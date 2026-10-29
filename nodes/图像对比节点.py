"""🐳 图像对比节点 - 在节点内对比两张图像（继承 ComfyUI 内置 PreviewImage，复用图片保存逻辑）"""
from nodes import PreviewImage


class WPImageComparer(PreviewImage):
    """🐳 WP 图像对比 — 在节点内叠放对比两张图，支持悬停滑动或点击切换（前端交互实现）。"""

    CATEGORY = "🐳 WP_Node"
    FUNCTION = "compare_images"
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    DESCRIPTION = "对比两张图像：鼠标在节点上左右滑动即可对比 A/B 两侧效果。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "image_a": ("IMAGE",),
                "image_b": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def compare_images(self, image_a=None, image_b=None, filename_prefix="WP.compare.", prompt=None, extra_pnginfo=None):
        result = {"ui": {"a_images": [], "b_images": []}}
        if image_a is not None and len(image_a) > 0:
            result["ui"]["a_images"] = self.save_images(image_a, filename_prefix, prompt, extra_pnginfo)["ui"]["images"]
        if image_b is not None and len(image_b) > 0:
            result["ui"]["b_images"] = self.save_images(image_b, filename_prefix, prompt, extra_pnginfo)["ui"]["images"]
        return result


NODE_CLASS_MAPPINGS = {
    "WP_ImageComparer": WPImageComparer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_ImageComparer": "🐳 WP 图像对比",
}