"""
🐳 WP 输出文件夹监测模块
功能：配置并实时监测 ComfyUI 输出文件夹，文件变化时通过 WebSocket 推送前端刷新。
输出文件夹以"虚拟项目"形式展示：不写入素材库账本，每次列表都直接读取磁盘实时状态。
"""
import os
import sys
import io
import json
import shutil
import threading
import time
import mimetypes
from datetime import datetime
from typing import Dict, List, Optional

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_CONFIG_PATH = os.path.join(PLUGIN_DIR, "wp_output_config.json")

SUPPORTED_FORMATS = {
    "image": [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif"],
    "audio": [".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"],
    "video": [".mp4", ".webm", ".avi", ".mov", ".mkv", ".wmv", ".flv"],
    "text": [".txt", ".json", ".csv", ".xml", ".yaml", ".yml", ".md", ".py", ".js", ".html", ".css"],
}
EXT_TO_TYPE = {ext: ftype for ftype, exts in SUPPORTED_FORMATS.items() for ext in exts}

POLL_INTERVAL = 2.0      # 基础轮询间隔（秒）
INVALID_RETRY = 5.0      # 路径失效时的重试间隔（秒）
DEBOUNCE_WAIT = 1.2      # 变化防抖：等文件写完再通知（秒）
MAX_LIST_FILES = 500     # 单次列表最多返回文件数（按最新优先截断）
THUMB_CACHE_MAX = 400    # 缩略图内存缓存条目上限

# 尝试导入 PIL 用于缩略图
try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("[WP输出监测] PIL 未安装，输出图片将不显示缩略图")


def _get_media_type(file_ext: str) -> str:
    return EXT_TO_TYPE.get(file_ext.lower(), "unknown")


# ffmpeg 查找与视频抽帧的共享实现在 asset_library.py（素材库/输出目录共用）


class OutputFolderMonitor:
    """ComfyUI 输出文件夹监测器：配置持久化 + 后台监测线程 + 实时列表/缩略图"""

    def __init__(self):
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        self.output_path: Optional[str] = None   # 已配置的输出目录（绝对路径）
        self.status = "stopped"                  # stopped / watching / invalid
        self.last_change: Optional[str] = None   # 最后一次检测到变化的时间
        self.file_count = 0                      # 最近一次快照的文件总数
        self._last_snapshot: Dict[str, tuple] = {}   # relpath -> (size, mtime_ns)
        self._thumb_cache: Dict[str, tuple] = {}     # relpath -> (size, mtime_ns, bytes)

        self._load_config()

    # ========== 配置管理 ==========

    def _load_config(self):
        try:
            with open(OUTPUT_CONFIG_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            path = data.get("output_path", "")
            if path and os.path.isabs(path):
                self.output_path = os.path.normpath(path)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

    def _save_config(self):
        data = {
            "version": 1,
            "output_path": self.output_path or "",
            "configured_at": datetime.now().isoformat(),
        }
        with open(OUTPUT_CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def get_detected_path(self) -> Optional[str]:
        """自动检测：直接向 ComfyUI 本体询问输出目录，100% 准确"""
        try:
            import folder_paths
            return os.path.abspath(folder_paths.get_output_directory())
        except Exception:
            return None

    def get_config_info(self) -> Dict:
        """供前端展示的配置状态"""
        configured = bool(self.output_path)
        accessible = configured and os.path.isdir(self.output_path)
        return {
            "configured": configured,
            "path": self.output_path or "",
            "accessible": accessible,
            "detected_path": self.get_detected_path(),
            "status": self.status if configured else "stopped",
            "last_change": self.last_change,
            "file_count": self.file_count,
        }

    def set_output_path(self, path: str) -> Dict:
        """配置输出文件夹（path 为空 = 清除配置并停止监测）"""
        path = (path or "").strip()
        if not path:
            return self.clear_output_path()

        if not os.path.isabs(path):
            return {"success": False, "error": "请提供完整的绝对路径"}

        norm = os.path.normpath(path)
        if not os.path.isdir(norm):
            return {"success": False, "error": f"文件夹不存在：{norm}"}

        with self._lock:
            self.output_path = norm
            self._save_config()

        self.start()
        return {"success": True, "path": norm, "status": self.status}

    def clear_output_path(self) -> Dict:
        with self._lock:
            self.output_path = None
            self._last_snapshot = {}
            self._thumb_cache.clear()
            self.file_count = 0
            self._save_config()
        self.stop()
        return {"success": True, "cleared": True}

    # ========== 监测线程 ==========

    def start(self):
        """启动监测线程（已配置且线程未运行时）"""
        self._stop_event.set()  # 停掉旧线程
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._stop_event = threading.Event()

        if not self.output_path:
            self.status = "stopped"
            return

        self._thread = threading.Thread(target=self._monitor_loop, daemon=True, name="wp-output-monitor")
        self._thread.start()
        print(f"[WP输出监测] 已启动监测：{self.output_path}")

    def stop(self):
        self._stop_event.set()
        self.status = "stopped"
        self._last_snapshot = {}

    def _monitor_loop(self):
        """持续监测输出文件夹：快照对比 + 防抖 + 变化推送"""
        poll = POLL_INTERVAL
        while not self._stop_event.is_set():
            path = self.output_path
            if not path:
                self.status = "stopped"
                self._stop_event.wait(INVALID_RETRY)
                continue

            if not os.path.isdir(path):
                # 路径失效（磁盘断开/被删）：暂停监测但不崩溃，等待恢复
                if self.status != "invalid":
                    print(f"[WP输出监测] 输出文件夹无法访问，暂停监测：{path}")
                self.status = "invalid"
                self._stop_event.wait(INVALID_RETRY)
                continue

            self.status = "watching"
            t0 = time.time()
            snap = self._take_snapshot(path)
            elapsed = time.time() - t0

            # 自适应轮询：文件夹很大导致单次扫描耗时长时，拉长间隔，控制 CPU 占用
            poll = max(POLL_INTERVAL, elapsed * 3)

            with self._lock:
                prev = self._last_snapshot

            if snap != prev:
                # 防抖：ComfyUI 写文件有过程，等稳定后再通知，避免半成品触发刷新
                self._stop_event.wait(DEBOUNCE_WAIT)
                snap2 = self._take_snapshot(path)
                if snap2 == snap:
                    with self._lock:
                        self._last_snapshot = snap2
                        self.file_count = len(snap2)
                        self.last_change = datetime.now().isoformat()
                    self._notify_change()

            self._stop_event.wait(poll)

    def _take_snapshot(self, base: str) -> Dict[str, tuple]:
        """递归收集所有受支持格式文件的 (大小, 修改时间)，作为变化检测快照"""
        result = {}
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in files:
                ext = os.path.splitext(name)[1].lower()
                if ext not in EXT_TO_TYPE:
                    continue
                full = os.path.join(root, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                result[os.path.relpath(full, base)] = (st.st_size, st.st_mtime_ns)
        return result

    def _notify_change(self):
        """通过 ComfyUI 官方线程安全接口推送变化事件给前端"""
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("wp_output_changed", {
                "last_change": self.last_change,
                "file_count": self.file_count,
            })
        except Exception as e:
            # 独立测试环境（无 ComfyUI 服务）下仅记录状态
            print(f"[WP输出监测] 推送变化事件失败（ComfyUI 未运行？）: {e}")

    # ========== 路径安全 ==========

    def _resolve_rel(self, rel: str) -> Optional[str]:
        """将相对路径解析为输出目录内的绝对路径，越界（../）返回 None"""
        if not self.output_path:
            return None
        base = os.path.abspath(self.output_path)
        full = os.path.normpath(os.path.join(base, (rel or "").strip().lstrip("/\\")))
        if full != base and not full.startswith(base + os.sep):
            return None
        return full

    # ========== 列表 ==========

    def list_output(self, sub: str = "", query: str = "") -> Dict:
        """列出输出文件夹内容。sub 为空 = 根视图（返回子文件夹清单 + 全部文件）；
        sub 为子文件夹名 = 只列该子文件夹（递归）内的文件。文件按最新优先排序。"""
        if not self.output_path:
            return {"success": False, "error": "尚未配置输出文件夹"}
        if not os.path.isdir(self.output_path):
            return {"success": False, "error": "输出文件夹无法访问，请检查路径"}

        target = self._resolve_rel(sub)
        if target is None or not os.path.isdir(target):
            return {"success": False, "error": "子文件夹不存在"}

        files = []
        subfolders = []

        if not sub:
            # 根视图：一级子文件夹作为"分类"，统计各自递归文件数
            try:
                entries = os.listdir(self.output_path)
            except OSError as e:
                return {"success": False, "error": f"无法读取输出文件夹: {e}"}
            for entry in entries:
                full = os.path.join(self.output_path, entry)
                if not os.path.isdir(full) or entry.startswith("."):
                    continue
                count = self._count_files(full)
                if count > 0:
                    subfolders.append({"name": entry, "rel": entry, "count": count})
            subfolders.sort(key=lambda x: x["name"])

        # 递归收集 target 下所有受支持文件
        for root, dirs, names in os.walk(target):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in names:
                ext = os.path.splitext(name)[1].lower()
                if ext not in EXT_TO_TYPE:
                    continue
                if query and query.lower() not in name.lower():
                    continue
                full = os.path.join(root, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                files.append({
                    "name": os.path.splitext(name)[0],
                    "file_name": name,
                    "rel_path": os.path.relpath(full, self.output_path).replace("\\", "/"),
                    "file_type": _get_media_type(ext),
                    "file_ext": ext,
                    "file_size": st.st_size,
                    "modified_time": datetime.fromtimestamp(st.st_mtime).isoformat(),
                    "_mtime": st.st_mtime,
                })

        # 最新优先
        files.sort(key=lambda x: x["_mtime"], reverse=True)
        total = len(files)
        truncated = total > MAX_LIST_FILES
        for f in files:
            f.pop("_mtime", None)
        files = files[:MAX_LIST_FILES]

        return {
            "success": True,
            "subfolders": subfolders,
            "files": files,
            "total": total,
            "truncated": truncated,
            "max_files": MAX_LIST_FILES,
        }

    def _count_files(self, folder: str) -> int:
        count = 0
        for root, dirs, names in os.walk(folder):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in names:
                if os.path.splitext(name)[1].lower() in EXT_TO_TYPE:
                    count += 1
        return count

    # ========== 缩略图 / 文本 / 文件服务 ==========

    def get_thumbnail(self, rel: str) -> Optional[bytes]:
        """生成输出图片缩略图（内存缓存，文件变化自动失效）"""
        if not PIL_AVAILABLE:
            return None
        full = self._resolve_rel(rel)
        if not full or not os.path.isfile(full):
            return None
        if _get_media_type(os.path.splitext(full)[1]) != "image":
            return None

        try:
            st = os.stat(full)
        except OSError:
            return None

        cached = self._thumb_cache.get(rel)
        if cached and cached[0] == st.st_size and cached[1] == st.st_mtime_ns:
            return cached[2]

        import io
        try:
            with Image.open(full) as img:
                img.thumbnail((256, 256), Image.Resampling.LANCZOS)
                if img.mode in ('RGBA', 'P'):
                    img = img.convert('RGB')
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=85, optimize=True)
                data = buf.getvalue()
        except Exception as e:
            print(f"[WP输出监测] 生成缩略图失败: {rel} ({e})")
            return None

        # FIFO 淘汰，控制内存占用
        if len(self._thumb_cache) >= THUMB_CACHE_MAX:
            oldest = next(iter(self._thumb_cache))
            self._thumb_cache.pop(oldest, None)
        self._thumb_cache[rel] = (st.st_size, st.st_mtime_ns, data)
        return data

    def read_text(self, rel: str) -> Optional[str]:
        """读取输出文本文件内容（拖拽注入文本 widget 用）"""
        full = self._resolve_rel(rel)
        if not full or not os.path.isfile(full):
            return None
        if _get_media_type(os.path.splitext(full)[1]) != "text":
            return None
        for encoding in ['utf-8', 'gbk', 'gb2312', 'latin-1']:
            try:
                with open(full, 'r', encoding=encoding) as f:
                    return f.read()
            except UnicodeDecodeError:
                continue
        return None

    def get_file_info(self, rel: str) -> Optional[Dict]:
        """获取文件绝对路径与内容类型（文件流接口用）"""
        full = self._resolve_rel(rel)
        if not full or not os.path.isfile(full):
            return None
        return {
            "path": full,
            "content_type": mimetypes.guess_type(full)[0] or "application/octet-stream",
        }

    def copy_to_input(self, rel: str) -> Dict:
        """复制输出文件到 ComfyUI input 目录（拖拽/双击生成节点用），避开同名覆盖"""
        import folder_paths
        full = self._resolve_rel(rel)
        if not full or not os.path.isfile(full):
            return {"success": False, "error": "输出文件不存在"}

        input_dir = folder_paths.get_input_directory()
        file_name = os.path.basename(full)
        dest = os.path.join(input_dir, file_name)
        counter = 1
        base, ext = os.path.splitext(file_name)
        while os.path.exists(dest):
            file_name = f"{base}_{counter}{ext}"
            dest = os.path.join(input_dir, file_name)
            counter += 1

        try:
            shutil.copy2(full, dest)
        except OSError as e:
            return {"success": False, "error": f"复制失败: {e}"}
        return {"success": True, "file_name": file_name}

    def copy_to_clipboard(self, rel: str) -> Dict:
        """复制输出文件本体到系统剪贴板（图片=文件+位图，文本=文件+文字，其他=仅文件）"""
        from .asset_library import _win_copy_to_clipboard

        if sys.platform != "win32":
            return {"success": False, "error": "剪贴板功能仅支持 Windows 系统"}

        full = self._resolve_rel(rel)
        if not full or not os.path.isfile(full):
            return {"success": False, "error": "输出文件不存在"}

        media_type = _get_media_type(os.path.splitext(full)[1])
        dib_bytes = None
        text = None

        if media_type == "image" and PIL_AVAILABLE:
            # 位图格式：粘贴到聊天框/输入框时直接出图片（GIF 取首帧）
            try:
                with Image.open(full) as img:
                    if img.mode != "RGB":
                        img = img.convert("RGB")
                    buf = io.BytesIO()
                    img.save(buf, format="BMP")
                    dib_bytes = buf.getvalue()[14:]
            except Exception as e:
                print(f"[WP输出监测] 转换位图失败（不影响文件粘贴）: {e}")
        elif media_type == "text":
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except Exception as e:
                print(f"[WP输出监测] 读取文本失败（不影响文件粘贴）: {e}")

        ok, msg = _win_copy_to_clipboard([full], dib_bytes=dib_bytes, text=text)
        return {"success": ok, **({} if ok else {"error": msg})}

    def copy_video_frame(self, rel: str, time_sec) -> Dict:
        """用 ffmpeg 抽取视频指定时间点的帧，以位图格式写入系统剪贴板"""
        from .asset_library import _win_copy_to_clipboard, _extract_video_frame_dib

        if sys.platform != "win32":
            return {"success": False, "error": "剪贴板功能仅支持 Windows 系统"}

        full = self._resolve_rel(rel)
        if not full or not os.path.isfile(full):
            return {"success": False, "error": "视频文件不存在"}

        ok, payload = _extract_video_frame_dib(full, time_sec)
        if not ok:
            return {"success": False, "error": payload}

        ok, msg = _win_copy_to_clipboard([], dib_bytes=payload)
        return {"success": ok, **({} if ok else {"error": msg})}


# 全局单例（资产库节点路由引用）
output_monitor = OutputFolderMonitor()

# 若已配置过输出文件夹，随插件加载自动开始监测
if output_monitor.output_path:
    output_monitor.start()
