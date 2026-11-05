import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../server/config.js';
import { ProviderError, createProvider } from '../server/provider.js';
import { makeRoot } from './helpers/root.js';
import {
  completionBody,
  delay,
  sendJson,
  sendSseFragments,
  sseBody,
  startStub,
} from './helpers/openai-stub.js';

function configFor(t, stub, env = {}) {
  const root = makeRoot(t);
  return loadConfig(
    {
      AI_API_KEY: 'test-key',
      AI_BASE_URL: stub.baseUrl,
      AI_MODEL: 'stub-model',
      AI_TIMEOUT_MS: '5000',
      ...env,
    },
    root,
  );
}

async function stubFor(t, handler) {
  const stub = await startStub(handler);
  t.after(() => stub.close());
  return stub;
}

const CHAT_MESSAGES = [{ role: 'user', content: 'hello' }];

test('live provider identifies itself and sends an authenticated chat request', async (t) => {
  const stub = await stubFor(t, (req, res) => sendJson(res, 200, completionBody('pong')));
  const provider = createProvider(configFor(t, stub));

  assert.equal(provider.kind, 'live');
  assert.equal(provider.model, 'stub-model');
  assert.equal(provider.visionModel, 'stub-model');

  const result = await provider.chat({ messages: CHAT_MESSAGES, temperature: 0.2, maxTokens: 32 });

  assert.equal(result.text, 'pong');
  assert.equal(result.usage.total_tokens, 8);
  assert.equal(stub.requests.length, 1);

  const [request] = stub.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.json.model, 'stub-model');
  assert.notEqual(request.json.stream, true, 'chat() is not streaming');
  assert.deepEqual(request.json.messages, CHAT_MESSAGES);
  assert.equal(request.json.temperature, 0.2);
  assert.equal(request.json.max_tokens ?? request.json.max_completion_tokens, 32);
});

test('image content is routed to the configured vision model', async (t) => {
  const stub = await stubFor(t, (req, res) => sendJson(res, 200, completionBody('{"question":"q"}')));
  const provider = createProvider(configFor(t, stub, { AI_VISION_MODEL: 'stub-vision' }));

  assert.equal(provider.visionModel, 'stub-vision');
  await provider.chat({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'transcribe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
      },
    ],
  });

  assert.equal(stub.requests[0].json.model, 'stub-vision');
});

test('streamChat reassembles fragmented SSE, keeps usage and stops at [DONE]', async (t) => {
  const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
  const payload = sseBody(['你', '好', '！'], usage);
  const stub = await stubFor(t, (req, res) => sendSseFragments(res, payload, { size: 5 }));
  const provider = createProvider(configFor(t, stub));

  const events = [];
  for await (const event of provider.streamChat({ messages: CHAT_MESSAGES })) events.push(event);

  const text = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
  assert.equal(text, '你好！');
  const usageEvent = events.find((event) => event.type === 'usage');
  assert.deepEqual(usageEvent.usage, usage);
  assert.equal(stub.requests[0].json.stream, true);
});

test('a 400 caused by an unsupported temperature is retried without it', async (t) => {
  const stub = await stubFor(t, (req, res, entry, requests) => {
    if (requests.length === 1) {
      sendJson(res, 400, { error: { message: 'deepseek-reasoner does not support setting temperature' } });
      return;
    }
    sendJson(res, 200, completionBody('ok'));
  });
  const provider = createProvider(configFor(t, stub));

  const result = await provider.chat({ messages: CHAT_MESSAGES, temperature: 0.6 });

  assert.equal(result.text, 'ok');
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0].json.temperature, 0.6);
  assert.equal('temperature' in stub.requests[1].json, false);
});

test('non-2xx upstream responses raise ProviderError with status and no key leak', async (t) => {
  const stub = await stubFor(t, (req, res) =>
    sendJson(res, 401, { error: { message: 'Incorrect API key provided' } }),
  );
  const provider = createProvider(configFor(t, stub));

  await assert.rejects(provider.chat({ messages: CHAT_MESSAGES }), (error) => {
    assert.equal(error.name, 'ProviderError');
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'UPSTREAM');
    assert.equal(error.status, 401);
    assert.ok(!String(error.message).includes('test-key'));
    return true;
  });
});

test('a 500 on the first attempt is retried once', async (t) => {
  let calls = 0;
  const stub = await stubFor(t, (req, res) => {
    calls += 1;
    if (calls === 1) {
      sendJson(res, 500, { error: { message: 'boom' } });
      return;
    }
    sendJson(res, 200, completionBody('recovered'));
  });
  const provider = createProvider(configFor(t, stub));

  const result = await provider.chat({ messages: CHAT_MESSAGES });

  assert.equal(result.text, 'recovered');
  assert.equal(stub.requests.length, 2);
});

test('a hanging upstream hits the configured timeout', async (t) => {
  const stub = await stubFor(t, () => {}); // never responds
  const provider = createProvider(configFor(t, stub, { AI_TIMEOUT_MS: '120' }));

  await assert.rejects(provider.chat({ messages: CHAT_MESSAGES }), (error) => {
    assert.equal(error.name, 'ProviderError');
    assert.equal(error.code, 'TIMEOUT');
    return true;
  });
});

test('caller abort surfaces as ABORTED', async (t) => {
  const stub = await stubFor(t, () => {});
  const provider = createProvider(configFor(t, stub, { AI_TIMEOUT_MS: '5000' }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40);
  t.after(() => clearTimeout(timer));

  await assert.rejects(provider.chat({ messages: CHAT_MESSAGES, signal: controller.signal }), (error) => {
    assert.equal(error.name, 'ProviderError');
    assert.equal(error.code, 'ABORTED');
    return true;
  });
});

test('demo provider answers recognize markers deterministically', async (t) => {
  const provider = createProvider(loadConfig({ AI_DEMO: '1' }, makeRoot(t)));

  assert.equal(provider.kind, 'demo');
  assert.equal(provider.visionModel, 'demo-vision');

  const messages = [
    { role: 'system', content: '[TASK:RECOGNIZE] 请识别题目' },
    { role: 'user', content: [{ type: 'text', text: '识别' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
  ];
  const first = await provider.chat({ messages });
  const second = await provider.chat({ messages });

  assert.equal(first.text, second.text, 'demo output is deterministic');
  const parsed = JSON.parse(first.text);
  assert.equal(parsed.subject, '数学');
  assert.equal(parsed.questionType, 'choice');
  assert.equal(parsed.confidence, 0.98);
  assert.equal(parsed.options.length, 4);
  assert.ok(parsed.question.includes('f(x)'));
});

test('demo provider streams the answer in small slices and honours abort', async (t) => {
  const provider = createProvider(loadConfig({ AI_DEMO: '1' }, makeRoot(t)));
  const messages = [
    { role: 'system', content: '[TASK:ANSWER] 请作答' },
    { role: 'user', content: '已知函数 f(x)=x^2-4x+3，求最小值。' },
  ];

  const collect = async (signal) => {
    const chunks = [];
    for await (const event of provider.streamChat({ messages, signal })) {
      assert.ok(event.type === 'delta' || event.type === 'usage', `unexpected event ${event.type}`);
      if (event.type === 'delta') chunks.push(event.text);
    }
    return chunks;
  };

  const chunks = await collect();
  assert.ok(chunks.length > 1, 'answer is streamed in multiple slices');
  assert.ok(Math.max(...chunks.map((chunk) => chunk.length)) <= 16);
  const text = chunks.join('');
  assert.match(text, /【答案】A/);
  assert.match(text, /【解析】/);
  assert.match(text, /演示模式/);

  const again = await collect();
  assert.equal(again.join(''), text, 'demo stream is deterministic');

  const controller = new AbortController();
  const partial = await Promise.race([
    (async () => {
      const received = [];
      for await (const event of provider.streamChat({ messages, signal: controller.signal })) {
        if (event.type === 'delta') received.push(event.text);
        controller.abort();
      }
      return received;
    })(),
    delay(800).then(() => 'timeout'),
  ]);
  assert.notEqual(partial, 'timeout', 'aborted demo stream finishes promptly');
  assert.ok(Array.isArray(partial));
});
