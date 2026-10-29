import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════
// 🐳 WP 提示词对话 · 前端聊天面板
// 采用“执行式节点”：点“发送”=执行一次节点，模型回复通过 ui 通道回填。
// 多轮对话历史存于「对话历史」widget（JSON），随工作流持久化，多节点天然隔离。
// 流式输出：后端在推理过程中通过 PromptServer.send_sync("wp_prompt_agent_token")
// 实时推送 token，前端按会话 ID 区分追加到对应节点的 AI 消息元素。
// ═══════════════════════════════════════════════

const WIDGET_HISTORY = "对话历史";
const WIDGET_INPUT = "用户输入";

// 「输入草稿」widget 名：输入框未发送草稿的持久化存档位（后端不消费）。
// 画布切换/节点重建/刷新后输入框是全新空白元素，草稿由此 widget 恢复
const WIDGET_DRAFT = "输入草稿";

// 后端推送事件名（与 提示词对话节点.py 中的字符串保持一致）
const STREAM_EVENT = "wp_prompt_agent_token";

// SID 标记格式：[[WP_SID:<sid>]]，前端写入「用户输入」widget 开头，后端剥离
const SID_PREFIX = "[[WP_SID:";

// 「重新生成」标记：[[WP_REGEN]]，重新生成某轮时写在 SID 标记之后，
// 后端据此把对话历史截断到该轮提问为止（干净重跑，不含原回复及其后对话）
const REGEN_FLAG = "[[WP_REGEN]]";

// 需要隐藏的采样/内部 widget（只留「使用技能」下拉框）
const HIDDEN_WIDGETS = [
    "对话历史", "用户输入", "最大轮数", "最大生成token", "温度", "top_p", "top_k", "重复惩罚", "输出think块", "API配置", "仅输出内容", "图像数量", "卸载模型", "输入草稿",
];

// 「API配置」widget 名：前端「设置」弹窗读写，后端未连本地模型时使用
const WIDGET_API_CFG = "API配置";

// 「图像数量」widget 名：图片输入端口数量（1-10），设置弹窗维护，前端据此增删图片输入口
const WIDGET_IMAGE_COUNT = "图像数量";
const IMAGE_INPUT_MAX = 10;

// 「仅输出内容」widget 名：前端左下角开关按钮读写，开启后回复只输出内容本身
const WIDGET_ONLY_OUTPUT = "仅输出内容";

// 「卸载模型」widget 名：前端左下角开关按钮读写，开启后每次本地推理完成自动卸载模型释放显存
const WIDGET_UNLOAD_MODEL = "卸载模型";

// 本地模型输入端口名（用于检测是否连接本地模型，决定「卸载模型」按钮可用性）
const LOCAL_MODEL_INPUT = "qwen模型";

// 会话表：sid -> node，用于把后端推送的 token 路由到正确的节点
const streamingSessions = new Map();

// 发送中会话的模块级备份：nodeId -> { sid, text }
// 恢复优先用「用户输入」widget 里的 SID 残留；若画布快照未保留 widget 直改值，
// 则从这里按节点 ID 找回本轮会话，保证任何情况下切回画布都能恢复
const pendingTurns = new Map();

// 会话结果暂存表：sid -> { reply, error, buffer }
// 画布切换/页面刷新会重建节点、清空内存状态；本表（模块级，随页面存活）用于：
// 1) 暂存切走画布期间后端完成的回复，切回画布后直接固化，不丢结果
// 2) 暂存流式已生成内容，切回画布后接着显示，流式视觉上不中断
const sidResults = new Map();
const SID_RESULTS_MAX = 50;
function rememberSidResult(sid, patch) {
    if (!sid) return;
    let cache = sidResults.get(sid);
    if (!cache) {
        if (sidResults.size >= SID_RESULTS_MAX) {
            sidResults.delete(sidResults.keys().next().value);
        }
        cache = { reply: "", error: "", buffer: "" };
        sidResults.set(sid, cache);
    }
    Object.assign(cache, patch || {});
}

// 等待回复超时：busy 期间超过该时长无任何 token/结果，判定回复丢失并回滚，
// 防止页面刷新/画布切换导致结果永久丢失时节点永远卡在“思考中…”
const BUSY_TIMEOUT_MS = 5 * 60 * 1000;

// 「对话历史」widget 保存的最多消息条数：取节点「最大轮数」widget 值（设置弹窗可改），
// widget 缺失/非法时兜底 60（与后端默认一致）
const MAX_HISTORY_ITEMS = 60;
function getMaxHistoryItems(node) {
    const w = node.widgets ? node.widgets.find((x) => x.name === "最大轮数") : null;
    const n = parseInt(w && w.value, 10);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : MAX_HISTORY_ITEMS;
}

// ═══ 提交失败旁路监听 ═══
// 新版前端 app.queuePrompt 会吞掉 /prompt 的验证错误（只弹全局错误 UI、不抛异常），
// doSend 的 try/catch 捕获不到，聊天框会一直卡在“思考中…”。这里旁路拦截 /prompt
// 响应记录失败详情，doSend 提交返回后检查并转投到对话框（只观察，不改任何原有行为）。
let lastPromptSubmitError = null;
{
    const origFetchApi = api.fetchApi.bind(api);
    api.fetchApi = async function (route, options) {
        const res = await origFetchApi(route, options);
        try {
            if (
                res.status !== 200 &&
                options &&
                options.method === "POST" &&
                String(route).endsWith("/prompt")
            ) {
                const clone = res.clone();
                const data = await clone.json().catch(() => null);
                lastPromptSubmitError = { time: Date.now(), status: res.status, data };
            }
        } catch (e) {
            /* 旁路失败不影响原逻辑 */
        }
        return res;
    };
}

// 把后端验证错误拼成可读的多行消息（节点标题 · 参数名 · 错误说明）
function formatPromptSubmitError(data) {
    const lines = ["提交失败（未进入执行队列），原因："];
    try {
        const err = data && data.error;
        if (err && typeof err === "object" && err.message) {
            lines.push(`${err.message}${err.details ? "：" + err.details : ""}`);
        } else if (typeof err === "string" && err) {
            lines.push(err);
        }
        const nodeErrors = (data && data.node_errors) || {};
        for (const nodeId of Object.keys(nodeErrors)) {
            const errs = (nodeErrors[nodeId] && nodeErrors[nodeId].errors) || [];
            const n = app.graph && app.graph.getNodeById ? app.graph.getNodeById(nodeId) : null;
            const title = (n && (n.title || n.type)) || `节点#${nodeId}`;
            for (const e of errs) {
                const info = e && e.extra_info && e.extra_info.input_name;
                const name = Array.isArray(info) ? info[0] : info || "";
                lines.push(`· ${title}${name ? " · " + name : ""}：${(e && e.message) || (e && e.type) || "未知错误"}`);
            }
        }
        if (lines.length === 1) lines.push("（后端未返回详细信息，可查看页面右上角的错误面板）");
    } catch (e) {
        lines.push("（错误详情解析失败，可查看页面右上角的错误面板）");
    }
    return lines.join("\n");
}

function hideWidget(node, name) {
    const w = node.widgets ? node.widgets.find((x) => x.name === name) : null;
    if (w) {
        w.hidden = true;
        w.computeSize = () => [0, 0];
    }
}

function getInputWidget(node) {
    return node.widgets.find((x) => x.name === WIDGET_INPUT);
}

function getHistoryWidget(node) {
    return node.widgets.find((x) => x.name === WIDGET_HISTORY);
}

function getDraftWidget(node) {
    return node.widgets ? node.widgets.find((x) => x.name === WIDGET_DRAFT) : null;
}

// 草稿写入存档位：输入框每次按键实时同步（直改 widget.value 不触发 onWidgetChanged，无回环）
function saveDraft(node, text) {
    const w = getDraftWidget(node);
    if (w) w.value = text || "";
}

// 草稿恢复：节点重建（画布切换/刷新/重开工作流）后输入框是全新空白元素，从存档位回填
function restoreDraft(node) {
    const g = node._chat;
    if (!g || !g.inputEl) return;
    const w = getDraftWidget(node);
    const v = String((w && w.value) || "");
    if (v) g.inputEl.value = v;
}

function loadHistory(node) {
    const w = getHistoryWidget(node);
    try {
        const arr = JSON.parse((w && w.value) || "[]");
        node._chat.history = Array.isArray(arr) ? arr : [];
    } catch (e) {
        node._chat.history = [];
    }
}

function saveHistory(node) {
    const g = node._chat;
    // 消息条数上限：超限砍最旧，防 widget 值随对话无限膨胀拖慢保存/加载
    while (g.history.length > getMaxHistoryItems(node)) g.history.shift();
    const w = getHistoryWidget(node);
    if (w) w.value = JSON.stringify(g.history);
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 复制兜底：clipboard API 不可用时用临时 textarea 复制
function fallbackCopy(text, done) {
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        if (done) done();
    } catch (e) {
        /* 复制失败就静默 */
    }
}

// 生成一个会话 ID（同一毫秒 + 6 位随机后缀，足够区分）
function genSid() {
    return `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 把 SID 标记塞进用户输入文本开头，后端会把它剥离出来用于路由流式 token；
// 重新生成轮次额外插入 REGEN 标记，让后端把历史截断到目标轮提问为止
function wrapUserInputWithSid(sid, text, isRegen) {
    return `${SID_PREFIX}${sid}]]${isRegen ? REGEN_FLAG : ""}${text}`;
}

// 读取节点「API配置」widget：解析 JSON 并校验关键字段，无效返回 null
function readApiConfig(node) {
    const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_API_CFG) : null;
    try {
        const cfg = JSON.parse((w && w.value) || "{}");
        if (
            cfg &&
            String(cfg.api_url || "").trim() &&
            String(cfg.api_key || "").trim() &&
            String(cfg.model || "").trim()
        ) {
            return cfg;
        }
    } catch (e) {
        /* 配置无效则当作未配置 */
    }
    return null;
}

// 重新生成按钮 HTML（气泡底部操作栏）：busy 时禁用防重复点击，
// 正在重新生成的那一轮按钮额外切换为旋转图标 + “生成中…”文案
function buildRegenBtnHtml(idx, busy, loading) {
    const disabled = busy ? " disabled" : "";
    const cls = loading ? " wp-chat-regen-loading" : "";
    const label = loading ? "生成中…" : "重新生成";
    const icon =
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"' +
        (loading ? ' class="wp-regen-spin"' : "") +
        '><path d="M17.65,6.35C16.2,4.9 14.21,4 12,4c-4.42,0-7.99,3.58-7.99,8s3.57,8 7.99,8c3.73,0 6.84-2.55 7.73-6h-2.08c-0.82,2.33-3.04,4-5.65,4c-3.31,0-6-2.69-6-6s2.69-6 6-6c1.66,0 3.14,0.69 4.22,1.78L13,11h7V4L17.65,6.35z"/></svg>';
    return (
        '<div class="wp-chat-actions">' +
        `<button class="wp-chat-regen-btn${cls}" type="button" data-idx="${idx}"${disabled}` +
        ' title="用同一轮提问重新生成：新结果以新气泡追加，原内容保留">' +
        icon +
        `<span>${label}</span></button></div>`
    );
}

function renderHistory(node) {
    const g = node._chat;
    const el = g.historyEl;
    if (!el) return;

    const roleLabel = { user: "用户", assistant: "AI", system: "系统" };
    const parts = [];

    if (!g.history.length && !g.busy) {
        el.innerHTML =
            '<div class="wp-chat-empty"><div class="wp-chat-empty-icon">🐳</div>' +
            '<div>输入内容开始对话</div>' +
            '<div class="wp-chat-empty-sub">发送 /help 查看可用技能 · 未连本地模型时请先点【⚙ 设置】配置 API</div></div>';
        g.streamingEl = null;
        return;
    }

    // 复制按钮 HTML（点击逻辑用事件委托统一处理，见 historyEl 的 click 监听）
    const copyBtnHtml =
        '<button class="wp-chat-copy-btn" type="button" title="复制本条内容">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16,1H4C3.45,1,3,1.45,3,2v14h2V3h11V1z M19,5H8C7.45,5,7,5.45,7,6v16c0,0.55,0.45,1,1,1h11c0.55,0,1-0.45,1-1V6C20,5.45,19.55,5,19,5z M18,21H9V7h9V21z"/></svg>' +
        "</button>";

    // 版本日志预计算：① 提问文本 -> 轮次号（后出现的同文本提问覆盖旧的，
    // 与后端“从尾部向前找”的匹配口径一致）；② 相同提问的重新生成结果按序编号 v1/v2…
    const userTextToTurn = {};
    let turnCounter = 0;
    for (const m of g.history) {
        if (m.role === "user") {
            turnCounter++;
            if (m.content) userTextToTurn[m.content] = turnCounter;
        }
    }
    const regenVersions = {};

    // 历史消息（气泡排版：用户靠右、AI/系统靠左）
    for (let i = 0; i < g.history.length; i++) {
        const m = g.history[i];
        const label = roleLabel[m.role] || (m.role || "?");
        // 重新生成的结果气泡带版本标签：↻ 重新生成 · 第N轮 · vK
        let tagHtml = "";
        if (m.role === "assistant" && m.regenOf) {
            const tn = userTextToTurn[m.regenOf];
            regenVersions[m.regenOf] = (regenVersions[m.regenOf] || 0) + 1;
            tagHtml =
                '<span class="wp-chat-regen-tag">↻ 重新生成' +
                (tn ? ` · 第${tn}轮` : "") +
                ` · v${regenVersions[m.regenOf]}</span>`;
        }
        // AI 气泡底部操作栏（仅 assistant 消息；busy 期间禁用防重复触发）
        const actionsHtml =
            m.role === "assistant"
                ? buildRegenBtnHtml(i, g.busy, g.busy && g._regenLoadingIdx === i)
                : "";
        parts.push(
            `<div class="wp-chat-msg ${m.role}"><div class="wp-chat-bubble">` +
            copyBtnHtml +
            `<div class="wp-chat-role">${label}${tagHtml}</div>` +
            `<div class="wp-chat-content">${escapeHtml(m.content)}</div>` +
            actionsHtml +
            `</div></div>`
        );
    }
    // 流式 AI 消息占位（或“思考中…”提示）；本轮用户消息已在 history 里（发送时即固化）
    if (g.busy) {
        const hasContent = !!(g.streamingBuffer && g.streamingBuffer.length);
        const content = hasContent ? g.streamingBuffer : "思考中…";
        const contentClass = hasContent ? "wp-chat-content" : "wp-chat-content wp-chat-thinking";
        parts.push(
            `<div class="wp-chat-msg assistant" data-streaming="1"><div class="wp-chat-bubble">` +
            copyBtnHtml +
            `<div class="wp-chat-role">AI</div>` +
            `<div class="${contentClass}">${escapeHtml(content)}${hasContent ? '<span class="wp-chat-cursor"></span>' : ""}</div></div></div>`
        );
    }
    el.innerHTML = parts.join("");
    // 保存流式元素引用，后续 token 追加直接改 textContent，不重排
    g.streamingEl = el.querySelector('[data-streaming="1"]');
    el.scrollTop = el.scrollHeight;
}

// 流式 token 追加：直接改 DOM 文本，避免每次都重新生成 innerHTML
function appendStreamingToken(node, token) {
    const g = node._chat;
    if (!g.busy || !g.streamingEl) return;
    if (!g.streamingBuffer) {
        // 第一个 token 到达，把“思考中…”换成正式内容样式
        const ce = g.streamingEl.querySelector(".wp-chat-content");
        if (ce) ce.classList.remove("wp-chat-thinking");
    }
    g.streamingBuffer += token;
    const ce = g.streamingEl.querySelector(".wp-chat-content");
    if (ce) ce.textContent = g.streamingBuffer;
    if (g.historyEl) g.historyEl.scrollTop = g.historyEl.scrollHeight;
}

async function doSend(node) {
    const g = node._chat;
    if (g.busy) return;
    const text = ((g.inputEl && g.inputEl.value) || "").trim();
    if (!text) return;

    // 本地模型与 API 二选一：连了端口走本地，没连则要求已配置 API
    const modelInput = node.inputs ? node.inputs.find((i) => i.name === "qwen模型") : null;
    const hasLocal = !!(modelInput && modelInput.link);
    if (!hasLocal && !readApiConfig(node)) {
        alert("未连接本地模型，也未配置 API。\n\n请把「qwen模型」端口连到 🐳 WP 模型加载器，\n或点击输入框左下角的【⚙ 设置】配置 API 后再发送。");
        return;
    }

    // 生成本轮会话 ID，让后端推送的 token 能路由回这个节点
    const sid = genSid();
    g.streamingSid = sid;
    g.streamingBuffer = "";

    // 核心修复：发送时立即把本轮用户消息固化进「对话历史」widget。
    // 消息随画布/工作流快照持久化，切换画布或刷新页面后节点重建也不丢失；
    // 后端拼装上下文时会自动弹出尾部相同消息，不会发给模型两遍。
    g.history.push({ role: "user", content: text });
    saveHistory(node);

    streamingSessions.set(sid, node);
    pendingTurns.set(String(node.id), { sid, text });
    rememberSidResult(sid, { reply: "", error: "", buffer: "" });

    // 「用户输入」widget 写入带 SID 标记的文本，后端解析剥离
    const inputWidget = getInputWidget(node);
    if (inputWidget) inputWidget.value = wrapUserInputWithSid(sid, text);

    g.busy = true;
    feedWatchdog(node);
    if (g.inputEl) g.inputEl.value = "";
    saveDraft(node, ""); // 消息已固化进历史，草稿存档位一并清空

    renderHistory(node);
    node.setDirtyCanvas(true, true);

    try {
        // 部分执行：只运行当前聊天节点，画布上其它输出节点（保存/预览等）不跑；
        // 本节点依赖的上游（模型加载器、图片链）由服务端自动补算或走缓存。
        // 若前端版本过旧不支持第三参数，会退回整图运行（与旧行为一致）。
        const submitStartedAt = Date.now();
        await app.queuePrompt(0, 1, { queueNodeIds: [String(node.id)] });
        // 新版前端 queuePrompt 会吞掉验证错误（只弹全局 UI、不抛异常）：
        // 检查旁路拦截记录，本轮提交失败时把具体错误转投对话框并结束等待
        if (lastPromptSubmitError && lastPromptSubmitError.time >= submitStartedAt) {
            g.history.push({ role: "system", content: formatPromptSubmitError(lastPromptSubmitError.data) });
            rememberSidResult(sid, { error: "提交失败" });
            endTurn(node);
            return;
        }
    } catch (e) {
        console.error("[WP提示词对话] 执行失败：", e);
        // 失败：保留已固化的用户消息，补一条错误提示（与 execution_error 行为一致）
        g.history.push({ role: "system", content: `发送失败：${(e && e.message) || e}` });
        rememberSidResult(sid, { error: "发送失败" });
        endTurn(node);
    }
}

// 重新生成某一轮：msgIdx 为被点击的 AI 气泡在历史中的索引。
// 上下文由后端截断（[[WP_REGEN]] 标记）到该轮提问为止，干净重跑；
// 历史不动（原气泡及其后对话全保留），新结果以新气泡追加到对话末尾。
async function doRegenerate(node, msgIdx) {
    const g = node._chat;
    if (g.busy) return;
    const msg = g.history[msgIdx];
    if (!msg || msg.role !== "assistant" || !String(msg.content || "").trim()) return;
    // 目标提问：重新生成的结果气泡自带 regenOf（原提问文本，避免被其后的
    // 新对话轮次干扰找错提问）；普通回复则向前找最近的用户消息
    let text = "";
    if (msg.regenOf) {
        text = String(msg.regenOf);
    } else {
        let userIdx = -1;
        for (let i = msgIdx; i >= 0; i--) {
            if (g.history[i] && g.history[i].role === "user") { userIdx = i; break; }
        }
        if (userIdx < 0) return;
        text = String(g.history[userIdx].content || "");
    }
    text = text.trim();
    if (!text) return;

    // 模型可用性校验（与 doSend 同口径）
    const modelInput = node.inputs ? node.inputs.find((i) => i.name === "qwen模型") : null;
    const hasLocal = !!(modelInput && modelInput.link);
    if (!hasLocal && !readApiConfig(node)) {
        alert("未连接本地模型，也未配置 API。\n\n请把「qwen模型」端口连到 🐳 WP 模型加载器，\n或点击输入框左下角的【⚙ 设置】配置 API 后再重新生成。");
        return;
    }

    const sid = genSid();
    g.streamingSid = sid;
    g.streamingBuffer = "";
    g._regenOf = text;        // 本轮重新生成的目标提问：finalizeTurn 据此打版本标签
    g._regenLoadingIdx = msgIdx; // 被点击的按钮渲染为加载态

    // 历史不修改（原消息全保留）；只注册会话路由与恢复备份
    streamingSessions.set(sid, node);
    pendingTurns.set(String(node.id), { sid, text, regen: true });
    rememberSidResult(sid, { reply: "", error: "", buffer: "" });

    // 「用户输入」widget 写入带 SID + REGEN 标记的原提问，后端截断历史后重跑该轮
    const inputWidget = getInputWidget(node);
    if (inputWidget) inputWidget.value = wrapUserInputWithSid(sid, text, true);

    g.busy = true;
    feedWatchdog(node);
    renderHistory(node);
    node.setDirtyCanvas(true, true);

    try {
        const submitStartedAt = Date.now();
        await app.queuePrompt(0, 1, { queueNodeIds: [String(node.id)] });
        // 提交失败（未进入执行队列）：错误转投对话框并结束等待，按钮恢复可点支持重试
        if (lastPromptSubmitError && lastPromptSubmitError.time >= submitStartedAt) {
            g.history.push({ role: "system", content: formatPromptSubmitError(lastPromptSubmitError.data) });
            rememberSidResult(sid, { error: "重新生成提交失败" });
            endTurn(node);
            return;
        }
    } catch (e) {
        console.error("[WP提示词对话] 重新生成提交失败：", e);
        g.history.push({ role: "system", content: `重新生成失败：${(e && e.message) || e}` });
        rememberSidResult(sid, { error: "重新生成失败" });
        endTurn(node);
    }
}

// 结束一轮等待：清理所有临时状态（流式路由、看门狗、输入残留）并把历史写回 widget。
// 不追加任何 AI 回复；错误/清空/超时场景直接调用。
function endTurn(node) {
    const g = node._chat;
    pendingTurns.delete(String(node.id));
    if (g.streamingSid) {
        // 只有会话表仍指向本节点时才清除：防止画布切换后旧实例的看门狗
        // 误删新实例已接管的流式路由
        if (streamingSessions.get(g.streamingSid) === node) {
            streamingSessions.delete(g.streamingSid);
        }
        g.streamingSid = null;
    }
    g.streamingBuffer = "";
    g.streamingEl = null;
    g.busy = false;
    g._regenOf = null;
    g._regenLoadingIdx = -1;
    clearTimeout(g._watchdog);
    g._watchdog = null;
    const iw = getInputWidget(node);
    if (iw) iw.value = "";
    saveHistory(node);
    renderHistory(node);
    node.setDirtyCanvas(true, true);
}

// 固化一轮结果：把 AI 回复写入历史并结束等待。
// 幂等：非 busy 状态直接忽略，防已清空（doClear）/ 已超时 / 跨画布误投的过期回复污染记录。
// 重新生成轮的回复带 regenOf 字段（目标提问文本），渲染时据此显示版本标签。
function finalizeTurn(node, reply) {
    const g = node._chat;
    if (!g || !g.busy) return false;
    const finalReply = ((reply && String(reply).trim()) || g.streamingBuffer || "").trim();
    if (g.streamingSid) rememberSidResult(g.streamingSid, { reply: finalReply, buffer: "" });
    if (finalReply) {
        const item = { role: "assistant", content: finalReply };
        if (g._regenOf) item.regenOf = g._regenOf;
        g.history.push(item);
    }
    endTurn(node);
    return true;
}

// 看门狗：busy 期间长时间无任何 token/结果到达，判定回复丢失并回滚等待状态。
// token 到达只刷新 _lastActiveAt；定时器到期时自查空闲时长，近期有活动则自动续期。
function feedWatchdog(node) {
    const g = node._chat;
    if (!g.busy) return;
    g._lastActiveAt = Date.now();
    clearTimeout(g._watchdog);
    const check = () => {
        if (!g.busy) return;
        // 会话已被重建后的新节点接管（画布切换回来）时，旧实例放弃管理权，不误杀
        if (g.streamingSid && streamingSessions.get(g.streamingSid) !== node) return;
        const idle = Date.now() - (g._lastActiveAt || 0);
        if (idle < BUSY_TIMEOUT_MS) {
            clearTimeout(g._watchdog);
            g._watchdog = setTimeout(check, BUSY_TIMEOUT_MS - idle);
            return;
        }
        g.history.push({ role: "system", content: "等待回复超时：长时间未收到模型输出（可能因页面刷新或画布切换导致结果丢失），请重新发送。" });
        endTurn(node);
    };
    g._watchdog = setTimeout(check, BUSY_TIMEOUT_MS);
}

// 画布切换/页面刷新自愈：节点重建后（内存状态清零），恢复“等待回复中”状态。
// 恢复线索双保险：优先读「用户输入」widget 残留的 SID 标记（随画布快照持久化）；
// 若画布快照未保留 widget 直改值，则从模块级 pendingTurns 备份按节点 ID 找回。
function recoverPendingTurn(node) {
    const g = node._chat;
    if (g.busy) return;
    const inputWidget = getInputWidget(node);
    const raw = (inputWidget && inputWidget.value) || "";
    let sid = "";
    let text = "";
    let isRegen = false;
    const m = raw.match(/^\[\[WP_SID:([^\]]+)\]\]([\s\S]*)$/);
    if (m && m[2].trim()) {
        sid = m[1];
        text = m[2];
        // 剥离「重新生成」标记：恢复时按 regen 场景处理
        if (text.startsWith(REGEN_FLAG)) {
            isRegen = true;
            text = text.slice(REGEN_FLAG.length);
        }
    } else {
        const entry = pendingTurns.get(String(node.id));
        if (entry && entry.sid) {
            sid = entry.sid;
            text = entry.text || "";
            isRegen = !!entry.regen;
        }
        if (inputWidget && raw) inputWidget.value = "";
    }
    if (!sid || !text.trim()) {
        if (inputWidget && raw) inputWidget.value = "";
        return;
    }
    // 该会话仍由另一个实例持有时分两种情况：
    // - 旧实例还在当前活动画布（典型：同画布复制粘贴出的节点带了相同 SID）→ 不许抢路由
    // - 旧实例已不在活动画布（画布切换/刷新后重建）→ 由本节点接管
    const existing = streamingSessions.get(sid);
    if (existing && existing !== node) {
        const inActiveGraph = !!(app.graph && app.graph.getNodeById && app.graph.getNodeById(existing.id) === existing);
        if (inActiveGraph) {
            if (inputWidget) inputWidget.value = "";
            return;
        }
    }
    // 历史尾部应已含本轮用户消息（发送时固化）；极端时序下补一条。
    // 重新生成轮不补：目标提问已在历史中间，补到尾部反而会污染记录
    if (!isRegen) {
        const last = g.history[g.history.length - 1];
        if (!last || last.role !== "user" || last.content !== text) {
            g.history.push({ role: "user", content: text });
        }
    }
    g.busy = true;
    g.streamingSid = sid;
    if (isRegen) g._regenOf = text; // 恢复版本标签依据：固化回复时重新打上 regenOf
    streamingSessions.set(sid, node);
    // 切走画布期间已产生的结果/错误/流式内容，从暂存表恢复
    const cache = sidResults.get(sid);
    if (cache && cache.error) {
        g.history.push({ role: "system", content: cache.error });
        sidResults.delete(sid);
        endTurn(node);
        return;
    }
    if (cache && cache.reply) {
        const reply = cache.reply;
        sidResults.delete(sid);
        finalizeTurn(node, reply);
        return;
    }
    g.streamingBuffer = (cache && cache.buffer) || "";
    renderHistory(node);
    feedWatchdog(node);
    node.setDirtyCanvas(true, true);
}

// 拉取后端最新技能清单，刷新「使用技能」下拉框选项（技能文件热更新，无需重启）
async function refreshSkillCombo(node) {
    const w = node.widgets ? node.widgets.find((x) => x.name === "使用技能") : null;
    if (!w) return;
    try {
        const resp = await api.fetchApi("/wp_node/prompt_agent/skills");
        if (!resp || !resp.ok) return;
        const data = await resp.json();
        const list = Array.isArray(data && data.skills) ? data.skills : [];
        if (!list.length) return;
        w.options = w.options || {};
        w.options.values = list;
        if (!list.includes(w.value)) w.value = list[0] || "无";
        node.setDirtyCanvas(true, true);
    } catch (e) {
        /* 拉取失败保留旧列表 */
    }
}

// 按「图像数量」widget 同步图片输入端口：超出数量的图片口从尾部删除（连线一并断开），缺失的补上
function syncImageInputs(node) {
    const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_IMAGE_COUNT) : null;
    let count = parseInt(w && w.value, 10);
    if (!Number.isFinite(count)) count = 3;
    count = Math.max(1, Math.min(IMAGE_INPUT_MAX, count));
    if (w) w.value = count;
    if (!node.inputs) return;
    for (let i = node.inputs.length - 1; i >= 0; i--) {
        const inp = node.inputs[i];
        const n = inp && inp.name && inp.name.startsWith("图片") ? parseInt(inp.name.slice(2), 10) : NaN;
        if (Number.isFinite(n) && n > count) node.removeInput(i);
    }
    for (let n = 1; n <= count; n++) {
        const name = "图片" + n;
        if (!node.inputs.find((i) => i.name === name)) node.addInput(name, "IMAGE");
    }
    node.setDirtyCanvas(true, true);
}

function doClear(node) {
    const g = node._chat;
    // 清空时若有正在进行的流式会话，也一并清掉（后端照常跑完，
    // 但 onExecuted 因 busy=false 会丢弃回复，不再污染新记录）
    pendingTurns.delete(String(node.id));
    if (g.streamingSid) {
        streamingSessions.delete(g.streamingSid);
        g.streamingSid = null;
    }
    g.history = [];
    g.streamingBuffer = "";
    g.streamingEl = null;
    g.busy = false;
    g._regenOf = null;
    g._regenLoadingIdx = -1;
    clearTimeout(g._watchdog);
    g._watchdog = null;
    saveHistory(node);
    // 只清聊天记录，输入框里未发送的草稿保留；
    // 隐藏「用户输入」widget 照旧清空（防残留 SID 在画布切换后被恢复成假会话）
    const inputWidget = getInputWidget(node);
    if (inputWidget) inputWidget.value = "";
    renderHistory(node);
    node.setDirtyCanvas(true, true);
}

const STYLE_ID = "wp_prompt_agent_chat_style";
function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .wp-chat-root {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        padding: 4px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-family: 'Segoe UI','Microsoft YaHei',sans-serif;
        pointer-events: auto;
        min-height: 0; /* 关键：让 flex 子项能正确收缩 */
      }
      .wp-chat-history {
        flex: 1 1 auto;
        min-height: 80px;
        overflow-y: auto;
        box-sizing: border-box;
        background: #1a1a1c; border: 1px solid #333; border-radius: 8px;
        padding: 8px; font-size: 12px; line-height: 1.55;
      }
      .wp-chat-empty {
        height: 100%; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 4px;
        color: #777; text-align: center; padding: 12px;
      }
      .wp-chat-empty-icon { font-size: 22px; opacity: .8; }
      .wp-chat-empty-sub { font-size: 11px; color: #5c5c60; }
      /* 气泡排版：用户靠右、AI/系统靠左 */
      .wp-chat-msg { display: flex; margin-bottom: 8px; }
      .wp-chat-msg.user { justify-content: flex-end; }
      .wp-chat-msg.assistant, .wp-chat-msg.system { justify-content: flex-start; }
      .wp-chat-bubble {
        position: relative;
        max-width: 88%; box-sizing: border-box;
        background: #222226; border: 1px solid #333; border-radius: 10px;
        padding: 5px 10px 6px; word-break: break-word; white-space: pre-wrap;
      }
      /* 复制按钮：默认隐藏，鼠标移到气泡上才出现 */
      .wp-chat-copy-btn {
        position: absolute; top: 2px; right: 2px;
        width: 22px; height: 22px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border-radius: 5px; border: 1px solid #4a4a4c;
        background: #2a2a2c; color: #b9b9bd; cursor: pointer;
        opacity: 0; transition: opacity .12s ease;
      }
      .wp-chat-bubble:hover .wp-chat-copy-btn { opacity: 1; }
      .wp-chat-copy-btn:hover { background: #3a3a3c; color: #e0e0e0; }
      .wp-chat-copy-btn.copied { color: #7ee2a8; border-color: #3f7f5c; }
      .wp-chat-copy-btn svg { display: block; }
      .wp-chat-msg.user .wp-chat-bubble { border-color: rgba(110,168,254,.35); }
      /* —— AI 气泡底部操作栏（重新生成） —— */
      .wp-chat-actions {
        display: flex; align-items: center; gap: 6px;
        margin-top: 4px; padding-top: 3px;
        border-top: 1px solid rgba(255,255,255,.06);
      }
      .wp-chat-regen-btn {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px; border-radius: 5px;
        border: 1px solid #4a4a4c; background: transparent;
        color: #8a8a90; cursor: pointer; font-size: 11px; line-height: 1.4;
        opacity: .75; transition: opacity .12s ease, background .12s ease, color .12s ease;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      }
      .wp-chat-regen-btn:hover { background: #3a3a3c; color: #e0e0e0; opacity: 1; }
      .wp-chat-regen-btn:disabled { opacity: .3; cursor: not-allowed; }
      .wp-chat-regen-btn:disabled:hover { background: transparent; color: #8a8a90; }
      .wp-chat-regen-btn svg { display: block; flex: 0 0 auto; }
      .wp-chat-regen-btn.wp-chat-regen-loading { opacity: 1; color: #b99af5; border-color: rgba(102,42,213,.5); }
      .wp-regen-spin { animation: wpRegenSpin 1s linear infinite; }
      @keyframes wpRegenSpin { to { transform: rotate(360deg); } }
      /* 触屏设备（无鼠标悬停）：按钮常显，避免移动端找不到入口 */
      @media (hover: none) {
        .wp-chat-regen-btn { opacity: 1; }
      }
      /* 重新生成结果气泡的版本标签 */
      .wp-chat-regen-tag {
        display: inline-block; margin-left: 6px; padding: 0 5px;
        border-radius: 4px; font-size: 10px; font-weight: normal;
        background: rgba(102,42,213,.18); border: 1px solid rgba(102,42,213,.4);
        color: #b99af5; vertical-align: 1px; white-space: nowrap;
      }
      .wp-chat-role { font-weight: bold; font-size: 11px; margin-bottom: 1px; }
      .wp-chat-msg.user .wp-chat-role { color: #6ea8fe; }
      .wp-chat-msg.assistant .wp-chat-role { color: #7ee2a8; }
      .wp-chat-msg.system .wp-chat-role { color: #c9a6ff; }
      .wp-chat-content { color: #d5d5d8; }
      .wp-chat-thinking { color: #7ee2a8; }
      .wp-chat-cursor {
        display: inline-block; width: 7px; height: 13px; margin-left: 2px;
        background: #7ee2a8; vertical-align: -2px; border-radius: 1px;
        animation: wpCursorBlink 1s steps(1) infinite;
      }
      @keyframes wpCursorBlink { 50% { opacity: 0; } }
      .wp-chat-input-row {
        flex: 0 0 auto; /* 固定在底部，不被压缩 */
        position: relative; /* 输入框高度拉伸手柄的定位锚点 */
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .wp-chat-input {
        width: 100%; box-sizing: border-box; height: 56px; resize: none;
        background: #1a1a1c; border: 1px solid #333; border-radius: 8px;
        color: #e0e0e0; padding: 6px 8px; font-size: 12px;
        font-family: inherit; outline: none;
      }
      .wp-chat-input:focus { border-color: #662ad5; }
      /* 输入框高度拉伸手柄：钉在输入框右上角（绝对定位于输入行，不随内容滚动偏移） */
      .wp-chat-input-grip {
        position: absolute; top: -9px; right: 6px; z-index: 3;
        width: 18px; height: 16px; line-height: 14px; text-align: center;
        font-size: 10px; color: #b9b9c0; cursor: ns-resize;
        background: #2a2a2c; border: 1px solid #4a4a4c; border-radius: 5px;
        user-select: none; touch-action: none;
      }
      .wp-chat-input-grip:hover { color: #fff; border-color: #7d4be0; background: #662ad5; }
      body.wp-chat-resizing { cursor: ns-resize; user-select: none; }
      .wp-chat-btn-row { display: flex; align-items: center; gap: 6px; }
      .wp-chat-btn-row .wp-chat-spacer { flex: 1 1 auto; }
      .wp-chat-btn {
        padding: 5px 14px; border-radius: 6px; border: 1px solid #4a4a4c;
        background: #2a2a2c; color: #e0e0e0; cursor: pointer; font-size: 12px;
      }
      .wp-chat-btn:hover { background: #3a3a3c; }
      .wp-chat-send { background: #662ad5; border-color: #7d4be0; color: #fff; }
      .wp-chat-send:hover { background: #7d4be0; }
      .wp-chat-icon-btn {
        width: 28px; height: 28px; padding: 0;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 6px; border: 1px solid #4a4a4c;
        background: #2a2a2c; color: #b9b9bd; cursor: pointer;
      }
      .wp-chat-icon-btn:hover { background: #3a3a3c; color: #e0e0e0; }
      .wp-chat-icon-btn svg { display: block; }
      .wp-chat-icon-btn:disabled { opacity: .35; cursor: not-allowed; }
      .wp-chat-icon-btn:disabled:hover { background: #2a2a2c; color: #b9b9bd; }
      .wp-chat-icon-btn.wp-active { background: #3d2a6e; border-color: #662ad5; color: #b99af5; }
      .wp-chat-icon-btn.wp-active:hover { background: #4a347f; }
      /* —— API 设置弹窗（同色系深色风格） —— */
      .wp-chat-modal-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,.6);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Segoe UI','Microsoft YaHei',sans-serif;
      }
      .wp-chat-modal {
        width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px);
        overflow-y: auto; box-sizing: border-box;
        background: #1a1a1c; border: 1px solid #3a3a3c; border-radius: 10px;
        padding: 16px 18px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
      }
      .wp-chat-modal-title { font-size: 14px; font-weight: bold; color: #e0e0e0; margin-bottom: 4px; }
      .wp-chat-modal-desc { font-size: 11px; color: #8a8a90; line-height: 1.5; margin-bottom: 12px; }
      .wp-chat-modal-field { margin-bottom: 10px; }
      .wp-chat-modal-field label {
        display: block; font-size: 11px; color: #a8a8ae; margin-bottom: 3px;
      }
      .wp-chat-modal-field input {
        width: 100%; box-sizing: border-box;
        background: #222226; border: 1px solid #3a3a3c; border-radius: 6px;
        color: #e0e0e0; padding: 6px 8px; font-size: 12px; outline: none;
        font-family: inherit;
      }
      .wp-chat-modal-field input:focus { border-color: #662ad5; }
      .wp-chat-modal-field input::placeholder { color: #5c5c60; }
      /* API Key 小眼睛切换 */
      .wp-chat-key-wrap { position: relative; }
      .wp-chat-key-wrap input { padding-right: 32px; }
      .wp-chat-eye {
        position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
        width: 24px; height: 24px; padding: 0; border: none; background: transparent;
        color: #8a8a90; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .wp-chat-eye:hover { color: #e0e0e0; }
      .wp-chat-eye-on { color: #7ee2a8; }
      .wp-chat-modal-row { display: flex; gap: 10px; }
      .wp-chat-modal-row .wp-chat-modal-field { flex: 1; }
      .wp-chat-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
      .wp-chat-modal-note { font-size: 11px; color: #6a6a70; margin-top: 10px; line-height: 1.5; }
    `;
    document.head.appendChild(s);
}

// 打开 API 设置弹窗：读写节点「API配置」widget（随工作流持久化）
function openSettingsDialog(node) {
    // 已打开则不重复弹
    if (document.querySelector(".wp-chat-modal-overlay")) return;
    const cfg = readApiConfig(node) || {};
    const turnsWidget = node.widgets ? node.widgets.find((x) => x.name === "最大轮数") : null;
    const turnsInit = parseInt(turnsWidget && turnsWidget.value, 10) || 60;
    const imgCountWidget = node.widgets ? node.widgets.find((x) => x.name === WIDGET_IMAGE_COUNT) : null;
    const imgCountInit = parseInt(imgCountWidget && imgCountWidget.value, 10) || 3;

    const overlay = document.createElement("div");
    overlay.className = "wp-chat-modal-overlay";

    const panel = document.createElement("div");
    panel.className = "wp-chat-modal";
    panel.innerHTML = `
      <div class="wp-chat-modal-title">⚙ API 设置</div>
      <div class="wp-chat-modal-desc">连接本地模型时优先使用本地模型；「qwen模型」端口未连接时，将使用下方 API 配置对话。</div>
      <div class="wp-chat-modal-field">
        <label>API 地址（OpenAI 兼容接口）</label>
        <input data-k="api_url" type="text" placeholder="https://api-inference.modelscope.cn/v1/chat/completions"
          value="${escapeHtml(cfg.api_url || "")}">
      </div>
      <div class="wp-chat-modal-field">
        <label>API Key</label>
        <div class="wp-chat-key-wrap">
          <input data-k="api_key" type="password" placeholder="ms-xxxxxxxx（魔搭令牌 / OpenAI sk-…）"
            value="${escapeHtml(cfg.api_key || "")}">
          <button class="wp-chat-eye" data-act="eye" type="button" title="显示 / 隐藏 API Key">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>
          </button>
        </div>
      </div>
      <div class="wp-chat-modal-field">
        <label>模型名称</label>
        <input data-k="model" type="text" placeholder="Qwen/Qwen3-VL-235B-A22B-Instruct"
          value="${escapeHtml(cfg.model || "")}">
      </div>
      <div class="wp-chat-modal-row">
        <div class="wp-chat-modal-field">
          <label>最大回复 token</label>
          <input data-k="max_tokens" type="number" min="1" max="100000" value="${Number(cfg.max_tokens) || 3000}">
        </div>
        <div class="wp-chat-modal-field">
          <label>随机种子（0 = 随机）</label>
          <input data-k="seed" type="number" min="0" max="9999999999" value="${Number(cfg.seed) || 0}">
        </div>
      </div>
      <div class="wp-chat-modal-field">
        <label>对话最大轮数（历史消息条数上限，用户+AI 合计，超过自动删最旧）</label>
        <input data-k="max_turns" type="number" min="1" max="500" value="${turnsInit}">
      </div>
      <div class="wp-chat-modal-field">
        <label>图像输入数量（1-10，调小会断开多余端口上已连的线）</label>
        <input data-k="image_count" type="number" min="1" max="${IMAGE_INPUT_MAX}" value="${imgCountInit}">
      </div>
      <div class="wp-chat-modal-actions">
        <button class="wp-chat-btn" data-act="clear" type="button">清除配置</button>
        <button class="wp-chat-btn" data-act="cancel" type="button">取消</button>
        <button class="wp-chat-btn wp-chat-send" data-act="save" type="button">保存</button>
      </div>
      <div class="wp-chat-modal-note">提示：配置会随工作流文件保存（API Key 为明文），分享工作流前请注意清除。魔搭免费额度：每模型 500 次/天，总计 2000 次/天。</div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const inputs = {};
    panel.querySelectorAll("input[data-k]").forEach((el) => { inputs[el.dataset.k] = el; });

    function close() {
        overlay.remove();
    }
    function saveValue(val) {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_API_CFG) : null;
        if (w) w.value = val;
        node.setDirtyCanvas(true, true);
    }

    overlay.addEventListener("pointerdown", (e) => {
        if (e.target === overlay) close();
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
            e.preventDefault();
            panel.querySelector('[data-act="save"]').click();
        }
    });

    panel.querySelector('[data-act="cancel"]').addEventListener("click", close);
    // 小眼睛：切换 API Key 明文 / 密文显示
    const eyeBtn = panel.querySelector('[data-act="eye"]');
    eyeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    eyeBtn.addEventListener("click", () => {
        const inp = inputs.api_key;
        const show = inp.type === "password";
        inp.type = show ? "text" : "password";
        eyeBtn.classList.toggle("wp-chat-eye-on", show);
        inp.focus();
    });
    panel.querySelector('[data-act="clear"]').addEventListener("click", () => {
        saveValue("");
        close();
    });
    panel.querySelector('[data-act="save"]').addEventListener("click", () => {
        // 轮数独立保存：与 API 配置无关，未填 API 也能保存轮数
        const turns = parseInt(inputs.max_turns.value, 10);
        if (turnsWidget) {
            turnsWidget.value = Number.isFinite(turns) && turns >= 1 ? Math.min(turns, 500) : 60;
            node.setDirtyCanvas(true, true);
        }
        // 图像数量独立保存：写回 widget 并立即同步图片输入端口
        const imgCount = parseInt(inputs.image_count.value, 10);
        if (imgCountWidget) {
            imgCountWidget.value = Number.isFinite(imgCount) ? Math.max(1, Math.min(IMAGE_INPUT_MAX, imgCount)) : 3;
            syncImageInputs(node);
        }
        const newCfg = {
            api_url: (inputs.api_url.value || "").trim(),
            api_key: (inputs.api_key.value || "").trim(),
            model: (inputs.model.value || "").trim(),
            max_tokens: parseInt(inputs.max_tokens.value, 10) || 3000,
            seed: parseInt(inputs.seed.value, 10) || 0,
        };
        if (!newCfg.api_url || !newCfg.api_key || !newCfg.model) {
            alert("API 地址、API Key、模型名称三项都必填。\n\n如不想使用 API 模式，请点「清除配置」或「取消」。");
            return;
        }
        saveValue(JSON.stringify(newCfg));
        close();
    });

    inputs.api_url.focus();
}

function buildChatPanel(node) {
    const g = node._chat;

    const root = document.createElement("div");
    root.className = "wp-chat-root";

    const history = document.createElement("div");
    history.className = "wp-chat-history";
    root.appendChild(history);
    g.historyEl = history;

    // 复制 / 重新生成按钮：事件委托（气泡每次渲染全量重建，统一在这里处理点击）
    history.addEventListener("pointerdown", (e) => e.stopPropagation());
    history.addEventListener("click", (e) => {
        const regenBtn = e.target.closest(".wp-chat-regen-btn");
        if (regenBtn) {
            e.stopPropagation();
            if (regenBtn.disabled) return;
            const idx = parseInt(regenBtn.dataset.idx, 10);
            if (Number.isFinite(idx)) doRegenerate(node, idx);
            return;
        }
        const btn = e.target.closest(".wp-chat-copy-btn");
        if (!btn) return;
        e.stopPropagation();
        const bubble = btn.closest(".wp-chat-bubble");
        const contentEl = bubble ? bubble.querySelector(".wp-chat-content") : null;
        const text = contentEl ? contentEl.textContent : "";
        if (!text) return;
        const done = () => {
            btn.classList.add("copied");
            const oldTitle = btn.title;
            btn.title = "已复制 ✓";
            setTimeout(() => {
                btn.classList.remove("copied");
                btn.title = oldTitle;
            }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        } else {
            fallbackCopy(text, done);
        }
    });

    const inputRow = document.createElement("div");
    inputRow.className = "wp-chat-input-row";

    const textarea = document.createElement("textarea");
    textarea.className = "wp-chat-input";
    textarea.placeholder = "输入内容，Enter 发送 / Shift+Enter 换行";
    inputRow.appendChild(textarea);
    g.inputEl = textarea;

    // —— 输入框高度拉伸手柄：右上角拖拽调整高度（最小=默认 56px，最大=3 倍默认） ——
    const INPUT_MIN_H = 56;
    const INPUT_MAX_H = INPUT_MIN_H * 3;
    const grip = document.createElement("div");
    grip.className = "wp-chat-input-grip";
    grip.title = "拖拽调整输入框高度";
    grip.textContent = "⇕";
    inputRow.appendChild(grip);
    grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        grip.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const startH = textarea.getBoundingClientRect().height;
        document.body.classList.add("wp-chat-resizing");
        const onMove = (ev) => {
            // 手柄在顶边：向上拖=变高，向下拖=变矮；边界夹紧到 [最小, 最大]
            const h = Math.min(INPUT_MAX_H, Math.max(INPUT_MIN_H, Math.round(startH + (startY - ev.clientY))));
            textarea.style.height = h + "px";
        };
        const onUp = (ev) => {
            grip.releasePointerCapture(ev.pointerId);
            grip.removeEventListener("pointermove", onMove);
            grip.removeEventListener("pointerup", onUp);
            grip.removeEventListener("pointercancel", onUp);
            document.body.classList.remove("wp-chat-resizing");
        };
        grip.addEventListener("pointermove", onMove);
        grip.addEventListener("pointerup", onUp);
        grip.addEventListener("pointercancel", onUp);
    });

    const btnRow = document.createElement("div");
    btnRow.className = "wp-chat-btn-row";

    // 左侧：API 设置齿轮按钮
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "wp-chat-icon-btn";
    settingsBtn.type = "button";
    settingsBtn.title = "API 设置（未连本地模型时使用）";
    settingsBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>';

    // 仅输出内容开关：开启后回复只输出提示词内容本身（不带解释/寒暄）
    const onlyBtn = document.createElement("button");
    onlyBtn.className = "wp-chat-icon-btn";
    onlyBtn.type = "button";
    onlyBtn.title = "仅输出内容：开启后回复只输出提示词内容本身，不带解释和寒暄";
    onlyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M4,5h16c0.55,0,1,0.45,1,1s-0.45,1-1,1H4C3.45,7,3,6.55,3,6S3.45,5,4,5z M4,11h16c0.55,0,1,0.45,1,1s-0.45,1-1,1H4c-0.55,0-1-0.45-1-1S3.45,11,4,11z M4,17h10c0.55,0,1,0.45,1,1s-0.45,1-1,1H4c-0.55,0-1-0.45-1-1S3.45,17,4,17z"/></svg>';

    function syncOnlyBtn() {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_ONLY_OUTPUT) : null;
        const on = !!(w && w.value);
        onlyBtn.classList.toggle("wp-active", on);
        onlyBtn.title = on
            ? "仅输出内容：已开启（点击关闭）——回复只输出提示词内容本身"
            : "仅输出内容：已关闭（点击开启）——回复只输出提示词内容本身";
    }
    syncOnlyBtn();
    onlyBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_ONLY_OUTPUT) : null;
        if (w) {
            w.value = !w.value;
            node.setDirtyCanvas(true, true);
        }
        syncOnlyBtn();
    });

    // 卸载模型开关：开启后每次本地推理完成自动卸载模型释放显存（仅本地模型模式可用）
    const unloadBtn = document.createElement("button");
    unloadBtn.className = "wp-chat-icon-btn";
    unloadBtn.type = "button";
    unloadBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M5,17h14v2H5V17z M12,3l6.6,8H5.4L12,3z"/></svg>';

    function hasLocalModel() {
        const inp = node.inputs ? node.inputs.find((x) => x.name === LOCAL_MODEL_INPUT) : null;
        return !!(inp && inp.link !== null && inp.link !== undefined);
    }

    function syncUnloadBtn() {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_UNLOAD_MODEL) : null;
        const on = !!(w && w.value);
        const connected = hasLocalModel();
        unloadBtn.disabled = !connected;
        unloadBtn.classList.toggle("wp-active", on && connected);
        unloadBtn.title = !connected
            ? "卸载模型：未连接本地模型（API 模式无需卸载）"
            : on
                ? "卸载模型：已开启（点击关闭）——每次本地推理完成后自动卸载模型释放显存，下次运行需重新加载"
                : "卸载模型：已关闭（点击开启）——每次本地推理完成后自动卸载模型释放显存";
    }
    syncUnloadBtn();
    g.unloadBtnSync = syncUnloadBtn;
    unloadBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (unloadBtn.disabled) return;
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_UNLOAD_MODEL) : null;
        if (w) {
            w.value = !w.value;
            node.setDirtyCanvas(true, true);
        }
        syncUnloadBtn();
    });

    // 弹性空隙：设置靠左，清空/发送靠右
    const spacer = document.createElement("div");
    spacer.className = "wp-chat-spacer";

    const clearBtn = document.createElement("button");
    clearBtn.className = "wp-chat-btn wp-chat-clear";
    clearBtn.textContent = "清空";
    clearBtn.type = "button";

    const sendBtn = document.createElement("button");
    sendBtn.className = "wp-chat-btn wp-chat-send";
    sendBtn.textContent = "发送";
    sendBtn.type = "button";

    btnRow.appendChild(settingsBtn);
    btnRow.appendChild(onlyBtn);
    btnRow.appendChild(unloadBtn);
    btnRow.appendChild(spacer);
    btnRow.appendChild(clearBtn);
    btnRow.appendChild(sendBtn);
    inputRow.appendChild(btnRow);
    root.appendChild(inputRow);

    // —— 交互事件：阻止冒泡，避免拖动节点/缩放画布 ——
    root.addEventListener("pointerdown", (e) => e.stopPropagation());
    root.addEventListener("mousedown", (e) => e.stopPropagation());
    root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

    textarea.addEventListener("pointerdown", (e) => e.stopPropagation());
    // 草稿实时存档：每个按键同步进「输入草稿」widget（随画布快照持久化），
    // 画布切换/节点重建后由 onConfigure → restoreDraft 回填；程序清空 value 不触发 input
    textarea.addEventListener("input", () => saveDraft(node, textarea.value));
    textarea.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            doSend(node);
        }
    });

    sendBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        doSend(node);
    });
    clearBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        doClear(node);
    });
    settingsBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSettingsDialog(node);
    });

    g.rootEl = root;

    const domWidget = node.addDOMWidget("wp_chat", "wp_chat_custom", root, {
        serialize: false,
        hideOnZoom: false,
        // 弹性布局（与 ComfyUI 内置视频预览组件同一机制）：
        // 面板自动填满节点剩余高度，节点拉伸即变大、缩小不小于 220。
        // 注意：不要再覆盖 computeSize，否则会退化为固定高度，拉伸时内容越出节点。
        getMinHeight: () => 220,
    });

    // 节点尺寸变化时强制 root 重新计算高度（CSS 已用 100% 自适应）
    const ro = new ResizeObserver(() => {
        if (g.historyEl && g.busy) {
            g.historyEl.scrollTop = g.historyEl.scrollHeight;
        }
    });
    if (domWidget && domWidget.element) {
        ro.observe(domWidget.element);
    } else {
        ro.observe(root.parentElement || root);
    }
    g._resizeObserver = ro;

    renderHistory(node);
    return domWidget;
}

function setupChat(node) {
    if (!node._chat) node._chat = { history: [], busy: false, streamingSid: null, streamingBuffer: "", streamingEl: null, _watchdog: null, _lastActiveAt: 0, _regenOf: null, _regenLoadingIdx: -1 };
    loadHistory(node);

    HIDDEN_WIDGETS.forEach((n) => hideWidget(node, n));

    node.size[0] = Math.max(node.size[0] || 0, 400);
    // 节点初始高度设为合理值（面板最小 220 + 标题/下拉框约 66），
    // 后续拉伸由前端布局引擎按 getMinHeight 弹性分配，无需手动同步高度
    node.size[1] = Math.max(node.size[1] || 0, 286);
    buildChatPanel(node);

    // 技能清单热更新（覆盖新拖出的节点；画布切换重建的场景在 onConfigure 里刷新）
    refreshSkillCombo(node);
    // 图片输入口数量同步（新节点按「图像数量」裁剪；画布切换/加载场景在 onConfigure 里同步）
    syncImageInputs(node);

    // 监听外部（如重载工作流）对「对话历史」widget 的改动
    const origCB = node.onWidgetChanged;
    node.onWidgetChanged = function (name, value, widget) {
        if (origCB) origCB.apply(this, arguments);
        if (name === WIDGET_HISTORY) {
            loadHistory(this);
            renderHistory(this);
        }
        if (name === WIDGET_IMAGE_COUNT) syncImageInputs(this);
        // 外部（undo/redo 等）改动草稿存档位 → 回写输入框；
        // 值相同则跳过，避免与 input 事件形成回环
        if (name === WIDGET_DRAFT) {
            const g = this._chat;
            const v = String(value || "");
            if (g && g.inputEl && g.inputEl.value !== v) g.inputEl.value = v;
        }
    };

    // 本地模型连线变化：刷新「卸载模型」按钮可用状态
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        if (origConn) origConn.apply(this, arguments);
        try {
            if (this._chat && this._chat.unloadBtnSync) {
                setTimeout(() => this._chat.unloadBtnSync(), 0);
            }
        } catch (e) {
            /* 刷新失败不影响连线 */
        }
    };
}

// ═══════════════════════════════════════════════
// 注册扩展
// ═══════════════════════════════════════════════
app.registerExtension({
    name: "WP.PromptAgent",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "WP_PromptAgent") return;

        // 节点创建：初始化聊天面板
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            ensureStyle();
            setupChat(this);
            return r;
        };

        // 节点执行完成：固化 AI 回复到历史（用户消息发送时已固化）
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            if (onExecuted) onExecuted.apply(this, arguments);
            try {
                const m = message || {};
                const replyArr = m.reply || (m.output && m.output.reply);
                const reply = Array.isArray(replyArr) ? (replyArr[0] || "") : "";
                const g = this._chat;
                if (!g) return;

                // 只有正在等待回复（busy）才固化本轮结果：已清空（doClear）/ 已超时 /
                // 跨画布误投（别的 workflow 恰好有同 id 节点）的回复一律丢弃。
                // 整画布运行的空输入轮走不到 busy=true，天然静默跳过。
                if (!g.busy) {
                    const iw = getInputWidget(this);
                    if (iw && String(iw.value || "").startsWith(SID_PREFIX)) iw.value = "";
                    return;
                }
                finalizeTurn(this, reply);
            } catch (e) {
                console.error("[WP提示词对话] onExecuted 处理失败：", e);
            }
        };

        // 重载已保存节点 / 画布切换重建时恢复状态
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);
            if (this._chat) {
                // 此时 widget 值已从画布快照恢复：
                // 1) 「对话历史」里含发送时固化的用户消息 → 恢复显示
                // 2) 「用户输入」里残留的 SID 标记 → 自愈"等待回复中"状态
                // 3) 「输入草稿」里的未发送草稿 → 回填重建后的空输入框
                loadHistory(this);
                renderHistory(this);
                recoverPendingTurn(this);
                refreshSkillCombo(this);
                syncImageInputs(this);
                restoreDraft(this);
                // 「卸载模型」开关值与本地模型连线均已恢复 → 刷新按钮高亮/可用状态
                if (this._chat.unloadBtnSync) this._chat.unloadBtnSync();
            }
        };
    },
});

// ═══════════════════════════════════════════════
// 全局事件监听：后端推送的流式 token，按 sid 路由到对应节点
// 事件 payload: { sid: "<会话ID>", token: "<token文本>", done: <bool> }
// ═══════════════════════════════════════════════
api.addEventListener(STREAM_EVENT, (e) => {
    try {
        const data = e.detail || {};
        const sid = data.sid;
        const node = sid ? streamingSessions.get(sid) : null;
        if (!node || !node._chat) return;
        if (data.token) {
            appendStreamingToken(node, data.token);
            node._chat._lastActiveAt = Date.now();
            // 已生成的流式内容同步进暂存表：切画布回来时接着显示，视觉上不中断
            rememberSidResult(sid, { buffer: node._chat.streamingBuffer });
        }
        // done=true 时不立即固化（等 onExecuted 统一处理），只清掉 sid 引用
        if (data.done) {
            // 这里不删 sid，留给 onExecuted 清理，避免 onExecuted 比 done 早到的边界情况
        }
    } catch (err) {
        console.error("[WP提示词对话] 流式 token 处理失败：", err);
    }
});

// ═══════════════════════════════════════════════
// 全局兜底：节点不在当前活动画布时（切到别的画布 tab），ComfyUI 不会调用
// 它的 onExecuted，回复会随节点重建而丢失。这里把结果记入暂存表，
// 等用户切回画布、recoverPendingTurn 消费固化。
// ═══════════════════════════════════════════════
api.addEventListener("executed", (e) => {
    try {
        const d = e.detail || {};
        // 注意：executed 事件的节点字段名是 node（execution.py send_sync），
        // 而 execution_error / execution_interrupted 用的是 node_id
        const evNodeId = d.node !== undefined ? d.node : d.node_id;
        const out = d.output || {};
        const replyArr = out.reply || d.reply;
        const reply = Array.isArray(replyArr) ? (replyArr[0] || "") : "";
        if (!reply || evNodeId === undefined) return;
        for (const [sid, node] of Array.from(streamingSessions.entries())) {
            if (String(node.id) !== String(evNodeId)) continue;
            // 只暂存。节点在活动画布时 ComfyUI 自己的分发会走 onExecuted →
            // finalizeTurn（幂等），这里不重复固化
            rememberSidResult(sid, { reply: String(reply), buffer: "" });
            break;
        }
    } catch (err) {
        console.error("[WP提示词对话] executed 兜底处理失败：", err);
    }
});

// ═══════════════════════════════════════════════
// 执行失败处理：后端抛错（如 API 网络错误）时回滚 busy 状态，
// 并把错误信息显示到聊天面板，避免节点永远卡在“思考中…”
// ═══════════════════════════════════════════════
api.addEventListener("execution_error", (e) => {
    try {
        const d = e.detail || {};
        const errMsg = `执行出错：${d.exception_message || d.exception_type || "未知错误"}`;
        for (const [sid, node] of Array.from(streamingSessions.entries())) {
            if (String(node.id) !== String(d.node_id)) continue;
            streamingSessions.delete(sid);
            // 节点不在当前活动画布时，在旧实例上改 widget 不会同步进画布快照，
            // 只记录暂存，切回画布后由 recoverPendingTurn 消费
            const active = !!(app.graph && app.graph.getNodeById && d.node_id !== undefined && app.graph.getNodeById(d.node_id) === node);
            if (!active) {
                rememberSidResult(sid, { error: errMsg });
                continue;
            }
            const g = node._chat;
            if (!g || !g.busy) continue;
            g.history.push({ role: "system", content: errMsg });
            endTurn(node);
        }
    } catch (err) {
        console.error("[WP提示词对话] execution_error 处理失败：", err);
    }
});

// ═══════════════════════════════════════════════
// 中断处理：用户点「中断」时后端抛 InterruptProcessingException，
// ComfyUI 广播 execution_interrupted（不带 error），不处理会让节点永远卡在“思考中…”
// ═══════════════════════════════════════════════
api.addEventListener("execution_interrupted", (e) => {
    try {
        const d = e.detail || {};
        const msg = "执行已被中断";
        for (const [sid, node] of Array.from(streamingSessions.entries())) {
            if (String(node.id) !== String(d.node_id)) continue;
            streamingSessions.delete(sid);
            const active = !!(app.graph && app.graph.getNodeById && d.node_id !== undefined && app.graph.getNodeById(d.node_id) === node);
            if (!active) {
                rememberSidResult(sid, { error: msg });
                continue;
            }
            const g = node._chat;
            if (!g || !g.busy) continue;
            g.history.push({ role: "system", content: msg });
            endTurn(node);
        }
    } catch (err) {
        console.error("[WP提示词对话] execution_interrupted 处理失败：", err);
    }
});
