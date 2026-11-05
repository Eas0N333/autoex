/**
 * Answer pipeline: turns a normalized question into streamed tutor output.
 * The provider is always injected; this module performs no network I/O itself.
 */

export const ANSWER_SYSTEM_PROMPT = `[TASK:ANSWER]
你是一位耐心、严谨的中文答题老师，负责讲解用户提交的题目。

输出格式（必须严格遵守）：
1. 第一行以【答案】开头，直接给出结论。选择题必须写出所选选项的字母与内容，例如：【答案】A（-1）。
2. 空一行后以【解析】开头，说明推理过程。
3. 如果用户要求逐步讲解，使用编号步骤（1. 2. 3. …）展开推导。

作答规则：
- 只依据题目与给出的选项作答，不得编造题目中不存在的选项或条件。
- 如果题目信息不完整、图片内容残缺或条件互相矛盾，不要猜测答案，直接在【答案】中说明缺少哪些信息，并在【解析】中说明需要补充什么。
- 公式使用 LaTeX，行内写作 $...$（例如 $x^2-4x+3$）；不要使用 \\(...\\)，也不要用代码块包裹公式。
- 不要输出 JSON，不要重复题目原文，不要输出与题目无关的客套话。
- 使用简体中文作答。`;

const STYLE_INSTRUCTIONS = {
  concise: '简洁模式：解析控制在 120 字以内，只给关键步骤与结论，不展开推导。',
  detailed:
    '详细模式：给出完整推理过程，分段说明每一步的依据与结果，并在最后一行用【易错点】指出一个常见错误。',
  step: '逐步讲解模式：用编号步骤（1. 2. 3. …）逐步推导，每步写明理由与中间结果，并在最后一行用【易错点】指出一个常见错误。',
};

const STYLES = new Set(Object.keys(STYLE_INSTRUCTIONS));

const DEFAULT_LIMITS = {
  maxQuestionChars: 8000,
  maxOptions: 10,
};

function truncate(text, max) {
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return text;
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  // Never leave a dangling high surrogate behind.
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

  const options = [];
  for (const item of items) {
    if (options.length >= maxOptions) break;

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
      label = asText(item.label ?? item.key ?? item.letter ?? item.name);
      text = asText(item.text ?? item.value ?? item.content ?? item.option);
      if (!text && label) {
        const split = splitLabeledOption(label);
        if (split && split.text) {
          label = split.label;
          text = split.text;
        }
      }
    } else {
      continue;
    }

    if (!text) continue;
    label = label.toUpperCase();
    if (!/^[A-Z]$/.test(label)) {
      const split = splitLabeledOption(text);
      label = split ? split.label : String.fromCharCode(65 + options.length);
      if (split) text = split.text;
    }
    if (!text) continue;
    options.push({ label, text });
  }

  return options;
}

function normalizeStyle(value) {
  return typeof value === 'string' && STYLES.has(value) ? value : 'concise';
}

/**
 * Builds the OpenAI-style messages for the answer model.
 * `options.limits` (optional) carries maxQuestionChars / maxOptions.
 */
export function buildAnswerMessages(input = {}, buildOptions = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const limits = { ...DEFAULT_LIMITS, ...(buildOptions?.limits ?? {}) };

  const question = truncate(asText(source.question), limits.maxQuestionChars);
  const maxOptions =
    typeof limits.maxOptions === 'number' && limits.maxOptions > 0
      ? Math.min(Math.floor(limits.maxOptions), 26) // at most A-Z labels
      : DEFAULT_LIMITS.maxOptions;
  const options = normalizeOptions(source.options, maxOptions);
  const subject = asText(source.subject);
  const style = normalizeStyle(source.style);

  const lines = [];
  if (question) {
    lines.push(`题目：${question}`);
  } else {
    lines.push('题目：（用户未提供题目内容）');
  }

  if (options.length > 0) {
    lines.push('选项：');
    for (const option of options) {
      lines.push(`${option.label}. ${option.text}`);
    }
  }

  if (subject) lines.push(`学科：${subject}`);
  lines.push(`作答要求：${STYLE_INSTRUCTIONS[style]}`);

  return [
    { role: 'system', content: ANSWER_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * Streams the tutor answer. Deltas and usage events from the provider are
 * passed through unchanged.
 */
export async function* answerStream(input, context = {}) {
  const { provider, signal, limits } = context ?? {};
  if (!provider || typeof provider.streamChat !== 'function') {
    throw new TypeError('answerStream requires a provider with streamChat()');
  }

  const messages = buildAnswerMessages(input, { limits });

  for await (const chunk of provider.streamChat({
    messages,
    temperature: 0.2,
    maxTokens: 1800,
    signal,
  })) {
    yield chunk;
  }
}
