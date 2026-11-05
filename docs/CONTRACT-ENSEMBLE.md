# CONTRACT — 多模型交叉验证（Ensemble）+ 订阅 API

目标：一次解答同时调用最多 3 个模型独立作答，再由第 4 个（评审）模型比对三份答案、验证过程并输出最终答案；支持 DeepSeek 官方 API 与 Command Code 订阅 API（OpenAI Chat Completions 兼容）。

已确认的外部事实（写死在预设里，勿改）：
- Command Code Provider API：`https://api.commandcode.ai/provider/v1`，`POST /chat/completions`，`Authorization: Bearer <CMD_API_KEY>`；模型目录 `GET /provider/v1/models`（公开，含 `supported_endpoints`）。**Claude 模型只支持 `/messages`**，本应用统一走 chat completions，候选/评审只能用 OpenAI/开源模型（`deepseek/*`、`google/gemini-*`、`gpt-*` 等）。
- DeepSeek 官方：`https://api.deepseek.com`，模型 `deepseek-flash`（V4.1 Flash，**支持视觉**，`image_url` + base64 data URL，仅限 user 消息）与 `deepseek-v4-pro`（无视觉）；旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍被接受但已路由到 Flash。
- 两者都是标准 OpenAI 兼容，流式 `data:` SSE，usage 在末尾 chunk。

## 1. 配置模型

`ai` 新增两块（`config.json` / `electron/settings.js` / `server/config.js` 同步）：

```js
ai: {
  baseUrl, apiKey, model, visionModel, timeoutMs, maxRetries, headers,

  // 可选：OCR 专用端点，字段为空则继承上面的 ai.*
  vision: { baseUrl: '', apiKey: '', model: '' },

  ensemble: {
    enabled: false,
    candidates: [                      // 固定 3 槽（允许 2–5，UI 展示 3）
      { name: '模型 A', baseUrl: '', apiKey: '', model: '', temperature: 0.3 },
      { name: '模型 B', baseUrl: '', apiKey: '', model: '', temperature: 0.6 },
      { name: '模型 C', baseUrl: '', apiKey: '', model: '', temperature: 0.9 }
    ],
    judge: { name: '评审', baseUrl: '', apiKey: '', model: '', temperature: 0.1 }
  }
}
```

- 候选/评审的 `baseUrl`、`apiKey` 为空 → 继承 `ai.baseUrl` / `ai.apiKey`；`model` 为空 → 该候选视为**未配置**（评审的 model 为空则继承 `ai.model`）。
- 只有 `model` 非空且 `baseUrl` 解析成功（继承后）的候选才参与；参与数 `< 2` 时若请求交叉验证 → `EngineError('BAD_REQUEST', '交叉验证需要至少 2 个候选模型')`。
- `temperature` 0–2，缺省 0.3/0.6/0.9（候选）与 0.1（评审）。
- `demo` 判定：全局 key、任一候选 key、vision key 全空 → demo。
- 密钥掩码：渲染层只能拿到 `hasApiKey`（含继承），永不回传明文；空字符串 patch 表示保持原值。
- 环境变量（网页版）：`AI_VISION_BASE_URL` / `AI_VISION_API_KEY` / `AI_VISION_MODEL`、`AI_ENSEMBLE=1`；`config.json` 支持完整嵌套。

## 2. 引擎事件 — `server/engine.js`

`answerStream(input, { signal, ensemble })`，`ensemble` 缺省取 `config.ai.ensemble.enabled`。

```js
{type:'meta', cached, mode, model, question, options, subject, style,
 ensemble:boolean,
 candidates:[{index,name,model}],          // 仅当次调用实际参与者
 judge:{name,model}|null}

{type:'candidate', index, name, model,
 status:'running'|'done'|'error', text?, error?, durationMs?, usage?}

{type:'delta', text}                       // 评审最终答案的流式增量（单模型模式即原行为）
{type:'usage', usage}
{type:'done', text, cached, durationMs, usage, ensemble,
 candidates:[{index,name,model,status,text?,error?,durationMs?}],
 judge:{name,model,status:'done'|'error', error?}|null,
 fallback?:boolean}
```

- 候选答案用**非流式** `provider.chat` 并行发出（`temperature` 按槽位），每个候选独立 `AbortController` + 总超时 `ai.timeoutMs`；任一失败只影响该候选。
- 三个候选都失败 → `EngineError('UPSTREAM_ERROR', …)`；仅部分成功 → 用存活者继续评审。
- 评审用 `provider.streamChat` 流式输出，提示词标记 `[TASK:JUDGE]`；产物格式与普通答案一致（`【答案】`/`【解析】`），额外一行 `【一致性】`。
- 评审失败 → 回退：取第一个成功候选的原文作为最终答案，`judge.status='error'`、`fallback=true`，`done` 正常结束，不抛错。
- 缓存键包含：模式、每个参与者的 `baseUrl|model|temperature`、评审 `model`、题干/选项/风格；命中时重放 `candidate`（status done）→ 一次 `delta` 全文 → `done{cached:true}`。
- 中止：所有候选与评审同时 abort，抛 `EngineError('ABORTED')`，不写缓存。
- 兼容：若上游以 HTTP 400 拒绝 `temperature`（如 `deepseek-reasoner`），provider 自动去掉该参数重试一次。
- 视觉识别仍用 `ai.vision` 端点（若配置），不参与交叉验证。

## 3. Prompt — `server/ensemble.js`（新）

```js
export const CANDIDATE_SYSTEM_PROMPT  // 以 '[TASK:ANSWER]' 开头：独立作答，不得假设他人
export const JUDGE_SYSTEM_PROMPT      // 以 '[TASK:JUDGE]' 开头
export function buildCandidateMessages({question, options, subject, style}) -> messages
export function buildJudgeMessages({question, options, subject, style, answers:[{name,model,text}]}) -> messages
export async function* ensembleAnswer(input, {candidates, judge, signal, limits})
```

- 评审提示词要求：逐份核对（不投票、不看模型名气）、指出错误步骤、给出最终答案；选择题必须给出选项字母；答案冲突时说明取舍理由；最后一行 `【一致性】一致 | 存在分歧（说明）`。
- 候选答案按 `模型 A/B/C` 编号 + 模型名提供给评审，题干与选项原样。
- 注入风格指令与长度上限（`maxQuestionChars` / `maxOptions`）。

## 4. HTTP — `server/index.js` / 网页 UI

- `POST /api/answer` 新增 body `ensemble?:boolean`；SSE 新增 `event: candidate`（payload 同上），`done` 事件带 `candidates`/`judge`/`fallback`。
- `Accept: application/json` 返回 `{answer, candidates:[…], judge, fallback, ensemble, cached, durationMs}`。
- `GET /api/config` 增加 `ensemble: { enabled, candidates:[{name,model,hasKey}], judge:{name,model,hasKey} }`（无明文 key）。
- 网页 UI：回答风格旁加 `交叉验证` 开关（`/api/config` 显示不可用时禁用并提示原因）；候选卡片显示 3 个模型的名称/状态/答案摘要（可展开），最终答案在下方流式输出；`done.fallback` 显示警告。SSE 解析器需处理 `candidate` 事件。

## 5. 桌面 — settings / main / IPC

- `electron/settings.js`：默认值、清洗、校验、`getState()` 掩码如上；快捷预设仅作为 UI 常量导出：
  ```js
  export const AI_PRESETS = {
    commandcode: { label:'Command Code 订阅', baseUrl:'https://api.commandcode.ai/provider/v1', model:'deepseek/deepseek-v4.1-flash', visionModel:'deepseek/deepseek-v4.1-flash',
                   candidates:['deepseek/deepseek-v4.1-flash','deepseek/deepseek-v4-pro','google/gemini-3.8-flash'], judge:'deepseek/deepseek-v4-pro' },
    deepseek:    { label:'DeepSeek 官方',    baseUrl:'https://api.deepseek.com',               model:'deepseek-flash',              visionModel:'deepseek-flash',
                   candidates:['deepseek-flash','deepseek-v4-pro','deepseek-flash'], judge:'deepseek-v4-pro' },
    openai:      { label:'OpenAI',            baseUrl:'https://api.openai.com/v1',              model:'gpt-4o-mini',                visionModel:'gpt-4o-mini', candidates:[], judge:'' }
  }
  ```
- `electron/main.js`：`buildEngineConfig()` 把 `settings.ai.vision` / `settings.ai.ensemble` 合并进 engine 配置，逐槽解析继承后的 baseUrl/key/model；`aqs:answer` 传 `ensemble`（取设置值，或 IPC 参数覆盖）；把 engine 的 `candidate` 事件转成 `answer:candidate` 广播；`answer:done` 带上 `candidates/judge/fallback/ensemble`；历史记录附带 `models` 摘要（候选名）与 `fallback`。
- Preload 通道不变，事件直接透传；State 增加 `engine.ensemble: {enabled, candidates:[{name,model}], judge:{name,model}}`。

## 6. 桌面 UI — `electron/ui/*`

- 自动条新增 `#ensemble-toggle`（`data-testid="ensemble-toggle"`）：文案「交叉验证」，不可用时禁用并 title 说明「需在设置中配置 ≥2 个候选模型」。
- 答案卡：交叉验证时在最终答案上方渲染 `[data-testid="candidates"]`，每行 `[data-testid="candidate-<index>"]`：状态点（running/done/error）、名称、模型、耗时；点击展开该候选完整答案（Markdown）；全部完成后显示「3/3 已完成」；失败候选显示错误码。评审流式期间显示「评审中…」。
- 设置抽屉新增两组：
  - **视觉识别**：可选独立端点（Base URL / Key / 模型），留空继承全局，提示「视觉模型须支持图片输入（DeepSeek 官方用 deepseek-flash）」。
  - **交叉验证**：总开关、3 个候选槽（名称/Base URL/Key/模型/温度）、评审槽；每槽 key 只显示「已保存/继承/未配置」；预设按钮 `Command Code 订阅` / `DeepSeek 官方` / `OpenAI` 一键填 baseUrl 与建议模型（仅填空字段）；`清空候选`。
- 保存后 `updateSettings` 触发主进程重建 engine；UI 依据返回 State 刷新可用性。
- 键盘/无障碍/深浅色沿用现有；新增元素全部 `data-testid`。

## 7. 验证口径（QA）

- `npm test` 全绿（现有 57 项不回归）+ 新增：
  - `test/ensemble.test.js`：3 provider stub 并行、候选事件 running→done、评审请求包含三份答案与 `[TASK:JUDGE]`、评审流式 delta、部分失败、全部失败、评审失败回退、abort 全链路、缓存重放（含候选）、候选数 <2 报 BAD_REQUEST、温度/模型签名进缓存键。
  - `test/settings.test.js`（或现有）：新字段清洗/范围/掩码/继承/demo 判定/坏 patch 拒绝。
  - `test/server.test.js`：`ensemble:true` 的 SSE `candidate` 事件与 JSON 聚合；`/api/config.ensemble` 不含密钥。
- `npm run desktop:smoke` + `npm run smoke` 仍通过。
- 真实链路：用本机 stub 起 3 个不同回答的端点（不同 model 名区分），验证评审收到三份并输出最终答案；桌面端选中浏览器窗口后自动走交叉验证。

## 8. 图标/打包不变

`package.json` 的 `files`、图标、安装包目标不改；新增源文件在 `server/`、`electron/` 白名单内自动打入。
