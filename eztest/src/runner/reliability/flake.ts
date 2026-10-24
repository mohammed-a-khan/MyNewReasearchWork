/**
 * Flake classifier. When a journey attempt fails and a retry passes, the
 * failure was not the product: this decides *why* from the failed attempt
 * (its error text, what its steps waited for or recovered from, its network
 * log) and from what the passing attempt had to wait for. The category is
 * stored on the passing result and in history, so the Quality Center can show
 * the root cause per flaky journey (timing, overlay, detached, network, data).
 */
import type { FlakeCause, FlakeClassification, JourneyResult, StepResult } from '../../core/index.js';
import { classifyEnvironmentFailure, type NetLogEntry } from './health.js';

interface Rule {
  re: RegExp;
  cause: FlakeCause;
  confidence: number;
  reason: string;
}

const RULES: Rule[] = [
  { re: /is covered by|covers the element|covered the element|obscured|overlay|backdrop|another element would receive the click/i, cause: 'overlay', confidence: 0.9, reason: 'an overlay covered the element' },
  { re: /no longer in the page|JavaScript context went away|not attached to the DOM|detached|re-rendered|stale element|Execution context was destroyed|lost its value/i, cause: 'detached', confidence: 0.85, reason: 'the element was re-rendered (detached) during the step' },
  { re: /ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED|ECONNRESET|ERR_CONNECTION|socket hang up|net::ERR_|returned 5\d\d|HTTP 5\d\d|status 5\d\d/i, cause: 'network', confidence: 0.85, reason: 'a network call failed or returned 5xx' },
  { re: /DATA_|data problem|No available|already exists|duplicate key|UNIQUE constraint|lease|ORA-00001|violates .* constraint|not found in the data/i, cause: 'data', confidence: 0.8, reason: 'test data was missing, already used or conflicting' },
  { re: /Timeout|timed out|still animating|keeps moving|not visible|is hidden|is disabled|still moving|post-condition failed|did not reach|waiting for/i, cause: 'timing', confidence: 0.7, reason: 'the app was not ready in time (slow response, animation or late rendering)' },
];

function failedLeaf(steps: StepResult[]): StepResult | undefined {
  let cur = steps.find((s) => s.status === 'failed' && !s.soft);
  while (cur?.children?.length) {
    const inner = cur.children.find((s) => s.status === 'failed' && !s.soft);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function allSteps(steps: StepResult[]): StepResult[] {
  const out: StepResult[] = [];
  const walk = (l?: StepResult[]) => l?.forEach((s) => { out.push(s); walk(s.children); });
  walk(steps);
  return out;
}

/** The dominant cause among recorded waits/recoveries of an attempt (weighted by time waited). */
export function causeFromRecords(steps: StepResult[]): { cause: FlakeCause; detail: string } | undefined {
  const weight = new Map<FlakeCause, number>();
  const detail = new Map<FlakeCause, string>();
  for (const s of allSteps(steps)) {
    for (const w of s.reliability?.waits ?? []) {
      weight.set(w.cause, (weight.get(w.cause) ?? 0) + Math.max(1, w.ms));
      if (!detail.has(w.cause)) detail.set(w.cause, `${s.stepId}: waited ${w.ms} ms (${w.detail ?? w.cause})`);
    }
    for (const r of s.reliability?.recovered ?? []) {
      weight.set(r.cause, (weight.get(r.cause) ?? 0) + 5000); // a recovery is a strong signal
      if (!detail.has(r.cause)) detail.set(r.cause, `${s.stepId}: ${r.detail}`);
    }
  }
  let best: FlakeCause | undefined;
  for (const [c, w] of weight) if (!best || w > (weight.get(best) ?? 0)) best = c;
  return best ? { cause: best, detail: detail.get(best)! } : undefined;
}

/**
 * Why did `failed` fail when `passed` (a later attempt) passed?
 * `network` is the failed attempt's network log (entries carry stepId).
 */
export function classifyFlake(failed: JourneyResult, passed: JourneyResult | undefined, network: NetLogEntry[] = []): FlakeClassification {
  const step = failedLeaf(failed.steps);
  const message = [step?.error?.message, failed.error?.message].filter(Boolean).join('\n');
  const base = {
    failedAttempt: failed.attempt,
    ...(step ? { failedStepId: step.stepId } : {}),
    ...(message ? { failedMessage: message.split('\n')[0].slice(0, 300) } : {}),
    evidence: [...new Set([...(step?.evidence ?? []), ...failed.evidence])],
  };
  // 1. What the failed attempt itself recorded (it had to recover, or waited out a cause and still failed).
  const rec = causeFromRecords(failed.steps);
  if (rec && rec.cause !== 'timing') return { cause: rec.cause, confidence: 0.9, reason: `failed attempt: ${rec.detail}`, ...base };
  // 2. The error text of the failing step.
  if (failed.reliability?.preconditions?.some((p) => !p.passed) || failed.error?.name === 'DataPrecondition') {
    return { cause: 'data', confidence: 0.9, reason: 'a data precondition did not hold on the failed attempt', ...base };
  }
  const env = classifyEnvironmentFailure(failed, network);
  if (env) return { cause: 'network', confidence: 0.85, reason: env, ...base };
  for (const r of RULES) if (r.re.test(message)) return { cause: r.cause, confidence: r.confidence, reason: `${r.reason}: ${message.split('\n')[0].slice(0, 160)}`, ...base };
  // 3. What the passing attempt had to wait for at the same step.
  const passRec = passed ? causeFromRecords(passed.steps.filter((s) => !step || s.stepId === step.stepId)) ?? causeFromRecords(passed.steps) : undefined;
  if (passRec) return { cause: passRec.cause, confidence: 0.6, reason: `the passing attempt had to wait: ${passRec.detail}`, ...base };
  if (rec) return { cause: rec.cause, confidence: 0.6, reason: `failed attempt: ${rec.detail}`, ...base };
  return { cause: step?.conditions.some((c) => !c.passed) ? 'timing' : 'unknown', confidence: 0.4, reason: message ? `unclassified failure: ${message.split('\n')[0].slice(0, 160)}` : 'no failure message', ...base };
}
