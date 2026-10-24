/**
 * Executes one step: resolve the target strictly, act, check post-conditions;
 * when the target cannot be resolved, climb the healing ladder and accept a
 * heal only if the step's post-conditions (and action-implied checks) hold.
 */
import type { Locator } from '../browser/index.js';
import {
  nowIso,
  sleep,
  type ConditionResult,
  type ElementFingerprint,
  type HealRecord,
  type LocatorCandidate,
  type Step,
  type StepResult,
} from '../core/index.js';
import { ANCHOR_ACTION, captureFingerprint } from '../heal/fingerprint.js';
import type { FingerprintStore } from '../heal/store.js';
import { needsTarget, performAction, implicitCheck, type ActionOutcome } from './actions.js';
import { evaluateConditions, type ConditionEnv } from './conditions.js';
import { stepHooksFor } from './hooks.js';
import { describeCandidate, interpolateCandidate, isScoped, resolveTarget, rootFor, scopedLocator, toLocator } from './locate.js';
import { ELEMENTS_JOURNEY } from '../heal/store.js';
import { bindStep } from '../elements/bind.js';
import { scopeHints } from './scope-hints.js';
import { safeName } from './evidence.js';
import type { RunOptions, StepContext } from './types.js';
import { settleLoaders } from './waits.js';
import { guardedAction } from './reliability/guard.js';
import { suggestImprovement } from './reliability/improve.js';
import { withComponentCandidates } from './components/heal.js';
import { overlayTarget } from './video-overlay.js';
import { executeManualStep } from './manual.js';

export const SUSPECTED_REGRESSION =
  'suspected regression: a matching element was found but the expected outcome did not happen';

export interface StepRuntime {
  opts: RunOptions;
  store: FingerprintStore;
  stepTimeoutMs: number;
  locateTimeoutMs: number;
  conditionTimeoutMs: number;
}

type Core = Omit<StepResult, 'stepId' | 'intent' | 'startedAt' | 'durationMs' | 'evidence'> & { evidence: string[] };

function conditionFailure(results: ConditionResult[]): string {
  return results.filter((r) => !r.passed).map((r) => `${r.condition.type}: ${r.message ?? 'failed'}`).join('; ');
}

async function safeFingerprint(loc: Locator): Promise<ElementFingerprint | undefined> {
  try {
    return await captureFingerprint(loc);
  } catch {
    return undefined;
  }
}

/** Condition environment of a step: the current page and frame chain, ledger, session and file base. */
export function envFor(ctx: StepContext, opts?: RunOptions): ConditionEnv {
  return {
    page: ctx.page, ledger: ctx.ledger, vars: () => ctx.vars(), interpolate: (s: string) => ctx.interpolate(s),
    session: ctx.session, frames: ctx.session?.frames, baseDir: opts?.baseDir, ...(opts?.apiSpec ? { apiSpec: opts.apiSpec } : {}),
  };
}

/**
 * Run a step's action + post-conditions with an already-resolved locator
 * ("poll": repeat until they hold). Trace/debug step hooks wrap each attempt.
 */
async function actAndVerify(step: Step, loc: Locator | undefined, ctx: StepContext, rt: StepRuntime, timeout: number, healing = false, reresolve?: () => Promise<Locator | undefined>) {
  const hooks = stepHooksFor(ctx.page);
  const attempts = step.poll ? (step.poll.attempts ?? 10) : 1;
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    if (hooks?.beforeAct) await hooks.beforeAct(loc, { healing });
    let outcome: ActionOutcome;
    try {
      await settleLoaders(step, ctx, rt.opts);
      // Reliability guard: app idle, actionability (named overlays), re-render safety (see reliability/guard.ts).
      outcome = await guardedAction(step, loc, ctx, rt.opts, timeout, (l, t) => performAction(step, l, ctx, rt.opts, t), { reresolve });
    } catch (e) {
      hooks?.afterAct?.(e as Error);
      if (last) throw e;
      await sleep(step.poll?.intervalMs ?? 500);
      continue;
    }
    hooks?.afterAct?.();
    if (!step.postconditions.length) return { outcome, conditions: [] };
    if (hooks?.beforeVerify) await hooks.beforeVerify();
    await settleLoaders(step, ctx, rt.opts);
    await screenshotBeforeAssertion(step, ctx, rt.opts);
    const conditions = await evaluateConditions(step.postconditions, envFor(ctx, rt.opts), last ? rt.conditionTimeoutMs : 0);
    hooks?.afterVerify?.(conditions);
    if (last || conditions.every((c) => c.passed)) return { outcome, conditions };
    await sleep(step.poll?.intervalMs ?? 500);
  }
}

/** screenshots: before-assertions — capture the page right before post-conditions are checked. */
async function screenshotBeforeAssertion(step: Step, ctx: StepContext, opts: RunOptions): Promise<void> {
  if (opts.screenshots !== 'before-assertions' || !step.postconditions.length) return;
  try {
    const png = await ctx.page.screenshot({ fullPage: true, timeout: 5000 });
    await ctx.evidence.store('screenshot', `journeys/${safeName(ctx.journey.id)}/attempt-${ctx.attempt}/${safeName(step.id)}.before-assert.png`, png, {
      journeyId: ctx.journey.id, stepId: step.id, description: 'screenshot before assertion',
    });
  } catch (e) {
    ctx.logger.warn('could not capture the pre-assertion screenshot', { stepId: step.id, message: (e as Error).message });
  }
}

/** Execute one step (without screenshots/lenses, which the journey loop adds). */
export async function executeStepCore(rawStep: Step, ctx: StepContext, rt: StepRuntime): Promise<Core> {
  // Repository elements (@Screen.key, SDK screens, matching descriptions) take the repository's locators.
  const step = rt.opts.elements?.size ? bindStep(rawStep, rt.opts.elements) : rawStep;
  // "Manual:" steps: a tester's verdict while the page stays open (hybrid journeys, runner/manual.ts).
  if (step.action === 'manual') return executeManualStep(step, ctx, rt.opts, rt.conditionTimeoutMs);
  // Desktop, terminal, SAP GUI and screen-image surfaces take their steps first (runner/surface.ts).
  for (const i of rt.opts.stepInterceptors ?? []) {
    const r = await i.execute(step, ctx, rt);
    if (r) return r;
  }
  const timeout = step.timeoutMs ?? rt.stepTimeoutMs;
  if (step.action === 'assert' && step.postconditions.length === 0) {
    return { status: 'failed', conditions: [], evidence: [], error: { message: 'assert step has no post-conditions; nothing would be checked' } };
  }
  if (!needsTarget(step)) {
    const { outcome, conditions } = await actAndVerify(step, undefined, ctx, rt, timeout);
    const passed = conditions.every((c) => c.passed);
    return {
      status: passed ? 'passed' : 'failed',
      conditions,
      evidence: outcome.evidence ?? [],
      captured: outcome.captured,
      ...(passed ? {} : { error: { message: `post-condition failed: ${conditionFailure(conditions)}` } }),
    };
  }
  if (!step.target) {
    return { status: 'failed', conditions: [], evidence: [], error: { message: `${step.action} step has no target` } };
  }

  const target = step.target;
  const root = rootFor(ctx.page, [...(ctx.session?.frames ?? []), ...(target.frames ?? [])]);
  const res = await resolveTarget(root, target, ctx.vars(), Math.min(timeout, rt.locateTimeoutMs));
  const hooks = stepHooksFor(ctx.page);
  hooks?.located?.(res);
  // A shared repository element (unscoped) keeps one memory for every journey that uses it.
  const [memJourney, memStep] = memoryKey(ctx.journey.id, step.id, target);
  if (res.locator && res.candidate) {
    const fp = rt.opts.fingerprints === 'missing' && rt.store.get(memJourney, memStep)?.fingerprint ? undefined : await safeFingerprint(res.locator);
    // A more robust locator for a weak target, checked against the live element before acting:
    // proposed for review when the step passes, never applied.
    const improvement = rt.opts.suggestLocators !== false && !isScoped(target)
      ? await suggestImprovement(root, res.locator, target, fp ?? rt.store.get(memJourney, memStep)?.fingerprint, ctx.vars()).catch(() => undefined)
      : undefined;
    const reresolve = async () => (await resolveTarget(root, target, ctx.vars(), Math.min(timeout, rt.locateTimeoutMs))).locator;
    await overlayTarget(ctx.page, step, res.locator); // highlight the target in the recorded video
    const { outcome, conditions } = await actAndVerify(step, res.locator, ctx, rt, timeout, false, reresolve);
    const passed = conditions.every((c) => c.passed);
    if (passed) {
      rt.store.recordSuccess(memJourney, memStep, fp, rawCandidate(target.locators, res.candidate, ctx));
      // Anchors and containers of a scoped target keep their own memory, so a renamed anchor can heal too.
      for (const [i, a] of (res.scope?.anchors ?? []).entries()) {
        if (!a.locator || !a.candidate || !a.scope.anchor) continue;
        rt.store.recordSuccess(ctx.journey.id, anchorStepId(step.id, i), await safeFingerprint(a.locator), rawCandidate(a.scope.anchor.locators, a.candidate, ctx));
      }
    }
    return {
      status: passed ? 'passed' : 'failed',
      conditions,
      evidence: outcome.evidence ?? [],
      usedLocator: res.candidate,
      captured: outcome.captured,
      ...(improvement && passed ? { improvement } : {}),
      ...(passed ? {} : { error: { message: `post-condition failed: ${conditionFailure(conditions)}` } }),
    };
  }

  // ---------------------------------------------------------------- healing
  // A container or anchor that matches several elements is a strictness failure, never healed:
  // picking one of them would be a guess.
  if (res.scope && !res.scope.ok) {
    const msg = `${target.description}: ${res.scope.notes.join('; ')}`;
    if (res.scope.ambiguous || !rt.opts.healer) return { status: 'failed', conditions: [], evidence: [], error: { message: msg } };
    // An anchor or container that is gone (not ambiguous) climbs the healing ladder itself; the step's outcome verifies it.
    const healed = await healAnchor(step, target, res.scope, root, ctx, rt, timeout);
    if (healed.result) return healed.result;
    return { status: 'failed', conditions: [], evidence: [], error: { message: `${msg}; healing found no candidate for the anchor${healed.notes.length ? ` (${healed.notes.join('; ')})` : ''}` } };
  }
  // Several matches: say how to name one ("in the row containing ...", "the 2nd ...").
  const many = res.ambiguous ? res.tried?.find((t) => t.count > 1) : undefined;
  const hints = many ? await scopeHints(res.scope ? scopedLocator(res.scope, many.candidate) : toLocator(root, many.candidate), target.description, many.count).catch(() => []) : [];
  const failure = `no locator candidate matched exactly one element for ${target.description} (${res.notes.join('; ')})${hints.length ? `; name one, e.g. ${hints.join(', or ')}` : ''}`;
  const healer = rt.opts.healer;
  if (!healer) return { status: 'failed', conditions: [], evidence: [], error: { message: failure } };
  if (hooks?.beforeHeal) await hooks.beforeHeal(failure);
  const notes: string[] = [];
  // Scoped targets heal inside their resolved container; layout filters and the ordinal still apply.
  const healRoot = res.scope?.root ?? root;
  const locate = (c: LocatorCandidate) => (res.scope ? scopedLocator(res.scope, c) : toLocator(root, c));
  const healCtx = {
    page: ctx.page, root: healRoot, journey: ctx.journey, step, target, failure, store: rt.store, memory: { journeyId: memJourney, stepId: memStep },
    note: (m: string) => {
      notes.push(m);
      hooks?.healNote?.(m);
    },
  };
  // Component steps add a widget-aware tier (src/runner/components/heal.ts) after the healer's own ladder.
  for await (const cand of step.action === 'component' ? withComponentCandidates(healer, healCtx) : healer.candidates(healCtx)) {
    const c = interpolateCandidate(cand.locator, ctx.vars());
    const loc = locate(c);
    const n = await loc.count().catch(() => 0);
    hooks?.healCandidate?.({ ...cand, resolved: c, matches: n });
    if (n !== 1) {
      notes.push(`${cand.tier}: ${describeCandidate(c)} matched ${n} elements (skipped)`);
      continue;
    }
    const fp = await safeFingerprint(loc);
    const heal: HealRecord = {
      stepId: step.id, tier: cand.tier, original: target.locators, healed: cand.locator,
      confidence: cand.confidence, verified: false, reason: cand.reason, evidence: [],
      ...(target.element ? { element: target.element } : {}),
    };
    ctx.logger.info('heal attempt', { journeyId: ctx.journey.id, stepId: step.id, tier: cand.tier, locator: describeCandidate(c) });
    let outcome: ActionOutcome = {};
    let conditions: ConditionResult[] = [];
    try {
      ({ outcome, conditions } = await actAndVerify(step, loc, ctx, rt, timeout, true, async () => ((await loc.count().catch(() => 0)) === 1 ? loc : undefined)));
    } catch (e) {
      rt.opts.events?.emit({ type: 'heal', journeyId: ctx.journey.id, stepId: step.id, tier: cand.tier, verified: false });
      return {
        status: 'failed', conditions, evidence: [], heal, usedLocator: c,
        error: { message: `${SUSPECTED_REGRESSION} (healed ${cand.tier} candidate ${describeCandidate(c)}; action failed: ${(e as Error).message.split('\n')[0]})` },
      };
    }
    const implied = await implicitCheck(step, loc, ctx, outcome);
    const condOk = conditions.every((r) => r.passed);
    const hasVerification = conditions.length > 0 || implied !== undefined;
    const verified = hasVerification && condOk && (implied?.ok ?? true);
    heal.verified = verified;
    heal.reason = `${cand.reason}${implied ? `; ${implied.message}` : ''}`;
    rt.opts.events?.emit({ type: 'heal', journeyId: ctx.journey.id, stepId: step.id, tier: cand.tier, verified });
    if (verified) {
      rt.store.recordSuccess(memJourney, memStep, fp, cand.locator);
      rt.store.recordHeal(memJourney, memStep, {
        locator: cand.locator, original: target.locators, tier: cand.tier, confidence: cand.confidence, verifiedAt: nowIso(), runId: ctx.runId,
      });
      return { status: 'passed-healed', conditions, evidence: outcome.evidence ?? [], heal, usedLocator: c, captured: outcome.captured };
    }
    if (!hasVerification && healer.policy.requireVerification === false) return unverifiedHeal(heal, conditions, outcome, c);
    const why = !hasVerification
      ? 'heal could not be verified: the step has no post-conditions (add an Expect line)'
      : `${SUSPECTED_REGRESSION} (${[conditionFailure(conditions), implied && !implied.ok ? implied.message : ''].filter(Boolean).join('; ')})`;
    return { status: 'failed', conditions, evidence: outcome.evidence ?? [], heal, usedLocator: c, captured: outcome.captured, error: { message: why } };
  }
  return {
    status: 'failed', conditions: [], evidence: [],
    error: { message: `${failure}; healing found no candidate${notes.length ? ` (${notes.join('; ')})` : ''}` },
  };
}

/** Fingerprint-store step id of the i-th scope anchor of a step (`<step>~scope<i>`). */
export function anchorStepId(stepId: string, i: number): string {
  return `${stepId}~scope${i}`;
}

/**
 * Heal the anchor (or container) of a scoped target that matched nothing: the
 * healer's ladder runs for the anchor (its own memory, `<step>~scope<i>`), each
 * candidate must match exactly one element, the whole target must then resolve
 * strictly, and the heal counts only when the step's post-conditions hold.
 */
async function healAnchor(step: Step, target: NonNullable<Step['target']>, scope: NonNullable<Awaited<ReturnType<typeof resolveTarget>>['scope']>, root: ReturnType<typeof rootFor>, ctx: StepContext, rt: StepRuntime, timeout: number): Promise<{ result?: Core; notes: string[] }> {
  const healer = rt.opts.healer;
  const i = scope.anchors.length - 1;
  const sc = scope.anchors[i]?.scope;
  if (!healer || !sc?.anchor || i < 0) return { notes: sc?.relation === 'row' ? ['a row is found by its text; it is not healed'] : [] };
  const anchor = sc.anchor;
  const aStep = anchorStepId(step.id, i);
  const failure = `anchor ${anchor.description} of ${target.description} matched nothing`;
  const notes: string[] = [];
  const healCtx = {
    page: ctx.page, root: scope.root, journey: ctx.journey, step: { ...step, id: aStep, target: anchor, action: ANCHOR_ACTION as Step['action'] }, target: anchor, failure, store: rt.store,
    memory: { journeyId: ctx.journey.id, stepId: aStep }, note: (m: string) => notes.push(m),
  };
  for await (const cand of healer.candidates(healCtx)) {
    const c = interpolateCandidate(cand.locator, ctx.vars());
    const n = await toLocator(scope.root, c).count().catch(() => 0);
    if (n !== 1) {
      notes.push(`${cand.tier}: ${describeCandidate(c)} matched ${n} elements (skipped)`);
      continue;
    }
    const scopes = [...(target.scope ?? [])];
    scopes[i] = { ...sc, anchor: { ...anchor, locators: [cand.locator, ...anchor.locators] } };
    const healedTarget = { ...target, scope: scopes };
    const r = await resolveTarget(root, healedTarget, ctx.vars(), Math.min(timeout, rt.locateTimeoutMs));
    if (!r.locator) {
      notes.push(`${cand.tier}: the anchor ${describeCandidate(c)} resolved, but ${target.description} did not (${r.notes.join('; ')})`);
      continue;
    }
    const heal: HealRecord = {
      stepId: step.id, tier: cand.tier, original: anchor.locators, healed: cand.locator, confidence: cand.confidence, verified: false,
      reason: `anchor ${anchor.description}: ${cand.reason}`, evidence: [], anchor: i,
    };
    let outcome: ActionOutcome = {};
    let conditions: ConditionResult[] = [];
    try {
      ({ outcome, conditions } = await actAndVerify(step, r.locator, ctx, rt, timeout, true));
    } catch (e) {
      return { notes, result: { status: 'failed', conditions, evidence: [], heal, usedLocator: r.candidate, error: { message: `${SUSPECTED_REGRESSION} (healed anchor ${describeCandidate(c)}; action failed: ${(e as Error).message.split('\n')[0]})` } } };
    }
    const implied = await implicitCheck(step, r.locator, ctx, outcome);
    const verified = (conditions.length > 0 || implied !== undefined) && conditions.every((x) => x.passed) && (implied?.ok ?? true);
    heal.verified = verified;
    rt.opts.events?.emit({ type: 'heal', journeyId: ctx.journey.id, stepId: step.id, tier: cand.tier, verified });
    if (!verified && !(conditions.length || implied) && healer.policy.requireVerification === false) return { notes, result: unverifiedHeal(heal, conditions, outcome, r.candidate) };
    if (!verified) {
      const why = conditions.length || implied ? `${SUSPECTED_REGRESSION} (${conditionFailure(conditions)})` : 'heal could not be verified: the step has no post-conditions (add an Expect line)';
      return { notes, result: { status: 'failed', conditions, evidence: outcome.evidence ?? [], heal, usedLocator: r.candidate, error: { message: why } } };
    }
    const aLoc = r.scope?.anchors[i]?.locator;
    rt.store.recordSuccess(ctx.journey.id, aStep, aLoc ? await safeFingerprint(aLoc) : undefined, cand.locator);
    rt.store.recordHeal(ctx.journey.id, aStep, { locator: cand.locator, original: anchor.locators, tier: cand.tier, confidence: cand.confidence, verifiedAt: nowIso(), runId: ctx.runId });
    return { notes, result: { status: 'passed-healed', conditions, evidence: outcome.evidence ?? [], heal, usedLocator: r.candidate, captured: outcome.captured } };
  }
  return { notes };
}

/**
 * healing.requireVerification: false and the step has nothing to verify the heal with: the step passes healed,
 * the heal is marked unverified, and it is not recorded in the fingerprint store (never replayed from the cache).
 */
function unverifiedHeal(heal: HealRecord, conditions: ConditionResult[], outcome: ActionOutcome, used: Core['usedLocator']): Core {
  heal.unverified = true;
  heal.reason = `${heal.reason}; not verified: the step has no post-conditions (healing.requireVerification is false)`;
  return {
    status: 'passed-healed', conditions, evidence: outcome.evidence ?? [], heal, usedLocator: used, captured: outcome.captured,
    warnings: [`unverified heal (${heal.tier}): the step has no post-conditions to verify it; review it before accepting (healing.requireVerification is false)`],
  };
}

/**
 * Fingerprint-store key of a step's target: `@elements/<id>` for an unscoped
 * repository element (one memory, and one T0 heal, for every journey using it),
 * else `<journey>/<step>`.
 */
export function memoryKey(journeyId: string, stepId: string, target: { element?: string; scope?: unknown[]; nth?: number } | undefined): [string, string] {
  return target?.element && !target.scope?.length && target.nth === undefined ? [ELEMENTS_JOURNEY, target.element] : [journeyId, stepId];
}

/** Map the interpolated candidate that resolved back to its raw (template) form for storage. */
function rawCandidate(raws: LocatorCandidate[], used: LocatorCandidate, ctx: StepContext): LocatorCandidate {
  return raws.find((r) => JSON.stringify(interpolateCandidate(r, ctx.vars())) === JSON.stringify(used)) ?? used;
}

/** Skeleton result for a step that did not run. */
export function skippedStep(step: Step, reason: string): StepResult {
  return { stepId: step.id, intent: step.intent, status: 'skipped', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], error: { message: reason } };
}
