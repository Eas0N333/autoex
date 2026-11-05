/**
 * desktopCapturer sources for the overlay app (docs/CONTRACT-DESKTOP.md §4).
 *
 * The renderer only needs an id and a human label; capture itself happens in the
 * renderer via getUserMedia. Thumbnails are 320x200 data URLs for the picker.
 */

import { desktopCapturer } from 'electron';

import { loadSettings, saveSettings } from './settings.js';

export const THUMBNAIL_SIZE = Object.freeze({ width: 320, height: 200 });

/**
 * macOS (ScreenCaptureKit) can leave getSources pending forever while TCC is
 * undecided, so the picker must fail with actionable copy instead of spinning.
 */
const SOURCE_TIMEOUT_MS = 8_000;

function sourceListError(message) {
  const error = new Error(message);
  error.code = 'SOURCE_LIST_FAILED';
  return error;
}

async function captureSources() {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(sourceListError(
        process.platform === 'darwin'
          ? '读取窗口列表超时：请先在系统设置中允许本应用录屏，然后重启应用重试'
          : '读取窗口列表超时，请稍后重试',
      ));
    }, SOURCE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: THUMBNAIL_SIZE.width, height: THUMBNAIL_SIZE.height },
        fetchWindowIcons: false,
      }),
      timeout,
    ]);
  } catch (error) {
    // Electron rejects with a bare string ("Failed to get sources.") on macOS
    // when TCC is denied; give the renderer a stable code and actionable copy.
    if (error?.code === 'SOURCE_LIST_FAILED') throw error;
    const detail = typeof error === 'string' ? error : error?.message;
    throw sourceListError(
      process.platform === 'darwin'
        ? `读取窗口列表失败${detail ? `（${detail}）` : ''}：请在系统设置中允许本应用录屏，然后重启应用重试`
        : `读取窗口列表失败${detail ? `（${detail}）` : ''}，请稍后重试`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Ordered so the picker can put browsers first. */
const BROWSER_MATCHERS = Object.freeze([
  { label: 'Chrome', pattern: /google chrome|chromium|\bchrome\b/i },
  { label: 'Edge', pattern: /microsoft edge|msedge|edge 浏览器|\bms edge\b/i },
  { label: 'Firefox', pattern: /firefox/i },
  { label: 'Safari', pattern: /safari/i },
  { label: 'Arc', pattern: /\barc\b/i },
  { label: 'Brave', pattern: /brave/i },
  { label: 'Opera', pattern: /opera/i },
  { label: '360', pattern: /360(?:安全|极速|浏览器)|\b360browser\b/i },
  { label: 'QQ浏览器', pattern: /qq\s*浏览器|qqbrowser/i },
]);

/** Names that belong to the overlay itself and must never be captured. */
const SELF_NAME = /ai\s*答题|ai[\s-]*quiz|electron\s*$|^aiquiz/i;

/** Window titles carry zero-width joiners (Microsoft\u200b Edge) and stray spacing. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

export function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function sourceName(source) {
  return cleanTitle(source?.name);
}

function isSelfName(name) {
  return SELF_NAME.test(name);
}

export function browserLabel(name) {
  const title = cleanTitle(name);
  if (!title) return null;
  for (const matcher of BROWSER_MATCHERS) {
    if (matcher.pattern.test(title)) return matcher.label;
  }
  return null;
}

export function isBrowserName(name) {
  return browserLabel(name) !== null;
}

function kindRank(source) {
  if (isBrowserName(source.name)) return 0;
  return source.kind === 'window' ? 1 : 2;
}

function thumbnailOf(source) {
  const thumbnail = source?.thumbnail;
  if (!thumbnail || (typeof thumbnail.isEmpty === 'function' && thumbnail.isEmpty())) return undefined;
  try {
    return thumbnail.toDataURL();
  } catch {
    return undefined;
  }
}

function appIconOf(source) {
  const icon = source?.appIcon;
  if (!icon || (typeof icon.isEmpty === 'function' && icon.isEmpty())) return undefined;
  try {
    return icon.toDataURL();
  } catch {
    return undefined;
  }
}

function normalizeSource(source, kind) {
  const name = sourceName(source);
  const shaped = {
    id: String(source.id),
    name,
    kind,
    isBrowser: isBrowserName(name),
  };
  const appIcon = appIconOf(source);
  if (appIcon) shaped.appIcon = appIcon;
  const thumbnail = thumbnailOf(source);
  if (thumbnail) shaped.thumbnail = thumbnail;
  return shaped;
}

/**
 * Lists capturable windows and screens. Browsers first, then other windows,
 * then whole screens; the overlay's own window and untitled sources are dropped.
 */
export async function listSources({ excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds.filter(Boolean).map(String));
  const raw = await captureSources();

  const sources = [];
  for (const source of raw ?? []) {
    const name = sourceName(source);
    if (!name) continue;
    if (isSelfName(name)) continue;
    const id = String(source.id);
    if (excluded.has(id)) continue;
    const kind = String(id).startsWith('screen:') ? 'screen' : 'window';
    sources.push(normalizeSource(source, kind));
  }

  const rank = new Map(sources.map((source) => [source.id, kindRank(source)]));
  return sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => (rank.get(a.source.id) - rank.get(b.source.id)) || (a.index - b.index))
    .map(({ source }) => source);
}

/**
 * Validates that `id` still exists and remembers it as the capture target.
 * Returns `{ ok:false, error }` instead of throwing so the renderer can show it.
 */
export async function selectSource(id) {
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: '窗口 ID 不能为空' } };
  }
  const wanted = id.trim();
  let sources;
  try {
    sources = await listSources();
  } catch (error) {
    return {
      ok: false,
      error: { code: 'SOURCE_LIST_FAILED', message: `无法读取窗口列表：${error?.message ?? error}` },
    };
  }
  const source = sources.find((item) => item.id === wanted);
  if (!source) {
    return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '窗口已关闭或不存在，请刷新列表后重试' } };
  }
  saveSettings({ capture: { sourceId: source.id, sourceName: source.name } });
  return {
    ok: true,
    source: { id: source.id, name: source.name, kind: source.kind, isBrowser: source.isBrowser },
  };
}

/** Forgets the capture target (renderer shows the "choose a window" state). */
export function clearSource() {
  saveSettings({ capture: { sourceId: null, sourceName: null } });
  return loadSettings();
}
