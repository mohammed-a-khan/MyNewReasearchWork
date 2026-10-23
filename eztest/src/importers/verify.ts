/**
 * Replay-verified conversion. Imported journeys are only "verified" after a
 * real run: `verifyImported` runs them with the EZTest runner and records
 * per-step pass/fail; `coverageEquivalence` combines that with the import
 * report into what was converted AND verified versus what still needs work.
 */
import type { Journey, JourneyStatus, RunResult, StepStatus } from '../core/index.js';
import { runJourneys, type RunOptions } from '../runner/index.js';
import type { ImportReport } from './types.js';

export interface VerifiedStep {
  stepId: string;
  intent: string;
  status: StepStatus;
  /** Post-conditions declared on the step and how many held. */
  conditions: number;
  conditionsPassed: number;
  error?: string;
}

export interface VerifiedJourney {
  journeyId: string;
  name: string;
  status: JourneyStatus;
  /** True only when the journey ran and every step passed without healing. */
  verified: boolean;
  steps: VerifiedStep[];
  error?: string;
}

export interface ImportVerification {
  runId: string;
  journeys: VerifiedJourney[];
  summary: { journeys: number; verifiedJourneys: number; steps: number; passedSteps: number; failedSteps: number; otherSteps: number };
  run: RunResult;
}

/** Run imported journeys for real and report per-journey / per-step outcomes. */
export async function verifyImported(input: Journey[] | ImportReport, options: RunOptions): Promise<ImportVerification> {
  const imported = Array.isArray(input) ? input : input.journeys;
  // @library journeys (imported step definitions) are callable sub-journeys, not tests of their own.
  const journeys = imported.filter((j) => !j.tags.includes('library'));
  const library = imported.filter((j) => j.tags.includes('library'));
  if (!journeys.length) throw new Error('verifyImported: no imported journeys to run');
  const run = await runJourneys(journeys, library.length ? { ...options, library: [...(options.library ?? []), ...library] } : options);
  const byId = new Map(journeys.map((j) => [j.id, j]));
  // Data-driven journeys run once per Examples row, as "<id>-<row>".
  const sourceOf = (id: string) => byId.get(id) ?? journeys.find((j) => (j.examples?.length || j.examplesFrom) && id.startsWith(`${j.id}-`));
  const out: VerifiedJourney[] = run.journeys.map((jr) => {
    const j = sourceOf(jr.journeyId);
    const steps: VerifiedStep[] = jr.steps.map((sr) => {
      const declared = j?.steps.find((s) => s.id === sr.stepId)?.postconditions.length ?? 0;
      const own = sr.conditions.slice(0, declared);
      return {
        stepId: sr.stepId, intent: sr.intent, status: sr.status, conditions: declared,
        conditionsPassed: own.filter((c) => c.passed).length, ...(sr.error ? { error: sr.error.message } : {}),
      };
    });
    return {
      journeyId: jr.journeyId, name: jr.name, status: jr.status,
      verified: jr.status === 'passed' && steps.length > 0 && steps.every((s) => s.status === 'passed'),
      steps, ...(jr.error ? { error: jr.error.message } : {}),
    };
  });
  const all = out.flatMap((j) => j.steps);
  return {
    runId: run.runId,
    journeys: out,
    summary: {
      journeys: out.length,
      verifiedJourneys: out.filter((j) => j.verified).length,
      steps: all.length,
      passedSteps: all.filter((s) => s.status === 'passed').length,
      failedSteps: all.filter((s) => s.status === 'failed' || s.status === 'blocked').length,
      otherSteps: all.filter((s) => s.status !== 'passed' && s.status !== 'failed' && s.status !== 'blocked').length,
    },
    run,
  };
}

/**
 * The verification of an imported journey. A data-driven journey runs once per Examples row
 * (ids `<id>-<row>`): it is verified only when every row instance is.
 */
export function verifiedRunOf(id: string, dataDriven: boolean, verification?: ImportVerification): VerifiedJourney | undefined {
  if (!verification) return undefined;
  const exact = verification.journeys.find((j) => j.journeyId === id);
  if (exact || !dataDriven) return exact;
  const rows = verification.journeys.filter((j) => j.journeyId.startsWith(`${id}-`));
  if (!rows.length) return undefined;
  const bad = rows.find((r) => !r.verified);
  return { ...(bad ?? rows[0]), journeyId: id, verified: !bad };
}

export type EquivalenceStatus =
  /** Fully converted and every step passed in a real run. */
  | 'equivalent'
  /** Every converted step passed, but some source steps are TODO. */
  | 'verified-partial'
  /** Ran and failed (or healed) — needs work. */
  | 'failed'
  /** Converted but not part of the verification run. */
  | 'not-run'
  /** Nothing convertible: no journey was produced. */
  | 'not-converted';

export interface JourneyEquivalence {
  id: string;
  name: string;
  file: string;
  status: EquivalenceStatus;
  sourceSteps: number;
  convertedSteps: number;
  verifiedSteps: number;
  assertions: number;
  convertedAssertions: number;
  verifiedAssertions: number;
  todo: number;
  failures: string[];
}

export interface CoverageEquivalence {
  totals: {
    sourceSteps: number;
    convertedSteps: number;
    verifiedSteps: number;
    assertions: number;
    convertedAssertions: number;
    verifiedAssertions: number;
    todo: number;
  };
  /** Fractions 0..1 over source steps + assertions. */
  ratios: { converted: number; verified: number };
  journeys: JourneyEquivalence[];
  /** Human-readable list of what still needs attention. */
  needsWork: string[];
}

/** Summarise what was converted AND verified versus what needs work. */
export function coverageEquivalence(report: ImportReport, verification?: ImportVerification): CoverageEquivalence {
  const ran = new Map((verification?.journeys ?? []).map((j) => [j.journeyId, j]));
  const runOf = (c: ImportReport['converted'][number]) => verifiedRunOf(c.id, !!(c.journey?.examples?.length || c.journey?.examplesFrom), verification);
  const journeys: JourneyEquivalence[] = report.converted.map((c) => {
    const v = c.journey ? ran.get(c.id) ?? runOf(c) : undefined;
    // Steps that were actions vs. standalone assert steps, from the parsed journey.
    const actionIds = new Set((c.journey?.steps ?? []).filter((s) => s.action !== 'assert').map((s) => s.id));
    const verifiedSteps = v ? v.steps.filter((s) => s.status === 'passed' && actionIds.has(s.stepId)).length : 0;
    const verifiedAssertions = v ? Math.min(c.coverage.convertedAssertions, v.steps.filter((s) => s.status === 'passed').reduce((n, s) => n + s.conditionsPassed, 0)) : 0;
    const failures = v ? v.steps.filter((s) => s.status !== 'passed').map((s) => `${s.stepId} (${s.status})${s.error ? `: ${s.error}` : ''}`) : [];
    if (v?.error) failures.unshift(v.error);
    let status: EquivalenceStatus;
    if (!c.journey) status = 'not-converted';
    else if (!v) status = 'not-run';
    else if (!v.verified) status = 'failed';
    else status = c.todo.length ? 'verified-partial' : 'equivalent';
    return {
      id: c.id, name: c.name, file: c.file, status,
      sourceSteps: c.coverage.sourceSteps, convertedSteps: c.coverage.convertedSteps, verifiedSteps,
      assertions: c.coverage.assertions, convertedAssertions: c.coverage.convertedAssertions, verifiedAssertions,
      todo: c.todo.length, failures,
    };
  });
  const sum = (k: keyof JourneyEquivalence) => journeys.reduce((n, j) => n + (j[k] as number), 0);
  const fileTodos = report.todo.filter((t) => !t.journeyId).length;
  const totals = {
    sourceSteps: sum('sourceSteps') + fileTodos, convertedSteps: sum('convertedSteps'), verifiedSteps: sum('verifiedSteps'),
    assertions: sum('assertions'), convertedAssertions: sum('convertedAssertions'), verifiedAssertions: sum('verifiedAssertions'),
    todo: report.todo.length,
  };
  const denom = totals.sourceSteps + totals.assertions;
  const needsWork: string[] = [];
  for (const j of journeys) {
    if (j.status === 'not-converted') needsWork.push(`${j.name} (${j.file}): nothing could be converted (${j.todo} TODO)`);
    else if (j.status === 'failed') needsWork.push(`${j.name} (${j.file}): replay failed — ${j.failures[0] ?? 'see run'}`);
    else if (j.status === 'not-run') needsWork.push(`${j.name} (${j.file}): converted but not verified by a run`);
    else if (j.status === 'verified-partial') needsWork.push(`${j.name} (${j.file}): verified, but ${j.todo} source step(s) still TODO`);
  }
  for (const t of report.todo.filter((x) => !x.journeyId)) needsWork.push(`${t.file}:${t.line}: ${t.reason}`);
  return {
    totals,
    ratios: {
      converted: denom ? (totals.convertedSteps + totals.convertedAssertions) / denom : 0,
      verified: denom ? (totals.verifiedSteps + totals.verifiedAssertions) / denom : 0,
    },
    journeys,
    needsWork,
  };
}
