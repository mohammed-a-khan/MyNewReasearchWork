/**
 * Process workers (`workers: process`, docs/scale.md): the messages between a run and its worker
 * processes, and what of the run options can cross into a worker.
 *
 * The run (the parent) keeps everything that must be one per run: the journey queue, resource
 * locks, `Depends on:` handoff, run-wide setup values, retries, the circuit breaker, the evidence
 * vault and its hash chain, results and run.json. A worker runs one journey attempt at a time on
 * its own browser and records its evidence through the run, so the chain stays one sequence.
 *
 * Messages use Node's "advanced" IPC serialization (structured clone): Buffers, Maps and Dates
 * cross as they are.
 */
import type { EvidenceKind, EvidenceRef, EzEvent, Journey, JourneyResult } from '../../core/index.js';
import type { ResolvedBrowser } from '../browsers.js';
import type { RunOptions } from '../types.js';

/** A module function that rebuilds a value in the worker: `(await import(module))[exportName](...args)`. */
export interface WorkerRecipe {
  module: string;
  export?: string;
  args?: unknown[];
}

/**
 * Builds the run options a worker needs that cannot be copied (handlers, healers, lenses ...):
 * `(await import(module))[export ?? 'default'](args)` returns them. The engine and the CLI give one
 * (src/cli/run-worker.ts); library users with handlers give their own.
 */
export interface WorkerSetup {
  module: string;
  export?: string;
  args?: unknown;
}

/** What a setup module returns. */
export interface WorkerSetupResult {
  options: Partial<RunOptions>;
  /** Called when the worker stops. */
  close?(): Promise<void>;
}

export const WORKER_RECIPE = Symbol.for('eztest.workerRecipe');

/** Mark a value (a healer, a handler) as rebuildable in a worker process from a module function. */
export function withWorkerRecipe<T extends object>(value: T, recipe: WorkerRecipe): T {
  Object.defineProperty(value, WORKER_RECIPE, { value: recipe, enumerable: false });
  return value;
}

export function recipeOf(v: unknown): WorkerRecipe | undefined {
  return v && (typeof v === 'object' || typeof v === 'function') ? ((v as Record<symbol, unknown>)[WORKER_RECIPE] as WorkerRecipe | undefined) : undefined;
}

/** Run options that stay with the run itself (the worker gets its own versions, or does not need them). */
export const PARENT_ONLY: ReadonlySet<string> = new Set([
  'events', 'logger', 'signal', 'locks', 'debug', 'workers', 'workerSetup', 'healthChecks', 'circuitBreaker', 'addSecret', 'knownSecrets', 'retryStrategy',
]);

/** Plain data that structured clone carries unchanged (no functions, no class instances). */
export function isPlainData(v: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return true;
  if (t !== 'object') return false;
  if (depth > 64 || seen.has(v)) return seen.has(v);
  seen.add(v);
  if (v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return true;
  if (Array.isArray(v)) return v.every((x) => isPlainData(x, seen, depth + 1));
  if (v instanceof Map) return [...v].every(([k, x]) => isPlainData(k, seen, depth + 1) && isPlainData(x, seen, depth + 1));
  if (v instanceof Set) return [...v].every((x) => isPlainData(x, seen, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v as Record<string, unknown>).every((x) => isPlainData(x, seen, depth + 1));
}

export interface TransferPlan {
  /** Data options, copied as they are. */
  data: Record<string, unknown>;
  /** Options rebuilt in the worker from their recipe. */
  recipes: Record<string, WorkerRecipe>;
  /** Options that can neither be copied nor rebuilt (functions, class instances without a recipe). */
  blocked: string[];
}

/** Split the run options into what a worker gets as data, what it rebuilds, and what it cannot have. */
export function planTransfer(options: RunOptions): TransferPlan {
  const data: Record<string, unknown> = {};
  const recipes: Record<string, WorkerRecipe> = {};
  const blocked: string[] = [];
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined || PARENT_ONLY.has(k)) continue;
    const recipe = recipeOf(v);
    if (recipe) recipes[k] = recipe;
    else if (isPlainData(v)) data[k] = v;
    else blocked.push(k);
  }
  return { data, recipes, blocked };
}

/** A copy of a value that structured clone accepts: functions and symbols dropped, odd objects as JSON. */
export function cloneable<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : typeof x === 'function' || typeof x === 'symbol' ? undefined : x)) ?? 'null') as T;
  }
}

/** Gherkin BeforeAll state of a run, shared between its workers (src/runner/bdd-all.ts). */
export interface BddAllSnapshot {
  shared: Array<[string, Record<string, unknown>]>;
  failed: Array<[string, string]>;
}

export type ToWorker =
  | {
    type: 'init';
    index: number;
    runId: string;
    runDir: string;
    fingerprintStore: string;
    stepTimeoutMs: number;
    targets: ResolvedBrowser[];
    journeys: Journey[];
    data: Record<string, unknown>;
    recipes: Record<string, WorkerRecipe>;
    setup?: WorkerSetup;
    /** Secret values the run masks (the worker masks them in its evidence too). */
    secrets: string[];
  }
  | { type: 'task'; id: number; journey: Journey; attempt: number; seed?: Record<string, unknown>; teardown?: boolean; bdd: BddAllSnapshot }
  | { type: 'cancel'; reason: string; closeBrowsers: boolean }
  | { type: 'close' }
  | { type: 'reply'; rid: number; ok: boolean; value?: unknown; error?: string };

export type FromWorker =
  | { type: 'ready'; versions: Array<[string, string | undefined]>; launchErrors: Array<[string, string]> }
  | { type: 'init-error'; message: string }
  | { type: 'record'; rid: number; kind: EvidenceKind; path: string; meta: { stepId?: string; journeyId?: string; description?: string } }
  | { type: 'event'; event: EzEvent }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }
  | { type: 'secret'; value: string }
  | { type: 'resources'; pids: number[]; dirs: string[] }
  | {
    type: 'result'; id: number; result: JourneyResult; network?: unknown[]; bdd: BddAllSnapshot; exports?: unknown[];
    driverEnv: Record<string, string>; context?: { created: number; reused: number };
  }
  | { type: 'task-error'; id: number; message: string; name?: string };

/** Evidence ref as the vault returns it. */
export type RecordReply = EvidenceRef;
