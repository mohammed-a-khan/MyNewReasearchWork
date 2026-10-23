/**
 * `dates`: the same date functions as `.ez` expressions (core/expr), typed.
 * Business days use the configured holiday calendar and weekend (config
 * `dates`). Dates go in as `Date` or ISO strings; a date-only string
 * ("2026-03-01") stays date-only in results, an instant stays an instant.
 */
import { FUNCTIONS, formatDate, isoInZone } from '../core/expr.js';

export type DateInput = Date | string;

const call = <T>(name: string, ...args: unknown[]): T => FUNCTIONS[name.toLowerCase()](args) as T;

function toDate(v: DateInput): Date {
  if (v instanceof Date) return v;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`"${v}" is not a date`);
  return d;
}

const iso = (v: DateInput) => (v instanceof Date ? v.toISOString() : v);

export const dates = {
  /** Today as YYYY-MM-DD (in a time zone when given, e.g. "America/New_York"). */
  today: (tz?: string): string => call('today', ...(tz ? [tz] : [])),
  /** Now as an ISO instant (with the zone's offset when given). */
  now: (tz?: string): string => call('now', ...(tz ? [tz] : [])),
  addDays: (d: DateInput, n: number): string => call('addDays', iso(d), n),
  addMonths: (d: DateInput, n: number): string => call('addMonths', iso(d), n),
  addHours: (d: DateInput, n: number): string => call('addHours', iso(d), n),
  addMinutes: (d: DateInput, n: number): string => call('addMinutes', iso(d), n),
  /** Add n business days (negative goes back; 0 rolls a weekend/holiday forward). */
  addBusinessDays: (d: DateInput, n: number, holidays?: string[]): string => call('addBusinessDays', iso(d), n, ...(holidays ? [holidays] : [])),
  nextBusinessDay: (d: DateInput, holidays?: string[]): string => call('nextBusinessDay', iso(d), ...(holidays ? [holidays] : [])),
  previousBusinessDay: (d: DateInput, holidays?: string[]): string => call('previousBusinessDay', iso(d), ...(holidays ? [holidays] : [])),
  isBusinessDay: (d: DateInput, holidays?: string[]): boolean => call('isBusinessDay', iso(d), ...(holidays ? [holidays] : [])),
  /** Whole days from a to b. */
  daysBetween: (a: DateInput, b: DateInput): number => call('daysBetween', iso(a), iso(b)),
  /** Format with tokens YYYY YY MM M DD D HH mm ss SSS, optionally as wall-clock time in a zone. */
  format: (d: DateInput, pattern = 'YYYY-MM-DD', tz?: string): string => call('format', iso(d), pattern, ...(tz ? [tz] : [])),
  /** MM/DD/YYYY. */
  toUSDate: (d: DateInput, tz?: string): string => dates.format(d, 'MM/DD/YYYY', tz),
  /** ISO-8601 local time with offset in a zone, e.g. 2026-03-01T09:30:00.000-05:00. */
  inZone: (d: DateInput, tz: string): string => isoInZone(toDate(d), tz),
  /** First day of the month (YYYY-MM-DD). */
  startOfMonth: (d: DateInput = new Date()): string => formatDate(toDate(d), 'YYYY-MM-01'),
  /** Last day of the month (YYYY-MM-DD). */
  endOfMonth: (d: DateInput = new Date()): string => {
    const x = toDate(d);
    return formatDate(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)), 'YYYY-MM-DD');
  },
  /** Parse an ISO string (or pass a Date through). */
  parse: (d: DateInput): Date => toDate(d),

  // ------------------------------------------------------------------ Date objects (local time, like JavaScript Dates)
  /** A Date from a Date, an ISO string or epoch milliseconds (now when omitted). */
  toDate: (d?: DateInput | number): Date => (d === undefined ? new Date() : typeof d === 'number' ? new Date(d) : new Date(toDate(d).getTime())),
  /** Move a date by n units (negative goes back). "businessDays" skips weekends and configured holidays. */
  shift: (d: DateInput, n: number, unit: ShiftUnit): Date => shift(toDate(d), n, unit),
  /** Start of the day / week (Monday) / month / year, local time. */
  startOf: (d: DateInput, unit: 'day' | 'week' | 'month' | 'year'): Date => startOf(toDate(d), unit),
  /** End of the day / week / month / year, local time (23:59:59.999). */
  endOf: (d: DateInput, unit: 'day' | 'week' | 'month' | 'year'): Date => {
    const s0 = startOf(toDate(d), unit);
    const next = unit === 'day' ? shift(s0, 1, 'days') : unit === 'week' ? shift(s0, 7, 'days') : unit === 'month' ? shift(s0, 1, 'months') : shift(s0, 1, 'years');
    return new Date(next.getTime() - 1);
  },
  /** Whole units from a to b (b - a), truncated toward zero. */
  diff: (a: DateInput, b: DateInput, unit: 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years'): number => {
    const x = toDate(a);
    const y = toDate(b);
    if (unit === 'months' || unit === 'years') {
      const m = (y.getFullYear() - x.getFullYear()) * 12 + (y.getMonth() - x.getMonth()) - (y.getDate() < x.getDate() ? 1 : 0);
      return unit === 'months' ? m : Math.trunc(m / 12);
    }
    const ms = { milliseconds: 1, seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5 }[unit];
    return Math.trunc((y.getTime() - x.getTime()) / ms);
  },
  /** Negative when a is before b, 0 when equal, positive when after. */
  compare: (a: DateInput, b: DateInput): number => toDate(a).getTime() - toDate(b).getTime(),
  /** Same day / month / year (local time). */
  isSame: (a: DateInput, b: DateInput, unit: 'day' | 'week' | 'month' | 'year'): boolean => startOf(toDate(a), unit).getTime() === startOf(toDate(b), unit).getTime(),
  isWeekend: (d: DateInput): boolean => [0, 6].includes(toDate(d).getDay()),
  /** Business days from a to b (excluding a, including b), using the configured calendar. */
  businessDaysBetween: (a: DateInput, b: DateInput): number => {
    let n = 0;
    const end = startOf(toDate(b), 'day').getTime();
    for (let d = shift(startOf(toDate(a), 'day'), 1, 'days'); d.getTime() <= end; d = shift(d, 1, 'days')) if (isBusinessLocal(d)) n++;
    return n;
  },
  /**
   * Format with YYYY YY MMMM MMM MM M DD D HH H hh h mm m ss s SSS A a, in local
   * time or as wall-clock time in a time zone (MMM is the upper-case short month).
   */
  formatWith: (d: DateInput, pattern: string, tz?: string): string => formatWith(toDate(d), pattern, tz),
};

export type ShiftUnit = 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years' | 'businessDays';

function isBusinessLocal(d: Date): boolean {
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return call<boolean>('isBusinessDay', iso);
}

function shift(d: Date, n: number, unit: ShiftUnit): Date {
  const r = new Date(d.getTime());
  switch (unit) {
    case 'milliseconds': r.setMilliseconds(r.getMilliseconds() + n); break;
    case 'seconds': r.setSeconds(r.getSeconds() + n); break;
    case 'minutes': r.setMinutes(r.getMinutes() + n); break;
    case 'hours': r.setHours(r.getHours() + n); break;
    case 'days': r.setDate(r.getDate() + n); break;
    case 'weeks': r.setDate(r.getDate() + 7 * n); break;
    case 'months': r.setMonth(r.getMonth() + n); break;
    case 'years': r.setFullYear(r.getFullYear() + n); break;
    case 'businessDays': {
      const step = n < 0 ? -1 : 1;
      for (let left = Math.abs(n), guard = 0; left > 0; guard++) {
        if (guard > 36_600) throw new Error('shift: no business days found (check the weekend and holiday calendar)');
        r.setDate(r.getDate() + step);
        if (isBusinessLocal(r)) left--;
      }
      break;
    }
  }
  return r;
}

function startOf(d: Date, unit: 'day' | 'week' | 'month' | 'year'): Date {
  const r = new Date(d.getTime());
  r.setHours(0, 0, 0, 0);
  if (unit === 'week') r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  if (unit === 'month') r.setDate(1);
  if (unit === 'year') r.setMonth(0, 1);
  return r;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatWith(d: Date, pattern: string, tz?: string): string {
  let p: { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number };
  if (tz) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
    p = { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second), ms: d.getMilliseconds() };
  } else p = { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds() };
  const two = (n: number) => String(n).padStart(2, '0');
  const h12 = p.h % 12 || 12;
  const map: Record<string, string> = {
    YYYY: String(p.y), YY: String(p.y).slice(-2), MMMM: MONTHS[p.mo - 1], MMM: MONTHS[p.mo - 1].slice(0, 3).toUpperCase(), MM: two(p.mo), M: String(p.mo),
    DD: two(p.d), D: String(p.d), HH: two(p.h), H: String(p.h), hh: two(h12), h: String(h12), mm: two(p.mi), m: String(p.mi),
    ss: two(p.s), s: String(p.s), SSS: String(p.ms).padStart(3, '0'), A: p.h >= 12 ? 'PM' : 'AM', a: p.h >= 12 ? 'pm' : 'am',
  };
  return pattern.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|A|a/g, (t) => map[t]);
}

export type Dates = typeof dates;
