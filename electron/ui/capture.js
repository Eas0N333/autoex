/**
 * Window capture helpers for the desktop overlay (renderer side only).
 *
 * The main process only hands us a desktopCapturer source id; everything here
 * runs in the sandboxed renderer: getUserMedia over that id, JPEG frame grabs,
 * a 16x16 difference hash and a cheap edge-density probe used to skip blank
 * screens. No dependencies, no build step, every failure carries a stable
 * `code` so the UI can show Chinese guidance.
 */

export class CaptureError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const DEFAULT_MAX_WIDTH = 1600;
const DEFAULT_QUALITY = 0.82;

/** Hash grid: 17x16 luminance samples -> 16x16 = 256 horizontal comparisons. */
const HASH_WIDTH = 17;
const HASH_HEIGHT = 16;
const HASH_BITS = 256;

/** Edge probe resolution (longest side, px). */
const EDGE_WIDTH = 96;
/** Sobel magnitude above this fraction of the theoretical maximum counts as an edge. */
const EDGE_THRESHOLD = 0.08;

let hashCanvas = null;
let edgeCanvas = null;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new CaptureError('FRAME_NOT_READY', '无法创建画布上下文。');
  return ctx;
}

/** Map a getUserMedia failure onto a code + actionable Chinese message. */
function describeCaptureFailure(error) {
  const name = error && typeof error.name === 'string' ? error.name : '';
  const raw = error && typeof error.message === 'string' ? error.message.trim() : '';
  const suffix = raw && /[\u4e00-\u9fa5]/.test(raw) ? `（${raw}）` : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CaptureError(
        'CAPTURE_DENIED',
        '屏幕录制权限被拒绝：请在「系统设置 › 隐私与安全性 › 屏幕录制」中允许本应用，然后重新选择窗口。',
        error,
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CaptureError('SOURCE_CLOSED', '目标窗口已关闭或不可用，请重新选择窗口。', error);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CaptureError('SOURCE_CLOSED', '无法读取窗口画面（窗口可能已最小化或被占用），请重新选择窗口。', error);
    case 'TypeError':
    case 'NotSupportedError':
      return new CaptureError('CAPTURE_UNSUPPORTED', '当前环境不支持窗口采集，请确认通过桌面应用启动。', error);
    default:
      return new CaptureError(
        'CAPTURE_FAILED',
        raw ? `窗口采集失败：${raw}` : `窗口采集失败${suffix}，请重新选择窗口。`,
        error,
      );
  }
}

/**
 * Start capturing a desktopCapturer source into a <video> element.
 * Electron's legacy chromeMediaSource constraints are the only way to bind a
 * pre-selected window id without a display-media picker.
 */
export async function startCapture(sourceId, videoEl) {
  if (typeof sourceId !== 'string' || !sourceId.trim()) {
    throw new CaptureError('NO_SOURCE', '还没有选择要采集的窗口，请先选择浏览器窗口。');
  }

  const mediaDevices = globalThis.navigator && globalThis.navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    throw new CaptureError('CAPTURE_UNSUPPORTED', '当前环境不支持窗口采集，请通过桌面应用启动。');
  }

  let stream;
  try {
    stream = await mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1200,
          maxFrameRate: 10,
        },
      },
    });
  } catch (error) {
    throw describeCaptureFailure(error);
  }

  if (videoEl) {
    try {
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      // Do not await playback: some window sources deliver their first frame
      // late, and a pending play() promise must not block the capture session.
      const playback = videoEl.play();
      if (playback && typeof playback.catch === 'function') playback.catch(() => {});
    } catch {
      // Assigning srcObject is the only requirement; frames still arrive.
    }
  }

  return stream;
}

/** Stop every track of a stream (safe for null/undefined). */
export function stopCapture(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try {
      track.onended = null;
      track.stop();
    } catch {
      // A already-ended track throws in some Chromium builds; ignore.
    }
  }
}

function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return { x: 0, y: 0, w: 1, h: 1 };
  const x = clamp(crop.x, 0, 1);
  const y = clamp(crop.y, 0, 1);
  let w = clamp(crop.w, 0, 1);
  let h = clamp(crop.h, 0, 1);
  if (w <= 0.01 || h <= 0.01) return { x: 0, y: 0, w: 1, h: 1 };
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (w <= 0.01 || h <= 0.01) return { x: 0, y: 0, w: 1, h: 1 };
  return { x, y, w, h };
}

function cropToPixels(crop, videoWidth, videoHeight) {
  const rect = normalizeCrop(crop);
  const sx = Math.round(rect.x * videoWidth);
  const sy = Math.round(rect.y * videoHeight);
  const sw = Math.max(1, Math.round(rect.w * videoWidth));
  const sh = Math.max(1, Math.round(rect.h * videoHeight));
  return {
    sx: Math.min(sx, Math.max(0, videoWidth - 1)),
    sy: Math.min(sy, Math.max(0, videoHeight - 1)),
    sw: Math.min(sw, videoWidth - sx),
    sh: Math.min(sh, videoHeight - sy),
  };
}

/**
 * Draw the current video frame into a canvas, cropped to a normalized rect and
 * scaled so its width does not exceed `maxWidth` (0 = no limit).
 */
export function drawFrame(videoEl, canvasEl, options = {}) {
  if (!videoEl || !canvasEl) {
    throw new CaptureError('FRAME_NOT_READY', '画面元素未就绪，请重新选择窗口。');
  }
  const videoWidth = Number(videoEl.videoWidth) || 0;
  const videoHeight = Number(videoEl.videoHeight) || 0;
  if (videoWidth < 2 || videoHeight < 2 || Number(videoEl.readyState) < 2) {
    throw new CaptureError('FRAME_NOT_READY', '画面尚未就绪，请稍候再试。');
  }

  const rect = cropToPixels(options.crop, videoWidth, videoHeight);
  const limit = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : rect.sw;
  const scale = Math.min(1, limit / rect.sw);
  const width = Math.max(1, Math.round(rect.sw * scale));
  const height = Math.max(1, Math.round(rect.sh * scale));

  if (canvasEl.width !== width || canvasEl.height !== height) {
    canvasEl.width = width;
    canvasEl.height = height;
  }

  const ctx = context2d(canvasEl);
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(videoEl, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);
  return { width, height };
}

/**
 * Grab a JPEG data URL from the video element.
 * `crop` is a normalized rect {x,y,w,h} in 0..1 (null = whole frame).
 */
export function grabFrame(videoEl, canvasEl, options = {}) {
  const maxWidth = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : DEFAULT_MAX_WIDTH;
  const quality = clamp(options.quality ?? DEFAULT_QUALITY, 0.3, 0.95);
  const size = drawFrame(videoEl, canvasEl, { crop: options.crop ?? null, maxWidth });

  let dataUrl;
  try {
    dataUrl = canvasEl.toDataURL('image/jpeg', quality);
  } catch (error) {
    throw new CaptureError('FRAME_NOT_READY', '无法导出截图，请重新选择窗口。', error);
  }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new CaptureError('FRAME_NOT_READY', '截图数据为空，请重新选择窗口。');
  }

  return { dataUrl, width: size.width, height: size.height };
}

function ensureHashCanvas() {
  if (!hashCanvas) hashCanvas = makeCanvas(HASH_WIDTH, HASH_HEIGHT);
  return hashCanvas;
}

/**
 * 16x16 dHash over the canvas: 17 luminance columns per row give exactly
 * 16 horizontal comparisons per row, i.e. 256 bits stored in a BigInt.
 * Bit order is row-major, most significant bit first.
 */
export function frameHash(canvasEl) {
  if (!canvasEl || !canvasEl.width || !canvasEl.height) return 0n;
  const canvas = ensureHashCanvas();
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, HASH_WIDTH, HASH_HEIGHT);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvasEl, 0, 0, canvasEl.width, canvasEl.height, 0, 0, HASH_WIDTH, HASH_HEIGHT);

  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT).data;
  } catch {
    return 0n;
  }

  const luminance = new Uint8Array(HASH_WIDTH * HASH_HEIGHT);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    luminance[index] = Math.round(
      pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114,
    );
  }

  let hash = 0n;
  for (let row = 0; row < HASH_HEIGHT; row += 1) {
    const base = row * HASH_WIDTH;
    for (let column = 0; column < HASH_HEIGHT; column += 1) {
      const left = luminance[base + column];
      const right = luminance[base + column + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

/** Hamming distance between two 256-bit frame hashes. */
export function hamming(a, b) {
  if (typeof a !== 'bigint' || typeof b !== 'bigint') return HASH_BITS;
  let diff = a ^ b;
  if (diff < 0n) diff = -diff;
  let count = 0;
  while (diff) {
    diff &= diff - 1n;
    count += 1;
  }
  return count;
}

function ensureEdgeCanvas(width, height) {
  if (!edgeCanvas) edgeCanvas = makeCanvas(width, height);
  else if (edgeCanvas.width !== width || edgeCanvas.height !== height) {
    edgeCanvas.width = width;
    edgeCanvas.height = height;
  }
  return edgeCanvas;
}

/**
 * Fraction (0..1) of pixels with a strong Sobel gradient. Used to skip blank
 * or single-colour frames where no question can be present.
 */
export function edgeDensity(canvasEl) {
  if (!canvasEl || canvasEl.width < 8 || canvasEl.height < 8) return 0;

  const width = EDGE_WIDTH;
  const height = Math.max(8, Math.min(EDGE_WIDTH, Math.round((width * canvasEl.height) / canvasEl.width)));
  const canvas = ensureEdgeCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvasEl, 0, 0, canvasEl.width, canvasEl.height, 0, 0, width, height);

  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return 0;
  }

  const gray = new Float32Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
  }

  let edges = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = gray[(y - 1) * width + (x - 1)];
      const top = gray[(y - 1) * width + x];
      const topRight = gray[(y - 1) * width + (x + 1)];
      const left = gray[y * width + (x - 1)];
      const right = gray[y * width + (x + 1)];
      const bottomLeft = gray[(y + 1) * width + (x - 1)];
      const bottom = gray[(y + 1) * width + x];
      const bottomRight = gray[(y + 1) * width + (x + 1)];

      const gx = -topLeft - 2 * left - bottomLeft + topRight + 2 * right + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      const magnitude = (Math.abs(gx) + Math.abs(gy)) / 1020;
      if (magnitude > EDGE_THRESHOLD) edges += 1;
      samples += 1;
    }
  }

  if (!samples) return 0;
  return Math.round((edges / samples) * 10000) / 10000;
}
