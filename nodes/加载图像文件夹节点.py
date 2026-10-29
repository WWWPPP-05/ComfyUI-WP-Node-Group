"""
🐳 加载图像（文件夹）节点
递归扫描指定文件夹及其子文件夹，把所有图像文件加载后以图像列表输出
支持格式：JPG / JPEG / PNG / WEBP / BMP / GIF / TIFF
"""
import os
import re
import numpy as np
import torch
from PIL import Image, ImageOps

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


def _clean_path(raw):
    """清理用户输入的路径：去空格、去首尾引号，相对路径转为绝对路径"""
    text = (raw or "").strip().strip('"').strip("'").strip()
    return os.path.abspath(text) if text else ""


def _natural_key(name):
    """智能文件名排序：数字按数值比较，img1、img2、…、img10 不会乱序"""
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def _scan_records(root, recursive, skipped_dirs):
    """
    遍历文件夹收集图像文件记录
    返回元组列表：(完整路径, 文件名, 扩展名, 大小字节, 修改时间)
    只读文件档案信息，不加载图片内容
    """
    records = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if recursive:
                                stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext in SUPPORTED_EXTS:
                                st = entry.stat(follow_symlinks=False)
                                records.append((entry.path, entry.name, ext, st.st_size, st.st_mtime))
                    except OSError:
                        continue
        except OSError:
            skipped_dirs.append(current)
    return records


class ImageFolderLoadNode:
    """
    🐳 加载图像（文件夹）节点
    递归扫描文件夹，把图像文件全部加载后输出为图像列表
    下游节点会对列表中的每张图像各执行一次
    """

    CATEGORY = "🐳 WP_Node"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "load_images"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文件夹路径": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "例如 F:\\images 或 input/图片",
                    "tooltip": "要扫描的文件夹路径，支持绝对路径或相对路径（以ComfyUI主程序目录为基准），可直接粘贴带引号的路径",
                }),
                "包含子文件夹": ("BOOLEAN", {"default": True, "tooltip": "开启后递归扫描所有子文件夹"}),
                "排序方式": (["文件名升序", "文件名降序", "时间最新优先", "时间最旧优先"], {"default": "文件名升序"}),
            },
        }

    def load_images(self, 文件夹路径, 包含子文件夹=True, 排序方式="文件名升序"):
        path = _clean_path(文件夹路径)
        if not path:
            raise ValueError("【WP 加载图像（文件夹）】文件夹路径为空，请填写要扫描的文件夹路径（支持绝对路径或相对路径）")
        if not os.path.exists(path):
            raise ValueError(f"【WP 加载图像（文件夹）】路径不存在：{path}\n请检查路径是否填写正确")
        if not os.path.isdir(path):
            raise ValueError(f"【WP 加载图像（文件夹）】该路径是文件而不是文件夹：{path}\n请填写文件夹路径")

        skipped_dirs = []
        records = _scan_records(path, 包含子文件夹, skipped_dirs)

        if not records:
            formats = "、".join(sorted(e.lstrip(".").upper() for e in SUPPORTED_EXTS))
            if 包含子文件夹:
                scope = "及其所有子文件夹中"
                hint = ""
            else:
                scope = "中（当前未开启\"包含子文件夹\"）"
                hint = "\n提示：可尝试开启\"包含子文件夹\"开关"
            raise ValueError(
                f"【WP 加载图像（文件夹）】在文件夹{scope}没有找到任何图像文件：{path}\n"
                f"支持的图像格式：{formats}{hint}"
            )

        if 排序方式 == "文件名升序":
            records.sort(key=lambda r: _natural_key(r[1]))
        elif 排序方式 == "文件名降序":
            records.sort(key=lambda r: _natural_key(r[1]), reverse=True)
        elif 排序方式 == "时间最新优先":
            records.sort(key=lambda r: r[4], reverse=True)
        else:
            records.sort(key=lambda r: r[4])

        # 逐张加载：读完立即转张量并关闭文件，不保留文件句柄
        images = []
        for full_path, _, _, _, _ in records:
            try:
                with Image.open(full_path) as im:
                    im = ImageOps.exif_transpose(im)
                    im = im.convert("RGB")
                    arr = np.array(im).astype(np.float32) / 255.0
            except Exception as e:
                raise ValueError(
                    f"【WP 加载图像（文件夹）】图片无法读取：{full_path}\n"
                    f"可删除或修复该文件后重试\n错误详情：{e}"
                )
            images.append(torch.from_numpy(arr)[None,])

        return (images,)

    @classmethod
    def IS_CHANGED(s, 文件夹路径, 包含子文件夹=True, 排序方式="文件名升序"):
        """用扫描摘要做缓存指纹：文件夹内容增删改时自动重新扫描，无需手动刷新"""
        path = _clean_path(文件夹路径)
        if not path or not os.path.isdir(path):
            return "invalid"
        skipped = []
        records = _scan_records(path, 包含子文件夹, skipped)
        total = sum(r[3] for r in records)
        newest = max((r[4] for r in records), default=0)
        return f"{len(records)}_{total}_{newest}_{len(skipped)}"

    @classmethod
    def VALIDATE_INPUTS(s, 文件夹路径, 包含子文件夹=True, 排序方式="文件名升序"):
        """排队前先校验路径，让错误第一时间显示在节点上"""
        path = _clean_path(文件夹路径)
        if not path:
            return "【WP 加载图像（文件夹）】文件夹路径为空，请填写要扫描的文件夹路径"
        if not os.path.exists(path):
            return f"【WP 加载图像（文件夹）】路径不存在：{path}"
        if not os.path.isdir(path):
            return f"【WP 加载图像（文件夹）】该路径是文件而不是文件夹：{path}"
        return True
