/**
 * The SDK's process-wide state: the journey registry filled while a module is
 * loaded, the source maps of bundled modules (for call-site lines), and the
 * AsyncLocalStorage that tells `ui`, `db`, `expect`, `step()` ... which
 * journey attempt they belong to.
 *
 * Everything lives on `globalThis` under a `Symbol.for` key, so a journey
 * module that resolves `eztest/sdk` to another copy of this file (a published
 * install next to a source checkout, or `dist/` next to `src/`) still talks to
 * the runner that loaded it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Journey, StepInput, StepResult, StepSource } from '../core/index.js';
import type { JourneyOptions, JourneyFn } from './types.js';

/** One `journey()` call seen while a module was loading. */
export interface Registration {
  name: string;
  options: JourneyOptions;
  fn: JourneyFn;
  /** Absolute path of the module being loaded (the file `eztest run` discovered). */
  file: string;
  line?: number;
}

/** What the runner gives the SDK for one journey attempt (implemented in runner/code-journeys.ts). */
export interface SdkHost {
  readonly journey: Journey;
  readonly baseDir: string;
  readonly runDir: string;
  /** Run a step through the runner path (locating, healing, post-conditions, evidence, trace, debugger). */
  exec(step: Omit<StepInput, 'id'> & { id?: string }, o?: ExecOptions): Promise<StepResult>;
  /** Record a step that runs in Node (files, generic assertions): timing, debugger checkpoint, evidence, report. */
  record<T>(intent: string, fn: (rec: LocalRecorder) => Promise<T>, o?: RecordOptions): Promise<T>;
  /** A nested, reported step (`step()`). */
  group<T>(name: string, fn: () => Promise<T>, source?: StepSource): Promise<T>;
  /** Run an `.ez`/YAML/JSON or library journey (or another code journey) with parameters; returns its Returns values. */
  runJourney(ref: string, params: Record<string, unknown>, source?: StepSource): Promise<Record<string, unknown>>;
  /** Evaluate a declarative condition without failing (polls up to timeoutMs). */
  probe(condition: unknown, timeoutMs: number): Promise<boolean>;
  /** Journey variables, run variables, Examples row and ledger, merged (later wins). */
  vars(): Record<string, unknown>;
  getVar(key: string): unknown;
  setVar(key: string, value: unknown): void;
  deleteVar(key: string): void;
  /** The Examples row (data-driven journeys), else {}. */
  row(): Record<string, string>;
  /** Store a piece of evidence (masked, hash-chained) and return its id. */
  evidence(kind: 'data' | 'log' | 'screenshot' | 'document', name: string, content: string | Uint8Array, description: string): Promise<string>;
  /** Screenshot of the current page as evidence (undefined when there is no page). */
  screenshot(name: string, description: string): Promise<string | undefined>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
  /** A record from the test data fabric (RunOptions.data). */
  lease(entity: string, where: Record<string, string>, as: string, strategy?: string): Promise<Record<string, unknown>>;
  /** The live browser page (escape hatch; actions on it bypass verification). */
  page(): unknown;
  /** Objects kept for the whole journey attempt (`journeyInstance`). */
  instances(): Map<unknown, unknown>;
  /** A reported group tried again until it passes (`poll`, step definitions with `{ retry }`). */
  retrying?<T>(name: string, fn: () => Promise<T>, o: { attempts?: number; within?: number; every?: number; message?: string }, source?: StepSource): Promise<T>;
  /** Register a code cleanup action, run after the journey (`cleanup.add`). */
  addCleanup?(description: string, fn: () => Promise<unknown>): void;
  /** Run `fn` with a transaction open on a connection alias (`db.transaction`). */
  transaction?<T>(connection: string, fn: () => Promise<T>, source?: StepSource): Promise<T>;
  readonly signal?: AbortSignal;
}

export interface ExecOptions {
  /** A failure is recorded but does not throw (soft assertion). */
  soft?: boolean;
  /** A failure is recorded as skipped and does not throw. */
  optional?: boolean;
  source?: StepSource;
}

export interface RecordOptions {
  soft?: boolean;
  source?: StepSource;
  /** "assert" records the step as a check (counts as an assertion in reports). */
  kind?: 'action' | 'assert';
}

/** Lets a Node-side step attach what it found. */
export interface LocalRecorder {
  capture(key: string, value: unknown): void;
  evidence(id: string): void;
  /** Mark the step failed without throwing (the caller decides). */
  fail(message: string): void;
  warn(message: string): void;
}

/** The ALS frame: which host, and whether expectations are soft here. */
export interface Frame {
  host: SdkHost;
  soft: boolean;
  /** The host's current step group (opaque to the SDK). */
  node?: unknown;
  /** Multi-actor journeys: the actor SDK calls run as (`actors.manager.ui...`). */
  actor?: string;
}

/** A decoded source map of a bundled module: generated line -> segments [genCol, sourceIdx, line, col]. */
export interface BundleMap {
  sources: string[];
  lines: Array<Array<[number, number, number, number]>>;
}

interface Shared {
  als: AsyncLocalStorage<Frame>;
  /** Registrations by module file. */
  registry: Map<string, Registration[]>;
  /** Files currently being loaded (innermost last). */
  loading: string[];
  /** Bundle file path -> source map. */
  maps: Map<string, BundleMap>;
  /** Original source files that belong to code journeys (absolute paths). */
  userFiles: Set<string>;
}

const KEY = Symbol.for('eztest.sdk.runtime.v1');

export function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { als: new AsyncLocalStorage<Frame>(), registry: new Map(), loading: [], maps: new Map(), userFiles: new Set() };
    g[KEY] = s;
  }
  return s;
}

/** Thrown by SDK calls outside a running journey. */
export class SdkContextError extends Error {
  constructor(what: string) {
    super(`${what} can only be used while EZTest runs a code journey or a "Run code" step (it was called outside one)`);
    this.name = 'SdkContextError';
  }
}

/** The current frame, or a clear error. */
export function frame(what = 'eztest/sdk'): Frame {
  const f = shared().als.getStore();
  if (!f) throw new SdkContextError(what);
  return f;
}

export function currentHost(what?: string): SdkHost {
  return frame(what).host;
}

/** Run `fn` with a host bound (used by the runner). */
export function withHost<T>(host: SdkHost, fn: () => Promise<T>, node?: unknown): Promise<T> {
  return shared().als.run({ host, soft: false, ...(node !== undefined ? { node } : {}) }, fn);
}

/** Run `fn` inside a child step group of the current frame (used by the runner's host). */
export function withNode<T>(node: unknown, fn: () => Promise<T>): Promise<T> {
  const f = shared().als.getStore();
  if (!f) throw new SdkContextError('step()');
  return shared().als.run({ ...f, node }, fn);
}

/** The current frame without throwing (undefined outside a journey). */
export function currentFrame(): Frame | undefined {
  return shared().als.getStore();
}

/** Run `fn` as an actor of a multi-actor journey: its `ui` calls use that actor's browser context. */
export function withActor<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  const f = frame(`actors.${actor}`);
  return shared().als.run({ ...f, actor }, fn);
}

/** Run `fn` with expectations made soft. */
export function withSoft<T>(fn: () => Promise<T>): Promise<T> {
  const f = frame('soft()');
  return shared().als.run({ ...f, soft: true }, fn);
}

/**
 * Thrown when a step fails hard. It carries the recorded result, so the
 * enclosing `step()` or journey knows the failure is already reported.
 */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly result: StepResult,
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}
