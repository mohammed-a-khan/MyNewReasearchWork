/**
 * Locale-aware numbers, amounts and dates. UI text is parsed with the
 * separators, digits and date order of a locale (de-DE "1.234,50 EUR",
 * fr-FR "1 234,50" with narrow no-break spaces, ar-EG with Arabic-Indic
 * digits, en-IN "12,34,567.00", de-CH "1'234.50"), so assertions compare
 * values, not formatting. Bidirectional control marks used in right-to-left
 * text are ignored.
 */

/** Characters from code points (keeps this source file ASCII). */
const cp = (...codes: number[]) => String.fromCharCode(...codes);
const range = (from: number, to: number) => cp(...Array.from({ length: to - from + 1 }, (_, i) => from + i));

/** LRM, RLM, ALM, embeddings/overrides and isolates. */
const BIDI = new RegExp(`[${cp(0x200e, 0x200f, 0x061c)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`, 'g');
/** Space-like characters used as group separators (NBSP, narrow NBSP, figure space, thin space). */
const SPACE_CHARS = ` ${cp(0x00a0, 0x202f, 0x2007, 0x2009)}`;
const ARABIC_DECIMAL = cp(0x066b);
const ARABIC_GROUP = cp(0x066c);
const RIGHT_QUOTE = cp(0x2019);
const MINUS_SIGNS = `-${cp(0x2212, 0x2012, 0x2013)}`;
/** First code point of each run of native decimal digits (Arabic-Indic, Persian, Devanagari, Bengali, Thai, full-width). */
const DIGIT_BASES = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50, 0xff10];
const NATIVE_DIGITS = new RegExp(`[${DIGIT_BASES.map((b) => range(b, b + 9)).join('')}]`, 'g');

/** Native digits to ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(NATIVE_DIGITS, (ch) => {
    const c = ch.charCodeAt(0);
    for (const base of DIGIT_BASES) if (c >= base && c <= base + 9) return String(c - base);
    return ch;
  });
}

/** Remove bidi control marks (common in RTL UIs and in Intl output for RTL locales). */
export function stripBidi(s: string): string {
  return s.replace(BIDI, '');
}

function separators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(-1234567.891);
  return {
    group: stripBidi(parts.find((p) => p.type === 'group')?.value ?? ','),
    decimal: stripBidi(parts.find((p) => p.type === 'decimal')?.value ?? '.'),
  };
}

const escapeClass = (c: string) => c.replace(/[\\\]^-]/g, (x) => `\\${x}`);

/** Parse a number as written in `locale`. Returns undefined when the text holds no number. */
export function parseLocaleNumber(text: string, locale = 'en-US'): number | undefined {
  const { group, decimal } = separators(locale);
  let s = asciiDigits(stripBidi(String(text)));
  const minus = `[${escapeClass(MINUS_SIGNS)}]`;
  const negative = /^\s*\(.*\)\s*$/.test(s) || new RegExp(`${minus}\\s*\\d`).test(s) || new RegExp(`\\d\\s*${minus}\\s*$`).test(s);
  // Group separators that are spaces in the locale (fr, ru, sv...) may come as any space.
  const groupIsSpace = SPACE_CHARS.includes(group) || /^\s$/.test(group);
  const seps = new Set(['.', ',', "'", RIGHT_QUOTE, decimal, ARABIC_DECIMAL, ARABIC_GROUP, ...(groupIsSpace ? [] : [group])]);
  s = [...s].map((ch) => (/\d/.test(ch) || seps.has(ch) ? ch : ' ')).join('').trim();
  if (groupIsSpace) s = s.replace(/(\d) (?=\d{3}(?:\D|$))/g, '$1');
  const m = new RegExp(`\\d[\\d${[...seps].map(escapeClass).join('')}]*`).exec(s);
  if (!m) return undefined;
  let num = m[0].replace(new RegExp(`[${[...seps].map(escapeClass).join('')}]+$`), '');
  if (decimal === ARABIC_DECIMAL) num = num.split(ARABIC_GROUP).join('').split(ARABIC_DECIMAL).join('.');
  else {
    if (group && !groupIsSpace) num = num.split(group).join('');
    num = num.split("'").join('').split(RIGHT_QUOTE).join(''); // Swiss grouping
    if (decimal !== '.') num = num.split(decimal).join('.');
  }
  num = num.replace(/\.(?=.*\.)/g, ''); // stray separators: keep the last decimal point
  const v = Number(num);
  if (!Number.isFinite(v)) return undefined;
  return negative ? -v : v;
}


/** The currency symbols and codes a locale may print for `currency`. */
export function currencyMarks(currency: string, locale = 'en-US'): string[] {
  const out = new Set<string>([currency.toUpperCase()]);
  for (const display of ['symbol', 'narrowSymbol', 'code'] as const) {
    try {
      const p = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: display }).formatToParts(1).find((x) => x.type === 'currency');
      if (p) out.add(stripBidi(p.value).trim());
    } catch {
      /* unknown currency */
    }
  }
  return [...out].filter(Boolean);
}

export function formatLocaleNumber(v: number, locale = 'en-US', digits?: number): string {
  return new Intl.NumberFormat(locale, digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

export function formatCurrency(v: number, currency: string, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(v);
}

function monthNames(locale: string): Array<{ name: string; month: number }> {
  const out: Array<{ name: string; month: number }> = [];
  for (const style of ['long', 'short'] as const) {
    const f = new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' });
    for (let m = 0; m < 12; m++) out.push({ name: stripBidi(f.format(new Date(Date.UTC(2021, m, 15)))).toLowerCase().replace(/\.$/, ''), month: m + 1 });
  }
  return out.sort((a, b) => b.name.length - a.name.length);
}

/** Order of day, month and year in the locale's numeric short date. */
function dateOrder(locale: string): Array<'day' | 'month' | 'year'> {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
    .formatToParts(new Date(Date.UTC(2033, 10, 22)))
    .filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year')
    .map((p) => p.type as 'day' | 'month' | 'year');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Parse a date as written in `locale` (numeric or with month names) into YYYY-MM-DD. */
export function parseLocaleDate(text: string, locale = 'en-US'): string | undefined {
  let s = asciiDigits(stripBidi(String(text))).toLowerCase().trim();
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  let month: number | undefined;
  for (const m of monthNames(locale)) {
    if (m.name && s.includes(m.name)) {
      month = m.month;
      s = s.replace(m.name, ' ');
      break;
    }
  }
  const nums = (s.match(/\d+/g) ?? []).map(Number);
  let day: number | undefined;
  let year: number | undefined;
  if (month !== undefined) {
    if (nums.length < 2) return undefined;
    const y = nums.find((n) => n > 31) ?? nums[nums.length - 1];
    year = y;
    day = nums.find((n) => n !== y && n >= 1 && n <= 31);
  } else {
    if (nums.length < 3) return undefined;
    const order = dateOrder(locale);
    const byPart: Record<string, number> = {};
    order.forEach((p, i) => { byPart[p] = nums[i]; });
    ({ day, month, year } = byPart as { day: number; month: number; year: number });
  }
  if (day === undefined || month === undefined || year === undefined) return undefined;
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function formatLocaleDate(isoDate: string, locale = 'en-US', style: 'short' | 'medium' | 'long' = 'medium'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(isoDate);
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: 'UTC' }).format(d);
}

/** Is a locale written right-to-left? */
export function isRtlLocale(locale: string): boolean {
  return /^(ar|he|iw|fa|ur|ps|yi|dv|ku-arab|sd|ug)(?:-|$)/i.test(locale);
}
