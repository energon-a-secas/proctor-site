// ── Alternative import formats: Aiken, GIFT (subset), CSV ────
//
// Each parser returns a raw document { title?, questions: [...] } that flows
// into normalizeTest() like hand-written JSON would. sniffFormat() looks for
// unambiguous signals only — anything unrecognized stays on the JSON/YAML
// path so its error messages remain the good ones.

/** Detect a non-JSON/YAML format from strong signals, or null. */
export function sniffFormat(text) {
  if (/^ANSWER:\s*[A-Z]\s*$/m.test(text)) return 'aiken';
  if (/\{[^}]*[=~][^}]*\}/.test(text) || /^::.+::/m.test(text) || /\{\s*T(RUE)?\s*\}|\{\s*F(ALSE)?\s*\}/i.test(text)) return 'gift';
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n')).toLowerCase();
  if (firstLine.includes(',') && /\b(prompt|question)\b/.test(firstLine) && /\b(answer|accept)\b/.test(firstLine)) return 'csv';
  return null;
}

// ── Aiken ────────────────────────────────────────────────────
// Question text
// A. option     (A-Z with "." or ")")
// ANSWER: B

export function parseAiken(text) {
  const questions = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block, i) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const ansLine = lines.findIndex((l) => /^ANSWER:\s*[A-Z]\s*$/.test(l));
    if (ansLine === -1) throw new Error(`Aiken block ${i + 1}: no "ANSWER: X" line`);
    const letter = lines[ansLine].match(/^ANSWER:\s*([A-Z])/)[1];
    const options = [];
    const promptLines = [];
    lines.slice(0, ansLine).forEach((l) => {
      const m = l.match(/^([A-Z])[.)]\s+(.*)$/);
      if (m) options.push(m[2]);
      else if (options.length === 0) promptLines.push(l);
      else options[options.length - 1] += ` ${l}`; // wrapped option line
    });
    const answer = letter.charCodeAt(0) - 65;
    if (!promptLines.length) throw new Error(`Aiken block ${i + 1}: no question text before the options`);
    if (answer >= options.length) throw new Error(`Aiken block ${i + 1}: ANSWER: ${letter} but only ${options.length} options`);
    return { type: 'single', prompt: promptLines.join(' '), options, answer };
  });
  return { questions };
}

// ── GIFT (subset) ────────────────────────────────────────────
// ::title:: prompt { =right ~wrong #feedback }   ·   {T} / {F}   ·   {=fill =fill2}
// Supported: single, multi (several "="), truefalse, fill. Not supported:
// numeric ranges {#..}, matching {=a -> b}, weights are read but ignored.

const GIFT_UNESCAPE = /\\([:=~#{}])/g;

function giftText(s) {
  return s.replace(GIFT_UNESCAPE, '$1').trim();
}

export function parseGIFT(text) {
  const src = text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const blocks = src.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const questions = blocks.map((block, i) => {
    const m = block.match(/^(?:::(.*?)::)?\s*([\s\S]*?)\{([\s\S]*)\}\s*([\s\S]*)$/);
    if (!m) throw new Error(`GIFT block ${i + 1}: no {answers} section`);
    const [, , promptRaw, body] = m;
    const prompt = giftText(promptRaw);
    if (!prompt) throw new Error(`GIFT block ${i + 1}: empty question text`);
    const trimmed = body.trim();

    if (/^(T|TRUE)$/i.test(trimmed)) return { type: 'truefalse', prompt, answer: true };
    if (/^(F|FALSE)$/i.test(trimmed)) return { type: 'truefalse', prompt, answer: false };

    // "#### general feedback" applies to the whole question
    const [answersPart, ...generalParts] = trimmed.split('####');
    const generalFb = generalParts.length ? giftText(generalParts.join('####')) : null;

    // Tokenize on unescaped = and ~ (plain scan — no nesting in this subset)
    const tokens = [];
    let sign = null, buf = '';
    for (let c = 0; c < answersPart.length; c++) {
      const ch = answersPart[c];
      if (ch === '\\') { buf += ch + (answersPart[c + 1] ?? ''); c++; continue; }
      if (ch === '=' || ch === '~') {
        if (sign) tokens.push({ correct: sign === '=', raw: buf });
        sign = ch; buf = '';
      } else buf += ch;
    }
    if (sign) tokens.push({ correct: sign === '=', raw: buf });
    if (!tokens.length) throw new Error(`GIFT block ${i + 1}: no "=" or "~" answers inside {}`);

    // Explanation: the correct option's "#feedback", else "####", else any feedback
    let correctFb = null, anyFb = null;
    const opts = tokens.map((t) => {
      const s = t.raw.replace(/^\s*%-?\d+(\.\d+)?%/, ''); // strip weight
      const fb = s.split(/(?<!\\)#/);
      if (fb.length > 1) {
        const note = giftText(fb.slice(1).join('#'));
        if (t.correct && !correctFb) correctFb = note;
        if (!anyFb) anyFb = note;
      }
      return { correct: t.correct, text: giftText(fb[0]) };
    }).filter((o) => o.text);
    const explanation = correctFb ?? generalFb ?? anyFb;

    const rights = opts.filter((o) => o.correct);
    if (!opts.some((o) => !o.correct)) {
      return { type: 'fill', prompt, accept: rights.map((o) => o.text), ...(explanation ? { explanation } : {}) };
    }
    const base = { prompt, options: opts.map((o) => o.text), ...(explanation ? { explanation } : {}) };
    if (rights.length > 1) {
      return { type: 'multi', ...base, answers: opts.map((o, idx) => (o.correct ? idx : -1)).filter((x) => x !== -1) };
    }
    return { type: 'single', ...base, answer: opts.findIndex((o) => o.correct) };
  });
  return { questions };
}

// ── CSV ──────────────────────────────────────────────────────
// Header row names the columns: prompt (or question), options (| separated),
// answer, answers, accept, explanation, category, type, points.

function csvRows(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export function parseCSV(text) {
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error('CSV needs a header row plus at least one question row');
  const cols = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => cols.indexOf(name);
  const pCol = idx('prompt') !== -1 ? idx('prompt') : idx('question');
  if (pCol === -1) throw new Error('CSV header needs a "prompt" (or "question") column');
  const get = (row, name) => { const c = idx(name); return c === -1 ? '' : (row[c] ?? '').trim(); };

  const questions = rows.slice(1).map((row) => {
    const q = { prompt: (row[pCol] ?? '').trim() };
    const options = get(row, 'options');
    if (options) q.options = options.split('|').map((o) => o.trim()).filter(Boolean);
    const answers = get(row, 'answers');
    if (answers) q.answers = answers.split('|').map((a) => (/^\d+$/.test(a.trim()) ? parseInt(a, 10) : a.trim()));
    const answer = get(row, 'answer');
    if (answer && !answers) {
      if (/^(true|false)$/i.test(answer)) q.answer = answer.toLowerCase() === 'true';
      else if (/^\d+$/.test(answer)) q.answer = parseInt(answer, 10);
      else q.answer = answer;
    }
    const accept = get(row, 'accept');
    if (accept) q.accept = accept.split('|').map((a) => a.trim()).filter(Boolean);
    ['explanation', 'category', 'type'].forEach((k) => { const v = get(row, k); if (v) q[k] = v; });
    const points = get(row, 'points');
    if (points && /^\d+(\.\d+)?$/.test(points)) q.points = parseFloat(points);
    return q;
  });
  return { questions };
}
