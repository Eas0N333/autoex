# AI 答题系统

截图识别题目 → 结构化编辑 → AI 流式解答。纯 Node 零依赖服务端 + 零构建前端，默认离线演示模式，填入任意 OpenAI 兼容模型的 Key 即可切换在线模式。

两种形态共用同一套引擎（`server/`）：**桌面悬浮窗**（Electron，贴左边缘、自动盯屏取题）与 **网页版**（本地 HTTP 服务 + 浏览器 UI）。

## 功能

- **四种取题方式**：拖拽图片、选择文件、`Ctrl/Cmd+V` 粘贴截图、`getDisplayMedia` 屏幕截图（可直接框选浏览器里正在显示的线上题目）。
- **视觉识别**：图片交给多模态模型转写题干、学科、题型、选项（LaTeX 保留为 `$...$`），识别结果可手动修改、增删选项。
- **流式解答**：`fetch` + SSE，边生成边渲染 Markdown，支持 `停止`；答案先给结论再给解析，三档风格（简洁 / 详细 / 逐步讲解）。
- **多模型交叉验证**：一次解答可并行调用 3 个模型独立作答，再由评审模型核对三份答案、纠正分歧并流式输出最终答案（DeepSeek 官方 / Command Code 订阅等 OpenAI 兼容端点可混用）。
- **模型下拉选择**：桌面设置里文本模型、识别模型（OCR）、候选与评审模型都从内置目录下拉选择；目录按全局 Base URL 自动切换（Command Code 67 个、DeepSeek 官方 2 个），无需手输模型名。
- **缓存与历史**：相同题目 + 风格命中服务端答案缓存（`来自缓存` 标记）；最近 20 条记录保存在本机 `localStorage`。
- **演示模式**：未配置 Key 时用内置示例题库，整条链路（识别 → SSE 解答 → 缓存 → 历史）照常可跑，页面有明确标记。

## 桌面悬浮窗（Electron，Windows / macOS）

除网页版外，本仓库还提供贴屏幕左边缘的常驻悬浮窗：选定一个浏览器窗口后持续截帧，检测到题目变化就用视觉模型识别并流式解答，答案始终停在左侧，不打断右侧的浏览/做题。

### 安装与运行

```bash
npm install        # 只安装开发依赖（electron + electron-builder），运行时依赖为空
npm run desktop    # 启动悬浮窗
```

- 首次启动即为**演示模式**（内置示例题库，无需 Key），窗口顶部有"演示"徽标。
- 切换在线模式：打开设置抽屉，填写 API Base URL / Key，再从下拉中选择文本模型与视觉模型。设置保存在系统 userData 目录（Windows `%APPDATA%\AI 答题助手\settings.json`，macOS `~/Library/Application Support/AI 答题助手/settings.json`）。
- 调试用环境变量：`AQS_SETTINGS=<文件路径>` 覆盖设置文件位置，`AI_DEMO=1` 强制演示模式。

### 使用

1. 点「选择浏览器窗口」，从缩略图列表中选择 Chrome / Edge / Firefox / Safari / Arc / Brave / Opera / 360 / QQ 浏览器等窗口（浏览器排在最前，也可选整个屏幕）。
2. 选好后自动开始截帧。题目变化 → 自动识别 → 自动解答（开关可关）；识别文本可编辑后重新提交。
3. 需要立即取题时点「扫描一次」；答案卡底部显示耗时、是否命中缓存与字符数。

### 快捷键（默认值）

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl/Cmd+Shift+Q` | 显示 / 隐藏悬浮窗 |
| `Ctrl/Cmd+Shift+S` | 立即扫描一次 |
| `Ctrl/Cmd+Shift+P` | 暂停 / 继续自动识别 |

### 本地演示页（测试用）

```bash
npm run demo:page        # http://127.0.0.1:8899/
```

一个四题的练习页（数学/物理/化学，含选项与「下一题」），用来试悬浮窗的自动取题：打开页面后在悬浮窗里选中该浏览器窗口，点「下一题」即可看到题目变化 → 自动识别 → 解答。未配置 API Key 时为演示答案，配置后走真实模型。

### 多模型交叉验证（3 份作答 + 1 次评审）

开启后每次解答先并行请求最多 3 个候选模型独立作答（互不可见），再把三份答案交给评审模型逐份核对、指出错误并流式输出最终答案；选择题明确给出选项字母，结尾附 `【一致性】` 结论。单个候选失败不影响其余候选；评审失败时自动回退为第一个成功候选的原文。悬浮窗自动条与网页版「回答风格」旁都有「交叉验证」开关，答案卡展示三张候选卡片（可展开全文）、评审模型与耗时。

配置（桌面：设置抽屉 → 交叉验证；网页：`config.json`）：

```json
{
  "ai": {
    "baseUrl": "https://api.commandcode.ai/provider/v1",
    "apiKey": "cmd-…",
    "model": "deepseek/deepseek-v4.1-flash",
    "visionModel": "deepseek/deepseek-v4.1-flash",
    "ensemble": {
      "enabled": true,
      "candidates": [
        { "name": "DeepSeek V4.1 Flash", "model": "deepseek/deepseek-v4.1-flash", "temperature": 0.3 },
        { "name": "Gemini 3.8 Flash", "model": "google/gemini-3.8-flash", "temperature": 0.6 },
        { "name": "Qwen 3.8 Max", "model": "Qwen/Qwen3.8-Max", "temperature": 0.9 }
      ],
      "judge": { "name": "评审", "model": "deepseek/deepseek-v4-pro", "temperature": 0.1 }
    }
  }
}
```

上例所有候选与评审都省略了 `baseUrl` / `apiKey`，因此共用同一个 Command Code 订阅 Key。网页版没有桌面设置抽屉，模型字段直接写目录里的 id；桌面下拉会把同一个 id 显示成可读名称（如 `DeepSeek V4.1 Flash (latest)`）。

预设与下拉目录（设置抽屉先选 Base URL，模型一栏就变成该端点的下拉；已有值不会被覆盖）：

| 预设 | Base URL | 下拉可选模型（均走 `/chat/completions`） |
| --- | --- | --- |
| Command Code 订阅（GOAT） | `https://api.commandcode.ai/provider/v1` | 67 个（其中 11 个支持视觉）：`deepseek/*`、`google/gemini-*`、`gpt-*`、`Qwen/*`、`GLM/*`、`Kimi/*`、`Grok/*` 等 |
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-flash`（支持视觉）、`deepseek-v4-pro`（无视觉） |
| OpenAI | `https://api.openai.com/v1` | 无内置目录：回退为文本输入（如 `gpt-4o-mini`），自定义端点同样如此 |

Command Code 只需在「模型服务」填**一个订阅 Key**：候选与评审的 Base URL / Key 收在「高级：自定义端点 / Key」里且默认折叠，留空即继承全局，同一个订阅 Key 可以驱动多个模型；模型、视觉模型、候选、评审全部从下拉里选，不用记模型名。下拉随全局 Base URL 切换（hostname 含 `commandcode.ai` → 67 个 GOAT 模型；含 `api.deepseek.com` → 2 个官方模型；OpenAI 与其它自定义端点没有内置目录，回退为手输模型 id）。只有选中了模型的候选才参与，至少需要 2 个。Command Code 使用 `Authorization: Bearer <CMD_API_KEY>`。

> - DeepSeek 官方 `deepseek-flash`（V4.1 Flash）**支持视觉**，可直接把 `visionModel` 设为 `deepseek-flash`（图片按官方文档以 `image_url` + base64 data URL 放在 user 消息里）；`deepseek-v4-pro` 不支持视觉。
> - Command Code 的 67 个模型是 GOAT 计划可用模型与 `/provider/v1/models` 中支持 `/chat/completions` 的交集。**Claude 系列只提供 `/messages` 端点**，本应用统一走 `/chat/completions`，所以不在下拉里；`Jev` 是 decision 模型，同样不可选。
> - Command Code 的模型目录可公开查询：`GET https://api.commandcode.ai/provider/v1/models`（含 `supported_endpoints`）。

### 连接自检

设置抽屉「模型服务」里的 API Key 下方常驻一行连接状态：填完 Key 不用等答题，就能立刻知道连接是否成功、哪些模型真的可用。

- **自动触发**：API Key 输入停止 1 秒且长度 ≥ 8 时自动测试（直接用还没保存的 Key，不会顺手存盘）；文本/视觉/候选/评审模型或 Base URL 变化后 0.8 秒自动重测；点「保存」成功后立即再测一次；切换预设会清空旧结果并在已有 Key 时自动测试。留空 Key 时显示「未填写 API Key，当前为演示模式」，不发任何请求。
- **状态**：测试中显示「正在验证连接…」；全部可用显示「已连接 · N/N 个模型可用 · 耗时」；部分失败显示「部分模型不可用（M/N）」；全部失败显示「连接失败：中文原因」。
- **每个模型单独检测**：文本、视觉（OCR）、每个候选、评审各占一行，显示角色、模型名、耗时和 ✓/✗，失败时给出 `AUTH（401）`、`PLAN`、`MODEL_NOT_FOUND`、`RATE_LIMITED`、`TIMEOUT`、`NETWORK` 等代码和中文说明（例如 403 会写明「该模型不在当前订阅计划内」）。一个 Key 驱动多个模型时，某个模型不在订阅内不会掩盖其余模型可用。
- **探测成本与私密性**：每行只是一次 `ping`（最多 8 token，temperature 0，不重试）的真实 `/chat/completions` 请求，**会计费**（通常可忽略），但确实会走你的真实额度。探测结果只展示主机名，界面、日志和返回数据里都不会出现明文 Key 或完整 URL；保存前的临时 Key 只用于本次探测。

### 自动检测与隐私

- 只捕获你选中的那一个窗口；帧在渲染进程 canvas 内缩放、裁剪并编码为 JPEG，仅在内存中转发给视觉模型，**不写入磁盘**。
- 触发条件：16×16 感知哈希（dHash）变化超过灵敏度阈值、连续两帧稳定、非空白页，冷却时间 ≥4 秒；滚动/动画不会反复触发。
- 悬浮窗开启内容保护（`setContentProtection`），不会截入它自己的画面；主进程不监听端口、不启动 HTTP 服务，直接复用 `server/` 引擎。
- 密钥只存在主进程与本机设置文件里，不下发渲染进程、不写日志；渲染层只拿到 `hasApiKey` 布尔值。渲染进程 `sandbox` + `contextIsolation`，无 Node 权限，CSP 默认拒绝外连（仅 KaTeX 可选 CDN，加载失败自动降级为可读 TeX）。
- Windows 无需额外授权；macOS 首次采集需要在「系统设置 → 隐私与安全性 → 屏幕录制」中授权本应用，应用内会提示并提供直达按钮。

### 打包

```bash
npm run pack:win   # Windows：nsis 安装包 + portable 免安装版 → dist/
npm run pack:mac   # macOS：dmg + zip → dist/（必须在 macOS 上执行，Windows 不能构建 dmg）
```

- 打包内容为白名单：`electron/**/*`、`server/**/*`、`web/render.js`、`package.json`、`build/icon.png`、`build/tray.png`、`build/trayTemplate.png`；`test/`、`docs/`、`fixtures/`、`dist/` 不会进入安装包。
- Windows 已在开发机实测：`npx electron-builder --win dir` 产出 `dist/win-unpacked/AI 答题助手.exe`（已用 `--smoke` 启动验证），`npm run pack:win` 产出 `dist/AI 答题助手 Setup 1.0.0.exe`（98 MB，NSIS，可选安装目录）与免安装 `dist/AI 答题助手 1.0.0.exe`（90 MB）。未配置代码签名，SmartScreen 会提示"未知发布者"，可选「更多信息 → 仍要运行」。
- macOS 构建与运行**未在 mac 机器上实测**（Windows 无法交叉构建 dmg）：`npm run pack:mac` 必须在真实 macOS 上执行，产物为 `dist/*.dmg` 与 `dist/*.zip`；未签名包首次打开需右键「打开」以通过 Gatekeeper。

## 网页版快速开始

要求 Node.js ≥ 20.6（开发验证于 Node 24）。仅使用网页版时无需 `npm install`。

```bash
npm start          # http://127.0.0.1:8787
```

首次启动即为**演示模式**。接入真实模型：

```bash
cp config.example.json config.json   # 或直接用环境变量
# 编辑 config.json 填入 ai.apiKey / ai.baseUrl / ai.model / ai.visionModel
npm start
```

环境变量优先于 `config.json`：

| 变量 | 说明 |
| --- | --- |
| `AI_API_KEY`（或 `OPENAI_API_KEY`） | 模型密钥；留空即演示模式 |
| `AI_BASE_URL` | OpenAI 兼容端点，默认 `https://api.openai.com/v1` |
| `AI_MODEL` | 文本模型，默认 `gpt-4o-mini` |
| `AI_VISION_MODEL` | 识别用视觉模型，默认同 `AI_MODEL` |
| `AI_VISION_BASE_URL` / `AI_VISION_API_KEY` | OCR 独立端点（可选，留空继承主端点） |
| `AI_ENSEMBLE=1` | 开启多模型交叉验证（候选模型在 `config.json` 的 `ai.ensemble` 中配置） |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` | 单次请求超时（默认 60s）、失败重试次数（默认 1） |
| `HOST` / `PORT` | 监听地址，默认 `127.0.0.1:8787` |
| `AI_DEMO=1` | 强制演示模式 |
| `MAX_IMAGE_BYTES` / `MAX_BODY_BYTES` / `RATE_PER_MINUTE` | 上传与限流上限 |

任何 OpenAI 兼容服务都可直接使用（OpenAI、DeepSeek、Command Code 订阅、通义千问兼容模式、Moonshot、vLLM、Ollama 等），只需改 `AI_BASE_URL`；多模态模型放在 `AI_VISION_MODEL`，图片请求会自动路由到它。DeepSeek 官方 `deepseek-flash` 支持视觉（`AI_VISION_MODEL=deepseek-flash`），`deepseek-v4-pro` 不支持，需要另配 `AI_VISION_BASE_URL`/`AI_VISION_MODEL`。

## 使用流程

1. 拖拽 / 粘贴 / 截图上传题目图片，点击 **识别题目**。
2. 检查并可修改题干、学科、题型、选项（识别不到选项时手动 `＋ 添加选项`）。
3. 选择回答风格，**提交 AI 解答**（`Ctrl/Cmd+Enter`），答案实时流式输出。
4. 完成后自动写入历史；点击历史条目可回填题目与答案。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 模式、模型、限制、版本 |
| GET | `/api/config` | 前端引导配置 |
| POST | `/api/recognize` | `{imageDataUrl}` → 题干、选项、学科、题型、置信度 |
| POST | `/api/answer` | `{question, options?, subject?, style?, imageDataUrl?, ensemble?}` → SSE：`meta` → `candidate`\* → `delta`\* → `done`，或 `error` |

`Accept: application/json` 时 `/api/answer` 返回聚合后的 `{answer, mode, model, cached, durationMs, ensemble, candidates, judge, fallback}`。

`ensemble:true` 时 `candidate` 事件逐个报告候选状态（`running/done/error`、模型名、耗时、答案），`done` 附带全部候选、评审状态与是否回退。

错误统一为 `{"error":{"code":"BAD_REQUEST|PAYLOAD_TOO_LARGE|RATE_LIMITED|UNSUPPORTED|UPSTREAM_ERROR|TIMEOUT|INTERNAL","message":"…"}}`。

## 安全与边界

- 密钥只在服务端读取，不下发、不写日志；上游失败只返回截断后的错误摘要。
- 图片不落盘，仅以 base64 随请求转发给模型。
- 请求体/图片大小限制、按 IP 限流（默认 40 次/分钟）、静态目录穿越防护、`nosniff`。
- 前端 Markdown 渲染先转义再生成标签，链接仅允许 `http(s)`；KaTeX 走 CDN 且失败时退化为可读的 `$...$` 文本。

## 测试

```bash
npm test              # node:test 单测/集成测试（99 项），无网络、无 Key，端口随机
npm run smoke         # 启动真实 HTTP 进程跑完整 demo 链路，输出 SMOKE OK
npm run desktop:smoke # 启动真实 Electron 进程，校验左边缘停靠 + 截图，输出 DESKTOP SMOKE OK
```

`desktop:smoke` 需要已执行 `npm install`（Electron 二进制），使用临时设置文件与 `AI_DEMO=1`，不会读写你的真实配置。

## 目录

```
server/  config.js 配置 · provider.js 模型客户端（live/demo）· recognize.js 视觉识别
         answer.js 解答提示词与流式 · index.js HTTP/SSE/静态/限流 · cache.js · mock.js
         engine.js 主进程/HTTP 共用的引擎 · ensemble.js 三模型并行 + 评审 · config.js 配置
electron/ main.js 窗口/托盘/快捷键 · probe.js 连接自检 · settings.js 配置与密钥掩码 · model-catalog.js 内置模型目录（下拉选项）· sources.js 窗口源 · preload.cjs · ui/ 悬浮窗前端
web/     index.html · app.js 交互与 SSE · render.js 安全 Markdown/数学 · styles.css
build/   icon.png · icon.ico · tray.png · trayTemplate.png（打包与托盘图标）
scripts/ smoke.mjs（HTTP 冒烟）· desktop-smoke.mjs（Electron 冒烟）· demo-page.mjs（本地练习页）
demo/    quiz.html 本地练习页
test/    node:test 套件 + OpenAI 兼容 stub
docs/CONTRACT.md · CONTRACT-DESKTOP.md · CONTRACT-ENSEMBLE.md  内部接口契约
fixtures/sample-question.png  演示与冒烟用题目图
```
