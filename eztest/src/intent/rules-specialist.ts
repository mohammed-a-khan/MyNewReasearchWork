/**
 * Phrasings for the specialist features: phone calls (voice verification),
 * single-story component checks and API security scans. Kept in one file so
 * the shared grammar only spreads SPECIALIST_RULES and asks
 * isSpecialistExpectation() which "Expect ..." lines are steps of their own.
 */
import { protectQuotes } from './quotes.js';
import type { IntentRule } from './rules.js';

const Q = '(⟦\\d+⟧)';
const KEY = '([A-Za-z_][\\w]*)';
const DUR = '(\\d+(?:\\.\\d+)?)\\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)';
const NUM = `(${Q}|\\+?[\\d][\\d\\s().-]*\\d)`;
const VAR = '(\\$\\{[\\w.]+\\}|[A-Za-z_]\\w*)';

const V = (s: string | undefined, q: string[]): string => {
  if (s === undefined) return '';
  const m = /^⟦(\d+)⟧$/.exec(s.trim());
  return m ? q[Number(m[1])] : s.trim();
};
const ms = (n: string, u: string) => (/^ms|milli/i.test(u) ? Number(n) : /^m(?:in)?/i.test(u) ? Number(n) * 60_000 : Number(n) * 1000);
const strip = (v: string) => (v.startsWith('${') ? v.slice(2, -1) : v);
const quotedList = (s: string, q: string[]) => [...s.matchAll(/⟦(\d+)⟧/g)].map((m) => q[Number(m[1])]);

function cat(category: string, rules: IntentRule[]): IntentRule[] {
  return rules.map((r) => ({ ...r, category }));
}

export const VOICE_RULES: IntentRule[] = cat('Phone calls', [
  { name: 'voice-place-call', keywords: ['place', 'call', 'make', 'dial'], example: 'Place a call to "+15550100" and press "1w2" as call',
    re: new RegExp(String.raw`^(?:place|make|start|dial)\s+(?:a\s+)?(?:phone\s+)?call\s+to\s+${NUM}(?:\s+from\s+${NUM})?(?:\s+saying\s+${Q})?(?:\s+(?:and\s+)?(?:press(?:ing)?|send(?:ing)?|dial(?:ling)?)\s+(?:the\s+)?(?:digits\s+)?${Q})?(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?(?:\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => ({
      action: 'voice',
      args: { op: 'place', to: V(m[1], q), ...(m[3] ? { from: V(m[3], q) } : {}), ...(m[5] ? { say: V(m[5], q) } : {}), ...(m[6] ? { digits: V(m[6], q) } : {}), ...(m[7] ? { timeoutMs: ms(m[7], m[8]) } : {}) },
      captureAs: m[9] ?? 'call',
    }) },
  { name: 'voice-wait-call', keywords: ['wait', 'call', 'receive'], example: 'Wait for a call to "+15550100" and capture the spoken code as otp',
    re: new RegExp(String.raw`^(?:wait\s+for|receive|answer|get)\s+(?:a|an|the\s+next|the\s+latest|an\s+incoming)\s+(?:incoming\s+)?(?:phone\s+)?call(?:\s+(?:to|on)\s+${NUM})?(?:\s+from\s+${NUM})?(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?(?:\s+and\s+capture\s+the\s+(?:(\d+)-digit\s+)?(?:spoken\s+)?(?:code|otp)\s+as\s+${KEY})?(?:\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => ({
      action: 'voice',
      args: { op: 'wait', ...(m[1] ? { to: V(m[1], q) } : {}), ...(m[3] ? { from: V(m[3], q) } : {}), ...(m[5] ? { timeoutMs: ms(m[5], m[6]) } : {}), ...(m[8] ? { codeAs: m[8], ...(m[7] ? { codeDigits: Number(m[7]) } : {}) } : {}) },
      captureAs: m[9] ?? 'call',
    }) },
  { name: 'voice-expect-said', keywords: ['expect', 'call', 'say', 'prompt'], example: 'Expect the call call to say "Press 1 for billing" then "Press 2 for support"',
    re: new RegExp(String.raw`^(?:expect|verify|check|assert)\s+(?:that\s+)?(?:the\s+)?(?:phone\s+)?call\s+${VAR}\s+(?:to\s+)?(?:say|said|says|prompt|prompts|prompted|play|plays|played|contain|contains)(?:\s+(?:the\s+)?(?:prompts?|text))?\s+(${Q}(?:\s*(?:,|then|and|,\s*then)\s*${Q})*)$`, 'i'),
    build: (m, q) => ({ action: 'voice', args: { op: 'expectSaid', call: strip(m[1]), texts: quotedList(m[2], q), ordered: /\bthen\b/i.test(m[2]) } }) },
  { name: 'voice-expect-digits', keywords: ['expect', 'call', 'digits', 'dtmf'], example: 'Expect the call call to have sent the digits "1w2"',
    re: new RegExp(String.raw`^(?:expect|verify|check|assert)\s+(?:that\s+)?(?:the\s+)?(?:phone\s+)?call\s+${VAR}\s+(?:to\s+have\s+|has\s+)?(?:sent|received|pressed|dialled|dialed)\s+(?:the\s+)?(?:dtmf\s+)?(?:digits|tones|keys)\s+${Q}$`, 'i'),
    build: (m, q) => ({ action: 'voice', args: { op: 'expectDigits', call: strip(m[1]), digits: V(m[2], q) } }) },
]);

/** All specialist rules, in the order they are tried. */
export const SPECIALIST_RULES: IntentRule[] = [...VOICE_RULES];

const STEP_EXPECTATIONS = new Set(['voice-expect-said', 'voice-expect-digits']);

/** "Expect ..." lines that are steps of their own (not post-conditions of the step before). */
export function isSpecialistExpectation(line: string): boolean {
  const { text } = protectQuotes(line.trim().replace(/[.;]+$/, '').replace(/^(?:and|then|also)\s+/i, ''));
  return SPECIALIST_RULES.some((r) => STEP_EXPECTATIONS.has(r.name) && r.re.test(text));
}
