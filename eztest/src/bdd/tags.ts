/**
 * Tag expressions: `@smoke and not @wip`, `(@a or @b) and not @slow`.
 *
 *   expr    := or
 *   or      := and ("or" and)*
 *   and     := not ("and" not)*
 *   not     := "not" not | primary
 *   primary := "(" expr ")" | tag
 *
 * Tags are compared without the "@" and without case, like the rest of
 * EZTest's tag filters (`@Smoke` matches `@smoke`). A bare word is a tag too,
 * so `smoke,regression` style lists keep working. Inside a tag, `\(`, `\)`,
 * `\ ` and `\\` escape those characters.
 */
import { EzTestError } from '../core/index.js';

export type TagExpression =
  | { type: 'tag'; name: string }
  | { type: 'not'; expr: TagExpression }
  | { type: 'and'; left: TagExpression; right: TagExpression }
  | { type: 'or'; left: TagExpression; right: TagExpression }
  | { type: 'true' };

export class TagExpressionError extends EzTestError {
  constructor(message: string, readonly expression: string, readonly column: number) {
    super(`Invalid tag expression "${expression}" at column ${column}: ${message}`, 'BAD_TAG_EXPRESSION', { expression, column });
    this.name = 'TagExpressionError';
  }
}

interface Tok {
  kind: 'lp' | 'rp' | 'and' | 'or' | 'not' | 'tag';
  text: string;
  column: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ kind: ch === '(' ? 'lp' : 'rp', text: ch, column: i + 1 });
      i++;
      continue;
    }
    const start = i;
    let word = '';
    while (i < src.length && !/\s/.test(src[i]) && src[i] !== '(' && src[i] !== ')') {
      if (src[i] === '\\') {
        const nx = src[i + 1];
        if (nx === undefined || !/[()\\\s]/.test(nx)) throw new TagExpressionError(`illegal escape "\\${nx ?? ''}"`, src, i + 1);
        word += nx;
        i += 2;
        continue;
      }
      word += src[i++];
    }
    const lower = word.toLowerCase();
    if (lower === 'and' || lower === 'or' || lower === 'not') out.push({ kind: lower, text: word, column: start + 1 });
    else out.push({ kind: 'tag', text: word, column: start + 1 });
  }
  return out;
}

const norm = (t: string) => t.trim().replace(/^@/, '').toLowerCase();

/** Parse a tag expression. An empty expression matches everything. */
export function parseTagExpression(src: string): TagExpression {
  const toks = tokenize(src);
  if (!toks.length) return { type: 'true' };
  let p = 0;
  const peek = () => toks[p];
  const fail = (msg: string, t?: Tok): never => {
    throw new TagExpressionError(msg, src, t?.column ?? src.length + 1);
  };
  const primary = (): TagExpression => {
    const t = peek();
    if (!t) return fail('expected a tag or "("');
    if (t.kind === 'lp') {
      p++;
      const e = or();
      if (peek()?.kind !== 'rp') fail('missing ")"', peek());
      p++;
      return e;
    }
    if (t.kind === 'tag') {
      p++;
      if (!norm(t.text)) fail('empty tag', t);
      return { type: 'tag', name: norm(t.text) };
    }
    return fail(`expected a tag, got "${t.text}"`, t);
  };
  const not = (): TagExpression => {
    if (peek()?.kind === 'not') {
      p++;
      return { type: 'not', expr: not() };
    }
    return primary();
  };
  const and = (): TagExpression => {
    let left = not();
    while (peek()?.kind === 'and') {
      p++;
      left = { type: 'and', left, right: not() };
    }
    return left;
  };
  const or = (): TagExpression => {
    let left = and();
    while (peek()?.kind === 'or') {
      p++;
      left = { type: 'or', left, right: and() };
    }
    return left;
  };
  const e = or();
  if (p < toks.length) {
    const t = toks[p];
    fail(t.kind === 'rp' ? 'unmatched ")"' : t.kind === 'tag' ? `expected "and" or "or" before "${t.text}"` : `unexpected "${t.text}"`, t);
  }
  return e;
}

/** True when the tags (with or without "@") satisfy the expression. */
export function evaluateTags(expr: TagExpression, tags: Iterable<string>): boolean {
  const set = new Set([...tags].map(norm));
  const ev = (e: TagExpression): boolean => {
    switch (e.type) {
      case 'true':
        return true;
      case 'tag':
        return set.has(e.name);
      case 'not':
        return !ev(e.expr);
      case 'and':
        return ev(e.left) && ev(e.right);
      case 'or':
        return ev(e.left) || ev(e.right);
    }
  };
  return ev(expr);
}

/** Parse once, then test tag lists. */
export function tagMatcher(src: string): (tags: Iterable<string>) => boolean {
  const e = parseTagExpression(src);
  return (tags) => evaluateTags(e, tags);
}

/** True when the text is an expression rather than a plain tag list (`and`, `or`, `not`, parentheses). */
export function isTagExpression(src: string): boolean {
  return /(?:^|\s|\()(?:and|or|not)(?:\s|\(|$)|[()]/i.test(src);
}

/**
 * The `--tags` option: an expression, or a comma separated list (any of them).
 * `@smoke,@regression` is `@smoke or @regression`.
 */
export function tagFilterFrom(values: string | string[] | undefined): ((tags: Iterable<string>) => boolean) | undefined {
  const list = (Array.isArray(values) ? values : values === undefined ? [] : [values]).map((v) => v.trim()).filter(Boolean);
  if (!list.length) return undefined;
  const parts = list.flatMap((v) => (isTagExpression(v) ? [v] : v.split(',').map((x) => x.trim()).filter(Boolean)));
  if (!parts.length) return undefined;
  return tagMatcher(parts.map((x) => (parts.length > 1 ? `(${x})` : x)).join(' or '));
}

/** Render back to text (normalised, minimal parentheses). */
export function tagExpressionToText(e: TagExpression): string {
  const prec = (x: TagExpression) => (x.type === 'or' ? 1 : x.type === 'and' ? 2 : 3);
  const wrap = (x: TagExpression, min: number) => (prec(x) < min ? `(${tagExpressionToText(x)})` : tagExpressionToText(x));
  switch (e.type) {
    case 'true':
      return '';
    case 'tag':
      return `@${e.name.replace(/([()\\\s])/g, '\\$1')}`;
    case 'not':
      return `not ${wrap(e.expr, 3)}`;
    case 'and':
      return `${wrap(e.left, 2)} and ${wrap(e.right, 2)}`;
    case 'or':
      return `${wrap(e.left, 1)} or ${wrap(e.right, 1)}`;
  }
}
