# -*- coding: utf-8 -*-
"""
🐳 WP 提示词对话节点 — 工作流内嵌式提示词优化对话工具

【设计说明】
本节点复用「🐳 WP 模型加载器」加载的模型（通过 qwen模型 输入端口，类型 QWENLLAMA）。
Qwen3 / Qwen3.5 VL 是多模态模型，文字与图片解析由同一个模型完成，因此无需单独的
文本/视觉模型选择，节点顶部只保留「使用技能」下拉框。

多轮对话上下文由前端维护，通过「对话历史」widget 以 JSON 形式持久化：
    [{"role": "user" | "assistant" | "system", "content": "..."}, ...]
每次执行时，本节点把「历史 + 本轮用户输入(+图片)」拼成 messages 交给模型，
返回最新回复；前端负责把回复追加回历史并持久化，保证刷新/重载不丢失。

【技能机制】
- 技能文件放在 nodes/skills/，每次对话前检测目录变化自动重载（热重载），增删改技能无需重启 ComfyUI。
- 支持通用 SKILL.md 技能包（Agent Skills 标准格式）解压直接放入即用；文件夹形式的技能名
  = 文件夹名，改文件夹名即同步改下拉框显示名（旧显示名自动降级为别名，老工作流不断档）。
- 消息开头可用 /快捷指令 临时切换技能（如 "/h3 一只猫在雨中奔跑"），支持大小写、
  多别名（alias 逗号分隔）、指令后带标点、唯一前缀匹配；未命中会在回复开头给出提示。
- 内置 /help 指令：直接返回技能清单，不消耗模型推理。
- 【无】技能的自然聊天模式下注入技能清单，模型可引导用户使用 /指令；技能生效时
  不注入（模型应专注任务，清单只会稀释技能指令的注意力）。
- 两步式轻量 agent：技能带多份参考文件时，先做一次小推理按"本轮请求 + 附图张数"精选
  参考文件，再做主推理生成；同时后端把真实附图张数作为"输入事实"注入系统提示词，
  杜绝模型虚构图片引用。该机制对任何技能自动适用，无需逐个技能配置；
  参考文件只有 0/1 份时跳过精选，精选失败自动回退为全量加载。
- references/、templates/、examples/ 三个约定目录下的 .txt/.md 均自动作为技能参考文件，
  技能若依赖风格模板库或示例文件，模型能看到真实内容而不是凭空编造。

【推理与上下文】
- 本地模型与 API 模式均为流式输出：API 模式解析 SSE 数据块并复用同一 WebSocket 通道
  逐 token 推送前端（前端零适配）；网关不支持流式时自动回退非流式。API 连接按
  （地址, 密钥）复用会话，429/5xx/网络抖动自动重试一次。
- 多轮历史与系统提示词共享字符总预算（默认 6 万，历史保底 8000）：技能参考文件越多
  系统提示词越大，留给历史的额度越小，避免合计超出本地模型上下文窗口。
"""
import json
import os
import re
import base64
import threading
import time

import requests
from aiohttp import web

import numpy as np

from .推理模型加载器节点 import (
    _WpLlamaStorage,
    _call_chat_completion,
    _clean_think_block_text,
    _reset_llm_inference_state,
    _batch_image_index_to_base64,
    _wp_log,
)

import comfy.model_management as mm
from server import PromptServer

# 流式推送事件名（与 js/wp_prompt_agent.js 中的 STREAM_EVENT 保持一致）
_STREAM_EVENT = "wp_prompt_agent_token"

# SID 标记前缀：前端在「用户输入」widget 开头写入 [[WP_SID:<sid>]]，
# 后端解析时剥离出来用于把推送的 token 路由回对应节点
_SID_PREFIX = "[[WP_SID:"

# 「重新生成」标记：前端点击某轮 AI 回复的重新生成按钮时写在 SID 标记之后，
# 后端据此把对话历史截断到该轮提问为止（不含该轮原回复及其后对话），干净重跑该轮
_REGEN_FLAG = "[[WP_REGEN]]"

# 默认系统提示词（未被任何技能覆盖时使用）
DEFAULT_SYSTEM_PROMPT = "你是一个专业的 AI 绘画提示词优化助手。你会根据用户的描述或图片，生成、优化、扩写高质量的中文提示词。"

# 多轮对话规则：用户的修改指令优先于技能默认输出偏好。
# 技能 prompt 里常写死"直接输出、用英文、不许解释"等规则，本段在技能 prompt 之后注入，
# 防止模型在用户要求修改上一条回复（如"改为中文"）时无视用户、按技能模板重新生成。
_DIALOGUE_RULE = (
    "【多轮对话规则】以上技能指令只约束\"从零生成新内容\"的情形。"
    "当用户的消息是对你上一条回复的修改、调整或转换要求"
    "（例如：改为中文、翻译成英文、再短一些、换个风格、只修改某一段）时，"
    "必须以你上一条回复的内容为基础，按用户的明确要求进行修改后输出；"
    "用户的明确要求优先于技能中的默认输出语言、段落语言等偏好。"
    "严禁无视用户的修改指令而按技能模板从头重新生成一遍内容。"
)

# 技能文件目录：nodes/skills/（SKILL.md/skill.json 技能文件夹 + 简单 .json 文件）
_SKILLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")

DEFAULT_SKILL = "无"

# 系统提示词 + 多轮历史的字符总预算：历史额度 = 总预算 - 系统提示词长度（保底 8000），
# 超限从最旧开始按问答对丢弃，防止"技能参考文件 + 长对话"合计撑爆模型上下文
_MAX_TOTAL_CHARS = 60000


def _read_text(path: str) -> str:
    """读取文本文件：优先 UTF-8，解码失败回退 GBK（兼容手写/下载的中文文件），并去掉 BOM。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except UnicodeDecodeError:
        with open(path, "r", encoding="gbk", errors="ignore") as f:
            text = f.read()
    return text.lstrip("\ufeff")


def _parse_skill_md(path: str) -> tuple[dict, str]:
    """解析通用 SKILL.md（Agent Skills 标准格式）：返回 (头部字段表, 正文)。

    头部指文件开头 --- ... --- 之间的片段，只取单行 key: value（不引 YAML 依赖）；
    没有头部时字段表为空、正文为整个文件。
    """
    try:
        text = _read_text(path)
    except Exception:
        return {}, ""
    m = re.match(r"^\s*---\s*\n(.*?)\n\s*---\s*\n?(.*)$", text, flags=re.DOTALL)
    if not m:
        return {}, text.strip()
    fields: dict = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^([A-Za-z][\w-]*)\s*:\s*(.*)$", line.strip())
        if kv:
            val = kv.group(2).strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            fields[kv.group(1).lower()] = val
    return fields, m.group(2).strip()


def _scan_references(base_dir: str) -> list[str]:
    """收集技能文件夹 references/templates/examples 目录下的 .txt/.md 参考文件（含子目录）。

    templates/（风格模板库）与 examples/（示例）同 references/ 一样自动注入，
    技能正文若依赖这些文件，模型才能真正看到内容而不是凭空编造。
    """
    found: list[str] = []
    for sub in ("references", "templates", "examples"):
        sub_dir = os.path.join(base_dir, sub)
        if not os.path.isdir(sub_dir):
            continue
        for dirpath, _dirnames, filenames in os.walk(sub_dir):
            for fn in sorted(filenames):
                if fn.lower().endswith((".txt", ".md")):
                    found.append(os.path.relpath(os.path.join(dirpath, fn), base_dir).replace("\\", "/"))
    return found


def _load_skills() -> tuple[dict[str, str], dict[str, str], dict[str, bool], dict[str, list[dict]]]:
    """扫描 nodes/skills/ 目录，读取技能定义。文件夹形式的技能名 = 文件夹名。

    支持三种形式：
    1. 通用 SKILL.md 文件夹（Agent Skills 标准格式，下载解压直接放入即用）：
       skills/<文件夹>/SKILL.md，正文即提示词，references/templates/examples 子目录下
       的 .txt/.md 自动作为参考文件；头部 name/alias 注册为快捷指令别名；默认完全替代系统提示词。
    2. skill.json 文件夹：skills/<文件夹>/skill.json，定义 alias/prompt/include_references；
       显示名取文件夹名，json 里声明的 name 自动降级为别名（旧工作流不断档）。
    3. 简单 JSON 文件：skills/xxx.json，内容 {"name", "alias", "prompt", "replace_system"(可选)}。

    返回 (技能名 -> 基础指令, 别名 -> 技能名, 技能名 -> 是否替代系统提示词,
           技能名 -> [{"file": 相对路径, "content": 文件内容}, ...])。
    alias 可选，供 /指令 快捷触发；支持逗号/空格分隔多个别名。
    replace_system 可选，true=用 prompt 完全替代默认系统提示词（避免角色冲突）；
    不写或 false=追加到默认系统提示词之后（保持原行为）。
    """
    skills: dict[str, str] = {}
    aliases: dict[str, str] = {}
    replace_systems: dict[str, bool] = {}
    skill_refs: dict[str, list[dict]] = {}
    os.makedirs(_SKILLS_DIR, exist_ok=True)
    if not os.path.isdir(_SKILLS_DIR):
        return skills, aliases, replace_systems, skill_refs

    def _register(data: dict, base_dir: str, display_name: str = "") -> None:
        """把单个技能定义注册到 skills/aliases/replace_systems/skill_refs 字典。

        display_name 非空（文件夹形式）时以文件夹名为技能名；
        定义里声明的 name 与文件夹名不同时自动注册为别名，旧工作流里已选的技能名仍能解析。
        """
        if not isinstance(data, dict):
            return
        declared = str(data.get("name") or "").strip()
        name = display_name or declared
        prompt = str(data.get("prompt") or "").strip()
        if not name or not prompt:
            return
        # 收集 include_references 列出的参考文件（暂存不拼接，对话时按需选用）
        ref_files: list[dict] = []
        include_refs = data.get("include_references") or []
        if isinstance(include_refs, list):
            for ref_rel in include_refs:
                if not isinstance(ref_rel, str):
                    continue
                ref_path = os.path.join(base_dir, ref_rel)
                if not os.path.isfile(ref_path):
                    continue
                try:
                    ref_content = _read_text(ref_path).strip()
                except Exception:
                    continue
                if ref_content:
                    ref_files.append({"file": ref_rel.replace("\\", "/"), "content": ref_content})
        skills[name] = prompt
        replace_systems[name] = bool(data.get("replace_system") or False)
        if ref_files:
            skill_refs[name] = ref_files
        # alias 支持逗号/空格分隔的多个别名，如 "h3, h3video"
        alias_raw = str(data.get("alias") or "").strip().lower()
        if declared and declared != name:
            alias_raw = (alias_raw + " " + declared.lower()).strip()
        for alias in re.split(r"[,，\s]+", alias_raw):
            if alias:
                aliases[alias] = name

    for fname in sorted(os.listdir(_SKILLS_DIR)):
        path = os.path.join(_SKILLS_DIR, fname)

        # 文件夹形式：skill.json（自定义定义）优先，其次通用 SKILL.md（直接放入即用）
        if os.path.isdir(path):
            skill_json = os.path.join(path, "skill.json")
            if os.path.isfile(skill_json):
                try:
                    data = json.loads(_read_text(skill_json))
                except Exception:
                    continue
                _register(data, path, display_name=fname)
                continue
            skill_md = os.path.join(path, "SKILL.md")
            if os.path.isfile(skill_md):
                fields, body = _parse_skill_md(skill_md)
                if body:
                    replace_raw = str(fields.get("replace_system", "true")).strip().lower()
                    _register({
                        "name": fname,
                        "prompt": body,
                        "alias": " ".join(v for v in (fields.get("name"), fields.get("alias")) if v),
                        "replace_system": replace_raw not in ("false", "0", "no", "否"),
                        "include_references": _scan_references(path),
                    }, path)
            continue

        # 简单 JSON 文件形式
        if not fname.lower().endswith(".json"):
            continue
        try:
            data = json.loads(_read_text(path))
        except Exception:
            continue
        _register(data, os.path.dirname(path))

    return skills, aliases, replace_systems, skill_refs


# 内置帮助指令：直接返回技能清单，不消耗模型推理
_HELP_COMMANDS = {"help", "帮助", "技能", "skills", "?"}

# 技能表缓存：目录签名变化（技能文件增删/修改）时自动重载，实现热更新；
# 签名扫描按 3 秒节流，避免每次对话都全量遍历技能目录
_SKILLS_RESCAN_INTERVAL = 3.0
_skills_lock = threading.Lock()
_skills_cache: dict = {"sig": None, "ts": 0.0, "skills": {}, "aliases": {}, "replace": {}, "refs": {}}


def _skills_signature() -> tuple:
    """扫描技能目录，返回 (文件相对路径, mtime) 签名，用于检测目录内容变化。"""
    sig: list = []
    if os.path.isdir(_SKILLS_DIR):
        for dirpath, _dirnames, filenames in os.walk(_SKILLS_DIR):
            for fn in filenames:
                p = os.path.join(dirpath, fn)
                try:
                    sig.append((os.path.relpath(p, _SKILLS_DIR).replace("\\", "/"), os.path.getmtime(p)))
                except OSError:
                    continue
    return tuple(sorted(sig))


def _get_skills() -> tuple[dict[str, str], dict[str, str], dict[str, bool], dict[str, list[dict]]]:
    """获取 (技能定义, 别名表, 是否替代系统提示词, 各技能参考文件表)。目录变化时自动重扫。

    扫描按 _SKILLS_RESCAN_INTERVAL 秒节流：间隔内直接用缓存，避免每次对话都全量遍历
    技能目录；间隔外的首次调用重新计算目录签名，增删改技能依然免重启生效。
    """
    with _skills_lock:
        now = time.time()
        if _skills_cache["sig"] is None or now - _skills_cache["ts"] >= _SKILLS_RESCAN_INTERVAL:
            sig = _skills_signature()
            if sig != _skills_cache["sig"]:
                skills, aliases, replace, refs = _load_skills()
                _skills_cache.update(sig=sig, skills=skills, aliases=aliases, replace=replace, refs=refs)
            _skills_cache["ts"] = now
        return _skills_cache["skills"], _skills_cache["aliases"], _skills_cache["replace"], _skills_cache["refs"]


def _skill_list() -> list[str]:
    skills, _aliases, _replace, _refs = _get_skills()
    return ["无"] + [name for name in skills if name != "无"]


def _parse_command(text: str) -> tuple[str, str]:
    """解析消息开头的 /指令。返回 (指令小写, 去掉指令后的正文)；无指令时指令为空。

    指令后紧跟中文标点也能识别，如 "/h3，帮我写" -> ("h3", "帮我写")。
    """
    m = re.match(r"^\s*/([^\s，。：:,.！!？?/]+)[\s，。：:,.！!？?]*([\s\S]*)", text or "")
    if m:
        return m.group(1).lower(), m.group(2).strip()
    return "", (text or "").strip()


def _match_skill(cmd: str, skills: dict[str, str], aliases: dict[str, str]) -> tuple[str | None, list[str]]:
    """匹配指令到技能：先精确匹配别名/技能名，再做前缀匹配（唯一命中才生效）。

    返回 (技能名, 前缀歧义时的候选技能名列表)：
    - 精确/唯一前缀命中 -> (技能名, [])
    - 前缀命中多个技能 -> (None, 候选列表)，调用方可提示用户补全前缀
    - 完全未命中       -> (None, [])
    """
    cmd = (cmd or "").strip().lower()
    if not cmd:
        return None, []
    if cmd == "none" or cmd == "无":
        return "无", []
    if cmd in aliases:
        return aliases[cmd], []
    for name in skills:
        if cmd == name.lower():
            return name, []
    candidates = {name for alias, name in aliases.items() if alias.startswith(cmd)}
    candidates |= {name for name in skills if name.lower().startswith(cmd)}
    if len(candidates) == 1:
        return candidates.pop(), []
    if len(candidates) > 1:
        return None, sorted(candidates)
    return None, []


def _skill_lines(skills: dict[str, str], aliases: dict[str, str]) -> list[str]:
    """生成「技能名（快捷指令：/xxx）」清单行。"""
    lines = []
    for name in skills:
        cmds = [f"/{a}" for a, n in aliases.items() if n == name]
        lines.append(f"- {name}" + (f"（快捷指令：{'、'.join(cmds)}）" if cmds else "（无快捷指令，用节点下拉框选择）"))
    return lines


def _skills_help_reply(skills: dict[str, str], aliases: dict[str, str]) -> str:
    """内置 /help 指令的回复文案：列出所有技能和用法。"""
    lines = _skill_lines(skills, aliases)
    return (
        "当前可用技能：\n" + "\n".join(lines)
        + "\n\n用法：在消息开头输入 /快捷指令 + 你的内容，例如「/h3 一只猫在雨中奔跑」；"
        "指令优先级高于节点下拉框，仅对当轮生效。"
    )


def _skills_system_note(skills: dict[str, str], aliases: dict[str, str]) -> str:
    """注入系统提示词的技能清单说明，让模型能引导用户使用 /指令 切换技能。"""
    return (
        "当前系统可用以下技能，用户在消息开头用 /快捷指令 即可临时切换（与节点下拉框选择效果相同）：\n"
        + "\n".join(_skill_lines(skills, aliases))
        + "\n当用户的请求更适合某个技能时，可主动提示用户使用对应指令。"
    )


def _input_fact_note(total_images: int) -> str:
    """注入本轮输入事实（附图数量），杜绝模型虚构图片引用。

    这是通用机制：任何技能生效时都会被告知真实的附图情况，
    模型无需再猜测"本轮有没有图"，从源头避免套错格式模板。
    """
    if total_images > 0:
        return (
            f"【本轮输入事实】用户本轮共附带 {total_images} 张图片，按出现顺序为 Picture 1 到 Picture {total_images}。"
            "引用图片时只能使用这些真实存在的编号，严禁虚构不存在的图片编号。"
        )
    return (
        "【本轮输入事实】用户本轮没有附带任何图片。任何依赖参考图片的规则、模式或格式本轮均不适用，"
        "严禁输出图片对齐/图片引用类指令，严禁虚构 <Picture N> 之类不存在的图片标签。"
    )


# 用户声明优先规则：用户明确说了用什么模式/图片用途，模型不得自行改判（通用，任何技能适用）
_USER_MODE_PRIORITY_NOTE = (
    "【用户声明优先】用户在消息中明确声明的任务类型、生成模式或图片用途（例如声明图片用作参考、"
    "首帧、尾帧、分镜等）具有最高优先级：必须严格按用户声明的模式选择输出格式和图片角色，"
    "不得依据图片数量或任何其它线索擅自改判为别的模式，也不得发明规范之外的模式名称。"
    "例如用户声明是参考生成时，参考图只用于提取人物/物体的身份特征，目标视频不得以参考图作为开场帧。"
    "仅当用户未明确声明时，才可根据参考规范自行判断。"
)


# 仅输出内容模式：回复只给最终内容本身，不带解释/寒暄/分析
_ONLY_CONTENT_NOTE = (
    "【仅输出内容模式】你的回复必须只包含最终的提示词或生成内容本身："
    "不写任何开场白、引导语（如“好的”“以下是”）、结尾说明、分析过程、使用建议或额外解释，"
    "也不添加代码块以外的任何多余文字。仅当用户明确要求解释、提问或修改时，才可以正常展开回答。"
)


def _pick_references(llm, user_text: str, total_images: int, refs: list[dict]) -> list[dict]:
    """轻量 agent 第一步：让模型根据本轮请求 + 附图事实，从多份参考文件中选出需要的。

    只做一次小推理（限长输出、温度 0、不流式）。失败或无法识别时回退为全量加载，
    行为与旧版一致，保证任何情况下节点都能出结果。
    """
    file_list = "\n".join(f"- {r['file']}" for r in refs)
    messages = [
        {"role": "system", "content": (
            "你是资料检索助手。根据用户请求和本轮附带的图片数量，从参考文件清单中选出本次任务需要参考的文件。"
            "只输出需要的文件名（多个用逗号分隔），不要输出任何解释。拿不准时输出全部文件名。"
        )},
        {"role": "user", "content": (
            f"用户请求：{user_text}\n本轮附带图片：{total_images} 张\n"
            f"可用参考文件：\n{file_list}\n请输出本次需要的参考文件名。"
        )},
    ]
    params = {"max_tokens": 120, "temperature": 0.0, "stream": False, "stop": ["</s>"]}
    try:
        resp = _call_chat_completion(llm, messages=messages, params=params)
        answer = ""
        try:
            answer = resp["choices"][0]["message"].get("content") or ""
        except Exception:
            answer = ""
        answer = _clean_think_block_text(str(answer)).lower()
    except Exception:
        return list(refs)
    # 从回复中识别文件名：支持全名或去扩展名的文件主干；主干用整词边界匹配，
    # 避免 "ref" 误中 "reference" 之类的子串（主干足够长才参与匹配，进一步降低误命中）
    picked = []
    for r in refs:
        base = os.path.basename(r["file"]).lower()
        stem = os.path.splitext(base)[0]
        if base in answer:
            picked.append(r)
        elif len(stem) >= 3 and re.search(rf"(?<![\w-]){re.escape(stem)}(?![\w-])", answer):
            picked.append(r)
    return picked if picked else list(refs)


def _extract_sid(text: str) -> tuple[str, str]:
    """从前端写入的用户输入中剥离 [[WP_SID:<sid>]] 标记。

    返回 (sid, 剩余真实文本)。没有标记则 sid 为空字符串。
    """
    text = text or ""
    m = re.match(rf"^{re.escape(_SID_PREFIX)}([^\]]+)\]\](.*)$", text, flags=re.DOTALL)
    if m:
        return m.group(1).strip(), m.group(2)
    return "", text


def _trim_history(history: list, max_turns: int, char_budget: int) -> list:
    """历史截断：轮数与字符预算双上限，超限从最旧开始丢弃（前端保存时同步截断，这里双保险）。

    开头孤立的 assistant 消息（对应的用户提问已被截掉）会让模型读到"没头没尾的回答"，
    一并丢弃，保证上下文从完整的一问一答开始。
    """
    while len(history) > max_turns:
        history.pop(0)
    total = sum(len(str(it.get("content") or "")) for it in history if isinstance(it, dict))
    while history and total > char_budget:
        dropped = history.pop(0)
        if isinstance(dropped, dict):
            total -= len(str(dropped.get("content") or ""))
    while history and isinstance(history[0], dict) and history[0].get("role") == "assistant":
        history.pop(0)
    return history


def _parse_api_config(raw) -> dict:
    """解析前端「设置」弹窗保存到「API配置」widget 的 JSON。无效或缺关键字段时返回空 dict。"""
    if isinstance(raw, dict):
        cfg = raw
    else:
        try:
            cfg = json.loads((raw or "").strip())
        except Exception:
            return {}
        if not isinstance(cfg, dict):
            return {}
    url = str(cfg.get("api_url") or "").strip()
    key = str(cfg.get("api_key") or "").strip()
    model = str(cfg.get("model") or "").strip()
    if not (url and key and model):
        return {}
    try:
        cfg["max_tokens"] = int(cfg.get("max_tokens") or 3000)
    except (TypeError, ValueError):
        cfg["max_tokens"] = 3000
    try:
        cfg["seed"] = int(cfg.get("seed") or 0)
    except (TypeError, ValueError):
        cfg["seed"] = 0
    return cfg


def _image_to_base64_jpeg(图片, index: int, max_size: int = 1536, quality: int = 90) -> str:
    """ComfyUI IMAGE 张量的第 index 张转 Base64 JPEG（API 模式用，高清上限 1536 像素）。

    用 JPEG 而非 PNG：多图时请求体从十几 MB 降到 1MB 级，避免被 API 网关拒绝；
    1536 像素对提示词优化类视觉任务足够，比 2048 再省一半上传体积。
    """
    import io
    from PIL import Image
    image_np = 图片[index].cpu().numpy()
    image_np = (image_np * 255).clip(0, 255).astype(np.uint8)
    pil_image = Image.fromarray(image_np)
    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")
    w, h = pil_image.size
    if w > max_size or h > max_size:
        scale = max_size / max(w, h)
        pil_image = pil_image.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="JPEG", quality=quality)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


# API 请求会话缓存：(接口地址, 密钥) -> Session，复用 TCP+TLS 连接，省去每次握手
_api_sessions: dict[tuple[str, str], requests.Session] = {}
_api_sessions_lock = threading.Lock()

# 视为瞬时错误可重试一次的 HTTP 状态码（限流/网关类）
_API_RETRY_STATUS = {429, 500, 502, 503, 504}


def _get_api_session(api_cfg: dict) -> requests.Session:
    """按 (接口地址, 密钥) 复用连接池会话。"""
    key = (api_cfg["api_url"], api_cfg["api_key"])
    with _api_sessions_lock:
        sess = _api_sessions.get(key)
        if sess is None:
            sess = requests.Session()
            _api_sessions[key] = sess
        return sess


def _parse_api_content(result) -> str:
    """从非流式响应中取出回复文本，统一错误信息。"""
    if isinstance(result, dict) and result.get("error"):
        err = result["error"]
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        raise RuntimeError(f"API 返回错误：{msg[:500]}")
    choices = result.get("choices") if isinstance(result, dict) else None
    if not choices:
        raise RuntimeError(f"API 返回异常：choices 为空，请检查 API Key / 模型名 / 接口地址。返回片段：{str(result)[:300]}")
    try:
        return str(choices[0]["message"].get("content") or "")
    except (KeyError, IndexError, TypeError, AttributeError):
        raise RuntimeError(f"解析 API 响应失败。返回片段：{str(result)[:300]}")


def _api_request_json(api_cfg: dict, body: dict) -> dict:
    """非流式 API 请求（网关不支持流式时的回退路径），带一次瞬时错误重试。"""
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_cfg['api_key']}"}
    last_err: Exception | None = None
    for _attempt in range(2):
        try:
            resp = _get_api_session(api_cfg).post(api_cfg["api_url"], headers=headers, json=body, timeout=300)
        except requests.RequestException as e:
            last_err = e
            continue
        if resp.status_code in _API_RETRY_STATUS and _attempt == 0:
            last_err = RuntimeError(f"API 错误（状态码 {resp.status_code}）：{resp.text[:300]}")
            continue
        if resp.status_code != 200:
            raise RuntimeError(f"API 错误（状态码 {resp.status_code}）：{resp.text[:500]}")
        try:
            result = resp.json()
        except Exception:
            raise RuntimeError(f"API 返回了非 JSON 内容（状态码 {resp.status_code}）：{resp.text[:300]}")
        return result
    raise RuntimeError(f"API 请求失败（含一次重试）：{last_err}")


def _call_api_chat(api_cfg: dict, messages: list, 温度: float, top_p: float, sid: str = "") -> str:
    """API 模式推理（流式优先）：调用兼容 OpenAI 协议的 /chat/completions 接口。

    逐 token 解析 SSE 数据块，复用本地模式的 WebSocket 通道实时推送前端（前端零适配）；
    网关不支持流式（拿到 200 却收不到任何 token）时自动回退非流式重试。
    连接按 (地址, 密钥) 复用；429/5xx/网络抖动自动重试一次，已收到内容的中断不重试
    （避免重复推送 token）。重试期间任何一次拿到 200 响应后，之前的失败不再参与判定。
    """
    body = {
        "model": api_cfg["model"],
        "messages": messages,
        "max_tokens": api_cfg["max_tokens"],
        "temperature": float(温度),
        "top_p": float(top_p),
        "stream": True,
        # Qwen3 系云端模型默认开思考，思考会偷吃 max_tokens 配额（正文可能被耗成空）；
        # 显式关闭。不认识该参数的网关会自动忽略。
        "enable_thinking": False,
    }
    if api_cfg.get("seed"):
        body["seed"] = api_cfg["seed"]
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_cfg['api_key']}",
        "Accept": "text/event-stream",
    }

    parts: list[str] = []
    got_any = False
    last_err: Exception | None = None
    for _attempt in range(2):
        try:
            resp = _get_api_session(api_cfg).post(api_cfg["api_url"], headers=headers, json=body, timeout=300, stream=True)
        except requests.RequestException as e:
            last_err = e
            continue
        if resp.status_code in _API_RETRY_STATUS and _attempt == 0:
            last_err = RuntimeError(f"API 错误（状态码 {resp.status_code}）：{resp.text[:300]}")
            resp.close()
            continue
        if resp.status_code != 200:
            detail = resp.text[:500]
            resp.close()
            raise RuntimeError(f"API 错误（状态码 {resp.status_code}）：{detail}")
        last_err = None  # 已拿到 200 响应，之前尝试的失败不再参与后续判定
        try:
            resp.encoding = "utf-8"
            for line in resp.iter_lines(decode_unicode=True):
                if mm.processing_interrupted():
                    break
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except Exception:
                    continue
                if isinstance(chunk, dict) and chunk.get("error"):
                    err = chunk["error"]
                    msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    raise RuntimeError(f"API 返回错误：{msg[:500]}")
                try:
                    token = chunk["choices"][0].get("delta", {}).get("content")
                except Exception:
                    token = None
                if token:
                    parts.append(token)
                    got_any = True
                    if sid:
                        try:
                            PromptServer.instance.send_sync(_STREAM_EVENT, {"sid": sid, "token": token})
                        except Exception:
                            pass
        except requests.RequestException as e:
            # 流中断：已收到内容则不重试（避免 token 重复推送），直接报错
            if got_any:
                raise RuntimeError(f"API 流式传输中断：{e}")
            last_err = e
            continue
        finally:
            resp.close()
        break

    if not got_any:
        # 未收到任何 token：连接始终失败则报错；否则可能是网关不支持流式，回退非流式
        if last_err is not None:
            raise RuntimeError(f"API 请求失败（含一次重试）：{last_err}")
        return _parse_api_content(_api_request_json(api_cfg, {**body, "stream": False}))
    return "".join(parts)


class WpPromptAgent:
    """🐳 WP 提示词对话 — 多图接入的提示词优化对话节点。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "使用技能": (_skill_list(), {"default": DEFAULT_SKILL, "tooltip": "每次对话默认应用的技能；用 /技能名 指令可临时覆盖。"}),
                "用户输入": ("STRING", {"default": "", "multiline": True, "tooltip": "本轮要发给模型的用户消息（前端聊天框写入）。"}),
                "对话历史": ("STRING", {"default": "[]", "multiline": True, "tooltip": "多轮对话上下文（JSON），由前端维护并持久化。"}),
                "最大生成token": ("INT", {"default": 2048, "min": 20, "max": 8192, "step": 1}),
                "温度": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 20, "min": 0, "max": 200, "step": 1}),
                "重复惩罚": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.01}),
                "输出think块": ("BOOLEAN", {"default": False, "tooltip": "开启=保留模型原始思考过程输出。"}),
                "仅输出内容": ("BOOLEAN", {"default": False, "tooltip": "开启=回复只输出提示词/最终内容本身，不带任何解释、分析或寒暄。由前端左下角开关按钮维护。"}),
                "API配置": ("STRING", {"default": "", "multiline": True, "tooltip": "API 模式配置（JSON），由前端「设置」弹窗维护；未连接本地模型时启用。"}),
                "最大轮数": ("INT", {"default": 60, "min": 1, "max": 500, "step": 1, "tooltip": "对话历史最多保留的消息条数（用户+AI 消息合计），超限自动删最旧的；由前端「设置」弹窗维护。"}),
                "图像数量": ("INT", {"default": 3, "min": 1, "max": 10, "step": 1, "tooltip": "图片输入端口数量（1-10）；由前端「设置」弹窗维护。"}),
                "卸载模型": ("BOOLEAN", {"default": False, "tooltip": "开启后每次本地推理完成自动卸载模型释放显存（下次运行需重新加载，耗时较长）；仅本地模型模式有效，由前端左下角开关按钮维护。"}),
                # 输入框未发送草稿的持久化存档位：前端维护、后端不消费。
                # 必须放在 widget 列表末尾——ComfyUI 按 widget 顺序存取工作流值数组，
                # 插在中间会导致旧工作流打开时全部 widget 值错位
                "输入草稿": ("STRING", {"default": "", "multiline": True, "tooltip": "输入框未发送的草稿（前端维护并持久化，后端不使用；切换画布/刷新/重开工作流后恢复输入框内容）。"}),
            },
            "optional": {
                "qwen模型": ("QWENLLAMA", {"tooltip": "本地模型（连接时优先使用）；不连接则走「设置」里配置的 API。"}),
                # 图片输入端口：后端固定声明最大 10 个（可选），前端按「图像数量」设置动态显示
                **{f"图片{i}": ("IMAGE",) for i in range(1, 11)},
            },
        }

    # 输出端口「回复文本」：每轮对话结束后原样输出 AI 最新的完整回复（含解释、分析部分），
    # 可连到下游节点的文本输入（如 CLIP 文本编码、🐳 WP 文本框）直接取用对话结果；
    # 空输入静默跳过时回退输出「对话历史」里最后一条 AI 回复，整画布运行下游不断供
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("回复文本",)
    FUNCTION = "run"
    CATEGORY = "🐳 WP_Node"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, 卸载模型=False, **kwargs):
        """「卸载模型」开启时返回 NaN 声明本节点不可缓存：卸载是靠执行触发的副作用，
        若被 ComfyUI 执行缓存跳过（输入未变时复用旧结果），显存永远不会被释放"""
        if bool(卸载模型):
            return float("NaN")
        return ""

    @staticmethod
    def _unload_if_enabled(qwen模型, 卸载模型):
        """不推理的快速返回路径（帮助指令/空输入）顺手卸载：
        开关开 && 连了本地模型 && 模型在显存 → 释放，保证整画布跑完显存干净"""
        if qwen模型 is not None and bool(卸载模型) and _WpLlamaStorage.model is not None:
            _WpLlamaStorage.unload()
            _wp_log("「卸载模型」开关触发 unload（本轮未推理，顺手释放显存）")

    def run(
        self,
        使用技能,
        用户输入,
        对话历史,
        最大生成token,
        温度,
        top_p,
        top_k,
        重复惩罚,
        输出think块,
        仅输出内容,
        API配置,
        最大轮数,
        图像数量,
        卸载模型,
        输入草稿="",  # 前端草稿存档位，后端不消费（占位防止旧工作流值错位）
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
        t_total = _wp_log("==== 提示词对话节点 run 开始 ====")

        # ---- 推理后端选择：连接本地模型优先；未连接则用「设置」弹窗配置的 API ----
        api_cfg = _parse_api_config(API配置)
        if qwen模型 is None and not api_cfg:
            raise RuntimeError("未连接本地模型，且 API 配置无效。请把「qwen模型」端口连到 🐳 WP 模型加载器，或点击节点底部【⚙ 设置】完成 API 配置。")

        # ---- 解析多轮对话历史 ----
        messages = []
        try:
            history = json.loads(对话历史 or "[]")
            if not isinstance(history, list):
                history = []
        except Exception:
            history = []

        # ---- 合并多图，统一尺寸（前置：技能组装与参考文件精选都需要先知道附图数量） ----
        all_images = [img for img in (图片1, 图片2, 图片3, 图片4, 图片5, 图片6, 图片7, 图片8, 图片9, 图片10) if img is not None]
        图片 = None
        if all_images:
            import torch
            import torch.nn.functional as F
            target_h, target_w = all_images[0].shape[1], all_images[0].shape[2]
            resized = []
            for img in all_images:
                if img.shape[3] == 4:
                    # RGBA 白底合成转 RGB，与普通 3 通道图统一，避免 torch.cat 通道数不一致报错
                    img = img[..., :3] * img[..., 3:4] + (1.0 - img[..., 3:4])
                if img.shape[1] != target_h or img.shape[2] != target_w:
                    img = img.permute(0, 3, 1, 2)
                    img = F.interpolate(img, size=(target_h, target_w), mode="bilinear", align_corners=False)
                    img = img.permute(0, 2, 3, 1)
                resized.append(img)
            图片 = torch.cat(resized, dim=0)
            _wp_log(f"合并图片完成，共 {int(图片.shape[0])} 张")
        total_images = int(图片.shape[0]) if 图片 is not None else 0

        # ---- 解析本轮技能（先剥离 SID 标记再解析 /指令；技能表支持热重载） ----
        skills, aliases, replace_systems, refs = _get_skills()
        sid, 真实输入 = _extract_sid(用户输入)
        # 剥离「重新生成」标记（前端重新生成按钮写入）：本轮为某一轮的干净重跑
        is_regen = 真实输入.startswith(_REGEN_FLAG)
        if is_regen:
            真实输入 = 真实输入[len(_REGEN_FLAG):]
        cmd, user_text = _parse_command(真实输入)

        if is_regen:
            # 重新生成：从历史尾部向前找与本轮输入相同的提问，截断该提问及其后所有
            # 消息（含该轮原 AI 回复和之后的对话），上下文 = 该轮提问之前的对话 +
            # 该轮提问本身，与首次生成同口径；找不到匹配时退化为普通重发
            for _ri in range(len(history) - 1, -1, -1):
                _item = history[_ri]
                if isinstance(_item, dict) and _item.get("role") == "user":
                    if _extract_sid(str(_item.get("content") or ""))[1] == 真实输入:
                        history = history[:_ri]
                        break
        else:
            # 普通发送：前端发送时已把本轮用户消息提前固化进「对话历史」widget
            # （防画布切换丢失），弹出尾部与本轮相同的消息，避免重复拼装发给模型两遍
            if history and isinstance(history[-1], dict) and history[-1].get("role") == "user":
                _prev = _extract_sid(str(history[-1].get("content") or ""))[1]
                if _prev == 真实输入:
                    history = history[:-1]

        # 内置帮助指令：直接返回技能清单，不调用模型
        if cmd in _HELP_COMMANDS:
            self._unload_if_enabled(qwen模型, 卸载模型)
            _wp_log("==== 提示词对话节点 run 总耗时 ====", t_total)
            help_reply = _skills_help_reply(skills, aliases)
            return {"ui": {"reply": [help_reply]}, "result": (help_reply,)}

        # 空输入静默跳过：整画布运行时本节点没有新消息，不推理也不报错，
        # 直接返回空回复（前端收到空 reply 不会往聊天记录里添加任何内容）
        if not user_text:
            _wp_log("用户输入为空，静默跳过本轮执行")
            self._unload_if_enabled(qwen模型, 卸载模型)
            # 「回复文本」端口回退：输出「对话历史」里最后一条 AI 回复，
            # 保证「先对话优化、后运行整画布」时下游节点仍能拿到最新结果
            last_reply = ""
            for item in reversed(history):
                if isinstance(item, dict) and item.get("role") == "assistant" and item.get("content"):
                    last_reply = str(item["content"])
                    break
            _wp_log("==== 提示词对话节点 run 总耗时 ====", t_total)
            return {"ui": {"reply": [""]}, "result": (last_reply,)}

        # ---- 模型引用失效保护（复用推理节点的重载逻辑）----
        # 放在帮助指令/空输入之后：没有新消息时快速返回不碰模型，
        # 避免整画布运行时空跑一次几十秒的模型加载、白白占用显存
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
                # 旧名称兼容：曾用显示名（skill.json 声明的 name）已注册为别名，仍可解析
                skill, _amb = _match_skill(str(使用技能), skills, aliases)
                if skill is None:
                    skill = DEFAULT_SKILL

        # ---- 系统提示词组装：稳定段在前、变化段在后 ----
        # 顺序设计目的：① 利于 API 厂商前缀缓存——开头内容跨轮不变可命中缓存，
        # 大幅降低首 token 延迟与费用；② 关键行为规则放尾部（模型对首尾注意力最强），
        # 「仅输出内容」等用户显式开关放最尾强化执行。
        # 技能为【无】时正常交流、不带任何角色预设：系统提示词从空开始，
        # 下面各段注入均带技能守卫，只保留功能性信息（技能清单、附图事实等）
        system_text = "" if skill == "无" else DEFAULT_SYSTEM_PROMPT
        if skill != "无" and skills.get(skill):
            if replace_systems.get(skill):
                # 技能要求完全替代默认系统提示词，避免角色冲突
                system_text = skills[skill]
            else:
                # 默认行为：追加到默认系统提示词之后
                system_text = system_text + "\n\n" + skills[skill]
            # 轻量 agent 第一步：技能带多份参考文件时，先按"本轮请求 + 附图事实"精选，
            # 避免全量塞入让小模型混淆格式；0/1 份时无需精选，失败自动回退全量。
            # API 模式下云端大模型理解力强，直接全量加载，不额外消耗调用次数
            skill_refs = refs.get(skill) or []
            if llm is not None and len(skill_refs) > 1:
                t_pick = _wp_log("参考文件精选（agent 第一步）")
                _reset_llm_inference_state(llm)
                skill_refs = _pick_references(llm, user_text, total_images, skill_refs)
                _wp_log(f"入选参考文件：{[r['file'] for r in skill_refs]}")
                _wp_log("参考文件精选（agent 第一步）", t_pick)
            for r in skill_refs:
                system_text += f"\n\n----- 以下是参考文件 {r['file']} 的内容 -----\n{r['content']}"
        # [稳定] 用户声明的模式/图片用途优先级最高（通用规则：任何多模式技能均适用，
        # 防止模型根据图片数量擅自改判模式，如把"参考图"当"首帧"用）
        if skill != "无":
            system_text = system_text + "\n\n" + _USER_MODE_PRIORITY_NOTE
        # [稳定] 技能清单只在【无】技能的自然聊天模式注入（此时引导用户用 /指令 才有
        # 价值；技能生效时模型应专注任务，注入清单只会稀释技能指令的注意力）
        if skills and skill == "无":
            system_text = system_text + ("\n\n" if system_text else "") + _skills_system_note(skills, aliases)
        # [稳定] 有历史对话时注入多轮对话规则，确保用户的修改指令优先于技能默认偏好
        if history and skill != "无":
            system_text = system_text + "\n\n" + _DIALOGUE_RULE
        # [变化] 注入本轮输入事实（附图数量每轮可能不同，放后段保护前面的稳定前缀）。
        # 【无】技能下仅真的有附图时才告知图片数量，无图时不注入（保持纯自然交流）
        if skill != "无" or total_images > 0:
            system_text = system_text + ("\n\n" if system_text else "") + _input_fact_note(total_images)
        # [变化] 仅输出内容模式：用户显式开关，放最尾强化执行
        if bool(仅输出内容):
            system_text = system_text + ("\n\n" if system_text else "") + _ONLY_CONTENT_NOTE

        # ---- 历史截断：轮数上限 + 与系统提示词共享的字符总预算 ----
        # 系统提示词越大（如带大量参考文件的技能），留给历史的额度越小，
        # 避免"系统+历史"合计超出本地模型上下文窗口（有 8000 字符保底）
        history = _trim_history(history, max(1, int(最大轮数 or 60)), max(8000, _MAX_TOTAL_CHARS - len(system_text)))

        # 系统提示词为空（【无】技能、无附图、未开「仅输出内容」）时不传 system 角色，
        # 模型以纯自然对话方式回答；本地推理与线上 API 均兼容无 system 的消息列表
        if system_text.strip():
            messages.append({"role": "system", "content": system_text})

        for item in history:
            if isinstance(item, dict) and item.get("role") in ("user", "assistant") and item.get("content"):
                content = item["content"]
                if item["role"] == "user" and isinstance(content, str):
                    # 历史里的旧 /指令 前缀剥离，避免模型把它当作要重复执行的任务
                    _cmd, content = _parse_command(_extract_sid(content)[1])
                    if not content:
                        continue
                messages.append({"role": item["role"], "content": content})

        # ---- 本轮用户消息（文本 + 可选图片） ----
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
            # ---- 本地模型：流式推理，逐 token 通过 WebSocket 推送前端 ----
            params = {
                "max_tokens": int(最大生成token),
                "temperature": float(温度),
                "top_p": float(top_p),
                "top_k": int(top_k),
                "repeat_penalty": float(重复惩罚),
                "stream": True,
                "stop": ["</s>"],
            }

            t_reset = _wp_log("重置推理状态")
            _reset_llm_inference_state(llm)
            _wp_log("重置推理状态", t_reset)

            t_call = _wp_log("模型推理（流式）")
            chunks = _call_chat_completion(llm, messages=messages, params=params)
            # stream=True 时返回生成器，逐 chunk 提取 token 累积 + 实时推送前端
            parts: list[str] = []
            for chunk in chunks:
                try:
                    delta = chunk["choices"][0].get("delta", {})
                    token = delta.get("content")
                except Exception:
                    token = None
                if token:
                    parts.append(token)
                    if sid:
                        try:
                            PromptServer.instance.send_sync(_STREAM_EVENT, {"sid": sid, "token": token})
                        except Exception:
                            pass
            text = "".join(parts)
            _wp_log("模型推理（流式）", t_call)
        else:
            # ---- API 模式：流式推理（SSE 解析逐 token 推送前端），网关不支持时自动回退非流式 ----
            t_call = _wp_log("API 推理（流式）")
            text = _call_api_chat(api_cfg, messages, 温度, top_p, sid)
            _wp_log("API 推理（流式）", t_call)

        # 推理结束发一次 done 标记，前端据此切换“流式中”→“完成”样式（本地/API 通用）
        if sid:
            try:
                PromptServer.instance.send_sync(_STREAM_EVENT, {"sid": sid, "token": "", "done": True})
            except Exception:
                pass

        if not bool(输出think块):
            text = _clean_think_block_text(text)

        # 「卸载模型」开关：本地推理完成后立即卸载释放显存（中断/正常完成均触发；
        # 下次运行由「引用失效保护」逻辑自动重新加载）
        if llm is not None and bool(卸载模型):
            t_unload = _wp_log("「卸载模型」开关触发 unload")
            _WpLlamaStorage.unload()
            _wp_log("「卸载模型」开关触发 unload", t_unload)

        if mm.processing_interrupted():
            raise mm.InterruptProcessingException()

        _wp_log("==== 提示词对话节点 run 总耗时 ====", t_total)
        reply = skill_hint + text.lstrip().removeprefix(": ").strip()
        # 回复双通道输出：ui 通道发前端聊天框，「回复文本」端口原样输出给下游节点
        return {"ui": {"reply": [reply]}, "result": (reply,)}


NODE_CLASS_MAPPINGS = {
    "WpPromptAgent": WpPromptAgent,
}


# 技能清单接口：前端节点创建/重建时拉取，刷新「使用技能」下拉框选项，
# 让新增/删除技能文件后无需重启 ComfyUI 也无需刷新页面即可在下拉框中出现
@PromptServer.instance.routes.get("/wp_node/prompt_agent/skills")
async def _wp_prompt_agent_skills(request):
    return web.json_response({"skills": _skill_list()})

NODE_DISPLAY_NAME_MAPPINGS = {
    "WpPromptAgent": "🐳 WP 提示词对话",
}