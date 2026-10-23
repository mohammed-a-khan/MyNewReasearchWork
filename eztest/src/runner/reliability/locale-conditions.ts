/**
 * Locale-aware assertions:
 *  - localeValue: an element's text parsed as a number, an amount or a date in
 *    a locale ("1.234,50 EUR" in de-DE is 1234.5) equals the expected value;
 *  - direction: the page (or an element) is laid out right-to-left / left-to-right.
 */
import { currencyMarks, getDefaultLocale, parseLocaleDate, parseLocaleNumber, stripBidi, type Condition, type ConditionResult } from '../../core/index.js';
import type { ConditionEnv } from '../conditions.js';
import { strictLocator } from '../conditions-advanced.js';

type LocaleCondition = Extract<Condition, { type: 'localeValue' | 'direction' }>;

const fail = (condition: Condition, message: string, actual?: string): ConditionResult => ({ condition, passed: false, message, ...(actual !== undefined ? { actual } : {}) });
const ok = (condition: Condition, actual?: string): ConditionResult => ({ condition, passed: true, ...(actual !== undefined ? { actual } : {}) });

/** The locale in force: the condition's, else the browser page's (journey Locale: / config locale), else the default. */
async function localeOf(c: { locale?: string }, env: ConditionEnv): Promise<string> {
  if (c.locale) return env.interpolate(c.locale);
  const nav = await env.page.evaluate(() => navigator.language).catch(() => undefined);
  return nav || getDefaultLocale();
}

export async function evaluateLocaleCondition(c: LocaleCondition, env: ConditionEnv): Promise<ConditionResult> {
  if (c.type === 'direction') {
    let dir: string;
    if (c.of) {
      const r = await strictLocator(env, c.of);
      if (!r.locator) return fail(c, `${c.of.description}: not found exactly once (${r.notes.join('; ')})`);
      dir = await r.locator.evaluate((el) => getComputedStyle(el).direction, undefined, { timeout: 2000 });
    } else {
      dir = await env.page.evaluate(() => getComputedStyle(document.body ?? document.documentElement).direction);
    }
    return dir === c.dir ? ok(c, dir) : fail(c, `${c.of?.description ?? 'the page'} is laid out ${dir}, expected ${c.dir}`, dir);
  }
  const r = await strictLocator(env, c.target);
  if (!r.locator) return fail(c, `${c.target.description}: not found exactly once (${r.notes.join('; ')})`);
  const raw = await r.locator.evaluate((el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el as HTMLElement).innerText ?? el.textContent ?? ''), undefined, { timeout: 2000 });
  const text = stripBidi(raw).replace(/\s+/g, ' ').trim();
  const locale = await localeOf(c, env);
  const want = env.interpolate(c.value);
  if (c.kind === 'date') {
    const got = parseLocaleDate(text, locale);
    const exp = parseLocaleDate(want, 'en-US') ?? want;
    if (!got) return fail(c, `${c.target.description} shows "${text}", which is not a date in ${locale}`, text);
    return got === exp ? ok(c, `${text} (${got})`) : fail(c, `${c.target.description} shows "${text}" = ${got} in ${locale}, expected ${exp}`, text);
  }
  const got = parseLocaleNumber(text, locale);
  const exp = Number(want);
  if (!Number.isFinite(exp)) return fail(c, `expected value "${want}" is not a number (write it as 1234.5)`);
  if (got === undefined) return fail(c, `${c.target.description} shows "${text}", which holds no number in ${locale}`, text);
  if (c.kind === 'currency' && c.currency) {
    const marks = currencyMarks(env.interpolate(c.currency), locale);
    if (!marks.some((m) => text.includes(m))) return fail(c, `${c.target.description} shows "${text}" without the ${c.currency} currency mark (${marks.join(', ')}) in ${locale}`, text);
  }
  const tol = c.tolerance ?? 1e-9;
  return Math.abs(got - exp) <= tol ? ok(c, `${text} (${got})`) : fail(c, `${c.target.description} shows "${text}" = ${got} in ${locale}, expected ${exp}`, text);
}
