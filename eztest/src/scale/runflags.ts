/**
 * Runner selection, ordering and burn-in (`eztest run` flags):
 *
 *   --last-failed          only the journeys that failed in the last recorded run
 *   --failed-first         previously failing journeys first, then by risk
 *   --shuffle [seed]       random but reproducible order (the seed is printed)
 *   --repeat-each N        run every selected journey N times (burn-in)
 *   --burn-in [N]          repeat only new or changed journeys N times (default 5)
 *   --max-failures N       cancel the run after N failed journeys (rest: skipped)
 *   --retry-strategy isolated   retry failures after the main pass, one at a time
 *   --fail-on-flaky        exit non-zero when a journey passed only on retry or was flaky in burn-in
 *
 * Repeated copies keep the journey's id for the first run and `<id>~rep<k>` for
 * the others, so the burn-in verdict groups them back.
 */
import { hashSeed, mulberry32 } from '../data/prng.js';
import type { Journey, JourneyStatus, RunResult } from '../core/index.js';
import type { RunHistoryEntry } from '../insights/index.js';
import { scoreFlakiness } from '../insights/flaky.js';
import { stripBrowser } from '../runner/browsers.js';

export const REPEAT_SEP = '~rep';

export function baseJourneyId(id: string): string {
  const i = id.indexOf(REPEAT_SEP);
  return i < 0 ? id : id.slice(0, i) + id.slice(i).replace(/^~rep\d+/, '');
}

/** Last recorded status of each journey (Examples rows and repeats fold into their journey: worst of that run wins). */
export function lastStatuses(runs: readonly RunHistoryEntry[], journeyIds: string[]): Map<string, JourneyStatus> {
  const order: JourneyStatus[] = ['error', 'failed', 'passed-healed', 'passed', 'skipped'];
  const ids = new Set(journeyIds);
  const owner = (oid: string): string | undefined => {
    const b = baseJourneyId(oid);
    if (ids.has(b)) return b;
    // A cross-browser unit (<id>@<browser>) belongs to its journey when the journeys are not units themselves.
    const j = stripBrowser(b);
    if (ids.has(j)) return j;
    return journeyIds.find((x) => b.startsWith(`${x}-`) || j.startsWith(`${x}-`));
  };
  const out = new Map<string, JourneyStatus>();
  for (const r of runs) {
    const worst = new Map<string, JourneyStatus>();
    for (const o of r.outcomes) {
      const id = owner(o.journeyId);
      if (!id) continue;
      const prev = worst.get(id);
      if (!prev || order.indexOf(o.status) < order.indexOf(prev)) worst.set(id, o.status);
    }
    for (const [id, st] of worst) out.set(id, st);
  }
  return out;
}

/** Journeys that failed or errored in the most recent recorded run. */
export function lastFailedIds(runs: readonly RunHistoryEntry[], journeys: Array<Pick<Journey, 'id' | 'examples'>>): { runId?: string; ids: string[] } {
  const last = runs[runs.length - 1];
  if (!last) return { ids: [] };
  const ids = new Set<string>();
  for (const o of last.outcomes) {
    if (o.status !== 'failed' && o.status !== 'error') continue;
    const id = stripBrowser(baseJourneyId(o.journeyId));
    const hit = journeys.find((j) => j.id === id) ?? journeys.find((j) => j.examples?.length && id.startsWith(`${j.id}-`));
    if (hit) ids.add(hit.id);
  }
  return { runId: last.runId, ids: [...ids] };
}

/** Previously failing first (failed/error, then healed, then the rest), then higher risk; stable otherwise. */
export function failedFirst<T extends Pick<Journey, 'id' | 'risk'>>(journeys: T[], last: Map<string, JourneyStatus>): T[] {
  const rank = (s?: JourneyStatus) => (s === 'failed' || s === 'error' ? 0 : s === 'passed-healed' ? 1 : s === undefined ? 2 : 3);
  return journeys.map((j, i) => ({ j, i })).sort((a, b) => rank(last.get(a.j.id)) - rank(last.get(b.j.id)) || b.j.risk - a.j.risk || a.i - b.i).map((x) => x.j);
}

/** Fisher-Yates with a seeded PRNG: the same seed gives the same order on every machine. */
export function seededShuffle<T>(list: T[], seed: string | number): T[] {
  const rnd = mulberry32(hashSeed(seed));
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const k = Math.floor(rnd() * (i + 1));
    [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
}

/** N copies of each journey (or only of `only`); copies run as separate journeys. */
export function repeatJourneys(journeys: Journey[], n: number, only?: Set<string>): Journey[] {
  const times = Math.max(1, Math.floor(n));
  const out: Journey[] = [];
  for (const j of journeys) {
    out.push(j);
    if (only && !only.has(j.id)) continue;
    for (let k = 2; k <= times; k++) out.push({ ...j, id: `${j.id}${REPEAT_SEP}${k}`, name: `${j.name} (repeat ${k}/${times})` });
  }
  return out;
}

export interface BurnInVerdict {
  journeyId: string;
  runs: number;
  passed: number;
  failed: number;
  verdict: 'stable' | 'flaky' | 'broken';
}

/** Group repeated copies back to their journey: mixed outcomes are flaky. */
export function burnInVerdicts(run: RunResult): BurnInVerdict[] {
  const groups = new Map<string, JourneyStatus[]>();
  for (const j of run.journeys) {
    const id = baseJourneyId(j.journeyId);
    groups.set(id, [...(groups.get(id) ?? []), j.status]);
  }
  const out: BurnInVerdict[] = [];
  for (const [id, st] of groups) {
    if (st.length < 2) continue;
    const ok = st.filter((s) => s === 'passed' || s === 'passed-healed').length;
    const bad = st.filter((s) => s === 'failed' || s === 'error').length;
    const score = scoreFlakiness(id, st, { minSamples: 2, minFlips: 1, window: st.length });
    out.push({ journeyId: id, runs: st.length, passed: ok, failed: bad, verdict: ok && bad ? 'flaky' : bad ? 'broken' : score.state === 'flaky' ? 'flaky' : 'stable' });
  }
  return out.sort((a, b) => a.journeyId.localeCompare(b.journeyId));
}

/** Journeys that passed only after a retry: flaky by definition. */
export function passedOnRetry(run: RunResult): string[] {
  return run.journeys.filter((j) => (j.status === 'passed' || j.status === 'passed-healed') && j.attempt > 1).map((j) => j.journeyId);
}
