# -*- coding: utf-8 -*-
"""H3 分段编排节点 v0.1（骨架 + 单段采样）。

把「MiniMax H3 参考生成视频 + 自定义采样器(高级)」这条链路收进一个节点，
后续版本在此骨架上叠加：多段卡片式分段、段间 prev_latent 自动衔接、
视频拼接直接出成片。

当前 v0.1 能力：
- 公共资源输入：model / clip / video_vae / audio_vae（可选）
- 尺寸三控件：宽高比(下拉) + 百万像素 + 倍数 → 联动换算 width/height
- 时长：直接填「秒」，内部换算成 24fps 帧数并 snap 到 H3 的 17k+5 网格
- 采样：内部调用官方核心 MiniMaxH3ReferenceToVideo + SamplerCustomAdvanced
- 输出：单段 latent

采样器高级内部固定用：RandomNoise + BasicGuider + KSamplerSelect + ManualSigmas
（与你现有工作流一致的配置，后续可把 seed/sigmas/sampler 提为节点输入）。
"""
import math
import os
import threading
from collections import OrderedDict

import torch

import nodes
import folder_paths
import comfy.samplers
import comfy.sd
import comfy.utils
from comfy.utils import ProgressBar
from comfy_api.latest import io
from comfy_api.latest import InputImpl

# 官方核心节点类（内部直接复用，避免重复实现采样链路）
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
from comfy_extras.nodes_audio import load as _load_audio_waveform
from comfy_extras.nodes_custom_sampler import (
    BasicGuider,
    BasicScheduler,
    KSamplerSelect,
    RandomNoise,
    SamplerCustomAdvanced,
)

# 自有节点：段间衔接（prev_latent 续接）+ 视频拼接（多段解码裁剪成片）
from .H3段间衔接节点 import H3SegmentBridge
from .H3视频拼接节点 import H3VideoConcat

# ── LoRA 缓存加载（复用 LoRA堆加载器节点 的逻辑，模块级 LRU 缓存）──
_LORA_CACHE = OrderedDict()
_LORA_LOCK = threading.Lock()
_LORA_CACHE_MAX = 5


def _load_lora_cached(lora_name):
    """带 LRU 缓存加载 LoRA 权重，文件不存在返回 None。"""
    lora_path = folder_paths.get_full_path("loras", lora_name)
    if lora_path is None:
        return None
    try:
        mtime = os.path.getmtime(lora_path)
    except OSError:
        return None
    with _LORA_LOCK:
        entry = _LORA_CACHE.get(lora_name)
        if entry is not None and entry[0] == mtime:
            _LORA_CACHE.move_to_end(lora_name)
            return entry[1]
    lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
    try:
        mtime = os.path.getmtime(lora_path)
    except OSError:
        pass
    with _LORA_LOCK:
        _LORA_CACHE[lora_name] = (mtime, lora)
        _LORA_CACHE.move_to_end(lora_name)
        while len(_LORA_CACHE) > _LORA_CACHE_MAX:
            _LORA_CACHE.popitem(last=False)
    return lora


def _apply_lora(model, lora_name, strength):
    """把单个 LoRA 应用到模型（clone 后打补丁），失败返回原模型。"""
    if not lora_name or lora_name in ("无", "（暂无LoRA）"):
        return model
    try:
        strength = float(strength) if strength is not None else 1.0
    except (TypeError, ValueError):
        strength = 1.0
    strength = max(-4.0, min(4.0, strength))
    if strength == 0.0:
        return model
    try:
        lora = _load_lora_cached(lora_name)
    except Exception as e:
        print(f"[WP H3分段编排] LoRA \"{lora_name}\" 加载失败: {e}")
        return model
    if lora is None:
        print(f"[WP H3分段编排] LoRA \"{lora_name}\" 找不到文件")
        return model
    try:
        model, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0)
    except Exception as e:
        print(f"[WP H3分段编排] LoRA \"{lora_name}\" 应用失败: {e}")
    return model


def _apply_loras(model, loras):
    """把一组 LoRA 逐个叠加到模型上（每段独立生效，按列表顺序依次打补丁）。

    loras 支持两种形态：
    - 列表：`[{"name": "...", "strength": 1.0}, ...]`
    - 兼容旧格式：`{"lora": "...", "lora_strength": 1.0}` 单条（走 _apply_lora）
    """
    if not loras:
        return model
    # 兼容旧单字段格式（前端升级前的存量数据）
    if isinstance(loras, dict):
        name = loras.get("lora") or loras.get("name") or ""
        strength = loras.get("lora_strength", loras.get("strength", 1.0))
        return _apply_lora(model, name, strength)
    if not isinstance(loras, list):
        return model
    out = model
    for item in loras:
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip()
        if not name:
            continue
        strength = item.get("strength", 1.0)
        out = _apply_lora(out, name, strength)
    return out

FPS = 24.0

# 宽高比下拉选项（与官方 ResolutionSelector 对齐）
ASPECT_RATIO_OPTIONS = [
    "1:1 (Square)",
    "2:3 (Portrait Photo)",
    "3:2 (Photo)",
    "3:4 (Portrait Standard)",
    "4:3 (Standard)",
    "9:16 (Portrait Widescreen)",
    "16:9 (Widescreen)",
    "21:9 (Ultrawide)",
]
ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}


def _seconds_to_length(seconds):
    """秒 → H3 帧数（24fps），snap 到 17k+5 网格，并 clamp 到 [5, 138]。

    与你现有工作流里的数学表达式一致：
      min(138, 5 + 17 * round((max(5, round(秒*24)) - 5) / 17))
    """
    try:
        sec = float(seconds)
    except (TypeError, ValueError):
        sec = 5.0
    frames = max(5, round(sec * FPS))
    snapped = 5 + 17 * round((frames - 5) / 17)
    return max(5, min(138, snapped))


def _resolution(aspect_ratio, megapixels, multiple):
    """尺寸三控件联动，等价官方 ResolutionSelector.execute 的算法。

    scale = sqrt(megapixels * 1024^2 / (w_ratio * h_ratio))
    width  = round(w_ratio * scale / multiple) * multiple
    """
    w_ratio, h_ratio = ASPECT_RATIOS.get(aspect_ratio, (16, 9))
    try:
        mp = float(megapixels)
    except (TypeError, ValueError):
        mp = 1.0
    try:
        mult = int(multiple)
    except (TypeError, ValueError):
        mult = 8
    if mult < 1:
        mult = 8
    total_pixels = mp * 1024 * 1024
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    width = round(w_ratio * scale / mult) * mult
    height = round(h_ratio * scale / mult) * mult
    return max(32, width), max(32, height)


class H3SegmentDirector:
    """🐳 WP H3分段编排 — 单段采样骨架。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "MiniMax H3 UNET"}),
                "clip": ("CLIP", {"tooltip": "qwen3vl CLIP"}),
                "video_vae": ("VAE", {"tooltip": "H3 视频 VAE"}),
                "宽高比": (ASPECT_RATIO_OPTIONS, {"default": "16:9 (Widescreen)", "tooltip": "输出画面宽高比"}),
                "百万像素": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 16.0, "step": 0.01, "tooltip": "目标总像素（1.0 ≈ 1024×1024）"}),
                "倍数": ("INT", {"default": 8, "min": 8, "max": 128, "step": 4, "tooltip": "分辨率对齐到该倍数的最近整数"}),
                "noise_seed": ("INT", {"default": 112, "min": 0, "max": 0xffffffffffffffff, "tooltip": "随机噪声种子"}),
                "采样器": (comfy.samplers.SAMPLER_NAMES, {"default": "er_sde", "tooltip": "采样器"}),
                "调度器": (comfy.samplers.SCHEDULER_NAMES, {"default": "normal", "tooltip": "调度器（仅当未接入 sigmas 时生效）"}),
                "步数": ("INT", {"default": 20, "min": 1, "max": 10000, "tooltip": "采样步数（仅当未接入 sigmas 时生效）"}),
                "ref_image_size": (["match", "max"], {"default": "match", "tooltip": "参考图尺寸策略"}),
                "segments_json": ("STRING", {"default": "[]", "multiline": False, "tooltip": "多段数据桥（前端卡片 UI 写入，后端解析）"}),
            },
            "optional": {
                "audio_vae": ("VAE", {"tooltip": "H3 音频 VAE；不接则仅画面"}),
                "sigmas": ("SIGMAS", {"tooltip": "外接噪声表；接入后调度器与步数失效"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("images", "audio", "frame_count")
    FUNCTION = "run"
    CATEGORY = "🐳 WP_Node/📽️ 视频"

    def _load_ref_images(self, ref_image_files, ref_image_size, width, height):
        """参考图文件名列表 → {ref_image_0: tensor, ...}（MiniMaxH3 期望 [B,H,W,C]）。"""
        ref_images = {}
        if not ref_image_files:
            return ref_images
        loader = nodes.LoadImage()
        for i, fname in enumerate(ref_image_files):
            try:
                img_tensor = loader.load_image(fname)[0]  # [N,H,W,C]
                ref_images[f"ref_image_{i}"] = img_tensor
            except Exception as e:
                print(f"[WP H3分段编排] 参考图 {fname} 加载失败: {e}")
        return ref_images

    def _load_ref_videos(self, ref_video_files):
        """参考视频文件名列表 → (ref_videos, ref_video_audios)。

        ref_videos:  {ref_video_0: 帧张量 [N,H,W,C], ...}（24fps，至少 5 帧）
        ref_video_audios: {ref_video_audio_0: {waveform, sample_rate}, ...}（视频自带音轨，与 ref_video_N 配对）
        """
        ref_videos = {}
        ref_video_audios = {}
        if not ref_video_files:
            return ref_videos, ref_video_audios
        for i, fname in enumerate(ref_video_files):
            try:
                video_path = folder_paths.get_annotated_filepath(fname)
                source = InputImpl.VideoFromFile(video_path)
                comps = source.get_components()
                frames = comps.images  # [N,H,W,C] 帧张量
                if frames is None or frames.shape[0] < 5:
                    print(f"[WP H3分段编排] 参考视频 {fname} 帧数不足 5，跳过")
                    continue
                ref_videos[f"ref_video_{i}"] = frames
                # 视频自带音轨作为 ref_video_audio_N
                if comps.audio is not None:
                    ref_video_audios[f"ref_video_audio_{i}"] = {
                        "waveform": comps.audio["waveform"],
                        "sample_rate": comps.audio["sample_rate"],
                    }
            except Exception as e:
                print(f"[WP H3分段编排] 参考视频 {fname} 加载失败: {e}")
        return ref_videos, ref_video_audios

    def _load_ref_audios(self, ref_audio_files):
        """独立参考音频文件名列表 → {ref_audio_0: {waveform, sample_rate}, ...}。"""
        ref_audios = {}
        if not ref_audio_files:
            return ref_audios
        for i, fname in enumerate(ref_audio_files):
            try:
                audio_path = folder_paths.get_annotated_filepath(fname)
                waveform, sample_rate = _load_audio_waveform(audio_path)
                ref_audios[f"ref_audio_{i}"] = {
                    "waveform": waveform.unsqueeze(0),  # [C,L] → [B,C,L]
                    "sample_rate": sample_rate,
                }
            except Exception as e:
                print(f"[WP H3分段编排] 参考音频 {fname} 加载失败: {e}")
        return ref_audios

    def _sample_segment(self, model, clip, video_vae, audio_vae, prompt, width, height,
                        length, ref_image_size, ref_images,
                        ref_videos=None, ref_video_audios=None, ref_audios=None):
        """对单段执行：参考生成视频 → conditioning + 空 latent（不采样）。"""
        ref_out = MiniMaxH3ReferenceToVideo.execute(
            clip=clip,
            vae=video_vae,
            audio_vae=audio_vae,
            prompt=prompt,
            width=width,
            height=height,
            length=length,
            ref_image_size=ref_image_size,
            ref_images=ref_images,
            ref_videos=ref_videos or {},
            ref_video_audios=ref_video_audios or {},
            ref_audios=ref_audios or {},
        )
        return ref_out.args[0], ref_out.args[1]  # positive, latent

    def run(self, model, clip, video_vae, 宽高比, 百万像素, 倍数,
            noise_seed, 采样器, 调度器, 步数, ref_image_size, segments_json,
            audio_vae=None, sigmas=None):
        # 1. 尺寸三控件 → 分辨率
        width, height = _resolution(宽高比, 百万像素, 倍数)

        # 2. 解析所有分段（含可选的「公共参数」段 _common:true）
        import json as _json
        segs = []
        common = None
        try:
            parsed = _json.loads(segments_json or "[]")
            if isinstance(parsed, list):
                for s in parsed:
                    if isinstance(s, dict):
                        if s.get("_common"):
                            common = s
                        else:
                            segs.append(s)
        except Exception as e:
            raise ValueError(f"WP H3分段编排：segments_json 解析失败（{e}）")
        if not segs:
            raise ValueError("WP H3分段编排：未解析到任何分段（segments_json 为空）")

        # 公共参数（enabled 时对每段生效：媒体前置 + 提示词前置拼接）
        common_enabled = bool(common and common.get("enabled"))
        if common_enabled:
            common_prompt = (common.get("prompt") or "").strip()
            common_ref_images = [str(x).strip() for x in (common.get("ref_images") or []) if x and str(x).strip()]
            common_ref_videos = [str(x).strip() for x in (common.get("ref_videos") or []) if x and str(x).strip()]
            common_ref_audios = [str(x).strip() for x in (common.get("ref_audios") or []) if x and str(x).strip()]
            if common_prompt or common_ref_images or common_ref_videos or common_ref_audios:
                print(f"[WP H3分段编排] 公共参数启用：提示词「{common_prompt[:30]}」，"
                      f"参考图 {len(common_ref_images)} 张，参考视频 {len(common_ref_videos)} 个，"
                      f"参考音频 {len(common_ref_audios)} 个")
            else:
                common_enabled = False  # 公共参数为空，视为未启用

        # 3. 组装采样器高级所需对象（一次组装，逐段复用）
        sampler = KSamplerSelect.execute(sampler_name=采样器).args[0]
        # 噪声表：优先外接 sigmas；未接入则用 调度器+步数 生成
        if sigmas is not None:
            sigmas_t = sigmas
        else:
            sigmas_t = BasicScheduler.execute(
                model=model, scheduler=调度器, steps=步数, denoise=1.0,
            ).args[0]

        bridge = H3SegmentBridge()

        seg_latents = []  # 各段采样后的 latent（含 wp_h3_bridge 元数据）
        prev_latent = None

        # 进度条：每段算 1 个刻度，最后拼接再算 1 个刻度
        pbar = ProgressBar(len(segs) + 1)

        for idx, seg in enumerate(segs):
            # 逐段进度提示（采样前）：当前第几段 / 总段数
            pbar.update_absolute(
                idx, len(segs) + 1,
                preview=None,
            )
            prompt = (seg.get("prompt") or "").strip()
            duration = seg.get("duration", 5.0)
            length = _seconds_to_length(duration)
            context_frames = str(seg.get("context_frames", 22))
            # 多 LoRA：优先读 loras 列表；兼容旧 lora/lora_strength 单字段
            loras = seg.get("loras")
            lora_name = seg.get("lora") or ""
            lora_strength = seg.get("lora_strength", 1.0)
            seam_redraw = seg.get("seam_redraw", 0.10)

            # 参考图 / 参考视频 / 参考音频
            ri = seg.get("ref_images") or []
            ref_image_files = [str(x).strip() for x in ri if x and str(x).strip()]
            rv = seg.get("ref_videos") or []
            ref_video_files = [str(x).strip() for x in rv if x and str(x).strip()]
            ra = seg.get("ref_audios") or []
            ref_audio_files = [str(x).strip() for x in ra if x and str(x).strip()]

            # 公共参数合并：媒体前置（公共在前，分段在后）+ 提示词前置拼接
            if common_enabled:
                ref_image_files = common_ref_images + ref_image_files
                ref_video_files = common_ref_videos + ref_video_files
                ref_audio_files = common_ref_audios + ref_audio_files
                if common_prompt:
                    prompt = (common_prompt + "\n" + prompt).strip() if prompt else common_prompt

            ref_images = self._load_ref_images(ref_image_files, ref_image_size, width, height)
            ref_videos, ref_video_audios = self._load_ref_videos(ref_video_files)
            ref_audios = self._load_ref_audios(ref_audio_files)

            # 汇总有效 LoRA 列表（优先新格式 loras，否则回退旧单字段）
            if isinstance(loras, list) and loras:
                eff_loras = [x for x in loras if isinstance(x, dict) and (x.get("name") or "").strip()]
                lora_desc = "+".join(f"{x.get('name')}({x.get('strength', 1.0)})" for x in eff_loras) if eff_loras else "无"
            elif lora_name:
                eff_loras = [{"name": lora_name, "strength": lora_strength}]
                lora_desc = f"{lora_name}({lora_strength})"
            else:
                eff_loras = []
                lora_desc = "无"

            print(f"[WP H3分段编排] 采样分段 {idx + 1}/{len(segs)}：时长 {duration}s（{length} 帧），"
                  f"参考图 {len(ref_images)} 张，参考视频 {len(ref_videos)} 个，参考音频 {len(ref_audios)} 个，"
                  f"LoRA={lora_desc}")

            # 本段模型：按需打 LoRA 补丁（每段独立生效，多 LoRA 顺序叠加）
            seg_model = _apply_loras(model, eff_loras) if eff_loras else model

            # ── 逐段错误处理：单段失败给出明确上下文，而非整体崩溃 ──
            try:
                # 生成 conditioning + 空 latent
                positive, latent = self._sample_segment(
                    seg_model, clip, video_vae, audio_vae, prompt, width, height,
                    length, ref_image_size, ref_images,
                    ref_videos, ref_video_audios, ref_audios,
                )

                # 段间续接：第 2 段起把 prev_latent 尾部续接进当前段
                if prev_latent is not None:
                    cond2, latent2, trim = bridge.bridge(
                        conditioning=positive,
                        latent=latent,
                        context_frames=context_frames,
                        seam_redraw=seam_redraw,
                        prev_latent=prev_latent,
                    )
                    positive, latent = cond2, latent2

                # 采样
                guider = BasicGuider.execute(model=seg_model, conditioning=positive).args[0]
                noise = RandomNoise.execute(noise_seed=noise_seed + idx).args[0]
                sample_out = SamplerCustomAdvanced.execute(
                    noise=noise,
                    guider=guider,
                    sampler=sampler,
                    sigmas=sigmas_t,
                    latent_image=latent,
                )
                out_latent = sample_out.args[0]
            except Exception as e:
                # 段失败：汇总该段关键信息，抛带上下文的错误
                p_snippet = (prompt[:40] + "…") if len(prompt) > 40 else (prompt or "（空）")
                raise RuntimeError(
                    f"WP H3分段编排：第 {idx + 1}/{len(segs)} 段采样失败（时长 {duration}s，"
                    f"提示词「{p_snippet}」，LoRA={lora_desc or '无'}）\n"
                    f"  原始错误：{type(e).__name__}: {e}"
                ) from e

            seg_latents.append(out_latent)
            prev_latent = out_latent
            # 该段完成，进度 +1
            pbar.update_absolute(idx + 1, len(segs) + 1)

        # 4. 拼接成片（复用 H3VideoConcat）
        pbar.update_absolute(len(segs), len(segs) + 1)
        if len(seg_latents) > 16:
            print(f"[WP H3分段编排] 警告：分段数 {len(seg_latents)} 超过拼接上限 16，仅前 16 段参与拼接")
            seg_latents = seg_latents[:16]
        concat = H3VideoConcat()
        images, audio, frame_count = concat.concat(
            crop_frames=22,  # 后备裁剪值；桥接段以 wp_h3_bridge 元数据为准
            video_vae=video_vae,
            audio_vae=audio_vae,
            latent_1=seg_latents[0] if len(seg_latents) > 0 else None,
            latent_2=seg_latents[1] if len(seg_latents) > 1 else None,
            latent_3=seg_latents[2] if len(seg_latents) > 2 else None,
            latent_4=seg_latents[3] if len(seg_latents) > 3 else None,
            latent_5=seg_latents[4] if len(seg_latents) > 4 else None,
            latent_6=seg_latents[5] if len(seg_latents) > 5 else None,
            latent_7=seg_latents[6] if len(seg_latents) > 6 else None,
            latent_8=seg_latents[7] if len(seg_latents) > 7 else None,
            latent_9=seg_latents[8] if len(seg_latents) > 8 else None,
            latent_10=seg_latents[9] if len(seg_latents) > 9 else None,
            latent_11=seg_latents[10] if len(seg_latents) > 10 else None,
            latent_12=seg_latents[11] if len(seg_latents) > 11 else None,
            latent_13=seg_latents[12] if len(seg_latents) > 12 else None,
            latent_14=seg_latents[13] if len(seg_latents) > 13 else None,
            latent_15=seg_latents[14] if len(seg_latents) > 14 else None,
            latent_16=seg_latents[15] if len(seg_latents) > 15 else None,
            offload_to_cpu=True,
            trim_latent_tokens=True,
        )

        # 拼接完成，进度走满
        pbar.update_absolute(len(segs) + 1, len(segs) + 1)

        print(f"[WP H3分段编排] 完成：{len(segs)} 段拼接，共 {frame_count} 帧")
        return (images, audio, int(frame_count))


NODE_CLASS_MAPPINGS = {
    "WP_H3SegmentDirector": H3SegmentDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_H3SegmentDirector": "🐳 WP H3分段编排",
}
