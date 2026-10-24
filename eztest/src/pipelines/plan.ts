/**
 * `pipelines:`: which journeys a CI trigger or deployment stage runs, and why.
 *
 * - resolvePipeline: the entry for `--pipeline <name>` or `--pipeline auto`
 *   (from the CI's stage, job or deployment environment, then the trigger).
 * - planPipeline: the static selection (tag expression, risk, Browsers:
 *   headers, setup journeys, library journeys), with a reason per journey.
 *   Impact and time budgets are applied at run time by the scale selection
 *   (--changed-since, --budget), which explains its own decisions.
 * - pipelineRunSettings: what the entry changes about the run (environment,
 *   browsers, shards, retries, workers, impact base, budget).
 * - tagsReport: journeys no pipeline runs, untagged journeys, empty pipelines.
 */
import type { Journey } from '../core/index.js';
import type { PipelineEntry } from '../config/index.js';
import type { CiContext } from './detect.js';
import { explainTags, matchesTags, parseTagExpression, tagExpressionToText, type TagExpr } from './tags.js';

export interface PipelineResolution {
  name: string;
  entry: PipelineEntry;
  /** How the entry was chosen, for the log. */
  how: string;
}

export class PipelineError extends Error {}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_.]+/g, '-');

export function resolvePipeline(want: string, pipelines: Record<string, PipelineEntry>, ci: CiContext, env: Record<string, string | undefined> = process.env): PipelineResolution {
  const names = Object.keys(pipelines);
  if (!names.length) throw new PipelineError('No pipelines are configured: add a "pipelines:" block to eztest.config.yaml (see docs/pipelines.md)');
  const pick = (name: string, how: string): PipelineResolution => ({ name, entry: pipelines[name], how });
  if (want !== 'auto') {
    if (pipelines[want]) return pick(want, 'named on the command line');
    const close = names.find((n) => norm(n) === norm(want));
    if (close) return pick(close, `named on the command line (as ${want})`);
    throw new PipelineError(`No pipeline "${want}" (configured: ${names.join(', ')})`);
  }
  if (env.EZTEST_PIPELINE && env.EZTEST_PIPELINE !== 'auto') return resolvePipeline(env.EZTEST_PIPELINE, pipelines, ci, env);
  const seen = [ci.stage && `stage "${ci.stage}"`, ci.job && `job "${ci.job}"`, ci.environment && `environment "${ci.environment}"`].filter(Boolean).join(', ');
  // 1. A CI stage, job or environment named like the entry, or listed in its `stages:`.
  for (const [label, value] of [['stage', ci.stage], ['job', ci.job], ['environment', ci.environment]] as const) {
    if (!value) continue;
    for (const n of names) {
      const e = pipelines[n];
      if (norm(n) === norm(value) || e.stages.some((s) => norm(s) === norm(value))) return pick(n, `${ci.system} ${label} "${value}"`);
    }
  }
  // 2. A deployment environment: the entry for that environment.
  if (ci.environment) {
    const hits = names.filter((n) => pipelines[n].environment && norm(pipelines[n].environment!) === norm(ci.environment!));
    if (hits.length === 1) return pick(hits[0], `${ci.system} deployment environment "${ci.environment}"`);
  }
  // 3. The trigger: pull request, schedule, deployment.
  const byTrigger = (t: PipelineEntry['trigger'], fallbackNames: string[]) => names.find((n) => pipelines[n].trigger === t) ?? names.find((n) => fallbackNames.includes(norm(n)));
  const t = ci.reason === 'pr' ? byTrigger('pr', ['pr', 'pull-request', 'smoke'])
    : ci.reason === 'schedule' ? byTrigger('schedule', ['nightly', 'scheduled', 'regression'])
    : ci.reason === 'manual' && ci.system === 'local' ? undefined
    : ci.reason === 'deploy' ? byTrigger('deploy', []) : undefined;
  if (t) return pick(t, `${ci.system} trigger: ${ci.reason}`);
  throw new PipelineError(`--pipeline auto: no pipeline matches this ${ci.system === 'local' ? 'machine (not in CI)' : `${ci.system} run`} (${seen || `trigger ${ci.reason}`}). Name it (--pipeline <name>), set EZTEST_PIPELINE, or list the stage under the entry's "stages:" (configured: ${names.join(', ')})`);
}

export interface JourneyDecision {
  journeyId: string;
  name: string;
  selected: boolean;
  /** Setup / teardown journeys run once around the selection. */
  role?: 'setup' | 'teardown';
  reasons: string[];
}

export interface PipelinePlan {
  name: string;
  entry: PipelineEntry;
  expression?: string;
  decisions: JourneyDecision[];
  /** Selected tests (setup and teardown journeys not included). */
  selected: Journey[];
  /** Setup and teardown journeys that run around them (when anything is selected). */
  around: Journey[];
  /** Selection applied at run time, described. */
  dynamic: string[];
}

function riskOf(v: PipelineEntry['risk']): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  const m = /^\s*(?:>=|>)?\s*([1-5])\s*$/.exec(v);
  if (!m) throw new PipelineError(`risk "${v}" must be 1-5 or ">=n"`);
  return /^\s*>[^=]/.test(v) ? Math.min(5, Number(m[1]) + 1) : Number(m[1]);
}

export function compileTags(entry: PipelineEntry, name: string): TagExpr | undefined {
  if (!entry.tags) return undefined;
  try {
    return parseTagExpression(entry.tags);
  } catch (e) {
    throw new PipelineError(`pipelines.${name}.tags: ${(e as Error).message}`);
  }
}

export function planPipeline(name: string, entry: PipelineEntry, journeys: Journey[]): PipelinePlan {
  const expr = compileTags(entry, name);
  const minRisk = riskOf(entry.risk);
  const browsers = entry.browsers?.map((b) => b.toLowerCase());
  const decisions: JourneyDecision[] = [];
  const selected: Journey[] = [];
  const around: Journey[] = [];
  for (const j of journeys) {
    const d: JourneyDecision = { journeyId: j.id, name: j.name, selected: true, reasons: [] };
    decisions.push(d);
    if (j.tags.includes('setup') || j.tags.includes('teardown')) {
      d.role = j.tags.includes('setup') ? 'setup' : 'teardown';
      d.reasons.push(d.role === 'setup' ? 'Setup: journey, runs once before the selected journeys' : 'Teardown: journey, runs once after them');
      around.push(j);
      continue;
    }
    if (j.tags.includes('library')) {
      d.selected = false;
      d.reasons.push('@library: only called by other journeys (Run journey)');
      continue;
    }
    if (expr) {
      const ok = matchesTags(expr, j.tags);
      d.reasons.push(`tags ${ok ? 'match' : 'do not match'} ${entry.tags} (${explainTags(expr, j.tags)})`);
      if (!ok) d.selected = false;
    } else d.reasons.push('no tag filter: every journey');
    if (minRisk !== undefined) {
      if (j.risk >= minRisk) d.reasons.push(`risk ${j.risk} >= ${minRisk}`);
      else {
        d.selected = false;
        d.reasons.push(`risk ${j.risk} < ${minRisk}`);
      }
    }
    if (browsers?.length && j.browsers?.length) {
      const on = j.browsers.map((b) => b.toLowerCase()).filter((b) => browsers.includes(b));
      if (!on.length) {
        d.selected = false;
        d.reasons.push(`Browsers: ${j.browsers.join(', ')} excludes ${browsers.join(', ')}`);
      } else if (on.length < browsers.length) d.reasons.push(`runs on ${on.join(', ')} only (Browsers: header)`);
    }
    if (d.selected) selected.push(j);
  }
  if (!selected.length) for (const d of decisions) if (d.role) (d.selected = false, d.reasons.push('nothing else is selected'));
  const dynamic: string[] = [];
  if (entry.impact) dynamic.push(`impact: only journeys affected by the change since ${entry.impact === true ? 'the pull request target (EZTEST_BASE_REF, else origin/main)' : entry.impact}`);
  if (entry.budget) dynamic.push(`budget ${entry.budget}: the highest risk-per-minute journeys that fit, from historical durations`);
  if (entry.shards) dynamic.push(`split into ${entry.shards} shard(s) balanced by historical duration`);
  return { name, entry, ...(expr ? { expression: tagExpressionToText(expr) } : {}), decisions, selected, around: selected.length ? around : [], dynamic };
}

export interface PipelineRunSettings {
  environment?: string;
  browsers?: string[];
  retries?: number;
  workers?: number;
  changedSince?: string;
  budget?: string;
  risk?: string;
  /** `i/n` from the CI's own parallelism, when the entry is sharded and no --shard was given. */
  shard?: string;
}

export function pipelineRunSettings(entry: PipelineEntry, ci: CiContext, env: Record<string, string | undefined> = process.env): PipelineRunSettings {
  const out: PipelineRunSettings = {};
  if (entry.environment) out.environment = entry.environment;
  if (entry.browsers?.length) out.browsers = entry.browsers;
  if (entry.retries !== undefined) out.retries = entry.retries;
  if (entry.workers !== undefined) out.workers = entry.workers;
  if (entry.impact) out.changedSince = entry.impact === true ? env.EZTEST_BASE_REF || (ci.baseBranch ? `origin/${ci.baseBranch}` : 'origin/main') : entry.impact;
  if (entry.budget) out.budget = entry.budget;
  if (entry.risk !== undefined) out.risk = String(entry.risk);
  if (entry.shards && entry.shards !== 1 && ci.shard) out.shard = `${ci.shard.index}/${ci.shard.total}`;
  return out;
}

export interface TagsReport {
  journeys: Array<{ id: string; name: string; tags: string[]; pipelines: string[] }>;
  untagged: string[];
  inNoPipeline: string[];
  emptyPipelines: string[];
  pipelines: Array<{ name: string; tags?: string; journeys: number }>;
  tagCounts: Array<{ tag: string; journeys: number }>;
}

export function tagsReport(journeys: Journey[], pipelines: Record<string, PipelineEntry>): TagsReport {
  const tests = journeys.filter((j) => !j.tags.some((t) => ['library', 'setup', 'teardown'].includes(t)));
  const plans = Object.entries(pipelines).map(([n, e]) => planPipeline(n, e, tests));
  const rows = tests.map((j) => ({ id: j.id, name: j.name, tags: j.tags, pipelines: plans.filter((p) => p.selected.includes(j)).map((p) => p.name) }));
  const counts = new Map<string, number>();
  for (const j of tests) for (const t of new Set(j.tags.map((x) => x.toLowerCase()))) counts.set(t, (counts.get(t) ?? 0) + 1);
  return {
    journeys: rows,
    untagged: tests.filter((j) => !j.tags.length).map((j) => j.id),
    inNoPipeline: Object.keys(pipelines).length ? rows.filter((r) => !r.pipelines.length).map((r) => r.id) : [],
    emptyPipelines: plans.filter((p) => !p.selected.length).map((p) => p.name),
    pipelines: plans.map((p) => ({ name: p.name, ...(p.entry.tags ? { tags: p.entry.tags } : {}), journeys: p.selected.length })),
    tagCounts: [...counts].map(([tag, n]) => ({ tag, journeys: n })).sort((a, b) => b.journeys - a.journeys || a.tag.localeCompare(b.tag)),
  };
}
