// 🐳 WP PSD拆解启动器 — 工作流下拉框 + 载入按钮 + 管理弹窗（存新/覆盖/删除）
// 交互机制复刻 wp_psd_planner.js：DOM widget 挂载 + 弹窗；后端 API 在 PSD拆解启动器节点.py 注册。
import { app } from "../../scripts/app.js";

const NODE_NAME = "WP_PsdSplitter";
const STYLE_ID = "wp-spl-style";
const API = "/wp_node/psd_splitter";

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function apiList() {
    const r = await fetch(`${API}/list`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || "获取列表失败");
    return j.workflows;
}

async function apiGet(name) {
    const r = await fetch(`${API}/get?name=${encodeURIComponent(name)}`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || "读取工作流失败");
    return j.data;
}

async function apiSave(name, data) {
    const r = await fetch(`${API}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, data }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || "保存失败");
    return j.overwritten;
}

async function apiDelete(name) {
    const r = await fetch(`${API}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || "删除失败");
}

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .wp-spl-node-row { width: 100%; box-sizing: border-box; }
      .wp-spl-select {
        width: 100%; box-sizing: border-box;
        background: #222226; border: 1px solid #3a3a3c; border-radius: 6px;
        color: #e0e0e0; padding: 5px 8px; font-size: 12px; outline: none;
        font-family: inherit; cursor: pointer;
      }
      .wp-spl-select:focus { border-color: #662ad5; }
      .wp-spl-btn-row { display: flex; gap: 8px; margin-top: 6px; }
      .wp-spl-btn {
        flex: 1; background: #2a2a2c; border: 1px solid #4a4a4c; border-radius: 6px;
        color: #e0e0e0; padding: 6px 8px; font-size: 12px; cursor: pointer; font-family: inherit;
      }
      .wp-spl-btn:hover { background: #3d2a6e; border-color: #662ad5; color: #b99af5; }
      .wp-spl-modal-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,.6);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Segoe UI','Microsoft YaHei',sans-serif;
      }
      .wp-spl-modal {
        width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px);
        overflow-y: auto; box-sizing: border-box;
        background: #1a1a1c; border: 1px solid #3a3a3c; border-radius: 10px;
        padding: 16px 18px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
      }
      .wp-spl-modal-title { font-size: 14px; font-weight: bold; color: #e0e0e0; margin-bottom: 4px; }
      .wp-spl-modal-desc { font-size: 11px; color: #8a8a90; line-height: 1.5; margin-bottom: 12px; }
      .wp-spl-save-row { display: flex; gap: 8px; margin-bottom: 12px; }
      .wp-spl-save-row input {
        flex: 1; box-sizing: border-box;
        background: #222226; border: 1px solid #3a3a3c; border-radius: 6px;
        color: #e0e0e0; padding: 6px 8px; font-size: 12px; outline: none; font-family: inherit;
      }
      .wp-spl-save-row input:focus { border-color: #662ad5; }
      .wp-spl-save-row input::placeholder { color: #5c5c60; }
      .wp-spl-list { border: 1px solid #3a3a3c; border-radius: 6px; max-height: 220px; overflow-y: auto; margin-bottom: 12px; }
      .wp-spl-item {
        padding: 7px 10px; font-size: 12px; color: #c8c8cc; cursor: pointer;
        border-bottom: 1px solid #262628; display: flex; justify-content: space-between; align-items: center;
      }
      .wp-spl-item:last-child { border-bottom: none; }
      .wp-spl-item:hover { background: #26262a; }
      .wp-spl-item.selected { background: #3d2a6e; color: #fff; }
      .wp-spl-item-empty { padding: 12px; font-size: 12px; color: #6a6a70; text-align: center; }
      .wp-spl-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .wp-spl-modal-btn {
        background: #2a2a2c; border: 1px solid #4a4a4c; border-radius: 6px;
        color: #e0e0e0; padding: 6px 14px; font-size: 12px; cursor: pointer; font-family: inherit;
      }
      .wp-spl-modal-btn:hover { background: #3a3a3c; }
      .wp-spl-modal-btn-primary { background: #662ad5; border-color: #7d4be0; color: #fff; }
      .wp-spl-modal-btn-primary:hover { background: #7d4be0; }
      .wp-spl-modal-btn-danger { color: #ff8080; }
      .wp-spl-modal-btn-danger:hover { background: #4a2226; border-color: #8a3a40; }
      .wp-spl-status { font-size: 11px; color: #7ee2a8; min-height: 16px; margin-bottom: 6px; }
      .wp-spl-status.err { color: #ff8080; }
    `;
    document.head.appendChild(s);
}

// 载入工作流到画布（整体替换，等同手动打开工作流文件）
async function loadWorkflow(name) {
    if (!name) { alert("请先在下拉框选择一个工作流。"); return; }
    if (!confirm(`载入「${name}」会替换当前画布，未保存的改动将丢失。\n\n（想保留当前画布请先取消，去「管理工作流」里保存）\n\n继续载入？`)) return;
    try {
        const data = await apiGet(name);
        app.loadGraphData(data);
    } catch (e) {
        alert(`载入失败：${e.message}`);
    }
}

// 管理弹窗：列表 + 存新 / 覆盖 / 删除
function openManagerDialog(node) {
    if (document.querySelector(".wp-spl-modal-overlay")) return;
    ensureStyle();

    const overlay = document.createElement("div");
    overlay.className = "wp-spl-modal-overlay";
    const panel = document.createElement("div");
    panel.className = "wp-spl-modal";
    panel.innerHTML = `
      <div class="wp-spl-modal-title">🗂 PSD拆解工作流管理</div>
      <div class="wp-spl-modal-desc">工作流保存在插件目录 workflows_psd/ 下。「存为/覆盖」保存的是<b>当前画布</b>的全部节点与连线。</div>
      <div class="wp-spl-save-row">
        <input data-k="newname" type="text" maxlength="60" placeholder="输入新工作流名称…">
        <button class="wp-spl-modal-btn wp-spl-modal-btn-primary" data-act="save-new" type="button">💾 存为新工作流</button>
      </div>
      <div class="wp-spl-list" data-k="list"></div>
      <div class="wp-spl-status" data-k="status"></div>
      <div class="wp-spl-actions">
        <button class="wp-spl-modal-btn wp-spl-modal-btn-danger" data-act="del" type="button">🗑 删除选中</button>
        <button class="wp-spl-modal-btn" data-act="overwrite" type="button">🔄 当前画布覆盖选中</button>
        <button class="wp-spl-modal-btn" data-act="close" type="button">关闭</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const $ = (k) => panel.querySelector(`[data-k="${k}"]`);
    const listEl = $("list"), statusEl = $("status"), nameInput = $("newname");
    let selected = null;

    function setStatus(msg, isErr) {
        statusEl.textContent = msg || "";
        statusEl.classList.toggle("err", !!isErr);
    }
    function close() { overlay.remove(); }

    function renderList(names) {
        listEl.innerHTML = "";
        if (!names.length) {
            listEl.innerHTML = '<div class="wp-spl-item-empty">暂无工作流（用上方「存为新工作流」创建）</div>';
            return;
        }
        for (const n of names) {
            const row = document.createElement("div");
            row.className = "wp-spl-item" + (n === selected ? " selected" : "");
            row.innerHTML = `<span>${escapeHtml(n)}</span>`;
            row.addEventListener("click", () => {
                selected = n;
                renderList(names);
            });
            listEl.appendChild(row);
        }
    }

    async function refresh() {
        try {
            const names = await apiList();
            if (selected && !names.includes(selected)) selected = null;
            renderList(names);
            return names;
        } catch (e) {
            setStatus(e.message, true);
            return [];
        }
    }

    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });

    panel.querySelector('[data-act="close"]').addEventListener("click", close);

    // 存为新工作流（当前画布）
    panel.querySelector('[data-act="save-new"]').addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) { setStatus("请先输入新工作流名称", true); nameInput.focus(); return; }
        try {
            const overwritten = await apiSave(name, app.graph.serialize());
            setStatus(overwritten ? `「${name}」已存在，已覆盖保存` : `已保存「${name}」`);
            nameInput.value = "";
            selected = name;
            await refresh();
            if (node._wpSplRefresh) node._wpSplRefresh(name);
        } catch (e) { setStatus(e.message, true); }
    });

    // 用当前画布覆盖选中项
    panel.querySelector('[data-act="overwrite"]').addEventListener("click", async () => {
        if (!selected) { setStatus("请先在列表中点选一个工作流", true); return; }
        if (!confirm(`用当前画布覆盖「${selected}」？\n（原内容将被替换，不可恢复）`)) return;
        try {
            await apiSave(selected, app.graph.serialize());
            setStatus(`已用当前画布覆盖「${selected}」`);
            if (node._wpSplRefresh) node._wpSplRefresh(selected);
        } catch (e) { setStatus(e.message, true); }
    });

    // 删除选中项
    panel.querySelector('[data-act="del"]').addEventListener("click", async () => {
        if (!selected) { setStatus("请先在列表中点选一个工作流", true); return; }
        if (!confirm(`删除工作流「${selected}」？\n（不可恢复）`)) return;
        try {
            await apiDelete(selected);
            setStatus(`已删除「${selected}」`);
            selected = null;
            await refresh();
            if (node._wpSplRefresh) node._wpSplRefresh();
        } catch (e) { setStatus(e.message, true); }
    });

    refresh();
    nameInput.focus();
}

app.registerExtension({
    name: "WP.PsdSplitter",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            try {
                const node = this;
                ensureStyle();

                // 隐藏后端「使用说明」文本框（说明放按钮组上方的小字）
                const w = node.widgets ? node.widgets.find((x) => x.name === "使用说明") : null;
                if (w) { w.hidden = true; w.computeSize = () => [0, 0]; }

                // ---- 下拉框 ----
                const selRoot = document.createElement("div");
                selRoot.className = "wp-spl-node-row";
                const select = document.createElement("select");
                select.className = "wp-spl-select";
                selRoot.appendChild(select);

                // ---- 载入 / 管理 按钮 ----
                const btnRoot = document.createElement("div");
                btnRoot.className = "wp-spl-node-row";
                const btnRow = document.createElement("div");
                btnRow.className = "wp-spl-btn-row";
                const loadBtn = document.createElement("button");
                loadBtn.className = "wp-spl-btn";
                loadBtn.type = "button";
                loadBtn.textContent = "📥 载入到画布";
                loadBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
                loadBtn.addEventListener("click", () => loadWorkflow(select.value));
                const mgrBtn = document.createElement("button");
                mgrBtn.className = "wp-spl-btn";
                mgrBtn.type = "button";
                mgrBtn.textContent = "🗂 管理工作流";
                mgrBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
                mgrBtn.addEventListener("click", () => openManagerDialog(node));
                btnRow.appendChild(loadBtn);
                btnRow.appendChild(mgrBtn);
                btnRoot.appendChild(btnRow);

                node.addDOMWidget("wp_spl_select", "wp_spl_select_custom", selRoot, {
                    serialize: false, hideOnZoom: false, getMinHeight: () => 30,
                });
                node.addDOMWidget("wp_spl_buttons", "wp_spl_buttons_custom", btnRoot, {
                    serialize: false, hideOnZoom: false, getMinHeight: () => 38,
                });

                // 刷新下拉框选项（管理弹窗操作后也会调用）
                node._wpSplRefresh = async function (preferName) {
                    try {
                        const names = await apiList();
                        const prev = preferName || select.value;
                        select.innerHTML = "";
                        if (!names.length) {
                            const opt = document.createElement("option");
                            opt.value = "";
                            opt.textContent = "（暂无工作流，点「管理工作流」创建）";
                            select.appendChild(opt);
                            return;
                        }
                        for (const n of names) {
                            const opt = document.createElement("option");
                            opt.value = n;
                            opt.textContent = n;
                            select.appendChild(opt);
                        }
                        if (names.includes(prev)) select.value = prev;
                    } catch (e) {
                        console.error("[WP PSD拆解] 拉取工作流列表失败：", e);
                    }
                };
                node._wpSplRefresh();
            } catch (e) {
                console.error("[WP PSD拆解] 前端初始化失败：", e);
            }
            return r;
        };
    },
});
