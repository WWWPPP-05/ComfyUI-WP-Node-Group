"""
🐳 WP 三图组合节点
脸模（手动上传 / WP资产库选用） + 服装库 + 姿势库 + 发型库 四图组合输出
素材数据直接扫描素材文件夹（子文件夹=分类），描述读取库内「素材描述.json」（可在弹窗中编辑持久化）
输出：脸模图像 / 服装图像 / 姿势图像 / 发型图像 / 整合提示词
"""
import json
import os
import shutil
import threading
import asyncio
import logging
import mimetypes
import numpy as np
import torch
from PIL import Image, ImageOps
from aiohttp import web
import folder_paths
from server import PromptServer

logger = logging.getLogger(__name__)

# 素材库固定位置：models/WP nodes/；预览图在同级「xx 预览图」文件夹
WP_NODES_DIR = os.path.join(folder_paths.models_dir, "WP nodes")
LIBS = {
    "outfit": {"name": "女装", "label": "服装库"},
    "pose": {"name": "姿势", "label": "姿势库"},
    "hair": {"name": "发型", "label": "发型库"},
}
DESC_FILE = "素材描述.json"
IMAGE_EXTS = {".webp", ".jpg", ".jpeg", ".png", ".bmp", ".gif"}
FAV_SUFFIX = " 收藏"  # 收藏文件夹与素材库同级，同「xx 预览图」命名风格
RANDOM_CONFIG_FILE = os.path.join(WP_NODES_DIR, "随机分类开关.json")  # 各库随机分类开关的持久化文件

# 整合提示词模板（图1固定文案；图2/3/4分别接入素材描述）
_PROMPT_FACE = "使用图1参考面部，保留可辨识的五官比例、脸型、肤色与发型，不沿用图片1的服装和动作。"
_PROMPT_OUTFIT = "服装参考图2{desc_seg}，准确还原款式、剪裁、配色、面料纹理与装饰细节，使衣物自然贴合图片1人物的身体，不复制图片2的人脸或姿势。"
_PROMPT_POSE = "动作严格按照图3姿态{desc_seg}及观察角度进行参考，遵循躯干朝向、四肢位置、重心和透视关系，不复制图片3的身份、服装或背景。"
_PROMPT_HAIR = "发型参考图4{desc_seg}，准确还原发型的轮廓、长度、卷度、刘海形态与颜色，使发型自然贴合图片1人物的头型与发际线，不复制图片4的人脸、表情或头部姿态。"

MAX_EDGE = 1024  # 输出图像最大边像素，比例保持不变
THUMB_SHORT_EDGE = 300  # 预览图短边像素（原图更小则保持原尺寸不放大）


def _lib_root(lib):
    return os.path.join(WP_NODES_DIR, LIBS[lib]["name"])


def _thumb_root(lib):
    return os.path.join(WP_NODES_DIR, LIBS[lib]["name"] + " 预览图")


def _fav_root(lib):
    return os.path.join(WP_NODES_DIR, LIBS[lib]["name"] + FAV_SUFFIX)


def _clean_path(raw):
    text = (raw or "").strip().strip('"').strip("'").strip()
    return os.path.abspath(text) if text else ""


def _load_image_tensor(path):
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
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


# ========== 素材库扫描与描述读写 ==========

# 库解析缓存：lib -> (指纹, 解析结果)；文件夹或描述文件变化后自动失效
_library_cache = {}
_desc_lock = threading.Lock()
_random_lock = threading.Lock()


def _load_desc_map(lib):
    path = os.path.join(_lib_root(lib), DESC_FILE)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_desc_map(lib, desc_map):
    path = os.path.join(_lib_root(lib), DESC_FILE)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(desc_map, f, ensure_ascii=False, indent=0)


def _library_fingerprint(lib):
    """指纹 = 一级子文件夹的mtime + 描述文件mtime + 收藏夹mtime，任一变化缓存失效"""
    root = _lib_root(lib)
    try:
        parts = [str(os.stat(root).st_mtime_ns)]
        fav = _fav_root(lib)
        if os.path.isdir(fav):
            parts.append("fav:" + str(os.stat(fav).st_mtime_ns))
        with os.scandir(root) as it:
            for e in it:
                try:
                    parts.append(e.name + str(e.stat().st_mtime_ns))
                except OSError:
                    pass
        return "|".join(sorted(parts))
    except OSError:
        return None


def parse_library(lib):
    """
    扫描素材库：子文件夹=分类，图片文件=素材；描述合并自「素材描述.json」
    返回 {"success": True, "total", "categories": [{"name", "count"}], "items": [{id, cat, desc, file}]}
    """
    if lib not in LIBS:
        return {"success": False, "error": f"未知的素材库标识：{lib}"}
    root = _lib_root(lib)
    if not os.path.isdir(root):
        return {"success": False, "error": f"素材库文件夹不存在：{root}\n请先按规范创建"}

    fp = _library_fingerprint(lib)
    cached = _library_cache.get(lib)
    if cached and cached[0] == fp:
        return cached[1]

    desc_map = _load_desc_map(lib)
    items = []
    cat_counts = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        rel_dir = os.path.relpath(dirpath, root)
        cat = "" if rel_dir == "." else rel_dir.replace("\\", "/")
        for fn in sorted(filenames):
            if os.path.splitext(fn)[1].lower() not in IMAGE_EXTS:
                continue
            file = (cat + "/" + fn) if cat else fn
            rec = desc_map.get(file) or {}
            items.append({
                "id": (rec.get("id") or os.path.splitext(fn)[0]),
                "cat": cat or "未分类",
                "desc": rec.get("desc") or "",
                "file": file,
            })
            cat_counts[cat or "未分类"] = cat_counts.get(cat or "未分类", 0) + 1

    if not items:
        return {"success": False, "error": f"素材库文件夹里没有图片：{root}"}

    # 收藏标记：以收藏文件夹里是否存在同名副本为准（弹窗心形按钮的激活状态）
    fav_set = _scan_favorites(lib)
    for it in items:
        it["fav"] = it["file"] in fav_set

    # 有描述的素材排前面：弹窗第一眼就是带描述的旧图，无描述的新图（后补素材）排在后面
    items.sort(key=lambda it: (not it["desc"], it["file"]))

    # 素材库有变动时补齐缺失的预览图（弹窗缩略图按同名文件直接命中，避免每次都回退原图）
    ensure_thumbs(lib, items)

    categories = [{"name": name, "count": cnt} for name, cnt in
                  sorted(cat_counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    result = {"success": True, "total": len(items), "categories": categories, "items": items,
              "random_disabled": sorted(get_random_disabled(lib))}
    _library_cache[lib] = (fp, result)
    return result


def update_description(lib, file, desc):
    """更新一条素材的描述并持久化到「素材描述.json」"""
    if lib not in LIBS:
        return {"success": False, "error": f"未知的素材库标识：{lib}"}
    desc = (desc or "").strip()
    with _desc_lock:
        desc_map = _load_desc_map(lib)
        rec = desc_map.get(file) or {}
        rec["desc"] = desc
        desc_map[file] = rec
        _save_desc_map(lib, desc_map)
    _library_cache.pop(lib, None)
    return {"success": True}


# ========== 收藏（收藏文件夹 = 库同级「xx 收藏」） ==========

def _scan_favorites(lib):
    """扫描收藏文件夹，返回已收藏素材的相对路径集合（路径结构与库内一致）"""
    root = _fav_root(lib)
    favs = set()
    if not os.path.isdir(root):
        return favs
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        rel_dir = os.path.relpath(dirpath, root)
        cat = "" if rel_dir == "." else rel_dir.replace("\\", "/")
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() not in IMAGE_EXTS:
                continue
            favs.add((cat + "/" + fn) if cat else fn)
    return favs


def is_favorite(lib, file):
    """查询某素材是否已收藏（收藏文件夹里存在同名副本）"""
    if lib not in LIBS:
        return {"success": False, "error": f"未知的素材库标识：{lib}"}
    return {"success": True, "fav": file in _scan_favorites(lib)}


def toggle_favorite(lib, file, fav):
    """收藏开关：fav=True 复制素材到收藏文件夹；fav=False 删除对应副本"""
    if lib not in LIBS:
        return {"success": False, "error": f"未知的素材库标识：{lib}"}
    src_full, root_real = _resolve_lib_file(lib, file)
    if not src_full:
        return {"success": False, "error": f"素材不存在：{file}"}
    rel = os.path.relpath(src_full, root_real)
    dst = os.path.join(_fav_root(lib), rel)
    try:
        if fav:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src_full, dst)
        elif os.path.isfile(dst):
            os.remove(dst)
            # 顺手清掉因此空出来的多级收藏子文件夹
            fav_real = os.path.realpath(_fav_root(lib))
            d = os.path.dirname(dst)
            while os.path.realpath(d) != fav_real:
                try:
                    os.rmdir(d)
                except OSError:
                    break
                d = os.path.dirname(d)
    except OSError as e:
        return {"success": False, "error": f"收藏操作失败：{e}"}
    _library_cache.pop(lib, None)
    return {"success": True}


# ========== 随机分类开关配置 ==========

def _load_random_config():
    try:
        with open(RANDOM_CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def get_random_disabled(lib):
    """读取某库被关闭随机的分类名集合"""
    rec = _load_random_config().get(LIBS[lib]["name"]) or {}
    disabled = rec.get("disabled")
    return set(disabled) if isinstance(disabled, list) else set()


def set_random_disabled(lib, disabled):
    """保存某库的随机分类开关（disabled=不参与随机的分类名列表）"""
    with _random_lock:
        cfg = _load_random_config()
        cfg[LIBS[lib]["name"]] = {"disabled": sorted(set(disabled))}
        with open(RANDOM_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=0)
    _library_cache.pop(lib, None)
    return {"success": True}


def _resolve_lib_file(lib, file, preview=False):
    """把库标识+相对路径解析成绝对路径；preview=True 时优先预览图文件夹，找不到回退原图"""
    file = (file or "").replace("\\", "/")
    roots = [_thumb_root(lib), _lib_root(lib)] if preview else [_lib_root(lib)]
    for root in roots:
        root_real = os.path.realpath(root)
        full = os.path.realpath(os.path.join(root_real, file))
        # 安全校验：真实路径必须仍在该库文件夹内（防止 ../ 越界读取任意文件）
        if full == root_real or not full.startswith(root_real + os.sep):
            return None, None
        if os.path.isfile(full):
            return full, root_real
    return None, None


# ========== 预览图自动生成 ==========

def make_thumb(lib, file):
    """为库中一张原图生成预览图（同名同扩展名，短边300）；已存在跳过，返回是否新生成"""
    src_full, _ = _resolve_lib_file(lib, file)
    if not src_full:
        return False
    dst = os.path.join(_thumb_root(lib), file.replace("/", os.sep))
    if os.path.isfile(dst):
        return False
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with Image.open(src_full) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            short = min(im.size)
            if short > THUMB_SHORT_EDGE:
                scale = THUMB_SHORT_EDGE / short
                im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
            if os.path.splitext(dst)[1].lower() == ".webp":
                im.save(dst, "WEBP", quality=80)
            else:
                im.save(dst, quality=85)
        return True
    except Exception as e:
        logger.warning(f"[WP三图组合] 生成预览图失败 {lib}/{file}: {e}")
        return False


def ensure_thumbs(lib, items):
    """检查库内全部素材的预览图，缺失的现场生成（新增素材后打开弹窗自动补图）"""
    made = 0
    for it in items:
        if make_thumb(lib, it["file"]):
            made += 1
    if made:
        logger.info(f"[WP三图组合] {LIBS[lib]['name']}库自动补生成预览图 {made} 张")


# ========== 节点本体 ==========

class WPThreeImageCombo:
    """脸模 + 服装 + 姿势 + 发型 四图组合，附带整合提示词输出"""

    CATEGORY = "🐳 WP_Node/🎨 图像"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("脸模图像", "服装图像", "姿势图像", "发型图像", "整合提示词")
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "服装库开关": ("BOOLEAN", {"default": True, "tooltip": "关闭后不输出服装图像（输出端口隐藏）"}),
                "姿势库开关": ("BOOLEAN", {"default": True, "tooltip": "关闭后不输出姿势图像（输出端口隐藏）"}),
                "发型库开关": ("BOOLEAN", {"default": True, "tooltip": "关闭后不输出发型图像（输出端口隐藏）"}),
                # 以下四项由前端界面写入，界面上隐藏
                "脸模文件": ("STRING", {"default": ""}),
                "服装选择": ("STRING", {"default": ""}),
                "姿势选择": ("STRING", {"default": ""}),
                "发型选择": ("STRING", {"default": ""}),
            },
        }

    @classmethod
    def _pick_item(cls, selection, lib, label):
        """解析 widget 选择；素材未选择/文件丢失时给出明确报错"""
        data = _parse_selection(selection)
        file = data.get("file", "")
        if not file:
            raise ValueError(f"【WP 三图组合】还没有选择{label}：请点击{label}卡片的「随机」或「素材库」按钮")
        _, root_real = _resolve_lib_file(lib, file)
        if not root_real:
            raise ValueError(f"【WP 三图组合】{label}图片不存在：{file}\n素材库可能有变动，请重新选择")
        return data

    def execute(self, 服装库开关, 姿势库开关, 发型库开关, 脸模文件, 服装选择, 姿势选择, 发型选择):
        # ---- 脸模 ----
        face = _parse_selection(脸模文件)
        face_name = face.get("name", "")
        face_sub = face.get("subfolder", "")
        if not face_name:
            raise ValueError("【WP 三图组合】还没有设置脸模图像：请点击节点上的「上传」或「素材库」按钮选择一张脸模图片")
        face_path = os.path.join(folder_paths.get_input_directory(), face_sub, face_name)
        if not os.path.isfile(face_path):
            raise ValueError(f"【WP 三图组合】脸模文件不存在：{face_path}\n请重新上传或选用脸模图像")
        face_img = _load_image_tensor(face_path)

        # ---- 各素材库（开启时才校验与加载）----
        picks = {}
        for key, enabled, selection in (
            ("outfit", 服装库开关, 服装选择),
            ("pose", 姿势库开关, 姿势选择),
            ("hair", 发型库开关, 发型选择),
        ):
            if enabled:
                picks[key] = self._pick_item(selection, key, LIBS[key]["label"])

        # 关闭的库输出 None（端口与连线保持原样，不送黑图占位）
        imgs = {"outfit": None, "pose": None, "hair": None}
        for key, data in picks.items():
            full, _ = _resolve_lib_file(key, data.get("file", ""))
            imgs[key] = _load_image_tensor(full)

        # ---- 整合提示词（关闭的库对应句子去掉）----
        def seg(key):
            d = (picks.get(key, {}).get("desc") or "").strip()
            return f"（{d}）" if d else ""

        prompt = " ".join(x for x in (
            _PROMPT_FACE,
            _PROMPT_OUTFIT.format(desc_seg=seg("outfit")) if 服装库开关 else "",
            _PROMPT_POSE.format(desc_seg=seg("pose")) if 姿势库开关 else "",
            _PROMPT_HAIR.format(desc_seg=seg("hair")) if 发型库开关 else "",
        ) if x)

        return (face_img, imgs["outfit"], imgs["pose"], imgs["hair"], prompt)


# ========== API 路由 ==========

@PromptServer.instance.routes.get("/wp_node/three_combo/library")
async def three_combo_library(request):
    """获取素材库清单（分类+每条素材的编号/描述/文件路径），前端弹窗和随机按钮使用"""
    try:
        lib = request.query.get("lib", "")
        result = await asyncio.to_thread(parse_library, lib)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP三图组合] 获取素材库失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/three_combo/image")
async def three_combo_image(request):
    """提供素材图片给前端（preview=1 时优先预览图，找不到回退原图）"""
    try:
        lib = request.query.get("lib", "")
        file = request.query.get("file", "")
        preview = request.query.get("preview", "") == "1"
        if lib not in LIBS or not file:
            return web.Response(status=400, text="缺少 lib 或 file 参数")
        full, _ = await asyncio.to_thread(_resolve_lib_file, lib, file, preview)
        if not full:
            return web.Response(status=404, text="图片不存在")
        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        return web.FileResponse(full, headers={
            "Content-Type": content_type,
            "Cache-Control": "public, max-age=3600",
        })
    except Exception as e:
        logger.error(f"[WP三图组合] 素材图片服务失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/three_combo/describe")
async def three_combo_describe(request):
    """保存一条素材的描述，持久化到库文件夹的「素材描述.json」"""
    try:
        body = await request.json()
        lib = body.get("lib", "")
        file = (body.get("file", "") or "").replace("\\", "/")
        if lib not in LIBS or not file:
            return web.json_response({"success": False, "error": "缺少 lib 或 file 参数"}, status=400)
        result = await asyncio.to_thread(update_description, lib, file, body.get("desc", ""))
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP三图组合] 保存描述失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/three_combo/favorite")
async def three_combo_favorite_query(request):
    """查询单张素材的收藏状态（节点卡片心形按钮显示用，避免拉取整个素材库）"""
    try:
        lib = request.query.get("lib", "")
        file = (request.query.get("file", "") or "").replace("\\", "/")
        if lib not in LIBS or not file:
            return web.json_response({"success": False, "error": "缺少 lib 或 file 参数"}, status=400)
        result = await asyncio.to_thread(is_favorite, lib, file)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP三图组合] 查询收藏状态失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/three_combo/favorite")
async def three_combo_favorite(request):
    """收藏开关：fav=true 复制素材到该库收藏文件夹，fav=false 删除对应副本"""
    try:
        body = await request.json()
        lib = body.get("lib", "")
        file = (body.get("file", "") or "").replace("\\", "/")
        if lib not in LIBS or not file:
            return web.json_response({"success": False, "error": "缺少 lib 或 file 参数"}, status=400)
        result = await asyncio.to_thread(toggle_favorite, lib, file, bool(body.get("fav")))
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP三图组合] 收藏操作失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/three_combo/random_config")
async def three_combo_random_config(request):
    """保存某素材库的随机分类开关（disabled=不参与随机的分类名列表）"""
    try:
        body = await request.json()
        lib = body.get("lib", "")
        if lib not in LIBS:
            return web.json_response({"success": False, "error": "缺少 lib 参数"}, status=400)
        disabled = body.get("disabled")
        if not isinstance(disabled, list):
            return web.json_response({"success": False, "error": "disabled 参数必须是数组"}, status=400)
        result = await asyncio.to_thread(set_random_disabled, lib, [str(x) for x in disabled])
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP三图组合] 保存随机配置失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/three_combo/import_face")
async def three_combo_import_face(request):
    """把素材库里的一张原图复制到 ComfyUI 的 input 目录，供前端设为脸模"""
    try:
        body = await request.json()
        lib = body.get("lib", "")
        file = (body.get("file", "") or "").replace("\\", "/")
        if lib not in LIBS or not file:
            return web.json_response({"success": False, "error": "缺少 lib 或 file 参数"}, status=400)
        full, _ = await asyncio.to_thread(_resolve_lib_file, lib, file)
        if not full:
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
