/**
 * Canonical Document Model: every document source (PDF text layer today;
 * layout/OCR/vision extractors later) is turned into the same shape:
 * pages -> lines -> segments, plus named fields and typed tables. Every value
 * keeps where it came from (page, bbox), how it was read (method) and how
 * confident the reader is, so reports can always point back at the evidence.
 */

/** Bounding box in PDF points, origin at the TOP-LEFT of the page (y grows downwards). */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ExtractionMethod = 'text-layer' | 'layout' | 'ocr' | 'vision';

export type ValueType = 'text' | 'number' | 'currency' | 'date' | 'percent';

/** One positioned text run as reported by the PDF text layer. */
export interface TextItem {
  text: string;
  page: number;
  /** Left edge (points). */
  x: number;
  /** Top edge, top-left origin (points). */
  y: number;
  width: number;
  height: number;
  /** Baseline in PDF user space (bottom-left origin). */
  baseline: number;
  fontName: string;
  fontFamily?: string;
  fontSize: number;
}

/** Adjacent items on a line separated by less than a column gap. */
export interface Segment {
  text: string;
  bbox: BBox;
  fontSize: number;
  items: TextItem[];
}

export interface Line {
  page: number;
  /** Index of the line on its page, in reading order. */
  index: number;
  text: string;
  bbox: BBox;
  segments: Segment[];
}

export interface PageModel {
  number: number;
  width: number;
  height: number;
  lines: Line[];
}

export interface DocMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO-8601 when the PDF date could be parsed. */
  creationDate?: string;
  modDate?: string;
  pdfVersion?: string;
  pageCount: number;
  pageSizes: Array<{ width: number; height: number }>;
  encrypted: boolean;
}

export type NormalizedKind = 'null' | 'number' | 'date' | 'text';

export interface NormalizedValue {
  kind: NormalizedKind;
  /** number for kind=number, ISO date (YYYY-MM-DD) for kind=date, folded text for kind=text, null for kind=null. */
  value: number | string | null;
  /** ISO 4217 code when a currency symbol/code was present. */
  currency?: string;
  /** True when the raw value was a percentage (value is the number as printed, e.g. 12.5 for "12.5%"). */
  percent?: boolean;
  /** Set when the raw value looked like a date but its day/month order is ambiguous. */
  ambiguousDate?: boolean;
}

export interface DocValue {
  raw: string;
  normalized: NormalizedValue;
  page: number;
  bbox: BBox;
  method: ExtractionMethod;
  /** 0..1 */
  confidence: number;
}

export interface DocField {
  name: string;
  label?: string;
  type: ValueType;
  value: DocValue;
}

export interface TableCell extends DocValue {
  column: string;
}

export type TableRowKind = 'data' | 'total' | 'subtotal';

export interface TableRow {
  index: number;
  page: number;
  kind: TableRowKind;
  cells: Record<string, TableCell>;
  /** Number of physical lines stitched into this row (wrapped cells). */
  lineCount: number;
}

export interface DocTable {
  name: string;
  columns: string[];
  /** Positions of the header occurrences (first page plus repeated headers). */
  headers: Array<{ page: number; bbox: BBox }>;
  rows: TableRow[];
  pages: number[];
  terminatedBy?: string;
}

export type DocSeverity = 'error' | 'warning' | 'info';

export interface DocFinding {
  code: string;
  severity: DocSeverity;
  message: string;
  page?: number;
  ref?: string;
}

export interface CanonicalDocument {
  /** File name / label of the source. */
  source: string;
  sha256: string;
  metadata: DocMetadata;
  pages: PageModel[];
  fields: DocField[];
  tables: DocTable[];
  /** Problems found while extracting (missing fields, header not found, empty table...). */
  findings: DocFinding[];
}

/** All lines of the document, in reading order. */
export function allLines(doc: CanonicalDocument): Line[] {
  return doc.pages.flatMap((p) => p.lines);
}

/** Plain text of the whole document, one line per text line, pages separated by a form feed. */
export function documentText(doc: CanonicalDocument): string {
  return doc.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\f\n');
}

export function unionBBox(boxes: BBox[]): BBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return { x: round2(x0), y: round2(y0), width: round2(x1 - x0), height: round2(y1 - y0) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
