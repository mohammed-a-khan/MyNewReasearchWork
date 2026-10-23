/**
 * Deterministic image template matching: zero-mean normalised
 * cross-correlation (NCC) over grayscale, tried at several scales (DPI
 * differences: 100%, 125%, 150% ...). A coarse pass on downsampled images
 * proposes candidates; a full-resolution pass in their neighbourhood scores
 * them exactly. Scores are in [-1, 1]; 1 is a perfect match.
 */
import { resize, type Box, type Gray } from './image.js';

export interface TemplateMatch extends Box {
  score: number;
  /** Scale of the template that matched (1 = as stored). */
  scale: number;
}

export interface MatchOptions {
  /** Minimum NCC score (default 0.9). */
  threshold?: number;
  /** Template scales to try (default [1, 1.25, 1.5, 0.8, 2]). */
  scales?: number[];
  /** Search only this region of the screen. */
  region?: Box;
  /** Keep at most this many matches (default 10). */
  max?: number;
}

/** Integral images of values and squares, for O(1) window mean/variance. */
function integrals(g: Gray): { s: Float64Array; q: Float64Array } {
  const w = g.width + 1;
  const s = new Float64Array(w * (g.height + 1));
  const q = new Float64Array(w * (g.height + 1));
  for (let y = 0; y < g.height; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < g.width; x++) {
      const v = g.data[y * g.width + x];
      rs += v;
      rq += v * v;
      s[(y + 1) * w + x + 1] = s[y * w + x + 1] + rs;
      q[(y + 1) * w + x + 1] = q[y * w + x + 1] + rq;
    }
  }
  return { s, q };
}

interface Prepared {
  t: Float32Array;
  w: number;
  h: number;
  /** sqrt(sum((t - mean)^2)) */
  norm: number;
}

function prepare(t: Gray): Prepared | undefined {
  const n = t.width * t.height;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += t.data[i];
  mean /= n;
  const z = new Float32Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    z[i] = t.data[i] - mean;
    ss += z[i] * z[i];
  }
  if (ss < 1e-6 * n) return undefined; // flat template: cannot correlate
  return { t: z, w: t.width, h: t.height, norm: Math.sqrt(ss) };
}

function nccAt(img: Gray, ii: { s: Float64Array; q: Float64Array }, p: Prepared, x: number, y: number): number {
  const W = img.width + 1;
  const n = p.w * p.h;
  const x1 = x + p.w;
  const y1 = y + p.h;
  const sum = ii.s[y1 * W + x1] - ii.s[y * W + x1] - ii.s[y1 * W + x] + ii.s[y * W + x];
  const sq = ii.q[y1 * W + x1] - ii.q[y * W + x1] - ii.q[y1 * W + x] + ii.q[y * W + x];
  const varI = sq - (sum * sum) / n;
  if (varI <= 1e-6) return 0;
  let dot = 0;
  for (let j = 0; j < p.h; j++) {
    const row = (y + j) * img.width + x;
    const trow = j * p.w;
    for (let i = 0; i < p.w; i++) dot += img.data[row + i] * p.t[trow + i];
  }
  return dot / (p.norm * Math.sqrt(varI));
}

/** All positions scoring at least `min`, best first, with overlapping hits suppressed. */
function scan(img: Gray, p: Prepared, min: number, area: Box, step = 1): Array<{ x: number; y: number; score: number }> {
  const ii = integrals(img);
  const hits: Array<{ x: number; y: number; score: number }> = [];
  const xEnd = Math.min(img.width - p.w, area.x + area.width - p.w);
  const yEnd = Math.min(img.height - p.h, area.y + area.height - p.h);
  for (let y = Math.max(0, area.y); y <= yEnd; y += step) {
    for (let x = Math.max(0, area.x); x <= xEnd; x += step) {
      const s = nccAt(img, ii, p, x, y);
      if (s >= min) hits.push({ x, y, score: s });
    }
  }
  return suppress(hits, p.w, p.h);
}

function suppress<T extends { x: number; y: number; score: number }>(hits: T[], w: number, h: number): T[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const keep: T[] = [];
  for (const c of sorted) if (!keep.some((k) => Math.abs(k.x - c.x) < w / 2 && Math.abs(k.y - c.y) < h / 2)) keep.push(c);
  return keep;
}

/** Find `template` on `screen`. Returns matches above the threshold, best first. */
export function findTemplate(screen: Gray, template: Gray, o: MatchOptions = {}): TemplateMatch[] {
  const threshold = o.threshold ?? 0.9;
  const region = o.region ?? { x: 0, y: 0, width: screen.width, height: screen.height };
  const out: TemplateMatch[] = [];
  for (const scale of o.scales ?? [1, 1.25, 1.5, 0.8, 2]) {
    const tw = Math.round(template.width * scale);
    const th = Math.round(template.height * scale);
    if (tw < 4 || th < 4 || tw > region.width || th > region.height) continue;
    const t = scale === 1 ? template : resize(template, tw, th);
    const full = prepare(t);
    if (!full) continue;
    // Coarse pass: downsample so the template is ~12-24 px on its short side.
    const f = Math.max(1, Math.min(4, Math.floor(Math.min(tw, th) / 16)));
    let candidates: Array<{ x: number; y: number }>;
    if (f > 1) {
      const small = resize(screen, screen.width / f, screen.height / f);
      const st = prepare(resize(t, tw / f, th / f));
      if (!st) continue;
      const area = { x: Math.floor(region.x / f), y: Math.floor(region.y / f), width: Math.ceil(region.width / f), height: Math.ceil(region.height / f) };
      candidates = scan(small, st, Math.max(0.2, threshold - 0.45), area).slice(0, 40).map((c) => ({ x: c.x * f, y: c.y * f }));
    } else candidates = [{ x: region.x, y: region.y }];
    const ii = integrals(screen);
    const refined: Array<{ x: number; y: number; score: number }> = [];
    for (const c of candidates) {
      const area = f > 1 ? { x: c.x - f, y: c.y - f, width: tw + 2 * f + 1, height: th + 2 * f + 1 } : region;
      if (f > 1) {
        let best = { x: 0, y: 0, score: -2 };
        for (let y = Math.max(0, area.y); y <= Math.min(screen.height - th, area.y + 2 * f); y++) {
          for (let x = Math.max(0, area.x); x <= Math.min(screen.width - tw, area.x + 2 * f); x++) {
            const s = nccAt(screen, ii, full, x, y);
            if (s > best.score) best = { x, y, score: s };
          }
        }
        if (best.score >= threshold) refined.push(best);
      } else refined.push(...scan(screen, full, threshold, area));
    }
    for (const r of suppress(refined, tw, th)) out.push({ x: r.x, y: r.y, width: tw, height: th, score: Math.round(r.score * 10_000) / 10_000, scale });
  }
  return suppress(out.map((m) => ({ ...m })), Math.min(...out.map((m) => m.width), Infinity), Math.min(...out.map((m) => m.height), Infinity))
    .sort((a, b) => b.score - a.score)
    .slice(0, o.max ?? 10);
}
