"""
🐳 WP_API 调用工具节点 - 调用外部兼容 OpenAI 协议的大模型 API 进行文本处理或图像分析
使用V1 API（传统方式）定义节点
"""
import json
import base64
import numpy as np
from PIL import Image
import io
import requests
import random


class WhaleAPINode:
    """
     WP_API 调用工具节点 - 调用外部兼容 OpenAI 协议的大模型 API

    魔搭社区兼容性说明：
    - 如需使用 ModelScope API，将 api_url 设为 https://api-inference.modelscope.cn/v1/chat/completions
    - api_key 来自魔搭个人中心的访问令牌（需绑定阿里云账号）
    - model 可填魔搭模型 id，如 Qwen/Qwen3-VL-235B-A22B-Instruct（视觉）或 deepseek-ai/DeepSeek-V3.1（文本）
    - 免费额度：每个模型每天 500 次，总 2000 次/天，请注意用量
    """

    CATEGORY = "🐳 WP_Node"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "process"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "image": ("IMAGE",),
                "image_2": ("IMAGE",),
                "image_3": ("IMAGE",),
            },
            "required": {
                "mode": (["图片", "文本"], {"default": "图片"}),
                "prompt_template": ("STRING", {"default": "请描述这张图片", "multiline": True}),
                "system_prompt": ("STRING", {"default": "你是一个有用的助手", "multiline": True}),
                "api_url": ("STRING", {"default": "https://api.openai.com/v1/chat/completions"}),
                "api_key": ("STRING", {"default": "", "password": True}),
                "model": ("STRING", {"default": "gpt-4o"}),
                "seed": ("INT", {"default": 1426415715, "min": 0, "max": 9999999999}),
                "max_tokens": ("INT", {"default": 3000, "min": 1, "max": 100000}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """每次都重新执行，不使用缓存"""
        return True

    @staticmethod
    def image_to_base64(image_tensor, max_size=2048):
        """
        将 ComfyUI 的 IMAGE 张量转换为 Base64 编码的 PNG 字符串。
        张量形状: [B, H, W, C]，数值范围 0-1
        
        参数:
            image_tensor: 输入的图像张量
            max_size: 最大边长限制，默认 2048 像素
        
        返回:
            Base64 编码的 PNG 字符串
        """
        # 取第一张图片，从GPU转到CPU，再转成numpy数组
        image_np = image_tensor[0].cpu().numpy()
        # 把0-1的浮点数转成0-255的整数（uint8是图片的标准格式）
        image_np = (image_np * 255).clip(0, 255).astype(np.uint8)
        # numpy数组转成PIL图片对象
        pil_image = Image.fromarray(image_np)
        
        # 检查图片尺寸是否超过限制，如果超过则自动缩放
        original_width, original_height = pil_image.size
        
        # 如果图片的任意一边超过 max_size，则进行缩放
        if original_width > max_size or original_height > max_size:
            # 计算缩放比例，保持宽高比
            scale = max_size / max(original_width, original_height)
            new_width = int(original_width * scale)
            new_height = int(original_height * scale)
            
            # 确保尺寸至少为 1
            new_width = max(1, new_width)
            new_height = max(1, new_height)
            
            # 缩放图片（使用高质量缩放）
            pil_image = pil_image.resize((new_width, new_height), Image.LANCZOS)
            
            print(f"[WP_API] 图片尺寸超过限制，自动缩放: {original_width}×{original_height} -> {new_width}×{new_height}")
        
        # 把图片保存到内存缓冲区（而不是硬盘），格式为PNG
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        buffer.seek(0)
        # 读取缓冲区内容，进行Base64编码，再转成字符串返回
        return base64.b64encode(buffer.read()).decode("utf-8")

    def process(
        self,
        mode,
        prompt_template,
        system_prompt,
        api_url,
        api_key,
        model,
        seed,
        max_tokens,
        image=None,
        image_2=None,
        image_3=None,
    ):
        try:
            # 限制种子值为10位数以内（最大9999999999）
            actual_seed = max(0, min(seed, 9999999999))

            # 构建用户消息内容
            if mode == "图片":
                # 图片模式：收集所有非空图片
                images = []
                if image is not None:
                    images.append(image)
                if image_2 is not None:
                    images.append(image_2)
                if image_3 is not None:
                    images.append(image_3)

                if len(images) > 0:
                    # 有多张图片，构建多模态消息
                    content = []
                    for img in images:
                        base64_str = self.image_to_base64(img)
                        content.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{base64_str}"
                            }
                        })
                    # 添加文本提示
                    content.append({
                        "type": "text",
                        "text": prompt_template
                    })
                else:
                    # 没有连接任何图片，仅发送文本
                    content = prompt_template
            else:
                # 文本模式：忽略所有图片
                content = prompt_template

            # 构建 messages 数组
            messages = []
            if system_prompt and system_prompt.strip():
                messages.append({
                    "role": "system",
                    "content": system_prompt
                })
            messages.append({
                "role": "user",
                "content": content
            })

            # 构建请求体
            body = {
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": 0.7,
            }
            if actual_seed != 0:
                body["seed"] = actual_seed

            # 发送请求
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            }

            response = requests.post(
                api_url,
                headers=headers,
                json=body,
                timeout=120
            )

            # 检查响应状态
            if response.status_code != 200:
                return (f"API 错误 (状态码: {response.status_code}): {response.text}",)

            # 解析响应
            result = response.json()

            # 检查是否有错误信息
            if "error" in result:
                error_msg = result["error"].get("message", str(result["error"]))
                return (f"API 返回错误: {error_msg}",)

            # 检查 choices 是否存在且非空
            if "choices" not in result or result["choices"] is None or len(result["choices"]) == 0:
                return (f"API 返回异常: choices 字段为空 (None 或空列表)。可能原因：1) API Key 无效 2) 模型不支持 3) 请求参数有误。完整返回: {str(result)}",)

            # 安全提取文本
            try:
                text_result = result["choices"][0]["message"]["content"]
                return (text_result,)
            except (KeyError, IndexError, TypeError) as e:
                return (f"解析 API 响应失败: {str(e)}。返回内容: {str(result)[:500]}",)

        except requests.exceptions.RequestException as e:
            return (f"网络请求错误: {str(e)}",)
        except Exception as e:
            return (f"发生错误: {str(e)}",)
