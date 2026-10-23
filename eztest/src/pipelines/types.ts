/** Types of the `pipelines:` mapping and of deployment test records (docs/pipelines.md). */

/** What one deployment pipeline run tested, recorded on the results server. */
export interface DeploymentRecord {
  /** Stable id: `<environment>:<version>:<runId>` unless given. */
  id: string;
  recordedAt: string;
  recordedBy?: string;
  /** The application under test (default: the EZTest project). */
  app?: string;
  /** App version or build number that was deployed. */
  version: string;
  environment: string;
  /** The `pipelines:` entry that chose the journeys. */
  pipeline: string;
  /** CI system, stage and links. */
  ci?: { system: string; stage?: string; buildId?: string; buildNumber?: string; url?: string; commit?: string; branch?: string; releaseId?: string };
  selection: { journeys: string[]; total: number; tags?: string; reasons?: string[]; shards?: number; browsers?: string[] };
  results: { total: number; passed: number; passedHealed: number; failed: number; skipped: number; errors: number };
  readiness?: { decision: string; score?: number; failingGates?: string[] };
  runId?: string;
  evidence?: { runUrl?: string; reportUrl?: string; buildUrl?: string; testRunUrl?: string; evidenceHead?: string; artifacts?: string[] };
  testPlan?: { planId?: number; suiteId?: number; testRunId?: number; results?: number };
}
