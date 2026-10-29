class WPTextBoxNode:
    """🐳 WP 文本框 — 多行文本输入，输出字符串"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "execute"
    CATEGORY = "🐳 WP_Node"

    def execute(self, 文本):
        return (文本,)


NODE_CLASS_MAPPINGS = {
    "WP_TextBox": WPTextBoxNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_TextBox": "🐳 WP 文本框",
}