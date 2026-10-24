/**
 * A process worker of a `workers: process` run (see protocol.ts): it builds its run options (data
 * from the run, handlers from the worker setup), opens its own browsers, and runs one journey
 * attempt at a time when the run asks. Terminal signals are left to the run, which cancels the
 * workers over IPC; when the run goes away (the IPC channel closes) the worker removes its
 * browsers and exits.
 */
import { EventBus, type EvidenceKind, type EvidenceRef, type Logger } from '../../core/index.js';
import { FingerprintStore } from '../../heal/store.js';
import { cleanupBrowsersNow, liveBrowserPids, observeLiveBrowsers } from '../../browser/launcher/launch.js';
import { observeTrackedTempDirs, trackedTempDirs } from '../../browser/launcher/temp-dirs.js';
import { LocalAttemptRunner } from '../attempts.js';
import { exportBddAllState, importBddAllState } from '../bdd-all.js';
import { RunCancelledError } from '../cancel.js';
import { createRunExtensions } from '../extensions.js';
import { attemptNetwork } from '../journey.js';
import type { RunOptions } from '../types.js';
import { cloneable, type FromWorker, type ToWorker, type WorkerRecipe, type WorkerSetupResult } from './protocol.js';
import { RemoteEvidenceWriter } from './remote-evidence.js';

const send = (m: FromWorker): void => {
  if (process.connected) process.send!(m);
};

// The run cancels its workers itself (a terminal Ctrl+C reaches the whole process group).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => undefined);
process.on('disconnect', () => {
  cleanupBrowsersNow();
  process.exit(1);
});

let replies = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function ask<T>(m: { type: 'record'; kind: EvidenceKind; path: string; meta: Record<string, string | undefined> }): Promise<T> {
  const rid = ++replies;
  return new Promise<T>((resolve, reject) => {
    waiting.set(rid, { resolve: resolve as (v: unknown) => void, reject });
    send({ ...m, rid } as FromWorker);
  });
}

const forwardLogger: Logger = {
  debug: (msg, data) => send({ type: 'log', level: 'debug', msg, ...(data ? { data: cloneable(data) } : {}) }),
  info: (msg, data) => send({ type: 'log', level: 'info', msg, ...(data ? { data: cloneable(data) } : {}) }),
  warn: (msg, data) => send({ type: 'log', level: 'warn', msg, ...(data ? { data: cloneable(data) } : {}) }),
  error: (msg, data) => send({ type: 'log', level: 'error', msg, ...(data ? { data: cloneable(data) } : {}) }),
};

/** Buffers arrive as plain Uint8Arrays over IPC (client certificates, keys): make them Buffers again. */
function asBuffers(v: unknown, seen = new Set<unknown>()): unknown {
  if (v instanceof Uint8Array) return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (!v || typeof v !== 'object' || seen.has(v) || v instanceof Date || v instanceof RegExp || v instanceof Map || v instanceof Set) return v;
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => asBuffers(x, seen));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, asBuffers(x, seen)]));
}

async function rebuild(r: WorkerRecipe): Promise<unknown> {
  const mod = (await import(r.module)) as Record<string, unknown>;
  const fn = mod[r.export ?? 'default'];
  if (typeof fn !== 'function') throw new Error(`worker recipe: ${r.module} has no function "${r.export ?? 'default'}"`);
  return (fn as (...a: unknown[]) => unknown)(...(r.args ?? []));
}

let runner: LocalAttemptRunner | undefined;
let store: FingerprintStore | undefined;
let evidence: RemoteEvidenceWriter | undefined;
let options: RunOptions | undefined;
let setup: WorkerSetupResult | undefined;
let runDir = '';
const controller = new AbortController();
let resourcesQueued = false;
const reportResources = () => {
  if (resourcesQueued) return;
  resourcesQueued = true;
  queueMicrotask(() => {
    resourcesQueued = false;
    send({ type: 'resources', pids: liveBrowserPids(), dirs: trackedTempDirs() });
  });
};

async function init(m: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  runDir = m.runDir;
  observeLiveBrowsers(reportResources);
  observeTrackedTempDirs(reportResources);
  if (m.setup) {
    const mod = (await import(m.setup.module)) as Record<string, unknown>;
    const fn = mod[m.setup.export ?? 'default'] as (args: unknown, ctx: { secrets: string[]; onSecret(v: string): void }) => Promise<WorkerSetupResult>;
    if (typeof fn !== 'function') throw new Error(`worker setup: ${m.setup.module} has no function "${m.setup.export ?? 'default'}"`);
    setup = await fn(m.setup.args, { secrets: m.secrets, onSecret: (value) => send({ type: 'secret', value }) });
  }
  const rebuilt: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(m.recipes)) rebuilt[k] = await rebuild(r);
  const events = new EventBus();
  events.on((event) => send({ type: 'event', event: cloneable(event) }));
  const o = { ...(setup?.options ?? {}), ...asBuffers(m.data) as Record<string, unknown>, ...rebuilt, events, logger: forwardLogger, signal: controller.signal } as RunOptions;
  for (const k of ['locks', 'debug', 'workers', 'workerSetup', 'healthChecks', 'manual'] as const) delete (o as unknown as Record<string, unknown>)[k];
  options = o;
  store = await FingerprintStore.open(m.fingerprintStore);
  evidence = new RemoteEvidenceWriter(m.runDir, (kind, path, meta) => ask<EvidenceRef>({ type: 'record', kind, path, meta }), o.mask);
  const extensions = createRunExtensions(o, { runId: m.runId, runDir: m.runDir, browserName: m.targets[0].id, evidence, logger: forwardLogger });
  runner = await LocalAttemptRunner.open(o, {
    runId: m.runId, runDir: m.runDir, evidence, logger: forwardLogger, store, extensions, stepTimeoutMs: m.stepTimeoutMs,
    targets: m.targets, journeys: m.journeys, launch: { handleSignals: false },
  });
  send({ type: 'ready', versions: [...runner.versions()], launchErrors: [] });
}

async function task(m: Extract<ToWorker, { type: 'task' }>): Promise<void> {
  try {
    importBddAllState(runDir, m.bdd);
    const r = await runner!.run(m.journey, m.attempt, m.seed, { teardown: m.teardown });
    await evidence!.flush();
    await store!.save();
    const net = attemptNetwork.get(r);
    const exp = (options!.store as { pipelineExport?: () => { entries: unknown[] } } | undefined)?.pipelineExport?.().entries;
    send({
      type: 'result', id: m.id, result: cloneable(r), ...(net ? { network: cloneable(net) } : {}), bdd: cloneable(exportBddAllState(runDir)),
      ...(exp?.length ? { exports: cloneable(exp) } : {}), driverEnv: runner!.driverEnvironment(), ...(runner!.contextCounts() ? { context: runner!.contextCounts() } : {}),
    });
  } catch (e) {
    send({ type: 'task-error', id: m.id, message: (e as Error)?.message ?? String(e), name: (e as Error)?.name });
  }
}

async function close(): Promise<void> {
  try {
    await runner?.close();
    await store?.save();
    await setup?.close?.();
  } finally {
    observeLiveBrowsers(undefined);
    observeTrackedTempDirs(undefined);
    process.exit(0);
  }
}

process.on('message', (raw: unknown) => {
  const m = raw as ToWorker;
  switch (m.type) {
    case 'init':
      init(m).catch((e: Error) => {
        send({ type: 'init-error', message: e?.message ?? String(e) });
        setTimeout(() => process.exit(2), 100);
      });
      break;
    case 'task':
      void task(m);
      break;
    case 'cancel':
      if (!controller.signal.aborted) controller.abort(new RunCancelledError(m.reason));
      // A cancel by a terminal signal stops running steps at once, as it does in an inline run.
      if (m.closeBrowsers) cleanupBrowsersNow();
      break;
    case 'close':
      void close();
      break;
    case 'reply': {
      const w = waiting.get(m.rid);
      waiting.delete(m.rid);
      if (w) m.ok ? w.resolve(m.value) : w.reject(new Error(m.error ?? 'request failed'));
      break;
    }
  }
});
