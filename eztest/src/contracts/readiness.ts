/**
 * Readiness gates for contracts: `apiCoverage` (share of spec operations and
 * status codes the run exercised, and no contract violations) and `contracts`
 * (contract verification results and the results server's can-release
 * answer). Their
 * inputs are files in the run directory, recorded as evidence so every
 * verdict cites something that exists.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceRef } from '../core/index.js';
import { EvidenceVault } from '../core/index.js';
import type { ApiCoverageReport } from './coverage.js';
import type { CanReleaseResult } from './release.js';
import { API_COVERAGE_FILE } from './run-coverage.js';
import type { ContractVerification } from './verify.js';

export const CONTRACT_RESULTS_FILE = 'contracts-results.json';

export interface ApiCoverageGateInput {
  report: ApiCoverageReport;
  evidence: string[];
}

export interface ContractsGateInput {
  verifications: Array<{ consumer: string; provider: string; passed: boolean; failed: string[] }>;
  canRelease?: CanReleaseResult;
  evidence: string[];
}

export interface GateOutcome {
  status: 'pass' | 'fail' | 'no-data';
  summary: string;
  evidence: string[];
  journeys: string[];
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

export function evaluateApiCoverageGate(inputs: ApiCoverageGateInput[] | undefined, cfg: Record<string, unknown>, journeyIds: Set<string>): GateOutcome {
  if (!inputs?.length) return { status: 'no-data', summary: 'No API coverage was recorded (configure api.spec and run API steps).', evidence: [], journeys: [] };
  const minOps = (cfg.minOperations as number | undefined) ?? (cfg.min as number | undefined) ?? 0.8;
  const minStatus = cfg.minStatusCodes as number | undefined;
  const noViolations = (cfg.noViolations as boolean | undefined) ?? true;
  const problems: string[] = [];
  const evidence = inputs.flatMap((i) => i.evidence);
  const journeys = [...new Set(inputs.flatMap((i) => i.report.operations.flatMap((o) => o.journeys)))].filter((j) => journeyIds.has(j));
  for (const { report: r } of inputs) {
    const t = r.totals;
    if (t.operationRatio < minOps) problems.push(`${r.spec.title || r.spec.file}: operations ${t.coveredOperations}/${t.operations} (${pct(t.operationRatio)}) below ${pct(minOps)}; untested: ${r.operations.filter((o) => !o.covered).map((o) => o.id).slice(0, 8).join(', ')}`);
    if (minStatus !== undefined && t.statusRatio < minStatus) problems.push(`${r.spec.title || r.spec.file}: status codes ${t.coveredStatusCodes}/${t.statusCodes} (${pct(t.statusRatio)}) below ${pct(minStatus)}`);
    if (noViolations && t.violations > 0) problems.push(`${r.spec.title || r.spec.file}: ${t.violations} contract violation(s)`);
  }
  const head = inputs.map(({ report: r }) => `${r.spec.title || r.spec.file}: operations ${pct(r.totals.operationRatio)}, status codes ${pct(r.totals.statusRatio)}, parameters ${pct(r.totals.parameterRatio)}`).join('; ');
  return problems.length
    ? { status: 'fail', summary: `API coverage below policy. ${problems.join('. ')}.`, evidence, journeys }
    : { status: 'pass', summary: `API coverage meets policy (${head}).`, evidence, journeys };
}

export function evaluateContractsGate(input: ContractsGateInput | undefined): GateOutcome {
  if (!input || (!input.verifications.length && !input.canRelease)) {
    return { status: 'no-data', summary: 'No contract verification or can-release result was recorded (eztest contracts verify|can-release --run <runDir>).', evidence: [], journeys: [] };
  }
  const problems: string[] = [];
  for (const v of input.verifications) if (!v.passed) problems.push(`contract ${v.consumer} -> ${v.provider} failed verification (${v.failed.slice(0, 5).join('; ')})`);
  const c = input.canRelease;
  if (c && !c.releasable) problems.push(`can-release ${c.app} ${c.version} to ${c.environment}: NO (${c.reason})`);
  const ok = [
    ...input.verifications.filter((v) => v.passed).map((v) => `${v.consumer} -> ${v.provider} verified`),
    ...(c?.releasable ? [`can-release ${c.app} ${c.version} to ${c.environment}: yes`] : []),
  ];
  return problems.length
    ? { status: 'fail', summary: `Contracts not satisfied: ${problems.join('; ')}.`, evidence: input.evidence, journeys: [] }
    : { status: 'pass', summary: `Contracts satisfied: ${ok.join('; ')}.`, evidence: input.evidence, journeys: [] };
}

/** Read the contract inputs of a run (api-coverage.json and contracts-results.json, with their evidence ids). */
export async function contractReadinessInputs(runDir: string, evidence: EvidenceRef[]): Promise<{ apiCoverage?: ApiCoverageGateInput[]; contracts?: ContractsGateInput }> {
  const out: { apiCoverage?: ApiCoverageGateInput[]; contracts?: ContractsGateInput } = {};
  const cov = join(runDir, API_COVERAGE_FILE);
  if (existsSync(cov)) {
    try {
      const doc = JSON.parse(await readFile(cov, 'utf8')) as { reports: ApiCoverageReport[]; evidenceId?: string };
      const reports = doc.reports;
      const ev = doc.evidenceId && evidence.some((e) => e.id === doc.evidenceId) ? [doc.evidenceId] : [];
      out.apiCoverage = reports.map((report) => ({ report, evidence: ev }));
    } catch {
      // unreadable: the gate reports no data
    }
  }
  const res = join(runDir, CONTRACT_RESULTS_FILE);
  if (existsSync(res)) {
    try {
      const data = JSON.parse(await readFile(res, 'utf8')) as Omit<ContractsGateInput, 'evidence'> & { evidenceId?: string };
      const { evidenceId, ...rest } = data;
      out.contracts = { ...rest, evidence: evidenceId && evidence.some((e) => e.id === evidenceId) ? [evidenceId] : [] };
    } catch {
      // unreadable
    }
  }
  return out;
}

/** Merge verification and can-release results into the run's contracts-results.json (recorded as evidence). */
export async function recordContractResults(runDir: string, add: { verifications?: ContractVerification[]; canRelease?: CanReleaseResult }): Promise<string> {
  const p = join(runDir, CONTRACT_RESULTS_FILE);
  const prev: Omit<ContractsGateInput, 'evidence'> = existsSync(p) ? (JSON.parse(await readFile(p, 'utf8')) as Omit<ContractsGateInput, 'evidence'>) : { verifications: [] };
  delete (prev as { evidenceId?: string }).evidenceId;
  const verifications = [...prev.verifications];
  for (const v of add.verifications ?? []) {
    const entry = { consumer: v.consumer, provider: v.provider, passed: v.passed, failed: v.expectations.filter((e) => !e.passed).map((e) => `${e.description}: ${e.error ?? e.mismatches[0]?.message ?? 'failed'}`) };
    const at = verifications.findIndex((x) => x.consumer === v.consumer && x.provider === v.provider);
    if (at >= 0) verifications[at] = entry;
    else verifications.push(entry);
  }
  const data = { verifications, ...(add.canRelease ?? prev.canRelease ? { canRelease: add.canRelease ?? prev.canRelease } : {}) };
  const vault = await EvidenceVault.resume(runDir);
  const ref = await vault.store('report', `contracts/results-${Date.now()}.json`, JSON.stringify(data, null, 2), { description: 'contract verification and can-release results' });
  await writeFile(p, JSON.stringify({ ...data, evidenceId: ref.id }, null, 2));
  return ref.id;
}
