import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_CATALOG,
  catalogForBaseUrl,
  isVisionModel,
  modelLabel,
  modelsForBaseUrl,
} from '../electron/model-catalog.js';

const commandCodeModels = MODEL_CATALOG.commandcode.models;
const ids = commandCodeModels.map((m) => m.id);
const byId = new Map(commandCodeModels.map((m) => [m.id, m]));

test('Command Code 目录包含 GOAT 计划里全部可走 chat/completions 的 67 个模型', () => {
  assert.equal(commandCodeModels.length, 67);
  assert.equal(new Set(ids).size, ids.length, '模型 id 不能重复');
  assert.equal(MODEL_CATALOG.commandcode.label, 'Command Code（GOAT）');
  assert.equal(MODEL_CATALOG.commandcode.baseUrl, 'https://api.commandcode.ai/provider/v1');
});

test('Command Code 目录排除 /messages 的 claude 与决策模型 Jev', () => {
  for (const id of ids) {
    assert.doesNotMatch(id, /claude/i, `不应出现 claude 模型：${id}`);
    assert.doesNotMatch(id, /(^|\/)jev/i, `不应出现 Jev 模型：${id}`);
  }
});

test('Command Code 模型 id 只含接口安全字符，且元数据齐全', () => {
  for (const model of commandCodeModels) {
    assert.match(model.id, /^[A-Za-z0-9._:@/+-]+$/, `非法 id：${model.id}`);
    assert.ok(model.label.length > 0, `缺少 label：${model.id}`);
    assert.ok(model.vendor.length > 0, `缺少 vendor：${model.id}`);
    assert.equal(typeof model.vision, 'boolean');
    if (model.id.includes('/')) assert.equal(model.vendor, model.id.split('/')[0]);
  }
});

test('Command Code 目录按 vendor 再按 label 排序', () => {
  const sortKey = (m) => `${m.vendor.toLowerCase()}\u0000${m.label.toLowerCase()}\u0000${m.id.toLowerCase()}`;
  const sorted = [...commandCodeModels].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  assert.deepEqual(
    commandCodeModels.map((m) => m.id),
    sorted.map((m) => m.id),
  );
});

test('关键候选模型都在目录里，视觉标记正确', () => {
  for (const id of ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro', 'google/gemini-3.8-flash']) {
    assert.ok(byId.has(id), `缺少模型：${id}`);
  }
  assert.equal(byId.get('deepseek/deepseek-v4.1-flash').vision, true);
  assert.equal(byId.get('deepseek/deepseek-v4-pro').vision, false);
  assert.equal(byId.get('google/gemini-3.8-flash').vision, true);
  assert.equal(byId.get('gpt-6-luna').vision, true);
  assert.equal(byId.get('moonshotai/Kimi-K3').vision, false);
});

test('DeepSeek 官方目录与 OpenAI 占位目录', () => {
  const deepseek = MODEL_CATALOG.deepseek;
  assert.equal(deepseek.label, 'DeepSeek 官方');
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
  assert.deepEqual(
    deepseek.models.map((m) => ({ id: m.id, label: m.label, vision: m.vision })),
    [
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', vision: true },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', vision: false },
    ],
  );
  assert.deepEqual(MODEL_CATALOG.openai.models, []);
});

test('catalogForBaseUrl 识别内置端点，自定义端点返回 null', () => {
  const cc = catalogForBaseUrl('https://api.commandcode.ai/provider/v1');
  assert.equal(cc.key, 'commandcode');
  assert.equal(cc.label, 'Command Code（GOAT）');
  assert.equal(cc.baseUrl, 'https://api.commandcode.ai/provider/v1');
  assert.equal(cc.models, MODEL_CATALOG.commandcode.models);

  assert.equal(catalogForBaseUrl('https://api.commandcode.ai/provider/v1/').key, 'commandcode');
  assert.equal(catalogForBaseUrl('https://api.commandcode.ai').key, 'commandcode');
  assert.equal(catalogForBaseUrl('  https://api.commandcode.ai/provider/v1  ').key, 'commandcode');

  const ds = catalogForBaseUrl('https://api.deepseek.com');
  assert.equal(ds.key, 'deepseek');
  assert.equal(ds.models, MODEL_CATALOG.deepseek.models);
  assert.equal(catalogForBaseUrl('https://api.deepseek.com/v1/').key, 'deepseek');

  assert.equal(catalogForBaseUrl('https://api.openai.com/v1').key, 'openai');

  assert.equal(catalogForBaseUrl('https://my-proxy.example.com/v1'), null);
  assert.equal(catalogForBaseUrl('http://127.0.0.1:8787/v1'), null);
  assert.equal(catalogForBaseUrl(''), null);
  assert.equal(catalogForBaseUrl(undefined), null);
  assert.equal(catalogForBaseUrl(null), null);
});

test('modelsForBaseUrl 未知端点回退为空数组，不返回 null', () => {
  assert.deepEqual(modelsForBaseUrl('https://my-proxy.example.com/v1'), []);
  assert.equal(modelsForBaseUrl('https://api.commandcode.ai/provider/v1').length, 67);
  assert.equal(modelsForBaseUrl('https://api.deepseek.com').length, 2);
});

test('modelLabel 返回内置展示名，未知 id 原样返回', () => {
  assert.equal(modelLabel('deepseek/deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash (latest)');
  assert.equal(modelLabel('deepseek-flash'), 'DeepSeek V4.1 Flash');
  assert.equal(modelLabel('my-own/model-1'), 'my-own/model-1');
  assert.equal(modelLabel(''), '');
  assert.equal(modelLabel(undefined), '');
});

test('isVisionModel 只认内置视觉模型，未知模型一律 false', () => {
  assert.equal(isVisionModel('deepseek/deepseek-v4.1-flash'), true);
  assert.equal(isVisionModel('deepseek-flash'), true);
  assert.equal(isVisionModel('deepseek/deepseek-v4-pro'), false);
  assert.equal(isVisionModel('deepseek-v4-pro'), false);
  assert.equal(isVisionModel('my-own/model-1'), false);
  assert.equal(isVisionModel(''), false);
  assert.equal(isVisionModel(undefined), false);
});
