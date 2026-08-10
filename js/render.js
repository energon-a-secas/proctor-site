// ── DOM rendering for every view ─────────────────────────────

import { $, escHtml } from './utils.js';
import { state, getTest } from './state.js';
import { gradeQuestion, isAnswered, correctText, responseText, summarize } from './grader.js';
import { formatClock } from './timer.js';

const VIEWS = ['library', 'runner', 'results', 'format'];

export function showView(name) {
  VIEWS.forEach((v) => { $(`view-${v}`).hidden = v !== name; });
  window.scrollTo({ top: 0 });
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
      <div class="toolbar">
        <button class="btn btn--primary btn--sm" data-action="start">Start</button>
        ${sample ? '' : `
          <button class="btn btn--ghost btn--sm" data-action="share">Copy link</button>
          <button class="btn btn--ghost btn--sm" data-action="remove" aria-label="Remove ${escHtml(t.title)}">Remove</button>`}
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

  const saved = Object.values(state.tests).sort((a, b) => b.addedAt - a.addedAt);
  $('savedSection').hidden = saved.length === 0 && !state.session;
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
  $('questionCategory').hidden = !q.category;
  $('questionCategory').textContent = q.category || '';
  $('questionPrompt').textContent = q.prompt;
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
          <span>${escHtml(q.options[optIdx])}</span>
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
    $('feedbackExplanation').textContent = q.explanation || '';
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

export function renderResults() {
  const s = state.session;
  const test = activeTest();
  const sum = summarize(test, s);
  state.lastSummary = sum;

  const timeUsed = s.finishedAt && s.startedAt ? Math.round((s.finishedAt - s.startedAt) / 1000) : null;
  $('scoreCard').innerHTML = `
    <div class="proctor-score__pct ${sum.scorePct >= 70 ? 'proctor-score__pct--good' : ''}">${sum.scorePct}%</div>
    <div class="proctor-score__detail">
      <p><strong>${escHtml(test.title)}</strong> · ${s.mode === 'exam' ? 'Simulator' : 'Study'}</p>
      <p>${sum.points} of ${sum.maxPoints} points${timeUsed !== null ? ` · ${formatClock(timeUsed)} used` : ''}</p>
      ${sum.passed !== null ? `<span class="proctor-chip ${sum.passed ? 'proctor-chip--pass' : 'proctor-chip--fail'}">${sum.passed ? `Passed (needs ${test.passingScore}%)` : `Below the ${test.passingScore}% pass mark`}</span>` : ''}
    </div>`;

  const cats = Object.entries(sum.perCategory);
  $('categoryBreakdown').innerHTML = cats.length < 2 ? '' : `
    <h3 class="proctor-subhead">By category</h3>
    <div class="card">
      ${cats.map(([cat, c]) => {
        const pct = Math.round((c.correct / c.total) * 100);
        return `
          <div class="proctor-cat">
            <span class="proctor-cat__name">${escHtml(cat)}</span>
            <div class="proctor-cat__bar"><div class="proctor-cat__fill" style="width:${pct}%"></div></div>
            <span class="proctor-cat__score">${c.correct}/${c.total}</span>
          </div>`;
      }).join('')}
    </div>`;

  $('retakeMissedBtn').hidden = sum.missed.length === 0;
  $('reviewHost').innerHTML = `
    <h3 class="proctor-subhead">Review</h3>
    ${s.order.map((qIdx, pos) => {
      const q = test.questions[qIdx];
      const resp = s.responses[pos];
      const correct = gradeQuestion(q, resp);
      return `
        <div class="card proctor-review ${correct ? '' : 'proctor-review--wrong'}">
          <p class="proctor-review__prompt"><span class="proctor-review__n">${pos + 1}</span> ${escHtml(q.prompt)}</p>
          <p class="proctor-review__line">${correct ? '✓' : '✗'} Your answer: <strong>${escHtml(responseText(q, resp))}</strong></p>
          ${correct ? '' : `<p class="proctor-review__line">Correct answer: <strong>${escHtml(correctText(q))}</strong></p>`}
          ${q.explanation ? `<p class="proctor-review__explanation">${escHtml(q.explanation)}</p>` : ''}
        </div>`;
    }).join('')}`;
}

// ── Format view ──────────────────────────────────────────────

export const FORMAT_EXAMPLE = `{
  "title": "Terminal Basics",
  "description": "Everyday commands, no tricks",
  "category": "technical",
  "timeLimitMinutes": 10,
  "passingScore": 70,
  "questions": [
    {
      "type": "single",
      "category": "files",
      "prompt": "Which command lists hidden files too?",
      "options": ["ls", "ls -a", "ls -s", "list --all"],
      "answer": 1,
      "explanation": "-a includes entries starting with a dot"
    },
    {
      "type": "multi",
      "prompt": "Which of these create a directory?",
      "options": ["mkdir docs", "touch docs/", "install -d docs", "cd docs"],
      "answers": [0, 2],
      "explanation": "touch creates files; cd only moves you"
    },
    {
      "type": "truefalse",
      "prompt": "In git, HEAD always points at a branch.",
      "answer": false,
      "explanation": "A detached HEAD points at a commit directly"
    },
    {
      "type": "fill",
      "prompt": "Type the command that prints the current directory.",
      "accept": ["pwd"],
      "explanation": "pwd = print working directory"
    }
  ]
}`;

export function renderFormatView() {
  $('formatExample').textContent = FORMAT_EXAMPLE;
}
