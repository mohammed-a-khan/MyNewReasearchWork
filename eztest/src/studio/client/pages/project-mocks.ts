/**
 * Project › Mocks: mock stores, interactions with editable responses, fault
 * toggles (latency, error status, corrupt body, drop), replay servers, drift
 * detection against the real target (as a role).
 */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { relTime } from '../core/format.js';
import { button, card, emptyState } from '../ui/badge.js';
import { confirmDialog, promptDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, field, pageHeader, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface StoreItem {
  path: string;
  recordings?: number;
  target?: string;
  updatedAt?: string;
  running?: boolean;
  faults?: number;
  error?: string;
}

interface Interaction {
  id: string;
  request: { method: string; path: string; query: string; headers: Record<string, string> };
  response: { status: number; headers: Record<string, string>; delayMs?: number; body: { text: string; truncated: boolean; binary: boolean }; bodyEncoding: string };
  recordedAt: string;
}

interface Fault {
  id?: number;
  enabled: boolean;
  method: string;
  path: string;
  latencyMs?: number;
  status?: number;
  corruptBody?: boolean;
  drop?: boolean;
  probability?: number;
}

interface StoreView {
  path: string;
  target?: string;
  updatedAt: string;
  recordings: Interaction[];
  faults: Fault[];
  server?: { url: string; startedAt: string; stats: Record<string, number>; faults: number };
}

interface Drift {
  ok: boolean;
  target: string;
  checked: number;
  drifted: number;
  errors: number;
  skippedNonGet: number;
  results: Array<{ id: string; method: string; path: string; outcome: string; differences: Array<{ path: string; kind: string; expected?: string; actual?: string }>; error?: string }>;
}

function editor(store: StoreView, rec: Interaction, onSaved: (v: StoreView) => void): HTMLElement {
  const status = h('input', { class: 'input', type: 'number', min: '100', max: '599', value: String(rec.response.status) });
  const delay = h('input', { class: 'input', type: 'number', min: '0', value: String(rec.response.delayMs ?? '') });
  const headers = h('textarea', { class: 'input mono-input', rows: 4, value: JSON.stringify(rec.response.headers, null, 2) });
  const body = h('textarea', { class: 'input wb-textarea', spellcheck: 'false', value: rec.response.body.text, disabled: rec.response.body.binary || rec.response.body.truncated });
  const save = async () => {
    let hdrs: Record<string, string>;
    try {
      hdrs = JSON.parse(headers.value);
    } catch {
      toastError('Headers must be a JSON object');
      return;
    }
    if (!(await confirmDialog({ title: 'Save the response?', message: `Overwrite the recorded response of ${rec.request.method} ${rec.request.path} in ${store.path}?`, confirm: 'Save' }))) return;
    try {
      const v = await api.put<StoreView>('/api/project/mocks/recording', { path: store.path, id: rec.id, response: { status: Number(status.value), delayMs: delay.value === '' ? undefined : Number(delay.value), headers: hdrs, ...(body.disabled ? {} : { body: body.value }) } });
      toast('Response saved', { kind: 'success' });
      onSaved(v);
    } catch (e) {
      toastError((e as Error).message);
    }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: 'Delete the interaction?', message: `Remove ${rec.request.method} ${rec.request.path} from ${store.path}?`, confirm: 'Delete', danger: true }))) return;
    try {
      onSaved(await api.del<StoreView>('/api/project/mocks/recording', { path: store.path, id: rec.id }));
    } catch (e) {
      toastError((e as Error).message);
    }
  };
  return h('div', { class: 'stack', id: 'mock-editor' },
    h('h3', { class: 'h3' }, h('code', { text: `${rec.request.method} ${rec.request.path}${rec.request.query ? `?${rec.request.query}` : ''}` })),
    h('div', { class: 'form-grid' }, field('Status', status), field('Extra latency (ms)', delay)),
    field('Response headers (JSON)', headers),
    field(rec.response.body.binary ? 'Body (binary, not editable)' : 'Response body', body),
    h('div', { class: 'row' }, button('Save response', { kind: 'primary', icon: 'save', onclick: () => void save() }), button('Delete', { kind: 'danger', icon: 'trash', onclick: () => void del() })));
}

function faultsEditor(store: StoreView, onSaved: (v: StoreView) => void): HTMLElement {
  const rules: Fault[] = store.faults.map((f) => ({ ...f }));
  const host = h('div', { class: 'stack-sm' });
  const render = () => {
    clear(host).append(
      dataTable<Fault>({
        caption: 'Fault rules',
        rows: rules,
        empty: 'No fault rules. Add one to inject latency, errors or dropped connections when replaying.',
        columns: [
          { title: 'On', render: (f) => h('input', { type: 'checkbox', checked: f.enabled, 'aria-label': `Rule ${rules.indexOf(f) + 1} enabled`, onchange: (e: Event) => (f.enabled = (e.target as HTMLInputElement).checked) }) },
          { title: 'Method', render: (f) => h('input', { class: 'input input-sm', value: f.method, size: 5, 'aria-label': `Rule ${rules.indexOf(f) + 1} method`, oninput: (e: Event) => (f.method = (e.target as HTMLInputElement).value) }) },
          { title: 'Path (glob)', render: (f) => h('input', { class: 'input input-sm mono-input', value: f.path, 'aria-label': `Rule ${rules.indexOf(f) + 1} path`, oninput: (e: Event) => (f.path = (e.target as HTMLInputElement).value) }) },
          { title: 'Latency ms', render: (f) => h('input', { class: 'input input-sm', type: 'number', min: '0', value: f.latencyMs ?? '', 'aria-label': `Rule ${rules.indexOf(f) + 1} latency`, oninput: (e: Event) => (f.latencyMs = (e.target as HTMLInputElement).value === '' ? undefined : Number((e.target as HTMLInputElement).value)) }) },
          { title: 'Status', render: (f) => h('input', { class: 'input input-sm', type: 'number', min: '100', max: '599', value: f.status ?? '', 'aria-label': `Rule ${rules.indexOf(f) + 1} error status`, oninput: (e: Event) => (f.status = (e.target as HTMLInputElement).value === '' ? undefined : Number((e.target as HTMLInputElement).value)) }) },
          { title: 'Corrupt', render: (f) => h('input', { type: 'checkbox', checked: !!f.corruptBody, 'aria-label': `Rule ${rules.indexOf(f) + 1} corrupt body`, onchange: (e: Event) => (f.corruptBody = (e.target as HTMLInputElement).checked) }) },
          { title: 'Drop', render: (f) => h('input', { type: 'checkbox', checked: !!f.drop, 'aria-label': `Rule ${rules.indexOf(f) + 1} drop connection`, onchange: (e: Event) => (f.drop = (e.target as HTMLInputElement).checked) }) },
          { title: 'Probability', render: (f) => h('input', { class: 'input input-sm', type: 'number', min: '0', max: '1', step: '0.05', value: f.probability ?? 1, 'aria-label': `Rule ${rules.indexOf(f) + 1} probability`, oninput: (e: Event) => (f.probability = Number((e.target as HTMLInputElement).value)) }) },
          { title: 'Remove', srOnly: true, render: (f) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove rule ${rules.indexOf(f) + 1}`, onclick: () => (rules.splice(rules.indexOf(f), 1), render()) }, '×') },
        ],
      }),
      h('div', { class: 'row' },
        button('Add rule', { small: true, icon: 'plus', onclick: () => (rules.push({ enabled: true, method: '*', path: '/api/**', latencyMs: 1500, probability: 1 }), render()) }),
        button('Save faults', { small: true, kind: 'primary', icon: 'save', onclick: async () => {
          if (!(await confirmDialog({ title: 'Save fault rules?', message: `Write ${rules.length} rule(s) next to ${store.path}? They apply the next time a replay server starts.`, confirm: 'Save' }))) return;
          try {
            onSaved(await api.put<StoreView>('/api/project/mocks/faults', { path: store.path, rules }));
            toast('Fault rules saved', { kind: 'success' });
          } catch (e) {
            toastError((e as Error).message);
          }
        } })),
    );
  };
  render();
  return host;
}

function storeDetail(el: HTMLElement, path: string, roles: string[], reloadList: () => void): void {
  let selected: string | undefined;
  const render = (v: StoreView) => {
    const recList = h('div');
    const edit = h('div');
    const select = (rec: Interaction) => {
      selected = rec.id;
      clear(edit).appendChild(editor(v, rec, (nv) => render(nv)));
      for (const r of recList.querySelectorAll('tr')) r.classList.toggle('row-active', r.dataset.id === rec.id);
    };
    recList.appendChild(dataTable<Interaction>({
      caption: 'Recorded interactions',
      rows: v.recordings,
      empty: 'No interactions yet: capture some from the target below.',
      rowAttrs: (r) => ({ dataset: { id: r.id } }),
      columns: [
        { title: 'Request', render: (r) => h('code', { text: `${r.request.method} ${r.request.path}${r.request.query ? `?${r.request.query}` : ''}` }) },
        { title: 'Status', render: (r) => sevBadge(r.response.status < 400 ? 'ok' : 'fail', String(r.response.status)) },
        { title: 'Latency', render: (r) => (r.response.delayMs ? `${r.response.delayMs} ms` : '') },
        { title: 'Recorded', render: (r) => relTime(r.recordedAt) },
        { title: 'Edit', srOnly: true, render: (r) => button('Edit', { small: true, icon: 'edit', onclick: () => select(r), ariaLabel: `Edit ${r.request.method} ${r.request.path}` }) },
      ],
    }));
    // Server
    const port = h('input', { class: 'input input-sm', type: 'number', min: '0', max: '65535', placeholder: 'auto', 'aria-label': 'Port (empty: any free port)' });
    const serverBox = v.server
      ? h('div', { class: 'stack-sm', id: 'mock-server' }, h('p', { class: 'row wrap' }, sevBadge('ok', 'running'), h('code', { text: v.server.url }), h('span', { class: 'muted', text: `since ${relTime(v.server.startedAt)} · ${v.server.faults} fault rule(s) · ${Object.entries(v.server.stats).map(([k, n]) => `${k} ${n}`).join(', ')}` })),
          button('Stop replay server', { kind: 'danger', icon: 'stop', onclick: async () => {
            try {
              render(await api.del<StoreView>('/api/project/mocks/server', { path: v.path }));
              reloadList();
            } catch (e) {
              toastError((e as Error).message);
            }
          } }))
      : h('div', { class: 'row wrap', id: 'mock-server' }, sevBadge('neutral', 'stopped'), port, button('Start replay server', { kind: 'primary', icon: 'run', disabled: !v.recordings.length, onclick: async () => {
          try {
            render(await api.post<StoreView>('/api/project/mocks/server', { path: v.path, port: port.value }));
            reloadList();
          } catch (e) {
            toastError((e as Error).message);
          }
        } }));
    // Drift + capture
    const target = h('input', { class: 'input mono-input', value: v.target ?? '', placeholder: 'https://api.example.com (default: store target or baseUrl)' });
    const roleSel = h('select', { class: 'input' }, h('option', { value: '', text: 'No auth' }), roles.map((r) => h('option', { value: r, text: `as ${r}` })));
    const paths = h('textarea', { class: 'input mono-input', rows: 3, placeholder: '/api/customers\n/api/orders' });
    const driftOut = h('div', { 'aria-live': 'polite', id: 'mock-drift' });
    const runDrift = async () => {
      const r = await withStates(driftOut, () => api.post<Drift>('/api/project/mocks/drift', { path: v.path, target: target.value || undefined, role: roleSel.value || undefined }), { loading: 'Re-sending recorded GETs to the target…' });
      if (!r) return;
      driftOut.append(
        h('p', { class: 'row wrap' }, sevBadge(r.ok ? 'pass' : 'drift', r.ok ? 'No drift' : `${r.drifted} drifted`), h('span', { class: 'muted', text: `${r.checked} checked against ${r.target}, ${r.errors} error(s), ${r.skippedNonGet} non-GET skipped` })),
        dataTable({
          caption: 'Drift results',
          rows: r.results,
          rowAttrs: (x) => ({ class: x.outcome === 'ok' ? 'row-ok' : 'row-bad' }),
          columns: [
            { title: 'Request', render: (x) => h('code', { text: `${x.method} ${x.path}` }) },
            { title: 'Outcome', render: (x) => sevBadge(x.outcome === 'ok' ? 'ok' : x.outcome === 'drift' ? 'drift' : 'fail', x.outcome) },
            { title: 'Differences (recorded → live)', render: (x) => (x.error ? h('span', { class: 'bad-text', text: x.error }) : x.differences.length ? h('ul', { class: 'bullets' }, x.differences.map((d) => h('li', null, h('code', { text: d.path }), ` ${d.kind}${d.expected !== undefined ? `: ${d.expected} → ${d.actual ?? '(missing)'}` : ''}`))) : h('span', { class: 'muted', text: 'same shape' })) },
          ],
        }),
      );
    };
    const capture = async () => {
      const list = paths.value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (!list.length) {
        toastError('Give at least one path to capture');
        return;
      }
      try {
        const r = await api.post<{ captured: Array<{ path: string; status: number }>; store: StoreView }>('/api/project/mocks/capture', { path: v.path, target: target.value || undefined, role: roleSel.value || undefined, paths: list });
        toast(`Captured ${r.captured.length} interaction(s)`, { kind: 'success' });
        render(r.store);
        reloadList();
      } catch (e) {
        toastError((e as Error).message);
      }
    };
    clear(el).append(
      h('div', { class: 'row-between' }, h('h2', { class: 'h3' }, h('code', { text: v.path }))),
      card('Interactions', h('div', { class: 'two-col' }, recList, edit)),
      card('Faults', faultsEditor(v, (nv) => render(nv))),
      card('Replay server', serverBox),
      card('Target: capture and drift', h('div', { class: 'stack' },
        h('div', { class: 'form-grid' }, field('Target URL', target), field('Auth', roleSel)),
        h('div', { class: 'two-col' },
          h('div', { class: 'stack-sm' }, field('Capture GET paths into the store', paths), button('Capture', { icon: 'record', onclick: () => void capture() })),
          h('div', { class: 'stack-sm' }, h('p', { class: 'help', text: 'Drift re-sends every recorded GET to the target and compares status, content type and JSON shape. Non-GET recordings are never re-sent.' }), button('Run drift detection', { kind: 'primary', icon: 'activity', onclick: () => void runDrift() }))),
        driftOut)),
    );
    const sel = v.recordings.find((r) => r.id === selected) ?? v.recordings[0];
    if (sel) select(sel);
  };
  void withStates(el, () => api.get<StoreView>(`/api/project/mocks/store?path=${encodeURIComponent(path)}`)).then((v) => v && render(v));
}

export const mocksSection: SubPageDef = {
  id: 'mocks',
  title: 'Mocks',
  icon: 'server',
  description: 'Stores, faults, replay, drift',
  mount(root) {
    const list = h('div');
    const detail = h('div', { class: 'stack' });
    const newBtn = button('New store', { icon: 'plus', onclick: async () => {
      const p = await promptDialog({ title: 'New mock store', label: 'Path in the project', value: 'mocks/shop-api.json', help: 'A JSON file; capture interactions into it from the target afterwards.' });
      if (!p) return;
      try {
        await api.post('/api/project/mocks/store', { path: p });
        selected = p;
        await load();
      } catch (e) {
        toastError((e as Error).message);
      }
    } });
    root.appendChild(h('div', { class: 'page-inner stack' }, pageHeader('Mocks', 'Recorded service virtualization: browse and edit interactions, inject faults, replay on a local port, detect drift against the real service.', newBtn), list, detail));
    let selected: string | undefined;
    let roles: string[] = [];
    const load = async () => {
      const r = await withStates(list, () => api.get<{ stores: StoreItem[] }>('/api/project/mocks'), { retry: () => void load() });
      if (!r) return;
      try {
        roles = (await api.get<{ roles: Array<{ name: string; api: boolean }> }>('/api/workbench/context')).roles.filter((x) => x.api).map((x) => x.name);
      } catch {
        roles = [];
      }
      if (!r.stores.length) {
        list.appendChild(emptyState('No mock stores', 'Create one, then capture GET interactions from the target (or record with "eztest mock record").', newBtn.cloneNode(true) as HTMLElement));
        clear(detail);
        return;
      }
      const cur = r.stores.find((s) => s.path === selected) ?? r.stores[0];
      selected = cur.path;
      const id = uid('store');
      const sel = h('select', { class: 'input', id, onchange: () => ((selected = sel.value), storeDetail(detail, sel.value, roles, () => void load())) }, r.stores.map((s) => h('option', { value: s.path, text: `${s.path} · ${s.recordings ?? 0} interaction(s)${s.running ? ' · replaying' : ''}${s.faults ? ` · ${s.faults} fault(s)` : ''}`, selected: s.path === cur.path })));
      list.appendChild(h('div', { class: 'row wrap' }, h('label', { for: id, text: 'Store' }), sel));
      storeDetail(detail, cur.path, roles, () => void load());
    };
    return { show: () => void load() };
  },
};

