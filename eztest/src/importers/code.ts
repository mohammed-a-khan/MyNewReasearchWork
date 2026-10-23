/**
 * A small, tolerant lexer and expression parser for test source code
 * (JavaScript/TypeScript, Java, C#, Python). It only *reads* source text:
 * nothing is ever evaluated or executed. It understands enough to recognise
 * call chains such as `page.getByRole('button', { name: 'Go' }).click()` or
 * `driver.findElement(By.id("q")).sendKeys("x")`; anything else is reported
 * as unparseable so the importer can keep it as a TODO.
 */

export type Lang = 'js' | 'java' | 'cs' | 'py';

export interface Token {
  t: 'id' | 'str' | 'num' | 're' | 'p';
  v: string;
  /** Offset of the first character. */
  pos: number;
  /** Offset just after the last character. */
  end: number;
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  col: number;
  /** First token on its line. */
  nl: boolean;
  /** Strings: a template / interpolated string with embedded expressions. */
  template?: boolean;
  /** Regex flags. */
  flags?: string;
}

const PUNCT3 = ['===', '!==', '...', '**=', '>>>'];
const PUNCT2 = ['==', '!=', '=>', '&&', '||', '?.', '??', '+=', '-=', '<=', '>=', '::', '->', '++', '--'];
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '&&', '||', '=>', '==', '===', '!=', '!==', '+', '-', '*', '%', '<', '>', '??']);

function unescape(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_w, e: string) => {
    if (e[0] === 'u' && e.length > 1) return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    switch (e) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '\n': return '';
      default: return e;
    }
  });
}

export class LexError extends Error {}

/** Tokenize source text. Comments are skipped; strings are unescaped. */
export function tokenize(src: string, lang: Lang): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let sawTokenOnLine = false;
  const n = src.length;
  const push = (tok: Omit<Token, 'line' | 'col' | 'nl'>, startLine: number, startCol: number) => {
    out.push({ ...tok, line: startLine, col: startCol, nl: !sawTokenOnLine });
    sawTokenOnLine = true;
  };
  const advanceLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (src[k] === '\n') {
        line++;
        lineStart = k + 1;
      }
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      lineStart = i + 1;
      sawTokenOnLine = false;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '﻿') {
      i++;
      continue;
    }
    if (lang === 'py' && c === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      lineStart = i;
      continue;
    }
    const startLine = line;
    const startCol = i - lineStart;
    // comments
    if (lang === 'py' ? c === '#' : c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (lang !== 'py' && c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const stop = e < 0 ? n : e + 2;
      advanceLines(i, stop);
      i = stop;
      continue;
    }
    // python string prefixes / C# verbatim and interpolated strings
    let prefix = '';
    if (lang === 'py') {
      const m = /^([rRbBuUfF]{1,2})(?=['"])/.exec(src.slice(i, i + 3));
      if (m) prefix = m[1].toLowerCase();
    } else if (lang === 'cs') {
      const m = /^(\$@|@\$|@|\$)(?=")/.exec(src.slice(i, i + 3));
      if (m) prefix = m[1];
    }
    const q = src[i + prefix.length];
    if (q === '"' || q === "'" || (q === '`' && lang === 'js')) {
      const start = i;
      let j = i + prefix.length;
      const triple = lang === 'py' && src.startsWith(q.repeat(3), j);
      const delim = triple ? q.repeat(3) : q;
      j += delim.length;
      const raw = prefix.includes('r') || prefix.includes('@');
      let body = '';
      let closed = false;
      while (j < n) {
        if (raw && prefix.includes('@') && src[j] === '"' && src[j + 1] === '"') {
          body += '"';
          j += 2;
          continue;
        }
        if (!raw && src[j] === '\\') {
          body += src.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (src.startsWith(delim, j)) {
          closed = true;
          j += delim.length;
          break;
        }
        if (src[j] === '\n' && !triple && q !== '`' && !prefix.includes('@')) break;
        body += src[j];
        j++;
      }
      if (!closed) throw new LexError(`unterminated string at line ${startLine}`);
      const template =
        (q === '`' && /\$\{/.test(body)) || (prefix.includes('f') && /\{[^{]/.test(body)) || (prefix.includes('$') && /\{[^{]/.test(body));
      advanceLines(start, j);
      push({ t: 'str', v: raw ? body : unescape(body), pos: start, end: j, ...(template ? { template: true } : {}) }, startLine, startCol);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+(?:[eE][+-]?[0-9]+)?)[a-zA-Z]*/.exec(src.slice(i))!;
      push({ t: 'num', v: m[0], pos: i, end: i + m[0].length }, startLine, startCol);
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$@]/.test(c) && !(c === '@' && lang !== 'cs')) {
      const m = /^[A-Za-z_$@][\w$]*/.exec(src.slice(i))!;
      push({ t: 'id', v: m[0], pos: i, end: i + m[0].length }, startLine, startCol);
      i += m[0].length;
      continue;
    }
    if (lang === 'js' && c === '/') {
      const prev = out[out.length - 1];
      const regexAllowed = !prev || (prev.t === 'p' && REGEX_PREV.has(prev.v)) || (prev.t === 'id' && /^(?:return|typeof|case|in|of|await|yield)$/.test(prev.v));
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        let body = '';
        let closed = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') {
            body += src.slice(j, j + 2);
            j += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            closed = true;
            j++;
            break;
          }
          body += ch;
          j++;
        }
        if (closed) {
          const fm = /^[a-z]*/.exec(src.slice(j))![0];
          push({ t: 're', v: body, flags: fm, pos: i, end: j + fm.length }, startLine, startCol);
          i = j + fm.length;
          continue;
        }
      }
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    const p = PUNCT3.includes(three) ? three : PUNCT2.includes(two) ? two : c;
    push({ t: 'p', v: p, pos: i, end: i + p.length }, startLine, startCol);
    i += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ structure helpers

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Index of the token closing the bracket at `open` (exclusive search), or -1. */
export function matchBracket(toks: Token[], open: number): number {
  const o = toks[open]?.v;
  const c = OPEN[o];
  if (!c) return -1;
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const v = toks[k].t === 'p' ? toks[k].v : '';
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') {
      depth--;
      if (depth === 0) return v === c ? k : -1;
    }
  }
  return -1;
}

const CONTINUES = new Set(['.', ',', '(', '[', '{', '+', '-', '*', '/', '=', '&&', '||', '?', ':', '=>', '!', '?.', '??', '==', '===', '!=', '!==', '<', '>']);

/** A statement: token range [start, end). */
export interface Stmt {
  start: number;
  end: number;
}

/**
 * Split tokens [from, to) into statements at depth 0. `;` always ends one; in
 * JS and Python a line break ends one when the statement is complete; a
 * block's closing `}` ends one in brace languages.
 */
export function splitStatements(toks: Token[], from: number, to: number, lang: Lang): Stmt[] {
  const out: Stmt[] = [];
  let start = from;
  let depth = 0;
  const flush = (end: number) => {
    if (end > start) out.push({ start, end });
    start = end;
  };
  for (let k = from; k < to; k++) {
    const tk = toks[k];
    if (k > start && depth === 0 && tk.nl) {
      const prev = toks[k - 1];
      const prevContinues = prev.t === 'p' && CONTINUES.has(prev.v) && !(prev.v === '}' );
      const nextContinues = tk.t === 'p' && (tk.v === '.' || tk.v === '?.' || tk.v === ')' || tk.v === ']');
      const newlineEnds = lang === 'js' || lang === 'py';
      if (newlineEnds && !prevContinues && !nextContinues && !(lang === 'py' && tk.col > toks[start].col)) flush(k);
      else if (!newlineEnds && prev.t === 'p' && prev.v === '}' && !(tk.t === 'id' && /^(?:else|catch|finally|while)$/.test(tk.v))) flush(k);
    }
    if (tk.t === 'p') {
      if (tk.v === '(' || tk.v === '[' || tk.v === '{') depth++;
      else if (tk.v === ')' || tk.v === ']' || tk.v === '}') depth = Math.max(0, depth - 1);
      else if (tk.v === ';' && depth === 0) {
        flush(k);
        start = k + 1;
      }
    }
  }
  flush(to);
  return out.filter((s) => !(s.end - s.start === 1 && toks[s.start].t === 'p' && toks[s.start].v === ';'));
}

/** Original source text of a token range. */
export function textOf(src: string, toks: Token[], s: Stmt): string {
  if (s.end <= s.start) return '';
  return src.slice(toks[s.start].pos, toks[s.end - 1].end);
}

// ------------------------------------------------------------------ expressions

export type Expr =
  | { k: 'str'; v: string; template?: boolean }
  | { k: 'num'; v: number }
  | { k: 're'; source: string; flags: string }
  | { k: 'lit'; v: boolean | null }
  | { k: 'obj'; props: Record<string, Expr> }
  | { k: 'arr'; items: Expr[] }
  | { k: 'ref'; name: string }
  | { k: 'member'; obj: Expr; name: string }
  | { k: 'call'; fn: Expr; args: Expr[]; kwargs: Record<string, Expr>; isNew?: boolean }
  | { k: 'index'; obj: Expr; index: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'concat'; parts: Expr[] }
  | { k: 'cmp'; op: string; left: Expr; right: Expr };

export class ParseError extends Error {}

const BOOL: Record<string, boolean | null> = { true: true, false: false, True: true, False: false, null: null, None: null, undefined: null };

/** Parse an expression from tokens [from, to). Throws ParseError when not fully understood. */
export function parseExpr(toks: Token[], from: number, to: number): Expr {
  let k = from;
  const peek = (o = 0): Token | undefined => (k + o < to ? toks[k + o] : undefined);
  const isP = (v: string, o = 0) => peek(o)?.t === 'p' && peek(o)?.v === v;
  const isId = (v: string, o = 0) => peek(o)?.t === 'id' && peek(o)?.v === v;
  const expectP = (v: string) => {
    if (!isP(v)) throw new ParseError(`expected "${v}" but found "${peek()?.v ?? 'end'}"`);
    k++;
  };

  const primary = (): Expr => {
    const tk = peek();
    if (!tk) throw new ParseError('unexpected end of expression');
    if (tk.t === 'str') {
      k++;
      let e: Expr = { k: 'str', v: tk.v, ...(tk.template ? { template: true } : {}) };
      // implicit concatenation of adjacent string literals (Python)
      while (peek()?.t === 'str') {
        const nx = peek()!;
        k++;
        e = { k: 'str', v: (e as { v: string }).v + nx.v, ...((e as { template?: boolean }).template || nx.template ? { template: true } : {}) };
      }
      return e;
    }
    if (tk.t === 'num') {
      k++;
      const v = Number(tk.v.replace(/_/g, '').replace(/[a-zA-Z]+$/, ''));
      if (Number.isNaN(v)) throw new ParseError(`bad number ${tk.v}`);
      return { k: 'num', v };
    }
    if (tk.t === 're') {
      k++;
      return { k: 're', source: tk.v, flags: tk.flags ?? '' };
    }
    if (tk.t === 'id') {
      if (tk.v in BOOL) {
        k++;
        return { k: 'lit', v: BOOL[tk.v] };
      }
      if (tk.v === 'async' || tk.v === 'function' || tk.v === 'lambda') throw new ParseError('functions are not supported');
      k++;
      if (isP('=>')) throw new ParseError('arrow functions are not supported');
      return { k: 'ref', name: tk.v };
    }
    if (tk.v === '(') {
      const close = matchBracket(toks, k);
      if (close < 0 || close >= to) throw new ParseError('unbalanced parenthesis');
      if (toks[close + 1]?.v === '=>' && close + 1 < to) throw new ParseError('arrow functions are not supported');
      const items = list(k + 1, close);
      k = close + 1;
      return items.length === 1 ? items[0] : { k: 'arr', items };
    }
    if (tk.v === '[') {
      const close = matchBracket(toks, k);
      if (close < 0 || close >= to) throw new ParseError('unbalanced bracket');
      const items = list(k + 1, close);
      k = close + 1;
      return { k: 'arr', items };
    }
    if (tk.v === '{') {
      const close = matchBracket(toks, k);
      if (close < 0 || close >= to) throw new ParseError('unbalanced brace');
      const props: Record<string, Expr> = {};
      const save = k;
      k = save + 1;
      while (k < close) {
        const key = peek();
        if (!key || (key.t !== 'id' && key.t !== 'str')) throw new ParseError('object keys must be names or strings');
        k++;
        if (isP(':')) {
          k++;
          const end = itemEnd(k, close);
          props[key.v] = parseExpr(toks, k, end);
          k = end;
        } else {
          props[key.v] = { k: 'ref', name: key.v };
        }
        if (isP(',')) k++;
        else if (k !== close) throw new ParseError('expected "," in object literal');
      }
      k = close + 1;
      return { k: 'obj', props };
    }
    throw new ParseError(`unexpected "${tk.v}"`);
  };

  /** End of a comma-separated item starting at `s` (bounded by `limit`). */
  const itemEnd = (s: number, limit: number): number => {
    let d = 0;
    for (let j = s; j < limit; j++) {
      const v = toks[j].t === 'p' ? toks[j].v : '';
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') d--;
      else if (v === ',' && d === 0) return j;
    }
    return limit;
  };

  const list = (s: number, e: number): Expr[] => {
    const items: Expr[] = [];
    let j = s;
    while (j < e) {
      const end = itemEnd(j, e);
      if (end > j) items.push(parseExpr(toks, j, end));
      j = end + 1;
    }
    return items;
  };

  const callArgs = (s: number, e: number): { args: Expr[]; kwargs: Record<string, Expr> } => {
    const args: Expr[] = [];
    const kwargs: Record<string, Expr> = {};
    let j = s;
    while (j < e) {
      const end = itemEnd(j, e);
      if (end > j) {
        const a = toks[j];
        const b = toks[j + 1];
        if (a.t === 'id' && b && b.t === 'p' && (b.v === '=' || b.v === ':') && j + 2 < end) kwargs[a.v] = parseExpr(toks, j + 2, end);
        else args.push(parseExpr(toks, j, end));
      }
      j = end + 1;
    }
    return { args, kwargs };
  };

  const postfix = (): Expr => {
    let isNew = false;
    if (isId('new')) {
      isNew = true;
      k++;
    }
    let e = primary();
    // Java/C# generics after `new X<...>(`
    if (isNew && isP('<')) {
      let d = 0;
      while (k < to) {
        if (isP('<')) d++;
        else if (isP('>')) d--;
        k++;
        if (d === 0) break;
      }
    }
    for (;;) {
      if (isP('.') || isP('?.') || isP('!.')) {
        k++;
        const nm = peek();
        if (!nm || nm.t !== 'id') {
          if (isP('(')) continue; // `?.(` optional call
          throw new ParseError('expected a member name');
        }
        k++;
        e = { k: 'member', obj: e, name: nm.v };
      } else if (isP('!') && (isP('.', 1) || isP(')', 1) || isP(',', 1) || peek(1) === undefined)) {
        k++; // TypeScript non-null assertion
      } else if (isP('(')) {
        const close = matchBracket(toks, k);
        if (close < 0 || close >= to) throw new ParseError('unbalanced call parenthesis');
        const { args, kwargs } = callArgs(k + 1, close);
        k = close + 1;
        e = { k: 'call', fn: e, args, kwargs, ...(isNew ? { isNew: true } : {}) };
        isNew = false;
      } else if (isP('[')) {
        const close = matchBracket(toks, k);
        if (close < 0 || close >= to) throw new ParseError('unbalanced index bracket');
        const index = parseExpr(toks, k + 1, close);
        k = close + 1;
        e = { k: 'index', obj: e, index };
      } else break;
    }
    return e;
  };

  const unary = (): Expr => {
    if (isId('await')) {
      k++;
      return unary();
    }
    if (isP('!') || isId('not')) {
      k++;
      return { k: 'not', e: unary() };
    }
    return postfix();
  };

  const additive = (): Expr => {
    const parts = [unary()];
    while (isP('+')) {
      k++;
      parts.push(unary());
    }
    return parts.length === 1 ? parts[0] : { k: 'concat', parts };
  };

  const comparison = (): Expr => {
    const left = additive();
    const t = peek();
    if (!t) return left;
    let op: string | undefined;
    if (t.t === 'p' && ['==', '===', '!=', '!==', '<', '>', '<=', '>='].includes(t.v)) op = t.v;
    else if (t.t === 'id' && t.v === 'in') op = 'in';
    else if (t.t === 'id' && t.v === 'not' && isId('in', 1)) {
      op = 'not in';
      k++;
    } else if (t.t === 'id' && t.v === 'is') op = isId('not', 1) ? (k++, 'is not') : 'is';
    if (!op) return left;
    k++;
    return { k: 'cmp', op, left, right: additive() };
  };

  const e = comparison();
  if (k < to && !(k === to - 1 && isP(';'))) throw new ParseError(`unexpected "${peek()?.v}"`);
  return e;
}

// ------------------------------------------------------------------ chains

export interface Segment {
  /** Identifier name (absent when the chain starts with a non-name expression). */
  name?: string;
  /** The root expression when it is not a plain name. */
  expr?: Expr;
  call: boolean;
  args: Expr[];
  kwargs: Record<string, Expr>;
  isNew?: boolean;
}

/** Flatten `a.b(x).c.d(y)` into segments [a, b(x), c, d(y)]. */
export function flatten(e: Expr): Segment[] {
  if (e.k === 'ref') return [{ name: e.name, call: false, args: [], kwargs: {} }];
  if (e.k === 'member') return [...flatten(e.obj), { name: e.name, call: false, args: [], kwargs: {} }];
  if (e.k === 'call') {
    const segs = flatten(e.fn);
    const last = segs[segs.length - 1];
    if (last.call) return [...segs, { call: true, args: e.args, kwargs: e.kwargs, expr: { k: 'lit', v: null } }];
    segs[segs.length - 1] = { ...last, call: true, args: e.args, kwargs: e.kwargs, ...(e.isNew ? { isNew: true } : {}) };
    return segs;
  }
  return [{ expr: e, call: false, args: [], kwargs: {} }];
}

/** String value of a literal (or a concatenation of literals); undefined otherwise. */
export function strOf(e: Expr | undefined, vars?: Map<string, Expr>): string | undefined {
  if (!e) return undefined;
  if (e.k === 'str') return e.template ? undefined : e.v;
  if (e.k === 'num') return String(e.v);
  if (e.k === 'ref' && vars?.has(e.name)) return strOf(vars.get(e.name), undefined);
  if (e.k === 'concat') {
    let s = '';
    for (const p of e.parts) {
      const v = strOf(p, vars);
      if (v === undefined) return undefined;
      s += v;
    }
    return s;
  }
  return undefined;
}

/** `a.b.c` as a dotted name, when the expression is only names and members. */
export function dotted(e: Expr): string | undefined {
  if (e.k === 'ref') return e.name;
  if (e.k === 'member') {
    const o = dotted(e.obj);
    return o === undefined ? undefined : `${o}.${e.name}`;
  }
  return undefined;
}

/** Replace references to known variables with their bound expressions (one level deep per name). */
export function substitute(e: Expr, vars: Map<string, Expr>, depth = 0): Expr {
  if (depth > 8) return e;
  switch (e.k) {
    case 'ref': {
      const v = vars.get(e.name);
      return v ? substitute(v, vars, depth + 1) : e;
    }
    case 'member': return { ...e, obj: substitute(e.obj, vars, depth) };
    case 'call': return { ...e, fn: substitute(e.fn, vars, depth), args: e.args.map((a) => substitute(a, vars, depth)),
      kwargs: Object.fromEntries(Object.entries(e.kwargs).map(([kk, v]) => [kk, substitute(v, vars, depth)])) };
    case 'index': return { ...e, obj: substitute(e.obj, vars, depth), index: substitute(e.index, vars, depth) };
    case 'not': return { ...e, e: substitute(e.e, vars, depth) };
    case 'concat': return { ...e, parts: e.parts.map((p) => substitute(p, vars, depth)) };
    case 'cmp': return { ...e, left: substitute(e.left, vars, depth), right: substitute(e.right, vars, depth) };
    case 'arr': return { ...e, items: e.items.map((p) => substitute(p, vars, depth)) };
    case 'obj': return { ...e, props: Object.fromEntries(Object.entries(e.props).map(([kk, v]) => [kk, substitute(v, vars, depth)])) };
    default: return e;
  }
}

/** Parse a variable declaration statement: `const x = ...`, `WebElement x = ...`, `var x = ...`, `x = ...`. */
export function declaration(toks: Token[], s: Stmt): { name: string; valueStart: number } | undefined {
  let k = s.start;
  const isId = (j: number) => toks[j]?.t === 'id';
  while (k < s.end && toks[k].t === 'id' && /^(?:const|let|var|final|readonly|private|public|static)$/.test(toks[k].v) && isId(k + 1)) k++;
  // Typed declaration: Type name = ...  /  Type<Generic> name = ...
  if (isId(k) && isId(k + 1) && toks[k + 2]?.v === '=' && toks[k + 2].t === 'p') return { name: toks[k + 1].v, valueStart: k + 3 };
  if (isId(k) && toks[k + 1]?.v === '<') {
    let j = k + 1;
    let d = 0;
    for (; j < s.end; j++) {
      if (toks[j].v === '<') d++;
      else if (toks[j].v === '>') d--;
      if (d === 0) break;
    }
    if (isId(j + 1) && toks[j + 2]?.v === '=') return { name: toks[j + 1].v, valueStart: j + 3 };
  }
  // name: Type = ... (TS / Python annotations)
  if (isId(k) && toks[k + 1]?.v === ':' && isId(k + 2) && toks[k + 3]?.v === '=') return { name: toks[k].v, valueStart: k + 4 };
  if (isId(k) && toks[k + 1]?.t === 'p' && toks[k + 1].v === '=') return { name: toks[k].v, valueStart: k + 2 };
  return undefined;
}

/** "loginAsBob" / "test_login_as_bob" / "Login_As_Bob" -> "login as bob". */
export function humanize(name: string): string {
  return name
    .replace(/^test_?/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_]+/g, ' ')
    .trim()
    .toLowerCase() || name;
}
