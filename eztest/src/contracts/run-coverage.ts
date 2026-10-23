/**
 * API coverage of a finished run: the calls come from the run's contract
 * evidence (written by the api.spec hook: operation, status, header names,
 * violations) and, for steps without it, from the API steps' network
 * evidence. The report is written next to the run (api-coverage.json/.md)
 * and appended to the evidence chain so readiness gates can cite it.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EvidenceVault } from '../core/index.js';
import { readEvidenceManifest } from '../insights/artifacts.js';
import { apiCoverageMarkdown, callsFromNetworkLogs, computeApiCoverage, type ApiCall, type ApiCoverageReport } from './coverage.js';
import type { ContractEvidence } from './hook.js';
import { cachedSpec } from './openapi.js';

export const API_COVERAGE_FILE = 'api-coverage.json';

/** The API calls a run made (contract evidence first, network evidence for the rest). */
export async function apiCallsOfRun(runDir: string): Promise<ApiCall[]> {
  const evidence = await readEvidenceManifest(runDir);
  const calls: ApiCall[] = [];
  const covered = new Set<string>();
  for (const e of evidence) {
    if (e.kind !== 'data' || !e.path.startsWith('contracts/')) continue;
    try {
      const c = JSON.parse(await readFile(join(runDir, e.path), 'utf8')) as ContractEvidence;
      calls.push({ method: c.method, url: c.url, status: c.status, ...(e.journeyId ? { journeyId: e.journeyId } : {}), ...(e.stepId ? { stepId: e.stepId } : {}), evidenceId: e.id, headerNames: c.headerNames, violations: c.violations.length, hasBody: c.hasBody });
      covered.add(`${e.journeyId}|${e.stepId}`);
    } catch {
      // unreadable evidence is reported by `eztest evidence verify`
    }
  }
  for (const e of evidence) {
    if (e.kind !== 'network' || !e.path.startsWith('api/') || covered.has(`${e.journeyId}|${e.stepId}`)) continue;
    try {
      const raw = JSON.parse(await readFile(join(runDir, e.path), 'utf8')) as { entries?: Array<Record<string, unknown>> };
      calls.push(...callsFromNetworkLogs([{ evidenceId: e.id, journeyId: e.journeyId, stepId: e.stepId, entries: (raw.entries ?? []) as never }]));
    } catch {
      // skip
    }
  }
  return calls;
}

export async function computeRunApiCoverage(runDir: string, specFiles: string[]): Promise<ApiCoverageReport[]> {
  const calls = await apiCallsOfRun(runDir);
  return specFiles.map((f) => computeApiCoverage(cachedSpec(resolve(f)), calls));
}

/** Compute, write (api-coverage.json/.md) and record the run's API coverage as evidence. */
export async function recordApiCoverage(runDir: string, specFiles: string[]): Promise<{ reports: ApiCoverageReport[]; evidenceId?: string }> {
  const reports = await computeRunApiCoverage(runDir, specFiles);
  const json = JSON.stringify({ version: 1, reports }, null, 2);
  let evidenceId: string | undefined;
  // The evidence copy gets its own name (evidence files are never overwritten); api-coverage.json is the current view.
  if (existsSync(join(runDir, 'evidence-manifest.jsonl'))) {
    const vault = await EvidenceVault.resume(runDir);
    const ref = await vault.store('report', `contracts/api-coverage-${Date.now()}.json`, json, { description: 'API coverage against the spec' });
    evidenceId = ref.id;
  }
  await writeFile(join(runDir, API_COVERAGE_FILE), JSON.stringify({ version: 1, reports, ...(evidenceId ? { evidenceId } : {}) }, null, 2));
  await writeFile(join(runDir, 'api-coverage.md'), reports.map(apiCoverageMarkdown).join('\n'));
  return { reports, ...(evidenceId ? { evidenceId } : {}) };
}

export async function loadApiCoverage(runDir: string): Promise<ApiCoverageReport[] | undefined> {
  const p = join(runDir, API_COVERAGE_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return (JSON.parse(await readFile(p, 'utf8')) as { reports: ApiCoverageReport[] }).reports;
  } catch {
    return undefined;
  }
}
