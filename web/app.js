/**
 * AI 答题系统 — single-page front end.
 * Plain ES modules, no framework, no build step. All network calls are guarded;
 * failures surface in the inline error bar instead of dialogs.
 */

import { renderMarkdown, loadKatex } from './render.js';

const HISTORY_KEY = 'aqs.history.v1';
const HISTORY_LIMIT = 20;
const MAX_OPTION_LETTERS = 26;

const STYLE_LABELS = { concise: '简洁', detailed: '详细', step: '逐步讲解' };
const QUESTION_TYPES = ['choice', 'blank', 'short', 'unknown'];
const SUPPORTED_IMAGE = /^image\/(png|jpe?g|webp|gif)$/i;

const DEFAULT_CONFIG = {
  mode: 'unknown',
  models: { chat: '', visionModel: '' },
  limits: { maxImageBytes: 8 * 1024 * 1024, maxQuestionChars: 8000, maxOptions: 10 },
  styles: ['concise', 'detailed', 'step'],
  ensemble: { enabled: false, available: false, reason: '正在读取交叉验证配置…', candidates: [], judge: null },
};

const $ = (id) => document.getElementById(id);

const elements = {
  modeBadge: $('mode-badge'),
  modeBanner: $('mode-banner'),
  errorBar: $('error-bar'),
  errorText: $('error-text'),
  errorRetry: $('error-retry'),
  errorClose: $('error-close'),
  dropZone: $('drop-zone'),
  dropHint: $('drop-hint'),
  previewWrap: $('preview-wrap'),
  preview: $('preview'),
  previewMeta: $('preview-meta'),
  fileInput: $('file-input'),
  captureBtn: $('capture-btn'),
  recognizeBtn: $('recognize-btn'),
  resetImageBtn: $('reset-image-btn'),
  captureStatus: $('capture-status'),
  captureVideo: $('capture-video'),
  restoreBtn: $('restore-btn'),
  questionInput: $('question-input'),
  questionCount: $('question-count'),
  subjectInput: $('subject-input'),
  typeSelect: $('type-select'),
  optionList: $('option-list'),
  optionEmpty: $('option-empty'),
  addOptionBtn: $('add-option-btn'),
  styleSelect: $('style-select'),
  ensembleToggle: $('ensemble-toggle'),
  ensembleCheckbox: $('ensemble-checkbox'),
  ensembleHint: $('ensemble-hint'),
  candidates: $('candidates'),
  candidateList: $('candidate-list'),
  candidatesCount: $('candidates-count'),
  judgeRow: $('judge-row'),
  judgeDot: $('judge-dot'),
  judgeLabel: $('judge-label'),
  judgeTime: $('judge-time'),
  ensembleWarning: $('ensemble-warning'),
  submitBtn: $('submit-btn'),
  stopBtn: $('stop-btn'),
  demoChip: $('demo-chip'),
  cachedChip: $('cached-chip'),
  answerMeta: $('answer-meta'),
  copyBtn: $('copy-btn'),
  answerPanel: $('answer-panel'),
  answerMd: $('answer-md'),
  answerStatus: $('answer-status'),
  clearHistoryBtn: $('clear-history-btn'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
};

class AppError extends Error {
  constructor(message, code, status) {
    super(message || '请求失败');
    this.name = 'AppError';
    this.code = code || '';
    this.status = status || 0;
  }
}

const state = {
  config: cloneDefaults(),
  image: null,
  recognized: null,
  answerRaw: '',
  streaming: false,
  busyRecognize: false,
  busyCapture: false,
  controller: null,
  stickToBottom: true,
  history: [],
  errorRetry: null,
  answerModel: '',
  lastDone: null,
  configLoaded: false,
  ensembleTouched: false,
  ensembleUsed: false,
  candidateTotal: 0,
  candidates: [],
  judge: null,
  fallback: false,
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function cloneDefaults() {
  return {
    mode: DEFAULT_CONFIG.mode,
    models: { ...DEFAULT_CONFIG.models },
    limits: { ...DEFAULT_CONFIG.limits },
    styles: [...DEFAULT_CONFIG.styles],
    ensemble: {
      enabled: DEFAULT_CONFIG.ensemble.enabled,
      available: DEFAULT_CONFIG.ensemble.available,
      reason: DEFAULT_CONFIG.ensemble.reason,
      candidates: [],
      judge: null,
    },
  };
}

function letterFor(index) {
  return String.fromCharCode(65 + Math.min(index, MAX_OPTION_LETTERS - 1));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 20);
}

function isCancelError(error) {
  return Boolean(error) && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

function describeError(error) {
  if (error instanceof AppError) {
    const known = {
      BAD_REQUEST: '请求参数有误，请检查题目内容后重试。',
      PAYLOAD_TOO_LARGE: '内容超过服务端大小限制，请换一张更小的截图。',
      RATE_LIMITED: '请求过于频繁，请稍候再试。',
      UNSUPPORTED: '该图片格式不受支持，请使用 PNG / JPG / WEBP / GIF。',
      TIMEOUT: '模型响应超时，请稍后重试。',
      UPSTREAM_ERROR: '模型服务暂时不可用，请稍后重试。',
      INTERNAL: '服务端处理失败，请稍后重试。',
    };
    return known[error.code] || error.message || '请求失败。';
  }
  if (isAbortError(error)) return '请求已取消。';
  if (error && error.name === 'TypeError') return '无法连接服务端，请确认服务已启动。';
  if (error && error.name === 'QuotaExceededError') return '浏览器存储空间不足。';
  return (error && error.message) || '未知错误。';
}

function on(target, type, handler, options) {
  target.addEventListener(
    type,
    (event) => {
      try {
        const result = handler(event);
        if (result && typeof result.then === 'function') result.catch(reportUnexpected);
      } catch (error) {
        reportUnexpected(error);
      }
    },
    options,
  );
}

function startTask(task) {
  try {
    const result = task();
    if (result && typeof result.then === 'function') result.catch(reportUnexpected);
  } catch (error) {
    reportUnexpected(error);
  }
}

function reportUnexpected(error) {
  if (isAbortError(error)) return;
  console.error(error);
  showError(`操作失败：${describeError(error)} 请重试。`);
}

/* ------------------------------------------------------------------ */
/* error bar / status                                                  */
/* ------------------------------------------------------------------ */

function showError(message, options = {}) {
  elements.errorText.textContent = message;
  elements.errorBar.hidden = false;
  state.errorRetry = typeof options.retry === 'function' ? options.retry : null;
  elements.errorRetry.hidden = state.errorRetry === null;
}

function clearError() {
  elements.errorBar.hidden = true;
  elements.errorText.textContent = '';
  elements.errorRetry.hidden = true;
  state.errorRetry = null;
}

function setAnswerStatus(text) {
  elements.answerStatus.textContent = text || '';
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function parseErrorPayload(response) {
  let message = `服务端返回 HTTP ${response.status}`;
  let code = '';
  try {
    const data = await response.json();
    if (data && data.error && typeof data.error === 'object') {
      if (typeof data.error.message === 'string' && data.error.message) message = data.error.message;
      if (typeof data.error.code === 'string') code = data.error.code;
    }
  } catch {
    // Non-JSON error body: keep the status-based message.
  }
  return { message, code };
}

async function apiFetch(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { Accept: 'application/json' } };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;

  const response = await fetch(path, init);
  if (!response.ok) {
    const info = await parseErrorPayload(response);
    throw new AppError(info.message, info.code, response.status);
  }
  return response;
}

async function apiJSON(path, options) {
  const response = await apiFetch(path, options);
  let text = '';
  try {
    text = await response.text();
  } catch {
    throw new AppError('读取服务端响应失败。', 'BAD_RESPONSE', response.status);
  }
  if (!text.trim()) throw new AppError('服务端返回了空响应。', 'BAD_RESPONSE', response.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('服务端返回了无法解析的数据。', 'BAD_RESPONSE', response.status);
  }
}

/* ------------------------------------------------------------------ */
/* config + mode                                                       */
/* ------------------------------------------------------------------ */

function normalizeEnsemble(raw) {
  const info = { enabled: false, available: false, reason: '', candidates: [], judge: null };
  if (!raw || typeof raw !== 'object') {
    info.reason = '交叉验证不可用：服务端未返回相关配置。';
    return info;
  }

  info.enabled = raw.enabled === true;
  info.candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .slice(0, 5)
    .map((slot, index) => {
      const item = slot && typeof slot === 'object' ? slot : {};
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      return {
        name: name || `模型 ${letterFor(index)}`,
        model: typeof item.model === 'string' ? item.model.trim() : '',
        hasKey: item.hasKey !== false,
      };
    });

  const judgeRaw = raw.judge && typeof raw.judge === 'object' ? raw.judge : {};
  const judgeName = typeof judgeRaw.name === 'string' ? judgeRaw.name.trim() : '';
  info.judge = {
    name: judgeName || '评审',
    model: typeof judgeRaw.model === 'string' ? judgeRaw.model.trim() : '',
    hasKey: judgeRaw.hasKey !== false,
  };

  const usable = info.candidates.filter((candidate) => candidate.model && candidate.hasKey).length;
  info.available = typeof raw.available === 'boolean' ? raw.available : usable >= 2;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  info.reason = reason || (info.available ? '' : `交叉验证需要至少 2 个已配置的候选模型（当前 ${usable} 个）。`);
  return info;
}

function normalizeConfig(raw) {
  const config = cloneDefaults();
  if (!raw || typeof raw !== 'object') return config;

  if (raw.mode === 'demo' || raw.mode === 'live') config.mode = raw.mode;

  if (raw.models && typeof raw.models === 'object') {
    if (typeof raw.models.chat === 'string') config.models.chat = raw.models.chat;
    if (typeof raw.models.visionModel === 'string') config.models.visionModel = raw.models.visionModel;
  }

  if (raw.limits && typeof raw.limits === 'object') {
    config.limits.maxImageBytes = positiveInt(raw.limits.maxImageBytes, DEFAULT_CONFIG.limits.maxImageBytes);
    config.limits.maxQuestionChars = positiveInt(raw.limits.maxQuestionChars, DEFAULT_CONFIG.limits.maxQuestionChars);
    config.limits.maxOptions = Math.min(
      MAX_OPTION_LETTERS,
      positiveInt(raw.limits.maxOptions, DEFAULT_CONFIG.limits.maxOptions),
    );
  }

  if (Array.isArray(raw.styles)) {
    const styles = raw.styles.filter((style) => typeof style === 'string' && style.trim()).map((style) => style.trim());
    if (styles.length) config.styles = styles;
  }

  config.ensemble = normalizeEnsemble(raw.ensemble);
  return config;
}

async function initConfig() {
  try {
    const data = await apiJSON('/api/config');
    state.config = normalizeConfig(data);
    state.configLoaded = true;
    applyConfig(state.config);
    renderMode();
    if (state.errorRetry === initConfig) clearError();
  } catch (error) {
    if (!state.configLoaded) {
      state.config = normalizeConfig(null);
      state.config.ensemble.reason = '无法获取服务端配置，交叉验证不可用。';
      applyConfig(state.config);
      renderMode();
    }
    const suffix = state.configLoaded ? '请点击「重试」刷新配置。' : '已使用默认限制，请确认服务已启动后点击「重试」。';
    showError(`无法获取服务端配置：${describeError(error)} ${suffix}`, { retry: initConfig });
  }
}

function applyConfig(config) {
  renderStyleOptions(config.styles);
  applyEnsembleConfig(config.ensemble);
  elements.questionInput.maxLength = config.limits.maxQuestionChars;
  updateQuestionCount();
  syncOptionsState();
}

/** Reflect server-side availability: disable the switch and explain why. */
function applyEnsembleConfig(info) {
  const available = Boolean(info && info.available);
  const checkbox = elements.ensembleCheckbox;
  checkbox.disabled = !available;
  elements.ensembleToggle.classList.toggle('is-disabled', !available);
  elements.ensembleToggle.title = available
    ? '交叉验证：多个候选模型并行作答，再由评审模型比对后输出最终答案'
    : (info && info.reason) || '交叉验证不可用。';

  if (!available) {
    checkbox.checked = false;
  } else if (!state.ensembleTouched) {
    checkbox.checked = info.enabled === true;
  }
  elements.ensembleToggle.classList.toggle('is-on', checkbox.checked && available);

  const hint = available ? '' : (info && info.reason) || '交叉验证不可用。';
  elements.ensembleHint.hidden = hint === '';
  elements.ensembleHint.textContent = hint;
}

function renderStyleOptions(styles) {
  const values = Array.isArray(styles) && styles.length ? styles : DEFAULT_CONFIG.styles;
  const previous = elements.styleSelect.value;
  elements.styleSelect.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = STYLE_LABELS[value] || value;
      return option;
    }),
  );
  elements.styleSelect.value = values.includes(previous) ? previous : values[0];
}

function renderMode() {
  const { mode } = state.config;
  const badge = elements.modeBadge;
  const banner = elements.modeBanner;
  badge.classList.remove('badge-demo', 'badge-live', 'badge-unknown');
  banner.classList.remove('banner-demo', 'banner-live');

  if (mode === 'demo') {
    badge.textContent = '演示模式';
    badge.classList.add('badge-demo');
    banner.hidden = false;
    banner.classList.add('banner-demo');
    banner.textContent =
      '演示模式：未配置 API Key，识别与解答均使用内置示例数据。在 config.json 或环境变量 AI_API_KEY 中填入密钥并重启服务，即可切换为在线模式。';
    return;
  }

  if (mode === 'live') {
    badge.textContent = '在线模式';
    badge.classList.add('badge-live');
    banner.hidden = false;
    banner.classList.add('banner-live');
    const chatModel = state.config.models.chat || '默认模型';
    const vision = state.config.models.visionModel ? `，识别模型 ${state.config.models.visionModel}` : '';
    banner.textContent = `在线模式：解答模型 ${chatModel}${vision}。`;
    return;
  }

  badge.textContent = '未连接';
  badge.classList.add('badge-unknown');
  banner.hidden = true;
  banner.textContent = '';
}

/* ------------------------------------------------------------------ */
/* image intake                                                        */
/* ------------------------------------------------------------------ */

function approxBytesFromDataUrl(dataUrl) {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  if (comma === -1) return 0;
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:')) resolve(reader.result);
      else reject(new Error('文件读取结果异常。'));
    };
    reader.onerror = () => reject(reader.error || new Error('文件读取失败。'));
    reader.readAsDataURL(file);
  });
}

function readImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error('图片解析超时。')), 15000);
    image.onload = () => {
      clearTimeout(timer);
      resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error('图片格式无法解析。'));
    };
    image.src = dataUrl;
  });
}

function pickImageFile(dataTransfer) {
  if (!dataTransfer) return null;
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    if (item && item.kind === 'file') {
      const file = item.getAsFile();
      if (file && /^image\//.test(file.type || '')) return file;
    }
  }
  const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  return files.find((file) => file && /^image\//.test(file.type || '')) || null;
}

async function acceptFile(file) {
  if (!file) return;
  if (!SUPPORTED_IMAGE.test(file.type || '')) {
    showError('仅支持 PNG / JPG / WEBP / GIF 图片，请重新选择。');
    return;
  }
  const maxBytes = state.config.limits.maxImageBytes;
  if (file.size > maxBytes) {
    showError(`图片约 ${formatBytes(file.size)}，超过服务端上限 ${formatBytes(maxBytes)}，请压缩或裁剪后重试。`);
    return;
  }

  clearError();
  elements.captureStatus.textContent = '正在读取图片…';
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const bytes = approxBytesFromDataUrl(dataUrl);
    if (bytes > maxBytes) {
      elements.captureStatus.textContent = '';
      showError(`图片约 ${formatBytes(bytes)}，超过服务端上限 ${formatBytes(maxBytes)}，请压缩或裁剪后重试。`);
      return;
    }
    const size = await readImageSize(dataUrl);
    setImage({ dataUrl, width: size.width, height: size.height, bytes });
    elements.captureStatus.textContent = '图片已添加，点击「识别题目」开始识别。';
  } catch (error) {
    elements.captureStatus.textContent = '';
    showError(`读取图片失败：${describeError(error)} 请换一张图片。`);
  }
}

function setImage(image) {
  state.image = image;
  elements.preview.src = image.dataUrl;
  elements.previewWrap.hidden = false;
  elements.dropHint.hidden = true;
  elements.previewMeta.textContent = `${image.width} × ${image.height} · ${formatBytes(image.bytes)}`;
  elements.recognizeBtn.disabled = false;
  elements.recognizeBtn.textContent = '识别题目';
  elements.resetImageBtn.hidden = false;
  elements.dropZone.classList.add('has-image');
}

function clearImage() {
  state.image = null;
  elements.preview.removeAttribute('src');
  elements.previewWrap.hidden = true;
  elements.dropHint.hidden = false;
  elements.previewMeta.textContent = '';
  elements.recognizeBtn.disabled = true;
  elements.recognizeBtn.textContent = '识别题目';
  elements.resetImageBtn.hidden = true;
  elements.captureStatus.textContent = '';
  elements.dropZone.classList.remove('has-image');
  elements.dropZone.focus();
}

function waitForVideoFrame(video) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMetadata);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (video.videoWidth > 0) finish();
      else finish(new Error('没有获取到屏幕画面。'));
    }, 4000);

    function grab() {
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => finish());
      } else {
        setTimeout(() => finish(), 150);
      }
    }

    function onMetadata() {
      grab();
    }

    video.addEventListener('loadedmetadata', onMetadata);
    const playing = video.play();
    if (playing && typeof playing.catch === 'function') playing.catch(() => {});
    if (video.readyState >= 2) grab();
  });
}

async function captureScreen() {
  if (state.busyCapture) return;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    showError('当前浏览器不支持屏幕截图，请改用拖拽、点击选择或粘贴图片。');
    return;
  }

  clearError();
  state.busyCapture = true;
  setButtonBusy(elements.captureBtn, true);
  elements.captureStatus.textContent = '正在获取屏幕画面…';
  let stream = null;

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false });
    // Only lock the rest of the form once a screen has actually been shared.
    elements.recognizeBtn.disabled = true;
    elements.resetImageBtn.disabled = true;
    const video = elements.captureVideo;
    video.srcObject = stream;
    await waitForVideoFrame(video);

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('没有获取到屏幕画面。');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理画面。');
    context.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/png');
    const bytes = approxBytesFromDataUrl(dataUrl);
    const maxBytes = state.config.limits.maxImageBytes;
    if (bytes > maxBytes) {
      elements.captureStatus.textContent = '';
      showError(`截图约 ${formatBytes(bytes)}，超过服务端上限 ${formatBytes(maxBytes)}，请缩小截图范围或改用图片上传。`);
      return;
    }

    setImage({ dataUrl, width, height, bytes });
    elements.captureStatus.textContent = '截图已添加，点击「识别题目」开始识别。';
  } catch (error) {
    elements.captureStatus.textContent = '';
    if (isCancelError(error)) return; // User dismissed the picker: stay silent.
    showError(`屏幕截图失败：${describeError(error)} 请重试，或改用拖拽 / 粘贴图片。`);
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Track already ended.
        }
      }
    }
    elements.captureVideo.srcObject = null;
    state.busyCapture = false;
    setButtonBusy(elements.captureBtn, false);
    elements.recognizeBtn.disabled = !state.image;
    elements.resetImageBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* option rows + form                                                  */
/* ------------------------------------------------------------------ */

function nextFreeLabel() {
  const used = new Set(
    Array.from(elements.optionList.querySelectorAll('.option-label')).map((input) => input.value.trim().toUpperCase()),
  );
  for (let index = 0; index < state.config.limits.maxOptions; index += 1) {
    const label = letterFor(index);
    if (!used.has(label)) return label;
  }
  return letterFor(elements.optionList.children.length);
}

function addOptionRow(option = {}) {
  if (elements.optionList.children.length >= state.config.limits.maxOptions) return null;

  const label = typeof option.label === 'string' && /^[A-Za-z]$/.test(option.label.trim())
    ? option.label.trim().toUpperCase()
    : nextFreeLabel();
  const text = typeof option.text === 'string' ? option.text : '';

  const row = document.createElement('div');
  row.className = 'option-row';

  const labelInput = document.createElement('input');
  labelInput.className = 'input option-label';
  labelInput.type = 'text';
  labelInput.maxLength = 1;
  labelInput.value = label;
  labelInput.setAttribute('aria-label', '选项标签');

  const textInput = document.createElement('input');
  textInput.className = 'input option-text';
  textInput.type = 'text';
  textInput.value = text;
  textInput.placeholder = '选项内容';
  textInput.setAttribute('aria-label', `${label} 选项内容`);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-small btn-ghost option-remove';
  removeBtn.type = 'button';
  removeBtn.textContent = '删除';
  removeBtn.setAttribute('aria-label', `删除选项 ${label}`);

  on(labelInput, 'input', () => {
    labelInput.value = labelInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
    syncRestoreState();
  });
  on(textInput, 'input', syncRestoreState);
  on(removeBtn, 'click', () => {
    row.remove();
    syncOptionsState();
    syncSubmitState();
  });

  row.append(labelInput, textInput, removeBtn);
  elements.optionList.append(row);
  syncOptionsState();
  return row;
}

function renderOptions(options) {
  const list = Array.isArray(options) ? options.slice(0, state.config.limits.maxOptions) : [];
  elements.optionList.replaceChildren();
  list.forEach((option) => addOptionRow(option));
  syncOptionsState();
}

function readOptions() {
  const options = [];
  Array.from(elements.optionList.children).forEach((row, index) => {
    const textInput = row.querySelector('.option-text');
    const labelInput = row.querySelector('.option-label');
    const text = textInput ? textInput.value.trim() : '';
    if (!text) return;
    const rawLabel = labelInput ? labelInput.value.trim().toUpperCase() : '';
    options.push({ label: /^[A-Z]$/.test(rawLabel) ? rawLabel : letterFor(index), text });
  });
  return options.slice(0, state.config.limits.maxOptions);
}

function syncOptionsState() {
  const count = elements.optionList.children.length;
  const max = state.config.limits.maxOptions;
  elements.optionEmpty.hidden = count > 0;
  elements.addOptionBtn.disabled = count >= max;
  elements.addOptionBtn.hidden = count >= max;
  syncRestoreState();
}

function updateQuestionCount() {
  const length = elements.questionInput.value.length;
  const max = state.config.limits.maxQuestionChars;
  elements.questionCount.textContent = `${length} / ${max}`;
  elements.questionCount.classList.toggle('is-over', length >= max);
}

function syncSubmitState() {
  elements.submitBtn.disabled = state.streaming || elements.questionInput.value.trim().length === 0;
}

function subjectFieldValue(subject) {
  return typeof subject === 'string' && subject !== '未知' ? subject : '';
}

function syncRestoreState() {
  const snapshot = state.recognized;
  if (!snapshot) {
    elements.restoreBtn.hidden = true;
    return;
  }
  const sameQuestion = elements.questionInput.value === snapshot.question;
  const sameSubject = elements.subjectInput.value.trim() === subjectFieldValue(snapshot.subject).trim();
  const sameType = elements.typeSelect.value === snapshot.questionType;
  const sameOptions = JSON.stringify(readOptions()) === JSON.stringify(snapshot.options);
  elements.restoreBtn.hidden = sameQuestion && sameSubject && sameType && sameOptions;
}

function restoreRecognition() {
  const snapshot = state.recognized;
  if (!snapshot) return;
  elements.questionInput.value = snapshot.question;
  elements.subjectInput.value = subjectFieldValue(snapshot.subject);
  elements.typeSelect.value = snapshot.questionType;
  renderOptions(snapshot.options);
  updateQuestionCount();
  syncSubmitState();
  elements.questionInput.focus();
}

/* ------------------------------------------------------------------ */
/* recognition                                                         */
/* ------------------------------------------------------------------ */

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const max = state.config.limits.maxOptions;
  const options = [];
  raw.slice(0, max).forEach((item, index) => {
    const fallbackLabel = letterFor(index);
    if (typeof item === 'string') {
      const matched = /^\s*([A-Za-z])\s*[.、):：]\s*(.*)$/.exec(item);
      const text = matched ? matched[2].trim() : item.trim();
      if (text) options.push({ label: matched ? matched[1].toUpperCase() : fallbackLabel, text });
      return;
    }
    if (item && typeof item === 'object') {
      const rawLabel = typeof item.label === 'string' ? item.label.trim().toUpperCase() : '';
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (text) options.push({ label: /^[A-Z]$/.test(rawLabel) ? rawLabel : fallbackLabel, text });
    }
  });
  return options;
}

function applyRecognition(raw) {
  if (!raw || typeof raw !== 'object') {
    showError('识别结果格式异常，请换一张截图，或手动输入题目。');
    return false;
  }
  const question = typeof raw.question === 'string' ? raw.question : '';
  if (!question.trim()) {
    showError('没有识别到题目文字，请换一张更清晰的截图，或手动输入题目。');
    return false;
  }

  const options = normalizeOptions(raw.options);
  const subject = typeof raw.subject === 'string' && raw.subject.trim() ? raw.subject.trim() : '未知';
  const questionType = QUESTION_TYPES.includes(raw.questionType) ? raw.questionType : 'unknown';

  state.recognized = {
    question,
    options: options.map((option) => ({ ...option })),
    subject,
    questionType,
  };

  elements.questionInput.value = question;
  elements.subjectInput.value = subjectFieldValue(subject);
  elements.typeSelect.value = questionType;
  renderOptions(options);
  updateQuestionCount();
  syncSubmitState();
  elements.restoreBtn.hidden = true;
  return true;
}

async function runRecognize() {
  if (state.busyRecognize) return;
  if (!state.image) {
    showError('请先添加题目截图（拖拽、选择、粘贴或屏幕截图）。');
    return;
  }

  state.busyRecognize = true;
  clearError();
  setButtonBusy(elements.recognizeBtn, true);
  elements.captureBtn.disabled = true;
  elements.resetImageBtn.disabled = true;
  elements.captureStatus.textContent = '正在识别图片中的题目…';

  try {
    const data = await apiJSON('/api/recognize', {
      method: 'POST',
      body: { imageDataUrl: state.image.dataUrl },
    });
    if (applyRecognition(data)) {
      elements.captureStatus.textContent = '识别完成，可修改下方内容后再提交。';
      elements.recognizeBtn.textContent = '重新识别';
      setAnswerStatus('题目已识别，可编辑后提交。');
    } else {
      elements.captureStatus.textContent = '';
    }
  } catch (error) {
    elements.captureStatus.textContent = '';
    showError(`识别失败：${describeError(error)} 请稍后重试，或直接手动输入题目。`, { retry: runRecognize });
  } finally {
    state.busyRecognize = false;
    setButtonBusy(elements.recognizeBtn, false);
    elements.recognizeBtn.disabled = !state.image;
    elements.captureBtn.disabled = false;
    elements.resetImageBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* answer rendering                                                    */
/* ------------------------------------------------------------------ */

let frameHandle = 0;

function isNearBottom(element, threshold = 48) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
}

function appendCaret(container) {
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  const last = container.lastElementChild;
  if (last && /^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH)$/.test(last.tagName)) last.append(caret);
  else container.append(caret);
}

function renderAnswer() {
  const container = elements.answerMd;
  const raw = state.answerRaw;
  if (!raw.trim()) {
    const placeholder = document.createElement('p');
    placeholder.className = 'placeholder';
    placeholder.textContent = state.streaming
      ? '正在等待模型输出…'
      : '先识别或输入题目，再点击「提交 AI 解答」。';
    container.replaceChildren(placeholder);
    return;
  }
  // renderMarkdown escapes all source text; only its own tags reach innerHTML.
  container.innerHTML = renderMarkdown(raw);
  if (state.streaming) appendCaret(container);
}

function scheduleAnswerRender() {
  if (frameHandle) return;
  frameHandle = requestAnimationFrame(() => {
    frameHandle = 0;
    const stick = state.stickToBottom;
    renderAnswer();
    if (stick) elements.answerPanel.scrollTop = elements.answerPanel.scrollHeight;
  });
}

function appendAnswerText(text) {
  if (!text) return;
  state.answerRaw += text;
  scheduleAnswerRender();
}

function updateAnswerMeta() {
  if (!state.answerModel) {
    elements.answerMeta.textContent = '';
    return;
  }
  const label = state.ensembleUsed && !state.fallback ? '评审' : '模型';
  elements.answerMeta.textContent = `${label} ${state.answerModel}`;
}

/* ------------------------------------------------------------------ */
/* ensemble candidates                                                 */
/* ------------------------------------------------------------------ */

function candidateEntry(index) {
  let entry = state.candidates.find((item) => item.index === index);
  if (entry) return entry;
  entry = {
    index,
    name: '',
    model: '',
    status: 'running',
    text: '',
    error: '',
    durationMs: null,
    expanded: false,
    renderedText: '',
    node: null,
  };
  state.candidates.push(entry);
  state.candidates.sort((a, b) => a.index - b.index);
  return entry;
}

function resetCandidates() {
  state.ensembleUsed = false;
  state.candidateTotal = 0;
  state.candidates = [];
  state.judge = null;
  state.fallback = false;
  if (elements.candidateList) elements.candidateList.replaceChildren();
  elements.candidates.hidden = true;
  elements.candidatesCount.textContent = '';
  elements.judgeRow.hidden = true;
  elements.judgeLabel.textContent = '';
  elements.judgeLabel.removeAttribute('title');
  elements.judgeTime.textContent = '';
  elements.judgeDot.dataset.status = 'running';
  elements.ensembleWarning.hidden = true;
  elements.ensembleWarning.textContent = '';
}

function candidateProgress() {
  const settled = state.candidates.filter(
    (candidate) => candidate.status === 'done' || candidate.status === 'error',
  ).length;
  return { settled, total: Math.max(state.candidateTotal, state.candidates.length) };
}

function updateCandidatesSummary() {
  const { settled, total } = candidateProgress();
  const failed = state.candidates.filter((candidate) => candidate.status === 'error').length;
  const parts = [];
  if (total > 0) parts.push(`${settled}/${total} 已完成`);
  if (failed > 0) parts.push(`${failed} 个失败`);
  elements.candidatesCount.textContent = parts.join(' · ');
}

function ensureCandidateCard(entry) {
  if (entry.node) return entry.node;

  const card = document.createElement('div');
  card.className = 'candidate';
  card.setAttribute('data-testid', `candidate-${entry.index}`);
  card.setAttribute('data-status', entry.status);
  card.setAttribute('role', 'listitem');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'candidate-head';
  head.setAttribute('aria-expanded', 'false');

  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.dataset.status = entry.status;
  dot.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'candidate-name';

  const model = document.createElement('span');
  model.className = 'candidate-model';

  const time = document.createElement('span');
  time.className = 'candidate-time';

  const caret = document.createElement('span');
  caret.className = 'candidate-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';

  head.append(dot, name, model, time, caret);

  const preview = document.createElement('p');
  preview.className = 'candidate-preview';

  const error = document.createElement('p');
  error.className = 'candidate-error';
  error.hidden = true;

  const body = document.createElement('div');
  body.className = 'candidate-body answer-md';
  body.hidden = true;

  on(head, 'click', () => toggleCandidate(entry));
  card.append(head, preview, error, body);
  elements.candidateList.append(card);

  entry.node = card;
  entry.headNode = head;
  entry.dotNode = dot;
  entry.nameNode = name;
  entry.modelNode = model;
  entry.timeNode = time;
  entry.previewNode = preview;
  entry.errorNode = error;
  entry.bodyNode = body;
  return card;
}

function updateCandidateCard(entry) {
  const card = ensureCandidateCard(entry);
  const hasText = typeof entry.text === 'string' && entry.text.trim() !== '';
  const expandable = hasText && entry.status !== 'running';
  if (!expandable) entry.expanded = false;

  card.setAttribute('data-status', entry.status);
  entry.dotNode.dataset.status = entry.status;
  entry.nameNode.textContent = entry.name || `模型 ${letterFor(entry.index)}`;
  entry.modelNode.textContent = entry.model || '未指定模型';
  entry.timeNode.textContent = Number.isFinite(entry.durationMs) ? `${(entry.durationMs / 1000).toFixed(1)}s` : '';
  entry.headNode.disabled = false;
  entry.headNode.setAttribute('aria-disabled', expandable ? 'false' : 'true');
  entry.headNode.setAttribute('aria-expanded', entry.expanded ? 'true' : 'false');
  entry.headNode.title = expandable ? (entry.expanded ? '收起完整答案' : '展开完整答案') : '';

  if (hasText) {
    entry.previewNode.textContent = snippetOf(entry.text, 96);
  } else if (entry.status === 'error') {
    entry.errorNode.hidden = false;
    entry.errorNode.textContent = entry.error ? `错误：${entry.error}` : '未返回答案';
    entry.previewNode.textContent = '';
  } else {
    entry.previewNode.textContent = entry.status === 'running' ? '正在作答…' : '';
  }

  if (hasText) {
    entry.errorNode.hidden = true;
    entry.errorNode.textContent = '';
  }

  if (entry.expanded) {
    entry.bodyNode.hidden = false;
    if (entry.renderedText !== entry.text) {
      // renderMarkdown escapes source text; only its own tags reach innerHTML.
      entry.bodyNode.innerHTML = renderMarkdown(entry.text);
      entry.renderedText = entry.text;
    }
  } else {
    entry.bodyNode.hidden = true;
  }
}

function toggleCandidate(entry) {
  if (!entry.text || !entry.text.trim() || entry.status === 'running') return;
  entry.expanded = !entry.expanded;
  updateCandidateCard(entry);
}

function normalizeJudgeState(raw) {
  const judge = {
    name: typeof raw.name === 'string' && raw.name ? raw.name : '评审',
    model: typeof raw.model === 'string' ? raw.model : '',
    status: ['running', 'done', 'error'].includes(raw.status) ? raw.status : 'running',
  };
  if (typeof raw.error === 'string' && raw.error) judge.error = raw.error;
  if (Number.isFinite(raw.durationMs)) judge.durationMs = raw.durationMs;
  return judge;
}

function updateJudgeRow() {
  const judge = state.judge;
  if (!judge) {
    elements.judgeRow.hidden = true;
    return;
  }

  elements.judgeRow.hidden = false;
  if (judge.status === 'error') elements.judgeDot.dataset.status = 'error';
  else if (judge.status === 'done') elements.judgeDot.dataset.status = 'done';
  else elements.judgeDot.dataset.status = 'running';

  const label = judge.name || '评审';
  const waiting = state.candidates.some((candidate) => candidate.status === 'running');
  let text;
  if (judge.status === 'error') text = `${label}未能完成比对`;
  else if (judge.status === 'done') text = `${label}已完成比对`;
  else if (waiting) text = `${label}等待候选完成…`;
  else text = `${label}比对中…`;

  elements.judgeLabel.textContent = judge.model ? `${text}（${judge.model}）` : text;
  elements.judgeTime.textContent = Number.isFinite(judge.durationMs) ? `${(judge.durationMs / 1000).toFixed(1)}s` : '';
  if (judge.status === 'error' && judge.error) elements.judgeLabel.title = judge.error;
  else elements.judgeLabel.removeAttribute('title');
}

function updateEnsembleWarning() {
  if (!state.fallback) {
    elements.ensembleWarning.hidden = true;
    elements.ensembleWarning.textContent = '';
    return;
  }
  const source = state.candidates.find((candidate) => candidate.status === 'done' && candidate.text);
  const name = source ? source.name || `模型 ${letterFor(source.index)}` : '候选模型';
  elements.ensembleWarning.hidden = false;
  elements.ensembleWarning.textContent = `评审模型不可用，已回退为「${name}」的原始答案。`;
}

function applyCandidateEvent(raw) {
  if (!raw || typeof raw !== 'object') return;
  const index = Number(raw.index);
  if (!Number.isFinite(index)) return;

  state.ensembleUsed = true;
  elements.candidates.hidden = false;
  const entry = candidateEntry(index);
  if (typeof raw.name === 'string' && raw.name) entry.name = raw.name;
  if (typeof raw.model === 'string' && raw.model) entry.model = raw.model;
  if (raw.status === 'running' || raw.status === 'done' || raw.status === 'error') entry.status = raw.status;
  if (typeof raw.text === 'string') entry.text = raw.text;
  if (typeof raw.error === 'string') entry.error = raw.error;
  if (Number.isFinite(raw.durationMs)) entry.durationMs = raw.durationMs;

  updateCandidateCard(entry);
  updateCandidatesSummary();
  updateJudgeRow();
}

function beginEnsemble(meta) {
  state.ensembleUsed = true;
  elements.candidates.hidden = false;

  const list = meta && Array.isArray(meta.candidates) ? meta.candidates : [];
  if (list.length > 0) state.candidateTotal = Math.max(state.candidateTotal, list.length);

  list.forEach((item, position) => {
    const rawIndex = Number(item && item.index);
    const entry = candidateEntry(Number.isFinite(rawIndex) ? rawIndex : position);
    if (item && typeof item.name === 'string' && item.name && !entry.name) entry.name = item.name;
    if (item && typeof item.model === 'string' && item.model && !entry.model) entry.model = item.model;
    updateCandidateCard(entry);
  });

  if (meta && meta.judge && typeof meta.judge === 'object') {
    state.judge = { ...(state.judge || {}), ...normalizeJudgeState(meta.judge) };
  }

  updateCandidatesSummary();
  updateJudgeRow();
}

function applyEnsembleDone(done) {
  if (!done || typeof done !== 'object') return;
  const doneCandidates = Array.isArray(done.candidates) ? done.candidates : [];
  const hasJudge = Boolean(done.judge) && typeof done.judge === 'object';
  const isEnsemble = done.ensemble === true || doneCandidates.length > 0 || hasJudge;
  if (!isEnsemble) return;

  state.ensembleUsed = true;
  elements.candidates.hidden = false;
  if (doneCandidates.length > 0) {
    state.candidateTotal = Math.max(state.candidateTotal, doneCandidates.length);
    doneCandidates.forEach((raw) => applyCandidateEvent(raw));
  }
  if (hasJudge) {
    state.judge = { ...(state.judge || {}), ...normalizeJudgeState(done.judge) };
  }
  if (done.fallback === true) {
    state.fallback = true;
    const source = state.candidates.find((candidate) => candidate.status === 'done' && candidate.text);
    if (source && source.model) state.answerModel = source.model;
    updateAnswerMeta();
  }

  updateCandidatesSummary();
  updateJudgeRow();
  updateEnsembleWarning();
}

function setStreamingUI(streaming) {
  elements.submitBtn.classList.toggle('is-busy', streaming);
  elements.stopBtn.hidden = !streaming;
  elements.answerPanel.setAttribute('aria-busy', streaming ? 'true' : 'false');
  syncSubmitState();
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  let name = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value || 'message';
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  return { name, data: dataLines.join('\n') };
}

function handleServerEvent(name, data) {
  let payload = null;
  if (data) {
    try {
      payload = JSON.parse(data);
    } catch {
      payload = null;
    }
  }

  if (name === 'delta') {
    if (payload && typeof payload.text === 'string') appendAnswerText(payload.text);
    return;
  }

  if (name === 'candidate') {
    if (payload) applyCandidateEvent(payload);
    return;
  }

  if (name === 'meta') {
    if (!payload) return;
    if (payload.cached) elements.cachedChip.hidden = false;
    if (payload.mode === 'demo') elements.demoChip.hidden = false;
    if (payload.ensemble === true) beginEnsemble(payload);
    const judgeModel = payload.judge && typeof payload.judge === 'object' && typeof payload.judge.model === 'string'
      ? payload.judge.model
      : '';
    const model = judgeModel || (typeof payload.model === 'string' ? payload.model : '');
    if (model) state.answerModel = model;
    updateAnswerMeta();
    return;
  }

  if (name === 'done') {
    state.lastDone = payload && typeof payload === 'object' ? payload : {};
    applyEnsembleDone(state.lastDone);
    return;
  }

  if (name === 'error') {
    const message = payload && typeof payload.message === 'string' && payload.message
      ? payload.message
      : '服务端返回错误。';
    const code = payload && typeof payload.code === 'string' ? payload.code : 'SERVER_ERROR';
    throw new AppError(message, code);
  }

  // Unknown event names are ignored so new server events never break the UI.
}

async function consumeAnswerStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (block) => {
    const event = parseSseBlock(block);
    if (!event) return;
    handleServerEvent(event.name, event.data);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        dispatch(block);
        match = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed.
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* answer submission                                                   */
/* ------------------------------------------------------------------ */

async function submitAnswer() {
  if (state.streaming) return;

  const question = elements.questionInput.value.trim();
  if (!question) {
    showError('题目内容为空，请先识别或手动输入题目。');
    elements.questionInput.focus();
    return;
  }
  const maxChars = state.config.limits.maxQuestionChars;
  if (question.length > maxChars) {
    showError(`题目超过 ${maxChars} 字符上限，请精简后再提交。`);
    return;
  }

  const payload = {
    question,
    options: readOptions(),
    subject: elements.subjectInput.value.trim(),
    style: elements.styleSelect.value,
    ensemble: elements.ensembleCheckbox.checked === true,
  };

  clearError();
  state.streaming = true;
  state.answerRaw = '';
  state.answerModel = '';
  state.lastDone = null;
  state.stickToBottom = true;
  resetCandidates();
  elements.cachedChip.hidden = true;
  elements.demoChip.hidden = true;
  elements.answerMeta.textContent = '';
  elements.copyBtn.disabled = true;
  elements.answerMd.replaceChildren();
  elements.answerPanel.scrollTop = 0;
  renderAnswer();
  setAnswerStatus('正在生成解答…');
  setStreamingUI(true);

  const controller = new AbortController();
  state.controller = controller;

  try {
    const response = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const info = await parseErrorPayload(response);
      throw new AppError(info.message, info.code, response.status);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      // Defensive path: a non-streaming gateway response is still usable.
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!data || typeof data.answer !== 'string' || !data.answer.trim()) {
        throw new AppError('服务端返回了空答案。', 'EMPTY_ANSWER');
      }
      if (data.cached) elements.cachedChip.hidden = false;
      if (data.mode === 'demo') elements.demoChip.hidden = false;
      if (data.ensemble === true || data.judge) applyEnsembleDone(data);
      const jsonModel = data.judge && typeof data.judge === 'object' && typeof data.judge.model === 'string' && data.judge.model
        ? data.judge.model
        : (typeof data.model === 'string' ? data.model : '');
      if (jsonModel && !state.fallback) {
        state.answerModel = jsonModel;
        updateAnswerMeta();
      }
      appendAnswerText(data.answer);
    } else {
      if (!response.body) throw new AppError('当前浏览器不支持流式响应。', 'NO_STREAM');
      await consumeAnswerStream(response);
    }

    if (!state.answerRaw.trim()) throw new AppError('服务端没有返回任何内容。', 'EMPTY_ANSWER');

    const done = state.lastDone || {};
    const durationMs = Number(done.durationMs);
    const seconds = Number.isFinite(durationMs) && durationMs >= 0 ? (durationMs / 1000).toFixed(1) : '';
    const progress = candidateProgress();
    const ensembleNote = state.ensembleUsed && progress.total > 0
      ? ` · 交叉验证 ${progress.settled}/${progress.total}`
      : '';
    setAnswerStatus(`已完成${ensembleNote}${seconds ? ` · 耗时 ${seconds}s` : ''} · ${state.answerRaw.length} 字`);
    elements.copyBtn.disabled = false;
    persistHistory();
  } catch (error) {
    if (isAbortError(error)) {
      if (state.answerRaw.trim()) {
        setAnswerStatus('已停止生成，以上为已生成的内容。');
        elements.copyBtn.disabled = false;
      } else {
        setAnswerStatus('已停止。');
      }
    } else {
      setAnswerStatus('生成失败');
      showError(`解答失败：${describeError(error)}`, { retry: submitAnswer });
      if (state.answerRaw.trim()) elements.copyBtn.disabled = false;
    }
  } finally {
    state.streaming = false;
    state.controller = null;
    setStreamingUI(false);
    renderAnswer();
  }
}

function stopStreaming() {
  if (!state.controller) return;
  try {
    state.controller.abort();
  } catch {
    // Already aborted.
  }
  resetCandidates();
  setAnswerStatus('正在停止…');
}

/* ------------------------------------------------------------------ */
/* clipboard                                                           */
/* ------------------------------------------------------------------ */

function legacyCopy(text) {
  try {
    const proxy = document.createElement('textarea');
    proxy.className = 'clipboard-proxy';
    proxy.value = text;
    proxy.setAttribute('readonly', '');
    document.body.append(proxy);
    proxy.select();
    const ok = document.execCommand('copy');
    proxy.remove();
    return ok;
  } catch {
    return false;
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or insecure context: fall back below.
    }
  }
  return legacyCopy(text);
}

let copyTimer = 0;

function flashCopyLabel() {
  elements.copyBtn.textContent = '已复制';
  elements.copyBtn.classList.add('is-copied');
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    elements.copyBtn.textContent = '复制';
    elements.copyBtn.classList.remove('is-copied');
  }, 1600);
}

async function copyAnswer() {
  const text = state.answerRaw.trim();
  if (!text) return;
  const ok = await writeClipboard(text);
  if (ok) flashCopyLabel();
  else showError('复制失败，请手动选中答案后复制。');
}

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

function isHistoryEntry(item) {
  return Boolean(item)
    && typeof item === 'object'
    && typeof item.question === 'string'
    && typeof item.answer === 'string'
    && Number.isFinite(item.at);
}

function sanitizeEntry(item) {
  return {
    id: typeof item.id === 'string' ? item.id : `${item.at}-${Math.random().toString(36).slice(2, 8)}`,
    question: item.question,
    options: normalizeOptions(item.options),
    subject: typeof item.subject === 'string' ? item.subject : '',
    style: typeof item.style === 'string' ? item.style : 'concise',
    questionType: QUESTION_TYPES.includes(item.questionType) ? item.questionType : 'unknown',
    answer: item.answer,
    at: Number(item.at),
  };
}

function loadHistory() {
  let raw = null;
  try {
    raw = localStorage.getItem(HISTORY_KEY);
  } catch {
    return; // Storage disabled (private mode / file://): history is optional.
  }
  if (!raw) return;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  state.history = parsed.filter(isHistoryEntry).slice(0, HISTORY_LIMIT).map(sanitizeEntry);
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
  } catch {
    // Quota exceeded or storage disabled: keep working without persistence.
  }
}

function snippetOf(text, maxLength = 72) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function persistHistory() {
  if (!state.answerRaw.trim()) return;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question: elements.questionInput.value.trim(),
    options: readOptions(),
    subject: elements.subjectInput.value.trim(),
    style: elements.styleSelect.value,
    questionType: elements.typeSelect.value,
    answer: state.answerRaw,
    at: Date.now(),
  };
  if (!entry.question) return;
  const rest = state.history.filter(
    (item) => !(item.question === entry.question && item.answer === entry.answer),
  );
  state.history = [entry, ...rest].slice(0, HISTORY_LIMIT);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = elements.historyList;
  list.replaceChildren();

  for (const entry of state.history) {
    const item = document.createElement('li');
    item.className = 'history-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-button';

    const snippet = document.createElement('span');
    snippet.className = 'history-snippet';
    snippet.textContent = snippetOf(entry.question);

    const meta = document.createElement('span');
    meta.className = 'history-meta';

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatTime(entry.at);
    meta.append(time);

    if (entry.subject) {
      const subject = document.createElement('span');
      subject.className = 'history-subject';
      subject.textContent = entry.subject;
      meta.append(subject);
    }

    if (entry.style && STYLE_LABELS[entry.style]) {
      const style = document.createElement('span');
      style.textContent = STYLE_LABELS[entry.style];
      meta.append(style);
    }

    button.append(snippet, meta);
    on(button, 'click', () => restoreHistoryEntry(entry));
    item.append(button);
    list.append(item);
  }

  elements.historyEmpty.hidden = state.history.length > 0;
  elements.clearHistoryBtn.disabled = state.history.length === 0;
  if (state.history.length === 0) resetClearState();
}

function restoreHistoryEntry(entry) {
  elements.questionInput.value = entry.question;
  elements.subjectInput.value = entry.subject;
  elements.typeSelect.value = QUESTION_TYPES.includes(entry.questionType) ? entry.questionType : 'unknown';
  if (state.config.styles.includes(entry.style)) elements.styleSelect.value = entry.style;
  renderOptions(entry.options);
  updateQuestionCount();
  syncSubmitState();

  state.answerRaw = entry.answer;
  state.streaming = false;
  state.answerModel = '';
  resetCandidates();
  elements.cachedChip.hidden = true;
  elements.demoChip.hidden = true;
  elements.answerMeta.textContent = '';
  elements.copyBtn.disabled = !entry.answer.trim();
  elements.answerPanel.scrollTop = 0;
  renderAnswer();
  setAnswerStatus('已从历史记录恢复。');
  syncRestoreState();
}

let clearArmed = false;
let clearTimer = 0;

function resetClearState() {
  clearArmed = false;
  clearTimeout(clearTimer);
  elements.clearHistoryBtn.textContent = '清空历史';
  elements.clearHistoryBtn.classList.remove('is-danger');
}

function onClearHistory() {
  if (!state.history.length) return;
  if (!clearArmed) {
    clearArmed = true;
    elements.clearHistoryBtn.textContent = '确认清空';
    elements.clearHistoryBtn.classList.add('is-danger');
    clearTimer = setTimeout(resetClearState, 4000);
    return;
  }
  resetClearState();
  state.history = [];
  saveHistory();
  renderHistory();
  setAnswerStatus('历史记录已清空。');
}

/* ------------------------------------------------------------------ */
/* busy helpers                                                        */
/* ------------------------------------------------------------------ */

function setButtonBusy(button, busy) {
  button.classList.toggle('is-busy', busy);
  button.disabled = busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

let dragDepth = 0;

function bindEvents() {
  const zone = elements.dropZone;

  on(zone, 'click', () => elements.fileInput.click());
  on(zone, 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements.fileInput.click();
    }
  });

  on(elements.fileInput, 'change', () => {
    const files = elements.fileInput.files;
    const file = files && files[0] ? files[0] : null;
    elements.fileInput.value = '';
    if (file) startTask(() => acceptFile(file));
  });

  zone.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) zone.classList.remove('is-dragover');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    zone.classList.remove('is-dragover');
    const file = pickImageFile(event.dataTransfer);
    if (!file) {
      showError('未检测到图片，请拖入 PNG / JPG / WEBP / GIF 文件。');
      return;
    }
    startTask(() => acceptFile(file));
  });

  // Dropping anywhere else must not navigate away from the page.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  document.addEventListener('paste', (event) => {
    const file = pickImageFile(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    startTask(() => acceptFile(file));
  });

  on(elements.captureBtn, 'click', captureScreen);
  on(elements.recognizeBtn, 'click', runRecognize);
  on(elements.resetImageBtn, 'click', clearImage);

  on(elements.addOptionBtn, 'click', () => {
    const row = addOptionRow({});
    if (!row) return;
    syncSubmitState();
    const textInput = row.querySelector('.option-text');
    if (textInput) textInput.focus();
  });

  on(elements.questionInput, 'input', () => {
    updateQuestionCount();
    syncSubmitState();
    syncRestoreState();
  });
  on(elements.subjectInput, 'input', syncRestoreState);
  on(elements.typeSelect, 'change', syncRestoreState);
  on(elements.restoreBtn, 'click', restoreRecognition);
  on(elements.ensembleCheckbox, 'change', () => {
    state.ensembleTouched = true;
    elements.ensembleToggle.classList.toggle('is-on', elements.ensembleCheckbox.checked);
  });

  on(elements.submitBtn, 'click', submitAnswer);
  on(elements.stopBtn, 'click', stopStreaming);
  on(elements.copyBtn, 'click', copyAnswer);
  on(elements.clearHistoryBtn, 'click', onClearHistory);

  on(elements.errorClose, 'click', clearError);
  on(elements.errorRetry, 'click', () => {
    const retry = state.errorRetry;
    clearError();
    if (typeof retry === 'function') return retry();
    return undefined;
  });

  on(elements.answerPanel, 'scroll', () => {
    state.stickToBottom = isNearBottom(elements.answerPanel);
  });

  document.addEventListener('keydown', (event) => {
    const combo = (event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key === 'NumpadEnter');
    if (combo) {
      event.preventDefault();
      if (!state.streaming) startTask(submitAnswer);
      return;
    }
    if (event.key === 'Escape' && state.streaming) {
      event.preventDefault();
      stopStreaming();
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (isAbortError(reason)) return;
    console.error('Unhandled rejection', reason);
    showError(`操作失败：${describeError(reason)} 请重试。`);
  });
}

async function initMath() {
  const available = await loadKatex();
  if (!available) return;
  if (state.answerRaw.trim()) renderAnswer();
}

function init() {
  bindEvents();
  loadHistory();
  renderHistory();
  applyConfig(state.config);
  updateQuestionCount();
  renderAnswer();
  syncSubmitState();
  renderMode();
  startTask(initConfig);
  startTask(initMath);
}

init();
