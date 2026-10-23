/**
 * Coverage (#/quality/coverage): one view of UI, requirement, API, risk,
 * change and manual coverage; the UI coverage map page by page, with a heat
 * overlay painted into the stored DOM snapshot (sandboxed iframe, like the
 * trace viewer) and the untested elements of each page; UI coverage and
 * accessibility trends; failure tags of the latest run.
 */
import { api } from '../../core/api.js';
import { h, uid } from '../../core/dom.js';
import { dateTime, pct, plural, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link } from '../../core/router.js';
import { badge, button, card, stat } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { lineChart } from './charts.js';
import { autoRefresh, meter, qualityFrame } from './common.js';

interface Element {
  key: string;
  role: string;
  name: string;
  label: string;
  count: number;
  disabled?: boolean;
  href?: string;
  interactions: number;
  assertions: number;
  journeys: string[];
  tested: boolean;
}

interface Page {
  route: string;
  url: string;
  title: string;
  snapshots: number;
  journeys: string[];
  elements: Element[];
  total: number;
  tested: number;
  percent: number;
  representative?: { runId: string; journeyId: string };
}

interface Dimension {
  id: string;
  label: string;
  covered: number;
  total: number;
  ratio?: number;
  status: 'ok' | 'warn' | 'bad' | 'no-data';
  detail: string;
  gaps: Array<{ id: string; text: string; link?: string }>;
}

interface Overview {
  combined: { dimensions: Dimension[]; overall?: number };
  ui: { pages: Page[]; totals: { pages: number; elements: number; tested: number; percent: number; links: number; visitedLinks: number; snapshots: number }; unvisitedLinks: Array<{ route: string; from: string[]; label: string }>; warnings: string[] };
  runIds: string[];
  latestRunId?: string;
  failureTags: Array<{ journeyId: string; tags: string[]; failingStreak: number }>;
  uniqueErrors: Array<{ signature: string; message: string; journeys: string[] }>;
}

interface Trend {
  ui: Array<{ runId: string; startedAt?: string; percent: number; tested: number; total: number }>;
  a11y: {
    points: Array<{ runId: string; startedAt?: string; total: number; new: number; fixed: number }>;
    latest?: { runId: string; previous?: string; new: Array<{ ruleId: string; route: string; target: string; component: string; help: string }>; fixed: Array<{ ruleId: string; route: string; target: string; component: string }>; persisting: unknown[] };
    byComponent: Array<{ component: string; open: number; new: number; fixed: number; rules: string[] }>;
  };
}

const TAG_LABEL: Record<string, string> = { 'new-failure': 'New failure', 'always-failing': 'Always failing', regressed: 'Regressed', flaky: 'Flaky' };
const tone = (s: Dimension['status']) => (s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : s === 'bad' ? 'bad' : undefined);

export function registerCoveragePage(): void {
  registerPage({
    id: 'quality-coverage',
    title: 'Coverage',
    icon: 'target',
    route: 'quality/coverage',
    group: 'quality',
    order: 245,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Coverage', 'What the suite exercises: UI elements per page, requirements, API operations, risk, changed code and manual verification, with the gaps in each.', { wide: true });
      const exp = (fmt: string, label: string) => h('a', { class: 'btn btn-sm', href: `/api/quality/coverage/export.${fmt}`, download: '', id: `coverage-export-${fmt}` }, icon('download', { size: 14 }), h('span', { text: label }));
      f.toolbar.append(exp('csv', 'UI map CSV'), exp('json', 'JSON'));
      let data: Overview | undefined;
      let trend: Trend | undefined;
      let selected: string | undefined;
      let focusKey: string | undefined;
      const untestedOnly = h('input', { type: 'checkbox', id: uid('untested'), checked: true });

      const dimTile = (d: Dimension) =>
        h(
          'li',
          { class: ['cov-dim', `tone-${d.status}`], dataset: { dim: d.id } },
          h('div', { class: 'row-between' }, h('h3', { class: 'q-h3', text: d.label }), d.status === 'no-data' ? h('span', { class: 'chip', text: 'no data' }) : badge(d.status === 'ok' ? 'ok' : d.status === 'warn' ? 'warn' : 'bad', d.ratio !== undefined ? pct(d.ratio) : '')),
          d.ratio !== undefined ? meter(d.ratio, `${d.label} coverage ${pct(d.ratio)}`, tone(d.status) ?? 'ok') : null,
          h('p', { class: 'small muted', text: d.detail }),
          d.gaps.length ? h('details', { class: 'cov-gaps' }, h('summary', { text: `${plural(d.gaps.length, 'gap')}` }), h('ul', { class: 'bullets small' }, d.gaps.slice(0, 50).map((g) => h('li', null, g.link ? h('a', { href: g.link, text: g.text }) : h('span', { text: g.text }))), d.gaps.length > 50 ? h('li', { class: 'muted', text: `… ${d.gaps.length - 50} more` }) : null)) : null,
        );

      const overlayUrl = (route: string) => `/api/quality/coverage/overlay?route=${encodeURIComponent(route)}${focusKey ? `&focus=${encodeURIComponent(focusKey)}` : ''}`;

      const pageDetail = (p: Page): HTMLElement => {
        const list = untestedOnly.checked ? p.elements.filter((e) => !e.tested) : p.elements;
        const frame = h('iframe', { class: 'cov-frame', sandbox: '', src: p.representative ? overlayUrl(p.route) : 'about:blank', title: `Coverage heat overlay of ${p.route}`, referrerpolicy: 'no-referrer', id: 'coverage-overlay' });
        return h(
          'div',
          { class: 'cov-detail', id: 'coverage-page' },
          h('div', { class: 'row-between' }, h('h3', { class: 'q-h3' }, h('code', { text: p.route }), ` · ${p.tested}/${p.total} tested (${pct(p.percent)})`), h('span', { class: 'small muted', text: `${plural(p.snapshots, 'snapshot')} · journeys: ${p.journeys.join(', ') || 'none'}` })),
          h('p', { class: 'cov-legend small' }, h('span', { class: 'cov-key cov-key-tested', 'aria-hidden': 'true' }), ' Tested (solid green; darker = used more) ', h('span', { class: 'cov-key cov-key-untested', 'aria-hidden': 'true' }), ' Untested (dashed red) ', h('span', { class: 'cov-key cov-key-focus', 'aria-hidden': 'true' }), ' Selected'),
          h('div', { class: 'cov-split' },
            h('div', { class: 'cov-frame-wrap' }, p.representative ? frame : h('p', { class: 'muted', text: 'No snapshot of this page.' })),
            h(
              'div',
              { class: 'cov-elements' },
              h('label', { class: 'check' }, untestedOnly, h('span', { text: 'Untested only' })),
              list.length
                ? h(
                    'table',
                    { class: 'table compact', id: 'coverage-elements' },
                    h('caption', { class: 'sr-only', text: `Interactive elements on ${p.route}` }),
                    h('thead', null, h('tr', null, ['Element', 'Status', 'Used by', ''].map((t) => h('th', { scope: 'col', text: t })))),
                    h(
                      'tbody',
                      null,
                      list.map((e) =>
                        h(
                          'tr',
                          { dataset: { key: e.key, tested: String(e.tested) }, class: focusKey === e.key ? 'row-active' : undefined },
                          h('th', { scope: 'row' }, h('span', { class: 'chip', text: e.role }), ' ', h('span', { text: e.label }), e.count > 1 ? h('span', { class: 'muted small', text: ` ×${e.count}` }) : null, e.href ? h('span', { class: 'muted small q-block', text: `→ ${e.href}` }) : null),
                          h('td', null, e.tested ? badge('passed', 'Tested') : badge('failed', 'Untested')),
                          h('td', { class: 'small' }, e.tested ? `${plural(e.interactions, 'interaction')}, ${plural(e.assertions, 'assertion')} · ${e.journeys.join(', ')}` : '—'),
                          h('td', null, p.representative ? button('Show', { small: true, kind: 'ghost', ariaLabel: `Show ${e.role} ${e.label} on the page`, onclick: () => {
                            focusKey = e.key;
                            render();
                          } }) : null),
                        ),
                      ),
                    ),
                  )
                : h('p', { class: 'ok-text' }, icon('check', { size: 14 }), h('span', { text: ' Every interactive element on this page is tested.' })),
            ),
          ),
        );
      };

      const render = () => {
        if (!data) return;
        const d = data;
        const ui = d.ui;
        const pages = ui.pages;
        if (selected && !pages.some((p) => p.route === selected)) selected = undefined;
        selected ??= pages.find((p) => p.percent < 1)?.route ?? pages[0]?.route;
        const cur = pages.find((p) => p.route === selected);
        const tr = trend;
        f.content(
          h('div', { class: 'stats q-kpis' },
            stat(d.combined.overall !== undefined ? pct(d.combined.overall) : '–', 'Overall (mean of dimensions with data)', d.combined.overall !== undefined ? (d.combined.overall >= 0.8 ? 'ok' : 'warn') : undefined),
            stat(ui.totals.elements ? pct(ui.totals.percent) : '–', `UI elements (${ui.totals.tested}/${ui.totals.elements})`, ui.totals.elements ? (ui.totals.percent >= 0.8 ? 'ok' : 'warn') : undefined),
            stat(ui.totals.pages, 'Pages seen'),
            stat(ui.unvisitedLinks.length, 'Links never visited', ui.unvisitedLinks.length ? 'warn' : 'ok'),
          ),
          card('Coverage by dimension', h('ul', { class: 'cov-dims', id: 'coverage-dimensions' }, d.combined.dimensions.map(dimTile)), { id: 'coverage-combined' }),
          card(
            'UI coverage map',
            pages.length
              ? h(
                  'div',
                  { class: 'stack' },
                  h(
                    'div',
                    { class: 'q-table-scroll' },
                    h(
                      'table',
                      { class: 'table compact', id: 'coverage-pages' },
                      h('caption', { class: 'sr-only', text: 'Pages and their UI coverage' }),
                      h('thead', null, h('tr', null, ['Page', 'Coverage', 'Tested', 'Untested', 'Journeys'].map((t) => h('th', { scope: 'col', text: t })))),
                      h(
                        'tbody',
                        null,
                        pages.map((p) =>
                          h(
                            'tr',
                            { class: p.route === selected ? 'row-active' : undefined, dataset: { route: p.route } },
                            h('th', { scope: 'row' }, h('button', { type: 'button', class: 'link-btn', 'aria-pressed': String(p.route === selected), onclick: () => {
                              selected = p.route;
                              focusKey = undefined;
                              render();
                            } }, h('code', { text: p.route })), p.title ? h('span', { class: 'muted small q-block', text: p.title }) : null),
                            h('td', null, h('div', { class: 'q-rate' }, meter(p.percent, `${p.route} UI coverage ${pct(p.percent)}`, p.percent >= 0.8 ? 'ok' : p.percent >= 0.5 ? 'warn' : 'bad'), h('span', { class: 'num small', text: pct(p.percent) }))),
                            h('td', { class: 'num', text: String(p.tested) }),
                            h('td', { class: 'num', text: String(p.total - p.tested) }),
                            h('td', { class: 'small', text: p.journeys.join(', ') }),
                          ),
                        ),
                      ),
                    ),
                  ),
                  cur ? pageDetail(cur) : null,
                )
              : h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'No DOM snapshots yet. Enable trace.timeTravel in eztest.config.yaml (or run with --time-travel) so runs record the pages they visit.' }), ...ui.warnings.map((w) => h('p', { class: 'warn-text small', text: w }))),
            { id: 'coverage-ui' },
          ),
          ui.unvisitedLinks.length
            ? card('Links to pages no journey visited', h('ul', { class: 'bullets small', id: 'coverage-unvisited' }, ui.unvisitedLinks.map((l) => h('li', null, h('code', { text: l.route }), ` — "${l.label}" on ${l.from.join(', ')}`))), { id: 'coverage-links' })
            : null,
          h(
            'div',
            { class: 'q-grid2' },
            card('UI coverage trend', tr && tr.ui.length > 1 ? lineChart([{ id: 'ui', label: 'UI coverage', slot: 1, values: tr.ui.map((p) => p.percent) }], { label: 'UI coverage per run', x: tr.ui.map((p) => relTime(p.startedAt)), xLong: tr.ui.map((p) => `${dateTime(p.startedAt)} (${p.runId}): ${p.tested}/${p.total}`), format: pct, yMax: 1 }) : h('p', { class: 'muted', text: tr?.ui.length === 1 ? `One run with snapshots so far: ${pct(tr.ui[0].percent)}.` : 'The trend appears once two runs recorded DOM snapshots.' }), { id: 'coverage-trend' }),
            card(
              'Accessibility trend',
              tr && tr.a11y.points.length
                ? h('div', { class: 'stack' },
                    tr.a11y.points.length > 1 ? lineChart([{ id: 'open', label: 'Open issues', slot: 2, values: tr.a11y.points.map((p) => p.total) }, { id: 'new', label: 'New', slot: 8, values: tr.a11y.points.map((p) => p.new) }, { id: 'fixed', label: 'Fixed', slot: 3, values: tr.a11y.points.map((p) => p.fixed) }], { label: 'Accessibility issues per run', x: tr.a11y.points.map((p) => relTime(p.startedAt)), xLong: tr.a11y.points.map((p) => `${dateTime(p.startedAt)} (${p.runId})`), format: (v) => String(Math.round(v)) }) : null,
                    tr.a11y.latest ? h('p', { class: 'small', text: `Latest scanned run: ${tr.a11y.latest.new.length} new, ${tr.a11y.latest.fixed.length} fixed, ${tr.a11y.latest.persisting.length} persisting issue(s).` }) : null,
                    tr.a11y.latest?.new.length ? h('ul', { class: 'bullets small', id: 'a11y-new' }, tr.a11y.latest.new.slice(0, 20).map((i) => h('li', null, badge('new', 'New'), ` ${i.ruleId} on `, h('code', { text: i.route }), ` (${i.component}): ${i.help}`))) : null,
                    tr.a11y.latest?.fixed.length ? h('ul', { class: 'bullets small', id: 'a11y-fixed' }, tr.a11y.latest.fixed.slice(0, 20).map((i) => h('li', null, badge('passed', 'Fixed'), ` ${i.ruleId} on `, h('code', { text: i.route }), ` (${i.component})`))) : null,
                    tr.a11y.byComponent.length ? h('table', { class: 'table compact' }, h('caption', { class: 'sr-only', text: 'Accessibility issues by component' }), h('thead', null, h('tr', null, ['Component', 'Open', 'New', 'Fixed', 'Rules'].map((t) => h('th', { scope: 'col', text: t })))), h('tbody', null, tr.a11y.byComponent.map((c) => h('tr', null, h('th', { scope: 'row', text: c.component }), h('td', { class: 'num', text: String(c.open) }), h('td', { class: 'num', text: String(c.new) }), h('td', { class: 'num', text: String(c.fixed) }), h('td', { class: 'small', text: c.rules.join(', ') }))))) : null,
                  )
                : h('p', { class: 'muted', text: 'No accessibility scans yet (add the a11y lens).' }),
              { id: 'coverage-a11y' },
            ),
          ),
          card(
            'Failure tags (latest run)',
            d.failureTags.length || d.uniqueErrors.length
              ? h('div', { class: 'stack' },
                  d.failureTags.length ? h('ul', { class: 'bullets small', id: 'failure-tags' }, d.failureTags.map((t) => h('li', null, h('code', { text: t.journeyId }), ' ', t.tags.length ? t.tags.map((x) => h('span', { class: `chip tag-${x}`, text: TAG_LABEL[x] ?? x })) : h('span', { class: 'muted', text: 'failing' }), t.failingStreak > 1 ? h('span', { class: 'muted', text: ` · failing ${t.failingStreak} runs in a row` }) : null))) : null,
                  d.uniqueErrors.length ? h('div', null, h('p', { class: 'q-label', text: 'Unique errors' }), h('ul', { class: 'bullets small', id: 'unique-errors' }, d.uniqueErrors.map((e) => h('li', null, h('strong', { text: plural(e.journeys.length, 'journey') }), `: ${e.message}`)))) : null,
                  d.latestRunId ? h('a', { class: 'small', href: link('quality', 'triage', d.latestRunId), text: 'Open the triage board' }) : null,
                )
              : h('p', { class: 'muted', text: 'No failures in the latest run.' }),
            { id: 'coverage-tags' },
          ),
        );
      };

      const load = async () => {
        if (!data) f.loading('Building the coverage map…');
        try {
          const [o, t] = await Promise.all([api.get<Overview>('/api/quality/coverage'), api.get<Trend>('/api/quality/coverage/trend').catch(() => undefined)]);
          data = o;
          trend = t;
          render();
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      untestedOnly.addEventListener('change', render);
      autoRefresh(ctx, () => void load(), []);
      return {
        show: (r) => {
          const p = r.query.get('page');
          if (p) selected = p;
          void load();
        },
        focus: () => f.heading.focus(),
      };
    },
  });
}
