/**
 * Flaky scoring. A journey is labelled from its recent outcome sequence:
 *  - new        fewer than `minSamples` executed outcomes
 *  - broken     trailing run of >= `brokenStreak` failures (consistently failing is not flaky)
 *  - recovering passing again after having been broken, but not yet `stableStreak` passes
 *  - flaky      alternates between pass and fail (flip rate) with a failure rate whose
 *               Wilson lower bound is above `minFailRateLow`
 *  - stable     otherwise
 * Healed passes ("passed-healed") count as passes for state, but are tracked as
 * their own signal: a rising healed trend means the suite depends on healing.
 */
import type { FlakeCause, JourneyStatus } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import type { HistoryStore } from './history.js';
import { summarizeFlakeCauses, withFlakeCauses } from './flake-causes.js';

export type FlakyState = 'new' | 'stable' | 'flaky' | 'broken' | 'recovering';

export interface FlakyOptions {
  /** Only the most recent N executed outcomes are considered. Default 20. */
  window?: number;
  /** Minimum executed outcomes before any label other than "new". Default 5. */
  minSamples?: number;
  /** Trailing consecutive failures that make a journey "broken". Default 3. */
  brokenStreak?: number;
  /** Consecutive passes after a broken streak before "stable" again. Default 3. */
  stableStreak?: number;
  /** Minimum number of pass/fail flips for "flaky" (a single break-and-fix is 2 flips). Default 3. */
  minFlips?: number;
  /** Minimum flips / (n - 1) for "flaky". Default 0.2. */
  minFlipRate?: number;
  /** Wilson lower bound of the failure rate needed for "flaky". Default 0.02. */
  minFailRateLow?: number;
  /** Quarantine is never recommended with fewer samples than this. Default 10. */
  quarantineMinSamples?: number;
  /** Healed share of passes considered a healing dependency. Default 0.3. */
  healedRateThreshold?: number;
  /** z for the Wilson interval. Default 1.96 (95%). */
  z?: number;
}

export interface WilsonInterval {
  low: number;
  high: number;
  center: number;
}

export interface FlakyScore {
  journeyId: string;
  state: FlakyState;
  samples: number;
  passes: number;
  healedPasses: number;
  failures: number;
  flips: number;
  flipRate: number;
  failRate: number;
  /** Wilson interval of the failure rate. */
  failRateInterval: WilsonInterval;
  healedRate: number;
  /** Healed passes are more frequent in the newer half of the window than the older half. */
  healedTrendRising: boolean;
  healingDependent: boolean;
  quarantine: { recommended: boolean; reason: string };
  /** Root-cause category of the flakiness, from classified retries (see flake-causes.ts). */
  rootCause?: { cause: FlakeCause; share: number; retriedPasses: number; advice: string };
  /** Executed outcome sequence, oldest first: P pass, H healed pass, F fail. */
  sequence: string;
  reasons: string[];
}

/** Wilson score interval for `successes` out of `n`. */
export function wilsonInterval(successes: number, n: number, z = 1.96): WilsonInterval {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n < 0 || successes < 0 || successes > n) {
    throw new EzTestError(`wilsonInterval: invalid input ${successes}/${n}`, 'INVALID_INPUT');
  }
  if (n === 0) return { low: 0, high: 1, center: 0.5 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin), center };
}

type Sym = 'P' | 'H' | 'F';

function symbol(s: JourneyStatus): Sym | undefined {
  if (s === 'passed') return 'P';
  if (s === 'passed-healed') return 'H';
  if (s === 'failed' || s === 'error') return 'F';
  return undefined; // skipped: not an execution
}

const isPass = (s: Sym) => s !== 'F';

/** Score one journey from its statuses, oldest first. */
export function scoreFlakiness(journeyId: string, statuses: JourneyStatus[], opts: FlakyOptions = {}): FlakyScore {
  const o = {
    window: opts.window ?? 20,
    minSamples: opts.minSamples ?? 5,
    brokenStreak: opts.brokenStreak ?? 3,
    stableStreak: opts.stableStreak ?? 3,
    minFlips: opts.minFlips ?? 3,
    minFlipRate: opts.minFlipRate ?? 0.2,
    minFailRateLow: opts.minFailRateLow ?? 0.02,
    quarantineMinSamples: opts.quarantineMinSamples ?? 10,
    healedRateThreshold: opts.healedRateThreshold ?? 0.3,
    z: opts.z ?? 1.96,
  };
  if (o.minSamples < 2) throw new EzTestError('minSamples must be >= 2', 'INVALID_OPTIONS');
  if (o.quarantineMinSamples < o.minSamples) o.quarantineMinSamples = o.minSamples;

  const seq = statuses.map(symbol).filter((x): x is Sym => x !== undefined).slice(-o.window);
  const n = seq.length;
  const passes = seq.filter(isPass).length;
  const healedPasses = seq.filter((s) => s === 'H').length;
  const failures = n - passes;
  let flips = 0;
  for (let i = 1; i < n; i++) if (isPass(seq[i]) !== isPass(seq[i - 1])) flips++;
  const flipRate = n > 1 ? flips / (n - 1) : 0;
  const failRate = n > 0 ? failures / n : 0;
  const failRateInterval = wilsonInterval(failures, n, o.z);
  const healedRate = passes > 0 ? healedPasses / passes : 0;

  const half = Math.floor(n / 2);
  const older = seq.slice(0, half);
  const newer = seq.slice(half);
  const rate = (xs: Sym[]) => {
    const p = xs.filter(isPass).length;
    return p ? xs.filter((s) => s === 'H').length / p : 0;
  };
  const healedTrendRising = n >= 4 && rate(newer) > rate(older);

  let trailingFails = 0;
  for (let i = n - 1; i >= 0 && seq[i] === 'F'; i--) trailingFails++;
  let trailingPasses = 0;
  for (let i = n - 1; i >= 0 && isPass(seq[i]); i--) trailingPasses++;
  let priorFails = 0;
  for (let i = n - 1 - trailingPasses; i >= 0 && seq[i] === 'F'; i--) priorFails++;

  const reasons: string[] = [];
  let state: FlakyState;
  if (n < o.minSamples) {
    state = 'new';
    reasons.push(`only ${n} executed outcome(s); ${o.minSamples} needed before labelling`);
  } else if (trailingFails >= o.brokenStreak) {
    state = 'broken';
    reasons.push(`failed the last ${trailingFails} consecutive runs`);
  } else if (trailingPasses > 0 && trailingPasses < o.stableStreak && priorFails >= o.brokenStreak) {
    state = 'recovering';
    reasons.push(`passing for ${trailingPasses} run(s) after ${priorFails} consecutive failures`);
  } else if (
    passes > 0 &&
    failures > 0 &&
    flips >= o.minFlips &&
    flipRate >= o.minFlipRate &&
    failRateInterval.low >= o.minFailRateLow
  ) {
    state = 'flaky';
    reasons.push(
      `${flips} pass/fail flips over ${n} runs (flip rate ${flipRate.toFixed(2)}), failure rate ${failRate.toFixed(2)} (95% CI ${failRateInterval.low.toFixed(2)}-${failRateInterval.high.toFixed(2)})`,
    );
  } else {
    state = 'stable';
    reasons.push(`failure rate ${failRate.toFixed(2)} with flip rate ${flipRate.toFixed(2)}`);
  }

  const healingDependent = passes >= o.minSamples && healedRate >= o.healedRateThreshold;
  if (healingDependent) reasons.push(`${healedPasses}/${passes} passes needed healing`);
  if (healedTrendRising && healedPasses > 0) reasons.push('healed passes are rising in recent runs');

  let quarantine: FlakyScore['quarantine'];
  if (state !== 'flaky') quarantine = { recommended: false, reason: `state is ${state}` };
  else if (n < o.quarantineMinSamples)
    quarantine = { recommended: false, reason: `flaky but only ${n}/${o.quarantineMinSamples} samples; keep observing` };
  else quarantine = { recommended: true, reason: `flaky across ${n} samples (flip rate ${flipRate.toFixed(2)})` };

  return {
    journeyId,
    state,
    samples: n,
    passes,
    healedPasses,
    failures,
    flips,
    flipRate,
    failRate,
    failRateInterval,
    healedRate,
    healedTrendRising,
    healingDependent,
    quarantine,
    sequence: seq.join(''),
    reasons,
  };
}

/** Score every journey in a history store (retried passes and their classified root causes included). */
export function scoreHistory(store: HistoryStore, opts: FlakyOptions = {}): FlakyScore[] {
  const ids = store.journeyIds();
  return ids.map((id) => {
    const outcomes = store.outcomesFor(id);
    return withFlakeCauses(scoreFlakiness(id, outcomes.map((o) => o.status), opts), summarizeFlakeCauses(id, outcomes, opts.window ?? 20));
  });
}
