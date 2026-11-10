# DSH × RapidOCR 本地视觉识别插件 —— 技术评估

> **状态：已实施完成。** 插件 `@local/dsh-rapidocr` 已装入 `desktop` profile 并启用，`ocr_image` 工具已在真实 Host 中验证可用。
> 实施记录见 **[docs/implementation.md](implementation.md)**；本文保留评估阶段的数据与论证。

评估日期：2026-11-06 ｜ 目标运行时：DeepSeek Harness Desktop `0.2.2-rc.1`（Electron 44.7.0 / Node 24.21.0），profile `desktop`
测试机：Intel i7-10700F @2.9GHz（8 核 / 16 线程，无 GPU），Windows 11

配套文档：**[docs/dsh-integration.md](dsh-integration.md)**（DSH 插件 API 证据，含行号）

---

## 1. 结论

**可行，且已验证到"可直接开工"的程度。** 评估过程中已经把最关键的风险点（纯 Node 能否复现 RapidOCR 精度）实测跑通了：

> 已完成的原型 `bench/node/` 是一个**纯 Node.js 的 RapidOCR 移植**（onnxruntime-node + OpenCV.js WASM + clipper-lib + pngjs，**零 Python、零编译步骤**），在 3 张基准图上把 Python 参考实现的输出**逐字节复现**：17/17 行的文本与置信度分数完全相同，检测框、裁剪尺寸、方向分类分数也完全相同；A4 压力测试 68/68 行文本相同（68 个框中 1 个差 1 px）。而且**比 Python 快 15–25%**。

**最终推荐形态：**

> 一个 Host-only bundle，注册一个 `ocr_image` 工具；OCR 引擎跑在**常驻 Node 子进程（sidecar）**里；模型是 13 MB 的 ONNX；全链路 CPU 推理、离线可用、图片不出本机。

三条核心判断：

1. **能力缺口真实存在。** 对整个 `app.asar`（22,102 个文件）做正则扫描确认：本版本 DSH **没有任何 OCR / 视觉描述工具**。唯一沾边的是内置 `read_image`，它"图片进、图片出"，模型只能靠多模态能力看图；而 agent 常用的 `MiniMax-M3.1-Flash` 这类文本模型**根本看不到图**。所以本地 OCR 的直接价值是：**给纯文本模型补上"看图识字"的能力**，同时图片不出本机、零 VLM token 成本。
2. **端到端链路已验证可行。** 用户在对话里附一张截图 → 模型侧收到的提示词里是一行 `[Image: "C:\...\x.png"; image/png; 1280x720. Use read_image to view it.]`（`dsh-spill-policy/lib/index.js:175`，已逐行核对）→ 模型拿这个路径调 `ocr_image(file_path)` → 拿到文本。**这条路不需要任何新机制。**
3. **性能对"截图"场景非常够用，对"整页扫描件"不够快。** 1280×720 截图预热后 **495 ms**，1920×1080 **1.07 s**；但 A4 300dpi 扫描件（68 行）要 **9.3 s**。瓶颈是识别阶段，**约 120–210 ms / 行**。

---

## 2. 实测数据

### 2.1 模型

| 模型 | 用途 | 大小 |
|---|---|---|
| `ch_PP-OCRv3_det_infer.onnx` | 文本检测 DBNet | 2.32 MB |
| `ch_PP-OCRv3_rec_infer.onnx` | 文本识别 CRNN | 10.20 MB |
| `ch_ppocr_mobile_v2.0_cls_infer.onnx` | 方向分类（0°/180°） | 0.56 MB |
| **合计** | | **13.07 MB** |

字符表（6623 字，中英文 + 符号）**内嵌在 rec 模型的 ONNX metadata 里**，不是外部文件。许可证：RapidOCR 与 PP-OCRv3 均为 **Apache-2.0**，可自由随包分发。

### 2.2 延迟（i7-10700F，无 GPU，ORT 默认多线程）

| 场景 | Node 预热中位数 | Python 参考 | Node 阶段拆解 (det/cls/rec) | 行数 | 与 Python 逐行一致 |
|---|---|---|---|---|---|
| 1280×720 截图 | **495 ms** | 633 ms | 134 / 4 / 275 ms | 6 | 6/6 |
| 800×600 中英混排 | **568 ms** | 669 ms | 118 / 16 / 413 ms | 5 | 5/5 |
| 1920×1080 密集文本 | **1,068 ms** | 1,197 ms | 375 / 7 / 563 ms | 6 | 6/6 |
| A4 300dpi 扫描件（2480×3508） | **9,254 ms** | 10,504 ms | 3,058 / 52 / 10,507 ms | 68 | 68/68（1 框差 1 px） |

冷启动（首次调用，含模型加载）：Node 844–1,741 ms；模型加载本身 **411 ms**（Python 448 ms）。
内存：3 张基准图峰值 RSS **552 MB**；A4 扫描件峰值 **1,769 MB**（OpenCV.js WASM 堆是主要来源）。

**吞吐换算：约 120–210 ms / 文本行。** 截图（5–8 行）＝半秒到一秒；整页文档（60+ 行）＝10 秒量级。

### 2.3 已排除的调优方向

`rec_batch_num` 从 6 调到 16/32/64，A4 场景反而更慢（10.4 s → 11.6 s → 14–21 s）。**批量大小不是杠杆，保持默认 6。**
真正有效的杠杆是**输入降采样**（A4 场景先缩到长边 ~1600 px 再送检）和**按段落切块**。

---

## 3. 候选架构对比

| | **A. Python sidecar** | **B. 纯 Node sidecar（推荐，已验证）** | **C. MCP 配置型 bundle** |
|---|---|---|---|
| 引擎 | RapidOCR（Python） | onnxruntime-node + 自移植管线 | Python MCP server |
| 额外运行时 | 需 Python + **262 MB** venv | **无**（Node 已在 DSH 里） | 需 Python + MCP 包 |
| 精度 | 官方基准 | **已实测与官方逐字节一致** | 同 A |
| 离线可用 | 需先装 venv | **装完即用** | 需先装 venv |
| 速度 | 基准 | **快 15–25%** | 同 A |
| 开发量 | 小 | 中（已完成核心） | 中 |
| 与 DSH 契合度 | 中 | **高（与 sensevoice 插件同构）** | 低（多一层协议，不便分发二进制模型） |

**C 不推荐**：MCP 适合接现成远程服务，不适合"分发 13 MB 二进制 + 常驻本地进程"。
**A 作为兜底保留**：若将来要支持手写体/表格等超出 PP-OCRv3 能力的需求，可换用更新的 RapidOCR Python 版而不必重写管线。

---

## 4. 推荐架构（B）

### 4.1 组件

```
DSH Host (Electron 44.7.0)
└── bundle @local/dsh-rapidocr          ← Host-only，无 client.js
    ├── index.js                         ← apply(ctx, config)，注册 ocr_image
    ├── worker/ocr-worker.js             ← 常驻 sidecar（ELECTRON_RUN_AS_NODE=1），JSON Lines 协议
    ├── src/                             ← 已验证的移植代码（det/cls/rec/geometry/matops/image/onnxMetadata）
    ├── models/*.onnx                    ← 13 MB
    ├── locale/{en,zh}.json + icon.svg
    └── cordis.patch.yml
```

### 4.2 关键技术结论（全部已验证）

- **纯 Node 管线可行**：移植了 det 预处理/DB 后处理/unclip、方向分类、rec 预处理 + CTC 解码，输出与 Python 参考**逐字节一致**。
- **`onnxruntime-node` 没有 model metadata API**：字符表用自写的最小 ONNX protobuf 扫描器（`src/onnxMetadata.js`）从 metadata_props 取出，6623 条与 Python `session.get_character_list()` 完全相同。**运行期零 Python、零外部字典文件。**
- **DB 的 unclip 需要多边形偏移**：Python 侧靠 `pyclipper`，Node 侧用 `clipper-lib`（Clipper 6.4.2 的纯 JS 移植，即 pyclipper 封装的那个库），并复刻了 pyclipper 的**路径坐标截断**与**偏移距离四舍五入到 half-away-from-zero**。
  - ⚠️ 踩坑：常见的 `js-angusj-clipper`（WASM 版）在 **Node 24 下返回空的偏移结果**，不可用；`clipper-lib` 可用。
- **图像处理用 OpenCV.js WASM**（`@techstark/opencv-js` 5.0.0 —— 与 Python `cv2 5.0.0` **同一发布版本**，所以 resize/warpPerspective/findContours/minAreaRect 的行为一致）。注意 OpenCV.js 5 的 `cv.boxPoints()` 返回 `{x,y}[]` 而非 Mat。
- **数值语义差异已复刻**：Python `round()` 是 half-to-even，JS `Math.round` 是 half-up；`np.round` 又是 half-even。移植里逐处对齐（例：Python `round(77.5)=78`）。
- **原生 `.node` 插件可在 DSH Host 内加载**：先例——`@deepseek-ai/dsh-attachment-local` 在 Host 里 `require('sharp')`（N-API）。Electron 44.7.0 支持 N-API v8+，ABI 稳定。
- **但推理仍应放 sidecar**：把 30 MB 的 `onnxruntime.dll` 塞进 Electron 主进程，1–10 秒同步推理会**卡住整个 GUI**。子进程隔离，同时对齐 sensevoice 插件的成熟做法。
- **sidecar 通信**：DSH 有现成 `ctx.subprocess.spawn({ argv, cwd, graceMs, env, stdio })` → `handle.stdin/stdout/done/terminate()/waitForExit()`；sensevoice 插件就是这么起的（`env: { ELECTRON_RUN_AS_NODE: '1' }`）。协议用 **stdin/stdout 上的 JSON Lines**。
- **图片如何进入工具**：DSH 既有约定是**路径字符串**（内置 `read_image` 参数就是 `file_path: string`），经 `ctx.workingDirectory.ensure(agent)` → `ctx.fs.resolve()` → `ctx.fs.readBytes()`。
  → 工具同样用 `file_path` 入参，**在 Host 侧读字节、经管道喂给 sidecar**，路径授权仍归 `ctx.fs`，不绕沙箱。
- **模型文件随 bundle 走**：本地目录安装是 `link:`，`files` 不过滤；走 registry/tarball 安装则必须把 `models/*.onnx` 列进 `files`。

### 4.3 依赖体积（这是本方案最大的实际成本）

| 依赖 | 用途 | 解包体积 | 压缩下载 |
|---|---|---|---|
| `onnxruntime-node` | ONNX 推理（预编译二进制） | 307 MB（含**全部平台**） | **110 MB** |
| `@techstark/opencv-js` | OpenCV 5.0 WASM | 14.7 MB | ~4 MB |
| `pngjs` | PNG 解码（纯 JS） | 0.65 MB | — |
| `clipper-lib` | Clipper 纯 JS 移植 | 0.21 MB | — |
| 自带模型 | 3 个 ONNX | 13.07 MB | 13 MB |
| **合计** | | **~336 MB** | **~127 MB** |

**两个可选的瘦身方案**（实施阶段选一）：

- **方案 i（声明为 npm 依赖）**：走正常 pnpm 流程，但需用户批准 `onnxruntime-node` 的 postinstall（pnpm 11 默认拦截构建脚本），且磁盘上留 307 MB。
- **方案 ii（vendor 进 bundle）**：把 `onnxruntime-node` 只保留 `lib/` + `bin/napi-v6/win32/x64/`（**onnxruntime.dll 30.3 MB + binding 0.34 MB**），连同 opencv-js / pngjs / clipper-lib 一起 vendor 进 bundle 目录，**零 npm 依赖、零构建脚本、零安装授权**，Windows 侧总体积降到 ~50 MB。代价是要自己跟进上游版本。
  → **建议 v1 走方案 ii**（本项目以 Windows 桌面为主），同时保留方案 i 作为跨平台打包路径。

### 4.4 工具契约（骨架）

```js
ctx.tools.register({
  name: 'ocr_image',
  description: 'Recognise text in an image file with a local CPU OCR engine and return the text.',
  parameters: {                      // 裸 JSON Schema，不是 zod
    type: 'object', additionalProperties: false,
    properties: { file_path: { type: 'string', description: '...' } },
    required: ['file_path'],
  },
  output: {
    schema: { type: 'object', properties: { path: {type:'string'}, text: {type:'string'} }, required:['path','text'] },
    render: (_args, value) => [{ type: 'text', text: `<path>${value.path}</path>\n<text>\n${value.text}\n</text>` }],
  },
  timeoutMs: 120_000,
  isConcurrencySafe: () => true,
  async execute(args, exec) { /* ctx.fs 解析 → sidecar → 返回 { path, text } */ },
})
```

注意：profile bundle **不能 import `@deepseek-ai/dsh-tools`**（profile 的 `node_modules/@deepseek-ai` 只有 `cosmokit` 和 `schemastery`），所以要手写裸 `ToolDefinition`，不能用 `defineTool` 辅助函数。

---

## 5. 能力边界（必须说清）

| 能力 | 状态 |
|---|---|
| 中英文/数字/常见符号识别 | ✅ 强项，6623 字符表 |
| 截图、网页、UI 界面文字 | ✅ 主要目标场景，0.5–1.1 s |
| 180° 倒置文本 | ✅ 内置方向分类模型自动纠正 |
| 倾斜文本 | ⚠️ 轻度倾斜可，剧烈透视/曲面不行 |
| 手写体 | ❌ 不行（PP-OCR 是印刷体模型） |
| **图片内容理解 / 描述 / 物体识别** | ❌ **RapidOCR 不是 VLM，做不了**。要"看懂图"仍需多模态模型 |
| 表格结构还原 | ❌ 只出文本行 + 坐标，不出表格结构 |
| 竖排古籍 / 极小字号（<10 px） | ❌ / ⚠️ |
| 单次处理上百行 | ⚠️ 9 s+ 且内存峰值 1.8 GB，建议先降采样或切块 |
| WebP / AVIF 输入 | ⚠️ 当前只解码 PNG/JPEG，需另加解码器 |

**一句话**：这个插件解决的是"**把图里的字抠出来变成文本**"，不是"**理解图里有什么**"。

---

## 6. 待决策项

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| 1 | **能力范围** | (a) 只做 OCR；(b) 加表格结构还原 | **(a) 只做 OCR**。结构还原要另加模型，工作量翻倍 |
| 2 | **引擎实现** | (a) 纯 Node；(b) Python sidecar | **(a) 纯 Node**（已实测逐字节一致且更快） |
| 3 | **依赖打包** | (a) vendor 进 bundle（~50 MB，零安装授权）；(b) 声明 npm 依赖（127 MB 下载 + 需批准构建脚本） | **(a)**，跨平台场景再考虑 (b) |
| 4 | **模型分发** | (a) 随 bundle 打包 13 MB；(b) 首次使用时下载 | **(a)**，装完即用、离线可用 |
| 5 | **工具粒度** | (a) 只有 `ocr_image`；(b) 另加 `ocr_batch` | **(a)** 先做单图 |

---

## 7. 实施计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 纯 Node 移植验证 | ✅ **已完成**（`bench/node/`，17/17 行逐字节一致） |
| 1 | 抽离为 bundle（`package.json` / `cordis.patch.yml` / `locale` / `icon` / `index.js`） | ✅ 已完成 |
| 2 | sidecar 化（`worker/ocr-worker.js` JSON Lines 协议 + `ctx.subprocess.spawn` 生命周期 + 崩溃重启） | ✅ 已完成 |
| 3 | 工具接线（`ocr_image` 注册、`ctx.fs` 路径解析、超时/取消、system prompt 引导语） | ✅ 已完成 |
| 4 | 依赖 vendor 化（按 §4.3 方案 ii） | ✅ 已完成（46 MB vendor，零 npm 依赖） |
| 5 | 安装与验证（`plugin_manager install_bundle` → 实际调用 → 核对渲染结果） | ✅ 已完成（装入 desktop profile 并启用，真实 Host 内验证） |
| 6 | 打磨（图标/多语言文案/错误提示/并发控制/大图降采样策略） | 🟡 部分完成：图标、双语 locale、错误提示、并发、`maxPixels` 像素上限均已就绪；**大图降采样仍未做**（超过 4000 万像素直接拒绝，不是自动缩小） |

---

## 8. 风险清单

| 风险 | 等级 | 说明与对策 |
|---|---|---|
| 依赖体积 | 中 | ORT npm 包 307 MB 解包 / 110 MB 下载。**对策：vendor 方案（§4.3 ii）降到 ~50 MB** |
| 大图/整页扫描件耗时 9 s+、内存峰值 1.8 GB | 中 | 工具内加降采样阈值（长边 ~1600 px）+ 明确的耗时提示；对 agent 而言 9 s 仍在 120 s timeout 内 |
| sidecar 崩溃导致工具不可用 | 中 | 需实现"首次调用时惰性拉起 + 崩溃自动重启 + 失败降级为明确错误信息" |
| OpenCV.js WASM 堆内存 | 中 | 堆是 RSS 主因；已在 ORT 侧关闭 arena（与 Python 一致）把 970 MB 压到 552 MB |
| 移植代码需跟随上游模型变更 | 低 | 模型版本与字符表一起锁；模型升级时重跑基准对齐脚本 |
| `character.txt` 与模型版本脱耦 | 低 | v1 直接用 protobuf 扫描器运行时读取，无外部文件 |
| 工具全局可见影响 minimal preset | 低 | `ctx.tools.register` 注册在 root ctx 即全局；若要收窄，注册到 `agent.ctx` |
| 许可证 | 低 | RapidOCR / PP-OCRv3 均 Apache-2.0，可自由分发；随包附 NOTICE |
| WebP/AVIF 不支持 | 低 | 需要时加一个解码器即可 |

---

## 附录：复现方式

```powershell
cd bench                                          # 仓库根目录下
.\.venv\Scripts\python.exe bench_python.py       # Python 参考基准 -> report_python.json
cd node
npm install
node cli/ocr.js ../samples/screenshot_1280x720.png # 单图识别
npm run bench                                     # 基准测试 -> node/report_node.{json,md}
```
