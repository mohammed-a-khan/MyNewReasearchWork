/**
 * Replay verification: run a recorded journey with the real runner and report,
 * step by step, what passed. Failing (or not-run) steps are always reported,
 * never dropped from the journey.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EzTestError, type RunResult, type StepStatus } from '../core/index.js';
import { runJourneys, type RunOptions } from '../runner/index.js';
import type { RecordingResult } from './compose.js';

export interface VerifiedStep {
  stepId: string;
  intent: string;
  status: StepStatus | 'missing';
  error?: string;
}

export interface VerificationReport {
  /** True when every recorded step passed (healed passes count, and are listed in `healed`). */
  passed: boolean;
  steps: VerifiedStep[];
  /** Steps that failed, or did not run because an earlier step failed. */
  failed: VerifiedStep[];
  healed: VerifiedStep[];
  run: RunResult;
}

export type VerifyOptions = Omit<RunOptions, 'outputDir'> & { outputDir?: string };

/**
 * Replay `result.journey` with `runJourneys`. Variables the recording needs
 * (e.g. `password`) must be supplied in `options.variables`, otherwise this
 * throws before running. `baseUrl` defaults to the recording's origin.
 */
export async function verifyRecording(result: RecordingResult, options: VerifyOptions = {}): Promise<VerificationReport> {
  const missing = result.variables.filter((v) => options.variables?.[v] === undefined);
  if (missing.length) {
    throw new EzTestError(
      `verifyRecording: supply ${missing.map((m) => `"${m}"`).join(', ')} in options.variables (recorded values are never stored)`,
      'MISSING_VARIABLE',
      { missing },
    );
  }
  const outputDir = options.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-record-verify-')));
  // An explicit baseUrl points the recording at another copy of the app, over the Base URL it was recorded with.
  const run = await runJourneys([result.journey], { ...options, outputDir, ...(options.baseUrl ? { baseUrlOverride: options.baseUrl } : { baseUrl: result.baseUrl }) });
  const jr = run.journeys[0];
  const byId = new Map(jr.steps.map((s) => [s.stepId, s]));
  const steps: VerifiedStep[] = result.journey.steps.map((s) => {
    const r = byId.get(s.id);
    if (!r) return { stepId: s.id, intent: s.intent, status: 'missing', error: jr.error?.message ?? 'step has no result' };
    return { stepId: s.id, intent: s.intent, status: r.status, ...(r.error ? { error: r.error.message } : {}) };
  });
  const failed = steps.filter((s) => s.status !== 'passed' && s.status !== 'passed-healed');
  const healed = steps.filter((s) => s.status === 'passed-healed');
  return { passed: failed.length === 0, steps, failed, healed, run };
}
