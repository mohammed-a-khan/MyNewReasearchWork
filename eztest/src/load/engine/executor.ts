/**
 * The scheduler of a load generator. It follows each population's curve:
 *
 * - closed model: the curve is a number of concurrent virtual users; VUs
 *   are started and (gracefully, newest first) stopped to track it;
 * - open model: the curve is an arrival rate; iteration arrivals are
 *   scheduled exactly from the curve's integral, handed to a free VU,
 *   queued (their wait counts as latency) when none is free, and dropped
 *   only beyond `maxQueue`.
 *
 * Every second it closes an interval of metrics (local runs: the timeline;
 * agents: an encoded interval sent to the controller). It supports live
 * control: add/remove VUs, scale the load, stop gracefully or abort.
 */
import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { EzTestError } from '../../core/index.js';
import type { EncodedInterval, TimelinePoint } from '../metrics.js';
import { StopVu, VirtualUser, type LoadRuntime, type PopulationRuntime } from './vu.js';

export interface ExecutorOptions {
  runtime: LoadRuntime;
  populations: PopulationRuntime[];
  model: 'closed' | 'open';
  /** local: close intervals into the runtime's timeline; agent: emit encoded intervals. */
  mode: 'local' | 'agent';
  /** Override the duration (default: the longest curve). */
  durationMs?: number;
  /** Wall-clock start (agents start together at the controller's time). */
  startAt?: number;
  /**
   * Closed model: VU target = floor(curve + roundOffset). Default 0.5 (rounding). Agent i of N uses i/N so
   * the agents' integer VU counts add up exactly to the total (Hermite's identity).
   */
  roundOffset?: number;
}

interface PopState {
  rt: PopulationRuntime;
  vus: Set<VirtualUser>;
  idle: VirtualUser[];
  /** Live adjustment of the closed-model target. */
  extra: number;
  /** Open model state. */
  arrivals: number;
  nextAt: number;
  queue: number[];
  done: boolean;
}

export interface ExecutorStatus {
  running: boolean;
  elapsedMs: number;
  durationMs: number;
  vus: number;
  factor: number;
  populations: Array<{ name: string; vus: number; target: number; queued: number }>;
}

export class Executor extends EventEmitter {
  private readonly pops: PopState[];
  private t0 = 0;
  private stopping = false;
  private aborted = false;
  private factor = 1;
  private readonly durationMs: number;
  private tickTimer?: NodeJS.Timeout;
  private ctrlTimer?: NodeJS.Timeout;
  private secondsClosed = 0;
  private readonly loops = new Set<Promise<void>>();
  private finished?: Promise<void>;
  private wake?: () => void;
  private lag?: IntervalHistogram;

  constructor(readonly o: ExecutorOptions) {
    super();
    if (!o.populations.length) throw new EzTestError('no populations to run', 'LOAD_SCENARIO');
    this.pops = o.populations.map((rt) => ({ rt, vus: new Set(), idle: [], extra: 0, arrivals: 0, nextAt: 0, queue: [], done: false }));
    this.durationMs = o.durationMs ?? Math.max(...o.populations.map((p) => p.curve.durationMs));
  }

  get runtime(): LoadRuntime {
    return this.o.runtime;
  }

  elapsed(): number {
    return this.t0 ? performance.now() - this.t0 : 0;
  }

  activeVus(): number {
    let n = 0;
    for (const p of this.pops) for (const v of p.vus) if (!v.stopRequested) n++;
    return n;
  }

  private popVus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.pops) {
      let n = 0;
      for (const v of p.vus) if (!v.stopRequested && (this.o.model === 'closed' || v.busy)) n++;
      out[p.rt.spec.name] = n;
    }
    return out;
  }

  status(): ExecutorStatus {
    const t = this.elapsed();
    return {
      running: !!this.t0 && !this.stopping,
      elapsedMs: Math.round(t),
      durationMs: this.durationMs,
      vus: this.activeVus(),
      factor: this.factor,
      populations: this.pops.map((p) => ({ name: p.rt.spec.name, vus: [...p.vus].filter((v) => !v.stopRequested).length, target: Math.round(this.target(p, t) * 100) / 100, queued: p.queue.length })),
    };
  }

  private target(p: PopState, t: number): number {
    return Math.max(0, p.rt.curve.at(t) * this.factor + p.extra);
  }

  /** Start and resolve when the test (including graceful stop) is over. */
  run(): Promise<void> {
    if (this.finished) return this.finished;
    this.finished = this.start();
    return this.finished;
  }

  private async start(): Promise<void> {
    if (this.o.startAt && this.o.startAt > Date.now()) await new Promise((r) => setTimeout(r, this.o.startAt! - Date.now()));
    this.t0 = performance.now();
    this.o.runtime.metrics.startedAt = Date.now();
    this.lag = monitorEventLoopDelay({ resolution: 10 });
    this.lag.enable();
    this.scheduleTick();
    if (this.o.model === 'closed') this.controlClosed();
    else this.controlOpen();
    await new Promise<void>((resolve) => this.once('stopped-scheduling', resolve));
    await this.drain();
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.lag?.disable();
    this.closeSecond(true);
    this.emit('done');
  }

  private scheduleTick(): void {
    const next = this.t0 + (this.secondsClosed + 1) * 1000;
    this.tickTimer = setTimeout(() => {
      this.closeSecond(false);
      if (!this.aborted) this.scheduleTick();
    }, Math.max(0, next - performance.now()));
  }

  private closeSecond(final: boolean): void {
    const t = this.secondsClosed;
    this.secondsClosed++;
    const vus = this.activeVus();
    const pv = this.popVus();
    const m = this.o.runtime.metrics;
    // the generator's own event-loop delay: a starved generator inflates the latencies it reports
    let lag: number | undefined;
    if (this.lag && this.lag.count > 0) {
      lag = Math.round((this.lag.percentile(99) / 1e6) * 100) / 100;
      this.lag.reset();
    }
    if (this.o.mode === 'agent') this.emit('interval', m.drainInterval(t, vus, pv, lag) as EncodedInterval);
    else this.emit('interval', m.closeInterval(t, vus, pv, lag) as TimelinePoint);
  }

  // ---------------------------------------------------------------- closed model

  private controlClosed(): void {
    const step = () => {
      if (this.stopping) return;
      const t = this.elapsed();
      if (t >= this.durationMs) {
        this.beginStop();
        return;
      }
      for (const p of this.pops) {
        const want = Math.floor(this.target(p, t) + (this.o.roundOffset ?? 0.5) + 1e-9);
        const live = [...p.vus].filter((v) => !v.stopRequested);
        if (live.length < want) for (let i = live.length; i < want; i++) this.spawnClosed(p);
        else if (live.length > want) {
          for (const v of live.slice(want).reverse()) v.stopRequested = true;
        }
      }
      this.ctrlTimer = setTimeout(step, 50);
    };
    step();
  }

  private spawnClosed(p: PopState): void {
    const vu = new VirtualUser(this.o.runtime, p.rt);
    p.vus.add(vu);
    const pacing = p.rt.path.pacing ?? this.o.runtime.scenario.options.pacing;
    const loop = (async () => {
      try {
        let backoff = 0;
        let nextStart: number | undefined;
        while (!vu.stopRequested && !this.stopping && !vu.aborted) {
          if (!vu.initialized) {
            if (!(await vu.init())) {
              backoff = Math.min(5000, backoff ? backoff * 2 : 500);
              await this.sleep(backoff);
              continue;
            }
            backoff = 0;
          }
          let intended: number | undefined;
          if (pacing) {
            nextStart ??= performance.now();
            const wait = nextStart - performance.now();
            if (wait > 0) await this.sleep(wait);
            if (vu.stopRequested || this.stopping) break;
            intended = nextStart;
            nextStart += pacing;
          }
          this.o.runtime.metrics.noteStarted();
          await vu.iteration(intended);
        }
        if (vu.initialized && !vu.aborted) await vu.end();
      } catch (e) {
        if (!(e instanceof StopVu)) this.emit('vu-error', e);
      } finally {
        await vu.close();
        p.vus.delete(vu);
        this.wake?.();
      }
    })();
    this.track(loop);
  }

  // ---------------------------------------------------------------- open model

  /** Time (ms) at which the integral of the rate curve reaches k iterations, or Infinity. */
  private arrivalTime(p: PopState, k: number, after: number): number {
    const c = p.rt.curve;
    const want = (k * 1000) / this.factor;
    const end = this.durationMs;
    if (c.integral(end) < want) return Number.POSITIVE_INFINITY;
    let lo = after;
    let hi = end;
    for (let i = 0; i < 60 && hi - lo > 0.0005; i++) {
      const mid = (lo + hi) / 2;
      if (c.integral(mid) < want) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  private controlOpen(): void {
    for (const p of this.pops) p.nextAt = this.arrivalTime(p, 1, 0);
    const step = () => {
      if (this.stopping) return;
      const now = this.elapsed();
      let soonest = Number.POSITIVE_INFINITY;
      let allDone = true;
      for (const p of this.pops) {
        let guard = 0;
        while (p.nextAt <= now && guard++ < 100_000) {
          this.arrive(p, this.t0 + p.nextAt);
          p.arrivals++;
          p.nextAt = this.arrivalTime(p, p.arrivals + 1, p.nextAt);
        }
        if (Number.isFinite(p.nextAt)) {
          allDone = false;
          soonest = Math.min(soonest, p.nextAt);
        }
      }
      if (allDone || now >= this.durationMs) {
        this.beginStop();
        return;
      }
      this.ctrlTimer = setTimeout(step, Math.max(0, Math.min(50, soonest - this.elapsed())));
    };
    step();
  }

  private arrive(p: PopState, intended: number): void {
    const vu = p.idle.pop();
    if (vu) return this.runOpen(p, vu, intended);
    if (p.vus.size < p.rt.maxVus) {
      const fresh = new VirtualUser(this.o.runtime, p.rt);
      p.vus.add(fresh);
      return this.runOpen(p, fresh, intended);
    }
    if (p.queue.length < this.o.runtime.scenario.options.maxQueue) p.queue.push(intended);
    else this.o.runtime.metrics.noteDropped();
  }

  private runOpen(p: PopState, vu: VirtualUser, intended: number): void {
    const job = (async () => {
      let next: number | undefined = intended;
      try {
        while (next !== undefined && !this.aborted) {
          if (this.o.runtime.scenario.options.newSessionPerIteration && vu.initialized) await vu.newSession();
          if (!vu.initialized && !(await vu.init())) {
            this.o.runtime.metrics.record({ kind: 'iteration', name: p.rt.path.name, population: p.rt.spec.name, ok: false, errorType: 'init', latencyUs: Math.max(1, (performance.now() - next) * 1000) });
          } else {
            this.o.runtime.metrics.noteStarted();
            await vu.iteration(next);
          }
          // arrivals scheduled before the end still run (within the graceful stop); an abort drops them
          next = this.aborted ? undefined : p.queue.shift();
        }
        if (this.aborted) {
          while (p.queue.length) {
            p.queue.shift();
            this.o.runtime.metrics.noteDropped();
          }
        }
        if (this.aborted || this.stopping) {
          await vu.end();
          await vu.close();
          p.vus.delete(vu);
        } else p.idle.push(vu);
      } catch (e) {
        if (!(e instanceof StopVu)) this.emit('vu-error', e);
        await vu.close();
        p.vus.delete(vu);
      } finally {
        this.wake?.();
      }
    })();
    this.track(job);
  }

  // ---------------------------------------------------------------- control

  private track(p: Promise<void>): void {
    this.loops.add(p);
    void p.finally(() => this.loops.delete(p));
  }

  private readonly sleepers = new Set<{ t: NodeJS.Timeout; r: () => void }>();

  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((r) => {
      const s = { t: setTimeout(() => {
        this.sleepers.delete(s);
        r();
      }, ms), r };
      this.sleepers.add(s);
    });
  }

  private beginStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.ctrlTimer) clearTimeout(this.ctrlTimer);
    for (const p of this.pops) for (const v of p.vus) v.stopRequested = true;
    // a stop wakes sleepers so ramp-down is immediate
    for (const s of this.sleepers) {
      clearTimeout(s.t);
      s.r();
    }
    this.sleepers.clear();
    this.emit('stopping');
    this.emit('stopped-scheduling');
  }

  private async drain(): Promise<void> {
    const grace = this.o.runtime.scenario.options.gracefulStop;
    const deadline = performance.now() + grace;
    // idle open-model VUs end now
    for (const p of this.pops) {
      for (const v of p.idle.splice(0)) {
        await v.end();
        await v.close();
        p.vus.delete(v);
      }
    }
    while (this.loops.size && performance.now() < deadline) {
      await Promise.race([Promise.all([...this.loops]), new Promise((r) => setTimeout(r, Math.max(1, deadline - performance.now())))]);
    }
    if (this.loops.size) {
      this.aborted = true;
      for (const p of this.pops) for (const v of p.vus) {
        v.aborted = true;
        v.client.close();
      }
      await Promise.race([Promise.all([...this.loops]), new Promise((r) => setTimeout(r, 5000))]);
    }
  }

  /** Graceful stop (running iterations finish within gracefulStop). */
  stop(): void {
    this.beginStop();
  }

  /** Stop at once: running iterations are abandoned and not recorded. */
  abort(): void {
    this.aborted = true;
    for (const p of this.pops) for (const v of p.vus) v.aborted = true;
    this.beginStop();
  }

  /** Add (or with a negative n, remove) virtual users to a population (closed model) or all populations. */
  addVus(n: number, population?: string): void {
    const targets = population ? this.pops.filter((p) => p.rt.spec.name === population) : this.pops;
    if (!targets.length) throw new EzTestError(`unknown population "${population}"`, 'LOAD_CONTROL');
    const each = n / targets.length;
    for (const p of targets) p.extra += each;
  }

  /** Scale the load (VUs or arrival rate) by a factor from now on. */
  setFactor(f: number): void {
    if (!(f >= 0)) throw new EzTestError('factor must be >= 0', 'LOAD_CONTROL');
    const now = this.elapsed();
    this.factor = f;
    if (this.o.model === 'open') {
      for (const p of this.pops) {
        // keep the arrivals already made; continue from the scaled integral
        const done = (p.rt.curve.integral(now) / 1000) * f;
        p.arrivals = Math.floor(done);
        p.nextAt = this.arrivalTime(p, p.arrivals + 1, now);
      }
    }
  }
}
