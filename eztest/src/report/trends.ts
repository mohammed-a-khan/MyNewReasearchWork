/**
 * `eztest report trends`: the cross-run portfolio dashboard, from history
 * (.eztest/history.json) and the run directories' saved report models -
 * pass-rate and duration trends, readiness history, flakiest and slowest
 * tests, most failing tests, and a failure heat map by day and suite.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreHistory, HistoryStore, type RunHistoryEntry } from '../insights/index.js';
import { escapeHtml as e } from './escape.js';
import { columnChart, fmtMs, fmtPct, heatmap, hbarChart, lineChart } from './charts.js';
import { REPORT_CSS } from './styles.js';
import { MINI_SCRIPT } from './mini-script.js';
import { readReportModel } from './write.js';

export interface TrendsModel {
  format: 'eztest-trends';
  version: 1;
  generatedAt: string;
  runs: Array<{ runId: string; startedAt: string; branch?: string; total: number; failed: number; passRate: number; durationMs: number; readiness?: string; readinessScore?: number }>;
  flakiest: Array<{ id: string; flipRate: number; failRate: number; samples: number; state: string; sequence: string }>;
  slowest: Array<{ id: string; avgMs: number; maxMs: number; samples: number }>;
  mostFailing: Array<{ id: string; failures: number; samples: number; lastFailedRun?: string }>;
  heatmap: { days: string[]; suites: string[]; cells: Array<Array<{ rate: number; n: number } | null>> };
  totals: { runs: number; tests: number; from?: string; to?: string; avgPassRate: number };
}

const PASS = (s: string) => s === 'passed' || s === 'passed-healed';
const FAIL = (s: string) => s === 'failed' || s === 'error';

function lastOutcomes(r: RunHistoryEntry) {
  const m = new Map<string, RunHistoryEntry['outcomes'][number]>();
  for (const o of r.outcomes) if (!m.get(o.journeyId) || o.attempt >= m.get(o.journeyId)!.attempt) m.set(o.journeyId, o);
  return [...m.values()];
}

export interface TrendsOptions {
  /** Only the last n runs (default 50). */
  runs?: number;
  branch?: string;
  /** journey id -> suite (from saved report models); default: the part of the id before the first "-" or "@". */
  suiteOf?: (journeyId: string) => string;
}

export function buildTrends(history: readonly RunHistoryEntry[], o: TrendsOptions = {}): TrendsModel {
  const all = [...history].filter((r) => !o.branch || r.branch === o.branch).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const runs = all.slice(-(o.runs ?? 50));
  const suiteOf = o.suiteOf ?? ((id: string) => id.split(/[@]/)[0].split('-')[0] || id);
  const runRows = runs.map((r) => {
    const last = lastOutcomes(r);
    const executed = last.filter((x) => x.status !== 'skipped');
    const passed = executed.filter((x) => PASS(x.status)).length;
    return { runId: r.runId, startedAt: r.startedAt, ...(r.branch ? { branch: r.branch } : {}), total: last.length, failed: executed.filter((x) => FAIL(x.status)).length, passRate: executed.length ? passed / executed.length : 0, durationMs: r.durationMs ?? last.reduce((n, x) => n + x.durationMs, 0), ...(r.readiness ? { readiness: r.readiness } : {}), ...(r.readinessScore !== undefined ? { readinessScore: r.readinessScore } : {}) };
  });
  // flakiness from the same window
  const store = new HistoryStore('in-memory');
  (store as unknown as { data: { version: 1; runs: RunHistoryEntry[] }; loaded: boolean }).data = { version: 1, runs };
  (store as unknown as { loaded: boolean }).loaded = true;
  const scores = runs.length ? scoreHistory(store) : [];
  const flakiest = scores.filter((s) => s.flips > 0).sort((a, b) => b.flipRate - a.flipRate || b.failRate - a.failRate).slice(0, 15).map((s) => ({ id: s.journeyId, flipRate: s.flipRate, failRate: s.failRate, samples: s.samples, state: s.state, sequence: s.sequence.slice(-30) }));
  const dur = new Map<string, number[]>();
  const fails = new Map<string, { failures: number; samples: number; last?: string }>();
  for (const r of runs) for (const x of lastOutcomes(r)) {
    if (x.status === 'skipped') continue;
    dur.set(x.journeyId, [...(dur.get(x.journeyId) ?? []), x.durationMs]);
    const f = fails.get(x.journeyId) ?? { failures: 0, samples: 0 };
    f.samples++;
    if (FAIL(x.status)) {
      f.failures++;
      f.last = r.runId;
    }
    fails.set(x.journeyId, f);
  }
  const slowest = [...dur.entries()].map(([id, ds]) => ({ id, avgMs: ds.reduce((a, b) => a + b, 0) / ds.length, maxMs: Math.max(...ds), samples: ds.length })).sort((a, b) => b.avgMs - a.avgMs).slice(0, 15);
  const mostFailing = [...fails.entries()].filter(([, f]) => f.failures > 0).map(([id, f]) => ({ id, failures: f.failures, samples: f.samples, ...(f.last ? { lastFailedRun: f.last } : {}) })).sort((a, b) => b.failures - a.failures || b.failures / b.samples - a.failures / a.samples).slice(0, 15);
  // heat map: day x suite failure rate
  const days = [...new Set(runs.map((r) => r.startedAt.slice(0, 10)))].slice(-21);
  const bySuite = new Map<string, Map<string, { n: number; f: number }>>();
  for (const r of runs) {
    const day = r.startedAt.slice(0, 10);
    if (!days.includes(day)) continue;
    for (const x of lastOutcomes(r)) {
      if (x.status === 'skipped') continue;
      const s = suiteOf(x.journeyId);
      const m = bySuite.get(s) ?? new Map();
      const c = m.get(day) ?? { n: 0, f: 0 };
      c.n++;
      if (FAIL(x.status)) c.f++;
      m.set(day, c);
      bySuite.set(s, m);
    }
  }
  const suites = [...bySuite.entries()].map(([s, m]) => ({ s, f: [...m.values()].reduce((n, c) => n + c.f, 0) })).sort((a, b) => b.f - a.f || a.s.localeCompare(b.s)).slice(0, 15).map((x) => x.s);
  const cells = suites.map((s) => days.map((d) => {
    const c = bySuite.get(s)?.get(d);
    return c ? { rate: c.f / c.n, n: c.n } : null;
  }));
  const ids = new Set(runs.flatMap((r) => r.outcomes.map((x) => x.journeyId)));
  return {
    format: 'eztest-trends',
    version: 1,
    generatedAt: new Date().toISOString(),
    runs: runRows,
    flakiest,
    slowest,
    mostFailing,
    heatmap: { days, suites, cells },
    totals: { runs: runRows.length, tests: ids.size, ...(runRows.length ? { from: runRows[0].startedAt, to: runRows[runRows.length - 1].startedAt } : {}), avgPassRate: runRows.length ? runRows.reduce((n, r) => n + r.passRate, 0) / runRows.length : 0 },
  };
}

/** journey id -> first suite segment, from the saved report models of the run directories in `outputDir`. */
export async function suitesFromRuns(outputDir: string, max = 10): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(outputDir)) return out;
  const dirs = (await readdir(outputDir)).filter((d) => existsSync(join(outputDir, d, 'run.json'))).sort().reverse().slice(0, max);
  for (const d of dirs) {
    const m = await readReportModel(join(outputDir, d)).catch(() => undefined);
    for (const t of m?.tests ?? []) if (!out.has(t.id) && t.suite.length) out.set(t.id, t.suite.length > 1 ? t.suite.slice(0, -1).join(' / ') : t.suite[0]);
  }
  return out;
}

const shortDay = (iso: string) => iso.slice(5, 10);

export function renderTrendsHtml(t: TrendsModel, o: { title?: string; brand?: string } = {}): string {
  const title = o.title ?? 'Test portfolio trends';
  const runs = t.runs;
  const pass = runs.length >= 2 ? lineChart(runs.map((r, i) => ({ label: shortDay(r.startedAt), value: r.passRate, detail: `${r.total} tests, ${r.failed} failed`, current: i === runs.length - 1 })), { title: 'Pass rate per run', yMax: 1, yFormat: (v) => fmtPct(v, 0), series: 'series-1', area: true, width: 640 }) : '<p class="muted">Two or more runs are needed.</p>';
  const dur = runs.length ? columnChart(runs.map((r) => ({ label: shortDay(r.startedAt), value: r.durationMs, tip: `${r.runId}: ${fmtMs(r.durationMs)}` })), { title: 'Duration per run', yLabel: 'run', yFormat: fmtMs, width: 640 }) : '';
  const ready = runs.filter((r) => r.readiness);
  const readiness = ready.length
    ? `<div class="tbl-wrap"><table><caption class="sr-only">Readiness history</caption><thead><tr><th scope="col">Run</th><th scope="col">Started</th><th scope="col">Decision</th><th scope="col">Score</th><th scope="col">Pass rate</th></tr></thead><tbody>${ready.slice(-30).reverse().map((r) => `<tr><td class="mono">${e(r.runId)}</td><td>${e(r.startedAt.replace('T', ' ').slice(0, 16))}</td><td><span class="badge ${r.readiness === 'GO' ? 'b-passed' : r.readiness === 'NO_GO' ? 'b-failed' : 'b-flaky'}">${e(r.readiness!.replace(/_/g, ' '))}</span></td><td class="num">${e(r.readinessScore ?? '')}</td><td class="num">${e(fmtPct(r.passRate))}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No readiness decisions recorded (configure readiness.policyPath).</p>';
  const strip = ready.length ? `<p class="sr-only">Readiness of each run, oldest first:</p><div class="chips" style="margin-bottom:10px">${ready.slice(-40).map((r) => `<span class="badge ${r.readiness === 'GO' ? 'b-passed' : r.readiness === 'NO_GO' ? 'b-failed' : 'b-flaky'}" data-tip="${e(`${r.runId}: ${r.readiness}`)}" title="${e(r.runId)}">${e(shortDay(r.startedAt))}</span>`).join('')}</div>` : '';
  const flaky = t.flakiest.length ? hbarChart(t.flakiest.map((f) => ({ label: f.id, value: f.flipRate, valueLabel: `${fmtPct(f.flipRate, 0)} flips, ${fmtPct(f.failRate, 0)} fails`, cls: 'st-flaky', tip: `${f.id}: ${f.state}, ${f.sequence}` })), { title: 'Flakiest tests', unit: 'Flip rate', labelWidth: 150, width: 440 }) : '<p class="muted">No test changed outcome between runs.</p>';
  const slow = t.slowest.length ? hbarChart(t.slowest.map((s) => ({ label: s.id, value: s.avgMs, valueLabel: `${fmtMs(s.avgMs)} avg`, cls: 'series-1', tip: `${s.id}: average ${fmtMs(s.avgMs)}, max ${fmtMs(s.maxMs)} over ${s.samples} runs` })), { title: 'Slowest tests (average)', unit: 'Average duration', labelWidth: 150, width: 440 }) : '';
  const failing = t.mostFailing.length ? hbarChart(t.mostFailing.map((f) => ({ label: f.id, value: f.failures, valueLabel: `${f.failures} of ${f.samples}`, cls: 'st-failed' })), { title: 'Most failing tests', unit: 'Failures', labelWidth: 150, width: 440 }) : '<p class="muted">No failures in the window.</p>';
  const heat = t.heatmap.suites.length && t.heatmap.days.length ? heatmap(t.heatmap.suites, t.heatmap.days.map(shortDay), t.heatmap.cells, { title: 'Failure rate by day and suite', valueLabel: 'failure rate', width: 900 }) : '<p class="muted">No data.</p>';
  const k = t.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${e(title)}</title><style>${REPORT_CSS}</style></head><body><a class="skip" href="#main">Skip to the dashboard</a>
<header class="topbar"><div class="topbar-in"><div class="brand"><span class="brand-mark" aria-hidden="true">${e((o.brand ?? 'EZ').slice(0, 2).toUpperCase())}</span><div class="brand-text"><div class="brand-name">${e(o.brand ?? 'EZTest')}</div><h1>${e(title)}</h1></div></div>
<span class="small muted">${e(k.runs)} runs${k.from ? ` &middot; ${e(k.from.slice(0, 10))} to ${e(k.to!.slice(0, 10))}` : ''}</span><div class="top-actions"><button type="button" class="btn" id="theme-toggle" aria-pressed="false">Dark theme</button></div></div></header>
<main id="main">
<div class="kpis" role="list" aria-label="Portfolio figures">${[
    ['Runs', String(k.runs)], ['Distinct tests', String(k.tests)], ['Average pass rate', fmtPct(k.avgPassRate)], ['Latest pass rate', runs.length ? fmtPct(runs[runs.length - 1].passRate) : '-'],
    ['Flaky tests', String(t.flakiest.length)], ['Latest readiness', ready.length ? ready[ready.length - 1].readiness!.replace(/_/g, ' ') : '-'],
  ].map(([l, v]) => `<div class="kpi k-accent" role="listitem"><div class="kpi-label">${e(l)}</div><div class="kpi-value">${e(v)}</div></div>`).join('')}</div>
<section class="block" aria-labelledby="t1"><div class="grid g-2"><div class="card"><h2 id="t1" style="font-size:15px;margin-bottom:8px">Pass rate trend</h2>${pass}</div><div class="card"><h2 style="font-size:15px;margin-bottom:8px">Duration trend</h2>${dur}</div></div></section>
<section class="block" aria-labelledby="t2"><div class="card"><h2 id="t2" style="font-size:15px;margin-bottom:8px">Readiness history</h2>${strip}${readiness}</div></section>
<section class="block" aria-labelledby="t3"><div class="card"><h2 id="t3" style="font-size:15px;margin-bottom:8px">Failure heat map</h2><p class="card-sub">Share of executed tests that failed, per suite and day (darker is worse).</p><div style="overflow-x:auto">${heat}</div></div></section>
<section class="block" aria-labelledby="t4"><div class="grid g-3"><div class="card"><h2 id="t4" style="font-size:15px;margin-bottom:8px">Flakiest tests</h2>${flaky}</div><div class="card"><h2 style="font-size:15px;margin-bottom:8px">Slowest tests</h2>${slow}</div><div class="card"><h2 style="font-size:15px;margin-bottom:8px">Most failing tests</h2>${failing}</div></div></section>
</main><footer class="foot"><span>Generated by EZTest on ${e(t.generatedAt.replace('T', ' ').slice(0, 16))} UTC from .eztest/history.json</span></footer>
<div class="tip" id="tip" role="tooltip" hidden></div><script>${MINI_SCRIPT}</script></body></html>`;
}
