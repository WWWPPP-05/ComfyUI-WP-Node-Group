/**
 * 🐳 WP H3视频拼接节点 - 渐进输入显示（latent_2..latent_16 按需出现）
 * 2026-11-23 新增（配套节点 v4 无限续接改造）；
 * 2026-11-23 修复动态槽位三个失效场景【2026-11-23 修复】；
 * 2026-11-23 修复槽位收敛后节点高度不收缩（下方大片空白）【2026-11-23 修复】；
 * 2026-11-23 修复 v2【2026-11-23 修复v2】：
 *   症状A：复制节点（含上游）粘贴时概率性连线断开
 *     原因：粘贴 = 建节点 → configure 灌 16 槽数据 →【异步若干拍】→ 恢复连线。
 *           此前收敛用 setTimeout(0) 单拍延迟，若连线恢复落在收敛之后，
 *           收敛已把未连接槽位删掉，连线恢复找不到落点 → 断开（竞态=概率性）。
 *   症状B：复制粘贴 / 刷新网页后，节点高度回到 16 槽全高、下方大片空白
 *     原因：ensureSlotsFromSchema 补槽时 litegraph addInput 会自动放大节点高度；
 *           若随后的收敛拍因同样竞态未执行（或执行在连线恢复前），节点停留在
 *           "16 槽高度 + 2 个槽位"的空白状态。
 *   修复 v2 三项（全部幂等，可安全重复执行）：
 *     1) 收敛永不删除"已连接"的槽位（即使收敛拍跑早，最坏只是多留空槽，绝不丢线）；
 *     2) 防抖 + 拖尾双拍收敛（120ms 防抖 + 400ms 兜底），覆盖粘贴/加载的任意多拍异步链；
 *     3) onAfterGraphConfigured 全图终检：图完全配置（含连线恢复）后对所有拼接节点
 *        做最后一次收敛 + 高度收缩，彻底覆盖刷新/加载路径。
 *
 * 节点后端固定声明 latent_1..latent_16 共 16 个可选输入；本扩展把"未启用"的
 * 槽位从画布节点上动态移除，实现渐进显示：
 *   - 初始只有 latent_1 + 一个空的 latent_2
 *   - latent_i 接入连线后，latent_(i+1) 出现
 *   - 断开 latent_i 后，其后的槽位全部收回
 *   - 槽位顺序即拼接顺序，中间空槽后端自动跳过
 *
 * 实现方式为 VHS Video Combine 同款的 removeInput/addInput 动态槽位
 * （本机前端 1.53.6 不支持 hiddenUntilConnected，因此走 JS 扩展）。
 * 加回槽位时按名称找到后端 inputs 定义补全 type 与 tooltip。
 */
import { app } from "../../scripts/app.js";

const NODE_TYPE = "WP_H3VideoConcat";
const PREFIX = "latent_";
const FIRST = 2;
const LAST = 16;

/** 防抖延迟：粘贴/加载的异步链（建节点→configure→恢复连线）通常在数十 ms 内完成，
 *  120ms 防抖可完整覆盖；拖尾兜底 400ms 再补一拍，应对更慢的恢复路径 */
const DEBOUNCE_MS = 120;
const TRAILING_MS = 400;

const isConcat = (n) => n && n.type === NODE_TYPE;
const slotName = (i) => PREFIX + i;

/** 某槽位当前是否已接入连线（槽位不存在视为未连接） */
function connected(node, name) {
    const inp = node.inputs?.find((i) => i.name === name);
    return !!inp && inp.link != null;
}

/**
 * 应用渐进规则【2026-11-23 修复v2：永不删除已连接槽位】
 * - 保留 latent_1..第一个未连接槽位（该空槽作为"下一个可用口"保留）
 * - 其后的槽位：已连接的【保留】（幂等且绝不丢线），未连接的移除
 *   → 即使本函数在连线恢复完成前被调用，也不会造成任何连线丢失；
 *     粘贴带"中间空槽"的工作流时，空槽后的已连接槽位同样保留
 * - 收敛后收缩节点高度（仅缩不放，不覆盖用户手动拉宽）
 */
function applyProgressive(node) {
    if (!isConcat(node) || node.__wpProgressiveLock) return;

    // 找到第一个未连接（或不存在）的槽位号（没有则到 LAST+1，即全部已连接）
    let firstFree = null;
    for (let s = FIRST; s <= LAST; s++) {
        if (!connected(node, slotName(s))) { firstFree = s; break; }
    }
    const keepUntil = firstFree == null ? LAST : firstFree; // 第一个空槽保留，其后按连接状态取舍

    node.__wpProgressiveLock = true;
    try {
        for (let s = keepUntil + 1; s <= LAST; s++) {
            const name = slotName(s);
            const inp = node.inputs.find((i) => i.name === name);
            // 【修复v2】已连接的槽位一律保留——删除它会直接断线
            if (inp && inp.link == null) {
                const idx = node.inputs.indexOf(inp);
                node.removeInput(idx);
            }
        }
        // 保证第一个空槽位存在（把收敛过程中被移除的链路头部加回来）
        if (keepUntil <= LAST && !node.inputs.some((i) => i.name === slotName(keepUntil))) {
            const def = node.constructor?.nodeData?.inputs?.[slotName(keepUntil)];
            node.addInput(slotName(keepUntil), def?.type ?? "LATENT");
        }
        // 【2026-11-23 修复】槽位移除后收缩节点高度：litegraph 的 removeInput 不会自动
        // 重算节点尺寸；且 addInput（ensureSlotsFromSchema 补槽）会自动放大高度。
        // 这里统一按当前 inputs/widgets 重算最小高度，仅收缩不放大。
        try {
            const cs = node.computeSize();
            if (Array.isArray(cs) && Array.isArray(node.size) && node.size[1] > cs[1] + 1) {
                node.size[1] = cs[1];
            }
        } catch (e) { /* computeSize 不可用时保持原尺寸，不影响功能 */ }
    } finally {
        node.__wpProgressiveLock = false;
    }
    node.setDirtyCanvas?.(true, true);
}

/**
 * 防抖 + 拖尾双拍收敛【2026-11-23 修复v2】
 * 粘贴/加载的连线恢复是异步多拍的：连续事件不断重置防抖计时器，最后一拍后
 * DEBOUNCE_MS 收敛一次；TRAILING_MS 兜底再补一拍，覆盖更慢的恢复路径。
 * 旧版 setTimeout(0) 单拍延迟在恢复链跨拍时会抢先删槽 → 概率性断线。
 */
function deferProgressive(node) {
    if (!isConcat(node)) return;
    clearTimeout(node.__wpDebounceT);
    clearTimeout(node.__wpTrailingT);
    node.__wpDebounceT = setTimeout(() => {
        if (node.graph) applyProgressive(node);
    }, DEBOUNCE_MS);
    node.__wpTrailingT = setTimeout(() => {
        if (node.graph) applyProgressive(node);
    }, DEBOUNCE_MS + TRAILING_MS);
}

/** 工作流加载/序列化时按需把被移除的槽位补回（litegraph 序列化会丢弃被 removeInput 的口，
 *  但老工作流里存有 latent_3..16 的空 widget 记录；这里按后端定义补全后由延迟收敛收敛）
 *  注意：addInput 会自动放大节点高度，最终高度由随后的收敛拍收缩 */
function ensureSlotsFromSchema(node) {
    if (!isConcat(node) || !node.constructor?.nodeData?.inputs) return;
    const inputsDef = node.constructor.nodeData.inputs;
    node.__wpProgressiveLock = true;
    try {
        for (let s = FIRST; s <= LAST; s++) {
            const name = slotName(s);
            if (!node.inputs.some((i) => i.name === name) && inputsDef[name]) {
                node.addInput(name, inputsDef[name].type ?? "LATENT");
            }
        }
    } finally {
        node.__wpProgressiveLock = false;
    }
}

app.registerExtension({
    name: "WP_Node_Group.H3ConcatProgressiveInputs",

    // 原型级挂载：连线变化与 configure 都在 prototype 层拦截，
    // 不依赖实例属性（1.53.6 前端不触发实例级 onConnectionsChange）
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;

        // 连线变化：交互接入/断开后防抖收敛（粘贴恢复连线也会走这里，
        // 每次恢复都会重置防抖计时器 → 收敛必然发生在全部连线恢复之后）
        const origConn = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, ...rest) {
            const r = origConn?.apply(this, [type, slotIndex, isConnected, ...rest]);
            if (type === 1 /*INPUT*/) deferProgressive(this);
            return r;
        };

        // configure 完成（粘贴/加载工作流灌数据）后防抖收敛
        const origCfg = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const r = origCfg?.apply(this, args);
            deferProgressive(this);
            return r;
        };

        const origOnAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function (...args) {
            const r = origOnAdded?.apply(this, args);
            if (isConcat(this)) applyProgressive(this);
            return r;
        };
    },

    // 新建节点：初始收敛为 latent_1 + 空的 latent_2
    async nodeCreated(node) {
        if (!isConcat(node)) return;
        applyProgressive(node);
    },

    // 载入已有工作流：先按后端定义补全被序列化丢弃的槽位（保住 link 的落点），
    // 再防抖收敛显示——不抢在 link 恢复之前删槽位
    async loadedGraphNode(node) {
        if (!isConcat(node)) return;
        ensureSlotsFromSchema(node);
        deferProgressive(node);
    },

    // 【2026-11-23 修复v2】图完全配置（含全部连线恢复）后的全图终检：
    // 对所有拼接节点做最后一次收敛 + 高度收缩。覆盖刷新/加载路径上任何
    // 早于连线恢复的收敛拍造成的高度残留，也兜底粘贴链的最后一拍。
    async onAfterGraphConfigured() {
        const nodes = app.graph?.nodes ?? [];
        for (const n of nodes) {
            if (isConcat(n)) applyProgressive(n);
        }
    },
});
