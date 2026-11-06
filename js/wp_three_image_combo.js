/**
 * 🐳 WP 三图组合节点 前端（四图版：脸模 + 服装 + 姿势 + 发型）
 * 节点卡片界面 + 素材库弹窗（浏览/搜索/大图查看/描述编辑）+ 脸模弹窗 + 随机组合 + 库开关（端口隐藏）
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "WP_ThreeImageCombo";

const SLOTS = {
    face: { index: 0, title: "1 · 脸模", color: "#f0c24b", widget: "脸模文件" },
    outfit: { index: 1, title: "2 · 服装", color: "#6ea8ff", widget: "服装选择", lib: "outfit", libName: "服装库", toggleWidget: "服装库开关" },
    pose: { index: 2, title: "3 · 姿势", color: "#ff9e5e", widget: "姿势选择", lib: "pose", libName: "姿势库", toggleWidget: "姿势库开关" },
    hair: { index: 3, title: "4 · 发型", color: "#7ed39a", widget: "发型选择", lib: "hair", libName: "发型库", toggleWidget: "发型库开关" },
};
const LIB_SLOTS = ["outfit", "pose", "hair"];
// 节点完整输出端口序列（用于加载旧工作流后自愈被隐藏端口导致缺失/错位的 outputs）
const FULL_OUTPUTS = [["脸模图像", "IMAGE"], ["服装图像", "IMAGE"], ["姿势图像", "IMAGE"], ["发型图像", "IMAGE"], ["整合提示词", "STRING"]];

// 整合提示词模板（与后端 三图组合节点.py 保持一致）
const PROMPT_TPL = {
    face: "使用图1参考面部，保留可辨识的五官比例、脸型、肤色与发型，不沿用图片1的服装和动作。",
    outfit: "服装参考图2{seg}，准确还原款式、剪裁、配色、面料纹理与装饰细节，使衣物自然贴合图片1人物的身体，不复制图片2的人脸或姿势。",
    pose: "动作严格按照图3姿态{seg}及观察角度进行参考，遵循躯干朝向、四肢位置、重心和透视关系，不复制图片3的身份、服装或背景。",
    hair: "发型参考图4{seg}，准确还原发型的轮廓、长度、卷度、刘海形态与颜色，使发型自然贴合图片1人物的头型与发际线，不复制图片4的人脸、表情或头部姿态。",
};

// ---------- 样式 ----------
let _styleDone = false;
function ensureStyle() {
    if (_styleDone) return;
    _styleDone = true;
    const style = document.createElement("style");
    style.textContent = `
.wp3c-root { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: #e9ecf1; user-select: none;
    height:100%; box-sizing:border-box; overflow:hidden; }
.wp3c-hint { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
.wp3c-hint-text { font-size:12px; color:#a3abb8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wp3c-btn { border:1px solid #343a44; background:#1a1e24; color:#e9ecf1; border-radius:8px; padding:5px 12px;
    font-size:12px; cursor:pointer; white-space:nowrap; transition:background .15s,border-color .15s; }
.wp3c-btn:hover { background:#232831; border-color:#4a525f; }
.wp3c-btn:disabled { opacity:.45; cursor:not-allowed; background:#1a1e24; border-color:#272c34; }
.wp3c-btn.primary { background:#2c4a78; border-color:#3d6ab0; }
.wp3c-btn.primary:hover { background:#35588f; }
.wp3c-cards { display:flex; gap:8px; align-items:stretch; }
.wp3c-card { flex:1 1 0; min-width:0; background:#1a1e24; border:1px solid #272c34; border-radius:12px;
    display:flex; flex-direction:column; overflow:hidden; transition:opacity .2s, filter .2s; }
.wp3c-card.wp3c-off { opacity:.45; filter:saturate(.35); }
.wp3c-card-head { display:flex; align-items:center; gap:6px; padding:6px 10px; font-size:13px; font-weight:700; color:#111418; }
.wp3c-card-title { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wp3c-tg { margin-left:auto; width:34px; height:18px; border-radius:999px; border:1px solid rgba(0,0,0,.25);
    background:#8d97a5; position:relative; cursor:pointer; padding:0; flex:0 0 auto; transition:background .15s; }
.wp3c-tg::after { content:""; position:absolute; top:1px; left:1px; width:14px; height:14px; border-radius:50%;
    background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); transition:left .15s; }
.wp3c-tg.wp3c-tg-on { background:#2f9e63; }
.wp3c-tg.wp3c-tg-on::after { left:17px; }
.wp3c-card-imgbox { position:relative; height:var(--wp3c-img-h, 190px); background:#0d0f12;
    display:flex; align-items:center; justify-content:center; transition:height .25s ease; }
.wp3c-card-imgbox img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
.wp3c-card-empty { font-size:12px; color:#6c7482; text-align:center; padding:0 8px; line-height:1.7; }
.wp3c-card-name { padding:6px 10px 4px; font-size:12px; font-weight:700; color:#e9ecf1;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wp3c-card-desc { padding:0 10px 6px; font-size:11px; color:#a3abb8; line-height:1.5; height:34px; overflow:hidden;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.wp3c-card-btns { display:flex; gap:6px; padding:6px 10px 10px; }
.wp3c-card-btns .wp3c-btn { flex:1 1 0; padding:4px 6px; font-size:12px; }
.wp3c-card-btns .wp3c-btn.wp3c-icon { flex:0 0 auto; padding:4px 11px; }
.wp3c-prompt { margin-top:8px; background:#1a1e24; border:1px solid #272c34; border-radius:10px; padding:8px 12px; }
.wp3c-prompt-head { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:5px; }
.wp3c-prompt-head .wp3c-btn { padding:3px 10px; font-size:11px; }
.wp3c-prompt-text { font-size:12px; color:#c3cad6; line-height:1.65; white-space:pre-wrap; word-break:break-all;
    user-select:text; max-height:130px; overflow-y:auto; }

/* ===== 弹窗 ===== */
.wp3c-overlay { position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,.62);
    display:flex; align-items:center; justify-content:center; font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif; }
.wp3c-dialog { width:min(1460px,96vw); height:min(900px,94vh); background:#14171c; border:1px solid #343a44;
    border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.45); display:flex; flex-direction:column; overflow:hidden; color:#e9ecf1; }
.wp3c-dlg-head { display:flex; align-items:center; gap:12px; padding:14px 18px 10px; }
.wp3c-dlg-title { font-size:17px; font-weight:700; }
.wp3c-dlg-sub { font-size:12px; color:#a3abb8; }
.wp3c-dlg-close { margin-left:auto; width:34px; height:34px; border-radius:9px; border:1px solid #343a44;
    background:#1a1e24; color:#e9ecf1; font-size:15px; cursor:pointer; }
.wp3c-dlg-close:hover { background:#2a2f38; }
.wp3c-tabs { display:flex; gap:6px; padding:4px 18px 8px; flex-wrap:wrap; }
.wp3c-tab { border:1px solid #343a44; background:#1a1e24; color:#dfe3ea; border-radius:999px; padding:5px 14px;
    font-size:13px; cursor:pointer; white-space:nowrap; }
.wp3c-tab:hover { background:#232831; }
.wp3c-tab.active { background:#2c4a78; border-color:#3d6ab0; color:#fff; }
.wp3c-toolbar { display:flex; align-items:center; gap:10px; padding:0 18px 10px; }
.wp3c-search { flex:1 1 auto; background:#0d0f12; border:1px solid #343a44; border-radius:8px; color:#e9ecf1;
    padding:7px 12px; font-size:13px; outline:none; }
.wp3c-search:focus { border-color:#3d6ab0; }
.wp3c-status { font-size:12px; color:#a3abb8; white-space:nowrap; }
.wp3c-grid { flex:1 1 auto; overflow-y:auto; padding:4px 18px 18px;
    display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:14px;
    grid-auto-rows:max-content; align-content:start; }
.wp3c-item { background:#1a1e24; border:1px solid #272c34; border-radius:10px; overflow:hidden; cursor:pointer;
    min-height:300px; transition:border-color .12s, transform .12s; }
.wp3c-item:hover { border-color:#6ea8ff; transform:translateY(-2px); }
.wp3c-item.selected { border-color:#6ea8ff; box-shadow:0 0 0 2px rgba(110,168,255,.35); }
.wp3c-item-img { height:240px; background:#0d0f12; display:flex; align-items:center; justify-content:center; position:relative; }
.wp3c-item-img img { max-width:100%; max-height:100%; object-fit:contain; }
.wp3c-item-name { padding:6px 9px 2px; font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wp3c-item-desc { padding:0 9px 8px; font-size:11px; color:#a3abb8; line-height:1.5; min-height:32px;
    white-space:pre-line; word-break:break-all; }
.wp3c-item-desc .wp3c-nodesc { color:#5b6370; font-style:italic; }
.wp3c-card-imgbox.drag-over { outline:2px dashed #f0c24b; outline-offset:-2px; background:rgba(240,194,75,.10); }
.wp3c-dlg-body { flex:1 1 auto; display:flex; min-height:0; }
.wp3c-preview { width:300px; flex:0 0 300px; border-left:1px solid #272c34; background:#101317;
    padding:12px; display:flex; flex-direction:column; gap:8px; overflow-y:auto; }
.wp3c-preview-empty { margin:auto; text-align:center; color:#6c7482; font-size:12px; line-height:1.8; padding:0 8px; }
.wp3c-preview-id { font-size:14px; font-weight:700; word-break:break-all; }
.wp3c-preview-imgbox { flex:1 1 auto; min-height:120px; background:#0d0f12; border:1px solid #272c34;
    border-radius:10px; overflow-y:auto; }
.wp3c-preview-imgbox img { display:block; width:100%; height:auto; }
.wp3c-preview-desc { font-size:12px; color:#c3cad6; line-height:1.6; white-space:pre-line; word-break:break-all; }
.wp3c-preview-desc textarea { width:100%; min-height:90px; background:#0d0f12; border:1px solid #343a44;
    border-radius:8px; color:#e9ecf1; padding:8px; font-size:12px; line-height:1.6; outline:none; resize:vertical;
    font-family:inherit; }
.wp3c-preview-desc textarea:focus { border-color:#3d6ab0; }
.wp3c-preview-editbtns { display:flex; gap:6px; }
.wp3c-preview-editbtns .wp3c-btn { flex:1 1 0; padding:4px 6px; font-size:12px; }
.wp3c-preview-tip { font-size:11px; color:#6c7482; line-height:1.6; margin-top:auto; }
.wp3c-empty { grid-column:1/-1; text-align:center; color:#6c7482; font-size:13px; padding:60px 0; }
.wp3c-more { grid-column:1/-1; text-align:center; padding:10px 0 2px; }
.wp3c-more button { background:#1a1e24; border:1px solid #343a44; color:#a3abb8; border-radius:8px;
    padding:6px 18px; font-size:12px; cursor:pointer; }

/* ===== 大图查看模态（复刻原 index.html 放大查看） ===== */
.wp3c-viewer { position:fixed; inset:0; z-index:100001; background:rgba(0,0,0,.88);
    display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px;
    font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif; }
.wp3c-viewer-stage { flex:1 1 auto; width:100%; display:flex; align-items:center; justify-content:center;
    min-height:0; padding:24px 64px 0; }
.wp3c-viewer-stage img { max-width:100%; max-height:100%; object-fit:contain; }
.wp3c-viewer-nav { position:absolute; top:50%; transform:translateY(-50%); width:44px; height:64px;
    border:1px solid #343a44; background:rgba(26,30,36,.8); color:#e9ecf1; font-size:26px; cursor:pointer;
    border-radius:10px; }
.wp3c-viewer-nav:hover { background:#2a2f38; }
.wp3c-viewer-nav.l { left:10px; }
.wp3c-viewer-nav.r { right:10px; }
.wp3c-viewer-close { position:absolute; top:14px; right:16px; width:38px; height:38px; border-radius:9px;
    border:1px solid #343a44; background:rgba(26,30,36,.8); color:#e9ecf1; font-size:16px; cursor:pointer; }
.wp3c-viewer-info { flex:0 0 auto; max-width:min(900px,90vw); padding:0 16px 20px; text-align:center;
    color:#c3cad6; font-size:13px; line-height:1.7; }
.wp3c-viewer-info .wp3c-vid { font-weight:700; color:#e9ecf1; font-size:15px; word-break:break-all; }
.wp3c-viewer-info .wp3c-vdesc { white-space:pre-line; word-break:break-all; color:#a3abb8; }
.wp3c-viewer-info .wp3c-vcount { color:#6c7482; font-size:11px; }

.wp3c-toast { position:fixed; left:50%; bottom:40px; transform:translateX(-50%); z-index:100002;
    background:#2a2f38; border:1px solid #4a525f; color:#e9ecf1; padding:10px 20px; border-radius:10px;
    font-size:13px; font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif; box-shadow:0 8px 24px rgba(0,0,0,.4); }
.wp3c-toast.err { background:#3a2020; border-color:#6b3030; }

/* ===== 收藏心形按钮（缩略图右上角） ===== */
.wp3c-fav { position:absolute; top:8px; right:8px; width:32px; height:32px; border-radius:50%; padding:0;
    border:1px solid #343a44; background:rgba(13,15,18,.78); color:#8d97a5; font-size:17px; line-height:1;
    cursor:pointer; display:flex; align-items:center; justify-content:center;
    transition:color .15s, border-color .15s, background .15s, transform .1s; }
.wp3c-fav:hover { color:#ff5470; border-color:#ff5470; transform:scale(1.1); }
.wp3c-fav.on { color:#ff5470; border-color:#c73a52; background:rgba(255,84,112,.14); }
.wp3c-fav:disabled { opacity:.55; cursor:wait; transform:none; }

/* ===== 随机切换设置面板 ===== */
.wp3c-cfg-dialog { width:min(480px,92vw); max-height:min(640px,86vh); background:#14171c; border:1px solid #343a44;
    border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.5); display:flex; flex-direction:column; overflow:hidden;
    color:#e9ecf1; }
.wp3c-cfg-tip { font-size:12px; color:#a3abb8; padding:0 18px 10px; line-height:1.6; }
.wp3c-cfg-list { flex:1 1 auto; overflow-y:auto; padding:0 12px 10px; display:flex; flex-direction:column; gap:6px; }
.wp3c-cfg-row { display:flex; align-items:center; justify-content:space-between; gap:10px; background:#1a1e24;
    border:1px solid #272c34; border-radius:10px; padding:9px 12px; cursor:pointer; transition:border-color .12s; }
.wp3c-cfg-row:hover { border-color:#4a525f; }
.wp3c-cfg-label { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wp3c-cfg-foot { display:flex; gap:8px; padding:10px 14px 14px; }
.wp3c-cfg-foot .wp3c-btn { flex:1 1 0; padding:7px 10px; }
`;
    document.head.appendChild(style);
}

function toast(msg, isErr) {
    const el = document.createElement("div");
    el.className = "wp3c-toast" + (isErr ? " err" : "");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
}

function stopCanvasDrag(el) {
    // 防止在节点内点击/拖动时带动画布或节点本身
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); }, false);
}

// ---------- 节点数据处理 ----------

function getWidget(node, name) {
    return node.widgets?.find((w) => w.name === name) || null;
}

function readWidgetJSON(widget) {
    try {
        const v = (widget?.value ?? "").trim();
        return v ? JSON.parse(v) : {};
    } catch (e) {
        return {};
    }
}

function isSlotEnabled(node, slot) {
    const meta = SLOTS[slot];
    if (!meta?.toggleWidget) return true;
    const v = getWidget(node, meta.toggleWidget)?.value;
    // 旧工作流没有该 widget 时视为开启
    return v !== false && v !== "false";
}

function slotPreviewURL(node, slot, data) {
    if (slot === "face") {
        return api.apiURL("/view") + "?filename=" + encodeURIComponent(data.name || "") +
            "&subfolder=" + encodeURIComponent(data.subfolder || "") + "&type=input";
    }
    // 节点卡片加载原图（不带 preview=1，避免把 300px 缩略图当素材显示）
    return "/wp_node/three_combo/image?lib=" + SLOTS[slot].lib +
        "&file=" + encodeURIComponent(data.file || "");
}

function applySlot(node, slot, data) {
    const w = getWidget(node, SLOTS[slot].widget);
    if (w) w.value = JSON.stringify(data);
    refreshCard(node, slot);
    node.setDirtyCanvas(true, true);
    // 新版前端靠 window mouseup 捕获画布变化并保存工作流草稿；click 在 mouseup 之后触发，
    // 直接赋值 w.value 会错过捕获时机，这里补发一个合成 mouseup 让变更追踪器立即捕获新值
    window.dispatchEvent(new MouseEvent("mouseup"));
}

// ---------- 库开关：卡片状态（端口与连线不再变动，关闭的库由后端输出 None） ----------

// 加载旧工作流后自愈：旧版方案保存的 outputs 可能缺少 slot 或带 hidden=true，这里统一补齐并恢复显示
function restoreFullOutputs(node) {
    if (!Array.isArray(node.outputs)) return;
    for (let i = 0; i < FULL_OUTPUTS.length; i++) {
        const [name, type] = FULL_OUTPUTS[i];
        if (node.outputs[i]?.name === name) continue;
        node.addOutput(name, type);
        const fresh = node.outputs.pop();
        node.outputs.splice(i, 0, fresh);
    }
    for (const slot of LIB_SLOTS) {
        const out = node.outputs[SLOTS[slot].index];
        if (out?.hidden) out.hidden = false;
    }
}

function setSlotEnabled(node, slot, enabled) {
    const w = getWidget(node, SLOTS[slot].toggleWidget);
    if (w) w.value = enabled;
    const ui = node._wp3cUI?.[slot];
    if (ui) {
        ui.card.classList.toggle("wp3c-off", !enabled);
        ui.toggle.classList.toggle("wp3c-tg-on", enabled);
        ui.toggle.title = enabled ? "点击关闭该素材库（关闭后该库输出为空）" : "点击开启该素材库";
        ui.randBtn.disabled = !enabled;
        ui.libBtn.disabled = !enabled;
    }
    updateIntegratedPrompt(node);
    node.setDirtyCanvas(true, true);
    window.dispatchEvent(new MouseEvent("mouseup"));
}

function syncAllToggles(node) {
    restoreFullOutputs(node);
}

// 根据节点可用高度计算四张图片的显示区高度：总高 − 顶部提示 − 底部提示词区 − 间距 = 卡片区，
// 卡片区再减去卡片内固定部分（标题/名称/描述/按钮），结果限制在 120~500px 保证清晰且不溢出
const IMG_MIN_H = 120;
const IMG_MAX_H = 500;

function layoutCards(node) {
    const root = node._wp3cRoot;
    if (!root || !node._wp3cCards || !node._wp3cHint || !node._wp3cPrompt) return;
    const H = root.clientHeight;
    if (H < 200) return;
    const avail = H - node._wp3cHint.offsetHeight - node._wp3cPrompt.offsetHeight - 16;
    const cardEl = node._wp3cCards.firstElementChild;
    const imgbox = cardEl?.querySelector(".wp3c-card-imgbox");
    if (!cardEl || !imgbox) return;
    // 卡片实际高度 − 图片区高度 = 不随图片变化的固定部分（标题/名称/描述/按钮/边框）
    const fixedH = Math.max(0, cardEl.offsetHeight - imgbox.offsetHeight);
    let imgH = Math.round(avail - fixedH);
    imgH = Math.max(IMG_MIN_H, Math.min(IMG_MAX_H, imgH));
    const val = imgH + "px";
    if (root.style.getPropertyValue("--wp3c-img-h") !== val) {
        root.style.setProperty("--wp3c-img-h", val);
    }
}

// 心形按钮状态统一渲染（节点卡片与素材库弹窗共用）
function applyFavState(btn, fav) {
    btn.style.display = "";
    btn.className = "wp3c-fav" + (fav ? " on" : "");
    btn.textContent = fav ? "♥" : "♡";
    btn.title = fav ? "点击取消收藏" : "点击收藏";
    btn.dataset.fav = fav ? "1" : "";
}

// 异步查询当前选中素材的收藏状态并更新节点卡片上的心形（换素材/随机/弹窗收藏后自动跟随）
async function refreshCardFav(node, slot) {
    const ui = node._wp3cUI?.[slot];
    if (!ui?.favBtn) return;
    const meta = SLOTS[slot];
    const data = readWidgetJSON(getWidget(node, meta.widget));
    const seq = (ui.favSeq = (ui.favSeq || 0) + 1);
    if (!data.file) { ui.favBtn.style.display = "none"; return; }
    try {
        const res = await fetch("/wp_node/three_combo/favorite?lib=" + meta.lib +
            "&file=" + encodeURIComponent(data.file));
        const j = await res.json().catch(() => ({ success: false }));
        if (ui.favSeq !== seq) return; // 过期响应，丢弃
        if (j.success) applyFavState(ui.favBtn, !!j.fav);
        else ui.favBtn.style.display = "none";
    } catch (e) {
        if (ui.favSeq === seq) ui.favBtn.style.display = "none";
    }
}

function refreshCard(node, slot) {
    const ui = node._wp3cUI?.[slot];
    if (!ui) return;
    const data = readWidgetJSON(getWidget(node, SLOTS[slot].widget));
    const has = slot === "face" ? !!data.name : !!data.file;
    ui.empty.style.display = has ? "none" : "";
    ui.img.style.display = has ? "" : "none";
    if (has) {
        ui.img.src = slotPreviewURL(node, slot, data);
        ui.name.textContent = slot === "face" ? (data.name || "") : (data.id || data.file || "");
        ui.desc.textContent = slot === "face" ? "已上传 · 不参与随机" : (data.desc || "");
    } else {
        ui.name.textContent = "未选择";
        ui.desc.textContent = slot === "face" ? "点按钮上传 · 可直接拖入图片" : "点随机或打开素材库选择";
    }
    if (slot !== "face") refreshCardFav(node, slot);
    updateIntegratedPrompt(node);
}

function updateIntegratedPrompt(node) {
    const box = node._wp3cPromptText;
    if (!box) return;
    const seg = (slot) => {
        const d = (readWidgetJSON(getWidget(node, SLOTS[slot].widget)).desc || "").trim();
        return d ? "（" + d + "）" : "";
    };
    box.textContent = [
        PROMPT_TPL.face,
        ...(isSlotEnabled(node, "outfit") ? [PROMPT_TPL.outfit.replace("{seg}", seg("outfit"))] : []),
        ...(isSlotEnabled(node, "pose") ? [PROMPT_TPL.pose.replace("{seg}", seg("pose"))] : []),
        ...(isSlotEnabled(node, "hair") ? [PROMPT_TPL.hair.replace("{seg}", seg("hair"))] : []),
    ].join(" ");
}

// ---------- 素材库数据 ----------

async function ensureLibrary(node, slot, force) {
    const cache = node._wp3cLibs?.[slot];
    if (!force && cache && cache.items) return cache;
    const res = await fetch("/wp_node/three_combo/library?lib=" + SLOTS[slot].lib);
    const j = await res.json().catch(() => ({ success: false, error: "服务器返回异常" }));
    if (!j.success) throw new Error(j.error || "素材库读取失败");
    const lib = { items: j.items || [], categories: j.categories || [], total: j.total || 0,
        random_disabled: j.random_disabled || [] };
    (node._wp3cLibs ||= {})[slot] = lib;
    return lib;
}

async function randomSlot(node, slot) {
    if (!isSlotEnabled(node, slot)) return;
    try {
        const lib = await ensureLibrary(node, slot);
        // 随机池排除「随机设置」里被关闭的分类
        const disabled = lib.random_disabled || [];
        const pool = disabled.length ? lib.items.filter((it) => !disabled.includes(it.cat)) : lib.items;
        if (!pool.length) { toast(SLOTS[slot].libName + "里没有可随机的素材（相关分类可能已被关闭）", true); return; }
        const cur = readWidgetJSON(getWidget(node, SLOTS[slot].widget)).file;
        let pick = pool[Math.floor(Math.random() * pool.length)];
        if (pool.length > 1) {
            let guard = 0;
            while (pick.file === cur && guard++ < 20) {
                pick = pool[Math.floor(Math.random() * pool.length)];
            }
        }
        applySlot(node, slot, pick);
    } catch (e) {
        toast("随机失败：" + e.message, true);
    }
}

// 判断拖拽数据里是否带脸模可用的内容（素材库素材标记 或 本地文件）
function faceDragHasPayload(dt) {
    // 素材库拖拽进行中（由素材卡 dragstart 置位）一律放行，避开 Electron 下自定义类型 types 不可见的问题
    if (window.__wp3cDragging) return true;
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.includes("application/x-wp3c-asset") || types.includes("Files");
}

// 统一处理丢到脸模上的数据：优先素材库素材，其次本地图片文件
async function handleFaceDrop(node, dt) {
    // 优先读三图组合自己的素材标记，其次读应用级资产库标记；Electron 偶发丢失时退回内存缓存
    let raw = dt.getData("application/x-wp3c-asset");
    if (!raw) raw = dt.getData("application/x-wp-asset");
    if (!raw && window.__wp3cDragBuf) raw = window.__wp3cDragBuf;
    if (raw) {
        let d;
        try { d = JSON.parse(raw); } catch (_) { d = null; }
        if (!d) { toast("拖拽导入失败：数据无法解析", true); return; }
        // 兼容两种字段名：三图组合内部用 source，应用级资产库用 type
        const src = d.source || d.type;
        try {
            if (src === "wp_asset") {
                if (!d.assetId) throw new Error("缺少素材 ID");
                // 来自 WP 资产库：复制到 input 后选用
                const res = await fetch("/wp_node/asset_library/asset/" + encodeURIComponent(d.assetId) + "/copy_to_input", { method: "POST" });
                const j = await res.json().catch(() => ({}));
                if (!j.success || !j.file_name) throw new Error(j.error || "取用失败");
                applySlot(node, "face", { name: j.file_name, subfolder: "" });
                toast("脸模已选用：" + j.file_name);
            } else if (src === "lib_file") {
                // 来自服装/姿势/发型素材库：复制到 input 后选用
                const res = await fetch("/wp_node/three_combo/import_face", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ lib: d.lib, file: d.file }),
                });
                const j = await res.json().catch(() => ({}));
                if (!j.success || !j.name) throw new Error(j.error || "导入失败");
                applySlot(node, "face", { name: j.name, subfolder: "" });
                toast("已导入为脸模：" + j.name);
            } else {
                toast("拖拽导入失败：不支持的素材来源「" + src + "」", true);
            }
        } catch (e2) {
            toast("拖拽导入失败：" + e2.message, true);
        }
        return;
    }
    // Windows 本地图片文件拖入：走与「上传」按钮相同的上传流程
    const files = Array.from(dt.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
        await uploadFaceImage(node, files[0]);
    } else if (dt.files?.length) {
        toast("只能拖入图片文件", true);
    } else {
        toast("拖拽导入失败：拖拽数据为空", true);
    }
}

// ========== 全局文件拖放协调（window 捕获阶段） ==========
// ComfyUI 新版前端把自定义 DOM 部件用绝对定位层覆盖在画布上，节点包裹结构复杂，
// 普通冒泡式 dragover/drop 事件可能到不了脸模卡片，导致拖拽毫无反应。
// 这里改为在 window「捕获阶段」监听拖放，并依据坐标判断是否命中某个脸模卡片区域，
// 从最外层兜底处理 Windows 文件拖入和素材库拖入，稳定且不影响其它节点。
let _faceDropTargets = [];      // 每个脸模卡片一个目标：{card, imgbox, node}
let _faceDropActive = null;     // 当前正在拖拽悬停的目标
let _globalFaceDnDReady = false;

function _faceDropHit(x, y) {
    for (const t of _faceDropTargets) {
        if (!t.card.isConnected) continue;
        const r = t.card.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return t;
    }
    return null;
}

// Electron 下同页自定义拖拽偶发 clientX/Y 为 0，坐标命中会失败，这里退而用事件目标定位卡片
function _faceDropTargetByEvent(e) {
    const el = e.target;
    if (!el || !(el instanceof Element)) return null;
    for (const t of _faceDropTargets) {
        if (t.card === el || t.card.contains(el)) return t;
    }
    return null;
}

function _installGlobalFaceDnD() {
    if (_globalFaceDnDReady) return;
    _globalFaceDnDReady = true;

    // 拖放不预先按 types 过滤：自定义类型（资产库素材）在 dragover 阶段可能不出现在 types 里，
    // 只要坐标落在脸模卡片上就放行并高亮，落到后代 drop 时再精确解析数据
    window.addEventListener("dragover", (e) => {
        // 优先按坐标命中；坐标异常时用事件目标回退定位
        let t = _faceDropHit(e.clientX, e.clientY);
        if (!t) t = _faceDropTargetByEvent(e);
        if (_faceDropActive && _faceDropActive !== t) {
            _faceDropActive.imgbox.classList.remove("drag-over");
            _faceDropActive = null;
        }
        if (!t) return;
        // 必须 preventDefault，浏览器才允许在此处放下文件
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
        _faceDropActive = t;
        t.imgbox.classList.add("drag-over");
    }, true);

    window.addEventListener("drop", (e) => {
        const t = _faceDropHit(e.clientX, e.clientY) || _faceDropTargetByEvent(e) || _faceDropActive;
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        t.imgbox.classList.remove("drag-over");
        _faceDropActive = null;
        handleFaceDrop(t.node, e.dataTransfer);
    }, true);

    // 拖拽整体结束（含取消）时兜底清理高亮
    window.addEventListener("dragend", () => {
        if (_faceDropActive) {
            _faceDropActive.imgbox.classList.remove("drag-over");
            _faceDropActive = null;
        }
    }, true);
}

function _registerFaceDropTarget(node, card, imgbox) {
    _installGlobalFaceDnD();
    _faceDropTargets.push({ card, imgbox, node });
}

function _unregisterFaceDropTarget(node) {
    _faceDropTargets = _faceDropTargets.filter((t) => t.node !== node);
}

// 脸模本地上传（参考「加载图像」节点流程：系统文件选择框 → /upload/image → 更新节点显示）
async function uploadFaceImage(node, file) {
    try {
        const body = new FormData();
        body.append("image", file);
        let res = await fetch(api.apiURL("/upload/image"), { method: "POST", body });
        if (res.status === 409) {
            // 与「加载图像」节点一致：同名文件已存在时先询问是否覆盖
            if (!confirm("【WP 三图组合】同名文件已存在：" + file.name + "\n是否覆盖上传？")) return;
            const body2 = new FormData();
            body2.append("image", file);
            body2.append("overwrite", "true");
            res = await fetch(api.apiURL("/upload/image"), { method: "POST", body: body2 });
        }
        if (!res.ok) {
            toast("上传失败：" + (await res.text()), true);
            return;
        }
        const j = await res.json().catch(() => ({}));
        if (!j.name) {
            toast("上传失败：服务器未返回文件名", true);
            return;
        }
        applySlot(node, "face", { name: j.name, subfolder: j.subfolder || "" });
        toast("脸模已上传：" + j.name);
    } catch (e) {
        toast("上传失败：" + e.message, true);
    }
}

// ---------- 通用弹窗骨架 ----------

function buildDialog() {
    const overlay = document.createElement("div");
    overlay.className = "wp3c-overlay";
    const dlg = document.createElement("div");
    dlg.className = "wp3c-dialog";
    overlay.appendChild(dlg);

    const close = () => overlay.remove();
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    const esc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc);

    const head = document.createElement("div");
    head.className = "wp3c-dlg-head";
    const title = document.createElement("div");
    title.className = "wp3c-dlg-title";
    const sub = document.createElement("div");
    sub.className = "wp3c-dlg-sub";
    const closeBtn = document.createElement("button");
    closeBtn.className = "wp3c-dlg-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", close);
    head.append(title, sub, closeBtn);

    const tabs = document.createElement("div");
    tabs.className = "wp3c-tabs";
    const toolbar = document.createElement("div");
    toolbar.className = "wp3c-toolbar";

    dlg.append(head, tabs, toolbar);
    document.body.appendChild(overlay);
    return { overlay, dlg, title, sub, tabs, toolbar, close };
}

const BATCH = 120; // 网格分批渲染，一次 120 张，滚动到底自动追加

// 直接加载图片（素材均为本地小图，分批渲染本身已控制单批数量，无需懒加载）
function lazyImg(imgEl, url) {
    imgEl.src = url;
    return imgEl;
}

// ---------- 大图查看模态（复刻原 index.html 的放大查看：左右键/Esc 切换） ----------

function openViewer(meta, items, startIndex) {
    const ov = document.createElement("div");
    ov.className = "wp3c-viewer";
    const stage = document.createElement("div");
    stage.className = "wp3c-viewer-stage";
    const img = document.createElement("img");
    const navL = document.createElement("button");
    navL.className = "wp3c-viewer-nav l";
    navL.textContent = "‹";
    navL.title = "上一张（←）";
    const navR = document.createElement("button");
    navR.className = "wp3c-viewer-nav r";
    navR.textContent = "›";
    navR.title = "下一张（→）";
    const closeBtn = document.createElement("button");
    closeBtn.className = "wp3c-viewer-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭（Esc）";
    const info = document.createElement("div");
    info.className = "wp3c-viewer-info";
    stage.append(img);
    ov.append(stage, navL, navR, closeBtn, info);
    document.body.appendChild(ov);

    let idx = startIndex;
    const show = () => {
        const it = items[idx];
        if (!it) return;
        img.src = "/wp_node/three_combo/image?lib=" + meta.lib + "&file=" + encodeURIComponent(it.file);
        info.innerHTML = "";
        const idEl = document.createElement("div");
        idEl.className = "wp3c-vid";
        idEl.textContent = it.id || it.file;
        const descEl = document.createElement("div");
        descEl.className = "wp3c-vdesc";
        descEl.textContent = it.desc || "（暂无描述）";
        const cntEl = document.createElement("div");
        cntEl.className = "wp3c-vcount";
        cntEl.textContent = (idx + 1) + " / " + items.length + "　← → 切换 · Esc 关闭";
        info.append(idEl, descEl, cntEl);
    };
    const step = (d) => { idx = (idx + d + items.length) % items.length; show(); };
    const close = () => {
        document.removeEventListener("keydown", onKey);
        ov.remove();
    };
    const onKey = (e) => {
        if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "ArrowRight") step(1);
        else if (e.key === "Escape") close();
    };
    navL.addEventListener("click", () => step(-1));
    navR.addEventListener("click", () => step(1));
    closeBtn.addEventListener("click", close);
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });
    document.addEventListener("keydown", onKey);
    show();
}

// ---------- 随机切换设置面板（按分类开关控制随机池） ----------

// 从节点卡片打开随机设置：库数据未加载时先取一次再打开面板
async function openRandomConfigForNode(node, slot) {
    try {
        const lib = await ensureLibrary(node, slot);
        openRandomConfigDialog(lib, SLOTS[slot]);
    } catch (e) {
        toast("读取" + SLOTS[slot].libName + "失败：" + e.message, true);
    }
}

function openRandomConfigDialog(lib, meta) {
    const overlay = document.createElement("div");
    overlay.className = "wp3c-overlay";
    overlay.style.zIndex = "100000";
    const dlg = document.createElement("div");
    dlg.className = "wp3c-cfg-dialog";
    overlay.appendChild(dlg);

    const close = () => { overlay.remove(); document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", esc);

    const head = document.createElement("div");
    head.className = "wp3c-dlg-head";
    head.style.paddingBottom = "4px";
    const title = document.createElement("div");
    title.className = "wp3c-dlg-title";
    title.textContent = "⚙ " + meta.libName + " · 随机切换设置";
    const closeBtn = document.createElement("button");
    closeBtn.className = "wp3c-dlg-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭（Esc）";
    closeBtn.addEventListener("click", close);
    head.append(title, closeBtn);

    const tip = document.createElement("div");
    tip.className = "wp3c-cfg-tip";
    tip.textContent = "关闭某个文件夹后，「随机」不再抽到该文件夹的素材；浏览和搜索不受影响。";

    const list = document.createElement("div");
    list.className = "wp3c-cfg-list";

    const foot = document.createElement("div");
    foot.className = "wp3c-cfg-foot";
    const allOn = document.createElement("button");
    allOn.className = "wp3c-btn";
    allOn.type = "button";
    allOn.textContent = "全部开启";
    allOn.addEventListener("click", () => apply([]));
    const done = document.createElement("button");
    done.className = "wp3c-btn primary";
    done.type = "button";
    done.textContent = "完成";
    done.addEventListener("click", close);
    foot.append(allOn, done);

    dlg.append(head, tip, list, foot);
    document.body.appendChild(overlay);

    const isOff = (cat) => (lib.random_disabled || []).includes(cat);
    const render = () => {
        for (const [cat, tg] of toggles) {
            const on = !isOff(cat);
            tg.classList.toggle("wp3c-tg-on", on);
            tg.title = on ? "点击关闭（该分类不参与随机）" : "点击开启（该分类参与随机）";
        }
    };

    let saving = false;
    const save = async (nd) => {
        if (saving) return;
        saving = true;
        try {
            const res = await fetch("/wp_node/three_combo/random_config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lib: meta.lib, disabled: nd }),
            });
            const j = await res.json().catch(() => ({}));
            if (!j.success) throw new Error(j.error || "保存失败");
            toast("随机设置已保存");
        } catch (e) {
            toast("保存失败：" + e.message, true);
        } finally {
            saving = false;
        }
    };
    // 先更新本地缓存再保存：节点上点「随机」立即按新开关生效，无需重新打开弹窗
    const apply = (nd) => {
        lib.random_disabled = nd;
        render();
        save(nd);
    };

    const toggles = new Map();
    for (const c of lib.categories || []) {
        const row = document.createElement("div");
        row.className = "wp3c-cfg-row";
        const label = document.createElement("div");
        label.className = "wp3c-cfg-label";
        label.textContent = c.name + " · " + c.count + " 张";
        label.title = c.name;
        const tg = document.createElement("button");
        tg.className = "wp3c-tg";
        tg.type = "button";
        toggles.set(c.name, tg);
        row.append(label, tg);
        row.addEventListener("click", () => {
            const nd = (lib.random_disabled || []).filter((x) => x !== c.name);
            if (!isOff(c.name)) nd.push(c.name);  // 当前开启 → 点击关闭
            apply(nd);
        });
        list.appendChild(row);
    }
    render();
}

// ---------- 服装/姿势/发型素材库弹窗 ----------

async function openLibDialog(node, slot) {
    const meta = SLOTS[slot];
    const ui = buildDialog();
    ui.title.textContent = "🗂 " + meta.libName + " · 选择素材";
    ui.sub.textContent = "点击卡片选用 · 双击放大查看 · 悬停右侧可编辑描述";

    // 工具栏：搜索框 + 状态
    const search = document.createElement("input");
    search.className = "wp3c-search";
    search.placeholder = "搜索编号或描述关键词…";
    const status = document.createElement("div");
    status.className = "wp3c-status";
    status.textContent = "读取中…";
    ui.toolbar.append(search, status);

    // 左侧素材网格 + 右侧悬停预览面板
    const body = document.createElement("div");
    body.className = "wp3c-dlg-body";
    const grid = document.createElement("div");
    grid.className = "wp3c-grid";
    const preview = document.createElement("div");
    preview.className = "wp3c-preview";
    body.append(grid, preview);
    ui.dlg.appendChild(body);

    // ---- 右侧预览面板：常驻结构，悬停更新内容，支持编辑描述并持久化 ----
    const pvId = document.createElement("div");
    pvId.className = "wp3c-preview-id";
    const pvImgbox = document.createElement("div");
    pvImgbox.className = "wp3c-preview-imgbox";
    const pvDesc = document.createElement("div");
    pvDesc.className = "wp3c-preview-desc";
    const pvBtns = document.createElement("div");
    pvBtns.className = "wp3c-preview-editbtns";
    const pvEdit = document.createElement("button");
    pvEdit.className = "wp3c-btn";
    pvEdit.type = "button";
    pvEdit.textContent = "✎ 编辑描述";
    pvEdit.disabled = true;
    pvBtns.append(pvEdit);
    const pvTip = document.createElement("div");
    pvTip.className = "wp3c-preview-tip";
    pvTip.innerHTML = "点击卡片选用 · 双击放大查看<br>描述保存后立即生效并写入素材库";
    const pvEmpty = document.createElement("div");
    pvEmpty.className = "wp3c-preview-empty";
    pvEmpty.innerHTML = "鼠标悬停左侧素材<br>这里会放大显示对应图像和提示词";
    const showPvEmpty = () => {
        pvId.style.display = pvImgbox.style.display = pvDesc.style.display = pvBtns.style.display = "none";
        pvEmpty.style.display = "";
    };
    const showPvContent = () => {
        pvEmpty.style.display = "none";
        pvId.style.display = pvImgbox.style.display = pvDesc.style.display = pvBtns.style.display = "";
    };
    preview.append(pvEmpty, pvId, pvImgbox, pvDesc, pvBtns, pvTip);
    showPvEmpty();

    let curItem = null;       // 当前悬停的素材
    let editing = false;      // 是否处于描述编辑态
    let editTa = null;        // 描述编辑输入框

    const setPreview = (item) => {
        curItem = item;
        if (editing) {
            editing = false;
            editTa = null;
            cancelBtn.remove();
        }
        pvEdit.textContent = "✎ 编辑描述";
        pvEdit.disabled = !item;
        if (!item) { showPvEmpty(); return; }
        showPvContent();
        pvId.textContent = item.id || item.file;
        pvImgbox.innerHTML = "";
        const img = document.createElement("img");
        img.src = "/wp_node/three_combo/image?lib=" + meta.lib + "&file=" + encodeURIComponent(item.file) + "&preview=1";
        pvImgbox.appendChild(img);
        pvDesc.textContent = item.desc || "（暂无描述）";
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "wp3c-btn";
    cancelBtn.type = "button";
    cancelBtn.textContent = "✕ 取消";
    cancelBtn.addEventListener("click", () => setPreview(curItem));

    // 同一个按钮两种状态：未编辑时点击进入编辑，编辑中点击保存
    pvEdit.addEventListener("click", async () => {
        if (!curItem) return;
        if (!editing) {
            editing = true;
            pvDesc.innerHTML = "";
            editTa = document.createElement("textarea");
            editTa.value = curItem.desc || "";
            pvDesc.appendChild(editTa);
            pvEdit.textContent = "💾 保存";
            pvBtns.appendChild(cancelBtn);
            editTa.focus();
            return;
        }
        const desc = (editTa?.value || "").trim();
        pvEdit.disabled = true;
        try {
            const res = await fetch("/wp_node/three_combo/describe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lib: meta.lib, file: curItem.file, desc }),
            });
            const j = await res.json().catch(() => ({}));
            if (!j.success) throw new Error(j.error || "保存失败");
            curItem.desc = desc;
            // 同步更新网格卡片上的描述（保持滚动位置，不整页重建）
            for (const el of grid.querySelectorAll(".wp3c-item")) {
                if (el.dataset.file === curItem.file) {
                    const d = el.querySelector(".wp3c-item-desc");
                    if (d) {
                        d.innerHTML = "";
                        if (desc) {
                            d.textContent = desc;
                        } else {
                            const s = document.createElement("span");
                            s.className = "wp3c-nodesc";
                            s.textContent = "暂无描述 · 弹窗内可编辑";
                            d.appendChild(s);
                        }
                    }
                }
            }
            // 若该素材正是节点当前选中的，同步 widget 与界面提示词
            const sel = readWidgetJSON(getWidget(node, meta.widget));
            if (sel.file === curItem.file) applySlot(node, slot, { ...sel, desc });
            setPreview(curItem);
            toast("描述已保存");
        } catch (e) {
            toast("保存失败：" + e.message, true);
        } finally {
            pvEdit.disabled = false;
        }
    });

    // ---- 网格分批渲染 ----
    const state = { items: [], rendered: 0, moreBtn: null };
    const renderBatch = () => {
        const frag = document.createDocumentFragment();
        const end = Math.min(state.rendered + BATCH, state.items.length);
        for (let i = state.rendered; i < end; i++) frag.appendChild(state.items[i]);
        state.rendered = end;
        grid.appendChild(frag);
        if (state.rendered < state.items.length && !state.moreBtn) {
            const moreBox = document.createElement("div");
            moreBox.className = "wp3c-more";
            const btn = document.createElement("button");
            btn.textContent = "加载更多（" + (state.items.length - state.rendered) + "）";
            btn.addEventListener("click", () => { moreBox.remove(); state.moreBtn = null; renderBatch(); });
            moreBox.appendChild(btn);
            grid.appendChild(moreBox);
            state.moreBtn = moreBox;
        }
    };
    grid.addEventListener("scroll", () => {
        if (state.moreBtn && grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 300) {
            state.moreBtn.click();
        }
    });
    const resetGrid = (nodes, emptyText) => {
        grid.innerHTML = "";
        state.items = nodes;
        state.rendered = 0;
        state.moreBtn = null;
        if (!nodes.length && emptyText) {
            const empty = document.createElement("div");
            empty.className = "wp3c-empty";
            empty.textContent = emptyText;
            grid.appendChild(empty);
            return;
        }
        renderBatch();
        grid.scrollTop = 0;
    };

    let lib = null;
    let curCat = "";
    let curKeyword = "";
    let viewItems = []; // 当前过滤结果（大图模态按它切换）
    const currentFile = () => readWidgetJSON(getWidget(node, meta.widget)).file;

    const cardFor = (item, viewIndex) => {
        const card = document.createElement("div");
        card.className = "wp3c-item" + (item.file === currentFile() ? " selected" : "");
        card.dataset.file = item.file;
        const box = document.createElement("div");
        box.className = "wp3c-item-img";
        const img = lazyImg(document.createElement("img"),
            "/wp_node/three_combo/image?lib=" + meta.lib +
            "&file=" + encodeURIComponent(item.file) + "&preview=1");
        box.appendChild(img);
        // 右上角心形收藏按钮：红心=已收藏（副本在收藏文件夹），灰心=未收藏
        const favBtn = document.createElement("button");
        favBtn.type = "button";
        applyFavState(favBtn, !!item.fav);
        box.appendChild(favBtn);
        favBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (favBtn.disabled) return;
            const want = !item.fav;
            favBtn.disabled = true;
            try {
                const res = await fetch("/wp_node/three_combo/favorite", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ lib: meta.lib, file: item.file, fav: want }),
                });
                const j = await res.json().catch(() => ({}));
                if (!j.success) throw new Error(j.error || "操作失败");
                item.fav = want;
                applyFavState(favBtn, want);
                toast(want ? "已收藏：" + (item.id || item.file) : "已取消收藏：" + (item.id || item.file));
                refreshCardFav(node, slot); // 若收藏/取消的正是节点当前选中素材，同步节点卡片心形
            } catch (err) {
                toast("收藏操作失败：" + err.message, true);
            } finally {
                favBtn.disabled = false;
            }
        });
        favBtn.addEventListener("dblclick", (e) => e.stopPropagation());
        const name = document.createElement("div");
        name.className = "wp3c-item-name";
        name.textContent = item.id || item.file;
        name.title = item.id || item.file;
        const desc = document.createElement("div");
        desc.className = "wp3c-item-desc";
        if (item.desc) {
            desc.textContent = item.desc;
        } else {
            const s = document.createElement("span");
            s.className = "wp3c-nodesc";
            s.textContent = "暂无描述 · 弹窗内可编辑";
            desc.appendChild(s);
        }
        desc.title = item.desc || "";
        card.append(box, name, desc);
        card.addEventListener("click", () => {
            applySlot(node, slot, item);
            ui.close();
        });
        // 双击放大查看原图（复刻原 index.html 的放大浏览）
        card.addEventListener("dblclick", () => openViewer(meta, viewItems, viewIndex));
        // 悬停预览 + 可拖拽到节点的「1 · 脸模」区域
        card.addEventListener("mouseenter", () => setPreview(item));
        card.draggable = true;
        card.addEventListener("dragstart", (e) => {
            const buf = JSON.stringify({ source: "lib_file", lib: meta.lib, file: item.file });
            e.dataTransfer.setData("application/x-wp3c-asset", buf);
            window.__wp3cDragBuf = buf;
            window.__wp3cDragging = true;
            e.dataTransfer.effectAllowed = "copy";
            // 拖拽期间让遮罩不挡鼠标事件并变淡，便于看到下面的节点
            ui.overlay.style.pointerEvents = "none";
            ui.overlay.style.background = "rgba(0,0,0,.25)";
        });
        card.addEventListener("dragend", () => {
            window.__wp3cDragging = false;
            window.__wp3cDragBuf = null;
            ui.overlay.style.pointerEvents = "";
            ui.overlay.style.background = "";
        });
        return card;
    };

    const refresh = () => {
        if (!lib) return;
        const kw = curKeyword.toLowerCase();
        viewItems = lib.items.filter((it) =>
            (!curCat || it.cat === curCat) &&
            (!kw || (it.id || "").toLowerCase().includes(kw) || (it.desc || "").toLowerCase().includes(kw))
        );
        status.textContent = viewItems.length + " 个素材" + (curCat ? " · " + curCat : "");
        resetGrid(viewItems.map((it, i) => cardFor(it, i)), "没有匹配的素材，换个关键词或分类试试");
    };

    const renderTabs = () => {
        ui.tabs.innerHTML = "";
        const mk = (label, val) => {
            const t = document.createElement("button");
            t.className = "wp3c-tab" + (curCat === val ? " active" : "");
            t.textContent = label;
            t.addEventListener("click", () => { curCat = val; renderTabs(); refresh(); });
            ui.tabs.appendChild(t);
        };
        mk("全部 · " + lib.total, "");
        for (const c of lib.categories) mk(c.name + " · " + c.count, c.name);
    };

    let debounce = null;
    search.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { curKeyword = search.value.trim(); refresh(); }, 200);
    });

    try {
        // 弹窗每次打开都强制刷新：收藏状态、分类开关、描述始终显示服务器最新数据
        lib = await ensureLibrary(node, slot, true);
        ui.sub.textContent = meta.libName + " · " + lib.total + " 张素材";
        renderTabs();
        refresh();
    } catch (e) {
        status.textContent = "";
        resetGrid([], "读取失败：" + e.message);
    }
    search.focus();
}

// ---------- 脸模弹窗 ----------

async function openFaceDialog(node) {
    const ui = buildDialog();
    ui.title.textContent = "🟡 WP 资产库 · 选择脸模";
    ui.sub.textContent = "选择项目与分类，点击图片取用为脸模";
    ui.tabs.innerHTML = "";
    ui.toolbar.innerHTML = "";

    // 工具栏：项目下拉 + 状态
    const bar = document.createElement("div");
    bar.className = "wp3c-toolbar";
    bar.style.padding = "0 18px 10px";
    const projSel = document.createElement("select");
    projSel.className = "wp3c-search";
    projSel.style.maxWidth = "260px";
    const libStatus = document.createElement("div");
    libStatus.className = "wp3c-status";
    libStatus.textContent = "";
    bar.append(projSel, libStatus);

    const catTabs = document.createElement("div");
    catTabs.className = "wp3c-tabs";
    catTabs.style.padding = "0 18px 8px";
    ui.dlg.append(bar, catTabs);
    const gridState = makeFaceGrid(ui.dlg);

    let projectsLoaded = false;
    const loadProjects = async () => {
        if (projectsLoaded) return;
        try {
            libStatus.textContent = "读取项目…";
            const res = await fetch("/wp_node/asset_library/projects");
            const projects = await res.json().catch(() => null);
            if (!Array.isArray(projects)) throw new Error("资产库返回异常");
            projSel.innerHTML = "";
            if (!projects.length) {
                libStatus.textContent = "资产库还没有项目，请先在资产库面板中创建";
                return;
            }
            for (const p of projects) {
                const opt = document.createElement("option");
                opt.value = p.id;
                opt.textContent = p.name || p.id;
                projSel.appendChild(opt);
            }
            projectsLoaded = true;
            libStatus.textContent = "";
            loadCategories();
        } catch (e) {
            libStatus.textContent = "读取失败：" + e.message;
        }
    };

    const loadCategories = async () => {
        try {
            catTabs.innerHTML = "";
            libStatus.textContent = "读取分类…";
            const res = await fetch("/wp_node/asset_library/categories?project_id=" + encodeURIComponent(projSel.value));
            const cats = await res.json().catch(() => null);
            if (!Array.isArray(cats)) throw new Error("分类读取失败");
            if (!cats.length) {
                libStatus.textContent = "该项目下没有分类";
                gridState.reset([]);
                return;
            }
            for (const c of cats) {
                const t = document.createElement("button");
                t.className = "wp3c-tab";
                t.textContent = c.name || c.id;
                t.addEventListener("click", () => {
                    catTabs.querySelectorAll(".wp3c-tab").forEach((x) => x.className = "wp3c-tab");
                    t.className = "wp3c-tab active";
                    loadAssets(c.id);
                });
                catTabs.appendChild(t);
            }
            libStatus.textContent = "";
            catTabs.querySelector(".wp3c-tab")?.click();
        } catch (e) {
            libStatus.textContent = "读取失败：" + e.message;
        }
    };
    projSel.addEventListener("change", loadCategories);

    const loadAssets = async (catId) => {
        try {
            libStatus.textContent = "读取素材…";
            const res = await fetch("/wp_node/asset_library/assets/" + encodeURIComponent(catId) +
                "?project_id=" + encodeURIComponent(projSel.value));
            const assets = await res.json().catch(() => null);
            if (!Array.isArray(assets)) throw new Error("素材读取失败");
            const images = assets.filter((a) => (a.file_type || "image") === "image");
            libStatus.textContent = images.length + " 张图片";
            const cards = images.map((a) => {
                const card = document.createElement("div");
                card.className = "wp3c-item";
                const box = document.createElement("div");
                box.className = "wp3c-item-img";
                const img = lazyImg(document.createElement("img"),
                    "/wp_node/asset_library/thumbnail/" + encodeURIComponent(a.id));
                box.appendChild(img);
                const name = document.createElement("div");
                name.className = "wp3c-item-name";
                name.textContent = a.name || a.file_name || "";
                name.title = name.textContent;
                const desc = document.createElement("div");
                desc.className = "wp3c-item-desc";
                desc.textContent = a.description || "";
                card.append(box, name, desc);
                card.addEventListener("click", () => useAsset(a, card));
                // 悬停预览 + 可拖拽到节点的「1 · 脸模」区域
                card.addEventListener("mouseenter", () => {
                    setFacePreview(gridState.preview, {
                        src: img.src,
                        id: a.name || a.file_name || "",
                        desc: a.description || "",
                        tip: "点击取用 · 也可直接拖到节点的「1 · 脸模」区域",
                    });
                });
                card.draggable = true;
                card.addEventListener("dragstart", (e) => {
                    const buf = JSON.stringify({ source: "wp_asset", assetId: a.id });
                    e.dataTransfer.setData("application/x-wp3c-asset", buf);
                    window.__wp3cDragBuf = buf;
                    window.__wp3cDragging = true;
                    e.dataTransfer.effectAllowed = "copy";
                    // 拖拽期间让遮罩不挡鼠标事件并变淡，便于看到下面的节点
                    ui.overlay.style.pointerEvents = "none";
                    ui.overlay.style.background = "rgba(0,0,0,.25)";
                });
                card.addEventListener("dragend", () => {
                    window.__wp3cDragging = false;
                    window.__wp3cDragBuf = null;
                    ui.overlay.style.pointerEvents = "";
                    ui.overlay.style.background = "";
                });
                return card;
            });
            gridState.reset(cards, "这个分类里没有图片素材");
        } catch (e) {
            libStatus.textContent = "读取失败：" + e.message;
        }
    };

    let busy = false;
    const useAsset = async (a, card) => {
        if (busy) return;
        busy = true;
        libStatus.textContent = "正在取用「" + (a.name || a.file_name) + "」…";
        try {
            const res = await fetch("/wp_node/asset_library/asset/" + encodeURIComponent(a.id) + "/copy_to_input",
                { method: "POST" });
            const j = await res.json().catch(() => ({}));
            if (!j.success || !j.file_name) throw new Error(j.error || "取用失败");
            applySlot(node, "face", { name: j.file_name, subfolder: "" });
            toast("脸模已选用：" + j.file_name);
            ui.close();
        } catch (e) {
            libStatus.textContent = "取用失败：" + e.message;
            toast("取用失败：" + e.message, true);
        } finally {
            busy = false;
        }
    };

    loadProjects();
}

// 脸模弹窗的网格 + 右侧悬停预览（与素材库弹窗同款结构）
function setFacePreview(preview, data) {
    preview.innerHTML = "";
    if (!data) {
        const empty = document.createElement("div");
        empty.className = "wp3c-preview-empty";
        empty.innerHTML = "鼠标悬停左侧素材<br>这里会放大显示对应图像和提示词";
        preview.appendChild(empty);
        return;
    }
    const id = document.createElement("div");
    id.className = "wp3c-preview-id";
    id.textContent = data.id || "";
    const imgbox = document.createElement("div");
    imgbox.className = "wp3c-preview-imgbox";
    const img = document.createElement("img");
    img.src = data.src || "";
    imgbox.appendChild(img);
    const desc = document.createElement("div");
    desc.className = "wp3c-preview-desc";
    desc.textContent = data.desc || "";
    const tip = document.createElement("div");
    tip.className = "wp3c-preview-tip";
    tip.textContent = data.tip || "";
    preview.append(id, imgbox, desc, tip);
}

function makeFaceGrid(dlg) {
    const body = document.createElement("div");
    body.className = "wp3c-dlg-body";
    const grid = document.createElement("div");
    grid.className = "wp3c-grid";
    const preview = document.createElement("div");
    preview.className = "wp3c-preview";
    setFacePreview(preview, null);
    body.append(grid, preview);
    dlg.appendChild(body);

    const state = { items: [], rendered: 0, observer: null, preview };

    const renderBatch = () => {
        const frag = document.createDocumentFragment();
        const end = Math.min(state.rendered + BATCH, state.items.length);
        for (let i = state.rendered; i < end; i++) frag.appendChild(state.items[i]);
        state.rendered = end;
        grid.appendChild(frag);
        if (state.rendered < state.items.length && !state.moreBtn) {
            const moreBox = document.createElement("div");
            moreBox.className = "wp3c-more";
            const btn = document.createElement("button");
            btn.textContent = "加载更多（" + (state.items.length - state.rendered) + "）";
            btn.addEventListener("click", () => { moreBox.remove(); state.moreBtn = null; renderBatch(); });
            moreBox.appendChild(btn);
            grid.appendChild(moreBox);
            state.moreBtn = moreBox;
        }
    };

    grid.addEventListener("scroll", () => {
        if (state.moreBtn && grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 300) {
            state.moreBtn.click();
        }
    });

    state.reset = (nodes, emptyText) => {
        grid.innerHTML = "";
        state.items = nodes;
        state.rendered = 0;
        state.moreBtn = null;
        if (!nodes.length && emptyText) {
            const empty = document.createElement("div");
            empty.className = "wp3c-empty";
            empty.textContent = emptyText;
            grid.appendChild(empty);
            return;
        }
        renderBatch();
        grid.scrollTop = 0;
    };
    return state;
}

// ---------- 节点界面 ----------

function buildNodeUI(node) {
    ensureStyle();

    // 隐藏七个数据/开关 widget（值仍会随工作流保存，界面用自定义控件展示）
    for (const key of ["脸模文件", "服装选择", "姿势选择", "发型选择", "服装库开关", "姿势库开关", "发型库开关"]) {
        const w = getWidget(node, key);
        if (w) { w.hidden = true; w.computeSize = () => [0, 0]; }
    }

    const root = document.createElement("div");
    root.className = "wp3c-root";
    node._wp3cRoot = root;

    // 顶部：说明 + 随机组合按钮
    const hint = document.createElement("div");
    hint.className = "wp3c-hint";
    const hintText = document.createElement("div");
    hintText.className = "wp3c-hint-text";
    hintText.textContent = "1 脸模 → 2 服装 → 3 姿势 → 4 发型 · 开关可临时关闭某个库 · 上传的脸模不参与随机";
    const randAll = document.createElement("button");
    randAll.className = "wp3c-btn primary";
    randAll.type = "button";
    randAll.textContent = "🎲 随机组合（服装+姿势+发型）";
    randAll.title = "同时随机更换开启中的素材库素材";
    randAll.addEventListener("click", () => {
        for (const slot of LIB_SLOTS) if (isSlotEnabled(node, slot)) randomSlot(node, slot);
    });
    stopCanvasDrag(randAll);
    hint.append(hintText, randAll);

    // 四张卡片
    const cards = document.createElement("div");
    cards.className = "wp3c-cards";
    node._wp3cCards = cards;
    node._wp3cHint = hint;
    node._wp3cUI = {};

    // 脸模上传用的隐藏文件选择框（点「上传」直接弹出，参考「加载图像」节点）
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        if (f) uploadFaceImage(node, f);
        fileInput.value = "";
    });
    root.appendChild(fileInput);

    for (const slot of ["face", "outfit", "pose", "hair"]) {
        const meta = SLOTS[slot];
        const card = document.createElement("div");
        card.className = "wp3c-card";

        const head = document.createElement("div");
        head.className = "wp3c-card-head";
        head.style.background = meta.color;
        const headTitle = document.createElement("span");
        headTitle.className = "wp3c-card-title";
        headTitle.textContent = meta.title;
        head.appendChild(headTitle);

        // 库开关（服装/姿势/发型卡片）：关闭后端口隐藏、按钮失效、不输出
        let toggle = null;
        if (slot !== "face") {
            toggle = document.createElement("button");
            toggle.className = "wp3c-tg wp3c-tg-on";
            toggle.type = "button";
            stopCanvasDrag(toggle);
            toggle.addEventListener("click", () => {
                setSlotEnabled(node, slot, !isSlotEnabled(node, slot));
            });
            head.appendChild(toggle);
        }

        const imgbox = document.createElement("div");
        imgbox.className = "wp3c-card-imgbox";
        const img = document.createElement("img");
        img.style.display = "none";
        const empty = document.createElement("div");
        empty.className = "wp3c-card-empty";
        imgbox.append(img, empty);

        // 收藏心形（仅素材库卡片：脸模为上传图，不属于素材库，不适用）
        let favBtn = null;
        if (slot !== "face") {
            favBtn = document.createElement("button");
            favBtn.className = "wp3c-fav";
            favBtn.type = "button";
            favBtn.style.display = "none";
            favBtn.title = "收藏状态";
            imgbox.appendChild(favBtn);
            stopCanvasDrag(favBtn);
            favBtn.addEventListener("click", async () => {
                if (favBtn.disabled) return;
                const data = readWidgetJSON(getWidget(node, meta.widget));
                if (!data.file) return;
                const want = favBtn.dataset.fav !== "1";
                favBtn.disabled = true;
                try {
                    const res = await fetch("/wp_node/three_combo/favorite", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ lib: meta.lib, file: data.file, fav: want }),
                    });
                    const j = await res.json().catch(() => ({}));
                    if (!j.success) throw new Error(j.error || "操作失败");
                    applyFavState(favBtn, want);
                    toast(want ? "已收藏：" + (data.id || data.file) : "已取消收藏：" + (data.id || data.file));
                } catch (e) {
                    toast("收藏操作失败：" + e.message, true);
                } finally {
                    favBtn.disabled = false;
                }
            });
        }

        const name = document.createElement("div");
        name.className = "wp3c-card-name";
        const desc = document.createElement("div");
        desc.className = "wp3c-card-desc";

        const btns = document.createElement("div");
        btns.className = "wp3c-card-btns";
        const mkBtn = (label, title, onClick) => {
            const b = document.createElement("button");
            b.className = "wp3c-btn";
            b.type = "button";
            b.textContent = label;
            b.title = title;
            b.addEventListener("click", onClick);
            stopCanvasDrag(b);
            return b;
        };
        let randBtn = null, libBtn = null;
        if (slot === "face") {
            btns.append(
                mkBtn("⬆ 上传", "选择本地图片上传为脸模", () => fileInput.click()),
                mkBtn("🗃 素材库", "从 WP 资产库选用脸模", () => openFaceDialog(node))
            );
        } else {
            randBtn = mkBtn("🎲 随机", "随机更换一张" + (slot === "outfit" ? "服装" : slot === "pose" ? "姿势" : "发型"),
                () => randomSlot(node, slot));
            libBtn = mkBtn("🗃 素材库", "打开" + meta.libName + "手动选择", () => openLibDialog(node, slot));
            const cfgBtn = mkBtn("⚙", meta.libName + "随机切换设置（选择参与随机的分类）",
                () => openRandomConfigForNode(node, slot));
            cfgBtn.classList.add("wp3c-icon");
            btns.append(randBtn, libBtn, cfgBtn);
        }

        card.append(head, imgbox, name, desc, btns);
        if (slot === "face") {
            // 注册到全局 window 捕获阶段拖放协调器：ComfyUI 新版前端的 DOM 层级会拦住
            // 普通冒泡式 dragover/drop，必须从最外层按坐标兜底才能稳定接收文件拖入
            _registerFaceDropTarget(node, card, imgbox);
            // 下面 DOM 级监听作为补充（事件若能正常到达卡片时提供高亮与处理）
            card.addEventListener("dragover", (e) => {
                if (faceDragHasPayload(e.dataTransfer)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    imgbox.classList.add("drag-over");
                }
            });
            card.addEventListener("dragleave", (e) => {
                // 在卡片内子元素间移动也会触发 dragleave，仅在真正离开卡片时取消高亮
                if (!card.contains(e.relatedTarget)) imgbox.classList.remove("drag-over");
            });
            card.addEventListener("drop", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                imgbox.classList.remove("drag-over");
                await handleFaceDrop(node, e.dataTransfer);
            });
        }
        stopCanvasDrag(card);
        cards.appendChild(card);
        node._wp3cUI[slot] = {
            img, empty, name, desc, card, toggle, favBtn,
            randBtn: randBtn || { disabled: false }, libBtn: libBtn || { disabled: false },
        };
    }

    // 底部：整合提示词（只读，随四张图的选择自动更新）
    const promptBox = document.createElement("div");
    promptBox.className = "wp3c-prompt";
    const promptHead = document.createElement("div");
    promptHead.className = "wp3c-prompt-head";
    const promptTitle = document.createElement("div");
    promptTitle.textContent = "📋 整合提示词（只读 · 随上方选择自动更新）";
    const copyBtn = document.createElement("button");
    copyBtn.className = "wp3c-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "复制";
    copyBtn.title = "复制整合提示词到剪贴板";
    copyBtn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(promptText.textContent);
            toast("整合提示词已复制");
        } catch (e) {
            toast("复制失败：" + e.message, true);
        }
    });
    stopCanvasDrag(copyBtn);
    promptHead.append(promptTitle, copyBtn);
    const promptText = document.createElement("div");
    promptText.className = "wp3c-prompt-text";
    promptBox.append(promptHead, promptText);
    node._wp3cPromptText = promptText;

    // 注册节点级拖放接口（新旧前端通用的官方机制，ComfyUI「加载图像」节点同款）：
    // 拖文件悬停整个节点时高亮，松手导入为脸模；覆盖 DOM 卡片没盖住的区域（如节点标题栏）。
    // dragover 必须 preventDefault 浏览器才允许在此放下（canvas 路径上没人替我们做这件事）
    // 卡片区域由上面的 drop 优先处理（preventDefault 后节点级接口不会再触发，不会重复上传）
    node.onDragOver = (e) => {
        if (faceDragHasPayload(e.dataTransfer)) {
            e.preventDefault?.();
            return true;
        }
        return false;
    };
    node.onDragDrop = async (e) => {
        if (!faceDragHasPayload(e.dataTransfer)) return false;
        await handleFaceDrop(node, e.dataTransfer);
        return true;
    };

    root.append(hint, cards, promptBox);
    node._wp3cPrompt = promptBox;
    node.addDOMWidget("wp_three_combo_ui", "wp_three_combo_custom", root, {
        serialize: false,
        hideOnZoom: false,
        // 最小高度按「顶部提示 + 卡片(含约200px图片区) + 提示词区」预留，保证默认尺寸下图区不小于旧版
        getMinHeight: () => 560,
    });

    // 监听节点容器尺寸变化（拖拽缩放/窗口调整/布局重排都会触发），实时自适应图片区高度
    const ro = new ResizeObserver(() => layoutCards(node));
    ro.observe(root);
    node._wp3cRO = ro;
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        node._wp3cRO?.disconnect();
        node._wp3cRO = null;
        _unregisterFaceDropTarget(node);
        return origOnRemoved?.apply(this, arguments);
    };

    node.size = [Math.max(node.size[0], 760), node.size[1] || 10];
    node.setDirtyCanvas(true, true);

    // 恢复工作流里已保存的选择与开关状态
    for (const slot of ["face", "outfit", "pose", "hair"]) refreshCard(node, slot);
    for (const slot of LIB_SLOTS) setSlotEnabled(node, slot, isSlotEnabled(node, slot));
    layoutCards(node);

    // 加载/粘贴工作流时，widget 值要等到 configure 阶段才回填，回填后再刷新一次界面与端口状态
    const origOnConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = origOnConfigure?.apply(this, arguments);
        restoreFullOutputs(this);
        for (const slot of ["face", "outfit", "pose", "hair"]) refreshCard(this, slot);
        for (const slot of LIB_SLOTS) setSlotEnabled(this, slot, isSlotEnabled(this, slot));
        return r;
    };
}

app.registerExtension({
    name: "Comfyui_WP_Node_Group.ThreeImageCombo",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            try {
                buildNodeUI(this);
            } catch (e) {
                console.error("[WP三图组合] 前端初始化失败：", e);
            }
            return result;
        };
    },
});
