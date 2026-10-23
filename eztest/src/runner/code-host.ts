/**
 * Running code journeys and `Run code` steps: the runner side of the SDK.
 *
 * The host turns SDK calls into runner steps that go through the flow engine
 * (`executeStep`), so a `ui.click` is located, healed, verified, screenshotted,
 * traced, paused by the debugger and recorded exactly like an `.ez` step.
 * `step()` groups become block results with children; Node-side work (files,
 * value assertions) becomes recorded steps with evidence.
 */
import {
  EzTestError, Step, nowIso, slugify,
  type Condition, type Journey, type StepInput, type StepResult, type StepSource,
} from '../core/index.js';
import { callSite, errorSite } from '../sdk/callsite.js';
import { literal } from '../sdk/internal.js';
import { sdk } from '../sdk/journey.js';
import { StepFailure, currentFrame, withHost, withNode, type ExecOptions, type LocalRecorder, type RecordOptions, type SdkHost } from '../sdk/runtime.js';
import type { SdkContext } from '../sdk/types.js';
import { resolveCodeTarget, type CodeTarget } from './code-journeys.js';
import { evaluateConditions } from './conditions.js';
import { safeName } from './evidence.js';
import { executeStep, type FlowEnv, type FlowScope } from './flow.js';
import { envFor, skippedStep } from './step.js';
import { basename, dirname, resolve } from 'node:path';

/** A step group (the journey root, a `step()` or a `Run code` step) collecting child results. */
interface GroupNode {
  children: StepResult[];
  /** Step ids used in this group (repeated calls from one line get -2, -3 ...). */
  ids: Map<string, number>;
  /** Failures recorded and thrown from here; a caught one is "handled". */
  thrown: Set<StepResult>;
}

const newNode = (): GroupNode => ({ children: [], ids: new Map(), thrown: new Set() });

/** Errors whose failure is already recorded as a step result. */
const recorded = new WeakSet<object>();

class CancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'CancelledError';
  }
}

export interface CodeRunInput {
  scope: FlowScope;
  flow: FlowEnv;
  /** The file of the code (step ids use its line numbers). */
  file: string;
}

class Host implements SdkHost {
  readonly journey: Journey;
  readonly baseDir: string;
  readonly runDir: string;
  private seq = 0;

  constructor(private readonly scope: FlowScope, private readonly flow: FlowEnv, private readonly file: string, readonly root: GroupNode) {
    this.journey = scope.journey;
    this.baseDir = flow.opts.baseDir ?? process.cwd();
    this.runDir = this.ctx().runDir;
  }

  get signal(): AbortSignal | undefined {
    return this.flow.opts.signal;
  }

  private node(): GroupNode {
    const f = currentFrame();
    return (f?.host === this && (f.node as GroupNode | undefined)) || this.root;
  }

  private ctx(step?: Step) {
    return this.flow.ctx(step ?? Step.parse({ id: 'code', intent: 'code', action: 'code' }), this.actorScope());
  }

  /** The actor of the current SDK call (`actors.manager.ui...`, `as('manager', ...)`), if any. */
  private currentActor(): string | undefined {
    const f = currentFrame();
    return f?.host === this ? f.actor : undefined;
  }

  /** The journey scope, as the current actor when there is one (multi-actor journeys, docs/multi-actor.md). */
  private actorScope(): FlowScope {
    const a = this.currentActor();
    return a && this.flow.actors?.get(a) ? { ...this.scope, actor: a } : this.scope;
  }

  /** Make sure the current actor has its context (and has signed in when it declares a role). */
  private async enterActor(): Promise<FlowScope> {
    const a = this.currentActor();
    if (!a) return this.scope;
    if (!this.flow.actors) throw new EzTestError(`actors.${a}: several actors need a web code journey`, 'NO_ACTORS');
    const { slot } = await this.flow.actors.enter(a);
    if (slot.platform !== 'web') throw new EzTestError(`actors.${a} runs on ${slot.platform}: native actors are supported in .ez / YAML "As ${a}:" blocks`, 'BAD_ACTOR');
    const scope: FlowScope = { ...this.scope, actor: a };
    if (slot.spec.role && !slot.signedIn) {
      slot.signedIn = true;
      const login = Step.parse({ id: this.idFor(undefined, `login-${a}`), intent: `Log in as ${slot.spec.role}`, action: 'login', value: literal(slot.spec.role) });
      this.settle(login, await executeStep(login, scope, this.flow), false);
    }
    return scope;
  }

  private idFor(source: StepSource | undefined, intent: string): string {
    const n = this.node();
    let base: string;
    if (source) base = source.file === this.file ? `L${source.line}` : `${slugify(basename(source.file).replace(/\.[^.]+$/, ''))}-L${source.line}`;
    else base = slugify(intent).slice(0, 40);
    const k = (n.ids.get(base) ?? 0) + 1;
    n.ids.set(base, k);
    return k > 1 ? `${base}-${k}` : base;
  }

  private checkCancelled(step: Step): void {
    if (this.flow.opts.signal?.aborted) {
      this.node().children.push(skippedStep(step, 'not run: run cancelled'));
      const e = new CancelledError();
      recorded.add(e);
      throw e;
    }
  }

  /** Push a result; on failure throw (hard) or keep going (soft / optional). */
  private settle(step: Step, sr: StepResult, soft: boolean): StepResult {
    const n = this.node();
    if (soft && sr.status === 'failed') sr.soft = true;
    n.children.push(sr);
    if (sr.status === 'failed' && !soft && !step.optional) {
      n.thrown.add(sr);
      const e = new StepFailure(`${sr.intent}: ${sr.error?.message ?? 'failed'}`, sr);
      recorded.add(e);
      throw e;
    }
    return sr;
  }

  async exec(input: Omit<StepInput, 'id'> & { id?: string }, o: ExecOptions = {}): Promise<StepResult> {
    const source = o.source ?? callSite();
    const step = Step.parse({
      ...input,
      id: input.id ?? this.idFor(source, input.intent),
      ...(source ? { source } : {}),
      ...(o.optional ? { optional: true } : {}),
      ...(o.soft ? { soft: true } : {}),
    });
    this.checkCancelled(step);
    const sr = await executeStep(step, await this.enterActor(), this.flow);
    return this.settle(step, sr, !!o.soft);
  }

  async record<T>(intent: string, fn: (rec: LocalRecorder) => Promise<T>, o: RecordOptions = {}): Promise<T> {
    const source = o.source ?? callSite();
    const step = Step.parse({
      id: this.idFor(source, intent), intent, action: o.kind === 'assert' ? 'assert' : 'custom', handler: 'code', ...(source ? { source } : {}),
      ...(o.soft ? { soft: true } : {}),
    });
    this.checkCancelled(step);
    let value: T | undefined;
    const run = async (s: Step): Promise<StepResult> => {
      const t0 = Date.now();
      const startedAt = nowIso();
      this.flow.events?.emit({ type: 'step:start', journeyId: this.journey.id, stepId: s.id, intent: s.intent });
      const captured: Record<string, unknown> = {};
      const evidence: string[] = [];
      const warnings: string[] = [];
      let failure: string | undefined;
      const rec: LocalRecorder = {
        capture: (k, v) => { captured[k] = v; },
        evidence: (id) => { evidence.push(id); },
        fail: (m) => { failure ??= m; },
        warn: (m) => { warnings.push(m); },
      };
      try {
        value = await fn(rec);
      } catch (e) {
        failure ??= (e as Error).message.split('\n')[0];
      }
      const sr: StepResult = {
        stepId: s.id, intent: s.intent, status: failure ? 'failed' : 'passed', startedAt, durationMs: Date.now() - t0, conditions: [], evidence,
        ...(Object.keys(captured).length ? { captured: maskCaptured(captured, this.flow) } : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(failure ? { error: { message: failure } } : {}),
      };
      this.flow.events?.emit({ type: 'step:end', journeyId: this.journey.id, stepId: s.id, status: sr.status, durationMs: sr.durationMs });
      return sr;
    };
    this.flow.onStep?.(step.id);
    const sr = this.flow.wrap ? await this.flow.wrap(step, run) : await run(step);
    this.settle(step, sr, !!o.soft);
    return value as T;
  }

  async group<T>(name: string, fn: () => Promise<T>, source?: StepSource): Promise<T> {
    const step = Step.parse({ id: this.idFor(source, name), intent: name, action: 'group', value: name, steps: [], ...(source ? { source } : {}) });
    this.checkCancelled(step);
    const parent = this.node();
    const hooks = this.flow.group?.(step);
    if (hooks && (await hooks.before()) === 'skip') {
      parent.children.push(skippedStep(step, 'skipped in the debugger'));
      return undefined as T;
    }
    this.flow.onStep?.(step.id);
    const { result, value, error } = await this.runGroup(step, fn, true);
    hooks?.after(result);
    parent.children.push(result);
    if (error) {
      if (recorded.has(error as object)) parent.thrown.add(result);
      throw error;
    }
    return value as T;
  }

  /**
   * Run `fn` as a group: children are collected, a thrown error becomes the group's failure
   * (with a "code error" child when the error is not an already-recorded step failure).
   */
  async runGroup<T>(step: Step, fn: () => Promise<T>, nested: boolean): Promise<{ result: StepResult; value?: T; error?: unknown }> {
    const node = newNode();
    const t0 = Date.now();
    const startedAt = nowIso();
    this.flow.events?.emit({ type: 'step:start', journeyId: this.journey.id, stepId: step.id, intent: step.intent });
    let value: T | undefined;
    let error: unknown;
    const run = () => (nested ? withNode(node, fn) : withHost(this, fn, node));
    try {
      value = await run();
    } catch (e) {
      error = e;
      if (!recorded.has(e as object)) {
        node.children.push(await this.codeError(e));
        if (e && typeof e === 'object') recorded.add(e);
      }
    }
    const result = groupResult(step, node, startedAt, Date.now() - t0, error);
    this.flow.events?.emit({ type: 'step:end', journeyId: this.journey.id, stepId: step.id, status: result.status, durationMs: result.durationMs });
    return { result, value, ...(error !== undefined ? { error } : {}) };
  }

  /** A failed step for an error thrown by user code, at the line that threw, with a screenshot. */
  async codeError(e: unknown): Promise<StepResult> {
    if (e instanceof CancelledError) return skippedStep(Step.parse({ id: 'cancelled', intent: 'run cancelled', action: 'code' }), 'not run: run cancelled');
    const err = e instanceof Error ? e : new Error(String(e));
    const site = errorSite(err);
    const where = site ? `${basename(site.file)}:${site.line}` : 'code';
    const id = site ? (site.file === this.file ? `L${site.line}` : `${slugify(basename(site.file).replace(/\.[^.]+$/, ''))}-L${site.line}`) : 'code-error';
    const evidence: string[] = [];
    const shot = await this.screenshot(`error-${id}`, `page when the code failed at ${where}`).catch(() => undefined);
    if (shot) evidence.push(shot);
    const mask = this.flow.opts.mask ?? ((s: string) => s);
    return {
      stepId: id, intent: `Code error at ${where}`, status: 'failed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence,
      error: { message: mask(err.message.split('\n')[0]), name: err.name, ...(err.stack ? { stack: mask(err.stack) } : {}) },
    };
  }

  async runJourney(ref: string, params: Record<string, unknown>, source?: StepSource): Promise<Record<string, unknown>> {
    const key = `__run${++this.seq}`;
    const sr = await this.exec(
      { intent: `Run journey "${ref}"${Object.keys(params).length ? ` with ${Object.keys(params).join(', ')}` : ''}`, action: 'runJourney', value: literal(ref), args: escapeArgs(params), captureAs: key },
      source ? { source } : {},
    );
    const out = (sr.captured?.[key] as Record<string, unknown> | undefined) ?? {};
    this.deleteVar(key);
    return out;
  }

  async probe(condition: unknown, timeoutMs: number): Promise<boolean> {
    const ctx = this.ctx();
    // Platform drivers (native apps) evaluate conditions on the device.
    const r = await (this.flow.evaluateConditions
      ? this.flow.evaluateConditions([condition as Condition], ctx, timeoutMs)
      : evaluateConditions([condition as Condition], envFor(ctx, this.flow.opts), timeoutMs)).catch(() => [{ passed: false }]);
    return r.every((x) => x.passed);
  }

  vars(): Record<string, unknown> {
    return this.ctx().vars();
  }

  getVar(key: string): unknown {
    const v = this.scope.ledger.get(key);
    if (v !== undefined) return v;
    let cur: unknown = this.vars();
    for (const p of key.split('.')) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
      else return undefined;
    }
    return cur;
  }

  setVar(key: string, value: unknown): void {
    this.scope.ledger.set(key, value);
  }

  deleteVar(key: string): void {
    this.scope.ledger.delete(key);
  }

  row(): Record<string, string> {
    return { ...this.journey.variables, ...((this.scope.params as Record<string, string> | undefined) ?? {}) };
  }

  async evidence(kind: 'data' | 'log' | 'screenshot' | 'document', name: string, content: string | Uint8Array, description: string): Promise<string> {
    const ctx = this.ctx();
    const ref = await ctx.evidence.store(kind, `${this.scope.prefix}/code/${safeName(name)}`, content, { journeyId: this.journey.id, description });
    return ref.id;
  }

  async screenshot(name: string, description: string): Promise<string | undefined> {
    const ctx = this.ctx();
    // On a native platform the device takes the screenshot (ctx.page is not a browser page there).
    const device = ctx.platform?.session as { screenshot?: () => Promise<Buffer> } | undefined;
    if (device?.screenshot) return this.evidence('screenshot', `${name}.png`, await device.screenshot(), description);
    if (ctx.page.isClosed()) return undefined;
    const png = await ctx.page.screenshot({ fullPage: true, timeout: 5000 });
    return this.evidence('screenshot', `${name}.png`, png, description);
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    const mask = this.flow.opts.mask ?? ((s: string) => s);
    this.flow.logger[level](mask(message), { journeyId: this.journey.id, ...(data ?? {}) });
    if (level === 'warn' || level === 'error') {
      const n = this.node();
      const last = n.children[n.children.length - 1];
      if (last) last.warnings = [...(last.warnings ?? []), `${level}: ${mask(message)}`];
    }
  }

  async lease(entity: string, where: Record<string, string>, as: string, strategy?: string): Promise<Record<string, unknown>> {
    const handler = this.flow.opts.data;
    if (!handler) throw new EzTestError('data.lease needs the Test Data Fabric (data.entities in config, RunOptions.data)', 'NO_HANDLER');
    const rec = await handler({ entity, as, where, strategy: (strategy ?? 'find-or-create') as 'find' }, this.ctx());
    this.scope.ledger.set(as, rec);
    return rec;
  }

  page(): unknown {
    return this.ctx().page;
  }

  instances(): Map<unknown, unknown> {
    // One map per journey attempt (its ledger), shared by every code step of that attempt.
    let m = attemptInstances.get(this.scope.ledger);
    if (!m) attemptInstances.set(this.scope.ledger, (m = new Map()));
    return m;
  }
}

const attemptInstances = new WeakMap<object, Map<unknown, unknown>>();

function escapeArgs(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? literal(v) : v]));
}

function maskCaptured(c: Record<string, unknown>, flow: FlowEnv): Record<string, unknown> {
  const mask = flow.opts.mask;
  if (!mask) return c;
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return mask(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };
  return deep(c) as Record<string, unknown>;
}

/** Status of a group from its children: hard failures that were caught by the code are "handled". */
function groupResult(step: Step, node: GroupNode, startedAt: string, durationMs: number, error: unknown): StepResult {
  const handled = (r: StepResult) => r.status === 'failed' && !r.soft && !error && node.thrown.has(r);
  for (const c of node.children) if (handled(c)) c.warnings = [...(c.warnings ?? []), 'failure caught and handled by the code'];
  const softFailed = node.children.some((c) => c.status === 'failed' && c.soft);
  const healed = node.children.some((c) => c.status === 'passed-healed');
  const msg = error ? (error instanceof Error ? error.message.split('\n')[0] : String(error)) : undefined;
  const status: StepResult['status'] = error ? (error instanceof CancelledError ? 'skipped' : 'failed') : softFailed ? 'failed' : healed ? 'passed-healed' : 'passed';
  return {
    stepId: step.id, intent: step.intent, status, startedAt, durationMs, conditions: [], evidence: [], children: node.children,
    ...(msg ? { error: { message: msg } } : softFailed ? { error: { message: 'soft assertion(s) failed inside the step' } } : {}),
    ...(!error && softFailed ? { soft: true } : {}),
  };
}

/** Directories a `Run code "file#name"` reference is resolved against. */
function codeDirs(scope: FlowScope, flow: FlowEnv): string[] {
  const base = flow.opts.baseDir ?? process.cwd();
  const dirs = [base, resolve(base, 'journeys')];
  if (scope.journey.code) dirs.unshift(dirname(scope.journey.code.file));
  return [...new Set(dirs)];
}

/**
 * Run a code journey's body for one attempt. Returns the top-level step
 * results and the journey status.
 */
export async function runCodeJourney(journey: Journey, scope: FlowScope, flow: FlowEnv): Promise<{ steps: StepResult[]; status: 'passed' | 'passed-healed' | 'failed' | 'skipped'; error?: { message: string; name?: string } }> {
  if (!journey.code) throw new EzTestError(`Journey "${journey.id}" is not a code journey`, 'NOT_CODE');
  const target = await resolveCodeTarget(`${journey.code.file}#journey:${journey.code.name}`, [], { cwd: flow.opts.baseDir ?? process.cwd() });
  const root = newNode();
  const host = new Host(scope, flow, journey.code.file, root);
  let error: unknown;
  try {
    await withHost(host, async () => {
      await (target.fn as (c: SdkContext) => unknown)(sdk);
    }, root);
  } catch (e) {
    error = e;
    if (!recorded.has(e as object)) root.children.push(await host.codeError(e));
  }
  const r = groupResult(Step.parse({ id: 'journey', intent: journey.name, action: 'group', steps: [] }), root, nowIso(), 0, error);
  const steps = r.children ?? [];
  if (!steps.length) {
    steps.push({ stepId: 'code', intent: `Run code journey "${journey.name}"`, status: error ? 'failed' : 'passed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], ...(r.error ? { error: r.error } : {}) });
  }
  const status = r.status === 'blocked' ? 'failed' : r.status;
  return { steps, status, ...(r.error && r.status === 'failed' ? { error: { message: r.error.message, name: error instanceof Error ? error.name : 'Error' } } : {}) };
}

/** `Run code "file#name" with k=v as result` (and a code journey called with "Run journey"). */
export async function runCodeStep(step: Step, scope: FlowScope, flow: FlowEnv): Promise<StepResult> {
  const ctx = flow.ctx(step, scope);
  const ref = ctx.interpolate(step.value ?? '');
  const params = Object.fromEntries(Object.entries(step.args ?? {}).map(([k, v]) => [k, typeof v === 'string' ? ctx.interpolate(v) : v]));
  let target: CodeTarget;
  try {
    target = await resolveCodeTarget(ref, codeDirs(scope, flow), { cwd: flow.opts.baseDir ?? process.cwd() });
  } catch (e) {
    return { stepId: step.id, intent: step.intent, status: 'failed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], error: { message: (e as Error).message } };
  }
  const subScope: FlowScope = { ...scope, prefix: `${scope.prefix}/${safeName(step.id)}`, params: { ...(scope.params ?? {}), ...params } };
  const host = new Host(subScope, flow, target.file, newNode());
  const { result, value } = await host.runGroup(step, async () => {
    const out = target.kind === 'journey' ? await (target.fn as (c: SdkContext) => unknown)(sdk) : await (target.fn as (c: SdkContext, p: unknown) => unknown)(sdk, params);
    return out;
  }, false);
  if (result.status !== 'failed' || result.soft) {
    const v = value;
    if (step.captureAs) {
      scope.ledger.set(step.captureAs, v ?? null);
      result.captured = { ...(result.captured ?? {}), [step.captureAs]: v ?? null };
    } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) {
      for (const [k, x] of Object.entries(v)) scope.ledger.set(k, x);
      result.captured = { ...(result.captured ?? {}), ...(v as Record<string, unknown>) };
    }
  }
  return result;
}
