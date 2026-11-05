import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerMessages,
} from '../server/answer.js';
import {
  RECOGNIZE_SYSTEM_PROMPT,
  RecognizeError,
  buildRecognizeMessages,
  isSupportedImageDataUrl,
  parseRecognizeOutput,
} from '../server/recognize.js';

const VALID_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DEMO_PAYLOAD = {
  question: '已知函数 f(x)=x^2-4x+3，求 f(x) 的最小值。',
  options: [
    { label: 'A', text: '-1' },
    { label: 'B', text: '0' },
    { label: 'C', text: '1' },
    { label: 'D', text: '3' },
  ],
  subject: '数学',
  questionType: 'choice',
  confidence: 0.98,
};

function parseJson(raw) {
  return parseRecognizeOutput(raw);
}

test('system prompts carry the demo markers and answer format', () => {
  assert.ok(RECOGNIZE_SYSTEM_PROMPT.startsWith('[TASK:RECOGNIZE]'));
  assert.ok(ANSWER_SYSTEM_PROMPT.startsWith('[TASK:ANSWER]'));
  assert.match(ANSWER_SYSTEM_PROMPT, /【答案】/);
  assert.match(ANSWER_SYSTEM_PROMPT, /【解析】/);
});

test('parseRecognizeOutput accepts plain JSON', () => {
  const parsed = parseJson(JSON.stringify(DEMO_PAYLOAD));

  assert.equal(parsed.question, DEMO_PAYLOAD.question);
  assert.deepEqual(parsed.options, DEMO_PAYLOAD.options);
  assert.equal(parsed.subject, '数学');
  assert.equal(parsed.questionType, 'choice');
  assert.equal(parsed.confidence, 0.98);
});

test('parseRecognizeOutput unwraps ```json fences and surrounding prose', () => {
  const fenced = `\`\`\`json\n${JSON.stringify(DEMO_PAYLOAD, null, 2)}\n\`\`\``;
  const prose = `好的，识别结果如下：\n${JSON.stringify(DEMO_PAYLOAD)}\n以上是题目内容，请核对。`;

  assert.equal(parseJson(fenced).question, DEMO_PAYLOAD.question);
  assert.equal(parseJson(prose).question, DEMO_PAYLOAD.question);
  assert.equal(parseJson(`  \n${JSON.stringify(DEMO_PAYLOAD)}\n  `).options.length, 4);
});

test('parseRecognizeOutput normalizes string options and uppercase labels', () => {
  const parsed = parseJson(
    JSON.stringify({
      question: '下列哪项正确？',
      options: ['A. 甲', 'B. 乙', 'C. 丙'],
    }),
  );

  assert.deepEqual(parsed.options, [
    { label: 'A', text: '甲' },
    { label: 'B', text: '乙' },
    { label: 'C', text: '丙' },
  ]);

  const lowercase = parseJson(
    JSON.stringify({ question: '选一个', options: [{ label: 'a', text: '甲' }, { label: 'b', text: '乙' }] }),
  );
  assert.deepEqual(lowercase.options.map((option) => option.label), ['A', 'B']);
});

test('parseRecognizeOutput fills missing subject, options, type and confidence', () => {
  const parsed = parseJson(JSON.stringify({ question: '请证明勾股定理。' }));

  assert.equal(parsed.question, '请证明勾股定理。');
  assert.deepEqual(parsed.options, []);
  assert.equal(parsed.subject, '未知');
  assert.equal(parsed.confidence, 0.5);
  assert.equal(parsed.questionType, 'unknown');
});

test('parseRecognizeOutput keeps LaTeX and multi-line questions verbatim', () => {
  const question = '已知 $\\int_0^1 x^2 \\, dx = \\frac{1}{3}$，\n求 $\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$。';
  const parsed = parseJson(JSON.stringify({ question, subject: '数学', questionType: 'short' }));

  assert.equal(parsed.question, question);
  assert.equal(parsed.questionType, 'short');
});

test('parseRecognizeOutput rejects output without a usable question', () => {
  for (const raw of ['not json at all', '{"foo":1}', '{"question":""}', '{"question":null}', '']) {
    assert.throws(
      () => parseJson(raw),
      (error) => {
        assert.ok(error instanceof RecognizeError, `expected RecognizeError for ${raw}`);
        assert.equal(error.name, 'RecognizeError');
        assert.ok(['PARSE', 'EMPTY'].includes(error.code), `unexpected code ${error.code}`);
        assert.equal(typeof error.message, 'string');
        assert.ok(error.message.length > 0);
        return true;
      },
      `expected a throw for ${JSON.stringify(raw)}`,
    );
  }
});

test('isSupportedImageDataUrl accepts raster data URLs with base64 payloads', () => {
  assert.equal(isSupportedImageDataUrl(VALID_IMAGE), true);
  for (const mime of ['image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/png']) {
    assert.equal(isSupportedImageDataUrl(`data:${mime};base64,QUJDRA==`), true, mime);
  }
  assert.equal(isSupportedImageDataUrl('data:image/png;base64,ab+/cd=='), true);
});

test('isSupportedImageDataUrl rejects non-data URLs, SVG, empty and malformed payloads', () => {
  for (const value of [
    undefined,
    null,
    '',
    'https://example.com/q.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/bmp;base64,QUJD',
    'data:image/png,QUJD',
    'data:image/png;base64,',
    'data:image/png;base64,not base64!',
    'data:image/png;base64,@@@',
  ]) {
    assert.equal(isSupportedImageDataUrl(value), false, String(value));
  }
});

test('buildRecognizeMessages wraps the image and a text instruction', () => {
  const messages = buildRecognizeMessages({ imageDataUrl: VALID_IMAGE });

  assert.ok(Array.isArray(messages));
  assert.equal(messages[0].role, 'system');
  assert.ok(String(messages[0].content).startsWith('[TASK:RECOGNIZE]'));
  assert.match(String(messages[0].content), /JSON/i);

  const user = messages.find((message) => message.role === 'user');
  assert.ok(Array.isArray(user.content), 'vision requests use content parts');
  const imagePart = user.content.find((part) => part.type === 'image_url');
  assert.ok(imagePart, 'image_url part present');
  assert.equal(imagePart.image_url.url, VALID_IMAGE);
  const textPart = user.content.find((part) => part.type === 'text');
  assert.ok(textPart && textPart.text.length > 0, 'text part present');
});

test('buildAnswerMessages includes question, options and the requested style', () => {
  const messages = buildAnswerMessages({
    question: DEMO_PAYLOAD.question,
    options: DEMO_PAYLOAD.options,
    subject: '数学',
  });

  assert.equal(messages[0].role, 'system');
  assert.ok(String(messages[0].content).startsWith('[TASK:ANSWER]'));
  const userText = String(messages.at(-1).content);
  assert.ok(userText.includes(DEMO_PAYLOAD.question));
  for (const option of DEMO_PAYLOAD.options) {
    assert.ok(userText.includes(option.text), `option ${option.label} included`);
  }

  const concise = buildAnswerMessages({ question: 'Q', style: 'concise' });
  const detailed = buildAnswerMessages({ question: 'Q', style: 'detailed' });
  const step = buildAnswerMessages({ question: 'Q', style: 'step' });
  assert.notDeepEqual(detailed, concise);
  assert.notDeepEqual(step, concise);
  assert.notDeepEqual(step, detailed);
  assert.match(String(step.at(-1).content) + String(step[0].content), /步骤|逐步|step/i);
});

test('buildAnswerMessages truncates long questions and caps options', () => {
  const question = `${'A'.repeat(9000)}TAIL-MARKER`;
  const options = Array.from({ length: 15 }, (_, index) => ({
    label: String.fromCharCode(65 + index),
    text: `OPTION_${index}_MARKER`,
  }));

  const messages = buildAnswerMessages({ question, options, style: 'concise' });
  const userText = String(messages.at(-1).content);

  assert.ok(!userText.includes('TAIL-MARKER'), 'question is truncated from the tail');
  assert.ok(userText.length < 9000, 'message stays bounded by maxQuestionChars');
  assert.ok(userText.includes('OPTION_0_MARKER'));
  assert.ok(userText.includes('OPTION_9_MARKER'));
  assert.ok(!userText.includes('OPTION_10_MARKER'), 'options beyond maxOptions are dropped');
});
