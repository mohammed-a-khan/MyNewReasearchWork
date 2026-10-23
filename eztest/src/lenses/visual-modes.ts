/**
 * Visual comparison modes on images (deterministic, no AI):
 *
 * - strict: per-pixel colour comparison (pixelmatch) with anti-alias tolerance;
 * - ignore-colors: grayscale edge maps compared with a one-pixel tolerance,
 *   so a colour change that keeps the shapes passes while moved, added or
 *   removed shapes fail;
 *
 * plus clustering of differing pixels into regions (for DOM-change grouping).
 * Layout and content modes compare DOM snapshots (see visual-dom.ts); content
 * mode also uses the ignore-colors image check.
 */
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { EzTestError } from '../core/index.js';
import type { Box } from './visual.js';

export type VisualMode = 'strict' | 'layout' | 'content' | 'ignore-colors';
export const VISUAL_MODES: VisualMode[] = ['strict', 'layout', 'content', 'ignore-colors'];

export interface ModeCompareOptions {
  mode?: 'strict' | 'ignore-colors';
  /** pixelmatch colour threshold 0..1 (strict). Default 0.1. */
  threshold?: number;
  /** Anti-aliasing: "tolerate" (default) ignores anti-aliased pixels; "strict" counts them. */
  antiAlias?: 'tolerate' | 'strict';
  maxDiffPixels?: number;
  maxDiffRatio?: number;
  /** Regions (image pixels) painted identically in both images before comparing. */
  maskBoxes?: Box[];
}

export interface ModeCompareResult {
  status: 'match' | 'mismatch' | 'size-mismatch';
  passed: boolean;
  diffPixels: number;
  diffRatio: number;
  width: number;
  height: number;
  baselineSize?: { width: number; height: number };
  diffPng?: Buffer;
  /** Per-pixel difference mask (1 = differs), for region clustering. */
  mask?: Uint8Array;
}

function paint(png: PNG, boxes: Box[]): void {
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

/** Luminance (0..255) per pixel, alpha blended on white. */
export function grayscale(png: PNG): Float32Array {
  const out = new Float32Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    const a = png.data[i * 4 + 3] / 255;
    const r = png.data[i * 4] * a + 255 * (1 - a);
    const g = png.data[i * 4 + 1] * a + 255 * (1 - a);
    const b = png.data[i * 4 + 2] * a + 255 * (1 - a);
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

/** Binary edge map (Sobel gradient magnitude above `level`). */
export function edges(gray: Float32Array, w: number, h: number, level = 48): Uint8Array {
  const out = new Uint8Array(w * h);
  const at = (x: number, y: number) => gray[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      if (Math.hypot(gx, gy) >= level) out[y * w + x] = 1;
    }
  }
  return out;
}

function near(map: Uint8Array, w: number, h: number, x: number, y: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      if (xx >= 0 && xx < w && map[yy * w + xx]) return true;
    }
  }
  return false;
}

/** Compare two PNGs in strict or ignore-colors mode. */
export function compareImagesByMode(actual: Buffer, baseline: Buffer, o: ModeCompareOptions = {}): ModeCompareResult {
  const a = PNG.sync.read(actual);
  const b = PNG.sync.read(baseline);
  if (a.width !== b.width || a.height !== b.height) {
    return { status: 'size-mismatch', passed: false, diffPixels: Math.max(a.width * a.height, b.width * b.height), diffRatio: 1, width: a.width, height: a.height, baselineSize: { width: b.width, height: b.height } };
  }
  const threshold = o.threshold ?? 0.1;
  if (!(threshold >= 0 && threshold <= 1)) throw new EzTestError('threshold must be within 0..1', 'INVALID_INPUT');
  if (o.maskBoxes?.length) {
    paint(a, o.maskBoxes);
    paint(b, o.maskBoxes);
  }
  const w = a.width;
  const h = a.height;
  const mask = new Uint8Array(w * h);
  const diff = new PNG({ width: w, height: h });
  let diffPixels = 0;
  if ((o.mode ?? 'strict') === 'strict') {
    diffPixels = pixelmatch(a.data, b.data, diff.data, w, h, { threshold, includeAA: o.antiAlias === 'strict', diffMask: false });
    // pixelmatch paints differing pixels red (255, 0, 0); anti-aliased ones yellow.
    for (let i = 0; i < w * h; i++) if (diff.data[i * 4] === 255 && diff.data[i * 4 + 1] === 0 && diff.data[i * 4 + 2] === 0) mask[i] = 1;
  } else {
    const ea = edges(grayscale(a), w, h);
    const eb = edges(grayscale(b), w, h);
    const r = o.antiAlias === 'strict' ? 0 : 1;
    const gray = grayscale(b);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const y = (i - x) / w;
      const differs = (ea[i] && !near(eb, w, h, x, y, r)) || (eb[i] && !near(ea, w, h, x, y, r));
      const v = Math.round(255 - (255 - gray[i]) * 0.15);
      if (differs) {
        mask[i] = 1;
        diffPixels++;
        diff.data.set([255, 0, 0, 255], i * 4);
      } else diff.data.set([v, v, v, 255], i * 4);
    }
  }
  const total = w * h;
  const diffRatio = total ? diffPixels / total : 0;
  const passed = diffPixels <= (o.maxDiffPixels ?? 0) || (o.maxDiffRatio !== undefined && diffRatio <= o.maxDiffRatio);
  return { status: passed ? 'match' : 'mismatch', passed, diffPixels, diffRatio, width: w, height: h, diffPng: diffPixels > 0 ? PNG.sync.write(diff) : undefined, mask };
}

/**
 * Cluster differing pixels into rectangular regions: the mask is reduced to
 * `cell`-pixel cells and 8-connected cells (with a one-cell gap allowed) form a region.
 */
export function diffRegions(mask: Uint8Array, width: number, height: number, cell = 8): Array<Box & { pixels: number }> {
  const cw = Math.ceil(width / cell);
  const ch = Math.ceil(height / cell);
  const counts = new Uint32Array(cw * ch);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) counts[Math.floor(y / cell) * cw + Math.floor(x / cell)]++;
  const seen = new Uint8Array(cw * ch);
  const out: Array<Box & { pixels: number }> = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    let pixels = 0;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cw;
      const cy = (c - cx) / cw;
      pixels += counts[c];
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (counts[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    out.push({ x: x0 * cell, y: y0 * cell, width: Math.min(width, (x1 + 1) * cell) - x0 * cell, height: Math.min(height, (y1 + 1) * cell) - y0 * cell, pixels });
  }
  return out.sort((p, q) => q.pixels - p.pixels);
}
