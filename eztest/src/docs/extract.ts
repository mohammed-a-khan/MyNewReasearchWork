/**
 * PDF extraction into the Canonical Document Model.
 *
 *  - "text-layer" (default): positioned text from the PDF's text layer (pdfjs-dist
 *    legacy build, Node friendly, no worker thread), grouped into lines by baseline
 *    clustering and into column segments by gaps.
 *  - "layout": the text layer plus layout analysis: ruling lines, two-column reading
 *    order and template-free table detection (src/docs/layout.ts).
 *  - "ocr": every page is rendered (@napi-rs/canvas) and read by tesseract.js
 *    (src/docs/ocr.ts); the words become positioned items, so templates work as usual.
 *  - "auto": the text layer, and OCR for the pages that have none (scanned pages).
 *  - "vision": not supported (EZTest does not send documents to a model service).
 *
 * An optional template turns the layout into named fields and typed tables.
 */
import { NotSupportedError, sha256 } from '../core/index.js';
import type {
  CanonicalDocument,
  DocMetadata,
  DocValue,
  ExtractionMethod,
  Line,
  PageModel,
  Segment,
  TextItem,
} from './model.js';
import { round2, unionBBox } from './model.js';
import { normalizeValue, type NumberLocale } from './normalize.js';
import { applyTemplate, parseTemplate, type DocTemplate, type DocTemplateInput } from './template.js';
import { detectTables, findColumnRegion, orderColumns, rulingsFromOperators, type OpsIds } from './layout.js';
import { ocrWordsToItems, TesseractDocOcr, type DocOcrEngine, type DocOcrOptions } from './ocr.js';
import { canRender, openPdf, pdfjs, renderPage, toBytes, type PdfInput } from './render.js';

export type { PdfInput } from './render.js';

export type ExtractMethodOption = ExtractionMethod | 'auto';

export interface ExtractOptions {
  /** Label used in reports (defaults to the file name, or "document.pdf"). */
  source?: string;
  /** "text-layer" (default), "layout", "ocr" or "auto". "vision" throws NotSupportedError. */
  method?: ExtractMethodOption;
  password?: string;
  /** Max baseline distance (points) for two items to share a line. Default: 35% of the smaller font size, min 1.5pt. */
  lineTolerance?: number;
  /** Horizontal gap, as a multiple of font size, that splits a line into column segments. Default 0.9. */
  segmentGapEm?: number;
  /** Resolve real font names (costs one operator-list pass per page). Default true. */
  resolveFontNames?: boolean;
  /** Field/table template (object or YAML/JSON text) applied after layout extraction. */
  template?: DocTemplate | DocTemplateInput | string;
  locale?: NumberLocale;
  dateFormats?: string[];
  /** OCR settings for "ocr" and "auto" (language, resolution, engine). */
  ocr?: DocOcrOptions;
  /**
   * Template-free table detection (ruling-line grids and aligned text). Default: on for "layout"
   * when the template defines no tables.
   */
  detectTables?: boolean;
  /** Resolve optional peers (@napi-rs/canvas, tesseract.js) from this directory. Default process.cwd(). */
  baseDir?: string;
}

/** Convert a PDF date string (D:YYYYMMDDHHmmSSOHH'mm') to ISO-8601. */
export function parsePdfDate(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?$/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz, th = '00', tm = '00'] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (tz === '+' || tz === '-') ms -= (tz === '+' ? 1 : -1) * (+th * 60 + +tm) * 60000;
  const dt = new Date(ms);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

const METHODS = new Set(['text-layer', 'layout', 'ocr', 'auto']);

type PdfDoc = Awaited<ReturnType<typeof openPdf>>;
type PdfPage = Awaited<ReturnType<PdfDoc['getPage']>>;

/** Extract a PDF into the Canonical Document Model. */
export async function extractPdf(input: PdfInput, opts: ExtractOptions = {}): Promise<CanonicalDocument> {
  const method = opts.method ?? 'text-layer';
  if (method === 'vision') {
    throw new NotSupportedError('document extraction method "vision": EZTest does not send documents to a model service. Use "ocr" for scanned pages, "layout" for positional text and tables, or "auto"');
  }
  if (!METHODS.has(method)) throw new NotSupportedError(`document extraction method "${method}" (use text-layer, layout, ocr or auto)`);
  const { bytes, name } = await toBytes(input);
  const lib = await pdfjs();
  const pdf = await openPdf(bytes, { password: opts.password, render: method === 'ocr', baseDir: opts.baseDir });
  let renderDoc: PdfDoc | undefined = method === 'ocr' ? pdf : undefined;
  let ocr: DocOcrEngine | undefined;
  const findings: CanonicalDocument['findings'] = [];
  try {
    const metaRaw = await pdf.getMetadata().catch(() => undefined);
    const info = (metaRaw?.info ?? {}) as Record<string, unknown>;
    const pages: PageModel[] = [];
    const pageSizes: Array<{ width: number; height: number }> = [];
    const rendered = new Map<number, { png: Buffer; scale: number }>();
    const ocrPage = async (p: number, height: number): Promise<TextItem[]> => {
      renderDoc ??= await openPdf(bytes, { password: opts.password, render: true, baseDir: opts.baseDir });
      ocr ??= opts.ocr?.engine ?? new TesseractDocOcr({ baseDir: opts.baseDir, ...opts.ocr });
      const r = await renderPage(renderDoc, p, (opts.ocr?.dpi ?? 300) / 72, opts.baseDir);
      const png = r.png();
      rendered.set(p, { png, scale: r.scale });
      const words = await ocr.recognize(png);
      return ocrWordsToItems(words, { page: p, scale: r.scale, heightPt: height }, opts.ocr?.minConfidence ?? 30);
    };
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const [vx0, vy0, vx1, vy1] = page.view;
      const width = round2(vx1 - vx0);
      const height = round2(vy1 - vy0);
      pageSizes.push({ width, height });
      let items: TextItem[] = [];
      let pageMethod: ExtractionMethod = method === 'layout' ? 'layout' : 'text-layer';
      let opList: { fnArray: number[]; argsArray: unknown[] } | undefined;
      if (method !== 'ocr') {
        const tc = await page.getTextContent();
        if (opts.resolveFontNames !== false || method === 'layout') opList = await page.getOperatorList().catch(() => undefined);
        items = textLayerItems(page, tc, p, height, vx0, vy0);
      }
      if (method === 'ocr' || (method === 'auto' && items.length === 0)) {
        if (method === 'auto' && !canRender(opts.baseDir)) {
          findings.push({ code: 'OCR_UNAVAILABLE', severity: 'error', page: p, message: `Page ${p} has no text layer and cannot be read by OCR: install the optional peer dependencies @napi-rs/canvas and tesseract.js (with @tesseract.js-data/eng).` });
        } else {
          items = await ocrPage(p, height);
          pageMethod = 'ocr';
          if (items.length === 0) findings.push({ code: 'OCR_NO_TEXT', severity: 'warning', page: p, message: `OCR found no text on page ${p}.` });
        }
      }
      const model: PageModel = { number: p, width, height, lines: groupLines(items, opts), ...(pageMethod !== 'text-layer' ? { method: pageMethod } : {}) };
      if (method === 'layout') {
        if (opList) model.rulings = rulingsFromOperators(opList.fnArray, opList.argsArray, lib.OPS as unknown as OpsIds, page.view);
        const region = findColumnRegion(model.lines, width);
        if (region) model.lines = orderColumns(model.lines, region, (its) => groupLines(its, opts));
      }
      pages.push(model);
      page.cleanup();
    }
    const metadata: DocMetadata = {
      title: str(info.Title),
      author: str(info.Author),
      subject: str(info.Subject),
      keywords: str(info.Keywords),
      creator: str(info.Creator),
      producer: str(info.Producer),
      creationDate: parsePdfDate(info.CreationDate),
      modDate: parsePdfDate(info.ModDate),
      pdfVersion: str(info.PDFFormatVersion),
      pageCount: pdf.numPages,
      pageSizes,
      encrypted: info.EncryptFilterName !== null && info.EncryptFilterName !== undefined,
    };
    for (const k of Object.keys(metadata) as Array<keyof DocMetadata>) if (metadata[k] === undefined) delete metadata[k];
    const doc: CanonicalDocument = {
      source: opts.source ?? name ?? 'document.pdf',
      sha256: sha256(bytes),
      metadata,
      pages,
      fields: [],
      tables: [],
      findings,
    };
    if (pages.every((pg) => pg.lines.length === 0) && !findings.some((f) => f.code === 'OCR_UNAVAILABLE')) {
      doc.findings.push({
        code: 'NO_TEXT_LAYER',
        severity: 'error',
        message: method === 'ocr' || method === 'auto'
          ? 'No text was found in the document, not even by OCR.'
          : 'The document has no extractable text layer (scanned image?). Extract with method "ocr" or "auto" to read it by OCR.',
      });
    }
    let templateTables = false;
    if (opts.template !== undefined) {
      const tpl = parseTemplate(opts.template as DocTemplateInput | string);
      templateTables = tpl.tables.length > 0;
      applyTemplate(doc, tpl, { locale: opts.locale, dateFormats: opts.dateFormats });
      if (rendered.size && ocr?.recognizeRegion) await rereadNumbers(doc, tpl, rendered, ocr, opts);
    }
    if ((opts.detectTables ?? method === 'layout') && !templateTables) {
      for (const pg of pages) doc.tables.push(...detectTables(pg, { locale: opts.locale, dateFormats: opts.dateFormats, method: pg.method === 'ocr' ? 'ocr' : 'layout' }));
    }
    annotateProvenance(doc);
    return doc;
  } finally {
    await ocr?.close().catch(() => undefined);
    if (renderDoc && renderDoc !== pdf) await renderDoc.destroy();
    await pdf.destroy();
  }
}

function textLayerItems(page: PdfPage, tc: Awaited<ReturnType<PdfPage['getTextContent']>>, p: number, height: number, vx0: number, vy0: number): TextItem[] {
  const styles = tc.styles as Record<string, { fontFamily?: string }>;
  const items: TextItem[] = [];
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform as number[];
    const fontSize = round2(Math.hypot(t[2], t[3]) || Math.abs(t[3]) || it.height || 1);
    const baseline = t[5] - vy0;
    const x = t[4] - vx0;
    const h = it.height || fontSize;
    let fontName = it.fontName;
    try {
      if (page.commonObjs.has(it.fontName)) {
        const f = page.commonObjs.get(it.fontName) as { name?: string } | undefined;
        if (f?.name) fontName = f.name;
      }
    } catch {
      // Font not resolved: keep pdfjs' internal id.
    }
    items.push({
      text: it.str,
      page: p,
      x: round2(x),
      y: round2(height - baseline - h),
      width: round2(it.width),
      height: round2(h),
      baseline: round2(baseline),
      fontName,
      fontFamily: styles[it.fontName]?.fontFamily,
      fontSize,
    });
  }
  return items;
}

const NUMERIC_TYPES = new Set(['number', 'currency', 'percent']);
const DIGITS = '0123456789.,-+()$€£¥%';

/**
 * Second look at typed numeric values on OCR pages that did not read as numbers (a lone "1" is
 * often read as "il" or "|"): the value's box is read again as one line limited to digits and
 * number punctuation. Only a result that parses as a number replaces the value.
 */
async function rereadNumbers(doc: CanonicalDocument, tpl: DocTemplate, rendered: Map<number, { png: Buffer; scale: number }>, ocr: DocOcrEngine, o: ExtractOptions): Promise<void> {
  const locale = o.locale ?? tpl.locale ?? 'auto';
  const dateFormats = o.dateFormats ?? tpl.dateFormats;
  const fix = async (v: DocValue): Promise<boolean> => {
    const img = rendered.get(v.page);
    if (!img || v.normalized.kind === 'number') return false;
    // Only what looks like a garbled number ("il", "1O.5O", "|"), not labels such as "Total:".
    if (!/^[\dOoIli|!:;.,$€£¥%()+\-\s]{1,20}$/.test(v.raw)) return false;
    const k = img.scale;
    const rect = { left: Math.max(0, Math.floor((v.bbox.x - 9) * k)), top: Math.max(0, Math.floor((v.bbox.y - 3) * k)), width: Math.ceil((v.bbox.width + 18) * k), height: Math.ceil((v.bbox.height + 6) * k) };
    const r = await ocr.recognizeRegion!(img.png, rect, { whitelist: DIGITS });
    const n = normalizeValue(r.text, { type: 'number', locale, dateFormats });
    if (!r.text || n.kind !== 'number') return false;
    v.raw = r.text;
    v.normalized = { ...normalizeValue(r.text, { locale, dateFormats }), ...(v.normalized.currency ? { currency: v.normalized.currency } : {}) };
    v.confidence = Math.round(Math.min(0.9, r.confidence / 100) * 100) / 100;
    return true;
  };
  for (const f of doc.fields) {
    if (!NUMERIC_TYPES.has(f.type)) continue;
    if (await fix(f.value)) doc.findings = doc.findings.filter((x) => !(x.code === 'FIELD_TYPE_MISMATCH' && x.ref === f.name));
  }
  for (const spec of tpl.tables) {
    const table = doc.tables.find((t) => t.name === spec.name);
    if (!table) continue;
    const numeric = spec.columns.filter((c): c is Exclude<typeof c, string> => typeof c !== 'string' && NUMERIC_TYPES.has(c.type)).map((c) => c.name);
    for (const row of table.rows) for (const c of numeric) if (row.cells[c]) await fix(row.cells[c]);
  }
}

/**
 * Values read from OCR (or layout) pages say so: their method is the page's method, and on OCR
 * pages their confidence is capped by the recogniser's mean confidence for the words in the box.
 */
export function annotateProvenance(doc: CanonicalDocument): void {
  const pages = new Map(doc.pages.map((p) => [p.number, p]));
  const fix = (v: DocValue) => {
    const pg = pages.get(v.page);
    if (!pg?.method) return;
    v.method = pg.method;
    if (pg.method !== 'ocr') return;
    const b = v.bbox;
    const inside = pg.lines.flatMap((l) => l.segments.flatMap((s) => s.items)).filter((it) => {
      const cx = it.x + it.width / 2;
      const cy = it.y + it.height / 2;
      return cx >= b.x - 0.5 && cx <= b.x + b.width + 0.5 && cy >= b.y - 0.5 && cy <= b.y + b.height + 0.5;
    });
    const confs = inside.map((it) => it.confidence ?? 1);
    if (confs.length) v.confidence = Math.round(Math.min(v.confidence, confs.reduce((a, c) => a + c, 0) / confs.length) * 100) / 100;
  };
  for (const f of doc.fields) fix(f.value);
  for (const t of doc.tables) for (const r of t.rows) for (const c of Object.values(r.cells)) fix(c);
}

/** Accept an already-extracted document, raw bytes or a file path. */
export async function loadDocument(
  input: CanonicalDocument | PdfInput,
  opts: ExtractOptions = {},
): Promise<CanonicalDocument> {
  if (typeof input === 'object' && input !== null && 'pages' in input && 'metadata' in input) return input;
  return extractPdf(input as PdfInput, opts);
}

// ----------------------------------------------------------------- layout

/** Group positioned items into lines (baseline clustering) and segments (column gaps). */
export function groupLines(items: TextItem[], opts: { lineTolerance?: number; segmentGapEm?: number } = {}): Line[] {
  const sorted = [...items].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  const clusters: TextItem[][] = [];
  let cur: TextItem[] = [];
  let ref = 0;
  for (const it of sorted) {
    if (cur.length === 0) {
      cur = [it];
      ref = it.baseline;
      continue;
    }
    const minSize = Math.min(it.fontSize, ...cur.map((c) => c.fontSize));
    const tol = opts.lineTolerance ?? Math.max(1.5, 0.35 * minSize);
    if (Math.abs(it.baseline - ref) <= tol) {
      cur.push(it);
      ref = cur.reduce((s, c) => s + c.baseline, 0) / cur.length;
    } else {
      clusters.push(cur);
      cur = [it];
      ref = it.baseline;
    }
  }
  if (cur.length) clusters.push(cur);
  const gapEm = opts.segmentGapEm ?? 0.9;
  return clusters.map((cl, index) => {
    const its = [...cl].sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    let seg: TextItem[] = [];
    const flush = () => {
      if (!seg.length) return;
      segments.push({
        text: joinItems(seg),
        bbox: unionBBox(seg),
        fontSize: Math.max(...seg.map((s) => s.fontSize)),
        items: seg,
      });
      seg = [];
    };
    for (const it of its) {
      const prev = seg[seg.length - 1];
      if (prev && it.x - (prev.x + prev.width) > gapEm * Math.max(prev.fontSize, it.fontSize)) flush();
      seg.push(it);
    }
    flush();
    return {
      page: its[0].page,
      index,
      text: segments.map((s) => s.text).join(' '),
      bbox: unionBBox(its),
      segments,
    };
  });
}

function joinItems(items: TextItem[]): string {
  let out = '';
  let prev: TextItem | undefined;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.width);
      if (gap > 0.15 * Math.min(prev.fontSize, it.fontSize) && !/\s$/.test(out) && !/^\s/.test(it.text)) out += ' ';
    }
    out += it.text;
    prev = it;
  }
  return out.replace(/\s+/g, ' ').trim();
}
