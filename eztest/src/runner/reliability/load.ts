/**
 * Adaptive deadlines (docs/reliability.md, "Waits under load").
 *
 * A wait given 5 s on an idle machine gets much less than 5 s of real work on a machine whose CPUs
 * are oversubscribed: the browser renders, runs scripts and answers at a fraction of its speed, and
 * this process is descheduled. Instead of failing such a wait (or healing an element that is only
 * slow to appear), the runner measures how loaded the machine was while it waited and extends the
 * deadline in proportion, up to a bound (default 3x the base):
 *
 * - CPU saturation: when the machine's CPUs were busy (>= 85% over the wait) the deadline scales
 *   with the run queue: runnable tasks per CPU (Linux: sampled from /proc/loadavg every second;
 *   elsewhere the 1-minute load average). Twice as many runnable tasks as CPUs: each gets half.
 * - event-loop starvation: a 50 ms timer (unref'd) adds up how late its ticks fire; the share of a
 *   wait's time this process could not run is time the wait did not have: x 1 / (1 - share).
 * - browser responsiveness: the round trip of a trivial evaluation in the page, compared with an
 *   idle browser's few ms: each 250 ms of round trip adds one base deadline.
 *
 * The factor is the largest of the three, and 1 on an idle machine (below the thresholds).
 * Polling waits (locating a target, post-conditions) re-check when their deadline comes; waits run
 * inside the browser driver (an action's actionability wait, a navigation) get a timeout scaled by
 * the load of the seconds before they start. Every extension is recorded on the step
 * (`reliability.extended`) and logged, so a run on a busy machine says why it took longer.
 *
 * EZTEST_ADAPTIVE_WAITS=0 turns it off; EZTEST_ADAPTIVE_MAX sets the bound (1..10).
 */
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';

/** Something with a cheap evaluation in the page (a Page, or a frame). */
export interface Probeable {
  evaluate(fn: () => unknown): Promise<unknown>;
}

export interface LoadReading {
  /** Deadline multiplier (1 = no load). */
  factor: number;
  /** Share of the window this process could not run (0..1). */
  starved: number;
  /** Share of the machine's CPU time that was busy in the window (0..1). */
  cpuBusy: number;
  /** Runnable tasks per CPU in the window. */
  runQueue: number;
  /** Browser round trip of a trivial evaluation (ms), when probed. */
  rttMs?: number;
}

export interface Extension {
  /** What waited ("locate the Sign in button", "post-conditions", "click ..."). */
  what: string;
  baseMs: number;
  /** The deadline it got (ms from its start). */
  ms: number;
  reason: string;
}

const TICK_MS = 50;
const CPU_EVERY_MS = 1000;
/** Below this the process counts as running freely (timer noise, GC pauses). */
const STARVED_MIN = 0.1;
/** CPUs this busy are saturated; below it the run queue says nothing about waiting for a CPU. */
const CPU_BUSY_MIN = 0.85;
/** Runnable tasks per CPU above which deadlines grow. */
const RUNQ_MIN = 1.15;
const RTT_UNIT_MS = 250;
const RTT_MIN_MS = 60;

export function adaptiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.EZTEST_ADAPTIVE_WAITS ?? '');
}

export function adaptiveMax(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.EZTEST_ADAPTIVE_MAX);
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 10) : 3;
}

const CORES = Math.max(1, availableParallelism());

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  return { idle, total };
}

/** Runnable tasks right now (Linux /proc/loadavg "R/T" field), else the 1-minute load average. */
function runnable(): number {
  try {
    const f = readFileSync('/proc/loadavg', 'utf8').split(/\s+/)[3];
    const n = Number(f?.split('/')[0]);
    // The field counts this process (reading it): one runnable task is ours.
    if (Number.isFinite(n)) return Math.max(0, n - 1);
  } catch {
    // not Linux
  }
  return loadavg()[0];
}

interface CpuPoint {
  t: number;
  idle: number;
  total: number;
  runq: number;
}

/** Process-wide sampler: event-loop lateness every tick, CPU use and run queue every second. */
class Sampler {
  private timer?: NodeJS.Timeout;
  private expected = 0;
  /** [time, cumulative lost ms], one per tick, the last 60 s. */
  private readonly points: Array<[number, number]> = [];
  private readonly cpu: CpuPoint[] = [];
  private lost = 0;
  private lastUse = 0;
  private lastCpu = 0;

  private cpuPoint(now: number): CpuPoint {
    const c = cpuTimes();
    return { t: now, idle: c.idle, total: c.total, runq: runnable() };
  }

  private start(): void {
    if (this.timer) return;
    const now0 = performance.now();
    this.expected = now0 + TICK_MS;
    this.points.length = 0;
    this.points.push([now0, this.lost]);
    this.cpu.length = 0;
    this.cpu.push(this.cpuPoint(now0));
    this.lastCpu = now0;
    const tick = () => {
      const now = performance.now();
      const late = now - this.expected;
      if (late > 5) this.lost += late;
      this.points.push([now, this.lost]);
      while (this.points.length > 1 && now - this.points[0][0] > 60_000) this.points.shift();
      if (now - this.lastCpu >= CPU_EVERY_MS) {
        this.cpu.push(this.cpuPoint(now));
        this.lastCpu = now;
        while (this.cpu.length > 1 && now - this.cpu[0].t > 60_000) this.cpu.shift();
      }
      this.expected = now + TICK_MS;
      // Nobody waited for a minute: stop sampling until the next wait.
      if (now - this.lastUse > 60_000) {
        this.timer = undefined;
        return;
      }
      this.timer = setTimeout(tick, TICK_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, TICK_MS);
    this.timer.unref();
  }

  /** Keep sampling (every wait calls it). */
  touch(): void {
    this.lastUse = performance.now();
    this.start();
  }

  /** Share of [from, now] (performance.now() ms) this process was not running. */
  starvedSince(from: number): number {
    const now = performance.now();
    if (now - from < TICK_MS * 4) return 0;
    let base = this.points[0];
    for (const p of this.points) {
      if (p[0] > from) break;
      base = p;
    }
    if (!base) return 0;
    // The current, still pending tick's lateness counts too.
    const lost = this.lost + Math.max(0, now - this.expected) - base[1];
    return Math.max(0, Math.min(0.95, lost / Math.max(1, now - Math.max(from, base[0]))));
  }

  /** CPU busy share and mean runnable tasks per CPU over [from, now]. */
  cpuSince(from: number): { busy: number; runQueue: number } {
    const now = performance.now();
    const cur = this.cpuPoint(now);
    let base = this.cpu[0];
    for (const p of this.cpu) {
      if (p.t > from) break;
      base = p;
    }
    if (!base || cur.total - base.total <= 0) return { busy: 0, runQueue: cur.runq / CORES };
    const busy = 1 - (cur.idle - base.idle) / (cur.total - base.total);
    const inWindow = this.cpu.filter((p) => p.t >= base.t).map((p) => p.runq);
    inWindow.push(cur.runq);
    const runq = inWindow.reduce((a, b) => a + b, 0) / inWindow.length;
    return { busy: Math.max(0, Math.min(1, busy)), runQueue: runq / CORES };
  }
}

const sampler = new Sampler();

/** Start measuring (the runner calls this when a journey starts, so the first waits have a history). */
export function startLoadSampling(): void {
  sampler.touch();
}

/** The last browser round trip measured, so waits that start on an idle machine do not probe every time. */
let lastRtt: { at: number; ms: number } | undefined;

async function probe(target: Probeable | undefined): Promise<number | undefined> {
  if (!target) return undefined;
  const t0 = performance.now();
  let answered = false;
  let call: Promise<void>;
  try {
    call = target.evaluate(() => 1).then(() => void (answered = true), () => undefined);
  } catch {
    return undefined; // a stand-in page (native platforms) has no evaluate
  }
  let timer: NodeJS.Timeout | undefined;
  // At most 1 s: a page between documents (it waits for the new one), or one that failed, says nothing about load.
  await Promise.race([call, new Promise((r) => (timer = setTimeout(r, 1000)))]);
  clearTimeout(timer);
  if (!answered) return undefined;
  const ms = performance.now() - t0;
  lastRtt = { at: performance.now(), ms };
  return ms;
}

let override: ((from: number) => LoadReading) | undefined;

/** Internal (tests): replace the measurement with fixed readings; undefined restores it. */
export function overrideLoadReading(fn: ((from: number) => LoadReading) | undefined): void {
  override = fn;
}

/** How loaded the machine was since `from` (performance.now() ms), probing the browser when one is given. */
export async function readLoad(from: number, target?: Probeable, max = adaptiveMax()): Promise<LoadReading> {
  if (override) {
    const r = override(from);
    return { ...r, factor: Math.min(max, Math.max(1, r.factor)) };
  }
  sampler.touch();
  const starved = sampler.starvedSince(from);
  const { busy, runQueue } = sampler.cpuSince(from);
  const rttMs = await probe(target);
  const loop = starved >= STARVED_MIN ? 1 / (1 - starved) : 1;
  const cpu = busy >= CPU_BUSY_MIN && runQueue >= RUNQ_MIN ? runQueue : 1;
  const browser = rttMs !== undefined && rttMs >= RTT_MIN_MS ? 1 + rttMs / RTT_UNIT_MS : 1;
  const factor = Math.min(max, Math.max(1, loop, cpu, browser));
  return { factor, starved, cpuBusy: busy, runQueue, ...(rttMs !== undefined ? { rttMs: Math.round(rttMs) } : {}) };
}

function reasonOf(r: LoadReading): string {
  const parts: string[] = [];
  if (r.cpuBusy >= CPU_BUSY_MIN && r.runQueue >= RUNQ_MIN) parts.push(`CPUs ${Math.round(r.cpuBusy * 100)}% busy with ${r.runQueue.toFixed(1)} runnable tasks per CPU`);
  if (r.starved >= STARVED_MIN) parts.push(`this process could not run ${Math.round(r.starved * 100)}% of the time`);
  if (r.rttMs !== undefined && r.rttMs >= RTT_MIN_MS) parts.push(`the browser took ${r.rttMs} ms to answer a trivial call`);
  return parts.join('; ') || 'machine under load';
}

export interface AdaptOptions {
  what: string;
  probe?: Probeable;
  onExtend?: (e: Extension) => void;
  max?: number;
  enabled?: boolean;
}

/**
 * A deadline for a polling wait, extended in proportion to the load measured while it waited
 * (bounded by base x max). `reached()` says whether the wait should give up now.
 */
export class AdaptiveDeadline {
  private readonly start = performance.now();
  private readonly startWall = Date.now();
  private at: number;
  private extendedTo?: number;
  private readonly max: number;
  private readonly on: boolean;

  constructor(readonly baseMs: number, private readonly o: AdaptOptions) {
    this.at = this.startWall + baseMs;
    this.max = o.max ?? adaptiveMax();
    this.on = (o.enabled ?? adaptiveEnabled()) && baseMs >= 200 && Number.isFinite(baseMs);
    if (this.on) sampler.touch();
  }

  /** ms left before the current deadline. */
  remaining(): number {
    return Math.max(0, this.at - Date.now());
  }

  /** True when the wait should give up: the deadline passed and the load does not justify (more) time. */
  async reached(): Promise<boolean> {
    if (Date.now() < this.at) return false;
    if (!this.on) return true;
    const cap = this.startWall + this.baseMs * this.max;
    if (this.at >= cap) return true;
    const r = await readLoad(this.start, this.o.probe, this.max);
    const want = Math.min(cap, this.startWall + this.baseMs * r.factor);
    // Extend only when it buys real time (a tenth of the base at least).
    if (want - Date.now() < this.baseMs * 0.1) return true;
    this.at = want;
    this.extendedTo = want - this.startWall;
    this.o.onExtend?.({ what: this.o.what, baseMs: this.baseMs, ms: Math.round(this.extendedTo), reason: reasonOf(r) });
    return false;
  }

  /** The deadline it ended up with, when it was extended. */
  get extendedMs(): number | undefined {
    return this.extendedTo;
  }
}

/**
 * A timeout for a wait that runs inside the browser driver (it cannot be extended once started):
 * the base scaled by the load of the last few seconds and the browser's current round trip.
 */
export async function adaptiveTimeout(baseMs: number, o: AdaptOptions): Promise<number> {
  if (!(o.enabled ?? adaptiveEnabled()) || !(baseMs >= 200) || !Number.isFinite(baseMs)) return baseMs;
  sampler.touch();
  const from = performance.now() - 3000;
  // An idle machine whose browser answered fast a moment ago: no probe (it would cost a round trip per action).
  const c = sampler.cpuSince(from);
  const calm = !override && sampler.starvedSince(from) < STARVED_MIN / 2 && !(c.busy >= CPU_BUSY_MIN && c.runQueue >= RUNQ_MIN) && lastRtt && performance.now() - lastRtt.at < 2000 && lastRtt.ms < RTT_MIN_MS / 2;
  if (calm) return baseMs;
  const r = await readLoad(from, o.probe, o.max ?? adaptiveMax());
  if (r.factor < 1.1) return baseMs;
  const ms = Math.round(baseMs * r.factor);
  o.onExtend?.({ what: o.what, baseMs, ms, reason: reasonOf(r) });
  return ms;
}
