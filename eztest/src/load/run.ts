/**
 * A load test on this machine: the scenario's populations on one load
 * generator, monitors on the same timeline, SLAs evaluated live and at the
 * end, analysis, and the results (the same shape a distributed run
 * produces). `LoadTest` is the live handle the CLI and Studio drive:
 * status, add VUs, scale, stop, abort.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { EzTestError } from '../core/index.js';
import type { Scenario } from './model.js';
import { loadAllData, type Row } from './data.js';
import { MetricsCollector, type EncodedInterval, type NameStats, type TimelinePoint, type ErrorSample } from './metrics.js';
import { profileCurve, apportion } from './profiles.js';
import { Executor } from './engine/executor.js';
import { GeneratorPool } from './engine/generators.js';
import { LoadRuntime, type PopulationRuntime } from './engine/vu.js';
import { MonitorRunner, type MonitorSeries } from './monitors/index.js';
import { evaluateSla, LiveSla, worst, type LiveSlaEvent, type SlaItem, type SlaResult } from './sla.js';
import { analyzeRun, compareRuns, type AnalysisResult, type ComparisonResult, type RegressionRules } from './analysis.js';
import type { LatencySummary } from './histogram.js';

import { RESULTS_FORMAT } from './constants.js';

export { RESULTS_FORMAT };

export interface LoadTotals {
  requests: number;
  errors: number;
  errorRate: number;
  rps: number;
  iterations: number;
  iterationErrors: number;
  dropped: number;
  bytesIn: number;
  bytesOut: number;
  maxVus: number;
  /** Response time of all requests (coordinated-omission safe). */
  latency: LatencySummary;
  /** Service time (from the actual send). */
  service: LatencySummary;
  /** Load generator health: event-loop delay per second (p99, ms), worst and median second. */
  generatorLag: { worstMs: number; medianMs: number };
}

export interface LoadResults {
  format: typeof RESULTS_FORMAT;
  version: 1;
  runId: string;
  scenario: { name: string; description?: string; model: 'closed' | 'open'; populations: Array<{ name: string; userPath: string; share: number; zone?: string; network?: unknown; browser: boolean }>; tags: string[]; requirements: string[]; profile?: unknown };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  agents: Array<{ id: string; host: string; zone?: string; vus: number; requests: number; errors: number; rps: number }>;
  totals: LoadTotals;
  names: NameStats[];
  timeline: TimelinePoint[];
  monitors: MonitorSeries[];
  sla: SlaResult;
  liveSla: LiveSlaEvent[];
  errors: { byType: Record<string, number>; samples: ErrorSample[] };
  analysis: AnalysisResult;
  comparison?: ComparisonResult;
  verdict: 'pass' | 'warn' | 'fail';
  stopReason?: string;
  /** Generator processes per load generator process (when more than one). */
  generators?: number;
}

export interface LiveSnapshot {
  runId: string;
  scenario: string;
  state: 'starting' | 'running' | 'stopping' | 'done' | 'failed';
  elapsedMs: number;
  durationMs: number;
  vus: number;
  point?: TimelinePoint;
  totals: { requests: number; errors: number; iterations: number; dropped: number };
  sla: SlaItem[];
  monitors: Array<{ name: string; type: string; values: Record<string, number>; t?: number }>;
  populations: Array<{ name: string; vus: number; target: number; queued: number }>;
  agents?: Array<{ id: string; host: string; vus: number; state: string }>;
}

export interface LoadTestOptions {
  runId?: string;
  data?: Record<string, Row[]>;
  /** Skip the scenario's monitors. */
  monitors?: boolean;
  durationMs?: number;
  baseline?: Pick<LoadResults, 'runId' | 'names'>;
  regressionRules?: Partial<RegressionRules>;
  seed?: number;
  /**
   * Load generator processes on this machine (docs/load.md, "Generators"): each runs 1/N of every
   * population on its own event loop; their metrics merge exactly. Default 1 (`eztest load run`:
   * one per CPU). Scenarios with browser-level users use one generator.
   */
  generators?: number;
}

/** How many generator processes a scenario runs on: browser-level users stay on one (they are separate browser processes anyway). */
export function generatorsFor(s: Scenario, wanted: number | undefined): { count: number; note?: string } {
  const n = Math.max(1, Math.floor(wanted ?? 1));
  if (n > 1 && s.populations.some((p) => p.browser ?? s.userPaths[p.userPath]?.browser)) return { count: 1, note: 'browser-level users run on one generator process' };
  return { count: n };
}

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `load-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${randomBytes(3).toString('hex')}`;
}

/**
 * Population runtimes for a scenario on one generator. `slice` is this
 * generator's share of the load: one fraction for all populations, or one
 * per population (distributed runs; 0 = not on this generator).
 */
export function buildPopulations(s: Scenario, rt: LoadRuntime, slice: number | Record<string, number> = 1, o: { generators?: number } = {}): PopulationRuntime[] {
  const total = s.populations.reduce((a, p) => a + p.share, 0);
  const frac = (name: string) => (typeof slice === 'number' ? slice : (slice[name] ?? 0));
  const pops = s.populations.filter((p) => frac(p.name) > 0 && p.share > 0);
  // maxVus is per load generator (open model; a machine with several generator processes shares it), split over its populations by share.
  const maxVus = apportion(Math.max(pops.length, Math.ceil(s.options.maxVus / Math.max(1, o.generators ?? 1))), pops.map((p) => p.share));
  return pops.map((p, i) => {
    const prof = p.profile ?? s.profile;
    if (!prof) throw new EzTestError(`population ${p.name}: no profile`, 'LOAD_SCENARIO');
    const curve = profileCurve(prof, s.model).scale((p.share / total) * frac(p.name));
    return { spec: p, path: s.userPaths[p.userPath], curve, shaper: rt.shaperFor(p), maxVus: Math.max(1, maxVus[i]) };
  });
}

export function steadyAfter(s: Scenario): number {
  return Math.max(0, ...s.sla.map((x) => x.ignoreFirst)) / 1000;
}

export function summarizeResults(o: {
  runId: string; scenario: Scenario; metrics: MetricsCollector; startedAt: number; finishedAt: number; monitors: MonitorSeries[]; live: LiveSla;
  baseline?: Pick<LoadResults, 'runId' | 'names'>; rules?: Partial<RegressionRules>; agents?: LoadResults['agents']; stopReason?: string;
}): LoadResults {
  const s = o.scenario;
  const m = o.metrics;
  const durationMs = o.finishedAt - o.startedAt;
  const names = m.stats(durationMs);
  const steady = m.steadyAfterSec > 0 ? m.stats(durationMs, true) : undefined;
  const reqs = names.filter((n) => n.kind === 'request');
  const its = names.filter((n) => n.kind === 'iteration');
  const requests = reqs.reduce((a, n) => a + n.count, 0);
  const errors = reqs.reduce((a, n) => a + n.errors, 0);
  const sla = evaluateSla(s.sla, names, steady);
  const iterations = its.reduce((a, n) => a + n.count, 0);
  const analysis = analyzeRun({ timeline: m.timeline, monitors: o.monitors, names, model: s.model, dropped: m.iterationsDropped, iterations });
  const comparison = o.baseline ? compareRuns(o.baseline, { runId: o.runId, names }, o.rules) : undefined;
  if (comparison) analysis.findings.push(...comparison.findings);
  const slaVerdict = sla.status === 'no-data' ? (s.sla.length ? 'fail' : 'pass') : sla.status === 'pass' ? 'pass' : sla.status;
  let verdict: LoadResults['verdict'] = slaVerdict === 'fail' ? 'fail' : slaVerdict === 'warn' ? 'warn' : 'pass';
  if (verdict === 'pass' && !requests && !iterations) verdict = 'fail';
  return {
    format: RESULTS_FORMAT,
    version: 1,
    runId: o.runId,
    scenario: {
      name: s.name, description: s.description, model: s.model, tags: s.tags, requirements: s.requirements, profile: s.profile,
      populations: s.populations.map((p) => ({ name: p.name, userPath: p.userPath, share: p.share, zone: p.zone, network: p.network, browser: p.browser ?? s.userPaths[p.userPath].browser })),
    },
    startedAt: new Date(o.startedAt).toISOString(),
    finishedAt: new Date(o.finishedAt).toISOString(),
    durationMs,
    agents: o.agents ?? [],
    totals: {
      requests, errors, errorRate: requests ? errors / requests : 0, rps: requests / Math.max(0.001, durationMs / 1000), iterations, iterationErrors: its.reduce((a, n) => a + n.errors, 0),
      dropped: m.iterationsDropped, bytesIn: reqs.reduce((a, n) => a + n.bytesIn, 0), bytesOut: reqs.reduce((a, n) => a + n.bytesOut, 0), maxVus: m.maxVus,
      latency: m.allRequests().summary(), service: m.allRequestsService().summary(),
      generatorLag: (() => {
        const l = m.timeline.map((p) => p.lagMs).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
        return { worstMs: l.length ? l[l.length - 1] : 0, medianMs: l.length ? l[Math.floor(l.length / 2)] : 0 };
      })(),
    },
    names,
    timeline: m.timeline,
    monitors: o.monitors,
    sla,
    liveSla: o.live.events,
    errors: { byType: Object.fromEntries(m.errorsByType), samples: m.errorSamples },
    analysis,
    comparison,
    verdict,
    stopReason: o.stopReason,
  };
}

export class LoadTest extends EventEmitter {
  readonly runId: string;
  readonly metrics: MetricsCollector;
  private executor?: Executor;
  private pool?: GeneratorPool;
  private runtime?: LoadRuntime;
  private monitors?: MonitorRunner;
  private readonly live: LiveSla;
  private liveItems: SlaItem[] = [];
  private state: LiveSnapshot['state'] = 'starting';
  private stopReason?: string;
  private promise?: Promise<LoadResults>;

  constructor(readonly scenario: Scenario, readonly o: LoadTestOptions = {}) {
    super();
    this.runId = o.runId ?? newRunId();
    this.metrics = new MetricsCollector(scenario.options.errorSamples);
    this.metrics.steadyAfterSec = steadyAfter(scenario);
    this.live = new LiveSla(scenario.sla);
  }

  run(): Promise<LoadResults> {
    this.promise ??= this.execute().catch((e) => {
      this.state = 'failed';
      this.emit('failed', e);
      throw e;
    });
    return this.promise;
  }

  private async execute(): Promise<LoadResults> {
    const s = this.scenario;
    const data = this.o.data ?? (await loadAllData(s));
    const gens = generatorsFor(s, this.o.generators);
    if (gens.note) this.emit('note', gens.note);
    if (gens.count > 1) return this.executeOnGenerators(gens.count, data);
    this.runtime = new LoadRuntime(s, data, this.metrics, { seed: this.o.seed });
    const pops = buildPopulations(s, this.runtime);
    this.executor = new Executor({ runtime: this.runtime, populations: pops, model: s.model, mode: 'local', durationMs: this.o.durationMs });
    this.monitors = new MonitorRunner(this.o.monitors === false ? [] : s.monitors, s);
    const started = Date.now();
    await this.monitors.start(started);
    this.executor.on('interval', (p: TimelinePoint) => this.onPoint(p));
    this.executor.on('vu-error', (e: Error) => this.emit('vu-error', e));
    this.state = 'running';
    this.emit('started', { runId: this.runId });
    try {
      await this.executor.run();
    } finally {
      await this.monitors.stop();
      await this.runtime.close();
    }
    this.state = 'done';
    const results = summarizeResults({ runId: this.runId, scenario: s, metrics: this.metrics, startedAt: this.metrics.startedAt, finishedAt: Date.now(), monitors: this.monitors.series, live: this.live, baseline: this.o.baseline, rules: this.o.regressionRules, stopReason: this.stopReason });
    this.emit('done', results);
    return results;
  }

  /** The scenario on several generator processes; their seconds are merged into this test's metrics. */
  private async executeOnGenerators(threads: number, data: Record<string, Row[]>): Promise<LoadResults> {
    const s = this.scenario;
    const durationMs = this.o.durationMs ?? Math.max(...s.populations.map((p) => profileCurve((p.profile ?? s.profile)!, s.model).durationMs));
    const seed = this.o.seed ?? s.options.seed;
    const pool = new GeneratorPool({ scenario: s, data, slices: 1, processes: threads, ...(this.o.durationMs !== undefined ? { durationMs: this.o.durationMs } : {}), ...(seed !== undefined ? { seed } : {}) }, durationMs);
    this.pool = pool;
    this.monitors = new MonitorRunner(this.o.monitors === false ? [] : s.monitors, s);
    let monitorsStarted: Promise<void> = Promise.resolve();
    pool.on('started', (at: number) => {
      this.metrics.startedAt = at;
      this.state = 'running';
      monitorsStarted = this.monitors!.start(at);
      this.emit('started', { runId: this.runId });
    });
    pool.on('interval', (e: EncodedInterval) => this.onPoint(this.metrics.ingest([e])));
    pool.on('vu-error', (e: Error) => this.emit('vu-error', e));
    let out;
    try {
      out = await pool.run();
    } finally {
      await monitorsStarted.catch(() => undefined);
      await this.monitors.stop();
    }
    this.metrics.ingestFinal(out.details);
    for (const e of out.errors) this.metrics.noteError(e);
    this.metrics.maxVus = Math.max(this.metrics.maxVus, out.maxVus);
    this.state = 'done';
    const results = summarizeResults({ runId: this.runId, scenario: s, metrics: this.metrics, startedAt: this.metrics.startedAt, finishedAt: Date.now(), monitors: this.monitors.series, live: this.live, baseline: this.o.baseline, rules: this.o.regressionRules, stopReason: this.stopReason });
    results.generators = threads;
    this.emit('done', results);
    return results;
  }

  private onPoint(p: TimelinePoint): void {
    this.liveItems = this.live.update(this.metrics.timeline);
    const stopOn = this.scenario.stopOnSlaFail;
    if (stopOn !== false && this.live.failingSince !== undefined) {
      const grace = stopOn === true ? 0 : stopOn / 1000;
      if (p.t - this.live.failingSince >= grace && this.state === 'running') {
        this.stopReason = `SLA failed live at ${this.live.failingSince}s (stopOnSlaFail)`;
        this.stop();
      }
    }
    this.emit('point', p, this.snapshot());
  }

  snapshot(): LiveSnapshot {
    const st = this.executor?.status() ?? this.pool?.status();
    const tl = this.metrics.timeline;
    const reqs = tl.reduce((a, p) => a + p.requests, 0);
    return {
      runId: this.runId,
      scenario: this.scenario.name,
      state: this.state,
      elapsedMs: st?.elapsedMs ?? 0,
      durationMs: st?.durationMs ?? 0,
      vus: st?.vus ?? 0,
      point: tl[tl.length - 1],
      totals: { requests: reqs, errors: tl.reduce((a, p) => a + p.errors, 0), iterations: tl.reduce((a, p) => a + p.iterations, 0), dropped: this.metrics.iterationsDropped },
      sla: this.liveItems,
      monitors: this.monitors?.latest() ?? [],
      populations: st?.populations ?? [],
    };
  }

  liveStatus(): SlaItem[] {
    return this.liveItems;
  }

  stop(reason = 'stopped'): void {
    this.stopReason ??= reason;
    this.state = 'stopping';
    this.executor?.stop();
    this.pool?.stop();
  }

  abort(): void {
    this.stopReason ??= 'aborted';
    this.state = 'stopping';
    this.executor?.abort();
    this.pool?.abort();
  }

  addVus(n: number, population?: string): void {
    const g = this.executor ?? this.pool;
    if (!g) throw new EzTestError('the test is not running', 'LOAD_CONTROL');
    if (this.scenario.model !== 'closed') throw new EzTestError('adding VUs applies to the closed model; use setFactor for arrival rates', 'LOAD_CONTROL');
    g.addVus(n, population);
  }

  setFactor(f: number): void {
    const g = this.executor ?? this.pool;
    if (!g) throw new EzTestError('the test is not running', 'LOAD_CONTROL');
    g.setFactor(f);
  }
}

/** Overall status of a results document for gates and exit codes. */
export function verdictOf(r: Pick<LoadResults, 'verdict' | 'comparison'>, o: { failOnWarn?: boolean; failOnRegression?: boolean } = {}): { exitCode: number; status: 'pass' | 'warn' | 'fail'; why: string } {
  if (r.verdict === 'fail') return { exitCode: 1, status: 'fail', why: 'an SLA failed' };
  if (o.failOnRegression && (r.comparison?.regressions ?? 0) > 0) return { exitCode: 1, status: 'fail', why: `${r.comparison!.regressions} regression(s) against the baseline` };
  if (r.verdict === 'warn') return { exitCode: o.failOnWarn ? 1 : 0, status: 'warn', why: 'an SLA is in its warning range' };
  return { exitCode: 0, status: 'pass', why: 'all SLAs met' };
}

export { worst };
