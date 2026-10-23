/**
 * Value normalizer. Turns printed values ("$ (1,234.50)", "1.234,50 €",
 * "12.5 %", "15 Jan 2024", "n/a") into comparable canonical values.
 *
 * Safety rules:
 *  - a date is never parsed as a number and a number never as a date;
 *  - thousands grouping is validated (groups of three), so "15.01.2024" is not 15012024;
 *  - ambiguous dates such as 01/02/2024 are NOT guessed unless an explicit format is given.
 */
import type { NormalizedValue, ValueType } from './model.js';

export type NumberLocale = 'en' | 'de' | 'fr' | 'auto';

export interface NormalizeOptions {
  /** Decimal/thousands convention. en: 1,234.50  de: 1.234,50  fr: 1 234,50  auto: inferred (ambiguous "1.234" reads as en). */
  locale?: NumberLocale;
  /** Expected type; when omitted the value is auto-detected (date, then number, then text). */
  type?: ValueType;
  /** Explicit date formats tried first, e.g. ["DD/MM/YYYY", "MMM D, YYYY"]. Tokens: YYYY YY MMMM MMM MM M DD D. */
  dateFormats?: string[];
  /** Tokens treated as "no value". Default: "", n/a, na, null, none, nil, -, –, —. */
  nullTokens?: string[];
  /** Lower-case text values (default true). */
  caseFold?: boolean;
}

export const DEFAULT_NULL_TOKENS = ['', 'n/a', 'na', 'null', 'none', 'nil', '-', '–', '—', '--'];

/** Unicode NFKC, all whitespace runs collapsed to one space, trimmed, optionally lower-cased. */
export function foldText(s: string, opts: { caseFold?: boolean } = {}): string {
  const t = s.normalize('NFKC').replace(/[\s   ​]+/g, ' ').trim();
  return opts.caseFold === false ? t : t.toLowerCase();
}

// ----------------------------------------------------------------- numbers

const CURRENCY_SYMBOLS: Array<[string, string]> = [
  ['R$', 'BRL'],
  ['US$', 'USD'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['₩', 'KRW'],
  ['₽', 'RUB'],
  ['₺', 'TRY'],
  ['₪', 'ILS'],
  ['₫', 'VND'],
  ['zł', 'PLN'],
  ['kr', 'SEK'],
];
const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'INR', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK',
  'HUF', 'BRL', 'MXN', 'ZAR', 'SGD', 'HKD', 'KRW', 'RUB', 'TRY', 'ILS', 'AED', 'SAR', 'RON', 'BGN',
]);

export interface ParsedNumber {
  value: number;
  currency?: string;
  percent?: boolean;
}

/**
 * Parse a printed number. Handles currency symbols/codes, accounting negatives
 * "(1,234.50)", trailing minus "1,234.50-", leading +/-/U+2212, percent signs and
 * en/de/fr grouping. Returns undefined when the string is not a number.
 */
export function parseNumber(raw: string, locale: NumberLocale = 'auto'): ParsedNumber | undefined {
  let s = raw.normalize('NFKC').replace(/[   ]/g, ' ').replace(/−/g, '-').trim();
  if (!s) return undefined;
  let neg = false;
  let currency: string | undefined;
  let percent = false;
  // Peel decorations from both ends until nothing changes.
  for (let guard = 0; guard < 8; guard++) {
    const before = s;
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) {
      if (neg) return undefined;
      neg = true;
      s = paren[1].trim();
    }
    if (/^[-+]/.test(s)) {
      if (s[0] === '-') {
        if (neg) return undefined;
        neg = true;
      }
      s = s.slice(1).trim();
    }
    if (/\d-$/.test(s) || /\d\s+-$/.test(s)) {
      if (neg) return undefined;
      neg = true;
      s = s.slice(0, -1).trim();
    }
    if (s.endsWith('%')) {
      if (percent) return undefined;
      percent = true;
      s = s.slice(0, -1).trim();
    }
    const code = /^([A-Z]{3})\s*(?=[-+(\d.,])/.exec(s) ?? /(?<=[\d)])\s*([A-Z]{3})$/.exec(s);
    if (code && CURRENCY_CODES.has(code[1])) {
      if (currency && currency !== code[1]) return undefined;
      currency = code[1];
      s = (s.startsWith(code[1]) ? s.slice(code[1].length) : s.slice(0, s.length - code[0].length)).trim();
    }
    for (const [sym, iso] of CURRENCY_SYMBOLS) {
      if (s.startsWith(sym) && /^\s*[-+(\d.,]/.test(s.slice(sym.length))) {
        if (currency && currency !== iso) return undefined;
        currency = iso;
        s = s.slice(sym.length).trim();
        break;
      }
      if (s.endsWith(sym) && /[\d)]\s*$/.test(s.slice(0, -sym.length))) {
        if (currency && currency !== iso) return undefined;
        currency = iso;
        s = s.slice(0, -sym.length).trim();
        break;
      }
    }
    if (s === before) break;
  }
  const n = parseBareNumber(s, locale);
  if (n === undefined) return undefined;
  const value = neg && n !== 0 ? -n : n;
  const out: ParsedNumber = { value };
  if (currency) out.currency = currency;
  if (percent) out.percent = true;
  return out;
}

function parseBareNumber(s: string, locale: NumberLocale): number | undefined {
  if (!/^[0-9.,' ]+$/.test(s) || !/\d/.test(s)) return undefined;
  if (!/\d$/.test(s)) return undefined;
  const candidates: Array<{ dec: string; thou: string[] }> = [];
  if (locale === 'en') candidates.push({ dec: '.', thou: [',', "'", ' '] });
  else if (locale === 'de') candidates.push({ dec: ',', thou: ['.', ' ', "'"] });
  else if (locale === 'fr') candidates.push({ dec: ',', thou: [' ', '.'] });
  else {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      candidates.push(lastDot > lastComma ? { dec: '.', thou: [',', "'", ' '] } : { dec: ',', thou: ['.', ' ', "'"] });
    } else if (lastComma >= 0) {
      const single = s.indexOf(',') === lastComma;
      const after = s.length - lastComma - 1;
      if (single && after !== 3) candidates.push({ dec: ',', thou: ['.', ' ', "'"] });
      else candidates.push({ dec: '.', thou: [',', "'", ' '] });
    } else if (lastDot >= 0) {
      const single = s.indexOf('.') === lastDot;
      if (single) candidates.push({ dec: '.', thou: [',', "'", ' '] });
      else candidates.push({ dec: ',', thou: ['.', ' ', "'"] });
    } else {
      candidates.push({ dec: '.', thou: [',', "'", ' '] });
    }
  }
  for (const c of candidates) {
    const v = parseWith(s, c.dec, c.thou);
    if (v !== undefined) return v;
  }
  return undefined;
}

function parseWith(s: string, dec: string, thou: string[]): number | undefined {
  const parts = s.split(dec);
  if (parts.length > 2) return undefined;
  const intPart = parts[0];
  const frac = parts.length === 2 ? parts[1] : '';
  if (parts.length === 2 && !/^\d+$/.test(frac)) return undefined;
  let digits: string;
  if (intPart === '') {
    if (!frac) return undefined;
    digits = '0';
  } else if (/^\d+$/.test(intPart)) {
    digits = intPart;
  } else {
    const seps = new Set(intPart.replace(/\d/g, ''));
    if (seps.size !== 1) return undefined;
    const sep = [...seps][0];
    if (!thou.includes(sep)) return undefined;
    const groups = intPart.split(sep);
    if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return undefined;
    digits = groups.join('');
  }
  const v = Number(frac ? `${digits}.${frac}` : digits);
  return Number.isFinite(v) ? v : undefined;
}

// ----------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {};
(
  [
    ['january', 'jan', 'januar', 'janvier', 'janv'],
    ['february', 'feb', 'februar', 'février', 'févr', 'fev'],
    ['march', 'mar', 'märz', 'mär', 'mars'],
    ['april', 'apr', 'avril', 'avr'],
    ['may', 'mai'],
    ['june', 'jun', 'juni', 'juin'],
    ['july', 'jul', 'juli', 'juillet', 'juil'],
    ['august', 'aug', 'août', 'aout'],
    ['september', 'sep', 'sept', 'septembre'],
    ['october', 'oct', 'oktober', 'okt', 'octobre'],
    ['november', 'nov', 'novembre'],
    ['december', 'dec', 'dezember', 'dez', 'décembre', 'déc'],
  ] as const
).forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)));

function monthFromName(s: string): number | undefined {
  return MONTHS[s.toLowerCase().replace(/\.$/, '')];
}

function isoDate(y: number, m: number, d: number): string | undefined {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
  if (m < 1 || m > 12 || d < 1 || y < 1 || y > 9999) return undefined;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function expandYear(yy: number): number {
  return yy < 70 ? 2000 + yy : 1900 + yy;
}

const TOKEN_RE = /YYYY|YY|MMMM|MMM|MM|M|DD|D/g;

/** Parse a date with one explicit format, e.g. "DD.MM.YYYY" or "MMM D, YYYY". Returns ISO YYYY-MM-DD. */
export function parseDateWithFormat(raw: string, format: string): string | undefined {
  const order: string[] = [];
  let pattern = '';
  let last = 0;
  for (const m of format.matchAll(TOKEN_RE)) {
    pattern += escapeRe(format.slice(last, m.index));
    const tok = m[0];
    order.push(tok);
    pattern +=
      tok === 'YYYY' ? '(\\d{4})' :
      tok === 'YY' ? '(\\d{2})' :
      tok === 'MMMM' || tok === 'MMM' ? '([A-Za-zÀ-ÿ]+\\.?)' :
      tok === 'MM' || tok === 'DD' ? '(\\d{2})' : '(\\d{1,2})';
    last = (m.index ?? 0) + tok.length;
  }
  pattern += escapeRe(format.slice(last));
  const re = new RegExp(`^${pattern.replace(/ /g, '\\s+')}$`, 'i');
  const m = re.exec(foldText(raw, { caseFold: false }));
  if (!m) return undefined;
  let y: number | undefined;
  let mo: number | undefined;
  let d: number | undefined;
  order.forEach((tok, i) => {
    const v = m[i + 1];
    if (tok === 'YYYY') y = Number(v);
    else if (tok === 'YY') y = expandYear(Number(v));
    else if (tok === 'MMMM' || tok === 'MMM') mo = monthFromName(v);
    else if (tok === 'MM' || tok === 'M') mo = Number(v);
    else d = Number(v);
  });
  if (y === undefined || mo === undefined || d === undefined) return undefined;
  return isoDate(y, mo, d);
}

export interface DateParse {
  iso?: string;
  ambiguous?: boolean;
}

/**
 * Safe date auto-detection. Recognises ISO (2024-01-15, optional time), YYYY/MM/DD,
 * DD.MM.YYYY, month-name forms ("15 Jan 2024", "Jan 15, 2024") and slash/dash
 * numeric dates only when the day/month order is unambiguous (one part > 12).
 */
export function parseDate(raw: string, formats: string[] = []): DateParse {
  const s = foldText(raw, { caseFold: false });
  for (const f of formats) {
    const iso = parseDateWithFormat(s, f);
    if (iso) return { iso };
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) return { iso: isoDate(+m[1], +m[2], +m[3]) };
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return { iso: isoDate(+m[1], +m[2], +m[3]) };
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return { iso: isoDate(+m[3], +m[2], +m[1]) };
  m = /^(\d{1,2})\.?\s+([A-Za-zÀ-ÿ]+\.?),?\s+(\d{4})$/.exec(s);
  if (m && monthFromName(m[2])) return { iso: isoDate(+m[3], monthFromName(m[2])!, +m[1]) };
  m = /^([A-Za-zÀ-ÿ]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && monthFromName(m[1])) return { iso: isoDate(+m[3], monthFromName(m[1])!, +m[2]) };
  m = /^(\d{1,2})[/-]([A-Za-z]{3,})[/-](\d{4})$/.exec(s);
  if (m && monthFromName(m[2])) return { iso: isoDate(+m[3], monthFromName(m[2])!, +m[1]) };
  m = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[3];
    const y = m[4].length === 2 ? expandYear(+m[4]) : +m[4];
    if (a > 12 && b <= 12) return { iso: isoDate(y, b, a) };
    if (b > 12 && a <= 12) return { iso: isoDate(y, a, b) };
    if (a === b) return { iso: isoDate(y, a, b) };
    return { ambiguous: true };
  }
  return {};
}

// ----------------------------------------------------------------- values

/** Normalize any raw value (string from a document, number/boolean/null from a DB or JSON). */
export function normalizeValue(raw: unknown, opts: NormalizeOptions = {}): NormalizedValue {
  if (raw === null || raw === undefined) return { kind: 'null', value: null };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { kind: 'text', value: String(raw).toLowerCase() };
    return { kind: 'number', value: raw };
  }
  if (typeof raw === 'bigint') return { kind: 'number', value: Number(raw) };
  if (typeof raw === 'boolean') return { kind: 'text', value: String(raw) };
  if (raw instanceof Date) {
    const iso = Number.isNaN(raw.getTime()) ? undefined : raw.toISOString().slice(0, 10);
    return iso ? { kind: 'date', value: iso } : { kind: 'null', value: null };
  }
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const folded = foldText(s);
  const nullTokens = opts.nullTokens ?? DEFAULT_NULL_TOKENS;
  if (nullTokens.some((t) => foldText(t) === folded)) return { kind: 'null', value: null };
  const text = (): NormalizedValue => ({ kind: 'text', value: opts.caseFold === false ? foldText(s, { caseFold: false }) : folded });
  const type = opts.type;
  if (type === 'text') return text();
  if (type === 'date' || type === undefined) {
    const d = parseDate(s, opts.dateFormats);
    if (d.iso) return { kind: 'date', value: d.iso };
    if (d.ambiguous) return { ...text(), ambiguousDate: true };
    if (type === 'date') return text();
  }
  const n = parseNumber(s, opts.locale ?? 'auto');
  if (n) {
    const out: NormalizedValue = { kind: 'number', value: n.value };
    if (n.currency) out.currency = n.currency;
    if (n.percent) out.percent = true;
    return out;
  }
  return text();
}

/** True when two normalized values denote the same thing. A date never equals a number. */
export function valuesEqual(a: NormalizedValue, b: NormalizedValue, epsilon = 1e-9): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'null') return true;
  if (a.currency && b.currency && a.currency !== b.currency) return false;
  if (!!a.percent !== !!b.percent && a.kind === 'number') return false;
  if (a.kind === 'number') return Math.abs((a.value as number) - (b.value as number)) <= epsilon;
  return a.value === b.value;
}

/** Display string for a normalized value (deterministic). */
export function formatNormalized(v: NormalizedValue): string {
  if (v.kind === 'null') return '∅';
  if (v.kind === 'number') {
    const n = Number((v.value as number).toFixed(10));
    return `${v.currency ? v.currency + ' ' : ''}${n}${v.percent ? '%' : ''}`;
  }
  return String(v.value);
}

/** Levenshtein-based similarity 0..1 of two strings (after folding). */
export function similarity(a: string, b: string): number {
  const x = foldText(a);
  const y = foldText(b);
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  const prev = new Array<number>(y.length + 1);
  const cur = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= y.length; j++) prev[j] = cur[j];
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
