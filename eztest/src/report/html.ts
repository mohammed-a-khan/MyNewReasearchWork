/**
 * The HTML run report: one self-contained file (no CDN, no external assets;
 * evidence is linked relative to the run directory), that works offline and
 * from file://, prints as an executive summary and scales to tens of
 * thousands of tests.
 *
 * - The executive summary, failure analysis, comparison, integrations and run
 *   context are static HTML and SVG (they read without script, in print and
 *   in mail clients).
 * - The test explorer (tree, filters, search, facets, sort, permalinks,
 *   keyboard navigation) and each test's detail are built by the inline
 *   script from the embedded model (JSON in a non-executable script element,
 *   `<` escaped); it uses DOM APIs and textContent only, never innerHTML of
 *   data. The list is virtualised: only the rows in view are in the DOM.
 */
import type { RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { apiCoverageHtml } from '../contracts/coverage.js';
import { escapeHtml as e } from './escape.js';
import { buildReportModel, STATE_LABEL, TEST_STATES, type Kpis, type ReportModel, type ReportModelInput, type TestState } from './data.js';
import { columnChart, donutChart, durationBins, fmtMs, fmtPct, ganttChart, hbarChart, lineChart, meter } from './charts.js';
import { icon, STATE_ICON } from './icons.js';
import { REPORT_CSS } from './styles.js';
import { REPORT_SCRIPT } from './client.js';
import type { ReportInsights } from './model.js';
import { bddHierarchy, type BddScenarioEntry } from './bdd.js';
import type { RunResult as Run } from '../core/index.js';

const STATUS_STATE: Record<string, TestState> = { passed: 'passed', 'passed-healed': 'healed', failed: 'failed', error: 'error', skipped: 'skipped', blocked: 'error' };
const sbadge = (s: string) => badge(STATUS_STATE[s] ?? 'skipped');
const MATCH_LABEL: Record<string, string> = { definition: 'step definition', ez: 'EZTest phrasing', undefined: 'undefined', ambiguous: 'ambiguous' };

function bddScenario(sc: BddScenarioEntry): string {
  const steps = sc.steps.map((st) => `<li class="g-step">${sbadge(st.status)} <span class="g-kw">${e(st.keyword)}</span> ${e(st.text)}${st.match ? ` <small class="muted" title="${e(st.location ?? '')}">${e(MATCH_LABEL[st.match] ?? st.match)}${st.location ? ` &middot; ${e(st.location)}` : ''}</small>` : ''}${st.error ? `<div class="g-err">${e(st.error)}</div>` : ''}</li>`).join('');
  const hooks = sc.hookFailures.map((h) => `<li class="g-step">${sbadge('failed')} ${e(h)}</li>`).join('');
  return `<li class="g-scenario"><details${sc.status === 'failed' || sc.status === 'error' ? ' open' : ''}><summary>${sbadge(sc.status)} <span class="g-kw">${e(sc.keyword)}:</span> <a href="${testHref(sc.journeyId)}">${e(sc.name)}</a> <small class="muted">line ${e(sc.line)}${sc.examples ? ` &middot; ${e(sc.examples.name || 'Examples')} row ${e((sc.examples.row?.index ?? 0) + 1)}` : ''} &middot; ${e(fmtMs(sc.durationMs))}</small></summary><ol class="g-steps">${steps}${hooks}</ol></details></li>`;
}

/** Feature / rule / scenario hierarchy of the run's Gherkin scenarios (docs/bdd.md). */
export function featuresBlock(run: Run): string {
  const h = bddHierarchy(run);
  if (!h) return '';
  const t = h.totals;
  const features = h.features.map((f) => {
    const c = f.counts;
    const rules = f.rules.map((r) => `<li class="g-rule"><details open><summary>${sbadge(r.status)} <span class="g-kw">Rule:</span> ${e(r.name)} <small class="muted">line ${e(r.line)}</small></summary><ul class="g-scenarios">${r.scenarios.map(bddScenario).join('')}</ul></details></li>`).join('');
    return `<li class="g-feature"><details${f.status === 'failed' || f.status === 'error' ? ' open' : ''}><summary>${sbadge(f.status)} <strong>${e(f.name || f.file)}</strong> <small class="muted">${e(f.file)} &middot; ${e(c.passed + c.passedHealed)} passed, ${e(c.failed + c.errors)} failed, ${e(c.skipped)} skipped</small></summary>
<ul class="g-scenarios">${f.scenarios.map(bddScenario).join('')}${rules}</ul></details></li>`;
  }).join('');
  return `<section class="block" id="features" aria-labelledby="features-h"><div class="block-head"><h2 id="features-h">Features</h2><p>${e(t.features)} feature(s), ${e(t.rules)} rule(s), ${e(t.scenarios)} scenario(s), ${e(t.steps)} step(s): ${e(t.passed + t.passedHealed)} passed, ${e(t.failed + t.errors)} failed, ${e(t.skipped)} skipped</p></div>
<div class="card"><ul class="g-features">${features}</ul></div></section>`;
}

export interface HtmlReportOptions extends ReportInsights, Omit<ReportModelInput, keyof ReportInsights> {
  title?: string;
  /** Export files written next to the report (linked from the header). */
  exports?: Array<{ label: string; href: string }>;
}

/** Embed JSON in a script element: it cannot end the element or start a comment. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const testHref = (id: string) => `#test/${encodeURIComponent(id)}`;
const badge = (s: TestState) => `<span class="badge b-${s}">${icon(STATE_ICON[s])}${e(STATE_LABEL[s])}</span>`;
const ext = (url: string | undefined, label: string, cls = '') => (url ? `<a class="${cls}" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)}<span class="sr-only"> (opens in a new tab)</span></a>` : `<span class="${cls}">${e(label)}</span>`);
const fmtDate = (iso: string | undefined) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
};
const shortDate = (iso: string, time = false) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return time ? `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : day;
};

function delta(cur: number, prev: number | undefined, o: { goodWhen: 'up' | 'down' | 'none'; fmt?: (n: number) => string; pp?: boolean }): string {
  if (prev === undefined) return '<span class="kpi-delta">no previous run</span>';
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return '<span class="kpi-delta">no change vs previous</span>';
  const txt = o.pp ? `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)} pp` : `${d > 0 ? '+' : '\u2212'}${o.fmt ? o.fmt(Math.abs(d)) : Math.abs(d)}`;
  const cls = o.goodWhen === 'none' ? '' : (d > 0) === (o.goodWhen === 'up') ? 'good' : 'bad';
  return `<span class="kpi-delta ${cls}">${e(txt)} vs previous</span>`;
}

function kpiTiles(m: ReportModel): string {
  const k = m.kpis;
  const p: Kpis | undefined = m.previous?.kpis;
  const tile = (cls: string, label: string, value: string, d: string, href?: string, ico?: string) => {
    const inner = `<div class="kpi-label">${ico ? icon(ico) : ''}${e(label)}</div><div class="kpi-value">${e(value)}</div>${d}`;
    return `<div class="kpi ${cls}">${href ? `<a href="${href}" data-filter-link="${e(href.slice(8))}">${inner}</a>` : inner}</div>`;
  };
  return `<div class="kpis" role="list" aria-label="Key figures">${[
    tile('k-accent', 'Total tests', String(k.total), delta(k.total, p?.total, { goodWhen: 'none' }), '#filter/all'),
    tile('k-passed', 'Passed', String(k.passed), delta(k.passed, p?.passed, { goodWhen: 'up' }), '#filter/passed', 'check'),
    tile('k-failed', 'Failed', String(k.failed + k.errors), delta(k.failed + k.errors, p ? p.failed + p.errors : undefined, { goodWhen: 'down' }), '#filter/failed', 'x'),
    tile('k-flaky', 'Flaky', String(k.flaky), delta(k.flaky, p?.flaky, { goodWhen: 'down' }), '#filter/flaky', 'retry'),
    tile('k-healed', 'Healed', String(k.healed), delta(k.healed, p?.healed, { goodWhen: 'down' }), '#filter/healed', 'heal'),
    tile('k-skipped', 'Skipped', String(k.skipped), delta(k.skipped, p?.skipped, { goodWhen: 'none' }), '#filter/skipped', 'minus'),
    tile('k-accent', 'Pass rate', fmtPct(k.passRate), delta(k.passRate, p?.passRate, { goodWhen: 'up', pp: true })),
    tile('k-accent', 'Duration', fmtMs(k.durationMs), delta(k.durationMs, p?.durationMs, { goodWhen: 'down', fmt: fmtMs })),
  ].map((t) => t.replace('<div class="kpi ', '<div role="listitem" class="kpi ')).join('')}</div>`;
}

function verdictCard(m: ReportModel): string {
  const v = m.verdict;
  const ico = v.decision === 'GO' ? 'check' : v.decision === 'NO_GO' ? 'x' : 'alert';
  const label = v.decision.replace(/_/g, ' ');
  const rank: Record<string, number> = { violation: 0, risk: 1, waived: 2, 'missing-input': 3, pass: 4, info: 5 };
  const reasons = [...v.reasons]
    .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9))
    .map((r) => {
      const cites = [
        ...r.tests.slice(0, 5).map((t) => `<a href="${testHref(t)}">${e(t)}</a>`),
        ...(r.tests.length > 5 ? [`<span class="muted">+${r.tests.length - 5} more</span>`] : []),
        ...r.requirements.slice(0, 6).map((q) => `<code>${e(q)}</code>`),
        ...r.evidence.slice(0, 4).map((x) => evLink(m, x)),
        ...(r.evidence.length > 4 ? [`<span class="muted">+${r.evidence.length - 4} evidence</span>`] : []),
      ];
      return `<li><span class="rk ${e(r.kind)}">${e(r.kind)}</span><span>${e(r.text)}${cites.length ? ` <span class="cites">${cites.join(', ')}</span>` : ''}</span></li>`;
    })
    .join('');
  const gates = v.gates.length ? `<div class="gates"><span class="sr-only">Readiness gates: </span>${v.gates.map((g) => `<span class="gate g-${e(g.status)}" title="${e(g.summary)}">${e(g.gate)}: ${e(g.status)}</span>`).join('')}</div>` : '';
  const exc = v.exceptions.length ? `<p class="small">Exceptions applied: ${v.exceptions.map((x) => `${e(x.gate)} approved by <strong>${e(x.approver)}</strong> (${e(x.reason)})`).join('; ')}</p>` : '';
  const perBrowser = v.browsers ? `<p class="small">Per browser: ${Object.entries(v.browsers).map(([b, r]) => `${e(b)} <strong>${e(r.decision.replace(/_/g, ' '))}</strong> (${e(r.score)})`).join(' &middot; ')}</p>` : '';
  return `<section class="card verdict v-${e(v.decision)}" aria-labelledby="verdict-h">
<div class="v-badge"><div class="v-icon">${icon(ico)}</div><div><div class="v-label" id="verdict-h">Release readiness</div><div class="v-decision">${e(label)}</div>${v.score !== undefined ? `<div class="v-score">score ${e(v.score)} / 100</div>` : `<div class="v-score">built-in rule</div>`}</div></div>
<div><ul class="reasons">${reasons}</ul>${gates}${exc}${perBrowser}</div></section>`;
}

function evLink(m: ReportModel, id: string): string {
  const r = m.evidence[id];
  if (!r) return `<span class="mono muted" title="not in the evidence manifest">${e(id)}</span>`;
  const kind = m.evidenceKinds[r[0]] ?? '';
  return r[1] ? `<a class="mono" href="${e(r[1])}" title="${e(`${kind}${r[2] ? `: ${r[2]}` : ''}`)}">${e(id)}</a>` : `<span class="mono">${e(id)}</span>`;
}

function summaryCharts(m: ReportModel): string {
  const k = m.kpis;
  const segs = TEST_STATES.map((s) => ({ key: s, label: STATE_LABEL[s], value: s === 'failed' ? k.failed : s === 'error' ? k.errors : s === 'passed' ? k.passed : s === 'healed' ? k.healed : s === 'flaky' ? k.flaky : k.skipped }));
  const donut = donutChart(segs, { title: 'Outcome of every test', centre: fmtPct(k.passRate, 1), centreLabel: 'pass rate' });
  const trend = m.trend;
  const trendPass = trend.length >= 2
    ? lineChart(trend.map((t) => ({ label: shortDate(t.startedAt), value: t.passRate, detail: `${shortDate(t.startedAt, true)} UTC, ${t.total} tests, ${t.failed} failed${t.readiness ? `, ${t.readiness.replace(/_/g, ' ')}` : ''}`, current: t.current })), { title: `Pass rate, last ${trend.length} runs`, yMax: 1, yFormat: (v) => fmtPct(v, 0), series: 'series-1', area: true })
    : '<p class="muted">The trend appears after the second recorded run (history: .eztest/history.json).</p>';
  const trendDur = trend.length >= 2
    ? columnChart(trend.map((t) => ({ label: shortDate(t.startedAt), value: t.durationMs, tip: `${shortDate(t.startedAt, true)} UTC: ${fmtMs(t.durationMs)}${t.current ? ' (this run)' : ''}`, cls: t.current ? 'series-1' : 'muted' })), { title: `Run duration, last ${trend.length} runs`, yLabel: 'run', yFormat: fmtMs })
    : '<p class="muted">No earlier runs yet.</p>';
  const executed = m.tests.filter((t) => t.state !== 'skipped');
  const dist = executed.length ? columnChart(durationBins(executed.map((t) => t.durationMs)), { title: 'Test duration distribution', yLabel: 'test duration', yFormat: (v) => String(Math.round(v)), width: 720, height: 230 }) : '<p class="muted">Nothing executed.</p>';
  const slow = m.slowest.length
    ? hbarChart(m.slowest.map((s) => ({ label: s.name, value: s.durationMs, valueLabel: fmtMs(s.durationMs), cls: `st-${s.state}`, href: testHref(s.id), tip: `${s.name}: ${fmtMs(s.durationMs)} (${STATE_LABEL[s.state]})` })), { title: 'Slowest tests', unit: 'Duration', width: 720, labelWidth: 260 })
    : '<p class="muted">Nothing executed.</p>';
  const clusters = m.clusters.length
    ? hbarChart(m.clusters.slice(0, 6).map((c) => ({ label: c.message, value: c.size, valueLabel: `${c.size} test${c.size === 1 ? '' : 's'}`, cls: 'st-failed', href: `#failure/${encodeURIComponent(c.id)}`, tip: `${c.message} - ${c.size} test(s)${c.category ? `, ${c.category}` : ''}` })), { title: 'Top failure clusters', unit: 'Tests', labelWidth: 300, width: 720 })
    : `<p class="muted">${k.failed + k.errors ? 'No clusters.' : 'No failures in this run.'}</p>`;
  const cov = m.coverage;
  const meters = [
    cov.risk ? meter(cov.risk.ratio, { label: 'Risk-weighted coverage', detail: `${cov.risk.covered} of ${cov.risk.total} risk points passed` }) : '',
    cov.requirements ? meter(cov.requirements.ratio, { label: 'Requirements passing', detail: `${cov.requirements.passing} of ${cov.requirements.total} requirements; ${cov.requirements.failing} failing, ${cov.requirements.notRun} not run, ${cov.requirements.uncovered} without tests` }) : '',
    ...(cov.api ?? []).map((a) => meter(a.ratio, { label: `API coverage: ${a.title}`, detail: `${a.covered} of ${a.operations} operations; status codes ${fmtPct(a.statusRatio, 0)}; ${a.violations} contract violation(s)` })),
    cov.ui ? meter(cov.ui.percent, { label: 'UI coverage', detail: `${cov.ui.tested} of ${cov.ui.elements} elements on ${cov.ui.pages} page(s)` }) : '',
  ].filter(Boolean).join('');
  const spans = executed.map((t) => ({ id: t.id, label: t.name, start: t.startMs, end: t.startMs + Math.max(1, t.durationMs), cls: `st-${t.state}`, href: testHref(t.id) }));
  const gantt = spans.length ? ganttChart(spans, { title: 'Execution timeline (parallel lanes)', totalMs: m.durationMs }) : '';
  return `<div class="grid g-3">
<div class="card"><h3>Outcome</h3>${donut}</div>
<div class="card"><h3>Pass rate trend</h3><p class="card-sub">Executed tests that passed, per run, from history.</p>${trendPass}</div>
<div class="card"><h3>Duration trend</h3><p class="card-sub">Wall-clock duration of each run.</p>${trendDur}</div></div>
<div class="grid g-2" style="margin-top:16px">
<div class="card"><h3>Duration distribution</h3><p class="card-sub">How long tests take: number of tests per duration band.</p>${dist}</div>
<div class="card"><h3>Slowest tests</h3>${slow}</div></div>
<div class="grid g-2" style="margin-top:16px">
<div class="card"><h3>Top failure clusters</h3><p class="card-sub">Failures with similar messages and stack frames, likely one root cause each.</p>${clusters}</div>
<div class="card"><h3>Coverage</h3>${meters || '<p class="muted">No coverage data in this run (requirements, risk, API spec or UI map).</p>'}</div></div>
${gantt ? `<details class="card" style="margin-top:16px"><summary><h3 style="display:inline">Execution timeline</h3> <span class="muted small">tests on parallel lanes, by start time</span></summary><div style="margin-top:10px;overflow-x:auto">${gantt}</div></details>` : ''}`;
}

function browsersBlock(m: ReportModel): string {
  const b = m.browsers;
  if (!b) return '';
  const rows = b.names.map((n) => {
    const x = b.perBrowser[n];
    return `<tr><th scope="row">${e(n)}</th><td>${e(x.version ?? '')}</td><td class="num">${e(x.total)}</td><td class="num">${e(x.passed)}</td><td class="num">${e(x.failed)}</td><td class="num">${e(x.skipped)}</td><td>${x.decision ? `${e(x.decision.replace(/_/g, ' '))} (${e(x.score)})` : '-'}</td></tr>`;
  }).join('');
  const grid = b.grid.map((g) => `<tr><th scope="row">${e(g.unit)}</th>${g.cells.map((c) => `<td>${c.id && c.state ? `<a href="${testHref(c.id)}">${badge(c.state)}</a>` : '<span class="muted">-</span>'}</td>`).join('')}<td>${g.only.length ? `<strong class="ink-failed">fails on ${e(g.only.join(', '))} only</strong>` : ''}</td></tr>`).join('');
  return `<section class="block" aria-labelledby="browsers-h"><div class="block-head"><h2 id="browsers-h">Browsers</h2><p>Each journey ran on every browser; the summary above is all browsers combined.</p></div>
<div class="grid g-3-2"><div class="card"><div class="tbl-wrap"><table><caption class="sr-only">Per browser</caption><thead><tr><th scope="col">Browser</th><th scope="col">Version</th><th scope="col">Units</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Skipped</th><th scope="col">Readiness</th></tr></thead><tbody>${rows}</tbody></table></div></div>
<div class="card"><div class="tbl-wrap"><table><caption class="sr-only">Journey x browser</caption><thead><tr><th scope="col">Journey</th>${b.names.map((n) => `<th scope="col">${e(n)}</th>`).join('')}<th scope="col">Browser-specific</th></tr></thead><tbody>${grid}</tbody></table></div></div></div></section>`;
}

function failuresBlock(m: ReportModel): string {
  const failed = m.tests.filter((t) => t.state === 'failed' || t.state === 'error');
  if (!failed.length && !m.tests.some((t) => t.state === 'flaky')) {
    return `<section class="block" id="failures" aria-labelledby="failures-h"><div class="block-head"><h2 id="failures-h">Failure analysis</h2></div><div class="card"><p>${icon('check')} No failures in this run.</p></div></section>`;
  }
  const groups = m.failureGroups.map((g) => `<tr id="sig-${e(g.signature)}"><td><pre>${e(g.message)}</pre><div class="small muted mono">signature ${e(g.signature)}</div></td><td class="num">${e(g.tests.length)}</td><td>${g.known ? `<span class="badge b-neutral">known</span>` : `<span class="badge b-failed">new</span>`}</td><td>${g.firstSeenRun ? `${e(shortDate(g.firstSeenAt ?? '', true))}<div class="small muted mono">${e(g.firstSeenRun)}</div>` : '<span class="muted">this run</span>'}</td><td>${g.category ? e(g.category) : '-'}</td><td><div class="chips">${g.tests.slice(0, 12).map((t) => `<a class="chip" href="${testHref(t)}">${e(t)}</a>`).join('')}${g.tests.length > 12 ? `<span class="muted small">+${g.tests.length - 12} more</span>` : ''}</div></td><td><button type="button" class="btn no-print" data-copy-bug="${e(g.tests[0])}">${icon('copy')}Copy for bug</button></td></tr>`).join('');
  const clusters = m.clusters.map((c) => `<li id="failure/${e(c.id)}"><strong>${e(c.id)}</strong> &middot; ${e(c.size)} test(s)${c.category ? ` &middot; ${e(c.category)}` : ''} &middot; cohesion ${e(fmtPct(c.cohesion, 0))}<pre>${e(c.message)}</pre><div class="chips">${c.tests.slice(0, 20).map((t) => `<a class="chip" href="${testHref(t)}">${e(t)}</a>`).join('')}</div></li>`).join('');
  const cap = 200;
  const list = [...failed, ...m.tests.filter((t) => t.state === 'flaky')].slice(0, cap);
  const rows = list.map((t) => `<tr><td>${badge(t.state)}</td><td><a href="${testHref(t.id)}">${e(t.name)}</a><div class="small muted mono">${e(t.id)}${t.browser ? ` &middot; ${e(t.browser)}` : ''}</div></td><td>${e(t.failedStep ?? '')}<pre class="small">${e((t.error?.message ?? t.flake?.reason ?? '').split('\n')[0].slice(0, 220))}</pre></td><td>${t.triage ? `${e(t.triage.category)} <span class="muted">(${e(Math.round(t.triage.confidence * 100))}%)</span>` : '-'}</td><td>${e(t.owners.join(', ') || '-')}</td><td>${t.bugs.map((b) => ext(b.url, `${b.system === 'ado' ? 'Bug' : ''} ${b.id}`.trim())).join(', ') || '-'}</td></tr>`).join('');
  return `<section class="block" id="failures" aria-labelledby="failures-h"><div class="block-head"><h2 id="failures-h">Failure analysis</h2><p>${e(failed.length)} failing test(s) in ${e(m.failureGroups.length)} distinct error signature(s); ${e(m.failureGroups.filter((g) => !g.known).length)} new, ${e(m.failureGroups.filter((g) => g.known).length)} seen in earlier runs.</p></div>
${m.failureGroups.length ? `<div class="card"><h3>Errors by signature</h3><p class="card-sub">Same normalised message and stack frames. "Known" means an earlier run in history failed the same way.</p><div class="tbl-wrap"><table><thead><tr><th scope="col">Error</th><th scope="col">Tests</th><th scope="col">New or known</th><th scope="col">First seen</th><th scope="col">Probable cause</th><th scope="col">Tests sharing it</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${groups}</tbody></table></div></div>` : ''}
${clusters ? `<div class="card" style="margin-top:16px"><h3>Shared root causes</h3><p class="card-sub">Clusters of similar failures (they may differ in detail but probably share a cause).</p><ul class="reasons" style="gap:12px">${clusters}</ul></div>` : ''}
<div class="card" style="margin-top:16px"><h3>Failing and flaky tests</h3>${list.length < failed.length + m.tests.filter((t) => t.state === 'flaky').length ? `<p class="card-sub">First ${cap}; the test explorer has all of them.</p>` : ''}<div class="tbl-wrap"><table><thead><tr><th scope="col">State</th><th scope="col">Test</th><th scope="col">Where it failed</th><th scope="col">Triage</th><th scope="col">Owners</th><th scope="col">Bugs</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`;
}

function comparisonBlock(m: ReportModel): string {
  const c = m.comparison;
  if (!c) return `<section class="block" id="comparison" aria-labelledby="cmp-h"><div class="block-head"><h2 id="cmp-h">Comparison</h2></div><div class="card"><p class="muted">No baseline run to compare with. Compare any two runs with <code>eztest report compare &lt;baselineRunDir&gt; &lt;runDir&gt;</code>.</p></div></section>`;
  const list = (items: Array<{ id: string; name: string }>, extra: (x: never) => string, empty: string) =>
    items.length ? `<ul>${items.slice(0, 100).map((x) => `<li><a href="${testHref(x.id)}">${e(x.name)}</a> ${extra(x as never)}</li>`).join('')}${items.length > 100 ? `<li class="muted">+${items.length - 100} more</li>` : ''}</ul>` : `<p class="muted small">${e(empty)}</p>`;
  const b = c.kpis.before;
  const a = c.kpis.after;
  return `<section class="block" id="comparison" aria-labelledby="cmp-h"><div class="block-head"><h2 id="cmp-h">Comparison</h2><p>This run against baseline <code>${e(c.baselineRunId)}</code> (${e(fmtDate(c.baselineStartedAt))}). Pass rate ${e(fmtPct(b.passRate))} &rarr; ${e(fmtPct(a.passRate))}; duration ${e(fmtMs(b.durationMs))} &rarr; ${e(fmtMs(a.durationMs))}.</p></div>
<div class="cmp-cols">
<div class="card"><h3>Newly failing <span class="cnt ink-failed">${e(c.newlyFailing.length)}</span></h3>${list(c.newlyFailing, (x: { before: string }) => `<span class="muted small">was ${e(x.before)}</span>`, 'None.')}</div>
<div class="card"><h3>Fixed <span class="cnt">${e(c.fixed.length)}</span></h3>${list(c.fixed, (x: { before: string }) => `<span class="muted small">was ${e(x.before)}</span>`, 'None.')}</div>
<div class="card"><h3>Slower <span class="cnt">${e(c.slower.length)}</span></h3>${list(c.slower, (x: { beforeMs: number; afterMs: number; ratio: number }) => `<span class="muted small">${e(fmtMs(x.beforeMs))} &rarr; ${e(fmtMs(x.afterMs))} (${e(x.ratio)}x)</span>`, 'No test got 1.5x slower.')}</div>
<div class="card"><h3>New tests <span class="cnt">${e(c.added.length)}</span></h3>${list(c.added, (x: { state: TestState }) => badge(x.state), 'None.')}</div>
<div class="card"><h3>Still failing <span class="cnt">${e(c.stillFailing.length)}</span></h3>${list(c.stillFailing, () => '', 'None.')}</div>
<div class="card"><h3>Removed <span class="cnt">${e(c.removed.length)}</span></h3><ul>${c.removed.slice(0, 100).map((x) => `<li>${e(x.name)} <span class="muted small mono">${e(x.id)}</span></li>`).join('') || '<li class="muted small">None.</li>'}</ul></div>
</div></section>`;
}

function statusBadge(s: string | undefined, ok?: boolean): string {
  if (!s) return '';
  const cls = s === 'success' || ok === true ? 'b-passed' : s === 'partial' ? 'b-flaky' : s === 'failed' || ok === false ? 'b-failed' : 'b-neutral';
  return `<span class="badge status ${cls}">${e(s)}</span>`;
}

function integrationsBlock(m: ReportModel): string {
  const i = m.integrations;
  const cards: string[] = [];
  const ado = i.ado;
  if (ado) {
    const p = ado.publish;
    const tc = m.tests.flatMap((t) => (t.ado?.testCases ?? []).map((c) => ({ t, c })));
    cards.push(`<div class="card int-card" id="int-ado"><h3>Azure DevOps ${p ? statusBadge(p.status) : '<span class="badge status b-neutral">not published</span>'}</h3>
${ado.project ? `<p class="small muted">${ext(ado.collectionUrl, ado.collectionUrl ?? '')} &middot; project ${e(ado.project)}</p>` : '<p class="small muted">Not configured (ado.organizationUrl and ado.project).</p>'}
${p ? `<dl class="kv"><dt>Test run</dt><dd>${p.runId ? ext(p.runUrl, `Run ${p.runId}${p.runName ? ` - ${p.runName}` : ''}`) : '-'}</dd><dt>Results</dt><dd>${e(p.results.length)} published${p.unmapped.length ? `, ${e(p.unmapped.length)} test(s) without @TestCaseId` : ''}${p.missingPoints.length ? `, ${e(p.missingPoints.length)} without a test point` : ''}</dd>${p.planId ? `<dt>Plan / suite</dt><dd>${e(p.planId)}${p.suiteId ? ` / ${e(p.suiteId)}` : ''}</dd>` : ''}<dt>Attachments</dt><dd>${e(p.attachments)}</dd><dt>When</dt><dd>${e(fmtDate(p.at))}</dd>${p.reason ? `<dt>Why</dt><dd>${e(p.reason)}</dd>` : ''}</dl>${p.warnings.length ? `<details><summary class="small">${e(p.warnings.length)} warning(s)</summary><ul class="small">${p.warnings.map((w) => `<li>${e(w)}</li>`).join('')}</ul></details>` : ''}` : '<p class="none">The run was not published to Azure Test Plans (ado.publishResults, or eztest ado publish).</p>'}
<p class="small"><strong>Linked test cases:</strong> ${tc.length ? tc.slice(0, 40).map(({ c }) => ext(c.url, `#${c.id}`)).join(', ') + (tc.length > 40 ? ` +${tc.length - 40} more` : '') : '<span class="muted">none (tag journeys with @TestCaseId:&lt;id&gt;)</span>'}</p>
<p class="small"><strong>Bugs:</strong> ${ado.bugs.length ? ado.bugs.map((b) => `${ext(b.url, `Bug ${b.id}`)} <span class="muted">(${e(b.action)}, ${e(b.journeyId)})</span>`).join(', ') : '<span class="muted">none filed</span>'}</p>
${ado.build ? `<p class="small"><strong>Pipeline build:</strong> ${ext(ado.build.url, ado.build.number ?? ado.build.id ?? 'build')}</p>` : ''}
${ado.release ? `<p class="small"><strong>Release:</strong> ${ext(ado.release.url, `${ado.release.name ?? 'release'}${ado.release.environment ? ` (${ado.release.environment})` : ''}`)}</p>` : ''}
${ado.requirementsCommented.length ? `<p class="small"><strong>Requirements commented:</strong> ${ado.requirementsCommented.map((r) => ext(r.url, `#${r.requirement}`)).join(', ')}</p>` : ''}</div>`);
  }
  const pr = i.pullRequest;
  cards.push(`<div class="card int-card" id="int-pr"><h3>Pull request ${pr?.comment ? statusBadge('posted', true) : ''}</h3>${pr ? `<dl class="kv"><dt>Pull request</dt><dd>${ext(pr.url, `#${pr.number}`)} <span class="muted">(${e(pr.provider)})</span></dd>${pr.comment ? `<dt>Comment</dt><dd>${e(pr.comment.action)}</dd>` : ''}${pr.status ? `<dt>Status</dt><dd>${e(pr.status.kind)}${pr.status.state ? ` ${e(pr.status.state)}` : ''}, ${e(pr.status.annotations)} annotation(s)</dd>` : ''}</dl>` : '<p class="none">No pull request for this run (eztest pr report posts the status and the summary comment).</p>'}</div>`);
  const jira = i.jira;
  cards.push(`<div class="card int-card" id="int-jira"><h3>Jira ${jira ? statusBadge(jira.status) : ''}</h3>${jira ? (jira.bugs.length ? `<ul>${jira.bugs.map((b) => `<li>${ext(b.url, b.key)} <span class="muted small">${e(b.action)} for ${e(b.journeyId)}</span></li>`).join('')}</ul>` : `<p class="none">No bugs filed${jira.reason ? `: ${e(jira.reason)}` : ''}.</p>`) : '<p class="none">The Jira publisher did not run for this run.</p>'}</div>`);
  const notes = i.notifications;
  cards.push(`<div class="card int-card" id="int-notify"><h3>Slack and Teams</h3>${notes.length ? `<ul>${notes.map((n) => `<li><strong>${e(n.channel)}</strong> ${statusBadge(n.ok ? 'sent' : 'failed', n.ok)} <span class="small">${e(n.message)}</span> <span class="muted small">${e(fmtDate(n.at))}</span></li>`).join('')}</ul>` : '<p class="none">No message sent (publishers: slack, teams).</p>'}</div>`);
  const git = i.git;
  const owners = [...new Set(m.tests.filter((t) => t.state === 'failed' || t.state === 'error').flatMap((t) => t.owners))];
  cards.push(`<div class="card int-card" id="int-git"><h3>Git and CODEOWNERS</h3>${git ? `<dl class="kv">${git.repository ? `<dt>Repository</dt><dd>${ext(git.repositoryUrl, git.repository)}</dd>` : ''}${git.branch ? `<dt>Branch</dt><dd><code>${e(git.branch)}</code></dd>` : ''}${git.commit ? `<dt>Commit</dt><dd>${ext(git.commitUrl, git.commit.slice(0, 12), 'mono')}</dd>` : ''}<dt>Owners of failing tests</dt><dd>${owners.length ? e(owners.join(', ')) : git.codeowners ? 'none failing' : '<span class="muted">no CODEOWNERS file</span>'}</dd></dl>` : '<p class="none">Not a git checkout.</p>'}</div>`);
  const rs = i.resultsServer;
  cards.push(`<div class="card int-card" id="int-server"><h3>Results server ${rs ? statusBadge(rs.verified === false ? 'not verified' : 'published', rs.verified !== false) : ''}</h3>${rs ? `<p>${ext(rs.url, 'Open this run on the EZTest results server')}</p><p class="small muted">${e(fmtDate(rs.at))}${rs.verified ? ' &middot; evidence verified by the server' : ''}</p>` : '<p class="none">Not published (server.url and --publish).</p>'}</div>`);
  if (i.publishers.length) cards.push(`<div class="card int-card"><h3>Other publishers</h3><ul>${i.publishers.map((p) => `<li><strong>${e(p.name)}</strong> ${statusBadge(p.skipped ? 'skipped' : p.ok ? 'ok' : 'failed', p.skipped ? undefined : p.ok)} <span class="small">${e(p.message)}</span></li>`).join('')}</ul></div>`);
  return `<section class="block" id="integrations" aria-labelledby="int-h"><div class="block-head"><h2 id="int-h">Integrations</h2><p>Where this run was published and who was told.</p></div><div class="int-grid">${cards.join('')}</div></section>`;
}

function contextBlock(m: ReportModel): string {
  const c = m.context;
  const dl = (rows: Array<[string, string | undefined]>) => `<dl class="kv">${rows.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `<dt>${e(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const env = dl([
    ['Environment', c?.environment ? e(c.environment) : undefined],
    ['Base URL', c?.baseUrl ? `<code>${e(c.baseUrl)}</code>` : undefined],
    ['Browsers', c?.browsers.length ? e(c.browsers.map((b) => `${b.name}${b.version ? ` ${b.version}` : ''}`).join(', ')) : 'none launched'],
    ['Devices', c?.devices.length ? e(c.devices.join(', ')) : undefined],
  ]);
  const build = dl([
    ['CI', c?.build ? e(c.build.system) : 'local run'],
    ['Pipeline', c?.build?.pipeline ? e(c.build.pipeline) : undefined],
    ['Build', c?.build ? ext(c.build.url, c.build.number ?? c.build.id ?? 'build') : undefined],
    ['Release', c?.release ? ext(c.release.url, `${c.release.name ?? ''}${c.release.environment ? ` (${c.release.environment})` : ''}`) : undefined],
    ['Branch', c?.branch ? `<code>${e(c.branch)}</code>${c.targetBranch ? ` &rarr; <code>${e(c.targetBranch)}</code>` : ''}` : undefined],
    ['Commit', c?.commit ? `${ext(c.commit.url, c.commit.sha.slice(0, 12), 'mono')}${c.commit.author ? ` by ${e(c.commit.author)}` : ''}` : undefined],
    ['Pull request', c?.pullRequest ? ext(c.pullRequest.url, `#${c.pullRequest.number}`) : undefined],
    ['Trigger', c?.trigger ? e(c.trigger) : undefined],
    ['Run by', c?.user ? e(c.user) : undefined],
  ]);
  const how = dl([
    ['EZTest', c ? e(c.eztestVersion) : undefined],
    ['Node.js', c ? e(c.node) : undefined],
    ['Machine', c ? e([c.machine.host, c.machine.os, c.machine.cpus ? `${c.machine.cpus} CPUs` : '', c.machine.memoryGb ? `${c.machine.memoryGb} GB` : ''].filter(Boolean).join(' \u00b7 ')) : undefined],
    ['Shard', c?.shard ? `${e(c.shard.index)} of ${e(c.shard.total)}` : undefined],
    ['Started', e(fmtDate(m.startedAt))],
    ['Finished', e(fmtDate(m.finishedAt))],
    ['Duration', e(fmtMs(m.durationMs))],
    ['Time zone', c ? e(c.timeZone) : undefined],
    ['Run id', `<code>${e(m.runId)}</code>`],
    ['Evidence head', m.evidenceHead ? `<code title="${e(m.evidenceHead)}">${e(m.evidenceHead.slice(0, 16))}</code> (hash-chained; eztest evidence verify)` : undefined],
  ]);
  const extra = c && Object.keys(c.extra).length ? `<details class="small" style="margin-top:8px"><summary>Other recorded environment values</summary>${dl(Object.entries(c.extra).map(([k, v]) => [k, `<code>${e(v)}</code>`]))}</details>` : '';
  return `<section class="block" id="context" aria-labelledby="ctx-h"><div class="block-head"><h2 id="ctx-h">Run context</h2></div><div class="ctx-grid">
<div class="card"><h3>Where</h3>${env}</div><div class="card"><h3>Build and pipeline</h3>${build}</div><div class="card"><h3>How</h3>${how}${extra}</div></div></section>`;
}

function evidenceBlock(m: ReportModel): string {
  const counts = new Map<string, number>();
  for (const v of Object.values(m.evidence)) counts.set(m.evidenceKinds[v[0]], (counts.get(m.evidenceKinds[v[0]]) ?? 0) + 1);
  const heal = m.healProposals.length
    ? `<div class="card" style="margin-top:16px"><h3>Heal proposals</h3><p class="card-sub">Locators EZTest healed during the run, for review (accept in Studio or eztest heal).</p><div class="tbl-wrap"><table><thead><tr><th scope="col">Test / step</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Tier</th><th scope="col">Confidence</th><th scope="col">Verified</th><th scope="col">Recommendation</th><th scope="col">Evidence</th></tr></thead><tbody>${m.healProposals
        .map((p) => `<tr><td><a href="${testHref(p.journeyId)}">${e(p.journeyName)}</a><div class="small muted mono">${e(p.stepId)}</div></td><td><code>${e(p.from.join(' | '))}</code></td><td><code>${e(p.to)}</code></td><td>${e(p.tier)}</td><td class="num">${e(Math.round(p.confidence * 100))}%</td><td>${p.verified ? '<span class="badge b-passed">yes</span>' : '<span class="badge b-failed">no</span>'}</td><td>${e(p.recommendation)}</td><td>${p.evidence.map((x) => evLink(m, x)).join(' ')}</td></tr>`)
        .join('')}</tbody></table></div></div>`
    : '';
  return `<section class="block" id="evidence" aria-labelledby="ev-h"><div class="block-head"><h2 id="ev-h">Evidence</h2><p>${e(Object.keys(m.evidence).length)} artefacts in the hash-chained evidence vault of this run.</p></div>
<div class="card"><div class="chips">${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="chip">${e(k)} <strong>${e(n)}</strong></span>`).join('') || '<span class="muted">No evidence manifest.</span>'}</div>${Object.keys(m.evidence).length ? '<div id="ev-browser" style="margin-top:12px"><p class="small muted">The evidence browser needs JavaScript.</p></div>' : ''}</div>${heal}${(m.extraHtml ?? []).map((h) => `<div class="card" style="margin-top:16px">${h}</div>`).join('')}</section>`;
}

/** The brand colour on the header mark and accents, with readable text on it. */
export function brandCss(color: string | undefined): string {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return '';
  const n = parseInt(color.slice(1), 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const ink = lum > 0.179 ? '#141413' : '#ffffff';
  return `.brand-mark{background:${color};color:${ink}}:root{--brand:${color}}.topbar{border-top:3px solid ${color}}.sections a[aria-current=true]{border-bottom-color:${color}}`;
}

/** Render the HTML report of a model. */
export function renderReportModelHtml(m: ReportModel, o: { exports?: Array<{ label: string; href: string }>; featuresHtml?: string } = {}): string {
  const k = m.kpis;
  const failing = k.failed + k.errors;
  const logo = m.brand.logo ? `<img src="${e(m.brand.logo)}" alt="${e(m.brand.name)} logo">` : `<span class="brand-mark" aria-hidden="true">${e(m.brand.name.slice(0, 2).toUpperCase())}</span>`;
  const exportsMenu = o.exports?.length
    ? `<div class="menu"><button type="button" class="btn" id="exports-btn" aria-haspopup="true" aria-expanded="false" aria-controls="exports-list">${icon('download')}Export</button><ul class="menu-list" id="exports-list" hidden>${o.exports.map((x) => `<li><a href="${e(x.href)}" download>${e(x.label)}</a></li>`).join('')}</ul></div>`
    : '';
  const health = m.health
    ? `<div class="banner" role="note">${m.health.preflight && !m.health.preflight.ok ? `<strong>Environment unavailable:</strong> ${e(m.health.preflight.failed.join('; '))} (nothing ran). ` : ''}${m.health.circuit ? `<strong>Circuit breaker opened</strong> after ${e(m.health.circuit.afterJourney)}: ${e(m.health.circuit.notRun)} test(s) not run (${e(m.health.circuit.reason)}).` : ''}</div>`
    : '';
  const clientData = {
    runId: m.runId,
    title: m.title,
    startedAt: m.startedAt,
    brand: m.brand.name,
    branch: m.context?.branch,
    commit: m.context?.commit?.sha,
    baseUrl: m.context?.baseUrl,
    environment: m.context?.environment,
    browsers: m.context?.browsers.map((b) => b.name),
    evidenceKinds: m.evidenceKinds,
    evidence: m.evidence,
    clusters: Object.fromEntries(m.clusters.map((c) => [c.id, c.message])),
    tests: m.tests,
    ...(m.snapshots ? { snapshots: m.snapshots } : {}),
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; media-src 'self' file: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="generator" content="EZTest ${e(m.context?.eztestVersion ?? '')}">
<title>${e(m.title)} - ${e(m.runId)}</title><style>${REPORT_CSS}${brandCss(m.brand.color)}</style></head>
<body><a class="skip" href="#main">Skip to the report</a>
<header class="topbar"><div class="topbar-in">
<div class="brand">${logo}<div class="brand-text"><div class="brand-name">${e(m.brand.name)}</div><h1>${e(m.title)}</h1></div></div>
<span class="badge ${m.verdict.decision === 'GO' ? 'b-passed' : m.verdict.decision === 'NO_GO' ? 'b-failed' : 'b-flaky'}" title="Release readiness">${icon(m.verdict.decision === 'GO' ? 'check' : m.verdict.decision === 'NO_GO' ? 'x' : 'alert')}${e(m.verdict.decision.replace(/_/g, ' '))}</span>
<span class="small muted">${e(fmtDate(m.startedAt))} &middot; ${e(fmtMs(m.durationMs))}${m.context?.branch ? ` &middot; <code>${e(m.context.branch)}</code>` : ''}</span>
<div class="top-actions">${exportsMenu}<button type="button" class="btn" id="print-btn">${icon('print')}Print or PDF</button><button type="button" class="btn" id="theme-toggle" aria-pressed="false">${icon('moon')}<span>Dark theme</span></button></div></div>
<nav class="sections" aria-label="Report sections"><a href="#summary">Summary</a><a href="#tests">Tests<span class="count">${e(k.total)}</span></a><a href="#failures">Failures<span class="count">${e(failing)}</span></a><a href="#comparison">Comparison</a><a href="#integrations">Integrations</a><a href="#context">Context</a><a href="#evidence">Evidence</a></nav></header>
<main id="main" tabindex="-1">
${health}
<section class="block" id="summary" aria-labelledby="summary-h"><div class="block-head"><h2 id="summary-h">Executive summary</h2><p>Run <code>${e(m.runId)}</code>${m.previous ? `, compared with the previous run <code>${e(m.previous.runId)}</code>` : ''}.</p></div>
${verdictCard(m)}${kpiTiles(m)}${summaryCharts(m)}</section>
${browsersBlock(m)}
${o.featuresHtml ?? m.featuresHtml ?? ''}
<section class="block" id="tests" aria-labelledby="tests-h"><div class="block-head"><h2 id="tests-h">Tests</h2><p>Filter, search and open any test. Shortcuts: <span class="kbd">/</span> search, <span class="kbd">&uarr;</span><span class="kbd">&darr;</span> move, <span class="kbd">Enter</span> open, <span class="kbd">Esc</span> close.</p></div>
<div class="explorer" id="explorer">
<div class="ex-side"><div class="ex-tools" role="search">
<div class="ex-search"><label for="q" class="sr-only">Search tests</label><input type="search" id="q" placeholder="Search name, id, tag, error, step, owner" autocomplete="off"></div>
<div class="filters" role="group" aria-label="Filter by state"><button type="button" class="fchip" data-state="all" aria-pressed="true">All <span class="num">${e(k.total)}</span></button>${TEST_STATES.map((s) => `<button type="button" class="fchip" data-state="${s}" aria-pressed="false"><span class="dot st-${s}" aria-hidden="true"></span>${e(STATE_LABEL[s])} <span class="num">${e(s === 'failed' ? k.failed : s === 'error' ? k.errors : s === 'passed' ? k.passed : s === 'healed' ? k.healed : s === 'flaky' ? k.flaky : k.skipped)}</span></button>`).join('')}</div>
<div class="ex-row2"><label>Group <select id="group"><option value="suite">Suite</option><option value="tag">Tag</option><option value="owner">Owner</option><option value="browser">Browser</option><option value="cluster">Failure cluster</option><option value="none">No grouping</option></select></label>
<label>Sort <select id="sort"><option value="default">Run order</option><option value="severity">Failures first</option><option value="duration">Slowest first</option><option value="name">Name</option><option value="risk">Risk</option></select></label>
<label>Tag <select id="f-tag"><option value="">Any</option></select></label><label>Owner <select id="f-owner"><option value="">Any</option></select></label><label>Browser <select id="f-browser"><option value="">Any</option></select></label></div>
</div>
<div class="ex-count" id="count" aria-live="polite"></div>
<div class="vlist" id="vlist" role="tree" aria-label="Tests" tabindex="0"><div class="vlist-inner" id="vinner"></div></div></div>
<div class="ex-detail" id="detail" tabindex="-1" aria-live="polite"><div class="empty"><div><p>Select a test to see its steps, evidence and failure details.</p><p class="small">Every test has a permalink: <code>#test/&lt;id&gt;</code></p></div></div></div>
</div>
<noscript><p>The interactive test list needs JavaScript. Failing tests are listed under Failure analysis.</p></noscript></section>
${failuresBlock(m)}
${comparisonBlock(m)}
${integrationsBlock(m)}
${contextBlock(m)}
${evidenceBlock(m)}
</main>
<footer class="foot"><span>${e(m.brand.name)} &middot; generated by EZTest ${e(m.context?.eztestVersion ?? '')} on ${e(fmtDate(m.generatedAt))}</span><span>Report model v${e(m.version)} &middot; <span class="kbd">?</span> keyboard shortcuts</span></footer>
<div class="tip" id="tip" role="tooltip" hidden></div>
<dialog class="lightbox" id="lightbox" aria-label="Screenshot viewer"><div class="lb-in"><div class="lb-bar"><span class="lb-cap" id="lb-cap"></span><button type="button" class="btn" id="lb-prev">Previous</button><button type="button" class="btn" id="lb-next">Next</button><button type="button" class="btn" id="lb-zoom" aria-pressed="false">Actual size</button><a class="btn" id="lb-open" href="#" target="_blank" rel="noopener">${icon('external')}Open</a><button type="button" class="btn" id="lb-close">${icon('close')}Close</button></div><img id="lb-img" alt=""></div></dialog>
<script type="application/json" id="ez-data">${scriptJson(clientData)}</script>
<script>${REPORT_SCRIPT}</script></body></html>`;
}

/** Build the model of a run and render it. */
export function renderHtmlReport(run: RunResult, opts: HtmlReportOptions = {}): string {
  if (!run || !Array.isArray(run.journeys)) throw new EzTestError('renderHtmlReport requires a RunResult', 'INVALID_INPUT');
  if (run.journeys.length === 0) throw new EzTestError('renderHtmlReport: run has no journeys', 'INVALID_INPUT');
  const extraHtml = [...(opts.extraHtml ?? []), ...(opts.apiCoverage ?? []).map(apiCoverageHtml)];
  const model = buildReportModel(run, { ...opts, extraHtml });
  const f = featuresBlock(run);
  if (f) model.featuresHtml = f;
  return renderReportModelHtml(model, { exports: opts.exports });
}
