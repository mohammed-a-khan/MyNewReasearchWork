/**
 * Watch mode support: which journeys to re-run when a journey file changes -
 * the journey itself and, transitively, every journey that calls it with
 * `Run journey` (by id, name or file name).
 */
import { basename, extname } from 'node:path';
import { flattenSteps, type Journey } from '../core/index.js';

export function callees(j: Journey): string[] {
  return flattenSteps(j.steps).filter((s) => s.action === 'runJourney' && typeof s.value === 'string').map((s) => String(s.value));
}

/** Journey ids to re-run when `changed` (ids) changed: those journeys plus their callers, transitively. */
export function affectedJourneys(changed: Journey[], all: Journey[], files: Map<string, string> = new Map()): string[] {
  const refsOf = (j: Journey) => {
    const f = files.get(j.id);
    return new Set([j.id, j.name, ...(f ? [basename(f), basename(f, extname(f))] : [])].map((x) => x.toLowerCase()));
  };
  const out = new Set(changed.map((j) => j.id));
  let frontier = [...changed];
  while (frontier.length) {
    const next: Journey[] = [];
    for (const c of frontier) {
      const refs = refsOf(c);
      for (const j of all) {
        if (out.has(j.id)) continue;
        if (callees(j).some((r) => refs.has(r.toLowerCase()) || refs.has(basename(r, extname(r)).toLowerCase()))) {
          out.add(j.id);
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return [...out];
}
