/**
 * Dates for picker steps: parsing what the author wrote ("15 March 2027",
 * "2027-03-15", "March 15, 2027", "today + 3 days"), working out the display
 * format a picker uses (placeholder, explicit format, or the page locale) and
 * formatting/parsing values in that format. Month names come from ICU via
 * Intl, so any locale the browser and Node know works.
 */
import { ComponentError } from './engine.js';

export interface YMD {
  y: number;
  /** 0-based month. */
  m: number;
  d: number;
}

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthIndex(word: string, locale = 'en-US'): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  for (let i = 0; i < 12; i++) {
    const names = [EN_MONTHS[i], EN_MONTHS[i].slice(0, 3), ...monthNames(locale, i)];
    if (names.some((n) => n === w)) return i;
  }
  for (let i = 0; i < 12; i++) if (w.length >= 3 && EN_MONTHS[i].startsWith(w)) return i;
  return -1;
}

function monthNames(locale: string, m: number): string[] {
  const dt = new Date(Date.UTC(2021, m, 15));
  const out: string[] = [];
  for (const month of ['long', 'short'] as const) {
    try {
      out.push(new Intl.DateTimeFormat(locale, { month, timeZone: 'UTC' }).format(dt).toLowerCase().replace(/\.$/, ''));
    } catch {
      // unknown locale: English names only
    }
  }
  return out;
}

function valid(y: number, m: number, d: number): YMD {
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) throw new ComponentError(`${y}-${m + 1}-${d} is not a valid date`, 'COMPONENT_BAD_DATE');
  return { y, m, d };
}

/** Parse the date an author wrote. `now` is injectable for tests. */
export function parseDateText(text: string, now = new Date()): YMD {
  const s = text.trim().replace(/^the\s+/i, '');
  let m: RegExpExecArray | null;
  const rel = /^(today|tomorrow|yesterday)(?:\s*([+-])\s*(\d+)\s*(days?|weeks?|months?|years?))?$/i.exec(s) ?? /^in\s+(\d+)\s+(days?|weeks?|months?|years?)$/i.exec(s);
  if (rel) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let sign = 1;
    let n = 0;
    let unit = 'day';
    if (/^in\s/i.test(s)) {
      n = Number(rel[1]);
      unit = rel[2];
    } else {
      base.setDate(base.getDate() + (/tomorrow/i.test(rel[1]) ? 1 : /yesterday/i.test(rel[1]) ? -1 : 0));
      if (rel[2]) {
        sign = rel[2] === '-' ? -1 : 1;
        n = Number(rel[3]);
        unit = rel[4];
      }
    }
    if (/^day/i.test(unit)) base.setDate(base.getDate() + sign * n);
    else if (/^week/i.test(unit)) base.setDate(base.getDate() + sign * n * 7);
    else if (/^month/i.test(unit)) base.setMonth(base.getMonth() + sign * n);
    else base.setFullYear(base.getFullYear() + sign * n);
    return { y: base.getFullYear(), m: base.getMonth(), d: base.getDate() };
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) return valid(+m[1], +m[2] - 1, +m[3]);
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) return valid(+m[1], +m[2] - 1, +m[3]);
  if ((m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/.exec(s))) return valid(+m[3], +m[2] - 1, +m[1]);
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+(?:of\s+)?([\p{L}.]+)\s*,?\s+(\d{4})$/u.exec(s))) {
    const mi = monthIndex(m[2]);
    if (mi >= 0) return valid(+m[3], mi, +m[1]);
  }
  if ((m = /^([\p{L}.]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{4})$/u.exec(s))) {
    const mi = monthIndex(m[1]);
    if (mi >= 0) return valid(+m[3], mi, +m[2]);
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    // Slashes are ambiguous; only accept them when one side cannot be a month.
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) return valid(+m[3], b - 1, a);
    if (b > 12 && a <= 12) return valid(+m[3], a - 1, b);
    throw new ComponentError(`"${text}" is ambiguous (day/month or month/day?); write it as 2027-03-15 or 15 March 2027`, 'COMPONENT_BAD_DATE');
  }
  throw new ComponentError(`cannot read "${text}" as a date (use 2027-03-15, 15 March 2027 or March 15, 2027)`, 'COMPONENT_BAD_DATE');
}

export function isoOf(d: YMD): string {
  return `${String(d.y).padStart(4, '0')}-${String(d.m + 1).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
}

export function sameDate(a: YMD | undefined, b: YMD): boolean {
  return !!a && a.y === b.y && a.m === b.m && a.d === b.d;
}

/**
 * Normalise a display format to tokens d dd M MM MMM MMMM yy yyyy.
 * Accepts moment/dayjs (DD/MM/YYYY), ICU (dd.MM.y), lower-case (mm/dd/yyyy)
 * and German MUI placeholders (TT.MM.JJJJ).
 */
export function normalizeFormat(fmt: string): string {
  let f = fmt.trim();
  f = f.replace(/T/g, 'D').replace(/J/g, 'Y'); // German placeholders
  f = f.replace(/A/g, 'Y'); // Spanish/French AAAA
  if (/^[^Mm]*m{1,2}[^Mm]*$/.test(f) && /[dD]/.test(f) && /[yY]/.test(f)) f = f.replace(/m/g, 'M'); // mm/dd/yyyy
  f = f.replace(/D/g, 'd').replace(/Y/g, 'y');
  f = f.replace(/(^|[^y])y(?!y)/g, '$1yyyy'); // ICU "y" = full year
  return f;
}

/** A display format from an input placeholder, when it is one ("MM/DD/YYYY", "dd.mm.yyyy", "MMM d, y"). */
export function formatFromPlaceholder(placeholder: string): string | undefined {
  const p = placeholder.trim();
  if (!p || !/^[dDmMyYTJA.,/\-\s]+$/.test(p) || !/[dDT]/.test(p) || !/[mM]/.test(p) || !/[yYJA]/.test(p)) return undefined;
  return normalizeFormat(p);
}

/** The short numeric date format of a locale, e.g. en-US "MM/dd/yyyy", de-DE "dd.MM.yyyy". */
export function localeFormat(locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2027, 2, 15));
    return parts.map((p) => (p.type === 'year' ? 'yyyy' : p.type === 'month' ? 'MM' : p.type === 'day' ? 'dd' : p.value)).join('');
  } catch {
    return 'MM/dd/yyyy';
  }
}

const TOKENS = /yyyy|yy|MMMM|MMM|MM|M|dd|d/g;

export function formatDate(d: YMD, format: string, locale = 'en-US'): string {
  const dt = new Date(Date.UTC(d.y, d.m, d.d));
  const name = (month: 'long' | 'short') => new Intl.DateTimeFormat(locale, { month, timeZone: 'UTC' }).format(dt);
  return normalizeFormat(format).replace(TOKENS, (t) => {
    switch (t) {
      case 'yyyy': return String(d.y).padStart(4, '0');
      case 'yy': return String(d.y % 100).padStart(2, '0');
      case 'MMMM': return name('long');
      case 'MMM': return name('short');
      case 'MM': return String(d.m + 1).padStart(2, '0');
      case 'M': return String(d.m + 1);
      case 'dd': return String(d.d).padStart(2, '0');
      default: return String(d.d);
    }
  });
}

/** Parse a displayed value with a format; undefined when it does not fit. */
export function parseWithFormat(value: string, format: string, locale = 'en-US'): YMD | undefined {
  const f = normalizeFormat(format);
  const order: string[] = [];
  const re = new RegExp(
    '^' +
      f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(TOKENS, (t) => {
        order.push(t);
        return t.startsWith('MMM') ? '([\\p{L}.]+)' : t === 'yyyy' ? '(\\d{4})' : '(\\d{1,2})';
      }).replace(/\s+/g, '\\s*') +
      '$',
    'u',
  );
  const m = re.exec(value.trim());
  if (!m) return undefined;
  let y = NaN;
  let mo = NaN;
  let d = NaN;
  order.forEach((t, i) => {
    const v = m[i + 1];
    if (t === 'yyyy') y = +v;
    else if (t === 'yy') y = 2000 + +v;
    else if (t.startsWith('MMM')) mo = monthIndex(v, locale);
    else if (t.startsWith('M')) mo = +v - 1;
    else d = +v;
  });
  if (!(y > 0 && mo >= 0 && mo < 12 && d >= 1 && d <= 31)) return undefined;
  return { y, m: mo, d };
}

/** Parse a value in any of the usual machine formats (hidden inputs: ISO, yyyy/MM/dd). */
export function parseLoose(value: string): YMD | undefined {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value.trim());
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : undefined;
}

export function describeDate(d: YMD): string {
  return `${d.d} ${EN_MONTHS[d.m][0].toUpperCase()}${EN_MONTHS[d.m].slice(1)} ${d.y}`;
}
