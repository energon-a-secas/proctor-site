// ── Entry point: restore state, load samples, wire events ────

import { state, loadState, testId } from './state.js';
import { parseTest } from './parser.js';
import { initEvents } from './events.js';
import { renderLibrary, renderFormatView } from './render.js';
import { showToast, b64urlDecode } from './utils.js';

const SAMPLES = ['data/terminal-basics.json', 'data/console-lore.yaml'];

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

function importFromUrl() {
  const hash = location.hash.match(/^#t=(.+)$/);
  if (hash) {
    try {
      const parsed = parseTest(b64urlDecode(hash[1]));
      if (parsed.error) throw new Error(parsed.error);
      history.replaceState(null, '', location.pathname);
      import('./state.js').then(({ addTest }) => {
        addTest(parsed.test, 'link');
        renderLibrary();
        showToast(`Loaded "${parsed.test.title}" from the link`);
      });
    } catch { showToast('The shared link did not contain a valid test'); }
  }
  const src = new URLSearchParams(location.search).get('src');
  if (src && /^https:\/\//.test(src)) {
    fetch(src).then((r) => r.text()).then((text) => {
      const parsed = parseTest(text);
      if (parsed.error) { showToast(parsed.error.split('\n')[0]); return; }
      import('./state.js').then(({ addTest }) => {
        addTest(parsed.test, 'url');
        renderLibrary();
        showToast(`Loaded "${parsed.test.title}"`);
      });
    }).catch(() => showToast('Could not fetch ?src= (CORS or network)'));
  }
}

loadState();
initEvents();
renderFormatView();
loadSamples().then(() => { renderLibrary(); importFromUrl(); });
