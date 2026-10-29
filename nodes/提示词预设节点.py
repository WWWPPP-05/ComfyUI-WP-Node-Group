"""
🐳 WP 提示词预设节点
功能：储存和管理提示词预设，支持分组和增删改
"""
import os
import re
import json
import base64
from server import PromptServer
from aiohttp import web


# 项目根目录
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 预设文件路径
PRESETS_FILE = os.path.join(PROJECT_ROOT, "data", "prompt_presets.json")
# 图片存放文件夹
IMAGES_DIR = os.path.join(PROJECT_ROOT, "data", "prompt_preset_images")

# 静态路由前缀
IMAGE_URL_PREFIX = "/wp_node/prompt_presets/image"


def ensure_images_dir():
    """确保图片文件夹存在"""
    if not os.path.exists(IMAGES_DIR):
        os.makedirs(IMAGES_DIR)


def sanitize_filename(name):
    """将分组/预设名转换为安全的文件名片段"""
    # 替换 Windows 文件名非法字符和路径分隔符
    safe = re.sub(r'[\\/:*?"<>|]', "_", name)
    safe = safe.strip().strip(".")
    return safe if safe else "untitled"


def get_image_filename(group_name, preset_name):
    """根据分组和预设名生成图片文件名"""
    return f"{sanitize_filename(group_name)}__{sanitize_filename(preset_name)}.jpg"


def is_base64_image(s):
    """判断字符串是否为 base64 图片数据"""
    return isinstance(s, str) and s.startswith("data:image")


def save_image_from_base64(filename, b64data):
    """将 base64 图片数据保存为文件，返回文件名；失败返回 None"""
    if not b64data or not is_base64_image(b64data):
        return None
    try:
        ensure_images_dir()
        # 解析 base64：data:image/jpeg;base64,xxxx
        header, b64content = b64data.split(",", 1)
        img_bytes = base64.b64decode(b64content)
        filepath = os.path.join(IMAGES_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(img_bytes)
        return filename
    except Exception as e:
        print(f"[WP提示词预设] 保存图片文件失败: {e}")
        return None


def delete_image_file(filename):
    """删除图片文件（如果存在）"""
    if not filename:
        return
    try:
        filepath = os.path.join(IMAGES_DIR, filename)
        if os.path.exists(filepath):
            os.remove(filepath)
    except Exception as e:
        print(f"[WP提示词预设] 删除图片文件失败: {e}")


def rename_image_file(old_filename, new_filename):
    """重命名图片文件"""
    if not old_filename or old_filename == new_filename:
        return
    try:
        old_path = os.path.join(IMAGES_DIR, old_filename)
        new_path = os.path.join(IMAGES_DIR, new_filename)
        if os.path.exists(old_path):
            os.rename(old_path, new_path)
    except Exception as e:
        print(f"[WP提示词预设] 重命名图片文件失败: {e}")


def get_image_url(filename):
    """根据文件名生成可访问的 URL"""
    if not filename:
        return None
    return f"{IMAGE_URL_PREFIX}/{filename}"


def migrate_legacy_image(group_name, preset_name, value):
    """
    迁移旧数据：如果 image 字段是 base64，保存为文件并更新 JSON。
    返回更新后的 value（dict 格式）。
    """
    if not isinstance(value, dict):
        return value
    img = value.get("image")
    if is_base64_image(img):
        filename = get_image_filename(group_name, preset_name)
        saved = save_image_from_base64(filename, img)
        if saved:
            value["image"] = filename
            # 同步保存到 JSON
            try:
                presets_data = get_presets_data()
                if group_name in presets_data.get("groups", {}):
                    if preset_name in presets_data["groups"][group_name]:
                        presets_data["groups"][group_name][preset_name]["image"] = filename
                        save_presets_data(presets_data)
            except Exception as e:
                print(f"[WP提示词预设] 迁移旧图片数据失败: {e}")
    return value


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
    """获取指定分组和预设的内容（兼容新旧格式）"""
    data = get_presets_data()
    group = data.get("groups", {}).get(group_name, {})
    value = group.get(preset_name, "")
    if isinstance(value, dict):
        return value.get("content", "")
    return value


def get_preset_full_data(group_name, preset_name):
    """获取指定分组和预设的完整数据（包含图片），自动迁移旧 base64 数据"""
    data = get_presets_data()
    group = data.get("groups", {}).get(group_name, {})
    value = group.get(preset_name, "")
    if isinstance(value, dict):
        # 迁移旧 base64 图片到文件存储
        value = migrate_legacy_image(group_name, preset_name, value)
        return value
    return {"content": value, "image": None}


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


@PromptServer.instance.routes.get("/wp_node/prompt_presets/get")
async def get_single_preset(request):
    """获取单个预设的完整数据（包含图片文件名和URL）"""
    group_name = request.query.get("group", "")
    preset_name = request.query.get("preset", "")
    if not group_name or not preset_name:
        return web.json_response({"success": False, "error": "参数不能为空"})
    data = get_preset_full_data(group_name, preset_name)
    # 返回图片 URL，前端直接用 URL 加载
    image_filename = data.get("image")
    data["image_url"] = get_image_url(image_filename) if image_filename else None
    return web.json_response({"success": True, "data": data})


@PromptServer.instance.routes.get(IMAGE_URL_PREFIX + "/{filename}")
async def serve_preset_image(request):
    """提供图片文件的静态访问"""
    filename = request.match_info.get("filename", "")
    if not filename:
        return web.Response(status=404, text="文件名不能为空")
    # 防止路径穿越
    if "/" in filename or "\\" in filename or ".." in filename:
        return web.Response(status=400, text="非法文件名")
    filepath = os.path.join(IMAGES_DIR, filename)
    if not os.path.exists(filepath):
        return web.Response(status=404, text="图片不存在")
    return web.FileResponse(filepath, headers={
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*"
    })


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
        
        # 删除该分组下所有图片文件
        group_presets = presets_data["groups"][group_name]
        for preset_name, value in group_presets.items():
            if isinstance(value, dict):
                img = value.get("image")
                if img:
                    delete_image_file(img)
        
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
        
        # 重命名分组下所有图片文件
        group_presets = presets_data["groups"][old_name]
        for preset_name, value in group_presets.items():
            if isinstance(value, dict):
                old_img = value.get("image")
                if old_img:
                    new_img = get_image_filename(new_name, preset_name)
                    rename_image_file(old_img, new_img)
                    value["image"] = new_img
        
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
        image = data.get("image", None)
        
        if not group_name:
            return web.json_response({"success": False, "error": "分组名称不能为空"})
        if not preset_name:
            return web.json_response({"success": False, "error": "预设名称不能为空"})
        
        # 处理图片：base64 → 文件
        stored_image = None
        if image and is_base64_image(image):
            filename = get_image_filename(group_name, preset_name)
            stored_image = save_image_from_base64(filename, image)
        
        presets_data = get_presets_data()
        
        # 确保分组存在
        if "groups" not in presets_data:
            presets_data["groups"] = {}
        if group_name not in presets_data["groups"]:
            presets_data["groups"][group_name] = {}
        
        # 添加预设（image 字段存文件名）
        presets_data["groups"][group_name][preset_name] = {
            "content": content,
            "image": stored_image
        }
        
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
        image = data.get("image", None)
        
        if not old_group or not new_group or not old_name or new_name is None:
            return web.json_response({"success": False, "error": "参数不能为空"})
        
        presets_data = get_presets_data()
        
        # 获取旧预设数据（含旧图片文件名）
        old_value = presets_data.get("groups", {}).get(old_group, {}).get(old_name, {})
        old_image_filename = None
        if isinstance(old_value, dict):
            old_image_filename = old_value.get("image")
        
        # 确保新分组存在
        if new_group not in presets_data.get("groups", {}):
            presets_data["groups"][new_group] = {}
        
        # 删除旧预设
        if old_group in presets_data.get("groups", {}):
            if old_name in presets_data["groups"][old_group]:
                del presets_data["groups"][old_group][old_name]
        
        # 处理图片文件
        new_image_filename = None
        new_target_filename = get_image_filename(new_group, new_name)
        
        if image is None:
            # 用户删除了图片：删除旧文件
            if old_image_filename:
                delete_image_file(old_image_filename)
            new_image_filename = None
        elif is_base64_image(image):
            # 用户新上传/更换了图片：删除旧文件，保存新文件
            if old_image_filename:
                delete_image_file(old_image_filename)
            new_image_filename = save_image_from_base64(new_target_filename, image)
        else:
            # image 不是 base64（可能是旧文件名）：保留原文件，按新名称重命名
            if old_image_filename:
                if old_group != new_group or old_name != new_name:
                    rename_image_file(old_image_filename, new_target_filename)
                new_image_filename = new_target_filename
        
        # 添加新预设（image 字段存文件名）
        presets_data["groups"][new_group][new_name] = {
            "content": content,
            "image": new_image_filename
        }
        
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
        
        # 删除关联的图片文件
        old_value = presets_data["groups"][group_name][preset_name]
        if isinstance(old_value, dict):
            old_image = old_value.get("image")
            if old_image:
                delete_image_file(old_image)
        
        del presets_data["groups"][group_name][preset_name]
        
        if save_presets_data(presets_data):
            return web.json_response({"success": True, "message": "删除成功"})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


# 模块加载时确保图片文件夹存在
ensure_images_dir()
