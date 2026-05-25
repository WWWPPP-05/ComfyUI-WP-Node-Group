"""
🐳 WP 提示词预设节点
功能：储存和管理提示词预设，支持分组和增删改
"""
import os
import json
from server import PromptServer
from aiohttp import web


# 预设文件路径（数据文件在项目根目录）
PRESETS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompt_presets.json")


def get_presets_data():
    """获取所有预设数据（包含分组结构）"""
    if os.path.exists(PRESETS_FILE):
        try:
            with open(PRESETS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # 兼容旧格式（没有分组的纯字典）
                if isinstance(data, dict) and "groups" not in data:
                    # 迁移旧数据到新格式
                    new_data = {
                        "groups": {
                            "默认分组": data
                        }
                    }
                    save_presets_data(new_data)
                    return new_data
                return data
        except Exception as e:
            print(f"[WP提示词预设] 读取预设文件失败: {e}")
    return {"groups": {"默认分组": {}}}


def save_presets_data(data):
    """保存预设数据到文件"""
    try:
        with open(PRESETS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[WP提示词预设] 保存预设文件失败: {e}")
        return False


def get_group_names():
    """获取所有分组名称"""
    data = get_presets_data()
    groups = list(data.get("groups", {}).keys())
    if not groups:
        groups = ["默认分组"]
    return groups


def get_preset_names_by_group(group_name):
    """获取指定分组下的预设名称列表"""
    data = get_presets_data()
    group = data.get("groups", {}).get(group_name, {})
    names = list(group.keys())
    if not names:
        names = ["默认预设"]
    return names


def get_all_preset_names():
    """获取所有预设名称（用于INPUT_TYPES，避免选项验证失败）"""
    data = get_presets_data()
    all_names = set()
    for group in data.get("groups", {}).values():
        all_names.update(group.keys())
    names = list(all_names)
    if not names:
        names = ["默认预设"]
    return names


def get_preset_content(group_name, preset_name):
    """获取指定分组和预设的内容"""
    data = get_presets_data()
    group = data.get("groups", {}).get(group_name, {})
    return group.get(preset_name, "")


class PromptPresetNode:
    """
    🐳 WP 提示词预设节点
    支持分组管理提示词预设
    """

    @classmethod
    def INPUT_TYPES(s):
        groups = get_group_names()
        default_group = groups[0] if groups else "默认分组"
        # 使用所有预设名称，避免ComfyUI验证失败
        all_presets = get_all_preset_names()
        
        return {
            "required": {
                "分组": (groups, {"default": default_group}),
                "预设": (all_presets, {"default": all_presets[0] if all_presets else "默认预设"}),
            }
        }

    CATEGORY = "🐳 WP_Node"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "get_prompt"
    OUTPUT_NODE = True

    def get_prompt(self, 分组, 预设):
        """返回选中的提示词内容"""
        content = get_preset_content(分组, 预设)
        if not content:
            print(f"[WP提示词预设] 警告: 未找到预设内容 - 分组='{分组}', 预设='{预设}'")
            # 尝试重新读取数据
            data = get_presets_data()
            print(f"[WP提示词预设] 当前分组列表: {list(data.get('groups', {}).keys())}")
            if 分组 in data.get("groups", {}):
                print(f"[WP提示词预设] 分组 '{分组}' 中的预设: {list(data['groups'][分组].keys())}")
            else:
                print(f"[WP提示词预设] 分组 '{分组}' 不存在!")
        return (content,)

    @classmethod
    def IS_CHANGED(s, 分组, 预设):
        """检测预设是否变化"""
        return f"{分组}/{预设}"


# ========== API路由 ==========

@PromptServer.instance.routes.get("/wp_node/prompt_presets")
async def get_prompt_presets(request):
    """获取所有预设数据"""
    data = get_presets_data()
    return web.json_response(data)


@PromptServer.instance.routes.get("/wp_node/prompt_presets/groups")
async def get_groups_api(request):
    """获取所有分组名称"""
    groups = get_group_names()
    return web.json_response(groups)


@PromptServer.instance.routes.get("/wp_node/prompt_presets/names")
async def get_preset_names_api(request):
    """获取指定分组下的预设名称列表"""
    group_name = request.query.get("group", "默认分组")
    names = get_preset_names_by_group(group_name)
    return web.json_response(names)


# ========== 分组管理API ==========

@PromptServer.instance.routes.post("/wp_node/prompt_presets/groups/add")
async def add_group(request):
    """添加新分组"""
    try:
        data = await request.json()
        group_name = data.get("group_name", "").strip()
        
        if not group_name:
            return web.json_response({"success": False, "error": "分组名称不能为空"})
        
        presets_data = get_presets_data()
        
        if group_name in presets_data.get("groups", {}):
            return web.json_response({"success": False, "error": "分组已存在"})
        
        if "groups" not in presets_data:
            presets_data["groups"] = {}
        
        presets_data["groups"][group_name] = {}
        
        if save_presets_data(presets_data):
            return web.json_response({"success": True, "message": "分组添加成功"})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


@PromptServer.instance.routes.post("/wp_node/prompt_presets/groups/delete")
async def delete_group(request):
    """删除分组"""
    try:
        data = await request.json()
        group_name = data.get("group_name", "").strip()
        
        if not group_name:
            return web.json_response({"success": False, "error": "分组名称不能为空"})
        
        presets_data = get_presets_data()
        
        if group_name not in presets_data.get("groups", {}):
            return web.json_response({"success": False, "error": "分组不存在"})
        
        # 不允许删除最后一个分组
        if len(presets_data["groups"]) <= 1:
            return web.json_response({"success": False, "error": "不能删除最后一个分组"})
        
        del presets_data["groups"][group_name]
        
        if save_presets_data(presets_data):
            return web.json_response({"success": True, "message": "分组删除成功"})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


@PromptServer.instance.routes.post("/wp_node/prompt_presets/groups/rename")
async def rename_group(request):
    """重命名分组"""
    try:
        data = await request.json()
        old_name = data.get("old_name", "").strip()
        new_name = data.get("new_name", "").strip()
        
        if not old_name or not new_name:
            return web.json_response({"success": False, "error": "分组名称不能为空"})
        
        if old_name == new_name:
            return web.json_response({"success": True, "message": "名称未变化"})
        
        presets_data = get_presets_data()
        
        if old_name not in presets_data.get("groups", {}):
            return web.json_response({"success": False, "error": "原分组不存在"})
        
        if new_name in presets_data["groups"]:
            return web.json_response({"success": False, "error": "新分组名称已存在"})
        
        # 重命名分组：移动数据到新名称
        presets_data["groups"][new_name] = presets_data["groups"][old_name]
        del presets_data["groups"][old_name]
        
        if save_presets_data(presets_data):
            return web.json_response({"success": True, "message": "分组重命名成功"})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


# ========== 预设管理API ==========

@PromptServer.instance.routes.post("/wp_node/prompt_presets/add")
async def add_prompt_preset(request):
    """添加新的提示词预设"""
    try:
        data = await request.json()
        group_name = data.get("group_name", "").strip()
        preset_name = data.get("preset_name", "").strip()
        content = data.get("content", "").strip()
        
        if not group_name:
            return web.json_response({"success": False, "error": "分组名称不能为空"})
        if not preset_name:
            return web.json_response({"success": False, "error": "预设名称不能为空"})
        
        presets_data = get_presets_data()
        
        # 确保分组存在
        if "groups" not in presets_data:
            presets_data["groups"] = {}
        if group_name not in presets_data["groups"]:
            presets_data["groups"][group_name] = {}
        
        # 添加预设
        presets_data["groups"][group_name][preset_name] = content
        
        if save_presets_data(presets_data):
            return web.json_response({"success": True, "message": "添加成功"})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


@PromptServer.instance.routes.post("/wp_node/prompt_presets/update")
async def update_prompt_preset(request):
    """更新提示词预设"""
    try:
        data = await request.json()
        old_group = data.get("old_group", "").strip()
        new_group = data.get("new_group", "").strip()
        old_name = data.get("old_name", "").strip()
        new_name = data.get("new_name", "").strip()
        content = data.get("content", "").strip()
        
        if not old_group or not new_group or not old_name or not new_name:
            return web.json_response({"success": False, "error": "参数不能为空"})
        
        presets_data = get_presets_data()
        
        # 确保新分组存在
        if new_group not in presets_data.get("groups", {}):
            presets_data["groups"][new_group] = {}
        
        # 删除旧预设
        if old_group in presets_data.get("groups", {}):
            if old_name in presets_data["groups"][old_group]:
                del presets_data["groups"][old_group][old_name]
        
        # 添加新预设
        presets_data["groups"][new_group][new_name] = content
        
        if save_presets_data(presets_data):
            return web.json_response({"success": True, "message": "更新成功"})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


@PromptServer.instance.routes.post("/wp_node/prompt_presets/delete")
async def delete_prompt_preset(request):
    """删除提示词预设"""
    try:
        data = await request.json()
        group_name = data.get("group_name", "").strip()
        preset_name = data.get("preset_name", "").strip()
        
        if not group_name or not preset_name:
            return web.json_response({"success": False, "error": "参数不能为空"})
        
        presets_data = get_presets_data()
        
        if group_name not in presets_data.get("groups", {}):
            return web.json_response({"success": False, "error": "分组不存在"})
        
        if preset_name not in presets_data["groups"][group_name]:
            return web.json_response({"success": False, "error": "预设不存在"})
        
        del presets_data["groups"][group_name][preset_name]
        
        if save_presets_data(presets_data):
            return web.json_response({"success": True, "message": "删除成功"})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})
