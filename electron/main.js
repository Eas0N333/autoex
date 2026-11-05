/**
 * Electron main process for the desktop overlay (docs/CONTRACT-DESKTOP.md §3/§5).
 *
 * Responsibilities: settings, the docked frameless window, tray, global
 * shortcuts, desktopCapturer sources and the `aqs:*` IPC bridge. No HTTP server,
 * no port. Capture, frame diffing and rendering all live in the sandboxed
 * renderer; this process only owns the engine (server/engine.js) and OS glue.
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  globalShortcut,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../server/config.js';
import { createEngine } from '../server/engine.js';
import * as settingsStore from './settings.js';
import { testConnection } from './probe.js';
import { clearSource, listSources, selectSource } from './sources.js';

/* ------------------------------------------------------------- constants -- */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, 'ui', 'index.html');
const PRELOAD_FILE = path.join(HERE, 'preload.cjs');
const APP_NAME = 'AI 答题助手';
const PRODUCT_ID = 'app.aiquiz.overlay';

const ARGV = process.argv.slice(1);
const SMOKE = ARGV.includes('--smoke');
const SMOKE_EXIT = ARGV.includes('--smoke-exit');
const SMOKE_AUTO = process.env.AQS_SMOKE_AUTO === '1';
const SMOKE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AQS_SMOKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 60_000;
})();

const MARGIN = 12;
const COLLAPSED = Object.freeze({ width: 56, height: 96 });
/** Below this the expanded panel cannot show its controls; such values are treated as corrupt. */
const MIN_EXPANDED = Object.freeze({ width: 380, height: 560 });
const DEFAULT_EXPANDED = Object.freeze({ width: 420 });
const MAX_WIDTH = 680;
const EXPAND_TOLERANCE = 8;
const EXPAND_RETRY_MS = 100;
const MAX_PERSISTED_HEIGHT = 4000;
const MAX_IMAGE_CHARS = 16 * 1024 * 1024;
const RECOGNIZE_DEDUPE_MS = 10_000;
const HISTORY_LIMIT = 20;
/** macOS only: the TCC screen-capture dialog can stay open for a few seconds. */
const PERMISSION_POLL_INTERVAL_MS = 2_000;
const PERMISSION_POLL_ATTEMPTS = 10;
const STYLES = settingsStore.STYLES;

/** macOS TCC state that must not survive a cleanup. */
let permissionTimer = null;
let permissionRestartPrompted = false;

/** Neutral 32x32 PNG used when build/tray.png is missing from the package. */
const FALLBACK_TRAY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAnklEQVR42u3XPQ6AMAgG0F6RsRejl+kpunchvQcydDJEjbGAUZJvqiZv6A8kZk6eSW8AZAlKqqRJuoQkYxeaa21+i/PfWwDg5wuuAgqvq3IGAF5fcASwqpiAbAjIGgANAagBqiGgaoBmCGgaoBsCugYgQwBpgGEIGD8gJMB9E7ofQ/eLyP0qdn+M3J/jvyMK0ZS6t+UhBpMQo9l3puMNxdWzSxD3ivQAAAAASUVORK5CYII=';

/* -------------------------------------------------------------- logging -- */

// In smoke mode stdout carries exactly one JSON line per stage.
if (SMOKE) {
  const toStderr = (...parts) => {
    const text = parts
      .map((part) => (typeof part === 'string' ? part : part instanceof Error ? part.stack ?? part.message : JSON.stringify(part)))
      .join(' ');
    process.stderr.write(`${text}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

function log(...parts) {
  console.log('[aqs]', ...parts);
}

/* ---------------------------------------------------------------- state -- */

let win = null;
let tray = null;
let engine = null;
let trayVisible = true;
let quitting = false;
let cleanedUp = false;
let paused = false;
let currentSettings = null;
let history = [];
let lastRecognize = null;
let recognizeChain = Promise.resolve();
let boundsTimer = null;
let expandRetryTimer = null;
/** Aborts the previous `aqs:test-connection` run whenever a new one starts. */
let probeController = null;

const activeAnswers = new Map();
const smoke = { answered: false, finished: false, timer: null };

function current() {
  if (!currentSettings) currentSettings = settingsStore.loadSettings();
  return currentSettings;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ipcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* --------------------------------------------------------------- engine -- */

function fallbackServerConfig() {
  const emptyRoot = path.join(app.getPath('temp'), 'aqs-no-repo-config');
  return loadConfig(process.env, emptyRoot);
}

function serverBaseConfig() {
  try {
    return loadConfig();
  } catch (error) {
    console.error('[aqs] config.json 无效，改用默认配置：', error?.message ?? error);
    return fallbackServerConfig();
  }
}

/**
 * settings.ai wins over repo config.json; env vars already dominate inside settings.
 * Vision and ensemble slots are resolved here (blank fields inherit global ai.*)
 * so the engine only ever sees concrete endpoints.
 */
function buildEngineConfig() {
  const base = serverBaseConfig();
  const s = current();
  // settings already fold in env/config keys, so `base.demo` (which only knows
  // env + repo config.json) must not override a key stored in settings.json.
  const demo = settingsStore.isDemo(s);
  const vision = settingsStore.resolveVision(s);
  const ensemble = settingsStore.resolveEnsemble(s);
  const secret = (value) => (demo ? '' : value);
  const ai = {
    ...base.ai,
    ...s.ai,
    baseUrl: s.ai.baseUrl || base.ai.baseUrl,
    model: s.ai.model || base.ai.model,
    apiKey: secret(s.ai.apiKey || base.ai.apiKey || ''),
    visionModel: vision.model,
    headers: { ...(base.ai.headers ?? {}) },
    vision: {
      baseUrl: vision.baseUrl,
      apiKey: secret(vision.apiKey),
      model: vision.model,
    },
    ensemble: {
      enabled: ensemble.enabled,
      candidates: ensemble.candidates.map((candidate) => ({
        ...candidate,
        apiKey: secret(candidate.apiKey),
      })),
      judge: { ...ensemble.judge, apiKey: secret(ensemble.judge.apiKey) },
    },
  };
  return { ...base, demo, ai };
}

function rebuildEngine() {
  abortAllAnswers();
  engine = createEngine(buildEngineConfig());
  lastRecognize = null;
}

function engineMode() {
  if (engine?.mode) return engine.mode;
  return settingsStore.isDemo(current()) ? 'demo' : 'live';
}

/* ---------------------------------------------------------------- state -- */

function screenPermission() {
  if (process.platform !== 'darwin') return 'not-darwin';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch (error) {
    log('读取屏幕录制权限失败：', error?.message ?? error);
    return 'unknown';
  }
}

function isCapturing() {
  return Boolean(current().capture.sourceId) && !paused;
}

function buildState() {
  const s = current();
  const mode = engineMode();
  return {
    app: {
      version: app.getVersion(),
      platform: process.platform,
      demo: mode === 'demo',
      locale: app.getLocale(),
    },
    settings: settingsStore.getState(s),
    engine: {
      mode,
      models: engine?.models ?? { chat: '', visionModel: '' },
      limits: engine?.limits ?? {},
      ensemble: {
        enabled: s.ai.ensemble.enabled,
        candidates: settingsStore.activeCandidates(s).map((candidate) => ({
          name: candidate.name,
          model: candidate.model,
        })),
        judge: {
          name: s.ai.ensemble.judge.name,
          model: settingsStore.resolveEnsemble(s).judge.model,
        },
      },
    },
    runtime: {
      paused,
      busy: activeAnswers.size > 0,
      capturing: isCapturing(),
      sourceName: s.capture.sourceName ?? null,
      permission: screenPermission(),
    },
    history: history.slice(0, HISTORY_LIMIT),
  };
}

function emit(event) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('aqs:event', event);
}

function broadcastState() {
  emit({ type: 'state', state: buildState() });
}

function toast(level, message) {
  emit({ type: 'toast', level, message });
}

/* --------------------------------------------------------------- window -- */

function targetDisplay(displayId) {
  const displays = screen.getAllDisplays();
  if (displayId !== null && displayId !== undefined) {
    const found = displays.find((display) => display.id === displayId);
    if (found) return found;
  }
  return screen.getPrimaryDisplay();
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isVisibleOnSomeDisplay(rect) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x);
    const overlapY = Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y);
    return overlapX >= 80 && overlapY >= 80;
  });
}

/**
 * Left-docked placement; saved x/y only win while they are still on screen.
 *
 * A stored expanded size smaller than `MIN_EXPANDED` is corrupt data (older builds
 * persisted the 56x96 pill size, or clamped it to 320x420): the panel is repaired to
 * `DEFAULT_EXPANDED.width` x full work-area height and the returned rect carries a
 * non-enumerable `dirty` marker so the caller persists the repaired size. The marker
 * is deliberately non-enumerable, so `{ ...bounds }` (BrowserWindow options) stays clean.
 */
function computeBounds(overlay) {
  const display = targetDisplay(overlay.displayId);
  const { workArea } = display;
  if (overlay.collapsed) {
    // Keep the pill where the panel was; only repair coordinates that are missing or off-screen.
    const rememberX = Number.isFinite(Number(overlay.x)) ? Number(overlay.x) : workArea.x + MARGIN;
    const rememberY = Number.isFinite(Number(overlay.y)) ? Number(overlay.y) : workArea.y + MARGIN;
    const x = clampNumber(rememberX, workArea.x, workArea.x + workArea.width - COLLAPSED.width, workArea.x + MARGIN);
    const y = clampNumber(rememberY, workArea.y, workArea.y + workArea.height - COLLAPSED.height, workArea.y + MARGIN);
    return { x, y, ...COLLAPSED };
  }
  const widthKnown = overlay.width !== null && overlay.width !== undefined && Number.isFinite(Number(overlay.width));
  const heightKnown = overlay.height !== null && overlay.height !== undefined && Number.isFinite(Number(overlay.height));
  const dirty =
    (widthKnown && Number(overlay.width) < MIN_EXPANDED.width)
    || (heightKnown && Number(overlay.height) < MIN_EXPANDED.height);
  const maxHeight = Math.max(MIN_EXPANDED.height, workArea.height - MARGIN * 2);
  const width = dirty
    ? DEFAULT_EXPANDED.width
    : clampNumber(overlay.width, MIN_EXPANDED.width, MAX_WIDTH, DEFAULT_EXPANDED.width);
  const height = dirty || !heightKnown
    ? maxHeight
    : clampNumber(overlay.height, MIN_EXPANDED.height, maxHeight, maxHeight);
  const docked = { x: workArea.x + MARGIN, y: workArea.y + MARGIN, width, height };
  let bounds = docked;
  if (overlay.x !== null && overlay.x !== undefined && overlay.y !== null && overlay.y !== undefined) {
    const remembered = { x: overlay.x, y: overlay.y, width, height };
    if (isVisibleOnSomeDisplay(remembered)) bounds = remembered;
  }
  if (dirty) Object.defineProperty(bounds, 'dirty', { value: true, enumerable: false });
  return bounds;
}

/** True when the actual window size is still an unusable (collapsed/corrupt) size. */
function isExpandedSizeUsable(bounds) {
  return bounds.width >= MIN_EXPANDED.width - EXPAND_TOLERANCE
    && bounds.height >= MIN_EXPANDED.height - EXPAND_TOLERANCE;
}

/** The expanded rect the panel should have, repairing corrupt stored sizes. */
function expandedTarget(overlay) {
  return computeBounds({ ...overlay, collapsed: false });
}

function mediaSourceId() {
  try {
    return typeof win?.getMediaSourceId === 'function' ? win.getMediaSourceId() : null;
  } catch {
    return null;
  }
}

function persistBounds(reason) {
  if (!win || win.isDestroyed()) return;
  const s = current();
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const patch = { overlay: { x: bounds.x, y: bounds.y, displayId: display.id } };
  if (!s.overlay.collapsed) {
    if (isExpandedSizeUsable(bounds)) {
      patch.overlay.width = clampNumber(bounds.width, MIN_EXPANDED.width, MAX_WIDTH, s.overlay.width);
      patch.overlay.height = clampNumber(bounds.height, MIN_EXPANDED.height, MAX_PERSISTED_HEIGHT, s.overlay.height);
    } else {
      // Still the collapsed remnant: never overwrite a usable saved size with it.
      console.warn(
        `[aqs] 忽略异常的窗口尺寸 ${bounds.width}×${bounds.height}（${reason}），保留已保存的展开尺寸`,
      );
    }
  }
  try {
    currentSettings = settingsStore.saveSettings(patch);
  } catch (error) {
    console.error(`[aqs] 保存窗口位置失败（${reason}）：`, error?.message ?? error);
  }
}

function schedulePersistBounds(reason) {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => persistBounds(reason), 350);
}

function applyCollapsed(collapsed) {
  const flag = Boolean(collapsed);
  if (!win || win.isDestroyed()) return current();
  const s = current();
  let actual;
  try {
    actual = applyBounds(flag, s.overlay);
  } catch (error) {
    console.error('[aqs] 调整窗口尺寸失败：', error?.message ?? error);
    toast('warn', flag ? '窗口折叠失败，请重启应用' : '窗口展开失败，请重启应用');
    return current();
  }
  const patch = { collapsed: flag, x: actual.x, y: actual.y, displayId: actual.displayId };
  if (!flag) {
    // Never persist the collapsed remnant as the expanded size; keep a usable target instead.
    const usable = isExpandedSizeUsable(actual) ? actual : expandedTarget(s.overlay);
    patch.width = clampNumber(usable.width, MIN_EXPANDED.width, MAX_WIDTH, DEFAULT_EXPANDED.width);
    patch.height = clampNumber(usable.height, MIN_EXPANDED.height, MAX_PERSISTED_HEIGHT, usable.height);
  }
  try {
    currentSettings = settingsStore.saveSettings({ overlay: patch });
  } catch (error) {
    console.error('[aqs] 保存折叠状态失败：', error?.message ?? error);
    currentSettings = { ...s, overlay: { ...s.overlay, collapsed: flag } };
  }
  win.setResizable(!flag);
  broadcastState();
  refreshTray();
  return current();
}

/**
 * Resizes the window for a collapse/expand transition and returns the bounds the window
 * actually has afterwards. Transparent frameless windows ignore resizable/minimumSize on
 * Windows, so the request is never trusted: read back, retry once, then report failure.
 */
function applyBounds(collapsed, overlay) {
  if (collapsed) {
    win.setMinimumSize(COLLAPSED.width, COLLAPSED.height);
    // Collapse in place: the pill keeps the panel's top-left corner instead of jumping to
    // the work-area corner. Bounds are clamped so the whole pill stays reachable.
    const currentBounds = win.getBounds();
    const currentDisplay = screen.getDisplayMatching(currentBounds);
    const area = currentDisplay.workArea;
    const x = clampNumber(currentBounds.x, area.x, area.x + area.width - COLLAPSED.width, area.x + MARGIN);
    const y = clampNumber(currentBounds.y, area.y, area.y + area.height - COLLAPSED.height, area.y + MARGIN);
    win.setBounds({ x, y, ...COLLAPSED });
    const actual = win.getBounds();
    return { x: actual.x, y: actual.y, width: actual.width, height: actual.height, displayId: currentDisplay.id };
  }
  win.setResizable(true);
  win.setMinimumSize(MIN_EXPANDED.width, MIN_EXPANDED.height);
  const requested = expandedTarget(overlay);
  win.setBounds(requested);
  let actual = win.getBounds();
  if (!isExpandedSizeUsable(actual)) {
    win.setSize(requested.width, requested.height);
    actual = win.getBounds();
  }
  if (!isExpandedSizeUsable(actual)) {
    console.error(
      `[aqs] 展开窗口未生效（实际 ${actual.width}×${actual.height}，期望 ${requested.width}×${requested.height}），稍后重试`,
    );
    scheduleExpandRetry(requested);
  }
  return {
    x: actual.x,
    y: actual.y,
    width: actual.width,
    height: actual.height,
    displayId: screen.getDisplayMatching(actual).id,
  };
}

/** Re-applies the expanded bounds once the compositor settled; reports if it still fails. */
function scheduleExpandRetry(requested) {
  clearTimeout(expandRetryTimer);
  expandRetryTimer = setTimeout(() => {
    expandRetryTimer = null;
    if (!win || win.isDestroyed() || current().overlay.collapsed) return;
    win.setBounds(requested);
    const actual = win.getBounds();
    if (!isExpandedSizeUsable(actual)) {
      console.error(
        `[aqs] 窗口展开失败（实际 ${actual.width}×${actual.height}，期望 ≥${MIN_EXPANDED.width}×${MIN_EXPANDED.height}）`,
      );
      toast('warn', '窗口展开失败，请重启应用');
      return;
    }
    persistBounds('expand-retry');
    broadcastState();
  }, EXPAND_RETRY_MS);
}

/** Move the overlay by absolute screen coordinates (used by the pill drag). */
function moveOverlayTo(payload) {
  if (!win || win.isDestroyed()) return;
  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw ipcError('BAD_REQUEST', '窗口坐标无效');
  }
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const bounds = win.getBounds();
  const { workArea } = display;
  const maxX = workArea.x + Math.max(0, workArea.width - bounds.width);
  const maxY = workArea.y + Math.max(0, workArea.height - bounds.height);
  win.setPosition(
    Math.min(maxX, Math.max(workArea.x, Math.round(x))),
    Math.min(maxY, Math.max(workArea.y, Math.round(y))),
    false,
  );
}

function showOverlay({ focus = true, expandCollapsed = true } = {}) {
  if (!win || win.isDestroyed()) return;
  if (expandCollapsed && current().overlay.collapsed) applyCollapsed(false);
  trayVisible = true;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  if (focus) win.focus();
  refreshTray();
}

function hideOverlay() {
  if (!win || win.isDestroyed()) return;
  trayVisible = false;
  win.hide();
  refreshTray();
}

function toggleOverlay() {
  if (!win || win.isDestroyed()) return;
  const visible = win.isVisible() && trayVisible;
  if (!visible) {
    showOverlay();
    return;
  }
  // A visible pill is an affordance, not "shown": the first toggle expands it.
  if (current().overlay.collapsed) {
    showOverlay({ focus: true });
    return;
  }
  hideOverlay();
}

function createWindow() {
  const overlay = current().overlay;
  const bounds = computeBounds(overlay);

  win = new BrowserWindow({
    ...bounds,
    minWidth: overlay.collapsed ? COLLAPSED.width : MIN_EXPANDED.width,
    maxWidth: MAX_WIDTH,
    minHeight: overlay.collapsed ? COLLAPSED.height : MIN_EXPANDED.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: !overlay.collapsed,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: PRELOAD_FILE,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  win.once('ready-to-show', () => {
    win.setContentProtection(true);
    if (SMOKE) win.show();
    else win.showInactive();
  });

  win.on('show', () => {
    win.setContentProtection(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    trayVisible = true;
  });

  win.on('hide', () => {
    trayVisible = false;
  });

  win.on('move', () => schedulePersistBounds('move'));
  win.on('resize', () => schedulePersistBounds('resize'));

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideOverlay();
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[aqs] 渲染进程退出：', details?.reason ?? 'unknown');
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== uiFileUrl()) event.preventDefault();
  });

  win.webContents.once('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    win.setContentProtection(true);
    emit({ type: 'permission', screen: screenPermission() });
    const permission = screenPermission();
    if (permission === 'denied' || permission === 'restricted') {
      toast('warn', '未获得屏幕录制权限，请在系统设置中允许后重启应用');
    }
    broadcastState();
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[aqs] 界面加载失败（${code} ${description}）：${url}`);
  });

  win.webContents.on('context-menu', (event) => event.preventDefault());

  loadUi();
  if (SMOKE) win.show();
  return win;
}

function uiFileUrl() {
  return pathToFileURL(UI_FILE).href;
}

function loadUi() {
  if (!existsSync(UI_FILE)) {
    console.error(`[aqs] 找不到界面文件：${UI_FILE}`);
    return;
  }
  win.loadFile(UI_FILE).catch((error) => {
    // The pending load rejects when the app exits mid-load; that is expected during smoke shutdown.
    if (smoke.finished || quitting) return;
    console.error('[aqs] 界面加载失败：', error?.message ?? error);
  });
}

/* ----------------------------------------------------------------- tray -- */

function resolveTrayAsset() {
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const candidates = [path.join(app.getAppPath(), 'build', name)];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'build', name));
  candidates.push(path.join(app.getAppPath(), '..', 'build', name), path.join(HERE, '..', 'build', name));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Recolors a monochrome icon so the tray reflects demo/live mode. */
function tintIcon(image, [r, g, b]) {
  const size = image.getSize();
  if (!size.width || !size.height) return image;
  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length < size.width * size.height * 4) return image;
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i + 3] === 0) continue;
    const luminance = (0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2]) / 255;
    const weight = 0.25 + 0.75 * luminance;
    bitmap[i] = Math.min(255, Math.round(b * weight));
    bitmap[i + 1] = Math.min(255, Math.round(g * weight));
    bitmap[i + 2] = Math.min(255, Math.round(r * weight));
  }
  try {
    return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
  } catch (error) {
    console.error('[aqs] 托盘图标着色失败：', error?.message ?? error);
    return image;
  }
}

function trayImage(mode) {
  const asset = resolveTrayAsset();
  let base = asset ? nativeImage.createFromPath(asset) : nativeImage.createEmpty();
  if (base.isEmpty()) {
    base = nativeImage.createFromDataURL(`data:image/png;base64,${FALLBACK_TRAY_PNG}`);
  }
  if (base.isEmpty()) return base;
  if (process.platform === 'darwin') {
    // build/trayTemplate.png is 16x16 with a 32x32 @2x sibling; createFromPath
    // keeps both reps, so never resize it (that would drop the retina rep).
    const template = asset ? base : base.resize({ width: 16, height: 16 });
    template.setTemplateImage(true);
    return template;
  }
  const color = mode === 'demo' ? [245, 158, 11] : [34, 197, 94];
  return tintIcon(base, color);
}

function openLogDirectory() {
  try {
    app.setAppLogsPath();
    const dir = app.getPath('logs');
    mkdirSync(dir, { recursive: true });
    shell.openPath(dir).then((failure) => {
      if (failure) toast('warn', `无法打开日志目录：${failure}`);
    });
  } catch (error) {
    toast('error', `无法打开日志目录：${error?.message ?? error}`);
  }
}

function createTray() {
  if (tray) return tray;
  try {
    tray = new Tray(trayImage(engineMode()));
  } catch (error) {
    console.error('[aqs] 托盘创建失败：', error?.message ?? error);
    return null;
  }
  tray.on('click', () => toggleOverlay());
  tray.on('double-click', () => showOverlay());
  refreshTray();
  return tray;
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const s = current();
  const mode = engineMode();
  const collapsed = Boolean(s.overlay.collapsed);
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible() && trayVisible);
  tray.setImage(trayImage(mode));
  tray.setToolTip(
    `${APP_NAME} · ${mode === 'demo' ? '演示模式' : '在线模式'}${paused ? ' · 已暂停' : ''}${collapsed ? ' · 已折叠' : ''}`,
  );
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: collapsed ? '展开悬浮窗' : visible ? '隐藏悬浮窗' : '显示悬浮窗',
      click: () => (collapsed || !visible ? showOverlay() : hideOverlay()),
    },
    { type: 'separator' },
    {
      label: '自动识别',
      type: 'checkbox',
      checked: s.auto.enabled,
      click: (item) => setAutoFlag({ enabled: item.checked }),
    },
    {
      label: '自动解答',
      type: 'checkbox',
      checked: s.auto.autoAnswer,
      click: (item) => setAutoFlag({ autoAnswer: item.checked }),
    },
    {
      label: paused ? '继续' : '暂停',
      type: 'normal',
      click: () => setPaused(!paused),
    },
    { type: 'separator' },
    { label: '打开日志目录', click: () => openLogDirectory() },
    ...(process.platform === 'darwin'
      ? [
          { label: '屏幕录制权限…', click: () => openScreenPermission() },
          {
            label: '重启应用',
            click: () => {
              app.relaunch();
              quitApp();
            },
          },
        ]
      : []),
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]));
}

function setAutoFlag(patch) {
  try {
    currentSettings = settingsStore.saveSettings({ auto: patch });
  } catch (error) {
    toast('error', error?.message ?? '保存自动识别设置失败');
    return current();
  }
  broadcastState();
  refreshTray();
  return current();
}

function setPaused(flag) {
  paused = Boolean(flag);
  broadcastState();
  refreshTray();
  return current();
}

/* ------------------------------------------------------------- shortcuts -- */

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const { hotkeys } = current();
  const bindings = [
    { accelerator: hotkeys.toggle, run: () => toggleOverlay(), label: '显示/隐藏' },
    { accelerator: hotkeys.scan, run: () => sendCommand('scan'), label: '扫描' },
    { accelerator: hotkeys.pause, run: () => setPaused(!paused), label: '暂停/继续' },
  ];
  const failures = [];
  for (const binding of bindings) {
    if (!binding.accelerator) continue;
    try {
      const ok = globalShortcut.register(binding.accelerator, binding.run);
      if (!ok) failures.push(`${binding.label}（${binding.accelerator}）`);
    } catch (error) {
      failures.push(`${binding.label}（${binding.accelerator}：${error?.message ?? error}）`);
    }
  }
  if (failures.length > 0) {
    const message = `快捷键注册失败：${failures.join('、')}`;
    console.error(`[aqs] ${message}`);
    toast('warn', message);
  }
}

function sendCommand(command) {
  showOverlay({ focus: false });
  emit({ type: 'command', command });
}

/* -------------------------------------------------------------- permission -- */

function stopPermissionWatch() {
  if (!permissionTimer) return;
  clearInterval(permissionTimer);
  permissionTimer = null;
}

/** macOS only: new screen-capture grants need a fresh process to take effect. */
function offerPermissionRestart() {
  if (SMOKE || permissionRestartPrompted || quitting) return;
  permissionRestartPrompted = true;
  const options = {
    type: 'info',
    title: '屏幕录制权限已开启',
    message: '屏幕录制权限已开启',
    detail: 'macOS 需要重启应用后，屏幕录制权限才会生效。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
  const show = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  show
    .then(({ response }) => {
      if (response === 0) {
        app.relaunch();
        quitApp();
        return;
      }
      toast('info', '屏幕录制权限已开启，重启应用后生效');
    })
    .catch((error) => log('重启提示失败：', error?.message ?? error));
}

/**
 * Polls the TCC state for ~20s after the user is sent to System Settings or
 * lists windows. The system dialog can stay open, so one snapshot is not enough.
 */
function watchScreenPermission() {
  if (process.platform !== 'darwin' || SMOKE || quitting) return;
  if (permissionTimer) return;
  if (screenPermission() === 'granted') return;
  let attempts = 0;
  let last = screenPermission();
  permissionTimer = setInterval(() => {
    attempts += 1;
    const status = screenPermission();
    if (status !== last) {
      last = status;
      emit({ type: 'permission', screen: status });
      broadcastState();
    }
    if (status === 'granted') {
      stopPermissionWatch();
      offerPermissionRestart();
      return;
    }
    if (attempts >= PERMISSION_POLL_ATTEMPTS) stopPermissionWatch();
  }, PERMISSION_POLL_INTERVAL_MS);
  permissionTimer.unref?.();
}

function openScreenPermission() {
  if (process.platform !== 'darwin') return;
  watchScreenPermission();
  shell
    .openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    .then(() => toast('info', '请在系统设置中允许本应用，授权后重启应用生效'))
    .catch((error) => toast('error', `无法打开系统设置：${error?.message ?? error}`));
}

/* ---------------------------------------------------------------- history -- */

function historyFile() {
  return path.join(path.dirname(settingsStore.settingsFile()), 'history.json');
}

function loadHistory() {
  try {
    const file = historyFile();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => isPlainObject(entry) && typeof entry.question === 'string')
      .slice(0, HISTORY_LIMIT);
  } catch (error) {
    log('读取历史记录失败：', error?.message ?? error);
    return [];
  }
}

function persistHistory() {
  try {
    const file = historyFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('保存历史记录失败：', error?.message ?? error);
  }
}

function pushHistory(entry) {
  history = [entry, ...history].slice(0, HISTORY_LIMIT);
  persistHistory();
}

/* ---------------------------------------------------------------- answers -- */

/**
 * Aborts every in-flight answer. The pump itself emits `answer:error`
 * (code ABORTED) so each request produces exactly one terminal event.
 */
function abortAllAnswers() {
  for (const [requestId, controller] of [...activeAnswers.entries()]) {
    activeAnswers.delete(requestId);
    controller.abort();
  }
}

function startAnswer(input) {
  abortAllAnswers();
  const requestId = randomUUID();
  const controller = new AbortController();
  activeAnswers.set(requestId, controller);
  broadcastState();
  void pumpAnswer(requestId, controller, input);
  return requestId;
}

async function pumpAnswer(requestId, controller, input) {
  const activeEngine = engine;
  const startedAt = Date.now();
  const ensembleWanted = typeof input.ensemble === 'boolean'
    ? input.ensemble
    : Boolean(current().ai.ensemble.enabled);
  let text = '';
  let question = input.question ?? '';
  let options = input.options;
  let subject = input.subject;
  let terminal = false;
  try {
    if (!question.trim() && input.imageDataUrl) {
      const recognized = await recognizeImage(input.imageDataUrl, controller.signal, 'manual');
      question = String(recognized?.question ?? '');
      if (!options && Array.isArray(recognized?.options) && recognized.options.length > 0) options = recognized.options;
      if (!subject && recognized?.subject) subject = recognized.subject;
      emit({ type: 'recognized', question, trigger: 'manual' });
    }
    if (!question.trim()) throw ipcError('BAD_REQUEST', '没有可解答的题目');

    for await (const event of activeEngine.answerStream(
      { question, options, subject, style: input.style },
      { signal: controller.signal, ensemble: ensembleWanted },
    )) {
      if (controller.signal.aborted) break;
      if (!event || typeof event !== 'object') continue;
      if (event.type === 'meta') {
        emit({
          type: 'answer:meta',
          requestId,
          cached: Boolean(event.cached),
          mode: activeEngine.mode,
          model: typeof event.model === 'string' && event.model
            ? event.model
            : activeEngine.models?.chat ?? '',
          question: event.question ?? question,
          options: event.options ?? options ?? [],
          subject: event.subject ?? subject ?? '未知',
          style: event.style ?? input.style ?? 'concise',
          ensemble: Boolean(event.ensemble ?? ensembleWanted),
          candidates: Array.isArray(event.candidates) ? event.candidates : [],
          judge: event.judge ?? null,
        });
      } else if (event.type === 'candidate') {
        emit({
          type: 'answer:candidate',
          requestId,
          index: Number.isFinite(event.index) ? event.index : 0,
          name: typeof event.name === 'string' ? event.name : '',
          model: typeof event.model === 'string' ? event.model : '',
          status: typeof event.status === 'string' ? event.status : 'running',
          text: typeof event.text === 'string' ? event.text : undefined,
          error: asErrorText(event.error),
          durationMs: Number.isFinite(event.durationMs) ? event.durationMs : undefined,
          usage: event.usage ?? undefined,
        });
      } else if (event.type === 'delta') {
        text += event.text ?? '';
        emit({ type: 'answer:delta', requestId, text: event.text ?? '' });
      } else if (event.type === 'done') {
        terminal = true;
        const finalText = typeof event.text === 'string' ? event.text : text;
        const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : Date.now() - startedAt;
        const candidates = Array.isArray(event.candidates) ? event.candidates : [];
        const judge = event.judge ?? null;
        const fallback = Boolean(event.fallback);
        const ensemble = Boolean(event.ensemble ?? ensembleWanted);
        emit({
          type: 'answer:done',
          requestId,
          text: finalText,
          durationMs,
          usage: event.usage ?? null,
          cached: Boolean(event.cached),
          ensemble,
          candidates,
          judge,
          fallback,
        });
        pushHistory({
          id: requestId,
          question: String(question).slice(0, 500),
          answer: finalText,
          subject: subject ?? '未知',
          style: input.style ?? current().style,
          mode: activeEngine.mode,
          cached: Boolean(event.cached),
          ensemble,
          models: candidates.map((candidate) => candidate?.name).filter((name) => typeof name === 'string'),
          fallback,
          at: Date.now(),
        });
        smokeAnswer(question, finalText);
      }
    }
  } catch (error) {
    terminal = true;
    if (controller.signal.aborted) {
      emit({ type: 'answer:error', requestId, code: 'ABORTED', message: '已停止' });
    } else {
      emit({
        type: 'answer:error',
        requestId,
        code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
        message: error?.message ?? '解答失败',
      });
    }
  } finally {
    if (activeAnswers.get(requestId) === controller) activeAnswers.delete(requestId);
    // Breaking out of the stream on abort still owes the renderer a terminal event.
    if (!terminal && controller.signal.aborted) {
      emit({ type: 'answer:error', requestId, code: 'ABORTED', message: '已停止' });
    }
    broadcastState();
  }
}

/** Serializes recognition (concurrency 1) and reuses identical images for 10s. */
function recognizeImage(imageDataUrl, signal, trigger) {
  const key = createHash('sha256').update(imageDataUrl).digest('hex');
  const cached = lastRecognize;
  if (cached && cached.key === key && Date.now() - cached.at < RECOGNIZE_DEDUPE_MS) {
    log(`识别命中重复帧缓存（${trigger}）`);
    return Promise.resolve(cached.result);
  }
  const run = () => engine.recognize({ imageDataUrl, signal });
  const queued = recognizeChain.then(run, run);
  recognizeChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued.then((result) => {
    lastRecognize = { key, at: Date.now(), result };
    return result;
  });
}

/* ------------------------------------------------------------- IPC input -- */

function asString(value, label, { max = 1000, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw ipcError('BAD_REQUEST', `${label} 必须是字符串`);
  if (!allowEmpty && value.trim() === '') throw ipcError('BAD_REQUEST', `${label} 不能为空`);
  if (value.length > max) throw ipcError('BAD_REQUEST', `${label} 不能超过 ${max} 个字符`);
  return value;
}

function asEnum(value, label, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw ipcError('BAD_REQUEST', `${label} 必须是 ${allowed.join(' / ')} 之一`);
  }
  return value;
}

function asBoolean(value, label) {
  if (typeof value !== 'boolean') throw ipcError('BAD_REQUEST', `${label} 必须是布尔值`);
  return value;
}

/** Engine error fields may be a string, an Error or a `{message}` object. */
function asErrorText(value) {
  if (typeof value === 'string') return value || undefined;
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message || undefined;
  return undefined;
}

function asImageDataUrl(value) {
  if (typeof value !== 'string' || value === '') throw ipcError('BAD_REQUEST', '缺少图片数据');
  if (value.length > MAX_IMAGE_CHARS) throw ipcError('PAYLOAD_TOO_LARGE', '图片过大，请缩小采集区域');
  if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value)) {
    throw ipcError('UNSUPPORTED', '只支持 PNG/JPEG/WebP/GIF 图片');
  }
  return value;
}

function asOptions(raw) {
  if (raw === undefined || raw === null) return undefined;
  let list;
  if (typeof raw === 'string') list = raw.split(/\r?\n/);
  else if (Array.isArray(raw)) list = raw;
  else throw ipcError('BAD_REQUEST', 'options 必须是数组或字符串');
  if (list.length > 20) throw ipcError('BAD_REQUEST', '选项过多');
  const options = [];
  for (const item of list) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'string') {
      const text = item.trim().slice(0, 500);
      if (text) options.push({ label: String.fromCharCode(65 + options.length), text });
      continue;
    }
    if (!isPlainObject(item)) throw ipcError('BAD_REQUEST', '选项必须是字符串或 {label,text}');
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 500) : '';
    if (!text) continue;
    const label = typeof item.label === 'string' && item.label.trim()
      ? item.label.trim().slice(0, 8)
      : String.fromCharCode(65 + options.length);
    options.push({ label, text });
    if (options.length >= 10) break;
  }
  return options.length > 0 ? options.slice(0, 10) : undefined;
}

function asAnswerInput(raw) {
  if (!isPlainObject(raw)) throw ipcError('BAD_REQUEST', 'answer 参数必须是对象');
  const question = raw.question === undefined || raw.question === null
    ? ''
    : asString(raw.question, '题目', { max: 8000, allowEmpty: true });
  const imageDataUrl = raw.imageDataUrl === undefined || raw.imageDataUrl === null || raw.imageDataUrl === ''
    ? undefined
    : asImageDataUrl(raw.imageDataUrl);
  if (!question.trim() && !imageDataUrl) throw ipcError('BAD_REQUEST', '题目文本和图片至少提供一项');
  const input = { question, imageDataUrl };
  const options = asOptions(raw.options);
  if (options) input.options = options;
  if (raw.subject !== undefined && raw.subject !== null) {
    input.subject = asString(raw.subject, '学科', { max: 80, allowEmpty: true });
  }
  if (raw.style !== undefined && raw.style !== null) input.style = asEnum(raw.style, '风格', STYLES);
  if (raw.ensemble !== undefined && raw.ensemble !== null) {
    input.ensemble = asBoolean(raw.ensemble, '交叉验证开关');
  }
  return input;
}

function asRecognizePayload(raw) {
  const payload = typeof raw === 'string' ? { imageDataUrl: raw } : raw;
  if (!isPlainObject(payload)) throw ipcError('BAD_REQUEST', 'recognize 参数必须是图片 dataURL');
  const imageDataUrl = asImageDataUrl(payload.imageDataUrl);
  const trigger = payload.trigger === 'auto' ? 'auto' : 'manual';
  return { imageDataUrl, trigger };
}

/* ------------------------------------------------------------------- IPC -- */

/** Encodes `code` into the message tail so preload can rebuild it. */
function encodeError(error) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL';
  const message = typeof error?.message === 'string' && error.message ? error.message : '操作失败';
  return new Error(JSON.stringify({ code, message }));
}

function handle(channel, run) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await run(event, ...args);
    } catch (error) {
      throw encodeError(error);
    }
  });
}

function registerIpc() {
  handle('aqs:get-state', async () => buildState());

  handle('aqs:update-settings', async (_event, patch) => {
    const clean = settingsStore.validatePatch(patch);
    const before = current();
    const next = settingsStore.saveSettings(clean);
    currentSettings = next;

    if (JSON.stringify(before.ai) !== JSON.stringify(next.ai)) rebuildEngine();
    if (JSON.stringify(before.hotkeys) !== JSON.stringify(next.hotkeys)) registerHotkeys();
    if (clean.overlay && clean.overlay.collapsed !== undefined) {
      if (win && !win.isDestroyed()) applyCollapsed(clean.overlay.collapsed);
    } else if (
      win
      && !win.isDestroyed()
      && !next.overlay.collapsed
      && (clean.overlay?.width !== undefined || clean.overlay?.height !== undefined)
    ) {
      const bounds = win.getBounds();
      const width = clean.overlay?.width ?? bounds.width;
      const height = clean.overlay?.height ?? bounds.height;
      if (width < MIN_EXPANDED.width || height < MIN_EXPANDED.height) {
        // Repair instead of squeezing the panel into the old collapsed size.
        applyCollapsed(false);
      } else if (bounds.width !== width || bounds.height !== height) {
        win.setBounds({ ...bounds, width, height });
      }
    }
    broadcastState();
    refreshTray();
    return buildState();
  });

  handle('aqs:test-connection', async (_event, patch) => {
    // Only the validated, unsaved patch is probed; it is never persisted or broadcast.
    const clean = patch === undefined || patch === null ? {} : settingsStore.validatePatch(patch);
    if (probeController) probeController.abort();
    const controller = new AbortController();
    probeController = controller;
    try {
      return await testConnection(current(), clean, { signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw ipcError('ABORTED', '连接测试已取消');
      throw error;
    } finally {
      if (probeController === controller) probeController = null;
    }
  });

  handle('aqs:list-sources', async () => {
    // getSources triggers the macOS TCC prompt; watch it so a grant is not lost.
    if (process.platform === 'darwin' && screenPermission() !== 'granted') watchScreenPermission();
    return listSources({ excludeIds: [mediaSourceId()].filter(Boolean) });
  });

  handle('aqs:select-source', async (_event, id) => {
    const sourceId = asString(id, '窗口 ID', { max: 512 });
    const result = await selectSource(sourceId);
    if (!result.ok) {
      throw ipcError(result.error?.code ?? 'SOURCE_NOT_FOUND', result.error?.message ?? '无法选择该窗口');
    }
    currentSettings = settingsStore.loadSettings();
    broadcastState();
    return buildState();
  });

  handle('aqs:clear-source', async () => {
    currentSettings = clearSource();
    broadcastState();
    return buildState();
  });

  handle('aqs:recognize', async (_event, payload) => {
    const { imageDataUrl, trigger } = asRecognizePayload(payload);
    const result = await recognizeImage(imageDataUrl, undefined, trigger);
    emit({ type: 'recognized', question: String(result?.question ?? ''), trigger });
    return result;
  });

  handle('aqs:answer', async (_event, payload) => {
    const input = asAnswerInput(payload);
    return { requestId: startAnswer(input) };
  });

  handle('aqs:stop-answer', async (_event, requestId) => {
    const id = asString(requestId, 'requestId', { max: 100 });
    const controller = activeAnswers.get(id);
    if (controller) {
      activeAnswers.delete(id);
      controller.abort();
    }
  });

  handle('aqs:set-auto', async (_event, patch) => {
    if (!isPlainObject(patch)) throw ipcError('BAD_REQUEST', 'auto 参数必须是对象');
    const clean = settingsStore.validatePatch({ auto: patch });
    currentSettings = settingsStore.saveSettings(clean);
    broadcastState();
    refreshTray();
    return buildState();
  });

  handle('aqs:set-paused', async (_event, flag) => {
    setPaused(asBoolean(flag, '暂停状态'));
    return buildState();
  });

  handle('aqs:capture-status', async () => {
    const s = current();
    return {
      source: s.capture.sourceId ? { id: s.capture.sourceId, name: s.capture.sourceName } : null,
      permission: screenPermission(),
      capturing: isCapturing(),
    };
  });

  handle('aqs:open-screen-permission', async () => {
    openScreenPermission();
  });

  handle('aqs:collapse', async (_event, flag) => {
    applyCollapsed(asBoolean(flag, '折叠状态'));
    return buildState();
  });

  handle('aqs:move-window', async (_event, payload) => {
    moveOverlayTo(payload);
  });

  handle('aqs:drag-end', async () => {
    schedulePersistBounds('drag');
  });

  handle('aqs:show-overlay', async () => {
    showOverlay();
  });

  handle('aqs:quit', async () => {
    quitApp();
  });
}

/* ------------------------------------------------------------------ smoke -- */

function smokeOut(tag, payload) {
  // writeSync keeps the line complete even though the process exits right after.
  writeSync(1, `${tag} ${JSON.stringify(payload)}\n`);
}

function finishSmoke(code) {
  if (smoke.finished) return;
  smoke.finished = true;
  if (smoke.timer) {
    clearTimeout(smoke.timer);
    smoke.timer = null;
  }
  cleanup();
  app.exit(code);
}

function smokeFail(reason) {
  if (smoke.finished) return;
  writeSync(1, `SMOKE_FAIL ${reason}\n`);
  finishSmoke(1);
}

function smokeAnswer(question, text) {
  if (!SMOKE || !SMOKE_AUTO || smoke.answered) return;
  smoke.answered = true;
  smokeOut('SMOKE_ANSWER', { question: String(question ?? '').slice(0, 200), chars: String(text ?? '').length });
  finishSmoke(0);
}

function waitForLoad(target, timeoutMs) {
  return new Promise((resolve) => {
    if (!target || target.isDestroyed() || target.webContents.isLoading() === false) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    target.webContents.once('did-finish-load', finish);
    target.webContents.once('did-fail-load', finish);
  });
}

async function applySmokeSource() {
  const wanted = (process.env.AQS_SMOKE_SOURCE ?? '').trim();
  if (!wanted) return;
  const needle = wanted.toLowerCase();
  let sources;
  try {
    sources = await listSources();
  } catch (error) {
    smokeFail(`SOURCE_LIST_FAILED ${error?.message ?? error}`);
    return;
  }
  const match = sources.find((source) => source.name.toLowerCase().includes(needle));
  if (!match) {
    smokeFail('SOURCE_NOT_FOUND');
    return;
  }
  currentSettings = settingsStore.saveSettings({ capture: { sourceId: match.id, sourceName: match.name } });
  log(`冒烟模式已选中窗口：${match.name}`);
}

async function waitForUiReady(target, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!target || target.isDestroyed()) return false;
    try {
      const ready = await target.webContents.executeJavaScript(
        `(() => {
          const app = document.querySelector('#app');
          const panel = document.querySelector('#panel');
          return (
            document.readyState === 'complete' &&
            app?.dataset.ready === 'true' &&
            !!panel &&
            getComputedStyle(panel).display !== 'none'
          );
        })()`,
        true,
      );
      if (ready) return true;
    } catch {
      // The renderer context does not exist yet while the page is loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function runSmokeReady() {
  if (smoke.finished) return;
  try {
    if (!win || win.isDestroyed()) throw new Error('窗口未创建');
    const uiReady = await waitForUiReady(win, 8000);
    if (!uiReady) throw new Error('界面未就绪');
    // Let the first themed paint settle so the screenshot is not the blank pre-CSS frame.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const shot = (process.env.AQS_SMOKE_SHOT ?? '').trim();
    if (shot) {
      const file = path.resolve(shot);
      mkdirSync(path.dirname(file), { recursive: true });
      const image = await win.webContents.capturePage();
      const png = image.toPNG();
      if (!png || png.length === 0) throw new Error('capturePage 返回空图片');
      writeFileSync(file, png);
    }
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    smokeOut('SMOKE_READY', {
      bounds,
      mode: engineMode(),
      platform: process.platform,
      version: app.getVersion(),
      display: {
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
      },
    });
    const keepAlive = SMOKE_AUTO || SMOKE_EXIT;
    if (!keepAlive) setTimeout(() => finishSmoke(0), 400);
  } catch (error) {
    smokeFail(`READY_FAILED ${error?.message ?? error}`);
  }
}

/* ------------------------------------------------------------------ lifecycle -- */

/**
 * macOS needs an application menu even for an LSUIElement app: the Edit roles
 * are what wire Cmd+C/V/X/A/Z inside the frameless settings form.
 */
function installMacMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: `Copyright © ${new Date().getFullYear()} ${APP_NAME}`,
  });
}

function cleanup() {
  quitting = true;
  if (cleanedUp) return;
  cleanedUp = true;
  clearTimeout(boundsTimer);
  clearTimeout(expandRetryTimer);
  expandRetryTimer = null;
  clearTimeout(smoke.timer);
  stopPermissionWatch();
  smoke.timer = null;
  abortAllAnswers();
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* already shutting down */
  }
  if (win && !win.isDestroyed()) {
    try {
      persistBounds('quit');
    } catch {
      /* the window may be mid-destruction */
    }
  }
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}

function quitApp() {
  cleanup();
  app.quit();
}

function startSmokeTimeout() {
  smoke.timer = setTimeout(() => smokeFail('TIMEOUT'), SMOKE_TIMEOUT_MS);
}

async function boot() {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId(PRODUCT_ID);
  if (process.platform === 'darwin') {
    installMacMenu();
    if (app.dock) app.dock.hide();
  }

  settingsStore.cleanupTempFiles();
  currentSettings = settingsStore.loadSettings();
  history = loadHistory();
  engine = createEngine(buildEngineConfig());

  if (SMOKE) startSmokeTimeout();

  if (SMOKE) await applySmokeSource();
  if (smoke.finished) return;
  if (SMOKE_AUTO) {
    currentSettings.auto = { ...currentSettings.auto, enabled: true };
  }

  registerIpc();
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const own = webContents === win?.webContents;
      callback(own && (permission === 'media' || permission === 'display-capture'));
    });
  } catch (error) {
    console.error('[aqs] 权限处理器注册失败：', error?.message ?? error);
  }

  createWindow();

  if (!SMOKE) {
    createTray();
    registerHotkeys();
    screen.on('display-removed', () => ensureWindowVisible());
    screen.on('display-metrics-changed', () => ensureWindowVisible());
  }

  if (SMOKE) {
    await waitForLoad(win, 5000);
    await runSmokeReady();
  }
}

function ensureWindowVisible() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  if (isVisibleOnSomeDisplay(bounds)) return;
  const overlay = current().overlay;
  const fixed = computeBounds({ ...overlay, x: null, y: null });
  win.setBounds(fixed);
}

/* --------------------------------------------------------------- app boot -- */

const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    // showOverlay() expands a collapsed pill, so a second launch always reveals the panel.
    showOverlay();
  });

  app.on('window-all-closed', () => {
    // Tray-resident app: closing the panel must never quit it.
  });

  app.on('activate', () => {
    if (!win) createWindow();
    showOverlay();
  });

  app.on('will-quit', () => {
    cleanup();
  });

  app.whenReady().then(boot).catch((error) => {
    console.error('[aqs] 启动失败：', error?.stack ?? error);
    if (SMOKE) smokeFail(`BOOT_FAILED ${error?.message ?? error}`);
    else app.quit();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[aqs] 未处理的 Promise 拒绝：', reason?.stack ?? reason);
});

process.on('uncaughtException', (error) => {
  console.error('[aqs] 未捕获异常：', error?.stack ?? error);
  if (SMOKE) smokeFail(`UNCAUGHT ${error?.message ?? error}`);
});
