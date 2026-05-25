# -*- coding: utf-8 -*-
"""
🐳 WP llama — 图像/视频/文本推理节点
所有推理逻辑从原 comfyUI-qwen3_5-llama-TE 节点 1:1 复刻。
"""
import numpy as np

from .llama_loader_node import (
    _WpLlamaStorage,
    _call_chat_completion,
    _clean_think_block_text,
    _reset_llm_inference_state,
    _batch_image_index_to_base64,
    _normalize_random_seed,
    DEFAULT_IMAGE_PROMPT,
    DEFAULT_IMAGE_SYSTEM_PROMPT,
    DEFAULT_TEXT_SYSTEM_PROMPT,
)

import comfy.model_management as mm


class WpLlamaInference:
    """🐳 WP llama — 图像/视频/文本推理节点。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "qwen模型": ("QWENLLAMA",),
                "输入模式": (["图片", "逐帧", "视频", "文本"], {"default": "图片", "tooltip": "图片=只读第1张；逐帧=一张一张推理；视频=抽帧后一次性推理；文本=仅文字输入，无需图片。"}),
                "提示词": ("STRING", {"default": DEFAULT_IMAGE_PROMPT, "multiline": True}),
                "系统提示词": ("STRING", {"default": DEFAULT_IMAGE_SYSTEM_PROMPT, "multiline": True}),
                "最多帧数": ("INT", {"default": 24, "min": 2, "max": 1024, "step": 1, "tooltip": "视频模式下从输入图片序列中均匀抽取的帧数。"}),
                "最大边长": ("INT", {"default": 512, "min": 128, "max": 16384, "step": 64, "tooltip": "对输入图片做缩放以提速（取最长边）。"}),
                "最大生成token": ("INT", {"default": 1024, "min": 20, "max": 8192, "step": 1}),
                "温度": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 20, "min": 0, "max": 200, "step": 1}),
                "重复惩罚": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.01}),
                "频率惩罚": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "存在惩罚": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "step": 1, "control_after_generate": True, "tooltip": "随机种子。可用 ComfyUI 的生成后控制来固定、递增、递减或随机。"}),
                "输出think块": ("BOOLEAN", {"default": True, "tooltip": "开启=保留模型原始思考过程输出；关闭=仅在最终结果里移除 think 块。"}),
            },
            "optional": {
                "图片": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "run"
    CATEGORY = "🐳 WP_Node"

    def run(
        self,
        qwen模型,
        输入模式,
        提示词,
        系统提示词,
        最多帧数,
        最大边长,
        最大生成token,
        温度,
        top_p,
        top_k,
        重复惩罚,
        频率惩罚,
        存在惩罚,
        seed,
        输出think块,
        图片=None,
    ):
        # 卸载后 / 引用失效时：自动重载与同步到当前有效模型
        need_reload = False
        if _WpLlamaStorage.model is None:
            need_reload = True
        elif qwen模型 is not _WpLlamaStorage.model:
            if hasattr(qwen模型, "settings") and getattr(qwen模型, "settings") == _WpLlamaStorage.model.settings:
                qwen模型 = _WpLlamaStorage.model
            else:
                need_reload = True

        if need_reload:
            if not hasattr(qwen模型, "settings"):
                raise RuntimeError("输入的模型对象缺少配置信息，无法自动重载。请先运行「🐳 WP 模型加载器」。")
            _WpLlamaStorage.load(qwen模型.settings)
            qwen模型 = _WpLlamaStorage.model

        if not hasattr(qwen模型, "llm") or qwen模型.llm is None:
            raise RuntimeError("模型对象内部 llm 实例无效，请检查模型文件完整性，或重新加载模型。")

        llm = qwen模型.llm

        messages = []
        system_text = (系统提示词 or "").strip()

        if 输入模式 == "文本":
            if not system_text or system_text == DEFAULT_IMAGE_SYSTEM_PROMPT:
                system_text = DEFAULT_TEXT_SYSTEM_PROMPT
        elif 输入模式 == "视频" and system_text:
            system_text = "请将输入的图片序列当做视频而不是静态帧序列, " + system_text

        if system_text:
            messages.append({"role": "system", "content": system_text})

        total_images = int(图片.shape[0]) if 图片 is not None else 0
        if 输入模式 in ("图片", "逐帧", "视频") and total_images == 0:
            raise ValueError("未检测到图片输入。")

        if 输入模式 == "图片":
            frame_indices = [0]
        elif 输入模式 == "逐帧":
            frame_indices = list(range(total_images))
        elif 输入模式 == "视频":
            if total_images == 1:
                frame_indices = [0]
            else:
                count = min(max(int(最多帧数), 2), total_images)
                frame_indices = np.linspace(0, total_images - 1, count, dtype=int).tolist()
        elif 输入模式 == "文本":
            frame_indices = []
        else:
            raise ValueError(f"未知输入模式：{输入模式}")

        params = {
            "max_tokens": int(最大生成token),
            "temperature": float(温度),
            "top_p": float(top_p),
            "top_k": int(top_k),
            "repeat_penalty": float(重复惩罚),
            "frequency_penalty": float(频率惩罚),
            "presence_penalty": float(存在惩罚),
            "seed": _normalize_random_seed(seed),
            "stream": False,
            "stop": ["</s>"],
        }

        prompt_text = (提示词 or "").strip()
        if 输入模式 == "文本":
            if not prompt_text:
                raise ValueError("文本模式下，提示词不能为空。")

            messages.append({"role": "user", "content": prompt_text})
            _reset_llm_inference_state(llm)
            out = _call_chat_completion(llm, messages=messages, params=params)
            try:
                text = out["choices"][0]["message"]["content"]
            except Exception:
                text = str(out)
        elif 输入模式 == "逐帧":
            user_content = [{"type": "text", "text": prompt_text}, {"type": "image_url", "image_url": {"url": ""}}]
            messages.append({"role": "user", "content": user_content})

            out_parts = []
            for idx, frame_index in enumerate(frame_indices):
                if mm.processing_interrupted():
                    raise mm.InterruptProcessingException()
                img_b64 = _batch_image_index_to_base64(图片, frame_index, int(最大边长))
                if not img_b64:
                    continue
                user_content[1]["image_url"]["url"] = f"data:image/jpeg;base64,{img_b64}"
                _reset_llm_inference_state(llm)
                out = _call_chat_completion(llm, messages=messages, params=params)
                try:
                    part = out["choices"][0]["message"]["content"]
                except Exception:
                    part = str(out)
                if len(frame_indices) > 1:
                    out_parts.append(f"====== 第{idx+1}帧 ======\n{part}".strip())
                else:
                    out_parts.append(str(part).strip())
            text = "\n\n".join([p for p in out_parts if p])
        else:
            user_content = [{"type": "text", "text": prompt_text}]
            for frame_index in frame_indices:
                img_b64 = _batch_image_index_to_base64(图片, frame_index, int(最大边长))
                if not img_b64:
                    continue
                user_content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}})
            messages.append({"role": "user", "content": user_content})
            _reset_llm_inference_state(llm)
            out = _call_chat_completion(llm, messages=messages, params=params)
            try:
                text = out["choices"][0]["message"]["content"]
            except Exception:
                text = str(out)

        if not bool(输出think块):
            text = _clean_think_block_text(text)

        if mm.processing_interrupted():
            raise mm.InterruptProcessingException()

        return (text.lstrip().removeprefix(": ").strip(),)
