/**
 * Several load generators on one machine: generator processes, each running 1/N of every population
 * with its own event loop, scheduler and connections (one Node.js event loop tops out at a few
 * thousand requests a second). Their per-second intervals are merged exactly (histograms added,
 * not percentiles averaged), so the results are those of one generator N times as fast.
 *
 * How the load is split, for generator g of the G generators of a test (G = agents x processes per agent):
 * - closed model: each runs curve / G virtual users, rounded with offset (g + 0.5) / G, so the
 *   integer VU counts add up to round(curve) exactly (Hermite's identity), as one generator's would;
 * - open model: each runs rate / G, its k-th arrival due when its integral reaches k - 1 + (g + 1) / G,
 *   so the generators' arrivals interleave into the same sequence one generator would produce
 *   (never G arrivals at the same instant). Response time is still measured from each arrival's
 *   intended start (coordinated-omission safe);
 * - data sets are sliced like agents' (unique rows stay unique), VU ids do not overlap, seeds differ;
 * - maxVus (open model) is shared between the processes.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import { EzTestError } from '../../core/index.js';
import { sliceRows, type Row } from '../data.js';
import { mergeIntervals, type EncodedInterval, type ErrorSample } from '../metrics.js';
import type { EncodedHistogram } from '../histogram.js';
import { scenarioDocument, type Scenario } from '../model.js';
import type { ExecutorStatus } from './executor.js';

/** The generator's module: the build (dist), the agent bundle's copy (dist-load-agent), or the source (development). */
const THREAD = (() => {
  const at = (ext: string) => fileURLToPath(new URL(`./generator-worker${ext}`, import.meta.url));
  return ['.js', '.mjs'].map(at).find((p) => existsSync(p)) ?? at('.ts');
})();

/** The default number of generator processes: one per CPU. */
export function defaultGenerators(): number {
  return Math.max(1, availableParallelism());
}

/** What one generator process runs. */
export interface GeneratorJob {
  /** The scenario as a document (scenarioDocument), parsed again in the process. */
  scenario: Record<string, unknown>;
  baseDir: string;
  data: Record<string, Row[]>;
  /** Share of each population (or one share for all) of this process. */
  slices: number | Record<string, number>;
  vuIdOffset: number;
  roundOffset: number;
  arrivalPhase: number;
  durationMs?: number;
  seed?: number;
  /** Processes of this process (maxVus is shared between them). */
  of: number;
}

export type ToThread =
  | { type: 'prepare'; job: GeneratorJob }
  | { type: 'start'; startAt: number }
  | { type: 'stop'; abort?: boolean }
  | { type: 'control'; addVus?: number; population?: string; factor?: number };

type FromThread =
  | { type: 'ready'; empty: boolean }
  | { type: 'interval'; data: EncodedInterval }
  | { type: 'vu-error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'final'; details: FinalDetail[]; errors: ErrorSample[]; maxVus: number };

export type FinalDetail = { k: 'request' | 'transaction' | 'page' | 'iteration'; name: string; status: Record<string, number>; errs: Record<string, number>; service: EncodedHistogram };

export interface GeneratorPoolOptions {
  scenario: Scenario;
  /** Rows of each data set (already this agent's slice in a distributed run). */
  data: Record<string, Row[]>;
  /** This agent's share of each population (1 on a single machine). */
  slices: number | Record<string, number>;
  /** Generator processes to start. */
  processes: number;
  /** This process among the test's load generator processes (agents): index and count. */
  slot?: { index: number; count: number };
  vuIdOffset?: number;
  durationMs?: number;
  seed?: number;
  /** Wall-clock start (an agent starts at the controller's time); default: as soon as every process is ready. */
  startAt?: number;
}

export interface GeneratorResults {
  details: FinalDetail[];
  errors: ErrorSample[];
  maxVus: number;
}

/** Split a share over processes: a number, or each population's share. */
function share(slices: number | Record<string, number>, n: number): number | Record<string, number> {
  return typeof slices === 'number' ? slices / n : Object.fromEntries(Object.entries(slices).map(([k, v]) => [k, v / n]));
}

/**
 * N generator processes acting as one generator. Emits 'interval' (one merged EncodedInterval per second,
 * in order) and 'vu-error'.
 */
export class GeneratorPool extends EventEmitter {
  private readonly workers: Array<{ w: ChildProcess; done: boolean; lastT: number; final?: Extract<FromThread, { type: 'final' }> }> = [];
  private readonly pending = new Map<number, Map<number, EncodedInterval>>();
  private nextT = 0;
  private t0 = 0;
  private last?: EncodedInterval;
  private finished?: Promise<GeneratorResults>;
  private readonly durationMs: number;

  constructor(readonly o: GeneratorPoolOptions, durationMs: number) {
    super();
    if (!(o.processes >= 1)) throw new EzTestError('generators must be >= 1', 'LOAD_SCENARIO');
    this.durationMs = durationMs;
  }

  /** Start the processes, wait until each has built its populations, start them together; resolves when all are done. */
  run(): Promise<GeneratorResults> {
    this.finished ??= this.execute();
    return this.finished;
  }

  private async execute(): Promise<GeneratorResults> {
    const o = this.o;
    const n = o.processes;
    const slot = o.slot ?? { index: 0, count: 1 };
    const total = slot.count * n;
    const ready: Array<Promise<void>> = [];
    let failure: Error | undefined;
    const done: Array<Promise<void>> = [];
    const doc = scenarioDocument(o.scenario);
    for (let i = 0; i < n; i++) {
      const g = slot.index * n + i;
      const data: Record<string, Row[]> = {};
      for (const [name, rows] of Object.entries(o.data)) data[name] = o.scenario.data[name] ? sliceRows(rows, o.scenario.data[name], i, n) : rows;
      const job: GeneratorJob = {
        scenario: doc, baseDir: o.scenario.baseDir, data, slices: share(o.slices, n),
        vuIdOffset: (o.vuIdOffset ?? 0) + i * Math.floor(1_000_000 / n), roundOffset: (g + 0.5) / total, arrivalPhase: (g + 1) / total,
        ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
        ...(o.seed !== undefined ? { seed: o.seed + i * 7919 } : {}), of: n,
      };
      const w = fork(THREAD, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const t = { w, done: false, lastT: -1 } as (typeof this.workers)[number];
      this.workers.push(t);
      let readyResolve!: () => void;
      let readyReject!: (e: Error) => void;
      ready.push(new Promise<void>((res, rej) => {
        readyResolve = res;
        readyReject = rej;
      }));
      done.push(new Promise<void>((resolve) => {
        const finish = () => {
          if (t.done) return;
          t.done = true;
          this.flush(false); // the seconds it completed (its last one may still wait for the others)
          resolve();
        };
        w.on('message', (m: FromThread) => {
          switch (m.type) {
            case 'ready':
              readyResolve();
              return;
            case 'interval':
              this.onInterval(i, m.data);
              return;
            case 'vu-error':
              this.emit('vu-error', new Error(m.message));
              return;
            case 'error':
              failure ??= new EzTestError(`load generator process ${i + 1}: ${m.message}`, 'LOAD_GENERATOR');
              readyReject(failure);
              finish();
              w.kill();
              return;
            case 'final':
              t.final = m;
              finish();
              w.disconnect();
              return;
          }
        });
        w.on('error', (e) => {
          failure ??= new EzTestError(`load generator process ${i + 1} failed: ${e.message}`, 'LOAD_GENERATOR');
          readyReject(failure);
          finish();
        });
        w.on('exit', (code, signal) => {
          if (!t.final && !failure) failure = new EzTestError(`load generator process ${i + 1} exited (${signal ?? `code ${code}`})`, 'LOAD_GENERATOR');
          readyReject(failure ?? new EzTestError(`load generator process ${i + 1} exited`, 'LOAD_GENERATOR'));
          finish();
        });
      }));
      w.send({ type: 'prepare', job } satisfies ToThread);
    }
    try {
      await Promise.all(ready);
    } catch (e) {
      for (const t of this.workers) t.w.kill();
      throw e;
    }
    // Every process built its populations: start them at one wall-clock instant.
    const startAt = Math.max(o.startAt ?? 0, Date.now() + 100);
    this.t0 = startAt;
    for (const t of this.workers) t.w.send({ type: 'start', startAt } satisfies ToThread);
    this.emit('started', startAt);
    await Promise.all(done);
    this.flush(true);
    if (failure && !this.workers.some((t) => t.final)) throw failure;
    if (failure) this.emit('vu-error', failure);
    const finals = this.workers.map((t) => t.final).filter((f): f is NonNullable<typeof f> => !!f);
    return {
      details: finals.flatMap((f) => f.details),
      errors: finals.flatMap((f) => f.errors),
      maxVus: this.maxVus,
    };
  }

  private maxVus = 0;

  private onInterval(i: number, e: EncodedInterval): void {
    const t = this.workers[i];
    t.lastT = Math.max(t.lastT, e.t);
    let m = this.pending.get(e.t);
    if (!m) this.pending.set(e.t, (m = new Map()));
    m.set(i, e);
    this.flush(false);
  }

  /** Emit complete seconds in order (or every second still pending when `force`). */
  private flush(force: boolean): void {
    for (;;) {
      const t = this.nextT;
      const parts = this.pending.get(t);
      const live = this.workers.map((x, i) => ({ x, i })).filter(({ x }) => !x.done);
      if (!parts) {
        const later = [...this.pending.keys()].some((k) => k > t);
        if (later && (force || live.every(({ x }) => x.lastT > t))) {
          this.nextT++;
          continue;
        }
        return;
      }
      const complete = live.every(({ x, i }) => parts.has(i) || x.lastT > t);
      if (!complete && !force) return;
      this.pending.delete(t);
      this.nextT++;
      const merged = mergeIntervals([...parts.values()]);
      this.maxVus = Math.max(this.maxVus, merged.vus);
      this.last = merged;
      this.emit('interval', merged);
    }
  }

  private broadcast(m: ToThread): void {
    for (const t of this.workers) if (!t.done && t.w.connected) t.w.send(m);
  }

  stop(): void {
    this.broadcast({ type: 'stop' });
  }

  abort(): void {
    this.broadcast({ type: 'stop', abort: true });
  }

  /** Add (or remove) VUs: split over the processes (fractions add up through the closed model's rounding). */
  addVus(n: number, population?: string): void {
    if (population && !this.o.scenario.populations.some((p) => p.name === population)) throw new EzTestError(`unknown population "${population}"`, 'LOAD_CONTROL');
    this.broadcast({ type: 'control', addVus: n / this.o.processes, ...(population ? { population } : {}) });
  }

  setFactor(f: number): void {
    if (!(f >= 0)) throw new EzTestError('factor must be >= 0', 'LOAD_CONTROL');
    this.broadcast({ type: 'control', factor: f });
  }

  /** Status from the last merged second (the processes' schedulers are elsewhere). */
  status(): ExecutorStatus {
    const pops = this.last?.populations ?? {};
    return {
      running: !!this.t0 && this.workers.some((t) => !t.done),
      elapsedMs: this.t0 ? Math.max(0, Date.now() - this.t0) : 0,
      durationMs: this.durationMs,
      vus: this.last?.vus ?? 0,
      factor: 1,
      populations: this.o.scenario.populations.map(({ name }) => ({ name, vus: pops[name]?.vus ?? 0, target: pops[name]?.vus ?? 0, queued: 0 })),
    };
  }
}
