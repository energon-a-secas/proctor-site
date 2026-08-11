// ── Shared state + localStorage persistence ──────────────────

const KEY = 'proctor_v1';

export const state = {
  tests: {},       // id -> { id, title, description, category, count, addedAt, source, doc }
  samples: [],     // loaded at boot from data/, never persisted
  session: null,   // { testId, sample, mode, order[], responses[], checked[], flags[], pos, startedAt, timeLimitS, done }
  lastSummary: null,
  history: [],     // [{ title, mode, scorePct, at }] newest first, capped
  notes: {},       // testId -> { questionId: "personal note" }
  review: { perPage: 10, showAnswers: true, showNotes: false, onlyCorrect: false },
  embed: false,    // ?embed=1 iframe mode: fully in-memory, never touches storage
};

export function saveState() {
  if (state.embed) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      tests: state.tests,
      history: state.history,
      session: state.session,
      notes: state.notes,
      review: state.review,
    }));
  } catch { /* storage full or blocked — the app still works for this session */ }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.tests = data.tests || {};
    state.history = data.history || [];
    state.session = data.session || null;
    if (state.session && state.session.done) state.session = null;
    state.notes = data.notes || {};
    state.review = { perPage: 10, showAnswers: true, showNotes: false, onlyCorrect: false, ...(data.review || {}) };
  } catch { /* corrupted storage — start fresh */ }
}

/** Stable id for a test document: slug + short content hash. */
export function testId(doc) {
  const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  let h = 0;
  const s = JSON.stringify(doc);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${slug}-${(h >>> 0).toString(36)}`;
}

export function addTest(doc, source) {
  const id = testId(doc);
  state.tests[id] = {
    id,
    title: doc.title,
    description: doc.description,
    category: doc.category,
    count: doc.questions.length,
    addedAt: Date.now(),
    source,
    doc,
  };
  saveState();
  return id;
}

export function removeTest(id) {
  delete state.tests[id];
  if (state.session?.testId === id) state.session = null;
  saveState();
}

export function getTest(id) {
  if (state.tests[id]) return state.tests[id];
  return state.samples.find((s) => s.id === id) || null;
}

export function recordResult(id, title, mode, scorePct, cats) {
  state.history.unshift({ id, title, mode, scorePct, at: Date.now(), cats: cats || null });
  state.history = state.history.slice(0, 50);
  saveState();
}

export function saveNote(tid, qid, text) {
  if (!state.notes[tid]) state.notes[tid] = {};
  if (text.trim()) state.notes[tid][qid] = text;
  else delete state.notes[tid][qid];
  saveState();
}

export function getNote(tid, qid) {
  return state.notes[tid]?.[qid] || '';
}
