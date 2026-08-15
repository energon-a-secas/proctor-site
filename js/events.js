// ── Event wiring + session lifecycle ─────────────────────────

import { $, showToast, shuffled, copyText, b64urlEncode, downloadFile } from './utils.js';
import { mdBlock } from './md.js';
import {
  state, saveState, addTest, removeTest, updateTest, getTest, recordResult, saveNote,
  recordQuestionStats, weakIdxs,
} from './state.js';
import { parseTest } from './parser.js';
import { isAnswered, gradeQuestion, responseText, correctText } from './grader.js';
import {
  showView, renderLibrary, renderRunner, renderQuestion, renderPalette,
  renderResults, renderTimer, FORMAT_EXAMPLE, review, renderReview, renderProgress,
  usedFacets, facetFilterHtml, matchesFilter, resetReviewFilter,
  testWithNotes, testAsMarkdown,
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
- Group questions with "domain" (blueprint section or scenario) and "subdomain" (the
  split inside it). Use "category" for a free topic tag.
- Shared context — a scenario, a system description, a dataset every question refers
  to — goes in that domain's "description" in the top-level "domains" list, written
  ONCE. Never repeat it at the start of each "prompt": Proctor shows the description
  itself, and a repeated preamble is duplicated on every screen.
- Each "prompt" contains only what that question asks.
- 10 to 20 questions, mixed types. "timeLimitMinutes" and "passingScore" are optional.

My topic: `;

// ── Session lifecycle ────────────────────────────────────────

let pendingTestId = null;

let shownAt = null; // when the current question appeared — per-question time source

/** Book the time spent on the current question before leaving it. */
function bookTime() {
  const s = state.session;
  if (!s || s.done || shownAt === null || !s.times) return;
  s.times[s.pos] = (s.times[s.pos] || 0) + (Date.now() - shownAt) / 1000;
  shownAt = Date.now();
}

function startSession(id, mode, { shuffleQ, shuffleO, onlyIdxs, drawCount, timeLimitMin, facetFilter } = {}) {
  const entry = getTest(id);
  if (!entry) { showToast('Test not found'); return; }
  const test = entry.doc || entry;
  // Facet selection narrows the pool first; Draw N then samples what is left.
  // An empty selection is refused in the mode modal, before it gets here.
  let order = onlyIdxs ?? test.questions
    .map((_, i) => i)
    .filter((i) => !facetFilter || matchesFilter(test.questions[i], facetFilter));
  // Random slice of the bank: "ensure" questions are always in, the rest
  // are drawn by lottery up to the requested count.
  if (!onlyIdxs && drawCount && drawCount < order.length) {
    const ensured = order.filter((i) => test.questions[i].ensure);
    const pool = shuffled(order.filter((i) => !test.questions[i].ensure));
    order = [...ensured, ...pool.slice(0, Math.max(0, drawCount - ensured.length))].sort((a, b) => a - b);
  }
  if (shuffleQ) order = shuffled(order);
  const optionOrders = order.map((qIdx) => {
    const q = test.questions[qIdx];
    if (!q.options) return null;
    const idxs = q.options.map((_, i) => i);
    return shuffleO ? shuffled(idxs) : idxs;
  });
  // Time limit: blank = the test's own, 0 = explicitly no timer, N = N minutes
  const limitMin = timeLimitMin ?? test.timeLimitMinutes;
  state.session = {
    testId: id,
    mode,
    order,
    optionOrders,
    responses: new Array(order.length).fill(null),
    checked: new Array(order.length).fill(false),
    flags: new Array(order.length).fill(false),
    times: new Array(order.length).fill(0),
    pos: 0,
    startedAt: Date.now(),
    finishedAt: null,
    timeLimitS: mode === 'exam' && limitMin ? limitMin * 60 : null,
    done: false,
  };
  saveState();
  showView('runner');
  renderRunner();
  shownAt = Date.now();
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
  bookTime();
  shownAt = null;
  stopTimer();
  s.done = true;
  s.finishedAt = Date.now();
  renderResults();
  const test = getTest(s.testId);
  // Progress cards chart one breakdown: the domain split when the test has one,
  // otherwise categories.
  const sum = state.lastSummary;
  const facet = Object.keys(sum.perFacet.domain).length > 1 ? 'domain' : 'category';
  recordResult(s.testId, test ? test.title : '?', s.mode, sum.scorePct, sum.perFacet[facet], facet);
  if (!state.embed && test) {
    const doc = test.doc || test;
    recordQuestionStats(s.testId, s.order.map((qIdx, pos) => {
      const q = doc.questions[qIdx];
      return { qid: q.id, correct: gradeQuestion(q, s.responses[pos]) };
    }));
  }
  showView('results');
}

function quitSession() {
  stopTimer();
  shownAt = null;
  state.session = null;
  saveState();
  renderLibrary();
  showView('library');
}

function resumeSession() {
  const s = state.session;
  if (!s) return;
  if (!s.times) s.times = new Array(s.order.length).fill(0); // pre-1.5 session
  showView('runner');
  renderRunner();
  shownAt = Date.now();
  if (s.timeLimitS) {
    // Resume budget: original limit minus time already spent before the reload.
    const spent = Math.round((Date.now() - s.startedAt) / 1000);
    const left = Math.max(30, s.timeLimitS - spent);
    startTimer(left, renderTimer, () => { showToast('Time is up — submitting'); finishSession(); });
  }
}

// ── Import pipeline ──────────────────────────────────────────

function handleRawText(text, source, { onError, name } = {}) {
  const result = parseTest(text, { name });
  if (result.error) {
    if (onError) onError(result.error);
    else showToast(result.error.split('\n')[0]);
    return false;
  }
  const id = addTest(result.test, source, result.notes);
  renderLibrary();
  openModeModal(id);
  return true;
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => handleRawText(String(reader.result), 'file', { name: file.name });
  reader.onerror = () => showToast('Could not read the file');
  reader.readAsText(file);
}

// ── Modals ───────────────────────────────────────────────────

function openModal(id) { $(id).hidden = false; $(id).querySelector('.modal__dialog').focus(); }
function closeModals() { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); }

/** Which domains/subdomains/categories the next run draws from. Reset per test. */
let modeFilter = { domain: [], subdomain: [], category: [] };

function pendingDoc() {
  const t = pendingTestId ? getTest(pendingTestId) : null;
  return t ? (t.doc || t) : null;
}

/** Refresh the mode modal's facet chips, pool size, and Draw N bounds. */
function renderModeFacets() {
  const doc = pendingDoc();
  if (!doc) return;
  const facets = usedFacets(doc);
  $('modeFacets').hidden = facets.length === 0;
  $('modeFacets').innerHTML = facets.length ? facetFilterHtml(doc, modeFilter) : '';
  const pool = doc.questions.filter((q) => matchesFilter(q, modeFilter)).length;
  $('modeTestName').textContent = pool === doc.questions.length
    ? `${doc.title} · ${doc.questions.length} questions`
    : `${doc.title} · ${pool} of ${doc.questions.length} questions selected`;
  $('drawCount').max = String(pool);
  $('drawCount').placeholder = String(pool);
}

function openModeModal(id) {
  pendingTestId = id;
  const t = getTest(id);
  modeFilter = { domain: [], subdomain: [], category: [] };
  $('drawCount').value = '';
  renderModeFacets();
  if (!t) $('modeTestName').textContent = '';
  $('timeLimitInput').value = '';
  $('timeLimitInput').placeholder = (t && (t.doc || t).timeLimitMinutes) ? String((t.doc || t).timeLimitMinutes) : 'none';
  const weak = t ? weakIdxs(id, t.doc || t) : [];
  $('weakRow').hidden = weak.length === 0;
  $('weakCount').textContent = weak.length
    ? `${weak.length} question${weak.length > 1 ? 's' : ''} you keep missing`
    : '';
  openModal('modeModal');
}

// ── Wiring ───────────────────────────────────────────────────

export function initEvents() {
  // Header
  $('loadTestBtn').addEventListener('click', () => { showView('library'); $('dropzone').scrollIntoView({ block: 'center' }); });
  $('progressBtn').addEventListener('click', () => { renderProgress(); showView('progress'); });
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
    // Close only the paste dialog — handleRawText just opened the mode picker,
    // and closeModals() here would shut it too, making success look like nothing.
    if (ok) $('pasteModal').hidden = true;
  });

  $('practiceWeakBtn').addEventListener('click', () => {
    if (!pendingTestId) return;
    const t = getTest(pendingTestId);
    const idxs = weakIdxs(pendingTestId, t.doc || t);
    if (!idxs.length) return;
    closeModals();
    startSession(pendingTestId, 'study', { onlyIdxs: idxs });
  });

  // Modal close (backdrop, X, Cancel, Esc)
  document.querySelectorAll('[data-modal-close]').forEach((el) => el.addEventListener('click', closeModals));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (openMenuIsVisible()) {
      const menu = [...document.querySelectorAll('.proctor-menu')].find((m) => !m.querySelector('.proctor-menu__panel').hidden);
      openMenu(null);
      menu?.querySelector('.proctor-menu__toggle')?.focus();
      return;
    }
    closeModals();
  });

  // Mode modal
  document.querySelectorAll('.proctor-mode-card').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (!pendingTestId) { closeModals(); return; }
      if (btn.dataset.mode === 'review') { closeModals(); openReview(pendingTestId); return; }
      // Refuse an empty selection here, with the modal still open, so the chips
      // that produced it are one click away from being fixed.
      const doc = pendingDoc();
      if (doc && !doc.questions.some((q) => matchesFilter(q, modeFilter))) {
        showToast('That filter leaves no questions'); return;
      }
      closeModals();
      const mode = btn.dataset.mode === 'exam' ? 'exam' : 'study';
      const draw = parseInt($('drawCount').value, 10);
      const rawTime = $('timeLimitInput').value.trim();
      const time = parseInt(rawTime, 10);
      const opts = {
        shuffleQ: $('shuffleQuestions').checked,
        shuffleO: $('shuffleOptions').checked,
        drawCount: Number.isFinite(draw) && draw > 0 ? draw : null,
        timeLimitMin: rawTime === '' || !Number.isFinite(time) ? null : Math.max(0, time),
        facetFilter: modeFilter,
      };
      startSession(pendingTestId, mode, opts);
    }));

  // Facet chips: mode modal (narrows the run) and review (narrows the list)
  $('modeFacets').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-facet]');
    if (!chip) return;
    toggleFacet(modeFilter, chip.dataset.facet, chip.dataset.value);
    renderModeFacets();
  });
  $('reviewFacets').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-facet]');
    if (!chip) return;
    toggleFacet(review.filter, chip.dataset.facet, chip.dataset.value);
    review.page = 0;
    renderReview();
  });

  // Library cards (delegated)
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.proctor-testcard');
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!card || !action) return;
    const id = card.dataset.testId;
    if (action === 'start') openModeModal(id);
    if (action === 'review') openReview(id);
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
    bookTime();
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
  $('exportCsvBtn').addEventListener('click', () => {
    const s = state.session;
    if (!s) return;
    const test = getTest(s.testId); const doc = test.doc || test;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['n', 'domain', 'subdomain', 'category', 'prompt', 'your_answer', 'correct_answer', 'correct', 'points', 'seconds'].join(',')];
    s.order.forEach((qIdx, pos) => {
      const q = doc.questions[qIdx];
      const ok = gradeQuestion(q, s.responses[pos]);
      rows.push([pos + 1, esc(q.domain), esc(q.subdomain), esc(q.category), esc(q.prompt), esc(responseText(q, s.responses[pos])),
        esc(correctText(q)), ok ? 'yes' : 'no', q.points, Math.round(s.times?.[pos] || 0)].join(','));
    });
    rows.push(['', '', '', '', esc(`TOTAL ${state.lastSummary.scorePct}%`), '', '', '', `${state.lastSummary.points}/${state.lastSummary.maxPoints}`].join(','));
    const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    downloadFile(`proctor-${slug}-${new Date().toISOString().slice(0, 10)}.csv`, rows.join('\n'), 'text/csv');
    showToast('Results CSV downloaded');
  });

  // Format view
  $('copyPromptBtn').addEventListener('click', () => copyText(LLM_PROMPT, 'Prompt copied — add your topic'));
  $('copySchemaBtn').addEventListener('click', () => copyText(FORMAT_EXAMPLE, 'Example JSON copied'));
  $('backFromFormatBtn').addEventListener('click', () => { showView('library'); });

  // Review mode
  // Dropdown menus in the Review toolbar — one controller, two menus
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.proctor-menu__toggle');
    if (!btn) return;
    e.stopPropagation();
    const menu = btn.closest('.proctor-menu');
    openMenu(menu.querySelector('.proctor-menu__panel').hidden ? menu : null);
  });
  $('reviewVisibilityPanel').addEventListener('change', (e) => {
    const key = e.target.dataset.visibility;
    if (!key) return;
    state.review[key] = e.target.checked;
    saveState();
    renderReview();          // rebuilds the panel; reopening keeps it in place
    openMenu(menuByName('visibility'));
  });
  $('reviewPerPagePanel').addEventListener('change', (e) => {
    const n = e.target.dataset.perpage;
    if (n === undefined) return;
    state.review.perPage = parseInt(n, 10);
    review.page = 0;
    saveState();
    renderReview();
    openMenu(null);          // a one-shot choice: picking it is the end of it
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.proctor-menu')) openMenu(null);
  });
  $('reviewPager').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    const p = btn.dataset.page;
    if (p === 'prev') review.page -= 1;
    else if (p === 'next') review.page += 1;
    else review.page = parseInt(p, 10);
    renderReview();
    $('reviewList').scrollIntoView({ block: 'start' });
  });
  $('reviewPdfBtn').addEventListener('click', () => { openMenu(null); window.print(); });

  // Downloads: the filtered slice, with your notes in it
  $('reviewJsonBtn').addEventListener('click', () => {
    openMenu(null);
    const doc = reviewDoc();
    if (!doc) return;
    downloadFile(exportName(doc.test, 'json'), JSON.stringify(testWithNotes(review.testId, {
      ...doc.test, questions: doc.questions,
    }), null, 2), 'application/json');
    showToast('JSON downloaded — notes included');
  });
  $('reviewMdBtn').addEventListener('click', () => {
    openMenu(null);
    const doc = reviewDoc();
    if (!doc) return;
    downloadFile(exportName(doc.test, 'md'), testAsMarkdown(review.testId, doc.test, doc.questions), 'text/markdown');
    showToast('Markdown downloaded');
  });

  // Edit source — replaces the document in place, keeping the test's id
  $('reviewEditBtn').addEventListener('click', () => openEditor(review.testId));
  $('editCopyBtn').addEventListener('click', () => copyText($('editInput').value, 'JSON copied'));
  $('editSaveBtn').addEventListener('click', saveEditor);
  $('reviewShareBtn').addEventListener('click', () => {
    openMenu(null);
    const entry = getTest(review.testId);
    if (!entry) return;
    const encoded = b64urlEncode(JSON.stringify(entry.doc || entry));
    if (encoded.length > 12000) { showToast('Too big to share as a link — send the file instead'); return; }
    copyText(`${location.origin}${location.pathname}#t=${encoded}`, 'Share link copied — the test travels inside it');
  });
  $('reviewBackBtn').addEventListener('click', () => { showView('library'); renderLibrary(); });
  $('reviewEmbedBtn').addEventListener('click', () => {
    openMenu(null);
    const entry = getTest(review.testId);
    if (!entry) return;
    const doc = entry.doc || entry;
    const encoded = b64urlEncode(JSON.stringify(doc));
    if (encoded.length > 12000) { showToast('Too big to embed via URL — host the file and use ?src= instead'); return; }
    const src = `${location.origin}${location.pathname}?embed=1&mode=study#t=${encoded}`;
    const snippet = `<iframe src="${src}"\n  width="100%" height="640" loading="lazy" style="border:0;border-radius:12px"\n  title="${doc.title.replace(/"/g, '&quot;')} — Proctor"></iframe>`;
    copyText(snippet, 'Embed code copied — paste it into any page');
  });
  // Notes: one implementation for the runner, the results recap, and Review.
  // Each block carries its own test and question id, so these listeners live on
  // the document rather than on any one view's container.
  let noteTimer = null;
  document.addEventListener('input', (e) => {
    const block = e.target.classList?.contains('proctor-note-input') ? e.target.closest('.proctor-note') : null;
    if (!block) return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(block.dataset.noteTest, block.dataset.noteQid, e.target.value), 400);
  });
  document.addEventListener('click', (e) => {
    const view = e.target.closest('.proctor-note-view');
    if (view && !e.target.closest('a')) { openNoteEditor(view); return; }
    // In Review, clicking a question also tells the arrows where to resume from
    const item = e.target.closest('.proctor-review-item');
    if (!item || e.target.closest('input, textarea, a, button')) return;
    const shown = parseInt(item.dataset.shown, 10);
    if (Number.isFinite(shown) && shown !== review.cursor) {
      review.cursor = shown;
      renderReview();
    }
  });
  document.addEventListener('keydown', (e) => {
    const view = e.target.closest?.('.proctor-note-view');
    if (view && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNoteEditor(view); }
  });
  document.addEventListener('focusout', (e) => {
    const block = e.target.classList?.contains('proctor-note-input') ? e.target.closest('.proctor-note') : null;
    if (!block) return;
    const text = e.target.value;
    clearTimeout(noteTimer);
    saveNote(block.dataset.noteTest, block.dataset.noteQid, text);
    const view = block.querySelector('.proctor-note-view');
    const print = block.querySelector('.proctor-note-print');
    view.classList.toggle('proctor-note-view--empty', !text.trim());
    view.innerHTML = text.trim() ? mdBlock(text) : 'Add a note — markdown works here';
    if (print) print.innerHTML = mdBlock(text);
    view.hidden = false;
    e.target.hidden = true;
  });

  // Keyboard
  document.addEventListener('keydown', onKey);
}

// Every dropdown on the page is a `.proctor-menu`; opening one closes the rest.
// Driven off the DOM rather than a fixed list so a menu rendered into innerHTML
// works without being registered anywhere.
function openMenu(menu) {
  document.querySelectorAll('.proctor-menu').forEach((el) => {
    const open = el === menu;
    el.querySelector('.proctor-menu__toggle')?.setAttribute('aria-expanded', String(open));
    const panel = el.querySelector('.proctor-menu__panel');
    if (panel) panel.hidden = !open;
  });
}

function menuByName(name) {
  return document.querySelector(`.proctor-menu[data-menu="${name}"]`);
}

function openMenuIsVisible() {
  return [...document.querySelectorAll('.proctor-menu__panel')].some((p) => !p.hidden);
}

function toggleFacet(filter, key, value) {
  if (key === 'noted') { filter.noted = !filter.noted; return; }
  const list = filter[key];
  if (!list) return;
  const at = list.indexOf(value);
  if (at === -1) list.push(value);
  else list.splice(at, 1);
}

/** Walk the filtered question list one at a time. Crossing a page boundary
 *  turns the page, so paging is something the arrows do for you rather than a
 *  separate thing to drive. */
function moveReviewCursor(delta) {
  if (!review.visibleCount) return;
  const next = Math.min(review.visibleCount - 1, Math.max(0, review.cursor + delta));
  if (next === review.cursor && document.querySelector('.proctor-review-item--current')) return;
  review.cursor = next;
  const page = review.perPage > 0 ? Math.floor(next / review.perPage) : 0;
  if (page !== review.page) review.page = page;
  renderReview();
  const el = document.querySelector('.proctor-review-item--current');
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** What Review is currently showing: the test, and the questions surviving its
 *  filter. Both downloads export that slice, matching what Export PDF prints. */
function reviewDoc() {
  const entry = getTest(review.testId);
  if (!entry) return null;
  const test = entry.doc || entry;
  return { test, questions: test.questions.filter((q) => matchesFilter(q, review.filter)) };
}

function exportName(test, ext) {
  const slug = test.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `proctor-${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

// ── Source editor ────────────────────────────────────────────

let editingId = null;

function openEditor(id) {
  const entry = id ? state.tests[id] : null;
  if (!entry) {
    // Samples live in memory and reload from data/ on every visit, so an edit
    // to one could not persist. Say so instead of opening an editor that lies.
    showToast('Samples cannot be edited — load your own copy first');
    return;
  }
  editingId = id;
  $('editInput').value = JSON.stringify(entry.doc, null, 2);
  $('editError').hidden = true;
  const running = state.session && !state.session.done && state.session.testId === id;
  $('editNote').textContent = running
    ? 'Saving replaces the test and discards the run you have in progress. Notes and history are kept.'
    : 'Notes, per-question stats and run history follow the question ids — reordering questions without explicit "id" fields moves the notes with the position, not the question.';
  $('editNote').classList.toggle('proctor-edit-note--warn', !!running);
  openModal('editModal');
}

function saveEditor() {
  if (!editingId) return;
  const result = parseTest($('editInput').value);
  if (result.error) {
    $('editError').textContent = result.error;
    $('editError').hidden = false;
    return;
  }
  // A run holds indexes into the old question list; keeping it after an edit
  // would answer the wrong questions.
  if (state.session && !state.session.done && state.session.testId === editingId) {
    stopTimer();
    state.session = null;
  }
  updateTest(editingId, result.test);
  Object.entries(result.notes || {}).forEach(([qid, text]) => saveNote(editingId, qid, text));
  closeModals();
  renderLibrary();
  if (review.testId === editingId && !$('view-review').hidden) {
    review.cursor = 0;
    review.page = 0;
    resetReviewFilter();
    renderReview();
  }
  showToast('Saved — notes and history kept');
  editingId = null;
}

function openNoteEditor(view) {
  const ta = view.parentElement.querySelector('.proctor-note-input');
  view.hidden = true;
  ta.hidden = false;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

export function openReview(id) {
  review.testId = id;
  review.page = 0;
  resetReviewFilter();
  openMenu(null);
  showView('review');
  renderReview();
}

/** Start a run directly (embed mode boots through this — no mode modal). */
export function startRun(id, mode, { drawCount, timeLimitMin } = {}) {
  startSession(id, mode === 'exam' ? 'exam' : 'study', { drawCount, timeLimitMin });
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
  bookTime();
  s.pos = next;
  saveState();
  renderQuestion();
}

function onKey(e) {
  if (!$('view-review').hidden) {
    const typing = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT';
    if (typing) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); moveReviewCursor(-1); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); moveReviewCursor(1); }
    else if (e.key === 'Home') { e.preventDefault(); moveReviewCursor(-review.visibleCount); }
    else if (e.key === 'End') { e.preventDefault(); moveReviewCursor(review.visibleCount); }
    return;
  }
  const s = state.session;
  if (!s || $('view-runner').hidden) return;
  // A note is prose: every key belongs to it, Enter included. The fill-in input
  // is the one field where Enter still means "check this answer".
  if (e.target.closest('.proctor-note')) return;
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
