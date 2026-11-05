/**
 * 模型目录：各供应商的可用模型清单。
 *
 * 纯数据 + 纯函数，不依赖 Node 内置模块，渲染进程可直接 import，
 * 服务端与测试也能复用同一份清单。
 *
 * commandcode 清单 = GOAT 计划可用模型 ∩ Provider `/chat/completions` 端点模型
 * （claude-* 仅走 /messages，Jev* 为决策模型，均已排除）。
 */

/** @typedef {{ id: string, label: string, vendor: string, vision: boolean }} CatalogModel */

export const MODEL_CATALOG = Object.freeze({
  commandcode: Object.freeze({
    label: 'Command Code（GOAT）',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    models: Object.freeze([
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash (latest)', vendor: 'deepseek', vision: true },
      { id: 'deepseek/deepseek-v4-flash-fast', label: 'DeepSeek V4 Flash Fast', vendor: 'deepseek', vision: false },
      { id: 'deepseek/deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision (exp)', vendor: 'deepseek', vision: true },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro (latest)', vendor: 'deepseek', vision: false },
      { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash (latest)', vendor: 'deepseek', vision: true },
      { id: 'deepseek/deepseek-v4.1-flash-fast', label: 'DeepSeek V4.1 Flash Fast (latest)', vendor: 'deepseek', vision: true },
      { id: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash', vendor: 'google', vision: true },
      { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', vendor: 'google', vision: true },
      { id: 'inclusionai/ling-3.1-flash', label: 'Ling 3.1 Flash', vendor: 'inclusionai', vision: false },
      { id: 'inclusionai/ling-3.1-flash-1019', label: 'Ling 3.1 Flash 1019', vendor: 'inclusionai', vision: false },
      { id: 'meituan/LongCat-2.0', label: 'LongCat 2.0', vendor: 'meituan', vision: false },
      { id: 'meta/muse-spark-1.2', label: 'Muse Spark 1.2', vendor: 'meta', vision: false },
      { id: 'meta/muse-spark-1.2-contributor', label: 'Muse Spark 1.2 Contributor', vendor: 'meta', vision: false },
      { id: 'meta/muse-spark-1.3', label: 'Muse Spark 1.3', vendor: 'meta', vision: false },
      { id: 'meta/muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor', vendor: 'meta', vision: false },
      { id: 'meta/muse-spark-open', label: 'Muse Spark Open', vendor: 'meta', vision: false },
      { id: 'minimax/minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', vendor: 'minimax', vision: false },
      { id: 'MiniMaxAI/MiniMax-M2.5', label: 'MiniMax M2.5', vendor: 'MiniMaxAI', vision: false },
      { id: 'MiniMaxAI/MiniMax-M2.7', label: 'MiniMax M2.7', vendor: 'MiniMaxAI', vision: false },
      { id: 'MiniMaxAI/MiniMax-M3', label: 'MiniMax M3', vendor: 'MiniMaxAI', vision: false },
      { id: 'mistral/mistral-large-4', label: 'Mistral Large 4', vendor: 'mistral', vision: false },
      { id: 'moonshotai/Kimi-K2.5', label: 'Kimi K2.5', vendor: 'moonshotai', vision: false },
      { id: 'moonshotai/Kimi-K2.6', label: 'Kimi K2.6', vendor: 'moonshotai', vision: false },
      { id: 'moonshotai/Kimi-K2.7-Code', label: 'Kimi K2.7 Code', vendor: 'moonshotai', vision: false },
      { id: 'moonshotai/Kimi-K2.7-Code-Highspeed', label: 'Kimi K2.7 Code HighSpeed', vendor: 'moonshotai', vision: false },
      { id: 'moonshotai/Kimi-K3', label: 'Kimi K3', vendor: 'moonshotai', vision: false },
      { id: 'moonshotai/Kimi-K3.1-Pro', label: 'Kimi K3.1 Pro', vendor: 'moonshotai', vision: false },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra', vendor: 'nvidia', vision: false },
      { id: 'nvidia/nemotron-3.5-super-vl', label: 'Nemotron 3.5 Super VL', vendor: 'nvidia', vision: true },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', vendor: 'openai', vision: true },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', vendor: 'openai', vision: true },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', vendor: 'openai', vision: true },
      { id: 'ornith/ornith-1.5-122b', label: 'Ornith 1.5 122B', vendor: 'ornith', vision: false },
      { id: 'Qwen/Qwen3.6-Max-Preview', label: 'Qwen 3.6 Max Preview', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.6-Plus', label: 'Qwen 3.6 Plus', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.7-Flash', label: 'Qwen 3.7 Flash', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.7-Max', label: 'Qwen 3.7 Max', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.7-Plus', label: 'Qwen 3.7 Plus', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.8-27B', label: 'Qwen 3.8 27B', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.8-Flash', label: 'Qwen 3.8 Flash', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.8-Max', label: 'Qwen 3.8 Max', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.8-Max-0902', label: 'Qwen 3.8 Max 0902', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.8-Max-Prime', label: 'Qwen 3.8 Max Prime', vendor: 'Qwen', vision: false },
      { id: 'Qwen/Qwen3.8-Omni-Flash', label: 'Qwen 3.8 Omni Flash', vendor: 'Qwen', vision: true },
      { id: 'reflection/beam:free', label: 'Beam 1.0', vendor: 'reflection', vision: false },
      { id: 'stealth/crouton-alpha', label: 'Crouton Alpha', vendor: 'stealth', vision: false },
      { id: 'stealth/glyph-cluster:free', label: 'Glyph Cluster', vendor: 'stealth', vision: false },
      { id: 'stepfun/Step-3.5-Flash', label: 'Step 3.5 Flash', vendor: 'stepfun', vision: false },
      { id: 'stepfun/Step-3.7-Flash', label: 'Step 3.7 Flash', vendor: 'stepfun', vision: false },
      { id: 'stepfun/Step-5-Preview', label: 'Step 5 Preview', vendor: 'stepfun', vision: false },
      { id: 'tencent/hy3-paid', label: 'Tencent Hy3', vendor: 'tencent', vision: false },
      { id: 'tencent/hy4-preview', label: 'Tencent Hy4 Preview', vendor: 'tencent', vision: false },
      { id: 'thinkingmachines/inkling', label: 'Inkling', vendor: 'thinkingmachines', vision: false },
      { id: 'thinkingmachines/inkling-small', label: 'Inkling Small', vendor: 'thinkingmachines', vision: false },
      { id: 'xai/grok-4.5', label: 'Grok 4.5', vendor: 'xai', vision: false },
      { id: 'xai/grok-4.6', label: 'Grok 4.6', vendor: 'xai', vision: false },
      { id: 'xai/grok-4.7', label: 'Grok 4.7', vendor: 'xai', vision: false },
      { id: 'xiaomi/mimo-v2.6-flash', label: 'MiMo V2.6 Flash', vendor: 'xiaomi', vision: false },
      { id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo V2.6 Pro', vendor: 'xiaomi', vision: false },
      { id: 'xiaomi/mimo-v2.6-pro-ultraspeed', label: 'MiMo V2.6 Pro UltraSpeed', vendor: 'xiaomi', vision: false },
      { id: 'z-ai/glm-5.3-flash', label: 'GLM-5.3 Flash', vendor: 'z-ai', vision: false },
      { id: 'z-ai/glm-5.3-flashx', label: 'GLM-5.3 FlashX', vendor: 'z-ai', vision: false },
      { id: 'zai-org/GLM-5', label: 'GLM-5', vendor: 'zai-org', vision: false },
      { id: 'zai-org/GLM-5.1', label: 'GLM-5.1', vendor: 'zai-org', vision: false },
      { id: 'zai-org/GLM-5.2', label: 'GLM-5.2', vendor: 'zai-org', vision: false },
      { id: 'zai-org/GLM-5.2-Fast', label: 'GLM-5.2 Fast', vendor: 'zai-org', vision: false },
      { id: 'zai-org/GLM-5.3', label: 'GLM-5.3', vendor: 'zai-org', vision: false },
    ]),
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: Object.freeze([
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', vendor: 'deepseek', vision: true },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'deepseek', vision: false },
    ]),
  }),
  // 目录为空：自定义端点（OpenAI 兼容）仍由用户手输模型名。
  openai: Object.freeze({
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: Object.freeze([]),
  }),
});

/** 端点主机名 → 目录 key（顺序敏感：先匹配更具体的主机名）。 */
const HOST_MATCHERS = Object.freeze([
  Object.freeze({ key: 'commandcode', host: 'commandcode.ai' }),
  Object.freeze({ key: 'deepseek', host: 'api.deepseek.com' }),
  Object.freeze({ key: 'openai', host: 'api.openai.com' }),
]);

/** 模型 id → 目录条目，供标签 / 视觉查询用。 */
const MODELS_BY_ID = (() => {
  const map = new Map();
  for (const entry of Object.values(MODEL_CATALOG)) {
    for (const model of entry.models) if (!map.has(model.id)) map.set(model.id, model);
  }
  return map;
})();

function hostnameOf(baseUrl) {
  if (typeof baseUrl !== 'string') return '';
  const raw = baseUrl.trim();
  if (!raw) return '';
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      // 继续尝试下一种写法
    }
  }
  return '';
}

/**
 * 按接口地址找到内置模型目录。
 * @param {string} baseUrl
 * @returns {{ key: string, label: string, baseUrl: string, models: readonly CatalogModel[] } | null}
 */
export function catalogForBaseUrl(baseUrl) {
  const host = hostnameOf(baseUrl);
  if (!host) return null;
  for (const { key, host: suffix } of HOST_MATCHERS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      const entry = MODEL_CATALOG[key];
      return { key, label: entry.label, baseUrl: entry.baseUrl, models: entry.models };
    }
  }
  return null;
}

/**
 * 按接口地址取可选模型；未知端点返回空数组。
 * @param {string} baseUrl
 * @returns {readonly CatalogModel[]}
 */
export function modelsForBaseUrl(baseUrl) {
  return catalogForBaseUrl(baseUrl)?.models ?? [];
}

/**
 * 模型 id 的展示名；未知 id 原样返回。
 * @param {string} id
 */
export function modelLabel(id) {
  if (typeof id !== 'string' || !id) return typeof id === 'string' ? id : '';
  return MODELS_BY_ID.get(id)?.label ?? id;
}

/**
 * 模型是否支持图片输入；未知模型一律 false。
 * @param {string} id
 */
export function isVisionModel(id) {
  if (typeof id !== 'string' || !id) return false;
  return MODELS_BY_ID.get(id)?.vision === true;
}
