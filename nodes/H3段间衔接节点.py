# -*- coding: utf-8 -*-
"""H3 段间衔接：head 模式 v3.1（借鉴 ComfyUI_MiniMaxH3_Director 的 motion-context + latent-continue 思路）。

把当前段 latent 扩帧出一段头部引导缓冲帧，将上一段尾部的视频关键帧与音频
钉入缓冲区，解码后由拼接节点裁掉缓冲区头部 + align 超出的尾部，实现无缝衔接。

各模态使用"已被实测各自验证过"的机制组合（Director 的两套机制互斥，不可对同一
内容叠加，v3 曾因音频双重引导在接缝后出现回声式重说，v3.1 修正）：
1. 【视频 = latent-continue 路径】上一段尾部视频块硬拷贝进头部 + noise_mask
   锥形锁定（接缝前 4 个时间片锁到 seam_redraw）——v3 实测画面接缝完美；
2. 【音频 = motion-context 路径】音频不硬拷贝、不锁定，仅挂 0 号关键帧
   audio_latent 作 cond 引导（官方 MiniMaxH3AddGuide 同款通道，与画面同起点）
   ——v2 实测音频正常；
3. 【尾部对齐裁剪】align 超出的尾部帧写入 wp_h3_bridge 元数据，拼接节点裁掉；
4. 【关键帧去重】覆盖上游 0 号首帧锚，避免与上下文头重复锚定；
5. 【防御】重建 latent 时清除陈旧 noise_mask，再写入我们自己的锁定 mask。

v1→v3 迭代史（避免重复踩坑）：
- v1：音频走 minimax_refs → stock 把 ref 音频排到视频起点之前，音画脱轴 → 第3秒闪烁错乱；
- v2：音频改挂关键帧（音画同轴）→ 闪烁消除，画面剩小瑕疵；
- v3：视频硬拷贝+锁定 → 画面接缝完美；但音频也被硬拷贝+锁定（双重引导）→ 接缝后回声重说；
- v3.1：音频回退 v2 纯 cond，视频保留 v3 锁定；
- v3.2：缓存/内存优化（输出与 v3.1 逐元素一致）：执行缓存审计确认两节点均为纯函数、
  无输入污染（ComfyUI 输入哈希缓存天然正确）；头部写入改 in_place 直写扩帧零张量，
  省一份整段视频 latent 的 clone 分配与全量拷贝。
"""
import math

import node_helpers
import torch
from comfy.nested_tensor import NestedTensor

try:
    from comfy.ldm.minimax.model import FRAME_PER_TOKEN
except ImportError:
    FRAME_PER_TOKEN = (1, 4, 4, 4, 4)

FPS = 24.0
AUDIO_HZ = 40.0
CONTEXT_FRAME_CHOICES = (5, 22, 39, 56)
DEFAULT_CONTEXT_FRAMES = 22
SEAM_TAPER_TOKENS = 4       # 靠近接缝、锥形锁定的视频时间片数（Director 同款）
DEFAULT_SEAM_REDRAW = 0.10  # 接缝重绘幅度（Director SEAM_MIN_MASK 同款默认）


def _snap_context(raw):
    try:
        n = int(raw or DEFAULT_CONTEXT_FRAMES)
    except (TypeError, ValueError):
        n = DEFAULT_CONTEXT_FRAMES
    return min(CONTEXT_FRAME_CHOICES, key=lambda g: (abs(g - n), -g))


def _pixel_frames(latent_t):
    return sum(FRAME_PER_TOKEN[k % 5] for k in range(int(latent_t)))


def _steps_for_frames(n):
    k, covered = 0, 0
    while covered < n:
        covered += FRAME_PER_TOKEN[k % 5]
        k += 1
    return k if covered == n else None


def _align_frame_count(n):
    while n % 17 != 5:
        n += 1
    return n


def _video_latent_t(frame_count):
    return 2 if frame_count <= 5 else ((frame_count - 5) // 17) * 5 + 2


def _streams(samples):
    if hasattr(samples, "unbind"):
        return list(samples.unbind())
    if hasattr(samples, "tensors"):
        return list(samples.tensors)
    if isinstance(samples, (tuple, list)):
        return list(samples)
    return [samples]


def _video(latent):
    v = _streams(latent["samples"])[0]
    if v.ndim == 4:
        v = v.unsqueeze(0)
    return v


def _audio(latent):
    parts = _streams(latent["samples"])
    if len(parts) < 2:
        return None
    a = parts[1]
    if a.ndim == 3:
        a = a.unsqueeze(0)
    return a


def _video_tail_blocks(latent, n):
    video = _video(latent)
    total = int(video.shape[2])
    steps = _steps_for_frames(n)
    if steps is None or steps > total:
        raise ValueError(f"H3段间衔接：上下文帧数 {n} 不对齐 H3 时间网格（可选 {list(CONTEXT_FRAME_CHOICES)}）")
    start = total - steps
    if start % 5 != 0:
        raise ValueError(f"H3段间衔接：上一段时长（{total} 个时间片）与上下文 {n} 帧不对齐，无法正确续接")
    if start < 0:
        raise ValueError("H3段间衔接：上一段太短，无法提取上下文")
    blocks = [video[:1, :, start + k:start + k + 1].clone() for k in range(steps)]
    offsets = [_pixel_frames(k) for k in range(steps)]
    covered = _pixel_frames(steps)
    return blocks, offsets, covered


def _audio_tail_sync(latent, covered):
    """取上一段尾部音频 latent，长度与视频钉入窗口 covered 像素帧同轴对齐。

    音频 latent 帧率 40 / 像素帧率 24 → 每像素帧 5/3 个音频 latent 帧，
    与官方 FRAME_RESCALE 一致；整段挂到 0 号关键帧后，音频与头部画面同起点。
    """
    audio = _audio(latent)
    if audio is None:
        return None, 0
    total_t = int(audio.shape[-1])
    rt = int(round(covered * AUDIO_HZ / FPS))
    if rt < 1:
        return None, 0
    if rt > total_t:
        rt = total_t
    start = total_t - rt
    return audio[:1, ..., start:total_t].clone(), rt


def _expand_latent(latent, context_frames):
    """把空 latent 重建为更长的采样长度：visible + context 对齐到 H3 17k+5 网格。

    返回 (新 latent, 采样总帧数)。重建时清除陈旧的 noise_mask。
    """
    video = _video(latent)
    total_t = int(video.shape[2])
    frame_count = _pixel_frames(total_t)
    new_frame_count = _align_frame_count(frame_count + context_frames)
    new_t = _video_latent_t(new_frame_count)

    b, c, _, h, w = video.shape
    dev, dt = video.device, video.dtype
    new_video = torch.zeros(b, c, new_t, h, w, device=dev, dtype=dt)

    audio = _audio(latent)
    new_audio = None
    if audio is not None:
        new_a = int(round(new_frame_count / FPS * AUDIO_HZ))
        new_audio = torch.zeros(b, audio.shape[1], audio.shape[2], new_a, device=dev, dtype=dt)

    samples = NestedTensor((new_video, new_audio)) if new_audio is not None else NestedTensor((new_video,))
    out = dict(latent)
    out.pop("noise_mask", None)  # 旧 mask 形状与新 latent 不匹配，必须清除
    out["samples"] = samples
    return out, new_frame_count


def _clamp_seam_redraw(value):
    """接缝重绘幅度：0=硬锁上一段尾部（最连续），越大重绘越多。"""
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = DEFAULT_SEAM_REDRAW
    if not math.isfinite(n):
        n = DEFAULT_SEAM_REDRAW
    return max(0.0, min(0.95, n))


def _prefix_token_weights(prefix_steps, seam_min):
    """头部时间片的去噪权重：前段 1.0（可自由重绘），最后 SEAM_TAPER_TOKENS 个
    线性锥形降到 seam_min（≈硬锁上一段尾部）。Director prefix_token_weights 同款。"""
    n = int(prefix_steps)
    if n < 1:
        return ()
    taper = max(1, min(SEAM_TAPER_TOKENS, n))
    head = n - taper
    floor = _clamp_seam_redraw(seam_min)
    weights = [1.0] * head
    weights.extend(1.0 + (floor - 1.0) * (float(i + 1) / float(taper)) for i in range(taper))
    return tuple(weights)


def _video_seam_mask(t_steps, prefix_steps, h, w, device, weights):
    """视频去噪 mask [1,1,T,h,w]：全 1，头部 prefix 按锥形权重锁定。"""
    mask = torch.ones((1, 1, int(t_steps), int(h), int(w)), device=device, dtype=torch.float32)
    n = max(0, min(int(prefix_steps), int(t_steps)))
    if n < 1:
        return mask
    ramp = torch.tensor(weights[:n], device=device, dtype=torch.float32)
    mask[:, :, :n] = ramp.view(1, 1, n, 1, 1)
    return mask


def _lock_head_from_prev(latent, blocks, seam_redraw, in_place=False):
    """把上一段尾部视频硬拷贝进扩帧 latent 头部，并写视频 noise_mask 锥形锁定。

    in_place=True 专用于 _expand_latent 刚重建的 latent：其零张量为本节点独占，
    可原地直写，省掉一份整段视频 latent 的 clone 分配与全量拷贝（v3.2），
    写入位置与数值与 clone 路径完全相同，输出逐元素一致。
    in_place=False（默认）保持旧路径：对非本节点创建的 latent 仍先 clone 再写，绝不改输入。

    只处理视频流：音频不硬拷贝、不锁定（v3 曾把音频也锁定，与关键帧音频 cond
    形成双重引导——Director 的 continue/motion-context 两套机制互斥——导致接缝后
    出现回声式重说；v3.1 音频回到 v2 的纯 cond 路径）。
    官方采样链路：KSampler 读取 latent["noise_mask"]，非嵌套 mask 只作用于视频流，
    音频流由 samplers.py 自动补全 1（全去噪）——全部 stock 原生支持。
    """
    streams = _streams(latent["samples"])
    video = streams[0]
    if video.ndim == 4:
        video = video.unsqueeze(0)
    patched_video = video if in_place else video.clone()
    steps = len(blocks)
    dev, dt = patched_video.device, patched_video.dtype
    for k, blk in enumerate(blocks):
        piece = blk if blk.ndim == 5 else blk.unsqueeze(0)
        patched_video[:, :, k:k + 1] = piece.to(device=dev, dtype=dt)

    weights = _prefix_token_weights(steps, seam_redraw)
    video_mask = _video_seam_mask(
        int(patched_video.shape[2]), steps,
        int(patched_video.shape[3]), int(patched_video.shape[4]),
        dev, weights,
    )

    out = dict(latent)
    if len(streams) > 1:
        out["samples"] = NestedTensor((patched_video, streams[1]))
    else:
        out["samples"] = NestedTensor((patched_video,))
    out["noise_mask"] = video_mask  # 纯视频 mask；音频走关键帧 cond 路径
    return out


def _existing_keyframes(conditioning):
    """读上游已有的 minimax_keyframes，丢弃 0 号首帧锚（被上下文头取代），其余保留。"""
    try:
        meta = conditioning[0][1] if conditioning and isinstance(conditioning[0], (list, tuple)) else {}
        kfs = (meta or {}).get("minimax_keyframes") or []
    except Exception:
        return []
    out = []
    for kf in kfs:
        if not isinstance(kf, dict):
            continue
        try:
            if int(kf.get("resolved_frame_index", -1)) == 0:
                continue  # stock 首帧锚，让位于上下文头（Director 同款处理）
        except (TypeError, ValueError):
            pass
        out.append(dict(kf))
    return out


class H3SegmentBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING", {"tooltip": "当前段条件（来自官方 MiniMax H3 条件节点）"}),
                "latent": ("LATENT", {"tooltip": "当前段 H3 潜空间，需与 conditioning 同源"}),
                "context_frames": ([str(v) for v in CONTEXT_FRAME_CHOICES], {"default": str(DEFAULT_CONTEXT_FRAMES)}),
                "seam_redraw": ("FLOAT", {"default": DEFAULT_SEAM_REDRAW, "min": 0.0, "max": 0.95, "step": 0.05,
                                          "tooltip": "接缝重绘幅度：0=硬锁上一段尾部（接缝最连续）；越大接缝前后重绘越多（更自由但可能有痕迹）。Director 默认 0.10"}),
            },
            "optional": {
                "prev_latent": ("LATENT", {"tooltip": "上一段 H3 潜空间，用于提取尾部关键帧（含音频）"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "INT")
    RETURN_NAMES = ("conditioning", "latent", "trim_frames")
    FUNCTION = "bridge"
    CATEGORY = "🐳 WP_Node/📽️ 视频"

    def bridge(self, conditioning, latent, context_frames, seam_redraw=DEFAULT_SEAM_REDRAW, prev_latent=None):
        if prev_latent is None or prev_latent.get("samples") is None:
            return (conditioning, latent, 0)

        video = _video(latent)
        if video.ndim != 5 or video.shape[1] != 24:
            raise ValueError(f"H3段间衔接：当前段不是 H3 视频潜空间，形状 {tuple(video.shape)}")

        prev_video = _video(prev_latent)
        if prev_video.ndim != 5 or prev_video.shape[1] != 24:
            raise ValueError(f"H3段间衔接：上一段不是 H3 视频潜空间，形状 {tuple(prev_video.shape)}")
        if tuple(prev_video.shape[3:]) != tuple(video.shape[3:]):
            raise ValueError("H3段间衔接：上一段与当前段分辨率不一致")

        n = _snap_context(context_frames)
        blocks, offsets, covered = _video_tail_blocks(prev_latent, n)
        seam = _clamp_seam_redraw(seam_redraw)

        # 多生成：扩展 latent，头部留出引导缓冲帧
        visible = _pixel_frames(int(video.shape[2]))
        out_latent, sample_frames = _expand_latent(latent, n)
        tail_frames = max(0, sample_frames - covered - visible)

        # 关键帧：7 个视频块钉到头部缓冲帧（正索引，官方原生支持）；
        # 上一段尾部音频整段挂在 0 号关键帧上，与头部画面同一时间起点 → 音画同步
        audio_tail, rt = _audio_tail_sync(prev_latent, covered)
        keyframes = []
        for o, blk in zip(offsets, blocks):
            kf = {"resolved_frame_index": o, "latent": blk}
            if o == 0 and audio_tail is not None:
                kf["audio_latent"] = audio_tail
            keyframes.append(kf)

        merged = keyframes + _existing_keyframes(conditioning)
        out_cond = node_helpers.conditioning_set_values(
            conditioning, {"minimax_keyframes": merged}
        )
        # 注意：不再写 minimax_refs —— stock 会把 ref 音频排到视频起点之前，
        # 破坏头部引导区的音画同步（v1 第 3 秒闪烁错乱的根因）。

        # v3.1：硬拷贝上一段尾部视频进头部 + 视频 noise_mask 锥形锁定接缝；
        # 音频不硬拷贝、不锁定（v2 纯 cond 路径，避免双重引导导致接缝后回声重说）
        # v3.2：in_place=True——out_latent 的零张量刚由 _expand_latent 独家创建，
        # 原地直写省一份整段视频 latent 的 clone（显存峰值与拷贝开销双降）
        out_latent = _lock_head_from_prev(out_latent, blocks, seam, in_place=True)

        # 拼接元数据：头部裁剪 + 尾部 align 超出，由 WP H3视频拼接 节点读取
        out_latent["wp_h3_bridge"] = {
            "crop": int(covered),
            "tail": int(tail_frames),
            "visible": int(visible),
            "sample": int(sample_frames),
            "seam": float(seam),
        }
        return (out_cond, out_latent, int(covered))


NODE_CLASS_MAPPINGS = {"WP_H3SegmentBridge": H3SegmentBridge}
NODE_DISPLAY_NAME_MAPPINGS = {"WP_H3SegmentBridge": "🐳 WP H3段间衔接"}
