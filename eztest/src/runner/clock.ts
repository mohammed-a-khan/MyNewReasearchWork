/**
 * Clock steps (`Set the clock to 2027-03-15 09:00`, `Advance the clock by 2
 * hours`, `Pause the clock`, `Run all timers`, ...) and the journey `Clock:`
 * header, on the context's browser clock (src/browser/clock.ts). Each change
 * is kept as evidence (`<step>.clock.json`: the operation and the fake time
 * after it), and `today()` / `now()` in expressions follow the fake clock
 * while it is installed.
 */
import { contextClock, installedClock, parseClockDuration, parseClockTime, type BrowserClock } from '../browser/clock.js';
import type { BrowserContext } from '../browser/index.js';
import { CLOCK_NOW_VAR, EzTestError, getDefaultTimeZone, NotSupportedError, type Journey, type Step } from '../core/index.js';
import type { ActionOutcome } from './actions.js';
import { safeName } from './evidence.js';
import type { StepContext } from './types.js';

/** The clock operations a step can ask for (args.clock). */
export const CLOCK_OPS = ['install', 'set', 'fixed', 'pause', 'pauseAt', 'resume', 'fastForward', 'runFor', 'runAll', 'runToLast', 'real', 'read'] as const;
export type ClockOp = (typeof CLOCK_OPS)[number];

/** Time zone clock times without an offset are read in: the journey's Timezone:, the run's pinned zone, else the machine's. */
export function clockZone(journey: Pick<Journey, 'emulation'>): string | undefined {
  return journey.emulation?.timezoneId ?? getDefaultTimeZone();
}

/** Run one clock operation on a context's clock. */
export async function applyClockOp(clock: BrowserClock, op: ClockOp, a: { time?: string; duration?: string; timeZone?: string }): Promise<void> {
  const time = () => {
    if (a.time === undefined) throw new EzTestError(`clock ${op} needs a time`, 'MISSING_VALUE');
    return parseClockTime(a.time, { timeZone: a.timeZone, now: clock.now() });
  };
  const ms = () => {
    if (a.duration === undefined) throw new EzTestError(`clock ${op} needs a duration`, 'MISSING_VALUE');
    return parseClockDuration(a.duration);
  };
  switch (op) {
    case 'install': return clock.install(a.time !== undefined ? time() : undefined);
    case 'set': return clock.installed ? clock.setSystemTime(time()) : clock.install(time());
    case 'fixed': {
      const t = time();
      if (!clock.installed) await clock.install(t);
      return clock.setFixedTime(t);
    }
    case 'pause': return clock.pause();
    case 'pauseAt': {
      const t = time();
      if (!clock.installed) await clock.install(t);
      return clock.pauseAt(t);
    }
    case 'resume': return clock.resume();
    case 'fastForward': return clock.fastForward(ms());
    case 'runFor': return clock.runFor(ms());
    case 'runAll': return clock.runAll();
    case 'runToLast': return clock.runToLast();
    case 'real': return clock.useRealTime();
    case 'read': return;
  }
}

/** A `browser` step with args.op "clock". */
export async function clockAction(step: Step, ctx: StepContext, context: BrowserContext): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const op = String(a.clock ?? '') as ClockOp;
  if (!CLOCK_OPS.includes(op)) throw new NotSupportedError(`clock operation "${op}" (use one of ${CLOCK_OPS.join(', ')})`);
  const clock = contextClock(context);
  const str = (v: unknown) => (v === undefined ? undefined : ctx.interpolate(String(v)));
  await applyClockOp(clock, op, { time: str(a.time), duration: str(a.duration), timeZone: str(a.timeZone) ?? clockZone(ctx.journey) });
  const now = clock.dateNow();
  const fake = now === undefined ? undefined : new Date(now).toISOString();
  if (op === 'read') {
    if (!step.captureAs) throw new EzTestError('Reading the clock needs captureAs', 'MISSING_CAPTURE_KEY');
    if (fake) ctx.ledger.set(step.captureAs, fake);
    return { captured: fake ? { [step.captureAs]: fake } : {} };
  }
  const ref = await ctx.evidence.store('log', `journeys/${safeName(ctx.journey.id)}/attempt-${ctx.attempt}/${safeName(step.id)}.clock.json`,
    JSON.stringify({ op, args: { time: str(a.time), duration: str(a.duration) }, fakeTime: fake, paused: op === 'pause' || op === 'pauseAt', history: clock.history }, null, 2),
    { journeyId: ctx.journey.id, stepId: step.id, description: `clock ${op}${fake ? ` -> ${fake}` : ''}` });
  if (step.captureAs && fake) {
    ctx.ledger.set(step.captureAs, fake);
    return { captured: { [step.captureAs]: fake }, evidence: [ref.id] };
  }
  return { evidence: [ref.id] };
}

/** Apply a journey's `Clock:` header (`2026-12-31T23:59 Europe/London`, `paused 2027-01-01 08:00`) to a new context. */
export async function applyJourneyClock(journey: Journey, context: BrowserContext): Promise<void> {
  const spec = journey.clock?.trim();
  if (!spec) return;
  const m = /^(paused|frozen|fixed)\s+(?:at\s+)?(.+)$/i.exec(spec);
  const op: ClockOp = m ? (/paused/i.test(m[1]) ? 'pauseAt' : 'fixed') : 'set';
  await applyClockOp(contextClock(context), op, { time: m ? m[2] : spec, timeZone: clockZone(journey) });
}

/** Variables that make today() / now() follow an installed clock (empty without one). */
export function clockVars(context: BrowserContext | undefined): Record<string, unknown> {
  const c = context ? installedClock(context) : undefined;
  const t = c?.dateNow();
  return t === undefined ? {} : { [CLOCK_VAR]: t };
}

/** Hidden variable holding the fake epoch ms; read by today() and now() (src/core/expr.ts). */
export const CLOCK_VAR = CLOCK_NOW_VAR;

/** Does a step tree change the clock? (Such journeys never share a pooled browser context.) */
export function usesClock(steps: Step[] | undefined): boolean {
  return (steps ?? []).some((s) => (s.action === 'browser' && s.args?.op === 'clock') || usesClock(s.steps) || usesClock(s.else) || usesClock(s.catch));
}
