/**
 * `clock`: the browser clock of the journey's context, from code. Every call is
 * a runner step (the same as the `.ez` clock phrasings: evidence, trace,
 * debugger), so `today()` / `now()` in later steps follow the fake time too.
 *
 * ```ts
 * await clock.set('2026-12-31 23:59:50');
 * await ui.open('/lab/clock');
 * await clock.advance('15 seconds');
 * ```
 */
import { literal, run, tempKey } from './internal.js';
import { currentHost } from './runtime.js';

/** A time: epoch ms, a Date, or `2027-03-15 09:00` / `2026-12-31T23:59:50Z` / `2026-12-31 23:59 Europe/London`. */
export type ClockInput = number | Date | string;
/** A duration: ms, or `2 hours`, `1h30m`, `01:30:00`. */
export type DurationInput = number | string;

const timeText = (t: ClockInput) => (typeof t === 'number' ? new Date(t).toISOString() : t instanceof Date ? t.toISOString() : t);
const durText = (d: DurationInput) => (typeof d === 'number' ? `${Math.round(d)} ms` : d);

async function op(intent: string, clockOp: string, extra: Record<string, string> = {}): Promise<void> {
  await run({ intent, action: 'browser', args: { op: 'clock', clock: clockOp, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, literal(v)])) } });
}

export const clock = {
  /** Show `time` from now on (installs the fake clock on first use); time keeps flowing. */
  set: (time: ClockInput) => op(`Set the clock to ${timeText(time)}`, 'set', { time: timeText(time) }),
  /** Install the fake clock (at `time`, default now) without changing anything else. */
  install: (time?: ClockInput) => op(time === undefined ? 'Install a fake clock' : `Install a fake clock at ${timeText(time)}`, 'install', time === undefined ? {} : { time: timeText(time) }),
  /** Date always says `time`; timers keep running. */
  freeze: (time: ClockInput) => op(`Freeze the clock at ${timeText(time)}`, 'fixed', { time: timeText(time) }),
  pause: () => op('Pause the clock', 'pause'),
  pauseAt: (time: ClockInput) => op(`Pause the clock at ${timeText(time)}`, 'pauseAt', { time: timeText(time) }),
  resume: () => op('Resume the clock', 'resume'),
  /** Jump ahead, firing each due timer once. */
  advance: (d: DurationInput) => op(`Advance the clock by ${durText(d)}`, 'fastForward', { duration: durText(d) }),
  /** Advance, firing every timer in order (intervals repeatedly). */
  runFor: (d: DurationInput) => op(`Run the clock for ${durText(d)}`, 'runFor', { duration: durText(d) }),
  runAll: () => op('Run all timers', 'runAll'),
  runToLast: () => op('Run timers to the last one', 'runToLast'),
  useRealTime: () => op('Use the real clock', 'real'),
  /** The fake time now (undefined when no clock is installed). */
  async now(): Promise<Date | undefined> {
    const key = tempKey('clock');
    const r = await run({ intent: 'Read the clock', action: 'browser', args: { op: 'clock', clock: 'read' }, captureAs: key }, { optional: true });
    currentHost().deleteVar(key);
    const v = r.captured?.[key];
    return typeof v === 'string' ? new Date(v) : undefined;
  },
};

export type Clock = typeof clock;
