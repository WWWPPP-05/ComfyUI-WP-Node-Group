/**
 * 🐳 提示词列表节点 - 前端扩展
 * 动态显示/隐藏提示词输入框，节点高度自动伸缩
 */
import { app } from "../../scripts/app.js";

const NODE_TYPE = "WP_PromptList";

const INPUT_HEIGHT = 60;
const BASE_HEIGHT = 180;
const MAX_SLOTS = 20;

function getPromptWidgetName(index) {
    return `提示词_${index}`;
}

function syncPromptWidgets(node, count) {
    const clampedCount = Math.min(count, MAX_SLOTS);

    for (let i = 1; i <= MAX_SLOTS; i++) {
        const widget = node.widgets.find(w => w.name === getPromptWidgetName(i));
        if (widget) {
            widget.hidden = i > clampedCount;
        }
    }
}

function adjustNodeHeight(node, count) {
    const clampedCount = Math.min(count, MAX_SLOTS);
    const neededHeight = BASE_HEIGHT + clampedCount * INPUT_HEIGHT;
    if (node.size.height < neededHeight) {
        node.size.height = neededHeight;
    }
}

app.registerExtension({
    name: "WP_Node.PromptList",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function() {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            const node = this;

            this.size = [400, 360];

            const countWidget = this.widgets.find(w => w.name === "输入框数量");
            if (countWidget) {
                const currentValue = countWidget.value;
                syncPromptWidgets(node, currentValue);
                adjustNodeHeight(node, currentValue);

                const originalCallback = countWidget.callback;
                countWidget.callback = function(value) {
                    if (originalCallback) {
                        originalCallback.call(this, value);
                    }
                    syncPromptWidgets(node, value);
                    adjustNodeHeight(node, value);
                };
            }

            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function(info) {
            const result = onConfigure ? onConfigure.call(this, info) : undefined;

            const countWidget = this.widgets.find(w => w.name === "输入框数量");
            if (countWidget) {
                syncPromptWidgets(this, countWidget.value);
                adjustNodeHeight(this, countWidget.value);
            }

            return result;
        };
    },
});

console.log("[WP提示词列表] 前端扩展已加载");
