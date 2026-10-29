# -*- coding: utf-8 -*-
"""🐳 WP PSD导出 — PSD 拆解管线第⑤站（终点）：组装导出可编辑 PSD 文件。

组装配方来自 PoC-1 验证结论：
- psd-tools 1.12.1 的 create_pixel_layer 会强制 RGBA→RGB 丢 alpha，必须绕过：
  直接调 PixelLayer._build_layer_record_and_channels 构建 (record, channels) 再实例化。
- 中文图层名双配套：保存时 UTF-8 encoding + 每层写 luni（Unicode Layer Name）字段。
- psd.append() 加到栈顶 → 组装顺序：先背景底层，再按 z_index 升序逐层 append（z 小在底）。
MVP 边界：8-bit sRGB、Normal 混合、无图层组、边缘不羽化，纯 CPU 操作。
"""
import json
import os
import re
import time

import numpy as np
import torch
from PIL import Image

import folder_paths

from psd_tools import PSDImage
from psd_tools.api import layers as psd_layers
from psd_tools.constants import Compression, Tag

from .推理模型加载器节点 import _wp_log

_BG_TYPES = ("背景", "background", "bg")


def _tensor_to_pil(t):
    """ComfyUI IMAGE 张量 [H,W,3] float 0~1 → PIL RGB uint8。"""
    arr = t.detach().cpu().numpy()
    return Image.fromarray(np.clip(arr * 255.0, 0, 255).astype(np.uint8))


def _append_layer(psd, pil_rgba, name):
    """写入单个全画布 RGBA 像素层（PoC-1 配方，绕过 create_pixel_layer 的 alpha 丢失 bug）。
    luni 是 PS 显示中文层名的正规字段，与保存时的 UTF-8 encoding 构成双保险。"""
    record, channels = psd_layers.PixelLayer._build_layer_record_and_channels(
        pil_rgba, name, 0, 0, Compression.RLE
    )
    layer = psd_layers.PixelLayer(psd, record, channels)
    layer._record.tagged_blocks.set_data(Tag.UNICODE_LAYER_NAME, name)
    psd.append(layer)
    return layer


class WP_PsdExport:
    """🐳 WP PSD导出 — 管线终点：原图 + 图层蒙版 + 结果JSON + 干净背景图 → 可编辑 PSD。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "原图像素源（连「🐳 WP PSD图层精抠」的图层图像，或直接连原图加载节点，取第 1 张）。"}),
                "图层蒙版": ("MASK", {"tooltip": "接「🐳 WP PSD图层精抠」的图层蒙版输出（[n,H,W]）。"}),
                "结果JSON": ("STRING", {"multiline": True, "tooltip": "接「🐳 WP PSD图层精抠」的结果JSON（层名/z序/类型/source）。"}),
                "背景图": ("IMAGE", {"tooltip": "接 Qwen Image 2.1 工作流输出的干净背景图（尺寸不符会自动 lanczos 对齐画布）。"}),
                "文件名前缀": ("STRING", {"default": "psd_export", "tooltip": "存 ComfyUI output 目录，文件名 = 前缀_时间戳.psd。"}),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("PSD路径", "预览图")
    FUNCTION = "export"
    CATEGORY = "🐳 WP_Node"
    OUTPUT_NODE = True  # 管线终点：输出不连线 Run 时也执行（PoC-4 验证）

    def export(self, image, 图层蒙版, 结果JSON, 背景图, 文件名前缀):
        t0 = _wp_log("==== PSD导出 export 开始 ====")

        if image is None or int(image.shape[0]) == 0:
            raise ValueError("未检测到图片输入。")
        if 背景图 is None or int(背景图.shape[0]) == 0:
            raise ValueError("未检测到背景图输入（应接 Qwen Image 2.1 工作流输出的干净背景）。")

        # ---- 基础像素与蒙版校验 ----
        base_rgb = _tensor_to_pil(image[0])
        W, H = base_rgb.size

        if 图层蒙版 is None or 图层蒙版.dim() < 2:
            raise ValueError("图层蒙版格式不对，应接「🐳 WP PSD图层精抠」的图层蒙版输出（[n,H,W]）。")
        if 图层蒙版.dim() == 2:
            图层蒙版 = 图层蒙版.unsqueeze(0)
        if tuple(图层蒙版.shape[-2:]) != (H, W):
            raise ValueError(
                f"图层蒙版尺寸 {tuple(图层蒙版.shape[-2:])} 与原图 ({W},{H}) 不一致，"
                "请确认两个节点用的是同一张图。"
            )
        n = int(图层蒙版.shape[0])
        masks = 图层蒙版.detach().cpu().numpy() > 0.5

        # ---- 结果JSON：层数校验 + 背景层识别 ----
        try:
            report = json.loads(结果JSON)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"结果JSON 解析失败（{e}），请确认连线来自「🐳 WP PSD图层精抠」的结果JSON 输出。"
            )
        layers = report.get("layers")
        if not isinstance(layers, list) or not layers:
            raise RuntimeError("结果JSON 中没有有效图层（layers 为空）。")
        if len(layers) != n:
            raise RuntimeError(
                f"结果JSON 层数（{len(layers)}）与图层蒙版批数（{n}）不一致，"
                "两者必须来自同一次「🐳 WP PSD图层精抠」运行。"
            )

        # 背景层识别双保险：source=background（精抠标记）或 layer_type=背景
        bg_names, fg_idx = [], []
        for i, l in enumerate(layers):
            if str(l.get("source", "")) == "background" or str(l.get("layer_type", "")).lower() in _BG_TYPES:
                bg_names.append(str(l.get("layer_name") or "背景"))
            else:
                fg_idx.append(i)
        bg_layer_name = bg_names[0] if bg_names else "背景"
        if len(bg_names) > 1:
            _wp_log(f"识别到 {len(bg_names)} 个背景层，底层取「{bg_layer_name}」，其余跳过不重复写入")

        # ---- 背景图对齐画布（Qwen 输出常 1152x2048 vs 原图 1125x2000，双保险）----
        bg_pil = _tensor_to_pil(背景图[0]).convert("RGB")
        if bg_pil.size != (W, H):
            _wp_log(f"背景图 {bg_pil.size[0]}x{bg_pil.size[1]} 与画布 {W}x{H} 不一致，已 lanczos 自动对齐")
            bg_pil = bg_pil.resize((W, H), Image.LANCZOS)

        # ---- 组装 PSD：底层干净背景 + 前景按 z_index 升序（stable sort，z 小在底）----
        psd = PSDImage.new("RGB", (W, H), color=0, depth=8)
        _append_layer(psd, bg_pil.convert("RGBA"), bg_layer_name)

        base_arr = np.asarray(base_rgb)
        canvas = bg_pil.convert("RGBA")  # 预览图：背景 + 前景按 z 序 alpha 合成
        for i in sorted(fg_idx, key=lambda k: int(layers[k].get("z_index", 0))):
            name = str(layers[i].get("layer_name") or f"层{i}")
            rgba = np.dstack([base_arr, (masks[i] * 255).astype(np.uint8)])
            pil_layer = Image.fromarray(rgba)  # (H,W,4) uint8 自动识别为 RGBA
            _append_layer(psd, pil_layer, name)
            canvas = Image.alpha_composite(canvas, pil_layer)

        # ---- 保存（中文层名在此生效：UTF-8 encoding + luni 双保险）----
        prefix = re.sub(r'[\\/:*?"<>|]', "_", str(文件名前缀).strip()) or "psd_export"
        out_dir = folder_paths.get_output_directory()
        out_path = os.path.join(out_dir, f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}.psd")
        psd.save(out_path, encoding="utf-8")

        prev = torch.from_numpy(
            np.asarray(canvas.convert("RGB")).astype(np.float32) / 255.0
        ).unsqueeze(0)

        size_mb = os.path.getsize(out_path) / 1024 ** 2
        _wp_log(
            f"PSD 已导出：{out_path}（{size_mb:.1f} MB）—— 底层「{bg_layer_name}」+ 前景 {len(fg_idx)} 层"
            f"（跳过背景层 {len(bg_names)} 个），画布 {W}x{H}",
            t0,
        )
        return (out_path, prev)


NODE_CLASS_MAPPINGS = {
    "WP_PsdExport": WP_PsdExport,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_PsdExport": "🐳 WP PSD导出",
}
