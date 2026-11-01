"""
🐳 WP 三图组合节点
脸模（手动上传 / WP资产库选用） + 服装库 + 姿势库 三图组合输出
服装/姿势的素材数据（编号、分类、描述）解析自素材文件夹内的 index.html（const D=[...]）
输出：脸模图像 / 服装图像 / 姿势图像 / 整合提示词
"""
import os
import json
import asyncio
import logging
import numpy as np
import torch
from PIL import Image, ImageOps
from aiohttp import web
import folder_paths
from server import PromptServer

logger = logging.getLogger(__name__)

DEFAULT_OUTFIT_DIR = r"D:\Comfyui 资产库\00 女装"
DEFAULT_POSE_DIR = r"D:\Comfyui 资产库\00 姿势"

# 整合提示词模板（图1固定文案；图2/3分别接入素材描述）
_PROMPT_FACE = "使用图1参考面部，保留可辨识的五官比例、脸型、肤色与发型，不沿用图片1的服装和动作。"
_PROMPT_OUTFIT = "服装参考图2{desc_seg}，准确还原款式、剪裁、配色、面料纹理与装饰细节，使衣物自然贴合图片1人物的身体，不复制图片2的人脸或姿势。"
_PROMPT_POSE = "动作严格按照图3姿态{desc_seg}及观察角度进行参考，遵循躯干朝向、四肢位置、重心和透视关系，不复制图片3的身份、服装或背景。"


def _clean_path(raw):
    text = (raw or "").strip().strip('"').strip("'").strip()
    return os.path.abspath(text) if text else ""


MAX_EDGE = 1024  # 输出图像最大边像素，比例保持不变


def _load_image_tensor(path):
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        # 最大边压到 1024px，宽高比不变
        if max(im.size) > MAX_EDGE:
            scale = MAX_EDGE / max(im.size)
            im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
        arr = np.array(im).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _parse_selection(raw):
    """把 widget 里存的 JSON 解析成字典，解析失败返回空字典"""
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


# ========== index.html 素材数据解析 ==========

def _extract_js_array(html):
    """提取 const D=[...] 的 JSON 数组文本（括号计数 + 字符串感知，防止内容里出现 ] 提前截断）"""
    marker = "const D="
    i = html.find(marker)
    if i < 0:
        return None
    j = html.find("[", i)
    if j < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for k in range(j, len(html)):
        c = html[k]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    return html[j:k + 1]
    return None


def _map_item(it):
    """把 index.html 里的原始记录统一成 {id, cat, desc, file}；识别不了的字段结构返回 None"""
    if not isinstance(it, dict):
        return None
    if "カテゴリ" in it:  # 女装库结构
        cat = it.get("カテゴリ", "")
        desc = it.get("キーワード", "")
    elif "系統" in it:  # 姿势库结构
        cat = it.get("系統", "")
        desc = "·".join(x for x in (it.get("ポーズ名", ""), it.get("アングル", "")) if x)
    else:
        return None
    file = it.get("サムネ") or it.get("画像") or it.get("原寸") or ""
    if not file:
        return None
    return {
        "id": it.get("id", ""),
        "cat": cat,
        "desc": desc,
        "file": str(file).replace("\\", "/"),
    }


# 库解析缓存：路径 -> (指纹, 解析结果)；index.html 变化后自动失效
_library_cache = {}


def _library_fingerprint(root):
    idx = os.path.join(root, "index.html")
    try:
        st = os.stat(idx)
        return f"{st.st_mtime_ns}_{st.st_size}"
    except OSError:
        return None


def parse_library(root):
    """
    解析素材库：读取 index.html 的 const D 数据，与磁盘文件核对后返回
    {"success": True, "categories": [{"name", "count"}], "items": [{id, cat, desc, file}]}
    """
    root = _clean_path(root)
    if not root or not os.path.isdir(root):
        return {"success": False, "error": f"素材库路径不存在或不是文件夹：{root}"}
    idx = os.path.join(root, "index.html")
    if not os.path.isfile(idx):
        return {"success": False, "error": f"素材库文件夹里没有找到 index.html：{root}"}

    fp = _library_fingerprint(root)
    cached = _library_cache.get(root)
    if cached and cached[0] == fp:
        return cached[1]

    try:
        with open(idx, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()
    except OSError as e:
        return {"success": False, "error": f"index.html 读取失败：{e}"}

    arr_text = _extract_js_array(html)
    if not arr_text:
        return {"success": False, "error": "index.html 里没有找到 const D=[...] 素材数据，无法解析"}

    try:
        raw_items = json.loads(arr_text)
    except ValueError as e:
        return {"success": False, "error": f"素材数据解析失败（不是合法JSON）：{e}"}

    items = []
    cat_counts = {}
    for it in raw_items:
        item = _map_item(it)
        if not item:
            continue
        # 与磁盘核对：文件不存在的记录不提供（防止前端选用后加载失败）
        if not os.path.isfile(os.path.join(root, item["file"])):
            continue
        items.append(item)
        if item["cat"]:
            cat_counts[item["cat"]] = cat_counts.get(item["cat"], 0) + 1

    if not items:
        return {"success": False, "error": "素材数据是空的，或所有素材文件在磁盘上都找不到，请检查文件夹内容"}

    # 分类按素材量降序排列，看起来更稳定
    categories = [{"name": name, "count": cnt} for name, cnt in
                  sorted(cat_counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    result = {"success": True, "root": root, "total": len(items),
              "categories": categories, "items": items}
    _library_cache[root] = (fp, result)
    return result


# ========== 节点本体 ==========

class WPThreeImageCombo:
    """脸模 + 服装 + 姿势 三图组合，附带整合提示词输出"""

    CATEGORY = "🐳 WP_Node"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("脸模图像", "服装图像", "姿势图像", "整合提示词")
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "服装库路径": ("STRING", {
                    "default": DEFAULT_OUTFIT_DIR,
                    "multiline": False,
                    "placeholder": r"例如 D:\Comfyui 资产库\00 女装",
                    "tooltip": "服装素材库文件夹（需包含index.html数据文件）",
                }),
                "姿势库路径": ("STRING", {
                    "default": DEFAULT_POSE_DIR,
                    "multiline": False,
                    "placeholder": r"例如 D:\Comfyui 资产库\00 姿势",
                    "tooltip": "姿势素材库文件夹（需包含index.html数据文件）",
                }),
                # 以下三项由前端界面写入，界面上隐藏
                "脸模文件": ("STRING", {"default": ""}),
                "服装选择": ("STRING", {"default": ""}),
                "姿势选择": ("STRING", {"default": ""}),
            },
        }

    def execute(self, 服装库路径, 姿势库路径, 脸模文件, 服装选择, 姿势选择):
        # ---- 脸模 ----
        face = _parse_selection(脸模文件)
        face_name = face.get("name", "")
        face_sub = face.get("subfolder", "")
        if not face_name:
            raise ValueError("【WP 三图组合】还没有设置脸模图像：请点击节点上的「上传」或「素材库」按钮选择一张脸模图片")
        face_path = os.path.join(folder_paths.get_input_directory(), face_sub, face_name)
        if not os.path.isfile(face_path):
            raise ValueError(f"【WP 三图组合】脸模文件不存在：{face_path}\n请重新上传或选用脸模图像")

        # ---- 服装 ----
        outfit = _parse_selection(服装选择)
        outfit_file = outfit.get("file", "")
        if not outfit_file:
            raise ValueError("【WP 三图组合】还没有选择服装：请点击服装卡片的「随机」或「素材库」按钮")
        outfit_root = _clean_path(服装库路径)
        outfit_path = os.path.join(outfit_root, outfit_file)
        if not os.path.isfile(outfit_path):
            raise ValueError(f"【WP 三图组合】服装图片不存在：{outfit_path}\n素材库可能有变动，请重新选择服装")

        # ---- 姿势 ----
        pose = _parse_selection(姿势选择)
        pose_file = pose.get("file", "")
        if not pose_file:
            raise ValueError("【WP 三图组合】还没有选择姿势：请点击姿势卡片的「随机」或「素材库」按钮")
        pose_root = _clean_path(姿势库路径)
        pose_path = os.path.join(pose_root, pose_file)
        if not os.path.isfile(pose_path):
            raise ValueError(f"【WP 三图组合】姿势图片不存在：{pose_path}\n素材库可能有变动，请重新选择姿势")

        # ---- 加载图像 ----
        face_img = _load_image_tensor(face_path)
        outfit_img = _load_image_tensor(outfit_path)
        pose_img = _load_image_tensor(pose_path)

        # ---- 整合提示词 ----
        outfit_desc = (outfit.get("desc") or "").strip()
        pose_desc = (pose.get("desc") or "").strip()
        prompt = " ".join([
            _PROMPT_FACE,
            _PROMPT_OUTFIT.format(desc_seg=f"（{outfit_desc}）" if outfit_desc else ""),
            _PROMPT_POSE.format(desc_seg=f"（{pose_desc}）" if pose_desc else ""),
        ])

        return (face_img, outfit_img, pose_img, prompt)


# ========== API 路由 ==========

@PromptServer.instance.routes.get("/wp_node/three_combo/library")
async def three_combo_library(request):
    """获取素材库清单（分类+每条素材的编号/描述/文件路径），前端弹窗和随机按钮使用"""
    try:
        path = request.query.get("path", "")
        result = await asyncio.to_thread(parse_library, path)
        # items 里带完整文件路径会泄露服务器路径信息，只保留相对 file
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP三图组合] 获取素材库失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/three_combo/image")
async def three_combo_image(request):
    """提供素材库图片给前端预览（严格限制只能访问指定库文件夹内的图片）"""
    try:
        import mimetypes
        root = _clean_path(request.query.get("root", ""))
        file = (request.query.get("file", "") or "").replace("\\", "/")
        if not root or not file:
            return web.Response(status=400, text="缺少 root 或 file 参数")
        root_real = os.path.realpath(root)
        full = os.path.realpath(os.path.join(root_real, file))
        # 安全校验：解析后的真实路径必须仍在库文件夹内（防止 ../ 越界读取任意文件）
        if full != root_real and not full.startswith(root_real + os.sep):
            return web.Response(status=403, text="禁止访问素材库之外的文件")
        if not os.path.isfile(full):
            return web.Response(status=404, text="图片不存在")
        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        return web.FileResponse(full, headers={
            "Content-Type": content_type,
            "Cache-Control": "public, max-age=3600",
        })
    except Exception as e:
        logger.error(f"[WP三图组合] 素材图片服务失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/three_combo/import_face")
async def three_combo_import_face(request):
    """把素材库里的一张图片复制到 ComfyUI 的 input 目录，供前端拖拽设为脸模"""
    try:
        import shutil
        body = await request.json()
        root = _clean_path(body.get("root", ""))
        file = (body.get("file", "") or "").replace("\\", "/")
        if not root or not file:
            return web.json_response({"success": False, "error": "缺少 root 或 file 参数"}, status=400)
        root_real = os.path.realpath(root)
        full = os.path.realpath(os.path.join(root_real, file))
        # 安全校验：真实路径必须仍在库文件夹内（与图片预览接口一致）
        if full != root_real and not full.startswith(root_real + os.sep):
            return web.json_response({"success": False, "error": "禁止访问素材库之外的文件"}, status=403)
        if not os.path.isfile(full):
            return web.json_response({"success": False, "error": "图片不存在"}, status=404)
        if os.path.splitext(full)[1].lower() not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
            return web.json_response({"success": False, "error": "只支持图片文件"}, status=400)
        # 复制到 input 目录，同名自动加序号
        in_dir = folder_paths.get_input_directory()
        stem, ext = os.path.splitext(os.path.basename(full))
        target = os.path.join(in_dir, stem + ext)
        n = 1
        while os.path.exists(target) and n <= 999:
            target = os.path.join(in_dir, f"{stem}_{n}{ext}")
            n += 1
        if os.path.exists(target):
            return web.json_response({"success": False, "error": "同名文件太多，请清理 input 文件夹"}, status=500)
        shutil.copy2(full, target)
        return web.json_response({"success": True, "name": os.path.basename(target)})
    except Exception as e:
        logger.error(f"[WP三图组合] 导入脸模失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


NODE_CLASS_MAPPINGS = {
    "WPThreeImageCombo": WPThreeImageCombo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WPThreeImageCombo": "🐳 WP 三图组合",
}
