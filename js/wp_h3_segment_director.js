/**
 * 🐳 WP H3分段编排节点 - 多段卡片式 UI 前端（DOM 版）
 *
 * 用 addDOMWidget 渲染真实 HTML 卡片列表：点 + 加段 / × 删段，
 * 每段独立配置提示词 / 时长 / LoRA / 参考图 / 衔接上下文。
 * 参考图采用 3 列宫格 + 虚线占位槽 + 底部「展开更多 (+3)」通栏按钮，最多 9 张。
 * 数据实时序列化进后端隐藏 widget `segments_json`。
 *
 * 数据源策略：单一数据源 node._wpSegs 持有分段数组，
 * 所有增删改直接操作该数组，再 writeSegments 序列化写回 widget，
 * 彻底避免「内存对象 与 widget.value 不同步」导致增删失效的问题。
 */
import { app } from "../../scripts/app.js";

const NODE_TYPE = "WP_H3SegmentDirector";
const JSON_WIDGET = "segments_json";

const CTX_OPTIONS = ["5", "22", "39", "56"];
const MIN_WIDTH = 520;
const MAX_REF_IMAGES = 9;      // 参考图上限

function defaultSegment() {
    return {
        prompt: "",
        duration: 5.0,
        loras: [{ name: "", strength: 1.0 }],  // 多 LoRA 列表（默认一行空 LoRA）
        ref_images: [""],  // 默认 1 个空槽位（填入后动态追加下一个）
        ref_videos: [],
        ref_audios: [],
        context_frames: 22,
        seam_redraw: 0.10,          // 接缝重绘幅度（桥接用）
        collapsed: false,           // 卡片折叠状态
    };
}

const isTarget = (n) => n && n.type === NODE_TYPE;

// ── 公共参数（带开关，默认关闭；内容只含 提示词 + 参考图/视频/音频） ──
function defaultCommon() {
    return {
        _common: true,
        enabled: false,          // 默认关闭
        collapsed: false,        // 卡片折叠状态（与分段卡一致）
        prompt: "",
        ref_images: [""],
        ref_videos: [],
        ref_audios: [],
    };
}

// 读取公共参数对象（单一数据源 node._wpCommon）
function getCommon(node) {
    if (!node._wpCommon || typeof node._wpCommon !== "object") {
        node._wpCommon = defaultCommon();
    }
    return node._wpCommon;
}

// ── 单一数据源：node._wpSegs ──
function getSegs(node) {
    if (!Array.isArray(node._wpSegs)) node._wpSegs = [];
    return node._wpSegs;
}

function loadSegs(node) {
    const w = node.widgets?.find((x) => x && x.name === JSON_WIDGET);
    let arr = [];
    try {
        const v = w?.value || "[]";
        const parsed = JSON.parse(v);
        arr = Array.isArray(parsed) ? parsed : [];
    } catch (e) { arr = []; }

    // 抽出公共参数段（_common:true）到 node._wpCommon，其余作为分段
    let common = null;
    const segArr = [];
    for (const s of arr) {
        if (s && typeof s === "object" && s._common) {
            if (!common) common = s;
        } else {
            segArr.push(s);
        }
    }
    if (common) {
        const dc = defaultCommon();
        const c = {};
        for (const k in dc) c[k] = (common[k] !== undefined && common[k] !== null) ? common[k] : dc[k];
        node._wpCommon = c;
    } else {
        node._wpCommon = defaultCommon();
    }

    arr = segArr;
    if (arr.length === 0) arr = [defaultSegment()];
    // 补齐缺省字段 + 旧数据迁移（lora/lora_strength → loras 数组）
    arr = arr.map((s) => {
        const d = defaultSegment();
        const out = {};
        for (const k in d) out[k] = (s && s[k] !== undefined && s[k] !== null) ? s[k] : d[k];
        // 旧格式迁移：有 lora 字段但无 loras 数组
        if (!Array.isArray(out.loras) || out.loras.length === 0) {
            if (s && (s.lora || s.lora_strength !== undefined)) {
                out.loras = [{ name: s.lora || "", strength: s.lora_strength ?? 1.0 }];
            } else if (!Array.isArray(out.loras)) {
                out.loras = [{ name: "", strength: 1.0 }];
            }
        }
        // 参考图收敛：裁掉末尾多余空槽，只保留「已填数 + 1 个空槽」（动态追加逻辑）
        if (Array.isArray(out.ref_images)) {
            const imgs = out.ref_images.map((x) => (x == null ? "" : String(x).trim()));
            // 找到最后一个非空槽的位置
            let lastFilled = -1;
            for (let i = 0; i < imgs.length; i++) if (imgs[i]) lastFilled = i;
            // 保留到 lastFilled+2（即已填槽 + 紧随的 1 个空槽），至少 1 个
            const keep = Math.max(1, lastFilled + 2);
            const trimmed = imgs.slice(0, keep);
            while (trimmed.length < keep) trimmed.push("");  // 补足末尾空槽
            while (trimmed.length < 1) trimmed.push("");
            out.ref_images = trimmed;
        }
        return out;
    });
    node._wpSegs = arr;
    return arr;
}

function saveSegs(node) {
    const segs = getSegs(node);
    const common = getCommon(node);
    const w = node.widgets?.find((x) => x && x.name === JSON_WIDGET);
    if (w) {
        const old = w.value;
        // 公共参数前置：[_common, seg1, seg2, ...]
        const payload = [common, ...segs];
        const next = JSON.stringify(payload);
        w.value = next;
        // 关键：新版 ComfyUI 前端用 onWidgetChanged + graph.incrementVersion 通知序列化/持久化，
        // 旧版 graph.change() 已失效，直接改 value 不触发状态快照，导致切画布后数据丢失。
        try { w.callback?.(next); } catch (_) {}
        try { node.onWidgetChanged?.(JSON_WIDGET, next, old, w); } catch (_) {}
        // incrementVersion 会触发整个 graph 重新序列化/重绘，代价高；
        // 用 rAF 合并，同帧内多次 saveSegs 只触发一次，避免输入时卡顿。
        if (!node._wpVerPending) {
            node._wpVerPending = true;
            requestAnimationFrame(() => {
                node._wpVerPending = false;
                try { node.graph?.incrementVersion?.(); } catch (_) {}
                try { node.setDirtyCanvas?.(true, true); } catch (_) {}
            });
        }
    }
}

// ── LoRA 列表 ──
let _loraCache = null;
async function fetchLoras() {
    if (_loraCache) return _loraCache;
    try {
        const resp = await fetch("/api/loras");
        if (resp.ok) {
            const data = await resp.json();
            _loraCache = Array.isArray(data) ? data.map((d) => d.name || d) : [];
        } else throw new Error("bad status");
    } catch (e) {
        try {
            const r2 = await fetch("/object_info/WP_LoRAStackLoader");
            if (r2.ok) {
                const info = await r2.json();
                const req = info?.WP_LoRAStackLoader?.input?.required || {};
                const def = req["LoRA_01"] || req["LoRA_1"];
                _loraCache = def && Array.isArray(def[0]) ? def[0] : [];
            }
        } catch (_) { _loraCache = []; }
    }
    return _loraCache;
}

// ── 内联样式 ──
let _styleInjected = false;
function injectStyle() {
    if (_styleInjected) return;
    _styleInjected = true;
    const css = `
.wp-seg-host{box-sizing:border-box;padding:8px;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:#d8d4cd;background:transparent;}
.wp-seg-host *{box-sizing:border-box;}
.wp-seg-add{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:30px;margin-bottom:8px;border:1px solid rgba(110,168,255,.55);border-radius:7px;background:rgba(110,168,255,.14);color:#6ea8ff;font-size:12px;font-weight:600;cursor:pointer;transition:background .12s;}
.wp-seg-add:hover{background:rgba(110,168,255,.24);}
.wp-seg-card{border:1px solid rgba(255,255,255,.10);border-radius:9px;background:rgba(26,28,36,.92);margin-bottom:8px;overflow:hidden;}
.wp-seg-head{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;background:rgba(255,255,255,.045);}
.wp-seg-dot{width:8px;height:8px;border-radius:50%;background:#6ea8ff;flex:0 0 auto;}
.wp-seg-title{font-size:13px;font-weight:600;color:#e8e4dd;flex:1 1 auto;}
.wp-seg-dur{font-size:11px;color:#4ade80;background:rgba(0,0,0,.32);border-radius:9px;padding:2px 9px;flex:0 0 auto;}
.wp-seg-del{width:22px;height:22px;border-radius:50%;border:1px solid rgba(239,68,68,.55);background:rgba(239,68,68,.14);color:#ef4444;font-size:13px;line-height:1;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;}
.wp-seg-del:hover{background:rgba(239,68,68,.3);}
.wp-seg-fold{width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#c9c5bd;font-size:12px;line-height:1;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:0;}
.wp-seg-fold:hover{background:rgba(255,255,255,.12);}
.wp-seg-head{cursor:pointer;}
.wp-seg-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px;}
/* ── 左右两栏：左参数 / 右提示词 ── */
.wp-seg-main{display:flex;gap:8px;align-items:stretch;}
.wp-seg-left{flex:1 1 50%;display:flex;flex-direction:column;gap:6px;min-width:0;}
.wp-seg-right{flex:1 1 50%;display:flex;flex-direction:column;gap:3px;min-width:0;}
.wp-seg-field{display:flex;flex-direction:column;gap:3px;min-width:0;}
.wp-seg-label{font-size:10px;color:#8a8a9a;letter-spacing:.3px;}
.wp-seg-input,.wp-seg-textarea,.wp-seg-select{width:100%;background:rgba(0,0,0,.30);border:1px solid rgba(255,255,255,.08);border-radius:5px;color:#d8d4cd;font-size:12px;padding:5px 8px;outline:none;font-family:inherit;}
.wp-seg-input:focus,.wp-seg-textarea:focus,.wp-seg-select:focus{border-color:rgba(110,168,255,.5);}
.wp-seg-textarea{resize:none;line-height:1.5;width:100%;flex:1 1 auto;min-height:120px;}
.wp-seg-select{appearance:auto;}
.wp-seg-select option{background:#1a1a24;color:#d8d4cd;}
.wp-seg-row{display:flex;gap:6px;}
.wp-seg-row>div{flex:1;min-width:0;}
.wp-seg-field.disabled,.wp-seg-field.disabled .wp-seg-label{opacity:.45;}
.wp-seg-field.disabled .wp-seg-input,.wp-seg-field.disabled .wp-seg-select{background:rgba(0,0,0,.16);border-color:rgba(255,255,255,.04);color:#7a7a86;cursor:not-allowed;pointer-events:none;}

/* ── 参考图宫格区 ── */
.wp-seg-imgs{border:1px solid rgba(255,255,255,.08);border-radius:7px;background:rgba(0,0,0,.16);padding:8px;display:flex;flex-direction:column;gap:8px;}
.wp-seg-imgs-head{display:flex;align-items:center;justify-content:space-between;}
.wp-seg-imgs-title{font-size:12px;font-weight:700;color:#e8e4dd;}
.wp-seg-imgs-count{font-size:11px;color:#8a8a9a;}
.wp-seg-pick{border:1px solid rgba(255,255,255,.16);border-radius:6px;background:rgba(255,255,255,.05);color:#c9c5bd;font-size:11px;padding:3px 10px;cursor:pointer;}
.wp-seg-pick:hover{background:rgba(255,255,255,.1);}
.wp-seg-grid{display:grid;grid-template-columns:1fr;gap:8px;}
.wp-seg-grid.expanded{grid-template-columns:repeat(3,1fr);}
.wp-seg-slot{position:relative;aspect-ratio:1/1;border:1px dashed rgba(255,255,255,.22);border-radius:6px;background:rgba(0,0,0,.24);display:flex;align-items:center;justify-content:center;overflow:hidden;}
.wp-seg-slot .wp-seg-slot-idx{font-size:11px;color:#6b6b78;text-align:center;line-height:1.4;}
.wp-seg-slot-img{width:100%;height:100%;object-fit:cover;display:block;}
.wp-seg-slot-del{position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;border:1px solid rgba(239,68,68,.6);background:rgba(20,20,26,.85);color:#ef4444;font-size:12px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .12s;}
.wp-seg-slot:hover .wp-seg-slot-del{opacity:1;}
.wp-seg-slot-fill{cursor:pointer;}
.wp-seg-slot-fill:hover{border-color:rgba(110,168,255,.5);background:rgba(110,168,255,.08);}
.wp-seg-slot-over{border-color:#6ea8ff !important;background:rgba(110,168,255,.18) !important;box-shadow:0 0 0 2px rgba(110,168,255,.25) inset;}
/* 锁定槽位（继承自公共参数的参考图）：黄色边框 + 锁定角标，不可编辑 */
.wp-seg-slot-locked{border-color:rgba(255,193,7,.5);background:rgba(255,193,7,.06);cursor:default;}
.wp-seg-slot-locked:hover{border-color:rgba(255,193,7,.7);background:rgba(255,193,7,.10);}
.wp-seg-slot-lock{position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:4px;border:1px solid rgba(255,193,7,.6);background:rgba(20,20,26,.85);color:#ffc107;font-size:10px;line-height:1;display:flex;align-items:center;justify-content:center;pointer-events:none;}
/* ── 缩略图 hover 放大预览 ── */
.wp-seg-slot-img{cursor:zoom-in;}
.wp-seg-preview{position:fixed;z-index:999999;max-width:320px;max-height:320px;border:2px solid rgba(110,168,255,.6);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.55);background:#14141a;object-fit:contain;pointer-events:none;}

/* ── 参考视频 / 参考音频 列表区块 ── */
.wp-seg-media{border:1px solid rgba(255,255,255,.08);border-radius:7px;background:rgba(0,0,0,.16);padding:8px;display:flex;flex-direction:column;gap:6px;}
.wp-seg-media-head{display:flex;align-items:center;justify-content:space-between;}
.wp-seg-media-title{font-size:12px;font-weight:700;color:#e8e4dd;}
.wp-seg-media-count{font-size:11px;color:#8a8a9a;}
.wp-seg-media-add{border:1px solid rgba(255,255,255,.16);border-radius:6px;background:rgba(255,255,255,.05);color:#c9c5bd;font-size:11px;padding:3px 10px;cursor:pointer;}
.wp-seg-media-add:hover{background:rgba(255,255,255,.1);}
.wp-seg-media-list{display:flex;flex-direction:column;gap:4px;}
.wp-seg-media-empty{font-size:11px;color:#6b6b78;padding:4px 2px;}
.wp-seg-media-item{display:flex;align-items:center;gap:6px;border:1px dashed rgba(255,255,255,.18);border-radius:6px;background:rgba(0,0,0,.22);padding:4px 8px;min-height:26px;}
.wp-seg-media-name{flex:1;font-size:11px;color:#c9c5bd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wp-seg-media-del{width:18px;height:18px;border-radius:50%;border:1px solid rgba(239,68,68,.6);background:rgba(20,20,26,.85);color:#ef4444;font-size:12px;line-height:1;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;}
.wp-seg-media-del:hover{background:rgba(239,68,68,.3);}
.wp-seg-media-over{border-color:#6ea8ff !important;background:rgba(110,168,255,.18) !important;}
.wp-seg-media-thumb{width:34px;height:26px;flex:0 0 auto;border-radius:4px;overflow:hidden;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;color:#8a8a9a;font-size:14px;border:1px solid rgba(255,255,255,.08);}
.wp-seg-media-thumb img{width:100%;height:100%;object-fit:cover;display:block;}

/* ── 采样进度提示条 ── */
.wp-seg-progress{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 10px;border:1px solid rgba(110,168,255,.35);border-radius:7px;background:rgba(110,168,255,.10);font-size:11px;color:#a8c7ff;}
.wp-seg-progress .wp-seg-progress-bar{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.10);overflow:hidden;}
.wp-seg-progress .wp-seg-progress-fill{height:100%;background:linear-gradient(90deg,#6ea8ff,#4ade80);width:0%;transition:width .15s ease;border-radius:3px;}
.wp-seg-progress .wp-seg-progress-text{flex:0 0 auto;font-variant-numeric:tabular-nums;}

/* ── 公共参数卡片（开关 + 精简内容） ── */
.wp-seg-common{border:1px solid rgba(255,193,7,.30);border-radius:9px;background:rgba(30,28,22,.92);margin-bottom:8px;overflow:hidden;}
.wp-seg-common.on{border-color:rgba(255,193,7,.55);background:rgba(38,34,22,.92);}
.wp-seg-common-head{display:flex;align-items:center;gap:8px;height:36px;padding:0 10px;background:rgba(255,193,7,.06);cursor:pointer;}
.wp-seg-common-dot{width:8px;height:8px;border-radius:50%;background:#ffc107;flex:0 0 auto;}
.wp-seg-common-title{font-size:13px;font-weight:600;color:#f0dfb0;flex:1 1 auto;}
.wp-seg-common-switch{position:relative;width:34px;height:18px;border-radius:10px;background:rgba(255,255,255,.14);cursor:pointer;flex:0 0 auto;transition:background .15s;border:none;padding:0;}
.wp-seg-common-switch.on{background:#4ade80;}
.wp-seg-common-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s;}
.wp-seg-common-switch.on::after{left:18px;}
.wp-seg-common-body{padding:8px 10px 10px;display:none;}
.wp-seg-common-body.show{display:block;}
.wp-seg-common .wp-seg-main{margin-bottom:6px;}
.wp-seg-common-hint{font-size:10px;color:#b89b4d;margin-top:4px;line-height:1.4;}

/* 分段卡内继承自公共参数的媒体项（不可编辑、带锁标记） */
.wp-seg-inherited{border-style:dashed;border-color:rgba(255,193,7,.45) !important;background:rgba(255,193,7,.07) !important;opacity:.9;}
.wp-seg-inherited .wp-seg-slot-idx{color:#b89b4d;}
.wp-seg-lock{font-size:9px;color:#b89b4d;margin-left:4px;}

/* ── 多 LoRA 叠加区 ── */
.wp-seg-loras{border:1px solid rgba(255,255,255,.08);border-radius:7px;background:rgba(0,0,0,.16);padding:8px;display:flex;flex-direction:column;gap:6px;}
.wp-seg-loras-head{display:flex;align-items:center;justify-content:space-between;}
.wp-seg-loras-title{font-size:12px;font-weight:700;color:#e8e4dd;}
.wp-seg-loras-list{display:flex;flex-direction:column;gap:4px;}
.wp-seg-lora-item{display:flex;align-items:center;gap:6px;}
.wp-seg-lora-item .wp-seg-select{flex:1;min-width:0;}
.wp-seg-lora-strength{width:70px;flex:0 0 70px;}
`;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
}

// ── 构建整块 UI ──
function buildUI(node) {
    injectStyle();
    const segs = getSegs(node);

    const host = document.createElement("div");
    host.className = "wp-seg-host";
    host.dataset.wpSegHost = "1";

    // 公共参数卡片（带开关，默认关闭，位于分段列表上方）
    const commonCard = buildCommonCard(node);
    host.appendChild(commonCard);

    const addBtn = document.createElement("button");
    addBtn.className = "wp-seg-add";
    addBtn.textContent = "＋ 添加分段";
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
        getSegs(node).push(defaultSegment());
        saveSegs(node);
        rebuild(node);
    });
    host.appendChild(addBtn);

    // 采样进度提示条（默认隐藏，运行中由进度事件驱动显示）
    const progress = document.createElement("div");
    progress.className = "wp-seg-progress";
    progress.style.display = "none";
    const progBar = document.createElement("div");
    progBar.className = "wp-seg-progress-bar";
    const progFill = document.createElement("div");
    progFill.className = "wp-seg-progress-fill";
    progBar.appendChild(progFill);
    const progText = document.createElement("span");
    progText.className = "wp-seg-progress-text";
    progress.append(progBar, progText);
    host.appendChild(progress);

    const list = document.createElement("div");
    list.className = "wp-seg-list";
    segs.forEach((seg, i) => list.appendChild(buildCard(node, seg, i)));
    host.appendChild(list);

    return host;
}

// ── 公共参数卡片：开关 + 提示词 + 参考图/视频/音频 ──
function buildCommonCard(node) {
    const common = getCommon(node);
    const card = document.createElement("div");
    card.className = "wp-seg-common" + (common.enabled ? " on" : "");

    // 标题栏
    const head = document.createElement("div");
    head.className = "wp-seg-common-head";
    const dot = document.createElement("span"); dot.className = "wp-seg-common-dot";
    const title = document.createElement("span"); title.className = "wp-seg-common-title"; title.textContent = "公共参数";
    const fold = document.createElement("button");
    fold.className = "wp-seg-fold";
    fold.type = "button";
    fold.title = common.collapsed ? "展开公共参数" : "折叠公共参数";
    fold.textContent = common.collapsed ? "▸" : "▾";
    const sw = document.createElement("button");
    sw.className = "wp-seg-common-switch" + (common.enabled ? " on" : "");
    sw.type = "button";
    sw.title = common.enabled ? "关闭公共参数" : "启用公共参数";
    head.append(dot, title, fold, sw);
    card.appendChild(head);

    // 主体（默认隐藏，启用时显示；折叠时也隐藏）
    const body = document.createElement("div");
    body.className = "wp-seg-common-body" + (common.enabled && !common.collapsed ? " show" : "");

    // 左右两栏：左 = 参考图/视频/音频，右 = 提示词
    const main = document.createElement("div");
    main.className = "wp-seg-main";

    const left = document.createElement("div");
    left.className = "wp-seg-left";
    const imgBlock = buildRefImagesBlock(node, common);
    const videoBlock = buildRefMediaBlock(node, common, "ref_videos", "参考视频", "video/*");
    const audioBlock = buildRefMediaBlock(node, common, "ref_audios", "参考音频", "audio/*");
    left.append(imgBlock, videoBlock, audioBlock);

    const right = document.createElement("div");
    right.className = "wp-seg-right";
    const pl = document.createElement("div"); pl.className = "wp-seg-label"; pl.textContent = "提示词（拼接在前）";
    const pt = document.createElement("textarea"); pt.className = "wp-seg-textarea"; pt.placeholder = "公共提示词，运行时与各段提示词前后拼接…"; pt.value = common.prompt || "";
    pt.addEventListener("input", () => { common.prompt = pt.value; saveSegs(node); });
    right.append(pl, pt);

    main.append(left, right);
    body.appendChild(main);

    // 提示
    const hint = document.createElement("div");
    hint.className = "wp-seg-common-hint";
    hint.textContent = "启用后：参考图/视频/音频 会前置到每个分段卡（不可编辑）；提示词会在运行时与各段提示词前后拼接。";
    body.appendChild(hint);

    card.appendChild(body);

    // 折叠切换
    fold.addEventListener("click", (e) => {
        e.stopPropagation();
        common.collapsed = !common.collapsed;
        saveSegs(node);
        rebuild(node);
    });
    // 点标题栏空白处也可折叠（fold/sw 按钮已 stopPropagation 排除）
    head.addEventListener("click", () => {
        common.collapsed = !common.collapsed;
        saveSegs(node);
        rebuild(node);
    });

    // 开关切换
    sw.addEventListener("click", (e) => {
        e.stopPropagation();
        common.enabled = !common.enabled;
        saveSegs(node);
        rebuild(node);
    });

    return card;
}

function buildCard(node, seg, i) {
    const card = document.createElement("div");
    card.className = "wp-seg-card";

    // ── 标题栏 ──
    const head = document.createElement("div");
    head.className = "wp-seg-head";
    const dot = document.createElement("span"); dot.className = "wp-seg-dot";
    const title = document.createElement("span"); title.className = "wp-seg-title"; title.textContent = `分段 ${i + 1}`;
    const dur = document.createElement("span"); dur.className = "wp-seg-dur"; dur.textContent = `${seg.duration ?? 5.0}s`;
    const fold = document.createElement("button");
    fold.className = "wp-seg-fold";
    fold.type = "button";
    fold.title = seg.collapsed ? "展开此分段" : "折叠此分段";
    fold.textContent = seg.collapsed ? "▸" : "▾";
    const del = document.createElement("button");
    del.className = "wp-seg-del"; del.textContent = "×"; del.type = "button"; del.title = "删除此分段";
    del.addEventListener("click", () => {
        const cur = getSegs(node);
        cur.splice(i, 1);
        if (cur.length === 0) cur.push(defaultSegment());
        saveSegs(node);
        rebuild(node);
    });
    head.append(dot, title, dur, fold, del);

    // 折叠状态记忆：点标题栏任意非按钮区域也可折叠
    fold.addEventListener("click", (e) => {
        e.stopPropagation();
        seg.collapsed = !seg.collapsed;
        saveSegs(node);
        rebuild(node);
    });
    // 点标题栏空白处也可折叠（del/fold 按钮已 stopPropagation 排除）
    head.addEventListener("click", () => {
        seg.collapsed = !seg.collapsed;
        saveSegs(node);
        rebuild(node);
    });
    card.appendChild(head);

    // ── 主体 ──
    const body = document.createElement("div");
    body.className = "wp-seg-body";

    // 左右两栏容器
    const main = document.createElement("div");
    main.className = "wp-seg-main";

    // 左栏：参数（时长 / 衔接上下文 / 接缝重绘 一行 + LoRA + 参考图/视频/音频）
    const left = document.createElement("div");
    left.className = "wp-seg-left";

    // 时长 + 衔接上下文 + 接缝重绘 三参数一行
    const row1 = document.createElement("div"); row1.className = "wp-seg-row";
    const df = document.createElement("div"); df.className = "wp-seg-field";
    const dl = document.createElement("div"); dl.className = "wp-seg-label"; dl.textContent = "时长";
    const di = document.createElement("input"); di.className = "wp-seg-input"; di.type = "number"; di.min = "0.3"; di.max = "5.75"; di.step = "0.05"; di.value = seg.duration ?? 5.0;
    di.addEventListener("input", () => { const n = parseFloat(di.value); if (isFinite(n)) { seg.duration = n; dur.textContent = `${n}s`; saveSegs(node); } });
    df.append(dl, di);

    const cf = document.createElement("div"); cf.className = "wp-seg-field";
    const cl = document.createElement("div"); cl.className = "wp-seg-label"; cl.textContent = "衔接上下文";
    const cs = document.createElement("select"); cs.className = "wp-seg-select";
    CTX_OPTIONS.forEach((o) => { const op = document.createElement("option"); op.value = o; op.textContent = o; if (String(seg.context_frames) === o) op.selected = true; cs.appendChild(op); });
    cs.addEventListener("change", () => { seg.context_frames = parseInt(cs.value, 10); saveSegs(node); });
    cf.append(cl, cs);

    const sr = document.createElement("div"); sr.className = "wp-seg-field";
    const srl = document.createElement("div"); srl.className = "wp-seg-label"; srl.textContent = "接缝重绘";
    const sri = document.createElement("input"); sri.className = "wp-seg-input"; sri.type = "number"; sri.min = "0"; sri.max = "1"; sri.step = "0.05"; sri.value = seg.seam_redraw ?? 0.10;
    sri.addEventListener("input", () => { const n = parseFloat(sri.value); if (isFinite(n)) { seg.seam_redraw = n; saveSegs(node); } });
    sr.append(srl, sri);
    row1.append(df, cf, sr);
    left.appendChild(row1);

    // LoRA 叠加区（增删行模式）
    const loraBlock = buildLoraBlock(node, seg);
    left.appendChild(loraBlock);

    // 参考图宫格区（公共参数启用时，公共参考图会占据图片1..N 位置并锁定）
    const imgBlock = buildRefImagesBlock(node, seg);
    left.appendChild(imgBlock);

    // 参考视频 / 参考音频 列表区
    const videoBlock = buildRefMediaBlock(node, seg, "ref_videos", "参考视频", "video/*");
    const audioBlock = buildRefMediaBlock(node, seg, "ref_audios", "参考音频", "audio/*");
    left.append(videoBlock, audioBlock);

    // 继承自公共参数的视频/音频（只读展示，参考图已合并进宫格）
    const inheritedMedia = buildInheritedMediaBlock(node, getCommon(node));
    if (inheritedMedia) left.appendChild(inheritedMedia);

    // 右栏：提示词（4:3 比例，高度与左侧对齐）
    const right = document.createElement("div");
    right.className = "wp-seg-right";
    const pl = document.createElement("div"); pl.className = "wp-seg-label"; pl.textContent = "提示词";
    const pt = document.createElement("textarea"); pt.className = "wp-seg-textarea"; pt.placeholder = "本段叙事提示词…"; pt.value = seg.prompt || "";
    pt.addEventListener("input", () => { seg.prompt = pt.value; saveSegs(node); });
    right.append(pl, pt);

    main.append(left, right);
    body.appendChild(main);
    card.appendChild(body);

    // 应用折叠状态（body 隐藏）
    if (seg.collapsed) body.style.display = "none";

    return card;
}

// ── 继承自公共参数的视频/音频展示（只读、不可编辑） ──
// 参考图已合并进参考图宫格（占据图片1..N），此函数只展示视频/音频的继承项。
// 返回 null 表示无继承内容（不渲染）。
function buildInheritedMediaBlock(node, common) {
    if (!common || !common.enabled) return null;
    const vids = (common.ref_videos || []).filter((p) => p && String(p).trim());
    const auds = (common.ref_audios || []).filter((p) => p && String(p).trim());
    if (vids.length === 0 && auds.length === 0) return null;

    const block = document.createElement("div");
    block.className = "wp-seg-inherited";
    block.style.cssText = "border:1px dashed rgba(255,193,7,.45);border-radius:7px;background:rgba(255,193,7,.06);padding:6px 8px;";

    const title = document.createElement("div");
    title.style.cssText = "font-size:10px;font-weight:700;color:#b89b4d;margin-bottom:4px;display:flex;align-items:center;";
    title.textContent = "继承自公共参数";
    const lock = document.createElement("span");
    lock.style.cssText = "font-size:9px;font-weight:400;color:#b89b4d;margin-left:4px;";
    lock.textContent = "[锁定] 不可编辑";
    title.appendChild(lock);
    block.appendChild(title);

    const mediaNames = [
        ...vids.map((n) => `视频 ${n}`),
        ...auds.map((n) => `音频 ${n}`),
    ];
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:2px;";
    mediaNames.forEach((mn) => {
        const item = document.createElement("div");
        item.style.cssText = "font-size:10px;color:#c9b98a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        item.textContent = mn;
        item.title = mn;
        list.appendChild(item);
    });
    block.appendChild(list);

    return block;
}

// ── 多 LoRA 叠加区（增删行模式） ──
function buildLoraBlock(node, seg) {
    const block = document.createElement("div");
    block.className = "wp-seg-loras";

    const head = document.createElement("div");
    head.className = "wp-seg-loras-head";
    const title = document.createElement("div");
    title.className = "wp-seg-loras-title";
    title.textContent = "LoRA 叠加";
    const addBtn = document.createElement("button");
    addBtn.className = "wp-seg-media-add";
    addBtn.type = "button";
    addBtn.textContent = "+ 新增";
    addBtn.addEventListener("click", () => {
        if (!Array.isArray(seg.loras)) seg.loras = [];
        seg.loras.push({ name: "", strength: 1.0 });
        saveSegs(node);
        refreshLoraList(node, seg, list);
    });
    head.append(title, addBtn);

    const list = document.createElement("div");
    list.className = "wp-seg-loras-list";

    function refreshLoraList(node, seg, list) {
        if (!Array.isArray(seg.loras)) seg.loras = [{ name: "", strength: 1.0 }];
        if (seg.loras.length === 0) seg.loras.push({ name: "", strength: 1.0 });
        list.innerHTML = "";
        const loraOptions = (node.__wpLoras || []).slice();
        seg.loras.forEach((entry, idx) => {
            if (!entry || typeof entry !== "object") { seg.loras[idx] = { name: "", strength: 1.0 }; entry = seg.loras[idx]; }
            const row = document.createElement("div");
            row.className = "wp-seg-lora-item";

            // LoRA 下拉
            const sel = document.createElement("select");
            sel.className = "wp-seg-select";
            const noneOp = document.createElement("option");
            noneOp.value = ""; noneOp.textContent = "（无）"; sel.appendChild(noneOp);
            loraOptions.forEach((name) => {
                const op = document.createElement("option");
                op.value = name; op.textContent = name;
                if (entry.name === name) op.selected = true;
                sel.appendChild(op);
            });
            sel.addEventListener("change", () => { entry.name = sel.value; saveSegs(node); });

            // 强度
            const strInput = document.createElement("input");
            strInput.className = "wp-seg-input wp-seg-lora-strength";
            strInput.type = "number"; strInput.min = "-4"; strInput.max = "4"; strInput.step = "0.01";
            strInput.value = entry.strength ?? 1.0;
            strInput.addEventListener("input", () => { const n = parseFloat(strInput.value); if (isFinite(n)) { entry.strength = n; saveSegs(node); } });

            // 删除按钮
            const delBtn = document.createElement("button");
            delBtn.className = "wp-seg-media-del";
            delBtn.textContent = "×";
            delBtn.type = "button";
            delBtn.title = "删除此行 LoRA";
            delBtn.addEventListener("click", () => {
                seg.loras.splice(idx, 1);
                if (seg.loras.length === 0) seg.loras.push({ name: "", strength: 1.0 });
                saveSegs(node);
                refreshLoraList(node, seg, list);
            });

            row.append(sel, strInput, delBtn);
            list.appendChild(row);
        });
    }

    refreshLoraList(node, seg, list);
    block.append(head, list);
    return block;
}

// ── 参考图宫格区 ──
function buildRefImagesBlock(node, seg) {
    const block = document.createElement("div");
    block.className = "wp-seg-imgs";

    // 标题栏：标题 + 计数 + 选已有
    const head = document.createElement("div");
    head.className = "wp-seg-imgs-head";
    const title = document.createElement("div");
    title.className = "wp-seg-imgs-title";
    title.textContent = "参考图片";

    const count = document.createElement("span");
    count.className = "wp-seg-imgs-count";

    const pick = document.createElement("button");
    pick.className = "wp-seg-pick";
    pick.type = "button";
    pick.textContent = "选已有";
    pick.addEventListener("click", () => pickExisting(node, seg, count, grid));

    head.append(title, count, pick);

    // 宫格（默认 1 列；多张时自动 3 列）
    const grid = document.createElement("div");
    grid.className = "wp-seg-grid";

    refreshRefGrid(node, seg, grid, count);

    block.append(head, grid);
    return block;
}

// 判断当前 seg 是否为公共参数对象（公共参数卡自己的宫格不参与继承）
function isCommonSeg(node, seg) {
    return seg === getCommon(node);
}

// 获取该分段卡「继承自公共参数的锁定参考图」列表（公共参数启用时返回，否则空数组）
function getInheritedImages(node, seg) {
    if (isCommonSeg(node, seg)) return [];
    const common = getCommon(node);
    if (!common || !common.enabled) return [];
    return (common.ref_images || []).filter((p) => p && String(p).trim());
}

// 渲染参考图宫格：
// - 公共参数卡（seg === common）：只显示 common 自己的 ref_images。
// - 分段卡且公共参数启用：宫格 = 公共参考图（锁定，占据图片1..N）+ 分段自己的参考图（图片N+1 起）。
function refreshRefGrid(node, seg, grid, count) {
    if (!Array.isArray(seg.ref_images)) seg.ref_images = [""];

    // 收敛分段自己的数组：末尾多余空槽裁掉，保证「已填数 + 1 个空槽」
    let lastFilled = -1;
    for (let i = 0; i < seg.ref_images.length; i++) {
        if (seg.ref_images[i] && String(seg.ref_images[i]).trim()) lastFilled = i;
    }
    const keep = Math.max(1, lastFilled + 2);          // 已填槽 + 紧随 1 个空槽
    const trimmed = seg.ref_images.slice(0, keep);
    while (trimmed.length < keep) trimmed.push("");
    while (trimmed.length < 1) trimmed.push("");
    seg.ref_images = trimmed.slice(0, MAX_REF_IMAGES);

    // 继承的公共参考图（锁定，前置）
    const inherited = getInheritedImages(node, seg);
    const ownImgs = seg.ref_images.filter((p) => p && String(p).trim());   // 分段自己已填的
    const ownHasEmpty = seg.ref_images.some((p) => !p || !String(p).trim()); // 分段末尾是否有空槽

    // 显示列表：锁定公共图 + 分段自己的图 + （末尾空槽，受上限约束）
    const lockedCount = inherited.length;
    const ownFilledCount = ownImgs.length;

    // 剩余可填容量 = MAX - 锁定公共图数
    const remainCap = Math.max(0, MAX_REF_IMAGES - lockedCount);

    const filledTotal = lockedCount + Math.min(ownFilledCount, remainCap);
    count.textContent = `${filledTotal} / ${MAX_REF_IMAGES}`;

    // 是否还需显示一个可填的空槽（分段自己还能继续加）
    const showEmpty = ownHasEmpty && remainCap > ownFilledCount;

    // 列数：1 张时 1 列（大方框），多张时 3 列宫格
    const totalShown = lockedCount + ownFilledCount + (showEmpty ? 1 : 0);
    grid.classList.toggle("expanded", totalShown > 1);

    // 重建宫格会移除旧 slot，其 mouseleave 不会触发，主动隐藏预览浮层防残留
    hideImagePreview();

    grid.innerHTML = "";

    // 1) 锁定公共图（占据图片1..N，不可编辑）；ownIdx = -1 表示不可写入
    inherited.forEach((img, i) => {
        grid.appendChild(buildRefSlot(node, seg, img, i, grid, count, true, -1));
    });

    // 2) 分段自己的已填图（显示编号从 lockedCount 起，真实索引为 j）
    ownImgs.slice(0, remainCap).forEach((img, j) => {
        const k = lockedCount + j;
        grid.appendChild(buildRefSlot(node, seg, img, k, grid, count, false, j));
    });

    // 3) 末尾空槽（可继续添加），显示编号 = lockedCount + ownFilledCount，真实索引 = ownFilledCount
    if (showEmpty) {
        const k = lockedCount + ownFilledCount;
        grid.appendChild(buildRefSlot(node, seg, "", k, grid, count, false, ownFilledCount));
    }
}

function buildRefSlot(node, seg, img, k, grid, count, locked, ownIdx) {
    const slot = document.createElement("div");
    slot.className = "wp-seg-slot";
    if (locked) slot.classList.add("wp-seg-slot-locked");
    slot.title = locked ? "继承自公共参数（不可编辑）" : "点击填充或修改参考图路径";

    const hasImg = img && String(img).trim();

    if (hasImg) {
        // 有图：尝试显示缩略图（走 api/view 预览），失败则显示文件名
        const im = document.createElement("img");
        im.className = "wp-seg-slot-img";
        im.loading = "lazy";
        im.decoding = "async";
        im.src = `/api/view?filename=${encodeURIComponent(String(img).trim())}&type=input`;
        im.onerror = () => {
            // 预览失败，退回文字占位
            slot.innerHTML = "";
            const txt = document.createElement("div");
            txt.className = "wp-seg-slot-idx";
            txt.textContent = truncate(String(img).trim(), 18);
            slot.appendChild(txt);
            slot.classList.add("wp-seg-slot-fill");
            if (!locked) slot.appendChild(buildSlotDel(node, seg, ownIdx, grid, count));
            if (!locked) slot.onclick = () => pickImageForSlot(node, seg, ownIdx, grid, count);
        };
        slot.appendChild(im);
        if (locked) {
            // 锁定角标
            const lock = document.createElement("span");
            lock.className = "wp-seg-slot-lock";
            lock.textContent = "锁";
            slot.appendChild(lock);
        } else {
            slot.appendChild(buildSlotDel(node, seg, ownIdx, grid, count));
            slot.onclick = () => pickImageForSlot(node, seg, ownIdx, grid, count);
        }
        // hover 放大预览：显示大图浮层
        attachImagePreview(slot, im);
    } else {
        // 空槽：占位 + 点击填充（锁定槽不会走到这里，因为 inherited 已过滤空值）
        slot.classList.add("wp-seg-slot-fill");
        const idx = document.createElement("div");
        idx.className = "wp-seg-slot-idx";
        idx.textContent = `图片${k + 1}`;
        slot.appendChild(idx);
        slot.onclick = () => pickImageForSlot(node, seg, ownIdx, grid, count);
    }

    // 挂载槽位上下文，供全局 document 捕获 drop 代理（installGlobalDropGuard）调用
    // locked 槽位不参与拖放填充；ownIdx 是分段自己数组里的真实写入索引
    slot._wpCtx = { node, seg, k, ownIdx, grid, count, kind: "image", locked: !!locked };

    return slot;
}

// ── 参考视频 / 参考音频 列表区块 ──
// key: "ref_videos" 或 "ref_audios"；accept: 文件选择器 accept 属性（"video/*" / "audio/*"）
function buildRefMediaBlock(node, seg, key, titleText, accept) {
    const block = document.createElement("div");
    block.className = "wp-seg-media";

    const head = document.createElement("div");
    head.className = "wp-seg-media-head";
    const title = document.createElement("div");
    title.className = "wp-seg-media-title";
    title.textContent = titleText;
    const count = document.createElement("span");
    count.className = "wp-seg-media-count";

    const addBtn = document.createElement("button");
    addBtn.className = "wp-seg-media-add";
    addBtn.type = "button";
    addBtn.textContent = "+ 添加";
    addBtn.addEventListener("click", () => pickMediaForList(node, seg, key, accept, list));

    head.append(title, count, addBtn);

    const list = document.createElement("div");
    list.className = "wp-seg-media-list";

    function refresh() {
        if (!Array.isArray(seg[key])) seg[key] = [];
        const items = seg[key].filter((x) => x && String(x).trim());
        count.textContent = `${items.length} 个`;
        list.innerHTML = "";
        if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "wp-seg-media-empty";
            empty.textContent = "拖入或点击添加";
            // 空态也可作为拖放目标
            empty.classList.add("wp-seg-media-item");
            empty._wpCtx = { node, seg, key, kind: key === "ref_videos" ? "video" : "audio", list };
            list.appendChild(empty);
        } else {
            seg[key].forEach((name, idx) => {
                if (!name || !String(name).trim()) return;
                const item = document.createElement("div");
                item.className = "wp-seg-media-item";
                // 缩略图：视频抽帧 / 音频图标 / 其它通用图标
                const thumb = buildMediaThumb(node, seg, key, String(name).trim());
                const nm = document.createElement("div");
                nm.className = "wp-seg-media-name";
                nm.textContent = truncate(String(name).trim(), 40);
                nm.title = String(name).trim();
                const del = document.createElement("button");
                del.className = "wp-seg-media-del";
                del.textContent = "×";
                del.type = "button";
                del.title = "移除";
                del.addEventListener("click", (e) => {
                    e.stopPropagation();
                    seg[key][idx] = "";
                    saveSegs(node);
                    // 公共参数卡：删除素材需同步刷新所有分段卡
                    if (isCommonSeg(node, seg)) rebuild(node);
                    else refresh();
                });
                item.append(thumb, nm, del);
                // 整个 item 作为拖放替换目标
                item._wpCtx = { node, seg, key, kind: key === "ref_videos" ? "video" : "audio", list };
                list.appendChild(item);
            });
        }
    }

    refresh();
    block.append(head, list);
    return block;
}

// 构建参考视频/音频列表项的缩略图：
// - 视频：尝试走 /api/view 抽帧缩略（ComfyUI 对视频返回首帧），失败回落 ▶ 图标
// - 音频：显示 ♪ 图标（音频无画面）
function buildMediaThumb(node, seg, key, name) {
    const thumb = document.createElement("div");
    thumb.className = "wp-seg-media-thumb";

    if (key === "ref_videos") {
        // 视频：尝试预览首帧
        const im = document.createElement("img");
        im.loading = "lazy";
        im.decoding = "async";
        im.src = `/api/view?filename=${encodeURIComponent(name)}&type=input`;
        im.onerror = () => {
            thumb.innerHTML = "";
            thumb.textContent = "▶";
        };
        thumb.appendChild(im);
        // hover 放大预览首帧
        attachImagePreview(thumb, im);
    } else {
        // 音频：图标
        thumb.textContent = "♪";
        thumb.title = name;
    }

    return thumb;
}

// 点击「+ 添加」：打开文件选择器，选视频/音频后上传填入
async function pickMediaForList(node, seg, key, accept, list) {    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        if (!Array.isArray(seg[key])) seg[key] = [];
        const isVideo = key === "ref_videos";
        for (const f of files) {
            const name = isVideo ? await uploadVideo(f) : await uploadAudio(f);
            if (name) {
                // 优先填回空位，否则追加
                const emptyIdx = seg[key].findIndex((x) => !x || !String(x).trim());
                if (emptyIdx >= 0) seg[key][emptyIdx] = name;
                else seg[key].push(name);
            }
        }
        saveSegs(node);
        // 通过 list 的父级 block 重新渲染（简单起见直接 rebuild 该卡片）
        rebuild(node);
    };
    input.click();
}

// ── 槽位拖拽：由全局代理 installGlobalDropGuard 统一处理 ──
// 不再在槽位自身绑 dragover/drop 捕获监听（会与全局代理、素材库 document 兜底互相冲突）。
// 槽位只保留 _wpCtx 上下文，拖放逻辑见 handleDropForSlot。

// 从拖拽数据中提取网页图片 URL
function extractImageUrl(dt) {
    const uri = dt.getData("text/uri-list");
    if (uri) {
        const lines = uri.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
        const first = lines[0];
        if (first && /^https?:\/\//i.test(first)) return first.trim();
    }
    const html = dt.getData("text/html");
    if (html) {
        const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (m && /^https?:\/\//i.test(m[1])) return m[1];
    }
    const plain = dt.getData("text/plain");
    if (plain && /^https?:\/\/\S+\.(png|jpe?g|webp|gif|bmp)(\?\S*)?$/i.test(plain.trim())) {
        return plain.trim();
    }
    return null;
}

// 素材库素材 → 复制到 input 目录，返回文件名
async function copyAssetToInput(assetId) {
    try {
        const resp = await fetch(`/wp_node/asset_library/asset/${assetId}/copy_to_input`, { method: "POST" });
        if (resp.ok) {
            const data = await resp.json();
            if (data && data.success && data.file_name) return data.file_name;
        }
        return null;
    } catch (e) {
        return null;
    }
}

// 网页图片 URL → 下载并上传到 input 目录
async function uploadImageFromUrl(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const blob = await resp.blob();
        if (!blob.type.startsWith("image/")) return null;
        const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
        const file = new File([blob], `web_${Date.now()}.${ext}`, { type: blob.type });
        return await uploadImage(file);
    } catch (e) {
        return null;
    }
}

// 槽位填充值并刷新（ownIdx 是分段自己 ref_images 数组里的真实写入索引）
function setSlotValue(node, seg, ownIdx, name, grid, count) {
    if (!name) return;
    if (ownIdx == null || ownIdx < 0) return;
    seg.ref_images[ownIdx] = name;
    saveSegs(node);
    // 公共参数卡：素材变化会同步到所有分段卡的继承宫格，需整体 rebuild
    if (isCommonSeg(node, seg)) rebuild(node);
    else refreshRefGrid(node, seg, grid, count);
}

function buildSlotDel(node, seg, ownIdx, grid, count) {
    const del = document.createElement("button");
    del.className = "wp-seg-slot-del";
    del.textContent = "×";
    del.type = "button";
    del.title = "清除此参考图";
    del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (ownIdx == null || ownIdx < 0) return;
        seg.ref_images[ownIdx] = "";
        saveSegs(node);
        // 公共参数卡：删除素材需同步刷新所有分段卡
        if (isCommonSeg(node, seg)) rebuild(node);
        else refreshRefGrid(node, seg, grid, count);
    });
    return del;
}

// 点击槽位：打开文件选择器，选图后上传填入
function pickImageForSlot(node, seg, ownIdx, grid, count) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const name = await uploadImage(f);
        if (name) setSlotValue(node, seg, ownIdx, name, grid, count);
    };
    input.click();
}

function pickExisting(node, seg, count, grid) {
    // 通过文件对话框选择已有输入图（沿用 ComfyUI 上传组件逻辑）
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        for (const f of files) {
            const name = await uploadImage(f);
            if (!name) continue;
            // 剩余容量 = 上限 - 继承的公共参考图数量（公共图占据图片1..N）
            const locked = getInheritedImages(node, seg).length;
            const remainCap = Math.max(0, MAX_REF_IMAGES - locked);
            const ownFilled = seg.ref_images.filter((p) => p && String(p).trim()).length;
            if (ownFilled >= remainCap) break;
            // 优先填入空槽，否则追加
            const emptyIdx = seg.ref_images.findIndex((p) => !p || !String(p).trim());
            if (emptyIdx >= 0) seg.ref_images[emptyIdx] = name;
            else seg.ref_images.push(name);
        }
        saveSegs(node);
        // 公共参数卡：素材变化需同步刷新所有分段卡
        if (isCommonSeg(node, seg)) rebuild(node);
        else refreshRefGrid(node, seg, grid, count);
    };
    input.click();
}

async function uploadImage(file) {
    try {
        const form = new FormData();
        form.append("image", file);
        form.append("overwrite", "true");
        const resp = await fetch("/api/upload/image", { method: "POST", body: form });
        if (resp.ok) {
            const data = await resp.json();
            return data?.name || file.name;
        }
        return file.name;
    } catch (e) {
        return file.name;
    }
}

// 上传视频文件到 input 目录（复用 ComfyUI /api/upload/image 的 multipart 通道，字段名 image）
async function uploadVideo(file) {
    try {
        const form = new FormData();
        form.append("image", file);
        form.append("overwrite", "true");
        const resp = await fetch("/api/upload/image", { method: "POST", body: form });
        if (resp.ok) {
            const data = await resp.json();
            return data?.name || file.name;
        }
        return file.name;
    } catch (e) {
        return file.name;
    }
}

// 上传音频文件到 input 目录
async function uploadAudio(file) {
    try {
        const form = new FormData();
        form.append("image", file);
        form.append("overwrite", "true");
        const resp = await fetch("/api/upload/image", { method: "POST", body: form });
        if (resp.ok) {
            const data = await resp.json();
            return data?.name || file.name;
        }
        return file.name;
    } catch (e) {
        return file.name;
    }
}

function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── 缩略图 hover 放大预览 ──
// 复用单个全局浮层 img，hover 到有缩略图的元素时显示大图，移出时隐藏。
let _previewImg = null;
// 全局隐藏预览浮层（供删除/重建 DOM 时兜底，避免浮层残留）
function hideImagePreview() {
    if (_previewImg) _previewImg.style.display = "none";
}
function attachImagePreview(triggerEl, smallImg, previewSrc) {
    if (typeof window === "undefined") return;
    const src = previewSrc || smallImg?.src;
    if (!src) return;
    const show = (e) => {
        if (!_previewImg) {
            _previewImg = document.createElement("img");
            _previewImg.className = "wp-seg-preview";
            document.body.appendChild(_previewImg);
        }
        // 仅在 src 变化时更新（避免 mousemove 反复重新解码/请求）
        if (_previewImg.dataset.src !== src) {
            _previewImg.dataset.src = src;
            _previewImg.src = src;
        }
        _previewImg.style.display = "block";
        const pad = 16;
        let x = (e.clientX ?? 0) + pad;
        let y = (e.clientY ?? 0) + pad;
        // 防溢出：贴近屏幕边缘时翻转到鼠标另一侧
        // 用 offsetWidth/offsetHeight（缓存、无 reflow），而非 getBoundingClientRect
        const pw = _previewImg.offsetWidth || 320;
        const ph = _previewImg.offsetHeight || 320;
        if (x + pw > window.innerWidth) x = (e.clientX ?? 0) - pw - pad;
        if (y + ph > window.innerHeight) y = (e.clientY ?? 0) - ph - pad;
        _previewImg.style.left = `${Math.max(0, x)}px`;
        _previewImg.style.top = `${Math.max(0, y)}px`;
    };
    const hide = () => hideImagePreview();
    triggerEl.addEventListener("mouseenter", show);
    triggerEl.addEventListener("mousemove", show);
    triggerEl.addEventListener("mouseleave", hide);
}

// ── 精确同步节点高度（基于 DOM 实际高度 + computeLayoutSize 机制） ──
// 注意：绝不能往 DOM widget 元素上写 minHeight / scrollHeight 之类会反哺测量的属性，
// 否则会形成「读 scrollHeight → 写 minHeight → scrollHeight 变大 → 再写」的正反馈，导致节点无限长。
//
// 关键：ComfyUI 前端把带 computeLayoutSize 的 widget 当作「弹性 widget」，
// 通过 distributeSpace 把节点剩余空间按 [minHeight, maxHeight] 分配给它们。
// 若 maxHeight 为 undefined 会被视为 Infinity，导致 widget 贪婪吸收所有剩余空间——
// 删除分段后内容变矮，但 widget 仍占满原高度，节点无法收缩。
// 因此必须让 maxHeight === minHeight，锁定 widget 高度 = 内容高度，节点才能精确收缩。
function applyWidgetHeight(node) {
    const w = node._wpSegDomWidget;
    if (!w) return;
    const el = w.element;
    if (!el) return;
    const h = measureHeight(node);
    if (w.options) {
        w.options.getMinHeight = () => h;
        w.options.getMaxHeight = () => h;   // 锁死上限 = 内容高度，禁止弹性吸收剩余空间
    }
    if (typeof w.computeLayoutSize === "function") {
        w.computeLayoutSize = () => ({ minHeight: h, maxHeight: h, minWidth: MIN_WIDTH });
    }
    // 删除 computeSize，避免被当作固定尺寸 widget 不参与 resize
    try { delete w.computeSize; } catch (_) { w.computeSize = undefined; }
    // 内容变化后强制节点重排（含收缩）：标记 widget 槽位脏 + 重绘，
    // 触发前端 arrange() → _arrangeWidgets() → distributeSpace()，按锁定的 maxHeight 收缩节点。
    node._widgetSlotsDirty = true;
    node.setDirtyCanvas?.(true, true);
    // 关键：ComfyUI 前端的 renderedSize = max(node.size[1], contentHeight)，
    // 只改 widget 的 minHeight/maxHeight 无法让 node.size[1] 收缩。
    // 必须显式用 computeSize() 重算总高度并写回 node.size（走 setNodeSize → commitNodeSize）。
    syncNodeSize(node);
}

// 显式收缩/同步节点总尺寸：用节点自身的 computeSize()（标题 + 输入槽 + 各 widget 高度）
// 得到正确总高度，写回 node.size，触发 setNodeSize/commitNodeSize 完成收缩。
function syncNodeSize(node) {
    if (!node) return;
    let cw = node.size ? node.size[0] : MIN_WIDTH;
    let ch = measureHeight(node);
    if (typeof node.computeSize === "function") {
        try {
            const s = node.computeSize();
            if (Array.isArray(s) && s.length >= 2) {
                cw = Math.max(MIN_WIDTH, s[0] || 0, cw);
                ch = s[1] || 0;
            }
        } catch (_) { /* 用 measureHeight 兜底 */ }
    }
    // 兜底：computeSize 失败或高度异常时，用 measureHeight + 估算的标题/槽位偏移
    if (!ch || ch < 50) ch = measureHeight(node) + 80;
    const targetW = Math.ceil(cw);
    const targetH = Math.ceil(ch);
    // 尺寸无变化时跳过，避免 setNodeSize 反复触发 ResizeObserver → 回环
    if (node.size && Math.abs(node.size[0] - targetW) < 1 && Math.abs(node.size[1] - targetH) < 1) {
        return;
    }
    node.size = [targetW, targetH];
}

function rebuild(node) {
    // rAF 合并：同帧内多次 rebuild 只执行最后一次，避免重复重建整棵 DOM（性能关键）
    if (node._wpRebuildPending) return;
    node._wpRebuildPending = true;
    requestAnimationFrame(() => {
        node._wpRebuildPending = false;
        _doRebuild(node);
    });
}

function _doRebuild(node) {
    const w = node._wpSegDomWidget;
    if (!w || !w.element) return;
    const host = w.element;
    const segs = getSegs(node);

    // 重建公共参数卡片（开关状态/媒体变化时刷新）
    const oldCommon = host.querySelector(".wp-seg-common");
    const newCommon = buildCommonCard(node);
    if (oldCommon) host.replaceChild(newCommon, oldCommon);
    else host.insertBefore(newCommon, host.firstChild);

    const oldList = host.querySelector(".wp-seg-list");
    const newList = document.createElement("div");
    newList.className = "wp-seg-list";
    segs.forEach((seg, i) => newList.appendChild(buildCard(node, seg, i)));
    if (oldList) host.replaceChild(newList, oldList);
    else host.appendChild(newList);
    // 内容变化后重新计算并应用高度
    requestAnimationFrame(() => applyWidgetHeight(node));
}

// ── 精确估算卡片区总高度 ──
// 关键：只读取「内容自身」的高度（list/addBtn 子元素的 offsetHeight），
// 绝不读取 widget.element 的 scrollHeight——那个值会受 minHeight 反哺，形成无限长循环。
function measureHeight(node) {
    const host = node._wpSegDomWidget?.element;
    if (!host) return estimateHeight(node);

    // 读取内容列表的真实高度（不受 widget 自身 minHeight 影响）
    const list = host.querySelector(".wp-seg-list");
    const addBtn = host.querySelector(".wp-seg-add");
    const progress = host.querySelector(".wp-seg-progress");
    const common = host.querySelector(".wp-seg-common");
    let h = 0;
    if (common) h += common.offsetHeight + 8;       // 公共参数卡片
    if (addBtn) h += addBtn.offsetHeight + 8;       // 按钮高度 + 与列表间距
    if (progress && progress.style.display !== "none") h += progress.offsetHeight + 8;  // 进度条（运行时才显示）
    if (list) {
        h += list.offsetHeight;
    } else {
        // 兜底：累加所有卡片
        host.querySelectorAll(".wp-seg-card").forEach((c) => { h += c.offsetHeight + 8; });
    }
    // host 自身 padding(8*2)
    h += 16;
    return Math.max(200, Math.ceil(h));
}

// 纯估算（无 DOM 时兜底），不参与循环
function estimateHeight(node) {
    const segs = getSegs(node);
    if (!segs.length) return 200;
    // 每段卡片高度估算（左右两栏：左参数 + 右提示词，取较高者）
    let per = 34 + 6 + 6;                          // 标题 + body padding/gap
    per += (12 + 3 + 28);                          // 时长/衔接/接缝 一行
    per += (12 + 3 + 28);                          // LoRA 行
    per += (12 + 3);                               // 参考图标题
    // 参考图宫格区（默认 1 个槽；多张时 3 列）
    let refBlock = 0;
    segs.forEach((s) => {
        const n = Array.isArray(s.ref_images) ? s.ref_images.length : 1;
        const cols = n > 1 ? 3 : 1;                 // 1 张 1 列，多张 3 列
        const rows = Math.max(1, Math.ceil(n / cols));
        const gridH = rows * 96 + (rows - 1) * 8;
        refBlock += 16 + 20 + 8 + gridH + 8;
    });
    const total = 38 + segs.length * per + refBlock + (segs.length - 1) * 8 + 16;
    return Math.max(200, Math.ceil(total));
}

// ── setup ──
// 幂等：onNodeCreated / onConfigure / nodeCreated 都可能触发（切换画布返回时会再次触发），
// 必须保证 setupUI 只真正构建一次，否则会重复 addDOMWidget 造成卡片叠加、节点被撑高。
function setupUI(node) {
    if (typeof node.addDOMWidget !== "function") return;

    // 已构建过 → 仅同步数据 + 重算高度，不再重复 addDOMWidget
    if (node._wpSegUIBuilt) {
        loadSegs(node);
        rebuild(node);
        requestAnimationFrame(() => applyWidgetHeight(node));
        return;
    }

    // 清理可能残留的旧 DOM widget（_extraWidgets 里 type 匹配的），避免重复
    if (Array.isArray(node._extraWidgets)) {
        for (let i = node._extraWidgets.length - 1; i >= 0; i--) {
            const w = node._extraWidgets[i];
            if (w && w.type === "wp_h3_seg_dom") {
                try { node.removeWidget(w); } catch (_) { node._extraWidgets.splice(i, 1); }
            }
        }
    }

    const jw = node.widgets?.find((w) => w && w.name === JSON_WIDGET);
    if (jw) { jw.hidden = true; jw.computeSize = () => [0, 0]; }

    loadSegs(node);

    fetchLoras().then((list) => {
        node.__wpLoras = list;
        if (node._wpSegDomWidget?.element) rebuild(node);
    });

    const host = buildUI(node);
    const widget = node.addDOMWidget("wp_h3_seg_dom", "wp_h3_seg_dom", host, {
        getValue: () => getSegs(node),
        setValue: () => {},
        getMinHeight: () => measureHeight(node),
        hideOnZoom: false,
    });
    widget.element = host;
    node._wpSegDomWidget = widget;
    node._wpSegUIBuilt = true;   // 标记已构建，后续 setupUI 走幂等分支

    // 精确控制 DOM widget 高度（computeLayoutSize + CSS 变量，对齐 Director 成熟做法）
    applyWidgetHeight(node);

    // ResizeObserver：内容实际尺寸变化时兜底同步（rAF 节流，避免缩略图加载引发的连锁重绘）
    if (typeof ResizeObserver !== "undefined") {
        node._wpResizeObs?.disconnect?.();
        node._wpResizeObs = new ResizeObserver(() => {
            if (node._wpResizePending) return;
            node._wpResizePending = true;
            requestAnimationFrame(() => {
                node._wpResizePending = false;
                applyWidgetHeight(node);
            });
        });
        node._wpResizeObs.observe(host);
    }

    // 初次渲染后同步一次
    requestAnimationFrame(() => {
        requestAnimationFrame(() => applyWidgetHeight(node));
    });

    if (!node.size || node.size[0] < MIN_WIDTH) {
        node.size = [MIN_WIDTH, node.size ? node.size[1] : 0];
    }

    // ── sigmas 连接监听：接入后调度器/步数置灰不可选 ──
    installSigmasListener(node);
}

// 监听 sigmas 输入端口连接状态，接入时置灰「调度器」「步数」widget（不可编辑），断开时恢复。
function installSigmasListener(node) {
    if (node._wpSigmasListenerInstalled) return;
    node._wpSigmasListenerInstalled = true;

    function syncDisabledState() {
        // 检查 sigmas 输入是否已连接
        let connected = false;
        try {
            const input = node.inputs?.find((i) => i && i.name === "sigmas");
            connected = !!(input && input.link != null);
        } catch (_) { connected = false; }

        // 置灰/恢复 调度器 与 步数 两个 widget
        const names = ["调度器", "步数"];
        for (const name of names) {
            const w = node.widgets?.find((x) => x && x.name === name);
            if (!w) continue;
            w.disabled = connected;
            // 也同步到 DOM 元素（ComfyUI 会渲染 disabled 属性）
            if (w.element) {
                try { w.element.disabled = connected; } catch (_) {}
            }
        }
    }

    // 初始同步
    syncDisabledState();

    // 连接变化时同步（onConnectionsChange 在输入连接/断开时被前端调用）
    const orig = node.onConnectionsChange;
    node.onConnectionsChange = function (type, index, connected, link_info) {
        try { orig?.apply(this, arguments); } catch (_) {}
        syncDisabledState();
    };
}

// ── 全局拖放代理：单一 document 捕获阶段 drop 处理器 ──
// 背景：素材库 asset_library.js 在 document 上注册了捕获 drop 兜底（setTimeout 1000ms 后才注册），
// 会把拖到画布上的素材注入「名字含 image 的 widget」（误命中 ref_image_size 等）。
// 本扩展在加载时立即注册一个 document 捕获 drop 处理器（早于 asset_library），
// 当拖放落点位于本节点的参考图槽位（.wp-seg-slot）内时，统一接管：
//   - stopImmediatePropagation 阻断 asset_library 兜底（不污染其它 widget）
//   - 根据拖拽来源（素材库/外部文件/网页图片）直接填充槽位
// 槽位上下文（node/seg/索引/刷新函数）挂在槽位元素的 _wpCtx 上，由 buildRefSlot 写入。
function installGlobalDropGuard() {
    if (window.__wpSegDropGuardInstalled) return;
    window.__wpSegDropGuardInstalled = true;

    const overClass = (slot) => slot.classList.contains("wp-seg-media-item") ? "wp-seg-media-over" : "wp-seg-slot-over";

    document.addEventListener("dragover", (e) => {
        const slot = findDropSlot(e.target);
        if (!slot) return;
        // 锁定槽位（继承自公共参数）不接受拖放
        if (slot._wpCtx && slot._wpCtx.locked) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        slot.classList.add(overClass(slot));
    }, true);

    document.addEventListener("drop", async (e) => {
        const slot = findDropSlot(e.target);
        if (!slot) return;
        if (slot._wpCtx && slot._wpCtx.locked) return;
        const dt = e.dataTransfer;
        if (!dt) return;

        e.preventDefault();
        e.stopImmediatePropagation();   // 阻断 asset_library 的 document 兜底
        slot.classList.remove(overClass(slot));

        const ctx = slot._wpCtx;
        if (!ctx) return;
        await handleDropForSlot(ctx, dt, slot);
    }, true);

    document.addEventListener("dragleave", (e) => {
        const slot = findDropSlot(e.target);
        if (!slot) return;
        // 仅当真正离开槽位（而非进入其子元素）时移除高亮
        const related = e.relatedTarget;
        if (related && slot.contains(related)) return;
        slot.classList.remove(overClass(slot));
    }, true);
}

// 从事件目标向上查找可拖放槽位元素（参考图槽位 或 视频/音频列表项）
function findDropSlot(target) {
    let t = target;
    while (t && t !== document && t !== null) {
        if (t.classList && (t.classList.contains("wp-seg-slot") || t.classList.contains("wp-seg-media-item"))) return t;
        t = t.parentElement;
    }
    return null;
}

// 槽位拖放核心：支持素材库、外部文件、网页图片（图片槽）+ 视频/音频列表项
async function handleDropForSlot(ctx, dt, slot) {
    const { node, seg, k, ownIdx, grid, count, kind, key, list } = ctx;

    // 锁定槽位（继承自公共参数）不参与拖放填充
    if (ctx.locked) return;

    // 视频/音频列表项：写入 seg.ref_videos / seg.ref_audios
    if (kind === "video" || kind === "audio") {
        const isVideo = kind === "video";
        // 外部文件（本地文件夹拖入视频/音频）
        if (dt.files && dt.files.length > 0) {
            const f = dt.files[0];
            const okType = isVideo ? (f.type && f.type.startsWith("video/")) : (f.type && (f.type.startsWith("audio/") || f.type.startsWith("video/")));
            if (f && okType) {
                const name = isVideo ? await uploadVideo(f) : await uploadAudio(f);
                if (name) { appendMediaValue(node, seg, key, name); }
                return;
            }
        }
        // 素材库拖入（视频/音频素材）
        const wpAsset = dt.getData("application/x-wp-asset");
        if (wpAsset) {
            try {
                const info = JSON.parse(wpAsset);
                if (info && info.assetId) {
                    const want = isVideo ? "video" : "audio";
                    if (info.fileType && info.fileType !== want) return;
                    const name = await copyAssetToInput(info.assetId);
                    if (name) { appendMediaValue(node, seg, key, name); }
                    return;
                }
            } catch (_) { /* 忽略 */ }
        }
        return;
    }

    // ── 图片槽（kind === "image"，默认） ──
    // 1) 素材库拖入（自定义 MIME）
    const wpAsset = dt.getData("application/x-wp-asset");
    if (wpAsset) {
        try {
            const info = JSON.parse(wpAsset);
            if (info && info.assetId) {
                if (info.fileType && info.fileType !== "image") return;
                const name = await copyAssetToInput(info.assetId);
                if (name) setSlotValue(node, seg, ownIdx, name, grid, count);
                return;
            }
        } catch (_) { /* 继续尝试其它来源 */ }
    }

    // 2) 外部文件（本地文件夹拖入）
    if (dt.files && dt.files.length > 0) {
        const f = dt.files[0];
        if (f && f.type && f.type.startsWith("image/")) {
            const name = await uploadImage(f);
            if (name) setSlotValue(node, seg, ownIdx, name, grid, count);
            return;
        }
    }

    // 3) 网页图片（拖入图片 URL）
    const url = extractImageUrl(dt);
    if (url) {
        const name = await uploadImageFromUrl(url);
        if (name) setSlotValue(node, seg, ownIdx, name, grid, count);
    }
}

// 追加一个视频/音频文件名到 seg[key]，优先填回空位，再 rebuild
function appendMediaValue(node, seg, key, name) {
    if (!name) return;
    if (!Array.isArray(seg[key])) seg[key] = [];
    const emptyIdx = seg[key].findIndex((x) => !x || !String(x).trim());
    if (emptyIdx >= 0) seg[key][emptyIdx] = name;
    else seg[key].push(name);
    saveSegs(node);
    rebuild(node);
}
installGlobalDropGuard();

// ── 采样进度监听：驱动节点内的进度提示条 ──
// 后端 ProgressBar(len(segs)+1) 每个刻度对应「采样第 i 段」或「拼接」，
// ComfyUI 通过 api "progress" 事件广播 { value, max, node_id }。
// 这里把 value/max 映射到节点内嵌的进度条（采样中 X/N 段），并在执行结束/出错时隐藏。
function installProgressListener() {
    if (window.__wpSegProgressInstalled) return;
    window.__wpSegProgressInstalled = true;
    if (typeof api === "undefined" || !api.addEventListener) return;

    function setProgress(node, value, max) {
        const host = node?._wpSegDomWidget?.element;
        if (!host) return;
        const progress = host.querySelector(".wp-seg-progress");
        if (!progress) return;
        const fill = host.querySelector(".wp-seg-progress-fill");
        const text = host.querySelector(".wp-seg-progress-text");
        const total = Math.max(1, max || 1);
        const v = Math.max(0, Math.min(total, value || 0));
        const pct = Math.round((v / total) * 100);
        // 后端刻度：0..len(segs) 为逐段采样，len(segs)+1 为拼接完成
        // 展示为「采样中 X/N」：value 在 [1, len(segs)] 区间表示正在采样第 value 段
        const segTotal = Math.max(1, total - 1);
        if (v >= total) {
            text.textContent = "拼接完成";
            progress.style.display = "none";
            if (fill) fill.style.width = "100%";
        } else if (v >= segTotal && v < total) {
            text.textContent = "拼接中…";
            progress.style.display = "flex";
            if (fill) fill.style.width = `${pct}%`;
        } else {
            text.textContent = `采样中 ${v}/${segTotal} 段`;
            progress.style.display = "flex";
            if (fill) fill.style.width = `${pct}%`;
        }
        // 进度条出现/消失会改变内容高度，触发重算
        requestAnimationFrame(() => applyWidgetHeight(node));
    }

    function hideProgress(node) {
        const host = node?._wpSegDomWidget?.element;
        if (!host) return;
        const progress = host.querySelector(".wp-seg-progress");
        if (progress) progress.style.display = "none";
        requestAnimationFrame(() => applyWidgetHeight(node));
    }

    api.addEventListener("progress", (e) => {
        try {
            const d = e.detail || {};
            const nid = d.node_id ?? d.node;
            const node = app?.graph?.getNodeById?.(nid);
            if (node && node.type === NODE_TYPE) {
                setProgress(node, d.value, d.max);
            }
        } catch (_) { /* 忽略进度事件异常 */ }
    });

    // 执行结束/出错/中断时，隐藏进度条
    api.addEventListener("executed", (e) => {
        try {
            const d = e.detail || {};
            const nid = d.node ?? d.node_id;
            const node = app?.graph?.getNodeById?.(nid);
            if (node && node.type === NODE_TYPE) hideProgress(node);
        } catch (_) {}
    });
    api.addEventListener("execution_error", (e) => {
        try {
            const d = e.detail || {};
            const node = app?.graph?.getNodeById?.(d.node_id);
            if (node && node.type === NODE_TYPE) hideProgress(node);
        } catch (_) {}
    });
    api.addEventListener("execution_interrupted", (e) => {
        try {
            const d = e.detail || {};
            const node = app?.graph?.getNodeById?.(d.node_id);
            if (node && node.type === NODE_TYPE) hideProgress(node);
        } catch (_) {}
    });
}
installProgressListener();

// ── 注册扩展 ──
app.registerExtension({
    name: "WP_Node_Group.H3SegmentDirectorCards",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);
            setupUI(this);
            return r;
        };
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const r = onConfigure?.apply(this, args);
            setupUI(this);
            return r;
        };
    },

    async nodeCreated(node) {
        if (isTarget(node)) setupUI(node);
    },
});

console.log("[WP_Node] H3分段编排 卡片式 DOM UI 已加载");
