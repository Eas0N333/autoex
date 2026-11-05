import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../server/config.js';
import { EngineError, createEngine } from '../server/engine.js';
import { DEMO_ANSWER_TEXT } from '../server/mock.js';
import { makeRoot } from './helpers/root.js';
import {
  completionBody,
  delay,
  sendJson,
  sendSseFragments,
  sseBody,
  startStub,
} from './helpers/openai-stub.js';

const QUESTION = '已知函数 f(x)=x^2-4x+3，求 f(x) 的最小值。';
const OPTIONS = [
  { label: 'A', text: '-1' },
  { label: 'B', text: '0' },
];
const JUDGE_DELTAS = ['【答案】A（-1）\n\n', '【解析】三份独立作答推导一致。\n', '【一致性】一致'];
const JUDGE_TEXT = JUDGE_DELTAS.join('');

function textForModel(model) {
  return `【答案】A（-1）\n\n【解析】${model} 独立推导：配方后最小值为 -1。`;
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function systemOf(entry) {
  return String(entry?.json?.messages?.[0]?.content ?? '');
}

/**
 * One OpenAI-compatible endpoint. Candidate answers are plain JSON completions
 * keyed by the requested model; `[TASK:JUDGE]` requests get a chunked SSE stream.
 */
async function modelStub(t, options = {}) {
  const {
    answer = (model) => textForModel(model),
    judgeDeltas = JUDGE_DELTAS,
    status = 200,
    judgeStatus = 200,
    delayMs = 0,
  } = options;

  const stub = await startStub(async (req, res, entry) => {
    if (!String(entry.url).endsWith('/chat/completions')) {
      sendJson(res, 404, { error: { message: 'unknown path' } });
      return;
    }
    const body = entry.json ?? {};
    const isJudge = systemOf(entry).startsWith('[TASK:JUDGE]');
    if (delayMs > 0) await delay(delayMs);
    if (res.destroyed || res.writableEnded) return;

    if (isJudge) {
      if (judgeStatus !== 200) {
        sendJson(res, judgeStatus, { error: { message: 'judge unavailable' } });
        return;
      }
      await sendSseFragments(
        res,
        sseBody(judgeDeltas, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
      );
      return;
    }

    if (status !== 200) {
      sendJson(res, status, { error: { message: 'candidate unavailable' } });
      return;
    }
    const text = typeof answer === 'function' ? answer(body.model, entry) : answer;
    sendJson(res, 200, completionBody(text));
  });
  t.after(() => stub.close());
  return stub;
}

/** Live config whose global endpoint is unusable: every slot must set its own. */
function liveConfig(t) {
  const config = loadConfig(
    {
      AI_API_KEY: 'global-key',
      AI_BASE_URL: 'http://127.0.0.1:9/v1',
      AI_MODEL: 'global-model',
      AI_TIMEOUT_MS: '3000',
    },
    makeRoot(t),
  );
  config.ai.maxRetries = 0; // No retry delays: failure assertions stay exact.
  config.ai.ensemble.enabled = false;
  return config;
}

function candidateSlots(stubs, overrides = {}) {
  return stubs.map((stub, index) => ({
    name: `模型 ${'ABC'[index]}`,
    baseUrl: stub.baseUrl,
    apiKey: `key-${'abc'[index]}`,
    model: `model-${'abc'[index]}`,
    temperature: [0.3, 0.6, 0.9][index],
    ...(overrides[index] ?? {}),
  }));
}

function judgeSlot(stub, overrides = {}) {
  return {
    name: '评审',
    baseUrl: stub.baseUrl,
    apiKey: 'judge-key',
    model: 'judge-model',
    temperature: 0.1,
    ...overrides,
  };
}

function ensembleConfig(t, stubs, judgeStub, overrides = {}) {
  const config = liveConfig(t);
  config.ai.ensemble.candidates = candidateSlots(stubs, overrides.candidates);
  config.ai.ensemble.judge = judgeSlot(judgeStub, overrides.judge);
  return config;
}

test('three providers answer in parallel and the judge streams the final answer', async (t) => {
  const stubs = [await modelStub(t), await modelStub(t), await modelStub(t)];
  const judgeStub = await modelStub(t);
  const engine = createEngine(ensembleConfig(t, stubs, judgeStub));

  const events = await collect(
    engine.answerStream({ question: QUESTION, options: OPTIONS, style: 'detailed' }, { ensemble: true }),
  );

  const meta = events[0];
  assert.equal(meta.type, 'meta');
  assert.equal(meta.ensemble, true);
  assert.equal(meta.cached, false);
  assert.equal(meta.model, 'judge-model', 'meta model is the judge model');
  assert.deepEqual(meta.judge, { name: '评审', model: 'judge-model' });
  assert.deepEqual(
    meta.candidates.map(({ index, name, model }) => ({ index, name, model })),
    [
      { index: 0, name: '模型 A', model: 'model-a' },
      { index: 1, name: '模型 B', model: 'model-b' },
      { index: 2, name: '模型 C', model: 'model-c' },
    ],
  );

  // Every candidate is announced as running before any of them settles.
  const candidateEvents = events.filter((event) => event.type === 'candidate');
  assert.equal(candidateEvents.length, 6);
  const running = candidateEvents.slice(0, 3);
  const settled = candidateEvents.slice(3);
  assert.deepEqual(running.map((event) => event.status), ['running', 'running', 'running']);
  assert.deepEqual(running.map((event) => event.index), [0, 1, 2]);
  for (const event of running) {
    assert.equal(event.text, undefined);
    assert.equal(event.durationMs, undefined);
  }

  // Settlement order is a race; identify candidates by index, not position.
  const doneByIndex = new Map(settled.map((event) => [event.index, event]));
  assert.deepEqual([...doneByIndex.keys()].sort(), [0, 1, 2]);
  for (const index of [0, 1, 2]) {
    const event = doneByIndex.get(index);
    assert.equal(event.status, 'done');
    assert.equal(event.model, `model-${'abc'[index]}`);
    assert.equal(event.text, textForModel(`model-${'abc'[index]}`));
    assert.equal(typeof event.durationMs, 'number');
    assert.ok(event.durationMs >= 0);
  }

  // The judge stream is forwarded delta by delta, in order.
  const deltas = events.filter((event) => event.type === 'delta').map((event) => event.text);
  assert.deepEqual(deltas, JUDGE_DELTAS);

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.ensemble, true);
  assert.equal(done.text, JUDGE_TEXT);
  assert.equal(done.cached, false);
  assert.equal(done.fallback, undefined);
  assert.deepEqual(done.judge, { name: '评审', model: 'judge-model', status: 'done' });
  assert.deepEqual(
    done.candidates.map((candidate) => ({ index: candidate.index, status: candidate.status })),
    [
      { index: 0, status: 'done' },
      { index: 1, status: 'done' },
      { index: 2, status: 'done' },
    ],
  );

  // Each candidate endpoint saw exactly its own request: model, temperature, key.
  stubs.forEach((stub, index) => {
    assert.equal(stub.requests.length, 1, `candidate ${index} received one request`);
    const request = stub.requests[0];
    assert.equal(request.json.model, `model-${'abc'[index]}`);
    assert.equal(request.json.temperature, [0.3, 0.6, 0.9][index]);
    assert.equal(request.json.stream, false, 'candidates answer without streaming');
    assert.equal(request.headers.authorization, `Bearer key-${'abc'[index]}`);
    assert.equal(request.json.messages[0].content.startsWith('[TASK:ANSWER]'), true);
  });

  assert.equal(judgeStub.requests.length, 1);
  const judgeRequest = judgeStub.requests[0];
  assert.equal(systemOf(judgeRequest).startsWith('[TASK:JUDGE]'), true);
  assert.equal(judgeRequest.json.model, 'judge-model');
  assert.equal(judgeRequest.json.temperature, 0.1);
  assert.equal(judgeRequest.json.stream, true);
  assert.equal(judgeRequest.headers.authorization, 'Bearer judge-key');

  const judgePrompt = String(judgeRequest.json.messages.at(-1).content);
  assert.ok(judgePrompt.includes(QUESTION), 'judge sees the original question');
  assert.ok(judgePrompt.includes('A. -1') && judgePrompt.includes('B. 0'), 'judge sees the options');
  for (const model of ['model-a', 'model-b', 'model-c']) {
    assert.ok(judgePrompt.includes(model), `judge prompt names ${model}`);
    assert.ok(judgePrompt.includes(textForModel(model)), `judge prompt carries ${model}'s answer`);
  }
});

test('one failing candidate is reported but the judge still answers from the survivors', async (t) => {
  const stubs = [
    await modelStub(t),
    await modelStub(t, { status: 500 }),
    await modelStub(t),
  ];
  const judgeStub = await modelStub(t);
  const engine = createEngine(ensembleConfig(t, stubs, judgeStub));

  const events = await collect(engine.answerStream({ question: QUESTION }, { ensemble: true }));

  const settled = events.filter((event) => event.type === 'candidate' && event.status !== 'running');
  const byIndex = new Map(settled.map((event) => [event.index, event]));
  assert.equal(byIndex.get(0).status, 'done');
  assert.equal(byIndex.get(2).status, 'done');
  assert.equal(byIndex.get(1).status, 'error');
  assert.equal(byIndex.get(1).error, 'UPSTREAM');
  assert.equal(byIndex.get(1).text, undefined);

  assert.equal(judgeStub.requests.length, 1);
  const judgePrompt = String(judgeStub.requests[0].json.messages.at(-1).content);
  assert.ok(judgePrompt.includes(textForModel('model-a')));
  assert.ok(judgePrompt.includes(textForModel('model-c')));
  assert.ok(!judgePrompt.includes('model-b'), 'the failed candidate never reaches the judge');
  assert.ok(judgePrompt.includes('以下是 2 份相互独立的作答'));

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, JUDGE_TEXT);
  assert.equal(done.fallback, undefined, 'a partial failure is not a judge fallback');
  assert.deepEqual(
    done.candidates.map((candidate) => [candidate.index, candidate.status, candidate.error]),
    [
      [0, 'done', undefined],
      [1, 'error', 'UPSTREAM'],
      [2, 'done', undefined],
    ],
  );
});

test('when every candidate fails the answer rejects with UPSTREAM_ERROR and no judge call', async (t) => {
  const stubs = [
    await modelStub(t, { status: 502 }),
    await modelStub(t, { status: 500 }),
    await modelStub(t, { status: 503 }),
  ];
  const judgeStub = await modelStub(t);
  const engine = createEngine(ensembleConfig(t, stubs, judgeStub));

  await assert.rejects(engine.answerComplete({ question: QUESTION }, { ensemble: true }), (error) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.message, '所有候选模型均未能作答，请稍后重试');
    return true;
  });
  assert.equal(judgeStub.requests.length, 0, 'the judge is never asked');
});

test('a judge failure falls back to the first surviving answer', async (t) => {
  const stubs = [await modelStub(t), await modelStub(t), await modelStub(t)];
  const judgeStub = await modelStub(t, { judgeStatus: 500 });
  const engine = createEngine(ensembleConfig(t, stubs, judgeStub));

  const events = await collect(engine.answerStream({ question: QUESTION }, { ensemble: true }));
  const deltas = events.filter((event) => event.type === 'delta').map((event) => event.text);
  assert.deepEqual(deltas, [textForModel('model-a')], 'the survivor answer is replayed as one delta');

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, textForModel('model-a'));
  assert.equal(done.fallback, true);
  assert.equal(done.judge.status, 'error');
  assert.equal(done.judge.error, 'UPSTREAM');
  assert.equal(done.judge.model, 'judge-model');
  assert.equal(done.candidates.length, 3);
});

test('fewer than two usable candidates is a BAD_REQUEST', async (t) => {
  const stub = await modelStub(t);
  const config = liveConfig(t);
  config.ai.ensemble.candidates = [
    { name: '模型 A', baseUrl: stub.baseUrl, apiKey: 'key-a', model: 'model-a', temperature: 0.3 },
    { name: '模型 B', baseUrl: '', apiKey: '', model: '', temperature: 0.6 },
    { name: '模型 C', baseUrl: '', apiKey: '', model: '', temperature: 0.9 },
  ];
  config.ai.ensemble.judge = judgeSlot(stub);

  await assert.rejects(createEngine(config).answerComplete({ question: QUESTION }, { ensemble: true }), {
    name: 'EngineError',
    code: 'BAD_REQUEST',
    message: '交叉验证需要至少 2 个候选模型',
  });
  assert.equal(stub.requests.length, 0, 'validation happens before any upstream call');

  // A candidate whose resolved base URL is unusable does not count either.
  const broken = liveConfig(t);
  broken.ai.baseUrl = '';
  broken.ai.ensemble.candidates = [
    { name: '模型 A', baseUrl: stub.baseUrl, apiKey: 'key-a', model: 'model-a', temperature: 0.3 },
    { name: '模型 B', baseUrl: 'ftp://not-http', apiKey: '', model: 'model-b', temperature: 0.6 },
  ];
  broken.ai.ensemble.judge = judgeSlot(stub);
  await assert.rejects(createEngine(broken).answerComplete({ question: QUESTION }, { ensemble: true }), {
    name: 'EngineError',
    code: 'BAD_REQUEST',
  });
});

test('aborting while the candidates run rejects ABORTED and caches nothing', async (t) => {
  let candidateCalls = 0;
  const stub = await startStub(async (req, res, entry) => {
    const isJudge = systemOf(entry).startsWith('[TASK:JUDGE]');
    if (!isJudge) {
      candidateCalls += 1;
      // Hold the first round open so the caller can abort mid-flight.
      if (candidateCalls <= 3) await delay(300);
      if (res.destroyed || res.writableEnded) return;
      sendJson(res, 200, completionBody(textForModel(entry.json?.model)));
      return;
    }
    if (res.destroyed || res.writableEnded) return;
    await sendSseFragments(res, sseBody(JUDGE_DELTAS));
  });
  t.after(() => stub.close());

  const config = liveConfig(t);
  config.ai.ensemble.candidates = [0, 1, 2].map((index) => ({
    name: `模型 ${'ABC'[index]}`,
    baseUrl: stub.baseUrl,
    apiKey: `key-${'abc'[index]}`,
    model: `model-${'abc'[index]}`,
    temperature: [0.3, 0.6, 0.9][index],
  }));
  config.ai.ensemble.judge = judgeSlot(stub);
  const engine = createEngine(config);

  const controller = new AbortController();
  const iterator = engine.answerStream({ question: QUESTION }, { ensemble: true, signal: controller.signal })[
    Symbol.asyncIterator
  ]();

  const first = await iterator.next();
  assert.equal(first.value.type, 'meta');
  controller.abort();

  let aborted = null;
  try {
    for (;;) {
      const { done } = await iterator.next();
      if (done) break;
    }
  } catch (error) {
    aborted = error;
  }
  assert.ok(aborted instanceof EngineError, 'abort surfaces as an EngineError');
  assert.equal(aborted.code, 'ABORTED');
  assert.equal(candidateCalls <= 3, true, 'no candidate settled before the abort');

  const afterAbort = await engine.answerComplete({ question: QUESTION }, { ensemble: true });
  assert.equal(afterAbort.cached, false, 'an aborted ensemble answer is never cached');
  assert.equal(afterAbort.text, JUDGE_TEXT);
});

test('aborting mid-judge rejects ABORTED and caches nothing', async (t) => {
  const candidateStub = await modelStub(t);
  let judgeCalls = 0;
  const judgeStub = await startStub(async (req, res, entry) => {
    const isJudge = systemOf(entry).startsWith('[TASK:JUDGE]');
    if (!isJudge) {
      sendJson(res, 200, completionBody(textForModel(entry.json?.model)));
      return;
    }
    judgeCalls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '【答案】A' } }] })}\n\n`);
    if (judgeCalls > 1) {
      await sendSseFragments(res, sseBody(['（-1）\n\n', '【一致性】一致']));
      return;
    }
    // Keep the stream open so the caller can abort during judging.
  });
  t.after(() => judgeStub.close());

  const config = liveConfig(t);
  config.ai.ensemble.candidates = [0, 1, 2].map((index) => ({
    name: `模型 ${'ABC'[index]}`,
    baseUrl: candidateStub.baseUrl,
    apiKey: `key-${'abc'[index]}`,
    model: `model-${'abc'[index]}`,
    temperature: [0.3, 0.6, 0.9][index],
  }));
  config.ai.ensemble.judge = judgeSlot(judgeStub);
  const engine = createEngine(config);

  const controller = new AbortController();
  const iterator = engine.answerStream({ question: QUESTION }, { ensemble: true, signal: controller.signal })[
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
  assert.equal(judgeCalls, 1, 'the judge stream was already open');

  const afterAbort = await engine.answerComplete({ question: QUESTION }, { ensemble: true });
  assert.equal(afterAbort.cached, false, 'a truncated judge answer is never cached');
  assert.equal(judgeCalls, 2, 'the retry really re-ran the pipeline');
});

test('a cached ensemble answer replays candidates, one delta and done without HTTP traffic', async (t) => {
  const stubs = [await modelStub(t), await modelStub(t), await modelStub(t)];
  const judgeStub = await modelStub(t);
  const engine = createEngine(ensembleConfig(t, stubs, judgeStub));
  const input = { question: QUESTION, options: OPTIONS, style: 'concise' };

  const first = await engine.answerComplete(input, { ensemble: true });
  assert.equal(first.cached, false);
  assert.equal(first.text, JUDGE_TEXT);
  assert.equal(first.candidates.length, 3);

  const before = [...stubs, judgeStub].map((stub) => stub.requests.length);

  const replay = await collect(engine.answerStream(input, { ensemble: true }));
  assert.deepEqual(
    replay.map((event) => event.type),
    ['meta', 'candidate', 'candidate', 'candidate', 'delta', 'done'],
  );
  assert.equal(replay[0].cached, true);
  assert.equal(replay[0].ensemble, true);
  const delta = replay.filter((event) => event.type === 'delta');
  assert.equal(delta.length, 1);
  assert.equal(delta[0].text, JUDGE_TEXT);

  const cachedCandidates = replay.filter((event) => event.type === 'candidate');
  assert.deepEqual(cachedCandidates.map((event) => event.status), ['done', 'done', 'done']);
  assert.deepEqual(cachedCandidates.map((event) => event.model), ['model-a', 'model-b', 'model-c']);
  assert.equal(cachedCandidates[0].text, textForModel('model-a'));

  const done = replay.at(-1);
  assert.equal(done.cached, true);
  assert.equal(done.text, JUDGE_TEXT);
  assert.equal(done.candidates.length, 3);
  assert.equal(done.judge.status, 'done');

  const after = [...stubs, judgeStub].map((stub) => stub.requests.length);
  assert.deepEqual(after, before, 'the cached replay never touches the network');
});

test('ensemble cache keys cover candidate temperature/model and clearCache works', async (t) => {
  const config = loadConfig({ AI_DEMO: '1' }, makeRoot(t));
  const engine = createEngine(config);
  const input = { question: '缓存签名测试题：解释牛顿第一定律。' };

  const first = await engine.answerComplete(input, { ensemble: true });
  assert.equal(first.cached, false);
  assert.equal((await engine.answerComplete(input, { ensemble: true })).cached, true);

  // Temperature is part of the candidate signature.
  engine.config.ai.ensemble.candidates[0].temperature = 1.4;
  assert.equal(
    (await engine.answerComplete(input, { ensemble: true })).cached,
    false,
    'a different candidate temperature misses',
  );

  // ... and so is the model name.
  engine.config.ai.ensemble.candidates[1].model = 'gpt-demo-extra';
  assert.equal(
    (await engine.answerComplete(input, { ensemble: true })).cached,
    false,
    'a different candidate model misses',
  );

  // Ensemble and single-model answers never share an entry.
  assert.equal((await engine.answerComplete(input)).cached, false, 'plain mode is a different key');
  assert.equal((await engine.answerComplete(input)).cached, true);

  engine.clearCache();
  assert.equal(
    (await engine.answerComplete(input, { ensemble: true })).cached,
    false,
    'clearCache drops ensemble entries too',
  );
});

test('a different judge model never reuses another engine cache entry', async (t) => {
  const stubs = [await modelStub(t), await modelStub(t), await modelStub(t)];
  const judgeStub = await modelStub(t);
  const input = { question: '评审签名测试题' };

  const first = createEngine(ensembleConfig(t, stubs, judgeStub));
  assert.equal((await first.answerComplete(input, { ensemble: true })).cached, false);
  assert.equal((await first.answerComplete(input, { ensemble: true })).cached, true);

  const second = createEngine(
    ensembleConfig(t, stubs, judgeStub, { judge: { model: 'judge-model-2', temperature: 0.4 } }),
  );
  const other = await second.answerComplete(input, { ensemble: true });
  assert.equal(other.cached, false, 'a different judge signature is a miss');
  assert.equal(other.judge.model, 'judge-model-2');
  assert.equal(judgeStub.requests.at(-1).json.model, 'judge-model-2');
});

test('candidate and judge endpoints inherit the global base URL, key and model', async (t) => {
  const sharedStub = await modelStub(t);
  const ownStub = await modelStub(t);

  const config = loadConfig(
    {
      AI_API_KEY: 'global-key',
      AI_BASE_URL: sharedStub.baseUrl,
      AI_MODEL: 'global-model',
      AI_TIMEOUT_MS: '3000',
    },
    makeRoot(t),
  );
  config.ai.maxRetries = 0;
  config.ai.ensemble.candidates = [
    // Fully inherited: empty baseUrl, apiKey and judge model.
    { name: '模型 A', baseUrl: '', apiKey: '', model: 'inherit-model', temperature: 0.3 },
    // Own key, inherited endpoint.
    { name: '模型 B', baseUrl: '', apiKey: 'own-key-b', model: 'own-model-b', temperature: 0.6 },
    // Fully explicit endpoint.
    { name: '模型 C', baseUrl: ownStub.baseUrl, apiKey: 'own-key-c', model: 'own-model-c', temperature: 0.9 },
  ];
  config.ai.ensemble.judge = { name: '评审', baseUrl: '', apiKey: '', model: '', temperature: 0.1 };

  const engine = createEngine(config);
  const events = await collect(engine.answerStream({ question: QUESTION }, { ensemble: true }));

  assert.equal(events[0].model, 'global-model', 'an empty judge model inherits ai.model');
  assert.equal(events[0].judge.model, 'global-model');
  assert.deepEqual(events[0].candidates.map((candidate) => candidate.model), [
    'inherit-model',
    'own-model-b',
    'own-model-c',
  ]);

  const shared = sharedStub.requests;
  const inherited = shared.find((entry) => entry.json.model === 'inherit-model');
  assert.ok(inherited, 'the inherited candidate hit the global endpoint');
  assert.equal(inherited.headers.authorization, 'Bearer global-key');
  assert.equal(inherited.json.temperature, 0.3);

  const ownKey = shared.find((entry) => entry.json.model === 'own-model-b');
  assert.ok(ownKey, 'the per-candidate key still uses the global endpoint');
  assert.equal(ownKey.headers.authorization, 'Bearer own-key-b');

  assert.equal(ownStub.requests.length, 1);
  assert.equal(ownStub.requests[0].json.model, 'own-model-c');
  assert.equal(ownStub.requests[0].headers.authorization, 'Bearer own-key-c');

  const judgeRequest = shared.find((entry) => systemOf(entry).startsWith('[TASK:JUDGE]'));
  assert.ok(judgeRequest, 'the judge inherited the global endpoint');
  assert.equal(judgeRequest.json.model, 'global-model');
  assert.equal(judgeRequest.headers.authorization, 'Bearer global-key');
  assert.equal(judgeRequest.json.temperature, 0.1);
});

test('demo mode runs the cross-check offline with three participants and a judge', async (t) => {
  const config = loadConfig({ AI_DEMO: '1' }, makeRoot(t));
  const engine = createEngine(config);
  assert.equal(engine.provider.kind, 'demo');

  const events = await collect(engine.answerStream({ question: '演示模式交叉验证' }, { ensemble: true }));
  const meta = events[0];
  assert.equal(meta.mode, 'demo');
  assert.equal(meta.ensemble, true);
  assert.equal(meta.candidates.length, 3);
  assert.deepEqual(meta.candidates.map((candidate) => candidate.index), [0, 1, 2]);
  assert.equal(meta.judge.name, '评审');
  assert.equal(meta.judge.model, 'demo-chat');

  const candidateEvents = events.filter((event) => event.type === 'candidate');
  assert.equal(candidateEvents.filter((event) => event.status === 'running').length, 3);
  const settled = candidateEvents.filter((event) => event.status === 'done');
  assert.equal(settled.length, 3);
  for (const event of settled) assert.equal(event.text, DEMO_ANSWER_TEXT);

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.ensemble, true);
  assert.equal(done.fallback, undefined);
  assert.equal(done.judge.status, 'done');
  assert.equal(done.candidates.length, 3);
  assert.ok(done.text.includes('【一致性】'), 'the judge answer carries the consistency line');
  assert.equal(
    events.filter((event) => event.type === 'delta').map((event) => event.text).join(''),
    done.text,
  );
});
