/**
 * Cross-journey dependencies (`Depends on: <journey> [with key, ...]`).
 * Field suites share state between features implicitly (a scenario relies on
 * data an earlier feature created and "recovers" it from the database). Here
 * the dependency is explicit: the runner orders prerequisites first, hands
 * over the named ledger values, and when a prerequisite did not pass, skips
 * the dependent with the reason instead of letting it fail on missing state.
 */
import type { Journey, JourneyResult } from '../../core/index.js';

export interface DependencyPlan {
  /** Prerequisite indices of each journey (same order as the input). */
  prereqs: number[][];
  /** Journeys that cannot run: unknown prerequisite or a cycle. */
  errors: Map<number, string>;
}

function findIndex(journeys: Journey[], ref: string): number[] {
  const exact = journeys.flatMap((j, i) => (j.id === ref || j.name === ref ? [i] : []));
  if (exact.length) return exact;
  // A data-driven prerequisite expands into one journey per Examples row (id-1, id-2, ...): all of them.
  return journeys.flatMap((j, i) => (j.id.startsWith(`${ref}-`) && j.examples === undefined ? [i] : []));
}

/** Resolve `dependsOn` references and reject unknown prerequisites and cycles. */
export function planDependencies(journeys: Journey[]): DependencyPlan {
  const prereqs = journeys.map(() => [] as number[]);
  const errors = new Map<number, string>();
  journeys.forEach((j, i) => {
    for (const d of j.dependsOn ?? []) {
      const hits = findIndex(journeys, d.journey).filter((x) => x !== i);
      if (!hits.length) {
        errors.set(i, `not run: depends on "${d.journey}", which is not part of this run (select it too)`);
        continue;
      }
      prereqs[i].push(...hits);
    }
  });
  // Cycle detection (DFS, colours).
  const colour = new Array<number>(journeys.length).fill(0);
  const stack: number[] = [];
  const visit = (i: number): void => {
    colour[i] = 1;
    stack.push(i);
    for (const p of prereqs[i]) {
      if (colour[p] === 1) {
        const cycle = stack.slice(stack.indexOf(p));
        const names = [...cycle, p].map((x) => journeys[x].id).join(' -> ');
        for (const c of cycle) errors.set(c, `not run: circular dependency ${names}`);
      } else if (colour[p] === 0) visit(p);
    }
    stack.pop();
    colour[i] = 2;
  };
  journeys.forEach((_, i) => colour[i] === 0 && visit(i));
  return { prereqs, errors };
}

const passed = (r: JourneyResult) => r.status === 'passed' || r.status === 'passed-healed';

export interface Handoff {
  /** Values for the dependent's ledger. */
  seed: Record<string, unknown>;
  /** Why the dependent must not run (a prerequisite did not pass or did not produce a value). */
  blocked?: string;
  summary: Array<{ journeyId: string; status: string; handoff: string[] }>;
}

/** The ledger handoff for a dependent once its prerequisites finished. */
export function handoffFor(dependent: Journey, prereqs: Array<{ journey: Journey; result: JourneyResult }>): Handoff {
  const seed: Record<string, unknown> = {};
  const summary: Handoff['summary'] = [];
  for (const d of dependent.dependsOn ?? []) {
    const mine = prereqs.filter((p) => p.journey.id === d.journey || p.journey.name === d.journey || p.journey.id.startsWith(`${d.journey}-`));
    for (const { journey, result } of mine) {
      if (!passed(result)) {
        return { seed, summary, blocked: `not run: depends on "${journey.id}", which ${result.status === 'skipped' ? 'did not run' : result.status}${result.error?.message ? ` (${result.error.message.split('\n')[0].slice(0, 120)})` : ''}` };
      }
      const keys = d.take.length ? d.take : (journey.returns ?? []);
      for (const k of keys) {
        if (!(k in result.ledger)) return { seed, summary, blocked: `not run: prerequisite "${journey.id}" passed but did not produce "${k}"` };
        seed[k] = result.ledger[k];
      }
      summary.push({ journeyId: journey.id, status: result.status, handoff: keys });
    }
  }
  return { seed, summary };
}
