"""🐳 简易画板节点 - 节点内嵌轻量画板：手绘 / 几何形状 / 文字 → 合并输出 RGBA 图像张量"""
import os

import numpy as np
import torch
from PIL import Image

import folder_paths


class WPSimpleCanvas:
    """🐳 WP 简易画板 — 全程在节点内部完成手绘、形状、文字编辑，点击「输出图像」合并三层内容输出图像。"""

    CATEGORY = "🐳 WP_Node"
    FUNCTION = "simple_canvas"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    DESCRIPTION = (
        "简易画板：节点内直接绘制（画笔/橡皮/矩形/圆形/三角形/文字），"
        "点击「输出图像」按钮合并背景层、位图层、矢量层，按画布设定尺寸输出 RGBA 图像，"
        "并仅刷新正下方直连的预览图像/保存图像类节点（不运行工作流其它部分）；"
        "整体运行工作流前会自动导出画布最新内容，保证下游用的是最新画布；"
        "开启「自动输出」后每次编辑完成自动更新。画布内容随工作流保存与恢复。"
        "支持 Ctrl+V 粘贴剪贴板图片至画布中心（可撤销）；"
        "「分割」工具圈选任意形状区域，一键拆分为独立新图层（原图层保留缺口，可撤销）。"
    )

    @staticmethod
    def _latest_output(unique_id):
        """查找本节点最新的画板输出（前端命名 WP.canvas.output.n{node_id}.{ts}.png），并清理旧文件"""
        if unique_id is None:
            return None
        d = folder_paths.get_input_directory()
        prefix = f"WP.canvas.output.n{unique_id}."
        try:
            files = [os.path.join(d, f) for f in os.listdir(d) if f.startswith(prefix) and f.endswith(".png")]
        except OSError:
            return None
        if not files:
            return None
        files.sort(key=lambda p: os.path.getmtime(p))
        for old in files[:-1]:
            try:
                os.remove(old)
            except OSError:
                pass
        return files[-1]

    @classmethod
    def IS_CHANGED(cls, unique_id=None, **kwargs):
        """画板文件经由 input 目录传递，不在工作流数据中，执行缓存无法感知其更新；
        以最新画板文件的修改时间作为缓存指纹，文件一变即强制重新执行本节点"""
        out = cls._latest_output(unique_id)
        if out:
            try:
                return f"canvas:{os.path.getmtime(out)}"
            except OSError:
                return float("NaN")
        return ""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def simple_canvas(self, unique_id=None):
        out_path = self._latest_output(unique_id)
        if out_path and os.path.isfile(out_path):
            img = Image.open(out_path).convert("RGBA")
        else:
            # 尚未点击「输出图像」时输出全透明占位图，避免下游节点报错
            img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        tensor = torch.from_numpy(np.array(img)).unsqueeze(0).float() / 255.0
        return (tensor,)


NODE_CLASS_MAPPINGS = {
    "WP_SimpleCanvas": WPSimpleCanvas,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_SimpleCanvas": "🐳 WP 简易画板",
}
