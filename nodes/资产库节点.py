"""
🐳 WP 资产库节点
功能：资产库管理入口节点，提供资产库面板控制
数据结构：项目 -> 分类 -> 资产
"""
import os
import json
import logging
from aiohttp import web
import folder_paths
from server import PromptServer

from ..asset_library import get_asset_library

logger = logging.getLogger(__name__)

asset_lib = get_asset_library()


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


# ========== 资产管理 API ==========

@PromptServer.instance.routes.get("/wp_node/asset_library/assets/{category_id}")
async def get_assets_by_category(request):
    try:
        category_id = request.match_info.get("category_id")
        proj_id = request.query.get("project_id")
        query = request.query.get("q", "")
        
        assets = asset_lib.get_assets_by_category(category_id, proj_id, query)
        return web.json_response(assets)
    except Exception as e:
        logger.error(f"[WP资产库] 获取资产失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/asset_library/scan")
async def scan_local_files(request):
    """扫描本地文件并添加到资产库"""
    try:
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
        asset_id = request.match_info.get("asset_id")
        data = await request.json()
        new_name = data.get("name", "").strip()
        
        if not new_name:
            return web.json_response({"success": False, "error": "资产名称不能为空"})
        
        success = asset_lib.update_asset(asset_id, name=new_name)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "重命名失败或资产不存在"})
    except Exception as e:
        logger.error(f"[WP资产库] 重命名资产异常: {e}", exc_info=True)
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
        
        return web.json_response({
            "success": True,
            "count": added_count,
            "total": len(uploaded_files)
        })
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
        
        # 从内存缓存获取缩略图（不存在则从原图临时生成）
        thumb_bytes = asset_lib.get_cached_thumbnail(asset_id)
        
        if not thumb_bytes:
            return web.Response(status=404, text="缩略图不存在")
        
        return web.Response(body=thumb_bytes, content_type="image/jpeg")
    except Exception as e:
        logger.error(f"[WP资产库] 获取缩略图异常: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)
