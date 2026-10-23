/**
 * Failure classification across runs (smart tags), computed from the history
 * store's outcomes and failure signatures:
 *
 * - new-failure:    fails now, and did not fail in the previous N runs it ran in
 *                   (and it has run before);
 * - always-failing: failed with the same signature in each of its last K runs;
 * - regressed:      fails now, passed in the run just before;
 * - flaky:          fails now, but its recent history flips between pass and fail.
 *
 * Plus unique-error grouping: failures of one run grouped by signature, so
 * one broken component that fails ten journeys reads as one error.
 */
import type { RunResult } from '../core/index.js';
import type { RunHistoryEntry } from './history.js';
import { failureSignature } from './signature.js';

export type FailureTag = 'new-failure' | 'always-failing' | 'regressed' | 'flaky';

export interface JourneyFailureTags {
  journeyId: string;
  tags: FailureTag[];
  /** Consecutive failing runs ending with this one. */
  failingStreak: number;
  /** Runs looked at (this one included). */
  window: number;
  signature?: string;
}

export interface FailureTagOptions {
  /** How far back "new" looks (runs the journey ran in). Default 10. */
  newWindow?: number;
  /** Consecutive failures with one signature that make "always failing". Default 3. */
  alwaysAfter?: number;
}

const FAIL = (s: string) => s === 'failed' || s === 'error';
const PASS = (s: string) => s === 'passed' || s === 'passed-healed';

/** Tags for every failing journey of `runId`, from history entries (oldest first, the run included). */
export function failureTags(runs: readonly RunHistoryEntry[], runId: string, opts: FailureTagOptions = {}): JourneyFailureTags[] {
  const newWindow = opts.newWindow ?? 10;
  const alwaysAfter = Math.max(2, opts.alwaysAfter ?? 3);
  const ordered = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const at = ordered.findIndex((r) => r.runId === runId);
  if (at < 0) return [];
  const upto = ordered.slice(0, at + 1);
  const run = ordered[at];
  const out: JourneyFailureTags[] = [];
  const lastOf = (r: RunHistoryEntry, id: string) => {
    const mine = r.outcomes.filter((o) => o.journeyId === id);
    return mine.length ? mine.reduce((a, b) => (b.attempt >= a.attempt ? b : a)) : undefined;
  };
  for (const id of [...new Set(run.outcomes.map((o) => o.journeyId))].sort()) {
    const now = lastOf(run, id)!;
    if (!FAIL(now.status)) continue;
    const seq = upto.map((r) => lastOf(r, id)).filter((o): o is NonNullable<typeof o> => !!o && o.status !== 'skipped');
    const prior = seq.slice(0, -1);
    const recent = prior.slice(-newWindow);
    const tags: FailureTag[] = [];
    if (prior.length && !recent.some((o) => FAIL(o.status))) tags.push('new-failure');
    let streak = 0;
    for (let i = seq.length - 1; i >= 0 && FAIL(seq[i].status); i--) streak++;
    const tail = seq.slice(-alwaysAfter);
    if (tail.length >= alwaysAfter && tail.every((o) => FAIL(o.status) && o.signature && o.signature === now.signature)) tags.push('always-failing');
    if (prior.length && PASS(prior[prior.length - 1].status)) tags.push('regressed');
    const window = seq.slice(-newWindow - 1);
    let flips = 0;
    for (let i = 1; i < window.length; i++) if (PASS(window[i].status) !== PASS(window[i - 1].status)) flips++;
    if (window.length >= 4 && flips >= 3 && !tags.includes('always-failing')) tags.push('flaky');
    out.push({ journeyId: id, tags, failingStreak: streak, window: seq.length, ...(now.signature ? { signature: now.signature } : {}) });
  }
  return out;
}

export interface UniqueError {
  signature: string;
  message: string;
  journeys: string[];
  /** Steps (journeyId/stepId) where it surfaced. */
  steps: string[];
}

/** Failures of a run grouped by failure signature, biggest group first. */
export function uniqueErrors(run: RunResult): UniqueError[] {
  const groups = new Map<string, UniqueError>();
  for (const j of run.journeys) {
    if (!FAIL(j.status)) continue;
    const failed = j.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
    const err = failed?.error ?? j.error;
    if (!err?.message?.trim()) continue;
    const sig = failureSignature({ message: err.message, stack: err.stack, name: err.name });
    const g = groups.get(sig.hash) ?? { signature: sig.hash, message: sig.normalized.slice(0, 300), journeys: [], steps: [] };
    if (!g.journeys.includes(j.journeyId)) g.journeys.push(j.journeyId);
    if (failed) g.steps.push(`${j.journeyId}/${failed.stepId}`);
    groups.set(sig.hash, g);
  }
  return [...groups.values()].sort((a, b) => b.journeys.length - a.journeys.length || a.signature.localeCompare(b.signature));
}
