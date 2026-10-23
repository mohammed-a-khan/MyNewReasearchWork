/**
 * Record sources for reconciliation. Every source becomes a RecordSet: a list
 * of flat rows plus optional per-cell provenance (page + bbox for documents).
 */
import { readFile } from 'node:fs/promises';
import { EzTestError, NotSupportedError } from '../core/index.js';
import type { BBox, CanonicalDocument } from './model.js';
import { readXlsx } from '../importers/xlsx.js';
import { parseCsv, type CsvOptions } from './csv.js';

export type SourceKind = 'pdf' | 'db' | 'csv' | 'json' | 'ui' | 'records' | 'xlsx';

export interface CellProvenance {
  page?: number;
  bbox?: BBox;
  confidence?: number;
}

export type RecordValue = string | number | boolean | null | undefined;

export interface RecordSet {
  name: string;
  kind: SourceKind;
  rows: Array<Record<string, RecordValue>>;
  /** Same index as rows; column -> provenance. */
  provenance?: Array<Record<string, CellProvenance>>;
}

function flatValue(v: unknown): RecordValue {
  if (v === null || v === undefined) return v as null | undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/** Rows of a table extracted from a document (data rows only unless includeTotals). */
export function fromPdfTable(doc: CanonicalDocument, tableName: string, opts: { includeTotals?: boolean } = {}): RecordSet {
  const t = doc.tables.find((x) => x.name === tableName);
  if (!t) {
    throw new EzTestError(`Document ${doc.source} has no extracted table "${tableName}" (apply a template first)`, 'TABLE_NOT_EXTRACTED');
  }
  const rows: Array<Record<string, RecordValue>> = [];
  const provenance: Array<Record<string, CellProvenance>> = [];
  for (const r of t.rows) {
    if (r.kind !== 'data' && !opts.includeTotals) continue;
    const row: Record<string, RecordValue> = {};
    const prov: Record<string, CellProvenance> = {};
    for (const c of t.columns) {
      const cell = r.cells[c];
      row[c] = cell ? cell.raw : null;
      if (cell) prov[c] = { page: cell.page, bbox: cell.bbox, confidence: cell.confidence };
    }
    rows.push(row);
    provenance.push(prov);
  }
  return { name: `${doc.source}#${tableName}`, kind: 'pdf', rows, provenance };
}

/** Extracted fields of a document as a single record. */
export function fromPdfFields(doc: CanonicalDocument): RecordSet {
  const row: Record<string, RecordValue> = {};
  const prov: Record<string, CellProvenance> = {};
  for (const f of doc.fields) {
    row[f.name] = f.value.raw;
    prov[f.name] = { page: f.value.page, bbox: f.value.bbox, confidence: f.value.confidence };
  }
  return { name: `${doc.source}#fields`, kind: 'pdf', rows: [row], provenance: [prov] };
}

/** Rows returned by a DB query the caller ran (e.g. `db.prepare(sql).all()`). */
export function fromDbRows(rows: ReadonlyArray<Record<string, unknown>>, name = 'db'): RecordSet {
  return { name, kind: 'db', rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, flatValue(v)]))) };
}

export function fromCsv(text: string, opts: CsvOptions & { name?: string } = {}): RecordSet {
  const t = parseCsv(text, opts);
  return { name: opts.name ?? 'csv', kind: 'csv', rows: t.rows };
}

/**
 * JSON array of objects (or an object whose `path`, e.g. "data.items", is such an array).
 * Nested objects are flattened with dotted keys ("customer.name").
 */
export function fromJson(input: string | unknown, opts: { path?: string; name?: string } = {}): RecordSet {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new EzTestError(`Invalid JSON: ${(e as Error).message}`, 'JSON_INVALID');
    }
  }
  if (opts.path) {
    for (const part of opts.path.split('.')) {
      if (data && typeof data === 'object' && part in (data as Record<string, unknown>)) data = (data as Record<string, unknown>)[part];
      else throw new EzTestError(`JSON path "${opts.path}" not found`, 'JSON_PATH_NOT_FOUND');
    }
  }
  if (!Array.isArray(data)) throw new EzTestError('JSON source must be an array of objects', 'JSON_NOT_ARRAY');
  const rows = data.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EzTestError(`JSON element ${i} is not an object`, 'JSON_NOT_OBJECT');
    }
    const flat: Record<string, RecordValue> = {};
    const walk = (o: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(o)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) walk(v as Record<string, unknown>, key);
        else flat[key] = flatValue(v);
      }
    };
    walk(item as Record<string, unknown>, '');
    return flat;
  });
  return { name: opts.name ?? 'json', kind: 'json', rows };
}

/** Values captured from the UI (a ledger such as { "order-total": "19.99" }) as a single record. */
export function fromUiLedger(ledger: Record<string, string | number | null | undefined>, name = 'ui'): RecordSet {
  return { name, kind: 'ui', rows: [Object.fromEntries(Object.entries(ledger).map(([k, v]) => [k, flatValue(v)]))] };
}

export function fromRecords(rows: Array<Record<string, unknown>>, name = 'records'): RecordSet {
  return { name, kind: 'records', rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, flatValue(v)]))) };
}

/** Excel workbook (first sheet unless `sheet` is given); header row becomes column names. */
export async function fromXlsx(input: Uint8Array | string, opts: { sheet?: string; name?: string } = {}): Promise<RecordSet> {
  const rows = await readXlsx(input, { sheet: opts.sheet });
  if (!rows.length) throw new EzTestError('XLSX source has no data rows', 'SOURCE_EMPTY');
  return { name: opts.name ?? (typeof input === 'string' ? input : 'xlsx'), kind: 'xlsx', rows };
}

export type SourceSpec =
  | { type: 'csv'; path?: string; text?: string; options?: CsvOptions; name?: string }
  | { type: 'json'; path?: string; text?: string; jsonPath?: string; name?: string }
  | { type: 'db'; rows: Array<Record<string, unknown>>; name?: string }
  | { type: 'ui'; ledger: Record<string, string>; name?: string }
  | { type: 'xlsx'; path: string; sheet?: string; name?: string };

/** Load a source from a declarative spec (files are read from disk). */
export async function loadSource(spec: SourceSpec): Promise<RecordSet> {
  switch (spec.type) {
    case 'csv': {
      const text = spec.text ?? (spec.path ? await readFile(spec.path, 'utf8') : undefined);
      if (text === undefined) throw new EzTestError('CSV source needs "path" or "text"', 'SOURCE_INVALID');
      return fromCsv(text, { ...spec.options, name: spec.name ?? spec.path });
    }
    case 'json': {
      const text = spec.text ?? (spec.path ? await readFile(spec.path, 'utf8') : undefined);
      if (text === undefined) throw new EzTestError('JSON source needs "path" or "text"', 'SOURCE_INVALID');
      return fromJson(text, { path: spec.jsonPath, name: spec.name ?? spec.path });
    }
    case 'db':
      return fromDbRows(spec.rows, spec.name);
    case 'ui':
      return fromUiLedger(spec.ledger, spec.name);
    case 'xlsx':
      return fromXlsx(spec.path, { sheet: spec.sheet, name: spec.name });
    default:
      throw new NotSupportedError(`source type ${JSON.stringify((spec as { type: string }).type)}`);
  }
}
