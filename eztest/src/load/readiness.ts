/**
 * The `load` readiness gate: a load run's SLA verdict (and, when compared
 * with a baseline, its regressions) decides GO / NO_GO. Its input is the
 * run's `load-results.json`, cited by evidence id.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceRef } from '../core/index.js';
import { LOAD_RESULTS_FILE, LOAD_REPORT_FILE, loadJourneyId } from './constants.js';
import type { LoadResults } from './run.js';

export interface LoadGateInput {
  scenario: string;
  verdict: 'pass' | 'warn' | 'fail';
  failed: Array<{ sla: string; name: string; metric: string; value: number | null; fail?: number; status: string }>;
  warnings: Array<{ sla: string; name: string; metric: string; value: number | null; warn?: number }>;
  regressions: number;
  regressionDetails: string[];
  requests: number;
  errorRate: number;
  p95: number;
  evidence: string[];
  journeys: string[];
}

export interface LoadGateOutcome {
  status: 'pass' | 'fail' | 'no-data';
  summary: string;
  evidence: string[];
  journeys: string[];
}

export function loadGateInput(r: LoadResults, evidence: string[]): LoadGateInput {
  return {
    scenario: r.scenario.name,
    verdict: r.verdict,
    failed: r.sla.items.filter((i) => i.status === 'fail' || i.status === 'no-data').map((i) => ({ sla: i.sla, name: i.name, metric: i.metric, value: i.value, fail: i.fail, status: i.status })),
    warnings: r.sla.items.filter((i) => i.status === 'warn').map((i) => ({ sla: i.sla, name: i.name, metric: i.metric, value: i.value, warn: i.warn })),
    regressions: r.comparison?.regressions ?? 0,
    regressionDetails: (r.comparison?.rows ?? []).filter((x) => x.verdict === 'regression').map((x) => `${x.name}: ${x.reasons.join('; ')}`),
    requests: r.totals.requests,
    errorRate: r.totals.errorRate,
    p95: r.totals.latency.p95,
    evidence,
    journeys: [loadJourneyId(r)],
  };
}

export function evaluateLoadGate(input: LoadGateInput[] | LoadGateInput | undefined, cfg: Record<string, unknown> = {}): LoadGateOutcome {
  const list = input === undefined ? [] : Array.isArray(input) ? input : [input];
  if (!list.length) return { status: 'no-data', summary: 'No load test results were recorded for this run (eztest load run --run <runDir>, or gate the load run directory).', evidence: [], journeys: [] };
  const allowWarnings = (cfg.allowWarnings as boolean | undefined) ?? true;
  const maxRegressions = (cfg.maxRegressions as number | undefined) ?? 0;
  const problems: string[] = [];
  for (const l of list) {
    for (const f of l.failed) problems.push(`${l.scenario}: ${f.name} ${f.metric} ${f.value ?? 'not measured'}${f.fail !== undefined ? ` > ${f.fail}` : ''}`);
    if (!allowWarnings) for (const w of l.warnings) problems.push(`${l.scenario}: ${w.name} ${w.metric} ${w.value} in the warning range (> ${w.warn})`);
    if (l.regressions > maxRegressions) problems.push(`${l.scenario}: ${l.regressions} regression(s) vs baseline (${l.regressionDetails.slice(0, 3).join(' | ')})`);
    if (!l.requests) problems.push(`${l.scenario}: no requests completed`);
  }
  const evidence = list.flatMap((l) => l.evidence);
  const journeys = list.flatMap((l) => l.journeys);
  const head = list.map((l) => `${l.scenario}: ${l.requests} requests, ${(l.errorRate * 100).toFixed(2)}% errors, p95 ${l.p95} ms`).join('; ');
  return problems.length
    ? { status: 'fail', summary: `Load SLAs not met: ${problems.slice(0, 8).join('; ')}.`, evidence, journeys }
    : { status: 'pass', summary: `Load SLAs met (${head}).`, evidence, journeys };
}

/** The load gate input of a run directory (its load-results.json and the evidence id that recorded it). */
export async function loadReadinessInputs(runDir: string, evidence: EvidenceRef[]): Promise<{ load?: LoadGateInput[] }> {
  const file = join(runDir, LOAD_RESULTS_FILE);
  if (!existsSync(file)) return {};
  try {
    const r = JSON.parse(await readFile(file, 'utf8')) as LoadResults;
    const ids = evidence.filter((e) => e.path === LOAD_RESULTS_FILE || e.path === LOAD_REPORT_FILE).map((e) => e.id);
    return { load: [loadGateInput(r, ids)] };
  } catch {
    return {};
  }
}
