/**
 * Heal proposals: a reviewable list of every heal in a run (original locators
 * -> verified healed locator), ready to turn into a pull request against the
 * journey sources. Unverified heals are listed separately as rejected.
 */
import { flattenStepResults, flattenSteps, type HealRecord, type Journey, type LocatorCandidate, type RunResult, type Target } from '../core/index.js';
import { ELEMENTS_JOURNEY, type FingerprintStore } from './store.js';

export interface HealProposal {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  targetDescription?: string;
  original: LocatorCandidate[];
  healed: LocatorCandidate;
  tier: HealRecord['tier'];
  confidence: number;
  verified: boolean;
  reason: string;
  evidence: string[];
  /** The step target with the healed locator promoted to first place. */
  suggestedTarget?: Target;
  /** Shared repository element: accepting the heal rewrites elements/*.yaml (every journey using it is fixed). */
  element?: string;
  /** The heal is of a scope anchor or container of the target (not rewritten automatically). */
  anchor?: number;
  /** Accepted without verification (healing.requireVerification: false). */
  unverified?: boolean;
}

/** A more robust locator for a step that passed with a weak one (verified to select the same element). */
export interface ImprovementProposal {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  current?: LocatorCandidate;
  suggested: LocatorCandidate;
  score: number;
  currentScore: number;
  reason: string;
}

export interface HealProposalFile {
  runId: string;
  generatedAt: string;
  /** Verified heals, ready for review. */
  proposals: HealProposal[];
  /** Heals whose post-conditions did not hold (suspected regressions). */
  rejected: HealProposal[];
  /** Heals accepted without verification (healing.requireVerification: false): review them; never auto-accepted. */
  unverified?: HealProposal[];
  /** Verified, more robust locators for weak targets of passing steps (review kind "improvement"). */
  improvements?: ImprovementProposal[];
}

/** Collect heal proposals from a run result. */
export function collectHealProposals(run: Pick<RunResult, 'runId' | 'journeys'>, journeys: Journey[] = []): HealProposalFile {
  const out: HealProposalFile = { runId: run.runId, generatedAt: new Date().toISOString(), proposals: [], rejected: [], improvements: [] };
  for (const jr of run.journeys) {
    const j = journeys.find((x) => x.id === jr.journeyId);
    // Healed steps may sit inside blocks (if/loops/frame blocks); walk the whole tree.
    for (const { result: sr } of flattenStepResults(jr.steps)) {
      if (sr.improvement && (sr.status === 'passed' || sr.status === 'passed-healed')) {
        out.improvements!.push({
          journeyId: jr.journeyId, journeyName: jr.name, stepId: sr.stepId, intent: sr.intent,
          current: sr.usedLocator, suggested: sr.improvement.suggested, score: sr.improvement.score, currentScore: sr.improvement.currentScore, reason: sr.improvement.reason,
        });
      }
      const h = sr.heal;
      if (!h) continue;
      const target = (j ? flattenSteps(j.steps) : []).find((s) => s.id === sr.stepId)?.target;
      const p: HealProposal = {
        journeyId: jr.journeyId,
        journeyName: jr.name,
        stepId: sr.stepId,
        intent: sr.intent,
        targetDescription: target?.description,
        original: h.original,
        healed: h.healed,
        tier: h.tier,
        confidence: h.confidence,
        verified: h.verified,
        reason: h.reason,
        evidence: h.evidence,
        ...(h.element ? { element: h.element } : {}),
        ...(h.anchor !== undefined ? { anchor: h.anchor } : {}),
        ...(h.unverified ? { unverified: true } : {}),
        ...(target && h.verified ? { suggestedTarget: { ...target, locators: [h.healed, ...target.locators] } } : {}),
      };
      if (h.unverified) (out.unverified ??= []).push(p);
      else (h.verified ? out.proposals : out.rejected).push(p);
    }
  }
  return out;
}

/** Promote verified heals into the T0 cache of a fingerprint store. */
export function promoteVerifiedHeals(store: FingerprintStore, file: HealProposalFile): number {
  let n = 0;
  for (const p of file.proposals) {
    if (!p.verified) continue;
    store.recordHeal(p.element ? ELEMENTS_JOURNEY : p.journeyId, p.element ?? p.stepId, {
      locator: p.healed,
      original: p.original,
      tier: p.tier,
      confidence: p.confidence,
      verifiedAt: file.generatedAt,
      runId: file.runId,
    });
    n++;
  }
  return n;
}
