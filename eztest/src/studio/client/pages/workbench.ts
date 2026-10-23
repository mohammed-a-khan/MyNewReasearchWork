/**
 * API & DB workbench (`#/workbench`): compose REST, GraphQL and SOAP requests
 * with environments and variables, authenticate as a configured role (the
 * token is resolved on the server and never shown), inspect the response,
 * test JSONPath expressions and validate JSON Schemas; run parameterized SQL
 * read-only by default (SQLite, PostgreSQL, SQL Server and Oracle); pick and
 * run named queries from the catalogue (db.queries); and turn a request or
 * query into a validated .ez step inserted into a journey.
 */
import { api, ApiError } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { ms } from '../core/format.js';
import { registerPage } from '../core/registry.js';
import { registerShortcut } from '../core/keys.js';
import { link, navigate } from '../core/router.js';
import { refreshJourneys } from '../core/state.js';
import { button, copyText, emptyState } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { createTabs } from '../ui/tabs.js';
import { toast, toastError } from '../ui/toast.js';
import { codeBlock, dataTable, download, errorState, field, fmtBytes, loadingState, pageHeader, sevBadge, toCsv } from './assurance-ui.js';

type Kind = 'rest' | 'graphql' | 'soap' | 'sql' | 'query';

interface CatalogueEntry {
  name: string;
  connection: string | null;
  description: string;
  fragment: boolean;
  source: string;
  params: Array<{ name: string; type: string; default?: unknown }>;
  sql: string;
}

interface Pair {
  name: string;
  value: string;
  enabled: boolean;
}

interface WbState {
  kind: Kind;
  method: string;
  url: string;
  headers: Pair[];
  query: Pair[];
  bodyType: 'none' | 'json' | 'text' | 'form';
  body: string;
  graphql: { query: string; variables: string; operationName: string };
  soap: { version: '1.1' | '1.2'; action: string; body: string };
  role: string;
  variables: Pair[];
  sql: { connection: string; sql: string; params: string };
  jsonAsserts: Array<{ path: string; value: string }>;
  history: Array<{ kind: Kind; method: string; url: string; at: string }>;
}

interface Context {
  environment: string | null;
  environments: string[];
  baseUrl?: string;
  roles: Array<{ name: string; api: boolean }>;
  connections: Array<{ name: string; driver: string }>;
  journeys: Array<{ path: string; name: string }>;
  writesEnabled: boolean;
  error?: string;
}

interface SendResult {
  ok: boolean;
  error?: string;
  status?: number;
  statusText?: string;
  durationMs: number;
  size?: number;
  headers?: Record<string, string>;
  contentType?: string;
  text?: string;
  truncated?: boolean;
  json?: unknown;
  soap?: unknown;
  request: { method: string; url: string; headers?: Record<string, string>; kind?: string };
}

interface SqlResult {
  kind: 'read' | 'write';
  enforced?: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
  rowsAffected?: number;
  truncated?: boolean;
  durationMs: number;
}

const STORE_KEY = 'ez.workbench.v1';

function defaults(): WbState {
  return {
    kind: 'rest', method: 'GET', url: '/api/customers', headers: [{ name: 'accept', value: 'application/json', enabled: true }], query: [], bodyType: 'json', body: '',
    graphql: { query: '{\n  __typename\n}', variables: '', operationName: '' }, soap: { version: '1.1', action: '', body: '' }, role: '', variables: [{ name: 'id', value: '1', enabled: true }],
    sql: { connection: '', sql: 'SELECT id, name, region FROM customers ORDER BY id', params: '' }, jsonAsserts: [], history: [],
  };
}

function load(): WbState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...defaults(), ...(JSON.parse(raw) as Partial<WbState>) };
  } catch {
    // storage disabled
  }
  return defaults();
}

function pairEditor(label: string, list: Pair[], onChange: () => void): HTMLElement {
  const host = h('div', { class: 'kv-editor', role: 'group', 'aria-label': label });
  const render = () => {
    clear(host);
    list.forEach((p, i) => {
      const en = h('input', { type: 'checkbox', checked: p.enabled, 'aria-label': `${label} ${i + 1} enabled`, onchange: () => ((p.enabled = en.checked), onChange()) });
      const name = h('input', { class: 'input input-sm mono-input', value: p.name, placeholder: 'name', 'aria-label': `${label} ${i + 1} name`, oninput: () => ((p.name = name.value), onChange()) });
      const value = h('input', { class: 'input input-sm mono-input', value: p.value, placeholder: 'value ({{variable}} allowed)', 'aria-label': `${label} ${i + 1} value`, oninput: () => ((p.value = value.value), onChange()) });
      host.appendChild(h('div', { class: 'kv-row' }, en, name, value, h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${label} ${i + 1}`, onclick: () => (list.splice(i, 1), onChange(), render()) }, icon('trash', { size: 14 }))));
    });
    host.appendChild(h('div', null, button(`Add ${label.toLowerCase()}`, { small: true, icon: 'plus', onclick: () => (list.push({ name: '', value: '', enabled: true }), onChange(), render()) })));
  };
  render();
  return host;
}

function statusClass(n: number | undefined): string {
  return n ? `status-${String(n)[0]}xx` : '';
}

export function registerWorkbenchPage(): void {
  registerPage({
    id: 'workbench',
    title: 'Workbench',
    icon: 'workbench',
    route: 'workbench',
    order: 58,
    mount(ctx) {
      ctx.root.classList.add('page-scroll');
      const st = load();
      const save = () => {
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify({ ...st, history: st.history.slice(0, 20) }));
        } catch {
          // storage disabled
        }
      };
      let context: Context | undefined;
      let lastResponse: SendResult | undefined;
      let lastSql: SqlResult | undefined;
      const inner = h('div', { class: 'page-inner' });
      ctx.root.appendChild(inner);

      // ---------------------------------------------------------- top bar
      const envSel = h('select', { class: 'input input-sm', id: 'wb-env' });
      const roleSel = h('select', { class: 'input input-sm', id: 'wb-role', onchange: () => ((st.role = roleSel.value), save()) });
      const baseInfo = h('span', { class: 'small muted', id: 'wb-base' });
      envSel.addEventListener('change', async () => {
        const name = envSel.value || null;
        if (!(await confirmDialog({ title: 'Switch environment?', message: `Use ${name ? `"${name}"` : 'the default environment'} for Studio runs, the workbench and every page in this Studio session?`, confirm: 'Switch' }))) {
          envSel.value = context?.environment ?? '';
          return;
        }
        try {
          const r = await api.post<{ ok: boolean; error?: string }>('/api/project/environments/active', { name });
          if (!r.ok) toastError(`The environment does not load: ${r.error ?? ''}`);
          else toast(`Environment: ${name ?? 'default'}`, { kind: 'success' });
          await refreshContext();
        } catch (e) {
          toastError((e as Error).message);
        }
      });

      const refreshContext = async () => {
        context = await api.get<Context>('/api/workbench/context');
        clear(envSel).append(h('option', { value: '', text: 'default (EZTEST_ENV)' }), ...context.environments.map((e) => h('option', { value: e, text: e })));
        envSel.value = context.environment ?? '';
        clear(roleSel).append(h('option', { value: '', text: 'No auth' }), ...context.roles.map((r) => h('option', { value: r.name, text: r.api ? `as ${r.name}` : `${r.name} (no API credentials)`, disabled: !r.api })));
        roleSel.value = context.roles.some((r) => r.name === st.role && r.api) ? st.role : '';
        baseInfo.textContent = context.baseUrl ? `Base URL ${context.baseUrl}` : 'No baseUrl configured: use full URLs';
        clear(connSel).append(...(context.connections.length ? context.connections.map((c) => h('option', { value: c.name, text: `${c.name} (${c.driver})` })) : [h('option', { value: '', text: 'No connections configured' })]));
        connSel.value = context.connections.some((c) => c.name === st.sql.connection) ? st.sql.connection : (context.connections[0]?.name ?? '');
        st.sql.connection = connSel.value;
        writes = context.writesEnabled;
        renderWriteMode();
      };

      // ---------------------------------------------------------- REST composer
      const methodSel = h('select', { class: 'input', 'aria-label': 'HTTP method', onchange: () => ((st.method = methodSel.value), save()) }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => h('option', { value: m, text: m })));
      methodSel.value = st.method;
      const urlInput = h('input', { class: 'input mono-input', id: 'wb-url', value: st.url, placeholder: '/api/orders/{{id}} or https://…', 'aria-label': 'Request URL', oninput: () => ((st.url = urlInput.value), save()) });
      const sendBtn = button('Send', { kind: 'primary', icon: 'send', id: 'wb-send', onclick: () => void send(), title: 'Send (Ctrl+Enter)' });
      const stepBtn = button('Save as step', { icon: 'save', id: 'wb-save-step', onclick: () => void saveAsStep(st.kind) });
      const bodyTypeSel = h('select', { class: 'input input-sm', 'aria-label': 'Body type', onchange: () => ((st.bodyType = bodyTypeSel.value as WbState['bodyType']), save()) }, [['none', 'No body'], ['json', 'JSON'], ['text', 'Text'], ['form', 'Form (a=1&b=2)']].map(([v, t]) => h('option', { value: v, text: t })));
      bodyTypeSel.value = st.bodyType;
      const bodyTa = h('textarea', { class: 'input wb-textarea', spellcheck: 'false', value: st.body, 'aria-label': 'Request body', oninput: () => ((st.body = bodyTa.value), save()) });
      const restTabs = createTabs({
        label: 'Request',
        tabs: [
          { id: 'params', title: 'Params', mount: (p) => p.append(pairEditor('Query parameter', st.query, save)) },
          { id: 'headers', title: 'Headers', mount: (p) => p.append(pairEditor('Header', st.headers, save), h('p', { class: 'help', text: 'Authorization comes from the role picked above; it is added on the server.' })) },
          { id: 'body', title: 'Body', mount: (p) => p.append(h('div', { class: 'stack-sm' }, bodyTypeSel, bodyTa)) },
          { id: 'vars', title: 'Variables', mount: (p) => p.append(pairEditor('Variable', st.variables, save), h('p', { class: 'help', text: 'Use {{name}} or ${name} in the URL, headers and body. {{baseUrl}} is the configured base URL.' })) },
        ],
        class: 'card',
      });

      // ---------------------------------------------------------- GraphQL / SOAP
      const gqlQuery = h('textarea', { class: 'input wb-textarea', spellcheck: 'false', value: st.graphql.query, 'aria-label': 'GraphQL query', oninput: () => ((st.graphql.query = gqlQuery.value), save()) });
      const gqlVars = h('textarea', { class: 'input wb-textarea', rows: 4, spellcheck: 'false', value: st.graphql.variables, placeholder: '{ "id": 1 }', 'aria-label': 'GraphQL variables (JSON)', oninput: () => ((st.graphql.variables = gqlVars.value), save()) });
      const gqlOp = h('input', { class: 'input mono-input', value: st.graphql.operationName, 'aria-label': 'Operation name', oninput: () => ((st.graphql.operationName = gqlOp.value), save()) });
      const soapVer = h('select', { class: 'input', 'aria-label': 'SOAP version', onchange: () => ((st.soap.version = soapVer.value as '1.1' | '1.2'), save()) }, ['1.1', '1.2'].map((v) => h('option', { value: v, text: `SOAP ${v}` })));
      soapVer.value = st.soap.version;
      const soapAction = h('input', { class: 'input mono-input', value: st.soap.action, 'aria-label': 'SOAPAction', placeholder: 'urn:GetOrder', oninput: () => ((st.soap.action = soapAction.value), save()) });
      const soapBody = h('textarea', { class: 'input wb-textarea', spellcheck: 'false', value: st.soap.body, 'aria-label': 'SOAP body or full envelope', placeholder: '<tns:GetOrder xmlns:tns="urn:shop"><id>1</id></tns:GetOrder>', oninput: () => ((st.soap.body = soapBody.value), save()) });

      // ---------------------------------------------------------- response
      const respHost = h('div', { class: 'card', id: 'wb-response', 'aria-live': 'polite' });
      const renderResponse = () => {
        clear(respHost);
        const r = lastResponse;
        if (!r) {
          respHost.appendChild(h('div', { class: 'card-body' }, emptyState('No response yet', 'Compose a request and press Send (Ctrl+Enter).')));
          return;
        }
        if (!r.ok) {
          respHost.appendChild(h('div', { class: 'card-body' }, errorState(new Error(r.error ?? 'Request failed'))));
          return;
        }
        const pretty = r.json !== undefined ? JSON.stringify(r.json, null, 2) : r.text ?? '';
        const jpInput = h('input', { class: 'input mono-input', id: 'wb-jsonpath', value: '$[0].name', 'aria-label': 'JSONPath expression' });
        const jpOut = h('div', { 'aria-live': 'polite' });
        const evalPath = async () => {
          try {
            const res = await api.post<{ values: unknown[]; count: number; ledgerPath?: string }>('/api/workbench/jsonpath', { data: r.json ?? r.text, path: jpInput.value });
            clear(jpOut).append(
              h('p', { class: 'small muted', text: `${res.count} match(es)${res.ledgerPath !== undefined ? ` · step path: response.body${res.ledgerPath ? `.${res.ledgerPath}` : ''}` : ' · not usable in a step (wildcards)'}` }),
              codeBlock(JSON.stringify(res.values.length === 1 ? res.values[0] : res.values, null, 2), { label: 'JSONPath result', id: 'wb-jsonpath-result' }),
              res.count === 1 && res.ledgerPath !== undefined && (typeof res.values[0] !== 'object' || res.values[0] === null)
                ? button('Add as assertion', { small: true, icon: 'plus', onclick: () => {
                    st.jsonAsserts.push({ path: jpInput.value, value: String(res.values[0]) });
                    save();
                    toast(`Assertion added: ${jpInput.value} = ${String(res.values[0])}`);
                  } })
                : h('span'),
            );
          } catch (e) {
            clear(jpOut).appendChild(h('p', { class: 'bad-text', text: (e as Error).message }));
          }
        };
        const schemaTa = h('textarea', { class: 'input wb-textarea', rows: 8, spellcheck: 'false', 'aria-label': 'JSON Schema', placeholder: '{ "type": "array", "items": { "type": "object", "required": ["id"] } }' });
        const schemaOut = h('div', { 'aria-live': 'polite' });
        const validate = async () => {
          try {
            const res = await api.post<{ valid: boolean; errors: string[] }>('/api/workbench/schema', { data: r.json ?? r.text, schema: schemaTa.value });
            clear(schemaOut).append(sevBadge(res.valid ? 'pass' : 'fail', res.valid ? 'Valid' : `${res.errors.length} error(s)`), res.errors.length ? h('ul', { class: 'bullets bad-text' }, res.errors.map((x) => h('li', { text: x }))) : h('span'));
          } catch (e) {
            clear(schemaOut).appendChild(h('p', { class: 'bad-text', text: (e as Error).message }));
          }
        };
        const tabs = createTabs({
          label: 'Response',
          tabs: [
            { id: 'body', title: 'Body', mount: (p) => p.append(codeBlock(pretty, { label: 'Response body', tall: true, id: 'wb-body' }), r.truncated ? h('p', { class: 'small warn-text', text: 'Truncated to 2 MB.' }) : h('span')) },
            { id: 'headers', title: 'Headers', badge: Object.keys(r.headers ?? {}).length, mount: (p) => p.append(dataTable({ caption: 'Response headers', rows: Object.entries(r.headers ?? {}), columns: [{ title: 'Header', render: ([k]) => h('code', { text: k }) }, { title: 'Value', render: ([, v]) => h('code', { text: v }) }] })) },
            { id: 'jsonpath', title: 'JSONPath', mount: (p) => p.append(h('form', { class: 'row', onsubmit: (e: Event) => (e.preventDefault(), void evalPath()) }, jpInput, h('button', { type: 'submit', class: 'btn btn-sm', text: 'Evaluate' })), jpOut) },
            { id: 'schema', title: 'Schema', mount: (p) => p.append(h('div', { class: 'stack-sm' }, schemaTa, button('Validate', { small: true, icon: 'check', onclick: () => void validate() }), schemaOut)) },
            { id: 'request', title: 'Request', mount: (p) => p.append(h('p', null, h('code', { text: `${r.request.method} ${r.request.url}` })), dataTable({ caption: 'Request headers', rows: Object.entries(r.request.headers ?? {}), columns: [{ title: 'Header', render: ([k]) => h('code', { text: k }) }, { title: 'Value', render: ([, v]) => h('code', { text: v }) }] })) },
          ],
        });
        respHost.append(
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Response' }), h('div', { class: 'resp-meta' }, h('span', { class: ['status-code', statusClass(r.status)], id: 'wb-status', text: `${r.status} ${r.statusText ?? ''}` }), h('span', { class: 'muted', text: ms(r.durationMs) }), h('span', { class: 'muted', text: fmtBytes(r.size) }), button('Download', { small: true, icon: 'download', onclick: () => download(`response.${r.json !== undefined ? 'json' : 'txt'}`, pretty, r.contentType || 'text/plain') }))),
          h('div', { class: 'card-body' }, tabs.el),
        );
      };

      const send = async () => {
        const kind = st.kind === 'sql' ? 'rest' : st.kind;
        const body = {
          kind, method: st.method, url: st.url, headers: st.headers, query: st.query, bodyType: st.bodyType, body: st.body, role: st.role || undefined,
          variables: Object.fromEntries(st.variables.filter((v) => v.enabled && v.name).map((v) => [v.name, v.value])), graphql: st.graphql, soap: st.soap,
        };
        sendBtn.disabled = true;
        clear(respHost).appendChild(h('div', { class: 'card-body' }, loadingState('Sending…')));
        try {
          lastResponse = await api.post<SendResult>('/api/workbench/send', body);
          st.history = [{ kind, method: kind === 'rest' ? st.method : 'POST', url: st.url, at: new Date().toISOString() }, ...st.history.filter((x) => !(x.url === st.url && x.method === st.method))].slice(0, 20);
          save();
          renderHistory();
        } catch (e) {
          lastResponse = { ok: false, error: (e as Error).message, durationMs: 0, request: { method: st.method, url: st.url } };
        } finally {
          sendBtn.disabled = false;
        }
        renderResponse();
      };

      // ---------------------------------------------------------- SQL console
      const connSel = h('select', { class: 'input', id: 'wb-conn', onchange: () => ((st.sql.connection = connSel.value), save()) });
      const sqlTa = h('textarea', { class: 'input wb-textarea', id: 'wb-sql', spellcheck: 'false', value: st.sql.sql, 'aria-label': 'SQL statement', oninput: () => ((st.sql.sql = sqlTa.value), save()) });
      const sqlParams = h('input', { class: 'input mono-input', id: 'wb-sql-params', value: st.sql.params, placeholder: '["EU", 100]', oninput: () => ((st.sql.params = sqlParams.value), save()) });
      let writes = false;
      const modeBadge = h('span', { class: 'readonly-badge ro', id: 'wb-sql-mode' });
      const writeToggleId = uid('writes');
      const writeToggle = h('input', { type: 'checkbox', id: writeToggleId });
      const renderWriteMode = () => {
        writeToggle.checked = writes;
        modeBadge.className = `readonly-badge ${writes ? 'rw' : 'ro'}`;
        clear(modeBadge).append(icon(writes ? 'unlock' : 'lock', { size: 12 }), h('span', { text: writes ? 'Writes allowed (each confirmed)' : 'Read-only' }));
      };
      writeToggle.addEventListener('change', async () => {
        if (writeToggle.checked) {
          const ok = await confirmDialog({ title: 'Allow writes?', message: 'INSERT, UPDATE, DELETE and DDL statements will run against the selected connection for this Studio session. Each write still asks for confirmation.', confirm: 'Allow writes', danger: true });
          if (!ok) return renderWriteMode();
        }
        try {
          const r = await api.post<{ writesEnabled: boolean }>('/api/workbench/sql/mode', { allowWrites: writeToggle.checked, confirm: true });
          writes = r.writesEnabled;
        } catch (e) {
          toastError((e as Error).message);
        }
        renderWriteMode();
      });
      const sqlOut = h('div', { class: 'stack-sm', id: 'wb-sql-result', 'aria-live': 'polite' });
      const runSql = async (confirm = false) => {
        let params: unknown[] = [];
        if (st.sql.params.trim()) {
          try {
            params = JSON.parse(st.sql.params);
            if (!Array.isArray(params)) throw new Error('not an array');
          } catch {
            toastError('Parameters must be a JSON array, e.g. ["EU", 100]');
            return;
          }
        }
        clear(sqlOut).appendChild(loadingState('Running…'));
        try {
          lastSql = await api.post<SqlResult>('/api/workbench/sql', { connection: st.sql.connection, sql: st.sql.sql, params, confirm });
          renderSql();
        } catch (e) {
          const err = e as ApiError;
          if (err instanceof ApiError && err.status === 409 && err.body.confirm) {
            clear(sqlOut);
            if (await confirmDialog({ title: 'Run this write?', message: h('div', null, h('p', { text: `This statement changes data (${String(err.body.reason ?? 'write')}).` }), codeBlock(st.sql.sql)), confirm: 'Run write', danger: true })) await runSql(true);
            return;
          }
          clear(sqlOut).appendChild(h('div', { class: ['note', err instanceof ApiError && err.status === 403 ? 'note-warn' : 'note-bad'], role: 'alert', id: 'wb-sql-error' }, h('strong', { text: err instanceof ApiError && err.status === 403 ? 'Blocked. ' : 'Error. ' }), err.message));
        }
      };
      const renderSql = () => {
        const r = lastSql;
        clear(sqlOut);
        if (!r) return;
        if (r.kind === 'write') {
          sqlOut.appendChild(h('p', { class: 'note note-warn', text: `${r.rowsAffected ?? 0} row(s) affected in ${ms(r.durationMs)}.` }));
          return;
        }
        sqlOut.append(
          h('div', { class: 'row-between' }, h('p', { class: 'small muted', id: 'wb-sql-count', text: `${r.rowCount} row(s) in ${ms(r.durationMs)}${r.truncated ? ' (first 1000 shown)' : ''} · ${r.enforced ?? ''}` }), h('div', { class: 'row' }, button('Export CSV', { small: true, icon: 'download', onclick: () => download('query.csv', toCsv(r.columns, r.rows), 'text/csv') }), button('Export JSON', { small: true, icon: 'download', onclick: () => download('query.json', JSON.stringify(r.rows, null, 2), 'application/json') }))),
          r.rows.length ? h('div', { class: 'grid-results' }, dataTable({ caption: 'Query result', rows: r.rows, columns: r.columns.map((c) => ({ title: c, render: (row: Record<string, unknown>) => (row[c] === null ? h('span', { class: 'muted', text: 'NULL' }) : typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c])) })) })) : emptyState('No rows', 'The query returned no rows.'),
        );
      };

      // ---------------------------------------------------------- Queries (named-query catalogue)
      let catalogue: CatalogueEntry[] = [];
      let picked: { name: string; connection: string; binds: Record<string, string>; defaults: Record<string, string> } | undefined;
      /** Values the user set (blank and unchanged defaults are left to the query's header). */
      const chosenBinds = () => (picked ? Object.fromEntries(Object.entries(picked.binds).filter(([k, x]) => x !== '' && x !== picked!.defaults[k])) : undefined);
      const qList = h('ul', { class: 'stack-sm wb-query-list', id: 'wb-queries-list', 'aria-label': 'Catalogue queries' });
      const qForm = h('div', { class: 'stack-sm', id: 'wb-query-form' });
      const qFilter = h('input', { class: 'input input-sm', id: 'wb-queries-filter', placeholder: 'Filter by name, connection or description', 'aria-label': 'Filter queries', oninput: () => renderCatalogue() });
      const qInfo = h('p', { class: 'small muted', id: 'wb-queries-info' });
      const loadCatalogue = async () => {
        clear(qList).appendChild(h('li', null, loadingState('Loading queries…')));
        try {
          const r = await api.get<{ dir: string; queries: CatalogueEntry[] }>('/api/workbench/queries');
          catalogue = r.queries.filter((q) => !q.fragment);
          qInfo.textContent = `${catalogue.length} quer${catalogue.length === 1 ? 'y' : 'ies'} from ${r.dir}/ and db.queries.inline`;
          renderCatalogue();
        } catch (e) {
          clear(qList).appendChild(h('li', { class: 'note note-bad', role: 'alert', text: (e as Error).message }));
        }
      };
      const renderCatalogue = () => {
        const f = qFilter.value.trim().toLowerCase();
        const shown = catalogue.filter((q) => !f || `${q.name} ${q.connection ?? ''} ${q.description}`.toLowerCase().includes(f));
        clear(qList);
        if (!shown.length) {
          qList.appendChild(h('li', null, emptyState('No queries', catalogue.length ? 'Nothing matches the filter.' : 'Add queries/NAME.sql files or db.queries.inline to the configuration.')));
          return;
        }
        for (const q of shown.slice(0, 200)) {
          qList.appendChild(h('li', { class: ['wb-query', picked?.name === q.name ? 'selected' : ''] },
            h('button', { type: 'button', class: 'link-btn mono', 'data-query': q.name, onclick: () => pickQuery(q) }, q.name),
            h('span', { class: 'small muted', text: ` ${q.connection ? `on ${q.connection}` : 'no connection header'}${q.params.length ? ` · ${q.params.map((x) => x.name).join(', ')}` : ''}${q.description ? ` · ${q.description}` : ''}` })));
        }
      };
      const pickQuery = (q: CatalogueEntry) => {
        const conn = q.connection ?? connSel.value;
        const defaults = Object.fromEntries(q.params.map((x) => [x.name, x.default === undefined || x.default === null ? '' : String(x.default)]));
        picked = { name: q.name, connection: conn, binds: { ...defaults }, defaults };
        renderCatalogue();
        clear(qForm).append(
          h('h3', { class: 'h3', text: q.name }),
          q.description ? h('p', { class: 'small', text: q.description }) : '',
          codeBlock(q.sql),
          h('div', { class: 'form-grid' },
            ...q.params.map((x) => {
              const inp = h('input', { class: 'input input-sm mono-input', value: picked!.binds[x.name], 'data-param': x.name, placeholder: x.default !== undefined ? `default ${String(x.default)}` : x.type === 'any' ? 'value or ${var}' : x.type, oninput: () => (picked!.binds[x.name] = inp.value) });
              return field(`:${x.name}${x.type !== 'any' ? ` (${x.type})` : ''}`, inp);
            })),
          h('p', { class: 'help', text: 'Values are bound as parameters, never spliced into the SQL. Use ${name} for workbench variables.' }),
          h('div', { class: 'row' }, button('Run query', { kind: 'primary', icon: 'run', id: 'wb-query-run', onclick: () => void runQuery() }), button('Save as step', { icon: 'save', id: 'wb-query-save-step', onclick: () => void saveAsStep('query') })),
        );
      };
      const runQuery = async (confirm = false) => {
        if (!picked) return;
        clear(sqlOut).appendChild(loadingState('Running…'));
        const variables = Object.fromEntries(st.variables.filter((x) => x.enabled && x.name).map((x) => [x.name, x.value]));
        try {
          lastSql = await api.post<SqlResult>('/api/workbench/queries/run', { name: picked.name, connection: picked.connection, binds: chosenBinds(), variables, confirm });
          renderSql();
        } catch (e) {
          const err = e as ApiError;
          if (err instanceof ApiError && err.status === 409 && err.body.confirm) {
            clear(sqlOut);
            if (await confirmDialog({ title: 'Run this write?', message: `Query "${picked.name}" changes data (${String(err.body.reason ?? 'write')}).`, confirm: 'Run write', danger: true })) await runQuery(true);
            return;
          }
          clear(sqlOut).appendChild(h('div', { class: ['note', err instanceof ApiError && err.status === 403 ? 'note-warn' : 'note-bad'], role: 'alert', id: 'wb-sql-error' }, h('strong', { text: err instanceof ApiError && err.status === 403 ? 'Blocked. ' : 'Error. ' }), err.message));
        }
      };
      const queriesPanel = h('details', { class: 'card wb-queries', id: 'wb-queries', ontoggle: () => (queriesPanel.open && !catalogue.length ? void loadCatalogue() : undefined) },
        h('summary', null, h('strong', { text: 'Queries' }), h('span', { class: 'small muted', text: ' named-query catalogue (db.queries)' })),
        h('div', { class: 'stack-sm' }, h('div', { class: 'row-between' }, qFilter, button('Reload', { small: true, icon: 'refresh', onclick: () => void loadCatalogue() })), qInfo, qList, qForm),
      );

      // ---------------------------------------------------------- save as step
      const saveAsStep = async (kind: Kind) => {
        if (!context?.journeys.length) {
          toastError('No .ez journey to insert into');
          return;
        }
        const capture = h('input', { class: 'input mono-input', value: kind === 'sql' || kind === 'query' ? 'rows' : 'response' });
        const asserts: Array<{ type: string; label: string; path?: string; value: string; on: boolean }> = [];
        if (kind === 'sql' || kind === 'query') {
          if (lastSql?.kind === 'read') asserts.push({ type: 'rows', label: `returns ${lastSql.rowCount} rows`, value: String(lastSql.rowCount), on: true });
        } else {
          if (lastResponse?.ok && lastResponse.status) asserts.push({ type: 'status', label: `status is ${lastResponse.status}`, value: String(lastResponse.status), on: true });
          for (const a of st.jsonAsserts) asserts.push({ type: 'jsonpath', label: `${a.path} equals "${a.value}"`, path: a.path, value: a.value, on: true });
        }
        const journeySel = h('select', { class: 'input' }, context.journeys.map((j) => h('option', { value: j.path, text: `${j.name} (${j.path})` })));
        const preview = h('pre', { class: 'step-preview', id: 'wb-step-preview', 'aria-live': 'polite' });
        const status = h('div', { 'aria-live': 'polite' });
        let lines: string[] = [];
        const req = () => ({
          kind, method: st.method, url: st.url, headers: st.headers.filter((x) => x.enabled && x.name && !['accept', 'content-type'].includes(x.name.toLowerCase())), bodyType: st.bodyType, body: st.body, role: st.role || undefined, graphql: st.graphql,
          connection: kind === 'query' ? (picked?.connection ?? '') : st.sql.connection, sql: st.sql.sql, params: kind !== 'query' && st.sql.params.trim() ? JSON.parse(st.sql.params) : undefined,
          query: picked?.name, binds: chosenBinds(),
          captureAs: capture.value, assertions: asserts.filter((a) => a.on).map((a) => ({ type: a.type, path: a.path, value: a.value })),
        });
        const refresh = async () => {
          try {
            const r = await api.post<{ lines: string[]; ok: boolean; errors: Array<{ message: string }> }>('/api/workbench/step', req());
            lines = r.lines;
            preview.textContent = r.lines.join('\n');
            clear(status).appendChild(r.ok ? h('p', { class: 'ok-text', text: 'These steps validate against the EZTest grammar.' }) : h('p', { class: 'bad-text', text: r.errors.map((e) => e.message).join('; ') }));
          } catch (e) {
            lines = [];
            preview.textContent = '';
            clear(status).appendChild(h('p', { class: 'bad-text', role: 'alert', text: (e as Error).message }));
          }
        };
        capture.addEventListener('input', () => void refresh());
        const assertBox = h('fieldset', { class: 'fs' }, h('legend', { text: 'Assertions' }), asserts.length ? asserts.map((a, i) => {
          const id = uid('as');
          const cb = h('input', { type: 'checkbox', id, checked: a.on, onchange: () => ((asserts[i].on = cb.checked), void refresh()) });
          return h('label', { class: 'check', for: id }, cb, h('span', { text: a.label }));
        }) : h('p', { class: 'small muted', text: kind === 'sql' || kind === 'query' ? 'Run the query first to assert its row count.' : 'Send the request first; add JSONPath assertions from the JSONPath tab.' }));
        await refresh();
        void openModal<boolean>({
          title: 'Save as step',
          size: 'lg',
          body: h('div', { class: 'stack' }, field('Store the result as', capture, 'The name later steps use, e.g. ${response.status}.'), assertBox, h('div', null, h('p', { class: 'field-label', text: 'Steps' }), preview), status, field('Insert at the end of', journeySel)),
          actions: [
            { label: 'Cancel', run: () => false },
            { label: 'Copy steps', run: async () => (lines.length ? (await copyText(lines.join('\n')), toast('Copied'), undefined) : undefined) },
            {
              label: 'Insert into journey',
              kind: 'primary',
              run: async () => {
                if (!lines.length) return undefined;
                if (!(await confirmDialog({ title: 'Insert steps?', message: `Append ${lines.length} line(s) to ${journeySel.value}?`, confirm: 'Insert' }))) return undefined;
                try {
                  const r = await api.post<{ path: string; journey?: { name: string; steps: number } }>('/api/workbench/insert', { path: journeySel.value, lines });
                  toast(`Inserted into ${r.path}: the journey validates (${r.journey?.steps ?? '?'} steps)`, { kind: 'success', action: { label: 'Open', run: () => navigate(link('journeys', r.path)) } });
                  void refreshJourneys();
                  return true;
                } catch (e) {
                  clear(status).appendChild(h('p', { class: 'bad-text', role: 'alert', text: (e as Error).message }));
                  return undefined;
                }
              },
            },
          ],
        });
      };

      // ---------------------------------------------------------- history
      const historyHost = h('ul', { class: 'pill-list', 'aria-label': 'Recent requests' });
      const renderHistory = () => {
        clear(historyHost);
        for (const x of st.history.slice(0, 8)) {
          historyHost.appendChild(h('li', null, h('button', { type: 'button', class: 'pill', onclick: () => {
            st.method = x.method;
            st.url = x.url;
            methodSel.value = x.method;
            urlInput.value = x.url;
            save();
          } }, `${x.method} ${x.url}`)));
        }
      };

      // ---------------------------------------------------------- layout
      const urlRow = (kindLabel?: string) => h('div', { class: 'wb-url' }, kindLabel ? h('span', { class: 'chip', text: kindLabel }) : methodSel, urlInput, sendBtn, stepBtn);
      const restPane = h('div', { class: 'stack' });
      const sqlPane = h('div', { class: 'stack' },
        h('div', { class: 'row wrap' }, field('Connection', connSel), modeBadge, h('label', { class: 'check', for: writeToggleId }, writeToggle, h('span', { text: 'Allow writes for this session' }))),
        sqlTa,
        field('Parameters (JSON array for ?, $1, @p1 or :1 placeholders)', sqlParams),
        h('div', { class: 'row' }, button('Run query', { kind: 'primary', icon: 'run', id: 'wb-sql-run', onclick: () => void runSql() }), button('Save as step', { icon: 'save', id: 'wb-sql-save-step', onclick: () => void saveAsStep('sql') })),
        queriesPanel,
        sqlOut,
      );
      const layoutFor = (k: Kind) => {
        st.kind = k;
        save();
        clear(restPane);
        if (k === 'rest') restPane.append(urlRow(), restTabs.el);
        else if (k === 'graphql') restPane.append(urlRow('POST'), h('div', { class: 'two-col' }, h('div', { class: 'stack-sm' }, h('p', { class: 'field-label', text: 'Query' }), gqlQuery), h('div', { class: 'stack-sm' }, field('Variables (JSON)', gqlVars), field('Operation name', gqlOp))));
        else if (k === 'soap') restPane.append(urlRow('POST'), h('div', { class: 'form-grid' }, field('Version', soapVer), field('SOAPAction', soapAction)), soapBody, h('p', { class: 'help', text: 'Paste the body element (wrapped in an envelope for you) or a full envelope.' }));
      };
      let kindTabs: ReturnType<typeof createTabs> | undefined;
      kindTabs = createTabs({
        label: 'Request kind',
        selected: st.kind,
        tabs: [
          { id: 'rest', title: 'REST', mount: (p) => (layoutFor('rest'), p.append(restPane)) },
          { id: 'graphql', title: 'GraphQL', mount: (p) => (layoutFor('graphql'), p.append(restPane)) },
          { id: 'soap', title: 'SOAP', mount: (p) => (layoutFor('soap'), p.append(restPane)) },
          { id: 'sql', title: 'SQL', mount: (p) => ((st.kind = 'sql'), save(), p.append(sqlPane)) },
        ],
        onSelect: (id) => {
          if (id !== 'sql') {
            layoutFor(id as Kind);
            const panel = kindTabs?.el.querySelector<HTMLElement>(`.tabpanel:not([hidden])`);
            if (panel && !panel.contains(restPane)) panel.appendChild(restPane);
          } else {
            st.kind = 'sql';
            save();
          }
          respHost.hidden = id === 'sql';
        },
        class: 'card wb-kinds',
      });
      const heading = pageHeader('API & DB workbench', 'Requests and queries through EZTest\'s own clients: auth as a role (resolved on the server), secrets masked, one click to a journey step.', [
        field('Environment', envSel),
        field('Auth', roleSel),
      ]);
      inner.append(heading, h('p', { class: 'row wrap' }, baseInfo, historyHost), kindTabs!.el, h('div', { class: 'wb-response-wrap' }, respHost));
      renderHistory();
      renderResponse();
      respHost.hidden = st.kind === 'sql';
      registerShortcut({ keys: 'Mod+Enter', title: 'Send request / run query (workbench)', group: 'Workbench', inInputs: true, when: () => location.hash.startsWith('#/workbench'), run: () => void (st.kind === 'sql' ? runSql() : send()) });
      let loaded = false;
      return {
        show: () => {
          if (loaded) return;
          loaded = true;
          refreshContext().catch((e: Error) => inner.prepend(errorState(e, () => void refreshContext())));
        },
        focus: () => heading.querySelector<HTMLElement>('h1')?.focus(),
      };
    },
  });
}

