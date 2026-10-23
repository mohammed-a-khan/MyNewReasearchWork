/**
 * parseIntent: one plain-English line -> one Journey step, deterministically.
 */
import { EzTestError, slugify, type StepInput } from '../core/index.js';
import { protectQuotes, restoreQuotes } from './quotes.js';
import { INTENT_RULES, parseDuration, type IntentRule } from './rules.js';
import { ADVANCED_RULES, setInnerParser } from './rules-advanced.js';
import { DESKTOP_RULES } from './rules-desktop.js';
import { MOBILE_RULES } from './rules-mobile.js';
import { COMPONENT_RULES } from './rules-components.js';

/** Rules contributed by add-ons (e.g. the Dynamics 365 adapter); checked before the built-in rules. */
const PLUGIN_RULES: IntentRule[] = [];

/**
 * Extend the plain-English grammar. Plugin rules are tried before built-in
 * rules, in registration order. Registering a rule name twice replaces it.
 * Returns a function that removes the rules again.
 */
export function registerIntentRules(rules: IntentRule[]): () => void {
  const replaced: Array<{ rule: IntentRule; index: number }> = [];
  for (const r of rules) {
    const i = PLUGIN_RULES.findIndex((x) => x.name === r.name);
    if (i >= 0) replaced.push({ rule: PLUGIN_RULES.splice(i, 1)[0], index: i });
    PLUGIN_RULES.push(r);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const r of rules) {
      const i = PLUGIN_RULES.indexOf(r);
      if (i >= 0) PLUGIN_RULES.splice(i, 1);
    }
    // Restore rules this registration replaced, so nested registrations unwind cleanly.
    for (const { rule, index } of replaced.reverse()) PLUGIN_RULES.splice(Math.min(index, PLUGIN_RULES.length), 0, rule);
  };
}

function allRules(): IntentRule[] {
  return PLUGIN_RULES.length ? [...PLUGIN_RULES, ...INTENT_RULES] : INTENT_RULES;
}

/** Thrown for a line the grammar cannot understand; carries line number and suggestions. */
export class IntentParseError extends EzTestError {
  constructor(
    message: string,
    readonly line: string,
    readonly lineNumber: number | undefined,
    readonly suggestions: string[],
  ) {
    super(message, 'INTENT_PARSE', { line, lineNumber, suggestions });
    this.name = 'IntentParseError';
  }
}

export interface ParseIntentOptions {
  /** Step id; defaults to a slug of the line. */
  id?: string;
  /** 1-based line number, used in error messages. */
  lineNumber?: number;
  /** Only try add-on (plugin) rules; used to let add-on "Expect ..." phrasings become steps. */
  pluginsOnly?: boolean;
}

/** True when an add-on rule claims this line (e.g. "Expect D365 field ..."). */
export function matchesPluginRule(line: string): boolean {
  if (!PLUGIN_RULES.length) return false;
  try {
    parseIntent(line, { pluginsOnly: true });
    return true;
  } catch {
    return false;
  }
}

/** Trailing annotations: `[id=login optional timeout=5s risk=4]`. */
export interface StepAnnotations {
  id?: string;
  optional?: boolean;
  timeoutMs?: number;
  risk?: number;
  /** Soft assertion: record the failure and continue. */
  soft?: boolean;
  /** Re-run the step until its post-conditions hold, up to this many times. */
  retry?: number;
  /** Imported line not yet replayed by `eztest import --verify` (informational; no effect on the step). */
  unverified?: boolean;
  /** Pause between retries. */
  everyMs?: number;
}

const THIRD_PERSON: Record<string, string> = {
  clicks: 'click', taps: 'tap', types: 'type', enters: 'enter', opens: 'open', goes: 'go', navigates: 'navigate',
  visits: 'visit', selects: 'select', chooses: 'choose', checks: 'check', unchecks: 'uncheck', presses: 'press',
  hovers: 'hover', uploads: 'upload', downloads: 'download', waits: 'wait', captures: 'capture', logs: 'log',
  signs: 'sign', fills: 'fill', clears: 'clear', verifies: 'verify', expects: 'expect', calls: 'call',
  runs: 'run', remembers: 'remember', stores: 'store', saves: 'save', sends: 'send', compares: 'compare',
  uses: 'use', sets: 'set', picks: 'pick', submits: 'submit', follows: 'follow', double_clicks: 'double-click',
  switches: 'switch', closes: 'close', accepts: 'accept', dismisses: 'dismiss', answers: 'answer', drags: 'drag', drops: 'drop',
  scrolls: 'scroll', swipes: 'swipe', focuses: 'focus', triggers: 'trigger', mocks: 'mock', blocks: 'block', repeats: 'repeat',
  holds: 'hold', releases: 'release', grants: 'grant', emulates: 'emulate', extracts: 'extract', counts: 'count', connects: 'connect',
};

// Single-line blocks ("Repeat 3 times: press Tab") parse their inner step with this same parser.
setInnerParser((line) => parseIntent(line));

export function splitAnnotations(text: string): { text: string; ann: StepAnnotations } {
  const m = /\s*\[((?:\s*(?:id\s*=\s*[\w.-]+|optional|soft|unverified|timeout\s*=\s*\d+(?:\.\d+)?\s*(?:ms|s|m)?|risk\s*=\s*[1-5]|retry\s*=\s*\d+|every\s*=\s*\d+(?:\.\d+)?\s*(?:ms|s|m)?)\s*)+)\]\s*$/i.exec(text);
  if (!m) return { text, ann: {} };
  const ann: StepAnnotations = {};
  for (const tok of m[1].trim().split(/\s+(?=id\s*=|optional|soft|unverified|timeout\s*=|risk\s*=|retry\s*=|every\s*=)/i)) {
    let t: RegExpExecArray | null;
    if ((t = /^id\s*=\s*([\w.-]+)$/i.exec(tok))) ann.id = t[1];
    else if (/^optional$/i.test(tok)) ann.optional = true;
    else if (/^soft$/i.test(tok)) ann.soft = true;
    else if (/^unverified$/i.test(tok)) ann.unverified = true;
    else if ((t = /^timeout\s*=\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(tok))) ann.timeoutMs = parseDuration(t[1], t[2] ?? 'ms');
    else if ((t = /^risk\s*=\s*([1-5])$/i.exec(tok))) ann.risk = Number(t[1]);
    else if ((t = /^retry\s*=\s*(\d+)$/i.exec(tok))) ann.retry = Number(t[1]);
    else if ((t = /^every\s*=\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(tok))) ann.everyMs = parseDuration(t[1], t[2] ?? 'ms');
  }
  return { text: text.slice(0, m.index), ann };
}

/** Strip leading conjunctions/subjects ("And then I clicks ..." -> "click ..."). */
function normaliseLead(text: string): string {
  let t = text.trim().replace(/[.;]+$/, '').trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(/^(?:and|then|when|given|but|also|next|finally|first)\s*,?\s+/i, '');
    t = t.replace(/^(?:i|we|the\s+user|user|they)\s+(?!should\b|must\b)/i, '');
    if (t === before) break;
  }
  const first = /^(\S+)/.exec(t)?.[1];
  if (first) {
    const base = THIRD_PERSON[first.toLowerCase().replace(/-/g, '_')];
    if (base) t = base + t.slice(first.length);
  }
  return t.replace(/\s+/g, ' ');
}

/** Deterministically parse one plain-English line into a Journey step. */
export function parseIntent(line: string, opts: ParseIntentOptions = {}): StepInput {
  const original = line.trim();
  if (!original) throw new IntentParseError('Empty step line', line, opts.lineNumber, []);
  const { text: protectedText, quotes } = protectQuotes(original);
  const { text: body, ann } = splitAnnotations(protectedText);
  const intent = restoreQuotes(body.trim(), quotes).replace(/\s+/g, ' ').trim();
  const normalised = normaliseLead(body);
  // Rules marked raw (verbatim code tails, e.g. "Run JavaScript: ...") see the line without quote protection.
  const rawNormalised = normaliseLead(splitAnnotations(original).text);
  const errors: string[] = [];
  for (const rule of opts.pluginsOnly ? PLUGIN_RULES : allRules()) {
    const m = rule.re.exec(rule.raw ? rawNormalised : normalised);
    if (!m) continue;
    try {
      const built = rule.build(m, rule.raw ? [] : quotes);
      if (!built) continue;
      const step: StepInput = {
        id: opts.id ?? ann.id ?? defaultStepId(intent),
        intent,
        ...built,
      };
      if (ann.optional) step.optional = true;
      if (ann.timeoutMs) step.timeoutMs = ann.timeoutMs;
      if (ann.risk) step.risk = ann.risk;
      if (ann.soft) step.soft = true;
      if (ann.retry || ann.everyMs) step.poll = { ...(step.poll ?? {}), ...(ann.retry ? { attempts: ann.retry } : {}), ...(ann.everyMs !== undefined ? { intervalMs: ann.everyMs } : {}) };
      return step;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) {
        const where = opts.lineNumber !== undefined ? `line ${opts.lineNumber}: ` : '';
        throw new IntentParseError(`${where}${(e as Error).message}`, original, opts.lineNumber, [rule.example]);
      }
      errors.push(`${rule.name}: ${(e as Error).message}`);
    }
  }
  const suggestions = suggest(normalised);
  const where = opts.lineNumber !== undefined ? `line ${opts.lineNumber}: ` : '';
  const detail = errors.length ? ` (${errors.join('; ')})` : '';
  throw new IntentParseError(
    `${where}cannot understand "${intent}"${detail}.` +
      (suggestions.length ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?` : ''),
    original,
    opts.lineNumber,
    suggestions,
  );
}

/** The grammar rule that parses `line` (the same first-match order as parseIntent), or undefined. */
export function matchedRule(line: string): IntentRule | undefined {
  const original = line.trim();
  const { text: protectedText, quotes } = protectQuotes(original);
  const normalised = normaliseLead(splitAnnotations(protectedText).text);
  const rawNormalised = normaliseLead(splitAnnotations(original).text);
  for (const rule of allRules()) {
    const m = rule.re.exec(rule.raw ? rawNormalised : normalised);
    if (!m) continue;
    try {
      if (rule.build(m, rule.raw ? [] : quotes)) return rule;
    } catch {
      // try the next rule, as parseIntent does
    }
  }
  return undefined;
}

/** Default step id: a slug of the intent (stable across inserted lines). */
export function defaultStepId(intent: string): string {
  return slugify(intent).slice(0, 60).replace(/-+$/, '') || 'step';
}

function levenshtein(a: string, b: string): number {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** Closest rules by leading keyword (exact keyword first, then edit distance <= 2). */
export function suggest(line: string, max = 3): string[] {
  const first = (/^([\w-]+)/.exec(line)?.[1] ?? '').toLowerCase();
  if (!first) return allRules().slice(0, max).map((r) => r.example);
  const scored: Array<{ rule: IntentRule; d: number }> = [];
  // Core phrasings are suggested before advanced and component ones when equally close;
  // desktop/legacy and mobile phrasings (the most specialised) come last.
  const late = new Set([...ADVANCED_RULES, ...COMPONENT_RULES, ...DESKTOP_RULES, ...MOBILE_RULES]);
  const ordered = [...allRules().filter((r) => !late.has(r)), ...ADVANCED_RULES, ...COMPONENT_RULES, ...DESKTOP_RULES, ...MOBILE_RULES];
  for (const rule of ordered) {
    const d = Math.min(...rule.keywords.map((k) => levenshtein(first, k.toLowerCase())));
    if (d <= 2) scored.push({ rule, d });
  }
  scored.sort((a, b) => a.d - b.d);
  const out: string[] = [];
  for (const s of scored) if (!out.includes(s.rule.example)) out.push(s.rule.example);
  return out.slice(0, max);
}
