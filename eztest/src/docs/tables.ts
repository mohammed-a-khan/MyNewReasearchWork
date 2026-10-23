/**
 * Table extraction from positioned text.
 *
 *  1. find the header row by expected column names (fuzzy, case-insensitive),
 *  2. derive column x-bands from the header positions,
 *  3. assign every text item below to the band it overlaps most,
 *  4. stitch wrapped cells (lines with no anchor-column value) into the previous row,
 *  5. continue on following pages after a repeated header,
 *  6. tag total/subtotal rows and stop at a terminator, a grand total or a large gap.
 */
import type { BBox, CanonicalDocument, DocFinding, DocTable, Line, TableCell, TableRow, TextItem, ValueType } from './model.js';
import { unionBBox } from './model.js';
import { foldText, similarity, type NumberLocale } from './normalize.js';
import { makeValue } from './fields.js';
import { compileUserRegex, TableSpecSchema, type TableSpec, type TableSpecInput } from './template.js';

export interface TableContext {
  locale?: NumberLocale;
  dateFormats?: string[];
}

interface ColumnDef {
  name: string;
  aliases: string[];
  type: ValueType;
  required: boolean;
}

interface HeaderHit {
  line: Line;
  /** Column name -> header bbox, only for matched columns. */
  boxes: Map<string, BBox>;
}

function columnsOf(spec: TableSpec): ColumnDef[] {
  return spec.columns.map((c) =>
    typeof c === 'string'
      ? { name: c, aliases: [c], type: 'text' as ValueType, required: true }
      : {
          name: c.name,
          aliases: c.header === undefined ? [c.name] : Array.isArray(c.header) ? c.header : [c.header],
          type: c.type,
          required: c.required,
        },
  );
}

function joinText(items: TextItem[]): string {
  let out = '';
  let prev: TextItem | undefined;
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (prev) {
      const sameLine = Math.abs(prev.baseline - it.baseline) < 0.5 * it.fontSize;
      const gap = it.x - (prev.x + prev.width);
      if (!sameLine || gap > 0.15 * it.fontSize) out += ' ';
    }
    out += it.text;
    prev = it;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Try to read a line as the table header. */
function matchHeader(line: Line, cols: ColumnDef[], spec: TableSpec): HeaderHit | undefined {
  // Candidate phrases: every run of up to 4 consecutive items inside a segment.
  const cands: Array<{ text: string; bbox: BBox; from: number; to: number }> = [];
  let base = 0;
  for (const seg of line.segments) {
    const its = seg.items;
    for (let i = 0; i < its.length; i++) {
      for (let j = i; j < Math.min(its.length, i + 4); j++) {
        const run = its.slice(i, j + 1);
        cands.push({ text: joinText(run), bbox: unionBBox(run), from: base + i, to: base + j });
      }
    }
    base += its.length;
  }
  const scored: Array<{ col: ColumnDef; cand: (typeof cands)[number]; score: number }> = [];
  for (const col of cols) {
    for (const cand of cands) {
      const t = foldText(cand.text).replace(/\s*:$/, '');
      let best = 0;
      for (const a of col.aliases) best = Math.max(best, t === foldText(a) ? 1 : similarity(t, a));
      if (best >= spec.headerThreshold) scored.push({ col, cand, score: best });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.cand.from - b.cand.from);
  const used = new Set<number>();
  const boxes = new Map<string, BBox>();
  for (const s of scored) {
    if (boxes.has(s.col.name)) continue;
    let clash = false;
    for (let k = s.cand.from; k <= s.cand.to; k++) if (used.has(k)) clash = true;
    if (clash) continue;
    for (let k = s.cand.from; k <= s.cand.to; k++) used.add(k);
    boxes.set(s.col.name, s.cand.bbox);
  }
  const required = cols.filter((c) => c.required);
  const need = spec.minHeaderColumns ?? required.length;
  const matchedRequired = required.filter((c) => boxes.has(c.name)).length;
  if (boxes.size < Math.max(need, 1) || (spec.minHeaderColumns === undefined && matchedRequired < required.length)) return undefined;
  // Header items must not be mostly unmatched prose (a sentence mentioning "Qty" is not a header).
  if (used.size < line.segments.reduce((n, s) => n + s.items.length, 0) * 0.5) return undefined;
  return { line, boxes };
}

interface Band {
  name: string;
  x0: number;
  x1: number;
}

function bandsFrom(hit: HeaderHit): Band[] {
  const cols = [...hit.boxes.entries()].sort((a, b) => a[1].x - b[1].x);
  return cols.map(([name, box], i) => {
    const prev = cols[i - 1]?.[1];
    const next = cols[i + 1]?.[1];
    return {
      name,
      x0: prev ? (prev.x + prev.width + box.x) / 2 : -Infinity,
      x1: next ? (box.x + box.width + next.x) / 2 : Infinity,
    };
  });
}

function assign(line: Line, bands: Band[]): Map<string, TextItem[]> {
  const out = new Map<string, TextItem[]>();
  for (const it of line.segments.flatMap((s) => s.items)) {
    let best: Band | undefined;
    let bestOv = -Infinity;
    const cx = it.x + it.width / 2;
    for (const b of bands) {
      const ov = Math.min(it.x + it.width, b.x1) - Math.max(it.x, b.x0);
      const contains = cx >= b.x0 && cx < b.x1;
      const score = ov + (contains ? 0.01 : 0);
      if (score > bestOv) {
        bestOv = score;
        best = b;
      }
    }
    if (!best) continue;
    const arr = out.get(best.name) ?? [];
    arr.push(it);
    out.set(best.name, arr);
  }
  return out;
}

/** Extract tables described by specs. Missing headers and empty tables are error findings, never silent. */
export function extractTables(
  doc: CanonicalDocument,
  specsIn: Array<TableSpec | TableSpecInput>,
  ctx: TableContext = {},
): { tables: DocTable[]; findings: DocFinding[] } {
  const tables: DocTable[] = [];
  const findings: DocFinding[] = [];
  for (const specIn of specsIn) {
    const spec = TableSpecSchema.parse(specIn);
    const r = extractOne(doc, spec, ctx);
    findings.push(...r.findings);
    if (r.table) tables.push(r.table);
  }
  return { tables, findings };
}

function extractOne(doc: CanonicalDocument, spec: TableSpec, ctx: TableContext): { table?: DocTable; findings: DocFinding[] } {
  const findings: DocFinding[] = [];
  const cols = columnsOf(spec);
  const colByName = new Map(cols.map((c) => [c.name, c]));
  const keyCols = spec.key === undefined ? [] : Array.isArray(spec.key) ? spec.key : [spec.key];
  for (const k of keyCols) {
    if (!colByName.has(k)) {
      findings.push({ code: 'TABLE_SPEC_INVALID', severity: 'error', message: `Table "${spec.name}": key column "${k}" is not a declared column.`, ref: spec.name });
      return { findings };
    }
  }
  const anchors = keyCols.length
    ? keyCols
    : cols.filter((c) => c.type !== 'text').map((c) => c.name).concat(cols.every((c) => c.type === 'text') ? [cols[0].name] : []);
  const terminator = spec.terminator ? compileUserRegex(spec.terminator, 'i', 'terminator') : undefined;
  const totalRe = compileUserRegex(spec.totalPattern, 'i', 'totalPattern');
  const subtotalRe = compileUserRegex(spec.subtotalPattern, 'i', 'subtotalPattern');

  // Locate the first header.
  let startPage = -1;
  let hit: HeaderHit | undefined;
  for (const page of doc.pages) {
    for (const line of page.lines) {
      hit = matchHeader(line, cols, spec);
      if (hit) break;
    }
    if (hit) {
      startPage = page.number;
      break;
    }
  }
  if (!hit) {
    if (spec.required) {
      findings.push({
        code: 'TABLE_HEADER_NOT_FOUND',
        severity: 'error',
        message: `Table "${spec.name}": header row with columns ${JSON.stringify(cols.map((c) => c.aliases[0]))} not found.`,
        ref: spec.name,
      });
    }
    return { findings };
  }
  const missingCols = cols.filter((c) => !hit!.boxes.has(c.name)).map((c) => c.name);
  if (missingCols.length) {
    findings.push({ code: 'TABLE_COLUMN_NOT_FOUND', severity: 'warning', message: `Table "${spec.name}": optional column(s) ${JSON.stringify(missingCols)} not in header.`, ref: spec.name });
  }
  const table: DocTable = {
    name: spec.name,
    columns: cols.filter((c) => hit!.boxes.has(c.name)).map((c) => c.name),
    headers: [{ page: startPage, bbox: hit.line.bbox }],
    rows: [],
    pages: [],
  };
  let bands = bandsFrom(hit);
  let stop = false;
  let current: { row: TableRow; items: Map<string, TextItem[]> } | undefined;
  const rowItems: Array<Map<string, TextItem[]>> = [];

  const finalizeCell = (row: TableRow, items: Map<string, TextItem[]>) => {
    row.cells = {};
    for (const name of table.columns) {
      const its = items.get(name);
      if (!its?.length) continue;
      const col = colByName.get(name)!;
      const raw = joinText(its);
      const v = makeValue(raw, col.type, its[0].page, unionBBox(its), 0.95, ctx);
      const cell: TableCell = { ...v, column: name };
      row.cells[name] = cell;
    }
  };

  for (const page of doc.pages) {
    if (stop) break;
    if (page.number < startPage) continue;
    let lines = page.lines;
    if (page.number === startPage) {
      lines = lines.filter((l) => l.index > hit!.line.index);
    } else {
      if (!spec.continueAcrossPages) break;
      // Continue only where the header is repeated; everything above it (page header) is skipped.
      let rep: HeaderHit | undefined;
      for (const l of page.lines) {
        rep = matchHeader(l, cols, spec);
        if (rep) break;
      }
      if (!rep) break;
      table.headers.push({ page: page.number, bbox: rep.line.bbox });
      bands = bandsFrom(rep);
      const at = rep.line.index;
      lines = lines.filter((l) => l.index > at);
    }
    let lastBottom = page.number === startPage ? hit.line.bbox.y + hit.line.bbox.height : undefined;
    if (page.number !== startPage) lastBottom = table.headers[table.headers.length - 1].bbox.y + table.headers[table.headers.length - 1].bbox.height;
    for (const line of lines) {
      const fs = Math.max(...line.segments.map((s) => s.fontSize));
      if (terminator && terminator.test(line.text)) {
        table.terminatedBy = `terminator: ${line.text}`;
        stop = true;
        break;
      }
      if (matchHeader(line, cols, spec)) {
        table.headers.push({ page: page.number, bbox: line.bbox });
        lastBottom = line.bbox.y + line.bbox.height;
        continue;
      }
      if (lastBottom !== undefined && line.bbox.y - lastBottom > spec.maxRowGapEm * fs) break;
      lastBottom = line.bbox.y + line.bbox.height;
      const cellItems = assign(line, bands);
      if (cellItems.size === 0) continue;
      const firstText = line.segments[0]?.text ?? '';
      const kind = subtotalRe.test(firstText) ? 'subtotal' : totalRe.test(firstText) ? 'total' : 'data';
      const hasAnchor = anchors.some((a) => cellItems.has(a));
      const prevGap = current ? line.bbox.y - lastRowBottom(current.items) : Infinity;
      if (
        kind === 'data' &&
        spec.stitchWrapped &&
        current &&
        current.row.kind === 'data' &&
        current.row.page === page.number &&
        !hasAnchor &&
        prevGap < 1.6 * fs
      ) {
        for (const [name, its] of cellItems) current.items.set(name, [...(current.items.get(name) ?? []), ...its]);
        current.row.lineCount += 1;
        finalizeCell(current.row, current.items);
        continue;
      }
      const row: TableRow = { index: table.rows.length, page: page.number, kind, cells: {}, lineCount: 1 };
      finalizeCell(row, cellItems);
      table.rows.push(row);
      rowItems.push(cellItems);
      current = { row, items: cellItems };
      if (!table.pages.includes(page.number)) table.pages.push(page.number);
      if (kind === 'total' && !spec.continueAfterTotal) {
        table.terminatedBy = 'total row';
        stop = true;
        break;
      }
    }
  }
  const dataRows = table.rows.filter((r) => r.kind === 'data');
  if (dataRows.length === 0) {
    findings.push({ code: 'TABLE_EMPTY', severity: 'error', message: `Table "${spec.name}": header found but no data rows were extracted.`, page: startPage, ref: spec.name });
  }
  for (const r of dataRows) {
    for (const k of keyCols) {
      if (!r.cells[k]) {
        findings.push({ code: 'TABLE_ROW_NO_KEY', severity: 'warning', message: `Table "${spec.name}" row ${r.index + 1}: key column "${k}" is empty.`, page: r.page, ref: spec.name });
      }
    }
  }
  return { table, findings };
}

function lastRowBottom(items: Map<string, TextItem[]>): number {
  let b = -Infinity;
  for (const its of items.values()) for (const it of its) b = Math.max(b, it.y + it.height);
  return b;
}

/** Data rows of a table as plain records (column -> raw text). */
export function tableRecords(table: DocTable, opts: { includeTotals?: boolean } = {}): Array<Record<string, string>> {
  return table.rows
    .filter((r) => opts.includeTotals || r.kind === 'data')
    .map((r) => Object.fromEntries(table.columns.filter((c) => r.cells[c]).map((c) => [c, r.cells[c].raw])));
}
