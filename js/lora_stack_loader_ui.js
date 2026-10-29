import { app } from "../../../scripts/app.js";

// ═══════════════════════════════════════════════════════════════
// 🐳 WP Lora堆加载器 · 开关 + 窄滑条（-4~4，红/黄/紫分段）
//  ⚠ 用 splice 原地插入，不替换 node.widgets 数组，避免破坏 ComfyUI 内部引用
//  ⚠ 自定义行 serialize:false —— 不写入 widgets_values，保证与无扩展环境双向兼容
// ═══════════════════════════════════════════════════════════════

const SLOTS = [
    { loraName: "LoRA_01", enableName: "启用_01", strengthName: "强度_01", index: 1 },
    { loraName: "LoRA_02", enableName: "启用_02", strengthName: "强度_02", index: 2 },
    { loraName: "LoRA_03", enableName: "启用_03", strengthName: "强度_03", index: 3 },
    { loraName: "LoRA_04", enableName: "启用_04", strengthName: "强度_04", index: 4 },
    { loraName: "LoRA_05", enableName: "启用_05", strengthName: "强度_05", index: 5 },
];

const RANGE_MIN = -4.0;
const RANGE_MAX = 4.0;
const RANGE_STEP = 0.01;
const WHEEL_STEP = 0.05;    // 滚轮微调步长
const DBLCLICK_MS = 350;    // 双击判定窗口

const ROW_H = 26;          // 自定义行高度
const TRACK_H = 8;         // 滑条高度
const TRACK_R = 4;         // 滑条圆角
const SWITCH_R = 4;        // 开关圆点半径
const SWITCH_HIT_R = 12;   // 开关命中半径（视觉4px + 8px 容差）
const MIN_NODE_W = 320;    // 节点最小宽度

// ── 工具 ──────────────────────────────────────────────
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function fmt(v) { return v.toFixed(2); }
function rrect(ctx, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
function isOn(w) { return !!(w && w.value === true); }
function getVal(w) { let v = Number(w ? w.value : 1); return isFinite(v) ? v : 1; }
function snap(v) {
    v = clamp(v, RANGE_MIN, RANGE_MAX);
    v = Math.round(v / RANGE_STEP) * RANGE_STEP;
    return Math.round(v * 100) / 100;
}
// 强度配色：负值=红（反向），<1=黄，>=1=紫
function colorOf(v) { return v < 0 ? "#ef4444" : (v < 1.0 ? "#f59e0b" : "#8b5cf6"); }
// 写入强度并触发画布刷新；markChange=true 时标记工作流已修改（未保存提示/自动保存）
function applyStrength(slot, v, markChange = true) {
    if (!slot.strengthWidget) return;
    slot.strengthWidget.value = snap(v);
    if (slot._node) {
        slot._node.setDirtyCanvas(true, false);
        if (markChange && slot._node.graph && slot._node.graph.change) slot._node.graph.change();
    }
}
// LoRA 文件是否已失效（不在下拉列表中）
function isMissing(slot) {
    const w = slot.loraWidget;
    if (!w || !w.options || !Array.isArray(w.options.values)) return false;
    const v = w.value;
    if (!v || v === "无" || v === "（暂无LoRA）") return false;
    return !w.options.values.includes(v);
}

// ── 绘制一个槽位：[◎开关] [═══滑条═══] [数值/缺失] ──
function drawSlot(ctx, node, slot, W, y, H) {
    const on = isOn(slot.enableWidget);
    const val = getVal(slot.strengthWidget);
    const missing = on && isMissing(slot);
    const alpha = on ? 1.0 : 0.45;

    const padX = 14;
    const swD = SWITCH_R * 2;        // 8
    const swGap = 10;
    const valGap = 8;
    const valW = 38;
    const centerY = y + H / 2;

    const trackW = Math.max(80, W - padX * 2 - swD - swGap - valW - valGap);
    const trackLeft = padX + swD + swGap;
    const trackY = centerY - TRACK_H / 2;
    const swX = padX + SWITCH_R;
    const swY = centerY;
    const valX = trackLeft + trackW + valGap + valW;

    slot._geom = {
        swX, swY, swR: SWITCH_R,
        tLeft: trackLeft, tTop: trackY, tW: trackW, tH: TRACK_H,
    };

    ctx.save();
    ctx.globalAlpha = alpha;

    // ── 开关圆点 ──
    if (on) {
        ctx.save();
        ctx.shadowColor = "rgba(74,222,128,0.45)";
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(swX, swY, SWITCH_R, 0, Math.PI * 2);
        ctx.fillStyle = "#4ade80";
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(swX, swY, SWITCH_R, 0, Math.PI * 2);
        ctx.fillStyle = "#4ade80";
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.arc(swX, swY, SWITCH_R, 0, Math.PI * 2);
        ctx.fillStyle = "#6b7280";
        ctx.globalAlpha = 0.5;
        ctx.fill();
        ctx.globalAlpha = alpha;
    }

    // ── 窄滑条 ──
    if (on) {
        // 轨道
        rrect(ctx, trackLeft, trackY, trackW, TRACK_H, TRACK_R);
        ctx.fillStyle = "#1a1a24";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // 填充：红 (<0) / 黄 (<1) / 紫 (≥1)
        const ratio = clamp((val - RANGE_MIN) / (RANGE_MAX - RANGE_MIN), 0, 1);
        const fillW = trackW * ratio;
        const fillColor = colorOf(val);
        if (fillW > 0.3) {
            rrect(ctx, trackLeft, trackY, fillW, TRACK_H, TRACK_R);
            ctx.fillStyle = fillColor;
            ctx.fill();
        }

        // 1.0 参考线（在 2/3 处）
        const refOne = trackLeft + trackW * ((1.0 - RANGE_MIN) / (RANGE_MAX - RANGE_MIN));
        ctx.beginPath();
        ctx.moveTo(refOne, trackY - 2);
        ctx.lineTo(refOne, trackY + TRACK_H + 2);
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // 拖拽把手
        if (slot._drag) {
            const tx = trackLeft + fillW;
            const ty = trackY + TRACK_H / 2;
            ctx.beginPath();
            ctx.arc(tx, ty, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = "#f5f0e8";
            ctx.fill();
            ctx.strokeStyle = fillColor;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    } else {
        rrect(ctx, trackLeft, trackY, trackW, TRACK_H, TRACK_R);
        ctx.fillStyle = "rgba(20,20,28,0.4)";
        ctx.fill();
    }

    // ── 数值 / 文件缺失提示 ──
    ctx.font = "bold 12px 'Segoe UI','Consolas',monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    if (missing) {
        ctx.fillStyle = "#ef4444";
        ctx.fillText("缺失", valX, centerY);
    } else if (on) {
        ctx.fillStyle = colorOf(val);
        ctx.fillText(fmt(val), valX, centerY);
    } else {
        ctx.fillStyle = "#7a7a8e";
        ctx.fillText("—", valX, centerY);
    }

    ctx.restore();
}

// ── 鼠标交互 ─────────────────────────────────────────
// 主路径：widget.mouse（litegraph 会把画布内 move/up 转发给捕获的 widget）
// 兜底：document 监听（仅覆盖拖出画布场景，坐标换算后与主路径同算法）
function handleMouse(event, pos, node, slot) {
    const g = slot._geom;
    if (!g) return;

    // 结束拖拽：pointer 会话结束/画布 mouseup 时转发给 widget.mouse
    if (event.type === "mouseup" || event.type === "pointerup") {
        if (slot._endDrag) { slot._endDrag(); return true; }
        return;
    }
    // 拖拽中：画布内 move 由 litegraph 转发，pos 为节点本地坐标
    if ((event.type === "mousemove" || event.type === "pointermove") && slot._drag) {
        applyStrength(slot, RANGE_MIN + clamp((pos[0] - g.tLeft) / g.tW, 0, 1) * (RANGE_MAX - RANGE_MIN), false);
        return true;
    }
    if (event.type !== "mousedown" && event.type !== "pointerdown") return;
    if (event.button !== 0) return;

    const hx = pos[0], hy = pos[1];

    // 开关命中
    if ((hx - g.swX) ** 2 + (hy - g.swY) ** 2 <= SWITCH_HIT_R ** 2) {
        if (slot.enableWidget) {
            slot.enableWidget.value = !isOn(slot.enableWidget);
            node.setDirtyCanvas(true, true);
            if (node.graph && node.graph.change) node.graph.change();
        }
        return true;
    }

    // 滑条命中
    if (hx < g.tLeft - 4 || hx > g.tLeft + g.tW + 4 || hy < g.tTop - 4 || hy > g.tTop + g.tH + 4) return;

    // 双击滑条：输入精确值
    const now = performance.now();
    if (now - (slot._lastTap || 0) < DBLCLICK_MS) {
        slot._lastTap = 0;
        const raw = prompt("输入强度值（-4 ~ 4）", String(getVal(slot.strengthWidget)));
        if (raw !== null) {
            const v = parseFloat(String(raw).trim());
            if (isFinite(v)) applyStrength(slot, v);
        }
        return true;
    }
    slot._lastTap = now;

    // 清理可能残留的旧拖拽监听（自愈：即使上次结束信号丢失也能恢复）
    if (slot._endDrag) slot._endDrag();

    // 单击跳值并进入拖拽
    applyStrength(slot, RANGE_MIN + clamp((hx - g.tLeft) / g.tW, 0, 1) * (RANGE_MAX - RANGE_MIN), false);
    slot._drag = true;

    // 结束拖拽并清理监听（幂等；widget up / document up / buttons 检测三路皆可触发）
    function endDrag() {
        if (!slot._drag) return;
        slot._drag = false;
        slot._endDrag = null;
        document.removeEventListener("mousemove", onDocMove);
        document.removeEventListener("mouseup", onDocUp);
        node.setDirtyCanvas(true, true);
        if (node.graph && node.graph.change) node.graph.change();
    }
    // document 兜底：与主路径同算法（屏幕坐标 → 画布坐标 → 节点本地），保证两路结果一致
    function onDocMove(e2) {
        if (!slot._drag) return;
        if (e2.buttons === 0) { endDrag(); return; }
        const c = app.canvas;
        if (!c || !c.canvas) return;
        const rect = c.canvas.getBoundingClientRect();
        const px = (e2.clientX - rect.left) * (c.canvas.width / rect.width);
        const py = (e2.clientY - rect.top) * (c.canvas.height / rect.height);
        const gp = c.convertCanvasToOffset([px, py]);
        const lx = gp[0] - node.pos[0];
        applyStrength(slot, RANGE_MIN + clamp((lx - g.tLeft) / g.tW, 0, 1) * (RANGE_MAX - RANGE_MIN), false);
    }
    function onDocUp() { endDrag(); }
    slot._endDrag = endDrag;
    document.addEventListener("mousemove", onDocMove);
    document.addEventListener("mouseup", onDocUp);
    return true;
}

// ── setup ────────────────────────────────────────────
function setupUI(node) {
    // 清理旧的自定义 widget
    if (node.widgets) {
        for (let i = node.widgets.length - 1; i >= 0; i--) {
            if (node.widgets[i] && node.widgets[i].type === "wp_lora_slot") {
                node.widgets.splice(i, 1);
            }
        }
    }

    const slots = [];
    for (const cfg of SLOTS) {
        const loraW = node.widgets ? node.widgets.find(w => w && w.name === cfg.loraName) : null;
        const enableW = node.widgets ? node.widgets.find(w => w && w.name === cfg.enableName) : null;
        const strengthW = node.widgets ? node.widgets.find(w => w && w.name === cfg.strengthName) : null;

        // 隐藏原生控件
        if (enableW) { enableW.hidden = true; enableW.computeSize = () => [0, 0]; }
        if (strengthW) { strengthW.hidden = true; strengthW.computeSize = () => [0, 0]; }

        const slot = { ...cfg, loraWidget: loraW, enableWidget: enableW, strengthWidget: strengthW, _node: node, _drag: false, _geom: null };
        slots.push(slot);
    }
    node._wpLoraSlots = slots;

    // 添加自定义 widget 并 splice 到正确位置
    for (const slot of slots) {
        const cw = node.addCustomWidget({
            name: "wp_lora_slot_" + slot.index,
            type: "wp_lora_slot",
            serialize: false,   // 不写入 widgets_values：避免污染位置序列化，与无扩展环境双向兼容
            draw(ctx, n, W, y, H) { drawSlot(ctx, n, slot, W, y, H); },
            mouse(event, pos, n) { return handleMouse(event, pos, n, slot); },
            computeSize(width) { return [width, ROW_H]; },
        });
        slot._customWidget = cw;

        // splice：从末尾移除刚加入的 cw，再插入到对应 LoRA combo 之后
        const cwIdx = node.widgets.indexOf(cw);
        if (cwIdx >= 0) node.widgets.splice(cwIdx, 1);
        const loraIdx = node.widgets.indexOf(slot.loraWidget);
        if (loraIdx >= 0) {
            node.widgets.splice(loraIdx + 1, 0, cw);
        }
        // 兜底：确保包装后的 widget 实例仍带 serialize:false
        if (cw) cw.serialize = false;
    }

    if (!node.size || node.size[0] < MIN_NODE_W) {
        node.size = [MIN_NODE_W, node.size ? node.size[1] : 0];
    }

    // combo 变化时刷新
    if (!node._wpCB) {
        const orig = node.onWidgetChanged;
        node.onWidgetChanged = function (name, value, widget) {
            if (orig) orig.call(this, name, value, widget);
            if (name && /^LoRA_\d+$/.test(name)) this.setDirtyCanvas(true, true);
        };
        node._wpCB = true;
    }
}

// ── 画布级命中（滚轮微调 + hover 光标共用） ──────────
function getGraphPos(e) {
    const c = app.canvas;
    const rect = c.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (c.canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (c.canvas.height / rect.height);
    return c.convertCanvasToOffset([x, y]);
}

function hitTestSlot(gp) {
    const graph = app.graph;
    if (!graph || !graph._nodes) return null;
    for (const node of graph._nodes) {
        if (!node._wpLoraSlots || (node.flags && node.flags.collapsed)) continue;
        const lx = gp[0] - node.pos[0];
        const ly = gp[1] - node.pos[1];
        if (lx < 0 || ly < 0 || !node.size || lx > node.size[0] || ly > node.size[1]) continue;
        for (const slot of node._wpLoraSlots) {
            const g = slot._geom;
            if (!g) continue;
            if ((lx - g.swX) ** 2 + (ly - g.swY) ** 2 <= SWITCH_HIT_R ** 2) return { node, slot };
            if (lx >= g.tLeft - 4 && lx <= g.tLeft + g.tW + 4 && ly >= g.tTop - 5 && ly <= g.tTop + g.tH + 5) return { node, slot };
        }
    }
    return null;
}

// ── 注册扩展 ─────────────────────────────────────────
app.registerExtension({
    name: "WP.LoraStackLoaderUI",
    async setup() {
        const cv = app.canvas && app.canvas.canvas;
        if (!cv) return;
        const parent = cv.parentElement || cv;

        // 滚轮微调（capture 阶段拦截，避免同时缩放画布）
        if (!parent._wpLoraWheel) {
            parent.addEventListener("wheel", (e) => {
                if (e.defaultPrevented) return;
                // 只处理直接发生在画布上的滚轮：Toast 通知、下拉弹窗等 DOM 覆盖层
                // 盖在画布上方时，其上的滚轮不应穿透到滑条（覆盖层位置的屏幕坐标
                // 换算成画布坐标后可能恰好落在滑条命中区内）
                if (e.target !== cv) return;
                const hit = hitTestSlot(getGraphPos(e));
                if (!hit || !isOn(hit.slot.enableWidget)) return;
                e.preventDefault();
                e.stopPropagation();
                applyStrength(hit.slot, getVal(hit.slot.strengthWidget) + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP));
            }, { capture: true, passive: false });
            parent._wpLoraWheel = true;
        }

        // hover 手型光标（仅命中行时设置，移出时还原）
        if (!cv._wpLoraCursor) {
            cv.addEventListener("mousemove", (e) => {
                if (e.buttons) return; // 按键拖拽中交给滑条逻辑
                const gp = (app.canvas && app.canvas.graph_mouse) ? app.canvas.graph_mouse : getGraphPos(e);
                const hit = hitTestSlot(gp);
                if (hit) cv.style.cursor = "pointer";
                else if (cv.style.cursor === "pointer") cv.style.cursor = "";
            });
            cv._wpLoraCursor = true;
        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "WP_LoRAStackLoader") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            setupUI(this);
            return r;
        };

        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            // 旧格式适配：早期版本的自定义行会往 widgets_values 写入 null 占位
            // （数组长度 = widget 总数）。还原时这些行被 serialize:false 跳过，
            // 不剔除占位会导致后续值整体错位。剔除后与原生 15 项格式对齐。
            if (info && Array.isArray(info.widgets_values) && this.widgets && this.widgets.length) {
                const customIdx = [];
                this.widgets.forEach((w, i) => { if (w && w.type === "wp_lora_slot") customIdx.push(i); });
                if (customIdx.length
                    && info.widgets_values.length === this.widgets.length
                    && customIdx.every(i => info.widgets_values[i] == null)) {
                    info.widgets_values = info.widgets_values.filter((_, i) => !customIdx.includes(i));
                }
            }
            if (onConfigure) onConfigure.apply(this, arguments);
            if (this.widgets) setupUI(this);
        };
    },
});

console.log("[WP_Node] Lora堆加载器 UI 已加载 - 开关 + 窄滑条（-4~4，红/黄/紫分段，滚轮微调/双击输入）");