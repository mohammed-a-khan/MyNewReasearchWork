/**
 * A ServiceNow emulation for EZTest's ServiceNow pack, built from the public
 * documentation of the platform's conventions. It is NOT ServiceNow: the
 * pack is tested against this mock, not against a real instance.
 *
 *  - UI16-style pages: login.do, <table>_list.do, <table>.do forms with
 *    `element.<table>.<field>` containers, label-text spans, mandatory
 *    markers, reference fields (sys_display.* + autocomplete), choice lists,
 *    read-only fields, UI action buttons (Submit, Update, Resolve, Delete),
 *    output messages, related lists (Task SLAs).
 *  - Service Portal (/sp): catalog items with variables (sp_formfield_*),
 *    Order Now, order status with the REQ number.
 *  - Table API (/api/now/table): encoded queries (=, !=, IN, LIKE,
 *    STARTSWITH, ISEMPTY, ISNOTEMPTY, ^, ^OR), sysparm_fields with dot-walks,
 *    sysparm_display_value=true|false|all, sysparm_limit, ACL-filtered fields,
 *    403 for tables a user may not read; Basic auth and OAuth (/oauth_token.do).
 *  - Dictionary tables (sys_db_object, sys_dictionary, sys_documentation,
 *    sys_choice) generated from the live model; update sets (sys_update_set,
 *    sys_update_xml with payloads) and upgrade history (skipped records).
 *    commitUpdateSet(name) applies an update set's dictionary changes.
 *
 * Run standalone: `npx tsx examples/servicenow-mock/server.ts`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  baseFields, fieldAccess, genPassword, Store, TABLES, tableAccess, VAR_TYPE,
  type Access, type MockField, type MockTable, type MockUser, type Rec,
} from './model.js';

export interface ServiceNowMockServer {
  url: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  users: Record<'admin' | 'itil' | 'employee' | 'integration', { username: string; password: string }>;
  store: Store;
  stats: { apiRequests: number; queries: string[]; tokenRequests: number };
  /** Apply an update set's dictionary/choice/UI action changes to the live instance. */
  commitUpdateSet(name: string): void;
  close(): Promise<void>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
}
const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json');
const redirect = (res: ServerResponse, to: string, headers: Record<string, string> = {}) => {
  res.writeHead(302, { location: to, ...headers });
  res.end();
};
async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (req.headers.cookie ?? '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly detail = '') {
    super(message);
  }
}

export async function startServiceNowMock(o: { port?: number; saveDelayMs?: number } = {}): Promise<ServiceNowMockServer> {
  const store = new Store();
  const fields: MockField[] = baseFields();
  const labelOverride = new Map<string, string>();
  const clientId = 'ez_sn_client_' + randomBytes(4).toString('hex');
  const clientSecret = genPassword('sncs');
  const delay = o.saveDelayMs ?? 120;
  const mk = (userName: string, name: string, roles: string[]): MockUser => ({ sysId: store.newId(), userName, name, password: genPassword(userName.slice(0, 3)), roles });
  const admin = mk('admin', 'System Administrator', ['admin']);
  const itil = mk('beth.anglin', 'Beth Anglin', ['itil']);
  const employee = mk('abel.tuter', 'Abel Tuter', []);
  const integration = mk('eztest.integration', 'EZTest Integration', ['admin', 'rest_api_explorer']);
  const users = [admin, itil, employee, integration];
  for (const u of users) store.insert('sys_user', { sys_id: u.sysId, user_name: u.userName, name: u.name, email: `${u.userName}@example.com` });
  store.insert('sys_user', { user_name: 'fred.luddy', name: 'Fred Luddy', email: 'fred.luddy@example.com' });
  const groups = Object.fromEntries(['Service Desk', 'Network', 'Hardware'].map((n) => [n, store.insert('sys_user_group', { name: n }).sys_id]));
  const resolveAction = store.insert('sys_ui_action', { name: 'Resolve', table: 'incident', action_name: 'resolve_incident', active: 'true' });
  const inc1 = store.insert('incident', { short_description: 'Email not working', description: 'Outlook cannot connect', priority: '3', state: '2', category: 'software', caller_id: employee.sysId, assignment_group: groups['Service Desk'], active: 'true', opened_at: '2026-10-01 09:00:00' }, 'INC');
  store.insert('incident', { short_description: 'VPN down in Berlin', priority: '1', state: '2', category: 'network', caller_id: itil.sysId, assignment_group: groups.Network, active: 'true', opened_at: '2026-10-02 10:00:00' }, 'INC');
  store.insert('task_sla', { task: inc1.sys_id, sla: 'Priority 3 resolution (5 day)', stage: 'In progress', has_breached: 'false' });
  store.insert('task_sla', { task: inc1.sys_id, sla: 'Priority 3 response (1 day)', stage: 'Completed', has_breached: 'false' });
  store.insert('change_request', { short_description: 'Patch mail servers', type: 'normal', state: '1', active: 'true' }, 'CHG');
  const laptop = store.insert('sc_cat_item', { name: 'Standard Laptop', short_description: 'A standard laptop for daily work', active: 'true' });
  const vpn = store.insert('sc_cat_item', { name: 'Request VPN access', short_description: 'Remote network access', active: 'true' });
  const variable = (item: string, name: string, question: string, type: string, mandatory: boolean, order: number, choices: string[] = []) => {
    const v = store.insert('item_option_new', { cat_item: item, name, question_text: question, type, mandatory: String(mandatory), order: String(order) });
    for (const c of choices) store.insert('question_choice', { question: v.sys_id, value: c.toLowerCase().replace(/\W+/g, '_'), text: c });
    return v;
  };
  variable(laptop.sys_id, 'model', 'Model', VAR_TYPE.selectBox, true, 100, ['MacBook Pro 14', 'Dell XPS 13', 'Lenovo ThinkPad X1']);
  const addSw = variable(laptop.sys_id, 'additional_software', 'Additional software', VAR_TYPE.multiLine, false, 200);
  variable(laptop.sys_id, 'justification', 'Business justification', VAR_TYPE.singleLine, true, 300);
  variable(laptop.sys_id, 'express', 'Express delivery', VAR_TYPE.checkbox, false, 400);
  variable(vpn.sys_id, 'reason', 'Reason', VAR_TYPE.singleLine, true, 100);

  // ---------------------------------------------------------------- update sets and upgrade history
  const xml = (table: string, action: string, inner: Record<string, string>, attrs = '') =>
    `<?xml version="1.0" encoding="UTF-8"?><record_update table="${table}"><${table} action="${action}"${attrs}>${Object.entries(inner).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</${table}></record_update>`;
  const us1 = store.insert('sys_update_set', { name: 'EZ incident form changes', state: 'complete', application: 'Global' });
  const us2 = store.insert('sys_update_set', { name: 'EZ change model', state: 'complete', application: 'Global' });
  const bizRule = store.newId();
  const updates: Array<[string, string, string, string, string, string]> = [
    [us1.sys_id, 'sys_dictionary_incident_u_vip', 'Dictionary', 'incident.u_vip', 'INSERT_OR_UPDATE', xml('sys_dictionary', 'INSERT_OR_UPDATE', { name: 'incident', element: 'u_vip', column_label: 'VIP', internal_type: 'boolean', mandatory: 'false' })],
    [us1.sys_id, 'sys_documentation_task_short_description_en', 'Field Label', 'task.short_description', 'INSERT_OR_UPDATE', xml('sys_documentation', 'INSERT_OR_UPDATE', { name: 'task', element: 'short_description', label: 'Summary', language: 'en' })],
    [us1.sys_id, 'sys_dictionary_incident_category', 'Dictionary', 'incident.category', 'INSERT_OR_UPDATE', xml('sys_dictionary', 'INSERT_OR_UPDATE', { name: 'incident', element: 'category', column_label: 'Category', internal_type: 'string', mandatory: 'true' })],
    [us1.sys_id, 'sys_choice_incident_category', 'Choice List', 'incident.category', 'INSERT_OR_UPDATE',
      `<?xml version="1.0" encoding="UTF-8"?><record_update><sys_choice action="DELETE" field="category" table="incident"><name>incident</name><element>category</element><value>database</value><label>Database</label></sys_choice></record_update>`],
    [us1.sys_id, `sys_ui_action_${resolveAction.sys_id}`, 'UI Action', 'Resolve', 'INSERT_OR_UPDATE', xml('sys_ui_action', 'INSERT_OR_UPDATE', { name: 'Resolve', table: 'incident', action_name: 'resolve_incident', active: 'false', sys_id: resolveAction.sys_id })],
    [us1.sys_id, `item_option_new_${addSw.sys_id}`, 'Variable', 'Additional software', 'DELETE',
      `<?xml version="1.0" encoding="UTF-8"?><record_update table="item_option_new"><item_option_new action="DELETE"><cat_item display_value="Standard Laptop">${laptop.sys_id}</cat_item><name>additional_software</name><question_text>Additional software</question_text><sys_id>${addSw.sys_id}</sys_id></item_option_new></record_update>`],
    [us1.sys_id, `sys_script_${bizRule}`, 'Business Rule', 'Set VIP priority', 'INSERT_OR_UPDATE', xml('sys_script', 'INSERT_OR_UPDATE', { name: 'Set VIP priority', collection: 'incident', when: 'before', active: 'true' })],
    [us2.sys_id, 'sys_dictionary_change_request_u_cab_date', 'Dictionary', 'change_request.u_cab_date', 'INSERT_OR_UPDATE', xml('sys_dictionary', 'INSERT_OR_UPDATE', { name: 'change_request', element: 'u_cab_date', column_label: 'CAB date', internal_type: 'glide_date_time', mandatory: 'true' })],
  ];
  for (const [set, name, type, target, action, payload] of updates) store.insert('sys_update_xml', { update_set: set, name, type, target_name: target, action, payload });
  const upgrade = 'glide-xanadu-07-02-2024__patch3';
  for (const [file, type, target, disp] of [
    [`sys_ui_action_${resolveAction.sys_id}`, 'UI Action', 'Resolve', '4'],
    ['sys_dictionary_incident_priority', 'Dictionary', 'incident.priority', '4'],
    ['sys_script_include_4e8f2a1b7f3c', 'Script Include', 'IncidentUtils', '4'],
    ['sys_dictionary_task_state', 'Dictionary', 'task.state', '2'],
  ] as const) store.insert('sys_upgrade_history_log', { file_name: file, type, target_name: target, disposition: disp, resolution_status: 'not_reviewed', upgrade_history: upgrade });

  // ---------------------------------------------------------------- model helpers
  const tableDef = (n: string): MockTable | undefined => TABLES.find((t) => t.name === n);
  const chain = (n: string): string[] => {
    const out: string[] = [];
    for (let t = tableDef(n); t; t = t.parent ? tableDef(t.parent) : undefined) out.push(t.name);
    return out;
  };
  const labelOf = (f: MockField) => labelOverride.get(`${f.table}.${f.element}`) ?? f.label;
  const fieldsOf = (table: string): MockField[] => {
    const seen = new Map<string, MockField>();
    for (const t of chain(table)) for (const f of fields.filter((x) => x.table === t)) if (!seen.has(f.element)) seen.set(f.element, f);
    return [...seen.values()];
  };
  const fieldOf = (table: string, el: string) => fieldsOf(table).find((f) => f.element === el);
  const displayOf = (table: string, rec: Rec | undefined): string => {
    if (!rec) return '';
    const t = tableDef(table);
    return rec[t?.displayField ?? 'name'] ?? rec.name ?? rec.number ?? '';
  };
  const findRec = (table: string, id: string): Rec | undefined => {
    for (const t of [table, ...TABLES.filter((x) => chain(x.name).includes(table)).map((x) => x.name)]) {
      const r = store.tables.get(t)?.get(id);
      if (r) return r;
    }
    return undefined;
  };
  const display = (f: MockField, v: string | undefined): string => {
    if (v === undefined || v === '') return '';
    if (f.choices?.length) return f.choices.find((c) => c.value === v)?.label ?? v;
    if (f.type === 'reference' && f.reference) return displayOf(f.reference, findRec(f.reference, v));
    return v;
  };
  const rowsOf = (table: string): Rec[] => {
    if (table === 'sys_db_object') return TABLES.map((t) => ({ sys_id: `dbo_${t.name}`, name: t.name, label: t.label, super_class: t.parent ? `dbo_${t.parent}` : '' }));
    if (table === 'sys_dictionary') {
      return fields.map((f) => ({
        sys_id: `dict_${f.table}_${f.element}`, name: f.table, element: f.element, column_label: labelOf(f), internal_type: f.type, mandatory: String(!!f.mandatory),
        read_only: String(!!f.readOnly), reference: f.reference ?? '', max_length: String(f.maxLength ?? (f.type === 'string' ? 40 : 0)), choice: String(f.choice ?? 0), active: 'true',
      }));
    }
    if (table === 'sys_documentation') return fields.map((f) => ({ sys_id: `doc_${f.table}_${f.element}`, name: f.table, element: f.element, label: labelOf(f), language: 'en' }));
    if (table === 'sys_choice') {
      return fields.flatMap((f) => (f.choices ?? []).map((c, i) => ({ sys_id: `ch_${f.table}_${f.element}_${i}`, name: f.table, element: f.element, value: c.value, label: c.label, inactive: String(!!c.inactive), sequence: String(i) })));
    }
    const out: Rec[] = [];
    for (const t of [table, ...TABLES.filter((x) => x.name !== table && chain(x.name).includes(table)).map((x) => x.name)]) {
      const m = store.tables.get(t);
      if (m) out.push(...[...m.values()].map((r) => (t !== table ? { ...r, sys_class_name: t } : { ...r, sys_class_name: t })));
    }
    return out;
  };
  const VIRTUAL = new Set(['sys_db_object', 'sys_dictionary', 'sys_documentation', 'sys_choice']);
  const virtualField = (table: string, el: string): MockField | undefined =>
    VIRTUAL.has(table) ? { table, element: el, label: el, type: el === 'super_class' ? 'reference' : 'string', ...(el === 'super_class' ? { reference: 'sys_db_object' } : {}) } : undefined;

  // Encoded queries.
  const valueAt = (table: string, rec: Rec, path: string): string | undefined => {
    const [head, ...rest] = path.split('.');
    if (head === 'variables' && rest.length === 1) return (JSON.parse(rec.variables ?? '{}') as Record<string, string>)[rest[0]];
    if (!rest.length) return rec[head];
    const f = fieldOf(table, head) ?? virtualField(table, head);
    if (!f?.reference) return undefined;
    const target = f.reference === 'sys_db_object' ? rowsOf('sys_db_object').find((r) => r.sys_id === rec[head]) : findRec(f.reference, rec[head] ?? '');
    return target ? valueAt(f.reference, target, rest.join('.')) : undefined;
  };
  const term = (table: string, rec: Rec, t: string): boolean => {
    const m = /^([\w.]+?)(ISNOTEMPTY|ISEMPTY|!=|=|NOT IN|IN|STARTSWITH|ENDSWITH|NOT LIKE|LIKE|>=|<=|>|<)(.*)$/.exec(t);
    if (!m) throw new ApiError(400, `Invalid query term ${t}`);
    const [, field, op, val] = m;
    const v = valueAt(table, rec, field) ?? '';
    switch (op) {
      case '=': return v === val;
      case '!=': return v !== val;
      case 'IN': return val.split(',').includes(v);
      case 'NOT IN': return !val.split(',').includes(v);
      case 'LIKE': return v.toLowerCase().includes(val.toLowerCase());
      case 'NOT LIKE': return !v.toLowerCase().includes(val.toLowerCase());
      case 'STARTSWITH': return v.toLowerCase().startsWith(val.toLowerCase());
      case 'ENDSWITH': return v.toLowerCase().endsWith(val.toLowerCase());
      case 'ISEMPTY': return v === '';
      case 'ISNOTEMPTY': return v !== '';
      case '>': return Number(v) > Number(val);
      case '>=': return Number(v) >= Number(val);
      case '<': return Number(v) < Number(val);
      default: return Number(v) <= Number(val);
    }
  };
  const matches = (table: string, rec: Rec, q: string): boolean => {
    if (!q) return true;
    return q.split(/\^(?!OR)/).filter((x) => x && !/^ORDERBY/.test(x)).every((group) => group.split('^OR').some((t) => term(table, rec, t)));
  };

  // ---------------------------------------------------------------- auth
  const tokens = new Map<string, MockUser>();
  const sessions = new Map<string, { user: MockUser; flash: Array<{ type: 'info' | 'error'; text: string }> }>();
  const stats = { apiRequests: 0, queries: [] as string[], tokenRequests: 0 };
  const apiUser = (req: IncomingMessage): MockUser => {
    const h = req.headers.authorization ?? '';
    if (h.startsWith('Basic ')) {
      const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      const user = users.find((x) => x.userName === u && x.password === p.join(':'));
      if (user) return user;
    } else if (h.startsWith('Bearer ')) {
      const user = tokens.get(h.slice(7));
      if (user) return user;
    }
    throw new ApiError(401, 'User Not Authenticated', 'Required to provide Auth information');
  };
  const sessionOf = (req: IncomingMessage) => sessions.get(cookies(req).glide_session_store ?? '');

  // ---------------------------------------------------------------- Table API
  const accessFor = (u: MockUser, table: string, f: MockField): Access => (VIRTUAL.has(table) || table.startsWith('sys_update') || table === 'sys_upgrade_history_log' || table === 'sys_ui_action' ? (u.roles.includes('admin') ? 'read' : 'none') : fieldAccess(u, f, table));
  const tableRead = (u: MockUser, table: string): Access => (VIRTUAL.has(table) || ['sys_update_set', 'sys_update_xml', 'sys_upgrade_history_log', 'sys_ui_action'].includes(table) ? (u.roles.includes('admin') ? 'read' : 'none') : tableAccess(u, table));

  function apiRow(u: MockUser, table: string, rec: Rec, sel: string[] | undefined, dv: string, links: boolean): Record<string, unknown> {
    const cols = sel ?? [...new Set([...(VIRTUAL.has(table) ? Object.keys(rec) : fieldsOf(table).map((f) => f.element)), 'sys_id', ...Object.keys(rec)])].filter((k) => k !== 'variables');
    const out: Record<string, unknown> = {};
    for (const c of cols) {
      const base = c.split('.')[0];
      const f = fieldOf(rec.sys_class_name ?? table, base) ?? virtualField(table, base) ?? { table, element: base, label: base, type: 'string' as const };
      if (base !== 'sys_id' && base !== 'sys_class_name' && base !== 'variables' && accessFor(u, table, f) === 'none') continue;
      const raw = valueAt(rec.sys_class_name ?? table, rec, c) ?? '';
      const disp = c.includes('.') ? raw : display(f, raw);
      const link = f.type === 'reference' && raw && links && !c.includes('.') ? { link: `/api/now/table/${f.reference}/${raw}` } : {};
      if (dv === 'all') out[c] = { display_value: disp, value: raw, ...link };
      else if (dv === 'true') out[c] = disp;
      else out[c] = f.type === 'reference' && raw && links && !c.includes('.') ? { value: raw, ...link } : raw;
    }
    return out;
  }

  async function tableApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    stats.apiRequests++;
    const u = apiUser(req);
    const m = /^\/api\/now\/table\/(\w+)(?:\/([0-9a-z_]+))?$/.exec(url.pathname);
    if (!m) throw new ApiError(400, 'Invalid table API path');
    const [, table, id] = m;
    if (!tableDef(table) && !VIRTUAL.has(table)) throw new ApiError(400, `Invalid table ${table}`);
    const read = tableRead(u, table);
    if (read === 'none') throw new ApiError(403, 'User Not Authorized', `ACL Exception Read Failed due to security constraints on ${table}`);
    const sel = url.searchParams.get('sysparm_fields')?.split(',').map((s) => s.trim()).filter(Boolean);
    const dv = url.searchParams.get('sysparm_display_value') ?? 'false';
    const links = url.searchParams.get('sysparm_exclude_reference_link') !== 'true';
    if (req.method === 'GET' && !id) {
      const q = url.searchParams.get('sysparm_query') ?? '';
      stats.queries.push(`${table}?${q}`);
      let rows = rowsOf(table).filter((r) => matches(table, r, q));
      // Non-ITIL users only see their own incidents (the "caller is me" read ACL).
      if (!u.roles.includes('admin') && !u.roles.includes('itil') && chain(table).includes('task')) rows = rows.filter((r) => r.caller_id === u.sysId || r.requested_for === u.sysId || r.opened_by === u.sysId);
      const limit = Number(url.searchParams.get('sysparm_limit') ?? '10000');
      return json(res, 200, { result: rows.slice(0, limit).map((r) => apiRow(u, table, r, sel, dv, links)) });
    }
    if (req.method === 'GET' && id) {
      const r = rowsOf(table).find((x) => x.sys_id === id);
      if (!r) throw new ApiError(404, 'No Record found', 'Record doesn\'t exist or ACL restricts the record retrieval');
      return json(res, 200, { result: apiRow(u, table, r, sel, dv, links) });
    }
    if (read !== 'write' || VIRTUAL.has(table)) throw new ApiError(403, 'User Not Authorized', `ACL Exception ${req.method === 'POST' ? 'Insert' : 'Update'} Failed due to security constraints`);
    const data = JSON.parse((await body(req)) || '{}') as Record<string, unknown>;
    const clean: Rec = {};
    for (const [k, v] of Object.entries(data)) {
      const f = fieldOf(table, k);
      if (!f) continue;
      if (fieldAccess(u, f, table) !== 'write') throw new ApiError(403, 'User Not Authorized', `ACL Exception Update Failed on ${table}.${k}`);
      clean[k] = String(v ?? '');
    }
    if (req.method === 'POST') {
      const rec = store.insert(table, { active: 'true', state: '1', ...clean }, tableDef(table)?.numberPrefix);
      return json(res, 201, { result: apiRow(u, table, rec, sel, dv, links) });
    }
    const rec = store.tables.get(table)?.get(id ?? '');
    if (!rec) throw new ApiError(404, 'No Record found');
    if (req.method === 'DELETE') {
      store.table(table).delete(rec.sys_id);
      res.writeHead(204).end();
      return;
    }
    Object.assign(rec, clean);
    return json(res, 200, { result: apiRow(u, table, rec, sel, dv, links) });
  }

  // ---------------------------------------------------------------- UI rendering
  const page = (title: string, inner: string, u?: MockUser) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} | ServiceNow</title>
<style>body{font-family:sans-serif;margin:0}.navbar{background:#293e40;color:#fff;padding:8px}.form-group{margin:6px 12px;display:flex;gap:8px}.form-group label{width:180px}
.outputmsg_error{background:#fdd}.outputmsg_info{background:#def}.readonly,.disabled{background:#eee}.ac_dropdown{position:absolute;background:#fff;border:1px solid #999}
.tabs2_list{margin:12px}table.list2_body{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px}</style></head>
<body><div class="navbar navbar-header" role="banner"><span class="navbar-brand">ServiceNow</span>${u ? `<span class="user-name" id="user_info_dropdown">${esc(u.name)}</span> <a href="/logout.do">Log out</a>` : ''}</div>
<main id="gsft_main_content">${inner}</main></body></html>`;

  const messages = (flash: Array<{ type: string; text: string }>) =>
    `<div class="outputmsg_container" id="output_messages">${flash.map((m) => `<div class="outputmsg outputmsg_${m.type} notification notification-${m.type === 'error' ? 'error' : 'info'}" role="alert"><span class="outputmsg_text">${esc(m.text)}</span></div>`).join('')}</div>`;

  function fieldHtml(u: MockUser, table: string, f: MockField, rec: Rec): string {
    const acc = fieldAccess(u, f, table);
    if (acc === 'none') return '';
    const id = `${table}.${f.element}`;
    const ro = acc !== 'write' || f.readOnly || (rec.state === '7');
    const v = rec[f.element] ?? '';
    const mandatory = !!f.mandatory && !ro;
    const marker = `<span class="required-marker${mandatory ? ' mandatory' : ''}" aria-label="${mandatory ? 'Mandatory - must be populated before Submit' : ''}">${mandatory ? '*' : ''}</span>`;
    const label = (forId: string) => `<div class="label_spacing control-label"><label for="${forId}" class="control-label">${marker}<span class="label-text" data-html="false">${esc(labelOf(f))}</span></label></div>`;
    const attrs = `data-mandatory="${mandatory}" data-type="${f.type}" ${ro ? 'readonly="readonly" aria-readonly="true"' : ''}`;
    let ctrl: string;
    let forId = id;
    if (f.choices?.length) {
      ctrl = `<select id="${id}" name="${id}" class="form-control${ro ? ' disabled' : ''}" ${attrs} ${ro ? 'disabled' : ''}>${f.choice === 1 ? '<option value="">-- None --</option>' : ''}${f.choices.filter((c) => !c.inactive).map((c) => `<option value="${esc(c.value)}"${c.value === v ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>${ro ? `<input type="hidden" name="${id}" value="${esc(v)}">` : ''}`;
    } else if (f.type === 'reference') {
      forId = `sys_display.${id}`;
      ctrl = `<input type="hidden" id="${id}" name="${id}" value="${esc(v)}"><input id="sys_display.${id}" name="sys_display.${id}" class="form-control${ro ? ' readonly' : ''}" role="combobox" autocomplete="off" data-ref-table="${f.reference}" value="${esc(display(f, v))}" ${attrs}>${ro ? '' : `<button type="button" id="lookup.${id}" class="btn btn-default icon-search" aria-label="Look up value for field: ${esc(labelOf(f))}"></button>`}`;
    } else if (f.type === 'boolean') {
      forId = `ni.${id}`;
      ctrl = `<input type="hidden" id="${id}" name="${id}" value="${v === 'true' ? 'true' : 'false'}"><input type="checkbox" id="ni.${id}" ${v === 'true' ? 'checked' : ''} ${ro ? 'disabled' : ''} onchange="document.getElementById('${id}').value=this.checked?'true':'false'" ${attrs}>`;
    } else if (f.type === 'journal_input' || (f.maxLength ?? 0) > 1000) {
      ctrl = `<textarea id="${id}" name="${id}" class="form-control${ro ? ' readonly' : ''}" ${attrs}>${esc(v)}</textarea>`;
    } else {
      ctrl = `<input id="${id}" name="${id}" class="form-control${ro ? ' disabled' : ''}" value="${esc(v)}" ${attrs}>`;
    }
    return `<div class="form-group" id="element.${id}" data-field="${f.element}">${label(forId)}<div class="col-xs-10 form-field">${ctrl}</div></div>`;
  }

  function uiActions(u: MockUser, table: string, rec: Rec, isNew: boolean): Array<{ id: string; label: string }> {
    if (tableAccess(u, table) !== 'write') return [];
    if (isNew) return [{ id: 'sysverb_insert', label: 'Submit' }];
    const out = [{ id: 'sysverb_update', label: 'Update' }];
    const resolve = store.find('sys_ui_action', (a) => a.action_name === 'resolve_incident')[0];
    if (table === 'incident' && resolve?.active === 'true' && !['6', '7'].includes(rec.state ?? '')) out.push({ id: 'resolve_incident', label: 'Resolve' });
    if (u.roles.includes('admin')) out.push({ id: 'sysverb_delete', label: 'Delete' });
    return out;
  }

  const FORM_JS = `
function gsftSubmit(btn){var action=btn.id;var form=document.getElementById(document.forms[0].id);var missing=[];
 var need=function(el){if(!el)return;var v=el.value;var lbl=el.closest('.form-group').querySelector('.label-text').textContent;if(!v||!String(v).trim())missing.push(lbl);};
 form.querySelectorAll('[data-mandatory="true"]').forEach(function(el){var id=el.id.replace(/^sys_display\\.|^ni\\./,'');need(document.getElementById(id));});
 if(action==='resolve_incident'){['incident.close_code','incident.close_notes'].forEach(function(id){var el=document.getElementById(id);if(el&&missing.indexOf(el.closest('.form-group').querySelector('.label-text').textContent)<0)need(el);});}
 if(missing.length&&action!=='sysverb_delete'){var c=document.getElementById('output_messages');c.innerHTML='<div class="outputmsg outputmsg_error notification notification-error" role="alert"><span class="outputmsg_text">The following mandatory fields are not filled in: '+missing.join(', ')+'</span></div>';return false;}
 document.getElementById('sys_action').value=action;btn.disabled=true;setTimeout(function(){form.submit();},${delay});return false;}
document.addEventListener('input',function(e){var t=e.target;if(!t.id||t.id.indexOf('sys_display.')!==0)return;var id=t.id.slice(12);var dd=document.getElementById('AC.'+id);if(dd)dd.remove();
 document.getElementById(id).value='';if(!t.value)return;fetch('/_ac?table='+encodeURIComponent(t.dataset.refTable)+'&q='+encodeURIComponent(t.value)).then(function(r){return r.json()}).then(function(rows){
 if(t.value===''||document.getElementById('AC.'+id))return;var d=document.createElement('div');d.id='AC.'+id;d.className='ac_dropdown';d.setAttribute('role','listbox');
 d.innerHTML='<table><tbody>'+rows.map(function(r){return '<tr class="ac_row" role="option" data-sys-id="'+r.sys_id+'"><td class="ac_cell">'+r.name.replace(/</g,'&lt;')+'</td></tr>'}).join('')+(rows.length?'':'<tr class="ac_no_match"><td>No matches found</td></tr>')+'</tbody></table>';
 t.parentNode.appendChild(d);d.querySelectorAll('tr.ac_row').forEach(function(tr){tr.addEventListener('click',function(){document.getElementById(id).value=tr.dataset.sysId;t.value=tr.textContent;d.remove();});});});});`;

  function renderForm(u: MockUser, table: string, rec: Rec, isNew: boolean, flash: Array<{ type: string; text: string }>): string {
    const t = tableDef(table)!;
    const fs = fieldsOf(table).filter((f) => f.onForm);
    const actions = uiActions(u, table, rec, isNew);
    const btns = actions.map((a) => `<button type="button" class="form_action_button header action_context btn btn-default" id="${a.id}" onclick="return gsftSubmit(this)">${esc(a.label)}</button>`).join('');
    let related = '';
    if (table === 'incident' && !isNew) {
      const slas = store.find('task_sla', (s) => s.task === rec.sys_id);
      related = `<div class="related_lists" id="related_lists_wrapper"><div class="tabs2_section"><span class="tab_caption_text">Task SLAs (${slas.length})</span>
<div class="tabs2_list" id="incident.task_sla.task" tab_caption="Task SLAs"><table class="list2_body" role="grid"><thead><tr><th name="sla">SLA definition</th><th name="stage">Stage</th><th name="has_breached">Has breached</th></tr></thead>
<tbody>${slas.map((s) => `<tr class="list_row" sys_id="${s.sys_id}"><td>${esc(s.sla)}</td><td>${esc(s.stage)}</td><td>${esc(s.has_breached)}</td></tr>`).join('')}</tbody></table></div></div></div>`;
    }
    return page(`${t.label} ${rec.number ?? ''}`, `
<form id="${table}.do" name="${table}.do" method="post" action="/${table}.do${isNew ? '' : `?sys_id=${rec.sys_id}`}">
<div class="form_header navbar-header"><h1 class="navbar-title form_header_title" id="form_header_title">${esc(t.label)}${isNew ? ' New record' : ` ${esc(rec.number ?? displayOf(table, rec))}`}</h1>
<span class="navbar_ui_actions" id="ui_actions">${btns}</span></div>
${messages(flash)}
<input type="hidden" id="sys_action" name="sys_action" value=""><input type="hidden" id="sys_uniqueValue" name="sys_uniqueValue" value="${isNew ? '-1' : rec.sys_id}">
<div class="section tabs2_section" id="section-main">${fs.map((f) => fieldHtml(u, table, f, rec)).join('')}</div>
</form>${related}<script>${FORM_JS}</script>`, u);
  }

  function renderList(u: MockUser, table: string, q: string): string {
    const t = tableDef(table)!;
    let rows = rowsOf(table).filter((r) => matches(table, r, q));
    if (!u.roles.includes('admin') && !u.roles.includes('itil')) rows = rows.filter((r) => r.caller_id === u.sysId);
    const cols = fieldsOf(table).filter((f) => f.onForm && ['number', 'short_description', 'priority', 'state', 'caller_id', 'assignment_group', 'type'].includes(f.element));
    const canCreate = tableAccess(u, table) === 'write';
    return page(`${t.label}s`, `<div class="list_nav navbar-header"><h1 class="list_title navbar-title">${esc(t.label)}s</h1>${canCreate ? `<button id="sysverb_new" class="list_action btn btn-primary" onclick="location.href='/${table}.do?sys_id=-1'">New</button>` : ''}</div>
<table id="${table}_table" class="list2_body data_list_table" role="grid"><thead><tr>${cols.map((c) => `<th name="${c.element}" class="list_hdr">${esc(labelOf(c))}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr class="list_row" sys_id="${r.sys_id}" record_class="${table}">${cols.map((c, i) => `<td class="vt">${i === 0 ? `<a class="linked formlink" href="/${table}.do?sys_id=${r.sys_id}">${esc(display(c, r[c.element]))}</a>` : esc(display(c, r[c.element]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`, u);
  }

  function renderPortal(u: MockUser, url: URL): string {
    const id = url.searchParams.get('id') ?? 'index';
    const shell = (title: string, inner: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Service Portal</title></head><body><div class="sp-page-root" id="sp-page"><header class="navbar"><span class="portal-title">IT Service Portal</span><span class="user-name">${esc(u.name)}</span></header>${inner}</div></body></html>`;
    if (id === 'sc_cat_item') {
      const item = store.table('sc_cat_item').get(url.searchParams.get('sys_id') ?? '');
      if (!item) return shell('Not found', '<div class="alert alert-danger" role="alert">Item not found</div>');
      const vars = store.find('item_option_new', (v) => v.cat_item === item.sys_id).sort((a, b) => Number(a.order) - Number(b.order));
      const control = (v: Rec) => {
        const fid = `sp_formfield_${v.name}`;
        if (v.type === VAR_TYPE.selectBox) {
          const choices = store.find('question_choice', (c) => c.question === v.sys_id);
          return `<select id="${fid}" name="${v.name}" class="form-control" data-mandatory="${v.mandatory}"><option value="">-- None --</option>${choices.map((c) => `<option value="${esc(c.value)}">${esc(c.text)}</option>`).join('')}</select>`;
        }
        if (v.type === VAR_TYPE.multiLine) return `<textarea id="${fid}" name="${v.name}" class="form-control" data-mandatory="${v.mandatory}"></textarea>`;
        if (v.type === VAR_TYPE.checkbox) return `<input type="checkbox" id="${fid}" name="${v.name}" value="true" data-mandatory="false">`;
        return `<input id="${fid}" name="${v.name}" class="form-control" data-mandatory="${v.mandatory}">`;
      };
      const js = `function spOrder(){var f=document.getElementById('sc_cat_item_form');var miss=[];f.querySelectorAll('[data-mandatory="true"]').forEach(function(el){if(!el.value.trim())miss.push(el.closest('.form-group').querySelector('.field-label-text').textContent);});
var a=document.getElementById('sp_messages');if(miss.length){a.innerHTML='<div class="alert alert-danger" role="alert">The following mandatory fields are not filled in: '+miss.join(', ')+'</div>';return false;}
document.getElementById('order_now').disabled=true;setTimeout(function(){f.submit()},${delay});return false;}`;
      return shell(item.name, `<div class="sc-cat-item"><h1 class="sc-cat-item-name">${esc(item.name)}</h1><p class="sc-cat-item-short-description">${esc(item.short_description)}</p>
<div id="sp_messages"></div><form id="sc_cat_item_form" method="post" action="/sp/order"><input type="hidden" name="sys_id" value="${item.sys_id}">
${vars.map((v) => `<div class="form-group sp-variable" id="sp_formfield_container_${v.name}"><label class="field-label" for="sp_formfield_${v.name}">${v.mandatory === 'true' ? '<span class="field-decorations"><span class="fa fa-asterisk mandatory" aria-label="Required"></span></span>' : ''}<span class="field-label-text">${esc(v.question_text)}</span></label>${control(v)}</div>`).join('')}
<button type="button" class="btn btn-primary btn-block" id="order_now" name="order_now" onclick="return spOrder()">Order Now</button></form></div><script>${js}</script>`);
    }
    if (id === 'order_status') {
      const reqRec = store.table('sc_request').get(url.searchParams.get('sys_id') ?? '');
      if (!reqRec) return shell('Not found', '<div class="alert alert-danger" role="alert">Request not found</div>');
      const items = store.find('sc_req_item', (r) => r.request === reqRec.sys_id);
      return shell('Order status', `<div class="order-status"><h2 class="panel-title">Thank you, your request has been submitted</h2><div>Request Number: <b class="request-number" id="request_number">${esc(reqRec.number)}</b></div>
<ul class="requested-items">${items.map((i) => `<li class="requested-item" data-number="${esc(i.number)}">${esc(i.number)} ${esc(displayOf('sc_cat_item', store.table('sc_cat_item').get(i.cat_item)))}</li>`).join('')}</ul></div>`);
    }
    const items = store.find('sc_cat_item', (i) => i.active === 'true');
    return shell('Service Catalog', `<div class="sc-category"><h1>Service Catalog</h1>${items.map((i) => `<a class="sc-cat-item-tile" href="/sp?id=sc_cat_item&sys_id=${i.sys_id}">${esc(i.name)}</a>`).join('')}</div>`);
  }

  // ---------------------------------------------------------------- UI handlers
  async function ui(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (path === '/login.do') {
      if (req.method === 'POST') {
        const p = new URLSearchParams(await body(req));
        const u = users.find((x) => x.userName === p.get('user_name') && x.password === p.get('user_password'));
        if (!u) return send(res, 200, loginPage('User name or password invalid'));
        const sid = randomBytes(16).toString('hex');
        sessions.set(sid, { user: u, flash: [] });
        return redirect(res, p.get('sysparm_goto_url') || '/navpage.do', { 'set-cookie': `glide_session_store=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      }
      return send(res, 200, loginPage());
    }
    const s = sessionOf(req);
    if (!s) return redirect(res, `/login.do?sysparm_goto_url=${encodeURIComponent(path + url.search)}`);
    const u = s.user;
    const flash = s.flash.splice(0);
    if (path === '/logout.do') {
      sessions.delete(cookies(req).glide_session_store ?? '');
      return redirect(res, '/login.do');
    }
    if (path === '/navpage.do' || path === '/') {
      return send(res, 200, page('Home', `<nav id="nav_west" aria-label="Application Navigator"><input id="filter" placeholder="Filter navigator"><ul class="app-navigator">
${['incident', 'change_request'].filter((t) => tableAccess(u, t) !== 'none').map((t) => `<li class="nav-module"><a href="/${t}_list.do">${esc(tableDef(t)!.label)}s</a></li>`).join('')}</ul></nav><h1 class="homepage-title">Welcome, ${esc(u.name)}</h1>`, u));
    }
    if (path === '/_ac') {
      const table = url.searchParams.get('table') ?? '';
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      if (tableAccess(u, table) === 'none') return json(res, 200, []);
      return json(res, 200, rowsOf(table).filter((r) => displayOf(table, r).toLowerCase().startsWith(q)).slice(0, 10).map((r) => ({ sys_id: r.sys_id, name: displayOf(table, r) })));
    }
    if (path === '/sp') return send(res, 200, renderPortal(u, url));
    if (path === '/sp/order' && req.method === 'POST') {
      const p = new URLSearchParams(await body(req));
      const item = store.table('sc_cat_item').get(p.get('sys_id') ?? '');
      if (!item) return send(res, 404, 'no item');
      const vars: Record<string, string> = {};
      for (const v of store.find('item_option_new', (x) => x.cat_item === item.sys_id)) vars[v.name] = p.get(v.name) ?? (v.type === VAR_TYPE.checkbox ? 'false' : '');
      const reqRec = store.insert('sc_request', { requested_for: u.sysId, opened_by: u.sysId, state: '1', active: 'true', short_description: item.name }, 'REQ');
      store.insert('sc_req_item', { request: reqRec.sys_id, cat_item: item.sys_id, requested_for: u.sysId, opened_by: u.sysId, state: '1', active: 'true', short_description: item.name, variables: JSON.stringify(vars) }, 'RITM');
      return redirect(res, `/sp?id=order_status&sys_id=${reqRec.sys_id}`);
    }
    const lm = /^\/(\w+)_list\.do$/.exec(path);
    if (lm && tableDef(lm[1])) {
      if (tableAccess(u, lm[1]) === 'none') return send(res, 403, page('Security', '<div class="outputmsg outputmsg_error" role="alert"><span class="outputmsg_text">Security constraints prevent access to requested page</span></div>', u));
      return send(res, 200, renderList(u, lm[1], url.searchParams.get('sysparm_query') ?? ''));
    }
    const fm = /^\/(\w+)\.do$/.exec(path);
    if (fm && tableDef(fm[1])) {
      const table = fm[1];
      if (tableAccess(u, table) === 'none') return send(res, 403, page('Security', '<div class="outputmsg outputmsg_error" role="alert"><span class="outputmsg_text">Security constraints prevent access to requested page</span></div>', u));
      const sysId = url.searchParams.get('sys_id') ?? '-1';
      const isNew = sysId === '-1';
      if (req.method === 'GET') {
        const rec = isNew ? { number: '', state: '1' } : store.tables.get(table)?.get(sysId);
        if (!rec) return send(res, 404, page('Not found', '<div class="outputmsg outputmsg_error" role="alert"><span class="outputmsg_text">Record not found</span></div>', u));
        if (!isNew && !u.roles.includes('itil') && !u.roles.includes('admin') && rec.caller_id !== u.sysId) {
          return send(res, 403, page('Security', '<div class="outputmsg outputmsg_error" role="alert"><span class="outputmsg_text">Security constraints prevent access to requested page</span></div>', u));
        }
        return send(res, 200, renderForm(u, table, rec as Rec, isNew, flash));
      }
      const p = new URLSearchParams(await body(req));
      const action = p.get('sys_action') ?? '';
      const posted: Rec = {};
      for (const f of fieldsOf(table)) {
        const v = p.get(`${table}.${f.element}`);
        if (v !== null && fieldAccess(u, f, table) === 'write' && !f.readOnly) posted[f.element] = v;
      }
      const rec = isNew ? undefined : store.tables.get(table)?.get(sysId);
      const merged: Rec = { ...(rec ?? {}), ...posted };
      if (action === 'sysverb_delete' && rec) {
        store.table(table).delete(rec.sys_id);
        s.flash.push({ type: 'info', text: `Record deleted` });
        return redirect(res, `/${table}_list.do`);
      }
      // Business rule (before insert/update): Priority 1 incidents need an assignment group.
      if (table === 'incident' && merged.priority === '1' && !merged.assignment_group) {
        return send(res, 200, renderForm(u, table, { ...merged, number: rec?.number ?? '' }, isNew, [{ type: 'error', text: 'Assignment group is required for Priority 1 incidents' }, { type: 'error', text: isNew ? 'Invalid insert' : 'Invalid update' }]));
      }
      if (action === 'resolve_incident') merged.state = '6';
      let saved: Rec;
      if (isNew) saved = store.insert(table, { active: 'true', opened_at: '2026-10-23 08:00:00', state: '1', ...merged }, tableDef(table)!.numberPrefix);
      else {
        Object.assign(rec!, merged);
        saved = rec!;
      }
      s.flash.push({ type: 'info', text: isNew ? `${tableDef(table)!.label} ${saved.number} created` : action === 'resolve_incident' ? `${tableDef(table)!.label} ${saved.number} resolved` : `${tableDef(table)!.label} ${saved.number} updated` });
      return redirect(res, `/${table}.do?sys_id=${saved.sys_id}`);
    }
    send(res, 404, page('Not found', '<p>Not found</p>', u));
  }

  const loginPage = (error?: string) => page('Log in', `<form id="loginPage" method="post" action="/login.do"><h1>Log in</h1>${error ? `<div class="outputmsg outputmsg_error" role="alert"><span class="outputmsg_text">${esc(error)}</span></div>` : ''}
<label for="user_name">User name</label><input id="user_name" name="user_name"><label for="user_password">Password</label><input id="user_password" name="user_password" type="password">
<input type="hidden" name="sysparm_goto_url" id="sysparm_goto_url" value=""><button id="sysverb_login" type="submit">Log in</button></form>
<script>document.getElementById('sysparm_goto_url').value=new URLSearchParams(location.search).get('sysparm_goto_url')||'';</script>`);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (async () => {
      if (url.pathname === '/oauth_token.do' && req.method === 'POST') {
        stats.tokenRequests++;
        const p = new URLSearchParams(await body(req));
        if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return json(res, 401, { error: 'access_denied', error_description: 'Invalid client' });
        let u: MockUser | undefined;
        if (p.get('grant_type') === 'password') u = users.find((x) => x.userName === p.get('username') && x.password === p.get('password'));
        else if (p.get('grant_type') === 'client_credentials') u = integration;
        if (!u) return json(res, 401, { error: 'access_denied', error_description: 'Invalid credentials' });
        const tok = randomBytes(24).toString('base64url');
        tokens.set(tok, u);
        return json(res, 200, { access_token: tok, refresh_token: randomBytes(12).toString('hex'), scope: 'useraccount', token_type: 'Bearer', expires_in: 1799 });
      }
      if (url.pathname.startsWith('/api/now/table/')) return tableApi(req, res, url);
      return ui(req, res, url);
    })().catch((e: unknown) => {
      if (e instanceof ApiError) return json(res, e.status, { error: { message: e.message, detail: e.detail }, status: 'failure' });
      json(res, 500, { error: { message: (e as Error).message }, status: 'failure' });
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    tokenUrl: `${url}/oauth_token.do`,
    clientId,
    clientSecret,
    users: {
      admin: { username: admin.userName, password: admin.password },
      itil: { username: itil.userName, password: itil.password },
      employee: { username: employee.userName, password: employee.password },
      integration: { username: integration.userName, password: integration.password },
    },
    store,
    stats,
    commitUpdateSet(name) {
      const set = store.find('sys_update_set', (x) => x.name === name)[0];
      if (!set) throw new Error(`no update set ${name}`);
      for (const x of store.find('sys_update_xml', (r) => r.update_set === set.sys_id)) {
        const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(x.payload)?.[1];
        if (x.name.startsWith('sys_documentation_')) labelOverride.set(`${tag('name')}.${tag('element')}`, tag('label')!);
        else if (x.name.startsWith('sys_dictionary_')) {
          const f = fields.find((y) => y.table === tag('name') && y.element === tag('element'));
          if (f) f.mandatory = tag('mandatory') === 'true';
          else fields.push({ table: tag('name')!, element: tag('element')!, label: tag('column_label')!, type: tag('internal_type') as MockField['type'], mandatory: tag('mandatory') === 'true', onForm: true });
        } else if (x.name.startsWith('sys_choice_')) {
          const f = fields.find((y) => y.table === tag('name') && y.element === tag('element'));
          if (f?.choices) f.choices = f.choices.filter((c) => c.value !== tag('value'));
        } else if (x.name.startsWith('sys_ui_action_')) {
          const a = store.table('sys_ui_action').get(tag('sys_id') ?? '');
          if (a) a.active = tag('active') ?? a.active;
        } else if (x.name.startsWith('item_option_new_') && x.action === 'DELETE') {
          store.table('item_option_new').delete(tag('sys_id') ?? '');
        }
      }
      set.state = 'committed';
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServiceNowMock({ port: Number(process.env.PORT ?? 8095) });
  console.log(`ServiceNow mock on ${s.url}`);
  for (const [r, u] of Object.entries(s.users)) console.log(`  ${r}: ${u.username} / ${u.password}`);
}
