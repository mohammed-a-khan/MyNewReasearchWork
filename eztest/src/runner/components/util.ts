/** Small shared helpers for the Node side of the component adapters. */
import type { Frame, Locator } from '../../browser/index.js';
import { sleep } from '../../core/index.js';
import { ComponentError, engine, frameOf, marked } from './engine.js';
import type { CellCondition, CompareOp } from './types.js';

export interface OpOptions {
  /** Upper bound for waits (popups, re-renders, verification). Default 10000. */
  timeoutMs?: number;
  /** Upper bound for scanning virtualized/paged content. Default 60000. */
  budgetMs?: number;
  /** Force a specific adapter id (e.g. "kendo", "kendo-grid"). */
  adapter?: string;
}

export const DEFAULT_TIMEOUT = 10_000;
export const DEFAULT_BUDGET = 60_000;

/** Poll fn until it returns a value (not undefined) or the deadline passes. */
export async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number, every = 50): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await sleep(every);
  }
}

/** Marked-element access bound to the widget's frame. */
export class Scope {
  private constructor(
    public loc: Locator,
    readonly frame: Frame,
    private readonly orig: Locator,
  ) {}

  /**
   * Bind to the element `loc` resolves to now. The element is pinned with a
   * data attribute, so the operation keeps acting on the same widget even when
   * its accessible name changes underneath (a combobox named by its value).
   */
  static async of(loc: Locator, timeout = DEFAULT_TIMEOUT): Promise<Scope> {
    const frame = await frameOf(loc, timeout);
    const pin = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const existing = await loc.evaluate((el, p) => {
      const cur = el.getAttribute('data-ezc-root');
      if (cur) return cur;
      el.setAttribute('data-ezc-root', p);
      return p;
    }, pin, { timeout });
    return new Scope(frame.locator(`[data-ezc-root="${existing}"]`), frame, loc);
  }



  el(tag: string | null | undefined, what = 'element'): Locator {
    if (!tag) throw new ComponentError(`internal: no ${what} to act on`, 'COMPONENT');
    return marked(this.frame, tag);
  }

  /**
   * Run an engine op on the pinned widget. When the framework replaced the
   * widget's root element (re-render: same description, new node), the pin is
   * gone: re-pin through the original locator and run again.
   */
  async call<R>(op: string, arg: unknown = {}, timeout = DEFAULT_TIMEOUT): Promise<R> {
    try {
      return await engine<R>(this.loc, op, arg, Math.min(timeout, 1500));
    } catch (e) {
      if ((e as Error).name !== 'TimeoutError' || (await this.loc.count()) > 0) throw e;
      this.loc = (await Scope.of(this.orig, timeout)).loc;
      return engine<R>(this.loc, op, arg, timeout);
    }
  }
}

const OP_WORDS: Record<CompareOp, string> = {
  equals: '=', notEquals: '!=', contains: 'contains', startsWith: 'starts with', endsWith: 'ends with', matches: 'matches',
  gt: '>', gte: '>=', lt: '<', lte: '<=', empty: 'is empty', notEmpty: 'is not empty',
};

/** "Customer = "Contoso" and Status = "Open"" */
export function describeWhere(where: CellCondition[]): string {
  return where.map((w) => (w.op === 'empty' || w.op === 'notEmpty' ? `${w.column} ${OP_WORDS[w.op]}` : `${w.column} ${OP_WORDS[w.op ?? 'equals']} "${w.value}"`)).join(' and ');
}

/** Same comparison the engine uses, for Node-side checks (numbers compare as numbers). */
export function parseNumber(s: string): number | null {
  let t = normText(s).replace(/[\s']/g, '');
  const neg = /^\(.*\)$/.test(t) || /^-|-$|^[^\d]*-/.test(t);
  t = t.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(t)) return null;
  const lc = t.lastIndexOf(',');
  const ld = t.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) t = lc > ld ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (lc >= 0) t = (t.length - lc - 1 === 3 && t.indexOf(',') === lc && lc > 0) || t.split(',').length > 2 ? t.replace(/,/g, '') : t.replace(',', '.');
  else if (t.split('.').length > 2) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const INVIS = new RegExp(`[${[[0x200b, 0x200f], [0x2066, 0x2069], [0x202a, 0x202e], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');
const NBSP = new RegExp(`[${String.fromCharCode(0xa0, 0x202f, 0x2007)}]`, 'g');

export function normText(s: string | null | undefined): string {
  return (s ?? '').replace(INVIS, '').replace(NBSP, ' ').replace(/\s+/g, ' ').trim();
}

export function sameValue(actual: string, expected: string): boolean {
  const a = normText(actual);
  const b = normText(expected);
  if (a === b) return true;
  const numeric = (s: string) => /\d/.test(s) && /^[\s(+\-]*[^\d\s]{0,4}\s*\d[\d.,'\s]*\s*[^\d\s]{0,4}[)\s]*$/.test(s);
  if (numeric(a) && numeric(b)) {
    const x = parseNumber(a);
    return x !== null && x === parseNumber(b);
  }
  return false;
}

/** Are the values in order? Numbers compare numerically, ISO-like dates as dates, the rest by locale-aware text. */
export function isSorted(values: string[], order: 'asc' | 'desc'): { ok: boolean; at?: number } {
  const vals = values.map(normText);
  const allNum = vals.every((v) => v === '' || parseNumber(v) !== null);
  const cmp = (a: string, b: string): number => {
    if (allNum) return (parseNumber(a) ?? -Infinity) - (parseNumber(b) ?? -Infinity);
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  };
  for (let i = 1; i < vals.length; i++) {
    const c = cmp(vals[i - 1], vals[i]);
    if (order === 'asc' ? c > 0 : c < 0) return { ok: false, at: i };
  }
  return { ok: true };
}

export function ms(since: number): number {
  return Date.now() - since;
}
