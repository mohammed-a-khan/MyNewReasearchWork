/**
 * Monitor state: per-journey health, persisted atomically so restarts keep
 * consecutive-failure counts and never re-send an alert already sent.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JourneyResult, JourneyStatus } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { redactText } from '../mocks/redact.js';

/** up: healthy; degraded: failing but under the flap guard; down: alerted failure; unknown: no runs yet. */
export type MonitorHealth = 'up' | 'degraded' | 'down' | 'unknown';

export interface JourneyMonitorState {
  journeyId: string;
  name: string;
  health: MonitorHealth;
  lastStatus?: JourneyStatus;
  consecutiveFailures: number;
  /** ISO time the health last changed between up and down. */
  lastChange?: string;
  lastRunAt?: string;
  lastRunDir?: string;
  lastFailingStep?: { stepId: string; intent: string; message?: string };
  lastError?: string;
  totalRuns: number;
  passedRuns: number;
  /** Percent of counted runs (skipped excluded) that passed, null before any run. */
  uptimePct: number | null;
  /** Recent durations (ms), newest last, capped at the window size. */
  durations: number[];
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface AlertRecord {
  id: string;
  at: string;
  journeyId: string;
  kind: 'down' | 'recovered';
  delivered: string[];
  failed: Array<{ channel: string; error: string }>;
}

export interface MonitorState {
  format: 'eztest-monitor-state';
  version: 1;
  startedAt: string;
  updatedAt: string;
  ticks: number;
  runs: number;
  skippedTicks: number;
  /** Most recent skipped ticks (overlap), newest last. */
  skips: Array<{ at: string; reason: string }>;
  lastRunError?: string;
  journeys: Record<string, JourneyMonitorState>;
  /** Most recent alerts, newest last. */
  alerts: AlertRecord[];
}

export const MAX_HISTORY = 100;

export function emptyMonitorState(now: string): MonitorState {
  return {
    format: 'eztest-monitor-state',
    version: 1,
    startedAt: now,
    updatedAt: now,
    ticks: 0,
    runs: 0,
    skippedTicks: 0,
    skips: [],
    journeys: {},
    alerts: [],
  };
}

export async function loadMonitorState(path: string, now: string): Promise<MonitorState> {
  if (!existsSync(path)) return emptyMonitorState(now);
  let parsed: MonitorState;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as MonitorState;
  } catch (e) {
    throw new EzTestError(`Monitor state file is corrupt: ${path} (${(e as Error).message})`, 'MONITOR_STATE_INVALID');
  }
  if (parsed?.format !== 'eztest-monitor-state' || parsed.version !== 1 || typeof parsed.journeys !== 'object') {
    throw new EzTestError(`Not an EZTest monitor state file: ${path}`, 'MONITOR_STATE_INVALID');
  }
  return parsed;
}

export async function saveMonitorState(path: string, state: MonitorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function isPass(s: JourneyStatus): boolean {
  return s === 'passed' || s === 'passed-healed';
}

export interface Transition {
  journeyId: string;
  kind: 'down' | 'recovered';
}

export interface ApplyOptions {
  /** Consecutive failures before a "down" alert (flap guard), default 2. */
  failureThreshold: number;
  window: number;
  now: string;
  runDir?: string;
}

/** Fold one journey result into the state. Returns the alert-worthy transition, if any. */
export function applyResult(state: MonitorState, r: JourneyResult, o: ApplyOptions): Transition | undefined {
  const js: JourneyMonitorState = (state.journeys[r.journeyId] ??= {
    journeyId: r.journeyId,
    name: r.name,
    health: 'unknown',
    consecutiveFailures: 0,
    totalRuns: 0,
    passedRuns: 0,
    uptimePct: null,
    durations: [],
    p50Ms: null,
    p95Ms: null,
  });
  js.name = r.name;
  js.lastStatus = r.status;
  js.lastRunAt = o.now;
  if (o.runDir) js.lastRunDir = o.runDir;
  if (r.status === 'skipped') return undefined;

  js.totalRuns += 1;
  js.durations = [...js.durations, r.durationMs].slice(-o.window);
  js.p50Ms = percentile(js.durations, 50);
  js.p95Ms = percentile(js.durations, 95);

  let transition: Transition | undefined;
  if (isPass(r.status)) {
    js.passedRuns += 1;
    js.consecutiveFailures = 0;
    js.lastFailingStep = undefined;
    js.lastError = undefined;
    if (js.health === 'down') {
      transition = { journeyId: r.journeyId, kind: 'recovered' };
      js.lastChange = o.now;
    } else if (js.health === 'unknown') js.lastChange = o.now;
    js.health = 'up';
  } else {
    js.consecutiveFailures += 1;
    const failing = r.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
    js.lastFailingStep = failing
      ? { stepId: failing.stepId, intent: redactText(failing.intent), message: failing.error?.message ? redactText(failing.error.message).slice(0, 1000) : undefined }
      : undefined;
    const err = r.error?.message ?? failing?.error?.message;
    js.lastError = err ? redactText(err).slice(0, 1000) : undefined;
    if (js.health !== 'down') {
      if (js.consecutiveFailures >= o.failureThreshold) {
        js.health = 'down';
        js.lastChange = o.now;
        transition = { journeyId: r.journeyId, kind: 'down' };
      } else js.health = 'degraded';
    }
  }
  js.uptimePct = js.totalRuns ? Math.round((js.passedRuns / js.totalRuns) * 10000) / 100 : null;
  return transition;
}
