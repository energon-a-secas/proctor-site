// ── Markdown subset renderer (escape-first, zero dependencies) ─
//
// Raw text is HTML-escaped BEFORE any transform, so no HTML in a test
// document ever reaches the DOM as markup. The subset, documented in
// /llms.txt: ``` fenced code blocks, `inline code`, **bold**, *italic*,
// [text](https://url), - bullet lists, 1. numbered lists, # headings.
// Anything else renders literally. Links are restricted to http(s).

import { escHtml } from './utils.js';

const FENCE_RE = /```[^\S\n]*([\w+-]*)\n([\s\S]*?)```/g;

// Placeholder sentinel for extracted code spans: NUL can't appear in text
// that came through JSON/YAML parsing, so it can't collide with content.
const SENT = '\u0000';
const SENT_RE = /\u0000(\d+)\u0000/g;

/** Inline transforms on already-escaped text. */
function inline(esc) {
  // Pull code spans out first so their contents survive the other transforms
  const codes = [];
  let out = esc.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `${SENT}${codes.length - 1}${SENT}`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out.replace(SENT_RE, (_, i) => `<code>${codes[i]}</code>`);
}

/** One line of markdown → inline HTML. No block elements — safe inside buttons. */
export function mdInline(text) {
  if (text === null || text === undefined) return '';
  return inline(escHtml(String(text)));
}

/** Full subset → block HTML (paragraphs, lists, fenced code). */
export function mdBlock(text) {
  if (text === null || text === undefined) return '';
  const src = String(text).replace(/\r\n?/g, '\n');
  let html = '';
  let last = 0;
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(src))) {
    html += prose(src.slice(last, m.index));
    html += `<pre class="md-code"><code>${escHtml(m[2].replace(/\n$/, ''))}</code></pre>`;
    last = m.index + m[0].length;
  }
  html += prose(src.slice(last));
  return html;
}

function prose(text) {
  return text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return '';
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    }
    const h = lines.length === 1 && lines[0].match(/^#{1,4}\s+(.*)$/);
    if (h) return `<p class="md-head">${mdInline(h[1])}</p>`;
    return `<p>${lines.map((l) => mdInline(l)).join('<br>')}</p>`;
  }).join('');
}
