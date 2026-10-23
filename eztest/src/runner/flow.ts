/**
 * The flow engine: runs block steps (If/Otherwise, Repeat, For each, While,
 * Retry, Try/On failure, groups, "In the X frame" blocks) and sub-journeys
 * ("Run journey ... with k=v"), recursing into their child steps. Leaf steps
 * go back to the journey runner, so healing, evidence, lenses and events work
 * the same at every depth. Block results carry their children, so reports
 * show the nesting.
 *
 * Conditions are declarative Conditions or safe expressions; nothing is
 * evaluated as code.
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  EzTestError, asNumber, evaluateExpression, isBlockStep, nowIso, sleep, slugify, truthy,
  type Condition, type ConditionResult, type EventBus, type FlowSpec, type Journey, type Logger, type Step, type StepResult,
} from '../core/index.js';
import { frameAction } from './advanced.js';
import { evaluateConditionOnce } from './conditions.js';
import { safeName } from './evidence.js';
import { Ledger } from './ledger.js';
import { envFor, skippedStep } from './step.js';
import type { RunOptions, StepContext } from './types.js';
import type { ActorRuntime } from './actors.js';

/** Where a list of steps runs: which journey (for ids, variables and fingerprints), which ledger, which evidence prefix. */
export interface FlowScope {
  journey: Journey;
  ledger: Ledger;
  /** Evidence path prefix (unique per loop iteration / sub-journey). */
  prefix: string;
  /** Extra variables (sub-journey parameters). */
  params?: Record<string, unknown>;
  /** Sub-journey nesting depth (guards against runaway recursion). */
  depth: number;
  /** Multi-actor journeys: the actor this list runs as (undefined: the primary actor). "Switch to user" sets it. */
  actor?: string;
}

export interface FlowEnv {
  opts: RunOptions;
  logger: Logger;
  events?: EventBus;
  stepTimeoutMs: number;
  /** Run a leaf step in a scope (the journey runner's runStep). */
  leaf(step: Step, scope: FlowScope): Promise<StepResult>;
  /** Build a step context in a scope. */
  ctx(step: Step, scope: FlowScope): StepContext;
  /** Called when a step starts (for network/console attribution). */
  onStep?(stepId: string): void;
  /** Journeys "Run journey" can call (besides opts.library). */
  journeys?: Journey[];
  /**
   * Platform drivers (native apps) evaluate conditions themselves: If/While conditions and block
   * post-conditions go through this instead of the page-based evaluator when set.
   */
  evaluateConditions?(conditions: Condition[], ctx: StepContext, timeoutMs: number): Promise<ConditionResult[]>;
  /** Code steps (eztest/sdk) that run in Node: wrapped with the trace and debugger like a leaf step. */
  wrap?(step: Step, exec: (step: Step) => Promise<StepResult>): Promise<StepResult>;
  /** Code `step()` groups: a debugger checkpoint before the group ('skip' skips it) and a notice when it ends. */
  group?(step: Step): { before(): Promise<'continue' | 'skip'>; after(result: StepResult): void };
  /** Multi-actor journeys: actor contexts (set by the web journey runner; see actors.ts). */
  actors?: ActorRuntime;
}

const MAX_SUB_DEPTH = 10;

/** Run one step: a block through the flow engine, anything else as a leaf. */
export async function executeStep(step: Step, scope: FlowScope, env: FlowEnv): Promise<StepResult> {
  env.onStep?.(step.id);
  let r: StepResult;
  if (step.action === 'code') r = await (await import('./code-host.js')).runCodeStep(step, scope, env);
  else if (step.action === 'actor' && step.steps === undefined) r = await switchActor(step, scope, env);
  else if (isBlockStep(step) || step.action === 'runJourney') r = await runBlock(step, scope, env);
  else r = await env.leaf(step, scope);
  const session = env.ctx(step, scope).session;
  const warnings = session?.takeWarnings() ?? [];
  if (warnings.length) r.warnings = [...(r.warnings ?? []), ...warnings];
  if (step.soft) r.soft = true;
  return r;
}

interface ListOutcome {
  failed: boolean;
  /** Message of the first hard failure. */
  error?: string;
}

/** Run a list of steps; stop at the first hard failure and record the rest as skipped. */
async function runList(list: Step[] | undefined, scope: FlowScope, env: FlowEnv, out: StepResult[], tag: Pick<StepResult, 'branch' | 'iteration'>): Promise<ListOutcome> {
  let blocked: string | undefined;
  let error: string | undefined;
  let softFailed = false;
  for (const child of list ?? []) {
    if (!blocked && env.opts.signal?.aborted) {
      blocked = 'not run: run cancelled';
      error = 'run cancelled';
    }
    if (blocked) {
      out.push({ ...skippedStep(child, blocked), ...tag });
      continue;
    }
    const r = await executeStep(child, scope, env);
    out.push({ ...r, ...tag });
    if (r.status === 'failed' && !child.optional) {
      if (child.soft || r.soft) softFailed = true;
      else {
        blocked = `not run: step "${child.id}" failed`;
        error = r.error?.message ?? 'failed';
      }
    }
  }
  return { failed: blocked !== undefined, error: error ?? (softFailed ? 'a soft assertion failed' : undefined) };
}

/** The actor a step names (its value, with ${var} filled in). */
function actorName(step: Step, scope: FlowScope, env: FlowEnv): string {
  if (!env.actors) throw new EzTestError(`"${step.intent}": several actors need a web journey (or a code journey) run by EZTest's browser runner`, 'NO_ACTORS');
  const name = env.ctx(step, scope).interpolate(step.value ?? '').trim();
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new EzTestError(`"${step.intent}": "${name}" is not an actor name (letters, digits, _ . -)`, 'BAD_ACTOR');
  return name;
}

/** The login an actor with a role does when it first acts. */
function actorLoginStep(step: Step, role: string): Step {
  return { id: `${step.id}-login`, intent: `Log in as ${role}`, action: 'login', value: role, postconditions: [], optional: false };
}

/** "Switch to user "bob"": the rest of this step list runs as bob (created, and signed in when bob has a role). */
async function switchActor(step: Step, scope: FlowScope, env: FlowEnv): Promise<StepResult> {
  const t0 = Date.now();
  const startedAt = nowIso();
  env.events?.emit({ type: 'step:start', journeyId: scope.journey.id, stepId: step.id, intent: step.intent });
  const children: StepResult[] = [];
  let conditions: StepResult['conditions'] = [];
  let error: string | undefined;
  let name = '';
  try {
    name = actorName(step, scope, env);
    const { slot } = await env.actors!.enter(name);
    if (slot.platform !== 'web') throw new EzTestError(`"${step.intent}": ${name} is a ${slot.platform} actor; use an "As ${name}:" block for native steps`, 'BAD_ACTOR');
    scope.actor = name;
    if (slot.spec.role && !slot.signedIn) {
      slot.signedIn = true;
      const login = await executeStep(actorLoginStep(step, slot.spec.role), scope, env);
      children.push({ ...login, branch: 'body' });
      if (login.status === 'failed') error = `actor "${name}" could not sign in as ${slot.spec.role}: ${login.error?.message ?? 'failed'}`;
    }
    // Expectations written after "Switch to user" are checked in that user's session.
    if (!error && step.postconditions.length) {
      const ctx = env.ctx(step, scope);
      if (env.evaluateConditions) conditions = await env.evaluateConditions(step.postconditions, ctx, env.opts.conditionTimeoutMs ?? 5000);
      else {
        const { evaluateConditions } = await import('./conditions.js');
        conditions = await evaluateConditions(step.postconditions, envFor(ctx, env.opts), env.opts.conditionTimeoutMs ?? 5000);
      }
      const bad = conditions.filter((c) => !c.passed);
      if (bad.length) error = `post-condition failed: ${bad.map((c) => `${c.condition.type}: ${c.message ?? 'failed'}`).join('; ')}`;
    }
  } catch (e) {
    error = (e as Error).message.split('\n')[0];
  }
  const sr: StepResult = {
    stepId: step.id, intent: step.intent, status: error ? 'failed' : 'passed', startedAt, durationMs: Date.now() - t0, conditions, evidence: [],
    ...(children.length ? { children } : {}), ...(name ? { captured: { actor: name } } : {}), ...(error ? { error: { message: error } } : {}),
    ...(env.actors?.labelled && name ? { actor: name } : {}),
  };
  env.events?.emit({ type: 'step:end', journeyId: scope.journey.id, stepId: step.id, status: sr.status, durationMs: sr.durationMs });
  return sr;
}

/** Evaluate an If/While condition: a declarative condition or a safe expression. */
export async function flowConditionHolds(flow: FlowSpec | undefined, step: Step, scope: FlowScope, env: FlowEnv): Promise<boolean> {
  if (!flow || (!flow.condition && !flow.expr)) throw new EzTestError(`"${step.intent}" has no condition`, 'BAD_BLOCK');
  const ctx = env.ctx(step, scope);
  let v: boolean;
  if (flow.expr) v = truthy(evaluateExpression(flow.expr, ctx.vars()));
  else {
    const r = env.evaluateConditions
      ? (await env.evaluateConditions([flow.condition!], ctx, 0).catch(() => [{ passed: false }]))[0]
      : await evaluateConditionOnce(flow.condition!, envFor(ctx, env.opts)).catch(() => ({ passed: false }));
    v = r.passed;
  }
  return flow.negate ? !v : v;
}

/** Rows of a data file (csv, xlsx, json) as records. */
export async function readDataRows(path: string, sheet?: string): Promise<Array<Record<string, unknown>>> {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    const rows = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { rows?: unknown }).rows) ? (v as { rows: unknown[] }).rows : undefined;
    if (!rows) throw new EzTestError(`${path}: expected a JSON array of rows`, 'BAD_DATA');
    return rows as Array<Record<string, unknown>>;
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    const { parseCsv } = await import('../importers/manual.js');
    const table = parseCsv(await readFile(path, 'utf8'), ext === '.tsv' ? '\t' : undefined).filter((r) => r.some((c) => c.trim() !== ''));
    const [head, ...body] = table;
    if (!head) return [];
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
  }
  if (ext === '.xlsx') {
    const { readXlsx } = await import('../importers/xlsx.js');
    return readXlsx(path, sheet ? { sheet } : {});
  }
  throw new EzTestError(`Unsupported data file "${path}" (use .csv, .tsv, .xlsx or .json)`, 'BAD_DATA');
}

/** Temporarily set loop variables in the ledger; returns a restore function. */
function bindVars(ledger: Ledger, values: Record<string, unknown>): () => void {
  const view = ledger.view();
  const saved = Object.keys(values).map((k) => [k, k in view, view[k]] as const);
  for (const [k, v] of Object.entries(values)) ledger.set(k, v);
  return () => {
    for (const [k, had, v] of saved) {
      if (had) ledger.set(k, v);
      else ledger.delete(k);
    }
  };
}

function itemsOf(v: unknown, what: string): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && 'status' in v && 'body' in v && Array.isArray((v as { body: unknown }).body)) return (v as { body: unknown[] }).body;
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      if (Array.isArray(p)) return p;
    } catch {
      /* fall through */
    }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (v && typeof v === 'object') return Object.entries(v).map(([key, value]) => ({ key, value }));
  throw new EzTestError(`${what} is not a list`, 'NOT_A_LIST');
}

/** Resolve a "Run journey" reference: library by id/name, then RunOptions.resolveJourney (e.g. files). */
async function resolveSub(ref: string, env: FlowEnv): Promise<Journey> {
  const pool = [...(env.opts.library ?? []), ...(env.journeys ?? [])];
  const slug = slugify(ref);
  const hit = pool.find((j) => j.id === ref) ?? pool.find((j) => j.name === ref) ?? pool.find((j) => j.id === slug || slugify(j.name) === slug);
  if (hit) return hit;
  const resolved = await env.opts.resolveJourney?.(ref);
  if (resolved) return resolved;
  const known = pool.map((j) => j.id).slice(0, 15).join(', ');
  throw new EzTestError(`No journey "${ref}" to run (known: ${known || 'none'}; pass RunOptions.library or tag shared journeys @library)`, 'NO_JOURNEY');
}

async function runBlock(step: Step, scope: FlowScope, env: FlowEnv): Promise<StepResult> {
  const t0 = Date.now();
  const startedAt = nowIso();
  env.events?.emit({ type: 'step:start', journeyId: scope.journey.id, stepId: step.id, intent: step.intent });
  const children: StepResult[] = [];
  const f = step.flow ?? {};
  let error: string | undefined;
  let iterations = 0;
  const captured: Record<string, unknown> = {};
  const nativeEvidence: string[] = [];
  // An As block's own post-conditions are checked in that actor's session.
  let condScope = scope;
  const iterPrefix = (i: number) => `${scope.prefix}/${safeName(step.id)}-${i}`;
  try {
    switch (step.action) {
      case 'group':
        error = (await runList(step.steps, scope, env, children, { branch: 'body' })).error;
        break;
      case 'frame': {
        const ctx = env.ctx(step, scope);
        if (!ctx.session) throw new EzTestError('frame blocks need a browser session', 'NO_SESSION');
        const saved = ctx.session.pages.frames;
        try {
          await frameAction(step, ctx, step.timeoutMs ?? env.stepTimeoutMs);
          error = (await runList(step.steps, scope, env, children, { branch: 'body' })).error;
        } finally {
          ctx.session.pages.frames = saved;
        }
        break;
      }
      case 'if': {
        const holds = await flowConditionHolds(step.flow, step, scope, env);
        captured.branch = holds ? 'then' : 'otherwise';
        error = (await runList(holds ? step.steps : step.else, scope, env, children, { branch: holds ? 'then' : 'else' })).error;
        break;
      }
      case 'repeat': {
        const raw = typeof f.times === 'string' ? env.ctx(step, scope).interpolate(f.times) : f.times;
        const n = asNumber(raw);
        if (n === undefined || n < 0 || !Number.isInteger(n)) throw new EzTestError(`Repeat needs a whole number of times, got "${String(raw)}"`, 'BAD_BLOCK');
        const as = f.as ?? 'index';
        for (let i = 1; i <= n; i++) {
          iterations = i;
          const restore = bindVars(scope.ledger, { [as]: i });
          try {
            error = (await runList(step.steps, { ...scope, prefix: iterPrefix(i) }, env, children, { iteration: i })).error;
          } finally {
            restore();
          }
          if (error) break;
        }
        break;
      }
      case 'forEach': {
        let items: unknown[];
        const ctx = env.ctx(step, scope);
        if (f.data) items = await readDataRows(resolve(env.opts.baseDir ?? process.cwd(), ctx.interpolate(f.data)), f.sheet);
        else if (f.items) items = itemsOf(evaluateExpression(f.items, ctx.vars()), f.items);
        else throw new EzTestError('For each needs a list or a data file', 'BAD_BLOCK');
        const as = f.as ?? (f.data ? 'row' : 'item');
        captured.count = items.length;
        for (let i = 0; i < items.length; i++) {
          iterations = i + 1;
          const restore = bindVars(scope.ledger, { [as]: items[i], index: i + 1 });
          try {
            error = (await runList(step.steps, { ...scope, prefix: iterPrefix(i + 1) }, env, children, { iteration: i + 1 })).error;
          } finally {
            restore();
          }
          if (error) break;
        }
        break;
      }
      case 'while': {
        const max = f.maxIterations ?? env.opts.maxLoopIterations ?? 100;
        let i = 0;
        while (await flowConditionHolds(step.flow, step, scope, env)) {
          if (env.opts.signal?.aborted) {
            error = 'run cancelled';
            break;
          }
          if (i >= max) {
            error = `While loop still running after ${max} iterations (raise the limit with "max N times")`;
            break;
          }
          i++;
          iterations = i;
          const restore = bindVars(scope.ledger, { [f.as ?? 'index']: i });
          try {
            error = (await runList(step.steps, { ...scope, prefix: iterPrefix(i) }, env, children, { iteration: i })).error;
          } finally {
            restore();
          }
          if (error) break;
          if (f.delayMs) await sleep(f.delayMs);
        }
        break;
      }
      case 'retry': {
        const attempts = f.attempts ?? 3;
        for (let i = 1; i <= attempts; i++) {
          iterations = i;
          const r = await runList(step.steps, { ...scope, prefix: iterPrefix(i) }, env, children, { iteration: i });
          error = r.error;
          if (!r.failed) {
            error = undefined;
            break;
          }
          if (env.opts.signal?.aborted) break;
          if (i < attempts) {
            env.logger.info('retrying block', { stepId: step.id, attempt: i, error: r.error });
            await sleep(f.delayMs ?? 500);
          }
        }
        if (error) error = `failed after ${attempts} attempts: ${error}`;
        break;
      }
      case 'try': {
        const r = await runList(step.steps, scope, env, children, { branch: 'body' });
        if (r.failed) {
          captured.handled = r.error;
          const restore = bindVars(scope.ledger, { error: r.error ?? 'failed' });
          try {
            error = (await runList(step.catch, scope, env, children, { branch: 'catch' })).error;
          } finally {
            restore();
          }
        }
        break;
      }
      case 'actor': {
        // "As manager:": the children run in that actor's own context and session.
        const name = actorName(step, scope, env);
        const { slot } = await env.actors!.enter(name);
        captured.actor = name;
        if (slot.platform !== 'web') {
          if (!env.actors!.runNative) throw new EzTestError(`actor "${name}" runs on ${slot.platform}, but no platform driver is available for it`, 'NO_DRIVER');
          const r = await env.actors!.runNative(slot, step.steps ?? [], scope.ledger.view());
          for (const c of r.steps) children.push({ ...c, actor: name, branch: 'body' });
          for (const [k, v] of Object.entries(r.ledger)) scope.ledger.set(k, v);
          nativeEvidence.push(...r.evidence);
          error = r.error;
          break;
        }
        const inner: FlowScope = { ...scope, actor: name };
        condScope = inner;
        if (slot.spec.role && !slot.signedIn) {
          slot.signedIn = true;
          const login = await executeStep(actorLoginStep(step, slot.spec.role), inner, env);
          children.push({ ...login, branch: 'body' });
          if (login.status === 'failed') {
            error = `actor "${name}" could not sign in as ${slot.spec.role}: ${login.error?.message ?? 'failed'}`;
            break;
          }
        }
        error = (await runList(step.steps, inner, env, children, { branch: 'body' })).error;
        break;
      }
      case 'parallel': {
        // "In parallel:": each child (an As block, usually) is a branch; branches run at the same time.
        const branches = step.steps ?? [];
        const run = async (child: Step): Promise<StepResult> => {
          if (env.opts.signal?.aborted) return skippedStep(child, 'not run: run cancelled');
          // A branch gets its own scope: a "Switch to user" inside it does not change its siblings.
          return executeStep(child, { ...scope }, env);
        };
        let results: StepResult[];
        if (env.actors?.sequentialParallel) {
          results = [];
          for (const b of branches) results.push(await run(b));
        } else {
          results = await Promise.all(branches.map(run));
        }
        captured.branches = branches.length;
        if (env.actors?.sequentialParallel) captured.sequential = true;
        results.forEach((r) => children.push({ ...r, branch: 'body' }));
        const bad = results.filter((r, i) => r.status === 'failed' && !branches[i].optional && !branches[i].soft && !r.soft);
        if (bad.length) error = bad.map((r) => `${r.intent}: ${r.error?.message ?? 'failed'}`).join('; ');
        break;
      }
      case 'runJourney': {
        if (scope.depth >= MAX_SUB_DEPTH) throw new EzTestError(`Sub-journeys nested more than ${MAX_SUB_DEPTH} deep (a journey calls itself?)`, 'SUB_DEPTH');
        const ctx = env.ctx(step, scope);
        const sub = await resolveSub(ctx.interpolate(step.value ?? ''), env);
        const params = Object.fromEntries(Object.entries(step.args ?? {}).map(([k, v]) => [k, typeof v === 'string' ? ctx.interpolate(v) : v]));
        const missing = (sub.params ?? []).filter((p) => params[p] === undefined && sub.variables[p] === undefined);
        if (missing.length) throw new EzTestError(`Journey "${sub.name}" needs parameter(s): ${missing.join(', ')}`, 'MISSING_PARAM');
        const ledger = new Ledger();
        for (const [k, v] of Object.entries(params)) ledger.set(k, v);
        const subScope: FlowScope = { journey: sub, ledger, prefix: `${scope.prefix}/${safeName(sub.id)}-${safeName(step.id)}`, params, depth: scope.depth + 1 };
        error = (await runList(sub.steps, subScope, env, children, { branch: 'body' })).error;
        const returned: Record<string, unknown> = {};
        for (const k of sub.returns ?? []) {
          const v = ledger.get(k);
          if (v === undefined && !error) error = `Journey "${sub.name}" did not set its return value "${k}"`;
          returned[k] = v;
        }
        if (!error) {
          if (step.captureAs) scope.ledger.set(step.captureAs, returned);
          else for (const [k, v] of Object.entries(returned)) scope.ledger.set(k, v);
        }
        Object.assign(captured, step.captureAs ? { [step.captureAs]: returned } : returned);
        break;
      }
      default:
        throw new EzTestError(`"${step.action}" is not a block step`, 'BAD_BLOCK');
    }
  } catch (e) {
    error = (e as Error).message.split('\n')[0];
  }
  if (iterations) captured.iterations = iterations;

  // Post-conditions of the block itself are checked after its children.
  let conditions: StepResult['conditions'] = [];
  if (!error && step.postconditions.length) {
    if (env.evaluateConditions) conditions = await env.evaluateConditions(step.postconditions, env.ctx(step, condScope), 5000);
    else {
      const { evaluateConditions } = await import('./conditions.js');
      conditions = await evaluateConditions(step.postconditions, envFor(env.ctx(step, condScope), env.opts), 5000);
    }
    const bad = conditions.filter((c) => !c.passed);
    if (bad.length) error = `post-condition failed: ${bad.map((c) => `${c.condition.type}: ${c.message ?? 'failed'}`).join('; ')}`;
  }
  const childSoftFail = children.some((c) => c.status === 'failed' && c.soft);
  const healed = children.some((c) => c.status === 'passed-healed');
  const status: StepResult['status'] = error ? 'failed' : childSoftFail ? 'failed' : healed ? 'passed-healed' : 'passed';
  const sr: StepResult = {
    stepId: step.id, intent: step.intent, status, startedAt, durationMs: Date.now() - t0, conditions, evidence: nativeEvidence, children,
    ...(env.actors?.labelled ? { actor: step.action === 'actor' && typeof captured.actor === 'string' ? captured.actor : scope.actor ?? env.actors.primary } : {}),
    ...(Object.keys(captured).length ? { captured } : {}),
    ...(error ? { error: { message: error } } : childSoftFail ? { error: { message: 'soft assertion(s) failed inside the block' } } : {}),
  };
  // A block whose only failures are soft keeps the journey going.
  if (!error && childSoftFail) sr.soft = true;
  env.events?.emit({ type: 'step:end', journeyId: scope.journey.id, stepId: step.id, status: sr.status, durationMs: sr.durationMs });
  if (step.optional && sr.status === 'failed') {
    sr.status = 'skipped';
    sr.error = { message: `optional step failed: ${sr.error?.message ?? 'unknown'}` };
  }

  return sr;
}
