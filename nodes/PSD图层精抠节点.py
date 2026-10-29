# -*- coding: utf-8 -*-
"""
🐳 WP PSD 图层精抠 — PSD 拆解管线第③站：SAM3.1 文本概念分割
吃规划 JSON + 原图，输出每层像素级精确 mask（图层图像/图层蒙版 batch）+ 诊断 JSON + 预览拼图。
调用配方来自 PoC-2.7 v3 验证结论（概念词并集查询、分层阈值、实例落在规划框内即保留、
bbox 矩形兜底）。SAM3 代码来自 ComfyUI-RMBG 插件，权重在 models/sam3/。
"""
import gc
import json
import os
import sys
import threading

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

import folder_paths
import comfy.model_management as mm

from .推理模型加载器节点 import _wp_log

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_THIS_DIR)
_CUSTOM_NODES_DIR = os.path.dirname(_PLUGIN_DIR)

# 旧版规划 JSON 没有 concept_words 字段时，按图层类型兜底
_FALLBACK_WORDS = {
    "文字": ["words", "text"],
    "标志": ["logo"],
    "装饰": ["decorative element", "ornament"],
    "主体": ["person"],
    "前景": ["object"],
}

# 这些类型用低阈值（SAM 对文字/标志/装饰的内部检测分天生低，PoC-2.7 实测 0.5 会全灭）
_TEXT_LAYER_TYPES = ("文字", "标志", "装饰")


def _scan_sam_models():
    """扫描 models/sam3/ 下的 .safetensors 权重，生成下拉框列表；默认优先选 sam3.1。"""
    sam_dir = os.path.join(folder_paths.models_dir, "sam3")
    files = []
    if os.path.isdir(sam_dir):
        files = sorted(f for f in os.listdir(sam_dir) if f.lower().endswith(".safetensors"))
    if not files:
        return ["（models/sam3 下未找到权重）"], "（models/sam3 下未找到权重）"
    for f in files:
        if "sam3.1" in f.lower():
            return files, f
    return files, files[0]


class _Sam3Storage:
    """SAM3.1 processor 单例缓存（按模型文件名区分，同一模型第二次运行秒加载）。"""
    _processors = {}
    _lock = threading.Lock()

    @classmethod
    def load(cls, model_name):
        if model_name in cls._processors:
            return cls._processors[model_name]
        with cls._lock:
            if model_name in cls._processors:
                return cls._processors[model_name]

            if not torch.cuda.is_available():
                raise RuntimeError("SAM3.1 需要 GPU（CUDA），当前环境不可用。")

            rmbg = os.path.join(_CUSTOM_NODES_DIR, "ComfyUI-RMBG")
            sam3_code = os.path.join(rmbg, "models", "sam3")
            models_parent = os.path.join(rmbg, "models")
            bpe = os.path.join(sam3_code, "assets", "bpe_simple_vocab_16e6.txt.gz")
            ckpt = os.path.join(folder_paths.models_dir, "sam3", model_name)
            if model_name.startswith("（"):
                raise RuntimeError(
                    "models/sam3 目录下没有 .safetensors 权重文件。\n"
                    f"请先下载 SAM3.1 权重放到：{os.path.join(folder_paths.models_dir, 'sam3')}"
                )
            size_gb = os.path.getsize(ckpt) / 1024 ** 3 if os.path.exists(ckpt) else 0
            t = _wp_log(
                f"正在加载 SAM 模型：{model_name}（{size_gb:.2f} GB）——从磁盘读盘 + 进显存，"
                "首次加载约需 1~3 分钟，期间界面显示执行中，请耐心等待……"
            )
            for p, desc in ((sam3_code, "SAM3 代码目录（ComfyUI-RMBG 插件）"),
                           (bpe, "SAM3 BPE 词表"), (ckpt, "SAM 权重文件")):
                if not os.path.exists(p):
                    raise FileNotFoundError(
                        f"找不到{desc}：{p}\n"
                        "SAM3.1 依赖 ComfyUI-RMBG 插件的代码与 models/sam3 下的权重，请确认已安装/下载。"
                    )

            # PoC-2.7 配方：两个目录都注入 sys.path（sam3 包的导入依赖此路径布局）
            for p in (sam3_code, models_parent):
                if p not in sys.path:
                    sys.path.insert(0, p)

            from sam3.model_builder import build_sam3_image_model
            from sam3.model.sam3_image_processor import Sam3Processor
            from safetensors.torch import load_file as safetensors_load_file

            model = build_sam3_image_model(
                bpe_path=bpe, device="cpu", eval_mode=True,
                checkpoint_path=None, load_from_HF=False,
                enable_segmentation=True, enable_inst_interactivity=False)
            sd = safetensors_load_file(ckpt, device="cpu")
            if any(k.startswith("detector.") for k in sd):
                sd = {k.replace("detector.", ""): v for k, v in sd.items() if "detector" in k}
            model.load_state_dict(sd, strict=False)
            model = model.cuda().eval()
            processor = Sam3Processor(model, device="cuda")

            cls._processors[model_name] = processor
            _wp_log(f"SAM 模型加载完成：{model_name}", t)
            return processor

    @classmethod
    def unload(cls, model_name=None):
        if model_name is None:
            cls._processors.clear()
        else:
            cls._processors.pop(model_name, None)
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def _bbox_to_rect(bbox, W, H):
    """规划 bbox（0~1000 归一化 [x,y,w,h]）→ 像素矩形 (x0,y0,x1,y1)，clamp 到画布。"""
    x, y, w, h = [float(v) for v in bbox]
    rx0 = max(0, min(int(x / 1000 * W), W - 1))
    ry0 = max(0, min(int(y / 1000 * H), H - 1))
    rx1 = max(rx0 + 1, min(int((x + w) / 1000 * W), W))
    ry1 = max(ry0 + 1, min(int((y + h) / 1000 * H), H))
    return rx0, ry0, rx1, ry1


def _query_word(processor, state, word, conf):
    """单概念词查询，返回实例级二值 mask 数组 [n,H,W] 或 None。"""
    processor.reset_all_prompts(state)
    processor.set_confidence_threshold(float(conf), state)
    st = processor.set_text_prompt(word, state)
    masks = st.get("masks")
    if masks is None or masks.numel() == 0:
        return None
    m = masks.float()
    if m.ndim == 4:
        m = m.squeeze(1)
    return m.cpu().numpy() > 0.5


def _make_preview(pil_img, layers, masks_bool, sources):
    """每层一格的拼图：红色半透明显示 mask、绿框显示规划 bbox、标签显示命中状态。"""
    W, H = pil_img.size
    cell_w = 300
    cell_h = max(60, int(cell_w * H / W))
    try:
        font = ImageFont.truetype("msyh.ttc", 15)
    except Exception:
        font = ImageFont.load_default()

    cells = []
    for l, merged, source in zip(layers, masks_bool, sources):
        cell = pil_img.resize((cell_w, cell_h))
        m = Image.fromarray((merged * 255).astype(np.uint8)).resize((cell_w, cell_h))
        red = Image.new("RGB", (cell_w, cell_h), (255, 0, 0))
        cell = Image.composite(red, cell, m.point(lambda p: 128 if p > 127 else 0))
        d = ImageDraw.Draw(cell)
        rx0, ry0, rx1, ry1 = _bbox_to_rect(l["bbox"], W, H)
        d.rectangle([rx0 / W * cell_w, ry0 / H * cell_h, rx1 / W * cell_w, ry1 / H * cell_h],
                    outline=(0, 255, 0), width=2)
        if source == "sam":
            tag = "OK"
        elif source == "background":
            tag = "BG"
        else:
            tag = "FALLBACK"
        d.text((4, 4), f'{l["z_index"]:02d} {l["layer_name"]} {tag}', fill=(255, 255, 0), font=font)
        cells.append(cell)

    cols = 5
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), (30, 30, 30))
    for i, c in enumerate(cells):
        sheet.paste(c, ((i % cols) * cell_w, (i // cols) * cell_h))
    out = np.array(sheet).astype(np.float32) / 255.0
    return torch.from_numpy(out).unsqueeze(0)


class WP_PsdLayerExtract:
    """🐳 WP PSD图层精抠 — SAM3.1 按规划 JSON 把每层抠成像素级精确 mask。"""

    @classmethod
    def INPUT_TYPES(s):
        sam_files, sam_default = _scan_sam_models()
        return {
            "required": {
                "规划JSON": ("STRING", {"multiline": True, "tooltip": "接「🐳 WP PSD图层规划」或人工修改后的规划 JSON。"}),
                "image": ("IMAGE", {"tooltip": "原图（须与规划时用的同一张）。"}),
                "SAM模型": (sam_files, {"default": sam_default, "tooltip": "显式选择 SAM 模型权重（扫描 models/sam3 目录生成，新放权重需重启 ComfyUI 后出现）。"}),
                "物体检测阈值": ("FLOAT", {"default": 0.30, "min": 0.05, "max": 0.90, "step": 0.05, "tooltip": "主体/前景等具象物体层的 SAM3 置信度阈值。PoC-2.7 验证值 0.30。"}),
                "文字检测阈值": ("FLOAT", {"default": 0.10, "min": 0.05, "max": 0.90, "step": 0.05, "tooltip": "文字/标志/装饰层的阈值。SAM 对文字类检测分天生低，0.5 会全部漏检，PoC 验证值 0.10。"}),
                "推理后卸载": ("BOOLEAN", {"default": False, "tooltip": "开启=执行完释放 SAM3.1（约 3.9GB 显存）；关闭=常驻显存，下次秒加载。显存紧张时建议开启。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "IMAGE")
    RETURN_NAMES = ("图层图像", "图层蒙版", "结果JSON", "预览图")
    FUNCTION = "extract"
    CATEGORY = "🐳 WP_Node"

    def extract(self, 规划JSON, image, SAM模型, 物体检测阈值, 文字检测阈值, 推理后卸载):
        t_total = _wp_log("==== PSD图层精抠 extract 开始 ====")

        if image is None or int(image.shape[0]) == 0:
            raise ValueError("未检测到图片输入。")

        try:
            plan = json.loads(规划JSON)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"规划 JSON 解析失败（第 {e.lineno} 行第 {e.colno} 列：{e.msg}）。\n"
                "如果刚在文本框里手工修改过 JSON，请检查逗号/引号是否写错。"
            )
        layers = plan.get("layers")
        if not isinstance(layers, list) or not layers:
            raise RuntimeError("规划 JSON 中没有有效图层（layers 为空）。")

        img_np = image[0].cpu().numpy()
        img_np = np.clip(img_np * 255.0, 0, 255).astype(np.uint8)
        pil_img = Image.fromarray(img_np)
        W, H = pil_img.size

        processor = _Sam3Storage.load(SAM模型)
        try:
            t_enc = _wp_log("SAM3.1 图片编码 set_image")
            state = processor.set_image(pil_img)
            _wp_log("SAM3.1 图片编码 set_image", t_enc)

            masks_bool = []
            sources = []
            report_layers = []

            for l in layers:
                if mm.processing_interrupted():
                    raise mm.InterruptProcessingException()

                name = str(l.get("layer_name", "未命名图层"))
                ltype = str(l.get("layer_type", ""))
                rx0, ry0, rx1, ry1 = _bbox_to_rect(l.get("bbox", [0, 0, 1000, 1000]), W, H)
                rect = np.zeros((H, W), dtype=bool)
                rect[ry0:ry1, rx0:rx1] = True

                t_layer = _wp_log(f"图层 [{l.get('z_index', 0)}] {name}（{ltype}）")

                if ltype == "背景":
                    # 背景不走 SAM：全图占位 mask，干净背景由后续补全节点负责
                    merged = np.ones((H, W), dtype=bool)
                    source = "background"
                    words, conf, n_raw, n_kept = [], 0.0, 0, 0
                else:
                    cw = l.get("concept_words")
                    words = [str(w).strip() for w in cw if str(w).strip()] if isinstance(cw, list) else []
                    if not words:
                        words = list(_FALLBACK_WORDS.get(ltype, ["object"]))
                    conf = float(文字检测阈值) if ltype in _TEXT_LAYER_TYPES else float(物体检测阈值)

                    merged = np.zeros((H, W), dtype=bool)
                    n_raw = 0
                    n_kept = 0
                    for word in words:
                        try:
                            inst = _query_word(processor, state, word, conf)
                        except Exception as e:
                            _wp_log(f"图层 [{name}] 概念词 {word!r} 查询异常: {e}")
                            continue
                        if inst is None:
                            continue
                        n_raw += int(inst.shape[0])
                        for i in range(inst.shape[0]):
                            m = inst[i]
                            if m.sum() < 50:
                                continue
                            inter = int((m & rect).sum())
                            contain = inter / max(int(m.sum()), 1)
                            iou = inter / max(int(m.sum()) + int(rect.sum()) - inter, 1)
                            # PoC-2.7 归属规则：实例落在规划框内即保留，多层查询天然不抢
                            if contain >= 0.3 or iou >= 0.1:
                                merged |= m
                                n_kept += 1

                    if merged.sum() > 0:
                        source = "sam"
                    else:
                        # 兜底：SAM 检测不到的层用规划 bbox 矩形当 mask，保证管线不断
                        merged = rect
                        source = "bbox_fallback"
                        _wp_log(f"图层 [{name}] SAM 零命中，已用 bbox 矩形兜底")

                masks_bool.append(merged)
                sources.append(source)
                report_layers.append({
                    "z_index": l.get("z_index", 0),
                    "layer_name": name,
                    "layer_type": ltype,
                    "words": words,
                    "conf": conf,
                    "n_raw": n_raw,
                    "n_kept": n_kept,
                    "mask_px": int(merged.sum()),
                    "source": source,
                })
                _wp_log(f"图层 [{l.get('z_index', 0)}] {name} 完成", t_layer)

        finally:
            if bool(推理后卸载):
                _wp_log(f"推理后卸载 SAM 模型：{SAM模型}，释放显存")
                _Sam3Storage.unload(SAM模型)

        n = len(layers)
        mask_tensor = torch.from_numpy(np.stack(masks_bool).astype(np.float32))
        img_tensor = image[0:1].repeat(n, 1, 1, 1)
        report = {
            "canvas": {"width": W, "height": H},
            "layers": report_layers,
        }
        report_text = json.dumps(report, ensure_ascii=False, indent=2)
        preview = _make_preview(pil_img, layers, masks_bool, sources)

        n_hit = sum(1 for s in sources if s == "sam")
        n_fallback = sum(1 for s in sources if s == "bbox_fallback")
        _wp_log(f"精抠完成：{n_hit}/{n} 层 SAM 命中，{n_fallback} 层 bbox 兜底")
        _wp_log("==== PSD图层精抠 extract 总耗时 ====", t_total)
        return (img_tensor, mask_tensor, report_text, preview)
