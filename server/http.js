/**
 * Small HTTP helpers shared by the server routes: error type, JSON responses,
 * capped JSON body reading, per-IP token bucket and the static file handler.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';

export class HttpError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (options.retryAfterSec !== undefined) this.retryAfterSec = options.retryAfterSec;
    if (options.headers) this.headers = options.headers;
  }
}

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export function contentTypeFor(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/** Common headers for every response, plus a sink for post-disconnect EPIPE. */
export function setBaseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.on('error', () => {
    // The peer vanished mid-write (EPIPE / ECONNRESET); nothing to recover.
  });
}

export function sendJson(res, status, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = '{"error":{"code":"INTERNAL","message":"响应序列化失败"}}';
    status = 500;
  }
  const buffer = Buffer.from(body, 'utf8');
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(buffer);
  } catch {
    // Client disconnected between the checks above and writeHead.
  }
}

/** Render an error response. Only HttpError details reach the client. */
export function sendError(res, error) {
  const httpError =
    error instanceof HttpError ? error : new HttpError(500, 'INTERNAL', '服务器内部错误');
  const headers = { ...(httpError.headers ?? {}) };
  if (httpError.retryAfterSec !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(httpError.retryAfterSec)));
  }
  if (httpError.status === 413 || httpError.status >= 500) headers.Connection = 'close';
  sendJson(res, httpError.status, { error: { code: httpError.code, message: httpError.message } }, headers);
}

/**
 * Read and parse a JSON request body, rejecting anything larger than `maxBytes`.
 * Resolves to a plain object; rejects with an HttpError the route can send as-is.
 */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!type.includes('application/json')) {
      req.resume();
      reject(new HttpError(415, 'UNSUPPORTED', '请求体必须使用 application/json 编码'));
      return;
    }

    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY;
    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        finish(reject, new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${limit} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        finish(reject, new HttpError(400, 'BAD_REQUEST', '请求体不能为空'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish(reject, new HttpError(400, 'BAD_REQUEST', '请求体不是合法的 JSON'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(reject, new HttpError(400, 'BAD_REQUEST', '请求体必须是一个 JSON 对象'));
        return;
      }
      finish(resolve, parsed);
    });

    req.on('error', () => finish(reject, new HttpError(400, 'BAD_REQUEST', '读取请求体失败')));
    req.on('aborted', () => finish(reject, new HttpError(400, 'BAD_REQUEST', '请求已中断')));
  });
}

/**
 * Per-IP token bucket. Capacity equals ratePerMinute, so a burst larger than
 * that is rejected with a Retry-After hint.
 */
export function createRateLimiter({ ratePerMinute = 60, maxKeys = 10_000 } = {}) {
  const capacity = Number.isFinite(ratePerMinute) && ratePerMinute > 0 ? ratePerMinute : 60;
  const refillPerMs = capacity / 60_000;
  const buckets = new Map();

  function take(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (bucket) {
      bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updated) * refillPerMs);
      bucket.updated = now;
    } else {
      bucket = { tokens: capacity, updated: now };
    }

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs) };
    }

    bucket.tokens -= 1;
    buckets.delete(key);
    buckets.set(key, bucket);
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  return { take };
}

/**
 * Serve a directory of static files with an SPA fallback.
 * `serve(req, res, pathname)` resolves to true when it wrote a response.
 */
export function createStaticHandler({ root, indexFile = 'index.html' }) {
  const webRoot = path.resolve(root);

  async function resolveRequestPath(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { status: 400 };
    }
    if (decoded.includes('\0')) return { status: 400 };

    const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
    const relative = normalized === '/' ? indexFile : normalized.replace(/^\/+/, '');
    const target = path.resolve(webRoot, relative);
    if (target !== webRoot && !target.startsWith(webRoot + path.sep)) {
      return { status: 403 };
    }
    return { target, relative };
  }

  async function readIfFile(target) {
    try {
      return await readFile(target);
    } catch {
      return null;
    }
  }

  async function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const resolved = await resolveRequestPath(pathname);
    if (resolved.status === 400) {
      plain(res, 400, 'Bad Request');
      return true;
    }
    if (resolved.status === 403) {
      plain(res, 403, 'Forbidden');
      return true;
    }

    let filePath = resolved.target;
    let body = await readIfFile(filePath);

    if (!body) {
      // A missing asset stays a 404; extension-less paths fall back to the SPA.
      if (resolved.relative === indexFile || path.extname(resolved.relative) !== '') {
        plain(res, 404, 'Not Found');
        return true;
      }
      filePath = path.join(webRoot, indexFile);
      body = await readIfFile(filePath);
      if (!body) {
        plain(res, 404, 'Not Found');
        return true;
      }
    }

    const isHtml = contentTypeFor(filePath).startsWith('text/html');
    try {
      res.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': String(body.length),
        'Cache-Control': isHtml ? 'no-store' : 'no-cache',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    } catch {
      // Client disconnected.
    }
    return true;
  }

  function plain(res, status, message) {
    const buffer = Buffer.from(`${message}\n`, 'utf8');
    if (res.destroyed || res.writableEnded) return;
    try {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
    } catch {
      // Client disconnected.
    }
  }

  return { serve };
}
