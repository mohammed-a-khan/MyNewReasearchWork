/**
 * Load test results on disk, as an EZTest run directory: the results
 * document, the HTML report and the timeline CSV go into the evidence vault
 * (hash-chained manifest), with a `run.json` whose journey records the SLA
 * verdicts. So a load run can be verified, packed, published to the results
 * server and gated by readiness like any other run. Run history for trends
 * lives in `.eztest/load-history.json`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { EvidenceVault, summarize, type EvidenceRef, type JourneyResult, type RunResult, type StepResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { renderLoadReport } from './report.js';
import type { LoadResults } from './run.js';
import { LOAD_REPORT_FILE, LOAD_RESULTS_FILE, RESULTS_FORMAT, loadJourneyId } from './constants.js';

export { LOAD_REPORT_FILE, LOAD_RESULTS_FILE, loadJourneyId };
import type { TrendEntry } from './analysis.js';

export function toRunResult(r: LoadResults, evidence: string[]): RunResult {
  const steps: StepResult[] = [];
  const at = r.startedAt;
  steps.push({
    stepId: 'load-run',
    intent: `Run ${r.scenario.name}: ${r.totals.requests} requests, ${(r.totals.errorRate * 100).toFixed(2)}% errors, p95 ${r.totals.latency.p95} ms`,
    status: r.totals.requests || r.totals.iterations ? 'passed' : 'failed',
    startedAt: at, durationMs: r.durationMs, conditions: [], evidence,
  });
  r.sla.items.forEach((i, n) => {
    steps.push({
      stepId: `sla-${n + 1}`,
      intent: `SLA ${i.sla}: ${i.name} ${i.metric} ${i.value ?? 'no data'}${i.unit === 'ms' ? ' ms' : ''} (warn ${i.warn ?? '-'}, fail ${i.fail ?? '-'})`,
      status: i.status === 'fail' || i.status === 'no-data' ? 'failed' : 'passed',
      startedAt: at, durationMs: 0, conditions: [], evidence,
      ...(i.status === 'warn' ? { warnings: ['in the SLA warning range'] } : {}),
      ...(i.status === 'fail' || i.status === 'no-data' ? { error: { message: `${i.metric} of ${i.name} is ${i.value ?? 'not measured'} (fail threshold ${i.fail ?? '-'})` } } : {}),
    });
  });
  const failed = r.verdict === 'fail';
  const j: JourneyResult = {
    journeyId: loadJourneyId(r), name: `Load: ${r.scenario.name}`, status: failed ? 'failed' : 'passed', startedAt: at, durationMs: r.durationMs, steps,
    tags: ['@load', ...r.scenario.tags], requirements: r.scenario.requirements, risk: 4, attempt: 1, ledger: {}, evidence,
    ...(failed ? { error: { message: r.sla.items.filter((i) => i.status === 'fail').map((i) => `${i.name} ${i.metric}`).slice(0, 5).join('; ') || 'load test failed' } } : {}),
  };
  return {
    runId: r.runId, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, journeys: [j], summary: summarize([j]),
    environment: { kind: 'load', scenario: r.scenario.name, model: r.scenario.model, agents: String(r.agents.length || 1) },
  };
}

function timelineCsv(r: LoadResults): string {
  const head = ['t', 'at', 'vus', 'rps', 'errors', 'iterations', 'dropped', 'p50', 'p90', 'p95', 'p99', 'max', 'bytesIn', 'bytesOut'];
  const lines = r.timeline.map((p) => [p.t, new Date(p.at).toISOString(), p.vus, p.rps, p.errors, p.iterations, p.dropped, p.latency?.p50 ?? '', p.latency?.p90 ?? '', p.latency?.p95 ?? '', p.latency?.p99 ?? '', p.latency?.max ?? '', p.bytesIn, p.bytesOut].join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

export interface WrittenRun {
  runDir: string;
  run: RunResult;
  evidence: EvidenceRef[];
  files: { results: string; report: string; timeline: string };
}

/** Write a load run directory under `outputDir` (or exactly `runDir`). */
export async function writeLoadRun(r: LoadResults, o: { outputDir?: string; runDir?: string; scenarioText?: string; extra?: Array<{ path: string; data: string; description: string }> }): Promise<WrittenRun> {
  const runDir = o.runDir ?? join(o.outputDir ?? 'eztest-results', r.runId);
  await mkdir(runDir, { recursive: true });
  const vault = new EvidenceVault(runDir);
  await vault.init();
  const journeyId = loadJourneyId(r);
  const ev: EvidenceRef[] = [];
  ev.push(await vault.store('data', LOAD_RESULTS_FILE, JSON.stringify(r, null, 2), { journeyId, description: 'Load test results (EZTest Load)' }));
  ev.push(await vault.store('report', LOAD_REPORT_FILE, renderLoadReport(r), { journeyId, description: 'Load test report' }));
  ev.push(await vault.store('data', 'timeline.csv', timelineCsv(r), { journeyId, description: 'Load timeline per second' }));
  if (o.scenarioText) ev.push(await vault.store('data', 'scenario.yaml', o.scenarioText, { journeyId, description: 'Scenario as run' }));
  for (const x of o.extra ?? []) ev.push(await vault.store('data', x.path, x.data, { journeyId, description: x.description }));
  const run = toRunResult(r, ev.map((e) => e.id));
  run.evidenceHead = vault.headHash;
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  return { runDir, run, evidence: ev, files: { results: join(runDir, LOAD_RESULTS_FILE), report: join(runDir, LOAD_REPORT_FILE), timeline: join(runDir, 'timeline.csv') } };
}

export async function readLoadResults(pathOrDir: string): Promise<LoadResults> {
  const file = existsSync(join(pathOrDir, LOAD_RESULTS_FILE)) ? join(pathOrDir, LOAD_RESULTS_FILE) : pathOrDir;
  let r: LoadResults;
  try {
    r = JSON.parse(await readFile(file, 'utf8')) as LoadResults;
  } catch (e) {
    throw new EzTestError(`${file}: not readable load results (${(e as Error).message})`, 'LOAD_RESULTS');
  }
  if (r.format !== RESULTS_FORMAT) throw new EzTestError(`${file} is not an EZTest Load results file`, 'LOAD_RESULTS');
  return r;
}

// ------------------------------------------------------------------ history (trends)

export function trendEntry(r: LoadResults): TrendEntry {
  return {
    runId: r.runId, at: r.startedAt, scenario: r.scenario.name, verdict: r.verdict, rps: Math.round(r.totals.rps * 100) / 100, errorRate: r.totals.errorRate, p95: r.totals.latency.p95,
    names: Object.fromEntries(r.names.filter((n) => n.kind !== 'iteration').map((n) => [`${n.kind}:${n.name}`, { p95: n.latency.p95, errorRate: n.errorRate, count: n.count }])),
  };
}

export async function appendHistory(file: string, r: LoadResults, max = 200): Promise<TrendEntry[]> {
  const path = resolve(file);
  let list: TrendEntry[] = [];
  if (existsSync(path)) {
    try {
      const j = JSON.parse(await readFile(path, 'utf8')) as { runs?: TrendEntry[] };
      list = Array.isArray(j.runs) ? j.runs : [];
    } catch {
      list = [];
    }
  }
  list = [...list.filter((e) => e.runId !== r.runId), trendEntry(r)].slice(-max);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, runs: list }, null, 2));
  return list;
}

export async function readHistory(file: string, scenario?: string): Promise<TrendEntry[]> {
  if (!existsSync(file)) return [];
  const j = JSON.parse(await readFile(file, 'utf8')) as { runs?: TrendEntry[] };
  return (j.runs ?? []).filter((e) => !scenario || e.scenario === scenario);
}
