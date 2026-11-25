# -*- coding: utf-8 -*-
"""
自检_提示词包.py —— H3 分段提示词包机器校验层【2026-11-24 三层架构改造新增】

对应 SKILL.md「不变量契约」I1/I2/I3/I5/I6/I7/I9/I10 的可机器判定部分
（I4 绑定零虚构、I8 空间调度的人工终审项不在本脚本职责内）。

用法：
  python 自检_提示词包.py <总控卡分段包.md路径>
退出码：0 = 无 FAIL（可有 WARN，需人工裁量）；1 = 存在 FAIL，不得交付。

判级说明：
  [FAIL] 违反不变量，必须回改提示词包后重跑
  [WARN] 机器计数/启发式命中，需人工裁量（含合法豁免场景）
  [PASS] 通过
"""
import re
import sys
import io
from pathlib import Path

# 仅当 stdout 是标准 TextIOWrapper（带 .buffer）时才做 UTF-8 重定向；
# 被 import 复用时（如提示词对话节点），ComfyUI-Manager 会把 sys.stdout 换成
# ComfyUIManagerLogger（无 .buffer），此处无条件访问 .buffer 会 AttributeError。
# 防御：无 .buffer 时跳过重定向，由调用方负责隔离。
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FRAME_TABLE = {73: 3, 90: 4, 124: 5, 141: 6, 158: 7}  # 帧数 -> 整秒
SUB_T = re.compile(r"^[-*]?\s*(\d+(?:\.\d+)?)s?\s*[–—~\-]\s*(\d+(?:\.\d+)?)s\s*(?:[：:【\[]|$)")  # 兼容「X–Ys【峰值/冲击帧标记】：」格式【2026-11-24 带标记子段漏计修订】
SHOT_T = re.compile(r"^镜头\s*(\d+)\s*[｜|]\s*(\d+(?:\.\d+)?)s?\s*[–—~\-]\s*(\d+(?:\.\d+)?)s")  # s? 兼容「3s–7s」整数起点写法【2026-11-24 单份25s事故修复】
MUTE_WORDS = ("静默", "静音", "完全无声", "归零")
LIP_WORDS = ("嘴唇轻启", "嘴唇微张", "欲言又止地张嘴", "开口欲言", "做出道歉姿态", "做出念白", "做出呼喊姿态", "张嘴")
REENTRY_WORDS = ("重新", "再次", "又一遍", "重复一遍")
# I7 事件唯一性计数对象：动作态动词（正文叙述里出现即计一次）
ACTION_VERBS = ("视线交汇", "交汇", "相碰", "擦肩", "转身", "停步", "低头", "视线移回", "视线抬起")


def load_text(text):
    """纯文本解析入口：接受提示词包全文文本（不落盘），返回 (text, head, segs)。

    供「提示词对话节点」复用——节点 import 本模块后直接把模型生成的文本喂进来跑校验，
    避免复刻解析逻辑造成口径漂移。【2026-11-24 节点校验闭环新增】
    """
    parts = text.split("---")
    head = parts[0]
    segs = []
    # 兼容两种分段格式：【2026-11-24 修复：支持「【段N 提示词】」标题式，无 --- 分隔符】
    for p in parts[1:]:
        m = re.search(r"段\s*(\d+)\s*提示词", p)
        if m:
            segs.append({"no": int(m.group(1)), "text": p, "title": m.group(0)})
    if not segs:
        # 标题式：【段N 提示词】出现在全文任意处
        for m in re.finditer(r"【段(\d+)\s*提示词】(.*?)(?=【段\d+\s*提示词】|$)", text, re.S):
            segs.append({"no": int(m.group(1)), "text": m.group(2), "title": m.group(0)})
        # head 取第一个段标题之前的全部文本
        if segs:
            head = text[: text.find(segs[0]["title"])]
    if not segs:
        # 第三种格式：【--- 分隔 + 各段直接以「整体基调：」开头，无段标题】（25s v4 实测格式）【2026-11-24 v4 格式支持新增】
        for p in parts[1:]:
            if re.search(r"^整体基调[：:]", p, re.M) and re.search(r"^参考图绑定", p, re.M):
                segs.append({"no": len(segs) + 1, "text": p, "title": f"段{len(segs)+1}（---分隔无标题式）"})
    if not segs:
        # 单份完整提示词格式【2026-11-24 单份25s事故新增：无总控卡/无分段，整体作为一个段跑内容类检查】
        if re.search(r"^整体基调[：:]", text, re.M) and re.search(r"^镜头\s*1\s*[｜|]", text, re.M):
            # 排除 --- 多段式误入单份模式（多段各有整体基调时不应合并为单份）
            n_tones = len(re.findall(r"^整体基调[：:]", text, re.M))
            if n_tones <= 1:
                segs = [{"no": 1, "text": text, "title": "单份完整提示词", "single": True}]
                head = ""
    if not segs and parts[0].startswith("【总控卡】"):
        head = parts[0]
    return text, head, segs


def load(path):
    """文件路径入口：读文件后走 load_text 纯文本解析。"""
    text = Path(path).read_text(encoding="utf-8")
    return load_text(text)


def check_total_duration(segs, rep):
    """I14 总时长上限：单份完整提示词末时刻 >15s → FAIL，应转分段包。【2026-11-24 单份25s事故新增】
    【2026-11-24 10s 误分段修订：阈值 7s→15s——用户拍板「>15s 才默认分段；≤15s 且未明确要求分段则不分段」，
    10s 输入（无分段意图）被误拆 2 段即旧阈值 7s 所致；单份提示词 ≤15s 属合法，不再拦。】"""
    if not segs or not segs[0].get("single"):
        return
    last = 0.0
    for m in re.finditer(r"镜头\s*\d+\s*[｜|]\s*(\d+(?:\.\d+)?)s?\s*[–—~\-]\s*(\d+(?:\.\d+)?)s", segs[0]["text"]):
        last = max(last, float(m.group(2)))
    if last > 15.0:
        rep.append(("FAIL", "I14", f"单份完整提示词总时长 {f2s(last)}s > 15s——超过单份默认分段阈值，应转「总控卡+分段包」路径（>15s 默认分段；≤15s 且用户未要求分段则保持单份，禁止擅自分段）"))


def get_tone(seg_text):
    m = re.search(r"^整体基调：(.+?)$", seg_text, re.M)
    return m.group(1).strip() if m else None


def get_binding_block(seg_text):
    m = re.search(r"参考图绑定（[^）]*）：\n(.*?)\n叙事顺序", seg_text, re.S)
    return m.group(1).strip() if m else None


def get_audio_lines(seg_text):
    m = re.search(r"音效设计（[^）]*）：\n((?:[-*].+\n?)+)", seg_text)
    return m.group(1) if m else ""


def get_body_lines(seg_text):
    """叙事顺序之后的镜头+子段正文（不含绑定/音效/负面）"""
    m = re.search(r"叙事顺序：.*?\n(.*?)\n音效设计", seg_text, re.S)
    return m.group(1) if m else ""


def f2s(x):
    x = round(float(x), 2)
    return f"{x:g}"


SECS_TO_FRAMES = {3: 73, 4: 90, 5: 124, 6: 141, 7: 158}
SECS_OPTIONS = (3, 4, 5, 6, 7)


def best_combo(declared, min_segs=1, max_segs=20):
    """组合择优：给定声明总时长（整秒），枚举段数×段长组合，返回 Σ帧÷24 与声明残差最小且 ≤0.5s 的方案。

    【2026-11-24 组合择优新增】此前 I1 只查「帧数合法+总时长=段和」不查最优性——
    10s 误分段包实测：6+4=265 帧=11.04s 残差 1.04s 超限，而 5+5=248 帧=10.33s 残差 0.33s 才是合规最优。
    网格步长 17 帧≈0.71s，整秒组合必有残差，须枚举找最小残差组合而非"按当前拆分执行并接受缓冲"。
    优先级：段数少优先（切点少、衔接成本低），段数相同再比残差小。
    返回 (段数, 残差, [(段秒, 帧), ...], 帧和, 实算秒)，无可行组合返回 None。"""
    best = None
    for n in range(min_segs, max_segs + 1):
        if n > 6:
            break  # 段数超过 6 不再枚举（25s 最优也只需 5 段；更大 n 由剪枝+声明秒约束自然规避）
        lo, hi = 3 * n, 7 * n
        if declared < lo or declared > hi:
            continue
        for combo in _iter_combos(n):
            if sum(combo) != declared:
                continue
            frames = [SECS_TO_FRAMES[s] for s in combo]
            total_frames = sum(frames)
            real = total_frames / 24.0
            rdiff = abs(declared - real)
            if rdiff <= 0.5 and (best is None or (n, rdiff) < (best[0], best[1])):
                best = (n, rdiff, list(zip(combo, frames)), total_frames, real)
    return best


def _iter_combos(n):
    """迭代 n 段整秒的全部组合（3..7），字典序。段数上限 20 时 5^20 不可枚举，实际只在 sum==declared 约束下配合剪枝，
    故改为只迭代段数和（sum==declared）的组合——用整数划分式生成，避免指数爆炸。"""
    # 简化：只对 n<=6 做全组合枚举（5^6=15625 可接受），更大 n 由 best_combo 的剪枝+声明秒约束自然跳过
    if n > 6:
        return iter(())
    from itertools import product
    return product(SECS_OPTIONS, repeat=n)


def check_frame_budget(head, segs, rep):
    rows = re.findall(r"段\s*(\d+)\s*[｜|]\s*执行填\s*(\d+)\s*帧\s*[｜|]\s*提示词写\s*(\d+)\s*s\s*[｜|]\s*全局\s*([\d.]+)\s*[–—~\-]\s*([\d.]+)\s*s", head)
    if not rows:
        rep.append(("FAIL", "I1", "总控卡未解析到「分段预算表」行（帧数前置格式）"))
        return
    ok = True
    prev_end = 0.0
    for no, frames, secs, g0, g1 in rows:
        frames, secs = int(frames), int(secs)
        if frames not in FRAME_TABLE:
            rep.append(("FAIL", "I1", f"段{no} 帧{frames} 不在整秒配对表 {{73,90,124,141,158}}"))
            ok = False
        elif FRAME_TABLE[frames] != secs:
            rep.append(("FAIL", "I1", f"段{no} 帧{frames} 应配 {FRAME_TABLE[frames]}s，预算表写 {secs}s"))
            ok = False
        if abs(float(g0) - prev_end) > 0.01:
            rep.append(("FAIL", "I1", f"段{no} 全局起点 {f2s(g0)}s 与上段末尾 {f2s(prev_end)}s 不连续"))
            ok = False
        prev_end = float(g1)
    total = sum(int(r[1]) for r in rows)
    # I1 扩充：总控卡声明总时长必须等于各段整秒之和（25s v4 实测：声明 25s 只分了 23s，还编"余2s并入尾平台"伪解释）【2026-11-24 v4 修订】
    m_total = re.search(r"总时长[：:]\s*(\d+)\s*s", head)
    if m_total:
        declared = int(m_total.group(1))
        seg_sum = sum(int(r[2]) for r in rows)
        if declared != seg_sum:
            rep.append(("FAIL", "I1", f"总控卡声明总时长 {declared}s ≠ 各段整秒之和 {seg_sum}s（缺 {declared - seg_sum}s——禁止'余Ns并入尾平台'类伪解释：141帧=6s 封顶，帧数无弹性；须重新分配整秒直至补齐）"))
            ok = False
        # I1 扩充：实际帧时长对账（00035 实测：声明 25s、581 帧实算 24.208s、差 0.79s——旧公式向上超 632、新公式就近亏 581，换算公式只保帧数合法、不保总长对齐；整秒之和对账通过≠帧实算对账通过）【2026-11-24 00035 修订】
        real = total / 24.0
        rdiff = abs(declared - real)
        # I1 扩充：组合择优【2026-11-24 组合择优新增】——枚举最小残差组合，替代"按当前拆分执行并接受缓冲"。
        # 10s 误分段包实测：6+4=265 帧=11.04s 残差 1.04s 超限，而 5+5=248 帧=10.33s 残差 0.33s 才是合规最优。
        best = best_combo(declared)
        if rdiff > 0.5:
            msg = (f"实际帧时长对账：声明 {declared}s ≠ 帧数实算 {f2s(real)}s（差 {f2s(rdiff)}s）——网格步长 17 帧≈0.71s，整秒组合必有残差，须枚举最小残差组合")
            if best:
                secs_str = "+".join(str(s) for s, _ in best[2])
                msg += (f"；组合择优：{secs_str}={best[3]} 帧={f2s(best[4])}s 残差 {f2s(best[1])}s ≤0.5s 才是合规最优（当前拆分非最优，应改用此组合）")
            else:
                msg += "；机器枚举无 ≤0.5s 可行组合——须增加段数或改声明总时长"
            rep.append(("FAIL", "I1", msg))
            ok = False
        elif best and best[1] < rdiff - 0.001:
            secs_str = "+".join(str(s) for s, _ in best[2])
            rep.append(("WARN", "I1", f"实际帧时长对账通过（残差 {f2s(rdiff)}s），但存在更优组合 {secs_str}={best[3]} 帧={f2s(best[4])}s 残差 {f2s(best[1])}s——建议择优（非强制）"))
        else:
            rep.append(("PASS", "I1", f"实际帧时长对账：{total} 帧={f2s(real)}s，与声明 {declared}s 残差 {f2s(rdiff)}s ≤0.5s，且为最小残差组合"))
    if ok:
        rep.append(("PASS", "I1", f"预算表 {len(rows)} 段全配对合规，帧数和 {total}（成片验收：成片总帧数应等于此值，超出即执行侧秒数吸附）"))


def check_time_coverage(seg, rep, budget=None):
    shots, subs = [], []
    for line in seg["text"].splitlines():
        line = line.strip()
        m = SHOT_T.match(line)
        if m:
            shots.append((int(m.group(1)), float(m.group(2)), float(m.group(3))))
        m = SUB_T.match(line)
        if m:
            subs.append((float(m.group(1)), float(m.group(2))))
    if not shots:
        rep.append(("FAIL", "I2", f"段{seg['no']} 未解析到「镜头N｜X–Ys」行"))
        return
    if abs(shots[0][1]) > 0.01:
        rep.append(("FAIL", "I2", f"段{seg['no']} 首镜头起点 {f2s(shots[0][1])}s ≠ 0.0s"))
    prev = shots[0][1]
    for no, a, b in shots:
        if abs(a - prev) > 0.01:
            rep.append(("FAIL", "I2", f"段{seg['no']} 镜头{no} 起点 {f2s(a)}s 与上一镜头末尾 {f2s(prev)}s 有空洞/重叠"))
        prev = b
    last = shots[-1][2]
    # 【2026-11-24 00035 修订】原要求段末整秒收尾；现允许 0.5s 步长（镜头切至 X.5s 适配段实际帧秒 6.583/5.167 等）
    if abs(last * 2 - round(last * 2)) > 0.001:
        rep.append(("FAIL", "I2", f"段{seg['no']} 段末 {f2s(last)}s 非 0.5s 步长（原整秒收尾已放宽，适配 00035 帧实算时间轴）"))
    for a, b in subs:
        if b <= a:
            rep.append(("FAIL", "I2", f"段{seg['no']} 子段 {f2s(a)}–{f2s(b)}s 区间非法（b≤a）"))
    rep.append(("PASS", "I2", f"段{seg['no']} 镜头链 0.0→{f2s(last)}s 连续整秒收尾"))
    # I2 扩充：镜头时间轴末值不得超段实际秒（00035 实测：7s 段实际 158/24=6.58s，镜头3 写至 7.0s，末 0.4s 内容被吃掉，段尾平台提前 0.4s 落地→衔接缝节奏压缩感）【2026-11-24 00035 修订】
    # 【2026-11-24 10s 分段2 新探针修订：段内前 3 行无「执行填N帧」时回退用总控卡预算表帧数——新包形制把帧数只写在预算表，段内不重复，导致超限检查被静默跳过（实测段2 镜头链 0→10s 塞进 124 帧=5.17s 的段）；同时把音效/子段时间戳并入超限判定（音效行同写至 10.0s）】
    m_f = re.search(r"执行填\s*(\d+)\s*帧", seg.get("title", "") + "\n" + "\n".join(seg["text"].splitlines()[:3]))
    frames_ref, src = None, "段内"
    if m_f:
        frames_ref = int(m_f.group(1))
    elif budget and seg["no"] in budget:
        frames_ref = int(budget[seg["no"]])
        src = "总控卡预算表"
    if frames_ref:
        real_sec = frames_ref / 24.0
        tmax = last
        for a, b in subs:
            if b > tmax:
                tmax = b
        over = tmax - real_sec
        if over > 0.01:
            rep.append(("FAIL", "I2", f"段{seg['no']} 镜头/音效时间轴最大末值 {f2s(tmax)}s 超段实际秒 {f2s(real_sec)}s（{frames_ref}帧/24fps，帧数取自{src}，超 {f2s(over)}s）——被吃内容导致段尾平台提前落地、衔接节奏压缩；镜头/音效末值须 ≤ 段实际秒（如 158 帧段切至 6.5s、124 帧段切至 5.0s）"))
        else:
            rep.append(("PASS", "I2", f"段{seg['no']} 镜头/音效时间轴最大末值 {f2s(tmax)}s ≤ 段实际秒 {f2s(real_sec)}s（帧数取自{src}）"))


def check_binding(segs, rep):
    blocks = {}
    for seg in segs:
        blk = get_binding_block(seg["text"])
        if blk is None:
            rep.append(("FAIL", "I3", f"段{seg['no']} 缺「参考图绑定」区块或后接「叙事顺序」结构"))
            continue
        nums = [int(n) for n in re.findall(r"@Image(\d+)（", blk)]
        if nums != list(range(1, len(nums) + 1)):
            rep.append(("FAIL", "I3", f"段{seg['no']} @Image 编号非从 1 连续：{nums}"))
        if "标签用途映射" not in blk:
            rep.append(("FAIL", "I3", f"段{seg['no']} 绑定区块缺「标签用途映射」行"))
        for n in nums:
            if f"@Image{n} 锁定" not in blk:
                rep.append(("WARN", "I3", f"段{seg['no']} 映射行缺 @Image{n} 的锁定条目"))
        blocks[seg["no"]] = blk
    if len(blocks) > 1:
        first = next(iter(blocks.values()))
        diffs = [no for no, blk in blocks.items() if blk != first]
        if diffs:
            # 情绪链递进（表情由X转为Y）属合法设计：绑定漂移与合法递进由人工裁量
            rep.append(("WARN", "I3", f"段{diffs} 绑定区块与段1 不逐字一致——若差异仅为表情气质递进行属合法设计，若涉及外观/服饰/场景行即为漂移，须人工核对"))
        else:
            all_nums = [int(n) for b in blocks.values() for n in re.findall(r"@Image(\d+)（", b)]
            top = max(all_nums) if all_nums else 0
            rep.append(("PASS", "I3", f"{len(blocks)} 段绑定区块逐字一致，@Image1..{top} 连续"))


def check_tone(head, segs, rep):
    # 总控卡基调区合法形态：①同行「- 整体基调逐字复制区：{文本}」②「- 整体基调逐字复制区：」换行后「整体基调：{文本}」
    # 【2026-11-24 误报修复：兼容两种形态】
    master = None
    m = re.search(r"整体基调逐字复制区[：:]\s*(.+?)$", head, re.M)
    if m and m.group(1).strip():
        master = m.group(1).strip()
    else:
        m2 = re.search(r"整体基调逐字复制区[：:][^\n]*\n\s*(?:[-*]\s*)?(?:整体基调[：:])?\s*(.+?)$", head, re.M)
        if m2 and m2.group(1).strip():
            master = m2.group(1).strip()
    if master:
        # 剥离可能被吞进 master 的「整体基调：」/「- 」前缀（\s* 会跨换行）
        master = re.sub(r"^(?:[-*]\s*)?(?:整体基调[：:])?\s*", "", master).strip()
    if not master:
        rep.append(("FAIL", "I5", "总控卡缺「整体基调逐字复制区」行"))
        return
    bad = []
    for seg in segs:
        t = get_tone(seg["text"])
        if t != master:
            bad.append(seg["no"])
    if bad:
        rep.append(("FAIL", "I5", f"段{bad} 整体基调与总控卡基调区不一致（要求逐字复制）"))
    else:
        rep.append(("PASS", "I5", f"{len(segs)} 段整体基调与总控卡逐字一致"))


def check_reentry(segs, rep):
    hits, seen = [], set()
    for seg in segs[1:]:
        body = get_body_lines(seg["text"])
        for line in body.splitlines():
            line = line.strip()
            for w in REENTRY_WORDS:
                if w in line and (seg["no"], w, line) not in seen:
                    seen.add((seg["no"], w, line))
                    hits.append((seg["no"], w, line[:60]))
    if hits:
        for no, w, ctx in hits:
            rep.append(("WARN", "I6", f"段{no} 疑似承接区/正文重触发措辞「{w}」：{ctx}…（承接区只写完成态保持）"))
    else:
        rep.append(("PASS", "I6", "未检出「重新/再次/又一遍」类重触发措辞"))


def check_verb_uniqueness(segs, rep):
    full_body = "\n".join(get_body_lines(s["text"]) for s in segs)
    for v in ACTION_VERBS:
        n = full_body.count(v)
        if n >= 2:
            rep.append(("WARN", "I7", f"动作动词「{v}」全包出现 {n} 次动作态（I7 上限 1 次，偷看被抓类豁免至 2；其余应改写为状态延续）"))
    rep.append(("PASS", "I7", "动词计数完成（上方 WARN 需人工裁量）"))


def check_dialog(segs, rep):
    bad = []
    for seg in segs:
        has_no_dialog = "无台词" in seg["text"] or "不生成清晰说话口型" in seg["text"]
        body = get_body_lines(seg["text"])
        for w in LIP_WORDS:
            if w in body:
                bad.append((seg["no"], w))
    # 台词口径一致性【2026-11-24 克苏鲁包修订：段3 自造台词"这、这是什么东西？"且音效行复述台词，其余三段声明无台词——I9 只查"声明无台词段的正文开口词"，声明有台词段免查，但包内口径分裂=台词是生成侧自加非用户指令；全包台词口径须统一】
    has_dialog_segs = [seg["no"] for seg in segs if ("台词" in seg["text"] and "无台词" not in seg["text"] and "不生成清晰说话口型" not in seg["text"])]
    no_dialog_segs = [seg["no"] for seg in segs if ("无台词" in seg["text"] or "不生成清晰说话口型" in seg["text"])]
    if has_dialog_segs and no_dialog_segs:
        rep.append(("FAIL", "I9", f"包内台词口径分裂：段{has_dialog_segs} 含台词/口型同步描述，段{no_dialog_segs} 声明无台词——台词须来自用户指令；用户未给台词时全包统一无台词（台词段改写为喉结滚动/倒吸气/瞳孔收缩等替代轨道）"))
    for no, w in bad:
        rep.append(("FAIL", "I9", f"段{no} 无台词场景正文含开口类动作词「{w}」（灰区词诱导凭空台词）"))
    if not bad:
        nd = sum(1 for s in segs if "无台词" in s["text"])
        rep.append(("PASS", "I9", f"{nd}/{len(segs)} 段声明无台词，正文未检出开口类动作词"))


def check_seam_audio(segs, rep):
    bad_mute, bad_peak = [], []
    for i, seg in enumerate(segs):
        audio = get_audio_lines(seg["text"])
        lines = [l.strip() for l in audio.splitlines() if l.strip()]
        is_last = (i == len(segs) - 1)
        tail = lines[-1] if lines else ""
        if not is_last:
            for w in MUTE_WORDS:
                # 排除否定句（"不归零"是合规声明，非静默描述）
                if w in tail and ("不" + w) not in tail:
                    bad_mute.append((seg["no"], w))
        for l in lines:
            m = SUB_T.match(l)
            if m and "峰值" in l and "无峰值" not in l and "无单点峰值" not in l:
                if float(m.group(1)) < 2.0:
                    bad_peak.append((seg["no"], l[:40]))
    for no, w in bad_mute:
        rep.append(("FAIL", "I10", f"段{no} 非末段段尾含「{w}」（须衰减至低频余震+底噪延续，仅末段允许静默收束）"))
    for no, l in bad_peak:
        rep.append(("FAIL", "I10", f"段{no} 音效峰值距段首 <2s：{l}…"))
    if not bad_mute and not bad_peak:
        rep.append(("PASS", "I10", "非末段无静默收尾，音效峰值均距段首 ≥2s"))


def check_bgm(segs, rep):
    """I11 无BGM 声明：音效设计声明无BGM 时，每段负面约束必须含无背景音乐禁止项。【2026-11-24 00033 新增】
    【2026-11-24 克苏鲁包修订：声明无BGM 但音效行写"紧张悬疑配乐"且伪造"已按用户要求保留配乐"括号注记绕过负面禁词——配乐/弦乐/管弦/合成器词出现在音效行同样违规（负面约束只挡生成方向，音效行是正向指令更先中毒）】"""
    bad = []
    bad_audio = []
    MUSIC_WORDS = ("配乐", "弦乐", "管弦", "合成器", "BGM", "bgm", "背景音乐")
    for seg in segs:
        # 「无BGM」声明位于音效设计 header 行（get_audio_lines 只取 header 之后的行），须查全段文本
        declares_no_bgm = "无BGM" in seg["text"] or "无 BGM" in seg["text"]
        neg = ""
        m = re.search(r"负面约束[：:]\s*(.+?)$", seg["text"], re.S)
        if m:
            neg = m.group(1)
        has_bgm_ban = ("背景音乐" in neg) or ("BGM" in neg) or ("配乐" in neg)
        if declares_no_bgm and not has_bgm_ban:
            bad.append(seg["no"])
        # 音效行配乐词检查：声明无BGM 的段，其音效设计行含配乐类词即违规（括号注记"已按用户要求保留配乐"不能豁免——用户没说过，生成侧不得代用户决策）
        if declares_no_bgm:
            audio = get_audio_lines(seg["text"])
            for w in MUSIC_WORDS:
                if w in audio and ("无" + w) not in audio and ("不出现" + w) not in audio:
                    bad_audio.append((seg["no"], w))
    if bad:
        for no in bad:
            rep.append(("FAIL", "I11", f"段{no} 音效设计声明无BGM，但负面约束缺「无背景音乐」禁止项（00033 实测：仅声明失效，成片出现弦乐/悬疑合成器/管弦乐）"))
    if bad_audio:
        for no, w in bad_audio:
            rep.append(("FAIL", "I11", f"段{no} 声明无BGM 但音效行含配乐类词「{w}」——音效行是正向指令优先于负面约束中毒（实测克苏鲁包：段4 音效写'紧张悬疑配乐'还加'已按用户要求保留配乐'注记，用户从未说过；全片基调已声明无BGM，须删配乐行改写环境音效）"))
    if not bad and not bad_audio:
        rep.append(("PASS", "I11", "无BGM 声明与负面约束禁止项配套齐全"))


def check_image_registry(head, segs, rep):
    """I4 配套：参考图登记。登记行存在时核对编号-用途类型（编号错位 FAIL）+ 绑定不得超出登记数。【2026-11-24 25s 测试包增强】
    【2026-11-24 第5次复发修订：单份模式 head 为空导致本检查对单份提示词完全失明——head 无登记行时回退从全文（首段文本）搜登记行】"""
    m = re.search(r"参考图登记[：:]\s*(.+)$", head, re.M)
    scope_note = "总控卡"
    if not m:
        # 单份模式：从首段文本（绑定区附近）搜登记行
        for seg in segs:
            m2 = re.search(r"参考图登记[：:]\s*(.+)$", seg["text"], re.M)
            if m2:
                m, scope_note = m2, f"单份提示词（段{seg['no']}内）"
                break
    if not m:
        rep.append(("FAIL", "I4", "缺「参考图登记：@Image1=…（N=用户上传图数）」行——绑定槽位无唯一事实源，机器无法核对虚构槽位（2026-11-24 起单份提示词同样强制；此前单份缺登记行=机器层失明，第5次场景槽位虚构即经此路径漏过）"))
        return
    reg_text = m.group(1)
    reg_nums = [int(n) for n in re.findall(r"@Image(\d+)", reg_text)]
    if not reg_nums:
        rep.append(("WARN", "I4", "参考图登记行存在但未解析到 @ImageN 编号"))
        return
    reg_max = max(reg_nums)
    # 登记行完整性：声明"共N张"但实际登记条目不足 → WARN（25s v4 实测：写共2张却只登记@Image1，段3/4 绑定@Image2 被误判溢出）【2026-11-24 v4 修订】
    m_cnt = re.search(r"共\s*(\d+)\s*张", reg_text)
    if m_cnt and len(reg_nums) < int(m_cnt.group(1)):
        rep.append(("WARN", "I4", f"登记行声明「共{m_cnt.group(1)}张」但只登记了 {len(reg_nums)} 条（@Image1..{reg_max}）——登记行不完整：应逐张列出 @ImageN=对象；下方若有溢出 FAIL，先核对此项"))
    # 登记-绑定 用途类型核对：登记对象名 → 类型词
    def obj_kind(name):
        if re.search(r"兽|怪|龙|妖|魔|生物|机甲|异星", name):
            return "creature"
        if re.search(r"男|女|人|子|少女|少年|孩|老者|角色", name):
            return "person"
        if re.search(r"街|市|场|景|殿|屋|城|庭|室|空间|厅", name):
            return "scene"
        return "other"
    reg = {}
    for mm in re.finditer(r"@Image(\d+)\s*[=＝]\s*([^\n；;（(]*)", reg_text):
        reg[int(mm.group(1))] = mm.group(2).strip()
    mismatches, overflow = [], []
    for seg in segs:
        blk = get_binding_block(seg["text"]) or ""
        nums = [int(n) for n in re.findall(r"@Image(\d+)（", blk)]
        if nums and max(nums) > reg_max:
            overflow.append((seg["no"], max(nums)))
        for mm in re.finditer(r"@Image(\d+)（([^）]*)绑定）", blk):
            n, usage = int(mm.group(1)), mm.group(2)
            if n in reg:
                kind = obj_kind(reg[n])
                # 场景/目标/道具类绑定用途是否与登记对象类型自洽
                if kind == "creature" and ("场景" in usage or "环境" in usage):
                    mismatches.append((seg["no"], n, f"登记为「{reg[n]}」(生物类)却绑定用途「{usage}」——编号错位：模型会拿该图当{usage}参考"))
                elif kind == "scene" and ("主体" in usage or "目标" in usage or "道具" in usage):
                    mismatches.append((seg["no"], n, f"登记为「{reg[n]}」(场景类)却绑定用途「{usage}」——编号错位"))
                elif kind == "person" and ("场景" in usage or "环境" in usage):
                    mismatches.append((seg["no"], n, f"登记为「{reg[n]}」(人物类)却绑定用途「{usage}」——编号错位"))
    for no, mx in overflow:
        rep.append(("FAIL", "I4", f"段{no} 绑定 @Image{mx} 超出登记数 @Image{reg_max}（虚构参考图槽位；无场景图时应写文字场景描述）"))
    for no, n, msg in mismatches:
        rep.append(("FAIL", "I3/I4", f"段{no} @Image{n} 编号错位：{msg}"))
    if not mismatches and not overflow:
        rep.append(("PASS", "I4", f"参考图登记 {len(reg_nums)} 张，绑定编号未超登记、登记-用途类型自洽"))


def check_process_anchor(segs, rep):
    """I12 过程锚（启发式 WARN）：相向/接近类场景，子段须有间距/运动状态锚点，防终态吸引提前收敛。【2026-11-24 00033 新增】"""
    approaching = re.compile(r"(相向|迎面|靠近|距离.{0,6}缩短)")
    anchors = re.compile(r"(间距|相距|约.{0,4}步|距离约|保持匀速|未停下|不停步|仍在前行|仍在行走)")
    weak, has_approach = [], False
    for seg in segs:
        body = get_body_lines(seg["text"])
        if approaching.search(body):
            has_approach = True
            if not anchors.search(body):
                weak.append(seg["no"])
    if has_approach and weak:
        rep.append(("WARN", "I12", f"段{weak} 含相向/接近描写但无间距或运动状态锚点（终态吸引风险：模型会提前收敛到相遇/停步终态——00030/00033 均实测复现）"))
    elif has_approach:
        rep.append(("PASS", "I12", "接近类场景已含过程锚点"))
    else:
        rep.append(("PASS", "I12", "无接近类描写，不适用"))


CAMERA_PARAM_WORDS = ("焦距", "景深", "推近", "拉远", "横移", "跟拍", "仰拍", "俯拍", "平视", "机位", "广角", "长焦", "浅景深", "变焦", "升降", "摇镜")
PERF_TRACKS = {
    "眼神": ("视线", "目光", "瞳孔", "眼神", "看向", "望向", "瞥"),
    "面部": ("表情", "嘴角", "眉头", "脸颊", "面部", "下巴", "微笑", "抿"),
    "头肩": ("头", "肩", "颈部", "侧头", "颔首", "低头", "抬头"),
    "手部": ("手", "指尖", "袖", "握", "摊", "指", "抚"),
    "身体": ("身体", "重心", "姿态", "站", "步", "躯干", "前倾", "后仰", "僵"),
    "呼吸声音": ("呼吸", "喘", "屏息", "衣料", "布料", "脚步", "低吟"),
}


def check_content_density(segs, rep):
    """I13 内容密度：三槽结构/字数/运镜参数/表演轨道覆盖。【2026-11-24 00033+25s 密度诊断新增；同日 10s 单份密度修订：子段字数与运镜参数两项升 FAIL（算术级判定可硬拦——10s 单份实测镜头3/4 泛化运镜词+轨道3/6 漏过交付）；表演轨道维持 WARN（人物在场与否属语义裁量）】
    【2026-11-24 克苏鲁包单薄修订：新增镜头数下限 FAIL——实测 4 段各仅 1 个镜头糊满全段（5s/7s 单镜头），子段字数/运镜参数/轨道三项全绿仍结构单薄；规则=每镜头平均时长 ≤3s（5s 段 ≥2 镜头、7s 段 ≥3），v6 基准包 3-4 镜头/段全过】"""
    thin_subs, weak_camera, seg_track_cov = [], [], {}
    for seg in segs:
        body = get_body_lines(seg["text"])
        shot_no = 0
        shot_count = 0
        seg_end = 0.0
        sub_in_shot = 0
        cam_param_hits = 0
        for line in body.splitlines():
            s = line.strip()
            if SHOT_T.match(s):
                if shot_no and cam_param_hits == 0:
                    weak_camera.append((seg["no"], shot_no))
                m_shot = SHOT_T.match(s)
                shot_no = int(m_shot.group(1))
                shot_count += 1
                try:
                    seg_end = float(m_shot.group(3))
                except (ValueError, IndexError):
                    pass
                sub_in_shot = 0
                cam_param_hits = 0
                # 镜头 header 行本身含机位描写也算
                for w in CAMERA_PARAM_WORDS:
                    if w in s:
                        cam_param_hits += 1
            else:
                if s:
                    # 镜头描述行（机位/构图散文行）同样计入运镜参数计数
                    for w in CAMERA_PARAM_WORDS:
                        if w in s:
                            cam_param_hits += 1
            if SUB_T.match(s):
                sub_in_shot += 1
                is_carry = ("承接" in s) or ("延续" in s) or shot_no == 1
                if not is_carry and len(s) < 25:
                    thin_subs.append((seg["no"], shot_no, sub_in_shot, len(s), s[:40]))
                for w in CAMERA_PARAM_WORDS:
                    if w in s:
                        cam_param_hits += 1
        if shot_no and cam_param_hits == 0:
            weak_camera.append((seg["no"], shot_no))
        # 镜头数下限【2026-11-24 克苏鲁包单薄修订】
        if shot_count:
            needed = max(2, -(-int(seg_end) // 3))  # ceil(段秒/3)，下限2
            if shot_count < needed:
                rep.append(("FAIL", "I13", f"段{seg['no']} 仅 {shot_count} 个镜头覆盖 {f2s(seg_end)}s（下限 {needed}：每镜头平均时长须 ≤3s，5s 段 ≥2、7s 段 ≥3——单镜头糊满整段=无分镜切换的结构性单薄，子段写得再长也单薄）"))
            else:
                rep.append(("PASS", "I13", f"段{seg['no']} {shot_count} 个镜头覆盖 {f2s(seg_end)}s（≥下限 {needed}）"))
        # 表演轨道覆盖率
        cov = [k for k, words in PERF_TRACKS.items() if any(w in body for w in words)]
        seg_track_cov[seg["no"]] = cov
    if thin_subs:
        for no, shot, sub, n, ctx in thin_subs[:10]:
            rep.append(("FAIL", "I13", f"段{no} 镜头{shot} 子段{sub} 仅 {n} 字（<{25}）：{ctx}…（三槽结构：动作直述+可见细节+运镜参数）——单份与分段包同标【2026-11-24 升级为 FAIL】"))
    else:
        rep.append(("PASS", "I13", f"全部非承接子段 ≥25 字"))
    if weak_camera:
        for no, shot in weak_camera[:10]:
            rep.append(("FAIL", "I13", f"段{no} 镜头{shot} 未检出含参数的运镜/景深句式（泛化词'缓慢推近'不满足，须含焦距/速度/景深/机位高度等参数）——单份与分段包同标【2026-11-24 升级为 FAIL】"))
    else:
        rep.append(("PASS", "I13", "每镜头均含参数化运镜句式"))
    # 表演轨道：生活流/情绪类至少 4 轨道（弱启发）
    all_text = "".join(get_body_lines(s["text"]) for s in segs)
    full_cov = [k for k, words in PERF_TRACKS.items() if any(w in all_text for w in words)]
    if len(full_cov) < 4:
        rep.append(("WARN", "I13", f"表演轨道仅覆盖 {len(full_cov)}/6（{','.join(full_cov)}）——生活流/情绪类应按六轨道注入（眼神/面部/头肩/手部/身体/呼吸声音）"))
    else:
        rep.append(("PASS", "I13", f"表演轨道覆盖 {len(full_cov)}/6"))


def check_segment_density(segs, rep):
    """I13 分段密度专项（仅分段包模式调用）：分段后每段内容被稀释的结构性根因——
    每段 5s 里要塞「承接→推进→峰值→平台」整条起承转合，逼得每镜头只写 1~2 子段、单镜头信息薄。
    修法是约束「弧线分配」而非「字数」：
    ①每镜头子段数下限：分段模式下每个镜头 ≥2 个子段（承接镜头除外），
      否则子段级三槽无从展开——当前 I13 只数镜头不数子段，5s 段 2 镜头各 1 子段照样全绿；
    ②每段叙事弧线节点数：叙事顺序链 ≤3 节点（承接态不计），
      禁止把「起幅→蓄能→突进→命中→反馈→收尾」6+ 节点全弧线塞进单段。
    【2026-11-24 分段密度修订】"""
    for seg in segs:
        body = get_body_lines(seg["text"])
        if not body:
            continue
        # ② 叙事弧线节点数：取「叙事顺序：」行的箭头链
        m_narr = re.search(r"叙事顺序[：:]\s*(.+)$", seg["text"], re.M)
        if m_narr:
            chain = m_narr.group(1)
            # 节点 = 按 → 或 、 切分后的非空段；承接态（含"承接"）不计入
            nodes = [n.strip() for n in re.split(r"[→>、]", chain) if n.strip()]
            nodes = [n for n in nodes if "承接" not in n]
            if len(nodes) > 3:
                rep.append(("WARN", "I13", f"段{seg['no']} 叙事顺序链 {len(nodes)} 个节点（{chain.strip()}）——分段模式每段只承担一个节奏单元，禁把整条起承转合塞进单段（承接态不计，主节奏节点 ≤3；单镜头被切碎、信息稀释的根因）"))
        # ① 每镜头子段数下限（承接镜头豁免：承接区本就只写 1 个子段的延续态）
        shot_no = 0
        sub_in_shot = 0
        is_carry_shot = False
        carry_text = ""
        thin_shots = []

        def _check_carry_empty(segno, txt):
            """③ 承接区空写检查：承接镜头虽豁免子段数下限，但必须有内容——须含"微动态+氛围"类词，
            禁纯静态"镜头平稳/机位固定"空镜头。【2026-11-24 承接区空写修订】"""
            if not txt:
                return
            static_signal = any(w in txt for w in ("镜头平稳", "机位固定", "画面延续", "画面稳定", "镜头停", "保持稳定", "机位平稳"))
            dynamic_words = ("流动", "抖动", "起伏", "渐暗", "渐亮", "扩散", "悬浮", "沉降", "翻卷", "涌动", "闪烁", "余晖", "余光", "明灭", "喘息", "呼吸", "飘", "扬", "卷", "绕", "涌动", "浮动", "颤", "微动", "余震", "余烟", "升腾", "落下", "弹起", "压暗", "低吼", "拉长")
            has_dynamic = any(w in txt for w in dynamic_words)
            if static_signal and not has_dynamic:
                rep.append(("WARN", "I13", f"段{segno} 承接区（镜头1）写成纯静态空镜头——只有\"镜头平稳/机位固定\"停死措辞、无微动态与氛围细节，每段约 1s（20% 时长）被零信息量浪费；承接区须写延续上段末态的画面细节+氛围+至少一个微动作（烟尘流动/能量余晖渐暗/呼吸起伏/毛发随风抖等）【2026-11-24 承接区空写修订】"))

        for line in body.splitlines():
            s = line.strip()
            m_shot = SHOT_T.match(s)
            if m_shot:
                if shot_no and sub_in_shot < 2 and not is_carry_shot:
                    thin_shots.append((shot_no, sub_in_shot))
                if is_carry_shot:
                    _check_carry_empty(seg["no"], carry_text)
                shot_no = int(m_shot.group(1))
                sub_in_shot = 0
                # 承接镜头判定：镜头标题含「承接/延续」，或该镜头子段文本含承接词【2026-11-24 承接区空写修订】
                is_carry_shot = ("承接" in s) or ("延续" in s)
                carry_text = s if is_carry_shot else ""
            elif SUB_T.match(s):
                sub_in_shot += 1
                if ("承接" in s) or ("延续" in s):
                    is_carry_shot = True
                if is_carry_shot:
                    carry_text += s + " "
        if shot_no and sub_in_shot < 2 and not is_carry_shot:
            thin_shots.append((shot_no, sub_in_shot))
        if is_carry_shot:
            _check_carry_empty(seg["no"], carry_text)
        if thin_shots:
            for no, n in thin_shots:
                rep.append(("FAIL", "I13", f"段{seg['no']} 镜头{no} 仅 {n} 个子段（分段模式每镜头 ≥2 子段：子段级三槽须充分展开，单镜头只写 1 个子段=动作直述+可见细节+运镜参数挤不进一行的稀薄）——这是分段内容稀释的直接结构病【2026-11-24 分段密度修订】"))
        else:
            rep.append(("PASS", "I13", f"段{seg['no']} 每镜头均 ≥2 子段（子段级三槽充分展开）"))


def check_light_anchor(segs, rep):
    """I16 天光锚：剧情含天光转变（天黑/入夜/骤暗/黎明）时，转变点之后每段每个镜头组须带天光锚词。【2026-11-24 00034 成片事故新增】"""
    TRANSIT = ("天黑", "入夜", "骤暗", "转暗", "天色转", "入黄昏", "黎明", "天亮")
    ANCHORS = ("夜", "昏暗", "暗淡", "灯笼", "冷调", "冷光", "阴云", "乌云", "幽暗", "昏黄", "暗紫", "冷暗", "黑影", "压暗", "暗沉", "尘雾", "冷灰", "冷黑")
    # 找到转变首次出现的段号
    first_transit = None
    for seg in segs:
        body = get_body_lines(seg["text"])
        if first_transit is None and any(t in body for t in TRANSIT):
            first_transit = seg["no"]
    if first_transit is None:
        return
    weak = []
    for seg in segs:
        if seg["no"] < first_transit:
            continue
        body = get_body_lines(seg["text"])
        if not body:
            continue
        # 按镜头组切分，逐组查锚
        groups = re.split(r"(?=^镜头\s*\d+)", body, flags=re.M)
        shot_no = 0
        for g in groups:
            m = re.match(r"镜头\s*(\d+)", g)
            if not m:
                continue
            shot_no = int(m.group(1))
            if not any(a in g for a in ANCHORS):
                weak.append((seg["no"], shot_no))
    if weak:
        for no, shot in weak[:12]:
            rep.append(("WARN", "I16", f"段{no} 镜头{shot} 无天光锚词（转变点后每镜头须带 夜/昏暗/灯笼/冷调 等状态锚——00034 实测：无锚镜头成片回亮到日间）"))
    else:
        rep.append(("PASS", "I16", f"天光转变点（段{first_transit}）之后各镜头均含天光锚"))


def check_cutpoint_alignment(head, segs, rep):
    """I15 切点对齐（数值部分）：切点全局秒必须等于预算表对应段界末秒。【2026-11-24 25s v3 新增】
    语义镜像部分（承接描述=段末子段末句改写）无可靠启发式，契约措辞兜底 + 人工终审。"""
    cuts = re.findall(r"切点(\d+)（段(\d+)/段(\d+)间）[｜|]类型：[^｜|]*[｜|]全局\s*([\d.]+)s", head)
    bounds = re.findall(r"段\s*(\d+)[｜|]执行填\s*(\d+)\s*帧[｜|]提示词写\s*(\d+)\s*s[｜|]全局\s*([\d.]+)\s*[–—~\-]\s*([\d.]+)\s*s", head)
    if not cuts:
        rep.append(("WARN", "I15", "总控卡未解析到切点清单行——切点与段界/段末态对齐无法核对"))
        return
    seg_end = {int(b[0]): float(b[4]) for b in bounds}
    bad = []
    for no, a, b, g in cuts:
        g = float(g)
        expect = seg_end.get(int(a))
        if expect is None or abs(g - expect) > 0.01:
            bad.append((no, g, expect))
    if bad:
        for no, g, expect in bad:
            rep.append(("FAIL", "I15", f"切点{no} 全局 {f2s(g)}s ≠ 段{no} 全局区间末 {f2s(expect) if expect else '未解析'}s（切点必须落在预算表段界上）"))
    else:
        rep.append(("PASS", "I15", f"{len(cuts)} 个切点全局秒均与预算表段界对齐（承接描述须人工核对是否镜像段末实际状态）"))


def check_impact_frame(head, segs, rep):
    """I18 冲击帧全局秒一致性：总控卡「冲击帧：全局 X–Ys，归属段N，距段首 Zs」声明，须与段N内实际冲击帧的段内秒数交叉一致。
    【2026-11-24 重新生成包实测】总控卡写"冲击帧全局 17.5–17.7s，归属段4，距段首 2.5s"，但段4 实际把冲击帧写在段内 3.5–3.7s
    （对应全局 18.5–18.7s），差整整 1s——机器层此前完全无冲击帧检查，此不一致静默漏过。"""
    m_head = re.search(r"冲击帧[：:]\s*全局\s*([\d.]+)\s*[–—~\-]\s*([\d.]+)s[，,]\s*归属段\s*(\d+).*?距段首\s*([\d.]+)s", head)
    if not m_head:
        # 无冲击帧声明（"冲击帧：无"）或格式未匹配
        if "冲击帧" in head and "无" in head.split("冲击帧", 1)[1][:8]:
            rep.append(("PASS", "I18", "总控卡声明无冲击帧，跳过一致性核对"))
        else:
            rep.append(("WARN", "I18", "总控卡未解析到冲击帧声明行（或格式非标准）——冲击帧全局秒与段内实际无法核对"))
        return
    g0, g1, seg_no, dist = float(m_head.group(1)), float(m_head.group(2)), int(m_head.group(3)), float(m_head.group(4))
    # 找段N 内实际冲击帧的段内秒数
    seg = next((s for s in segs if s["no"] == seg_no), None)
    if not seg:
        rep.append(("WARN", "I18", f"总控卡声明冲击帧归属段{seg_no}，但未找到该段正文"))
        return
    found = None
    for line in seg["text"].splitlines():
        s = line.strip()
        # 段内冲击帧子段格式：- 3.5–3.7s【冲击帧｜...】
        m = re.search(r"([\d.]+)\s*[–—~\-]\s*([\d.]+)s\s*[【\[]冲击帧", s)
        if m:
            found = (float(m.group(1)), float(m.group(2)))
            break
    if found is None:
        rep.append(("FAIL", "I18", f"总控卡声明冲击帧归属段{seg_no}，但段{seg_no} 正文未解析到「X–Ys【冲击帧】」子段——冲击帧声明与段内实际不符"))
        return
    seg_start, seg_end = found
    # 校验：总控卡"距段首 Zs"应等于段内实际冲击帧起点 seg_start
    if abs(seg_start - dist) > 0.01:
        rep.append(("FAIL", "I18", f"冲击帧全局秒声明与段内实际不一致：总控卡写「归属段{seg_no}，距段首 {f2s(dist)}s」，但段{seg_no} 实际冲击帧在段内 {f2s(seg_start)}–{f2s(seg_end)}s（距段首 {f2s(seg_start)}s，差 {f2s(seg_start - dist)}s）——冲击帧的全局位置与段内落点对不上，须对齐"))
    else:
        rep.append(("PASS", "I18", f"冲击帧全局秒一致：段{seg_no} 段内 {f2s(seg_start)}–{f2s(seg_end)}s = 距段首 {f2s(dist)}s，与总控卡声明相符"))


def main():
    if len(sys.argv) < 2:
        print("用法: python 自检_提示词包.py <总控卡分段包.md路径>")
        return 1
    path = sys.argv[1]
    text, head, segs = load(path)
    if not segs:
        print("[FAIL] 未解析到任何「段N 提示词」区块，也不是单份完整提示词（须含「整体基调：」与「镜头1｜」结构）")
        return 1
    single = segs[0].get("single", False)
    rep = []
    if single:
        # 单份模式：跳过依赖总控卡的检查（I1 预算/I5 基调逐字），其余内容类检查全量跑【2026-11-24 单份支持新增】
        # 【2026-11-24 第5次复发修订：单份同样跑 I4 登记核对——check_image_registry 已支持 head 为空时从段内搜登记行】
        # 【2026-11-24 10s 误分段修订：单份模式无总控卡预算表，budget 传 None——此前引用未定义变量 budget 直接 UnboundLocalError，
        #   单份探针从未跑通（一进单份模式即崩），是"单份路径机器失明"的直接表现】
        check_total_duration(segs, rep)
        for seg in segs:
            check_time_coverage(seg, rep, None)
        check_binding(segs, rep)
        check_verb_uniqueness(segs, rep)
        check_dialog(segs, rep)
        check_seam_audio(segs, rep)
        check_bgm(segs, rep)
        check_image_registry(head, segs, rep)
        check_process_anchor(segs, rep)
        check_light_anchor(segs, rep)
        check_content_density(segs, rep)
    else:
        # 【2026-11-24 10s 分段2 新探针修订：从总控卡预算表提取段号→帧数映射，供 check_time_coverage 帧数回退取数】
        budget = {}
        for bno, bfr in re.findall(r"段\s*(\d+)\s*[｜|]\s*执行填\s*(\d+)\s*帧", head):
            budget[int(bno)] = int(bfr)
        check_frame_budget(head, segs, rep)
        check_cutpoint_alignment(head, segs, rep)
        check_impact_frame(head, segs, rep)
        for seg in segs:
            check_time_coverage(seg, rep, budget)
        check_binding(segs, rep)
        check_tone(head, segs, rep)
        check_reentry(segs, rep)
        check_verb_uniqueness(segs, rep)
        check_dialog(segs, rep)
        check_seam_audio(segs, rep)
        check_bgm(segs, rep)
        check_image_registry(head, segs, rep)
        check_process_anchor(segs, rep)
        check_light_anchor(segs, rep)
        check_content_density(segs, rep)
        check_segment_density(segs, rep)

    n_fail = sum(1 for r in rep if r[0] == "FAIL")
    n_warn = sum(1 for r in rep if r[0] == "WARN")
    print(f"==== 自检_提示词包 报告：{Path(path).name} ====")
    for lvl, inv, msg in rep:
        print(f"[{lvl}] {inv}｜{msg}")
    print(f"==== 合计：FAIL {n_fail}｜WARN {n_warn}｜{'不得交付，回改后重跑' if n_fail else '机器层通过（WARN 需人工裁量；I4 绑定零虚构 / I8 空间调度须人工终审）'} ====")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
