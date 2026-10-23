/**
 * Minimal in-process load runner for quick checks (EZTest Load, src/load, is the full engine).
 * Closed model: `vus` workers loop back-to-back. Open model (`arrivalRate`):
 * iterations start at a fixed rate, bounded by `maxInFlight`; iterations that
 * cannot start are counted as dropped. Latencies go into a memory-bounded
 * histogram (p50/p90/p95/p99).
 */
import { EzTestError } from '../core/index.js';
import { LatencyHistogram } from './stats.js';

export interface LoadRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Status codes counted as success. Default: 200-399. */
  expectStatus?: number[];
}

export interface LoadOptions {
  /** Either a request description or a custom async iteration (throw or return false = error). */
  request?: LoadRequest;
  iteration?: (ctx: { vu: number; iter: number }) => Promise<boolean | void>;
  vus?: number;
  durationMs?: number;
  /** Total iterations across all VUs (closed model). */
  iterations?: number;
  arrivalRate?: { perSecond: number; maxInFlight?: number };
  /** Per-iteration timeout. Default 30s. */
  timeoutMs?: number;
}

export interface LoadStats {
  model: 'closed' | 'open';
  iterations: number;
  errors: number;
  errorRate: number;
  dropped: number;
  durationMs: number;
  throughputPerSec: number;
  latencyMs: { min: number; mean: number; p50: number; p90: number; p95: number; p99: number; max: number };
  errorSamples: string[];
}

export async function runLoad(opts: LoadOptions): Promise<LoadStats> {
  if (!opts.request === !opts.iteration) throw new EzTestError('runLoad: provide exactly one of request or iteration', 'INVALID_INPUT');
  if (!opts.durationMs && !opts.iterations) throw new EzTestError('runLoad: durationMs or iterations is required', 'INVALID_INPUT');
  if (opts.arrivalRate && !opts.durationMs) throw new EzTestError('runLoad: arrivalRate requires durationMs', 'INVALID_INPUT');
  const vus = opts.vus ?? 1;
  if (!Number.isInteger(vus) || vus < 1) throw new EzTestError('runLoad: vus must be a positive integer', 'INVALID_INPUT');
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const hist = new LatencyHistogram();
  let errors = 0;
  let started = 0;
  let dropped = 0;
  const errorSamples: string[] = [];
  const noteError = (msg: string) => {
    errors++;
    if (errorSamples.length < 10) errorSamples.push(msg.slice(0, 200));
  };

  const req = opts.request;
  const iterate =
    opts.iteration ??
    (async () => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(req!.url, { method: req!.method ?? 'GET', headers: req!.headers, body: req!.body, redirect: 'manual', signal: ac.signal });
        await res.arrayBuffer();
        const ok = req!.expectStatus ? req!.expectStatus.includes(res.status) : res.status >= 200 && res.status < 400;
        if (!ok) throw new Error(`HTTP ${res.status}`);
        return true;
      } finally {
        clearTimeout(t);
      }
    });

  const once = async (vu: number, iter: number) => {
    const t0 = performance.now();
    try {
      const r = await iterate({ vu, iter });
      if (r === false) noteError('iteration returned false');
    } catch (e) {
      noteError((e as Error).message ?? String(e));
    } finally {
      hist.record(performance.now() - t0);
    }
  };

  const t0 = performance.now();
  const deadline = opts.durationMs ? t0 + opts.durationMs : Infinity;
  if (opts.arrivalRate) {
    const { perSecond } = opts.arrivalRate;
    if (!(perSecond > 0)) throw new EzTestError('runLoad: arrivalRate.perSecond must be > 0', 'INVALID_INPUT');
    const maxInFlight = opts.arrivalRate.maxInFlight ?? vus * 10;
    const interval = 1000 / perSecond;
    const inflight = new Set<Promise<void>>();
    let next = t0;
    while (next < deadline) {
      const wait = next - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (inflight.size >= maxInFlight) dropped++;
      else {
        const p: Promise<void> = once(started % vus, started).then(() => {
          inflight.delete(p);
        });
        started++;
        inflight.add(p);
      }
      next += interval;
    }
    await Promise.all(inflight);
  } else {
    const limit = opts.iterations ?? Infinity;
    await Promise.all(
      Array.from({ length: vus }, async (_, vu) => {
        while (performance.now() < deadline && started < limit) {
          const iter = started++;
          await once(vu, iter);
        }
      }),
    );
  }
  const durationMs = performance.now() - t0;
  if (hist.count === 0) throw new EzTestError('runLoad: no iteration completed', 'LOAD_EMPTY');
  return {
    model: opts.arrivalRate ? 'open' : 'closed',
    iterations: hist.count,
    errors,
    errorRate: errors / hist.count,
    dropped,
    durationMs,
    throughputPerSec: hist.count / (durationMs / 1000),
    latencyMs: {
      min: hist.min,
      mean: hist.mean,
      p50: hist.percentile(50),
      p90: hist.percentile(90),
      p95: hist.percentile(95),
      p99: hist.percentile(99),
      max: hist.max,
    },
    errorSamples,
  };
}
