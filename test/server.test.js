import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadConfig } from '../server/config.js';
import { createServer } from '../server/index.js';
import { closeServer, listenEphemeral, makeRoot } from './helpers/root.js';
import {
  completionBody,
  delay,
  sendJson,
  sendSseFragments,
  sseBody,
  startStub,
} from './helpers/openai-stub.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const RECOGNIZED = {
  question: '已知函数 f(x)=x^2-4x+3，求 f(x) 的最小值。',
  options: [
    { label: 'A', text: '-1' },
    { label: 'B', text: '0' },
    { label: 'C', text: '1' },
    { label: 'D', text: '3' },
  ],
  subject: '数学',
  questionType: 'choice',
  confidence: 0.98,
};
const ANSWER_DELTAS = ['【答案】A（-1）\n\n', '【解析】f(x)=(x-2)²-1，', '最小值 -1。\n'];

/** Stub that answers like an OpenAI-compatible endpoint for both tasks. */
async function chatStub(t) {
  const stub = await startStub(async (req, res, entry) => {
    if (!String(entry.url).endsWith('/chat/completions')) {
      sendJson(res, 404, { error: { message: 'unknown path' } });
      return;
    }
    const body = entry.json ?? {};
    const system = String(body.messages?.[0]?.content ?? '');
    if (system.startsWith('[TASK:RECOGNIZE]')) {
      sendJson(res, 200, completionBody(JSON.stringify(RECOGNIZED)));
      return;
    }
    if (body.stream === true) {
      await sendSseFragments(res, sseBody(ANSWER_DELTAS, { total_tokens: 12 }));
      return;
    }
    sendJson(res, 200, completionBody(ANSWER_DELTAS.join('')));
  });
  t.after(() => stub.close());
  return stub;
}

function liveConfig(t, stub, tweak = () => {}) {
  const config = loadConfig(
    {
      AI_API_KEY: 'test-key',
      AI_BASE_URL: stub.baseUrl,
      AI_MODEL: 'stub-model',
      AI_TIMEOUT_MS: '3000',
    },
    makeRoot(t),
  );
  config.host = '127.0.0.1';
  config.port = 0;
  tweak(config);
  return config;
}

async function boot(t, config) {
  const server = createServer(config);
  const url = await listenEphemeral(server);
  t.after(() => closeServer(server));
  return { server, url };
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

async function postJson(url, path, payload, headers = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('health, config and static assets are served', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, liveConfig(t, stub));

  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.mode, 'live');
  assert.equal(healthBody.models.chat, 'stub-model');
  assert.equal(typeof healthBody.models.visionModel, 'string');
  assert.equal(healthBody.limits.maxImageBytes, 8 * 1024 * 1024);
  assert.equal(healthBody.limits.maxQuestionChars, 8000);
  assert.equal(healthBody.version, PACKAGE.version);

  const configResponse = await fetch(`${url}/api/config`);
  assert.equal(configResponse.status, 200);
  const configBody = await configResponse.json();
  assert.equal(configBody.mode, 'live');
  assert.equal(configBody.models.chat, 'stub-model');
  assert.equal(configBody.limits.maxOptions, 10);
  assert.deepEqual(configBody.styles, ['concise', 'detailed', 'step']);

  const index = await fetch(`${url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  assert.match(index.headers.get('cache-control') ?? '', /no-store/);
  const html = await index.text();
  assert.match(html, /<html/i);
  assert.match(html, /app\.js/);

  const spa = await fetch(`${url}/some/spa/route`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('content-type') ?? '', /text\/html/);

  assert.equal(stub.requests.length, 0, 'no upstream calls for static/health/config');
});

test('recognize validates input and returns the parsed question', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, liveConfig(t, stub, (config) => {
    config.limits.maxImageBytes = 128;
  }));

  const missing = await postJson(url, '/api/recognize', {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'BAD_REQUEST');

  const malformed = await postJson(url, '/api/recognize', '{ not json');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'BAD_REQUEST');

  const wrongMime = await postJson(url, '/api/recognize', {
    imageDataUrl: 'data:image/bmp;base64,QUJD',
  });
  assert.equal(wrongMime.status, 415);
  assert.equal((await wrongMime.json()).error.code, 'UNSUPPORTED');

  const tooLarge = await postJson(url, '/api/recognize', {
    imageDataUrl: `data:image/png;base64,${Buffer.alloc(200, 7).toString('base64')}`,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, 'PAYLOAD_TOO_LARGE');

  const ok = await postJson(url, '/api/recognize', { imageDataUrl: PNG_DATA_URL });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.question, RECOGNIZED.question);
  assert.deepEqual(body.options, RECOGNIZED.options);
  assert.equal(body.subject, '数学');
  assert.equal(body.questionType, 'choice');
  assert.equal(body.confidence, 0.98);
  assert.equal(body.model, 'stub-model');
  assert.equal(body.mode, 'live');
  assert.match(String(stub.requests.at(-1).json.messages[0].content), /^\[TASK:RECOGNIZE\]/);
});

test('answer streams meta → delta+ → done and caches the full answer', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, liveConfig(t, stub));
  const payload = { question: '已知函数 f(x)=x^2-4x+3，求最小值。', style: 'concise' };

  const response = await postJson(url, '/api/answer', payload);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(response.headers.get('cache-control') ?? '', /no-cache/);
  assert.match(response.headers.get('cache-control') ?? '', /no-transform/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');

  const events = parseSse(await response.text());
  const names = events.map((event) => event.event);
  assert.equal(names[0], 'meta');
  assert.equal(names.at(-1), 'done');
  assert.ok(names.filter((name) => name === 'delta').length >= 1, 'at least one delta');
  assert.ok(names.slice(1, -1).every((name) => name === 'delta'), 'deltas only between meta and done');

  const meta = JSON.parse(events[0].data);
  assert.equal(meta.mode, 'live');
  assert.equal(meta.model, 'stub-model');
  assert.equal(meta.cached, false);
  assert.equal(meta.question, payload.question);
  assert.equal(meta.style, 'concise');

  const answer = events
    .filter((event) => event.event === 'delta')
    .map((event) => JSON.parse(event.data).text)
    .join('');
  assert.ok(answer.includes('【答案】A'), 'streamed answer text is complete');

  const done = JSON.parse(events.at(-1).data);
  assert.equal(typeof done.durationMs, 'number');
  assert.ok(done.usage === null || typeof done.usage === 'object');

  const cached = parseSse(await (await postJson(url, '/api/answer', payload)).text());
  assert.equal(JSON.parse(cached[0].data).cached, true, 'second identical request hits the cache');
  const cachedAnswer = cached
    .filter((event) => event.event === 'delta')
    .map((event) => JSON.parse(event.data).text)
    .join('');
  assert.equal(cachedAnswer, answer);
});

test('answer supports JSON aggregation and rejects empty questions', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, liveConfig(t, stub));

  const response = await postJson(
    url,
    '/api/answer',
    { question: '解释牛顿第一定律。', style: 'detailed' },
    { accept: 'application/json' },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.answer, 'string');
  assert.ok(body.answer.includes('【答案】'));
  assert.equal(body.mode, 'live');
  assert.equal(body.model, 'stub-model');
  assert.equal(typeof body.cached, 'boolean');
  assert.equal(typeof body.durationMs, 'number');

  const empty = await postJson(url, '/api/answer', { question: '   ' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'BAD_REQUEST');

  const fallback = await postJson(url, '/api/answer', '{');
  assert.equal(fallback.status, 400);
});

test('oversized request bodies are rejected with 413', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, liveConfig(t, stub, (config) => {
    config.limits.maxBodyBytes = 128;
  }));

  const response = await postJson(url, '/api/answer', { question: 'x'.repeat(4096) });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('a burst of API calls is rate limited with Retry-After', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, liveConfig(t, stub, (config) => {
    config.limits.ratePerMinute = 2;
  }));

  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const limited = await fetch(`${url}/api/health`);
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.ok(limited.headers.get('retry-after'), 'Retry-After header present');
});

test('client disconnect mid-stream does not break the server', async (t) => {
  const stub = await startStub(async (req, res, entry) => {
    if (!String(entry.url).endsWith('/chat/completions')) {
      sendJson(res, 404, { error: { message: 'unknown path' } });
      return;
    }
    // Keep the upstream stream open long enough for the client to abort.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const text of ANSWER_DELTAS) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
      await delay(100);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  t.after(() => stub.close());
  const { url } = await boot(t, liveConfig(t, stub));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  t.after(() => clearTimeout(timer));
  await assert.rejects((async () => {
    const response = await fetch(`${url}/api/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '中断测试题目' }),
      signal: controller.signal,
    });
    await response.text();
  })());

  await delay(150);
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
});

/** Three candidate slots plus a judge, all on the shared stub (distinct models). */
function ensembleConfig(t, stub) {
  const config = liveConfig(t, stub);
  config.ai.ensemble.enabled = true;
  config.ai.ensemble.candidates = [0, 1, 2].map((index) => ({
    name: `模型 ${'ABC'[index]}`,
    baseUrl: stub.baseUrl,
    apiKey: `key-${'abc'[index]}`,
    model: `model-${'abc'[index]}`,
    temperature: [0.3, 0.6, 0.9][index],
  }));
  config.ai.ensemble.judge = {
    name: '评审',
    baseUrl: stub.baseUrl,
    apiKey: 'judge-key',
    model: 'judge-model',
    temperature: 0.1,
  };
  return config;
}

test('ensemble answers emit candidate events between meta and delta', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, ensembleConfig(t, stub));

  const response = await postJson(url, '/api/answer', {
    question: '交叉验证 SSE 题目',
    ensemble: true,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const events = parseSse(await response.text());
  const names = events.map((event) => event.event);
  const metaIndex = names.indexOf('meta');
  const firstCandidate = names.indexOf('candidate');
  const firstDelta = names.indexOf('delta');
  assert.equal(metaIndex, 0);
  assert.ok(firstCandidate > 0, 'candidate events are emitted');
  assert.ok(firstDelta > firstCandidate, 'candidate events precede the judge deltas');
  assert.equal(names.at(-1), 'done');

  const meta = JSON.parse(events[0].data);
  assert.equal(meta.ensemble, true);
  assert.equal(meta.model, 'judge-model', 'meta model is the judge model');
  assert.deepEqual(meta.judge, { name: '评审', model: 'judge-model', status: 'running' });
  assert.deepEqual(
    meta.candidates.map((candidate) => candidate.model),
    ['model-a', 'model-b', 'model-c'],
  );

  const candidates = events
    .filter((event) => event.event === 'candidate')
    .map((event) => JSON.parse(event.data));
  assert.equal(candidates.filter((candidate) => candidate.status === 'running').length, 3);
  const settled = candidates.filter((candidate) => candidate.status === 'done');
  assert.equal(settled.length, 3);
  for (const candidate of settled) {
    assert.equal(typeof candidate.text, 'string');
    assert.ok(candidate.text.includes('【答案】A'));
    assert.equal(typeof candidate.durationMs, 'number');
  }

  const done = JSON.parse(events.at(-1).data);
  assert.equal(done.ensemble, true);
  assert.equal(done.fallback, false);
  assert.equal(done.judge.status, 'done');
  assert.equal(done.judge.model, 'judge-model');
  assert.equal(done.candidates.length, 3);
  assert.ok(done.text.includes('【答案】A'));

  // Three parallel candidate calls plus one streaming judge call.
  assert.equal(stub.requests.length, 4);
  const judgeRequest = stub.requests.find((entry) =>
    String(entry.json?.messages?.[0]?.content ?? '').startsWith('[TASK:JUDGE]'),
  );
  assert.ok(judgeRequest, 'the judge prompt uses the [TASK:JUDGE] marker');
  const judgePrompt = String(judgeRequest.json.messages.at(-1).content);
  for (const model of ['model-a', 'model-b', 'model-c']) {
    assert.ok(judgePrompt.includes(model), `judge prompt names ${model}`);
  }
  assert.equal(judgeRequest.headers.authorization, 'Bearer judge-key');

  // JSON aggregation folds the same candidate/judge snapshots into one payload.
  const aggregated = await postJson(
    url,
    '/api/answer',
    { question: '交叉验证 JSON 题目', ensemble: true },
    { accept: 'application/json' },
  );
  assert.equal(aggregated.status, 200);
  const body = await aggregated.json();
  assert.equal(body.ensemble, true);
  assert.equal(body.fallback, false);
  assert.equal(body.answer, ANSWER_DELTAS.join(''));
  assert.equal(body.judge.status, 'done');
  assert.equal(body.judge.model, 'judge-model');
  assert.equal(body.candidates.length, 3);
  assert.deepEqual(
    body.candidates.map((candidate) => [candidate.index, candidate.status]),
    [
      [0, 'done'],
      [1, 'done'],
      [2, 'done'],
    ],
  );
  for (const candidate of body.candidates) assert.ok(candidate.text.includes('【答案】A'));
});

test('ensemble:false keeps the plain meta → delta → done stream', async (t) => {
  const stub = await chatStub(t);
  const { url } = await boot(t, ensembleConfig(t, stub));

  const response = await postJson(url, '/api/answer', {
    question: '关闭交叉验证的题目',
    ensemble: false,
  });
  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  const names = events.map((event) => event.event);
  assert.equal(names[0], 'meta');
  assert.equal(names.at(-1), 'done');
  assert.ok(names.slice(1, -1).every((name) => name === 'delta'), 'deltas only in between');
  assert.ok(!names.includes('candidate'), 'no candidate events when ensemble is off');

  const meta = JSON.parse(events[0].data);
  assert.equal(meta.ensemble, false);
  assert.equal(meta.model, 'stub-model');
  assert.deepEqual(meta.candidates, []);
  assert.equal(meta.judge, null);

  const done = JSON.parse(events.at(-1).data);
  assert.equal(done.ensemble, false);
  assert.deepEqual(done.candidates, []);
  assert.equal(done.judge, null);
  assert.equal(done.fallback, false);

  assert.equal(stub.requests.length, 1, 'exactly one upstream answer call');
  assert.equal(stub.requests[0].json.stream, true);
});

test('/api/config describes the ensemble without leaking key material', async (t) => {
  const stub = await chatStub(t);
  const config = ensembleConfig(t, stub);
  config.ai.apiKey = 'sk-global-secret';
  config.ai.ensemble.candidates[0].apiKey = 'sk-candidate-secret';
  config.ai.ensemble.judge.apiKey = 'sk-judge-secret';
  const { url } = await boot(t, config);

  const response = await fetch(`${url}/api/config`);
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(!raw.includes('sk-'), 'no key material in /api/config');
  assert.ok(!raw.includes('apiKey'), '/api/config never exposes apiKey fields');

  const body = JSON.parse(raw);
  assert.equal(body.ensemble.enabled, true);
  assert.equal(body.ensemble.available, true);
  assert.equal(body.ensemble.candidates.length, 3);
  assert.deepEqual(
    body.ensemble.candidates.map((candidate) => [candidate.name, candidate.model, candidate.hasKey]),
    [
      ['模型 A', 'model-a', true],
      ['模型 B', 'model-b', true],
      ['模型 C', 'model-c', true],
    ],
  );
  assert.deepEqual(body.ensemble.judge, { name: '评审', model: 'judge-model', hasKey: true });
  for (const candidate of body.ensemble.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['hasKey', 'model', 'name']);
  }
  assert.equal(stub.requests.length, 0, 'reading the config hits no upstream endpoint');
});
