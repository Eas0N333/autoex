# CONTRACT — AI Quiz Solver

Zero-dependency **Node 24 ESM** backend + **zero-build** static web UI.
No npm packages, no bundler, no TypeScript. Node built-ins only (`node:http`, `fetch`).
Everything runs offline in **demo mode** (no API key) and against any **OpenAI-compatible** endpoint in live mode.

```
ex/
  package.json            [owner: lead]
  server/config.js        [owner: lead]  loadConfig()
  server/provider.js      [owner: backend] createProvider() — live + demo
  server/mock.js          [owner: backend] demo provider (deterministic)
  server/cache.js         [owner: backend] LRU+TTL cache for answers
  server/index.js         [owner: backend] HTTP server, routes, SSE, static, limits
  server/recognize.js     [owner: ai]    image → question via vision model
  server/answer.js        [owner: ai]    question → streamed answer via chat model
  web/index.html|app.js|styles.css [owner: frontend]
  test/*.test.js          [owner: qa]
  scripts/smoke.mjs       [owner: qa]
  fixtures/sample-question.png [owner: lead]
```

Anyone may READ any file. Nobody writes outside their ownership. Do not add npm dependencies. Do not add build steps.

## 1. Config object (already implemented)

`loadConfig(env?, root?)` → `{ root, host, port, demo, ai:{baseUrl, apiKey, model, visionModel, timeoutMs, maxRetries, headers}, limits:{maxBodyBytes, maxImageBytes, maxQuestionChars, maxOptions, ratePerMinute, answerCacheTtlMs, maxCacheEntries} }`.
`demo === true` when no key configured. In demo, `ai.apiKey === ''`.

## 2. Provider interface — `server/provider.js`

```js
export function createProvider(config) -> Provider

Provider = {
  kind: 'live' | 'demo',
  model: string,            // chat model name used in responses
  visionModel: string,      // vision model name (demo: 'demo-vision')
  chat({ messages, temperature?, maxTokens?, signal? }) -> Promise<{ text, usage }>
  async *streamChat({ messages, temperature?, maxTokens?, signal? }) -> AsyncGenerator<Delta>
}

Delta = { type: 'delta', text: string } | { type: 'usage', usage: object }
```

- `messages` is OpenAI chat format: `[{ role:'system'|'user'|'assistant', content: string | Array<{type:'text',text} | {type:'image_url',image_url:{url}}> }]`.
- Live: `POST ${baseUrl}/chat/completions`, `Authorization: Bearer <key>`, plus `config.ai.headers`; `stream:true` for `streamChat`, parse SSE `data:` lines, `[DONE]` terminates, usage from final chunk when present. Non-2xx → throw `ProviderError` with `status` and body snippet. Timeout via `AbortSignal.timeout(config.ai.timeoutMs)` merged with caller `signal`; retry once on 429/5xx/network (respect caller abort, no retry after first byte emitted).
- Demo: no network. Deterministic output driven by markers in the system message (see §3). `streamChat` yields `{type:'delta', text}` in ~8-char slices, 12 ms apart, honouring `signal`; never throws.
- Never log the API key. Never return it to callers.

`ProviderError` must be exported: `{ name:'ProviderError', code:'UPSTREAM'|'TIMEOUT'|'ABORTED', status?, message }`.

**Demo markers (must match exactly, produced by ai modules):**
- Recognize system prompt starts with `[TASK:RECOGNIZE]`.
- Answer system prompt starts with `[TASK:ANSWER]`.

Demo recognize replies with exactly this JSON content:
```json
{"question":"已知函数 f(x)=x^2-4x+3，求 f(x) 的最小值。","options":[{"label":"A","text":"-1"},{"label":"B","text":"0"},{"label":"C","text":"1"},{"label":"D","text":"3"}],"subject":"数学","questionType":"choice","confidence":0.98}
```
Demo answer text (streamed):
```
【答案】A（-1）

【解析】f(x)=x²-4x+3=(x-2)²-1，故顶点为 (2, -1)，最小值 -1。
- 配方后平方项 ≥ 0，取等时 x=2。
- 对照选项，只有 A 与 -1 相符。

（演示模式：未配置 API Key，以上为内置示例回答。）
```

## 3. AI pipeline — `server/recognize.js`, `server/answer.js`

`recognize.js`:
```js
export const RECOGNIZE_SYSTEM_PROMPT        // begins with '[TASK:RECOGNIZE]'
export function isSupportedImageDataUrl(s)  // ^data:image\/(png|jpe?g|webp|gif);base64,<valid b64>
export function buildRecognizeMessages({ imageDataUrl }) -> messages   // user content: [text, image_url]
export function parseRecognizeOutput(rawText) -> { question, options:[{label,text}], subject, questionType:'choice'|'blank'|'short'|'unknown', confidence:number }
export async function recognizeQuestion({ imageDataUrl }, { provider, signal }) -> same shape + { model, raw? }
```
- Parsing must survive: ```json fences, leading prose, trailing prose, stray whitespace, uppercase labels, string options (`"A. xxx"`), missing options (→ `[]`), missing subject (→ `'未知'`), missing confidence (→ `0.5`). Throw `RecognizeError` (`code:'PARSE'|'EMPTY'`) only when no usable `question` string exists.
- Prompt: transcribe **verbatim** (never solve, never translate), keep LaTeX as `$...$`, split options into label+text, detect subject and type, output **JSON only**.
- Vision disabled (demo): `recognizeQuestion` must call `provider.chat` with the same messages; the demo provider ignores the image.

`answer.js`:
```js
export const ANSWER_SYSTEM_PROMPT           // begins with '[TASK:ANSWER]'
export function buildAnswerMessages({ question, options, subject, style }) -> messages
export async function* answerStream(input, { provider, signal })  // yields {type:'delta',text}|{type:'usage',usage}
```
- `style` ∈ `'concise' | 'detailed' | 'step'` (default `'concise'`), injected as a length/detail instruction.
- Output format contract (the model is instructed to follow it): first line `【答案】…`, then `【解析】…`; for choice questions state the chosen label; for `step` add numbered derivation; end with a one-line `【易错点】` only for `detailed`/`step`.
- Truncate question to `limits.maxQuestionChars`, at most `limits.maxOptions` options, before building messages.

## 4. HTTP API — `server/index.js`

Bind `config.host:config.port`, print one line `[ai-quiz] listening on http://host:port (mode=demo|live, model=…)` after `listen`. Export `createServer(config)` and `start()`; only auto-start when executed directly (`import.meta.url === pathToFileURL(process.argv[1]).href`), so tests can boot ephemeral instances.

Common:
- Request body: JSON, `Content-Type: application/json`, size-capped by `limits.maxBodyBytes` → 413 `PAYLOAD_TOO_LARGE`.
- Errors: `{"error":{"code":"BAD_REQUEST|PAYLOAD_TOO_LARGE|RATE_LIMITED|UNSUPPORTED|UPSTREAM_ERROR|TIMEOUT|INTERNAL","message":"..."}}` with 400/413/429/415/502/504/500. Never leak stack traces or the key.
- Per-IP token bucket on `/api/*` at `limits.ratePerMinute` → 429 + `Retry-After`.
- CORS not needed (same origin). `X-Content-Type-Options: nosniff` on everything.
- Static: serve `web/`, `/` → `index.html`, unknown non-API path → `index.html` (SPA), path traversal rejected, correct content types, `Cache-Control: no-store` for html.

Routes:
1. `GET /api/health` → `{ ok:true, mode, models:{ chat, visionModel }, limits:{ maxImageBytes, maxQuestionChars }, version }` (version from package.json).
2. `GET /api/config` → `{ mode, models:{ chat, visionModel }, limits:{ maxImageBytes, maxQuestionChars, maxOptions }, styles:['concise','detailed','step'] }`.
3. `POST /api/recognize` `{ imageDataUrl }` → `200 { question, options, subject, questionType, confidence, model, mode }`.
   - 400 `BAD_REQUEST` invalid/missing image, 413 too large (decoded base64 bytes > `maxImageBytes`), 415 unsupported mime, 504 `TIMEOUT`, 502 `UPSTREAM_ERROR`.
   - Abort upstream when client disconnects.
4. `POST /api/answer` `{ question, options?, subject?, style?, imageDataUrl? }` → `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`.
   - If `imageDataUrl` given and `question` empty → run recognition first.
   - Events (each `event: <name>\ndata: <json>\n\n`):
     - `meta` `{ mode, model, cached:boolean, question, options, subject, style }`
     - `delta` `{ text }`
     - `done` `{ durationMs, usage: object|null }`
     - `error` `{ code, message }` (terminal; then close)
   - Heartbeat comment `: ping\n\n` every 15 s while waiting on upstream.
   - Cache: key = sha256(question|options|style); hit → replay full text as one `delta`, `meta.cached=true`, `done`. Skip cache for `imageDataUrl`-only requests. Store only successful full answers.
   - Client abort → abort upstream, no write-after-end errors.
   - Also accept `Accept: application/json` → non-streaming `{ answer, mode, model, cached, durationMs }` (same logic, aggregated).

## 5. Web UI — `web/*`

`index.html` must load `styles.css` + `app.js` (`type="module"`), be usable with JS on, no framework, no CDN requirement (optional KaTeX CDN allowed only as progressive enhancement; raw TeX must remain readable).

Required UI:
- Header: product name, mode badge (`演示模式` amber / `在线模式` green) from `GET /api/config`.
- Capture zone: drag&drop image, click-to-pick, `Ctrl/Cmd+V` paste from clipboard, and **屏幕截图** button using `getDisplayMedia` + `<video>` + canvas frame grab; after capture show preview + `重新识别`.
- `识别题目` → `POST /api/recognize` → editable form: question textarea, subject input, option rows (label + text, add/remove, max from config), type select.
- `提交 AI 解答` (also `Ctrl+Enter`) → `POST /api/answer`, consume SSE via `fetch` + `ReadableStream` parser (POST, so `EventSource` is unusable), stream markdown into result panel with a blinking cursor; `停止` button aborts; errors shown inline, never `alert`.
- Answer panel: markdown (headings, bold, code, lists, `$…$`/`\(…\)` math via KaTeX if present, else literal), `复制` button, style selector (`简洁/详细/逐步讲解`).
- History: last 20 entries in `localStorage` (`aqs.history.v1`) — question snippet, timestamp, subject, answer; click restores; `清空历史`; survives reload.
- States: disabled/spinner on buttons while busy, aria-live on answer region, responsive down to 360 px, visible focus rings, no layout shift when streaming.
- Demo mode: `meta.cached`/`demo` surfaced as "来自缓存" / "演示模式" chip.
- `web/app.js` must be robust: every `fetch` wrapped, JSON parse guarded, SSE parser handles chunk boundaries, multiple `data:` lines, `event:` renames, and unknown events.

## 6. Tests — `test/*.test.js` + `scripts/smoke.mjs` (qa)

`node --test test/` must pass with **no network** and **no API key**. Cover:
- `loadConfig` precedence + demo detection (no key, `AI_DEMO=1`, `config.json`).
- `parseRecognizeOutput`: fenced JSON, prose-wrapped JSON, string options, missing fields, invalid → throws.
- Provider (live) against a local stub OpenAI-compatible server (`http.createServer`) — assert request path/auth/stream parsing/retry-on-500/`[DONE]`; assert demo provider determinism and abort.
- HTTP integration on ephemeral port with `AI_BASE_URL` → stub: `/api/health`, `/api/config`, `/api/recognize` (400/413/415), `/api/answer` SSE event sequence (`meta`→`delta`*→`done`), JSON-mode answer, 429 after burst, static `/` serves html.
- `scripts/smoke.mjs`: boot real server on ephemeral port (demo), hammer health/recognize/answer/static, print `SMOKE OK` and exit non-zero on failure. Use `fixtures/sample-question.png` (read it via base64).

## 7. Ground rules

- Node ESM only; `node:` prefixed imports; no `require`, no CommonJS.
- No dependency, no bundler, no generated build output.
- Every public export above must exist with the exact name/shape — tests and siblings depend on it.
- No secrets in client payloads, logs, or repo files.
- Handle abort, EOF, and malformed upstream payloads without crashing the process.
- Keep code boring and commented only where non-obvious.
