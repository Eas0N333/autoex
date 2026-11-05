import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROBE_TIMEOUT_MS,
  resolveProbeTargets,
  testConnection,
} from '../electron/probe.js';
import { completionBody, delay, sendJson, startStub } from './helpers/openai-stub.js';

const GLOBAL_KEY = 'sk-global-secret-0123456789';
const CANDIDATE_KEY = 'sk-candidate-secret-0123456789';
const PATCH_KEY = 'sk-patch-secret-0123456789';

/** A settings-like object; deliberately no import of electron/settings.js. */
function makeSettings({
  baseUrl = 'http://127.0.0.1:9/v1',
  apiKey = GLOBAL_KEY,
  model = 'text-model',
  visionModel = '',
  vision = {},
  candidates = [],
  judge = {},
  demo,
} = {}) {
  const settings = {
    ai: {
      baseUrl,
      apiKey,
      model,
      visionModel,
      vision: { baseUrl: '', apiKey: '', model: '', ...vision },
      ensemble: {
        enabled: candidates.length > 0 || Boolean(judge.model),
        candidates,
        judge: { name: '评审', baseUrl: '', apiKey: '', model: '', ...judge },
      },
    },
  };
  if (demo !== undefined) settings.demo = demo;
  return settings;
}

function candidate(model, extra = {}) {
  return { name: `候选 ${model}`, baseUrl: '', apiKey: '', model, temperature: 0.3, ...extra };
}

async function stubFor(t, handler) {
  const stub = await startStub(handler);
  t.after(() => stub.close());
  return stub;
}

function okHandler(req, res) {
  sendJson(res, 200, completionBody('pong'));
}

const role = (row) => row.role;

test('probe checks text, vision, candidate and judge concurrently with a summary', async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const stub = await stubFor(t, async (req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(60);
    inFlight -= 1;
    okHandler(req, res);
  });

  const settings = makeSettings({
    baseUrl: stub.baseUrl,
    model: 'text-model',
    visionModel: 'vision-model',
    vision: { model: 'vision-model' },
    candidates: [candidate('cand-a')],
    judge: { model: 'judge-model' },
  });

  const result = await testConnection(settings);

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 4);
  assert.deepEqual(result.results.map(role).sort(), ['candidate', 'judge', 'text', 'vision']);

  for (const row of result.results) {
    assert.equal(row.ok, true, `${row.role} should succeed`);
    assert.equal(row.host, '127.0.0.1');
    assert.equal(typeof row.model, 'string');
    assert.ok(row.model.length > 0);
    assert.equal(typeof row.label, 'string');
    assert.ok(row.label.length > 0);
    assert.ok(Number.isFinite(row.latencyMs) && row.latencyMs >= 0);
  }

  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.ok, 4);
  assert.equal(result.summary.failed, 0);
  assert.equal(
    result.summary.latencyMs,
    Math.max(...result.results.map((row) => row.latencyMs)),
    '整体耗时取最慢的目标',
  );

  assert.equal(stub.requests.length, 4);
  assert.equal(maxInFlight, 2, '探测并发上限为 2');
  assert.deepEqual(
    stub.requests.map((request) => request.json.model).sort(),
    ['cand-a', 'judge-model', 'text-model', 'vision-model'],
  );
  for (const request of stub.requests) {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${GLOBAL_KEY}`);
    assert.ok(request.json.max_tokens <= 16, '探测只消耗极少量 token');
  }
});

test('probe maps upstream failures to stable reason codes', async (t) => {
  const cases = [
    { label: '401', status: 401, body: { error: { message: 'Incorrect API key provided' } }, code: 'AUTH' },
    {
      label: '403 upgrade_required',
      status: 403,
      body: { error: { message: 'upgrade_required: this model needs a higher tier' } },
      code: 'PLAN',
    },
    {
      label: '404',
      status: 404,
      body: { error: { message: 'model not found' } },
      code: 'MODEL_NOT_FOUND',
    },
    {
      label: '429',
      status: 429,
      body: { error: { message: 'rate limit exceeded' } },
      code: 'RATE_LIMITED',
    },
    { label: '500', status: 500, body: { error: { message: 'internal error' } }, code: 'UPSTREAM' },
  ];

  for (const item of cases) {
    const stub = await stubFor(t, (req, res) => sendJson(res, item.status, item.body));
    const result = await testConnection(makeSettings({ baseUrl: stub.baseUrl }));

    assert.equal(result.ok, false, `${item.label} should fail`);
    assert.equal(result.results.length, 1, `${item.label} only probes the text model`);
    const [row] = result.results;
    assert.equal(row.ok, false);
    assert.equal(row.code, item.code, `${item.label} maps to ${item.code}`);
    assert.equal(row.status, item.status);
    assert.equal(row.host, '127.0.0.1');
    assert.equal(typeof row.message, 'string');
    assert.ok(row.message.length > 0);
    assert.ok(!row.message.includes(GLOBAL_KEY), `${item.label} message must not leak the key`);
    assert.equal(result.summary.failed, 1);
    assert.equal(stub.requests.length, 1, `${item.label} must not retry during a probe`);
  }
});

test('probe reports a timeout when the endpoint never answers', { timeout: 15_000 }, async (t) => {
  const stub = await stubFor(t, () => {
    // Keep the socket open: the probe has to give up on its own.
  });
  const started = Date.now();
  const result = await testConnection(makeSettings({ baseUrl: stub.baseUrl }), undefined, {
    timeoutMs: 800,
  });

  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].code, 'TIMEOUT');
  assert.equal(result.summary.failed, 1);
  assert.ok(Date.now() - started < PROBE_TIMEOUT_MS, '自定义超时生效，无需等满默认 15s');
});

test('probe reports NETWORK when the endpoint refuses connections', async () => {
  const stub = await startStub(() => {});
  const baseUrl = stub.baseUrl;
  await stub.close();

  const result = await testConnection(makeSettings({ baseUrl }));

  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].code, 'NETWORK');
  assert.equal(result.results[0].host, '127.0.0.1');
  assert.equal(result.summary.failed, 1);
});

test('candidate slots inherit the global base URL and key when empty', async (t) => {
  const stub = await stubFor(t, okHandler);
  const settings = makeSettings({
    baseUrl: stub.baseUrl,
    candidates: [candidate('cand-a')],
    judge: { model: 'judge-model' },
  });

  const result = await testConnection(settings);
  assert.equal(result.ok, true);

  const candidateTarget = resolveProbeTargets(settings).find((target) => target.role === 'candidate');
  assert.ok(candidateTarget);
  assert.equal(candidateTarget.baseUrl, stub.baseUrl);
  assert.equal(candidateTarget.apiKey, GLOBAL_KEY);

  const request = stub.requests.find((entry) => entry.json.model === 'cand-a');
  assert.ok(request, 'candidate model was requested');
  assert.equal(request.headers.authorization, `Bearer ${GLOBAL_KEY}`);
});

test('candidate slots use their own key when configured', async (t) => {
  const stub = await stubFor(t, okHandler);
  const settings = makeSettings({
    baseUrl: stub.baseUrl,
    candidates: [candidate('cand-a', { apiKey: CANDIDATE_KEY })],
  });

  const result = await testConnection(settings);
  assert.equal(result.ok, true);
  assert.equal(stub.requests.length, 2);

  const candidateRequest = stub.requests.find((entry) => entry.json.model === 'cand-a');
  const textRequest = stub.requests.find((entry) => entry.json.model === 'text-model');
  assert.equal(candidateRequest.headers.authorization, `Bearer ${CANDIDATE_KEY}`);
  assert.equal(textRequest.headers.authorization, `Bearer ${GLOBAL_KEY}`);
});

test('judge inherits ai.model when its own model is empty', async (t) => {
  const textStub = await stubFor(t, okHandler);
  const judgeStub = await stubFor(t, okHandler);
  const settings = makeSettings({
    baseUrl: textStub.baseUrl,
    model: 'text-model',
    judge: { baseUrl: judgeStub.baseUrl },
  });

  const judgeTarget = resolveProbeTargets(settings).find((target) => target.role === 'judge');
  assert.ok(judgeTarget, 'judge slot with a custom base URL is probed');
  assert.equal(judgeTarget.model, 'text-model');

  const result = await testConnection(settings);
  assert.equal(result.ok, true);
  assert.equal(judgeStub.requests.length, 1);
  assert.equal(judgeStub.requests[0].json.model, 'text-model');
  assert.equal(judgeStub.requests[0].headers.authorization, `Bearer ${GLOBAL_KEY}`);
});

test('identical base URL, model and key targets are requested once', async (t) => {
  const stub = await stubFor(t, okHandler);
  const settings = makeSettings({
    baseUrl: stub.baseUrl,
    model: 'shared-model',
    candidates: [candidate('shared-model')],
    judge: { model: 'shared-model' },
  });

  const result = await testConnection(settings);

  assert.equal(stub.requests.length, 1, 'duplicate targets collapse into one request');
  assert.equal(result.ok, true);
  assert.ok(result.results.every((row) => row.ok));
  assert.ok(result.summary.ok >= 1);
});

test('probe targets are deduplicated and capped at eight', () => {
  const settings = makeSettings({
    baseUrl: 'http://127.0.0.1:9/v1',
    visionModel: 'vision-model',
    vision: { model: 'vision-model' },
    candidates: Array.from({ length: 10 }, (_, index) => candidate(`cand-${index}`)),
    judge: { model: 'judge-model' },
  });

  const targets = resolveProbeTargets(settings);

  assert.ok(targets.length <= 8, `expected at most 8 targets, got ${targets.length}`);
  assert.equal(targets.length, 8);
  const keys = new Set(targets.map((target) => target.key));
  assert.equal(keys.size, targets.length, 'target keys are unique');
  for (const target of targets) {
    assert.ok(['text', 'vision', 'candidate', 'judge'].includes(target.role));
    assert.equal(typeof target.baseUrl, 'string');
    assert.equal(typeof target.model, 'string');
    assert.ok(target.model.length > 0);
    assert.ok(target.key.length > 0);
  }
});

test('missing api key sends no request and reports NO_KEY', async (t) => {
  const stub = await stubFor(t, okHandler);
  const settings = makeSettings({ baseUrl: stub.baseUrl, apiKey: '' });

  const result = await testConnection(settings);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_KEY');
  assert.equal(stub.requests.length, 0, 'no request may leave the process without a key');
});

test('demo settings send no request and report DEMO', async (t) => {
  const stub = await stubFor(t, okHandler);
  const settings = makeSettings({ baseUrl: stub.baseUrl, demo: true });

  const result = await testConnection(settings);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DEMO');
  assert.equal(stub.requests.length, 0, 'demo mode never touches the network');
});

test('results never expose the api key or the full base URL', async (t) => {
  const stub = await stubFor(t, (req, res) =>
    sendJson(res, 401, { error: { message: `Incorrect API key provided: ${GLOBAL_KEY}` } }),
  );

  const result = await testConnection(makeSettings({ baseUrl: stub.baseUrl }));
  assert.equal(result.ok, false);
  assert.equal(result.results[0].code, 'AUTH');
  assert.equal(result.results[0].host, '127.0.0.1');

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(GLOBAL_KEY), 'api key must never be returned');
  assert.ok(!serialized.includes('sk-'), 'no key material at all');
  assert.ok(!serialized.includes(String(stub.port)), 'only the hostname is exposed, not the full URL');
  assert.ok(!serialized.includes('/v1'), 'the base URL path is not exposed');
});

test('patch overrides the current settings for one probe only', async (t) => {
  const stub = await stubFor(t, okHandler);
  const settings = makeSettings({ baseUrl: stub.baseUrl, model: 'stored-model' });
  const snapshot = structuredClone(settings);

  const result = await testConnection(settings, {
    ai: { apiKey: PATCH_KEY, model: 'patched-model' },
  });

  assert.equal(result.ok, true);
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].json.model, 'patched-model');
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${PATCH_KEY}`);
  assert.equal(result.results[0].model, 'patched-model');
  assert.ok(!JSON.stringify(result).includes(PATCH_KEY));
  assert.deepEqual(settings, snapshot, 'the temporary patch is not written back');
});

test('patch can supply the key the saved settings lack', async (t) => {
  const stub = await stubFor(t, okHandler);
  const settings = makeSettings({ baseUrl: stub.baseUrl, apiKey: '' });

  const withoutPatch = await testConnection(settings);
  assert.equal(withoutPatch.reason, 'NO_KEY');
  assert.equal(stub.requests.length, 0);

  const result = await testConnection(settings, { ai: { apiKey: PATCH_KEY } });
  assert.equal(result.ok, true);
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${PATCH_KEY}`);
  assert.equal(settings.ai.apiKey, '');
});
