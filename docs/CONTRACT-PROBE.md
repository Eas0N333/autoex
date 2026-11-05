# CONTRACT — 连接自检（Probe）

目标：用户在设置里填入 API Key / 切换模型后，自动验证“能不能连上、这个模型能不能用”，并在界面上直接显示成功/失败原因，而不是等到答题时才报错。

## 1. 主进程模块 — `electron/probe.js`（新，纯 Node，不依赖 electron）

```js
export const PROBE_TIMEOUT_MS = 15000;

export function resolveProbeTargets(settings-like, patch?) -> [Target]
// settings-like: { ai:{baseUrl,apiKey,model,visionModel,vision:{baseUrl,apiKey,model},ensemble:{candidates,judge}} }
// patch: 同 updateSettings 的局部 patch（可含 ai/baseUrl/apiKey/model/vision/ensemble）
// Target = { role:'text'|'vision'|'candidate'|'judge', label, baseUrl, apiKey, model, key:uniqueId }

export async function testConnection(settingsLike, patch, { signal } = {}) -> Result

Result = {
  ok: boolean,                 // 所有目标成功
  reason?: 'NO_KEY'|'DEMO',    // 没有任何可用 Key → 不发请求
  checkedAt: number,
  summary: { total, ok, failed, latencyMs },   // latencyMs = 最慢目标
  results: [{
    role, label, model, host,   // host 只出 hostname，不出完整 URL/Key
    ok, latencyMs,
    status?: number,            // 上游 HTTP 状态
    code?: 'AUTH'|'PLAN'|'MODEL_NOT_FOUND'|'RATE_LIMITED'|'TIMEOUT'|'NETWORK'|'UPSTREAM'|'NO_KEY',
    message?: string            // 中文、≤160 字，绝不包含 Key
  }]
}
```

- 目标去重：同 `baseUrl|model|apiKey` 只测一次；上限 8 个；候选/评审只有在 `model` 非空时才加入；文本、OCR、候选、评审各一条。
- 探测请求：`provider.chat({ messages:[{role:'user',content:'ping'}], maxTokens:8, temperature:0, signal })`，`createProvider({ai:{baseUrl,apiKey,model,timeoutMs:PROBE_TIMEOUT_MS,maxRetries:0}})`。
- 并发 2；单个超时 15s；`signal` 中止后整体抛 `AbortError`（上层忽略）。
  - 实现补充（用于测试）：`testConnection(settings, patch, { signal, timeoutMs })` 可覆盖单目标超时，非法值回退 `PROBE_TIMEOUT_MS`；不传时行为不变。
- 错误映射：401→`AUTH`「密钥无效或已过期」；403 且响应含 `upgrade_required`/`model_region_unavailable`/`permission`→`PLAN`「该模型不在当前订阅计划内」；404→`MODEL_NOT_FOUND`「模型不存在或端点不匹配」；429→`RATE_LIMITED`「请求过于频繁，稍后再试」；超时→`TIMEOUT`；网络→`NETWORK`；其它→`UPSTREAM`。
- 不读取 `settings.js`（避免测试时依赖 electron）；由调用方传入已解析的 settings/patch 对象。
- 不写文件、不打日志、不缓存、绝不返回 Key。

## 2. IPC — `electron/main.js` / `electron/preload.cjs`

- 通道 `aqs:test-connection`，入参 `patch`（对象或省略），主进程：
  - 用 `validatePatch(patch)` 清洗（允许未保存的 Key，但**绝不落盘**）；
  - 合并当前设置后调用 `testConnection`（可带 `AbortController`，新请求中止旧请求）；
  - 返回 `Result`；参数非法 → reject `{name:'AqsError',code:'BAD_REQUEST',message}`。
- preload 暴露 `window.aqs.testConnection(patch) -> Promise<Result>`（加入现有桥，保持 sandbox）。
- State 不需要变化；不得广播 Key。

## 3. 界面 — `electron/ui/*`

- 「模型服务 → API Key」下方新增一行：
  - 按钮 `#btn-test-connection`（`data-testid="test-connection"`，文案 `测试连接`）
  - 状态 `#conn-status`（`aria-live="polite"`，`data-state="idle|testing|ok|partial|error|demo"`）
  - 结果列表 `#conn-results`（`[data-testid="conn-results"]`，默认隐藏），每行 `[data-testid="conn-result"]` 显示：角色（文本/视觉/候选 A/评审）、模型、耗时、状态（✓/✗ + 中文原因）。
- 自动触发（**核心需求**）：
  - API Key 输入停止 1000ms 且长度 ≥ 8 → 自动测试（使用未保存的 Key，不保存）。
  - 文本/视觉/候选/评审模型下拉变化、Base URL 变化（debounce 800ms）→ 自动测试。
  - 保存设置成功后立即测试一次。
  - 预设切换后清空旧状态，若已有 Key 则自动测试。
  - 新请求发出时取消上一次（AbortController 或忽略过期响应）。
- 状态文案：
  - testing：`正在验证连接…`（转圈）
  - ok：`已连接 · {ok}/{total} 个模型可用 · {latency}ms`（绿色）
  - partial：`部分模型不可用（{failed}/{total}）`（琥珀色）
  - error：`连接失败：{中文原因}`（红色）
  - demo / 无 Key：`未填写 API Key，当前为演示模式`（灰色，不发请求）
- 失败行展示 `AUTH（401）`、`PLAN`、`MODEL_NOT_FOUND` 等 + 中文说明；403 计划错误明确写「该模型不在当前订阅计划内」。
- 绝不在 DOM、toast、日志中出现明文 Key；Key 输入框始终只显示 masking。
- 测试中禁用按钮并显示 spinner；结果列表可折叠；Esc/关闭设置不清除结果但停止计时。

## 4. 验证

- `test/probe.test.js`（QA）：本地 OpenAI 兼容 stub — 全部成功、401 AUTH、403 PLAN、404 MODEL_NOT_FOUND、429、超时、网络不可达、目标去重（文本=候选同模型只测一次）、多目标并发、demo 无 Key 不发请求、结果不含 Key/完整 baseUrl（只有 host）。
- 真机/无头：填入假 Key → 状态变红并显示 `AUTH（401）`；填入可用 Key（stub）→ 绿色 `已连接`；修改候选模型 → 自动重测；保存后自动重测；结果列表角色齐全。
- `npm test`、`npm run desktop:smoke`、`npm run smoke` 全绿。
