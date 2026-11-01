import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════
// 🐳 WP 提示词优化 · 前端
// 复刻「提示词对话」节点的前端交互（无聊天面板部分）：
// - 弹性面板：输入框随节点拉伸自适应、底部工具栏固定停靠节点最底部
//   （输入值实时同步进隐藏的「提示词输入」widget，随工作流持久化）
// - ⚙ 设置弹窗：API 地址/Key/模型/token/种子 + 图像输入数量（写入「API配置」「图像数量」widget 持久化）
// - 图片端口显隐：按「图像数量」widget 动态增删 图片1..10 输入端口
// - 仅输出内容 / 卸载模型 开关按钮（读写同名 widget）
// - 技能下拉框热刷新（与原节点共用 /wp_node/prompt_agent/skills 接口）
// ═══════════════════════════════════════════════

// 需要隐藏的内部 widget（面板上只留「使用技能」下拉框；
// 「提示词输入」由弹性面板里的 textarea 同步写入）
const HIDDEN_WIDGETS = [
    "提示词输入", "最大生成token", "温度", "top_p", "top_k", "重复惩罚", "输出think块", "API配置", "仅输出内容", "图像数量", "卸载模型",
];

const WIDGET_INPUT = "提示词输入";

const WIDGET_API_CFG = "API配置";
const WIDGET_IMAGE_COUNT = "图像数量";
const WIDGET_ONLY_OUTPUT = "仅输出内容";
const WIDGET_UNLOAD_MODEL = "卸载模型";
const IMAGE_INPUT_MAX = 10;

// 本地模型输入端口名（用于检测是否连接本地模型，决定「卸载模型」按钮可用性）
const LOCAL_MODEL_INPUT = "qwen模型";

const STYLE_ID = "wp_prompt_optimizer_style";

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* 弹性面板根容器：填满节点剩余高度；输入框自适应、工具栏钉底 */
      .wp-opt-root {
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
      .wp-opt-input {
        flex: 1 1 auto;       /* 输入框占满剩余空间，随节点拉伸自适应 */
        min-height: 40px;
        width: 100%; box-sizing: border-box; resize: none;
        background: #1a1a1c; border: 1px solid #333; border-radius: 8px;
        color: #e0e0e0; padding: 6px 8px; font-size: 12px;
        font-family: inherit; outline: none;
      }
      .wp-opt-input:focus { border-color: #662ad5; }
      .wp-opt-input::placeholder { color: #5c5c60; }
      .wp-opt-bar {
        flex: 0 0 auto;      /* 工具栏固定高度，始终停靠面板最底部 */
        display: flex; align-items: center; gap: 6px;
        width: 100%; box-sizing: border-box; padding: 2px 0;
        pointer-events: auto;
      }
      .wp-opt-bar .wp-chat-spacer { flex: 1 1 auto; }
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
      .wp-opt-hint { font-size: 11px; color: #6a6a70; white-space: nowrap; }
      /* —— API 设置弹窗（同色系深色风格，与提示词对话节点一致） —— */
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
      .wp-chat-btn {
        padding: 5px 14px; border-radius: 6px; border: 1px solid #4a4a4c;
        background: #2a2a2c; color: #e0e0e0; cursor: pointer; font-size: 12px;
      }
      .wp-chat-btn:hover { background: #3a3a3c; }
      .wp-chat-send { background: #662ad5; border-color: #7d4be0; color: #fff; }
      .wp-chat-send:hover { background: #7d4be0; }
    `;
    document.head.appendChild(s);
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hideWidget(node, name) {
    const w = node.widgets ? node.widgets.find((x) => x.name === name) : null;
    if (w) {
        w.hidden = true;
        w.computeSize = () => [0, 0];
    }
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

// 打开 API 设置弹窗：读写节点「API配置」widget（随工作流持久化）
function openSettingsDialog(node) {
    // 已打开则不重复弹
    if (document.querySelector(".wp-chat-modal-overlay")) return;
    const cfg = readApiConfig(node) || {};
    const imgCountWidget = node.widgets ? node.widgets.find((x) => x.name === WIDGET_IMAGE_COUNT) : null;
    const imgCountInit = parseInt(imgCountWidget && imgCountWidget.value, 10) || 3;

    const overlay = document.createElement("div");
    overlay.className = "wp-chat-modal-overlay";

    const panel = document.createElement("div");
    panel.className = "wp-chat-modal";
    panel.innerHTML = `
      <div class="wp-chat-modal-title">⚙ API 设置</div>
      <div class="wp-chat-modal-desc">连接本地模型时优先使用本地模型；「qwen模型」端口未连接时，将使用下方 API 配置执行优化。</div>
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
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12,5c-5,0-9,4.5-10,7 1,2.5,5,7,10,7s9-4.5,10-7c-1-2.5-5-7-10-7zm0 11.5A4.5,4.5 0 1 1 12 7.5a4.5,4.5 0 0 1 0 9zM12 9.5a2.5,2.5 0 1 0 0 5 2.5,2.5 0 0 1 0-5z"/></svg>
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

// 构建弹性面板 DOM widget：输入框（自适应）+ 底部工具栏（⚙ 设置 / 仅输出内容 / 卸载模型）。
// 输入值实时同步进隐藏的「提示词输入」widget（直改 value 不触发 onWidgetChanged，无回环），
// 随工作流/画布快照持久化；节点重建后由 setupNode/onConfigure 回填。
function buildPanel(node) {
    const root = document.createElement("div");
    root.className = "wp-opt-root";

    // 输入框：flex:1 占满面板剩余高度，节点拉伸时自适应变高/变矮
    const textarea = document.createElement("textarea");
    textarea.className = "wp-opt-input";
    textarea.placeholder = "输入待优化的提示词…（开头可用 /技能名 切换技能，/help 查看技能清单）";
    root.appendChild(textarea);
    node._wpOpt = node._wpOpt || {};
    node._wpOpt.inputEl = textarea;

    // 输入实时同步进隐藏 widget（值随工作流保存；程序清空 value 不触发 input，无回环）
    textarea.addEventListener("input", () => {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_INPUT) : null;
        if (w) w.value = textarea.value;
    });
    // 从隐藏 widget 回填输入框（画布切换/重载/undo 恢复场景）
    node._wpOpt.restoreInput = () => {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_INPUT) : null;
        const v = String((w && w.value) || "");
        if (textarea.value !== v) textarea.value = v;
    };
    node._wpOpt.restoreInput();

    // 文本连线状态反馈：接入连线时输入框置灰（运行时使用连线内容），拔线自动恢复
    node._wpOpt.syncInputLinkState = () => {
        const inp = node.inputs ? node.inputs.find((i) => i.name === WIDGET_INPUT) : null;
        const linked = !!(inp && inp.link !== null && inp.link !== undefined);
        textarea.disabled = linked;
        textarea.placeholder = linked
            ? "已接入文本连线，运行时使用连线内容"
            : "输入待优化的提示词…（开头可用 /技能名 切换技能，/help 查看技能清单）";
    };
    node._wpOpt.syncInputLinkState();

    const bar = document.createElement("div");
    bar.className = "wp-opt-bar";

    // 左侧：API 设置齿轮按钮
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "wp-chat-icon-btn";
    settingsBtn.type = "button";
    settingsBtn.title = "API 设置（未连本地模型时使用）";
    settingsBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>';

    // 仅输出内容开关：开启后结果只输出提示词内容本身（不带解释/寒暄）
    const onlyBtn = document.createElement("button");
    onlyBtn.className = "wp-chat-icon-btn";
    onlyBtn.type = "button";
    onlyBtn.title = "仅输出内容：开启后结果只输出提示词内容本身，不带解释和寒暄";
    onlyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M4,5h16c0.55,0,1,0.45,1,1s-0.45,1-1,1H4C3.45,7,3,6.55,3,6S3.45,5,4,5z M4,11h16c0.55,0,1,0.45,1,1s-0.45,1-1,1H4c-0.55,0-1-0.45-1-1S3.45,11,4,11z M4,17h10c0.55,0,1,0.45,1,1s-0.45,1-1,1H4c-0.55,0-1-0.45-1-1S3.45,17,4,17z"/></svg>';

    function syncOnlyBtn() {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_ONLY_OUTPUT) : null;
        const on = !!(w && w.value);
        onlyBtn.classList.toggle("wp-active", on);
        onlyBtn.title = on
            ? "仅输出内容：已开启（点击关闭）——结果只输出提示词内容本身"
            : "仅输出内容：已关闭（点击开启）——结果只输出提示词内容本身";
    }
    syncOnlyBtn();
    node._wpOpt.onlyBtnSync = syncOnlyBtn;
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
    node._wpOpt.unloadBtnSync = syncUnloadBtn;
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

    const hint = document.createElement("div");
    hint.className = "wp-opt-hint";
    hint.textContent = "运行画布时执行";

    bar.appendChild(settingsBtn);
    bar.appendChild(onlyBtn);
    bar.appendChild(unloadBtn);
    bar.appendChild(hint);
    root.appendChild(bar);

    // —— 交互事件：阻止冒泡，避免拖动节点/缩放画布 ——
    root.addEventListener("pointerdown", (e) => e.stopPropagation());
    root.addEventListener("mousedown", (e) => e.stopPropagation());
    root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    settingsBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSettingsDialog(node);
    });

    // 弹性布局（与原节点聊天面板同一机制）：面板自动填满节点剩余高度，
    // 输入框 flex:1 自适应、工具栏钉底；节点拉伸即变大、缩小不小于最小高度。
    // 注意：不要覆盖 computeSize，否则会退化为固定高度，拉伸时内容越出节点。
    node.addDOMWidget("wp_opt_panel", "wp_opt_panel", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 96, // 输入框最小 40 + 工具栏 32 + 间距
    });
}

// 拉取后端最新技能清单，刷新「使用技能」下拉框选项（技能文件热更新，无需重启 ComfyUI）
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

function setupNode(node) {
    ensureStyle();
    HIDDEN_WIDGETS.forEach((n) => hideWidget(node, n));
    node.size[0] = Math.max(node.size[0] || 0, 400);
    // 节点初始高度（面板最小 96 + 标题/下拉框约 70），后续拉伸由布局引擎弹性分配
    node.size[1] = Math.max(node.size[1] || 0, 180);
    buildPanel(node);
    refreshSkillCombo(node);
    syncImageInputs(node);

    // 监听 widget 改动：「图像数量」→ 同步图片端口；「提示词输入」被外部
    // （undo/redo 等）改动 → 回填输入框；值相同跳过，避免与 input 事件回环
    const origCB = node.onWidgetChanged;
    node.onWidgetChanged = function (name, value, widget) {
        if (origCB) origCB.apply(this, arguments);
        if (name === WIDGET_IMAGE_COUNT) syncImageInputs(this);
        if (name === WIDGET_INPUT && this._wpOpt && this._wpOpt.restoreInput) {
            this._wpOpt.restoreInput();
        }
    };

    // 连线变化：刷新「卸载模型」按钮可用状态 + 文本连线输入框置灰状态
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        if (origConn) origConn.apply(this, arguments);
        try {
            if (this._wpOpt) {
                if (this._wpOpt.unloadBtnSync) setTimeout(() => this._wpOpt.unloadBtnSync(), 0);
                if (this._wpOpt.syncInputLinkState) setTimeout(() => this._wpOpt.syncInputLinkState(), 0);
            }
        } catch (e) {
            /* 刷新失败不影响连线 */
        }
    };
}

app.registerExtension({
    name: "WP.PromptOptimizer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "WP_PromptOptimizer") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            setupNode(this);
            return r;
        };

        // 画布切换/重载重建节点时：widget 值已从快照恢复，同步端口、输入框与按钮状态
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            refreshSkillCombo(this);
            syncImageInputs(this);
            if (this._wpOpt) {
                if (this._wpOpt.restoreInput) this._wpOpt.restoreInput();
                if (this._wpOpt.syncInputLinkState) this._wpOpt.syncInputLinkState();
                if (this._wpOpt.unloadBtnSync) this._wpOpt.unloadBtnSync();
                if (this._wpOpt.onlyBtnSync) this._wpOpt.onlyBtnSync();
            }
            return r;
        };
    },
});
