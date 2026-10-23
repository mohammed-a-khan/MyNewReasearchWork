/**
 * Three-way ledger: the same business facts as shown in the UI, printed in
 * the document and stored in the database, side by side. When two sources
 * agree and one differs, the odd one out points at the defective layer.
 */
import { EzTestError } from '../core/index.js';
import type { CanonicalDocument, ValueType } from './model.js';
import { formatNormalized } from './normalize.js';
import { compareValues, footingFromTable, reconcile, type GateResult, type ReconciliationReport, type Tolerance } from './reconcile.js';
import { fromDbRows, fromPdfTable, type RecordValue } from './sources.js';
import type { NumberLocale } from './normalize.js';

export type LedgerSource = 'ui' | 'pdf' | 'db';
export const LEDGER_SOURCES: LedgerSource[] = ['ui', 'pdf', 'db'];

/** Where a source keeps a field: its key, optionally with a regex whose group 1 (or "value") is the value. */
export type SourceRef = string | { key: string; pattern?: string };

export interface ThreeWayFieldMapping {
  /** Canonical field name, e.g. "total". */
  name: string;
  ui?: SourceRef;
  /** Name of an extracted document field (doc.fields). */
  pdf?: SourceRef;
  db?: SourceRef;
  type?: ValueType;
  tolerance?: Tolerance;
  fuzzy?: number;
}

export interface ThreeWayMapping {
  fields: ThreeWayFieldMapping[];
  /** Line items: document table vs DB rows. */
  lines?: {
    pdfTable: string;
    dbRows: ReadonlyArray<Record<string, unknown>>;
    /** Canonical (document) key column(s). */
    key: string | string[];
    /** document column -> DB column */
    fieldMap: Record<string, string>;
    types?: Record<string, ValueType>;
    tolerances?: Record<string, Tolerance>;
  };
  /** Footing of the document table: sum of `column` must equal the printed total row. */
  footing?: { pdfTable: string; column: string; tolerance?: number };
  locale?: NumberLocale;
  dateFormats?: string[];
}

export interface ThreeWayInputs {
  ui?: Record<string, string | number | null | undefined>;
  pdf?: CanonicalDocument;
  db?: Record<string, unknown>;
}

export type ThreeWayVerdict = 'ALL_AGREE' | 'ODD_ONE_OUT' | 'ALL_DISAGREE' | 'DISAGREE' | 'INSUFFICIENT_DATA';

export interface ThreeWayValue {
  raw?: string;
  normalized?: string;
  page?: number;
  /** Why the value is absent (source not given, key not found, pattern did not match). */
  note?: string;
}

export interface ThreeWayFieldResult {
  name: string;
  values: Record<LedgerSource, ThreeWayValue>;
  verdict: ThreeWayVerdict;
  oddOneOut?: LedgerSource;
  /** Human diagnosis without business values. */
  diagnosis: string;
}

export interface ThreeWayReport {
  kind: 'three-way';
  status: 'PASS' | 'FAIL';
  fields: ThreeWayFieldResult[];
  lines?: ReconciliationReport;
  footing?: GateResult;
  /** Overall diagnoses (deduplicated, sorted). */
  diagnosis: string[];
}

const DIAGNOSIS: Record<LedgerSource, string> = {
  pdf: 'document generation defect (UI and DB agree, the document differs)',
  ui: 'UI display/binding defect (document and DB agree, the UI differs)',
  db: 'persistence defect (UI and document agree, the stored value differs)',
};

function readRef(source: Record<string, unknown> | undefined, ref: SourceRef | undefined): ThreeWayValue & { value?: unknown } {
  if (ref === undefined) return { note: 'not mapped' };
  if (!source) return { note: 'source not provided' };
  const { key, pattern } = typeof ref === 'string' ? { key: ref, pattern: undefined } : ref;
  if (!(key in source) || source[key] === undefined) return { note: `key "${key}" not found` };
  const v = source[key];
  if (!pattern) return { value: v, raw: v === null ? '' : String(v) };
  const m = new RegExp(pattern).exec(String(v ?? ''));
  if (!m) return { note: `pattern did not match` };
  const got = m.groups?.value ?? m[1] ?? m[0];
  return { value: got, raw: got };
}

/** Three-way reconciliation of UI, document and DB values. */
export function reconcileThreeWay(inputs: ThreeWayInputs, mapping: ThreeWayMapping): ThreeWayReport {
  if (mapping.fields.length === 0 && !mapping.lines) {
    throw new EzTestError('reconcileThreeWay: mapping has no fields and no lines', 'RECONCILE_INVALID');
  }
  const pdfFields: Record<string, RecordValue> | undefined = inputs.pdf
    ? Object.fromEntries(inputs.pdf.fields.map((f) => [f.name, f.value.raw]))
    : undefined;
  const pdfPages = new Map(inputs.pdf?.fields.map((f) => [f.name, f.value.page]) ?? []);
  const sources: Record<LedgerSource, Record<string, unknown> | undefined> = {
    ui: inputs.ui,
    pdf: pdfFields,
    db: inputs.db,
  };
  const results: ThreeWayFieldResult[] = [];
  for (const fm of mapping.fields) {
    const got = {} as Record<LedgerSource, ThreeWayValue & { value?: unknown }>;
    for (const s of LEDGER_SOURCES) got[s] = readRef(sources[s], fm[s]);
    if (got.pdf.raw !== undefined && typeof fm.pdf !== 'undefined') {
      const k = typeof fm.pdf === 'string' ? fm.pdf : fm.pdf.key;
      const p = pdfPages.get(k);
      if (p !== undefined) got.pdf.page = p;
    }
    const present = LEDGER_SOURCES.filter((s) => got[s].raw !== undefined);
    const opts = { type: fm.type, tolerance: fm.tolerance, fuzzy: fm.fuzzy, locale: mapping.locale, dateFormats: mapping.dateFormats };
    const eq = (a: LedgerSource, b: LedgerSource) => {
      const c = compareValues(got[a].value, got[b].value, opts);
      return c.type !== 'MISMATCH';
    };
    for (const s of present) {
      const c = compareValues(got[s].value, got[s].value, opts);
      got[s].normalized = formatNormalized(c.expectedNormalized);
    }
    let verdict: ThreeWayVerdict;
    let odd: LedgerSource | undefined;
    let diagnosis = '';
    if (present.length < 2) {
      verdict = 'INSUFFICIENT_DATA';
      diagnosis = `only ${present.length} source(s) provide "${fm.name}"; at least two are needed`;
    } else if (present.length === 2) {
      const [a, b] = present;
      if (eq(a, b)) {
        verdict = 'ALL_AGREE';
        diagnosis = `${a} and ${b} agree (third source unavailable)`;
      } else {
        verdict = 'DISAGREE';
        diagnosis = `${a} and ${b} disagree; a third source is needed to tell which is wrong`;
      }
    } else {
      const ab = eq('ui', 'pdf');
      const ad = eq('ui', 'db');
      const bd = eq('pdf', 'db');
      if (ab && ad && bd) {
        verdict = 'ALL_AGREE';
        diagnosis = 'UI, document and DB agree';
      } else if (ad && !ab && !bd) {
        verdict = 'ODD_ONE_OUT';
        odd = 'pdf';
      } else if (bd && !ab && !ad) {
        verdict = 'ODD_ONE_OUT';
        odd = 'ui';
      } else if (ab && !ad && !bd) {
        verdict = 'ODD_ONE_OUT';
        odd = 'db';
      } else {
        verdict = 'ALL_DISAGREE';
      }
      if (verdict !== 'ALL_AGREE') diagnosis = odd ? DIAGNOSIS[odd] : verdict === 'ALL_DISAGREE' ? 'UI, document and DB all disagree' : diagnosisOr(verdict);
    }
    const values = {} as Record<LedgerSource, ThreeWayValue>;
    for (const s of LEDGER_SOURCES) {
      const { value: _v, ...rest } = got[s];
      values[s] = rest;
    }
    const r: ThreeWayFieldResult = { name: fm.name, values, verdict, diagnosis };
    if (odd) r.oddOneOut = odd;
    results.push(r);
  }

  let lines: ReconciliationReport | undefined;
  if (mapping.lines) {
    if (!inputs.pdf) throw new EzTestError('reconcileThreeWay: lines mapping needs inputs.pdf', 'RECONCILE_INVALID');
    lines = reconcile(fromPdfTable(inputs.pdf, mapping.lines.pdfTable), fromDbRows(mapping.lines.dbRows), {
      key: mapping.lines.key,
      fieldMap: mapping.lines.fieldMap,
      columns: Object.keys(mapping.lines.fieldMap).filter((c) => !(Array.isArray(mapping.lines!.key) ? mapping.lines!.key : [mapping.lines!.key]).includes(c)),
      types: mapping.lines.types,
      tolerances: mapping.lines.tolerances,
      locale: mapping.locale,
      dateFormats: mapping.dateFormats,
      expectedName: 'pdf',
      actualName: 'db',
    });
  }
  let footing: GateResult | undefined;
  if (mapping.footing) {
    if (!inputs.pdf) throw new EzTestError('reconcileThreeWay: footing needs inputs.pdf', 'RECONCILE_INVALID');
    const t = inputs.pdf.tables.find((x) => x.name === mapping.footing!.pdfTable);
    footing = t
      ? footingFromTable(t, mapping.footing.column, { tolerance: mapping.footing.tolerance, locale: mapping.locale })
      : { name: `footing:${mapping.footing.pdfTable}`, passed: false, message: `table "${mapping.footing.pdfTable}" was not extracted` };
  }

  const diag = new Set<string>();
  for (const r of results) if (r.oddOneOut) diag.add(`${r.name}: ${r.diagnosis}`);
  for (const r of results) if (r.verdict === 'ALL_DISAGREE' || r.verdict === 'DISAGREE') diag.add(`${r.name}: ${r.diagnosis}`);
  if (lines && lines.status === 'FAIL') diag.add('line items: document table and DB rows do not reconcile');
  if (footing && !footing.passed) diag.add(`footing: ${footing.message}`);
  const comparable = results.filter((r) => r.verdict !== 'INSUFFICIENT_DATA').length;
  if (comparable === 0 && !lines) diag.add('no field could be compared across at least two sources');
  const failed =
    comparable === 0 && !lines ||
    results.some((r) => r.verdict !== 'ALL_AGREE') ||
    (lines !== undefined && lines.status === 'FAIL') ||
    (footing !== undefined && !footing.passed);
  return {
    kind: 'three-way',
    status: failed ? 'FAIL' : 'PASS',
    fields: results,
    ...(lines ? { lines } : {}),
    ...(footing ? { footing } : {}),
    diagnosis: [...diag].sort(),
  };
}

function diagnosisOr(v: ThreeWayVerdict): string {
  return v === 'ALL_DISAGREE' ? 'all sources disagree' : 'inconclusive';
}
