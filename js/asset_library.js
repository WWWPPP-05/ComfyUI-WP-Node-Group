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

// ComfyUI 输出文件夹（虚拟项目）：不写入账本，每次直接读磁盘
const WP_OUTPUT_PROJECT_ID = "__wp_output__";
let outputViewEnabled = false;   // 当前是否处于输出视图
let currentOutputFilter = "all"; // 当前选中的输出分类筛选（all/image/video/audio/text）
let outputAllFiles = [];         // 输出文件夹全量文件缓存（分类筛选与计数的数据源）
let outputListMeta = null;       // 全量列表的截断信息（truncated/total/max_files）
let assetListCache = [];         // 当前分类最新资产列表（详情页图片左右切换用）
let outputListCache = [];        // 当前输出文件列表（详情页图片左右切换用）

// 输出视图左侧固定分类（key 与后端 file_type 对应）
const OUTPUT_FILTERS = [
    { key: "all",   name: "全部", icon: "📋" },
    { key: "image", name: "图片", icon: "🖼️" },
    { key: "video", name: "视频", icon: "🎬" },
    { key: "audio", name: "音频", icon: "🎵" },
    { key: "text",  name: "文字", icon: "📄" },
];
let multiSelectMode = false;     // 素材多选模式开关
let selectedAssetIds = new Set(); // 多选模式下已选中的素材ID集合

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

    // 右侧按钮组（设置 + 关闭）
    const headerRight = document.createElement("div");
    headerRight.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    // 设置按钮
    const settingsBtn = document.createElement("button");
    settingsBtn.innerHTML = "⚙";
    settingsBtn.title = "存储设置";
    settingsBtn.style.cssText = `
        background: rgba(255, 255, 255, 0.15);
        border: none;
        color: #fff;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
    `;
    settingsBtn.onmouseover = () => settingsBtn.style.background = "rgba(255, 255, 255, 0.3)";
    settingsBtn.onmouseout = () => settingsBtn.style.background = "rgba(255, 255, 255, 0.15)";
    settingsBtn.onclick = () => showStorageSettingsDialog();

    headerRight.appendChild(settingsBtn);
    headerRight.appendChild(closeBtn);

    header.appendChild(title);
    header.appendChild(headerRight);

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
    newProjBtn.id = "wp-asset-new-project-btn";
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
    newCatBtn.id = "wp-asset-new-category-btn";
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

    // 修改当前项目名称按钮（放在删除按钮上方）
    const renameProjBtn = document.createElement("button");
    renameProjBtn.id = "wp-asset-rename-project-btn";
    renameProjBtn.textContent = "✏️ 修改当前项目名称";
    renameProjBtn.title = "修改当前选中的项目名称";
    renameProjBtn.style.cssText = `
        width: calc(100% - 20px);
        margin: 5px auto;
        padding: 6px 10px;
        background: rgba(128, 128, 128, 0.3);
        border: none;
        border-radius: 16px;
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
    `;
    renameProjBtn.onmouseover = () => renameProjBtn.style.background = "rgba(102, 42, 213, 0.5)";
    renameProjBtn.onmouseout = () => renameProjBtn.style.background = "rgba(128, 128, 128, 0.3)";
    renameProjBtn.onclick = renameCurrentProject;
    sidebar.appendChild(renameProjBtn);

    // 删除当前项目按钮（放在左侧面板最下方）
    const deleteProjBtn = document.createElement("button");
    deleteProjBtn.id = "wp-asset-delete-project-btn";
    deleteProjBtn.textContent = "️ 删除当前项目";
    deleteProjBtn.title = "删除当前选中的项目及其所有内容";
    deleteProjBtn.style.cssText = `
        width: calc(100% - 20px);
        margin: 5px auto 10px auto;
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
        if (outputViewEnabled) {
            renderOutputFiltered(); // 排序在渲染时生效，直接重渲染当前分类即可
        } else if (currentCategoryId) {
            loadAssetsByCategory(currentCategoryId, document.getElementById("wp-asset-search-input")?.value || "");
        }
    };
    leftGroup.appendChild(sortBtn);

    // 右侧：操作按钮组
    const rightGroup = document.createElement("div");
    rightGroup.style.cssText = `
        display: flex;
        gap: 8px;
        align-items: center;
    `;

    // 多选模式按钮（位于刷新按钮左侧）
    const multiSelectBtn = document.createElement("button");
    multiSelectBtn.id = "wp-asset-multi-select-btn";
    multiSelectBtn.title = "多选模式：批量选择素材进行删除/移动";
    multiSelectBtn.style.cssText = `
        width: 24px;
        height: 24px;
        min-width: 24px;
        background: rgba(128, 128, 128, 0.3);
        border: 1px solid rgba(128, 128, 128, 0.2);
        border-radius: 50%;
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
    `;
    multiSelectBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="4.5" width="10" height="10" rx="2"/><path d="M4.5 4.5V3.5A1.5 1.5 0 0 1 6 2h7A1.5 1.5 0 0 1 14.5 3.5v7A1.5 1.5 0 0 1 13 12h-1"/><path d="M5 9.5l2 2 4-4.5"/></svg>`;
    multiSelectBtn.onmouseover = () => {
        if (!multiSelectMode) multiSelectBtn.style.background = "rgba(128, 128, 128, 0.5)";
    };
    multiSelectBtn.onmouseout = () => {
        if (!multiSelectMode) multiSelectBtn.style.background = "rgba(128, 128, 128, 0.3)";
    };
    multiSelectBtn.onclick = () => toggleMultiSelectMode();

    // 刷新按钮
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "wp-refresh-btn";
    refreshBtn.id = "wp-asset-refresh-btn";
    refreshBtn.innerHTML = "⟳ 刷新";
    refreshBtn.title = "全库智能扫描：自动识别新文件夹（项目/分类）、新素材，并同步改名/删除";
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
    uploadBtn.id = "wp-asset-upload-btn";
    uploadBtn.textContent = "上传文件";
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

    rightGroup.appendChild(multiSelectBtn);
    rightGroup.appendChild(refreshBtn);
    rightGroup.appendChild(uploadBtn);
    toolbar.appendChild(leftGroup);
    toolbar.appendChild(rightGroup);

    // 批量操作工具栏（多选模式下有选中素材时显示）
    const batchToolbar = document.createElement("div");
    batchToolbar.id = "wp-asset-batch-toolbar";
    batchToolbar.style.cssText = `
        display: none;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        margin-bottom: 10px;
        background: rgba(102, 42, 213, 0.15);
        border: 1px solid rgba(102, 42, 213, 0.4);
        border-radius: 8px;
        flex-wrap: wrap;
        flex-shrink: 0;
    `;

    const batchCount = document.createElement("span");
    batchCount.id = "wp-asset-batch-count";
    batchCount.style.cssText = `
        font-size: 12px;
        color: #c9a6ff;
        white-space: nowrap;
    `;
    batchCount.textContent = "已选 0 项";

    const batchMoveBtn = document.createElement("button");
    batchMoveBtn.id = "wp-asset-batch-move-btn";
    batchMoveBtn.textContent = "📁 移动至...";
    batchMoveBtn.style.cssText = `
        padding: 3px 12px;
        height: 24px;
        background: #662ad5;
        border: none;
        border-radius: 6px;
        color: #fff;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
        transition: background 0.2s;
    `;
    batchMoveBtn.onmouseover = () => batchMoveBtn.style.background = "#5a24bf";
    batchMoveBtn.onmouseout = () => batchMoveBtn.style.background = "#662ad5";
    batchMoveBtn.onclick = () => showBatchMoveDialog();

    const batchDeleteBtn = document.createElement("button");
    batchDeleteBtn.id = "wp-asset-batch-delete-btn";
    batchDeleteBtn.textContent = "🗑 删除";
    batchDeleteBtn.style.cssText = `
        padding: 3px 12px;
        height: 24px;
        background: rgba(220, 53, 69, 0.85);
        border: none;
        border-radius: 6px;
        color: #fff;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
        transition: background 0.2s;
    `;
    batchDeleteBtn.onmouseover = () => batchDeleteBtn.style.background = "rgba(200, 35, 51, 0.95)";
    batchDeleteBtn.onmouseout = () => batchDeleteBtn.style.background = "rgba(220, 53, 69, 0.85)";
    batchDeleteBtn.onclick = () => executeBatchDelete();

    const batchCancelBtn = document.createElement("button");
    batchCancelBtn.id = "wp-asset-batch-cancel-btn";
    batchCancelBtn.textContent = "✕ 取消";
    batchCancelBtn.title = "退出多选模式";
    batchCancelBtn.style.cssText = `
        padding: 3px 12px;
        height: 24px;
        background: rgba(128, 128, 128, 0.5);
        border: none;
        border-radius: 6px;
        color: #fff;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
        transition: background 0.2s;
        margin-left: auto;
    `;
    batchCancelBtn.onmouseover = () => batchCancelBtn.style.background = "rgba(128, 128, 128, 0.7)";
    batchCancelBtn.onmouseout = () => batchCancelBtn.style.background = "rgba(128, 128, 128, 0.5)";
    batchCancelBtn.onclick = () => exitMultiSelectMode();

    batchToolbar.appendChild(batchCount);
    batchToolbar.appendChild(batchMoveBtn);
    batchToolbar.appendChild(batchDeleteBtn);
    batchToolbar.appendChild(batchCancelBtn);

    // 资产网格容器
    const assetGrid = document.createElement("div");
    assetGrid.id = "wp-asset-grid";
    assetGrid.className = "wp-asset-grid";
    assetGrid.style.cssText = `
        flex: 1;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 8px;
        overflow-y: auto;
        padding: 5px;
    `;

    // 多选模式下点击网格空白区域退出
    assetGrid.addEventListener("click", (e) => {
        if (multiSelectMode && e.target === assetGrid) {
            exitMultiSelectMode();
        }
    });

    mainContent.appendChild(toolbar);
    mainContent.appendChild(batchToolbar);
    mainContent.appendChild(assetGrid);

    // 详情视图容器（点击素材查看详情时显示，网格隐藏；返回后列表原样恢复）
    const detailContainer = document.createElement("div");
    detailContainer.id = "wp-asset-detail";
    detailContainer.style.cssText = `
        flex: 1;
        display: none;
        flex-direction: column;
        overflow: hidden;
        min-height: 0;
    `;
    mainContent.appendChild(detailContainer);

    content.appendChild(sidebar);
    content.appendChild(mainContent);

    panel.appendChild(header);
    panel.appendChild(content);

    // 添加样式
    addAssetPanelStyles();

    // 添加到页面
    document.body.appendChild(panel);
    assetPanelElement = panel;

    // ESC 退出多选模式（输入框聚焦时不触发）
    if (!document.getElementById("wp-asset-multi-select-bound")) {
        const escMarker = document.createElement("div");
        escMarker.id = "wp-asset-multi-select-bound";
        escMarker.style.display = "none";
        document.body.appendChild(escMarker);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && multiSelectMode) {
                const active = document.activeElement;
                if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
                exitMultiSelectMode();
            }
        });
    }

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
        /* 分类拖拽排序：拖起项半透明，目标位置显示紫色插入线 */
        .wp-asset-category.wp-cat-draggable {
            position: relative;
            cursor: grab;
        }
        .wp-asset-category.wp-cat-draggable:active {
            cursor: grabbing;
        }
        .wp-asset-category.wp-cat-dragging {
            opacity: 0.4;
        }
        .wp-asset-category.wp-cat-drop-before::before,
        .wp-asset-category.wp-cat-drop-after::after {
            content: "";
            position: absolute;
            left: 8px;
            right: 8px;
            height: 2px;
            background: #662ad5;
            border-radius: 1px;
            box-shadow: 0 0 6px rgba(102, 42, 213, 0.9);
            pointer-events: none;
        }
        .wp-asset-category.wp-cat-drop-before::before { top: -1px; }
        .wp-asset-category.wp-cat-drop-after::after { bottom: -1px; }
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
            position: relative;
        }
        .wp-asset-item:hover {
            transform: scale(1.03);
            border-color: #662ad5;
            box-shadow: 0 4px 12px rgba(102, 42, 213, 0.3);
        }
        .wp-asset-checkbox {
            position: absolute;
            top: 4px;
            right: 4px;
            width: 18px;
            height: 18px;
            border: 2px solid rgba(255, 255, 255, 0.85);
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.45);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 10;
            pointer-events: none;
        }
        .wp-multi-select-mode .wp-asset-checkbox {
            display: flex;
        }
        .wp-asset-checkbox svg {
            display: none;
        }
        .wp-asset-item.wp-asset-selected .wp-asset-checkbox {
            background: #662ad5;
            border-color: #662ad5;
        }
        .wp-asset-item.wp-asset-selected .wp-asset-checkbox svg {
            display: block;
        }
        .wp-asset-item.wp-asset-selected {
            border-color: #662ad5;
            box-shadow: 0 0 0 2px rgba(102, 42, 213, 0.55);
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

// 校准素材库与文件系统（同步磁盘上的改名/删除），失败时静默忽略不打扰用户
async function syncFilesystem() {
    try {
        const response = await fetch(`${ASSET_API_BASE}/sync_fs`, { method: 'POST' });
        const result = await response.json();
        if (result.success) {
            if (result.renamed > 0 || result.removed > 0) {
                console.log(`[WP资产库] 文件系统校准: 改名 ${result.renamed} 个, 移除失效 ${result.removed} 个`);
            }
        } else {
            console.warn("[WP资产库] 文件系统校准失败:", result.error);
        }
    } catch (error) {
        console.warn("[WP资产库] 文件系统校准请求失败:", error);
    }
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
        // 每次打开面板时先校准文件系统（同步磁盘改名/删除），再刷新数据
        syncFilesystem().finally(() => loadProjects());
    } else {
        assetPanelElement.style.display = "none";
        assetPanelVisible = false;
    }
}

// ========== 项目管理 ==========

// 加载项目列表
async function loadProjects() {
    try {
        // 并行获取项目列表与输出文件夹配置（输出配置失败不阻塞项目加载）
        const [projResp, outResp] = await Promise.all([
            fetch(`${ASSET_API_BASE}/projects`),
            fetch(`${ASSET_API_BASE}/output/config`).catch(() => null)
        ]);
        const projects = await projResp.json();
        let outputConfig = null;
        if (outResp && outResp.ok) {
            try { outputConfig = await outResp.json(); } catch (e) {}
        }

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

        // 已配置输出文件夹时，在末尾追加虚拟项目
        const outputReady = !!(outputConfig && outputConfig.configured);
        if (outputReady) {
            const option = document.createElement("option");
            option.value = WP_OUTPUT_PROJECT_ID;
            option.textContent = "📤 ComfyUI 输出";
            projectSelect.appendChild(option);
        }

        // 恢复选中值或默认选第一个
        if (currentVal === WP_OUTPUT_PROJECT_ID && outputReady) {
            projectSelect.value = WP_OUTPUT_PROJECT_ID;
            selectProject(WP_OUTPUT_PROJECT_ID);
        } else if (currentVal && projects.find(p => p.id === currentVal)) {
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
    exitDetailView(); // 切换项目时退出详情视图，恢复列表
    exitMultiSelectMode(); // 切换项目时退出多选模式（选中集合跨项目无意义）
    currentProjectId = projectId;
    currentCategoryId = null;

    // 更新下拉框选中状态
    const projectSelect = document.getElementById("wp-asset-project-select");
    if (projectSelect) {
        projectSelect.value = projectId;
    }

    // 输出文件夹虚拟项目：进入输出视图
    if (projectId === WP_OUTPUT_PROJECT_ID) {
        setOutputViewMode(true);
        await loadOutputCategories();
        return;
    }

    setOutputViewMode(false);

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

// ========== ComfyUI 输出文件夹（虚拟项目） ==========

// 输出视图模式切换：隐藏素材库专属按钮（新建项目/分类、改名、删除、上传、多选），保留搜索/排序/刷新
function setOutputViewMode(isOutput) {
    outputViewEnabled = isOutput;
    if (isOutput) exitMultiSelectMode(); // 输出视图只读，不允许多选批量操作
    const hideIds = [
        "wp-asset-new-project-btn",
        "wp-asset-new-category-btn",
        "wp-asset-rename-project-btn",
        "wp-asset-delete-project-btn",
        "wp-asset-upload-btn",
        "wp-asset-multi-select-btn",
    ];
    hideIds.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.style.display = isOutput ? "none" : "";
    });
    if (!isOutput) currentOutputFilter = "all";
}

// 加载输出视图：左侧"分类" = 全部/图片/视频/音频/文字 固定分类；右侧 = 文件网格
async function loadOutputCategories(keepFilter = false) {
    try {
        const response = await fetch(`${ASSET_API_BASE}/output/list`);
        const data = await response.json();

        const catList = document.getElementById("wp-asset-categories");
        if (!catList) return;

        if (!data.success) {
            catList.innerHTML = "";
            const grid = document.getElementById("wp-asset-grid");
            if (grid) grid.innerHTML = `<div style='color:#c66; text-align:center; padding:50px;'>⚠ ${data.error || "读取输出文件夹失败"}</div>`;
            return;
        }

        if (!keepFilter) currentOutputFilter = "all";

        // 缓存全量文件（分类筛选与计数的数据源）
        outputAllFiles = data.files || [];
        outputListMeta = { truncated: data.truncated, total: data.total, max_files: data.max_files };

        // 左侧固定分类条目（计数从缓存按 file_type 统计）
        catList.innerHTML = "";
        OUTPUT_FILTERS.forEach(f => {
            const count = f.key === "all"
                ? outputAllFiles.length
                : outputAllFiles.filter(x => (x.file_type || "image") === f.key).length;
            const el = document.createElement("div");
            el.className = "wp-asset-category" + (currentOutputFilter === f.key ? " active" : "");
            el.dataset.filter = f.key;
            const nameSpan = document.createElement("span");
            nameSpan.textContent = `${f.icon} ${f.name}`;
            nameSpan.style.cssText = "flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
            const countSpan = document.createElement("span");
            countSpan.textContent = count;
            countSpan.style.cssText = "font-size: 10px; color: #888;";
            el.appendChild(nameSpan);
            el.appendChild(countSpan);
            el.onclick = () => selectOutputFilter(f.key);
            catList.appendChild(el);
        });

        renderOutputFiltered();
    } catch (error) {
        console.error("[WP资产库] 加载输出文件夹失败:", error);
    }
}

// 按当前分类筛选缓存并渲染右侧网格
function renderOutputFiltered() {
    const files = currentOutputFilter === "all"
        ? outputAllFiles
        : outputAllFiles.filter(f => (f.file_type || "image") === currentOutputFilter);
    // 截断提示仅对"全部"分类有意义（类型分类下的计数是全量截断后的子集）
    const payload = { files };
    if (currentOutputFilter === "all" && outputListMeta) {
        payload.truncated = outputListMeta.truncated;
        payload.total = outputListMeta.total;
        payload.max_files = outputListMeta.max_files;
    }
    renderOutputFiles(payload);
}

// 选择输出分类（纯前端过滤缓存数据，零延迟）
function selectOutputFilter(key) {
    exitDetailView(); // 切换分类时退出详情视图，恢复列表
    currentOutputFilter = key;
    document.querySelectorAll('.wp-asset-category').forEach(el => {
        el.classList.toggle('active', el.dataset.filter === key);
    });
    renderOutputFiltered();
}

// 重新请求输出文件列表（query 为搜索词），再按当前分类筛选渲染
async function loadOutputFiles(query = "") {
    try {
        let url = `${ASSET_API_BASE}/output/list`;
        if (query) url += `?q=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        const data = await response.json();

        if (!data.success) {
            const grid = document.getElementById("wp-asset-grid");
            if (grid) grid.innerHTML = `<div style='color:#c66; text-align:center; padding:50px;'>⚠ ${data.error || "读取失败"}</div>`;
            return;
        }
        outputAllFiles = data.files || [];
        outputListMeta = { truncated: data.truncated, total: data.total, max_files: data.max_files };
        renderOutputFiltered();
    } catch (error) {
        console.error("[WP资产库] 加载输出文件失败:", error);
    }
}

// 渲染输出文件网格（默认最新优先，可用排序按钮切换名称排序）
function renderOutputFiles(data) {
    const grid = document.getElementById("wp-asset-grid");
    if (!grid) return;
    grid.innerHTML = "";

    const files = (data.files || []).slice();

    if (files.length === 0) {
        outputListCache = [];
        grid.innerHTML = "<div style='color:#888; text-align:center; padding:50px;'>暂无输出文件<br><span style='font-size:11px;color:#666;'>运行工作流生成图片/视频后，这里会实时更新</span></div>";
        return;
    }

    if (assetSortMode === 'asc') {
        files.sort((a, b) => (a.file_name || "").localeCompare(b.file_name || ""));
    } else if (assetSortMode === 'desc') {
        files.sort((a, b) => (b.file_name || "").localeCompare(a.file_name || ""));
    }

    // 缓存当前列表（详情页图片左右切换的数据源，顺序与显示一致）
    outputListCache = files;

    files.forEach(file => {
        const item = document.createElement("div");
        item.className = "wp-asset-item";
        item.draggable = true;

        const fileType = file.file_type || "image";
        const relPath = file.rel_path || "";
        const fileUrl = `${ASSET_API_BASE}/output/file?path=${encodeURIComponent(relPath)}`;

        const thumbDiv = document.createElement("div");
        thumbDiv.className = "wp-asset-thumb";

        if (fileType === "image") {
            thumbDiv.style.backgroundImage = `url("${ASSET_API_BASE}/output/thumbnail?path=${encodeURIComponent(relPath)}&t=${encodeURIComponent(file.modified_time || "")}")`;
        } else if (fileType === "video") {
            thumbDiv.style.position = "relative";
            thumbDiv.style.overflow = "hidden";
            thumbDiv.style.background = "#000";
            thumbDiv.style.cursor = "pointer";

            const video = document.createElement("video");
            video.muted = true;
            video.loop = true;
            video.preload = "metadata";
            video.playsInline = true;
            video.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
            video.src = fileUrl;
            thumbDiv.appendChild(video);

            // hover 控件层：放大 + 播放/暂停 + 静音
            const controls = document.createElement("div");
            controls.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                display: flex; flex-direction: column; justify-content: space-between;
                opacity: 0; transition: opacity 0.2s;
            `;

            const topBar = document.createElement("div");
            topBar.style.cssText = "display:flex;justify-content:flex-end;padding:2px;";
            const enlargeBtn = document.createElement("button");
            enlargeBtn.innerHTML = "🔍";
            enlargeBtn.title = "放大预览";
            enlargeBtn.style.cssText = `
                background: rgba(0,0,0,0.5); border: none; color: #fff;
                width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
                font-size: 12px; display: flex; align-items: center; justify-content: center;
            `;
            enlargeBtn.onclick = (e) => {
                e.stopPropagation();
                showVideoPreview(null, file.name, fileUrl);
            };
            topBar.appendChild(enlargeBtn);

            // 详情按钮：进入输出文件详情页
            const detailBtn = document.createElement("button");
            detailBtn.innerHTML = "ⓘ";
            detailBtn.title = "查看详情";
            detailBtn.style.cssText = `
                background: rgba(0,0,0,0.5); border: none; color: #fff;
                width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
                font-size: 13px; display: flex; align-items: center; justify-content: center;
            `;
            detailBtn.onclick = (e) => {
                e.stopPropagation();
                showOutputDetail(file);
            };
            topBar.appendChild(detailBtn);

            const midBar = document.createElement("div");
            midBar.style.cssText = "display:flex;justify-content:center;align-items:center;flex:1;";
            const playBtn = document.createElement("button");
            playBtn.innerHTML = "▶";
            playBtn.style.cssText = `
                background: rgba(0,0,0,0.5); border: none; color: #fff;
                width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
                font-size: 14px; display: flex; align-items: center; justify-content: center;
            `;
            midBar.appendChild(playBtn);

            const botBar = document.createElement("div");
            botBar.style.cssText = "display:flex;justify-content:flex-end;padding:2px;";
            const muteBtn = document.createElement("button");
            muteBtn.innerHTML = "🔇";
            muteBtn.title = "取消静音";
            muteBtn.style.cssText = `
                background: rgba(0,0,0,0.5); border: none; color: #fff;
                width: 20px; height: 20px; border-radius: 4px; cursor: pointer;
                font-size: 10px; display: flex; align-items: center; justify-content: center;
            `;
            botBar.appendChild(muteBtn);

            controls.appendChild(topBar);
            controls.appendChild(midBar);
            controls.appendChild(botBar);
            thumbDiv.appendChild(controls);

            thumbDiv.onmouseenter = () => { controls.style.opacity = "1"; };
            thumbDiv.onmouseleave = () => { controls.style.opacity = "0"; };

            let isPlaying = false;
            const togglePlay = () => {
                if (isPlaying) {
                    video.pause();
                    playBtn.innerHTML = "▶";
                } else {
                    video.play().catch(() => {});
                    playBtn.innerHTML = "⏸";
                }
                isPlaying = !isPlaying;
            };
            playBtn.onclick = (e) => { e.stopPropagation(); togglePlay(); };
            thumbDiv.onclick = () => togglePlay();

            muteBtn.onclick = (e) => {
                e.stopPropagation();
                video.muted = !video.muted;
                muteBtn.innerHTML = video.muted ? "🔇" : "🔊";
                muteBtn.title = video.muted ? "取消静音" : "静音";
            };

            thumbDiv._videoEl = video;
        } else {
            thumbDiv.style.display = "flex";
            thumbDiv.style.alignItems = "center";
            thumbDiv.style.justifyContent = "center";

            let icon = "📄", typeLabel = "文件";
            if (fileType === "audio") { icon = "🎵"; typeLabel = "音频"; }
            else if (fileType === "text") { icon = "📝"; typeLabel = "文本"; }

            thumbDiv.innerHTML = `<div style="text-align:center;"><div style="font-size:36px;">${icon}</div><div style="font-size:10px;color:#888;margin-top:4px;">${typeLabel}</div><div style="font-size:9px;color:#666;">${file.file_ext || ""}</div></div>`;
        }

        const infoDiv = document.createElement("div");
        infoDiv.className = "wp-asset-info";
        infoDiv.textContent = file.file_name || file.name;

        item.appendChild(thumbDiv);
        item.appendChild(infoDiv);

        // 拖拽：携带输出文件标识，drop 处理器按 wp_output 分支走 /output/* 接口
        item.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("application/x-wp-asset", JSON.stringify({
                type: "wp_output",
                path: relPath,
                fileName: file.file_name,
                fileType: fileType
            }));
            e.dataTransfer.setData("text/plain", file.file_name || file.name);
            e.dataTransfer.effectAllowed = "copy";
        });

        // 右键菜单：视频=复制帧+复制文件，其他类型=复制到剪贴板
        item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showOutputContextMenu(e, file, thumbDiv._videoEl);
        });

        // 点击行为（单击=查看详情，双击=快捷操作；视频详情走 hover 控件 ⓘ 按钮）
        if (fileType === "image") {
            item.onclick = () => scheduleOutputDetail(file);
            item.ondblclick = () => { cancelScheduledDetail(); exportOutputToCanvas(relPath); };
        } else if (fileType === "video") {
            // 播放/暂停与放大已在 thumbDiv 内处理
        } else if (fileType === "audio") {
            item.onclick = () => showOutputDetail(file);
        } else if (fileType === "text") {
            item.onclick = () => scheduleOutputDetail(file);
            item.ondblclick = () => { cancelScheduledDetail(); showOutputTextPreview(file.name, relPath); };
        }

        grid.appendChild(item);
    });

    // 超量截断提示
    if (data.truncated) {
        const notice = document.createElement("div");
        notice.style.cssText = "grid-column: 1 / -1; color:#888; text-align:center; padding:8px; font-size:11px;";
        notice.textContent = `仅显示最新的 ${data.max_files} 个文件（共 ${data.total} 个）`;
        grid.appendChild(notice);
    }
}

// 输出文本只读预览
async function showOutputTextPreview(name, relPath) {
    closeAllPreviews();
    let content = "", errorMsg = "";
    try {
        const resp = await fetch(`${ASSET_API_BASE}/output/text?path=${encodeURIComponent(relPath)}`);
        const data = await resp.json();
        if (data.success) {
            content = data.content || "";
        } else {
            errorMsg = data.error || "未知错误";
        }
    } catch (e) {
        errorMsg = e.message;
    }

    const overlay = document.createElement("div");
    overlay.className = "wp-preview-overlay";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.7); z-index: 10002;
        display: flex; align-items: center; justify-content: center;
    `;

    const container = document.createElement("div");
    container.style.cssText = `
        background: #2a2a2a; border-radius: 12px; width: 640px; max-width: 90vw;
        max-height: 80vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid #444;
    `;

    const header = document.createElement("div");
    header.style.cssText = `
        padding: 10px 16px; display: flex; justify-content: space-between;
        align-items: center; background: #333; border-radius: 12px 12px 0 0;
    `;
    const titleSpan = document.createElement("span");
    titleSpan.style.color = "#fff";
    titleSpan.style.fontSize = "14px";
    titleSpan.textContent = `📝 ${name || "文本预览"}（只读）`;
    header.appendChild(titleSpan);
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "✕";
    closeBtn.style.cssText = `
        background: #555; border: none; color: #fff; width: 28px; height: 28px;
        border-radius: 50%; cursor: pointer; font-size: 14px;
    `;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    header.appendChild(closeBtn);

    const textarea = document.createElement("textarea");
    textarea.readOnly = true;
    textarea.value = errorMsg ? `读取失败: ${errorMsg}` : content;
    textarea.style.cssText = `
        flex: 1; margin: 12px 16px; padding: 12px; background: #1a1a1a;
        border: 1px solid #444; border-radius: 8px; color: #ddd;
        font-family: Consolas, Monaco, monospace; font-size: 13px;
        resize: none; min-height: 200px;
    `;

    container.appendChild(header);
    container.appendChild(textarea);
    overlay.appendChild(container);
    overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
    document.body.appendChild(overlay);
}

// 导出输出文件到画板（双击图片）
async function exportOutputToCanvas(relPath) {
    try {
        const currentApp = getApp();
        if (!currentApp) {
            alert("无法获取 ComfyUI 实例，请刷新页面重试。");
            return;
        }

        // 复制输出文件到 input 目录
        const copyResponse = await fetch(`${ASSET_API_BASE}/output/copy_to_input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPath })
        });

        if (!copyResponse.ok) {
            alert("复制输出文件失败");
            return;
        }

        const result = await copyResponse.json();

        if (result.success && result.file_name) {
            const node = LiteGraph.createNode("LoadImage");
            if (!node) {
                alert("无法创建加载图像节点。");
                return;
            }

            let posX = 100, posY = 100;
            const canvas = currentApp.canvas;
            if (canvas && canvas.graph_mouse) {
                posX = canvas.graph_mouse[0];
                posY = canvas.graph_mouse[1];
            }
            node.pos = [posX, posY];
            currentApp.graph.add(node);

            setTimeout(() => {
                if (node.widgets) {
                    for (let i = 0; i < node.widgets.length; i++) {
                        const widget = node.widgets[i];
                        if (widget.name === "image") {
                            widget.value = result.file_name;
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
            alert("导出输出文件失败: " + (result.error || "未知错误"));
        }
    } catch (error) {
        console.error("[WP资产库] 导出输出文件失败:", error);
        alert("导出输出文件失败: " + error.message);
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

// 修改当前项目名称
async function renameCurrentProject() {
    if (!currentProjectId) {
        alert("请先选择一个项目！");
        return;
    }
    
    const projSelect = document.getElementById("wp-asset-project-select");
    const currentName = projSelect ? projSelect.options[projSelect.selectedIndex]?.text : "当前项目";
    
    const newName = prompt("请输入新的项目名称：", currentName);
    if (!newName || !newName.trim()) return;
    
    try {
        const response = await fetch(`${ASSET_API_BASE}/projects/${encodeURIComponent(currentProjectId)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // 刷新项目列表并自动选中当前项目
            await loadProjects();
            // 重新选中当前项目（刷新后下拉框值会变回默认，需要重新设置）
            const newSelect = document.getElementById("wp-asset-project-select");
            if (newSelect) {
                newSelect.value = currentProjectId;
            }
        } else {
            alert("重命名失败: " + (result.error || "未知错误"));
        }
    } catch (error) {
        console.error('[WP资产库] 重命名项目失败:', error);
        alert("重命名失败: " + error.message);
    }
}

// ========== 素材详情视图（面板内 列表 ↔ 详情 切换） ==========

// 单击详情延迟打开（与双击快捷操作共存：250ms 内双击则取消详情、执行快捷操作）
let detailClickTimer = null;

function scheduleAssetDetail(asset) {
    clearTimeout(detailClickTimer);
    detailClickTimer = setTimeout(() => {
        detailClickTimer = null;
        showAssetDetail(asset);
    }, 250);
}

function scheduleOutputDetail(file) {
    clearTimeout(detailClickTimer);
    detailClickTimer = setTimeout(() => {
        detailClickTimer = null;
        showOutputDetail(file);
    }, 250);
}

function cancelScheduledDetail() {
    if (detailClickTimer) {
        clearTimeout(detailClickTimer);
        detailClickTimer = null;
    }
}

// 进入详情视图：隐藏网格、清空并显示详情容器（列表 DOM 完整保留，返回即时恢复）
function enterDetailView() {
    const grid = document.getElementById("wp-asset-grid");
    const detail = document.getElementById("wp-asset-detail");
    if (!grid || !detail) return;
    grid.style.display = "none";
    detail.style.display = "flex";
    detail.innerHTML = "";
}

// 退出详情视图，恢复列表（滚动位置与内容原样保留）
function exitDetailView() {
    const grid = document.getElementById("wp-asset-grid");
    const detail = document.getElementById("wp-asset-detail");
    if (!grid || !detail) return;
    if (detail.style.display === "none") return;
    detail.style.display = "none";
    detail.innerHTML = ""; // 释放视频/音频等媒体元素
    grid.style.display = "grid";
}

// 素材库资产 → 详情
function showAssetDetail(asset) {
    if (!asset) return;
    const projName = (projectsCache.find(p => String(p.id) === String(currentProjectId)) || {}).name || "未知项目";
    const catEl = document.querySelector("#wp-asset-categories .wp-asset-category.active span:first-child");
    const catName = catEl ? catEl.textContent : "未知分类";

    // 图片序列导航：取当前列表中的图片资产（顺序与列表显示一致）
    let nav = null;
    const images = assetListCache.filter(a => (a.file_type || "image") === "image");
    const idx = images.findIndex(a => String(a.id) === String(asset.id));
    if (idx >= 0 && images.length > 1) {
        nav = {
            index: idx,
            count: images.length,
            go: (i) => showAssetDetail(images[i]),
            prevUrl: idx > 0 ? `${ASSET_API_BASE}/file/${images[idx - 1].id}` : null,
            nextUrl: idx < images.length - 1 ? `${ASSET_API_BASE}/file/${images[idx + 1].id}` : null,
        };
    }

    renderDetailView({
        kind: "asset",
        id: asset.id,
        name: asset.name || asset.file_name,
        fileType: asset.file_type || "image",
        fileExt: asset.file_ext || "",
        fileSize: asset.file_size,
        timeLabel: "上传时间",
        timeValue: asset.upload_time || null,
        locationLabel: "所属位置",
        locationValue: projName + " › " + catName,
        description: asset.description || "",
        mediaUrl: `${ASSET_API_BASE}/file/${asset.id}`,
        textUrl: `${ASSET_API_BASE}/text/${asset.id}`,
        nav: nav,
    });
}

// 输出文件夹文件 → 详情
function showOutputDetail(file) {
    if (!file) return;
    const rel = file.rel_path || "";
    const folder = rel.includes("/") ? rel.split("/").slice(0, -1).join(" › ") : "";

    // 图片序列导航：取当前列表中的图片文件（顺序与列表显示一致）
    let nav = null;
    const images = outputListCache.filter(f => (f.file_type || "image") === "image");
    const idx = images.findIndex(f => (f.rel_path || "") === rel);
    if (idx >= 0 && images.length > 1) {
        const urlOf = (f) => `${ASSET_API_BASE}/output/file?path=${encodeURIComponent(f.rel_path || "")}`;
        nav = {
            index: idx,
            count: images.length,
            go: (i) => showOutputDetail(images[i]),
            prevUrl: idx > 0 ? urlOf(images[idx - 1]) : null,
            nextUrl: idx < images.length - 1 ? urlOf(images[idx + 1]) : null,
        };
    }

    renderDetailView({
        kind: "output",
        relPath: rel,
        name: file.file_name || file.name,
        fileType: file.file_type || "image",
        fileExt: file.file_ext || "",
        fileSize: file.file_size,
        timeLabel: "修改时间",
        timeValue: file.modified_time || null,
        locationLabel: "输出位置",
        locationValue: "📤 ComfyUI 输出" + (folder ? " › " + folder : ""),
        description: "",
        mediaUrl: `${ASSET_API_BASE}/output/file?path=${encodeURIComponent(rel)}`,
        textUrl: `${ASSET_API_BASE}/output/text?path=${encodeURIComponent(rel)}`,
        nav: nav,
    });
}

// 通用详情渲染（顶部返回栏 + 按类型差异化的预览区 + 信息区 + 操作按钮）
async function renderDetailView(cfg) {
    enterDetailView();
    const detail = document.getElementById("wp-asset-detail");
    if (!detail) return;

    // ---- 顶部栏：返回按钮 + 标题 ----
    const header = document.createElement("div");
    header.style.cssText = `
        display: flex; align-items: center; gap: 10px;
        padding: 0 0 12px 0; border-bottom: 1px solid #333; flex-shrink: 0;
    `;
    const backBtn = document.createElement("button");
    backBtn.textContent = "← 返回列表";
    backBtn.title = "返回素材列表";
    backBtn.style.cssText = `
        padding: 5px 14px; background: rgba(128,128,128,0.3); border: none;
        border-radius: 16px; color: #fff; cursor: pointer; font-size: 12px;
        white-space: nowrap; transition: background 0.2s; flex-shrink: 0;
    `;
    backBtn.onmouseenter = () => backBtn.style.background = "rgba(102, 42, 213, 0.6)";
    backBtn.onmouseleave = () => backBtn.style.background = "rgba(128,128,128,0.3)";
    backBtn.onclick = exitDetailView;

    const typeIcons = { image: "🖼️", video: "🎬", audio: "🎵", text: "📝" };
    const titleEl = document.createElement("div");
    titleEl.style.cssText = `
        color: #fff; font-size: 14px; font-weight: 600; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; flex: 1;
    `;
    titleEl.textContent = (typeIcons[cfg.fileType] || "📄") + " " + cfg.name;
    header.appendChild(backBtn);
    header.appendChild(titleEl);
    detail.appendChild(header);

    // ---- 内容滚动区 ----
    const scroll = document.createElement("div");
    scroll.style.cssText = "flex: 1; overflow-y: auto; min-height: 0;";
    detail.appendChild(scroll);

    // ---- 预览区（按类型差异化展示） ----
    const preview = document.createElement("div");
    preview.style.cssText = `
        display: flex; align-items: center; justify-content: center;
        background: #1a1a1a; border-radius: 10px; margin: 12px 0;
        min-height: 180px; max-height: 46vh; overflow: hidden;
        position: relative;
    `;

    if (cfg.fileType === "image") {
        const img = document.createElement("img");
        img.src = cfg.mediaUrl;
        img.alt = cfg.name;
        img.style.cssText = `
            max-width: 100%; max-height: 46vh; object-fit: contain;
            cursor: zoom-in; display: block;
        `;
        img.onclick = () => showImageFullscreen(cfg.mediaUrl, cfg.name);
        preview.appendChild(img);

        // 图片序列导航：左右切换按钮 + 相邻图片预加载（切换无白屏）
        if (cfg.nav) {
            if (cfg.nav.prevUrl) { const pre = new Image(); pre.src = cfg.nav.prevUrl; }
            if (cfg.nav.nextUrl) { const pre = new Image(); pre.src = cfg.nav.nextUrl; }

            const makeNavBtn = (dir) => {
                const atEdge = (dir === -1 && cfg.nav.index === 0) || (dir === 1 && cfg.nav.index === cfg.nav.count - 1);
                const b = document.createElement("button");
                b.innerHTML = dir === -1 ? "<" : ">";
                b.title = dir === -1 ? "上一张" : "下一张";
                b.style.cssText = `
                    position: absolute; ${dir === -1 ? "left: 8px" : "right: 8px"}; top: 50%;
                    transform: translateY(-50%);
                    width: 36px; height: 36px; border-radius: 50%;
                    background: rgba(0,0,0,0.5); border: none; color: #fff;
                    font-size: 17px; font-weight: bold; cursor: ${atEdge ? "default" : "pointer"};
                    z-index: 5; display: flex; align-items: center; justify-content: center;
                    opacity: ${atEdge ? 0.15 : 0.8};
                    transition: opacity 0.2s, background 0.2s;
                    padding: 0; line-height: 1; flex-shrink: 0;
                `;
                if (!atEdge) {
                    b.onmouseenter = () => { b.style.opacity = "1"; b.style.background = "rgba(102, 42, 213, 0.8)"; };
                    b.onmouseleave = () => { b.style.opacity = "0.8"; b.style.background = "rgba(0,0,0,0.5)"; };
                    b.onclick = (e) => {
                        e.stopPropagation();
                        cfg.nav.go(cfg.nav.index + dir);
                    };
                }
                return b;
            };
            preview.appendChild(makeNavBtn(-1));
            preview.appendChild(makeNavBtn(1));
        }
    } else if (cfg.fileType === "video") {
        const video = document.createElement("video");
        video.controls = true;
        video.preload = "metadata";
        video.src = cfg.mediaUrl;
        video.style.cssText = "max-width: 100%; max-height: 46vh; display: block;";
        preview.appendChild(video);

        // 素材库视频遇浏览器不支持的格式时自动转码（输出视图只读不转码）
        if (!cfg.mediaUrl.includes("/output/")) {
            const tcTip = document.createElement("div");
            tcTip.style.cssText = "display:none;padding:6px 10px;color:#c9a6ff;font-size:12px;";
            const tryTranscode = () => handleVideoTranscode(video, cfg.id, tcTip);
            video.addEventListener("error", tryTranscode);
            // HEVC 等编码音频能播、画面解不了，浏览器不报 error，需检测画面宽度为 0
            video.addEventListener("loadedmetadata", () => {
                if (video.videoWidth === 0) tryTranscode();
            });
            preview.appendChild(tcTip);
        }

        // 倍速选择：悬浮控件，切换即时生效且保持播放位置；退出详情销毁元素即重置为1x
        const rates = [0.5, 1, 1.5, 2];
        let currentRate = 1;

        const rateBtn = document.createElement("button");
        rateBtn.textContent = "1x";
        rateBtn.title = "播放倍速";
        rateBtn.style.cssText = `
            position: absolute; top: 8px; right: 8px; z-index: 5;
            padding: 3px 10px; border-radius: 12px; border: none;
            background: rgba(0,0,0,0.55); color: #fff;
            font-size: 12px; font-weight: 600; cursor: pointer;
            transition: background 0.2s; line-height: 1.4;
        `;

        const rateMenu = document.createElement("div");
        rateMenu.style.cssText = `
            position: absolute; top: 36px; right: 8px; z-index: 6;
            background: rgba(25,25,30,0.95); border-radius: 8px;
            padding: 4px; display: none; flex-direction: column;
            min-width: 64px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.12);
        `;

        const applyRate = (rate) => {
            currentRate = rate;
            video.playbackRate = rate;
            rateBtn.textContent = rate + "x";
            [...rateMenu.children].forEach(item => {
                const on = parseFloat(item.dataset.rate) === rate;
                item.style.background = on ? "rgba(102, 42, 213, 0.85)" : "transparent";
                item.style.color = on ? "#fff" : "#ccc";
                item.style.fontWeight = on ? "700" : "400";
            });
            rateMenu.style.display = "none";
        };

        rates.forEach(r => {
            const item = document.createElement("div");
            item.textContent = r + "x";
            item.dataset.rate = r;
            item.style.cssText = `
                padding: 5px 12px; border-radius: 5px; font-size: 12px;
                cursor: pointer; text-align: center; white-space: nowrap;
                transition: background 0.15s;
            `;
            item.onmouseenter = () => { if (parseFloat(item.dataset.rate) !== currentRate) item.style.background = "rgba(255,255,255,0.08)"; };
            item.onmouseleave = () => { if (parseFloat(item.dataset.rate) !== currentRate) item.style.background = "transparent"; };
            item.onclick = (e) => { e.stopPropagation(); applyRate(r); };
            rateMenu.appendChild(item);
        });
        applyRate(1); // 初始化按钮文字与列表高亮

        rateBtn.onclick = (e) => {
            e.stopPropagation();
            rateMenu.style.display = rateMenu.style.display === "none" ? "flex" : "none";
        };
        preview.appendChild(rateBtn);
        preview.appendChild(rateMenu);

        // 点击其他区域收起倍速列表；详情已关闭则自我清理监听
        const closeRateMenu = (e) => {
            if (!rateMenu.isConnected) {
                document.removeEventListener("click", closeRateMenu);
                return;
            }
            if (!rateMenu.contains(e.target) && e.target !== rateBtn) rateMenu.style.display = "none";
        };
        document.addEventListener("click", closeRateMenu);
    } else if (cfg.fileType === "audio") {
        const box = document.createElement("div");
        box.style.cssText = "text-align:center; padding: 20px 30px;";
        const icon = document.createElement("div");
        icon.style.fontSize = "56px";
        icon.textContent = "🎵";
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = cfg.mediaUrl;
        audio.style.cssText = "width: 100%; max-width: 320px; margin: 12px auto 0; display: block;";
        box.appendChild(icon);
        box.appendChild(audio);
        preview.appendChild(box);
    } else if (cfg.fileType === "text") {
        const textBody = document.createElement("div");
        textBody.style.cssText = `
            width: 100%; height: 46vh; overflow: auto; padding: 14px;
            font-family: Consolas, Monaco, monospace; font-size: 12px;
            color: #ccc; white-space: pre-wrap; word-break: break-all;
            text-align: left; box-sizing: border-box;
        `;
        textBody.textContent = "⏳ 正在读取内容…";
        preview.appendChild(textBody);
        try {
            const resp = await fetch(cfg.textUrl);
            const data = await resp.json();
            textBody.textContent = (data.success && data.content !== undefined)
                ? data.content
                : ("读取失败: " + (data.error || "未知错误"));
        } catch (e) {
            textBody.textContent = "读取失败: " + e.message;
        }
    } else {
        const box = document.createElement("div");
        box.style.cssText = "text-align:center; padding: 40px 20px;";
        const icon = document.createElement("div");
        icon.style.fontSize = "56px";
        icon.textContent = "📄";
        const tip = document.createElement("div");
        tip.style.cssText = "color:#888;font-size:12px;margin-top:8px;";
        tip.textContent = "该类型暂不支持预览";
        box.appendChild(icon);
        box.appendChild(tip);
        preview.appendChild(box);
    }
    scroll.appendChild(preview);

    // ---- 信息区 ----
    const info = document.createElement("div");
    info.style.cssText = "padding: 4px 2px 10px 2px;";

    const typeNames = { image: "图片", video: "视频", audio: "音频", text: "文本" };
    const rows = [
        ["类型", (typeNames[cfg.fileType] || "文件") + (cfg.fileExt ? " (" + cfg.fileExt + ")" : "")],
        ["大小", (typeof cfg.fileSize === "number" && cfg.fileSize > 0) ? formatBytes(cfg.fileSize) : "未知"],
    ];
    if (cfg.timeValue) {
        let t = cfg.timeValue;
        try { t = new Date(cfg.timeValue).toLocaleString(); } catch (e) {}
        rows.push([cfg.timeLabel || "时间", t]);
    }
    rows.push([cfg.locationLabel || "位置", cfg.locationValue]);
    if (cfg.description) rows.push(["描述", cfg.description]);

    rows.forEach(pair => {
        const row = document.createElement("div");
        row.style.cssText = `
            display: flex; gap: 12px; padding: 7px 0;
            border-bottom: 1px dashed #333; font-size: 12px;
        `;
        const kEl = document.createElement("span");
        kEl.textContent = pair[0];
        kEl.style.cssText = "color: #888; width: 64px; flex-shrink: 0;";
        const vEl = document.createElement("span");
        vEl.textContent = pair[1];
        vEl.style.cssText = "color: #ddd; word-break: break-all; flex: 1;";
        row.appendChild(kEl);
        row.appendChild(vEl);
        info.appendChild(row);
    });

    // ---- 操作按钮 ----
    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap;";
    const makeBtn = (text, primary, onclick) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.cssText = primary
            ? "padding: 7px 18px; background: #662ad5; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 12px;"
            : "padding: 7px 18px; background: rgba(128,128,128,0.3); border: none; border-radius: 6px; color: #ddd; cursor: pointer; font-size: 12px;";
        b.onclick = onclick;
        return b;
    };

    if (cfg.fileType === "image") {
        actions.appendChild(makeBtn("📤 导出到画布", true, () => {
            if (cfg.kind === "output") exportOutputToCanvas(cfg.relPath);
            else exportAssetToCanvas(cfg.id);
        }));
    } else if (cfg.fileType === "text" && cfg.kind === "asset") {
        actions.appendChild(makeBtn("✏️ 编辑内容", false, () => showTextEditor(cfg.id, cfg.name)));
    } else if (cfg.fileType === "video") {
        actions.appendChild(makeBtn("🔍 全屏播放", false, () => {
            showVideoPreview(cfg.id, cfg.name, cfg.kind === "output" ? cfg.mediaUrl : null);
        }));
    }
    if (actions.children.length > 0) info.appendChild(actions);

    scroll.appendChild(info);

    // 进入/切换详情时的淡入过渡（切换图片时大图与信息区同步刷新）
    if (scroll.animate) {
        scroll.animate(
            [{ opacity: 0.25 }, { opacity: 1 }],
            { duration: 180, easing: "ease-out" }
        );
    }
}

// 图片全屏放大（点击详情大图）
function showImageFullscreen(url, name) {
    closeAllPreviews();
    const overlay = document.createElement("div");
    overlay.className = "wp-preview-overlay";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.85); z-index: 10002;
        display: flex; align-items: center; justify-content: center;
        flex-direction: column; gap: 10px;
    `;
    const img = document.createElement("img");
    img.src = url;
    img.alt = name || "";
    img.style.cssText = `
        max-width: 94vw; max-height: 88vh; object-fit: contain;
        border-radius: 4px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;
    const label = document.createElement("div");
    label.textContent = name || "";
    label.style.cssText = "color: #aaa; font-size: 12px; max-width: 90vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    overlay.appendChild(img);
    overlay.appendChild(label);
    overlay.onclick = () => document.body.removeChild(overlay);
    document.body.appendChild(overlay);
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
        
        // 绑定拖拽排序（事件委托，重复调用只生效一次）
        wpSetupCategoryDrag(catList);
        
        categories.forEach(cat => {
            const catElement = document.createElement("div");
            catElement.className = "wp-asset-category";
            if (currentCategoryId === cat.id) {
                catElement.classList.add("active");
            }
            catElement.dataset.categoryId = cat.id;
            // 支持按住拖动调整分类顺序
            catElement.draggable = true;
            catElement.classList.add("wp-cat-draggable");
            catElement.title = "按住拖动可调整顺序";
            
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
    exitDetailView(); // 切换分类时退出详情视图，恢复列表
    exitMultiSelectMode(); // 切换分类时退出多选模式（选中集合跨分类无意义）
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

// ========== 分类拖拽排序 ==========

let draggedCategoryId = null; // 当前被拖拽的分类ID

// 为分类列表绑定拖拽排序（事件委托，只在首次调用时绑定）
function wpSetupCategoryDrag(catList) {
    if (!catList || catList.dataset.wpDragBound === "1") return;
    catList.dataset.wpDragBound = "1";

    catList.addEventListener("dragstart", (e) => {
        if (outputViewEnabled) return; // 输出视图的文件夹列表不可拖拽
        const item = e.target.closest && e.target.closest(".wp-asset-category");
        if (!item) return;
        // 从删除按钮上起拖时忽略，避免误触
        if (e.target.closest && e.target.closest("button")) { e.preventDefault(); return; }
        draggedCategoryId = item.dataset.categoryId;
        item.classList.add("wp-cat-dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", draggedCategoryId); } catch (err) {}
    });

    catList.addEventListener("dragover", (e) => {
        if (!draggedCategoryId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        wpClearCategoryDropMarkers(catList);
        const overItem = e.target.closest && e.target.closest(".wp-asset-category");
        if (!overItem || overItem.dataset.categoryId === draggedCategoryId) return;
        const rect = overItem.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > rect.height / 2;
        overItem.classList.add(isAfter ? "wp-cat-drop-after" : "wp-cat-drop-before");
    });

    catList.addEventListener("drop", (e) => {
        if (!draggedCategoryId) return;
        e.preventDefault();
        const overItem = e.target.closest && e.target.closest(".wp-asset-category");
        const sourceItem = catList.querySelector(`.wp-asset-category[data-category-id="${draggedCategoryId}"]`);
        wpClearCategoryDropMarkers(catList);
        if (!overItem || !sourceItem || overItem === sourceItem) return;

        // DOM 立即重排（不重新加载列表，当前选中分类不受影响），再静默保存顺序
        const rect = overItem.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > rect.height / 2;
        if (isAfter) overItem.after(sourceItem); else overItem.before(sourceItem);
        wpSaveCategoryOrder(catList);
    });

    catList.addEventListener("dragend", () => {
        draggedCategoryId = null;
        wpClearCategoryDropMarkers(catList);
        catList.querySelectorAll(".wp-cat-dragging").forEach(el => el.classList.remove("wp-cat-dragging"));
    });
}

// 清除插入指示线
function wpClearCategoryDropMarkers(catList) {
    catList.querySelectorAll(".wp-cat-drop-before, .wp-cat-drop-after").forEach(el => {
        el.classList.remove("wp-cat-drop-before", "wp-cat-drop-after");
    });
}

// 保存拖拽后的分类顺序到服务端（保存失败只提示控制台，不影响已生效的界面顺序）
async function wpSaveCategoryOrder(catList) {
    if (!currentProjectId) return;
    const orderedIds = Array.from(catList.querySelectorAll(".wp-asset-category"))
        .map(el => el.dataset.categoryId)
        .filter(Boolean);
    if (!orderedIds.length) return;
    try {
        const response = await fetch(`${ASSET_API_BASE}/categories/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: currentProjectId, ordered_ids: orderedIds })
        });
        const text = await response.text();
        let result = null;
        try { result = JSON.parse(text); } catch (err) {}
        if (!result || !result.success) {
            console.warn("[WP资产库] 分类排序未保存（后端可能未重启）:", response.status, text.substring(0, 120));
        }
    } catch (error) {
        console.warn("[WP资产库] 分类排序保存请求失败:", error);
    }
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

        // 缓存当前列表（详情页图片左右切换的数据源，顺序与显示一致）
        assetListCache = assets;

        const grid = document.getElementById("wp-asset-grid");
        grid.innerHTML = "";

        if (assets.length === 0) {
            assetListCache = [];
            grid.innerHTML = "<div style='color:#888; text-align:center; padding:50px;'>暂无资产</div>";
            return;
        }
        
        assets.forEach(asset => {
            const assetElement = document.createElement("div");
            assetElement.className = "wp-asset-item";
            assetElement.dataset.assetId = asset.id;
            assetElement.draggable = true;
            
            const fileType = asset.file_type || "image";
            const fileExt = (asset.file_ext || "").toLowerCase();
            
            // 创建缩略图/图标区域
            const thumbDiv = document.createElement("div");
            thumbDiv.className = "wp-asset-thumb";
            
            if (fileType === "image") {
                // 图片类型：显示缩略图
                const timestamp = new Date().getTime();
                thumbDiv.style.backgroundImage = `url("${ASSET_API_BASE}/thumbnail/${asset.id}?t=${timestamp}")`;
            } else if (fileType === "video") {
                // 视频类型：嵌入静音播放器 + 控件层
                thumbDiv.style.position = "relative";
                thumbDiv.style.overflow = "hidden";
                thumbDiv.style.background = "#000";
                thumbDiv.style.cursor = "pointer";
                
                const video = document.createElement("video");
                video.muted = true;
                video.loop = true;
                video.preload = "metadata";
                video.playsInline = true;
                video.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
                video.src = `${ASSET_API_BASE}/file/${asset.id}`;
                thumbDiv.appendChild(video);

                // HEVC 等编码浏览器解不了画面且不报 error：检测画面宽度为 0，
                // 用视频首帧截图代替黑屏卡片（点放大可自动转码播放）
                const fallbackToThumb = () => {
                    if (thumbDiv._videoReplaced) return;
                    thumbDiv._videoReplaced = true;
                    video.remove();
                    thumbDiv.style.backgroundImage = `url("${ASSET_API_BASE}/video_thumbnail/${asset.id}")`;
                    thumbDiv.style.backgroundSize = "cover";
                    thumbDiv.style.backgroundPosition = "center";
                };
                video.addEventListener("loadedmetadata", () => {
                    if (video.videoWidth === 0) fallbackToThumb();
                });
                
                // 控件层
                const controls = document.createElement("div");
                controls.style.cssText = `
                    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                    display: flex; flex-direction: column; justify-content: space-between;
                    opacity: 0; transition: opacity 0.2s;
                `;
                
                // 顶部：放大按钮
                const topBar = document.createElement("div");
                topBar.style.cssText = "display:flex;justify-content:flex-end;padding:2px;";
                const enlargeBtn = document.createElement("button");
                enlargeBtn.innerHTML = "🔍";
                enlargeBtn.title = "放大预览";
                enlargeBtn.style.cssText = `
                    background: rgba(0,0,0,0.5); border: none; color: #fff;
                    width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
                    font-size: 12px; display: flex; align-items: center; justify-content: center;
                `;
                enlargeBtn.onclick = (e) => {
                e.stopPropagation();
                if (multiSelectMode) { toggleAssetSelection(asset.id); return; }
                showVideoPreview(asset.id, asset.name);
            };
            topBar.appendChild(enlargeBtn);

            // 详情按钮：进入素材详情页
            const detailBtn = document.createElement("button");
            detailBtn.innerHTML = "ⓘ";
            detailBtn.title = "查看详情";
            detailBtn.style.cssText = `
                background: rgba(0,0,0,0.5); border: none; color: #fff;
                width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
                font-size: 13px; display: flex; align-items: center; justify-content: center;
            `;
            detailBtn.onclick = (e) => {
                e.stopPropagation();
                if (multiSelectMode) { toggleAssetSelection(asset.id); return; }
                showAssetDetail(asset);
            };
            topBar.appendChild(detailBtn);
                
                // 中间：播放/暂停按钮
                const midBar = document.createElement("div");
                midBar.style.cssText = "display:flex;justify-content:center;align-items:center;flex:1;";
                const playBtn = document.createElement("button");
                playBtn.innerHTML = "▶";
                playBtn.style.cssText = `
                    background: rgba(0,0,0,0.5); border: none; color: #fff;
                    width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
                    font-size: 14px; display: flex; align-items: center; justify-content: center;
                `;
                midBar.appendChild(playBtn);
                
                // 底部：进度条 + 静音按钮
                const botBar = document.createElement("div");
                botBar.style.cssText = "display:flex;align-items:center;gap:4px;padding:2px 4px;";
                
                const progressBar = document.createElement("input");
                progressBar.type = "range";
                progressBar.min = 0;
                progressBar.max = 100;
                progressBar.value = 0;
                progressBar.style.cssText = "flex:1;height:3px;accent-color:#662ad5;cursor:pointer;margin:0;";
                
                const muteBtn = document.createElement("button");
                muteBtn.innerHTML = "🔇";
                muteBtn.title = "取消静音";
                muteBtn.style.cssText = `
                    background: rgba(0,0,0,0.5); border: none; color: #fff;
                    width: 20px; height: 20px; border-radius: 4px; cursor: pointer;
                    font-size: 10px; display: flex; align-items: center; justify-content: center;
                    flex-shrink: 0;
                `;
                
                botBar.appendChild(progressBar);
                botBar.appendChild(muteBtn);
                
                controls.appendChild(topBar);
                controls.appendChild(midBar);
                controls.appendChild(botBar);
                thumbDiv.appendChild(controls);
                
                // 事件：hover 显示控件
                thumbDiv.onmouseenter = () => { controls.style.opacity = "1"; };
                thumbDiv.onmouseleave = () => { controls.style.opacity = "0"; };
                
                // 事件：点击播放/暂停
                let isPlaying = false;
                const togglePlay = () => {
                    if (thumbDiv._videoReplaced) return; // 已替换为首帧图的卡片不播放
                    if (isPlaying) {
                        video.pause();
                        playBtn.innerHTML = "▶";
                    } else {
                        video.play().catch(() => {});
                        playBtn.innerHTML = "⏸";
                    }
                    isPlaying = !isPlaying;
                };
                
                playBtn.onclick = (e) => { e.stopPropagation(); togglePlay(); };
                thumbDiv.onclick = () => {
                    if (multiSelectMode) { toggleAssetSelection(asset.id); return; }
                    togglePlay();
                };
                
                // 事件：静音切换
                muteBtn.onclick = (e) => {
                    e.stopPropagation();
                    video.muted = !video.muted;
                    muteBtn.innerHTML = video.muted ? "🔇" : "🔊";
                    muteBtn.title = video.muted ? "取消静音" : "静音";
                };
                
                // 事件：进度条
                video.addEventListener("timeupdate", () => {
                    if (video.duration) {
                        progressBar.value = (video.currentTime / video.duration) * 100;
                    }
                });
                progressBar.oninput = (e) => {
                    e.stopPropagation();
                    if (video.duration) {
                        video.currentTime = (progressBar.value / 100) * video.duration;
                    }
                };
                
                // 浏览器不支持的视频格式：卡片内提示（点放大可自动转码播放）
                video.addEventListener("error", () => {
                    fallbackToThumb();
                    playBtn.innerHTML = "⚠";
                    playBtn.title = "浏览器不支持该视频格式，点击右上角🔍放大可自动转码播放";
                });

                // 存引用，方便销毁
                thumbDiv._videoEl = video;
            } else {
                // 非图片类型：显示类型图标
                thumbDiv.style.display = "flex";
                thumbDiv.style.alignItems = "center";
                thumbDiv.style.justifyContent = "center";
                thumbDiv.style.fontSize = "36px";
                
                let icon = "📄";
                let typeLabel = "文件";
                if (fileType === "audio") {
                    icon = "🎵";
                    typeLabel = "音频";
                } else if (fileType === "video") {
                    icon = "🎬";
                    typeLabel = "视频";
                } else if (fileType === "text") {
                    icon = "📝";
                    typeLabel = "文本";
                }
                
                thumbDiv.innerHTML = `<div style="text-align:center;"><div style="font-size:36px;">${icon}</div><div style="font-size:10px;color:#888;margin-top:4px;">${typeLabel}</div><div style="font-size:9px;color:#666;">${fileExt}</div></div>`;
            }
            
            // 创建信息区域
            const infoDiv = document.createElement("div");
            infoDiv.className = "wp-asset-info";
            infoDiv.textContent = asset.name || asset.file_name;

            assetElement.appendChild(thumbDiv);
            assetElement.appendChild(infoDiv);

            // 多选模式选择框（默认隐藏，由 grid 的 wp-multi-select-mode class 控制显示）
            const checkboxDiv = document.createElement("div");
            checkboxDiv.className = "wp-asset-checkbox";
            checkboxDiv.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7.5l3.5 3.5L12 3.5"/></svg>`;
            assetElement.appendChild(checkboxDiv);

            // 拖拽事件（多选模式下禁用）
            assetElement.addEventListener("dragstart", (e) => {
                if (multiSelectMode) { e.preventDefault(); return; }
                e.dataTransfer.setData("application/x-wp-asset", JSON.stringify({
                    type: "wp_asset",
                    assetId: asset.id,
                    fileName: asset.file_name,
                    fileType: fileType
                }));
                e.dataTransfer.setData("text/plain", asset.name || asset.file_name);
                e.dataTransfer.effectAllowed = "copy";
            });

            // 双击/点击行为——按文件类型不同处理（单击=查看详情，双击=快捷操作）；多选模式下统一拦截为勾选
            if (fileType === "image") {
                assetElement.onclick = () => {
                    if (multiSelectMode) { toggleAssetSelection(asset.id); return; }
                    scheduleAssetDetail(asset);
                };
                assetElement.ondblclick = () => {
                    if (multiSelectMode) return;
                    cancelScheduledDetail(); exportAssetToCanvas(asset.id);
                };
            } else if (fileType === "video") {
                // 视频单击=卡片内播放/暂停（保留）；详情通过 hover 控件层的 ⓘ 按钮进入；多选模式下拦截为勾选
            } else if (fileType === "audio") {
                assetElement.onclick = () => {
                    if (multiSelectMode) { toggleAssetSelection(asset.id); return; }
                    showAssetDetail(asset);
                };
            } else if (fileType === "text") {
                assetElement.onclick = () => {
                    if (multiSelectMode) { toggleAssetSelection(asset.id); return; }
                    scheduleAssetDetail(asset);
                };
                assetElement.ondblclick = () => {
                    if (multiSelectMode) return;
                    cancelScheduledDetail(); showTextEditor(asset.id, asset.name);
                };
            }

            // 右键菜单（多选模式下不弹出；视频素材传入预览播放器引用以支持复制当前画面）
            assetElement.oncontextmenu = (e) => {
                e.preventDefault();
                if (multiSelectMode) return;
                showAssetContextMenu(e, asset.id, thumbDiv._videoEl);
            };

            // 多选模式下恢复已选中素材的勾选态（排序/搜索重绘列表后保持视觉一致）
            if (multiSelectMode && selectedAssetIds.has(asset.id)) {
                assetElement.classList.add("wp-asset-selected");
            }

            grid.appendChild(assetElement);
        });
    } catch (error) {
        console.error("[WP资产库] 加载资产失败:", error);
    }
}

// ========== 素材多选模式 ==========

// 请求后端批量接口并解析 JSON；非 200 或非 JSON 响应时给出可诊断的错误提示
async function wpBatchFetchJson(response) {
    let text = "";
    try { text = await response.text(); } catch (e) {}
    if (!response.ok) {
        if (response.status === 404 || response.status === 405) {
            throw new Error(`接口未加载（HTTP ${response.status}），新功能需要重启 ComfyUI 后重试`);
        }
        throw new Error(`HTTP ${response.status}${text ? `：${text.substring(0, 120)}` : ""}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error("后端响应异常（非 JSON），请重启 ComfyUI 后重试");
    }
}

// 切换多选模式（进入/退出）
function toggleMultiSelectMode() {
    if (multiSelectMode) {
        exitMultiSelectMode();
        return;
    }
    // 输出视图只读，不允许多选；未选分类时无素材可选
    if (outputViewEnabled) return;
    if (!currentCategoryId) {
        alert("请先选择一个分类");
        return;
    }
    exitDetailView(); // 进入多选前退出详情视图，回到列表
    multiSelectMode = true;
    selectedAssetIds.clear();

    const grid = document.getElementById("wp-asset-grid");
    if (grid) grid.classList.add("wp-multi-select-mode");
    updateMultiSelectButtonState();
    updateBatchToolbar();
}

// 退出多选模式：清空选择、恢复点击/拖拽行为
function exitMultiSelectMode() {
    if (!multiSelectMode) return;
    multiSelectMode = false;
    selectedAssetIds.clear();

    const grid = document.getElementById("wp-asset-grid");
    if (grid) grid.classList.remove("wp-multi-select-mode");
    // 清除所有素材卡片的高亮态
    document.querySelectorAll(".wp-asset-item.wp-asset-selected").forEach(el => {
        el.classList.remove("wp-asset-selected");
    });
    updateMultiSelectButtonState();
    updateBatchToolbar();
}

// 更新多选按钮的激活外观
function updateMultiSelectButtonState() {
    const btn = document.getElementById("wp-asset-multi-select-btn");
    if (!btn) return;
    if (multiSelectMode) {
        btn.style.background = "rgba(102, 42, 213, 0.85)";
        btn.style.borderColor = "#662ad5";
        btn.style.color = "#fff";
        btn.title = "退出多选模式";
    } else {
        btn.style.background = "rgba(128, 128, 128, 0.3)";
        btn.style.borderColor = "rgba(128, 128, 128, 0.2)";
        btn.style.color = "rgba(255, 255, 255, 0.6)";
        btn.title = "多选模式：批量选择素材进行删除/移动";
    }
}

// 勾选/取消勾选单个素材
function toggleAssetSelection(assetId) {
    const itemEl = document.querySelector(`.wp-asset-item[data-asset-id="${assetId}"]`);
    if (selectedAssetIds.has(assetId)) {
        selectedAssetIds.delete(assetId);
        if (itemEl) itemEl.classList.remove("wp-asset-selected");
    } else {
        selectedAssetIds.add(assetId);
        if (itemEl) itemEl.classList.add("wp-asset-selected");
    }
    updateBatchToolbar();
}

// 更新批量操作工具栏（至少选中一个素材时显示）
function updateBatchToolbar() {
    const bar = document.getElementById("wp-asset-batch-toolbar");
    const countEl = document.getElementById("wp-asset-batch-count");
    if (!bar || !countEl) return;
    const n = selectedAssetIds.size;
    bar.style.display = (multiSelectMode && n > 0) ? "flex" : "none";
    countEl.textContent = `已选 ${n} 项`;
}

// 批量删除
async function executeBatchDelete() {
    if (!multiSelectMode || selectedAssetIds.size === 0) return;
    const n = selectedAssetIds.size;
    if (!confirm(`确定要删除选中的 ${n} 个素材吗？\n\n素材文件将从磁盘移除，无法恢复！`)) return;

    const deleteBtn = document.getElementById("wp-asset-batch-delete-btn");
    const moveBtn = document.getElementById("wp-asset-batch-move-btn");
    const originalText = deleteBtn ? deleteBtn.textContent : "";
    if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.textContent = "删除中..."; deleteBtn.style.opacity = "0.6"; }
    if (moveBtn) { moveBtn.disabled = true; moveBtn.style.opacity = "0.6"; }

    try {
        const response = await fetch(`${ASSET_API_BASE}/assets/batch_delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset_ids: Array.from(selectedAssetIds) })
        });
        const result = await wpBatchFetchJson(response);
        if (result.success) {
            alert(`成功删除 ${result.deleted} 个素材`);
        } else {
            const failedCount = (result.failed || []).length;
            alert(`删除完成：成功 ${result.deleted} 个，失败 ${failedCount} 个\n\n失败原因：${(result.failed || [])[0]?.reason || "未知"}`);
        }
        await finishBatchOperation();
    } catch (error) {
        alert(`批量删除失败: ${error.message}`);
        if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.textContent = originalText; deleteBtn.style.opacity = "1"; }
        if (moveBtn) { moveBtn.disabled = false; moveBtn.style.opacity = "1"; }
    }
}

// 批量移动弹窗：两级选择（目标项目 -> 目标分类）
async function showBatchMoveDialog() {
    if (!multiSelectMode || selectedAssetIds.size === 0) return;

    // 若项目缓存为空先加载
    if (!projectsCache || projectsCache.length === 0) {
        try {
            const resp = await fetch(`${ASSET_API_BASE}/projects`);
            projectsCache = await resp.json();
        } catch (e) {
            alert("获取项目列表失败，请重试");
            return;
        }
    }
    if (!projectsCache.length) {
        alert("没有可用的项目");
        return;
    }

    const overlay = document.createElement("div");
    overlay.className = "wp-upload-overlay";
    const dialog = document.createElement("div");
    dialog.className = "wp-upload-dialog";
    dialog.style.width = "380px";
    dialog.innerHTML = `
        <div style="font-size:15px;font-weight:bold;color:#fff;margin-bottom:14px;">移动 ${selectedAssetIds.size} 个素材至</div>
        <div style="margin-bottom:12px;">
            <div style="font-size:12px;color:#aaa;margin-bottom:6px;">目标项目</div>
            <select id="wp-batch-move-project" style="width:100%;padding:6px 8px;background:#2a2a2a;border:1px solid #444;border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;"></select>
        </div>
        <div style="margin-bottom:16px;">
            <div style="font-size:12px;color:#aaa;margin-bottom:6px;">目标分类</div>
            <select id="wp-batch-move-category" style="width:100%;padding:6px 8px;background:#2a2a2a;border:1px solid #444;border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;"></select>
        </div>
        <div id="wp-batch-move-msg" style="font-size:12px;color:#c9a6ff;margin-bottom:10px;min-height:16px;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="wp-batch-move-cancel" style="padding:6px 16px;background:rgba(128,128,128,0.5);border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">取消</button>
            <button id="wp-batch-move-confirm" style="padding:6px 16px;background:#662ad5;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">移动</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const projectSelect = dialog.querySelector("#wp-batch-move-project");
    const categorySelect = dialog.querySelector("#wp-batch-move-category");
    const msgEl = dialog.querySelector("#wp-batch-move-msg");
    const confirmBtn = dialog.querySelector("#wp-batch-move-confirm");
    const cancelBtn = dialog.querySelector("#wp-batch-move-cancel");

    // 填充项目下拉（当前项目默认选中）
    projectsCache.forEach(proj => {
        const opt = document.createElement("option");
        opt.value = proj.id;
        opt.textContent = proj.name;
        projectSelect.appendChild(opt);
    });
    if (currentProjectId && projectsCache.find(p => p.id === currentProjectId)) {
        projectSelect.value = currentProjectId;
    }

    // 加载指定项目的分类
    const loadCategoriesFor = async (projectId) => {
        categorySelect.innerHTML = "";
        categorySelect.disabled = true;
        try {
            const resp = await fetch(`${ASSET_API_BASE}/categories?project_id=${encodeURIComponent(projectId)}`);
            const categories = await resp.json();
            if (!categories.length) {
                const opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "（该项目暂无分类）";
                categorySelect.appendChild(opt);
                return;
            }
            categories.forEach(cat => {
                const opt = document.createElement("option");
                opt.value = cat.id;
                opt.textContent = `${cat.name}（${cat.asset_count} 个素材）`;
                categorySelect.appendChild(opt);
            });
        } catch (e) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "加载分类失败";
            categorySelect.appendChild(opt);
        } finally {
            categorySelect.disabled = false;
        }
    };
    loadCategoriesFor(projectSelect.value);

    projectSelect.onchange = () => loadCategoriesFor(projectSelect.value);

    const closeDialog = () => document.body.removeChild(overlay);

    cancelBtn.onclick = closeDialog;
    overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };

    confirmBtn.onclick = async () => {
        const targetProject = projectSelect.value;
        const targetCategory = categorySelect.value;
        if (!targetProject || !targetCategory) {
            msgEl.textContent = "请选择目标项目和分类";
            msgEl.style.color = "#ff6b6b";
            return;
        }
        confirmBtn.disabled = true;
        confirmBtn.textContent = "移动中...";
        confirmBtn.style.opacity = "0.6";
        msgEl.style.color = "#c9a6ff";
        msgEl.textContent = "正在移动素材文件...";

        try {
            const response = await fetch(`${ASSET_API_BASE}/assets/batch_move`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: Array.from(selectedAssetIds),
                    project_id: targetProject,
                    category_id: targetCategory
                })
            });
            const result = await wpBatchFetchJson(response);
            closeDialog();
            if (result.success) {
                alert(`成功移动 ${result.moved} 个素材`);
            } else {
                const failedCount = (result.failed || []).length;
                alert(`移动完成：成功 ${result.moved} 个，失败 ${failedCount} 个\n\n失败原因：${(result.failed || [])[0]?.reason || "未知"}`);
            }
            await finishBatchOperation(true);
        } catch (error) {
            msgEl.style.color = "#ff6b6b";
            msgEl.textContent = `移动失败: ${error.message}`;
            confirmBtn.disabled = false;
            confirmBtn.textContent = "移动";
            confirmBtn.style.opacity = "1";
        }
    };
}

// 批量操作完成后的收尾：恢复按钮状态，刷新列表/分类计数/项目下拉，退出多选模式
async function finishBatchOperation() {
    // 成功路径不经过 catch 的恢复逻辑，需在此复位按钮，否则残留"删除中..."禁用态导致下次无法点击
    const deleteBtn = document.getElementById("wp-asset-batch-delete-btn");
    const moveBtn = document.getElementById("wp-asset-batch-move-btn");
    if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.textContent = "🗑 删除"; deleteBtn.style.opacity = "1"; }
    if (moveBtn) { moveBtn.disabled = false; moveBtn.style.opacity = "1"; }

    exitMultiSelectMode();
    // 刷新当前分类素材列表与侧边栏分类计数（素材跨分类移动后计数变化）
    if (currentProjectId) {
        await loadCategories(currentProjectId);
    }
    if (currentCategoryId) {
        await loadAssetsByCategory(currentCategoryId, document.getElementById("wp-asset-search-input")?.value || "");
    }
}

// 搜索资产
async function searchAssets(query) {
    exitDetailView(); // 搜索时退出详情视图，恢复列表
    if (outputViewEnabled) {
        await loadOutputFiles(query);
        return;
    }
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
        
        // 先复制文件到 ComfyUI 的 input 目录
        const copyResponse = await fetch(`${ASSET_API_BASE}/asset/${assetId}/copy_to_input`, {
            method: 'POST'
        });
        
        if (!copyResponse.ok) {
            alert("复制资产文件失败");
            return;
        }
        
        const result = await copyResponse.json();
        
        if (result.success && result.file_name) {
            // 使用 ComfyUI 原生的 LoadImage 节点，兼容所有能加载图像的节点
            const node = LiteGraph.createNode("LoadImage");
            if (!node) {
                alert("无法创建加载图像节点。");
                return;
            }
            
            // 获取鼠标在画布上的位置
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
                            widget.value = result.file_name;
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
    } catch (error) {
        console.error("[WP资产库] 导出资产失败:", error);
        alert("导出资产失败: " + error.message);
    }
}

// ========== 视频预览（放大播放器） ==========

// 视频转码播放：浏览器不支持的格式（H.265/MKV/AVI 等）触发后台转 H.264，完成后自动重载播放
async function handleVideoTranscode(video, assetId, tipEl) {
    if (video.dataset.transcodeStarted) return;
    video.dataset.transcodeStarted = "1";
    const showTip = (msg) => { if (tipEl) { tipEl.style.display = "block"; tipEl.textContent = msg; } };
    try {
        const startResp = await fetch(`${ASSET_API_BASE}/asset/${assetId}/transcode`, { method: 'POST' });
        const startResult = await startResp.json();
        if (!startResult.success) { showTip(startResult.error || "该视频无法播放"); return; }
        if (startResult.status === "native") { showTip("该视频格式浏览器不支持"); return; }
        while (true) {
            if (!document.body.contains(video)) return; // 播放器已关闭，停止轮询
            showTip("该视频格式浏览器不支持，正在自动转码为 H.264…（每个视频只需转一次，稍候自动播放）");
            await new Promise(r => setTimeout(r, 1200));
            const stResp = await fetch(`${ASSET_API_BASE}/asset/${assetId}/transcode_status`);
            const st = await stResp.json();
            if (st.status === "done") {
                video.src = `${ASSET_API_BASE}/file/${assetId}?t=${Date.now()}`;
                video.load();
                video.play().catch(() => {});
                if (tipEl) tipEl.style.display = "none";
                return;
            }
            if (st.status === "failed") { showTip("转码失败: " + (st.error || "未知原因")); return; }
        }
    } catch (e) {
        showTip("转码请求失败: " + e.message);
    }
}

function showVideoPreview(assetId, assetName, fileUrl) {
    // 移除已有预览
    closeAllPreviews();
    
    const overlay = document.createElement("div");
    overlay.className = "wp-preview-overlay";
    overlay.id = "wp-video-preview";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.85); z-index: 10002;
        display: flex; align-items: center; justify-content: center;
    `;
    
    const container = document.createElement("div");
    container.style.cssText = `
        position: relative; max-width: 90vw; max-height: 90vh;
        background: #1a1a1a; border-radius: 12px; overflow: hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;
    
    // 标题栏
    const header = document.createElement("div");
    header.style.cssText = `
        padding: 10px 16px; display: flex; justify-content: space-between;
        align-items: center; background: #2a2a2a;
    `;
    header.innerHTML = `
        <span style="color:#fff;font-size:14px;">🎬 ${assetName || '视频预览'}</span>
        <div style="display:flex;gap:8px;align-items:center;"></div>
    `;
    
    const headerRight = header.querySelector('div');
    
    // 倍速选择器
    const speedSelect = document.createElement("select");
    speedSelect.style.cssText = `
        background: #444; color: #fff; border: 1px solid #555;
        border-radius: 4px; padding: 2px 6px; font-size: 12px; cursor: pointer;
    `;
    [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(s => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s + 'x';
        if (s === 1) opt.selected = true;
        speedSelect.appendChild(opt);
    });
    headerRight.appendChild(speedSelect);
    
    // 关闭按钮
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "✕";
    closeBtn.style.cssText = `
        background: #555; border: none; color: #fff; width: 28px; height: 28px;
        border-radius: 50%; cursor: pointer; font-size: 14px;
    `;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    headerRight.appendChild(closeBtn);
    
    // 视频元素
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.style.cssText = `
        display: block; max-width: 90vw; max-height: calc(90vh - 50px);
        outline: none;
    `;
    video.src = fileUrl || `${ASSET_API_BASE}/file/${assetId}`;

    // 转码状态提示条（素材库视频遇不支持的格式时自动转码；输出视图只读不转码）
    const transcodeTip = document.createElement("div");
    transcodeTip.style.cssText = `
        display: none; padding: 8px 16px; color: #c9a6ff;
        font-size: 13px; background: rgba(102, 42, 213, 0.15);
        border-top: 1px solid rgba(102, 42, 213, 0.3);
    `;
    if (!fileUrl) {
        const tryTranscode = () => handleVideoTranscode(video, assetId, transcodeTip);
        video.addEventListener("error", tryTranscode);
        // HEVC 等编码音频能播、画面解不了，浏览器不报 error，需检测画面宽度为 0
        video.addEventListener("loadedmetadata", () => {
            if (video.videoWidth === 0) tryTranscode();
        });
    }

    speedSelect.onchange = () => { video.playbackRate = parseFloat(speedSelect.value); };

    container.appendChild(header);
    container.appendChild(video);
    container.appendChild(transcodeTip);
    overlay.appendChild(container);
    overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
    document.body.appendChild(overlay);
}

// ========== 音频预览 ==========

function showAudioPreview(assetId, assetName, fileUrl) {
    closeAllPreviews();
    
    const overlay = document.createElement("div");
    overlay.className = "wp-preview-overlay";
    overlay.id = "wp-audio-preview";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.7); z-index: 10002;
        display: flex; align-items: center; justify-content: center;
    `;
    
    const container = document.createElement("div");
    container.style.cssText = `
        background: #2a2a2a; border-radius: 12px; padding: 24px;
        min-width: 400px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        border: 1px solid #444;
    `;
    
    container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <span style="color:#fff;font-size:16px;">🎵 ${assetName || '音频预览'}</span>
            <button id="wp-audio-close" style="background:#555;border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;">✕</button>
        </div>
        <div style="text-align:center;margin-bottom:16px;">
            <div style="font-size:48px;margin-bottom:8px;">🎵</div>
        </div>
    `;
    
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.autoplay = true;
    audio.style.cssText = "width:100%;outline:none;";
    audio.src = fileUrl || `${ASSET_API_BASE}/file/${assetId}`;
    
    const speedRow = document.createElement("div");
    speedRow.style.cssText = "margin-top:12px;display:flex;align-items:center;gap:8px;";
    speedRow.innerHTML = '<span style="color:#aaa;font-size:12px;">倍速：</span>';
    
    const speedSelect = document.createElement("select");
    speedSelect.style.cssText = `
        background: #444; color: #fff; border: 1px solid #555;
        border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer;
    `;
    [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(s => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s + 'x';
        if (s === 1) opt.selected = true;
        speedSelect.appendChild(opt);
    });
    speedSelect.onchange = () => { audio.playbackRate = parseFloat(speedSelect.value); };
    speedRow.appendChild(speedSelect);
    
    container.appendChild(audio);
    container.appendChild(speedRow);
    overlay.appendChild(container);
    
    container.querySelector("#wp-audio-close").onclick = () => document.body.removeChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
    document.body.appendChild(overlay);
}

// ========== 文本编辑器 ==========

async function showTextEditor(assetId, assetName) {
    closeAllPreviews();
    
    // 加载文本内容
    let content = "";
    try {
        const resp = await fetch(`${ASSET_API_BASE}/text/${assetId}`);
        const data = await resp.json();
        if (data.success) {
            content = data.content;
        }
    } catch (e) {
        console.error("[WP资产库] 读取文本失败:", e);
    }
    
    const overlay = document.createElement("div");
    overlay.className = "wp-preview-overlay";
    overlay.id = "wp-text-editor";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.8); z-index: 10002;
        display: flex; align-items: center; justify-content: center;
    `;
    
    const container = document.createElement("div");
    container.style.cssText = `
        background: #2a2a2a; border-radius: 12px; width: 700px; max-width: 90vw;
        max-height: 85vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid #444;
    `;
    
    // 标题栏
    const header = document.createElement("div");
    header.style.cssText = `
        padding: 12px 16px; display: flex; justify-content: space-between;
        align-items: center; border-bottom: 1px solid #444;
    `;
    header.innerHTML = `
        <span style="color:#fff;font-size:14px;">📝 ${assetName || '文本编辑'}</span>
        <div style="display:flex;gap:8px;">
    `;
    
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "📋 复制";
    copyBtn.style.cssText = `
        background: #444; border: none; color: #fff; padding: 4px 12px;
        border-radius: 4px; cursor: pointer; font-size: 12px;
    `;
    
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "💾 保存";
    saveBtn.style.cssText = `
        background: #28a745; border: none; color: #fff; padding: 4px 12px;
        border-radius: 4px; cursor: pointer; font-size: 12px;
    `;
    
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "✕";
    closeBtn.style.cssText = `
        background: #555; border: none; color: #fff; width: 28px; height: 28px;
        border-radius: 50%; cursor: pointer; font-size: 14px;
    `;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    
    header.querySelector('div').appendChild(copyBtn);
    header.querySelector('div').appendChild(saveBtn);
    header.querySelector('div').appendChild(closeBtn);
    
    // 文本编辑区
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.cssText = `
        flex: 1; padding: 16px; background: #1a1a1a; color: #e0e0e0;
        border: none; outline: none; resize: none; font-size: 13px;
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        line-height: 1.6; min-height: 300px;
    `;
    
    // 状态栏
    const statusBar = document.createElement("div");
    statusBar.style.cssText = `
        padding: 6px 16px; border-top: 1px solid #444;
        color: #888; font-size: 11px; display: flex; justify-content: space-between;
    `;
    const updateStatus = (msg) => { statusBar.innerHTML = `<span>${msg}</span><span>${content.length} 字符</span>`; };
    updateStatus("双击打开编辑");
    
    // 复制功能
    copyBtn.onclick = () => {
        navigator.clipboard.writeText(textarea.value).then(() => {
            updateStatus("✅ 已复制到剪贴板");
        }).catch(() => {
            textarea.select();
            document.execCommand("copy");
            updateStatus("✅ 已复制到剪贴板");
        });
    };
    
    // 保存功能
    saveBtn.onclick = async () => {
        try {
            const resp = await fetch(`${ASSET_API_BASE}/text/${assetId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: textarea.value })
            });
            const data = await resp.json();
            if (data.success) {
                content = textarea.value;
                updateStatus("✅ 已保存");
            } else {
                updateStatus("❌ 保存失败: " + (data.error || "未知错误"));
            }
        } catch (e) {
            updateStatus("❌ 保存失败: " + e.message);
        }
    };
    
    // 跟踪修改状态
    textarea.oninput = () => {
        const changed = textarea.value !== content;
        updateStatus(changed ? "✏️ 已修改，未保存" : "双击打开编辑");
    };
    
    container.appendChild(header);
    container.appendChild(textarea);
    container.appendChild(statusBar);
    overlay.appendChild(container);
    overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
    document.body.appendChild(overlay);
    
    textarea.focus();
}

// 关闭所有预览
function closeAllPreviews() {
    document.querySelectorAll('.wp-preview-overlay').forEach(el => el.remove());
}

// 扫描本地文件并添加到资产库
async function scanLocalFiles() {
    exitDetailView(); // 手动刷新时退出详情视图，恢复列表

    // 查找刷新按钮并禁用
    const btn = document.getElementById("wp-asset-refresh-btn");

    // 输出视图：刷新按钮 = 重新读取输出文件夹（保留当前子文件夹选中）
    if (outputViewEnabled) {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = "⟳ 刷新中...";
        }
        try {
            await loadOutputCategories(true);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = "⟳ 刷新";
            }
        }
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = "⟳ 扫描中...";
    }
    
    try {
        const response = await fetch(`${ASSET_API_BASE}/scan_all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            const parts = [];
            if (result.new_projects > 0) parts.push(`新项目 ${result.new_projects} 个`);
            if (result.new_categories > 0) parts.push(`新分类 ${result.new_categories} 个`);
            if (result.new_assets > 0) parts.push(`新素材 ${result.new_assets} 个`);
            if (result.renamed > 0) parts.push(`改名同步 ${result.renamed} 个`);
            if (result.remounted > 0) parts.push(`位置修正 ${result.remounted} 个`);
            if (result.removed > 0) parts.push(`移除失效素材 ${result.removed} 个`);
            const removedFolders = [];
            if (result.removed_projects > 0) removedFolders.push(`项目 ${result.removed_projects} 个`);
            if (result.removed_categories > 0) removedFolders.push(`分类 ${result.removed_categories} 个`);
            if (removedFolders.length > 0) parts.push(`移除失效${removedFolders.join("、")}`);
            
            let msg = parts.length > 0
                ? "扫描完成：" + parts.join("，")
                : "扫描完成，没有发现变化。";
            
            if (result.loose_files > 0) {
                msg += `\n\n另有 ${result.loose_files} 个散文件未入库（请放入项目/分类文件夹内再刷新）。`;
            }
            if (result.invalid_files > 0) {
                msg += `\n${result.invalid_files} 个损坏文件已跳过。`;
            }
            alert(msg);
            
            // 刷新面板数据：项目列表会保留当前选中项
            await loadProjects();
            if (currentProjectId) {
                await loadCategories(currentProjectId);
            }
            if (currentCategoryId) {
                await loadAssetsByCategory(currentCategoryId, document.getElementById("wp-asset-search-input")?.value || "");
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
    title.textContent = "上传文件到资产库";
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
    fileInput.accept = ".jpg,.jpeg,.png,.webp,.gif,.bmp,.tiff,.tif,.mp3,.wav,.ogg,.flac,.aac,.m4a,.mp4,.webm,.avi,.mov,.mkv,.txt,.json,.csv,.xml,.yaml,.yml,.md,.py,.js,.html,.css";
    fileInput.multiple = true;
    fileInput.style.cssText = "display: none;";
    
    // 拖拽区域
    const dropZone = document.createElement("div");
    dropZone.className = "wp-drop-zone";
    dropZone.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 10px;"></div>
        <div>拖拽文件到这里或点击选择</div>
        <div style="font-size: 12px; color: #888; margin-top: 5px;">支持图片、音频、视频、文本等格式</div>
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
            if (result.failed > 0) {
                alert(`成功上传 ${result.count} 个文件，${result.failed} 个失败（文件可能已损坏或格式不支持）！`);
            } else {
                alert(`成功上传 ${result.count} 个文件！`);
            }
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

// 显示资产右键菜单（videoEl 仅视频素材传入：内嵌预览播放器引用）
function showAssetContextMenu(event, assetId, videoEl) {
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

    // 复制到系统剪贴板（可粘贴到微信/网页输入框/本地文件夹等）
    const clipboardItem = document.createElement("div");
    clipboardItem.className = "wp-context-menu-item";
    clipboardItem.textContent = "复制到剪贴板";
    clipboardItem.onclick = async () => {
        document.body.removeChild(menu);
        try {
            const response = await fetch(`${ASSET_API_BASE}/asset/${assetId}/clipboard`, { method: 'POST' });
            const text = await response.text();
            let result = null;
            try { result = JSON.parse(text); } catch (e) {}
            if (result && result.success) {
                wpShowToast("已复制到剪贴板，可直接粘贴 (Ctrl+V)");
            } else {
                alert(`复制失败: ${(result && result.error) || `HTTP ${response.status}（后端可能未重启）`}`);
            }
        } catch (error) {
            alert(`复制失败: ${error.message}`);
        }
    };

    // 复制视频帧（仅视频素材：取预览播放器当前画面位置，未播放过则为第一帧）
    let videoFrameItem = null;
    if (videoEl) {
        videoFrameItem = document.createElement("div");
        videoFrameItem.className = "wp-context-menu-item";
        videoFrameItem.textContent = "复制视频帧";
        videoFrameItem.onclick = async () => {
            document.body.removeChild(menu);
            const t = videoEl.currentTime || 0;
            try {
                const response = await fetch(`${ASSET_API_BASE}/asset/${assetId}/video_frame`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ time: t })
                });
                const text = await response.text();
                let result = null;
                try { result = JSON.parse(text); } catch (e) {}
                if (result && result.success) {
                    wpShowToast("已复制视频帧，可直接粘贴 (Ctrl+V)");
                } else {
                    alert(`复制失败: ${(result && result.error) || `HTTP ${response.status}（后端可能未重启）`}`);
                }
            } catch (error) {
                alert(`复制失败: ${error.message}`);
            }
        };
        // 视频素材的"复制到剪贴板"明确为复制视频文件本体
        clipboardItem.textContent = "复制视频文件";
    }

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
    if (videoFrameItem) {
        menu.appendChild(videoFrameItem);
    }
    menu.appendChild(clipboardItem);
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

// 轻提示：顶部自动消失，无需点击确认
function wpShowToast(message, duration = 1800) {
    document.querySelectorAll(".wp-toast").forEach(t => t.remove());
    const toast = document.createElement("div");
    toast.className = "wp-toast";
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(30, 30, 35, 0.92);
        color: #fff;
        padding: 10px 22px;
        border-radius: 8px;
        font-size: 13px;
        z-index: 100000;
        pointer-events: none;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.12);
        transition: opacity 0.3s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// 输出文件右键菜单（输出为只读视图：视频=复制帧+复制文件，其他类型=复制到剪贴板）
function showOutputContextMenu(event, file, videoEl) {
    // 移除旧菜单，避免连点右键时叠加
    document.querySelectorAll(".wp-context-menu").forEach(m => m.remove());

    const relPath = file.rel_path || "";
    const fileType = file.file_type || "image";

    const menu = document.createElement("div");
    menu.className = "wp-context-menu";
    menu.style.cssText = `
        position: fixed;
        top: ${event.clientY}px;
        left: ${event.clientX}px;
    `;

    const postClipboard = async (url, body, successMsg) => {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const text = await response.text();
            let result = null;
            try { result = JSON.parse(text); } catch (e) {}
            if (result && result.success) {
                wpShowToast(successMsg);
            } else {
                alert(`复制失败: ${(result && result.error) || `HTTP ${response.status}（后端可能未重启）`}`);
            }
        } catch (error) {
            alert(`复制失败: ${error.message}`);
        }
    };

    const makeItem = (label, onclick) => {
        const item = document.createElement("div");
        item.className = "wp-context-menu-item";
        item.textContent = label;
        item.onclick = () => {
            document.body.removeChild(menu);
            onclick();
        };
        return item;
    };

    if (fileType === "video") {
        menu.appendChild(makeItem("复制视频帧", () => {
            // 取预览播放器当前画面位置（未播放过则为第一帧）
            const t = videoEl ? (videoEl.currentTime || 0) : 0;
            postClipboard(`${ASSET_API_BASE}/output/video_frame`, { path: relPath, time: t },
                "已复制视频帧，可直接粘贴 (Ctrl+V)");
        }));
        menu.appendChild(makeItem("复制视频文件", () => {
            postClipboard(`${ASSET_API_BASE}/output/clipboard`, { path: relPath },
                "已复制视频文件，可粘贴到文件夹 (Ctrl+V)");
        }));
    } else {
        menu.appendChild(makeItem("复制到剪贴板", () => {
            postClipboard(`${ASSET_API_BASE}/output/clipboard`, { path: relPath },
                "已复制到剪贴板，可直接粘贴 (Ctrl+V)");
        }));
    }

    document.body.appendChild(menu);

    const closeMenu = (e) => {
        // 菜单已被移除（如再次右键触发了新菜单）时只清理监听器，避免重复移除报错
        if (!menu.isConnected) {
            document.removeEventListener('click', closeMenu);
            return;
        }
        if (!menu.contains(e.target)) {
            document.body.removeChild(menu);
            document.removeEventListener('click', closeMenu);
        }
    };
    document.addEventListener('click', closeMenu);
}

// 创建悬浮按钮（默认圆形只显示鲸鱼，悬停平滑展开为胶囊，可自由拖动并记忆位置）
function createFloatingButton() {
    const POS_KEY = "wp_asset_library_button_pos";
    const SIZE = 45;          // 收起态直径
    const EXPAND_W = 120;     // 展开态宽度
    const EDGE = 8;           // 屏幕边缘安全留白
    const DRAG_DIST = 5;      // 超过该位移判定为拖动而非点击
    const EASE = "cubic-bezier(0.16, 1, 0.3, 1)"; // easeOutExpo：快起慢收，丝滑收尾

    const button = document.createElement("div");
    button.id = "wp-asset-library-button";

    const whaleEl = document.createElement("span");
    whaleEl.textContent = "🐳";
    whaleEl.style.cssText = "font-size:20px;line-height:1;flex:none;";

    const labelEl = document.createElement("span");
    labelEl.textContent = "资产库";
    labelEl.style.cssText = `
        font-size:12px;
        font-weight:500;
        letter-spacing:0.3px;
        white-space:nowrap;
        max-width:0;
        opacity:0;
        overflow:hidden;
        margin-left:0;
        transition:max-width 0.6s ${EASE},opacity 0.35s ease,margin-left 0.6s ${EASE};
    `;

    button.style.cssText = `
        position: fixed;
        width: ${SIZE}px;
        height: ${SIZE}px;
        left: 0;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, rgba(102, 42, 213, 0.65) 0%, rgba(102, 42, 213, 0.45) 100%);
        color: white;
        border-radius: ${SIZE / 2}px;
        cursor: pointer;
        z-index: 9999;
        box-shadow: 0 4px 20px rgba(102, 42, 213, 0.45), 0 0 15px rgba(102, 42, 213, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2);
        backdrop-filter: blur(15px) saturate(1.2);
        -webkit-backdrop-filter: blur(15px) saturate(1.2);
        transition: all 0.6s ${EASE};
        border: 1px solid rgba(255, 255, 255, 0.25);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        box-sizing: border-box;
    `;
    button.appendChild(whaleEl);
    button.appendChild(labelEl);

    // 呼吸灯动画关键帧（一次性注入）
    if (!document.getElementById("wp-asset-btn-keyframes")) {
        const kf = document.createElement("style");
        kf.id = "wp-asset-btn-keyframes";
        kf.textContent = `
            @keyframes wp-orbit-pulse { 0%,100% { border-color: rgba(160,105,255,0.22); } 50% { border-color: rgba(185,135,255,0.6); } }
            @keyframes wp-dot-glow { 0%,100% { box-shadow: 0 0 4px rgba(185,135,255,0.65), 0 0 8px rgba(160,105,255,0.3); } 50% { box-shadow: 0 0 7px rgba(210,175,255,0.95), 0 0 14px rgba(160,105,255,0.55); } }
        `;
        document.head.appendChild(kf);
    }

    // 呼吸灯轨道：2px 描边、与按钮间隙 6px，4px 光点沿描边匀速环绕（4秒一圈），展开时轨道同步张开为胶囊形
    const ORBIT_D = SIZE + 6 * 2 + 2 * 2; // 轨道外径 = 直径 + 间隙×2 + 描边×2
    const ORBIT_W_EXPAND = EXPAND_W + 6 * 2 + 2 * 2;
    const orbitEl = document.createElement("span");
    orbitEl.style.cssText = `
        position: absolute;
        left: 50%;
        top: 50%;
        width: ${ORBIT_D}px;
        height: ${ORBIT_D}px;
        transform: translate(-50%, -50%);
        border: 2px solid rgba(160, 105, 255, 0.4);
        border-radius: ${ORBIT_D / 2}px;
        pointer-events: none;
        box-sizing: border-box;
        transition: width 0.6s ${EASE};
        animation: wp-orbit-pulse 3s ease-in-out infinite;
    `;
    const dotEl = document.createElement("span");
    dotEl.style.cssText = `
        position: absolute;
        left: 0;
        top: 0;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: #dcc5ff;
        animation: wp-dot-glow 2.5s ease-in-out infinite;
    `;
    orbitEl.appendChild(dotEl);
    button.appendChild(orbitEl);

    // 光点沿胶囊轨迹逐帧定位（顺时针闭环：右半圆→下直线→左半圆→上直线），过渡期间轨迹变形光点自动跟随
    const ORBIT_PERIOD = 4000; // 环绕一圈耗时（毫秒）
    let dotS = 0;             // 光点沿轨迹的弧长（逐帧正向累积，保证始终顺时针不倒退）
    let lastC = 0;            // 上一帧轨迹周长（识别变形帧）
    let dotLast = performance.now();
    const animateDot = (now) => {
        const dt = now - dotLast;
        dotLast = now;
        const ow = orbitEl.getBoundingClientRect().width;
        const R = (ORBIT_D - 2) / 2;           // 描边中心线圆角半径
        const L = Math.max(0, ow - 2 - 2 * R); // 直线段长（圆形时为 0）
        const C = Math.PI * 2 * R + 2 * L;     // 当前轨迹周长
        if (lastC && Math.abs(C - lastC) > 0.5) {
            // 变形帧：按弧长比例重映射，光点物理位置跟随轨道平滑变形，无跳变无倒退
            dotS = (dotS / lastC) * C;
        }
        lastC = C;
        dotS = (dotS + (dt / ORBIT_PERIOD) * C) % C;
        const s = dotS;
        const cy = ORBIT_D / 2;
        const cxR = ow - 1 - R; // 右侧圆心
        const cxL = 1 + R;      // 左侧圆心
        let x, y;
        if (s < Math.PI * R) {                  // 右半圆（顶→右→底）
            const th = s / R;
            x = cxR + R * Math.sin(th);
            y = cy - R * Math.cos(th);
        } else if (s < Math.PI * R + L) {       // 下直线（底右→底左）
            x = cxR - (s - Math.PI * R);
            y = ORBIT_D - 1;
        } else if (s < Math.PI * 2 * R + L) {   // 左半圆（底→左→顶）
            const th = (s - Math.PI * R - L) / R;
            x = cxL - R * Math.sin(th);
            y = cy + R * Math.cos(th);
        } else {                                // 上直线（顶左→顶右，闭合）
            x = cxL + (s - Math.PI * 2 * R - L);
            y = 1;
        }
        dotEl.style.transform = `translate(${(x - 2).toFixed(2)}px, ${(y - 2).toFixed(2)}px)`;
        requestAnimationFrame(animateDot);
    };
    requestAnimationFrame(animateDot);

    // 基准位置（收起态左上角屏幕坐标）：优先恢复上次拖放位置，否则默认右下角
    let baseLeft = window.innerWidth - 68 - SIZE;
    let baseTop = window.innerHeight - 68 - SIZE;
    try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
            baseLeft = saved.left;
            baseTop = saved.top;
        }
    } catch (e) { /* 本地存储不可用时用默认位置 */ }

    const clampX = (x) => Math.max(EDGE, Math.min(x, window.innerWidth - SIZE - EDGE));
    const clampY = (y) => Math.max(EDGE, Math.min(y, window.innerHeight - SIZE - EDGE));
    baseLeft = clampX(baseLeft);
    baseTop = clampY(baseTop);
    button.style.left = baseLeft + "px";
    button.style.top = baseTop + "px";

    let hoverOn = false;   // 当前是否展开
    let dragging = false;  // 拖动中

    // 展开/收起：收起态右边缘 = baseLeft + SIZE，展开时右边缘锚定向左展开；贴左边缘时改为左边缘锚定向右展开
    const applyExpand = (on) => {
        hoverOn = on;
        if (on) {
            let newLeft = baseLeft + SIZE - EXPAND_W;
            if (newLeft < EDGE) newLeft = baseLeft;
            button.style.width = EXPAND_W + "px";
            button.style.left = newLeft + "px";
            labelEl.style.maxWidth = "90px";
            labelEl.style.opacity = "1";
            labelEl.style.marginLeft = "6px";
            orbitEl.style.width = ORBIT_W_EXPAND + "px";
            button.style.background = "linear-gradient(135deg, rgba(102, 42, 213, 0.85) 0%, rgba(102, 42, 213, 0.6) 100%)";
            button.style.boxShadow = "0 8px 30px rgba(102, 42, 213, 0.6), 0 0 25px rgba(102, 42, 213, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.3)";
            button.style.borderColor = "rgba(255, 255, 255, 0.35)";
        } else {
            button.style.width = SIZE + "px";
            button.style.left = baseLeft + "px";
            labelEl.style.maxWidth = "0";
            labelEl.style.opacity = "0";
            labelEl.style.marginLeft = "0";
            orbitEl.style.width = ORBIT_D + "px";
            button.style.background = "linear-gradient(135deg, rgba(102, 42, 213, 0.65) 0%, rgba(102, 42, 213, 0.45) 100%)";
            button.style.boxShadow = "0 4px 20px rgba(102, 42, 213, 0.45), 0 0 15px rgba(102, 42, 213, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2)";
            button.style.borderColor = "rgba(255, 255, 255, 0.25)";
        }
    };

    button.addEventListener("pointerenter", () => { if (!dragging) applyExpand(true); });
    button.addEventListener("pointerleave", () => { if (!dragging) applyExpand(false); });

    let press = null; // 按下时的指针与位置快照

    button.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || press) return;
        e.preventDefault();
        e.stopPropagation();
        press = { px: e.clientX, py: e.clientY, sx: baseLeft, sy: baseTop };
        dragging = false;
        try { button.setPointerCapture(e.pointerId); } catch (err) {}
        button.style.cursor = "grabbing";
    });

    button.addEventListener("pointermove", (e) => {
        if (!press) return;
        const dx = e.clientX - press.px;
        const dy = e.clientY - press.py;
        if (!dragging && Math.hypot(dx, dy) > DRAG_DIST) {
            dragging = true;
            // 拖动开始：禁用过渡，瞬间收起为圆形，保证跟手
            button.style.transition = "none";
            labelEl.style.transition = "none";
            applyExpand(false);
        }
        if (dragging) {
            baseLeft = clampX(press.sx + dx);
            baseTop = clampY(press.sy + dy);
            button.style.left = baseLeft + "px";
            button.style.top = baseTop + "px";
        }
    });

    const endPress = (e, cancelled) => {
        if (!press) return;
        const wasDrag = dragging;
        press = null;
        dragging = false;
        button.style.cursor = "pointer";
        button.style.transition = "";
        labelEl.style.transition = "";
        try { button.releasePointerCapture(e.pointerId); } catch (err) {}
        if (cancelled) return;
        if (wasDrag) {
            try { localStorage.setItem(POS_KEY, JSON.stringify({ left: baseLeft, top: baseTop })); } catch (err) {}
            // 松手后指针仍在按钮上时恢复展开态
            if (button.matches(":hover")) applyExpand(true);
        } else {
            toggleAssetPanel();
        }
    };

    button.addEventListener("pointerup", (e) => endPress(e, false));
    button.addEventListener("pointercancel", (e) => endPress(e, true));

    // 窗口尺寸变化时把按钮拉回可视范围
    window.addEventListener("resize", () => {
        baseLeft = clampX(baseLeft);
        baseTop = clampY(baseTop);
        if (hoverOn) {
            applyExpand(false);
            applyExpand(true);
        } else if (!dragging) {
            button.style.left = baseLeft + "px";
            button.style.top = baseTop + "px";
        }
    });

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
    title.textContent = "保存文件到资产库";
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

                // 监听输出文件夹变化事件（后端监测线程推送，实时同步到面板）
                api.addEventListener("wp_output_changed", (event) => {
                    console.log("[WP资产库] 输出文件夹发生变化:", event.detail);
                    if (assetPanelVisible && outputViewEnabled) {
                        // 静默刷新：保留当前子文件夹选中与搜索词
                        loadOutputCategories(true);
                    }
                });
            }
        },
        
        init: function() {
            initAssetLibrary();
            // 添加画布拖放处理器
            setupCanvasDropHandler();
        }
    });
}

init();

// 按文件类型精确匹配的 widget 候选名
function wpExactWidgetNames(fileType) {
    const names = {
        "image": ["image", "image_upload", "filename", "file", "path"],
        "video": ["video", "filename", "file", "path", "image"],
        "audio": ["audio", "filename", "file", "path", "image"],
        "text":  ["文本", "text", "string", "value", "prompt", "content", "multiline"]
    };
    return names[fileType] || names["image"];
}

// 模糊匹配关键词：widget 名包含即命中，解决第三方节点命名不统一导致拖放失效的问题
function wpWidgetKeywords(fileType) {
    const kws = {
        "image": ["image", "img", "photo", "picture", "图"],
        "video": ["video", "视频"],
        "audio": ["audio", "音频"],
        "text":  ["text", "文本", "string", "内容", "content", "prompt", "提示"]
    };
    return kws[fileType] || kws["image"];
}

// 在节点 widgets 中查找匹配文件类型的 widget：先精确名匹配，再关键词模糊匹配
function wpFindWidgetForFile(node, fileType) {
    if (!node || !node.widgets) return null;
    for (const wName of wpExactWidgetNames(fileType)) {
        const w = node.widgets.find(w => w.name === wName);
        if (w) return w;
    }
    const kws = wpWidgetKeywords(fileType);
    for (const w of node.widgets) {
        if (!w.name) continue;
        const lower = w.name.toLowerCase();
        if (kws.some(k => lower.includes(k.toLowerCase()))) return w;
    }
    return null;
}

// 拖拽注入媒体文件后对齐官方上传路径的收尾动作，否则前端缓存的 input 文件清单
// 不含新文件，切换画布时会误报"缺少输入：所需的媒体输入未选择文件"（节点变红）
function wpSyncMediaWidgetAfterInject(node, widget, fileName, oldValue) {
    // 与官方 addToComboValues 一致：把文件名加入 combo 下拉选项
    try {
        if (widget.options) {
            if (!widget.options.values) widget.options.values = [];
            if (!widget.options.values.includes(fileName)) {
                widget.options.values.push(fileName);
            }
        }
    } catch (err) {
        console.warn("[WP资产库] 更新下拉选项失败:", err);
    }
    // 与官方 onUploadComplete 一致：通知节点 widget 已变化，让 Vue 侧状态同步
    try {
        if (typeof node.onWidgetChanged === "function") {
            node.onWidgetChanged(widget.name, fileName, oldValue, widget);
        }
    } catch (err) {
        console.warn("[WP资产库] 通知节点widget变化失败:", err);
    }
    // 与官方 useNodeImageUpload 一致：失效 assetsStore 的 input 列表缓存并重新拉取
    try {
        const vueApp = document.getElementById("vue-app")?.__vue_app__;
        const pinia = vueApp?.config?.globalProperties?.$pinia;
        const assetsStore = pinia?._s?.get("assets");
        if (assetsStore?.inputAssets?.invalidate) {
            assetsStore.inputAssets.invalidate();
        }
    } catch (err) {
        console.warn("[WP资产库] 刷新input文件列表缓存失败:", err);
    }
}

// 设置画布拖放处理器——支持从资产库拖拽文件到画布
function setupCanvasDropHandler() {
    const currentApp = getApp();
    if (!currentApp || !currentApp.canvas) {
        setTimeout(setupCanvasDropHandler, 1000);
        return;
    }
    
    const canvasEl = currentApp.canvas.canvas;
    if (!canvasEl) {
        setTimeout(setupCanvasDropHandler, 1000);
        return;
    }
    
    // 避免重复绑定
    if (canvasEl._wpAssetDropHandler) return;
    canvasEl._wpAssetDropHandler = true;
    
    // 根据文件类型获取最佳节点类型名称
    function getNodeTypeForFile(fileType) {
        const candidates = {
            "image":  ["LoadImage"],
            "video":  ["VHS_LoadVideo", "VHS_LoadVideoPath", "LoadVideo", "LoadImage"],
            "audio":  ["VHS_LoadAudio", "VHS_LoadAudioPath", "LoadAudio", "LoadImage"],
            "text":   ["WP_TextBox", "LoadImage"]
        };
        const types = candidates[fileType] || ["LoadImage"];
        for (const t of types) {
            if (LiteGraph.registered_node_types && LiteGraph.registered_node_types[t]) {
                console.log("[WP资产库] 为文件类型", fileType, "选择节点:", t);
                return t;
            }
        }
        console.log("[WP资产库] 文件类型", fileType, "未找到专用节点，回退到 LoadImage");
        return "LoadImage";
    }
    
    canvasEl.addEventListener("dragover", (e) => {
        if (e.dataTransfer.types.includes("application/x-wp-asset")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        }
    });
    
    canvasEl.addEventListener("drop", async (e) => {
        const wpData = e.dataTransfer.getData("application/x-wp-asset");
        if (!wpData) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        try {
            const assetData = JSON.parse(wpData);
            const assetId = assetData.assetId;
            const fileType = assetData.fileType || "image";

            // 按来源（素材库资产 / 输出文件夹文件）构造接口端点
            const isOutput = assetData.type === "wp_output" && !!assetData.path;
            const textUrl = isOutput
                ? `${ASSET_API_BASE}/output/text?path=${encodeURIComponent(assetData.path)}`
                : `${ASSET_API_BASE}/text/${assetId}`;
            const copyUrl = isOutput
                ? `${ASSET_API_BASE}/output/copy_to_input`
                : `${ASSET_API_BASE}/asset/${assetId}/copy_to_input`;
            const copyOptions = isOutput
                ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: assetData.path }) }
                : { method: 'POST' };

            // 文本类型：读取内容，创建 WP_TextBox 并注入
            if (fileType === "text") {
                const textResp = await fetch(textUrl);
                const textData = await textResp.json();
                
                if (!textData.success || textData.content === undefined) {
                    console.error("[WP资产库] 读取文本内容失败:", textData.error);
                    return;
                }
                
                const currentApp = getApp();
                if (!currentApp) return;
                
                const node = LiteGraph.createNode("WP_TextBox");
                if (!node) return;
                
                const canvas = currentApp.canvas;
                const rect = canvasEl.getBoundingClientRect();
                const scale = canvas.ds?.scale || 1;
                const offset = canvas.ds?.offset || [0, 0];
                
                node.pos = [
                    (e.clientX - rect.left) / scale - offset[0],
                    (e.clientY - rect.top) / scale - offset[1]
                ];
                currentApp.graph.add(node);
                
                setTimeout(() => {
                    const widget = wpFindWidgetForFile(node, "text");
                    if (widget) {
                        widget.value = textData.content;
                        if (widget.callback) widget.callback(widget.value);
                    }
                    node.setSize(node.computeSize());
                    node.setDirtyCanvas(true, true);
                }, 50);
                
                return;
            }
            
            // 复制文件到 input 目录
            const copyResponse = await fetch(copyUrl, copyOptions);
            
            if (!copyResponse.ok) {
                console.error("[WP资产库] 复制文件失败");
                return;
            }
            
            const result = await copyResponse.json();
            if (!result.success || !result.file_name) {
                console.error("[WP资产库] 复制文件失败:", result.error);
                return;
            }
            
            const currentApp = getApp();
            if (!currentApp) return;
            
            // 根据文件类型创建对应节点
            const nodeType = getNodeTypeForFile(fileType);
            const node = LiteGraph.createNode(nodeType);
            if (!node) return;
            
            // 获取鼠标在画布上的位置
            const canvas = currentApp.canvas;
            const rect = canvasEl.getBoundingClientRect();
            const scale = canvas.ds?.scale || 1;
            const offset = canvas.ds?.offset || [0, 0];
            
            let posX = (e.clientX - rect.left) / scale - offset[0];
            let posY = (e.clientY - rect.top) / scale - offset[1];
            
            node.pos = [posX, posY];
            currentApp.graph.add(node);
            
            // 设置文件名到对应的 widget
            setTimeout(() => {
                const widget = wpFindWidgetForFile(node, fileType);
                if (widget) {
                    const oldValue = widget.value;
                    widget.value = result.file_name;
                    if (widget.callback) widget.callback(widget.value);
                    wpSyncMediaWidgetAfterInject(node, widget, result.file_name, oldValue);
                }
                node.setSize(node.computeSize());
                node.setDirtyCanvas(true, true);
            }, 50);
            
        } catch (error) {
            console.error("[WP资产库] 拖放处理失败:", error);
        }
    });
    
    console.log("[WP资产库] 画布拖放处理器已设置");
}

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
        
        // 批量生成多张图时，取用户当前查看/悬停的那张，而非固定第一张
        let imgIdx = 0;
        if (typeof node.imageIndex === "number" && node.imageIndex >= 0) {
            imgIdx = node.imageIndex;
        } else if (typeof node.overIndex === "number" && node.overIndex >= 0) {
            imgIdx = node.overIndex;
        }
        
        // 方法1: 从节点的输出槽获取图像
        if (node.outputs) {
            for (const output of node.outputs) {
                if (output.slot_index !== undefined && output.type === "IMAGE") {
                    // 尝试从节点的预览元素中找图片
                    const previewImg = node.imgs?.[imgIdx];
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
            const safeIdx = Math.min(imgIdx, node.imgs.length - 1);
            imgElement = node.imgs[safeIdx];
            imageUrl = node.imgs[safeIdx].src;
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

        if (!assetName) {
            alert("请输入资产名称");
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

// ========== 存储设置（素材库位置配置与迁移） ==========

const WP_STORAGE_STAGE_LABELS = {
    copy: "正在复制文件",
    verify: "正在校验文件完整性",
    finalize: "正在更新配置",
    cleanup: "正在清理旧位置",
    done: "迁移完成",
    error: "迁移失败"
};

const WP_STORAGE_STYLES = {
    pathBox: `
        background: #1a1a1a; border: 1px solid #444; border-radius: 6px;
        padding: 8px 12px; color: #9d8cd6; font-size: 12px;
        font-family: Consolas, Monaco, 'Courier New', monospace;
        word-break: break-all; user-select: text;
    `,
    pathInput: `
        flex: 1; padding: 8px 12px; background: #1a1a1a; border: 1px solid #444;
        border-radius: 6px; color: #fff; font-size: 12px; outline: none;
        font-family: Consolas, Monaco, 'Courier New', monospace; min-width: 0;
    `,
    primaryBtn: `
        background: #662ad5; border: none; color: #fff; padding: 8px 18px;
        border-radius: 6px; cursor: pointer; font-size: 13px;
    `,
    secondaryBtn: `
        background: #444; border: none; color: #fff; padding: 8px 16px;
        border-radius: 6px; cursor: pointer; font-size: 13px;
    `,
    warningBox: `
        background: rgba(255,193,7,0.1); border: 1px solid rgba(255,193,7,0.35);
        color: #ffc107; padding: 10px 12px; border-radius: 6px;
        font-size: 12px; line-height: 1.7; margin-bottom: 6px; word-break: break-all;
    `,
    errorBox: `
        background: rgba(220,53,69,0.1); border: 1px solid rgba(220,53,69,0.35);
        color: #f0778a; padding: 10px 12px; border-radius: 6px;
        font-size: 12px; line-height: 1.7; margin-bottom: 6px; word-break: break-all;
    `,
    successBox: `
        background: rgba(40,167,69,0.1); border: 1px solid rgba(40,167,69,0.35);
        color: #4cd07d; padding: 12px 14px; border-radius: 6px;
        font-size: 13px; margin-bottom: 6px; line-height: 1.7;
    `
};

function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return "未知";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, b = bytes;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b : b.toFixed(1)) + " " + units[i];
}

function wpCopyText(text, btn) {
    const orig = btn.textContent;
    const markDone = () => {
        btn.textContent = "✅ 已复制";
        setTimeout(() => { btn.textContent = orig; }, 1500);
    };
    const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* 忽略 */ }
        document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(markDone).catch(() => { fallback(); markDone(); });
    } else {
        fallback();
        markDone();
    }
}

function wpMakeLabel(text) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "color:#bbb;font-size:12px;margin:12px 0 6px 0;";
    return el;
}

function wpMakePathRow(path) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:stretch;";
    const box = document.createElement("div");
    box.style.cssText = WP_STORAGE_STYLES.pathBox + "flex:1;";
    box.textContent = path;
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "📋 复制";
    copyBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn + "white-space:nowrap;";
    copyBtn.onclick = () => wpCopyText(path, copyBtn);
    row.appendChild(box);
    row.appendChild(copyBtn);
    return row;
}

async function refreshAssetPanel() {
    try {
        await loadProjects();
        if (currentProjectId) {
            const sel = document.getElementById("wp-asset-project-select");
            if (sel) sel.value = currentProjectId;
            await selectProject(currentProjectId);
        }
    } catch (e) {
        console.error("[WP资产库] 刷新资产库失败:", e);
    }
}

// 存储设置主入口
async function showStorageSettingsDialog() {
    document.querySelectorAll('.wp-storage-overlay').forEach(el => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "wp-storage-overlay";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.7); z-index: 10002;
        display: flex; align-items: center; justify-content: center;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
        background: #2a2a2a; border-radius: 12px; width: 580px; max-width: 92vw;
        max-height: 85vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid #444;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const header = document.createElement("div");
    header.style.cssText = `
        padding: 12px 16px; display: flex; justify-content: space-between;
        align-items: center; border-bottom: 1px solid #444;
    `;
    const title = document.createElement("span");
    title.textContent = "⚙ 存储设置";
    title.style.cssText = "color:#fff;font-size:15px;font-weight:600;";
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "✕";
    closeBtn.style.cssText = `
        background: #555; border: none; color: #fff; width: 28px; height: 28px;
        border-radius: 50%; cursor: pointer; font-size: 14px;
    `;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.style.cssText = `
        flex: 1; overflow-y: auto; padding: 18px 20px; color: #ddd; font-size: 13px;
    `;
    body.innerHTML = `<div style="color:#888;text-align:center;padding:50px 0;">⏳ 正在读取存储信息…</div>`;

    dialog.appendChild(header);
    dialog.appendChild(body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };

    // 读取存储信息与迁移状态
    let info = null, status = null;
    try {
        const [infoResp, statusResp] = await Promise.all([
            fetch(`${ASSET_API_BASE}/storage/info`),
            fetch(`${ASSET_API_BASE}/storage/migration_status`)
        ]);
        info = await infoResp.json();
        status = await statusResp.json();
    } catch (e) {
        body.innerHTML = "";
        const errBox = document.createElement("div");
        errBox.style.cssText = WP_STORAGE_STYLES.errorBox;
        errBox.textContent = "❌ 读取存储信息失败：" + e.message;
        body.appendChild(errBox);
        return;
    }

    // 已有迁移在进行（例如页面刷新过）：直接显示进度
    if (status && status.migrating) {
        renderMigrationProgress(body, overlay, info);
        return;
    }

    renderStorageMainView(body, overlay, info);
}

// 主视图：已配置显示路径信息；未配置/失效则进入配置表单
function renderStorageMainView(body, overlay, info) {
    body.innerHTML = "";

    if (info.configured && info.accessible) {
        const okBox = document.createElement("div");
        okBox.style.cssText = WP_STORAGE_STYLES.successBox;
        okBox.textContent = "✅ 素材库存储位置已配置";
        body.appendChild(okBox);

        body.appendChild(wpMakeLabel("当前素材库路径"));
        body.appendChild(wpMakePathRow(info.path));

        const stats = document.createElement("div");
        stats.style.cssText = "color:#888;font-size:12px;margin:12px 0 0 0;";
        stats.textContent = `素材 ${info.asset_count} 个 · 文件 ${info.file_count} 个 · 占用 ${formatBytes(info.size_bytes)}`
            + (info.free_bytes !== null && info.free_bytes !== undefined ? ` · 所在磁盘剩余 ${formatBytes(info.free_bytes)}` : "");
        body.appendChild(stats);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;justify-content:space-between;margin-top:24px;";
        const rebindBtn = document.createElement("button");
        rebindBtn.textContent = "🔗 重新绑定路径";
        rebindBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
        rebindBtn.onclick = () => renderStorageRebindView(body, overlay, info);
        const rightBtns = document.createElement("div");
        rightBtns.style.cssText = "display:flex;gap:10px;";
        const migrateBtn = document.createElement("button");
        migrateBtn.textContent = "📦 迁移到新位置";
        migrateBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn;
        migrateBtn.onclick = () => renderStorageChangeView(body, overlay, info);
        const closeBtn2 = document.createElement("button");
        closeBtn2.textContent = "关闭";
        closeBtn2.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
        closeBtn2.onclick = () => document.body.removeChild(overlay);
        rightBtns.appendChild(migrateBtn);
        rightBtns.appendChild(closeBtn2);
        btnRow.appendChild(rebindBtn);
        btnRow.appendChild(rightBtns);
        body.appendChild(btnRow);

        // 底部追加：ComfyUI 输出文件夹配置区
        renderOutputConfigSection(body);
        return;
    }

    renderStorageChangeView(body, overlay, info);
}

// 配置/迁移表单：路径输入 + 浏览 + 验证
function renderStorageChangeView(body, overlay, info) {
    body.innerHTML = "";

    const isBroken = info.configured && !info.accessible;
    const hasData = info.file_count > 0;

    // 顶部提示
    const tip = document.createElement("div");
    if (isBroken) {
        tip.style.cssText = WP_STORAGE_STYLES.errorBox;
        tip.innerHTML = `❌ 已配置的素材库路径无法访问（磁盘可能未连接）：<br>` +
            `<span style="font-family:Consolas,monospace;">${info.pointer_path}</span><br>` +
            `已临时回退到默认位置，请重新配置素材库位置：`;
    } else if (info.configured) {
        tip.style.cssText = WP_STORAGE_STYLES.warningBox;
        tip.textContent = `当前素材库共 ${info.asset_count} 个素材（约 ${formatBytes(info.size_bytes)}），将整体迁移到新位置。`;
    } else if (hasData) {
        tip.style.cssText = WP_STORAGE_STYLES.warningBox;
        tip.innerHTML = `尚未配置存储位置，素材目前保存在插件目录内（占用插件空间）：<br>` +
            `<span style="font-family:Consolas,monospace;">${info.default_path}</span><br>` +
            `配置后将把 ${info.asset_count} 个素材迁移到新位置。`;
    } else {
        tip.style.cssText = WP_STORAGE_STYLES.warningBox;
        tip.textContent = "尚未配置存储位置，当前使用插件目录内的默认位置。配置后素材将保存到独立位置，不再占用插件空间。";
    }
    body.appendChild(tip);

    // 路径输入行
    body.appendChild(wpMakeLabel("素材库存储位置"));
    const inputRow = document.createElement("div");
    inputRow.style.cssText = "display:flex;gap:8px;";
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.placeholder = "例如 D:\\WP素材库";
    pathInput.style.cssText = WP_STORAGE_STYLES.pathInput;
    const browseBtn = document.createElement("button");
    browseBtn.textContent = "📁 浏览…";
    browseBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn + "white-space:nowrap;";
    browseBtn.onclick = () => {
        showFolderBrowser((selected) => {
            pathInput.value = selected;
            validateStoragePath(selected, msgEl);
        });
    };
    inputRow.appendChild(pathInput);
    inputRow.appendChild(browseBtn);
    body.appendChild(inputRow);

    // 验证消息区
    const msgEl = document.createElement("div");
    msgEl.style.cssText = "min-height:20px;margin:8px 0 4px 0;font-size:12px;";
    body.appendChild(msgEl);

    const hint = document.createElement("div");
    hint.style.cssText = "color:#777;font-size:11px;margin-bottom:8px;";
    hint.textContent = "支持手动输入完整路径，或点击“浏览”选择。文件夹不存在时会自动创建。";
    body.appendChild(hint);

    // 按钮行
    const btnRow = document.createElement("div");
    btnRow.style.cssText = isBroken
        ? "display:flex;justify-content:space-between;gap:10px;margin-top:14px;"
        : "display:flex;justify-content:flex-end;gap:10px;margin-top:14px;";
    if (isBroken) {
        const rebindBtn = document.createElement("button");
        rebindBtn.textContent = "🔗 重新绑定路径";
        rebindBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
        rebindBtn.onclick = () => renderStorageRebindView(body, overlay, info);
        btnRow.appendChild(rebindBtn);
    }
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
    cancelBtn.onclick = () => {
        if (info.configured && info.accessible) {
            renderStorageMainView(body, overlay, info);
        } else {
            document.body.removeChild(overlay);
        }
    };
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = isBroken ? "重新配置" : (hasData ? "开始迁移" : "配置位置");
    confirmBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn;
    confirmBtn.onclick = () => confirmStorageLocation(body, overlay, info, pathInput.value.trim(), msgEl, confirmBtn);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    body.appendChild(btnRow);

    // 输入防抖验证
    let validateTimer = null;
    pathInput.oninput = () => {
        msgEl.textContent = "";
        clearTimeout(validateTimer);
        if (!pathInput.value.trim()) return;
        validateTimer = setTimeout(() => validateStoragePath(pathInput.value.trim(), msgEl), 600);
    };

    // 底部追加：ComfyUI 输出文件夹配置区
    renderOutputConfigSection(body);
}

async function validateStoragePath(path, msgEl) {
    try {
        const resp = await fetch(`${ASSET_API_BASE}/storage/validate_path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const v = await resp.json();
        if (v.valid) {
            if (!v.exists) {
                msgEl.style.color = "#4cd07d";
                msgEl.textContent = "✓ 路径有效，确认时将自动创建该文件夹";
            } else if (!v.is_empty) {
                msgEl.style.color = "#ffc107";
                msgEl.textContent = "⚠ 路径有效，但文件夹不为空（需选择空文件夹）";
            } else {
                msgEl.style.color = "#4cd07d";
                msgEl.textContent = "✓ 路径有效";
            }
        } else {
            msgEl.style.color = "#f0778a";
            msgEl.textContent = "✕ " + (v.error || "路径无效");
        }
    } catch (e) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ 验证失败：" + e.message;
    }
}

// 确认配置/迁移：验证 -> 二次确认 -> 调用后端 -> 进度或完成视图
async function confirmStorageLocation(body, overlay, info, path, msgEl, btn) {
    if (!path) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ 请先填写存储位置";
        return;
    }

    const origText = btn.textContent;
    const restoreBtn = () => { btn.disabled = false; btn.textContent = origText; };
    btn.disabled = true;
    btn.textContent = "验证中…";

    let v;
    try {
        const resp = await fetch(`${ASSET_API_BASE}/storage/validate_path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        v = await resp.json();
    } catch (e) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ 验证失败：" + e.message;
        restoreBtn();
        return;
    }

    if (!v.valid) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ " + (v.error || "路径无效");
        restoreBtn();
        return;
    }
    if (v.exists && !v.is_empty) {
        msgEl.style.color = "#ffc107";
        msgEl.textContent = "⚠ 目标文件夹不为空，请选择一个空文件夹（或新建一个）";
        restoreBtn();
        return;
    }

    // 二次确认
    const hasData = info.file_count > 0;
    const confirmMsg = hasData
        ? `即将把素材库迁移到：\n\n${v.path}\n\n共 ${info.file_count} 个文件（约 ${formatBytes(info.size_bytes)}）\n迁移完成前请勿关闭 ComfyUI。\n\n确定开始迁移吗？`
        : `即将设置素材库存储位置为：\n\n${v.path}\n\n确定吗？`;
    if (!confirm(confirmMsg)) {
        restoreBtn();
        return;
    }

    // 执行配置/迁移
    btn.textContent = "处理中…";
    let result;
    try {
        const resp = await fetch(`${ASSET_API_BASE}/storage/set_location`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: v.path })
        });
        result = await resp.json();
    } catch (e) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ 操作失败：" + e.message;
        restoreBtn();
        return;
    }

    if (!result.success) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ " + (result.error || "操作失败");
        restoreBtn();
        return;
    }

    if (result.mode === "migrating") {
        renderMigrationProgress(body, overlay, info, result.to);
    } else {
        renderStorageDoneView(body, overlay, "✅ 素材库位置已配置", result.to, null);
        refreshAssetPanel();
    }
}

// ========== 重新绑定路径（文件已就位、账本路径失效的场景） ==========

async function callRebindApi(path, dryRun) {
    const resp = await fetch(`${ASSET_API_BASE}/storage/rebind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path, dry_run: dryRun })
    });
    return await resp.json();
}

function renderRebindStats(v) {
    const parts = [];
    if (v.rebound > 0) parts.push(`<span style="color:#ffc107;">${v.rebound} 个路径失效待改写</span>`);
    if (v.valid > 0) parts.push(`${v.valid} 个路径已有效`);
    if (v.missing > 0) parts.push(`<span style="color:#f0778a;">${v.missing} 个文件缺失</span>`);
    let html = `共 ${v.total} 个素材：` + (parts.length ? parts.join("，") : "无");
    if (v.missing > 0 && v.missing_files && v.missing_files.length) {
        html += `<br>缺失文件（最多列 10 个）：<span style="font-family:Consolas,monospace;">${v.missing_files.join("、")}</span>`;
    }
    return html;
}

// 重新绑定视图：选路径 -> 检测 -> 执行
function renderStorageRebindView(body, overlay, info) {
    body.innerHTML = "";

    const tip = document.createElement("div");
    tip.style.cssText = WP_STORAGE_STYLES.warningBox;
    tip.innerHTML = `适用于：素材库文件夹被手动移动、或从其他电脑拷贝替换后，素材无法显示或拖拽失败。<br>` +
        `请选择素材库<b>当前实际所在</b>的文件夹（必须包含 assets.json）。<br>` +
        `重新绑定只改写素材记录中的失效路径，<b>不会移动、复制或删除任何文件</b>。`;
    body.appendChild(tip);

    if (info && info.pointer_path) {
        body.appendChild(wpMakeLabel("当前绑定的路径"));
        body.appendChild(wpMakePathRow(info.pointer_path));
    }

    body.appendChild(wpMakeLabel("素材库实际位置"));
    const inputRow = document.createElement("div");
    inputRow.style.cssText = "display:flex;gap:8px;";
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.placeholder = "例如 D:\\WP素材库（包含 assets.json 的文件夹）";
    pathInput.style.cssText = WP_STORAGE_STYLES.pathInput;
    const browseBtn = document.createElement("button");
    browseBtn.textContent = "📁 浏览…";
    browseBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn + "white-space:nowrap;";
    browseBtn.onclick = () => {
        showFolderBrowser((selected) => {
            pathInput.value = selected;
            msgEl.innerHTML = "";
            execBtn.disabled = true;
        });
    };
    inputRow.appendChild(pathInput);
    inputRow.appendChild(browseBtn);
    body.appendChild(inputRow);

    const msgEl = document.createElement("div");
    msgEl.style.cssText = "min-height:20px;margin:8px 0 4px 0;font-size:12px;line-height:1.7;";
    body.appendChild(msgEl);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:14px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
    cancelBtn.onclick = () => showStorageSettingsDialog();
    const checkBtn = document.createElement("button");
    checkBtn.textContent = "🔍 检测路径";
    checkBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
    const execBtn = document.createElement("button");
    execBtn.textContent = "🔗 执行重新绑定";
    execBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn;
    execBtn.disabled = true;
    checkBtn.onclick = () => previewRebind(pathInput.value.trim(), msgEl, checkBtn, execBtn);
    execBtn.onclick = () => executeRebind(body, overlay, pathInput.value.trim(), msgEl, execBtn);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(checkBtn);
    btnRow.appendChild(execBtn);
    body.appendChild(btnRow);

    pathInput.oninput = () => {
        msgEl.innerHTML = "";
        execBtn.disabled = true;
    };
}

// 检测（dry_run）：只统计不写入
async function previewRebind(path, msgEl, checkBtn, execBtn) {
    if (!path) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ 请先填写素材库实际位置";
        return;
    }
    const orig = checkBtn.textContent;
    checkBtn.disabled = true;
    checkBtn.textContent = "检测中…";
    try {
        const v = await callRebindApi(path, true);
        if (!v.success) {
            msgEl.style.color = "#f0778a";
            msgEl.textContent = "✕ " + (v.error || "路径无效");
            execBtn.disabled = true;
        } else {
            msgEl.style.color = "#4cd07d";
            msgEl.innerHTML = "✓ 检测通过，" + renderRebindStats(v);
            execBtn.disabled = false;
        }
    } catch (e) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ 检测失败：" + e.message;
        execBtn.disabled = true;
    }
    checkBtn.disabled = false;
    checkBtn.textContent = orig;
}

// 执行重新绑定：二次确认 -> 调后端 -> 结果视图
async function executeRebind(body, overlay, path, msgEl, btn) {
    const confirmMsg = `即将把素材库重新绑定到：\n\n${path}\n\n将改写素材记录中的失效路径，不会移动或删除任何文件。\n\n确定执行吗？`;
    if (!confirm(confirmMsg)) return;

    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "执行中…";
    try {
        const v = await callRebindApi(path, false);
        if (!v.success) {
            msgEl.style.color = "#f0778a";
            msgEl.textContent = "✕ " + (v.error || "重新绑定失败");
            btn.disabled = false;
            btn.textContent = orig;
            return;
        }
        renderRebindDoneView(body, overlay, v);
        refreshAssetPanel();
    } catch (e) {
        msgEl.style.color = "#f0778a";
        msgEl.textContent = "✕ 执行失败：" + e.message;
        btn.disabled = false;
        btn.textContent = orig;
    }
}

// 重新绑定完成视图（含统计与缺失文件提示）
function renderRebindDoneView(body, overlay, v) {
    body.innerHTML = "";

    const okBox = document.createElement("div");
    okBox.style.cssText = WP_STORAGE_STYLES.successBox;
    okBox.style.whiteSpace = "pre-line";
    let msg = "✅ 重新绑定完成";
    if (v.total !== undefined && v.total !== null) {
        msg += `\n共 ${v.total} 个素材：${v.rebound} 个已改写路径`;
        if (v.valid > 0) msg += `，${v.valid} 个原本就有效`;
        if (v.missing > 0) msg += `，${v.missing} 个文件缺失（文件可能未随库一起拷贝）`;
    }
    okBox.textContent = msg;
    body.appendChild(okBox);

    body.appendChild(wpMakeLabel("当前素材库路径"));
    body.appendChild(wpMakePathRow(v.path || ""));

    if (v.missing > 0 && v.missing_files && v.missing_files.length) {
        const warn = document.createElement("div");
        warn.style.cssText = WP_STORAGE_STYLES.warningBox;
        warn.textContent = "以下文件在新位置未找到：" + v.missing_files.join("、")
            + (v.missing > v.missing_files.length ? ` …等共 ${v.missing} 个` : "");
        body.appendChild(warn);
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;margin-top:22px;";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    btnRow.appendChild(closeBtn);
    body.appendChild(btnRow);
}

// 迁移进度视图（轮询后端状态）
function renderMigrationProgress(body, overlay, info, toPath) {
    body.innerHTML = "";

    const title = document.createElement("div");
    title.textContent = "📦 正在迁移素材库";
    title.style.cssText = "color:#fff;font-size:15px;font-weight:600;margin-bottom:12px;";
    body.appendChild(title);

    const pathInfo = document.createElement("div");
    pathInfo.style.cssText = "color:#888;font-size:11px;margin-bottom:14px;word-break:break-all;";
    pathInfo.innerHTML = `迁移至：<span style="font-family:Consolas,monospace;color:#9d8cd6;">${toPath || "读取中…"}</span>`;
    body.appendChild(pathInfo);

    const track = document.createElement("div");
    track.style.cssText = "height:14px;background:#1a1a1a;border-radius:7px;border:1px solid #444;overflow:hidden;";
    const fill = document.createElement("div");
    fill.style.cssText = "height:100%;width:0%;background:linear-gradient(90deg,#662ad5,#8a5cf6);transition:width 0.3s ease;";
    track.appendChild(fill);
    body.appendChild(track);

    const stageEl = document.createElement("div");
    stageEl.style.cssText = "display:flex;justify-content:space-between;margin-top:10px;color:#ccc;font-size:12px;";
    const stageLabel = document.createElement("span");
    stageLabel.textContent = "准备中…";
    const percentEl = document.createElement("span");
    percentEl.textContent = "0%";
    stageEl.appendChild(stageLabel);
    stageEl.appendChild(percentEl);
    body.appendChild(stageEl);

    const fileEl = document.createElement("div");
    fileEl.style.cssText = "color:#777;font-size:11px;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    body.appendChild(fileEl);

    const statsEl = document.createElement("div");
    statsEl.style.cssText = "color:#777;font-size:11px;margin-top:4px;";
    body.appendChild(statsEl);

    const note = document.createElement("div");
    note.style.cssText = "color:#888;font-size:11px;margin-top:20px;line-height:1.8;white-space:pre-line;";
    note.textContent = "· 迁移完成前原素材库不会被删除\n· 可关闭此窗口，迁移会在后台继续（重新打开设置可查看进度）\n· 迁移期间请勿关闭 ComfyUI";
    body.appendChild(note);

    let sawMigrating = false;
    let noSignalCount = 0;

    async function poll() {
        let st;
        try {
            const resp = await fetch(`${ASSET_API_BASE}/storage/migration_status`);
            st = await resp.json();
            noSignalCount = 0;
        } catch (e) {
            noSignalCount++;
            if (noSignalCount >= 8) {
                renderStorageErrorView(body, overlay, "网络异常，无法获取迁移进度。迁移可能仍在后台进行，请稍后重新打开设置查看结果。");
                return;
            }
            setTimeout(poll, 800);
            return;
        }

        if (st.migrating) {
            sawMigrating = true;
            if (st.to_path && pathInfo.dataset.set !== "1") {
                pathInfo.innerHTML = `迁移至：<span style="font-family:Consolas,monospace;color:#9d8cd6;">${st.to_path}</span>`;
                pathInfo.dataset.set = "1";
            }
            fill.style.width = (st.percent || 0) + "%";
            percentEl.textContent = (st.percent || 0) + "%";
            stageLabel.textContent = WP_STORAGE_STAGE_LABELS[st.stage] || st.message || "处理中…";
            fileEl.textContent = st.current_file ? "📄 " + st.current_file : "";
            if (st.total_files) {
                statsEl.textContent = `已复制 ${st.copied_files || 0}/${st.total_files} 个文件 · ${formatBytes(st.copied_bytes || 0)} / ${formatBytes(st.total_bytes || 0)}`;
            }
            setTimeout(poll, 600);
        } else if (sawMigrating || st.stage === "done" || st.stage === "error") {
            if (st.stage === "done") {
                renderStorageDoneView(body, overlay, "✅ 迁移完成", st.to_path, st);
                refreshAssetPanel();
            } else {
                renderStorageErrorView(body, overlay, st.error || st.message || "未知错误");
            }
        } else {
            // 迁移线程刚启动还未上报状态，继续等待
            noSignalCount++;
            if (noSignalCount >= 20) {
                renderStorageErrorView(body, overlay, "迁移任务未能启动，请重新尝试。");
                return;
            }
            setTimeout(poll, 500);
        }
    }
    poll();
}

// 完成视图
function renderStorageDoneView(body, overlay, titleText, newPath, st) {
    body.innerHTML = "";

    const okBox = document.createElement("div");
    okBox.style.cssText = WP_STORAGE_STYLES.successBox;
    let msg = titleText;
    if (st && st.total_files) {
        msg += `\n共迁移 ${st.total_files} 个文件（${formatBytes(st.total_bytes)}）`;
    }
    okBox.textContent = msg;
    okBox.style.whiteSpace = "pre-line";
    body.appendChild(okBox);

    body.appendChild(wpMakeLabel("当前素材库路径"));
    body.appendChild(wpMakePathRow(newPath || ""));

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;margin-top:22px;";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    btnRow.appendChild(closeBtn);
    body.appendChild(btnRow);
}

// 失败视图（原数据不受影响）
function renderStorageErrorView(body, overlay, errorMsg) {
    body.innerHTML = "";

    const errBox = document.createElement("div");
    errBox.style.cssText = WP_STORAGE_STYLES.errorBox;
    errBox.textContent = `❌ ${errorMsg}\n\n原素材库数据未受影响，可重新尝试迁移。`;
    errBox.style.whiteSpace = "pre-line";
    body.appendChild(errBox);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:22px;";
    const backBtn = document.createElement("button");
    backBtn.textContent = "返回设置";
    backBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
    backBtn.onclick = () => showStorageSettingsDialog();
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    btnRow.appendChild(backBtn);
    btnRow.appendChild(closeBtn);
    body.appendChild(btnRow);
}

// ========== ComfyUI 输出文件夹配置区（存储设置弹窗底部） ==========

async function renderOutputConfigSection(body) {
    // 避免重复渲染
    body.querySelector(".wp-output-config-section")?.remove();

    const section = document.createElement("div");
    section.className = "wp-output-config-section";
    section.style.cssText = "margin-top:24px;padding-top:16px;border-top:1px solid #444;";
    body.appendChild(section);

    const title = document.createElement("div");
    title.textContent = "📤 ComfyUI 输出文件夹监控";
    title.style.cssText = "color:#fff;font-size:14px;font-weight:600;margin-bottom:8px;";
    section.appendChild(title);

    const desc = document.createElement("div");
    desc.style.cssText = "color:#888;font-size:12px;margin-bottom:12px;";
    desc.textContent = "监控 ComfyUI 的输出目录，新生成的图片/视频会实时出现在素材库的「📤 ComfyUI 输出」项目中，可直接拖入画布使用（不影响素材库本身的文件）。";
    section.appendChild(desc);

    let config = null;
    try {
        const resp = await fetch(`${ASSET_API_BASE}/output/config`);
        config = await resp.json();
    } catch (e) {
        const errBox = document.createElement("div");
        errBox.style.cssText = WP_STORAGE_STYLES.errorBox;
        errBox.textContent = "❌ 读取输出文件夹配置失败：" + e.message;
        section.appendChild(errBox);
        return;
    }

    // 内容容器（配置操作后局部刷新，不重绘整个弹窗）
    const content = document.createElement("div");
    section.appendChild(content);

    const renderContent = (cfg) => {
        content.innerHTML = "";

        if (cfg.configured) {
            // 已配置：状态 + 路径 + 统计 + 操作按钮
            const statusBox = document.createElement("div");
            if (cfg.status === "watching" && cfg.accessible) {
                statusBox.style.cssText = WP_STORAGE_STYLES.successBox;
                statusBox.textContent = "✅ 正在实时监控（自动检测新增/修改/删除）";
            } else if (!cfg.accessible) {
                statusBox.style.cssText = WP_STORAGE_STYLES.errorBox;
                statusBox.textContent = "❌ 输出文件夹无法访问，请检查磁盘或更改路径";
            } else {
                statusBox.style.cssText = WP_STORAGE_STYLES.warningBox;
                statusBox.textContent = "⚠ 监控未运行";
            }
            content.appendChild(statusBox);

            content.appendChild(wpMakeLabel("输出文件夹路径"));
            content.appendChild(wpMakePathRow(cfg.path));

            const stats = document.createElement("div");
            stats.style.cssText = "color:#888;font-size:12px;margin-top:8px;";
            let statsText = `当前文件 ${cfg.file_count} 个`;
            if (cfg.last_change) {
                try {
                    statsText += ` · 最近变化 ${new Date(cfg.last_change).toLocaleString()}`;
                } catch (e) {}
            }
            stats.textContent = statsText;
            content.appendChild(stats);

            const btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:10px;margin-top:14px;";

            const changeBtn = document.createElement("button");
            changeBtn.textContent = "🔄 更改路径";
            changeBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
            changeBtn.onclick = () => {
                showFolderBrowser(async (selected) => {
                    const latest = await wpSetOutputPath(selected);
                    if (latest) {
                        loadProjects();
                        renderContent(latest);
                    }
                });
            };

            const stopBtn = document.createElement("button");
            stopBtn.textContent = "⏹ 停止监控";
            stopBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
            stopBtn.onclick = async () => {
                if (!confirm("停止监控并从素材库移除「📤 ComfyUI 输出」项目？\n（只取消监控，不会删除任何文件）")) return;
                const latest = await wpSetOutputPath("");
                if (latest) {
                    // 若当前正处于输出视图，切回第一个普通项目
                    if (outputViewEnabled) {
                        setOutputViewMode(false);
                    }
                    await loadProjects();
                    renderContent(latest);
                }
            };

            btnRow.appendChild(changeBtn);
            btnRow.appendChild(stopBtn);
            content.appendChild(btnRow);
        } else {
            // 未配置：自动检测建议 + 手动选择
            if (cfg.detected_path) {
                const suggestBox = document.createElement("div");
                suggestBox.style.cssText = WP_STORAGE_STYLES.successBox;
                suggestBox.innerHTML = `🤖 自动检测到 ComfyUI 输出目录：<br>` +
                    `<span style="font-family:Consolas,monospace;">${cfg.detected_path}</span>`;
                content.appendChild(suggestBox);

                const useBtn = document.createElement("button");
                useBtn.textContent = "✓ 使用此路径";
                useBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn + "margin-top:10px;";
                useBtn.onclick = async () => {
                    const latest = await wpSetOutputPath(cfg.detected_path);
                    if (latest) {
                        loadProjects();
                        renderContent(latest);
                    }
                };
                content.appendChild(useBtn);
            }

            const manualBtn = document.createElement("button");
            manualBtn.textContent = "📁 手动选择文件夹…";
            manualBtn.style.cssText = (cfg.detected_path ? WP_STORAGE_STYLES.secondaryBtn : WP_STORAGE_STYLES.primaryBtn) + "margin-top:10px;";
            manualBtn.onclick = () => {
                showFolderBrowser(async (selected) => {
                    const latest = await wpSetOutputPath(selected);
                    if (latest) {
                        loadProjects();
                        renderContent(latest);
                    }
                });
            };
            content.appendChild(manualBtn);
        }
    };

    renderContent(config);
}

// 设置输出文件夹路径（成功返回最新配置，失败返回 null 并提示）
async function wpSetOutputPath(path) {
    try {
        const resp = await fetch(`${ASSET_API_BASE}/output/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path })
        });
        const result = await resp.json();
        if (result.success) {
            // 重新读取完整配置状态（含 file_count / status 等）
            const cfgResp = await fetch(`${ASSET_API_BASE}/output/config`);
            return await cfgResp.json();
        }
        alert("设置失败: " + (result.error || "未知错误"));
        return null;
    } catch (e) {
        alert("设置失败: " + e.message);
        return null;
    }
}

// 服务器文件夹浏览器（选盘符 → 逐级进入 → 选定/新建文件夹）
function showFolderBrowser(onSelect) {
    document.querySelectorAll('.wp-folder-browser-overlay').forEach(el => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "wp-folder-browser-overlay";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.6); z-index: 10003;
        display: flex; align-items: center; justify-content: center;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
        background: #2a2a2a; border-radius: 12px; width: 520px; max-width: 92vw;
        display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid #444;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const header = document.createElement("div");
    header.style.cssText = `
        padding: 12px 16px; display: flex; justify-content: space-between;
        align-items: center; border-bottom: 1px solid #444;
    `;
    const title = document.createElement("span");
    title.textContent = "📁 选择文件夹";
    title.style.cssText = "color:#fff;font-size:15px;font-weight:600;";
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "✕";
    closeBtn.style.cssText = `
        background: #555; border: none; color: #fff; width: 28px; height: 28px;
        border-radius: 50%; cursor: pointer; font-size: 14px;
    `;
    closeBtn.onclick = () => document.body.removeChild(overlay);
    header.appendChild(title);
    header.appendChild(closeBtn);

    // 路径栏
    const pathBar = document.createElement("div");
    pathBar.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 10px 16px; border-bottom: 1px solid #444;
    `;
    const upBtn = document.createElement("button");
    upBtn.textContent = "⬆ 上级";
    upBtn.style.cssText = `
        background: #444; border: none; color: #fff; padding: 4px 10px;
        border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap;
    `;
    const pathLabel = document.createElement("span");
    pathLabel.style.cssText = `
        flex: 1; color: #9d8cd6; font-size: 12px;
        font-family: Consolas, Monaco, monospace; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
    `;
    pathLabel.textContent = "我的电脑（选择磁盘）";
    pathBar.appendChild(upBtn);
    pathBar.appendChild(pathLabel);

    // 文件夹列表
    const listEl = document.createElement("div");
    listEl.style.cssText = `
        flex: 1; min-height: 280px; max-height: 50vh; overflow-y: auto;
        padding: 6px 0;
    `;

    // 底部按钮
    const footer = document.createElement("div");
    footer.style.cssText = `
        display: flex; justify-content: flex-end; gap: 10px;
        padding: 12px 16px; border-top: 1px solid #444;
    `;
    const newFolderBtn = document.createElement("button");
    newFolderBtn.textContent = "📁 新建文件夹";
    newFolderBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = WP_STORAGE_STYLES.secondaryBtn;
    const selectBtn = document.createElement("button");
    selectBtn.textContent = "✔ 选定此位置";
    selectBtn.style.cssText = WP_STORAGE_STYLES.primaryBtn;
    footer.appendChild(newFolderBtn);
    footer.appendChild(cancelBtn);
    footer.appendChild(selectBtn);

    let currentPath = "";
    let selectedPath = null;

    function highlightRow(row) {
        [...listEl.children].forEach(c => {
            c.style.background = "transparent";
            delete c.dataset.selected;
        });
        row.style.background = "rgba(102,42,213,0.3)";
        row.dataset.selected = "1";
    }

    async function loadDir(path) {
        listEl.innerHTML = `<div style="color:#888;text-align:center;padding:30px 0;">⏳ 加载中…</div>`;
        selectedPath = null;
        try {
            const url = path
                ? `${ASSET_API_BASE}/storage/browse?path=${encodeURIComponent(path)}`
                : `${ASSET_API_BASE}/storage/browse`;
            const resp = await fetch(url);
            const data = await resp.json();
            if (data.error) {
                listEl.innerHTML = `<div style="color:#f0778a;padding:16px;">❌ ${data.error}</div>`;
                return;
            }
            currentPath = data.path || "";
            pathLabel.textContent = currentPath || "我的电脑（选择磁盘）";
            upBtn.style.visibility = currentPath ? "visible" : "hidden";
            upBtn.onclick = () => loadDir((data.parent !== null && data.parent !== undefined) ? data.parent : "");

            listEl.innerHTML = "";
            const entries = [];
            (data.drives || []).forEach(d => entries.push({ name: d, path: d, isDrive: true }));
            (data.dirs || []).forEach(d => entries.push({
                name: d,
                path: currentPath.replace(/[\\/]+$/, "") + "\\" + d,
                isDrive: false
            }));

            if (entries.length === 0) {
                listEl.innerHTML = `<div style="color:#888;text-align:center;padding:30px 0;">此文件夹内没有子文件夹</div>`;
            }

            entries.forEach(entry => {
                const row = document.createElement("div");
                row.style.cssText = `
                    display: flex; align-items: center; gap: 8px;
                    padding: 8px 16px; cursor: pointer; font-size: 13px; color: #ddd;
                `;
                row.onmouseover = () => { if (!row.dataset.selected) row.style.background = "rgba(102,42,213,0.12)"; };
                row.onmouseout = () => { if (!row.dataset.selected) row.style.background = "transparent"; };
                const icon = document.createElement("span");
                icon.textContent = entry.isDrive ? "💽" : "📁";
                const nameSpan = document.createElement("span");
                nameSpan.textContent = entry.name;
                row.appendChild(icon);
                row.appendChild(nameSpan);

                row.onclick = () => {
                    selectedPath = entry.path;
                    highlightRow(row);
                };
                row.ondblclick = () => loadDir(entry.path);

                listEl.appendChild(row);
            });
        } catch (e) {
            listEl.innerHTML = `<div style="color:#f0778a;padding:16px;">❌ 加载失败：${e.message}</div>`;
        }
    }

    newFolderBtn.onclick = async () => {
        if (!currentPath) {
            alert("请先进入一个磁盘和文件夹，再新建子文件夹");
            return;
        }
        const name = prompt("请输入新文件夹名称：");
        if (!name || !name.trim()) return;
        try {
            const resp = await fetch(`${ASSET_API_BASE}/storage/create_folder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent: currentPath, name: name.trim() })
            });
            const result = await resp.json();
            if (result.success) {
                await loadDir(currentPath);
                selectedPath = result.path;
                [...listEl.children].forEach(c => {
                    const span = c.querySelector("span:last-child");
                    if (span && span.textContent === name.trim()) highlightRow(c);
                });
            } else {
                alert("新建失败：" + (result.error || "未知错误"));
            }
        } catch (e) {
            alert("新建失败：" + e.message);
        }
    };

    selectBtn.onclick = () => {
        const target = selectedPath || currentPath;
        if (!target) {
            alert("请先选择一个磁盘并进入文件夹");
            return;
        }
        document.body.removeChild(overlay);
        if (onSelect) onSelect(target);
    };

    cancelBtn.onclick = () => document.body.removeChild(overlay);

    dialog.appendChild(header);
    dialog.appendChild(pathBar);
    dialog.appendChild(listEl);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };

    loadDir("");
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
        
        // 查找画布上指定位置是否有支持该文件类型的节点
        function findNodeAt(clientX, clientY, fileType) {
            const worldPos = currentApp.canvas.convertEventToCanvasOffset({
                clientX: clientX,
                clientY: clientY
            });
            
            const node = currentApp.graph.getNodeOnPos(worldPos[0], worldPos[1]);
            if (node && wpFindWidgetForFile(node, fileType)) {
                return node;
            }
            
            // 备用：手动遍历所有节点查找
            const allNodes = currentApp.graph._nodes || [];
            for (const n of allNodes) {
                if (worldPos[0] >= n.pos[0] && worldPos[0] <= n.pos[0] + n.size[0] &&
                    worldPos[1] >= n.pos[1] && worldPos[1] <= n.pos[1] + n.size[1]) {
                    if (wpFindWidgetForFile(n, fileType)) {
                        return n;
                    }
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
                // 优先解析 application/x-wp-asset 数据
                const wpData = e.dataTransfer.getData("application/x-wp-asset");
                if (!wpData) return;
                
                const parsed = JSON.parse(wpData);
                if (parsed.type !== "wp_asset" && parsed.type !== "wp_output") return;

                const fileType = parsed.fileType || "image";

                // 按来源（素材库资产 / 输出文件夹文件）构造接口端点
                const isOutput = parsed.type === "wp_output" && !!parsed.path;
                const textUrl = isOutput
                    ? `${ASSET_API_BASE}/output/text?path=${encodeURIComponent(parsed.path)}`
                    : `${ASSET_API_BASE}/text/${parsed.assetId}`;
                const copyUrl = isOutput
                    ? `${ASSET_API_BASE}/output/copy_to_input`
                    : `${ASSET_API_BASE}/asset/${parsed.assetId}/copy_to_input`;
                const copyOptions = isOutput
                    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: parsed.path }) }
                    : { method: 'POST' };

                // 查找落点上的节点
                const targetNode = findNodeAt(e.clientX, e.clientY, fileType);
                if (!targetNode) return;

                e.preventDefault();
                e.stopPropagation();

                // 文本类型：读取文本内容注入到节点
                if (fileType === "text") {
                    const textResp = await fetch(textUrl);
                    const textData = await textResp.json();
                    
                    if (!textData.success || textData.content === undefined) {
                        console.error("[WP资产库] 读取文本内容失败:", textData.error);
                        return;
                    }
                    
                    const matchedWidget = wpFindWidgetForFile(targetNode, fileType);
                    
                    if (matchedWidget) {
                        matchedWidget.value = textData.content;
                        matchedWidget.callback && matchedWidget.callback(textData.content);
                        targetNode.setDirtyCanvas(true, true);
                        currentApp.graph.setDirtyCanvas(true, true);
                        console.log("[WP资产库] 文本内容已注入到节点", targetNode.type, "widget:", matchedWidget.name);
                    } else {
                        console.error("[WP资产库] 未找到匹配的文本 widget，节点类型:", targetNode.type);
                    }
                    return;
                }
                
                // 非文本类型：复制文件到 input 目录，注入文件名
                const response = await fetch(copyUrl, copyOptions);
                const result = await response.json();
                
                if (result.success) {
                    const matchedWidget = wpFindWidgetForFile(targetNode, fileType);

                    if (matchedWidget) {
                        const oldValue = matchedWidget.value;
                        matchedWidget.value = result.file_name;
                        matchedWidget.callback && matchedWidget.callback(result.file_name);
                        wpSyncMediaWidgetAfterInject(targetNode, matchedWidget, result.file_name, oldValue);
                        targetNode.setDirtyCanvas(true, true);
                        currentApp.graph.setDirtyCanvas(true, true);
                    } else {
                        console.error("[WP资产库] 未找到匹配的 widget，节点类型:", targetNode.type);
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
