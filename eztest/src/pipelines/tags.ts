/**
 * Tag expressions for `pipelines:` selections:
 *
 *   @smoke
 *   @regression and not @quarantined
 *   (@sit or @smoke) and not @slow
 *   @smoke, @critical                 (a comma is "or")
 *
 * Tags match case-insensitively, with or without the leading @. A tag ending
 * in `*` matches a prefix (`@team-*`).
 */

export type TagExpr =
  | { op: 'tag'; tag: string }
  | { op: 'not'; e: TagExpr }
  | { op: 'and' | 'or'; a: TagExpr; b: TagExpr };

export class TagExpressionError extends Error {}

const norm = (t: string) => t.trim().replace(/^@/, '').toLowerCase();

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /\s*(\(|\)|,|&&|\|\||!|[^\s(),!]+)/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(s))) {
    out.push(m[1]);
    at = re.lastIndex;
  }
  if (s.slice(at).trim()) throw new TagExpressionError(`cannot read "${s.slice(at).trim()}" in tag expression "${s}"`);
  return out;
}

export function parseTagExpression(src: string): TagExpr {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i]?.toLowerCase();
  const fail = (what: string): never => {
    throw new TagExpressionError(`tag expression "${src}": ${what}`);
  };
  const or = (): TagExpr => {
    let a = and();
    while (peek() === 'or' || peek() === ',' || peek() === '||') {
      i++;
      a = { op: 'or', a, b: and() };
    }
    return a;
  };
  const and = (): TagExpr => {
    let a = not();
    while (peek() === 'and' || peek() === '&&') {
      i++;
      a = { op: 'and', a, b: not() };
    }
    return a;
  };
  const not = (): TagExpr => {
    if (peek() === 'not' || peek() === '!') {
      i++;
      return { op: 'not', e: not() };
    }
    return primary();
  };
  const primary = (): TagExpr => {
    const t = toks[i];
    if (t === undefined) return fail('ends too early (expected a tag)');
    if (t === '(') {
      i++;
      const e = or();
      if (toks[i] !== ')') fail('missing ")"');
      i++;
      return e;
    }
    if ([')', ',', '&&', '||'].includes(t) || ['and', 'or'].includes(t.toLowerCase())) fail(`unexpected "${t}"`);
    i++;
    if (!/^@?[\w.:/*-]+$/.test(t)) fail(`"${t}" is not a tag`);
    return { op: 'tag', tag: norm(t) };
  };
  if (!toks.length) fail('is empty');
  const e = or();
  if (i < toks.length) fail(`unexpected "${toks[i]}"`);
  return e;
}

export function matchesTags(e: TagExpr, tags: readonly string[]): boolean {
  const have = tags.map(norm);
  const ev = (x: TagExpr): boolean => {
    switch (x.op) {
      case 'tag':
        return x.tag.endsWith('*') ? have.some((t) => t.startsWith(x.tag.slice(0, -1))) : have.includes(x.tag);
      case 'not':
        return !ev(x.e);
      case 'and':
        return ev(x.a) && ev(x.b);
      case 'or':
        return ev(x.a) || ev(x.b);
    }
  };
  return ev(e);
}

/** Why a journey matches or does not: the tags of the expression it has and lacks. */
export function explainTags(e: TagExpr, tags: readonly string[]): string {
  const have = new Set(tags.map(norm));
  const named: string[] = [];
  const walk = (x: TagExpr) => {
    if (x.op === 'tag') named.push(x.tag);
    else if (x.op === 'not') walk(x.e);
    else (walk(x.a), walk(x.b));
  };
  walk(e);
  const yes = [...new Set(named.filter((t) => (t.endsWith('*') ? [...have].some((h) => h.startsWith(t.slice(0, -1))) : have.has(t))))];
  const no = [...new Set(named.filter((t) => !yes.includes(t)))];
  return [yes.length ? `has ${yes.map((t) => `@${t}`).join(', ')}` : '', no.length ? `lacks ${no.map((t) => `@${t}`).join(', ')}` : ''].filter(Boolean).join('; ') || 'no tags';
}

export function tagExpressionToText(e: TagExpr): string {
  switch (e.op) {
    case 'tag':
      return `@${e.tag}`;
    case 'not':
      return `not ${e.e.op === 'tag' || e.e.op === 'not' ? tagExpressionToText(e.e) : `(${tagExpressionToText(e.e)})`}`;
    default: {
      const side = (x: TagExpr) => (x.op === 'and' || x.op === 'or') && x.op !== e.op ? `(${tagExpressionToText(x)})` : tagExpressionToText(x);
      return `${side(e.a)} ${e.op} ${side(e.b)}`;
    }
  }
}
