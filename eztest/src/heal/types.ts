/** Healing contracts shared by the healer and the runner. */
import type { Page } from '../browser/index.js';
import type { HealTier, Journey, LocatorCandidate, Step, Target } from '../core/index.js';
import type { LocatorRoot } from '../runner/locate.js';
import type { FingerprintStore } from './store.js';

/** Ladder order. Every tier is deterministic; EZTest uses no AI provider. */
export const HEAL_TIERS: readonly HealTier[] = ['T0-cache', 'T1-fingerprint', 'T2-semantic'];

export interface HealPolicy {
  /** Master switch. Disabled: no candidates are ever proposed. */
  enabled: boolean;
  /** Highest tier the ladder may climb to (inclusive). */
  maxTier: HealTier;
  /** Proposals below this confidence are not offered (and the T2 acceptance threshold). */
  minConfidence: number;
  /** The best candidate must beat the runner-up by this much (T1/T2), else it is ambiguous. */
  margin: number;
  /** T1 fingerprint acceptance threshold. */
  threshold: number;
  /**
   * A heal counts only when the step's post-conditions (or the action's implied check) verify it. Default true.
   * false: a heal of a step with nothing to verify it is accepted as passed-healed but marked unverified
   * (HealRecord.unverified); it is never cached or auto-applied. A heal whose checks fail is still a suspected regression.
   */
  requireVerification: boolean;
}

export const DEFAULT_HEAL_POLICY: HealPolicy = {
  enabled: true,
  maxTier: 'T2-semantic',
  minConfidence: 0.6,
  margin: 0.08,
  threshold: 0.72,
  requireVerification: true,
};

/** One locator the runner may try, with where it came from and why. */
export interface HealCandidate {
  locator: LocatorCandidate;
  tier: HealTier;
  confidence: number;
  reason: string;
}

/** What the healer sees when a step's target could not be resolved. */
export interface HealContext {
  page: Page;
  /** Root (page or frame) the target lives in. */
  root: LocatorRoot;
  journey: Journey;
  step: Step;
  target: Target;
  /** Why the original locators failed (resolution notes). */
  failure: string;
  store?: FingerprintStore;
  /** Store key of the target's memory (default the journey and step; `@elements/<id>` for repository elements). */
  memory?: { journeyId: string; stepId: string };
  /** Diagnostics sink: why a tier produced nothing. */
  note?: (message: string) => void;
}

/**
 * A healer proposes candidate locators in ladder order. It never acts on the
 * page: the runner performs the step with a candidate and accepts the heal
 * only if the step's post-conditions then hold.
 */
export interface Healer {
  readonly policy: HealPolicy;
  /** Lazily yield candidates, cheapest tier first. */
  candidates(ctx: HealContext): AsyncIterable<HealCandidate>;
}
