/**
 * Desktop overlay controller.
 *
 * Runs in the sandboxed renderer with no Node access: every privileged action
 * goes through `window.aqs` (preload bridge) and every call is wrapped so a
 * failure turns into an inline Chinese message with its error code.
 *
 * Responsibilities:
 *  - keep the panel/drawers/picker in sync with the main-process state
 *  - capture a chosen desktop window, detect question changes frame by frame
 *  - recognize through `aqs.recognize`, stream answers through `aqs.answer`
 *  - local history (localStorage) and settings/crop editing
 */

import { renderMarkdown, loadKatex } from '../../web/render.js';
import { catalogForBaseUrl } from '../model-catalog.js';
import {
  startCapture,
  stopCapture,
  grabFrame,
  drawFrame,
  frameHash,
  hamming,
  edgeDensity,
  CaptureError,
} from './capture.js';

const HISTORY_KEY = 'aqs.desktop.history.v1';
const HISTORY_LIMIT = 20;

const MIN_INTERVAL = 800;
const MAX_INTERVAL = 5000;
const DEFAULT_INTERVAL = 1500;
const SENSITIVITY_BITS = { 1: 6, 2: 10, 3: 14, 4: 18, 5: 22 };
const STABLE_BITS = 2;
const MIN_EDGE_DENSITY = 0.02;
const DETECT_MAX_WIDTH = 640;
const FRAME_MAX_WIDTH = 1600;
const FRAME_QUALITY = 0.82;
const SCHEDULER_MS = 250;

const STYLE_LABELS = { concise: '简洁', detailed: '详细', step: '逐步' };
const TYPE_LABELS = { choice: '选择题', blank: '填空题', short: '解答题', unknown: '题型未知' };
const STATUS_LABELS = { error: '未连接', paused: '已暂停', busy: '处理中', capturing: '采集中', idle: '待命' };

/** CONTRACT-ENSEMBLE §5 — UI copies of the settings presets (baseUrl + model placeholder). */
const AI_PRESETS = {
  commandcode: {
    label: 'Command Code 订阅',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    visionModel: 'deepseek/deepseek-v4.1-flash',
    candidates: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro', 'google/gemini-3.8-flash'],
    judge: 'deepseek/deepseek-v4-pro',
  },
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    visionModel: 'deepseek-flash',
    candidates: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-flash'],
    judge: 'deepseek-v4-pro',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
    candidates: ['gpt-4o-mini', 'gpt-4o-mini', 'gpt-4o-mini'],
    judge: 'gpt-4o-mini',
  },
};

const ENSEMBLE_SLOTS = 3;
const DEFAULT_CANDIDATES = [
  { name: '模型 A', temperature: 0.3 },
  { name: '模型 B', temperature: 0.6 },
  { name: '模型 C', temperature: 0.9 },
];
const DEFAULT_JUDGE = { name: '评审', temperature: 0.1 };
const KEY_SOURCE_TEXT = { own: '已保存', inherited: '继承全局', none: '未配置' };
const KEY_SOURCE_HINT = {
  own: '已保存密钥（留空保持不变）',
  inherited: '继承全局密钥（留空保持不变）',
  none: '未配置（留空表示不配置）',
};
const MODEL_PATTERN = /^[A-Za-z0-9._:@/+-]{1,160}$/;

const ERROR_TEXT = {
  BAD_REQUEST: '请求参数不合法，请检查题目内容或窗口选择后重试。',
  UNSUPPORTED: '该操作或图片格式不受支持。',
  PAYLOAD_TOO_LARGE: '截图或题目内容超出大小限制，请缩小识别区域后重试。',
  RATE_LIMITED: '请求过于频繁，请稍候片刻再试。',
  UPSTREAM_ERROR: '模型服务暂时不可用，请稍后重试。',
  TIMEOUT: '模型响应超时，请稍后重试。',
  ABORTED: '本次生成已取消。',
  INTERNAL: '应用内部错误，请重启桌面应用后再试。',
  EMPTY_QUESTION: '题目为空，请先识别或手动输入题目。',
  RECOGNIZE_FAILED: '没有识别出题目，请调整识别区域后重试。',
  NO_SOURCE: '还没有选择要采集的窗口，请先选择浏览器窗口。',
  SOURCE_CLOSED: '目标窗口已关闭或不可用，请重新选择窗口。',
  SOURCE_NOT_FOUND: '目标窗口已不可用，请刷新列表后重新选择。',
  SOURCE_LIST_FAILED: '读取窗口列表失败，请稍后重试。',
  CAPTURE_DENIED: '屏幕录制权限被拒绝，请在系统设置中授权后重试。',
  CAPTURE_UNSUPPORTED: '当前环境不支持窗口采集，请通过桌面应用启动。',
  CAPTURE_FAILED: '窗口采集失败，请重新选择窗口。',
  FRAME_NOT_READY: '画面尚未就绪，请稍候再试。',
  NO_BRIDGE: '未检测到桌面接口，请通过桌面应用启动。',
  SETTINGS_INVALID: '设置内容不合法，请检查后重试。',
};

const $ = (id) => document.getElementById(id);

const els = {
  app: $('app'),
  panel: $('panel'),
  scroller: $('scroller'),
  pill: $('collapse-pill'),
  pillDot: $('pill-dot'),
  pillHint: $('pill-hint'),

  statusDot: $('status-dot'),
  statusText: $('status-text'),
  modeBadge: $('mode-badge'),
  collapse: $('btn-collapse'),
  settingsBtn: $('btn-settings'),
  historyBtn: $('btn-history'),

  error: $('inline-error'),
  errorCode: $('inline-error-code'),
  errorText: $('inline-error-text'),
  errorClose: $('btn-dismiss-error'),

  permissionBanner: $('permission-banner'),
  bannerPermission: $('btn-banner-permission'),

  sourceName: $('source-name'),
  sourceHint: $('source-hint'),
  pickSource: $('btn-pick-source'),
  scan: $('btn-scan'),
  clearSource: $('btn-clear-source'),

  questionCard: $('question-card'),
  questionText: $('question-text'),
  questionOptions: $('question-options'),
  questionSubject: $('question-subject'),
  questionType: $('question-type'),
  questionConfidence: $('question-confidence'),
  toggleQuestion: $('btn-toggle-question'),
  saveQuestion: $('btn-save-question'),
  rerecognize: $('btn-rerecognize'),
  submit: $('btn-submit'),

  answerMd: $('answer-md'),
  answerEmpty: $('answer-empty'),
  answerChars: $('answer-chars'),
  answerCached: $('answer-cached'),
  answerDuration: $('answer-duration'),
  answerModel: $('answer-model'),
  copy: $('btn-copy'),
  stop: $('btn-stop'),
  styleButtons: Array.from(document.querySelectorAll('[data-style]')),

  autoEnabled: $('auto-enabled'),
  autoAnswer: $('auto-answer'),
  pause: $('btn-pause'),
  sensitivity: $('sensitivity'),
  sensitivityLabel: $('sensitivity-label'),
  nextScan: $('next-scan'),
  ensembleToggle: $('ensemble-toggle'),
  ensembleSwitch: $('ensemble-switch'),
  ensembleCost: $('ensemble-cost'),
  ensemblePanel: $('ensemble-panel'),
  ensembleSummary: $('ensemble-summary'),
  ensembleJudge: $('ensemble-judge'),
  candidateList: $('candidate-list'),

  historyDrawer: $('history-drawer'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  clearHistory: $('btn-clear-history'),
  closeHistory: $('btn-close-history'),

  settingsDrawer: $('settings-drawer'),
  settingsForm: $('settings-form'),
  closeSettings: $('btn-close-settings'),
  settingsError: $('settings-error'),
  setBaseUrl: $('set-base-url'),
  setApiKey: $('set-api-key'),
  setKeyHint: $('set-key-hint'),
  testConnection: $('btn-test-connection'),
  connStatus: $('conn-status'),
  connResults: $('conn-results'),
  connResultsSummary: $('conn-results-summary'),
  connResultsList: $('conn-results-list'),
  setAutoEnabled: $('set-auto-enabled'),
  setAutoAnswer: $('set-auto-answer'),
  visionBase: $('vision-base'),
  visionKey: $('vision-key'),
  visionKeyHint: $('vision-key-hint'),
  setEnsembleEnabled: $('set-ensemble-enabled'),
  ensembleSlots: $('ensemble-slots'),
  ensembleClear: $('btn-ensemble-clear'),
  presetButtons: Array.from(document.querySelectorAll('[data-preset]')),
  setInterval: $('set-interval'),
  setSensitivity: $('set-sensitivity'),
  setSensitivityLabel: $('set-sensitivity-label'),
  cropStage: $('crop-stage'),
  cropImage: $('crop-image'),
  cropEmpty: $('crop-empty'),
  cropRect: $('crop-rect'),
  cropValue: $('crop-value'),
  cropReset: $('btn-crop-reset'),
  permissionRow: $('permission-row'),
  permissionStatus: $('permission-status'),
  screenPermission: $('btn-screen-permission'),

  picker: $('source-picker'),
  pickerList: $('source-list'),
  pickerStatus: $('source-status'),
  pickerEmpty: $('source-empty'),
  pickerPermission: $('btn-picker-permission'),
  refreshSources: $('btn-refresh-sources'),
  closePicker: $('btn-close-picker'),
  cancelPicker: $('btn-cancel-picker'),

  toast: $('toast'),
  video: $('capture-video'),
  detectCanvas: $('detect-canvas'),
  grabCanvas: $('grab-canvas'),
  noBridge: $('no-bridge'),
};

class UiError extends Error {
  constructor(code, message, extra = {}) {
    super(message || ERROR_TEXT[code] || code || '操作失败');
    this.name = 'UiError';
    this.code = code || 'INTERNAL';
    Object.assign(this, extra);
  }
}

function defaultSettings() {
  return {
    ai: {
      baseUrl: '',
      model: '',
      visionModel: '',
      hasApiKey: false,
      vision: { baseUrl: '', model: '', hasApiKey: false, keySource: 'none' },
      ensemble: {
        enabled: false,
        candidates: DEFAULT_CANDIDATES.map((slot) => ({
          name: slot.name,
          baseUrl: '',
          model: '',
          temperature: slot.temperature,
          hasApiKey: false,
          keySource: 'none',
        })),
        judge: {
          name: DEFAULT_JUDGE.name,
          baseUrl: '',
          model: '',
          temperature: DEFAULT_JUDGE.temperature,
          hasApiKey: false,
          keySource: 'none',
        },
      },
    },
    auto: { enabled: true, autoAnswer: true, intervalMs: DEFAULT_INTERVAL, sensitivity: 3, crop: null },
    style: 'concise',
    capture: { sourceId: null, sourceName: '' },
    overlay: { collapsed: false, width: 420 },
    hotkeys: {
      toggle: 'CommandOrControl+Shift+Q',
      scan: 'CommandOrControl+Shift+S',
      pause: 'CommandOrControl+Shift+P',
    },
  };
}

const state = {
  ready: false,
  app: { version: '', platform: '', demo: true },
  engine: { mode: 'demo', models: { chat: '', visionModel: '' }, limits: {} },
  settings: defaultSettings(),
  runtime: { paused: false, busy: false, capturing: false, sourceName: '', permission: 'unknown' },
  screenPermission: 'unknown',

  stream: null,
  sourceId: null,
  capturePending: false,
  captureToken: 0,
  lastFrame: '',
  lastFrameSize: null,

  hashes: [],
  baselineHash: null,
  detecting: false,
  cooldownUntil: 0,
  nextScanAt: 0,
  scheduler: 0,
  lastDetectError: { code: '', at: 0 },

  recognizing: false,
  streaming: false,
  startingAnswer: false,
  requestId: null,
  answerText: '',
  answerMeta: { cached: false, durationMs: 0, model: '', usage: null },
  answerRenderQueued: false,
  stickToBottom: true,
  ensemble: {
    active: false,
    done: false,
    fallback: false,
    judge: null,
    candidates: [],
    expanded: new Set(),
  },

  question: { text: '', options: [], subject: '', questionType: 'unknown', confidence: 0, model: '' },
  questionDirty: false,
  lastQuestionKey: '',
  questionCollapsed: false,

  history: [],
  historyAdopted: false,
  historyClearArmedAt: 0,

  collapsed: false,
  drawer: '',
  cropDraft: null,
  cropDrag: null,

  // 连接自检：seq 用来丢弃过期响应，timer 是本轮自动测试的 debounce 句柄。
  probe: { seq: 0, timer: 0, hasResult: false },

  toastTimer: 0,
  toastHideTimer: 0,
  // 展开自愈：透明无边框窗口可能忽略 resize，展开后按实际 window 尺寸复核并重试。
  expandRetryTimer: 0,
  expandRetries: 0,
  expandGaveUp: false,
  offEvent: null,
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function sessionInterval() {
  return clamp(state.settings.auto.intervalMs, MIN_INTERVAL, MAX_INTERVAL);
}

function sensitivityLevel() {
  return clamp(Math.round(state.settings.auto.sensitivity) || 3, 1, 5);
}

function sensitivityBits() {
  return SENSITIVITY_BITS[sensitivityLevel()] ?? SENSITIVITY_BITS[3];
}

function cooldownMs() {
  return Math.max(4000, sessionInterval() * 2);
}

function isPaused() {
  return Boolean(state.runtime.paused);
}

function isAutoOn() {
  return state.settings.auto.enabled !== false;
}

function isAutoAnswer() {
  return state.settings.auto.autoAnswer !== false;
}

function isBusy() {
  return Boolean(state.recognizing || state.streaming || state.runtime.busy);
}

function currentStyle() {
  const style = state.settings.style;
  return STYLE_LABELS[style] ? style : 'concise';
}

function currentCrop() {
  return normalizeCropObject(state.settings.auto.crop);
}

function normalizeCropObject(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const x = Number(crop.x);
  const y = Number(crop.y);
  const w = Number(crop.w);
  const h = Number(crop.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0.01 || h <= 0.01) return null;
  const left = clamp(x, 0, 1);
  const top = clamp(y, 0, 1);
  return {
    x: left,
    y: top,
    w: clamp(w, 0.01, 1 - left),
    h: clamp(h, 0.01, 1 - top),
  };
}

function currentSourceName() {
  return state.settings.capture.sourceName || state.runtime.sourceName || '目标窗口';
}

function questionKey(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function snippet(value, length) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeSensitivity(level) {
  const value = clamp(Math.round(level) || 3, 1, 5);
  return `${value} 级 · ${SENSITIVITY_BITS[value]} bit`;
}

function hotkeyLabel(accelerator) {
  const parts = String(accelerator || '')
    .split('+')
    .filter(Boolean);
  if (!parts.length) return '无快捷键';
  return parts
    .map((part) => {
      if (part === 'CommandOrControl' || part === 'CmdOrCtrl') return state.app.platform === 'darwin' ? 'Cmd' : 'Ctrl';
      if (part === 'Command') return 'Cmd';
      if (part === 'Control') return 'Ctrl';
      return part;
    })
    .join('+\u200B');
}

function hasQuestionText() {
  return Boolean((els.questionText.value || state.question.text || '').trim());
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option, index) => {
      if (!option) return null;
      if (typeof option === 'string') {
        return { label: String.fromCharCode(65 + index), text: option };
      }
      const label = String(option.label ?? String.fromCharCode(65 + index)).trim();
      const text = String(option.text ?? '').trim();
      if (!text) return null;
      return { label, text };
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* bridge + error plumbing                                             */
/* ------------------------------------------------------------------ */

function extractCode(error) {
  if (!error) return '';
  const candidates = [error.code, error.data && error.data.code, error.detail && error.detail.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(candidate)) return candidate;
  }
  const message = String(error.message || '');
  const match = /(?:code["']?\s*[:=]\s*["']?)([A-Z][A-Z0-9_]{2,})/.exec(message);
  if (match) return match[1];
  // IPC errors lose custom properties; the code often survives as a token.
  const known = /\b(BAD_REQUEST|UNSUPPORTED|PAYLOAD_TOO_LARGE|RATE_LIMITED|UPSTREAM_ERROR|TIMEOUT|ABORTED|INTERNAL|NO_SOURCE|NO_BRIDGE|CAPTURE_DENIED|CAPTURE_UNSUPPORTED|CAPTURE_FAILED|SOURCE_CLOSED|FRAME_NOT_READY|EMPTY_QUESTION|SETTINGS_INVALID)\b/.exec(
    message,
  );
  if (known) return known[1];
  if (error.name === 'AbortError') return 'ABORTED';
  return '';
}

function toUiError(error, operation = '') {
  if (error instanceof UiError) return error;
  if (error instanceof CaptureError) return new UiError(error.code, error.message, { operation, cause: error });
  if (!error) return new UiError('INTERNAL', '操作失败，请重试。', { operation });
  const code = extractCode(error) || 'INTERNAL';
  const message = String(error.message || error.reason || '').trim();
  return new UiError(code, message || '操作失败，请重试。', { operation, cause: error });
}

function describeError(code, error) {
  const known = ERROR_TEXT[code];
  if (known) return known;
  const message = String((error && error.message) || '').trim();
  if (/[\u4e00-\u9fa5]/.test(message)) return message;
  if (message) return `操作失败（${code}）：${message}`;
  return '操作失败，请重试。';
}

async function call(method, ...args) {
  const api = window.aqs;
  if (!api || typeof api.getState !== 'function') {
    throw new UiError('NO_BRIDGE', '未检测到桌面接口，请通过桌面应用启动。');
  }
  const fn = api[method];
  if (typeof fn !== 'function') {
    throw new UiError('NO_BRIDGE', `桌面接口缺少 ${method}() 方法。`);
  }
  try {
    return await fn.apply(api, args);
  } catch (error) {
    throw toUiError(error, method);
  }
}

function showError(error) {
  const info = toUiError(error);
  const code = info.code || 'INTERNAL';
  els.errorCode.textContent = code;
  els.errorText.textContent = describeError(code, info);
  els.error.dataset.level = code === 'ABORTED' ? 'info' : 'error';
  els.error.hidden = false;
}

function clearError() {
  els.error.hidden = true;
}

function reportUnexpected(error) {
  if (!error) return;
  if (error instanceof UiError && error.code === 'ABORTED') return;
  showError(error);
}

function showToast(message, level = 'info', timeout = 3200) {
  if (!message) return;
  clearTimeout(state.toastTimer);
  clearTimeout(state.toastHideTimer);
  els.toast.textContent = message;
  els.toast.dataset.level = level;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('is-visible'));
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    state.toastHideTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 220);
  }, timeout);
}

/* ------------------------------------------------------------------ */
/* state application + rendering                                       */
/* ------------------------------------------------------------------ */

function normalizeTemperature(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(2, Math.max(0, number));
}

/** Masked key indicator: main never sends plaintext keys, only `keySource`/`hasApiKey`. */
function normalizeKeyInfo(entry) {
  const source = entry && typeof entry.keySource === 'string' ? entry.keySource : '';
  if (source === 'own' || source === 'inherited' || source === 'none') {
    return { hasApiKey: Boolean(entry.hasApiKey ?? source !== 'none'), keySource: source };
  }
  const hasApiKey = Boolean(entry && (entry.hasApiKey ?? entry.hasKey));
  return { hasApiKey, keySource: hasApiKey ? 'own' : 'none' };
}

function normalizeCandidate(raw, index) {
  const slot = DEFAULT_CANDIDATES[index] || { name: `模型 ${index + 1}`, temperature: 0.3 };
  const entry = raw && typeof raw === 'object' ? raw : {};
  const key = normalizeKeyInfo(entry);
  return {
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 40) : slot.name,
    baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
    model: typeof entry.model === 'string' ? entry.model.trim() : '',
    temperature: normalizeTemperature(entry.temperature, slot.temperature),
    hasApiKey: key.hasApiKey,
    keySource: key.keySource,
  };
}

function normalizeJudge(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const key = normalizeKeyInfo(entry);
  return {
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 40) : DEFAULT_JUDGE.name,
    baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
    model: typeof entry.model === 'string' ? entry.model.trim() : '',
    temperature: normalizeTemperature(entry.temperature, DEFAULT_JUDGE.temperature),
    hasApiKey: key.hasApiKey,
    keySource: key.keySource,
  };
}

function normalizeEnsemble(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(entry.candidates) ? entry.candidates.slice(0, ENSEMBLE_SLOTS) : [];
  return {
    enabled: Boolean(entry.enabled),
    candidates: Array.from({ length: ENSEMBLE_SLOTS }, (_, index) => normalizeCandidate(list[index], index)),
    judge: normalizeJudge(entry.judge),
  };
}

function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const ai = raw.ai && typeof raw.ai === 'object' ? raw.ai : {};
  const auto = raw.auto && typeof raw.auto === 'object' ? raw.auto : {};
  const capture = raw.capture && typeof raw.capture === 'object' ? raw.capture : {};
  const overlay = raw.overlay && typeof raw.overlay === 'object' ? raw.overlay : {};
  const hotkeys = raw.hotkeys && typeof raw.hotkeys === 'object' ? raw.hotkeys : {};
  const vision = ai.vision && typeof ai.vision === 'object' ? ai.vision : {};
  const visionKey = normalizeKeyInfo(vision);

  return {
    ai: {
      baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl : '',
      model: typeof ai.model === 'string' ? ai.model : '',
      visionModel: typeof ai.visionModel === 'string' ? ai.visionModel : '',
      hasApiKey: Boolean(ai.hasApiKey ?? ai.apiKey),
      vision: {
        baseUrl: typeof vision.baseUrl === 'string' ? vision.baseUrl : '',
        model: typeof vision.model === 'string' ? vision.model : '',
        hasApiKey: visionKey.hasApiKey,
        keySource: visionKey.keySource,
      },
      ensemble: normalizeEnsemble(ai.ensemble),
    },
    auto: {
      enabled: auto.enabled !== false,
      autoAnswer: auto.autoAnswer !== false,
      intervalMs: clamp(auto.intervalMs ?? DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL),
      sensitivity: clamp(Math.round(auto.sensitivity ?? 3) || 3, 1, 5),
      crop: normalizeCropObject(auto.crop),
    },
    style: STYLE_LABELS[raw.style] ? raw.style : base.style,
    capture: {
      sourceId: typeof capture.sourceId === 'string' && capture.sourceId ? capture.sourceId : null,
      sourceName: typeof capture.sourceName === 'string' ? capture.sourceName : '',
    },
    overlay: {
      collapsed: Boolean(overlay.collapsed),
      width: clamp(overlay.width ?? 420, 320, 680),
    },
    hotkeys: {
      toggle: typeof hotkeys.toggle === 'string' ? hotkeys.toggle : base.hotkeys.toggle,
      scan: typeof hotkeys.scan === 'string' ? hotkeys.scan : base.hotkeys.scan,
      pause: typeof hotkeys.pause === 'string' ? hotkeys.pause : base.hotkeys.pause,
    },
  };
}

function applyState(next) {
  if (!next || typeof next !== 'object') return;

  if (next.app && typeof next.app === 'object') state.app = { ...state.app, ...next.app };
  if (next.engine && typeof next.engine === 'object') {
    state.engine = {
      ...state.engine,
      ...next.engine,
      models: { ...state.engine.models, ...(next.engine.models || {}) },
    };
  }

  let sourceChanged = false;
  if (next.settings && typeof next.settings === 'object') {
    const previousSource = state.settings.capture.sourceId;
    state.settings = normalizeSettings(next.settings);
    sourceChanged = previousSource !== state.settings.capture.sourceId;
  }

  if (next.runtime && typeof next.runtime === 'object') {
    state.runtime = { ...state.runtime, ...next.runtime };
    if (typeof next.runtime.permission === 'string') state.screenPermission = next.runtime.permission;
    if (!state.settings.capture.sourceName && typeof next.runtime.sourceName === 'string') {
      state.settings.capture.sourceName = next.runtime.sourceName;
    }
  }

  if (!state.historyAdopted) {
    state.historyAdopted = true;
    if (Array.isArray(next.history) && next.history.length && !state.history.length) {
      state.history = next.history
        .map(normalizeHistoryEntry)
        .filter(Boolean)
        .slice(0, HISTORY_LIMIT);
      saveHistory();
      renderHistory();
    }
  }

  state.collapsed = Boolean(state.settings.overlay.collapsed);
  renderAll();

  if (sourceChanged && state.ready) {
    void syncCapture(state.settings.capture.sourceId);
  }
}

function renderAll() {
  renderStatus();
  renderMode();
  renderSource();
  renderQuestion();
  renderAnswer();
  renderAuto();
  renderStyle();
  renderBusy();
  renderCollapsed();
  renderPermission();
  renderEnsemble();
  renderEnsembleToggle();
}

function renderStatus() {
  const dotState = !state.ready
    ? 'error'
    : isPaused()
      ? 'paused'
      : state.streaming || state.recognizing
        ? 'busy'
        : state.stream
          ? 'capturing'
          : 'idle';

  els.statusDot.dataset.state = dotState;
  els.statusDot.setAttribute('aria-label', `状态：${STATUS_LABELS[dotState]}`);
  els.pillDot.dataset.state = dotState;
  els.statusText.textContent = STATUS_LABELS[dotState];

  if (!state.ready) {
    els.app.dataset.ready = 'false';
  } else {
    els.app.dataset.ready = 'true';
  }
}

function renderMode() {
  const mode = state.engine.mode === 'live' ? 'live' : 'demo';
  els.modeBadge.textContent = mode === 'live' ? '在线模式' : '演示模式';
  els.modeBadge.dataset.mode = mode;
  els.modeBadge.title =
    mode === 'live'
      ? `在线模型：${state.engine.models.chat || '未配置'}`
      : '未配置 API Key，使用内置演示模型';
}

function renderSource() {
  const name = state.settings.capture.sourceName || state.runtime.sourceName || '';
  const selected = Boolean(state.settings.capture.sourceId);
  els.sourceName.textContent = name || '未选择窗口';
  els.sourceName.title = name || '未选择窗口';
  els.sourceHint.textContent = !selected
    ? '选择浏览器窗口后开始自动识别'
    : state.stream
      ? '画面已连接，正在检测题目变化'
      : '正在连接窗口画面…';
  els.pickSource.querySelector('span').textContent = selected ? '更换窗口' : '选择浏览器窗口';
  els.pickSource.dataset.variant = selected ? 'ghost' : 'primary';
  els.pickSource.classList.toggle('primary-btn', !selected);
  els.pickSource.classList.toggle('ghost-btn', selected);
  els.clearSource.hidden = !selected;
}

function setChip(element, text) {
  if (!element) return;
  element.textContent = text || '';
  element.hidden = !text;
}

function renderQuestion() {
  if (document.activeElement !== els.questionText) {
    els.questionText.value = state.question.text || '';
  }
  setChip(els.questionSubject, state.question.subject && state.question.subject !== '未知' ? state.question.subject : '');
  setChip(
    els.questionType,
    state.question.questionType && state.question.questionType !== 'unknown'
      ? TYPE_LABELS[state.question.questionType] || ''
      : '',
  );
  setChip(
    els.questionConfidence,
    state.question.confidence > 0 ? `置信 ${Math.round(state.question.confidence * 100)}%` : '',
  );

  els.questionOptions.textContent = '';
  const options = state.question.options;
  if (options.length) {
    for (const option of options) {
      const item = document.createElement('li');
      item.className = 'option';
      const label = document.createElement('span');
      label.className = 'option-label';
      label.textContent = option.label;
      const text = document.createElement('span');
      text.className = 'option-text';
      text.textContent = option.text;
      item.append(label, text);
      els.questionOptions.append(item);
    }
    els.questionOptions.hidden = false;
  } else {
    els.questionOptions.hidden = true;
  }

  updateSubmitState();
}

function updateSubmitState() {
  const ready = state.ready;
  els.submit.disabled = !ready || state.streaming || !hasQuestionText();
  els.rerecognize.disabled = !ready || state.recognizing;
  els.scan.disabled = !ready || state.recognizing;
  els.saveQuestion.disabled = !ready;
  els.questionText.disabled = !ready;
}

function renderAnswer() {
  const text = state.answerText;
  if (text) {
    els.answerEmpty.hidden = true;
    els.answerMd.innerHTML = renderMarkdown(text);
    highlightAnswerLabels(els.answerMd);
  } else {
    els.answerEmpty.hidden = false;
    els.answerMd.textContent = '';
  }

  els.answerMd.classList.toggle('is-streaming', state.streaming);
  els.answerMd.setAttribute('aria-busy', state.streaming ? 'true' : 'false');

  const meta = state.answerMeta;
  els.answerChars.textContent = `${text.length} 字`;
  els.copy.disabled = !text;
  els.stop.hidden = !state.streaming;
  setChip(els.answerCached, meta.cached ? '来自缓存' : '');
  setChip(els.answerDuration, meta.durationMs > 0 ? `${(meta.durationMs / 1000).toFixed(1)}s` : '');
  const model = meta.model || state.engine.models.chat || '';
  setChip(els.answerModel, model);
  els.answerModel.title = model;

  maybeScrollAnswer();
}

const LABEL_RE = /【(答案|解析|易错点|步骤)】/g;

/** Wrap the model's section markers so 【答案】 stands out without trusting HTML. */
function highlightAnswerLabels(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const value = node.nodeValue || '';
    if (!value.includes('【')) continue;
    if (node.parentElement && node.parentElement.closest('code, pre')) continue;
    LABEL_RE.lastIndex = 0;
    if (!LABEL_RE.test(value)) continue;
    LABEL_RE.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let match = LABEL_RE.exec(value);
    while (match) {
      if (match.index > cursor) fragment.append(document.createTextNode(value.slice(cursor, match.index)));
      const span = document.createElement('span');
      span.className = match[1] === '答案' ? 'answer-label answer-label-key' : 'answer-label';
      span.textContent = match[0];
      fragment.append(span);
      cursor = match.index + match[0].length;
      match = LABEL_RE.exec(value);
    }
    if (cursor < value.length) fragment.append(document.createTextNode(value.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
  }
}

function maybeScrollAnswer() {
  if (!els.scroller) return;
  if (!state.streaming && !state.stickToBottom) return;
  if (!state.stickToBottom) return;
  requestAnimationFrame(() => {
    els.scroller.scrollTop = els.scroller.scrollHeight;
  });
}

function scheduleAnswerRender() {
  if (state.answerRenderQueued) return;
  state.answerRenderQueued = true;
  requestAnimationFrame(() => {
    state.answerRenderQueued = false;
    renderAnswer();
  });
}

function ensembleAvailability() {
  const engine = state.engine.ensemble;
  if (engine && Array.isArray(engine.candidates)) {
    const count = engine.candidates.filter(
      (item) => item && typeof item.model === 'string' && item.model.trim(),
    ).length;
    return { count, ready: count >= 2 };
  }
  const count = state.settings.ai.ensemble.candidates.filter((item) => item.model && item.model.trim()).length;
  return { count, ready: count >= 2 };
}

function ensembleEnabled() {
  return Boolean(state.settings.ai.ensemble.enabled);
}

function renderEnsembleToggle() {
  if (!els.ensembleToggle) return;
  const availability = ensembleAvailability();
  const disabled = !state.ready || !availability.ready;
  els.ensembleToggle.checked = ensembleEnabled();
  els.ensembleToggle.disabled = disabled;
  if (els.ensembleSwitch) {
    els.ensembleSwitch.title = availability.ready
      ? '每次解答同时询问 3 个候选模型，由评审模型比对后输出最终答案。'
      : '需在设置中配置 ≥2 个候选模型';
    els.ensembleSwitch.dataset.disabled = String(disabled);
    els.ensembleToggle.title = els.ensembleSwitch.title;
  }
  if (els.ensembleCost) {
    els.ensembleCost.textContent = availability.ready
      ? '每次 3 份候选 + 1 次评审'
      : '每次 3 份候选 + 1 次评审 · 需配置 ≥2 个候选模型';
  }
}

function emptyEnsembleRun() {
  return { active: false, done: false, fallback: false, judge: null, candidates: [], expanded: new Set() };
}

function resetEnsembleRun() {
  state.ensemble = emptyEnsembleRun();
  renderEnsemble();
}

function beginEnsembleRun(meta) {
  const list = Array.isArray(meta.candidates) ? meta.candidates : [];
  const candidates = list.map((item, index) => {
    const entry = item && typeof item === 'object' ? item : {};
    return {
      index: Number.isInteger(entry.index) ? entry.index : index,
      name: typeof entry.name === 'string' ? entry.name : '',
      model: typeof entry.model === 'string' ? entry.model : '',
      status: 'running',
      text: '',
      error: '',
      durationMs: 0,
    };
  });
  candidates.sort((a, b) => a.index - b.index);
  const judge = meta.judge && typeof meta.judge === 'object' ? meta.judge : null;
  state.ensemble = {
    active: Boolean(meta.ensemble) || candidates.length > 0,
    done: false,
    fallback: false,
    judge: judge
      ? {
          name: typeof judge.name === 'string' ? judge.name : '',
          model: typeof judge.model === 'string' ? judge.model : '',
          status: 'running',
          error: '',
        }
      : null,
    candidates,
    expanded: new Set(),
  };
  renderEnsemble();
}

function applyCandidateEvent(event, { final = false } = {}) {
  const run = state.ensemble;
  const index = Number.isInteger(event.index) ? event.index : run.candidates.length;
  let slot = run.candidates.find((item) => item.index === index);
  if (!slot) {
    slot = { index, name: '', model: '', status: 'running', text: '', error: '', durationMs: 0 };
    run.candidates.push(slot);
  }
  if (typeof event.name === 'string' && event.name) slot.name = event.name;
  if (typeof event.model === 'string' && event.model) slot.model = event.model;
  if (event.status === 'running' || event.status === 'done' || event.status === 'error') slot.status = event.status;
  else if (final) slot.status = 'done';
  if (typeof event.text === 'string') slot.text = event.text;
  if (typeof event.error === 'string') slot.error = event.error;
  const duration = Number(event.durationMs);
  if (Number.isFinite(duration) && duration >= 0) slot.durationMs = duration;
  run.candidates.sort((a, b) => a.index - b.index);
  run.active = true;
  renderEnsemble();
}

function completeEnsembleRun(event) {
  const run = state.ensemble;
  const list = Array.isArray(event.candidates) ? event.candidates : [];
  if (!run.active && !list.length) return;
  if (list.length) {
    run.candidates = list
      .map((item, index) => {
        const entry = item && typeof item === 'object' ? item : {};
        return {
          index: Number.isInteger(entry.index) ? entry.index : index,
          name: typeof entry.name === 'string' ? entry.name : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          status: entry.status === 'error' ? 'error' : 'done',
          text: typeof entry.text === 'string' ? entry.text : '',
          error: typeof entry.error === 'string' ? entry.error : '',
          durationMs: Number(entry.durationMs) || 0,
        };
      })
      .sort((a, b) => a.index - b.index);
  } else {
    run.candidates = run.candidates.map((item) =>
      item.status === 'running' ? { ...item, status: 'done' } : item,
    );
  }
  const judge = event.judge && typeof event.judge === 'object' ? event.judge : null;
  if (judge) {
    run.judge = {
      name: typeof judge.name === 'string' ? judge.name : '',
      model: typeof judge.model === 'string' ? judge.model : '',
      status: judge.status === 'error' ? 'error' : 'done',
      error: typeof judge.error === 'string' ? judge.error : '',
    };
  } else if (run.judge) {
    run.judge = { ...run.judge, status: 'done' };
  }
  run.fallback = Boolean(event.fallback);
  run.done = true;
  run.active = Boolean(event.ensemble) || run.candidates.length > 0;
  if (run.active) renderEnsemble();
  if (run.fallback) showToast('评审不可用，已回退到候选答案。', 'warn');
}

function abortEnsembleRun(code = 'ABORTED') {
  const run = state.ensemble;
  if (!run.active) {
    resetEnsembleRun();
    return;
  }
  run.candidates = run.candidates.map((item) =>
    item.status === 'running' ? { ...item, status: 'error', error: code } : item,
  );
  if (run.judge && run.judge.status === 'running') {
    run.judge = { ...run.judge, status: 'error', error: code };
  }
  run.done = true;
  renderEnsemble();
}

function ensembleSummaryText(run) {
  const total = run.candidates.length;
  const done = run.candidates.filter((item) => item.status === 'done').length;
  const settled = run.candidates.every((item) => item.status !== 'running');
  if (!total) return run.judge ? '评审中…' : '';
  if (!settled) return `${done}/${total} 已完成`;
  if (!run.done) return `${done}/${total} 已完成 · 评审中…`;
  if (run.fallback) return `评审不可用，已回退 · ${done}/${total} 已完成`;
  return `${done}/${total} 已完成`;
}

function candidateStatusText(slot) {
  if (slot.status === 'running') return '作答中';
  if (slot.status === 'error') return slot.error ? String(slot.error).toUpperCase() : '失败';
  if (slot.durationMs > 0) return `${(slot.durationMs / 1000).toFixed(1)}s`;
  return '完成';
}

function renderCandidateRows(run) {
  const list = els.candidateList;
  if (!list) return;
  list.textContent = '';
  for (const slot of run.candidates) {
    const item = document.createElement('li');
    item.className = 'candidate';
    item.dataset.status = slot.status;
    item.setAttribute('data-testid', `candidate-${slot.index}`);

    const expanded = run.expanded.has(slot.index) && Boolean(slot.text);
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'candidate-head';
    head.dataset.candidateIndex = String(slot.index);
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    head.title = slot.text ? (expanded ? '收起该候选的答案' : '展开该候选的答案') : '暂无可展开的答案';

    const dot = document.createElement('span');
    dot.className = 'candidate-dot';
    dot.dataset.state = slot.status;
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'candidate-name';
    name.textContent = slot.name || `候选 ${slot.index + 1}`;

    const model = document.createElement('span');
    model.className = 'candidate-model';
    model.textContent = slot.model || '未配置';
    model.title = slot.model || '未配置';

    const status = document.createElement('span');
    status.className = 'candidate-status';
    status.dataset.state = slot.status;
    status.textContent = candidateStatusText(slot);

    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'icon candidate-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-chevron-down');
    chevron.append(use);
    chevron.hidden = !slot.text;

    head.append(dot, name, model, status, chevron);
    item.append(head);

    if (expanded) {
      const body = document.createElement('div');
      body.className = 'candidate-body answer-md';
      body.innerHTML = renderMarkdown(slot.text);
      highlightAnswerLabels(body);
      item.append(body);
    }
    list.append(item);
  }
}

function renderEnsembleJudge(run) {
  const judge = run.judge;
  if (!judge) {
    setChip(els.ensembleJudge, '');
    return;
  }
  const model = judge.model || judge.name || '评审';
  setChip(els.ensembleJudge, judge.status === 'error' ? `评审 · ${model}（失败）` : `评审 · ${model}`);
  els.ensembleJudge.title = judge.error || `评审模型：${model}`;
}

function renderEnsemble() {
  const run = state.ensemble;
  const visible = run.active && run.candidates.length > 0;
  if (!els.ensemblePanel) return;
  els.ensemblePanel.hidden = !visible;
  els.ensemblePanel.dataset.fallback = String(Boolean(run.fallback));
  if (!visible) {
    if (els.candidateList) els.candidateList.textContent = '';
    els.ensembleSummary.textContent = '';
    setChip(els.ensembleJudge, '');
    return;
  }
  els.ensembleSummary.textContent = ensembleSummaryText(run);
  renderEnsembleJudge(run);
  renderCandidateRows(run);
}

function toggleCandidate(index) {
  const run = state.ensemble;
  const slot = run.candidates.find((item) => item.index === index);
  if (!slot || !slot.text) return;
  if (run.expanded.has(index)) run.expanded.delete(index);
  else run.expanded.add(index);
  renderEnsemble();
}

function renderAuto() {
  const auto = state.settings.auto;
  els.autoEnabled.checked = auto.enabled !== false;
  els.autoAnswer.checked = auto.autoAnswer !== false;
  els.pause.textContent = isPaused() ? '继续' : '暂停';
  els.pause.setAttribute('aria-pressed', isPaused() ? 'true' : 'false');
  els.sensitivity.value = String(auto.sensitivity);
  els.sensitivityLabel.textContent = describeSensitivity(auto.sensitivity);
  updateCountdown();
}

function renderStyle() {
  const style = currentStyle();
  for (const button of els.styleButtons) {
    const active = button.dataset.style === style;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.dataset.active = active ? 'true' : 'false';
  }
}

function renderBusy() {
  els.app.dataset.busy = String(isBusy());
  renderStatus();
  updateSubmitState();
  els.stop.hidden = !state.streaming;
}

function renderCollapsed() {
  const collapsed = Boolean(state.collapsed);
  state.settings.overlay.collapsed = collapsed;
  els.app.dataset.collapsed = String(collapsed);
  els.pill.hidden = !collapsed;
  els.panel.hidden = collapsed;
  document.body.dataset.collapsed = String(collapsed);
  els.pill.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  const hotkey = hotkeyLabel(state.settings.hotkeys.toggle);
  els.pillHint.textContent = hotkey;
  els.pillHint.title = `展开快捷键：${state.settings.hotkeys.toggle}`;
  els.pill.title = `展开 AI 答题悬浮窗（${hotkey}）`;
  els.pill.setAttribute('aria-label', `展开 AI 答题悬浮窗（${hotkey}）`);
  scheduleExpandRetry();
}

function permissionLabel(permission) {
  switch (permission) {
    case 'granted':
      return '已授权';
    case 'denied':
      return '未授权';
    case 'restricted':
      return '受系统限制';
    case 'not-darwin':
      return '无需授权';
    default:
      return '未知';
  }
}

function renderPermission() {
  const darwin = state.app.platform === 'darwin';
  els.permissionRow.hidden = !darwin;
  els.permissionStatus.textContent = permissionLabel(state.screenPermission);
  const denied = darwin && (state.screenPermission === 'denied' || state.screenPermission === 'restricted');
  els.permissionBanner.hidden = !denied;
  els.pickerPermission.hidden = !darwin;
}

function updateCountdown() {
  if (!els.nextScan) return;
  if (!state.ready) {
    els.nextScan.textContent = '未连接';
    return;
  }
  if (!isAutoOn()) {
    els.nextScan.textContent = '自动识别关闭';
    return;
  }
  if (isPaused()) {
    els.nextScan.textContent = '已暂停';
    return;
  }
  if (state.recognizing) {
    els.nextScan.textContent = '识别中…';
    return;
  }
  if (state.streaming) {
    els.nextScan.textContent = '生成中…';
    return;
  }
  if (!state.stream) {
    els.nextScan.textContent = '未连接窗口';
    return;
  }
  const now = Date.now();
  if (now < state.cooldownUntil) {
    els.nextScan.textContent = `冷却 ${Math.ceil((state.cooldownUntil - now) / 1000)}s`;
    return;
  }
  const left = Math.max(0, Math.ceil((state.nextScanAt - now) / 1000));
  els.nextScan.textContent = left > 0 ? `下次扫描 ${left}s` : '扫描中…';
}

/* ------------------------------------------------------------------ */
/* capture lifecycle                                                   */
/* ------------------------------------------------------------------ */

function resetDetection() {
  state.hashes = [];
  state.baselineHash = null;
  state.cooldownUntil = 0;
  state.nextScanAt = Date.now() + sessionInterval();
}

function teardownCapture() {
  state.captureToken += 1;
  const stream = state.stream;
  state.stream = null;
  state.capturePending = false;
  resetDetection();
  if (stream) stopCapture(stream);
  if (els.video) {
    try {
      els.video.pause();
    } catch {
      // Element may already be detached.
    }
    els.video.srcObject = null;
  }
  state.lastFrame = '';
  state.lastFrameSize = null;
  renderStatus();
  renderSource();
}

function waitForVideo(video, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
      if (ready || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(ready);
      }
    }, 100);
  });
}

async function syncCapture(target) {
  const nextId = typeof target === 'string' && target ? target : null;
  if (state.sourceId === nextId && (state.stream || state.capturePending)) return;

  teardownCapture();
  state.sourceId = nextId;
  renderSource();

  if (!nextId) return;

  const token = ++state.captureToken;
  state.capturePending = true;
  try {
    const stream = await startCapture(nextId, els.video);
    if (token !== state.captureToken) {
      stopCapture(stream);
      return;
    }
    state.stream = stream;
    state.capturePending = false;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (state.stream !== stream) return;
        state.stream = null;
        resetDetection();
        renderStatus();
        renderSource();
        showError(new UiError('SOURCE_CLOSED'));
        showToast('窗口已关闭，自动检测已停止，请重新选择窗口。', 'warn', 4200);
      });
    }
    await waitForVideo(els.video, 5000);
    if (token !== state.captureToken) return;
    resetDetection();
    renderStatus();
    renderSource();
    if (els.video.videoWidth > 0) {
      showToast(`已连接窗口：${currentSourceName()}`, 'info');
    } else {
      showToast('窗口画面尚未就绪，正在等待第一帧…', 'warn', 4200);
    }
  } catch (error) {
    if (token !== state.captureToken) return;
    state.stream = null;
    state.capturePending = false;
    const info = toUiError(error);
    if (info.code === 'CAPTURE_DENIED' && state.app.platform === 'darwin') {
      state.screenPermission = 'denied';
      renderPermission();
    }
    showError(info);
    renderStatus();
    renderSource();
  } finally {
    if (token === state.captureToken) state.capturePending = false;
  }
}

async function ensureCapture() {
  if (!state.ready) return;
  if (!state.sourceId) return;
  if (state.stream) return;
  await syncCapture(state.sourceId);
}

function grabCurrentFrame() {
  return grabFrame(els.video, els.grabCanvas, {
    crop: currentCrop(),
    maxWidth: FRAME_MAX_WIDTH,
    quality: FRAME_QUALITY,
  });
}

/* ------------------------------------------------------------------ */
/* detection loop                                                      */
/* ------------------------------------------------------------------ */

function startScheduler() {
  if (state.scheduler) return;
  state.nextScanAt = Date.now() + sessionInterval();
  state.scheduler = setInterval(schedulerTick, SCHEDULER_MS);
}

function schedulerTick() {
  try {
    updateCountdown();
    if (!state.ready || !state.stream) return;
    if (!isAutoOn() || isPaused() || isBusy()) return;
    const now = Date.now();
    if (now < state.nextScanAt) return;
    state.nextScanAt = now + sessionInterval();
    if (now < state.cooldownUntil) return;
    void detectFrame();
  } catch (error) {
    reportUnexpected(error);
  }
}

async function detectFrame() {
  if (state.detecting || !state.stream) return;
  state.detecting = true;
  try {
    drawFrame(els.video, els.detectCanvas, { crop: currentCrop(), maxWidth: DETECT_MAX_WIDTH });
    const hash = frameHash(els.detectCanvas);
    const density = edgeDensity(els.detectCanvas);

    const recent = state.hashes;
    recent.push(hash);
    while (recent.length > 3) recent.shift();
    if (recent.length < 2) return;

    const previous = recent[recent.length - 2];
    const current = recent[recent.length - 1];
    const stable = hamming(current, previous) <= STABLE_BITS;
    if (!stable) return;
    if (density < MIN_EDGE_DENSITY) return;

    if (state.baselineHash === null) {
      state.baselineHash = current;
      await triggerAuto('initial');
      return;
    }
    if (hamming(current, state.baselineHash) < sensitivityBits()) return;
    state.baselineHash = current;
    await triggerAuto('change');
  } catch (error) {
    const info = toUiError(error);
    const now = Date.now();
    if (info.code !== 'FRAME_NOT_READY' && now - state.lastDetectError.at > 10000) {
      state.lastDetectError = { code: info.code, at: now };
      if (info.code !== 'ABORTED') showError(info);
    }
  } finally {
    state.detecting = false;
  }
}

async function triggerAuto(reason) {
  if (isPaused() || isBusy()) return;
  state.cooldownUntil = Date.now() + cooldownMs();
  state.nextScanAt = Date.now() + sessionInterval();
  let frame;
  try {
    frame = grabCurrentFrame();
  } catch (error) {
    if (toUiError(error).code !== 'FRAME_NOT_READY') showError(error);
    return;
  }
  state.lastFrame = frame.dataUrl;
  state.lastFrameSize = { width: frame.width, height: frame.height };
  await recognizeFrame({ frame, trigger: 'auto', reason });
}

async function manualScan() {
  if (!state.ready) {
    showError(new UiError('NO_BRIDGE'));
    return;
  }
  if (!state.sourceId) {
    showToast('请先选择要识别的窗口。', 'warn');
    await openSourcePicker();
    return;
  }
  if (state.recognizing) {
    showToast('正在识别中，请稍候…', 'info');
    return;
  }
  if (!state.stream) await syncCapture(state.sourceId);
  if (!state.stream) return;

  state.cooldownUntil = Date.now() + cooldownMs();
  let frame;
  try {
    frame = grabCurrentFrame();
  } catch (error) {
    showError(error);
    return;
  }
  state.lastFrame = frame.dataUrl;
  state.lastFrameSize = { width: frame.width, height: frame.height };
  state.baselineHash = state.hashes.length ? state.hashes[state.hashes.length - 1] : null;
  await recognizeFrame({ frame, trigger: 'manual' });
}

/* ------------------------------------------------------------------ */
/* recognition + answers                                               */
/* ------------------------------------------------------------------ */

function applyQuestion(question) {
  if (!question) return;
  const text =
    typeof question === 'string' ? question.trim() : String(question.question ?? question.text ?? '').trim();
  if (!text) return;
  state.question = {
    text,
    options: normalizeOptions(typeof question === 'string' ? [] : question.options),
    subject: typeof question.subject === 'string' ? question.subject : '',
    questionType: TYPE_LABELS[question.questionType] ? question.questionType : 'unknown',
    confidence: Number.isFinite(Number(question.confidence)) ? Number(question.confidence) : 0,
    model: typeof question.model === 'string' ? question.model : '',
  };
  state.questionDirty = false;
  renderQuestion();
}

async function recognizeFrame({ frame, trigger }) {
  if (state.recognizing) return;
  state.recognizing = true;
  renderBusy();
  try {
    if (!frame || !frame.dataUrl) throw new UiError('FRAME_NOT_READY');
    const result = await call('recognize', frame.dataUrl);
    const text = result && typeof result.question === 'string' ? result.question.trim() : '';
    if (!text) throw new UiError('RECOGNIZE_FAILED');

    const key = questionKey(text);
    const duplicate = key === state.lastQuestionKey;
    applyQuestion(result);
    state.lastQuestionKey = key;
    clearError();

    if (duplicate && trigger === 'auto') return;

    if (!isAutoAnswer()) {
      showToast(
        trigger === 'auto' ? '检测到题目，点击「解答」查看答案。' : '已识别题目，点击「解答」查看答案。',
        'info',
      );
      return;
    }
    if (isPaused()) {
      showToast('已暂停自动解答，题目已就绪。', 'info');
      return;
    }
    await startAnswer({ silent: true });
  } catch (error) {
    const info = toUiError(error);
    if (info.code !== 'ABORTED') showError(info);
  } finally {
    state.recognizing = false;
    renderBusy();
    updateCountdown();
  }
}

async function startAnswer() {
  if (!state.ready) {
    showError(new UiError('NO_BRIDGE'));
    return;
  }
  const text = (els.questionText.value || state.question.text || '').trim();
  if (!text) {
    showError(new UiError('EMPTY_QUESTION'));
    els.questionText.focus();
    return;
  }

  if (state.streaming && !state.requestId) return;
  if (state.streaming && state.requestId) {
    const previous = state.requestId;
    state.requestId = null;
    try {
      await call('stopAnswer', previous);
    } catch {
      // The main process also aborts the previous answer on a new request.
    }
  }

  state.question.text = text;
  state.questionDirty = false;
  state.answerText = '';
  state.answerMeta = { cached: false, durationMs: 0, model: '', usage: null };
  state.streaming = true;
  state.requestId = null;
  state.stickToBottom = true;
  resetEnsembleRun();
  clearError();
  renderBusy();
  renderAnswer();

  const payload = { question: text, style: currentStyle() };
  const options = state.question.options.filter((option) => option && option.text);
  if (options.length) payload.options = options;
  if (state.question.subject) payload.subject = state.question.subject;

  try {
    state.startingAnswer = true;
    const response = await call('answer', payload);
    if (!response || typeof response.requestId !== 'string' || !response.requestId) {
      throw new UiError('INTERNAL', '桌面接口未返回 requestId。');
    }
    state.startingAnswer = false;
    state.requestId = response.requestId;
    renderBusy();
  } catch (error) {
    state.startingAnswer = false;
    state.streaming = false;
    state.requestId = null;
    renderBusy();
    renderAnswer();
    showError(error);
  }
}

async function stopAnswer() {
  const requestId = state.requestId;
  if (!requestId) {
    state.streaming = false;
    resetEnsembleRun();
    renderBusy();
    renderAnswer();
    return;
  }
  try {
    await call('stopAnswer', requestId);
    showToast('已停止生成。', 'info');
  } catch (error) {
    showError(error);
  } finally {
    if (state.requestId === requestId) {
      state.requestId = null;
      state.streaming = false;
      resetEnsembleRun();
      renderBusy();
      renderAnswer();
      updateCountdown();
    }
  }
}

function acceptRequest(requestId) {
  if (typeof requestId !== 'string' || !requestId) return false;
  if (!state.requestId) {
    state.requestId = requestId;
    return true;
  }
  return state.requestId === requestId;
}

function onAnswerMeta(event) {
  if (!acceptRequest(event.requestId)) return;
  state.streaming = true;
  state.answerText = '';
  state.answerMeta = {
    cached: Boolean(event.cached),
    durationMs: 0,
    model: typeof event.model === 'string' ? event.model : '',
    usage: null,
  };
  const candidates = Array.isArray(event.candidates) ? event.candidates : [];
  if (event.ensemble || candidates.length) beginEnsembleRun(event);
  else resetEnsembleRun();
  if (event.ensemble === true) {
    // An ensemble run proves the switch was on even if the cached state lagged.
    state.settings.ai.ensemble.enabled = true;
  }
  renderEnsembleToggle();
  if (event.question && typeof event.question === 'string' && !state.question.text.trim()) {
    applyQuestion({
      question: event.question,
      options: event.options,
      subject: event.subject,
      questionType: event.questionType,
    });
  }
  state.stickToBottom = true;
  renderBusy();
  renderAnswer();
}

function onAnswerCandidate(event) {
  if (typeof event.requestId === 'string' && event.requestId) {
    if (!acceptRequest(event.requestId)) return;
  }
  applyCandidateEvent(event);
}

function onAnswerDelta(event) {
  if (!acceptRequest(event.requestId)) return;
  state.streaming = true;
  if (typeof event.text === 'string' && event.text) {
    state.answerText += event.text;
    scheduleAnswerRender();
  }
  els.stop.hidden = false;
}

function onAnswerDone(event) {
  if (typeof event.requestId === 'string' && event.requestId) {
    if (state.requestId && state.requestId !== event.requestId) return;
    state.requestId = event.requestId;
  }
  const text = typeof event.text === 'string' ? event.text : state.answerText;
  completeEnsembleRun(event);
  finishAnswer({
    text,
    durationMs: Number(event.durationMs) || 0,
    cached: Boolean(event.cached ?? state.answerMeta.cached),
    usage: event.usage && typeof event.usage === 'object' ? event.usage : null,
  });
}

function onAnswerError(event) {
  const requestId = typeof event.requestId === 'string' ? event.requestId : '';
  const active = state.requestId;
  // Stale terminal event from an answer this view already replaced or stopped.
  if (requestId && active && requestId !== active) return;
  if (requestId && !active && state.startingAnswer) return;
  if (!requestId && !active && !state.streaming) return;

  const code = typeof event.code === 'string' && event.code ? event.code : 'INTERNAL';
  const wasActive = state.streaming;
  state.streaming = false;
  state.requestId = null;
  if (code === 'ABORTED') resetEnsembleRun();
  else abortEnsembleRun(code);
  renderBusy();
  renderAnswer();
  updateCountdown();

  if (code === 'ABORTED') {
    if (wasActive) showToast('已停止生成。', 'info');
    return;
  }
  showError(new UiError(code, typeof event.message === 'string' ? event.message : ''));
}

function finishAnswer({ text, durationMs, cached, usage }) {
  const value = typeof text === 'string' ? text : state.answerText;
  state.streaming = false;
  state.requestId = null;
  state.answerText = value;
  state.answerMeta = { ...state.answerMeta, cached, durationMs, usage };
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldownMs());
  state.nextScanAt = Date.now() + sessionInterval();
  renderBusy();
  renderAnswer();
  updateCountdown();
  if (value.trim()) pushHistory(value, { cached, durationMs });
}

function onRecognized(event) {
  if (!event || !event.question) return;
  // Our own aqs.recognize() result takes precedence; main's event is for
  // hotkey/external scans that this view did not start.
  if (state.recognizing) return;

  const raw = event.question;
  const text = typeof raw === 'string' ? raw.trim() : String(raw.question ?? '').trim();
  if (!text) return;
  const key = questionKey(text);
  if (key === state.lastQuestionKey) return;

  applyQuestion(raw);
  state.lastQuestionKey = key;
  if (event.trigger === 'auto' && isAutoAnswer() && !isPaused()) {
    void startAnswer();
  } else {
    showToast('检测到题目，点击「解答」查看答案。', 'info');
  }
}

/* ------------------------------------------------------------------ */
/* events from main                                                    */
/* ------------------------------------------------------------------ */

function handleEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
  switch (event.type) {
    case 'state':
      state.ready = true;
      applyState(event.state);
      if (!state.scheduler) startScheduler();
      void ensureCapture();
      break;
    case 'answer:meta':
      onAnswerMeta(event);
      break;
    case 'answer:candidate':
      onAnswerCandidate(event);
      break;
    case 'answer:delta':
      onAnswerDelta(event);
      break;
    case 'answer:done':
      onAnswerDone(event);
      break;
    case 'answer:error':
      onAnswerError(event);
      break;
    case 'recognized':
      onRecognized(event);
      break;
    case 'toast':
      showToast(
        String(event.message || ''),
        event.level === 'warn' || event.level === 'error' ? event.level : 'info',
      );
      break;
    case 'permission':
      state.screenPermission = typeof event.screen === 'string' ? event.screen : 'unknown';
      renderPermission();
      break;
    case 'command':
      // Main forwards global-hotkey/tray accelerators as commands.
      if (event.command === 'scan') {
        void manualScan();
      } else if (event.command === 'pause') {
        void togglePause();
      } else if (event.command === 'toggle') {
        if (state.collapsed) resetExpandRetry();
        void collapseTo(!state.collapsed);
      }
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

function isHistoryEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && typeof entry.question === 'string';
}

/**
 * Main keeps its own history.json with `answer`; this view stores `text`.
 * Normalize both shapes so restored entries always have a text body.
 */
function normalizeHistoryEntry(entry) {
  if (!isHistoryEntry(entry)) return null;
  const question = String(entry.question).trim();
  if (!question) return null;
  return {
    id: typeof entry.id === 'string' ? entry.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: Number(entry.at) || Date.now(),
    question,
    options: Array.isArray(entry.options) ? normalizeOptions(entry.options) : [],
    subject: typeof entry.subject === 'string' ? entry.subject : '未知',
    questionType: TYPE_LABELS[entry.questionType] ? entry.questionType : 'unknown',
    style: STYLE_LABELS[entry.style] ? entry.style : 'concise',
    text: typeof entry.text === 'string' ? entry.text : typeof entry.answer === 'string' ? entry.answer : '',
    cached: Boolean(entry.cached),
    durationMs: Number(entry.durationMs) || 0,
    model: typeof entry.model === 'string' ? entry.model : '',
  };
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
  } catch {
    showToast('浏览器存储不可用，历史记录仅在本次运行中保留。', 'warn');
  }
}

function pushHistory(answerText, { cached, durationMs }) {
  const question = state.question;
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    question: question.text,
    options: question.options.map((option) => ({ label: option.label, text: option.text })),
    subject: question.subject || '未知',
    questionType: question.questionType || 'unknown',
    style: currentStyle(),
    text: answerText,
    cached: Boolean(cached),
    durationMs: Number(durationMs) || 0,
    model: state.answerMeta.model || '',
  };
  const previous = state.history[0];
  if (
    previous &&
    previous.question === entry.question &&
    previous.text === entry.text &&
    entry.at - Number(previous.at) < 5000
  ) {
    return;
  }
  state.history = [entry, ...state.history].slice(0, HISTORY_LIMIT);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  els.historyList.textContent = '';
  els.historyEmpty.hidden = state.history.length > 0;

  state.history.forEach((entry, index) => {
    const item = document.createElement('li');
    item.className = 'history-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-button';
    button.dataset.historyIndex = String(index);

    const head = document.createElement('span');
    head.className = 'history-question';
    head.textContent = snippet(entry.question, 90);
    head.title = entry.question;

    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const time = document.createElement('span');
    time.textContent = formatTime(entry.at);
    const subject = document.createElement('span');
    subject.className = 'chip chip-mini';
    subject.textContent = entry.subject || '未知';
    const length = document.createElement('span');
    length.textContent = `${String(entry.text || '').length} 字`;
    meta.append(time, subject, length);

    const answer = document.createElement('span');
    answer.className = 'history-answer';
    answer.textContent = snippet(entry.text, 60);

    button.append(head, meta, answer);
    item.append(button);
    els.historyList.append(item);
  });
}

function restoreHistory(index) {
  const entry = state.history[index];
  if (!entry) return;
  applyQuestion({
    question: entry.question,
    options: entry.options,
    subject: entry.subject,
    questionType: entry.questionType,
  });
  state.lastQuestionKey = questionKey(entry.question);
  state.questionDirty = false;
  els.questionText.value = entry.question;
  state.answerText = typeof entry.text === 'string' ? entry.text : '';
  state.answerMeta = {
    cached: Boolean(entry.cached),
    durationMs: Number(entry.durationMs) || 0,
    model: typeof entry.model === 'string' ? entry.model : '',
    usage: null,
  };
  state.streaming = false;
  state.requestId = null;
  state.stickToBottom = true;
  renderQuestion();
  renderAnswer();
  renderBusy();
  closeDrawers();
  showToast('已从历史回填题目与答案。', 'info');
}

function clearHistory() {
  state.history = [];
  saveHistory();
  renderHistory();
  showToast('历史记录已清空。', 'info');
}

/* ------------------------------------------------------------------ */
/* settings drawer                                                     */
/* ------------------------------------------------------------------ */

function modelFieldParts(id) {
  const select = $(id);
  if (!select) return null;
  return { id, select, custom: $(`${id}-custom`), hint: $(`${id}-hint`) };
}

/** 下拉可见且已有选项时以 select 为准，否则回退到同 id 的「-custom」文本框。 */
function usingModelSelect(field) {
  return Boolean(field && !field.select.hidden && field.select.options.length > 0);
}

function ensureModelOption(select, value) {
  if (!value) return;
  for (const option of select.options) {
    if (option.value === value) return;
  }
  const option = document.createElement('option');
  option.value = value;
  option.textContent = `当前：${value}`;
  option.dataset.legacy = 'true';
  select.append(option);
}

function readModelValue(id) {
  const field = modelFieldParts(id);
  if (!field) return '';
  if (usingModelSelect(field)) return field.select.value.trim();
  return field.custom ? field.custom.value.trim() : '';
}

function setModelValue(id, value) {
  const field = modelFieldParts(id);
  if (!field) return;
  const next = typeof value === 'string' ? value.trim() : '';
  if (!usingModelSelect(field)) {
    if (field.custom && field.custom.value !== next) field.custom.value = next;
    return;
  }
  ensureModelOption(field.select, next);
  if (field.select.value !== next) field.select.value = next;
  for (const option of [...field.select.options]) {
    if (option.dataset.legacy === 'true' && option.value !== next) option.remove();
  }
}

function focusModelField(id) {
  const field = modelFieldParts(id);
  if (!field) return;
  const target = usingModelSelect(field) ? field.select : field.custom || field.select;
  if (target && typeof target.focus === 'function') target.focus();
}

const MODEL_EMPTY_LABEL = {
  global: '（不修改，沿用已保存）',
  vision: '（留空 → 继承全局视觉模型）',
  judge: '（留空 → 继承全局文本模型）',
  slot: '（未配置）',
};

/**
 * 用模型目录重建一个下拉；目录内没有的旧值会插入「当前：xxx」并选中。
 * 端点无目录（或目录为空）时隐藏下拉、露出同 id 的「-custom」文本框。
 */
function renderModelField(id, baseUrl, options = {}) {
  const field = modelFieldParts(id);
  if (!field) return;
  const {
    visionOnly = false,
    emptyLabel = MODEL_EMPTY_LABEL.slot,
    inheritFromGlobal = false,
    customHint = '自定义端点：手动填写模型 id',
  } = options;
  const previous = readModelValue(id);
  const catalog = catalogForBaseUrl(baseUrl);
  const hasCatalog = Boolean(catalog) && catalog.models.length > 0;
  const signature = [
    hasCatalog ? catalog.key : 'custom',
    baseUrl,
    visionOnly ? 'vision' : 'all',
    inheritFromGlobal ? 'inherit' : 'own',
  ].join('|');

  if (field.select.dataset.sig === signature) {
    if (hasCatalog) {
      ensureModelOption(field.select, previous);
      if (field.select.value !== previous) field.select.value = previous;
    }
    return;
  }
  field.select.dataset.sig = signature;

  if (!hasCatalog) {
    field.select.hidden = true;
    field.select.replaceChildren();
    if (field.custom) {
      field.custom.hidden = false;
      if (field.custom.value !== previous) field.custom.value = previous;
    }
    if (field.hint) {
      field.hint.hidden = false;
      field.hint.dataset.state = 'custom';
      field.hint.textContent = catalog ? '该端点未内置模型列表，请手动填写模型 id' : customHint;
    }
    return;
  }

  const models = visionOnly ? catalog.models.filter((model) => model.vision) : [...catalog.models];
  field.select.hidden = false;
  if (field.custom) {
    field.custom.hidden = true;
    if (field.custom.value) field.custom.value = '';
  }

  const select = field.select;
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = emptyLabel;
  select.append(blank);

  const groups = new Map();
  for (const model of models) {
    const vendor = model.vendor || '其他';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(model);
  }
  for (const [vendor, list] of groups) {
    const group = document.createElement('optgroup');
    group.label = vendor;
    for (const model of list) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.vision ? `${model.label}（视觉）` : model.label;
      group.append(option);
    }
    select.append(group);
  }
  ensureModelOption(select, previous);
  select.value = previous;
  if (select.value !== previous) select.value = '';

  if (field.hint) {
    if (inheritFromGlobal) {
      field.hint.hidden = false;
      field.hint.dataset.state = 'inherited';
      field.hint.textContent = `继承全局端点（${catalog.label}）`;
    } else if (visionOnly && models.length === 0) {
      field.hint.hidden = false;
      field.hint.dataset.state = 'none';
      field.hint.textContent = '该端点没有可用的视觉模型，可在「视觉识别」里单独配置端点。';
    } else {
      field.hint.hidden = true;
      field.hint.textContent = '';
      delete field.hint.dataset.state;
    }
  }
}

/** 端点变了就按新的 Base URL 重建全部模型下拉，保留仍然存在的取值。 */
function refreshModelSelectors() {
  const globalBase = els.setBaseUrl.value.trim();
  renderModelField('set-model', globalBase, { emptyLabel: MODEL_EMPTY_LABEL.global });
  renderModelField('set-vision', globalBase, {
    emptyLabel: MODEL_EMPTY_LABEL.global,
    visionOnly: true,
  });
  const visionBase = els.visionBase ? els.visionBase.value.trim() : '';
  renderModelField('vision-model', visionBase || globalBase, {
    emptyLabel: MODEL_EMPTY_LABEL.vision,
    visionOnly: true,
  });
  const fields = els.ensembleFields;
  if (!fields) return;
  fields.candidates.forEach((slot, index) => {
    const slotBase = slot.base.value.trim();
    renderModelField(`cand-${index}-model`, slotBase || globalBase, {
      emptyLabel: MODEL_EMPTY_LABEL.slot,
      inheritFromGlobal: !slotBase,
    });
  });
  const judgeBase = fields.judge.base.value.trim();
  renderModelField('judge-model', judgeBase || globalBase, {
    emptyLabel: MODEL_EMPTY_LABEL.judge,
    inheritFromGlobal: !judgeBase,
  });
}

function makeSettingField({ id, label, type = 'text', placeholder = '', min, max, step, hint }) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const labelEl = document.createElement('span');
  labelEl.className = 'field-label';
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.id = id;
  input.type = type;
  input.autocomplete = type === 'password' ? 'new-password' : 'off';
  input.spellcheck = false;
  if (placeholder) input.placeholder = placeholder;
  if (type === 'url') input.inputMode = 'url';
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  wrapper.append(labelEl, input);
  let hintEl = null;
  if (hint) {
    hintEl = document.createElement('span');
    hintEl.className = 'field-hint';
    hintEl.id = `${id}-hint`;
    hintEl.textContent = hint;
    wrapper.append(hintEl);
  }
  return { wrapper, input, hint: hintEl };
}

function buildEnsembleSlot({ prefix, legend, testid, isCandidate, temperature }) {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'ensemble-slot';
  fieldset.setAttribute('data-testid', testid);
  const legendEl = document.createElement('legend');
  legendEl.textContent = legend;

  const head = document.createElement('div');
  head.className = 'field-row';
  const name = makeSettingField({
    id: `${prefix}-name`,
    label: '名称',
    placeholder: isCandidate ? '模型 A' : '评审',
  });
  const temp = makeSettingField({
    id: `${prefix}-temp`,
    label: '温度',
    type: 'number',
    min: 0,
    max: 2,
    step: 0.1,
    placeholder: String(temperature),
  });
  head.append(name.wrapper, temp.wrapper);

  const modelWrap = document.createElement('div');
  modelWrap.className = 'field';
  const modelLabel = document.createElement('label');
  modelLabel.className = 'field-label';
  modelLabel.htmlFor = `${prefix}-model`;
  modelLabel.textContent = '模型';
  const modelSelect = document.createElement('select');
  modelSelect.id = `${prefix}-model`;
  modelSelect.className = 'model-select';
  modelSelect.autocomplete = 'off';
  modelSelect.setAttribute('data-testid', 'model-select');
  const modelCustom = document.createElement('input');
  modelCustom.id = `${prefix}-model-custom`;
  modelCustom.className = 'model-custom';
  modelCustom.type = 'text';
  modelCustom.autocomplete = 'off';
  modelCustom.spellcheck = false;
  modelCustom.placeholder = isCandidate ? '输入模型 id，例如 deepseek-chat' : '留空继承全局文本模型';
  modelCustom.hidden = true;
  const modelHint = document.createElement('span');
  modelHint.id = `${prefix}-model-hint`;
  modelHint.className = 'field-hint model-hint';
  modelHint.textContent = isCandidate ? '继承全局端点' : '留空继承全局文本模型';
  modelWrap.append(modelLabel, modelSelect, modelCustom, modelHint);

  const base = makeSettingField({
    id: `${prefix}-base`,
    label: 'Base URL',
    type: 'url',
    placeholder: '留空继承全局',
  });
  const key = makeSettingField({
    id: `${prefix}-key`,
    label: 'API Key',
    type: 'password',
    placeholder: '留空保持全局 Key',
    hint: '未配置',
  });

  const advanced = document.createElement('details');
  advanced.className = 'slot-advanced';
  const summary = document.createElement('summary');
  summary.textContent = '高级：自定义端点 / Key（默认继承全局）';
  advanced.append(summary, base.wrapper, key.wrapper);

  fieldset.append(legendEl, head, modelWrap, advanced);
  return {
    fieldset,
    fields: {
      name: name.input,
      temp: temp.input,
      base: base.input,
      key: key.input,
      keyHint: key.hint,
      model: modelSelect,
      modelCustom,
      modelHint,
    },
  };
}

function initEnsembleForm() {
  if (!els.ensembleSlots || els.ensembleFields) return;
  const fragment = document.createDocumentFragment();
  const candidates = DEFAULT_CANDIDATES.map((slot, index) => {
    const built = buildEnsembleSlot({
      prefix: `cand-${index}`,
      legend: `候选 ${index + 1} · ${slot.name}`,
      testid: `ensemble-candidate-${index}`,
      isCandidate: true,
      temperature: slot.temperature,
    });
    fragment.append(built.fieldset);
    return built.fields;
  });
  const judge = buildEnsembleSlot({
    prefix: 'judge',
    legend: '评审模型',
    testid: 'ensemble-judge-slot',
    isCandidate: false,
    temperature: DEFAULT_JUDGE.temperature,
  });
  fragment.append(judge.fieldset);
  els.ensembleSlots.append(fragment);
  els.ensembleFields = { candidates, judge: judge.fields };
}

function keyHintText(keySource, withKeep = true) {
  const base = KEY_SOURCE_TEXT[keySource] || KEY_SOURCE_TEXT.none;
  return withKeep ? `${base}（留空保持不变）` : base;
}

function renderEnsembleForm() {
  initEnsembleForm();
  const ai = state.settings.ai;
  els.visionBase.value = ai.vision.baseUrl || '';
  els.visionKey.value = '';
  els.visionKeyHint.textContent = keyHintText(ai.vision.keySource);
  els.visionKeyHint.dataset.state = ai.vision.keySource || 'none';
  els.setEnsembleEnabled.checked = Boolean(ai.ensemble.enabled);
  setModelValue('vision-model', ai.vision.model || '');

  const fields = els.ensembleFields;
  if (!fields) return;
  ai.ensemble.candidates.forEach((slot, index) => {
    const target = fields.candidates[index];
    if (!target) return;
    target.name.value = slot.name || '';
    target.base.value = slot.baseUrl || '';
    setModelValue(`cand-${index}-model`, slot.model || '');
    target.temp.value = String(slot.temperature);
    target.key.value = '';
    target.keyHint.textContent = keyHintText(slot.keySource);
    target.keyHint.dataset.state = slot.keySource || 'none';
  });
  const judge = ai.ensemble.judge;
  fields.judge.name.value = judge.name || '';
  fields.judge.base.value = judge.baseUrl || '';
  setModelValue('judge-model', judge.model || '');
  fields.judge.temp.value = String(judge.temperature);
  fields.judge.key.value = '';
  fields.judge.keyHint.textContent = keyHintText(judge.keySource);
  fields.judge.keyHint.dataset.state = judge.keySource || 'none';
  refreshModelSelectors();
}

function applyPreset(name) {
  const preset = AI_PRESETS[name];
  if (!preset) return;
  initEnsembleForm();
  const fields = els.ensembleFields;
  if (!fields) return;
  const presetBases = Object.values(AI_PRESETS).map((item) => item.baseUrl);
  const presetModels = new Set(
    Object.values(AI_PRESETS)
      .flatMap((item) => [item.model, item.visionModel, ...(item.candidates ?? []), item.judge])
      .filter(Boolean),
  );
  const currentBase = els.setBaseUrl.value.trim();
  const baseIsDefault = !currentBase || presetBases.includes(currentBase);
  if (baseIsDefault) els.setBaseUrl.value = preset.baseUrl;
  // 先按新端点重建目录，再按「空值或旧预设值」覆盖模型。
  refreshModelSelectors();

  const textValue = readModelValue('set-model');
  if (!textValue || (baseIsDefault && presetModels.has(textValue))) setModelValue('set-model', preset.model);
  const visionValue = readModelValue('set-vision');
  if (
    preset.visionModel &&
    (!visionValue || (baseIsDefault && presetModels.has(visionValue)))
  ) {
    setModelValue('set-vision', preset.visionModel);
  }

  const models = Array.isArray(preset.candidates) ? preset.candidates : [];
  const slots = [...fields.candidates, fields.judge];
  slots.forEach((slot, index) => {
    const suggested = index < fields.candidates.length ? models[index] : preset.judge;
    if (!suggested) return;
    const slotBase = slot.base.value.trim();
    if (!slotBase || presetBases.includes(slotBase)) slot.base.value = '';
  });
  refreshModelSelectors();

  slots.forEach((slot, index) => {
    const suggested = index < fields.candidates.length ? models[index] : preset.judge;
    if (!suggested) return;
    const id = index < fields.candidates.length ? `cand-${index}-model` : 'judge-model';
    const current = readModelValue(id);
    if (!current || presetModels.has(current)) setModelValue(id, suggested);
  });
  refreshModelSelectors();
  showToast(`已填入 ${preset.label} 的端点与模型，可修改后保存。`, 'info');
  // 预设切换后旧结果不再可信：清空状态，有 Key 就立刻重测。
  state.probe.seq += 1;
  state.probe.hasResult = false;
  setProbeTesting(false);
  clearProbeResults();
  if (formHasAnyKey()) void runProbe();
  else renderProbeDemo();
}

function clearEnsembleCandidates() {
  initEnsembleForm();
  const fields = els.ensembleFields;
  if (!fields) return;
  fields.candidates.forEach((slot, index) => {
    const defaults = DEFAULT_CANDIDATES[index];
    slot.name.value = defaults.name;
    slot.base.value = '';
    setModelValue(`cand-${index}-model`, '');
    slot.temp.value = String(defaults.temperature);
    slot.key.value = '';
  });
  refreshModelSelectors();
  showToast('已清空候选配置，已保存的密钥不会被删除。', 'info');
}

function validHttpUrl(value) {
  return !value || /^https?:\/\/[^\s]+$/i.test(value);
}

function validModel(value) {
  return !value || MODEL_PATTERN.test(value);
}

async function toggleEnsemble(enabled) {
  if (!state.ready) {
    renderEnsembleToggle();
    return;
  }
  if (enabled && !ensembleAvailability().ready) {
    renderEnsembleToggle();
    showToast('需在设置中配置 ≥2 个候选模型。', 'warn');
    return;
  }
  try {
    const next = await call('updateSettings', { ai: { ensemble: { enabled } } });
    if (next && next.settings) applyState(next);
    else {
      state.settings.ai.ensemble.enabled = enabled;
      renderEnsembleToggle();
    }
    showToast(enabled ? '已开启交叉验证。' : '已关闭交叉验证。', 'info');
  } catch (error) {
    renderEnsembleToggle();
    showError(error);
  }
}

function openSettings() {
  const ai = state.settings.ai;
  const auto = state.settings.auto;
  els.setBaseUrl.value = ai.baseUrl || '';
  setModelValue('set-model', ai.model || '');
  setModelValue('set-vision', ai.visionModel || '');
  els.setApiKey.value = '';
  els.setKeyHint.textContent = ai.hasApiKey ? '已保存密钥（留空表示不修改）' : '未配置密钥，当前为演示模式';
  els.setInterval.value = String(sessionInterval());
  els.setAutoEnabled.checked = isAutoOn();
  els.setAutoAnswer.checked = isAutoAnswer();
  els.setSensitivity.value = String(auto.sensitivity);
  els.setSensitivityLabel.textContent = describeSensitivity(auto.sensitivity);
  renderEnsembleForm();
  syncProbeIdle();
  els.settingsError.hidden = true;
  state.cropDraft = currentCrop();
  state.cropDrag = null;

  if (!state.lastFrame && state.stream) {
    try {
      const frame = grabCurrentFrame();
      state.lastFrame = frame.dataUrl;
      state.lastFrameSize = { width: frame.width, height: frame.height };
    } catch {
      // No frame yet; the crop editor shows its empty state.
    }
  }
  if (state.lastFrame) {
    els.cropImage.src = state.lastFrame;
    els.cropImage.hidden = false;
    els.cropEmpty.hidden = true;
    if (state.lastFrameSize && state.lastFrameSize.width && state.lastFrameSize.height) {
      els.cropStage.style.aspectRatio = `${state.lastFrameSize.width} / ${state.lastFrameSize.height}`;
    }
  } else {
    els.cropImage.removeAttribute('src');
    els.cropImage.hidden = true;
    els.cropEmpty.hidden = false;
    els.cropStage.style.aspectRatio = '';
  }
  renderCropEditor();
  openDrawer('settings');
  els.setBaseUrl.focus();
}

function showSettingsError(code, message) {
  els.settingsError.hidden = false;
  els.settingsError.dataset.code = code;
  els.settingsError.textContent = `${code}：${message}`;
}

function renderCropEditor() {
  const hasImage = Boolean(els.cropImage.getAttribute('src'));
  els.cropImage.hidden = !hasImage;
  els.cropEmpty.hidden = hasImage;
  const crop = state.cropDraft;
  if (!hasImage || !crop) {
    els.cropRect.hidden = true;
    els.cropValue.textContent = '全图';
    return;
  }
  els.cropRect.hidden = false;
  els.cropRect.style.left = `${crop.x * 100}%`;
  els.cropRect.style.top = `${crop.y * 100}%`;
  els.cropRect.style.width = `${crop.w * 100}%`;
  els.cropRect.style.height = `${crop.h * 100}%`;
  els.cropValue.textContent = `x ${(crop.x * 100).toFixed(0)}% · y ${(crop.y * 100).toFixed(0)}% · 宽 ${(crop.w * 100).toFixed(0)}% · 高 ${(crop.h * 100).toFixed(0)}%`;
}

function cropPoint(event) {
  const rect = els.cropStage.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function updateCropFromPoint(point) {
  const drag = state.cropDrag;
  if (!drag || !point) return;
  const x = Math.min(drag.x, point.x);
  const y = Math.min(drag.y, point.y);
  const w = Math.max(0.01, Math.abs(point.x - drag.x));
  const h = Math.max(0.01, Math.abs(point.y - drag.y));
  state.cropDraft = { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
  renderCropEditor();
}

async function saveSettings(event) {
  event.preventDefault();
  if (!state.ready) {
    showSettingsError('NO_BRIDGE', '未检测到桌面接口。');
    return;
  }
  const baseUrl = els.setBaseUrl.value.trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    showSettingsError('SETTINGS_INVALID', '接口地址需以 http:// 或 https:// 开头。');
    els.setBaseUrl.focus();
    return;
  }
  const interval = clamp(Math.round(Number(els.setInterval.value) || DEFAULT_INTERVAL), MIN_INTERVAL, MAX_INTERVAL);
  const sensitivity = clamp(Math.round(Number(els.setSensitivity.value) || 3), 1, 5);
  const apiKey = els.setApiKey.value.trim();

  initEnsembleForm();
  const visionBase = els.visionBase.value.trim();
  const visionKey = els.visionKey.value.trim();
  const visionModelInput = readModelValue('vision-model');
  if (!validHttpUrl(visionBase)) {
    showSettingsError('SETTINGS_INVALID', '视觉 Base URL 需以 http:// 或 https:// 开头。');
    els.visionBase.focus();
    return;
  }
  if (!validModel(visionModelInput)) {
    showSettingsError('SETTINGS_INVALID', '视觉模型名只能包含字母、数字与 . _ : @ / + -。');
    focusModelField('vision-model');
    return;
  }

  const fields = els.ensembleFields;
  const candidatePatch = [];
  const candidateCount = fields ? fields.candidates.length : 0;
  for (let index = 0; index < candidateCount; index += 1) {
    const slot = fields.candidates[index];
    const slotBase = slot.base.value.trim();
    const slotModel = readModelValue(`cand-${index}-model`);
    const slotKey = slot.key.value.trim();
    const rawTemp = slot.temp.value.trim();
    const temperature = rawTemp === '' ? DEFAULT_CANDIDATES[index].temperature : Number(rawTemp);
    if (!validHttpUrl(slotBase)) {
      showSettingsError('SETTINGS_INVALID', `候选 ${index + 1} 的 Base URL 需以 http:// 或 https:// 开头。`);
      slot.base.focus();
      return;
    }
    if (!validModel(slotModel)) {
      showSettingsError('SETTINGS_INVALID', `候选 ${index + 1} 的模型名只能包含字母、数字与 . _ : @ / + -。`);
      focusModelField(`cand-${index}-model`);
      return;
    }
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      showSettingsError('SETTINGS_INVALID', `候选 ${index + 1} 的温度需在 0–2 之间。`);
      slot.temp.focus();
      return;
    }
    const entry = { name: slot.name.value.trim(), baseUrl: slotBase, model: slotModel, temperature };
    if (slotKey) entry.apiKey = slotKey;
    candidatePatch.push(entry);
  }

  let judgePatch = null;
  if (fields && fields.judge) {
    const slot = fields.judge;
    const slotBase = slot.base.value.trim();
    const slotModel = readModelValue('judge-model');
    const slotKey = slot.key.value.trim();
    const rawTemp = slot.temp.value.trim();
    const temperature = rawTemp === '' ? DEFAULT_JUDGE.temperature : Number(rawTemp);
    if (!validHttpUrl(slotBase)) {
      showSettingsError('SETTINGS_INVALID', '评审的 Base URL 需以 http:// 或 https:// 开头。');
      slot.base.focus();
      return;
    }
    if (!validModel(slotModel)) {
      showSettingsError('SETTINGS_INVALID', '评审的模型名只能包含字母、数字与 . _ : @ / + -。');
      focusModelField('judge-model');
      return;
    }
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      showSettingsError('SETTINGS_INVALID', '评审的温度需在 0–2 之间。');
      slot.temp.focus();
      return;
    }
    judgePatch = { name: slot.name.value.trim(), baseUrl: slotBase, model: slotModel, temperature };
    if (slotKey) judgePatch.apiKey = slotKey;
  }

  const ensembleEnabled = els.setEnsembleEnabled.checked;
  if (ensembleEnabled) {
    const configured = candidatePatch.filter((item) => item.model).length;
    if (configured < 2) {
      showSettingsError('BAD_REQUEST', '交叉验证需要至少 2 个候选模型。');
      return;
    }
  }

  const aiPatch = {};
  const textModelValue = readModelValue('set-model');
  const visionModelValue = readModelValue('set-vision');
  if (!validModel(textModelValue)) {
    showSettingsError('SETTINGS_INVALID', '文本模型名只能包含字母、数字与 . _ : @ / + -。');
    focusModelField('set-model');
    return;
  }
  if (!validModel(visionModelValue)) {
    showSettingsError('SETTINGS_INVALID', '视觉模型名只能包含字母、数字与 . _ : @ / + -。');
    focusModelField('set-vision');
    return;
  }
  if (baseUrl) aiPatch.baseUrl = baseUrl;
  if (textModelValue) aiPatch.model = textModelValue;
  if (visionModelValue) aiPatch.visionModel = visionModelValue;
  if (apiKey) aiPatch.apiKey = apiKey;

  const visionPatch = { baseUrl: visionBase, model: visionModelInput };
  if (visionKey) visionPatch.apiKey = visionKey;
  aiPatch.vision = visionPatch;
  const ensemblePatch = { enabled: ensembleEnabled, candidates: candidatePatch };
  if (judgePatch) ensemblePatch.judge = judgePatch;
  aiPatch.ensemble = ensemblePatch;

  const patch = {
    ai: aiPatch,
    auto: {
      enabled: els.setAutoEnabled.checked,
      autoAnswer: els.setAutoAnswer.checked,
      intervalMs: interval,
      sensitivity,
      crop: state.cropDraft ? { ...state.cropDraft } : null,
    },
    style: currentStyle(),
  };

  els.settingsError.hidden = true;
  const button = $('btn-save-settings');
  button.disabled = true;
  try {
    const next = await call('updateSettings', patch);
    if (next && next.settings) applyState(next);
    els.setApiKey.value = '';
    const updated = state.settings.ai;
    els.setKeyHint.textContent = updated.hasApiKey ? '已保存密钥（留空表示不修改）' : '未配置密钥，当前为演示模式';
    renderEnsembleForm();
    state.cropDraft = currentCrop();
    renderCropEditor();
    showToast('设置已保存。', 'info');
    // 保存成功后立刻用已保存的配置验证一次（Key 输入框已清空，走 saved key）。
    void runProbe();
  } catch (error) {
    const info = toUiError(error);
    showSettingsError(info.code, describeError(info.code, info));
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* connection self-check (CONTRACT-PROBE §3)                           */
/* ------------------------------------------------------------------ */

const PROBE_KEY_DEBOUNCE_MS = 1000;
const PROBE_FIELD_DEBOUNCE_MS = 800;
const PROBE_KEY_MIN_LENGTH = 8;

/** 与 electron/probe.js 的错误码保持一致；中文说明由界面兜底，不信任上游文案。 */
const CONN_CODE_TEXT = {
  AUTH: '密钥无效或已过期',
  PLAN: '该模型不在当前订阅计划内',
  MODEL_NOT_FOUND: '模型不存在或端点不匹配',
  RATE_LIMITED: '请求过于频繁，稍后再试',
  TIMEOUT: '连接超时，请检查网络或端点',
  NETWORK: '网络不可达，请检查网络或端点',
  NO_KEY: '未填写 API Key',
  UPSTREAM: '上游服务返回错误',
};

const CONN_ROLE_TEXT = { text: '文本', vision: '视觉', candidate: '候选', judge: '评审' };

const PROBE_MODEL_IDS = new Set([
  'set-model',
  'vision-model',
  'set-model-custom',
  'set-vision-custom',
  'vision-model-custom',
]);

function isProbeModelField(id) {
  if (typeof id !== 'string' || !id) return false;
  if (PROBE_MODEL_IDS.has(id)) return true;
  return /^(cand-[0-9]+|judge)-model(-custom)?$/.test(id);
}

function formApiKey() {
  return els.setApiKey ? els.setApiKey.value.trim() : '';
}

/** 表单或已保存设置里是否存在任何可用 Key（决定「演示模式」还是「尚未验证」）。 */
function formHasAnyKey() {
  if (formApiKey()) return true;
  const ai = state.settings.ai;
  if (ai.hasApiKey || ai.vision.hasApiKey) return true;
  if (ai.vision.keySource && ai.vision.keySource !== 'none') return true;
  const savedSlots = [...(ai.ensemble.candidates || []), ai.ensemble.judge];
  if (savedSlots.some((slot) => slot && slot.keySource && slot.keySource !== 'none')) return true;
  if (els.visionKey && els.visionKey.value.trim()) return true;
  const fields = els.ensembleFields;
  if (fields && [...fields.candidates, fields.judge].some((slot) => slot.key.value.trim())) return true;
  return false;
}

/** 把界面上所有明文 Key 从待渲染文本中抹掉，避免任何路径漏出。 */
function redactSecrets(text) {
  if (!text) return '';
  let out = String(text);
  const secrets = [formApiKey()];
  if (els.visionKey) secrets.push(els.visionKey.value.trim());
  if (els.ensembleFields) {
    for (const slot of [...els.ensembleFields.candidates, els.ensembleFields.judge]) {
      secrets.push(slot.key.value.trim());
    }
  }
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('••••');
  }
  return out;
}

function probeSupported() {
  const api = window.aqs;
  return Boolean(api && typeof api.testConnection === 'function');
}

function probeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 只读表单，绝不落盘：未保存的 Key / 端点 / 候选都直接进 patch。 */
function buildProbePatch() {
  initEnsembleForm();
  const fields = els.ensembleFields;
  const ai = {};
  const baseUrl = els.setBaseUrl.value.trim();
  const apiKey = formApiKey();
  const textModel = readModelValue('set-model');
  const visionModel = readModelValue('set-vision');
  if (baseUrl) ai.baseUrl = baseUrl;
  if (apiKey) ai.apiKey = apiKey;
  if (textModel) ai.model = textModel;
  if (visionModel) ai.visionModel = visionModel;

  const vision = {
    baseUrl: els.visionBase ? els.visionBase.value.trim() : '',
    model: readModelValue('vision-model'),
  };
  const visionKey = els.visionKey ? els.visionKey.value.trim() : '';
  if (visionKey) vision.apiKey = visionKey;
  ai.vision = vision;

  if (fields) {
    const candidates = fields.candidates.map((slot, index) => {
      const entry = {
        name: slot.name.value.trim(),
        baseUrl: slot.base.value.trim(),
        model: readModelValue(`cand-${index}-model`),
        temperature: probeNumber(slot.temp.value.trim(), DEFAULT_CANDIDATES[index].temperature),
      };
      const key = slot.key.value.trim();
      if (key) entry.apiKey = key;
      return entry;
    });
    const judgeSlot = fields.judge;
    const judge = {
      name: judgeSlot.name.value.trim(),
      baseUrl: judgeSlot.base.value.trim(),
      model: readModelValue('judge-model'),
      temperature: probeNumber(judgeSlot.temp.value.trim(), DEFAULT_JUDGE.temperature),
    };
    const judgeKey = judgeSlot.key.value.trim();
    if (judgeKey) judge.apiKey = judgeKey;
    ai.ensemble = { candidates, judge };
  }

  return { ai };
}

/** 端点格式非法时先拦住，避免每次都拿到 BAD_REQUEST。 */
function probeInputProblem() {
  const base = els.setBaseUrl.value.trim();
  if (!validHttpUrl(base)) return '接口地址需以 http:// 或 https:// 开头';
  const visionBase = els.visionBase ? els.visionBase.value.trim() : '';
  if (!validHttpUrl(visionBase)) return '视觉 Base URL 需以 http:// 或 https:// 开头';
  const fields = els.ensembleFields;
  if (fields && [...fields.candidates, fields.judge].some((slot) => !validHttpUrl(slot.base.value.trim()))) {
    return '自定义 Base URL 需以 http:// 或 https:// 开头';
  }
  return '';
}

function clearProbeTimer() {
  if (state.probe.timer) {
    clearTimeout(state.probe.timer);
    state.probe.timer = 0;
  }
}

function scheduleProbe(delayMs = PROBE_FIELD_DEBOUNCE_MS) {
  clearProbeTimer();
  state.probe.timer = setTimeout(() => {
    state.probe.timer = 0;
    void runProbe();
  }, Math.max(0, delayMs));
}

function setProbeStatus(stateName, text) {
  if (!els.connStatus) return;
  els.connStatus.dataset.state = stateName;
  els.connStatus.textContent = text;
}

function setProbeTesting(flag) {
  if (!els.testConnection) return;
  els.testConnection.disabled = flag;
  els.testConnection.dataset.testing = String(flag);
  if (flag) els.testConnection.setAttribute('aria-busy', 'true');
  else els.testConnection.removeAttribute('aria-busy');
}

function clearProbeResults() {
  if (els.connResultsList) els.connResultsList.replaceChildren();
  if (els.connResultsSummary) els.connResultsSummary.textContent = '检测详情';
  if (els.connResults) {
    els.connResults.open = false;
    els.connResults.hidden = true;
  }
}

function renderProbeDemo() {
  setProbeTesting(false);
  clearProbeResults();
  state.probe.hasResult = false;
  setProbeStatus('demo', '未填写 API Key，当前为演示模式');
}

function renderProbeFailure(reason) {
  setProbeTesting(false);
  clearProbeResults();
  state.probe.hasResult = true;
  setProbeStatus('error', `连接失败：${redactSecrets(reason) || '连接失败'}`);
}

function renderProbeTesting() {
  setProbeTesting(true);
  clearProbeResults();
  setProbeStatus('testing', '正在验证连接…');
}

/** 打开设置后回到未测试状态（不发起请求）。 */
function syncProbeIdle() {
  if (state.probe.timer || state.probe.hasResult) return;
  setProbeTesting(false);
  if (formHasAnyKey()) setProbeStatus('idle', '尚未验证连接');
  else renderProbeDemo();
}

function connReasonText(result) {
  if (!result || typeof result !== 'object') return '连接失败';
  const code = typeof result.code === 'string' ? result.code : '';
  const known = CONN_CODE_TEXT[code];
  if (known) return known;
  const message = typeof result.message === 'string' ? result.message.trim() : '';
  return redactSecrets(message) || '连接失败';
}

function connResultText(result) {
  if (result.ok === true) return '✓ 可用';
  const code = typeof result.code === 'string' && result.code ? result.code : 'UPSTREAM';
  const status = Number(result.status);
  const statusText = Number.isFinite(status) ? `（${status}）` : '';
  return `✗ ${code}${statusText} ${connReasonText(result)}`;
}

function normalizeProbeReport(raw) {
  const list = raw && Array.isArray(raw.results) ? raw.results : [];
  const results = list.filter((item) => item && typeof item === 'object');
  const total = results.length;
  const okCount = results.filter((item) => item.ok === true).length;
  const summary = raw && raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
  const slowest = results.reduce((max, item) => Math.max(max, probeNumber(item.latencyMs, 0)), 0);
  const latency = probeNumber(summary.latencyMs, slowest);
  return {
    results,
    total,
    okCount,
    failed: total - okCount,
    latency: Math.max(0, Math.round(latency)),
    reason: typeof (raw && raw.reason) === 'string' ? raw.reason : '',
    ok: !raw || raw.ok !== false,
  };
}

function renderProbeResults(report) {
  if (!els.connResults || !els.connResultsList) return;
  const fragment = document.createDocumentFragment();
  let candidateIndex = 0;
  for (const result of report.results) {
    const role = typeof result.role === 'string' ? result.role : 'text';
    let roleText = CONN_ROLE_TEXT[role] || '模型';
    if (role === 'candidate') {
      roleText = `候选 ${String.fromCharCode(65 + Math.min(candidateIndex, 25))}`;
      candidateIndex += 1;
    }

    const row = document.createElement('div');
    row.className = 'conn-result';
    row.setAttribute('data-testid', 'conn-result');
    row.dataset.role = role;
    row.dataset.ok = String(result.ok === true);

    const roleEl = document.createElement('span');
    roleEl.className = 'conn-result-role';
    roleEl.textContent = roleText;

    const modelEl = document.createElement('span');
    modelEl.className = 'conn-result-model';
    const model = typeof result.model === 'string' ? result.model.trim() : '';
    modelEl.textContent = redactSecrets(model) || '默认模型';
    modelEl.title = modelEl.textContent;

    const timeEl = document.createElement('span');
    timeEl.className = 'conn-result-time';
    const latency = Number(result.latencyMs);
    timeEl.textContent = Number.isFinite(latency) ? `${Math.max(0, Math.round(latency))}ms` : '—';

    const stateEl = document.createElement('span');
    stateEl.className = 'conn-result-state';
    stateEl.textContent = connResultText(result);

    row.append(roleEl, modelEl, timeEl, stateEl);
    fragment.append(row);
  }

  els.connResultsList.replaceChildren(fragment);
  els.connResults.hidden = false;
  els.connResults.open = true;
  if (els.connResultsSummary) {
    els.connResultsSummary.textContent = `检测详情 · ${report.okCount}/${report.total} 可用`;
  }
}

function renderProbeResult(raw) {
  setProbeTesting(false);
  const report = normalizeProbeReport(raw);
  state.probe.hasResult = true;

  if (report.reason === 'DEMO' || report.reason === 'NO_KEY') {
    renderProbeDemo();
    return;
  }
  if (report.total === 0) {
    if (report.ok) {
      clearProbeResults();
      setProbeStatus('ok', '已连接 · 未发现可测试的模型');
    } else {
      renderProbeFailure('未返回可用的检测结果');
    }
    return;
  }

  if (report.failed === 0) {
    setProbeStatus('ok', `已连接 · ${report.okCount}/${report.total} 个模型可用 · ${report.latency}ms`);
  } else if (report.okCount > 0) {
    setProbeStatus('partial', `部分模型不可用（${report.failed}/${report.total}）`);
  } else {
    const firstFailure = report.results.find((item) => item.ok !== true) || null;
    setProbeStatus('error', `连接失败：${connReasonText(firstFailure)}`);
  }
  renderProbeResults(report);
}

async function runProbe({ manual = false } = {}) {
  clearProbeTimer();

  const typedKey = formApiKey();
  if (typedKey && typedKey.length < PROBE_KEY_MIN_LENGTH) {
    setProbeTesting(false);
    setProbeStatus('idle', `API Key 至少需要 ${PROBE_KEY_MIN_LENGTH} 位字符`);
    return;
  }
  if (!formHasAnyKey()) {
    renderProbeDemo();
    return;
  }
  const problem = probeInputProblem();
  if (problem) {
    renderProbeFailure(problem);
    return;
  }
  if (!probeSupported()) {
    if (manual) renderProbeFailure('当前桌面版本不支持连接自检');
    return;
  }

  const patch = buildProbePatch();
  const token = (state.probe.seq += 1);
  renderProbeTesting();
  let raw;
  try {
    raw = await window.aqs.testConnection(patch);
  } catch (error) {
    if (token !== state.probe.seq) return;
    const info = toUiError(error, 'testConnection');
    renderProbeFailure(describeError(info.code, info));
    return;
  }
  if (token !== state.probe.seq) return;
  renderProbeResult(raw);
}

function onProbeKeyInput() {
  clearProbeTimer();
  const key = formApiKey();
  if (!key) {
    state.probe.hasResult = false;
    clearProbeResults();
    if (formHasAnyKey()) setProbeStatus('idle', '留空将沿用已保存的密钥');
    else renderProbeDemo();
    return;
  }
  if (key.length < PROBE_KEY_MIN_LENGTH) {
    state.probe.hasResult = false;
    clearProbeResults();
    setProbeTesting(false);
    setProbeStatus('idle', `API Key 至少需要 ${PROBE_KEY_MIN_LENGTH} 位字符`);
    return;
  }
  scheduleProbe(PROBE_KEY_DEBOUNCE_MS);
}

async function persistAuto(patch) {
  if (!state.ready) {
    renderAuto();
    return;
  }
  try {
    const next = await call('setAuto', patch);
    if (next && next.settings) applyState(next);
    else renderAuto();
  } catch (error) {
    showError(error);
    renderAuto();
  }
}

async function togglePause() {
  if (!state.ready) return;
  const next = !isPaused();
  try {
    const nextState = await call('setPaused', next);
    if (nextState && nextState.settings) applyState(nextState);
    else {
      state.runtime.paused = next;
      renderAuto();
      renderStatus();
      renderBusy();
    }
    showToast(next ? '已暂停自动检测。' : '已继续自动检测。', 'info');
  } catch (error) {
    showError(error);
  }
}

async function selectStyle(style) {
  if (!STYLE_LABELS[style] || style === currentStyle()) return;
  const previous = currentStyle();
  state.settings.style = style;
  renderStyle();
  try {
    const next = await call('updateSettings', { style });
    if (next && next.settings) applyState(next);
  } catch (error) {
    state.settings.style = previous;
    renderStyle();
    showError(error);
    return;
  }
  renderStyle();
  if (state.question.text && state.answerText && !state.streaming) {
    await startAnswer();
  }
}

/* ------------------------------------------------------------------ */
/* source picker                                                       */
/* ------------------------------------------------------------------ */

function openDrawer(kind) {
  closeDrawers();
  state.drawer = kind;
  if (kind === 'history') {
    els.historyDrawer.hidden = false;
    els.historyDrawer.classList.add('is-open');
  } else if (kind === 'settings') {
    els.settingsDrawer.hidden = false;
    els.settingsDrawer.classList.add('is-open');
  }
}

function closeDrawers() {
  state.drawer = '';
  // 关闭（含 Esc）不清结果，只停掉尚未触发的自动测试计时。
  clearProbeTimer();
  els.historyDrawer.hidden = true;
  els.historyDrawer.classList.remove('is-open');
  els.settingsDrawer.hidden = true;
  els.settingsDrawer.classList.remove('is-open');
  if (state.historyClearArmedAt) {
    state.historyClearArmedAt = 0;
    els.clearHistory.textContent = '清空';
  }
}

function openHistory() {
  renderHistory();
  openDrawer('history');
  els.closeHistory.focus();
}

async function openSourcePicker() {
  closeDrawers();
  state.drawer = 'picker';
  els.picker.hidden = false;
  els.pickerEmpty.hidden = true;
  els.pickerList.textContent = '';
  els.pickerStatus.dataset.state = 'loading';
  els.pickerStatus.textContent = '正在读取窗口列表…';
  renderPermission();
  els.refreshSources.focus();
  await loadSources();
}

function closeSourcePicker() {
  els.picker.hidden = true;
  els.pickerList.textContent = '';
  if (state.drawer === 'picker') state.drawer = '';
  els.pickSource.focus();
}

async function loadSources() {
  if (!state.ready) {
    els.pickerStatus.dataset.state = 'error';
    els.pickerStatus.textContent = 'NO_BRIDGE：未检测到桌面接口。';
    return;
  }
  els.refreshSources.disabled = true;
  els.pickerStatus.dataset.state = 'loading';
  els.pickerStatus.textContent = '正在读取窗口列表…';
  try {
    const sources = await call('listSources');
    const list = Array.isArray(sources) ? sources : [];
    renderSources(list);
  } catch (error) {
    const info = toUiError(error);
    els.pickerStatus.dataset.state = 'error';
    els.pickerStatus.textContent = `${info.code}：${describeError(info.code, info)}`;
    els.pickerEmpty.hidden = false;
  } finally {
    els.refreshSources.disabled = false;
  }
}

function renderSources(sources) {
  els.pickerList.textContent = '';
  const list = sources.filter((source) => source && typeof source.id === 'string' && source.id);
  list.sort((left, right) => Number(Boolean(right.isBrowser)) - Number(Boolean(left.isBrowser)));
  const browsers = list.filter((source) => source.isBrowser).length;

  if (!list.length) {
    els.pickerEmpty.hidden = false;
    els.pickerStatus.dataset.state = 'empty';
    els.pickerStatus.textContent = '没有找到可采集的窗口。';
    return;
  }

  els.pickerEmpty.hidden = true;
  els.pickerStatus.dataset.state = 'ready';
  els.pickerStatus.textContent = `共 ${list.length} 个来源，其中 ${browsers} 个浏览器窗口（已置顶）。`;

  for (const source of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'source-card';
    card.dataset.kind = source.kind === 'screen' ? 'screen' : 'window';
    if (source.id === state.settings.capture.sourceId) card.dataset.selected = 'true';

    const thumb = document.createElement('span');
    thumb.className = 'source-thumb';
    if (typeof source.thumbnail === 'string' && source.thumbnail.startsWith('data:image/')) {
      const image = document.createElement('img');
      image.src = source.thumbnail;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      thumb.append(image);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'source-thumb-empty';
      placeholder.textContent = source.kind === 'screen' ? '屏幕' : '窗口';
      thumb.append(placeholder);
    }

    const name = document.createElement('span');
    name.className = 'source-card-name';
    name.textContent = source.name || '未命名窗口';
    name.title = source.name || '未命名窗口';

    const tags = document.createElement('span');
    tags.className = 'source-tags';
    if (source.isBrowser) {
      const tag = document.createElement('span');
      tag.className = 'chip chip-mini chip-accent';
      tag.textContent = '浏览器';
      tags.append(tag);
    }
    const kind = document.createElement('span');
    kind.className = 'chip chip-mini';
    kind.textContent = source.kind === 'screen' ? '屏幕' : '窗口';
    tags.append(kind);

    card.append(thumb, name, tags);
    card.addEventListener('click', () => {
      void selectSource(source.id, source.name, card);
    });
    els.pickerList.append(card);
  }
}

async function selectSource(id, name, card) {
  if (!id) return;
  if (card) card.disabled = true;
  try {
    const result = await call('selectSource', id);
    if (result && result.ok === false) {
      throw new UiError('SOURCE_CLOSED', '该窗口已不可用，请刷新列表后重试。');
    }
    if (result && result.settings) {
      applyState(result);
    } else {
      const next = await call('getState');
      applyState(next);
    }
    closeSourcePicker();
    showToast(`已选择窗口：${name || currentSourceName()}`, 'info');
    await ensureCapture();
  } catch (error) {
    const info = toUiError(error);
    els.pickerStatus.dataset.state = 'error';
    els.pickerStatus.textContent = `${info.code}：${describeError(info.code, info)}`;
    if (card) card.disabled = false;
    showError(info);
  }
}

async function clearSourceSelection() {
  if (!state.ready) return;
  try {
    const next = await call('clearSource');
    if (next && next.settings) applyState(next);
    else {
      state.settings.capture = { sourceId: null, sourceName: '' };
      renderSource();
    }
    teardownCapture();
    state.sourceId = null;
    renderSource();
    showToast('已清除窗口选择。', 'info');
  } catch (error) {
    showError(error);
  }
}

/* ------------------------------------------------------------------ */
/* clipboard + permissions                                             */
/* ------------------------------------------------------------------ */

async function copyAnswer() {
  const text = state.answerText.trim();
  if (!text) {
    showToast('还没有可复制的答案。', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('答案已复制到剪贴板。', 'info');
    return;
  } catch {
    // Fall through to the selection-based fallback.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    showToast(copied ? '答案已复制到剪贴板。' : '复制失败，请手动选择答案文本。', copied ? 'info' : 'warn');
  } catch {
    showToast('复制失败，请手动选择答案文本。', 'warn');
  }
}

async function openScreenPermission() {
  if (!state.ready) return;
  try {
    await call('openScreenPermission');
    showToast('已打开系统设置，请允许屏幕录制后重启应用。', 'info', 4200);
  } catch (error) {
    showError(error);
  }
}

async function collapseTo(flag) {
  if (!state.ready) {
    state.collapsed = Boolean(flag);
    renderCollapsed();
    return;
  }
  try {
    const next = await call('collapse', Boolean(flag));
    if (next && next.settings) applyState(next);
    else {
      state.collapsed = Boolean(flag);
      renderCollapsed();
    }
  } catch (error) {
    showError(error);
  }
}

/* ------------------------------------------------------------------ */
/* expand self-heal                                                    */
/* ------------------------------------------------------------------ */

/*
 * 透明无边框窗口在 Windows 上可能忽略 resize：主进程说「已展开」，实际窗口
 * 仍是 56×96 的胶囊。这里按真实 window 尺寸复核，最多补两次展开请求。
 */
const EXPAND_RETRY_DELAY_MS = 300;
const EXPAND_RETRY_LIMIT = 2;
const EXPAND_MIN_SIDE = 200;

/** 无法测量（无 outerWidth/Height）时不做推定，避免误伤无头/测试环境。 */
function windowLooksExpanded() {
  const width = Number(window.outerWidth);
  const height = Number(window.outerHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return true;
  return width >= EXPAND_MIN_SIDE && height >= EXPAND_MIN_SIDE;
}

function resetExpandRetry() {
  if (state.expandRetryTimer) {
    clearTimeout(state.expandRetryTimer);
    state.expandRetryTimer = 0;
  }
  state.expandRetries = 0;
  state.expandGaveUp = false;
}

function scheduleExpandRetry() {
  if (state.collapsed || !state.ready || windowLooksExpanded()) {
    resetExpandRetry();
    return;
  }
  if (state.expandGaveUp || state.expandRetryTimer) return;
  state.expandRetryTimer = setTimeout(runExpandRetry, EXPAND_RETRY_DELAY_MS);
}

function runExpandRetry() {
  state.expandRetryTimer = 0;
  if (state.collapsed || !state.ready || windowLooksExpanded()) {
    resetExpandRetry();
    return;
  }
  if (state.expandRetries >= EXPAND_RETRY_LIMIT) {
    state.expandGaveUp = true;
    console.warn(
      `[aqs] 展开重试 ${EXPAND_RETRY_LIMIT} 次后窗口仍为 ${window.outerWidth}x${window.outerHeight}，请点击托盘图标或重启应用。`,
    );
    try {
      showToast('展开失败：窗口尺寸仍然异常，请点击托盘图标或重启应用。', 'error', 6000);
    } catch {
      // 提示失败不能影响状态记录。
    }
    return;
  }
  state.expandRetries += 1;
  console.warn(
    `[aqs] 窗口尺寸异常（${window.outerWidth}x${window.outerHeight}），第 ${state.expandRetries} 次重试展开。`,
  );
  try {
    showToast('警告：窗口尺寸异常，正在重试展开', 'warn', 2800);
  } catch {
    // 提示失败也不能阻断重试。
  }
  void collapseTo(false).finally(scheduleExpandRetry);
}

/** 用户主动展开：重置重试预算，避免上一次放弃后点击失效。 */
function requestExpand() {
  resetExpandRetry();
  void collapseTo(false);
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  // header
  els.collapse.addEventListener('click', () => {
    void collapseTo(true);
  });
  els.pill.addEventListener('click', () => {
    requestExpand();
  });
  els.pill.addEventListener('dblclick', (event) => {
    event.preventDefault();
    requestExpand();
  });
  els.settingsBtn.addEventListener('click', () => openSettings());
  els.historyBtn.addEventListener('click', () => openHistory());
  els.errorClose.addEventListener('click', () => clearError());

  // source row
  els.pickSource.addEventListener('click', () => {
    void openSourcePicker();
  });
  els.scan.addEventListener('click', () => {
    void manualScan();
  });
  els.clearSource.addEventListener('click', () => {
    void clearSourceSelection();
  });

  // question card
  els.questionText.addEventListener('input', () => {
    state.question.text = els.questionText.value;
    state.questionDirty = true;
    updateSubmitState();
  });
  els.questionText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      void startAnswer();
    }
  });
  els.saveQuestion.addEventListener('click', () => {
    const text = els.questionText.value.trim();
    state.question.text = text;
    state.questionDirty = false;
    els.questionText.value = text;
    renderQuestion();
    showToast(text ? '题目已保存。' : '题目为空。', text ? 'info' : 'warn');
  });
  els.toggleQuestion.addEventListener('click', () => {
    state.questionCollapsed = !state.questionCollapsed;
    els.questionCard.classList.toggle('is-collapsed', state.questionCollapsed);
    els.toggleQuestion.setAttribute('aria-expanded', String(!state.questionCollapsed));
    els.toggleQuestion.setAttribute('aria-label', state.questionCollapsed ? '展开题目' : '收起题目');
  });
  els.rerecognize.addEventListener('click', () => {
    void manualScan();
  });
  els.submit.addEventListener('click', () => {
    void startAnswer();
  });

  // answer card
  els.copy.addEventListener('click', () => {
    void copyAnswer();
  });
  els.stop.addEventListener('click', () => {
    void stopAnswer();
  });
  for (const button of els.styleButtons) {
    button.addEventListener('click', () => {
      void selectStyle(button.dataset.style);
    });
  }
  els.answerMd.addEventListener('click', (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') || '';
    if (href && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(href).then(
        () => showToast('链接已复制到剪贴板。', 'info'),
        () => showToast('无法打开外部链接。', 'warn'),
      );
    } else {
      showToast('无法打开外部链接。', 'warn');
    }
  });

  // auto bar
  els.autoEnabled.addEventListener('change', () => {
    void persistAuto({ enabled: els.autoEnabled.checked });
  });
  els.autoAnswer.addEventListener('change', () => {
    void persistAuto({ autoAnswer: els.autoAnswer.checked });
  });
  els.pause.addEventListener('click', () => {
    void togglePause();
  });
  els.ensembleToggle.addEventListener('change', () => {
    void toggleEnsemble(els.ensembleToggle.checked);
  });
  els.candidateList.addEventListener('click', (event) => {
    const head = event.target && event.target.closest ? event.target.closest('[data-candidate-index]') : null;
    if (!head) return;
    const index = Number(head.dataset.candidateIndex);
    if (Number.isInteger(index)) toggleCandidate(index);
  });
  els.sensitivity.addEventListener('input', () => {
    els.sensitivityLabel.textContent = describeSensitivity(els.sensitivity.value);
  });
  els.sensitivity.addEventListener('change', () => {
    void persistAuto({ sensitivity: clamp(Math.round(Number(els.sensitivity.value)), 1, 5) });
  });

  // scroller stick-to-bottom tracking
  els.scroller.addEventListener('scroll', () => {
    const distance = els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight;
    state.stickToBottom = distance < 48;
  });

  // history
  els.closeHistory.addEventListener('click', () => closeDrawers());
  els.clearHistory.addEventListener('click', () => {
    if (!state.historyClearArmedAt || Date.now() - state.historyClearArmedAt > 3000) {
      state.historyClearArmedAt = Date.now();
      els.clearHistory.textContent = '再点一次清空';
      showToast('再次点击「再点一次清空」将删除全部历史。', 'warn');
      return;
    }
    state.historyClearArmedAt = 0;
    els.clearHistory.textContent = '清空';
    clearHistory();
  });
  els.historyList.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-history-index]') : null;
    if (!button) return;
    const index = Number(button.dataset.historyIndex);
    if (Number.isInteger(index)) restoreHistory(index);
  });

  // settings
  els.closeSettings.addEventListener('click', () => closeDrawers());
  els.settingsForm.addEventListener('submit', (event) => {
    void saveSettings(event);
  });
  els.setSensitivity.addEventListener('input', () => {
    els.setSensitivityLabel.textContent = describeSensitivity(els.setSensitivity.value);
  });
  els.setBaseUrl.addEventListener('input', refreshModelSelectors);
  els.setBaseUrl.addEventListener('change', refreshModelSelectors);
  els.visionBase.addEventListener('input', refreshModelSelectors);
  els.ensembleSlots.addEventListener('input', (event) => {
    const target = event.target;
    if (target && typeof target.id === 'string' && target.id.endsWith('-base')) refreshModelSelectors();
  });

  // connection self-check triggers (CONTRACT-PROBE §3)
  if (els.testConnection) {
    els.testConnection.addEventListener('click', () => {
      void runProbe({ manual: true });
    });
  }
  els.setApiKey.addEventListener('input', onProbeKeyInput);
  els.settingsForm.addEventListener('change', (event) => {
    const target = event.target;
    const id = target && typeof target.id === 'string' ? target.id : '';
    if (isProbeModelField(id)) scheduleProbe(PROBE_FIELD_DEBOUNCE_MS);
  });
  els.settingsForm.addEventListener('input', (event) => {
    const target = event.target;
    const id = target && typeof target.id === 'string' ? target.id : '';
    const endpointChanged = id === 'set-base-url' || id.endsWith('-base');
    const customModelChanged = id.endsWith('-custom') && isProbeModelField(id);
    if (endpointChanged || customModelChanged) scheduleProbe(PROBE_FIELD_DEBOUNCE_MS);
  });
  for (const button of els.presetButtons) {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  }
  els.ensembleClear.addEventListener('click', () => clearEnsembleCandidates());
  els.cropReset.addEventListener('click', () => {
    state.cropDraft = null;
    state.cropDrag = null;
    renderCropEditor();
  });
  els.cropImage.addEventListener('load', () => {
    const width = els.cropImage.naturalWidth;
    const height = els.cropImage.naturalHeight;
    if (width && height) els.cropStage.style.aspectRatio = `${width} / ${height}`;
    renderCropEditor();
  });
  els.cropStage.addEventListener('pointerdown', (event) => {
    if (els.cropImage.hidden) return;
    const point = cropPoint(event);
    if (!point) return;
    event.preventDefault();
    state.cropDrag = { x: point.x, y: point.y, pointerId: event.pointerId, before: state.cropDraft };
    state.cropDraft = { x: point.x, y: point.y, w: 0.01, h: 0.01 };
    renderCropEditor();
    if (typeof els.cropStage.setPointerCapture === 'function') {
      try {
        els.cropStage.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; pointermove still fires inside the stage.
      }
    }
  });
  els.cropStage.addEventListener('pointermove', (event) => {
    if (!state.cropDrag) return;
    const point = cropPoint(event);
    if (point) updateCropFromPoint(point);
  });
  const endCropDrag = () => {
    if (!state.cropDrag) return;
    const drag = state.cropDrag;
    state.cropDrag = null;
    if (drag.pointerId != null && typeof els.cropStage.releasePointerCapture === 'function') {
      try {
        els.cropStage.releasePointerCapture(drag.pointerId);
      } catch {
        // Already released by the browser.
      }
    }
    const crop = state.cropDraft;
    if (!crop || crop.w < 0.04 || crop.h < 0.04) {
      state.cropDraft = drag.before || null;
    }
    renderCropEditor();
  };
  els.cropStage.addEventListener('pointerup', endCropDrag);
  els.cropStage.addEventListener('pointercancel', endCropDrag);
  els.screenPermission.addEventListener('click', () => {
    void openScreenPermission();
  });
  els.bannerPermission.addEventListener('click', () => {
    void openScreenPermission();
  });

  // source picker
  els.closePicker.addEventListener('click', () => closeSourcePicker());
  els.cancelPicker.addEventListener('click', () => closeSourcePicker());
  els.refreshSources.addEventListener('click', () => {
    void loadSources();
  });
  els.pickerPermission.addEventListener('click', () => {
    void openScreenPermission();
  });
  els.picker.addEventListener('click', (event) => {
    if (event.target === els.picker) closeSourcePicker();
  });

  // keyboard: Esc closes overlays, Enter scans, Ctrl/Cmd+Enter answers
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.picker.hidden) {
        event.preventDefault();
        closeSourcePicker();
        return;
      }
      if (state.drawer) {
        event.preventDefault();
        closeDrawers();
        return;
      }
      if (!els.error.hidden) clearError();
      return;
    }

    const target = event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    const typing =
      tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || Boolean(target && target.isContentEditable);
    if (event.key !== 'Enter') return;

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      void startAnswer();
      return;
    }
    if (typing || state.drawer || !els.picker.hidden) return;
    event.preventDefault();
    void manualScan();
  });

  const cleanup = () => {
    if (state.offEvent) {
      try {
        state.offEvent();
      } catch {
        // Listener removal must never block teardown.
      }
      state.offEvent = null;
    }
    if (state.scheduler) {
      clearInterval(state.scheduler);
      state.scheduler = 0;
    }
    teardownCapture();
  };
  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function showNoBridge() {
  els.noBridge.hidden = false;
  els.app.hidden = true;
  document.body.classList.add('no-bridge-mode');
}

async function init() {
  bindEvents();
  initEnsembleForm();
  state.history = loadHistory();
  renderHistory();

  if (!window.aqs || typeof window.aqs.getState !== 'function') {
    showNoBridge();
    return;
  }

  try {
    const off = window.aqs.onEvent((event) => {
      try {
        handleEvent(event);
      } catch (error) {
        reportUnexpected(error);
      }
    });
    state.offEvent = typeof off === 'function' ? off : null;
  } catch (error) {
    showError(toUiError(error, 'onEvent'));
  }

  try {
    const initial = await call('getState');
    if (initial && initial.settings) {
      state.ready = true;
      applyState(initial);
    } else {
      throw new UiError('INTERNAL', '桌面接口返回的状态为空。');
    }
  } catch (error) {
    showError(error);
    state.ready = false;
    renderAll();
    return;
  }

  renderAll();
  await ensureCapture();
  startScheduler();
  updateCountdown();

  // Optional math enhancement: inject after the load event so a slow or
  // unreachable CDN can never delay the window's first paint or load signal.
  const enhanceMath = () => {
    loadKatex({ timeoutMs: 6000 }).then((loaded) => {
      if (loaded && state.answerText) renderAnswer();
    });
  };
  if (document.readyState === 'complete') {
    setTimeout(enhanceMath, 600);
  } else {
    window.addEventListener('load', () => setTimeout(enhanceMath, 600), { once: true });
  }
}

void init().catch((error) => {
  showError(toUiError(error, 'init'));
});
