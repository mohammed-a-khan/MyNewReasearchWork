/**
 * Visual lens: screenshot vs baseline with pngjs + pixelmatch. Masked regions
 * (selectors or boxes) are painted identically in both images before diffing.
 * Size differences are reported explicitly (never silently cropped).
 * A missing baseline fails unless update mode is on.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from '../browser/index.js';
import { EzTestError, slugify } from '../core/index.js';
import { storeLensEvidence, type Lens, type LensContext, type LensResult, type LensStep } from './lens.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCompareOptions {
  /** pixelmatch per-pixel colour threshold 0..1. Default 0.1. */
  threshold?: number;
  /** Count anti-aliased pixels as differences. Default false (tolerated). */
  includeAA?: boolean;
  /** Allowed differing pixels. Default 0. */
  maxDiffPixels?: number;
  /** Allowed differing ratio 0..1 (checked in addition to maxDiffPixels). */
  maxDiffRatio?: number;
  /** Regions (in image pixels) to ignore. */
  maskBoxes?: Box[];
}

export type VisualStatus = 'match' | 'mismatch' | 'size-mismatch' | 'missing-baseline' | 'baseline-updated';

export interface ImageCompareResult {
  status: VisualStatus;
  passed: boolean;
  diffPixels: number;
  diffRatio: number;
  width: number;
  height: number;
  baselineSize?: { width: number; height: number };
  diffPng?: Buffer;
}

function paintMasks(png: PNG, boxes: Box[]): void {
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(png.width, Math.ceil(b.x + b.width));
    const y1 = Math.min(png.height, Math.ceil(b.y + b.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
    }
  }
}

export function compareImages(actual: Buffer, baseline: Buffer, opts: ImageCompareOptions = {}): ImageCompareResult {
  const a = PNG.sync.read(actual);
  const b = PNG.sync.read(baseline);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      status: 'size-mismatch',
      passed: false,
      diffPixels: Math.max(a.width * a.height, b.width * b.height),
      diffRatio: 1,
      width: a.width,
      height: a.height,
      baselineSize: { width: b.width, height: b.height },
    };
  }
  const threshold = opts.threshold ?? 0.1;
  if (!(threshold >= 0 && threshold <= 1)) throw new EzTestError('threshold must be within 0..1', 'INVALID_INPUT');
  if (opts.maskBoxes?.length) {
    paintMasks(a, opts.maskBoxes);
    paintMasks(b, opts.maskBoxes);
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold, includeAA: opts.includeAA ?? false });
  const total = a.width * a.height;
  const diffRatio = total ? diffPixels / total : 0;
  // Passes when within the pixel allowance OR within the ratio allowance (if one is set).
  const passed = diffPixels <= (opts.maxDiffPixels ?? 0) || (opts.maxDiffRatio !== undefined && diffRatio <= opts.maxDiffRatio);
  return {
    status: passed ? 'match' : 'mismatch',
    passed,
    diffPixels,
    diffRatio,
    width: a.width,
    height: a.height,
    diffPng: diffPixels > 0 ? PNG.sync.write(diff) : undefined,
  };
}

export interface VisualOptions extends Omit<ImageCompareOptions, 'maskBoxes'> {
  name: string;
  baselineDir: string;
  /** Where actual/diff images go. Default: baselineDir/../visual-output. */
  outputDir?: string;
  /** Selectors whose boxes are masked. */
  mask?: string[];
  maskBoxes?: Box[];
  /** Write the current screenshot as the new baseline. */
  update?: boolean;
  fullPage?: boolean;
}

export interface VisualResult extends Omit<ImageCompareResult, 'diffPng'> {
  name: string;
  baselinePath: string;
  actualPath?: string;
  diffPath?: string;
  maskedBoxes: Box[];
}

function safeName(name: string): string {
  if (!name) throw new EzTestError('visual comparison needs a name', 'INVALID_INPUT');
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.') ? name : slugify(name);
}

async function maskBoxesFor(page: Page, selectors: string[], fullPage: boolean): Promise<Box[]> {
  const dpr = Number(await page.evaluate('window.devicePixelRatio')) || 1;
  const scroll = fullPage ? ((await page.evaluate('[window.scrollX, window.scrollY]')) as [number, number]) : [0, 0];
  const boxes: Box[] = [];
  for (const sel of selectors) {
    const all = await page.locator(sel).all();
    if (all.length === 0) throw new EzTestError(`mask selector matched nothing: ${sel}`, 'MASK_NOT_FOUND');
    for (const loc of all) {
      const b = await loc.boundingBox();
      if (b) boxes.push({ x: (b.x + scroll[0]) * dpr, y: (b.y + scroll[1]) * dpr, width: b.width * dpr, height: b.height * dpr });
    }
  }
  return boxes;
}

/** Ignore regions kept next to the baselines: `{ "<baseline name>": Box[], "*": Box[] }` (edited from EZTest Studio). */
export const VISUAL_MASKS_FILE = 'masks.json';

export interface VisualMaskBox extends Box {
  /** Why the region is ignored (e.g. "clock", "ad banner"). */
  label?: string;
}

/** Read the ignore regions saved for a baseline directory (missing or unreadable file: none). */
export async function loadVisualMasks(baselineDir: string): Promise<Record<string, VisualMaskBox[]>> {
  const p = join(baselineDir, VISUAL_MASKS_FILE);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, VisualMaskBox[]> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      out[k] = v.filter((b): b is VisualMaskBox => !!b && typeof b === 'object' && ['x', 'y', 'width', 'height'].every((f) => Number.isFinite((b as Record<string, unknown>)[f])));
    }
    return out;
  } catch {
    return {};
  }
}

/** Ignore regions of one baseline: its own plus the global "*" regions. */
export async function masksFor(baselineDir: string, name: string): Promise<VisualMaskBox[]> {
  const all = await loadVisualMasks(baselineDir);
  return [...(all['*'] ?? []), ...(all[name] ?? [])];
}

export async function compareScreenshot(page: Page, opts: VisualOptions): Promise<VisualResult> {
  const name = safeName(opts.name);
  const outDir = opts.outputDir ?? join(opts.baselineDir, '..', 'visual-output');
  await mkdir(opts.baselineDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const baselinePath = join(opts.baselineDir, `${name}.png`);
  const fullPage = opts.fullPage ?? false;
  const shot = await page.screenshot({ fullPage, animations: 'disabled', caret: 'hide' });
  const saved = (await masksFor(opts.baselineDir, name)).map(({ x, y, width, height }) => ({ x, y, width, height }));
  const maskedBoxes = [...(opts.maskBoxes ?? []), ...saved, ...(opts.mask?.length ? await maskBoxesFor(page, opts.mask, fullPage) : [])];
  const png = PNG.sync.read(shot);
  if (opts.update) {
    await writeFile(baselinePath, shot);
    return { name, status: 'baseline-updated', passed: true, diffPixels: 0, diffRatio: 0, width: png.width, height: png.height, baselinePath, maskedBoxes };
  }
  const actualPath = join(outDir, `${name}.actual.png`);
  if (!existsSync(baselinePath)) {
    await writeFile(actualPath, shot);
    return { name, status: 'missing-baseline', passed: false, diffPixels: 0, diffRatio: 1, width: png.width, height: png.height, baselinePath, actualPath, maskedBoxes };
  }
  const res = compareImages(shot, await readFile(baselinePath), { ...opts, maskBoxes: maskedBoxes });
  const { diffPng, ...rest } = res;
  let diffPath: string | undefined;
  if (!res.passed) await writeFile(actualPath, shot);
  if (diffPng) {
    diffPath = join(outDir, `${name}.diff.png`);
    await writeFile(diffPath, diffPng);
  }
  return { ...rest, name, baselinePath, actualPath: res.passed ? undefined : actualPath, diffPath, maskedBoxes };
}

export function createVisualLens(opts: Omit<VisualOptions, 'name'>): Lens<VisualResult> {
  return {
    name: 'visual',
    async afterStep(page: Page, step: LensStep, ctx?: LensContext): Promise<LensResult<VisualResult>> {
      const res = await compareScreenshot(page, { ...opts, name: `${ctx?.journeyId ?? 'journey'}-${step.id}` });
      const evidence = await storeLensEvidence(ctx, 'visual', step, res);
      return {
        lens: 'visual',
        stepId: step.id,
        passed: res.passed,
        summary: `${res.status}: ${res.diffPixels} px differ (${(res.diffRatio * 100).toFixed(2)}%)`,
        evidence,
        data: res,
      };
    },
  };
}
