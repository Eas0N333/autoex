#!/usr/bin/env node
// Collapse/expand smoke test: boots the Electron overlay with a throwaway
// settings file that starts collapsed, then drives the real UI over the Chrome
// DevTools Protocol and asserts the window can be expanded again.
//
// The regression it covers: a collapsed transparent window used to restore its
// clamp-ed 56x96 "requested" bounds, so the app looked expanded while the window
// stayed pill-sized (or shrank to the 320x420 minimum), hiding the panel.
//
// Usage: node scripts/collapse-smoke.mjs
// Prints "COLLAPSE SMOKE OK" and exits 0 on success, otherwise prints
// "COLLAPSE FAIL <reason>" plus diagnostics and exits non-zero.
// Zero dependencies: uses node:net for the DevTools WebSocket.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

const READY_TIMEOUT_MS = Number(process.env.AQS_COLLAPSE_TIMEOUT_MS) || 40_000;
const TRANSITION_TIMEOUT_MS = 8_000;
const SETTLE_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const CYCLES = 3;

/** Pill window bounds (main.js COLLAPSED = 56x96) with a small slack. */
const COLLAPSED_MAX = { width: 70, height: 110 };
/** Smallest window that can still show the panel comfortably. */
const EXPANDED_MIN = { width: 380, height: 560 };
/** The panel must fill the expanded window, not a sliver of it. */
const PANEL_MIN = { width: 360, height: 520 };
/** Persisted bounds vs. live window size tolerance. */
const PERSIST_TOLERANCE = 10;
/** File prefix contract from the main process. */
const FAIL_PREFIX = 'COLLAPSE FAIL ';

const electronBinary = resolveElectronBinary();
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'aqs-collapse-'));
const settingsFile = path.join(tmpRoot, 'settings.json');
const profileDir = path.join(tmpRoot, 'profile');
const shotFile = path.join(tmpRoot, 'collapsed.png');
const shotExpanded = path.join(tmpRoot, 'expanded.png');
const logTail = { stdout: '', stderr: '' };

let cdp = null;
let child = null;
let stage = '启动';
let spawnError = null;

function resolveElectronBinary() {
  if (process.env.ELECTRON_BIN) return process.env.ELECTRON_BIN;
  const require = createRequire(import.meta.url);
  let electronPath;
  try {
    electronPath = require('electron');
  } catch (error) {
    throw new Error(
      `无法解析 electron 可执行文件（node_modules/electron 未正确安装）：${error.message}\n请先运行 npm install`,
    );
  }
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    throw new Error(`electron 可执行文件不存在：${String(electronPath)}`);
  }
  return electronPath;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function describe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function killTree(target) {
  if (!target || target.pid === undefined) return;
  if (target.exitCode !== null || target.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(target.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  target.kill('SIGTERM');
  spawnSync('sh', ['-c', `sleep 1; kill -9 ${target.pid} 2>/dev/null || true`], { stdio: 'ignore' });
}

function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!head.subarray(0, 8).equals(signature)) throw new Error(`${file} 不是 PNG 文件`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function readSettings() {
  if (!existsSync(settingsFile)) return null;
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return null;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------ websocket -- */

/** Minimal RFC 6455 client: text frames out, text/ping/close handled in. */
class DevToolsSocket {
  constructor(url) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port) || 80;
    this.pathName = `${parsed.pathname}${parsed.search}`;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.closed = false;
    this.fragments = [];
    this.nextId = 1;
    this.pending = new Map();
  }

  connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`DevTools WebSocket 握手超时（${timeoutMs}ms）`));
      }, timeoutMs);

      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);

      const onHandshakeError = (error) => {
        clearTimeout(timer);
        reject(error);
      };

      socket.once('error', onHandshakeError);
      socket.once('connect', () => {
        socket.write(
          [
            `GET ${this.pathName} HTTP/1.1`,
            `Host: ${this.host}:${this.port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.handshakeDone) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = this.buffer.subarray(0, end).toString('latin1');
          this.buffer = this.buffer.subarray(end + 4);
          if (!/^HTTP\/1\.1 101/.test(head)) {
            onHandshakeError(new Error(`DevTools WebSocket 握手失败：${head.split('\r\n')[0] || '<空响应>'}`));
            socket.destroy();
            return;
          }
          this.handshakeDone = true;
          clearTimeout(timer);
          socket.off('error', onHandshakeError);
          socket.on('error', (error) => this.failAll(error));
          socket.once('close', () => {
            this.closed = true;
            this.failAll(new Error('DevTools WebSocket 已关闭'));
          });
          resolve();
        }
        this.drainFrames();
      });
    });
  }

  failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  drainFrames() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];

      if (opcode === 0x8) {
        this.writeFrame(0x8, Buffer.alloc(0));
        this.socket?.end();
        this.closed = true;
        this.failAll(new Error('DevTools WebSocket 对端关闭'));
        return;
      }
      if (opcode === 0x9) {
        this.writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (!fin) continue;
        this.handleMessage(Buffer.concat(this.fragments).toString('utf8'));
        this.fragments = [];
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this.handleMessage(payload.toString('utf8'));
        else this.fragments = [payload];
      }
    }
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    // 只处理命令回复；CDP 事件（无 id）这里不需要。
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
    else entry.resolve(message.result ?? {});
  }

  writeFrame(opcode, payload) {
    if (!this.socket || this.closed) return;
    const mask = crypto.randomBytes(4);
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length]);
    } else if (length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(method, params = {}, timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(new Error('DevTools WebSocket 已关闭'));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeFrame(0x1, body);
    });
  }

  close() {
    if (!this.socket || this.closed) return;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
    } catch {
      // 已经断开时忽略
    }
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}

/* ----------------------------------------------------------------- CDP -- */

async function listPageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`/json/list 返回 ${response.status}`);
  const targets = await response.json();
  if (!Array.isArray(targets)) return [];
  return targets.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string');
}

async function waitForTarget(port, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`electron 启动失败：${spawnError.message}`);
    try {
      const [target] = await listPageTargets(port);
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    if (child && child.exitCode !== null) {
      throw new Error(`electron 在暴露 DevTools 之前退出（code=${child.exitCode}）；${processFailureHint()}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`等待 DevTools 目标超时${lastError ? `：${lastError.message}` : ''}`);
}

async function evaluate(expression, { awaitPromise = true } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
    includeCommandLineAPI: false,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || '未知异常';
    throw new Error(`页面脚本执行失败：${detail.split('\n')[0]}`);
  }
  return result.result?.value;
}

const MEASURE_EXPRESSION = `(() => {
  const app = document.getElementById('app');
  const pill = document.getElementById('collapse-pill');
  const panel = document.getElementById('panel');
  const rect = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const shown = (el) => {
    if (!el || el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  return {
    ready: app ? app.dataset.ready === 'true' : false,
    collapsed: app ? app.dataset.collapsed === 'true' : null,
    width: window.outerWidth,
    height: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    pillVisible: shown(pill),
    pillText: pill ? String(pill.innerText || pill.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    pillLabel: pill ? String(pill.getAttribute('aria-label') || '') : '',
    pillRect: rect(pill),
    panelVisible: shown(panel),
    panelRect: rect(panel),
  };
})()`;

function measure() {
  return evaluate(MEASURE_EXPRESSION);
}

async function pollUntil(label, predicate, timeoutMs = TRANSITION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      last = await measure();
      if (predicate(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  const detail = last ? `最后状态：${describe(last)}` : `未取得状态${lastError ? `：${lastError.message}` : ''}`;
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）；${detail}`);
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const state = await measure();
      if (state.ready) return state;
    } catch {
      // 页面还没加载完，继续等
    }
    await sleep(POLL_MS);
  }
  throw new Error(`等待 #app[data-ready=true] 超时（${READY_TIMEOUT_MS}ms）`);
}

async function screenshot(file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15_000);
  assert(typeof data === 'string' && data.length > 0, 'CDP 截图返回为空');
  writeFileSync(file, Buffer.from(data, 'base64'));
  const size = pngSize(file);
  assert(size.width > 0 && size.height > 0, `截图尺寸异常：${size.width}x${size.height}`);
  return { ...size, bytes: statSync(file).size };
}

async function clickPill(state) {
  const rect = state.pillRect;
  assert(rect, '胶囊不存在，无法点击');
  assert(rect.width > 0 && rect.height > 0, `胶囊尺寸为 0：${describe(rect)}`);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  return { x, y };
}

function isCollapsed(state) {
  return state.collapsed === true
    && state.width <= COLLAPSED_MAX.width
    && state.height <= COLLAPSED_MAX.height;
}

function isExpanded(state) {
  return state.collapsed === false
    && state.width >= EXPANDED_MIN.width
    && state.height >= EXPANDED_MIN.height;
}

function assertPanelUsable(state) {
  assert(state.panelVisible, `#panel 未显示：${describe(state)}`);
  const rect = state.panelRect || { width: 0, height: 0 };
  assert(
    rect.width >= PANEL_MIN.width && rect.height >= PANEL_MIN.height,
    `#panel 尺寸过小（${Math.round(rect.width)}x${Math.round(rect.height)}，要求 ≥${PANEL_MIN.width}x${PANEL_MIN.height}）`,
  );
}

const COLLAPSE_TRUE = "window.aqs ? window.aqs.collapse(true).then(() => true) : false";

async function expandViaBridge() {
  await evaluate(COLLAPSE_TRUE);
  await pollUntil('折叠（aqs.collapse(true)）', isCollapsed);
  await evaluate("window.aqs ? window.aqs.showOverlay().then(() => true) : false");
  return pollUntil('展开（aqs.showOverlay()）', isExpanded);
}

function processFailureHint() {
  const lines = [];
  if (logTail.stdout.trim()) lines.push(`stdout 尾部：\n${logTail.stdout.slice(-1500)}`);
  if (logTail.stderr.trim()) lines.push(`stderr 尾部：\n${logTail.stderr.slice(-1500)}`);
  return lines.join('\n');
}

/* ---------------------------------------------------------------- main -- */

async function run() {
  stage = '写入初始折叠设置';
  writeFileSync(
    settingsFile,
    `${JSON.stringify(
      {
        ai: { apiKey: '' },
        overlay: { width: 320, height: 420, collapsed: true },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  stage = '启动 electron';
  const port = await freePort();
  child = spawn(
    electronBinary,
    [
      rootDir,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--remote-allow-origins=*',
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        AQS_SETTINGS: settingsFile,
        AI_DEMO: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    },
  );
  child.on('error', (error) => {
    spawnError = error;
    logTail.stderr += `spawn error: ${error.message}\n`;
  });
  child.stdout.on('data', (chunk) => {
    logTail.stdout = `${logTail.stdout}${chunk.toString()}`.slice(-8000);
  });
  child.stderr.on('data', (chunk) => {
    logTail.stderr = `${logTail.stderr}${chunk.toString()}`.slice(-8000);
  });

  stage = '连接 DevTools';
  const target = await waitForTarget(port, Date.now() + READY_TIMEOUT_MS);
  cdp = new DevToolsSocket(target.webSocketDebuggerUrl);
  await cdp.connect(10_000);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable').catch(() => {});

  stage = '等待页面就绪';
  await waitForReady();

  stage = '断言折叠态';
  const collapsed = await pollUntil('折叠态窗口尺寸', isCollapsed, SETTLE_TIMEOUT_MS);
  assert(
    collapsed.width <= COLLAPSED_MAX.width && collapsed.height <= COLLAPSED_MAX.height,
    `折叠后窗口过大：${collapsed.width}x${collapsed.height}（上限 ${COLLAPSED_MAX.width}x${COLLAPSED_MAX.height}）`,
  );
  assert(collapsed.pillVisible, `折叠后胶囊未显示：${describe(collapsed)}`);
  assert(
    collapsed.pillText.includes('展开'),
    `胶囊文本缺少「展开」提示：${describe(collapsed.pillText)}（aria-label=${describe(collapsed.pillLabel)}）`,
  );
  const shotCollapsed = await screenshot(shotFile);

  stage = '点击胶囊展开';
  await clickPill(collapsed);
  const firstExpand = await pollUntil('点击胶囊后展开', isExpanded);
  assertPanelUsable(firstExpand);
  const shotMouse = await screenshot(shotExpanded);

  stage = 'showOverlay 展开路径';
  const bridgeExpand = await expandViaBridge();
  assertPanelUsable(bridgeExpand);

  stage = '折叠/展开循环';
  const sizes = [{ width: firstExpand.width, height: firstExpand.height }];
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    await evaluate(COLLAPSE_TRUE);
    await pollUntil(`第 ${cycle} 次折叠`, isCollapsed);
    const pillState = await measure();
    await clickPill(pillState);
    const expanded = await pollUntil(`第 ${cycle} 次点击展开`, isExpanded);
    assertPanelUsable(expanded);
    sizes.push({ width: expanded.width, height: expanded.height });
  }
  const widths = sizes.map((size) => size.width);
  const heights = sizes.map((size) => size.height);
  const widthSpread = Math.max(...widths) - Math.min(...widths);
  const heightSpread = Math.max(...heights) - Math.min(...heights);
  assert(
    widthSpread <= 4 && heightSpread <= 4,
    `多次展开尺寸不稳定：宽 ${widths.join('/')}（跨度 ${widthSpread}），高 ${heights.join('/')}（跨度 ${heightSpread}）`,
  );

  stage = '校验持久化设置';
  const finalState = await measure();
  const expected = {
    width: Math.round(finalState.width),
    height: Math.round(finalState.height),
  };
  const settingsDeadline = Date.now() + SETTLE_TIMEOUT_MS;
  let saved = readSettings();
  while (Date.now() < settingsDeadline) {
    const overlay = saved?.overlay || {};
    if (
      overlay.collapsed === false
      && Number(overlay.width) >= EXPANDED_MIN.width
      && Number(overlay.height) >= EXPANDED_MIN.height
      && Math.abs(Number(overlay.width) - expected.width) <= PERSIST_TOLERANCE
      && Math.abs(Number(overlay.height) - expected.height) <= PERSIST_TOLERANCE
    ) {
      break;
    }
    await sleep(POLL_MS);
    saved = readSettings();
  }
  const overlay = saved?.overlay || {};
  assert(saved, `设置文件缺失或无法解析：${settingsFile}`);
  assert(overlay.collapsed === false, `设置未记录展开状态：collapsed=${describe(overlay.collapsed)}`);
  assert(
    Number(overlay.width) >= EXPANDED_MIN.width,
    `持久化宽度过小：width=${describe(overlay.width)}（要求 ≥${EXPANDED_MIN.width}）`,
  );
  assert(
    Number(overlay.height) >= EXPANDED_MIN.height,
    `持久化高度过小：height=${describe(overlay.height)}（要求 ≥${EXPANDED_MIN.height}）`,
  );
  assert(
    Math.abs(Number(overlay.width) - expected.width) <= PERSIST_TOLERANCE,
    `持久化宽度与窗口不一致：settings.width=${describe(overlay.width)}，window.outerWidth=${expected.width}（容差 ${PERSIST_TOLERANCE}）`,
  );
  assert(
    Math.abs(Number(overlay.height) - expected.height) <= PERSIST_TOLERANCE,
    `持久化高度与窗口不一致：settings.height=${describe(overlay.height)}，window.outerHeight=${expected.height}（容差 ${PERSIST_TOLERANCE}）`,
  );

  console.log(
    `COLLAPSE READY collapsed=${collapsed.width}x${collapsed.height} pill=${describe(collapsed.pillText)} ` +
      `expanded=${expected.width}x${expected.height} cycles=${CYCLES} ` +
      `saved=${overlay.width}x${overlay.height} ` +
      `shot=${shotCollapsed.width}x${shotCollapsed.height}/${shotCollapsed.bytes}B ` +
      `+${shotMouse.width}x${shotMouse.height}/${shotMouse.bytes}B`,
  );
  console.log('COLLAPSE SMOKE OK');
}

function waitForExit(target, timeoutMs) {
  if (!target || target.exitCode !== null || target.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    target.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function cleanup() {
  try {
    cdp?.close();
  } catch {
    // 忽略
  }
  killTree(child);
  await waitForExit(child, 3_000);
  // Windows 会短暂占用 user-data-dir（profile 锁），删除需要重试。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch {
      await sleep(200);
    }
  }
  console.warn(`COLLAPSE WARN 临时目录未能删除（可手动清理）：${tmpRoot}`);
}

function reportFailure(error) {
  const lines = [`${FAIL_PREFIX}${stage}：${error?.message ?? error}`];
  lines.push(`可执行文件：${electronBinary}`);
  lines.push(`临时目录：${tmpRoot}`);
  const settings = readSettings();
  if (settings) lines.push(`设置快照：overlay=${describe(settings.overlay)}`);
  const hint = processFailureHint();
  if (hint) lines.push(hint);
  console.error(lines.join('\n'));
}

try {
  await run();
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
