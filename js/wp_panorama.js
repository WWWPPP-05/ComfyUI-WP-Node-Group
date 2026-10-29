import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ═══════════════════════════════════════════════
// 🐳 WP 全景图预览 · 前端扩展
// 本地内置 Pannellum，全景画面直接嵌入节点内部显示
// ═══════════════════════════════════════════════

const NODE_NAME = "WP_PanoramaView";
const PURPLE = "#662ad5";
const DEFAULT_SIZE = [1024, 512]; // 新建节点默认尺寸：宽1024 × 高512
const RATIO_MAP = {
    "1:1": 1,
    "2:3": 2 / 3,
    "3:4": 3 / 4,
    "9:16": 9 / 16,
    "3:2": 3 / 2,
    "4:3": 4 / 3,
    "16:9": 16 / 9,
    "21:9": 21 / 9,
};
const EMPTY_TITLE = "🗺️ 暂无全景图";
const EMPTY_HINT = "请先将全景图接入输入端口并运行工作流，再重新打开预览（需 2:1 等距圆柱投影全景图）";
const HELP_TEXT = "拖拽旋转 · 滚轮缩放 · 紫色框为输出范围";
const MIN_HFOV = 30;
const MAX_HFOV = 150;
const SHOT_MAX_EDGE = 1536; // 截图输出最大边像素（较小边按比例自动计算，与节点大小无关）

function imageDataToUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${encodeURIComponent(data.subfolder || "")}`
    );
}

function tryCall(fn) {
    try {
        fn();
    } catch (e) {
        /* 忽略查看器接口异常 */
    }
}

// ── Pannellum 本地加载（vendor 目录，离线可用）──
let pannellumPromise = null;

function loadPannellum() {
    if (window.pannellum) return Promise.resolve();
    if (pannellumPromise) return pannellumPromise;
    pannellumPromise = new Promise((resolve, reject) => {
        const base = new URL("vendor/", import.meta.url);
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = new URL("pannellum.css", base).href;
        document.head.appendChild(link);
        const script = document.createElement("script");
        script.src = new URL("pannellum.js", base).href;
        script.onload = () => (window.pannellum ? resolve() : reject(new Error("window.pannellum 缺失")));
        script.onerror = () => {
            pannellumPromise = null;
            reject(new Error("pannellum.js 加载失败"));
        };
        document.head.appendChild(script);
    });
    return pannellumPromise;
}

// ── 样式 ──
function injectStyle() {
    if (document.getElementById("wp-pano-style")) return;
    const style = document.createElement("style");
    style.id = "wp-pano-style";
    style.textContent = `
.wp-pano-inline{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:200px;background:#000;overflow:hidden;font-family:inherit;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;}
.wp-pano-inline .wp-pano-view{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;}
.wp-pano-inline .wp-pano-container{position:absolute;inset:0;}
.wp-pano-inline .wp-pano-frame{position:absolute;border:3px solid ${PURPLE};box-shadow:0 0 0 9999px rgba(0,0,0,.4);pointer-events:none;transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease;z-index:3;}
.wp-pano-inline .wp-pano-frame-label{position:absolute;top:8px;right:8px;background:${PURPLE};color:#fff;font-size:12px;line-height:1;padding:4px 8px;border-radius:4px;white-space:nowrap;}
.wp-pano-inline .wp-pano-empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;color:#a89fd0;background:rgba(10,8,20,.62);z-index:4;text-align:center;padding:16px;}
.wp-pano-inline .wp-pano-empty-title{font-size:16px;}
.wp-pano-inline .wp-pano-empty-sub{font-size:12.5px;line-height:1.7;max-width:92%;color:#8f86b8;}
.wp-pano-inline .wp-pano-ctrl{position:absolute;top:8px;right:8px;z-index:5;display:flex;gap:4px;}
.wp-pano-inline .wp-pano-ctrl button{width:30px;height:30px;border-radius:6px;background:rgba(22,16,42,.82);border:1px solid rgba(102,42,213,.55);color:#d8d2f2;font-size:15px;line-height:1;cursor:pointer;padding:0;font-family:inherit;}
.wp-pano-inline .wp-pano-ctrl button:hover{background:${PURPLE};color:#fff;}
.wp-pano-inline .wp-pano-actions{flex:0 0 auto;display:flex;padding:6px;}
.wp-pano-inline .wp-pano-actions.top{padding-bottom:3px;}
.wp-pano-inline .wp-pano-actions.bottom{padding-top:3px;}
.wp-pano-inline .wp-pano-actions button{flex:1 1 auto;height:30px;border:0;border-radius:6px;color:#fff;font-size:13px;line-height:1;font-family:inherit;letter-spacing:.5px;cursor:pointer;padding:0;}
.wp-pano-inline .wp-pano-actions button:active{transform:translateY(1px);}
.wp-pano-inline .wp-pano-btn-purple{background:${PURPLE};}
.wp-pano-inline .wp-pano-btn-purple:hover{background:#7736ea;}
.wp-pano-inline .wp-pano-btn-blue{background:#2a68d5;}
.wp-pano-inline .wp-pano-btn-blue:hover{background:#3a79ea;}
.wp-pano-inline .wp-pano-status{position:absolute;left:0;right:0;bottom:0;z-index:5;background:rgba(12,9,24,.82);color:#cfc8ee;font-size:12px;line-height:1.5;padding:3px 10px;pointer-events:none;min-height:20px;box-sizing:border-box;}
.wp-pano-inline .wp-pano-status.ok{color:#6fe0a0;}
.wp-pano-inline .wp-pano-status.err{color:#ff8b8b;}
.wp-pano-inline .wp-pano-status.warn{color:#ffc46b;}
.wp-pano-inline .wp-pano-container canvas{position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;display:block!important;}
.wp-pano-inline .pnlm-ui{pointer-events:none!important;}
.wp-pano-inline.wp-pano-dragging{cursor:grabbing!important;}
`;
    document.head.appendChild(style);
}

// ── 节点内显示区（DOM 挂件，弹性填充节点剩余高度）──
function createPanoUI(node) {
    if (node._pano) return;
    injectStyle();

    const wrap = document.createElement("div");
    wrap.className = "wp-pano-inline";

    // 预览视口：占据两条按钮栏之外的全部高度（取景框、空态、重置按钮、状态栏都在其内）
    const view = document.createElement("div");
    view.className = "wp-pano-view";

    const container = document.createElement("div");
    container.className = "wp-pano-container";

    const frame = document.createElement("div");
    frame.className = "wp-pano-frame";
    const frameLabel = document.createElement("span");
    frameLabel.className = "wp-pano-frame-label";
    frame.appendChild(frameLabel);

    const empty = document.createElement("div");
    empty.className = "wp-pano-empty";
    const emptyTitle = document.createElement("div");
    emptyTitle.className = "wp-pano-empty-title";
    emptyTitle.textContent = EMPTY_TITLE;
    const emptySub = document.createElement("div");
    emptySub.className = "wp-pano-empty-sub";
    emptySub.textContent = EMPTY_HINT;
    empty.append(emptyTitle, emptySub);

    const ctrl = document.createElement("div");
    ctrl.className = "wp-pano-ctrl";
    const resetBtn = mkCtrlBtn("⟳", "恢复缩放100%（保持当前视角）");
    ctrl.append(resetBtn);

    const status = document.createElement("div");
    status.className = "wp-pano-status";

    // 顶部操作栏：截图并输出（蓝色）——位置与原按钮一致（预览界面之上）
    const topBar = document.createElement("div");
    topBar.className = "wp-pano-actions top";
    const capBtn = document.createElement("button");
    capBtn.type = "button";
    capBtn.className = "wp-pano-btn wp-pano-btn-blue";
    capBtn.textContent = "📸 截图并输出";
    topBar.append(capBtn);

    // 底部操作栏：启动全景预览（紫色）——位于预览界面下方
    const bottomBar = document.createElement("div");
    bottomBar.className = "wp-pano-actions bottom";
    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "wp-pano-btn wp-pano-btn-purple";
    startBtn.textContent = "▶ 启动全景预览";
    bottomBar.append(startBtn);

    view.append(container, frame, ctrl, empty, status);
    wrap.append(topBar, view, bottomBar);

    // ── 自研交互层：拖拽旋转 + 滚轮缩放 ──
    // Pannellum 内部事件机制与 ComfyUI 挂件系统冲突，改为在捕获阶段接管指针事件，
    // 通过 setPointerCapture 保证拖拽期间事件直达本容器（画布无法抢占），再驱动 viewer API
    let drag = null;
    wrap.addEventListener(
        "pointerdown",
        (e) => {
            const p = node._pano;
            if (!p || !p.viewer || e.button !== 0) return;
            // 点击按钮时不接管：捕获阶段先于按钮执行，须放行事件让按钮自身监听器响应
            if (e.target.closest && e.target.closest(".wp-pano-btn")) return;
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: 0, pitch: 0, hfov: 100 };
            try {
                drag.yaw = p.viewer.getYaw();
                drag.pitch = p.viewer.getPitch();
                drag.hfov = p.viewer.getHfov();
            } catch (err) {}
            try {
                wrap.setPointerCapture(e.pointerId);
            } catch (err) {}
            wrap.classList.add("wp-pano-dragging");
            e.stopPropagation();
            e.preventDefault();
        },
        { capture: true }
    );
    wrap.addEventListener(
        "pointermove",
        (e) => {
            const p = node._pano;
            if (!p || !p.viewer || !drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            drag.x = e.clientX;
            drag.y = e.clientY;
            const w = p.view.clientWidth || 1;
            const h = p.view.clientHeight || 1;
            const k = drag.hfov * 1.2;
            drag.yaw -= (dx / w) * k;
            drag.pitch = Math.max(-89.5, Math.min(89.5, drag.pitch + (dy / h) * k));
            // rAF 节流：指针事件可达 120+/秒，合并为每帧一次应用，保证大节点拖拽流畅
            if (!drag.raf) {
                drag.raf = requestAnimationFrame(() => {
                    drag.raf = 0;
                    tryCall(() => p.viewer.setYaw(drag.yaw, false));
                    tryCall(() => p.viewer.setPitch(drag.pitch, false));
                });
            }
            e.stopPropagation();
        },
        { capture: true }
    );
    const endDrag = (e) => {
        if (!drag) return;
        if (drag.raf) cancelAnimationFrame(drag.raf);
        drag = null;
        wrap.classList.remove("wp-pano-dragging");
        try {
            wrap.releasePointerCapture(e.pointerId);
        } catch (err) {}
        e.stopPropagation();
    };
    wrap.addEventListener("pointerup", endDrag, { capture: true });
    wrap.addEventListener("pointercancel", endDrag, { capture: true });
    wrap.addEventListener(
        "wheel",
        (e) => {
            const p = node._pano;
            if (!p || !p.viewer) return;
            tryCall(() => {
                // 步长 6%：平滑细腻的缩放；false：立即生效无动画延迟
                const f = e.deltaY > 0 ? 1.06 : 1 / 1.06;
                p.viewer.setHfov(Math.max(MIN_HFOV, Math.min(MAX_HFOV, p.viewer.getHfov() * f)), false);
            });
            e.stopPropagation();
            e.preventDefault();
        },
        { capture: true, passive: false }
    );

    const widget = node.addDOMWidget("wp_pano", "wp_pano_custom", wrap, {
        serialize: false,
        hideOnZoom: false,
        // 弹性布局（与项目内聊天面板同一机制）：自动填满节点剩余高度，最小不低于 240
        getMinHeight: () => 240,
    });
    widget.serialize = false;

    node._pano = { wrap, view, container, frame, frameLabel, empty, ctrl, status, viewer: null, viewerUrl: null, lastViewState: null, started: false, widget };

    // 初始为空态：显示标准化提示，隐藏取景框与缩放按钮
    hideChrome(node);

    resetBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = node._pano;
        // 仅恢复缩放至 100%（hfov=100），保持当前视角（yaw/pitch）不变
        if (p && p.viewer) tryCall(() => p.viewer.setHfov(100, false));
    });

    // 顶部/底部操作按钮：拖拽层已在捕获阶段放行，这里阻止冒泡避免画布同时响应
    capBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    startBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    capBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        capture(node);
    });
    startBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startPreview(node);
    });

    // 节点尺寸变化 → 同步查看器与取景框
    new ResizeObserver(() => {
        const p = node._pano;
        if (!p) return;
        if (p.viewer) {
            tryCall(() => p.viewer.resize());
            fixCanvasSize(node);
        }
        layoutFrame(node);
    }).observe(view);
}

// 兜底：Pannellum canvas 布局尺寸与容器不一致时强制修正（修复画面只显示一条细带）
function fixCanvasSize(node) {
    const p = node._pano;
    if (!p || !p.container) return;
    const canvas = p.container.querySelector("canvas");
    if (!canvas) return;
    if (canvas.clientWidth !== p.container.clientWidth || canvas.clientHeight !== p.container.clientHeight) {
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        if (p.viewer) tryCall(() => p.viewer.resize());
    }
}

function mkCtrlBtn(text, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wp-pano-btn";
    b.textContent = text;
    b.title = title || "";
    return b;
}

function showChrome(node) {
    const p = node._pano;
    if (!p) return;
    p.frame.style.display = "";
    p.ctrl.style.display = "";
}

function hideChrome(node) {
    const p = node._pano;
    if (!p) return;
    p.frame.style.display = "none";
    p.ctrl.style.display = "none";
}

function setStatus(node, text, kind) {
    const p = node._pano;
    if (!p) return;
    p.status.textContent = text;
    p.status.className = "wp-pano-status" + (kind ? " " + kind : "");
}

function getRatioInfo(node) {
    const w = node.widgets ? node.widgets.find((x) => x.name === "输出比例") : null;
    const label = w && w.value ? String(w.value) : "1:1";
    return { label, value: RATIO_MAP[label] || 1 };
}

// 读取参数【截图最大边像素】（数值异常或旧值超范围时回退默认 1536）
function getShotMaxEdge(node) {
    const w = node.widgets ? node.widgets.find((x) => x.name === "截图最大边像素") : null;
    const v = Math.round(Number(w && w.value));
    return Number.isFinite(v) && v >= 64 ? v : SHOT_MAX_EDGE;
}

// 按输出比例换算截图尺寸：长边 = 设定值，短边按比例自动计算
function shotSize(node) {
    const { value: ratio } = getRatioInfo(node);
    const m = getShotMaxEdge(node);
    return ratio >= 1
        ? { w: m, h: Math.max(2, Math.round(m / ratio)) }
        : { w: Math.max(2, Math.round(m * ratio)), h: m };
}

// ── 紫色取景框布局（居中 + 按比例自适应）──
function layoutFrame(node) {
    const p = node._pano;
    if (!p || !p.frame || !p.viewer) return;
    const vw = p.view.clientWidth;
    const vh = p.view.clientHeight;
    if (!vw || !vh) return;

    const { label: ratioLabel, value: ratio } = getRatioInfo(node);
    const margin = Math.max(14, Math.round(Math.min(vw, vh) * 0.07));
    const availW = Math.max(10, vw - margin * 2);
    const availH = Math.max(10, vh - margin * 2);
    let w, h;
    if (availW / availH > ratio) {
        h = availH;
        w = h * ratio;
    } else {
        w = availW;
        h = w / ratio;
    }
    const st = p.frame.style;
    st.left = Math.round((vw - w) / 2) + "px";
    st.top = Math.round((vh - h) / 2) + "px";
    st.width = Math.round(w) + "px";
    st.height = Math.round(h) + "px";

    // 标签显示实际输出尺寸：长边 =【截图最大边像素】，短边按比例自动计算
    const { w: ow, h: oh } = shotSize(node);
    p.frameLabel.textContent = `${ratioLabel} · 输出 ${ow}×${oh}px`;
}

// ── 全景查看器 ──
function destroyViewer(node) {
    const p = node._pano;
    if (!p) return;
    if (p.viewer) {
        try {
            p.lastViewState = { yaw: p.viewer.getYaw(), pitch: p.viewer.getPitch(), hfov: p.viewer.getHfov() };
        } catch (e) {}
        tryCall(() => p.viewer.destroy());
        p.viewer = null;
    }
    p.container.innerHTML = "";
    p.viewerUrl = null;
}

function showPanorama(node, url, keepView) {
    const p = node._pano;
    if (!p) return;
    destroyViewer(node);
    p.empty.style.display = "none";
    showChrome(node);
    setStatus(node, "正在加载全景图…", "");

    const vs = keepView && p.lastViewState ? p.lastViewState : { yaw: 0, pitch: 0, hfov: 100 };

    // 延迟到浏览器布局完成后创建查看器，确保容器有正确尺寸
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const cw = p.container.clientWidth;
            const ch = p.container.clientHeight;
            if (!cw || !ch) {
                // 容器尚未布局（极端情况），稍后再试
                setTimeout(() => showPanorama(node, url, keepView), 120);
                return;
            }
            // vendor 库已改：WebGL 上下文开启 preserveDrawingBuffer，截图可稳定读取画布
            p.viewer = window.pannellum.viewer(p.container, {
                type: "equirectangular",
                panorama: url,
                autoLoad: true,
                showControls: false,
                compass: false,
                yaw: vs.yaw,
                pitch: vs.pitch,
                hfov: vs.hfov,
                minHfov: MIN_HFOV,
                maxHfov: MAX_HFOV,
            });
            p.viewerUrl = url;
            // 创建后立即 resize 一次，再在图像加载完成后再 resize 一次
            p.viewer.resize();
            fixCanvasSize(node);
            p.viewer.on("load", () => {
                p.viewer.resize();
                fixCanvasSize(node);
                layoutFrame(node);
                setStatus(node, HELP_TEXT, "");
            });
            p.viewer.on("error", (msg) => {
                console.error("[WP_Panorama] 全景图加载失败", msg);
                setStatus(node, "全景图加载失败：" + (msg || "图像无法读取"), "err");
            });
            layoutFrame(node);
        });
    });
}

async function startPreview(node) {
    try {
        await loadPannellum();
    } catch (e) {
        console.error("[WP_Panorama] Pannellum 加载失败", e);
        setStatus(node, "全景库加载失败，请查看控制台日志", "err");
        return;
    }
    const p = node._pano;
    if (!p) return;
    p.started = true;
    const hasInput = node.inputs && node.inputs.some((i) => i.name === "image" && i.link != null);

    if (node._panoLatest) {
        // 先显示缓存图（避免闪空态），再自动运行拿最新图，回传后热更新
        showPanorama(node, node._panoLatest, false);
    } else if (hasInput) {
        p.empty.style.display = "flex";
        hideChrome(node);
        setStatus(node, "正在运行工作流获取全景图…", "");
    } else {
        // 未连接输入：标准化提示（在节点显示区内展示）
        p.empty.style.display = "flex";
        hideChrome(node);
        setStatus(node, "暂无全景图：请先将全景图接入输入端口", "warn");
        return;
    }

    // 已连接输入：总是重新运行（输入换图后也能拿到最新；上游有执行缓存，很快）
    if (hasInput) {
        try {
            await app.queuePrompt();
        } catch (err) {
            if (!node._panoLatest) setStatus(node, "自动运行失败，请手动运行工作流后再点击本按钮", "err");
        }
    }
}

// ── 截图 ──
function isBlank(ctx, canvas) {
    const w = Math.min(canvas.width, 48);
    const h = Math.min(canvas.height, 48);
    if (!w || !h) return true;
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) {
        if (d[i] !== 0) return false;
    }
    return true;
}

// ── 截图：离屏全分辨率渲染 ──
// 在隐藏容器中按目标尺寸重建同一视角的全景渲染，截图尺寸只由「输出比例 + 截图最大边像素」决定，
// 与节点大小无关；清晰度上限取决于原始全景图分辨率

async function renderShot(node) {
    const p = node._pano;
    if (!p.viewer || !p.viewerUrl) return null;
    // 紫框布局尺寸（用于推算局部视野），紫框始终居中 → 视角无偏移
    const fw = p.frame.offsetWidth;
    const fh = p.frame.offsetHeight;
    if (fw < 4 || fh < 4) return null;

    // 目标尺寸：长边 = 参数【截图最大边像素】，短边按输出比例自动计算
    const { w: tw, h: th } = shotSize(node);

    // 紫框局部水平视场角（透视投影：线性于 tan 半角）
    const hfov = p.viewer.getHfov();
    const cw = p.container.clientWidth || 1;
    const rad = Math.PI / 180;
    let hfovF = 2 * Math.atan(Math.tan((hfov * rad) / 2) * (fw / cw)) / rad;

    // 移出视口的隐藏容器（WebGL 正常渲染，不干扰页面）
    const holder = document.createElement("div");
    holder.style.cssText = `position:fixed;left:-20000px;top:0;width:${tw}px;height:${th}px;overflow:hidden;`;
    document.body.appendChild(holder);

    // 离屏出图需要达到目标像素：临时放宽 vendor 的画布缓冲上限（节点内交互视图仍保持 2560 上限）
    const prevCap = window.__wpPanoMaxBuffer;
    window.__wpPanoMaxBuffer = 8192;

    let viewer2 = null;
    try {
        viewer2 = window.pannellum.viewer(holder, {
            type: "equirectangular",
            panorama: p.viewerUrl,
            autoLoad: true,
            showControls: false,
            compass: false,
            yaw: p.viewer.getYaw(),
            pitch: p.viewer.getPitch(),
            hfov: Math.max(5, Math.min(180, hfovF)),
            minHfov: 5,
            maxHfov: 180,
        });
        await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error("离屏渲染超时")), 10000);
            viewer2.on("load", () => {
                clearTimeout(to);
                resolve();
            });
            viewer2.on("error", (m) => {
                clearTimeout(to);
                reject(new Error(m || "全景图加载失败"));
            });
        });
        tryCall(() => viewer2.resize());
        // 等渲染帧完成
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const src = holder.querySelector("canvas");
        if (!src || !src.width) return null;
        const crop = document.createElement("canvas");
        crop.width = tw;
        crop.height = th;
        const ctx = crop.getContext("2d");
        // 源缓冲可能因 dpr 大于目标，统一缩放到标准尺寸
        ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, tw, th);
        return isBlank(ctx, crop) ? null : crop;
    } finally {
        window.__wpPanoMaxBuffer = prevCap;
        tryCall(() => viewer2 && viewer2.destroy && viewer2.destroy());
        holder.remove();
    }
}

async function queueAfterCapture(node) {
    setStatus(node, "截图已保存，正在自动运行工作流…", "");
    try {
        await app.queuePrompt();
    } catch (err) {
        setStatus(node, "自动运行失败，请手动运行工作流", "err");
    }
}

async function capture(node) {
    const p = node._pano;
    if (!p) return;
    if (node._panoBusy) return;
    if (!p.viewer || !p.viewerUrl) {
        setStatus(node, "暂无全景图，无法截图", "err");
        return;
    }
    node._panoBusy = true;
    try {
        setStatus(node, "正在截图…", "");
        const crop = await renderShot(node);
        if (!crop) throw new Error("画布捕获失败（内容为空）");
        const blob = await new Promise((res) => crop.toBlob((b) => res(b), "image/png"));
        if (!blob) throw new Error("图像编码失败");

        // 文件名带节点ID：Python 端按此前缀自动查找本节点最新截图（无需可见参数传递）
        const name = `WP.pano.capture.n${node.id}.${Date.now()}.png`;
        const body = new FormData();
        body.append("image", blob, name);
        body.append("type", "input");
        body.append("overwrite", "true");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body });
        if (!resp.ok) throw new Error(`上传失败 HTTP ${resp.status}`);

        tryCall(() => node.setDirtyCanvas(true, true));
        await queueAfterCapture(node);
    } catch (err) {
        console.error("[WP_Panorama] 截图失败", err);
        setStatus(node, `截图失败：${err && err.message ? err.message : err}`, "err");
    } finally {
        node._panoBusy = false;
    }
}

// ── 扩展注册 ──
// 节点执行报错时，在状态栏明确提示（避免无声卡住）
api.addEventListener("execution_error", (e) => {
    const d = e.detail || {};
    const node = app.graph && app.graph.getNodeById(d.node_id);
    if (node && node.type === NODE_NAME && node._pano) {
        setStatus(node, `运行失败：${d.exception_message || "节点执行出错"}`, "err");
    }
});

app.registerExtension({
    name: "WP_Node.PanoramaView",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            this._panoLatest = null;
            this._panoBusy = false;

            // 默认尺寸：宽1024 × 高512（已保存工作流加载后会还原用户手动调整的尺寸）
            this.setSize([DEFAULT_SIZE[0], DEFAULT_SIZE[1]]);

            // 节点内显示区（DOM 挂件）：内含顶部蓝色「截图并输出」与底部紫色「启动全景预览」
            createPanoUI(this);

            // 比例下拉变化 → 重排紫色取景框
            const self = this;
            const ratioWidget = this.widgets ? this.widgets.find((x) => x.name === "输出比例") : null;
            if (ratioWidget) {
                const origCB = ratioWidget.callback;
                ratioWidget.callback = function () {
                    const rr = origCB ? origCB.apply(this, arguments) : undefined;
                    layoutFrame(self);
                    return rr;
                };
            }
            // 最大边像素变化 → 同步取景框标签上显示的输出尺寸
            const maxEdgeWidget = this.widgets ? this.widgets.find((x) => x.name === "截图最大边像素") : null;
            if (maxEdgeWidget) {
                const origEdgeCB = maxEdgeWidget.callback;
                maxEdgeWidget.callback = function () {
                    const rr = origEdgeCB ? origEdgeCB.apply(this, arguments) : undefined;
                    layoutFrame(self);
                    return rr;
                };
            }
            return r;
        };

        // 旧工作流兼容：旧参数【截图宽度】默认值为 0，超出新范围时归位为默认值
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            const w = this.widgets ? this.widgets.find((x) => x.name === "截图最大边像素") : null;
            if (w && !(Number(w.value) >= 64)) w.value = SHOT_MAX_EDGE;
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
            const m = message || {};

            if (Array.isArray(m.pano_images) && m.pano_images.length > 0) {
                this._panoLatest = imageDataToUrl(m.pano_images[0]);
                const p = this._pano;
                // 预览启动过：尚未显示或源图变化时自动加载/热更新（变化时保持当前视角）
                if (p && p.started) {
                    if (p.viewerUrl) {
                        if (p.viewerUrl !== this._panoLatest) showPanorama(this, this._panoLatest, true);
                    } else {
                        showPanorama(this, this._panoLatest, false);
                    }
                }
            }

            if (typeof m.capture === "string" && m.capture) {
                setStatus(this, `✅ 截图已输出到「图像」端口（${m.capture.split("/").pop()}）`, "ok");
            }
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const r = onRemoved ? onRemoved.apply(this, arguments) : undefined;
            const p = this._pano;
            if (p) {
                destroyViewer(this);
                try {
                    p.wrap.remove();
                } catch (e) {}
                this._pano = null;
            }
            return r;
        };
    },
});

console.log("[WP_Node] 全景图预览扩展已加载（节点内嵌模式 v7：蓝/紫按钮 + 截图最大边像素可调）");
