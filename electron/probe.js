/**
 * Connection self-test — docs/CONTRACT-PROBE.md §1.
 *
 * Pure Node: no `electron` import, no filesystem, no logging, no caching.
 * The caller passes already-resolved settings plus an optional local patch, so
 * tests can run this module directly. Nothing here ever returns an API key or a
 * full base URL: results carry `host` only.
 */

import { createProvider, ProviderError } from '../server/provider.js';

export const PROBE_TIMEOUT_MS = 15_000;

const CONCURRENCY = 2;
const MAX_TARGETS = 8;
const MESSAGE_LIMIT = 160;
const PROBE_PROMPT = 'ping';
const ROLE_ORDER = Object.freeze(['text', 'vision', 'candidate', 'judge']);

const ROLE_LABELS = Object.freeze({ text: '文本', vision: '视觉', candidate: '候选', judge: '评审' });

const MESSAGES = Object.freeze({
  AUTH: '密钥无效或已过期',
  PLAN: '该模型不在当前订阅计划内',
  MODEL_NOT_FOUND: '模型不存在或端点不匹配',
  RATE_LIMITED: '请求过于频繁，稍后再试',
  NETWORK: '无法连接模型服务，请检查 Base URL 与网络',
  UPSTREAM: '模型服务返回了错误响应',
  NO_KEY: '未配置 API Key',
});

const MODEL_MISSING = /unsupported_model|model_not_found|does not exist|invalid model|not[\s_-]*found/i;
const PLAN_MARKERS = /upgrade_required|model_region_unavailable|permission/i;
const SECRETISH = /\b(?:sk|xox[baprs]|ak|api[_-]?key)[-_:]?[A-Za-z0-9_-]{6,}/gi;

/* ---------------------------------------------------------------- helpers -- */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Merge `patch` over `base`, touching only the keys the patch actually carries. */
function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) out[key] = mergeDeep(out[key], value);
    else if (Array.isArray(value)) out[key] = mergeArrays(out[key], value);
    else out[key] = value;
  }
  return out;
}

/** Element-wise merge for slot lists (candidates keep their inherited defaults). */
function mergeArrays(base, patch) {
  const source = Array.isArray(base) ? base : [];
  const length = Math.max(source.length, patch.length);
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const next = patch[index];
    if (next === undefined) {
      out.push(source[index]);
    } else if (isPlainObject(next) && isPlainObject(source[index])) {
      out.push(mergeDeep(source[index], next));
    } else {
      out.push(next);
    }
  }
  return out;
}

/** `patch` may be a full settings patch (`{ai:{...}}`) or a bare `ai` patch. */
function patchAi(patch) {
  if (!isPlainObject(patch)) return {};
  if (Object.prototype.hasOwnProperty.call(patch, 'ai')) {
    return isPlainObject(patch.ai) ? patch.ai : {};
  }
  return patch;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

function roleLabel(role, index) {
  if (role === 'candidate') {
    return `${ROLE_LABELS.candidate} ${String.fromCharCode(65 + index)}`;
  }
  return ROLE_LABELS[role];
}

function abortError() {
  const error = new Error('连接测试已取消');
  error.name = 'AbortError';
  return error;
}

/* --------------------------------------------------------------- targets -- */

/**
 * @param {object} settingsLike `{ai:{baseUrl,apiKey,model,visionModel,vision,ensemble}}`
 * @param {object} [patch] local patch from `validatePatch`
 * @returns {Array<{role:string,label:string,baseUrl:string,apiKey:string,model:string,key:string}>}
 */
export function resolveProbeTargets(settingsLike, patch) {
  const settings = isPlainObject(settingsLike) ? settingsLike : {};
  const ai = mergeDeep(isPlainObject(settings.ai) ? settings.ai : {}, patchAi(patch));

  const baseUrl = text(ai.baseUrl);
  const apiKey = text(ai.apiKey);
  const model = text(ai.model);
  const visionModel = text(ai.visionModel);
  const vision = isPlainObject(ai.vision) ? ai.vision : {};
  const ensemble = isPlainObject(ai.ensemble) ? ai.ensemble : {};
  const candidates = Array.isArray(ensemble.candidates) ? ensemble.candidates : [];
  const judge = isPlainObject(ensemble.judge) ? ensemble.judge : {};

  // Each slot inherits the global endpoint first, then its own overrides.
  const inherited = (slot, fallbackModel) => ({
    baseUrl: text(slot.baseUrl) || baseUrl,
    apiKey: text(slot.apiKey) || apiKey,
    model: text(slot.model) || fallbackModel,
  });

  const slots = [
    { role: 'text', ...inherited({}, model) },
    { role: 'vision', ...inherited(vision, visionModel || model) },
  ];

  candidates.forEach((candidate, index) => {
    if (!isPlainObject(candidate)) return;
    slots.push({
      role: 'candidate',
      index,
      ...inherited(candidate, ''),
    });
  });

  // An empty judge model falls back to the text model.
  slots.push({ role: 'judge', ...inherited(judge, model) });

  const targets = [];
  const seen = new Set();
  for (const slot of slots) {
    if (!slot.baseUrl || !slot.model) continue;
    const identity = `${slot.baseUrl}|${slot.model}|${slot.apiKey}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = slot.role === 'candidate' ? `candidate-${slot.index}` : slot.role;
    targets.push({
      role: slot.role,
      label: roleLabel(slot.role, slot.index ?? 0),
      baseUrl: slot.baseUrl,
      apiKey: slot.apiKey,
      model: slot.model,
      key,
    });
    if (targets.length >= MAX_TARGETS) break;
  }

  // Stable contract order: text, vision, candidates (slot order), judge.
  targets.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  return targets;
}

/* --------------------------------------------------------------- messages -- */

function cap(value) {
  const out = String(value ?? '');
  return out.length > MESSAGE_LIMIT ? `${out.slice(0, MESSAGE_LIMIT - 1)}…` : out;
}

function scrub(value, target) {
  let out = String(value ?? '');
  if (target.apiKey) out = out.split(target.apiKey).join('[已隐藏]');
  out = out.replace(SECRETISH, '[已隐藏]');
  if (target.baseUrl) {
    const host = hostOf(target.baseUrl);
    out = out.split(target.baseUrl).join(host || '[服务地址已隐藏]');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return cap(out);
}

function networkMessage(detail) {
  if (!detail) return MESSAGES.NETWORK;
  // The provider already prefixes transport failures with the same phrase.
  return detail.startsWith('无法连接模型服务') ? detail : `${MESSAGES.NETWORK}：${detail}`;
}

/** Map a provider failure onto the contract's code/status/message triple. */
function classify(error, target, timeoutMs) {
  if (error instanceof ProviderError) {
    const { status } = error;
    const detail = scrub(error.message ?? '', target);
    const seconds = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${Math.round(timeoutMs)}ms`;
    if (error.code === 'TIMEOUT') {
      return { code: 'TIMEOUT', message: `连接超时（${seconds}），请检查网络或服务地址` };
    }
    if (typeof status === 'number') {
      if (status === 401) return { status, code: 'AUTH', message: MESSAGES.AUTH };
      if (status === 403 && PLAN_MARKERS.test(detail)) {
        return { status, code: 'PLAN', message: MESSAGES.PLAN };
      }
      if ((status === 400 || status === 404) && MODEL_MISSING.test(detail)) {
        return { status, code: 'MODEL_NOT_FOUND', message: MESSAGES.MODEL_NOT_FOUND };
      }
      if (status === 404) return { status, code: 'MODEL_NOT_FOUND', message: MESSAGES.MODEL_NOT_FOUND };
      if (status === 429) return { status, code: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED };
      return {
        status,
        code: 'UPSTREAM',
        message: detail
          ? `${MESSAGES.UPSTREAM}（HTTP ${status}）：${detail}`
          : `${MESSAGES.UPSTREAM}（HTTP ${status}）`,
      };
    }
    return { code: 'NETWORK', message: networkMessage(detail) };
  }

  return { code: 'NETWORK', message: networkMessage(scrub(error?.message ?? '', target)) };
}

/* ---------------------------------------------------------------- probing -- */

async function probeTarget(target, signal, timeoutMs) {
  const started = Date.now();
  const host = hostOf(target.baseUrl);
  const base = { role: target.role, label: target.label, model: target.model, host };

  if (signal?.aborted) throw abortError();

  const provider = createProvider({
    ai: {
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      timeoutMs,
      maxRetries: 0,
    },
  });

  try {
    await provider.chat({
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      maxTokens: 8,
      temperature: 0,
      signal,
    });
    return { ...base, ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    if (signal?.aborted || error?.code === 'ABORTED') throw abortError();
    const failure = classify(error, target, timeoutMs);
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - started,
      ...failure,
      message: cap(failure.message),
    };
  }
}

/** Bounded worker pool: resolves in input order, rethrows the first failure. */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failure = null;

  const run = async () => {
    for (;;) {
      if (failure) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        failure = failure ?? error;
        return;
      }
    }
  };

  const runners = [];
  for (let index = 0; index < Math.min(limit, items.length); index += 1) runners.push(run());
  await Promise.all(runners);
  if (failure) throw failure;
  return results;
}

/**
 * @param {object} settingsLike resolved settings (see resolveProbeTargets)
 * @param {object} [patch] local, unsaved patch; never persisted here
 * @param {{signal?: AbortSignal}} [options]
 */
export async function testConnection(settingsLike, patch, options = {}) {
  const signal = options?.signal;
  const configuredTimeout = Number(options?.timeoutMs);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : PROBE_TIMEOUT_MS;
  const targets = resolveProbeTargets(settingsLike, patch);

  if (isPlainObject(settingsLike) && settingsLike.demo === true) {
    return {
      ok: false,
      reason: 'DEMO',
      checkedAt: Date.now(),
      summary: { total: 0, ok: 0, failed: 0, latencyMs: 0 },
      results: [],
    };
  }

  const keyed = targets.filter((target) => target.apiKey);
  if (keyed.length === 0) {
    return {
      ok: false,
      reason: 'NO_KEY',
      checkedAt: Date.now(),
      summary: { total: 0, ok: 0, failed: 0, latencyMs: 0 },
      results: [],
    };
  }

  if (signal?.aborted) throw abortError();

  const results = await runPool(keyed, CONCURRENCY, (target) => {
    if (signal?.aborted) throw abortError();
    return probeTarget(target, signal, timeoutMs);
  });

  if (signal?.aborted) throw abortError();

  const ok = results.filter((result) => result.ok).length;
  const latencyMs = results.reduce((slowest, result) => Math.max(slowest, result.latencyMs), 0);
  return {
    ok: ok === results.length,
    checkedAt: Date.now(),
    summary: { total: results.length, ok, failed: results.length - ok, latencyMs },
    results,
  };
}
