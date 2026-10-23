/**
 * The Quality Center: a "Quality" group in the activity bar (heal review,
 * triage, flaky and quarantine, readiness, traceability, compare, trends),
 * palette commands, a run-detail tab with "N heals to review", and a dashboard
 * card. Server side: `routes/quality-*.ts`.
 */
import { h } from '../../core/dom.js';
import { plural } from '../../core/format.js';
import { api } from '../../core/api.js';
import { registerCommand, registerDashboardCard, registerRunDetailTab } from '../../core/registry.js';
import { link, navigate } from '../../core/router.js';
import { button, card, stat } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { registerComparePage } from './compare.js';
import { qualitySummary, startQualitySummary, type QualitySummary } from './common.js';
import { registerFlakyPage } from './flaky.js';
import { registerHealInbox } from './heals.js';
import { registerReadinessPage } from './readiness.js';
import { registerTraceabilityPage } from './traceability.js';
import { registerTriageBoard } from './triage.js';
import { registerTrendsPage } from './trends.js';
import { registerCoveragePage } from './coverage.js';
import { registerDeploymentsPage } from './deployments.js';

const go = (...seg: string[]) => () => navigate(link('quality', ...seg));

export function registerQualityCenter(): void {
  registerHealInbox();
  registerTriageBoard();
  registerFlakyPage();
  registerReadinessPage();
  registerTraceabilityPage();
  registerComparePage();
  registerTrendsPage();
  registerCoveragePage();
  registerDeploymentsPage();

  const cmd = (id: string, title: string, run: () => void, keywords: string[] = [], ic: Parameters<typeof icon>[0] = 'shield') => registerCommand({ id: `quality.${id}`, title, group: 'Quality', icon: ic, keywords, run });
  cmd('heals', 'Review heals', go('heals'), ['heal', 'inbox', 'locator', 'accept', 'reject'], 'heal');
  cmd('triage', 'Open the triage board', go('triage'), ['failures', 'bugs', 'classification', 'ado'], 'shield');
  cmd('flaky', 'Flaky tests and quarantine', go('flaky'), ['quarantine', 'flip rate'], 'activity');
  cmd('readiness', 'Release readiness and sign-off', go('readiness'), ['go', 'no go', 'policy', 'sign off'], 'check');
  cmd('traceability', 'Requirements traceability matrix', go('traceability'), ['requirements', 'coverage', 'export', 'xlsx'], 'list');
  cmd('compare', 'Compare two runs', go('compare'), ['diff', 'regression'], 'convert');
  cmd('trends', 'Quality trends and analytics', go('trends'), ['pass rate', 'heal rate', 'duration'], 'insights');
  cmd('coverage', 'Coverage: UI map, requirements, API, risk, change', go('coverage'), ['ui coverage', 'untested', 'heat map', 'accessibility trend'], 'target');
  cmd('deployments', 'Deployments: what was tested where, per version', go('deployments'), ['environment', 'release', 'pipeline', 'version'], 'target');

  // Run detail: a "Quality" tab linking the run into every Quality Center view.
  registerRunDetailTab({
    id: 'quality',
    title: 'Quality',
    order: 45,
    badge: (d) => {
      const n = qualitySummary.get()?.pendingByRun[d.run.runId] ?? 0;
      return n ? `${n} heal${n === 1 ? '' : 's'} to review` : undefined;
    },
    mount(el, d) {
      const id = d.run.runId;
      const s = d.run.summary;
      const pending = qualitySummary.get()?.pendingByRun[id] ?? 0;
      const row = (ic: Parameters<typeof icon>[0], title: string, text: string, href: string, label: string) =>
        h('li', { class: 'q-link-row' }, icon(ic, { size: 16 }), h('div', null, h('strong', { text: title }), h('p', { class: 'muted small', text })), h('a', { class: 'btn btn-sm', href, text: label }));
      el.append(
        h(
          'ul',
          { class: 'q-links' },
          row('heal', 'Heal review', pending ? `${plural(pending, 'verified heal')} from this run to accept or reject` : s.passedHealed ? 'Heals from this run were already reviewed' : 'No heals in this run', `${link('quality', 'heals')}?run=${encodeURIComponent(id)}`, 'Review heals'),
          row('shield', 'Triage board', s.failed + s.errors ? `${plural(s.failed + s.errors, 'failure')} clustered by signature` : 'No failures', link('quality', 'triage', id), 'Open triage'),
          row('check', 'Release readiness', 'Decision, gates, what would make it GO, sign-off', link('quality', 'readiness', id), 'Open readiness'),
          row('convert', 'Compare', 'Changes against the previous run', `${link('quality', 'compare')}?b=${encodeURIComponent(id)}`, 'Compare'),
        ),
      );
    },
  });

  registerDashboardCard({
    id: 'quality',
    order: 50,
    async render() {
      const s = await api.get<QualitySummary>('/api/quality/summary').catch(() => qualitySummary.get());
      if (s) qualitySummary.set(s);
      return card(
        'Quality Center',
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'stats' },
            stat(s?.pendingHeals ?? '–', 'Heals to review', s?.pendingHeals ? 'heal' : undefined),
            stat(s?.latestRun?.failed ?? '–', 'Failures in last run', s?.latestRun?.failed ? 'bad' : 'ok'),
            stat(s?.quarantine.active ?? '–', 'Quarantined', s?.quarantine.expiringSoon || s?.quarantine.expired ? 'warn' : undefined),
          ),
          s?.quarantine.expired ? h('p', { class: 'warn-text small' }, icon('clock', { size: 12 }), ` ${plural(s.quarantine.expired, 'quarantine')} expired`) : null,
          h(
            'div',
            { class: 'row wrap' },
            button('Review heals', { small: true, icon: 'heal', kind: s?.pendingHeals ? 'primary' : 'default', onclick: go('heals') }),
            button('Triage', { small: true, icon: 'shield', onclick: go('triage') }),
            button('Readiness', { small: true, icon: 'check', onclick: go('readiness') }),
            button('Flaky', { small: true, icon: 'activity', onclick: go('flaky') }),
          ),
        ),
        { id: 'dash-quality', class: 'span-2' },
      );
    },
  });

  startQualitySummary();
}
