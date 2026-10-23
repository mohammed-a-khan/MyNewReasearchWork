/**
 * Rule-based triage. Every failed journey is classified as product-bug,
 * test-issue, environment, data, flaky or unknown, with a confidence and the
 * evidence ids that support it. Citations are validated against the evidence
 * manifest; a candidate that cannot cite real evidence loses confidence.
 *
 * Rules are grouped into independent families (error text, execution
 * signals, network, history). The best candidate from a *different* family
 * acts as a deterministic second opinion: if it disagrees with the winner and
 * is close in confidence, the verdict is marked `needs-human`.
 */
import type { EvidenceRef, JourneyResult, RunResult, StepResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import type { NetworkEntry } from '../perf/network.js';
import type { NetworkLog } from './artifacts.js';
import type { FlakyScore } from './flaky.js';
import { failureSignature, clusterFailures, type FailureCluster } from './signature.js';
import { urlMatches } from './glob.js';

export type TriageCategory = 'product-bug' | 'test-issue' | 'environment' | 'data' | 'flaky' | 'unknown';
export type RuleFamily = 'error-text' | 'execution' | 'network' | 'history';

export interface TriageCandidate {
  category: TriageCategory;
  confidence: number;
  family: RuleFamily;
  rule: string;
  reason: string;
  evidence: string[];
}

export interface TriageVerdict {
  journeyId: string;
  journeyName: string;
  stepId?: string;
  category: TriageCategory;
  confidence: number;
  status: 'decided' | 'needs-human';
  reasons: string[];
  /** Evidence ids, all verified to exist in the manifest. */
  evidence: string[];
  signature?: string;
  winner?: TriageCandidate;
  secondOpinion?: TriageCandidate;
  candidates: TriageCandidate[];
}

export interface EndpointOwnership {
  /** URL patterns (see urlMatches) for endpoints the team owns: 5xx there is a product bug. */
  owned?: string[];
  /** URL patterns for third-party / infrastructure endpoints: 5xx there is environmental. */
  external?: string[];
}

export interface TriageInput {
  run: RunResult;
  /** The evidence manifest. Citations must refer to these ids. */
  evidence: EvidenceRef[];
  networkLogs?: NetworkLog[];
  flaky?: FlakyScore[];
  ownership?: EndpointOwnership;
}

export interface TriageOptions {
  /** Second opinion within this confidence distance and disagreeing -> needs-human. Default 0.15. */
  disagreementMargin?: number;
  /** Winners below this confidence -> needs-human. Default 0.5. */
  minConfidence?: number;
  clusterThreshold?: number;
}

export interface TriageReport {
  runId: string;
  verdicts: TriageVerdict[];
  clusters: FailureCluster[];
  counts: Record<TriageCategory, number>;
  needsHuman: number;
}

interface Pattern {
  re: RegExp;
  category: TriageCategory;
  confidence: number;
  rule: string;
  reason: string;
}

const ERROR_PATTERNS: Pattern[] = [
  { re: /heal was rejected in review/i, category: 'product-bug', confidence: 0.7, rule: 'rejected-heal', reason: 'the element changed in a way a reviewer rejected as a heal - suspected regression' },
  { re: /ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo|EAI_AGAIN/i, category: 'environment', confidence: 0.85, rule: 'dns-failure', reason: 'DNS resolution failed' },
  { re: /ECONNREFUSED|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED|TIMED_OUT)|ECONNRESET|socket hang up|EPIPE/i, category: 'environment', confidence: 0.85, rule: 'connection-failure', reason: 'connection to the server failed' },
  { re: /ERR_CERT_|certificate|self[- ]signed/i, category: 'environment', confidence: 0.75, rule: 'tls-failure', reason: 'TLS / certificate problem' },
  { re: /(?:page\.goto|navigation|waitForNavigation|waitForURL)[^\n]*timeout|timeout[^\n]*exceeded[^\n]*navigat|ETIMEDOUT/i, category: 'environment', confidence: 0.7, rule: 'navigation-timeout', reason: 'navigation timed out' },
  { re: /browser has been closed|Target (?:page, context or browser )?(?:has been )?closed|out of memory|ENOSPC/i, category: 'environment', confidence: 0.7, rule: 'infrastructure', reason: 'browser or host infrastructure failure' },
  { re: /UNIQUE constraint|duplicate key|ER_DUP_ENTRY|ORA-00001|violates (?:unique|foreign key|not-null|check) constraint|FOREIGN KEY constraint|NOT NULL constraint/i, category: 'data', confidence: 0.8, rule: 'data-constraint', reason: 'a data constraint was violated' },
  { re: /no (?:matching )?(?:record|row|data)s? (?:found|matched|available)|data need|test data (?:missing|exhausted)|already exists/i, category: 'data', confidence: 0.7, rule: 'data-missing', reason: 'required test data was missing or already used' },
  { re: /is covered by .*\(an overlay\)|intercepts pointer events/i, category: 'test-issue', confidence: 0.6, rule: 'overlay-blocked', reason: 'an overlay covered the element (dismiss it in the journey, or a dialog is stuck open)' },
  { re: /waiting for (?:locator|selector|getBy)|resolved to 0 elements|no element(?:s)? (?:matches|found)|element (?:is )?not found|strict mode violation|locator\.\w+: Timeout|not attached to the DOM/i, category: 'test-issue', confidence: 0.65, rule: 'locator-not-found', reason: 'the target element could not be located' },
  { re: /Unknown variable|ZodError|Invalid journey|is not a function|Cannot read propert(?:y|ies) of undefined/i, category: 'test-issue', confidence: 0.7, rule: 'test-code-error', reason: 'error in the test definition or test code' },
  { re: /expect\(|assert(?:ion)?(?:Error)? |expected .* (?:to|but)|toEqual|toBe|mismatch/i, category: 'product-bug', confidence: 0.55, rule: 'assertion-failed', reason: 'an assertion on application behaviour failed' },
];

const LOCATOR_FAILURE = /waiting for (?:locator|selector|getBy)|resolved to 0 elements|no element|not found|strict mode violation|locator\.\w+: Timeout/i;

const isStepFailure = (s: StepResult) => (s.status === 'failed' || s.status === 'blocked') && !s.soft;

/**
 * The step that failed the journey. Block steps (if/loops/sub-journeys) carry
 * their children: descend to the innermost failing child, which holds the real
 * error, evidence and heal. Soft (non-fatal) assertions are skipped.
 */
export function failingStep(j: Pick<JourneyResult, 'steps'>): StepResult | undefined {
  let cur = j.steps.find(isStepFailure);
  while (cur?.children?.length) {
    const inner = cur.children.find(isStepFailure);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function emptyCounts(): Record<TriageCategory, number> {
  return { 'product-bug': 0, 'test-issue': 0, environment: 0, data: 0, flaky: 0, unknown: 0 };
}

function ownershipOf(url: string, own: EndpointOwnership | undefined): 'owned' | 'external' | 'unknown' {
  if (!own) return 'unknown';
  if ((own.external ?? []).some((p) => urlMatches(p, url))) return 'external';
  if ((own.owned ?? []).some((p) => urlMatches(p, url))) return 'owned';
  return own.owned && own.owned.length > 0 ? 'external' : 'unknown';
}

function describeEntry(e: NetworkEntry): string {
  let path = e.url;
  try {
    const u = new URL(e.url);
    path = `${u.host}${u.pathname}`; // never include query strings (may carry tokens)
  } catch {
    /* keep raw */
  }
  return `${e.method} ${path}`;
}

/** Classify a single failed journey. Exposed for callers who triage incrementally. */
export function triageJourney(
  j: JourneyResult,
  input: TriageInput,
  opts: TriageOptions = {},
): TriageVerdict {
  const margin = opts.disagreementMargin ?? 0.15;
  const minConfidence = opts.minConfidence ?? 0.5;
  const known = new Set(input.evidence.map((e) => e.id));
  const step = failingStep(j);
  const stepIds = new Set(j.steps.map((s) => s.stepId));
  const valid = (ids: Array<string | undefined>) => [...new Set(ids.filter((x): x is string => !!x && known.has(x)))];

  const journeyEvidence = valid([
    ...j.evidence,
    ...input.evidence.filter((e) => e.journeyId === j.journeyId).map((e) => e.id),
  ]);
  const stepEvidence = step
    ? valid([
        ...step.evidence,
        ...(step.heal?.evidence ?? []),
        ...input.evidence.filter((e) => e.journeyId === j.journeyId && e.stepId === step.stepId).map((e) => e.id),
      ])
    : [];
  const baseEvidence = stepEvidence.length ? stepEvidence : journeyEvidence;

  const candidates: TriageCandidate[] = [];
  const add = (c: TriageCandidate) => {
    const cited = valid(c.evidence);
    // Uncited candidates are kept but heavily discounted: a verdict must point at evidence.
    candidates.push({ ...c, evidence: cited, confidence: cited.length ? c.confidence : Math.min(c.confidence, 0.3) });
  };

  // ---- error-text family
  const message = [step?.error?.message, j.error?.message].filter(Boolean).join('\n');
  if (message) {
    for (const p of ERROR_PATTERNS) {
      if (p.re.test(message)) {
        add({ category: p.category, confidence: p.confidence, family: 'error-text', rule: p.rule, reason: p.reason, evidence: baseEvidence });
        break; // first (most specific) match wins within the family
      }
    }
  }

  // ---- reliability records (runner): data preconditions and classified environment failures
  const rel = j.reliability;
  if (j.error?.name === 'DataPrecondition' || rel?.preconditions?.some((p) => !p.passed)) {
    const bad = rel?.preconditions?.filter((p) => !p.passed).map((p) => `${p.check}${p.message ? ` (${p.message})` : ''}`).join('; ');
    add({ category: 'data', confidence: 0.95, family: 'execution', rule: 'data-precondition', reason: `data problem, not a product failure: ${bad || j.error?.message || 'a data precondition did not hold'}`, evidence: journeyEvidence });
  }
  if (rel?.environment) {
    const strong = /50[234]|DNS|refused|connection|timed out|TLS|network level/i.test(rel.environment.reason);
    add({ category: 'environment', confidence: strong ? 0.9 : 0.7, family: 'network', rule: 'environment-failure', reason: `environment failure, not a product failure: ${rel.environment.reason}`, evidence: [...rel.environment.evidence, ...baseEvidence] });
  }

  // ---- execution-signal family
  if (step) {
    const failedConds = step.conditions.filter((c) => !c.passed);
    const locatorFailed = !!step.error && LOCATOR_FAILURE.test(step.error.message);
    if (step.heal && !step.heal.verified) {
      add({
        category: 'test-issue',
        confidence: 0.7,
        family: 'execution',
        rule: 'heal-unverified',
        reason: `heal (${step.heal.tier}, confidence ${step.heal.confidence.toFixed(2)}) could not be verified by post-conditions; the locator needs a reviewed update`,
        evidence: [...stepEvidence, ...step.heal.evidence],
      });
    } else if (locatorFailed && !step.usedLocator) {
      add({ category: 'test-issue', confidence: 0.7, family: 'execution', rule: 'locator-unresolved', reason: 'no locator candidate resolved the target and healing did not recover it', evidence: stepEvidence });
    } else if (failedConds.length > 0 && (step.usedLocator || !step.error || step.heal?.verified === true)) {
      const desc = failedConds.map((c) => `${c.condition.type}${c.actual !== undefined ? ` (actual: ${String(c.actual).slice(0, 80)})` : ''}`).join(', ');
      add({
        category: 'product-bug',
        confidence: 0.75,
        family: 'execution',
        rule: 'suspected-regression',
        reason: `the element was found and the action ran, but post-condition(s) failed: ${desc} - suspected regression`,
        evidence: stepEvidence,
      });
    }
  }

  // ---- network family
  const logs = (input.networkLogs ?? []).filter(
    (l) => l.journeyId === j.journeyId || (l.journeyId === undefined && l.stepId !== undefined && stepIds.has(l.stepId)),
  );
  let netDone = false;
  for (const log of logs) {
    if (netDone) break;
    for (const e of log.entries) {
      if (e.failure && e.status === 0) {
        add({ category: 'environment', confidence: 0.75, family: 'network', rule: 'request-failed', reason: `${describeEntry(e)} failed at network level (${e.failure.slice(0, 80)})`, evidence: [log.evidenceId] });
        netDone = true;
        break;
      }
      if (e.status >= 500) {
        const owner = ownershipOf(e.url, input.ownership);
        if (owner === 'owned') {
          add({ category: 'product-bug', confidence: 0.85, family: 'network', rule: 'owned-5xx', reason: `${describeEntry(e)} returned HTTP ${e.status} from an endpoint the team owns`, evidence: [log.evidenceId] });
        } else if (owner === 'external') {
          add({ category: 'environment', confidence: 0.85, family: 'network', rule: 'external-5xx', reason: `${describeEntry(e)} returned HTTP ${e.status} from an external/infrastructure endpoint`, evidence: [log.evidenceId] });
        } else {
          add({ category: 'environment', confidence: 0.55, family: 'network', rule: 'unowned-5xx', reason: `${describeEntry(e)} returned HTTP ${e.status} (no endpoint ownership configured)`, evidence: [log.evidenceId] });
        }
        netDone = true;
        break;
      }
      if (e.status === 409 || e.status === 422) {
        add({ category: 'data', confidence: 0.6, family: 'network', rule: 'data-conflict', reason: `${describeEntry(e)} returned HTTP ${e.status} (conflict / unprocessable data)`, evidence: [log.evidenceId] });
        netDone = true;
        break;
      }
    }
  }

  // ---- history family
  const hist = input.flaky?.find((f) => f.journeyId === j.journeyId);
  if (hist?.state === 'flaky') {
    add({ category: 'flaky', confidence: 0.7, family: 'history', rule: 'history-flaky', reason: `history: ${hist.reasons[0] ?? 'flaky'}`, evidence: baseEvidence });
  } else if (hist?.state === 'broken') {
    add({ category: 'product-bug', confidence: 0.4, family: 'history', rule: 'history-broken', reason: `history: ${hist.reasons[0] ?? 'consistently failing'}`, evidence: baseEvidence });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const winner = candidates[0];
  const second = winner ? candidates.find((c) => c.family !== winner.family && c.category !== winner.category) : undefined;

  let signature: string | undefined;
  const errMsg = step?.error?.message ?? j.error?.message;
  if (errMsg) signature = failureSignature({ message: errMsg, stack: step?.error?.stack ?? j.error?.stack, name: step?.error?.name ?? j.error?.name }).hash;

  if (!winner) {
    return {
      journeyId: j.journeyId,
      journeyName: j.name,
      stepId: step?.stepId,
      category: 'unknown',
      confidence: 0,
      status: 'needs-human',
      reasons: ['no triage rule matched this failure'],
      evidence: baseEvidence,
      signature,
      candidates,
    };
  }
  const reasons = [winner.reason];
  let status: TriageVerdict['status'] = 'decided';
  if (winner.evidence.length === 0) {
    status = 'needs-human';
    reasons.push('no valid evidence id could be cited');
  }
  if (winner.confidence < minConfidence) {
    status = 'needs-human';
    reasons.push(`confidence ${winner.confidence.toFixed(2)} below ${minConfidence}`);
  }
  if (second && winner.confidence - second.confidence < margin - 1e-9) {
    status = 'needs-human';
    reasons.push(`second opinion (${second.family}/${second.rule}) says ${second.category}: ${second.reason}`);
  }
  return {
    journeyId: j.journeyId,
    journeyName: j.name,
    stepId: step?.stepId,
    category: winner.confidence < minConfidence ? 'unknown' : winner.category,
    confidence: winner.confidence,
    status,
    reasons,
    evidence: winner.evidence,
    signature,
    winner,
    secondOpinion: second,
    candidates,
  };
}

/** Triage every failed/errored journey of a run. */
export function triageRun(input: TriageInput, opts: TriageOptions = {}): TriageReport {
  if (!input.run || !Array.isArray(input.run.journeys)) throw new EzTestError('triageRun requires a RunResult', 'INVALID_INPUT');
  if (input.run.journeys.length === 0) throw new EzTestError('triageRun: run has no journeys', 'INVALID_INPUT');
  const failed = input.run.journeys.filter((j) => j.status === 'failed' || j.status === 'error');
  const verdicts = failed.map((j) => triageJourney(j, input, opts));
  const counts = emptyCounts();
  for (const v of verdicts) counts[v.category]++;
  const items = failed
    .map((j) => {
      const s = failingStep(j);
      const err = s?.error ?? j.error;
      return err?.message ? { id: j.journeyId, message: err.message, stack: err.stack, name: err.name } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  return {
    runId: input.run.runId,
    verdicts,
    clusters: clusterFailures(items, { threshold: opts.clusterThreshold }),
    counts,
    needsHuman: verdicts.filter((v) => v.status === 'needs-human').length,
  };
}

/** Throw if any verdict cites an evidence id that does not exist. */
export function assertCitations(report: TriageReport, evidence: EvidenceRef[]): void {
  const known = new Set(evidence.map((e) => e.id));
  for (const v of report.verdicts) {
    for (const id of v.evidence) {
      if (!known.has(id)) throw new EzTestError(`Triage verdict for ${v.journeyId} cites unknown evidence ${id}`, 'INVALID_CITATION');
    }
  }
}
