/**
 * Visual PDF comparison: both documents are rendered page by page
 * (src/docs/render.ts) and pixel-diffed with pixelmatch. Masked regions
 * (dates, generated ids, signatures) are painted identically on both sides
 * first, so they never count. Each page passes when its share of differing
 * pixels is within the tolerance; diff images are kept as evidence.
 */
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { EzTestError } from '../core/index.js';
import { renderPdfPages, type PdfInput, type RenderedPage } from './render.js';

/** A region to ignore, in PDF points from the top-left corner of the page. No page: every page. */
export interface VisualMask {
  page?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualCompareOptions {
  /** Rendering resolution. Default 100 dpi. */
  dpi?: number;
  /** Per-pixel colour distance (0..1) above which a pixel counts as different (pixelmatch threshold). Default 0.1. */
  threshold?: number;
  /** Largest share of differing pixels a page may have and still pass (0..1). Default 0 (any visible difference fails). */
  maxDiffRatio?: number;
  /** Alternative to maxDiffRatio: an absolute pixel budget per page. */
  maxDiffPixels?: number;
  /** Count anti-aliasing differences too. Default false (pixelmatch detects and skips them). */
  includeAA?: boolean;
  masks?: VisualMask[];
  /** Only these pages (1-based). Default: all. */
  pages?: number[];
  password?: string;
  baseDir?: string;
}

export interface VisualPageResult {
  page: number;
  /** Pixel size the page was compared at. */
  width: number;
  height: number;
  diffPixels: number;
  /** diffPixels / (width x height), 0..1 */
  diffRatio: number;
  passed: boolean;
  /** Why the page could not be compared pixel by pixel. */
  problem?: 'missing-in-actual' | 'missing-in-expected' | 'size-differs';
  /** PNG images (kept for evidence; absent for pages that only exist on one side). */
  expectedPng?: Buffer;
  actualPng?: Buffer;
  diffPng?: Buffer;
}

export interface VisualCompareResult {
  passed: boolean;
  pageCount: { actual: number; expected: number };
  pages: VisualPageResult[];
  options: { dpi: number; threshold: number; maxDiffRatio?: number; maxDiffPixels?: number; masks: VisualMask[] };
  summary: string;
}

const MASK_GRAY = 200;

function paintMasks(img: Uint8Array | Uint8ClampedArray, r: RenderedPage, w: number, h: number, masks: VisualMask[]): Array<[number, number, number, number]> {
  const boxes: Array<[number, number, number, number]> = [];
  for (const m of masks) {
    if (m.page !== undefined && m.page !== r.page) continue;
    const x0 = Math.max(0, Math.floor(m.x * r.scale));
    const y0 = Math.max(0, Math.floor(m.y * r.scale));
    const x1 = Math.min(w, Math.ceil((m.x + m.width) * r.scale));
    const y1 = Math.min(h, Math.ceil((m.y + m.height) * r.scale));
    boxes.push([x0, y0, x1, y1]);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        img[i] = img[i + 1] = img[i + 2] = MASK_GRAY;
        img[i + 3] = 255;
      }
    }
  }
  return boxes;
}

/** Pad an RGBA image to w x h with white. */
function padTo(r: RenderedPage, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < r.height; y++) out.set(r.rgba.subarray(y * r.width * 4, (y + 1) * r.width * 4), y * w * 4);
  return out;
}

function encodePng(data: Uint8Array, w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return PNG.sync.write(png);
}

/** Compare two PDFs visually, page by page. `actual` is the document under test, `expected` the baseline. */
export async function compareDocumentsVisually(actual: PdfInput, expected: PdfInput, o: VisualCompareOptions = {}): Promise<VisualCompareResult> {
  const dpi = o.dpi ?? 100;
  const threshold = o.threshold ?? 0.1;
  const masks = o.masks ?? [];
  for (const m of masks) {
    if (![m.x, m.y, m.width, m.height].every((n) => Number.isFinite(n)) || m.width <= 0 || m.height <= 0) throw new EzTestError(`Invalid mask ${JSON.stringify(m)}: x, y, width and height are points from the top-left corner`, 'DOCS_VISUAL_MASK');
  }
  const [a, e] = await Promise.all([
    renderPdfPages(actual, { dpi, password: o.password, baseDir: o.baseDir }),
    renderPdfPages(expected, { dpi, password: o.password, baseDir: o.baseDir }),
  ]);
  const count = Math.max(a.length, e.length);
  const wanted = new Set(o.pages ?? Array.from({ length: count }, (_, i) => i + 1));
  const pages: VisualPageResult[] = [];
  for (let p = 1; p <= count; p++) {
    if (!wanted.has(p)) continue;
    const ra = a[p - 1];
    const re = e[p - 1];
    if (!ra || !re) {
      const only = (ra ?? re)!;
      pages.push({
        page: p, width: only.width, height: only.height, diffPixels: only.width * only.height, diffRatio: 1, passed: false,
        problem: ra ? 'missing-in-expected' : 'missing-in-actual', ...(ra ? { actualPng: ra.png() } : { expectedPng: re!.png() }),
      });
      continue;
    }
    const w = Math.max(ra.width, re.width);
    const h = Math.max(ra.height, re.height);
    const sizeDiffers = ra.width !== re.width || ra.height !== re.height;
    const ia = padTo(ra, w, h);
    const ie = padTo(re, w, h);
    const boxes = paintMasks(ia, ra, w, h, masks);
    paintMasks(ie, re, w, h, masks);
    const diff = new Uint8Array(w * h * 4);
    const diffPixels = pixelmatch(ia, ie, diff, w, h, { threshold, includeAA: o.includeAA ?? false, alpha: 0.2, diffColor: [220, 0, 0] });
    // Show the masked regions on the diff image (light blue), so a reviewer sees what was ignored.
    for (const [x0, y0, x1, y1] of boxes) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          diff[i] = 170;
          diff[i + 1] = 200;
          diff[i + 2] = 255;
          diff[i + 3] = 255;
        }
      }
    }
    const diffRatio = diffPixels / (w * h);
    const withinRatio = o.maxDiffPixels !== undefined ? diffPixels <= o.maxDiffPixels : diffRatio <= (o.maxDiffRatio ?? 0);
    const passed = !sizeDiffers && withinRatio;
    pages.push({
      page: p, width: w, height: h, diffPixels, diffRatio, passed, ...(sizeDiffers ? { problem: 'size-differs' as const } : {}),
      expectedPng: encodePng(ie, w, h), actualPng: encodePng(ia, w, h), diffPng: encodePng(diff, w, h),
    });
  }
  const failed = pages.filter((p) => !p.passed);
  const countDiffers = a.length !== e.length;
  const passed = !countDiffers && failed.length === 0;
  const pct = (r: number) => `${(r * 100).toFixed(r < 0.001 ? 4 : 2)}%`;
  const summary = passed
    ? `${pages.length} page(s) look alike (largest difference ${pct(Math.max(0, ...pages.map((p) => p.diffRatio)))})`
    : [
        countDiffers ? `page count differs: ${a.length} vs ${e.length} expected` : '',
        ...failed.map((p) => (p.problem === 'missing-in-actual' ? `page ${p.page} is missing` : p.problem === 'missing-in-expected' ? `page ${p.page} is extra` : p.problem === 'size-differs' ? `page ${p.page} has a different size` : `page ${p.page} differs in ${p.diffPixels} pixels (${pct(p.diffRatio)})`)),
      ].filter(Boolean).join('; ');
  return {
    passed, pageCount: { actual: a.length, expected: e.length }, pages,
    options: { dpi, threshold, ...(o.maxDiffPixels !== undefined ? { maxDiffPixels: o.maxDiffPixels } : { maxDiffRatio: o.maxDiffRatio ?? 0 }), masks },
    summary,
  };
}

/** The result without images (for JSON evidence and the ledger). */
export function visualResultSummary(r: VisualCompareResult): Record<string, unknown> {
  return {
    passed: r.passed, summary: r.summary, pageCount: r.pageCount, options: r.options,
    pages: r.pages.map(({ expectedPng: _e, actualPng: _a, diffPng: _d, ...rest }) => rest),
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Self-contained HTML report: expected, actual and diff image per page (failing pages first). */
export function renderVisualHtml(r: VisualCompareResult, o: { title?: string; actualName?: string; expectedName?: string; allPages?: boolean } = {}): string {
  const img = (b?: Buffer) => (b ? `<img alt="" src="data:image/png;base64,${b.toString('base64')}">` : '<div class="none">no page</div>');
  const shown = [...r.pages].sort((x, y) => Number(x.passed) - Number(y.passed) || x.page - y.page).filter((p) => o.allPages || !p.passed || r.pages.length <= 3);
  const rows = shown.map((p) => `<section class="${p.passed ? 'pass' : 'fail'}"><h2>Page ${p.page}: ${p.passed ? 'PASS' : 'FAIL'} - ${p.diffPixels} px (${(p.diffRatio * 100).toFixed(4)}%)${p.problem ? ` - ${esc(p.problem)}` : ''}</h2>
<div class="grid"><figure><figcaption>Expected${o.expectedName ? `: ${esc(o.expectedName)}` : ''}</figcaption>${img(p.expectedPng)}</figure><figure><figcaption>Actual${o.actualName ? `: ${esc(o.actualName)}` : ''}</figcaption>${img(p.actualPng)}</figure><figure><figcaption>Difference (red; masked regions blue)</figcaption>${img(p.diffPng)}</figure></div></section>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title ?? 'Visual document comparison')}</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#222}h1{font-size:20px}.verdict{font-weight:600}.pass h2{color:#17663a}.fail h2{color:#a4161a}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}img{max-width:100%;border:1px solid #ccc}figcaption{font-size:12px;color:#555}.none{padding:24px;border:1px dashed #aaa;text-align:center}</style></head>
<body><h1>${esc(o.title ?? 'Visual document comparison')}</h1><p class="verdict">${r.passed ? 'PASS' : 'FAIL'}: ${esc(r.summary)}</p>
<p>Pages: actual ${r.pageCount.actual}, expected ${r.pageCount.expected}. ${r.options.dpi} dpi, threshold ${r.options.threshold}, tolerance ${r.options.maxDiffPixels !== undefined ? `${r.options.maxDiffPixels} px` : `${((r.options.maxDiffRatio ?? 0) * 100).toFixed(3)}%`}, ${r.options.masks.length} mask(s).</p>
${rows}</body></html>`;
}

/**
 * Parse mask text from a step: "page 1 400,60,150,20", "400,60,150,20 on page 2", several joined
 * by "and", "," between regions is not allowed (use "and" or ";").
 */
export function parseMasks(text: string): VisualMask[] {
  const out: VisualMask[] = [];
  const parts = text.split(/\s*(?:;|\band\b)\s*/i).filter(Boolean);
  for (const part of parts) {
    const m = /^(?:(?:the\s+)?region\s+)?(?:page\s+(\d+)\s+)?(?:at\s+)?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s+on\s+page\s+(\d+))?$/i.exec(part.trim());
    if (!m) throw new EzTestError(`Cannot read mask "${part}": write x,y,width,height in points from the top-left, optionally "page N" first or "on page N" after`, 'DOCS_VISUAL_MASK');
    const page = m[1] ?? m[6];
    out.push({ ...(page ? { page: Number(page) } : {}), x: Number(m[2]), y: Number(m[3]), width: Number(m[4]), height: Number(m[5]) });
  }
  return out;
}
