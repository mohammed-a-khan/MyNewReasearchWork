/** Helpers for the component-adapter e2e suites (real Chromium against examples/enterprise-app). */
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { prebuildClients, startEnterpriseApp, type EnterpriseApp } from '../../examples/enterprise-app/server.js';

export const TIMEOUTS = { stepTimeoutMs: 8000, locateTimeoutMs: 4000, conditionTimeoutMs: 4000 } as const;

export async function startApp(): Promise<EnterpriseApp> {
  await prebuildClients();
  return startEnterpriseApp();
}

export function describeSteps(j: JourneyResult): string {
  return flattenStepResults(j.steps)
    .map(({ result: s, depth }) => `${'  '.repeat(depth)}${s.stepId}: ${s.status} (${s.durationMs} ms)${s.error ? ` (${s.error.message})` : ''}`)
    .join('\n');
}

export interface EzRun {
  run: RunResult;
  j: JourneyResult;
  outputDir: string;
}

export async function runEz(baseUrl: string, ez: string, opts: Partial<RunOptions> = {}): Promise<EzRun> {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-comp-')));
  const run = await runJourneys([parseEzScript(ez)], { ...TIMEOUTS, baseUrl, outputDir, viewport: { width: 1280, height: 900 }, ...opts });
  return { run, j: run.journeys[0], outputDir };
}

export async function expectPasses(baseUrl: string, ez: string, opts: Partial<RunOptions> = {}): Promise<EzRun> {
  const r = await runEz(baseUrl, ez, opts);
  expect(r.j.status, `${r.j.error?.message ?? ''}\n${describeSteps(r.j)}`).toMatch(/^passed/);
  return r;
}

export interface ComponentEvidence {
  step: string;
  widget: string;
  op: string;
  adapter: string;
  library: string;
  rowKey?: string;
  row?: { key: string; cells: Record<string, string> };
  verified: string;
  ms: number;
  details?: Record<string, unknown>;
}

/** The evidence JSON a component step stored. */
export async function componentEvidence(r: EzRun, stepId: string, attempt = 1): Promise<ComponentEvidence> {
  const file = join(r.outputDir, r.run.runId, 'components', r.j.journeyId, `attempt-${attempt}`, `${stepId}.json`);
  expect(existsSync(file), `no component evidence at ${file}`).toBe(true);
  return JSON.parse(await readFile(file, 'utf8')) as ComponentEvidence;
}

/** Step results by id (top level). */
export function stepById(j: JourneyResult, id: string) {
  const s = flattenStepResults(j.steps).find((x) => x.result.stepId === id)?.result;
  expect(s, `no step ${id}: ${describeSteps(j)}`).toBeTruthy();
  return s!;
}
