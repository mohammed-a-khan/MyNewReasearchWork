import type { RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { healProposals, type HealProposal, type ReportInsights } from './model.js';

export interface JsonReport {
  format: 'eztest-report';
  version: 1;
  generatedAt: string;
  run: RunResult;
  insights: {
    triage?: ReportInsights['triage'];
    readiness?: ReportInsights['readiness'];
    flaky?: ReportInsights['flaky'];
    apiCoverage?: ReportInsights['apiCoverage'];
    healProposals: HealProposal[];
  };
}

export function buildJsonReport(run: RunResult, insights: ReportInsights = {}): JsonReport {
  if (run.journeys.length === 0) throw new EzTestError('buildJsonReport: run has no journeys', 'INVALID_INPUT');
  return {
    format: 'eztest-report',
    version: 1,
    generatedAt: new Date().toISOString(),
    run,
    insights: {
      triage: insights.triage,
      readiness: insights.readiness,
      flaky: insights.flaky,
      ...(insights.apiCoverage ? { apiCoverage: insights.apiCoverage } : {}),
      healProposals: healProposals(run),
    },
  };
}
