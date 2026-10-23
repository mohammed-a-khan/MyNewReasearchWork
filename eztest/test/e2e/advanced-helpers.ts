/** Helpers for the advanced-automation e2e suites (real Chromium against the demo app's /lab pages). */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';

export const FAST = { stepTimeoutMs: 6000, locateTimeoutMs: 2000, conditionTimeoutMs: 3000 } as const;

export async function outDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `eztest-adv-${prefix}-`));
}

/** One line per step (nested steps indented), for readable assertion failures. */
export function describeSteps(j: JourneyResult): string {
  return flattenStepResults(j.steps)
    .map(({ result: s, depth }) => `${'  '.repeat(depth)}${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`)
    .join('\n');
}

/** Parse and run one .ez journey; returns the run and its only journey result. */
export async function runEz(baseUrl: string, ez: string, opts: Partial<RunOptions> = {}): Promise<{ run: RunResult; j: JourneyResult }> {
  const journey = parseEzScript(ez);
  const run = await runJourneys([journey], { ...FAST, baseUrl, outputDir: opts.outputDir ?? (await outDir('run')), ...opts });
  return { run, j: run.journeys[0] };
}

/** Run and expect every step to pass. */
export async function expectPasses(baseUrl: string, ez: string, opts: Partial<RunOptions> = {}): Promise<{ run: RunResult; j: JourneyResult }> {
  const r = await runEz(baseUrl, ez, opts);
  expect(r.j.status, `${r.j.error?.message ?? ''}\n${describeSteps(r.j)}`).toMatch(/^passed/);
  return r;
}
