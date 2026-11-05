import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../server/config.js';
import { EngineError, createEngine } from '../server/engine.js';
import { createServer } from '../server/index.js';
import { DEMO_ANSWER_TEXT, DEMO_RECOGNIZE_JSON } from '../server/mock.js';
import { closeServer, listenEphemeral, makeRoot } from './helpers/root.js';
import {
  completionBody,
  sendJson,
  sendSseFragments,
  sseBody,
  startStub,
} from './helpers/openai-stub.js';

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

const DEMO_RECOGNIZED = JSON.parse(DEMO_RECOGNIZE_JSON);

function demoConfig(t) {
  return loadConfig({ AI_DEMO: '1' }, makeRoot(t));
}

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
  tweak(config);
  return config;
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('engine exposes the transport-free contract surface', async (t) => {
  const config = demoConfig(t);
  const engine = createEngine(config);

  assert.equal(engine.config, config);
  assert.equal(engine.mode, 'demo');
  assert.deepEqual(engine.models, { chat: 'demo-chat', visionModel: 'demo-vision' });
  assert.equal(engine.provider.kind, 'demo');
  assert.equal(engine.limits.maxImageBytes, 8 * 1024 * 1024);
  assert.equal(engine.limits.maxQuestionChars, 8000);
  assert.equal(engine.limits.maxOptions, 10);
  assert.equal(typeof engine.validateImage, 'function');
  assert.equal(typeof engine.recognize, 'function');
  assert.equal(typeof engine.answerStream, 'function');
  assert.equal(typeof engine.answerComplete, 'function');
  assert.equal(typeof engine.clearCache, 'function');
});

test('validateImage and recognize reject bad images with EngineError codes', async (t) => {
  const config = demoConfig(t);
  config.limits.maxImageBytes = 128;
  const engine = createEngine(config);

  assert.throws(() => engine.validateImage(undefined), { name: 'EngineError', code: 'BAD_REQUEST' });
  assert.throws(() => engine.validateImage('data:image/bmp;base64,QUJD'), {
    name: 'EngineError',
    code: 'UNSUPPORTED',
  });
  assert.throws(() => engine.validateImage('data:image/png;base64,@@@'), {
    name: 'EngineError',
    code: 'BAD_REQUEST',
  });
  assert.throws(
    () => engine.validateImage(`data:image/png;base64,${Buffer.alloc(200, 7).toString('base64')}`),
    { name: 'EngineError', code: 'PAYLOAD_TOO_LARGE' },
  );
  assert.equal(engine.validateImage(PNG_DATA_URL), undefined);

  await assert.rejects(engine.recognize({}), { name: 'EngineError', code: 'BAD_REQUEST' });
  await assert.rejects(engine.recognize({ imageDataUrl: 'data:image/tiff;base64,QUJD' }), {
    name: 'EngineError',
    code: 'UNSUPPORTED',
  });
  await assert.rejects(
    engine.recognize({ imageDataUrl: `data:image/png;base64,${Buffer.alloc(200, 7).toString('base64')}` }),
    { name: 'EngineError', code: 'PAYLOAD_TOO_LARGE' },
  );

  const question = await engine.recognize({ imageDataUrl: PNG_DATA_URL });
  assert.equal(question.question, DEMO_RECOGNIZED.question);
  assert.deepEqual(question.options, DEMO_RECOGNIZED.options);
  assert.equal(question.subject, '数学');
  assert.equal(question.questionType, 'choice');
  assert.equal(question.confidence, 0.98);
  assert.equal(question.model, 'demo-vision');
});

test('answerStream emits meta → delta+ → usage → done for a plain question', async (t) => {
  const engine = createEngine(demoConfig(t));

  const events = await collect(engine.answerStream({ question: '求 f(x)=x^2-4x+3 的最小值。' }));
  const types = events.map((event) => event.type);
  assert.equal(types[0], 'meta');
  assert.equal(types.at(-1), 'done');
  assert.ok(types.includes('delta'), 'at least one delta');
  assert.ok(types.slice(1, -1).every((type) => type === 'delta' || type === 'usage'));

  const meta = events[0];
  assert.equal(meta.cached, false);
  assert.equal(meta.question, '求 f(x)=x^2-4x+3 的最小值。');
  assert.equal(meta.subject, '未知');
  assert.equal(meta.style, 'concise');
  assert.deepEqual(meta.options, []);

  const streamed = events
    .filter((event) => event.type === 'delta')
    .map((event) => event.text)
    .join('');
  const done = events.at(-1);
  assert.equal(streamed, DEMO_ANSWER_TEXT);
  assert.equal(done.text, DEMO_ANSWER_TEXT);
  assert.equal(done.cached, false);
  assert.equal(typeof done.durationMs, 'number');
  assert.equal(typeof done.usage, 'object');
});

test('answers are cached by question/options/style and replayed as one delta', async (t) => {
  const engine = createEngine(demoConfig(t));
  const question = '缓存测试：解释牛顿第一定律。';

  const first = await engine.answerComplete({ question });
  assert.equal(first.cached, false);
  assert.equal(first.text, DEMO_ANSWER_TEXT);

  const second = await engine.answerComplete({ question });
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);

  const replay = await collect(engine.answerStream({ question }));
  assert.deepEqual(
    replay.map((event) => event.type),
    ['meta', 'delta', 'done'],
  );
  assert.equal(replay[0].cached, true);
  assert.equal(replay[1].text, first.text);
  assert.equal(replay[2].cached, true);

  // Style is part of the key: a different style is a miss.
  const detailed = await engine.answerComplete({ question, style: 'detailed' });
  assert.equal(detailed.cached, false);

  // Options are part of the key too.
  const withOptions = await engine.answerComplete({
    question,
    options: [{ label: 'A', text: '物体保持静止或匀速直线运动' }],
  });
  assert.equal(withOptions.cached, false);

  // Defaults normalize the same way for the key.
  const shorthand = await engine.answerComplete({ question, style: '' });
  assert.equal(shorthand.cached, true);

  engine.clearCache();
  const afterClear = await engine.answerComplete({ question });
  assert.equal(afterClear.cached, false);
});

test('image-only answers recognize first and are never cached', async (t) => {
  const stub = await chatStub(t);
  const engine = createEngine(liveConfig(t, stub));

  const events = await collect(engine.answerStream({ imageDataUrl: PNG_DATA_URL }));
  const meta = events[0];
  assert.equal(meta.type, 'meta');
  assert.equal(meta.cached, false);
  assert.equal(meta.question, RECOGNIZED.question);
  assert.deepEqual(meta.options, RECOGNIZED.options);
  assert.equal(meta.subject, '数学');

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, ANSWER_DELTAS.join(''));

  assert.equal(stub.requests.length, 2, 'recognition then answer');
  assert.match(String(stub.requests[0].json.messages[0].content), /^\[TASK:RECOGNIZE\]/);
  assert.match(String(stub.requests[1].json.messages[0].content), /^\[TASK:ANSWER\]/);

  const again = await engine.answerComplete({ imageDataUrl: PNG_DATA_URL });
  assert.equal(again.cached, false, 'image-only answers bypass the cache');
  assert.equal(stub.requests.length, 4, 'recognition runs again instead of a cache hit');
});

test('a question supplied alongside an image skips recognition but stays cacheable', async (t) => {
  const stub = await chatStub(t);
  const engine = createEngine(liveConfig(t, stub));

  const first = await engine.answerComplete({ question: '带图片但已有题目', imageDataUrl: PNG_DATA_URL });
  assert.equal(first.cached, false);
  assert.equal(stub.requests.length, 1);
  assert.match(String(stub.requests[0].json.messages[0].content), /^\[TASK:ANSWER\]/);
  assert.ok(
    JSON.stringify(stub.requests[0].json.messages).includes('带图片但已有题目'),
    'the supplied question is what gets answered',
  );

  const second = await engine.answerComplete({ question: '带图片但已有题目', imageDataUrl: PNG_DATA_URL });
  assert.equal(second.cached, true);
  assert.equal(stub.requests.length, 1);
});

test('aborting mid-stream throws EngineError ABORTED and leaves the cache empty', async (t) => {
  const engine = createEngine(demoConfig(t));
  const controller = new AbortController();
  const iterator = engine.answerStream({ question: '中断测试题目' }, { signal: controller.signal })[
    Symbol.asyncIterator
  ]();

  let aborted = null;
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.type === 'delta') controller.abort();
    }
  } catch (error) {
    aborted = error;
  }

  assert.ok(aborted instanceof EngineError, 'abort surfaces as EngineError');
  assert.equal(aborted.code, 'ABORTED');
  assert.equal(aborted.message, '请求已取消');

  const afterAbort = await engine.answerComplete({ question: '中断测试题目' });
  assert.equal(afterAbort.cached, false, 'a cancelled answer is never cached');
  assert.equal(afterAbort.text, DEMO_ANSWER_TEXT);
});

test('an already-aborted signal rejects before producing any event', async (t) => {
  const engine = createEngine(demoConfig(t));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(engine.answerComplete({ question: '任意题目' }, { signal: controller.signal }), {
    name: 'EngineError',
    code: 'ABORTED',
  });
});

test('live provider aborts mid-stream are reported as ABORTED', async (t) => {
  const stub = await startStub(async (req, res, entry) => {
    const body = entry.json ?? {};
    const system = String(body.messages?.[0]?.content ?? '');
    if (system.startsWith('[TASK:RECOGNIZE]')) {
      sendJson(res, 200, completionBody(JSON.stringify(RECOGNIZED)));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '第一段' } }] })}\n\n`);
    // Keep the connection open so the caller has time to abort.
  });
  t.after(() => stub.close());
  const engine = createEngine(liveConfig(t, stub));

  const controller = new AbortController();
  const iterator = engine.answerStream({ question: '中断真实流' }, { signal: controller.signal })[
    Symbol.asyncIterator
  ]();

  let aborted = null;
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.type === 'delta') controller.abort();
    }
  } catch (error) {
    aborted = error;
  }

  assert.ok(aborted instanceof EngineError);
  assert.equal(aborted.code, 'ABORTED');
});

test('provider failures map to TIMEOUT / UPSTREAM_ERROR engine codes', async (t) => {
  const timeoutStub = await startStub(() => {
    // Never respond: the provider timeout has to fire.
  });
  t.after(() => timeoutStub.close());
  const timeoutEngine = createEngine(
    liveConfig(t, timeoutStub, (config) => {
      config.ai.timeoutMs = 120;
      config.ai.maxRetries = 0;
    }),
  );
  await assert.rejects(timeoutEngine.answerComplete({ question: '超时题目' }), (error) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.message, '模型响应超时，请稍后重试');
    return true;
  });

  const failingStub = await startStub((req, res) => {
    sendJson(res, 503, { error: { message: 'stub unavailable' } });
  });
  t.after(() => failingStub.close());
  const failingEngine = createEngine(
    liveConfig(t, failingStub, (config) => {
      config.ai.maxRetries = 0;
    }),
  );
  await assert.rejects(failingEngine.answerComplete({ question: '上游故障题目' }), (error) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.message, '模型服务暂时不可用，请稍后重试');
    return true;
  });

  const unparsableStub = await startStub((req, res, entry) => {
    const body = entry.json ?? {};
    if (String(body.messages?.[0]?.content ?? '').startsWith('[TASK:RECOGNIZE]')) {
      sendJson(res, 200, completionBody('抱歉，这张图片我看不清。'));
      return;
    }
    sendJson(res, 200, completionBody('无法作答'));
  });
  t.after(() => unparsableStub.close());
  const unparsableEngine = createEngine(liveConfig(t, unparsableStub));

  await assert.rejects(unparsableEngine.recognize({ imageDataUrl: PNG_DATA_URL }), (error) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.message, '未能从图片中识别出题目，请重试或手动输入');
    return true;
  });
});

test('invalid answer input raises BAD_REQUEST engine errors', async (t) => {
  const engine = createEngine(demoConfig(t));

  await assert.rejects(engine.answerComplete({ question: '   ' }), {
    name: 'EngineError',
    code: 'BAD_REQUEST',
  });
  await assert.rejects(engine.answerComplete({ question: 42 }), {
    name: 'EngineError',
    code: 'BAD_REQUEST',
  });
  await assert.rejects(engine.answerComplete({ question: '题目', options: 'A. 选项' }), {
    name: 'EngineError',
    code: 'BAD_REQUEST',
  });
  await assert.rejects(engine.answerComplete({ question: '题目', style: 'fancy' }), {
    name: 'EngineError',
    code: 'BAD_REQUEST',
  });
  await assert.rejects(engine.answerComplete({ question: '题目', imageDataUrl: 'data:image/bmp;base64,QUJD' }), {
    name: 'EngineError',
    code: 'UNSUPPORTED',
  });
});

test('limits truncate the question and cap option count before hitting the cache', async (t) => {
  const config = demoConfig(t);
  config.limits.maxQuestionChars = 10;
  config.limits.maxOptions = 2;
  const engine = createEngine(config);

  const events = await collect(
    engine.answerStream({
      question: '一二三四五六七八九十甲乙丙',
      options: [
        { label: 'A', text: '一' },
        { label: 'B', text: '二' },
        { label: 'C', text: '三' },
      ],
    }),
  );

  const meta = events[0];
  assert.equal(meta.question, '一二三四五六七八九十');
  assert.deepEqual(meta.options, [
    { label: 'A', text: '一' },
    { label: 'B', text: '二' },
  ]);

  const cached = await engine.answerComplete({ question: '一二三四五六七八九十', options: meta.options });
  assert.equal(cached.cached, true, 'truncation happens before the cache key');
});

test('the HTTP server still serves through the engine', async (t) => {
  const stub = await chatStub(t);
  const config = liveConfig(t, stub);
  config.host = '127.0.0.1';
  config.port = 0;

  const server = createServer(config);
  assert.equal(server.engine.mode, 'live');
  assert.equal(server.engine.models.chat, 'stub-model');

  const url = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'live');
  assert.deepEqual(health.models, { chat: 'stub-model', visionModel: 'stub-model' });

  const answer = await fetch(`${url}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ question: '引擎接入测试' }),
  });
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.answer, ANSWER_DELTAS.join(''));
  assert.equal(body.cached, false);

  const second = await fetch(`${url}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ question: '引擎接入测试' }),
  });
  assert.equal((await second.json()).cached, true, 'the HTTP layer shares the engine cache');
});

test('a separate vision endpoint recognizes while answers use the chat endpoint', async (t) => {
  const answerStub = await chatStub(t);

  const visionStub = await startStub(async (req, res) => {
    sendJson(res, 200, completionBody(JSON.stringify(RECOGNIZED)));
  });
  t.after(() => visionStub.close());

  const config = loadConfig(
    {
      AI_API_KEY: 'chat-key',
      AI_BASE_URL: answerStub.baseUrl,
      AI_MODEL: 'chat-model',
      AI_TIMEOUT_MS: '3000',
      AI_VISION_API_KEY: 'vision-key',
      AI_VISION_BASE_URL: visionStub.baseUrl,
      AI_VISION_MODEL: 'vision-model',
    },
    makeRoot(t),
  );
  const engine = createEngine(config);
  assert.deepEqual(engine.models, { chat: 'chat-model', visionModel: 'vision-model' });

  const recognized = await engine.recognize({ imageDataUrl: PNG_DATA_URL });
  assert.equal(recognized.question, RECOGNIZED.question);
  assert.equal(recognized.model, 'vision-model');
  assert.equal(visionStub.requests.length, 1);
  const visionRequest = visionStub.requests[0];
  assert.equal(visionRequest.json.model, 'vision-model');
  assert.equal(visionRequest.headers.authorization, 'Bearer vision-key');
  assert.match(String(visionRequest.json.messages[0].content), /^\[TASK:RECOGNIZE\]/);
  assert.equal(answerStub.requests.length, 0, 'recognition never touches the chat endpoint');

  const events = await collect(engine.answerStream({ imageDataUrl: PNG_DATA_URL }));
  assert.equal(events[0].question, RECOGNIZED.question);
  assert.equal(events.at(-1).text, ANSWER_DELTAS.join(''));

  assert.equal(visionStub.requests.length, 2, 'recognition used the vision endpoint again');
  assert.equal(answerStub.requests.length, 1, 'the answer itself used the chat endpoint');
  const answerRequest = answerStub.requests[0];
  assert.equal(answerRequest.json.model, 'chat-model');
  assert.equal(answerRequest.headers.authorization, 'Bearer chat-key');
  assert.match(String(answerRequest.json.messages[0].content), /^\[TASK:ANSWER\]/);
});

test('ensemble meta reports the judge model and three configured candidates', async (t) => {
  const stub = await chatStub(t);
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
  const engine = createEngine(config);

  const events = await collect(engine.answerStream({ question: '交叉验证引擎测试' }, { ensemble: true }));
  const meta = events[0];
  assert.equal(meta.type, 'meta');
  assert.equal(meta.ensemble, true);
  assert.equal(meta.model, 'judge-model', 'meta model is the judge model, not ai.model');
  assert.deepEqual(meta.judge, { name: '评审', model: 'judge-model' });
  assert.deepEqual(
    meta.candidates.map((candidate) => candidate.model),
    ['model-a', 'model-b', 'model-c'],
  );

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.ensemble, true);
  assert.equal(done.judge.model, 'judge-model');
  assert.equal(done.candidates.length, 3);
  assert.equal(done.fallback, undefined);

  assert.equal(stub.requests.length, 4, 'three candidate calls plus the judge');
  const judgeRequest = stub.requests.find((entry) =>
    String(entry.json?.messages?.[0]?.content ?? '').startsWith('[TASK:JUDGE]'),
  );
  assert.ok(judgeRequest);
  assert.equal(judgeRequest.json.model, 'judge-model');
  assert.equal(judgeRequest.json.temperature, 0.1);
  assert.equal(judgeRequest.json.stream, true);
});
