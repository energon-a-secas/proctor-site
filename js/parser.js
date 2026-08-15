// ── Test parsing: JSON first, then a YAML subset, then normalization ──
//
// The YAML parser is deliberately a subset — plain indentation, lists, maps,
// scalars, inline [a, b] arrays, and | block scalars. No anchors, no aliases,
// no flow maps, no multi-doc. The limits are documented in /llms.txt; JSON is
// the canonical format and YAML exists for hand-written tests.

import { sniffFormat, parseAiken, parseGIFT, parseCSV } from './formats.js';

const TAB_RE = /^\s*\t/;

function yamlScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(yamlScalar);
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function stripComment(line) {
  // Full-line comments, plus trailing " #" outside quotes (cheap heuristic:
  // only strip when the line contains no quote characters at all).
  if (/^\s*#/.test(line)) return '';
  if (!line.includes('"') && !line.includes("'")) {
    const i = line.indexOf(' #');
    if (i !== -1) return line.slice(0, i);
  }
  return line;
}

export function parseYAMLSubset(text) {
  const rawLines = text.split('\n');
  const lines = [];
  rawLines.forEach((raw, idx) => {
    if (TAB_RE.test(raw)) throw new Error(`line ${idx + 1}: tabs are not allowed in YAML indentation`);
    const line = stripComment(raw);
    if (line.trim() === '') return;
    lines.push({ text: line, indent: line.match(/^ */)[0].length, n: idx + 1 });
  });
  if (!lines.length) throw new Error('empty document');
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) throw new Error(`line ${lines[next].n}: unexpected content (check indentation)`);
  return value;
}

function parseBlock(lines, i, indent) {
  if (lines[i].text.trim().startsWith('- ') || lines[i].text.trim() === '-') {
    return parseList(lines, i, indent);
  }
  return parseMap(lines, i, indent);
}

function parseList(lines, i, indent) {
  const out = [];
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.trim().startsWith('- ') || lines[i].text.trim() === '-')) {
    const rest = lines[i].text.trim().replace(/^-\s?/, '');
    if (rest === '') {
      // "-" alone: value is the nested block
      const [v, next] = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? indent + 2);
      out.push(v); i = next;
    } else if (/^[\w"'][^:]*:(\s|$)/.test(rest)) {
      // "- key: value": inline start of a map item; virtual indent is where the key sits
      const keyIndent = indent + (lines[i].text.length - lines[i].text.trimStart().length === indent ? 2 : 2);
      const virtual = { text: ' '.repeat(indent + 2) + rest, indent: indent + 2, n: lines[i].n };
      const spliced = [virtual, ...lines.slice(i + 1)];
      const [v, consumed] = parseMap(spliced, 0, indent + 2);
      out.push(v); i = i + consumed;
    } else {
      out.push(yamlScalar(rest)); i += 1;
    }
  }
  return [out, i];
}

function parseMap(lines, i, indent) {
  const out = {};
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.trim().startsWith('- ')) {
    const line = lines[i].text.trim();
    const m = line.match(/^("([^"]*)"|'([^']*)'|([^:]+)):(.*)$/);
    if (!m) throw new Error(`line ${lines[i].n}: expected "key: value"`);
    const key = (m[2] ?? m[3] ?? m[4]).trim();
    const rest = m[5];
    if (rest.trim() === '|' || rest.trim() === '|-') {
      // Block scalar: consume deeper-indented lines verbatim
      const chunks = [];
      let j = i + 1;
      const base = j < lines.length ? lines[j].indent : indent + 2;
      while (j < lines.length && lines[j].indent >= base) {
        chunks.push(lines[j].text.slice(base)); j += 1;
      }
      out[key] = chunks.join('\n'); i = j;
    } else if (rest.trim() === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [v, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        out[key] = v; i = next;
      } else {
        out[key] = null; i += 1;
      }
    } else {
      out[key] = yamlScalar(rest); i += 1;
    }
  }
  return [out, i];
}

// ── Normalization ────────────────────────────────────────────

const TYPES = new Set(['single', 'multi', 'truefalse', 'fill']);

function resolveIndex(value, options, qn, what, errors) {
  if (typeof value === 'number') {
    if (value < 0 || value >= options.length) {
      errors.push(`Q${qn}: ${what} index ${value} is out of range (0-${options.length - 1})`);
      return null;
    }
    return value;
  }
  const idx = options.findIndex((o) => String(o).trim() === String(value).trim());
  if (idx === -1) errors.push(`Q${qn}: ${what} "${value}" matches no option`);
  return idx === -1 ? null : idx;
}

/** The declared `domains` registry, normalized to [{ name, description, subdomains }].
 *  Accepts an array of strings or objects, or a map of name -> description|object —
 *  a plain YAML map is the shape people reach for first. */
function normalizeDomains(raw) {
  const entries = [];
  const push = (name, body) => {
    const n = String(name ?? '').trim();
    if (!n) return;
    const o = body && typeof body === 'object' && !Array.isArray(body) ? body : { description: body };
    entries.push({
      name: n,
      description: o.description ?? o.scenario ?? o.summary ?? null,
      subdomains: Array.isArray(o.subdomains) ? o.subdomains.map((s) => String(s).trim()).filter(Boolean) : [],
    });
  };
  if (Array.isArray(raw)) {
    raw.forEach((d) => {
      if (d && typeof d === 'object') push(d.name ?? d.title ?? d.id, d);
      else push(d, null);
    });
  } else if (raw && typeof raw === 'object') {
    Object.entries(raw).forEach(([name, body]) => push(name, body));
  }
  return entries.map((e) => ({
    ...e,
    description: e.description ? String(e.description).trim() : null,
  }));
}

function inferType(q) {
  if (q.type) return String(q.type).toLowerCase();
  if (q.accept !== undefined) return 'fill';
  if (Array.isArray(q.answers)) return 'multi';
  if (typeof q.answer === 'boolean') return 'truefalse';
  return 'single';
}

/** Parse raw text (JSON, YAML, Aiken, GIFT, or CSV) into a normalized test, or { error }.
 *  `name` (e.g. the file name) titles formats that carry no title of their own. */
export function parseTest(text, { name } = {}) {
  let doc;
  const trimmed = text.trim();
  if (!trimmed) return { error: 'The file is empty' };
  try {
    doc = JSON.parse(trimmed);
  } catch (jsonErr) {
    const alt = sniffFormat(trimmed);
    if (alt) {
      try {
        doc = { aiken: parseAiken, gift: parseGIFT, csv: parseCSV }[alt](trimmed);
      } catch (altErr) {
        return { error: `Looks like ${alt.toUpperCase()}, but: ${altErr.message}` };
      }
    } else {
      try {
        doc = parseYAMLSubset(trimmed);
      } catch (yamlErr) {
        const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
        return { error: looksJson ? `Invalid JSON: ${jsonErr.message}` : `Not valid JSON, and YAML parsing failed: ${yamlErr.message}` };
      }
    }
  }
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && !doc.title) {
    doc.title = name
      ? name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
      : `Imported test — ${new Date().toISOString().slice(0, 10)}`;
  }
  return normalizeTest(doc);
}

export function normalizeTest(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: 'The document root must be an object with "title" and "questions"' };
  }
  const errors = [];
  const title = String(doc.title || '').trim();
  if (!title) errors.push('Missing "title"');
  const rawQs = doc.questions;
  if (!Array.isArray(rawQs) || rawQs.length === 0) {
    return { error: 'Missing "questions" — a non-empty array of question objects' };
  }

  const questions = rawQs.map((q, i) => {
    const qn = i + 1;
    if (!q || typeof q !== 'object') { errors.push(`Q${qn}: not an object`); return null; }
    const type = inferType(q);
    if (!TYPES.has(type)) { errors.push(`Q${qn}: unknown type "${q.type}" (single, multi, truefalse, fill)`); return null; }
    const prompt = String(q.prompt || q.question || '').trim();
    if (!prompt) errors.push(`Q${qn}: missing "prompt"`);

    const norm = {
      id: q.id || `q${qn}`,
      type,
      prompt,
      category: q.category ? String(q.category).trim() : null,
      domain: q.domain ? String(q.domain).trim() : null,
      subdomain: q.subdomain ? String(q.subdomain).trim() : null,
      explanation: q.explanation ? String(q.explanation).trim() : null,
      points: typeof q.points === 'number' && q.points > 0 ? q.points : 1,
      ensure: q.ensure === true || q.ensure === 'true',
    };

    if (type === 'single' || type === 'multi') {
      const options = Array.isArray(q.options) ? q.options.map(String) : [];
      if (options.length < 2) errors.push(`Q${qn}: needs at least 2 "options"`);
      norm.options = options;
      if (type === 'single') {
        norm.answer = resolveIndex(q.answer, options, qn, 'answer', errors);
      } else {
        const raw = Array.isArray(q.answers) ? q.answers : (Array.isArray(q.answer) ? q.answer : null);
        if (!raw || raw.length === 0) { errors.push(`Q${qn}: multi needs "answers" (array)`); norm.answers = []; }
        else norm.answers = [...new Set(raw.map((a) => resolveIndex(a, options, qn, 'answers entry', errors)).filter((x) => x !== null))];
      }
    } else if (type === 'truefalse') {
      let a = q.answer;
      if (a === 'true') a = true;
      if (a === 'false') a = false;
      if (typeof a !== 'boolean') { errors.push(`Q${qn}: truefalse needs "answer": true or false`); a = true; }
      norm.answer = a;
    } else { // fill
      const accept = Array.isArray(q.accept) ? q.accept : (q.accept !== undefined ? [q.accept] : (q.answer !== undefined ? [q.answer] : []));
      if (!accept.length) errors.push(`Q${qn}: fill needs "accept" — the list of accepted answers`);
      norm.accept = accept.map((a) => String(a).trim());
      norm.caseSensitive = q.caseSensitive === true;
    }
    return norm;
  }).filter(Boolean);

  if (errors.length) return { error: errors.slice(0, 8).join('\n') + (errors.length > 8 ? `\n…and ${errors.length - 8} more` : '') };

  // A `note` on a question is the author's *own* annotation, written by our JSON
  // export. It is lifted out of the document rather than kept on it: the doc is
  // what a share link and the content-hashed id are built from, and personal
  // notes must change neither.
  const notes = {};
  rawQs.forEach((raw, i) => {
    const text = raw && typeof raw === 'object' && raw.note ? String(raw.note).trim() : '';
    if (text && questions[i]) notes[questions[i].id] = text;
  });

  // Domains: declared ones keep their order and descriptions; any domain a
  // question names without declaring is registered on first appearance, so the
  // facet filters work whether or not the author wrote the registry.
  const domains = normalizeDomains(doc.domains);
  const byName = new Map(domains.map((d) => [d.name.toLowerCase(), d]));
  questions.forEach((q) => {
    if (!q.domain) return;
    let d = byName.get(q.domain.toLowerCase());
    if (!d) { d = { name: q.domain, description: null, subdomains: [] }; domains.push(d); byName.set(q.domain.toLowerCase(), d); }
    q.domain = d.name; // one spelling wins, so chips and breakdowns do not split
    if (q.subdomain && !d.subdomains.some((s) => s.toLowerCase() === q.subdomain.toLowerCase())) {
      d.subdomains.push(q.subdomain);
    }
  });

  return {
    notes,
    test: {
      title,
      description: doc.description ? String(doc.description).trim() : null,
      category: doc.category ? String(doc.category).trim() : null,
      domains,
      timeLimitMinutes: typeof doc.timeLimitMinutes === 'number' && doc.timeLimitMinutes > 0 ? doc.timeLimitMinutes : null,
      passingScore: typeof doc.passingScore === 'number' ? doc.passingScore : null,
      questions,
    },
  };
}
