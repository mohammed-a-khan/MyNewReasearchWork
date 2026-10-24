/**
 * A faithful-enough Salesforce mock for EZTest's Salesforce adapter.
 *
 *  - Lightning Experience-like UI (/lightning/...) built from web components
 *    with open shadow roots: navigation bar + App Launcher, list views
 *    (lightning-datatable with row actions), record pages (highlights panel,
 *    details, path, related lists), the record create/edit modal (inputs,
 *    comboboxes, dependent picklists, lookups with type-ahead, textarea,
 *    checkbox, currency, date), toasts and field-level / page-level errors.
 *  - Login page (username/password) issuing an HttpOnly session cookie.
 *  - REST API subset under /services/data/v61.0: OAuth2 token endpoint
 *    (password + client_credentials grants), describeGlobal, sObject describe,
 *    record CRUD, SOQL query (small, safe parser) and the tabs resource.
 *  - Profiles + field-level security: rep@ez.test cannot edit AnnualRevenue,
 *    cannot see NumberOfEmployees and has no access to Case (no Cases tab).
 *  - setRelease('Spring' | 'Summer' | 'Winter') switches the org metadata
 *    (relabel, new required field, changed picklist values) for impact analysis.
 *
 * Run standalone: `npx tsx examples/salesforce-mock/server.ts`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  encodeValidFor, fieldAccess, MockStore, nameFieldOf, objectsFor, PROFILES, recordName, seed, validationRules,
  type FieldAccess, type MockField, type MockObject, type MockProfile, type MockRecord, type MockUser, type Release, type SfError, type Value,
} from './model.js';
import { parseSoql, runSoql, SoqlError } from './soql.js';
import { formatCurrency, formatDate, renderLogin, renderPage, type PageData, type UiField, type UiRow } from './ui.js';

export interface SalesforceMockOptions {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  release?: Release;
  /** Simulated server latency for UI saves (ms). Default 200. */
  saveDelayMs?: number;
  /** The list view header (title and New button) renders this long after the page (ms), like a slow Lightning org. Default 0. */
  listHeaderDelayMs?: number;
  tokenTtlSeconds?: number;
  /** Fixed passwords (default: generated per start). */
  passwords?: { admin?: string; rep?: string };
}

export interface SalesforceMockServer {
  url: string;
  tokenUrl: string;
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  users: { admin: { username: string; password: string }; rep: { username: string; password: string } };
  store: MockStore;
  stats: { tokenRequests: number; describeRequests: number; apiRequests: number; queries: string[] };
  readonly release: Release;
  setRelease(r: Release): void;
  /** Invalidate every issued access token (simulates session expiry). */
  expireTokens(): void;
  objects(): MockObject[];
  close(): Promise<void>;
}

const API_VERSION = '61.0';
const ID_RE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

class HttpError extends Error {
  constructor(readonly status: number, readonly errors: SfError[]) {
    super(errors.map((e) => e.message).join('; '));
  }
}
const err = (status: number, errorCode: string, message: string, fields: string[] = []) => new HttpError(status, [{ errorCode, message, fields }]);

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json;charset=UTF-8', ...headers });
  res.end(JSON.stringify(body));
}
function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}
function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const t = await readBody(req);
  if (!t.trim()) return {};
  try {
    const v = JSON.parse(t) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw err(400, 'JSON_PARSER_ERROR', 'The request body is not valid JSON.');
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const SOAP: Record<string, string> = {
  id: 'tns:ID', string: 'xsd:string', textarea: 'xsd:string', picklist: 'xsd:string', currency: 'xsd:double', date: 'xsd:date', datetime: 'xsd:dateTime',
  boolean: 'xsd:boolean', reference: 'tns:ID', phone: 'xsd:string', email: 'xsd:string', double: 'xsd:double', int: 'xsd:int', percent: 'xsd:double', url: 'xsd:string',
};
const NUMERIC = new Set(['currency', 'double', 'int', 'percent']);

export async function startSalesforceMock(opts: SalesforceMockOptions = {}): Promise<SalesforceMockServer> {
  const clientId = opts.clientId ?? '3MVG9eztest.mock.consumer.key';
  const clientSecret = opts.clientSecret ?? 'sf-' + randomBytes(8).toString('hex');
  const saveDelay = opts.saveDelayMs ?? 200;
  const ttl = opts.tokenTtlSeconds ?? 7200;
  let release: Release = opts.release ?? 'Spring';
  const store = new MockStore();
  seed(store, objectsFor(release));
  const users: MockUser[] = [
    { id: '0055g00000AdMiNAAV', username: 'admin@ez.test', name: 'Ada Admin', profile: 'System Administrator', password: opts.passwords?.admin ?? 'Adm-' + randomBytes(6).toString('hex') },
    { id: '0055g00000RePuSAAR', username: 'rep@ez.test', name: 'Rex Rep', profile: 'Sales Rep', password: opts.passwords?.rep ?? 'Rep-' + randomBytes(6).toString('hex') },
  ];
  const tokens = new Map<string, { user: MockUser; exp: number }>();
  const sessions = new Map<string, MockUser>();
  const stats = { tokenRequests: 0, describeRequests: 0, apiRequests: 0, queries: [] as string[] };

  const objects = () => objectsFor(release);
  const objectByName = (n: string) => objects().find((o) => o.name.toLowerCase() === n.toLowerCase());
  const profileOf = (u: MockUser): MockProfile => PROFILES[u.profile];
  const canRead = (u: MockUser, o: MockObject) => !!profileOf(u).objects[o.name]?.read;
  const access = (u: MockUser, o: MockObject, f: MockField): FieldAccess => fieldAccess(profileOf(u), o, f);
  const visible = (u: MockUser, o: MockObject) => o.fields.filter((f) => access(u, o, f) !== 'hidden');
  const recordPath = (obj: string, id: string) => `/services/data/v${API_VERSION}/sobjects/${obj}/${id}`;

  // ---------------------------------------------------------------- formatting

  function display(o: MockObject, f: MockField, v: Value): string {
    if (v === null || v === undefined) return '';
    switch (f.type) {
      case 'currency': return typeof v === 'number' ? formatCurrency(v) : String(v);
      case 'date': return formatDate(String(v));
      case 'percent': return `${String(v)}%`;
      case 'int': return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'picklist': return f.picklist?.find((p) => p.value === v)?.label ?? String(v);
      case 'reference': {
        const t = objectByName(f.referenceTo?.[0] ?? '');
        const r = t ? store.get(t.name, String(v)) : undefined;
        return t && r ? recordName(t, r) : '';
      }
      default: return String(v);
    }
  }

  function recordView(u: MockUser, o: MockObject, rec: MockRecord): NonNullable<PageData['record']> {
    const values: Record<string, unknown> = {};
    const disp: Record<string, string> = {};
    const links: Record<string, string> = {};
    for (const f of visible(u, o)) {
      const v = rec[f.name] ?? null;
      values[f.name] = v;
      disp[f.name] = display(o, f, v);
      if (f.type === 'reference' && typeof v === 'string' && disp[f.name]) links[f.name] = `/lightning/r/${f.referenceTo![0]}/${v}/view`;
    }
    return { id: String(rec.Id), name: recordName(o, rec), values, display: disp, links };
  }

  // ---------------------------------------------------------------- describe

  function fieldJson(u: MockUser, o: MockObject, f: MockField): Record<string, unknown> {
    const a = access(u, o, f);
    const writable = a === 'edit' && !f.system && f.type !== 'id';
    const controller = f.controllerName ? o.fields.find((x) => x.name === f.controllerName) : undefined;
    const controllerValues = controller?.picklist?.map((p) => p.value) ?? [];
    return {
      aggregatable: f.type !== 'textarea', autoNumber: o.name === 'Case' && f.name === 'CaseNumber', byteLength: (f.length ?? 0) * 3,
      calculated: !!f.system && f.type !== 'id' && f.name !== 'CaseNumber', caseSensitive: false,
      controllerName: f.controllerName ?? null, createable: writable, custom: !!f.custom, defaultValue: null,
      defaultedOnCreate: f.type === 'id' || f.type === 'boolean' || f.name === 'CaseNumber', dependentPicklist: !!f.controllerName,
      digits: f.type === 'int' ? 9 : 0, externalId: false, filterable: f.type !== 'textarea', groupable: !NUMERIC.has(f.type) && f.type !== 'textarea',
      htmlFormatted: false, idLookup: f.type === 'id', inlineHelpText: null, label: f.label, length: f.length ?? 0,
      name: f.name, nameField: !!f.nameField, nillable: !f.required && f.type !== 'id' && f.type !== 'boolean', permissionable: !f.required && !f.system,
      picklistValues: (f.picklist ?? []).map((p) => ({
        active: true, defaultValue: !!p.defaultValue, label: p.label,
        validFor: f.controllerName ? encodeValidFor(controllerValues, p.validFor ?? []) : null, value: p.value,
      })),
      precision: f.type === 'currency' ? 18 : f.type === 'percent' ? 3 : 0, referenceTo: f.referenceTo ?? [], relationshipName: f.relationshipName ?? null,
      restrictedPicklist: f.type === 'picklist', scale: f.type === 'currency' ? 2 : 0, soapType: SOAP[f.type], sortable: f.type !== 'textarea',
      type: f.type, unique: false, updateable: writable,
    };
  }

  function describeJson(u: MockUser, o: MockObject): Record<string, unknown> {
    const op = profileOf(u).objects[o.name]!;
    return {
      activateable: false, createable: op.create, custom: false, customSetting: false, deletable: op.delete, feedEnabled: true,
      keyPrefix: o.keyPrefix, label: o.label, labelPlural: o.labelPlural, layoutable: true, mergeable: o.name !== 'Opportunity', name: o.name,
      queryable: true, replicateable: true, retrieveable: true, searchable: true, triggerable: true, undeletable: op.delete, updateable: op.edit,
      fields: visible(u, o).map((f) => fieldJson(u, o, f)),
      childRelationships: objects().flatMap((c) =>
        c.fields.filter((f) => f.type === 'reference' && f.referenceTo?.includes(o.name)).map((f) => ({
          cascadeDelete: false, childSObject: c.name, field: f.name, relationshipName: o.related.find((r) => r.childObject === c.name && r.field === f.name)?.relationshipName ?? null,
        })),
      ),
      recordTypeInfos: [],
      urls: { describe: `/services/data/v${API_VERSION}/sobjects/${o.name}/describe`, sobject: `/services/data/v${API_VERSION}/sobjects/${o.name}`, rowTemplate: `/services/data/v${API_VERSION}/sobjects/${o.name}/{ID}` },
    };
  }

  // ---------------------------------------------------------------- writes (shared by REST and the UI)

  /** Validate a write as user `u`; returns the merged record or the errors. */
  function validateWrite(u: MockUser, o: MockObject, existing: MockRecord | undefined, values: MockRecord): { errors: SfError[]; merged: MockRecord } {
    const errors: SfError[] = [];
    const op = profileOf(u).objects[o.name];
    if (!op || !(existing ? op.edit : op.create)) {
      return { errors: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: `insufficient access rights on object ${o.name}`, fields: [] }], merged: {} };
    }
    const merged: MockRecord = { ...(existing ?? {}) };
    const readOnly: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      const f = o.fields.find((x) => x.name.toLowerCase() === k.toLowerCase());
      if (!f || access(u, o, f) === 'hidden') {
        errors.push({ errorCode: 'INVALID_FIELD', message: `No such column '${k}' on sobject of type ${o.name}`, fields: [k] });
        continue;
      }
      if (access(u, o, f) !== 'edit' || f.system) {
        readOnly.push(f.name);
        continue;
      }
      if (v !== null && f.type === 'picklist') {
        const ok = f.picklist?.some((p) => p.value === v);
        if (!ok) errors.push({ errorCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', message: `${f.label}: bad value for restricted picklist field: ${String(v)}`, fields: [f.name] });
      }
      if (v !== null && f.type === 'reference') {
        const target = objectByName(f.referenceTo?.[0] ?? '');
        if (typeof v !== 'string' || !ID_RE.test(v)) errors.push({ errorCode: 'MALFORMED_ID', message: `${f.label}: id value of incorrect type: ${String(v)}`, fields: [f.name] });
        else if (!target || !store.get(target.name, v)) errors.push({ errorCode: 'FIELD_INTEGRITY_EXCEPTION', message: `field integrity exception: unknown (${f.label})`, fields: [f.name] });
      }
      if (typeof v === 'string' && f.length && v.length > f.length) {
        errors.push({ errorCode: 'STRING_TOO_LONG', message: `${f.label}: data value too large: ${v.slice(0, 20)}... (max length=${f.length})`, fields: [f.name] });
      }
      merged[f.name] = v === '' ? null : v;
    }
    if (readOnly.length) {
      errors.push({
        errorCode: 'INVALID_FIELD_FOR_INSERT_UPDATE',
        message: `Unable to create/update fields: ${readOnly.join(', ')}. Please check the security settings of this field and verify that it is read/write for your profile or permission set.`,
        fields: readOnly,
      });
    }
    // Dependent picklists must match their controller.
    for (const f of o.fields.filter((x) => x.controllerName)) {
      const v = merged[f.name];
      if (v === null || v === undefined) continue;
      const cv = merged[f.controllerName!];
      const pv = f.picklist?.find((p) => p.value === v);
      if (pv && (typeof cv !== 'string' || !(pv.validFor ?? []).includes(cv))) {
        errors.push({ errorCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', message: `${f.label}: bad value for restricted picklist field: ${String(v)}`, fields: [f.name] });
      }
    }
    const missing = o.fields.filter((f) => f.required && !f.system && (merged[f.name] === null || merged[f.name] === undefined || merged[f.name] === ''));
    if (missing.length) {
      errors.push({ errorCode: 'REQUIRED_FIELD_MISSING', message: `Required fields are missing: [${missing.map((f) => f.name).join(', ')}]`, fields: missing.map((f) => f.name) });
    }
    if (!errors.length) errors.push(...validationRules(o, merged));
    return { errors, merged };
  }

  /** Convert REST JSON values (strict types) for a write. */
  function coerceApi(o: MockObject, body: Record<string, unknown>): MockRecord {
    const out: MockRecord = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'attributes') continue;
      const f = o.fields.find((x) => x.name.toLowerCase() === k.toLowerCase());
      if (!f || v === null) {
        out[f?.name ?? k] = v === null ? null : (v as Value);
        continue;
      }
      const bad = (want: string) => err(400, 'JSON_PARSER_ERROR', `Cannot deserialize instance of ${want} from ${typeof v === 'string' ? 'VALUE_STRING' : 'VALUE_' + typeof v} value ${JSON.stringify(v)} or request may be missing a required field`);
      if (NUMERIC.has(f.type)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || (f.type === 'int' && !Number.isInteger(v))) throw bad(f.type);
        out[f.name] = v;
      } else if (f.type === 'boolean') {
        if (typeof v !== 'boolean') throw bad('boolean');
        out[f.name] = v;
      } else if (f.type === 'date') {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad('date');
        out[f.name] = v;
      } else {
        if (typeof v !== 'string') throw bad(f.type);
        out[f.name] = v;
      }
    }
    return out;
  }

  /** Convert UI form values (strings from inputs) for a write; format problems become field errors. */
  function coerceUi(o: MockObject, values: Record<string, unknown>, fieldErrors: Record<string, string>): MockRecord {
    const out: MockRecord = {};
    for (const [k, v] of Object.entries(values)) {
      const f = o.fields.find((x) => x.name === k);
      if (!f) throw err(400, 'INVALID_FIELD', `Field ${k} is not on the layout.`);
      if (v === null || v === undefined || v === '') {
        out[k] = f.type === 'boolean' ? false : null;
        continue;
      }
      if (NUMERIC.has(f.type)) {
        const t = String(v).replace(/[$,\s%]/g, '');
        if (!/^-?\d+(?:\.\d+)?$/.test(t) || (f.type === 'int' && t.includes('.'))) fieldErrors[k] = `Enter a valid value.`;
        else out[k] = Number(t);
      } else if (f.type === 'date') {
        const s = String(v).trim();
        let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
        if (m) out[k] = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        else if ((m = /^\d{4}-\d{2}-\d{2}$/.exec(s))) out[k] = s;
        else fieldErrors[k] = 'Your entry does not match the allowed format M/d/yyyy.';
      } else if (f.type === 'boolean') out[k] = v === true || v === 'true';
      else out[k] = String(v);
    }
    return out;
  }

  // ---------------------------------------------------------------- OAuth

  async function handleToken(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    stats.tokenRequests++;
    const p = new URLSearchParams(await readBody(req));
    const grant = p.get('grant_type');
    if (p.get('client_id') !== clientId) return sendJson(res, 400, { error: 'invalid_client_id', error_description: 'client identifier invalid' });
    if (p.get('client_secret') !== clientSecret) return sendJson(res, 400, { error: 'invalid_client', error_description: 'invalid client credentials' });
    let user: MockUser | undefined;
    if (grant === 'password') {
      user = users.find((u) => u.username === p.get('username') && u.password === p.get('password'));
      if (!user) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'authentication failure' });
    } else if (grant === 'client_credentials') {
      user = users[0];
    } else return sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'grant type not supported' });
    const token = `00D5g000004EZTE!AR${randomBytes(24).toString('base64url')}`;
    tokens.set(token, { user, exp: Date.now() + ttl * 1000 });
    sendJson(res, 200, {
      access_token: token, instance_url: url.origin, id: `${url.origin}/id/00D5g000004EZTEEA2/${user.id}`, token_type: 'Bearer',
      issued_at: String(Date.now()), signature: randomBytes(16).toString('base64'), scope: 'api',
    });
  }

  function apiUser(req: IncomingMessage): MockUser {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const t = m ? tokens.get(m[1]) : undefined;
    if (!t || t.exp < Date.now()) throw err(401, 'INVALID_SESSION_ID', 'Session expired or invalid');
    return t.user;
  }

  // ---------------------------------------------------------------- REST

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, rest: string): Promise<void> {
    stats.apiRequests++;
    const u = apiUser(req);
    const method = req.method ?? 'GET';
    let m: RegExpExecArray | null;
    const readable = (name: string) => {
      const o = objectByName(name);
      if (!o || !canRead(u, o)) throw err(404, 'NOT_FOUND', 'The requested resource does not exist');
      return o;
    };
    if (rest === 'sobjects' && method === 'GET') {
      return sendJson(res, 200, {
        encoding: 'UTF-8', maxBatchSize: 200,
        sobjects: objects().filter((o) => canRead(u, o)).map((o) => {
          const op = profileOf(u).objects[o.name]!;
          return { name: o.name, label: o.label, labelPlural: o.labelPlural, keyPrefix: o.keyPrefix, custom: false, createable: op.create, updateable: op.edit, deletable: op.delete, queryable: true, urls: { sobject: `/services/data/v${API_VERSION}/sobjects/${o.name}` } };
        }),
      });
    }
    if (rest === 'tabs' && method === 'GET') {
      return sendJson(res, 200, profileOf(u).tabs.map((n) => {
        const o = objectByName(n)!;
        return { label: o.labelPlural, name: `standard-${o.name}`, sobjectName: o.name, url: `${url.origin}/lightning/o/${o.name}/home`, custom: false };
      }));
    }
    if ((m = /^sobjects\/(\w+)\/describe$/.exec(rest)) && method === 'GET') {
      stats.describeRequests++;
      return sendJson(res, 200, describeJson(u, readable(m[1])));
    }
    if ((m = /^sobjects\/(\w+)$/.exec(rest))) {
      const o = readable(m[1]);
      if (method !== 'POST') throw err(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed. Allowed are HEAD,GET,POST`);
      const { errors, merged } = validateWrite(u, o, undefined, coerceApi(o, await readJson(req)));
      if (errors.length) throw new HttpError(400, errors);
      const id = store.insert(o, merged);
      return sendJson(res, 201, { id, success: true, errors: [] });
    }
    if ((m = /^sobjects\/(\w+)\/([A-Za-z0-9]+)$/.exec(rest))) {
      const o = readable(m[1]);
      if (!ID_RE.test(m[2])) throw err(400, 'MALFORMED_ID', `Invalid id: ${m[2]}`);
      const rec = store.get(o.name, m[2]);
      if (!rec) throw err(404, 'NOT_FOUND', 'The requested resource does not exist');
      const id = String(rec.Id);
      if (method === 'GET') {
        const want = url.searchParams.get('fields');
        const vis = visible(u, o);
        let fields = vis;
        if (want) {
          fields = want.split(',').map((n) => {
            const f = vis.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
            if (!f) throw err(400, 'INVALID_FIELD', `No such column '${n.trim()}' on sobject of type ${o.name}`);
            return f;
          });
        }
        const out: Record<string, unknown> = { attributes: { type: o.name, url: recordPath(o.name, id) } };
        for (const f of fields) out[f.name] = rec[f.name] ?? null;
        out.Id = id;
        return sendJson(res, 200, out);
      }
      if (method === 'PATCH') {
        const { errors, merged } = validateWrite(u, o, rec, coerceApi(o, await readJson(req)));
        if (errors.length) throw new HttpError(400, errors);
        store.update(o, id, merged);
        res.writeHead(204);
        return void res.end();
      }
      if (method === 'DELETE') {
        if (!profileOf(u).objects[o.name]?.delete) throw err(400, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
        store.table(o.name).delete(id);
        res.writeHead(204);
        return void res.end();
      }
      throw err(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed. Allowed are HEAD,GET,PATCH,DELETE`);
    }
    if (rest === 'query' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      stats.queries.push(q);
      let ast;
      try {
        ast = parseSoql(q);
      } catch (e) {
        if (e instanceof SoqlError) throw err(400, e.errorCode, e.message);
        throw e;
      }
      const o = objectByName(ast.object);
      if (!o || !canRead(u, o)) {
        throw err(400, 'INVALID_TYPE', `sObject type '${ast.object}' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name. Please reference your WSDL or the describe call for the appropriate names.`);
      }
      try {
        const records = runSoql(ast, {
          obj: o,
          visible: (x) => visible(u, x),
          objectByName,
          canRead: (x) => canRead(u, x),
          lookup: (x, id) => store.get(x.name, id),
        }, [...store.table(o.name).values()], recordPath);
        return sendJson(res, 200, { totalSize: records.length, done: true, records });
      } catch (e) {
        if (e instanceof SoqlError) throw err(400, e.errorCode, e.message);
        throw e;
      }
    }
    throw err(404, 'NOT_FOUND', 'The requested resource does not exist');
  }

  // ---------------------------------------------------------------- UI

  function uiFields(u: MockUser, o: MockObject): UiField[] {
    return visible(u, o).map((f) => {
      const t = f.referenceTo?.[0] ? objectByName(f.referenceTo[0]) : undefined;
      return {
        name: f.name, label: f.label, type: f.type, required: !!f.required, access: access(u, o, f) === 'edit' ? 'edit' : 'read', system: !!f.system || f.type === 'id',
        ...(f.picklist ? { picklist: f.picklist.map((p) => ({ value: p.value, label: p.label, ...(p.validFor ? { validFor: p.validFor } : {}) })) } : {}),
        ...(f.controllerName ? { controllerName: f.controllerName } : {}),
        ...(t ? { referenceTo: t.name, referencePlural: t.labelPlural } : {}),
      };
    });
  }

  function shell(u: MockUser, kind: PageData['kind'], title: string): PageData {
    const p = profileOf(u);
    const tab = (n: string) => {
      const o = objectByName(n)!;
      return { object: o.name, label: o.labelPlural, url: `/lightning/o/${o.name}/list?filterName=Recent` };
    };
    return {
      kind, title, user: { name: u.name, username: u.username },
      nav: ['Account', 'Opportunity', 'Case'].filter((n) => p.tabs.includes(n)).map(tab),
      launcher: p.tabs.map(tab),
    };
  }

  function objectInfo(u: MockUser, o: MockObject): NonNullable<PageData['object']> {
    const op = profileOf(u).objects[o.name]!;
    return { name: o.name, label: o.label, labelPlural: o.labelPlural, canCreate: op.create, canDelete: op.delete, nameField: nameFieldOf(o).name };
  }

  function noAccess(res: ServerResponse, u: MockUser): void {
    const d = shell(u, 'error', 'Insufficient Privileges');
    d.error = { title: 'Insufficient Privileges', message: 'You do not have the level of access necessary to perform the operation you requested. Please contact the owner of the record or your administrator if access is necessary.' };
    sendHtml(res, 403, renderPage(d));
  }

  function listPage(u: MockUser, o: MockObject, modal?: PageData['modal']): string {
    const d = shell(u, 'list', o.labelPlural);
    d.object = objectInfo(u, o);
    d.fields = uiFields(u, o);
    const vis = visible(u, o);
    d.listView = { name: 'Recently Viewed', columns: o.listColumns.map((n) => vis.find((f) => f.name === n)).filter((f): f is MockField => !!f).map((f) => ({ field: f.name, label: f.label })) };
    if (opts.listHeaderDelayMs) d.listHeaderDelayMs = opts.listHeaderDelayMs;
    if (modal) {
      d.modal = modal;
      d.record = { id: '', name: '', values: {}, display: {}, links: {} };
    }
    return renderPage(d);
  }

  function rowsOf(u: MockUser, o: MockObject, recs: MockRecord[], columns: string[]): UiRow[] {
    const vis = visible(u, o);
    return recs
      .sort((a, b) => recordName(o, a).localeCompare(recordName(o, b)))
      .map((r) => ({
        id: String(r.Id), url: `/lightning/r/${o.name}/${String(r.Id)}/view`,
        cells: Object.fromEntries(columns.map((c) => {
          const f = vis.find((x) => x.name === c);
          return [c, f ? display(o, f, r[c] ?? null) : ''];
        })),
      }));
  }

  function recordPage(u: MockUser, o: MockObject, rec: MockRecord, modal?: PageData['modal']): string {
    const view = recordView(u, o, rec);
    const d = shell(u, 'record', view.name);
    d.object = objectInfo(u, o);
    d.fields = uiFields(u, o);
    d.record = view;
    d.highlights = o.highlights.filter((n) => d.fields!.some((f) => f.name === n));
    if (o.pathField) {
      const f = o.fields.find((x) => x.name === o.pathField)!;
      d.path = { field: f.name, stages: (f.picklist ?? []).map((p) => p.value).filter((v) => v !== 'Closed Lost'), current: String(rec[f.name] ?? '') };
    }
    d.related = o.related
      .map((rl) => ({ rl, child: objectByName(rl.childObject)! }))
      .filter(({ child }) => canRead(u, child))
      .map(({ rl, child }) => {
        const vis = visible(u, child);
        const cols = rl.columns.filter((c) => vis.some((f) => f.name === c));
        const recs = [...store.table(child.name).values()].filter((r) => r[rl.field] === rec.Id);
        return { label: rl.label, columns: cols.map((c) => ({ field: c, label: vis.find((f) => f.name === c)!.label })), rows: rowsOf(u, child, recs, cols) };
      });
    if (modal) d.modal = modal;
    return renderPage(d);
  }

  function sessionUser(req: IncomingMessage): MockUser | undefined {
    const sid = cookies(req).sid;
    return sid ? sessions.get(sid) : undefined;
  }

  async function handleUi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if ((path === '/' || path === '/login') && req.method === 'GET') {
      if (sessionUser(req)) return redirect(res, '/lightning/page/home');
      return sendHtml(res, 200, renderLogin({ startUrl: url.searchParams.get('startURL') ?? '' }));
    }
    if (path === '/login' && req.method === 'POST') {
      const p = new URLSearchParams(await readBody(req));
      const user = users.find((u) => u.username === p.get('username') && u.password === p.get('pw'));
      if (!user) {
        return sendHtml(res, 200, renderLogin({ username: p.get('username') ?? '', error: "Please check your username and password. If you still can't log in, contact your Salesforce administrator." }));
      }
      const sid = randomBytes(24).toString('base64url');
      sessions.set(sid, user);
      const start = p.get('startURL') ?? '';
      return redirect(res, start.startsWith('/lightning/') ? start : '/lightning/page/home', { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (path === '/secur/logout.jsp') {
      const sid = cookies(req).sid;
      if (sid) sessions.delete(sid);
      return redirect(res, '/', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    const u = sessionUser(req);
    if (path.startsWith('/_ui/')) {
      if (!u) return sendJson(res, 401, { error: 'Session expired or invalid' });
      return handleUiApi(req, res, url, u);
    }
    if (!path.startsWith('/lightning/')) return sendHtml(res, 404, '<h1>Not found</h1>');
    if (!u) return redirect(res, `/?startURL=${encodeURIComponent(path + url.search)}`);
    if (path === '/lightning/page/home') return sendHtml(res, 200, renderPage(shell(u, 'home', 'Home')));
    let m: RegExpExecArray | null;
    if ((m = /^\/lightning\/o\/(\w+)\/(list|home|new)$/.exec(path))) {
      const o = objectByName(m[1]);
      if (!o) return sendHtml(res, 404, '<h1>Page not found</h1>');
      if (!canRead(u, o) || !profileOf(u).tabs.includes(o.name)) return noAccess(res, u);
      if (m[2] === 'new') {
        if (!profileOf(u).objects[o.name]?.create) return noAccess(res, u);
        return sendHtml(res, 200, listPage(u, o, { mode: 'new', backUrl: `/lightning/o/${o.name}/list?filterName=Recent` }));
      }
      return sendHtml(res, 200, listPage(u, o));
    }
    if ((m = /^\/lightning\/r\/(\w+)\/([A-Za-z0-9]{15,18})\/(view|edit)$/.exec(path))) {
      const o = objectByName(m[1]);
      if (!o) return sendHtml(res, 404, '<h1>Page not found</h1>');
      if (!canRead(u, o)) return noAccess(res, u);
      const rec = store.get(o.name, m[2]);
      if (!rec) return sendHtml(res, 404, '<h1>Record not found</h1>');
      if (m[3] === 'edit') return sendHtml(res, 200, recordPage(u, o, rec, { mode: 'edit', backUrl: `/lightning/r/${o.name}/${String(rec.Id)}/view` }));
      return sendHtml(res, 200, recordPage(u, o, rec));
    }
    return sendHtml(res, 404, '<h1>Page not found</h1>');
  }

  async function handleUiApi(req: IncomingMessage, res: ServerResponse, url: URL, u: MockUser): Promise<void> {
    const path = url.pathname;
    const readable = (n: unknown) => {
      const o = objectByName(String(n ?? ''));
      if (!o || !canRead(u, o)) throw err(403, 'INSUFFICIENT_ACCESS', 'Insufficient Privileges');
      return o;
    };
    if (path === '/_ui/list') {
      const o = readable(url.searchParams.get('object'));
      const cols = o.listColumns.filter((c) => visible(u, o).some((f) => f.name === c));
      return sendJson(res, 200, { rows: rowsOf(u, o, [...store.table(o.name).values()], cols) });
    }
    if (path === '/_ui/lookup') {
      const o = readable(url.searchParams.get('object'));
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const nf = nameFieldOf(o).name;
      const rows = [...store.table(o.name).values()]
        .filter((r) => q && String(r[nf] ?? '').toLowerCase().includes(q))
        .sort((a, b) => String(a[nf]).localeCompare(String(b[nf])))
        .slice(0, 10)
        .map((r) => ({ id: String(r.Id), name: String(r[nf] ?? ''), meta: [o.label, r.Phone ? String(r.Phone) : ''].filter(Boolean).join(' • ') }));
      return sendJson(res, 200, rows);
    }
    if (path === '/_ui/save' && req.method === 'POST') {
      const body = await readJson(req);
      const o = readable(body.object);
      const id = typeof body.id === 'string' && body.id ? body.id : undefined;
      const existing = id ? store.get(o.name, id) : undefined;
      if (id && !existing) return sendJson(res, 404, { pageErrors: ['The record you are trying to edit has been deleted.'], fieldErrors: {} });
      const fieldErrors: Record<string, string> = {};
      const values = coerceUi(o, (body.values ?? {}) as Record<string, unknown>, fieldErrors);
      await new Promise((r) => setTimeout(r, saveDelay));
      if (Object.keys(fieldErrors).length) return sendJson(res, 400, { pageErrors: [], fieldErrors });
      const { errors, merged } = validateWrite(u, o, existing, values);
      if (errors.length) {
        const pageErrors: string[] = [];
        for (const e of errors) {
          if (e.errorCode === 'REQUIRED_FIELD_MISSING') for (const f of e.fields) fieldErrors[f] = 'Complete this field.';
          else if (e.fields.length === 1) fieldErrors[e.fields[0]] = e.message.replace(/^[^:]+: (?=bad value)/, '');
          else pageErrors.push(e.message);
        }
        return sendJson(res, 400, { pageErrors, fieldErrors });
      }
      let rid: string;
      if (existing) {
        rid = String(existing.Id);
        store.update(o, rid, merged);
      } else rid = store.insert(o, merged);
      return sendJson(res, 200, { id: rid, name: recordName(o, store.get(o.name, rid)!) });
    }
    if (path === '/_ui/path' && req.method === 'POST') {
      const body = await readJson(req);
      const o = readable(body.object);
      const rec = store.get(o.name, String(body.id ?? ''));
      if (!rec || !o.pathField) return sendJson(res, 404, { error: 'Record not found' });
      const f = o.fields.find((x) => x.name === o.pathField)!;
      const stages = (f.picklist ?? []).map((p) => p.value).filter((v) => v !== 'Closed Lost');
      const cur = stages.indexOf(String(rec[f.name] ?? ''));
      let next: string | undefined;
      if (typeof body.stage === 'string') next = stages.includes(body.stage) ? body.stage : undefined;
      else next = stages[cur + 1];
      if (!next) return sendJson(res, 400, { error: cur >= stages.length - 1 ? 'This is the last stage.' : 'Unknown stage.' });
      await new Promise((r) => setTimeout(r, saveDelay));
      const { errors, merged } = validateWrite(u, o, rec, { [f.name]: next });
      if (errors.length) return sendJson(res, 400, { error: errors.map((e) => e.message).join(' ') });
      store.update(o, String(rec.Id), merged);
      return sendJson(res, 200, { stage: next, record: recordView(u, o, store.get(o.name, String(rec.Id))!) });
    }
    if (path === '/_ui/delete' && req.method === 'POST') {
      const body = await readJson(req);
      const o = readable(body.object);
      if (!profileOf(u).objects[o.name]?.delete) return sendJson(res, 403, { error: 'insufficient access rights on object id' });
      const rec = store.get(o.name, String(body.id ?? ''));
      if (!rec) return sendJson(res, 404, { error: 'Record not found' });
      store.table(o.name).delete(String(rec.Id));
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const run = async () => {
      if (url.pathname === '/services/oauth2/token' && req.method === 'POST') return handleToken(req, res, url);
      if (url.pathname === '/services/data' || url.pathname === '/services/data/') {
        return sendJson(res, 200, [{ label: "Summer '24", url: `/services/data/v${API_VERSION}`, version: API_VERSION }]);
      }
      const api = /^\/services\/data\/v(\d+\.\d)\/(.*)$/.exec(url.pathname);
      if (api) {
        if (api[1] !== API_VERSION) throw err(404, 'NOT_FOUND', 'The requested resource does not exist');
        return handleApi(req, res, url, decodeURIComponent(api[2]).replace(/\/+$/, ''));
      }
      return handleUi(req, res, url);
    };
    run().catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) {
        if (url.pathname.startsWith('/_ui/')) return sendJson(res, e.status, { error: e.message, pageErrors: [e.message], fieldErrors: {} });
        return sendJson(res, e.status, e.errors.map((x) => ({ message: x.message, errorCode: x.errorCode, ...(x.fields.length ? { fields: x.fields } : {}) })));
      }
      sendJson(res, 500, [{ message: (e as Error).message, errorCode: 'UNKNOWN_EXCEPTION' }]);
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 0;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    tokenUrl: `${url}/services/oauth2/token`,
    apiVersion: API_VERSION,
    clientId,
    clientSecret,
    users: {
      admin: { username: users[0].username, password: users[0].password },
      rep: { username: users[1].username, password: users[1].password },
    },
    store,
    stats,
    get release() {
      return release;
    },
    setRelease(r: Release) {
      release = r;
    },
    expireTokens() {
      tokens.clear();
    },
    objects,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

const isMain = process.argv[1] && /salesforce-mock[\\/]server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const s = await startSalesforceMock({
    port: Number(process.env.PORT ?? 4610),
    release: (process.env.SF_RELEASE as Release | undefined) ?? 'Spring',
    clientSecret: process.env.SF_MOCK_SECRET ?? 'local-dev-secret',
    passwords: { admin: process.env.SF_ADMIN_PASSWORD, rep: process.env.SF_REP_PASSWORD },
  });
  process.stdout.write(`Salesforce mock at ${s.url} (consumer key ${s.clientId}; users ${s.users.admin.username}, ${s.users.rep.username}; passwords from SF_ADMIN_PASSWORD / SF_REP_PASSWORD or generated)\n`);
}
