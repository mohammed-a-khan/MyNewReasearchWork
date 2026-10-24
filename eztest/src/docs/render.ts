/**
 * PDF page rendering for OCR and visual comparison: pdfjs-dist draws each page
 * onto a canvas from @napi-rs/canvas (an optional dependency of pdfjs-dist, prebuilt,
 * no system libraries). Without that package, rendering fails with a clear
 * message naming it; text-layer extraction never needs it.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { EzTestError } from '../core/index.js';

export type PdfInput = Uint8Array | ArrayBuffer | string;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | undefined;
/** pdfjs-dist, loaded lazily: importing src/docs must not pay for pdfjs unless a PDF is read. */
export async function pdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export async function toBytes(input: PdfInput): Promise<{ bytes: Uint8Array; name?: string }> {
  if (typeof input === 'string') return { bytes: new Uint8Array(await readFile(input)), name: basename(input) };
  if (input instanceof ArrayBuffer) return { bytes: new Uint8Array(input) };
  return { bytes: input };
}

// ------------------------------------------------------------------ canvas peer

/** The subset of @napi-rs/canvas EZTest uses. */
export interface CanvasModule {
  createCanvas(width: number, height: number): CanvasLike;
}
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): Ctx2d;
  toBuffer(mime: 'image/png'): Buffer;
}
export interface Ctx2d {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: unknown, x: number, y: number, w?: number, h?: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
}

let canvasMod: CanvasModule | undefined;

/**
 * @napi-rs/canvas, resolved from the project first, then from EZTest's own install.
 * Throws DOCS_CANVAS_MISSING naming the package when neither has it.
 */
export function loadCanvas(baseDir = process.cwd()): CanvasModule {
  if (canvasMod) return canvasMod;
  for (const from of [join(baseDir, 'package.json'), import.meta.url]) {
    try {
      const req = createRequire(from);
      const mod = req('@napi-rs/canvas') as CanvasModule;
      if (typeof mod.createCanvas === 'function') return (canvasMod = mod);
    } catch {
      /* try the next location */
    }
  }
  throw new EzTestError(
    'Rendering PDF pages (OCR of scanned pages, visual document comparison) needs @napi-rs/canvas, which is not installed. pdfjs-dist normally installs it as an optional dependency; it is missing when optional dependencies were omitted or the platform has no prebuilt binary. Run: npm install -D @napi-rs/canvas',
    'DOCS_CANVAS_MISSING',
    { package: '@napi-rs/canvas' },
  );
}

/** True when @napi-rs/canvas can be loaded. */
export function canRender(baseDir?: string): boolean {
  try {
    loadCanvas(baseDir);
    return true;
  } catch {
    return false;
  }
}

/** pdfjs CanvasFactory backed by our loaded canvas module (so pdfjs never resolves it on its own). */
function canvasFactoryClass(mod: CanvasModule) {
  return class EzCanvasFactory {
    create(width: number, height: number) {
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      const canvas = mod.createCanvas(Math.ceil(width), Math.ceil(height));
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(cc: { canvas: CanvasLike }, width: number, height: number) {
      cc.canvas.width = Math.ceil(width);
      cc.canvas.height = Math.ceil(height);
    }
    destroy(cc: { canvas: CanvasLike | null; context: unknown }) {
      if (cc.canvas) {
        cc.canvas.width = 0;
        cc.canvas.height = 0;
      }
      cc.canvas = null;
      cc.context = null;
    }
  };
}

let fontDir: string | undefined;
function standardFontDir(): string | undefined {
  if (fontDir !== undefined) return fontDir || undefined;
  try {
    fontDir = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';
  } catch {
    fontDir = '';
  }
  return fontDir || undefined;
}

type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

/** Open a PDF with pdfjs. `render: true` adds the canvas factory and standard font data rendering needs. */
export async function openPdf(bytes: Uint8Array, o: { password?: string; render?: boolean; baseDir?: string } = {}): Promise<PdfDoc> {
  const lib = await pdfjs();
  const extra: Record<string, unknown> = {};
  if (o.render) {
    extra.CanvasFactory = canvasFactoryClass(loadCanvas(o.baseDir));
    const fonts = standardFontDir();
    if (fonts) extra.standardFontDataUrl = fonts;
  }
  // pdfjs transfers (detaches) the buffer it is given, so hand it a copy.
  const task = lib.getDocument({
    data: bytes.slice(),
    password: o.password,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    ...extra,
  });
  try {
    return await task.promise;
  } catch (e) {
    const err = e as Error;
    if (err?.name === 'PasswordException') throw new EzTestError('PDF is password protected (pass opts.password)', 'PDF_PASSWORD_REQUIRED');
    throw new EzTestError(`Could not parse PDF: ${err?.message ?? String(e)}`, 'PDF_PARSE_ERROR');
  }
}

// ------------------------------------------------------------------ rendering

export interface RenderedPage {
  page: number;
  /** Page size in PDF points. */
  widthPt: number;
  heightPt: number;
  /** Pixels per point. */
  scale: number;
  /** Pixel size. */
  width: number;
  height: number;
  /** RGBA pixels (white background). */
  rgba: Uint8ClampedArray;
  png(): Buffer;
}

export interface RenderOptions {
  /** Pixels per PDF point (1 = 72 dpi). Default 2. */
  scale?: number;
  /** Alternative to scale: dots per inch. */
  dpi?: number;
  /** 1-based page numbers to render (default: all). */
  pages?: number[];
  password?: string;
  baseDir?: string;
}

/** Render one page of an open document. */
export async function renderPage(pdf: PdfDoc, pageNo: number, scale: number, baseDir?: string): Promise<RenderedPage> {
  const mod = loadCanvas(baseDir);
  const page = await pdf.getPage(pageNo);
  try {
    const vp = page.getViewport({ scale });
    const w = Math.max(1, Math.ceil(vp.width));
    const h = Math.max(1, Math.ceil(vp.height));
    const canvas = mod.createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx as never, viewport: vp }).promise;
    const data = ctx.getImageData(0, 0, w, h).data;
    const [vx0, vy0, vx1, vy1] = page.view;
    return {
      page: pageNo, widthPt: vx1 - vx0, heightPt: vy1 - vy0, scale, width: w, height: h, rgba: data,
      png: () => canvas.toBuffer('image/png'),
    };
  } finally {
    page.cleanup();
  }
}

/** Render the pages of a PDF to RGBA pixels (and PNG on demand). */
export async function renderPdfPages(input: PdfInput, o: RenderOptions = {}): Promise<RenderedPage[]> {
  const { bytes } = await toBytes(input);
  const scale = o.dpi ? o.dpi / 72 : o.scale ?? 2;
  loadCanvas(o.baseDir);
  const pdf = await openPdf(bytes, { password: o.password, render: true, baseDir: o.baseDir });
  try {
    const want = o.pages ?? Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    const out: RenderedPage[] = [];
    for (const p of want) {
      if (p < 1 || p > pdf.numPages) throw new EzTestError(`Page ${p} does not exist (the PDF has ${pdf.numPages})`, 'PDF_PAGE');
      out.push(await renderPage(pdf, p, scale, o.baseDir));
    }
    return out;
  } finally {
    await pdf.destroy();
  }
}
