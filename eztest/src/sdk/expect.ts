/**
 * `expect`: assertions whose failures carry evidence.
 *
 *  - `expect(value).toBe(x)` and friends check values in Node; a failure
 *    stores the actual and expected values (and a screenshot when a page is
 *    open) as evidence.
 *  - `expect.ui.*` checks run as runner post-conditions (polled, strictly
 *    located; a failure keeps the screenshot, ARIA snapshot and HTML).
 *  - `expect.api(res)`, `expect.rows(rows)` and `expect.db(query)` check API
 *    responses and row sets (keyed comparison with a findings report; empty
 *    comparisons fail).
 *  - `expect.soft...` (or anything inside `soft(async () => ...)`) records a
 *    failure and lets the journey continue; the journey still fails at the end.
 */
import type { Condition } from '../core/index.js';
import { parseCondition } from '../intent/conditions.js';
import { jsonPath, type ApiResponse } from './api.js';
import { callSite } from './callsite.js';
import { db, type BindValue } from './db.js';
import { describe, literal, run, show, target } from './internal.js';
import { frame } from './runtime.js';
import type { TargetInput } from './screen.js';
import type { Row } from './types.js';

// ------------------------------------------------------------------ value matchers

export interface ValueMatchers<T> {
  readonly not: ValueMatchers<T>;
  /** Strict equality (Object.is), or loose for numbers vs numeric strings when `loose` is set. */
  toBe(expected: unknown): Promise<void>;
  /** Deep equality (JSON form). */
  toEqual(expected: unknown): Promise<void>;
  /** A string contains a substring, or an array contains an item (deep). */
  toContain(item: unknown): Promise<void>;
  toMatch(pattern: RegExp | string): Promise<void>;
  toBeGreaterThan(n: number): Promise<void>;
  toBeGreaterThanOrEqual(n: number): Promise<void>;
  toBeLessThan(n: number): Promise<void>;
  toBeLessThanOrEqual(n: number): Promise<void>;
  toBeCloseTo(n: number, digits?: number): Promise<void>;
  toBeTruthy(): Promise<void>;
  toBeFalsy(): Promise<void>;
  toBeDefined(): Promise<void>;
  toBeUndefined(): Promise<void>;
  toBeNull(): Promise<void>;
  toHaveLength(n: number): Promise<void>;
  toBeOneOf(values: unknown[]): Promise<void>;
  /** Phantom: keeps T for editors. */
  readonly __value?: T;
}

const json = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const deepEq = (a: unknown, b: unknown) => json(a) === json(b);

interface Check {
  name: string;
  expected?: unknown;
  test(actual: unknown): boolean;
}

async function assertValue(actual: unknown, label: string | undefined, c: Check, negate: boolean, soft: boolean): Promise<void> {
  const f = frame('expect');
  const source = callSite();
  const what = label ?? show(actual);
  const intent = `Expect ${what} ${negate ? 'not ' : ''}${c.name}${'expected' in c ? ` ${show(c.expected)}` : ''}`;
  await f.host.record(intent, async (r) => {
    let ok: boolean;
    try {
      ok = c.test(actual);
    } catch (e) {
      ok = false;
      r.warn((e as Error).message);
    }
    if (negate) ok = !ok;
    r.capture('actual', actual);
    if ('expected' in c) r.capture('expected', c.expected);
    if (!ok) {
      const msg = `expected ${what} ${negate ? 'not ' : ''}${c.name}${'expected' in c ? ` ${show(c.expected, 200)}` : ''}${label ? ` (actual: ${show(actual, 200)})` : ''}`;
      r.evidence(await f.host.evidence('data', 'assertion.json', JSON.stringify({ assertion: intent, actual, ...('expected' in c ? { expected: c.expected } : {}), negated: negate }, null, 2), `failed assertion: ${intent}`));
      const shot = await f.host.screenshot('assertion', `page when "${intent}" failed`).catch(() => undefined);
      if (shot) r.evidence(shot);
      r.fail(msg);
    }
  }, { kind: 'assert', soft: soft || f.soft, ...(source ? { source } : {}) });
}

function valueMatchers<T>(actual: T, label: string | undefined, soft: boolean, negate = false): ValueMatchers<T> {
  const a = (c: Check) => assertValue(actual, label, c, negate, soft);
  const m: ValueMatchers<T> = {
    get not() {
      return valueMatchers(actual, label, soft, !negate);
    },
    toBe: (e) => a({ name: 'to be', expected: e, test: (v) => Object.is(v, e) }),
    toEqual: (e) => a({ name: 'to equal', expected: e, test: (v) => deepEq(v, e) }),
    toContain: (item) => a({ name: 'to contain', expected: item, test: (v) => (typeof v === 'string' ? v.includes(String(item)) : Array.isArray(v) ? v.some((x) => deepEq(x, item)) : false) }),
    toMatch: (p) => a({ name: 'to match', expected: String(p), test: (v) => (p instanceof RegExp ? p : new RegExp(p)).test(String(v)) }),
    toBeGreaterThan: (n) => a({ name: 'to be greater than', expected: n, test: (v) => num(v) > n }),
    toBeGreaterThanOrEqual: (n) => a({ name: 'to be at least', expected: n, test: (v) => num(v) >= n }),
    toBeLessThan: (n) => a({ name: 'to be less than', expected: n, test: (v) => num(v) < n }),
    toBeLessThanOrEqual: (n) => a({ name: 'to be at most', expected: n, test: (v) => num(v) <= n }),
    toBeCloseTo: (n, digits = 2) => a({ name: `to be close to (${digits} digits)`, expected: n, test: (v) => Math.abs(num(v) - n) < 10 ** -digits / 2 }),
    toBeTruthy: () => a({ name: 'to be truthy', test: (v) => !!v }),
    toBeFalsy: () => a({ name: 'to be falsy', test: (v) => !v }),
    toBeDefined: () => a({ name: 'to be defined', test: (v) => v !== undefined }),
    toBeUndefined: () => a({ name: 'to be undefined', test: (v) => v === undefined }),
    toBeNull: () => a({ name: 'to be null', test: (v) => v === null }),
    toHaveLength: (n) => a({ name: 'to have length', expected: n, test: (v) => (v as { length?: unknown } | null)?.length === n }),
    toBeOneOf: (values) => a({ name: 'to be one of', expected: values, test: (v) => values.some((x) => deepEq(x, v)) }),
  };
  return m;
}

// ------------------------------------------------------------------ UI (runner post-conditions)

async function uiAssert(conds: Condition[], intent: string, soft: boolean, timeoutMs?: number): Promise<void> {
  const f = frame('expect.ui');
  await run({ intent, action: 'assert', postconditions: conds }, { soft: soft || f.soft, ...(timeoutMs ? { timeoutMs } : {}) });
}

export interface TextMatchers {
  toBe(text: string): Promise<void>;
  toContain(text: string): Promise<void>;
  toMatch(pattern: RegExp | string): Promise<void>;
}

function uiFactory(soft: boolean) {
  return {
    /** The element's text. */
    text(t: TargetInput): TextMatchers {
      const tg = () => target(t);
      const d = describe(t);
      return {
        toBe: (v) => uiAssert([{ type: 'textEquals', target: tg(), value: literal(v) }], `Expect the text of ${d} to be ${show(v)}`, soft),
        toContain: (v) => uiAssert([{ type: 'textContains', target: tg(), value: literal(v) }], `Expect the text of ${d} to contain ${show(v)}`, soft),
        toMatch: (p) => uiAssert([{ type: 'textMatches', target: tg(), pattern: literal(p instanceof RegExp ? p.source : p), ...(p instanceof RegExp && p.flags ? { flags: p.flags } : {}) }], `Expect the text of ${d} to match ${String(p)}`, soft),
      };
    },
    /** The input's value. */
    value(t: TargetInput): { toBe(v: string): Promise<void> } {
      return { toBe: (v) => uiAssert([{ type: 'valueEquals', target: target(t), value: literal(v) }], `Expect the value of ${describe(t)} to be ${show(v)}`, soft) };
    },
    visible: (t: TargetInput) => uiAssert([{ type: 'visible', target: target(t) }], `Expect ${describe(t)} to be visible`, soft),
    hidden: (t: TargetInput) => uiAssert([{ type: 'hidden', target: target(t) }], `Expect ${describe(t)} to be hidden`, soft),
    enabled: (t: TargetInput) => uiAssert([{ type: 'state', target: target(t), state: 'enabled' }], `Expect ${describe(t)} to be enabled`, soft),
    disabled: (t: TargetInput) => uiAssert([{ type: 'state', target: target(t), state: 'disabled' }], `Expect ${describe(t)} to be disabled`, soft),
    checked: (t: TargetInput) => uiAssert([{ type: 'state', target: target(t), state: 'checked' }], `Expect ${describe(t)} to be checked`, soft),
    count(t: TargetInput): { toBe(n: number): Promise<void> } {
      return { toBe: (n) => uiAssert([{ type: 'count', target: target(t), equals: n }], `Expect ${n} of ${describe(t)}`, soft) };
    },
    url(): { toContain(s: string): Promise<void>; toMatch(pattern: string): Promise<void> } {
      return {
        toContain: (s) => uiAssert([{ type: 'urlContains', value: literal(s) }], `Expect the URL to contain ${show(s)}`, soft),
        toMatch: (p) => uiAssert([{ type: 'urlMatches', pattern: literal(p) }], `Expect the URL to match ${show(p)}`, soft),
      };
    },
    title(): { toContain(s: string): Promise<void> } {
      return { toContain: (s) => uiAssert([{ type: 'titleContains', value: literal(s) }], `Expect the title to contain ${show(s)}`, soft) };
    },
    page(): { toContainText(s: string): Promise<void>; notToContainText(s: string): Promise<void> } {
      return {
        toContainText: (s) => uiAssert([{ type: 'pageContainsText', value: literal(s) }], `Expect the page to contain ${show(s)}`, soft),
        notToContainText: (s) => uiAssert([{ type: 'pageNotContainsText', value: literal(s) }], `Expect the page not to contain ${show(s)}`, soft),
      };
    },
    /** Any `.ez` Expect phrase: `expect.ui.that('the "Save" button is disabled')`. */
    that: (phrase: string) => uiAssert([parseCondition(phrase)], `Expect ${phrase}`, soft),
  };
}

// ------------------------------------------------------------------ API

function apiFactory(soft: boolean) {
  return (res: ApiResponse) => ({
    status: (code: number) => valueMatchers(res?.status, `the response status`, soft).toBe(code),
    json: (path: string) => valueMatchers(jsonPath(res?.body, path), `response ${path}`, soft),
    header: (name: string) => valueMatchers(res?.headers?.[name.toLowerCase()], `response header ${name}`, soft),
    /** The call took at most `ms`. */
    fasterThan: (ms: number) => valueMatchers(res?.durationMs, 'the response time (ms)', soft).toBeLessThanOrEqual(ms),
  });
}

// ------------------------------------------------------------------ rows

export interface RowCompareOptions {
  /** Key column(s) that identify a row in both sets. Without a key, rows are compared in order. */
  key?: string | string[];
  /** Only compare these columns (default: the expected rows' columns). */
  columns?: string[];
  /** Numeric tolerance (absolute) for numbers. */
  tolerance?: number;
  /** Ignore case of text values. */
  ignoreCase?: boolean;
  /** Allow both sets to be empty (default false: comparing nothing fails). */
  allowEmpty?: boolean;
}

export interface RowFinding {
  type: 'MISSING' | 'EXTRA' | 'MISMATCH' | 'DUPLICATE_KEY';
  key: string;
  column?: string;
  expected?: unknown;
  actual?: unknown;
}

const col = (r: Row, c: string): unknown => {
  if (c in r) return r[c];
  const k = Object.keys(r).find((x) => x.toLowerCase() === c.toLowerCase());
  return k === undefined ? undefined : r[k];
};

function same(a: unknown, b: unknown, o: RowCompareOptions): boolean {
  const na = num(a);
  const nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) <= (o.tolerance ?? 0);
  const norm = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v).trim();
    return o.ignoreCase ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** Keyed comparison of two row sets: MISSING, EXTRA, MISMATCH and DUPLICATE_KEY findings. */
export function compareRows(actual: Row[], expected: Row[], o: RowCompareOptions = {}): RowFinding[] {
  const keys = o.key === undefined ? [] : Array.isArray(o.key) ? o.key : [o.key];
  const cols = o.columns ?? [...new Set(expected.flatMap((r) => Object.keys(r)))];
  const keyOf = (r: Row, i: number) => (keys.length ? keys.map((k) => String(col(r, k) ?? '')).join('|') : `#${i + 1}`);
  const index = (rows: Row[], out: RowFinding[]) => {
    const m = new Map<string, Row>();
    rows.forEach((r, i) => {
      const k = keyOf(r, i);
      if (m.has(k)) out.push({ type: 'DUPLICATE_KEY', key: k });
      m.set(k, r);
    });
    return m;
  };
  const findings: RowFinding[] = [];
  const A = index(actual, findings);
  const E = index(expected, findings);
  for (const [k, e] of E) {
    const a = A.get(k);
    if (!a) {
      findings.push({ type: 'MISSING', key: k });
      continue;
    }
    for (const c of cols) {
      if (keys.some((x) => x.toLowerCase() === c.toLowerCase())) continue;
      const ev = col(e, c);
      const av = col(a, c);
      if (!same(av, ev, o)) findings.push({ type: 'MISMATCH', key: k, column: c, expected: ev, actual: av });
    }
  }
  for (const k of A.keys()) if (!E.has(k)) findings.push({ type: 'EXTRA', key: k });
  return findings;
}

function rowsFactory(soft: boolean) {
  return (rows: Row[], label = 'rows') => {
    const record = async (intent: string, test: () => { ok: boolean; message: string; details?: unknown }) => {
      const f = frame('expect.rows');
      const source = callSite();
      await f.host.record(intent, async (r) => {
        const res = test();
        r.capture('rows', rows?.length ?? 0);
        if (!res.ok) {
          r.evidence(await f.host.evidence('data', 'rows-check.json', JSON.stringify({ check: intent, message: res.message, details: res.details, actualRows: rows }, null, 2), `failed row check: ${intent}`));
          r.fail(res.message);
        }
      }, { kind: 'assert', soft: soft || f.soft, ...(source ? { source } : {}) });
    };
    return {
      toHaveCount: (n: number) => record(`Expect ${n} ${label}`, () => ({ ok: rows?.length === n, message: `expected ${n} ${label}, got ${rows?.length ?? 0}` })),
      toBeEmpty: () => record(`Expect no ${label}`, () => ({ ok: (rows?.length ?? 0) === 0, message: `expected no ${label}, got ${rows?.length}` })),
      notToBeEmpty: () => record(`Expect some ${label}`, () => ({ ok: (rows?.length ?? 0) > 0, message: `expected some ${label}, got none` })),
      /** Some row has these column values (case-insensitive column names). */
      toContainRow: (partial: Row) => record(`Expect ${label} to contain ${show(partial)}`, () => {
        const ok = (rows ?? []).some((r) => Object.entries(partial).every(([c, v]) => same(col(r, c), v, {})));
        return { ok, message: `no row matches ${show(partial, 200)} among ${rows?.length ?? 0} ${label}` };
      }),
      /** Keyed comparison with another row set (a query, a file, a UI table). */
      toEqual: (expected: Row[], o: RowCompareOptions = {}) => record(`Expect ${label} to equal ${expected.length} expected rows${o.key ? ` by ${String(o.key)}` : ''}`, () => {
        if (!o.allowEmpty && !(rows?.length) && !expected.length) return { ok: false, message: `nothing to compare: both row sets are empty (pass allowEmpty to accept that)` };
        const findings = compareRows(rows ?? [], expected, o);
        const by = (t: string) => findings.filter((x) => x.type === t).length;
        return {
          ok: findings.length === 0,
          message: `${findings.length} difference(s): ${by('MISSING')} missing, ${by('EXTRA')} extra, ${by('MISMATCH')} mismatched, ${by('DUPLICATE_KEY')} duplicate keys; first: ${show(findings[0], 160)}`,
          details: findings,
        };
      }),
      /** Rows are sorted by a column. */
      toBeSortedBy: (column: string, dir: 'asc' | 'desc' = 'asc') => record(`Expect ${label} sorted by ${column} ${dir}`, () => {
        const vals = (rows ?? []).map((r) => col(r, column));
        const cmp = (a: unknown, b: unknown) => {
          const na = num(a), nb = num(b);
          return !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : String(a ?? '').localeCompare(String(b ?? ''));
        };
        const bad = vals.findIndex((v, i) => i > 0 && (dir === 'asc' ? cmp(vals[i - 1], v) > 0 : cmp(vals[i - 1], v) < 0));
        return { ok: vals.length > 0 && bad < 0, message: vals.length ? `row ${bad + 1} breaks the ${dir} order of ${column}` : `no ${label} to check` };
      }),
    };
  };
}

function dbFactory(soft: boolean) {
  return (query: string, params?: Record<string, BindValue>, o: { connection?: string } = {}) => {
    const rows = () => db.query(query, params, o);
    return {
      toHaveCount: async (n: number) => rowsFactory(soft)(await rows(), `rows of ${query}`).toHaveCount(n),
      notToBeEmpty: async () => rowsFactory(soft)(await rows(), `rows of ${query}`).notToBeEmpty(),
      toContainRow: async (partial: Row) => rowsFactory(soft)(await rows(), `rows of ${query}`).toContainRow(partial),
      /** The query's rows equal these rows (e.g. a UI table or an exported file). */
      toEqual: async (expected: Row[], c: RowCompareOptions = {}) => rowsFactory(soft)(await rows(), `rows of ${query}`).toEqual(expected, c),
    };
  };
}

// ------------------------------------------------------------------ the expect function

function make(soft: boolean) {
  const fn = <T>(actual: T, label?: string): ValueMatchers<T> => valueMatchers(actual, label, soft);
  return Object.assign(fn, {
    ui: uiFactory(soft),
    api: apiFactory(soft),
    rows: rowsFactory(soft),
    db: dbFactory(soft),
  });
}

type Base = ReturnType<typeof make>;

export interface Expect extends Base {
  /** The same matchers, soft: a failure is recorded and the journey continues (and fails at the end). */
  soft: Base;
}

export const expect: Expect = Object.assign(make(false), { soft: make(true) });
