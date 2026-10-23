/**
 * Requirements traceability (#/quality/traceability): requirements x journeys
 * x latest status from the journeys' Requirements headers, with coverage gaps,
 * an optional requirements list (CSV or an Azure DevOps query) and CSV / XLSX /
 * HTML export.
 */
import { api } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { pct, plural, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link } from '../../core/router.js';
import { badge, button, card, stat } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { toast, toastError } from '../../ui/toast.js';
import { autoRefresh, confirmWith, meter, qualityFrame } from './common.js';

interface Matrix {
  rows: Array<{
    requirement: { id: string; title?: string; source?: string; state?: string };
    journeys: Array<{ journeyId: string; status: string; quarantined: boolean; runId?: string }>;
    coverage: string;
    gap?: string;
  }>;
  journeys: Array<{ id: string; name: string; path?: string; kind?: string }>;
  unknownRequirements: string[];
  untracedJourneys: string[];
  totals: Record<string, number> & { requirements: number; gaps: number; coveragePct: number };
  sources: Array<{ kind: string; path: string; count: number; fetchedAt?: string }>;
  warnings: string[];
}

const COVERAGE: Record<string, [string, string]> = {
  'covered-passing': ['ok', 'Covered, passing'],
  'covered-healed': ['passed-healed', 'Passing with heals'],
  'covered-failing': ['bad', 'Covered, failing'],
  'covered-quarantined': ['warn', 'Only quarantined'],
  'not-run': ['warn', 'Not run'],
  uncovered: ['bad', 'No journey'],
};

export function registerTraceabilityPage(): void {
  registerPage({
    id: 'quality-traceability',
    title: 'Traceability',
    icon: 'list',
    route: 'quality/traceability',
    group: 'quality',
    order: 240,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Requirements traceability', 'Requirements × journeys × latest status. Gaps are requirements with no journey, or only failing or quarantined ones.', { wide: true });
      const gapsOnly = h('input', { type: 'checkbox', id: uid('gaps') });
      const exp = (fmt: string, label: string) => h('a', { class: 'btn btn-sm', href: `/api/quality/traceability/export.${fmt}`, download: '', id: `trace-export-${fmt}` }, icon('import', { size: 14 }), h('span', { text: label }));
      f.toolbar.append(h('label', { class: 'check' }, gapsOnly, h('span', { text: 'Only gaps' })), exp('csv', 'CSV'), exp('xlsx', 'Excel'), exp('html', 'HTML'));
      let m: Matrix | undefined;
      let adoConfigured = false;

      const uploadCsv = async (file: File) => {
        const text = await file.text();
        const ok = await confirmWith(`Use ${file.name} as the requirements list`, h('div', { class: 'stack' }, h('p', { text: 'Saved as .eztest/requirements.csv. Requirements in it that no journey covers show up as gaps.' }), h('pre', { class: 'q-pre', text: text.split(/\r?\n/).slice(0, 8).join('\n') })), 'Save list', { size: 'md' });
        if (!ok) return;
        try {
          const r = await api.put<{ count: number }>('/api/quality/traceability/requirements', { csv: text, confirm: true });
          toast(`Loaded ${plural(r.count, 'requirement')}`, { kind: 'success' });
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      };

      const adoQuery = async () => {
        const id = uid('wiql');
        const ta = h('textarea', { id, class: 'input q-code-input', rows: 5, value: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Requirement', 'Product Backlog Item') AND [System.State] <> 'Removed'" });
        const ok = await confirmWith('Requirements from Azure DevOps', h('div', { class: 'field' }, h('label', { for: id, text: 'WIQL query' }), ta), 'Run query', { size: 'lg', validate: () => (/^\s*select\b/i.test(ta.value) ? undefined : 'Enter a WIQL SELECT query') });
        if (!ok) return;
        try {
          const r = await api.post<{ count: number }>('/api/quality/traceability/ado', { query: ta.value, confirm: true });
          toast(`Loaded ${plural(r.count, 'requirement')} from Azure DevOps`, { kind: 'success' });
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      };

      const clearLists = async () => {
        const ok = await confirmWith('Remove requirement lists', h('p', { text: 'Deletes .eztest/requirements.csv and the cached Azure DevOps results. Journey Requirements headers are unaffected.' }), 'Remove', { danger: true, size: 'sm' });
        if (!ok) return;
        await api.del('/api/quality/traceability/requirements', { confirm: true }).catch((e: Error) => toastError(e.message));
        await load();
      };

      const render = () => {
        if (!m) return;
        if (!m.rows.length && !m.journeys.length) return f.empty('No journeys yet', 'Add a Requirements: header to your journeys (e.g. "Requirements: AUTH-1, ORD-7") to trace them.');
        const rows = gapsOnly.checked ? m.rows.filter((r) => r.coverage !== 'covered-passing' && r.coverage !== 'covered-healed') : m.rows;
        const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, id: 'req-file', 'aria-label': 'Requirements CSV file', onchange: (e: Event) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) void uploadCsv(file);
          (e.target as HTMLInputElement).value = '';
        } });
        const names = new Map(m.journeys.map((j) => [j.id, j]));
        f.content(
          h(
            'div',
            { class: 'q-grid2' },
            card(
              'Coverage',
              h('div', { class: 'stack' }, h('div', { class: 'stats' }, stat(m.totals.requirements, 'Requirements'), stat(pct(m.totals.coveragePct), 'Covered by passing', m.totals.coveragePct >= 0.9 ? 'ok' : 'warn'), stat(m.totals.gaps, 'Gaps', m.totals.gaps ? 'bad' : 'ok'), stat(m.untracedJourneys.length, 'Untraced journeys')), meter(m.totals.coveragePct, `Requirements covered by passing journeys: ${pct(m.totals.coveragePct)}`, m.totals.coveragePct >= 0.9 ? 'ok' : 'warn')),
              { id: 'trace-coverage' },
            ),
            card(
              'Requirements list',
              h(
                'div',
                { class: 'stack' },
                m.sources.length ? h('ul', { class: 'bullets small' }, m.sources.map((s) => h('li', { text: `${s.kind === 'csv' ? 'CSV' : 'Azure DevOps'}: ${s.path} (${plural(s.count, 'requirement')}${s.fetchedAt ? `, fetched ${relTime(s.fetchedAt)}` : ''})` }))) : h('p', { class: 'muted small', text: 'Only requirements named in journey headers are shown. Load a list (CSV with an id column, or an Azure DevOps query) so uncovered requirements show up too.' }),
                h('div', { class: 'row wrap' }, fileInput, button('Upload CSV…', { small: true, icon: 'import', id: 'req-upload', onclick: () => fileInput.click() }), button('Azure DevOps query…', { small: true, icon: 'external', disabled: !adoConfigured, title: adoConfigured ? undefined : 'Configure ado.* in eztest.config.yaml first', onclick: () => void adoQuery() }), m.sources.length ? button('Remove lists', { small: true, kind: 'ghost', onclick: () => void clearLists() }) : null),
                ...m.warnings.map((w) => h('p', { class: 'warn-text small', text: w })),
              ),
              { id: 'trace-sources' },
            ),
          ),
          card(
            `Matrix (${plural(rows.length, 'requirement')})`,
            rows.length
              ? h(
                  'div',
                  { class: 'q-table-scroll' },
                  h(
                    'table',
                    { class: 'table', id: 'trace-table' },
                    h('caption', { class: 'sr-only', text: 'Requirements traceability matrix' }),
                    h('thead', null, h('tr', null, ['Requirement', 'Coverage', 'Journeys (latest status)', 'Gap'].map((t) => h('th', { scope: 'col', text: t })))),
                    h(
                      'tbody',
                      null,
                      rows.map((r) => {
                        const [tone, text] = COVERAGE[r.coverage] ?? ['warn', r.coverage];
                        return h(
                          'tr',
                          { dataset: { req: r.requirement.id, coverage: r.coverage } },
                          h('th', { scope: 'row' }, h('span', { class: 'mono', text: r.requirement.id }), r.requirement.title ? h('span', { class: 'muted small q-block', text: r.requirement.title }) : null),
                          h('td', null, badge(tone, text)),
                          h('td', null, r.journeys.length ? h('ul', { class: 'q-tj' }, r.journeys.map((c) => h('li', null, c.status === 'not-run' ? badge('skipped', 'Not run') : badge(c.status), ' ', names.get(c.journeyId)?.path ? h('a', { href: link('journeys', names.get(c.journeyId)!.path!), text: names.get(c.journeyId)!.name }) : h('span', { text: c.journeyId }), names.get(c.journeyId)?.kind && names.get(c.journeyId)!.kind !== 'automated' ? h('span', { class: `chip kind-${names.get(c.journeyId)!.kind}`, text: names.get(c.journeyId)!.kind === 'manual' ? 'Manual' : 'Hybrid' }) : null, c.quarantined ? h('span', { class: 'chip', text: 'quarantined' }) : null, c.runId ? h('a', { class: 'muted small', href: link('runs', c.runId), text: ' run' }) : null))) : h('span', { class: 'muted', text: 'none' })),
                          h('td', { class: 'small', text: r.gap ?? '' }),
                        );
                      }),
                    ),
                  ),
                )
              : h('p', { class: 'ok-text' }, icon('check', { size: 14 }), h('span', { text: ' No coverage gaps.' })),
            { id: 'trace-matrix' },
          ),
          m.untracedJourneys.length || m.unknownRequirements.length
            ? card(
                'Loose ends',
                h('div', { class: 'stack small' }, m.untracedJourneys.length ? h('p', null, h('strong', { text: 'Journeys with no requirement: ' }), m.untracedJourneys.map((id, i) => [i ? ', ' : '', h('code', { text: id })])) : null, m.unknownRequirements.length ? h('p', null, h('strong', { text: 'Requirement ids in journeys but not in the list: ' }), m.unknownRequirements.map((id, i) => [i ? ', ' : '', h('code', { text: id })])) : null),
              )
            : null,
        );
      };

      const load = async () => {
        if (!m) f.loading();
        try {
          const [mm, ado] = await Promise.all([api.get<Matrix>('/api/quality/traceability'), api.get<{ configured: boolean }>('/api/quality/ado/status').catch(() => ({ configured: false }))]);
          m = mm;
          adoConfigured = ado.configured;
          render();
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      gapsOnly.addEventListener('change', render);
      autoRefresh(ctx, () => void load(), ['traceability', 'quarantine']);
      return { show: () => void load(), focus: () => f.heading.focus() };
    },
  });
}

