/**
 * The contract every rung of the desktop and legacy driver ladder implements,
 * and the shared step pipeline: act, record the fingerprint, verify
 * post-conditions, accept a heal only when they hold, store evidence.
 *
 * Ladder (most to least semantic): Electron (CDP) > Windows UI
 * Automation > Java Access Bridge > SAP GUI Scripting > terminal fields
 * (TN3270) > OCR text > image template > coordinates.
 */
import {
  NotSupportedError,
  type Condition,
  type ConditionResult,
  type ElementFingerprint,
  type HealRecord,
  type HealTier,
  type LocatorCandidate,
  type Step,
  type SurfaceUse,
} from '../core/index.js';
import { evaluateConditions, type ConditionEnv } from '../runner/conditions.js';
import { safeName } from '../runner/evidence.js';
import { envFor } from '../runner/step.js';
import type { InterceptedStep, InterceptorRuntime } from '../runner/surface.js';
import type { StepContext } from '../runner/types.js';

export type SurfaceKind = 'electron' | 'windows' | 'java' | 'sap' | 'tn3270' | 'tn5250' | 'vision';

/** What a surface did for a step. */
export interface ActResult {
  surface: SurfaceUse;
  /** Values for the ledger (and the step result). */
  captured?: Record<string, unknown>;
  /** The locator that resolved, shown in reports and the trace. */
  usedLocator?: LocatorCandidate;
  /** Fingerprint of the element acted on (stored when the step passes). */
  fingerprint?: ElementFingerprint;
  /** The element was found by healing, not by the step's own description. */
  heal?: { tier: HealTier; confidence: number; reason: string; original: LocatorCandidate[]; healed: LocatorCandidate };
  /** A check implied by the action itself (a healed fill must have put the value into the healed field). */
  implied?: { ok: boolean; message: string };
  /** Extra evidence ids the action produced (e.g. an OCR match image). */
  evidence?: string[];
  /** The action changed the screen (new terminal screen, window): snapshot it even when the policy is on-failure. */
  newScreen?: boolean;
}

/** Evidence a surface can produce about its current state. */
export interface SurfaceCapture {
  /** A picture of the screen/window (PNG) or a rendering (SVG). */
  image?: { data: Buffer | string; ext: 'png' | 'svg' };
  /** Structured state: UIA/component tree (xml), terminal screen (json), SAP element dump (json). */
  snapshot?: { data: string; ext: 'json' | 'xml' | 'txt' | 'html'; description: string };
}

export interface DesktopSurface {
  readonly kind: SurfaceKind;
  /** Human label, e.g. 'mainframe "cics"' or 'Windows app "Invoice"'. */
  readonly label: string;
  /** Whether this surface takes a generic step (default: everything but PASS_THROUGH actions). */
  accepts?(step: Step): boolean;
  /** Run a generic step (click, fill, press, capture ...) on this surface; undefined: not supported here. */
  act(step: Step, ctx: StepContext, rt: InterceptorRuntime): Promise<ActResult | undefined>;
  /** Evaluate a condition on this surface; undefined: not about this surface. */
  evaluate(c: Condition, env: ConditionEnv): Promise<ConditionResult | undefined>;
  capture(): Promise<SurfaceCapture>;
  close(): Promise<void>;
}

/** Actions the browser keeps handling while a surface is active (they do not touch the page). */
export const PASS_THROUGH = new Set(['api', 'db', 'set', 'wait', 'useData', 'compareDocument', 'email', 'sms', 'ws', 'compareData', 'login', 'navigate', 'tab', 'runJourney']);

export function unsupported(surface: DesktopSurface, step: Step): never {
  throw new NotSupportedError(`"${step.action}" steps on ${surface.label} (${step.intent}); see docs/desktop-and-legacy.md for what each driver supports`);
}

/** A condition target that means the whole screen. */
export const SCREEN_TARGET = /^(?:the\s+)?(?:terminal\s+|mainframe\s+|desktop\s+|sap\s+)?screen$/i;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Shared text-based condition evaluation for surfaces that expose screen text and element text. */
export async function evaluateTextConditions(
  c: Condition,
  env: ConditionEnv,
  io: { screenText(): Promise<string>; elementText?(c: Extract<Condition, { target: unknown }>['target'], field: 'text' | 'value'): Promise<string | undefined>; label: string },
): Promise<ConditionResult | undefined> {
  const I = env.interpolate;
  const ok = (actual?: string): ConditionResult => ({ condition: c, passed: true, ...(actual !== undefined ? { actual } : {}) });
  const fail = (message: string, actual?: string): ConditionResult => ({ condition: c, passed: false, message, ...(actual !== undefined ? { actual } : {}) });
  // "Expect the screen to contain X" as a post-condition parses as text of a target named "the screen".
  if ((c.type === 'textContains' || c.type === 'textEquals') && SCREEN_TARGET.test(c.target.description.trim())) {
    return evaluateTextConditions({ type: 'pageContainsText', value: c.value }, env, io).then((r) => r && { ...r, condition: c });
  }
  if (c.type === 'hidden' && SCREEN_TARGET.test(c.target.description.trim())) return undefined;
  switch (c.type) {
    case 'pageContainsText':
    case 'pageNotContainsText': {
      const text = await io.screenText();
      const want = norm(I(c.value));
      if (!want) return fail('expected text is empty');
      const has = norm(text).includes(want) || text.includes(I(c.value));
      if (c.type === 'pageContainsText') return has ? ok() : fail(`${io.label} does not show "${want}"`, norm(text).slice(0, 300));
      return has ? fail(`${io.label} shows "${want}"`) : ok();
    }
    case 'textContains':
    case 'textEquals':
    case 'valueEquals':
    case 'textMatches': {
      if (!io.elementText) return undefined;
      const field = c.type === 'valueEquals' || (c.type === 'textMatches' && c.field === 'value') ? 'value' : 'text';
      let got: string | undefined;
      try {
        got = await io.elementText(c.target, field);
      } catch (e) {
        return fail(`${c.target.description}: ${(e as Error).message}`);
      }
      if (got === undefined) return fail(`${c.target.description} was not found on ${io.label}`);
      const g = norm(got);
      if (c.type === 'textMatches') {
        const re = new RegExp(I(c.pattern), c.flags);
        return re.test(g) ? ok(g) : fail(`${c.target.description} "${g}" does not match /${re.source}/`, g);
      }
      const want = norm(I(c.value));
      if (c.type === 'textContains') return want && g.includes(want) ? ok(g) : fail(`${c.target.description} "${g}" does not contain "${want}"`, g);
      return g === want ? ok(g) : fail(`${c.target.description} is "${g}", expected "${want}"`, g);
    }
    case 'visible':
    case 'hidden': {
      if (!io.elementText) return undefined;
      let got: string | undefined;
      try {
        got = await io.elementText(c.target, 'text');
      } catch {
        got = undefined;
      }
      const shown = got !== undefined;
      if (c.type === 'visible') return shown ? ok('visible') : fail(`${c.target.description} is not on ${io.label}`, 'absent');
      return shown ? fail(`${c.target.description} is on ${io.label}`, 'visible') : ok('hidden');
    }
    default:
      return undefined;
  }
}

/** Store what a surface shows now as evidence of a step. */
export async function storeSurfaceEvidence(surface: DesktopSurface, step: Step, ctx: StepContext, why: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    const cap = await surface.capture();
    const prefix = `journeys/${safeName(ctx.journey.id)}/attempt-${ctx.attempt}/desktop/${safeName(step.id)}`;
    const meta = (d: string) => ({ journeyId: ctx.journey.id, stepId: step.id, description: `desktop: ${surface.kind}: ${d}` });
    if (cap.image) ids.push((await ctx.evidence.store('screenshot', `${prefix}.${cap.image.ext}`, cap.image.data, meta(`${why} (${surface.label})`))).id);
    if (cap.snapshot) {
      const kind = cap.snapshot.ext === 'xml' ? 'aria' : cap.snapshot.ext === 'html' ? 'dom' : 'data';
      ids.push((await ctx.evidence.store(kind, `${prefix}.${cap.snapshot.description.replace(/\W+/g, '-')}.${cap.snapshot.ext}`, cap.snapshot.data, meta(`${cap.snapshot.description} ${why}`))).id);
    }
  } catch (e) {
    ctx.logger.warn('could not capture desktop evidence', { stepId: step.id, surface: surface.label, message: (e as Error).message });
  }
  return ids;
}

/**
 * Run one step on a surface with the same guarantees as a browser step:
 * post-conditions are polled, a heal counts only when they hold, the
 * fingerprint is recorded on success, evidence follows the screenshot policy.
 */
export async function runSurfaceStep(
  surface: DesktopSurface,
  step: Step,
  ctx: StepContext,
  rt: InterceptorRuntime,
  act: () => Promise<ActResult>,
): Promise<InterceptedStep> {
  const attempts = step.poll ? (step.poll.attempts ?? 10) : 1;
  const policy = rt.opts.screenshots ?? 'on-failure';
  let result: ActResult | undefined;
  let conditions: ConditionResult[] = [];
  let error: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    error = undefined;
    try {
      result = await act();
    } catch (e) {
      error = (e as Error).message.split('\n')[0];
      result = undefined;
    }
    if (!error && result?.captured) for (const [k, v] of Object.entries(result.captured)) ctx.ledger.set(k, v);
    if (!error && step.postconditions.length) conditions = await evaluateConditions(step.postconditions, envFor(ctx, rt.opts), last ? rt.conditionTimeoutMs : 0);
    if (last || (!error && conditions.every((c) => c.passed))) break;
    await new Promise((r) => setTimeout(r, step.poll?.intervalMs ?? 500));
  }
  const condOk = conditions.every((c) => c.passed);
  let status: InterceptedStep['status'] = !error && condOk ? 'passed' : 'failed';
  let heal: HealRecord | undefined;
  if (result?.heal) {
    heal = { stepId: step.id, tier: result.heal.tier, original: result.heal.original, healed: result.heal.healed, confidence: result.heal.confidence, verified: false, reason: result.heal.reason, evidence: [] };
    const implied = result.implied;
    if (implied) heal.reason = `${heal.reason}; ${implied.message}`;
    if (!error && condOk && (conditions.length || implied) && (implied?.ok ?? true)) {
      heal.verified = true;
      status = 'passed-healed';
      rt.store.recordHeal(ctx.journey.id, step.id, { locator: result.heal.healed, original: result.heal.original, tier: result.heal.tier, confidence: result.heal.confidence, verifiedAt: new Date().toISOString(), runId: ctx.runId });
    } else if (!error) {
      status = 'failed';
      error = conditions.length || implied
        ? `suspected regression: a matching element was found but the expected outcome did not happen (${[...conditions.filter((c) => !c.passed).map((c) => c.message), implied && !implied.ok ? implied.message : ''].filter(Boolean).join('; ')})`
        : 'heal could not be verified: the step has no post-conditions (add an Expect line)';
    }
    rt.opts.events?.emit({ type: 'heal', journeyId: ctx.journey.id, stepId: step.id, tier: result.heal.tier, verified: heal.verified });
  }
  if ((status === 'passed' || status === 'passed-healed') && result?.fingerprint) rt.store.recordSuccess(ctx.journey.id, step.id, result.fingerprint, result.heal?.healed ?? result.usedLocator);
  if (!error && !condOk) error = `post-condition failed: ${conditions.filter((c) => !c.passed).map((c) => `${c.condition.type}: ${c.message ?? 'failed'}`).join('; ')}`;
  const failed = status === 'failed';
  const evidence = [...(result?.evidence ?? [])];
  if (policy !== 'off' && (policy === 'every-step' || failed || heal || result?.newScreen)) {
    const ids = await storeSurfaceEvidence(surface, step, ctx, failed ? 'at failure' : heal ? 'after heal' : `after ${step.action}`);
    evidence.push(...ids);
    if (heal) heal.evidence.push(...ids);
  }
  return {
    status,
    conditions,
    evidence,
    surface: result?.surface ?? { driver: surface.kind, rung: 'object' },
    ...(result?.usedLocator ? { usedLocator: result.usedLocator } : {}),
    ...(result?.captured ? { captured: result.captured } : {}),
    ...(heal ? { heal } : {}),
    ...(error ? { error: { message: error } } : {}),
  };
}
