/**
 * Historical journey durations, the input to duration-balanced sharding, budget
 * selection and CI matrix sizing. Durations come from the history store
 * (`.eztest/history.json`) or from a results server; a journey that never ran
 * gets an estimate (the median of the known journeys, or a fixed default).
 */
import type { HistoryStore, RunHistoryEntry } from '../insights/index.js';

export interface DurationTable {
  /** Typical duration (ms) per journey id, from history. */
  known: Record<string, number>;
  /** Estimate used for journeys with no history. */
  defaultMs: number;
}

/** Duration used when nothing at all is known (30 s: a typical UI journey). */
export const FALLBACK_DURATION_MS = 30_000;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Median duration of each journey over its last `window` recorded runs
 * (skipped outcomes ignored; for several attempts in one run the attempts are summed,
 * because that is how long the journey occupied a worker).
 */
export function durationsFromRuns(runs: readonly RunHistoryEntry[], window = 10): DurationTable {
  const per = new Map<string, number[]>();
  for (const r of runs) {
    const inRun = new Map<string, number>();
    for (const o of r.outcomes) {
      if (o.status === 'skipped') continue;
      inRun.set(o.journeyId, (inRun.get(o.journeyId) ?? 0) + Math.max(0, o.durationMs));
    }
    for (const [id, ms] of inRun) {
      const list = per.get(id) ?? [];
      list.push(ms);
      per.set(id, list);
    }
  }
  const known: Record<string, number> = {};
  for (const [id, list] of [...per].sort(([a], [b]) => a.localeCompare(b))) known[id] = median(list.slice(-window));
  const all = Object.values(known);
  return { known, defaultMs: all.length ? median(all) : FALLBACK_DURATION_MS };
}

export function durationsFromHistory(store: HistoryStore, window = 10): DurationTable {
  return durationsFromRuns(store.runs, window);
}

/**
 * Estimated duration of a journey. Data-driven journeys are recorded per Examples row
 * (`<id>-<row>`), so a journey with no exact entry sums the rows recorded under its id.
 */
export function estimateDuration(table: DurationTable, journeyId: string, opts: { rows?: number } = {}): { ms: number; source: 'history' | 'rows' | 'estimate' } {
  const exact = table.known[journeyId];
  if (exact !== undefined) return { ms: exact, source: 'history' };
  const prefix = `${journeyId}-`;
  let sum = 0;
  let n = 0;
  for (const [id, ms] of Object.entries(table.known)) {
    if (id.startsWith(prefix)) {
      sum += ms;
      n++;
    }
  }
  if (n) return { ms: sum, source: 'rows' };
  return { ms: table.defaultMs * Math.max(1, opts.rows ?? 1), source: 'estimate' };
}
