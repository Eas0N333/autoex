/**
 * Transport-free quiz engine.
 *
 * Owns everything between "raw request body" and "answer stream": input
 * normalization, image validation, vision recognition, the LRU+TTL answer cache
 * and error-code mapping. It performs no I/O of its own: the provider is
 * injected, nothing is written to disk and nothing is logged. `server/index.js`
 * (HTTP) and the Electron main process consume it through the same surface.
 *
 * Public surface (see docs/CONTRACT-DESKTOP.md §1):
 *   EngineError, createEngine(config)
 */

import { createHash } from 'node:crypto';

import { answerStream as streamAnswer } from './answer.js';
import { createCache } from './cache.js';
import { ensembleAnswer } from './ensemble.js';
import { createProvider, ProviderError } from './provider.js';
import { isSupportedImageDataUrl, recognizeQuestion } from './recognize.js';

export const STYLES = ['concise', 'detailed', 'step'];
export const DEFAULT_STYLE = 'concise';

const ERROR_CODES = new Set([
  'BAD_REQUEST',
  'UNSUPPORTED',
  'PAYLOAD_TOO_LARGE',
  'UPSTREAM_ERROR',
  'TIMEOUT',
  'ABORTED',
]);

const DEFAULT_LIMITS = {
  maxImageBytes: 8 * 1024 * 1024,
  maxQuestionChars: 8000,
  maxOptions: 10,
};

const MESSAGES = {
  missingImage: '缺少图片数据（imageDataUrl）',
  malformedImage: 'imageDataUrl 必须是 base64 编码的 data URL',
  invalidBase64: '图片数据不是合法的 base64 编码',
  emptyQuestion: '题目内容不能为空',
  aborted: '请求已取消',
  timeout: '模型响应超时，请稍后重试',
  upstream: '模型服务暂时不可用，请稍后重试',
  recognize: '未能从图片中识别出题目，请重试或手动输入',
  ensembleNeedsCandidates: '交叉验证需要至少 2 个候选模型',
  ensembleFailed: '所有候选模型均未能作答，请稍后重试',
};

/** Error type crossing the engine boundary; `code` drives caller behaviour. */
export class EngineError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EngineError';
    this.code = ERROR_CODES.has(code) ? code : 'UPSTREAM_ERROR';
  }
}

/** Base64 payload byte length without allocating the decoded buffer. */
function decodedBase64Bytes(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function limitNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function toEngineError(error) {
  if (error instanceof EngineError) return error;
  if (error instanceof ProviderError || error?.name === 'ProviderError') {
    if (error.code === 'TIMEOUT') return new EngineError('TIMEOUT', MESSAGES.timeout);
    if (error.code === 'ABORTED') return new EngineError('ABORTED', MESSAGES.aborted);
    return new EngineError('UPSTREAM_ERROR', MESSAGES.upstream);
  }
  if (error?.name === 'RecognizeError' || error?.code === 'PARSE' || error?.code === 'EMPTY') {
    return new EngineError('UPSTREAM_ERROR', MESSAGES.recognize);
  }
  return error;
}

function normalizeQuestion(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new EngineError('BAD_REQUEST', 'question 必须为字符串');
  return raw.trim();
}

function normalizeSubject(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 64);
}

function normalizeStyle(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_STYLE;
  const style = String(raw).trim();
  if (!STYLES.includes(style)) {
    throw new EngineError('BAD_REQUEST', `style 必须是 ${STYLES.join(' / ')} 之一`);
  }
  return style;
}

function normalizeOptions(raw, maxOptions) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new EngineError('BAD_REQUEST', 'options 必须为数组');
  const limit = Number.isFinite(maxOptions) && maxOptions > 0 ? maxOptions : DEFAULT_LIMITS.maxOptions;
  const options = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') continue;
    const label =
      typeof item.label === 'string' && item.label.trim() !== ''
        ? item.label.trim().slice(0, 8)
        : String.fromCharCode(65 + options.length);
    options.push({ label, text });
    if (options.length >= limit) break;
  }
  return options;
}

function cacheKey(question, options, style, ensembleMode) {
  const signature = options.map((option) => `${option.label}\u0001${option.text}`).join('\u0002');
  const base = `${question}\u0000${signature}\u0001${style}`;
  if (!ensembleMode) return createHash('sha256').update(base).digest('hex');
  const slots = ensembleMode.candidates
    .map((candidate) => `${candidate.baseUrl}|${candidate.model}|${candidate.temperature}`)
    .join('\u0003');
  const judge = `${ensembleMode.judge.baseUrl}|${ensembleMode.judge.model}|${ensembleMode.judge.temperature}`;
  return createHash('sha256').update(`${base}\u0004ensemble\u0005${slots}\u0006${judge}`).digest('hex');
}

const MIN_ENSEMBLE_CANDIDATES = 2;
const MAX_ENSEMBLE_CANDIDATES = 5;
const ENSEMBLE_TEMPERATURES = [0.3, 0.6, 0.9];

function trimSlash(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value);
}

function finiteTemperature(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0, n));
}

/**
 * Builds the engine for a config object produced by `loadConfig()`.
 * The returned object is the only API both the HTTP server and Electron use.
 */
export function createEngine(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('createEngine(config) requires the config object from loadConfig()');
  }

  const sourceLimits = config.limits ?? {};
  const limits = Object.freeze({
    maxImageBytes: limitNumber(sourceLimits.maxImageBytes, DEFAULT_LIMITS.maxImageBytes),
    maxQuestionChars: limitNumber(sourceLimits.maxQuestionChars, DEFAULT_LIMITS.maxQuestionChars),
    maxOptions: limitNumber(sourceLimits.maxOptions, DEFAULT_LIMITS.maxOptions),
  });

  const ai = config.ai ?? {};
  const baseAi = {
    baseUrl: trimSlash(ai.baseUrl),
    apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '',
    model: typeof ai.model === 'string' ? ai.model : '',
    visionModel: typeof ai.visionModel === 'string' ? ai.visionModel : '',
    timeoutMs: Number.isFinite(ai.timeoutMs) && ai.timeoutMs > 0 ? ai.timeoutMs : 60_000,
    maxRetries: Number.isFinite(ai.maxRetries) ? ai.maxRetries : 1,
    headers: ai.headers && typeof ai.headers === 'object' ? ai.headers : {},
  };

  const provider = createProvider(config);

  /** A config copy that points one provider at its own endpoint. */
  function endpointConfig({ baseUrl, apiKey, model, visionModel }) {
    return {
      ...config,
      demo: config.demo === true,
      ai: {
        ...baseAi,
        baseUrl,
        apiKey,
        model,
        visionModel: visionModel || model,
        headers: { ...baseAi.headers },
      },
    };
  }

  // Vision (OCR) endpoint: fields left empty inherit the primary ai.* endpoint.
  const visionSlot = ai.vision && typeof ai.vision === 'object' ? ai.vision : {};
  const visionBaseUrl = trimSlash(visionSlot.baseUrl) || baseAi.baseUrl;
  const visionApiKey =
    typeof visionSlot.apiKey === 'string' && visionSlot.apiKey !== '' ? visionSlot.apiKey : baseAi.apiKey;
  const visionModel =
    (typeof visionSlot.model === 'string' && visionSlot.model.trim()) ||
    baseAi.visionModel ||
    baseAi.model;
  const visionProvider =
    config.demo === true ||
    (visionBaseUrl === baseAi.baseUrl &&
      visionApiKey === baseAi.apiKey &&
      visionModel === (baseAi.visionModel || baseAi.model))
      ? provider
      : createProvider(endpointConfig({ baseUrl: visionBaseUrl, apiKey: visionApiKey, model: visionModel }), {
          allowKeyless: true,
        });

  const ensembleSlot = ai.ensemble && typeof ai.ensemble === 'object' ? ai.ensemble : {};
  const candidateSlots = Array.isArray(ensembleSlot.candidates)
    ? ensembleSlot.candidates.slice(0, MAX_ENSEMBLE_CANDIDATES)
    : [];

  function resolveSlot(raw, index, fallbackTemperature) {
    const slot = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const model = typeof slot.model === 'string' ? slot.model.trim() : '';
    const baseUrl = trimSlash(slot.baseUrl) || baseAi.baseUrl;
    const apiKey = typeof slot.apiKey === 'string' && slot.apiKey !== '' ? slot.apiKey : baseAi.apiKey;
    const name = typeof slot.name === 'string' && slot.name.trim() !== '' ? slot.name.trim() : `模型 ${String.fromCharCode(65 + index)}`;
    return { index, name, model, baseUrl, apiKey, temperature: finiteTemperature(slot.temperature, fallbackTemperature) };
  }

  // A candidate only participates when its model is configured and the resolved
  // base URL is usable.
  const participants = [];
  for (let index = 0; index < candidateSlots.length; index += 1) {
    const slot = resolveSlot(candidateSlots[index], index, ENSEMBLE_TEMPERATURES[index] ?? 0.3);
    if (slot.model === '' || !isHttpUrl(slot.baseUrl)) continue;
    participants.push({
      ...slot,
      provider: createProvider(endpointConfig({ baseUrl: slot.baseUrl, apiKey: slot.apiKey, model: slot.model }), {
        allowKeyless: true,
      }),
    });
  }

  const judgeSlot = ensembleSlot.judge && typeof ensembleSlot.judge === 'object' ? ensembleSlot.judge : {};
  const judgeModel = (typeof judgeSlot.model === 'string' && judgeSlot.model.trim()) || baseAi.model;
  const judgeBaseUrl = trimSlash(judgeSlot.baseUrl) || baseAi.baseUrl;
  const judgeApiKey =
    typeof judgeSlot.apiKey === 'string' && judgeSlot.apiKey !== '' ? judgeSlot.apiKey : baseAi.apiKey;
  const judgeProvider = createProvider(endpointConfig({ baseUrl: judgeBaseUrl, apiKey: judgeApiKey, model: judgeModel }), {
    allowKeyless: true,
  });
  const judge = {
    name: (typeof judgeSlot.name === 'string' && judgeSlot.name.trim()) || '评审',
    model: judgeProvider.model || judgeModel,
    baseUrl: judgeBaseUrl,
    apiKey: judgeApiKey,
    temperature: finiteTemperature(judgeSlot.temperature, 0.1),
    provider: judgeProvider,
  };

  const ensembleEnabled = ensembleSlot.enabled === true;

  /** Offline cross-check: the demo provider stands in for every candidate slot. */
  function demoParticipants() {
    const slots = candidateSlots.length > 0 ? candidateSlots : [null, null, null];
    const list = [];
    const count = Math.max(3, Math.min(MAX_ENSEMBLE_CANDIDATES, slots.length));
    for (let index = 0; index < count; index += 1) {
      const slot = resolveSlot(slots[index], index, ENSEMBLE_TEMPERATURES[index] ?? 0.3);
      list.push({ ...slot, model: slot.model || provider.model, provider });
    }
    return list;
  }

  let cache = createCache({
    maxEntries: sourceLimits.maxCacheEntries,
    ttlMs: sourceLimits.answerCacheTtlMs,
  });

  /** Validate an image data URL; throws EngineError (contract: returns void). */
  function validateImage(raw) {
    requireImage(raw);
  }

  /** Validates an image data URL and returns it trimmed for provider use. */
  function requireImage(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new EngineError('BAD_REQUEST', MESSAGES.missingImage);
    }
    const value = raw.trim();
    const match = /^data:([^;,]+);base64,(.*)$/is.exec(value);
    if (!match) {
      throw new EngineError('BAD_REQUEST', MESSAGES.malformedImage);
    }
    const mime = match[1].toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
      throw new EngineError('UNSUPPORTED', `不支持的图片类型：${mime}`);
    }
    if (!isSupportedImageDataUrl(value)) {
      throw new EngineError('BAD_REQUEST', MESSAGES.invalidBase64);
    }
    const bytes = decodedBase64Bytes(match[2]);
    if (bytes > limits.maxImageBytes) {
      throw new EngineError('PAYLOAD_TOO_LARGE', `图片大小超过 ${limits.maxImageBytes} 字节上限`);
    }
    return value;
  }

  /** Image → structured question. Validates the image, maps upstream failures. */
  async function recognize(input = {}) {
    const imageDataUrl = requireImage(input?.imageDataUrl);
    let result;
    try {
      result = await recognizeQuestion(
        { imageDataUrl },
        { provider: visionProvider, signal: input?.signal, limits },
      );
    } catch (error) {
      throw toEngineError(error);
    }
    return {
      question: String(result.question ?? ''),
      options: Array.isArray(result.options) ? result.options : [],
      subject: result.subject || '未知',
      questionType: result.questionType || 'unknown',
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      model: typeof result.model === 'string' && result.model ? result.model : visionProvider.visionModel,
    };
  }

  /**
   * Streams meta → delta* → (usage) → done. The whole pipeline (validation,
   * optional recognition, cache lookup/store) happens inside the generator, so
   * a caller that stops iterating early also stops the upstream request and
   * leaves the cache untouched.
   */
  async function* answerStream(input, context = {}) {
    const startedAt = Date.now();
    const signal = context?.signal;
    const source = input && typeof input === 'object' ? input : {};

    if (signal?.aborted) throw new EngineError('ABORTED', MESSAGES.aborted);

    const requestedEnsemble = context?.ensemble;
    const useEnsemble = requestedEnsemble === undefined ? ensembleEnabled : Boolean(requestedEnsemble);

    const style = normalizeStyle(source.style);
    let options = normalizeOptions(source.options, limits.maxOptions);
    let subject = normalizeSubject(source.subject);
    let question = normalizeQuestion(source.question).slice(0, limits.maxQuestionChars);

    let imageDataUrl = '';
    if (source.imageDataUrl !== undefined && source.imageDataUrl !== null && source.imageDataUrl !== '') {
      imageDataUrl = requireImage(source.imageDataUrl);
    }

    let activeCandidates = [];
    let activeJudge = null;
    if (useEnsemble) {
      activeCandidates = participants;
      activeJudge = judge;
      if (config.demo === true || (activeCandidates.length === 0 && provider.kind === 'demo')) {
        activeCandidates = demoParticipants();
        if (provider.kind === 'demo') {
          activeJudge = { ...judge, model: provider.model, provider };
        }
      }
      if (activeCandidates.length < MIN_ENSEMBLE_CANDIDATES) {
        throw new EngineError('BAD_REQUEST', MESSAGES.ensembleNeedsCandidates);
      }
    }

    const recognizedFromImage = imageDataUrl !== '' && question === '';
    if (recognizedFromImage) {
      const recognized = await recognize({ imageDataUrl, signal });
      question = String(recognized.question ?? '')
        .trim()
        .slice(0, limits.maxQuestionChars);
      if (options.length === 0 && Array.isArray(recognized.options)) {
        options = normalizeOptions(recognized.options, limits.maxOptions);
      }
      if (!subject) subject = normalizeSubject(recognized.subject);
    }

    if (!question) throw new EngineError('BAD_REQUEST', MESSAGES.emptyQuestion);

    const finalSubject = subject || '未知';
    const cacheable = !recognizedFromImage; // Image-only requests are never cached.
    const ensembleMode = useEnsemble ? { candidates: activeCandidates, judge: activeJudge } : null;
    const key = cacheKey(question, options, style, ensembleMode);
    const cached = cacheable ? cache.get(key) : undefined;

    yield {
      type: 'meta',
      cached: Boolean(cached),
      mode: provider.kind,
      model: useEnsemble ? activeJudge.model : provider.model,
      question,
      options,
      subject: finalSubject,
      style,
      ensemble: useEnsemble,
      candidates: useEnsemble
        ? activeCandidates.map((candidate) => ({
            index: candidate.index,
            name: candidate.name,
            model: candidate.model,
          }))
        : [],
      judge: useEnsemble ? { name: activeJudge.name, model: activeJudge.model } : null,
    };

    if (cached && typeof cached.text === 'string') {
      if (useEnsemble && Array.isArray(cached.candidates)) {
        for (const candidate of cached.candidates) {
          yield {
            type: 'candidate',
            index: candidate.index,
            name: candidate.name,
            model: candidate.model,
            status: candidate.status ?? 'done',
            ...(typeof candidate.text === 'string' ? { text: candidate.text } : {}),
            ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
            durationMs: candidate.durationMs ?? 0,
          };
        }
      }
      yield { type: 'delta', text: cached.text };
      yield {
        type: 'done',
        text: cached.text,
        cached: true,
        durationMs: Date.now() - startedAt,
        usage: cached.usage ?? null,
        ensemble: useEnsemble,
        candidates: useEnsemble && Array.isArray(cached.candidates) ? cached.candidates : [],
        judge: useEnsemble ? (cached.judge ?? null) : null,
      };
      return;
    }

    let text = '';
    let usage = null;
    let candidates = [];
    let judgeResult = null;
    let fallback = false;
    try {
      if (useEnsemble) {
        for await (const event of ensembleAnswer(
          { question, options, subject: finalSubject, style },
          {
            candidates: activeCandidates,
            judge: activeJudge,
            signal,
            limits: {
              maxQuestionChars: limits.maxQuestionChars,
              maxOptions: limits.maxOptions,
              timeoutMs: baseAi.timeoutMs,
            },
          },
        )) {
          if (!event || typeof event !== 'object') continue;
          if (event.type === 'candidate') {
            yield event;
          } else if (event.type === 'delta' && typeof event.text === 'string' && event.text !== '') {
            text += event.text;
            yield { type: 'delta', text: event.text };
          } else if (event.type === 'usage' && event.usage) {
            usage = event.usage;
            yield { type: 'usage', usage: event.usage };
          } else if (event.type === 'done') {
            candidates = Array.isArray(event.candidates) ? event.candidates : [];
            judgeResult = event.judge ?? null;
            fallback = event.fallback === true;
            if (typeof event.text === 'string') text = event.text;
          }
        }
      } else {
        for await (const chunk of streamAnswer(
          { question, options, subject: finalSubject, style },
          { provider, signal, limits },
        )) {
          if (!chunk || typeof chunk !== 'object') continue;
          if (chunk.type === 'delta' && typeof chunk.text === 'string' && chunk.text !== '') {
            text += chunk.text;
            yield { type: 'delta', text: chunk.text };
          } else if (chunk.type === 'usage' && chunk.usage) {
            usage = chunk.usage;
            yield { type: 'usage', usage: chunk.usage };
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new EngineError('ABORTED', MESSAGES.aborted);
      if (error?.code === 'ENSEMBLE_FAILED') {
        throw new EngineError('UPSTREAM_ERROR', MESSAGES.ensembleFailed);
      }
      throw toEngineError(error);
    }

    // A cancelled caller must never be served a truncated answer from the cache.
    if (signal?.aborted) throw new EngineError('ABORTED', MESSAGES.aborted);

    if (cacheable && text !== '') {
      cache.set(key, useEnsemble ? { text, usage, candidates, judge: judgeResult } : { text, usage });
    }

    yield {
      type: 'done',
      text,
      cached: false,
      durationMs: Date.now() - startedAt,
      usage,
      ensemble: useEnsemble,
      candidates: useEnsemble ? candidates : [],
      judge: useEnsemble ? judgeResult : null,
      ...(useEnsemble && fallback ? { fallback: true } : {}),
    };
  }

  /** Collects the stream into one complete answer (used for JSON aggregation). */
  async function answerComplete(input, context = {}) {
    const startedAt = Date.now();
    let text = '';
    let usage = null;
    let cached = false;
    for await (const event of answerStream(input, context)) {
      if (!event || typeof event !== 'object') continue;
      if (event.type === 'delta' && typeof event.text === 'string') text += event.text;
      else if (event.type === 'meta') cached = Boolean(event.cached);
      else if (event.type === 'usage' && event.usage) usage = event.usage;
      else if (event.type === 'done') {
        return {
          text: event.text,
          usage: event.usage ?? null,
          cached: Boolean(event.cached),
          durationMs: event.durationMs,
          ensemble: Boolean(event.ensemble),
          candidates: Array.isArray(event.candidates) ? event.candidates : [],
          judge: event.judge ?? null,
          fallback: event.fallback === true,
        };
      }
    }
    return {
      text,
      usage,
      cached,
      durationMs: Date.now() - startedAt,
      ensemble: false,
      candidates: [],
      judge: null,
      fallback: false,
    };
  }

  /** Drops every cached answer (LRU state included). */
  function clearCache() {
    cache = createCache({
      maxEntries: sourceLimits.maxCacheEntries,
      ttlMs: sourceLimits.answerCacheTtlMs,
    });
  }

  return {
    config,
    limits,
    provider,
    mode: provider.kind,
    models: { chat: provider.model, visionModel: visionProvider.visionModel },
    validateImage,
    recognize,
    answerStream,
    answerComplete,
    clearCache,
  };
}
