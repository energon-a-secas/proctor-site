// ── Shared utilities ─────────────────────────────────────────
// The generic helpers live in the DOM Kit (js/neorgon-dom.js, vendored from
// packages/neorgon-ui/dom/). They are re-exported here so every existing
// `import { escHtml } from './utils.js'` keeps working untouched.
//
// Do not edit js/neorgon-dom.js. Edit the canonical source and run
// packages/neorgon-ui/sync-dom.sh.

import { escHtml, showToast as toast, copyText as kitCopy, downloadText }
  from './neorgon-dom.js';

export { escHtml };

/** Cached element lookup by ID. */
const _els = {};
export function $(id) {
  return _els[id] || (_els[id] = document.getElementById(id));
}

/** This site's toast uses its own class and a longer dwell. */
export function showToast(msg) {
  return toast(msg, { visibleClass: 'toast--visible', duration: 2600 });
}

/** Fisher-Yates shuffle, returns a new array. */
export function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Copy text to the clipboard, with a toast either way. */
export async function copyText(text, label = 'Copied') {
  showToast(await kitCopy(text) ? label : 'Copy failed, select and copy manually');
}

/** Trigger a client-side file download. */
export function downloadFile(name, text, mime = 'text/plain') {
  downloadText(text, name, mime);
}

/** Base64url helpers for #t= share links (UTF-8 safe). */
export function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
