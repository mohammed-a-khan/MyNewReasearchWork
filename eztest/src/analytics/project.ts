/**
 * Project-wide coverage: the latest result of every journey across recent
 * runs, the UI coverage map over the traces of those results, and the
 * combined view (UI, requirements, API, risk, change, manual). Used by
 * `eztest coverage` and Studio Quality › Coverage.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDebugRunId, type Journey, type JourneyResult, type RunResult } from '../core/index.js';
import { loadApiCoverage } from '../contracts/run-coverage.js';
import type { ApiCoverageReport } from '../contracts/coverage.js';
import { computeTraceability, type ImpactResult, type RequirementInfo } from '../insights/index.js';
import { journeyKind, manualStepCount } from '../runner/manual.js';
import { combineCoverage, type CombinedCoverage, type JourneyLatest } from './combined.js';
import { computeUiCoverage, loadUiCoverage, runTraceInputs, type UiCoverageOptions, type UiCoverageReport } from './ui-coverage.js';

const RUN_ID = /^[A-Za-z0-9][\w.-]{0,120}$/;

export interface RunSummaryRef {
  runId: string;
  dir: string;
  startedAt: string;
  run: RunResult;
}

/** Completed runs of an output directory, newest first (cancelled runs left out). */
export async function recentRuns(outputDir: string, limit = 60): Promise<RunSummaryRef[]> {
  if (!existsSync(outputDir)) return [];
  const out: RunSummaryRef[] = [];
  for (const name of await readdir(outputDir)) {
    // Studio debug sessions are not part of the project's analytics.
    if (!RUN_ID.test(name) || isDebugRunId(name)) continue;
    const p = join(outputDir, name, 'run.json');
    if (!existsSync(p)) continue;
    try {
      const run = JSON.parse(await readFile(p, 'utf8')) as RunResult;
      if (run.journeys?.some((j) => j.error?.name === 'CancelledError')) continue;
      out.push({ runId: name, dir: join(outputDir, name), startedAt: run.startedAt, run });
    } catch {
      // unreadable run.json
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

/** The id a result belongs to (Examples rows run as "<id>-<row>"). */
function baseIdOf(resultId: string, ids: Set<string>): string | undefined {
  if (ids.has(resultId)) return resultId;
  for (let i = resultId.lastIndexOf('-'); i > 0; i = resultId.lastIndexOf('-', i - 1)) {
    const b = resultId.slice(0, i);
    if (ids.has(b)) return b;
  }
  return undefined;
}

export interface LatestResults {
  /** journeyId -> latest result(s) and run. */
  latest: Map<string, { runId: string; dir: string; startedAt: string; results: JourneyResult[] }>;
  runs: RunSummaryRef[];
}

/** Latest executed (not skipped) result of every journey, over recent runs. */
export async function latestResults(outputDir: string, journeys: Journey[], limit = 60): Promise<LatestResults> {
  const runs = await recentRuns(outputDir, limit);
  const ids = new Set(journeys.map((j) => j.id));
  const latest: LatestResults['latest'] = new Map();
  for (const r of runs) {
    const grouped = new Map<string, JourneyResult[]>();
    for (const j of r.run.journeys) {
      const b = baseIdOf(j.journeyId, ids);
      if (!b || latest.has(b) || j.tags.includes('hook')) continue;
      if (j.status === 'skipped' && !(j.manual && j.manual.executed > 0)) continue;
      grouped.set(b, [...(grouped.get(b) ?? []), j]);
    }
    for (const [b, results] of grouped) latest.set(b, { runId: r.runId, dir: r.dir, startedAt: r.startedAt, results });
  }
  return { latest, runs };
}

export interface ProjectCoverageOptions {
  outputDir: string;
  journeys: Journey[];
  ui?: UiCoverageOptions;
  requirements?: RequirementInfo[];
  quarantined?: string[];
  impact?: ImpactResult;
  /** Only these runs (newest first); default: the latest result of every journey across recent runs. */
  runIds?: string[];
  limit?: number;
}

export interface ProjectCoverage {
  combined: CombinedCoverage;
  ui: UiCoverageReport;
  api?: ApiCoverageReport[];
  /** Runs whose results were used. */
  runIds: string[];
}

export async function projectCoverage(o: ProjectCoverageOptions): Promise<ProjectCoverage> {
  const tests = o.journeys.filter((j) => !j.tags.includes('library') && !j.tags.includes('hook'));
  let latest: LatestResults['latest'];
  let runs: RunSummaryRef[];
  if (o.runIds?.length) {
    runs = (await recentRuns(o.outputDir, 500)).filter((r) => o.runIds!.includes(r.runId));
    const ids = new Set(tests.map((j) => j.id));
    latest = new Map();
    for (const r of runs) {
      for (const j of r.run.journeys) {
        const b = baseIdOf(j.journeyId, ids);
        if (!b || latest.get(b)?.runId !== undefined && latest.get(b)!.runId !== r.runId) continue;
        const cur = latest.get(b) ?? { runId: r.runId, dir: r.dir, startedAt: r.startedAt, results: [] };
        cur.results.push(j);
        latest.set(b, cur);
      }
    }
  } else ({ latest, runs } = await latestResults(o.outputDir, tests, o.limit ?? 60));

  // UI coverage over the traces behind each journey's latest result.
  const byRun = new Map<string, { dir: string; ids: Set<string> }>();
  for (const l of latest.values()) {
    const e = byRun.get(l.runId) ?? { dir: l.dir, ids: new Set<string>() };
    for (const r of l.results) e.ids.add(r.journeyId);
    byRun.set(l.runId, e);
  }
  const inputs = [];
  for (const [runId, e] of byRun) inputs.push(...(await runTraceInputs(e.dir, runId)).filter((t) => e.ids.has(t.trace.journeyId)));
  let ui = await computeUiCoverage(inputs, tests, o.ui ?? {});
  // A single run that already recorded its map (same inputs) needs no recomputation; keep the stored one when traces are gone.
  if (!inputs.length && runs[0]) ui = (await loadUiCoverage(runs[0].dir)) ?? ui;

  const status = (id: string) => {
    const rs = latest.get(id)?.results ?? [];
    if (!rs.length) return 'not-run' as const;
    if (rs.some((r) => r.status === 'failed' || r.status === 'error')) return 'failed' as const;
    if (rs.every((r) => r.status === 'skipped')) return 'skipped' as const;
    if (rs.some((r) => r.status === 'passed-healed')) return 'passed-healed' as const;
    return 'passed' as const;
  };
  const q = new Set(o.quarantined ?? []);
  const trace = computeTraceability({
    journeys: tests.map((j) => ({ id: j.id, name: j.name, requirements: j.requirements, tags: j.tags, risk: j.risk })),
    latest: Object.fromEntries(tests.map((j) => {
      const l = latest.get(j.id);
      const s = status(j.id);
      return [j.id, l && s !== 'not-run' ? { status: s, runId: l.runId, startedAt: l.startedAt } : undefined];
    })),
    quarantined: q,
    ...(o.requirements ? { requirements: o.requirements } : {}),
  });
  let api: ApiCoverageReport[] | undefined;
  for (const r of runs) {
    api = await loadApiCoverage(r.dir);
    if (api?.length) break;
  }
  const js: JourneyLatest[] = tests.map((j) => {
    const rs = latest.get(j.id)?.results ?? [];
    const kind = journeyKind(j);
    const steps = manualStepCount(j);
    const pending = rs.length ? rs.reduce((n, r) => n + (r.manual?.pending ?? (kind === 'automated' ? 0 : steps)), 0) / rs.length : steps;
    return { id: j.id, name: j.name, risk: j.risk, status: status(j.id), type: kind, ...(steps ? { manualSteps: steps, manualPending: Math.round(pending) } : {}) };
  });
  const combined = combineCoverage({ ui, traceability: trace, ...(api?.length ? { api } : {}), journeys: js, ...(o.impact ? { impact: o.impact } : {}) });
  return { combined, ui, ...(api?.length ? { api } : {}), runIds: [...byRun.keys()].sort() };
}
