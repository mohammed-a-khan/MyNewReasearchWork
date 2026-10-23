/**
 * Runs a journey's steps on a native app (or mobile web / web view) through a
 * NativeContext, with the web runner's guarantees: strict target resolution,
 * post-conditions polled, verified healing (a heal counts only when the
 * post-conditions or action-implied checks hold), the fingerprint store, the
 * flow engine (If/Repeat/For each/While/Retry/Try/Run journey), hash-chained
 * evidence and events. Non-UI steps (API, DB, data, documents, custom steps,
 * variables, email, SMS) run through the runner's own handlers unchanged.
 */
import {
  EzTestError, NotSupportedError, interpolate, journeyStatusFrom, nowIso, sleep,
  type ConditionResult, type ElementFingerprint, type HealRecord, type Journey, type JourneyResult, type LocatorCandidate, type Step, type StepResult,
} from '../core/index.js';
import { performAction, type ActionOutcome } from '../runner/actions.js';
import { resolveUrl } from '../runner/api.js';
import { safeName } from '../runner/evidence.js';
import { executeStep, type FlowEnv, type FlowScope } from '../runner/flow.js';
import { hookStep } from '../runner/journey-hooks.js';
import { runCodeJourney } from '../runner/code-host.js';
import { Ledger } from '../runner/ledger.js';
import type { PlatformRunEnv } from '../runner/platform.js';
import type { ScreenshotPolicy, StepContext } from '../runner/types.js';
import { SUSPECTED_REGRESSION } from '../runner/step.js';
import { evaluateNativeConditions, noPage, type NativeConditionEnv } from './conditions.js';
import { orUnsupported, performDeviceOp } from './device.js';
import { center, directionalSwipe, doubleTap, drag, tap, type Direction } from './gestures.js';
import { nativeHealCandidates } from './heal.js';
import { findersFor } from './locators.js';
import { interpolateCandidate, isWebContext, type NativeContext, type NativeResolution } from './native.js';
import { fingerprintOf } from './source.js';
import type { NativeTraceRecorder } from './trace.js';

export interface NativeRunSettings {
  screenshots: ScreenshotPolicy;
  /** Page source evidence: every step, on failure (and heals), or off. */
  pageSource: 'every-step' | 'on-failure' | 'off';
  webviewTimeoutMs: number;
  baseDir: string;
}

export interface NativeExecEnv extends PlatformRunEnv {
  native: NativeContext;
  platform: string;
  settings: NativeRunSettings;
  trace?: NativeTraceRecorder;
  /** Mobile web: the journey runs in the device browser (a web view context from the start). */
  mobileWeb: boolean;
}

/** Element queries (ui.text, ui.value, ui.attribute, ...) resolved strictly like actions. */
const NATIVE_ELEMENT_QUERIES = new Set(['text', 'value', 'attribute', 'box', 'state']);

/** Actions that act on a resolved element (healing applies). */
const ELEMENT_ACTIONS = new Set(['click', 'dblclick', 'fill', 'clear', 'select', 'check', 'uncheck', 'capture', 'drag', 'focus']);
/** Actions that the runner's own handlers execute (they never touch the page). */
const DATA_ACTIONS = new Set(['api', 'db', 'useData', 'compareDocument', 'custom', 'set', 'email', 'sms', 'ws', 'compareData']);

/** True when a step needs its target resolved (and healed) before acting. */
export function needsNativeTarget(step: Step): boolean {
  if (!step.target) return false;
  if (ELEMENT_ACTIONS.has(step.action)) return true;
  if (step.action === 'press' || step.action === 'wait' || step.action === 'keyboard') return step.args?.for === undefined;
  if (step.action === 'touch') return true;
  if (step.action === 'scroll') return step.args?.op === 'element';
  if (step.action === 'mobile') return step.args?.op === 'longPress' || step.args?.op === 'pinch';
  if (step.action === 'query') return NATIVE_ELEMENT_QUERIES.has(String(step.args?.what ?? 'text'));
  return false;
}

type Core = Omit<StepResult, 'stepId' | 'intent' | 'startedAt' | 'durationMs' | 'evidence'> & { evidence: string[] };

const conditionFailure = (rs: ConditionResult[]) => rs.filter((r) => !r.passed).map((r) => `${r.condition.type}: ${r.message ?? 'failed'}`).join('; ');

function requireValue(step: Step, ctx: StepContext): string {
  if (step.value === undefined) throw new EzTestError(`Step "${step.intent}" (${step.action}) needs a value`, 'MISSING_VALUE');
  return ctx.interpolate(step.value);
}

/** Apply an armed "Accept/Dismiss the next dialog" to a system alert that is now open. */
async function applyArmedDialog(n: NativeContext, ctx: StepContext): Promise<void> {
  const plan = n.armedDialog;
  if (!plan) return;
  const text = await n.device.alertText().catch(() => undefined);
  if (text === undefined) return;
  if (plan.text !== undefined) await n.device.typeText(plan.text).catch(() => undefined);
  if (plan.accept) await n.device.acceptAlert();
  else await n.device.dismissAlert();
  n.armedDialog = undefined;
  ctx.ledger.set('lastDialog', { text, handled: plan.accept ? 'accepted' : 'dismissed' });
}

/** Perform one step's action natively. `el` is the resolved element for target actions. */
export async function performNative(step: Step, el: string | undefined, ctx: StepContext, env: NativeExecEnv, timeout: number): Promise<ActionOutcome> {
  const n = env.native;
  const s = n.ui;
  const d = n.device;
  const need = (): string => {
    if (!el) throw new EzTestError(`Step "${step.intent}" (${step.action}) needs a target`, 'MISSING_TARGET');
    return el;
  };
  const a = (step.args ?? {}) as Record<string, unknown>;
  const web = isWebContext(n.context) ? n.web : undefined;
  let out: ActionOutcome = {};
  switch (step.action) {
    case 'navigate': {
      const mode = a.mode;
      if (mode === 'back') {
        if (web) await web.back();
        else await d.pressKey('back');
      } else if (mode === 'reload' || mode === 'forward') {
        if (!web || mode === 'forward') throw new NotSupportedError(`"${step.intent}" in a native app`);
        await web.navigate(await web.url());
      } else {
        const url = requireValue(step, ctx);
        if (web) await web.navigate(resolveUrl(url, ctx.baseUrl));
        else if (/^[a-z][\w+.-]*:/i.test(url)) await orUnsupported('opening a deep link', () => d.deepLink(url, n.appId));
        else throw new NotSupportedError(`opening "${url}" in a native app: use a deep link (scheme://...) or switch to the web view first`);
      }
      break;
    }
    case 'click': {
      if (a.button === 'right' || a.button === 'middle' || a.modifiers) throw new NotSupportedError(`"${step.intent}" on a touch screen (no mouse buttons or modifiers)`);
      if (a.newPage) throw new NotSupportedError('new tabs on a native app');
      if (a.position) {
        const r = await s.rect(need());
        const p = a.position as { x: number; y: number };
        await n.perform('tap', tap({ x: r.x + p.x, y: r.y + p.y }));
      } else if (a.clickCount === 3) throw new NotSupportedError('triple tap');
      else await s.click(need());
      break;
    }
    case 'dblclick':
      await n.perform('doubleTap', doubleTap(center(await s.rect(need()))));
      break;
    case 'fill': {
      const v = requireValue(step, ctx);
      const id = need();
      await s.clear(id).catch(() => undefined);
      await s.type(id, v);
      break;
    }
    case 'clear':
      await s.clear(need());
      break;
    case 'select': {
      const v = requireValue(step, ctx);
      await s.click(need());
      n.invalidate();
      const probe: NativeResolution = { notes: [], tried: [], ambiguous: false };
      const deadline = Date.now() + timeout;
      while (!(await n.tryCandidate({ strategy: 'text', value: v, exact: true }, probe))) {
        if (Date.now() >= deadline) throw new EzTestError(`option "${v}" not found exactly once after opening ${step.target?.description} (${probe.notes.slice(-3).join('; ')})`, 'NO_OPTION');
        await sleep(250);
        probe.notes = [];
      }
      await s.click(probe.element!);
      break;
    }
    case 'check':
    case 'uncheck': {
      const id = need();
      const want = step.action === 'check';
      if ((await n.checkedOf(id)) !== want) await s.click(id);
      break;
    }
    case 'press': {
      const key = requireValue(step, ctx);
      if (key.includes('+') && key.length > 1) throw new NotSupportedError(`key combination "${key}" on a native app`);
      if (el) await s.click(el);
      for (let i = 0; i < Number(a.times ?? 1); i++) await orUnsupported(`the ${key} key`, () => d.pressKey(key.toLowerCase()));
      break;
    }
    case 'wait': {
      if (a.for !== undefined) throw new NotSupportedError(`"${step.intent}" on a native app (browser events)`);
      if (el) {
        const deadline = Date.now() + timeout;
        while (!(await s.displayed(el).catch(() => false))) {
          if (Date.now() >= deadline) throw new EzTestError(`${step.target?.description} did not become visible within ${timeout} ms`, 'TIMEOUT');
          await sleep(250);
        }
      } else if (step.value !== undefined) {
        const ms = Number(ctx.interpolate(step.value));
        if (!Number.isFinite(ms) || ms < 0) throw new EzTestError(`wait value must be milliseconds, got "${step.value}"`, 'BAD_WAIT');
        await sleep(ms);
      } else if (!step.postconditions.length) throw new EzTestError('wait needs a duration, a target or a condition', 'BAD_WAIT');
      break;
    }
    case 'assert':
      break;
    case 'capture': {
      const mode = a.mode ?? 'text';
      if (mode !== 'text' && mode !== 'value') throw new NotSupportedError(`capture mode "${String(mode)}" on a native app`);
      const v = mode === 'value' ? await n.valueOf(need()) : (await n.textOf(need())).replace(/\s+/g, ' ').trim();
      const k = step.captureAs;
      if (!k) throw new EzTestError(`Step "${step.intent}" needs captureAs`, 'MISSING_CAPTURE_KEY');
      ctx.ledger.set(k, v);
      out = { captured: { [k]: v } };
      break;
    }
    case 'touch': {
      if (a.op === 'swipe') {
        const area = el ? await s.rect(el) : await n.window();
        await n.perform('swipe', directionalSwipe(area, (a.direction as Direction) ?? 'left', a.distance ? Math.min(0.9, Number(a.distance) / Math.max(1, area.width)) : 0.6));
      } else await n.perform('tap', tap(center(await s.rect(need()))));
      break;
    }
    case 'scroll': {
      const op = a.op;
      const dir = String(a.direction ?? 'down');
      const finger: Direction = ({ down: 'up', up: 'down', left: 'right', right: 'left', bottom: 'up', top: 'down' } as Record<string, Direction>)[dir] ?? 'up';
      if (op === 'intoView' || op === 'untilVisible') {
        const r = await performDeviceOp(deviceCtx({ ...step, args: { op: 'swipeUntil', direction: finger, max: a.max ?? 10 } }, undefined, ctx, env, timeout));
        out = { captured: r.captured };
      } else if (op === 'element') await n.perform('scroll', directionalSwipe(await s.rect(need()), finger));
      else if (op === 'page') await n.perform('scroll', directionalSwipe(await n.window(), finger, a.amount ? 0.4 : 0.7));
      else throw new NotSupportedError(`scroll "${String(op)}" on a native app`);
      break;
    }
    case 'drag': {
      if (!step.to) throw new NotSupportedError('drag by offset on a native app (drag to another element)');
      const to = await n.resolve(step.to, ctx.vars(), timeout);
      if (!to.element) throw new EzTestError(`drag destination ${step.to.description} not found exactly once (${to.notes.join('; ')})`, 'MISSING_TARGET');
      await n.perform('drag', drag(center(await s.rect(need())), center(await s.rect(to.element))));
      break;
    }
    case 'keyboard': {
      const op = a.op ?? 'type';
      const v = requireValue(step, ctx);
      if (op === 'type' || op === 'insert') {
        if (el) await s.type(el, v);
        else await d.typeText(v);
      } else throw new NotSupportedError(`holding keys on a native app ("${step.intent}")`);
      break;
    }
    case 'focus':
      if (a.op === 'blur') await d.hideKeyboard().catch(() => undefined);
      else await s.click(need());
      break;
    case 'network': {
      if (a.op !== 'offline' && a.op !== 'online') throw new NotSupportedError(`network "${String(a.op)}" on a native app (request mocking needs a browser; use an API mock server)`);
      const r = await performDeviceOp(deviceCtx({ ...step, args: { op: 'network', wifi: a.op === 'online', data: a.op === 'online' } }, undefined, ctx, env, timeout));
      out = { captured: r.captured };
      break;
    }
    case 'browser': {
      if (a.op === 'geolocation') {
        await orUnsupported('setting the location', () => d.setGeolocation(Number(a.latitude), Number(a.longitude)));
        break;
      }
      throw new NotSupportedError(`"${step.intent}" on a native app (browser state); use the mobile phrasings (Grant the app permission ..., Turn off wifi, ...)`);
    }
    case 'dialog': {
      const op = a.op;
      n.armedDialog = { accept: op !== 'dismiss', ...(op === 'answer' ? { text: requireValue(step, ctx) } : {}) };
      await applyArmedDialog(n, ctx);
      break;
    }
    case 'query': {
      const k = step.captureAs;
      if (!k) throw new EzTestError(`Step "${step.intent}" needs captureAs`, 'MISSING_CAPTURE_KEY');
      const what = String(a.what ?? 'text');
      let v: unknown;
      switch (what) {
        case 'text': v = await n.textOf(need()); break;
        case 'value': v = await n.valueOf(need()); break;
        case 'attribute': v = await s.attribute(need(), ctx.interpolate(String(a.name ?? ''))); break;
        case 'box': v = await s.rect(need()); break;
        case 'count': v = step.target ? (await n.matches(step.target, ctx.vars())).length : 0; break;
        case 'texts': {
          const ids = step.target ? await n.matches(step.target, ctx.vars()) : [];
          v = await Promise.all(ids.map((id) => n.textOf(id)));
          break;
        }
        case 'url': case 'title':
          if (!web) throw new NotSupportedError(`reading the ${what} in a native app (switch to the web view first)`);
          v = what === 'url' ? await web.url() : await web.title();
          break;
        default: throw new NotSupportedError(`query "${what}" on a native app`);
      }
      ctx.ledger.set(k, v);
      out = { captured: { [k]: v } };
      break;
    }
    case 'mobile': {
      const r = await performDeviceOp(deviceCtx(step, el, ctx, env, timeout));
      if (r.captured) for (const [k, v] of Object.entries(r.captured)) if (k !== 'swipes' && k !== 'context') ctx.ledger.set(k, v);
      const ev: string[] = [];
      if (r.file) {
        const ref = await ctx.evidence.store('download', `downloads/${safeName(ctx.journey.id)}/${safeName(step.id)}-${safeName(r.file.name)}`, r.file.data, { journeyId: ctx.journey.id, stepId: step.id, description: `file pulled from the device: ${r.file.name}` });
        ev.push(ref.id);
      }
      out = { captured: r.captured, evidence: ev };
      break;
    }
    default: {
      if (DATA_ACTIONS.has(step.action) || step.action === 'login') return performAction(step, undefined, ctx, env.opts, timeout);
      throw new NotSupportedError(`"${step.intent}" (${step.action}) on a native app`);
    }
  }
  n.invalidate();
  await applyArmedDialog(n, ctx);
  return out;
}

function deviceCtx(step: Step, el: string | undefined, ctx: StepContext, env: NativeExecEnv, timeout: number) {
  return {
    native: env.native, step, element: el, timeoutMs: timeout, baseDir: env.settings.baseDir, webviewTimeoutMs: env.settings.webviewTimeoutMs,
    interpolate: (s: string) => ctx.interpolate(s), vars: () => ctx.vars(),
    findVisible: async () => (step.target ? (await env.native.resolve(step.target, ctx.vars(), 0)).element : undefined),
  };
}

/** Checks implied by the action (used to verify heals). Undefined: nothing implied. */
export async function nativeImplicitCheck(step: Step, el: string, ctx: StepContext, env: NativeExecEnv, outcome: ActionOutcome): Promise<{ ok: boolean; message: string } | undefined> {
  const n = env.native;
  switch (step.action) {
    case 'fill': {
      if ((await n.ui.attribute(el, 'password').catch(() => null)) === 'true') return undefined;
      const want = ctx.interpolate(step.value ?? '');
      const v = await n.valueOf(el).catch(() => undefined);
      return { ok: v === want, message: v === want ? 'field holds the typed value' : 'field does not hold the typed value' };
    }
    case 'clear': {
      const v = await n.valueOf(el).catch(() => undefined);
      return { ok: v === '', message: v === '' ? 'field is empty' : 'field is not empty' };
    }
    case 'check':
    case 'uncheck': {
      const c = await n.checkedOf(el).catch(() => undefined);
      const ok = c === (step.action === 'check');
      return { ok, message: ok ? `element is ${step.action === 'check' ? 'checked' : 'unchecked'}` : 'checked state did not change' };
    }
    case 'capture': {
      const v = outcome.captured ? Object.values(outcome.captured)[0] : undefined;
      const ok = typeof v === 'string' && v.length > 0;
      return { ok, message: ok ? 'captured a value' : 'captured an empty value' };
    }
    default:
      return undefined;
  }
}

function condEnv(ctx: StepContext, env: NativeExecEnv): NativeConditionEnv {
  return { native: env.native, ledger: ctx.ledger, vars: () => ctx.vars(), interpolate: (s) => ctx.interpolate(s), baseDir: env.settings.baseDir };
}

async function screenshotBeforeAssertion(step: Step, ctx: StepContext, env: NativeExecEnv): Promise<void> {
  if (env.settings.screenshots !== 'before-assertions' || !step.postconditions.length) return;
  try {
    const png = await env.native.device.screenshot();
    await ctx.evidence.store('screenshot', `journeys/${safeName(ctx.journey.id)}/attempt-${ctx.attempt}/${safeName(step.id)}.before-assert.png`, png, { journeyId: ctx.journey.id, stepId: step.id, description: 'screenshot before assertion' });
  } catch (e) {
    ctx.logger.warn('could not capture the pre-assertion screenshot', { stepId: step.id, message: (e as Error).message });
  }
}

async function actAndVerify(step: Step, el: string | undefined, ctx: StepContext, env: NativeExecEnv, timeout: number) {
  const attempts = step.poll ? (step.poll.attempts ?? 10) : 1;
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    let outcome: ActionOutcome;
    try {
      outcome = await performNative(step, el, ctx, env, timeout);
    } catch (e) {
      if (last) throw e;
      await sleep(step.poll?.intervalMs ?? 500);
      continue;
    }
    if (!step.postconditions.length) return { outcome, conditions: [] as ConditionResult[] };
    await screenshotBeforeAssertion(step, ctx, env);
    const conditions = await evaluateNativeConditions(step.postconditions, condEnv(ctx, env), last ? env.conditionTimeoutMs : 0);
    if (last || conditions.every((c) => c.passed)) return { outcome, conditions };
    await sleep(step.poll?.intervalMs ?? 500);
  }
}

async function fingerprint(env: NativeExecEnv, el: string): Promise<ElementFingerprint | undefined> {
  try {
    const node = await env.native.nodeOf(el);
    return node ? fingerprintOf(node) : undefined;
  } catch {
    return undefined;
  }
}

function rawCandidate(raws: LocatorCandidate[], used: LocatorCandidate, vars: Record<string, unknown>): LocatorCandidate {
  return raws.find((r) => JSON.stringify(interpolateCandidate(r, vars)) === JSON.stringify(used)) ?? used;
}

/** Execute one step (resolve, act, verify, heal). Screenshots and page source are added by the caller. */
export async function executeNativeStepCore(step: Step, ctx: StepContext, env: NativeExecEnv): Promise<Core & { element?: string }> {
  const timeout = step.timeoutMs ?? env.stepTimeoutMs;
  const n = env.native;
  if (step.action === 'assert' && step.postconditions.length === 0) {
    return { status: 'failed', conditions: [], evidence: [], error: { message: 'assert step has no post-conditions; nothing would be checked' } };
  }
  if (!needsNativeTarget(step)) {
    const { outcome, conditions } = await actAndVerify(step, undefined, ctx, env, timeout);
    const passed = conditions.every((c) => c.passed);
    return { status: passed ? 'passed' : 'failed', conditions, evidence: outcome.evidence ?? [], captured: outcome.captured, ...(passed ? {} : { error: { message: `post-condition failed: ${conditionFailure(conditions)}` } }) };
  }
  const target = step.target!;
  const vars = ctx.vars();
  const res = await n.resolve(target, vars, Math.min(timeout, env.locateTimeoutMs));
  const loc = { tried: res.tried, used: res.candidate, element: res.element } as NonNullable<ReturnType<NonNullable<NativeExecEnv['trace']>['located']['get']>>;
  env.trace?.located.set(step.id, loc);
  if (res.element && res.candidate) {
    const fp = await fingerprint(env, res.element);
    const { outcome, conditions } = await actAndVerify(step, res.element, ctx, env, timeout);
    const passed = conditions.every((c) => c.passed);
    if (passed) env.store.recordSuccess(ctx.journey.id, step.id, fp, rawCandidate(target.locators, res.candidate, vars));
    return {
      status: passed ? 'passed' : 'failed', conditions, evidence: outcome.evidence ?? [], usedLocator: res.candidate, captured: outcome.captured, element: res.element,
      ...(passed ? {} : { error: { message: `post-condition failed: ${conditionFailure(conditions)}` } }),
    };
  }

  // ---------------------------------------------------------------- healing
  const failure = `no locator candidate matched exactly one element for ${target.description} (${res.notes.slice(0, 8).join('; ')})`;
  const policy = env.opts.healer?.policy;
  if (!policy) return { status: 'failed', conditions: [], evidence: [], error: { message: failure } };
  const notes: string[] = [];
  loc.heal = { attempts: [], notes };
  for await (const cand of nativeHealCandidates(policy, { journeyId: ctx.journey.id, stepId: step.id, target, store: env.store, note: (m) => notes.push(m) }, n)) {
    const c = interpolateCandidate(cand.locator, vars);
    const probe: NativeResolution = { notes: [], tried: [], ambiguous: false };
    const found = await n.tryCandidate(c, probe);
    loc.heal.attempts.push({ tier: cand.tier, locator: c, confidence: cand.confidence, reason: cand.reason, matches: found ? 1 : probe.tried.reduce((m, t) => Math.max(m, t.count), 0) });
    if (!found || !probe.element) {
      notes.push(`${cand.tier}: ${c.strategy}=${c.value} did not match exactly one element (skipped)`);
      continue;
    }
    const el = probe.element;
    loc.element = el;
    const fp = await fingerprint(env, el);
    const heal: HealRecord = { stepId: step.id, tier: cand.tier, original: target.locators, healed: cand.locator, confidence: cand.confidence, verified: false, reason: cand.reason, evidence: [] };
    ctx.logger.info('heal attempt', { journeyId: ctx.journey.id, stepId: step.id, tier: cand.tier, locator: `${c.strategy}=${c.value}` });
    let outcome: ActionOutcome = {};
    let conditions: ConditionResult[] = [];
    try {
      ({ outcome, conditions } = await actAndVerify(step, el, ctx, env, timeout));
    } catch (e) {
      env.opts.events?.emit({ type: 'heal', journeyId: ctx.journey.id, stepId: step.id, tier: cand.tier, verified: false });
      return { status: 'failed', conditions, evidence: [], heal, usedLocator: c, element: el, error: { message: `${SUSPECTED_REGRESSION} (healed ${cand.tier} candidate ${c.strategy}=${c.value}; action failed: ${(e as Error).message.split('\n')[0]})` } };
    }
    const implied = await nativeImplicitCheck(step, el, ctx, env, outcome);
    const condOk = conditions.every((r) => r.passed);
    const hasVerification = conditions.length > 0 || implied !== undefined;
    const verified = hasVerification && condOk && (implied?.ok ?? true);
    heal.verified = verified;
    heal.reason = `${cand.reason}${implied ? `; ${implied.message}` : ''}`;
    env.opts.events?.emit({ type: 'heal', journeyId: ctx.journey.id, stepId: step.id, tier: cand.tier, verified });
    if (verified) {
      env.store.recordSuccess(ctx.journey.id, step.id, fp, cand.locator);
      env.store.recordHeal(ctx.journey.id, step.id, { locator: cand.locator, original: target.locators, tier: cand.tier, confidence: cand.confidence, verifiedAt: nowIso(), runId: ctx.runId });
      return { status: 'passed-healed', conditions, evidence: outcome.evidence ?? [], heal, usedLocator: c, captured: outcome.captured, element: el };
    }
    const why = !hasVerification
      ? 'heal could not be verified: the step has no post-conditions (add an Expect line)'
      : `${SUSPECTED_REGRESSION} (${[conditionFailure(conditions), implied && !implied.ok ? implied.message : ''].filter(Boolean).join('; ')})`;
    return { status: 'failed', conditions, evidence: outcome.evidence ?? [], heal, usedLocator: c, captured: outcome.captured, element: el, error: { message: why } };
  }
  return { status: 'failed', conditions: [], evidence: [], error: { message: `${failure}; healing found no candidate${notes.length ? ` (${notes.join('; ')})` : ''}` } };
}

/** Run a step with evidence (screenshots, page source), trace and events. */
async function runNativeStep(step: Step, index: number, ctx: StepContext, env: NativeExecEnv, prefix: string): Promise<StepResult> {
  const { opts, evidence } = env;
  const n = env.native;
  const t0 = Date.now();
  const startedAt = nowIso();
  const meta = (description: string) => ({ journeyId: ctx.journey.id, stepId: step.id, description });
  opts.events?.emit({ type: 'step:start', journeyId: ctx.journey.id, stepId: step.id, intent: step.intent });
  n.currentStep = step.id;
  if (env.trace) {
    await env.trace.beginStep(index, step);
    if (step.action === 'fill' && step.value !== undefined && /pass(?:word|code)|pin\b|secret/i.test(step.target?.description ?? '')) env.trace.learn(ctx.interpolate(step.value));
  }
  let sr: StepResult;
  try {
    const { element: _e, ...core } = await executeNativeStepCore(step, ctx, env);
    sr = { stepId: step.id, intent: step.intent, startedAt, durationMs: 0, ...core };
  } catch (e) {
    const err = e as Error;
    sr = { stepId: step.id, intent: step.intent, status: 'failed', startedAt, durationMs: 0, conditions: [], evidence: [], error: { message: err.message.split('\n')[0], name: err.name } };
  }
  const failed = sr.status === 'failed';
  const shots = env.settings.screenshots;
  let shot: { id: string; path: string } | undefined;
  try {
    if (shots === 'every-step' || ((shots === 'on-failure' || shots === 'before-assertions') && failed) || sr.heal) {
      const png = await n.device.screenshot();
      const ref = await evidence.store('screenshot', `${prefix}/${safeName(step.id)}.png`, png, meta(`screenshot after ${step.action}`));
      sr.evidence.push(ref.id);
      if (sr.heal) sr.heal.evidence.push(ref.id);
      shot = { id: ref.id, path: ref.path };
    }
    const ps = env.settings.pageSource;
    if (ps === 'every-step' || (ps === 'on-failure' && (failed || sr.heal))) {
      n.invalidate();
      const { xml } = await n.source(0);
      const ref = await evidence.store('dom', `${prefix}/${safeName(step.id)}.source.${n.web ? 'html' : 'xml'}`, xml, meta(failed ? 'page source at failure' : 'page source after step'));
      sr.evidence.push(ref.id);
      if (sr.heal) sr.heal.evidence.push(ref.id);
    }
  } catch (e) {
    env.logger.warn('could not capture step evidence', { stepId: step.id, message: (e as Error).message });
  }
  await env.trace?.endStep(sr, shot);
  sr.durationMs = Date.now() - t0;
  opts.events?.emit({ type: 'step:end', journeyId: ctx.journey.id, stepId: step.id, status: sr.status, durationMs: sr.durationMs });
  if (step.optional && sr.status === 'failed') {
    sr.status = 'skipped';
    sr.error = { message: `optional step failed: ${sr.error?.message ?? 'unknown'}` };
  }
  return sr;
}

const CANCELLED = 'not run: run cancelled';

/** Run a journey's steps (plus beforeEach/afterEach hooks) on the native context; fills `result`. */
export async function runNativeJourney(journey: Journey, attempt: number, env: NativeExecEnv, result: JourneyResult): Promise<void> {
  const { opts } = env;
  const ledger = new Ledger();
  const vars = (): Record<string, unknown> => ({ ...journey.variables, ...(opts.variables ?? {}), ...ledger.view() });
  const prefix = `journeys/${safeName(journey.id)}/attempt-${attempt}`;
  const baseUrl = journey.baseUrl ?? opts.baseUrl;
  const ctxFor = (step: Step, scope?: FlowScope): StepContext => {
    const j = scope?.journey ?? journey;
    const l = scope?.ledger ?? ledger;
    const v = scope && scope.ledger !== ledger ? (): Record<string, unknown> => ({ ...j.variables, ...(opts.variables ?? {}), ...(scope.params ?? {}), ...l.view() }) : vars;
    return {
      runId: env.runId, runDir: env.runDir, journey: j, step, page: noPage(`"${step.intent}"`), context: noPage(`"${step.intent}"`), ledger: l, attempt, baseUrl,
      logger: env.logger, evidence: env.evidence, vars: v, interpolate: (s: string) => interpolate(s, v()), platform: { name: env.platform, session: env.native.device },
    };
  };
  let extraIndex = journey.steps.length;
  const flow: FlowEnv = {
    opts, logger: env.logger, events: opts.events, stepTimeoutMs: env.stepTimeoutMs, journeys: env.journeys,
    leaf: (step, sc) => {
      const top = sc.ledger === ledger ? journey.steps.indexOf(step) : -1;
      return runNativeStep(step, top >= 0 ? top : extraIndex++, ctxFor(step, sc), env, sc.prefix);
    },
    ctx: (step, scope) => ctxFor(step, scope),
    evaluateConditions: (conds, ctx, timeoutMs) => evaluateNativeConditions(conds, condEnv(ctx, env), timeoutMs),
  };
  const scope: FlowScope = { journey, ledger, prefix, depth: 0 };
  try {
    if (journey.lenses.length) throw new NotSupportedError(`lenses (${journey.lenses.join(', ')}) on native apps; they analyse browser pages`);
    if (opts.debug) env.logger.warn('the step debugger drives browser pages; the native journey runs without it', { journeyId: journey.id });
    if (journey.data.length) {
      if (!opts.data) throw new Error('Journey declares data needs but no data handler is configured (RunOptions.data)');
      for (const need of journey.data) ledger.set(need.as, await opts.data(need, ctxFor(journey.steps[0])));
    }
    let blocked: string | undefined;
    // A code journey (eztest/sdk) runs its function; its ui.* calls are leaf steps executed on the device.
    const steps = [...(opts.hooks?.beforeEach ?? []).map((h) => hookStep('before-each', h)), ...(journey.code ? [] : journey.steps)];
    for (const step of steps) {
      if (!blocked && opts.signal?.aborted) blocked = CANCELLED;
      if (blocked) {
        result.steps.push({ stepId: step.id, intent: step.intent, status: 'skipped', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], error: { message: blocked } });
        continue;
      }
      const sr = await executeStep(step, scope, flow);
      result.steps.push(sr);
      if (sr.status === 'failed' && !step.optional && !step.soft && !sr.soft) blocked = `not run: step "${step.id}" failed`;
    }
    let codeStatus: Awaited<ReturnType<typeof runCodeJourney>> | undefined;
    if (journey.code && !blocked && !opts.signal?.aborted) {
      codeStatus = await runCodeJourney(journey, scope, flow);
      result.steps.push(...codeStatus.steps);
    }
    const hooksAfter = result.steps.length;
    if (!opts.signal?.aborted) for (const h of opts.hooks?.afterEach ?? []) result.steps.push(await executeStep(hookStep('after-each', h), scope, flow));
    result.status = journeyStatusFrom(result.steps);
    if (codeStatus) {
      const hooks = [...result.steps.slice(0, hooksAfter - codeStatus.steps.length), ...result.steps.slice(hooksAfter)];
      result.status = hooks.some((x) => x.status === 'failed' || x.status === 'blocked') ? 'failed' : codeStatus.status;
      if (codeStatus.error && !result.error) result.error = codeStatus.error;
    }
    if (blocked === CANCELLED || (codeStatus && opts.signal?.aborted)) {
      result.status = 'skipped';
      result.error = { message: 'Run cancelled', name: 'CancelledError' };
    }
  } finally {
    result.ledger = ledger.toJSON();
  }
}

/** Finders for a candidate in the current context (exported for tools and tests). */
export { findersFor };
