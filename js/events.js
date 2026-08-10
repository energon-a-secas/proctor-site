// ── Event wiring + session lifecycle ─────────────────────────

import { $, showToast, shuffled, copyText, b64urlEncode } from './utils.js';
import { state, saveState, addTest, removeTest, getTest, recordResult } from './state.js';
import { parseTest } from './parser.js';
import { isAnswered } from './grader.js';
import {
  showView, renderLibrary, renderRunner, renderQuestion, renderPalette,
  renderResults, renderTimer, FORMAT_EXAMPLE,
} from './render.js';
import { startTimer, stopTimer } from './timer.js';

const LLM_PROMPT = `Write a test file for Proctor (https://proctor.neorgon.com), a browser exam runner.
Output ONLY a single JSON object, no prose, following this shape:

${FORMAT_EXAMPLE}

Rules:
- "type" is one of: single (one correct option), multi (several correct), truefalse, fill (typed answer).
- "answer" is a 0-based option index (or the option text); for truefalse it is a boolean.
- "multi" uses "answers": an array of indexes. "fill" uses "accept": every accepted string.
- Give every question an "explanation" written as feedback for a wrong answer.
- Use "category" per question so results break down by topic.
- 10 to 20 questions, mixed types. "timeLimitMinutes" and "passingScore" are optional.

My topic: `;

// ── Session lifecycle ────────────────────────────────────────

let pendingTestId = null;

function startSession(id, mode, { shuffleQ, shuffleO, onlyIdxs } = {}) {
  const entry = getTest(id);
  if (!entry) { showToast('Test not found'); return; }
  const test = entry.doc || entry;
  let order = onlyIdxs ?? test.questions.map((_, i) => i);
  if (shuffleQ) order = shuffled(order);
  const optionOrders = order.map((qIdx) => {
    const q = test.questions[qIdx];
    if (!q.options) return null;
    const idxs = q.options.map((_, i) => i);
    return shuffleO ? shuffled(idxs) : idxs;
  });
  state.session = {
    testId: id,
    mode,
    order,
    optionOrders,
    responses: new Array(order.length).fill(null),
    checked: new Array(order.length).fill(false),
    flags: new Array(order.length).fill(false),
    pos: 0,
    startedAt: Date.now(),
    finishedAt: null,
    timeLimitS: mode === 'exam' && test.timeLimitMinutes ? test.timeLimitMinutes * 60 : null,
    done: false,
  };
  saveState();
  showView('runner');
  renderRunner();
  if (state.session.timeLimitS) {
    startTimer(state.session.timeLimitS, renderTimer, () => {
      showToast('Time is up — submitting');
      finishSession();
    });
  }
}

function finishSession() {
  const s = state.session;
  if (!s) return;
  stopTimer();
  s.done = true;
  s.finishedAt = Date.now();
  renderResults();
  const test = getTest(s.testId);
  recordResult(test ? test.title : '?', s.mode, state.lastSummary.scorePct);
  showView('results');
}

function quitSession() {
  stopTimer();
  state.session = null;
  saveState();
  renderLibrary();
  showView('library');
}

function resumeSession() {
  const s = state.session;
  if (!s) return;
  showView('runner');
  renderRunner();
  if (s.timeLimitS) {
    // Resume budget: original limit minus time already spent before the reload.
    const spent = Math.round((Date.now() - s.startedAt) / 1000);
    const left = Math.max(30, s.timeLimitS - spent);
    startTimer(left, renderTimer, () => { showToast('Time is up — submitting'); finishSession(); });
  }
}

// ── Import pipeline ──────────────────────────────────────────

function handleRawText(text, source, { onError } = {}) {
  const result = parseTest(text);
  if (result.error) {
    if (onError) onError(result.error);
    else showToast(result.error.split('\n')[0]);
    return false;
  }
  const id = addTest(result.test, source);
  renderLibrary();
  openModeModal(id);
  return true;
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => handleRawText(String(reader.result), 'file');
  reader.onerror = () => showToast('Could not read the file');
  reader.readAsText(file);
}

// ── Modals ───────────────────────────────────────────────────

function openModal(id) { $(id).hidden = false; $(id).querySelector('.modal__dialog').focus(); }
function closeModals() { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); }

function openModeModal(id) {
  pendingTestId = id;
  const t = getTest(id);
  $('modeTestName').textContent = t ? `${t.title} · ${(t.doc || t).questions.length} questions` : '';
  openModal('modeModal');
}

// ── Wiring ───────────────────────────────────────────────────

export function initEvents() {
  // Header
  $('loadTestBtn').addEventListener('click', () => { showView('library'); $('dropzone').scrollIntoView({ block: 'center' }); });
  $('formatBtn').addEventListener('click', () => showView('format'));
  document.querySelectorAll('[data-goto="format"]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); showView('format'); }));

  // Dropzone
  const dz = $('dropzone');
  dz.addEventListener('click', () => $('fileInput').click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('proctor-dropzone--over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('proctor-dropzone--over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('proctor-dropzone--over');
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  });
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files?.[0]) readFile(e.target.files[0]);
    e.target.value = '';
  });

  // Paste modal
  $('pasteBtn').addEventListener('click', (e) => { e.stopPropagation(); $('pasteError').hidden = true; $('pasteInput').value = ''; openModal('pasteModal'); });
  $('pasteLoadBtn').addEventListener('click', () => {
    const ok = handleRawText($('pasteInput').value, 'paste', {
      onError: (err) => { $('pasteError').textContent = err; $('pasteError').hidden = false; },
    });
    if (ok) closeModals();
  });

  // Modal close (backdrop, X, Cancel, Esc)
  document.querySelectorAll('[data-modal-close]').forEach((el) => el.addEventListener('click', closeModals));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  // Mode modal
  document.querySelectorAll('.proctor-mode-card').forEach((btn) =>
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode === 'exam' ? 'exam' : 'study';
      const opts = { shuffleQ: $('shuffleQuestions').checked, shuffleO: $('shuffleOptions').checked };
      closeModals();
      if (pendingTestId) startSession(pendingTestId, mode, opts);
    }));

  // Library cards (delegated)
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.proctor-testcard');
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!card || !action) return;
    const id = card.dataset.testId;
    if (action === 'start') openModeModal(id);
    if (action === 'resume') resumeSession();
    if (action === 'discard') quitSession();
    if (action === 'remove') { removeTest(id); renderLibrary(); }
    if (action === 'share') {
      const t = state.tests[id];
      const encoded = b64urlEncode(JSON.stringify(t.doc));
      if (encoded.length > 12000) { showToast('Too big to share as a link — send the file instead'); return; }
      copyText(`${location.origin}${location.pathname}#t=${encoded}`, 'Share link copied');
    }
  });

  // Runner: options (delegated)
  $('optionsHost').addEventListener('click', (e) => {
    const btn = e.target.closest('.proctor-option');
    if (!btn || btn.disabled) return;
    selectOption(btn);
  });
  $('optionsHost').addEventListener('input', (e) => {
    if (e.target.id === 'fillInput') {
      state.session.responses[state.session.pos] = e.target.value;
      saveState();
      if (state.session.mode === 'study') $('checkBtn').disabled = e.target.value.trim() === '';
    }
  });

  // Runner: nav
  $('prevBtn').addEventListener('click', () => move(-1));
  $('nextBtn').addEventListener('click', () => {
    const s = state.session;
    if (s.mode === 'study' && s.pos === s.order.length - 1) {
      if (s.checked.every(Boolean)) { finishSession(); return; }
      const firstUnchecked = s.checked.findIndex((c) => !c);
      if (s.checked[s.pos]) { s.pos = firstUnchecked; renderQuestion(); showToast('Some questions are unchecked'); return; }
    }
    move(1);
  });
  $('checkBtn').addEventListener('click', checkCurrent);
  $('submitBtn').addEventListener('click', () => {
    const s = state.session;
    const test = getTest(s.testId); const doc = test.doc || test;
    const unanswered = s.order.filter((qIdx, pos) => !isAnswered(doc.questions[qIdx], s.responses[pos])).length;
    if (unanswered && !confirm(`${unanswered} question${unanswered > 1 ? 's' : ''} unanswered. Submit anyway?`)) return;
    finishSession();
  });
  $('quitBtn').addEventListener('click', () => { if (confirm('Quit this run? Progress is discarded.')) quitSession(); });
  $('flagBtn').addEventListener('click', () => {
    const s = state.session;
    s.flags[s.pos] = !s.flags[s.pos];
    saveState(); renderQuestion();
  });
  $('paletteHost').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-pos]');
    if (!cell) return;
    state.session.pos = parseInt(cell.dataset.pos, 10);
    renderQuestion();
  });

  // Results
  $('retakeBtn').addEventListener('click', () => {
    const s = state.session;
    openModeModal(s.testId);
  });
  $('retakeMissedBtn').addEventListener('click', () => {
    const s = state.session;
    const missed = state.lastSummary?.missed || [];
    if (!missed.length) return;
    startSession(s.testId, s.mode, { onlyIdxs: missed });
  });
  $('backToLibraryBtn').addEventListener('click', quitSession);

  // Format view
  $('copyPromptBtn').addEventListener('click', () => copyText(LLM_PROMPT, 'Prompt copied — add your topic'));
  $('copySchemaBtn').addEventListener('click', () => copyText(FORMAT_EXAMPLE, 'Example JSON copied'));
  $('backFromFormatBtn').addEventListener('click', () => { showView('library'); });

  // Keyboard
  document.addEventListener('keydown', onKey);
}

function selectOption(btn) {
  const s = state.session;
  const test = getTest(s.testId); const doc = test.doc || test;
  const q = doc.questions[s.order[s.pos]];
  if (s.mode === 'study' && s.checked[s.pos]) return;

  if (btn.dataset.bool !== undefined) {
    s.responses[s.pos] = btn.dataset.bool === 'true';
  } else {
    const optIdx = parseInt(btn.dataset.opt, 10);
    if (q.type === 'single') {
      s.responses[s.pos] = optIdx;
    } else {
      const cur = Array.isArray(s.responses[s.pos]) ? s.responses[s.pos] : [];
      s.responses[s.pos] = cur.includes(optIdx) ? cur.filter((i) => i !== optIdx) : [...cur, optIdx];
    }
  }
  saveState();
  renderQuestion();
}

function checkCurrent() {
  const s = state.session;
  if (s.mode !== 'study' || s.checked[s.pos]) return;
  const test = getTest(s.testId); const doc = test.doc || test;
  if (!isAnswered(doc.questions[s.order[s.pos]], s.responses[s.pos])) return;
  s.checked[s.pos] = true;
  saveState();
  renderQuestion();
}

function move(delta) {
  const s = state.session;
  const next = s.pos + delta;
  if (next < 0 || next >= s.order.length) return;
  s.pos = next;
  saveState();
  renderQuestion();
}

function onKey(e) {
  const s = state.session;
  if (!s || $('view-runner').hidden) return;
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  if (typing && e.key !== 'Enter') return;

  if (e.key === 'ArrowLeft' && !typing) move(-1);
  else if (e.key === 'ArrowRight' && !typing) move(1);
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (s.mode === 'study' && !s.checked[s.pos]) checkCurrent();
    else $('nextBtn').click();
  } else if (/^[1-9]$/.test(e.key) && !typing) {
    const nth = $('optionsHost').querySelectorAll('.proctor-option')[parseInt(e.key, 10) - 1];
    if (nth && !nth.disabled) selectOption(nth);
  } else if ((e.key === 'f' || e.key === 'F') && !typing && s.mode === 'exam') {
    $('flagBtn').click();
  }
}
