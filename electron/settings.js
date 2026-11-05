/**
 * Persistent desktop settings.
 *
 * Resolution order (docs/CONTRACT-DESKTOP.md §2):
 *   environment variables > userData/settings.json > repo config.json > defaults
 *
 * The API key is stored on this machine only and is never handed to a renderer:
 * `getState()` swaps it for a boolean `hasApiKey`.
 */

import { app } from 'electron';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { ROOT } from '../server/config.js';

export const STYLES = Object.freeze(['concise', 'detailed', 'step']);

/** One-click endpoints for the settings drawer (docs/CONTRACT-ENSEMBLE.md §5). */
export const AI_PRESETS = Object.freeze({
  commandcode: Object.freeze({
    label: 'Command Code 订阅',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    visionModel: 'deepseek/deepseek-v4.1-flash',
    candidates: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro', 'google/gemini-3.8-flash'],
    judge: 'deepseek/deepseek-v4-pro',
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    visionModel: 'deepseek-flash',
    candidates: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-flash'],
    judge: 'deepseek-v4-pro',
  }),
  openai: Object.freeze({
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
    candidates: ['gpt-4o-mini', 'gpt-4o-mini', 'gpt-4o-mini'],
    judge: 'gpt-4o-mini',
  }),
});

export const CANDIDATE_SLOTS = 3;
export const MAX_CANDIDATES = 5;
export const NAME_MAX = 40;

/** Slot defaults: three empty candidates plus the judge. */
export const DEFAULT_SETTINGS = Object.freeze({
  ai: Object.freeze({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    visionModel: '',
    timeoutMs: 60_000,
    maxRetries: 1,
    vision: Object.freeze({ baseUrl: '', apiKey: '', model: '' }),
    ensemble: Object.freeze({
      enabled: false,
      candidates: Object.freeze([
        Object.freeze({ name: '模型 A', baseUrl: '', apiKey: '', model: '', temperature: 0.3 }),
        Object.freeze({ name: '模型 B', baseUrl: '', apiKey: '', model: '', temperature: 0.6 }),
        Object.freeze({ name: '模型 C', baseUrl: '', apiKey: '', model: '', temperature: 0.9 }),
      ]),
      judge: Object.freeze({ name: '评审', baseUrl: '', apiKey: '', model: '', temperature: 0.1 }),
    }),
  }),
  auto: Object.freeze({
    enabled: true,
    autoAnswer: true,
    intervalMs: 1500,
    sensitivity: 3,
    crop: null,
  }),
  style: 'concise',
  capture: Object.freeze({ sourceId: null, sourceName: null }),
  overlay: Object.freeze({
    width: 420,
    x: null,
    y: null,
    height: null,
    collapsed: false,
    displayId: null,
  }),
  hotkeys: Object.freeze({
    toggle: 'CommandOrControl+Shift+Q',
    scan: 'CommandOrControl+Shift+S',
    pause: 'CommandOrControl+Shift+P',
  }),
});

const MODEL_PATTERN = /^[A-Za-z0-9._:@/+-]{1,160}$/;
const HOTKEY_PATTERN = /^[A-Za-z0-9_+\- ]{3,64}$/;
const URL_MAX = 2048;
const KEY_MAX = 512;

/** Invalid settings patch. `code` travels to the renderer (see preload decode). */
export class SettingsError extends Error {
  constructor(message, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cloneSettings(value) {
  return structuredClone(value);
}

/**
 * Merges two arrays index by index. `null`/`undefined` entries mean "leave this
 * slot alone", which is what the ensemble candidate form relies on.
 */
function mergeArrays(base, patch) {
  const out = base.map((item) => (isPlainObject(item) ? deepMerge({}, item) : item));
  for (let index = 0; index < patch.length; index += 1) {
    const value = patch[index];
    if (value === undefined || value === null) continue;
    const previous = out[index];
    out[index] = isPlainObject(value) && isPlainObject(previous) ? deepMerge(previous, value) : (
      isPlainObject(value) ? deepMerge({}, value) : value
    );
  }
  return out;
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      out[key] = Array.isArray(out[key]) ? mergeArrays(out[key], value) : mergeArrays([], value);
      continue;
    }
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : (
      isPlainObject(value) ? deepMerge({}, value) : value
    );
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function nullableInt(value, min, max) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function plainText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function normalizeBaseUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed) || trimmed.length > URL_MAX) return fallback;
  return trimmed;
}

function normalizeModel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return MODEL_PATTERN.test(trimmed) ? trimmed : fallback;
}

function normalizeAccelerator(value, fallback) {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!HOTKEY_PATTERN.test(trimmed) || !trimmed.includes('+')) return fallback;
  return trimmed;
}

function normalizeCrop(value) {
  if (!isPlainObject(value)) return null;
  const crop = {};
  for (const key of ['x', 'y', 'w', 'h']) {
    const n = Number(value[key]);
    if (!Number.isFinite(n)) return null;
    crop[key] = Math.min(1, Math.max(0, n));
  }
  if (crop.w <= 0 || crop.h <= 0) return null;
  if (crop.x + crop.w > 1.0001 || crop.y + crop.h > 1.0001) return null;
  return crop;
}

/** Secret text: trimmed, control characters stripped, capped. */
function normalizeSecret(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return plainText(value, KEY_MAX).trim();
}

/** Model name that may legitimately stay empty (an unconfigured slot). */
function normalizeOptionalModel(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return '';
  return MODEL_PATTERN.test(trimmed) ? trimmed : fallback;
}

function normalizeName(value, fallback) {
  const text = plainText(value, NAME_MAX).trim();
  return text || fallback;
}

function normalizeTemperature(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0, Math.round(n * 100) / 100));
}

function slotName(index) {
  const fallback = DEFAULT_SETTINGS.ai.ensemble.candidates[index];
  if (fallback) return fallback.name;
  return `模型 ${String.fromCharCode(65 + index)}`;
}

function sanitizeVision(raw) {
  const vision = isPlainObject(raw) ? raw : {};
  return {
    baseUrl: normalizeBaseUrl(vision.baseUrl, ''),
    apiKey: normalizeSecret(vision.apiKey),
    model: normalizeOptionalModel(vision.model),
  };
}

function sanitizeEnsemble(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const input = Array.isArray(source.candidates) ? source.candidates : [];
  const count = Math.min(MAX_CANDIDATES, Math.max(CANDIDATE_SLOTS, input.length));
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const slot = isPlainObject(input[index]) ? input[index] : {};
    const defaults = DEFAULT_SETTINGS.ai.ensemble.candidates[index];
    candidates.push({
      name: normalizeName(slot.name, defaults ? defaults.name : slotName(index)),
      baseUrl: normalizeBaseUrl(slot.baseUrl, ''),
      apiKey: normalizeSecret(slot.apiKey),
      model: normalizeOptionalModel(slot.model),
      temperature: normalizeTemperature(
        slot.temperature,
        defaults ? defaults.temperature : 0.3,
      ),
    });
  }
  const judge = isPlainObject(source.judge) ? source.judge : {};
  const judgeDefaults = DEFAULT_SETTINGS.ai.ensemble.judge;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.ai.ensemble.enabled,
    candidates,
    judge: {
      name: normalizeName(judge.name, judgeDefaults.name),
      baseUrl: normalizeBaseUrl(judge.baseUrl, ''),
      apiKey: normalizeSecret(judge.apiKey),
      model: normalizeOptionalModel(judge.model),
      temperature: normalizeTemperature(judge.temperature, judgeDefaults.temperature),
    },
  };
}

/* ------------------------------------------------------------------- paths -- */

function fallbackUserDataDir() {
  try {
    return app.getPath('userData');
  } catch {
    return path.join(ROOT, '.aqs-data');
  }
}

/** `AQS_SETTINGS` overrides the location (smoke tests use a temp file). */
export function settingsFile() {
  const override = typeof process.env.AQS_SETTINGS === 'string' ? process.env.AQS_SETTINGS.trim() : '';
  if (override) return path.resolve(override);
  return path.join(fallbackUserDataDir(), 'settings.json');
}

function backupPath(file) {
  return `${file}.bad`;
}

function backupCorrupt(file, error) {
  try {
    const target = backupPath(file);
    try {
      rmSync(target, { force: true });
    } catch {
      /* an old backup we cannot remove is not fatal */
    }
    renameSync(file, target);
    console.error(`[aqs] settings.json 无法解析（${error?.message ?? error}），已备份为 ${path.basename(target)}`);
  } catch (renameError) {
    console.error('[aqs] settings.json 无法解析且备份失败：', renameError?.message ?? renameError);
  }
}

function readObjectFile(file, { onCorrupt } = {}) {
  if (!existsSync(file)) return {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`[aqs] 读取 ${path.basename(file)} 失败：`, error?.message ?? error);
    return {};
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error('顶层不是 JSON 对象');
    return parsed;
  } catch (error) {
    onCorrupt?.(error);
    return {};
  }
}

/* ---------------------------------------------------------------- defaults -- */

export function defaultSettings() {
  return cloneSettings(DEFAULT_SETTINGS);
}

/** Repo-level `config.json` (server format) reduced to the settings subset. */
function readRepoConfig() {
  const raw = readObjectFile(path.join(ROOT, 'config.json'));
  const ai = isPlainObject(raw.ai) ? raw.ai : {};
  const patch = {};
  const aiPatch = {};
  if (typeof ai.baseUrl === 'string') aiPatch.baseUrl = ai.baseUrl;
  if (typeof ai.apiKey === 'string') aiPatch.apiKey = ai.apiKey;
  if (typeof ai.model === 'string') aiPatch.model = ai.model;
  if (typeof ai.visionModel === 'string') aiPatch.visionModel = ai.visionModel;
  if (ai.timeoutMs !== undefined) aiPatch.timeoutMs = ai.timeoutMs;
  if (ai.maxRetries !== undefined) aiPatch.maxRetries = ai.maxRetries;
  if (isPlainObject(ai.vision)) aiPatch.vision = cloneSettings(ai.vision);
  if (isPlainObject(ai.ensemble)) aiPatch.ensemble = cloneSettings(ai.ensemble);
  if (Object.keys(aiPatch).length > 0) patch.ai = aiPatch;
  return { patch, demo: raw.demo === true };
}

function readSettingsFile() {
  const file = settingsFile();
  return readObjectFile(file, { onCorrupt: (error) => backupCorrupt(file, error) });
}

function envOverrides(env) {
  const ai = {};
  const apiKey = env.AI_API_KEY ?? env.OPENAI_API_KEY;
  if (typeof apiKey === 'string' && apiKey.trim()) ai.apiKey = apiKey.trim();
  if (env.AI_BASE_URL) ai.baseUrl = env.AI_BASE_URL;
  if (env.AI_MODEL) ai.model = env.AI_MODEL;
  if (env.AI_VISION_MODEL) ai.visionModel = env.AI_VISION_MODEL;
  const vision = {};
  if (env.AI_VISION_BASE_URL) vision.baseUrl = env.AI_VISION_BASE_URL;
  if (env.AI_VISION_API_KEY) vision.apiKey = env.AI_VISION_API_KEY;
  if (env.AI_VISION_MODEL) vision.model = env.AI_VISION_MODEL;
  if (Object.keys(vision).length > 0) ai.vision = vision;
  if (env.AI_ENSEMBLE === '1' || env.AI_ENSEMBLE === 'true') ai.ensemble = { enabled: true };
  const timeout = Number(env.AI_TIMEOUT_MS);
  if (Number.isFinite(timeout) && timeout > 0) ai.timeoutMs = timeout;
  const retries = Number(env.AI_MAX_RETRIES);
  if (Number.isFinite(retries) && retries >= 0) ai.maxRetries = retries;
  const demo = env.AI_DEMO === '1' || env.AI_DEMO === 'true';
  if (demo) ai.apiKey = '';
  return { patch: Object.keys(ai).length > 0 ? { ai } : {}, demo };
}

/* -------------------------------------------------------------- sanitizing -- */

/** Coerces any JSON blob into a valid settings object (never throws). */
export function sanitizeSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const ai = isPlainObject(source.ai) ? source.ai : {};
  const auto = isPlainObject(source.auto) ? source.auto : {};
  const capture = isPlainObject(source.capture) ? source.capture : {};
  const overlay = isPlainObject(source.overlay) ? source.overlay : {};
  const hotkeys = isPlainObject(source.hotkeys) ? source.hotkeys : {};

  return {
    ai: {
      baseUrl: normalizeBaseUrl(ai.baseUrl, DEFAULT_SETTINGS.ai.baseUrl),
      apiKey: plainText(ai.apiKey, KEY_MAX).trim(),
      model: normalizeModel(ai.model, DEFAULT_SETTINGS.ai.model),
      visionModel: (() => {
        if (typeof ai.visionModel !== 'string') return DEFAULT_SETTINGS.ai.visionModel;
        const trimmed = ai.visionModel.trim();
        if (!trimmed) return '';
        return MODEL_PATTERN.test(trimmed) ? trimmed : DEFAULT_SETTINGS.ai.visionModel;
      })(),
      timeoutMs: clampInt(ai.timeoutMs, 1000, 300_000, DEFAULT_SETTINGS.ai.timeoutMs),
      maxRetries: clampInt(ai.maxRetries, 0, 5, DEFAULT_SETTINGS.ai.maxRetries),
      vision: sanitizeVision(ai.vision),
      ensemble: sanitizeEnsemble(ai.ensemble),
    },
    auto: {
      enabled: typeof auto.enabled === 'boolean' ? auto.enabled : DEFAULT_SETTINGS.auto.enabled,
      autoAnswer: typeof auto.autoAnswer === 'boolean' ? auto.autoAnswer : DEFAULT_SETTINGS.auto.autoAnswer,
      intervalMs: clampInt(auto.intervalMs, 800, 5000, DEFAULT_SETTINGS.auto.intervalMs),
      sensitivity: clampInt(auto.sensitivity, 1, 5, DEFAULT_SETTINGS.auto.sensitivity),
      crop: normalizeCrop(auto.crop),
    },
    style: STYLES.includes(source.style) ? source.style : DEFAULT_SETTINGS.style,
    capture: {
      sourceId: typeof capture.sourceId === 'string' && capture.sourceId.trim()
        ? plainText(capture.sourceId, 512)
        : null,
      sourceName: typeof capture.sourceName === 'string' && capture.sourceName.trim()
        ? plainText(capture.sourceName, 300)
        : null,
    },
    overlay: {
      width: clampInt(overlay.width, 320, 680, DEFAULT_SETTINGS.overlay.width),
      x: nullableInt(overlay.x, -100_000, 100_000),
      y: nullableInt(overlay.y, -100_000, 100_000),
      height: overlay.height === null || overlay.height === undefined
        ? null
        : clampInt(overlay.height, 420, 4000, null),
      collapsed: typeof overlay.collapsed === 'boolean' ? overlay.collapsed : DEFAULT_SETTINGS.overlay.collapsed,
      displayId: nullableInt(overlay.displayId, 0, Number.MAX_SAFE_INTEGER),
    },
    hotkeys: {
      toggle: normalizeAccelerator(hotkeys.toggle, DEFAULT_SETTINGS.hotkeys.toggle),
      scan: normalizeAccelerator(hotkeys.scan, DEFAULT_SETTINGS.hotkeys.scan),
      pause: normalizeAccelerator(hotkeys.pause, DEFAULT_SETTINGS.hotkeys.pause),
    },
  };
}

/* ---------------------------------------------------------------- validation -- */

function requireInt(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) !== value) {
    throw new SettingsError(`${label} 必须是整数`);
  }
  if (value < min || value > max) throw new SettingsError(`${label} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function requireText(value, label, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new SettingsError(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) throw new SettingsError(`${label} 不能为空`);
  if (value.length > max) throw new SettingsError(`${label} 不能超过 ${max} 个字符`);
  return trimmed;
}

function requireNumber(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SettingsError(`${label} 必须是数字`);
  }
  if (value < min || value > max) throw new SettingsError(`${label} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

/** Endpoint URL that may be blank ("inherit the global endpoint"). */
function optionalBaseUrl(value, label) {
  if (typeof value !== 'string') throw new SettingsError(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed) || trimmed.length > URL_MAX) {
    throw new SettingsError(`${label} 必须以 http:// 或 https:// 开头`);
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * `null` clears the stored key, `''` keeps it (docs/CONTRACT-ENSEMBLE.md §1).
 * The caller drops empty values so a blank form field never wipes a secret;
 * `null` survives re-validation so `saveSettings()` may validate twice.
 */
function validateSecretPatch(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new SettingsError(`${label} 必须是字符串`);
  if (value.length > KEY_MAX) throw new SettingsError(`${label} 不能超过 ${KEY_MAX} 个字符`);
  return plainText(value, KEY_MAX).trim();
}

function validateSlotSecret(value, label, out) {
  if (value === null) {
    out.apiKey = null;
    return;
  }
  const clean = validateSecretPatch(value, label);
  if (clean) out.apiKey = clean;
}

function validateVisionPatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('视觉识别设置必须是对象');
  const out = {};
  if (patch.baseUrl !== undefined) out.baseUrl = optionalBaseUrl(patch.baseUrl, '视觉端点 Base URL');
  if (patch.apiKey !== undefined) validateSlotSecret(patch.apiKey, '视觉端点 apiKey', out);
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string') throw new SettingsError('视觉模型必须是字符串');
    const value = patch.model.trim();
    if (value && !MODEL_PATTERN.test(value)) throw new SettingsError('视觉模型名称包含非法字符');
    out.model = value;
  }
  return out;
}

/** Slot name: blank falls back to the default label during sanitize. */
function optionalName(value, label) {
  if (typeof value !== 'string') throw new SettingsError(`${label} 必须是字符串`);
  if (value.length > NAME_MAX) throw new SettingsError(`${label} 不能超过 ${NAME_MAX} 个字符`);
  return plainText(value, NAME_MAX).trim();
}

function validateCandidatePatch(patch, index) {
  const label = `候选 ${index + 1}`;
  if (!isPlainObject(patch)) throw new SettingsError(`${label} 必须是对象`);
  const out = {};
  if (patch.name !== undefined) out.name = optionalName(patch.name, `${label} 名称`);
  if (patch.baseUrl !== undefined) out.baseUrl = optionalBaseUrl(patch.baseUrl, `${label} Base URL`);
  if (patch.apiKey !== undefined) validateSlotSecret(patch.apiKey, `${label} apiKey`, out);
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string') throw new SettingsError(`${label} 模型必须是字符串`);
    const value = patch.model.trim();
    if (value && !MODEL_PATTERN.test(value)) throw new SettingsError(`${label} 模型名称包含非法字符`);
    out.model = value;
  }
  if (patch.temperature !== undefined) {
    out.temperature = requireNumber(patch.temperature, `${label} 温度`, 0, 2);
  }
  return out;
}

function validateJudgePatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('评审模型必须是对象');
  const out = {};
  if (patch.name !== undefined) out.name = optionalName(patch.name, '评审名称');
  if (patch.baseUrl !== undefined) out.baseUrl = optionalBaseUrl(patch.baseUrl, '评审 Base URL');
  if (patch.apiKey !== undefined) validateSlotSecret(patch.apiKey, '评审 apiKey', out);
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string') throw new SettingsError('评审模型必须是字符串');
    const value = patch.model.trim();
    if (value && !MODEL_PATTERN.test(value)) throw new SettingsError('评审模型名称包含非法字符');
    out.model = value;
  }
  if (patch.temperature !== undefined) out.temperature = requireNumber(patch.temperature, '评审温度', 0, 2);
  return out;
}

function validateEnsemblePatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('交叉验证设置必须是对象');
  const out = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new SettingsError('交叉验证开关必须是布尔值');
    out.enabled = patch.enabled;
  }
  if (patch.candidates !== undefined) {
    if (!Array.isArray(patch.candidates)) throw new SettingsError('候选模型必须是数组');
    if (patch.candidates.length === 0) throw new SettingsError('候选模型至少保留 1 个槽位');
    if (patch.candidates.length > MAX_CANDIDATES) {
      throw new SettingsError(`候选模型最多 ${MAX_CANDIDATES} 个`);
    }
    out.candidates = patch.candidates.map((entry, index) => (
      entry === null || entry === undefined ? null : validateCandidatePatch(entry, index)
    ));
  }
  if (patch.judge !== undefined) out.judge = validateJudgePatch(patch.judge);
  return out;
}

function validateAiPatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('ai 必须是对象');
  const out = {};
  if (patch.baseUrl !== undefined) {
    const value = requireText(patch.baseUrl, 'API Base URL', URL_MAX);
    if (!/^https?:\/\/[^\s]+$/i.test(value)) throw new SettingsError('API Base URL 必须以 http:// 或 https:// 开头');
    out.baseUrl = value.replace(/\/+$/, '');
  }
  if (patch.apiKey !== undefined) validateSlotSecret(patch.apiKey, 'apiKey', out);
  if (patch.model !== undefined) {
    const value = requireText(patch.model, '文本模型', 160);
    if (!MODEL_PATTERN.test(value)) throw new SettingsError('文本模型名称包含非法字符');
    out.model = value;
  }
  if (patch.visionModel !== undefined) {
    if (typeof patch.visionModel !== 'string') throw new SettingsError('visionModel 必须是字符串');
    const value = patch.visionModel.trim();
    if (value && !MODEL_PATTERN.test(value)) throw new SettingsError('视觉模型名称包含非法字符');
    out.visionModel = value;
  }
  if (patch.vision !== undefined) out.vision = validateVisionPatch(patch.vision);
  if (patch.ensemble !== undefined) out.ensemble = validateEnsemblePatch(patch.ensemble);
  if (patch.timeoutMs !== undefined) out.timeoutMs = requireInt(patch.timeoutMs, '请求超时', 1000, 300_000);
  if (patch.maxRetries !== undefined) out.maxRetries = requireInt(patch.maxRetries, '重试次数', 0, 5);
  return out;
}

function validateAutoPatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('auto 必须是对象');
  const out = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new SettingsError('自动识别开关必须是布尔值');
    out.enabled = patch.enabled;
  }
  if (patch.autoAnswer !== undefined) {
    if (typeof patch.autoAnswer !== 'boolean') throw new SettingsError('自动解答开关必须是布尔值');
    out.autoAnswer = patch.autoAnswer;
  }
  if (patch.intervalMs !== undefined) out.intervalMs = requireInt(patch.intervalMs, '扫描间隔', 800, 5000);
  if (patch.sensitivity !== undefined) out.sensitivity = requireInt(patch.sensitivity, '灵敏度', 1, 5);
  if (patch.crop !== undefined) {
    if (patch.crop === null) out.crop = null;
    else {
      const crop = normalizeCrop(patch.crop);
      if (!crop) throw new SettingsError('裁剪区域必须是 {x,y,w,h}（0..1）且不能越界');
      out.crop = crop;
    }
  }
  return out;
}

function validateCapturePatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('capture 必须是对象');
  const out = {};
  if (patch.sourceId !== undefined) {
    if (patch.sourceId === null) out.sourceId = null;
    else out.sourceId = requireText(patch.sourceId, '窗口 ID', 512);
  }
  if (patch.sourceName !== undefined) {
    if (patch.sourceName === null) out.sourceName = null;
    else out.sourceName = requireText(patch.sourceName, '窗口名称', 300);
  }
  return out;
}

function validateOverlayPatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('overlay 必须是对象');
  const out = {};
  if (patch.width !== undefined) out.width = requireInt(patch.width, '窗口宽度', 320, 680);
  if (patch.height !== undefined) {
    out.height = patch.height === null ? null : requireInt(patch.height, '窗口高度', 420, 4000);
  }
  for (const key of ['x', 'y']) {
    if (patch[key] !== undefined) {
      out[key] = patch[key] === null ? null : requireInt(patch[key], '窗口坐标', -100_000, 100_000);
    }
  }
  if (patch.displayId !== undefined) {
    out.displayId = patch.displayId === null
      ? null
      : requireInt(patch.displayId, '显示器 ID', 0, Number.MAX_SAFE_INTEGER);
  }
  if (patch.collapsed !== undefined) {
    if (typeof patch.collapsed !== 'boolean') throw new SettingsError('折叠状态必须是布尔值');
    out.collapsed = patch.collapsed;
  }
  return out;
}

function validateHotkeysPatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('hotkeys 必须是对象');
  const out = {};
  for (const key of ['toggle', 'scan', 'pause']) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) {
      out[key] = null;
      continue;
    }
    const value = requireText(patch[key], `快捷键 ${key}`, 64);
    if (!HOTKEY_PATTERN.test(value) || !value.includes('+')) {
      throw new SettingsError(`快捷键 ${key} 格式不正确，例如 CommandOrControl+Shift+Q`);
    }
    out[key] = value;
  }
  return out;
}

/** Throws `SettingsError` (code BAD_REQUEST) when any provided field is invalid. */
export function validatePatch(patch) {
  if (!isPlainObject(patch)) throw new SettingsError('设置补丁必须是对象');
  const out = {};
  if (patch.ai !== undefined) out.ai = validateAiPatch(patch.ai);
  if (patch.auto !== undefined) out.auto = validateAutoPatch(patch.auto);
  if (patch.style !== undefined) {
    if (!STYLES.includes(patch.style)) throw new SettingsError(`风格必须是 ${STYLES.join(' / ')} 之一`);
    out.style = patch.style;
  }
  if (patch.capture !== undefined) out.capture = validateCapturePatch(patch.capture);
  if (patch.overlay !== undefined) out.overlay = validateOverlayPatch(patch.overlay);
  if (patch.hotkeys !== undefined) out.hotkeys = validateHotkeysPatch(patch.hotkeys);
  return out;
}

/* -------------------------------------------------------------- load / save -- */

let cache = null;
let forcedDemo = false;

function composeSettings() {
  const repo = readRepoConfig();
  const env = envOverrides(process.env);
  const file = readSettingsFile();

  let merged = deepMerge(defaultSettings(), repo.patch);
  merged = deepMerge(merged, file);
  merged = deepMerge(merged, env.patch);

  forcedDemo = repo.demo || env.demo;
  return sanitizeSettings(merged);
}

/** Reads settings once, then serves the cached (already sanitized) copy. */
export function loadSettings() {
  if (!cache) cache = composeSettings();
  return cloneSettings(cache);
}

/** Re-reads every layer from disk; used by tests and after external edits. */
export function reloadSettings() {
  cache = null;
  return loadSettings();
}

function atomicWrite(file, text) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file may already be gone */
    }
    throw error;
  }
}

/**
 * Deep-merges a validated patch, writes it atomically and returns the new settings.
 * Never persists the resolved env/config layers — only the user's own overrides.
 */
export function saveSettings(patch) {
  const clean = validatePatch(patch ?? {});
  const current = loadSettings();
  const next = sanitizeSettings(deepMerge(current, clean));
  atomicWrite(settingsFile(), `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
  return cloneSettings(next);
}

/** Persists an already-valid settings object (used when rolling back a failed write). */
export function replaceSettings(next) {
  const clean = sanitizeSettings(next);
  atomicWrite(settingsFile(), `${JSON.stringify(clean, null, 2)}\n`);
  cache = clean;
  return cloneSettings(clean);
}

/** Removes stale temp files left behind by an interrupted atomic write. */
export function cleanupTempFiles() {
  const file = settingsFile();
  try {
    const dir = path.dirname(file);
    const prefix = `.${path.basename(file)}.`;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(prefix) && entry.endsWith('.tmp')) rmSync(path.join(dir, entry), { force: true });
    }
  } catch {
    /* best effort only */
  }
}

/* ------------------------------------------------------------------- state -- */

/** `own` = stored on this slot, `inherited` = falls back to ai.apiKey, `none` = demo. */
function keySource(own, globalKey) {
  if (own) return 'own';
  if (globalKey) return 'inherited';
  return 'none';
}

/** Renderer-facing settings view — the plaintext API keys never appear here. */
export function getState(settings = loadSettings()) {
  const globalKey = settings.ai.apiKey;
  const vision = settings.ai.vision ?? sanitizeVision(undefined);
  const ensemble = settings.ai.ensemble ?? sanitizeEnsemble(undefined);
  return {
    ai: {
      baseUrl: settings.ai.baseUrl,
      model: settings.ai.model,
      visionModel: settings.ai.visionModel,
      hasApiKey: globalKey.length > 0,
      vision: {
        baseUrl: vision.baseUrl,
        model: vision.model,
        hasApiKey: Boolean(vision.apiKey || globalKey),
        keySource: keySource(vision.apiKey, globalKey),
      },
      ensemble: {
        enabled: ensemble.enabled,
        candidates: ensemble.candidates.map((candidate) => ({
          name: candidate.name,
          baseUrl: candidate.baseUrl,
          model: candidate.model,
          temperature: candidate.temperature,
          hasApiKey: Boolean(candidate.apiKey || globalKey),
          keySource: keySource(candidate.apiKey, globalKey),
        })),
        judge: {
          name: ensemble.judge.name,
          baseUrl: ensemble.judge.baseUrl,
          model: ensemble.judge.model,
          temperature: ensemble.judge.temperature,
          hasApiKey: Boolean(ensemble.judge.apiKey || globalKey),
          keySource: keySource(ensemble.judge.apiKey, globalKey),
        },
      },
    },
    auto: cloneSettings(settings.auto),
    style: settings.style,
    capture: cloneSettings(settings.capture),
    overlay: cloneSettings(settings.overlay),
    hotkeys: cloneSettings(settings.hotkeys),
  };
}

export function isDemoForced() {
  return forcedDemo;
}

/** Demo only when no key exists anywhere: global, vision, candidates or judge. */
export function isDemo(settings = loadSettings()) {
  if (forcedDemo) return true;
  if (settings.ai.apiKey) return false;
  if (settings.ai.vision?.apiKey) return false;
  if (settings.ai.ensemble?.judge?.apiKey) return false;
  return !settings.ai.ensemble?.candidates?.some((candidate) => candidate.apiKey);
}

/* --------------------------------------------------------------- endpoints -- */

/**
 * Ensemble block for the engine config: every slot with inheritance applied.
 * `model` stays empty for unconfigured candidates; the judge inherits ai.model.
 */
export function resolveEnsemble(settings) {
  const ai = settings.ai;
  const ensemble = ai.ensemble ?? sanitizeEnsemble(undefined);
  const resolve = (slot) => ({
    name: slot.name,
    baseUrl: slot.baseUrl || ai.baseUrl,
    apiKey: slot.apiKey || ai.apiKey,
    model: slot.model,
    temperature: slot.temperature,
  });
  const judge = resolve(ensemble.judge);
  if (!judge.model) judge.model = ai.model;
  return {
    enabled: ensemble.enabled,
    candidates: ensemble.candidates.map(resolve),
    judge,
  };
}

/** Slots that actually take part: a model plus a resolvable endpoint. */
export function activeCandidates(settings) {
  return resolveEnsemble(settings).candidates.filter((candidate) => candidate.model && candidate.baseUrl);
}

/** OCR endpoint: blank fields inherit the global ai.* values. */
export function resolveVision(settings) {
  const ai = settings.ai;
  const vision = ai.vision ?? sanitizeVision(undefined);
  return {
    baseUrl: vision.baseUrl || ai.baseUrl,
    apiKey: vision.apiKey || ai.apiKey,
    model: vision.model || ai.visionModel || ai.model,
  };
}
