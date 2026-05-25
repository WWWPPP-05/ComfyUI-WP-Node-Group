/**
 *  提示词列表节点 - 前端扩展
 * 提供动态调整输入框数量的 UI 功能
 */
import { app } from "../../scripts/app.js";

// 节点类型名称
const NODE_TYPE = "WP_PromptList";

// 最大输入框数量
const MAX_INPUTS = 20;

// 默认输入框数量
const DEFAULT_COUNT = 3;

// 注册节点扩展
app.registerExtension({
    name: "WP_Node.PromptList",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== NODE_TYPE) return;

        // 保存原始的 onNodeCreated
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.configure;

        nodeType.prototype.onNodeCreated = function() {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            const node = this;

            // 延迟执行，确保 widget 已完全创建
            setTimeout(() => {
                const numberWidget = node.widgets.find(w => w.name === "输入框数量");
                if (numberWidget) {
                    // 应用初始隐藏状态（新节点使用默认值 3）
                    const currentCount = Math.max(1, Math.min(MAX_INPUTS, Math.floor(numberWidget.value)));
                    applyHiddenState(node, currentCount);

                    // 新建节点给一个固定高度（基于默认 3 个输入框）
                    node.setSize([400, 300]);

                    // 绑定用户修改时的回调
                    const originalCallback = numberWidget.callback;
                    numberWidget.callback = function(value) {
                        if (originalCallback) originalCallback.apply(this, arguments);
                        const count = Math.max(1, Math.min(MAX_INPUTS, Math.floor(value)));
                        applyHiddenState(node, count);

                        // 用户修改数量时重新计算高度
                        resizeNode(node, count);
                    };
                }
            }, 100);

            return result;
        };

        nodeType.prototype.configure = function(info) {
            // 保存原始尺寸
            const s = info.size ? [info.size[0], info.size[1]] : null;
            // 调用原始 configure 恢复数据
            if (originalConfigure) originalConfigure.apply(this, arguments);
            // 从已恢复的 widget 中读取输入框数量
            const countWidget = this.widgets.find(w => w.name === "输入框数量");
            let c = DEFAULT_COUNT;
            if (countWidget && countWidget.value != null) {
                c = Math.max(1, Math.min(MAX_INPUTS, Math.floor(countWidget.value)));
            }
            // 应用隐藏状态
            applyHiddenState(this, c);
            // 恢复保存的尺寸
            if (s) { this.size[0] = s[0]; this.size[1] = s[1]; }
            // 必须返回 true，否则 LiteGraph 认为配置失败会重置节点
            return true;
        };
    }
});

/**
 * 应用 widget 隐藏状态
 * @param {Object} node - 节点实例
 * @param {number} count - 要显示的输入框数量
 */
function applyHiddenState(node, count) {
    for (let i = 1; i <= MAX_INPUTS; i++) {
        const widget = node.widgets.find(w => w.name === `提示词_${i}`);
        if (widget) {
            if (i > count) {
                // 隐藏的 widget 返回 0 高度，不触发尺寸重算
                widget._originalComputeSize = widget._originalComputeSize || widget.computeSize;
                widget.computeSize = () => [0, 0];
                widget.hidden = true;
            } else {
                // 恢复原始 computeSize
                if (widget._originalComputeSize) {
                    widget.computeSize = widget._originalComputeSize;
                }
                widget.hidden = false;
            }
        }
    }
}

/**
 * 手动计算并调整节点高度（只基于可见 widget）
 * @param {Object} node - 节点实例
 * @param {number} count - 要显示的输入框数量
 */
function resizeNode(node, count) {
    if (!node.setSize || !node.widgets) return;

    // 计算可见 widget 的总高度
    let totalHeight = 0;
    const WIDGET_MARGIN = 4;  // widget 之间的间距
    const BOTTOM_PADDING = 20; // 底部留白
    const HEADER_HEIGHT = 30;  // 标题栏高度

    // 统计每个可见 widget 的高度
    for (const widget of node.widgets) {
        if (!widget.hidden) {
            // widget 高度 = 实际渲染高度 + 间距
            totalHeight += (widget.computeSize ? widget.computeSize(node.size[0])[1] : 40) + WIDGET_MARGIN;
        }
    }

    // 加上标题栏和底部留白
    totalHeight += HEADER_HEIGHT + BOTTOM_PADDING;

    node.setSize([node.size[0], totalHeight]);
}

console.log("[ 提示词列表] 前端扩展已加载");
