import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIN_ENSEMBLE_SLOTS = 3;
const MAX_ENSEMBLE_SLOTS = 5;

const DEFAULT_CANDIDATES = [
  { name: '模型 A', temperature: 0.3 },
  { name: '模型 B', temperature: 0.6 },
  { name: '模型 C', temperature: 0.9 },
];

const DEFAULT_JUDGE = { name: '评审', temperature: 0.1 };

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  demo: false,
  ai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    visionModel: '',
    timeoutMs: 60_000,
    maxRetries: 1,
    headers: {},
    vision: { baseUrl: '', apiKey: '', model: '' },
    ensemble: {
      enabled: false,
      candidates: DEFAULT_CANDIDATES.map((candidate) => ({
        name: candidate.name,
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: candidate.temperature,
      })),
      judge: { name: DEFAULT_JUDGE.name, baseUrl: '', apiKey: '', model: '', temperature: DEFAULT_JUDGE.temperature },
    },
  },
  limits: {
    maxBodyBytes: 12 * 1024 * 1024,
    maxImageBytes: 8 * 1024 * 1024,
    maxQuestionChars: 8000,
    maxOptions: 10,
    ratePerMinute: 40,
    answerCacheTtlMs: 10 * 60 * 1000,
    maxCacheEntries: 200,
  },
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envNumber(env, key, fallback) {
  return env[key] === undefined ? fallback : num(env[key], fallback);
}

/** `true` for the usual on flags; anything else is treated as off. */
function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return fallback;
}

function cleanText(value, maxLength) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** Base URLs keep no trailing slash; anything without http(s):// is unusable. */
function cleanBaseUrl(value) {
  const text = cleanText(value, 512).replace(/\/+$/, '');
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : '';
}

function cleanTemperature(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0, n));
}

function sanitizeCandidate(raw, index) {
  const slot = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const preset = DEFAULT_CANDIDATES[index] ?? {
    name: `模型 ${String.fromCharCode(65 + (index % 26))}`,
    temperature: 0.3,
  };
  return {
    name: cleanText(slot.name, 32) || preset.name,
    baseUrl: cleanBaseUrl(slot.baseUrl),
    apiKey: cleanText(slot.apiKey, 512),
    model: cleanText(slot.model, 128),
    temperature: cleanTemperature(slot.temperature, preset.temperature),
  };
}

/** Always exposes at least three UI slots and never more than five. */
function sanitizeCandidates(raw) {
  const source = Array.isArray(raw) ? raw.slice(0, MAX_ENSEMBLE_SLOTS) : [];
  const count = Math.max(MIN_ENSEMBLE_SLOTS, source.length);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    candidates.push(sanitizeCandidate(source[index], index));
  }
  return candidates;
}

function sanitizeJudge(raw) {
  const slot = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    name: cleanText(slot.name, 32) || DEFAULT_JUDGE.name,
    baseUrl: cleanBaseUrl(slot.baseUrl),
    apiKey: cleanText(slot.apiKey, 512),
    model: cleanText(slot.model, 128),
    temperature: cleanTemperature(slot.temperature, DEFAULT_JUDGE.temperature),
  };
}

function readFileConfig(root) {
  const file = path.join(root, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config.json must contain a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid config.json: ${error.message}`);
  }
}

/**
 * Resolution order: environment variables > config.json > built-in defaults.
 * Demo mode is entered when no API key is configured anywhere (global, vision or
 * any ensemble slot), or when AI_DEMO=1 / demo:true.
 */
export function loadConfig(env = process.env, root = ROOT) {
  const file = readFileConfig(root);
  const fileAi = file.ai ?? {};
  const fileVision = fileAi.vision && typeof fileAi.vision === 'object' ? fileAi.vision : {};
  const fileEnsemble = fileAi.ensemble && typeof fileAi.ensemble === 'object' ? fileAi.ensemble : {};
  const fileLimits = file.limits ?? {};

  const apiKey = env.AI_API_KEY ?? env.OPENAI_API_KEY ?? fileAi.apiKey ?? DEFAULTS.ai.apiKey;
  const visionApiKey = env.AI_VISION_API_KEY ?? fileVision.apiKey ?? DEFAULTS.ai.vision.apiKey;
  const candidates = sanitizeCandidates(fileEnsemble.candidates);
  const judge = sanitizeJudge(fileEnsemble.judge);
  const hasEnsembleKey = candidates.some((candidate) => candidate.apiKey !== '');
  const forceDemo = file.demo === true || flag(env.AI_DEMO, false);

  const config = {
    root,
    host: env.HOST ?? file.host ?? DEFAULTS.host,
    port: envNumber(env, 'PORT', num(file.port, DEFAULTS.port)),
    demo: forceDemo || (!apiKey && !visionApiKey && !hasEnsembleKey),
    ai: {
      baseUrl: (env.AI_BASE_URL ?? fileAi.baseUrl ?? DEFAULTS.ai.baseUrl).replace(/\/+$/, ''),
      apiKey,
      model: env.AI_MODEL ?? fileAi.model ?? DEFAULTS.ai.model,
      visionModel: env.AI_VISION_MODEL ?? fileAi.visionModel ?? env.AI_MODEL ?? fileAi.model ?? DEFAULTS.ai.model,
      timeoutMs: envNumber(env, 'AI_TIMEOUT_MS', num(fileAi.timeoutMs, DEFAULTS.ai.timeoutMs)),
      maxRetries: envNumber(env, 'AI_MAX_RETRIES', num(fileAi.maxRetries, DEFAULTS.ai.maxRetries)),
      headers: { ...DEFAULTS.ai.headers, ...(fileAi.headers ?? {}) },
      vision: {
        baseUrl: cleanBaseUrl(env.AI_VISION_BASE_URL ?? fileVision.baseUrl),
        apiKey: cleanText(visionApiKey, 512),
        model: cleanText(env.AI_VISION_MODEL ?? fileVision.model, 128),
      },
      ensemble: {
        enabled: flag(env.AI_ENSEMBLE, fileEnsemble.enabled === true),
        candidates,
        judge,
      },
    },
    limits: {
      maxBodyBytes: envNumber(env, 'MAX_BODY_BYTES', num(fileLimits.maxBodyBytes, DEFAULTS.limits.maxBodyBytes)),
      maxImageBytes: envNumber(env, 'MAX_IMAGE_BYTES', num(fileLimits.maxImageBytes, DEFAULTS.limits.maxImageBytes)),
      maxQuestionChars: envNumber(env, 'MAX_QUESTION_CHARS', num(fileLimits.maxQuestionChars, DEFAULTS.limits.maxQuestionChars)),
      maxOptions: num(fileLimits.maxOptions, DEFAULTS.limits.maxOptions),
      ratePerMinute: envNumber(env, 'RATE_PER_MINUTE', num(fileLimits.ratePerMinute, DEFAULTS.limits.ratePerMinute)),
      answerCacheTtlMs: num(fileLimits.answerCacheTtlMs, DEFAULTS.limits.answerCacheTtlMs),
      maxCacheEntries: num(fileLimits.maxCacheEntries, DEFAULTS.limits.maxCacheEntries),
    },
  };

  if (config.demo) config.ai.apiKey = '';
  return config;
}
