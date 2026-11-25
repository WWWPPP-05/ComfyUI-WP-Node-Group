# -*- coding: utf-8 -*-
"""H3 视频拼接 v4：无限续接版。逐段 VAE 解码成画面后裁剪拼接，输出完整视频 + 音频。

v2：读取段间衔接节点写进 latent 的 wp_h3_bridge 元数据（头部裁 crop / 尾部裁 tail），音频同步裁剪，
未携带元数据的段回退 crop_frames 输入。
v3.2 内存优化：裁剪后立即 clone 释放整段解码缓冲；可选 offload_to_cpu。

v4（2026-11-23）三项改动：
1. 无限续接：latent_1–latent_16 共 16 段槽位；latent_2 起带 hiddenUntilConnected，
   上一槽位接入后下一槽位才在界面显示；槽位顺序即拼接顺序，中间空槽自动跳过。
   16 段 × 6.6s ≈ 105s 成片，常规长片够用；更多段建议分批导出后二阶段拼接。
2. offload_to_cpu 默认改为 True：段数放开上限后，终片 IMAGE 张量可达 10GB+
   （16 段 × 736×416 fp32），8G 显存必须先落内存再 cat。输出内容与 False 完全一致，
   仅张量所在设备不同。（v3.2 时代 4 段上限，默认 False 安全；v4 起默认 True）
3. trim_latent_tokens（默认 False，建议 A/B 无差异后常开）：把"裁头"提前到
   latent 时间片层——按 5 个时间片（= H3 解码器 1 个时间 chunk）整数块丢弃头部
   context 区的 latent，VAE 不再解码注定被裁掉的帧。桥接段典型省 15–30% 解码时间：
     context 22（22+73→107）：丢头部 5 片 = 17 帧，解码 90 帧省 17/107；
     context 39：丢 10 片 = 34 帧；context 56：丢 15 片 = 51 帧（省 48%）。
   数学论证（已对源码核实）：头裁 h=5q 片后，chunk i 的 token 窗口
   [5i, 5i+5+token_overlap] 与整段解码 chunk (i+q) 完全相同（token_overlap=2 对齐
   消掉），且 FRAME_PER_TOKEN 按 k%5 循环、h%5==0 → 时间片相位一致；唯一差异是
   chunk0 内部 [3,5) 的 2 帧会混入"不存在的前 chunk"（等价于向前 pad），这 2 帧属于
   原本就要裁掉的 crop 帧内，不影响可见区；可见区首帧起与整段解码逐元素一致。
   【尾裁不做】：尾部 pad token 复制来源不同（裁后取 visible 末帧 vs 原段取 token_drop
   前真实帧），会产生不同的 pad 内容，无法保证逐元素一致；且当前桥接段 tail=12 帧
   < 5 片（=17 帧尾 chunk 安全界）时尾裁本身也不触发，尾部浪费仅 ~11% 且不可省。
   解码后实测帧数兜底：不足导出窗口自动回退整段解码，绝不输出错帧。

耗时说明：本节点耗时主体 = 逐段 H3 VAE 解码（36 层 ViT3D、fp32、时空分块，8G 卡
空间上 4×2=8 块/行、时间上约 7 chunk），桥接段按"可见+context+align"全长采样解码
（107 帧只导出 73 帧），trim 选项即针对这 ~32% 浪费。若工作流每段另接了 VAEDecode
预览节点，则全部解码了两遍，删掉预览解码即可直接省一半。
"""
import torch

FPS = 24.0
MAX_SEGMENTS = 16
TOKEN_CHUNK = 5  # H3 VAE 时间解码 chunk = 5 个时间片（= 17 像素帧），也是 FRAME_PER_TOKEN 循环周期

try:
    from comfy.ldm.minimax.model import FRAME_PER_TOKEN
except ImportError:
    FRAME_PER_TOKEN = (1, 4, 4, 4, 4)


def _unpack(out):
    if hasattr(out, "args") and out.args:
        return out.args[0]
    if isinstance(out, (tuple, list)):
        return out[0]
    return out


def _pixel_frames(latent_t):
    """时间片数 → 像素帧数（与段间衔接节点同款映射）。"""
    return sum(FRAME_PER_TOKEN[k % 5] for k in range(int(latent_t)))


def _steps_for_frames(n):
    """像素帧数 → 精确时间片数；不在网格上返回 None。"""
    k, covered = 0, 0
    while covered < n:
        covered += FRAME_PER_TOKEN[k % 5]
        k += 1
    return k if covered == n else None


class H3VideoConcat:
    @classmethod
    def INPUT_TYPES(cls):
        # 【2026-11-23 端口顺序调整】vae 更名 video_vae 并与 audio_vae 一起移入 optional 前两位，
        # 使端口显示顺序为 video_vae → audio_vae → latent_1..16（required 端口永远排在 optional 之前，
        # 若 latent_1 留在 required 会把两个 VAE 端口压到 latent 系列之后，故 latent_1 一并转为 optional）。
        latents = {}
        tips = "槽位顺序即拼接顺序，中间空槽自动跳过"
        for i in range(2, MAX_SEGMENTS + 1):
            latents[f"latent_{i}"] = ("LATENT", {
                "hiddenUntilConnected": True,
                "tooltip": f"第 {i} 段 H3 潜空间（接入上一段后本槽位才显示）。{tips}",
            })
        return {
            "required": {
                "crop_frames": ("INT", {"default": 22, "min": 0, "max": 56, "step": 1, "tooltip": "后备裁剪值：仅对未携带 wp_h3_bridge 元数据、且不是第一段的 latent 生效；接了段间衔接节点时以元数据为准"}),
            },
            "optional": {
                # 端口顺序即本字典顺序：video_vae 在最上，audio_vae 紧随其下，其后是 latent 系列
                "video_vae": ("VAE", {"tooltip": "H3 视频 VAE，用于逐段解码"}),
                "audio_vae": ("VAE", {"tooltip": "H3 音频 VAE，用于解码各段音频；不接则只输出画面"}),
                "latent_1": ("LATENT", {"tooltip": "第 1 段 H3 潜空间"}),
                **latents,
                "offload_to_cpu": ("BOOLEAN", {"default": True, "tooltip": "默认开启：各段裁剪保留的画面/波形先搬到内存(CPU)再拼接。v4 起段数无上限，终片张量可能达 10GB+，8G 显存必须落内存；输出内容完全相同，仅张量所在设备不同"}),
                "trim_latent_tokens": ("BOOLEAN", {"default": False, "tooltip": "latent 级预裁剪：按 5 时间片整数块丢弃头部 context 区后再解码，桥接段省 15-48% 解码时间；只丢整 chunk 保证可见区逐帧一致，帧数不足自动回退整段解码。确认无差异后建议常开"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("images", "audio", "frame_count")
    FUNCTION = "concat"
    CATEGORY = "🐳 WP_Node/📽️ 视频"

    def _decode_video(self, vae, latent):
        from nodes import VAEDecode
        images, = VAEDecode().decode(vae, latent)
        return images

    def _decode_audio(self, audio_vae, latent):
        try:
            from comfy_extras.nodes_audio import VAEDecodeAudio
        except ImportError:
            from comfy_extras.nodes_lt import VAEDecodeAudio
        return _unpack(VAEDecodeAudio.execute(audio_vae, latent))

    @staticmethod
    def _bridge_meta(seg):
        if isinstance(seg, dict):
            meta = seg.get("wp_h3_bridge")
            if isinstance(meta, dict):
                return meta
        return None

    def _trim_tokens(self, seg, meta):
        """latent 级预裁剪：按 5 时间片整数块丢弃头部 context 区。

        返回 (裁剪后 latent, 头部跳过帧数) 或 None（不适用 / 无收益 / 预测帧数不足）。
        只做头裁、只丢 5 的整数倍时间片：
          - FRAME_PER_TOKEN 按 k%5 循环，h%5==0 → 保留区时间片相位与原段一致；
          - 解码 chunk 窗口 [5i,5i+7) 随 h(=5q) 平移后与原段 chunk(i+q) 完全重合，
            可见区逐帧等价（chunk0 内 [3,5) 的 2 帧混入 pad 前帧，落在 crop 区内）；
          - 【尾裁禁做】：尾部 pad token 复制来源不同会污染尾 chunk，不可保证等价
            （见文件头注释）。
        """
        crop = max(0, int(meta.get("crop", 0)))
        visible = int(meta.get("visible", 0))
        if visible <= 0 or crop < TOKEN_CHUNK:  # 不足一个时间 chunk 无收益
            return None

        try:
            from comfy.nested_tensor import NestedTensor
        except Exception:
            return None
        samples = seg.get("samples")
        if not hasattr(samples, "unbind") or not hasattr(samples, "tensors"):
            return None
        streams = list(samples.tensors)
        video = streams[0]
        if video.ndim != 5:
            return None
        total_tokens = int(video.shape[2])

        head_steps = _steps_for_frames(crop)
        if head_steps is None:
            return None
        h = (head_steps // TOKEN_CHUNK) * TOKEN_CHUNK  # 只丢整 chunk
        if h <= 0 or h >= total_tokens:
            return None

        head_skip_frames = _pixel_frames(h)
        crop_after = crop - head_skip_frames
        # 预测解码帧数：不足导出窗口则放弃（防御网格不匹配）
        if crop_after < 0 or _pixel_frames(total_tokens - h) < crop_after + visible:
            return None

        new_streams = [video[:, :, h:]] + streams[1:]
        trimmed = {"samples": NestedTensor(new_streams)}
        return trimmed, head_skip_frames

    def _trim_audio_head(self, audio, crop):
        if not isinstance(audio, dict) or audio.get("waveform") is None:
            return audio
        wf = audio["waveform"]
        sr = int(audio.get("sample_rate", 32000))
        drop = int(round(crop / FPS * sr))
        if drop > 0 and int(wf.shape[-1]) > drop:
            # v3.2：clone 释放整段解码波形（view 会拖住全段缓冲）
            wf = wf[..., drop:].clone()
        return {"waveform": wf, "sample_rate": sr}

    def _trim_audio_tail(self, audio, keep_frames):
        if not isinstance(audio, dict) or audio.get("waveform") is None:
            return audio
        wf = audio["waveform"]
        sr = int(audio.get("sample_rate", 32000))
        want = int(round(keep_frames / FPS * sr))
        if int(wf.shape[-1]) > want:
            # v3.2：clone 同上
            wf = wf[..., :want].clone()
        return {"waveform": wf, "sample_rate": sr}

    def concat(self, crop_frames, video_vae, audio_vae=None, latent_1=None,
               latent_2=None, latent_3=None, latent_4=None, latent_5=None,
               latent_6=None, latent_7=None, latent_8=None, latent_9=None,
               latent_10=None, latent_11=None, latent_12=None, latent_13=None,
               latent_14=None, latent_15=None, latent_16=None,
               offload_to_cpu=True, trim_latent_tokens=False):
        # 【2026-11-23 端口顺序调整】vae→video_vae；latent_1 转 optional 后缺失视为断链错误
        if video_vae is None:
            raise ValueError("H3视频拼接：video_vae（H3 视频 VAE）未接入")
        if latent_1 is None:
            raise ValueError("H3视频拼接：latent_1（第 1 段 H3 潜空间）未接入")
        slots = (latent_1, latent_2, latent_3, latent_4, latent_5,
                 latent_6, latent_7, latent_8, latent_9, latent_10,
                 latent_11, latent_12, latent_13, latent_14, latent_15, latent_16)
        segments = [l for l in slots if l is not None]  # 槽位顺序即拼接顺序，空槽跳过
        fallback_crop = max(0, int(crop_frames))
        offload = bool(offload_to_cpu)
        trim = bool(trim_latent_tokens)

        images_list = []
        audios = []
        for i, seg in enumerate(segments):
            meta = self._bridge_meta(seg)
            if meta is not None:
                # 接了段间衔接节点：以元数据为准（头部 crop + 尾部 align 超出）
                crop = max(0, int(meta.get("crop", 0)))
                tail = max(0, int(meta.get("tail", 0)))
            else:
                crop = fallback_crop if i > 0 else 0
                tail = 0

            # v4 trim：latent 级预裁剪成功则只解码保留区附近，失败/不适用走整段解码
            imgs = None
            crop_a, tail_a = crop, tail
            if trim and meta is not None:
                res = self._trim_tokens(seg, meta)
                if res is not None:
                    t_latent, head_skip = res
                    imgs = self._decode_video(video_vae, t_latent)
                    crop_a = crop - head_skip
                    # 实测帧数兜底（预测已过，此处防御 stock 解码行为差异）
                    if crop_a < 0 or int(imgs.shape[0]) < crop_a + int(meta.get("visible", 0)):
                        imgs = None
            if imgs is None:
                imgs = self._decode_video(video_vae, seg)
                crop_a, tail_a = crop, tail

            total = int(imgs.shape[0])
            if crop_a > 0:
                if total <= crop_a:
                    raise ValueError(f"H3视频拼接：第 {i + 1} 段帧数 {total} 小于头部裁剪帧数 {crop_a}")
                imgs = imgs[crop_a:]
            if tail_a > 0:
                keep = int(imgs.shape[0]) - tail_a
                if keep < 1:
                    raise ValueError(f"H3视频拼接：第 {i + 1} 段裁掉尾部 {tail_a} 帧后无剩余画面")
                imgs = imgs[:keep]
            # v3.2 内存优化：裁剪产生的是 view，会把整段 fp32 解码缓冲（约 GB 级）
            # 一直拖到 torch.cat 才释放；立即 clone 保留片段，让整段缓冲在本段
            # 处理完即可释放。未裁剪的段（第一段）本身即保留区，不 clone 以免翻倍。
            if crop_a > 0 or tail_a > 0:
                imgs = imgs.clone()
            if offload and imgs.device.type != "cpu":
                imgs = imgs.cpu()
            images_list.append(imgs)

            if audio_vae is not None:
                # 音频始终从原段 latent 解码（音频解码成本极低，不值得预裁剪）
                aud = self._decode_audio(audio_vae, seg)
                if crop > 0:
                    aud = self._trim_audio_head(aud, crop)
                if tail > 0:
                    aud = self._trim_audio_tail(aud, int(imgs.shape[0]))
                if isinstance(aud, dict) and aud.get("waveform") is not None:
                    if offload and aud["waveform"].device.type != "cpu":
                        aud = {"waveform": aud["waveform"].cpu(), "sample_rate": aud["sample_rate"]}
                    audios.append(aud)

        images = torch.cat(images_list, dim=0)

        if audios:
            sr = int(audios[0].get("sample_rate", 32000))
            waveform = torch.cat([a["waveform"] for a in audios], dim=-1)
            audio = {"waveform": waveform, "sample_rate": sr}
        else:
            audio = {}

        return (images, audio, int(images.shape[0]))


NODE_CLASS_MAPPINGS = {"WP_H3VideoConcat": H3VideoConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"WP_H3VideoConcat": "🐳 WP H3视频拼接"}
