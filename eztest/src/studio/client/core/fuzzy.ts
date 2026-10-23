/**
 * Fuzzy matching for the command palette and filters: the query's characters
 * must appear in order; consecutive runs, word starts and an early first hit
 * score higher. Returns the matched indexes so the UI can highlight them.
 */
export interface FuzzyMatch {
  score: number;
  indexes: number[];
}

const WORD_BREAK = /[\s/_\-.:@#()[\]"']/;

export function fuzzy(query: string, text: string): FuzzyMatch | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indexes: [] };
  const t = text.toLowerCase();
  // Fast path: a plain substring scores well.
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const wordStart = sub === 0 || WORD_BREAK.test(t[sub - 1]);
    return { score: 1000 - sub + (wordStart ? 200 : 0) + q.length * 10, indexes: Array.from({ length: q.length }, (_, i) => sub + i) };
  }
  const indexes: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return undefined;
    indexes.push(found);
    score += found === prev + 1 ? 15 : 1;
    if (found === 0 || WORD_BREAK.test(t[found - 1])) score += 10;
    prev = found;
    ti = found + 1;
  }
  score -= indexes[0] * 0.5;
  score -= (text.length - q.length) * 0.05;
  return { score, indexes };
}

/** Best of several fields (e.g. title and keywords). */
export function fuzzyAny(query: string, fields: Array<string | undefined>): FuzzyMatch | undefined {
  let best: FuzzyMatch | undefined;
  fields.forEach((f, i) => {
    if (!f) return;
    const m = fuzzy(query, f);
    if (!m) return;
    // Matches on secondary fields do not highlight the title.
    const scored = i === 0 ? m : { score: m.score - 50, indexes: [] };
    if (!best || scored.score > best.score) best = scored;
  });
  return best;
}
