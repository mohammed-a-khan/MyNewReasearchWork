/**
 * SLA profiles: thresholds per transaction/request (average, percentiles,
 * maximum, error rate, throughput), evaluated live on a sliding window of
 * the timeline and exactly at the end on the run's histograms.
 *
 * Live windows use the per-second summaries (count-weighted averages and
 * rates; the worst second's percentile, a conservative estimate). The final
 * verdict uses the merged histograms of the steady part of the run
 * (after `ignoreFirst`).
 */
import type { SlaSpec } from './model.js';
import type { NameStats, SampleKind, TimelinePoint } from './metrics.js';

export type SlaStatus = 'pass' | 'warn' | 'fail' | 'no-data';
export type SlaMetric = 'avg' | 'p50' | 'p90' | 'p95' | 'p99' | 'max' | 'errorRate' | 'throughput';
export const SLA_METRICS: SlaMetric[] = ['avg', 'p50', 'p90', 'p95', 'p99', 'max', 'errorRate', 'throughput'];

export interface SlaItem {
  sla: string;
  metric: SlaMetric;
  kind: SampleKind;
  name: string;
  value: number | null;
  warn?: number;
  fail?: number;
  status: SlaStatus;
  unit: 'ms' | 'ratio' | '/s';
}

export interface SlaResult {
  status: SlaStatus;
  items: SlaItem[];
}

export interface LiveSlaEvent {
  t: number;
  at: string;
  sla: string;
  name: string;
  metric: SlaMetric;
  from: SlaStatus;
  to: SlaStatus;
  value: number | null;
}

export function globMatch(glob: string, s: string): boolean {
  if (glob === '*' || glob === '**') return true;
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(s);
}

const slaName = (s: SlaSpec) => s.name ?? `${s.kind === 'any' ? '' : `${s.kind} `}${s.match}`.trim();

function judge(metric: SlaMetric, v: number | null, t: { warn?: number; fail?: number }): SlaStatus {
  if (v === null || !Number.isFinite(v)) return 'no-data';
  const worse = metric === 'throughput' ? (x: number, lim: number) => x < lim : (x: number, lim: number) => x > lim;
  if (t.fail !== undefined && worse(v, t.fail)) return 'fail';
  if (t.warn !== undefined && worse(v, t.warn)) return 'warn';
  return 'pass';
}

const rank: Record<SlaStatus, number> = { pass: 0, 'no-data': 1, warn: 2, fail: 3 };
export function worst(list: SlaStatus[]): SlaStatus {
  if (!list.length) return 'no-data';
  if (list.every((s) => s === 'no-data')) return 'no-data';
  return list.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'pass' as SlaStatus);
}

const kindOk = (s: SlaSpec, k: SampleKind) => (s.kind === 'any' ? k === 'transaction' || k === 'request' || k === 'page' : s.kind === k || (s.kind === 'request' && k === 'page'));
const unitOf = (m: SlaMetric): SlaItem['unit'] => (m === 'errorRate' ? 'ratio' : m === 'throughput' ? '/s' : 'ms');

/** Final evaluation over per-name statistics (the steady-state ones when `ignoreFirst` is used). */
export function evaluateSla(slas: SlaSpec[], stats: NameStats[], steadyStats?: NameStats[]): SlaResult {
  const items: SlaItem[] = [];
  for (const s of slas) {
    const pool = s.ignoreFirst > 0 && steadyStats ? steadyStats : stats;
    const matched = pool.filter((x) => kindOk(s, x.kind) && globMatch(s.match, x.name));
    for (const metric of SLA_METRICS) {
      const t = s[metric];
      if (!t) continue;
      if (!matched.length) {
        items.push({ sla: slaName(s), metric, kind: s.kind === 'any' ? 'transaction' : s.kind, name: s.match, value: null, ...t, status: 'no-data', unit: unitOf(metric) });
        continue;
      }
      for (const x of matched) {
        const v = metric === 'avg' ? x.latency.mean : metric === 'errorRate' ? x.errorRate : metric === 'throughput' ? x.throughput : x.latency[metric];
        const value = x.count ? Math.round(v * 1000) / 1000 : null;
        items.push({ sla: slaName(s), metric, kind: x.kind, name: x.name, value, ...t, status: judge(metric, value, t), unit: unitOf(metric) });
      }
    }
  }
  return { status: worst(items.map((i) => i.status)), items };
}

/** Window statistics from timeline points (live). */
export function windowStats(points: TimelinePoint[]): Map<string, { kind: SampleKind; name: string; count: number; errors: number; mean: number; p50: number; p90: number; p95: number; p99: number; max: number; seconds: number }> {
  const out = new Map<string, { kind: SampleKind; name: string; count: number; errors: number; mean: number; p50: number; p90: number; p95: number; p99: number; max: number; seconds: number }>();
  for (const p of points) {
    for (const r of p.rows) {
      const k = `${r.kind}\u0000${r.name}`;
      const w = out.get(k) ?? { kind: r.kind, name: r.name, count: 0, errors: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, seconds: points.length };
      const n = w.count + r.count;
      if (n) w.mean = (w.mean * w.count + r.mean * r.count) / n;
      w.count = n;
      w.errors += r.errors;
      w.p50 = Math.max(w.p50, r.p50);
      w.p90 = Math.max(w.p90, r.p90);
      w.p95 = Math.max(w.p95, r.p95);
      w.p99 = Math.max(w.p99, r.p99);
      w.max = Math.max(w.max, r.max);
      out.set(k, w);
    }
  }
  return out;
}

export class LiveSla {
  private state = new Map<string, SlaStatus>();
  readonly events: LiveSlaEvent[] = [];
  /** Seconds since the first fail (for stopOnSlaFail grace). */
  failingSince?: number;

  constructor(private readonly slas: SlaSpec[]) {}

  /** Evaluate after a new point; returns the current items. */
  update(timeline: TimelinePoint[]): SlaItem[] {
    const items: SlaItem[] = [];
    if (!timeline.length) return items;
    const now = timeline[timeline.length - 1];
    for (const s of this.slas) {
      const secs = Math.max(1, Math.round(s.window / 1000));
      const win = timeline.slice(-secs);
      const ws = [...windowStats(win).values()].filter((x) => kindOk(s, x.kind) && globMatch(s.match, x.name));
      for (const metric of SLA_METRICS) {
        const t = s[metric];
        if (!t) continue;
        for (const x of ws) {
          const v = metric === 'avg' ? x.mean : metric === 'errorRate' ? (x.count ? x.errors / x.count : 0) : metric === 'throughput' ? x.count / win.length : x[metric];
          const value = x.count || metric === 'throughput' ? Math.round(v * 1000) / 1000 : null;
          const status = judge(metric, value, t);
          const key = `${slaName(s)}|${metric}|${x.kind}|${x.name}`;
          const prev = this.state.get(key) ?? 'pass';
          if (prev !== status) {
            this.events.push({ t: now.t, at: new Date(now.at).toISOString(), sla: slaName(s), name: x.name, metric, from: prev, to: status, value });
            this.state.set(key, status);
          }
          items.push({ sla: slaName(s), metric, kind: x.kind, name: x.name, value, ...t, status, unit: unitOf(metric) });
        }
      }
    }
    const failing = items.some((i) => i.status === 'fail');
    if (failing && this.failingSince === undefined) this.failingSince = now.t;
    if (!failing) this.failingSince = undefined;
    return items;
  }
}
