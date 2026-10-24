import { flattenStepResults, type EvidenceRef, type RunResult } from '../core/index.js';
import type { TriageReport, ReadinessResult, FlakyScore } from '../insights/index.js';

export interface ReportInsights {
  triage?: TriageReport;
  readiness?: ReadinessResult;
  flaky?: FlakyScore[];
  /** Evidence manifest; used to resolve evidence ids to files. */
  evidence?: EvidenceRef[];
  /** API coverage against the configured spec(s) (api.spec). */
  apiCoverage?: import('../contracts/coverage.js').ApiCoverageReport[];
}

export interface HealProposal {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  tier: string;
  confidence: number;
  verified: boolean;
  from: string[];
  to: string;
  reason: string;
  evidence: string[];
  /** Verified heals are proposed for acceptance; unverified ones need review. */
  recommendation: 'accept' | 'review';
}

const loc = (l: { strategy: string; value: string; name?: string }) => `${l.strategy}=${l.value}${l.name ? ` [name=${l.name}]` : ''}`;

export function healProposals(run: RunResult): HealProposal[] {
  const out: HealProposal[] = [];
  for (const j of run.journeys) {
    // Heals may sit inside groups: code journey step() blocks, Gherkin steps, if/loop blocks.
    for (const { result: s } of flattenStepResults(j.steps)) {
      if (!s.heal) continue;
      out.push({
        journeyId: j.journeyId,
        journeyName: j.name,
        stepId: s.stepId,
        intent: s.intent,
        tier: s.heal.tier,
        confidence: s.heal.confidence,
        verified: s.heal.verified,
        from: s.heal.original.map(loc),
        to: loc(s.heal.healed),
        reason: s.heal.reason,
        evidence: s.heal.evidence,
        recommendation: s.heal.verified ? 'accept' : 'review',
      });
    }
  }
  return out;
}

export { loc as formatLocator };
