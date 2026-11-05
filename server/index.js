/**
 * HTTP server for the AI quiz solver.
 *
 * Routes: GET /api/health, GET /api/config, POST /api/recognize, POST /api/answer
 * plus the static SPA in web/. Everything that is not transport — validation,
 * normalization, recognition, answer streaming and caching — lives in
 * `server/engine.js`. This module only handles routing, body limits, the rate
 * limit, SSE encoding, status-code mapping, static serving, heartbeats and
 * client-disconnect aborts. It never auto-starts on import; `start()` is called
 * only when this module is executed directly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { EngineError, STYLES, createEngine } from './engine.js';
import {
  HttpError,
  createRateLimiter,
  createStaticHandler,
  readJsonBody,
  sendError,
  sendJson,
  setBaseHeaders,
} from './http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const HEARTBEAT_MS = 15_000;

const MAX_ENSEMBLE_SLOTS = 5;
const DEFAULT_ENSEMBLE_NAMES = ['模型 A', '模型 B', '模型 C', '模型 D', '模型 E'];
const DEFAULT_JUDGE_NAME = '评审';

const STATUS_BY_ENGINE_CODE = {
  BAD_REQUEST: 400,
  UNSUPPORTED: 415,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
  ABORTED: 502,
};

let versionCache = null;

function appVersion() {
  if (versionCache !== null) return versionCache;
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    versionCache = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    versionCache = '0.0.0';
  }
  return versionCache;
}

function clientIp(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * The static bundle always lives next to this module. A configured root may be
 * a throwaway config directory (tests), so only use it when it has a web/ tree.
 */
function resolveWebRoot(root) {
  if (typeof root === 'string' && root !== '') {
    const candidate = path.join(root, 'web');
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return path.join(PROJECT_ROOT, 'web');
}

function requestUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

function wantsJson(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('application/json') && !accept.includes('text/event-stream');
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Key-free description of the ensemble settings for `GET /api/config`.
 * Inheritance (`baseUrl`/`apiKey` fall back to `ai.*`) is resolved here so the
 * UI only ever sees `hasKey`, never key material.
 */
function describeEnsemble(config, mode) {
  const ai = config && typeof config.ai === 'object' && config.ai ? config.ai : {};
  const source = ai.ensemble && typeof ai.ensemble === 'object' ? ai.ensemble : {};
  const sharedKey = textOrEmpty(ai.apiKey);
  const sharedBaseUrl = textOrEmpty(ai.baseUrl);

  const slots = Array.isArray(source.candidates) ? source.candidates.slice(0, MAX_ENSEMBLE_SLOTS) : [];
  const resolved = slots.map((slot, index) => {
    const raw = slot && typeof slot === 'object' ? slot : {};
    const model = textOrEmpty(raw.model);
    const baseUrl = textOrEmpty(raw.baseUrl) || sharedBaseUrl;
    const hasKey = (textOrEmpty(raw.apiKey) || sharedKey) !== '';
    return {
      name: textOrEmpty(raw.name) || DEFAULT_ENSEMBLE_NAMES[index] || `模型 ${index + 1}`,
      model,
      hasKey,
      usable: model !== '' && /^https?:\/\//i.test(baseUrl),
    };
  });

  const judgeRaw = source.judge && typeof source.judge === 'object' ? source.judge : {};
  const judge = {
    name: textOrEmpty(judgeRaw.name) || DEFAULT_JUDGE_NAME,
    model: textOrEmpty(judgeRaw.model) || textOrEmpty(ai.model),
    hasKey: (textOrEmpty(judgeRaw.apiKey) || sharedKey) !== '',
  };

  // Demo mode answers from the built-in provider, so the cross-check stays usable
  // without keys (the engine substitutes demo participants); live mode needs the
  // same two-or-more configured models the engine insists on.
  const usable = resolved.filter((candidate) => candidate.usable).length;
  let reason = '';
  if (mode !== 'demo' && usable < 2) {
    reason = `交叉验证需要至少 2 个已配置的候选模型（当前 ${usable} 个）。`;
  }

  return {
    enabled: source.enabled === true,
    available: mode === 'demo' || usable >= 2,
    reason,
    candidates: resolved.map(({ name, model, hasKey }) => ({ name, model, hasKey })),
    judge: { name: judge.name, model: judge.model, hasKey: judge.hasKey },
  };
}

/** Only `true`-ish values opt in; anything else keeps the configured default out of the way. */
function parseEnsembleFlag(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return undefined;
}

/** Candidate payload shared by the SSE `candidate` event and JSON aggregation. */
function normalizeCandidate(raw, defaultStatus) {
  if (!raw || typeof raw !== 'object') return null;
  const index = Number(raw.index);
  if (!Number.isFinite(index)) return null;
  const candidate = {
    index,
    name: typeof raw.name === 'string' ? raw.name : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    status: ['running', 'done', 'error'].includes(raw.status) ? raw.status : defaultStatus,
  };
  if (typeof raw.text === 'string') candidate.text = raw.text;
  if (typeof raw.error === 'string') candidate.error = raw.error;
  if (Number.isFinite(raw.durationMs)) candidate.durationMs = raw.durationMs;
  if (raw.usage && typeof raw.usage === 'object') candidate.usage = raw.usage;
  return candidate;
}

/** Meta candidates only carry identity; they are still running at that point. */
function projectCandidates(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item, position) => {
      const index = Number(item.index);
      return {
        index: Number.isFinite(index) ? index : position,
        name: typeof item.name === 'string' ? item.name : '',
        model: typeof item.model === 'string' ? item.model : '',
      };
    });
}

function collectCandidates(raw, defaultStatus) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => normalizeCandidate(item, defaultStatus)).filter(Boolean);
}

function normalizeJudge(raw, defaultStatus) {
  if (!raw || typeof raw !== 'object') return null;
  const judge = {
    name: typeof raw.name === 'string' ? raw.name : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    status: ['running', 'done', 'error'].includes(raw.status) ? raw.status : defaultStatus,
  };
  if (typeof raw.error === 'string') judge.error = raw.error;
  if (Number.isFinite(raw.durationMs)) judge.durationMs = raw.durationMs;
  return judge;
}

/** Merge candidate snapshots by index so partial events never duplicate cards. */
function mergeCandidateSnapshots(current, incoming) {
  const merged = new Map(current.map((item) => [item.index, item]));
  for (const item of incoming) merged.set(item.index, { ...merged.get(item.index), ...item });
  return [...merged.values()].sort((a, b) => a.index - b.index);
}

/**
 * Drains an engine answer stream into one JSON payload. Candidate progress is
 * folded in the same way the SSE path forwards it, so both transports agree.
 */
async function collectAnswer(engine, input, context) {
  const startedAt = Date.now();
  let text = '';
  let usage = null;
  let cached = false;
  let durationMs = 0;
  let ensemble = false;
  let candidates = [];
  let judge = null;
  let fallback = false;
  let settled = false;

  for await (const event of engine.answerStream(input, context)) {
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'meta') {
      cached = Boolean(event.cached);
      ensemble = event.ensemble === true;
      if (Array.isArray(event.candidates)) {
        candidates = mergeCandidateSnapshots(candidates, projectCandidates(event.candidates));
      }
      if (event.judge && typeof event.judge === 'object') judge = normalizeJudge(event.judge, 'running');
      continue;
    }

    if (event.type === 'candidate') {
      const candidate = normalizeCandidate(event, 'running');
      if (candidate) candidates = mergeCandidateSnapshots(candidates, [candidate]);
      continue;
    }

    if (event.type === 'usage') {
      if (event.usage) usage = event.usage;
      continue;
    }

    if (event.type === 'delta') {
      if (typeof event.text === 'string') text += event.text;
      continue;
    }

    if (event.type === 'done') {
      settled = true;
      if (typeof event.text === 'string') text = event.text;
      if (event.usage) usage = event.usage;
      cached = Boolean(event.cached);
      durationMs = Number.isFinite(event.durationMs) ? event.durationMs : durationMs;
      if (typeof event.ensemble === 'boolean') ensemble = event.ensemble;
      if (Array.isArray(event.candidates)) {
        candidates = mergeCandidateSnapshots(candidates, collectCandidates(event.candidates, 'done'));
      }
      if (event.judge && typeof event.judge === 'object') {
        judge = { ...judge, ...normalizeJudge(event.judge, 'done') };
      }
      fallback = event.fallback === true;
    }
  }

  if (judge && judge.status === 'running') judge = { ...judge, status: 'done' };
  if (!settled) durationMs = Date.now() - startedAt;

  return { text, usage, cached, durationMs, ensemble, candidates, judge, fallback };
}

function methodNotAllowed(res, allow) {
  sendJson(
    res,
    405,
    { error: { code: 'METHOD_NOT_ALLOWED', message: `不支持的请求方法，请使用 ${allow}` } },
    { Allow: allow },
  );
}

/** Map engine failures to HTTP status codes; messages stay user-facing. */
function toApiError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof EngineError) {
    const status = STATUS_BY_ENGINE_CODE[error.code] ?? 500;
    return new HttpError(status, error.code, error.message);
  }
  return new HttpError(500, 'INTERNAL', '服务器内部错误');
}

/** Payload of the terminal SSE `error` event, or null to close silently. */
function streamErrorPayload(error) {
  if (error instanceof EngineError) {
    if (error.code === 'ABORTED') return null;
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL', message: '生成回答时发生错误' };
}

export function createServer(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('createServer(config) requires the config object from loadConfig()');
  }

  const limits = config.limits ?? {};
  const engine = createEngine(config);
  const limiter = createRateLimiter({ ratePerMinute: limits.ratePerMinute });
  const staticHandler = createStaticHandler({ root: resolveWebRoot(config.root) });
  const version = appVersion();
  const ensembleInfo = describeEnsemble(config, engine.mode);

  const healthPayload = () => ({
    ok: true,
    mode: engine.mode,
    models: engine.models,
    ensemble: { enabled: ensembleInfo.enabled, available: ensembleInfo.available },
    limits: {
      maxImageBytes: engine.limits.maxImageBytes,
      maxQuestionChars: engine.limits.maxQuestionChars,
    },
    version,
  });

  const configPayload = () => ({
    mode: engine.mode,
    models: engine.models,
    limits: {
      maxImageBytes: engine.limits.maxImageBytes,
      maxQuestionChars: engine.limits.maxQuestionChars,
      maxOptions: engine.limits.maxOptions,
    },
    styles: [...STYLES],
    ensemble: ensembleInfo,
  });

  function createSse(res) {
    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    const isClosed = () => closed || res.writableEnded || res.destroyed;

    const write = (raw) => {
      if (isClosed()) return false;
      try {
        res.write(raw);
        return true;
      } catch {
        closed = true;
        return false;
      }
    };

    return {
      start() {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive',
        });
        res.flushHeaders?.();
      },
      get closed() {
        return isClosed();
      },
      event(name, data) {
        return write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      pulse() {
        write(': ping\n\n');
      },
      end() {
        if (res.writableEnded || res.destroyed) return;
        try {
          res.end();
        } catch {
          // Client already gone.
        }
      },
    };
  }

  /** Abort the engine work as soon as the client drops the connection. */
  function trackClientAbort(res) {
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) aborter.abort();
    });
    res.on('error', () => aborter.abort());
    return aborter;
  }

  async function handleRecognize(req, res) {
    const aborter = trackClientAbort(res);

    let body;
    try {
      body = await readJsonBody(req, limits.maxBodyBytes);
    } catch (error) {
      return sendError(res, error);
    }

    try {
      const result = await engine.recognize({ imageDataUrl: body.imageDataUrl, signal: aborter.signal });
      if (res.writableEnded || res.destroyed) return;
      sendJson(res, 200, {
        question: result.question,
        options: result.options,
        subject: result.subject,
        questionType: result.questionType,
        confidence: result.confidence,
        model: result.model,
        mode: engine.mode,
      });
    } catch (error) {
      if (aborter.signal.aborted || res.destroyed) return;
      console.error('[ai-quiz] recognize failed:', error?.message ?? error);
      sendError(res, toApiError(error));
    }
  }

  async function handleAnswer(req, res) {
    const aborter = trackClientAbort(res);

    let body;
    try {
      body = await readJsonBody(req, limits.maxBodyBytes);
    } catch (error) {
      return sendError(res, error);
    }

    const input = {
      question: body.question,
      options: body.options,
      subject: body.subject,
      style: body.style,
      imageDataUrl: body.imageDataUrl,
    };

    // `undefined` keeps the configured default; an explicit boolean overrides it.
    const answerContext = { signal: aborter.signal };
    const ensembleFlag = parseEnsembleFlag(body.ensemble);
    if (ensembleFlag !== undefined) answerContext.ensemble = ensembleFlag;

    if (wantsJson(req)) {
      try {
        const result = await collectAnswer(engine, input, answerContext);
        if (res.destroyed || res.writableEnded) return;
        return sendJson(res, 200, {
          answer: result.text,
          mode: engine.mode,
          model: engine.models.chat,
          cached: result.cached,
          durationMs: result.durationMs,
          ensemble: result.ensemble,
          candidates: result.candidates,
          judge: result.judge,
          fallback: result.fallback,
        });
      } catch (error) {
        if (aborter.signal.aborted || res.destroyed) return;
        console.error('[ai-quiz] answer failed:', error?.message ?? error);
        return sendError(res, toApiError(error));
      }
    }

    // Pull the first event before writing SSE headers: validation, recognition
    // and cache misses must still surface as regular HTTP error responses.
    const iterator = engine.answerStream(input, answerContext)[Symbol.asyncIterator]();
    let first;
    try {
      first = await iterator.next();
    } catch (error) {
      if (aborter.signal.aborted || res.destroyed) return;
      console.error('[ai-quiz] answer failed:', error?.message ?? error);
      return sendError(res, toApiError(error));
    }

    if (first.done) {
      return sendError(res, new HttpError(500, 'INTERNAL', '服务器内部错误'));
    }

    const sse = createSse(res);
    sse.start();
    const heartbeat = setInterval(() => sse.pulse(), HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      if (sse.closed) return;

      const meta = first.value;
      sse.event('meta', {
        mode: engine.mode,
        model: typeof meta.model === 'string' && meta.model !== '' ? meta.model : engine.models.chat,
        cached: Boolean(meta.cached),
        question: meta.question,
        options: meta.options,
        subject: meta.subject,
        style: meta.style,
        ensemble: meta.ensemble === true,
        candidates: projectCandidates(meta.candidates),
        judge: normalizeJudge(meta.judge, 'running'),
      });

      try {
        for await (const event of iterator) {
          if (!event || typeof event !== 'object') continue;
          if (event.type === 'delta' && typeof event.text === 'string' && event.text !== '') {
            if (!sse.event('delta', { text: event.text })) break;
          } else if (event.type === 'candidate') {
            const candidate = normalizeCandidate(event, 'running');
            if (candidate && !sse.event('candidate', candidate)) break;
          } else if (event.type === 'done') {
            const judge = normalizeJudge(event.judge, 'done');
            const done = {
              text: typeof event.text === 'string' ? event.text : '',
              cached: Boolean(event.cached),
              durationMs: event.durationMs,
              usage: event.usage ?? null,
              ensemble: event.ensemble === true,
              candidates: collectCandidates(event.candidates, 'done'),
              judge,
              fallback: event.fallback === true,
            };
            sse.event('done', done);
          }
        }
      } catch (error) {
        if (!aborter.signal.aborted && !sse.closed) {
          const payload = streamErrorPayload(error);
          if (payload) sse.event('error', payload);
        }
        return;
      }
    } finally {
      clearInterval(heartbeat);
      sse.end();
    }
  }

  async function handleApi(req, res, pathname) {
    const limit = limiter.take(clientIp(req));
    if (!limit.allowed) {
      return sendError(
        res,
        new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试', {
          retryAfterSec: Math.ceil(limit.retryAfterMs / 1000),
        }),
      );
    }

    switch (pathname) {
      case '/api/health':
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        return sendJson(res, 200, healthPayload());
      case '/api/config':
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        return sendJson(res, 200, configPayload());
      case '/api/recognize':
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        return handleRecognize(req, res);
      case '/api/answer':
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        return handleAnswer(req, res);
      default:
        return sendError(res, new HttpError(404, 'NOT_FOUND', '接口不存在'));
    }
  }

  async function handle(req, res) {
    setBaseHeaders(res);
    req.on('error', () => {
      // Client vanished while sending the request.
    });

    const url = requestUrl(req);
    if (!url) return sendError(res, new HttpError(400, 'BAD_REQUEST', '非法的请求地址'));

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(req, res, url.pathname);
    }

    const served = await staticHandler.serve(req, res, url.pathname);
    if (!served) methodNotAllowed(res, 'GET, HEAD');
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // Socket already closed.
        }
        return;
      }
      sendError(res, error instanceof HttpError ? error : new HttpError(500, 'INTERNAL', '服务器内部错误'));
    });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  // Exposed for the listening banner and for tests that want the live provider.
  server.provider = engine.provider;
  server.engine = engine;
  return server;
}

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Create and start the server; the banner is printed once the socket listens. */
export function start(config = loadConfig()) {
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const host = typeof address === 'object' && address ? address.address : config.host;
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.log(
      `[ai-quiz] listening on http://${formatHost(host)}:${port} ` +
        `(mode=${server.provider.kind}, model=${server.provider.model})`,
    );
  });
  return server;
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const server = start(loadConfig());
  server.once('error', (error) => {
    console.error('[ai-quiz] failed to start:', error?.message ?? error);
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
