/**
 * Automatic analysis of a load test:
 *
 * - knee: response time against load (VUs, or arrival rate in the open
 *   model). A two-segment linear fit over the per-level p90 finds the load
 *   where latency starts to climb steeply; throughput flattening at the same
 *   point confirms saturation.
 * - resource saturation: monitored values (CPU, memory, disk, DB waits,
 *   JVM GC) that sit near their limit and move with the response time
 *   (Pearson correlation on the shared timeline).
 * - baseline comparison: per transaction/request, percentile, error-rate
 *   and throughput changes against a baseline run, with regression rules.
 * - trend: the same names over the run history.
 */
import type { MonitorSeries } from './monitors/index.js';
import type { NameStats, TimelinePoint } from './metrics.js';

export interface Finding {
  kind: 'knee' | 'saturation' | 'throughput-plateau' | 'errors' | 'dropped' | 'regression' | 'improvement' | 'info';
  severity: 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  /** Second of the test the finding refers to. */
  at?: number;
  metric?: string;
  value?: number;
}

export interface KneeResult {
  found: boolean;
  /** Load level (VUs or rate) where the knee is. */
  load?: number;
  slopeBefore?: number;
  slopeAfter?: number;
  latencyAtKnee?: number;
  levels: Array<{ load: number; p90: number; rps: number; samples: number }>;
}

/** Group timeline seconds by load level and compute p90 (request-weighted) and throughput per level. */
export function loadLevels(timeline: TimelinePoint[], by: 'vus' | 'started' = 'vus'): KneeResult['levels'] {
  const groups = new Map<number, { p90s: Array<[number, number]>; rps: number[] }>();
  for (const p of timeline) {
    if (!p.latency || !p.requests) continue;
    const load = by === 'vus' ? p.vus : p.started;
    if (load <= 0) continue;
    const g = groups.get(load) ?? { p90s: [], rps: [] };
    g.p90s.push([p.latency.p90, p.requests]);
    g.rps.push(p.rps);
    groups.set(load, g);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([load, g]) => {
      const sorted = [...g.p90s].sort((a, b) => a[0] - b[0]);
      const median = sorted[Math.floor(sorted.length / 2)][0];
      return { load, p90: median, rps: g.rps.reduce((a, b) => a + b, 0) / g.rps.length, samples: g.p90s.length };
    });
}

function fit(xs: number[], ys: number[]): { slope: number; intercept: number; sse: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  return { slope, intercept, sse };
}

export function detectKnee(levels: KneeResult['levels']): KneeResult {
  let pts = levels.filter((l) => l.samples >= 1);
  // warm-up: the first levels pay connection setup and JIT; drop leading levels far above the ones after them
  while (pts.length > 5) {
    const next = pts.slice(1, 4).map((p) => p.p90).sort((a, b) => a - b)[1];
    if (pts[0].p90 > 2 * next) pts = pts.slice(1);
    else break;
  }
  if (pts.length < 5) return { found: false, levels };
  const xs = pts.map((p) => p.load);
  const ys = pts.map((p) => p.p90);
  let best: { i: number; sse: number; a: ReturnType<typeof fit>; b: ReturnType<typeof fit> } | undefined;
  for (let i = 2; i <= pts.length - 3; i++) {
    const a = fit(xs.slice(0, i + 1), ys.slice(0, i + 1));
    const b = fit(xs.slice(i), ys.slice(i));
    const sse = a.sse + b.sse;
    if (!best || sse < best.sse) best = { i, sse, a, b };
  }
  if (!best) return { found: false, levels };
  const single = fit(xs, ys);
  const before = Math.max(best.a.slope, 1e-9);
  const lat = ys[best.i];
  const base = Math.max(1, ys[0]);
  // a knee: the second segment is much steeper, the split explains the data clearly better, and latency really grew after it
  const found = best.b.slope > 3 * before && best.b.slope > 0 && best.sse < single.sse * 0.75 && ys[ys.length - 1] > Math.max(base, lat) * 1.5;
  return { found, load: found ? xs[best.i] : undefined, slopeBefore: best.a.slope, slopeAfter: best.b.slope, latencyAtKnee: lat, levels };
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

const LIMITS: Array<{ re: RegExp; limit: number; label: string }> = [
  { re: /^cpuPercent$|\.cpuPercent$/, limit: 85, label: 'CPU' },
  { re: /^memUsedPercent$/, limit: 90, label: 'memory' },
  { re: /^swapUsedPercent$/, limit: 20, label: 'swap' },
  { re: /^diskUtilPercent$/, limit: 85, label: 'disk utilization' },
  { re: /^oldPercent$/, limit: 90, label: 'JVM old generation' },
  { re: /^gcTimePercent$/, limit: 10, label: 'JVM GC time' },
  { re: /^activeSessions$/, limit: Number.POSITIVE_INFINITY, label: 'active DB sessions' },
];

/** Monitored values that are saturated and/or track the response time. */
export function saturation(timeline: TimelinePoint[], monitors: MonitorSeries[]): Finding[] {
  const out: Finding[] = [];
  const lat = new Map<number, number>();
  for (const p of timeline) if (p.latency) lat.set(p.t, p.latency.p90);
  for (const s of monitors) {
    const keys = new Set(s.points.flatMap((p) => Object.keys(p.values)));
    for (const k of keys) {
      const pairs = s.points.filter((p) => lat.has(p.t) && Number.isFinite(p.values[k])).map((p) => [p.values[k], lat.get(p.t)!] as const);
      if (pairs.length < 4) continue;
      const r = pearson(pairs.map((x) => x[0]), pairs.map((x) => x[1]));
      const rule = LIMITS.find((l) => l.re.test(k)) ?? (k.startsWith('wait.') ? { limit: Number.POSITIVE_INFINITY, label: `DB waits ${k.slice(5)}` } : undefined);
      const values = pairs.map((x) => x[0]);
      const peak = Math.max(...values);
      const overShare = rule && Number.isFinite(rule.limit) ? values.filter((v) => v >= rule.limit).length / values.length : 0;
      if (rule && Number.isFinite(rule.limit) && overShare >= 0.1) {
        out.push({ kind: 'saturation', severity: r > 0.5 ? 'high' : 'medium', title: `${s.name}: ${rule.label} saturated`, detail: `${k} was at or above ${rule.limit} for ${Math.round(overShare * 100)}% of the samples (peak ${peak}); correlation with p90 response time r=${r.toFixed(2)}.`, metric: `${s.name}/${k}`, value: peak });
      } else if (rule && r >= 0.7 && peak > 0) {
        out.push({ kind: 'saturation', severity: 'medium', title: `${s.name}: ${rule.label} tracks response time`, detail: `${k} rises with the p90 response time (r=${r.toFixed(2)}, peak ${peak}): a likely bottleneck.`, metric: `${s.name}/${k}`, value: peak });
      }
    }
  }
  return out;
}

export interface AnalysisResult {
  knee: KneeResult;
  findings: Finding[];
}

export function analyzeRun(o: { timeline: TimelinePoint[]; monitors: MonitorSeries[]; names: NameStats[]; model: 'closed' | 'open'; dropped: number; iterations: number }): AnalysisResult {
  const findings: Finding[] = [];
  const knee = detectKnee(loadLevels(o.timeline, o.model === 'closed' ? 'vus' : 'started'));
  if (knee.found) {
    findings.push({ kind: 'knee', severity: 'high', title: `Response time knee at ${knee.load} ${o.model === 'closed' ? 'virtual users' : 'iterations/s'}`, detail: `p90 grows ${(knee.slopeBefore ?? 0).toFixed(2)} ms per unit of load before and ${(knee.slopeAfter ?? 0).toFixed(2)} ms after (p90 ${Math.round(knee.latencyAtKnee ?? 0)} ms at the knee).`, value: knee.load });
    const lv = knee.levels;
    const after = lv.filter((l) => l.load >= (knee.load ?? 0));
    if (after.length >= 3) {
      const growth = (after[after.length - 1].rps - after[0].rps) / Math.max(1, after[0].rps);
      const loadGrowth = (after[after.length - 1].load - after[0].load) / Math.max(1, after[0].load);
      if (loadGrowth > 0.2 && growth < loadGrowth / 3) findings.push({ kind: 'throughput-plateau', severity: 'high', title: 'Throughput stopped scaling with load', detail: `After the knee load grew ${Math.round(loadGrowth * 100)}% but throughput only ${Math.round(growth * 100)}%: the system is saturated.` });
    }
  }
  findings.push(...saturation(o.timeline, o.monitors));
  for (const n of o.names) {
    if ((n.kind === 'transaction' || n.kind === 'request') && n.count >= 20 && n.errorRate >= 0.05) {
      const top = Object.entries(n.errorsByType).sort((a, b) => b[1] - a[1])[0];
      findings.push({ kind: 'errors', severity: n.errorRate >= 0.2 ? 'high' : 'medium', title: `${n.name}: ${(n.errorRate * 100).toFixed(1)}% errors`, detail: `${n.errors} of ${n.count}${top ? `; mostly ${top[0]} (${top[1]})` : ''}.` });
    }
  }
  const lags = o.timeline.map((p) => p.lagMs).filter((x): x is number => typeof x === 'number');
  const slow = lags.filter((x) => x > 50).length;
  if (lags.length && slow / lags.length >= 0.1) findings.push({ kind: 'info', severity: slow / lags.length >= 0.3 ? 'high' : 'medium', title: 'Load generator saturated', detail: `Its event loop was delayed more than 50 ms (p99) in ${slow} of ${lags.length} seconds (worst ${Math.max(...lags)} ms): reported latencies include that delay. Add agents or reduce VUs per generator.` });
  if (o.dropped > 0) findings.push({ kind: 'dropped', severity: o.dropped / Math.max(1, o.iterations + o.dropped) > 0.01 ? 'high' : 'low', title: `${o.dropped} arrivals dropped`, detail: 'The open-model queue was full: the load generator had no free VU for these arrivals (raise options.maxVus / maxQueue or add agents).' });
  return { knee, findings };
}

// ------------------------------------------------------------------ baseline comparison

export interface ComparisonRow {
  kind: string;
  name: string;
  baseline?: { count: number; p50: number; p95: number; p99: number; mean: number; errorRate: number; throughput: number };
  current?: { count: number; p50: number; p95: number; p99: number; mean: number; errorRate: number; throughput: number };
  p95ChangePct?: number;
  errorRateChange?: number;
  throughputChangePct?: number;
  verdict: 'regression' | 'improvement' | 'unchanged' | 'new' | 'missing';
  reasons: string[];
}

export interface ComparisonResult {
  baselineRunId: string;
  currentRunId: string;
  rows: ComparisonRow[];
  regressions: number;
  improvements: number;
  findings: Finding[];
}

export interface RegressionRules {
  /** Percentile increase that counts as a regression (fraction). Default 0.15. */
  p95Pct: number;
  /** ...and at least this many ms. Default 20. */
  p95MinMs: number;
  /** Error-rate increase (absolute). Default 0.01. */
  errorRate: number;
  /** Throughput drop (fraction). Default 0.15. */
  throughputPct: number;
  /** Minimum samples on both sides. Default 30. */
  minCount: number;
}

export const DEFAULT_RULES: RegressionRules = { p95Pct: 0.15, p95MinMs: 20, errorRate: 0.01, throughputPct: 0.15, minCount: 30 };

const view = (n: NameStats) => ({ count: n.count, p50: n.latency.p50, p95: n.latency.p95, p99: n.latency.p99, mean: n.latency.mean, errorRate: n.errorRate, throughput: n.throughput });

export function compareRuns(baseline: { runId: string; names: NameStats[] }, current: { runId: string; names: NameStats[] }, rules: Partial<RegressionRules> = {}): ComparisonResult {
  const r = { ...DEFAULT_RULES, ...rules };
  const key = (n: NameStats) => `${n.kind}\u0000${n.name}`;
  const base = new Map(baseline.names.filter((n) => n.kind !== 'iteration').map((n) => [key(n), n]));
  const cur = new Map(current.names.filter((n) => n.kind !== 'iteration').map((n) => [key(n), n]));
  const rows: ComparisonRow[] = [];
  for (const [k, c] of cur) {
    const b = base.get(k);
    if (!b) {
      rows.push({ kind: c.kind, name: c.name, current: view(c), verdict: 'new', reasons: [] });
      continue;
    }
    const reasons: string[] = [];
    const better: string[] = [];
    const p95ChangePct = b.latency.p95 ? (c.latency.p95 - b.latency.p95) / b.latency.p95 : 0;
    const errorRateChange = c.errorRate - b.errorRate;
    const throughputChangePct = b.throughput ? (c.throughput - b.throughput) / b.throughput : 0;
    const enough = b.count >= r.minCount && c.count >= r.minCount;
    if (enough && p95ChangePct > r.p95Pct && c.latency.p95 - b.latency.p95 > r.p95MinMs) reasons.push(`p95 ${b.latency.p95} -> ${c.latency.p95} ms (+${Math.round(p95ChangePct * 100)}%)`);
    if (enough && p95ChangePct < -r.p95Pct && b.latency.p95 - c.latency.p95 > r.p95MinMs) better.push(`p95 ${Math.round(p95ChangePct * 100)}%`);
    if (errorRateChange > r.errorRate) reasons.push(`error rate ${(b.errorRate * 100).toFixed(2)}% -> ${(c.errorRate * 100).toFixed(2)}%`);
    if (enough && throughputChangePct < -r.throughputPct) reasons.push(`throughput ${b.throughput.toFixed(1)} -> ${c.throughput.toFixed(1)}/s (${Math.round(throughputChangePct * 100)}%)`);
    rows.push({ kind: c.kind, name: c.name, baseline: view(b), current: view(c), p95ChangePct, errorRateChange, throughputChangePct, verdict: reasons.length ? 'regression' : better.length ? 'improvement' : 'unchanged', reasons: reasons.length ? reasons : better });
  }
  for (const [k, b] of base) if (!cur.has(k)) rows.push({ kind: b.kind, name: b.name, baseline: view(b), verdict: 'missing', reasons: [] });
  const regressions = rows.filter((x) => x.verdict === 'regression');
  const improvements = rows.filter((x) => x.verdict === 'improvement');
  const findings: Finding[] = regressions.map((x) => ({ kind: 'regression' as const, severity: 'high' as const, title: `Regression: ${x.name}`, detail: x.reasons.join('; ') }));
  findings.push(...improvements.map((x) => ({ kind: 'improvement' as const, severity: 'info' as const, title: `Faster: ${x.name}`, detail: x.reasons.join('; ') })));
  return { baselineRunId: baseline.runId, currentRunId: current.runId, rows: rows.sort((a, b) => a.name.localeCompare(b.name)), regressions: regressions.length, improvements: improvements.length, findings };
}

// ------------------------------------------------------------------ trend

export interface TrendEntry {
  runId: string;
  at: string;
  scenario: string;
  verdict: string;
  rps: number;
  errorRate: number;
  p95: number;
  names: Record<string, { p95: number; errorRate: number; count: number }>;
}

export interface TrendResult {
  runs: TrendEntry[];
  /** Per name: p95 values oldest first and the least-squares slope (ms per run). */
  series: Array<{ name: string; p95: number[]; slope: number; direction: 'worse' | 'better' | 'flat' }>;
}

export function trend(entries: TrendEntry[], last = 20): TrendResult {
  const runs = entries.slice(-last);
  const names = new Set(runs.flatMap((r) => Object.keys(r.names)));
  const series = [...names].map((name) => {
    const vals = runs.map((r) => r.names[name]?.p95).filter((v): v is number => typeof v === 'number');
    const f = vals.length >= 2 ? fit(vals.map((_, i) => i), vals) : { slope: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    const rel = mean ? f.slope / mean : 0;
    return { name, p95: vals, slope: Math.round(f.slope * 100) / 100, direction: (rel > 0.03 ? 'worse' : rel < -0.03 ? 'better' : 'flat') as 'worse' | 'better' | 'flat' };
  });
  return { runs, series: series.sort((a, b) => b.slope - a.slope) };
}
