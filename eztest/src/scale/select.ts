/**
 * Test selection: which journeys to run, and why. Criteria combine as filters
 * (a journey must pass every criterion given) followed by an optional time
 * budget:
 *
 * - `changedSince`: journeys the impact analysis maps the changed files to, plus
 *   journeys whose own file changed.
 * - `onlyFailed`: journeys that failed or errored in an earlier run.
 * - `minRisk`: journeys with risk >= n.
 * - `budgetMs`: the highest risk-per-minute set that fits the budget, from
 *   historical durations (impacted and previously failed journeys get a boost).
 *
 * Every journey gets a reason (selected or not), so the CLI and the report can
 * explain the selection.
 */
import type { ImpactResult } from '../insights/index.js';
import { estimateDuration, type DurationTable } from './durations.js';

export interface SelectableJourney {
  id: string;
  name?: string;
  risk: number;
  rows?: number;
}

export interface SelectionCriteria {
  /** Impact analysis of the change (see analyzeImpact). */
  impact?: ImpactResult;
  /** Journey ids whose own file changed. */
  changedJourneyIds?: string[];
  /** Label for the change base, e.g. "origin/main". */
  changedSince?: string;
  /** Journey ids that failed/errored in an earlier run, and that run's id. */
  failed?: { runId: string; journeyIds: string[] };
  minRisk?: number;
  budgetMs?: number;
}

export interface SelectionDecision {
  journeyId: string;
  selected: boolean;
  reasons: string[];
  estimatedMs: number;
  /** Ranking value used by the budget (risk-weighted value per minute). */
  valuePerMinute?: number;
}

export interface Selection {
  criteria: { changedSince?: string; onlyFailed?: string; minRisk?: number; budgetMs?: number };
  selected: string[];
  decisions: SelectionDecision[];
  estimatedMs: number;
  /** One-paragraph explanation for humans. */
  summary: string;
}

export function parseBudget(v: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|min|h)?\s*$/i.exec(v);
  if (!m) throw new Error(`--budget must be a duration like 15m, 90s or 1h, got "${v}"`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return Math.round(n * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000));
}

export function parseRisk(v: string): number {
  const m = /^\s*(?:>=|≥|>)?\s*([1-5])\s*$/.exec(v);
  if (!m) throw new Error(`--risk must be 1-5 (optionally ">=4"), got "${v}"`);
  return /^\s*>[^=]/.test(v) ? Math.min(5, Number(m[1]) + 1) : Number(m[1]);
}

export const fmtMs = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`);

export function selectJourneys(journeys: SelectableJourney[], c: SelectionCriteria, table: DurationTable): Selection {
  const impacted = new Map((c.impact?.impacted ?? []).map((i) => [i.journeyId, i]));
  const changedFiles = new Set(c.changedJourneyIds ?? []);
  const failed = new Set(c.failed?.journeyIds ?? []);
  const useChange = c.impact !== undefined || c.changedJourneyIds !== undefined;
  const decisions: SelectionDecision[] = [];

  for (const j of journeys) {
    const est = estimateDuration(table, j.id, { rows: j.rows }).ms;
    const reasons: string[] = [];
    let ok = true;
    if (useChange) {
      const hit = impacted.get(j.id);
      if (hit) reasons.push(`impacted by ${hit.via.slice(0, 2).map((v) => v.file).join(', ')}${hit.via.length > 2 ? ` (+${hit.via.length - 2})` : ''}`);
      else if (changedFiles.has(j.id)) reasons.push('journey file changed');
      else {
        ok = false;
        reasons.push(`not affected by changes since ${c.changedSince ?? 'the base'}`);
      }
    }
    if (c.failed) {
      if (failed.has(j.id)) reasons.push(`failed in ${c.failed.runId}`);
      else {
        ok = false;
        reasons.push(`did not fail in ${c.failed.runId}`);
      }
    }
    if (c.minRisk !== undefined) {
      if (j.risk >= c.minRisk) reasons.push(`risk ${j.risk} >= ${c.minRisk}`);
      else {
        ok = false;
        reasons.push(`risk ${j.risk} < ${c.minRisk}`);
      }
    }
    if (!useChange && !c.failed && c.minRisk === undefined) reasons.push('all journeys');
    decisions.push({ journeyId: j.id, selected: ok, reasons, estimatedMs: est });
  }

  if (c.budgetMs !== undefined) {
    const byId = new Map(journeys.map((j) => [j.id, j]));
    const candidates = decisions.filter((d) => d.selected);
    for (const d of candidates) {
      const j = byId.get(d.journeyId)!;
      // Value: risk squared (a risk-5 journey matters far more than a risk-1 one), boosted for impact and recent failure.
      const value = j.risk * j.risk * (impacted.has(j.id) ? 1 + (impacted.get(j.id)!.score ?? 0) / 10 : 1) * (failed.has(j.id) ? 1.5 : 1);
      d.valuePerMinute = Math.round((value / Math.max(d.estimatedMs / 60_000, 1 / 60)) * 1000) / 1000;
    }
    candidates.sort((a, b) => b.valuePerMinute! - a.valuePerMinute! || a.journeyId.localeCompare(b.journeyId));
    let used = 0;
    for (const d of candidates) {
      if (used + d.estimatedMs <= c.budgetMs) {
        used += d.estimatedMs;
        d.reasons.push(`fits budget (${d.valuePerMinute} risk-value/min, ~${fmtMs(d.estimatedMs)})`);
      } else {
        d.selected = false;
        d.reasons.push(`over budget (~${fmtMs(d.estimatedMs)}, ${d.valuePerMinute} risk-value/min)`);
      }
    }
  }

  const selected = decisions.filter((d) => d.selected).map((d) => d.journeyId);
  const estimatedMs = decisions.filter((d) => d.selected).reduce((a, d) => a + d.estimatedMs, 0);
  const parts: string[] = [];
  if (useChange) parts.push(`changed since ${c.changedSince ?? 'base'} (${c.impact?.changedFiles.length ?? 0} files, ${impacted.size + changedFiles.size} impacted)`);
  if (c.failed) parts.push(`failed in ${c.failed.runId} (${failed.size})`);
  if (c.minRisk !== undefined) parts.push(`risk >= ${c.minRisk}`);
  if (c.budgetMs !== undefined) parts.push(`budget ${fmtMs(c.budgetMs)}`);
  const uncovered = c.impact?.uncovered.length ? `; ${c.impact.uncovered.length} changed file(s) map to no journey` : '';
  return {
    criteria: { changedSince: c.changedSince, onlyFailed: c.failed?.runId, minRisk: c.minRisk, budgetMs: c.budgetMs },
    selected,
    decisions,
    estimatedMs,
    summary: `Selected ${selected.length} of ${journeys.length} journeys (~${fmtMs(estimatedMs)}) by ${parts.join(', ') || 'no criteria'}${uncovered}.`,
  };
}
