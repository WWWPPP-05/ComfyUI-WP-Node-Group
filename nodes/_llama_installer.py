# -*- coding: utf-8 -*-
"""llama-cpp-python 自动安装器。

打包分发本插件时，接收方的 ComfyUI 环境未必装有（或版本/CUDA 不匹配的）
llama-cpp-python。此模块在节点运行时自动诊断环境（Python 版本 / torch 的
CUDA 版本 / 平台），从官方 GitHub Releases（abetlen/llama-cpp-python）
选择匹配的预编译轮子，断点续传下载后用当前 Python 的 pip 安装。

设计约束：仅依赖标准库（对方环境什么都缺的时候也要能跑起来）。
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = "abetlen/llama-cpp-python"
MIN_VERSION_DEFAULT = "0.3.36"


def _ver_tuple(s):
    return tuple(int(x) for x in re.findall(r"\d+", str(s))[:3])


def _current_installed_version():
    """读包元数据（不 import llama_cpp，避免触发 DLL 加载）。未装返回 None。"""
    try:
        from importlib.metadata import version
        return version("llama-cpp-python")
    except Exception:
        return None


def _detect_env():
    """检测本机 Python / 平台 / torch 的 CUDA 版本。"""
    env = {
        "python_tag": "cp%d%d" % (sys.version_info.major, sys.version_info.minor),
        "platform": sys.platform,  # win32 / darwin / linux
        "cuda": None,              # 如 (13, 0)；None 表示无 CUDA 版 torch
    }
    try:
        import torch

        cv = getattr(torch.version, "cuda", None)
        if cv:
            nums = re.findall(r"\d+", cv)
            env["cuda"] = (int(nums[0]), int(nums[1]) if len(nums) > 1 else 0)
    except Exception:
        pass
    return env


def _fetch_releases(pages=3):
    releases = []
    for page in range(1, pages + 1):
        url = "https://api.github.com/repos/%s/releases?per_page=100&page=%d" % (REPO, page)
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "wp-node-installer",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            batch = json.loads(resp.read().decode("utf-8"))
        if not batch:
            break
        releases.extend(batch)
    return releases


def _wheel_compatible(name, env):
    """检查轮子文件名是否匹配本机（平台 + Python 标签）。

    文件名形如 llama_cpp_python-0.3.36-cp313-cp313-win_amd64.whl
    """
    parts = name[:-4].split("-")
    if len(parts) < 3:
        return False
    plat = parts[-1]
    py_tags = parts[2:-1]
    if env["platform"] == "win32":
        if plat != "win_amd64":
            return False
    elif env["platform"] == "darwin":
        if "macosx" not in plat:
            return False
    elif "linux" not in plat:
        return False
    return any(t in (env["python_tag"], "abi3", "py3", "py2.py3") for t in py_tags)


def _pick_candidate(env, releases, min_version):
    """选轮子：返回 (下载直链, tag名) 或 None。

    变体策略：有 CUDA 版 torch 时只用与 torch 完全同版本的 cu 轮子
    （错配会因找不到对应的 cublas DLL 而加载失败），否则 CPU 版。
    """
    groups = {}
    for rel in releases:
        if rel.get("draft") or rel.get("prerelease"):
            continue
        tag = rel.get("tag_name", "")
        m = re.match(r"^v?(\d+\.\d+\.\d+)(?:-([a-z0-9.]+))?$", tag)
        if not m:
            continue
        ver = _ver_tuple(m.group(1))
        if ver < _ver_tuple(min_version):
            continue
        variant = m.group(2) or "cpu"
        assets = [a for a in (rel.get("assets") or []) if a.get("name", "").endswith(".whl")]
        if assets:
            groups.setdefault(variant, []).append((ver, tag, assets))
    if not groups:
        return None

    if env["cuda"] and "cu%d%d" % env["cuda"] in groups:
        chain = ["cu%d%d" % env["cuda"]]
    else:
        chain = ["cpu"]

    for variant in chain:
        for _ver, tag, assets in sorted(groups.get(variant, []), reverse=True):
            for a in assets:
                if _wheel_compatible(a["name"], env):
                    return a["browser_download_url"], tag
    return None


def _download(url, dest, log=print, retries=4):
    last = None
    for attempt in range(1, retries + 1):
        try:
            have = os.path.getsize(dest) if os.path.exists(dest) else 0
            req = urllib.request.Request(url, headers={"User-Agent": "wp-node-installer"})
            if have:
                req.add_header("Range", "bytes=%d-" % have)
            with urllib.request.urlopen(req, timeout=60) as resp:
                status = getattr(resp, "status", 200)
                if status not in (200, 206):
                    raise OSError("HTTP %s" % status)
                resume = status == 206 and have > 0
                length = resp.headers.get("Content-Length")
                total = int(length) if length else None
                if total is not None:
                    total += have if resume else 0
                mode = "ab" if resume else "wb"
                done = have if resume else 0
                t0 = time.time()
                with open(dest, mode) as f:
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        done += len(chunk)
                        if total and done * 100 // total != (done - len(chunk)) * 100 // total:
                            speed = done / max(time.time() - t0, 0.1) / 1048576
                            log("  下载 %d%%（%d/%d MB，%.1f MB/s）" % (done * 100 // total, done // 1048576, total // 1048576, speed))
            return
        except Exception as e:
            last = e
            if attempt < retries:
                log("  下载中断（第 %d 次）：%s —— 2 秒后从断点续传" % (attempt, e))
                time.sleep(2)
    raise RuntimeError("下载失败（已重试 %d 次）：%s" % (retries, last))


def _pip_install(wheel_path):
    cmd = [sys.executable, "-m", "pip", "install", "--no-deps", "--force-reinstall", wheel_path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("pip 安装失败：\n%s\n%s" % (r.stdout, r.stderr))


def _manual_hint(env, min_version, reason):
    cuda_part = ""
    if env["cuda"]:
        cuda_part = "，CUDA %d.%d（选文件名带 cu%d%d 的）" % (env["cuda"][0], env["cuda"][1], env["cuda"][0], env["cuda"][1])
    return (
        "自动安装未能完成：%s。\n"
        "手动安装步骤：\n"
        "1. 浏览器打开 https://github.com/%s/releases ；\n"
        "2. 选一个 ≥%s 的版本，按环境挑轮子：Python %s%s；\n"
        "3. 命令行执行：%s -m pip install --force-reinstall 下载的轮子完整路径；\n"
        "4. 网络不畅可先设代理（set HTTPS_PROXY=http://127.0.0.1:端口）再重跑工作流。"
        % (reason, REPO, min_version, env["python_tag"], cuda_part, sys.executable)
    )


def ensure_llama_cpp(min_version=MIN_VERSION_DEFAULT, log=print):
    """确保 llama-cpp-python 已按本机环境正确安装。

    返回 (ok, message)。ok=True 表示当前进程可直接使用（含"已装好"）；
    ok=False 时 message 含手动安装指引。
    """
    installed = _current_installed_version()
    if installed is not None and _ver_tuple(installed) >= _ver_tuple(min_version):
        return True, "已安装 llama-cpp-python %s，无需处理" % installed

    env = _detect_env()
    log("[WP安装器] llama-cpp-python 缺失或版本过旧（当前：%s），开始自动安装 ≥%s" % (installed or "未安装", min_version))
    log("[WP安装器] 本机环境：Python %s，平台 %s，torch CUDA：%s" % (
        env["python_tag"], env["platform"], ("%d.%d" % env["cuda"]) if env["cuda"] else "无（将装 CPU 版）"))

    try:
        cand = _pick_candidate(env, _fetch_releases(), min_version)
    except Exception as e:
        return False, _manual_hint(env, min_version, "无法访问 GitHub（%s）" % e)

    if not cand:
        if env["cuda"]:
            return False, _manual_hint(env, min_version, "官方源暂无与 torch CUDA %d.%d 匹配的预编译轮子" % env["cuda"])
        return False, _manual_hint(env, min_version, "官方源没有匹配本机环境的预编译轮子")

    url, tag = cand
    fname = url.rsplit("/", 1)[-1]
    log("[WP安装器] 选中：%s / %s（约几十至二百 MB，取决于网络）" % (tag, fname))

    tmp_dir = os.path.join(tempfile.gettempdir(), "wp_llama_installer")
    os.makedirs(tmp_dir, exist_ok=True)
    dest = os.path.join(tmp_dir, fname)
    try:
        _download(url, dest, log=log)
        log("[WP安装器] 下载完成，开始安装…")
        _pip_install(dest)
    except Exception as e:
        return False, _manual_hint(env, min_version, "自动安装失败（%s）" % e)
    finally:
        try:
            if os.path.exists(dest):
                os.remove(dest)
        except Exception:
            pass

    return True, "llama-cpp-python %s（%s）安装完成" % (_current_installed_version() or min_version, tag)
