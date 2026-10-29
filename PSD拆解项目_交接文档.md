# PSD 智能拆解项目 — 工作交接文档

> 新会话必读：本文件是完整工作交接。配合 PRD 文档 `生成PSD开发计划.md`（同目录）一起阅读。
> 项目当前状态（2026-10-16）：**五个节点全部开发完成（规划/精抠/背景补全/导出/拆解启动器）→ 前四节点待少爷重启实图验证 → 启动器待少爷重启验证 → 项目进入收尾验证阶段**。
>
> **🔄 新会话快速上手（账号切换交接，2026-10-16 晚）**：
> 1. 代码已全部写完且离线自检通过，**当前没有任何进行中的代码改动**，不要重写任何文件
> 2. 少爷重启 ComfyUI 后按第八节步骤统一验证 ④导出节点 和 ⑤启动器节点（预期现象都写好了）
> 3. 验证有报错 → 按报错日志定位修复（相关文件见第四节④⑤）；验证全过 → 做收尾三件事：requirements.txt 补 psd-tools、临时产物清理确认、插件打包（少爷习惯每轮只留最新构建）
> 4. 少爷可能对预置工作流「标准拆解管线」提出布局/参数微调 —— 直接改 `workflows_psd/标准拆解管线.json`（标准 ComfyUI 工作流格式，20 节点 27 连线，注意 widgets_values 顺序规则见第四节⑤）

---

## 一、项目目标

开发 ComfyUI 插件（属于 Comfyui_WP_Node_Group 插件包）：**单张图片智能拆解为可编辑 PSD 文件**。

管线架构（已全部 PoC 验证，前三节点已落地）：

```text
原图 → ① WP_PsdPlanner（VLM 语义规划：拆几层、每层名字/描述/z序/粗bbox）
     → ② 人工干预（MVP 用 JSON 文本修改）
     → ③ WP_PsdLayerExtract（SAM3.1 文本概念分割：每层像素级 mask）
     → ④ WP_PsdBgInpaint（前景蒙版并集 → 红标图）
     → 【少爷现成的 Qwen Image 2.1 工作流】（红标图 → 干净背景图，路线C）
     → ⑤ WP_PsdExport（psd-tools 组装导出 PSD）✅ 已开发，待实图验证
     → ⑥ WP_PsdSplitter（一键封装预置工作流）✅ 已开发，待重启验证
```

## 二、已确认的架构决策

| 环节 | 方案 |
|------|------|
| VLM 规划 | 双通道：本地 WP_LlamaLoader（Qwen3.5-9B GGUF + mmproj，优先）/ API 模式（OpenAI 兼容协议，复用提示词对话节点 `_parse_api_config`/`_call_api_chat`，含流式/回退/429重试） |
| 精抠 mask | **SAM3.1（已落地）**：权重 `models/sam3/sam3.1_multiplex_fp16.safetensors`，代码来自 ComfyUI-RMBG 插件 `models/sam3/` |
| 背景补全 | **路线C（已落地）**：节点输出红标图 → 用户现成 Qwen Image 2.1 工作流补全 → 结果连回导出节点。PoC-4 已证实节点内自调用必死锁，路线A出局 |
| PSD 组装 | psd-tools 1.12.1（py313 环境已装），PoC-1 配方见第三节 |
| 人工干预 MVP | WP_TextBox 改 JSON 文本（不做可视化 UI） |
| MVP 边界 | 8-bit sRGB 全画布图层、Normal 混合、无图层组、失败层 bbox 矩形兜底 |

## 三、PoC 技术资产（配方级结论，写节点时照抄）

### PoC-1 PSD 写入 ✅（WP_PsdExport 将直接使用）
- **psd-tools 1.12.1 的 `create_pixel_layer` 会强制 RGBA→RGB 丢 alpha，必须绕过**：
  直接调 `layers.PixelLayer._build_layer_record_and_channels(image_rgba, name, left, top, Compression.RLE)` 再 `layers.PixelLayer(psd, record, data_list)` + `psd.append(layer)`
- 已核对 py313 环境源码（2026-10-16）：
  - `_build_layer_record_and_channels(image, name, left, top, compression)` 返回 `(LayerRecord, ChannelDataList)`
  - `Layer.__init__(parent, record, channels)`，parent 传 psd 对象（PSDImage 实现了 GroupMixin 协议）
  - `PSDImage.new(mode, size, color=0, depth=8)`
- 中文图层名双配套：`save(path, encoding="utf-8")` + 每层 `layer._record.tagged_blocks.set_data(b"luni", name)`
- Compression 导入位置：`from psd_tools.constants import Compression`（不是 psd_tools.enums）
- 验收：PS 打开正常，3 层含透明。产物 `C:\Users\19810\AppData\Local\Temp\wp_psd_poc\poc_3layers_v2.psd`

### PoC-2 VLM 语义规划 ✅（已落地为 WP_PsdPlanner）
- 模型：`Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf` + 配套 mmproj BF16（`E:\comfy-UI\ComfyUINeo\models\LLM\`）
- **必须关思考模式**：推理参数 `enable_thinking=False`，否则思考吞 token 导致无 JSON 输出（API 模式同理，见第五节教训1）
- 参数：max_tokens=4096，temperature=0.2，失败自动重试 1 次
- bbox 双保险：提示词含数字格式示例 + 自动识别 `[x1,y1,x2,y2]` 并转换为宽高格式，clamp 到画布

### PoC-2.7 SAM3.1 分割 ✅（已落地为 WP_PsdLayerExtract）
- **调用配方**（照抄可用）：`build_sam3_image_model(bpe_path=..., device="cpu", eval_mode=True, checkpoint_path=None, load_from_HF=False, enable_segmentation=True, enable_inst_interactivity=False)` → safetensors 手动加载权重（key 前缀 `detector.` 需剥掉，strict=False）→ `.cuda().eval()` → `Sam3Processor(model, device="cuda")` → `set_image(图)` 一次 → 每概念：`reset_all_prompts(state)` + `set_confidence_threshold(阈值, state)` + `set_text_prompt(概念词, state)` → `state.get("masks")`（实例级 mask，>0.5 二值化）
- 依赖 sys.path 注入 `ComfyUI-RMBG/models/sam3` 和 `ComfyUI-RMBG/models`；BPE 词表 `ComfyUI-RMBG/models/sam3/assets/bpe_simple_vocab_16e6.txt.gz`
- 概念词策略：具象物体高阈值（0.30），文字/标志/装饰低阈值（0.10）；每层多词并集查询；`set_confidence_threshold` 用内部检测分，0.5 对文字类全灭
- 归属规则：实例落在规划框内（contain≥0.3 或 IoU≥0.1）即保留；<50px 碎渣丢弃；零命中 bbox 矩形兜底
- 性能：10 层 4.7 秒 / 显存峰值 3.86GB

### PoC-3 背景补全 ✅（已落地为 WP_PsdBgInpaint）
- **v2 正确配方（单图删除）**：image_1 = 红色标记图（前景 mask 涂纯红 255,0,0），prompt = "Remove all the regions covered in solid red. Naturally reconstruct ... background ... Keep everything not marked in red exactly unchanged."（细节按图调整）
- v1 失败教训：双图模式（干净原图+红标图）模型会忽略 mask 全图重绘，禁止使用
- 红标必须覆盖全部待删元素，漏标 = 元素残留
- 结果：72 秒/次，未标记区保真度中位差 4/255

### PoC-4 子工作流死锁验证 ✅
- 结论：节点执行中 POST /prompt 提交子任务后永远不被处理（队列串行），路线A出局
- 带出技术资产：
  - `OUTPUT_NODE = True` 可让无连线节点被 Run 执行（**WP_PsdExport 将用到**）
  - 队列管理接口是 `POST /queue`；`POST /interrupt` 踢不掉 running 僵尸任务
  - **ComfyUI 进程 TEMP 环境变量异常** → 节点内写文件必须用绝对路径（folder_paths API 可用）
  - **ComfyUINeo 热重载时机不可控** → 改节点代码后必须彻底重启验证
  - history 的 prompt 字段是 5 元素数组，节点返回值可从 /history 的 outputs 读到

## 四、五节点开发进度（当前阶段，2026-10-16）

三节点均已注册：`__init__.py`（import + NODE_CLASS_MAPPINGS + NODE_DISPLAY_NAME_MAPPINGS）、`js/node_color.js`（NODE_TYPES 数组紫色标题栏）。

### ① WP_PsdPlanner「🐳 WP PSD图层规划」✅ 完成
- 文件：`nodes/PSD图层规划节点.py`
- 功能：原图 → 图层方案 JSON（层名/类型/z_index/description/concept_words/bbox）+ bbox 彩框预览图
- 双通道：连接本地模型（QWENLLAMA，优先）或「API配置」JSON（未连模型时启用；API 设置弹窗前端在 `js/wp_psd_planner.js`，复刻提示词对话节点的 DOM button + addDOMWidget 机制）
- 拆分粒度三档预设：简单(2~5层)/详细(5~12层)/复杂(10~20层)，各带策略指令；「附加指令」文本框拼为规则第 8 条
- 关键机制（全是踩坑换来的）：
  - 本地推理 `enable_thinking=False`；API 模式 body 同样已加 `enable_thinking=False`（2026-10-16 修复，见第五节教训1）
  - 解析失败自动重试 1 次：attempt2 温度强制 0.7（打破重复书写）
  - **残骸抢救是最后防线**：两次解析全失败后才逐层提取完整图层、丢弃坏尾部
  - IS_CHANGED 返回"粒度+附加指令"焊入缓存签名；「卸载模型」开关不参与签名（缓存跳过=无需卸载）
  - 防幻觉："只拆解图中实际存在的元素"；bbox 双格式示例 + `_normalize_bbox` 自动纠正
  - API 模式图片 1536 高清；本地模式按「最大边长」缩放（默认 896）
- 输出：规划JSON STRING + 预览图 IMAGE
- 联调状态：饮品海报实测 24 层规划、文字层 9 个全齐（靠附加指令，见第五节教训6）

### ② WP_PsdLayerExtract「🐳 WP PSD图层精抠」✅ 完成
- 文件：`nodes/PSD图层精抠节点.py`
- 功能：规划 JSON + 原图 → 每层像素级 mask
- 「SAM模型」下拉框：扫描 `models/sam3/*.safetensors` 自动生成；显式加载日志（文件名+GB+预计耗时 1~3 分钟）；单例缓存按模型文件名区分；「推理后卸载」开关释放 3.9GB
- 双阈值：物体 0.30 / 文字·标志·装饰 0.10
- 输出（下游导出节点要吃的就是这些）：
  - 图层图像 IMAGE（原图复制 n 份的 batch）
  - 图层蒙版 MASK [n,H,W]（二值 0/1）
  - 结果JSON STRING：`{"canvas":{"width":W,"height":H},"layers":[{z_index,layer_name,layer_type,words,conf,n_raw,n_kept,mask_px,source},...]}`，source ∈ background/sam/bbox_fallback
  - 预览拼图 IMAGE
- 联调状态：饮品海报 24 层中 20 层 SAM 命中

### ③ WP_PsdBgInpaint「🐳 WP PSD背景补全」✅ 完成
- 文件：`nodes/PSD背景补全节点.py`
- 功能：原图 + 图层蒙版 + 结果JSON → 红标图（前景并集涂纯红，喂 Qwen Image 2.1 删背景）
- 背景层识别双保险：①结果JSON layer_type=背景 ②面积≥90% 兜底跳过（见第五节教训5）
- 输出：红标图 IMAGE
- 联调状态：三节点链路端到端跑通，红标图质量合格

### ④ WP_PsdExport「🐳 WP PSD导出」✅ 已开发（2026-10-16），待少爷重启实图验证
- 文件：`nodes/PSD导出节点.py`（已在 `__init__.py` 与 `js/node_color.js` 注册）
- 功能：管线终点。image（原图/精抠图层图像）+ 图层蒙版 + 结果JSON（均来自精抠节点）+ 背景图（Qwen Image 2.1 干净背景）→ 组装导出 PSD
- 输入：image / 图层蒙版 MASK / 结果JSON / 背景图 IMAGE / 文件名前缀（默认 `psd_export`，存 output 目录，`前缀_时间戳.psd`）
- 输出：PSD路径 STRING + 预览图 IMAGE（背景 + 前景按 z 序 alpha 合成）
- 实现要点（全部按已确认方案落地）：
  - `OUTPUT_NODE = True`：输出不连线 Run 时也执行
  - PSD 组装用 PoC-1 配方：`_build_layer_record_and_channels` 绕过 create_pixel_layer 丢 alpha bug；RLE 压缩；中文层名 UTF-8 + luni 双保险
  - 底层 = 背景图（不透明全画布，层名取结果JSON 背景层层名，无则"背景"）；背景图尺寸自动 lanczos 对齐画布
  - 前景按 z_index 升序 stable sort 逐层 append（psd-tools append = 加栈顶，z 小在底）
  - source=background 或 layer_type=背景 的层跳过（双保险识别）；bbox_fallback 层正常写入
  - 蒙版 dim==2 自动 unsqueeze(0)；JSON 解析失败 / 层数与蒙版批数不符 / 蒙版尺寸与原图不符 → 明确中文报错
  - 纯 CPU（PIL + psd-tools），不动显卡
- 冒烟测试已通过（2026-10-16）：3 层中文层名写入回读正常、半透明 alpha=128 保留、层序正确、合成像素与理论值一致（产物 `C:\Users\19810\AppData\Local\Temp\wp_psd_poc\export_node_smoke.psd`）
- 新版 psd-tools 1.12.x 注意：`PSDImage` 没有 `.layers` 属性了，用 `len(psd)` / `psd[i]` / `for l in psd` 访问层（写验证脚本时别踩）
- 验证方式：重启 ComfyUI → 四根线连好（精抠三输出 + Qwen 干净背景图）→ Run → output 目录找 `psd_export_时间戳.psd` → PS/Photopea 打开检查层数、中文层名、透明区

### ⑤ WP_PsdSplitter「🐳 WP PSD拆解」✅ 已开发（2026-10-16），待少爷重启验证
- 定位（少爷确认）：**启动器节点**（原"预置模板文件"方案升级）——节点上下拉框选工作流 + 弹窗管理（自定义增/改/删），Run 时纯摆设不执行
- 文件（三处新件 + 两处注册）：
  - `nodes/PSD拆解启动器节点.py`：节点类（无输入输出口，仅一个"使用说明"widget，前端隐藏）+ 4 个 API 路由（照资产库节点模式 `@PromptServer.instance.routes`，import 即注册）
  - `js/wp_psd_splitter.js`：前端（复刻 wp_psd_planner.js 的 DOM widget + 弹窗机制）——节点上=工作流下拉框+「📥 载入到画布」+「🗂 管理工作流」两按钮；弹窗=存新（当前画布 serialize 存为新名）/ 覆盖选中 / 删除选中 / 列表点选
  - `workflows_psd/标准拆解管线.json`：预置完整链（20 节点 27 连线）
  - `__init__.py` + `js/node_color.js` 注册
- API：`GET /wp_node/psd_splitter/list|get?name=`、`POST /wp_node/psd_splitter/save|delete`；名字清洗（非法字符替换 + 拒绝 `..`/空/超60字）防路径穿越；存储 = 插件目录 `workflows_psd/` 一个工作流一个 .json
- 预置「标准拆解管线」拼装要点（以少爷 `Qwen-image2.1-PSD.json` 为底子程序化拼装）：
  - PSD 链 5 节点（规划→文本框人工干预→精抠→背景补全→导出）+ 启动器摆左上角（不连线，随时可再切换）
  - **修正双图为单图模式**：删原 637/638 双 LoadImage 链，红标图 → ImageScaleToTotalPixels → TextEncodeQwenImage21.images.image_1，image_2 断开（PoC-3 v2 实战结论）
  - prompt 预填红区删除指令；规划节点附加指令预填文字层拆全指令（教训6）；SAM 模型预选 sam3.1_multiplex_fp16
  - VAEDecode → 导出.背景图 + SaveImage（前缀改 psd_干净背景）
  - widgets_values 规则：含已转输入口的 STRING（占位空值）+ seed 后跟 'fixed'（control_after_generate）；结构校验脚本全过（连线两端节点/slot/类型/双向引用）
- 已验证：py_compile + node --check 通过；API 文件逻辑（名单清洗/save-get-delete 循环）通过；预置 JSON 结构完整性校验通过
- 验证方式：重启 ComfyUI → 搜「🐳 WP PSD拆解」→ 节点上应出现下拉框（含"标准拆解管线"）+ 两按钮 → 载入 → 画布应出现 20 节点完整链 → 管理弹窗试存新/覆盖/删

## 五、节点开发阶段经验教训（新会话避免重踩）

1. **API 云端思考模式**：云端 Qwen3 默认开思考，思考耗尽 max_tokens → 正文空输出（症状：报错日志"模型原始输出（前300字符）："后空白）。已在 `_call_api_chat`（提示词对话节点.py）body 加 `enable_thinking: False`（魔搭等 Qwen 系网关标准参数，不认识的网关会忽略）。规划节点另有空输出防御日志。2026-10-16 修复，少爷未再反馈异常。
2. **残骸抢救必须是最后防线**：曾因首次解析失败即触发，吃掉重试机会只救回 5 层（损失 19 层）。现为"两次全失败后"才启用。
3. **重试必须换温度**（0.2→0.7）：同温度重试模型会重复书写同样的坏 JSON。
4. **JS 设置弹窗**：原生 `addWidget("button")` 点击回调在新前端不可靠，必须 DOM button + addDOMWidget（参考 `js/wp_psd_planner.js` / 提示词对话节点前端）；import 路径用 `"../../scripts/app.js"`；隐藏 widget 需 `computeSize = () => [0,0]`。
5. **背景补全面积兜底阈值 0.90**：SAM 曾把整只贴标杯身检出为 "label"（mask 达 96.6% 画布），穿透原 98% 阈值致红标图几乎全红。正常前景层 ≤5% 画布，90% 阈值安全。
6. **文字层拆全靠附加指令**："图中每一处可见文字都必须单独拆一层（顶部英文、品牌名、竖排产品字、印章、手写宣传语、小字）"——实测 24 层、文字层 9 个全齐。
7. **API 规划质量波动**：同一张图 bbox 兜底层数 3~10 不等（云端固有）。用控制台"X 层 bbox 兜底"计数判断质量（≤5 为佳），质量差就改 seed 重跑规划节点。bbox 兜底层 mask 天然是矩形，比 SAM mask 粗糙。
8. **ComfyUI 缓存机制**：fixed seed + 相同输入 = 复用缓存跳过执行（会话内有效，重启清空）；IS_CHANGED 返回 NaN 会强制每次重跑（曾导致"固定种子仍重跑"假象，已修复）。
9. **Qwen3.5 VLM 长 JSON 偶发格式损坏**（缺逗号/截断）：模型能力边界，管线靠"重试+抢救"消化，不要试图根治。
10. **Qwen3.5 VLM 会按"必须有某类层"的强制指令幻觉出不存在的元素**（如女人照片里出现"二维码"层）：提示词必须写"只拆解图中实际存在的元素"。

## 六、Qwen Image 2.1 工作流要点（少爷实战配置）

源文件：`user/default/workflows/Qwen-image2.1-PSD.json`

- 模型三件套（都在 `models/Qwen image 2.1/` 子目录）：`qwen_image_2.1_int8_convrot.safetensors`（UNET）+ `qwen3vl_8b_int8_convrot.safetensors`（CLIP, type=qwen_image）+ `qwen_image_2.1_vae_bf16.safetensors`
- 加速：TESpeedQwenImage21 + 8步 turbo LoRA（`p_qwen_image_2.1_8step_v0.1.safetensors`，走 WP_LoRAStackLoader）+ QwenImage21Cache
- KSampler：8 步、CFG 1、res_2s、simple、denoise 1
- 参考图输入：TextEncodeQwenImage21 的 `images.image_1`，先过 ImageScaleToTotalPixels（lanczos, 1MP, steps 32）
- 分辨率对齐：EmptyLatentImage 用 1152x2048（9:16 等比、32 倍数），输出后 lanczos 缩放回原图 1125x2000（导出节点内还会再做一次自动对齐，双保险）

## 七、环境与运行须知（踩坑记录）

| 事项 | 要点 |
|------|------|
| Python | `e:\comfy-UI\ComfyUINeo\py313\python.exe`（ComfyUI 同环境；系统 python 不在 PATH） |
| ComfyUI 地址 | `http://127.0.0.1:8188`，跑 API 类任务前需用户先启动 ComfyUI |
| **沙箱陷阱** | **跑 GPU/模型脚本必须非沙箱模式**（沙箱与 CUDA 驱动冲突死锁）；纯 HTTP/PIL/psd-tools 脚本无此问题 |
| PowerShell | 终端是 PowerShell 5，不支持 `&&` 链式命令，用 `;` 分隔；py_compile 语法自检命令模板：`& "e:\comfy-UI\ComfyUINeo\py313\python.exe" -m py_compile "文件路径"; echo "exit=$LASTEXITCODE"` |
| 僵尸进程 | 后台脚本跑完可能不退出，`Get-Process python` 查 + `Stop-Process -Id <pid> -Force` 清理 |
| HF 缓存 | HF_HOME 已指向 `models/hugface`，离线模式可用 |
| 热重载 | ComfyUINeo 热重载时机不可控，改节点代码后**必须彻底重启**验证 |
| 节点内写文件 | 用绝对路径（folder_paths API 正常，仅 TEMP 环境变量异常） |
| 临时产物目录 | `C:\Users\19810\AppData\Local\Temp\wp_psd_poc\`（PoC 产物在此，少爷保留） |
| 用户习惯 | 少爷会随手删跑完的临时 PoC 脚本（正常习惯），需重跑重新生成即可 |

## 八、下一步工作（按优先级）

1. **少爷重启 ComfyUI 统一验证**（一次验证两件事）：
   - WP_PsdExport：在已联调通过的饮品海报管线下游加「🐳 WP PSD导出」连四根线 Run → output 目录找 `psd_export_时间戳.psd` → PS/Photopea 检查层数/中文层名/透明区
   - WP_PsdSplitter：搜「🐳 WP PSD拆解」→ 下拉框应含"标准拆解管线" → 载入看 20 节点完整链（PSD 链 5 节点 + Qwen 全套）→ 管理弹窗试存/覆盖/删 → 完整链跑一张图出 PSD
2. 待观察：API 规划波动若持续高频（bbox 兜底常 >8 层），考虑优化规划提示词 bbox 精度 / 精抠宽松二次匹配（需少爷数据确认再做）
3. （可选）PoC-3 v3 收尾：mask 覆盖率 <30% 的层整 bbox 涂红兜底，预计删干净残留 Logo/要点文字
4. （全部验证通过后）项目收尾：requirements.txt 补 psd-tools；插件打包分发（少爷要求每轮只留最新构建）

## 九、协作规则（少爷的要求）

- 始终中文回复，称呼用户"少爷"
- 少爷零基础编程：解释用通俗中文，说清"为什么"；方案给最佳实践并说明与简单方案的区别
- **改代码前必须先列方案（改动文件、目的、影响、验证方式）并等确认**；临时 PoC 脚本同样遵守
- 不要自动 git commit（用户明确要求时才提交）
- 完成后用零基础能懂的方式汇报：改了什么、怎么验证、下一步可怎么优化
- 大任务拆小步，每步可独立验证
- 少爷切换账号频繁：本文档是唯一交接依据，每个阶段完成后立即更新

---

*文档整理时间：2026-10-16。当前进度：五个节点全部开发完成（导出节点冒烟测试过、启动器结构校验过），全部待少爷重启 ComfyUI 统一验证；验证全过即项目收尾。*
