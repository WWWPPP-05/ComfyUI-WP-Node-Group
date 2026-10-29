import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ═══════════════════════════════════════════════
// 🐳 WP 简易画板 · 前端扩展
// 节点内嵌轻量画板：画笔/橡皮/形状/文字，统一图层栈（背景 + 笔迹层/对象自由混排），
// 全部交互在节点内部完成，无弹窗；输出经 input 目录上传 → Python 端转张量
// ═══════════════════════════════════════════════

const NODE_NAME = "WP_SimpleCanvas";
const PURPLE = "#662ad5";
const PURPLE_L = "#8f6bff";
const DEFAULT_NODE_SIZE = [1024, 512];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.0;
const HISTORY_MAX = 40;
const SAVE_DEBOUNCE = 900;
const AUTO_OUT_DEBOUNCE = 500;

const RATIOS = ["1:1", "4:3", "16:9", "3:4", "9:16", "2:1", "1:2"];

// 图像显示类节点：点击「输出图像」时仅运行「画板 → 直连的这类节点」小段链路
const DISPLAY_TYPES = new Set(["PreviewImage", "SaveImage", "WP_ImageComparer"]);
// 当前打开的所有画板实例：工作流运行前统一同步未导出的改动
const BOARDS = new Set();

const FONTS = [
    ["默认", "system-ui, 'Microsoft YaHei', 'PingFang SC', sans-serif"],
    ["微软雅黑", "'Microsoft YaHei', sans-serif"],
    ["宋体", "'SimSun', 'Songti SC', serif"],
    ["黑体", "'SimHei', 'Heiti SC', sans-serif"],
    ["楷体", "'KaiTi', 'Kaiti SC', serif"],
    ["仿宋", "'FangSong', 'FangSong SC', serif"],
];

const SWATCHES = ["#000000", "#ffffff", "#f03e3e", "#f76707", "#f59f00", "#37b24d", "#0c8599", "#1c7ed6", "#7048e8", "#d6336c", "#868e96", "#74b816"];

const TOOL_KEYS = { v: "select", b: "brush", e: "eraser", t: "text", r: "rect", o: "ellipse", c: "cut" };

// 图层面板行首图标（按对象类型；笔迹层用 ✏）
const LAYER_ICONS = { image: "🖼", text: "T", rect: "▭", ellipse: "◯", triangle: "△" };

// 素材上传：最大边像素 / 单文件大小上限 / src→canvas 解码缓存
const MAX_UPLOAD_EDGE = 1024;
const MAX_FILE_MB = 20;
const IMG_CACHE = new Map();

// 资产库后端接口前缀（画布区拖入素材库图片时取原图用）
const ASSET_API = "/wp_node/asset_library";

function imageCanvasFromSrc(src, cb) {
    const img = new Image();
    img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext("2d").drawImage(img, 0, 0);
        if (IMG_CACHE.size > 16) IMG_CACHE.delete(IMG_CACHE.keys().next().value);
        IMG_CACHE.set(src, cv);
        cb(cv);
    };
    img.onerror = () => cb(null);
    img.src = src;
}

// 序列化用压缩格式：WebP 保留透明通道且体积比 PNG 小 5~10 倍（避免撑爆浏览器 localStorage 草稿配额）；环境不支持时回退 PNG
function canvasDataURL(cv) {
    const s = cv.toDataURL("image/webp", 0.92);
    return s.startsWith("data:image/webp") ? s : cv.toDataURL("image/png");
}

// ── 小工具 ──
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
}
function cleanClone(obj) { return JSON.parse(JSON.stringify(obj, (k, v) => (k.charAt(0) === "_" ? undefined : v))); }
function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
}
function sizeFor(ratio, maxEdge) {
    const [a, b] = ratio.split(":").map(Number);
    return a >= b
        ? { W: maxEdge, H: Math.max(2, Math.round(maxEdge * b / a)) }
        : { W: Math.max(2, Math.round(maxEdge * a / b)), H: maxEdge };
}

// ── 样式（跟随 ComfyUI 明暗主题）──
function injectStyle() {
    if (document.getElementById("wp-cv-style")) return;
    const style = document.createElement("style");
    style.id = "wp-cv-style";
    style.textContent = `
.wp-cv-root{--cv-bg:var(--comfy-menu-bg,var(--bg-color,#1e1e1e));--cv-fg:var(--fg-color,#e5e5e5);--cv-bd:var(--border-color,#444);--cv-ib:var(--comfy-input-bg,#2a2a2a);--cv-mut:#999;
position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:280px;background:var(--cv-bg);color:var(--cv-fg);
font-family:inherit;font-size:12px;overflow:hidden;user-select:none;-webkit-user-select:none;pointer-events:auto;}
.wp-cv-root input,.wp-cv-root textarea,.wp-cv-root select{user-select:text;-webkit-user-select:text;}
.wp-cv-root *{box-sizing:border-box;}
.wp-cv-main{flex:1 1 auto;display:flex;min-height:0;}
.wp-cv-toolbar{flex:0 0 148px;width:148px;overflow-y:auto;overflow-x:hidden;background:var(--cv-bg);border-right:1px solid var(--cv-bd);padding:6px 6px 10px;scrollbar-width:thin;}
.wp-cv-sec{padding:6px 2px 8px;border-bottom:1px solid var(--cv-bd);}
.wp-cv-sec:last-child{border-bottom:0;}
.wp-cv-sec-title{font-size:11px;color:var(--cv-mut);letter-spacing:1px;margin:2px 0 6px 2px;}
.wp-cv-row{display:flex;align-items:center;justify-content:space-between;gap:4px;margin:5px 0;color:var(--cv-fg);font-size:12px;}
.wp-cv-row>span{flex:0 0 auto;}
.wp-cv-root select,.wp-cv-root input[type=number],.wp-cv-root input[type=text]{background:var(--cv-ib);color:var(--cv-fg);border:1px solid var(--cv-bd);border-radius:4px;padding:2px 4px;font-size:12px;font-family:inherit;outline:none;min-width:0;}
.wp-cv-root select{max-width:88px;cursor:pointer;}
.wp-cv-stepper{display:flex;align-items:center;gap:2px;}
.wp-cv-stepper input{width:52px;text-align:center;}
.wp-cv-stepper button{width:18px;height:20px;flex:0 0 18px;}
.wp-cv-btn{background:var(--cv-ib);color:var(--cv-fg);border:1px solid var(--cv-bd);border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;line-height:1;padding:0;}
.wp-cv-btn:hover{border-color:${PURPLE_L};color:#fff;background:${PURPLE};}
.wp-cv-colorbtn{width:46px;height:20px;padding:2px;display:flex;align-items:center;justify-content:center;}
.wp-cv-colorbtn i{display:block;width:100%;height:100%;border-radius:3px;border:1px solid var(--cv-bd);background-image:linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,#fff 25%,#fff 75%,#ccc 75%);background-size:8px 8px;background-position:0 0,4px 4px;}
.wp-cv-colorbtn i b{display:block;width:100%;height:100%;}
.wp-cv-switch{width:32px;height:16px;border-radius:8px;background:var(--cv-ib);border:1px solid var(--cv-bd);position:relative;cursor:pointer;padding:0;flex:0 0 32px;}
.wp-cv-switch i{position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;background:var(--cv-mut);transition:left .15s,background .15s;}
.wp-cv-switch.on{background:${PURPLE};border-color:${PURPLE};}
.wp-cv-switch.on i{left:17px;background:#fff;}
.wp-cv-tools{display:flex;flex-direction:column;gap:2px;}
.wp-cv-tools button{display:flex;align-items:center;gap:6px;height:24px;padding:0 7px;background:transparent;border:1px solid transparent;border-radius:5px;color:var(--cv-fg);cursor:pointer;font-size:12px;font-family:inherit;text-align:left;}
.wp-cv-tools button:hover{background:var(--cv-ib);}
.wp-cv-tools button.on{background:${PURPLE};color:#fff;}
.wp-cv-tools button em{font-style:normal;margin-left:auto;font-size:10px;opacity:.55;}
.wp-cv-params{display:flex;flex-direction:column;gap:2px;}
.wp-cv-assets{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;}
.wp-cv-asset{position:relative;aspect-ratio:1/1;border:1px solid var(--cv-bd);border-radius:5px;overflow:hidden;cursor:pointer;background-color:var(--cv-ib);background-size:cover;background-position:center;}
.wp-cv-asset:hover{border-color:#8f6bff;}
.wp-cv-asset .del{position:absolute;top:2px;right:2px;width:15px;height:15px;border-radius:50%;border:0;background:rgba(0,0,0,.6);color:#fff;font-size:11px;line-height:15px;padding:0;cursor:pointer;font-family:inherit;text-align:center;}
.wp-cv-asset .del:hover{background:#e03131;}
.wp-cv-asset.add{border:1.5px dashed var(--cv-mut);display:flex;align-items:center;justify-content:center;color:var(--cv-mut);font-size:17px;background:transparent;}
.wp-cv-asset.add:hover{border-color:#8f6bff;color:#8f6bff;}
.wp-cv-assets.drag .add{border-color:#8f6bff;color:#8f6bff;background:rgba(143,107,255,.12);}
.wp-cv-asset.add.busy{pointer-events:none;animation:wpCvPulse .9s infinite;}
@keyframes wpCvPulse{50%{opacity:.35;}}
.cv-p{margin:4px 0;}
.cv-p-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;}
.cv-p-top span{font-size:12px;}
.cv-p-top input{width:56px;text-align:right;}
.cv-p-range{width:100%;accent-color:${PURPLE_L};cursor:pointer;}
.cv-p-toggles{display:flex;gap:4px;margin:4px 0;}
.cv-p-toggles .wp-cv-btn{flex:1;height:22px;}
.cv-p-toggles .wp-cv-btn.on{background:${PURPLE};border-color:${PURPLE};color:#fff;}
.cv-hint{font-size:11px;color:var(--cv-mut);line-height:1.6;padding:2px;}
.wp-cv-view{flex:1 1 auto;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--cv-bg);touch-action:none;}
.wp-cv-view.dragover{outline:2px dashed ${PURPLE_L};outline-offset:-3px;}
.wp-cv-view.dragover::after{content:"松开鼠标，添加图片到画布";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:7;pointer-events:none;background:rgba(22,18,34,.85);color:#fff;font-size:12px;line-height:1;padding:7px 12px;border-radius:6px;white-space:nowrap;}
.wp-cv-display{position:absolute;inset:0;width:100%;height:100%;display:block;}
.wp-cv-ta{position:absolute;display:none;z-index:6;background:transparent;border:0;outline:1.5px dashed ${PURPLE_L};outline-offset:2px;resize:none;overflow:hidden;padding:0;margin:0;white-space:pre;min-width:20px;min-height:14px;caret-color:#0af;}
.wp-cv-zoombadge{position:absolute;top:6px;right:6px;z-index:5;height:20px;padding:0 8px;border-radius:10px;background:var(--cv-ib);border:1px solid var(--cv-bd);color:var(--cv-mut);font-size:11px;cursor:pointer;font-family:inherit;}
.wp-cv-floatbar{position:absolute;left:0;top:0;display:none;gap:2px;padding:2px;background:var(--cv-ib);border:1px solid var(--cv-bd);border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.4);z-index:6;transform:translate(-50%,-100%);}
.wp-cv-floatbar .wp-cv-btn{width:26px;height:22px;font-size:13px;line-height:1;}
.wp-cv-zoombadge:hover{color:#fff;border-color:${PURPLE_L};}
.wp-cv-confirm{position:absolute;inset:0;z-index:8;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);}
.wp-cv-confirm-box{background:var(--cv-bg);border:1px solid var(--cv-bd);border-radius:8px;padding:14px 16px;max-width:82%;box-shadow:0 6px 24px rgba(0,0,0,.4);}
.wp-cv-confirm-box p{margin:0 0 12px;font-size:13px;line-height:1.6;}
.wp-cv-confirm-box .ops{display:flex;justify-content:flex-end;gap:8px;}
.wp-cv-confirm-box button{min-width:64px;height:26px;border-radius:5px;cursor:pointer;font-family:inherit;font-size:12px;border:1px solid var(--cv-bd);background:var(--cv-ib);color:var(--cv-fg);}
.wp-cv-confirm-box button.ok{background:${PURPLE};border-color:${PURPLE};color:#fff;}
.wp-cv-bottom{flex:0 0 40px;display:flex;align-items:center;gap:6px;padding:0 8px;border-top:1px solid var(--cv-bd);background:var(--cv-bg);}
.wp-cv-bleft,.wp-cv-bright{flex:1 1 0;display:flex;align-items:center;gap:5px;min-width:0;}
.wp-cv-bright{justify-content:flex-end;}
.wp-cv-bleft button{width:28px;height:26px;font-size:13px;}
.wp-cv-bleft button:disabled{opacity:.35;cursor:default;}
.wp-cv-bleft button:disabled:hover{background:var(--cv-ib);border-color:var(--cv-bd);color:var(--cv-fg);}
.wp-cv-status{font-size:11px;color:var(--cv-mut);margin-left:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.wp-cv-out{flex:0 0 auto;height:28px;padding:0 22px;border:0;border-radius:14px;background:${PURPLE};color:#fff;font-size:13px;letter-spacing:1px;cursor:pointer;font-family:inherit;}
.wp-cv-out:hover{background:#7736ea;}
.wp-cv-out:active{transform:translateY(1px);}
.wp-cv-out:disabled{opacity:.6;cursor:default;}
.wp-cv-bright span{font-size:12px;color:var(--cv-mut);}
.wp-cv-menu{position:absolute;z-index:20;min-width:118px;background:var(--cv-bg);border:1px solid var(--cv-bd);border-radius:7px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.45);display:none;}
.wp-cv-menu button{display:block;width:100%;height:26px;padding:0 10px;background:transparent;border:0;border-radius:4px;color:var(--cv-fg);font-size:12px;font-family:inherit;text-align:left;cursor:pointer;}
.wp-cv-menu button:hover{background:${PURPLE};color:#fff;}
.wp-cv-menu button:disabled{opacity:.4;cursor:default;}
.wp-cv-menu button:disabled:hover{background:transparent;color:var(--cv-fg);}
.wp-cv-menu hr{border:0;border-top:1px solid var(--cv-bd);margin:4px 2px;}
.wp-cv-picker{position:absolute;z-index:30;width:196px;background:var(--cv-bg);border:1px solid var(--cv-bd);border-radius:8px;padding:8px;box-shadow:0 6px 20px rgba(0,0,0,.45);display:none;}
.wp-cv-picker .sws{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:8px;}
.wp-cv-picker .sw{height:18px;border-radius:4px;border:1px solid var(--cv-bd);cursor:pointer;padding:0;background-image:linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%),linear-gradient(45deg,#bbb 25%,#fff 25%,#fff 75%,#bbb 75%);background-size:8px 8px;background-position:0 0,4px 4px;}
.wp-cv-picker .sw b{display:block;width:100%;height:100%;border-radius:3px;}
.wp-cv-picker .prow{display:flex;align-items:center;gap:5px;margin:6px 0;}
.wp-cv-picker .prow span{font-size:11px;color:var(--cv-mut);flex:0 0 auto;}
.wp-cv-picker input[type=text]{width:84px;}
.wp-cv-picker input[type=number]{width:44px;}
.wp-cv-picker input[type=color]{width:26px;height:22px;padding:0;border:1px solid var(--cv-bd);border-radius:4px;background:var(--cv-ib);cursor:pointer;}
.wp-cv-layers{flex:0 0 170px;width:170px;display:flex;flex-direction:column;min-height:0;background:var(--cv-bg);border-left:1px solid var(--cv-bd);}
.wp-cv-ltitle{flex:0 0 auto;padding:7px 8px 6px;font-size:11px;color:var(--cv-mut);letter-spacing:1px;border-bottom:1px solid var(--cv-bd);}
.wp-cv-layer-list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:4px;scrollbar-width:thin;}
.wp-cv-layer{display:flex;align-items:center;gap:5px;height:26px;padding:0 6px;margin-bottom:2px;border:1px solid transparent;border-radius:5px;cursor:pointer;}
.wp-cv-layer:hover{background:var(--cv-ib);}
.wp-cv-layer.selected{background:rgba(102,42,213,.3);border-color:${PURPLE_L};}
.wp-cv-layer.off{opacity:.5;}
.wp-cv-layer.dragging{opacity:.35;}
.wp-cv-layer.dragover-top{box-shadow:inset 0 2px 0 0 ${PURPLE_L};}
.wp-cv-layer.dragover-bottom{box-shadow:inset 0 -2px 0 0 ${PURPLE_L};}
.wp-cv-layer.fixed{cursor:default;}
.wp-cv-layer .vis{flex:0 0 auto;margin:0;cursor:pointer;accent-color:${PURPLE_L};}
.wp-cv-layer .ic{flex:0 0 14px;text-align:center;font-size:11px;color:var(--cv-mut);line-height:1;}
.wp-cv-layer .nm{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;}
.wp-cv-layer-ops{flex:0 0 auto;display:flex;flex-direction:column;gap:4px;padding:6px;border-top:1px solid var(--cv-bd);}
.wp-cv-layer-ops .wp-cv-btn{flex:1 1 auto;height:24px;}
.wp-cv-layer-ops .wp-cv-btn:disabled{opacity:.4;cursor:default;}
.wp-cv-lrow{display:flex;gap:4px;}
.wp-cv-lrow .wp-cv-btn{flex:1 1 0;height:24px;}
.wp-cv-layer.active{box-shadow:inset 2px 0 0 0 ${PURPLE_L};}
.wp-cv-layer.active .nm{font-weight:700;}
`;
    document.head.appendChild(style);
}

// ═══════════════ 画板控制器（每个节点一个实例）═══════════════
class WPCanvasBoard {
    constructor(node) {
        this.node = node;
        this.destroyed = false;
        BOARDS.add(this);
        this.state = {
            W: 1024, H: 1024, ratio: "1:1", maxEdge: 1024,
            bgColor: "#ffffff", bgTransparent: false, grid: false,
            tool: "brush",
            brush: { size: 24, color: "#339af0", opacity: 100, hardness: 80 },
            eraser: { size: 48, opacity: 100, hardness: 100 },
            text: { family: FONTS[0][1], size: 48, color: "#333333", bold: false, italic: false },
            shape: { fillOn: true, fillColor: "#845ef7", strokeOn: false, strokeColor: "#333333", strokeW: 4 },
            autoOut: false,
            stack: [{ id: "L1", type: "paint", name: "图层1", visible: true }],
            activeId: "L1",
            selection: new Set(),
        };
        this.view = { zoom: 1, x: 0, y: 0 };
        this.idSeq = 1;
        this.layerSeq = 1;
        this._revSeq = 1;
        this._snapCache = new Map(); // paint id → { rev, cv }：写时复制快照缓存，未变的层跨历史条目共享画布
        this.history = [];
        this.redoStack = [];
        this.editing = null;
        this.editBefore = null;
        this.editIsNew = false;
        this.drag = null;
        this.previewObj = null;
        this.spaceHeld = false;
        this._raf = 0;
        this._saveTimer = 0;
        this._autoTimer = 0;
        this._decPs = []; // restore 期间待解码的笔迹层 Promise（导出/序列化前需等待落地）
        this._busy = false;
        this._pSnap = null;
        this._restoredFrom = null;
        this._outDirty = true; // 画布有未导出的改动：新建/编辑/恢复后置真，运行工作流前自动输出
        this._didFit = false;
        this._hover = null;
        this._cutPts = null;   // 分割工具：已闭合的圈选路径（画布坐标）
        this._antsRaf = 0;     // 蚂蚁线动画帧
        this._antsOff = 0;     // 蚂蚁线相位偏移
        this._flash = null;    // 新对象高亮闪烁 { ids:Set, t0 }
        this._flashRaf = 0;
        this._pasteBusy = false; // 剪贴板图片解码/放置进行中（防重入）
        this._pasteAt = 0;       // 最近一次 paste 事件时间戳（防双通道重复粘贴）
        this.dpr = Math.max(1, window.devicePixelRatio || 1);

        this.buildDOM();
        this.initCanvases(this.state.W, this.state.H);
        this.buildParams();
        this.updateToolbarUI();
    }

    // ── DOM 构建 ──
    buildDOM() {
        injectStyle();
        const root = el("div", "wp-cv-root");
        root.setAttribute("data-wp-canvas", "1");
        root.innerHTML = `
<div class="wp-cv-main">
  <div class="wp-cv-toolbar">
    <div class="wp-cv-sec">
      <div class="wp-cv-sec-title">画布</div>
      <div class="wp-cv-row"><span>比例</span><select class="wp-cv-ratio">${RATIOS.map((r) => `<option value="${r}">${r}</option>`).join("")}</select></div>
      <div class="wp-cv-row"><span>最大边</span><div class="wp-cv-stepper"><button type="button" class="wp-cv-btn wp-cv-edge-minus">−</button><input type="number" class="wp-cv-edge" min="64" max="4096" step="1"><button type="button" class="wp-cv-btn wp-cv-edge-plus">＋</button></div></div>
      <div class="wp-cv-row"><span>背景色</span><button type="button" class="wp-cv-btn wp-cv-colorbtn wp-cv-bg"><i><b></b></i></button></div>
      <div class="wp-cv-row"><span>网格</span><button type="button" class="wp-cv-switch wp-cv-grid" title="显示等距辅助网格"><i></i></button></div>
    </div>
    <div class="wp-cv-sec">
      <div class="wp-cv-sec-title">工具</div>
      <div class="wp-cv-tools">
        <button type="button" data-tool="select" title="选择 (V)">✥ 选择<em>V</em></button>
        <button type="button" data-tool="brush" title="画笔 (B)">✏ 画笔<em>B</em></button>
        <button type="button" data-tool="eraser" title="橡皮擦 (E)">🧽 橡皮<em>E</em></button>
        <button type="button" data-tool="text" title="文字 (T)">T 文字<em>T</em></button>
        <button type="button" data-tool="rect" title="矩形 (R)">▭ 矩形<em>R</em></button>
        <button type="button" data-tool="ellipse" title="圆形 (O)">◯ 圆形<em>O</em></button>
        <button type="button" data-tool="triangle" title="三角形">△ 三角<em></em></button>
        <button type="button" data-tool="cut" title="分割 (C)：圈选后拆分为新图层">✂ 分割<em>C</em></button>
      </div>
    </div>
    <div class="wp-cv-sec">
      <div class="wp-cv-sec-title">参数</div>
      <div class="wp-cv-params"></div>
    </div>
    <div class="wp-cv-sec">
      <div class="wp-cv-sec-title">素材</div>
      <div class="wp-cv-assets"></div>
    </div>
  </div>
  <div class="wp-cv-view">
    <canvas class="wp-cv-display"></canvas>
    <textarea class="wp-cv-ta" spellcheck="false"></textarea>
    <button type="button" class="wp-cv-zoombadge" title="适配视图 (Ctrl+0)">100%</button>
    <div class="wp-cv-floatbar">
      <button type="button" class="wp-cv-btn" data-fb="flipx" title="水平镜像：左右翻转选中内容（可撤销）">↔</button>
      <button type="button" class="wp-cv-btn" data-fb="flipy" title="垂直镜像：上下翻转选中内容（可撤销）">↕</button>
      <button type="button" class="wp-cv-btn" data-fb="rot" title="旋转：按住拖动自由旋转（Shift 吸附 15°），轻点一下顺时针转 90°">⟳</button>
    </div>
    <div class="wp-cv-confirm"><div class="wp-cv-confirm-box"><p></p><div class="ops"><button type="button" class="cancel">取消</button><button type="button" class="ok">确定</button></div></div></div>
  </div>
  <div class="wp-cv-layers">
    <div class="wp-cv-ltitle">图层</div>
    <div class="wp-cv-layer-list"></div>
    <div class="wp-cv-layer-ops"><div class="wp-cv-lrow"><button type="button" class="wp-cv-btn wp-cv-addlayer" title="新增一个空白笔迹图层">＋ 新增</button><button type="button" class="wp-cv-btn wp-cv-dellayer" title="删除选中的图层（可撤销）">🗑 删除</button></div><button type="button" class="wp-cv-btn wp-cv-merge" title="将选中的图层合并为一张图片（可撤销）">⇊ 合并所选</button></div>
  </div>
</div>
<div class="wp-cv-bottom">
  <div class="wp-cv-bleft">
    <button type="button" class="wp-cv-btn wp-cv-undo" title="撤销 (Ctrl+Z)">↩</button>
    <button type="button" class="wp-cv-btn wp-cv-redo" title="重做 (Ctrl+Shift+Z)">↪</button>
    <button type="button" class="wp-cv-btn wp-cv-clear" title="清空画布（可撤销）">🗑</button>
    <span class="wp-cv-status"></span>
  </div>
  <button type="button" class="wp-cv-out">输出图像</button>
  <div class="wp-cv-bright"><span>自动输出</span><button type="button" class="wp-cv-switch wp-cv-auto" title="编辑完成后自动更新输出"><i></i></button></div>
</div>`;
        this.root = root;
        root.__wpBoard__ = this;
        const q = (s) => root.querySelector(s);
        this.viewEl = q(".wp-cv-view");
        this.display = q(".wp-cv-display");
        this.dctx = this.display.getContext("2d");
        this.ta = q(".wp-cv-ta");
        this.zoomBadge = q(".wp-cv-zoombadge");
        this.floatBar = q(".wp-cv-floatbar");
        this.confirmEl = q(".wp-cv-confirm");
        this.confirmMsg = q(".wp-cv-confirm p");
        this.paramsEl = q(".wp-cv-params");
        this.assetsEl = q(".wp-cv-assets");
        this.layerListEl = q(".wp-cv-layer-list");
        this.mergeBtn = q(".wp-cv-merge");
        this.addLayerBtn = q(".wp-cv-addlayer");
        this.delLayerBtn = q(".wp-cv-dellayer");
        this.fileInput = document.createElement("input");
        this.fileInput.type = "file";
        this.fileInput.accept = "image/*";
        this.fileInput.multiple = true;
        this.fileInput.style.display = "none";
        this.root.appendChild(this.fileInput);
        this._uploading = false;
        this.ratioSel = q(".wp-cv-ratio");
        this.edgeInput = q(".wp-cv-edge");
        this.bgBtn = q(".wp-cv-bg");
        this.bgSw = q(".wp-cv-bg b");
        this.gridSwitch = q(".wp-cv-grid");
        this.autoSwitch = q(".wp-cv-auto");
        this.undoBtn = q(".wp-cv-undo");
        this.redoBtn = q(".wp-cv-redo");
        this.clearBtn = q(".wp-cv-clear");
        this.outBtn = q(".wp-cv-out");
        this.statusEl = q(".wp-cv-status");
        this.toolBtns = {};
        root.querySelectorAll(".wp-cv-tools button").forEach((b) => (this.toolBtns[b.dataset.tool] = b));

        this.measCanvas = document.createElement("canvas");
        this.measCtx = this.measCanvas.getContext("2d");

        const widget = this.node.addDOMWidget("wp_canvas", "wp_canvas_custom", root, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => 320,
        });
        widget.serialize = false;
        this.widget = widget;

        this.bindToolbar();
        this.bindViewEvents();
        this.bindTextEditor();
        this.rebuildAssets();

        // 节点尺寸变化 → 重设显示画布并重绘
        this.ro = new ResizeObserver(() => {
            this.resizeDisplay();
            if (!this._didFit) {
                this._didFit = true;
                this.fitView();
            }
        });
        this.ro.observe(this.viewEl);
        // 初始布局完成后再适配一次（双 rAF 等待布局，参考全景图节点经验）
        requestAnimationFrame(() => requestAnimationFrame(() => {
            this.resizeDisplay();
            this._didFit = true;
            this.fitView();
        }));
    }

    // ── 工具栏事件 ──
    bindToolbar() {
        const stop = (e) => { e.stopPropagation(); };
        this.root.addEventListener("pointerdown", stop);
        this.root.addEventListener("contextmenu", (e) => e.preventDefault());

        // 素材面板：拖放上传 + 文件选择
        this.assetsEl.addEventListener("dragover", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.assetsEl.classList.add("drag");
        });
        this.assetsEl.addEventListener("dragleave", () => this.assetsEl.classList.remove("drag"));
        this.assetsEl.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.assetsEl.classList.remove("drag");
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) this.handleFiles(e.dataTransfer.files);
        });
        this.fileInput.addEventListener("change", () => {
            if (this.fileInput.files && this.fileInput.files.length) this.handleFiles(this.fileInput.files);
            this.fileInput.value = "";
        });

        // 画布区：拖入本地图片 / 资产库素材（接管拖放，阻止 ComfyUI 默认的拖图建节点行为）
        this.viewEl.addEventListener("dragover", (e) => {
            const t = e.dataTransfer && e.dataTransfer.types;
            if (!t || !(t.includes("Files") || t.includes("application/x-wp-asset"))) return;
            e.preventDefault(); e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            this.viewEl.classList.add("dragover");
        });
        this.viewEl.addEventListener("dragleave", (e) => {
            const rt = e.relatedTarget;
            if (rt && this.viewEl.contains(rt)) return;
            this.viewEl.classList.remove("dragover");
        });
        this.viewEl.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.viewEl.classList.remove("dragover");
            this.handleCanvasDrop(e);
        });

        // 悬浮工具条：镜像 / 旋转（选中元素后出现在选中框上方中间）
        this.floatBar.addEventListener("pointerdown", (e) => {
            const btn = e.target.closest("button[data-fb]");
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation(); // 不冒泡到画布，避免触发画布的选中/拖拽逻辑
            if (!this.state.selection.size) return;
            const kind = btn.dataset.fb;
            if (kind === "flipx") { this.mirrorSelection("x"); return; }
            if (kind === "flipy") { this.mirrorSelection("y"); return; }
            // 旋转按钮：按住拖动 = 自由旋转（复用画布的 rot 拖拽流程；轻点在 up 时转 90°）
            const [sx, sy] = this.eventPos(e);
            const [cx, cy] = this.toCanvas(sx, sy);
            this.capture(e);
            this.beginDrag({
                mode: "rot", vbefore: this.snapshotStack(), center: this.selCenter(),
                startC: [cx, cy], a0: null, objs: this.selBase(),
                paints: this.selectedPaints().map((l) => ({ ref: l, base: null })), moved: false,
            });
        });

        this.ratioSel.addEventListener("change", () => {
            const nr = this.ratioSel.value;
            if (nr === this.state.ratio) return;
            this.applyCanvasResize(nr, this.state.maxEdge);
        });

        // 最大边：加减按钮支持长按连击，松手后统一应用
        const edgePending = () => {
            const v = clamp(Math.round(+this.edgeInput.value || 0), 64, 4096);
            this.edgeInput.value = v;
            return v;
        };
        const edgeCommit = () => {
            const v = edgePending();
            if (v === this.state.maxEdge) return;
            this.applyCanvasResize(this.state.ratio, v);
        };
        this.edgeInput.addEventListener("change", edgeCommit);
        this.edgeInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); this.edgeInput.blur(); }
        });
        const holdBtn = (btn, step) => {
            let t1 = 0, t2 = 0;
            const tick = () => { this.edgeInput.value = clamp((+this.edgeInput.value || 0) + step, 64, 4096); };
            const stopHold = () => {
                clearTimeout(t1); clearInterval(t2);
                btn.removeEventListener("pointerup", stopHold);
                btn.removeEventListener("pointerleave", stopHold);
                edgeCommit();
            };
            btn.addEventListener("pointerdown", (e) => {
                e.stopPropagation(); e.preventDefault();
                tick();
                t1 = setTimeout(() => (t2 = setInterval(tick, 70)), 380);
                btn.addEventListener("pointerup", stopHold, { once: true });
                btn.addEventListener("pointerleave", stopHold, { once: true });
            });
        };
        holdBtn(this.root.querySelector(".wp-cv-edge-minus"), -16);
        holdBtn(this.root.querySelector(".wp-cv-edge-plus"), 16);

        this.bgBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.openColorPicker(this.bgBtn, {
                color: this.state.bgTransparent ? null : this.state.bgColor,
                allowTransparent: true,
                apply: (c) => {
                    this.state.bgTransparent = c == null;
                    if (c != null) this.state.bgColor = c;
                    this.updateToolbarUI();
                    this.requestRender();
                    this.saveSchedule();
                    this.markEdited();
                },
            });
        });

        this.gridSwitch.addEventListener("click", () => {
            this.state.grid = !this.state.grid;
            this.updateToolbarUI();
            this.requestRender();
            this.saveSchedule();
        });

        Object.entries(this.toolBtns).forEach(([t, b]) => b.addEventListener("click", () => this.setTool(t)));

        this.autoSwitch.addEventListener("click", () => {
            this.state.autoOut = !this.state.autoOut;
            this.updateToolbarUI();
            this.saveSchedule();
        });

        this.undoBtn.addEventListener("click", () => this.undo());
        this.redoBtn.addEventListener("click", () => this.redo());
        this.clearBtn.addEventListener("click", () => this.clearCanvas());
        this.outBtn.addEventListener("click", () => this.doOutput());
        this.mergeBtn.addEventListener("click", () => this.mergeLayers());
        this.addLayerBtn.addEventListener("click", () => this.addPaintLayer());
        this.delLayerBtn.addEventListener("click", async () => {
            if (!this.state.selection.size) return;
            const n = this.state.selection.size;
            if (!(await this.confirmDialog(`删除所选 ${n} 个图层？删除后可通过撤销恢复。`))) return;
            this.deleteSelection();
        });
        this.zoomBadge.addEventListener("click", () => this.fitView());

        // 右键菜单容器
        this.menu = el("div", "wp-cv-menu");
        this.root.appendChild(this.menu);
        // 取色器容器
        this.picker = el("div", "wp-cv-picker");
        this.root.appendChild(this.picker);

        this._docMenuCloser = (e) => {
            if (!this.menu.contains(e.target) && !this.viewEl.contains(e.target)) this.closeMenu();
            if (this.picker.style.display === "block" && !this.picker.contains(e.target) && !this._pickerAnchor?.contains?.(e.target)) this.closeColorPicker();
        };
        document.addEventListener("pointerdown", this._docMenuCloser, true);
    }

    // ── 画布区事件 ──
    bindViewEvents() {
        const v = this.viewEl;

        v.addEventListener("contextmenu", (e) => {
            if (e.target !== this.display) { e.stopPropagation(); return; }
            e.preventDefault(); e.stopPropagation();
            this.onContextMenu(e);
        });

        v.addEventListener("wheel", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!(e.ctrlKey || e.metaKey)) return;
            const [sx, sy] = this.eventPos(e);
            this.zoomAt(sx, sy, e.deltaY < 0 ? 1.12 : 1 / 1.12);
        }, { passive: false });

        v.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        v.addEventListener("pointermove", (e) => this.onPointerMove(e));
        v.addEventListener("pointerup", (e) => this.onPointerUp(e));
        v.addEventListener("pointercancel", (e) => this.onPointerUp(e));

        // 笔刷/橡皮：跟踪悬停位置绘制预览圈
        v.addEventListener("pointermove", (e) => {
            this._hover = this.eventPos(e);
            if (this.state.tool === "brush" || this.state.tool === "eraser") this.requestRender();
        });
        v.addEventListener("pointerleave", () => {
            if (this._hover) { this._hover = null; this.requestRender(); }
        });

        v.addEventListener("dblclick", (e) => {
            if (e.target !== this.display) return;
            e.preventDefault(); e.stopPropagation();
            if (this.state.tool !== "select" && this.state.tool !== "text") return;
            const [sx, sy] = this.eventPos(e);
            const [cx, cy] = this.toCanvas(sx, sy);
            const hit = this.hitTest(cx, cy);
            if (hit && hit.type === "text") {
                this.setSelection([hit.id]);
                this.startEdit(hit, false);
            }
        });
    }

    // ── 文字编辑浮层 ──
    bindTextEditor() {
        const ta = this.ta;
        ta.addEventListener("pointerdown", (e) => e.stopPropagation());
        ta.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.commitEdit(true); }
            else if (e.key === "Escape") { e.preventDefault(); this.commitEdit(false); }
        });
        ta.addEventListener("input", () => {
            if (!this.editing) return;
            this.editing.text = ta.value;
            this.invalidateText(this.editing);
            this.positionTA();
            this.requestRender();
        });
        ta.addEventListener("blur", () => { if (this.editing) this.commitEdit(true); });
    }

    // ── 画布初始化 ──
    initCanvases(W, H) {
        this.state.W = W; this.state.H = H;
        this.ensureStroke(W, H);
        for (const it of this.state.stack) {
            if (it.type !== "paint") continue;
            const cv = document.createElement("canvas");
            cv.width = W; cv.height = H;
            it._cv = cv;
            it._ctx = cv.getContext("2d", { willReadFrequently: true });
            it._dirty = false;
            it._rev = this._revSeq++; // 新空白画布：像素已变，作废旧快照缓存
        }
        if (!this.pScratch) this.pScratch = document.createElement("canvas");
        this.pScratch.width = W; this.pScratch.height = H;
    }

    // 笔迹层像素快照（不可变）：版本号未变时跨历史条目共享同一份画布，避免整栈拷贝撑爆内存
    snapCanvasOf(layer) {
        let rec = this._snapCache.get(layer.id);
        if (!rec || rec.rev !== layer._rev || rec.cv.width !== this.state.W || rec.cv.height !== this.state.H) {
            const c = document.createElement("canvas");
            c.width = this.state.W; c.height = this.state.H;
            c.getContext("2d").drawImage(layer._cv, 0, 0);
            rec = { rev: layer._rev, cv: c };
            this._snapCache.set(layer.id, rec);
        }
        return rec.cv;
    }

    ensureStroke(W, H) {
        if (!this.stroke) this.stroke = document.createElement("canvas");
        if (this.stroke.width !== W || this.stroke.height !== H) {
            this.stroke.width = W; this.stroke.height = H;
        }
        this.sctx = this.stroke.getContext("2d");
    }

    // ── 图层栈辅助 ──
    paintOf(id) { return this.state.stack.find((it) => it.type === "paint" && it.id === id) || null; }

    topmostPaint() {
        for (let i = this.state.stack.length - 1; i >= 0; i--) {
            const it = this.state.stack[i];
            if (it.type === "paint" && it.visible !== false) return it;
        }
        for (let i = this.state.stack.length - 1; i >= 0; i--) {
            if (this.state.stack[i].type === "paint") return this.state.stack[i];
        }
        return null;
    }

    activePaint() { return this.paintOf(this.state.activeId) || this.topmostPaint(); }

    selectedPaints() { return this.state.stack.filter((it) => it.type === "paint" && this.state.selection.has(it.id)); }

    setActive(id) {
        if (!this.paintOf(id)) return;
        this.state.activeId = id;
        this.saveSchedule();
        this.refreshLayers();
    }

    // 新建空白笔迹图层：名称取最小未占用的「图层N」
    newPaintLayer() {
        const names = new Set(this.state.stack.filter((it) => it.type === "paint").map((it) => it.name));
        let n = 1;
        while (names.has("图层" + n)) n++;
        const layer = { id: "L" + this.layerSeq++, type: "paint", name: "图层" + n, visible: true, _dirty: false };
        const cv = document.createElement("canvas");
        cv.width = this.state.W; cv.height = this.state.H;
        layer._cv = cv;
        layer._ctx = cv.getContext("2d", { willReadFrequently: true });
        return layer;
    }

    // 删除后自动选中相邻行：面板序 = stack 倒序，取第一个选中行的下一行，无则上一行
    neighborRowId() {
        const rows = [...this.state.stack].reverse();
        const del = new Set(this.state.selection);
        const idx = rows.findIndex((it) => del.has(it.id));
        if (idx < 0) return null;
        for (let j = idx + 1; j < rows.length; j++) if (!del.has(rows[j].id)) return rows[j].id;
        for (let j = idx - 1; j >= 0; j--) if (!del.has(rows[j].id)) return rows[j].id;
        return null;
    }

    addPaintLayer() {
        const before = this.fullSnapshot();
        const layer = this.newPaintLayer();
        this.state.stack.push(layer);
        this.state.activeId = layer.id;
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.setSelection([layer.id]);
        this.markEdited();
        this.requestRender();
        this.setStatus(`已新增图层「${layer.name}」（当前绘画目标）`);
    }

    resizeDisplay() {
        const vw = this.viewEl.clientWidth, vh = this.viewEl.clientHeight;
        if (!vw || !vh) return;
        this.dpr = Math.max(1, window.devicePixelRatio || 1);
        this.display.width = Math.round(vw * this.dpr);
        this.display.height = Math.round(vh * this.dpr);
        this.requestRender();
    }

    // ── 视图 ──
    fitView() {
        const vw = this.viewEl.clientWidth, vh = this.viewEl.clientHeight;
        if (!vw || !vh) return;
        const z = clamp(Math.min((vw - 36) / this.state.W, (vh - 36) / this.state.H), MIN_ZOOM, MAX_ZOOM);
        this.view.zoom = z;
        this.view.x = (vw - this.state.W * z) / 2;
        this.view.y = (vh - this.state.H * z) / 2;
        this.requestRender();
    }
    zoomAt(sx, sy, f) {
        const nz = clamp(this.view.zoom * f, MIN_ZOOM, MAX_ZOOM);
        const [cx, cy] = this.toCanvas(sx, sy);
        this.view.zoom = nz;
        this.view.x = sx - cx * nz;
        this.view.y = sy - cy * nz;
        this.requestRender();
    }
    toCanvas(sx, sy) { return [(sx - this.view.x) / this.view.zoom, (sy - this.view.y) / this.view.zoom]; }
    toScreen(cx, cy) { return [this.view.x + cx * this.view.zoom, this.view.y + cy * this.view.zoom]; }
    eventPos(e) {
        const r = this.viewEl.getBoundingClientRect();
        // 视觉坐标 → 布局坐标：ComfyUI 画布缩放时 DOM 容器被 CSS transform 缩放，
        // getBoundingClientRect 得到的是缩放后的视觉尺寸，需归一到布局域（canvas 渲染域）
        const kx = r.width > 0 ? this.viewEl.clientWidth / r.width : 1;
        const ky = r.height > 0 ? this.viewEl.clientHeight / r.height : 1;
        return [(e.clientX - r.left) * kx, (e.clientY - r.top) * ky];
    }

    // ── 渲染 ──
    requestRender() {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => { this._raf = 0; try { this.render(); } catch (err) { console.error("[WP_Canvas] 渲染错误", err); } });
    }

    render() {
        this.refreshLayers();
        const ctx = this.dctx;
        const vw = this.display.width / this.dpr, vh = this.display.height / this.dpr;
        if (!vw || !vh) return;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, vw, vh);
        const z = this.view.zoom;
        const sx = this.view.x, sy = this.view.y;
        const sw = this.state.W * z, sh = this.state.H * z;

        // 画布区域：背景 + 统一图层栈（画布坐标系；橡皮预览经 pScratch 合成）
        ctx.save();
        ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
        if (this.state.bgTransparent) this.drawChecker(ctx, sx, sy, sw, sh);
        else { ctx.fillStyle = this.state.bgColor; ctx.fillRect(sx, sy, sw, sh); }
        ctx.translate(sx, sy); ctx.scale(z, z);
        const strokeDrag = this.drag && this.drag.mode === "stroke";
        for (const it of this.state.stack) {
            if (it === this.editing || it.visible === false) continue;
            if (it.type === "paint") {
                const isActive = strokeDrag && it.id === this.drag.layerId;
                if (isActive && this.drag.erase) {
                    // 橡皮实时预览：pScratch = 层像素 − 笔触（不改动层本身）
                    const sc = this.pScratch.getContext("2d");
                    sc.clearRect(0, 0, this.state.W, this.state.H);
                    sc.drawImage(it._cv, 0, 0);
                    sc.globalCompositeOperation = "destination-out";
                    sc.globalAlpha = this.drag.opacity;
                    sc.drawImage(this.stroke, 0, 0);
                    sc.globalCompositeOperation = "source-over";
                    sc.globalAlpha = 1;
                    ctx.drawImage(this.pScratch, 0, 0);
                } else {
                    ctx.drawImage(it._cv, 0, 0);
                    if (isActive) {
                        ctx.globalAlpha = this.drag.opacity;
                        ctx.drawImage(this.stroke, 0, 0);
                        ctx.globalAlpha = 1;
                    }
                }
            } else {
                this.drawVector(ctx, it);
            }
        }
        if (this.previewObj) this.drawVector(ctx, this.previewObj);
        ctx.restore();

        if (this.state.grid) this.drawGrid(ctx, sx, sy, sw, sh);

        // 画布边界
        ctx.strokeStyle = "rgba(150,150,150,.8)";
        ctx.lineWidth = 1;
        ctx.strokeRect(sx - 0.5, sy - 0.5, sw + 1, sh + 1);

        // 绘画/橡皮工具下隐藏选中框（保持画布干净，选中状态见图层面板高亮）
        if (this.state.selection.size && this.state.tool !== "brush" && this.state.tool !== "eraser") this.drawSelection(ctx);
        if (this.drag && this.drag.mode === "marquee") this.drawMarquee(ctx);
        if (this.drag && this.drag.mode === "cut") this.drawCutPath(ctx, this.drag.pts, false);
        else if (this._cutPts) this.drawCutPath(ctx, this._cutPts, true);
        this.drawFlash(ctx);
        this.drawBrushCursor(ctx);
        this.zoomBadge.textContent = Math.round(z * 100) + "%";
        this.updateFloatBar();
    }

    // 悬浮工具条：跟随选中框上方中间；绘画/橡皮与文字编辑时隐藏
    updateFloatBar() {
        const bar = this.floatBar;
        if (!bar) return;
        const s = this.state;
        const show = s.selection.size > 0 && s.tool !== "brush" && s.tool !== "eraser" && !this.editing;
        if (!show) { bar.style.display = "none"; return; }
        const a = this.selAABB();
        const [sx, sy] = this.toScreen(a.x, a.y);
        bar.style.display = "flex";
        bar.style.left = (sx + a.w * this.view.zoom / 2) + "px";
        if (sy > 52) { bar.style.top = (sy - 8) + "px"; bar.style.transform = "translate(-50%,-100%)"; }
        else { bar.style.top = (sy + 8) + "px"; bar.style.transform = "translate(-50%,0)"; } // 贴顶时放进框内
    }

    // 笔刷/橡皮大小预览圈（黑白双圈，任何背景可见；橡皮为虚线）
    drawBrushCursor(ctx) {
        if (!this._hover) return;
        const t = this.state.tool;
        if ((t !== "brush" && t !== "eraser") || this.spaceHeld) return;
        const p = t === "brush" ? this.state.brush : this.state.eraser;
        const r = Math.max(2, (p.size / 2) * this.view.zoom);
        const [hx, hy] = this._hover;
        ctx.save();
        ctx.lineWidth = 1;
        if (t === "eraser") ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(0,0,0,.85)";
        ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.beginPath(); ctx.arc(hx, hy, r - 1, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
    }

    drawChecker(ctx, x, y, w, h) {
        if (!this._checkerPat) {
            const p = document.createElement("canvas");
            p.width = p.height = 16;
            const pc = p.getContext("2d");
            pc.fillStyle = "#ffffff"; pc.fillRect(0, 0, 16, 16);
            pc.fillStyle = "#c8c8c8"; pc.fillRect(0, 0, 8, 8); pc.fillRect(8, 8, 8, 8);
            this._checkerPat = ctx.createPattern(p, "repeat");
        }
        ctx.fillStyle = this._checkerPat;
        ctx.fillRect(x, y, w, h);
    }

    drawGrid(ctx, x, y, w, h) {
        const z = this.view.zoom;
        let step = 256;
        for (const c of [4, 8, 16, 32, 64, 128, 256]) { if (c * z >= 14) { step = c; break; } }
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        ctx.strokeStyle = "rgba(128,128,128,.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let gx = 0; gx <= this.state.W; gx += step) {
            const X = Math.round(this.view.x + gx * z) + 0.5;
            ctx.moveTo(X, y); ctx.lineTo(X, y + h);
        }
        for (let gy = 0; gy <= this.state.H; gy += step) {
            const Y = Math.round(this.view.y + gy * z) + 0.5;
            ctx.moveTo(x, Y); ctx.lineTo(x + w, Y);
        }
        ctx.stroke();
        ctx.restore();
    }

    // ── 矢量绘制与测量 ──
    fontStr(f) { return `${f.italic ? "italic " : ""}${f.bold ? "700 " : "400 "}${f.size}px ${f.family}`; }

    invalidateText(o) { o._mw = null; }

    textMetrics(o) {
        const key = this.fontStr(o.font) + "|" + o.text;
        if (o._mw != null && o._mkey === key) return { w: o._mw, h: o._mh };
        this.measCtx.font = this.fontStr(o.font);
        let w = 1;
        const lines = String(o.text || "").split("\n");
        for (const ln of lines) w = Math.max(w, this.measCtx.measureText(ln).width);
        o._mw = w; o._mh = lines.length * o.font.size * 1.25; o._mkey = key;
        return { w: o._mw, h: o._mh };
    }

    objBBox(o) {
        if (o.type === "text") { const m = this.textMetrics(o); return { x: o.x, y: o.y, w: m.w, h: m.h }; }
        return { x: o.x, y: o.y, w: o.w, h: o.h };
    }

    objCorners(o) {
        const b = this.objBBox(o);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
        if (!o.rot) return pts;
        const a = o.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        return pts.map(([px, py]) => {
            const dx = px - cx, dy = py - cy;
            return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
        });
    }

    drawVector(ctx, o) {
        ctx.save();
        const b = this.objBBox(o);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        // 镜像（绕对象中心翻转，先翻转再旋转，与 Photoshop 变换一致）
        if (o.flipX || o.flipY) { ctx.translate(cx, cy); ctx.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1); ctx.translate(-cx, -cy); }
        if (o.rot) { ctx.translate(cx, cy); ctx.rotate(o.rot * Math.PI / 180); ctx.translate(-cx, -cy); }
        if (o.type === "text") {
            ctx.font = this.fontStr(o.font);
            ctx.fillStyle = o.font.color;
            ctx.textBaseline = "top";
            const lines = String(o.text || "").split("\n");
            const lh = o.font.size * 1.25;
            lines.forEach((ln, i) => ctx.fillText(ln, o.x, o.y + i * lh));
        } else if (o.type === "image") {
            if (!o._cv) {
                // 解码中：显示占位虚线框
                ctx.strokeStyle = "rgba(128,128,128,.8)";
                ctx.lineWidth = Math.max(1, 2 / this.view.zoom);
                ctx.setLineDash([6, 4]);
                ctx.strokeRect(o.x, o.y, o.w, o.h);
                ctx.setLineDash([]);
            } else {
                const d = this.drag;
                let src = o._cv;
                // 橡皮实时预览（与最终擦除规则一致：仅被选中的图片）
                if (d && d.mode === "stroke" && d.erase && this.state.selection.has(o.id) && this.strokeIntersectsImg(d, o, Math.ceil(d.size / 2) + 2)) {
                    src = this.imgErasePreview(o);
                }
                ctx.drawImage(src, o.x, o.y, o.w, o.h);
            }
        } else {
            ctx.beginPath();
            if (o.type === "rect") ctx.rect(o.x, o.y, o.w, o.h);
            else if (o.type === "ellipse") ctx.ellipse(cx, cy, Math.max(o.w / 2, 0.1), Math.max(o.h / 2, 0.1), 0, 0, Math.PI * 2);
            else if (o.type === "triangle") {
                ctx.moveTo(o.x + o.w / 2, o.y);
                ctx.lineTo(o.x + o.w, o.y + o.h);
                ctx.lineTo(o.x, o.y + o.h);
                ctx.closePath();
            }
            if (o.fill && o.fill.on) { ctx.fillStyle = o.fill.color; ctx.fill(); }
            if (o.stroke && o.stroke.on) { ctx.strokeStyle = o.stroke.color; ctx.lineWidth = o.stroke.w; ctx.lineJoin = "round"; ctx.stroke(); }
        }
        ctx.restore();
    }

    // ── 选中框 ──
    selAABB() {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        // 笔迹层：取非空像素内容包围盒（空层不贡献边界）
        for (const l of this.selectedPaints()) {
            const b = this.bitmapInkBBox(l);
            if (!b) continue;
            x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
            x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
        }
        for (const o of this.selected()) {
            for (const [px, py] of this.objCorners(o)) {
                x0 = Math.min(x0, px); y0 = Math.min(y0, py);
                x1 = Math.max(x1, px); y1 = Math.max(y1, py);
            }
        }
        if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    selected() { return this.state.stack.filter((o) => o.type !== "paint" && this.state.selection.has(o.id)); }

    selHandles() {
        const a = this.selAABB();
        const [sx, sy] = this.toScreen(a.x, a.y);
        const sw = a.w * this.view.zoom, sh = a.h * this.view.zoom;
        const l = sx, t = sy, r = sx + sw, b = sy + sh, mx = (l + r) / 2, my = (t + b) / 2;
        return [
            { x: l, y: t, cur: "nwse-resize" }, { x: mx, y: t, cur: "ns-resize" }, { x: r, y: t, cur: "nesw-resize" },
            { x: l, y: my, cur: "ew-resize" }, { x: r, y: my, cur: "ew-resize" },
            { x: l, y: b, cur: "nesw-resize" }, { x: mx, y: b, cur: "ns-resize" }, { x: r, y: b, cur: "nwse-resize" },
        ];
    }

    rotHandles() {
        const a = this.selAABB();
        const [cx, cy] = this.toScreen(a.x + a.w / 2, a.y + a.h / 2);
        const pts = this.selHandles();
        const out = [];
        for (const i of [0, 2, 5, 7]) {
            const p = pts[i];
            const dx = p.x - cx, dy = p.y - cy;
            const len = Math.hypot(dx, dy) || 1;
            out.push({ x: p.x + dx / len * 22, y: p.y + dy / len * 22 });
        }
        return out;
    }

    drawSelection(ctx) {
        const a = this.selAABB();
        const [sx, sy] = this.toScreen(a.x, a.y);
        const sw = a.w * this.view.zoom, sh = a.h * this.view.zoom;
        ctx.save();
        ctx.strokeStyle = PURPLE_L;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.setLineDash([]);
        const hs = this.selHandles();
        if (hs.length) {
            // 旋转点连线（空选中时 rh 为空则跳过）
            const rh = this.rotHandles();
            if (rh.length) {
                ctx.strokeStyle = "rgba(143,107,255,.6)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                [0, 2, 5, 7].forEach((i, k) => { ctx.moveTo(hs[i].x, hs[i].y); ctx.lineTo(rh[k].x, rh[k].y); });
                ctx.stroke();
            }
            // 8 个缩放点
            ctx.fillStyle = "#fff";
            ctx.strokeStyle = PURPLE_L;
            ctx.lineWidth = 1.4;
            for (const p of hs) { ctx.beginPath(); ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7); ctx.fill(); ctx.stroke(); }
            // 4 个旋转点
            ctx.fillStyle = PURPLE_L;
            for (const p of rh) { ctx.beginPath(); ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2); ctx.fill(); }
        }
        const selPs = this.selectedPaints();
        if (selPs.length) {
            const label = selPs.map((l) => l.name).join("、");
            ctx.fillStyle = PURPLE_L;
            ctx.font = "11px sans-serif";
            ctx.fillText(label.length > 14 ? label.slice(0, 14) + "…" : label, sx + 4, sy > 16 ? sy - 5 : sy + 14);
        }
        ctx.restore();
    }

    drawMarquee(ctx) {
        const d = this.drag;
        const [x0, y0] = this.toScreen(d.startX, d.startY);
        const [x1, y1] = this.toScreen(d.curX, d.curY);
        ctx.save();
        ctx.fillStyle = "rgba(143,107,255,.12)";
        ctx.strokeStyle = PURPLE_L;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }

    // ── 分割工具：圈选绘制 ──
    drawCutPath(ctx, pts, closed) {
        if (!pts || pts.length < 2) return;
        ctx.save();
        ctx.beginPath();
        const [sx0, sy0] = this.toScreen(pts[0].x, pts[0].y);
        ctx.moveTo(sx0, sy0);
        for (let i = 1; i < pts.length; i++) {
            const [px, py] = this.toScreen(pts[i].x, pts[i].y);
            ctx.lineTo(px, py);
        }
        if (closed) {
            ctx.closePath();
            ctx.fillStyle = "rgba(143,107,255,.12)";
            ctx.fill("evenodd"); // 自交叉圈选按套索规则：奇偶填充
            ctx.setLineDash([6, 4]);
            ctx.lineDashOffset = -(this._antsOff || 0); // 蚂蚁线流动相位
            ctx.strokeStyle = PURPLE_L;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        } else {
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = PURPLE_L;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // 虚线预示闭合边
            ctx.beginPath();
            const [lx, ly] = this.toScreen(pts[pts.length - 1].x, pts[pts.length - 1].y);
            ctx.moveTo(lx, ly);
            ctx.lineTo(sx0, sy0);
            ctx.setLineDash([3, 5]);
            ctx.globalAlpha = 0.5;
            ctx.stroke();
            ctx.globalAlpha = 1;
            // 起点 marker（白圆紫边）
            ctx.beginPath();
            ctx.arc(sx0, sy0, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = PURPLE_L;
            ctx.stroke();
        }
        ctx.restore();
    }

    startAnts() {
        if (this._antsRaf || this.destroyed) return;
        const tick = () => {
            this._antsRaf = 0;
            if (this.destroyed || !this._cutPts) return;
            this._antsOff = (performance.now() / 40) % 20;
            this.requestRender();
            this._antsRaf = requestAnimationFrame(tick);
        };
        this._antsRaf = requestAnimationFrame(tick);
    }

    stopAnts() {
        if (this._antsRaf) { cancelAnimationFrame(this._antsRaf); this._antsRaf = 0; }
    }

    clearCutSel() {
        this._cutPts = null;
        this.stopAnts();
        this.buildParams();
        this.requestRender();
    }

    // ── 分割工具：新对象高亮闪烁 ──
    flashNew(ids) {
        this._flash = { ids: new Set(ids), t0: performance.now() };
        if (this._flashRaf || this.destroyed) return;
        const tick = () => {
            this._flashRaf = 0;
            if (this.destroyed || !this._flash) return;
            this.requestRender();
            if ((performance.now() - this._flash.t0) / 900 < 1) this._flashRaf = requestAnimationFrame(tick);
            else { this._flash = null; this.requestRender(); }
        };
        this._flashRaf = requestAnimationFrame(tick);
    }

    drawFlash(ctx) {
        const f = this._flash;
        if (!f) return;
        const t = (performance.now() - f.t0) / 900;
        if (t >= 1) { this._flash = null; return; }
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.75 * (1 - t);
        ctx.strokeStyle = PURPLE_L;
        ctx.lineWidth = 2.5;
        for (const o of this.state.stack) {
            if (!f.ids.has(o.id) || o.visible === false) continue;
            let corners;
            if (o.type === "paint") {
                const bb = this.bitmapInkBBox(o);
                if (!bb) continue;
                corners = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]];
            } else {
                corners = this.objCorners(o);
            }
            ctx.beginPath();
            corners.forEach(([px, py], i) => {
                const [sx, sy] = this.toScreen(px, py);
                if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
            });
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    }

    // ── 分割工具：蒙版与几何 ──
    cutMaskCanvas() {
        const cv = document.createElement("canvas");
        cv.width = this.state.W; cv.height = this.state.H;
        const c = cv.getContext("2d");
        const pts = this._cutPts;
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.closePath();
        c.fillStyle = "#fff";
        c.fill("evenodd");
        return cv;
    }

    cutPathBBox() {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of this._cutPts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        const bx = clamp(Math.floor(x0), 0, this.state.W), by = clamp(Math.floor(y0), 0, this.state.H);
        const ex = clamp(Math.ceil(x1), 0, this.state.W), ey = clamp(Math.ceil(y1), 0, this.state.H);
        return { x: bx, y: by, w: ex - bx, h: ey - by };
    }

    alphaBBoxOf(cv) {
        const W = cv.width, H = cv.height;
        const d = cv.getContext("2d").getImageData(0, 0, W, H).data;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let y = 0; y < H; y++) {
            const base = y * W * 4;
            for (let x = 0; x < W; x++) {
                if (d[base + x * 4 + 3] > 0) {
                    if (x < x0) x0 = x;
                    if (x > x1) x1 = x;
                    if (y < y0) y0 = y;
                    if (y > y1) y1 = y;
                }
            }
        }
        return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
    }

    // 分割目标：恰好选中一张可见图片 → 该图片；否则当前绘画笔迹层（隐藏时回落最顶笔迹层）
    cutTarget() {
        const sel = this.selected();
        if (sel.length === 1 && sel[0].type === "image" && sel[0].visible !== false) return sel[0];
        let tgt = this.paintOf(this.state.activeId);
        if (!tgt || tgt.visible === false) tgt = this.topmostPaint();
        return tgt;
    }

    doCutSplit() {
        if (!this._cutPts) { this.setStatus("请先在画布上圈选区域（松开鼠标自动闭合）"); return; }
        const tgt = this.cutTarget();
        if (!tgt) { this.setStatus("没有可分割的图层"); return; }
        if (tgt.type === "image") {
            if (!tgt._cv) { this.setStatus("图片正在解码，请稍后再拆分"); return; }
            this.splitImage(tgt);
        } else {
            this.splitPaint(tgt);
        }
    }

    uniqueSplitName(base) {
        const names = new Set(this.state.stack.filter((it) => it.type === "paint").map((it) => it.name));
        let n = `${base}·分割`, k = 2;
        while (names.has(n)) n = `${base}·分割${k++}`;
        return n;
    }

    // 笔迹层拆分：选区内容 → 新笔迹层（紧邻原层上方）；原层挖洞
    splitPaint(layer) {
        const bb = this.cutPathBBox();
        if (bb.w < 1 || bb.h < 1) { this.setStatus("选区完全在画布外，无法拆分"); return; }
        const mask = this.cutMaskCanvas();
        // 选区 ∩ 图层内容的包围盒（只扫选区包围盒，不全图扫描）
        const ld = layer._ctx.getImageData(bb.x, bb.y, bb.w, bb.h);
        const md = mask.getContext("2d").getImageData(bb.x, bb.y, bb.w, bb.h);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let y = 0; y < bb.h; y++) {
            for (let x = 0; x < bb.w; x++) {
                const i = (y * bb.w + x) * 4 + 3;
                if (ld.data[i] > 0 && md.data[i] > 0) {
                    const px = bb.x + x, py = bb.y + y;
                    if (px < x0) x0 = px;
                    if (px > x1) x1 = px;
                    if (py < y0) y0 = py;
                    if (py > y1) y1 = py;
                }
            }
        }
        if (!isFinite(x0)) { this.setStatus("选区内没有图层内容，无法拆分"); return; }
        const before = this.fullSnapshot();
        // 新层 = 原层内容 ∩ 蒙版：先画原内容，再用蒙版做 destination-in 裁剪
        // （顺序不能反：destination-in 保留的是目标已有像素，先画蒙版会把白色蒙版当成内容）
        const nl = this.newPaintLayer();
        nl.name = this.uniqueSplitName(layer.name);
        nl._ctx.drawImage(layer._cv, 0, 0);
        nl._ctx.globalCompositeOperation = "destination-in";
        nl._ctx.drawImage(mask, 0, 0);
        nl._ctx.globalCompositeOperation = "source-over";
        // 原层挖洞
        layer._ctx.save();
        layer._ctx.globalCompositeOperation = "destination-out";
        layer._ctx.drawImage(mask, 0, 0);
        layer._ctx.restore();
        nl._dirty = true; nl._rev = this._revSeq++;
        layer._dirty = true; layer._rev = this._revSeq++;
        this.state.stack.splice(this.state.stack.indexOf(layer) + 1, 0, nl);
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.finishSplit(nl.id, `已拆分「${layer.name}」为新图层「${nl.name}」（可撤销）`);
    }

    // 图片素材拆分：选区像素 → 新图片素材（含旋转/镜像几何）；原图挖洞
    splitImage(o) {
        const iw = o._cv.width, ih = o._cv.height;
        const sx = o.w / iw, sy = o.h / ih;
        const ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
        // 1) 蒙版映射到原图局部坐标（缩放 + 逆旋转，不含镜像：提取结果为原图方向）
        const local = document.createElement("canvas");
        local.width = iw; local.height = ih;
        const lc = local.getContext("2d");
        lc.setTransform(iw / o.w, 0, 0, ih / o.h, -o.x * iw / o.w, -o.y * ih / o.h);
        lc.translate(ocx, ocy);
        lc.rotate(-(o.rot || 0) * Math.PI / 180);
        lc.translate(-ocx, -ocy);
        lc.drawImage(this.cutMaskCanvas(), 0, 0);
        lc.setTransform(1, 0, 0, 1, 0, 0);
        // 2) 提取选区像素：先画原图，再用蒙版 destination-in 裁剪（顺序反了会得到白色蒙版）
        const ex = document.createElement("canvas");
        ex.width = iw; ex.height = ih;
        const ec = ex.getContext("2d");
        ec.drawImage(o._cv, 0, 0);
        ec.globalCompositeOperation = "destination-in";
        ec.drawImage(local, 0, 0);
        ec.globalCompositeOperation = "source-over";
        // 3) 烘焙镜像：翻转提取画布，让碎片与显示方向一致（新素材无需 flip 标记，几何计算统一）
        let pieceCv = ex;
        if (o.flipX || o.flipY) {
            pieceCv = document.createElement("canvas");
            pieceCv.width = iw; pieceCv.height = ih;
            const pc = pieceCv.getContext("2d");
            pc.translate(o.flipX ? iw : 0, o.flipY ? ih : 0);
            pc.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
            pc.drawImage(ex, 0, 0);
        }
        const bb = this.alphaBBoxOf(pieceCv);
        if (!bb) { this.setStatus("选区内没有图片内容，无法拆分"); return; }
        // 4) 裁剪碎片画布到内容包围盒：否则整图（含大片透明）压进碎片小框，内容会被极度缩小变形
        const frag = document.createElement("canvas");
        frag.width = bb.w; frag.height = bb.h;
        frag.getContext("2d").drawImage(pieceCv, -bb.x, -bb.y);
        // 5) 碎片对象：局部包围盒 → 画布位置（绕原图中心旋转 o.rot）
        let ncx = o.x + (bb.x + bb.w / 2) * sx, ncy = o.y + (bb.y + bb.h / 2) * sy;
        if (o.rot) {
            const a = o.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
            const dx = ncx - ocx, dy = ncy - ocy;
            ncx = ocx + dx * cos - dy * sin;
            ncy = ocy + dx * sin + dy * cos;
        }
        const pw = bb.w * sx, ph = bb.h * sy;
        const src = canvasDataURL(frag);
        const piece = { id: this.nextId(), type: "image", x: ncx - pw / 2, y: ncy - ph / 2, w: pw, h: ph, rot: o.rot || 0, src, name: (o.name || "素材") + "·分割" };
        IMG_CACHE.set(src, frag);
        piece._cv = frag;
        // 5) 原图挖洞 + src 同步
        const before = this.fullSnapshot();
        const oc = o._cv.getContext("2d");
        oc.save();
        oc.globalCompositeOperation = "destination-out";
        oc.drawImage(local, 0, 0);
        oc.restore();
        o.src = canvasDataURL(o._cv);
        IMG_CACHE.set(o.src, o._cv);
        this.state.stack.splice(this.state.stack.indexOf(o) + 1, 0, piece);
        this.rebuildAssets();
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.finishSplit(piece.id, `已拆分图片「${o.name || "素材"}」为独立新素材（可撤销）`);
    }

    finishSplit(newId, msg) {
        this._cutPts = null;
        this.stopAnts();
        this.setTool("select");
        this.setSelection([newId]);
        if (this.paintOf(newId)) this.state.activeId = newId;
        this.markEdited();
        this.flashNew([newId]);
        this.requestRender();
        this.setStatus(msg);
    }

    // ── 命中检测 ──
    // PS 行为：点击位置同时命中多个对象时，优先归属当前已选中的对象（选中项不被上层外框抢走，拖动/复制/右键稳定作用于选中项）
    hitTest(cx, cy) {
        return this.hitTestIn(cx, cy, true) || this.hitTestIn(cx, cy, false);
    }
    hitTestIn(cx, cy, selectedOnly) {
        const arr = this.state.stack;
        for (let i = arr.length - 1; i >= 0; i--) {
            const o = arr[i];
            if (o.visible === false) continue;
            if (this.state.selection.has(o.id) !== selectedOnly) continue;
            if (o.type === "paint") {
                // 笔迹层：按像素 alpha 命中
                const x = Math.floor(cx), y = Math.floor(cy);
                if (x < 0 || y < 0 || x >= this.state.W || y >= this.state.H) continue;
                try {
                    if (o._ctx.getImageData(x, y, 1, 1).data[3] > 10) return o;
                } catch (err) {}
                continue;
            }
            const b = this.objBBox(o);
            const ox = b.x + b.w / 2, oy = b.y + b.h / 2;
            let dx = cx - ox, dy = cy - oy;
            if (o.rot) {
                const a = -o.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
                const nx = dx * cos - dy * sin, ny = dx * sin + dy * cos;
                dx = nx; dy = ny;
            }
            // 镜像对象的本地坐标反变换（渲染时先翻转再旋转，逆序先反旋转再反翻转）
            if (o.flipX) dx = -dx;
            if (o.flipY) dy = -dy;
            const lx = ox + dx, ly = oy + dy;
            const pad = 2;
            if (lx < b.x - pad || lx > b.x + b.w + pad || ly < b.y - pad || ly > b.y + b.h + pad) continue;
            if (o.type === "ellipse") {
                const rx = b.w / 2 || 1, ry = b.h / 2 || 1;
                if (((lx - ox) / rx) ** 2 + ((ly - oy) / ry) ** 2 <= 1.15) return o;
                continue;
            }
            if (o.type === "triangle") {
                const ax = b.x + b.w / 2, ay = b.y, bx2 = b.x + b.w, by2 = b.y + b.h, cx2 = b.x, cy2 = b.y + b.h;
                const s1 = (bx2 - ax) * (ly - ay) - (by2 - ay) * (lx - ax);
                const s2 = (cx2 - bx2) * (ly - by2) - (cy2 - by2) * (lx - bx2);
                const s3 = (ax - cx2) * (ly - cy2) - (ay - cy2) * (lx - cx2);
                if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return o;
                continue;
            }
            return o; // rect / text
        }
        return null;
    }

    hitHandle(sx, sy) {
        if (!this.state.selection.size) return null;
        for (const p of this.rotHandles()) {
            if (Math.hypot(sx - p.x, sy - p.y) <= 10) return { kind: "rot" };
        }
        const hs = this.selHandles();
        for (let i = 0; i < hs.length; i++) {
            if (Math.abs(sx - hs[i].x) <= 8 && Math.abs(sy - hs[i].y) <= 8) return { kind: "scale", idx: i };
        }
        return null;
    }

    // ── 指针交互 ──
    onPointerDown(e) {
        if (this._busy) return;
        e.stopPropagation();
        // 仅响应画布本体；缩放徽章/确认浮层等不触发绘图工具
        if (e.target !== this.display) return;
        // preventDefault 会阻止 textarea 失焦，需手动提交文字编辑
        if (this.editing) this.commitEdit(true);
        const [sx, sy] = this.eventPos(e);
        const [cx, cy] = this.toCanvas(sx, sy);

        if (e.button === 1 || this.spaceHeld) {
            this.beginDrag({ mode: "pan", sx, sy, ox: this.view.x, oy: this.view.y });
            this.capture(e); this.updateCursor();
            e.preventDefault();
            return;
        }
        if (e.button !== 0) return;
        e.preventDefault();
        this.capture(e);
        const tool = this.state.tool;

        if (tool === "select") {
            const h = this.hitHandle(sx, sy);
            if (h) {
                const vbefore = this.snapshotStack();
                if (h.kind === "rot") this.beginDrag({ mode: "rot", vbefore, center: this.selCenter(), startC: [cx, cy], a0: null, objs: this.selBase(), paints: this.selectedPaints().map((l) => ({ ref: l, base: null })), moved: false });
                else this.beginDrag({ mode: "scale", vbefore, idx: h.idx, startC: [cx, cy], objs: this.selBase(), aabb0: this.selAABB(), alt: e.altKey, paints: this.selectedPaints().map((l) => ({ ref: l, base: null })), moved: false });
                return;
            }
            const hit = this.hitTest(cx, cy);
            if (hit) {
                if (hit.type === "paint") this.setActive(hit.id);
                if (e.shiftKey) {
                    if (this.state.selection.has(hit.id)) this.state.selection.delete(hit.id);
                    else this.state.selection.add(hit.id);
                    this.buildParams();
                    this.requestRender();
                    return;
                }
                if (!this.state.selection.has(hit.id)) this.setSelection([hit.id]);
                const vbefore = this.snapshotStack(); // Alt 复制场景取复制前快照：撤销时一并删除副本
                // Alt+拖动 = 拖拽复制（PS 行为）：克隆选中项，原件留原地，拖动副本
                const dup = !!e.altKey;
                if (dup) this.duplicateSelection();
                this.beginDrag({ mode: "move", vbefore, sx, sy, objs: this.selBase(), paints: this.selectedPaints().map((l) => ({ ref: l, base: null })), moved: false, dup });
                return;
            }
            if (!e.shiftKey) this.state.selection.clear();
            this.buildParams();
            this.beginDrag({ mode: "marquee", startX: cx, startY: cy, curX: cx, curY: cy, add: e.shiftKey, base: new Set(this.state.selection) });
            this.requestRender();
            return;
        }

        if (tool === "brush" || tool === "eraser") {
            // 绘画目标 = 当前笔迹层；被隐藏/丢失时自动落到最顶可见笔迹层
            let tgt = this.paintOf(this.state.activeId);
            if (!tgt || tgt.visible === false) {
                tgt = this.topmostPaint();
                if (tgt) this.setActive(tgt.id);
            }
            if (!tgt) return;
            const p = tool === "brush" ? this.state.brush : this.state.eraser;
            this.beginDrag({
                mode: "stroke", erase: tool === "eraser", layerId: tgt.id,
                size: p.size, hardness: p.hardness, color: p.color || "#000",
                opacity: clamp(p.opacity, 1, 100) / 100,
                last: { x: cx, y: cy }, pts: [{ x: cx, y: cy }],
                bbox: { x0: cx, y0: cy, x1: cx, y1: cy },
            });
            this.stamp(cx, cy);
            this.requestRender();
            return;
        }

        if (tool === "cut") {
            // 新圈选自动替换旧选区
            this._cutPts = null;
            this.stopAnts();
            this.beginDrag({ mode: "cut", pts: [{ x: cx, y: cy }] });
            this.requestRender();
            return;
        }

        if (tool === "rect" || tool === "ellipse" || tool === "triangle") {
            const s = this.state.shape;
            this.previewObj = {
                id: this.nextId(), type: tool, x: cx, y: cy, w: 0, h: 0, rot: 0,
                fill: { on: s.fillOn, color: s.fillColor },
                stroke: { on: s.strokeOn, color: s.strokeColor, w: s.strokeW },
            };
            this.beginDrag({ mode: "shape", startX: cx, startY: cy, shift: e.shiftKey, alt: e.altKey });
            this.requestRender();
            return;
        }

        if (tool === "text") {
            const hit = this.hitTest(cx, cy);
            if (hit && hit.type === "text") { this.setSelection([hit.id]); this.startEdit(hit, false); return; }
            const t = this.state.text;
            const o = { id: this.nextId(), type: "text", x: cx, y: cy, rot: 0, text: "文本", font: { family: t.family, size: t.size, color: t.color, bold: t.bold, italic: t.italic } };
            const before = this.snapshotStack();
            this.state.stack.push(o);
            this.setSelection([o.id]);
            this.startEdit(o, true, before);
        }
    }

    beginDrag(d) { this.drag = d; }
    capture(e) { try { this.viewEl.setPointerCapture(e.pointerId); } catch (err) {} }
    selBase() {
        return this.selected().map((o) => {
            const b = this.objBBox(o);
            return { ref: o, x: b.x, y: b.y, w: b.w, h: b.h, rot: o.rot, fs: o.type === "text" ? o.font.size : null };
        });
    }
    selCenter() { const a = this.selAABB(); return [a.x + a.w / 2, a.y + a.h / 2]; }

    // 拖拽复制（PS 行为）：克隆当前选中项，副本插在原项正上方，选中切换为副本（原件不动）
    duplicateSelection() {
        const stack = this.state.stack;
        const clones = [];
        for (let i = 0; i < stack.length; i++) {
            const it = stack[i];
            if (!this.state.selection.has(it.id)) continue;
            if (it.type === "paint") {
                const cp = this.newPaintLayer();
                cp.name = it.name + " 副本";
                cp._ctx.drawImage(it._cv, 0, 0);
                cp._dirty = true; // 副本携带像素，序列化时需保存
                cp._rev = this._revSeq++;
                clones.push({ at: i + 1, obj: cp });
            } else {
                const cp = cleanClone(it); // 深拷贝可序列化属性（自动剥离 _cv 等运行时字段）
                cp.id = this.nextId();
                if (it.name) cp.name = it.name + " 副本";
                if (it._cv) { // 图片：深拷贝像素画布，与原件互不影响（可独立擦除）
                    const cv = document.createElement("canvas");
                    cv.width = it._cv.width; cv.height = it._cv.height;
                    cv.getContext("2d").drawImage(it._cv, 0, 0);
                    cp._cv = cv;
                }
                if (cp.type === "text") this.invalidateText(cp);
                clones.push({ at: i + 1, obj: cp });
            }
        }
        // 倒序插入：从高索引往低插，避免索引位移
        for (let i = clones.length - 1; i >= 0; i--) stack.splice(clones[i].at, 0, clones[i].obj);
        this.state.selection = new Set(clones.map((c) => c.obj.id));
        this.buildParams();
        this.requestRender();
    }

    // 镜像选中内容（axis: "x" 水平 | "y" 垂直）：绕选中整体中心翻转，Photoshop 标准行为
    mirrorSelection(axis) {
        if (!this.state.selection.size) return;
        const before = this.fullSnapshot();
        const [gcx, gcy] = this.selCenter();
        for (const b of this.selBase()) {
            const o = b.ref;
            if (axis === "x") { o.x = 2 * gcx - (b.x + b.w); o.flipX = !o.flipX; }
            else { o.y = 2 * gcy - (b.y + b.h); o.flipY = !o.flipY; }
            o.rot = -b.rot || 0; // 翻转会反转旋转方向，取反保持视觉一致
        }
        for (const l of this.selectedPaints()) {
            const snap = this.snapCanvasOf(l); // 不可变快照作为翻转源
            const c = l._ctx;
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.clearRect(0, 0, this.state.W, this.state.H);
            // 绕 x=gcx（水平）或 y=gcy（垂直）翻转
            if (axis === "x") c.setTransform(-1, 0, 0, 1, 2 * gcx, 0);
            else c.setTransform(1, 0, 0, -1, 0, 2 * gcy);
            c.drawImage(snap, 0, 0);
            c.setTransform(1, 0, 0, 1, 0, 0);
            l._dirty = true;
            l._rev = this._revSeq++;
        }
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.markEdited();
        this.requestRender();
    }

    // 选中内容整体绕选中中心顺时针旋转 90°（悬浮条旋转按钮轻点）
    rotateSelection90() {
        if (!this.state.selection.size) return;
        const before = this.fullSnapshot();
        const [gcx, gcy] = this.selCenter();
        const cos = 0, sin = 1; // 顺时针 90°（画布 y 轴向下，正角即顺时针）
        for (const b of this.selBase()) {
            const o = b.ref;
            const bx = b.x + b.w / 2, by = b.y + b.h / 2;
            const ncx = gcx + (bx - gcx) * cos - (by - gcy) * sin;
            const ncy = gcy + (bx - gcx) * sin + (by - gcy) * cos;
            o.x = ncx - b.w / 2; o.y = ncy - b.h / 2;
            o.rot = (b.rot + 90) % 360;
        }
        for (const l of this.selectedPaints()) {
            const snap = this.snapCanvasOf(l);
            const c = l._ctx;
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.clearRect(0, 0, this.state.W, this.state.H);
            c.setTransform(cos, sin, -sin, cos, gcx * (1 - cos) + gcy * sin, gcy * (1 - cos) - gcx * sin);
            c.drawImage(snap, 0, 0);
            c.setTransform(1, 0, 0, 1, 0, 0);
            l._dirty = true;
            l._rev = this._revSeq++;
        }
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.markEdited();
        this.requestRender();
    }

    onPointerMove(e) {
        // 悬停光标
        if (!this.drag) {
            if (this.state.tool === "select" && this.state.selection.size) {
                const [sx, sy] = this.eventPos(e);
                const h = this.hitHandle(sx, sy);
                this.viewEl.style.cursor = h ? (h.kind === "rot" ? "grab" : this.selHandles()[h.idx]?.cur || "default") : "default";
            }
            return;
        }
        e.stopPropagation();
        const d = this.drag;
        const [sx, sy] = this.eventPos(e);
        const [cx, cy] = this.toCanvas(sx, sy);

        if (d.mode === "pan") {
            this.view.x = d.ox + (sx - d.sx);
            this.view.y = d.oy + (sy - d.sy);
            this.requestRender();
            return;
        }
        if (d.mode === "stroke") {
            const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
            for (const ev of evs.length ? evs : [e]) {
                const [ex, ey] = this.eventPos(ev);
                const [px, py] = this.toCanvas(ex, ey);
                this.stampLine(d.last.x, d.last.y, px, py);
                d.last = { x: px, y: py };
                d.bbox.x0 = Math.min(d.bbox.x0, px); d.bbox.y0 = Math.min(d.bbox.y0, py);
                d.bbox.x1 = Math.max(d.bbox.x1, px); d.bbox.y1 = Math.max(d.bbox.y1, py);
            }
            this.requestRender();
            return;
        }
        if (d.mode === "cut") {
            const lp = d.pts[d.pts.length - 1];
            if (Math.hypot(cx - lp.x, cy - lp.y) >= 1.5) d.pts.push({ x: cx, y: cy });
            this.requestRender();
            return;
        }
        if (d.mode === "shape") {
            const o = this.previewObj;
            let x0 = d.startX, y0 = d.startY;
            let w = cx - x0, h = cy - y0;
            if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
            let nx = x0, ny = y0;
            if (e.altKey) { nx = x0 - w; ny = y0 - h; w *= 2; h *= 2; }
            o.x = Math.min(nx, nx + w); o.y = Math.min(ny, ny + h);
            o.w = Math.abs(w); o.h = Math.abs(h);
            this.requestRender();
            return;
        }
        if (d.mode === "move") {
            const dx = (sx - d.sx) / this.view.zoom, dy = (sy - d.sy) / this.view.zoom;
            if (d.paints && d.paints.length) {
                // 首次实际移动时快照各笔迹层（用于撤销与平移源）
                if (!d.moved && (Math.abs(sx - d.sx) > 1 || Math.abs(sy - d.sy) > 1)) {
                    d.moved = true;
                    for (const p of d.paints) {
                        const base = document.createElement("canvas");
                        base.width = this.state.W; base.height = this.state.H;
                        base.getContext("2d").drawImage(p.ref._cv, 0, 0);
                        p.base = base;
                        p.ref._rev = this._revSeq++; // 像素将变化：作废旧快照缓存
                    }
                }
                if (d.moved) {
                    for (const p of d.paints) {
                        p.ref._ctx.clearRect(0, 0, this.state.W, this.state.H);
                        p.ref._ctx.drawImage(p.base, Math.round(dx), Math.round(dy));
                        p.ref._dirty = true;
                        p.ref._rev = this._revSeq++; // 每帧新像素：作废旧快照与包围盒缓存
                    }
                }
            }
            for (const b of d.objs) { b.ref.x = b.x + dx; b.ref.y = b.y + dy; if (b.ref.type === "text") this.invalidateText(b.ref); }
            this.requestRender();
            return;
        }
        if (d.mode === "scale") {
            this.applyScale(d, cx, cy, e.shiftKey, e.altKey);
            this.requestRender();
            return;
        }
        if (d.mode === "rot") {
            const [gcx, gcy] = d.center;
            // 轻点判定：拖动超过 2 屏幕像素才算真实旋转（否则 up 时转 90°）
            if (!d.moved && Math.hypot(cx - d.startC[0], cy - d.startC[1]) > 2 / this.view.zoom) d.moved = true;
            if (!d.moved) return;
            let delta = Math.atan2(cy - gcy, cx - gcx) - Math.atan2(d.startC[1] - gcy, d.startC[0] - gcx);
            if (e.shiftKey) {
                const st = 15 * Math.PI / 180;
                const base = (d.baseAngle ?? (d.baseAngle = d.objs[0] ? d.objs[0].rot * Math.PI / 180 : 0));
                // 以第一个对象为基准对齐 15°
                let target = base + delta;
                target = Math.round(target / st) * st;
                delta = target - base;
            }
            const cos = Math.cos(delta), sin = Math.sin(delta);
            for (const b of d.objs) {
                const o = b.ref;
                const bx = b.x + b.w / 2, by = b.y + b.h / 2;
                const dx = bx - gcx, dy = by - gcy;
                const ncx = gcx + dx * cos - dy * sin;
                const ncy = gcy + dx * sin + dy * cos;
                o.x = ncx - b.w / 2; o.y = ncy - b.h / 2;
                o.rot = (b.rot + delta * 180 / Math.PI) % 360;
            }
            // 笔迹层像素旋转：首帧快照 base，之后每帧从 base 围绕选中中心重放（与矢量同一 delta/center 同步旋转）
            if (d.paints && d.paints.length) {
                if (!d.rotSnap) {
                    d.rotSnap = true;
                    for (const p of d.paints) {
                        const base = document.createElement("canvas");
                        base.width = this.state.W; base.height = this.state.H;
                        base.getContext("2d").drawImage(p.ref._cv, 0, 0);
                        p.base = base;
                    }
                }
                for (const p of d.paints) {
                    const c = p.ref._ctx;
                    c.setTransform(1, 0, 0, 1, 0, 0);
                    c.clearRect(0, 0, this.state.W, this.state.H);
                    // 围绕 (gcx,gcy) 旋转 delta 的仿射矩阵
                    c.setTransform(cos, sin, -sin, cos, gcx * (1 - cos) + gcy * sin, gcy * (1 - cos) - gcx * sin);
                    c.drawImage(p.base, 0, 0);
                    c.setTransform(1, 0, 0, 1, 0, 0);
                    p.ref._dirty = true;
                    p.ref._rev = this._revSeq++; // 每帧新像素：作废旧快照与包围盒缓存
                }
            }
            this.requestRender();
            return;
        }
        if (d.mode === "marquee") {
            d.curX = cx; d.curY = cy;
            this.requestRender();
        }
    }

    applyScale(d, mx, my, shift, alt) {
        const a = d.aabb0;
        const idx = d.idx;
        const l = a.x, t = a.y, r = a.x + a.w, b = a.y + a.h;
        const cxm = (l + r) / 2, cym = (t + b) / 2;
        // 锚点：默认对侧，Alt 时以中心为锚
        let ax, ay, lockX = false, lockY = false;
        if (alt) { ax = cxm; ay = cym; }
        else {
            const anchors = [
                [r, b], [cxm, b], [l, b],
                [r, cym], [l, cym],
                [r, t], [cxm, t], [l, t],
            ];
            [ax, ay] = anchors[idx];
        }
        if (!alt) {
            if (idx === 1 || idx === 6) lockX = true;   // 上/下中点：仅纵向
            if (idx === 3 || idx === 4) lockY = true;   // 左/右中点：仅横向
        }
        const sx0 = d.startC[0] - ax, sy0 = d.startC[1] - ay;
        let fx = lockX ? 1 : (sx0 === 0 ? 1 : (mx - ax) / sx0);
        let fy = lockY ? 1 : (sy0 === 0 ? 1 : (my - ay) / sy0);
        if (shift && (idx === 0 || idx === 2 || idx === 5 || idx === 7)) {
            // 角点 + Shift：等比（以对角线投影）
            const d0 = Math.hypot(sx0, sy0) || 1;
            const f = Math.hypot(mx - ax, my - ay) / d0;
            fx = f; fy = f;
        }
        if (Math.abs(fx) < 0.02) fx = 0.02 * (fx < 0 ? -1 : 1);
        if (Math.abs(fy) < 0.02) fy = 0.02 * (fy < 0 ? -1 : 1);
        for (const bd of d.objs) {
            const o = bd.ref;
            if (o.type === "text") {
                // 文字：缩放字号而非宽高（宽高由字号派生）
                const sf = lockY ? fx : fy;
                o.font = { ...o.font, size: clamp(Math.round(bd.fs * sf), 4, 2000) };
                o.x = ax + (bd.x - ax) * fx;
                o.y = ay + (bd.y - ay) * fy;
                this.invalidateText(o);
                continue;
            }
            const bx = bd.x + bd.w / 2, by = bd.y + bd.h / 2;
            const ncx = ax + (bx - ax) * fx;
            const ncy = ay + (by - ay) * fy;
            o.w = Math.max(2, bd.w * fx);
            o.h = Math.max(2, bd.h * fy);
            o.x = ncx - o.w / 2;
            o.y = ncy - o.h / 2;
        }
        // 笔迹层像素缩放：首帧快照 base，之后每帧从 base 重放（锚点固定，其余按 fx/fy 缩放）
        if (d.paints && d.paints.length) {
            if (!d.moved) {
                d.moved = true;
                for (const p of d.paints) {
                    const base = document.createElement("canvas");
                    base.width = this.state.W; base.height = this.state.H;
                    base.getContext("2d").drawImage(p.ref._cv, 0, 0);
                    p.base = base;
                }
            }
            for (const p of d.paints) {
                const c = p.ref._ctx;
                c.setTransform(1, 0, 0, 1, 0, 0);
                c.clearRect(0, 0, this.state.W, this.state.H);
                c.setTransform(fx, 0, 0, fy, ax * (1 - fx), ay * (1 - fy));
                c.drawImage(p.base, 0, 0);
                c.setTransform(1, 0, 0, 1, 0, 0);
                p.ref._dirty = true;
                p.ref._rev = this._revSeq++; // 每帧新像素：作废旧快照与包围盒缓存
            }
        }
    }

    onPointerUp(e) {
        if (!this.drag) return;
        e.stopPropagation();
        try { this.viewEl.releasePointerCapture(e.pointerId); } catch (err) {}
        const d = this.drag;
        this.drag = null;
        this.updateCursor();

        if (d.mode === "stroke") { this.endStroke(d); return; }
        if (d.mode === "cut") {
            const pts = d.pts;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
            if (pts.length >= 3 && x1 - x0 >= 3 && y1 - y0 >= 3) {
                this._cutPts = pts;
                this.startAnts();
                this.buildParams();
                this.setStatus("选区已闭合，点击「拆分选区」或按 Enter 拆分");
            } else {
                this._cutPts = null;
                this.stopAnts();
                this.buildParams();
                if (pts.length >= 3) this.setStatus("选区太小，请重新圈选");
            }
            this.requestRender();
            return;
        }
        if (d.mode === "shape") {
            const o = this.previewObj;
            this.previewObj = null;
            if (o && o.w >= 3 && o.h >= 3) {
                this.withStackMutation(() => this.state.stack.push(o));
                this.setSelection([o.id]);
                this.buildParams();
                this.markEdited();
            }
            this.requestRender();
            return;
        }
        if (d.mode === "move" || d.mode === "scale" || d.mode === "rot") {
            // 轻点旋转按钮（未发生真实拖动）：整体绕选中中心顺时针转 90°
            if (d.mode === "rot" && !d.moved) { this.rotateSelection90(); return; }
            // 拖拽复制统一走 full 快照撤销（无论是否移动：副本创建+移动算一步）
            if (d.dup || (d.paints && d.paints.length && d.moved)) {
                // 含笔迹层移动：整画布快照撤销；被移动层的「操作前像素」取自拖前快照
                const movedById = new Map(d.paints.filter((p) => p.base).map((p) => [p.ref.id, p.base]));
                const before = {
                    W: this.state.W, H: this.state.H, ratio: this.state.ratio, maxEdge: this.state.maxEdge,
                    bgColor: this.state.bgColor, bgTransparent: this.state.bgTransparent, grid: this.state.grid,
                    stack: d.vbefore.map((it) => {
                        if (it.type !== "paint") return it;
                        if (movedById.has(it.id)) return { ...it, _cv: movedById.get(it.id) };
                        const cur = this.paintOf(it.id);
                        return cur ? { ...it, _cv: this.snapCanvasOf(cur) } : it; // 未移动层取不可变快照，禁止引用活画布
                    }),
                };
                this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
                this.markEdited();
            } else {
                const after = this.snapshotStack();
                if (JSON.stringify(d.vbefore) !== JSON.stringify(after)) {
                    this.pushEntry({ kind: "stack", before: d.vbefore, after });
                    this.markEdited();
                }
            }
            this.requestRender();
            return;
        }
        if (d.mode === "marquee") {
            const x0 = Math.min(d.startX, d.curX), x1 = Math.max(d.startX, d.curX);
            const y0 = Math.min(d.startY, d.curY), y1 = Math.max(d.startY, d.curY);
            if (x1 - x0 > 3 || y1 - y0 > 3) {
                const sel = d.add ? new Set(d.base) : new Set();
                for (const o of this.state.stack) {
                    if (o.type === "paint" || o.visible === false) continue; // 框选不选中隐藏图层与笔迹层
                    for (const [px, py] of this.objCorners(o)) {
                        if (px >= x0 && px <= x1 && py >= y0 && py <= y1) { sel.add(o.id); break; }
                    }
                }
                this.state.selection = sel;
                this.buildParams();
            }
            this.requestRender();
        }
    }

    // ── 画笔/橡皮 ──
    stamp(x, y) {
        const d = this.drag;
        if (!d || d.mode !== "stroke") return;
        const ctx = this.sctx;
        const r = Math.max(0.5, d.size / 2);
        ctx.save();
        if (d.hardness >= 99) {
            ctx.fillStyle = d.color;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        } else {
            const inner = r * d.hardness / 100;
            const [rr, gg, bb] = hexToRgb(d.color);
            const g = ctx.createRadialGradient(x, y, inner, x, y, r);
            g.addColorStop(0, `rgba(${rr},${gg},${bb},1)`);
            g.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    }

    stampLine(x0, y0, x1, y1) {
        const d = this.drag;
        if (!d) return;
        const dist = Math.hypot(x1 - x0, y1 - y0);
        const step = Math.max(0.7, d.size * 0.12);
        const n = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= n; i++) this.stamp(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
    }

    endStroke(d) {
        const tgt = this.paintOf(d.layerId) || this.activePaint();
        const pad = Math.ceil(d.size / 2) + 2;
        const bx = clamp(Math.floor(d.bbox.x0 - pad), 0, this.state.W - 1);
        const by = clamp(Math.floor(d.bbox.y0 - pad), 0, this.state.H - 1);
        const bw = clamp(Math.ceil(d.bbox.x1 + pad), 0, this.state.W) - bx;
        const bh = clamp(Math.ceil(d.bbox.y1 + pad), 0, this.state.H) - by;
        let bmPart = null;
        if (tgt && bw > 0 && bh > 0) {
            const before = tgt._ctx.getImageData(bx, by, bw, bh);
            tgt._ctx.save();
            if (d.erase) tgt._ctx.globalCompositeOperation = "destination-out";
            tgt._ctx.globalAlpha = d.opacity;
            tgt._ctx.drawImage(this.stroke, 0, 0);
            tgt._ctx.restore();
            const after = tgt._ctx.getImageData(bx, by, bw, bh);
            bmPart = { layerId: tgt.id, bbox: { x: bx, y: by, w: bw, h: bh }, before, after };
            tgt._dirty = true;
            tgt._rev = this._revSeq++;
        }
        // 橡皮对图像素材的擦除（烘焙 + 撤销快照）
        const imgs = this.eraseImages(d, pad);
        if (bmPart || imgs.length) {
            this.pushEntry({ kind: "bitmap", ...(bmPart || {}), imgs: imgs.length ? imgs : undefined });
            this.markEdited();
        }
        this.sctx.clearRect(0, 0, this.state.W, this.state.H);
        this.requestRender();
    }

    // ── 文字编辑 ──
    startEdit(o, isNew, before) {
        if (this.editing) this.commitEdit(true);
        this.editing = o;
        this.editIsNew = isNew;
        this.editBefore = before || this.snapshotStack();
        this._editOrigText = o.text;
        this.ta.value = o.text;
        this.ta.style.display = "block";
        this.positionTA();
        this.requestRender();
        setTimeout(() => { this.ta.focus(); this.ta.select(); }, 0);
    }

    positionTA() {
        const o = this.editing;
        if (!o) return;
        const z = this.view.zoom;
        const [sx, sy] = this.toScreen(o.x, o.y);
        const m = this.textMetrics(o);
        this.ta.style.left = sx + "px";
        this.ta.style.top = sy + "px";
        this.ta.style.width = Math.max(24, m.w * z + 24) + "px";
        this.ta.style.height = Math.max(16, m.h * z + 6) + "px";
        this.ta.style.font = this.fontStr(o.font);
        this.ta.style.fontSize = o.font.size * z + "px";
        this.ta.style.lineHeight = 1.25;
        this.ta.style.color = o.font.color;
        this.ta.style.transform = o.rot ? `rotate(${o.rot}deg)` : "";
        this.ta.style.transformOrigin = "0 0";
    }

    commitEdit(save) {
        const o = this.editing;
        if (!o) return;
        this.editing = null;
        this.ta.style.display = "none";
        if (!save) {
            this.adoptStack(cleanClone(this.editBefore));
            this.invalidateAllText();
            this.pruneSelection();
        } else if (o.text.trim() === "") {
            const before = this.editBefore;
            this.state.stack = this.state.stack.filter((v) => v !== o);
            const after = this.snapshotStack();
            if (JSON.stringify(before) !== JSON.stringify(after)) this.pushEntry({ kind: "stack", before, after });
        } else {
            const after = this.snapshotStack();
            if (JSON.stringify(this.editBefore) !== JSON.stringify(after)) {
                this.pushEntry({ kind: "stack", before: this.editBefore, after });
            }
        }
        this.editBefore = null;
        this.buildParams();
        if (save) this.markEdited();
        this.requestRender();
    }

    invalidateAllText() { for (const o of this.state.stack) if (o.type === "text") this.invalidateText(o); }

    // ── 选择与对象操作 ──
    nextId() { return "v" + this.idSeq++; }
    setSelection(ids) { this.state.selection = new Set(ids); this.buildParams(); this.requestRender(); }
    pruneSelection() {
        const live = new Set(this.state.stack.map((o) => o.id));
        for (const id of this.state.selection) if (!live.has(id)) this.state.selection.delete(id);
        this.buildParams();
    }

    deleteSelection() {
        if (!this.state.selection.size) return;
        const paints = this.selectedPaints();
        const allPaints = this.state.stack.filter((it) => it.type === "paint");
        // 至少保留一个笔迹图层（绘画目标不可全删）
        if (paints.length && allPaints.length - paints.length < 1) {
            this.setStatus("至少需要保留一个图层，禁止删除最后一个笔迹图层");
            return;
        }
        const nextId = this.neighborRowId();
        if (paints.length) {
            const before = this.fullSnapshot();
            this.state.stack = this.state.stack.filter((it) => !this.state.selection.has(it.id));
            if (!this.paintOf(this.state.activeId)) this.state.activeId = (this.topmostPaint() || {}).id || null;
            this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        } else {
            this.withStackMutation(() => {
                this.state.stack = this.state.stack.filter((it) => !this.state.selection.has(it.id));
            });
        }
        this.state.selection.clear();
        if (nextId) this.state.selection.add(nextId);
        this.rebuildAssets();
        this.buildParams();
        this.markEdited();
        this.requestRender();
        this.setStatus(paints.length ? "图层已删除（可撤销）" : "已删除");
    }

    levelOp(kind) {
        if (!this.state.selection.size) return;
        this.withStackMutation(() => {
            const arr = this.state.stack;
            const sel = arr.filter((o) => this.state.selection.has(o.id));
            const rest = arr.filter((o) => !this.state.selection.has(o.id));
            if (kind === "top") this.state.stack = [...rest, ...sel];
            else if (kind === "bottom") this.state.stack = [...sel, ...rest];
            else {
                for (const o of sel) {
                    const i = this.state.stack.indexOf(o);
                    const j = kind === "up" ? i + 1 : i - 1;
                    if (j >= 0 && j < this.state.stack.length) {
                        this.state.stack.splice(i, 1);
                        this.state.stack.splice(j, 0, o);
                    }
                }
            }
        });
        this.markEdited();
        this.requestRender();
    }

    // ── 右键菜单 ──
    onContextMenu(e) {
        const [sx, sy] = this.eventPos(e);
        const [cx, cy] = this.toCanvas(sx, sy);
        const hit = this.hitTest(cx, cy);
        if (hit) {
            if (hit.type === "paint") this.setActive(hit.id);
            if (!this.state.selection.has(hit.id)) this.setSelection([hit.id]);
        }
        if (!this.state.selection.size) { this.closeMenu(); return; }
        this.openMenu(sx, sy);
    }

    openMenu(sx, sy) {
        const m = this.menu;
        const has = this.state.selection.size > 0;
        m.innerHTML = "";
        const mk = (label, title, fn, enabled = true) => {
            const b = el("button", null, label);
            b.title = title || "";
            b.disabled = !enabled;
            b.addEventListener("click", () => { this.closeMenu(); fn(); });
            m.appendChild(b);
        };
        mk("删除", "Delete", () => this.deleteSelection(), has);
        m.appendChild(el("hr"));
        mk("上移一层", "", () => this.levelOp("up"), has);
        mk("下移一层", "", () => this.levelOp("down"), has);
        mk("置顶", "", () => this.levelOp("top"), has);
        mk("置底", "", () => this.levelOp("bottom"), has);
        m.style.display = "block";
        const rw = this.root.clientWidth, rh = this.root.clientHeight;
        const mw = m.offsetWidth, mh = m.offsetHeight;
        m.style.left = clamp(sx + 148 + 8, 0, Math.max(0, rw - mw)) + "px";
        m.style.top = clamp(sy + 40, 0, Math.max(0, rh - mh)) + "px";
    }

    closeMenu() { this.menu.style.display = "none"; }

    // ── 确认浮层 ──
    confirmDialog(msg) {
        return new Promise((resolve) => {
            this.confirmMsg.textContent = msg;
            this.confirmEl.style.display = "flex";
            const done = (v) => {
                this.confirmEl.style.display = "none";
                okB.removeEventListener("click", okH);
                cancelB.removeEventListener("click", cancelH);
                resolve(v);
            };
            const okB = this.confirmEl.querySelector(".ok");
            const cancelB = this.confirmEl.querySelector(".cancel");
            const okH = () => done(true);
            const cancelH = () => done(false);
            okB.addEventListener("click", okH);
            cancelB.addEventListener("click", cancelH);
        });
    }

    // ── 画布尺寸/清空 ──
    applyCanvasResize(ratio, maxEdge) {
        const before = this.fullSnapshot();
        this.state.ratio = ratio;
        this.state.maxEdge = maxEdge;
        const { W, H } = sizeFor(ratio, maxEdge);
        // 保留原内容：旧笔迹层原位画到新画布，矢量对象（素材/形状/文字）原位不动
        const olds = new Map();
        for (const it of this.state.stack) if (it.type === "paint") olds.set(it.id, { cv: it._cv, dirty: it._dirty });
        this.initCanvases(W, H);
        for (const it of this.state.stack) {
            if (it.type !== "paint") continue;
            const old = olds.get(it.id);
            if (old && old.dirty) { it._ctx.drawImage(old.cv, 0, 0); it._dirty = true; }
        }
        // 画布变小时，把会被完全挤出画布的对象拉回边缘（至少露 24px），避免"面板有、画布无"
        const keepVisible = (v, size, bound) => {
            const lo = 24 - size, hi = bound - 24;
            return lo > hi ? (bound - size) / 2 : clamp(v, lo, hi);
        };
        for (const o of this.state.stack) {
            if (o.type === "paint") continue;
            const b = this.objBBox(o);
            o.x = keepVisible(o.x, b.w, W);
            o.y = keepVisible(o.y, b.h, H);
        }
        this.state.selection.clear();
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.updateToolbarUI();
        this.buildParams();
        this.fitView();
        this.markEdited();
        this.setStatus(`画布尺寸已改为 ${W}×${H}，内容已保留`);
        this.requestRender();
    }

    clearCanvas() {
        const before = this.fullSnapshot();
        this.state.stack = [];
        const layer = this.newPaintLayer();
        this.state.stack = [layer];
        this.state.activeId = layer.id;
        this.state.selection.clear();
        this._cutPts = null;
        this.stopAnts();
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.buildParams();
        this.rebuildAssets();
        this.markEdited();
        this.requestRender();
        this.setStatus("画布已清空");
    }

    fullSnapshot() {
        const stack = this.snapshotStack().map((it) => {
            if (it.type !== "paint") return it;
            const cur = this.paintOf(it.id);
            if (!cur) return it;
            return { ...it, _cv: this.snapCanvasOf(cur) };
        });
        return {
            W: this.state.W, H: this.state.H,
            ratio: this.state.ratio, maxEdge: this.state.maxEdge,
            bgColor: this.state.bgColor, bgTransparent: this.state.bgTransparent, grid: this.state.grid,
            stack,
        };
    }

    applyFull(s) {
        this.state.ratio = s.ratio;
        this.state.maxEdge = s.maxEdge;
        this.state.bgColor = s.bgColor;
        this.state.bgTransparent = s.bgTransparent;
        this.state.grid = s.grid;
        this.initCanvases(s.W, s.H);
        // 重建图层栈：paint 按快照像素重建；矢量按 id 复用运行时对象（保留已解码图片 _cv）
        const oldById = new Map();
        for (const it of this.state.stack) oldById.set(it.id, it);
        const next = [];
        for (const it of s.stack) {
            const ex = oldById.get(it.id);
            if (it.type === "paint") {
                const layer = (ex && ex.type === "paint") ? ex : { id: it.id, type: "paint" };
                layer.name = it.name;
                layer.visible = it.visible !== false;
                // 从快照复制全新活画布（快照画布不可变，可能被多条历史共享）
                const live = document.createElement("canvas");
                live.width = s.W; live.height = s.H;
                live.getContext("2d").drawImage(it._cv, 0, 0);
                layer._cv = live;
                layer._ctx = live.getContext("2d", { willReadFrequently: true });
                layer._dirty = true;
                layer._rev = this._revSeq++;
                this._snapCache.set(layer.id, { rev: layer._rev, cv: it._cv }); // 快照可继续被后续 fullSnapshot 共享
                next.push(layer);
            } else {
                const clone = cleanClone(it);
                // 仅 src 一致时才复用已解码画布：图片像素被改过（挖洞/擦除）后 src 已变，错复用会恢复旧像素
                if (ex && ex.type !== "paint" && ex._cv && ex.src === it.src) clone._cv = ex._cv;
                next.push(clone);
            }
        }
        this.state.stack = next;
        this.ensureImageCanvases();
        if (!this.paintOf(this.state.activeId)) this.state.activeId = (this.topmostPaint() || {}).id || null;
        this.invalidateAllText();
        this.pruneSelection();
        this.rebuildAssets();
        this.updateToolbarUI();
        this.buildParams();
        this.requestRender();
    }

    // ── 历史 ──
    snapshotStack() { return cleanClone(this.state.stack); }

    withStackMutation(fn) {
        const before = this.snapshotStack();
        fn();
        const after = this.snapshotStack();
        if (JSON.stringify(before) !== JSON.stringify(after)) this.pushEntry({ kind: "stack", before, after });
    }

    // 恢复图层栈快照：按 id 复用运行时画布（paint 像素 / 图片解码结果），缺失则新建空画布
    adoptStack(plain) {
        const old = new Map();
        for (const it of this.state.stack) {
            if (it.type === "paint") old.set(it.id, { cv: it._cv, ctx: it._ctx, rev: it._rev });
            else if (it.type === "image" && it._cv) old.set(it.id, { cv: it._cv, src: it.src });
        }
        this.state.stack = plain;
        for (const it of this.state.stack) {
            const rec = old.get(it.id);
            if (it.type === "paint") {
                if (rec && rec.cv.width === this.state.W && rec.cv.height === this.state.H) {
                    it._cv = rec.cv; it._ctx = rec.ctx; it._rev = rec.rev; // 像素未变，沿用版本号保留快照共享
                } else {
                    const cv = document.createElement("canvas");
                    cv.width = this.state.W; cv.height = this.state.H;
                    it._cv = cv;
                    it._ctx = cv.getContext("2d", { willReadFrequently: true });
                    it._rev = this._revSeq++;
                }
            } else if (it.type === "image" && rec && rec.src === it.src) {
                it._cv = rec.cv; // 仅 src 一致时复用解码结果，像素已改的图片交给 ensureImageCanvases 重解码
            }
        }
        if (!this.paintOf(this.state.activeId)) this.state.activeId = (this.topmostPaint() || {}).id || null;
        this.ensureImageCanvases();
        this.rebuildAssets();
    }

    pushEntry(entry) {
        this.history.push(entry);
        if (this.history.length > HISTORY_MAX) this.history.shift();
        this.redoStack.length = 0;
        this.updateUndoBtns();
        this.saveSchedule();
    }

    applySide(entry, side) {
        const s = entry[side];
        if (entry.kind === "bitmap") {
            if (entry.bbox) {
                // 图层隔离：撤销补丁只写回原目标层，目标层已缺失时丢弃补丁（绝不落到其他层）
                const layer = this.paintOf(entry.layerId);
                if (layer) {
                    layer._ctx.putImageData(s, entry.bbox.x, entry.bbox.y);
                    layer._dirty = true;
                }
            }
            if (entry.imgs) {
                for (const im of entry.imgs) {
                    const o = this.state.stack.find((v) => v.id === im.id && v.type === "image");
                    if (!o || !o._cv) continue;
                    o._cv.getContext("2d").putImageData(side === "before" ? im.before : im.after, im.x, im.y);
                    o.src = canvasDataURL(o._cv); // 保持 src 与像素同步
                    IMG_CACHE.set(o.src, o._cv);
                }
            }
        } else if (entry.kind === "stack") {
            if (this.editing) this.commitEdit(false);
            this.adoptStack(cleanClone(s));
            this.invalidateAllText();
            this.pruneSelection();
        } else if (entry.kind === "full") {
            if (this.editing) this.commitEdit(false);
            this.applyFull(s);
        }
        this.requestRender();
        this.saveSchedule();
        this.markEdited();
    }

    undo() {
        const e = this.history.pop();
        if (!e) return;
        this.redoStack.push(e);
        this.applySide(e, "before");
        this.updateUndoBtns();
        this.setStatus("已撤销");
    }

    redo() {
        const e = this.redoStack.pop();
        if (!e) return;
        this.history.push(e);
        this.applySide(e, "after");
        this.updateUndoBtns();
        this.setStatus("已重做");
    }

    updateUndoBtns() {
        this.undoBtn.disabled = !this.history.length;
        this.redoBtn.disabled = !this.redoStack.length;
    }

    // ── 参数面板 ──
    paramTarget() {
        const sel = this.selected();
        if (sel.length !== 1) return null;
        const o = sel[0];
        const t = this.state.tool;
        if (o.type === "text" && (t === "select" || t === "text")) return o;
        if (o.type !== "text" && o.type !== "path" && o.type !== "image" && (t === "select" || t === "rect" || t === "ellipse" || t === "triangle")) return o;
        return null;
    }

    editBegin() { if (!this._pSnap) this._pSnap = this.snapshotStack(); }
    editEnd() {
        if (!this._pSnap) return;
        const after = this.snapshotStack();
        if (JSON.stringify(this._pSnap) !== JSON.stringify(after)) {
            this.pushEntry({ kind: "stack", before: this._pSnap, after });
            this.markEdited();
        }
        this._pSnap = null;
    }
    editCancel() { this._pSnap = null; }

    mkSlider(label, min, max, get, set, opts = {}) {
        const wrap = el("div", "cv-p");
        const top = el("div", "cv-p-top", `<span>${label}</span>`);
        const num = el("input"); num.type = "number"; num.min = min; num.max = max; num.step = opts.step || 1;
        top.appendChild(num);
        const rng = el("input", "cv-p-range"); rng.type = "range"; rng.min = min; rng.max = max; rng.step = opts.step || 1;
        wrap.append(top, rng);
        const v0 = get();
        rng.value = v0; num.value = Math.round(v0 * 100) / 100;
        const apply = (v) => {
            v = clamp(+v || 0, min, max);
            this.editBegin();
            set(v);
            rng.value = v; num.value = Math.round(v * 100) / 100;
            this.requestRender();
        };
        rng.addEventListener("input", () => apply(rng.value));
        rng.addEventListener("change", () => this.editEnd());
        num.addEventListener("change", () => { apply(num.value); this.editEnd(); });
        num.addEventListener("keydown", (e) => e.stopPropagation());
        return wrap;
    }

    mkColorRow(label, get, set, opts = {}) {
        const row = el("div", "wp-cv-row", `<span>${label}</span>`);
        const btn = el("button", "wp-cv-btn wp-cv-colorbtn", "<i><b></b></i>");
        btn.type = "button";
        const sw = btn.querySelector("b");
        const sync = () => {
            const c = get();
            sw.style.background = c == null ? "transparent" : c;
            sw.style.display = c == null ? "none" : "block";
            if (c == null) sw.parentElement.style.background = "transparent";
            else sw.parentElement.style.backgroundImage = "";
        };
        sync();
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.openColorPicker(btn, {
                color: get(),
                allowTransparent: !!opts.allowTransparent,
                apply: (c) => { this.editBegin(); set(c); sync(); this.requestRender(); },
                done: () => this.editEnd(),
            });
        });
        row.appendChild(btn);
        return row;
    }

    mkToggleRow(label, get, set) {
        const row = el("div", "wp-cv-row", `<span>${label}</span>`);
        const sw = el("button", "wp-cv-switch");
        sw.type = "button";
        sw.innerHTML = "<i></i>";
        const sync = () => sw.classList.toggle("on", !!get());
        sync();
        sw.addEventListener("click", () => {
            this.editBegin();
            set(!get());
            sync();
            this.editEnd();
            this.requestRender();
        });
        row.appendChild(sw);
        return row;
    }

    mkToggleBtn(label, get, set) {
        const b = el("button", "wp-cv-btn", label);
        b.type = "button";
        const sync = () => b.classList.toggle("on", !!get());
        sync();
        b.addEventListener("click", () => {
            this.editBegin();
            set(!get());
            sync();
            this.editEnd();
            this.requestRender();
        });
        return b;
    }

    mkSelectRow(label, options, get, set) {
        const row = el("div", "wp-cv-row", `<span>${label}</span>`);
        const s = el("select");
        options.forEach(([v, l], i) => {
            const o = el("option", null, l);
            o.value = String(i);
            s.appendChild(o);
        });
        const findIdx = () => {
            const v = get();
            const i = options.findIndex(([ov]) => ov === v);
            return i >= 0 ? i : 0;
        };
        s.value = String(findIdx());
        s.addEventListener("change", () => {
            this.editBegin();
            set(options[+s.value][0]);
            this.editEnd();
            this.requestRender();
        });
        row.appendChild(s);
        return row;
    }

    mkNumRow(label, min, max, get, set) {
        const row = el("div", "wp-cv-row", `<span>${label}</span>`);
        const n = el("input");
        n.type = "number"; n.min = min; n.max = max;
        n.value = get();
        n.style.width = "60px";
        const apply = () => {
            const v = clamp(Math.round(+n.value || min), min, max);
            n.value = v;
            this.editBegin();
            set(v);
            this.requestRender();
        };
        n.addEventListener("change", () => { apply(); this.editEnd(); });
        n.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") n.blur(); });
        row.appendChild(n);
        return row;
    }

    mkHint(text) { return el("div", "cv-hint", text); }

    buildParams() {
        if (this.editing) return;
        if (this._pSnap) this.editEnd();
        const p = this.paramsEl;
        p.innerHTML = "";
        const t = this.state.tool;
        const target = this.paramTarget();
        const add = (...els) => els.forEach((x) => x && p.appendChild(x));

        if (t === "cut") {
            const tgt = this.cutTarget();
            if (tgt && tgt.type === "image" && !tgt._cv) {
                add(this.mkHint("图片正在解码，请稍后再拆分"));
                return;
            }
            if (!tgt) {
                add(this.mkHint("没有可分割的图层"));
                return;
            }
            const tgtName = tgt.type === "image" ? `图片素材「${tgt.name || "未命名"}」` : `笔迹图层「${tgt.name}」`;
            add(this.mkHint(`分割目标：${tgtName}<br>按住鼠标画圈选区，松开自动闭合`));
            const btn = el("button", "wp-cv-btn", "✂ 拆分选区");
            btn.type = "button";
            btn.style.width = "100%";
            btn.style.height = "26px";
            btn.disabled = !this._cutPts;
            btn.addEventListener("click", () => this.doCutSplit());
            add(btn);
            add(this.mkHint(this._cutPts ? "Enter 拆分 · Esc 取消 · 画新圈自动替换" : "圈选后有内容即可拆分"));
            return;
        }

        const selPaints = this.selectedPaints();
        if (selPaints.length) {
            const n = this.state.selection.size;
            if (selPaints.length === 1 && n === 1 && selPaints[0].id === this.state.activeId) {
                add(this.mkHint(`已选中笔迹图层「${selPaints[0].name}」（当前绘画目标）<br>拖动整体移动，Delete 删除图层`));
            } else {
                add(this.mkHint(n > 1 ? `已选中 ${n} 个图层（含笔迹）<br>拖动整体移动，Delete 删除` : `已选中笔迹图层「${selPaints[0].name}」<br>拖动整体移动，Delete 删除图层`));
            }
            return;
        }

        if (t === "select" && !target) {
            const n = this.state.selection.size;
            const selArr = this.selected();
            const onlyImg = n === 1 && selArr.length === 1 && selArr[0].type === "image";
            add(this.mkHint(onlyImg ? "已选中图像素材<br>拖动移动 / 白点缩放 / 紫点旋转<br>橡皮擦可直接擦除像素" : n > 1 ? `已选中 ${n} 个对象<br>可拖拽移动 / 缩放 / 旋转` : "点击画布中的形状或文字<br>进行选中与编辑"));
            return;
        }

        if (t === "brush") {
            const b = this.state.brush;
            add(
                this.mkSlider("粗细", 1, 200, () => b.size, (v) => (b.size = v)),
                this.mkColorRow("颜色", () => b.color, (v) => (b.color = v || "#000000")),
                this.mkSlider("不透明度", 0, 100, () => b.opacity, (v) => (b.opacity = v)),
                this.mkSlider("硬度", 0, 100, () => b.hardness, (v) => (b.hardness = v)),
            );
            return;
        }
        if (t === "eraser") {
            const er = this.state.eraser;
            add(
                this.mkSlider("粗细", 1, 200, () => er.size, (v) => (er.size = v)),
                this.mkSlider("硬度", 0, 100, () => er.hardness, (v) => (er.hardness = v)),
                this.mkSlider("不透明度", 0, 100, () => er.opacity, (v) => (er.opacity = v)),
            );
            return;
        }

        if (t === "text" || (target && target.type === "text")) {
            if (target && target.type === "text") {
                const f = target.font;
                add(this.mkHint("正在编辑选中的文字对象"));
                add(
                    this.mkSelectRow("字体", FONTS.map(([l, c]) => [c, l]), () => f.family, (v) => { f.family = v; this.invalidateText(target); }),
                    this.mkNumRow("字号", 12, 200, () => f.size, (v) => { f.size = v; this.invalidateText(target); }),
                    this.mkColorRow("颜色", () => f.color, (v) => (f.color = v || "#333333")),
                );
                const tg = el("div", "cv-p-toggles");
                tg.append(
                    this.mkToggleBtn("加粗", () => f.bold, (v) => { f.bold = v; this.invalidateText(target); }),
                    this.mkToggleBtn("斜体", () => f.italic, (v) => { f.italic = v; this.invalidateText(target); }),
                );
                add(tg);
                return;
            }
            const d = this.state.text;
            add(
                this.mkSelectRow("字体", FONTS.map(([l, c]) => [c, l]), () => d.family, (v) => (d.family = v)),
                this.mkNumRow("字号", 12, 200, () => d.size, (v) => (d.size = v)),
                this.mkColorRow("颜色", () => d.color, (v) => (d.color = v || "#333333")),
            );
            const tg = el("div", "cv-p-toggles");
            tg.append(
                this.mkToggleBtn("加粗", () => d.bold, (v) => (d.bold = v)),
                this.mkToggleBtn("斜体", () => d.italic, (v) => (d.italic = v)),
            );
            add(tg);
            return;
        }

        // 形状工具 / 选中形状
        const isShapeTool = t === "rect" || t === "ellipse" || t === "triangle";
        if (isShapeTool || (target && target.type !== "text")) {
            let src, bindTo;
            if (target && target.type !== "text") {
                bindTo = target;
                add(this.mkHint("正在编辑选中的形状"));
            } else {
                bindTo = null;
            }
            src = bindTo || this.state.shape;
            const getFillOn = () => (bindTo ? bindTo.fill.on : this.state.shape.fillOn);
            const setFillOn = (v) => { if (bindTo) bindTo.fill.on = v; else this.state.shape.fillOn = v; };
            const getFillColor = () => (bindTo ? bindTo.fill.color : this.state.shape.fillColor);
            const setFillColor = (v) => { if (bindTo) bindTo.fill.color = v || "#845ef7"; else this.state.shape.fillColor = v || "#845ef7"; };
            const getStrokeOn = () => (bindTo ? bindTo.stroke.on : this.state.shape.strokeOn);
            const setStrokeOn = (v) => { if (bindTo) bindTo.stroke.on = v; else this.state.shape.strokeOn = v; };
            const getStrokeColor = () => (bindTo ? bindTo.stroke.color : this.state.shape.strokeColor);
            const setStrokeColor = (v) => { if (bindTo) bindTo.stroke.color = v || "#333333"; else this.state.shape.strokeColor = v || "#333333"; };
            const getStrokeW = () => (bindTo ? bindTo.stroke.w : this.state.shape.strokeW);
            const setStrokeW = (v) => { if (bindTo) bindTo.stroke.w = v; else this.state.shape.strokeW = v; };
            add(
                this.mkToggleRow("填充", getFillOn, setFillOn),
                this.mkColorRow("填充色", getFillColor, setFillColor),
                this.mkToggleRow("描边", getStrokeOn, setStrokeOn),
                this.mkColorRow("描边色", getStrokeColor, setStrokeColor),
                this.mkSlider("描边粗细", 1, 50, getStrokeW, setStrokeW),
            );
            return;
        }

        add(this.mkHint("选择左侧工具开始创作"));
    }

    // ── 取色器 ──
    openColorPicker(anchor, opts) {
        const pk = this.picker;
        this._pickerAnchor = anchor;
        this._pickerOpts = opts;
        let cur = opts.color;
        if (cur == null) cur = "#ffffff";
        cur = cur.toLowerCase();
        pk.innerHTML = "";
        const sws = el("div", "sws");
        if (opts.allowTransparent) {
            const b = el("button", "sw", "透明");
            b.type = "button";
            b.style.fontSize = "10px";
            b.style.color = "#888";
            b.style.background = "#555";
            b.addEventListener("click", () => apply(null));
            sws.appendChild(b);
        }
        for (const c of SWATCHES) {
            const b = el("button", "sw", `<b style="background:${c}"></b>`);
            b.type = "button";
            b.title = c;
            b.addEventListener("click", () => apply(c));
            sws.appendChild(b);
        }
        pk.appendChild(sws);

        const prow = el("div", "prow");
        const native = el("input"); native.type = "color"; native.value = cur;
        const hexLabel = el("span", null, "HEX");
        const hex = el("input"); hex.type = "text"; hex.value = cur;
        prow.append(native, hexLabel, hex);
        pk.appendChild(prow);

        const prow2 = el("div", "prow");
        const rgbs = [0, 1, 2].map((i) => {
            const s = el("span", null, "RGB"[i]);
            const n = el("input"); n.type = "number"; n.min = 0; n.max = 255;
            n.value = hexToRgb(cur)[i];
            prow2.append(s, n);
            return n;
        });
        pk.appendChild(prow2);

        const syncUI = (c) => {
            if (c == null) { hex.value = "transparent"; rgbs.forEach((n) => (n.value = 0)); native.value = "#ffffff"; return; }
            hex.value = c.toLowerCase();
            native.value = c.toLowerCase();
            const [r, g, b] = hexToRgb(c);
            rgbs[0].value = r; rgbs[1].value = g; rgbs[2].value = b;
        };
        const apply = (c) => {
            cur = c;
            syncUI(c == null ? null : c);
            opts.apply(c);
        };
        native.addEventListener("input", () => apply(native.value));
        hex.addEventListener("change", () => {
            let v = hex.value.trim();
            if (/^#?[0-9a-f]{6}$/i.test(v)) apply(v.startsWith("#") ? v.toLowerCase() : "#" + v.toLowerCase());
            else syncUI(cur);
        });
        hex.addEventListener("keydown", (e) => e.stopPropagation());
        rgbs.forEach((n, i) => {
            n.addEventListener("change", () => {
                const [r, g, b] = hexToRgb(cur);
                const vals = [r, g, b];
                vals[i] = clamp(Math.round(+n.value || 0), 0, 255);
                apply(rgbToHex(vals[0], vals[1], vals[2]));
            });
            n.addEventListener("keydown", (e) => e.stopPropagation());
        });

        pk.style.display = "block";
        const rootR = this.root.getBoundingClientRect();
        const aR = anchor.getBoundingClientRect();
        // 视觉坐标 → 布局坐标（兼容 ComfyUI 画布缩放的 CSS transform）
        const k = rootR.width > 0 ? this.root.clientWidth / rootR.width : 1;
        const pw = pk.offsetWidth, ph = pk.offsetHeight;
        let left = (aR.right - rootR.left) / k + 6;
        if (left + pw > this.root.clientWidth - 4) left = Math.max(4, (aR.left - rootR.left) / k - pw - 6);
        pk.style.left = left + "px";
        pk.style.top = clamp((aR.top - rootR.top) / k - 20, 4, Math.max(4, this.root.clientHeight - ph - 4)) + "px";
        syncUI(opts.color == null ? null : cur);
        this._pickerDone = () => { if (opts.done) opts.done(); };
    }

    closeColorPicker() {
        this.picker.style.display = "none";
        this._pickerAnchor = null;
        if (this._pickerDone) { const f = this._pickerDone; this._pickerDone = null; f(); }
    }

    // ── 工具切换 / 界面同步 ──
    setTool(t) {
        if (this.editing) this.commitEdit(true);
        if (t !== "cut" && this._cutPts) { this._cutPts = null; this.stopAnts(); }
        this.state.tool = t;
        this.closeMenu();
        this.updateToolbarUI();
        this.buildParams();
        this.updateCursor();
    }

    updateCursor() {
        const t = this.state.tool;
        this.viewEl.style.cursor = this.spaceHeld ? "grab"
            : this.drag && this.drag.mode === "pan" ? "grabbing"
            : t === "select" ? "default"
            : t === "text" ? "text"
            : "crosshair";
    }

    updateToolbarUI() {
        this.ratioSel.value = this.state.ratio;
        this.edgeInput.value = this.state.maxEdge;
        if (this.state.bgTransparent) {
            this.bgSw.style.display = "none";
        } else {
            this.bgSw.style.display = "block";
            this.bgSw.style.background = this.state.bgColor;
        }
        this.gridSwitch.classList.toggle("on", !!this.state.grid);
        this.autoSwitch.classList.toggle("on", !!this.state.autoOut);
        Object.entries(this.toolBtns).forEach(([t, b]) => b.classList.toggle("on", this.state.tool === t));
        this.updateUndoBtns();
    }

    setStatus(msg) {
        this.statusEl.textContent = msg || "";
        if (msg) {
            clearTimeout(this._statusTimer);
            this._statusTimer = setTimeout(() => (this.statusEl.textContent = ""), 2600);
        }
    }

    // ── 素材上传 ──
    rebuildAssets() {
        if (!this.assetsEl) return;
        this.assetsEl.innerHTML = "";
        for (const o of this.state.stack) {
            if (o.type !== "image") continue;
            const cell = el("div", "wp-cv-asset");
            cell.style.backgroundImage = `url("${o.src}")`;
            cell.title = "点击选中画布中的图像素材";
            const del = el("button", "del", "×");
            del.type = "button";
            del.title = "删除此素材";
            del.addEventListener("click", (e) => { e.stopPropagation(); this.removeAsset(o.id); });
            cell.addEventListener("click", () => {
                this.setTool("select");
                this.setSelection([o.id]);
            });
            cell.appendChild(del);
            this.assetsEl.appendChild(cell);
        }
        const add = el("div", "wp-cv-asset add", this._uploading ? "…" : "+");
        add.title = "点击选择图像，或直接拖入图像文件";
        if (this._uploading) add.classList.add("busy");
        else add.addEventListener("click", () => this.pickFiles());
        this.assetsEl.appendChild(add);
    }

    // ── 图层面板（右侧栏，Photoshop 风格：列表上方=顶层，笔迹层与对象自由混排）──
    layerNameOf(o) {
        if (o.name) return o.name;
        if (o.type === "text") {
            const t = String(o.text || "").replace(/\s+/g, " ").trim();
            return t ? (t.length > 12 ? t.slice(0, 12) + "…" : t) : "文字";
        }
        return { image: "图片", rect: "矩形", ellipse: "圆形", triangle: "三角形" }[o.type] || "图层";
    }

    // 面板刷新签名：内容/可见性/选中任一变化才重建行，避免拖拽指示线被频繁重建打断
    layerSig() {
        const s = this.state;
        return s.stack.map((o) => o.id + (o.visible === false ? "!" : "") + ":" + (o.type === "paint" ? o.name : this.layerNameOf(o))).join(",")
            + "|" + [...s.selection].join(",")
            + "|" + (s.activeId || "");
    }

    refreshLayers() {
        if (!this.layerListEl || this.destroyed) return;
        const sig = this.layerSig();
        if (sig === this._layerSig) return;
        this._layerSig = sig;
        this.rebuildLayers();
    }

    rebuildLayers() {
        const list = this.layerListEl;
        list.innerHTML = "";
        for (let i = this.state.stack.length - 1; i >= 0; i--) list.appendChild(this.mkLayerRow(this.state.stack[i]));
        this.delLayerBtn.disabled = !this.state.selection.size;
    }

    mkLayerRow(o) {
        const s = this.state;
        const isPaint = o.type === "paint";
        const row = el("div", "wp-cv-layer");
        if (s.selection.has(o.id)) row.classList.add("selected");
        if (o.visible === false) row.classList.add("off");
        if (isPaint && o.id === s.activeId) row.classList.add("active");
        row.draggable = true;
        row.title = isPaint
            ? "笔迹图层：点击选中并设为绘画目标（Ctrl/Shift 多选）；拖动此行调整层级顺序"
            : "点击选中（Ctrl/Shift 多选）；拖动此行调整层级顺序";
        const cb = el("input"); cb.type = "checkbox"; cb.className = "vis"; cb.checked = o.visible !== false;
        cb.title = "显示 / 隐藏此图层";
        const ic = el("span", "ic", isPaint ? "✏" : (LAYER_ICONS[o.type] || "▫"));
        const nm = el("span", "nm");
        nm.textContent = isPaint ? o.name : this.layerNameOf(o);
        nm.title = nm.textContent;
        row.append(cb, ic, nm);

        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
            const vis = cb.checked;
            this.withStackMutation(() => { o.visible = vis; });
            this.markEdited();
            this.requestRender();
        });
        row.addEventListener("click", (e) => {
            // 保持当前工具不切换（Photoshop 行为：选中图层 ≠ 切换工具）
            if (isPaint) this.setActive(o.id);
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
                const sel = new Set(s.selection);
                if (sel.has(o.id)) sel.delete(o.id); else sel.add(o.id);
                this.state.selection = sel;
                this.buildParams();
                this.requestRender();
            } else {
                this.setSelection([o.id]);
            }
        });

        row.addEventListener("dragstart", (e) => {
            this._dragLayerId = o.id;
            row.classList.add("dragging");
            try { e.dataTransfer.setData("text/plain", o.id); e.dataTransfer.effectAllowed = "move"; } catch (err) {}
        });
        row.addEventListener("dragend", () => {
            this._dragLayerId = null;
            row.classList.remove("dragging");
            this.clearLayerDropMarks();
        });
        row.addEventListener("dragover", (e) => {
            if (!this._dragLayerId || this._dragLayerId === o.id) return;
            e.preventDefault(); e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            this.markLayerDropRow(row, e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2);
        });
        row.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            const id = this._dragLayerId;
            this.clearLayerDropMarks();
            if (!id || id === o.id) return;
            this.reorderLayer(id, o, e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2);
        });
        return row;
    }

    markLayerDropRow(row, top) {
        for (const r of this.layerListEl.children) r.classList.remove("dragover-top", "dragover-bottom");
        row.classList.add(top ? "dragover-top" : "dragover-bottom");
    }

    clearLayerDropMarks() {
        if (!this.layerListEl) return;
        for (const r of this.layerListEl.children) r.classList.remove("dragover-top", "dragover-bottom");
    }

    // 列表上方=数组末尾（后绘制=更上层）：落在目标行上半区 → 插到目标之后（其上），下半区 → 之前（其下）
    reorderLayer(id, target, aboveInList) {
        const arr = this.state.stack;
        const obj = arr.find((v) => v.id === id);
        if (!obj || obj === target) return;
        this.withStackMutation(() => {
            arr.splice(arr.indexOf(obj), 1);
            const ti = arr.indexOf(target);
            arr.splice(aboveInList ? ti + 1 : ti, 0, obj);
        });
        this.markEdited();
        this.requestRender();
    }

    // 指定笔迹层非空像素包围盒（合并时确定笔迹范围，避免裁掉画到素材外的笔迹）
    // 按 _rev 版本号缓存：像素未变时直接复用，避免选中/拖拽时每帧全图扫描
    bitmapInkBBox(layer) {
        try {
            const W = this.state.W, H = this.state.H;
            if (!this._bboxCache) this._bboxCache = new Map();
            const rec = this._bboxCache.get(layer.id);
            if (rec && rec.rev === layer._rev && rec.W === W && rec.H === H) return rec.box;
            const d = layer._ctx.getImageData(0, 0, W, H).data;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (let y = 0; y < H; y++) {
                const base = y * W * 4;
                for (let x = 0; x < W; x++) {
                    if (d[base + x * 4 + 3] > 0) {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
            }
            const box = isFinite(x0) ? { x0, y0, x1, y1 } : null;
            this._bboxCache.set(layer.id, { rev: layer._rev, W, H, box });
            return box;
        } catch (err) { return null; }
    }

    // 合并所选图层：可见的选中项（笔迹层/对象）按层级烘焙为一张图片对象
    mergeLayers() {
        const s = this.state;
        const selVecs = s.stack.filter((o) => o.type !== "paint" && s.selection.has(o.id));
        const selPaints = this.selectedPaints();
        if (!selVecs.length && !selPaints.length) { this.setStatus("请先选择要合并的图层"); return; }
        const visVecs = selVecs.filter((o) => o.visible !== false);
        const visPaints = selPaints.filter((l) => l.visible !== false);
        if (visVecs.length + visPaints.length < 2) { this.setStatus("请先选择至少两个可见图层再合并"); return; }
        for (const o of visVecs) {
            if (o.type === "image" && !o._cv) { this.setStatus("图片正在解码，请稍后再合并"); return; }
        }
        // 合并区域 = 可见选中内容的包围盒（笔迹层取非空像素范围），外扩 2px 并裁剪到画布内
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const o of visVecs) {
            for (const [px, py] of this.objCorners(o)) {
                x0 = Math.min(x0, px); y0 = Math.min(y0, py);
                x1 = Math.max(x1, px); y1 = Math.max(y1, py);
            }
        }
        for (const l of visPaints) {
            const bb = this.bitmapInkBBox(l);
            if (bb) {
                x0 = Math.min(x0, bb.x0); y0 = Math.min(y0, bb.y0);
                x1 = Math.max(x1, bb.x1); y1 = Math.max(y1, bb.y1);
            }
        }
        if (!isFinite(x0)) { this.setStatus("所选图层没有可见内容，无法合并"); return; }
        x0 = clamp(Math.floor(x0) - 2, 0, s.W - 1); y0 = clamp(Math.floor(y0) - 2, 0, s.H - 1);
        x1 = clamp(Math.ceil(x1) + 2, x0 + 1, s.W); y1 = clamp(Math.ceil(y1) + 2, y0 + 1, s.H);
        const w = x1 - x0, h = y1 - y0;

        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const c2 = cv.getContext("2d");
        c2.translate(-x0, -y0);
        // 按 stack 层级顺序绘制参与合并的可见选中项
        const picked = new Set([...visVecs, ...visPaints].map((o) => o.id));
        for (const it of s.stack) {
            if (!picked.has(it.id)) continue;
            if (it.type === "paint") c2.drawImage(it._cv, 0, 0);
            else this.drawVector(c2, it);
        }

        const src = canvasDataURL(cv);
        const merged = { id: this.nextId(), type: "image", x: x0, y: y0, w, h, rot: 0, src, name: "合并图层" };
        IMG_CACHE.set(src, cv);
        merged._cv = cv;

        const before = this.fullSnapshot();
        // 隐藏的选中对象保留原样，仅移除参与合并的可见项；合并结果插到原最顶选中项的位置
        const removed = new Set([...visVecs, ...visPaints].map((o) => o.id));
        let insertAt = 0;
        for (let i = 0; i < s.stack.length; i++) if (picked.has(s.stack[i].id)) insertAt = i;
        s.stack = s.stack.filter((o) => !removed.has(o.id));
        insertAt = Math.min(insertAt, s.stack.length);
        s.stack.splice(insertAt, 0, merged);
        // 合并后若没有笔迹层，补一个空层保证可继续绘画
        if (!s.stack.some((it) => it.type === "paint")) {
            const l = this.newPaintLayer();
            s.stack.unshift(l);
            s.activeId = l.id;
        }
        if (!this.paintOf(s.activeId)) s.activeId = (this.topmostPaint() || {}).id || null;
        this.pushEntry({ kind: "full", before, after: this.fullSnapshot() });
        this.setTool("select");
        this.setSelection([merged.id]);
        this.rebuildAssets();
        this.markEdited();
        this.requestRender();
        this.setStatus(`已合并 ${removed.size} 个图层（可撤销）`);
    }

    pickFiles() {
        if (this._uploading || this.destroyed) return;
        this.fileInput.click();
    }

    async handleFiles(files) {
        if (this._uploading || this.destroyed) return;
        const list = [...files];
        const imgs = list.filter((f) => f.type && f.type.startsWith("image/"));
        if (!imgs.length) { this.setStatus("请选择图片文件（PNG / JPG / WebP 等）"); return; }
        this._uploading = true;
        this.rebuildAssets();
        for (const f of imgs) await this.loadAndPlace(f);
        this._uploading = false;
        this.rebuildAssets();
    }

    // 画布区拖放：本地图片文件，或资产库/输出面板拖来的素材（application/x-wp-asset 标识）
    async handleCanvasDrop(e) {
        if (this._uploading || this.destroyed) return;
        if (this.editing) this.commitEdit(true);
        const dt = e.dataTransfer;
        if (!dt) return;
        const wpRaw = dt.getData("application/x-wp-asset");
        if (wpRaw) {
            let info = null;
            try { info = JSON.parse(wpRaw); } catch (err) {}
            if (info && (info.type === "wp_asset" || info.type === "wp_output")) {
                this.addAssetFromLibrary(info);
                return;
            }
        }
        if (dt.files && dt.files.length) { this.handleFiles(dt.files); return; }
        this.setStatus("仅支持拖入图片");
    }

    // 从资产库/输出面板取原图并添加为素材（仅图片类型，走 loadAndPlace 居中放置）
    async addAssetFromLibrary(info) {
        if (this._uploading || this.destroyed) return;
        if ((info.fileType || "image") !== "image") { this.setStatus("仅支持拖入图片素材（视频/音频/文本不支持）"); return; }
        const isOutput = info.type === "wp_output" && !!info.path;
        const url = isOutput
            ? `${ASSET_API}/output/file?path=${encodeURIComponent(info.path)}`
            : `${ASSET_API}/file/${encodeURIComponent(info.assetId)}`;
        this._uploading = true;
        this.rebuildAssets();
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const file = new File([blob], info.fileName || "素材库图片", { type: blob.type || "image/png" });
            await this.loadAndPlace(file);
        } catch (err) {
            console.error("[WP_Canvas] 素材库图片加载失败", err);
            this.setStatus("素材库图片加载失败");
        } finally {
            this._uploading = false;
            this.rebuildAssets();
        }
    }

    async loadAndPlace(file, opts = {}) {
        if (!file.type || !file.type.startsWith("image/")) { this.setStatus(`跳过非图片文件：${file.name}`); return; }
        if (file.size > MAX_FILE_MB * 1024 * 1024) { this.setStatus(`文件过大（超过 ${MAX_FILE_MB}MB）：${file.name}`); return; }
        try {
            const dataURL = await new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = rej;
                r.readAsDataURL(file);
            });
            const img = await new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = dataURL;
            });
            if (!img.naturalWidth || !img.naturalHeight) throw new Error("图像内容无效");
            const cv = this.shrinkToMaxEdge(img);
            const src = canvasDataURL(cv);
            // 放置：默认居中，超出画布则缩至画布 90%
            let w = cv.width, h = cv.height;
            const W = this.state.W, H = this.state.H;
            if (w > W * 0.9 || h > H * 0.9) {
                const k = Math.min(W * 0.9 / w, H * 0.9 / h);
                w = Math.max(1, Math.round(w * k));
                h = Math.max(1, Math.round(h * k));
            }
            const o = { id: this.nextId(), type: "image", x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, rot: 0, src, name: file.name };
            IMG_CACHE.set(src, cv);
            o._cv = cv;
            this.withStackMutation(() => this.state.stack.push(o));
            this.rebuildAssets();
            this.markEdited();
            this.requestRender();
            if (opts.paste) {
                this.setTool("select");
                this.setSelection([o.id]);
                this.flashNew([o.id]);
                this.setStatus(`已粘贴剪贴板图片（${cv.width}×${cv.height}，可撤销）`);
            } else {
                this.setStatus(`已添加素材：${file.name}（${cv.width}×${cv.height}）`);
            }
        } catch (err) {
            console.error("[WP_Canvas] 素材加载失败", err);
            this.setStatus(`素材加载失败：${file.name}`);
        }
    }

    // 粘贴剪贴板图片：解码放置到画布中心 + 闪烁反馈（防重入）
    async pasteImageFile(file) {
        if (this.destroyed || this._pasteBusy) return;
        if (!file || !file.type || !file.type.startsWith("image/")) return;
        this._pasteBusy = true;
        try { await this.loadAndPlace(file, { paste: true }); }
        finally { this._pasteBusy = false; }
    }

    // Ctrl+V 兜底通道：paste 事件缺失时（部分浏览器场景）直读剪贴板 API
    async pasteFromClipboardAPI() {
        if (this.destroyed || this._pasteBusy) return;
        if (!navigator.clipboard || !navigator.clipboard.read) return;
        let items = null;
        try { items = await navigator.clipboard.read(); }
        catch (err) { return; } // 未授权/不支持：静默（paste 事件通道多半已完成）
        if (!items || !items.length) return;
        for (const it of items) {
            const mt = (it.types || []).find((tp) => tp.startsWith("image/"));
            if (!mt) continue;
            try {
                const blob = await it.getType(mt);
                this.pasteImageFile(new File([blob], "剪贴板图片", { type: mt }));
                return;
            } catch (err) { console.error("[WP_Canvas] 读取剪贴板图片失败", err); }
        }
    }

    // 最大边超过 1024 时等比缩小（保留透明通道），小图保持原尺寸
    shrinkToMaxEdge(img) {
        let w = img.naturalWidth, h = img.naturalHeight;
        const m = Math.max(w, h);
        if (m > MAX_UPLOAD_EDGE) {
            const k = MAX_UPLOAD_EDGE / m;
            w = Math.max(1, Math.round(w * k));
            h = Math.max(1, Math.round(h * k));
        }
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        return cv;
    }

    async removeAsset(id) {
        const o = this.state.stack.find((v) => v.id === id);
        if (!o || this._uploading) return;
        const ok = await this.confirmDialog("删除此素材？画布上的对应图像将一并移除。");
        if (!ok) return;
        this.withStackMutation(() => { this.state.stack = this.state.stack.filter((v) => v.id !== id); });
        this.state.selection.delete(id);
        this.rebuildAssets();
        this.markEdited();
        this.requestRender();
        this.setStatus("素材已删除");
    }

    ensureImageCanvases() {
        for (const o of this.state.stack) {
            if (o.type !== "image" || o._cv) continue;
            const c = IMG_CACHE.get(o.src);
            if (c) { o._cv = c; continue; }
            imageCanvasFromSrc(o.src, (cv) => {
                if (this.destroyed) return;
                if (cv && !o._cv) { o._cv = cv; this.requestRender(); }
            });
        }
    }

    // ── 橡皮擦除图像素材 ──
    // 画布坐标 → 图像局部像素坐标（考虑缩放、旋转与镜像：镜像是自身逆变换）
    canvasToImgLocal(o, px, py) {
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
        const a = -(o.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        const dx = px - cx, dy = py - cy;
        let rx = cx + dx * cos - dy * sin, ry = cy + dx * sin + dy * cos;
        if (o.flipX) rx = 2 * cx - rx;
        if (o.flipY) ry = 2 * cy - ry;
        return [(rx - o.x) * o._cv.width / o.w, (ry - o.y) * o._cv.height / o.h];
    }

    // 在图像上下文上设置「画布域 → 图像局部」的逆变换（笔触 canvas 可直接 drawImage）
    applyImgLocalTransform(c, o) {
        const iw = o._cv.width, ih = o._cv.height;
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
        c.setTransform(iw / o.w, 0, 0, ih / o.h, -o.x * iw / o.w, -o.y * ih / o.h);
        c.translate(cx, cy);
        c.rotate(-(o.rot || 0) * Math.PI / 180);
        c.translate(-cx, -cy);
        if (o.flipX || o.flipY) {
            c.translate(cx, cy);
            c.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
            c.translate(-cx, -cy);
        }
    }

    strokeIntersectsImg(d, o, pad) {
        const x0 = d.bbox.x0 - pad, y0 = d.bbox.y0 - pad, x1 = d.bbox.x1 + pad, y1 = d.bbox.y1 + pad;
        let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
        for (const [px, py] of this.objCorners(o)) {
            ox0 = Math.min(ox0, px); oy0 = Math.min(oy0, py);
            ox1 = Math.max(ox1, px); oy1 = Math.max(oy1, py);
        }
        return x0 < ox1 && x1 > ox0 && y0 < oy1 && y1 > oy0;
    }

    // 擦除预览（不修改原图）：scratch 合成「图像 - 笔触」
    imgErasePreview(o) {
        const d = this.drag;
        const sc = this.scratchImg || (this.scratchImg = document.createElement("canvas"));
        const iw = o._cv.width, ih = o._cv.height;
        if (sc.width !== iw || sc.height !== ih) { sc.width = iw; sc.height = ih; }
        const c = sc.getContext("2d");
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, iw, ih);
        c.drawImage(o._cv, 0, 0);
        c.globalCompositeOperation = "destination-out";
        c.globalAlpha = d.opacity;
        this.applyImgLocalTransform(c, o);
        c.drawImage(this.stroke, 0, 0);
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = "source-over";
        c.globalAlpha = 1;
        return sc;
    }

    // 烘焙擦除到图像像素（含撤销快照）。图层隔离：仅擦除被用户选中的图片，未选中的一律不动
    eraseImages(d, pad) {
        const out = [];
        if (!d.erase) return out;
        for (const o of this.state.stack) {
            if (o.type !== "image" || !o._cv) continue;
            if (o.visible === false) continue;
            if (!this.state.selection.has(o.id)) continue;
            if (!this.strokeIntersectsImg(d, o, pad)) continue;
            const iw = o._cv.width, ih = o._cv.height;
            const quad = [
                [d.bbox.x0 - pad, d.bbox.y0 - pad], [d.bbox.x1 + pad, d.bbox.y0 - pad],
                [d.bbox.x1 + pad, d.bbox.y1 + pad], [d.bbox.x0 - pad, d.bbox.y1 + pad],
            ].map(([px, py]) => this.canvasToImgLocal(o, px, py));
            const lx = clamp(Math.floor(Math.min(...quad.map((q) => q[0]))), 0, iw - 1);
            const ly = clamp(Math.floor(Math.min(...quad.map((q) => q[1]))), 0, ih - 1);
            const hx = clamp(Math.ceil(Math.max(...quad.map((q) => q[0]))), lx + 1, iw);
            const hy = clamp(Math.ceil(Math.max(...quad.map((q) => q[1]))), ly + 1, ih);
            const ictx = o._cv.getContext("2d");
            const before = ictx.getImageData(lx, ly, hx - lx, hy - ly);
            ictx.save();
            ictx.globalCompositeOperation = "destination-out";
            ictx.globalAlpha = d.opacity;
            this.applyImgLocalTransform(ictx, o);
            ictx.drawImage(this.stroke, 0, 0);
            ictx.restore();
            const after = ictx.getImageData(lx, ly, hx - lx, hy - ly);
            o.src = canvasDataURL(o._cv); // 同步像素到 src（保存/重建用）
            IMG_CACHE.set(o.src, o._cv);
            out.push({ id: o.id, x: lx, y: ly, before, after });
        }
        return out;
    }

    // ── 输出 ──
    // 等待 restore 后的笔迹像素全部解码落地（刷新后立刻运行时，保证合成的是完整画布）
    async awaitPixelRestore() {
        const ps = this._decPs;
        if (ps && ps.length) await Promise.all(ps);
    }

    // 合成画布并上传到 input 目录（后端经此文件读取画板图像）；上传成功后清除脏标记
    async exportNow() {
        if (this.editing) this.commitEdit(true);
        await this.awaitPixelRestore();
        const cnv = this.composeOutput();
        const blob = await new Promise((res) => cnv.toBlob((b) => res(b), "image/png"));
        if (!blob) throw new Error("图像编码失败");
        const name = `WP.canvas.output.n${this.node.id}.${Date.now()}.png`;
        const body = new FormData();
        body.append("image", blob, name);
        body.append("type", "input");
        body.append("overwrite", "true");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body });
        if (!resp.ok) throw new Error(`上传失败 HTTP ${resp.status}`);
        this._outDirty = false;
    }

    // 仅运行「画板 → 正下方直连的图像显示节点」链路（预览图像/保存图像/WP图像对比等），
    // 画板下游的其它分支（提示词对话、采样等）一律不执行
    async queuePreviewOnly() {
        const p = await app.graphToPrompt();
        const prompt = p.output || p.prompt || p;
        const myId = String(this.node.id);
        if (!prompt[myId]) return "no-display";

        // 1) 直连在画板输出上的图像显示节点
        const targets = new Set();
        for (const id of Object.keys(prompt)) {
            if (id === myId) continue;
            const n = prompt[id];
            if (!n || !DISPLAY_TYPES.has(n.class_type)) continue;
            for (const v of Object.values(n.inputs || {})) {
                if (Array.isArray(v) && String(v[0]) === myId) { targets.add(id); break; }
            }
        }
        if (!targets.size) return "no-display";

        // 2) 显示节点的上游依赖闭包（如 WP图像对比的另一张输入图；未变的节点命中 ComfyUI 缓存不重跑）
        const need = new Set([myId, ...targets]);
        const stack = [...targets];
        while (stack.length) {
            const id = stack.pop();
            const n = prompt[id];
            if (!n || !n.inputs) continue;
            for (const v of Object.values(n.inputs)) {
                if (!Array.isArray(v)) continue;
                const sid = String(v[0]);
                if (prompt[sid] && !need.has(sid)) { need.add(sid); stack.push(sid); }
            }
        }

        const sub = {};
        for (const id of need) sub[id] = prompt[id];
        const body = { prompt: sub };
        try { if (api.clientId) body.client_id = api.clientId; } catch (err) {}
        if (p.workflow) body.extra_data = { extra_pnginfo: { workflow: p.workflow } };
        const resp = await api.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
        if (!resp.ok) throw new Error(`运行失败 HTTP ${resp.status}`);
        return "ok";
    }

    composeOutput() {
        const c = document.createElement("canvas");
        c.width = this.state.W; c.height = this.state.H;
        const ctx = c.getContext("2d");
        if (!this.state.bgTransparent) {
            ctx.fillStyle = this.state.bgColor;
            ctx.fillRect(0, 0, this.state.W, this.state.H);
        }
        // 隐藏图层不参与输出（与 Photoshop 导出行为一致）
        for (const o of this.state.stack) {
            if (o.visible === false) continue;
            if (o.type === "paint") ctx.drawImage(o._cv, 0, 0);
            else this.drawVector(ctx, o);
        }
        return c;
    }

    async doOutput() {
        if (this._busy || this.destroyed) return;
        this._busy = true;
        this.outBtn.disabled = true;
        this.outBtn.textContent = "输出中…";
        try {
            await this.exportNow();
            this.setStatus(`已输出 ${this.state.W}×${this.state.H}`);
            this.outBtn.textContent = "✓ 已输出";
            try { this.node.setDirtyCanvas(true, true); } catch (err) {}
            // 只刷新正下方直连的图像显示节点，画板下游其它分支不执行
            const q = await this.queuePreviewOnly();
            if (q === "no-display") this.setStatus("图像已更新（画板未直连预览图像/保存图像类节点，未触发运行）");
        } catch (err) {
            console.error("[WP_Canvas] 输出失败", err);
            this.outBtn.textContent = "输出失败";
            this.setStatus("输出失败：" + (err && err.message ? err.message : err));
        } finally {
            this._busy = false;
            this.outBtn.disabled = false;
            setTimeout(() => { if (!this.destroyed && this.outBtn.textContent !== "输出图像") this.outBtn.textContent = "输出图像"; }, 1500);
        }
    }

    markEdited() {
        this._outDirty = true; // 画布有新改动：运行工作流前需自动导出
        this.saveSchedule();
        if (!this.state.autoOut) return;
        clearTimeout(this._autoTimer);
        this._autoTimer = setTimeout(() => this.doOutput(), AUTO_OUT_DEBOUNCE);
    }

    // ── 持久化 ──
    saveSchedule() {
        if (this.destroyed) return;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            try { this.node.properties.wpCanvasData = this.serializeNow(); } catch (err) { console.error("[WP_Canvas] 保存失败", err); }
        }, SAVE_DEBOUNCE);
    }

    serializeNow() {
        const s = this.state;
        return JSON.stringify({
            v: 2,
            p: {
                ratio: s.ratio, maxEdge: s.maxEdge, bgColor: s.bgColor, bgTransparent: s.bgTransparent,
                grid: s.grid, tool: s.tool, brush: s.brush, eraser: s.eraser, text: s.text, shape: s.shape,
                autoOut: s.autoOut, view: { zoom: this.view.zoom, x: this.view.x, y: this.view.y },
            },
            // 笔迹层序列化：仅保存有内容的层（WebP 压缩，保留透明通道）
            // 编码结果按层缓存（挂活层 _savedRev/_savedSrc，_ 前缀不进输出）：内容未变的层复用上次编码，图层多时避免每次保存全量重压缩导致卡顿
            st: this.snapshotStack().map((it) => {
                if (it.type !== "paint") return it;
                const cur = this.paintOf(it.id);
                if (!cur) return { ...it, src: null };
                // 未置脏的层：若带待恢复的 _src（restore 后解码尚未落地），原样带回而非写 null，
                // 避免竞态窗口内的自动保存把笔迹清空；真正空白的层 _src 本就是 null
                if (!cur._dirty) return { ...it, src: cur._src || null };
                if (!cur._savedSrc || cur._savedRev !== cur._rev) {
                    cur._savedSrc = canvasDataURL(cur._cv);
                    cur._savedRev = cur._rev;
                }
                return { ...it, src: cur._savedSrc };
            }),
            al: s.activeId,
        });
    }

    restore(json) {
        if (!json || json === this._restoredFrom) return;
        this._restoredFrom = json;
        let d;
        try { d = JSON.parse(json); } catch (err) { console.error("[WP_Canvas] 恢复数据解析失败", err); return; }
        if (!d || (d.v !== 1 && d.v !== 2)) return;
        // 恢复的画布内容可能与 input 目录中的上次输出文件不一致，下次运行前需自动导出一次
        this._outDirty = true;
        const p = d.p || {};
        const s = this.state;
        if (RATIOS.includes(p.ratio)) s.ratio = p.ratio;
        if (Number.isFinite(+p.maxEdge)) s.maxEdge = clamp(Math.round(+p.maxEdge), 64, 4096);
        if (typeof p.bgColor === "string") s.bgColor = p.bgColor;
        s.bgTransparent = !!p.bgTransparent;
        s.grid = !!p.grid;
        if (typeof p.tool === "string") s.tool = p.tool;
        if (p.brush) s.brush = { ...s.brush, ...p.brush };
        if (p.eraser) s.eraser = { ...s.eraser, ...p.eraser };
        if (p.text) s.text = { ...s.text, ...p.text };
        if (p.shape) s.shape = { ...s.shape, ...p.shape };
        s.autoOut = !!p.autoOut;
        s.selection = new Set();
        this._cutPts = null;
        this.stopAnts();
        // 图层栈：v2 直接读取；v1 由矢量数组 + 单笔迹位图迁移（笔迹层置底）
        if (d.v === 2 && Array.isArray(d.st)) {
            s.stack = cleanClone(d.st).map((it) => {
                if (it.type !== "paint") return it;
                return { id: it.id, type: "paint", name: it.name || "图层", visible: it.visible !== false, _src: it.src || null };
            });
            let maxSeq = 0;
            for (const it of s.stack) {
                if (it.type !== "paint") continue;
                const m = /^L(\d+)$/.exec(it.id);
                if (m) maxSeq = Math.max(maxSeq, +m[1]);
            }
            this.layerSeq = maxSeq + 1;
        } else {
            s.stack = Array.isArray(d.vs) ? cleanClone(d.vs) : [];
            s.stack.push({
                id: "L1", type: "paint", name: "图层1", visible: p.bmVisible !== false,
                _src: (typeof d.bm === "string" && d.bm.startsWith("data:image")) ? d.bm : null,
            });
            this.layerSeq = 2;
        }
        if (!s.stack.some((it) => it.type === "paint")) {
            s.stack.unshift({ id: "L1", type: "paint", name: "图层1", visible: true, _src: null });
            this.layerSeq = Math.max(this.layerSeq, 2);
        }
        const { W, H } = sizeFor(s.ratio, s.maxEdge);
        this.initCanvases(W, H);
        s.activeId = (typeof d.al === "string" && this.paintOf(d.al)) ? d.al : (this.topmostPaint() || {}).id || null;
        for (const o of s.stack) if (o.type === "text") this.invalidateText(o);
        this.ensureImageCanvases();
        this.rebuildAssets();
        // 异步恢复各笔迹层像素（guard：层仍在栈中且未被再次编辑）
        this._decPs = [];
        for (const it of s.stack) {
            if (it.type !== "paint" || !it._src) continue;
            const src = it._src;
            this._decPs.push(new Promise((res) => imageCanvasFromSrc(src, (cv) => {
                if (this.destroyed || !cv) return res();
                const cur = this.state.stack.find((q) => q.type === "paint" && q.id === it.id);
                if (!cur || cur._dirty) return res(); // 层已被删除或已被再次编辑
                cur._ctx.clearRect(0, 0, this.state.W, this.state.H);
                cur._ctx.drawImage(cv, 0, 0, this.state.W, this.state.H);
                cur._dirty = true;
                cur._rev = this._revSeq++;
                this._outDirty = true; // 像素解码落地晚于导出时，下次运行前重新自动导出
                this.saveSchedule(); // 落地后补一次保存：纠正解码窗口内可能写入节点的空数据
                this.requestRender();
                res();
            })));
        }
        // 历史数据迁移：旧版 PNG 素材 src 重新编码为 WebP，缩小工作流体积（避免撑爆浏览器草稿存储配额）
        for (const o of s.stack) {
            if (o.type !== "image" || typeof o.src !== "string" || !o.src.startsWith("data:image/png")) continue;
            imageCanvasFromSrc(o.src, (cv) => {
                if (this.destroyed || !cv) return;
                const cur = this.state.stack.find((v) => v.id === o.id);
                if (!cur || cur.src !== o.src) return; // 已被再次编辑/迁移则跳过
                cur.src = canvasDataURL(cv);
                cur._cv = cv;
                IMG_CACHE.set(cur.src, cv);
                this.rebuildAssets();
                this.markEdited();
                this.requestRender();
            });
        }
        this.history = [];
        this.redoStack = [];
        if (p.view && Number.isFinite(+p.view.zoom)) {
            this.view.zoom = clamp(+p.view.zoom, MIN_ZOOM, MAX_ZOOM);
            this.view.x = +p.view.x || 0;
            this.view.y = +p.view.y || 0;
        }
        this.updateToolbarUI();
        this.buildParams();
        this.requestRender();
    }

    // ── 全局键盘（仅激活节点响应）──
    handleGlobalKey(e) {
        if (this.destroyed || this.editing) return;
        // 拖拽进行中禁用撤销/重做/删除，避免对象引用失效
        if (this.drag) {
            const k0 = (e.key || "").toLowerCase();
            if (e.key === "Delete" || e.key === "Backspace" || ((e.ctrlKey || e.metaKey) && (k0 === "z" || k0 === "y"))) return;
        }
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
        const k = (e.key || "").toLowerCase();
        const mod = e.ctrlKey || e.metaKey;
        if (mod) {
            if (k === "z") { e.preventDefault(); e.stopPropagation(); e.shiftKey ? this.redo() : this.undo(); return; }
            if (k === "y") { e.preventDefault(); e.stopPropagation(); this.redo(); return; }
            if (e.key === "0") { e.preventDefault(); e.stopPropagation(); this.fitView(); return; }
            if (k === "v") {
                // 粘贴图片兜底通道：不 preventDefault（Chrome 中拦截 keydown 会取消原生 paste 事件）；
                // 80ms 内 paste 事件未处理过剪贴板，则改走 clipboard API
                setTimeout(() => {
                    if (this.destroyed) return;
                    if (performance.now() - this._pasteAt < 200) return;
                    this.pasteFromClipboardAPI();
                }, 80);
                return;
            }
            return;
        }
        if (e.key === " ") {
            if (!this.spaceHeld) { this.spaceHeld = true; this.updateCursor(); }
            e.preventDefault();
            return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
            if (this.state.selection.size) { e.preventDefault(); e.stopPropagation(); this.deleteSelection(); }
            return;
        }
        if (e.key === "Escape") {
            if (this._cutPts) { this.clearCutSel(); e.preventDefault(); }
            return;
        }
        if (e.key === "Enter" && this.state.tool === "cut" && this._cutPts) {
            e.preventDefault(); e.stopPropagation();
            this.doCutSplit();
            return;
        }
        if (TOOL_KEYS[k] && !e.repeat) {
            this.setTool(TOOL_KEYS[k]);
            e.preventDefault();
        }
    }

    destroy() {
        this.destroyed = true;
        BOARDS.delete(this);
        clearTimeout(this._saveTimer);
        clearTimeout(this._autoTimer);
        if (this._raf) cancelAnimationFrame(this._raf);
        this.stopAnts();
        if (this._flashRaf) { cancelAnimationFrame(this._flashRaf); this._flashRaf = 0; }
        if (this.ro) { try { this.ro.disconnect(); } catch (err) {} }
        if (this._docMenuCloser) document.removeEventListener("pointerdown", this._docMenuCloser, true);
        try { this.root.remove(); } catch (err) {}
    }
}

// ═══════════════ 全局激活跟踪 + 快捷键 ═══════════════
let ACTIVE_BOARD = null;

function installGlobalHandlers() {
    if (installGlobalHandlers._done) return;
    installGlobalHandlers._done = true;

    document.addEventListener("pointerdown", (e) => {
        const root = e.target && e.target.closest ? e.target.closest("[data-wp-canvas]") : null;
        ACTIVE_BOARD = root ? root.__wpBoard__ || null : null;
    }, true);

    document.addEventListener("keydown", (e) => {
        const b = ACTIVE_BOARD;
        if (!b || b.destroyed) return;
        b.handleGlobalKey(e);
    }, true);

    document.addEventListener("keyup", (e) => {
        const b = ACTIVE_BOARD;
        if (!b || b.destroyed) return;
        if (e.key === " ") { b.spaceHeld = false; b.updateCursor(); }
    }, true);

    // Ctrl+V 粘贴图片主通道：capture 阶段先于 ComfyUI 默认粘贴（粘节点/粘文本）处理；
    // 剪贴板含图片才拦截——无图时放行，保留 ComfyUI 原 Ctrl+V 行为
    document.addEventListener("paste", (e) => {
        const b = ACTIVE_BOARD;
        if (!b || b.destroyed) return;
        b._pasteAt = performance.now(); // 无条件记录：抑制随后 80ms 的 API 兜底轮询
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; // 文本框内正常粘贴文字
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const it of items) {
            if (it.kind !== "file" || !it.type || !it.type.startsWith("image/")) continue;
            const f = it.getAsFile();
            if (!f) continue;
            e.preventDefault();
            e.stopPropagation();
            b.pasteImageFile(f);
            return;
        }
    }, true);
}

// ═══════════════ 工作流运行前自动同步画板 ═══════════════
// 后端经 input 目录文件读取画板图像，画布改动后若未导出，运行用的就是旧图；
// 因此在任何运行提交前，把所有「有未导出改动」的画板自动合成上传一次
async function syncBoardsBeforeRun() {
    for (const b of [...BOARDS]) {
        if (b.destroyed || !b._outDirty) continue;
        try {
            await b.exportNow();
            if (!b.destroyed) b.setStatus("运行前已自动输出最新画布");
        } catch (err) {
            console.error("[WP_Canvas] 运行前自动输出失败", err);
        }
    }
}

// 拦截队列提交入口：api.fetchApi 是新旧前端提交 /prompt 的必经之路
let _queuePatched = false;
function patchQueueSync() {
    if (_queuePatched || !api || typeof api.fetchApi !== "function") return;
    _queuePatched = true;
    const orig = api.fetchApi.bind(api);
    api.fetchApi = async function (route, options) {
        const rt = String(route || "");
        const method = options && options.method ? String(options.method).toUpperCase() : "";
        if (rt.endsWith("/prompt") && method === "POST") {
            try { await syncBoardsBeforeRun(); } catch (err) { console.error("[WP_Canvas] 运行前自动输出失败", err); }
        }
        return orig(route, options);
    };
}

// ═══════════════ 扩展注册 ═══════════════
app.registerExtension({
    name: "WP_Node.SimpleCanvas",

    async setup() {
        installGlobalHandlers();
        patchQueueSync();
    },

    // 新版前端的队列前置钩子（旧版无此钩子自动忽略；与 fetchApi 拦截双保险，画板已干净时为空操作）
    async beforeQueued() {
        try { await syncBoardsBeforeRun(); } catch (err) { console.error("[WP_Canvas] 运行前自动输出失败", err); }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            this._wpBoard = new WPCanvasBoard(this);
            this.setSize([DEFAULT_NODE_SIZE[0], DEFAULT_NODE_SIZE[1]]);
            return r;
        };

        // 工作流加载/复制节点：从 properties 恢复画布
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            if (this._wpBoard && this.properties && this.properties.wpCanvasData) {
                this._wpBoard.restore(this.properties.wpCanvasData);
            }
            return r;
        };

        // 保存工作流：立即写入最新画布数据（防抖未触发时兜底）
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            const r = onSerialize ? onSerialize.apply(this, arguments) : undefined;
            if (this._wpBoard && !this._wpBoard.destroyed) {
                try {
                    const s = this._wpBoard.serializeNow();
                    if (s) {
                        data.properties = data.properties || {};
                        data.properties.wpCanvasData = s;
                        this.properties.wpCanvasData = s;
                    }
                } catch (err) { console.error("[WP_Canvas] 序列化失败", err); }
            }
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const r = onRemoved ? onRemoved.apply(this, arguments) : undefined;
            if (this._wpBoard) {
                this._wpBoard.destroy();
                this._wpBoard = null;
            }
            return r;
        };
    },
});

console.log("[WP_Node] 简易画板扩展已加载（节点内嵌画板 v2：画笔/橡皮/形状/文字 + Ctrl+V 粘贴图片 + 分割工具 + 三层合成输出）");
