/**
 * Clock and time phrasings (category "Clock"): the browser clock of the
 * journey's context (src/browser/clock.ts). Every phrase becomes a `browser`
 * step with args `{ op: 'clock', clock, time?, duration? }`.
 *
 *   Set the clock to 2027-03-15 09:00         Freeze the clock at "2026-12-31 23:59"
 *   Pause the clock                           Pause the clock at 2027-01-01 08:00
 *   Resume the clock                          Advance the clock by 2 hours
 *   Run the clock for 30 minutes              Run all timers
 *   Run timers to the last one                Use the real clock
 */
import type { Step } from '../core/index.js';
import { parseClockDuration, parseClockTime } from '../browser/clock.js';
import { literal } from './quotes.js';
import { quoteText } from './quotes.js';
import type { IntentRule, StepBody } from './rules.js';

const Q = String.raw`⟦\d+⟧`;
/** A clock time: quoted, a variable, `now`, or a bare ISO-like date/time with an optional zone. */
const TIME = String.raw`(${Q}|\$\{[^}]+\}|now|\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT|[A-Za-z_]+\/[A-Za-z0-9_+/-]+))?)`;
/** A duration: "2 hours", "1h30m", "90 minutes and 10 seconds", "01:30:00", or quoted / a variable. */
const DURATION = String.raw`(${Q}|\$\{[^}]+\}|\d+:\d{2}(?::\d{2})?|\d+(?:\.\d+)?\s*[a-z]+(?:(?:\s*,\s*|\s+and\s+|\s+|)\d+(?:\.\d+)?\s*[a-z]+)*)`;
const CLOCK = String.raw`(?:the\s+)?(?:browser\s+|page\s+|fake\s+|app\s+)?(?:clock|time)`;

function time(raw: string, q: string[]): string {
  const v = literal(raw, q).trim();
  // Validate now, so a typo fails at parse time (variables are checked when the step runs).
  if (!/\$\{/.test(v)) parseClockTime(v, { timeZone: 'UTC' });
  return v;
}

function duration(raw: string, q: string[]): string {
  const v = literal(raw, q).trim();
  if (!/\$\{/.test(v)) parseClockDuration(v);
  return v;
}

const clock = (c: string, extra: Record<string, string> = {}): StepBody => ({ action: 'browser', args: { op: 'clock', clock: c, ...extra } });

const R = (r: Omit<IntentRule, 'category'>): IntentRule => ({ ...r, category: 'Clock' });

export const CLOCK_RULES: IntentRule[] = [
  R({ name: 'clock-set', keywords: ['set', 'change', 'move'], example: 'Set the clock to 2027-03-15 09:00',
    re: new RegExp(String.raw`^(?:set|change|move|jump)\s+${CLOCK}\s+to\s+${TIME}$`, 'i'),
    build: (m, q) => clock('set', { time: time(m[1], q) }) }),
  R({ name: 'clock-install', keywords: ['install', 'use', 'start'], example: 'Install a fake clock at 2027-03-15 09:00',
    re: new RegExp(String.raw`^(?:install|use|start)\s+(?:a\s+|the\s+)?fake\s+(?:clock|time|timers)(?:\s+(?:at|from)\s+${TIME})?$`, 'i'),
    build: (m, q) => clock('install', m[1] ? { time: time(m[1], q) } : {}) }),
  R({ name: 'clock-fixed', keywords: ['freeze', 'fix'], example: 'Freeze the clock at "2026-12-31 23:59"',
    re: new RegExp(String.raw`^(?:freeze|fix)\s+(?:the\s+)?(?:browser\s+)?(?:clock|time|date)\s+(?:at|to|on)\s+${TIME}$`, 'i'),
    build: (m, q) => clock('fixed', { time: time(m[1], q) }) }),
  R({ name: 'clock-pause-at', keywords: ['pause', 'stop'], example: 'Pause the clock at 2027-01-01 08:00',
    re: new RegExp(String.raw`^(?:pause|stop|halt)\s+${CLOCK}\s+at\s+${TIME}$`, 'i'),
    build: (m, q) => clock('pauseAt', { time: time(m[1], q) }) }),
  R({ name: 'clock-pause', keywords: ['pause', 'stop', 'freeze'], example: 'Pause the clock',
    re: new RegExp(String.raw`^(?:pause|stop|halt|freeze)\s+${CLOCK}$`, 'i'),
    build: () => clock('pause') }),
  R({ name: 'clock-resume', keywords: ['resume', 'unpause', 'restart'], example: 'Resume the clock',
    re: new RegExp(String.raw`^(?:resume|unpause|restart|let)\s+${CLOCK}(?:\s+(?:run|flow|tick))?$`, 'i'),
    build: () => clock('resume') }),
  R({ name: 'clock-fast-forward', keywords: ['advance', 'fast-forward', 'move', 'skip'], example: 'Advance the clock by 2 hours',
    re: new RegExp(String.raw`^(?:advance|fast[-\s]?forward|move|skip|jump|wind)\s+${CLOCK}\s+(?:forward\s+|ahead\s+|on\s+)?(?:by\s+)?${DURATION}$|^(?:fast[-\s]?forward|skip|jump)\s+(?:ahead\s+|forward\s+)?(?:by\s+)?${DURATION}$`, 'i'),
    build: (m, q) => clock('fastForward', { duration: duration(m[1] ?? m[2], q) }) }),
  R({ name: 'clock-run-for', keywords: ['run', 'tick', 'let'], example: 'Run the clock for 30 minutes',
    re: new RegExp(String.raw`^(?:run|tick|let)\s+(?:the\s+)?(?:clock|timers|time)\s+(?:run\s+)?(?:for|by)\s+${DURATION}$|^let\s+${DURATION}\s+pass$`, 'i'),
    build: (m, q) => clock('runFor', { duration: duration(m[1] ?? m[2], q) }) }),
  R({ name: 'clock-run-all', keywords: ['run', 'flush', 'fire'], example: 'Run all timers',
    re: /^(?:run|flush|fire)\s+(?:all\s+(?:the\s+)?)?(?:pending\s+)?timers$/i,
    build: () => clock('runAll') }),
  R({ name: 'clock-run-to-last', keywords: ['run'], example: 'Run timers to the last one',
    re: /^run\s+(?:the\s+)?(?:pending\s+)?timers\s+(?:up\s+)?to\s+the\s+last(?:\s+one)?$|^run\s+to\s+the\s+last\s+timer$/i,
    build: () => clock('runToLast') }),
  R({ name: 'clock-real', keywords: ['use', 'restore', 'reset'], example: 'Use the real clock',
    re: /^(?:use|restore|reset\s+to|go\s+back\s+to|return\s+to)\s+(?:the\s+)?real\s+(?:clock|time)$/i,
    build: () => clock('real') }),
];

/** Render a clock step back to its canonical phrase (undefined for other steps). */
export function clockStepToText(s: Step): string | undefined {
  const a = s.args ?? {};
  if (s.action !== 'browser' || a.op !== 'clock') return undefined;
  const t = typeof a.time === 'string' ? (/^[\d-]+(?:[T ][\d:.]+)?(?:Z)?$/.test(a.time) ? a.time : quoteText(a.time)) : '';
  const d = typeof a.duration === 'string' ? (/^[\w :.,]+$/.test(a.duration) ? a.duration : quoteText(a.duration)) : '';
  switch (a.clock) {
    case 'set': return `Set the clock to ${t}`;
    case 'install': return t ? `Install a fake clock at ${t}` : 'Install a fake clock';
    case 'fixed': return `Freeze the clock at ${t}`;
    case 'pauseAt': return `Pause the clock at ${t}`;
    case 'pause': return 'Pause the clock';
    case 'resume': return 'Resume the clock';
    case 'fastForward': return `Advance the clock by ${d}`;
    case 'runFor': return `Run the clock for ${d}`;
    case 'runAll': return 'Run all timers';
    case 'runToLast': return 'Run timers to the last one';
    case 'real': return 'Use the real clock';
    default: return undefined;
  }
}
