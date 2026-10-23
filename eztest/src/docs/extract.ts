/**
 * PDF text-layer extraction with pdfjs-dist (legacy build, Node friendly, no
 * worker thread). Produces the Canonical Document Model: positioned items are
 * grouped into lines by baseline clustering, lines into column segments, and
 * an optional template turns the layout into named fields and typed tables.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { EzTestError, NotSupportedError, sha256 } from '../core/index.js';
import type {
  CanonicalDocument,
  DocMetadata,
  ExtractionMethod,
  Line,
  PageModel,
  Segment,
  TextItem,
} from './model.js';
import { round2, unionBBox } from './model.js';
import type { NumberLocale } from './normalize.js';
import { applyTemplate, parseTemplate, type DocTemplate, type DocTemplateInput } from './template.js';

export interface ExtractOptions {
  /** Label used in reports (defaults to the file name, or "document.pdf"). */
  source?: string;
  /** Only "text-layer" is implemented; other methods throw NotSupportedError. */
  method?: ExtractionMethod;
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
}

export type PdfInput = Uint8Array | ArrayBuffer | string;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | undefined;
async function pdfjs(): Promise<PdfJs> {
  // Loaded lazily: importing src/docs must not pay for pdfjs unless a PDF is read.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function toBytes(input: PdfInput): Promise<{ bytes: Uint8Array; name?: string }> {
  if (typeof input === 'string') return { bytes: new Uint8Array(await readFile(input)), name: basename(input) };
  if (input instanceof ArrayBuffer) return { bytes: new Uint8Array(input) };
  return { bytes: input };
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

/** Extract a PDF into the Canonical Document Model. */
export async function extractPdf(input: PdfInput, opts: ExtractOptions = {}): Promise<CanonicalDocument> {
  const method = opts.method ?? 'text-layer';
  if (method !== 'text-layer') {
    throw new NotSupportedError(`document extraction method "${method}" (only "text-layer" is implemented)`);
  }
  const { bytes, name } = await toBytes(input);
  const lib = await pdfjs();
  // pdfjs transfers (detaches) the buffer it is given, so hand it a copy.
  const task = lib.getDocument({
    data: bytes.slice(),
    password: opts.password,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  let pdf: Awaited<typeof task.promise>;
  try {
    pdf = await task.promise;
  } catch (e) {
    const err = e as Error;
    if (err?.name === 'PasswordException') {
      throw new EzTestError('PDF is password protected (pass opts.password)', 'PDF_PASSWORD_REQUIRED');
    }
    throw new EzTestError(`Could not parse PDF: ${err?.message ?? String(e)}`, 'PDF_PARSE_ERROR');
  }
  try {
    const metaRaw = await pdf.getMetadata().catch(() => undefined);
    const info = (metaRaw?.info ?? {}) as Record<string, unknown>;
    const pages: PageModel[] = [];
    const pageSizes: Array<{ width: number; height: number }> = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const [vx0, vy0, vx1, vy1] = page.view;
      const width = round2(vx1 - vx0);
      const height = round2(vy1 - vy0);
      pageSizes.push({ width, height });
      const tc = await page.getTextContent();
      if (opts.resolveFontNames !== false) await page.getOperatorList().catch(() => undefined);
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
      pages.push({ number: p, width, height, lines: groupLines(items, opts) });
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
      findings: [],
    };
    if (pages.every((pg) => pg.lines.length === 0)) {
      doc.findings.push({
        code: 'NO_TEXT_LAYER',
        severity: 'error',
        message: 'The document has no extractable text layer (scanned image?). OCR is not implemented.',
      });
    }
    if (opts.template !== undefined) {
      const tpl = parseTemplate(opts.template as DocTemplateInput | string);
      applyTemplate(doc, tpl, { locale: opts.locale, dateFormats: opts.dateFormats });
    }
    return doc;
  } finally {
    await pdf.destroy();
  }
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
