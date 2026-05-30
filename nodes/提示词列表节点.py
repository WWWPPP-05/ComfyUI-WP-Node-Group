"""
🐳 提示词列表节点
功能：批量管理多个提示词，支持统一添加前缀，输出为字符串列表
"""


class PromptListNode:
    """
    🐳 提示词列表节点
    
    批量管理多个提示词，支持统一添加前缀文字
    输出为字符串列表，跳过空的提示词输入框
    """
    
    CATEGORY = "🐳 WP_Node"
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "generate_prompt_list"
    OUTPUT_NODE = True
    OUTPUT_IS_LIST = (True,)
    
    @classmethod
    def INPUT_TYPES(cls):
        max_slots = 20
        prompt_inputs = {}
        for i in range(1, max_slots + 1):
            prompt_inputs[f"提示词_{i}"] = ("STRING", {
                "default": "",
                "multiline": True,
            })
        
        return {
            "required": {
                "统一添加": ("STRING", {
                    "default": "",
                    "multiline": False,
                }),
                "输入框数量": ("INT", {
                    "default": 3,
                    "min": 1,
                    "max": 20,
                    "step": 1,
                }),
                **prompt_inputs,
            },
        }
    
    def generate_prompt_list(self, 统一添加, 输入框数量, **kwargs):
        """
        核心处理方法：收集所有非空提示词，添加前缀后返回列表
        """
        result = []
        
        for i in range(1, 输入框数量 + 1):
            key = f"提示词_{i}"
            content = kwargs.get(key, "").strip()
            
            if content:
                if 统一添加:
                    content = 统一添加 + content
                result.append(content)
        
        return (result,)
