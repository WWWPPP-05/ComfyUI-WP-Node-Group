# -*- coding: utf-8 -*-
"""
🐳 WP PSD 图层规划 — PSD 拆解管线第①站：VLM 语义拆层
复用 WP_LlamaLoader 的本地 VLM（Qwen3.5-VL），把原图规划为 PSD 图层方案
JSON（图层名/类型/z序/英文描述/bbox），并输出 bbox 彩框预览图。
配方来自 PoC-2 v3 验证结论。
未连接本地模型时走 API 模式（OpenAI 兼容协议，复用提示词对话节点实现）；
「卸载模型」开启时本地推理完成后自动释放显存。
"""
import json
import re

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from .推理模型加载器节点 import (
    _WpLlamaStorage,
    _call_chat_completion,
    _reset_llm_inference_state,
    _batch_image_index_to_base64,
    _normalize_random_seed,
    _wp_log,
)
from .提示词对话节点 import _parse_api_config, _call_api_chat, _image_to_base64_jpeg

SYSTEM_PROMPT = (
    "你是资深平面设计师，擅长把海报设计稿拆解为 Photoshop 图层结构。"
    "你只输出严格合法的 JSON，不输出任何解释文字。"
)

_BBOX_COLORS = [
    (255, 0, 0), (0, 180, 0), (0, 90, 255), (255, 140, 0),
    (160, 0, 255), (0, 200, 200), (200, 0, 120),
]


_GRANULARITY_PRESETS = {
    "简单": {
        "lo": 2, "hi": 5,
        "rule": "只拆分大的视觉区块：背景合并为一层，人物/产品主体合并为一整层，大块文字可合并为一层。不要拆出细节元素（如五官、服饰部件、单件家具、小装饰品）。",
    },
    "详细": {
        "lo": 5, "hi": 12,
        "rule": "把每个独立物体拆为一层：人物/产品主体一整层，每件明显的家具/物品各一层，每组语义完整的文字一层，装饰图形/二维码/Logo 各一层。主体不拆部件。",
    },
    "复杂": {
        "lo": 10, "hi": 20,
        "rule": "细粒度拆分：主体可以拆成组成部件（如发型、上装、下装、手持物品各一层），每件家具/物品单独一层，每组文字单独一层，装饰元素按单元拆分。",
    },
}


def _build_user_prompt(granularity: str, extra_note: str) -> str:
    preset = _GRANULARITY_PRESETS.get(granularity, _GRANULARITY_PRESETS["详细"])
    prompt = f"""请把这张图片拆解为可编辑的 PSD 图层方案。

输出严格 JSON（禁止 markdown 代码块、禁止任何解释文字），格式：
{{"layers":[{{"layer_name":"中文图层名","layer_type":"背景|主体|前景|文字|装饰|标志","z_index":0,"description":"English description for AI inpainting","concept_words":["english words"],"bbox":[x,y,w,h]}}]}}

bbox 格式（必须严格遵守）：[左上角x, 左上角y, 宽, 高]
示例1：元素在画面左上角约1/4区域，则 bbox=[0, 0, 250, 250]
示例2：二维码在右下角，占画面宽15%，则 bbox=[830, 830, 150, 150]
注意：第3、4个数字是宽度和高度，不是右下角坐标。整幅图坐标范围是 0~1000。

规则：
1. 拆分粒度：{preset["rule"]}
2. 尽量拆出 {preset["lo"]}~{preset["hi"]} 个图层，但以图中实际存在的元素为准，不要为凑数拆出不存在的元素
3. 只拆解图中实际存在的元素：背景、人物/产品主体、每组语义完整的文字块、装饰图形、二维码/Logo；图中没有的元素不要创建
4. 文字按语义分组（如主标题一组、时间信息一组），不要按单行拆
5. z_index 小的在底层，必须反映真实遮挡关系（人物在背景之上、文字在装饰之上）
6. description 用英文，详细描述内容/颜色/质感/光照，供后续 AI 重绘使用
7. concept_words：每层 2~4 个简短英文概念词（如 woman、qr code、text、logo、banner），供检测分割模型使用"""
    note = (extra_note or "").strip()
    if note:
        prompt += f"\n8. 附加要求：{note}"
    return prompt


def _clean_and_parse_json(text: str) -> dict:
    t = re.sub(r"<think\b[^>]*>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)
    t = re.sub(r"^.*?</think>\s*", "", t, count=1, flags=re.DOTALL | re.IGNORECASE)
    # 未闭合 think 块说明生成被截断，直接报错触发重试
    if re.search(r"<think\b[^>]*>", t, flags=re.IGNORECASE):
        raise ValueError("think 块未闭合，输出被截断")
    t = t.replace("<think>", "").replace("</think>", "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t.strip(), flags=re.MULTILINE)
    m = re.search(r"\{.*\}", t, flags=re.DOTALL)
    if not m:
        raise ValueError(f"输出中找不到 JSON：{t[:200]}")
    return json.loads(m.group(0))


def _salvage_layers_from_raw(text: str):
    """标准解析失败后的残骸抢救：从原始输出中逐层提取已写完整的图层对象。
    坏尾部丢弃，保留完整前缀层（哪怕只救回 1 层也比全盘失败好）。"""
    m = re.search(r'"layers"\s*:\s*\[', text)
    if not m:
        return None
    s = text[m.end():].lstrip()
    dec = json.JSONDecoder()
    layers, idx = [], 0
    while idx < len(s):
        while idx < len(s) and s[idx] in ", \n\r\t":
            idx += 1
        if idx >= len(s) or s[idx] in "]}":
            break
        try:
            obj, end = dec.raw_decode(s, idx)
            if isinstance(obj, dict):
                layers.append(obj)
            idx = end
        except json.JSONDecodeError:
            break
    return layers or None


def _normalize_bbox(bbox):
    # 模型常混用 [x,y,w,h] 和 [x1,y1,x2,y2] 两种格式，按 PoC-2 判定规则自动纠正
    x, y, w, h = [float(v) for v in bbox]
    converted = False
    if (x + w > 1000 or y + h > 1000) and x <= w <= 1000 and y <= h <= 1000 and w > x and h > y:
        w, h = w - x, h - y
        converted = True
    x = max(0, min(x, 1000))
    y = max(0, min(y, 1000))
    w = max(1, min(w, 1000 - x))
    h = max(1, min(h, 1000 - y))
    return [round(x), round(y), round(w), round(h)], converted


def _draw_bbox_preview(image_tensor, layers):
    img = image_tensor[0].cpu().numpy()
    img = np.clip(img * 255.0, 0, 255).astype(np.uint8)
    pil = Image.fromarray(img)
    W, H = pil.size
    draw = ImageDraw.Draw(pil)
    try:
        font = ImageFont.truetype("msyh.ttc", max(18, round(min(W, H) / 40)))
    except Exception:
        font = ImageFont.load_default()
    line_w = max(2, round(min(W, H) / 300))
    for i, l in enumerate(layers):
        x, y, w, h = l["bbox"]
        px, py, pw, ph = x / 1000 * W, y / 1000 * H, w / 1000 * W, h / 1000 * H
        c = _BBOX_COLORS[i % len(_BBOX_COLORS)]
        draw.rectangle([px, py, px + pw, py + ph], outline=c, width=line_w)
        draw.text((px + 4, py + 4), f'{l["z_index"]}:{l["layer_name"]}', fill=c, font=font)
    out = np.array(pil).astype(np.float32) / 255.0
    return torch.from_numpy(out).unsqueeze(0)


class WP_PsdPlanner:
    """🐳 WP PSD图层规划 — VLM 把原图拆解为图层方案 JSON + bbox 预览图。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "待拆解的原图。"}),
                "拆分粒度": (["简单", "详细", "复杂"], {"default": "详细", "tooltip": "简单=只拆主体+背景等大区块（2~5层）；详细=每个独立物体一层（5~12层）；复杂=连主体部件（发型/服装等）都拆（10~20层）。"}),
                "附加指令": ("STRING", {"default": "", "multiline": True, "tooltip": "可选。额外拆分要求，如“二维码必须单独一层”。"}),
                "最大边长": ("INT", {"default": 896, "min": 256, "max": 2048, "step": 64, "tooltip": "送入本地 VLM 前的图片最长边缩放值，越小越快。896 为 PoC 验证值。API 模式固定用 1536 高清，不受此参数影响。"}),
                "最大生成token": ("INT", {"default": 4096, "min": 512, "max": 8192, "step": 64, "tooltip": "过小会导致 JSON 被截断。本地与 API 模式均生效。"}),
                "温度": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.5, "step": 0.01, "tooltip": "规划任务需要稳定输出，PoC 验证值 0.2。"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "step": 1, "control_after_generate": True, "tooltip": "随机种子（本地模式）。解析失败时自动用 seed+1 重试一次。"}),
                "卸载模型": ("BOOLEAN", {"default": False, "tooltip": "开启后每次本地推理完成自动卸载模型释放显存（下次运行需重新加载，耗时较长）；仅本地模型模式有效。"}),
                "API配置": ("STRING", {"default": "", "multiline": True, "tooltip": "API 模式配置（JSON，同「🐳 WP 提示词对话」设置弹窗格式：api_url/api_key/model/max_tokens/seed）。不连接本地模型时启用。"}),
            },
            "optional": {
                "qwen模型": ("QWENLLAMA", {"tooltip": "本地模型（连接时优先使用）；不连接则走「API配置」。需选配 mmproj 的多模态模型。"}),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("规划JSON", "预览图")
    FUNCTION = "plan"
    CATEGORY = "🐳 WP_Node"

    @classmethod
    def IS_CHANGED(cls, 拆分粒度=None, 附加指令=None, **kwargs):
        """把拆分粒度/附加指令编入缓存签名，确保这些影响提示词的参数一变就重新执行。
        「卸载模型」是执行副作用，被缓存跳过时说明结果直接复用、无需执行，不需要参与签名。"""
        return f"粒度={拆分粒度}|指令={附加指令}"

    def plan(self, image, 拆分粒度, 附加指令, 最大边长, 最大生成token, 温度, seed, 卸载模型, API配置, qwen模型=None):
        t_total = _wp_log("==== PSD图层规划 plan 开始 ====")

        # ---- 后端选择：连接本地模型优先；未连接则解析「API配置」（参考提示词对话节点）----
        api_cfg = _parse_api_config(API配置) if qwen模型 is None else {}
        if qwen模型 is None and not api_cfg:
            raise RuntimeError(
                "未连接本地模型，且 API 配置无效。请把「qwen模型」端口连到 🐳 WP 模型加载器，"
                "或在「API配置」里填入完整 JSON（需含 api_url / api_key / model）。"
            )

        llm = None
        if qwen模型 is not None:
            # 模型自动重载/引用同步（与 WP 推理节点同款逻辑）
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

            if getattr(qwen模型, "chat_handler", None) is None:
                raise RuntimeError("图层规划需要多模态（视觉）模型。请在「🐳 WP 模型加载器」里选择配套的 视觉投影mmproj。")

            if qwen模型.settings.get("think"):
                _wp_log("警告：模型加载器开启了「启用思考」，可能吞掉 JSON 输出。本节点已强制注入 enable_thinking=False。")

            llm = qwen模型.llm
        if image is None or int(image.shape[0]) == 0:
            raise ValueError("未检测到图片输入。")
        H, W = int(image.shape[1]), int(image.shape[2])

        # 本地模式按「最大边长」缩放省算力；API 模式用 1536 高清 JPEG（云端模型看得更清，规划质量更好）
        if llm is not None:
            img_b64 = _batch_image_index_to_base64(image, 0, int(最大边长))
        else:
            img_b64 = _image_to_base64_jpeg(image, 0, max_size=1536)
        if not img_b64:
            raise ValueError("图片编码失败。")

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": _build_user_prompt(拆分粒度, 附加指令)},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
            ]},
        ]

        plan = None
        raw = ""
        last_err = None
        if llm is not None:
            # ---- 本地推理：PoC-2 教训必须关思考模式，否则思考吞 token 导致无 JSON 输出。
            # 调用层显式传 enable_thinking=False，可压过加载器的「启用思考」配置。----
            first_seed = _normalize_random_seed(seed)
            params = {
                "max_tokens": int(最大生成token),
                "temperature": float(温度),
                "top_p": 0.9,
                "top_k": 20,
                "repeat_penalty": 1.0,
                "stream": False,
                "enable_thinking": False,
            }
            retry_seed = None if first_seed is None else first_seed + 1
            for attempt, cur_seed in ((1, first_seed), (2, retry_seed)):
                t_try = _wp_log(f"第 {attempt} 次推理（seed={cur_seed}）")
                params["seed"] = cur_seed
                # 第 2 次换温度打破模型的重复书写习惯（同温度重试易再抽到坏 JSON）
                params["temperature"] = float(温度) if attempt == 1 else 0.7
                _reset_llm_inference_state(llm)
                out = _call_chat_completion(llm, messages=messages, params=params)
                try:
                    raw = out["choices"][0]["message"]["content"]
                except Exception:
                    raw = str(out)
                try:
                    plan = _clean_and_parse_json(raw)
                    _wp_log(f"第 {attempt} 次推理并解析成功", t_try)
                    break
                except (ValueError, json.JSONDecodeError) as e:
                    last_err = e
                    last_raw = raw
                    _wp_log(f"第 {attempt} 次解析失败: {e}（先重试，全失败才兜底抢救）")
        else:
            # ---- API 推理：复用提示词对话节点同款（流式优先/网关回退/瞬时错误重试已内建）。
            # max_tokens 用节点参数覆盖配置默认值，规划 JSON 输出长。----
            api_cfg["max_tokens"] = int(最大生成token)
            for attempt in (1, 2):
                t_try = _wp_log(f"API 第 {attempt} 次推理")
                raw = _call_api_chat(api_cfg, messages, float(温度) if attempt == 1 else 0.7, 0.9)
                if not raw or not raw.strip():
                    # 空输出典型症状：思考模式耗尽 max_tokens 配额，正文一字未写。
                    # _call_api_chat 已默认传 enable_thinking=False，此处再兜一层明确诊断。
                    _wp_log(f"API 第 {attempt} 次推理返回空内容（若反复出现，检查网关是否支持 enable_thinking 参数、或调大「最大生成token」）")
                try:
                    plan = _clean_and_parse_json(raw)
                    _wp_log(f"API 第 {attempt} 次推理并解析成功", t_try)
                    break
                except (ValueError, json.JSONDecodeError) as e:
                    last_err = e
                    last_raw = raw
                    _wp_log(f"API 第 {attempt} 次解析失败: {e}（先重试，全失败才兜底抢救）")

        # 「卸载模型」开关：本地推理完成后立即卸载释放显存（API 模式无本地模型，无此动作）
        if llm is not None and bool(卸载模型):
            t_unload = _wp_log("「卸载模型」开关触发 unload")
            _WpLlamaStorage.unload()
            _wp_log("「卸载模型」开关触发 unload", t_unload)

        if plan is None:
            # 最后防线：两次标准解析全部失败，才启用残骸抢救（保留已写完整的图层，丢弃坏尾部）
            salvaged = _salvage_layers_from_raw(last_raw)
            if salvaged:
                plan = {"layers": salvaged}
                _wp_log(f"两次解析均失败，最后防线已抢救 {len(salvaged)} 个完整图层（损坏尾部已截除）")
            else:
                raise RuntimeError(
                    f"VLM 两次输出均无法解析为图层规划 JSON：{last_err}\n"
                    f"模型原始输出（前300字符）：{last_raw[:300]}"
                )

        layers = plan.get("layers")
        if not isinstance(layers, list) or not layers:
            raise RuntimeError(f"VLM 输出的 JSON 中没有有效图层：{json.dumps(plan, ensure_ascii=False)[:200]}")

        fixed_count = 0
        cleaned = []
        for l in layers:
            if not isinstance(l, dict):
                continue
            b = l.get("bbox")
            if isinstance(b, (list, tuple)) and len(b) == 4:
                try:
                    l["bbox"], converted = _normalize_bbox(b)
                    fixed_count += 1 if converted else 0
                except Exception:
                    l["bbox"] = [0, 0, 1000, 1000]
            else:
                _wp_log(f"图层 [{l.get('layer_name', '?')}] bbox 缺失/非法，已置为全画布")
                l["bbox"] = [0, 0, 1000, 1000]
            l.setdefault("layer_name", "未命名图层")
            l.setdefault("layer_type", "装饰")
            try:
                l["z_index"] = int(l.get("z_index", 0))
            except Exception:
                l["z_index"] = 0
            l.setdefault("description", "")
            cw = l.get("concept_words")
            if isinstance(cw, list) and cw:
                l["concept_words"] = [str(w).strip() for w in cw if str(w).strip()][:6]
            else:
                l["concept_words"] = []
            cleaned.append(l)

        cleaned.sort(key=lambda x: int(x.get("z_index", 0)))
        for i, l in enumerate(cleaned):
            l["z_index"] = i

        plan_out = {"canvas": {"width": W, "height": H}, "layers": cleaned}
        json_text = json.dumps(plan_out, ensure_ascii=False, indent=2)
        preview = _draw_bbox_preview(image, cleaned)

        _wp_log(f"规划完成：{len(cleaned)} 层，bbox 自动矫正 {fixed_count} 层")
        _wp_log("==== PSD图层规划 plan 总耗时 ====", t_total)
        return (json_text, preview)
