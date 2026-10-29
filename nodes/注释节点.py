class WPAnnotateNode:
    """🐳 WP 注释节点 — 在工作流中绘制带样式的注释框"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "🐳 WP_Node"
    OUTPUT_NODE = True

    def execute(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "WP_Annotate": WPAnnotateNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_Annotate": "🐳 WP 注释节点",
}
