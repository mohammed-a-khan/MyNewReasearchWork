import { EzTestError } from '../core/index.js';

/** Exact percentile (nearest-rank) of a non-empty array. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new EzTestError('percentile of empty array', 'INVALID_INPUT');
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

/**
 * Memory-bounded latency histogram: log-linear buckets with ~1% relative
 * precision from 1 microsecond to ~1 hour (fixed ~2,250 counters).
 */
export class LatencyHistogram {
  private static readonly GROWTH = Math.log(1.01);
  private static readonly MIN_US = 1;
  private static readonly SIZE = Math.ceil(Math.log(3.6e9) / Math.log(1.01)) + 2;
  private counts = new Uint32Array(LatencyHistogram.SIZE);
  count = 0;
  min = Infinity;
  max = -Infinity;
  sum = 0;

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new EzTestError(`invalid latency ${ms}`, 'INVALID_INPUT');
    const us = Math.max(LatencyHistogram.MIN_US, ms * 1000);
    const idx = Math.min(LatencyHistogram.SIZE - 1, Math.floor(Math.log(us) / LatencyHistogram.GROWTH));
    this.counts[idx]++;
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  /** Percentile in ms (upper edge of the bucket, clamped to observed min/max). */
  percentile(p: number): number {
    if (this.count === 0) throw new EzTestError('percentile of empty histogram', 'INVALID_INPUT');
    const target = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i];
      if (seen >= target) {
        const upperMs = Math.exp((i + 1) * LatencyHistogram.GROWTH) / 1000;
        return Math.min(this.max, Math.max(this.min, upperMs));
      }
    }
    return this.max;
  }

  get mean(): number {
    return this.count ? this.sum / this.count : NaN;
  }

  /** Bytes used by the counters (constant). */
  static get footprintBytes(): number {
    return LatencyHistogram.SIZE * 4;
  }
}
