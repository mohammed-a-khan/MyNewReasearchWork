/** Project › Environments: config environments, the active one, layers, and every effective value with its source (secrets masked). */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { button, card, emptyState } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, pageHeader, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface EnvView {
  active: string | null;
  overridden: boolean;
  processEnv: string | null;
  project?: string | null;
  projectOverridden?: boolean;
  processProject?: string | null;
  projects?: string[];
  environments: Array<{ name: string; files: string[] }>;
  sources: string[];
  layers: Array<{ source: string; kind: string; count: number }>;
  values: Array<{ path: string; value: unknown; source: string; kind: string; via?: string; variable?: string; secret: boolean; overridden: string[] }>;
  warnings: string[];
  sections?: Array<{ key: string; configured: boolean; sources: string[]; present: boolean }>;
  error?: string;
  masterKey: boolean;
}

function show(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export const environmentsSection: SubPageDef = {
  id: 'environments',
  title: 'Environments',
  icon: 'layers',
  description: 'Active environment, layers, value sources',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Environments', 'The configuration environments and their layers. Switch the environment used by runs from the Studio; every effective value shows the file or variable that set it. Secrets are masked.'), body));
    const load = async () => {
      const v = await withStates(body, () => api.get<EnvView>('/api/project/environments'), { retry: () => void load() });
      if (!v) return;
      const sel = h('select', { class: 'input', id: uid('env') }, h('option', { value: '', text: `Follow EZTEST_ENV${v.processEnv ? ` (${v.processEnv})` : ' (none)'}` }), v.environments.map((e) => h('option', { value: e.name, text: `${e.name} — ${e.files.join(', ')}` })));
      sel.value = v.overridden ? (v.active ?? '') : '';
      const apply = button('Use for Studio runs', { kind: 'primary', icon: 'check', id: 'env-apply', onclick: async () => {
        const name = sel.value || null;
        if (!(await confirmDialog({ title: 'Switch environment?', message: `Studio runs, the workbench and every page will use ${name ? `"${name}"` : 'EZTEST_ENV'} until you switch again or restart the Studio.`, confirm: 'Switch' }))) return;
        try {
          const r = await api.post<{ ok: boolean; error?: string; active: string | null }>('/api/project/environments/active', { name });
          if (r.ok) toast(`Active environment: ${r.active ?? 'none'}`, { kind: 'success' });
          else toastError(`Switched, but the configuration does not load: ${r.error ?? ''}`);
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      } });
      const projects = v.projects ?? [];
      const psel = h('select', { class: 'input', id: uid('project') }, h('option', { value: '', text: `Follow EZTEST_PROJECT${v.processProject ? ` (${v.processProject})` : ' (none)'}` }), projects.map((p) => h('option', { value: p, text: p })));
      psel.value = v.projectOverridden ? (v.project ?? '') : '';
      const papply = button('Use project', { kind: 'primary', icon: 'check', id: 'project-apply', onclick: async () => {
        const name = psel.value || null;
        if (!(await confirmDialog({ title: 'Switch project?', message: `Studio runs, the workbench and every page will use ${name ? `project "${name}"` : 'EZTEST_PROJECT'} until you switch again or restart the Studio.`, confirm: 'Switch' }))) return;
        try {
          const r = await api.post<{ ok: boolean; error?: string; project: string | null }>('/api/project/environments/project', { name });
          if (r.ok) toast(`Active project: ${r.project ?? 'none'}`, { kind: 'success' });
          else toastError(`Switched, but the configuration does not load: ${r.error ?? ''}`);
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      } });
      const filter = h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter keys, values or sources', 'aria-label': 'Filter effective configuration' });
      const tableHost = h('div');
      const renderTable = () => {
        const q = filter.value.trim().toLowerCase();
        const rows = v.values.filter((x) => !q || `${x.path} ${show(x.value)} ${x.source} ${x.variable ?? ''}`.toLowerCase().includes(q));
        clear(tableHost).appendChild(dataTable({
          caption: 'Effective configuration with value sources',
          rows,
          class: 'env-values',
          rowAttrs: (x) => ({ dataset: { path: x.path } }),
          columns: [
            { title: 'Key', render: (x) => h('code', { text: x.path }) },
            { title: 'Value', render: (x) => h('code', { class: x.secret ? 'secret-ref' : undefined, text: show(x.value) }) },
            { title: 'Source', render: (x) => h('span', null, sevBadge(x.kind === 'default' ? 'neutral' : x.kind === 'environment' ? 'info' : 'ok', x.kind === 'default' ? 'default' : x.source), x.variable ? h('code', { class: 'small', text: ` ${x.variable}` }) : null) },
            { title: 'How', render: (x) => h('span', { class: 'small muted', text: [x.via, x.overridden.length ? `overrides ${x.overridden.join(', ')}` : ''].filter(Boolean).join(' · ') }) },
          ],
        }));
      };
      filter.addEventListener('input', renderTable);
      renderTable();
      body.append(
        v.error ? h('p', { class: 'note note-bad', role: 'alert', text: `The configuration does not load: ${v.error}` }) : h('span'),
        projects.length ? card('Active project', h('div', { class: 'stack' },
          h('p', { class: 'row wrap' }, h('span', { text: 'Now: ' }), h('strong', { id: 'project-active', text: v.project ?? 'none (no project overlay)' }), v.projectOverridden ? sevBadge('info', 'switched in the Studio') : sevBadge('neutral', 'from EZTEST_PROJECT')),
          h('div', { class: 'row wrap' }, h('label', { for: psel.id, text: 'Project' }), psel, papply),
          h('p', { class: 'small muted', text: 'Layers: base config < projects.<name> < environment files < .env < EZTEST_* < CLI.' }))) : h('span'),
        card('Active environment', h('div', { class: 'stack' },
          h('p', { class: 'row wrap' }, h('span', { text: 'Now: ' }), h('strong', { id: 'env-active', text: v.active ?? 'none (base configuration only)' }), v.overridden ? sevBadge('info', 'switched in the Studio') : sevBadge('neutral', 'from EZTEST_ENV')),
          v.environments.length ? h('div', { class: 'row wrap' }, h('label', { for: sel.id, text: 'Environment' }), sel, apply) : emptyState('Only the base configuration', 'Add config/<name>.yaml (or .env.<name>) to define environments such as staging or prod.'),
          h('p', { class: 'small muted', text: v.masterKey ? 'EZTEST_MASTER_KEY is set: ENC(…) values are decrypted.' : 'EZTEST_MASTER_KEY is not set: ENC(…) values cannot be decrypted.' }))),
        card('Layers (lowest to highest precedence)', h('ol', { class: 'pill-list' }, v.layers.map((l) => h('li', { class: 'pill', text: `${l.source}${l.count ? ` · ${l.count} key(s)` : ''}` })))),
        v.sections?.length ? card('Configuration sections', h('ul', { class: 'pill-list', id: 'env-sections' }, v.sections.map((s) => h('li', { class: 'pill', title: s.configured ? `set in ${s.sources.join(', ')}` : 'defaults only', dataset: { section: s.key } }, sevBadge(s.configured ? 'ok' : 'neutral', s.key), h('span', { class: 'small muted', text: s.configured ? s.sources.join(', ') : s.present ? 'defaults' : 'not configured' }))))) : h('span'),
        v.warnings.length ? card('Warnings', h('ul', { class: 'bullets warn-text' }, v.warnings.map((w) => h('li', { text: w })))) : h('span'),
        card(`Effective configuration (${v.values.length} keys)`, h('div', { class: 'stack-sm' }, filter, tableHost), { id: 'env-values' }),
      );
    };
    return { show: () => void load() };
  },
};
