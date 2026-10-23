/** Project › Shared data: the shared store (browse, edit, expire, delete values) and data pools (items, claims). */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { dateTime, relTime } from '../core/format.js';
import { button, card, emptyState, stat } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, field, pageHeader, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface Entry {
  namespace: string;
  key: string;
  value: unknown;
  secret?: boolean;
  pipeline?: boolean;
  expiresAt?: string;
  expired: boolean;
  updatedAt: string;
  updatedBy?: string;
  source?: { runId?: string; journeyId?: string };
}
interface Pool { namespace: string; pool: string; available: number; claimed: number; total: number }
interface StoreView {
  error?: string;
  backend?: { name: string; description: string };
  defaultNamespace?: string;
  namespaces: string[];
  entries: Entry[];
  pools: Pool[];
}
interface PoolItems { namespace: string; pool: string; items: Array<{ id: string; value: unknown; secret?: boolean; addedAt: string; addedBy?: string; claimed: boolean; claim?: { owner: string; at: string; expiresAt: number } }> }

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

async function act(fn: () => Promise<unknown>, ok: string, reload: () => Promise<void>): Promise<void> {
  try {
    await fn();
    toast(ok, { kind: 'success' });
    await reload();
  } catch (e) {
    toastError((e as Error).message);
  }
}

function editor(v: StoreView, initial: Partial<Entry> | undefined, reload: () => Promise<void>): HTMLElement {
  const ns = h('select', { class: 'input' }, v.namespaces.map((n) => h('option', { value: n, text: n, selected: n === (initial?.namespace ?? v.defaultNamespace) })));
  const key = h('input', { class: 'input mono-input', value: initial?.key ?? '', placeholder: 'pending-order', required: true });
  const value = h('textarea', { class: 'input mono-input', rows: 3, placeholder: initial?.secret ? 'enter a new secret value' : 'ORD-7 or {"id": 7}' });
  if (initial && !initial.secret) (value as HTMLTextAreaElement).value = show(initial.value);
  const jsonId = uid('json');
  const json = h('input', { type: 'checkbox', id: jsonId, checked: initial ? typeof initial.value !== 'string' : false });
  const ttl = h('input', { class: 'input', placeholder: 'e.g. 2 days, 12h (empty: never)' });
  const secretId = uid('secret');
  const secret = h('input', { type: 'checkbox', id: secretId, checked: !!initial?.secret });
  const pipeId = uid('pipe');
  const pipeline = h('input', { type: 'checkbox', id: pipeId, checked: !!initial?.pipeline });
  const save = async () => {
    await act(() => api.post('/api/project/store/save', {
      namespace: (ns as HTMLSelectElement).value, key: (key as HTMLInputElement).value, value: (value as HTMLTextAreaElement).value, json: (json as HTMLInputElement).checked,
      ttl: (ttl as HTMLInputElement).value, secret: (secret as HTMLInputElement).checked, pipeline: (pipeline as HTMLInputElement).checked,
    }), `Saved ${(key as HTMLInputElement).value}`, reload);
  };
  return h('form', { class: 'stack', id: 'store-editor', onsubmit: (e: Event) => (e.preventDefault(), void save()) },
    h('div', { class: 'form-grid' }, field('Namespace', ns), field('Key', key), field('Expires after', ttl)),
    field('Value', value, 'Text, or JSON when "JSON value" is ticked. Secret values are encrypted with EZTEST_STORE_KEY / EZTEST_MASTER_KEY and never shown again.'),
    h('div', { class: 'row wrap' },
      h('label', { class: 'check', for: jsonId }, json, h('span', { text: 'JSON value' })),
      h('label', { class: 'check', for: secretId }, secret, h('span', { text: 'Secret' })),
      h('label', { class: 'check', for: pipeId }, pipeline, h('span', { text: 'For the pipeline' }))),
    h('div', null, h('button', { type: 'submit', class: 'btn btn-primary', text: initial?.key ? 'Save changes' : 'Add value' })));
}

function poolPanel(p: Pool, reload: () => Promise<void>): { body: HTMLElement; load: () => Promise<void> } {
  const body = h('div', { class: 'stack-sm', id: `pool-${p.namespace}-${p.pool}` });
  const load = async () => {
    const r = await withStates(body, () => api.get<PoolItems>(`/api/project/store/pool?namespace=${encodeURIComponent(p.namespace)}&pool=${encodeURIComponent(p.pool)}`));
    if (!r) return;
    const add = h('textarea', { class: 'input mono-input', rows: 2, placeholder: 'One item per line' });
    body.append(
      dataTable({
        caption: `Items of pool ${p.pool}`,
        rows: r.items,
        empty: 'The pool is empty.',
        columns: [
          { title: 'Item', render: (i) => h('code', { text: show(i.value) }) },
          { title: 'Added', render: (i) => h('span', { class: 'small', text: `${relTime(i.addedAt)}${i.addedBy ? ` by ${i.addedBy}` : ''}` }) },
          { title: 'State', render: (i) => (i.claimed ? sevBadge('warn', `claimed by ${i.claim!.owner.split('@')[0]} until ${dateTime(new Date(i.claim!.expiresAt).toISOString())}`) : sevBadge('ok', 'free')) },
          {
            title: 'Actions',
            render: (i) => h('div', { class: 'row' },
              i.claimed ? button('Release', { small: true, onclick: () => void act(() => api.post('/api/project/store/pool/release', { namespace: p.namespace, pool: p.pool, id: i.id }), 'Item released', async () => (await reload(), await load())) }) : h('span'),
              button('Remove', { small: true, kind: 'danger', onclick: async () => {
                if (!(await confirmDialog({ title: 'Remove item?', message: `Remove ${show(i.value)} from pool ${p.pool}?`, confirm: 'Remove', danger: true }))) return;
                await act(() => api.post('/api/project/store/pool/remove', { namespace: p.namespace, pool: p.pool, id: i.id }), 'Item removed', async () => (await reload(), await load()));
              } })),
          },
        ],
      }),
      h('form', { class: 'row wrap', onsubmit: (e: Event) => {
        e.preventDefault();
        void act(() => api.post('/api/project/store/pool/add', { namespace: p.namespace, pool: p.pool, values: (add as HTMLTextAreaElement).value }), 'Items added', async () => (await reload(), await load()));
      } }, field('Add items', add), h('button', { type: 'submit', class: 'btn', text: 'Add' })),
    );
  };
  return { body, load };
}

export const storeSection: SubPageDef = {
  id: 'shared-data',
  title: 'Shared data',
  icon: 'database',
  description: 'Shared store values and data pools',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Shared data', 'Values journeys save to the shared store and load in other journeys, runs and pipeline stages, and the data pools whose items each journey claims once.'), body));
    let nsFilter = '';
    let editing: Partial<Entry> | undefined;
    const load = async (): Promise<void> => {
      const v = await withStates(body, () => api.get<StoreView>('/api/project/store'), { retry: () => void load() });
      if (!v) return;
      const filter = h('select', { class: 'input input-sm', 'aria-label': 'Namespace' }, h('option', { value: '', text: 'All namespaces' }), v.namespaces.map((n) => h('option', { value: n, text: n, selected: n === nsFilter })));
      filter.addEventListener('change', () => ((nsFilter = (filter as HTMLSelectElement).value), void load()));
      const rows = v.entries.filter((e) => !nsFilter || e.namespace === nsFilter);
      const expired = v.entries.filter((e) => e.expired).length;
      const editorHost = h('div');
      const openEditor = (e?: Partial<Entry>) => {
        editing = e;
        clear(editorHost).appendChild(editor(v, editing, load));
      };
      openEditor(editing);
      body.append(
        v.error ? h('p', { class: 'note note-bad', text: v.error }) : h('span'),
        h('div', { class: 'stats' }, stat(v.entries.length, 'Values'), stat(expired, 'Expired', expired ? 'warn' : undefined), stat(v.pools.length, 'Pools'), stat(v.pools.reduce((a, p) => a + p.available, 0), 'Free pool items')),
        v.backend ? h('p', { class: 'small muted', text: `Backend: ${v.backend.name} (${v.backend.description}) · default namespace ${v.defaultNamespace}` }) : h('span'),
        card('Values', h('div', { class: 'stack-sm' },
          h('div', { class: 'row wrap' }, filter, button(`Purge expired (${expired})`, { small: true, icon: 'trash', disabled: !expired, onclick: () => void act(() => api.post('/api/project/store/purge', {}), 'Expired values removed', load) })),
          rows.length
            ? dataTable({
                caption: 'Shared store values',
                rows,
                columns: [
                  { title: 'Namespace', render: (e) => e.namespace },
                  { title: 'Key', render: (e) => h('code', { text: e.key }) },
                  { title: 'Value', render: (e) => h('code', { class: e.secret ? 'muted' : '', text: show(e.value).slice(0, 120) }) },
                  { title: 'Expires', render: (e) => (e.expired ? sevBadge('warn', `expired ${relTime(e.expiresAt)}`) : e.expiresAt ? h('span', { class: 'small', text: dateTime(e.expiresAt) }) : h('span', { class: 'muted small', text: 'never' })) },
                  { title: 'Saved', render: (e) => h('span', { class: 'small', text: `${relTime(e.updatedAt)}${e.source?.journeyId ? ` by ${e.source.journeyId}` : e.updatedBy ? ` by ${e.updatedBy}` : ''}` }) },
                  { title: 'Flags', render: (e) => h('span', { class: 'row' }, e.secret ? sevBadge('info', 'secret') : h('span'), e.pipeline ? sevBadge('info', 'pipeline') : h('span')) },
                  {
                    title: 'Actions',
                    render: (e) => h('div', { class: 'row' },
                      button('Edit', { small: true, onclick: () => openEditor(e) }),
                      e.expired ? h('span') : button('Expire', { small: true, onclick: () => void act(() => api.post('/api/project/store/expire', { namespace: e.namespace, key: e.key }), `${e.key} expired`, load) }),
                      button('Delete', { small: true, kind: 'danger', onclick: async () => {
                        if (!(await confirmDialog({ title: 'Delete value?', message: `Delete "${e.key}" from namespace "${e.namespace}"? Journeys that load it will fail unless they have a default.`, confirm: 'Delete', danger: true }))) return;
                        await act(() => api.post('/api/project/store/delete', { namespace: e.namespace, key: e.key }), `${e.key} deleted`, load);
                      } })),
                  },
                ],
              })
            : emptyState('No values', 'Journeys save values with: Save ${orderId} to the shared store as "pending-order"'))),
        card(editing?.key ? `Edit ${editing.key}` : 'Add a value', editorHost, { actions: editing?.key ? button('New value', { small: true, onclick: () => openEditor(undefined) }) : undefined }),
        card('Data pools', v.pools.length
          ? h('div', { class: 'stack' }, v.pools.filter((p) => !nsFilter || p.namespace === nsFilter).map((p) => {
              // Items load when the pool is opened.
              const panel = poolPanel(p, load);
              let loaded = false;
              const d = h('details', { class: 'stack-sm' },
                h('summary', null, h('strong', { text: p.pool }), h('span', { class: 'muted small', text: ` ${p.namespace} · ${p.available} free, ${p.claimed} claimed, ${p.total} total` })),
                panel.body);
              d.addEventListener('toggle', () => {
                if ((d as HTMLDetailsElement).open && !loaded) (loaded = true), void panel.load();
              });
              return d;
            }))
          : emptyState('No data pools', 'Add items with: Add ${policy} to pool "approvable-policies", or seed one from a data file (store.pools.<name>.from).')),
      );
    };
    return { show: () => void load() };
  },
};
