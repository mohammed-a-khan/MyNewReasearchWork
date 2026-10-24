/**
 * Debugger client state: the debug session (from `/api/debug/*`), its event
 * stream, the paused state, live step statuses and step details. Pages and
 * panels subscribe to `dbg`; commands go through `command()`.
 */
import { api } from '../../core/api.js';
import { announce } from '../../core/dom.js';
import { follow } from '../../core/events.js';
import { store } from '../../core/store.js';
import { toast, toastError } from '../../ui/toast.js';

export type PausePhase = 'before-step' | 'before-verify' | 'before-heal' | 'failed';

export interface StepResultLite {
  stepId: string;
  intent: string;
  status: string;
  durationMs: number;
  error?: { message: string };
  conditions?: Array<{ condition: Record<string, unknown> & { type: string }; passed: boolean; actual?: string; message?: string }>;
  usedLocator?: { strategy: string; value: string; name?: string };
  heal?: { tier: string; confidence: number; verified: boolean; healed: { strategy: string; value: string } };
}

export interface ServerBreakpoint {
  id: string;
  stepIndex?: number;
  stepId?: string;
  enabled: boolean;
  hits: number;
  condition?: Record<string, unknown>;
}

export interface DebugState {
  status: 'idle' | 'running' | 'paused' | 'finished';
  journeyId?: string;
  journeyName?: string;
  attempt?: number;
  stepIndex?: number;
  stepId?: string;
  intent?: string;
  /** Multi-actor journeys: the actor of the current step (its browser is the one on screen). */
  actor?: string;
  phase?: PausePhase;
  reason?: string;
  pausedAt?: string;
  url?: string;
  vars?: Record<string, unknown>;
  ledger?: Record<string, unknown>;
  lastResult?: StepResultLite;
  steps?: Array<{ index: number; id: string; intent: string; edited: boolean }>;
  breakpoints: ServerBreakpoint[];
  pauseOnFailure: boolean;
}

export interface StepDetails {
  index: number;
  stepId: string;
  intent: string;
  execution: number;
  status?: string;
  durationMs?: number;
  used?: { description: string; strategy: string; value: string };
  tried: Array<{ description: string; count: number; error?: string }>;
  notes: string[];
  heal: { attempts: Array<{ tier: string; description: string; confidence: number; reason: string; matches: number }>; notes: string[] };
  conditions: Array<{ text: string; type: string; passed: boolean; actual?: string; message?: string; expected?: string }>;
}

export interface NetEntry {
  id: number;
  stepIndex: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  startedAt: number;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  mimeType?: string;
}

export interface ConsoleEntry {
  stepIndex: number;
  type: string;
  text: string;
  location?: string;
  at: number;
}

export interface Details {
  step?: StepDetails;
  network: NetEntry[];
  console: ConsoleEntry[];
  current: number;
}

export interface StepLive {
  status: string;
  durationMs?: number;
  stepId?: string;
  intent?: string;
  /** How many times this index ran (loops reuse a block step; each leaf execution gets a new index). */
  runs?: number;
  /** Multi-actor journeys: who ran the step. */
  actor?: string;
}

export type SessionPhase = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error';

export interface DbgView {
  /** Session id while one exists (also after it finished). */
  id?: string;
  journeyId?: string;
  phase: SessionPhase;
  state?: DebugState;
  /** Live status per step index. */
  steps: Record<number, StepLive>;
  /** Step indices in the order they started (nested block steps have indices past the top-level ones). */
  order?: number[];
  /** Step index currently running or paused at. */
  current?: number;
  result?: { status?: string; runId?: string };
  details?: Details;
  /** The session ended with Stop: the rest of the journey was not run (teardown hooks were). */
  stopped?: boolean;
  /** Step index whose details are shown (defaults to the current one). */
  detailIndex?: number;
  error?: string;
}

export const dbg = store<DbgView>({ phase: 'idle', steps: {} });

let stopFollow: (() => void) | undefined;
let detailsTimer: ReturnType<typeof setTimeout> | undefined;

export const isPaused = () => dbg.get().phase === 'paused';
export const isActive = () => ['starting', 'running', 'paused'].includes(dbg.get().phase);

export async function refreshState(): Promise<void> {
  try {
    const r = await api.get<{ id?: string; journeyId?: string; state: string; result?: DbgView['result']; debug?: DebugState }>('/api/debug/session');
    if (r.state === 'idle' || !r.id) return;
    const cur = dbg.get();
    const paused = r.debug?.status === 'paused';
    dbg.set({
      ...cur,
      id: r.id,
      journeyId: r.journeyId,
      state: r.debug ?? cur.state,
      phase: r.state === 'running' ? (paused ? 'paused' : cur.phase === 'starting' ? 'running' : cur.phase === 'paused' ? 'running' : cur.phase === 'idle' ? 'running' : cur.phase) : r.state === 'done' || r.state === 'stopped' ? 'done' : 'error',
      stopped: r.state === 'stopped',
      current: r.debug?.stepIndex ?? cur.current,
      result: r.result ?? cur.result,
    });
  } catch {
    // not connected
  }
}

export async function refreshDetails(index?: number): Promise<void> {
  const cur = dbg.get();
  if (!cur.id) return;
  const i = index ?? cur.detailIndex ?? cur.current;
  try {
    const d = await api.get<Details & { steps: Array<{ index: number; status?: string; durationMs?: number }> }>(`/api/debug/details${i === undefined ? '' : `?index=${i}`}`);
    dbg.patch({ details: d });
  } catch {
    // session gone
  }
}

function scheduleDetails(): void {
  clearTimeout(detailsTimer);
  detailsTimer = setTimeout(() => void refreshDetails(), 120);
}

function onEvent(e: { type: string; [k: string]: unknown }): void {
  const cur = dbg.get();
  const idx = typeof e.stepIndex === 'number' ? e.stepIndex : undefined;
  switch (e.type) {
    case 'debug.stepStarted':
      if (idx !== undefined) dbg.set({ ...cur, phase: cur.phase === 'paused' ? 'running' : cur.phase === 'starting' ? 'running' : cur.phase, current: idx, steps: { ...cur.steps, [idx]: { status: 'running', stepId: String(e.stepId ?? ''), intent: String(e.intent ?? ''), runs: (cur.steps[idx]?.runs ?? 0) + 1, ...(typeof e.actor === 'string' ? { actor: e.actor } : {}) } }, order: [...(cur.order ?? []), idx], detailIndex: undefined });
      break;
    case 'debug.stepFinished':
      if (idx !== undefined) dbg.set({ ...cur, steps: { ...cur.steps, [idx]: { ...cur.steps[idx], status: String(e.status), durationMs: Number(e.durationMs) } } });
      scheduleDetails();
      break;
    case 'debug.stepSkipped':
      if (idx !== undefined) dbg.set({ ...cur, steps: { ...cur.steps, [idx]: { ...cur.steps[idx], status: 'skipped', stepId: String(e.stepId ?? '') } } });
      break;
    case 'debug.paused':
      {
        // A pause before a step comes before its "started" event: remember which step (and, for nested ones, where) it is.
        const known = idx !== undefined ? cur.steps[idx] : undefined;
        const entry: StepLive | undefined = idx === undefined ? undefined : { ...known, status: e.phase === 'failed' ? 'failed' : known?.status ?? '', stepId: String(e.stepId ?? known?.stepId ?? ''), intent: String(e.intent ?? known?.intent ?? ''), ...(typeof e.actor === 'string' ? { actor: e.actor } : {}) };
        const order = idx !== undefined && !(cur.order ?? []).includes(idx) ? [...(cur.order ?? []), idx] : cur.order;
        dbg.set({ ...cur, phase: 'paused', current: idx ?? cur.current, detailIndex: undefined, order, steps: idx !== undefined && entry ? { ...cur.steps, [idx]: entry } : cur.steps });
      }
      announce(e.phase === 'failed' ? `Paused on failure at step ${(idx ?? 0) + 1}` : `Paused before step ${(idx ?? 0) + 1}`);
      void refreshState().then(() => refreshDetails());
      break;
    case 'debug.resumed':
      if (cur.phase === 'paused') dbg.set({ ...cur, phase: 'running' });
      break;
    case 'debug.stepEdited':
      void refreshState();
      break;
    case 'session-error':
      dbg.patch({ error: String(e.message ?? 'Debug session failed') });
      toastError(`Debug session failed: ${String(e.message ?? '')}`);
      break;
    case 'done': {
      const status = typeof e.status === 'string' ? e.status : undefined;
      const stopped = e.state === 'stopped';
      dbg.set({ ...dbg.get(), phase: e.state === 'error' ? 'error' : 'done', stopped, result: { status, runId: typeof e.runId === 'string' ? e.runId : undefined } });
      announce(stopped ? 'Debug run stopped: the remaining steps were not run' : `Debug run finished${status ? `: ${status}` : ''}`);
      if (stopped) toast('Debug run stopped: the remaining steps were not run', { kind: 'warning', timeout: 4000 });
      else if (status) toast(`Debug run finished: ${status}`, { kind: status.startsWith('passed') ? 'success' : 'warning', timeout: 4000 });
      void refreshDetails();
      stopFollow?.();
      stopFollow = undefined;
      break;
    }
    default:
      break;
  }
}

/** Follow the session's event stream (replayed from the start). */
export function attach(id: string): void {
  stopFollow?.();
  stopFollow = follow('/api/debug/events', onEvent, (e) => e.type === 'done');
  void id;
}

export interface StartOptions {
  journey: string;
  breakpoints: Array<({ stepIndex: number } | { stepId: string } | { line: number; file: string }) & { condition?: string; enabled?: boolean }>;
  pauseOnFailure: boolean;
  pauseAtStart: boolean;
}

export async function startSession(o: StartOptions): Promise<void> {
  dbg.set({ phase: 'starting', steps: {}, journeyId: o.journey });
  try {
    const r = await api.post<{ id: string; journeyId: string }>('/api/debug/sessions', o);
    dbg.set({ phase: 'running', steps: {}, id: r.id, journeyId: r.journeyId });
    attach(r.id);
  } catch (e) {
    dbg.set({ phase: 'idle', steps: {}, error: (e as Error).message });
    throw e;
  }
}

export async function command(command: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const r = await api.post<{ debug: DebugState }>('/api/debug/command', { command, ...extra });
    if (command !== 'pause') dbg.patch({ state: r.debug, phase: r.debug.status === 'paused' ? 'paused' : 'running' });
    return true;
  } catch (e) {
    toastError(`${command}: ${(e as Error).message}`);
    return false;
  }
}

export async function stopSession(): Promise<void> {
  try {
    await api.post('/api/debug/stop', {});
  } catch (e) {
    toastError(`Stop: ${(e as Error).message}`);
  }
  await refreshState();
}

/** Re-attach to a session that is already running (page reload, another tab). */
export async function resume(): Promise<void> {
  type S = { id?: string; journeyId?: string; state: string; debug?: DebugState; result?: DbgView['result'] };
  const r = await api.get<S>('/api/debug/session').catch((): S => ({ state: 'idle' }));
  if (!r.id || r.state === 'idle') return;
  if (dbg.get().id === r.id) return;
  dbg.set({ phase: r.state === 'running' ? 'running' : r.state === 'done' || r.state === 'stopped' ? 'done' : 'error', stopped: r.state === 'stopped', steps: {}, id: r.id, journeyId: r.journeyId });
  if (r.state === 'running') attach(r.id);
  else {
    // A finished session: replay its events once for the statuses.
    attach(r.id);
  }
  await refreshState();
}
