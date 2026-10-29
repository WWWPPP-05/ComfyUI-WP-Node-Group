# -*- coding: utf-8 -*-
"""
🐳 WP Llama 模型加载器 — 加载 Qwen3 / Qwen3.5 模型到 llama-cpp-python

【依赖说明】
此节点依赖 llama-cpp-python 库（import 名为 llama_cpp），要求 ≥0.3.36。
- Qwen3.5 纯文本架构（qwen35）：≥0.3.35 即支持；
- 视觉（mmproj）：使用官方 MTMDChatHandler；Qwen3.5-VL 的视觉投影
  内部类型为 qwen3vl_merger（沿用 Qwen3-VL 视觉编码器），0.3.36 已实测
  支持完整视觉推理；mmproj 须与主模型配套（加载时自动校验维度）。

Windows 注意：
- 轮子的 CUDA 变体须与 ComfyUI 的 torch 匹配（torch 为 cu130 时装 cu130 轮子，
  其 ggml-cuda.dll 依赖 torch/lib 里的 cublas64_13.dll，本节点会自动配好搜索路径）；
- 本节点还会把系统 CUDA 工具箱目录追加到 PATH 末尾兜底（防止轮子与 torch 的
  CUDA 版本错开时找不到 cublas/cudart）；
- 若 PATH 上装有独立版 llama.cpp，本节点会自动让包内 DLL 优先，无需卸载。
"""
import base64
import gc
import inspect
import io
import os
import re
import time
from dataclasses import dataclass
from functools import wraps

import numpy as np
from PIL import Image

import folder_paths
import comfy.model_management as mm

def _preload_llama_cpp_dlls():
    """Windows 下在 import llama_cpp 前调整 DLL 搜索路径。

    必须在 import llama_cpp 之前执行，解决两个问题：
    1. ggml-cuda.dll 依赖的 cublas64_13.dll 只在 torch/lib 里，
       需把 torch/lib 前置到 PATH 才能启用 GPU 加速
    2. PATH 中独立版 llama.cpp 的旧版同名 DLL 需被包内版本压过

    注意：不能用 ctypes 提前加载包内 DLL。新版 llama_cpp(>=0.3.x) 会自己
    按绝对路径加载 DLL 并注册 GPU 后端，任何 ctypes 预加载都会造成
    "后端注册表分裂"（CUDA 后端显示加载成功，模型加载却报
    no backends are loaded），因此这里只调整搜索路径。
    """
    import sysconfig

    if os.name != "nt":
        return
    sp = sysconfig.get_paths()["purelib"]
    libdir = os.path.join(sp, "llama_cpp", "lib")
    if not os.path.isdir(libdir):
        return

    # torch 自带 CUDA 运行库(cublas/cudart)，供 ggml-cuda.dll 使用
    torch_lib = os.path.join(sp, "torch", "lib")
    if os.path.isdir(torch_lib):
        os.add_dll_directory(torch_lib)

    # 把 torch/lib 与包内 lib 前置到 PATH，保证依赖解析优先命中正确版本，
    # 压过 PATH 上独立版 llama.cpp 的旧 DLL
    for dll_dir in (torch_lib, libdir):
        if os.path.isdir(dll_dir):
            parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
            if dll_dir not in parts:
                os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")

    # 兜底：系统 CUDA 工具箱目录追加到 PATH 末尾（优先级最低）。
    # 当轮子的 CUDA 变体与 torch 不一致（如 cu12x 轮子 + cu130 torch）时，
    # torch/lib 里没有 cublas64_12.dll，可由系统 CUDA 12.x 目录补上
    try:
        import glob as _glob

        cuda_base = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
        for ver_dir in sorted(_glob.glob(os.path.join(cuda_base, "v*")), reverse=True):
            cuda_bin = os.path.join(ver_dir, "bin")
            if os.path.isdir(cuda_bin):
                os.add_dll_directory(cuda_bin)
                parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
                if cuda_bin not in parts:
                    os.environ["PATH"] = os.environ.get("PATH", "") + os.pathsep + cuda_bin
    except Exception:
        pass

    # 拦截 find_library，阻止旧版 llama_cpp 从 PATH 找到独立版 llama.cpp 的旧 DLL，
    # 强制其走包内路径回退逻辑
    import ctypes.util

    _orig_find_library = ctypes.util.find_library

    def _patched_find_library(name):
        if name in ("ggml", "ggml-base", "llama", "llama-common",
                    "mtmd", "ggml-cuda", "ggml-cpu"):
            return None
        return _orig_find_library(name)

    ctypes.util.find_library = _patched_find_library


_preload_llama_cpp_dlls()

try:
    from llama_cpp import Llama
except Exception as _wp_llama_import_error:
    # 保留真实错误（多为 DLL 加载失败），load() 时展示给用户，不再静默吞掉
    Llama = None
else:
    _wp_llama_import_error = None

try:
    from llama_cpp import GGML_TYPE_Q8_0
except Exception:
    GGML_TYPE_Q8_0 = 8

try:
    # 官方多模态处理器（mtmd 后端）：Qwen3-VL / Qwen2.5-VL 视觉投影
    from llama_cpp.llama_chat_format import MTMDChatHandler
except Exception:
    MTMDChatHandler = None


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")

DEFAULT_IMAGE_PROMPT = ""
DEFAULT_IMAGE_SYSTEM_PROMPT = "描述这张图,300字左右."
DEFAULT_TEXT_SYSTEM_PROMPT = "描述这张图,300字左右."
DEFAULT_KV_CACHE_TYPE = "默认(F16)"
Q8_0_CACHE_TYPE = "q8_0"
KV_CACHE_TYPE_OPTIONS = [DEFAULT_KV_CACHE_TYPE, Q8_0_CACHE_TYPE]


def _wp_log(step: str, start_time: float | None = None) -> float:
    """诊断日志：记录步骤开始/完成和耗时（秒）。开始时返回时间戳，完成时传入时间戳计算耗时。"""
    now = time.time()
    ts = time.strftime("%H:%M:%S", time.localtime(now)) + f".{int((now % 1) * 1000):03d}"
    if start_time is None:
        print(f"[WP诊断] [{ts}] {step} 开始", flush=True)
    else:
        cost = now - start_time
        print(f"[WP诊断] [{ts}] {step} 完成, 耗时 {cost:.3f}s", flush=True)
    return now


def _ensure_llm_dir_registered() -> None:
    folder_name = "LLM"
    llm_dir = os.path.join(folder_paths.models_dir, folder_name)

    supported_exts = set(getattr(folder_paths, "supported_pt_extensions", set()))
    llm_exts = supported_exts | {".gguf"}

    try:
        if folder_name not in folder_paths.folder_names_and_paths:
            folder_paths.folder_names_and_paths[folder_name] = ([llm_dir], llm_exts)
            return

        paths, exts = folder_paths.folder_names_and_paths[folder_name]
        if llm_dir not in paths:
            paths.append(llm_dir)

        if isinstance(exts, set):
            exts.update(llm_exts)
        else:
            folder_paths.folder_names_and_paths[folder_name] = (paths, set(exts) | llm_exts)
    except Exception:
        return


def _list_llm_files() -> list[str]:
    _ensure_llm_dir_registered()
    try:
        return folder_paths.get_filename_list("LLM")
    except Exception:
        return []


def _图片转base64(image_tensor) -> str:
    if image_tensor is None:
        return ""
    img = image_tensor[0].cpu().numpy()
    img = np.clip(img * 255.0, 0, 255).astype(np.uint8)
    pil = Image.fromarray(img)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _resize_image_to_max_edge(pil: Image.Image, max_edge: int) -> Image.Image:
    if max_edge <= 0:
        return pil
    w, h = pil.size
    long_edge = max(w, h)
    if long_edge <= max_edge:
        return pil
    scale = max_edge / float(long_edge)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return pil.resize((new_w, new_h), resample=Image.BICUBIC)


def _batch_image_index_to_base64(image_tensor, index: int, max_edge: int) -> str:
    if image_tensor is None:
        return ""
    if index < 0 or index >= int(image_tensor.shape[0]):
        return ""
    t = _wp_log(f"图片处理[index={index}, max_edge={max_edge}]")
    img = image_tensor[index].cpu().numpy()
    img = np.clip(img * 255.0, 0, 255).astype(np.uint8)
    pil = Image.fromarray(img)
    pil = _resize_image_to_max_edge(pil, max_edge)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=90)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    _wp_log(f"图片处理[index={index}, max_edge={max_edge}]", t)
    return b64


def _call_chat_completion(llm, *, messages, params: dict) -> dict:
    kwargs = dict(params or {})
    kwargs["messages"] = messages

    t_sig = _wp_log("反射签名 inspect.signature")
    try:
        sig = inspect.signature(llm.create_chat_completion)
        has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    except Exception:
        sig = None
        has_var_kw = True
    _wp_log("反射签名 inspect.signature", t_sig)

    if sig is not None and not has_var_kw:
        allowed = sig.parameters
        if "presence_penalty" in kwargs and "presence_penalty" not in allowed and "present_penalty" in allowed:
            kwargs["present_penalty"] = kwargs.pop("presence_penalty")
        if "present_penalty" in kwargs and "present_penalty" not in allowed and "presence_penalty" in allowed:
            kwargs["presence_penalty"] = kwargs.pop("present_penalty")
        kwargs = {k: v for k, v in kwargs.items() if k in allowed}

    t_call = _wp_log("模型推理 create_chat_completion")
    result = llm.create_chat_completion(**kwargs)
    _wp_log("模型推理 create_chat_completion", t_call)
    return result


def _clean_think_block_text(text: str) -> str:
    if not isinstance(text, str) or not text:
        return "" if text is None else str(text)

    cleaned = text
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)

    # 未闭合的思考块（生成被 max_tokens 截断，一直没等到 </think>）：
    # 从 <think> 起整段都是未完成的思考过程，必须整段丢弃；
    # 只删标签会把思考正文泄漏进最终回复
    if re.search(r"<think\b[^>]*>", cleaned, flags=re.IGNORECASE) and not re.search(
        r"</think>", cleaned, flags=re.IGNORECASE
    ):
        cleaned = re.sub(r"<think\b[^>]*>.*$", "", cleaned, flags=re.DOTALL | re.IGNORECASE)

    if re.search(r"</think>", cleaned, flags=re.IGNORECASE):
        cleaned = re.sub(r"^.*?</think>\s*", "", cleaned, count=1, flags=re.DOTALL | re.IGNORECASE)

    cleaned = cleaned.replace("<think>", "").replace("</think>", "")
    return cleaned


def _is_llama_param_available(param_name: str) -> bool | None:
    if Llama is None:
        return None

    try:
        sig = inspect.signature(Llama.__init__)
    except Exception:
        return None

    return param_name in sig.parameters


def _parse_kv_cache_type(value: str | None) -> int | None:
    if not value or value == DEFAULT_KV_CACHE_TYPE:
        return None
    if value == Q8_0_CACHE_TYPE:
        return GGML_TYPE_Q8_0
    raise ValueError(f"未知 KV 缓存类型：{value}")


def _normalize_random_seed(seed_value):
    try:
        seed_value = int(seed_value)
    except Exception:
        return None

    if seed_value < 0:
        return None
    return seed_value


def _reset_llm_inference_state(llm) -> None:
    try:
        ctx = getattr(llm, "_ctx", None)
        if ctx is not None and hasattr(ctx, "memory_clear"):
            ctx.memory_clear(True)
    except Exception:
        pass

    try:
        hybrid_cache_mgr = getattr(llm, "_hybrid_cache_mgr", None)
        if hybrid_cache_mgr is not None and hasattr(hybrid_cache_mgr, "clear"):
            hybrid_cache_mgr.clear()
    except Exception:
        pass

    try:
        batch = getattr(llm, "_batch", None)
        if batch is not None and hasattr(batch, "reset"):
            batch.reset()
    except Exception:
        pass

    try:
        input_ids = getattr(llm, "input_ids", None)
        if input_ids is not None and hasattr(input_ids, "fill"):
            input_ids.fill(0)
    except Exception:
        pass

    try:
        reset = getattr(llm, "reset", None)
        if callable(reset):
            reset()
        elif hasattr(llm, "n_tokens"):
            llm.n_tokens = 0
    except Exception:
        pass


def _attach_text_thinking_handler(llm, think: bool) -> bool:
    """纯文本模式下把"启用思考"开关接入 GGUF 模板的 enable_thinking 变量。

    Llama 内置的 chat_template.default handler 无法从请求层传入模板变量，
    导致模板按默认值（开启思考+xhigh 深度）执行；此处重建 handler 注入
    enable_thinking。think=False 时模板会预填空思考块，模型直接输出正文。
    """
    try:
        import llama_cpp.llama_chat_format as llama_chat_format

        template = llm.metadata.get("tokenizer.chat_template")
        if not template or "enable_thinking" not in template:
            return False

        eos_token = llm.detokenize([llm.token_eos()]).decode("utf-8", "replace")
        bos_token = llm.detokenize([llm.token_bos()]).decode("utf-8", "replace")
        stop_ids = [t for t in (llm.token_eos(), llm.token_eot()) if t != -1] or None

        special_tokens_map = {}
        for name, tid in {
            "eot_token": llm.token_eot(),
            "sep_token": llm.token_sep(),
            "nl_token": llm.token_nl(),
            "pad_token": llm.token_pad(),
            "mask_token": llm.token_mask(),
        }.items():
            if tid != -1:
                text = llm.detokenize([tid]).decode("utf-8", "replace")
                if text:
                    special_tokens_map[name] = text

        base_formatter = llama_chat_format.Jinja2ChatFormatter(
            template=template,
            eos_token=eos_token,
            bos_token=bos_token,
            stop_token_ids=stop_ids,
            special_tokens_map=special_tokens_map,
        )

        def _formatter(*, messages, **kwargs):
            return base_formatter(messages=messages, enable_thinking=bool(think), **kwargs)

        llm.chat_handler = llama_chat_format.chat_formatter_to_chat_completion_handler(_formatter)
        return True
    except Exception:
        return False


def _read_gguf_meta(path: str) -> dict:
    """只读 GGUF 头部的元数据 KV（不碰张量数据）。失败返回空 dict。"""
    import struct

    try:
        with open(path, "rb") as f:
            if f.read(4) != b"GGUF":
                return {}
            _, _, kv_count = struct.unpack("<IQQ", f.read(4 + 8 + 8))

            def read_str():
                (n,) = struct.unpack("<Q", f.read(8))
                return f.read(n).decode("utf-8", "replace")

            def read_value(t):
                if t == 0: return struct.unpack("<B", f.read(1))[0]
                if t == 1: return struct.unpack("<b", f.read(1))[0]
                if t == 2: return struct.unpack("<H", f.read(2))[0]
                if t == 3: return struct.unpack("<h", f.read(2))[0]
                if t == 4: return struct.unpack("<I", f.read(4))[0]
                if t == 5: return struct.unpack("<i", f.read(4))[0]
                if t == 6: return struct.unpack("<f", f.read(4))[0]
                if t == 7: return struct.unpack("<?", f.read(1))[0]
                if t == 8: return read_str()
                if t == 9:
                    (et,) = struct.unpack("<I", f.read(4))
                    (n,) = struct.unpack("<Q", f.read(8))
                    return [read_value(et) for _ in range(n)]
                if t == 10: return struct.unpack("<Q", f.read(8))[0]
                if t == 11: return struct.unpack("<q", f.read(8))[0]
                if t == 12: return struct.unpack("<d", f.read(8))[0]
                return None

            metas = {}
            for _ in range(kv_count):
                key = read_str()
                (t,) = struct.unpack("<I", f.read(4))
                metas[key] = read_value(t)
            return metas
    except Exception:
        return {}


def _check_mmproj_matches_model(model_path: str, mmproj_path: str) -> None:
    """校验 mmproj 与主模型配套（视觉投影维度须等于模型词嵌入维度）。

    同目录放多个模型时容易交叉配错（如 4B 的 mmproj 配 9B 的模型），
    配错的典型症状是推理输出乱码；此处提前拦截并给出明确提示。
    解析失败不阻塞加载（交给 llama.cpp 报自己的错误）。
    """
    try:
        model_meta = _read_gguf_meta(model_path)
        mm_meta = _read_gguf_meta(mmproj_path)
        arch = model_meta.get("general.architecture")
        emb = model_meta.get(f"{arch}.embedding_length") if arch else None
        proj = mm_meta.get("clip.vision.projection_dim")
        if emb and proj and int(emb) != int(proj):
            raise RuntimeError(
                "视觉投影（mmproj）与主模型不配套："
                f"投影维度 {proj} ≠ 模型嵌入维度 {emb}。\n"
                f"主模型：{os.path.basename(model_path)}\n"
                f"mmproj：{os.path.basename(mmproj_path)}\n"
                "请换用与主模型配套的 mmproj 文件。"
            )
    except RuntimeError:
        raise
    except Exception:
        return


def _make_vision_chat_handler(family: str, mmproj_path: str, think: bool):
    """视觉模式：按模型系列选用 llama-cpp-python 自带的专用 MTMD 处理器。

    旧实现直接继承 MTMDChatHandler 基类：基类用的是通用 USER:/ASSISTANT:
    模板（绕开了 Qwen 原生 chatml 结构），且经 **kwargs 传入的 enable_thinking
    会在基类 __call__ 内被吞掉、到不了模板渲染层——「关闭思考」完全失效，
    思考型模型默认输出思考过程。专用处理器通过 extra_template_arguments
    把开关真正注入模板：Qwen3.5 关闭思考时预填空 <think></think> 块，
    模型直接输出正文。
    """
    if MTMDChatHandler is None:
        from ._llama_installer import ensure_llama_cpp
        ok, msg = ensure_llama_cpp(log=_wp_log)
        if ok:
            raise RuntimeError(
                "视觉功能所需的依赖已自动升级完成，请重启 ComfyUI 后重新运行工作流。"
            )
        raise RuntimeError(f"当前 llama-cpp-python 版本过旧（缺少视觉支持 MTMDChatHandler）。\n{msg}")

    family = (family or "").strip()
    if family.startswith(("Qwen3.5", "Qwen3.6", "Qwen3.8")):
        try:
            from llama_cpp.llama_chat_format import Qwen35ChatHandler
            return Qwen35ChatHandler(
                clip_model_path=mmproj_path, verbose=False, enable_thinking=bool(think)
            )
        except ImportError:
            pass
    elif family.startswith("Qwen3"):
        try:
            from llama_cpp.llama_chat_format import Qwen3VLChatHandler
            return Qwen3VLChatHandler(
                clip_model_path=mmproj_path, verbose=False, force_reasoning=bool(think)
            )
        except ImportError:
            pass

    # 兜底：未知系列沿用通用处理器（无法禁用思考，仅保证能出图出文）
    class _WpMTMDHandler(MTMDChatHandler):
        def __call__(self, *args, **kwargs):
            kwargs.setdefault("enable_thinking", bool(think))
            return super().__call__(*args, **kwargs)

    return _WpMTMDHandler(clip_model_path=mmproj_path, verbose=False)


@dataclass
class _WpLlamaModel:
    llm: object
    settings: dict
    chat_handler: object | None = None


class _WpLlamaStorage:
    """模型存储单例，独立于原 Qwen TE 插件。"""
    model: _WpLlamaModel | None = None

    @classmethod
    def unload(cls) -> None:
        try:
            if cls.model and getattr(cls.model.llm, "close", None):
                cls.model.llm.close()
        except Exception:
            pass
        cls.model = None
        gc.collect()
        mm.soft_empty_cache()

    @classmethod
    def load(cls, config: dict) -> _WpLlamaModel:
        t_load = _wp_log(f"模型加载开始 family={config.get('family')}, model={config.get('model')}, n_ctx={config.get('n_ctx')}, n_gpu_layers={config.get('n_gpu_layers')}")
        if Llama is None:
            # 打包分发场景：先尝试自动安装/修复依赖，再重新导入
            from ._llama_installer import ensure_llama_cpp
            ok, msg = ensure_llama_cpp(log=_wp_log)
            if not ok:
                detail = ""
                if _wp_llama_import_error is not None:
                    detail = f"\n此前导入失败的真实错误：{type(_wp_llama_import_error).__name__}: {_wp_llama_import_error}\n"
                raise RuntimeError(f"{msg}\n{detail}")
            try:
                from llama_cpp import Llama as _Llama
                from llama_cpp.llama_chat_format import MTMDChatHandler as _MTMD
            except Exception as e:
                raise RuntimeError(
                    f"依赖已安装（{msg}）但导入仍失败：{e}\n"
                    "请重启 ComfyUI 后重试；若仍失败，多为轮子的 CUDA 变体与 torch 不匹配，"
                    "参见本文件顶部依赖说明。"
                )
            globals()["Llama"] = _Llama
            globals()["MTMDChatHandler"] = _MTMD
            globals()["_wp_llama_import_error"] = None
            _wp_log(f"依赖自动安装成功：{msg}")

        if cls.model and cls.model.settings == config:
            _wp_log("模型加载（命中已加载实例，跳过）", t_load)
            return cls.model

        t_unload = _wp_log("释放旧模型 unload")
        cls.unload()
        _wp_log("释放旧模型 unload", t_unload)

        model_path = os.path.join(folder_paths.models_dir, "LLM", config["model"])
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"找不到模型文件：{model_path}")

        mmproj = config.get("mmproj", "无")
        mmproj_path = None
        if mmproj and mmproj != "无":
            mmproj_path = os.path.join(folder_paths.models_dir, "LLM", mmproj)
            if not os.path.exists(mmproj_path):
                raise FileNotFoundError(f"找不到 mmproj 文件：{mmproj_path}")

        family = config["family"]
        think = config["think"]
        cache_type_k = config.get("cache_type_k", DEFAULT_KV_CACHE_TYPE)
        cache_type_v = config.get("cache_type_v", DEFAULT_KV_CACHE_TYPE)

        chat_handler = None
        if mmproj_path:
            _check_mmproj_matches_model(model_path, mmproj_path)
            t_handler = _wp_log("创建 chat_handler（视觉投影 MTMD）")
            chat_handler = _make_vision_chat_handler(family, mmproj_path, think)
            _wp_log("创建 chat_handler（视觉投影 MTMD）", t_handler)

        n_ctx = int(config.get("n_ctx", 8192))
        n_gpu_layers = int(config.get("n_gpu_layers", -1))

        llama_kwargs = {
            "model_path": model_path,
            "chat_handler": chat_handler,
            "n_ctx": n_ctx,
            "n_gpu_layers": n_gpu_layers,
            "verbose": False,
        }

        if _is_llama_param_available("ctx_checkpoints") is not False:
            llama_kwargs["ctx_checkpoints"] = 0

        if _is_llama_param_available("flash_attn_type") is not False:
            llama_kwargs["flash_attn_type"] = 1

        type_k = _parse_kv_cache_type(cache_type_k)
        type_v = _parse_kv_cache_type(cache_type_v)
        wants_custom_kv_type = type_k is not None or type_v is not None
        supports_type_k = _is_llama_param_available("type_k")
        supports_type_v = _is_llama_param_available("type_v")

        if wants_custom_kv_type and (supports_type_k is False or supports_type_v is False):
            raise RuntimeError("当前 llama-cpp-python 不支持 type_k/type_v（KV cache 量化），请更新该依赖后再使用 q8_0。")

        if type_k is not None:
            llama_kwargs["type_k"] = type_k
        if type_v is not None:
            llama_kwargs["type_v"] = type_v

        t_init = _wp_log(f"Llama 实例化（GGUF解析+上GPU+KV缓存预分配 n_ctx={n_ctx}）")
        try:
            llm = Llama(**llama_kwargs)
        except Exception as e:
            import llama_cpp
            raise RuntimeError(
                f"GGUF 模型加载失败（llama-cpp-python 版本 {getattr(llama_cpp, '__version__', '未知')}）：{e}\n"
                f"模型文件：{model_path}（{os.path.getsize(model_path) / 2**30:.2f} GB）\n"
                "常见原因：\n"
                "1) llama-cpp-python 过旧，不认识该模型架构（Qwen3.5 文本架构需 ≥0.3.35）；\n"
                "2) 模型文件未下载完整或已损坏，请重新下载；\n"
                "3) GPU DLL 加载失败，详见本文件顶部依赖说明。"
            ) from e
        _wp_log("Llama 实例化（GGUF解析+上GPU+KV缓存预分配）", t_init)

        if chat_handler is None:
            attached = _attach_text_thinking_handler(llm, bool(think))
            _wp_log(f"纯文本模式注入 enable_thinking={bool(think)} 到聊天模板：{'成功' if attached else '未生效(模板不支持或异常)，保持默认行为'}")

        cls.model = _WpLlamaModel(llm=llm, settings=dict(config), chat_handler=chat_handler)
        _wp_log("模型加载整体", t_load)
        return cls.model


def _install_global_unload_hook() -> None:
    """将 ComfyUI 全局卸载挂钩到本插件的卸载逻辑上。"""
    try:
        if hasattr(mm, "_wp_llm_unload_hook_installed") and mm._wp_llm_unload_hook_installed:
            return

        original = getattr(mm, "unload_all_models", None)
        if original is None or not callable(original):
            return

        @wraps(original)
        def wrapped_unload_all_models(*args, **kwargs):
            try:
                _WpLlamaStorage.unload()
            except Exception:
                pass
            return original(*args, **kwargs)

        mm.unload_all_models = wrapped_unload_all_models
        mm._wp_llm_unload_hook_installed = True
    except Exception:
        return


_install_global_unload_hook()


class WpLlamaLoader:
    """🐳 WP 模型加载器 — 加载 Qwen3 / Qwen3.5 VL 模型到 llama-cpp-python。"""

    @classmethod
    def INPUT_TYPES(s):
        all_files = _list_llm_files()
        model_list = [f for f in all_files if "mmproj" not in f.lower() and os.path.splitext(f)[1].lower() in [".gguf", ".safetensors", ".bin", ".pth", ".pt"]]
        mmproj_list = ["无"] + [f for f in all_files if "mmproj" in f.lower() and os.path.splitext(f)[1].lower() in [".gguf", ".safetensors", ".bin"]]

        if not model_list:
            model_list = ["（请把模型放到 models/LLM）"]

        return {
            "required": {
                "模型系列": (["Qwen3-VL", "Qwen3.5-VL", "Qwen3.8-VL"], {"default": "Qwen3.5-VL"}),
                "主模型": (model_list, {"tooltip": "主模型文件（建议 .gguf）放到 ComfyUI/models/LLM/"}),
                "视觉投影mmproj": (mmproj_list, {"default": "无", "tooltip": "多模态必选配套的 mmproj；纯文本选\"无\"。注意 mmproj 须与主模型配套（4B配4B、9B配9B），配错会在加载时被自动拦截。"}),
                "启用思考": ("BOOLEAN", {"default": False, "tooltip": "通过 enable_thinking 注入聊天模板（文本与视觉模式均适用）。"}),
                "上下文长度": ("INT", {"default": 8192, "min": 1024, "max": 327680, "step": 256, "tooltip": "对应 llama.cpp 的 n_ctx。"}),
                "GPU层数": ("INT", {"default": -1, "min": -1, "max": 9999, "step": 1, "tooltip": "对应 llama.cpp 的 n_gpu_layers；-1=尽可能多上GPU；0=纯CPU。"}),
                "KV缓存K类型": (KV_CACHE_TYPE_OPTIONS, {"default": DEFAULT_KV_CACHE_TYPE, "tooltip": "对应 llama.cpp 的 --cache-type-k / type_k。推荐默认；q8_0-27B模型以上可能提速。"}),
                "KV缓存V类型": (KV_CACHE_TYPE_OPTIONS, {"default": DEFAULT_KV_CACHE_TYPE, "tooltip": "对应 llama.cpp 的 --cache-type-v / type_v。推荐默认；q8_0-27B模型以上可能提速。"}),
            }
        }

    RETURN_TYPES = ("QWENLLAMA",)
    RETURN_NAMES = ("qwen模型",)
    FUNCTION = "load"
    CATEGORY = "🐳 WP_Node"

    def load(self, 模型系列, 主模型, 视觉投影mmproj, 启用思考, 上下文长度, GPU层数, KV缓存K类型, KV缓存V类型):
        if 主模型.startswith("（请把模型放到"):
            raise RuntimeError("未找到可用模型文件。请把模型放到 ComfyUI/models/LLM/ 后重启。")

        config = {
            "family": 模型系列,
            "model": 主模型,
            "mmproj": 视觉投影mmproj,
            "think": bool(启用思考),
            "n_ctx": int(上下文长度),
            "n_gpu_layers": int(GPU层数),
            "cache_type_k": KV缓存K类型,
            "cache_type_v": KV缓存V类型,
        }
        model = _WpLlamaStorage.load(config)
        return (model,)
