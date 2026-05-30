"""
Comfyui_WP_Node Group — 🐳 WP 滑条工具 (Universal Slider)
"""


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class GoohaiUniversalSlider:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "值": ("FLOAT", {
                    "default": 0.75,
                    "min": -999999,
                    "max": 999999,
                    "step": 0.01,
                    "display": "slider",
                }),
            },
            "hidden": {
                "output_type": (["float", "int"], {"default": "float"}),
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("*",)
    FUNCTION     = "execute"
    CATEGORY     = "🐳 WP_Node"

    def execute(self, 值, output_type="float"):
        processed_value = round(值, 10)
        if output_type == "int":
            return (int(round(processed_value)),)
        else:
            return (float(processed_value),)

    @classmethod
    def IS_CHANGED(cls, 值, output_type="float"):
        processed_value = round(float(值), 10)
        if output_type == "int":
            return int(round(processed_value))
        return processed_value


# ── 节点注册映射 ─────────────────────────────────
NODE_CLASS_MAPPINGS = {
    "WP_UniversalSlider": GoohaiUniversalSlider,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_UniversalSlider": "🐳 WP 滑条工具",
}
