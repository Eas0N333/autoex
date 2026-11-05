import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { loadConfig } from '../server/config.js';
import { makeRoot } from './helpers/root.js';

test('defaults apply on an empty root and demo mode is on without a key', (t) => {
  const root = makeRoot(t);
  const config = loadConfig({}, root);

  assert.equal(config.root, root);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.demo, true);
  assert.equal(config.ai.apiKey, '');
  assert.equal(config.ai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.ai.model, 'gpt-4o-mini');
  assert.equal(config.ai.visionModel, 'gpt-4o-mini');
  assert.equal(config.ai.timeoutMs, 60_000);
  assert.equal(config.ai.maxRetries, 1);
  assert.deepEqual(config.ai.headers, {});
  assert.equal(config.limits.maxBodyBytes, 12 * 1024 * 1024);
  assert.equal(config.limits.maxImageBytes, 8 * 1024 * 1024);
  assert.equal(config.limits.maxQuestionChars, 8000);
  assert.equal(config.limits.maxOptions, 10);
  assert.equal(config.limits.ratePerMinute, 40);
  assert.equal(config.limits.answerCacheTtlMs, 600_000);
  assert.equal(config.limits.maxCacheEntries, 200);
});

test('config.json supplies values and a configured key leaves demo mode', (t) => {
  const root = makeRoot(t, {
    host: '0.0.0.0',
    port: 9100,
    ai: { apiKey: 'sk-file', model: 'file-model', visionModel: 'file-vision', baseUrl: 'http://file/v1/' },
    limits: { ratePerMinute: 7, maxOptions: 4 },
  });
  const config = loadConfig({}, root);

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 9100);
  assert.equal(config.demo, false);
  assert.equal(config.ai.apiKey, 'sk-file');
  assert.equal(config.ai.model, 'file-model');
  assert.equal(config.ai.visionModel, 'file-vision');
  assert.equal(config.ai.baseUrl, 'http://file/v1');
  assert.equal(config.limits.ratePerMinute, 7);
  assert.equal(config.limits.maxOptions, 4);
});

test('environment variables win over config.json', (t) => {
  const root = makeRoot(t, {
    port: 9100,
    ai: { apiKey: 'sk-file', model: 'file-model', timeoutMs: 1234 },
    limits: { maxImageBytes: 111 },
  });
  const config = loadConfig(
    {
      PORT: '9200',
      AI_API_KEY: 'sk-env',
      AI_MODEL: 'env-model',
      AI_TIMEOUT_MS: '5000',
      MAX_IMAGE_BYTES: '222',
    },
    root,
  );

  assert.equal(config.port, 9200);
  assert.equal(config.demo, false);
  assert.equal(config.ai.apiKey, 'sk-env');
  assert.equal(config.ai.model, 'env-model');
  assert.equal(config.ai.visionModel, 'env-model');
  assert.equal(config.ai.timeoutMs, 5000);
  assert.equal(config.limits.maxImageBytes, 222);
});

test('OPENAI_API_KEY is accepted as an alias and enables live mode', (t) => {
  const root = makeRoot(t);
  const config = loadConfig({ OPENAI_API_KEY: 'sk-openai' }, root);

  assert.equal(config.demo, false);
  assert.equal(config.ai.apiKey, 'sk-openai');
});

test('AI_DEMO=1 forces demo mode even when a key is present', (t) => {
  const root = makeRoot(t, { ai: { apiKey: 'sk-file' } });
  for (const flag of ['1', 'true']) {
    const config = loadConfig({ AI_API_KEY: 'sk-env', AI_DEMO: flag }, root);
    assert.equal(config.demo, true, `AI_DEMO=${flag}`);
    assert.equal(config.ai.apiKey, '');
  }
});

test('demo:true in config.json forces demo mode and blanks the key', (t) => {
  const root = makeRoot(t, { demo: true, ai: { apiKey: 'sk-file' } });
  const config = loadConfig({}, root);

  assert.equal(config.demo, true);
  assert.equal(config.ai.apiKey, '');
});

test('numeric environment values are coerced and invalid ones ignored', (t) => {
  const root = makeRoot(t);
  const config = loadConfig(
    {
      AI_API_KEY: 'sk',
      PORT: 'abc',
      AI_TIMEOUT_MS: '4500',
      MAX_BODY_BYTES: '2048',
      RATE_PER_MINUTE: '-3',
    },
    root,
  );

  assert.equal(config.port, 8787, 'non-numeric PORT falls back to default');
  assert.equal(config.ai.timeoutMs, 4500);
  assert.equal(config.limits.maxBodyBytes, 2048);
  assert.equal(config.limits.ratePerMinute, 40, 'non-positive rate falls back to default');
});

test('baseUrl loses trailing slashes and custom headers are preserved', (t) => {
  const root = makeRoot(t, { ai: { headers: { 'X-Tenant': 'acme' } } });
  const config = loadConfig({ AI_API_KEY: 'sk', AI_BASE_URL: 'http://localhost:9999/v1///' }, root);

  assert.equal(config.ai.baseUrl, 'http://localhost:9999/v1');
  assert.equal(config.ai.headers['X-Tenant'], 'acme');
});

test('invalid config.json is reported, not silently ignored', (t) => {
  const root = makeRoot(t, undefined);
  rmSync(`${root}/config.json`, { force: true });
  writeFileSync(`${root}/config.json`, '{ not json');

  assert.throws(() => loadConfig({}, root), /config\.json/i);
});
