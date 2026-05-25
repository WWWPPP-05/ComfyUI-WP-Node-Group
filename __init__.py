"""
Comfyui_WP_Node Group - 自定义节点包
使用V1 API（传统方式）注册节点，兼容性更好
"""
from .nodes.image_load_node import ImageLoadNode
from .nodes.prompt_preset_node import PromptPresetNode
from .nodes.resolution_selector_node import ResolutionSelectorNode
from .nodes.image_split_node import ImageSplitNode
from .nodes.whale_api_node import WhaleAPINode
from .nodes.save_to_library_node import WPSaveToLibraryNode
from .nodes.prompt_list_node import PromptListNode
from .nodes.llama_loader_node import WpLlamaLoader
from .nodes.llama_inference_node import WpLlamaInference

# 导入资产库模块（注册API路由）
from .nodes import asset_library_node

NODE_CLASS_MAPPINGS = {
    "WP_ImageLoad": ImageLoadNode,
    "WP_PromptPreset": PromptPresetNode,
    "WP_ResolutionSelector": ResolutionSelectorNode,
    "WP_ImageSplit": ImageSplitNode,
    "WP_WhaleAPI": WhaleAPINode,
    "WP_SaveToLibrary": WPSaveToLibraryNode,
    "WP_PromptList": PromptListNode,
    "WP_LlamaLoader": WpLlamaLoader,
    "WP_LlamaInference": WpLlamaInference,
}

whale_emoji = chr(0x1F433)

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_ImageLoad": f"{whale_emoji} 加载图像",
    "WP_PromptPreset": f"{whale_emoji} WP 提示词预设",
    "WP_ResolutionSelector": f"{whale_emoji} 分辨率选择器",
    "WP_ImageSplit": f"{whale_emoji} 自动分割图像",
    "WP_WhaleAPI": f"{whale_emoji} WP_API 调用工具",
    "WP_SaveToLibrary": f"{whale_emoji} 导入资产库",
    "WP_PromptList": f"{whale_emoji} 提示词列表",
    "WP_LlamaLoader": f"{whale_emoji} WP 模型加载器",
    "WP_LlamaInference": f"{whale_emoji} WP 推理节点",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
