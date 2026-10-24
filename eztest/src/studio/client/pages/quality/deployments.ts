/**
 * Deployments (#/quality/deployments): what was tested in each environment for
 * each version, from the deployment test records `eztest run --pipeline`
 * keeps (results server or local runs): a version x environment matrix and
 * the records with their selection, results, readiness and evidence links.
 */
import { api } from '../../core/api.js';
import { h, uid } from '../../core/dom.js';
import { dateTime, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link } from '../../core/router.js';
import { card } from '../../ui/badge.js';
import { qualityFrame } from './common.js';

interface Rec {
  id: string;
  recordedAt?: string;
  recordedBy?: string;
  environment: string;
  version: string;
  pipeline: string;
  runId?: string;
  ci?: { system: string; stage?: string; url?: string; commit?: string; branch?: string };
  selection: { journeys: string[]; total: number; tags?: string };
  results: { total: number; passed: number; passedHealed: number; failed: number; skipped: number; errors: number };
  readiness?: { decision: string; score?: number; failingGates?: string[] };
  evidence?: { runUrl?: string; reportUrl?: string; buildUrl?: string; testRunUrl?: string };
  testPlan?: { planId?: number; testRunId?: number };
}
interface View {
  source: string;
  error?: string;
  environments: string[];
  versions: string[];
  matrix: Record<string, Record<string, Pick<Rec, 'id' | 'recordedAt' | 'pipeline' | 'runId' | 'results' | 'readiness'>>>;
  records: Rec[];
}

const verdict = (r: Pick<Rec, 'readiness' | 'results'>) => r.readiness?.decision ?? (r.results.failed + r.results.errors ? 'FAILED' : 'PASSED');
const tone = (v: string) => (v === 'GO' || v === 'PASSED' ? 'ok' : v === 'GO_WITH_RISKS' ? 'warn' : 'bad');
const chip = (v: string) => h('span', { class: `sev sev-${tone(v)}`, text: v.replace(/_/g, ' ') });

function matrix(v: View): HTMLElement {
  return h('div', { class: 'q-table-scroll' }, h('table', { class: 'table compact', id: 'deployments-matrix' },
    h('caption', { class: 'sr-only', text: 'Latest deployment test per version and environment' }),
    h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Version' }), v.environments.map((e) => h('th', { scope: 'col', text: e })))),
    h('tbody', null, v.versions.map((ver) => h('tr', null, h('th', { scope: 'row' }, h('code', { text: ver })), v.environments.map((env) => {
      const c = v.matrix[ver]?.[env];
      if (!c) return h('td', { class: 'muted', text: 'not tested' });
      const r = c.results;
      return h('td', null, chip(verdict(c)), h('div', { class: 'small muted', text: `${r.passed + r.passedHealed}/${r.total} passed · ${c.pipeline} · ${relTime(c.recordedAt)}` }),
        c.runId ? h('a', { class: 'small', href: link('runs', c.runId), text: 'run' }) : null);
    }))))));
}

export function registerDeploymentsPage(): void {
  registerPage({
    id: 'quality-deployments',
    title: 'Deployments',
    icon: 'target',
    route: 'quality/deployments',
    group: 'quality',
    order: 270,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Deployments', 'What was tested in each environment for each version: the journeys a deployment pipeline ran, their results, the readiness verdict and the evidence.', { wide: true });
      const envSel = h('select', { id: uid('env'), class: 'input input-sm' }, h('option', { value: '', text: 'All environments' }));
      f.toolbar.append(h('div', { class: 'q-inline-field' }, h('label', { for: envSel.id, text: 'Environment' }), envSel));
      const load = async () => {
        f.loading();
        let v: View;
        try {
          const env = (envSel as HTMLSelectElement).value;
          v = await api.get<View>(`/api/quality/deployments${env ? `?environment=${encodeURIComponent(env)}` : ''}`);
        } catch (e) {
          f.error((e as Error).message, () => void load());
          return;
        }
        if (envSel.childElementCount === 1) for (const e of v.environments) envSel.appendChild(h('option', { value: e, text: e }));
        if (v.error) return f.error(v.error, () => void load());
        if (!v.records.length) return f.empty('No deployment tests yet', 'Run a deployment pipeline: eztest run --pipeline deploy-sit (a pipelines: entry with an environment). Records come from the results server when one is configured, else from local runs.');
        f.body.removeAttribute('aria-busy');
        f.body.replaceChildren(
          h('p', { class: 'small muted', text: `Source: ${v.source}` }),
          card('Versions by environment', matrix(v)),
          card('Deployment test records', h('div', { class: 'q-table-scroll' }, h('table', { class: 'table compact', id: 'deployments-records' },
            h('caption', { class: 'sr-only', text: 'Deployment test records' }),
            h('thead', null, h('tr', null, ['When', 'Environment', 'Version', 'Pipeline', 'Verdict', 'Results', 'Selection', 'Evidence'].map((t) => h('th', { scope: 'col', text: t })))),
            h('tbody', null, v.records.map((r) => h('tr', null,
              h('td', { class: 'small', text: dateTime(r.recordedAt) }),
              h('td', { text: r.environment }),
              h('td', null, h('code', { text: r.version })),
              h('td', { text: `${r.pipeline}${r.ci?.stage ? ` (${r.ci.system} ${r.ci.stage})` : ''}` }),
              h('td', null, chip(verdict(r)), r.readiness?.failingGates?.length ? h('div', { class: 'small bad-text', text: r.readiness.failingGates.join(', ') }) : null),
              h('td', { class: 'small', text: `${r.results.passed + r.results.passedHealed}/${r.results.total} passed${r.results.failed + r.results.errors ? `, ${r.results.failed + r.results.errors} failed` : ''}` }),
              h('td', { class: 'small', text: `${r.selection.total} journeys${r.selection.tags ? ` · ${r.selection.tags}` : ''}` }),
              h('td', { class: 'small' },
                r.runId ? h('a', { href: link('runs', r.runId), text: 'run' }) : null, ' ',
                r.evidence?.buildUrl ? h('a', { href: r.evidence.buildUrl, target: '_blank', rel: 'noopener', text: 'build' }) : null, ' ',
                r.evidence?.testRunUrl ? h('a', { href: r.evidence.testRunUrl, target: '_blank', rel: 'noopener', text: 'test run' }) : null, ' ',
                r.evidence?.runUrl ? h('a', { href: r.evidence.runUrl, target: '_blank', rel: 'noopener', text: 'server' }) : null),
            )))))),
        );
      };
      envSel.addEventListener('change', () => void load());
      void load();
    },
  });
}
