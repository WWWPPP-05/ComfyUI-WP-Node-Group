class IgnoreGroupsGuHai:
    """🐳 WP 忽略多组 — 通过开关控制工作流中各编组的忽略/旁路状态"""

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
    "WP_IgnoreGroups": IgnoreGroupsGuHai,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_IgnoreGroups": "🐳 WP 忽略多组",
}
