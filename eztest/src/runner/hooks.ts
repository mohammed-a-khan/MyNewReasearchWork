/**
 * Step hooks: an opt-in observation seam inside step execution, used by the
 * time-travel trace and the live debugger. Hooks are registered per Page (one
 * journey attempt owns one page), so concurrent journeys never share them and
 * a run without trace/debug pays one WeakMap lookup per step.
 */
import type { Locator, Page } from '../browser/index.js';
import type { ConditionResult, LocatorCandidate } from '../core/index.js';
import type { HealCandidate } from '../heal/types.js';
import type { Resolution } from './locate.js';

export interface StepHooks {
  /** Target resolution finished (successfully or not). */
  located?(res: Resolution): void;
  /** About to perform the action (`loc` is the resolved or healed target). May pause. */
  beforeAct?(loc: Locator | undefined, info: { healing: boolean }): Promise<void>;
  afterAct?(error?: Error): void;
  /** About to evaluate post-conditions. May pause (debugger "step into"). */
  beforeVerify?(): Promise<void>;
  afterVerify?(results: ConditionResult[]): void;
  /** Strict resolution failed and the heal ladder is about to run. May pause. */
  beforeHeal?(failure: string): Promise<void>;
  /** A heal candidate was proposed and counted on the page. */
  healCandidate?(c: HealCandidate & { resolved: LocatorCandidate; matches: number }): void;
  /** A heal tier explained why it produced nothing. */
  healNote?(message: string): void;
}

const registry = new WeakMap<Page, StepHooks>();

export function setStepHooks(page: Page, hooks: StepHooks): void {
  registry.set(page, hooks);
}

export function clearStepHooks(page: Page): void {
  registry.delete(page);
}

/** Hooks for the page a step runs on, if trace/debug is active. */
export function stepHooksFor(page: Page): StepHooks | undefined {
  return registry.get(page);
}
