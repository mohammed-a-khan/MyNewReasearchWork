/**
 * The run side of process workers (see protocol.ts): N worker processes, each with its own browser,
 * taking journey attempts from the run's queue one at a time.
 *
 * - Evidence: a worker writes its files into the run directory and the run records them in the one
 *   hash-chained manifest (in arrival order).
 * - Events, log lines and secrets found in a worker reach the run's event bus, logger and masking.
 * - A worker that dies while it runs a journey (a native crash, `process.abort()`, an out-of-memory
 *   kill) turns that attempt into an environment failure with the end of the worker's output as
 *   evidence; a new worker takes its place and the run goes on.
 * - Cancel: the run's signal reaches every worker (a terminal signal also closes their browsers at
 *   once, as in an inline run); a forced stop kills the workers and their browsers synchronously.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso, type EzEvent, type Journey, type JourneyResult, type Logger } from '../../core/index.js';
import { killTree } from '../../browser/launcher/launch.js';
import type { AttemptRunner } from '../attempts.js';
import { exportBddAllState, importBddAllState } from '../bdd-all.js';
import { RunCancelledError } from '../cancel.js';
import type { EvidenceWriter } from '../evidence.js';
import { attemptNetwork } from '../journey.js';
import type { NetLogEntry } from '../reliability/health.js';
import { skippedStep } from '../step.js';
import { safeName } from '../evidence.js';
import type { ResolvedBrowser } from '../browsers.js';
import type { RunOptions } from '../types.js';
import { bddRecord } from '../bdd-run.js';
import type { FromWorker, ToWorker, TransferPlan, WorkerSetup } from './protocol.js';

const CHILD = (() => {
  const js = fileURLToPath(new URL('./child.js', import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL('./child.ts', import.meta.url));
})();

export interface PoolInit {
  size: number;
  runId: string;
  runDir: string;
  fingerprintStore: string;
  stepTimeoutMs: number;
  targets: ResolvedBrowser[];
  /** Every journey of the run (callable with "Run journey"). */
  journeys: Journey[];
  plan: TransferPlan;
  setup?: WorkerSetup;
  evidence: EvidenceWriter;
  logger: Logger;
  options: RunOptions;
}

interface Task {
  id: number;
  msg: Extract<ToWorker, { type: 'task' }>;
  journey: Journey;
  attempt: number;
  resolve: (r: JourneyResult) => void;
}

interface Slot {
  index: number;
  proc: ChildProcess;
  ready: boolean;
  busy?: Task;
  pids: number[];
  dirs: string[];
  tail: string;
  exited: Promise<void>;
  context?: { created: number; reused: number };
}

const WORKER_CRASHED = 'WorkerCrashed';

/** The result of a journey whose worker process died under it. */
function workerCrashed(j: Journey, attempt: number, browser: string, why: string, evidence: string[]): JourneyResult {
  const message = `the worker process running the journey ${why}; the run started a new worker and went on`;
  return {
    journeyId: j.id, name: j.name, startedAt: nowIso(), durationMs: 0, steps: j.steps.map((s) => skippedStep(s, `not run: ${message}`)),
    tags: j.tags, requirements: j.requirements, risk: j.risk, attempt, browser, ledger: {}, evidence,
    status: 'error', error: { message, name: WORKER_CRASHED },
    reliability: { environment: { reason: `worker process crashed (${why})`, evidence } },
    ...(j.bdd ? { bdd: bddRecord(j) } : {}),
  };
}

export class ProcessWorkerPool implements AttemptRunner {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 0;
  private closing = false;
  private cancelMsg?: Extract<ToWorker, { type: 'cancel' }>;
  private readonly versionMap = new Map<string, string | undefined>();
  private readonly driverEnv: Record<string, string> = {};
  private readonly contexts = new Map<number, { created: number; reused: number }>();
  /** Worker restarts after a crash (for the run's reliability notes). */
  restarts = 0;

  private constructor(private readonly init: PoolInit) {}

  /** Number of worker processes. */
  get size(): number {
    return this.init.size;
  }

  /** Start the workers and wait until each has its browser. A browser that cannot start fails the run as it would inline. */
  static async start(init: PoolInit): Promise<ProcessWorkerPool> {
    const pool = new ProcessWorkerPool(init);
    try {
      await Promise.all(Array.from({ length: init.size }, (_, i) => pool.spawn(i)));
    } catch (e) {
      await pool.close();
      throw e;
    }
    return pool;
  }

  private spawn(index: number): Promise<void> {
    const i = this.init;
    const proc = fork(CHILD, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
      env: { ...process.env, EZTEST_WORKER_INDEX: String(index) },
    });
    let resolveExit!: () => void;
    const slot: Slot = { index, proc, ready: false, pids: [], dirs: [], tail: '', exited: new Promise<void>((r) => (resolveExit = r)) };
    this.slots[index] = slot;
    const keep = (chunk: Buffer, to: NodeJS.WriteStream) => {
      const s = chunk.toString();
      slot.tail = (slot.tail + s).slice(-8000);
      // Output of user code (console.log in code steps) shows as it does inline; Node's own warnings once per run are enough.
      const shown = s.split('\n').filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n');
      if (shown.trim()) to.write(shown.endsWith('\n') ? shown : `${shown}\n`);
    };
    proc.stdout!.on('data', (c: Buffer) => keep(c, process.stdout));
    proc.stderr!.on('data', (c: Buffer) => keep(c, process.stderr));
    return new Promise<void>((resolve, reject) => {
      let started = false;
      proc.on('message', (raw: unknown) => {
        const m = raw as FromWorker;
        if (m.type === 'ready') {
          started = true;
          slot.ready = true;
          for (const [id, v] of m.versions) if (v || !this.versionMap.has(id)) this.versionMap.set(id, v);
          if (this.cancelMsg) proc.send(this.cancelMsg);
          resolve();
          this.pump();
        } else if (m.type === 'init-error') {
          if (!started) reject(new Error(m.message));
        } else this.onMessage(slot, m);
      });
      proc.on('exit', (code, signal) => {
        resolveExit();
        slot.ready = false;
        if (!started) {
          // Its browsers and folders, if it got that far; start() or the restart reports the failure.
          for (const pid of slot.pids) killTree(pid);
          for (const d of slot.dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          reject(new Error(`worker process ${index} exited before it was ready (${signal ?? `exit code ${code}`})${slot.tail.trim() ? `: ${slot.tail.trim().split('\n').slice(-5).join(' | ')}` : ''}`));
          return;
        }
        void this.onExit(slot, code, signal);
      });
      proc.on('error', (e) => {
        if (!started) reject(e);
      });
      const msg: ToWorker = {
        type: 'init', index, runId: i.runId, runDir: i.runDir, fingerprintStore: i.fingerprintStore, stepTimeoutMs: i.stepTimeoutMs,
        targets: i.targets, journeys: i.journeys, data: i.plan.data, recipes: i.plan.recipes, ...(i.setup ? { setup: i.setup } : {}),
        secrets: i.options.knownSecrets?.() ?? [],
      };
      proc.send(msg);
    });
  }

  private onMessage(slot: Slot, m: FromWorker): void {
    const i = this.init;
    switch (m.type) {
      case 'record':
        i.evidence.recordFile(m.kind, join(i.runDir, m.path), m.meta).then(
          (value) => slot.proc.connected && slot.proc.send({ type: 'reply', rid: m.rid, ok: true, value } satisfies ToWorker),
          (e: Error) => slot.proc.connected && slot.proc.send({ type: 'reply', rid: m.rid, ok: false, error: e.message } satisfies ToWorker),
        );
        return;
      case 'event':
        i.options.events?.emit(m.event as EzEvent);
        return;
      case 'log':
        i.logger[m.level](m.msg, { ...(m.data ?? {}), worker: slot.index });
        return;
      case 'secret':
        i.options.addSecret?.(m.value);
        return;
      case 'resources':
        slot.pids = m.pids;
        slot.dirs = m.dirs;
        return;
      case 'result': {
        const t = slot.busy;
        if (!t || t.id !== m.id) return;
        slot.busy = undefined;
        importBddAllState(i.runDir, m.bdd);
        if (m.network) attemptNetwork.set(m.result, m.network as NetLogEntry[]);
        if (m.exports?.length) (i.options.store as { absorbExports?: (e: unknown[]) => void } | undefined)?.absorbExports?.(m.exports);
        Object.assign(this.driverEnv, m.driverEnv);
        if (m.context) this.contexts.set(slot.index, m.context);
        t.resolve(m.result);
        this.pump();
        return;
      }
      case 'task-error': {
        const t = slot.busy;
        if (!t || t.id !== m.id) return;
        slot.busy = undefined;
        const e = new Error(m.message);
        e.name = m.name ?? 'Error';
        const browser = t.journey.browser ?? i.targets[0].id;
        t.resolve({
          journeyId: t.journey.id, name: t.journey.name, startedAt: nowIso(), durationMs: 0, steps: t.journey.steps.map((s) => skippedStep(s, `not run: ${m.message}`)),
          tags: t.journey.tags, requirements: t.journey.requirements, risk: t.journey.risk, attempt: t.attempt, browser, ledger: {}, evidence: [],
          status: 'error', error: { message: m.message, name: e.name },
        });
        this.pump();
        return;
      }
    }
  }

  private async onExit(slot: Slot, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const i = this.init;
    // Browsers and temp folders of a worker that died (they are its own; nothing else removes them now).
    for (const pid of slot.pids) killTree(pid);
    for (const d of slot.dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    slot.pids = [];
    slot.dirs = [];
    const t = slot.busy;
    slot.busy = undefined;
    if (this.closing) return;
    const why = signal ? `crashed (signal ${signal})` : `exited with code ${code}`;
    i.logger.error('worker process died', { worker: slot.index, why, journeyId: t?.journey.id });
    if (t) {
      const ev: string[] = [];
      try {
        const ref = await i.evidence.store('log', `journeys/${safeName(t.journey.id)}/worker-crash.txt`,
          `The worker process ${slot.index} running attempt ${t.attempt} of "${t.journey.name}" ${why}.\n\nLast output of the worker:\n${slot.tail || '(none)'}\n`,
          { journeyId: t.journey.id, description: `worker process ${why}` });
        ev.push(ref.id);
      } catch {
        // the crash is still recorded on the result
      }
      t.resolve(workerCrashed(t.journey, t.attempt, t.journey.browser ?? i.targets[0].id, why, ev));
    }
    this.restarts++;
    try {
      await this.spawn(slot.index);
    } catch (e) {
      i.logger.error('worker process could not be restarted', { worker: slot.index, message: (e as Error).message });
      if (!this.slots.some((s) => s.ready)) for (const q of this.queue.splice(0)) q.resolve(workerCrashed(q.journey, q.attempt, q.journey.browser ?? i.targets[0].id, 'could not be started again', []));
    }
  }

  private pump(): void {
    for (const s of this.slots) {
      if (!this.queue.length) return;
      if (!s || !s.ready || s.busy || !s.proc.connected) continue;
      const t = this.queue.shift()!;
      s.busy = t;
      s.proc.send(t.msg);
    }
  }

  run(j: Journey, attempt: number, seed?: Record<string, unknown>, o: { teardown?: boolean } = {}): Promise<JourneyResult> {
    const id = ++this.nextId;
    return new Promise<JourneyResult>((resolve) => {
      const msg: Extract<ToWorker, { type: 'task' }> = {
        type: 'task', id, journey: j, attempt, ...(seed ? { seed } : {}), ...(o.teardown ? { teardown: true } : {}), bdd: exportBddAllState(this.init.runDir),
      };
      this.queue.push({ id, msg, journey: j, attempt, resolve });
      this.pump();
    });
  }

  /** Pass the run's cancel on to every worker (now and to workers started later). */
  cancel(signal: AbortSignal): void {
    const reason = signal.reason instanceof RunCancelledError ? signal.reason.signal : typeof signal.reason === 'string' ? signal.reason : 'aborted';
    const closeBrowsers = signal.reason instanceof RunCancelledError && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(signal.reason.signal) && !this.init.options.teardownOnCancel;
    this.cancelMsg = { type: 'cancel', reason, closeBrowsers };
    for (const s of this.slots) if (s?.proc.connected) s.proc.send(this.cancelMsg);
  }

  /** A forced stop (second signal, grace period over): kill workers and their browsers now, synchronously. */
  killNow(): void {
    this.closing = true;
    for (const s of this.slots) {
      if (!s) continue;
      try {
        s.proc.kill('SIGKILL');
      } catch {
        // gone
      }
      for (const pid of s.pids) killTree(pid);
      for (const d of s.dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  versions(): Map<string, string | undefined> {
    return new Map(this.versionMap);
  }

  driverEnvironment(): Record<string, string> {
    return { ...this.driverEnv };
  }

  contextReuse(): string | undefined {
    if (!this.contexts.size) return undefined;
    let c = 0;
    let r = 0;
    for (const x of this.contexts.values()) {
      c += x.created;
      r += x.reused;
    }
    return `${c} created, ${r} reused`;
  }

  /** Close the workers (they close their browsers and handlers); a worker that hangs is killed after `graceMs`. */
  async close(graceMs = 20_000): Promise<void> {
    this.closing = true;
    for (const s of this.slots) if (s?.proc.connected) s.proc.send({ type: 'close' } satisfies ToWorker);
    await Promise.all(this.slots.filter(Boolean).map(async (s) => {
      if (s.proc.exitCode !== null || s.proc.signalCode !== null) return s.exited;
      const t = setTimeout(() => s.proc.kill('SIGKILL'), graceMs);
      await s.exited;
      clearTimeout(t);
    }));
    for (const s of this.slots) {
      if (!s) continue;
      for (const pid of s.pids) killTree(pid);
      for (const d of s.dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
}
