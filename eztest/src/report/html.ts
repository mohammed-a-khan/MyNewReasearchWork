/**
 * The HTML run report: one self-contained file (no CDN, no external assets;
 * evidence is linked relative to the run directory) that works offline and
 * from file://, and scales to tens of thousands of tests.
 *
 * Information architecture (each fact in exactly one place):
 *
 * - Header (sticky): brand, report title, run meta (project / environment,
 *   date and time, duration, browsers) and the result counts as a status bar.
 * - Tabs (WAI-ARIA tablist, one panel visible, deep links `#overview`,
 *   `#tests`, `#tests/<id>`, `#failures`, `#failures/<group>`, `#trends`,
 *   `#quality`, `#environment`, `#policy`):
 *   Overview (outcome, results by feature / tag / browser, slowest tests, top
 *   failure reasons), Tests (the virtualised list and the test detail),
 *   Failures (grouped by cause, with the next step), Trends (history and the
 *   changes since the baseline run), Quality (lenses, coverage, API
 *   contracts), Environment (run, source, machine, browsers, filters,
 *   configuration, publishing, evidence) and, only when report.readiness is
 *   on, a secondary Policy tab with the readiness decision.
 *
 * Static parts are HTML and SVG (they read without script and print); the
 * explorer and the test detail are built by the inline script from the
 * embedded model (JSON in a non-executable script element, `<` escaped) with
 * DOM APIs and textContent only.
 */
import type { RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { apiCoverageHtml } from '../contracts/coverage.js';
import { escapeHtml as e } from './escape.js';
import { buildReportModel, STATE_LABEL, TEST_STATES, type ReportModel, type ReportModelInput, type TestModel, type TestState } from './data.js';
import { columnChart, fmtMs, fmtPct, lineChart, meter } from './charts.js';
import { icon, STATE_ICON } from './icons.js';
import { REPORT_CSS } from './styles.js';
import { REPORT_SCRIPT } from './client.js';
import type { ReportInsights } from './model.js';
import { bddHierarchy, type BddScenarioEntry } from './bdd.js';
import { qualityCards } from './html-insights.js';
import { CATEGORY_LABEL, FAILURE_CATEGORIES, type FailureCategory } from './categorise.js';
import { causeGroups, type CauseGroup } from './causes.js';
import { brandPalette, fontStack, isHidden, labelsOf, paletteCss, productName, type BrandLabels } from './brand.js';
import type { RunResult as Run } from '../core/index.js';

const STATUS_STATE: Record<string, TestState> = { passed: 'passed', 'passed-healed': 'healed', failed: 'failed', error: 'error', skipped: 'skipped', blocked: 'error' };
const sbadge = (s: string) => badge(STATUS_STATE[s] ?? 'skipped');
const MATCH_LABEL: Record<string, string> = { definition: 'step definition', ez: 'built-in phrasing', undefined: 'undefined', ambiguous: 'ambiguous' };

function bddScenario(sc: BddScenarioEntry): string {
  const steps = sc.steps.map((st) => `<li class="g-step">${sbadge(st.status)} <span class="g-kw">${e(st.keyword)}</span> ${e(st.text)}${st.match ? ` <small class="muted" title="${e(st.location ?? '')}">${e(MATCH_LABEL[st.match] ?? st.match)}${st.location ? ` &middot; ${e(st.location)}` : ''}</small>` : ''}${st.error ? `<div class="g-err">${e(st.error)}</div>` : ''}</li>`).join('');
  const hooks = sc.hookFailures.map((h) => `<li class="g-step">${sbadge('failed')} ${e(h)}</li>`).join('');
  return `<li class="g-scenario"><details${sc.status === 'failed' || sc.status === 'error' ? ' open' : ''}><summary>${sbadge(sc.status)} <span class="g-kw">${e(sc.keyword)}:</span> <a href="${testHref(sc.journeyId)}">${e(sc.name)}</a> <small class="muted">line ${e(sc.line)}${sc.examples ? ` &middot; ${e(sc.examples.name || 'Examples')} row ${e((sc.examples.row?.index ?? 0) + 1)}` : ''} &middot; ${e(fmtMs(sc.durationMs))}</small></summary><ol class="g-steps">${steps}${hooks}</ol></details></li>`;
}

/**
 * Feature / rule / scenario hierarchy of the run's Gherkin scenarios (docs/bdd.md), as static HTML.
 * The report itself groups the Tests list by feature; this block is kept for callers that embed it.
 */
export function featuresBlock(run: Run): string {
  const h = bddHierarchy(run);
  if (!h) return '';
  const features = h.features.map((f) => {
    const rules = f.rules.map((r) => `<li class="g-rule"><details open><summary>${sbadge(r.status)} <span class="g-kw">Rule:</span> ${e(r.name)} <small class="muted">line ${e(r.line)}</small></summary><ul class="g-scenarios">${r.scenarios.map(bddScenario).join('')}</ul></details></li>`).join('');
    return `<li class="g-feature"><details${f.status === 'failed' || f.status === 'error' ? ' open' : ''}><summary>${sbadge(f.status)} <strong>${e(f.name || f.file)}</strong> <small class="muted">${e(f.file)}</small></summary>
<ul class="g-scenarios">${f.scenarios.map(bddScenario).join('')}${rules}</ul></details></li>`;
  }).join('');
  return `<section class="block" id="features" aria-label="Features"><div class="card"><ul class="g-features">${features}</ul></div></section>`;
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

const testHref = (id: string) => `#tests/${encodeURIComponent(id)}`;
const badge = (s: TestState, label?: string) => `<span class="badge b-${s}">${icon(STATE_ICON[s])}${e(label ?? STATE_LABEL[s])}</span>`;
const catChip = (c: FailureCategory) => `<span class="cat c-${c}">${e(CATEGORY_LABEL[c])}</span>`;
const ext = (url: string | undefined, label: string, cls = '') => (url ? `<a class="${cls}" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)}<span class="sr-only"> (opens in a new tab)</span></a>` : `<span class="${cls}">${e(label)}</span>`);
const info = (about: string, text: string) => `<button type="button" class="info" data-tip="${e(text)}">${icon('info')}<span class="sr-only">About ${e(about)}: ${e(text)}</span></button>`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "25 Oct 2026, 18:49 UTC". */
export function fmtWhen(iso: string | undefined, seconds = false): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${seconds ? `:${p(d.getUTCSeconds())}` : ''} UTC`;
}
const shortDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isFail = (t: { state: TestState }) => t.state === 'failed' || t.state === 'error';
const ADO_TAG = /^@?(TestCaseId|TestPlanId|TestSuiteId)\b/i;

/** State counts of a list of tests. */
function countsOf(tests: TestModel[]): Record<TestState, number> {
  const c: Record<TestState, number> = { passed: 0, healed: 0, flaky: 0, failed: 0, error: 0, skipped: 0 };
  for (const t of tests) c[t.state]++;
  return c;
}
/** A proportional bar of state counts (decorative; the numbers are next to it). */
function stateBar(c: Record<TestState, number>, cls = 'hbar'): string {
  const total = TEST_STATES.reduce((n, s) => n + c[s], 0) || 1;
  return `<span class="${cls}" aria-hidden="true">${TEST_STATES.filter((s) => c[s]).map((s) => `<span class="st-${s}" style="width:${((c[s] / total) * 100).toFixed(2)}%"></span>`).join('')}</span>`;
}
const passRateOf = (c: Record<TestState, number>) => {
  const executed = c.passed + c.healed + c.flaky + c.failed + c.error;
  return executed ? (c.passed + c.healed + c.flaky) / executed : 0;
};

// ------------------------------------------------------------------ header

function header(m: ReportModel, L: BrandLabels, o: { exports?: Array<{ label: string; href: string }> }): string {
  const b = m.brand;
  const k = m.kpis;
  const p = m.previous?.kpis;
  const logo = b.logo
    ? `<img class="brand-logo light${b.logoDark ? ' has-dark' : ''}" src="${e(b.logo)}" alt="${e(b.company ?? b.name)}">${b.logoDark ? `<img class="brand-logo dark" src="${e(b.logoDark)}" alt="${e(b.company ?? b.name)}">` : ''}`
    : `<span class="brand-mark" aria-hidden="true">${b.mark ? `<img src="${e(b.mark)}" alt="">` : icon('logo')}</span>`;
  const env = m.context?.environment;
  const browsers = m.context?.browsers ?? [];
  const meta = [
    `<li>${icon('folder')}<span class="sr-only">Project: </span><b>${e(b.name)}</b>${env ? ` <span aria-hidden="true">/</span><span class="sr-only">, environment</span> <b>${e(env)}</b>` : ''}</li>`,
    `<li>${icon('calendar')}<span class="sr-only">Started: </span><time datetime="${e(m.startedAt)}">${e(fmtWhen(m.startedAt))}</time></li>`,
    `<li>${icon('clock')}<span class="sr-only">Duration: </span>${e(fmtMs(m.durationMs))}</li>`,
    browsers.length ? `<li>${icon('globe')}<span class="sr-only">Browsers: </span>${e(browsers.map((x) => `${x.name[0].toUpperCase()}${x.name.slice(1)}${x.version ? ` ${x.version.split('.')[0]}` : ''}`).join(', '))}</li>` : '',
  ].join('');
  const delta = (cur: number, prev: number | undefined, goodWhen: 'up' | 'down' | 'none') => {
    if (prev === undefined || cur === prev) return '';
    const d = cur - prev;
    const cls = goodWhen === 'none' ? '' : (d > 0) === (goodWhen === 'up') ? 'good' : 'bad';
    return `<span class="d ${cls}" title="Change since the previous run">${d > 0 ? '+' : '\u2212'}${Math.abs(d)}</span>`;
  };
  const tile = (state: TestState | 'all', n: number, label: string, d: string) =>
    `<li class="sb-tile"><a href="${state === 'all' ? '#tests' : `#tests?state=${state}`}" data-count="${state}">${state === 'all' ? '' : `<span class="dot st-${state}" aria-hidden="true"></span>`}<span class="v">${e(n)}</span> <span class="l">${e(label)}</span>${d}</a></li>`;
  const tiles = [
    tile('all', k.total, k.total === 1 ? L.test : L.tests, delta(k.total, p?.total, 'none')),
    tile('passed', k.passed, 'passed', delta(k.passed, p?.passed, 'up')),
    tile('failed', k.failed, 'failed', delta(k.failed, p?.failed, 'down')),
    ...(k.errors ? [tile('error', k.errors, k.errors === 1 ? 'error' : 'errors', delta(k.errors, p?.errors, 'down'))] : []),
    tile('flaky', k.flaky, 'flaky', delta(k.flaky, p?.flaky, 'down')),
    ...(k.healed ? [tile('healed', k.healed, 'healed', delta(k.healed, p?.healed, 'down'))] : []),
    tile('skipped', k.skipped, 'skipped', delta(k.skipped, p?.skipped, 'none')),
  ].join('');
  const counts: Record<TestState, number> = { passed: k.passed, healed: k.healed, flaky: k.flaky, failed: k.failed, error: k.errors, skipped: k.skipped };
  const exportsMenu = o.exports?.length
    ? `<div class="menu"><button type="button" class="btn" id="exports-btn" aria-haspopup="true" aria-expanded="false" aria-controls="exports-list">${icon('download')}<span>Export</span></button><ul class="menu-list" id="exports-list" hidden>${o.exports.map((x) => `<li><a href="${e(x.href)}" download>${icon('download')}${e(x.label)}</a></li>`).join('')}</ul></div>`
    : '';
  return `<header class="topbar" id="top"><div class="head-in">
<div class="head-top"><div class="brand">${logo}<div class="brand-text">${b.company ? `<div class="brand-eyebrow">${e(b.company)}</div>` : ''}<h1 class="brand-title">${e(m.title)}${b.subtitle ? ` <span class="brand-sub">&mdash; ${e(b.subtitle)}</span>` : ''}</h1></div></div>
<div class="top-actions">${exportsMenu}<button type="button" class="btn" id="print-btn">${icon('print')}<span>Print</span></button><button type="button" class="btn" id="theme-toggle" aria-pressed="false">${icon('moon')}<span>Dark theme</span></button></div></div>
<ul class="run-meta" aria-label="Run">${meta}</ul>
<div class="statusbar" role="group" aria-label="Results">${stateBar(counts, 'sb-bar')}<ul class="sb-tiles">${tiles}</ul></div>
<div class="tabs" role="tablist" aria-label="Report sections" id="tablist">__TABS__</div>
</div></header>`;
}

interface TabDef {
  id: string;
  label: string;
  ico: string;
  body: string;
  secondary?: boolean;
  alert?: boolean;
}

function tabsHtml(tabs: TabDef[]): string {
  return tabs.map((t, i) => `<button type="button" role="tab" class="tab${t.secondary ? ' secondary' : ''}" id="tab-${t.id}" aria-controls="p-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${t.id}">${icon(t.ico)}${e(t.label)}${t.alert ? '<span class="alert" aria-hidden="true"></span>' : ''}</button>`).join('');
}

// ------------------------------------------------------------------ overview

function emptyState(title: string, text: string, ok = true): string {
  return `<div class="empty-state"><span class="halo${ok ? '' : ' n'}">${icon(ok ? 'check' : 'minus')}</span><strong>${e(title)}</strong><span>${e(text)}</span></div>`;
}

/** The outcome donut: pass rate in the centre, the share of each result in the legend (the counts are in the header). */
export function outcomeDonut(m: ReportModel): string {
  const k = m.kpis;
  const counts: Record<TestState, number> = { passed: k.passed, healed: k.healed, flaky: k.flaky, failed: k.failed, error: k.errors, skipped: k.skipped };
  const total = k.total || 1;
  const size = 168;
  const r = 74;
  const inner = 54;
  const c = size / 2;
  let a0 = -Math.PI / 2;
  const shown = TEST_STATES.filter((s) => counts[s]);
  const gap = shown.length > 1 ? 0.025 : 0;
  const pt = (rad: number, ang: number) => `${(c + rad * Math.cos(ang)).toFixed(2)},${(c + rad * Math.sin(ang)).toFixed(2)}`;
  const arcs = shown.map((s) => {
    const frac = counts[s] / total;
    const a1 = a0 + frac * Math.PI * 2;
    const st = a0 + gap / 2;
    const en = Math.max(st + 0.0001, a1 - gap / 2);
    a0 = a1;
    if (frac >= 0.9999) return `<path class="mark st-${s}" fill-rule="evenodd" d="M${c - r},${c}A${r},${r} 0 1 1 ${c + r},${c}A${r},${r} 0 1 1 ${c - r},${c}ZM${c - inner},${c}A${inner},${inner} 0 1 0 ${c + inner},${c}A${inner},${inner} 0 1 0 ${c - inner},${c}Z"/>`;
    const large = en - st > Math.PI ? 1 : 0;
    return `<path class="mark st-${s}" d="M${pt(r, st)}A${r},${r} 0 ${large} 1 ${pt(r, en)}L${pt(inner, en)}A${inner},${inner} 0 ${large} 0 ${pt(inner, st)}Z"/>`;
  }).join('');
  const desc = shown.map((s) => `${STATE_LABEL[s]} ${fmtPct(counts[s] / total)}`).join(', ');
  const legend = `<ul class="legend">${shown.map((s) => `<li><span class="key st-${s}" aria-hidden="true"></span><span class="lk">${e(STATE_LABEL[s])}</span><span class="lp">${e(fmtPct(counts[s] / total))}</span></li>`).join('')}</ul>`;
  return `<div class="outcome"><svg class="viz" viewBox="0 0 ${size} ${size}" role="img" aria-labelledby="donut-t"><title id="donut-t">Pass rate ${e(fmtPct(k.passRate))}. Share of tests: ${e(desc)}.</title><circle cx="${c}" cy="${c}" r="${(r + inner) / 2}" fill="none" class="track" stroke-width="${r - inner}"/>${arcs}<text x="${c}" y="${c + 2}" text-anchor="middle" class="viz-hero">${e(fmtPct(k.passRate, k.passRate === 1 || k.passRate === 0 ? 0 : 1))}</text><text x="${c}" y="${c + 22}" text-anchor="middle" class="viz-muted">pass rate</text></svg>${legend}</div>`;
}

/** The first column's heading from the section's label: "Results by module" -> "Module" (a brand's own words). */
function colOf(section: string, fallback: string): string {
  const m = /^results\s+by\s+(.+)$/i.exec(section.trim());
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : fallback;
}

function breakdownTable(rows: Array<{ label: string; tests: TestModel[]; href?: string }>, caption: string, first: string, more: number, noun = 'Tests', tab = 'Tests'): string {
  if (!rows.length) return '';
  const body = rows.map((r) => {
    const c = countsOf(r.tests);
    const failing = c.failed + c.error;
    return `<tr><th scope="row">${r.href ? `<a href="${e(r.href)}">${e(r.label)}</a>` : e(r.label)}</th><td class="num">${e(r.tests.length)}</td><td class="num${failing ? ' ink-failed' : ''}">${e(failing)}</td><td class="bar-cell bar-col">${stateBar(c)}</td><td class="num rate">${e(fmtPct(passRateOf(c), 0))}</td></tr>`;
  }).join('');
  return `<div class="tbl-wrap"><table><caption class="sr-only">${e(caption)}</caption><thead><tr><th scope="col">${e(first)}</th><th scope="col" class="num">${e(noun)}</th><th scope="col" class="num">Failing</th><th scope="col" class="bar-col"><span class="sr-only">Outcome</span></th><th scope="col" class="num">Pass rate</th></tr></thead><tbody>${body}</tbody></table></div>${more > 0 ? `<p class="small muted" style="margin:8px 0 0">${e(more)} more in the ${e(tab)} tab.</p>` : ''}`;
}

function overviewPanel(m: ReportModel, L: BrandLabels, groups: CauseGroup[]): string {
  const health = m.health
    ? `<div class="banner" role="note">${icon('alert')}<div>${m.health.preflight && !m.health.preflight.ok ? `<strong>Environment unavailable:</strong> ${e(m.health.preflight.failed.join('; '))} (nothing ran). ` : ''}${m.health.circuit ? `<strong>Circuit breaker opened</strong> after ${e(m.health.circuit.afterJourney)}: ${e(m.health.circuit.notRun)} test(s) not run (${e(m.health.circuit.reason)}).` : ''}</div></div>`
    : '';
  const bySuite = new Map<string, TestModel[]>();
  for (const t of m.tests) {
    const key = t.suite[0] ?? 'Ungrouped';
    bySuite.set(key, [...(bySuite.get(key) ?? []), t]);
  }
  const suites = [...bySuite.entries()].sort((a, b) => countsOf(b[1]).failed + countsOf(b[1]).error - (countsOf(a[1]).failed + countsOf(a[1]).error) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const byTag = new Map<string, TestModel[]>();
  for (const t of m.tests) for (const g of t.tags) if (!ADO_TAG.test(g)) byTag.set(g, [...(byTag.get(g) ?? []), t]);
  const tags = [...byTag.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const fail = groups.filter((g) => g.kind === 'failure');
  const reasons = groups.slice(0, 6).map((g) => `<div class="reason"><span class="cnt" title="${e(plural(g.tests.length, L.test, L.tests))}">${e(g.tests.length)}</span><a href="#failures/${e(g.id)}"><div class="msg" title="${e(g.message)}">${e(g.message)}</div></a>${catChip(g.cat)}</div>`).join('');
  const slow = m.slowest.slice(0, 6);
  const maxSlow = Math.max(1, ...slow.map((s) => s.durationMs));
  const slowList = slow.length
    ? `<ul class="list">${slow.map((s) => `<li><span class="sicon si-${s.state}" title="${e(STATE_LABEL[s.state])}">${icon(STATE_ICON[s.state])}</span><a class="grow" href="${testHref(s.id)}" title="${e(s.name)}">${e(s.name)}</a><span class="hbar" style="width:90px" aria-hidden="true"><span class="st-skipped" style="width:${((s.durationMs / maxSlow) * 100).toFixed(1)}%;background:var(--series-1)"></span></span><span class="n">${e(fmtMs(s.durationMs))}</span></li>`).join('')}</ul>`
    : emptyState('Nothing executed', 'Every test was skipped.', false);
  const b = m.browsers;
  const browserCard = b
    ? `<section class="card span-6" aria-labelledby="ov-browser"><div class="card-h"><h3 id="ov-browser">${e(L.sections.byBrowser)}</h3></div>${breakdownTable(b.names.map((n) => ({ label: `${n}${b.perBrowser[n].version ? ` ${b.perBrowser[n].version!.split('.')[0]}` : ''}`, tests: m.tests.filter((t) => t.browser === n) })), L.sections.byBrowser, colOf(L.sections.byBrowser, 'Browser'), 0, cap(L.tests), L.tabs.tests)}</section>`
    : '';
  return `${health}<div class="grid">
<section class="card span-4" aria-labelledby="ov-outcome"><div class="card-h"><h3 id="ov-outcome">${e(L.sections.outcome)}</h3>${info('the pass rate', 'Passed tests (healed and flaky included) out of the tests that ran; skipped tests are not counted.')}</div>${outcomeDonut(m)}</section>
<section class="card span-8" aria-labelledby="ov-reasons"><div class="card-h"><h3 id="ov-reasons" class="grow">${e(L.sections.topFailures)}</h3>${groups.length && !isHidden(m.brand, 'failures') ? `<a class="btn quiet" href="#failures">All causes</a>` : ''}</div>${fail.length || groups.length ? `<div>${reasons}</div>` : emptyState('No failures', `Every ${L.test} that ran passed.`)}</section>
<section class="card span-6" aria-labelledby="ov-feature"><div class="card-h"><h3 id="ov-feature">${e(L.sections.byFeature)}</h3>${info('features', 'The first level of the suite: the feature of a Gherkin scenario, else the folder or file of the journey.')}</div>${breakdownTable(suites.slice(0, 10).map(([label, tests]) => ({ label, tests })), L.sections.byFeature, colOf(L.sections.byFeature, 'Feature'), suites.length - 10, cap(L.tests), L.tabs.tests)}</section>
<section class="card span-6" aria-labelledby="ov-tag"><div class="card-h"><h3 id="ov-tag">${e(L.sections.byTag)}</h3></div>${tags.length ? breakdownTable(tags.slice(0, 10).map(([label, tests]) => ({ label, tests })), L.sections.byTag, colOf(L.sections.byTag, 'Tag'), tags.length - 10, cap(L.tests), L.tabs.tests) : emptyState('No tags', 'Tag journeys (Tags: @smoke) to see results per tag.', false)}</section>
<section class="card span-6" aria-labelledby="ov-slow"><div class="card-h"><h3 id="ov-slow">${e(L.sections.slowest)}</h3></div>${slowList}</section>
${browserCard}
</div>`;
}

// ------------------------------------------------------------------ tests

function testsPanel(m: ReportModel, L: BrandLabels): string {
  const present = TEST_STATES.filter((s) => m.tests.some((t) => t.state === s));
  return `<div class="explorer" id="explorer">
<div class="ex-side"><div class="ex-tools" role="search" aria-label="Find ${e(L.tests)}">
<div class="search">${icon('search')}<label for="q" class="sr-only">Search ${e(L.tests)}</label><input type="search" id="q" placeholder="Search name, tag, error, step" autocomplete="off"></div>
<div class="filters" role="group" aria-label="Filter by result"><button type="button" class="fchip" data-state="all" aria-pressed="true">All</button>${present.map((s) => `<button type="button" class="fchip" data-state="${s}" aria-pressed="false"><span class="dot st-${s}" aria-hidden="true"></span>${e(STATE_LABEL[s])}</button>`).join('')}</div>
<div class="ex-row2"><label>Group<select id="group"><option value="suite">Feature</option><option value="file">File</option><option value="tag">Tag</option><option value="browser">Browser</option><option value="owner">Owner</option><option value="category">Failure category</option><option value="none">No grouping</option></select></label>
<label>Sort<select id="sort"><option value="default">Run order</option><option value="severity">Failures first</option><option value="duration">Slowest first</option><option value="name">Name</option></select></label>
<label>Tag<select id="f-tag"><option value="">Any</option></select></label></div>
<details class="more" id="more-filters"><summary>More filters</summary><div class="ex-row2" style="margin-top:6px"><label>Owner<select id="f-owner"><option value="">Any</option></select></label><label>Browser<select id="f-browser"><option value="">Any</option></select></label><label>Category<select id="f-cat"><option value="">Any</option></select></label></div></details>
</div>
<div class="ex-count" id="count" aria-live="polite"></div>
<div class="vlist" id="vlist" role="tree" aria-label="${e(L.tests[0].toUpperCase() + L.tests.slice(1))}" tabindex="0"><div class="vlist-inner" id="vinner"></div></div></div>
<div class="ex-detail" id="detail" role="region" tabindex="-1" aria-label="${e(L.test[0].toUpperCase() + L.test.slice(1))} details"><div class="d-empty"><div>${icon('list')}<p>Select a ${e(L.test)} to see its steps, logs and evidence.</p><p class="small">Shortcuts: <span class="kbd">/</span> search &middot; <span class="kbd">&uarr;</span> <span class="kbd">&darr;</span> move &middot; <span class="kbd">Enter</span> open &middot; <span class="kbd">Esc</span> close</p></div></div></div>
</div>
<noscript><p>The interactive list needs JavaScript; the Failures tab lists every failing ${e(L.test)}.</p></noscript>
<div class="print-only" id="print-tests"></div>`;
}

// ------------------------------------------------------------------ failures

function failuresPanel(m: ReportModel, L: BrandLabels, groups: CauseGroup[]): string {
  const byCat = new Map<FailureCategory, CauseGroup[]>();
  for (const g of groups) byCat.set(g.cat, [...(byCat.get(g.cat) ?? []), g]);
  const order: FailureCategory[] = [...FAILURE_CATEGORIES.filter((c) => c !== 'flaky'), 'flaky'];
  const sections = order.filter((c) => byCat.has(c)).map((c) => {
    const list = byCat.get(c)!;
    const n = list.reduce((x, g) => x + g.tests.length, 0);
    // One next step for the whole category when every cause in it has the same one.
    const shared = list.length > 1 && list.every((g) => g.fix && g.fix === list[0].fix) ? list[0].fix : undefined;
    const cards = list.map((g) => {
      const first = g.tests[0];
      const tests = g.tests.slice(0, 50).map((t) => `<li><span class="sicon si-${t.state}" title="${e(STATE_LABEL[t.state])}">${icon(STATE_ICON[t.state])}</span><a href="${testHref(t.id)}" title="${e(t.name)}">${e(t.name)}</a>${t.failedStep ? `<span class="where" title="${e(t.failedStep)}">${e(t.failedStep)}</span>` : ''}</li>`).join('');
      return `<article class="cause-card${g.kind === 'flaky' ? ' flaky' : ''}" id="failures/${e(g.id)}" tabindex="-1" aria-labelledby="g-${e(g.id)}">
<div class="group-h"><div class="grow"><p class="group-msg" id="g-${e(g.id)}">${e(g.message)}</p><div class="group-meta">${g.kind === 'failure' ? (g.known ? `<span>Seen before${g.firstSeenAt ? ` &middot; first on ${e(shortDay(g.firstSeenAt))}` : ''}</span>` : '<span class="cat c-new">new</span>') : ''}${first.signature ? `<span class="mono" title="Error signature">${e(first.signature.slice(0, 10))}</span>` : ''}<button type="button" class="btn quiet no-print" data-copy-bug="${e(first.id)}" style="min-height:26px;padding:2px 8px">${icon('copy')}Copy for bug</button></div></div><div class="group-n">${e(g.tests.length)}<small>${e(g.tests.length === 1 ? L.test : L.tests)}</small></div></div>
${g.fix && !shared ? `<div class="next">${icon('bulb')}<div><strong>Next step:</strong> ${e(g.fix)}</div></div>` : ''}
<ul class="group-tests">${tests}${g.tests.length > 50 ? `<li class="muted">${e(g.tests.length - 50)} more: filter the Tests tab by this category.</li>` : ''}</ul></article>`;
    }).join('');
    return `<section class="cat-sec" aria-labelledby="cat-${c}"><h3 id="cat-${c}">${catChip(c)} <span class="muted small" style="font-weight:500">${e(plural(n, L.test, L.tests))} &middot; ${e(plural(list.length, 'cause', 'causes'))}</span></h3>${shared ? `<div class="next cat-next">${icon('bulb')}<div><strong>Next step:</strong> ${e(shared)}</div></div>` : ''}${cards}</section>`;
  }).join('');
  return `<div class="panel-head"><p>Failing and flaky ${e(L.tests)} grouped by cause: similar errors form one group, each with the suggested next step. ${info('the categories', 'Product defect, test issue, environment, test data, flaky or needs review: decided by the triage when it is confident, otherwise by rules on the error text.')}</p></div>${sections}`;
}

// ------------------------------------------------------------------ trends

function trendsPanel(m: ReportModel, L: BrandLabels): string {
  const t = m.trend;
  const parts: string[] = [];
  // Runs of one day are labelled by their time.
  const oneDay = new Set(t.map((x) => x.startedAt.slice(0, 10))).size === 1;
  const lbl = (iso: string) => (oneDay ? iso.slice(11, 16) : shortDay(iso));
  if (t.length >= 2) {
    const pts = t.map((x) => ({ label: lbl(x.startedAt), value: x.passRate, detail: `${fmtWhen(x.startedAt)}, ${x.total} ${L.tests}, ${x.failed} failing`, current: x.current }));
    parts.push(`<section class="card span-12" aria-labelledby="tr-pass"><div class="card-h"><h3 id="tr-pass">Pass rate</h3><span class="muted small">last ${e(t.length)} runs</span></div>${lineChart(pts, { title: `Pass rate, last ${t.length} runs`, yMax: 1, yFormat: (v) => fmtPct(v, 0), series: 'series-1', area: true, width: 1000, height: 220 })}</section>`);
    parts.push(`<section class="card span-6" aria-labelledby="tr-dur"><div class="card-h"><h3 id="tr-dur">Duration</h3></div>${columnChart(t.map((x) => ({ label: lbl(x.startedAt), value: x.durationMs, tip: `${fmtWhen(x.startedAt)}: ${fmtMs(x.durationMs)}${x.current ? ' (this run)' : ''}`, cls: x.current ? 'series-1' : 'muted' })), { title: `Run duration, last ${t.length} runs`, yLabel: 'run', yFormat: fmtMs, width: 560, height: 220 })}</section>`);
    parts.push(`<section class="card span-6" aria-labelledby="tr-flaky"><div class="card-h"><h3 id="tr-flaky">Flaky ${e(L.tests)}</h3>${info('flaky', 'Tests that failed first and passed on a retry, per run.')}</div>${columnChart(t.map((x) => ({ label: lbl(x.startedAt), value: x.flaky ?? 0, tip: `${fmtWhen(x.startedAt)}: ${x.flaky ?? 0} flaky${x.current ? ' (this run)' : ''}`, cls: x.current ? 'series-2' : 'muted' })), { title: `Flaky tests, last ${t.length} runs`, yLabel: 'run', yFormat: (v) => String(Math.round(v)), width: 560, height: 220 })}</section>`);
  }
  const c = m.comparison;
  if (c) {
    const list = (title: string, items: Array<{ id: string; name: string }>, extra: (x: never) => string = () => '') =>
      items.length ? `<div><h4 style="margin:0 0 6px">${e(title)} <span class="cnt">${e(items.length)}</span></h4><ul class="list">${items.slice(0, 50).map((x) => `<li><a class="grow" href="${testHref(x.id)}">${e(x.name)}</a>${extra(x as never)}</li>`).join('')}</ul></div>` : '';
    const blocks = [
      list('Newly failing', c.newlyFailing, (x: { before: string }) => `<span class="muted small">was ${e(x.before)}</span>`),
      list('Fixed', c.fixed),
      list('Slower', c.slower, (x: { beforeMs: number; afterMs: number }) => `<span class="muted small">${e(fmtMs(x.beforeMs))} &rarr; ${e(fmtMs(x.afterMs))}</span>`),
      list(`New ${L.tests}`, c.added),
      c.removed.length ? `<div><h4 style="margin:0 0 6px">Removed <span class="cnt">${e(c.removed.length)}</span></h4><ul class="list">${c.removed.slice(0, 50).map((x) => `<li><span class="grow">${e(x.name)}</span></li>`).join('')}</ul></div>` : '',
    ].filter(Boolean);
    parts.push(`<section class="card span-12" aria-labelledby="tr-cmp"><div class="card-h"><h3 id="tr-cmp">Changes since ${e(fmtWhen(c.baselineStartedAt))}</h3>${info('the baseline', `Compared with run ${c.baselineRunId} (report.baseline).`)}</div>${blocks.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${blocks.join('')}</div>` : emptyState('No changes', `Every ${L.test} has the same outcome as in the baseline run.`, false)}</section>`);
  }
  return `<div class="grid">${parts.join('')}</div>`;
}

// ------------------------------------------------------------------ quality

function qualityPanel(m: ReportModel): string {
  const cov = m.coverage;
  const meters = [
    cov.requirements ? meter(cov.requirements.ratio, { label: 'Requirements passing', detail: `${cov.requirements.passing} of ${cov.requirements.total}; ${cov.requirements.failing} failing, ${cov.requirements.notRun} not run, ${cov.requirements.uncovered} without tests` }) : '',
    cov.risk ? meter(cov.risk.ratio, { label: 'Risk-weighted coverage', detail: `${cov.risk.covered} of ${cov.risk.total} risk points passed` }) : '',
    ...(cov.api ?? []).map((a) => meter(a.ratio, { label: `API coverage: ${a.title}`, detail: `${a.covered} of ${a.operations} operations; status codes ${fmtPct(a.statusRatio, 0)}; ${a.violations} contract violation(s)` })),
    cov.ui ? meter(cov.ui.percent, { label: 'UI coverage', detail: `${cov.ui.tested} of ${cov.ui.elements} elements on ${cov.ui.pages} page(s)` }) : '',
  ].filter(Boolean).join('');
  const req = cov.requirements?.items.length
    ? `<div class="tbl-wrap" style="margin-top:8px"><table><caption class="sr-only">Requirements</caption><thead><tr><th scope="col">Requirement</th><th scope="col">State</th><th scope="col">Tests</th></tr></thead><tbody>${cov.requirements.items.slice(0, 300).map((r) => `<tr><th scope="row">${ext(r.url, r.id)}${r.title ? `<div class="small muted">${e(r.title)}</div>` : ''}</th><td>${badge(r.state === 'passing' ? 'passed' : r.state === 'failing' ? 'failed' : 'skipped', r.state)}</td><td>${r.tests.slice(0, 6).map((t) => `<a class="chip" href="${testHref(t)}">${e(t)}</a>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  const parts = [
    meters ? `<section class="card span-12" aria-labelledby="q-cov"><div class="card-h"><h3 id="q-cov">Coverage</h3></div>${meters}${req}</section>` : '',
    qualityCards(m),
    ...(m.extraHtml ?? []).map((h) => `<section class="card span-12">${h}</section>`),
  ].filter(Boolean);
  return `<div class="grid">${parts.join('')}</div>`;
}

export function hasQuality(m: ReportModel): boolean {
  const c = m.coverage;
  return !!(m.lenses || m.extraHtml?.length || c.requirements || c.risk || c.api?.length || c.ui);
}

// ------------------------------------------------------------------ environment

function statusBadge(s: string | undefined, ok?: boolean): string {
  if (!s) return '';
  const cls = s === 'success' || ok === true ? 'b-passed' : s === 'partial' ? 'b-flaky' : s === 'failed' || ok === false ? 'b-failed' : 'b-neutral';
  return `<span class="badge status ${cls}">${e(s)}</span>`;
}

const FILTER_KEY = /^(tags|grep|grepInvert|only|onlyFailed|risk|changedSince|journeys|shard|project)$/;

function environmentPanel(m: ReportModel): string {
  const c = m.context;
  const dl = (rows: Array<[string, string | undefined]>) => {
    const r = rows.filter(([, v]) => v !== undefined && v !== '');
    return r.length ? `<dl class="kv">${r.map(([k, v]) => `<dt>${e(k)}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
  };
  const sect = (id: string, title: string, body: string, o: { open?: boolean; hint?: string } = {}) =>
    body ? `<details class="sect" id="env-${id}"${o.open === false ? '' : ' open'}><summary>${icon('chevron').replace('<svg ', '<svg class="chev" ')}<span>${e(title)}</span>${o.hint ? `<span class="hint">${e(o.hint)}</span>` : ''}</summary><div class="sect-b">${body}</div></details>` : '';
  const run = dl([
    ['Run id', `<code>${e(m.runId)}</code>`],
    ['Started', e(fmtWhen(m.startedAt, true))],
    ['Finished', e(fmtWhen(m.finishedAt, true))],
    ['Time zone', c ? e(c.timeZone) : undefined],
    ['Trigger', c?.trigger ? e(c.trigger) : undefined],
    ['Run by', c?.user ? e(c.user) : undefined],
    ['Shard', c?.shard ? `${e(c.shard.index)} of ${e(c.shard.total)}` : undefined],
    ['Workers', c?.workers ? e(c.workers) : undefined],
  ]);
  const target = dl([
    ['Environment', c?.environment ? e(c.environment) : undefined],
    ['Base URL', c?.baseUrl ? `<code>${e(c.baseUrl)}</code>` : undefined],
    ['Devices', c?.devices.length ? e(c.devices.join(', ')) : undefined],
  ]);
  const browsers = c?.browsers.length ? `<div class="tbl-wrap"><table><caption class="sr-only">Browsers</caption><thead><tr><th scope="col">Browser</th><th scope="col">Version</th></tr></thead><tbody>${c.browsers.map((b) => `<tr><th scope="row">${e(b.name)}</th><td class="mono">${e(b.version ?? '-')}</td></tr>`).join('')}</tbody></table></div>` : '';
  const git = m.integrations.git;
  const owners = [...new Set(m.tests.filter(isFail).flatMap((t) => t.owners))];
  const source = dl([
    ['CI', c?.build ? e(c.build.system) : 'local run'],
    ['Pipeline', c?.build?.pipeline ? e(c.build.pipeline) : undefined],
    ['Build', c?.build ? ext(c.build.url, c.build.number ?? c.build.id ?? 'build') : undefined],
    ['Release', c?.release ? ext(c.release.url, `${c.release.name ?? ''}${c.release.environment ? ` (${c.release.environment})` : ''}`) : undefined],
    ['Repository', git?.repository ? ext(git.repositoryUrl, git.repository) : undefined],
    ['Branch', c?.branch ? `<code>${e(c.branch)}</code>${c.targetBranch ? ` &rarr; <code>${e(c.targetBranch)}</code>` : ''}` : undefined],
    ['Commit', c?.commit ? `${ext(c.commit.url, c.commit.sha.slice(0, 12), 'mono')}${c.commit.author ? ` by ${e(c.commit.author)}` : ''}` : undefined],
    ['Pull request', c?.pullRequest ? ext(c.pullRequest.url, `#${c.pullRequest.number}`) : undefined],
    ['Owners of failing tests', owners.length ? e(owners.join(', ')) : undefined],
  ]);
  const machine = dl([
    ['Machine', c ? e([c.machine.host, c.machine.os].filter(Boolean).join(' \u00b7 ')) : undefined],
    ['CPUs', c?.machine.cpus ? e(c.machine.cpus) : undefined],
    ['Memory', c?.machine.memoryGb ? `${e(c.machine.memoryGb)} GB` : undefined],
    ['Node.js', c ? e(c.node) : undefined],
    [m.brand.whiteLabel ? 'Engine version' : 'EZTest version', c ? e(c.eztestVersion) : undefined],
  ]);
  const filters = (m.config ?? []).filter(([k]) => FILTER_KEY.test(k));
  const filtersBody = filters.length ? dl(filters.map(([k, v]) => [k, `<code>${e(v)}</code>`])) : '<p class="muted small" style="margin:0">No filters: every journey in scope ran.</p>';
  const cfg = m.config?.length
    ? `<div class="cfg-filter no-print"><label class="sr-only" for="cfg-q">Filter settings</label><input type="search" id="cfg-q" placeholder="Filter settings (key or value)" autocomplete="off"><span id="cfg-count" class="small muted" aria-live="polite"></span></div><div class="tbl-wrap"><table class="cfg" id="cfg-table"><caption class="sr-only">Effective configuration, secrets masked</caption><thead><tr><th scope="col">Setting</th><th scope="col">Value</th></tr></thead><tbody>${m.config.map(([k, v]) => `<tr><td>${e(k)}</td><td>${e(v)}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  const i = m.integrations;
  const pub: string[] = [];
  const ado = i.ado;
  const adoExtra = ado ? [
    ['Pipeline build', ado.build ? ext(ado.build.url, ado.build.number ?? ado.build.id ?? 'build') : undefined],
    ['Release', ado.release ? ext(ado.release.url, `${ado.release.name ?? 'release'}${ado.release.environment ? ` (${ado.release.environment})` : ''}`) : undefined],
    ['Project', ado.project ? `${ext(ado.collectionUrl, ado.collectionUrl ?? '')} &middot; ${e(ado.project)}` : undefined],
  ] as Array<[string, string | undefined]> : [];
  if (ado?.publish) {
    const p = ado.publish;
    pub.push(`<div class="box"><div class="box-h">Azure DevOps ${statusBadge(p.status)}</div>${dl([
      ['Test run', p.runId ? ext(p.runUrl, `Run ${p.runId}${p.runName ? ` - ${p.runName}` : ''}`) : undefined],
      ['Results', `${e(p.results.length)} published${p.unmapped.length ? `, ${e(p.unmapped.length)} test(s) without @TestCaseId` : ''}${p.missingPoints.length ? `, ${e(p.missingPoints.length)} without a test point` : ''}`],
      ['Plan / suite', p.planId ? `${e(p.planId)}${p.suiteId ? ` / ${e(p.suiteId)}` : ''}` : undefined],
      ['Attachments', e(p.attachments)],
      ['When', e(fmtWhen(p.at))],
      ['Why', p.reason ? e(p.reason) : undefined],
      ['Bugs', ado.bugs.length ? ado.bugs.map((b) => `${ext(b.url, `Bug ${b.id}`)} <span class="muted">(${e(b.action)})</span>`).join(', ') : undefined],
      ['Requirements commented', ado.requirementsCommented.length ? ado.requirementsCommented.map((r) => ext(r.url, `#${r.requirement}`)).join(', ') : undefined],
      ...adoExtra,
    ])}${p.warnings.length ? `<details><summary>${e(p.warnings.length)} warning(s)</summary><ul class="small">${p.warnings.map((w) => `<li>${e(w)}</li>`).join('')}</ul></details>` : ''}</div>`);
  } else if (ado && (ado.bugs.length || ado.build || ado.release)) pub.push(`<div class="box"><div class="box-h">Azure DevOps <span class="badge status b-neutral">not published</span></div>${dl([['Bugs', ado.bugs.length ? ado.bugs.map((b) => ext(b.url, `Bug ${b.id}`)).join(', ') : undefined], ...adoExtra])}</div>`);
  const pr = i.pullRequest;
  if (pr) pub.push(`<div class="box"><div class="box-h">Pull request ${pr.comment ? statusBadge('posted', true) : ''}</div>${dl([['Pull request', `${ext(pr.url, `#${pr.number}`)} <span class="muted">(${e(pr.provider)})</span>`], ['Comment', pr.comment ? e(pr.comment.action) : undefined], ['Status', pr.status ? `${e(pr.status.kind)}${pr.status.state ? ` ${e(pr.status.state)}` : ''}, ${e(pr.status.annotations)} annotation(s)` : undefined]])}</div>`);
  if (i.jira) pub.push(`<div class="box"><div class="box-h">Jira ${statusBadge(i.jira.status)}</div>${i.jira.bugs.length ? `<ul class="list">${i.jira.bugs.map((b) => `<li>${ext(b.url, b.key)} <span class="muted small">${e(b.action)} for ${e(b.journeyId)}</span></li>`).join('')}</ul>` : `<p class="small muted" style="margin:0">No bugs filed${i.jira.reason ? `: ${e(i.jira.reason)}` : ''}.</p>`}</div>`);
  if (i.notifications.length) pub.push(`<div class="box"><div class="box-h">Notifications</div><ul class="list">${i.notifications.map((n) => `<li><strong>${e(n.channel)}</strong> ${statusBadge(n.ok ? 'sent' : 'failed', n.ok)} <span class="small grow">${e(n.message)}</span></li>`).join('')}</ul></div>`);
  const rs = i.resultsServer;
  if (rs) pub.push(`<div class="box"><div class="box-h">Results server ${statusBadge(rs.verified === false ? 'not verified' : 'published', rs.verified !== false)}</div><p class="small" style="margin:0">${ext(rs.url, 'Open this run on the results server')} <span class="muted">${e(fmtWhen(rs.at))}</span></p></div>`);
  if (i.publishers.length) pub.push(`<div class="box"><div class="box-h">Other publishers</div><ul class="list">${i.publishers.map((p) => `<li><strong>${e(p.name)}</strong> ${statusBadge(p.skipped ? 'skipped' : p.ok ? 'ok' : 'failed', p.skipped ? undefined : p.ok)} <span class="small grow">${e(p.message)}</span></li>`).join('')}</ul></div>`);
  const evCount = Object.keys(m.evidence).length;
  const evidence = evCount || m.evidenceHead
    ? `${dl([['Files', e(evCount)], ['Chain head', m.evidenceHead ? `<code title="${e(m.evidenceHead)}">${e(m.evidenceHead.slice(0, 16))}</code>` : undefined]])}<p class="small muted">Every file is hash-chained in the run's evidence manifest (verify with <code>eztest evidence verify</code>). Each test's own files are in its detail.</p>${evCount ? '<div id="ev-browser" class="no-print"><button type="button" class="btn" id="ev-load">Browse all evidence</button></div>' : ''}`
    : '';
  const extra = c && Object.keys(c.extra).length ? dl(Object.entries(c.extra).map(([k, v]) => [k, `<code>${e(v)}</code>`])) : '';
  return `<div class="env-grid">${sect('run', 'Run', run)}${sect('target', 'Target', target)}${sect('source', 'Source and pipeline', source)}${sect('machine', 'Machine', machine)}${sect('browsers', 'Browsers', browsers)}${sect('filters', 'Filters used', filtersBody)}</div>
${sect('config', 'Configuration', cfg, { open: false, hint: `${m.config?.length ?? 0} settings, secrets masked` })}
${sect('publishing', 'Publishing', pub.length ? `<div class="env-grid">${pub.join('')}</div>` : '', { open: false })}
${sect('evidence', 'Evidence', evidence, { open: false })}
${sect('extra', 'Other recorded values', extra, { open: false })}`;
}

// ------------------------------------------------------------------ policy (opt-in)

function policyPanel(m: ReportModel): string {
  const v = m.verdict!;
  const rank: Record<string, number> = { violation: 0, risk: 1, waived: 2, 'missing-input': 3, pass: 4, info: 5 };
  const reasons = [...v.reasons].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)).map((r) => `<li><span class="rk">${e(r.kind)}</span><span>${e(r.text)}${r.tests.length ? ` <span class="muted">(${r.tests.slice(0, 5).map((t) => `<a href="${testHref(t)}">${e(t)}</a>`).join(', ')}${r.tests.length > 5 ? `, +${r.tests.length - 5}` : ''})</span>` : ''}</span></li>`).join('');
  const gates = v.gates.length ? `<div style="margin-top:10px">${v.gates.map((g) => `<span class="gate" title="${e(g.summary)}">${e(g.gate)}: ${e(g.status)}</span>`).join('')}</div>` : '';
  const exc = v.exceptions.length ? `<p class="small" style="margin-top:8px">Exceptions applied: ${v.exceptions.map((x) => `${e(x.gate)} approved by <strong>${e(x.approver)}</strong> (${e(x.reason)})`).join('; ')}</p>` : '';
  return `<div class="panel-head"><p>The readiness policy's decision for this run (report.readiness). The results in the other tabs stand on their own; this is the policy's reading of them.</p></div>
<section class="card policy d-${v.decision === 'GO' ? 'pass' : v.decision === 'NO_GO' ? 'stop' : 'risk'}" aria-labelledby="policy-h"><div class="card-h"><h3 id="policy-h" class="grow">Readiness policy</h3>${v.score !== undefined ? `<span class="muted small">score ${e(v.score)} / 100</span>` : ''}</div><div class="decision">${e(v.decision.replace(/_/g, ' '))}</div><ul class="reasons" style="margin-top:10px">${reasons}</ul>${gates}${exc}</section>`;
}

// ------------------------------------------------------------------ page

/** The brand colour on the header and accents (legacy helper; brand.ts derives the full palette). */
export function brandCss(color: string | undefined): string {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return '';
  return paletteCss(brandPalette({ primary: color }));
}

/** The tabs a model shows, in order. */
export function reportTabs(m: ReportModel): Array<{ id: string; label: string }> {
  const L = labelsOf(m.brand);
  const failing = m.tests.some((t) => isFail(t) || t.state === 'flaky');
  return [
    { id: 'overview', label: L.tabs.overview },
    { id: 'tests', label: L.tabs.tests },
    ...(failing && !isHidden(m.brand, 'failures') ? [{ id: 'failures', label: L.tabs.failures }] : []),
    ...((m.trend.length >= 2 || m.comparison) && !isHidden(m.brand, 'trends') ? [{ id: 'trends', label: L.tabs.trends }] : []),
    ...(hasQuality(m) && !isHidden(m.brand, 'quality') ? [{ id: 'quality', label: L.tabs.quality }] : []),
    ...(!isHidden(m.brand, 'environment') ? [{ id: 'environment', label: L.tabs.environment }] : []),
    ...(m.verdict && !isHidden(m.brand, 'policy') ? [{ id: 'policy', label: L.tabs.policy }] : []),
  ];
}

const TAB_ICON: Record<string, string> = { overview: 'grid', tests: 'list', failures: 'bug', trends: 'trend', quality: 'gauge', environment: 'server', policy: 'scale' };

/** Render the HTML report of a model. */
export function renderReportModelHtml(m: ReportModel, o: { exports?: Array<{ label: string; href: string }>; featuresHtml?: string } = {}): string {
  const L = labelsOf(m.brand);
  const groups = causeGroups(m);
  const bodies: Record<string, () => string> = {
    overview: () => overviewPanel(m, L, groups),
    tests: () => testsPanel(m, L),
    failures: () => failuresPanel(m, L, groups),
    trends: () => trendsPanel(m, L),
    quality: () => qualityPanel(m),
    environment: () => environmentPanel(m),
    policy: () => policyPanel(m),
  };
  const tabs: TabDef[] = reportTabs(m).map((t) => ({ ...t, ico: TAB_ICON[t.id], body: bodies[t.id](), secondary: t.id === 'policy', alert: t.id === 'failures' }));
  const panels = tabs.map((t, i) => `<section class="tabpanel${i === 0 ? ' is-active' : ''}" id="p-${t.id}" data-tab="${t.id}" role="tabpanel" aria-labelledby="tab-${t.id}" tabindex="0"${t.id === 'tests' ? ' data-print="tests"' : ''}><h2 class="sr-only print-title">${e(t.label)}</h2>${t.body}</section>`).join('\n');
  const b = m.brand;
  const product = productName(b);
  const clientData = {
    runId: m.runId,
    title: m.title,
    startedAt: m.startedAt,
    brand: b.company ?? b.name,
    whiteLabel: !!b.whiteLabel,
    theme: b.theme ?? 'system',
    labels: { test: L.test, tests: L.tests },
    tabs: tabs.map((t) => t.id),
    branch: m.context?.branch,
    commit: m.context?.commit?.sha,
    baseUrl: m.context?.baseUrl,
    environment: m.context?.environment,
    browsers: m.context?.browsers.map((x) => x.name),
    evidenceKinds: m.evidenceKinds,
    evidence: m.evidence,
    clusters: Object.fromEntries(m.clusters.map((c) => [c.id, c.message])),
    tests: m.tests,
    ...(m.snapshots ? { snapshots: m.snapshots } : {}),
  };
  const fontCss = b.font ? `${b.font.src ? `@font-face{font-family:"${b.font.family}";src:url(${b.font.src}) format("woff2");font-display:swap}` : ''}:root{--sans:${fontStack(b.font.family)}}` : '';
  const foot = [
    b.footer ? `<span class="legal">${e(b.footer)}</span>` : '',
    b.preparedBy ? `<span>Prepared by ${e(b.preparedBy)}</span>` : '',
    `<span>${product ? `Generated by ${e(product)} ${e(m.context?.eztestVersion ?? '')} on ` : 'Generated on '}${e(fmtWhen(m.generatedAt))}</span>`,
    `<span><span class="kbd">?</span> keyboard shortcuts</span>`,
  ].join('');
  const themeBoot = `document.documentElement.classList.add('js');try{var t=localStorage.getItem('ez-report-theme');var d=${JSON.stringify(b.theme ?? 'system')};var q=/[?&]theme=(light|dark)/.exec(location.search);t=q?q[1]:t;if(t!=='light'&&t!=='dark')t=d!=='system'?d:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; media-src 'self' file: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self' about:">
${product ? `<meta name="generator" content="${e(product)} ${e(m.context?.eztestVersion ?? '')}">` : ''}
${b.favicon ? `<link rel="icon" href="${e(b.favicon)}">` : ''}
<title>${e(m.title)}${b.subtitle ? ` - ${e(b.subtitle)}` : ''} - ${e(fmtWhen(m.startedAt))}</title><style>${REPORT_CSS}${paletteCss(b.palette)}${fontCss}</style><script>${themeBoot}</script></head>
<body><a class="skip" href="#main">Skip to the report</a>
${header(m, L, o).replace('__TABS__', tabsHtml(tabs))}
<main id="main" tabindex="-1">
${panels}
</main>
<footer class="foot">${foot}</footer>
<div class="tip" id="tip" role="tooltip" hidden></div>
<dialog class="lightbox" id="lightbox" aria-label="Screenshot viewer"><div class="lb-in"><div class="lb-bar"><span class="lb-cap" id="lb-cap"></span><button type="button" class="btn" id="lb-prev">${icon('back')}Previous</button><button type="button" class="btn" id="lb-next">Next${icon('chevron')}</button><button type="button" class="btn" id="lb-zoom" aria-pressed="false">Actual size</button><a class="btn" id="lb-open" href="#" target="_blank" rel="noopener">${icon('external')}Open</a><button type="button" class="btn" id="lb-close">${icon('close')}Close</button></div><img id="lb-img" alt=""></div></dialog>
<script type="application/json" id="ez-data">${scriptJson(clientData)}</script>
<script>${REPORT_SCRIPT}</script></body></html>`;
}

/** Build the model of a run and render it. */
export function renderHtmlReport(run: RunResult, opts: HtmlReportOptions = {}): string {
  if (!run || !Array.isArray(run.journeys)) throw new EzTestError('renderHtmlReport requires a RunResult', 'INVALID_INPUT');
  if (run.journeys.length === 0) throw new EzTestError('renderHtmlReport: run has no journeys', 'INVALID_INPUT');
  const extraHtml = [...(opts.extraHtml ?? []), ...(opts.apiCoverage ?? []).map(apiCoverageHtml)];
  const model = buildReportModel(run, { ...opts, extraHtml });
  return renderReportModelHtml(model, { exports: opts.exports });
}
