/**
 * Where each trace step sits in the journey's block structure. Trace steps
 * are leaf executions in order; nested ones (If branches, loop iterations,
 * Try/On failure, frame blocks, sub-journeys) have indices past the top-level
 * steps. The run's result tree (`StepResult.children`, `iteration`, `branch`)
 * gives the nesting: its leaves are matched to the trace steps in order by
 * step id.
 */
import type { TraceFile } from './model.js';

export interface Nest {
  depth: number;
  /** Enclosing block steps, outermost first. */
  blocks: string[];
  /** 1-based loop iteration / retry attempt of the innermost loop. */
  iteration?: number;
  branch?: string;
}

export interface ResultNode {
  stepId: string;
  intent: string;
  status?: string;
  children?: ResultNode[];
  iteration?: number;
  branch?: string;
}

interface Leaf extends Nest {
  stepId: string;
}

function leaves(nodes: ResultNode[], depth: number, blocks: string[], iteration: number | undefined, branch: string | undefined, out: Leaf[]): void {
  for (const n of nodes) {
    const it = n.iteration ?? iteration;
    const br = n.branch ?? branch;
    if (n.children?.length) leaves(n.children, depth + 1, [...blocks, n.intent], undefined, undefined, out);
    else out.push({ stepId: n.stepId, depth, blocks, ...(it !== undefined && depth > 0 ? { iteration: it } : {}), ...(br && depth > 0 ? { branch: br } : {}) });
  }
}

/** Nesting per trace step position (only steps inside blocks are listed). */
export function nestingOf(trace: TraceFile, results: ResultNode[] | undefined): Map<number, Nest> {
  const out = new Map<number, Nest>();
  if (!results?.length) return out;
  const all: Leaf[] = [];
  leaves(results, 0, [], undefined, undefined, all);
  let j = 0;
  let prev: { stepId: string; nest?: Nest } | undefined;
  trace.steps.forEach((s, pos) => {
    // A step re-run from the debugger (execution > 1) is the same leaf as the run before it.
    if (s.execution > 1 && prev?.stepId === s.stepId) {
      if (prev.nest) out.set(pos, prev.nest);
      return;
    }
    for (let k = j; k < Math.min(all.length, j + 500); k++) {
      if (all[k].stepId !== s.stepId) continue;
      const { stepId: _id, ...nest } = all[k];
      if (nest.depth > 0) out.set(pos, nest);
      prev = { stepId: s.stepId, nest: nest.depth > 0 ? nest : undefined };
      j = k + 1;
      return;
    }
  });
  return out;
}

/** "in Repeat 3 times › If … · iteration 2 · else branch" */
export function nestLabel(n: Nest): string {
  return [`in ${n.blocks.join(' › ')}`, n.iteration !== undefined ? `iteration ${n.iteration}` : '', n.branch && n.branch !== 'body' && n.branch !== 'then' ? `${n.branch} branch` : ''].filter(Boolean).join(' · ');
}
