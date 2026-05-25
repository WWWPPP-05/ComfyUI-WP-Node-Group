/**
 *  WP 资产库前端扩展
 * 功能：创建悬浮按钮和资产库面板UI
 * 数据结构：项目 -> 分类 -> 资产
 */

// 延迟获取 app，确保 comfyAPI 已初始化
let app;
function getApp() {
    if (!app && window.comfyAPI?.app) {
        ({ app } = window.comfyAPI.app);
    }
    return app;
}

// 初始化时尝试获取 app
try {
    ({ app } = window.comfyAPI.app);
} catch(e) {
    // comfyAPI 可能还未初始化，等待 init 函数重试
}

// 资产库API基础路径
const ASSET_API_BASE = "/wp_node/asset_library";

// 资产库面板状态
let assetPanelVisible = false;
let assetPanelElement = null;

// 当前选中的项目和分类
let currentProjectId = null;
let currentCategoryId = null;

// 项目列表（缓存）
let projectsCache = [];

// 排序状态：null=不排序, 'asc'=升序, 'desc'=降序
let assetSortMode = null;

// 创建资产库面板
function createAssetPanel() {
    // 如果面板已存在，直接返回
    if (assetPanelElement) {
        return assetPanelElement;
    }

    // 创建面板容器
    const panel = document.createElement("div");
    panel.id = "wp-asset-library-panel";
    panel.className = "wp-asset-panel";
    panel.style.cssText = `
        position: fixed;
        top: 50%;
        right: 20px;
        transform: translateY(-50%);
        width: 650px;
        max-width: 90vw;
        height: 70vh;
        max-height: 90vh;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid #444;
        border-radius: 12px;
        z-index: 10000;
        display: none;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(10px);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    // 创建面板头部
    const header = document.createElement("div");
    header.className = "wp-asset-header";
    header.style.cssText = `
        padding: 15px 20px;
        background: #662ad5;
        border-bottom: 1px solid #444;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top-left-radius: 12px;
        border-top-right-radius: 12px;
    `;

    // 标题
    const title = document.createElement("h3");
    title.textContent = "🐳 资产库";
    title.style.cssText = `
        margin: 0;
        color: #fff;
        font-size: 16px;
        font-weight: 600;
    `;

    // 关闭按钮
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "✕";
    closeBtn.title = "关闭资产库";
    closeBtn.style.cssText = `
        background: #555;
        border: none;
        color: #fff;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    closeBtn.onclick = () => toggleAssetPanel(false);

    header.appendChild(title);
    header.appendChild(closeBtn);

    // 创建面板内容区域
    const content = document.createElement("div");
    content.className = "wp-asset-content";
    content.style.cssText = `
        flex: 1;
        display: flex;
        overflow: hidden;
    `;

    // 左侧边栏（项目+分类）
    const sidebar = document.createElement("div");
    sidebar.className = "wp-asset-sidebar";
    sidebar.style.cssText = `
        width: 220px;
        background: rgba(40, 40, 40, 0.8);
        border-right: 1px solid #444;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    `;

    // 项目区域 - 改为下拉框+按钮
    const projectSection = document.createElement("div");
    projectSection.style.cssText = `
        padding: 10px 10px 5px 10px;
        border-bottom: 1px solid #333;
    `;

    // 项目选择行
    const projectRow = document.createElement("div");
    projectRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    // 项目下拉框
    const projectSelect = document.createElement("select");
    projectSelect.id = "wp-asset-project-select";
    projectSelect.style.cssText = `
        width: 166px;
        padding: 2px 8px;
        height: 24px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 6px;
        color: #fff;
        font-size: 13px;
        outline: none;
        cursor: pointer;
        box-sizing: border-box;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    `;
    projectSelect.onchange = () => {
        const selectedId = projectSelect.value;
        if (selectedId) {
            selectProject(selectedId);
        }
    };

    // 新建项目按钮 - 半透明灰色圆形，中间是'+'
    const newProjBtn = document.createElement("button");
    newProjBtn.innerHTML = "+";
    newProjBtn.title = "新建项目";
    newProjBtn.style.cssText = `
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: none;
        background: rgba(128, 128, 128, 0.3);
        color: rgba(255, 255, 255, 0.7);
        font-size: 18px;
        font-weight: 300;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        line-height: 1;
        flex-shrink: 0;
    `;
    newProjBtn.onmouseover = () => {
        newProjBtn.style.background = "rgba(128, 128, 128, 0.5)";
        newProjBtn.style.color = "#fff";
    };
    newProjBtn.onmouseout = () => {
        newProjBtn.style.background = "rgba(128, 128, 128, 0.3)";
        newProjBtn.style.color = "rgba(255, 255, 255, 0.7)";
    };
    newProjBtn.onclick = createNewProject;

    projectRow.appendChild(projectSelect);
    projectRow.appendChild(newProjBtn);
    projectSection.appendChild(projectRow);

    // 分类区域
    const categorySection = document.createElement("div");
    categorySection.style.cssText = `
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 0;
    `;

    // 分类标题
    const catTitle = document.createElement("div");
    catTitle.textContent = "分类";
    catTitle.style.cssText = `
        padding: 10px 10px;
        color: #aaa;
        font-size: 12px;
        font-weight: 600;
        border-bottom: 1px solid #333;
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;

    // 新建分类按钮 - 与项目"+"按钮样式一致
    const newCatBtn = document.createElement("button");
    newCatBtn.innerHTML = "+";
    newCatBtn.title = "新建分类";
    newCatBtn.style.cssText = `
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: none;
        background: rgba(128, 128, 128, 0.3);
        color: rgba(255, 255, 255, 0.7);
        font-size: 14px;
        font-weight: 300;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        line-height: 1;
        flex-shrink: 0;
    `;
    newCatBtn.onmouseover = () => {
        newCatBtn.style.background = "rgba(128, 128, 128, 0.5)";
        newCatBtn.style.color = "#fff";
    };
    newCatBtn.onmouseout = () => {
        newCatBtn.style.background = "rgba(128, 128, 128, 0.3)";
        newCatBtn.style.color = "rgba(255, 255, 255, 0.7)";
    };
    newCatBtn.onclick = createNewCategory;

    catTitle.appendChild(newCatBtn);

    // 分类列表容器
    const catList = document.createElement("div");
    catList.id = "wp-asset-categories";
    catList.style.cssText = `
        padding: 5px 0;
        flex: 1;
        overflow-y: auto;
    `;

    categorySection.appendChild(catTitle);
    categorySection.appendChild(catList);

    sidebar.appendChild(projectSection);
    sidebar.appendChild(categorySection);

    // 删除当前项目按钮（放在左侧面板最下方）
    const deleteProjBtn = document.createElement("button");
    deleteProjBtn.id = "wp-asset-delete-project-btn";
    deleteProjBtn.textContent = "🗑️ 删除当前项目";
    deleteProjBtn.title = "删除当前选中的项目及其所有内容";
    deleteProjBtn.style.cssText = `
        width: calc(100% - 20px);
        margin: 10px auto;
        padding: 6px 10px;
        background: rgba(128, 128, 128, 0.3);
        border: none;
        border-radius: 16px;
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
    `;
    deleteProjBtn.onmouseover = () => deleteProjBtn.style.background = "rgba(220, 53, 69, 0.6)";
    deleteProjBtn.onmouseout = () => deleteProjBtn.style.background = "rgba(128, 128, 128, 0.3)";
    deleteProjBtn.onclick = deleteCurrentProject;
    sidebar.appendChild(deleteProjBtn);

    // 右侧主内容区域
    const mainContent = document.createElement("div");
    mainContent.className = "wp-asset-main";
    mainContent.style.cssText = `
        flex: 1;
        display: flex;
        flex-direction: column;
        padding: 15px;
        overflow: hidden;
    `;

    // 搜索和操作栏
    const toolbar = document.createElement("div");
    toolbar.className = "wp-asset-toolbar";
    toolbar.style.cssText = `
        display: flex;
        justify-content: space-between;
        margin-bottom: 15px;
        gap: 10px;
    `;

    // 左侧：搜索框
    const leftGroup = document.createElement("div");
    leftGroup.style.cssText = `
        flex: 1;
        display: flex;
    `;
    
    const searchInput = document.createElement("input");
    searchInput.id = "wp-asset-search-input";
    searchInput.type = "text";
    searchInput.placeholder = "搜索资产...";
    searchInput.style.cssText = `
        flex: 1;
        max-width: 180px;
        padding: 2px 10px;
        height: 24px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 6px;
        color: #fff;
        font-size: 12px;
        outline: none;
        box-sizing: border-box;
    `;
    searchInput.oninput = (e) => searchAssets(e.target.value);
    leftGroup.appendChild(searchInput);

    // 排序按钮
    const sortBtn = document.createElement("button");
    sortBtn.id = "wp-asset-sort-btn";
    sortBtn.title = "按名称排序";
    sortBtn.style.cssText = `
        width: 24px;
        height: 24px;
        min-width: 24px;
        background: rgba(128, 128, 128, 0.3);
        border: 1px solid rgba(128, 128, 128, 0.2);
        border-radius: 50%;
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        margin-left: 8px;
    `;
    sortBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor"><path d="M7 1L11 5H3L7 1Z"/><path d="M7 13L3 9H11L7 13Z"/></svg>`;
    sortBtn.onmouseover = () => {
        sortBtn.style.background = "rgba(128, 128, 128, 0.5)";
        sortBtn.querySelector('svg').style.color = "#fff";
    };
    sortBtn.onmouseout = () => {
        sortBtn.style.background = "rgba(128, 128, 128, 0.3)";
        sortBtn.querySelector('svg').style.color = "rgba(255, 255, 255, 0.6)";
    };
    sortBtn.onclick = () => {
        if (assetSortMode === null || assetSortMode === 'desc') {
            assetSortMode = 'asc';
            sortBtn.querySelector('svg').style.color = "#662ad5";
        } else {
            assetSortMode = 'desc';
            sortBtn.querySelector('svg').style.color = "#662ad5";
        }
        if (currentCategoryId) {
            loadAssetsByCategory(currentCategoryId, document.getElementById("wp-asset-search-input")?.value || "");
        }
    };
    leftGroup.appendChild(sortBtn);

    // 右侧：操作按钮组
    const rightGroup = document.createElement("div");
    rightGroup.style.cssText = `
        display: flex;
        gap: 8px;
    `;

    // 刷新按钮
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "wp-refresh-btn";
    refreshBtn.id = "wp-asset-refresh-btn";
    refreshBtn.innerHTML = "⟳ 刷新";
    refreshBtn.title = "扫描本地文件夹中的图片";
    refreshBtn.style.cssText = `
        padding: 2px 12px;
        height: 24px;
        background: rgba(128, 128, 128, 0.5);
        border: none;
        border-radius: 20px;
        color: #fff;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 4px;
        box-sizing: border-box;
    `;
    refreshBtn.onmouseover = () => refreshBtn.style.background = "rgba(128, 128, 128, 0.7)";
    refreshBtn.onmouseout = () => refreshBtn.style.background = "rgba(128, 128, 128, 0.5)";
    refreshBtn.onclick = () => scanLocalFiles();

    // 上传按钮
    const uploadBtn = document.createElement("button");
    uploadBtn.textContent = "上传图片";
    uploadBtn.style.cssText = `
        padding: 2px 12px;
        height: 24px;
        background: #662ad5;
        border: none;
        border-radius: 6px;
        color: white;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
        transition: background 0.2s;
        box-sizing: border-box;
    `;
    uploadBtn.onmouseover = () => uploadBtn.style.background = "#5a24bf";
    uploadBtn.onmouseout = () => uploadBtn.style.background = "#662ad5";
    uploadBtn.onclick = showUploadDialog;

    rightGroup.appendChild(refreshBtn);
    rightGroup.appendChild(uploadBtn);
    toolbar.appendChild(leftGroup);
    toolbar.appendChild(rightGroup);

    // 资产网格容器
    const assetGrid = document.createElement("div");
    assetGrid.id = "wp-asset-grid";
    assetGrid.className = "wp-asset-grid";
    assetGrid.style.cssText = `
        flex: 1;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 12px;
        overflow-y: auto;
        padding: 5px;
    `;

    mainContent.appendChild(toolbar);
    mainContent.appendChild(assetGrid);

    content.appendChild(sidebar);
    content.appendChild(mainContent);

    panel.appendChild(header);
    panel.appendChild(content);

    // 添加样式
    addAssetPanelStyles();

    // 添加到页面
    document.body.appendChild(panel);
    assetPanelElement = panel;

    // 加载项目列表
    loadProjects();

    return panel;
}

// 添加面板样式
function addAssetPanelStyles() {
    if (document.getElementById('wp-asset-styles')) {
        return;
    }

    const styles = document.createElement("style");
    styles.id = "wp-asset-styles";
    styles.textContent = `
        .wp-asset-category {
            padding: 8px 15px 8px 25px;
            color: #aaa;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-left: 3px solid transparent;
        }
        .wp-asset-category:hover {
            background: rgba(60, 60, 60, 0.8);
            color: #fff;
        }
        .wp-asset-category.active {
            background: rgba(102, 42, 213, 0.3);
            color: #fff;
            border-left-color: #662ad5;
        }
        .wp-asset-item {
            background: rgba(50, 50, 50, 0.8);
            border: 1px solid #444;
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            flex-direction: column;
            height: 140px;
        }
        .wp-asset-item:hover {
            transform: scale(1.03);
            border-color: #662ad5;
            box-shadow: 0 4px 12px rgba(102, 42, 213, 0.3);
        }
        .wp-asset-thumb {
            flex: 1;
            background-size: contain;
            background-position: center;
            background-repeat: no-repeat;
            background-color: rgba(30, 30, 30, 0.5);
        }
        .wp-asset-info {
            padding: 5px;
            background: rgba(40, 40, 40, 0.9);
            font-size: 11px;
            color: #aaa;
            text-align: center;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .wp-upload-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10001;
        }
        .wp-upload-dialog {
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 8px;
            padding: 20px;
            width: 500px;
            max-width: 90%;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        }
        .wp-drop-zone {
            border: 2px dashed #666;
            border-radius: 8px;
            padding: 40px 20px;
            text-align: center;
            color: #aaa;
            margin-bottom: 15px;
            transition: all 0.2s;
        }
        .wp-drop-zone.dragover {
            border-color: #007acc;
            background: rgba(0, 122, 204, 0.1);
            color: #007acc;
        }
        .wp-context-menu {
            position: fixed;
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 6px;
            padding: 5px 0;
            z-index: 10003;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            min-width: 120px;
        }
        .wp-context-menu-item {
            padding: 8px 15px;
            color: #fff;
            cursor: pointer;
            font-size: 14px;
        }
        .wp-context-menu-item:hover {
            background: #444;
        }
        .wp-context-menu-item.danger {
            color: #ff6b6b;
        }
        #wp-asset-project-select option {
            background: #2a2a2a;
            color: #fff;
        }
    `;
    document.head.appendChild(styles);
}

// 切换资产库面板显示/隐藏
function toggleAssetPanel(show = null) {
    if (!assetPanelElement) {
        createAssetPanel();
    }

    const shouldShow = show !== null ? show : !assetPanelVisible;
    
    if (shouldShow) {
        assetPanelElement.style.display = "flex";
        assetPanelVisible = true;
        // 每次打开面板时刷新数据
        loadProjects();
    } else {
        assetPanelElement.style.display = "none";
        assetPanelVisible = false;
    }
}

// ========== 项目管理 ==========

// 加载项目列表
async function loadProjects() {
    try {
        const response = await fetch(`${ASSET_API_BASE}/projects`);
        const projects = await response.json();
        
        projectsCache = projects;
        
        const projectSelect = document.getElementById("wp-asset-project-select");
        if (!projectSelect) return;
        
        // 保存当前选中值
        const currentVal = projectSelect.value;
        
        // 清空并重新填充
        projectSelect.innerHTML = "";
        
        projects.forEach(proj => {
            const option = document.createElement("option");
            option.value = proj.id;
            option.textContent = proj.name;
            projectSelect.appendChild(option);
        });
        
        // 恢复选中值或默认选第一个
        if (currentVal && projects.find(p => p.id === currentVal)) {
            projectSelect.value = currentVal;
        } else if (projects.length > 0) {
            projectSelect.value = projects[0].id;
            selectProject(projects[0].id);
        }
    } catch (error) {
        console.error("[WP资产库] 加载项目失败:", error);
    }
}

// 选择项目
async function selectProject(projectId) {
    currentProjectId = projectId;
    currentCategoryId = null;
    
    // 更新下拉框选中状态
    const projectSelect = document.getElementById("wp-asset-project-select");
    if (projectSelect) {
        projectSelect.value = projectId;
    }
    
    // 清除分类活动状态
    document.querySelectorAll('.wp-asset-category').forEach(el => {
        el.classList.remove('active');
    });
    
    // 加载该项目的分类
    await loadCategories(projectId);
    
    // 清空资产网格
    const grid = document.getElementById("wp-asset-grid");
    if (grid) {
        grid.innerHTML = "<div style='color:#888; text-align:center; padding:50px;'>请选择一个分类</div>";
    }
}

// 创建新项目
function createNewProject() {
    const name = prompt("请输入新项目名称:");
    if (name && name.trim()) {
        const cleanName = name.trim().replace(/[<>:"/\\|?*]/g, '').substring(0, 50);
        if (!cleanName) {
            alert("项目名称包含非法字符或为空");
            return;
        }
        
        const body = JSON.stringify({ name: cleanName });
        console.log('[WP资产库] 创建项目请求体:', body);
        
        fetch(`${ASSET_API_BASE}/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        })
        .then(response => response.json())
        .then(result => {
            if (result.success) {
                console.log('[WP资产库] 项目创建成功');
                loadProjects().then(() => {
                    // 选中新创建的项目
                    if (result.project_id) {
                        const projectSelect = document.getElementById("wp-asset-project-select");
                        if (projectSelect) {
                            projectSelect.value = result.project_id;
                            selectProject(result.project_id);
                        }
                    }
                });
            } else {
                alert(`创建失败: ${result.error || '未知错误'}`);
            }
        })
        .catch(error => {
            console.error('[WP资产库] 创建项目失败:', error);
            alert(`创建失败: ${error.message}`);
        });
    }
}

// 删除当前项目
async function deleteCurrentProject() {
    if (!currentProjectId) {
        alert("请先选择一个项目！");
        return;
    }
    
    const projSelect = document.getElementById("wp-asset-project-select");
    const projName = projSelect ? projSelect.options[projSelect.selectedIndex]?.text : "当前项目";
    
    if (!confirm(`确定要删除项目"${projName}"吗？\n\n此操作将永久删除该项目及其所有内容（分类、资产文件等），且不可恢复！`)) {
        return;
    }
    
    try {
        const response = await fetch(`${ASSET_API_BASE}/projects/${encodeURIComponent(currentProjectId)}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert("项目已删除");
            // 刷新项目列表
            await loadProjects();
            
            // 如果删除后没有项目了，自动创建默认项目
            const projects = projectsCache || [];
            if (projects.length === 0) {
                await fetch(`${ASSET_API_BASE}/projects`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: "默认项目", description: "默认项目" })
                });
                await loadProjects();
            }
        } else {
            alert("删除失败: " + (result.error || "未知错误"));
        }
    } catch (error) {
        console.error('[WP资产库] 删除项目失败:', error);
        alert("删除失败: " + error.message);
    }
}

// ========== 分类管理 ==========

// 加载分类列表
async function loadCategories(projectId) {
    try {
        const url = `${ASSET_API_BASE}/categories?project_id=${encodeURIComponent(projectId)}`;
        const response = await fetch(url);
        const categories = await response.json();
        
        const catList = document.getElementById("wp-asset-categories");
        if (!catList) return;
        
        catList.innerHTML = "";
        
        categories.forEach(cat => {
            const catElement = document.createElement("div");
            catElement.className = "wp-asset-category";
            if (currentCategoryId === cat.id) {
                catElement.classList.add("active");
            }
            catElement.dataset.categoryId = cat.id;
            
            const nameSpan = document.createElement("span");
            nameSpan.textContent = cat.name;
            nameSpan.style.cssText = "flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
            
            const rightGroup = document.createElement("span");
            rightGroup.style.cssText = "display: flex; align-items: center; gap: 6px;";
            
            const countSpan = document.createElement("span");
            countSpan.textContent = cat.asset_count;
            countSpan.style.cssText = "font-size: 10px; color: #888;";
            
            const delBtn = document.createElement("button");
            delBtn.innerHTML = "&#x1F5D1;&#xFE0F;"; // 🗑️
            delBtn.title = "删除此分类";
            delBtn.style.cssText = `
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.5);
                cursor: pointer;
                font-size: 14px;
                padding: 0 4px;
                line-height: 1;
                opacity: 0.6;
                transition: opacity 0.2s;
            `;
            delBtn.onmouseover = () => delBtn.style.opacity = "1";
            delBtn.onmouseout = () => delBtn.style.opacity = "0.6";
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteCategory(cat.id, cat.name);
            };
            
            rightGroup.appendChild(countSpan);
            rightGroup.appendChild(delBtn);
            
            catElement.appendChild(nameSpan);
            catElement.appendChild(rightGroup);
            
            catElement.onclick = () => selectCategory(cat.id);
            
            catElement.oncontextmenu = (e) => {
                e.preventDefault();
                showCategoryContextMenu(e, cat.id);
            };
            
            catList.appendChild(catElement);
        });
        
        // 默认选择第一个分类
        if (categories.length > 0) {
            selectCategory(categories[0].id);
        }
    } catch (error) {
        console.error("[WP资产库] 加载分类失败:", error);
    }
}

// 选择分类
async function selectCategory(categoryId) {
    currentCategoryId = categoryId;
    
    // 更新分类活动状态
    document.querySelectorAll('.wp-asset-category').forEach(el => {
        el.classList.remove('active');
        if (el.dataset.categoryId === categoryId) {
            el.classList.add('active');
        }
    });
    
    // 加载该分类的资产
    await loadAssetsByCategory(categoryId);
}

// 创建新分类
function createNewCategory() {
    if (!currentProjectId) {
        alert("请先选择一个项目！");
        return;
    }
    
    const name = prompt("请输入新分类名称:");
    if (name && name.trim()) {
        const cleanName = name.trim().replace(/[<>:"/\\|?*]/g, '').substring(0, 50);
        if (!cleanName) {
            alert("分类名称包含非法字符或为空");
            return;
        }
        
        const body = JSON.stringify({ 
            project_id: currentProjectId, 
            name: cleanName 
        });
        console.log('[WP资产库] 创建分类请求体:', body);
        
        fetch(`${ASSET_API_BASE}/categories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        })
        .then(response => {
            console.log('[WP资产库] 创建分类响应状态:', response.status);
            return response.json();
        })
        .then(result => {
            if (result.success) {
                console.log('[WP资产库] 分类创建成功');
                loadCategories(currentProjectId);
            } else {
                alert(`创建失败: ${result.error || '未知错误'}`);
            }
        })
        .catch(error => {
            console.error('[WP资产库] 创建分类失败:', error);
            alert(`创建失败: ${error.message}`);
        });
    }
}

// 删除分类
async function deleteCategory(categoryId, categoryName) {
    if (!currentProjectId) {
        alert("请先选择一个项目！");
        return;
    }
    
    if (!confirm(`确定要删除分类"${categoryName}"吗？\n\n此操作将永久删除该分类及其中所有资产文件，且不可恢复！`)) {
        return;
    }
    
    try {
        const response = await fetch(`${ASSET_API_BASE}/categories/${encodeURIComponent(categoryId)}?project_id=${encodeURIComponent(currentProjectId)}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert("分类已删除");
            // 刷新分类列表
            await loadCategories(currentProjectId);
            // 清空资产网格
            const grid = document.getElementById("wp-asset-grid");
            if (grid) {
                grid.innerHTML = "<div style='color:#888; text-align:center; padding:50px;'>请选择一个分类</div>";
            }
        } else {
            alert("删除失败: " + (result.error || "未知错误"));
        }
    } catch (error) {
        console.error('[WP资产库] 删除分类失败:', error);
        alert("删除失败: " + error.message);
    }
}

// 显示分类右键菜单
function showCategoryContextMenu(event, categoryId) {
    const menu = document.createElement("div");
    menu.className = "wp-context-menu";
    menu.style.cssText = `
        position: fixed;
        top: ${event.clientY}px;
        left: ${event.clientX}px;
    `;
    
    // 重命名
    const renameItem = document.createElement("div");
    renameItem.className = "wp-context-menu-item";
    renameItem.textContent = "重命名";
    renameItem.onclick = () => {
        const newName = prompt("请输入新分类名称:");
        if (newName && newName.trim()) {
            const cleanName = newName.trim().replace(/[<>:"/\\|?*]/g, '').substring(0, 50);
            fetch(`${ASSET_API_BASE}/categories/${categoryId}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: currentProjectId, name: cleanName })
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    loadCategories(currentProjectId);
                } else {
                    alert(`重命名失败: ${result.error}`);
                }
            })
            .catch(error => {
                alert(`重命名失败: ${error.message}`);
            });
        }
        document.body.removeChild(menu);
    };
    
    // 删除
    const deleteItem = document.createElement("div");
    deleteItem.className = "wp-context-menu-item danger";
    deleteItem.textContent = "删除分类";
    deleteItem.onclick = () => {
        if (confirm("确定要删除这个分类吗？（只能删除空分类）")) {
            fetch(`${ASSET_API_BASE}/categories/${categoryId}?project_id=${encodeURIComponent(currentProjectId)}`, {
                method: 'DELETE'
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    if (currentCategoryId === categoryId) {
                        currentCategoryId = null;
                    }
                    loadCategories(currentProjectId);
                } else {
                    alert(`删除失败: ${result.error}`);
                }
            })
            .catch(error => {
                alert(`删除失败: ${error.message}`);
            });
        }
        document.body.removeChild(menu);
    };
    
    menu.appendChild(renameItem);
    menu.appendChild(deleteItem);
    document.body.appendChild(menu);
    
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            document.body.removeChild(menu);
            document.removeEventListener('click', closeMenu);
        }
    };
    document.addEventListener('click', closeMenu);
}

// 加载分类下的资产
async function loadAssetsByCategory(categoryId, searchQuery = "") {
    if (!currentProjectId) {
        const grid = document.getElementById("wp-asset-grid");
        if (grid) {
            grid.innerHTML = "<div style='color:#888; text-align:center; padding:50px;'>请先选择一个项目</div>";
        }
        return;
    }
    
    try {
        let url = `${ASSET_API_BASE}/assets/${categoryId}?project_id=${encodeURIComponent(currentProjectId)}`;
        if (searchQuery) {
            url += `&q=${encodeURIComponent(searchQuery)}`;
        }
        
        const response = await fetch(url);
        const assets = await response.json();
        
        // 按名称排序
        if (assetSortMode === 'asc') {
            assets.sort((a, b) => (a.name || a.file_name || '').localeCompare(b.name || b.file_name || ''));
        } else if (assetSortMode === 'desc') {
            assets.sort((a, b) => (b.name || b.file_name || '').localeCompare(a.name || a.file_name || ''));
        }
        
        const grid = document.getElementById("wp-asset-grid");
        grid.innerHTML = "";
        
        if (assets.length === 0) {
            grid.innerHTML = "<div style='color:#888; text-align:center; padding:50px;'>暂无资产</div>";
            return;
        }
        
        assets.forEach(asset => {
            const assetElement = document.createElement("div");
            assetElement.className = "wp-asset-item";
            assetElement.dataset.assetId = asset.id;
            assetElement.draggable = true;
            
            // 创建缩略图
            const thumbDiv = document.createElement("div");
            thumbDiv.className = "wp-asset-thumb";
            const timestamp = new Date().getTime();
            thumbDiv.style.backgroundImage = `url("${ASSET_API_BASE}/thumbnail/${asset.id}?t=${timestamp}")`;
            
            // 创建信息区域
            const infoDiv = document.createElement("div");
            infoDiv.className = "wp-asset-info";
            infoDiv.textContent = asset.name || asset.file_name;
            
            assetElement.appendChild(thumbDiv);
            assetElement.appendChild(infoDiv);
            
            // 拖拽事件
            assetElement.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/plain", JSON.stringify({
                    type: "wp_asset",
                    assetId: asset.id,
                    fileName: asset.file_name
                }));
                e.dataTransfer.effectAllowed = "copy";
            });
            
            // 双击导出到画板
            assetElement.ondblclick = () => exportAssetToCanvas(asset.id);
            
            // 右键菜单
            assetElement.oncontextmenu = (e) => {
                e.preventDefault();
                showAssetContextMenu(e, asset.id);
            };
            
            grid.appendChild(assetElement);
        });
    } catch (error) {
        console.error("[WP资产库] 加载资产失败:", error);
    }
}

// 搜索资产
async function searchAssets(query) {
    if (!currentCategoryId) return;
    await loadAssetsByCategory(currentCategoryId, query);
}

// 导出资产到画板（双击功能）
async function exportAssetToCanvas(assetId) {
    try {
        const currentApp = getApp();
        if (!currentApp) {
            alert("无法获取 ComfyUI 实例，请刷新页面重试。");
            return;
        }
        
        const response = await fetch(`${ASSET_API_BASE}/asset/${assetId}`);
        const assetInfo = await response.json();
        
        if (assetInfo && assetInfo.file_name) {
            const copyResponse = await fetch(`${ASSET_API_BASE}/export_asset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: assetId })
            });
            
            if (copyResponse.ok) {
                const result = await copyResponse.json();
                
                if (result.success && result.filename) {
                    const node = LiteGraph.createNode("WP_ImageLoad");
                    if (!node) {
                        alert("无法创建加载图像节点。");
                        return;
                    }
                    
                    // 获取鼠标位置
                    let posX = 100, posY = 100;
                    const canvas = currentApp.canvas;
                    if (canvas && canvas.graph_mouse) {
                        posX = canvas.graph_mouse[0];
                        posY = canvas.graph_mouse[1];
                    }
                    node.pos = [posX, posY];
                    
                    // 添加节点到画布
                    currentApp.graph.add(node);
                    
                    // 设置图像文件名
                    setTimeout(() => {
                        if (node.widgets) {
                            for (let i = 0; i < node.widgets.length; i++) {
                                const widget = node.widgets[i];
                                if (widget.name === "image") {
                                    widget.value = result.filename;
                                    if (widget.callback) {
                                        widget.callback(widget.value);
                                    }
                                    break;
                                }
                            }
                        }
                        node.setSize(node.computeSize());
                        node.setDirtyCanvas(true, true);
                    }, 50);
                } else {
                    alert("导出资产失败: " + (result.error || "未知错误"));
                }
            } else {
                alert("导出资产失败");
            }
        }
    } catch (error) {
        console.error("[WP资产库] 导出资产失败:", error);
        alert("导出资产失败: " + error.message);
    }
}

// 扫描本地文件并添加到资产库
async function scanLocalFiles() {
    if (!currentProjectId) {
        alert("请先选择一个项目！");
        return;
    }
    if (!currentCategoryId) {
        alert("请先选择一个分类！");
        return;
    }
    
    // 查找刷新按钮并禁用
    const btn = document.getElementById("wp-asset-refresh-btn");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = "⟳ 扫描中...";
    }
    
    try {
        const response = await fetch(`${ASSET_API_BASE}/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: currentProjectId,
                category_id: currentCategoryId
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            if (result.count > 0) {
                alert(result.message);
                // 刷新当前分类资产列表
                await loadAssetsByCategory(currentCategoryId);
                // 刷新分类列表（更新资产数量）
                await loadCategories(currentProjectId);
            } else {
                alert("没有发现新的图片文件。");
            }
        } else {
            alert("扫描失败: " + (result.error || "未知错误"));
        }
    } catch (error) {
        console.error("[WP资产库] 扫描失败:", error);
        alert("扫描失败: " + error.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = "⟳ 刷新";
        }
    }
}

// 显示上传对话框
function showUploadDialog() {
    if (!currentProjectId) {
        alert("请先选择一个项目！");
        return;
    }
    
    if (!currentCategoryId) {
        alert("请先选择一个分类！");
        return;
    }
    
    // 创建上传覆盖层
    const overlay = document.createElement("div");
    overlay.className = "wp-upload-overlay";
    
    const dialog = document.createElement("div");
    dialog.className = "wp-upload-dialog";
    
    // 标题
    const title = document.createElement("h3");
    title.textContent = "上传图片到资产库";
    title.style.cssText = "margin: 0 0 15px 0; color: #fff;";
    
    // 当前项目/分类信息
    const infoDiv = document.createElement("div");
    infoDiv.style.cssText = "color: #aaa; font-size: 12px; margin-bottom: 15px;";
    
    const currentProj = projectsCache.find(p => p.id === currentProjectId);
    const projName = currentProj ? currentProj.name : "未知项目";
    infoDiv.textContent = `项目: ${projName} | 分类: ${currentCategoryId}`;
    
    // 文件输入
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.cssText = "display: none;";
    
    // 拖拽区域
    const dropZone = document.createElement("div");
    dropZone.className = "wp-drop-zone";
    dropZone.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 10px;"></div>
        <div>拖拽图片到这里或点击选择</div>
        <div style="font-size: 12px; color: #888; margin-top: 5px;">支持 JPG, PNG, WEBP, GIF</div>
    `;
    
    // 名称输入
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "资产名称 (可选):";
    nameLabel.style.cssText = "display: block; color: #ccc; margin: 10px 0 5px 0;";
    
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "留空则使用文件名";
    nameInput.style.cssText = `
        width: 100%;
        padding: 8px;
        background: #333;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        margin-bottom: 15px;
    `;
    
    // 按钮区域
    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;";
    
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = `
        padding: 8px 16px;
        background: #555;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
    `;
    cancelBtn.onclick = () => document.body.removeChild(overlay);
    
    const uploadBtn = document.createElement("button");
    uploadBtn.textContent = "上传";
    uploadBtn.style.cssText = `
        padding: 8px 16px;
        background: #28a745;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
    `;
    uploadBtn.onclick = () => uploadSelectedFiles(fileInput.files, nameInput.value, overlay);
    
    // 事件处理
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = () => {
        if (fileInput.files.length > 0) {
            dropZone.innerHTML = `<div>已选择 ${fileInput.files.length} 个文件</div>`;
        }
    };
    
    // 拖拽事件
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        fileInput.files = e.dataTransfer.files;
        if (e.dataTransfer.files.length > 0) {
            dropZone.innerHTML = `<div>已拖拽 ${e.dataTransfer.files.length} 个文件</div>`;
        }
    });
    
    dialog.appendChild(title);
    dialog.appendChild(infoDiv);
    dialog.appendChild(dropZone);
    dialog.appendChild(fileInput);
    dialog.appendChild(nameLabel);
    dialog.appendChild(nameInput);
    dialog.appendChild(buttonRow);
    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(uploadBtn);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// 上传选中的文件
async function uploadSelectedFiles(files, assetName, overlay) {
    if (!files || files.length === 0) {
        alert("请先选择文件！");
        return;
    }
    
    // 创建表单数据
    const formData = new FormData();
    formData.append('project_id', currentProjectId);
    formData.append('category_id', currentCategoryId);
    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }
    if (assetName && assetName.trim()) {
        formData.append('name', assetName.trim());
    }
    
    try {
        const response = await fetch(`${ASSET_API_BASE}/upload`, {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        if (result.success) {
            alert(`成功上传 ${result.count} 个文件！`);
            document.body.removeChild(overlay);
            
            // 重新加载当前分类的资产
            if (currentCategoryId) {
                await loadAssetsByCategory(currentCategoryId);
            }
        } else {
            alert(`上传失败: ${result.error || '未知错误'}`);
        }
    } catch (error) {
        console.error("[WP资产库] 上传失败:", error);
        alert(`上传失败: ${error.message}`);
    }
}

// 显示资产右键菜单
function showAssetContextMenu(event, assetId) {
    const menu = document.createElement("div");
    menu.className = "wp-context-menu";
    menu.style.cssText = `
        position: fixed;
        top: ${event.clientY}px;
        left: ${event.clientX}px;
    `;
    
    // 导出到画板
    const exportItem = document.createElement("div");
    exportItem.className = "wp-context-menu-item";
    exportItem.textContent = "导出到画板";
    exportItem.onclick = () => {
        exportAssetToCanvas(assetId);
        document.body.removeChild(menu);
    };
    
    // 重命名
    const renameItem = document.createElement("div");
    renameItem.className = "wp-context-menu-item";
    renameItem.textContent = "重命名";
    renameItem.onclick = () => {
        const currentName = document.querySelector(`.wp-asset-item[data-asset-id="${assetId}"] .wp-asset-info`)?.textContent || "";
        const newName = prompt("请输入新资产名称:", currentName);
        if (newName && newName.trim()) {
            const cleanName = newName.trim().replace(/[<>:"/\\|?*]/g, '').substring(0, 50);
            fetch(`${ASSET_API_BASE}/asset/${assetId}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: cleanName })
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    if (currentCategoryId) {
                        loadAssetsByCategory(currentCategoryId);
                    }
                } else {
                    alert(`重命名失败: ${result.error}`);
                }
            })
            .catch(error => {
                alert(`重命名失败: ${error.message}`);
            });
        }
        document.body.removeChild(menu);
    };
    
    // 删除
    const deleteItem = document.createElement("div");
    deleteItem.className = "wp-context-menu-item danger";
    deleteItem.textContent = "删除资产";
    deleteItem.onclick = () => {
        if (confirm("确定要删除这个资产吗？")) {
            fetch(`${ASSET_API_BASE}/asset/${assetId}`, {
                method: 'DELETE'
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    if (currentCategoryId) {
                        loadAssetsByCategory(currentCategoryId);
                    }
                } else {
                    alert(`删除失败: ${result.error}`);
                }
            })
            .catch(error => {
                alert(`删除失败: ${error.message}`);
            });
        }
        document.body.removeChild(menu);
    };
    
    menu.appendChild(exportItem);
    menu.appendChild(renameItem);
    menu.appendChild(deleteItem);
    document.body.appendChild(menu);
    
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            document.body.removeChild(menu);
            document.removeEventListener('click', closeMenu);
        }
    };
    document.addEventListener('click', closeMenu);
}

// 创建悬浮按钮
function createFloatingButton() {
    const button = document.createElement("div");
    button.id = "wp-asset-library-button";
    button.innerHTML = "🐳 资产库";
    button.style.cssText = `
        position: fixed;
        bottom: 68px;
        right: 68px;
        padding: 12px 24px;
        background: linear-gradient(135deg, rgba(102, 42, 213, 0.65) 0%, rgba(102, 42, 213, 0.45) 100%);
        color: white;
        border-radius: 50px;
        cursor: pointer;
        z-index: 9999;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 4px 20px rgba(102, 42, 213, 0.45), 0 0 15px rgba(102, 42, 213, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2);
        backdrop-filter: blur(15px) saturate(1.2);
        -webkit-backdrop-filter: blur(15px) saturate(1.2);
        transition: all 0.3s ease;
        border: 1px solid rgba(255, 255, 255, 0.25);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        letter-spacing: 0.3px;
    `;
    
    button.onclick = () => toggleAssetPanel();
    
    button.onmouseenter = () => {
        button.style.transform = "scale(1.08) translateY(-2px)";
        button.style.background = "linear-gradient(135deg, rgba(102, 42, 213, 0.85) 0%, rgba(102, 42, 213, 0.6) 100%)";
        button.style.boxShadow = "0 8px 30px rgba(102, 42, 213, 0.6), 0 0 25px rgba(102, 42, 213, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.3)";
        button.style.borderColor = "rgba(255, 255, 255, 0.35)";
    };
    
    button.onmouseleave = () => {
        button.style.transform = "scale(1) translateY(0)";
        button.style.background = "linear-gradient(135deg, rgba(102, 42, 213, 0.65) 0%, rgba(102, 42, 213, 0.45) 100%)";
        button.style.boxShadow = "0 4px 20px rgba(102, 42, 213, 0.45), 0 0 15px rgba(102, 42, 213, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2)";
        button.style.borderColor = "rgba(255, 255, 255, 0.25)";
    };
    
    document.body.appendChild(button);
}

// 初始化资产库扩展
function initAssetLibrary() {
    createFloatingButton();
    setTimeout(createAssetPanel, 1000);
    console.log("[WP资产库] 前端扩展已加载");
}

// 保存图像到资产库（右键菜单）
async function saveImageToAssetLibrary(imageSrc) {
    try {
        const response = await fetch(imageSrc);
        const blob = await response.blob();
        
        const fileName = `asset_${Date.now()}.png`;
        const file = new File([blob], fileName, { type: blob.type });
        
        showUploadDialogWithFile(file);
    } catch (error) {
        console.error("[WP资产库] 保存图像失败:", error);
        alert("保存图像到资产库失败: " + error.message);
    }
}

// 显示带预选文件的上传对话框
function showUploadDialogWithFile(file) {
    if (!currentProjectId || !currentCategoryId) {
        alert("请先在资产库中选择项目和分类！");
        return;
    }
    
    const overlay = document.createElement("div");
    overlay.className = "wp-upload-overlay";
    
    const dialog = document.createElement("div");
    dialog.className = "wp-upload-dialog";
    
    const title = document.createElement("h3");
    title.textContent = "保存图像到资产库";
    title.style.cssText = "margin: 0 0 15px 0; color: #fff;";
    
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "资产名称:";
    nameLabel.style.cssText = "display: block; color: #ccc; margin: 10px 0 5px 0;";
    
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "输入资产名称";
    nameInput.style.cssText = `
        width: 100%;
        padding: 8px;
        background: #333;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        margin-bottom: 15px;
    `;
    nameInput.value = `Image_${new Date().toLocaleString().replace(/[\/:]/g, '-')}`;
    
    const previewDiv = document.createElement("div");
    previewDiv.style.cssText = `
        text-align: center;
        margin-bottom: 15px;
        padding: 10px;
        background: rgba(40, 40, 40, 0.5);
        border-radius: 6px;
    `;
    
    const imgPreview = document.createElement("img");
    imgPreview.src = URL.createObjectURL(file);
    imgPreview.style.cssText = `
        max-width: 100%;
        max-height: 200px;
        object-fit: contain;
        border: 1px solid #444;
        border-radius: 4px;
    `;
    
    previewDiv.appendChild(imgPreview);
    
    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;";
    
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = `
        padding: 8px 16px;
        background: #555;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
    `;
    cancelBtn.onclick = () => {
        URL.revokeObjectURL(imgPreview.src);
        document.body.removeChild(overlay);
    };
    
    const uploadBtn = document.createElement("button");
    uploadBtn.textContent = "保存到资产库";
    uploadBtn.style.cssText = `
        padding: 8px 16px;
        background: #28a745;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
    `;
    uploadBtn.onclick = () => uploadSingleFile(file, nameInput.value, overlay, imgPreview.src);
    
    dialog.appendChild(title);
    dialog.appendChild(previewDiv);
    dialog.appendChild(nameLabel);
    dialog.appendChild(nameInput);
    dialog.appendChild(buttonRow);
    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(uploadBtn);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// 上传单个文件
async function uploadSingleFile(file, assetName, overlay, previewUrl) {
    if (!assetName || !assetName.trim()) {
        alert("请输入资产名称！");
        return;
    }
    
    const formData = new FormData();
    formData.append('project_id', currentProjectId);
    formData.append('category_id', currentCategoryId);
    formData.append('files', file);
    formData.append('name', assetName.trim());
    
    try {
        const response = await fetch(`${ASSET_API_BASE}/upload`, {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        if (result.success) {
            alert(`成功保存图像到资产库！`);
            document.body.removeChild(overlay);
            URL.revokeObjectURL(previewUrl);
            
            if (currentCategoryId) {
                await loadAssetsByCategory(currentCategoryId);
            }
        } else {
            URL.revokeObjectURL(previewUrl);
            alert(`保存失败: ${result.error || '未知错误'}`);
        }
    } catch (error) {
        URL.revokeObjectURL(previewUrl);
        console.error("[WP资产库] 保存失败:", error);
        alert(`保存失败: ${error.message}`);
    }
}

// 在ComfyUI准备好后获取 app 并注册扩展
async function init() {
    // 等待 comfyAPI 可用
    const maxRetries = 20;
    for (let i = 0; i < maxRetries; i++) {
        if (window.comfyAPI && window.comfyAPI.app) {
            break;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    
    // 更新全局 app
    if (window.comfyAPI?.app) {
        ({ app } = window.comfyAPI.app);
    }
    
    if (!app) {
        console.error('[WP资产库] 无法获取 ComfyUI app 对象');
        return;
    }
    
    // 注册扩展：添加右键菜单 + 初始化资产库
    app.registerExtension({
        name: "WP_Node.AssetLibrary",
        
        // 在节点注册时添加右键菜单
        beforeRegisterNodeDef(nodeType, nodeData, app) {
            // 对 PreviewImage、SaveImage、VHS_VideoCombine 等输出图像的节点添加右键菜单
            const nodeCategory = nodeData?.category || nodeType?.category || "";
            const nodeName = nodeData?.name || nodeType?.title || "";
            
            // 判断是否为图像输出节点
            const isImageNode = (
                nodeCategory.includes("image") || 
                nodeName.includes("PreviewImage") || 
                nodeName.includes("SaveImage") ||
                nodeName.includes("ImageSave") ||
                nodeName.includes("VHS_VideoCombine") ||
                nodeData?.output?.includes("IMAGE")
            );
            
            if (isImageNode) {
                const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
                nodeType.prototype.getExtraMenuOptions = function (_, options) {
                    origGetExtraMenuOptions?.apply?.(this, arguments);
                    
                    // 添加分隔符
                    if (options.length > 0 && options[options.length - 1] !== null) {
                        options.push(null);
                    }
                    
                    // 添加保存到资产库菜单项
                    options.push({
                        content: "🐳 保存到资产库",
                        callback: () => {
                            saveNodeImageToLibrary(this);
                        }
                    });
                };
            }
        },
        
        // 监听后端发来的刷新消息
        setup() {
            // 监听资产库刷新事件
            if (typeof api !== "undefined" && api.addEventListener) {
                api.addEventListener("wp_asset_library_refresh", (event) => {
                    console.log("[WP资产库] 收到刷新通知:", event.detail);
                    // 刷新资产库显示
                    if (assetPanelVisible) {
                        loadProjects();
                        if (currentCategoryId) {
                            loadAssetsByCategory(currentCategoryId);
                        }
                    }
                });
            }
        },
        
        init: function() {
            initAssetLibrary();
        }
    });
}

init();

// 保存节点图像到资产库
async function saveNodeImageToLibrary(node) {
    const currentApp = getApp();
    if (!currentApp) {
        alert("无法获取 ComfyUI 实例，请刷新页面重试。");
        return;
    }
    
    try {
        // 获取项目的 blob URL 或图片数据
        let imgElement = null;
        let imageUrl = null;
        
        // 方法1: 从节点的输出槽获取图像
        if (node.outputs) {
            for (const output of node.outputs) {
                if (output.slot_index !== undefined && output.type === "IMAGE") {
                    // 尝试从节点的预览元素中找图片
                    const previewImg = node.imgs?.[0];
                    if (previewImg) {
                        imgElement = previewImg;
                        imageUrl = previewImg.src;
                        break;
                    }
                }
            }
        }
        
        // 方法2: 直接从 node.imgs 获取
        if (!imgElement && node.imgs && node.imgs.length > 0) {
            imgElement = node.imgs[0];
            imageUrl = node.imgs[0].src;
        }
        
        // 方法3: 从节点 DOM 中找 canvas 或 img
        if (!imgElement) {
            const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
            if (nodeElement) {
                const img = nodeElement.querySelector('img');
                const canvas = nodeElement.querySelector('canvas');
                if (img && img.src && !img.src.startsWith('data:,')) {
                    imgElement = img;
                    imageUrl = img.src;
                } else if (canvas) {
                    imageUrl = canvas.toDataURL('image/png');
                }
            }
        }
        
        if (!imageUrl) {
            alert("无法获取节点图像，请确保节点已生成输出。");
            return;
        }
        
        // 显示保存对话框
        showSaveToLibraryDialog(imageUrl, currentApp);
        
    } catch (error) {
        console.error("[WP资产库] 保存节点图像失败:", error);
        alert("保存失败: " + error.message);
    }
}

// 显示保存到资产库的对话框
async function showSaveToLibraryDialog(imageUrl, currentApp) {
    // 确保有最新的项目列表
    let projects = [];
    try {
        const response = await fetch(`${ASSET_API_BASE}/projects`);
        projects = await response.json();
        if (!Array.isArray(projects)) projects = [];
        projectsCache = projects; // 更新缓存
    } catch (e) {
        console.error("[WP资产库] 获取项目列表失败:", e);
    }

    // 确保有分类列表
    let categories = [];
    if (currentProjectId) {
        try {
            const catResponse = await fetch(`${ASSET_API_BASE}/categories?project_id=${encodeURIComponent(currentProjectId)}`);
            categories = await catResponse.json();
            if (!Array.isArray(categories)) categories = [];
        } catch (e) {
            console.error("[WP资产库] 获取分类列表失败:", e);
        }
    }

    const overlay = document.createElement("div");
    overlay.className = "wp-upload-overlay";
    
    const dialog = document.createElement("div");
    dialog.className = "wp-upload-dialog";
    
    // 标题
    const title = document.createElement("h3");
    title.textContent = "🐳 保存到资产库";
    title.style.cssText = "margin: 0 0 15px 0; color: #fff;";
    
    // 预览图
    const previewDiv = document.createElement("div");
    previewDiv.style.cssText = `
        text-align: center;
        margin-bottom: 15px;
        padding: 10px;
        background: rgba(40, 40, 40, 0.5);
        border-radius: 6px;
    `;
    const imgPreview = document.createElement("img");
    imgPreview.src = imageUrl;
    imgPreview.style.cssText = `
        max-width: 100%;
        max-height: 200px;
        object-fit: contain;
        border: 1px solid #444;
        border-radius: 4px;
    `;
    previewDiv.appendChild(imgPreview);
    
    // 项目选择
    const projLabel = document.createElement("label");
    projLabel.textContent = "项目:";
    projLabel.style.cssText = "display: block; color: #ccc; margin: 10px 0 5px 0;";
    
    const projSelect = document.createElement("select");
    projSelect.style.cssText = `
        width: 100%;
        padding: 8px;
        background: #333;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
    `;
    projects.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === currentProjectId) opt.selected = true;
        projSelect.appendChild(opt);
    });
    
    // 分类选择
    const catLabel = document.createElement("label");
    catLabel.textContent = "分类:";
    catLabel.style.cssText = "display: block; color: #ccc; margin: 10px 0 5px 0;";
    
    const catSelect = document.createElement("select");
    catSelect.style.cssText = `
        width: 100%;
        padding: 8px;
        background: #333;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
    `;
    
    // 填充分类
    function populateCategories(cats) {
        catSelect.innerHTML = "";
        cats.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name;
            if (c.id === currentCategoryId) opt.selected = true;
            catSelect.appendChild(opt);
        });
    }
    populateCategories(categories);
    
    // 项目切换时加载分类
    projSelect.onchange = async () => {
        const projId = projSelect.value;
        try {
            const catResponse = await fetch(`${ASSET_API_BASE}/categories?project_id=${encodeURIComponent(projId)}`);
            const cats = await catResponse.json();
            populateCategories(Array.isArray(cats) ? cats : []);
        } catch (e) {
            console.error("[WP资产库] 加载分类失败:", e);
        }
    };
    
    // 资产名称
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "资产名称 (可选):";
    nameLabel.style.cssText = "display: block; color: #ccc; margin: 10px 0 5px 0;";
    
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "留空使用默认名";
    nameInput.style.cssText = `
        width: 100%;
        padding: 8px;
        background: #333;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        margin-bottom: 15px;
    `;
    
    // 按钮区域
    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;";
    
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = `
        padding: 8px 16px;
        background: #555;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
    `;
    cancelBtn.onclick = () => {
        if (imgPreview.src.startsWith('blob:')) {
            URL.revokeObjectURL(imgPreview.src);
        }
        document.body.removeChild(overlay);
    };
    
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "保存";
    saveBtn.style.cssText = `
        padding: 8px 16px;
        background: #28a745;
        border: none;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
    `;
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中...";
        
        const projId = projSelect.value;
        const catId = catSelect.value;
        const assetName = nameInput.value.trim();
        
        if (!projId || !catId) {
            alert("请选择项目和分类");
            saveBtn.disabled = false;
            saveBtn.textContent = "保存";
            return;
        }
        
        try {
            // 将图片 URL 转为 blob
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            const fileName = `asset_${Date.now()}.png`;
            const file = new File([blob], fileName, { type: blob.type });
            
            // 上传
            const formData = new FormData();
            formData.append('project_id', projId);
            formData.append('category_id', catId);
            formData.append('files', file);
            if (assetName) {
                formData.append('name', assetName);
            }
            
            const uploadResponse = await fetch(`${ASSET_API_BASE}/upload`, {
                method: 'POST',
                body: formData
            });
            
            const result = await uploadResponse.json();
            
            if (result.success) {
                alert("保存成功！");
                if (imgPreview.src.startsWith('blob:')) {
                    URL.revokeObjectURL(imgPreview.src);
                }
                document.body.removeChild(overlay);
                
                // 刷新资产库
                if (currentCategoryId) {
                    loadAssetsByCategory(currentCategoryId);
                }
            } else {
                alert("保存失败: " + (result.error || "未知错误"));
                saveBtn.disabled = false;
                saveBtn.textContent = "保存";
            }
        } catch (error) {
            alert("保存失败: " + error.message);
            saveBtn.disabled = false;
            saveBtn.textContent = "保存";
        }
    };
    
    dialog.appendChild(title);
    dialog.appendChild(previewDiv);
    dialog.appendChild(projLabel);
    dialog.appendChild(projSelect);
    dialog.appendChild(catLabel);
    dialog.appendChild(catSelect);
    dialog.appendChild(nameLabel);
    dialog.appendChild(nameInput);
    dialog.appendChild(buttonRow);
    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(saveBtn);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// 导出函数供其他模块使用
window.WPAssetLibrary = {
    togglePanel: toggleAssetPanel,
    showUploadDialog: showUploadDialog
};

// ========== 画布拖拽支持 ==========
(function initCanvasDrop() {
    // 等待 app 初始化后注册
    function registerDrop() {
        const currentApp = getApp();
        if (!currentApp || !currentApp.canvas) {
            setTimeout(registerDrop, 500);
            return;
        }
        
        const canvasEl = currentApp.canvas.canvas;
        if (!canvasEl) {
            setTimeout(registerDrop, 500);
            return;
        }
        
        console.log("[WP资产库] 画布拖拽监听器已注册");
        
        // 查找 LoadImage 节点的函数（使用 ComfyUI 官方坐标转换方法）
        function findNodeAt(clientX, clientY) {
            const worldPos = currentApp.canvas.convertEventToCanvasOffset({
                clientX: clientX,
                clientY: clientY
            });
            
            const node = currentApp.graph.getNodeOnPos(worldPos[0], worldPos[1]);
            if (node && (node.type === "LoadImage" || node.type === "WP_ImageLoad")) {
                return node;
            }
            
            // 备用：手动遍历查找
            const allNodes = currentApp.graph._nodes || [];
            for (const n of allNodes) {
                if (n.type !== "LoadImage" && n.type !== "WP_ImageLoad") continue;
                if (worldPos[0] >= n.pos[0] && worldPos[0] <= n.pos[0] + n.size[0] &&
                    worldPos[1] >= n.pos[1] && worldPos[1] <= n.pos[1] + n.size[1]) {
                    return n;
                }
            }
            
            return null;
        }
        
        document.addEventListener("drop", async (e) => {
            const rect = canvasEl.getBoundingClientRect();
            const inCanvas = e.clientX >= rect.left && e.clientX <= rect.right &&
                             e.clientY >= rect.top && e.clientY <= rect.bottom;
            
            if (!inCanvas) return;
            
            try {
                let jsonStr = null;
                for (const type of e.dataTransfer.types) {
                    const data = e.dataTransfer.getData(type);
                    if (type === "text/plain" && data) {
                        jsonStr = data;
                    }
                }
                
                if (!jsonStr) return;
                
                const parsed = JSON.parse(jsonStr);
                if (parsed.type !== "wp_asset") return;
                
                e.preventDefault();
                e.stopPropagation();
                
                const targetNode = findNodeAt(e.clientX, e.clientY);
                if (!targetNode) return;
                
                const response = await fetch(`${ASSET_API_BASE}/asset/${parsed.assetId}/copy_to_input`, {
                    method: 'POST'
                });
                const result = await response.json();
                
                if (result.success) {
                    const widgets = targetNode.widgets || [];
                    const imageWidget = widgets.find(w => w.name === "image" || w.name === "image_upload");
                    
                    if (imageWidget) {
                        imageWidget.value = result.file_name;
                        imageWidget.callback && imageWidget.callback(result.file_name);
                        targetNode.setDirtyCanvas(true, true);
                        currentApp.graph.setDirtyCanvas(true, true);
                    } else {
                        console.error("[WP资产库] 未找到 image widget");
                    }
                } else {
                    console.error("[WP资产库] 拖拽失败:", result.error);
                }
            } catch (err) {
                console.error("[WP资产库] 画布拖拽异常:", err);
            }
        }, true);
    }
    
    // 初始化
    setTimeout(registerDrop, 1000);
})();
