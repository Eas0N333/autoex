/**
 * Multi-model cross-check pipeline.
 *
 * One question is answered independently by 2–5 candidate models (non-streaming,
 * in parallel); a judge model then compares the labelled answers, verifies every
 * step and streams the final answer. This module owns prompts, parallel fan-out
 * and the judge fallback; providers are always injected, so it performs no
 * network I/O of its own and never sees an API key.
 *
 * Public surface (see docs/CONTRACT-ENSEMBLE.md §3):
 *   CANDIDATE_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT,
 *   buildCandidateMessages(), buildJudgeMessages(), ensembleAnswer()
 */

export const CANDIDATE_SYSTEM_PROMPT = `[TASK:ANSWER]
你是一位严谨、耐心的中文答题老师，这一次需要你独立完成用户提交的题目。

独立作答要求：
- 只依据题目与给出的选项作答，不得假设、引用、等待或提及任何其他模型、老师或“参考答案”。
- 不得编造题目中不存在的选项、条件或数据。
- 选择题必须写出所选选项的字母与内容，例如：【答案】A（-1）。
- 第一行以【答案】开头，直接给出结论；空一行后以【解析】开头，说明推理过程。
- 如果题目信息不完整、图片内容残缺或条件互相矛盾，不要猜测答案，直接在【答案】中说明缺少哪些信息，并在【解析】中说明需要补充什么。
- 公式使用 LaTeX，行内写作 $...$（例如 $x^2-4x+3$）；不要使用 \\(...\\)，也不要用代码块包裹公式。
- 不要输出 JSON，不要重复题目原文，不要输出与题目无关的客套话。
- 使用简体中文作答。`;

export const JUDGE_SYSTEM_PROMPT = `[TASK:JUDGE]
你是一位资深阅卷老师，负责交叉核对多份相互独立的作答，并给出最终答案。

核对要求：
1. 逐份核对（模型 A、模型 B、模型 C……）：独立验证每一步推导是否正确，不投票，也不参考模型名气、篇幅或措辞。
2. 明确指出每份答案中的错误步骤、跳步或不严谨之处；若答案互相冲突，说明取舍理由。
3. 综合各答案中正确的步骤，给出你自己的最终答案；选择题必须给出选项字母。
4. 不得编造题目中不存在的条件或选项；信息不足时说明缺少哪些信息，不要猜测。

输出格式（必须严格遵守）：
- 第一行以【答案】开头，给出最终结论，例如：【答案】A（-1）。
- 空一行后以【解析】开头，说明核对过程、各答案存在的问题与取舍理由。
- 最后一行以【一致性】开头，只允许两种写法：
  【一致性】一致
  【一致性】存在分歧（简述分歧点）
- 公式使用 LaTeX，行内写作 $...$；不要使用代码块包裹公式。
- 不要输出 JSON，不要重复题目原文，使用简体中文作答。`;

const STYLE_INSTRUCTIONS = {
  concise: '简洁模式：解析控制在 120 字以内，只给关键步骤与结论，不展开推导。',
  detailed:
    '详细模式：给出完整推理过程，分段说明每一步的依据与结果，并在最后一行用【易错点】指出一个常见错误。',
  step: '逐步讲解模式：用编号步骤（1. 2. 3. …）逐步推导，每步写明理由与中间结果，并在最后一行用【易错点】指出一个常见错误。',
};

const DEFAULT_LIMITS = {
  maxQuestionChars: 8000,
  maxOptions: 10,
};

const ANSWER_TEXT_LIMIT = 6000;

function truncate(text, max) {
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return text;
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function splitLabeledOption(value) {
  const match = /^(?:\(([A-Za-z])\)|（([A-Za-z])）|\[([A-Za-z])\]|([A-Za-z])\s*[.、．:：])\s*([\s\S]*)$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const label = (match[1] || match[2] || match[3] || match[4] || '').toUpperCase();
  return { label, text: match[5].trim() };
}

/** Tolerates the shapes an API caller may send: [{label,text}], ["A. …"] or an object map. */
function normalizeOptions(value, maxOptions) {
  if (value === null || value === undefined) return [];

  let items;
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    items = lines.length > 1 ? lines : [text];
  } else if (typeof value === 'object') {
    items = Object.entries(value).map(([label, text]) => ({ label, text }));
  } else {
    return [];
  }

  const limit = Number.isFinite(maxOptions) && maxOptions > 0 ? Math.min(Math.floor(maxOptions), 26) : DEFAULT_LIMITS.maxOptions;
  const options = [];

  for (const item of items) {
    if (options.length >= limit) break;

    let label = '';
    let text = '';

    if (typeof item === 'string' || typeof item === 'number') {
      const raw = asText(item);
      if (!raw) continue;
      const split = splitLabeledOption(raw);
      if (split) {
        label = split.label;
        text = split.text;
      } else {
        text = raw;
      }
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      label = asText(item.label ?? item.key ?? item.letter);
      text = asText(item.text ?? item.value ?? item.content ?? item.option);
    } else {
      continue;
    }

    if (!text) continue;
    label = label.toUpperCase();
    if (!/^[A-Z]$/.test(label)) label = String.fromCharCode(65 + options.length);
    options.push({ label, text });
  }

  return options;
}

function normalizeStyle(value) {
  return typeof value === 'string' && Object.hasOwn(STYLE_INSTRUCTIONS, value) ? value : 'concise';
}

/**
 * Builds the independent-answer messages for one candidate model.
 * `options.limits` (optional) carries maxQuestionChars / maxOptions.
 */
export function buildCandidateMessages(input = {}, buildOptions = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const limits = { ...DEFAULT_LIMITS, ...(buildOptions?.limits ?? {}) };

  const question = truncate(asText(source.question), limits.maxQuestionChars);
  const options = normalizeOptions(source.options, limits.maxOptions);
  const subject = asText(source.subject);
  const style = normalizeStyle(source.style);

  const lines = [question ? `题目：${question}` : '题目：（用户未提供题目内容）'];
  if (options.length > 0) {
    lines.push('选项：');
    for (const option of options) lines.push(`${option.label}. ${option.text}`);
  }
  if (subject) lines.push(`学科：${subject}`);
  lines.push(`作答要求：${STYLE_INSTRUCTIONS[style]}`);
  lines.push('请独立作答：不要提及或假设其他模型的答案。');

  return [
    { role: 'system', content: CANDIDATE_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * Builds the judge messages: the untouched question/options plus every produced
 * answer labelled `模型 A/B/C` together with its model name.
 */
export function buildJudgeMessages(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const limits = { ...DEFAULT_LIMITS, ...(source.limits ?? {}) };

  const question = truncate(asText(source.question), limits.maxQuestionChars);
  const options = normalizeOptions(source.options, limits.maxOptions);
  const subject = asText(source.subject);
  const style = normalizeStyle(source.style);
  const answers = Array.isArray(source.answers) ? source.answers : [];

  const lines = [question ? `题目：${question}` : '题目：（用户未提供题目内容）'];
  if (options.length > 0) {
    lines.push('选项：');
    for (const option of options) lines.push(`${option.label}. ${option.text}`);
  }
  if (subject) lines.push(`学科：${subject}`);
  lines.push(`作答风格：${style}`);
  lines.push('');
  lines.push(`以下是 ${answers.length} 份相互独立的作答，请逐份核对：`);

  for (const answer of answers) {
    const name = asText(answer?.name) || '模型';
    const model = asText(answer?.model) || '未标注模型';
    const text = truncate(asText(answer?.text), ANSWER_TEXT_LIMIT) || '（该模型未给出有效作答）';
    lines.push('');
    lines.push(`【${name}｜${model}】`);
    lines.push(text);
  }

  lines.push('');
  lines.push('请按系统要求输出最终答案，并在最后一行给出【一致性】结论。');

  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** FIFO bridge between settlement callbacks and the async generator. */
function createEventQueue() {
  const items = [];
  const waiters = [];
  let closed = false;

  return {
    push(item) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else items.push(item);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return() {
          closed = true;
          items.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function errorCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  if (error?.name === 'AbortError') return 'ABORTED';
  return 'UPSTREAM';
}

/**
 * Runs every candidate in parallel and yields `candidate` events as they settle,
 * then the judge stream (`delta`/`usage`), then one `done` event.
 *
 * `candidates` items: { index, name, model, temperature, provider }
 * `judge`: { name, model, temperature, provider }
 * `limits.timeoutMs` bounds each candidate request in addition to its provider
 * timeout. On judge failure the first successful answer is used verbatim,
 * `fallback` is set and `judge.status` is 'error' — this never throws. When every
 * candidate fails the function throws an error with code 'ENSEMBLE_FAILED'.
 */
export async function* ensembleAnswer(input, context = {}) {
  const { candidates, judge, signal, limits = {} } = context ?? {};
  const participants = Array.isArray(candidates) ? candidates : [];

  if (!judge || typeof judge.provider?.streamChat !== 'function') {
    throw new TypeError('ensembleAnswer requires a judge with a streamChat() provider');
  }
  if (participants.length === 0) {
    const error = new Error('没有可用的候选模型');
    error.code = 'ENSEMBLE_FAILED';
    throw error;
  }

  const timeoutMs =
    Number.isFinite(limits?.timeoutMs) && limits.timeoutMs > 0 ? limits.timeoutMs : 0;
  const messages = buildCandidateMessages(input, { limits });
  const queue = createEventQueue();
  const results = new Array(participants.length).fill(null);
  const controllers = [];
  let pending = participants.length;

  participants.forEach((participant, position) => {
    queue.push({
      type: 'candidate',
      index: participant.index ?? position,
      name: participant.name,
      model: participant.model,
      status: 'running',
    });
  });

  participants.forEach((participant, position) => {
    const controller = new AbortController();
    controllers.push(controller);
    const signals = [controller.signal];
    if (signal) signals.push(signal);
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    const attemptSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const startedAt = Date.now();

    Promise.resolve()
      .then(() =>
        participant.provider.chat({
          messages,
          temperature: participant.temperature,
          maxTokens: 1800,
          signal: attemptSignal,
        }),
      )
      .then((response) => {
        const text = typeof response?.text === 'string' ? response.text.trim() : '';
        if (text === '') throw new Error('候选模型返回了空答案');
        results[position] = {
          ok: true,
          text,
          usage: response?.usage ?? null,
          durationMs: Date.now() - startedAt,
        };
      })
      .catch((error) => {
        results[position] = { ok: false, error, durationMs: Date.now() - startedAt };
      })
      .finally(() => {
        const result = results[position];
        const index = participant.index ?? position;
        const base = {
          type: 'candidate',
          index,
          name: participant.name,
          model: participant.model,
        };
        if (result.ok) {
          queue.push({
            ...base,
            status: 'done',
            text: result.text,
            durationMs: result.durationMs,
            ...(result.usage ? { usage: result.usage } : {}),
          });
        } else {
          queue.push({
            ...base,
            status: 'error',
            error: errorCode(result.error),
            durationMs: result.durationMs,
          });
        }
        pending -= 1;
        if (pending === 0) queue.close();
      });
  });

  try {
    for await (const event of queue) {
      yield event;
    }
  } finally {
    // Also covers the caller stopping early (HTTP client gone): cancel every slot.
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort();
    }
  }

  const survivors = [];
  for (let position = 0; position < participants.length; position += 1) {
    const result = results[position];
    if (result?.ok) survivors.push({ participant: participants[position], result });
  }

  if (survivors.length === 0) {
    const error = new Error('所有候选模型均未能给出有效答案');
    error.code = 'ENSEMBLE_FAILED';
    throw error;
  }

  const judgeMessages = buildJudgeMessages({
    ...input,
    limits,
    answers: survivors.map(({ participant, result }) => ({
      name: participant.name,
      model: participant.model,
      text: result.text,
    })),
  });

  let judgeStatus = 'done';
  let judgeError;
  let fallback = false;
  let judgeText = '';
  let judgeUsage = null;

  try {
    for await (const chunk of judge.provider.streamChat({
      messages: judgeMessages,
      temperature: judge.temperature,
      maxTokens: 2200,
      signal,
    })) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        judgeText += chunk.text;
        yield { type: 'delta', text: chunk.text };
      } else if (chunk.type === 'usage' && chunk.usage) {
        judgeUsage = chunk.usage;
        yield { type: 'usage', usage: chunk.usage };
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    judgeStatus = 'error';
    judgeError = errorCode(error);
    fallback = true;
    judgeText = survivors[0].result.text;
    judgeUsage = null;
    yield { type: 'delta', text: judgeText };
  }

  if (signal?.aborted) {
    const error = new Error('请求已取消');
    error.code = 'ABORTED';
    throw error;
  }

  const candidateSummaries = participants.map((participant, position) => {
    const result = results[position];
    const summary = {
      index: participant.index ?? position,
      name: participant.name,
      model: participant.model,
      status: result?.ok ? 'done' : 'error',
      durationMs: result?.durationMs ?? 0,
    };
    if (result?.ok) summary.text = result.text;
    else summary.error = errorCode(result?.error);
    return summary;
  });

  yield {
    type: 'done',
    text: judgeText,
    candidates: candidateSummaries,
    judge: {
      name: judge.name,
      model: judge.model,
      status: judgeStatus,
      ...(judgeError ? { error: judgeError } : {}),
    },
    fallback,
    usage: judgeUsage,
  };
}
