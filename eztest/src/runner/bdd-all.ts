/**
 * Gherkin BeforeAll / AfterAll hooks (eztest/bdd).
 *
 * Scope: once per run, which is one `runJourneys` call: one `eztest run`, one Studio run, one shard
 * of a sharded run (`--shard i/n` runs on its own machine, so each shard runs the hook once).
 * Every `--workers` slot of the run shares the result.
 *
 *  - `runJourneys` runs each BeforeAll that applies to at least one scenario of the run as a hook
 *    journey of its own, before the scenarios start (so it has a browser context, the SDK, evidence
 *    and a result). Its `shared` values are kept for the run and copied into the World of every
 *    scenario the hook applies to. When it fails, those scenarios fail without running.
 *  - After the scenarios, each AfterAll that applies to a scenario that ran runs the same way, and
 *    sees the `shared` values of every BeforeAll.
 *  - A scenario run without that preparation (a debug session, a programmatic run of one journey)
 *    runs a BeforeAll it needs itself, once per process and run directory, inside its own result.
 */
import { EzTestError, Journey, nowIso, slugify, type StepResult } from '../core/index.js';
import { evaluateTags } from '../bdd/tags.js';
import { loadGlue } from '../bdd/load.js';
import { hooksFor, type BddAllContext, type Glue, type HookDefinition } from '../bdd/registry.js';
import { sdk } from '../sdk/journey.js';
import { openCodeHost, type CodeHostHandle } from './code-host.js';
import type { FlowEnv, FlowScope } from './flow.js';
import { relative, sep } from 'node:path';

interface AllState {
  /** BeforeAll hook id -> the values it shared. */
  shared: Map<string, Record<string, unknown>>;
  /** BeforeAll hook id -> why it failed. */
  failed: Map<string, string>;
  /** Hooks being run right now (concurrent scenarios wait for them). */
  pending: Map<string, Promise<void>>;
}

const states = new Map<string, AllState>();

/** The BeforeAll / AfterAll state of a run (keyed by its run directory). */
export function bddAllState(runDir: string): AllState {
  let s = states.get(runDir);
  if (!s) states.set(runDir, (s = { shared: new Map(), failed: new Map(), pending: new Map() }));
  return s;
}

export function clearBddAllState(runDir: string): void {
  states.delete(runDir);
}

const rel = (file: string, base: string) => {
  const r = relative(base, file);
  return (r && !r.startsWith('..') ? r : file).split(sep).join('/');
};

export const allHookLabel = (hk: HookDefinition, baseDir: string) =>
  `${hk.kind === 'beforeAll' ? 'BeforeAll' : 'AfterAll'} hook${hk.name ? `: ${hk.name}` : ''} (${rel(hk.file, baseDir)}:${hk.line})`;

/** The union of the glue files of a set of scenarios, in first-seen order. */
function glueFilesOf(journeys: Journey[]): string[] {
  const out: string[] = [];
  for (const j of journeys) for (const f of j.bdd?.glue ?? []) if (!out.includes(f)) out.push(f);
  return out;
}

const applies = (hk: HookDefinition, j: Journey) => !hk.tagExpression || evaluateTags(hk.tagExpression, j.tags);

/**
 * The BeforeAll (or AfterAll) hook journeys for the Gherkin scenarios of a run: one per hook that
 * applies to at least one of them, in hook order.
 */
export async function bddAllJourneys(journeys: Journey[], kind: 'beforeAll' | 'afterAll', baseDir: string): Promise<Journey[]> {
  const bdd = journeys.filter((j) => j.bdd);
  if (!bdd.length) return [];
  const files = glueFilesOf(bdd);
  let glue: Glue;
  try {
    glue = await loadGlue(files, { cwd: baseDir });
  } catch {
    return []; // the scenarios report why the step definitions do not load
  }
  if (glue.errors.length) return [];
  const worldParameters = bdd.find((j) => j.bdd?.worldParameters)?.bdd?.worldParameters;
  const ids = new Map<string, number>();
  const list = glue.hooks.filter((x) => x.kind === kind).sort((a, b) => a.order - b.order || a.seq - b.seq);
  if (kind === 'afterAll') list.reverse();
  return list
    .filter((hk) => bdd.some((j) => applies(hk, j)))
    .map((hk) => {
      const label = allHookLabel(hk, baseDir);
      let id = `bdd-${kind === 'beforeAll' ? 'before-all' : 'after-all'}--${slugify(hk.name ?? `${rel(hk.file, baseDir)}-${hk.line}`)}`;
      const n = (ids.get(id) ?? 0) + 1;
      ids.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      return Journey.parse({
        id, name: label, tags: ['hook', kind, 'bdd'],
        code: { file: hk.file, name: label, line: hk.line },
        bddAll: { kind, hook: hk.id, glue: files, ...(worldParameters ? { worldParameters } : {}) },
        steps: [{ id: 'hook', intent: label, action: 'code', handler: 'bdd', source: { file: hk.file, line: hk.line } }],
      });
    });
}

/** Run a hook's function as a reported group of the host; returns what it shared, or throws when it failed. */
async function runHookGroup(h: CodeHostHandle, hk: HookDefinition, baseDir: string, shared: Record<string, unknown>, parameters: Record<string, unknown>, extra: Partial<BddAllContext> = {}): Promise<StepResult | undefined> {
  const before = h.results.length;
  const attachments: string[] = [];
  const ctx: BddAllContext = {
    ...sdk, shared, parameters, ...extra,
    attach: async (name, content, description) => {
      const id = await h.host.evidence('data', name, content, description ?? `attachment ${name}`);
      attachments.push(id);
      return id;
    },
  };
  try {
    await h.group(allHookLabel(hk, baseDir), async () => {
      const out = await (hk.fn as unknown as (this: unknown, c: BddAllContext) => unknown).call(shared, ctx);
      if (out && typeof out === 'object' && !Array.isArray(out)) Object.assign(shared, out);
    }, { file: hk.file, line: hk.line });
  } catch {
    // recorded as the hook's failure
  }
  const r = h.results.length > before ? h.results[h.results.length - 1] : undefined;
  if (r) {
    r.gherkin = { kind: hk.kind === 'beforeAll' ? 'beforeAll' : 'afterAll', line: hk.line, match: 'hook', location: `${rel(hk.file, baseDir)}:${hk.line}` };
    if (attachments.length) r.evidence = [...r.evidence, ...attachments];
  }
  return r;
}

const failedHard = (r: StepResult | undefined) => !!r && ((r.status === 'failed' && !r.soft) || r.status === 'blocked');

/** One attempt of a BeforeAll / AfterAll hook journey. */
export async function runBddAllHook(journey: Journey, scope: FlowScope, flow: FlowEnv): Promise<{ steps: StepResult[]; status: 'passed' | 'passed-healed' | 'failed' | 'skipped'; error?: { message: string; name?: string } }> {
  const meta = journey.bddAll!;
  const baseDir = flow.opts.baseDir ?? process.cwd();
  const h = openCodeHost(scope, flow, journey.code?.file ?? '');
  const state = bddAllState(h.host.runDir);
  const glue = await loadGlue(meta.glue, { cwd: baseDir });
  const hk = glue.hooks.find((x) => x.id === meta.hook);
  if (!hk) throw new EzTestError(`The ${meta.kind} hook ${meta.hook} is no longer defined`, 'BDD_HOOK');
  const shared: Record<string, unknown> = meta.kind === 'beforeAll' ? {} : Object.assign({}, ...state.shared.values());
  const r = await h.within(() => runHookGroup(h, hk, baseDir, shared, meta.worldParameters ?? {}));
  const failed = failedHard(r);
  if (meta.kind === 'beforeAll') {
    if (failed) state.failed.set(hk.id, r?.error?.message ?? 'failed');
    else state.shared.set(hk.id, shared);
  }
  const status = failed ? 'failed' : r?.status === 'passed-healed' ? 'passed-healed' : 'passed';
  return { steps: h.results, status, ...(failed ? { error: { message: `${journey.name}: ${r?.error?.message ?? 'failed'}`, name: 'HookFailed' } } : {}) };
}

/**
 * Inside a scenario: make sure every BeforeAll that applies to it has run in this run (running it
 * here, once, when the run did not prepare it), and return the values to copy into the World, or
 * the failed hook's result.
 */
export async function beforeAllFor(h: CodeHostHandle, glue: Glue, tags: string[], baseDir: string, parameters: Record<string, unknown>): Promise<{ shared: Record<string, unknown>; failed?: StepResult }> {
  const state = bddAllState(h.host.runDir);
  const shared: Record<string, unknown> = {};
  for (const hk of hooksFor(glue, 'beforeAll', tags)) {
    if (!state.shared.has(hk.id) && !state.failed.has(hk.id)) {
      let p = state.pending.get(hk.id);
      if (!p) {
        p = (async () => {
          const mine: Record<string, unknown> = {};
          const r = await runHookGroup(h, hk, baseDir, mine, parameters);
          if (failedHard(r)) state.failed.set(hk.id, r?.error?.message ?? 'failed');
          else state.shared.set(hk.id, mine);
        })().finally(() => state.pending.delete(hk.id));
        state.pending.set(hk.id, p);
      }
      await p;
    }
    const why = state.failed.get(hk.id);
    if (why !== undefined) {
      const failed: StepResult = {
        stepId: `before-all-${slugify(hk.name ?? String(hk.line))}`, intent: allHookLabel(hk, baseDir), status: 'failed', startedAt: nowIso(), durationMs: 0,
        conditions: [], evidence: [], error: { name: 'BeforeAllFailed', message: `not run: ${allHookLabel(hk, baseDir)} failed: ${why}` },
        gherkin: { kind: 'beforeAll', line: hk.line, match: 'hook', location: `${rel(hk.file, baseDir)}:${hk.line}` },
      };
      return { shared, failed };
    }
    Object.assign(shared, state.shared.get(hk.id));
  }
  return { shared };
}
