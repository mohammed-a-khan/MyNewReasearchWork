/**
 * Fingerprint scoring (tier T1). A stored fingerprint is compared with each
 * candidate element feature by feature; only features the stored fingerprint
 * actually has count towards the weighted mean, so sparse fingerprints are
 * not penalised for what they never recorded.
 */
import type { ElementFingerprint } from '../core/index.js';
import { jaccard, textSimilarity, tokenOverlap } from './similarity.js';

/** Feature weights. They need not sum to 1; the score is a weighted mean. */
export const FEATURE_WEIGHTS = {
  role: 0.1,
  tag: 0.05,
  name: 0.2,
  text: 0.1,
  id: 0.1,
  testId: 0.15,
  classes: 0.05,
  attributes: 0.1,
  label: 0.1,
  placeholder: 0.05,
  path: 0.1,
  position: 0.05,
} as const;

export type Feature = keyof typeof FEATURE_WEIGHTS;

export interface FingerprintScore {
  score: number;
  breakdown: Partial<Record<Feature, number>>;
}

function idSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  return textSimilarity(a.replace(/[-_]/g, ' '), b.replace(/[-_]/g, ' '));
}

function pathSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const sa = a.split(' > ');
  const sb = b.split(' > ');
  const n = Math.max(sa.length, sb.length);
  let s = 0;
  // Compare from the element outward (closest ancestors matter most).
  for (let i = 1; i <= n; i++) {
    const x = sa[sa.length - i];
    const y = sb[sb.length - i];
    if (x === undefined || y === undefined) continue;
    if (x === y) s += 1;
    else if (x.split(/[#.]/)[0] === y.split(/[#.]/)[0]) s += 0.6;
  }
  return s / n;
}

function attributeSimilarity(a: Record<string, string>, b: Record<string, string> | undefined): number {
  const keys = Object.keys(a).filter((k) => k !== 'aria-label' && k !== 'value' && k !== 'title');
  if (!keys.length) return Number.NaN;
  let s = 0;
  for (const k of keys) {
    const v = b?.[k];
    if (v === undefined) continue;
    s += v === a[k] ? 1 : k === 'href' ? textSimilarity(a[k], v) : 0;
  }
  return s / keys.length;
}

function positionSimilarity(a: NonNullable<ElementFingerprint['box']>, b: ElementFingerprint['box']): number {
  if (!b) return 0;
  const dx = a.x + a.width / 2 - (b.x + b.width / 2);
  const dy = a.y + a.height / 2 - (b.y + b.height / 2);
  return Math.max(0, 1 - Math.hypot(dx, dy) / 400);
}

/** Score a candidate element against a stored fingerprint (0..1). */
export function scoreFingerprint(stored: ElementFingerprint, cand: ElementFingerprint): FingerprintScore {
  const breakdown: Partial<Record<Feature, number>> = {};
  const put = (f: Feature, v: number) => {
    if (!Number.isNaN(v)) breakdown[f] = Math.max(0, Math.min(1, v));
  };
  if (stored.role) put('role', stored.role === cand.role ? 1 : 0);
  if (stored.tag) put('tag', stored.tag === cand.tag ? 1 : 0);
  if (stored.name) put('name', textSimilarity(stored.name, cand.name));
  if (stored.text) put('text', textSimilarity(stored.text, cand.text));
  if (stored.id) put('id', cand.id ? idSimilarity(stored.id, cand.id) : 0);
  if (stored.testId) put('testId', cand.testId === stored.testId ? 1 : cand.testId ? 0.5 * tokenOverlap(stored.testId, cand.testId) : 0);
  if (stored.classes?.length) put('classes', jaccard(stored.classes, cand.classes ?? []));
  if (stored.attributes) put('attributes', attributeSimilarity(stored.attributes, cand.attributes));
  if (stored.label) put('label', textSimilarity(stored.label, cand.label));
  if (stored.placeholder) put('placeholder', textSimilarity(stored.placeholder, cand.placeholder));
  if (stored.path) put('path', cand.path ? pathSimilarity(stored.path, cand.path) : 0);
  if (stored.box) put('position', positionSimilarity(stored.box, cand.box));
  let num = 0;
  let den = 0;
  for (const [f, v] of Object.entries(breakdown) as Array<[Feature, number]>) {
    num += FEATURE_WEIGHTS[f] * v;
    den += FEATURE_WEIGHTS[f];
  }
  return { score: den ? num / den : 0, breakdown };
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export type PickResult<T> =
  | { ok: true; best: Ranked<T>; runnerUp?: Ranked<T> }
  | { ok: false; reason: string; best?: Ranked<T>; runnerUp?: Ranked<T> };

/**
 * The acceptance rule shared by T1 and T2: the best candidate must reach
 * `threshold` AND beat the runner-up by at least `margin`. A near-tie is
 * ambiguous and is refused rather than guessed.
 */
export function pickBest<T>(ranked: Array<Ranked<T>>, threshold: number, margin: number): PickResult<T> {
  const sorted = [...ranked].sort((a, b) => b.score - a.score);
  const [best, runnerUp] = sorted;
  if (!best) return { ok: false, reason: 'no candidate elements' };
  if (best.score < threshold) {
    return { ok: false, reason: `best score ${best.score.toFixed(2)} is below threshold ${threshold}`, best, runnerUp };
  }
  if (runnerUp && best.score - runnerUp.score < margin) {
    return {
      ok: false,
      reason: `ambiguous: best ${best.score.toFixed(2)} vs runner-up ${runnerUp.score.toFixed(2)} (margin ${margin})`,
      best,
      runnerUp,
    };
  }
  return { ok: true, best, runnerUp };
}
