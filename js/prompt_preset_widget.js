/**
 * 🐳 WP 提示词预设节点 - 前端扩展
 * 提供分组管理和增删改提示词预设的UI功能，支持预设关联图片
 */
import { app } from "../../scripts/app.js";

// 节点类型名称
const NODE_TYPE = "WP_PromptPreset";

// API基础路径
const API_BASE = "/wp_node/prompt_presets";

// ========== 图片压缩工具 ==========

function compressImage(file, maxSize = 512) {
    return new Promise((resolve, reject) => {
        if (!file) {
            resolve(null);
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const longest = Math.max(width, height);
                if (longest > maxSize) {
                    const ratio = maxSize / longest;
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
            };
            img.onerror = () => reject(new Error("图片加载失败"));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsDataURL(file);
    });
}

// ========== 对话框 ==========

function createPresetDialog(title, options = {}) {
    const {
        groupName = "",
        presetName = "",
        presetContent = "",
        presetImage = null,
        groups = [],
        isEdit = false,
        isGroupEdit = false
    } = options;

    return new Promise((resolve) => {
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

        const dialog = document.createElement("div");
        dialog.style.cssText = `
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 8px;
            padding: 20px;
            width: 520px;
            max-width: 90%;
            max-height: 90%;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;

        const titleEl = document.createElement("h3");
        titleEl.textContent = title;
        titleEl.style.cssText = `
            margin: 0 0 15px 0;
            color: #fff;
            font-size: 16px;
        `;
        dialog.appendChild(titleEl);

        if (isGroupEdit) {
            createGroupManagementDialog(dialog, groups, resolve, overlay);
        } else {
            createPresetEditDialog(dialog, {
                groupName, presetName, presetContent, presetImage, groups, isEdit
            }, resolve, overlay);
        }

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// 创建预设编辑对话框内容
function createPresetEditDialog(dialog, options, resolve, overlay) {
    const { groupName, presetName, presetContent, presetImage, groups, isEdit } = options;
    let currentImage = presetImage || null;

    // 分组选择
    const groupLabel = document.createElement("label");
    groupLabel.textContent = "所属分组:";
    groupLabel.style.cssText = `color: #ccc; display: block; margin-bottom: 5px;`;
    dialog.appendChild(groupLabel);

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

    groups.forEach(group => {
        const option = document.createElement("option");
        option.value = group;
        option.textContent = group;
        if (group === groupName) option.selected = true;
        groupSelect.appendChild(option);
    });

    groupContainer.appendChild(groupSelect);

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

    // ===== 图片上传区域 =====
    const imageSection = document.createElement("div");
    imageSection.style.cssText = `
        margin-bottom: 15px;
    `;

    // 图片容器（虚线框 / 图片预览 + 删除按钮）
    const imageBox = document.createElement("div");
    imageBox.style.cssText = `
        position: relative;
        width: 100%;
        min-height: 80px;
        border: 2px dashed ${currentImage ? "transparent" : "#555"};
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: visible;
        transition: border-color 0.2s;
    `;

    // 隐藏的文件输入
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
            const compressed = await compressImage(file);
            currentImage = compressed;
            previewImg.src = compressed;
            previewImg.style.display = "block";
            placeholderText.style.display = "none";
            deleteBtn.style.display = "flex";
            imageBox.style.border = "2px dashed transparent";
        } catch (err) {
            console.error("[WP提示词预设] 图片压缩失败:", err);
            alert("图片处理失败，请重试");
        }
    };

    // 占位提示文字（无图片时显示）
    const placeholderText = document.createElement("div");
    placeholderText.style.cssText = `
        color: #666;
        font-size: 13px;
        user-select: none;
        display: ${currentImage ? "none" : "block"};
        padding: 20px;
    `;
    placeholderText.textContent = "📷 点击添加图片";

    // 预览图
    const previewImg = document.createElement("img");
    previewImg.style.cssText = `
        max-width: 100%;
        max-height: 200px;
        border-radius: 4px;
        object-fit: contain;
        display: ${currentImage ? "block" : "none"};
    `;
    if (currentImage) {
        previewImg.src = currentImage;
    }

    // 删除按钮（图片右上角 ❌）
    const deleteBtn = document.createElement("div");
    deleteBtn.textContent = "❌";
    deleteBtn.style.cssText = `
        position: absolute;
        top: -8px;
        right: -8px;
        width: 24px;
        height: 24px;
        display: ${currentImage ? "flex" : "none"};
        align-items: center;
        justify-content: center;
        background: #dc3545;
        border-radius: 50%;
        cursor: pointer;
        font-size: 12px;
        z-index: 1;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    `;
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        currentImage = null;
        previewImg.src = "";
        previewImg.style.display = "none";
        deleteBtn.style.display = "none";
        placeholderText.style.display = "block";
        imageBox.style.border = "2px dashed #555";
        fileInput.value = "";
    };

    // 点击整个区域触发文件选择
    imageBox.onclick = () => fileInput.click();
    imageBox.onmouseenter = () => {
        if (!currentImage) imageBox.style.borderColor = "#888";
    };
    imageBox.onmouseleave = () => {
        if (!currentImage) imageBox.style.borderColor = "#555";
    };

    imageBox.appendChild(placeholderText);
    imageBox.appendChild(previewImg);
    imageBox.appendChild(deleteBtn);
    imageBox.appendChild(fileInput);
    imageSection.appendChild(imageBox);

    dialog.appendChild(imageSection);

    // 按钮容器
    const btnContainer = document.createElement("div");
    btnContainer.style.cssText = `
        display: flex;
        justify-content: flex-end;
        gap: 10px;
    `;

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

    const cancelBtn = createButton("取消", false, () => {
        document.body.removeChild(overlay);
        resolve(null);
    });

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
        // 提交图片：URL=未修改传"keep"，base64=新上传传base64，null=已删除传null
        let submitImage;
        if (currentImage && currentImage.startsWith("data:image")) {
            submitImage = currentImage;
        } else if (currentImage && currentImage.startsWith("/")) {
            submitImage = "keep";
        } else {
            submitImage = null;
        }
        document.body.removeChild(overlay);
        resolve({
            group_name: selectedGroup,
            preset_name: name,
            content: content,
            image: submitImage
        });
    });

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);

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
                            await refreshAllNodes();
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

        const nodes = app.graph._nodes.filter(n =>
            n.comfyClass === NODE_TYPE || n.type === NODE_TYPE
        );

        for (const node of nodes) {
            const groupWidget = node.widgets.find(w => w.name === "分组");
            const presetWidget = node.widgets.find(w => w.name === "预设");

            if (groupWidget) {
                const oldValue = groupWidget.value;
                groupWidget.options.values = groups;
                if (!groups.includes(oldValue)) {
                    groupWidget.value = groups[0] || "默认分组";
                }
            }

            // 刷新预设列表
            if (presetWidget && groupWidget) {
                try {
                    const res = await fetch(`${API_BASE}/names?group=${encodeURIComponent(groupWidget.value)}`);
                    const presets = await res.json();
                    presetWidget.options.values = presets;
                    if (!presets.includes(presetWidget.value)) {
                        presetWidget.value = presets[0] || "默认预设";
                    }
                } catch (err) {
                    console.error("[WP提示词预设] 刷新预设列表失败:", err);
                }
            }

            node.setDirtyCanvas(true, true);
        }
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

    // 过滤预设列表的函数
    const filterPresetsByGroup = async (groupName) => {
        try {
            const response = await fetch(`${API_BASE}/names?group=${encodeURIComponent(groupName)}`);
            const groupPresets = await response.json();
            presetWidget.options.values = groupPresets;
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

    // 保存原始callback
    const originalCallback = groupWidget.callback;

    groupWidget.callback = async function(value) {
        // 验证分组是否合法
        if (!groupWidget.options.values.includes(value)) {
            // 不合法的分组名，恢复为第一个有效分组
            const validGroup = groupWidget.options.values[0] || "默认分组";
            groupWidget.value = validGroup;
            filterPresetsByGroup(validGroup);
            return;
        }

        if (originalCallback) originalCallback.call(this, value);

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
                    if (window._wpClearHoverCache) window._wpClearHoverCache(result.group_name, result.preset_name);
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
            const [groupsResponse, presetResponse] = await Promise.all([
                fetch(`${API_BASE}/groups`),
                fetch(`${API_BASE}/get?group=${encodeURIComponent(currentGroup)}&preset=${encodeURIComponent(currentPreset)}`)
            ]);
            const groups = await groupsResponse.json();
            const presetData = await presetResponse.json();

            let currentContent = "";
            let currentImage = null;
            if (presetData.success && presetData.data) {
                currentContent = presetData.data.content || "";
                currentImage = presetData.data.image_url || null;
            }

            const result = await createPresetDialog("编辑提示词预设", {
                groupName: currentGroup,
                presetName: currentPreset,
                presetContent: currentContent,
                presetImage: currentImage,
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
                        content: result.content,
                        image: result.image
                    })
                });
                const data = await updateResponse.json();
                if (data.success) {
                    await refreshNodeOptions(node);
                    if (window._wpClearAllHoverCache) window._wpClearAllHoverCache();
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
                if (window._wpClearHoverCache) window._wpClearHoverCache(currentGroup, currentPreset);
                alert("删除成功！");
            } else {
                alert("删除失败: " + (data.error || "未知错误"));
            }
        } catch (error) {
            console.error("[WP提示词预设] 删除失败:", error);
            alert("删除失败，请查看控制台日志");
        }
    }, { serialize: false });

    // ===== 鼠标悬停缩略图预览 =====
    addHoverPreview(node);
}

// 鼠标悬停缩略图预览（监听下拉列表DOM）
function addHoverPreview(node) {
    // 全局只设置一次
    if (window._wpHoverPreviewSetup) return;
    window._wpHoverPreviewSetup = true;

    // 预览浮层
    const previewEl = document.createElement("div");
    previewEl.style.cssText = `
        position: fixed;
        z-index: 10001;
        pointer-events: none;
        display: none;
        background: #1a1a1a;
        border: 1px solid #555;
        border-radius: 6px;
        padding: 4px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
    `;
    const previewImg = document.createElement("img");
    previewImg.style.cssText = `
        max-width: 256px;
        max-height: 256px;
        border-radius: 4px;
        display: block;
        object-fit: contain;
    `;
    previewEl.appendChild(previewImg);
    document.body.appendChild(previewEl);

    // 全局缓存：{ "分组/预设": imageData | null }
    const imageCache = {};
    let currentKey = "";
    let isShowing = false;
    let fetching = false;

    const hide = () => {
        previewEl.style.display = "none";
        isShowing = false;
    };

    const show = (clientX, clientY, imgData) => {
        previewImg.src = imgData;
        previewEl.style.display = "block";
        previewEl.style.left = (clientX + 16) + "px";
        previewEl.style.top = (clientY - 16) + "px";
        isShowing = true;
    };

    const updatePos = (clientX, clientY) => {
        previewEl.style.left = (clientX + 16) + "px";
        previewEl.style.top = (clientY - 16) + "px";
    };

    const fetchImage = async (group, preset) => {
        const key = `${group}/${preset}`;
        if (imageCache[key] !== undefined) return imageCache[key];
        try {
            const res = await fetch(`${API_BASE}/get?group=${encodeURIComponent(group)}&preset=${encodeURIComponent(preset)}`);
            const data = await res.json();
            const img = (data.success && data.data && data.data.image_url) ? data.data.image_url : null;
            imageCache[key] = img;
            return img;
        } catch {
            imageCache[key] = null;
            return null;
        }
    };

    // 暴露清除缓存的方法，供编辑/删除后调用
    window._wpClearHoverCache = (group, preset) => {
        const key = `${group}/${preset}`;
        delete imageCache[key];
    };
    window._wpClearAllHoverCache = () => {
        Object.keys(imageCache).forEach(k => delete imageCache[k]);
    };

    // 用事件委托监听 mousemove：检测鼠标是否悬停在下拉列表选项上
    document.addEventListener("mousemove", (e) => {
        const entry = e.target.closest && e.target.closest(".litemenu-entry");
        if (!entry) {
            if (isShowing) hide();
            return;
        }

        // 确认在 litecontextmenu 内
        const menu = entry.closest(".litecontextmenu");
        if (!menu) {
            if (isShowing) hide();
            return;
        }

        // 找到当前选中的 WP_PromptPreset 节点
        const currentNode = app.canvas && (app.canvas.current_node || app.canvas.selected_node);
        if (!currentNode || (currentNode.type !== NODE_TYPE && currentNode.comfyClass !== NODE_TYPE)) {
            if (isShowing) hide();
            return;
        }

        const groupWidget = currentNode.widgets.find(w => w.name === "分组");
        if (!groupWidget) {
            if (isShowing) hide();
            return;
        }

        const group = groupWidget.value;
        const preset = entry.dataset.value || entry.textContent.trim();

        if (!preset || preset === "默认预设") {
            if (isShowing) hide();
            return;
        }

        const key = `${group}/${preset}`;

        // 同一个预设：只更新位置
        if (key === currentKey && isShowing) {
            updatePos(e.clientX, e.clientY);
            return;
        }

        currentKey = key;

        // 有缓存：直接显示
        if (imageCache[key] !== undefined) {
            const img = imageCache[key];
            if (img) show(e.clientX, e.clientY, img);
            else hide();
            return;
        }

        // 无缓存：异步请求
        if (!fetching) {
            fetching = true;
            fetchImage(group, preset).then(img => {
                fetching = false;
                if (currentKey === `${group}/${preset}` && img) {
                    show(e.clientX, e.clientY, img);
                }
            });
        }
    });

    // 鼠标离开下拉列表时隐藏
    document.addEventListener("mouseleave", () => {
        if (isShowing) hide();
    });
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
            // 刷新所有WP_PromptPreset节点的选项
            await refreshAllNodes();
        }
    } catch (error) {
        console.error("[WP提示词预设] 管理分组失败:", error);
    }
}

console.log("[WP提示词预设] 前端扩展已加载");
