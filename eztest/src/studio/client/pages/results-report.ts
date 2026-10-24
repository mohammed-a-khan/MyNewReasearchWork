/**
 * The run report inside Results: the run-level analysis on the Overview tab
 * (readiness, figures against the previous run, what needs attention, failure
 * categories with the suggested next step, quality lens counts, the pass-rate
 * trend) and a "Report" tab that shows the run's full HTML report in place,
 * with its PDF, Excel and e-mail exports.
 */
import { add, h } from '../core/dom.js';
import { ms, pct } from '../core/format.js';
import { registerRunDetailTab, type RunDetail, type ReportSummary } from '../core/registry.js';
import { link } from '../core/router.js';
import { badge, card, stat } from '../ui/badge.js';
import { icon } from '../ui/icons.js';

const CATEGORY: Record<string, string> = { product: 'Product defect', test: 'Test issue', environment: 'Environment', data: 'Test data', flaky: 'Flaky', unknown: 'Needs review' };
const ORDER = ['product', 'test', 'environment', 'data', 'flaky', 'unknown'];

const catChip = (c: string) => h('span', { class: `rr-cat rr-${c}`, text: CATEGORY[c] ?? c });

function delta(cur: number, prev: number | undefined, f: (n: number) => string = String): string {
  if (prev === undefined) return '';
  if (cur === prev) return 'same as previous';
  return `${cur > prev ? '+' : '-'}${f(Math.abs(cur - prev))} vs previous`;
}

/** Export buttons (PDF, Excel, e-mail summary...) of a run. */
export function exportLinks(d: RunDetail): HTMLElement | null {
  if (!d.exports?.length && !d.report) return null;
  return h(
    'div',
    { class: 'row wrap rr-exports', role: 'group', 'aria-label': 'Report files' },
    d.report ? h('a', { class: 'btn btn-sm', href: d.report, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { text: 'HTML report' })) : null,
    (d.exports ?? []).map((x) => h('a', { class: 'btn btn-sm', href: x.href, download: '', 'data-format': x.format }, icon('download'), h('span', { text: x.label }))),
  );
}

/** The run-level analysis for the Overview tab. */
export function reportSummaryView(d: RunDetail): HTMLElement | null {
  const s: ReportSummary | undefined = d.reportSummary;
  if (!s) return null;
  const k = s.kpis;
  const p = s.previous?.kpis;
  const v = s.verdict;
  const tone = v.decision === 'GO' ? 'ok' : v.decision === 'NO_GO' ? 'bad' : 'warn';
  const testLink = (t: { id: string; name: string }) => h('a', { href: link('runs', d.run.runId, t.id), text: t.name });
  const attention = ([['newFailures', 'New failures'], ['regressions', 'Regressions'], ['flaky', 'Flaky'], ['fixed', 'Fixed'], ['slower', 'Slower']] as const).map(([key, label]) => {
    const list = s.attention[key] ?? [];
    return h('div', { class: 'rr-attn-item' }, h('div', { class: 'rr-attn-head' }, h('strong', { class: `rr-attn-n ${list.length && (key === 'newFailures' || key === 'regressions') ? 'bad-text' : ''}`, text: String(list.length) }), h('span', { text: label })), list.length ? h('ul', { class: 'rr-list' }, list.slice(0, 5).map((t) => h('li', null, testLink(t)))) : null);
  });
  const catMax = Math.max(1, ...Object.values(s.categories));
  const cats = ORDER.filter((c) => s.categories[c]).map((c) => h('div', { class: 'rr-bar-row' }, catChip(c), h('span', { class: 'rr-bar', 'aria-hidden': 'true' }, h('span', { class: `rr-fill rr-${c}`, style: { width: `${Math.round((s.categories[c] / catMax) * 100)}%` } })), h('span', { class: 'rr-bar-n', text: `${s.categories[c]} test${s.categories[c] === 1 ? '' : 's'}` })));
  const failures = s.failures.map((f) =>
    h('li', { class: 'rr-failure' },
      h('div', { class: 'row wrap' }, badge(f.state === 'error' ? 'error' : f.state), catChip(f.category), f.known ? null : h('span', { class: 'rr-cat rr-new', text: 'new' }), testLink(f)),
      f.failedStep ? h('div', { class: 'small', text: `Failed at: ${f.failedStep}` }) : null,
      f.error ? h('pre', { class: 'rr-err', text: f.error }) : null,
      h('p', { class: 'small' }, h('strong', { text: 'Suggested next step: ' }), f.fix),
    ),
  );
  const lens = s.lenses;
  const lensChips = lens
    ? h('div', { class: 'row wrap' },
        lens.a11y ? h('span', { class: 'chip', text: `Accessibility: ${lens.a11y.critical ?? 0} critical, ${lens.a11y.serious ?? 0} serious, ${lens.a11y.moderate ?? 0} moderate` }) : null,
        lens.security ? h('span', { class: 'chip', text: `Security: ${lens.security.high ?? 0} high, ${lens.security.medium ?? 0} medium, ${lens.security.low ?? 0} low` }) : null,
        lens.perf ? h('span', { class: 'chip', text: lens.perf.length ? `Performance over budget: ${lens.perf.join(', ')}` : 'Performance budgets met' }) : null)
    : null;
  const trend = s.trend.length >= 2
    ? h('div', { class: 'rr-trend', role: 'img', 'aria-label': `Pass rate of the last ${s.trend.length} runs, oldest first: ${s.trend.map((t) => pct(t.passRate)).join(', ')}` },
        s.trend.map((t) => h('span', { class: `rr-col${t.current ? ' rr-current' : ''}`, title: `${t.runId}: ${pct(t.passRate)}, ${ms(t.durationMs)}`, style: { height: `${Math.max(4, Math.round(t.passRate * 48))}px` } })))
    : null;
  return h(
    'div',
    { class: 'rr', id: 'run-report-summary' },
    h('div', { class: `rr-verdict tone-${tone}` }, h('span', { class: 'rr-v-label', text: 'Release readiness' }), h('strong', { class: 'rr-v-decision', text: v.decision.replace(/_/g, ' ') }), h('span', { class: 'muted small', text: v.score !== undefined ? `score ${v.score} / 100` : 'built-in rule' }), trend ? h('span', { class: 'rr-trend-wrap' }, h('span', { class: 'muted small', text: 'Pass rate trend' }), trend) : null),
    h('div', { class: 'stats' },
      stat(pct(k.passRate), `Pass rate ${delta(k.passRate * 100, p ? p.passRate * 100 : undefined, (n) => `${n.toFixed(1)} pp`)}`.trim()),
      stat(k.failed + k.errors, `Failed ${delta(k.failed + k.errors, p ? p.failed + p.errors : undefined)}`.trim(), k.failed + k.errors ? 'bad' : undefined),
      stat(k.flaky, `Flaky ${delta(k.flaky, p?.flaky)}`.trim()),
      stat(ms(k.durationMs), `Duration ${delta(k.durationMs, p?.durationMs, ms)}`.trim())),
    card('Needs attention', h('div', { class: 'rr-attn' }, attention), { id: 'rr-attention' }),
    cats.length ? card('Failure categories', h('div', null, cats, h('ul', { class: 'rr-failures' }, failures)), { id: 'rr-categories' }) : null,
    lensChips ? card('Quality lenses', lensChips, { id: 'rr-lenses' }) : null,
    exportLinks(d),
  );
}

/** The "Report" tab: the run's HTML report in place. */
export function registerReportTab(): void {
  registerRunDetailTab({
    id: 'report',
    title: 'Report',
    order: 15,
    when: (d) => !!d.report,
    mount(el, d) {
      add(
        el,
        exportLinks(d),
        h('iframe', {
          class: 'rr-frame',
          id: 'run-report-frame',
          src: d.report!,
          title: `HTML report of run ${d.run.runId}`,
          // Scripts run (the report's own, CSP-restricted to no network); forms, top navigation and plugins stay off.
          sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
          loading: 'lazy',
        }),
      );
    },
  });
}
