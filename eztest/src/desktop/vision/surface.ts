/**
 * The pixels-only rung: a screen (VNC/Citrix session, the browser page for
 * canvas apps, a desktop agent's screen, an Electron window, or a still
 * image) read with OCR and image templates, acted on by coordinates. Every
 * step records which rung acted (ocr / image / coordinates) and stores the
 * screenshot with the match boxes drawn in.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Condition, ConditionResult, Step } from '../../core/index.js';
import { analyzeDescription } from '../../intent/target.js';
import type { ConditionEnv } from '../../runner/conditions.js';
import type { InterceptorRuntime } from '../../runner/surface.js';
import type { StepContext } from '../../runner/types.js';
import { evaluateTextConditions, unsupported, type ActResult, type DesktopSurface, type SurfaceCapture } from '../surface.js';
import { annotate, cropPng, grayFromPng, type Box } from './image.js';
import { findText, wordsToText, type OcrEngine, type OcrWord, type TextHit } from './ocr.js';
import { findTemplate, type TemplateMatch } from './template.js';

/** Where the pixels come from and where clicks go. Coordinates are screen pixels of `capture()`. */
export interface ScreenSource {
  readonly name: string;
  capture(): Promise<Buffer>;
  click(x: number, y: number, o?: { button?: 'left' | 'right' | 'middle'; double?: boolean }): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  close?(): Promise<void>;
}

export interface VisionOptions {
  /** Base directory for image templates. */
  imagesDir: string;
  threshold: number;
  scales: number[];
  minConfidence: number;
  waitMs: number;
}

export class VisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionError';
  }
}

const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

export class VisionSurface implements DesktopSurface {
  readonly kind = 'vision' as const;
  private last?: { png: Buffer; boxes: Box[]; marks: Array<{ x: number; y: number }>; words?: OcrWord[] };

  constructor(
    readonly source: ScreenSource,
    readonly ocr: OcrEngine | undefined,
    readonly o: VisionOptions,
  ) {}

  get label(): string {
    return `screen "${this.source.name}"`;
  }

  accepts(step: Step): boolean {
    return ['click', 'dblclick', 'fill', 'press', 'capture', 'assert', 'hover', 'check', 'uncheck', 'select', 'clear'].includes(step.action);
  }

  async shot(): Promise<Buffer> {
    const png = await this.source.capture();
    this.last = { png, boxes: [], marks: [] };
    return png;
  }

  private needOcr(): OcrEngine {
    if (!this.ocr) throw new VisionError('OCR is not available: install the optional peer dependency tesseract.js and @tesseract.js-data/eng');
    return this.ocr;
  }

  async words(png?: Buffer): Promise<OcrWord[]> {
    const p = png ?? (await this.shot());
    const w = await this.needOcr().recognize(p);
    if (this.last && this.last.png === p) this.last.words = w;
    return w;
  }

  /** Exactly one occurrence of `text` on screen (OCR), polling up to `waitMs`. */
  async locateText(text: string, waitMs = 0, region?: Box): Promise<TextHit> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const png = await this.shot();
      const words = await this.words(png);
      let hits = findText(words, text, this.o.minConfidence);
      if (region) hits = hits.filter((h) => h.box.x >= region.x && h.box.y >= region.y && h.box.x + h.box.width <= region.x + region.width && h.box.y + h.box.height <= region.y + region.height);
      if (hits.length === 1) {
        this.last!.boxes.push(hits[0].box);
        return hits[0];
      }
      if (hits.length > 1) {
        this.last!.boxes.push(...hits.map((h) => h.box));
        throw new VisionError(`"${text}" appears ${hits.length} times on ${this.label} (${hits.map((h) => `${h.box.x},${h.box.y}`).join('; ')}); narrow it to a region`);
      }
      if (Date.now() >= deadline) throw new VisionError(`"${text}" was not found on ${this.label} by OCR (read: ${JSON.stringify(wordsToText(words).slice(0, 200))})`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private imagePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.o.imagesDir, p);
  }

  /** Exactly one match of an image template, polling up to `waitMs`. */
  async locateImage(image: string, waitMs = 0): Promise<TemplateMatch> {
    let tpl;
    try {
      tpl = grayFromPng(await readFile(this.imagePath(image)));
    } catch (e) {
      throw new VisionError(`cannot read image template "${image}" (${(e as Error).message.split('\n')[0]})`);
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const png = await this.shot();
      const matches = findTemplate(grayFromPng(png), tpl, { threshold: this.o.threshold, scales: this.o.scales });
      if (matches.length === 1 || (matches.length > 1 && matches[0].score - matches[1].score >= 0.05)) {
        this.last!.boxes.push(matches[0]);
        return matches[0];
      }
      if (matches.length > 1) {
        this.last!.boxes.push(...matches);
        throw new VisionError(`image "${image}" matches ${matches.length} places on ${this.label} (scores ${matches.map((m) => m.score.toFixed(3)).join(', ')})`);
      }
      if (Date.now() >= deadline) throw new VisionError(`image "${image}" was not found on ${this.label} (threshold ${this.o.threshold}, scales ${this.o.scales.join('/')})`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async clickAt(x: number, y: number, o: { button?: 'left' | 'right' | 'middle'; double?: boolean } = {}): Promise<void> {
    this.last?.marks.push({ x, y });
    await this.source.click(Math.round(x), Math.round(y), o);
  }

  textResult(h: TextHit, via: string, extra: Partial<ActResult> = {}): ActResult {
    return { surface: { driver: 'vision', rung: 'ocr', via: `${via} (confidence ${Math.round(h.confidence)})`, box: h.box }, usedLocator: { strategy: 'text', value: h.text }, ...extra };
  }

  imageResult(m: TemplateMatch, image: string, extra: Partial<ActResult> = {}): ActResult {
    return { surface: { driver: 'vision', rung: 'image', via: `image "${image}" score ${m.score} at ${Math.round(m.scale * 100)}%`, box: { x: m.x, y: m.y, width: m.width, height: m.height } }, usedLocator: { strategy: 'altText', value: image }, ...extra };
  }

  /** Read the text in a region (or the whole screen). */
  async read(region?: Box): Promise<string> {
    const png = await this.shot();
    const part = region ? cropPng(png, region) : png;
    if (region) this.last!.boxes.push(region);
    return wordsToText(await this.needOcr().recognize(part)).trim();
  }

  async act(step: Step, ctx: StepContext, _rt: InterceptorRuntime): Promise<ActResult | undefined> {
    const v = (s: string | undefined) => ctx.interpolate(s ?? '');
    const nameOf = () => {
      const d = step.target!.description;
      return analyzeDescription(d).name ?? d.replace(/^the\s+/i, '');
    };
    switch (step.action) {
      case 'click':
      case 'dblclick': {
        const name = nameOf();
        const h = await this.locateText(name, Math.min(this.o.waitMs, step.timeoutMs ?? 5000));
        const c = center(h.box);
        await this.clickAt(c.x, c.y, { double: step.action === 'dblclick', ...(step.args?.button ? { button: step.args.button as 'right' } : {}) });
        return this.textResult(h, `text "${name}"`, { newScreen: true });
      }
      case 'fill': {
        // No object tree: click to the right of the field's label, then type (an OCR anchor).
        const name = nameOf();
        const h = await this.locateText(name, Math.min(this.o.waitMs, step.timeoutMs ?? 5000));
        const x = h.box.x + h.box.width + Math.max(30, h.box.height * 2);
        const y = h.box.y + h.box.height / 2;
        await this.clickAt(x, y);
        await this.source.type(v(step.value));
        return this.textResult(h, `field right of label "${name}"`);
      }
      case 'press':
        await this.source.key(v(step.value));
        return { surface: { driver: 'vision', rung: 'coordinates', via: `key ${v(step.value)}` }, newScreen: true };
      case 'capture': {
        if (!step.target || !step.captureAs) return unsupported(this, step);
        const name = nameOf();
        const h = await this.locateText(name);
        // The value to the right of the label on the same line.
        const words = this.last?.words ?? [];
        const line = words.filter((w) => Math.abs(w.box.y + w.box.height / 2 - (h.box.y + h.box.height / 2)) < h.box.height && w.box.x > h.box.x + h.box.width);
        const value = line.sort((a, b) => a.box.x - b.box.x).map((w) => w.text).join(' ').replace(/^[:=\s]+/, '');
        return this.textResult(h, `text right of "${name}"`, { captured: { [step.captureAs]: value } });
      }
      case 'assert':
        return { surface: { driver: 'vision', rung: 'ocr', via: 'screen' } };
      default:
        return unsupported(this, step);
    }
  }

  async evaluate(c: Condition, env: ConditionEnv): Promise<ConditionResult | undefined> {
    return evaluateTextConditions(c, env, {
      label: this.label,
      screenText: async () => wordsToText(await this.words()),
      elementText: async (t) => {
        const name = analyzeDescription(t.description).name ?? t.description;
        const hits = findText(await this.words(), name, this.o.minConfidence);
        return hits.length ? hits[0].text : undefined;
      },
    });
  }

  async capture(): Promise<SurfaceCapture> {
    const last = this.last ?? { png: await this.source.capture(), boxes: [], marks: [] };
    const img = last.boxes.length || last.marks.length ? annotate(last.png, last.boxes, last.marks) : last.png;
    return {
      image: { data: img, ext: 'png' },
      snapshot: { data: JSON.stringify({ source: this.source.name, matches: last.boxes, clicks: last.marks, ...(last.words ? { text: wordsToText(last.words) } : {}) }, null, 2), ext: 'json', description: 'screen matches' },
    };
  }

  async close(): Promise<void> {
    await this.ocr?.close();
    await this.source.close?.();
  }
}
