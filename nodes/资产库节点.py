"""
🐳 WP 资产库节点
功能：资产库管理入口节点，提供资产库面板控制
数据结构：项目 -> 分类 -> 资产
"""
import os
import json
import asyncio
import logging
from aiohttp import web
import folder_paths
from server import PromptServer

from ..asset_library import get_asset_library
from ..asset_output_monitor import output_monitor

logger = logging.getLogger(__name__)

asset_lib = get_asset_library()

# 缩略图读取/生成的并发上限（防止素材多时大量线程同时压缩图片打满 CPU）
_thumb_gen_semaphore = asyncio.Semaphore(4)

# 浏览器缓存 30 天：缩略图按 asset_id 寻址且内容不变，切回文件夹时直接用本地缓存
_THUMB_CACHE_HEADERS = {"Cache-Control": "public, max-age=2592000"}


async def _get_thumbnail_in_background(gen_func, asset_id):
    """把缩略图读取/生成放到后台线程执行，避免 PIL/ffmpeg 阻塞服务器事件循环"""
    async with _thumb_gen_semaphore:
        return await asyncio.to_thread(gen_func, asset_id)


# ========== 存储位置管理 API ==========

def _migration_busy():
    """迁移进行中时返回 503 占用响应，否则返回 None（用于拦截写操作防止数据错乱）"""
    if asset_lib.get_migration_status().get("migrating"):
        return web.json_response(
            {"success": False, "error": "素材库正在迁移中，请等待迁移完成后再执行此操作"},
            status=503)
    return None


@PromptServer.instance.routes.get("/wp_node/asset_library/storage/info")
async def get_storage_info(request):
    """获取素材库存储信息（是否已配置、路径、占用、剩余空间）"""
    try:
        info = asset_lib.get_storage_info()
        return web.json_response(info)
    except Exception as e:
        logger.error(f"[WP资产库] 获取存储信息失败: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/storage/browse")
async def browse_directory(request):
    """浏览服务器文件夹（path 为空时返回磁盘列表）"""
    try:
        path = request.query.get("path", "")
        result = asset_lib.browse_directory(path if path else None)
        if "error" in result:
            return web.json_response(result, status=400)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 浏览文件夹失败: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/storage/create_folder")
async def create_folder(request):
    """在指定位置新建子文件夹（供文件夹浏览器使用）"""
    try:
        data = await request.json()
        parent = data.get("parent", "")
        name = data.get("name", "")
        result = asset_lib.create_folder(parent, name)
        if not result.get("success"):
            return web.json_response(result, status=400)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 新建文件夹失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/storage/validate_path")
async def validate_storage_path(request):
    """验证素材库路径合法性"""
    try:
        data = await request.json()
        result = asset_lib.validate_path(data.get("path", ""), create=False)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 验证路径失败: {e}", exc_info=True)
        return web.json_response({"valid": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/storage/set_location")
async def set_storage_location(request):
    """配置/迁移素材库位置（空库即时切换，有数据后台迁移，进度通过 migration_status 轮询）"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        path = data.get("path", "")
        result = asset_lib.start_set_location(path)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 配置素材库位置失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/storage/rebind")
async def rebind_storage_location(request):
    """重新绑定素材库路径（文件已就位、账本路径失效的场景）；dry_run=True 时仅检测不写入"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        path = data.get("path", "")
        dry_run = bool(data.get("dry_run", False))
        result = asset_lib.rebind_library_location(path, dry_run=dry_run)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 重新绑定路径失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/storage/migration_status")
async def get_migration_status(request):
    """获取迁移任务进度状态"""
    try:
        return web.json_response(asset_lib.get_migration_status())
    except Exception as e:
        logger.error(f"[WP资产库] 获取迁移状态失败: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


# ========== 项目管理 API ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/projects")
async def get_projects(request):
    try:
        projects = asset_lib.get_projects()
        return web.json_response(projects)
    except Exception as e:
        logger.error(f"[WP资产库] 获取项目失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/projects")
async def create_project(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        name = data.get("name", "").strip()
        description = data.get("description", "").strip()
        
        if not name:
            return web.json_response({"success": False, "error": "项目名称不能为空"})
        
        proj_id = asset_lib.create_project(name, description)
        if proj_id:
            return web.json_response({"success": True, "project_id": proj_id})
        else:
            return web.json_response({"success": False, "error": "项目已存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 创建项目异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.delete("/wp_node/asset_library/projects/{proj_id}")
async def delete_project(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        proj_id = request.match_info.get("proj_id")
        success = asset_lib.delete_project(proj_id)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "删除失败或项目不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 删除项目异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/projects/{proj_id}/rename")
async def rename_project(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        proj_id = request.match_info.get("proj_id")
        data = await request.json()
        new_name = data.get("name", "").strip()
        
        if not new_name:
            return web.json_response({"success": False, "error": "项目名称不能为空"})
        
        success = asset_lib.rename_project(proj_id, new_name)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "重命名失败或项目不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 重命名项目异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ========== 分类管理 API ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/categories")
async def get_categories(request):
    try:
        proj_id = request.query.get("project_id")
        categories = asset_lib.get_categories(proj_id)
        return web.json_response(categories)
    except Exception as e:
        logger.error(f"[WP资产库] 获取分类失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/categories")
async def create_category(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        proj_id = data.get("project_id", "").strip()
        name = data.get("name", "").strip()
        description = data.get("description", "").strip()
        
        if not proj_id:
            return web.json_response({"success": False, "error": "项目ID不能为空"})
        
        if not name:
            return web.json_response({"success": False, "error": "分类名称不能为空"})
        
        success = asset_lib.create_category(proj_id, name, description)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "分类已存在或项目不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 创建分类异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.delete("/wp_node/asset_library/categories/{cat_id}")
async def delete_category(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        cat_id = request.match_info.get("cat_id")
        proj_id = request.query.get("project_id")
        
        if not proj_id:
            return web.json_response({"success": False, "error": "缺少项目ID参数"})
        
        success = asset_lib.delete_category(proj_id, cat_id)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "删除失败或分类不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 删除分类异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/categories/{cat_id}/rename")
async def rename_category(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        cat_id = request.match_info.get("cat_id")
        data = await request.json()
        proj_id = data.get("project_id", "").strip()
        new_name = data.get("name", "").strip()
        
        if not proj_id:
            return web.json_response({"success": False, "error": "项目ID不能为空"})
        
        if not new_name:
            return web.json_response({"success": False, "error": "分类名称不能为空"})
        
        success = asset_lib.rename_category(proj_id, cat_id, new_name)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "重命名失败或分类不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 重命名分类异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/categories/reorder")
async def reorder_categories(request):
    """保存分类拖拽排序后的顺序"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        proj_id = data.get("project_id", "").strip()
        ordered_ids = data.get("ordered_ids", [])

        if not proj_id:
            return web.json_response({"success": False, "error": "缺少项目ID"})
        if not isinstance(ordered_ids, list) or not ordered_ids:
            return web.json_response({"success": False, "error": "缺少分类顺序列表"})

        success = asset_lib.reorder_categories(proj_id, ordered_ids)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "排序保存失败或项目不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 分类排序异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ========== 资产管理 API ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/assets/{category_id}")
async def get_assets_by_category(request):
    try:
        category_id = request.match_info.get("category_id")
        proj_id = request.query.get("project_id")
        query = request.query.get("q", "")

        # 列表构建含大量磁盘检查（每个素材一次），放后台线程避免阻塞事件循环导致切换分类卡顿
        assets = await asyncio.to_thread(asset_lib.get_assets_by_category, category_id, proj_id, query)
        return web.json_response(assets)
    except Exception as e:
        logger.error(f"[WP资产库] 获取资产失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/scan")
async def scan_local_files(request):
    """扫描本地文件并添加到资产库"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        project_id = data.get("project_id", "").strip()
        category_id = data.get("category_id", "").strip()
        
        if not project_id or not category_id:
            return web.json_response({"success": False, "error": "缺少项目ID或分类ID"})
        
        count = asset_lib.scan_local_images(project_id, category_id)
        
        # 通知前端刷新
        await PromptServer.instance.send_json("wp_asset_library_refresh", {"success": True, "scanned": count})
        
        return web.json_response({
            "success": True,
            "count": count,
            "message": f"扫描完成，新增 {count} 个资产"
        })
    except Exception as e:
        logger.error(f"[WP资产库] 扫描本地文件失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/asset/{asset_id}")
async def get_asset_info(request):
    try:
        asset_id = request.match_info.get("asset_id")
        asset_info = asset_lib.get_asset_info(asset_id)
        if asset_info:
            return web.json_response(asset_info)
        else:
            return web.json_response({"success": False, "error": "资产不存在"}, status=404)
    except Exception as e:
        logger.error(f"[WP资产库] 获取资产信息失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.delete("/wp_node/asset_library/asset/{asset_id}")
async def delete_asset(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        asset_id = request.match_info.get("asset_id")
        success = asset_lib.remove_asset(asset_id)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "删除失败或资产不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 删除资产异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/asset/{asset_id}/rename")
async def rename_asset(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        asset_id = request.match_info.get("asset_id")
        data = await request.json()
        new_name = data.get("name", "").strip()
        
        if not new_name:
            return web.json_response({"success": False, "error": "资产名称不能为空"})
        
        success = asset_lib.update_asset(asset_id, name=new_name)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "重命名失败（文件可能被占用或名称非法），请稍后重试"})
    except Exception as e:
        logger.error(f"[WP资产库] 重命名资产异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/assets/batch_delete")
async def batch_delete_assets(request):
    """批量删除资产"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        asset_ids = data.get("asset_ids", [])
        if not isinstance(asset_ids, list) or not asset_ids:
            return web.json_response({"success": False, "error": "缺少资产ID列表"})

        result = asset_lib.remove_assets_batch(asset_ids)
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 批量删除资产异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/assets/batch_move")
async def batch_move_assets(request):
    """批量移动资产到目标项目/分类"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        data = await request.json()
        asset_ids = data.get("asset_ids", [])
        target_project_id = data.get("project_id", "").strip()
        target_category_id = data.get("category_id", "").strip()

        if not isinstance(asset_ids, list) or not asset_ids:
            return web.json_response({"success": False, "error": "缺少资产ID列表"})
        if not target_project_id or not target_category_id:
            return web.json_response({"success": False, "error": "缺少目标项目ID或分类ID"})

        moved = 0
        failed = []
        for asset_id in asset_ids:
            ok, reason = asset_lib.move_asset(asset_id, target_project_id, target_category_id)
            if ok:
                moved += 1
            else:
                failed.append({"asset_id": asset_id, "reason": reason})

        return web.json_response({
            "success": len(failed) == 0,
            "moved": moved,
            "failed": failed
        })
    except Exception as e:
        logger.error(f"[WP资产库] 批量移动资产异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/asset/{asset_id}/clipboard")
async def copy_asset_to_clipboard(request):
    """复制素材本体到系统剪贴板（文件+图片/文本双格式，可粘贴到微信/输入框/文件夹等）"""
    try:
        asset_id = request.match_info.get("asset_id")
        ok, message = asset_lib.copy_asset_to_clipboard(asset_id)
        if ok:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": message})
    except Exception as e:
        logger.error(f"[WP资产库] 复制到剪贴板异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/asset/{asset_id}/video_frame")
async def copy_asset_video_frame(request):
    """抽取视频素材指定时间点的帧并复制到系统剪贴板（位图格式）"""
    try:
        asset_id = request.match_info.get("asset_id")
        data = await request.json()
        ok, message = asset_lib.copy_asset_video_frame(asset_id, data.get("time", 0))
        if ok:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": message})
    except Exception as e:
        logger.error(f"[WP资产库] 复制视频帧异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/sync_fs")
async def sync_filesystem(request):
    """校准素材库与文件系统：检测磁盘上的改名/删除并同步账本"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        result = asset_lib.sync_with_filesystem()
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 文件系统校准异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/scan_all")
async def scan_all(request):
    """全库智能扫描：自动发现新文件夹（项目/分类）并入库，同时校准改名/删除"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        result = asset_lib.full_scan()
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP资产库] 全库扫描失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ========== 输出文件夹监测 API ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/output/config")
async def get_output_config(request):
    """获取输出文件夹配置与监测状态（含自动检测到的 ComfyUI 输出目录）"""
    try:
        return web.json_response(output_monitor.get_config_info())
    except Exception as e:
        logger.error(f"[WP输出监测] 读取配置失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/output/config")
async def set_output_config(request):
    """配置/清除输出文件夹（path 为空 = 清除并停止监测）"""
    try:
        data = await request.json()
        result = output_monitor.set_output_path(data.get("path", ""))
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP输出监测] 保存配置失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/output/list")
async def list_output_files(request):
    """列出输出文件夹内容：sub 为空 = 根视图（子文件夹+全部文件），否则列该子文件夹；q 为搜索词"""
    try:
        result = output_monitor.list_output(
            request.query.get("sub", ""),
            request.query.get("q", ""),
        )
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP输出监测] 列出文件失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/output/thumbnail")
async def get_output_thumbnail(request):
    """输出图片缩略图（?path=相对路径）"""
    try:
        data = output_monitor.get_thumbnail(request.query.get("path", ""))
        if data is None:
            return web.Response(status=404, text="缩略图生成失败")
        return web.Response(body=data, content_type="image/jpeg")
    except Exception as e:
        logger.error(f"[WP输出监测] 生成缩略图异常: {e}", exc_info=True)
        return web.Response(status=500, text="internal error")


@PromptServer.instance.routes.get("/wp_node/asset_library/output/text")
async def get_output_text(request):
    """读取输出文本文件内容（拖拽注入文本 widget 用）"""
    try:
        content = output_monitor.read_text(request.query.get("path", ""))
        if content is None:
            return web.json_response({"success": False, "error": "读取失败或非文本文件"})
        return web.json_response({"success": True, "content": content})
    except Exception as e:
        logger.error(f"[WP输出监测] 读取文本异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/output/clipboard")
async def copy_output_to_clipboard(request):
    """复制输出文件本体到系统剪贴板（图片=文件+位图，文本=文件+文字，其他=仅文件）"""
    try:
        data = await request.json()
        return web.json_response(output_monitor.copy_to_clipboard(data.get("path", "")))
    except Exception as e:
        logger.error(f"[WP输出监测] 复制到剪贴板异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/output/video_frame")
async def copy_output_video_frame(request):
    """用 ffmpeg 抽取视频指定时间点的帧并复制到系统剪贴板（位图格式）"""
    try:
        data = await request.json()
        return web.json_response(output_monitor.copy_video_frame(data.get("path", ""), data.get("time", 0)))
    except Exception as e:
        logger.error(f"[WP输出监测] 复制视频帧异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/output/file")
async def serve_output_file(request):
    """以文件流形式提供输出文件（视频/音频播放，支持 Range 断点续传）"""
    try:
        import mimetypes
        info = output_monitor.get_file_info(request.query.get("path", ""))
        if not info:
            return web.Response(status=404, text="文件不存在")

        file_path = info["path"]
        content_type = info["content_type"]
        file_size = os.path.getsize(file_path)

        range_header = request.headers.get("Range", "")
        if range_header:
            start, end = 0, file_size - 1
            range_match = range_header.replace("bytes=", "").split("-")
            if range_match[0]:
                start = int(range_match[0])
            if len(range_match) > 1 and range_match[1]:
                end = int(range_match[1])

            if start >= file_size:
                return web.Response(status=416, text="Range Not Satisfiable")

            end = min(end, file_size - 1)
            with open(file_path, 'rb') as f:
                f.seek(start)
                data = f.read(end - start + 1)

            return web.Response(
                status=206,
                body=data,
                headers={
                    "Content-Type": content_type,
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                }
            )

        with open(file_path, 'rb') as f:
            data = f.read()
        return web.Response(body=data, content_type=content_type, headers={"Accept-Ranges": "bytes"})
    except Exception as e:
        logger.error(f"[WP输出监测] 文件流服务异常: {e}", exc_info=True)
        return web.Response(status=500, text="internal error")


@PromptServer.instance.routes.post("/wp_node/asset_library/output/copy_to_input")
async def copy_output_to_input(request):
    """复制输出文件到 ComfyUI input 目录（拖拽/双击生成节点用）"""
    try:
        data = await request.json()
        result = output_monitor.copy_to_input(data.get("path", ""))
        return web.json_response(result)
    except Exception as e:
        logger.error(f"[WP输出监测] 复制到 input 失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/asset/{asset_id}/copy_to_input")
async def copy_asset_to_input(request):
    """复制资产文件到 ComfyUI 的 input 目录，返回文件名供 LoadImage 节点加载"""
    try:
        import shutil
        asset_id = request.match_info.get("asset_id")
        
        # 获取资产文件路径
        asset_info = asset_lib.get_asset_info(asset_id)
        if not asset_info:
            return web.json_response({"success": False, "error": "资产不存在"})
        
        file_path = asset_info.get("file_path", "")
        if not file_path or not os.path.exists(file_path):
            # 尝试推算路径
            reconstructed = asset_lib._reconstruct_asset_path(asset_info)
            if reconstructed and os.path.exists(reconstructed):
                file_path = reconstructed
            else:
                return web.json_response({"success": False, "error": "资产文件不存在"})
        
        # 复制到 ComfyUI input 目录
        input_dir = folder_paths.get_input_directory()
        file_name = os.path.basename(file_path)
        dest_path = os.path.join(input_dir, file_name)
        
        # 如果同名文件已存在，避免覆盖
        if os.path.exists(dest_path):
            base, ext = os.path.splitext(file_name)
            counter = 1
            while os.path.exists(dest_path):
                file_name = f"{base}_{counter}{ext}"
                dest_path = os.path.join(input_dir, file_name)
                counter += 1
        
        shutil.copy2(file_path, dest_path)
        
        return web.json_response({"success": True, "file_name": file_name})
    except Exception as e:
        logger.error(f"[WP资产库] 复制资产文件异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/upload")
async def upload_asset(request):
    try:
        busy = _migration_busy()
        if busy:
            return busy

        reader = await request.multipart()
        
        project_id = None
        category_id = None
        asset_name = None
        uploaded_files = []
        
        async for field in reader:
            if field.name == 'project_id':
                project_id = await field.text()
            elif field.name == 'category_id':
                category_id = await field.text()
            elif field.name == 'name':
                asset_name = await field.text()
            elif field.name == 'files':
                filename = field.filename
                file_data = await field.read(decode=False)
                
                temp_dir = folder_paths.get_temp_directory()
                os.makedirs(temp_dir, exist_ok=True)
                temp_path = os.path.join(temp_dir, filename)
                
                with open(temp_path, 'wb') as f:
                    f.write(file_data)
                
                uploaded_files.append((temp_path, filename))
        
        if not project_id:
            return web.json_response({"success": False, "error": "缺少项目ID"})
        
        if not category_id:
            return web.json_response({"success": False, "error": "缺少分类ID"})
        
        if not uploaded_files:
            return web.json_response({"success": False, "error": "没有上传文件"})
        
        added_count = 0
        for file_path, original_filename in uploaded_files:
            name = asset_name if asset_name else None
            if added_count > 0:
                name = None
            
            asset_id = asset_lib.add_asset(file_path, project_id, category_id, name)
            if asset_id:
                added_count += 1
            try:
                os.remove(file_path)
            except:
                pass
        
        failed_count = len(uploaded_files) - added_count
        resp = {
            "success": added_count > 0,
            "count": added_count,
            "total": len(uploaded_files),
            "failed": failed_count
        }
        if added_count == 0:
            resp["error"] = "所有文件导入失败（文件可能已损坏或格式不支持）"
        return web.json_response(resp)
    except Exception as e:
        logger.error(f"[WP资产库] 上传资产异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/export_asset")
async def export_asset(request):
    try:
        data = await request.json()
        asset_id = data.get("asset_id")
        
        if not asset_id:
            return web.json_response({"success": False, "error": "缺少资产ID"})
        
        asset_info = asset_lib.get_asset_info(asset_id)
        if not asset_info:
            return web.json_response({"success": False, "error": "资产不存在"}, status=404)
        
        input_dir = folder_paths.get_input_directory()
        import shutil
        
        source_path = asset_info["file_path"]
        filename = asset_info["file_name"]
        
        basename, ext = os.path.splitext(filename)
        counter = 1
        new_filename = filename
        dest_path = os.path.join(input_dir, new_filename)
        
        while os.path.exists(dest_path):
            new_filename = f"{basename}_{counter}{ext}"
            dest_path = os.path.join(input_dir, new_filename)
            counter += 1
        
        shutil.copy2(source_path, dest_path)
        
        return web.json_response({
            "success": True,
            "filename": new_filename
        })
    except Exception as e:
        logger.error(f"[WP资产库] 导出资产异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/thumbnail/{asset_id}")
async def get_thumbnail(request):
    try:
        asset_id = request.match_info.get("asset_id")

        # 内存缓存 -> 磁盘缓存 -> 现场生成；放后台线程执行并限制并发
        thumb_bytes = await _get_thumbnail_in_background(asset_lib.get_cached_thumbnail, asset_id)

        if not thumb_bytes:
            return web.Response(status=404, text="缩略图不存在")

        return web.Response(body=thumb_bytes, content_type="image/jpeg", headers=_THUMB_CACHE_HEADERS)
    except Exception as e:
        logger.error(f"[WP资产库] 获取缩略图异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ========== 视频缩略图 API ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/video_thumbnail/{asset_id}")
async def get_video_thumbnail(request):
    """获取视频缩略图（磁盘缓存优先，缺失时用 ffmpeg 提取第一帧；后台线程执行）"""
    try:
        asset_id = request.match_info.get("asset_id")
        thumb_bytes = await _get_thumbnail_in_background(asset_lib.generate_video_thumbnail, asset_id)

        if not thumb_bytes:
            return web.Response(status=404, text="视频缩略图生成失败")

        return web.Response(body=thumb_bytes, content_type="image/jpeg", headers=_THUMB_CACHE_HEADERS)
    except Exception as e:
        logger.error(f"[WP资产库] 获取视频缩略图异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ========== 视频转码 API（浏览器兼容播放） ==========

@PromptServer.instance.routes.post("/wp_node/asset_library/asset/{asset_id}/transcode")
async def transcode_asset_video(request):
    """触发视频后台转码生成 H.264 缓存副本（原文件不动，每个视频只需转一次）"""
    try:
        asset_id = request.match_info.get("asset_id")
        return web.json_response(asset_lib.start_video_transcode(asset_id))
    except Exception as e:
        logger.error(f"[WP资产库] 触发视频转码异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/asset_library/asset/{asset_id}/transcode_status")
async def get_transcode_status(request):
    """查询视频转码进度状态（none/running/done/failed）"""
    try:
        asset_id = request.match_info.get("asset_id")
        return web.json_response(asset_lib.get_transcode_status(asset_id))
    except Exception as e:
        logger.error(f"[WP资产库] 查询转码状态异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ========== 文件流 API（用于视频/音频播放） ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/file/{asset_id}")
async def serve_asset_file(request):
    """以文件流形式提供资产文件，用于视频/音频播放（视频自动分流：浏览器播不了的用 H.264 转码缓存）"""
    try:
        import mimetypes
        asset_id = request.match_info.get("asset_id")
        file_path, _need_transcode = asset_lib.get_playable_path(asset_id)

        if not file_path or not os.path.exists(file_path):
            return web.Response(status=404, text="资产不存在或文件缺失")
        
        # 支持 Range 请求（视频拖动进度条需要）
        file_size = os.path.getsize(file_path)
        content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        
        range_header = request.headers.get("Range", "")
        if range_header:
            # 处理 Range 请求
            start, end = 0, file_size - 1
            range_match = range_header.replace("bytes=", "").split("-")
            if range_match[0]:
                start = int(range_match[0])
            if len(range_match) > 1 and range_match[1]:
                end = int(range_match[1])
            
            if start >= file_size:
                return web.Response(status=416, text="Range Not Satisfiable")
            
            end = min(end, file_size - 1)
            length = end - start + 1
            
            with open(file_path, 'rb') as f:
                f.seek(start)
                data = f.read(length)
            
            return web.Response(
                status=206,
                body=data,
                headers={
                    "Content-Type": content_type,
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                }
            )
        else:
            # 完整文件请求
            with open(file_path, 'rb') as f:
                data = f.read()
            
            return web.Response(
                body=data,
                content_type=content_type,
                headers={"Accept-Ranges": "bytes"}
            )
    except Exception as e:
        logger.error(f"[WP资产库] 文件流服务异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ========== 文本文件 API ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/text/{asset_id}")
async def read_text_asset(request):
    """读取文本资产内容"""
    try:
        asset_id = request.match_info.get("asset_id")
        content = asset_lib.read_text_content(asset_id)
        
        if content is None:
            return web.json_response({"success": False, "error": "读取失败或文件不存在"}, status=404)
        
        return web.json_response({"success": True, "content": content})
    except Exception as e:
        logger.error(f"[WP资产库] 读取文本异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/text/{asset_id}")
async def save_text_asset(request):
    """保存文本资产内容"""
    try:
        busy = _migration_busy()
        if busy:
            return busy

        asset_id = request.match_info.get("asset_id")
        data = await request.json()
        content = data.get("content", "")
        
        success = asset_lib.save_text_content(asset_id, content)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "保存失败"})
    except Exception as e:
        logger.error(f"[WP资产库] 保存文本异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)
