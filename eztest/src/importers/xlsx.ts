/**
 * Excel (.xlsx) reading via exceljs. `readXlsx` returns one record per data
 * row keyed by the header row, with every value as a string: rich text is
 * flattened, formulas give their cached result, dates become ISO dates, and
 * merged cells repeat the master value. Reusable by the docs module.
 */
import ExcelJS from 'exceljs';

export interface ReadXlsxOptions {
  /** Worksheet name or 1-based index. Default: the first worksheet. */
  sheet?: string | number;
  /** 1-based header row. Default: the first non-empty row. */
  headerRow?: number;
}

/** Position of a cell inside a vertical merge (absent when the cell is not merged). */
export type MergePosition = 'first' | 'middle' | 'last' | 'single';

export interface XlsxRow {
  /** 1-based worksheet row number. */
  rowNumber: number;
  values: Record<string, string>;
  /** Per column: where this row sits in a merged range. */
  merged: Record<string, MergePosition>;
}

export interface XlsxTable {
  sheet: string;
  headers: string[];
  rows: XlsxRow[];
}

/** Flatten an exceljs cell value to text. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
    if ('formula' in o || 'sharedFormula' in o) return cellText(o.result);
    if ('error' in o) return String(o.error);
    if ('text' in o) return cellText(o.text);
    if ('hyperlink' in o) return String(o.hyperlink);
  }
  return String(v);
}

async function loadWorkbook(input: string | Uint8Array | ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (typeof input === 'string') await wb.xlsx.readFile(input);
  else {
    const buf = input instanceof ArrayBuffer ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  }
  return wb;
}

/** Read a worksheet as a header-keyed table with merge information. */
export async function readXlsxTable(input: string | Uint8Array | ArrayBuffer, opts: ReadXlsxOptions = {}): Promise<XlsxTable> {
  const wb = await loadWorkbook(input);
  const ws = typeof opts.sheet === 'string' ? wb.getWorksheet(opts.sheet) : wb.worksheets[(opts.sheet ?? 1) - 1];
  if (!ws) {
    throw new Error(`readXlsx: worksheet ${JSON.stringify(opts.sheet ?? 1)} not found (have: ${wb.worksheets.map((w) => w.name).join(', ')})`);
  }
  const width = ws.columnCount;
  const textAt = (r: number, c: number) => cellText(ws.getCell(r, c).value).trim();
  let headerRow = opts.headerRow;
  if (!headerRow) {
    for (let r = 1; r <= ws.rowCount; r++) {
      let any = false;
      for (let c = 1; c <= width; c++) if (textAt(r, c)) any = true;
      if (any) {
        headerRow = r;
        break;
      }
    }
  }
  if (!headerRow) return { sheet: ws.name, headers: [], rows: [] };
  const headers: string[] = [];
  const seen = new Map<string, number>();
  for (let c = 1; c <= width; c++) {
    let h = textAt(headerRow, c).replace(/\s+/g, ' ') || `Column ${c}`;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    if (n > 1) h = `${h} (${n})`;
    headers.push(h);
  }
  const masterOf = (r: number, c: number): string | undefined => {
    if (r < 1 || r > ws.rowCount) return undefined;
    const cell = ws.getCell(r, c);
    return cell.isMerged ? cell.master.address : undefined;
  };
  const rows: XlsxRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const values: Record<string, string> = {};
    const merged: Record<string, MergePosition> = {};
    let any = false;
    for (let c = 1; c <= width; c++) {
      const v = cellText(ws.getCell(r, c).value);
      values[headers[c - 1]] = v;
      if (v.trim()) any = true;
      const m = masterOf(r, c);
      if (m) {
        const above = masterOf(r - 1, c) === m && r - 1 > headerRow;
        const below = masterOf(r + 1, c) === m;
        merged[headers[c - 1]] = above && below ? 'middle' : above ? 'last' : below ? 'first' : 'single';
      }
    }
    if (any) rows.push({ rowNumber: r, values, merged });
  }
  return { sheet: ws.name, headers, rows };
}

/** Read a worksheet into records keyed by the header row; every value is a string. */
export async function readXlsx(input: string | Uint8Array | ArrayBuffer, opts: ReadXlsxOptions = {}): Promise<Array<Record<string, string>>> {
  return (await readXlsxTable(input, opts)).rows.map((r) => r.values);
}
