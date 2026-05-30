/**
 * 🐳 WP_Node Group - 节点颜色设置
 * 为所有WP_Node节点设置紫色标题栏和白色字体，节点主体使用ComfyUI默认颜色
 */
import { app } from "../../scripts/app.js";

// 紫色 - 用于节点标题栏背景
const HEADER_COLOR = "#662ad5";
// 白色 - 用于节点标题栏字体
const TITLE_TEXT_COLOR = "#FFFFFF";

// 需要设置颜色的节点类型列表
const NODE_TYPES = [
    "WP_ImageLoad",          // 🐳 WP 加载图像
    "WP_PromptPreset",       //  WP 提示词预设
    "WP_ResolutionSelector", // 🐳 WP 分辨率选择器
    "WP_ImageSplit",         // 🐳 WP 自动分割图像
    "WP_WhaleAPI",           // 🐳 WP_API 调用工具
    "WP_SaveToLibrary",      // 🐳 WP 导入资产库
    "WP_PromptList",         // 🐳 WP 提示词列表
    "WP_LlamaLoader",        // 🐳 WP 模型加载器
    "WP_LlamaInference",     // 🐳 WP 推理节点
    "WP_UniversalSlider",    // 🐳 WP 滑条工具
    "WP_IgnoreGroups",       // 🐳 WP 忽略多组
];

// 注册扩展
app.registerExtension({
    name: "WP_Node.Color",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // 检查是否是需要设置颜色的节点类型
        if (!NODE_TYPES.includes(nodeData.name)) return;

        // 保存原始的onNodeCreated
        const onNodeCreated = nodeType.prototype.onNodeCreated;

        // 重写onNodeCreated方法
        nodeType.prototype.onNodeCreated = function() {
            // 调用原始的onNodeCreated
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            // 设置标题栏背景颜色和字体颜色
            this.color = HEADER_COLOR;
            this.title_color = TITLE_TEXT_COLOR;

            return result;
        };
    },

    // 节点加载完成后也设置颜色（确保颜色生效）
    async nodeCreated(node) {
        // 检查是否是需要设置颜色的节点类型
        if (!NODE_TYPES.includes(node.type)) return;

        // 设置标题栏背景颜色和字体颜色
        node.color = HEADER_COLOR;
        node.title_color = TITLE_TEXT_COLOR;

        // 刷新画布以显示新颜色
        node.setDirtyCanvas(true, true);
    }
});

console.log("[WP_Node] 节点颜色扩展已加载 - 紫色标题栏 + 白色字体 + 默认节点背景");
