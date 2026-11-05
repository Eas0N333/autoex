/**
 * Minimal, dependency-free markdown renderer for streamed model output.
 *
 * Safety model: every piece of source text is HTML-escaped before any tag is
 * emitted, so the returned string only ever contains markup produced here.
 * Model/user text never reaches innerHTML unescaped.
 *
 * KaTeX is optional progressive enhancement. If the CDN script is blocked or
 * unavailable, math is shown as readable literal TeX inside <code>.
 */

const PUA_START = '\uE000';
const PUA_END = '\uE001';
const SLOT_RE = /\uE000(\d+)\uE001/g;

const KATEX_VERSION = '0.16.11';
const KATEX_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.js`;
const KATEX_STYLE_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a string for safe interpolation into HTML text or attributes. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

let katexInstance = null;
let katexPromise = null;

/** True once KaTeX has been loaded from the CDN. */
export function hasKatex() {
  return katexInstance !== null;
}

/**
 * Lazily load KaTeX from jsDelivr. Resolves to false (never rejects) when the
 * network, the CSP or the CDN is unavailable, so rendering keeps working.
 */
export function loadKatex(options = {}) {
  if (katexInstance) return Promise.resolve(true);
  if (katexPromise) return katexPromise;
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(false);

  const preloaded = window.katex;
  if (preloaded && typeof preloaded.renderToString === 'function') {
    katexInstance = preloaded;
    document.documentElement.classList.add('has-katex');
    return Promise.resolve(true);
  }

  const scriptUrl = typeof options.scriptUrl === 'string' ? options.scriptUrl : KATEX_SCRIPT_URL;
  const styleUrl = typeof options.styleUrl === 'string' ? options.styleUrl : KATEX_STYLE_URL;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;

  katexPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      const style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = styleUrl;
      style.crossOrigin = 'anonymous';
      document.head.append(style);
    } catch {
      // Styling is optional; KaTeX markup degrades to plain text.
    }

    try {
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.addEventListener('load', () => {
        const candidate = window.katex;
        if (candidate && typeof candidate.renderToString === 'function') {
          katexInstance = candidate;
          document.documentElement.classList.add('has-katex');
          finish(true);
          return;
        }
        finish(false);
      });
      script.addEventListener('error', () => finish(false));
      document.head.append(script);
    } catch {
      finish(false);
    }
  });

  return katexPromise;
}

/** Render TeX to HTML, or to readable literal TeX when KaTeX is missing. */
function renderMath(tex, displayMode) {
  const source = String(tex ?? '').trim();
  if (!source) return null;
  if (katexInstance) {
    try {
      return katexInstance.renderToString(source, {
        displayMode: Boolean(displayMode),
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'html',
      });
    } catch {
      // Fall through to the readable literal.
    }
  }
  const literal = displayMode ? `$$${source}$$` : `$${source}$`;
  return `<code class="math-tex">${escapeHtml(literal)}</code>`;
}

/** Heuristic so a price like "$5 … $10" stays text while "$x^2$" becomes math. */
function looksLikeMath(tex) {
  const raw = String(tex ?? '');
  const value = raw.trim();
  if (!value) return false;
  // "$ 5 $" style padding reads like currency, not TeX.
  if (/^\s|\s$/.test(raw)) return false;
  if (/[a-zA-Z]/.test(value)) return true;
  if (/[\\^_{}=<>]/.test(value)) return true;
  // Plain arithmetic or a single number, e.g. "$1$".
  if (/^[\d\s.,+\-*/()%[\]]+$/.test(value)) return true;
  return false;
}

/**
 * Inline formatting for a single line/paragraph fragment.
 * Code spans and math are extracted before escaping so their bodies stay raw.
 */
function renderInline(raw) {
  const slots = [];
  const hold = (html) => {
    slots.push(html);
    return `${PUA_START}${slots.length - 1}${PUA_END}`;
  };

  let text = String(raw ?? '');

  // Code spans first, so `$` inside code never becomes math.
  text = text.replace(/`([^`\n]+)`/g, (whole, code) => hold(`<code class="inline-code">${escapeHtml(code)}</code>`));

  // Display math, then inline math, then \( \).
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (whole, tex) => {
    const html = renderMath(tex, true);
    return html ? hold(html) : whole;
  });
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (whole, tex) => {
    const html = renderMath(tex, true);
    return html ? hold(html) : whole;
  });
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (whole, tex) => {
    const html = renderMath(tex, false);
    return html ? hold(html) : whole;
  });
  text = text.replace(/\$([^$\n]+?)\$/g, (whole, tex) => {
    if (!looksLikeMath(tex)) return whole;
    const html = renderMath(tex, false);
    return html ? hold(html) : whole;
  });

  // Everything left is literal text.
  text = escapeHtml(text);

  // Links: only http(s) targets, always hardened.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (whole, label, url) => {
    return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return text.replace(SLOT_RE, (whole, index) => {
    const value = slots[Number(index)];
    return value === undefined ? '' : value;
  });
}

const LIST_RE = /^\s{0,6}([-*+]|\d{1,3}[.)])\s+/;
const LIST_ITEM_RE = /^\s{0,6}([-*+]|\d{1,3}[.)])\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function startsBlock(line) {
  if (!line.trim()) return true;
  if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^\s{0,3}\$\$/.test(line)) return true;
  if (LIST_RE.test(line)) return true;
  return false;
}

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  if (!lines[index].includes('|')) return false;
  return TABLE_SEPARATOR_RE.test(lines[index + 1]);
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block (an unterminated fence renders to the end).
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const size = fence[1].length;
      const info = fence[2].trim().split(/\s+/)[0] || '';
      const closing = new RegExp(`^\\s{0,3}${marker}{${size},}\\s*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const langClass = info ? ` class="language-${escapeHtml(info)}"` : '';
      out.push(`<pre class="code-block"><code${langClass}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Display math on its own line(s).
    if (/^\s{0,3}\$\$/.test(line)) {
      const first = line.replace(/^\s{0,3}\$\$/, '');
      const chunks = [];
      let closed = false;
      const firstClose = first.indexOf('$$');
      if (firstClose !== -1) {
        chunks.push(first.slice(0, firstClose));
        closed = true;
      } else {
        chunks.push(first);
      }
      i += 1;
      while (!closed && i < lines.length) {
        const current = lines[i];
        const close = current.indexOf('$$');
        if (close !== -1) {
          chunks.push(current.slice(0, close));
          closed = true;
          i += 1;
          break;
        }
        chunks.push(current);
        i += 1;
      }
      const tex = chunks.join('\n');
      const html = renderMath(tex, true);
      out.push(`<div class="md-math-block">${html || `<code class="math-tex">${escapeHtml(`$$${tex}$$`)}</code>`}</div>`);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} class="md-heading">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr class="md-hr">');
      i += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const splitRow = (row) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());
      const headerCells = splitRow(lines[i]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitRow(lines[i]));
        i += 1;
      }
      const headHtml = headerCells.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const bodyHtml = bodyRows
        .map((cells) => `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('');
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
      );
      continue;
    }

    if (LIST_RE.test(line)) {
      const ordered = /^\d/.test(line.trim());
      const items = [];
      while (i < lines.length) {
        const current = lines[i];
        const item = LIST_ITEM_RE.exec(current);
        if (item) {
          if (/^\d/.test(item[1]) !== ordered) break;
          items.push([item[2]]);
          i += 1;
          continue;
        }
        if (!current.trim()) break;
        if (items.length && !startsBlock(current)) {
          items[items.length - 1].push(current.trim());
          i += 1;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const rendered = items
        .map((parts) => `<li>${parts.map((part) => renderInline(part)).join('<br>')}</li>`)
        .join('');
      out.push(`<${tag} class="md-list">${rendered}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim()) {
      if (paragraph.length && startsBlock(lines[i])) break;
      paragraph.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${paragraph.map((row) => renderInline(row.trim())).join('<br>')}</p>`);
  }

  return out.join('\n');
}

/** Render a markdown string to sanitized HTML. */
export function renderMarkdown(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';
  return renderBlocks(source.split('\n'));
}
