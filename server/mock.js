/**
 * Deterministic demo provider used when no API key is configured.
 *
 * Output is selected by the task markers that recognize.js / answer.js place at
 * the start of their system prompts, so the demo path needs no network access.
 */

export const TASK_RECOGNIZE = '[TASK:RECOGNIZE]';
export const TASK_ANSWER = '[TASK:ANSWER]';
export const TASK_JUDGE = '[TASK:JUDGE]';

export const DEMO_RECOGNIZE_JSON =
  '{"question":"已知函数 f(x)=x^2-4x+3，求 f(x) 的最小值。","options":[{"label":"A","text":"-1"},{"label":"B","text":"0"},{"label":"C","text":"1"},{"label":"D","text":"3"}],"subject":"数学","questionType":"choice","confidence":0.98}';

export const DEMO_ANSWER_TEXT = [
  '【答案】A（-1）',
  '',
  '【解析】f(x)=x²-4x+3=(x-2)²-1，故顶点为 (2, -1)，最小值 -1。',
  '- 配方后平方项 ≥ 0，取等时 x=2。',
  '- 对照选项，只有 A 与 -1 相符。',
  '',
  '（演示模式：未配置 API Key，以上为内置示例回答。）',
].join('\n');

const DEMO_FALLBACK_TEXT = '（演示模式：未配置 API Key，暂无可用的模型输出。）';

export const DEMO_JUDGE_TEXT = `${DEMO_ANSWER_TEXT}\n\n【一致性】一致（演示模式）`;

const CHUNK_SIZE = 8;
const CHUNK_DELAY_MS = 12;

/** Plain text of a chat message content (string or OpenAI content parts). */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (typeof part?.text === 'string') text += part.text;
  }
  return text;
}

function systemPromptOf(messages) {
  if (!Array.isArray(messages)) return '';
  for (const message of messages) {
    if (message?.role === 'system') return contentText(message.content);
  }
  return '';
}

/** Pick the canned reply for a message list; deterministic and total. */
export function demoReplyText(messages) {
  const system = systemPromptOf(messages);
  if (system.includes(TASK_RECOGNIZE)) return DEMO_RECOGNIZE_JSON;
  if (system.includes(TASK_JUDGE)) return DEMO_JUDGE_TEXT;
  if (system.includes(TASK_ANSWER)) return DEMO_ANSWER_TEXT;
  return DEMO_FALLBACK_TEXT;
}

function countChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) total += contentText(message?.content).length;
  return total;
}

function estimateUsage(messages, reply) {
  const promptTokens = Math.ceil(countChars(messages) / 4);
  const completionTokens = Math.ceil(reply.length / 2);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/** Resolve after `ms`, or immediately when the signal aborts. Never rejects. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

export function createMockProvider(config = {}) {
  const model = 'demo-chat';
  const visionModel = 'demo-vision';

  // Never throws: the demo path must stay usable even with malformed input.
  async function chat({ messages } = {}) {
    try {
      const text = demoReplyText(messages);
      return { text, usage: estimateUsage(messages, text) };
    } catch {
      return { text: DEMO_FALLBACK_TEXT, usage: null };
    }
  }

  async function* streamChat({ messages, signal } = {}) {
    let text;
    try {
      text = demoReplyText(messages);
    } catch {
      text = DEMO_FALLBACK_TEXT;
    }

    const characters = Array.from(text);
    for (let offset = 0; offset < characters.length; offset += CHUNK_SIZE) {
      if (signal?.aborted) return;
      await pause(CHUNK_DELAY_MS, signal);
      if (signal?.aborted) return;
      yield { type: 'delta', text: characters.slice(offset, offset + CHUNK_SIZE).join('') };
    }
    if (signal?.aborted) return;
    try {
      yield { type: 'usage', usage: estimateUsage(messages, text) };
    } catch {
      // Ignore: usage is cosmetic in demo mode.
    }
  }

  return { kind: 'demo', model, visionModel, chat, streamChat };
}
