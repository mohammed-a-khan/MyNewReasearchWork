/**
 * Walking nested steps and step results. Blocks (if/loops/try/frame blocks,
 * sub-journeys) keep their children in `steps`/`else`/`catch` and results in
 * `children`; these helpers give consumers a flat view when they need one.
 */
import type { Step } from './journey.js';
import type { StepResult } from './results.js';

/** Action types whose step holds child steps and is executed by the flow engine. */
export const BLOCK_ACTIONS: ReadonlySet<string> = new Set(['if', 'repeat', 'forEach', 'while', 'retry', 'try', 'group', 'frame', 'actor', 'parallel', 'transaction']);

/** True when a step is a block (has children, or is a block action that needs them). */
export function isBlockStep(step: Pick<Step, 'action' | 'steps'>): boolean {
  return step.steps !== undefined && BLOCK_ACTIONS.has(step.action);
}

/** Every step, depth first (a block before its children: then, else, catch). */
export function flattenSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  const walk = (list: Step[] | undefined) => {
    for (const s of list ?? []) {
      out.push(s);
      walk(s.steps);
      walk(s.else);
      walk(s.catch);
    }
  };
  walk(steps);
  return out;
}

/** Every step result, depth first, with its nesting depth (top level = 0). */
export function flattenStepResults(results: StepResult[]): Array<{ result: StepResult; depth: number }> {
  const out: Array<{ result: StepResult; depth: number }> = [];
  const walk = (list: StepResult[] | undefined, depth: number) => {
    for (const r of list ?? []) {
      out.push({ result: r, depth });
      walk(r.children, depth + 1);
    }
  };
  walk(results, 0);
  return out;
}
