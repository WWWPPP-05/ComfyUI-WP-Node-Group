// 🐳 WP PSD图层规划 — API 设置弹窗
// 复刻「🐳 WP 提示词对话」的 API 设置交互：隐藏裸露的「API配置」多行文本框，
// 换成「⚙ API设置」按钮 + 弹窗表单；保存写回隐藏 widget，随工作流持久化。
import { app } from "../../scripts/app.js";

const NODE_NAME = "WP_PsdPlanner";
const WIDGET_API_CFG = "API配置";
const STYLE_ID = "wp-psd-planner-style";

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 读取节点「API配置」widget：解析 JSON，无效返回 null
function readApiConfig(node) {
    try {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_API_CFG) : null;
        const cfg = JSON.parse((w && w.value || "").trim());
        return (cfg && typeof cfg === "object") ? cfg : null;
    } catch (e) {
        return null;
    }
}

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .wp-psd-modal-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,.6);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Segoe UI','Microsoft YaHei',sans-serif;
      }
      .wp-psd-modal {
        width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px);
        overflow-y: auto; box-sizing: border-box;
        background: #1a1a1c; border: 1px solid #3a3a3c; border-radius: 10px;
        padding: 16px 18px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
      }
      .wp-psd-modal-title { font-size: 14px; font-weight: bold; color: #e0e0e0; margin-bottom: 4px; }
      .wp-psd-modal-desc { font-size: 11px; color: #8a8a90; line-height: 1.5; margin-bottom: 12px; }
      .wp-psd-modal-field { margin-bottom: 10px; }
      .wp-psd-modal-field label { display: block; font-size: 11px; color: #a8a8ae; margin-bottom: 3px; }
      .wp-psd-modal-field input {
        width: 100%; box-sizing: border-box;
        background: #222226; border: 1px solid #3a3a3c; border-radius: 6px;
        color: #e0e0e0; padding: 6px 8px; font-size: 12px; outline: none;
        font-family: inherit;
      }
      .wp-psd-modal-field input:focus { border-color: #662ad5; }
      .wp-psd-modal-field input::placeholder { color: #5c5c60; }
      .wp-psd-key-wrap { position: relative; }
      .wp-psd-key-wrap input { padding-right: 32px; }
      .wp-psd-eye {
        position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
        width: 24px; height: 24px; padding: 0; border: none; background: transparent;
        color: #8a8a90; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .wp-psd-eye:hover { color: #e0e0e0; }
      .wp-psd-eye-on { color: #7ee2a8; }
      .wp-psd-modal-row { display: flex; gap: 10px; }
      .wp-psd-modal-row .wp-psd-modal-field { flex: 1; }
      .wp-psd-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
      .wp-psd-modal-note { font-size: 11px; color: #6a6a70; margin-top: 10px; line-height: 1.5; }
      .wp-psd-btn {
        background: #2a2a2c; border: 1px solid #4a4a4c; border-radius: 6px;
        color: #e0e0e0; padding: 6px 14px; font-size: 12px; cursor: pointer;
      }
      .wp-psd-btn:hover { background: #3a3a3c; }
      .wp-psd-btn-primary { background: #662ad5; border-color: #7d4be0; color: #fff; }
      .wp-psd-btn-primary:hover { background: #7d4be0; }
      /* 节点上的「⚙ API设置」按钮（DOM widget 容器内） */
      .wp-psd-settings-btn {
        width: 100%; box-sizing: border-box;
        background: #2a2a2c; border: 1px solid #4a4a4c; border-radius: 6px;
        color: #e0e0e0; padding: 6px 10px; font-size: 12px; cursor: pointer;
        font-family: inherit; text-align: center;
      }
      .wp-psd-settings-btn:hover { background: #3d2a6e; border-color: #662ad5; color: #b99af5; }
    `;
    document.head.appendChild(s);
}

// 打开 API 设置弹窗：读写节点「API配置」widget（随工作流持久化）
function openSettingsDialog(node) {
    if (document.querySelector(".wp-psd-modal-overlay")) return;
    ensureStyle();
    const cfg = readApiConfig(node) || {};

    const overlay = document.createElement("div");
    overlay.className = "wp-psd-modal-overlay";

    const panel = document.createElement("div");
    panel.className = "wp-psd-modal";
    panel.innerHTML = `
      <div class="wp-psd-modal-title">⚙ API 设置</div>
      <div class="wp-psd-modal-desc">连接本地模型时优先使用本地模型；「qwen模型」端口未连接时，将使用下方 API 配置做图层规划。</div>
      <div class="wp-psd-modal-field">
        <label>API 地址（OpenAI 兼容接口）</label>
        <input data-k="api_url" type="text" placeholder="https://api-inference.modelscope.cn/v1/chat/completions"
          value="${escapeHtml(cfg.api_url || "")}">
      </div>
      <div class="wp-psd-modal-field">
        <label>API Key</label>
        <div class="wp-psd-key-wrap">
          <input data-k="api_key" type="password" placeholder="ms-xxxxxxxx（魔搭令牌 / OpenAI sk-…）"
            value="${escapeHtml(cfg.api_key || "")}">
          <button class="wp-psd-eye" data-act="eye" type="button" title="显示 / 隐藏 API Key">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>
          </button>
        </div>
      </div>
      <div class="wp-psd-modal-field">
        <label>模型名称</label>
        <input data-k="model" type="text" placeholder="Qwen/Qwen3-VL-235B-A22B-Instruct"
          value="${escapeHtml(cfg.model || "")}">
      </div>
      <div class="wp-psd-modal-row">
        <div class="wp-psd-modal-field">
          <label>最大回复 token</label>
          <input data-k="max_tokens" type="number" min="1" max="100000" value="${Number(cfg.max_tokens) || 3000}">
        </div>
        <div class="wp-psd-modal-field">
          <label>随机种子（0 = 随机）</label>
          <input data-k="seed" type="number" min="0" max="9999999999" value="${Number(cfg.seed) || 0}">
        </div>
      </div>
      <div class="wp-psd-modal-actions">
        <button class="wp-psd-btn" data-act="clear" type="button">清除配置</button>
        <button class="wp-psd-btn" data-act="cancel" type="button">取消</button>
        <button class="wp-psd-btn wp-psd-btn-primary" data-act="save" type="button">保存</button>
      </div>
      <div class="wp-psd-modal-note">提示：配置会随工作流文件保存（API Key 为明文），分享工作流前请注意清除。魔搭免费额度：每模型 500 次/天，总计 2000 次/天。</div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const inputs = {};
    panel.querySelectorAll("input[data-k]").forEach((el) => { inputs[el.dataset.k] = el; });

    function close() { overlay.remove(); }
    function saveValue(val) {
        const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_API_CFG) : null;
        if (w) w.value = val;
        node.setDirtyCanvas(true, true);
    }

    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
        if (e.key === "Enter") {
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
        eyeBtn.classList.toggle("wp-psd-eye-on", show);
        inp.focus();
    });
    panel.querySelector('[data-act="clear"]').addEventListener("click", () => {
        saveValue("");
        close();
    });
    panel.querySelector('[data-act="save"]').addEventListener("click", () => {
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

app.registerExtension({
    name: "WP.PsdPlanner",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            try {
                const node = this;
                ensureStyle();
                // 隐藏裸露的「API配置」多行文本框（值仍随工作流持久化，后端照常读取）
                const w = node.widgets ? node.widgets.find((x) => x.name === WIDGET_API_CFG) : null;
                if (w) {
                    w.hidden = true;
                    w.computeSize = () => [0, 0];
                }
                // 「⚙ API设置」按钮：DOM 按钮经 addDOMWidget 挂载
                // （与提示词对话节点同机制；原生 addWidget("button") 在新版前端点击回调不可靠）
                const root = document.createElement("div");
                const btn = document.createElement("button");
                btn.className = "wp-psd-settings-btn";
                btn.type = "button";
                btn.textContent = "⚙ API设置";
                btn.addEventListener("pointerdown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openSettingsDialog(node);
                });
                root.appendChild(btn);
                node.addDOMWidget("wp_psd_settings", "wp_psd_settings_custom", root, {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => 34,
                });
            } catch (e) {
                console.error("[WP PSD规划] 前端初始化失败：", e);
            }
            return r;
        };
    },
});
