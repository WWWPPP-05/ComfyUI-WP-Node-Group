class WPTextMergeNode:
    """🐳 WP 合并文本 — 按 文本1+间隔符+文本2 顺序合并，间隔符留空时默认单个空格"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本1": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                "文本2": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                "间隔符": ("STRING", {
                    "default": "",
                    "multiline": False,
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("输出文本",)
    FUNCTION = "execute"
    CATEGORY = "🐳 WP_Node"

    def execute(self, 文本1, 文本2, 间隔符):
        text1 = 文本1 or ""
        text2 = 文本2 or ""
        # 间隔符未填写（空值）时，自动使用单个空格
        sep = 间隔符 if 间隔符 else " "
        return (text1 + sep + text2,)


NODE_CLASS_MAPPINGS = {
    "WP_TextMerge": WPTextMergeNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_TextMerge": "🐳 WP 合并文本",
}
