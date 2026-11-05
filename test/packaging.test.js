import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function pngDimensions(buffer, file) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buffer.subarray(0, 8).equals(signature), `${file} 必须是 PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function icoSizes(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, 'ICO reserved 字段必须为 0');
  assert.equal(buffer.readUInt16LE(2), 1, 'ICO type 必须为 1');
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer[offset] === 0 ? 256 : buffer[offset];
    const height = buffer[offset + 1] === 0 ? 256 : buffer[offset + 1];
    sizes.push({ width, height });
  }
  return sizes;
}

test('package.json keeps the HTTP scripts and adds the desktop ones', () => {
  assert.equal(pkg.main, 'electron/main.js');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);

  assert.equal(pkg.scripts.start, 'node server/index.js');
  assert.equal(pkg.scripts.dev, 'node --watch server/index.js');
  assert.equal(pkg.scripts.test, 'node --test "test/**/*.test.js"');
  assert.equal(pkg.scripts.smoke, 'node scripts/smoke.mjs');

  assert.equal(pkg.scripts.desktop, 'electron .');
  assert.equal(pkg.scripts['desktop:smoke'], 'node scripts/desktop-smoke.mjs');
  assert.equal(pkg.scripts['pack:win'], 'electron-builder --win nsis portable');
  assert.equal(pkg.scripts['pack:mac'], 'electron-builder --mac dmg zip');
});

test('runtime dependencies stay empty and devDependencies are Electron only', () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  const devDependencies = Object.keys(pkg.devDependencies ?? {}).sort();
  assert.ok(devDependencies.includes('electron'), 'devDependencies 必须包含 electron');
  assert.ok(devDependencies.includes('electron-builder'), 'devDependencies 必须包含 electron-builder');
  assert.deepEqual(devDependencies, ['electron', 'electron-builder']);
});

test('packaged files whitelist is the contract set', () => {
  const files = pkg.build?.files;
  assert.ok(Array.isArray(files), 'build.files 必须是数组');
  assert.deepEqual(files, [
    'electron/**/*',
    'server/**/*',
    'web/render.js',
    'package.json',
    'build/icon.png',
    'build/tray.png',
    'build/trayTemplate.png',
  ]);
  for (const entry of files) {
    assert.ok(!/^(test|fixtures|docs|dist|scripts)\//.test(entry), `${entry} 不应被打包`);
  }
  assert.deepEqual(pkg.build.directories, { output: 'dist', buildResources: 'build' });
});

test('builder targets cover Windows nsis+portable and macOS dmg+zip', () => {
  assert.equal(pkg.build.appId, 'app.aiquiz.overlay');
  assert.equal(pkg.build.productName, 'AI 答题助手');

  assert.deepEqual(pkg.build.win.target, ['nsis', 'portable']);
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.deepEqual(pkg.build.mac.target, ['dmg', 'zip']);
  assert.equal(pkg.build.mac.category, 'public.app-category.education');
  assert.equal(pkg.build.mac.icon, 'build/icon.png');
  assert.equal(
    pkg.build.mac.extendInfo.NSScreenCaptureUsageDescription,
    '需要屏幕录制权限以识别浏览器中的题目',
  );
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
});

test('packaging icons exist with plausible dimensions', () => {
  const iconPng = `${rootDir}build/icon.png`;
  const iconIco = `${rootDir}build/icon.ico`;
  const trayPng = `${rootDir}build/tray.png`;
  const trayTemplate = `${rootDir}build/trayTemplate.png`;
  for (const file of [iconPng, iconIco, trayPng, trayTemplate]) {
    assert.ok(existsSync(file), `缺少图标 ${file}`);
    assert.ok(statSync(file).size > 200, `${file} 过小`);
  }

  const appPng = pngDimensions(readFileSync(iconPng), 'build/icon.png');
  assert.equal(appPng.width, 1024);
  assert.equal(appPng.height, 1024);

  const ico = icoSizes(readFileSync(iconIco));
  const widths = ico.map((entry) => entry.width);
  assert.ok(widths.includes(16), 'icon.ico 必须包含 16x16');
  assert.ok(widths.includes(256), 'icon.ico 必须包含 256x256');
  assert.ok(Math.max(...widths) <= 256, 'icon.ico 尺寸不得超过 256');

  for (const [file, buffer] of [
    ['build/tray.png', readFileSync(trayPng)],
    ['build/trayTemplate.png', readFileSync(trayTemplate)],
  ]) {
    const size = pngDimensions(buffer, file);
    assert.equal(size.width, 32, `${file} 宽度应为 32`);
    assert.equal(size.height, 32, `${file} 高度应为 32`);
  }
});

test('electron version is resolvable from node_modules', () => {
  const electronPkgFile = `${rootDir}node_modules/electron/package.json`;
  assert.ok(existsSync(electronPkgFile), '未安装 electron（node_modules/electron/package.json 缺失）');
  const electronPkg = JSON.parse(readFileSync(electronPkgFile, 'utf8'));
  assert.match(electronPkg.version, /^\d+\.\d+\.\d+/, 'electron 版本号不可解析');
  assert.match(pkg.devDependencies.electron, /\d+\.\d+\.\d+/, 'package.json 未约束 electron 版本');
  assert.ok(
    existsSync(`${rootDir}node_modules/electron/path.txt`),
    'electron 二进制未下载完成（path.txt 缺失）',
  );
});

test('builder config is limited to the files it needs', () => {
  assert.ok(!JSON.stringify(pkg.build).includes('fixtures/'), 'build 配置不得引用 fixtures');
  assert.ok(!JSON.stringify(pkg.build).includes('"test/**/*"'), 'build 配置不得包含 test');
  assert.equal(pkg.build.nsis.perMachine, undefined, '不使用 perMachine 安装');
});
