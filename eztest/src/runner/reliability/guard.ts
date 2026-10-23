/**
 * The reliability guard wraps every action the runner performs:
 *
 *   1. optional app-idle wait (pending fetch/XHR, framework quiescence),
 *   2. actionability wait (visible, enabled, stable, not animating, not covered),
 *   3. the action itself, re-resolving the target once when the SPA re-rendered
 *      it away mid-action ("element is not attached to the DOM"),
 *   4. for fill/select: a check that the value survived a re-render, re-typing
 *      into the re-resolved element when it did not.
 *
 * Everything the guard waited for or recovered from is recorded per step
 * (`StepResult.reliability`), so a flaky pass carries its root cause as
 * evidence instead of being an unexplained retry.
 */
import type { Locator } from '../../browser/index.js';
import { sleep, type Step, type StepReliability, type FlakeCause } from '../../core/index.js';
import type { ActionOutcome } from '../actions.js';
import type { RunOptions, StepContext } from '../types.js';
import { INPUT_ACTIONS, POINTER_ACTIONS, actionabilityMessage, waitActionable, type BlockCause } from './actionability.js';
import { waitForAppIdle, type AppIdleOptions } from './idle.js';
import { EzTestError } from '../../core/index.js';

export interface ReliabilityOptions {
  /** Wait for visible/enabled/stable/not-animating/not-covered before acting; name overlays in errors. Default true. */
  actionability?: boolean;
  /** Wait for the app to be idle (pending fetch/XHR, Angular/jQuery quiescence) before acting. Default off. */
  appIdle?: boolean | AppIdleOptions;
  /** After fill/select, check the value survived a re-render and redo it once if not. Default true. */
  verifyFill?: boolean;
  /** Re-resolve the target and retry once when it was detached mid-action. Default true. */
  reresolve?: boolean;
  /** Pause before every action (debugging only; never use it to fix timing). Default 0. */
  slowMo?: number;
}

/** Actions that never touch the page. */
const NO_PAGE = new Set(['api', 'db', 'set', 'compareData', 'email', 'sms', 'log', 'runJourney', 'group', 'if', 'while', 'forEach', 'repeat', 'try', 'retry', 'assert', 'useData', 'custom', 'compareDocument', 'login']);

const LOGS = new WeakMap<object, StepReliability>();

function log(ctx: StepContext): StepReliability {
  let l = LOGS.get(ctx);
  if (!l) LOGS.set(ctx, (l = { waits: [], recovered: [] }));
  return l;
}

/** Record that a step waited for something (only meaningful waits are worth recording). */
export function noteWait(ctx: StepContext, cause: FlakeCause, ms: number, detail?: string): void {
  log(ctx).waits.push({ cause, ms, ...(detail ? { detail } : {}) });
}

/** Record that a step recovered from a problem (re-resolved, re-typed, re-logged in...). */
export function noteRecovered(ctx: StepContext, cause: FlakeCause, detail: string): void {
  log(ctx).recovered.push({ cause, detail });
}

/** Take (and clear) the reliability record of a step context. */
export function takeReliability(ctx: StepContext): StepReliability | undefined {
  const l = LOGS.get(ctx);
  LOGS.delete(ctx);
  return l && (l.waits.length || l.recovered.length) ? l : undefined;
}

export function causeOfBlock(b: BlockCause): FlakeCause {
  return b === 'overlay' ? 'overlay' : b === 'detached' ? 'detached' : 'timing';
}

const DETACHED = /not attached to the DOM|element is not attached|detached from the DOM|was detached|Element is not attached|stale element|Node is detached|Execution context was destroyed|frame was detached/i;

export function isDetachedError(e: unknown): boolean {
  return e instanceof Error && DETACHED.test(e.message);
}

function idleOptions(o: ReliabilityOptions | undefined): AppIdleOptions | undefined {
  if (!o?.appIdle) return undefined;
  return o.appIdle === true ? {} : o.appIdle;
}

/** Does the guard apply to this step at all? */
function touchesPage(step: Step): boolean {
  return !NO_PAGE.has(step.action);
}

export interface GuardEnv {
  /** Resolve the step target again (after a re-render). */
  reresolve?: () => Promise<Locator | undefined>;
}

/**
 * Perform `perform(loc)` with the reliability guard around it.
 * `timeout` is the step's action timeout.
 */
export async function guardedAction(
  step: Step,
  loc: Locator | undefined,
  ctx: StepContext,
  opts: RunOptions,
  timeout: number,
  perform: (loc: Locator | undefined, timeout: number) => Promise<ActionOutcome>,
  env: GuardEnv = {},
): Promise<ActionOutcome> {
  const r = opts.reliability ?? {};
  if (!touchesPage(step)) return perform(loc, timeout);
  const t0 = Date.now();
  if (r.slowMo && r.slowMo > 0) await sleep(r.slowMo);
  const idle = idleOptions(r);
  if (idle && step.action !== 'navigate') {
    const w = await waitForAppIdle(ctx.page, { ...idle, timeoutMs: Math.min(idle.timeoutMs ?? 10_000, timeout) });
    if (w.capped || w.reasons.length) noteWait(ctx, 'network', w.waitedMs, `${w.capped ? 'app still busy after cap' : 'app busy'}: ${w.reasons.join(', ') || 'network activity'}`);
  }
  const description = step.target?.description ?? 'the element';
  const pointer = POINTER_ACTIONS.has(step.action) || (step.action === 'mouse' && step.target !== undefined);
  const guarded = loc && r.actionability !== false && !step.args?.force && (pointer || INPUT_ACTIONS.has(step.action));
  let current = loc;
  if (guarded && current) {
    for (let round = 0; round < 3; round++) {
      const left = Math.max(500, timeout - (Date.now() - t0));
      // The driver's actionability checks for the action (hover does not need an enabled element).
      const a = await waitActionable(current, { timeoutMs: left, hit: pointer, enabled: step.action !== 'hover', description, throwOnTimeout: false });
      for (const c of a.causes) if (c !== 'detached') noteWait(ctx, causeOfBlock(c), a.waitedMs, c === 'overlay' ? `covered by ${a.overlay ?? 'an overlay'}` : c);
      if (a.ok) break;
      const last = a.causes[a.causes.length - 1];
      if (last === 'detached' && r.reresolve !== false && env.reresolve) {
        const again = await env.reresolve();
        if (!again) break; // let the action report the missing element
        noteRecovered(ctx, 'detached', `${description} was re-rendered; re-resolved the target`);
        current = again;
        continue;
      }
      // Clear, named failures for what the driver would only report as a timeout.
      if (last === 'overlay' && a.last?.overlay) throw new EzTestError(actionabilityMessage(description, 'overlay', a.last, a.waitedMs), 'OBSCURED', { obscuredBy: a.last.obscuredBy });
      if (last === 'disabled' || last === 'hidden') throw new EzTestError(actionabilityMessage(description, last, a.last, a.waitedMs), 'NOT_ACTIONABLE');
      break; // animation / instability / non-overlay obscurer: the driver's own checks decide
    }
  }
  const remaining = () => Math.max(1000, timeout - (Date.now() - t0));
  let outcome: ActionOutcome;
  try {
    outcome = await perform(current, remaining());
  } catch (e) {
    if (!(current && r.reresolve !== false && env.reresolve && isDetachedError(e))) throw e;
    const again = await env.reresolve();
    if (!again) throw e;
    noteRecovered(ctx, 'detached', `${description} was detached during ${step.action}; re-resolved and retried once`);
    current = again;
    outcome = await perform(current, remaining());
  }
  if (current && r.verifyFill !== false && (step.action === 'fill' || step.action === 'select') && step.value !== undefined) {
    await verifyValue(step, current, ctx, opts, idle, remaining, perform, env);
  }
  return outcome;
}

async function valueOf(step: Step, loc: Locator): Promise<string[] | undefined> {
  try {
    if (step.action === 'fill') return [await loc.inputValue({ timeout: 1000 })];
    return await loc.evaluate((el) => (el instanceof HTMLSelectElement ? Array.from(el.selectedOptions).flatMap((o) => [o.value, o.label]) : []), undefined, { timeout: 1000 });
  } catch {
    return undefined;
  }
}

/** The typed/selected value must still be there once the app has settled (re-renders reset controlled inputs). */
async function verifyValue(
  step: Step, loc: Locator, ctx: StepContext, opts: RunOptions, idle: AppIdleOptions | undefined, remaining: () => number,
  perform: (loc: Locator | undefined, timeout: number) => Promise<ActionOutcome>, env: GuardEnv,
): Promise<void> {
  const want = ctx.interpolate(step.value ?? '');
  const holds = (v: string[] | undefined) => v !== undefined && v.includes(want);
  for (let round = 0; round < 2; round++) {
    if (idle) await waitForAppIdle(ctx.page, { ...idle, timeoutMs: Math.min(idle.timeoutMs ?? 10_000, remaining()) });
    let target = loc;
    let v = await valueOf(step, target);
    if (holds(v)) return;
    if (v === undefined && env.reresolve) {
      // The element is gone: a re-render replaced it.
      const again = await env.reresolve();
      if (!again) return;
      target = again;
      v = await valueOf(step, target);
      if (holds(v)) return;
    }
    if (step.action === 'fill' && v !== undefined && v[0] !== '' && !v[0].includes(want) && !want.includes(v[0])) return; // the app reformats input (masks): not a re-render
    noteRecovered(ctx, 'detached', `${step.target?.description ?? 'the field'} lost its value after a re-render ("${(v ?? [''])[0]}"); ${step.action === 'fill' ? 'typed' : 'selected'} it again`);
    await perform(target, remaining());
    loc = target;
  }
  void opts;
}
