#!/usr/bin/env node
// End-to-end smoke test: boots the real server in demo mode on a free port.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = fileURLToPath(new URL('../server/index.js', import.meta.url));
const fixture = readFileSync(new URL('../fixtures/sample-question.png', import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const event = { event: 'message', data: '' };
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event.event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
      }
      event.data = dataLines.join('\n');
      return event;
    });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), sleep(1000)]);
  }
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = '';

  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      AI_DEMO: '1',
      AI_API_KEY: '',
      // Unreachable on purpose: demo mode must never need the network.
      AI_BASE_URL: 'http://127.0.0.1:9/v1',
      AI_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    logs += chunk.toString();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    const deadline = Date.now() + 20_000;
    let health;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server exited before becoming healthy (code=${child.exitCode})\n${logs}`);
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    assert(health, `server did not answer /api/health in time\n${logs}`);
    assert(health.ok === true, 'health.ok must be true');
    assert(health.mode === 'demo', `expected demo mode, got ${health.mode}`);

    const index = await fetch(`${baseUrl}/`);
    assert(index.status === 200, `GET / returned ${index.status}`);
    assert(/text\/html/.test(index.headers.get('content-type') ?? ''), 'GET / must serve html');
    const html = await index.text();
    assert(/<html/i.test(html), 'index html missing markup');
    assert(/app\.js/.test(html), 'index html must load app.js');

    const configResponse = await fetch(`${baseUrl}/api/config`);
    assert(configResponse.status === 200, `GET /api/config returned ${configResponse.status}`);
    const config = await configResponse.json();
    assert(config.mode === 'demo', 'config.mode must be demo');
    assert(Array.isArray(config.styles) && config.styles.includes('step'), 'config.styles missing');

    const imageDataUrl = `data:image/png;base64,${fixture.toString('base64')}`;
    const recognizeResponse = await fetch(`${baseUrl}/api/recognize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    });
    assert(recognizeResponse.status === 200, `POST /api/recognize returned ${recognizeResponse.status}`);
    const recognized = await recognizeResponse.json();
    assert(typeof recognized.question === 'string' && recognized.question.length > 0, 'recognized question missing');
    assert(/[\u4e00-\u9fa5]/.test(recognized.question), 'recognized question must contain Chinese text');
    assert(Array.isArray(recognized.options) && recognized.options.length === 4, 'expected four options');
    assert(recognized.mode === 'demo', 'recognize mode must be demo');

    const answerResponse = await fetch(`${baseUrl}/api/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: recognized.question,
        options: recognized.options,
        subject: recognized.subject,
        style: 'concise',
      }),
    });
    assert(answerResponse.status === 200, `POST /api/answer returned ${answerResponse.status}`);
    assert(
      /text\/event-stream/.test(answerResponse.headers.get('content-type') ?? ''),
      'answer must stream text/event-stream',
    );

    const events = parseSse(await answerResponse.text());
    const names = events.map((event) => event.event);
    assert(names[0] === 'meta', `first SSE event must be meta, got ${names[0]}`);
    assert(names.at(-1) === 'done', `last SSE event must be done, got ${names.at(-1)}`);
    assert(names.filter((name) => name === 'delta').length >= 2, 'answer must arrive in multiple deltas');

    const answer = events
      .filter((event) => event.event === 'delta')
      .map((event) => JSON.parse(event.data).text)
      .join('');
    assert(answer.includes('【答案】'), 'answer must follow the 【答案】 format');
    assert(answer.includes('【解析】'), 'answer must follow the 【解析】 format');
    assert(/[\u4e00-\u9fa5]/.test(answer), 'answer must contain Chinese text');
    assert(answer.includes('演示模式'), 'demo answer must be labelled as demo');

    console.log('SMOKE OK');
  } catch (error) {
    console.error(`SMOKE FAILED: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await stopChild(child);
  }
}

await main();
