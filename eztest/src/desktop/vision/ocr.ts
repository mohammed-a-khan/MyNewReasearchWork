/**
 * OCR for the pixels-only rung (Citrix/VDI, canvas apps): an `OcrEngine`
 * interface, a tesseract.js implementation (optional peer dependency,
 * Apache-2.0, runs locally in WebAssembly; no service is called), and
 * deterministic phrase search over the recognised words.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { grayFromPng, resize, type Box, type Gray } from './image.js';

export interface OcrWord {
  text: string;
  box: Box;
  /** 0..100 */
  confidence: number;
  /** Index of the text line the word belongs to. */
  line: number;
}

export interface OcrEngine {
  recognize(png: Buffer): Promise<OcrWord[]>;
  close(): Promise<void>;
}

export interface TesseractOptions {
  lang?: string;
  /** Directory with <lang>.traineddata(.gz). Default: the @tesseract.js-data/<lang> package (4.0.0_best_int). */
  langPath?: string;
  /** Where tesseract.js caches language data. */
  cachePath?: string;
  /** Resolve packages from this directory (the project). */
  baseDir?: string;
  /** Tesseract page segmentation mode. Default 11 (sparse text): UI screens are scattered labels, not pages. */
  pageSegMode?: number;
  /** Upscale factor before recognition (small UI fonts read better at 2x). Default 2. */
  upscale?: number;
  /** Also read a polarity-normalised image, so light text on dark bars and buttons is found. Default true. */
  invert?: boolean;
}

function grayPng(g: Gray, invert: boolean): Buffer {
  const png = new PNG({ width: g.width, height: g.height });
  for (let i = 0; i < g.data.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(invert ? 255 - g.data[i] : g.data[i])));
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * Polarity normalisation: where the local background (a wide window mean) is
 * dark, the pixel is inverted, so light text on dark title bars and buttons
 * becomes dark text on a light background, which Tesseract reads best.
 */
export function normalizePolarity(g: Gray, radius = 24, pivot = 150): Gray {
  const W = g.width + 1;
  const ii = new Float64Array(W * (g.height + 1));
  for (let y = 0; y < g.height; y++) {
    let row = 0;
    for (let x = 0; x < g.width; x++) {
      row += g.data[y * g.width + x];
      ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(g.data.length);
  for (let y = 0; y < g.height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(g.height, y + radius + 1);
    for (let x = 0; x < g.width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(g.width, x + radius + 1);
      const mean = (ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
      const v = g.data[y * g.width + x];
      out[y * g.width + x] = mean < pivot ? 255 - v : v;
    }
  }
  return { width: g.width, height: g.height, data: out };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

interface TWord { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface TWorker {
  recognize(img: Buffer, o: object, out: object): Promise<{ data: { blocks?: Array<{ paragraphs: Array<{ lines: Array<{ words: TWord[] }> }> }> | null } }>;
  setParameters(p: Record<string, string>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

/** The language data directory of an installed @tesseract.js-data/<lang> package, if any. */
export function defaultLangPath(lang: string, baseDir = process.cwd()): string | undefined {
  try {
    const req = createRequire(join(baseDir, 'package.json'));
    const dir = dirname(req.resolve(`@tesseract.js-data/${lang}/package.json`));
    for (const v of ['4.0.0_best_int', '4.0.0']) if (existsSync(join(dir, v, `${lang}.traineddata.gz`))) return join(dir, v);
  } catch {
    /* not installed */
  }
  return undefined;
}

export class TesseractOcr implements OcrEngine {
  private worker?: Promise<TWorker>;

  constructor(private readonly o: TesseractOptions = {}) {}

  private async start(): Promise<TWorker> {
    const lang = this.o.lang ?? 'eng';
    let mod: { createWorker(lang: string, oem: number, o: object): Promise<TWorker> };
    try {
      const req = createRequire(join(this.o.baseDir ?? process.cwd(), 'package.json'));
      mod = (await import(req.resolve('tesseract.js'))) as typeof mod;
      if (typeof mod.createWorker !== 'function') mod = (mod as unknown as { default: typeof mod }).default;
    } catch {
      throw new Error('OCR needs the optional peer dependency tesseract.js (npm i -D tesseract.js @tesseract.js-data/eng)');
    }
    const langPath = this.o.langPath ?? defaultLangPath(lang, this.o.baseDir);
    if (!langPath) throw new Error(`no OCR language data for "${lang}": install @tesseract.js-data/${lang} or set citrix.ocr.langPath (EZTest never downloads it at run time)`);
    const w = await mod.createWorker(lang, 1, { langPath, gzip: true, ...(this.o.cachePath ? { cachePath: this.o.cachePath } : { cacheMethod: 'none' }) });
    await w.setParameters({ tessedit_pageseg_mode: String(this.o.pageSegMode ?? 11), preserve_interword_spaces: '1' });
    return w;
  }

  async recognize(png: Buffer): Promise<OcrWord[]> {
    this.worker ??= this.start();
    const w = await this.worker;
    const k = this.o.upscale ?? 2;
    const g0 = grayFromPng(png);
    const g = k === 1 ? g0 : resize(g0, g0.width * k, g0.height * k);
    // Pass 1: the image as it is; pass 2: polarity-normalised (light-on-dark text). Words merge by position.
    const passes = [grayPng(g, false), ...(this.o.invert === false ? [] : [grayPng(normalizePolarity(g, 24 * k), false)])];
    const out: OcrWord[] = [];
    let line = 0;
    for (const img of passes) {
      const r = await w.recognize(img, {}, { blocks: true });
      for (const b of r.data.blocks ?? []) {
        for (const p of b.paragraphs) {
          for (const l of p.lines) {
            for (const wd of l.words) {
              const box = { x: wd.bbox.x0 / k, y: wd.bbox.y0 / k, width: (wd.bbox.x1 - wd.bbox.x0) / k, height: (wd.bbox.y1 - wd.bbox.y0) / k };
              const word = { text: wd.text, confidence: wd.confidence, line, box };
              const clash = out.findIndex((o) => overlaps(o.box, box));
              if (clash < 0) out.push(word);
              else if (out[clash].confidence < word.confidence) out[clash] = word;
            }
            line++;
          }
        }
      }
    }
    return out.sort((a, b) => a.line - b.line || a.box.x - b.box.x);
  }

  async close(): Promise<void> {
    if (!this.worker) return;
    const w = await this.worker.catch(() => undefined);
    this.worker = undefined;
    await w?.terminate();
  }
}

const tokenize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);

export interface TextHit {
  text: string;
  box: Box;
  confidence: number;
}

/** Every occurrence of `phrase` (consecutive words on one line; case and punctuation ignored). */
export function findText(words: OcrWord[], phrase: string, minConfidence = 0): TextHit[] {
  const want = tokenize(phrase);
  if (!want.length) return [];
  const usable = words.filter((w) => w.confidence >= minConfidence && tokenize(w.text).length);
  const hits: TextHit[] = [];
  for (let i = 0; i < usable.length; i++) {
    const seq: OcrWord[] = [];
    const toks: string[] = [];
    for (let j = i; j < usable.length && usable[j].line === usable[i].line && toks.length < want.length; j++) {
      seq.push(usable[j]);
      toks.push(...tokenize(usable[j].text));
    }
    if (toks.slice(0, want.length).join(' ') !== want.join(' ')) continue;
    const x0 = Math.min(...seq.map((w) => w.box.x));
    const y0 = Math.min(...seq.map((w) => w.box.y));
    const x1 = Math.max(...seq.map((w) => w.box.x + w.box.width));
    const y1 = Math.max(...seq.map((w) => w.box.y + w.box.height));
    hits.push({ text: seq.map((w) => w.text).join(' '), box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, confidence: Math.min(...seq.map((w) => w.confidence)) });
  }
  return hits;
}

/** Words as lines of text (for "the screen contains" and evidence). */
export function wordsToText(words: OcrWord[]): string {
  const lines = new Map<number, string[]>();
  for (const w of words) lines.set(w.line, [...(lines.get(w.line) ?? []), w.text]);
  return [...lines.values()].map((l) => l.join(' ')).join('\n');
}
