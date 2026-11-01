# -*- coding: utf-8 -*-
"""
🐳 WP 提示词优化 — 单次执行式提示词优化节点

【设计说明】
与「🐳 WP 提示词对话」共用同一套技能目录（nodes/skills/）与推理通道
（本地 QWENLLAMA 模型优先，未连接时走「API配置」里的云端 API），
但去掉全部对话交互：没有聊天框、没有多轮历史、没有流式推送。

使用方式：左侧「提示词输入」框直接输入待优化内容（前端弹性面板，输入框随节点
尺寸自适应、底部工具栏固定停靠节点最底部），画布运行时一次性调用所选技能完成
优化，结果从「优化结果」端口输出，可直接连下游（如 CLIP 文本编码、🐳 WP 文本框）。

【技能机制】（与提示词对话节点完全一致，逻辑复用不复制）
- 技能文件放在 nodes/skills/，目录变化自动热重载，增删改技能无需重启。
- 输入开头可用 /快捷指令 临时切换技能（如 "/h3 一只猫在雨中奔跑"），
  指令优先级高于节点下拉框；未命中时在结果开头给出提示。
- /help 指令：直接返回技能清单，不消耗模型推理。
- 两步式轻量 agent：技能带多份参考文件时，先做一次小推理按"本轮请求 +
  附图张数"精选参考文件，再做主推理；本地模型适用，API 模式直接全量加载。
- 支持 10 个可选图片输入端口，统一尺寸合并后随本轮消息发给视觉模型。
"""
import torch

from .推理模型加载器节点 import (
    _WpLlamaStorage,
    _call_chat_completion,
    _clean_think_block_text,
    _reset_llm_inference_state,
    _batch_image_index_to_base64,
    _wp_log,
)

from .提示词对话节点 import (
    DEFAULT_SKILL,
    DEFAULT_SYSTEM_PROMPT,
    _HELP_COMMANDS,
    _ONLY_CONTENT_NOTE,
    _USER_MODE_PRIORITY_NOTE,
    _call_api_chat,
    _get_skills,
    _image_to_base64_jpeg,
    _input_fact_note,
    _match_skill,
    _parse_api_config,
    _parse_command,
    _pick_references,
    _skill_list,
    _skills_help_reply,
)

import comfy.model_management as mm


class WpPromptOptimizer:
    """🐳 WP 提示词优化 — 输入文本（或连线），运行时直接调用技能输出优化结果。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "使用技能": (_skill_list(), {"default": DEFAULT_SKILL, "tooltip": "运行时应用的技能；用输入开头的 /技能名 指令可临时覆盖。"}),
                "最大生成token": ("INT", {"default": 2048, "min": 20, "max": 8192, "step": 1}),
                "温度": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 20, "min": 0, "max": 200, "step": 1}),
                "重复惩罚": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.01}),
                "输出think块": ("BOOLEAN", {"default": False, "tooltip": "开启=保留模型原始思考过程输出。"}),
                "仅输出内容": ("BOOLEAN", {"default": False, "tooltip": "开启=结果只输出提示词/最终内容本身，不带任何解释、分析或寒暄。"}),
                "API配置": ("STRING", {"default": "", "multiline": True, "tooltip": 'API 模式配置（JSON）：{"api_url": "...", "api_key": "...", "model": "..."}；未连接本地模型时启用。'}),
                "卸载模型": ("BOOLEAN", {"default": False, "tooltip": "开启后每次本地推理完成自动卸载模型释放显存（下次运行需重新加载，耗时较长）；仅本地模型模式有效。"}),
                "图像数量": ("INT", {"default": 3, "min": 1, "max": 10, "step": 1, "tooltip": "图片输入端口数量（1-10）；由前端「设置」弹窗维护。"}),
                # 「提示词输入」必须放在 widget 列表末尾——ComfyUI 按 widget 顺序存取
                # 工作流值数组；它带同名可选输入端口（widget-input 机制），前端把它
                # 转成输入端口时值数组会少一格，放在中间会导致其余 widget 值整体错位
                # （如温度拿到 token 值报"超出范围"）。放末位错位只影响它自身，无副作用。
                "提示词输入": ("STRING", {"default": "", "multiline": True, "tooltip": "待优化的提示词内容；开头可用 /技能名 指令临时切换技能。左侧端口可接文本连线，接入后优先使用连线内容。"}),
            },
            "optional": {
                "qwen模型": ("QWENLLAMA", {"tooltip": "本地模型（连接时优先使用）；不连接则走「API配置」。"}),
                # 同名可选输入（ComfyUI 原生 widget-input 机制）：让「提示词输入」
                # 输入框像原生节点一样可接文本连线——连线时后端收到连线内容，
                # 未连线时收到输入框内容，参数名相同、后端无需区分来源
                "提示词输入": ("STRING", {"forceInput": True, "tooltip": "文本连线：接入后优先使用连线内容，输入框内容被忽略。"}),
                **{f"图片{i}": ("IMAGE",) for i in range(1, 11)},
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("优化结果",)
    FUNCTION = "run"
    CATEGORY = "🐳 WP_Node"

    @classmethod
    def IS_CHANGED(cls, 卸载模型=False, **kwargs):
        """「卸载模型」开启时声明本节点不可缓存，防止执行缓存跳过导致显存不释放。"""
        if bool(卸载模型):
            return float("NaN")
        return ""

    def run(
        self,
        使用技能,
        提示词输入,
        最大生成token,
        温度,
        top_p,
        top_k,
        重复惩罚,
        输出think块,
        仅输出内容,
        API配置,
        卸载模型,
        图像数量,  # 前端「设置」弹窗维护的端口数量存档位，后端不消费（图片口固定声明 10 个）
        qwen模型=None,
        图片1=None,
        图片2=None,
        图片3=None,
        图片4=None,
        图片5=None,
        图片6=None,
        图片7=None,
        图片8=None,
        图片9=None,
        图片10=None,
    ):
        t_total = _wp_log("==== 提示词优化节点 run 开始 ====")

        # ---- 文本来源：左侧「提示词输入」框（值由前端弹性面板同步写入 widget） ----
        raw_text = str(提示词输入 or "").strip()

        # ---- 推理后端选择：连接本地模型优先；未连接则用「API配置」 ----
        api_cfg = _parse_api_config(API配置)
        if qwen模型 is None and not api_cfg:
            raise RuntimeError("未连接本地模型，且 API 配置无效。请把「qwen模型」端口连到 🐳 WP 模型加载器，或在「API配置」里填写完整的 API 配置 JSON。")

        # ---- 合并多图，统一尺寸（RGBA 白底合成，与对话节点同口径） ----
        all_images = [img for img in (图片1, 图片2, 图片3, 图片4, 图片5, 图片6, 图片7, 图片8, 图片9, 图片10) if img is not None]
        图片 = None
        if all_images:
            import torch.nn.functional as F
            target_h, target_w = all_images[0].shape[1], all_images[0].shape[2]
            resized = []
            for img in all_images:
                if img.shape[3] == 4:
                    img = img[..., :3] * img[..., 3:4] + (1.0 - img[..., 3:4])
                if img.shape[1] != target_h or img.shape[2] != target_w:
                    img = img.permute(0, 3, 1, 2)
                    img = F.interpolate(img, size=(target_h, target_w), mode="bilinear", align_corners=False)
                    img = img.permute(0, 2, 3, 1)
                resized.append(img)
            图片 = torch.cat(resized, dim=0)
            _wp_log(f"合并图片完成，共 {int(图片.shape[0])} 张")
        total_images = int(图片.shape[0]) if 图片 is not None else 0

        # ---- 解析技能（支持热重载；输入开头 /指令 优先于下拉框） ----
        skills, aliases, replace_systems, refs = _get_skills()
        cmd, user_text = _parse_command(raw_text)

        # 内置帮助指令：直接返回技能清单，不调用模型
        if cmd in _HELP_COMMANDS:
            self._unload_if_enabled(qwen模型, 卸载模型)
            _wp_log("==== 提示词优化节点 run 总耗时 ====", t_total)
            return (_skills_help_reply(skills, aliases),)

        # 空输入静默跳过：不推理也不报错，输出空字符串保证下游不断供
        if not user_text:
            _wp_log("输入为空，静默跳过本轮执行")
            self._unload_if_enabled(qwen模型, 卸载模型)
            _wp_log("==== 提示词优化节点 run 总耗时 ====", t_total)
            return ("",)

        # ---- 模型引用失效保护（复用推理节点的重载逻辑） ----
        llm = None
        if qwen模型 is not None:
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
                raise RuntimeError("模型对象内部 llm 实例无效，请重新加载模型。")

            llm = qwen模型.llm

        skill = None
        skill_hint = ""
        if cmd:
            skill, ambiguous = _match_skill(cmd, skills, aliases)
            if skill is None:
                if ambiguous:
                    skill_hint = f"⚠️ 指令「/{cmd}」同时命中多个技能：{'、'.join(ambiguous)}。请输入更完整的前缀，或直接用节点下拉框选择。\n\n"
                else:
                    available = "、".join(f"/{a}" for a in sorted(aliases)) or "（无，请用节点下拉框选择）"
                    skill_hint = f"⚠️ 未找到技能「/{cmd}」，本轮已按默认设置处理。可用快捷指令：{available}\n\n"
        if skill is None:
            if 使用技能 == "无" or 使用技能 in skills:
                skill = 使用技能
            else:
                # 旧名称兼容：曾用显示名已注册为别名，仍可解析
                skill, _amb = _match_skill(str(使用技能), skills, aliases)
                if skill is None:
                    skill = DEFAULT_SKILL

        # ---- 系统提示词组装：稳定段在前、变化段在后（与对话节点同口径，
        # 但不注入对话规则与技能清单——本节点单次执行，无多轮上下文） ----
        system_text = "" if skill == "无" else DEFAULT_SYSTEM_PROMPT
        if skill != "无" and skills.get(skill):
            if replace_systems.get(skill):
                system_text = skills[skill]
            else:
                system_text = system_text + "\n\n" + skills[skill]
            # 轻量 agent 第一步：技能带多份参考文件时先精选，避免全量塞入；
            # API 模式下云端大模型理解力强，直接全量加载
            skill_refs = refs.get(skill) or []
            if llm is not None and len(skill_refs) > 1:
                t_pick = _wp_log("参考文件精选（agent 第一步）")
                _reset_llm_inference_state(llm)
                skill_refs = _pick_references(llm, user_text, total_images, skill_refs)
                _wp_log(f"入选参考文件：{[r['file'] for r in skill_refs]}")
                _wp_log("参考文件精选（agent 第一步）", t_pick)
            for r in skill_refs:
                system_text += f"\n\n----- 以下是参考文件 {r['file']} 的内容 -----\n{r['content']}"
        # [稳定] 用户声明的模式/图片用途优先级最高
        if skill != "无":
            system_text = system_text + "\n\n" + _USER_MODE_PRIORITY_NOTE
        # [变化] 本轮输入事实（附图数量）
        if skill != "无" or total_images > 0:
            system_text = system_text + ("\n\n" if system_text else "") + _input_fact_note(total_images)
        # [变化] 仅输出内容模式：用户显式开关，放最尾强化执行
        if bool(仅输出内容):
            system_text = system_text + ("\n\n" if system_text else "") + _ONLY_CONTENT_NOTE

        # ---- 消息组装：系统提示词（可为空）+ 本轮用户消息（文本 + 可选图片） ----
        messages = []
        if system_text.strip():
            messages.append({"role": "system", "content": system_text})

        if total_images > 0:
            user_content = [{"type": "text", "text": user_text}]
            for i in range(total_images):
                if llm is not None:
                    img_b64, mime = _batch_image_index_to_base64(图片, i, 512), "jpeg"
                else:
                    img_b64, mime = _image_to_base64_jpeg(图片, i), "jpeg"
                if img_b64:
                    user_content.append({"type": "image_url", "image_url": {"url": f"data:image/{mime};base64,{img_b64}"}})
            messages.append({"role": "user", "content": user_content})
        else:
            messages.append({"role": "user", "content": user_text})

        if llm is not None:
            # ---- 本地模型：单次非流式推理（无前端聊天面板，不需要逐 token 推送） ----
            params = {
                "max_tokens": int(最大生成token),
                "temperature": float(温度),
                "top_p": float(top_p),
                "top_k": int(top_k),
                "repeat_penalty": float(重复惩罚),
                "stream": False,
                "stop": ["</s>"],
            }

            t_reset = _wp_log("重置推理状态")
            _reset_llm_inference_state(llm)
            _wp_log("重置推理状态", t_reset)

            t_call = _wp_log("模型推理")
            resp = _call_chat_completion(llm, messages=messages, params=params)
            try:
                text = str(resp["choices"][0]["message"].get("content") or "")
            except (KeyError, IndexError, TypeError, AttributeError):
                raise RuntimeError(f"解析本地模型响应失败。返回片段：{str(resp)[:300]}")
            _wp_log("模型推理", t_call)
        else:
            # ---- API 模式：无前端会话，不传 sid（后端不推送流式 token） ----
            t_call = _wp_log("API 推理")
            text = _call_api_chat(api_cfg, messages, 温度, top_p)
            _wp_log("API 推理", t_call)

        if not bool(输出think块):
            text = _clean_think_block_text(text)

        # 「卸载模型」开关：本地推理完成后立即卸载释放显存
        if llm is not None and bool(卸载模型):
            t_unload = _wp_log("「卸载模型」开关触发 unload")
            _WpLlamaStorage.unload()
            _wp_log("「卸载模型」开关触发 unload", t_unload)

        if mm.processing_interrupted():
            raise mm.InterruptProcessingException()

        _wp_log("==== 提示词优化节点 run 总耗时 ====", t_total)
        result = skill_hint + text.lstrip().removeprefix(": ").strip()
        return (result,)

    @staticmethod
    def _unload_if_enabled(qwen模型, 卸载模型):
        """不推理的快速返回路径（帮助指令/空输入）顺手卸载：开关开 && 连了本地模型
        && 模型在显存 → 释放，保证整画布跑完显存干净"""
        if qwen模型 is not None and bool(卸载模型) and _WpLlamaStorage.model is not None:
            _WpLlamaStorage.unload()
            _wp_log("「卸载模型」开关触发 unload（本轮未推理，顺手释放显存）")


NODE_CLASS_MAPPINGS = {
    "WP_PromptOptimizer": WpPromptOptimizer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_PromptOptimizer": "🐳 WP 提示词优化",
}
