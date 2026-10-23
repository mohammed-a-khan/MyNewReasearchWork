/**
 * HDR-style latency histogram, written for EZTest Load.
 *
 * Values are integers in microseconds from 1 us to ~71 minutes, recorded
 * with a fixed number of significant decimal digits (default 3: every
 * reported value is within 0.1% of a recorded one). The layout is the
 * classic high-dynamic-range one: buckets that double in range, each split
 * into the same number of linear sub-buckets, so memory is constant
 * (~94 KB at 3 digits) whatever the number of samples.
 *
 * Coordinated omission: `recordCorrected(value, expectedInterval)` adds the
 * samples a stalled system would have produced had requests kept arriving
 * at the expected interval (the open-model scheduler measures from the
 * intended start time instead, which needs no correction).
 *
 * Histograms with the same settings merge losslessly (`add`), and encode to
 * a sparse, JSON-safe form for the agent -> controller stream.
 */
import { EzTestError } from '../core/index.js';

export const MAX_TRACKABLE_US = 0xffff_ffff;

export interface EncodedHistogram {
  /** Significant digits. */
  d: number;
  /** Sparse counts: [index, count, index, count, ...]. */
  c: number[];
  min: number;
  max: number;
  sum: number;
  n: number;
}

export class Histogram {
  readonly digits: number;
  private readonly subBucketHalfCountMagnitude: number;
  private readonly subBucketHalfCount: number;
  private readonly subBucketMask: number;
  private readonly subBucketCount: number;
  private readonly bucketCount: number;
  readonly counts: Float64Array;
  count = 0;
  min = Number.POSITIVE_INFINITY;
  max = 0;
  sum = 0;

  constructor(digits = 3) {
    if (!Number.isInteger(digits) || digits < 1 || digits > 4) throw new EzTestError('Histogram digits must be 1..4', 'INVALID_INPUT');
    this.digits = digits;
    const largestSingleUnit = 2 * 10 ** digits;
    const subBucketCountMagnitude = Math.ceil(Math.log2(largestSingleUnit));
    this.subBucketHalfCountMagnitude = subBucketCountMagnitude - 1;
    this.subBucketCount = 2 ** subBucketCountMagnitude;
    this.subBucketHalfCount = this.subBucketCount / 2;
    this.subBucketMask = this.subBucketCount - 1;
    let smallestUntrackable = this.subBucketCount;
    let buckets = 1;
    while (smallestUntrackable <= MAX_TRACKABLE_US) {
      smallestUntrackable *= 2;
      buckets++;
    }
    this.bucketCount = buckets;
    this.counts = new Float64Array((buckets + 1) * this.subBucketHalfCount);
  }

  private bucketIndex(v: number): number {
    return 31 - Math.clz32(v | this.subBucketMask) - this.subBucketHalfCountMagnitude;
  }

  /** Index into counts for an integer value (us). */
  indexOf(v: number): number {
    const b = this.bucketIndex(v);
    const sub = Math.floor(v / 2 ** b);
    return (b + 1) * this.subBucketHalfCount + (sub - this.subBucketHalfCount);
  }

  private valueAt(index: number): { low: number; size: number } {
    let b = Math.floor(index / this.subBucketHalfCount) - 1;
    let sub = (index % this.subBucketHalfCount) + this.subBucketHalfCount;
    if (b < 0) {
      sub -= this.subBucketHalfCount;
      b = 0;
    }
    const low = sub * 2 ** b;
    return { low, size: 2 ** b };
  }

  /** Record a value in microseconds (fractions are rounded). */
  recordUs(us: number, n = 1): void {
    if (!(us >= 0) || !Number.isFinite(us)) throw new EzTestError(`invalid latency ${us}`, 'INVALID_INPUT');
    const v = Math.min(MAX_TRACKABLE_US, Math.max(1, Math.round(us)));
    this.counts[this.indexOf(v)] += n;
    this.count += n;
    this.sum += v * n;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  /** Record a value in milliseconds. */
  recordMs(ms: number, n = 1): void {
    this.recordUs(ms * 1000, n);
  }

  /**
   * Record with coordinated-omission correction: when `us` exceeds the
   * expected interval between samples, the samples that would have been
   * taken during the stall are added with linearly decreasing values.
   */
  recordCorrected(us: number, expectedIntervalUs: number): void {
    this.recordUs(us);
    if (!(expectedIntervalUs > 0) || us <= expectedIntervalUs) return;
    for (let missing = us - expectedIntervalUs; missing >= expectedIntervalUs; missing -= expectedIntervalUs) this.recordUs(missing);
  }

  /** Value (us) at a percentile 0..100: the highest value equivalent to the bucket the percentile falls in, clamped to [min, max]. */
  percentileUs(p: number): number {
    if (this.count === 0) return Number.NaN;
    const target = Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * this.count));
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i];
      if (c === 0) continue;
      seen += c;
      if (seen >= target) {
        const { low, size } = this.valueAt(i);
        const hi = low + size - 1;
        return Math.min(this.max, Math.max(this.min, hi));
      }
    }
    return this.max;
  }

  percentileMs(p: number): number {
    return this.percentileUs(p) / 1000;
  }

  get meanMs(): number {
    return this.count ? this.sum / this.count / 1000 : Number.NaN;
  }

  get minMs(): number {
    return this.count ? this.min / 1000 : Number.NaN;
  }

  get maxMs(): number {
    return this.count ? this.max / 1000 : Number.NaN;
  }

  /** Standard deviation in ms (from bucket midpoints). */
  get stdDevMs(): number {
    if (this.count < 2) return 0;
    const mean = this.sum / this.count;
    let acc = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i];
      if (c === 0) continue;
      const { low, size } = this.valueAt(i);
      const mid = low + (size - 1) / 2;
      acc += c * (mid - mean) ** 2;
    }
    return Math.sqrt(acc / this.count) / 1000;
  }

  /** Merge another histogram with the same digits. */
  add(o: Histogram | EncodedHistogram): void {
    if (o instanceof Histogram) {
      if (o.digits !== this.digits) throw new EzTestError('cannot merge histograms with different precision', 'INVALID_INPUT');
      if (o.count === 0) return;
      for (let i = 0; i < o.counts.length; i++) if (o.counts[i]) this.counts[i] += o.counts[i];
      this.count += o.count;
      this.sum += o.sum;
      this.min = Math.min(this.min, o.min);
      this.max = Math.max(this.max, o.max);
      return;
    }
    if (o.d !== this.digits) throw new EzTestError('cannot merge histograms with different precision', 'INVALID_INPUT');
    if (!o.n) return;
    for (let i = 0; i + 1 < o.c.length; i += 2) {
      const idx = o.c[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.counts.length) throw new EzTestError(`histogram index ${idx} out of range`, 'INVALID_INPUT');
      this.counts[idx] += o.c[i + 1];
    }
    this.count += o.n;
    this.sum += o.sum;
    this.min = Math.min(this.min, o.min);
    this.max = Math.max(this.max, o.max);
  }

  reset(): void {
    this.counts.fill(0);
    this.count = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = 0;
    this.sum = 0;
  }

  encode(): EncodedHistogram {
    const c: number[] = [];
    for (let i = 0; i < this.counts.length; i++) if (this.counts[i]) c.push(i, this.counts[i]);
    return { d: this.digits, c, min: this.count ? this.min : 0, max: this.max, sum: this.sum, n: this.count };
  }

  static decode(e: EncodedHistogram): Histogram {
    const h = new Histogram(e.d);
    h.add(e);
    return h;
  }

  clone(): Histogram {
    const h = new Histogram(this.digits);
    h.add(this);
    return h;
  }

  /** Summary in milliseconds. */
  summary(): LatencySummary {
    return {
      count: this.count,
      min: round3(this.minMs),
      mean: round3(this.meanMs),
      p50: round3(this.percentileMs(50)),
      p75: round3(this.percentileMs(75)),
      p90: round3(this.percentileMs(90)),
      p95: round3(this.percentileMs(95)),
      p99: round3(this.percentileMs(99)),
      p999: round3(this.percentileMs(99.9)),
      max: round3(this.maxMs),
      stdDev: round3(this.stdDevMs),
    };
  }

  /** Bytes used by the counters. */
  get footprintBytes(): number {
    return this.counts.byteLength;
  }

  /** Number of buckets (diagnostics). */
  get buckets(): number {
    return this.bucketCount;
  }
}

export interface LatencySummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
  stdDev: number;
}

export function round3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n;
}
