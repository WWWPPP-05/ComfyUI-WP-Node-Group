---
trigger: always_on
---

# ComfyUI WP_Node 节点开发规范

本项目是一个 ComfyUI 自定义插件包，所有节点必须遵循以下规范。

## 节点命名规范

### 注册ID（内部标识）
- 格式：`WP_英文驼峰命名`
- 示例：`WP_UniversalSlider`、`WP_IgnoreGroups`、`WP_ImageLoad`
- 用途：在 `NODE_CLASS_MAPPINGS` 中作为 key，JavaScript 中识别节点类型

### 显示名称（用户看到）
- 格式：`🐳 WP 中文描述`
- 示例：`🐳 WP 滑条工具`、`🐳 WP 忽略多组`、`🐳 WP 加载图像`
- 用途：ComfyUI 节点菜单中显示的名称，节点标题栏显示的名称

## 节点分类

**所有节点的 CATEGORY 必须是 `"🐳 WP_Node"`**

```python
CATEGORY = "🐳 WP_Node"
```

这确保所有节点在 ComfyUI 右键菜单中归类到同一个分组下。

## 节点颜色

所有 WP 节点使用**紫色标题栏 + 白色字体**。新增节点后必须在 `js/node_color.js` 中注册：

```javascript
const NODE_TYPES = [
    "WP_UniversalSlider",    // 🐳 WP 滑条工具
    "WP_IgnoreGroups",       // 🐳 WP 忽略多组
    // ... 其他节点
];
```

添加规则：
- 使用节点的**注册ID**（不是显示名称）
- 注释用显示名称，方便对照

## 新增节点完整流程

### 1. 创建节点文件

在 `nodes/` 目录下创建 Python 文件，例如 `nodes/my_new_node.py`：

```python
class MyNewNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    CATEGORY = "🐳 WP_Node"
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "execute"

    def execute(self):
        return ()

NODE_CLASS_MAPPINGS = {
    "MyNewNode": MyNewNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyNewNode": "🐳 WP 我的新节点",
}
```

注意：
- 类名用英文驼峰
- `CATEGORY` 必须是 `"🐳 WP_Node"`
- 文件内部的 `NODE_DISPLAY_NAME_MAPPINGS` 显示名称也要用 `🐳 WP ` 前缀

### 2. 在 __init__.py 中注册

编辑项目根目录的 `__init__.py`：

```python
# 添加导入
from .nodes.my_new_node import MyNewNode

# 添加到 NODE_CLASS_MAPPINGS
NODE_CLASS_MAPPINGS = {
    # ... 其他节点
    "WP_MyNewNode": MyNewNode,
}

# 添加到 NODE_DISPLAY_NAME_MAPPINGS  
NODE_DISPLAY_NAME_MAPPINGS = {
    # ... 其他节点
    "WP_MyNewNode": f"{whale_emoji} WP 我的新节点",
}
```

注意：
- `__init__.py` 中的注册ID建议用 `WP_` 前缀（与文件内的 key 可以不同，但建议一致）
- 显示名称使用 `f"{whale_emoji} WP 中文描述"`，其中 `whale_emoji` 已在文件中定义

### 3. 在 node_color.js 中注册颜色

编辑 `js/node_color.js`，在 `NODE_TYPES` 数组中添加注册ID：

```javascript
const NODE_TYPES = [
    // ... 其他节点
    "WP_MyNewNode",          // 🐳 WP 我的新节点
];
```

### 4. 验证

重启 ComfyUI 后：
- 右键工作流 → 浏览节点 → 在 `🐳 WP_Node` 分类下能找到新节点
- 搜索节点时能搜到
- 节点标题栏显示紫色背景 + 白色字体

## 项目结构

```
Comfyui_WP_Node Group/
├── __init__.py              # 节点注册入口
├── nodes/                   # 节点定义文件
│   ├── xxx_node.py
│   └── 中文节点名.py
├── js/                      # 前端扩展
│   ├── node_color.js        # 节点颜色设置
│   └── ...
└── ...
```

## 常见错误排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 搜索能搜到但右键列表找不到 | CATEGORY 不是 `"🐳 WP_Node"` | 修改节点文件中的 CATEGORY |
| 节点没有紫色标题栏 | 没在 node_color.js 中注册 | 添加注册ID到 NODE_TYPES |
| 修改后不生效 | ComfyUI 没重启 | 必须重启 ComfyUI |
| 节点报错无法加载 | 导入路径或类名错误 | 检查 __init__.py 中的导入语句 |
