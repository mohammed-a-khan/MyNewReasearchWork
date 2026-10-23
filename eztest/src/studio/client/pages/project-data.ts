/** Project › Test data: needs per journey, entities and providers, leases (release stale), seeded synthetic preview with masking. */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { dateTime } from '../core/format.js';
import { button, card, emptyState } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, field, pageHeader, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface DataView {
  error?: string;
  seed: string | number;
  leaseDir: string;
  leaseTtlSeconds?: number;
  journeys: Array<{ journeyId: string; name: string; needs: Array<{ as: string; entity: string; where: string; strategy: string; declared: boolean }>; provider: string[] }>;
  parseErrors: Array<{ file: string; message: string }>;
  entities: Array<{ name: string; provider: string; connection?: string; table?: string; key: string; columns: Record<string, string> }>;
  providers: Array<{ kind: string; name: string; entities: string[] }>;
  leases: Array<{ file: string; resource?: string; owner?: string; acquiredAt?: number; expiresAt?: number; stale: boolean; unreadable?: boolean }>;
  generators: string[];
}

function previewCard(v: DataView): HTMLElement {
  const rows: Array<{ name: string; gen: string; mask: string }> = [
    { name: 'name', gen: 'fullName', mask: '' }, { name: 'email', gen: 'email', mask: 'email' }, { name: 'phone', gen: 'phone', mask: 'partial' },
    { name: 'card', gen: 'card:visa', mask: 'partial' }, { name: 'iban', gen: 'iban:DE', mask: 'partial' }, { name: 'city', gen: 'city', mask: '' },
  ];
  const synthetic = v.entities.filter((e) => Object.keys(e.columns).length);
  const entitySel = h('select', { class: 'input' }, h('option', { value: '', text: 'Custom fields (below)' }), synthetic.map((e) => h('option', { value: e.name, text: `${e.name} (${e.provider})` })));
  const seed = h('input', { class: 'input', value: String(v.seed), 'aria-describedby': undefined });
  const count = h('input', { class: 'input', type: 'number', min: '1', max: '50', value: '8' });
  const editor = h('div', { class: 'kv-editor' });
  const listId = uid('gens');
  const renderEditor = () => {
    clear(editor).appendChild(h('datalist', { id: listId }, v.generators.map((g) => h('option', { value: g }))));
    rows.forEach((r, i) => {
      editor.appendChild(h('div', { class: 'kv-row' },
        h('span', { class: 'small muted', text: String(i + 1) }),
        h('input', { class: 'input input-sm mono-input', value: r.name, 'aria-label': `Field ${i + 1} name`, oninput: (e: Event) => (r.name = (e.target as HTMLInputElement).value) }),
        h('div', { class: 'row' },
          h('input', { class: 'input input-sm mono-input', value: r.gen, list: listId, 'aria-label': `Field ${i + 1} generator`, oninput: (e: Event) => (r.gen = (e.target as HTMLInputElement).value) }),
          h('select', { class: 'input input-sm', 'aria-label': `Field ${i + 1} mask`, onchange: (e: Event) => (r.mask = (e.target as HTMLSelectElement).value) }, [['', 'no mask'], ['partial', 'partial'], ['email', 'email'], ['hash', 'hash'], ['redact', 'redact'], ['null', 'null']].map(([val, t]) => h('option', { value: val, text: t, selected: r.mask === val })))),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove field ${i + 1}`, onclick: () => (rows.splice(i, 1), renderEditor()) }, '×')));
    });
    editor.appendChild(h('div', null, button('Add field', { small: true, icon: 'plus', onclick: () => (rows.push({ name: `field${rows.length + 1}`, gen: 'company', mask: '' }), renderEditor()) })));
  };
  renderEditor();
  entitySel.addEventListener('change', () => (editor.hidden = !!entitySel.value));
  const out = h('div', { 'aria-live': 'polite' });
  const run = async () => {
    const body: Record<string, unknown> = { count: Number(count.value), seed: /^\d+$/.test(seed.value) ? Number(seed.value) : seed.value };
    if (entitySel.value) body.entity = entitySel.value;
    else {
      body.fields = Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.name, r.gen]));
      body.masks = Object.fromEntries(rows.filter((r) => r.name && r.mask).map((r) => [r.name, r.mask]));
    }
    const r = await withStates(out, () => api.post<{ rows: Array<Record<string, unknown>>; masked: Array<Record<string, unknown>>; fields: Record<string, string> }>('/api/project/data/preview', body));
    if (!r) return;
    const cols = Object.keys(r.fields);
    const table = (caption: string, data: Array<Record<string, unknown>>, id: string) => h('div', { id }, h('h3', { class: 'h3', text: caption }), dataTable({ caption, rows: data, columns: cols.map((c) => ({ title: c, render: (x: Record<string, unknown>) => (x[c] === null ? h('span', { class: 'muted', text: 'null' }) : h('code', { text: String(x[c]) })) })) }));
    out.append(h('p', { class: 'small muted', text: 'Same seed, same records: re-run with the seed to reproduce a failure. Card numbers pass Luhn, IBANs pass mod-97.' }), h('div', { class: 'two-col' }, table('Generated', r.rows, 'data-raw'), table('Masked view', r.masked, 'data-masked')));
  };
  return card('Synthetic data preview', h('form', { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), void run()) },
    h('div', { class: 'form-grid' }, field('Entity', entitySel), field('Seed', seed), field('Records', count)),
    editor,
    h('div', null, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Generate preview' })),
    out), { id: 'data-preview' });
}

export const dataSection: SubPageDef = {
  id: 'data',
  title: 'Test data',
  icon: 'database',
  description: 'Needs, providers, leases, synthetic preview',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Test data', 'What each journey needs, which provider serves it, the records leased right now and a deterministic synthetic preview with masking.'), body));
    const load = async () => {
      const v = await withStates(body, () => api.get<DataView>('/api/project/data'), { retry: () => void load() });
      if (!v) return;
      const stale = v.leases.filter((l) => l.stale).length;
      const release = button(`Release stale leases (${stale})`, { icon: 'trash', kind: 'danger', disabled: !stale, id: 'release-stale', onclick: async () => {
        if (!(await confirmDialog({ title: 'Release stale leases?', message: `Delete ${stale} expired lease file(s) in ${v.leaseDir}? Active leases are kept.`, confirm: 'Release', danger: true }))) return;
        try {
          const r = await api.post<{ released: string[] }>('/api/project/data/leases/release-stale', {});
          toast(`${r.released.length} stale lease(s) released`, { kind: 'success' });
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      } });
      body.append(
        v.error ? h('p', { class: 'note note-bad', text: v.error }) : h('span'),
        card('Data needs per journey', v.journeys.some((j) => j.needs.length)
          ? dataTable({
              caption: 'Data needs per journey',
              rows: v.journeys.flatMap((j) => j.needs.map((n, i) => ({ j, n, p: j.provider[i] }))),
              columns: [
                { title: 'Journey', render: (x) => h('strong', { text: x.j.name }) },
                { title: 'Alias', render: (x) => h('code', { text: x.n.as }) },
                { title: 'Entity', render: (x) => x.n.entity },
                { title: 'Constraints', render: (x) => h('code', { text: x.n.where || '(any)' }) },
                { title: 'Strategy', render: (x) => x.n.strategy },
                { title: 'Provider', render: (x) => sevBadge(x.p === 'unmapped' ? 'warn' : 'ok', x.p) },
              ],
            })
          : emptyState('No data needs', `None of the ${v.journeys.length} journeys declares data (e.g. "Given a Customer as buyer where region=EU").`)),
        h('div', { class: 'two-col' },
          card('Entities and providers', v.entities.length ? dataTable({ caption: 'Entities', rows: v.entities, columns: [{ title: 'Entity', render: (e) => h('strong', { text: e.name }) }, { title: 'Provider', render: (e) => `${e.provider}${e.connection ? `:${e.connection}` : ''}` }, { title: 'Table / key', render: (e) => `${e.table ?? '—'} / ${e.key}` }] }) : emptyState('No entities', 'Map entities to SQL, API or synthetic providers under data.entities.')),
          card('Leases', h('div', { class: 'stack-sm' }, h('p', { class: 'small muted', text: `${v.leaseDir} · lifetime ${v.leaseTtlSeconds ?? '?'} s` }), dataTable({
            caption: 'Leases',
            rows: v.leases,
            empty: 'No leases: no record is reserved right now.',
            columns: [
              { title: 'Resource', render: (l) => h('code', { text: l.resource ?? l.file }) },
              { title: 'Owner', render: (l) => h('span', { class: 'small', text: l.owner ?? '' }) },
              { title: 'Expires', render: (l) => (l.expiresAt ? dateTime(new Date(l.expiresAt).toISOString()) : '') },
              { title: 'State', render: (l) => sevBadge(l.stale ? 'warn' : 'ok', l.unreadable ? 'unreadable' : l.stale ? 'stale' : 'active') },
            ],
          }), release), { id: 'leases' })),
        previewCard(v),
      );
    };
    return { show: () => void load() };
  },
};
