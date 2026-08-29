// ── Entry point: restore state, load samples, wire events ────

import { state, loadState, addTest, testId } from './state.js';
import { parseTest } from './parser.js';
import { initEvents, startRun, openReview } from './events.js';
import { renderLibrary, renderFormatView } from './render.js';
import { showToast, b64urlDecode, escHtml } from './utils.js';

const SAMPLES = ['data/terminal-basics.json', 'data/console-lore.yaml', 'data/oncall-drill.json'];

const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';

async function loadSamples() {
  const results = await Promise.allSettled(SAMPLES.map(async (path) => {
    const res = await fetch(path);
    if (!res.ok) throw new Error(path);
    const parsed = parseTest(await res.text());
    if (parsed.error) throw new Error(`${path}: ${parsed.error}`);
    return { ...parsed.test, id: `sample-${testId(parsed.test)}` };
  }));
  state.samples = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// Embed mode (?embed=1): chromeless, in-memory only, auto-starts the test.
// A slim attribution bar replaces the header; ?mode= picks study|exam|review.
function embedBoot() {
  state.embed = true;
  document.body.classList.add('is-embed');
  const p = new URLSearchParams(location.search);
  p.delete('embed'); p.delete('mode');
  const qs = p.toString();
  const href = `${location.origin}${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  const bar = document.createElement('div');
  bar.className = 'proctor-embed-bar';
  bar.innerHTML = `<span id="embedBarTitle">Proctor</span>
    <a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">Open in Proctor ↗</a>`;
  document.body.prepend(bar);
}

function onImported(test, id) {
  if (!EMBED) return;
  const t = document.getElementById('embedBarTitle');
  if (t) t.textContent = test.title;
  const mode = params.get('mode') || 'study';
  if (mode === 'review') { openReview(id); return; }
  const draw = parseInt(params.get('draw'), 10);
  const time = parseInt(params.get('time'), 10);
  startRun(id, mode, {
    drawCount: Number.isFinite(draw) && draw > 0 ? draw : null,
    timeLimitMin: Number.isFinite(time) && time >= 0 ? time : null,
  });
}

function importFromUrl() {
  const hash = location.hash.match(/^#t=(.+)$/);
  if (hash) {
    try {
      const parsed = parseTest(b64urlDecode(hash[1]));
      if (parsed.error) throw new Error(parsed.error);
      if (!EMBED) history.replaceState(null, '', location.pathname);
      const id = addTest(parsed.test, 'link', parsed.notes);
      renderLibrary();
      if (EMBED) onImported(parsed.test, id);
      else showToast(`Loaded "${parsed.test.title}" from the link`);
    } catch { showToast('The shared link did not contain a valid test'); }
    return;
  }
  const src = params.get('src');
  if (src && /^https:\/\//.test(src)) {
    fetch(src).then((r) => r.text()).then((text) => {
      const parsed = parseTest(text);
      if (parsed.error) { showToast(parsed.error.split('\n')[0]); return; }
      const id = addTest(parsed.test, 'url', parsed.notes);
      renderLibrary();
      if (EMBED) onImported(parsed.test, id);
      else showToast(`Loaded "${parsed.test.title}"`);
    }).catch(() => showToast('Could not fetch ?src= (CORS or network)'));
    return;
  }
  if (EMBED) showToast('No test in the URL: pass #t= or ?src=');
}

if (EMBED) embedBoot();
else loadState();
initEvents();
renderFormatView();
loadSamples().then(() => { renderLibrary(); importFromUrl(); });
