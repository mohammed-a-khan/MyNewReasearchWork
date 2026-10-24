/**
 * report.json: the machine-readable report. Version 2 keeps everything
 * version 1 had (`run`, `insights`) and adds `model`, the report data model
 * (see docs/reports.md and REPORT_JSON_SCHEMA). Readers accept 1 and 2.
 */
import type { RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { healProposals, type HealProposal, type ReportInsights } from './model.js';
import { bddHierarchy, type BddReport } from './bdd.js';
import type { ReportModel } from './data.js';

export const REPORT_JSON_VERSION = 2 as const;

export interface JsonReport {
  format: 'eztest-report';
  /** 1 (before the report model) or 2. */
  version: 1 | 2;
  /** JSON Schema id of this document (REPORT_JSON_SCHEMA). */
  $schema?: string;
  generatedAt: string;
  run: RunResult;
  /** Gherkin scenarios grouped by feature and rule (present when the run has `.feature` scenarios). */
  bdd?: BddReport;
  insights: {
    triage?: ReportInsights['triage'];
    readiness?: ReportInsights['readiness'];
    flaky?: ReportInsights['flaky'];
    apiCoverage?: ReportInsights['apiCoverage'];
    healProposals: HealProposal[];
  };
  /** The report data model (version 2). */
  model?: ReportModel;
}

export function buildJsonReport(run: RunResult, insights: ReportInsights = {}, model?: ReportModel): JsonReport {
  if (run.journeys.length === 0) throw new EzTestError('buildJsonReport: run has no journeys', 'INVALID_INPUT');
  const bdd = bddHierarchy(run);
  return {
    format: 'eztest-report',
    version: REPORT_JSON_VERSION,
    $schema: 'eztest:report/2',
    generatedAt: new Date().toISOString(),
    run,
    ...(bdd ? { bdd } : {}),
    insights: {
      triage: insights.triage,
      readiness: insights.readiness,
      flaky: insights.flaky,
      ...(insights.apiCoverage ? { apiCoverage: insights.apiCoverage } : {}),
      healProposals: healProposals(run),
    },
    ...(model ? { model } : {}),
  };
}
