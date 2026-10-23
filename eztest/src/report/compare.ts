/**
 * `eztest report compare <baseline> <run>`: this run against a baseline run -
 * newly failing, fixed, still failing, slower, faster, new and removed tests,
 * and the key figures before and after - as a self-contained HTML page and JSON.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { escapeHtml as e } from './escape.js';
import { compareRunResults, type ComparisonModel, type Kpis } from './data.js';
import { columnChart, fmtMs, fmtPct } from './charts.js';
import { REPORT_CSS } from './styles.js';
import { MINI_SCRIPT } from './mini-script.js';

export async function loadRun(runDir: string): Promise<RunResult> {
  const p = join(runDir, 'run.json');
  if (!existsSync(p)) throw new EzTestError(`run.json not found in ${runDir}`, 'RUN_NOT_FOUND');
  const run = JSON.parse(await readFile(p, 'utf8')) as RunResult;
  if (!run || !Array.isArray(run.journeys)) throw new EzTestError(`${p} is not a run result`, 'RUN_INVALID');
  return run;
}

export async function compareRunDirs(baselineDir: string, runDir: string): Promise<{ comparison: ComparisonModel; baseline: RunResult; run: RunResult }> {
  const [baseline, run] = await Promise.all([loadRun(baselineDir), loadRun(runDir)]);
  return { comparison: compareRunResults(baseline, run), baseline, run };
}

const kpiRow = (label: string, a: string, b: string, better?: boolean) => `<tr><th scope="row">${e(label)}</th><td class="num">${e(a)}</td><td class="num">${e(b)}</td><td>${better === undefined ? '' : better ? '<span class="badge b-passed">better</span>' : '<span class="badge b-failed">worse</span>'}</td></tr>`;

function kpiTable(a: Kpis, b: Kpis): string {
  const cmp = (x: number, y: number, up: boolean) => (x === y ? undefined : up ? y > x : y < x);
  return `<table><caption class="sr-only">Key figures before and after</caption><thead><tr><th scope="col">Figure</th><th scope="col">Baseline</th><th scope="col">This run</th><th scope="col">Change</th></tr></thead><tbody>
${kpiRow('Tests', String(a.total), String(b.total))}
${kpiRow('Pass rate', fmtPct(a.passRate), fmtPct(b.passRate), cmp(a.passRate, b.passRate, true))}
${kpiRow('Failed', String(a.failed + a.errors), String(b.failed + b.errors), cmp(a.failed + a.errors, b.failed + b.errors, false))}
${kpiRow('Flaky', String(a.flaky), String(b.flaky), cmp(a.flaky, b.flaky, false))}
${kpiRow('Healed', String(a.healed), String(b.healed), cmp(a.healed, b.healed, false))}
${kpiRow('Skipped', String(a.skipped), String(b.skipped))}
${kpiRow('Duration', fmtMs(a.durationMs), fmtMs(b.durationMs), cmp(a.durationMs, b.durationMs, false))}</tbody></table>`;
}

/** The comparison page. `reportHref` links tests into each run's report.html (relative to the page). */
export function renderComparisonHtml(c: ComparisonModel, o: { runId: string; runStartedAt: string; title?: string; baselineReport?: string; runReport?: string; brand?: string }): string {
  const link = (href: string | undefined, id: string, name: string) => (href ? `<a href="${e(`${href}#test/${encodeURIComponent(id)}`)}">${e(name)}</a>` : e(name));
  const list = <T extends { id: string; name: string }>(items: T[], href: string | undefined, extra: (x: T) => string) =>
    items.length ? `<ul>${items.slice(0, 500).map((x) => `<li>${link(href, x.id, x.name)} ${extra(x)}</li>`).join('')}${items.length > 500 ? `<li class="muted">+${items.length - 500} more</li>` : ''}</ul>` : '<p class="muted small">None.</p>';
  const chart = columnChart([
    { label: 'Newly failing', value: c.newlyFailing.length, cls: 'st-failed' },
    { label: 'Still failing', value: c.stillFailing.length, cls: 'st-error' },
    { label: 'Fixed', value: c.fixed.length, cls: 'st-passed' },
    { label: 'Slower', value: c.slower.length, cls: 'series-2' },
    { label: 'Faster', value: c.faster.length, cls: 'series-1' },
    { label: 'New', value: c.added.length, cls: 'series-1' },
    { label: 'Removed', value: c.removed.length, cls: 'st-skipped' },
  ], { title: 'Changes between the runs', yLabel: 'change', yFormat: (v) => String(Math.round(v)), height: 220 });
  const title = o.title ?? 'Run comparison';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${e(title)}: ${e(c.baselineRunId)} vs ${e(o.runId)}</title><style>${REPORT_CSS}</style></head><body>
<header class="topbar"><div class="topbar-in"><div class="brand"><span class="brand-mark" aria-hidden="true">${e((o.brand ?? 'EZ').slice(0, 2).toUpperCase())}</span><div class="brand-text"><div class="brand-name">${e(o.brand ?? 'EZTest')}</div><h1>${e(title)}</h1></div></div>
<span class="small muted"><code>${e(c.baselineRunId)}</code> &rarr; <code>${e(o.runId)}</code></span><div class="top-actions"><button type="button" class="btn" id="theme-toggle" aria-pressed="false">Dark theme</button></div></div></header>
<main id="main">
<section class="block" aria-labelledby="k-h"><div class="block-head"><h2 id="k-h">Key figures</h2><p>Baseline ${e(c.baselineStartedAt)} &middot; this run ${e(o.runStartedAt)}</p></div>
<div class="grid g-2"><div class="card">${kpiTable(c.kpis.before, c.kpis.after)}</div><div class="card"><h3>What changed</h3>${chart}</div></div></section>
<section class="block" aria-labelledby="c-h"><div class="block-head"><h2 id="c-h">Tests</h2><p>Slower and faster: at least 1.5 times and 500 ms apart.</p></div><div class="cmp-cols">
<div class="card"><h3>Newly failing <span class="cnt ink-failed">${e(c.newlyFailing.length)}</span></h3>${list(c.newlyFailing, o.runReport, (x) => `<span class="muted small">${e(x.before)} &rarr; ${e(x.after)}</span>`)}</div>
<div class="card"><h3>Fixed <span class="cnt">${e(c.fixed.length)}</span></h3>${list(c.fixed, o.runReport, (x) => `<span class="muted small">${e(x.before)} &rarr; ${e(x.after)}</span>`)}</div>
<div class="card"><h3>Still failing <span class="cnt">${e(c.stillFailing.length)}</span></h3>${list(c.stillFailing, o.runReport, () => '')}</div>
<div class="card"><h3>Slower <span class="cnt">${e(c.slower.length)}</span></h3>${list(c.slower, o.runReport, (x) => `<span class="muted small">${e(fmtMs(x.beforeMs))} &rarr; ${e(fmtMs(x.afterMs))} (${e(x.ratio)}x)</span>`)}</div>
<div class="card"><h3>Faster <span class="cnt">${e(c.faster.length)}</span></h3>${list(c.faster, o.runReport, (x) => `<span class="muted small">${e(fmtMs(x.beforeMs))} &rarr; ${e(fmtMs(x.afterMs))}</span>`)}</div>
<div class="card"><h3>New tests <span class="cnt">${e(c.added.length)}</span></h3>${list(c.added, o.runReport, (x) => `<span class="muted small">${e(x.state)}</span>`)}</div>
<div class="card"><h3>Removed <span class="cnt">${e(c.removed.length)}</span></h3>${list(c.removed, o.baselineReport, () => '')}</div>
</div></section></main><div class="tip" id="tip" role="tooltip" hidden></div><script>${MINI_SCRIPT}</script></body></html>`;
}

/** A relative link from `fromDir` to `<runDir>/report.html`, when the report exists. */
export function reportHrefFrom(fromDir: string, runDir: string): string | undefined {
  const p = join(runDir, 'report.html');
  if (!existsSync(p)) return undefined;
  return relative(fromDir, p).split(sep).map(encodeURIComponent).join('/');
}
