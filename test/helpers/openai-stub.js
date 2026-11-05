import http from 'node:http';

/** Collects a request body into a UTF-8 string. */
export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Writes raw SSE text as several deliberately fragmented HTTP writes, so the
 * client has to reassemble events across chunk boundaries.
 */
export async function sendSseFragments(res, text, { size = 7, delayMs = 0 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (let i = 0; i < text.length; i += size) {
    if (delayMs) await delay(delayMs);
    res.write(text.slice(i, i + size));
  }
  res.end();
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal non-streaming chat completion payload. */
export function completionBody(text, usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'stub-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  };
}

/** Builds an SSE stream from delta texts plus an optional trailing usage chunk. */
export function sseBody(deltas, usage) {
  const lines = deltas.map(
    (text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
  );
  if (usage) {
    lines.push(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
    );
  }
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

/**
 * Boots an in-process OpenAI-compatible stub on an ephemeral port.
 * The handler receives (req, res, entry, requests); returning without writing
 * leaves the connection open, which is what timeout/abort tests want.
 */
export async function startStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    readBody(req)
      .then((body) => {
        const entry = { method: req.method, url: req.url, headers: req.headers, body };
        if (body) {
          try {
            entry.json = JSON.parse(body);
          } catch {
            entry.json = undefined;
          }
        }
        requests.push(entry);
        return handler(req, res, entry, requests);
      })
      .catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: error.message } });
        else res.destroy();
      });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref?.();

  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    url: `http://127.0.0.1:${port}`,
    requests,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
