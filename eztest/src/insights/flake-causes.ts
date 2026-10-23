/**
 * Flake root causes across runs. Every pass that needed a retry carries the
 * classified cause of its failed attempt (timing, overlay, detached, network,
 * data, environment) in history. This module aggregates them per journey,
 * names the dominant cause, and folds "passed only on retry" into flaky
 * scoring: a journey that keeps needing retries is flaky even though every
 * final status was a pass.
 */
import { FLAKE_CAUSES, type FlakeCause } from '../core/index.js';
import type { FlakyScore } from './flaky.js';
import type { HistoryStore, JourneyOutcome } from './history.js';

export interface FlakeCauseSummary {
  journeyId: string;
  /** Passes that needed a retry in the window. */
  retriedPasses: number;
  byCause: Record<FlakeCause, number>;
  /** The most frequent cause (ties: the most recent). */
  dominant?: FlakeCause;
  /** Share of retried passes with the dominant cause (0..1). */
  share: number;
  /** Plain-language advice for the dominant cause. */
  advice?: string;
}

export const FLAKE_ADVICE: Record<FlakeCause, string> = {
  timing: 'the app was not ready in time: turn on reliability.appIdle, or add a post-condition that waits for the real signal (not a sleep)',
  overlay: 'an overlay (spinner, cookie banner, toast, modal) covered the element: add the overlay to waits.loaders, or dismiss it in the journey',
  detached: 'the element was re-rendered during the step: keep reliability.verifyFill and reliability.appIdle on so the runner waits for the render',
  network: 'a backend call failed or returned 5xx: check the service and its dependencies (health checks would stop the run early)',
  data: 'test data was missing, used by someone else or conflicting: declare it with Data:/Requires: and lease it per worker',
  environment: 'the environment was unavailable or the session expired: add healthChecks and sessionExpiry to the config',
  unknown: 'no classifier rule matched: open the flake-cause evidence of the run',
};

const empty = (): Record<FlakeCause, number> => Object.fromEntries(FLAKE_CAUSES.map((c) => [c, 0])) as Record<FlakeCause, number>;

/** Summarise retried passes and their causes from outcomes (oldest first). */
export function summarizeFlakeCauses(journeyId: string, outcomes: Array<Pick<JourneyOutcome, 'status' | 'attempt' | 'flakeCause'>>, window = 20): FlakeCauseSummary {
  const recent = outcomes.filter((o) => o.status !== 'skipped').slice(-window);
  const byCause = empty();
  const lastSeen = new Map<FlakeCause, number>();
  let retriedPasses = 0;
  recent.forEach((o, i) => {
    const passed = o.status === 'passed' || o.status === 'passed-healed';
    if (!passed || o.attempt <= 1) return;
    retriedPasses++;
    const c = o.flakeCause ?? 'unknown';
    byCause[c]++;
    lastSeen.set(c, i);
  });
  let dominant: FlakeCause | undefined;
  for (const c of FLAKE_CAUSES) {
    if (!byCause[c]) continue;
    if (!dominant || byCause[c] > byCause[dominant] || (byCause[c] === byCause[dominant] && (lastSeen.get(c) ?? -1) > (lastSeen.get(dominant) ?? -1))) dominant = c;
  }
  return {
    journeyId, retriedPasses, byCause,
    ...(dominant ? { dominant, advice: FLAKE_ADVICE[dominant] } : {}),
    share: dominant && retriedPasses ? byCause[dominant] / retriedPasses : 0,
  };
}

/** Per-journey summaries from a history store. */
export function flakeCausesFromHistory(store: HistoryStore, window = 20): Map<string, FlakeCauseSummary> {
  return new Map(store.journeyIds().map((id) => [id, summarizeFlakeCauses(id, store.outcomesFor(id), window)]));
}

export interface ScoreWithCause extends FlakyScore {
  /** Root-cause category of the journey's flakiness (from classified retries). */
  rootCause?: { cause: FlakeCause; share: number; retriedPasses: number; advice: string };
}

/**
 * Fold retried passes into a flaky score: a journey that passed only on retry at least
 * `minRetried` times in the window is flaky (with its root cause), even when every
 * final status was a pass.
 */
export function withFlakeCauses(score: FlakyScore, causes: FlakeCauseSummary | undefined, minRetried = 2): ScoreWithCause {
  if (!causes?.dominant) return score;
  const rootCause = { cause: causes.dominant, share: causes.share, retriedPasses: causes.retriedPasses, advice: FLAKE_ADVICE[causes.dominant] };
  const out: ScoreWithCause = { ...score, rootCause, reasons: [...score.reasons] };
  if ((score.state === 'stable' || score.state === 'new') && causes.retriedPasses >= minRetried && score.samples >= 2) {
    out.state = 'flaky';
    out.reasons.unshift(`passed only on retry ${causes.retriedPasses} time(s) in the last ${score.samples} runs`);
  }
  out.reasons.push(`root cause: ${causes.dominant} (${Math.round(causes.share * 100)}% of ${causes.retriedPasses} retried pass(es)) - ${FLAKE_ADVICE[causes.dominant]}`);
  return out;
}
