/**
 * Dataset comparison (e.g. UI grid vs API vs DB). Type-aware: 25000 equals
 * "25000.00", a Date equals the same instant as an ISO string, but a date is
 * never read as a number. Comparing two empty sets FAILS: nothing was checked.
 * Column names match case-insensitively when there is no exact match, so an
 * Oracle row (ORDER_ID) compares with an API or SQL Server row (order_id).
 */
import { getColumn, hasColumn } from './db-rows.js';

export type CompareRow = Record<string, unknown>;

export interface CompareOptions {
  /** Column(s) identifying a row. */
  key: string | string[];
  /** Columns to compare (default: all columns of the expected rows, minus key columns). */
  columns?: string[];
  /** Absolute numeric tolerance, globally or per column. */
  tolerance?: number | Record<string, number>;
  /** Typed equality (default true). When false, values must be strictly equal. */
  typeAware?: boolean;
  /** Trim strings and compare case-insensitively. */
  ignoreCase?: boolean;
  trim?: boolean;
  /** Fail on actual rows not present in expected (default true). */
  failOnExtra?: boolean;
}

export interface CellMismatch {
  key: string;
  column: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}

export interface CompareResult {
  passed: boolean;
  /** Rows matched by key on both sides. */
  compared: number;
  /** Rows whose compared columns are all equal. */
  matched: number;
  missing: string[];
  extra: string[];
  duplicates: Array<{ side: 'expected' | 'actual'; key: string }>;
  mismatches: CellMismatch[];
  problems: string[];
  summary: string;
}

const NUMERIC_RE = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function keyOf(row: CompareRow, keys: string[]): string | undefined {
  const parts: string[] = [];
  for (const k of keys) {
    const v = getColumn(row, k);
    if (v === undefined || v === null || v === '') return undefined;
    parts.push(v instanceof Date ? v.toISOString() : String(v).trim());
  }
  return parts.join('|');
}

type Typed = { t: 'null' } | { t: 'num'; v: number } | { t: 'date'; v: number } | { t: 'bool'; v: boolean } | { t: 'str'; v: string } | { t: 'other'; v: string };

function typed(v: unknown): Typed {
  if (v === null || v === undefined) return { t: 'null' };
  if (v instanceof Date) return { t: 'date', v: v.getTime() };
  if (typeof v === 'number') return Number.isNaN(v) ? { t: 'other', v: 'NaN' } : { t: 'num', v };
  if (typeof v === 'bigint') return { t: 'num', v: Number(v) };
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'string') {
    if (ISO_DATE_RE.test(v.trim())) {
      const d = Date.parse(v.trim().replace(' ', 'T'));
      if (!Number.isNaN(d)) return { t: 'date', v: d };
    }
    if (NUMERIC_RE.test(v)) return { t: 'num', v: Number(v) };
    return { t: 'str', v };
  }
  return { t: 'other', v: JSON.stringify(v) };
}

function eqTyped(a: unknown, b: unknown, tol: number, o: CompareOptions): { equal: boolean; reason?: string } {
  if (o.typeAware === false) return Object.is(a, b) ? { equal: true } : { equal: false, reason: 'not strictly equal' };
  const x = typed(a);
  const y = typed(b);
  if (x.t === 'null' || y.t === 'null') return x.t === y.t ? { equal: true } : { equal: false, reason: 'null vs value' };
  if (x.t === 'num' && y.t === 'num') {
    const d = Math.abs(x.v - y.v);
    return d <= tol + Number.EPSILON * Math.max(1, Math.abs(x.v)) ? { equal: true } : { equal: false, reason: `numbers differ by ${d}` };
  }
  if (x.t === 'date' && y.t === 'date') return x.v === y.v ? { equal: true } : { equal: false, reason: 'dates differ' };
  if (x.t === 'bool' || y.t === 'bool') {
    const asBool = (t: Typed): boolean | undefined =>
      t.t === 'bool' ? t.v : t.t === 'num' && (t.v === 0 || t.v === 1) ? t.v === 1 : t.t === 'str' && /^(true|false)$/i.test(t.v) ? t.v.toLowerCase() === 'true' : undefined;
    const p = asBool(x);
    const q = asBool(y);
    return p !== undefined && p === q ? { equal: true } : { equal: false, reason: 'booleans differ' };
  }
  if (x.t !== y.t) return { equal: false, reason: `type ${x.t} vs ${y.t}` };
  let s1 = String((x as { v: unknown }).v);
  let s2 = String((y as { v: unknown }).v);
  if (o.trim) {
    s1 = s1.trim();
    s2 = s2.trim();
  }
  if (o.ignoreCase) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
  }
  return s1 === s2 ? { equal: true } : { equal: false, reason: 'text differs' };
}

export function compareRows(expected: CompareRow[], actual: CompareRow[], o: CompareOptions): CompareResult {
  const keys = Array.isArray(o.key) ? o.key : [o.key];
  if (keys.length === 0 || keys.some((k) => !k)) throw new Error('compareRows needs at least one key column');
  const problems: string[] = [];
  const duplicates: CompareResult['duplicates'] = [];

  const index = (rows: CompareRow[], side: 'expected' | 'actual') => {
    const m = new Map<string, CompareRow>();
    rows.forEach((r, i) => {
      const k = keyOf(r, keys);
      if (k === undefined) {
        problems.push(`${side} row ${i} has no value for key ${keys.join('+')}`);
        return;
      }
      if (m.has(k)) duplicates.push({ side, key: k });
      else m.set(k, r);
    });
    return m;
  };
  const exp = index(expected, 'expected');
  const act = index(actual, 'actual');

  const columns =
    o.columns ??
    [...new Set(expected.flatMap((r) => Object.keys(r)))].filter((c) => !keys.some((k) => k.toLowerCase() === c.toLowerCase()));
  const tolFor = (c: string) => (typeof o.tolerance === 'number' ? o.tolerance : o.tolerance ? Number(getColumn(o.tolerance, c) ?? 0) : 0);

  const missing: string[] = [];
  const extra: string[] = [];
  const mismatches: CellMismatch[] = [];
  let compared = 0;
  let matched = 0;
  for (const [k, e] of exp) {
    const a = act.get(k);
    if (!a) {
      missing.push(k);
      continue;
    }
    compared++;
    let rowOk = true;
    for (const c of columns) {
      const ev = getColumn(e, c);
      const av = getColumn(a, c);
      if (!hasColumn(a, c) && hasColumn(e, c)) {
        mismatches.push({ key: k, column: c, expected: ev, actual: undefined, reason: 'column missing in actual' });
        rowOk = false;
        continue;
      }
      const r = eqTyped(ev, av, tolFor(c), o);
      if (!r.equal) {
        mismatches.push({ key: k, column: c, expected: ev, actual: av, reason: r.reason ?? 'differs' });
        rowOk = false;
      }
    }
    if (rowOk) matched++;
  }
  for (const k of act.keys()) if (!exp.has(k)) extra.push(k);

  if (expected.length === 0 && actual.length === 0) problems.push('both datasets are empty: nothing was compared');
  else if (compared === 0) problems.push('no rows matched by key: nothing was compared');
  if (columns.length === 0 && compared > 0) problems.push('no columns to compare besides the key');

  const passed =
    problems.length === 0 && duplicates.length === 0 && missing.length === 0 && mismatches.length === 0 && (o.failOnExtra === false || extra.length === 0);
  const summary = passed
    ? `PASS: ${compared} rows x ${columns.length} columns equal`
    : `FAIL: ${compared} compared, ${matched} matched, ${missing.length} missing, ${extra.length} extra, ${duplicates.length} duplicate keys, ${mismatches.length} cell mismatches${problems.length ? '; ' + problems.join('; ') : ''}`;
  return { passed, compared, matched, missing, extra, duplicates, mismatches, problems, summary };
}
