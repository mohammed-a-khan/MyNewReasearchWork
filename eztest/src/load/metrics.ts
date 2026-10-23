/**
 * Metrics of a load test: every request, transaction, page and iteration
 * lands in a histogram per name for the whole run (response time and
 * service time) and in per-second interval histograms that become the
 * timeline. Agents send their intervals encoded; the controller merges them
 * with `ingest`, so percentiles of a distributed run are exact merges, not
 * averages of percentiles.
 */
import { Histogram, round3, type EncodedHistogram, type LatencySummary } from './histogram.js';

export type SampleKind = 'request' | 'transaction' | 'page' | 'iteration';

export interface Sample {
  name: string;
  kind: SampleKind;
  population: string;
  ok: boolean;
  errorType?: string;
  /** Response time in us, measured from the intended start (coordinated-omission safe). */
  latencyUs: number;
  /** Service time in us (from the actual send). Defaults to latencyUs. */
  serviceUs?: number;
  status?: number;
  bytesIn?: number;
  bytesOut?: number;
}

export interface ErrorSample {
  at: string;
  name: string;
  population: string;
  type: string;
  message: string;
  status?: number;
  url?: string;
  bodyStart?: string;
}

interface IntervalAcc {
  kind: SampleKind;
  name: string;
  hist: Histogram;
  n: number;
  e: number;
  bin: number;
  bout: number;
}

export interface EncodedInterval {
  /** Second since the test start. */
  t: number;
  vus: number;
  /** Iterations started/dropped/queued in this second. */
  started: number;
  dropped: number;
  keys: Array<{ k: SampleKind; name: string; n: number; e: number; bin: number; bout: number; h: EncodedHistogram }>;
  errors: Record<string, number>;
  /** The load generator's own event-loop delay in this second (p99, ms): its health. */
  lag?: number;
  populations: Record<string, { vus: number; n: number; e: number }>;
}

export interface IntervalSummaryRow {
  kind: SampleKind;
  name: string;
  count: number;
  errors: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface TimelinePoint {
  /** Second since start. */
  t: number;
  /** Epoch ms of the second's start. */
  at: number;
  vus: number;
  /** Requests completed in the second. */
  requests: number;
  /** Request throughput (per second). */
  rps: number;
  errors: number;
  iterations: number;
  started: number;
  dropped: number;
  bytesIn: number;
  bytesOut: number;
  /** All requests of the second. */
  latency: { mean: number; p50: number; p90: number; p95: number; p99: number; max: number } | null;
  rows: IntervalSummaryRow[];
  errorsByType: Record<string, number>;
  populations: Record<string, { vus: number; n: number; e: number }>;
  /** Worst load-generator event-loop delay (p99, ms) of the second. */
  lagMs?: number;
}

export interface NameStats {
  kind: SampleKind;
  name: string;
  count: number;
  errors: number;
  errorRate: number;
  throughput: number;
  bytesIn: number;
  bytesOut: number;
  latency: LatencySummary;
  service: LatencySummary;
  statusCodes: Record<string, number>;
  errorsByType: Record<string, number>;
}

interface CumAcc {
  kind: SampleKind;
  name: string;
  hist: Histogram;
  service: Histogram;
  n: number;
  e: number;
  bin: number;
  bout: number;
  status: Map<number, number>;
  errs: Map<string, number>;
}

const keyOf = (k: SampleKind, name: string) => `${k}\u0000${name}`;

function cumFor(map: Map<string, CumAcc>, key: string, kind: SampleKind, name: string): CumAcc {
  let c = map.get(key);
  if (!c) {
    c = { kind, name, hist: new Histogram(), service: new Histogram(), n: 0, e: 0, bin: 0, bout: 0, status: new Map(), errs: new Map() };
    map.set(key, c);
  }
  return c;
}

export class MetricsCollector {
  private readonly cum = new Map<string, CumAcc>();
  /** Statistics after `steadyAfterSec` (SLA ignoreFirst). */
  private readonly steady = new Map<string, CumAcc>();
  steadyAfterSec = 0;
  private interval = new Map<string, IntervalAcc>();
  private intervalErrors = new Map<string, number>();
  private intervalPops = new Map<string, { vus: number; n: number; e: number }>();
  private intervalStarted = 0;
  private intervalDropped = 0;
  readonly timeline: TimelinePoint[] = [];
  readonly errorSamples: ErrorSample[] = [];
  readonly errorsByType = new Map<string, number>();
  startedAt = Date.now();
  iterationsStarted = 0;
  iterationsDropped = 0;
  maxVus = 0;

  constructor(readonly maxErrorSamples = 20) {}

  record(s: Sample): void {
    const key = keyOf(s.kind, s.name);
    const targets = [cumFor(this.cum, key, s.kind, s.name)];
    if (this.steadyAfterSec > 0 && (Date.now() - this.startedAt) / 1000 >= this.steadyAfterSec) targets.push(cumFor(this.steady, key, s.kind, s.name));
    for (const c of targets) {
      c.hist.recordUs(s.latencyUs);
      c.service.recordUs(s.serviceUs ?? s.latencyUs);
      c.n++;
      c.bin += s.bytesIn ?? 0;
      c.bout += s.bytesOut ?? 0;
      if (s.status !== undefined) c.status.set(s.status, (c.status.get(s.status) ?? 0) + 1);
      if (!s.ok) {
        c.e++;
        const t = s.errorType ?? 'error';
        c.errs.set(t, (c.errs.get(t) ?? 0) + 1);
      }
    }
    let i = this.interval.get(key);
    if (!i) {
      i = { kind: s.kind, name: s.name, hist: new Histogram(), n: 0, e: 0, bin: 0, bout: 0 };
      this.interval.set(key, i);
    }
    i.hist.recordUs(s.latencyUs);
    i.n++;
    i.bin += s.bytesIn ?? 0;
    i.bout += s.bytesOut ?? 0;
    const pop = this.intervalPops.get(s.population) ?? { vus: 0, n: 0, e: 0 };
    if (s.kind === 'request') pop.n++;
    if (!s.ok) {
      i.e++;
      if (s.kind === 'request') pop.e++;
      const t = s.errorType ?? 'error';
      if (s.kind === 'request' || s.kind === 'page') {
        this.errorsByType.set(t, (this.errorsByType.get(t) ?? 0) + 1);
        this.intervalErrors.set(t, (this.intervalErrors.get(t) ?? 0) + 1);
      }
    }
    this.intervalPops.set(s.population, pop);
  }

  noteError(e: ErrorSample): void {
    if (this.errorSamples.length < this.maxErrorSamples) this.errorSamples.push(e);
  }

  noteStarted(n = 1): void {
    this.iterationsStarted += n;
    this.intervalStarted += n;
  }

  noteDropped(n = 1): void {
    this.iterationsDropped += n;
    this.intervalDropped += n;
  }

  /** The current second as an encoded interval (agents), resetting it. */
  drainInterval(t: number, vus: number, popVus: Record<string, number> = {}, lag?: number): EncodedInterval {
    const keys: EncodedInterval['keys'] = [];
    for (const i of this.interval.values()) keys.push({ k: i.kind, name: i.name, n: i.n, e: i.e, bin: i.bin, bout: i.bout, h: i.hist.encode() });
    const populations: EncodedInterval['populations'] = {};
    for (const [p, v] of this.intervalPops) populations[p] = { ...v, vus: popVus[p] ?? 0 };
    for (const [p, n] of Object.entries(popVus)) populations[p] ??= { vus: n, n: 0, e: 0 };
    const out: EncodedInterval = { t, vus, started: this.intervalStarted, dropped: this.intervalDropped, keys, errors: Object.fromEntries(this.intervalErrors), populations, ...(lag !== undefined ? { lag } : {}) };
    this.interval = new Map();
    this.intervalErrors = new Map();
    this.intervalPops = new Map();
    this.intervalStarted = 0;
    this.intervalDropped = 0;
    return out;
  }

  /** Close the current second locally into the timeline. */
  closeInterval(t: number, vus: number, popVus: Record<string, number> = {}, lag?: number): TimelinePoint {
    const e = this.drainInterval(t, vus, popVus, lag);
    return this.pushTimeline([e], false);
  }

  /** Merge intervals from agents (same second) into cumulative stats and the timeline. */
  ingest(parts: EncodedInterval[]): TimelinePoint {
    for (const p of parts) {
      for (const k of p.keys) {
        const key = keyOf(k.k, k.name);
        const targets = [cumFor(this.cum, key, k.k, k.name)];
        if (this.steadyAfterSec > 0 && p.t >= this.steadyAfterSec) targets.push(cumFor(this.steady, key, k.k, k.name));
        for (const c of targets) {
          c.hist.add(k.h);
          c.service.add(k.h);
          c.n += k.n;
          c.e += k.e;
          c.bin += k.bin;
          c.bout += k.bout;
        }
      }
      for (const [t, n] of Object.entries(p.errors)) this.errorsByType.set(t, (this.errorsByType.get(t) ?? 0) + n);
      this.iterationsStarted += p.started;
      this.iterationsDropped += p.dropped;
    }
    return this.pushTimeline(parts, true);
  }

  /** Final per-name details from agents (status codes, error types, service-time histograms). */
  ingestFinal(names: Array<{ k: SampleKind; name: string; status: Record<string, number>; errs: Record<string, number>; service: EncodedHistogram }>): void {
    for (const f of names) {
      const c = this.cum.get(keyOf(f.k, f.name));
      if (!c) continue;
      for (const [s, n] of Object.entries(f.status)) c.status.set(Number(s), (c.status.get(Number(s)) ?? 0) + n);
      for (const [t, n] of Object.entries(f.errs)) c.errs.set(t, (c.errs.get(t) ?? 0) + n);
    }
    // Service time: replace the response-time copy made by ingest() with the agents' own service histograms.
    const fresh = new Map<string, Histogram>();
    for (const f of names) {
      const key = keyOf(f.k, f.name);
      let h = fresh.get(key);
      if (!h) fresh.set(key, (h = new Histogram()));
      h.add(f.service);
    }
    for (const [key, h] of fresh) {
      const c = this.cum.get(key);
      if (c) c.service = h;
    }
  }

  finalDetails(): Array<{ k: SampleKind; name: string; status: Record<string, number>; errs: Record<string, number>; service: EncodedHistogram }> {
    return [...this.cum.values()].map((c) => ({ k: c.kind, name: c.name, status: Object.fromEntries([...c.status].map(([s, n]) => [String(s), n])), errs: Object.fromEntries(c.errs), service: c.service.encode() }));
  }

  private pushTimeline(parts: EncodedInterval[], cumulativeFromParts: boolean): TimelinePoint {
    void cumulativeFromParts;
    const t = parts[0]?.t ?? this.timeline.length;
    const merged = new Map<string, { kind: SampleKind; name: string; hist: Histogram; n: number; e: number }>();
    const all = new Histogram();
    let requests = 0;
    let errors = 0;
    let iterations = 0;
    let bin = 0;
    let bout = 0;
    let vus = 0;
    let started = 0;
    let dropped = 0;
    const errorsByType: Record<string, number> = {};
    const populations: Record<string, { vus: number; n: number; e: number }> = {};
    let lagMs: number | undefined;
    for (const p of parts) {
      if (p.lag !== undefined) lagMs = Math.max(lagMs ?? 0, p.lag);
      vus += p.vus;
      started += p.started;
      dropped += p.dropped;
      for (const k of p.keys) {
        const key = keyOf(k.k, k.name);
        let m = merged.get(key);
        if (!m) merged.set(key, (m = { kind: k.k, name: k.name, hist: new Histogram(), n: 0, e: 0 }));
        m.hist.add(k.h);
        m.n += k.n;
        m.e += k.e;
        if (k.k === 'request') {
          all.add(k.h);
          requests += k.n;
          errors += k.e;
          bin += k.bin;
          bout += k.bout;
        }
        if (k.k === 'iteration') iterations += k.n;
      }
      for (const [type, n] of Object.entries(p.errors)) errorsByType[type] = (errorsByType[type] ?? 0) + n;
      for (const [name, v] of Object.entries(p.populations)) {
        const q = (populations[name] ??= { vus: 0, n: 0, e: 0 });
        q.vus += v.vus;
        q.n += v.n;
        q.e += v.e;
      }
    }
    const rows: IntervalSummaryRow[] = [...merged.values()].map((m) => ({
      kind: m.kind, name: m.name, count: m.n, errors: m.e,
      mean: round3(m.hist.meanMs), p50: round3(m.hist.percentileMs(50)), p90: round3(m.hist.percentileMs(90)), p95: round3(m.hist.percentileMs(95)), p99: round3(m.hist.percentileMs(99)), max: round3(m.hist.maxMs),
    }));
    const point: TimelinePoint = {
      t, at: this.startedAt + t * 1000, vus, requests, rps: requests, errors, iterations, started, dropped, bytesIn: bin, bytesOut: bout,
      latency: all.count ? { mean: round3(all.meanMs), p50: round3(all.percentileMs(50)), p90: round3(all.percentileMs(90)), p95: round3(all.percentileMs(95)), p99: round3(all.percentileMs(99)), max: round3(all.maxMs) } : null,
      rows, errorsByType, populations, ...(lagMs !== undefined ? { lagMs } : {}),
    };
    if (vus > this.maxVus) this.maxVus = vus;
    this.timeline.push(point);
    return point;
  }

  /** Cumulative statistics per name (or of the steady part of the run). */
  stats(durationMs: number, steady = false): NameStats[] {
    const secs = Math.max(0.001, (steady ? durationMs - this.steadyAfterSec * 1000 : durationMs) / 1000);
    return [...(steady ? this.steady : this.cum).values()]
      .map((c) => ({
        kind: c.kind, name: c.name, count: c.n, errors: c.e, errorRate: c.n ? c.e / c.n : 0, throughput: c.n / secs, bytesIn: c.bin, bytesOut: c.bout,
        latency: c.hist.summary(), service: c.service.summary(),
        statusCodes: Object.fromEntries([...c.status].sort((a, b) => a[0] - b[0]).map(([s, n]) => [String(s), n])),
        errorsByType: Object.fromEntries(c.errs),
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
  }

  /** Histogram of all requests (merged). */
  allRequests(): Histogram {
    const h = new Histogram();
    for (const c of this.cum.values()) if (c.kind === 'request') h.add(c.hist);
    return h;
  }

  allRequestsService(): Histogram {
    const h = new Histogram();
    for (const c of this.cum.values()) if (c.kind === 'request') h.add(c.service);
    return h;
  }

  histogramOf(kind: SampleKind, name: string): Histogram | undefined {
    return this.cum.get(keyOf(kind, name))?.hist;
  }
}
