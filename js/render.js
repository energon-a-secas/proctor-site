// ── DOM rendering for every view ─────────────────────────────

import { $, escHtml } from './utils.js';
import { mdInline, mdBlock } from './md.js';
import { state, getTest, getNote, weakIdxs } from './state.js';
import { gradeQuestion, isAnswered, correctText, responseText, summarize, FACETS } from './grader.js';
import { formatClock } from './timer.js';

const VIEWS = ['library', 'runner', 'results', 'format', 'review', 'progress'];

export function showView(name) {
  VIEWS.forEach((v) => { $(`view-${v}`).hidden = v !== name; });
  window.scrollTo({ top: 0 });
}

// ── Facets: domain / subdomain / category ────────────────────
// A test declares whichever groupings it has. Everything that shows or filters
// by them reads these helpers, so a test with no groupings renders no chrome.

/** Distinct values of one facet, in document order. */
export function facetValues(test, key) {
  if (key === 'domain' && test.domains?.length) return test.domains.map((d) => d.name);
  const seen = [];
  test.questions.forEach((q) => { if (q[key] && !seen.includes(q[key])) seen.push(q[key]); });
  return seen;
}

/** The facets this test actually groups by — a facet with one value groups nothing. */
export function usedFacets(test) {
  return FACETS.map(({ key, label }) => ({ key, label, values: facetValues(test, key) }))
    .filter((f) => f.values.length > 1);
}

export function domainInfo(test, name) {
  if (!name) return null;
  return test.domains?.find((d) => d.name === name) || null;
}

/** The domain/subdomain/category chips for one question. */
export function tagChips(q) {
  return FACETS
    .filter(({ key }) => q[key])
    .map(({ key }) => `<span class="proctor-chip proctor-chip--${key}">${escHtml(q[key])}</span>`)
    .join('');
}

/** True when a question passes a { domain: [], subdomain: [], category: [] }
 *  selection. An empty list for a facet means "every value". */
export function matchesFilter(q, filter) {
  return FACETS.every(({ key }) => {
    const picked = filter[key];
    return !picked || picked.length === 0 || picked.includes(q[key]);
  });
}

/** What Review can show or hide. Every entry is phrased as a thing shown, so
 *  an unchecked box always means "hidden" — `onlyCorrect`-style inverted names
 *  read backwards in a menu. `when` keeps an option out of the list entirely
 *  when the test has nothing for it to act on. */
export const VISIBILITY = [
  { key: 'showAnswers', label: 'Answer key', hint: 'the check mark on the correct option' },
  { key: 'showWhy', label: 'Explanations', hint: 'the "Why" under each question' },
  { key: 'showWrong', label: 'Wrong options', hint: 'off leaves only the correct one' },
  { key: 'showNotes', label: 'Your notes', hint: 'editable, markdown' },
  {
    key: 'showTags', label: 'Tags', hint: 'domain, subdomain, and category chips',
    when: (test) => usedFacets(test).length > 0,
  },
  {
    key: 'showScenario', label: 'Scenario', hint: 'the domain heading and its shared context',
    when: (test) => (test.domains || []).some((d) => d.description),
  },
];

/** The options that apply to this test, with their current values. */
export function visibilityItems(test) {
  return VISIBILITY.filter((it) => !it.when || it.when(test))
    .map((it) => ({ ...it, on: state.review[it.key] !== false }));
}

/** Toggle chips for every facet the test uses. `filter` marks the active ones. */
export function facetFilterHtml(test, filter) {
  return usedFacets(test).map(({ key, label, values }) => `
    <div class="proctor-facet-row">
      <span class="proctor-facet-row__label">${label.replace('By ', '')}</span>
      <div class="proctor-facet-row__chips">
        ${values.map((v) => `
          <button type="button" class="proctor-facet-chip ${filter[key]?.includes(v) ? 'proctor-facet-chip--on' : ''}"
                  data-facet="${key}" data-value="${escHtml(v)}" aria-pressed="${!!filter[key]?.includes(v)}">${escHtml(v)}</button>`).join('')}
      </div>
    </div>`).join('');
}

// ── Library ──────────────────────────────────────────────────

function testCard(t, { sample = false } = {}) {
  const meta = [
    `${t.count ?? t.doc?.questions.length ?? t.questions?.length} questions`,
    t.category ? escHtml(t.category) : null,
    t.timeLimit ? `${t.timeLimit} min` : null,
  ].filter(Boolean).join(' · ');
  return `
    <div class="card proctor-testcard" data-test-id="${escHtml(t.id)}">
      <h4>${escHtml(t.title)}</h4>
      ${t.description ? `<p class="proctor-testcard__desc">${escHtml(t.description)}</p>` : ''}
      <p class="proctor-testcard__meta">${meta}</p>
      <div class="toolbar proctor-testcard__actions">
        <button class="btn btn--primary btn--sm" data-action="start">Start</button>
        <button class="btn btn--secondary btn--sm" data-action="review">Review</button>
        ${sample ? '' : `
          <button class="btn btn--ghost btn--sm btn--icon proctor-iconbtn" data-action="share"
                  title="Copy a share link" aria-label="Copy a share link for ${escHtml(t.title)}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
          </button>
          <button class="btn btn--ghost btn--sm btn--icon proctor-iconbtn" data-action="remove"
                  title="Remove" aria-label="Remove ${escHtml(t.title)}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
          </button>`}
      </div>
    </div>`;
}

export function renderLibrary() {
  const samples = state.samples;
  $('sampleGrid').innerHTML = samples.map((s) => testCard({
    id: s.id, title: s.title, description: s.description,
    category: s.category, count: s.questions.length,
    timeLimit: s.timeLimitMinutes,
  }, { sample: true })).join('') || '<p class="proctor-empty">Samples failed to load — serve the site over HTTP.</p>';

  // Newest first: the test you just imported is the first card in the rail.
  const saved = Object.values(state.tests).sort((a, b) => b.addedAt - a.addedAt);
  $('savedSection').hidden = saved.length === 0 && !state.session;
  $('savedCount').textContent = saved.length > 1 ? `${saved.length} loaded · newest first` : '';
  let html = saved.map((t) => testCard({ ...t, timeLimit: t.doc.timeLimitMinutes })).join('');

  if (state.session && !state.session.done) {
    const t = getTest(state.session.testId);
    if (t) {
      const answeredCount = state.session.responses.filter((r, i) => {
        const test = t.doc || t;
        return isAnswered(test.questions[state.session.order[i]], r);
      }).length;
      html = `
        <div class="card proctor-testcard proctor-testcard--resume" data-test-id="${escHtml(state.session.testId)}">
          <h4>Resume: ${escHtml(t.title)}</h4>
          <p class="proctor-testcard__meta">${state.session.mode === 'exam' ? 'Simulator' : 'Study'} · ${answeredCount}/${state.session.order.length} answered</p>
          <div class="toolbar">
            <button class="btn btn--primary btn--sm" data-action="resume">Resume</button>
            <button class="btn btn--ghost btn--sm" data-action="discard">Discard</button>
          </div>
        </div>` + html;
    }
  }
  $('savedGrid').innerHTML = html;
}

// Inline so the scenario panel needs no network and no icon font.
const SCENARIO_ICON = `<svg class="proctor-scenario__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h11l5 5v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M14 5v6h6"/></svg>`;
const CHEVRON = `<svg class="proctor-scenario__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

// ── Runner ───────────────────────────────────────────────────

function activeTest() {
  const t = getTest(state.session.testId);
  return t ? (t.doc || t) : null;
}

export function renderRunner() {
  const s = state.session;
  const test = activeTest();
  if (!test) return;
  $('runner-title').textContent = test.title;
  $('modeChip').textContent = s.mode === 'exam' ? 'Simulator' : 'Study';
  $('timerDisplay').hidden = !(s.mode === 'exam' && s.timeLimitS);
  $('paletteHost').hidden = s.mode !== 'exam';
  $('checkBtn').hidden = s.mode !== 'study';
  $('submitBtn').hidden = s.mode !== 'exam';
  $('flagBtn').hidden = s.mode !== 'exam';
  renderQuestion();
}

export function renderTimer(secondsLeftNow) {
  const el = $('timerDisplay');
  el.textContent = formatClock(secondsLeftNow);
  el.classList.toggle('proctor-timer--low', secondsLeftNow <= 60);
}

export function renderQuestion() {
  const s = state.session;
  const test = activeTest();
  const q = test.questions[s.order[s.pos]];
  const resp = s.responses[s.pos];
  const checked = s.mode === 'study' && s.checked[s.pos];

  $('progressLabel').textContent = `${s.pos + 1} / ${s.order.length}`;
  $('progressFill').style.width = `${((s.pos + 1) / s.order.length) * 100}%`;

  // Pace: average booked time per visited question vs the per-question budget
  const pace = $('paceLabel');
  const visited = s.times ? s.times.filter((t) => t > 0).length : 0;
  if (s.mode === 'exam' && visited >= 1) {
    const avg = s.times.reduce((a, b) => a + b, 0) / visited;
    const budget = s.timeLimitS ? s.timeLimitS / s.order.length : null;
    pace.hidden = false;
    pace.textContent = `${Math.round(avg)}s/q${budget ? ` · budget ${Math.round(budget)}s` : ''}`;
    pace.classList.toggle('proctor-pace--over', !!budget && avg > budget);
  } else {
    pace.hidden = true;
  }
  $('questionTags').innerHTML = tagChips(q);

  // The domain's shared scenario, in its own slot instead of copy-pasted into
  // every prompt. It opens when you arrive in a new domain and stays folded
  // while you work through it.
  const scenario = $('questionScenario');
  const info = domainInfo(test, q.domain);
  if (info?.description) {
    const prev = s.pos > 0 ? test.questions[s.order[s.pos - 1]] : null;
    scenario.hidden = false;
    // Rebuilt only when the domain changes. renderQuestion runs on every option
    // click, and rewriting the panel each time would undo a fold the reader
    // asked for while answering.
    if (scenario.dataset.domain !== info.name) {
      scenario.dataset.domain = info.name;
      const inRun = s.order.filter((idx) => test.questions[idx].domain === q.domain).length;
      scenario.innerHTML = `
        <details class="proctor-scenario" ${prev && prev.domain === q.domain ? '' : 'open'}>
          <summary class="proctor-scenario__head">
            ${SCENARIO_ICON}
            <span class="proctor-scenario__label">Scenario</span>
            <span class="proctor-scenario__name">${escHtml(info.name)}</span>
            <span class="proctor-scenario__count">${inRun} question${inRun === 1 ? '' : 's'}</span>
            ${CHEVRON}
          </summary>
          <div class="proctor-scenario__body proctor-md">${mdBlock(info.description)}</div>
        </details>`;
    }
  } else {
    scenario.hidden = true;
    scenario.innerHTML = '';
    delete scenario.dataset.domain;
  }
  $('questionPrompt').innerHTML = mdBlock(q.prompt);
  $('flagBtn').setAttribute('aria-pressed', String(!!s.flags[s.pos]));
  $('flagBtn').classList.toggle('proctor-flagged', !!s.flags[s.pos]);

  const hints = {
    single: 'Pick one answer',
    multi: 'Pick every answer that applies',
    truefalse: 'True or false?',
    fill: 'Type the answer',
  };
  $('questionHint').textContent = hints[q.type];

  const host = $('optionsHost');
  const optionIdxs = s.optionOrders[s.pos] ?? q.options?.map((_, i) => i);
  if (q.type === 'single' || q.type === 'multi') {
    host.innerHTML = optionIdxs.map((optIdx, shown) => {
      const selected = q.type === 'single' ? resp === optIdx : Array.isArray(resp) && resp.includes(optIdx);
      let cls = 'proctor-option';
      if (selected) cls += ' proctor-option--selected';
      if (checked) {
        const isCorrect = q.type === 'single' ? optIdx === q.answer : q.answers.includes(optIdx);
        if (isCorrect) cls += ' proctor-option--correct';
        else if (selected) cls += ' proctor-option--wrong';
      }
      return `
        <button type="button" class="${cls}" data-opt="${optIdx}" ${checked ? 'disabled' : ''}
                role="${q.type === 'single' ? 'radio' : 'checkbox'}" aria-checked="${selected}">
          <span class="proctor-option__key">${shown + 1}</span>
          <span>${mdInline(q.options[optIdx])}</span>
        </button>`;
    }).join('');
  } else if (q.type === 'truefalse') {
    host.innerHTML = [true, false].map((val, shown) => {
      const selected = resp === val;
      let cls = 'proctor-option';
      if (selected) cls += ' proctor-option--selected';
      if (checked) {
        if (val === q.answer) cls += ' proctor-option--correct';
        else if (selected) cls += ' proctor-option--wrong';
      }
      return `
        <button type="button" class="${cls}" data-bool="${val}" ${checked ? 'disabled' : ''}
                role="radio" aria-checked="${selected}">
          <span class="proctor-option__key">${shown + 1}</span><span>${val ? 'True' : 'False'}</span>
        </button>`;
    }).join('');
  } else { // fill
    host.innerHTML = `
      <input type="text" class="proctor-fill" id="fillInput" autocomplete="off" spellcheck="false"
             placeholder="Type your answer" value="${escHtml(resp ?? '')}" ${checked ? 'disabled' : ''}>`;
  }

  const fb = $('feedbackPanel');
  if (checked) {
    const correct = gradeQuestion(q, resp);
    fb.hidden = false;
    fb.className = `proctor-feedback ${correct ? 'proctor-feedback--correct' : 'proctor-feedback--wrong'}`;
    $('feedbackVerdict').textContent = correct ? 'Correct' : `Not quite — the answer is: ${correctText(q)}`;
    $('feedbackExplanation').innerHTML = mdBlock(q.explanation || '');
    $('feedbackExplanation').hidden = !q.explanation;
  } else {
    fb.hidden = true;
  }

  if (s.mode === 'study') {
    $('checkBtn').disabled = checked || !isAnswered(q, resp);
    $('nextBtn').textContent = s.pos === s.order.length - 1 ? 'Finish' : 'Next';
  } else {
    $('nextBtn').textContent = s.pos === s.order.length - 1 ? 'Last question' : 'Next';
    renderPalette();
  }
  $('prevBtn').disabled = s.pos === 0;
}

export function renderPalette() {
  const s = state.session;
  const test = activeTest();
  $('paletteHost').innerHTML = s.order.map((qIdx, pos) => {
    const answered = isAnswered(test.questions[qIdx], s.responses[pos]);
    let cls = 'proctor-palette__cell';
    if (pos === s.pos) cls += ' proctor-palette__cell--current';
    if (answered) cls += ' proctor-palette__cell--answered';
    if (s.flags[pos]) cls += ' proctor-palette__cell--flagged';
    return `<button type="button" class="${cls}" data-pos="${pos}" aria-label="Question ${pos + 1}${answered ? ', answered' : ''}${s.flags[pos] ? ', flagged' : ''}">${pos + 1}</button>`;
  }).join('');
}

// ── Results ──────────────────────────────────────────────────

/** Score bars for one breakdown: [[name, { correct, total }], …]. */
function breakdownRows(rows) {
  return rows.map(([name, c]) => {
    const pct = Math.round((c.correct / c.total) * 100);
    return `
      <div class="proctor-cat">
        <span class="proctor-cat__name">${escHtml(name)}</span>
        <div class="proctor-cat__bar"><div class="proctor-cat__fill" style="width:${pct}%"></div></div>
        <span class="proctor-cat__score">${c.correct}/${c.total}</span>
      </div>`;
  }).join('');
}

export function renderResults() {
  const s = state.session;
  const test = activeTest();
  const sum = summarize(test, s);
  state.lastSummary = sum;

  const timeUsed = s.finishedAt && s.startedAt ? Math.round((s.finishedAt - s.startedAt) / 1000) : null;
  const booked = s.times ? s.times.reduce((a, b) => a + b, 0) : 0;
  const avgQ = booked > 0 ? Math.round(booked / s.order.length) : null;
  $('scoreCard').innerHTML = `
    <div class="proctor-score__pct ${sum.scorePct >= 70 ? 'proctor-score__pct--good' : ''}">${sum.scorePct}%</div>
    <div class="proctor-score__detail">
      <p><strong>${escHtml(test.title)}</strong> · ${s.mode === 'exam' ? 'Simulator' : 'Study'}</p>
      <p>${sum.points} of ${sum.maxPoints} points${timeUsed !== null ? ` · ${formatClock(timeUsed)} used` : ''}${avgQ !== null ? ` · ${avgQ}s/question` : ''}</p>
      ${sum.passed !== null ? `<span class="proctor-chip ${sum.passed ? 'proctor-chip--pass' : 'proctor-chip--fail'}">${sum.passed ? `Passed (needs ${test.passingScore}%)` : `Below the ${test.passingScore}% pass mark`}</span>` : ''}
    </div>`;

  $('categoryBreakdown').innerHTML = FACETS.map(({ key, label }) => {
    const rows = Object.entries(sum.perFacet[key]);
    if (rows.length < 2) return '';
    return `
      <h3 class="proctor-subhead">${label}</h3>
      <div class="card">${breakdownRows(rows)}</div>`;
  }).join('');

  $('retakeMissedBtn').hidden = sum.missed.length === 0;
  $('reviewHost').innerHTML = `
    <h3 class="proctor-subhead">Review</h3>
    ${s.order.map((qIdx, pos) => {
      const q = test.questions[qIdx];
      const resp = s.responses[pos];
      const correct = gradeQuestion(q, resp);
      const secs = s.times?.[pos] ? Math.round(s.times[pos]) : null;
      const maxT = s.times ? Math.max(...s.times) : 0;
      return `
        <div class="card proctor-review ${correct ? '' : 'proctor-review--wrong'}">
          <div class="proctor-review__prompt proctor-md"><span class="proctor-review__n">${pos + 1}</span><div>${mdBlock(q.prompt)}</div>${secs !== null ? `<span class="proctor-review__time ${s.times[pos] === maxT && s.order.length > 1 ? 'proctor-review__time--slow' : ''}">${secs}s</span>` : ''}</div>
          <p class="proctor-review__line">${correct ? '✓' : '✗'} Your answer: <strong>${mdInline(responseText(q, resp))}</strong></p>
          ${correct ? '' : `<p class="proctor-review__line">Correct answer: <strong>${mdInline(correctText(q))}</strong></p>`}
          ${q.explanation ? `<div class="proctor-review__explanation proctor-md">${mdBlock(q.explanation)}</div>` : ''}
        </div>`;
    }).join('')}`;
}

// ── Progress: the history, finally on screen ─────────────────

function sparkline(scores) {
  if (scores.length < 2) return '';
  const w = 120, h = 30, pad = 2;
  const pts = scores.map((s, i) => {
    const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
    const y = pad + (1 - s / 100) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `
    <svg class="proctor-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function relDate(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function renderProgress() {
  const host = $('progressHost');
  if (!state.history.length) {
    host.innerHTML = '<div class="card proctor-empty">Nothing here yet — finish a study or simulator run and it lands here.</div>';
    return;
  }

  // Per-test cards: runs grouped by test id (title as fallback for entries
  // recorded before ids existed), oldest → newest for the trend line
  const byTest = new Map();
  state.history.forEach((h) => {
    const key = h.id || h.title;
    if (!byTest.has(key)) byTest.set(key, []);
    byTest.get(key).unshift(h);
  });

  const cards = [...byTest.values()].map((runs) => {
    const title = runs[runs.length - 1].title;
    const scores = runs.map((r) => r.scorePct);
    const last = runs[runs.length - 1];
    const best = Math.max(...scores);
    const entry = last.id ? getTest(last.id) : null;
    const weak = entry ? weakIdxs(last.id, entry.doc || entry).length : 0;
    // Latest run that carries a breakdown — 'facet' names it; runs recorded
    // before facets existed carry only categories.
    const withCats = [...runs].reverse().find((r) => r.cats && Object.keys(r.cats).length > 1);
    const cats = withCats?.cats;
    const facetLabel = FACETS.find((f) => f.key === (withCats?.facet || 'category'))?.label ?? 'By category';
    return `
      <div class="card proctor-progress-card">
        <div class="proctor-progress-card__head">
          <h4>${escHtml(title)}</h4>
          ${sparkline(scores)}
        </div>
        <p class="proctor-progress-card__meta">
          ${runs.length} run${runs.length > 1 ? 's' : ''} ·
          last <strong>${last.scorePct}%</strong> (${relDate(last.at)}) ·
          best <strong>${best}%</strong>${weak ? ` ·
          <span class="proctor-weak-chip">${weak} weak question${weak > 1 ? 's' : ''}</span>` : ''}
        </p>
        ${cats ? `<p class="proctor-progress-card__facet">${facetLabel}</p>${breakdownRows(Object.entries(cats))}` : ''}
      </div>`;
  }).join('');

  const recent = state.history.slice(0, 15).map((h) => `
    <div class="proctor-run-row">
      <span class="proctor-run-row__title">${escHtml(h.title)}</span>
      <span class="proctor-chip">${h.mode === 'exam' ? 'Simulator' : 'Study'}</span>
      <span class="proctor-run-row__score ${h.scorePct >= 70 ? 'proctor-run-row__score--good' : ''}">${h.scorePct}%</span>
      <span class="proctor-run-row__when">${relDate(h.at)}</span>
    </div>`).join('');

  host.innerHTML = `
    ${cards}
    <h3 class="proctor-subhead">Recent runs</h3>
    <div class="card proctor-runs">${recent}</div>`;
}

// ── Format view ──────────────────────────────────────────────

export const FORMAT_EXAMPLE = `{
  "title": "Terminal Basics",
  "description": "Everyday commands, no tricks",
  "category": "technical",
  "timeLimitMinutes": 10,
  "passingScore": 70,
  "domains": [
    {
      "name": "Filesystem",
      "description": "Shared setup for these questions, written ONCE here — never repeated in a prompt. You are on a Linux box in /tmp/work with a docs/ directory.",
      "subdomains": ["Navigation", "Creating files"]
    },
    { "name": "Version control" }
  ],
  "questions": [
    {
      "type": "single",
      "domain": "Filesystem",
      "subdomain": "Navigation",
      "category": "files",
      "prompt": "Which command lists hidden files too?",
      "options": ["ls", "ls -a", "ls -s", "list --all"],
      "answer": 1,
      "explanation": "-a includes entries starting with a dot"
    },
    {
      "type": "multi",
      "domain": "Filesystem",
      "subdomain": "Creating files",
      "prompt": "Which of these create a directory?",
      "options": ["mkdir docs", "touch docs/", "install -d docs", "cd docs"],
      "answers": [0, 2],
      "explanation": "touch creates files; cd only moves you"
    },
    {
      "type": "truefalse",
      "domain": "Version control",
      "prompt": "In git, HEAD always points at a branch.",
      "answer": false,
      "explanation": "A detached HEAD points at a commit directly"
    },
    {
      "type": "fill",
      "domain": "Filesystem",
      "subdomain": "Navigation",
      "prompt": "Type the command that prints the current directory.",
      "accept": ["pwd"],
      "explanation": "pwd = print working directory"
    }
  ]
}`;

export function renderFormatView() {
  $('formatExample').textContent = FORMAT_EXAMPLE;
}


// ── Review mode: the whole test rendered, paginated, print-ready ──
// Every question is in the DOM; pagination hides off-page items with a class
// the print stylesheet unhides — so Export PDF always prints the full test.

// The facet selection is per-test and deliberately not persisted — a domain
// filter means nothing on the next test you open.
export const review = {
  testId: null,
  page: 0,
  cursor: 0,            // index into the filtered list — what the arrow keys move
  perPage: 10,          // resolved for this bank; events.js reads it to flip pages
  visibleCount: 0,
  filter: { domain: [], subdomain: [], category: [] },
};

export function resetReviewFilter() {
  review.filter = { domain: [], subdomain: [], category: [] };
  review.cursor = 0;
}

/** Per-page choices sized to the bank: never an option larger than the test.
 *  0 is "All". A 12-question test offers 5/10/All; a 96-question bank adds 20/25/50. */
export function perPageSteps(total) {
  return [...[5, 10, 20, 25, 50, 100, 200].filter((n) => n < total), 0];
}

/** The saved preference, snapped to a step this bank actually offers. */
function resolvePerPage(saved, steps) {
  if (steps.includes(saved)) return saved;
  return steps.find((n) => n !== 0 && n >= saved) ?? 0;
}

function reviewOptionRows(q) {
  const { showAnswers } = state.review;
  // Hiding the wrong options no longer depends on the answer key: leaving one
  // unmarked option standing reveals the answer either way.
  const onlyCorrect = state.review.showWrong === false;
  if (q.type === 'fill') {
    return `<p class="proctor-review-accept">Accepted: <strong>${q.accept.map(mdInline).join('</strong> / <strong>')}</strong></p>`;
  }
  if (q.type === 'truefalse') {
    return [true, false]
      .filter((val) => !onlyCorrect || val === q.answer)
      .map((val) => `
      <div class="proctor-review-opt ${showAnswers && val === q.answer ? 'proctor-review-opt--correct' : ''}">
        <span class="proctor-option__key">${val === q.answer && showAnswers ? '✓' : ''}</span>
        <span>${val ? 'True' : 'False'}</span>
      </div>`).join('');
  }
  return q.options.map((opt, i) => {
    const isCorrect = q.type === 'single' ? i === q.answer : q.answers.includes(i);
    if (onlyCorrect && !isCorrect) return '';
    const mark = showAnswers && isCorrect;
    return `
      <div class="proctor-review-opt ${mark ? 'proctor-review-opt--correct' : ''}">
        <span class="proctor-option__key">${mark ? '✓' : String.fromCharCode(65 + i)}</span>
        <span>${mdInline(opt)}</span>
      </div>`;
  }).join('');
}

/** One row of a dropdown panel. `kind` picks the control; both look the same
 *  so the two menus in the Review toolbar read as one component. */
function menuItem({ kind, name, value, label, hint, on }) {
  return `
    <label class="proctor-menu__item">
      <input type="${kind}" ${kind === 'radio' ? `name="${name}"` : ''} data-${name}="${value}" ${on ? 'checked' : ''}>
      <span class="proctor-menu__text">
        <span class="proctor-menu__label">${label}</span>
        ${hint ? `<span class="proctor-menu__hint">${hint}</span>` : ''}
      </span>
    </label>`;
}

/** Per page, as a dropdown button rather than a native select — same block as
 *  the Visible menu beside it. Steps come from the bank's size. */
export function renderPerPageMenu(steps, perPage) {
  $('reviewPerPageValue').textContent = perPage === 0 ? 'All' : String(perPage);
  $('reviewPerPagePanel').innerHTML = steps.map((n) => menuItem({
    kind: 'radio', name: 'perpage', value: n, on: n === perPage,
    label: n === 0 ? 'All on one page' : `${n} questions`,
    hint: n === 0 ? 'no paging' : null,
  })).join('');
}

/** The Visible menu: one checkbox per applicable option, plus a badge counting
 *  what is currently hidden — the count is what tells you the list is not
 *  showing everything without opening it. */
export function renderVisibilityMenu(test) {
  const items = visibilityItems(test);
  const hidden = items.filter((it) => !it.on).length;
  const badge = $('reviewVisibilityBadge');
  badge.hidden = hidden === 0;
  badge.textContent = hidden ? String(hidden) : '';
  $('reviewVisibilityBtn').title = hidden
    ? `${hidden} of ${items.length} hidden`
    : 'Everything is showing';
  $('reviewVisibilityPanel').innerHTML = items.map((it) => menuItem({
    kind: 'checkbox', name: 'visibility', value: it.key,
    label: it.label, hint: it.hint, on: it.on,
  })).join('');
}

export function renderReview() {
  const entry = getTest(review.testId);
  if (!entry) return;
  const test = entry.doc || entry;
  const { showAnswers, showWhy, showNotes, showTags, showScenario } = state.review;
  const total = test.questions.length;

  const facets = usedFacets(test);
  $('reviewFacets').hidden = facets.length === 0;
  $('reviewFacets').innerHTML = facets.length ? facetFilterHtml(test, review.filter) : '';

  // Filtering happens before pagination, so "Export PDF" prints the slice you
  // selected — off-page items stay in the DOM, filtered-out ones do not.
  const visible = test.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => matchesFilter(q, review.filter));

  const steps = perPageSteps(visible.length);
  const perPage = resolvePerPage(state.review.perPage, steps);
  const pages = perPage > 0 ? Math.max(1, Math.ceil(visible.length / perPage)) : 1;
  review.perPage = perPage;
  review.visibleCount = visible.length;
  if (review.cursor >= visible.length) review.cursor = Math.max(0, visible.length - 1);
  if (review.page >= pages) review.page = pages - 1;
  if (review.page < 0) review.page = 0;

  $('review-title').textContent = test.title;
  $('reviewCount').textContent = visible.length === total
    ? `${total} questions`
    : `${visible.length} of ${total} questions`;
  renderVisibilityMenu(test);
  renderPerPageMenu(steps, perPage);

  if (!visible.length) {
    $('reviewList').innerHTML = '<div class="card proctor-empty">No question matches this filter.</div>';
    $('reviewPager').innerHTML = '';
    return;
  }

  // A domain gets its banner once per page: grouped banks read the same as a
  // section header, and a bank whose domains interleave does not get one banner
  // per question — which would be the original bug, moved.
  const bannered = new Set();
  $('reviewList').innerHTML = visible.map(({ q, i }, shown) => {
    const page = perPage > 0 ? Math.floor(shown / perPage) : 0;
    const offpage = page === review.page ? '' : ' proctor-review-item--offpage';
    const note = getNote(review.testId, q.id);
    // The scenario, carried once instead of pasted in front of every prompt.
    const info = showScenario ? domainInfo(test, q.domain) : null;
    let banner = '';
    if (info && !bannered.has(`${page}::${info.name}`)) {
      bannered.add(`${page}::${info.name}`);
      const inDomain = visible.filter(({ q: other }) => other.domain === info.name).length;
      banner = `
        <div class="proctor-domain-banner${offpage}">
          <div class="proctor-domain-banner__head">
            <span class="proctor-domain-banner__label">Domain</span>
            <h3 class="proctor-domain-banner__name">${escHtml(info.name)}</h3>
            <span class="proctor-domain-banner__count">${inDomain} question${inDomain === 1 ? '' : 's'}</span>
          </div>
          ${info.description ? `<div class="proctor-domain-banner__desc proctor-md">${mdBlock(info.description)}</div>` : ''}
        </div>`;
    }
    const current = shown === review.cursor ? ' proctor-review-item--current' : '';
    return `${banner}
      <div class="card proctor-review-item${offpage}${current}" data-qid="${escHtml(q.id)}" data-shown="${shown}">
        <div class="proctor-review-item__head">
          <span class="proctor-review__n">${i + 1}</span>
          ${showTags ? tagChips(q) : ''}
          <span class="proctor-review-item__type">${q.type}</span>
        </div>
        <div class="proctor-review-item__prompt proctor-md">${mdBlock(q.prompt)}</div>
        <div class="proctor-review-opts">${reviewOptionRows(q)}</div>
        ${showWhy && q.explanation ? `<div class="proctor-review-item__why proctor-md"><strong>Why:</strong> ${mdBlock(q.explanation)}</div>` : ''}
        ${showNotes ? `
          <div class="proctor-review-note">
            <div class="proctor-note-view proctor-md ${note ? '' : 'proctor-note-view--empty'}"
                 role="button" tabindex="0" title="Click to edit — markdown works here">${note ? mdBlock(note) : 'Add a note — markdown works here'}</div>
            <textarea class="proctor-note-input" rows="3" placeholder="Your note for this question (markdown works)"
                      aria-label="Note for question ${i + 1}" hidden>${escHtml(note)}</textarea>
            <div class="proctor-note-print proctor-md">${mdBlock(note)}</div>
          </div>` : (note ? `<div class="proctor-note-print proctor-note-print--always proctor-md">${mdBlock(note)}</div>` : '')}
      </div>`;
  }).join('');

  $('reviewPager').innerHTML = pages <= 1 ? '' : `
    <button class="btn btn--ghost btn--sm" data-page="prev" ${review.page === 0 ? 'disabled' : ''}>Prev</button>
    ${Array.from({ length: pages }, (_, p) => `
      <button class="proctor-pager__num ${p === review.page ? 'proctor-pager__num--current' : ''}" data-page="${p}">${p + 1}</button>`).join('')}
    <button class="btn btn--ghost btn--sm" data-page="next" ${review.page === pages - 1 ? 'disabled' : ''}>Next</button>`;
}
