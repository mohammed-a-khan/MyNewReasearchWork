/**
 * The run report inside Results: when a run has its HTML report, the run's
 * first tab ("Report") shows it in place with its PDF, Excel and e-mail
 * exports. The report carries the overview, the tests, the failures by
 * cause, the trends, the quality findings and the environment, so Studio
 * does not repeat them in tabs of its own (the Timeline, the Features bindings, heal review and the
 * evidence vault stay: they are Studio's tools for the run).
 */
import { add, h } from '../core/dom.js';
import { registerRunDetailTab, type RunDetail } from '../core/registry.js';
import { icon } from '../ui/icons.js';

/** Export buttons (PDF, Excel, e-mail summary...) of a run. */
export function exportLinks(d: RunDetail): HTMLElement | null {
  if (!d.exports?.length && !d.report) return null;
  return h(
    'div',
    { class: 'row wrap rr-exports', role: 'group', 'aria-label': 'Report files' },
    d.report ? h('a', { class: 'btn btn-sm', href: d.report, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { text: 'Open in a new tab' })) : null,
    (d.exports ?? []).map((x) => h('a', { class: 'btn btn-sm', href: x.href, download: '', 'data-format': x.format }, icon('download'), h('span', { text: x.label }))),
  );
}

/** The "Report" tab: the run's HTML report in place (the run's first tab when it has one). */
export function registerReportTab(): void {
  registerRunDetailTab({
    id: 'report',
    title: 'Report',
    order: 5,
    when: (d) => !!d.report,
    mount(el, d, ctx) {
      // A journey deep link opens the report on that test.
      const src = ctx.journeyId ? `${d.report!}#tests/${encodeURIComponent(ctx.journeyId)}` : d.report!;
      add(
        el,
        exportLinks(d),
        h('iframe', {
          class: 'rr-frame',
          id: 'run-report-frame',
          src,
          title: `Report of run ${d.run.runId}`,
          // Scripts run (the report's own, CSP-restricted to no network); forms, top navigation and plugins stay off.
          sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
        }),
      );
    },
  });
}
