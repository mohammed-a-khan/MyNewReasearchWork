/**
 * A small XPath 1.0 subset for the agent simulator (the real agents use the
 * platform's XPath engine): absolute positional paths (/a[1]/b[2]),
 * //Tag[pred] and //*[pred] with predicates built from and/or/not/parens,
 * @attr=lit, contains(@attr,lit), local-name()=lit, contains(local-name(),lit).
 */
import type { NativeNode } from '../../src/mobile/index.js';

type Pred = (n: NativeNode) => boolean;

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /\s*(\(|\)|,|=|"[^"]*"|'[^']*'|@[\w:.-]+|[A-Za-z_][\w.:-]*\(\)|[A-Za-z_][\w.:-]*)/y;
  let m: RegExpExecArray | null;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    m = re.exec(s);
    if (!m) {
      if (/^\s*$/.test(s.slice(i))) break;
      throw new Error(`xpath-lite: cannot parse "${s.slice(i)}"`);
    }
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

function parsePredicate(src: string): Pred {
  const t = tokenize(src);
  let p = 0;
  const peek = () => t[p];
  const eat = (x?: string) => {
    const v = t[p++];
    if (x !== undefined && v !== x) throw new Error(`xpath-lite: expected ${x}, got ${v}`);
    return v;
  };
  const lit = (v: string) => v.slice(1, -1);
  const value = (): ((n: NativeNode) => string | undefined) => {
    const v = eat();
    if (v.startsWith('@')) { const a = v.slice(1); return (n) => n.attrs[a]; }
    if (v === 'local-name()' || v === 'name()') return (n) => n.tag;
    throw new Error(`xpath-lite: unsupported value ${v}`);
  };
  const primary = (): Pred => {
    const v = peek();
    if (v === '(') { eat('('); const e = or(); eat(')'); return e; }
    if (v === 'not') { eat(); eat('('); const e = or(); eat(')'); return (n) => !e(n); }
    if (v === 'contains') {
      eat(); eat('('); const a = value(); eat(','); const b = lit(eat()); eat(')');
      return (n) => (a(n) ?? '').includes(b);
    }
    const a = value();
    if (peek() !== '=') return (n) => a(n) !== undefined;
    eat('=');
    const b = lit(eat());
    return (n) => a(n) === b;
  };
  const and = (): Pred => {
    let l = primary();
    while (peek() === 'and') { eat(); const r = primary(); const ll = l; l = (n) => ll(n) && r(n); }
    return l;
  };
  const or = (): Pred => {
    let l = and();
    while (peek() === 'or') { eat(); const r = and(); const ll = l; l = (n) => ll(n) || r(n); }
    return l;
  };
  const e = or();
  if (p !== t.length) throw new Error(`xpath-lite: trailing tokens in ${src}`);
  return e;
}

/** Evaluate against parsed nodes (document order). */
export function evaluateXPath(expr: string, nodes: NativeNode[], root: NativeNode | undefined): NativeNode[] {
  const desc = /^\/\/([\w.*:-]+)(?:\[(.*)\])?$/s.exec(expr);
  if (desc) {
    const pred = desc[2] ? parsePredicate(desc[2]) : () => true;
    return nodes.filter((n) => (desc[1] === '*' || n.tag === desc[1]) && pred(n));
  }
  if (/^(?:\/[\w.:-]+\[\d+\])+$/.test(expr)) {
    const hit = nodes.find((n) => n.xpath === expr);
    return hit ? [hit] : [];
  }
  void root;
  throw new Error(`xpath-lite: unsupported expression ${expr}`);
}
