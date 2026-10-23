/**
 * Non-browser surfaces (desktop apps, terminals, SAP GUI, screen images):
 * the hook through which they take over steps and conditions while active.
 *
 * - `RunOptions.stepInterceptors` see every leaf step first; an interceptor
 *   that returns an outcome has executed the step (the browser runner does not).
 * - A surface made active for a journey attempt (keyed by its BrowserSession)
 *   evaluates conditions it understands ("the screen contains ...", element
 *   text, values); everything else falls through to the browser evaluator.
 */
import type { Condition, ConditionResult, Step, StepResult } from '../core/index.js';
import type { FingerprintStore } from '../heal/store.js';
import type { ConditionEnv } from './conditions.js';
import type { RunOptions, StepContext } from './types.js';

/** A step result without the fields the runner fills in. */
export type InterceptedStep = Omit<StepResult, 'stepId' | 'intent' | 'startedAt' | 'durationMs' | 'evidence'> & { evidence: string[] };

export interface InterceptorRuntime {
  opts: RunOptions;
  store: FingerprintStore;
  stepTimeoutMs: number;
  conditionTimeoutMs: number;
}

export interface StepInterceptor {
  name: string;
  /** Execute the step, or return undefined to leave it to the browser runner. */
  execute(step: Step, ctx: StepContext, rt: InterceptorRuntime): Promise<InterceptedStep | undefined>;
}

/** A surface that evaluates conditions while it is the journey's active surface. */
export interface ConditionSurface {
  readonly kind: string;
  /** Evaluate once, or return undefined when the condition is not about this surface. */
  evaluate(c: Condition, env: ConditionEnv): Promise<ConditionResult | undefined>;
}

const active = new WeakMap<object, ConditionSurface>();

/** Make `surface` the active surface of a journey attempt (owner: its BrowserSession), or clear it. */
export function setActiveSurface(owner: object, surface: ConditionSurface | undefined): void {
  if (surface) active.set(owner, surface);
  else active.delete(owner);
}

export function activeSurface(owner: object | undefined): ConditionSurface | undefined {
  return owner ? active.get(owner) : undefined;
}
