/**
 * Home dashboard: last run, pass/heal/fail trend, release readiness, journey
 * health, flakiest journeys and recent heals, plus quick actions. Refreshes
 * when a run finishes or problems change.
 */
import { api } from '../core/api.js';
import { clear, h } from '../core/dom.js';
import { ms, pct, plural, relTime } from '../core/format.js';
import { dashboardCards, registerPage } from '../core/registry.js';
import { link, navigate } from '../core/router.js';
import { problemCount, runsVersion, session } from '../core/state.js';
import { badge, button, card, emptyState, stat } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { showPanel } from '../ui/shell.js';
import { outcomeStrip, trendChart, type TrendPoint } from '../ui/sparkline.js';
import { outcomeOf, type RunListItem } from './results.js';

interface Dashboard {
  lastRun?: RunListItem;
  runs: number;
  trend: TrendPoint[];
  readiness?: { runId: string; decision: string; score: number; rationale: string[] };
  flaky: Array<{ journeyId: string; state: string; failRate: number; flipRate: number; healedRate: number; samples: number; sequence: string }>;
  heals: Array<{ runId: string; startedAt?: string; journeyName?: string; intent?: string; tier?: string; confidence?: number; healed?: { strategy: string; value: string } }>;
  journeys: { total: number; broken: number; steps: number };
  problems: number;
  active?: { id: string; state: string };
  warnings: string[];
}

export function registerDashboardPage(): void {
  registerPage({
    id: 'home',
    title: 'Home',
    icon: 'home',
    order: 10,
    shortcut: 'Alt+1',
    mount(ctx) {
      const heading = h('h1', { class: 'page-title', tabindex: '-1', text: 'Dashboard' });
      const sub = h('p', { class: 'muted' });
      const grid = h('div', { class: 'dash-grid' });
      const quick = h(
        'div',
        { class: 'quick-actions', role: 'group', 'aria-label': 'Quick actions' },
        button('New journey', { icon: 'plus', onclick: () => import('../core/registry.js').then((m) => m.runCommand('journey.new')) }),
        button('Run journeys', { icon: 'run', kind: 'primary', onclick: () => navigate(link('run')) }),
        button('Record', { icon: 'record', onclick: () => navigate(link('record')) }),
        button('Import tests', { icon: 'import', onclick: () => navigate(link('import')) }),
      );
      ctx.root.classList.add('page-scroll');
      ctx.root.append(h('div', { class: 'page-inner' }, h('header', { class: 'page-head row-between' }, h('div', null, heading, sub), quick), grid));
      session.subscribe((s) => (sub.textContent = s ? `${s.project}${s.branch ? ` · ${s.branch}` : ''} · journeys in ${s.journeysDir}/` : ''));

      const render = (d: Dashboard) => {
        clear(grid);
        const lr = d.lastRun;
        const s = lr?.summary;
        grid.appendChild(
          card(
            'Last run',
            lr && s
              ? h(
                  'div',
                  { class: 'stack' },
                  h('p', { class: 'row' }, badge(outcomeOf(lr)), h('a', { class: 'mono', href: link('runs', lr.runId), text: lr.runId })),
                  h('p', { class: 'muted', text: `${relTime(lr.startedAt)} · ${ms(lr.durationMs)}` }),
                  h('div', { class: 'stats' }, stat(s.passed, 'Passed', 'ok'), stat(s.passedHealed, 'Healed', 'heal'), stat(s.failed + s.errors, 'Failed', 'bad'), stat(s.skipped, 'Skipped')),
                )
              : emptyState('No runs yet', 'Run your journeys to see results here.', button('Run journeys', { kind: 'primary', icon: 'run', onclick: () => navigate(link('run')) })),
            { id: 'dash-last', actions: lr ? h('a', { class: 'link-btn', href: link('runs'), text: `All ${plural(d.runs, 'run')}` }) : undefined },
          ),
        );
        grid.appendChild(
          card(
            'Release readiness',
            d.readiness
              ? h(
                  'div',
                  { class: 'stack' },
                  h('p', { class: 'readiness-big' }, badge(d.readiness.decision), h('span', { class: 'muted', text: ` score ${d.readiness.score}` })),
                  d.readiness.rationale.length ? h('ul', { class: 'bullets' }, d.readiness.rationale.slice(0, 4).map((r) => h('li', { text: r }))) : null,
                )
              : emptyState('No decision yet', 'Add a readiness policy (readiness.policyPath) to get GO / NO GO decisions after each run.'),
            { id: 'dash-readiness' },
          ),
        );
        grid.appendChild(
          card(
            'Journeys',
            h(
              'div',
              { class: 'stack' },
              h('div', { class: 'stats' }, stat(d.journeys.total, 'Journeys'), stat(d.journeys.steps, 'Steps'), stat(d.problems, 'Problems', d.problems ? 'bad' : 'ok')),
              d.problems || d.journeys.broken
                ? button(`Show ${plural(d.problems, 'problem')}`, { icon: 'alert', small: true, onclick: () => showPanel('problems', true) })
                : h('p', { class: 'ok-text' }, icon('check', { size: 14 }), h('span', { text: ' Every journey parses' })),
            ),
            { id: 'dash-journeys', actions: h('a', { class: 'link-btn', href: link('journeys'), text: 'Open editor' }) },
          ),
        );
        grid.appendChild(
          card(
            'Trend',
            d.trend.length ? trendChart(d.trend.slice(-30), { width: 520, height: 72, label: 'Pass, heal and fail trend' }) : emptyState('No history yet', 'The trend fills in as you run journeys.'),
            { id: 'dash-trend', class: 'span-2' },
          ),
        );
        grid.appendChild(
          card(
            'Flakiest journeys',
            d.flaky.length
              ? h(
                  'ul',
                  { class: 'rank-list' },
                  d.flaky.map((f) => h('li', null, h('div', { class: 'rank-main' }, h('strong', { text: f.journeyId }), badge(f.state)), h('div', { class: 'rank-sub' }, outcomeStrip(f.sequence, 16), h('span', { class: 'muted small', text: `flip ${pct(f.flipRate)} · fail ${pct(f.failRate)} · ${plural(f.samples, 'run')}` })))),
                )
              : emptyState('Nothing flaky', 'No journey flips between pass and fail in recent history.'),
            { id: 'dash-flaky', actions: h('a', { class: 'link-btn', href: link('insights'), text: 'Insights' }) },
          ),
        );
        grid.appendChild(
          card(
            'Recent heals',
            d.heals.length
              ? h(
                  'ul',
                  { class: 'rank-list' },
                  d.heals.map((x) => h('li', null, h('div', { class: 'rank-main' }, icon('heal', { size: 14 }), h('strong', { text: x.journeyName ?? '' }), h('span', { class: 'chip', text: x.tier ?? '' })), h('div', { class: 'rank-sub' }, h('span', { text: x.intent ?? '' }), h('code', { class: 'small', text: x.healed ? `${x.healed.strategy}=${x.healed.value}` : '' }), h('a', { class: 'muted small', href: link('runs', x.runId), text: relTime(x.startedAt) })))),
                )
              : emptyState('No heals', 'Verified heals of changed locators show up here for review.'),
            { id: 'dash-heals', class: 'span-2' },
          ),
        );
        // Cards contributed by features (registerDashboardCard), e.g. the Quality Center.
        for (const c of dashboardCards.get()) {
          const slot = h('div', { class: 'dash-slot', dataset: { card: c.id } });
          grid.appendChild(slot);
          void Promise.resolve(c.render())
            .then((el) => (el ? slot.replaceWith(el) : slot.remove()))
            .catch(() => slot.remove());
        }
        for (const w of d.warnings) grid.appendChild(h('p', { class: 'warn-text span-all', text: `Warning: ${w}` }));
      };

      const load = async () => {
        try {
          render(await api.get<Dashboard>('/api/dashboard'));
        } catch (e) {
          clear(grid).appendChild(h('p', { class: 'bad-text', text: `Could not load the dashboard: ${(e as Error).message}` }));
        }
      };
      runsVersion.subscribe(() => !ctx.root.hidden && void load(), false);
      problemCount.subscribe(() => !ctx.root.hidden && void load(), false);
      return { show: () => void load(), focus: () => heading.focus() };
    },
  });
}
