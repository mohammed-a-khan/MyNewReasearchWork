/**
 * Reconciler: joins two record sets by (composite) key, compares mapped
 * columns with per-column types, tolerances and fuzzy thresholds, applies a
 * known-differences allowlist and evaluates gates (coverage, footing,
 * checksum). Nothing passes on empty input: zero rows or zero compared fields
 * fail the coverage gate.
 */
import { EzTestError } from '../core/index.js';
import type { DocTable, NormalizedValue, ValueType } from './model.js';
import { formatNormalized, normalizeValue, similarity, valuesEqual, type NumberLocale } from './normalize.js';
import type { CellProvenance, RecordSet, RecordValue } from './sources.js';

export type FindingType =
  | 'MATCH'
  | 'MISMATCH'
  | 'WITHIN_TOLERANCE'
  | 'MISSING'
  | 'EXTRA'
  | 'DUPLICATE_KEY'
  | 'KNOWN_DIFFERENCE'
  | 'FORMAT_ONLY';

export const FINDING_TYPES: FindingType[] = [
  'MISMATCH',
  'MISSING',
  'EXTRA',
  'DUPLICATE_KEY',
  'KNOWN_DIFFERENCE',
  'WITHIN_TOLERANCE',
  'FORMAT_ONLY',
  'MATCH',
];

/** Finding types that make a reconciliation fail. */
export const FAILING_TYPES: ReadonlySet<FindingType> = new Set(['MISMATCH', 'MISSING', 'EXTRA', 'DUPLICATE_KEY']);

export interface Tolerance {
  /** Absolute tolerance, e.g. 0.01. */
  abs?: number;
  /** Relative tolerance, e.g. 0.001 for 0.1%. */
  rel?: number;
}

export interface KnownDifference {
  /** Regex tested against the composite key ("k1|k2"). */
  key: string;
  /** Canonical column name, or "*" for any column and for whole-row MISSING/EXTRA. */
  column: string;
  reason: string;
}

export interface FootingRule {
  name?: string;
  /** Which side's rows are summed. Default "actual". */
  side?: 'expected' | 'actual';
  /** Canonical column to sum (mapped through fieldMap for the actual side). */
  column: string;
  /** The printed total, e.g. "1,250.00". */
  printedTotal: string | number | null | undefined;
  /** Absolute tolerance (default 0.005). */
  tolerance?: number;
}

export interface ChecksumRule {
  /** Canonical column whose sum must agree on both sides. */
  column: string;
  tolerance?: number;
}

export interface ReconcileRules {
  /** Canonical key column(s) (expected-side names). */
  key: string | string[];
  /** expected column -> actual column, for sources with different names. */
  fieldMap?: Record<string, string>;
  /** Canonical columns to compare (default: every expected column that exists on the actual side). */
  columns?: string[];
  types?: Record<string, ValueType>;
  /** Per column tolerance; "*" applies to all numeric columns without their own. */
  tolerances?: Record<string, Tolerance>;
  /** Per column fuzzy text threshold 0..1; "*" for all. */
  fuzzy?: Record<string, number>;
  knownDifferences?: KnownDifference[];
  /** Number locale of the expected side (and of the actual side unless actualLocale is set). */
  locale?: NumberLocale;
  actualLocale?: NumberLocale;
  dateFormats?: string[];
  footing?: FootingRule[];
  checksum?: ChecksumRule[];
  /** Include MATCH findings in the report (default true). */
  includeMatches?: boolean;
  expectedName?: string;
  actualName?: string;
}

export interface ReconFinding {
  type: FindingType;
  key: string;
  column?: string;
  expected?: string;
  actual?: string;
  expectedNormalized?: string;
  actualNormalized?: string;
  delta?: number;
  similarity?: number;
  reason?: string;
  /** Explanation without business values (safe to show when values are masked). */
  message: string;
  expectedProvenance?: CellProvenance;
  actualProvenance?: CellProvenance;
}

export interface GateResult {
  name: string;
  passed: boolean;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface ReconciliationSummary {
  expectedRows: number;
  actualRows: number;
  matchedRows: number;
  fieldsCompared: number;
  columns: string[];
  skippedColumns: string[];
  counts: Record<FindingType, number>;
}

export interface ReconciliationReport {
  kind: 'reconciliation';
  expectedName: string;
  actualName: string;
  status: 'PASS' | 'FAIL';
  summary: ReconciliationSummary;
  gates: GateResult[];
  findings: ReconFinding[];
}

type Rows = RecordSet | ReadonlyArray<Record<string, unknown>>;

function asSet(x: Rows, fallback: string): RecordSet {
  if (!Array.isArray(x) && typeof x === 'object' && x !== null && 'rows' in x) return x as RecordSet;
  return { name: fallback, kind: 'records', rows: (x as ReadonlyArray<Record<string, unknown>>).map((r) => ({ ...r }) as Record<string, RecordValue>) };
}

function rawString(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return '';
  return String(v);
}

const keyCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });

export function sortFindings<T extends { key: string; column?: string; type: FindingType }>(f: T[]): T[] {
  return [...f].sort(
    (a, b) =>
      keyCollator.compare(a.key, b.key) ||
      keyCollator.compare(a.column ?? '', b.column ?? '') ||
      FINDING_TYPES.indexOf(a.type) - FINDING_TYPES.indexOf(b.type),
  );
}

export interface CellComparison {
  type: FindingType;
  expectedNormalized: NormalizedValue;
  actualNormalized: NormalizedValue;
  delta?: number;
  similarity?: number;
  message: string;
}

/** Compare one pair of values under the given type/tolerance/fuzzy rules. */
export function compareValues(
  expected: unknown,
  actual: unknown,
  opts: {
    type?: ValueType;
    tolerance?: Tolerance;
    fuzzy?: number;
    locale?: NumberLocale;
    /** Locale of the actual side when it differs (e.g. a German PDF vs an en DB export). */
    actualLocale?: NumberLocale;
    dateFormats?: string[];
  } = {},
): CellComparison {
  const n = { type: opts.type, locale: opts.locale, dateFormats: opts.dateFormats };
  const e = normalizeValue(expected, n);
  const a = normalizeValue(actual, { ...n, locale: opts.actualLocale ?? opts.locale });
  const base = { expectedNormalized: e, actualNormalized: a };
  if (valuesEqual(e, a)) {
    const re = rawString(expected)?.trim() ?? '';
    const ra = rawString(actual)?.trim() ?? '';
    return re === ra
      ? { ...base, type: 'MATCH', message: 'values are identical' }
      : { ...base, type: 'FORMAT_ONLY', message: 'same value, different formatting' };
  }
  if (e.kind === 'number' && a.kind === 'number') {
    const delta = Math.round(((a.value as number) - (e.value as number)) * 1e9) / 1e9;
    if (e.currency && a.currency && e.currency !== a.currency) {
      return { ...base, type: 'MISMATCH', delta, message: 'currencies differ' };
    }
    const t = opts.tolerance;
    if (t) {
      const allowed = Math.max(t.abs ?? 0, t.rel !== undefined ? t.rel * Math.abs(e.value as number) : 0);
      if (Math.abs(delta) <= allowed + 1e-9) {
        return { ...base, type: 'WITHIN_TOLERANCE', delta, message: `difference within tolerance (abs ${t.abs ?? 0}, rel ${t.rel ?? 0})` };
      }
    }
    return { ...base, type: 'MISMATCH', delta, message: 'numeric values differ' };
  }
  if (e.kind === 'text' && a.kind === 'text') {
    const sim = Math.round(similarity(String(e.value), String(a.value)) * 1000) / 1000;
    if (opts.fuzzy !== undefined && sim >= opts.fuzzy) {
      return { ...base, type: 'WITHIN_TOLERANCE', similarity: sim, message: `text similarity ${sim} >= threshold ${opts.fuzzy}` };
    }
    return { ...base, type: 'MISMATCH', similarity: sim, message: 'text values differ' };
  }
  if (e.kind === 'date' && a.kind === 'date') return { ...base, type: 'MISMATCH', message: 'dates differ' };
  return { ...base, type: 'MISMATCH', message: `value kinds differ (${e.kind} vs ${a.kind})` };
}

/** Footing: the printed total must equal the sum of the line values within tolerance. */
export function checkFooting(
  rows: ReadonlyArray<Record<string, unknown>>,
  column: string,
  printedTotal: unknown,
  opts: { tolerance?: number; locale?: NumberLocale; name?: string } = {},
): GateResult {
  const name = opts.name ?? `footing:${column}`;
  const tol = opts.tolerance ?? 0.005;
  const printed = normalizeValue(printedTotal, { type: 'number', locale: opts.locale });
  let sum = 0;
  let numeric = 0;
  let nonNumeric = 0;
  for (const r of rows) {
    const v = normalizeValue(r[column], { type: 'number', locale: opts.locale });
    if (v.kind === 'number') {
      sum += v.value as number;
      numeric++;
    } else nonNumeric++;
  }
  sum = Math.round(sum * 1e6) / 1e6;
  if (printed.kind !== 'number') {
    return { name, passed: false, message: 'printed total is missing or not a number', details: { rows: rows.length } };
  }
  if (numeric === 0) {
    return { name, passed: false, message: 'no numeric line values to sum (empty extraction)', details: { rows: rows.length, nonNumeric } };
  }
  const delta = Math.round(((printed.value as number) - sum) * 1e6) / 1e6;
  const passed = Math.abs(delta) <= tol && nonNumeric === 0;
  return {
    name,
    passed,
    message: passed
      ? `printed total equals the sum of ${numeric} line values`
      : nonNumeric > 0
        ? `${nonNumeric} line value(s) are not numeric`
        : `printed total differs from the sum of ${numeric} line values`,
    details: { printedTotal: printed.value as number, sum, delta, lines: numeric, nonNumeric, tolerance: tol },
  };
}

/** Footing rule built from a document table: sums `column` over data rows and reads the printed total from the total row. */
export function footingFromTable(table: DocTable, column: string, opts: { tolerance?: number; locale?: NumberLocale } = {}): GateResult {
  const rows = table.rows.filter((r) => r.kind === 'data').map((r) => ({ [column]: r.cells[column]?.raw ?? null }));
  const totalRow = [...table.rows].reverse().find((r) => r.kind === 'total');
  if (!totalRow) {
    return { name: `footing:${table.name}.${column}`, passed: false, message: `table "${table.name}" has no total row` };
  }
  return checkFooting(rows, column, totalRow.cells[column]?.raw, { ...opts, name: `footing:${table.name}.${column}` });
}

/** Reconcile expected vs actual records. */
export function reconcile(expectedIn: Rows, actualIn: Rows, rules: ReconcileRules): ReconciliationReport {
  const expected = asSet(expectedIn, rules.expectedName ?? 'expected');
  const actual = asSet(actualIn, rules.actualName ?? 'actual');
  const keyCols = Array.isArray(rules.key) ? rules.key : [rules.key];
  if (keyCols.length === 0) throw new EzTestError('reconcile: at least one key column is required', 'RECONCILE_INVALID');
  const map = (c: string) => rules.fieldMap?.[c] ?? c;
  const nopts = (c: string) => ({ type: rules.types?.[c], locale: rules.locale, dateFormats: rules.dateFormats });
  const known = (rules.knownDifferences ?? []).map((k) => ({ ...k, re: new RegExp(k.key) }));
  const findings: ReconFinding[] = [];
  const gates: GateResult[] = [];

  // Columns to compare.
  const actualCols = new Set(actual.rows.flatMap((r) => Object.keys(r)));
  const expectedCols = [...new Set(expected.rows.flatMap((r) => Object.keys(r)))].filter((c) => !keyCols.includes(c));
  const requested = rules.columns ?? expectedCols;
  const columns = rules.columns ? [...requested] : requested.filter((c) => actualCols.has(map(c)));
  const skippedColumns = rules.columns ? [] : requested.filter((c) => !actualCols.has(map(c)));
  columns.sort(keyCollator.compare);
  skippedColumns.sort(keyCollator.compare);

  const keyOf = (row: Record<string, unknown>, side: 'e' | 'a'): string | undefined => {
    const parts: string[] = [];
    for (const k of keyCols) {
      const locale = side === 'a' ? (rules.actualLocale ?? rules.locale) : rules.locale;
      const v = normalizeValue(row[side === 'e' ? k : map(k)], { ...nopts(k), locale, caseFold: true });
      if (v.kind === 'null') return undefined;
      parts.push(formatNormalized(v));
    }
    return parts.join('|');
  };
  const index = (set: RecordSet, side: 'e' | 'a') => {
    const m = new Map<string, number[]>();
    let noKey = 0;
    set.rows.forEach((r, i) => {
      const k = keyOf(r, side);
      if (k === undefined) {
        noKey++;
        return;
      }
      m.set(k, [...(m.get(k) ?? []), i]);
    });
    return { m, noKey };
  };
  const ei = index(expected, 'e');
  const ai = index(actual, 'a');
  if (ei.noKey || ai.noKey) {
    gates.push({
      name: 'keys',
      passed: false,
      message: `${ei.noKey} expected and ${ai.noKey} actual row(s) have an empty key and were not compared`,
      details: { expectedWithoutKey: ei.noKey, actualWithoutKey: ai.noKey },
    });
  }
  const knownFor = (key: string, column: string | undefined) =>
    known.find((k) => k.re.test(key) && (k.column === '*' || (column !== undefined && k.column === column)));

  const push = (f: ReconFinding) => {
    if (f.type === 'MISMATCH' || f.type === 'MISSING' || f.type === 'EXTRA') {
      const k = knownFor(f.key, f.column);
      if (k) {
        f = { ...f, type: 'KNOWN_DIFFERENCE', reason: k.reason, message: `${f.message} (known difference: ${f.type})` };
      }
    }
    if (f.type === 'MATCH' && rules.includeMatches === false) return;
    findings.push(f);
  };

  let matchedRows = 0;
  let fieldsCompared = 0;
  const allKeys = [...new Set([...ei.m.keys(), ...ai.m.keys()])].sort(keyCollator.compare);
  for (const key of allKeys) {
    const er = ei.m.get(key) ?? [];
    const ar = ai.m.get(key) ?? [];
    if (er.length > 1) push({ type: 'DUPLICATE_KEY', key, message: `key occurs ${er.length} times in ${expected.name}` });
    if (ar.length > 1) push({ type: 'DUPLICATE_KEY', key, message: `key occurs ${ar.length} times in ${actual.name}` });
    if (er.length > 1 || ar.length > 1) continue;
    if (er.length === 0) {
      push({ type: 'EXTRA', key, message: `row exists only in ${actual.name}` });
      continue;
    }
    if (ar.length === 0) {
      push({ type: 'MISSING', key, message: `row missing from ${actual.name}` });
      continue;
    }
    matchedRows++;
    const e = expected.rows[er[0]];
    const a = actual.rows[ar[0]];
    for (const col of columns) {
      const acol = map(col);
      const ep = expected.provenance?.[er[0]]?.[col];
      const ap = actual.provenance?.[ar[0]]?.[acol];
      if (!(acol in a)) {
        push({ type: 'MISSING', key, column: col, expected: rawString(e[col]), message: `column "${acol}" absent in ${actual.name}`, expectedProvenance: ep });
        continue;
      }
      if (!(col in e)) {
        push({ type: 'EXTRA', key, column: col, actual: rawString(a[acol]), message: `column "${col}" absent in ${expected.name}`, actualProvenance: ap });
        continue;
      }
      fieldsCompared++;
      const c = compareValues(e[col], a[acol], {
        ...nopts(col),
        actualLocale: rules.actualLocale,
        tolerance: rules.tolerances?.[col] ?? rules.tolerances?.['*'],
        fuzzy: rules.fuzzy?.[col] ?? rules.fuzzy?.['*'],
      });
      const f: ReconFinding = {
        type: c.type,
        key,
        column: col,
        expected: rawString(e[col]),
        actual: rawString(a[acol]),
        expectedNormalized: formatNormalized(c.expectedNormalized),
        actualNormalized: formatNormalized(c.actualNormalized),
        message: c.message,
      };
      if (c.delta !== undefined) f.delta = c.delta;
      if (c.similarity !== undefined) f.similarity = c.similarity;
      if (ep) f.expectedProvenance = ep;
      if (ap) f.actualProvenance = ap;
      push(f);
    }
  }

  // Coverage gate: nothing passes on empty input.
  const coverageProblems: string[] = [];
  if (expected.rows.length === 0) coverageProblems.push(`${expected.name} has no rows`);
  if (actual.rows.length === 0) coverageProblems.push(`${actual.name} has no rows`);
  if (columns.length === 0) coverageProblems.push('no columns to compare (check fieldMap/columns)');
  if (matchedRows === 0) coverageProblems.push('no rows could be joined by key');
  if (fieldsCompared === 0) coverageProblems.push('zero fields compared');
  gates.unshift({
    name: 'coverage',
    passed: coverageProblems.length === 0,
    message: coverageProblems.length ? coverageProblems.join('; ') : `${matchedRows} row(s), ${fieldsCompared} field(s) compared`,
    details: { rowsCompared: matchedRows, fieldsCompared, columns: columns.length },
  });

  for (const rule of rules.footing ?? []) {
    const side = rule.side ?? 'actual';
    const set = side === 'actual' ? actual : expected;
    const col = side === 'actual' ? map(rule.column) : rule.column;
    gates.push(checkFooting(set.rows, col, rule.printedTotal, { tolerance: rule.tolerance, locale: side === 'actual' ? (rules.actualLocale ?? rules.locale) : rules.locale, name: rule.name ?? `footing:${side}.${rule.column}` }));
  }
  for (const rule of rules.checksum ?? []) {
    const se = checkSum(expected.rows, rule.column, rules.locale);
    const sa = checkSum(actual.rows, map(rule.column), rules.actualLocale ?? rules.locale);
    const tol = rule.tolerance ?? 0.005;
    const delta = Math.round((sa.sum - se.sum) * 1e6) / 1e6;
    const passed = se.n > 0 && sa.n > 0 && Math.abs(delta) <= tol && expected.rows.length === actual.rows.length;
    gates.push({
      name: `checksum:${rule.column}`,
      passed,
      message: passed
        ? `control totals and row counts agree`
        : se.n === 0 || sa.n === 0
          ? 'no numeric values to checksum (empty extraction)'
          : expected.rows.length !== actual.rows.length
            ? 'row counts differ'
            : 'control totals differ',
      details: { expectedSum: se.sum, actualSum: sa.sum, delta, expectedRows: expected.rows.length, actualRows: actual.rows.length },
    });
  }

  const sorted = sortFindings(findings);
  const counts = Object.fromEntries(FINDING_TYPES.map((t) => [t, 0])) as Record<FindingType, number>;
  for (const f of sorted) counts[f.type]++;
  const failed = sorted.some((f) => FAILING_TYPES.has(f.type)) || gates.some((g) => !g.passed);
  return {
    kind: 'reconciliation',
    expectedName: expected.name,
    actualName: actual.name,
    status: failed ? 'FAIL' : 'PASS',
    summary: {
      expectedRows: expected.rows.length,
      actualRows: actual.rows.length,
      matchedRows,
      fieldsCompared,
      columns,
      skippedColumns,
      counts,
    },
    gates,
    findings: sorted,
  };
}

function checkSum(rows: ReadonlyArray<Record<string, unknown>>, column: string, locale?: NumberLocale): { sum: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const v = normalizeValue(r[column], { type: 'number', locale });
    if (v.kind === 'number') {
      sum += v.value as number;
      n++;
    }
  }
  return { sum: Math.round(sum * 1e6) / 1e6, n };
}
