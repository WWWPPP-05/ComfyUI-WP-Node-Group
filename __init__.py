"""
Comfyui_WP_Node Group - 自定义节点包
使用V1 API（传统方式）注册节点，兼容性更好
"""
from .nodes.加载图像节点 import ImageLoadNode
from .nodes.提示词预设节点 import PromptPresetNode
from .nodes.分辨率选择器节点 import ResolutionSelectorNode
from .nodes.自动分割图像节点 import ImageSplitNode
from .nodes.API调用工具节点 import WhaleAPINode
from .nodes.导入资产库节点 import WPSaveToLibraryNode
from .nodes.推理模型加载器节点 import WpLlamaLoader
from .nodes.推理节点 import WpLlamaInference
from .nodes.提示词列表节点 import PromptListNode
from .nodes.滑条工具节点 import GoohaiUniversalSlider
from .nodes.忽略多组节点 import IgnoreGroupsGuHai
from .nodes.注释节点 import WPAnnotateNode

# 导入资产库模块（注册API路由）
from .nodes import 资产库节点

NODE_CLASS_MAPPINGS = {
    "WP_ImageLoad": ImageLoadNode,
    "WP_PromptPreset": PromptPresetNode,
    "WP_ResolutionSelector": ResolutionSelectorNode,
    "WP_ImageSplit": ImageSplitNode,
    "WP_WhaleAPI": WhaleAPINode,
    "WP_SaveToLibrary": WPSaveToLibraryNode,
    "WP_LlamaLoader": WpLlamaLoader,
    "WP_LlamaInference": WpLlamaInference,
    "WP_PromptList": PromptListNode,
    "WP_UniversalSlider": GoohaiUniversalSlider,
    "WP_IgnoreGroups": IgnoreGroupsGuHai,
    "WP_Annotate": WPAnnotateNode,
}

whale_emoji = chr(0x1F433)

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_ImageLoad": f"{whale_emoji} WP 加载图像",
    "WP_PromptPreset": f"{whale_emoji} WP 提示词预设",
    "WP_ResolutionSelector": f"{whale_emoji} WP 分辨率选择器",
    "WP_ImageSplit": f"{whale_emoji} WP 自动分割图像",
    "WP_WhaleAPI": f"{whale_emoji} WP_API 调用工具",
    "WP_SaveToLibrary": f"{whale_emoji} WP 导入资产库",
    "WP_LlamaLoader": f"{whale_emoji} WP 模型加载器",
    "WP_LlamaInference": f"{whale_emoji} WP 推理节点",
    "WP_PromptList": f"{whale_emoji} WP 提示词列表",
    "WP_UniversalSlider": f"{whale_emoji} WP 滑条工具",
    "WP_IgnoreGroups": f"{whale_emoji} WP 忽略多组",
    "WP_Annotate": f"{whale_emoji} WP 注释节点",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
