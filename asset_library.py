"""
🐳 WP 资产库管理模块
功能：管理图片资产，支持项目、分类、资产三级层级结构
"""
import os
import json
import shutil
import hashlib
import uuid
import mimetypes
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import folder_paths

# 尝试导入PIL用于缩略图生成
try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("[WP资产库] PIL未安装，缩略图功能将受限")


class AssetLibraryManager:
    """
    资产库管理器
    负责管理图片资产的存储、分类、搜索等功能
    数据结构：项目 -> 分类 -> 资产
    """
    
    def __init__(self, base_path: str = None):
        """
        初始化资产库管理器
        
        Args:
            base_path: 资产库根目录路径，如果不提供则使用默认路径
        """
        # 设置资产库路径
        if base_path is None:
            # 使用自定义节点目录下的 wp_asset_library 子目录
            current_dir = os.path.dirname(os.path.abspath(__file__))
            self.base_path = os.path.join(current_dir, "wp_asset_library")
            
            # 迁移旧数据（如果存在）
            old_path = os.path.join(folder_paths.get_input_directory(), "wp_assets")
            if not os.path.exists(os.path.join(self.base_path, "assets.json")) and os.path.exists(os.path.join(old_path, "assets.json")):
                print("[WP资产库] 检测到旧版数据，正在迁移到新路径...")
                try:
                    # 复制旧数据到新路径
                    for item in os.listdir(old_path):
                        src = os.path.join(old_path, item)
                        dst = os.path.join(self.base_path, item)
                        if os.path.isdir(src):
                            shutil.copytree(src, dst, dirs_exist_ok=True)
                        else:
                            shutil.copy2(src, dst)
                    print("[WP资产库] 旧数据迁移完成")
                except Exception as e:
                    print(f"[WP资产库] 数据迁移失败: {e}")
        else:
            self.base_path = base_path
            
        # 创建必要的目录
        os.makedirs(self.base_path, exist_ok=True)
        
        # 资产库配置文件路径
        self.config_path = os.path.join(self.base_path, "config.json")
        # 资产库数据文件路径
        self.data_path = os.path.join(self.base_path, "assets.json")
        
        # 初始化配置和数据
        self._init_config()
        self._init_data()
        
        # 缩略图内存缓存：asset_id -> bytes
        self._thumbnail_cache = {}
    
    def _init_config(self):
        """初始化配置文件"""
        if not os.path.exists(self.config_path):
            config = {
                "version": "2.0",
                "created_at": datetime.now().isoformat(),
                "default_project": "默认项目",
                "default_category": "默认分类",
                "supported_formats": [".jpg", ".jpeg", ".png", ".webp", ".gif"],
                "max_file_size": 50 * 1024 * 1024,  # 50MB
                "thumbnail_size": [256, 256]
            }
            with open(self.config_path, 'w', encoding='utf-8') as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
        else:
            with open(self.config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
    
    def _init_data(self):
        """初始化资产数据文件"""
        if not os.path.exists(self.data_path):
            data = self._create_default_data()
            with open(self.data_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        else:
            with open(self.data_path, 'r', encoding='utf-8') as f:
                try:
                    data = json.load(f)
                    # 兼容旧数据格式迁移
                    if "projects" not in data:
                        print("[WP资产库] 检测到旧版数据格式，正在迁移到新版...")
                        data = self._migrate_old_data(data)
                        self._save_data(data)
                        print("[WP资产库] 数据迁移完成")
                except json.JSONDecodeError as e:
                    print(f"[WP资产库] 数据文件损坏，正在重建: {e}")
                    data = self._create_default_data()
                    with open(self.data_path, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
    
    def _create_default_data(self) -> Dict:
        """创建默认数据结构"""
        default_project_id = str(uuid.uuid4())
        default_category_id = str(uuid.uuid4())
        
        return {
            "projects": {
                default_project_id: {
                    "id": default_project_id,
                    "name": "默认项目",
                    "description": "默认项目",
                    "created_at": datetime.now().isoformat(),
                    "categories": {
                        default_category_id: {
                            "id": default_category_id,
                            "name": "默认分类",
                            "description": "默认资产分类",
                            "created_at": datetime.now().isoformat(),
                            "assets": []
                        }
                    }
                }
            },
            "assets": {},  # 资产详情，key为asset_id
            "next_asset_id": 1
        }
    
    def _migrate_old_data(self, old_data: Dict) -> Dict:
        """将旧版数据迁移到新版结构"""
        default_project_id = str(uuid.uuid4())
        
        new_data = {
            "projects": {
                default_project_id: {
                    "id": default_project_id,
                    "name": "默认项目",
                    "description": "从旧版数据迁移",
                    "created_at": datetime.now().isoformat(),
                    "categories": old_data.get("categories", {})
                }
            },
            "assets": old_data.get("assets", {}),
            "next_asset_id": old_data.get("next_asset_id", 1)
        }
        
        return new_data
    
    def _load_data(self) -> Dict:
        """加载资产数据"""
        with open(self.data_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def _save_data(self, data: Dict):
        """保存资产数据"""
        with open(self.data_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    
    # ========== 项目管理方法 ==========
    
    def get_projects(self) -> List[Dict]:
        """获取所有项目"""
        data = self._load_data()
        projects = []
        for proj_id, proj_info in data["projects"].items():
            project = {
                "id": proj_id,
                "name": proj_info["name"],
                "description": proj_info.get("description", ""),
                "category_count": len(proj_info.get("categories", {})),
                "created_at": proj_info.get("created_at", "")
            }
            projects.append(project)
        return projects
    
    def create_project(self, name: str, description: str = "") -> Optional[str]:
        """创建新项目"""
        if not name or not name.strip():
            return None
            
        name = name.strip()
        data = self._load_data()
        
        # 检查项目名称是否已存在
        for proj_id, proj_info in data["projects"].items():
            if proj_info["name"] == name:
                return None  # 项目已存在
        
        # 生成新的项目ID
        proj_id = str(uuid.uuid4())
        
        # 添加新项目
        data["projects"][proj_id] = {
            "id": proj_id,
            "name": name,
            "description": description,
            "created_at": datetime.now().isoformat(),
            "categories": {}
        }
        
        self._save_data(data)
        return proj_id
    
    def delete_project(self, proj_id: str) -> bool:
        """删除项目（级联删除分类、资产文件、本地文件夹）"""
        data = self._load_data()
        
        if proj_id not in data["projects"]:
            return False
        
        project = data["projects"][proj_id]
        proj_name = self._sanitize_folder_name(project["name"])
        proj_folder = os.path.join(self.base_path, proj_name)
        
        # 收集要删除的所有资产ID
        assets_to_delete = set()
        for cat_id, cat_info in project.get("categories", {}).items():
            for aid in cat_info.get("assets", []):
                assets_to_delete.add(aid)
        
        # 删除资产文件和缩略图
        for asset_id in assets_to_delete:
            if asset_id in data["assets"]:
                asset = data["assets"][asset_id]
                file_path = asset.get("file_path", "")
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"[WP资产库] 删除资产文件失败: {e}")
                
                # 删除缩略图
                thumb_path = os.path.join(os.path.dirname(file_path), f"thumbnail_{asset_id}.jpg")
                if os.path.exists(thumb_path):
                    try:
                        os.remove(thumb_path)
                    except Exception as e:
                        print(f"[WP资产库] 删除缩略图失败: {e}")
                
                del data["assets"][asset_id]
        
        # 删除项目记录
        del data["projects"][proj_id]
        self._save_data(data)
        
        # 删除本地项目文件夹
        if os.path.exists(proj_folder):
            try:
                shutil.rmtree(proj_folder, ignore_errors=True)
            except Exception as e:
                print(f"[WP资产库] 删除项目文件夹失败: {e}")
        
        # 如果删除后没有项目了，自动创建默认项目
        if len(data["projects"]) == 0:
            self._create_default_project(data)
        
        return True
    
    def _create_default_project(self, data: Dict):
        """创建默认项目"""
        default_project_id = str(uuid.uuid4())
        default_category_id = str(uuid.uuid4())
        
        data["projects"][default_project_id] = {
            "id": default_project_id,
            "name": "默认项目",
            "description": "默认项目",
            "created_at": datetime.now().isoformat(),
            "categories": {
                default_category_id: {
                    "id": default_category_id,
                    "name": "默认分类",
                    "description": "默认资产分类",
                    "created_at": datetime.now().isoformat(),
                    "assets": []
                }
            }
        }
        
        self._save_data(data)
        print("[WP资产库] 已自动创建默认项目")
    
    def rename_project(self, proj_id: str, new_name: str) -> bool:
        """重命名项目（同步重命名对应文件夹 + 更新所有分类下的资产路径）"""
        if not new_name or not new_name.strip():
            return False
            
        data = self._load_data()
        
        if proj_id not in data["projects"]:
            return False
            
        # 检查新名称是否已存在
        for existing_id, proj_info in data["projects"].items():
            if existing_id != proj_id and proj_info["name"] == new_name.strip():
                return False
        
        old_name = data["projects"][proj_id]["name"]
        old_folder_name = self._sanitize_folder_name(old_name)
        new_folder_name = self._sanitize_folder_name(new_name.strip())
        
        # 如果文件夹名不同，重命名文件夹 + 更新所有资产的 file_path
        if old_folder_name != new_folder_name:
            old_proj_dir = os.path.join(self.base_path, old_folder_name)
            new_proj_dir = os.path.join(self.base_path, new_folder_name)
            
            if os.path.exists(old_proj_dir):
                try:
                    shutil.move(old_proj_dir, new_proj_dir)
                except Exception as e:
                    print(f"[WP资产库] 重命名项目文件夹失败: {e}")
            
            # 更新该项目下所有资产的 file_path
            project = data["projects"][proj_id]
            for cat_id, cat_info in project.get("categories", {}).items():
                cat_name = self._sanitize_folder_name(cat_info["name"])
                new_cat_dir = os.path.join(new_proj_dir, cat_name)
                for asset_id in cat_info.get("assets", []):
                    if asset_id in data["assets"]:
                        old_path = data["assets"][asset_id].get("file_path", "")
                        if old_path:
                            old_file_name = os.path.basename(old_path)
                            new_path = os.path.join(new_cat_dir, old_file_name)
                            data["assets"][asset_id]["file_path"] = new_path
        
        data["projects"][proj_id]["name"] = new_name.strip()
        self._save_data(data)
        return True
    
    def get_project_info(self, proj_id: str) -> Optional[Dict]:
        """获取项目详细信息"""
        data = self._load_data()
        if proj_id in data["projects"]:
            proj = data["projects"][proj_id]
            return {
                "id": proj["id"],
                "name": proj["name"],
                "description": proj.get("description", ""),
                "category_count": len(proj.get("categories", {})),
                "created_at": proj.get("created_at", "")
            }
        return None
    
    # ========== 分类管理方法 ==========
    
    def get_categories(self, proj_id: str = None) -> List[Dict]:
        """获取分类列表（可按项目筛选）"""
        data = self._load_data()
        
        if proj_id:
            if proj_id not in data["projects"]:
                return []
            categories = data["projects"][proj_id].get("categories", {})
        else:
            # 获取所有项目的分类
            categories = {}
            for proj_info in data["projects"].values():
                categories.update(proj_info.get("categories", {}))
        
        result = []
        for cat_id, cat_info in categories.items():
            category = {
                "id": cat_id,
                "name": cat_info["name"],
                "description": cat_info.get("description", ""),
                "asset_count": len(cat_info.get("assets", [])),
                "created_at": cat_info.get("created_at", "")
            }
            result.append(category)
        return result
    
    def create_category(self, proj_id: str, name: str, description: str = "") -> bool:
        """创建新分类"""
        if not name or not name.strip():
            return False
            
        name = name.strip()
        data = self._load_data()
        
        if proj_id not in data["projects"]:
            return False
        
        # 检查分类名是否已存在（在同一项目内）
        categories = data["projects"][proj_id].get("categories", {})
        for cat_id, cat_info in categories.items():
            if cat_info["name"] == name:
                return False
        
        # 生成新的分类ID
        cat_id = str(uuid.uuid4())
        
        # 添加新分类
        data["projects"][proj_id]["categories"][cat_id] = {
            "id": cat_id,
            "name": name,
            "description": description,
            "created_at": datetime.now().isoformat(),
            "assets": []
        }
        
        self._save_data(data)
        return True
    
    def delete_category(self, proj_id: str, cat_id: str) -> bool:
        """删除分类（级联删除资产文件、本地文件夹）"""
        data = self._load_data()
        
        if proj_id not in data["projects"]:
            return False
            
        project = data["projects"][proj_id]
        if cat_id not in project.get("categories", {}):
            return False
            
        category = project["categories"][cat_id]
        cat_name = self._sanitize_folder_name(category["name"])
        proj_name = self._sanitize_folder_name(project["name"])
        cat_folder = os.path.join(self.base_path, proj_name, cat_name)
        
        # 收集要删除的资产ID
        assets_to_delete = list(category.get("assets", []))
        
        # 删除资产文件和缩略图
        for asset_id in assets_to_delete:
            if asset_id in data["assets"]:
                asset = data["assets"][asset_id]
                file_path = asset.get("file_path", "")
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"[WP资产库] 删除资产文件失败: {e}")
                
                # 删除缩略图
                thumb_path = os.path.join(os.path.dirname(file_path), f"thumbnail_{asset_id}.jpg")
                if os.path.exists(thumb_path):
                    try:
                        os.remove(thumb_path)
                    except Exception as e:
                        print(f"[WP资产库] 删除缩略图失败: {e}")
                
                del data["assets"][asset_id]
        
        # 删除分类记录
        del data["projects"][proj_id]["categories"][cat_id]
        self._save_data(data)
        
        # 删除本地分类文件夹
        if os.path.exists(cat_folder):
            try:
                shutil.rmtree(cat_folder, ignore_errors=True)
            except Exception as e:
                print(f"[WP资产库] 删除分类文件夹失败: {e}")
        
        return True
    
    def rename_category(self, proj_id: str, cat_id: str, new_name: str) -> bool:
        """重命名分类（同步重命名对应文件夹 + 更新资产路径）"""
        if not new_name or not new_name.strip():
            return False
            
        data = self._load_data()
        
        if proj_id not in data["projects"]:
            return False
            
        project = data["projects"][proj_id]
        if cat_id not in project.get("categories", {}):
            return False
            
        # 检查新名称是否已存在
        categories = project["categories"]
        for existing_id, cat_info in categories.items():
            if existing_id != cat_id and cat_info["name"] == new_name.strip():
                return False
        
        old_name = categories[cat_id]["name"]
        old_folder_name = self._sanitize_folder_name(old_name)
        new_folder_name = self._sanitize_folder_name(new_name.strip())
        
        # 如果文件夹名不同，重命名文件夹 + 更新资产路径
        if old_folder_name != new_folder_name:
            proj_name = self._sanitize_folder_name(project["name"])
            old_cat_dir = os.path.join(self.base_path, proj_name, old_folder_name)
            new_cat_dir = os.path.join(self.base_path, proj_name, new_folder_name)
            
            if os.path.exists(old_cat_dir):
                try:
                    shutil.move(old_cat_dir, new_cat_dir)
                except Exception as e:
                    print(f"[WP资产库] 重命名分类文件夹失败: {e}")
            
            # 更新该分类下所有资产的 file_path
            assets = categories[cat_id].get("assets", [])
            for asset_id in assets:
                if asset_id in data["assets"]:
                    old_path = data["assets"][asset_id].get("file_path", "")
                    if old_path:
                        old_file_name = os.path.basename(old_path)
                        new_path = os.path.join(new_cat_dir, old_file_name)
                        data["assets"][asset_id]["file_path"] = new_path
        
        categories[cat_id]["name"] = new_name.strip()
        self._save_data(data)
        return True
    
    # ========== 资产管理方法 ==========
    
    def _generate_asset_id(self) -> str:
        """生成资产ID"""
        data = self._load_data()
        asset_id = f"asset_{data['next_asset_id']}"
        data["next_asset_id"] += 1
        self._save_data(data)
        return asset_id
    
    def _calculate_file_hash(self, file_path: str) -> str:
        """计算文件哈希值"""
        hash_md5 = hashlib.md5()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
    
    def _generate_thumbnail_bytes(self, image_path: str, size=(256, 256)) -> Optional[bytes]:
        """生成缩略图并返回 bytes（不保存到磁盘）"""
        if not PIL_AVAILABLE:
            return None
            
        try:
            with Image.open(image_path) as img:
                # 保持宽高比的缩放
                img.thumbnail(size, Image.Resampling.LANCZOS)
                
                # RGBA 转 RGB（JPEG 不支持透明通道）
                if img.mode == 'RGBA':
                    img = img.convert('RGB')
                
                # 转换为 JPEG 格式
                import io
                buffer = io.BytesIO()
                img.save(buffer, format='JPEG', quality=85, optimize=True)
                return buffer.getvalue()
        except Exception as e:
            print(f"[WP资产库] 生成缩略图失败: {e}")
            return None
    
    def add_asset(self, file_path: str, proj_id: str, cat_id: str, name: str = None, description: str = "") -> Optional[str]:
        """
        添加资产到库中
        
        Args:
            file_path: 源文件路径
            proj_id: 项目ID
            cat_id: 分类ID
            name: 资产名称，如果不提供则使用文件名
            description: 资产描述
            
        Returns:
            资产ID，如果失败返回None
        """
        # 检查文件是否存在
        if not os.path.exists(file_path):
            print(f"[WP资产库] 文件不存在: {file_path}")
            return None
        
        # 检查项目是否存在
        data = self._load_data()
        if proj_id not in data["projects"]:
            print(f"[WP资产库] 项目不存在: {proj_id}")
            return None
        
        project = data["projects"][proj_id]
        
        # 检查分类是否存在
        if cat_id not in project.get("categories", {}):
            print(f"[WP资产库] 分类不存在: {cat_id}")
            return None
        
        # 检查文件类型
        file_ext = os.path.splitext(file_path)[1].lower()
        supported_formats = [".jpg", ".jpeg", ".png", ".webp", ".gif"]
        
        if file_ext not in supported_formats:
            print(f"[WP资产库] 不支持的文件格式: {file_ext}")
            return None
        
        # 如果没有提供名称，使用文件名（去掉扩展名）
        if name is None or not name.strip():
            name = os.path.splitext(os.path.basename(file_path))[0]
        
        # 使用文件名（去扩展名）作为显示名，但记录实际保存的文件名
        display_name = name
        original_filename = os.path.basename(file_path)
        
        # 创建目标目录：项目名/分类名/
        proj_name = self._sanitize_folder_name(project["name"])
        category = project["categories"][cat_id]
        cat_name = self._sanitize_folder_name(category["name"])
        
        asset_folder = os.path.join(self.base_path, proj_name, cat_name)
        os.makedirs(asset_folder, exist_ok=True)
        
        # 处理同名文件：如果文件已存在，自动改名
        dest_filename = original_filename
        dest_file_path = os.path.join(asset_folder, dest_filename)
        counter = 1
        
        while os.path.exists(dest_file_path):
            base, ext = os.path.splitext(original_filename)
            dest_filename = f"{base}({counter}){ext}"
            dest_file_path = os.path.join(asset_folder, dest_filename)
            counter += 1
        
        # 复制文件到目标目录
        try:
            shutil.copy2(file_path, dest_file_path)
        except Exception as e:
            print(f"[WP资产库] 复制文件失败: {e}")
            return None
        
        # 计算文件哈希
        file_hash = self._calculate_file_hash(dest_file_path)
        
        # 生成资产ID（用于唯一标识）
        asset_id = self._generate_asset_id()
        
        # 获取文件信息
        stat = os.stat(dest_file_path)
        file_size = stat.st_size
        file_mtime = datetime.fromtimestamp(stat.st_mtime).isoformat()
        
        # 更新数据
        data = self._load_data()
        
        # 添加资产信息
        data["assets"][asset_id] = {
            "id": asset_id,
            "name": display_name,
            "description": description,
            "project_id": proj_id,
            "category_id": cat_id,
            "file_path": dest_file_path,
            "file_name": dest_filename,
            "file_size": file_size,
            "file_ext": file_ext,
            "file_hash": file_hash,
            "upload_time": datetime.now().isoformat(),
            "modified_time": file_mtime
        }
        
        # 将资产ID添加到分类中
        data["projects"][proj_id]["categories"][cat_id]["assets"].append(asset_id)
        
        self._save_data(data)
        
        # 预生成缩略图到内存缓存
        if file_ext.lower() in ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.gif']:
            thumb_bytes = self._generate_thumbnail_bytes(dest_file_path)
            if thumb_bytes:
                self._thumbnail_cache[asset_id] = thumb_bytes
        
        return asset_id
    
    def _sanitize_folder_name(self, name: str) -> str:
        """将名称转换为安全的文件夹名"""
        # 替换Windows不允许的字符
        for ch in ['<', '>', ':', '"', '/', '\\', '|', '?', '*']:
            name = name.replace(ch, '_')
        name = name.strip()
        if not name:
            name = "未命名"
        return name
    
    def remove_asset(self, asset_id: str) -> bool:
        """从库中移除资产"""
        data = self._load_data()
        
        if asset_id not in data["assets"]:
            return False
        
        asset = data["assets"][asset_id]
        proj_id = asset.get("project_id")
        cat_id = asset.get("category_id")
        
        # 删除资产文件
        if os.path.exists(asset["file_path"]):
            try:
                os.remove(asset["file_path"])
            except Exception as e:
                print(f"[WP资产库] 删除资产文件失败: {e}")
        
        # 删除缩略图
        file_dir = os.path.dirname(asset["file_path"])
        thumbnail_path = os.path.join(file_dir, f"thumbnail_{asset_id}.jpg")
        if os.path.exists(thumbnail_path):
            try:
                os.remove(thumbnail_path)
            except Exception as e:
                print(f"[WP资产库] 删除缩略图失败: {e}")
        
        # 从分类中移除资产ID
        if proj_id and cat_id and proj_id in data["projects"]:
            categories = data["projects"][proj_id].get("categories", {})
            if cat_id in categories:
                if asset_id in categories[cat_id].get("assets", []):
                    categories[cat_id]["assets"].remove(asset_id)
        
        # 删除资产记录
        del data["assets"][asset_id]
        self._save_data(data)
        return True
    
    def get_assets_by_category(self, cat_id: str, proj_id: str = None, search_query: str = "") -> List[Dict]:
        """根据分类获取资产列表"""
        data = self._load_data()
        
        if proj_id:
            if proj_id not in data["projects"]:
                return []
            project = data["projects"][proj_id]
            if cat_id not in project.get("categories", {}):
                return []
            category = project["categories"][cat_id]
        else:
            # 在所有项目中查找分类
            category = None
            for proj_info in data["projects"].values():
                if cat_id in proj_info.get("categories", {}):
                    category = proj_info["categories"][cat_id]
                    break
            
            if category is None:
                return []
        
        assets = []
        
        for asset_id in category.get("assets", []):
            if asset_id in data["assets"]:
                asset = data["assets"][asset_id]
                
                # 检查搜索查询
                if search_query:
                    search_lower = search_query.lower()
                    if (search_lower not in asset["name"].lower() and 
                        search_lower not in asset.get("description", "").lower()):
                        continue
                
                assets.append({
                    "id": asset["id"],
                    "name": asset["name"],
                    "description": asset.get("description", ""),
                    "file_name": asset["file_name"],
                    "file_size": asset["file_size"],
                    "upload_time": asset["upload_time"],
                    "thumbnail_path": self._get_thumbnail_path(asset_id)
                })
        
        return assets
    
    def search_assets(self, query: str, proj_id: str = None) -> List[Dict]:
        """搜索所有资产"""
        data = self._load_data()
        results = []
        
        query_lower = query.lower()
        for asset_id, asset in data["assets"].items():
            # 如果指定了项目ID，只搜索该项目
            if proj_id and asset.get("project_id") != proj_id:
                continue
                
            if (query_lower in asset["name"].lower() or 
                query_lower in asset.get("description", "").lower()):
                
                results.append({
                    "id": asset["id"],
                    "name": asset["name"],
                    "description": asset.get("description", ""),
                    "file_name": asset["file_name"],
                    "file_size": asset["file_size"],
                    "upload_time": asset["upload_time"],
                    "category_id": asset.get("category_id"),
                    "project_id": asset.get("project_id"),
                    "thumbnail_path": self._get_thumbnail_path(asset_id)
                })
        
        return results
    
    def get_asset_info(self, asset_id: str) -> Optional[Dict]:
        """获取资产详细信息"""
        data = self._load_data()
        if asset_id in data["assets"]:
            asset = data["assets"][asset_id]
            return {
                "id": asset["id"],
                "name": asset["name"],
                "description": asset.get("description", ""),
                "file_name": asset["file_name"],
                "file_path": asset["file_path"],
                "file_size": asset["file_size"],
                "file_ext": asset["file_ext"],
                "upload_time": asset["upload_time"],
                "modified_time": asset["modified_time"],
                "category_id": asset.get("category_id"),
                "project_id": asset.get("project_id")
            }
        return None
    
    def get_cached_thumbnail(self, asset_id: str) -> Optional[bytes]:
        """获取缩略图 bytes（从内存缓存，不存在则从原图临时生成）"""
        # 先从缓存找
        if asset_id in self._thumbnail_cache:
            print(f"[WP资产库] 缩略图命中缓存: {asset_id}")
            return self._thumbnail_cache[asset_id]
        
        # 缓存没有，从原图临时生成
        asset_info = self.get_asset_info(asset_id)
        if not asset_info:
            print(f"[WP资产库] 缩略图获取失败: 资产不存在 {asset_id}")
            return None
        
        # 尝试用记录的 file_path
        file_path = asset_info.get("file_path", "")
        used_reconstructed = False
        if not file_path or not os.path.exists(file_path):
            print(f"[WP资产库] 记录路径不存在，尝试推算: {file_path}")
            # 记录的路径不存在（可能是旧数据），尝试推算新路径
            file_path = self._reconstruct_asset_path(asset_info)
            used_reconstructed = True
            if not file_path or not os.path.exists(file_path):
                print(f"[WP资产库] 推算路径也不存在: {file_path}")
                return None
        
        print(f"[WP资产库] 生成缩略图: asset={asset_id}, path={file_path}, 推算={used_reconstructed}")
        thumb_bytes = self._generate_thumbnail_bytes(file_path)
        if thumb_bytes:
            self._thumbnail_cache[asset_id] = thumb_bytes
            print(f"[WP资产库] 缩略图生成成功: {asset_id}, 大小={len(thumb_bytes)} bytes")
        else:
            print(f"[WP资产库] 缩略图生成失败: {asset_id}")
        
        return thumb_bytes
    
    def _reconstruct_asset_path(self, asset_info: Dict) -> str:
        """根据 asset_info 推算资产文件的实际路径（用于兼容旧数据）"""
        try:
            data = self._load_data()
            proj_id = asset_info.get("project_id")
            cat_id = asset_info.get("category_id")
            file_name = asset_info.get("file_name", "")
            
            if not proj_id or not cat_id or not file_name:
                return ""
            
            # 获取项目和分类信息
            if proj_id not in data["projects"]:
                return ""
            project = data["projects"][proj_id]
            categories = project.get("categories", {})
            if cat_id not in categories:
                return ""
            
            category = categories[cat_id]
            proj_name = self._sanitize_folder_name(project["name"])
            cat_name = self._sanitize_folder_name(category["name"])
            
            return os.path.join(self.base_path, proj_name, cat_name, file_name)
        except Exception as e:
            print(f"[WP资产库] 推算资产路径失败: {e}")
            return ""
    
    def _get_thumbnail_path(self, asset_id: str) -> str:
        """获取缩略图路径（根据资产的文件路径推断）"""
        data = self._load_data()
        if asset_id not in data["assets"]:
            return ""
        
        asset = data["assets"][asset_id]
        file_dir = os.path.dirname(asset.get("file_path", ""))
        if not file_dir:
            return ""
        
        thumbnail_path = os.path.join(file_dir, f"thumbnail_{asset_id}.jpg")
        return thumbnail_path if os.path.exists(thumbnail_path) else ""
    
    def update_asset(self, asset_id: str, name: str = None, description: str = None) -> bool:
        """更新资产信息"""
        data = self._load_data()
        
        if asset_id not in data["assets"]:
            return False
        
        if name is not None:
            data["assets"][asset_id]["name"] = name
        if description is not None:
            data["assets"][asset_id]["description"] = description
        
        data["assets"][asset_id]["modified_time"] = datetime.now().isoformat()
        self._save_data(data)
        return True
    
    def scan_local_images(self, proj_id: str, cat_id: str) -> int:
        """
        扫描本地资产库文件夹中的图片，添加到指定项目/分类中
        
        Args:
            proj_id: 项目ID
            cat_id: 分类ID
            
        Returns:
            新添加的资产数量
        """
        # 检查项目和分类是否存在
        data = self._load_data()
        if proj_id not in data["projects"]:
            return 0
        
        project = data["projects"][proj_id]
        if cat_id not in project.get("categories", {}):
            return 0
        
        # 获取已有文件的哈希集合（用于去重）
        existing_hashes = set()
        for asset_id, asset_info in data["assets"].items():
            if asset_info.get("project_id") == proj_id and asset_info.get("category_id") == cat_id:
                existing_hashes.add(asset_info.get("file_hash", ""))
        
        # 扫描本地目录中的图片
        supported_ext = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
        
        # 同时扫描自定义子目录
        new_count = 0
        for root, dirs, files in os.walk(self.base_path):
            # 跳过已管理的资产文件夹（项目名/分类名 结构）
            # 只扫描根目录和一级子目录
            rel = os.path.relpath(root, self.base_path)
            if rel != '.' and rel.count(os.sep) > 0:
                # 已经在项目/分类文件夹内了，跳过
                continue
            
            # 跳过系统文件夹
            dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
            
            for filename in files:
                file_ext = os.path.splitext(filename)[1].lower()
                if file_ext not in supported_ext:
                    continue
                
                file_path = os.path.join(root, filename)
                
                # 跳过已经注册过的文件
                abs_path = os.path.abspath(file_path)
                if any(abs_path in info.get("file_path", "") for info in data["assets"].values()):
                    continue
                
                # 计算哈希去重
                file_hash = self._calculate_file_hash(file_path)
                if file_hash in existing_hashes:
                    continue
                
                # 添加到资产库
                asset_id = self.add_asset(file_path, proj_id, cat_id)
                if asset_id:
                    existing_hashes.add(file_hash)
                    new_count += 1
        
        return new_count


# 全局资产库实例
asset_library = AssetLibraryManager()


def get_asset_library():
    """获取资产库实例"""
    return asset_library
