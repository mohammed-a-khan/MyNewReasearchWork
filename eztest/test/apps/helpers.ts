/** Shared helpers for the packaged-app pack tests. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Journey, RunResult } from '../../src/core/index.js';
import { runJourneys } from '../../src/runner/index.js';
import type { CustomStepHandler } from '../../src/runner/types.js';

/**
 * Per-test budget for the pack suites: several journeys run in one browser per test. On Firefox
 * (WebDriver BiDi) each step costs 3-6x the Chromium round trips, and in the full parallel suite
 * these tests outgrow the suite's 60 s default although every step passes (measured alone: 24 s vs 4.5 s).
 */
export const PACK_SUITE_TIMEOUT_MS = 180_000;

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `eztest-apps-${prefix}-`));
}

export async function runPack(journeys: Journey[], customSteps: Record<string, CustomStepHandler>, baseUrl: string, outputDir?: string): Promise<RunResult> {
  return runJourneys(journeys, {
    baseUrl,
    outputDir: outputDir ?? (await tempDir('run')),
    stepTimeoutMs: 10_000,
    locateTimeoutMs: 2000,
    conditionTimeoutMs: 3000,
    customSteps,
  });
}

/** "stepId:status:error" lines, for readable assertion failures. */
export function stepLines(run: RunResult, i = 0): string[] {
  return run.journeys[i].steps.map((s) => `${s.stepId}:${s.status}${s.error ? `:${s.error.message}` : ''}`);
}

export function allLines(run: RunResult, i = 0): string[] {
  return run.journeys[i].steps.map((s) => `${s.stepId}:passed`);
}
