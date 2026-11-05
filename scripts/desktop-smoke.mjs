#!/usr/bin/env node
// Desktop smoke test: boots the Electron overlay in demo mode with a throwaway
// settings file, waits for the SMOKE_READY line and the overlay screenshot, then
// asserts the window is docked to the left edge of the display work area.
//
// Usage: node scripts/desktop-smoke.mjs
// Exits 0 and prints "DESKTOP SMOKE OK" on success, non-zero with diagnostics otherwise.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const SMOKE_TIMEOUT_MS = Number(process.env.AQS_SMOKE_TIMEOUT_MS) || 45_000;
const KILL_DEADLINE_MS = SMOKE_TIMEOUT_MS + 15_000;
const SHOT_MIN_BYTES = 5 * 1024;
const SHOT_WAIT_MS = 8_000;

function fail(message, detail) {
  const lines = [`SMOKE FAIL ${message}`];
  if (detail) lines.push(detail);
  console.error(lines.join('\n'));
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!head.subarray(0, 8).equals(signature)) throw new Error(`${file} 不是 PNG 文件`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

async function waitForFile(file, minBytes, deadline) {
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const { size } = statSync(file);
      if (size >= minBytes) return size;
    }
    await sleep(100);
  }
  return 0;
}

function killTree(child) {
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
  spawnSync('sh', ['-c', `sleep 1; kill -9 ${child.pid} 2>/dev/null || true`], { stdio: 'ignore' });
}

function workAreaLeft(display) {
  if (!display || typeof display !== 'object') return null;
  const workArea = display.workArea || display.workarea;
  if (workArea && Number.isFinite(workArea.x)) return workArea.x;
  const bounds = display.bounds;
  if (bounds && Number.isFinite(bounds.x)) return bounds.x;
  if (Number.isFinite(display.x)) return display.x;
  return null;
}

function describe(value) {
  return JSON.stringify(value);
}

async function main() {
  const electronBinary = resolveElectronBinary();
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'aqs-smoke-'));
  const settingsFile = path.join(tmpRoot, 'settings.json');
  const shotFile = path.join(tmpRoot, 'overlay.png');

  const child = spawn(electronBinary, [rootDir, '--smoke'], {
    cwd: rootDir,
    env: {
      ...process.env,
      AQS_SETTINGS: settingsFile,
      AQS_SMOKE_SHOT: shotFile,
      AQS_SMOKE_TIMEOUT_MS: String(SMOKE_TIMEOUT_MS),
      AI_DEMO: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  let stdout = '';
  let stderr = '';
  let ready = null;
  let smokeFail = null;
  let settled = false;
  const deadline = Date.now() + KILL_DEADLINE_MS;

  const screens = [];
  let pending = '';
  const handleLine = (raw) => {
    const text = raw.trim();
    if (text.startsWith('SMOKE_READY')) {
      const payload = text.slice('SMOKE_READY'.length).trim();
      try {
        ready = JSON.parse(payload);
      } catch (error) {
        smokeFail = `SMOKE_READY 不是合法 JSON：${payload.slice(0, 200)} (${error.message})`;
      }
    } else if (text.startsWith('SMOKE_FAIL')) {
      smokeFail = text;
    }
  };
  const onStdout = (chunk) => {
    const text = chunk.toString();
    stdout += text;
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    settled = true;
    screens.push(`启动失败：${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (pending.trim()) {
      handleLine(pending);
      pending = '';
    }
    settled = true;
    screens.push(`electron 进程退出，code=${code} signal=${signal}`);
  });

  try {
    while (!ready && !smokeFail && !settled && Date.now() < deadline) {
      await sleep(100);
    }

    if (smokeFail) throw new Error(smokeFail);
    if (!ready) {
      throw new Error(screens[0] || `等待 SMOKE_READY 超时（${KILL_DEADLINE_MS}ms）`);
    }

    const bounds = ready.bounds || {};
    const display = ready.display || null;
    const left = workAreaLeft(display);

    assert(Number.isFinite(left), `SMOKE_READY.display 缺少 workArea/bounds 坐标：${describe(display)}`);
    assert(
      Number.isFinite(bounds.x) && Math.abs(bounds.x - left) <= 24,
      `窗口未停靠左边缘：x=${describe(bounds.x)}，显示器左边缘=${left}（容差 24px）`,
    );
    assert(Number.isFinite(bounds.width) && bounds.width >= 320, `窗口宽度不足：width=${describe(bounds.width)}（要求 ≥320）`);
    assert(Number.isFinite(bounds.height) && bounds.height > 400, `窗口高度不足：height=${describe(bounds.height)}（要求 >400）`);
    assert(ready.mode === 'demo', `模式应为 demo，实际为 ${describe(ready.mode)}`);
    if (!ready.version || !ready.platform) {
      throw new Error(`SMOKE_READY 缺少 version/platform：${describe(ready)}`);
    }

    const shotBytes = await waitForFile(shotFile, SHOT_MIN_BYTES, Date.now() + SHOT_WAIT_MS);
    assert(
      shotBytes >= SHOT_MIN_BYTES,
      `截图缺失或过小：${shotFile}（${shotBytes} 字节，要求 >5KB）`,
    );
    const shot = pngSize(shotFile);
    assert(shot.width >= 320 && shot.height > 400, `截图尺寸异常：${shot.width}x${shot.height}`);

    console.log(
      `SMOKE READY app=${ready.version} platform=${ready.platform} mode=${ready.mode} ` +
        `bounds=${bounds.width}x${bounds.height}@${bounds.x},${bounds.y} displayLeft=${left} ` +
        `shot=${shot.width}x${shot.height}/${shotBytes}B`,
    );
    console.log('DESKTOP SMOKE OK');
  } catch (error) {
    fail(error.message, [
      `可执行文件：${electronBinary}`,
      `临时目录：${tmpRoot}`,
      screens.length ? `进程状态：${screens.join(' | ')}` : '',
      `stdout 尾部：\n${stdout.slice(-2000) || '<空>'}`,
      `stderr 尾部：\n${stderr.slice(-2000) || '<空>'}`,
    ].filter(Boolean).join('\n'));
  } finally {
    killTree(child);
    await sleep(300);
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响结果
    }
  }
}

await main();
