/**
 * 🐳 WP 三图组合节点 前端
 * 节点卡片界面 + 素材库弹窗（服装/姿势）+ 脸模弹窗（本地上传/WP资产库）+ 随机组合
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "WP_ThreeImageCombo";

const SLOTS = {
    face: { index: 0, title: "1 · 脸模", color: "#f0c24b", widget: "脸模文件" },
    outfit: { index: 1, title: "2 · 服装", color: "#6ea8ff", widget: "服装选择", pathWidget: "服装库路径", libName: "服装库" },
    pose: { index: 2, title: "3 · 姿势", color: "#ff9e5e", widget: "姿势选择", pathWidget: "姿势库路径", libName: "姿势库" },
};

// 整合提示词模板（与后端 三图组合节点.py 保持一致）
const PROMPT_TPL = {
    face: "使用图1参考面部，保留可辨识的五官比例、脸型、肤色与发型，不沿用图片1的服装和动作。",
    outfit: "服装参考图2{seg}，准确还原款式、剪裁、配色、面料纹理与装饰细节，使衣物自然贴合图片1人物的身体，不复制图片2的人脸或姿势。",
    pose: "动作严格按照图3姿态{seg}及观察角度进行参考，遵循躯干朝向、四肢位置、重心和透视关系，不复制图片3的身份、服装或背景。",
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
.wp3c-btn.primary { background:#2c4a78; border-color:#3d6ab0; }
.wp3c-btn.primary:hover { background:#35588f; }
.wp3c-cards { display:flex; gap:8px; align-items:stretch; }
.wp3c-card { flex:1 1 0; min-width:0; background:#1a1e24; border:1px solid #272c34; border-radius:12px;
    display:flex; flex-direction:column; overflow:hidden; }
.wp3c-card-head { display:flex; align-items:center; gap:6px; padding:6px 10px; font-size:13px; font-weight:700; color:#111418; }
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
.wp3c-prompt { margin-top:8px; background:#1a1e24; border:1px solid #272c34; border-radius:10px; padding:8px 12px; }
.wp3c-prompt-head { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:5px; }
.wp3c-prompt-head .wp3c-btn { padding:3px 10px; font-size:11px; }
.wp3c-prompt-text { font-size:12px; color:#c3cad6; line-height:1.65; white-space:pre-wrap; word-break:break-all;
    user-select:text; max-height:130px; overflow-y:auto; }
.wp3c-loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    font-size:12px; color:#8fb4ff; background:rgba(13,15,18,.6); }

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
.wp3c-card-imgbox.drag-over { outline:2px dashed #f0c24b; outline-offset:-2px; background:rgba(240,194,75,.10); }
.wp3c-dlg-body { flex:1 1 auto; display:flex; min-height:0; }
.wp3c-preview { width:300px; flex:0 0 300px; border-left:1px solid #272c34; background:#101317;
    padding:12px; display:flex; flex-direction:column; gap:8px; overflow-y:auto; }
.wp3c-preview-empty { margin:auto; text-align:center; color:#6c7482; font-size:12px; line-height:1.8; padding:0 8px; }
.wp3c-preview-id { font-size:14px; font-weight:700; word-break:break-all; }
.wp3c-preview-imgbox { flex:1 1 auto; min-height:0; background:#0d0f12; border:1px solid #272c34;
    border-radius:10px; overflow-y:auto; }
.wp3c-preview-imgbox img { display:block; width:100%; height:auto; }
.wp3c-preview-desc { font-size:12px; color:#c3cad6; line-height:1.6; white-space:pre-line; word-break:break-all; }
.wp3c-preview-tip { font-size:11px; color:#6c7482; line-height:1.6; margin-top:auto; }
.wp3c-empty { grid-column:1/-1; text-align:center; color:#6c7482; font-size:13px; padding:60px 0; }
.wp3c-more { grid-column:1/-1; text-align:center; padding:10px 0 2px; }
.wp3c-more button { background:#1a1e24; border:1px solid #343a44; color:#a3abb8; border-radius:8px;
    padding:6px 18px; font-size:12px; cursor:pointer; }
.wp3c-toast { position:fixed; left:50%; bottom:40px; transform:translateX(-50%); z-index:100000;
    background:#2a2f38; border:1px solid #4a525f; color:#e9ecf1; padding:10px 20px; border-radius:10px;
    font-size:13px; font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif; box-shadow:0 8px 24px rgba(0,0,0,.4); }
.wp3c-toast.err { background:#3a2020; border-color:#6b3030; }
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

function slotPreviewURL(node, slot, data) {
    if (slot === "face") {
        return api.apiURL("/view") + "?filename=" + encodeURIComponent(data.name || "") +
            "&subfolder=" + encodeURIComponent(data.subfolder || "") + "&type=input";
    }
    const root = (getWidget(node, SLOTS[slot].pathWidget)?.value || "").trim();
    return "/wp_node/three_combo/image?root=" + encodeURIComponent(root) +
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

// 根据节点可用高度计算三张图片的显示区高度：总高 − 顶部提示 − 底部提示词区 − 间距 = 卡片区，
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
        ui.desc.textContent = slot === "face" ? "点按钮上传 · 可直接拖入图片 v5" : "点随机或打开素材库选择";
    }
    updateIntegratedPrompt(node);
}

function updateIntegratedPrompt(node) {
    const box = node._wp3cPromptText;
    if (!box) return;
    const outfit = readWidgetJSON(getWidget(node, SLOTS.outfit.widget));
    const pose = readWidgetJSON(getWidget(node, SLOTS.pose.widget));
    const seg = (d) => { d = (d || "").trim(); return d ? "（" + d + "）" : ""; };
    box.textContent = [
        PROMPT_TPL.face,
        PROMPT_TPL.outfit.replace("{seg}", seg(outfit.desc)),
        PROMPT_TPL.pose.replace("{seg}", seg(pose.desc)),
    ].join(" ");
}

// ---------- 素材库数据 ----------

async function ensureLibrary(node, slot) {
    const path = (getWidget(node, SLOTS[slot].pathWidget)?.value || "").trim();
    const cache = node._wp3cLibs?.[slot];
    if (cache && cache.path === path) return cache;
    const res = await fetch("/wp_node/three_combo/library?path=" + encodeURIComponent(path));
    const j = await res.json().catch(() => ({ success: false, error: "服务器返回异常" }));
    if (!j.success) throw new Error(j.error || "素材库读取失败");
    const lib = { path, items: j.items || [], categories: j.categories || [], total: j.total || 0 };
    (node._wp3cLibs ||= {})[slot] = lib;
    return lib;
}

async function randomSlot(node, slot) {
    try {
        const lib = await ensureLibrary(node, slot);
        if (!lib.items.length) { toast(SLOTS[slot].libName + "里没有可用素材", true); return; }
        const cur = readWidgetJSON(getWidget(node, SLOTS[slot].widget)).file;
        let pick = lib.items[Math.floor(Math.random() * lib.items.length)];
        if (lib.items.length > 1) {
            let guard = 0;
            while (pick.file === cur && guard++ < 20) {
                pick = lib.items[Math.floor(Math.random() * lib.items.length)];
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
                // 来自服装/姿势素材库：复制到 input 后选用
                const res = await fetch("/wp_node/three_combo/import_face", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ root: d.root, file: d.file }),
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

    let _faceDiagDone = false;

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
        _faceDiagDone = false;
    }, true);

    // 诊断：检测到带目标的拖拽首次进入页面时，提示一次，便于确认事件是否真的到达
    window.addEventListener("dragenter", (e) => {
        if (_faceDiagDone) return;
        _faceDiagDone = true;
        const types = Array.from(e.dataTransfer.types || []).join(", ");
        toast("检测到拖拽，类型：" + (types || "未知"));
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

// 填充右侧悬停预览面板（data 为空时显示占位提示）
function setPreview(preview, data) {
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

function makeGridScroller(dlg) {
    // 左侧素材网格 + 右侧悬停预览面板
    const body = document.createElement("div");
    body.className = "wp3c-dlg-body";
    const grid = document.createElement("div");
    grid.className = "wp3c-grid";
    const preview = document.createElement("div");
    preview.className = "wp3c-preview";
    setPreview(preview, null);
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

// 直接加载图片（素材均为本地小图，分批渲染本身已控制单批数量，无需懒加载）
function lazyImg(imgEl, url) {
    imgEl.src = url;
    return imgEl;
}

// ---------- 服装/姿势素材库弹窗 ----------

async function openLibDialog(node, slot) {
    const meta = SLOTS[slot];
    const ui = buildDialog();
    ui.title.textContent = "🗂 " + meta.libName + " · 选择素材";
    ui.sub.textContent = "";

    // 工具栏：搜索框 + 状态
    const search = document.createElement("input");
    search.className = "wp3c-search";
    search.placeholder = "搜索编号或描述关键词…";
    const status = document.createElement("div");
    status.className = "wp3c-status";
    status.textContent = "读取中…";
    ui.toolbar.append(search, status);

    const gridState = makeGridScroller(ui.dlg);

    let lib = null;
    let curCat = "";
    let curKeyword = "";
    const currentFile = () => readWidgetJSON(getWidget(node, meta.widget)).file;

    const cardFor = (item) => {
        const card = document.createElement("div");
        card.className = "wp3c-item" + (item.file === currentFile() ? " selected" : "");
        const box = document.createElement("div");
        box.className = "wp3c-item-img";
        const img = lazyImg(document.createElement("img"),
            "/wp_node/three_combo/image?root=" + encodeURIComponent(lib.path) +
            "&file=" + encodeURIComponent(item.file));
        box.appendChild(img);
        const name = document.createElement("div");
        name.className = "wp3c-item-name";
        name.textContent = item.id || item.file;
        name.title = item.id || item.file;
        const desc = document.createElement("div");
        desc.className = "wp3c-item-desc";
        desc.textContent = item.desc || "";
        desc.title = item.desc || "";
        card.append(box, name, desc);
        card.addEventListener("click", () => {
            applySlot(node, slot, item);
            ui.close();
        });
        // 悬停预览 + 可拖拽到节点的「1 · 脸模」区域
        card.addEventListener("mouseenter", () => {
            setPreview(gridState.preview, {
                src: img.src,
                id: item.id || item.file,
                desc: item.desc || "",
                tip: "点击选用 · 也可直接拖到节点的「1 · 脸模」区域",
            });
        });
        card.draggable = true;
        card.addEventListener("dragstart", (e) => {
            const buf = JSON.stringify({ source: "lib_file", root: lib.path, file: item.file });
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
        const items = lib.items.filter((it) =>
            (!curCat || it.cat === curCat) &&
            (!kw || (it.id || "").toLowerCase().includes(kw) || (it.desc || "").toLowerCase().includes(kw))
        );
        status.textContent = items.length + " 个素材" + (curCat ? " · " + curCat : "");
        gridState.reset(items.map(cardFor), "没有匹配的素材，换个关键词或分类试试");
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
        lib = await ensureLibrary(node, slot);
        ui.sub.textContent = lib.path;
        renderTabs();
        refresh();
    } catch (e) {
        status.textContent = "";
        gridState.reset([], "读取失败：" + e.message);
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
    const gridState = makeGridScroller(ui.dlg);

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
                    setPreview(gridState.preview, {
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

// ---------- 节点界面 ----------

function buildNodeUI(node) {
    ensureStyle();

    // 隐藏三个数据 widget（值仍会随工作流保存）
    for (const key of ["脸模文件", "服装选择", "姿势选择"]) {
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
    hintText.textContent = "1 脸模 → 2 服装 → 3 姿势 · 上传的脸模不参与随机 · v5";
    const randAll = document.createElement("button");
    randAll.className = "wp3c-btn primary";
    randAll.type = "button";
    randAll.textContent = "🎲 随机组合（服装+姿势）";
    randAll.title = "同时随机更换服装和姿势";
    randAll.addEventListener("click", () => { randomSlot(node, "outfit"); randomSlot(node, "pose"); });
    stopCanvasDrag(randAll);
    hint.append(hintText, randAll);

    // 三张卡片
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

    for (const slot of ["face", "outfit", "pose"]) {
        const meta = SLOTS[slot];
        const card = document.createElement("div");
        card.className = "wp3c-card";

        const head = document.createElement("div");
        head.className = "wp3c-card-head";
        head.style.background = meta.color;
        head.textContent = meta.title;

        const imgbox = document.createElement("div");
        imgbox.className = "wp3c-card-imgbox";
        const img = document.createElement("img");
        img.style.display = "none";
        const empty = document.createElement("div");
        empty.className = "wp3c-card-empty";
        imgbox.append(img, empty);

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
        if (slot === "face") {
            btns.append(
                mkBtn("⬆ 上传", "选择本地图片上传为脸模", () => fileInput.click()),
                mkBtn("🗃 素材库", "从 WP 资产库选用脸模", () => openFaceDialog(node))
            );
        } else {
            btns.append(
                mkBtn("🎲 随机", "随机更换一张" + (slot === "outfit" ? "服装" : "姿势"), () => randomSlot(node, slot)),
                mkBtn("🗃 素材库", "打开" + meta.libName + "手动选择", () => openLibDialog(node, slot))
            );
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
        node._wp3cUI[slot] = { img, empty, name, desc };
    }

    // 底部：整合提示词（只读，随三张图的选择自动更新）
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

    node.size = [Math.max(node.size[0], 700), node.size[1] || 10];
    node.setDirtyCanvas(true, true);

    // 恢复工作流里已保存的选择
    for (const slot of ["face", "outfit", "pose"]) refreshCard(node, slot);
    layoutCards(node);

    // 加载/粘贴工作流时，widget 值要等到 configure 阶段才回填，回填后再刷新一次界面
    const origOnConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = origOnConfigure?.apply(this, arguments);
        for (const slot of ["face", "outfit", "pose"]) refreshCard(this, slot);
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
