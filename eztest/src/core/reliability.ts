/**
 * Reliability records carried by results: what a step waited for or
 * recovered from, why a flaky journey failed before it passed, environment
 * and data problems, dependencies and failure diagnoses. See docs/reliability.md.
 */

/** Root-cause categories of flakiness and of non-product failures. */
export type FlakeCause = 'timing' | 'overlay' | 'detached' | 'network' | 'data' | 'environment' | 'unknown';

export const FLAKE_CAUSES: readonly FlakeCause[] = ['timing', 'overlay', 'detached', 'network', 'data', 'environment', 'unknown'];

export interface StepReliability {
  /** Waits that were needed before the action could run (cause, how long, what). */
  waits: Array<{ cause: FlakeCause; ms: number; detail?: string }>;
  /** Problems the step recovered from (re-resolved a re-rendered element, re-typed a lost value, re-logged in...). */
  recovered: Array<{ cause: FlakeCause; detail: string }>;
}

export interface FlakeClassification {
  cause: FlakeCause;
  /** 0..1 */
  confidence: number;
  reason: string;
  /** The attempt that failed (the result itself is the passing attempt). */
  failedAttempt: number;
  failedStepId?: string;
  failedMessage?: string;
  /** Evidence ids (e.g. the flake-cause record, the failed attempt's screenshot). */
  evidence: string[];
}

export interface PreconditionResult {
  check: string;
  passed: boolean;
  message?: string;
}

export interface JourneyReliability {
  /** Set when an attempt failed and a retry passed: why the failed attempt failed. */
  flake?: FlakeClassification;
  /** The failure was the environment (5xx, DNS, connection, timeouts, health checks), not the product. */
  environment?: { reason: string; evidence: string[] };
  /** Requires: checks run before the journey. */
  preconditions?: PreconditionResult[];
  /** Depends on: prerequisites and the ledger values handed over. */
  dependsOn?: Array<{ journeyId: string; status: string; handoff: string[] }>;
  /** Transparent re-logins after the session expired mid-journey. */
  relogins?: Array<{ stepId: string; role: string; reason: string; evidence?: string }>;
  /** The pooled account this journey ran as. */
  account?: { role: string; account: string };
  /** Resource locks lost while the journey held them (its exclusive use of the resource is not guaranteed). */
  locksLost?: string[];
}

export interface CandidateDiagnosis {
  locator: string;
  matches: number;
  error?: string;
}

export interface SimilarElement {
  /** A locator that would select it, e.g. role=button "Save draft". */
  locator: string;
  description: string;
  score: number;
}

/** Everything needed to understand a failed step without opening other files. */
export interface FailureDiagnosis {
  expected: string;
  found: string;
  candidates: CandidateDiagnosis[];
  /** "Did you mean": the nearest similar elements on the page. */
  similar: SimilarElement[];
  consoleErrors: string[];
  failedRequests: string[];
  /**
   * Visible form fields the browser's own validation rejects (`:invalid`, with the browser's message),
   * after a click or key press: a form that never submitted because of a native constraint (required,
   * pattern, min/max, step) shows nothing in the page itself.
   */
  invalidFields?: string[];
  /** Elements outlined in the failure screenshot (the matches, else the nearest similar element). */
  outlined?: number;
  /** Evidence id of the screenshot with the target (or the nearest match) highlighted. */
  screenshot?: string;
  url?: string;
}

export interface HealthCheckResult {
  name: string;
  kind: 'url' | 'api' | 'db';
  ok: boolean;
  ms: number;
  message: string;
}

export interface RunHealth {
  /** Pre-flight checks; ok=false means nothing ran (environment problem). */
  preflight?: { ok: boolean; checks: HealthCheckResult[] };
  /** The circuit breaker opened mid-run: remaining journeys were not run. */
  circuit?: { openedAt: string; afterJourney: string; reason: string; notRun: number };
}
