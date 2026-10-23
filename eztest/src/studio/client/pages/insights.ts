/** Insights: flaky scores (sortable table), the pass/heal/fail trend, and failure clusters of the latest run. */
import { api } from '../core/api.js';
import { clear, h } from '../core/dom.js';
import { pct, plural } from '../core/format.js';
import { registerPage } from '../core/registry.js';
import { link } from '../core/router.js';
import { runsVersion } from '../core/state.js';
import { badge, card, emptyState } from '../ui/badge.js';
import { outcomeStrip, trendChart, type TrendPoint } from '../ui/sparkline.js';
import { createTable } from '../ui/table.js';

interface Flaky {
  journeyId: string;
  state: string;
  samples: number;
  failRate: number;
  flipRate: number;
  healedRate: number;
  healedTrendRising: boolean;
  sequence: string;
  quarantine: { recommended: boolean; reason: string };
}

interface InsightsResponse {
  flaky: Flaky[];
  trend: Array<TrendPoint & { healedRatio: number }>;
  latest?: { runId: string; clusters: Array<{ id: string; size: number; members: string[]; message: string }> };
  warnings: string[];
}

export function registerInsightsPage(): void {
  registerPage({
    id: 'insights',
    title: 'Insights',
    icon: 'insights',
    order: 50,
    shortcut: 'Alt+5',
    mount(ctx) {
      const heading = h('h1', { class: 'page-title', tabindex: '-1', text: 'Insights' });
      const body = h('div', { class: 'cards' });
      ctx.root.classList.add('page-scroll');
      ctx.root.append(h('div', { class: 'page-inner' }, h('header', { class: 'page-head' }, heading, h('p', { class: 'muted', text: 'Flakiness, healing trend and failure clusters from your run history.' })), body));

      const flakyTable = createTable<Flaky>({
        label: 'Flaky score per journey',
        key: (f) => f.journeyId,
        sort: { id: 'flip', dir: 'desc' },
        columns: [
          { id: 'journey', title: 'Journey', width: 'minmax(10rem, 2fr)', sortable: true, value: (f) => f.journeyId },
          { id: 'state', title: 'State', width: '7.5rem', sortable: true, value: (f) => f.state, render: (f) => badge(f.state) },
          { id: 'runs', title: 'Runs', width: '4rem', sortable: true, align: 'end', value: (f) => f.samples },
          { id: 'fail', title: 'Fail rate', width: '5.5rem', sortable: true, align: 'end', value: (f) => f.failRate, render: (f) => pct(f.failRate) },
          { id: 'flip', title: 'Flip rate', width: '5.5rem', sortable: true, align: 'end', value: (f) => f.flipRate, render: (f) => pct(f.flipRate) },
          { id: 'healed', title: 'Healed', width: '6.5rem', sortable: true, align: 'end', value: (f) => f.healedRate, render: (f) => `${pct(f.healedRate)}${f.healedTrendRising ? ' ↑' : ''}` },
          { id: 'history', title: 'History', width: 'minmax(8rem, 1fr)', render: (f) => outcomeStrip(f.sequence) },
          { id: 'quarantine', title: 'Quarantine', width: 'minmax(8rem, 1fr)', value: (f) => (f.quarantine.recommended ? f.quarantine.reason : 'No'), render: (f) => (f.quarantine.recommended ? h('span', { class: 'warn-text', text: `Recommended: ${f.quarantine.reason}` }) : 'No') },
        ],
        empty: 'No history yet. Run some journeys first.',
      });

      const load = async () => {
        clear(body).appendChild(h('p', { class: 'muted', role: 'status', text: 'Loading…' }));
        let r: InsightsResponse;
        try {
          r = await api.get<InsightsResponse>('/api/insights');
        } catch (e) {
          clear(body).appendChild(h('p', { class: 'bad-text', text: `Could not load insights: ${(e as Error).message}` }));
          return;
        }
        clear(body);
        flakyTable.setRows(r.flaky);
        body.appendChild(card('Flaky scores', h('div', { class: 'table-frame fixed-h' }, flakyTable.el), { id: 'flaky', class: 'span-2' }));
        const trend = r.trend;
        body.appendChild(
          card(
            'Pass, heal and fail trend',
            trend.length
              ? h(
                  'div',
                  null,
                  trendChart(trend, { width: 640, height: 120, label: 'Run outcomes' }),
                  h(
                    'details',
                    null,
                    h('summary', { text: 'Show as a table' }),
                    h(
                      'table',
                      { class: 'table compact' },
                      h('caption', { class: 'sr-only', text: 'Outcomes per run' }),
                      h('thead', null, h('tr', null, ['Run', 'Journeys', 'Passed', 'Healed', 'Failed', 'Healed share'].map((t) => h('th', { scope: 'col', text: t })))),
                      h('tbody', null, trend.map((t) => h('tr', null, h('td', null, h('a', { class: 'mono', href: link('runs', t.runId), text: t.runId })), h('td', { text: String(t.total) }), h('td', { text: String(t.passed) }), h('td', { text: String(t.healed) }), h('td', { text: String(t.failed) }), h('td', { text: pct(t.healedRatio) })))),
                    ),
                  ),
                )
              : emptyState('No runs recorded', 'History builds up as you run journeys.'),
            { id: 'trend' },
          ),
        );
        const latest = r.latest;
        body.appendChild(
          card(
            'Failure clusters of the latest run',
            !latest
              ? emptyState('No runs yet', 'Clusters group failures that share a root cause.')
              : !latest.clusters.length
                ? h('p', null, badge('ok', 'No failures'), ` in ${latest.runId}`)
                : h('ul', { class: 'clusters' }, latest.clusters.map((c) => h('li', null, h('strong', { text: plural(c.size, 'failing journey') }), ': ', h('code', { text: c.message }), h('p', { class: 'muted', text: c.members.join(', ') })))),
            { id: 'clusters' },
          ),
        );
        for (const w of r.warnings) body.appendChild(h('p', { class: 'warn-text', text: `Warning: ${w}` }));
      };
      runsVersion.subscribe(() => !ctx.root.hidden && void load(), false);
      return { show: () => void load(), focus: () => heading.focus() };
    },
  });
}
