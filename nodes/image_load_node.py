"""
🐳 加载图像节点 - 完全复刻ComfyUI原生LoadImage功能
使用V1 API（传统方式）定义节点
支持按边缩放图像和遮罩
"""
import os
import hashlib
import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import comfy.model_management
import folder_paths
import node_helpers


class ImageLoadNode:
    """
     加载图像节点 - 从输入目录加载图像文件
    功能完全复刻ComfyUI原生LoadImage节点
    新增：支持按边缩放图像和遮罩
    """

    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "image": (sorted(files), {"image_upload": True}),
                "尺寸": ("INT", {"default": 512, "min": 1, "max": 8192, "step": 1}),
            },
            "optional": {
                "模式": ("BOOLEAN", {"default": True, "label_on": "max", "label_off": "min"}),
            }
        }

    CATEGORY = "🐳 WP_Node"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("图像", "遮罩", "宽", "高")
    FUNCTION = "load_image"

    def load_image(self, image, 尺寸, 模式=True):
        """执行图像加载并按边缩放"""
        image_path = folder_paths.get_annotated_filepath(image)

        # 使用PIL打开图像
        img = node_helpers.pillow(Image.open, image_path)

        output_images = []
        output_masks = []
        w, h = None, None

        # 获取中间数据类型
        dtype = comfy.model_management.intermediate_dtype()

        # 遍历图像序列（支持GIF等多帧图像）
        for i in ImageSequence.Iterator(img):
            # 处理EXIF旋转
            i = node_helpers.pillow(ImageOps.exif_transpose, i)

            # 处理32位整数图像
            if i.mode == 'I':
                i = i.point(lambda i: i * (1 / 255))

            # 转换为RGB
            image_rgb = i.convert("RGB")

            # 记录原始尺寸
            orig_w, orig_h = image_rgb.size

            # 按边缩放
            if 模式:
                # max模式（默认）：将长边缩放到target_size
                if orig_w >= orig_h:
                    new_w = 尺寸
                    new_h = int(orig_h * 尺寸 / orig_w)
                else:
                    new_h = 尺寸
                    new_w = int(orig_w * 尺寸 / orig_h)
            else:
                # min模式：将短边缩放到target_size
                if orig_w <= orig_h:
                    new_w = 尺寸
                    new_h = int(orig_h * 尺寸 / orig_w)
                else:
                    new_h = 尺寸
                    new_w = int(orig_w * 尺寸 / orig_h)

            # 确保尺寸至少为1
            new_w = max(1, new_w)
            new_h = max(1, new_h)

            # 缩放图像
            image_rgb = image_rgb.resize((new_w, new_h), Image.LANCZOS)

            # 记录第一帧的尺寸
            if len(output_images) == 0:
                w = new_w
                h = new_h

            # 跳过尺寸不匹配的帧
            if image_rgb.size[0] != w or image_rgb.size[1] != h:
                continue

            # 转换为numpy数组并归一化
            image_array = np.array(image_rgb).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_array)[None,]

            # 处理遮罩（Alpha通道）
            if 'A' in i.getbands():
                mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            elif i.mode == 'P' and 'transparency' in i.info:
                mask = np.array(i.convert('RGBA').getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            else:
                # 直接创建目标尺寸的遮罩，避免不必要的缩放操作
                mask = torch.zeros((new_h, new_w), dtype=torch.float32, device="cpu")

            # 缩放遮罩（仅当遮罩存在且尺寸不匹配时）
            if mask.shape != (new_h, new_w) and not (mask.shape[0] == 0 and mask.shape[1] == 0):
                mask_pil = Image.fromarray((mask.numpy() * 255).astype(np.uint8))
                mask_pil = mask_pil.resize((new_w, new_h), Image.LANCZOS)
                mask = torch.from_numpy(np.array(mask_pil).astype(np.float32) / 255.0)

            output_images.append(image_tensor.to(dtype=dtype))
            output_masks.append(mask.unsqueeze(0).to(dtype=dtype))

            # MPO格式只处理第一帧
            if img.format == "MPO":
                break

        # 合并多帧图像
        if len(output_images) > 1:
            output_image = torch.cat(output_images, dim=0)
            output_mask = torch.cat(output_masks, dim=0)
        else:
            output_image = output_images[0]
            output_mask = output_masks[0]

        return (output_image, output_mask, w, h)

    @classmethod
    def IS_CHANGED(s, image, 尺寸, 模式=True):
        """检测文件是否变化 - 包含所有输入参数以确保正确缓存"""
        image_path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(image_path, 'rb') as f:
            m.update(f.read())
        # 将尺寸和模式参数也纳入哈希计算，确保参数变化时节点会重新执行
        m.update(f"{尺寸}_{模式}".encode('utf-8'))
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, image, 尺寸, 模式=True):
        """验证输入 - 包含所有必填参数以确保正确验证"""
        if not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)
        return True
