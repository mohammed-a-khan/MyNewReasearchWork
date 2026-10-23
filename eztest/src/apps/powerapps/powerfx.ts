/**
 * A small, deterministic Power Fx expression evaluator for assertions over
 * canvas app state: `galAccounts.Selected.'Account Name' = "Fabrikam"`,
 * `CountRows(galAccounts.AllItems) > 2 && lblStatus.Text = "Saved"`,
 * `btnDelete.DisplayMode = DisplayMode.Disabled`. It parses into an AST and
 * evaluates against a snapshot of control properties; nothing is executed in
 * JavaScript (no eval). Supported: number/string/boolean literals, Blank(),
 * Control.Property and record field access ('Quoted Names' too), DisplayMode.*,
 * = <> < > <= >=, & (concatenate), + - * /, !, Not, && And, || Or, and the
 * functions CountRows, IsBlank, IsEmpty, Len, Text, Value, Lower, Upper, Trim,
 * If, First, Last, Concatenate, Not, And, Or.
 */
import { EzTestError } from '../../core/index.js';

type Tok = { t: 'num' | 'str' | 'id' | 'qid' | 'op' | 'eof'; v: string; pos: number };
export type FxValue = string | number | boolean | null | undefined | FxValue[] | { [k: string]: FxValue };
type Node =
  | { k: 'lit'; v: FxValue }
  | { k: 'name'; v: string }
  | { k: 'dot'; obj: Node; v: string }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

export class PowerFxError extends EzTestError {
  constructor(message: string) {
    super(message, 'PA_POWERFX');
    this.name = 'PowerFxError';
  }
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let s = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new PowerFxError(`Unterminated string at ${i}`);
        if (src[j] === '"' && src[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (src[j] === '"') break;
        else s += src[j++];
      }
      out.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new PowerFxError(`Unterminated 'name' at ${i}`);
      out.push({ t: 'qid', v: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    const op = /^(<>|<=|>=|&&|\|\||[=<>&+\-*/!().,])/.exec(src.slice(i));
    if (!op) throw new PowerFxError(`Unexpected "${c}" at ${i}`);
    out.push({ t: 'op', v: op[0], pos: i });
    i += op[0].length;
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

export function parsePowerFx(src: string): Node {
  const toks = lex(src.trim().replace(/^=/, ''));
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v: string) => peek().t === 'op' && peek().v === v;
  const isWord = (v: string) => peek().t === 'id' && peek().v.toLowerCase() === v.toLowerCase();
  const expect = (v: string) => {
    if (!isOp(v)) throw new PowerFxError(`Expected "${v}" at ${peek().pos}, found "${peek().v || 'end'}"`);
    p++;
  };
  const or = (): Node => {
    let a = and();
    while (isOp('||') || isWord('Or')) {
      p++;
      a = { k: 'bin', op: '||', a, b: and() };
    }
    return a;
  };
  const and = (): Node => {
    let a = not();
    while (isOp('&&') || isWord('And')) {
      p++;
      a = { k: 'bin', op: '&&', a, b: not() };
    }
    return a;
  };
  const not = (): Node => {
    if (isOp('!') || (isWord('Not') && toks[p + 1]?.v !== '(')) {
      p++;
      return { k: 'un', op: '!', a: not() };
    }
    return cmp();
  };
  const cmp = (): Node => {
    const a = concat();
    const t = peek();
    if (t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      p++;
      return { k: 'bin', op: t.v, a, b: concat() };
    }
    return a;
  };
  const concat = (): Node => {
    let a = add();
    while (isOp('&')) {
      p++;
      a = { k: 'bin', op: '&', a, b: add() };
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp('+') || isOp('-')) a = { k: 'bin', op: next().v, a, b: mul() };
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (isOp('*') || isOp('/')) a = { k: 'bin', op: next().v, a, b: unary() };
    return a;
  };
  const unary = (): Node => (isOp('-') ? (p++, { k: 'un', op: '-', a: unary() }) : postfix());
  const postfix = (): Node => {
    let n = primary();
    while (isOp('.')) {
      p++;
      const t = next();
      if (t.t !== 'id' && t.t !== 'qid') throw new PowerFxError(`Expected a name after "." at ${t.pos}`);
      n = { k: 'dot', obj: n, v: t.v };
    }
    return n;
  };
  const primary = (): Node => {
    const t = next();
    if (t.t === 'num') return { k: 'lit', v: Number(t.v) };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'qid') return { k: 'name', v: t.v };
    if (t.t === 'id') {
      if (/^true$/i.test(t.v)) return { k: 'lit', v: true };
      if (/^false$/i.test(t.v)) return { k: 'lit', v: false };
      if (isOp('(')) {
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            p++;
            args.push(or());
          }
        }
        expect(')');
        return { k: 'call', fn: t.v, args };
      }
      return { k: 'name', v: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      const e = or();
      expect(')');
      return e;
    }
    throw new PowerFxError(`Unexpected "${t.v || 'end of formula'}" at ${t.pos}`);
  };
  const ast = or();
  if (peek().t !== 'eof') throw new PowerFxError(`Unexpected "${peek().v}" at ${peek().pos}`);
  return ast;
}

const blank = (v: FxValue) => v === null || v === undefined || v === '';
const num = (v: FxValue): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (blank(v)) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new PowerFxError(`"${String(v)}" is not a number`);
  return n;
};
const str = (v: FxValue): string => (blank(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const truthy = (v: FxValue): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : /^true$/i.test(str(v)));

function field(obj: FxValue, name: string): FxValue {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const key = Object.keys(obj).find((k) => k === name) ?? Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : obj[key];
  }
  if (Array.isArray(obj)) return obj.map((r) => field(r, name)) as FxValue;
  return undefined;
}

/** Evaluate a Power Fx expression; `scope` maps control (and App) names to their property records. */
export function evaluatePowerFx(src: string, scope: Record<string, Record<string, FxValue>>): FxValue {
  const ast = parsePowerFx(src);
  const ev = (n: Node): FxValue => {
    switch (n.k) {
      case 'lit': return n.v;
      case 'name': {
        if (n.v === 'DisplayMode') return { Edit: 'Edit', View: 'View', Disabled: 'Disabled' };
        const c = scope[n.v] ?? Object.entries(scope).find(([k]) => k.toLowerCase() === n.v.toLowerCase())?.[1];
        if (!c) throw new PowerFxError(`Name isn't valid: "${n.v}" is not a control on the open app (controls: ${Object.keys(scope).join(', ')})`);
        return c as FxValue;
      }
      case 'dot': return field(ev(n.obj), n.v);
      case 'un': return n.op === '!' ? !truthy(ev(n.a)) : -num(ev(n.a));
      case 'bin': {
        if (n.op === '&&') return truthy(ev(n.a)) && truthy(ev(n.b));
        if (n.op === '||') return truthy(ev(n.a)) || truthy(ev(n.b));
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '&': return str(a) + str(b);
          case '+': return num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': return num(a) / num(b);
          case '=':
          case '<>': {
            const eq = typeof a === 'number' || typeof b === 'number' ? !blank(a) && !blank(b) ? num(a) === num(b) : blank(a) && blank(b) : typeof a === 'boolean' || typeof b === 'boolean' ? truthy(a) === truthy(b) : str(a) === str(b);
            return n.op === '=' ? eq : !eq;
          }
          default: {
            const [x, y] = typeof a === 'string' && typeof b === 'string' && Number.isNaN(Number(a)) ? [a, b] : [num(a), num(b)];
            return n.op === '<' ? x < y : n.op === '>' ? x > y : n.op === '<=' ? x <= y : x >= y;
          }
        }
      }
      case 'call': {
        const f = n.fn.toLowerCase();
        const args = () => n.args.map(ev);
        const one = () => {
          if (n.args.length !== 1) throw new PowerFxError(`${n.fn} takes one argument`);
          return ev(n.args[0]);
        };
        switch (f) {
          case 'countrows': { const t = one(); return Array.isArray(t) ? t.length : 0; }
          case 'isempty': { const t = one(); return !Array.isArray(t) || t.length === 0; }
          case 'isblank': return blank(one());
          case 'blank': return null;
          case 'len': return str(one()).length;
          case 'text': return str(one());
          case 'value': return num(one());
          case 'lower': return str(one()).toLowerCase();
          case 'upper': return str(one()).toUpperCase();
          case 'trim': return str(one()).trim().replace(/\s+/g, ' ');
          case 'first': { const t = one(); return Array.isArray(t) ? t[0] : undefined; }
          case 'last': { const t = one(); return Array.isArray(t) ? t[t.length - 1] : undefined; }
          case 'concatenate': return args().map(str).join('');
          case 'not': return !truthy(one());
          case 'and': return args().every(truthy);
          case 'or': return args().some(truthy);
          case 'if': {
            for (let i = 0; i + 1 < n.args.length; i += 2) if (truthy(ev(n.args[i]))) return ev(n.args[i + 1]);
            return n.args.length % 2 ? ev(n.args[n.args.length - 1]) : null;
          }
          default: throw new PowerFxError(`Function ${n.fn} is not supported in EZTest Power Fx assertions`);
        }
      }
    }
  };
  return ev(ast);
}

/** The control names a formula refers to (first segment of each name chain). */
export function powerFxNames(src: string): string[] {
  const names = new Set<string>();
  const walk = (n: Node, top = true) => {
    if (n.k === 'name' && top) names.add(n.v);
    if (n.k === 'dot') walk(n.obj, true);
    if (n.k === 'call') n.args.forEach((a) => walk(a));
    if (n.k === 'un') walk(n.a);
    if (n.k === 'bin') {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(parsePowerFx(src));
  return [...names].filter((x) => x !== 'DisplayMode');
}
