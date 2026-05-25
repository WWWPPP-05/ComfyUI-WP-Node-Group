"""
🐳 导入资产库节点
功能：将生图结果保存到资产库
"""
import os
import json
import logging
import tempfile
from aiohttp import web
from server import PromptServer

from ..asset_library import get_asset_library

logger = logging.getLogger(__name__)

asset_lib = get_asset_library()


@PromptServer.instance.routes.post("/wp_node/asset_library/save_from_node")
async def save_from_node(request):
    """从工作流节点保存图片到资产库"""
    try:
        # 读取 multipart 数据
        reader = await request.multipart()
        
        project_name = None
        category_name = None
        asset_name = None
        image_data = None
        filename = None
        
        async for field in reader:
            if field.name == 'project_name':
                project_name = await field.text()
            elif field.name == 'category_name':
                category_name = await field.text()
            elif field.name == 'asset_name':
                asset_name = await field.text()
            elif field.name == 'image':
                filename = field.filename or "image.png"
                image_data = await field.read(decode=False)
        
        if not image_data:
            return web.json_response({"success": False, "error": "缺少图像数据"})
        
        # 获取或创建项目
        projects = asset_lib.get_projects()
        proj_id = None
        
        if project_name and project_name.strip():
            # 查找或创建指定项目
            for p in projects:
                if p["name"] == project_name.strip():
                    proj_id = p["id"]
                    break
            if not proj_id:
                proj_id = asset_lib.create_project(project_name.strip())
        else:
            # 使用默认项目
            if projects:
                proj_id = projects[0]["id"]
            else:
                proj_id = asset_lib.create_project("默认项目")
        
        if not proj_id:
            return web.json_response({"success": False, "error": "无法获取项目"})
        
        # 获取或创建分类
        categories = asset_lib.get_categories(proj_id)
        cat_id = None
        
        if category_name and category_name.strip():
            for c in categories:
                if c["name"] == category_name.strip():
                    cat_id = c["id"]
                    break
            if not cat_id:
                asset_lib.create_category(proj_id, category_name.strip())
                categories = asset_lib.get_categories(proj_id)
                for c in categories:
                    if c["name"] == category_name.strip():
                        cat_id = c["id"]
                        break
        else:
            if categories:
                cat_id = categories[0]["id"]
            else:
                asset_lib.create_category(proj_id, "默认分类")
                categories = asset_lib.get_categories(proj_id)
                cat_id = categories[0]["id"]
        
        if not cat_id:
            return web.json_response({"success": False, "error": "无法获取分类"})
        
        # 保存图像到临时文件
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, filename or "image.png")
        
        with open(temp_path, 'wb') as f:
            f.write(image_data)
        
        # 添加到资产库
        name = asset_name.strip() if asset_name and asset_name.strip() else None
        asset_id = asset_lib.add_asset(temp_path, proj_id, cat_id, name)
        
        # 清理临时文件
        try:
            os.remove(temp_path)
        except:
            pass
        
        if asset_id:
            # 通知前端刷新资产库
            await PromptServer.instance.send_json("wp_asset_library_refresh", {"success": True, "asset_id": asset_id})
            return web.json_response({"success": True, "asset_id": asset_id})
        else:
            return web.json_response({"success": False, "error": "保存到资产库失败"})
            
    except Exception as e:
        logger.error(f"[WP资产库] 从节点保存失败: {e}", exc_info=True)
        return web.json_response({"success": False, "error": str(e)}, status=500)


class WPSaveToLibraryNode:
    """
    🐳 导入资产库节点
    将生图结果保存到资产库
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        # 获取项目和分类列表用于下拉选择
        try:
            projects = asset_lib.get_projects()
            # 生成 "项目名 / 分类名" 格式的选项
            location_names = ["(默认)"]
            for p in projects:
                proj_id = p["id"]
                proj_name = p["name"]
                cats = asset_lib.get_categories(proj_id)
                for c in cats:
                    location_names.append(f"{proj_name} / {c['name']}")
        except:
            location_names = ["(默认)"]
        
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                "save_location": (location_names, {
                    "default": "(默认)",
                    "tooltip": "选择保存位置（格式：项目名 / 分类名）"
                }),
                "asset_name": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "资产名称，留空使用默认名"
                }),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("状态",)
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "🐳 WP_Node"
    
    def execute(self, image, save_location="(默认)", asset_name=""):
        """
        执行保存到资产库
        
        Args:
            image: 图像数据
            save_location: 保存位置（格式：项目名 / 分类名）
            asset_name: 资产名称
        """
        import torch
        import numpy as np
        from PIL import Image as PILImage
        import io
        
        # 解析保存位置：如果是 "项目名 / 分类名" 格式，提取项目名和分类名
        project_name = ""
        category_name = ""
        if save_location and save_location != "(默认)" and " / " in save_location:
            parts = save_location.split(" / ", 1)
            project_name = parts[0].strip()
            category_name = parts[1].strip() if len(parts) > 1 else ""
        
        try:
            # 将 tensor 图像转换为 PNG 数据
            if isinstance(image, torch.Tensor):
                # 取第一张图
                img = image[0]
                # 转换为 numpy
                img = img.cpu().numpy()
                # 处理不同格式
                if img.shape[-1] == 3:
                    pil_img = PILImage.fromarray((img * 255).astype(np.uint8))
                elif img.shape[-1] == 4:
                    pil_img = PILImage.fromarray((img * 255).astype(np.uint8), 'RGBA')
                else:
                    pil_img = PILImage.fromarray((img * 255).astype(np.uint8))
                
                # 转换为 PNG 数据
                buffer = io.BytesIO()
                pil_img.save(buffer, format='PNG')
                image_data = buffer.getvalue()
            else:
                return ("❌ 不支持的图像格式",)
            
            # 通过 API 保存
            import requests
            
            files = {
                'image': ('image.png', image_data, 'image/png')
            }
            data = {
                'project_name': project_name,
                'category_name': category_name,
                'asset_name': asset_name
            }
            
            response = requests.post(
                "http://127.0.0.1:8188/wp_node/asset_library/save_from_node",
                files=files,
                data=data
            )
            
            result = response.json()
            
            if result.get("success"):
                return (f"✅ 已保存",)
            else:
                return (f"❌ {result.get('error', '未知错误')}",)
                
        except Exception as e:
            return (f"❌ {str(e)}",)
