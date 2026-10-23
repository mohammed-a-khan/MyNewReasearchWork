/**
 * Journeys as production monitors: the same journey files run on a schedule,
 * with per-journey health, flap-guarded alerts on state change only, and
 * atomically persisted state.
 */
import { join } from 'node:path';
import type { Journey, JourneyResult, RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { redactText } from '../mocks/redact.js';
import { assertMonitorSafe, type MonitorSafetyOptions } from './guard.js';
import { buildAlert, deliverAlert, validateChannels, type AlertChannel, type MonitorAlert } from './alerts.js';
import { applyResult, loadMonitorState, saveMonitorState, MAX_HISTORY, type MonitorState } from './state.js';

export type MonitorEvent =
  | { type: 'tick'; tick: number }
  | { type: 'skip'; tick: number }
  | { type: 'run'; tick: number; result: RunResult }
  | { type: 'run-error'; tick: number; error: string }
  | { type: 'alert'; alert: MonitorAlert; delivered: string[]; failed: Array<{ channel: string; error: string }> };

export interface MonitorOptions extends MonitorSafetyOptions {
  journeys: Journey[];
  /** Runs the journeys, e.g. `engine.run` or `(j) => runJourneys(j, opts)`. */
  run: (journeys: Journey[]) => Promise<RunResult>;
  intervalMs: number;
  /** Number of runs to start before stopping (skipped ticks do not count). Omit to run until `signal` aborts. */
  iterations?: number;
  signal?: AbortSignal;
  stateFile: string;
  alerts?: AlertChannel[];
  now?: () => Date;
  /** Consecutive failures before a "down" alert (flap guard), default 2. */
  failureThreshold?: number;
  /** Duration window for p50/p95, default 50 runs. */
  window?: number;
  /** Where runs are written; the run dir in alerts is `<outputDir>/<runId>`. */
  outputDir?: string;
  /** Overrides how the run dir is derived from a result. */
  runDirOf?: (run: RunResult) => string | undefined;
  /** Optional triage hint for a failing journey (e.g. from insights.triageJourney). Redacted before use. */
  triageHint?: (journey: JourneyResult, run: RunResult) => string | undefined | Promise<string | undefined>;
  onEvent?: (e: MonitorEvent) => void;
}

function syntheticError(j: Journey, message: string, now: string): JourneyResult {
  return {
    journeyId: j.id,
    name: j.name,
    status: 'error',
    startedAt: now,
    durationMs: 0,
    steps: [],
    tags: j.tags,
    requirements: j.requirements,
    risk: j.risk,
    attempt: 1,
    ledger: {},
    evidence: [],
    error: { message },
  };
}

export async function runMonitor(opts: MonitorOptions): Promise<MonitorState> {
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) throw new EzTestError('Monitor: intervalMs must be > 0', 'MONITOR_CONFIG');
  if (opts.iterations !== undefined && (!Number.isInteger(opts.iterations) || opts.iterations < 1)) {
    throw new EzTestError('Monitor: iterations must be a positive integer', 'MONITOR_CONFIG');
  }
  if (opts.iterations === undefined && !opts.signal) {
    throw new EzTestError('Monitor: give iterations or an AbortSignal so the monitor can stop', 'MONITOR_CONFIG');
  }
  const failureThreshold = opts.failureThreshold ?? 2;
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new EzTestError('Monitor: failureThreshold must be >= 1', 'MONITOR_CONFIG');
  const window = opts.window ?? 50;
  assertMonitorSafe(opts.journeys, opts);
  const channels = opts.alerts ?? [];
  validateChannels(channels);
  const nowIso = () => (opts.now ? opts.now() : new Date()).toISOString();
  const emit = (e: MonitorEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* listener errors never stop a monitor */
    }
  };

  const state = await loadMonitorState(opts.stateFile, nowIso());
  let saveChain: Promise<void> = Promise.resolve();
  const save = () => {
    state.updatedAt = nowIso();
    const snapshot = JSON.parse(JSON.stringify(state)) as MonitorState;
    saveChain = saveChain.then(() => saveMonitorState(opts.stateFile, snapshot));
    return saveChain;
  };

  const runDirOf = (r: RunResult): string | undefined =>
    opts.runDirOf ? opts.runDirOf(r) : opts.outputDir ? join(opts.outputDir, r.runId) : undefined;

  async function doRun(tick: number): Promise<void> {
    const at = nowIso();
    let result: RunResult | undefined;
    let results: JourneyResult[];
    try {
      result = await opts.run(opts.journeys);
      const byId = new Map(result.journeys.map((j) => [j.journeyId, j]));
      results = opts.journeys.map((j) => byId.get(j.id) ?? syntheticError(j, 'journey missing from run result', at));
      state.lastRunError = undefined;
      emit({ type: 'run', tick, result });
    } catch (e) {
      const msg = redactText((e as Error)?.message ?? String(e));
      state.lastRunError = msg;
      results = opts.journeys.map((j) => syntheticError(j, `run failed: ${msg}`, at));
      emit({ type: 'run-error', tick, error: msg });
    }
    state.runs += 1;
    const runDir = result ? runDirOf(result) : undefined;
    for (const jr of results) {
      const t = applyResult(state, jr, { failureThreshold, window, now: nowIso(), runDir });
      if (!t) continue;
      const js = state.journeys[t.journeyId];
      let hint: string | undefined;
      if (t.kind === 'down' && opts.triageHint && result) {
        try {
          hint = await opts.triageHint(jr, result);
        } catch {
          hint = undefined;
        }
      }
      const alert = buildAlert(t.kind, js, { at: nowIso(), triageHint: hint, runDir });
      if (state.alerts.some((a) => a.id === alert.id)) continue; // already sent (dedupe across restarts)
      const outcome = channels.length ? await deliverAlert(channels, alert) : { delivered: [], failed: [] };
      state.alerts = [...state.alerts, { id: alert.id, at: alert.at, journeyId: alert.journeyId, kind: alert.kind, ...outcome }].slice(-MAX_HISTORY);
      emit({ type: 'alert', alert, ...outcome });
    }
    await save();
  }

  return new Promise<MonitorState>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> | undefined;
    let ticks = 0;
    let started = 0;
    let finished = false;
    let failure: unknown;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', finish);
      Promise.resolve(inFlight)
        .then(() => save())
        .then(() => (failure ? reject(failure) : resolve(state)), reject);
    };

    const tick = () => {
      if (finished) return;
      if (opts.signal?.aborted) return finish();
      ticks += 1;
      state.ticks += 1;
      emit({ type: 'tick', tick: ticks });
      if (inFlight) {
        state.skippedTicks += 1;
        state.skips = [...state.skips, { at: nowIso(), reason: 'previous run still in progress' }].slice(-MAX_HISTORY);
        emit({ type: 'skip', tick: ticks });
        save().catch((e) => {
          failure = e;
          finish();
        });
      } else {
        const t = ticks;
        started += 1;
        inFlight = doRun(t)
          .catch((e) => {
            failure = e;
            finish();
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      if (opts.iterations !== undefined && started >= opts.iterations) return finish();
      timer = setTimeout(tick, opts.intervalMs);
    };

    opts.signal?.addEventListener('abort', finish, { once: true });
    tick();
  });
}
