/**
 * A tiny, safe expression language for variables, conditions and loops.
 *
 *   ${price} * ${qty}            "ORD-" + id            addDays(today(), 3)
 *   len(orders.body) > 2         upper(trim(name))      count >= 3 and not done
 *
 * It is a hand-written tokenizer and recursive-descent parser over a fixed
 * grammar. Nothing is ever handed to eval or the Function constructor: the
 * only operations are the operators below and a whitelisted function set.
 *
 * Grammar (lowest precedence first):
 *   ternary  := or ('?' ternary ':' ternary)?
 *   or       := and (('||' | 'or') and)*
 *   and      := not (('&&' | 'and') not)*
 *   not      := ('!' | 'not') not | compare
 *   compare  := add (('==' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'matches' | 'startsWith' | 'endsWith' | 'in') add)?
 *   add      := mul (('+' | '-') mul)*
 *   mul      := unary (('*' | '/' | '%') unary)*
 *   unary    := '-' unary | postfix
 *   postfix  := primary ('.' name | '[' ternary ']')*
 *   primary  := number | string | true | false | null | ${path} | name | name '(' args ')' | '(' ternary ')' | '[' list ']'
 *
 * Identifiers are variables; a bare word that is not a known variable is an
 * error (quote text). `+` adds when both sides are numbers (or numeric text)
 * and concatenates otherwise. String literals interpolate ${var}.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { EzTestError, interpolate } from './util.js';
import { formatCurrency, formatLocaleDate, formatLocaleNumber, parseLocaleDate, parseLocaleNumber } from './locale.js';
import { uniqueEmail, uniqueValue } from './unique.js';

export class ExpressionError extends EzTestError {
  constructor(message: string, readonly expression: string) {
    super(`${message} in expression: ${expression}`, 'EXPRESSION', { expression });
    this.name = 'ExpressionError';
  }
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'var'; v: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'end' };

export type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'str'; v: string }
  | { k: 'var'; path: string }
  | { k: 'get'; obj: Node; key: Node }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'list'; items: Node[] }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node };

const MAX_LENGTH = 4000;
const MAX_DEPTH = 60;
const WORD_OPS = new Set(['and', 'or', 'not', 'contains', 'matches', 'startswith', 'endswith', 'in']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const err = (m: string) => new ExpressionError(m, src);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const prev = out[out.length - 1];
    const afterValue = prev !== undefined && (prev.t === 'name' || prev.t === 'var' || prev.t === 'str' || (prev.t === 'op' && (prev.v === ']' || prev.v === ')')));
    const afterDot = prev !== undefined && prev.t === 'op' && prev.v === '.';
    if (afterDot && /\d/.test(c)) {
      // A numeric property, e.g. rows.0.name: integer digits only.
      const m = /^\d+/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && !afterValue && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || c === '“') {
      const close = c === '“' ? '”' : c;
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== close) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          v += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
          continue;
        }
        v += src[j++];
      }
      if (j >= src.length) throw err('unterminated string');
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw err('unterminated ${');
      const path = src.slice(i + 2, j).trim();
      if (!/^[A-Za-z_][\w]*(?:\.[\w-]+|\[\d+\])*$/.test(path)) throw err(`bad variable reference \${${path}}`);
      out.push({ t: 'var', v: path.replace(/\[(\d+)\]/g, '.$1') });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i))!;
      const w = m[0];
      if (WORD_OPS.has(w.toLowerCase())) out.push({ t: 'op', v: w.toLowerCase() });
      else out.push({ t: 'name', v: w });
      i += w.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%<>!()[],.?:='.includes(c)) {
      out.push({ t: 'op', v: c === '=' ? '==' : c });
      i++;
      continue;
    }
    throw err(`unexpected character "${c}"`);
  }
  out.push({ t: 'end' });
  return out;
}

/** Parse an expression into a syntax tree (throws ExpressionError with a clear message). */
export function parseExpression(src: string): Node {
  if (typeof src !== 'string' || !src.trim()) throw new ExpressionError('empty expression', String(src));
  if (src.length > MAX_LENGTH) throw new ExpressionError(`expression longer than ${MAX_LENGTH} characters`, src.slice(0, 60) + '...');
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const err = (m: string) => new ExpressionError(m, src);
  const peek = () => toks[p];
  const isOp = (v: string) => {
    const t = toks[p];
    return t.t === 'op' && t.v === v;
  };
  const eat = (v: string) => {
    if (!isOp(v)) throw err(`expected "${v}"`);
    p++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw err('expression nested too deeply');
  };

  function ternary(): Node {
    enter();
    const c = or();
    if (isOp('?')) {
      p++;
      const a = ternary();
      eat(':');
      const b = ternary();
      depth--;
      return { k: 'cond', c, a, b };
    }
    depth--;
    return c;
  }
  function or(): Node {
    let a = and();
    while (isOp('||') || isOp('or')) {
      p++;
      a = { k: 'bin', op: 'or', a, b: and() };
    }
    return a;
  }
  function and(): Node {
    let a = not();
    while (isOp('&&') || isOp('and')) {
      p++;
      a = { k: 'bin', op: 'and', a, b: not() };
    }
    return a;
  }
  function not(): Node {
    if (isOp('!') || isOp('not')) {
      p++;
      enter();
      const a = not();
      depth--;
      return { k: 'un', op: 'not', a };
    }
    return compare();
  }
  function compare(): Node {
    const a = add();
    const t = peek();
    if (t.t === 'op' && ['==', '!=', '<', '<=', '>', '>=', 'contains', 'matches', 'startswith', 'endswith', 'in'].includes(t.v)) {
      p++;
      return { k: 'bin', op: t.v, a, b: add() };
    }
    return a;
  }
  function add(): Node {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  }
  function mul(): Node {
    let a = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  }
  function unary(): Node {
    if (isOp('-')) {
      p++;
      enter();
      const a = unary();
      depth--;
      return { k: 'un', op: 'neg', a };
    }
    return postfix();
  }
  function postfix(): Node {
    let n = primary();
    for (;;) {
      if (isOp('.')) {
        p++;
        const t = peek();
        if (t.t === 'name') n = { k: 'get', obj: n, key: { k: 'lit', v: t.v } };
        else if (t.t === 'num') n = { k: 'get', obj: n, key: { k: 'lit', v: t.v } };
        else throw err('expected a property name after "."');
        p++;
      } else if (isOp('[')) {
        p++;
        const key = ternary();
        eat(']');
        n = { k: 'get', obj: n, key };
      } else return n;
    }
  }
  function primary(): Node {
    const t = peek();
    p++;
    switch (t.t) {
      case 'num': return { k: 'lit', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'var': return { k: 'var', path: t.v };
      case 'name': {
        const w = t.v;
        if (w === 'true' || w === 'false') return { k: 'lit', v: w === 'true' };
        if (w === 'null' || w === 'undefined') return { k: 'lit', v: null };
        if (isOp('(')) {
          p++;
          const fn = w.toLowerCase();
          if (!Object.hasOwn(FUNCTIONS, fn)) throw err(`unknown function "${w}" (available: ${Object.keys(FUNCTIONS).sort().join(', ')})`);
          const args: Node[] = [];
          if (!isOp(')')) {
            for (;;) {
              args.push(ternary());
              if (isOp(',')) {
                p++;
                continue;
              }
              break;
            }
          }
          eat(')');
          return { k: 'call', fn, args };
        }
        return { k: 'var', path: w };
      }
      case 'op':
        if (t.v === '(') {
          const e = ternary();
          eat(')');
          return e;
        }
        if (t.v === '[') {
          const items: Node[] = [];
          if (!isOp(']')) {
            for (;;) {
              items.push(ternary());
              if (isOp(',')) {
                p++;
                continue;
              }
              break;
            }
          }
          eat(']');
          return { k: 'list', items };
        }
        throw err(`unexpected "${t.v}"`);
      case 'end':
        throw err('unexpected end');
    }
  }

  const tree = ternary();
  if (peek().t !== 'end') {
    const t = peek() as { v?: unknown };
    throw err(`unexpected "${String(t.v)}" (text must be quoted)`);
  }
  return tree;
}

// ------------------------------------------------------------------ values

const NUMERIC = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s*$/;

/** A number for a number or numeric text; undefined otherwise. */
export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && NUMERIC.test(v)) return Number(v);
  if (typeof v === 'boolean') return undefined;
  return undefined;
}

/** Text form of any value (objects as JSON). */
export function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0';
  return Boolean(v);
}

function looseEquals(a: unknown, b: unknown): boolean {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return asText(a) === asText(b);
}

function compareValues(a: unknown, b: unknown): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  const sa = asText(a);
  const sb = asText(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ------------------------------------------------------------------ dates

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function toDate(v: unknown, fn: string): Date {
  if (v instanceof Date) return v;
  const s = asText(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${fn}: "${s}" is not a date`);
  return d;
}

function isDateOnly(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Format a date with tokens YYYY YY MM M DD D HH mm ss SSS (UTC). */
export function formatDate(d: Date, pattern: string): string {
  const map: Record<string, string> = {
    YYYY: String(d.getUTCFullYear()), YY: String(d.getUTCFullYear()).slice(-2), MM: pad(d.getUTCMonth() + 1), M: String(d.getUTCMonth() + 1),
    DD: pad(d.getUTCDate()), D: String(d.getUTCDate()), HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()),
    SSS: pad(d.getUTCMilliseconds(), 3),
  };
  return pattern.replace(/YYYY|YY|MM|M|DD|D|HH|mm|ss|SSS/g, (t) => map[t]);
}

// ------------------------------------------------------------------ time zones

function checkZone(tz: unknown, fn: string): string {
  const z = asText(tz);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
  } catch {
    throw new Error(`${fn}: unknown time zone "${z}" (use an IANA name such as "America/New_York")`);
  }
  return z;
}

/** Wall-clock parts of instant `d` in `tz`, as a Date whose UTC fields carry them (for formatDate). */
function wallClock(d: Date, tz: string): Date {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second), d.getUTCMilliseconds()));
}

/** Offset of `tz` from UTC at instant `d`, as +HH:MM. */
function offsetOf(d: Date, tz: string): string {
  const diff = Math.round((wallClock(d, tz).getTime() - d.getTime()) / 60_000);
  const sign = diff < 0 ? '-' : '+';
  const a = Math.abs(diff);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** ISO-8601 local time with offset in `tz`, e.g. 2026-03-01T09:30:00.000-05:00. */
export function isoInZone(d: Date, tz: string): string {
  const w = wallClock(d, tz);
  return `${isoDate(w)}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}.${pad(w.getUTCMilliseconds(), 3)}${offsetOf(d, tz)}`;
}

// ------------------------------------------------------------------ pinned time zone and locale

let defaultZone: string | undefined;
let defaultLocale = 'en-US';

/**
 * Pin the time zone used by today(), now() and format() when no zone is given
 * (config `timezone:`), so date expressions and the browser agree. undefined = UTC.
 */
export function setDefaultTimeZone(tz: string | undefined): void {
  defaultZone = tz === undefined ? undefined : checkZone(tz, 'timezone');
}

export function getDefaultTimeZone(): string | undefined {
  return defaultZone;
}

/** Default locale of the locale-aware functions (config `locale:`). */
export function setDefaultLocale(locale: string | undefined): void {
  defaultLocale = locale ?? 'en-US';
}

export function getDefaultLocale(): string {
  return defaultLocale;
}

// ------------------------------------------------------------------ business days

interface BusinessCalendar {
  holidays: Set<string>;
  weekend: Set<number>;
}
let calendar: BusinessCalendar = { holidays: new Set(), weekend: new Set([0, 6]) };

/** Set the default holiday calendar and weekend days used by the business-day functions (config `dates`). */
export function setBusinessCalendar(o: { holidays?: Iterable<string>; weekend?: Iterable<number> }): void {
  calendar = { holidays: new Set(o.holidays ?? []), weekend: new Set(o.weekend ?? [0, 6]) };
}

export function getBusinessCalendar(): { holidays: string[]; weekend: number[] } {
  return { holidays: [...calendar.holidays].sort(), weekend: [...calendar.weekend].sort() };
}

function holidaySet(extra: unknown, fn: string): Set<string> {
  if (extra === undefined || extra === null) return calendar.holidays;
  const l = list(extra, fn).map((h) => {
    const t = asText(h);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`${fn}: holiday "${t}" must be YYYY-MM-DD`);
    return t;
  });
  return new Set([...calendar.holidays, ...l]);
}

function isBusiness(d: Date, holidays: Set<string>): boolean {
  return !calendar.weekend.has(d.getUTCDay()) && !holidays.has(isoDate(d));
}

/** Add n business days (n may be negative; n = 0 rolls a non-business day forward). Keeps the time of day. */
function addBusiness(v: unknown, n: number, extra: unknown, fn: string): string {
  if (!Number.isInteger(n)) throw new Error(`${fn}: the number of days must be a whole number`);
  const hol = holidaySet(extra, fn);
  const d = new Date(toDate(v, fn).getTime());
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  if (left === 0) {
    for (let i = 0; i < 3660 && !isBusiness(d, hol); i++) d.setUTCDate(d.getUTCDate() + 1);
  }
  for (let guard = 0; left > 0; guard++) {
    if (guard > 36_600) throw new Error(`${fn}: no business days found (check the weekend and holiday calendar)`);
    d.setUTCDate(d.getUTCDate() + step);
    if (isBusiness(d, hol)) left--;
  }
  return isDateOnly(v) ? isoDate(d) : d.toISOString();
}

function shiftDate(v: unknown, ms: number, fn: string, months = 0): string {
  const d = new Date(toDate(v, fn).getTime() + ms);
  if (months) d.setUTCMonth(d.getUTCMonth() + months);
  return isDateOnly(v) ? isoDate(d) : d.toISOString();
}

// ------------------------------------------------------------------ functions

type Fn = (args: unknown[]) => unknown;
const num = (v: unknown, fn: string): number => {
  const n = asNumber(v);
  if (n === undefined) throw new Error(`${fn}: "${asText(v)}" is not a number`);
  return n;
};
const list = (v: unknown, fn: string): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      if (Array.isArray(p)) return p;
    } catch {
      /* not JSON */
    }
  }
  throw new Error(`${fn}: expected a list`);
};

/** Variable holding the fake epoch ms of an installed browser clock; today() and now() use it. */
export const CLOCK_NOW_VAR = '__eztestClockNow';

let clockNow: number | undefined;
function withClockNow<T>(t: number, fn: () => T): T {
  const prev = clockNow;
  clockNow = t;
  try {
    return fn();
  } finally {
    clockNow = prev;
  }
}
const current = () => (clockNow === undefined ? new Date() : new Date(clockNow));

/** The whitelisted functions (names are case-insensitive). */
export const FUNCTIONS: Record<string, Fn> = {
  today: ([tz]) => {
    const z = tz === undefined ? defaultZone : checkZone(tz, 'today');
    return z === undefined ? isoDate(current()) : isoDate(wallClock(current(), z));
  },
  now: ([tz]) => {
    const z = tz === undefined ? defaultZone : checkZone(tz, 'now');
    return z === undefined ? current().toISOString() : isoInZone(current(), z);
  },
  addbusinessdays: ([d, n, holidays]) => addBusiness(d, num(n, 'addBusinessDays'), holidays, 'addBusinessDays'),
  isbusinessday: ([d, holidays]) => isBusiness(toDate(d, 'isBusinessDay'), holidaySet(holidays, 'isBusinessDay')),
  nextbusinessday: ([d, holidays]) => addBusiness(d, 1, holidays, 'nextBusinessDay'),
  previousbusinessday: ([d, holidays]) => addBusiness(d, -1, holidays, 'previousBusinessDay'),
  adddays: ([d, n]) => shiftDate(d, num(n, 'addDays') * 86_400_000, 'addDays'),
  addhours: ([d, n]) => shiftDate(d, num(n, 'addHours') * 3_600_000, 'addHours'),
  addminutes: ([d, n]) => shiftDate(d, num(n, 'addMinutes') * 60_000, 'addMinutes'),
  addmonths: ([d, n]) => shiftDate(d, 0, 'addMonths', num(n, 'addMonths')),
  daysbetween: ([a, b]) => Math.round((toDate(b, 'daysBetween').getTime() - toDate(a, 'daysBetween').getTime()) / 86_400_000),
  format: ([v, pattern, tz]) => {
    if (typeof v === 'number' && typeof pattern === 'number') return v.toFixed(pattern);
    const d = toDate(v, 'format');
    // A date-only value is a calendar date, not an instant: the zone does not shift it.
    const z = tz === undefined ? defaultZone : checkZone(tz, 'format');
    const local = z === undefined || isDateOnly(v) ? d : wallClock(d, z);
    return formatDate(local, asText(pattern ?? 'YYYY-MM-DD'));
  },
  formatnumber: ([v, digits]) => num(v, 'formatNumber').toFixed(digits === undefined ? 2 : num(digits, 'formatNumber')),
  // Locale-aware formatting and parsing (default locale: config `locale:`).
  formatlocalenumber: ([v, locale, digits]) => formatLocaleNumber(num(v, 'formatLocaleNumber'), locale === undefined ? defaultLocale : asText(locale), digits === undefined ? undefined : num(digits, 'formatLocaleNumber')),
  formatcurrency: ([v, currency, locale]) => formatCurrency(num(v, 'formatCurrency'), asText(currency ?? 'EUR'), locale === undefined ? defaultLocale : asText(locale)),
  formatlocaledate: ([d, locale, style]) => formatLocaleDate(asText(d), locale === undefined ? defaultLocale : asText(locale), (style === undefined ? 'medium' : asText(style)) as 'medium'),
  parselocalenumber: ([t, locale]) => {
    const n = parseLocaleNumber(asText(t), locale === undefined ? defaultLocale : asText(locale));
    if (n === undefined) throw new Error(`parseLocaleNumber: "${asText(t)}" holds no number`);
    return n;
  },
  parselocaledate: ([t, locale]) => {
    const d = parseLocaleDate(asText(t), locale === undefined ? defaultLocale : asText(locale));
    if (d === undefined) throw new Error(`parseLocaleDate: "${asText(t)}" is not a date in ${locale === undefined ? defaultLocale : asText(locale)}`);
    return d;
  },
  upper: ([s]) => asText(s).toUpperCase(),
  lower: ([s]) => asText(s).toLowerCase(),
  trim: ([s]) => asText(s).trim(),
  len: ([v]) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : asText(v).length),
  length: ([v]) => FUNCTIONS.len([v]),
  substring: ([s, a, b]) => asText(s).substring(num(a, 'substring'), b === undefined ? undefined : num(b, 'substring')),
  replace: ([s, a, b]) => asText(s).split(asText(a)).join(asText(b)),
  split: ([s, sep]) => asText(s).split(asText(sep ?? ',')),
  join: ([l, sep]) => list(l, 'join').map(asText).join(asText(sep ?? ',')),
  concat: (args) => args.map(asText).join(''),
  contains: ([a, b]) => (Array.isArray(a) ? a.some((x) => looseEquals(x, b)) : asText(a).includes(asText(b))),
  startswith: ([a, b]) => asText(a).startsWith(asText(b)),
  endswith: ([a, b]) => asText(a).endsWith(asText(b)),
  padstart: ([s, n, c]) => asText(s).padStart(num(n, 'padStart'), asText(c ?? ' ')),
  number: ([v]) => num(v, 'number'),
  int: ([v]) => Math.trunc(num(v, 'int')),
  string: ([v]) => asText(v),
  round: ([v, d]) => {
    const f = 10 ** (d === undefined ? 0 : num(d, 'round'));
    return Math.round(num(v, 'round') * f) / f;
  },
  floor: ([v]) => Math.floor(num(v, 'floor')),
  ceil: ([v]) => Math.ceil(num(v, 'ceil')),
  abs: ([v]) => Math.abs(num(v, 'abs')),
  min: (args) => Math.min(...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map((v) => num(v, 'min'))),
  max: (args) => Math.max(...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map((v) => num(v, 'max'))),
  sum: ([l]) => list(l, 'sum').reduce<number>((a, v) => a + num(v, 'sum'), 0),
  random: ([a, b]) => {
    if (a === undefined) return Math.random();
    const lo = b === undefined ? 0 : num(a, 'random');
    const hi = b === undefined ? num(a, 'random') : num(b, 'random');
    return randomInt(Math.ceil(lo), Math.floor(hi) + 1);
  },
  randomstring: ([n]) => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < (n === undefined ? 8 : num(n, 'randomString')); i++) s += alphabet[randomInt(alphabet.length)];
    return s;
  },
  uuid: () => randomUUID(),
  /** Unique across parallel workers, CI shards and runs: unique("ORD-"), unique("C", 12) (max length). */
  unique: ([prefix, max]) => uniqueValue(prefix === undefined ? '' : asText(prefix), max === undefined ? undefined : num(max, 'unique')),
  uniqueemail: ([domain]) => uniqueEmail(domain === undefined ? 'example.test' : asText(domain)),
  first: ([l]) => list(l, 'first')[0],
  last: ([l]) => list(l, 'last').at(-1),
  at: ([l, i]) => list(l, 'at').at(num(i, 'at')),
  keys: ([o]) => (o && typeof o === 'object' ? Object.keys(o) : []),
  pluck: ([l, k]) => list(l, 'pluck').map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>)[asText(k)] : undefined)),
  json: ([v]) => JSON.stringify(v === undefined ? null : v),
  /** Some payload template styles spell json() as jsonEncode(). */
  jsonencode: ([v]) => JSON.stringify(v === undefined ? null : v),
  parsejson: ([v]) => JSON.parse(asText(v)),
  match: ([s, re, g]) => {
    const m = new RegExp(asText(re)).exec(asText(s));
    return m ? (m[g === undefined ? (m.length > 1 ? 1 : 0) : num(g, 'match')] ?? null) : null;
  },
  isempty: ([v]) => !truthy(v),
  coalesce: (args) => args.find((v) => v !== undefined && v !== null && v !== ''),
  range: ([a, b]) => {
    const lo = b === undefined ? 1 : num(a, 'range');
    const hi = b === undefined ? num(a, 'range') : num(b, 'range');
    if (hi - lo > 100_000) throw new Error('range: too many items');
    return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
  },
};

// ------------------------------------------------------------------ evaluation

function lookup(vars: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, part)) cur = (cur as Record<string, unknown>)[part];
    else return { found: false, value: undefined };
  }
  return { found: true, value: cur };
}

function evalNode(n: Node, vars: Record<string, unknown>, src: string): unknown {
  const ev = (x: Node) => evalNode(x, vars, src);
  switch (n.k) {
    case 'lit': return n.v;
    case 'str': return interpolate(n.v, vars);
    case 'var': {
      const r = lookup(vars, n.path);
      if (!r.found) throw new ExpressionError(`unknown variable "${n.path}" (quote text, e.g. "${n.path}")`, src);
      return r.value;
    }
    case 'get': {
      const o = ev(n.obj);
      const k = asText(ev(n.key));
      if (o === null || o === undefined) return undefined;
      if (typeof o === 'string') return k === 'length' ? o.length : o[Number(k)];
      if (Array.isArray(o) && k === 'length') return o.length;
      return typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
    }
    case 'list': return n.items.map(ev);
    case 'call': {
      try {
        // today() / now() follow a browser clock the journey installed (src/runner/clock.ts).
        const fake = vars[CLOCK_NOW_VAR];
        if ((n.fn === 'today' || n.fn === 'now') && typeof fake === 'number') return withClockNow(fake, () => FUNCTIONS[n.fn](n.args.map(ev)));
        return FUNCTIONS[n.fn](n.args.map(ev));
      } catch (e) {
        if (e instanceof ExpressionError) throw e;
        throw new ExpressionError((e as Error).message, src);
      }
    }
    case 'un': {
      const a = ev(n.a);
      if (n.op === 'not') return !truthy(a);
      const v = asNumber(a);
      if (v === undefined) throw new ExpressionError(`cannot negate "${asText(a)}"`, src);
      return -v;
    }
    case 'cond': return truthy(ev(n.c)) ? ev(n.a) : ev(n.b);
    case 'bin': {
      if (n.op === 'and') return truthy(ev(n.a)) && truthy(ev(n.b));
      if (n.op === 'or') return truthy(ev(n.a)) || truthy(ev(n.b));
      const a = ev(n.a);
      const b = ev(n.b);
      switch (n.op) {
        case '+': {
          const na = asNumber(a);
          const nb = asNumber(b);
          if (na !== undefined && nb !== undefined) return na + nb;
          if (Array.isArray(a)) return [...a, ...(Array.isArray(b) ? b : [b])];
          return asText(a) + asText(b);
        }
        case '-': case '*': case '/': case '%': {
          const na = asNumber(a);
          const nb = asNumber(b);
          if (na === undefined || nb === undefined) throw new ExpressionError(`"${n.op}" needs numbers, got "${asText(a)}" and "${asText(b)}"`, src);
          if ((n.op === '/' || n.op === '%') && nb === 0) throw new ExpressionError('division by zero', src);
          return n.op === '-' ? na - nb : n.op === '*' ? na * nb : n.op === '/' ? na / nb : na % nb;
        }
        case '==': return looseEquals(a, b);
        case '!=': return !looseEquals(a, b);
        case '<': return compareValues(a, b) < 0;
        case '<=': return compareValues(a, b) <= 0;
        case '>': return compareValues(a, b) > 0;
        case '>=': return compareValues(a, b) >= 0;
        case 'contains': return Array.isArray(a) ? a.some((x) => looseEquals(x, b)) : asText(a).includes(asText(b));
        case 'in': return Array.isArray(b) ? b.some((x) => looseEquals(x, a)) : asText(b).includes(asText(a));
        case 'startswith': return asText(a).startsWith(asText(b));
        case 'endswith': return asText(a).endsWith(asText(b));
        case 'matches': return new RegExp(asText(b)).test(asText(a));
      }
      throw new ExpressionError(`unknown operator ${n.op}`, src);
    }
  }
}

/** Evaluate an expression against variables. Throws ExpressionError on syntax or evaluation errors. */
export function evaluateExpression(src: string, vars: Record<string, unknown>): unknown {
  return evalNode(parseExpression(src), vars, src);
}

// ------------------------------------------------------------------ templates

export type TemplateSyntax = 'dollar' | 'mustache';

const SIMPLE_VAR = /^\s*([A-Za-z_][\w.]*)(?::-([^}]*))?\s*$/;

/** Index just past the closing delimiter of a placeholder body starting at `i`, honouring quotes; -1 if unterminated. */
function placeholderEnd(src: string, i: number, close: string): number {
  let quote = '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth <= 0 && src.startsWith(close, j)) return j;
  }
  return -1;
}

function renderOne(body: string, vars: Record<string, unknown>, whole: string): string {
  const simple = SIMPLE_VAR.exec(body);
  if (simple) {
    const r = lookup(vars, simple[1]);
    if (r.found && r.value !== undefined && r.value !== null) return typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value);
    if (simple[2] !== undefined) return simple[2];
    return whole;
  }
  try {
    return asText(evaluateExpression(body, vars));
  } catch (e) {
    // An unknown variable leaves the placeholder as written (like plain ${var}); other errors are real mistakes.
    if (e instanceof ExpressionError && /unknown variable/.test(e.message)) return whole;
    throw e;
  }
}

/**
 * Render a body template: `${var}` and `${expression}` (e.g. `${json(items)}`,
 * `${addBusinessDays(today(), 3)}`); with syntax "mustache" also `{{var}}` and
 * `{{expression}}` (mustache-style payload files; `{{jsonEncode(x)}}` works too).
 * `$${...}` is a literal `${...}`. Unknown variables are left as written.
 */
export function renderTemplate(src: string, vars: Record<string, unknown>, o: { syntax?: TemplateSyntax } = {}): string {
  const mustache = o.syntax === 'mustache';
  if (!src.includes('${') && !(mustache && src.includes('{{'))) return src;
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('$${', i)) {
      const end = placeholderEnd(src, i + 3, '}');
      if (end < 0) return out + src.slice(i);
      out += src.slice(i + 1, end + 1);
      i = end + 1;
      continue;
    }
    if (src.startsWith('${', i)) {
      const end = placeholderEnd(src, i + 2, '}');
      if (end < 0) return out + src.slice(i);
      out += renderOne(src.slice(i + 2, end), vars, src.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (mustache && src.startsWith('{{', i)) {
      const end = placeholderEnd(src, i + 2, '}}');
      if (end < 0) return out + src.slice(i);
      out += renderOne(src.slice(i + 2, end), vars, src.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** Check an expression's syntax; returns an error message or undefined. */
export function checkExpression(src: string): string | undefined {
  try {
    parseExpression(src);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
