/**
 * Run results. "passed-healed" is a first-class status: a healed step is never
 * reported as a plain pass, so dashboards and flaky scoring can tell them apart.
 */
import type { Condition, LocatorCandidate } from './journey.js';
import type { FailureDiagnosis, JourneyReliability, RunHealth, StepReliability } from './reliability.js';

export type StepStatus = 'passed' | 'passed-healed' | 'failed' | 'skipped' | 'blocked';
export type JourneyStatus = 'passed' | 'passed-healed' | 'failed' | 'skipped' | 'error';

export type EvidenceKind =
  | 'screenshot'
  | 'dom'
  | 'aria'
  | 'network'
  | 'console'
  | 'trace'
  | 'video'
  | 'video-chapters'
  | 'download'
  | 'data'
  | 'document'
  | 'report'
  | 'log';

export interface EvidenceRef {
  /** Stable id, e.g. "E-12". Triage and readiness verdicts cite these ids. */
  id: string;
  kind: EvidenceKind;
  /** Path relative to the run directory. */
  path: string;
  sha256: string;
  stepId?: string;
  journeyId?: string;
  description?: string;
  createdAt: string;
}

export type HealTier = 'T0-cache' | 'T1-fingerprint' | 'T2-semantic' | 'T3-ai';

export interface HealRecord {
  stepId: string;
  tier: HealTier;
  original: LocatorCandidate[];
  healed: LocatorCandidate;
  confidence: number;
  /** True only when every post-condition held after the healed action. */
  verified: boolean;
  reason: string;
  evidence: string[];
  /** Shared repository element the step used (`Checkout.placeOrder`): accepting the heal updates elements/*.yaml. */
  element?: string;
  /** The heal is of the step target's i-th scope anchor or container (`below "Email"`), not of the element itself. */
  anchor?: number;
}

export interface ConditionResult {
  condition: Condition;
  passed: boolean;
  actual?: string;
  message?: string;
}

export interface StepResult {
  stepId: string;
  intent: string;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  conditions: ConditionResult[];
  heal?: HealRecord;
  error?: { message: string; name?: string; stack?: string };
  evidence: string[];
  /** Locator that actually resolved the target (for reports and heal proposals). */
  usedLocator?: LocatorCandidate;
  captured?: Record<string, unknown>;
  /** Results of a block's child steps (if/loops/try/frame blocks/sub-journeys), in execution order. */
  children?: StepResult[];
  /** 1-based loop iteration or retry attempt this result belongs to (children of loops). */
  iteration?: number;
  /** Which branch of a block a child ran in. */
  branch?: 'then' | 'else' | 'catch' | 'body';
  /** A soft assertion: its failure did not stop the journey. */
  soft?: boolean;
  /** Non-fatal notes (e.g. an unexpected dialog was dismissed). */
  warnings?: string[];
  /** Set when a non-browser surface executed the step: which driver, and which rung of the ladder acted. */
  surface?: SurfaceUse;
  /** What the step waited for or recovered from (overlays, re-renders, busy app). */
  reliability?: StepReliability;
  /** Failure diagnosis: expected vs found, candidate match counts, "did you mean", console and network errors. */
  diagnosis?: FailureDiagnosis;
  /** A verified, more robust locator for this step's target (reviewable, never applied silently). */
  improvement?: { suggested: LocatorCandidate; score: number; currentScore: number; reason: string };
  /** Multi-actor journeys: the actor whose session ran the step (docs/multi-actor.md). */
  actor?: string;
  /** Set for `Manual:` steps: the tester's verdict, notes and attachments (see docs/manual-testing.md). */
  manual?: ManualStepRecord;
  /** Gherkin scenarios (docs/bdd.md): the feature-file step or hook this result belongs to, and what it was bound to. */
  gherkin?: GherkinStepRecord;
}

/** How a Gherkin step (or hook) of a `.feature` scenario ran. */
export interface GherkinStepRecord {
  kind: 'step' | 'before' | 'after';
  /** Steps: the keyword as written ("Given", "And", "*"). */
  keyword?: string;
  /** Steps: the step text (with the Examples row's values). */
  text?: string;
  /** Line in the feature file (steps), or of the hook in its file. */
  line: number;
  /** Comes from a Background. */
  background?: boolean;
  /**
   * definition: a step definition ran; ez: the EZTest phrasing fallback ran; undefined / ambiguous: nothing ran.
   * hook: a Before / After hook.
   */
  match?: 'definition' | 'ez' | 'undefined' | 'ambiguous' | 'hook';
  /** `file:line` of the step definition or hook, or the grammar rule of the EZTest phrasing. */
  location?: string;
  /** The definition's pattern. */
  pattern?: string;
  /** Undefined steps: a step definition to paste. */
  snippet?: string;
}

/** Where a Gherkin scenario's result belongs: feature, rule, scenario and Examples row (docs/bdd.md). */
export interface JourneyBddRecord {
  /** Feature file, relative to the project (forward slashes). */
  file: string;
  feature: { name: string; line: number };
  rule?: { name: string; line: number };
  scenario: { name: string; line: number; keyword: string };
  examples?: { name: string; line: number; row?: { line: number; index: number } };
}

/** A tester's verdict on a manual step. Notes are masked; attachments are evidence ids. */
export interface ManualStepRecord {
  verdict: 'passed' | 'failed' | 'blocked' | 'skipped' | 'pending';
  instruction: string;
  expected: string[];
  /** What the tester observed (free text, masked). */
  actual?: string;
  notes?: string;
  tester?: string;
  /** When the verdict was given. */
  at?: string;
  /** Evidence ids of screenshots and files the tester attached. */
  attachments: string[];
  /** Hybrid journeys: evidence id of the page screenshot shown to the tester at the pause. */
  pageScreenshot?: string;
}

/** Manual / hybrid summary of a journey result. */
export interface JourneyManualSummary {
  type: 'manual' | 'hybrid';
  /** Manual steps that got a verdict. */
  executed: number;
  /** Manual steps that did not get one (no tester attached, cancelled, ended early). */
  pending: number;
  testers: string[];
  assignee?: string;
}

/** Desktop/legacy driver ladder: the surface and rung that executed a step (see docs/desktop-and-legacy.md). */
export interface SurfaceUse {
  /** electron | windows | java | sap | tn3270 | tn5250 | vision */
  driver: string;
  /** object: a semantic element; field: a terminal field by label or position; ocr / image: pixels. */
  rung: 'object' | 'field' | 'ocr' | 'image' | 'coordinates';
  /** How the element was found, e.g. 'AutomationId "SaveBtn"' or 'label "USERID" at row 5 column 10'. */
  via?: string;
  /** Screen box (pixels or row/column cells) that was acted on or matched. */
  box?: { x: number; y: number; width: number; height: number };
}

export interface JourneyResult {
  journeyId: string;
  name: string;
  status: JourneyStatus;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  tags: string[];
  requirements: string[];
  risk: number;
  attempt: number;
  browser?: string;
  ledger: Record<string, unknown>;
  evidence: string[];
  error?: { message: string; name?: string; stack?: string };
  /** Flake root cause, environment/data problems, dependencies, re-logins, pooled account. */
  reliability?: JourneyReliability;
  /** Present for manual and hybrid journeys. */
  manual?: JourneyManualSummary;
  /** Present for Gherkin scenarios (`.feature` files): feature, rule, scenario and Examples row. */
  bdd?: JourneyBddRecord;
}

export interface RunSummary {
  total: number;
  passed: number;
  passedHealed: number;
  failed: number;
  skipped: number;
  errors: number;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  journeys: JourneyResult[];
  summary: RunSummary;
  environment: Record<string, string>;
  /** Hash of the evidence manifest head, see EvidenceVault. */
  evidenceHead?: string;
  /** Pre-flight environment health and the circuit breaker. */
  health?: RunHealth;
  /** Cross-browser runs: the summary of each browser (journey x browser units); `summary` is the combined one. */
  browsers?: Record<string, RunSummary & { version?: string }>;
}

export function summarize(journeys: JourneyResult[]): RunSummary {
  const s: RunSummary = { total: journeys.length, passed: 0, passedHealed: 0, failed: 0, skipped: 0, errors: 0 };
  for (const j of journeys) {
    if (j.status === 'passed') s.passed++;
    else if (j.status === 'passed-healed') s.passedHealed++;
    else if (j.status === 'failed') s.failed++;
    else if (j.status === 'skipped') s.skipped++;
    else s.errors++;
  }
  return s;
}

/** A journey's status is the worst of its step statuses. */
export function journeyStatusFrom(steps: StepResult[]): JourneyStatus {
  if (steps.length === 0) return 'error';
  if (steps.some((s) => s.status === 'failed' || s.status === 'blocked')) return 'failed';
  if (steps.every((s) => s.status === 'skipped')) return 'skipped';
  if (steps.some((s) => s.status === 'passed-healed')) return 'passed-healed';
  return 'passed';
}
