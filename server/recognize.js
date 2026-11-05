import { ProviderError } from './provider.js';

/**
 * Error thrown by the recognition pipeline.
 * code === 'PARSE'  -> upstream text contained no recoverable JSON object
 * code === 'EMPTY'  -> JSON was recoverable but contained no usable question
 */
export class RecognizeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RecognizeError';
    this.code = code;
  }
}

export const RECOGNIZE_SYSTEM_PROMPT = `[TASK:RECOGNIZE]
你是一个图片文字识别与题目结构化助手。用户会提供一张包含题目的图片（或截图）。
你的任务：

1. 逐字转录图片中出现的题目内容。不得解答、不得翻译、不得概括，也不要修正原文的错别字。
2. 保留原有的公式与符号：数学公式一律使用 LaTeX 并写成 $...$，例如 $f(x)=x^2-4x+3$；不要使用 \\(...\\) 或代码块。
3. 识别选择题的各个选项，拆分为 label 与 text 两部分，label 使用大写字母 A、B、C……
4. 判断学科 subject（如 数学、物理、化学、语文、英语、生物、历史、地理、政治；无法判断时填 "未知"）。
5. 判断题型 questionType，只能是以下四种之一：
   - "choice"：选择题
   - "blank"：填空题
   - "short"：简答/解答/计算题
   - "unknown"：无法判断
6. 给出 confidence，表示识别置信度，0 到 1 之间的小数。

输出要求：只输出一个 JSON 对象，不要使用 markdown 代码块，不要输出任何解释、前缀或后缀文字。
JSON 结构如下：

{"question":"题目原文","options":[{"label":"A","text":"选项内容"}],"subject":"数学","questionType":"choice","confidence":0.98}

字段说明：
- question：字符串，必填。图片中没有选项时，options 输出 []。
- options：数组，元素为 {label, text}；非选择题输出 []。
- subject：字符串，无法判断时填 "未知"。
- questionType："choice" | "blank" | "short" | "unknown"。
- confidence：数字，0 到 1。
- note：可选，仅在图片模糊、内容确实无法辨认时补充一句简短说明。

如果图片中没有可识别的题目，question 填空字符串，并在 note 中说明原因。`;

const RECOGNIZE_USER_TEXT = '请识别图片中的题目，按要求只输出 JSON。';

const REPAIR_INSTRUCTION =
  '上一次输出无法被解析。请重新输出，且只输出一个合法的 JSON 对象，' +
  '包含键 question、options、subject、questionType、confidence，不要包含 markdown 代码块或任何其他文字。';

const DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const QUESTION_TYPES = new Set(['choice', 'blank', 'short', 'unknown']);
const QUESTION_TYPE_ALIASES = new Map([
  ['choice', 'choice'],
  ['single_choice', 'choice'],
  ['singlechoice', 'choice'],
  ['multiple_choice', 'choice'],
  ['multiplechoice', 'choice'],
  ['select', 'choice'],
  ['选择题', 'choice'],
  ['单选', 'choice'],
  ['多选', 'choice'],
  ['blank', 'blank'],
  ['fill', 'blank'],
  ['fill_in', 'blank'],
  ['fill_blank', 'blank'],
  ['fillblank', 'blank'],
  ['填空', 'blank'],
  ['填空题', 'blank'],
  ['short', 'short'],
  ['short_answer', 'short'],
  ['shortanswer', 'short'],
  ['essay', 'short'],
  ['answer', 'short'],
  ['简答', 'short'],
  ['简答题', 'short'],
  ['解答', 'short'],
  ['解答题', 'short'],
  ['计算', 'short'],
  ['计算题', 'short'],
  ['unknown', 'unknown'],
  ['未知', 'unknown'],
]);

/**
 * Accepts only base64 data URLs for raster image formats the vision API supports.
 * SVG and other text formats are rejected on purpose.
 */
export function isSupportedImageDataUrl(value) {
  if (typeof value !== 'string') return false;
  const comma = value.indexOf(',');
  if (comma < 0) return false;
  const header = value.slice(0, comma);
  const payload = value.slice(comma + 1);
  if (!DATA_URL_PATTERN.test(header)) return false;
  if (payload.length === 0 || payload.length % 4 !== 0) return false;
  return BASE64_PATTERN.test(payload);
}

export function buildRecognizeMessages({ imageDataUrl } = {}) {
  if (typeof imageDataUrl !== 'string' || imageDataUrl.length === 0) {
    throw new TypeError('buildRecognizeMessages requires a non-empty imageDataUrl');
  }
  return [
    { role: 'system', content: RECOGNIZE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: RECOGNIZE_USER_TEXT },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

/* ---------------------------------------------------------------- parsing -- */

/** Escapes raw control characters that would otherwise make JSON.parse fail. */
function repairJson(source) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of source) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      const code = ch.codePointAt(0);
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** Returns every balanced top-level {...} snippet found in the text. */
function extractJsonObjects(text) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
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

function nextLabel(used) {
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    if (!used.has(letter)) return letter;
  }
  return '';
}

function normalizeOptions(value) {
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

  const used = new Set();
  const options = [];

  for (const item of items) {
    if (options.length >= 26) break;

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
      label = asText(item.label ?? item.key ?? item.letter ?? item.name ?? item.id ?? item.index);
      text = asText(item.text ?? item.value ?? item.content ?? item.option ?? item.answer ?? item.body);
      if (!text && label) {
        const split = splitLabeledOption(label);
        if (split && split.text) {
          label = split.label;
          text = split.text;
        }
      }
      if (!text && !label) continue;
    } else {
      continue;
    }

    label = label.toUpperCase();
    if (!/^[A-Z]$/.test(label)) {
      const split = splitLabeledOption(label || text);
      if (split) {
        label = split.label;
        text = split.text;
      } else if (label && !text) {
        text = label;
        label = '';
      } else {
        label = '';
      }
    } else if (!text) {
      // A bare label with no content carries no information.
      continue;
    }

    if (!text) continue;
    if (!label || used.has(label)) {
      if (label && used.has(label)) {
        const split = splitLabeledOption(text);
        if (split) text = split.text;
      }
      label = nextLabel(used);
      if (!label) break;
    }

    used.add(label);
    options.push({ label, text });
  }

  return options;
}

function normalizeQuestionType(value) {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value !== 'string' && typeof value !== 'number') return 'unknown';
  const key = String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (QUESTION_TYPES.has(key)) return key;
  return QUESTION_TYPE_ALIASES.get(key) || 'unknown';
}

function normalizeConfidence(value) {
  let n = value;
  if (typeof n === 'string') n = Number.parseFloat(n);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0.5;
  if (n > 1 && n <= 100) n /= 100;
  if (n > 1) n = 1;
  return n;
}

function pickQuestion(record) {
  const keys = ['question', 'questionText', 'question_text', 'text', 'title', '题目'];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeRecord(record) {
  const question = pickQuestion(record);
  if (!question) return null;

  const result = {
    question,
    options: normalizeOptions(record.options ?? record.choices ?? record.optionsList ?? record.选项),
    subject: asText(record.subject ?? record.学科) || '未知',
    questionType: normalizeQuestionType(record.questionType ?? record.question_type ?? record.type),
    confidence: normalizeConfidence(record.confidence),
  };

  const note = asText(record.note);
  if (note) result.note = note;

  return result;
}

/**
 * Tolerant parser for model output. Accepts fenced JSON, prose-wrapped JSON,
 * string options such as "A. -1", missing fields and extra keys.
 */
export function parseRecognizeOutput(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  const trimmed = text.trim();

  const candidates = [];
  if (trimmed) candidates.push(trimmed);
  for (const object of extractJsonObjects(text)) candidates.push(object);

  let sawObject = false;
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      try {
        parsed = JSON.parse(repairJson(candidate));
      } catch {
        continue;
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    sawObject = true;

    const normalized = normalizeRecord(parsed);
    if (normalized) return normalized;
  }

  if (sawObject) {
    throw new RecognizeError('EMPTY', '识别结果中缺少可用的题目内容');
  }
  throw new RecognizeError('PARSE', '无法从模型输出中解析出 JSON 对象');
}

/* -------------------------------------------------------------- recognize -- */

function isProviderParseError(error) {
  if (!(error instanceof ProviderError) && error?.name !== 'ProviderError') return false;
  return error.code === 'PARSE';
}

/**
 * Recognizes the question in an image. Provider is always injected; this module
 * performs no network I/O itself.
 */
export async function recognizeQuestion(input, context = {}) {
  const { imageDataUrl } = input ?? {};
  const { provider, signal } = context ?? {};

  if (!provider || typeof provider.chat !== 'function') {
    throw new TypeError('recognizeQuestion requires a provider with chat()');
  }
  if (!isSupportedImageDataUrl(imageDataUrl)) {
    throw new RecognizeError('EMPTY', '不支持的图片数据，仅支持 png/jpeg/webp/gif 的 base64 Data URL');
  }

  const baseMessages = buildRecognizeMessages({ imageDataUrl });
  let messages = baseMessages;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await provider.chat({
        messages,
        temperature: 0.1,
        maxTokens: 1200,
        signal,
      });
    } catch (error) {
      if (attempt === 0 && isProviderParseError(error)) {
        lastError = error;
        messages = [...baseMessages, { role: 'user', content: REPAIR_INSTRUCTION }];
        continue;
      }
      throw error;
    }

    const raw = typeof response?.text === 'string' ? response.text : '';
    try {
      const parsed = parseRecognizeOutput(raw);
      return { ...parsed, model: provider.visionModel || provider.model || '', raw };
    } catch (error) {
      if (attempt === 0 && error instanceof RecognizeError && error.code === 'PARSE') {
        lastError = error;
        messages = [...baseMessages, { role: 'user', content: REPAIR_INSTRUCTION }];
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new RecognizeError('PARSE', '识别失败');
}
