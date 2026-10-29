# -*- coding: utf-8 -*-
"""🐳 WP PSD拆解启动器 — PSD 拆解管线第⑥站：工作流启动器（纯摆设节点 + 管理 API）

节点本身不参与运算（Run 时不执行任何操作），作用：
① 给前端 JS 挂载点：下拉框选工作流 + 载入到画布 + 弹窗管理（增/改/删）
② 注册 4 个 HTTP API 管理插件目录 workflows_psd/ 下的工作流 JSON 文件
   （路由注册模式同资产库节点：@PromptServer.instance.routes，import 即生效）
"""
import json
import os
import re

from aiohttp import web
from server import PromptServer

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_WF_DIR = os.path.join(os.path.dirname(_THIS_DIR), "workflows_psd")


def _clean_name(name):
    """清洗工作流名：去非法字符、防路径穿越；异常时抛 ValueError。"""
    name = re.sub(r'[\\/:*?"<>|]', "_", str(name or "")).strip()
    if not name or len(name) > 60:
        raise ValueError("工作流名称不能为空，且不超过 60 个字符")
    if ".." in name:
        raise ValueError("工作流名称不能包含 ..")
    return name


@PromptServer.instance.routes.get("/wp_node/psd_splitter/list")
async def psd_splitter_list(request):
    """列出全部工作流（workflows_psd/ 下的 .json 文件名，去后缀）。"""
    try:
        os.makedirs(_WF_DIR, exist_ok=True)
        names = sorted(f[:-5] for f in os.listdir(_WF_DIR) if f.lower().endswith(".json"))
        return web.json_response({"success": True, "workflows": names})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/wp_node/psd_splitter/get")
async def psd_splitter_get(request):
    """读取单个工作流 JSON（供前端载入到画布）。"""
    try:
        name = _clean_name(request.query.get("name", ""))
        path = os.path.join(_WF_DIR, name + ".json")
        if not os.path.isfile(path):
            return web.json_response({"success": False, "error": f"工作流「{name}」不存在"}, status=404)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response({"success": True, "data": data})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/psd_splitter/save")
async def psd_splitter_save(request):
    """保存/覆盖工作流：body = {name, data}，data 为画布 serialize() 出的工作流对象。"""
    try:
        body = await request.json()
        name = _clean_name(body.get("name", ""))
        data = body.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
            return web.json_response({"success": False, "error": "工作流数据无效（缺少 nodes）"}, status=400)
        os.makedirs(_WF_DIR, exist_ok=True)
        path = os.path.join(_WF_DIR, name + ".json")
        overwritten = os.path.isfile(path)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        return web.json_response({"success": True, "overwritten": overwritten})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wp_node/psd_splitter/delete")
async def psd_splitter_delete(request):
    """删除工作流：body = {name}。"""
    try:
        body = await request.json()
        name = _clean_name(body.get("name", ""))
        path = os.path.join(_WF_DIR, name + ".json")
        if not os.path.isfile(path):
            return web.json_response({"success": False, "error": f"工作流「{name}」不存在"}, status=404)
        os.remove(path)
        return web.json_response({"success": True})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


class WP_PsdSplitter:
    """🐳 WP PSD拆解 — 启动器节点：选工作流一键载入整条 PSD 拆解管线。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "使用说明": ("STRING", {
                    "default": "PSD 拆解工作流启动器（Run 时本节点不执行）：\n"
                               "① 下拉框选择工作流 → 点「载入到画布」\n"
                               "② 点「管理工作流」可把当前画布存为新预设 / 覆盖 / 删除\n"
                               "③ 预置「标准拆解管线」= 规划→人工干预→精抠→背景补全→Qwen 2.1→导出 完整链",
                    "multiline": True,
                }),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "noop"
    CATEGORY = "🐳 WP_Node"

    def noop(self, 使用说明):
        return ()


NODE_CLASS_MAPPINGS = {
    "WP_PsdSplitter": WP_PsdSplitter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_PsdSplitter": "🐳 WP PSD拆解",
}
