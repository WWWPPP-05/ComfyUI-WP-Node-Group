"""🐳 全景图预览节点 - 前端360°全景查看 + 视角截图输出（继承 ComfyUI 内置 PreviewImage，复用图片保存逻辑）"""
import hashlib
import os

import numpy as np
import torch
from PIL import Image

import folder_paths
from nodes import PreviewImage


class WPPanoramaView(PreviewImage):
    """🐳 WP 全景图预览 — 弹窗360°查看全景图，选择视角与输出比例截图，由输出端口输出截图画面（截图前透传原图）。"""

    CATEGORY = "🐳 WP_Node"
    FUNCTION = "panorama_view"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    DESCRIPTION = (
        "360°全景图预览：运行工作流后点击节点上的「启动全景预览」按钮，"
        "在节点内显示区中拖拽旋转、滚轮缩放，选择输出比例（紫色取景框实时显示范围）后截图，"
        "输出端口即输出截图画面；截图前输出原图。"
    )

    # unique_id -> {"fp": 指纹, "images": 上次保存的回传结果}（输入未变时复用，避免重复落盘与前端闪刷）
    _source_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                "截图最大边像素": ("INT", {"default": 1536, "min": 64, "max": 4096, "tooltip": "截图输出图像最长边的像素值：长边等于该数值，短边按【输出比例】自动计算（例：1536 配 16:9 = 1536×864；配 9:16 = 864×1536）。只影响截图，不影响透传的原图"}),
                "输出比例": (["1:1", "2:3", "3:4", "9:16", "3:2", "4:3", "16:9", "21:9"], {"default": "1:1", "tooltip": "紫色取景框的输出比例"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @staticmethod
    def _tensor_fp(tensor):
        h = hashlib.md5()
        h.update(str(tuple(tensor.shape)).encode())
        h.update(tensor.detach().float().cpu().numpy().tobytes())
        return h.hexdigest()

    @staticmethod
    def _latest_capture(unique_id):
        """查找本节点最新的前端截图（前端命名 WP.pano.capture.n{node_id}.{ts}.png），并清理旧文件"""
        if unique_id is None:
            return None
        d = folder_paths.get_input_directory()
        prefix = f"WP.pano.capture.n{unique_id}."
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
    def IS_CHANGED(cls, **kwargs):
        """截图文件经由 input 目录传递，不在工作流数据中，执行缓存无法感知其更新；
        以最新截图的修改时间作为缓存指纹，截图一变即强制重新执行本节点"""
        cap = cls._latest_capture(kwargs.get("unique_id"))
        if cap:
            try:
                return f"capture:{os.path.getmtime(cap)}"
            except OSError:
                return float("NaN")
        return ""

    def panorama_view(self, image, 截图最大边像素=1536, 输出比例="1:1", prompt=None, extra_pnginfo=None, unique_id=None):
        ui = {"pano_images": [], "capture": ""}

        # 输入全景图保存到临时目录并回传前端，供全景查看器显示
        if image is not None and len(image) > 0:
            key = str(unique_id) if unique_id is not None else "_"
            fp = self._tensor_fp(image)
            cached = self._source_cache.get(key)
            if cached and cached["fp"] == fp:
                ui["pano_images"] = cached["images"]
            else:
                saved = self.save_images(image, "WP.panorama.source.", prompt, extra_pnginfo)["ui"]["images"]
                if len(self._source_cache) > 64:
                    self._source_cache.clear()
                self._source_cache[key] = {"fp": fp, "images": saved}
                ui["pano_images"] = saved

        # 输出：有最新截图 → 输出截图（长边归一到设定值）；无截图 → 透传原图
        out = image
        cap_path = self._latest_capture(unique_id)
        if cap_path and os.path.isfile(cap_path):
            ui["capture"] = os.path.basename(cap_path)
            img = Image.open(cap_path)
            if img.mode == "I":
                img = img.point(lambda i: i * (1 / 255))
            image_rgb = img.convert("RGB")
            # 前端已按目标尺寸渲染，这里仅做长边一致性兜底（旧截图或尺寸偏差）；数值异常时回退默认 1536
            target = 截图最大边像素 if 截图最大边像素 >= 64 else 1536
            w, h = image_rgb.size
            if max(w, h) != target:
                scale = target / max(w, h)
                resample = getattr(Image, "Resampling", Image).LANCZOS
                image_rgb = image_rgb.resize((max(1, round(w * scale)), max(1, round(h * scale))), resample)
            out = torch.from_numpy(np.array(image_rgb)).unsqueeze(0).float() / 255.0

        return {"ui": ui, "result": (out,)}


NODE_CLASS_MAPPINGS = {
    "WP_PanoramaView": WPPanoramaView,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_PanoramaView": "🐳 WP 全景图预览",
}
