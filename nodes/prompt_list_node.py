"""
 提示词列表节点
功能：多个提示词输入框，支持动态调整数量，输出字符串列表
"""


class PromptListNode:
    """
    🐳 提示词列表节点
    支持最多 20 个提示词输入框，输出为字符串列表
    """

    @classmethod
    def INPUT_TYPES(s):
        # 构建 optional 输入字典
        optional_inputs = {}
        for i in range(1, 21):  # 1 到 20
            optional_inputs[f"提示词_{i}"] = ("STRING", {"multiline": True, "default": ""})

        return {
            "required": {
                "输入框数量": ("INT", {"default": 3, "min": 1, "max": 20}),
                "统一添加": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": optional_inputs,
        }

    CATEGORY = "🐳 WP_Node"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "combine_prompts"
    OUTPUT_IS_LIST = (True,)

    def combine_prompts(self, 输入框数量, 统一添加, **kwargs):
        """收集所有非空的提示词，输出为字符串列表"""
        results = []

        # 只处理前 N 个提示词输入框（N = 输入框数量）
        for i in range(1, int(输入框数量) + 1):
            key = f"提示词_{i}"
            value = kwargs.get(key, "").strip()
            if value:
                # 统一添加 + 当前提示词
                if 统一添加.strip():
                    results.append(统一添加.strip() + " " + value)
                else:
                    results.append(value)

        return (results,)

    @classmethod
    def IS_CHANGED(s, 输入框数量, 统一添加, **kwargs):
        """检测输入是否变化"""
        return f"{输入框数量}_{统一添加}_{hash(tuple(sorted(kwargs.items())))}"
