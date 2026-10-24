/**
 * Layout analysis on positioned text (text layer or OCR words):
 *  - ruling lines (table borders) read from the page's drawing operators;
 *  - text columns (two-column prose) detected by a vertical gutter, so lines
 *    are read column by column instead of across the gutter;
 *  - template-free table detection, from ruling-line grids and from the
 *    alignment of text segments across consecutive lines.
 * Pure geometry: no model, no service.
 */
import type { BBox, DocTable, Line, PageModel, Ruling, TableRow, TextItem } from './model.js';
import { round2, unionBBox } from './model.js';
import { normalizeValue, type NumberLocale } from './normalize.js';

// ------------------------------------------------------------------ rulings

/** pdfjs operator ids used here (subset of pdfjs OPS). */
export interface OpsIds {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
  rectangle: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
}

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Horizontal and vertical ruling lines drawn on a page: stroked lines and rectangle borders, and
 * thin filled rectangles (a common way to draw table rules). Coordinates are converted to the
 * top-left origin used by the document model.
 */
export function rulingsFromOperators(fnArray: number[], argsArray: unknown[], OPS: OpsIds, view: number[]): Ruling[] {
  const [vx0, vy0, , vy1] = view;
  const height = vy1 - vy0;
  const out: Ruling[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let pending: Array<{ x0: number; y0: number; x1: number; y1: number; rect?: boolean; w?: number; h?: number }> = [];
  const emit = (x0: number, y0: number, x1: number, y1: number) => {
    const tx0 = x0 - vx0;
    const tx1 = x1 - vx0;
    const ty0 = height - (y0 - vy0);
    const ty1 = height - (y1 - vy0);
    if (Math.abs(ty0 - ty1) <= 1 && Math.abs(tx1 - tx0) >= 6) out.push({ orientation: 'h', x: round2(Math.min(tx0, tx1)), y: round2((ty0 + ty1) / 2), length: round2(Math.abs(tx1 - tx0)) });
    else if (Math.abs(tx0 - tx1) <= 1 && Math.abs(ty1 - ty0) >= 6) out.push({ orientation: 'v', x: round2((tx0 + tx1) / 2), y: round2(Math.min(ty0, ty1)), length: round2(Math.abs(ty1 - ty0)) });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as M);
    else if (fn === OPS.constructPath) {
      const ops = args[0] as number[];
      const a = args[1] as number[];
      let j = 0;
      let cx = 0;
      let cy = 0;
      let sx = 0;
      let sy = 0;
      for (const op of ops) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = [a[j++], a[j++], a[j++], a[j++]];
          const p0 = apply(ctm, x, y);
          const p1 = apply(ctm, x + w, y + h);
          pending.push({ x0: Math.min(p0[0], p1[0]), y0: Math.min(p0[1], p1[1]), x1: Math.max(p0[0], p1[0]), y1: Math.max(p0[1], p1[1]), rect: true });
          cx = x;
          cy = y;
        } else if (op === OPS.moveTo) {
          cx = sx = a[j++];
          cy = sy = a[j++];
        } else if (op === OPS.lineTo) {
          const nx = a[j++];
          const ny = a[j++];
          const p0 = apply(ctm, cx, cy);
          const p1 = apply(ctm, nx, ny);
          pending.push({ x0: p0[0], y0: p0[1], x1: p1[0], y1: p1[1] });
          cx = nx;
          cy = ny;
        } else if (op === OPS.curveTo) {
          j += 4;
          cx = a[j++];
          cy = a[j++];
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          j += 2;
          cx = a[j++];
          cy = a[j++];
        } else if (op === OPS.closePath) {
          cx = sx;
          cy = sy;
        }
      }
    } else if (fn === OPS.stroke || fn === OPS.closeStroke || fn === OPS.fillStroke || fn === OPS.eoFillStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) {
      for (const s of pending) {
        if (s.rect) {
          if (s.y1 - s.y0 <= 2) emit(s.x0, (s.y0 + s.y1) / 2, s.x1, (s.y0 + s.y1) / 2);
          else if (s.x1 - s.x0 <= 2) emit((s.x0 + s.x1) / 2, s.y0, (s.x0 + s.x1) / 2, s.y1);
          else {
            emit(s.x0, s.y0, s.x1, s.y0);
            emit(s.x0, s.y1, s.x1, s.y1);
            emit(s.x0, s.y0, s.x0, s.y1);
            emit(s.x1, s.y0, s.x1, s.y1);
          }
        } else emit(s.x0, s.y0, s.x1, s.y1);
      }
      pending = [];
    } else if (fn === OPS.fill || fn === OPS.eoFill) {
      // Thin filled rectangles are rules; larger fills are backgrounds, not borders.
      for (const s of pending) {
        if (!s.rect) continue;
        if (s.y1 - s.y0 <= 2.5 && s.x1 - s.x0 >= 6) emit(s.x0, (s.y0 + s.y1) / 2, s.x1, (s.y0 + s.y1) / 2);
        else if (s.x1 - s.x0 <= 2.5 && s.y1 - s.y0 >= 6) emit((s.x0 + s.x1) / 2, s.y0, (s.x0 + s.x1) / 2, s.y1);
      }
      pending = [];
    } else if (fn === OPS.endPath) pending = [];
  }
  return mergeRulings(out);
}

/** Merge collinear, overlapping or touching rulings. */
export function mergeRulings(rs: Ruling[], tol = 1.5): Ruling[] {
  const out: Ruling[] = [];
  for (const o of ['h', 'v'] as const) {
    const pos = (r: Ruling) => (o === 'h' ? r.y : r.x);
    const start = (r: Ruling) => (o === 'h' ? r.x : r.y);
    const list = rs.filter((r) => r.orientation === o).sort((a, b) => pos(a) - pos(b) || start(a) - start(b));
    const used = new Array(list.length).fill(false);
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      let p = pos(list[i]);
      let s = start(list[i]);
      let e = s + list[i].length;
      for (let j = i + 1; j < list.length && pos(list[j]) - p <= tol; j++) {
        if (used[j]) continue;
        const sj = start(list[j]);
        if (sj <= e + tol && sj + list[j].length >= s - tol) {
          s = Math.min(s, sj);
          e = Math.max(e, sj + list[j].length);
          p = (p + pos(list[j])) / 2;
          used[j] = true;
        }
      }
      out.push(o === 'h' ? { orientation: 'h', x: round2(s), y: round2(p), length: round2(e - s) } : { orientation: 'v', x: round2(p), y: round2(s), length: round2(e - s) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ columns

export interface ColumnRegion {
  /** Gutter x (points). */
  gutter: number;
  /** Line index range [first, last] of the two-column region (inclusive, original order). */
  first: number;
  last: number;
}

/**
 * Find a two-column prose region: a vertical gutter in the middle half of the page that no text
 * segment crosses over at least `minLines` consecutive lines, with prose (long segments) on both
 * sides. Tables (short cells) do not qualify.
 */
export function findColumnRegion(lines: Line[], pageWidth: number, o: { minLines?: number; minChars?: number } = {}): ColumnRegion | undefined {
  const minLines = o.minLines ?? 5;
  const minChars = o.minChars ?? 18;
  let best: (ColumnRegion & { score: number }) | undefined;
  for (let gx = Math.round(pageWidth * 0.3); gx <= Math.round(pageWidth * 0.7); gx += 2) {
    let start = -1;
    const close = (end: number) => {
      if (start < 0) return;
      const run = lines.slice(start, end + 1);
      const left = run.flatMap((l) => l.segments.filter((s) => s.bbox.x + s.bbox.width <= gx));
      const right = run.flatMap((l) => l.segments.filter((s) => s.bbox.x >= gx));
      const avg = (ss: typeof left) => (ss.length ? ss.reduce((n, s) => n + s.text.length, 0) / ss.length : 0);
      const both = run.length >= minLines && left.length >= minLines - 1 && right.length >= minLines - 1 && avg(left) >= minChars && avg(right) >= minChars;
      if (both) {
        // Prefer the widest margin around the gutter (centre of the whitespace).
        const lEdge = Math.max(...left.map((s) => s.bbox.x + s.bbox.width));
        const rEdge = Math.min(...right.map((s) => s.bbox.x));
        const margin = Math.min(gx - lEdge, rEdge - gx);
        const score = run.length * 1000 + margin;
        if (!best || score > best.score) best = { gutter: gx, first: start, last: end, score };
      }
      start = -1;
    };
    lines.forEach((l, i) => {
      const crosses = l.segments.some((s) => s.bbox.x < gx - 1 && s.bbox.x + s.bbox.width > gx + 1);
      if (crosses) close(i - 1);
      else if (start < 0) start = i;
    });
    close(lines.length - 1);
  }
  return best ? { gutter: best.gutter, first: best.first, last: best.last } : undefined;
}

/**
 * Reading order for a page with a two-column region: lines above, then the left column, then the
 * right column, then lines below. `regroup` turns items back into lines (baseline clustering).
 */
export function orderColumns(lines: Line[], region: ColumnRegion, regroup: (items: TextItem[]) => Line[]): Line[] {
  const inRegion = lines.slice(region.first, region.last + 1);
  const items = inRegion.flatMap((l) => l.segments.flatMap((s) => s.items));
  const left = regroup(items.filter((it) => it.x + it.width / 2 < region.gutter));
  const right = regroup(items.filter((it) => it.x + it.width / 2 >= region.gutter));
  const ordered = [...lines.slice(0, region.first), ...left, ...right, ...lines.slice(region.last + 1)];
  return ordered.map((l, index) => ({ ...l, index }));
}

// ------------------------------------------------------------------ tables

interface DetectOptions {
  locale?: NumberLocale;
  dateFormats?: string[];
  method?: 'layout' | 'ocr';
}

function cellValue(raw: string, column: string, page: number, bbox: BBox, o: DetectOptions, confidence: number) {
  return { column, raw, normalized: normalizeValue(raw, { locale: o.locale, dateFormats: o.dateFormats }), page, bbox, method: o.method ?? 'layout', confidence } as const;
}

function columnNames(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  });
}

const TOTAL_RE = /^(grand\s+)?total\b/i;
const SUBTOTAL_RE = /^sub-?\s?total\b/i;

/** Tables whose cells are delimited by ruling lines (a grid of at least 2x2 cells). */
export function detectRuledTables(page: PageModel, o: DetectOptions = {}): DocTable[] {
  const rs = page.rulings ?? [];
  const hs = rs.filter((r) => r.orientation === 'h');
  const vs = rs.filter((r) => r.orientation === 'v');
  const tol = 2;
  const meets = (h: Ruling, v: Ruling) => v.x >= h.x - tol && v.x <= h.x + h.length + tol && h.y >= v.y - tol && h.y <= v.y + v.length + tol;
  // Connected components of crossing rulings.
  const all = [...hs, ...vs];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  hs.forEach((h, i) => vs.forEach((v, j) => {
    if (meets(h, v)) parent[find(i)] = find(hs.length + j);
  }));
  const groups = new Map<number, Ruling[]>();
  all.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  const items = page.lines.flatMap((l) => l.segments.flatMap((s) => s.items));
  const tables: DocTable[] = [];
  for (const g of groups.values()) {
    const gx = uniq(g.filter((r) => r.orientation === 'v').map((r) => r.x), 3);
    const gy = uniq(g.filter((r) => r.orientation === 'h').map((r) => r.y), 3);
    if (gx.length < 2 || gy.length < 3) continue;
    const grid: TextItem[][][] = Array.from({ length: gy.length - 1 }, () => Array.from({ length: gx.length - 1 }, () => [] as TextItem[]));
    for (const it of items) {
      const cx = it.x + it.width / 2;
      const cy = it.y + it.height / 2;
      const c = gx.findIndex((x, i) => i < gx.length - 1 && cx >= x && cx < gx[i + 1]);
      const r = gy.findIndex((y, i) => i < gy.length - 1 && cy >= y && cy < gy[i + 1]);
      if (c >= 0 && r >= 0) grid[r][c].push(it);
    }
    const sameRow = (a: TextItem, b: TextItem) => Math.abs(a.baseline - b.baseline) < 0.5 * Math.min(a.fontSize, b.fontSize);
    const text = (its: TextItem[]) => [...its].sort((a, b) => (sameRow(a, b) ? a.x - b.x : b.baseline - a.baseline)).map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
    const nonEmpty = grid.filter((row) => row.some((cell) => cell.length));
    if (nonEmpty.length < 2) continue;
    const headerRow = nonEmpty[0];
    const columns = columnNames(headerRow.map(text));
    const headerIdx = grid.indexOf(headerRow);
    const rows: TableRow[] = [];
    for (let r = headerIdx + 1; r < grid.length; r++) {
      if (!grid[r].some((c) => c.length)) continue;
      const cells: TableRow['cells'] = {};
      grid[r].forEach((its, c) => {
        if (!its.length) return;
        const conf = its.every((t) => t.confidence === undefined) ? 0.9 : its.reduce((n, t) => n + (t.confidence ?? 1), 0) / its.length * 0.95;
        cells[columns[c]] = cellValue(text(its), columns[c], page.number, unionBBox(its), o, round2(conf));
      });
      const first = text(grid[r].find((c) => c.length) ?? []);
      rows.push({ index: rows.length, page: page.number, kind: SUBTOTAL_RE.test(first) ? 'subtotal' : TOTAL_RE.test(first) ? 'total' : 'data', cells, lineCount: 1 });
    }
    tables.push({
      name: `table-p${page.number}-${tables.length + 1}`,
      columns,
      headers: [{ page: page.number, bbox: unionBBox(headerRow.flat()) }],
      rows,
      pages: [page.number],
    });
  }
  return tables;
}

function uniq(ns: number[], tol: number): number[] {
  const s = [...ns].sort((a, b) => a - b);
  const out: number[] = [];
  for (const n of s) if (!out.length || n - out[out.length - 1] > tol) out.push(n);
  return out;
}

/**
 * Tables without borders: runs of consecutive lines whose segments line up in the same columns.
 * The first line of a run is the header; lines with nothing in the first column continue the row
 * above (wrapped cells). Regions already covered by a ruled table are skipped.
 */
export function detectAlignedTables(page: PageModel, o: DetectOptions & { minRows?: number; minColumns?: number; skip?: BBox[] } = {}): DocTable[] {
  const minRows = o.minRows ?? 2;
  const minCols = o.minColumns ?? 3;
  const lines = page.lines.filter((l) => !(o.skip ?? []).some((b) => l.bbox.y >= b.y - 1 && l.bbox.y + l.bbox.height <= b.y + b.height + 1));
  const tables: DocTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i];
    if (head.segments.length < minCols) {
      i++;
      continue;
    }
    const cols = head.segments.map((s) => ({ x0: s.bbox.x, x1: s.bbox.x + s.bbox.width }));
    const em = Math.max(...head.segments.map((s) => s.fontSize));
    const colOf = (b: BBox): number => {
      let best = -1;
      let bestOv = 0;
      cols.forEach((c, ci) => {
        const ov = Math.min(c.x1, b.x + b.width) - Math.max(c.x0, b.x);
        const near = ov > 0 ? ov : -Math.min(Math.abs(b.x - c.x0), Math.abs(b.x + b.width - c.x1));
        if (best < 0 || near > bestOv) {
          best = ci;
          bestOv = near;
        }
      });
      return bestOv > -em * 1.2 ? best : -1;
    };
    const body: Line[] = [];
    let prev = head;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.bbox.y - (prev.bbox.y + prev.bbox.height) > em * 2.5) break;
      const idx = l.segments.map((s) => colOf(s.bbox));
      if (idx.some((c) => c < 0) || new Set(idx).size !== idx.length) break;
      if (l.segments.length === 1 && body.length === 0) break;
      body.push(l);
      prev = l;
      l.segments.forEach((s, k) => {
        cols[idx[k]].x0 = Math.min(cols[idx[k]].x0, s.bbox.x);
        cols[idx[k]].x1 = Math.max(cols[idx[k]].x1, s.bbox.x + s.bbox.width);
      });
    }
    const full = body.filter((l) => l.segments.length >= Math.max(2, cols.length - 1));
    if (full.length < minRows) {
      i++;
      continue;
    }
    const columns = columnNames(head.segments.map((s) => s.text));
    const rows: TableRow[] = [];
    for (const l of body) {
      const idx = l.segments.map((s) => colOf(s.bbox));
      const conf = (l.segments.flatMap((s) => s.items).reduce((n, t) => n + (t.confidence ?? 1), 0) / Math.max(1, l.segments.flatMap((s) => s.items).length)) * 0.9;
      const last = rows[rows.length - 1];
      const firstText = l.segments[0]?.text ?? '';
      const continuation = last && !idx.includes(0) && l.segments.length < Math.max(2, cols.length - 1);
      if (continuation) {
        l.segments.forEach((s, k) => {
          const name = columns[idx[k]];
          const c = last.cells[name];
          if (c) {
            const raw = `${c.raw} ${s.text}`;
            last.cells[name] = cellValue(raw, name, page.number, unionBBox([c.bbox, s.bbox]), o, c.confidence);
          } else last.cells[name] = cellValue(s.text, name, page.number, s.bbox, o, round2(conf));
        });
        last.lineCount++;
        continue;
      }
      const cells: TableRow['cells'] = {};
      l.segments.forEach((s, k) => {
        cells[columns[idx[k]]] = cellValue(s.text, columns[idx[k]], page.number, s.bbox, o, round2(conf));
      });
      rows.push({ index: rows.length, page: page.number, kind: SUBTOTAL_RE.test(firstText) ? 'subtotal' : TOTAL_RE.test(firstText) ? 'total' : 'data', cells, lineCount: 1 });
    }
    tables.push({ name: `table-p${page.number}-${tables.length + 1}`, columns, headers: [{ page: page.number, bbox: head.bbox }], rows, pages: [page.number] });
    i = lines.indexOf(body[body.length - 1]) + 1;
  }
  return tables;
}

/** All template-free tables of a page: ruled grids first, then aligned text outside them. */
export function detectTables(page: PageModel, o: DetectOptions = {}): DocTable[] {
  const ruled = detectRuledTables(page, o);
  const skip = ruled.map((t) => unionBBox([...t.headers.map((h) => h.bbox), ...t.rows.flatMap((r) => Object.values(r.cells).map((c) => c.bbox))]));
  const aligned = detectAlignedTables(page, { ...o, skip });
  return [...ruled, ...aligned].map((t, i) => ({ ...t, name: `table-p${page.number}-${i + 1}` }));
}
