/**
 * Manual test cases from spreadsheets (CSV or Excel). Rows are grouped into
 * test cases by ID (a blank ID continues the previous case); every Step line
 * goes through the EZ grammar and every Expected Result line becomes a
 * post-condition of the step before it. Anything the grammar cannot read is
 * kept as a TODO.
 */
import { slugify } from '../core/index.js';
import { JourneyDraft, oneLine } from './builder.js';
import { assembleReport } from './report.js';
import type { ImportReport, ImporterOptions } from './types.js';
import { readXlsxTable, type MergePosition, type ReadXlsxOptions } from './xlsx.js';

export interface ManualColumns {
  id?: string | string[];
  title?: string | string[];
  step?: string | string[];
  expected?: string | string[];
  tags?: string | string[];
  priority?: string | string[];
  precondition?: string | string[];
}

export interface ManualOptions extends ImporterOptions {
  /** Column names (case/space-insensitive); each accepts one name or several aliases. */
  columns?: ManualColumns;
  /** manual: keep the cases as manual test cases (`Manual:` steps); hybrid: automate what the grammar reads, keep the rest manual. */
  manualMode?: 'automated' | 'manual' | 'hybrid';
}

export interface ManualRow {
  /** 1-based source line / row number. */
  line: number;
  values: Record<string, string>;
  /** Merge positions per column (Excel only). */
  merged?: Record<string, MergePosition>;
}

export const DEFAULT_MANUAL_COLUMNS: Required<{ [K in keyof ManualColumns]: string[] }> = {
  id: ['ID', 'Test Case ID', 'TC ID', 'Case ID', 'Test ID', 'TC'],
  title: ['Title', 'Test Case', 'Test Case Title', 'Name', 'Summary', 'Scenario'],
  step: ['Step', 'Steps', 'Action', 'Step Action', 'Test Step', 'Test Steps'],
  expected: ['Expected Result', 'Expected Results', 'Expected', 'Expected Outcome', 'Expected Behaviour', 'Expected Behavior'],
  tags: ['Tags', 'Labels', 'Tag'],
  priority: ['Priority'],
  precondition: ['Precondition', 'Preconditions', 'Pre-condition', 'Prerequisites'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveColumns(headers: string[], cfg: ManualColumns = {}): Partial<Record<keyof ManualColumns, string>> {
  const out: Partial<Record<keyof ManualColumns, string>> = {};
  for (const key of Object.keys(DEFAULT_MANUAL_COLUMNS) as Array<keyof ManualColumns>) {
    const given = cfg[key];
    const names = given === undefined ? DEFAULT_MANUAL_COLUMNS[key] : Array.isArray(given) ? given : [given];
    const hit = names.map(norm).map((n) => headers.find((h) => norm(h) === n)).find(Boolean);
    if (hit) out[key] = hit;
    else if (given !== undefined) throw new Error(`Manual import: column ${JSON.stringify(given)} (${key}) not found; headers are ${headers.join(', ')}`);
  }
  return out;
}

const PRIORITY_RISK: Record<string, number> = {
  '1': 5, critical: 5, blocker: 5, p0: 5, p1: 4, '2': 4, high: 4, '3': 3, medium: 3, normal: 3, p2: 3, '4': 2, low: 2, p3: 2, '5': 1, trivial: 1, p4: 1,
};

/** Split a cell into lines, dropping list numbering ("1.", "2)", "-"). */
function cellLines(s: string): string[] {
  return s.split(/\r?\n/).map((l) => l.replace(/^\s*(?:(?:step\s*)?\d+\s*[.):-]|[-*•])\s*/i, '').trim()).filter(Boolean);
}

/** Import manual test cases from already-read rows. */
export function importManualRows(rows: ManualRow[], opts: ManualOptions & { kind?: 'manual-csv' | 'manual-xlsx' } = {}): ImportReport {
  const file = opts.file ?? 'manual-tests';
  const kind = opts.kind ?? 'manual-csv';
  const ids = opts.ids ?? new Set<string>();
  const warnings: string[] = [];
  const headers = rows.length ? Object.keys(rows[0].values) : [];
  const col = resolveColumns(headers, opts.columns);
  if (!col.step) {
    return assembleReport([], [file], [`${file}: no Step column found (headers: ${headers.join(', ') || 'none'})`]);
  }
  interface Case { id: string; title: string; rows: ManualRow[]; line: number }
  const cases: Case[] = [];
  let cur: Case | undefined;
  for (const r of rows) {
    const id = col.id ? r.values[col.id]?.trim() ?? '' : '';
    const title = col.title ? r.values[col.title]?.trim() ?? '' : '';
    const startsNew = col.id ? id !== '' && id !== cur?.id : title !== '' && title !== cur?.title;
    if (startsNew || !cur) {
      cur = { id, title, rows: [], line: r.line };
      cases.push(cur);
    }
    if (!cur.title && title) cur.title = title;
    cur.rows.push(r);
  }
  const drafts: JourneyDraft[] = [];
  for (const c of cases) {
    const first = c.rows[0].values;
    const name = c.title || (c.id ? `Test case ${c.id}` : `Test case at row ${c.line}`);
    const tags = [...(opts.tags ?? [])];
    if (col.tags) tags.push(...c.rows.flatMap((r) => (r.values[col.tags!] ?? '').split(/[,;\s]+/)).filter(Boolean));
    let risk: number | undefined;
    const prio = col.priority ? first[col.priority]?.trim() : '';
    if (prio) {
      tags.push(`priority-${slugify(prio)}`);
      risk = PRIORITY_RISK[prio.toLowerCase()];
    }
    const pre = col.precondition ? oneLine(first[col.precondition] ?? '') : '';
    const keepManual = opts.manualMode === 'manual' || opts.manualMode === 'hybrid';
    const d = new JourneyDraft(name, {
      kind, file, line: c.line, ids, tags, ...(c.id ? { id: slugify(c.id) } : {}),
      ...(pre ? (keepManual ? { headers: [`Preconditions: ${pre}`] } : { description: `Precondition: ${pre}` }) : {}), ...(risk ? { risk } : {}),
      ...(opts.manualMode ? { manualMode: opts.manualMode } : {}),
    });
    for (const r of c.rows) {
      for (const line of cellLines(r.values[col.step] ?? '')) {
        try {
          d.english(line, { line: r.line, original: line });
        } catch (e) {
          d.addTodo({ line: r.line, original: line }, `conversion error: ${(e as Error).message}`);
        }
      }
      if (!col.expected) continue;
      const pos = r.merged?.[col.expected];
      if (pos === 'first' || pos === 'middle') continue; // a merged expected result applies after the last step it spans
      for (const line of cellLines(r.values[col.expected] ?? '')) {
        const body = line.replace(/^(?:verify|expect|check|ensure|confirm)\s+(?:that\s+)?/i, '');
        d.expect(body, { line: r.line, original: line });
      }
    }
    drafts.push(d);
  }
  if (!cases.length) warnings.push(`${file}: no test cases found`);
  return assembleReport(drafts, [file], warnings);
}

/** Parse CSV text (RFC 4180: quotes, doubled quotes, embedded newlines; delimiter , ; or tab auto-detected). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/, 1)[0] ?? '';
  const delim = delimiter ?? ([',', ';', '\t'].map((dl) => [dl, firstLine.split(dl).length] as const).sort((a, b) => b[1] - a[1])[0][0]);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (inQ) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Import manual test cases from CSV text. */
export function importManualCsv(text: string, opts: ManualOptions = {}): ImportReport {
  const file = opts.file ?? 'manual-tests.csv';
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (e) {
    return assembleReport([], [file], [], [{ file, line: 1, original: oneLine(text.slice(0, 120)), reason: (e as Error).message }]);
  }
  // Track physical line numbers (quoted fields may span lines).
  const [header, ...body] = table;
  if (!header) return assembleReport([], [file], [`${file}: empty CSV`]);
  const headers = header.map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows: ManualRow[] = [];
  let line = 2 + (header.join(',').match(/\n/g)?.length ?? 0);
  for (const r of body) {
    const values: Record<string, string> = {};
    headers.forEach((h, i) => (values[h] = r[i] ?? ''));
    if (Object.values(values).some((v) => v.trim())) rows.push({ line, values });
    line += 1 + r.reduce((n, f) => n + (f.match(/\n/g)?.length ?? 0), 0);
  }
  return importManualRows(rows, { ...opts, file, kind: 'manual-csv' });
}

/** Import manual test cases from an .xlsx workbook (path or bytes). Merged Expected Result cells apply once, after the last merged row. */
export async function importManualXlsx(input: string | Uint8Array | ArrayBuffer, opts: ManualOptions & ReadXlsxOptions = {}): Promise<ImportReport> {
  const file = opts.file ?? (typeof input === 'string' ? input : 'manual-tests.xlsx');
  const table = await readXlsxTable(input, opts);
  const rows: ManualRow[] = table.rows.map((r) => ({ line: r.rowNumber, values: r.values, merged: r.merged }));
  return importManualRows(rows, { ...opts, file, kind: 'manual-xlsx' });
}
