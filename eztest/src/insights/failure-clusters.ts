/**
 * Failure clustering across runs. The same root cause fails different
 * journeys in different runs with different ids, numbers, URLs and timings in
 * the message; normalized signatures (see signature.ts) put them together so a
 * team sees "one problem, 37 failures in 9 runs since Tuesday" instead of 37
 * separate failures.
 */
import type { RunResult } from '../core/index.js';
import { clusterFailures, type ClusterItem } from './signature.js';
import { failingStep } from './triage.js';

export interface CrossRunCluster {
  id: string;
  signature: string;
  /** Normalized message of the representative failure. */
  normalized: string;
  representative: { runId: string; journeyId: string; message: string };
  failures: number;
  runs: string[];
  journeys: string[];
  firstSeen: string;
  lastSeen: string;
  cohesion: number;
}

/** Cluster every failed journey of several runs. Most frequent first. */
export function clusterAcrossRuns(runs: Array<Pick<RunResult, 'runId' | 'startedAt' | 'journeys'>>, o: { threshold?: number } = {}): CrossRunCluster[] {
  const items: Array<ClusterItem & { runId: string; journeyId: string; at: string }> = [];
  for (const r of runs) {
    for (const j of r.journeys) {
      if (j.status !== 'failed' && j.status !== 'error') continue;
      const err = failingStep(j)?.error ?? j.error;
      if (!err?.message) continue;
      items.push({ id: `${r.runId}/${j.journeyId}`, message: err.message, stack: err.stack, name: err.name, runId: r.runId, journeyId: j.journeyId, at: r.startedAt });
    }
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  return clusterFailures(items, { threshold: o.threshold })
    .map((c) => {
      const members = c.members.map((m) => byId.get(m)!);
      const times = members.map((m) => m.at).sort();
      const rep = byId.get(c.representative.id)!;
      return {
        id: c.id, signature: c.signature, normalized: c.normalized,
        representative: { runId: rep.runId, journeyId: rep.journeyId, message: rep.message },
        failures: members.length,
        runs: [...new Set(members.map((m) => m.runId))],
        journeys: [...new Set(members.map((m) => m.journeyId))].sort(),
        firstSeen: times[0], lastSeen: times[times.length - 1], cohesion: c.cohesion,
      };
    })
    .sort((a, b) => b.failures - a.failures || b.lastSeen.localeCompare(a.lastSeen));
}
