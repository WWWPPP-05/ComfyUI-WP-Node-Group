# -*- coding: utf-8 -*-
import os
import threading
from collections import OrderedDict

import folder_paths
import comfy.utils
import comfy.sd

# 模块级 LRU 缓存：LoRA文件名 -> (文件修改时间, 权重)；文件被替换(mtime变化)时自动重新加载
_LORA_CACHE = OrderedDict()
_LORA_LOCK = threading.Lock()
_LORA_CACHE_MAX = 5


def _load_lora_cached(lora_name):
    """带 LRU 缓存加载 LoRA 权重，文件不存在返回 None"""
    lora_path = folder_paths.get_full_path("loras", lora_name)
    if lora_path is None:
        return None
    try:
        mtime = os.path.getmtime(lora_path)
    except OSError:
        return None
    with _LORA_LOCK:
        entry = _LORA_CACHE.get(lora_name)
        if entry is not None and entry[0] == mtime:
            _LORA_CACHE.move_to_end(lora_name)
            return entry[1]
    lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
    # 加载完成后再取一次 mtime：若读取期间文件被替换，旧 mtime 会把新数据记成旧版本
    try:
        mtime = os.path.getmtime(lora_path)
    except OSError:
        pass
    with _LORA_LOCK:
        _LORA_CACHE[lora_name] = (mtime, lora)
        _LORA_CACHE.move_to_end(lora_name)
        while len(_LORA_CACHE) > _LORA_CACHE_MAX:
            _LORA_CACHE.popitem(last=False)
    return lora


class LoRAStackLoader:
    """🐳 WP Lora堆加载器（仅模型）— 串联加载多个 LoRA，仅作用于模型，不经过 CLIP。每个 LoRA 由独立开关控制是否加载。"""

    @classmethod
    def INPUT_TYPES(s):
        # 移除“无”选项，空目录时给一个占位项避免 combo 报错
        lora_files = list(folder_paths.get_filename_list("loras"))
        if not lora_files:
            lora_files = ["（暂无LoRA）"]
        default_lora = lora_files[0]

        # 按 widget 显示顺序构建：LoRA → 强度 → 启用（启用在前端会被隐藏，由强度行的开关按钮控制）
        slot = {}
        for i in range(1, 6):
            idx = f"{i:02d}"
            slot[f"LoRA_{idx}"] = (lora_files, {"default": default_lora, "tooltip": "选择要加载的 LoRA 文件"})
            slot[f"强度_{idx}"] = ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.01, "tooltip": "LoRA 应用强度：负值=反向效果，0=不生效，按槽位 01→05 顺序依次叠加"})
            slot[f"启用_{idx}"] = ("BOOLEAN", {"default": False, "tooltip": "开启后才会加载该槽位的 LoRA"})

        return {
            "required": {
                "模型": ("MODEL", {"tooltip": "待挂载 LoRA 的基础模型"}),
                **slot,
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "load_loras"
    CATEGORY = "🐳 WP_Node"

    def load_loras(self, 模型, LoRA_01, 强度_01, 启用_01, LoRA_02, 强度_02, 启用_02, LoRA_03, 强度_03, 启用_03, LoRA_04, 强度_04, 启用_04, LoRA_05, 强度_05, 启用_05):
        # 每个槽位：(启用, LoRA名, 强度)
        slots = [
            (启用_01, LoRA_01, 强度_01),
            (启用_02, LoRA_02, 强度_02),
            (启用_03, LoRA_03, 强度_03),
            (启用_04, LoRA_04, 强度_04),
            (启用_05, LoRA_05, 强度_05),
        ]

        model = 模型
        loaded = 0
        skipped = 0

        for i, (enable, lora_name, strength) in enumerate(slots, 1):
            tag = f"槽位{i:02d}"

            # 开关关闭：跳过
            if not enable:
                continue

            # 占位/空值：跳过
            if not lora_name or lora_name in ("无", "（暂无LoRA）"):
                continue

            # 强度容错：防止旧工作流传入字符串导致崩溃
            try:
                strength = float(strength) if strength is not None else 1.0
            except (TypeError, ValueError):
                strength = 1.0
            # 钳制到滑条范围，防止手改工作流传入极端值产生异常结果
            strength = max(-4.0, min(4.0, strength))

            if strength == 0.0:
                continue

            # 文件失效或损坏：警告并跳过该槽位，不中断其他槽位
            try:
                lora = _load_lora_cached(lora_name)
            except Exception as e:
                print(f"[WP_LoRA堆加载器] 警告: {tag} LoRA\"{lora_name}\"加载失败（{type(e).__name__}: {e}），已跳过")
                skipped += 1
                continue
            if lora is None:
                print(f"[WP_LoRA堆加载器] 警告: {tag} 找不到LoRA文件\"{lora_name}\"，已跳过")
                skipped += 1
                continue

            try:
                model, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0)
            except Exception as e:
                print(f"[WP_LoRA堆加载器] 警告: {tag} LoRA\"{lora_name}\"应用失败（{type(e).__name__}: {e}），已跳过")
                skipped += 1
                continue

            loaded += 1

        if loaded or skipped:
            print(f"[WP_LoRA堆加载器] 完成: 成功加载 {loaded} 个，跳过 {skipped} 个")

        return (model,)


NODE_CLASS_MAPPINGS = {
    "WP_LoRAStackLoader": LoRAStackLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_LoRAStackLoader": "🐳 WP Lora堆加载器（仅模型）",
}
