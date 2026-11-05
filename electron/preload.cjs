/**
 * Sandboxed preload — plain CommonJS on purpose: the package root is
 * `"type": "module"`, so an ESM preload would not load in a sandboxed renderer.
 *
 * Exposes exactly the `window.aqs` surface from docs/CONTRACT-DESKTOP.md §5.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNEL = 'aqs:event';

/**
 * Main rejects with `new Error(JSON.stringify({code, message}))` so the code
 * survives Electron's IPC serialization. The rejection is rebuilt as a plain
 * `{code, message}` object because a contextBridge copy keeps only an Error's
 * message — custom properties (including `code`) are stripped.
 */
function decodeError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error);
  const tail = raw.slice(raw.lastIndexOf('{'));
  if (tail) {
    try {
      const payload = JSON.parse(tail);
      if (payload && typeof payload.code === 'string') {
        return {
          name: 'AqsError',
          code: payload.code,
          message: typeof payload.message === 'string' ? payload.message : raw,
          stack: typeof error?.stack === 'string' ? error.stack : undefined,
        };
      }
    } catch {
      /* not an encoded error — fall through */
    }
  }
  return {
    name: 'AqsError',
    code: 'INTERNAL',
    message: raw,
    stack: typeof error?.stack === 'string' ? error.stack : undefined,
  };
}

function invoke(channel, payload) {
  const call = payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload);
  return call.catch((error) => {
    throw decodeError(error);
  });
}

function assertCallback(cb) {
  if (typeof cb !== 'function') throw new TypeError('onEvent 需要一个函数');
}

const api = {
  getState: () => invoke('aqs:get-state'),

  updateSettings: (patch) => invoke('aqs:update-settings', patch),

  testConnection: (patch) => invoke('aqs:test-connection', patch),

  listSources: () => invoke('aqs:list-sources'),

  selectSource: (id) => invoke('aqs:select-source', id),

  clearSource: () => invoke('aqs:clear-source'),

  recognize: (imageDataUrl, trigger) => invoke('aqs:recognize', { imageDataUrl, trigger }),

  answer: (input) => invoke('aqs:answer', input),

  stopAnswer: (requestId) => invoke('aqs:stop-answer', requestId),

  setAuto: (patch) => invoke('aqs:set-auto', patch),

  setPaused: (flag) => invoke('aqs:set-paused', flag),

  captureStatus: () => invoke('aqs:capture-status'),

  openScreenPermission: () => invoke('aqs:open-screen-permission'),

  collapse: (flag) => invoke('aqs:collapse', flag),

  moveWindow: (position) => invoke('aqs:move-window', position),

  dragEnd: () => invoke('aqs:drag-end'),

  showOverlay: () => invoke('aqs:show-overlay'),

  quit: () => invoke('aqs:quit'),

  onEvent: (cb) => {
    assertCallback(cb);
    const listener = (_event, payload) => {
      try {
        cb(payload);
      } catch {
        /* a renderer handler must never break the IPC pump */
      }
    };
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('aqs', api);
