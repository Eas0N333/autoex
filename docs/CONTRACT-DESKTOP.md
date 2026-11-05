# CONTRACT — Desktop Overlay (Electron, Windows + macOS)

把现有 HTTP/Web 版升级为桌面常驻应用：左侧悬浮窗，选定浏览器窗口后持续截帧，检测到题目变化就识别并流式解答。

```
┌─ Electron main (Node) ──────────────┐        ┌─ Renderer: overlay (sandboxed) ─┐
│ settings.json (userData)            │  IPC   │ 左边缘悬浮窗 UI                  │
│ createEngine(config)  ← server/*    │◄──────►│ desktopCapturer → getUserMedia   │
│ provider / recognize / answer/cache │        │ 帧差检测 → 裁剪 → 识别 → 流式答案 │
│ tray, shortcuts, alwaysOnTop        │        │ 历史 / 设置 / 窗口选择            │
└─────────────────────────────────────┘        └─────────────────────────────────┘
```

- 渲染进程 `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`，只能通过 preload 暴露的 `window.aqs`。由于根 `package.json` 是 ESM，**sandbox preload 必须是 CJS**：文件名为 `electron/preload.cjs`。
- 主进程不监听端口、不启动 HTTP 服务；直接复用 `server/` 的引擎模块。
- 采集与帧差全部在渲染进程（canvas），主进程只提供 `desktopCapturer` 源列表与窗口管理。
- 悬浮窗 `setContentProtection(true)`，避免被自己/录屏截入。

## 文件所有权

| 文件 | owner |
| --- | --- |
| `server/engine.js`, `server/index.js`(改造), `test/engine.test.js` | backend |
| `electron/main.js`, `electron/settings.js`, `electron/sources.js`, `electron/preload.js` | electron |
| `electron/ui/index.html`, `electron/ui/overlay.js`, `electron/ui/overlay.css`, `electron/ui/capture.js` | overlay |
| `package.json`(打包配置/脚本), `build/*`, `scripts/desktop-smoke.mjs`, `README.md`(桌面章节), `test/packaging.test.js` | devops |
| `docs/CONTRACT-DESKTOP.md`, `fixtures/*` | lead |

不得新增运行时依赖（`dependencies` 必须为空）；只允许 `devDependencies: electron, electron-builder`。前端不得使用打包器；`electron/ui` 以 ESM `<script type="module">` 直接加载，可 `import '../../web/render.js'`。

## 1. Engine — `server/engine.js`（backend 负责抽取）

```js
export class EngineError extends Error {}   // { code:'BAD_REQUEST'|'UNSUPPORTED'|'PAYLOAD_TOO_LARGE'|'UPSTREAM_ERROR'|'TIMEOUT'|'ABORTED', message }

export function createEngine(config) -> {
  config, limits, provider,
  mode: 'live' | 'demo',
  models: { chat, visionModel },
  validateImage(dataUrl): void            // 抛 EngineError
  recognize({ imageDataUrl, signal }): Promise<Question>   // 含 model
  answerStream(input, { signal }): AsyncIterable<Event>
  answerComplete(input, { signal }): Promise<{ text, usage, cached, durationMs }>
  clearCache(): void
}

Event =
  | { type:'meta', cached:boolean, question, options, subject, style }
  | { type:'delta', text:string }
  | { type:'usage', usage:object }
  | { type:'done', text:string, cached:boolean, durationMs:number, usage:object|null }
```

- `input = { question, options?, subject?, style?, imageDataUrl? }`；`imageDataUrl` 非空且 `question` 为空时先识别。
- 归一化、长度上限、图片校验、答案缓存（sha256(question|options|style)，LRU+TTL，仅缓存完整答案）全部下沉到 engine；`server/index.js` 只保留 HTTP 关注点（路由/限流/SSE 编码/状态码映射）并改用 engine，现有 HTTP 行为与 37 项测试必须原样通过。
- engine 不打印日志、不触碰文件系统。
- 错误码映射：HTTP 层按 `EngineError.code` 映射 400/413/415/502/504；渲染层按 `code` 显示中文提示。

## 2. 设置 — `electron/settings.js`

存储：`path.join(app.getPath('userData'), 'settings.json')`，可用环境变量 `AQS_SETTINGS` 覆盖为指定文件（冒烟测试用）。读取顺序 **env > settings.json > repo config.json > 默认值**，密钥仅存本机。

```js
{
  ai: { baseUrl, apiKey, model, visionModel, timeoutMs, maxRetries },
  auto: { enabled:true, autoAnswer:true, intervalMs:1500, sensitivity:3, crop:null },  // crop: {x,y,w,h} 0..1
  style: 'concise',
  capture: { sourceId:null, sourceName:null },
  overlay: { width:420, x:null, y:null, height:null, collapsed:false, displayId:null },
  hotkeys: { toggle:'CommandOrControl+Shift+Q', scan:'CommandOrControl+Shift+S', pause:'CommandOrControl+Shift+P' }
}
```

- `apiKey` 空 → demo 模式（engine `kind==='demo'`）。
- `loadSettings()` 容错：坏 JSON 备份为 `settings.json.bad` 并用默认值。
- `saveSettings(patch)` 深合并 + 校验（数值范围、baseUrl 形如 http(s)://、style 枚举），原子写入。
- 暴露给渲染进程的 state 中密钥替换为布尔 `hasApiKey`，**绝不回传明文**。

## 3. 窗口 / 托盘 / 快捷键 — `electron/main.js`

- 单一实例锁；第二实例唤起并展开悬浮窗。
- BrowserWindow：`frame:false, transparent:true, resizable:true, skipTaskbar:true, alwaysOnTop:true, hasShadow:false, show:false`，`minWidth:320, maxWidth:680, minHeight:420`。
- 位置：目标显示器 `workArea` 左边缘 + 12px，顶部 + 12px，高度 = workArea.height - 24；`x` 可拖拽后记忆（`settings.overlay.x/y/width/height`），越界或显示器消失时回落到默认左边缘。
- `alwaysOnTop: 'screen-saver'`；`setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`（mac）；`setContentProtection(true)`；mac 隐藏 Dock（`app.dock.hide()`），Win 不占任务栏。
- 折叠态：宽 56、高 96 的胶囊，位置仍贴左边缘；展开恢复记忆宽度。折叠状态持久化。
- 托盘菜单：显示/隐藏、自动识别开关、自动解答开关、暂停/继续、打开日志目录、退出；图标随模式变色（demo 琥珀 / live 绿），打包资源 `build/tray.png`(32)、`build/trayTemplate.png`(mac 模板, 32)。
- 全局快捷键 default：toggle/scan/pause；注册失败仅提示不崩溃。
- 权限：Windows 无需额外授权；macOS 首次采集需要"屏幕录制"权限，`systemPreferences.getMediaAccessStatus('screen')` 上报；`openScreenPermission()` 打开 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`。
- 退出时清理：`globalShortcut.unregisterAll()`、强杀 engine 流、保存窗口位置。
- `app.on('window-all-closed')` 不退出（托盘常驻），除非显式 quit。

**冒烟钩子（必做）**
- `--smoke`：等待悬浮窗 UI 完成挂载（`#app[data-ready="true"]` 且 `#panel` 可见）后再截屏并打印单行 `SMOKE_READY {json}`（含 `bounds`,`mode`,`platform`,`version`,`display`），若 `AQS_SMOKE_SHOT` 则 `capturePage()` 写 PNG。`AQS_SMOKE_TIMEOUT_MS`（默认 60000）到点未完成则 `SMOKE_FAIL <reason>` 退出码 1。
- `AQS_SMOKE_SOURCE=<窗口标题子串>`：启动后匹配 `desktopCapturer` 源并写入 `settings.capture`。
- `AQS_SMOKE_AUTO=1`：自动开启 `auto.enabled`；首个 `answer:done` 到达时打印 `SMOKE_ANSWER {"question":...,"chars":...}` 并在 `--smoke-exit` 下退出 0。
- 所有冒烟输出走 `process.stdout` 单行 JSON，日志不得污染 stdout。

## 4. 源列表 — `electron/sources.js`

```js
listSources(): Promise<Source[]>   // Source = {id, name, kind:'window'|'screen', appIcon?:string, thumbnail?:string(dataURL 320px), isBrowser:boolean}
selectSource(id): Promise<{ok, source?}>   // 校验 id 存在，写入 settings.capture
```
- `desktopCapturer.getSources({types:['window','screen'], thumbnailSize:{width:320,height:200}, fetchWindowIcons:false})`。
- 排除自身窗口（name 命中应用名/“AI 答题”），排除空标题，浏览器识别：Chrome/Edge/Firefox/Safari/Arc/Brave/Opera/360/QQ浏览器。
- 浏览器源排前；缩略图 dataURL 仅供渲染层展示。

## 5. IPC — `electron/preload.js` 暴露 `window.aqs`

```ts
getState(): Promise<State>
updateSettings(patch): Promise<State>              // 深合并；apiKey 明文只进不出
listSources(): Promise<Source[]>
selectSource(id): Promise<State>
clearSource(): Promise<State>
recognize(imageDataUrl): Promise<Question>         // reject 时 error.code/message
answer({question,options?,subject?,style?,imageDataUrl?}): Promise<{requestId}>
stopAnswer(requestId): Promise<void>
setAuto({enabled?,autoAnswer?,intervalMs?,sensitivity?,crop?}): Promise<State>
setPaused(flag): Promise<State>
captureStatus(): Promise<{source, permission, capturing}>
openScreenPermission(): Promise<void>
collapse(flag): Promise<State>
showOverlay(): Promise<void>
quit(): Promise<void>
onEvent(cb): () => void
```

通道名固定 `aqs:*`（invoke）与 `aqs:event`（主→渲染）。主进程须校验所有 IPC 入参（类型/长度/枚举），非法即 reject，不崩溃。

**State**
```js
{
  app: { version, platform, demo, locale },
  settings: { ai:{baseUrl,model,visionModel,hasApiKey}, auto, style, capture, overlay, hotkeys },
  engine: { mode, models, limits },
  runtime: { paused, busy, capturing, sourceName, permission },
  history: []            // 最近 20 条，主进程内存持久化到 settings 同目录 history.json（可选，渲染层也可自己存）
}
```

**Event**
```js
{type:'state', state}
{type:'answer:meta', requestId, cached, mode, model, question, options, subject, style}
{type:'answer:delta', requestId, text}
{type:'answer:done', requestId, text, durationMs, usage, cached}
{type:'answer:error', requestId, code, message}
{type:'recognized', question, trigger:'auto'|'manual'}
{type:'toast', level:'info'|'warn'|'error', message}
{type:'permission', screen:'granted'|'denied'|'restricted'|'unknown'|'not-darwin'}
```

- 主进程维护 `Map<requestId, AbortController>`；`stopAnswer` 中止并回 `answer:error{code:'ABORTED'}`（或静默 done，二选一并保持一致）。
- 同一时刻只允许一个活动中答案：新 `answer` 自动中止旧的（发 `answer:error{ABORTED}`）。
- 识别并发上限 1；重复图片（同 base64 且 10s 内）走 engine 缓存/直接复用结果。

## 6. 采集与自动检测 — `electron/ui/capture.js`

```js
export async function startCapture(sourceId, videoEl): Promise<MediaStream>
export function stopCapture(stream): void
export function grabFrame(videoEl, canvasEl, {crop, maxWidth=1600, quality=0.82}): {dataUrl, width, height}
export function frameHash(canvasEl): bigint           // 16x16 dHash, 256 bit
export function hamming(a, b): number
export function edgeDensity(canvasEl): number          // 0..1
```

- `getUserMedia({audio:false, video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId: sourceId, maxWidth:1920, maxHeight:1200, maxFrameRate:10}}})`；失败抛中文可读错误（mac 权限 / 源已关闭）。
- 帧：`maxWidth` 等比缩放，`crop` 为归一化矩形；JPEG dataURL。
- 检测循环（overlay.js）：
  - 间隔 `auto.intervalMs`（默认 1500ms，允许 800–5000）。
  - `frameHash` 变化 ≥ 阈值（sensitivity 1..5 → hamming 6/10/14/18/22，默认 14）视为"画面变化"。
  - 需连续 2 帧稳定（相邻 hamming ≤ 2）才触发，避免动画/滚动误判。
  - `edgeDensity < 0.02` 跳过（空白页）。
  - 冷却 `max(4000, intervalMs*2)`；`runtime.paused`/`busy` 时不触发。
  - 识别结果文本 hash 与上次相同 → 跳过，不发解答。
  - 自动解答开关关闭时只展示"检测到题目"与识别文本，等待用户点击。
- 手动：`扫描一次` 立即抓帧识别；`Alt` 提示不必要。

## 7. 悬浮窗 UI — `electron/ui/*`

布局（宽度 420 默认，可拖拽右边缘缩放）：
- **Header**（`-webkit-app-region: drag`，按钮 `no-drag`）：状态点（采集中呼吸/暂停灰）、`AI 答题`、模式徽标（演示/在线）、折叠、设置。
- **Source 行**：已选窗口名 + `更换窗口`；未选时显示 `选择浏览器窗口` 主按钮。
- **题目卡**：识别文本（可折叠、可编辑保存）+ 学科/题型小标签 + `重新识别`。
- **答案卡**：流式 Markdown（复用 `web/render.js`），`【答案】` 高亮，`复制`、`停止`、风格切换；底部状态行（耗时/缓存/字符数）。
- **自动条**：`自动识别` / `自动解答` 开关、灵敏度滑块（1–5）、暂停按钮、下次扫描倒计时。
- **历史**：抽屉列出最近 20 条（题目摘要/时间/学科），点击回填题目与答案，`清空`。
- **设置抽屉**：API Base URL、Key（password + hasApiKey 提示）、文本/视觉模型、自动间隔、灵敏度、自动解答、裁剪编辑器（最近一帧 + 拖拽矩形，归一化保存）、mac 权限按钮。
- **折叠胶囊**：仅显示状态点 + 快捷键提示，点击展开。
- 选择窗口弹层：缩略图网格、浏览器置顶、`刷新列表`、无源时提示 mac 权限。

约束：`id`/`data-testid` 固定（冒烟与 CDP 依赖）：`#status-dot`、`#btn-pick-source`、`#btn-scan`、`#btn-settings`、`#btn-collapse`、`#answer-md`、`#question-text`、`#source-name`、`#auto-enabled`、`#auto-answer`、`#btn-pause`、`[data-testid="source-picker"]`、`#toast`。CSP：`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; script-src 'self' https://cdn.jsdelivr.net; connect-src 'none'`（KaTeX 为可选增强，CDN 不可达时必须降级为可读 TeX 且不阻塞首屏）。

无框架、无构建、深浅色跟随系统、`prefers-reduced-motion`、键盘可达（Tab 顺序、Esc 关抽屉、Enter 扫描）。

## 8. 打包 — `package.json` / `build/`

```json
"main": "electron/main.js",
"scripts": {
  "start": "node server/index.js",
  "desktop": "electron .",
  "desktop:smoke": "node scripts/desktop-smoke.mjs",
  "pack:win": "electron-builder --win nsis portable",
  "pack:mac": "electron-builder --mac dmg zip"
},
"build": {
  "appId": "app.aiquiz.overlay",
  "productName": "AI 答题助手",
  "files": ["electron/**/*", "server/**/*", "web/render.js", "package.json", "build/icon.png", "build/tray.png", "build/trayTemplate.png"],
  "directories": { "output": "dist", "buildResources": "build" },
  "win": { "target": ["nsis","portable"], "icon": "build/icon.ico" },
  "mac": { "target": ["dmg","zip"], "category": "public.app-category.education", "icon": "build/icon.png",
           "extendInfo": { "NSAppleEventsUsageDescription": "…", "NSScreenCaptureUsageDescription": "需要屏幕录制权限以识别浏览器中的题目" } },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
}
```
- `dependencies` 必须为空；打包不得包含 `test/`、`docs/`、`fixtures/`、`dist/`。
- 图标：`build/icon.png` (1024), `build/icon.ico` (16–256), `build/tray.png` (32), `build/trayTemplate.png` (32, 黑白模板) 由 lead 提供，勿改文件名。

## 9. 冒烟 — `scripts/desktop-smoke.mjs`

无第三方依赖，`node scripts/desktop-smoke.mjs`：
1. 用 `electron` 可执行文件启动 `--smoke`，环境 `AQS_SETTINGS=<临时>/settings.json`、`AI_DEMO=1`、`AQS_SMOKE_SHOT=<临时>/overlay.png`。
2. 解析 stdout 的 `SMOKE_READY`，断言：窗口 `x` 接近显示器左边缘（±24）、`width>=320`、`mode==='demo'`、`bounds.height > 400`。
3. 断言截图文件存在且 > 5KB。
4. 超时/ENOENT/崩溃 → 打印诊断与 `SMOKE FAIL`，退出码 1；成功打印 `DESKTOP SMOKE OK`。
5. `test/packaging.test.js`（`node --test` 内）：断言 `package.json.main`、`dependencies` 为空、files 白名单不含 test/fixtures、图标文件存在、electron 版本可解析（`node_modules/electron/package.json`），不实际打包。

## 10. 验证口径

- `npm test` 全绿（新增 engine + packaging 用例，旧 37 项不得回归）。
- `npm run desktop:smoke` → `DESKTOP SMOKE OK`。
- 手工/自动：选择 Edge/Chrome 窗口 → 页面题目变化 → 自动识别 → 流式答案（demo 模式即可）；macOS 未实测需在 README 标注"依赖屏幕录制授权，未在 mac 机器验证"。
- 安全：密钥不出主进程、CSP 生效、IPC 入参校验、渲染进程无 Node、`setContentProtection` 开启、窗口截图不含悬浮窗自身。
