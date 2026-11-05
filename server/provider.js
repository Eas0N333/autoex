/**
 * Chat provider for any OpenAI-compatible endpoint, plus the deterministic
 * demo provider used when no API key is configured.
 *
 * Public surface (see docs/CONTRACT.md §2): createProvider(), ProviderError.
 * The API key is never logged and never returned to callers.
 */

import { createMockProvider } from './mock.js';

const ERROR_CODES = new Set(['UPSTREAM', 'TIMEOUT', 'ABORTED']);
const SNIPPET_LIMIT = 300;
const RETRY_BASE_DELAY_MS = 300;

export class ProviderError extends Error {
  /**
   * @param {'UPSTREAM'|'TIMEOUT'|'ABORTED'} code
   * @param {number} [status] HTTP status from the upstream, when available
   * @param {string} [message] short, non-secret description
   */
  constructor(code, status, message) {
    // Tolerate ProviderError('UPSTREAM', 'message') as well.
    if (typeof status === 'string' && message === undefined) {
      message = status;
      status = undefined;
    }
    super(typeof message === 'string' && message ? message : String(code ?? 'UPSTREAM'));
    this.name = 'ProviderError';
    this.code = ERROR_CODES.has(code) ? code : 'UPSTREAM';
    if (typeof status === 'number' && Number.isFinite(status)) this.status = status;
  }
}

/** Collapse whitespace and cap an upstream error body so it is safe to surface. */
function snippet(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > SNIPPET_LIMIT ? text.slice(0, SNIPPET_LIMIT) : text;
}

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

function chunkText(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const node = choice?.delta ?? choice?.message;
  return contentText(node?.content ?? choice?.text);
}

/** Resolve after `ms`; rejects with ABORTED if the caller cancels first. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('ABORTED', undefined, '请求已取消'));
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new ProviderError('ABORTED', undefined, '请求已取消'));
    const timer = setTimeout(() => finish(null), ms);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function classifyFailure(error, callerSignal, timeoutSignal) {
  if (error instanceof ProviderError) return error;
  if (callerSignal?.aborted) return new ProviderError('ABORTED', undefined, '请求已取消');
  if (timeoutSignal?.aborted) return new ProviderError('TIMEOUT', undefined, '模型响应超时');
  if (error?.name === 'AbortError') return new ProviderError('ABORTED', undefined, '请求已取消');
  if (error?.name === 'TimeoutError') return new ProviderError('TIMEOUT', undefined, '模型响应超时');
  return new ProviderError('UPSTREAM', undefined, `读取模型响应失败：${snippet(error?.message)}`);
}

/**
 * Yield the payload of every complete SSE event from a reader.
 * Handles chunk splits, CRLF, comment lines, multi-line `data:` and a final
 * event that is not terminated by a blank line.
 */
async function* iterateSse(reader) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines = [];

  const takeEvent = () => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n');
    dataLines = [];
    return payload;
  };

  const handleLine = (rawLine) => {
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') return takeEvent();
    if (line.startsWith(':')) return null;
    const index = line.indexOf(':');
    const field = index === -1 ? line : line.slice(0, index);
    let value = index === -1 ? '' : line.slice(index + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    return null;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const payload = handleLine(line);
      if (payload !== null) yield payload;
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    const payload = handleLine(buffer);
    if (payload !== null) yield payload;
  }
  const tail = takeEvent();
  if (tail !== null) yield tail;
}

function createLiveProvider(config) {
  const ai = config.ai;
  const endpoint = `${String(ai.baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = Number.isFinite(ai.timeoutMs) && ai.timeoutMs > 0 ? ai.timeoutMs : 60_000;
  const retries = Number.isFinite(ai.maxRetries) ? Math.max(0, Math.min(5, Math.floor(ai.maxRetries))) : 1;

  function requestHeaders(stream) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    };
    if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
    for (const [name, value] of Object.entries(ai.headers ?? {})) {
      if (value === undefined || value === null) continue;
      headers[name] = String(value);
    }
    return headers;
  }

  function requestBody(messages, { temperature, maxTokens, stream }) {
    const usesImage = messages.some(
      (message) => Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url'),
    );
    const model = usesImage && ai.visionModel ? ai.visionModel : ai.model;
    const body = { model, messages, stream };
    if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature;
    if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
    return body;
  }

  /**
   * POST to the endpoint, retrying once (or ai.maxRetries times) on 429/5xx and
   * network failures. Retries only happen before any response is returned to the
   * caller, i.e. before any delta reaches the client.
   */
  async function openResponse(body, callerSignal) {
    let lastError = null;
    let temperatureDropped = false;
    for (let attempt = 0; ; attempt += 1) {
      if (callerSignal?.aborted) throw new ProviderError('ABORTED', undefined, '请求已取消');

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: requestHeaders(body.stream === true),
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (callerSignal?.aborted) throw new ProviderError('ABORTED', undefined, '请求已取消');
        const timedOut = timeoutSignal.aborted;
        lastError = timedOut
          ? new ProviderError('TIMEOUT', undefined, `模型响应超时（${timeoutMs}ms）`)
          : new ProviderError(
              'UPSTREAM',
              undefined,
              `无法连接模型服务：${snippet(error?.cause?.message ?? error?.message)}`,
            );
        if (!timedOut && attempt < retries) {
          await sleep(RETRY_BASE_DELAY_MS * (attempt + 1), callerSignal);
          continue;
        }
        throw lastError;
      }

      if (response.ok) return { response, timeoutSignal, callerSignal };

      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      const status = response.status;
      // Some models (e.g. deepseek-reasoner) reject `temperature` with HTTP 400.
      if (
        status === 400 &&
        !temperatureDropped &&
        body.temperature !== undefined &&
        /temperature/i.test(detail)
      ) {
        temperatureDropped = true;
        delete body.temperature;
        continue;
      }
      if ((status === 429 || status >= 500) && attempt < retries) {
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1), callerSignal);
        continue;
      }
      throw new ProviderError('UPSTREAM', status, snippet(detail) || `模型服务返回 HTTP ${status}`);
    }
    throw lastError ?? new ProviderError('UPSTREAM', undefined, '模型请求失败');
  }

  async function chat({ messages, temperature, maxTokens, signal } = {}) {
    const { response, timeoutSignal, callerSignal } = await openResponse(
      requestBody(messages, { temperature, maxTokens, stream: false }),
      signal,
    );

    let json;
    try {
      json = await response.json();
    } catch (error) {
      throw classifyFailure(error, callerSignal, timeoutSignal);
    }

    if (json?.error) {
      throw new ProviderError('UPSTREAM', response.status, snippet(JSON.stringify(json.error)));
    }

    const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content !== 'string') {
      throw new ProviderError('UPSTREAM', response.status, '模型服务返回了无法解析的响应');
    }
    return { text: content, usage: json?.usage ?? null };
  }

  async function* streamChat({ messages, temperature, maxTokens, signal } = {}) {
    const { response, timeoutSignal, callerSignal } = await openResponse(
      requestBody(messages, { temperature, maxTokens, stream: true }),
      signal,
    );
    if (!response.body) {
      throw new ProviderError('UPSTREAM', response.status, '模型服务未返回响应体');
    }

    const reader = response.body.getReader();
    try {
      for await (const payload of iterateSse(reader)) {
        if (payload.trim() === '[DONE]') return;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // Tolerate keep-alive fragments and malformed lines.
        }

        if (json?.error) {
          throw new ProviderError('UPSTREAM', response.status, snippet(JSON.stringify(json.error)));
        }

        const text = chunkText(json);
        if (text) yield { type: 'delta', text };
        if (json?.usage && typeof json.usage === 'object') {
          yield { type: 'usage', usage: json.usage };
        }
      }
    } catch (error) {
      throw classifyFailure(error, callerSignal, timeoutSignal);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Stream already closed or aborted.
      }
    }
  }

  return {
    kind: 'live',
    model: ai.model,
    visionModel: ai.visionModel || ai.model,
    chat,
    streamChat,
  };
}

/**
 * @param {ReturnType<typeof import('./config.js').loadConfig>} config
 * @param {{ allowKeyless?: boolean }} [options] `allowKeyless` builds a live
 *   provider for endpoints that authenticate some other way (per-endpoint keys
 *   are already merged into `config.ai.apiKey` by the engine).
 * @returns {{ kind:'live'|'demo', model:string, visionModel:string,
 *   chat:Function, streamChat:AsyncGeneratorFunction }}
 */
export function createProvider(config, options = {}) {
  if (!config || typeof config !== 'object' || !config.ai) {
    throw new TypeError('createProvider(config) requires the config object from loadConfig()');
  }
  if (config.demo === true) return createMockProvider(config);
  if (!config.ai.apiKey && options?.allowKeyless !== true) return createMockProvider(config);
  return createLiveProvider(config);
}
