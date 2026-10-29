# -*- coding: utf-8 -*-
"""🐳 WP PSD背景补全 — 把前景层蒙版合并为红标图，供 Qwen Image 2.1 单图删除模式生成干净背景。

PoC-3 v2 验证结论（单图编辑模式）：
- 只喂一张红色标注图 + 删除指令 → 红标元素全部删除、未标区域保留、中位像素差 4.00
- 双图模式（干净原图+红标图）会忽略 mask 全图重绘，禁止使用
- 红标必须覆盖全部待删元素，漏标 = 元素残留
背景层蒙版是全图占位，绝不能标红（等于全图重绘），本节点按结果JSON 识别并排除。
"""
import json

import numpy as np
import torch

from .推理模型加载器节点 import _wp_log


class WP_PsdBgInpaint:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "原图（须与规划/精抠时用的同一张）。"}),
                "图层蒙版": ("MASK", {"tooltip": "接「🐳 WP PSD图层精抠」的图层蒙版输出（n 层批量）。"}),
                "结果JSON": ("STRING", {"multiline": True, "tooltip": "接「🐳 WP PSD图层精抠」的结果JSON，用于识别背景层。"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("红标图",)
    FUNCTION = "build"
    CATEGORY = "🐳 WP_Node"

    def build(self, image, 图层蒙版, 结果JSON):
        t0 = _wp_log("==== PSD背景补全 build 开始 ====")
        if image is None or int(image.shape[0]) == 0:
            raise ValueError("未检测到图片输入。")

        img = image[0].detach().cpu().numpy()
        H, W = img.shape[0], img.shape[1]

        if 图层蒙版 is None or 图层蒙版.dim() < 2:
            raise ValueError("图层蒙版格式不对，应接「🐳 WP PSD图层精抠」的图层蒙版输出（[n,H,W]）。")
        if 图层蒙版.dim() == 2:
            图层蒙版 = 图层蒙版.unsqueeze(0)
        if 图层蒙版.shape[-2:] != (H, W):
            raise ValueError(
                f"图层蒙版尺寸 {tuple(图层蒙版.shape[-2:])} 与原图 ({H},{W}) 不一致，"
                "请确认两个节点用的是同一张图。"
            )
        n = int(图层蒙版.shape[0])
        masks = (图层蒙版.detach().cpu().numpy() > 0.5)

        # ---- 背景层识别 1：按结果JSON 的 layer_type ----
        bg_idx, names = set(), [f"层{i}" for i in range(n)]
        try:
            layers = json.loads(结果JSON).get("layers", [])
        except Exception as e:
            layers = []
            _wp_log(f"警告：结果JSON解析失败（{e}），改用面积规则判定背景层")
        if layers:
            if len(layers) != n:
                _wp_log(f"警告：结果JSON层数({len(layers)})与蒙版批次数({n})不一致，改用面积规则")
            else:
                for i, l in enumerate(layers):
                    names[i] = str(l.get("layer_name", names[i]))
                    if str(l.get("layer_type", "")).lower() in ("背景", "background", "bg"):
                        bg_idx.add(i)

        # ---- 背景层识别 2（兜底）：面积 ≥90% 视为异常全图层，跳过红标 ----
        # 历史教训：SAM 曾把整只贴标杯身检出为 "label"，单层 mask 达 96.6% 画布，红标图几乎全红。
        # 正常前景层通常 ≤5% 画布，90% 阈值离它很远；该层若真有内容，会随主体层一并删除，无损。
        area = H * W
        for i in range(n):
            if i in bg_idx:
                continue
            cov = float(masks[i].sum()) / area
            if cov >= 0.90:
                bg_idx.add(i)
                _wp_log(f"层 {i}「{names[i]}」面积 {cov:.1%} 异常过大，跳过红标（内容会随其主体层一起删除）")

        # ---- 前景并集 → 红标叠加（纯红 255,0,0，PoC-3 v2 验证值）----
        fg = np.zeros((H, W), dtype=bool)
        for i in range(n):
            if i not in bg_idx:
                fg |= masks[i]
        if len(bg_idx):
            _wp_log(f"跳过背景层：{['%d:%s' % (i, names[i]) for i in sorted(bg_idx)]}")

        out = np.clip(img * 255.0, 0, 255).astype(np.uint8)
        out[fg] = (255, 0, 0)
        out_t = torch.from_numpy(out.astype(np.float32) / 255.0).unsqueeze(0)

        _wp_log(
            f"共 {n} 层，跳过背景 {len(bg_idx)} 层，红标覆盖 {float(fg.sum()) / area:.1%} 画布，"
            f"输出红标图 ({W}x{H})",
            t0,
        )
        return (out_t,)


NODE_CLASS_MAPPINGS = {
    "WP_PsdBgInpaint": WP_PsdBgInpaint,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_PsdBgInpaint": "🐳 WP PSD背景补全",
}
