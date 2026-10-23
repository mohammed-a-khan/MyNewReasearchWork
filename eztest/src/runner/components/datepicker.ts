/**
 * Date pickers: pick a date through the calendar popup (navigating months by
 * the calendar's own buttons, finding the day by its date attribute, its
 * localized accessible label or its number), fall back to typing the date in
 * the field's display format (placeholder, an explicit format, or the page
 * locale), and verify the field now holds that date.
 */
import type { Locator } from '../../browser/index.js';
import { ComponentError } from './engine.js';
import {
  describeDate, formatDate, formatFromPlaceholder, isoOf, localeFormat, normalizeFormat, parseLoose, parseWithFormat, sameDate, type YMD,
} from './dates.js';
import { detectAdapter } from './registry.js';
import type { ComponentReport, DateDialect } from './types.js';
import { DEFAULT_TIMEOUT, ms, poll, Scope, type OpOptions } from './util.js';

interface DateInfo {
  root: string;
  input: string | null;
  type: string;
  placeholder: string;
  sections: Array<{ tag: string; label: string; text: string }>;
  sectionsText: string;
  hiddenValue: string;
  value: string;
  toggle: string | null;
  readOnly: boolean;
  locale: string;
  open: boolean;
}

interface CalendarState {
  open: boolean;
  popup?: string;
  shown?: { year: number; month: number } | null;
  title?: string;
  prev?: string | null;
  next?: string | null;
  hits?: number;
  tag?: string;
}

export interface PickOptions extends OpOptions {
  /** Display format to type in (e.g. "dd.MM.yyyy"); implies typing. */
  format?: string;
  /** Type the date instead of using the calendar. */
  typing?: boolean;
  /** Use the calendar only (no typing fallback). */
  calendarOnly?: boolean;
  /** Page locale override (default: the lang of the page or widget). */
  locale?: string;
}

function displayFormat(d: DateDialect, info: DateInfo, opts: PickOptions): string {
  if (opts.format) return normalizeFormat(opts.format);
  if (info.sections.length) {
    // MUI section fields: placeholder texts per section ("MM", "DD", "YYYY" / "TT", "JJJJ") in order.
    const fmt = formatFromPlaceholder(info.sectionsText);
    if (fmt) return fmt;
  }
  return formatFromPlaceholder(info.placeholder) ?? (d.format ? normalizeFormat(d.format) : localeFormat(opts.locale ?? info.locale));
}

/** The date the field holds now, read with its display format (or a machine-format hidden value). */
function heldDate(info: DateInfo, fmt: string, locale: string): YMD | undefined {
  const tryParse = (v: string) => (v ? parseWithFormat(v, fmt, locale) ?? parseLoose(v) : undefined);
  if (info.sections.length) return tryParse(info.hiddenValue) ?? tryParse(info.sectionsText.replace(/\s+/g, ''));
  return tryParse(info.value) ?? tryParse(info.hiddenValue);
}

/** Pick a date in the date picker at `loc`. */
export async function pickDate(loc: Locator, date: YMD, opts: PickOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await Scope.of(loc, timeout);
  await scope.call('clearMarks');
  const adapter = await detectAdapter<DateDialect>('datepicker', scope.loc, opts.adapter);
  const d = adapter.dialect;
  let info = await scope.call<DateInfo>('dateInfo', { d });
  const locale = opts.locale ?? info.locale;
  const fmt = d.native ? 'yyyy-MM-dd' : displayFormat(d, info, opts);
  const notes: string[] = [];
  let how = '';

  const verify = async (): Promise<boolean> =>
    !!(await poll(async () => {
      info = await scope.call<DateInfo>('dateInfo', { d });
      return sameDate(heldDate(info, fmt, locale), date) ? true : undefined;
    }, Math.min(timeout, 3000)));

  const viaCalendar = async (): Promise<boolean> => {
    if (!d.day || d.native) return false;
    let cal = await scope.call<CalendarState>('calendar', { d, locale });
    if (!cal.open) {
      const opener = info.toggle ?? info.input;
      if (!opener) {
        notes.push('no calendar button');
        return false;
      }
      await scope.el(opener, 'calendar button').click({ timeout });
      cal = (await poll(async () => {
        const c = await scope.call<CalendarState>('calendar', { d, locale });
        return c.open ? c : undefined;
      }, timeout)) ?? cal;
      if (!cal.open) {
        notes.push('the calendar did not open');
        return false;
      }
    }
    const want = { y: date.y, m: date.m, d: date.d };
    for (let i = 0; i < 600; i++) {
      cal = await scope.call<CalendarState>('calendar', { d, locale, want });
      if (cal.tag) {
        await scope.el(cal.tag, 'day').click({ timeout });
        how = `calendar (${i} month step${i === 1 ? '' : 's'})`;
        return true;
      }
      if (!cal.shown) {
        notes.push(`cannot tell which month the calendar shows ("${cal.title ?? ''}")`);
        return false;
      }
      const diff = date.y * 12 + date.m - (cal.shown.year * 12 + cal.shown.month);
      if (diff === 0) {
        notes.push(`no day ${date.d} in the calendar`);
        return false;
      }
      const btn = diff > 0 ? cal.next : cal.prev;
      if (!btn) {
        notes.push(`no ${diff > 0 ? 'next' : 'previous'} month button`);
        return false;
      }
      const before = cal.shown;
      await scope.el(btn, 'month button').click({ timeout });
      const moved = await poll(async () => {
        const c = await scope.call<CalendarState>('calendar', { d, locale });
        return c.shown && (c.shown.year !== before.year || c.shown.month !== before.month) ? true : undefined;
      }, timeout, 40);
      if (!moved) {
        notes.push('the calendar did not change month');
        return false;
      }
    }
    notes.push('too many month steps');
    return false;
  };

  const viaTyping = async (): Promise<boolean> => {
    const text = formatDate(date, fmt, locale);
    if (info.sections.length) {
      // Section fields (MUI): focus the first section and type each part; the field moves on by itself.
      const parts: Record<string, string> = { d: String(date.d).padStart(2, '0'), m: String(date.m + 1).padStart(2, '0'), y: String(date.y) };
      const first = scope.el(info.sections[0].tag, 'date section');
      await first.click({ timeout });
      for (const s of info.sections) {
        const k = /day|tag|jour|d[ií]a/i.test(s.label) ? 'd' : /month|monat|mois|mes/i.test(s.label) ? 'm' : 'y';
        await first.page().keyboard.type(parts[k], { delay: 10 });
      }
      await first.page().keyboard.press('Tab');
    } else if (info.input) {
      const input = scope.el(info.input, 'date field');
      if (info.readOnly) {
        notes.push('the field is read-only');
        return false;
      }
      await input.fill(d.native ? isoOf(date) : text, { timeout });
      if (!d.native) await input.press('Tab', { timeout }).catch(() => undefined);
    } else {
      notes.push('no text field to type into');
      return false;
    }
    how = `typed "${d.native ? isoOf(date) : text}" (format ${fmt})`;
    return true;
  };

  const order = opts.calendarOnly ? [viaCalendar] : opts.typing || opts.format || d.typeFirst ? [viaTyping] : [viaCalendar, viaTyping];
  for (const attempt of order) {
    if ((await attempt()) && (await verify())) {
      return {
        kind: 'datepicker', adapter: d.id, library: adapter.id, op: 'pick', ms: ms(t0), value: isoOf(date),
        verified: `${adapter.label} holds ${describeDate(date)} (shows "${info.sections.length ? info.sectionsText : info.value}"; ${how})`,
        details: { format: fmt, locale, how },
      };
    }
    if (how) notes.push(`${how} but the field shows "${info.sections.length ? info.sectionsText : info.value}"`);
    how = '';
  }
  throw new ComponentError(`could not pick ${describeDate(date)} in the ${adapter.label}: ${notes.join('; ')}`, 'COMPONENT_VERIFY');
}

/** Expect the picker to hold a date. */
export async function expectDate(loc: Locator, date: YMD, opts: PickOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const scope = await Scope.of(loc, opts.timeoutMs);
  const adapter = await detectAdapter<DateDialect>('datepicker', scope.loc, opts.adapter);
  const d = adapter.dialect;
  let info = await scope.call<DateInfo>('dateInfo', { d });
  const fmt = d.native ? 'yyyy-MM-dd' : displayFormat(d, info, opts);
  const locale = opts.locale ?? info.locale;
  const ok = await poll(async () => {
    info = await scope.call<DateInfo>('dateInfo', { d });
    return sameDate(heldDate(info, fmt, locale), date) ? true : undefined;
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
  if (!ok) throw new ComponentError(`the ${adapter.label} shows "${info.sections.length ? info.sectionsText : info.value}", not ${describeDate(date)} (format ${fmt})`, 'COMPONENT_ASSERT');
  return { kind: 'datepicker', adapter: d.id, library: adapter.id, op: 'expect', ms: ms(t0), verified: `${adapter.label} holds ${describeDate(date)}` };
}
