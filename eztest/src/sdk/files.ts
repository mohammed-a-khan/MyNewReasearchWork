/**
 * `files`: CSV, XLSX, JSON, text and PDF files, and downloads as rows.
 * Paths are relative to the project (RunOptions.baseDir). Every call is a
 * reported step; files written are kept as evidence.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { callSite } from './callsite.js';
import { currentHost, frame } from './runtime.js';
import type { Download } from './ui.js';
import type { Row } from './types.js';

export interface PdfText {
  /** Whole text, one line per text line, pages separated by a form feed. */
  text: string;
  /** Text of each page. */
  pages: string[];
  /** Form fields / key-values found, by name. */
  fields: Record<string, string>;
  sha256: string;
}

type PathLike = string | Download;

function abs(p: PathLike): string {
  const host = currentHost('files');
  const raw = typeof p === 'string' ? p : p.path;
  return isAbsolute(raw) ? raw : resolve(host.baseDir, raw);
}

function label(p: PathLike): string {
  return typeof p === 'string' ? p : p.filename;
}

function rec<T>(intent: string, fn: (r: import('./runtime.js').LocalRecorder) => Promise<T>): Promise<T> {
  const f = frame('files');
  const source = callSite();
  return f.host.record(intent, fn, { ...(source ? { source } : {}) });
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV text (columns from the first row unless given). */
export function toCsv(rows: Row[], columns?: string[], delimiter = ','): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const line = (vals: unknown[]) => vals.map(csvCell).join(delimiter);
  return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n') + '\n';
}

async function readRows(path: string, o: { sheet?: string | number; delimiter?: string } = {}): Promise<Array<Record<string, string>>> {
  const ext = extname(path).toLowerCase();
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    const { parseCsv } = await import('../docs/csv.js');
    return parseCsv(await readFile(path, 'utf8'), { delimiter: o.delimiter ?? (ext === '.tsv' ? '\t' : ','), relaxColumnCount: true }).rows;
  }
  if (ext === '.xlsx') {
    const { readXlsx } = await import('../importers/xlsx.js');
    return readXlsx(path, o.sheet !== undefined ? { sheet: o.sheet } : {});
  }
  if (ext === '.json') {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(v)) throw new TypeError(`${basename(path)}: expected a JSON array of rows`);
    return v as Array<Record<string, string>>;
  }
  throw new TypeError(`Cannot read rows from "${basename(path)}" (use .csv, .tsv, .xlsx or .json)`);
}

export const files = {
  /** Absolute path of a project-relative path. */
  path(p: string): string {
    return abs(p);
  },
  exists(p: string): boolean {
    return existsSync(abs(p));
  },
  /** Rows of a CSV/TSV, XLSX (first or named sheet) or JSON file, or of a download. Values are strings (CSV/XLSX). */
  rows(p: PathLike, o: { sheet?: string | number; delimiter?: string } = {}): Promise<Array<Record<string, string>>> {
    return rec(`Read rows from ${label(p)}${o.sheet !== undefined ? ` sheet ${String(o.sheet)}` : ''}`, async (r) => {
      const rows = await readRows(abs(p), o);
      r.capture('rows', rows.length);
      return rows;
    });
  },
  readCsv(p: PathLike, o: { delimiter?: string } = {}): Promise<Array<Record<string, string>>> {
    return files.rows(p, o);
  },
  readXlsx(p: PathLike, o: { sheet?: string | number } = {}): Promise<Array<Record<string, string>>> {
    return files.rows(p, o);
  },
  readJson<T = unknown>(p: PathLike): Promise<T> {
    return rec(`Read JSON ${label(p)}`, async () => JSON.parse(await readFile(abs(p), 'utf8')) as T);
  },
  readText(p: PathLike): Promise<string> {
    return rec(`Read text ${label(p)}`, async () => readFile(abs(p), 'utf8'));
  },
  /** Text, pages and fields of a PDF (text layer). */
  readPdf(p: PathLike): Promise<PdfText> {
    return rec(`Read PDF ${label(p)}`, async (r) => {
      const { extractPdf } = await import('../docs/extract.js');
      const { documentText } = await import('../docs/model.js');
      const doc = await extractPdf(abs(p));
      const pages = doc.pages.map((pg) => pg.lines.map((l) => l.text).join('\n'));
      const fields = Object.fromEntries(doc.fields.map((f) => [f.name, String(f.value ?? '')]));
      r.capture('pages', pages.length);
      return { text: documentText(doc), pages, fields, sha256: doc.sha256 };
    });
  },
  writeText(p: string, text: string): Promise<string> {
    return rec(`Write ${p}`, async (r) => {
      const out = abs(p);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, text);
      r.evidence(await currentHost().evidence('data', basename(out), text, `file written by code: ${p}`));
      return out;
    });
  },
  writeJson(p: string, value: unknown): Promise<string> {
    return files.writeText(p, JSON.stringify(value, null, 2) + '\n');
  },
  writeCsv(p: string, rows: Row[], o: { columns?: string[]; delimiter?: string } = {}): Promise<string> {
    return files.writeText(p, toCsv(rows, o.columns, o.delimiter));
  },
  /** Write rows to an .xlsx sheet (columns from the rows unless given). */
  writeXlsx(p: string, rows: Row[], o: { sheet?: string; columns?: string[] } = {}): Promise<string> {
    return rec(`Write ${p}${o.sheet ? ` sheet ${o.sheet}` : ''} (${rows.length} rows)`, async (r) => {
      const { default: ExcelJS } = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(o.sheet ?? 'Sheet1');
      const cols = o.columns ?? [...new Set(rows.flatMap((x) => Object.keys(x)))];
      ws.addRow(cols);
      for (const row of rows) ws.addRow(cols.map((c) => {
        const v = row[c];
        return v === undefined || v === null ? null : v instanceof Date || typeof v === 'number' || typeof v === 'boolean' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }));
      const out = abs(p);
      await mkdir(dirname(out), { recursive: true });
      const buf = new Uint8Array(await wb.xlsx.writeBuffer());
      await writeFile(out, buf);
      r.evidence(await currentHost().evidence('data', basename(out), buf, `workbook written by code: ${p}`));
      return out;
    });
  },
};

export type FilesSurface = typeof files;
