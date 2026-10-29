"""
🐳 WP 资产库管理模块
功能：管理图片资产，支持项目、分类、资产三级层级结构
"""
import os
import sys
import io
import json
import time
import shutil
import struct
import hashlib
import uuid
import threading
import mimetypes
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import folder_paths

# 插件目录与素材库位置指针文件（指针文件始终留在插件内，素材库本体可迁移到任意位置）
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
LIBRARY_POINTER_PATH = os.path.join(PLUGIN_DIR, "wp_library_location.json")
DEFAULT_LIBRARY_PATH = os.path.join(PLUGIN_DIR, "wp_asset_library")
# 迁移中断恢复标记：迁移开始时写入目标位置，正常完成后删除；重试时据此自动清理残留
MIGRATION_MARKER = ".wp_migration_in_progress"

# 尝试导入PIL用于缩略图生成
try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("[WP资产库] PIL未安装，缩略图功能将受限")


def _win_copy_to_clipboard(files: List[str], dib_bytes: bytes = None, text: str = None) -> Tuple[bool, str]:
    """
    通过 Windows API 把数据写入系统剪贴板（多格式并存，粘贴方自选所需格式）
    files: 文件绝对路径列表（CF_HDROP，粘贴到文件夹/文件发送框时出现真实文件）
    dib_bytes: 位图字节（CF_DIB，粘贴到聊天框/网页输入框时直接出图片）
    text: 文本内容（CF_UNICODETEXT，粘贴到输入框时出文字）
    """
    if sys.platform != "win32":
        return False, "剪贴板功能仅支持 Windows 系统"

    import ctypes

    CF_UNICODETEXT, CF_DIB, CF_HDROP = 13, 8, 15
    GMEM_MOVEABLE = 0x0002

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    # 64位系统上句柄/指针是64位，必须显式声明签名，否则ctypes按32位int截断导致句柄损坏
    user32.OpenClipboard.restype = ctypes.c_int
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.EmptyClipboard.restype = ctypes.c_int
    user32.EmptyClipboard.argtypes = []
    user32.CloseClipboard.restype = ctypes.c_int
    user32.CloseClipboard.argtypes = []
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_int
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.restype = ctypes.c_void_p
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]

    # 打开剪贴板（可能被其他程序短暂占用，重试约1秒）
    opened = False
    last_err = 0
    for _ in range(10):
        if user32.OpenClipboard(None):
            opened = True
            break
        last_err = ctypes.get_last_error()
        time.sleep(0.1)
    if not opened:
        return False, f"系统剪贴板被其他程序占用（code={last_err}），请稍后重试"

    def set_data(fmt: int, payload: bytes):
        """分配全局内存并写入剪贴板，失败抛异常（内存由系统接管，成功后不可释放）"""
        size = len(payload)
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            raise OSError("GlobalAlloc 失败")
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            kernel32.GlobalFree(handle)
            raise OSError("GlobalLock 失败")
        try:
            ctypes.memmove(ptr, payload, size)
        finally:
            kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(fmt, handle):
            kernel32.GlobalFree(handle)
            raise OSError(f"SetClipboardData(fmt={fmt}) 失败 code={ctypes.get_last_error()}")

    try:
        user32.EmptyClipboard()
        # 1) 文件列表（CF_HDROP）：DROPFILES 头20字节 + 双\0结尾的宽字符路径
        if files:
            payload = ("\0".join(files) + "\0").encode("utf-16-le")
            header = struct.pack("<IIiii", 20, 0, 0, 0, 1)  # pFiles=20, pt=(0,0), fNC=0, fWide=1
            set_data(CF_HDROP, header + payload)
        # 2) 位图（CF_DIB）：粘贴到微信/网页输入框时直接出图片
        if dib_bytes:
            set_data(CF_DIB, dib_bytes)
        # 3) 文本（CF_UNICODETEXT）
        if text is not None:
            set_data(CF_UNICODETEXT, text.encode("utf-16-le") + b"\x00\x00")
        return True, ""
    except Exception as e:
        return False, str(e)
    finally:
        user32.CloseClipboard()


# ffmpeg 能力探测缓存：exe 路径 -> 是否含 libx264 编码器
_ffmpeg_x264_cache: Dict[str, bool] = {}


def _ffmpeg_has_x264(exe: str) -> bool:
    """探测该 ffmpeg 是否带 libx264（conda 等无 GPL 构建不含，转码 H.264 必需）；结果缓存"""
    if exe in _ffmpeg_x264_cache:
        return _ffmpeg_x264_cache[exe]
    has = False
    try:
        import subprocess as _subprocess
        r = _subprocess.run([exe, "-hide_banner", "-encoders"],
                            capture_output=True, timeout=15)
        has = r.returncode == 0 and b"libx264" in r.stdout
    except Exception:
        has = False
    _ffmpeg_x264_cache[exe] = has
    return has


def _find_ffmpeg() -> Optional[str]:
    """多级查找 ffmpeg：收集系统 PATH / imageio_ffmpeg 包 / ComfyUI 目录捆绑全部候选，
    优先返回带 libx264 的完整版（视频转码必需），否则退回第一个可用"""
    import shutil as _shutil
    candidates = []
    exe = _shutil.which("ffmpeg")
    if exe:
        candidates.append(exe)
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            candidates.append(exe)
    except Exception:
        pass
    # 依次查找：ComfyUI 根目录 → custom_nodes 目录 → 插件目录
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    custom_nodes_dir = os.path.dirname(plugin_dir)
    comfyui_root = os.path.dirname(custom_nodes_dir)
    for base in (comfyui_root, custom_nodes_dir, plugin_dir):
        candidate = os.path.join(base, "ffmpeg.exe")
        if os.path.isfile(candidate):
            candidates.append(candidate)
    # 去重保序后优先选支持 libx264 的（PATH 里可能命中 conda 阉割版）
    seen = set()
    ordered = [c for c in candidates if not (c in seen or seen.add(c))]
    for exe in ordered:
        if _ffmpeg_has_x264(exe):
            return exe
    return ordered[0] if ordered else None


def _extract_video_frame_dib(video_path: str, time_sec) -> Tuple[bool, str]:
    """用 ffmpeg 抽取视频指定时间点的帧，返回 (成功, CF_DIB位图字节或错误信息)"""
    import subprocess as _subprocess

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return False, "未找到 ffmpeg，无法抽取视频帧"

    try:
        t = max(0.0, min(float(time_sec), 24 * 3600))
    except (TypeError, ValueError):
        t = 0.0

    try:
        result = _subprocess.run(
            [ffmpeg, "-ss", f"{t:.3f}", "-i", video_path, "-frames:v", "1",
             "-f", "image2", "-c:v", "bmp", "pipe:1"],
            capture_output=True, timeout=30
        )
    except Exception as e:
        return False, f"ffmpeg 执行失败: {e}"

    if result.returncode != 0 or len(result.stdout) < 15:
        err = result.stderr.decode("utf-8", errors="replace")[-200:] if result.stderr else "无输出"
        return False, f"抽取视频帧失败: {err}"

    # ffmpeg 输出的是完整 BMP 文件（14字节文件头），跳过文件头即 CF_DIB
    return True, result.stdout[14:]


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
            base_path: 资产库根目录路径，如果不提供则读取位置指针文件或使用默认路径
        """
        # 迁移状态（供前端轮询）
        self._migration_status: Dict = {"migrating": False, "stage": None}
        self._migration_lock = threading.Lock()

        if base_path is not None:
            self.base_path = base_path
        else:
            pointer = self._load_pointer()
            if pointer:
                pointer_path = pointer.get("base_path", "")
                if pointer_path and os.path.isdir(pointer_path):
                    self.base_path = pointer_path
                else:
                    print(f"[WP资产库] 已配置的素材库路径不可用: {pointer_path}，暂时回退到默认位置")
                    self.base_path = DEFAULT_LIBRARY_PATH
            else:
                # 未配置过位置：使用插件目录下的默认路径
                self.base_path = DEFAULT_LIBRARY_PATH

                # 迁移旧版数据（如果存在，仅默认模式下执行）
                old_path = os.path.join(folder_paths.get_input_directory(), "wp_assets")
                if not os.path.exists(os.path.join(self.base_path, "assets.json")) and os.path.exists(os.path.join(old_path, "assets.json")):
                    print("[WP资产库] 检测到旧版数据，正在迁移到新路径...")
                    try:
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
        # 视频转码状态：asset_id -> {"status": "running"/"done"/"failed", "error": str}
        self._transcode_status: Dict = {}
        self._transcode_lock = threading.Lock()
    
    def _init_config(self):
        """初始化配置文件"""
        if not os.path.exists(self.config_path):
            config = {
                "version": "2.0",
                "created_at": datetime.now().isoformat(),
                "default_project": "默认项目",
                "default_category": "默认分类",
                "supported_formats": {
                    "image": [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif"],
                    "audio": [".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"],
                    "video": [".mp4", ".webm", ".avi", ".mov", ".mkv", ".wmv", ".flv", ".m4v", ".ts", ".mts", ".m2ts", ".mpg", ".mpeg", ".3gp", ".vob", ".rm", ".rmvb"],
                    "text": [".txt", ".json", ".csv", ".xml", ".yaml", ".yml", ".md", ".py", ".js", ".html", ".css"]
                },
                "max_file_size": 50 * 1024 * 1024,  # 50MB
                "thumbnail_size": [256, 256]
            }
            with open(self.config_path, 'w', encoding='utf-8') as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
        else:
            with open(self.config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            # 兼容旧格式：将列表转为字典
            if isinstance(config.get("supported_formats"), list):
                old_formats = config["supported_formats"]
                config["supported_formats"] = {
                    "image": [f for f in old_formats if f in [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif"]],
                    "audio": [".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"],
                    "video": [".mp4", ".webm", ".avi", ".mov", ".mkv", ".wmv", ".flv", ".m4v", ".ts", ".mts", ".m2ts", ".mpg", ".mpeg", ".3gp", ".vob", ".rm", ".rmvb"],
                    "text": [".txt", ".json", ".csv", ".xml", ".yaml", ".yml", ".md", ".py", ".js", ".html", ".css"]
                }
                with open(self.config_path, 'w', encoding='utf-8') as f:
                    json.dump(config, f, ensure_ascii=False, indent=2)
                print("[WP资产库] 已迁移 supported_formats 到新格式")
    
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
    
    # ========== 存储位置管理 ==========

    def _load_pointer(self) -> Optional[Dict]:
        """读取素材库位置指针文件"""
        try:
            with open(LIBRARY_POINTER_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if data.get("base_path") and os.path.isabs(data["base_path"]):
                return data
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        return None

    def _save_pointer(self, base_path: str, migrated_from: str = None):
        """写入素材库位置指针文件"""
        data = {
            "version": 1,
            "base_path": base_path,
            "configured_at": datetime.now().isoformat(),
        }
        if migrated_from:
            data["migrated_from"] = migrated_from
        with open(LIBRARY_POINTER_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _apply_new_base_path(self, new_path: str):
        """切换实例到新的素材库路径（内存中）"""
        self.base_path = new_path
        self.config_path = os.path.join(new_path, "config.json")
        self.data_path = os.path.join(new_path, "assets.json")
        os.makedirs(new_path, exist_ok=True)
        self._init_config()
        self._init_data()
        self._thumbnail_cache.clear()

    def get_storage_info(self) -> Dict:
        """获取素材库存储信息（是否已配置、路径、占用、剩余空间等）"""
        pointer = self._load_pointer()
        configured = pointer is not None
        pointer_path = pointer.get("base_path") if pointer else None

        total_size = 0
        file_count = 0
        for root, dirs, files in os.walk(self.base_path):
            for fn in files:
                try:
                    total_size += os.path.getsize(os.path.join(root, fn))
                    file_count += 1
                except OSError:
                    pass

        try:
            data = self._load_data()
            asset_count = len(data.get("assets", {}))
        except Exception:
            asset_count = 0

        return {
            "configured": configured,
            "accessible": (not configured) or self.base_path == pointer_path,
            "path": self.base_path,
            "pointer_path": pointer_path,
            "is_default": os.path.normcase(self.base_path) == os.path.normcase(DEFAULT_LIBRARY_PATH),
            "default_path": DEFAULT_LIBRARY_PATH,
            "file_count": file_count,
            "asset_count": asset_count,
            "size_bytes": total_size,
            "free_bytes": self._get_free_bytes(self.base_path),
            "configured_at": pointer.get("configured_at") if pointer else None,
        }

    def _get_free_bytes(self, path: str) -> Optional[int]:
        """获取路径所在磁盘的剩余空间（路径不存在时向上查找最近存在的祖先）"""
        try:
            return shutil.disk_usage(path).free
        except Exception:
            p = path
            while p and not os.path.exists(p):
                parent = os.path.dirname(p)
                if parent == p:
                    break
                p = parent
            try:
                return shutil.disk_usage(p).free
            except Exception:
                return None

    def validate_path(self, path: str, create: bool = False) -> Dict:
        """
        验证素材库路径合法性（可读写、非系统保护目录、非插件/ComfyUI目录等）

        Args:
            path: 待验证路径
            create: 为 True 时自动创建不存在的文件夹（用于最终确认时）
        """
        result = {"valid": False, "error": "", "path": "", "exists": False, "writable": False,
                  "free_bytes": None, "is_empty": False}

        if not path or not str(path).strip():
            result["error"] = "路径不能为空"
            return result

        raw = str(path).strip().strip('"')
        if not os.path.isabs(raw):
            result["error"] = "请输入完整路径（例如 D:\\素材库）"
            return result

        path = os.path.normpath(os.path.abspath(raw))
        result["path"] = path

        drive, _ = os.path.splitdrive(path)
        if drive and not os.path.exists(drive + os.sep):
            result["error"] = f"磁盘 {drive} 不存在"
            return result

        if os.path.dirname(path) == path:
            result["error"] = "不能直接使用磁盘根目录，请选择或新建一个子文件夹"
            return result

        norm_path = os.path.normcase(path)

        # 系统保护目录
        protected = [
            os.environ.get("WINDIR", r"C:\Windows"),
            r"C:\Program Files",
            r"C:\Program Files (x86)",
            r"C:\ProgramData",
        ]
        for p in protected:
            np = os.path.normcase(p)
            if norm_path == np or norm_path.startswith(np + os.sep):
                result["error"] = "系统保护目录，不能作为素材库位置"
                return result

        # 插件目录本身
        norm_plugin = os.path.normcase(PLUGIN_DIR)
        if norm_path == norm_plugin or norm_path.startswith(norm_plugin + os.sep):
            result["error"] = "不能放在插件目录内（这正是要腾出的空间）"
            return result

        # 当前素材库位置
        norm_base = os.path.normcase(self.base_path)
        if norm_path == norm_base:
            result["error"] = "与当前素材库位置相同"
            return result
        if norm_path.startswith(norm_base + os.sep):
            result["error"] = "不能放在当前素材库内部"
            return result

        # ComfyUI 工作目录
        for getter in (folder_paths.get_input_directory, folder_paths.get_output_directory, folder_paths.get_temp_directory):
            try:
                d = os.path.normcase(getter())
                if norm_path == d or norm_path.startswith(d + os.sep):
                    result["error"] = "不能使用 ComfyUI 的输入/输出/临时目录"
                    return result
            except Exception:
                pass

        # 存在性检查
        if os.path.exists(path):
            if not os.path.isdir(path):
                result["error"] = "目标是一个文件，不是文件夹"
                return result
            result["exists"] = True
        elif create:
            try:
                os.makedirs(path, exist_ok=True)
                result["exists"] = True
            except Exception as e:
                result["error"] = f"无法创建该文件夹：{e}"
                return result

        # 可写性验证（仅在文件夹已存在时测试）
        if result["exists"]:
            try:
                test_file = os.path.join(path, f".wp_write_test_{os.getpid()}")
                with open(test_file, 'w') as f:
                    f.write("test")
                os.remove(test_file)
                result["writable"] = True
            except Exception as e:
                result["error"] = f"该路径不可写入：{e}"
                return result

            entries = [e for e in os.listdir(path) if e != MIGRATION_MARKER]
            result["is_empty"] = len(entries) == 0

        result["free_bytes"] = self._get_free_bytes(path)
        result["valid"] = True
        return result

    def browse_directory(self, path: str = None) -> Dict:
        """浏览服务器文件夹（只返回子文件夹列表，供选择存储位置）；path 为空时返回磁盘列表"""
        if not path:
            if hasattr(os, "listdrives"):
                drives = list(os.listdrives())
            else:
                import string
                drives = [f"{c}:{os.sep}" for c in string.ascii_uppercase if os.path.exists(f"{c}:{os.sep}")]
            return {"path": "", "parent": None, "dirs": [], "drives": drives}

        path = os.path.normpath(os.path.abspath(str(path).strip().strip('"')))
        if not os.path.isdir(path):
            return {"error": f"路径不存在或不是文件夹: {path}"}

        try:
            entries = os.listdir(path)
        except PermissionError:
            return {"error": f"无权访问该文件夹: {path}"}

        dirs = [e for e in entries if os.path.isdir(os.path.join(path, e))]
        dirs.sort()
        parent = os.path.dirname(path)
        if parent == path:
            parent = None
        return {"path": path, "parent": parent, "dirs": dirs, "drives": []}

    def create_folder(self, parent_path: str, name: str) -> Dict:
        """在指定位置新建子文件夹（供文件夹浏览器使用）"""
        if not name or not name.strip():
            return {"success": False, "error": "文件夹名称不能为空"}
        clean = name.strip()
        for ch in ['<', '>', ':', '"', '/', '\\', '|', '?', '*']:
            clean = clean.replace(ch, '_')
        if not clean:
            return {"success": False, "error": "文件夹名称无效"}

        parent_path = os.path.normpath(os.path.abspath(str(parent_path).strip().strip('"')))
        if not os.path.isdir(parent_path):
            return {"success": False, "error": "父文件夹不存在"}

        target = os.path.join(parent_path, clean)
        if os.path.exists(target):
            return {"success": False, "error": "同名文件夹已存在"}

        try:
            os.makedirs(target)
            return {"success": True, "path": target}
        except Exception as e:
            return {"success": False, "error": f"创建失败: {e}"}

    def _library_content_file_count(self) -> int:
        """统计素材库中的内容文件数（排除 assets.json / config.json / 迁移标记）"""
        count = 0
        for root, dirs, files in os.walk(self.base_path):
            for fn in files:
                if fn not in ("assets.json", "config.json", MIGRATION_MARKER):
                    count += 1
        return count

    def _clean_dir_contents(self, dir_path: str):
        """清空目录内容（保留目录本身），用于清理迁移残留"""
        try:
            for entry in os.listdir(dir_path):
                p = os.path.join(dir_path, entry)
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    try:
                        os.remove(p)
                    except OSError:
                        pass
        except Exception:
            pass

    def _rmtree_with_retry(self, path: str, max_retries: int = 5, delay: float = 1.0) -> bool:
        """删除目录，Windows 下文件可能被杀毒/索引服务短暂锁定，失败时重试"""
        for attempt in range(max_retries):
            try:
                shutil.rmtree(path)
                return True
            except OSError as e:
                if attempt == max_retries - 1:
                    print(f"[WP资产库] 警告：删除旧位置失败（可能被杀毒/索引等程序占用）：{e}")
                    print(f"[WP资产库] 迁移已完成，请稍后手动删除残留文件夹：{path}")
                    return False
                time.sleep(delay)
        return False

    def get_migration_status(self) -> Dict:
        """获取迁移任务状态（供前端轮询）"""
        return dict(self._migration_status)

    def start_set_location(self, new_path: str) -> Dict:
        """
        配置/迁移素材库位置的入口：
        - 库为空：直接切换（同步完成，很快）
        - 库有数据：启动后台线程执行完整迁移
        """
        if self._migration_status.get("migrating"):
            return {"success": False, "error": "已有迁移任务在进行中，请等待完成"}

        pre = self.validate_path(new_path, create=False)
        if not pre["valid"]:
            return {"success": False, "error": pre["error"]}

        if self._library_content_file_count() == 0:
            return self.set_library_location(new_path)

        def _bg_migrate(path: str):
            result = self.set_library_location(path)
            # 早退失败（如目标不为空/验证失败）不会经过状态更新分支，此处补写错误状态供前端轮询
            if not result.get("success") and self._migration_status.get("stage") not in ("error", "done"):
                self._migration_status = {
                    "migrating": False, "stage": "error", "percent": 0,
                    "error": result.get("error", "未知错误"),
                    "message": result.get("error", "迁移失败"),
                    "finished_at": datetime.now().isoformat(),
                }

        t = threading.Thread(target=_bg_migrate, args=(new_path,),
                             daemon=True, name="wp-asset-library-migration")
        t.start()
        return {"success": True, "mode": "migrating"}

    def set_library_location(self, new_path: str) -> Dict:
        """
        执行位置切换/迁移（同步阻塞，可能耗时较长，大库由 start_set_location 放入后台线程）：
        1. 验证并创建目标文件夹（必须为空，或为上次中断的残留）
        2. 复制全部文件
        3. 逐文件 MD5 校验完整性
        4. 改写 assets.json 绝对路径 -> 写指针文件 -> 切换实例
        5. 删除旧位置
        任何一步失败：原素材库保持不动，并清理目标位置的残留
        """
        with self._migration_lock:
            if self._migration_status.get("migrating"):
                return {"success": False, "error": "已有迁移任务在进行中"}

            v = self.validate_path(new_path, create=True)
            if not v["valid"]:
                return {"success": False, "error": v["error"]}
            new_path = v["path"]

            marker_path = os.path.join(new_path, MIGRATION_MARKER)
            # 目标必须为空；若存在迁移标记则视为上次中断的残留，自动清理后重试
            if os.path.exists(marker_path):
                print("[WP资产库] 检测到上次中断的迁移残留，自动清理后重试")
                self._clean_dir_contents(new_path)
            else:
                entries = os.listdir(new_path) if os.path.exists(new_path) else []
                if entries:
                    return {"success": False, "error": "目标文件夹不为空，请选择一个空文件夹（或新建一个）"}

            old_path = self.base_path

            # 收集库内全部文件
            files = []  # (绝对路径, 相对路径, 大小)
            for root, dirs, filenames in os.walk(old_path):
                for fn in filenames:
                    fp = os.path.join(root, fn)
                    try:
                        files.append((fp, os.path.relpath(fp, old_path), os.path.getsize(fp)))
                    except OSError:
                        pass

            total_bytes = sum(f[2] for f in files)

            status = {
                "migrating": True, "stage": "copy", "percent": 0,
                "current_file": "", "total_files": len(files), "copied_files": 0,
                "total_bytes": total_bytes, "copied_bytes": 0,
                "message": "正在复制文件…", "error": None,
                "from_path": old_path, "to_path": new_path,
                "started_at": datetime.now().isoformat(), "finished_at": None,
            }
            self._migration_status = status

            # ---- 空库：直接切换（无需复制校验）----
            data_files = {"assets.json", "config.json"}
            if all(f[1] in data_files for f in files):
                try:
                    for fp, rel, _ in files:
                        dst = os.path.join(new_path, rel)
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                        shutil.copy2(fp, dst)
                    self._save_pointer(new_path, migrated_from=old_path)
                    self._apply_new_base_path(new_path)
                    self._rmtree_with_retry(old_path)
                    status.update(migrating=False, stage="done", percent=100,
                                  message="配置完成", finished_at=datetime.now().isoformat())
                    print(f"[WP资产库] 素材库位置已配置: {old_path} -> {new_path}")
                    return {"success": True, "mode": "switched", "from": old_path, "to": new_path}
                except Exception as e:
                    status.update(migrating=False, stage="error", error=str(e),
                                  message="配置失败，原素材库未受影响",
                                  finished_at=datetime.now().isoformat())
                    return {"success": False, "mode": "error", "error": str(e)}

            # ---- 有数据：完整迁移 ----
            # 剩余空间检查
            free = self._get_free_bytes(new_path)
            if free is not None and free < total_bytes + 50 * 1024 * 1024:
                msg = (f"目标磁盘剩余空间不足（需要约 {total_bytes / 1024 / 1024:.0f}MB，"
                       f"剩余 {free / 1024 / 1024:.0f}MB）")
                status.update(migrating=False, stage="error", error=msg,
                              message=msg, finished_at=datetime.now().isoformat())
                return {"success": False, "mode": "error", "error": msg}

            # 写入迁移中断恢复标记
            with open(marker_path, 'w', encoding='utf-8') as f:
                f.write(json.dumps({"from": old_path, "started_at": status["started_at"]}, ensure_ascii=False))

            try:
                # 阶段1：复制（进度 0-60%）
                copied_bytes = 0
                for i, (fp, rel, size) in enumerate(files):
                    dst = os.path.join(new_path, rel)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(fp, dst)
                    copied_bytes += size
                    status.update(stage="copy", current_file=rel, copied_files=i + 1,
                                  copied_bytes=copied_bytes,
                                  percent=int(60 * copied_bytes / max(total_bytes, 1)),
                                  message="正在复制文件…")

                # 阶段2：完整性校验（进度 60-95%）
                status.update(stage="verify", message="正在校验文件完整性…", percent=60)
                for i, (fp, rel, size) in enumerate(files):
                    src_hash = self._calculate_file_hash(os.path.join(old_path, rel))
                    dst_hash = self._calculate_file_hash(os.path.join(new_path, rel))
                    if src_hash != dst_hash:
                        raise RuntimeError(f"文件校验失败: {rel}")
                    status.update(current_file=rel,
                                  percent=60 + int(35 * (i + 1) / len(files)))

                # 阶段3：收尾（改写路径 + 写指针 + 切换）
                status.update(stage="finalize", message="正在更新配置…", percent=96, current_file="")
                new_data_path = os.path.join(new_path, "assets.json")
                if os.path.exists(new_data_path):
                    with open(new_data_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    norm_old = os.path.normcase(old_path)
                    for asset in data.get("assets", {}).values():
                        fp = asset.get("file_path", "")
                        if fp:
                            norm_fp = os.path.normcase(fp)
                            if norm_fp == norm_old or norm_fp.startswith(norm_old + os.sep):
                                asset["file_path"] = os.path.join(new_path, os.path.relpath(fp, old_path))
                    with open(new_data_path, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)

                self._save_pointer(new_path, migrated_from=old_path)
                self._apply_new_base_path(new_path)

                # 阶段4：清理旧位置（进度 98-100%）
                status.update(stage="cleanup", message="正在清理旧位置…", percent=98)
                self._rmtree_with_retry(old_path)
                try:
                    os.remove(marker_path)
                except OSError:
                    pass

                status.update(migrating=False, stage="done", percent=100, message="迁移完成",
                              finished_at=datetime.now().isoformat())
                print(f"[WP资产库] 素材库迁移完成: {old_path} -> {new_path}（{len(files)} 个文件，"
                      f"{total_bytes / 1024 / 1024:.1f}MB）")
                return {"success": True, "mode": "migrated", "from": old_path, "to": new_path,
                        "files": len(files), "bytes": total_bytes}

            except Exception as e:
                # 失败：原素材库保持不动，清理目标位置残留
                status.update(migrating=False, stage="error", error=str(e),
                              message="迁移失败，原素材库未受影响",
                              finished_at=datetime.now().isoformat())
                self._clean_dir_contents(new_path)
                print(f"[WP资产库] 迁移失败，已保留原素材库: {e}")
                return {"success": False, "mode": "error", "error": str(e)}

    def _reconstruct_path_under(self, base_path: str, projects: Dict, asset: Dict) -> str:
        """在指定根目录下按 项目/分类/文件名 推算资产文件路径（用于重新绑定）"""
        try:
            proj_id = asset.get("project_id")
            cat_id = asset.get("category_id")
            file_name = asset.get("file_name", "")
            if not proj_id or not cat_id or not file_name:
                return ""
            project = projects.get(proj_id)
            if not project:
                return ""
            category = project.get("categories", {}).get(cat_id)
            if not category:
                return ""
            proj_name = self._sanitize_folder_name(project["name"])
            cat_name = self._sanitize_folder_name(category["name"])
            return os.path.join(base_path, proj_name, cat_name, file_name)
        except Exception:
            return ""

    def rebind_library_location(self, new_path: str, dry_run: bool = False) -> Dict:
        """
        重新绑定素材库路径（文件已就位、仅账本路径失效的场景，例如素材库从其他电脑拷贝/手动移动后）：
        1. 验证目标文件夹是完整的素材库（含 assets.json）
        2. 对 file_path 失效的资产，按 新路径/项目名/分类名/文件名 推算并验证存在后改写
        3. 写指针文件并切换实例
        dry_run 为 True 时只统计不写入。不会移动、复制或删除任何文件。
        """
        if self._migration_status.get("migrating"):
            return {"success": False, "error": "素材库正在迁移中，请等待迁移完成后再执行此操作"}

        if not new_path or not str(new_path).strip():
            return {"success": False, "error": "路径不能为空"}

        path = os.path.normpath(os.path.abspath(str(new_path).strip().strip('"')))
        if not os.path.isdir(path):
            return {"success": False, "error": f"文件夹不存在: {path}"}

        data_path = os.path.join(path, "assets.json")
        if not os.path.isfile(data_path):
            return {"success": False, "error": "该文件夹不是有效的素材库（缺少 assets.json），请选择素材库根目录"}

        try:
            with open(data_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            return {"success": False, "error": f"assets.json 读取失败: {e}"}

        assets = data.get("assets", {})
        projects = data.get("projects", {})
        total = valid = rebound = missing = 0
        missing_files = []

        for asset_id, asset in assets.items():
            total += 1
            fp = asset.get("file_path", "")
            if fp and os.path.exists(fp):
                valid += 1
                continue
            # 记录路径失效（如指向其他电脑），在新位置推算
            new_fp = self._reconstruct_path_under(path, projects, asset)
            if new_fp and os.path.exists(new_fp):
                rebound += 1
                if not dry_run:
                    asset["file_path"] = new_fp
            else:
                missing += 1
                if len(missing_files) < 10:
                    missing_files.append(asset.get("file_name") or asset_id)

        if dry_run:
            return {
                "success": True, "dry_run": True, "path": path,
                "total": total, "valid": valid, "rebound": rebound,
                "missing": missing, "missing_files": missing_files,
                "is_current": os.path.normcase(path) == os.path.normcase(self.base_path),
            }

        try:
            with open(data_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            return {"success": False, "error": f"assets.json 写入失败: {e}"}

        self._save_pointer(path)
        self._apply_new_base_path(path)
        print(f"[WP资产库] 素材库已重新绑定: {path}（{rebound} 个路径已改写，{missing} 个文件缺失）")

        return {
            "success": True, "path": path,
            "total": total, "valid": valid, "rebound": rebound,
            "missing": missing, "missing_files": missing_files,
        }

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

        # 同步创建磁盘文件夹，保持账本与文件系统一致（避免文件系统校准误判为已删除）
        try:
            os.makedirs(os.path.join(self.base_path, self._sanitize_folder_name(name)), exist_ok=True)
        except Exception as e:
            print(f"[WP资产库] 创建项目文件夹失败: {e}")

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
        
        # 同步创建默认项目/分类的磁盘文件夹，保持账本与文件系统一致
        try:
            os.makedirs(os.path.join(self.base_path, "默认项目", "默认分类"), exist_ok=True)
        except Exception as e:
            print(f"[WP资产库] 创建默认项目文件夹失败: {e}")

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
                # 带重试改名（Windows 下文件夹常被资源管理器/杀毒临时占用）
                moved = False
                last_err = None
                for _ in range(3):
                    try:
                        shutil.move(old_proj_dir, new_proj_dir)
                        moved = True
                        break
                    except Exception as e:
                        last_err = e
                        time.sleep(1)

                if not moved:
                    # 文件夹没改成功就中止：否则账本路径全部指向不存在的位置，素材与磁盘分裂
                    print(f"[WP资产库] 重命名项目文件夹失败: {last_err}")
                    return False
            
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

        # 同步创建磁盘文件夹，保持账本与文件系统一致（避免文件系统校准误判为已删除）
        proj_name = self._sanitize_folder_name(data["projects"][proj_id]["name"])
        try:
            os.makedirs(os.path.join(self.base_path, proj_name, self._sanitize_folder_name(name)), exist_ok=True)
        except Exception as e:
            print(f"[WP资产库] 创建分类文件夹失败: {e}")

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
                # 带重试改名（Windows 下文件夹常被资源管理器/杀毒临时占用）
                moved = False
                last_err = None
                for _ in range(3):
                    try:
                        shutil.move(old_cat_dir, new_cat_dir)
                        moved = True
                        break
                    except Exception as e:
                        last_err = e
                        time.sleep(1)

                if not moved:
                    # 文件夹没改成功就中止：否则账本路径全部指向不存在的位置，素材与磁盘分裂
                    print(f"[WP资产库] 重命名分类文件夹失败: {last_err}")
                    return False
            
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
    
    def reorder_categories(self, proj_id: str, ordered_ids: List[str]) -> bool:
        """按前端拖拽后的顺序重排分类（仅调整顺序，不改动分类内容）"""
        data = self._load_data()
        
        if proj_id not in data["projects"]:
            return False
        
        categories = data["projects"][proj_id].get("categories", {})
        if not categories or not ordered_ids:
            return False
        
        # 按传入顺序重建字典（JSON 键顺序即显示顺序）；未在列表中的分类兜底追加到末尾，避免丢数据
        new_categories = {}
        for cat_id in ordered_ids:
            if cat_id in categories and cat_id not in new_categories:
                new_categories[cat_id] = categories[cat_id]
        for cat_id, cat_info in categories.items():
            if cat_id not in new_categories:
                new_categories[cat_id] = cat_info
        
        data["projects"][proj_id]["categories"] = new_categories
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
        all_formats = self._get_all_supported_formats()
        media_type = self._get_media_type(file_ext)
        
        if file_ext not in all_formats:
            print(f"[WP资产库] 不支持的文件格式: {file_ext}")
            return None
        
        # 图片完整性校验：损坏的图片当场拒绝，避免入库后执行工作流才报错
        if media_type == "image" and not self._validate_image_file(file_path):
            return None
        
        # 如果没有提供名称，使用文件名（去掉扩展名）
        if name is None or not name.strip():
            name = os.path.splitext(os.path.basename(file_path))[0]
        
        # 名称清洗 + 限长（与重命名接口规则一致），同时作为磁盘文件名与显示名，
        # 保证"库内显示名 = 本地文件名"，避免入库时两边不一致
        name_base = self._sanitize_folder_name(name.strip())[:50]
        
        # 创建目标目录：项目名/分类名/
        proj_name = self._sanitize_folder_name(project["name"])
        category = project["categories"][cat_id]
        cat_name = self._sanitize_folder_name(category["name"])
        
        asset_folder = os.path.join(self.base_path, proj_name, cat_name)
        os.makedirs(asset_folder, exist_ok=True)
        
        # 用名称（+原扩展名）作为目标文件名；同名冲突自动加序号
        dest_filename = f"{name_base}{file_ext}"
        dest_file_path = os.path.join(asset_folder, dest_filename)
        counter = 1
        
        while os.path.exists(dest_file_path):
            dest_filename = f"{name_base}({counter}){file_ext}"
            dest_file_path = os.path.join(asset_folder, dest_filename)
            counter += 1
        
        # 显示名与最终文件名保持一致（含冲突序号）
        display_name = os.path.splitext(dest_filename)[0]
        
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
            "file_type": media_type,
            "file_hash": file_hash,
            "upload_time": datetime.now().isoformat(),
            "modified_time": file_mtime
        }
        
        # 将资产ID添加到分类中
        data["projects"][proj_id]["categories"][cat_id]["assets"].append(asset_id)
        
        self._save_data(data)
        
        # 预生成缩略图到内存缓存（仅图片类型）
        if media_type == "image":
            thumb_bytes = self._generate_thumbnail_bytes(dest_file_path)
            if thumb_bytes:
                self._thumbnail_cache[asset_id] = thumb_bytes
        
        return asset_id
    
    def _sanitize_folder_name(self, name: str) -> str:
        """将名称转换为安全的文件夹名"""
        for ch in ['<', '>', ':', '"', '/', '\\', '|', '?', '*']:
            name = name.replace(ch, '_')
        name = name.strip()
        if not name:
            name = "未命名"
        return name
    
    def _validate_image_file(self, file_path: str) -> bool:
        """校验图片文件完整性，损坏的图片返回 False"""
        if not PIL_AVAILABLE:
            return True
        try:
            with Image.open(file_path) as img:
                img.verify()
            return True
        except Exception as e:
            print(f"[WP资产库] 图片文件已损坏，拒绝导入: {file_path} ({e})")
            return False
    
    def _get_media_type(self, ext: str) -> str:
        """根据扩展名判断媒体类型"""
        ext = ext.lower()
        with open(self.config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        formats = config.get("supported_formats", {})
        for media_type, exts in formats.items():
            if ext in exts:
                return media_type
        return "unknown"
    
    def _get_all_supported_formats(self) -> set:
        """获取所有支持的文件扩展名（扁平化）"""
        with open(self.config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        formats = config.get("supported_formats", {})
        all_exts = set()
        for exts in formats.values():
            all_exts.update(exts)
        return all_exts
    
    def _get_image_formats(self) -> set:
        """获取支持的图片扩展名"""
        with open(self.config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        formats = config.get("supported_formats", {})
        return set(formats.get("image", []))
    
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
        seen_paths = set()
        
        for asset_id in category.get("assets", []):
            if asset_id in data["assets"]:
                asset = data["assets"][asset_id]
                
                # 检查搜索查询
                if search_query:
                    search_lower = search_query.lower()
                    if (search_lower not in asset["name"].lower() and 
                        search_lower not in asset.get("description", "").lower()):
                        continue
                
                # 磁盘上不存在的文件不显示（先尝试按项目/分类重建路径，兼容账本路径失效的旧数据）
                file_path = asset.get("file_path", "")
                if not file_path or not os.path.exists(file_path):
                    reconstructed = self._reconstruct_asset_path(asset)
                    if not (reconstructed and os.path.exists(reconstructed)):
                        continue
                
                # 同一文件多条账本记录只显示一条（Windows 路径大小写不敏感，用 normcase 归一）
                path_key = os.path.normcase(os.path.abspath(file_path))
                if path_key in seen_paths:
                    continue
                seen_paths.add(path_key)
                
                assets.append({
                    "id": asset["id"],
                    "name": asset["name"],
                    "description": asset.get("description", ""),
                    "file_name": asset["file_name"],
                    "file_size": asset["file_size"],
                    "file_type": asset.get("file_type", "image"),
                    "file_ext": asset.get("file_ext", ""),
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
                "file_type": asset.get("file_type", "image"),
                "upload_time": asset["upload_time"],
                "modified_time": asset["modified_time"],
                "category_id": asset.get("category_id"),
                "project_id": asset.get("project_id")
            }
        return None
    
    def get_cached_thumbnail(self, asset_id: str) -> Optional[bytes]:
        """获取缩略图 bytes（从内存缓存，不存在则从原图临时生成）。非图片类型返回 None。"""
        # 先从缓存找
        if asset_id in self._thumbnail_cache:
            return self._thumbnail_cache[asset_id]
        
        # 缓存没有，检查资产类型
        asset_info = self.get_asset_info(asset_id)
        if not asset_info:
            return None
        
        # 非图片类型不生成缩略图
        if asset_info.get("file_type", "image") != "image":
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
    
    def _resolve_owner_by_path(self, file_path: str, data: Dict) -> Tuple[Optional[str], Optional[str]]:
        """根据素材文件绝对路径反查所属项目/分类（取相对库目录的第一/二级文件夹名做大小写不敏感匹配）"""
        try:
            rel = os.path.relpath(os.path.abspath(file_path), self.base_path)
        except ValueError:
            return None, None
        parts = rel.split(os.sep)
        if len(parts) < 3 or parts[0] == "..":
            return None, None
        proj_key = self._sanitize_folder_name(parts[0]).lower()
        cat_key = self._sanitize_folder_name(parts[1]).lower()
        for pid, pinfo in data["projects"].items():
            if self._sanitize_folder_name(pinfo["name"]).lower() != proj_key:
                continue
            for cid, cinfo in pinfo.get("categories", {}).items():
                if self._sanitize_folder_name(cinfo["name"]).lower() == cat_key:
                    return pid, cid
            break
        return None, None

    def _remount_asset(self, data: Dict, asset_id: str, asset: Dict, new_proj_id: str, new_cat_id: str):
        """把素材从当前挂载的分类移到新分类（同步分类 assets 列表与素材的归属字段）"""
        old_proj = data["projects"].get(asset.get("project_id"))
        if old_proj:
            old_cat = old_proj.get("categories", {}).get(asset.get("category_id"))
            if old_cat and asset_id in old_cat.get("assets", []):
                old_cat["assets"].remove(asset_id)
        new_cat = data["projects"][new_proj_id]["categories"][new_cat_id]
        if asset_id not in new_cat["assets"]:
            new_cat["assets"].append(asset_id)
        asset["project_id"] = new_proj_id
        asset["category_id"] = new_cat_id

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
        """更新资产信息（重命名时同步修改磁盘文件名，磁盘失败则账本不动，保证两者一致）"""
        data = self._load_data()
        
        if asset_id not in data["assets"]:
            return False
        
        asset = data["assets"][asset_id]
        
        if name is not None and name.strip():
            # 后端兜底清洗非法字符并限长（前端有同样规则，此处防止直接调 API 绕过）
            clean_name = self._sanitize_folder_name(name.strip())[:50]
            if not clean_name:
                return False
            old_name = asset.get("name", "")
            # 用磁盘文件名（而非账本显示名）判断是否需要改文件：
            # 显示名与文件名分裂的素材，再输入一次相同名字即可修正
            old_file_name = asset.get("file_name", "")
            disk_stem = os.path.splitext(old_file_name)[0] if old_file_name else ""

            if old_name != clean_name or disk_stem != clean_name:
                old_file_path = asset.get("file_path", "")
                file_ext = asset.get("file_ext", "")
                if not file_ext and old_file_name:
                    file_ext = os.path.splitext(old_file_name)[1]
                final_name = clean_name

                # 路径失效时先尝试重建（如库换过位置）
                if old_file_path and not os.path.exists(old_file_path):
                    reconstructed = self._reconstruct_asset_path(asset)
                    if reconstructed and os.path.exists(reconstructed):
                        old_file_path = reconstructed
                        asset["file_path"] = reconstructed

                if not (old_file_path and os.path.exists(old_file_path)):
                    # 找不到文件时明确失败，不再只改账本显示名（避免显示名与文件名分裂）
                    print(f"[WP资产库] 重命名失败：找不到素材文件 {old_file_path or old_file_name}")
                    return False

                old_dir = os.path.dirname(old_file_path)
                new_file_name = final_name + file_ext
                new_file_path = os.path.join(old_dir, new_file_name)

                # 目标与当前为同一文件则无需改名（仅账本显示名需要修正）
                if os.path.abspath(new_file_path) != os.path.abspath(old_file_path):
                    # 目标文件已存在且不是同一个文件时加序号
                    counter = 1
                    while os.path.exists(new_file_path) and os.path.abspath(new_file_path) != os.path.abspath(old_file_path):
                        new_file_name = f"{final_name}({counter}){file_ext}"
                        new_file_path = os.path.join(old_dir, new_file_name)
                        counter += 1

                    # 带重试改名（Windows 杀毒/索引器可能临时锁定文件）
                    renamed = False
                    last_err = None
                    for _ in range(3):
                        try:
                            os.rename(old_file_path, new_file_path)
                            renamed = True
                            break
                        except Exception as e:
                            last_err = e
                            time.sleep(1)

                    if not renamed:
                        print(f"[WP资产库] 文件重命名失败: {last_err}")
                        return False

                    asset["file_path"] = new_file_path
                    asset["file_name"] = new_file_name
                    # 显示名与最终文件名保持一致（含冲突序号）
                    final_name = os.path.splitext(new_file_name)[0]
                    print(f"[WP资产库] 文件重命名: {os.path.basename(old_file_path)} -> {new_file_name}")

                asset["name"] = final_name
        
        if description is not None:
            asset["description"] = description

        asset["modified_time"] = datetime.now().isoformat()
        self._save_data(data)
        return True

    def move_asset(self, asset_id: str, target_project_id: str, target_category_id: str) -> Tuple[bool, str]:
        """
        移动资产到目标项目/分类（跨项目移动）
        磁盘文件 + 磁盘缩略图 + 账本三者同步更新；文件被占用时带重试
        Returns: (成功与否, 失败原因)
        """
        data = self._load_data()

        if asset_id not in data["assets"]:
            return False, "资产不存在"
        asset = data["assets"][asset_id]

        if target_project_id not in data["projects"]:
            return False, "目标项目不存在"
        project = data["projects"][target_project_id]
        categories = project.get("categories", {})
        if target_category_id not in categories:
            return False, "目标分类不存在"
        category = categories[target_category_id]

        # 源路径失效时先尝试重建（如库换过位置）
        src_path = asset.get("file_path", "")
        if src_path and not os.path.exists(src_path):
            reconstructed = self._reconstruct_asset_path(asset)
            if reconstructed and os.path.exists(reconstructed):
                src_path = reconstructed
        if not src_path or not os.path.exists(src_path):
            return False, "源文件不存在（可能已被移动或删除）"

        # 目标目录（项目名/分类名）
        proj_name = self._sanitize_folder_name(project["name"])
        cat_name = self._sanitize_folder_name(category["name"])
        target_dir = os.path.join(self.base_path, proj_name, cat_name)
        os.makedirs(target_dir, exist_ok=True)

        # 已在目标位置则直接成功
        if os.path.abspath(os.path.dirname(src_path)) == os.path.abspath(target_dir):
            return True, ""

        # 目标同名冲突时加序号；文件名取磁盘实际名，保证移动不改名
        file_name = os.path.basename(src_path)
        base, ext = os.path.splitext(file_name)
        new_path = os.path.join(target_dir, file_name)
        counter = 1
        while os.path.exists(new_path):
            new_path = os.path.join(target_dir, f"{base}({counter}){ext}")
            counter += 1

        # 带重试移动（Windows 杀毒/索引器可能临时锁定文件）
        moved = False
        last_err = None
        for _ in range(3):
            try:
                shutil.move(src_path, new_path)
                moved = True
                break
            except Exception as e:
                last_err = e
                time.sleep(1)
        if not moved:
            return False, f"文件移动失败: {last_err}"

        # 磁盘缩略图一并移动（仅扫描入库的素材有磁盘缩略图，失败不阻塞）
        old_thumb = os.path.join(os.path.dirname(src_path), f"thumbnail_{asset_id}.jpg")
        if os.path.exists(old_thumb):
            try:
                shutil.move(old_thumb, os.path.join(target_dir, f"thumbnail_{asset_id}.jpg"))
            except Exception as e:
                print(f"[WP资产库] 移动缩略图失败（忽略）: {e}")

        # 更新账本：旧分类列表移除、新分类列表追加、资产字段改指向
        old_proj = asset.get("project_id")
        old_cat = asset.get("category_id")
        if old_proj and old_cat and old_proj in data["projects"]:
            old_categories = data["projects"][old_proj].get("categories", {})
            if old_cat in old_categories and asset_id in old_categories[old_cat].get("assets", []):
                old_categories[old_cat]["assets"].remove(asset_id)

        category["assets"].append(asset_id)
        asset["project_id"] = target_project_id
        asset["category_id"] = target_category_id
        asset["file_path"] = new_path
        asset["file_name"] = os.path.basename(new_path)  # 仅同名冲突加序号时与原值不同，须与磁盘实际一致
        asset["modified_time"] = datetime.now().isoformat()
        # 注意：不改动 asset["name"]——显示名是用户命名，移动操作不得改名
        # （历史数据中 name 与 file_name 可能不一致，如保存节点图入库后重命名）

        self._save_data(data)
        print(f"[WP资产库] 移动资产: {os.path.basename(src_path)} -> {new_path}")
        return True, ""

    def remove_assets_batch(self, asset_ids: List[str]) -> Dict:
        """批量删除资产，返回成功/失败统计与失败明细"""
        success_count = 0
        failed = []
        for asset_id in asset_ids:
            try:
                if self.remove_asset(asset_id):
                    success_count += 1
                else:
                    failed.append({"asset_id": asset_id, "reason": "资产不存在或已删除"})
            except Exception as e:
                failed.append({"asset_id": asset_id, "reason": str(e)})
        return {
            "success": len(failed) == 0,
            "deleted": success_count,
            "failed": failed
        }

    def copy_asset_to_clipboard(self, asset_id: str) -> Tuple[bool, str]:
        """把素材本体复制到 Windows 系统剪贴板（文件 + 图片/文本双格式）"""
        if sys.platform != "win32":
            return False, "剪贴板功能仅支持 Windows 系统"

        asset_info = self.get_asset_info(asset_id)
        if not asset_info:
            return False, "素材不存在"

        file_path = asset_info.get("file_path", "")
        if not file_path or not os.path.exists(file_path):
            reconstructed = self._reconstruct_asset_path(asset_info)
            if reconstructed and os.path.exists(reconstructed):
                file_path = reconstructed
            else:
                return False, "素材文件不存在"

        dib_bytes = None
        text = None
        file_type = asset_info.get("file_type", "image")

        if file_type == "image" and PIL_AVAILABLE:
            # 位图格式：粘贴到聊天框/网页输入框时直接出图片（GIF 取首帧）
            try:
                with Image.open(file_path) as img:
                    if img.mode != "RGB":
                        img = img.convert("RGB")
                    buf = io.BytesIO()
                    img.save(buf, format="BMP")
                    dib_bytes = buf.getvalue()[14:]  # 跳过 BITMAPFILEHEADER，CF_DIB 从 BITMAPINFOHEADER 开始
            except Exception as e:
                print(f"[WP资产库] 转换位图失败（不影响文件粘贴）: {e}")
        elif file_type == "text":
            try:
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except Exception as e:
                print(f"[WP资产库] 读取文本失败（不影响文件粘贴）: {e}")

        return _win_copy_to_clipboard([file_path], dib_bytes=dib_bytes, text=text)

    def copy_asset_video_frame(self, asset_id: str, time_sec) -> Tuple[bool, str]:
        """抽取视频素材指定时间点的帧，以位图格式写入系统剪贴板"""
        if sys.platform != "win32":
            return False, "剪贴板功能仅支持 Windows 系统"

        asset_info = self.get_asset_info(asset_id)
        if not asset_info:
            return False, "素材不存在"

        if asset_info.get("file_type") != "video":
            return False, "仅视频素材支持复制视频帧"

        file_path = asset_info.get("file_path", "")
        if not file_path or not os.path.exists(file_path):
            reconstructed = self._reconstruct_asset_path(asset_info)
            if reconstructed and os.path.exists(reconstructed):
                file_path = reconstructed
            else:
                return False, "视频文件不存在"

        ok, payload = _extract_video_frame_dib(file_path, time_sec)
        if not ok:
            return False, payload
        return _win_copy_to_clipboard([], dib_bytes=payload)

    def sync_with_filesystem(self) -> Dict:
        """
        全库校准：检测用户在文件系统中对素材的改名/删除操作，并同步账本
        
        逻辑：
        1. 账本中路径失效的资产先尝试路径重建，仍失效的进入丢失名单
        2. 扫描库目录中账本未登记的文件（孤儿名单）
        3. 丢失与孤儿按"文件大小预筛 + 哈希确认"配对，配对成功 = 磁盘改名，更新账本
        4. 配不上的丢失记录 = 文件被删除，自动从库中移除
        5. 配不上的孤儿 = 全新文件，不自动入库（由用户手动扫描入库）
        """
        if not os.path.isdir(self.base_path):
            return {"success": False, "error": f"素材库目录不存在: {self.base_path}"}
        
        data = self._load_data()
        all_formats = self._get_all_supported_formats()
        
        # 1. 检查账本资产，收集路径失效的记录
        missing = []
        for asset_id, asset in data["assets"].items():
            fp = asset.get("file_path", "")
            if fp and os.path.exists(fp):
                continue
            reconstructed = self._reconstruct_asset_path(asset)
            if reconstructed and os.path.exists(reconstructed):
                asset["file_path"] = reconstructed
                continue
            missing.append((asset_id, asset))
        
        # 2. 扫描磁盘，收集账本未登记的文件（排除系统文件与缩略图）
        known_paths = set()
        for asset in data["assets"].values():
            fp = asset.get("file_path", "")
            if fp:
                known_paths.add(os.path.abspath(fp))
        
        orphan_files = []
        for root, dirs, files in os.walk(self.base_path):
            for filename in files:
                if filename in ("assets.json", "config.json", MIGRATION_MARKER):
                    continue
                if filename.startswith(("thumbnail_", "transcode_")):
                    continue
                file_ext = os.path.splitext(filename)[1].lower()
                if file_ext not in all_formats:
                    continue
                file_path = os.path.abspath(os.path.join(root, filename))
                if file_path not in known_paths:
                    orphan_files.append(file_path)
        
        # 3. 丢失资产与孤儿文件配对（先按大小预筛，再按哈希确认）
        renamed = 0
        used_orphans = set()
        remaining_missing = []
        for asset_id, asset in missing:
            expected_size = asset.get("file_size")
            expected_hash = asset.get("file_hash", "")
            matched = None
            for of in orphan_files:
                if of in used_orphans:
                    continue
                try:
                    if expected_size is not None and os.stat(of).st_size != expected_size:
                        continue
                    if expected_hash and self._calculate_file_hash(of) == expected_hash:
                        matched = of
                        break
                except OSError:
                    continue
            if matched:
                new_file_name = os.path.basename(matched)
                stat = os.stat(matched)
                asset["file_path"] = matched
                asset["file_name"] = new_file_name
                asset["name"] = os.path.splitext(new_file_name)[0]
                asset["file_size"] = stat.st_size
                asset["modified_time"] = datetime.fromtimestamp(stat.st_mtime).isoformat()
                # 素材被移动到其他文件夹时同步归属（新文件夹尚未注册的场景由 full_scan 兜底）
                new_proj_id, new_cat_id = self._resolve_owner_by_path(matched, data)
                if new_proj_id and new_cat_id and (new_proj_id != asset.get("project_id") or new_cat_id != asset.get("category_id")):
                    self._remount_asset(data, asset_id, asset, new_proj_id, new_cat_id)
                used_orphans.add(matched)
                renamed += 1
            else:
                remaining_missing.append((asset_id, asset))
        
        # 4. 配不上的丢失记录 = 文件被删除；无哈希的历史数据保守保留
        removed = 0
        skipped = 0
        for asset_id, asset in remaining_missing:
            if not asset.get("file_hash"):
                skipped += 1
                continue
            proj_id = asset.get("project_id")
            cat_id = asset.get("category_id")
            if proj_id and proj_id in data["projects"]:
                categories = data["projects"][proj_id].get("categories", {})
                if cat_id in categories and asset_id in categories[cat_id].get("assets", []):
                    categories[cat_id]["assets"].remove(asset_id)
            del data["assets"][asset_id]
            self._thumbnail_cache.pop(asset_id, None)
            removed += 1
        
        # 4.5 同一路径多条账本记录去重（历史重复注册的遗留数据）：按注册顺序保留最早一条
        deduped = 0
        seen_paths = set()
        for asset_id in list(data["assets"].keys()):
            asset = data["assets"][asset_id]
            fp = asset.get("file_path", "")
            if not fp or not os.path.exists(fp):
                continue
            path_key = os.path.normcase(os.path.abspath(fp))
            if path_key in seen_paths:
                proj_id = asset.get("project_id")
                cat_id = asset.get("category_id")
                if proj_id in data["projects"]:
                    categories = data["projects"][proj_id].get("categories", {})
                    if cat_id in categories and asset_id in categories[cat_id].get("assets", []):
                        categories[cat_id]["assets"].remove(asset_id)
                del data["assets"][asset_id]
                self._thumbnail_cache.pop(asset_id, None)
                deduped += 1
            else:
                seen_paths.add(path_key)
        
        # 5. 清理磁盘上已删除的项目/分类文件夹（账本残留的记录连同其下素材一并移除）
        removed_projects = 0
        removed_categories = 0
        disk_proj_folders = {}  # 项目文件夹名(lower) -> {分类文件夹名(lower)}
        try:
            for entry in os.listdir(self.base_path):
                entry_path = os.path.join(self.base_path, entry)
                if not os.path.isdir(entry_path) or entry.startswith(".") or entry.lower() in self._SKIP_FOLDERS:
                    continue
                cat_names = set()
                try:
                    for sub in os.listdir(entry_path):
                        sub_path = os.path.join(entry_path, sub)
                        if os.path.isdir(sub_path) and not sub.startswith(".") and sub.lower() not in self._SKIP_FOLDERS:
                            cat_names.add(self._sanitize_folder_name(sub).lower())
                except OSError:
                    pass
                disk_proj_folders[self._sanitize_folder_name(entry).lower()] = cat_names
        except OSError:
            disk_proj_folders = None

        if disk_proj_folders is not None:
            for proj_id in list(data["projects"].keys()):
                proj = data["projects"][proj_id]
                pkey = self._sanitize_folder_name(proj["name"]).lower()
                if pkey not in disk_proj_folders:
                    for cat in proj.get("categories", {}).values():
                        for aid in cat.get("assets", []):
                            data["assets"].pop(aid, None)
                            self._thumbnail_cache.pop(aid, None)
                    del data["projects"][proj_id]
                    removed_projects += 1
                    continue
                for cat_id in list(proj.get("categories", {}).keys()):
                    cat = proj["categories"][cat_id]
                    if self._sanitize_folder_name(cat["name"]).lower() not in disk_proj_folders[pkey]:
                        for aid in cat.get("assets", []):
                            data["assets"].pop(aid, None)
                            self._thumbnail_cache.pop(aid, None)
                        del proj["categories"][cat_id]
                        removed_categories += 1

        if renamed > 0 or removed > 0 or deduped > 0 or removed_projects > 0 or removed_categories > 0:
            self._save_data(data)

        orphans = len(orphan_files) - len(used_orphans)
        print(f"[WP资产库] 文件系统校准: 改名同步 {renamed}, 移除失效 {removed}, 去重合并 {deduped}, 移除失效项目 {removed_projects}, 移除失效分类 {removed_categories}, 保留待查 {skipped}, 未入库新文件 {orphans}")
        return {
            "success": True,
            "renamed": renamed,
            "removed": removed,
            "deduped": deduped,
            "removed_projects": removed_projects,
            "removed_categories": removed_categories,
            "skipped": skipped,
            "orphans": orphans,
            "total": len(data["assets"])
        }
    
    # 全库扫描时跳过的系统/隐藏文件夹
    _SKIP_FOLDERS = {"$recycle.bin", "system volume information", "recycler", "lost+found"}

    def full_scan(self) -> Dict:
        """
        全库智能扫描：
        1. 先执行文件系统校准（已有素材的改名/删除同步）
        2. 发现磁盘上未登记的文件夹：根目录新文件夹 → 新项目，项目下新子文件夹 → 新分类
        3. 收集所有分类文件夹（含更深层子文件夹）里的未入库文件，自动入库
        4. 根目录/项目文件夹下的散文件不自动入库，只统计数量
        """
        if not os.path.isdir(self.base_path):
            return {"success": False, "error": f"素材库目录不存在: {self.base_path}"}

        # 1. 先校准已有记录（改名/删除），内部自行保存
        sync_result = self.sync_with_filesystem()
        if not sync_result.get("success"):
            return sync_result

        data = self._load_data()
        all_formats = self._get_all_supported_formats()

        # 已登记资产的绝对路径集合（跨项目去重）
        known_paths = set()
        for asset in data["assets"].values():
            fp = asset.get("file_path", "")
            if fp:
                known_paths.add(os.path.abspath(fp))

        new_projects = 0
        new_categories = 0
        new_assets = 0
        loose_files = 0
        invalid_files = 0

        def is_skipped_folder(name: str) -> bool:
            return name.startswith(".") or name.lower() in self._SKIP_FOLDERS

        def is_system_file(name: str) -> bool:
            return name in ("assets.json", "config.json", MIGRATION_MARKER) or name.startswith(("thumbnail_", "transcode_"))

        # 2. 遍历根目录一级结构
        try:
            root_entries = os.listdir(self.base_path)
        except OSError as e:
            return {"success": False, "error": f"无法读取素材库目录: {e}"}

        for entry in root_entries:
            entry_path = os.path.join(self.base_path, entry)
            if os.path.isdir(entry_path):
                if is_skipped_folder(entry):
                    continue

                # 文件夹名 → 项目名（Windows 文件夹名本身不含非法字符，sanitize 仅防御）
                proj_name = self._sanitize_folder_name(entry)

                # 查找该项目是否已登记（文件夹名大小写不敏感匹配）
                proj_id = None
                for pid, pinfo in data["projects"].items():
                    if self._sanitize_folder_name(pinfo["name"]).lower() == proj_name.lower():
                        proj_id = pid
                        break

                if proj_id is None:
                    # 注册新项目
                    proj_id = str(uuid.uuid4())
                    data["projects"][proj_id] = {
                        "id": proj_id,
                        "name": proj_name,
                        "description": "",
                        "created_at": datetime.now().isoformat(),
                        "categories": {}
                    }
                    new_projects += 1

                # 3. 遍历该项目文件夹下的二级结构
                try:
                    proj_entries = os.listdir(entry_path)
                except OSError:
                    continue

                for sub in proj_entries:
                    sub_path = os.path.join(entry_path, sub)
                    if os.path.isdir(sub_path):
                        if is_skipped_folder(sub):
                            continue

                        cat_name = self._sanitize_folder_name(sub)
                        categories = data["projects"][proj_id].setdefault("categories", {})

                        cat_id = None
                        for cid, cinfo in categories.items():
                            if self._sanitize_folder_name(cinfo["name"]).lower() == cat_name.lower():
                                cat_id = cid
                                break

                        if cat_id is None:
                            cat_id = str(uuid.uuid4())
                            categories[cat_id] = {
                                "id": cat_id,
                                "name": cat_name,
                                "description": "",
                                "created_at": datetime.now().isoformat(),
                                "assets": []
                            }
                            new_categories += 1

                        # 4. 递归收集该分类文件夹（含更深层子文件夹）里的未入库文件
                        for root, dirs, files in os.walk(sub_path):
                            dirs[:] = [d for d in dirs if not is_skipped_folder(d)]
                            for filename in files:
                                if filename.startswith(("thumbnail_", "transcode_")):
                                    continue
                                file_ext = os.path.splitext(filename)[1].lower()
                                if file_ext not in all_formats:
                                    continue
                                file_path = os.path.abspath(os.path.join(root, filename))
                                if file_path in known_paths:
                                    continue

                                # 图片文件做完整性校验，损坏的不入库
                                media_type = self._get_media_type(file_ext)
                                if media_type == "image" and not self._validate_image_file(file_path):
                                    invalid_files += 1
                                    continue

                                try:
                                    stat = os.stat(file_path)
                                except OSError:
                                    continue

                                asset_id = f"asset_{data['next_asset_id']}"
                                data["next_asset_id"] += 1
                                data["assets"][asset_id] = {
                                    "id": asset_id,
                                    "name": os.path.splitext(filename)[0],
                                    "description": "",
                                    "project_id": proj_id,
                                    "category_id": cat_id,
                                    "file_path": file_path,
                                    "file_name": filename,
                                    "file_size": stat.st_size,
                                    "file_ext": file_ext,
                                    "file_type": media_type,
                                    "file_hash": self._calculate_file_hash(file_path),
                                    "upload_time": datetime.now().isoformat(),
                                    "modified_time": datetime.fromtimestamp(stat.st_mtime).isoformat()
                                }
                                categories[cat_id]["assets"].append(asset_id)
                                known_paths.add(file_path)
                                new_assets += 1

                                # 预生成图片缩略图
                                if media_type == "image":
                                    thumb_bytes = self._generate_thumbnail_bytes(file_path)
                                    if thumb_bytes:
                                        self._thumbnail_cache[asset_id] = thumb_bytes
                    else:
                        # 项目文件夹下的散文件：统计不入库
                        if is_system_file(sub):
                            continue
                        file_ext = os.path.splitext(sub)[1].lower()
                        if file_ext in all_formats:
                            loose_files += 1
            else:
                # 根目录散文件：统计不入库
                if is_system_file(entry):
                    continue
                file_ext = os.path.splitext(entry)[1].lower()
                if file_ext in all_formats:
                    loose_files += 1

        # 5. 归属校准：素材实际位置与挂载分类不一致时重新挂载
        #（sync 阶段新文件夹尚未注册导致归属未更新；或素材被移动到账本已注册的其他分类）
        remounted = 0
        for asset_id, asset in data["assets"].items():
            fp = asset.get("file_path", "")
            if not fp:
                continue
            owner_proj, owner_cat = self._resolve_owner_by_path(fp, data)
            if not owner_proj or not owner_cat:
                continue
            if owner_proj == asset.get("project_id") and owner_cat == asset.get("category_id"):
                continue
            if asset_id not in data["projects"][owner_proj]["categories"][owner_cat].get("assets", []):
                self._remount_asset(data, asset_id, asset, owner_proj, owner_cat)
                remounted += 1

        # 6. 一次性保存账本
        self._save_data(data)

        print(f"[WP资产库] 全库扫描: 新项目 {new_projects}, 新分类 {new_categories}, 新素材 {new_assets}, 位置修正 {remounted}, 散文件 {loose_files}, 损坏跳过 {invalid_files}")
        return {
            "success": True,
            "new_projects": new_projects,
            "new_categories": new_categories,
            "new_assets": new_assets,
            "renamed": sync_result.get("renamed", 0),
            "removed": sync_result.get("removed", 0),
            "removed_projects": sync_result.get("removed_projects", 0),
            "removed_categories": sync_result.get("removed_categories", 0),
            "remounted": remounted,
            "skipped": sync_result.get("skipped", 0),
            "loose_files": loose_files,
            "invalid_files": invalid_files,
            "total": len(data["assets"])
        }

    def scan_local_images(self, proj_id: str, cat_id: str) -> int:
        """
        扫描本地资产库文件夹中的文件，添加到指定项目/分类中
        
        扫描逻辑：
        1. 根据 assets.json 中的项目名/分类名定位对应的磁盘文件夹
        2. 遍历该分类文件夹中的所有文件
        3. 未注册的自动注册，已注册的同步文件名
        """
        data = self._load_data()
        if proj_id not in data["projects"]:
            return 0
        
        project = data["projects"][proj_id]
        if cat_id not in project.get("categories", {}):
            return 0
        
        category = project["categories"][cat_id]
        proj_name = self._sanitize_folder_name(project["name"])
        cat_name = self._sanitize_folder_name(category["name"])
        cat_folder = os.path.join(self.base_path, proj_name, cat_name)
        
        if not os.path.exists(cat_folder):
            print(f"[WP资产库] 分类文件夹不存在: {cat_folder}")
            return 0
        
        all_formats = self._get_all_supported_formats()
        
        # 构建已有资产的文件路径集合（用于去重）
        existing_paths = set()
        for asset_id in category.get("assets", []):
            if asset_id in data["assets"]:
                fp = os.path.abspath(data["assets"][asset_id].get("file_path", ""))
                if fp:
                    existing_paths.add(fp)
        
        new_count = 0
        synced_count = 0
        
        for filename in os.listdir(cat_folder):
            file_path = os.path.join(cat_folder, filename)
            if not os.path.isfile(file_path):
                continue
            
            file_ext = os.path.splitext(filename)[1].lower()
            if file_ext not in all_formats:
                continue
            
            abs_path = os.path.abspath(file_path)
            
            # 检查是否已注册
            if abs_path in existing_paths:
                # 已注册，检查文件名是否需要同步
                for asset_id in category.get("assets", []):
                    if asset_id in data["assets"]:
                        asset = data["assets"][asset_id]
                        if os.path.abspath(asset.get("file_path", "")) == abs_path:
                            # 同步文件名到 name 字段（去掉扩展名）
                            disk_name = os.path.splitext(filename)[0]
                            if asset.get("name") != disk_name:
                                asset["name"] = disk_name
                                asset["file_name"] = filename
                                synced_count += 1
                            break
                continue
            
            # 新文件，注册到资产库
            display_name = os.path.splitext(filename)[0]
            media_type = self._get_media_type(file_ext)
            file_hash = self._calculate_file_hash(file_path)
            stat = os.stat(file_path)
            
            asset_id = self._generate_asset_id()
            
            data = self._load_data()
            data["assets"][asset_id] = {
                "id": asset_id,
                "name": display_name,
                "description": "",
                "project_id": proj_id,
                "category_id": cat_id,
                "file_path": abs_path,
                "file_name": filename,
                "file_size": stat.st_size,
                "file_ext": file_ext,
                "file_type": media_type,
                "file_hash": file_hash,
                "upload_time": datetime.now().isoformat(),
                "modified_time": datetime.fromtimestamp(stat.st_mtime).isoformat()
            }
            
            data["projects"][proj_id]["categories"][cat_id]["assets"].append(asset_id)
            self._save_data(data)
            
            # 预生成缩略图
            if media_type == "image":
                thumb_bytes = self._generate_thumbnail_bytes(file_path)
                if thumb_bytes:
                    self._thumbnail_cache[asset_id] = thumb_bytes
            
            existing_paths.add(abs_path)
            new_count += 1
        
        if synced_count > 0:
            self._save_data(data)
            print(f"[WP资产库] 同步了 {synced_count} 个资产的文件名")
        
        if new_count > 0:
            print(f"[WP资产库] 扫描发现 {new_count} 个新文件")
        
        return new_count
    
    # ========== 视频兼容播放（自动转码缓存） ==========

    # 浏览器可直接播放的视频容器
    _BROWSER_NATIVE_VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm"}

    def _detect_mp4_codec(self, file_path: str) -> str:
        """解析 MP4/MOV 的 stsd box，返回视频编码标识（hvc1/avc1/...）；解析失败返回空串"""
        try:
            with open(file_path, "rb") as f:
                data = f.read(3 * 1024 * 1024)
            idx = data.find(b"stsd")
            if idx == -1:
                return ""
            pos = idx + 12  # 跳过 version/flags + entry_count，指向第一个条目
            if pos + 8 <= len(data):
                return data[pos + 4: pos + 8].decode("ascii", errors="ignore")
        except OSError:
            pass
        return ""

    def _video_needs_transcode(self, file_path: str) -> bool:
        """判断视频是否无法被浏览器直接播放（需要 H.264 转码缓存副本）"""
        ext = os.path.splitext(file_path)[1].lower()
        if ext == ".webm":
            return False  # WebM（VP8/VP9/AV1）浏览器原生支持
        if ext not in self._BROWSER_NATIVE_VIDEO_EXTS:
            return True   # mkv/avi/flv/ts/wmv 等容器浏览器不支持
        # mp4/mov/m4v 需检查内部编码：HEVC（hvc1/hev1）浏览器普遍不支持
        return self._detect_mp4_codec(file_path) in ("hvc1", "hev1")

    def _get_transcode_path(self, asset_id: str, file_path: str) -> str:
        """转码缓存副本路径（与素材同目录，transcode_ 前缀避免被扫描当作新素材）"""
        return os.path.join(os.path.dirname(file_path), f"transcode_{asset_id}.mp4")

    def start_video_transcode(self, asset_id: str) -> Dict:
        """触发视频后台转码生成 H.264 缓存副本（原文件不动）；已运行/已完成直接返回状态"""
        asset_info = self.get_asset_info(asset_id)
        if not asset_info:
            return {"success": False, "error": "素材不存在"}
        if asset_info.get("file_type") != "video":
            return {"success": False, "error": "非视频素材"}
        src = asset_info.get("file_path", "")
        if not src or not os.path.exists(src):
            return {"success": False, "error": "视频文件不存在"}
        if not self._video_needs_transcode(src):
            return {"success": True, "status": "native", "message": "该视频浏览器可直接播放，无需转码"}

        dst = self._get_transcode_path(asset_id, src)
        # 已有有效缓存（不早于原文件修改时间）直接视为完成
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            with self._transcode_lock:
                self._transcode_status[asset_id] = {"status": "done"}
            return {"success": True, "status": "done"}

        with self._transcode_lock:
            if self._transcode_status.get(asset_id, {}).get("status") == "running":
                return {"success": True, "status": "running"}
            self._transcode_status[asset_id] = {"status": "running"}

        threading.Thread(target=self._run_video_transcode, args=(asset_id, src, dst), daemon=True).start()
        return {"success": True, "status": "running"}

    def _run_video_transcode(self, asset_id: str, src_path: str, dst_path: str):
        """后台线程：ffmpeg 转 H.264（faststart 便于网页边下边播），完成后原子替换缓存"""
        import subprocess
        tmp_path = dst_path + ".tmp.mp4"
        try:
            ffmpeg = _find_ffmpeg()
            if not ffmpeg:
                raise RuntimeError("未找到 ffmpeg，无法转码")
            if _ffmpeg_has_x264(ffmpeg):
                # 完整版：libx264 恒定质量，体积小
                vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
            else:
                # 阉割版（无 GPL/libx264，如 conda 构建）：退回 Windows 系统媒体编码器
                vcodec = ["-c:v", "h264_mf", "-b:v", "4M"]
            cmd = [
                ffmpeg, "-y", "-loglevel", "error", "-i", src_path,
                *vcodec,
                "-c:a", "aac", "-movflags", "+faststart", tmp_path
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=60 * 30)
            if r.returncode != 0 or not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
                raise RuntimeError(r.stderr.decode("utf-8", errors="ignore")[-300:] or "ffmpeg 转码失败")
            os.replace(tmp_path, dst_path)
            with self._transcode_lock:
                self._transcode_status[asset_id] = {"status": "done"}
            print(f"[WP资产库] 视频转码完成: {asset_id} -> {os.path.basename(dst_path)}")
        except Exception as e:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            with self._transcode_lock:
                self._transcode_status[asset_id] = {"status": "failed", "error": str(e)}
            print(f"[WP资产库] 视频转码失败: {asset_id}, {e}")

    def get_transcode_status(self, asset_id: str) -> Dict:
        """查询转码状态：none/running/done/failed"""
        with self._transcode_lock:
            st = dict(self._transcode_status.get(asset_id, {"status": "none"}))
        return {"success": True, **st}

    def get_playable_path(self, asset_id: str) -> Tuple[Optional[str], bool]:
        """
        返回浏览器可播放的文件路径与"是否需要转码"标记：
        - 浏览器可直接播放 → (原文件, False)
        - 需转码且有有效缓存 → (缓存副本, False)
        - 需转码但无缓存 → (原文件, True)（前端播放失败后触发转码）
        """
        asset_info = self.get_asset_info(asset_id)
        if not asset_info:
            return None, False
        src = asset_info.get("file_path", "")
        if not src or not os.path.exists(src):
            return None, False
        if asset_info.get("file_type") != "video" or not self._video_needs_transcode(src):
            return src, False
        dst = self._get_transcode_path(asset_id, src)
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            return dst, False
        return src, True

    # ========== 视频缩略图 ==========
    
    def generate_video_thumbnail(self, asset_id: str) -> Optional[bytes]:
        """使用 ffmpeg 提取视频第一帧作为缩略图"""
        import subprocess
        import tempfile
        
        asset_info = self.get_asset_info(asset_id)
        if not asset_info or asset_info.get("file_type") != "video":
            return None
        
        video_path = asset_info.get("file_path", "")
        if not video_path or not os.path.exists(video_path):
            return None
        
        try:
            # 用 ffmpeg 提取第 1 秒的帧
            with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
                tmp_path = tmp.name
            
            cmd = [
                'ffmpeg', '-y', '-ss', '1', '-i', video_path,
                '-vframes', '1', '-q:v', '3', '-f', 'image2', tmp_path
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
                with open(tmp_path, 'rb') as f:
                    thumb_bytes = f.read()
                os.remove(tmp_path)
                self._thumbnail_cache[asset_id] = thumb_bytes
                return thumb_bytes
            else:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                return None
        except FileNotFoundError:
            print("[WP资产库] ffmpeg 未安装，无法生成视频缩略图")
            return None
        except Exception as e:
            print(f"[WP资产库] 视频缩略图生成失败: {e}")
            return None
    
    # ========== 文本文件读写 ==========
    
    def read_text_content(self, asset_id: str) -> Optional[str]:
        """读取文本文件内容"""
        asset_info = self.get_asset_info(asset_id)
        if not asset_info or asset_info.get("file_type") != "text":
            return None
        
        file_path = asset_info.get("file_path", "")
        if not file_path or not os.path.exists(file_path):
            return None
        
        try:
            # 尝试多种编码
            for encoding in ['utf-8', 'gbk', 'gb2312', 'latin-1']:
                try:
                    with open(file_path, 'r', encoding=encoding) as f:
                        return f.read()
                except UnicodeDecodeError:
                    continue
            return None
        except Exception as e:
            print(f"[WP资产库] 读取文本失败: {e}")
            return None
    
    def save_text_content(self, asset_id: str, content: str) -> bool:
        """保存文本文件内容"""
        asset_info = self.get_asset_info(asset_id)
        if not asset_info or asset_info.get("file_type") != "text":
            return False
        
        file_path = asset_info.get("file_path", "")
        if not file_path or not os.path.exists(file_path):
            return False
        
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)
            return True
        except Exception as e:
            print(f"[WP资产库] 保存文本失败: {e}")
            return False


# 全局资产库实例
asset_library = AssetLibraryManager()


def get_asset_library():
    """获取资产库实例"""
    return asset_library
