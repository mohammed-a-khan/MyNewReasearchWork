/**
 * Helpers shared by the SDK surfaces: building runner steps from SDK calls.
 */
import type { Condition, StepInput, StepResult, StepSource, Target } from '../core/index.js';
import { parseCondition } from '../intent/conditions.js';
import { callSite } from './callsite.js';
import { frame, type ExecOptions } from './runtime.js';
import { toTarget, type TargetInput } from './screen.js';

/**
 * Values coming from code are literal: a `${...}` inside them must not be
 * interpolated by the runner. `$${x}` is the runner's escape for `${x}`.
 */
export function literal(s: string): string {
  return s.replace(/\$\{/g, () => '$${');
}

/** Escape every string in a JSON-like value (targets, conditions, API bodies). */
export function literalDeep<T>(v: T): T {
  if (typeof v === 'string') return literal(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => literalDeep(x)) as unknown as T;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, literalDeep(x)])) as T;
  }
  return v;
}

export function target(t: TargetInput): Target {
  return literalDeep(toTarget(t));
}

/** Post-conditions written on a UI action: `{ expect: { visible: 'Invoice details' } }`. */
export interface ExpectSpecObject {
  /** An element (or text) that must be visible afterwards. */
  visible?: TargetInput;
  /** An element that must be hidden (or gone) afterwards. */
  hidden?: TargetInput;
  /** The URL contains this text. */
  url?: string;
  /** The URL matches this pattern (glob or /regex/). */
  urlMatches?: string;
  /** The page title contains this text. */
  title?: string;
  /** The page contains this text. */
  text?: string;
  /** The page does not contain this text. */
  notText?: string;
  /** [element, text]: the element's text contains the text. */
  textOf?: [TargetInput, string];
  /** [element, value]: the input's value equals the value. */
  value?: [TargetInput, string];
  /** [element, n]: exactly n elements match. */
  count?: [TargetInput, number];
}

/** A post-condition: an `.ez` Expect phrase ('the URL contains "/done"'), an object, or raw Conditions. */
export type ExpectSpec = string | ExpectSpecObject | Array<string | Condition>;

export function conditionsFrom(spec: ExpectSpec | undefined): Condition[] {
  if (spec === undefined) return [];
  if (typeof spec === 'string') return [parseCondition(spec)];
  if (Array.isArray(spec)) return spec.map((c) => (typeof c === 'string' ? parseCondition(c) : c));
  const out: Condition[] = [];
  if (spec.visible !== undefined) out.push({ type: 'visible', target: target(spec.visible) });
  if (spec.hidden !== undefined) out.push({ type: 'hidden', target: target(spec.hidden) });
  if (spec.url !== undefined) out.push({ type: 'urlContains', value: literal(spec.url) });
  if (spec.urlMatches !== undefined) out.push({ type: 'urlMatches', pattern: literal(spec.urlMatches) });
  if (spec.title !== undefined) out.push({ type: 'titleContains', value: literal(spec.title) });
  if (spec.text !== undefined) out.push({ type: 'pageContainsText', value: literal(spec.text) });
  if (spec.notText !== undefined) out.push({ type: 'pageNotContainsText', value: literal(spec.notText) });
  if (spec.textOf) out.push({ type: 'textContains', target: target(spec.textOf[0]), value: literal(spec.textOf[1]) });
  if (spec.value) out.push({ type: 'valueEquals', target: target(spec.value[0]), value: literal(spec.value[1]) });
  if (spec.count) out.push({ type: 'count', target: target(spec.count[0]), equals: spec.count[1] });
  return out;
}

/** Options every UI action accepts. */
export interface ActionOptions {
  /** Post-conditions: what must be true afterwards. They make healing verifiable. */
  expect?: ExpectSpec;
  /** Per-action timeout in ms. */
  timeoutMs?: number;
  /** A failure is recorded as skipped and the journey goes on. */
  optional?: boolean;
  /** Re-run the action until its post-conditions hold. */
  poll?: { attempts?: number; intervalMs?: number };
  /** Text for the report (default: generated from the call). */
  intent?: string;
}

/** Run a step through the host, adding the call site and the soft flag of the current frame. */
export async function run(step: Omit<StepInput, 'id'>, o: ActionOptions & { soft?: boolean; source?: StepSource } = {}): Promise<StepResult> {
  const f = frame(`${step.action}()`);
  const source = o.source ?? callSite();
  const full: Omit<StepInput, 'id'> = {
    ...step,
    ...(o.intent ? { intent: o.intent } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.poll ? { poll: o.poll } : {}),
    postconditions: [...(step.postconditions ?? []), ...conditionsFrom(o.expect)],
  };
  const eo: ExecOptions = { soft: o.soft ?? (f.soft || undefined), optional: o.optional, ...(source ? { source } : {}) };
  return f.host.exec(full, eo);
}

/** Short readable form of a value for step intents. */
export function show(v: unknown, max = 60): string {
  let s: string;
  if (typeof v === 'string') s = JSON.stringify(v);
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Readable form of a target for step intents. */
export function describe(t: TargetInput): string {
  try {
    return toTarget(t).description;
  } catch {
    return 'element';
  }
}

export function capturedValue(r: StepResult, key: string): unknown {
  return r.captured?.[key];
}

/** Unique ledger key for a capture made by the SDK. */
let seq = 0;
export function tempKey(prefix = 'sdk'): string {
  seq = (seq + 1) % 1_000_000;
  return `__${prefix}${seq}`;
}
