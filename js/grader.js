// ── Grading: one question, then the whole session ────────────

/** Has the user actually answered this question? */
export function isAnswered(q, resp) {
  if (resp === undefined || resp === null) return false;
  if (q.type === 'multi') return Array.isArray(resp) && resp.length > 0;
  if (q.type === 'fill') return String(resp).trim() !== '';
  return true;
}

/** Grade one question against a response. Returns true/false; unanswered is wrong. */
export function gradeQuestion(q, resp) {
  if (!isAnswered(q, resp)) return false;
  switch (q.type) {
    case 'single':
      return resp === q.answer;
    case 'truefalse':
      return resp === q.answer;
    case 'multi': {
      const got = [...resp].sort().join(',');
      const want = [...q.answers].sort().join(',');
      return got === want;
    }
    case 'fill': {
      const norm = (s) => (q.caseSensitive ? String(s).trim() : String(s).trim().toLowerCase());
      const given = norm(resp);
      return q.accept.some((a) => norm(a) === given);
    }
    default:
      return false;
  }
}

/** The correct answer, rendered as display text (for review screens). */
export function correctText(q) {
  switch (q.type) {
    case 'single': return q.options[q.answer] ?? '?';
    case 'multi': return q.answers.map((i) => q.options[i]).join(' + ');
    case 'truefalse': return q.answer ? 'True' : 'False';
    case 'fill': return q.accept.join(' / ');
    default: return '?';
  }
}

/** The user's response, rendered as display text. */
export function responseText(q, resp) {
  if (!isAnswered(q, resp)) return 'No answer';
  switch (q.type) {
    case 'single': return q.options[resp] ?? '?';
    case 'multi': return resp.map((i) => q.options[i]).join(' + ');
    case 'truefalse': return resp ? 'True' : 'False';
    case 'fill': return String(resp);
    default: return '?';
  }
}

/** Score a finished session. Order refers to session.order (shuffled indexes). */
export function summarize(test, session) {
  let points = 0;
  let maxPoints = 0;
  const perCategory = {};
  const missed = [];

  session.order.forEach((qIdx, pos) => {
    const q = test.questions[qIdx];
    const correct = gradeQuestion(q, session.responses[pos]);
    maxPoints += q.points;
    if (correct) points += q.points;
    else missed.push(qIdx);
    const cat = q.category || 'General';
    perCategory[cat] = perCategory[cat] || { correct: 0, total: 0 };
    perCategory[cat].total += 1;
    if (correct) perCategory[cat].correct += 1;
  });

  const scorePct = maxPoints ? Math.round((points / maxPoints) * 100) : 0;
  return {
    scorePct,
    points,
    maxPoints,
    perCategory,
    missed,
    passed: test.passingScore !== null ? scorePct >= test.passingScore : null,
  };
}
