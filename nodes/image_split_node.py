"""
🐳 自动分割图像节点
功能：将大图均匀分割为网格小图，支持可选自动保存、移除画布边缘和移除描边
"""
import os
import numpy as np
import torch
from PIL import Image

import folder_paths


class ImageSplitNode:
    """
    🐳 自动分割图像节点
    
    将单张或批量输入的大图，按照用户指定的水平和垂直张数，
    均匀分割为N×M网格的小图。
    
    特色功能：
    1. 网格均匀分割：支持任意N×M网格分割
    2. 批量处理：支持单张或批量图像输入
    3. 自动裁剪：移除描边、移除画布边缘
    4. 可选保存：可保存到本地，也可仅输出给下游节点
    5. 多格式支持：PNG/JPG/WEBP
    """
    
    # ========== 节点元数据 ==========
    
    # 节点在ComfyUI中的分类
    CATEGORY = "🐳 WP_Node"

    # 输出端口的数据类型，这里是图像批量
    RETURN_TYPES = ("IMAGE",)

    # 输出端口的显示名称
    RETURN_NAMES = ("分割图像",)

    # 节点执行时调用的方法名
    FUNCTION = "split_image"

    # 标记这是一个输出节点
    OUTPUT_NODE = True
    
    @classmethod
    def INPUT_TYPES(cls):
        """
        定义节点的输入控件
        
        返回一个字典，描述所有输入参数的类型和选项
        """
        # 保存格式选项
        save_formats = ["PNG", "JPG", "WEBP"]
        
        return {
            "required": {
                # 输入图像端口
                "图像": ("IMAGE",),
                
                # 开关：控制是否保存到本地
                # True = 保存到本地并输出，False = 仅输出给下游
                "保存到本地": ("BOOLEAN", {
                    "default": True,
                    "label_on": "开启",
                    "label_off": "关闭",
                }),
                
                # 保存目录输入框
                # 仅在"保存到本地"开启时有效
                "保存目录": ("STRING", {
                    "default": "output",
                }),
                
                # 水平张数：水平方向分割的列数
                "水平张数": ("INT", {
                    "default": 2,
                    "min": 1,
                    "max": 16,
                    "step": 1,
                }),
                
                # 垂直张数：垂直方向分割的行数
                "垂直张数": ("INT", {
                    "default": 2,
                    "min": 1,
                    "max": 16,
                    "step": 1,
                }),
                
                # 开关：是否移除画布边缘（透明区域）
                # 仅对带alpha通道的PNG图像有效
                "移除画布边缘": ("BOOLEAN", {
                    "default": True,
                    "label_on": "开启",
                    "label_off": "关闭",
                }),
                
                # 移除描边：从四周统一裁剪的像素数
                "移除描边": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 100,
                    "step": 1,
                }),
                
                # 文件名前缀
                "文件名前缀": ("STRING", {
                    "default": "图像分割_",
                }),
                
                # 保存格式下拉选择
                "保存格式": (save_formats, {
                    "default": "PNG",
                }),
            }
        }
    
    def split_image(self, 图像, 保存到本地, 保存目录, 水平张数, 垂直张数, 
                    移除画布边缘, 移除描边, 文件名前缀, 保存格式):
        """
        核心处理方法：分割图像为网格小图
        
        参数说明：
            图像: 输入图像张量，形状为 (B, H, W, C)
            保存到本地: 布尔值，是否保存文件
            保存目录: 字符串，保存路径
            水平张数: 整数，水平分割列数
            垂直张数: 整数，垂直分割行数
            移除画布边缘: 布尔值，是否裁剪透明边缘
            移除描边: 整数，四周裁剪像素数
            文件名前缀: 字符串，文件名前缀
            保存格式: 字符串，PNG/JPG/WEBP
        
        返回：
            (分割图像,): 元组，包含所有小图组成的批量图像张量
        """
        
        # ========== 第一步：获取输入图像的信息 ==========
        
        # 获取图像张量的形状
        # batch_size: 批量中的图像数量
        # h: 图像高度
        # w: 图像宽度
        # c: 通道数（3=RGB, 4=RGBA）
        batch_size, h, w, c = 图像.shape
        
        # 创建一个列表，用于存储所有分割后的小图
        result_tiles = []
        
        # ========== 第二步：处理保存目录 ==========
        
        # 仅在开启保存时，才需要处理目录
        if 保存到本地:
            # 如果保存目录是 "output"，使用ComfyUI默认的output目录
            if 保存目录 == "output":
                save_dir = folder_paths.get_output_directory()
            elif os.path.isabs(保存目录):
                # 绝对路径直接使用
                save_dir = 保存目录
            else:
                # 相对路径：相对于ComfyUI的输出目录
                save_dir = os.path.join(folder_paths.get_output_directory(), 保存目录)
            
            # 创建目录（如果不存在）
            # exist_ok=True 表示如果目录已存在，不会报错
            os.makedirs(save_dir, exist_ok=True)
            
            print(f"[自动分割图像] 保存目录: {save_dir}")
        
        # ========== 第三步：遍历批量中的每张图像 ==========
        
        for batch_idx in range(batch_size):
            # 取出当前图像（从张量转换为numpy数组）
            # ComfyUI的图像格式是 (H, W, C)，值范围是 0~1 的浮点数
            img = 图像[batch_idx].cpu().numpy()
            
            # 计算每张小图的尺寸
            # 使用向下取整（//），丢弃最后不足的像素行/列
            tile_w = w // 水平张数
            tile_h = h // 垂直张数
            
            print(f"[自动分割图像] 处理第 {batch_idx + 1}/{batch_size} 张图像，"
                  f"原图尺寸: {w}×{h}，分割后单张尺寸: {tile_w}×{tile_h}")
            
            # ========== 第四步：网格遍历分割 ==========
            
            # 按行遍历（垂直方向）
            for row in range(垂直张数):
                # 按列遍历（水平方向）
                for col in range(水平张数):
                    
                    # 计算当前小图的裁剪区域坐标
                    # y1, y2: 垂直方向的起始和结束像素
                    # x1, x2: 水平方向的起始和结束像素
                    y1 = row * tile_h
                    y2 = (row + 1) * tile_h
                    x1 = col * tile_w
                    x2 = (col + 1) * tile_w
                    
                    # 从原图中裁剪出当前小图
                    # numpy数组切片语法：[y起始:y结束, x起始:x结束, 所有通道]
                    tile = img[y1:y2, x1:x2, :].copy()
                    
                    # ========== 第五步：移除描边 ==========
                    
                    # 如果设置了移除描边像素数（大于0）
                    if 移除描边 > 0:
                        b = 移除描边
                        # 从四周裁剪 b 个像素
                        # 语法 [b:-b] 表示从第b个像素到倒数第b个像素
                        # 注意：如果小图太小，需要检查边界
                        if tile.shape[0] > 2 * b and tile.shape[1] > 2 * b:
                            tile = tile[b:-b, b:-b, :]
                    
                    # ========== 第六步：移除画布边缘 ==========
                    
                    # 仅在开启此功能且图像是4通道（RGBA）时执行
                    if 移除画布边缘 and tile.shape[2] == 4:
                        # 获取alpha通道（第4个通道，索引为3）
                        alpha = tile[:, :, 3]
                        
                        # 检查是否存在非透明区域
                        # alpha > 0 表示不透明或半透明像素
                        if alpha.sum() > 0:
                            # 找到所有非透明像素的坐标
                            # np.nonzero 返回非零元素的索引
                            y_nonzero, x_nonzero = np.nonzero(alpha > 0)
                            
                            # 计算非透明区域的边界
                            y_min = np.min(y_nonzero)
                            y_max = np.max(y_nonzero) + 1
                            x_min = np.min(x_nonzero)
                            x_max = np.max(x_nonzero) + 1
                            
                            # 裁剪到非透明区域
                            tile = tile[y_min:y_max, x_min:x_max, :]
                    
                    # ========== 第七步：保存到本地（如果开启） ==========
                    
                    if 保存到本地:
                        # 构建文件名：前缀 + 批次号 + 行号 + 列号
                        filename = f"{文件名前缀}{batch_idx}_{row}_{col}.{保存格式.lower()}"
                        save_path = os.path.join(save_dir, filename)
                        
                        # 调用保存方法
                        self._save_tile(tile, save_path, 保存格式)
                    
                    # ========== 第八步：添加到结果列表 ==========
                    
                    # 将numpy数组转换回torch张量
                    # 无论是否保存到本地，都要添加到结果中
                    tile_tensor = torch.from_numpy(tile)
                    result_tiles.append(tile_tensor)
        
        # ========== 第九步：合并所有小图并返回 ==========
        
        # 使用 torch.stack 将所有小图堆叠成一个批量张量
        # dim=0 表示在第0维（batch维度）堆叠
        output_batch = torch.stack(result_tiles, dim=0)
        
        print(f"[自动分割图像] 分割完成，共生成 {len(result_tiles)} 张小图")
        
        # 返回元组（ComfyUI要求）
        return (output_batch,)
    
    def _save_tile(self, tile, save_path, format):
        """
        保存单张小图到本地
        
        参数说明：
            tile: numpy数组，形状为 (H, W, C)，值范围 0~1
            save_path: 完整的保存路径
            format: 保存格式字符串（PNG/JPG/WEBP）
        """
        
        # 将浮点数图像（0~1）转换为整数图像（0~255）
        # astype(np.uint8) 转换为8位无符号整数
        tile_uint8 = (tile * 255).astype(np.uint8)
        
        # 处理JPG格式（不支持alpha通道）
        if format == "JPG":
            # 如果图像有4个通道（RGBA），只取前3个通道（RGB）
            if tile_uint8.shape[2] == 4:
                tile_uint8 = tile_uint8[:, :, :3]
            
            # 创建PIL图像对象
            img = Image.fromarray(tile_uint8, mode='RGB')
            # 保存为JPG，质量95
            img.save(save_path, "JPEG", quality=95)
        
        # 处理PNG格式
        elif format == "PNG":
            if tile_uint8.shape[2] == 4:
                img = Image.fromarray(tile_uint8, mode='RGBA')
            else:
                img = Image.fromarray(tile_uint8, mode='RGB')
            img.save(save_path, "PNG")
        
        # 处理WEBP格式
        elif format == "WEBP":
            if tile_uint8.shape[2] == 4:
                img = Image.fromarray(tile_uint8, mode='RGBA')
            else:
                img = Image.fromarray(tile_uint8, mode='RGB')
            img.save(save_path, "WEBP", quality=95)
        
        print(f"[自动分割图像] 已保存: {save_path}")
    
    @classmethod
    def IS_CHANGED(cls, 图像, 保存到本地, 保存目录, 水平张数, 垂直张数, 
                   移除画布边缘, 移除描边, 文件名前缀, 保存格式):
        """
        检测节点的输入是否发生变化
        
        ComfyUI使用这个方法来决定是否需要重新执行节点
        返回一个能唯一标识当前状态的值
        
        注意：图像张量本身不参与哈希计算（太大），
        而是依赖其他参数来判断是否需要重新执行
        """
        # 将所有参数组合成一个字符串作为标识
        # 注意：图像张量太大，不参与计算
        return f"{保存到本地}_{保存目录}_{水平张数}_{垂直张数}_" \
               f"{移除画布边缘}_{移除描边}_{文件名前缀}_{保存格式}"
