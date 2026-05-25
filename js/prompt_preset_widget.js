/**
 * 🐳 WP 提示词预设节点 - 前端扩展
 * 提供分组管理和增删改提示词预设的UI功能
 */
import { app } from "../../scripts/app.js";

// 节点类型名称
const NODE_TYPE = "WP_PromptPreset";

// API基础路径
const API_BASE = "/wp_node/prompt_presets";

// 创建自定义对话框
function createPresetDialog(title, options = {}) {
    const {
        groupName = "",
        presetName = "",
        presetContent = "",
        groups = [],
        isEdit = false,
        isGroupEdit = false
    } = options;

    return new Promise((resolve) => {
        // 创建遮罩层
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;

        // 创建对话框
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 8px;
            padding: 20px;
            width: 500px;
            max-width: 90%;
            max-height: 90%;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;

        // 标题
        const titleEl = document.createElement("h3");
        titleEl.textContent = title;
        titleEl.style.cssText = `
            margin: 0 0 15px 0;
            color: #fff;
            font-size: 16px;
        `;
        dialog.appendChild(titleEl);

        // 如果是分组管理对话框
        if (isGroupEdit) {
            createGroupManagementDialog(dialog, groups, resolve, overlay);
        } else {
            createPresetEditDialog(dialog, {
                groupName, presetName, presetContent, groups, isEdit
            }, resolve, overlay);
        }

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// 创建预设编辑对话框内容
function createPresetEditDialog(dialog, options, resolve, overlay) {
    const { groupName, presetName, presetContent, groups, isEdit } = options;

    // 分组选择
    const groupLabel = document.createElement("label");
    groupLabel.textContent = "所属分组:";
    groupLabel.style.cssText = `color: #ccc; display: block; margin-bottom: 5px;`;
    dialog.appendChild(groupLabel);

    // 分组选择容器
    const groupContainer = document.createElement("div");
    groupContainer.style.cssText = `
        display: flex;
        gap: 5px;
        margin-bottom: 15px;
    `;

    const groupSelect = document.createElement("select");
    groupSelect.style.cssText = `
        flex: 1;
        padding: 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        box-sizing: border-box;
    `;

    // 添加分组选项
    groups.forEach(group => {
        const option = document.createElement("option");
        option.value = group;
        option.textContent = group;
        if (group === groupName) option.selected = true;
        groupSelect.appendChild(option);
    });

    groupContainer.appendChild(groupSelect);

    // 管理分组按钮
    const manageGroupBtn = document.createElement("button");
    manageGroupBtn.textContent = "⚙️";
    manageGroupBtn.title = "管理分组";
    manageGroupBtn.style.cssText = `
        padding: 8px 12px;
        background: #444;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
        font-size: 14px;
    `;
    manageGroupBtn.onclick = () => {
        document.body.removeChild(overlay);
        resolve({ action: "manage_groups" });
    };
    groupContainer.appendChild(manageGroupBtn);

    dialog.appendChild(groupContainer);

    // 预设名称输入
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "预设名称:";
    nameLabel.style.cssText = `color: #ccc; display: block; margin-bottom: 5px;`;
    dialog.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = presetName;
    nameInput.style.cssText = `
        width: 100%;
        padding: 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        margin-bottom: 15px;
        box-sizing: border-box;
    `;
    dialog.appendChild(nameInput);

    // 内容输入
    const contentLabel = document.createElement("label");
    contentLabel.textContent = "提示词内容:";
    contentLabel.style.cssText = `color: #ccc; display: block; margin-bottom: 5px;`;
    dialog.appendChild(contentLabel);

    const contentInput = document.createElement("textarea");
    contentInput.value = presetContent;
    contentInput.style.cssText = `
        width: 100%;
        height: 150px;
        padding: 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        margin-bottom: 15px;
        box-sizing: border-box;
        resize: vertical;
        font-family: inherit;
    `;
    dialog.appendChild(contentInput);

    // 按钮容器
    const btnContainer = document.createElement("div");
    btnContainer.style.cssText = `
        display: flex;
        justify-content: flex-end;
        gap: 10px;
    `;

    // 创建按钮函数
    function createButton(text, isPrimary, onClick) {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.style.cssText = `
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
            background: ${isPrimary ? '#0066cc' : '#444'};
            color: #fff;
        `;
        btn.onmouseover = () => btn.style.background = isPrimary ? '#0052a3' : '#555';
        btn.onmouseout = () => btn.style.background = isPrimary ? '#0066cc' : '#444';
        btn.onclick = onClick;
        return btn;
    }

    // 取消按钮
    const cancelBtn = createButton("取消", false, () => {
        document.body.removeChild(overlay);
        resolve(null);
    });

    // 确定按钮
    const confirmBtn = createButton(isEdit ? "保存" : "添加", true, () => {
        const selectedGroup = groupSelect.value;
        const name = nameInput.value.trim();
        const content = contentInput.value.trim();
        if (!selectedGroup) {
            alert("请选择分组！");
            return;
        }
        if (!name) {
            alert("预设名称不能为空！");
            return;
        }
        document.body.removeChild(overlay);
        resolve({
            group_name: selectedGroup,
            preset_name: name,
            content: content
        });
    });

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);

    // 聚焦
    nameInput.focus();
    nameInput.select();
}

// 创建分组管理对话框
function createGroupManagementDialog(dialog, groups, resolve, overlay) {
    // 现有分组列表
    const listLabel = document.createElement("label");
    listLabel.textContent = "现有分组:";
    listLabel.style.cssText = `color: #ccc; display: block; margin-bottom: 5px;`;
    dialog.appendChild(listLabel);

    const groupList = document.createElement("div");
    groupList.style.cssText = `
        max-height: 150px;
        overflow-y: auto;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        margin-bottom: 15px;
        padding: 5px;
    `;

    function refreshGroupList() {
        groupList.innerHTML = "";
        groups.forEach(group => {
            const item = document.createElement("div");
            item.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 5px 8px;
                border-bottom: 1px solid #333;
            `;

            // 分组名称（可点击编辑）
            const nameContainer = document.createElement("div");
            nameContainer.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 1;
            `;

            const nameSpan = document.createElement("span");
            nameSpan.textContent = group;
            nameSpan.style.cssText = "color: #fff; cursor: pointer; padding: 2px 4px; border-radius: 3px; transition: background 0.2s;";
            nameSpan.onmouseover = () => nameSpan.style.background = "#444";
            nameSpan.onmouseout = () => nameSpan.style.background = "transparent";
            nameSpan.onclick = () => {
                // 切换到编辑模式
                const input = document.createElement("input");
                input.type = "text";
                input.value = group;
                input.style.cssText = `
                    flex: 1;
                    padding: 4px 8px;
                    background: #2a2a2a;
                    border: 1px solid #007bff;
                    border-radius: 3px;
                    color: #fff;
                    font-size: 14px;
                `;

                const saveBtn = document.createElement("button");
                saveBtn.textContent = "✓";
                saveBtn.style.cssText = `
                    padding: 4px 8px;
                    background: #28a745;
                    border: none;
                    border-radius: 3px;
                    color: #fff;
                    cursor: pointer;
                    font-size: 12px;
                `;

                const cancelBtn = document.createElement("button");
                cancelBtn.textContent = "✕";
                cancelBtn.style.cssText = `
                    padding: 4px 8px;
                    background: #6c757d;
                    border: none;
                    border-radius: 3px;
                    color: #fff;
                    cursor: pointer;
                    font-size: 12px;
                `;

                nameContainer.innerHTML = "";
                nameContainer.appendChild(input);
                nameContainer.appendChild(saveBtn);
                nameContainer.appendChild(cancelBtn);
                input.focus();
                input.select();

                const saveRename = async () => {
                    const newName = input.value.trim();
                    if (!newName) {
                        alert("分组名称不能为空！");
                        return;
                    }
                    if (newName === group) {
                        refreshGroupList();
                        return;
                    }
                    if (groups.includes(newName)) {
                        alert("分组名称已存在！");
                        return;
                    }
                    try {
                        const response = await fetch(`${API_BASE}/groups/rename`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ old_name: group, new_name: newName })
                        });
                        const data = await response.json();
                        if (data.success) {
                            const index = groups.indexOf(group);
                            if (index > -1) groups[index] = newName;
                            refreshGroupList();
                            // 刷新所有WP_PromptPreset节点的选项
                            refreshAllNodes();
                        } else {
                            alert("重命名失败: " + (data.error || "未知错误"));
                        }
                    } catch (error) {
                        console.error("[WP提示词预设] 重命名分组失败:", error);
                        alert("重命名失败，请查看控制台日志");
                    }
                };

                saveBtn.onclick = saveRename;
                cancelBtn.onclick = () => refreshGroupList();
                input.onkeydown = (e) => {
                    if (e.key === "Enter") saveRename();
                    if (e.key === "Escape") refreshGroupList();
                };
            };
            nameContainer.appendChild(nameSpan);
            item.appendChild(nameContainer);

            // 操作按钮容器
            const btnContainer = document.createElement("div");
            btnContainer.style.cssText = `
                display: flex;
                gap: 5px;
            `;

            // 编辑按钮
            const editBtn = document.createElement("button");
            editBtn.textContent = "✏️";
            editBtn.title = "重命名";
            editBtn.style.cssText = `
                background: transparent;
                border: none;
                color: #007bff;
                cursor: pointer;
                font-size: 12px;
            `;
            editBtn.onclick = () => nameSpan.click();
            btnContainer.appendChild(editBtn);

            // 删除按钮（最后一个分组不能删除）
            if (groups.length > 1) {
                const deleteBtn = document.createElement("button");
                deleteBtn.textContent = "🗑️";
                deleteBtn.title = "删除";
                deleteBtn.style.cssText = `
                    background: transparent;
                    border: none;
                    color: #dc3545;
                    cursor: pointer;
                    font-size: 12px;
                `;
                deleteBtn.onclick = async () => {
                    if (!confirm(`确定要删除分组 "${group}" 吗？\n该分组下的所有预设也会被删除！`)) {
                        return;
                    }
                    try {
                        const response = await fetch(`${API_BASE}/groups/delete`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ group_name: group })
                        });
                        const data = await response.json();
                        if (data.success) {
                            const index = groups.indexOf(group);
                            if (index > -1) groups.splice(index, 1);
                            refreshGroupList();
                        } else {
                            alert("删除失败: " + (data.error || "未知错误"));
                        }
                    } catch (error) {
                        console.error("[WP提示词预设] 删除分组失败:", error);
                    }
                };
                btnContainer.appendChild(deleteBtn);
            }

            item.appendChild(btnContainer);
            groupList.appendChild(item);
        });
    }

    refreshGroupList();
    dialog.appendChild(groupList);

    // 添加新分组
    const newGroupLabel = document.createElement("label");
    newGroupLabel.textContent = "添加新分组:";
    newGroupLabel.style.cssText = `color: #ccc; display: block; margin-bottom: 5px;`;
    dialog.appendChild(newGroupLabel);

    const newGroupContainer = document.createElement("div");
    newGroupContainer.style.cssText = `
        display: flex;
        gap: 5px;
        margin-bottom: 15px;
    `;

    const newGroupInput = document.createElement("input");
    newGroupInput.type = "text";
    newGroupInput.placeholder = "输入新分组名称";
    newGroupInput.style.cssText = `
        flex: 1;
        padding: 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        box-sizing: border-box;
    `;
    newGroupContainer.appendChild(newGroupInput);

    const addGroupBtn = document.createElement("button");
    addGroupBtn.textContent = "➕ 添加";
    addGroupBtn.style.cssText = `
        padding: 8px 16px;
        background: #28a745;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
        font-size: 14px;
    `;
    addGroupBtn.onclick = async () => {
        const groupName = newGroupInput.value.trim();
        if (!groupName) {
            alert("分组名称不能为空！");
            return;
        }
        if (groups.includes(groupName)) {
            alert("分组已存在！");
            return;
        }
        try {
            const response = await fetch(`${API_BASE}/groups/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ group_name: groupName })
            });
            const data = await response.json();
            if (data.success) {
                groups.push(groupName);
                newGroupInput.value = "";
                refreshGroupList();
                // 刷新所有节点的分组列表
                await refreshAllNodes();
            } else {
                alert("添加失败: " + (data.error || "未知错误"));
            }
        } catch (error) {
            console.error("[WP提示词预设] 添加分组失败:", error);
        }
    };
    newGroupContainer.appendChild(addGroupBtn);

    dialog.appendChild(newGroupContainer);

    // 关闭按钮
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText = `
        padding: 8px 16px;
        background: #444;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
        font-size: 14px;
        width: 100%;
    `;
    closeBtn.onclick = () => {
        document.body.removeChild(overlay);
        resolve({ action: "refresh" });
    };
    dialog.appendChild(closeBtn);
}

// 刷新节点选项
async function refreshNodeOptions(node) {
    try {
        // 获取所有分组
        const groupsResponse = await fetch(`${API_BASE}/groups`);
        const groups = await groupsResponse.json();

        // 获取当前选中的分组
        const groupWidget = node.widgets.find(w => w.name === "分组");
        const presetWidget = node.widgets.find(w => w.name === "预设");

        if (groupWidget) {
            groupWidget.options.values = groups;
            if (!groups.includes(groupWidget.value)) {
                groupWidget.value = groups[0] || "默认分组";
            }
        }

        // 刷新预设列表
        if (presetWidget && groupWidget) {
            const presetsResponse = await fetch(`${API_BASE}/names?group=${encodeURIComponent(groupWidget.value)}`);
            const presets = await presetsResponse.json();
            presetWidget.options.values = presets;
            if (!presets.includes(presetWidget.value)) {
                presetWidget.value = presets[0] || "默认预设";
            }
        }

        node.setDirtyCanvas(true, true);
    } catch (error) {
        console.error("[WP提示词预设] 刷新选项失败:", error);
    }
}

// 刷新所有WP_PromptPreset节点
async function refreshAllNodes() {
    try {
        // 获取最新分组列表
        const groupsResponse = await fetch(`${API_BASE}/groups`);
        const groups = await groupsResponse.json();

        // 遍历所有节点
        app.graph._nodes.forEach(node => {
            if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
                const groupWidget = node.widgets.find(w => w.name === "分组");
                const presetWidget = node.widgets.find(w => w.name === "预设");

                if (groupWidget) {
                    const oldValue = groupWidget.value;
                    groupWidget.options.values = groups;
                    // 如果当前选中的分组不存在了，切换到第一个
                    if (!groups.includes(oldValue)) {
                        groupWidget.value = groups[0] || "默认分组";
                    }
                }

                // 刷新预设列表
                if (presetWidget && groupWidget) {
                    fetch(`${API_BASE}/names?group=${encodeURIComponent(groupWidget.value)}`)
                        .then(res => res.json())
                        .then(presets => {
                            presetWidget.options.values = presets;
                            if (!presets.includes(presetWidget.value)) {
                                presetWidget.value = presets[0] || "默认预设";
                            }
                            node.setDirtyCanvas(true, true);
                        })
                        .catch(err => console.error("[WP提示词预设] 刷新预设列表失败:", err));
                }

                node.setDirtyCanvas(true, true);
            }
        });
    } catch (error) {
        console.error("[WP提示词预设] 刷新所有节点失败:", error);
    }
}

// 注册节点扩展
app.registerExtension({
    name: "WP_Node.PromptPreset",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== NODE_TYPE) return;

        // 保存原始的onNodeCreated
        const onNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function() {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            const node = this;

            // 添加分组联动功能
            addGroupLinkage(node);

            // 添加按钮
            addButtonWidgets(node);

            return result;
        };
    }
});

// 添加分组联动功能
function addGroupLinkage(node) {
    const groupWidget = node.widgets.find(w => w.name === "分组");
    const presetWidget = node.widgets.find(w => w.name === "预设");

    if (!groupWidget || !presetWidget) return;

    // 保存所有预设的完整列表（用于过滤）
    const allPresets = [...presetWidget.options.values];

    // 过滤预设列表的函数
    const filterPresetsByGroup = async (groupName) => {
        try {
            const response = await fetch(`${API_BASE}/names?group=${encodeURIComponent(groupName)}`);
            const groupPresets = await response.json();
            // 只显示当前分组的预设
            presetWidget.options.values = groupPresets;
            // 如果当前选中的预设不在该分组中，切换到第一个
            if (!groupPresets.includes(presetWidget.value)) {
                presetWidget.value = groupPresets[0] || "默认预设";
            }
            node.setDirtyCanvas(true, true);
        } catch (error) {
            console.error("[WP提示词预设] 过滤预设列表失败:", error);
        }
    };

    // 节点创建时立即过滤
    setTimeout(() => {
        filterPresetsByGroup(groupWidget.value);
    }, 100);

    // 保存原始的callback
    const originalCallback = groupWidget.callback;

    groupWidget.callback = async function(value) {
        // 调用原始callback
        if (originalCallback) originalCallback.call(this, value);

        // 过滤预设列表
        await filterPresetsByGroup(value);
    };
}

// 添加按钮widgets
function addButtonWidgets(node) {
    if (node._wpButtonsAdded) return;
    node._wpButtonsAdded = true;

    // 新增按钮
    node.addWidget("button", "➕ 新增", null, async () => {
        // 先获取分组列表
        try {
            const groupsResponse = await fetch(`${API_BASE}/groups`);
            const groups = await groupsResponse.json();

            const groupWidget = node.widgets.find(w => w.name === "分组");
            const currentGroup = groupWidget ? groupWidget.value : groups[0];

            const result = await createPresetDialog("新增提示词预设", {
                groupName: currentGroup,
                groups: groups
            });

            if (result) {
                if (result.action === "manage_groups") {
                    // 打开分组管理
                    await manageGroups(node);
                    return;
                }

                console.log("[WP提示词预设] 发送数据:", result);
                const response = await fetch(`${API_BASE}/add`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(result)
                });
                const data = await response.json();
                console.log("[WP提示词预设] 响应数据:", data);
                if (data.success) {
                    await refreshNodeOptions(node);
                    alert("添加成功！");
                } else {
                    alert("添加失败: " + (data.error || "未知错误"));
                }
            }
        } catch (error) {
            console.error("[WP提示词预设] 添加失败:", error);
            alert("添加失败，请查看控制台日志");
        }
    }, { serialize: false });

    // 编辑按钮
    node.addWidget("button", "✏️ 编辑", null, async () => {
        const groupWidget = node.widgets.find(w => w.name === "分组");
        const presetWidget = node.widgets.find(w => w.name === "预设");
        const currentGroup = groupWidget ? groupWidget.value : "";
        const currentPreset = presetWidget ? presetWidget.value : "";

        if (!currentPreset || currentPreset === "默认预设") {
            alert("请先选择一个有效的预设！");
            return;
        }

        try {
            // 获取所有数据
            const [groupsResponse, presetsResponse] = await Promise.all([
                fetch(`${API_BASE}/groups`),
                fetch(`${API_BASE}`)
            ]);
            const groups = await groupsResponse.json();
            const allData = await presetsResponse.json();
            const currentContent = allData.groups?.[currentGroup]?.[currentPreset] || "";

            const result = await createPresetDialog("编辑提示词预设", {
                groupName: currentGroup,
                presetName: currentPreset,
                presetContent: currentContent,
                groups: groups,
                isEdit: true
            });

            if (result) {
                if (result.action === "manage_groups") {
                    await manageGroups(node);
                    return;
                }

                const updateResponse = await fetch(`${API_BASE}/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        old_group: currentGroup,
                        new_group: result.group_name,
                        old_name: currentPreset,
                        new_name: result.preset_name,
                        content: result.content
                    })
                });
                const data = await updateResponse.json();
                if (data.success) {
                    await refreshNodeOptions(node);
                    alert("更新成功！");
                } else {
                    alert("更新失败: " + (data.error || "未知错误"));
                }
            }
        } catch (error) {
            console.error("[WP提示词预设] 编辑失败:", error);
            alert("编辑失败，请查看控制台日志");
        }
    }, { serialize: false });

    // 删除按钮
    node.addWidget("button", "🗑️ 删除", null, async () => {
        const groupWidget = node.widgets.find(w => w.name === "分组");
        const presetWidget = node.widgets.find(w => w.name === "预设");
        const currentGroup = groupWidget ? groupWidget.value : "";
        const currentPreset = presetWidget ? presetWidget.value : "";

        if (!currentPreset || currentPreset === "默认预设") {
            alert("默认预设不能删除！");
            return;
        }

        if (!confirm(`确定要删除预设 "${currentPreset}" 吗？`)) {
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/delete`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    group_name: currentGroup,
                    preset_name: currentPreset
                })
            });
            const data = await response.json();
            if (data.success) {
                await refreshNodeOptions(node);
                alert("删除成功！");
            } else {
                alert("删除失败: " + (data.error || "未知错误"));
            }
        } catch (error) {
            console.error("[WP提示词预设] 删除失败:", error);
            alert("删除失败，请查看控制台日志");
        }
    }, { serialize: false });
}

// 管理分组
async function manageGroups(node) {
    try {
        const groupsResponse = await fetch(`${API_BASE}/groups`);
        const groups = await groupsResponse.json();

        const result = await createPresetDialog("管理分组", {
            groups: groups,
            isGroupEdit: true
        });

        if (result && result.action === "refresh") {
            await refreshNodeOptions(node);
        }
    } catch (error) {
        console.error("[WP提示词预设] 管理分组失败:", error);
    }
}

console.log("[WP提示词预设] 前端扩展已加载");
