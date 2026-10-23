/**
 * Trends and analytics (#/quality/trends): pass, heal and flaky rates, mean
 * duration, failures by classification over time; slowest journeys and steps;
 * tags and areas.
 */
import { api } from '../../core/api.js';
import { h, uid } from '../../core/dom.js';
import { dateTime, ms, pct, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link } from '../../core/router.js';
import { card, stat } from '../../ui/badge.js';
import { barList, lineChart, stackedColumns } from './charts.js';
import { autoRefresh, CATEGORY_LABEL, meter, qualityFrame } from './common.js';

interface Trends {
  points: Array<{ runId: string; startedAt: string; total: number; executed: number; passRate: number; healRate: number; flakyRate: number; meanDurationMs: number; failures: Record<string, number> }>;
  slowJourneys: Array<{ journeyId: string; name: string; meanMs: number; maxMs: number; samples: number }>;
  slowSteps: Array<{ journeyId: string; stepId: string; intent: string; meanMs: number; maxMs: number; samples: number }>;
  tags: Array<{ tag: string; runs: number; passed: number; healed: number; failed: number }>;
  areas: Array<{ area: string; runs: number; passed: number; healed: number; failed: number }>;
  categories: string[];
}

function groupTable(caption: string, first: string, rows: Array<{ key: string; runs: number; passed: number; healed: number; failed: number }>): HTMLElement {
  return h(
    'div',
    { class: 'q-table-scroll' },
    h(
      'table',
      { class: 'table compact' },
      h('caption', { class: 'sr-only', text: caption }),
      h('thead', null, h('tr', null, [first, 'Results', 'Pass rate', 'Healed', 'Failed'].map((t) => h('th', { scope: 'col', text: t })))),
      h(
        'tbody',
        null,
        rows.map((r) => {
          const rate = r.runs ? (r.passed + r.healed) / r.runs : 0;
          return h('tr', null, h('th', { scope: 'row', text: r.key }), h('td', { class: 'num', text: String(r.runs) }), h('td', null, h('div', { class: 'q-rate' }, meter(rate, `${r.key} pass rate ${pct(rate)}`, rate >= 0.95 ? 'ok' : rate >= 0.8 ? 'warn' : 'bad'), h('span', { class: 'num small', text: pct(rate) }))), h('td', { class: 'num', text: String(r.healed) }), h('td', { class: 'num', text: String(r.failed) }));
        }),
      ),
    ),
  );
}

export function registerTrendsPage(): void {
  registerPage({
    id: 'quality-trends',
    title: 'Trends',
    icon: 'insights',
    route: 'quality/trends',
    group: 'quality',
    order: 260,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Trends and analytics', 'How suite health moves over time: pass, heal and flaky rates, duration, failure classes, and where time and failures concentrate.', { wide: true });
      const nSel = h('select', { id: uid('n'), class: 'input input-sm' }, [10, 30, 100].map((n) => h('option', { value: String(n), selected: n === 30, text: `Last ${n} runs` })));
      f.toolbar.append(h('div', { class: 'q-inline-field' }, h('label', { for: nSel.id, text: 'Range' }), nSel));

      const render = (t: Trends) => {
        const p = t.points;
        if (!p.length) return f.empty('No runs yet', 'Trends appear once journeys have run.');
        const x = p.map((q) => relTime(q.startedAt));
        const xLong = p.map((q) => `${dateTime(q.startedAt)} (${q.runId})`);
        const last = p[p.length - 1];
        const avg = (k: 'passRate' | 'healRate' | 'flakyRate') => p.reduce((s, q) => s + q[k], 0) / p.length;
        const slots: Record<string, number> = { 'product-bug': 1, 'test-issue': 2, environment: 3, data: 4, flaky: 5, unknown: 6 };
        f.content(
          h('div', { class: 'stats q-kpis' }, stat(pct(last.passRate), `Pass rate (avg ${pct(avg('passRate'))})`, last.passRate >= 0.95 ? 'ok' : 'warn'), stat(pct(last.healRate), `Heal rate (avg ${pct(avg('healRate'))})`, 'heal'), stat(pct(last.flakyRate), `Flaky rate (avg ${pct(avg('flakyRate'))})`, last.flakyRate ? 'warn' : undefined), stat(ms(last.meanDurationMs), 'Mean journey duration')),
          h(
            'div',
            { class: 'q-grid2' },
            card('Pass, heal and flaky rate', lineChart([{ id: 'pass', label: 'Pass rate', slot: 1, values: p.map((q) => q.passRate) }, { id: 'heal', label: 'Heal rate', slot: 2, values: p.map((q) => q.healRate) }, { id: 'flaky', label: 'Flaky rate', slot: 3, values: p.map((q) => q.flakyRate) }], { label: 'Pass, heal and flaky rate per run', x, xLong, format: pct, yMax: 1 }), { id: 'trend-rates' }),
            card('Mean journey duration', lineChart([{ id: 'dur', label: 'Mean duration', slot: 1, values: p.map((q) => q.meanDurationMs) }], { label: 'Mean journey duration per run', x, xLong, format: (v) => ms(v) }), { id: 'trend-duration' }),
          ),
          card(
            'Failures by classification',
            stackedColumns(p.map((q, i) => ({ x: x[i], xLong: xLong[i], values: q.failures })), t.categories.map((c) => ({ id: c, label: CATEGORY_LABEL[c] ?? c, slot: slots[c] ?? 6 })), { label: 'Failed journeys per run by triage classification (after reviews)', width: 1200, height: 220 }),
            { id: 'trend-failures' },
          ),
          h(
            'div',
            { class: 'q-grid2' },
            card('Slowest journeys (mean)', t.slowJourneys.length ? barList(t.slowJourneys.map((j) => ({ label: j.name, sub: `max ${ms(j.maxMs)} · ${j.samples} runs`, value: j.meanMs })), { label: 'Slowest journeys by mean duration', format: ms }) : h('p', { class: 'muted', text: 'No data' }), { id: 'slow-journeys' }),
            card('Slowest steps (mean)', t.slowSteps.length ? barList(t.slowSteps.map((s) => ({ label: s.intent, sub: `${s.journeyId} · max ${ms(s.maxMs)}`, value: s.meanMs, href: link('runs', p[p.length - 1].runId, s.journeyId, s.stepId) })), { label: 'Slowest steps by mean duration', format: ms }) : h('p', { class: 'muted', text: 'No data' }), { id: 'slow-steps' }),
          ),
          h(
            'div',
            { class: 'q-grid2' },
            card('Tags', groupTable('Results by tag', 'Tag', t.tags.map((g) => ({ key: g.tag.startsWith('(') ? g.tag : `@${g.tag}`, ...g }))), { id: 'by-tag' }),
            card('Areas (journey folders)', groupTable('Results by area', 'Area', t.areas.map((g) => ({ key: g.area, ...g }))), { id: 'by-area' }),
          ),
        );
      };

      const load = async () => {
        f.loading();
        try {
          render(await api.get<Trends>(`/api/quality/trends?n=${nSel.value}`));
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      nSel.addEventListener('change', () => void load());
      autoRefresh(ctx, () => void load(), ['triage']);
      return { show: () => void load(), focus: () => f.heading.focus() };
    },
  });
}
