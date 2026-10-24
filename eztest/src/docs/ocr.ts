/**
 * OCR for scanned / image-only PDF pages. Pages are rendered with pdfjs onto
 * an @napi-rs/canvas canvas (src/docs/render.ts) and read by tesseract.js
 * (optional peer dependency, Apache-2.0, runs locally in WebAssembly; no
 * service is called, and language data is never downloaded at run time).
 * Recognised words become positioned TextItems in PDF points, so line
 * grouping, field and table templates work on OCR output exactly as on a
 * text layer; each item keeps the recogniser's confidence.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { EzTestError } from '../core/index.js';
import type { TextItem } from './model.js';
import { round2 } from './model.js';
import type { RenderedPage } from './render.js';

/** One recognised word, pixel coordinates of the image it was read from. */
export interface OcrWordBox {
  text: string;
  /** 0..100 */
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Index of the recognised text line. */
  line: number;
  /** Baseline y (pixels) of the word's line at the word's centre, when the recogniser reports it. */
  baseline?: number;
  /** Line height (ascender to descender) in pixels, when reported. */
  lineHeight?: number;
}

export interface DocOcrEngine {
  /** Recognise the words of a PNG image. */
  recognize(png: Buffer): Promise<OcrWordBox[]>;
  /**
   * Optional second look at one region (pixels) as a single text line, limited to `whitelist`
   * characters: used to re-read numeric values a page-level pass got wrong (a lone "1" read as "il").
   */
  recognizeRegion?(png: Buffer, rect: { left: number; top: number; width: number; height: number }, o?: { whitelist?: string }): Promise<{ text: string; confidence: number }>;
  close(): Promise<void>;
}

export interface DocOcrOptions {
  /** Tesseract language(s), e.g. "eng" or "eng+deu". Default "eng". */
  lang?: string;
  /** Directory with <lang>.traineddata(.gz). Default: the installed @tesseract.js-data/<lang> package. */
  langPath?: string;
  /** Resolve tesseract.js and language data from this directory (the project). Default process.cwd(). */
  baseDir?: string;
  /** Rendering resolution for OCR. Default 300 dpi. */
  dpi?: number;
  /** Tesseract page segmentation mode. Default 3 (fully automatic page layout), right for document pages. */
  pageSegMode?: number;
  /** Words below this confidence (0..100) are dropped. Default 30. */
  minConfidence?: number;
  /** A ready engine (tests, a custom OCR service adapter). */
  engine?: DocOcrEngine;
}

/** Language data directory of an installed @tesseract.js-data/<lang> package. */
export function ocrLangPath(lang: string, baseDir = process.cwd()): string | undefined {
  for (const from of [join(baseDir, 'package.json'), import.meta.url]) {
    try {
      const dir = dirname(createRequire(from).resolve(`@tesseract.js-data/${lang}/package.json`));
      for (const v of ['4.0.0_best_int', '4.0.0']) if (existsSync(join(dir, v, `${lang}.traineddata.gz`))) return join(dir, v);
    } catch {
      /* next */
    }
  }
  return undefined;
}

interface TWord { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface TLine {
  words: TWord[];
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  baseline?: { x0: number; y0: number; x1: number; y1: number; has_baseline?: boolean };
  rowAttributes?: { row_height?: number; descenders?: number; ascenders?: number };
}
interface TWorker {
  recognize(img: Buffer, o: object, out: object): Promise<{ data: { blocks?: Array<{ paragraphs: Array<{ lines: TLine[] }> }> | null } }>;
  setParameters(p: Record<string, string>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

/** tesseract.js engine for document pages. */
export class TesseractDocOcr implements DocOcrEngine {
  private worker?: Promise<TWorker>;

  constructor(private readonly o: DocOcrOptions = {}) {}

  private async start(): Promise<TWorker> {
    const lang = this.o.lang ?? 'eng';
    const baseDir = this.o.baseDir ?? process.cwd();
    let mod: { createWorker(lang: string, oem: number, o: object): Promise<TWorker> } | undefined;
    for (const from of [join(baseDir, 'package.json'), import.meta.url]) {
      try {
        const m = (await import(createRequire(from).resolve('tesseract.js'))) as typeof mod & { default?: typeof mod };
        mod = typeof m?.createWorker === 'function' ? m : m?.default;
        if (mod) break;
      } catch {
        /* next */
      }
    }
    if (!mod) {
      throw new EzTestError('OCR of scanned PDF pages needs the optional peer dependency tesseract.js, which is not installed. Run: npm install -D tesseract.js @tesseract.js-data/eng', 'DOCS_OCR_MISSING', { package: 'tesseract.js' });
    }
    const langs = lang.split('+');
    const langPath = this.o.langPath ?? ocrLangPath(langs[0], baseDir);
    if (!langPath || (!this.o.langPath && langs.some((l) => !ocrLangPath(l, baseDir)))) {
      throw new EzTestError(`No OCR language data for "${lang}": install @tesseract.js-data/${langs[0]} or set langPath (EZTest never downloads language data at run time)`, 'DOCS_OCR_LANG');
    }
    const w = await mod.createWorker(lang, 1, { langPath, gzip: true, cacheMethod: 'none' });
    // The rendering resolution is known: telling Tesseract avoids its guess (and its console note).
    await w.setParameters({ tessedit_pageseg_mode: String(this.o.pageSegMode ?? 3), preserve_interword_spaces: '1', user_defined_dpi: String(Math.round(this.o.dpi ?? 300)) });
    return w;
  }

  async recognize(png: Buffer): Promise<OcrWordBox[]> {
    this.worker ??= this.start();
    let w: TWorker;
    try {
      w = await this.worker;
    } catch (e) {
      this.worker = undefined;
      throw e;
    }
    const r = await w.recognize(png, {}, { blocks: true });
    const out: OcrWordBox[] = [];
    let line = 0;
    for (const b of r.data.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          const bl = l.baseline && l.baseline.has_baseline !== false && l.baseline.x1 !== l.baseline.x0 ? l.baseline : undefined;
          const lh = l.rowAttributes?.row_height ? l.rowAttributes.row_height + (l.rowAttributes.descenders ?? 0) : undefined;
          for (const wd of l.words) {
            const text = wd.text.trim();
            if (!text) continue;
            const cx = (wd.bbox.x0 + wd.bbox.x1) / 2;
            const baseline = bl ? bl.y0 + ((bl.y1 - bl.y0) * (cx - bl.x0)) / (bl.x1 - bl.x0) : undefined;
            out.push({ text, confidence: wd.confidence, ...wd.bbox, line, ...(baseline !== undefined ? { baseline } : {}), ...(lh ? { lineHeight: lh } : {}) });
          }
          line++;
        }
      }
    }
    return out;
  }

  async recognizeRegion(png: Buffer, rect: { left: number; top: number; width: number; height: number }, o: { whitelist?: string } = {}): Promise<{ text: string; confidence: number }> {
    this.worker ??= this.start();
    const w = await this.worker;
    try {
      // One text line first; a single word, then a single character, when the line mode finds nothing.
      for (const psm of ['7', '8', '10']) {
        await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: o.whitelist ?? '' });
        const r = (await w.recognize(png, { rectangle: rect }, { text: true })) as unknown as { data: { text?: string; confidence?: number } };
        const text = (r.data.text ?? '').trim();
        if (text) return { text, confidence: r.data.confidence ?? 0 };
      }
      return { text: '', confidence: 0 };
    } finally {
      await w.setParameters({ tessedit_pageseg_mode: String(this.o.pageSegMode ?? 3), tessedit_char_whitelist: '' });
    }
  }

  async close(): Promise<void> {
    if (!this.worker) return;
    const w = await this.worker.catch(() => undefined);
    this.worker = undefined;
    await w?.terminate();
  }
}

/**
 * Turn OCR words of a rendered page into TextItems in PDF points (top-left origin for x/y,
 * bottom-left baseline like the text layer). Words of one recognised line share a baseline so
 * they group into one line; font size is estimated from the line's height.
 */
export function ocrWordsToItems(words: OcrWordBox[], page: Pick<RenderedPage, 'page' | 'scale' | 'heightPt'>, minConfidence = 30): TextItem[] {
  const byLine = new Map<number, OcrWordBox[]>();
  for (const w of words) {
    if (w.confidence < minConfidence) continue;
    byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
  }
  const items: TextItem[] = [];
  const k = page.scale;
  for (const ws of byLine.values()) {
    // Word boxes include descenders; the median box bottom of descender-free words is the baseline.
    const bottoms = ws.filter((w) => !/[gjpqy,;()[\]{}|@$]/.test(w.text)).map((w) => w.y1);
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const heights = ws.map((w) => w.y1 - w.y0);
    const capH = median(heights);
    // Box height of mixed text is ~ 0.72-0.95 of the font size; take the line height when reported.
    const sizePx = ws[0].lineHeight ? Math.max(capH, ws[0].lineHeight * 0.82) : capH / 0.78;
    const fontSize = round2(Math.max(4, sizePx / k));
    const baseLinePx = bottoms.length ? median(bottoms) : median(ws.map((w) => w.baseline ?? w.y1));
    for (const w of ws) {
      const x = w.x0 / k;
      const y = w.y0 / k;
      const width = (w.x1 - w.x0) / k;
      const height = (w.y1 - w.y0) / k;
      items.push({
        text: w.text,
        page: page.page,
        x: round2(x),
        y: round2(y),
        width: round2(width),
        height: round2(height),
        baseline: round2(page.heightPt - baseLinePx / k),
        fontName: 'OCR',
        fontSize,
        confidence: Math.round(w.confidence) / 100,
      });
    }
  }
  return items;
}
