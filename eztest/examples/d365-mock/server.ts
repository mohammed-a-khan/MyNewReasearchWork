/**
 * A faithful-enough Dynamics 365 / Dataverse mock for EZTest's D365 adapter.
 *
 *  - Unified Interface–like model-driven pages: /main.aspx?pagetype=entityrecord|entitylist&etn=...
 *  - Dataverse Web API subset under /api/data/v9.2 (EntityDefinitions metadata,
 *    record CRUD, $filter eq / $select / $top, formatted-value annotations),
 *    protected by bearer tokens from a client-credentials /token endpoint.
 *  - setReleaseWave(true) switches to "next release" metadata: telephone1 is
 *    relabelled "Main Phone" -> "Business Phone" and rendered with the phone
 *    control (new data-id), fax is removed, accountratingcode is added and
 *    accountnumber becomes required.
 *
 * The UI endpoints (/_mock/*) are unauthenticated: they stand in for the
 * browser session of a signed-in user. Run standalone: `npx tsx examples/d365-mock/server.ts`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { entities, MockStore, type MockAttribute, type MockEntity, type MockRecord, type RecordValue } from './model.js';
import { formatDate, formatMoney, listUrl, recordUrl, renderForm, renderList } from './ui.js';

export interface D365MockOptions {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  releaseWave?: boolean;
  /** Simulated server latency for form saves (ms). Default 250. */
  saveDelayMs?: number;
  tokenTtlSeconds?: number;
}

export interface D365MockServer {
  url: string;
  apiUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  store: MockStore;
  /** Count of /token requests and of Web API metadata requests (for cache tests). */
  stats: { tokenRequests: number; metadataRequests: number; apiRequests: number };
  setReleaseWave(on: boolean): void;
  readonly releaseWave: boolean;
  close(): Promise<void>;
}

const API = '/api/data/v9.2';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; odata.metadata=minimal', 'odata-version': '4.0', ...headers });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
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
    throw new HttpError(400, '0x80040333', 'The request body is not valid JSON.');
  }
}

const label = (l: string | null) => ({
  LocalizedLabels: l === null ? [] : [{ Label: l, LanguageCode: 1033, IsManaged: true }],
  UserLocalizedLabel: l === null ? null : { Label: l, LanguageCode: 1033, IsManaged: true },
});

const ODATA_TYPE: Record<string, string> = {
  String: 'StringAttributeMetadata', Memo: 'MemoAttributeMetadata', Picklist: 'PicklistAttributeMetadata', Status: 'StatusAttributeMetadata',
  State: 'StateAttributeMetadata', Money: 'MoneyAttributeMetadata', Integer: 'IntegerAttributeMetadata', Decimal: 'DecimalAttributeMetadata',
  Boolean: 'BooleanAttributeMetadata', DateTime: 'DateTimeAttributeMetadata', Lookup: 'LookupAttributeMetadata', Customer: 'LookupAttributeMetadata',
  Owner: 'LookupAttributeMetadata', Uniqueidentifier: 'UniqueIdentifierAttributeMetadata',
};

function attrJson(e: MockEntity, a: MockAttribute, cast?: string, expandOptions = false): Record<string, unknown> {
  const o: Record<string, unknown> = {
    '@odata.type': `#Microsoft.Dynamics.CRM.${ODATA_TYPE[a.type]}`,
    LogicalName: a.logicalName,
    SchemaName: a.logicalName.charAt(0).toUpperCase() + a.logicalName.slice(1),
    EntityLogicalName: e.logicalName,
    AttributeType: a.type,
    AttributeTypeName: { Value: `${a.type}Type` },
    DisplayName: label(a.label),
    RequiredLevel: { Value: a.required, CanBeChanged: a.required !== 'SystemRequired', ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
    IsPrimaryName: a.logicalName === e.primaryName,
    IsPrimaryId: a.logicalName === e.primaryId,
    MetadataId: stableGuid(`${e.logicalName}.${a.logicalName}`),
  };
  if (a.maxLength) o.MaxLength = a.maxLength;
  if (cast === 'LookupAttributeMetadata') o.Targets = a.targets ?? [];
  if (expandOptions && a.options) {
    o.OptionSet = { Options: a.options.map((x) => ({ Value: x.value, Label: label(x.label) })) };
  }
  if (expandOptions && a.type === 'Boolean') {
    const [f, t] = a.booleanLabels ?? ['No', 'Yes'];
    o.OptionSet = { TrueOption: { Value: 1, Label: label(t) }, FalseOption: { Value: 0, Label: label(f) } };
  }
  return o;
}

function stableGuid(seed: string): string {
  let h = 2166136261;
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    for (const ch of seed + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    bytes.push(h & 0xff);
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function entityJson(e: MockEntity): Record<string, unknown> {
  return {
    LogicalName: e.logicalName, SchemaName: e.displayName, EntitySetName: e.entitySetName, PrimaryIdAttribute: e.primaryId,
    PrimaryNameAttribute: e.primaryName, DisplayName: label(e.displayName), DisplayCollectionName: label(e.collectionName),
    ObjectTypeCode: e.logicalName === 'account' ? 1 : 3, MetadataId: e.metadataId,
  };
}

function select(o: Record<string, unknown>, sel: string | null): Record<string, unknown> {
  if (!sel) return o;
  const keep = new Set(sel.split(',').map((s) => s.trim()).concat(['@odata.type', 'MetadataId']));
  return Object.fromEntries(Object.entries(o).filter(([k]) => keep.has(k) || (k === 'OptionSet' || k === 'Targets')));
}

const isLookup = (a: MockAttribute) => a.type === 'Lookup' || a.type === 'Customer' || a.type === 'Owner';
const colName = (a: MockAttribute) => (isLookup(a) ? `_${a.logicalName}_value` : a.logicalName);

/** Parse `a eq 'x' and b eq 5` into equality clauses. */
function parseFilter(f: string): Array<[string, RecordValue]> {
  const out: Array<[string, RecordValue]> = [];
  const re = /\s*([A-Za-z_][\w]*)\s+eq\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false|null|[0-9a-f-]{36})\s*(?:and\b|$)/iy;
  let pos = 0;
  while (pos < f.length) {
    re.lastIndex = pos;
    const m = re.exec(f);
    if (!m) throw new HttpError(400, '0x80060888', `The mock only supports "<field> eq <value>" clauses joined by "and"; cannot parse $filter "${f}".`);
    const raw = m[2];
    let v: RecordValue;
    if (raw.startsWith("'")) v = raw.slice(1, -1).replace(/''/g, "'");
    else if (/^(true|false)$/i.test(raw)) v = raw.toLowerCase() === 'true';
    else if (/^null$/i.test(raw)) v = null;
    else if (GUID.test(raw)) v = raw.toLowerCase();
    else v = Number(raw);
    out.push([m[1], v]);
    pos = re.lastIndex;
  }
  if (!out.length) throw new HttpError(400, '0x80060888', 'Empty $filter.');
  return out;
}

export async function startD365Mock(opts: D365MockOptions = {}): Promise<D365MockServer> {
  const clientId = opts.clientId ?? 'eztest-client';
  const clientSecret = opts.clientSecret ?? 's3cr3t-' + randomBytes(6).toString('hex');
  const saveDelay = opts.saveDelayMs ?? 250;
  let wave = opts.releaseWave ?? false;
  const store = new MockStore();
  const tokens = new Map<string, number>();
  const stats = { tokenRequests: 0, metadataRequests: 0, apiRequests: 0 };
  const all = () => entities(wave);
  const byName = (n: string) => all().find((e) => e.logicalName === n);
  const bySet = (s: string) => all().find((e) => e.entitySetName === s);

  function projectRecord(e: MockEntity, rec: MockRecord, sel: string | null, annotations: boolean): Record<string, unknown> {
    const cols = e.attributes.filter((a) => a.type !== 'Uniqueidentifier' || a.logicalName === e.primaryId);
    const out: Record<string, unknown> = { '@odata.etag': `W/"${Date.parse(String(rec.modifiedon)) % 1_000_000}"` };
    const wanted = sel ? new Set(sel.split(',').map((s) => s.trim())) : undefined;
    if (wanted) {
      const known = new Set(cols.map(colName));
      for (const w of wanted) {
        if (!known.has(w)) throw new HttpError(400, '0x80060888', `Could not find a property named '${w}' on type 'Microsoft.Dynamics.CRM.${e.logicalName}'.`);
      }
    }
    for (const a of cols) {
      const k = colName(a);
      if (wanted && !wanted.has(k) && a.logicalName !== e.primaryId) continue;
      const v = rec[k] ?? null;
      out[k] = v;
      if (!annotations || v === null) continue;
      if (a.options) {
        const o = a.options.find((x) => x.value === v);
        if (o) out[k + FORMATTED] = o.label;
      } else if (a.type === 'Boolean') out[k + FORMATTED] = (a.booleanLabels ?? ['No', 'Yes'])[v ? 1 : 0];
      else if (a.type === 'Money' && typeof v === 'number') out[k + FORMATTED] = formatMoney(v);
      else if (a.type === 'DateTime' && typeof v === 'string') out[k + FORMATTED] = formatDate(v);
      else if (isLookup(a) && typeof v === 'string') {
        const target = a.targets?.[0] ?? 'account';
        const n = store.nameOf(target, v);
        if (n !== undefined) out[k + FORMATTED] = n;
        out[k + '@Microsoft.Dynamics.CRM.lookuplogicalname'] = target;
      }
    }
    return out;
  }

  /** Validate and convert a Web API body into stored columns. */
  function toColumns(e: MockEntity, body: Record<string, unknown>): MockRecord {
    const out: MockRecord = {};
    for (const [k, v] of Object.entries(body)) {
      const bind = /^(\w+)@odata\.bind$/.exec(k);
      if (bind) {
        const a = e.attributes.find((x) => x.logicalName === bind[1] && isLookup(x));
        if (!a) throw new HttpError(400, '0x80060888', `An undeclared property '${bind[1]}' which only has property annotations in the payload was found.`);
        if (v === null) {
          out[colName(a)] = null;
          continue;
        }
        const m = /^\/?(\w+)\(([0-9a-f-]{36})\)$/i.exec(String(v));
        const te = m ? bySet(m[1]) : undefined;
        if (!m || !te || !(a.targets ?? []).includes(te.logicalName)) throw new HttpError(400, '0x80048d19', `Invalid @odata.bind value for '${bind[1]}': ${String(v)}`);
        if (!store.table(te.logicalName).has(m[2].toLowerCase())) throw new HttpError(404, '0x80040217', `${te.logicalName} With Id = ${m[2]} Does Not Exist`);
        out[colName(a)] = m[2].toLowerCase();
        continue;
      }
      const a = e.attributes.find((x) => x.logicalName === k && !isLookup(x));
      if (!a || a.type === 'Uniqueidentifier') {
        throw new HttpError(400, '0x80060888', `The property '${k}' does not exist on type 'Microsoft.Dynamics.CRM.${e.logicalName}'. Make sure to only use property names that are defined by the type.`);
      }
      out[k] = coerce(e, a, v);
    }
    return out;
  }

  function coerce(e: MockEntity, a: MockAttribute, v: unknown): RecordValue {
    if (v === null) return null;
    const bad = () => new HttpError(400, '0x80048d19', `Error converting attribute value to Property: ${a.logicalName} on ${e.logicalName}: ${JSON.stringify(v)}`);
    switch (a.type) {
      case 'Money': case 'Integer': case 'Decimal':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad();
        if (a.type === 'Integer' && !Number.isInteger(v)) throw bad();
        return v;
      case 'Picklist': case 'Status': case 'State':
        if (typeof v !== 'number' || !(a.options ?? []).some((o) => o.value === v)) {
          throw new HttpError(400, '0x8004431a', `${String(v)} is not a valid value for ${a.logicalName}.`);
        }
        return v;
      case 'Boolean':
        if (typeof v !== 'boolean') throw bad();
        return v;
      case 'DateTime':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad();
        return new Date(v).toISOString().replace('.000Z', 'Z');
      default:
        if (typeof v !== 'string') throw bad();
        if (a.maxLength && v.length > a.maxLength) throw new HttpError(400, '0x80044331', `A validation error occurred. The length of the '${a.logicalName}' attribute exceeded the maximum allowed length of '${a.maxLength}'.`);
        return v;
    }
  }

  function authorize(req: IncomingMessage): void {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    const exp = m ? tokens.get(m[1]) : undefined;
    if (!m || exp === undefined || exp < Date.now()) {
      throw new HttpError(401, '0x80072560', 'The user is not authenticated. Provide a valid bearer token.');
    }
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    stats.tokenRequests++;
    const p = new URLSearchParams(await readBody(req));
    let id = p.get('client_id');
    let secret = p.get('client_secret');
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    if (p.get('grant_type') !== 'client_credentials') return sendJson(res, 400, { error: 'unsupported_grant_type' });
    if (id !== clientId || secret !== clientSecret) return sendJson(res, 401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
    const token = randomBytes(24).toString('base64url');
    const ttl = opts.tokenTtlSeconds ?? 3600;
    tokens.set(token, Date.now() + ttl * 1000);
    sendJson(res, 200, { token_type: 'Bearer', expires_in: ttl, ext_expires_in: ttl, access_token: token });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    stats.apiRequests++;
    authorize(req);
    const base = `${url.origin}${API}`;
    const path = decodeURIComponent(url.pathname.slice(API.length + 1));
    const method = req.method ?? 'GET';
    const sel = url.searchParams.get('$select');
    const annotations = /odata\.include-annotations/i.test(String(req.headers.prefer ?? ''));

    // ---------- metadata
    let m: RegExpExecArray | null;
    if (path === 'EntityDefinitions') {
      stats.metadataRequests++;
      return sendJson(res, 200, { '@odata.context': `${base}/$metadata#EntityDefinitions`, value: all().map((e) => select(entityJson(e), sel)) });
    }
    if ((m = /^EntityDefinitions\(LogicalName='(\w+)'\)(?:\/Attributes(?:\/Microsoft\.Dynamics\.CRM\.(\w+))?(?:\(LogicalName='(\w+)'\))?)?$/.exec(path))) {
      stats.metadataRequests++;
      if (method !== 'GET') throw new HttpError(405, '0x80060888', 'Metadata is read-only in the mock.');
      const e = byName(m[1]);
      if (!e) throw new HttpError(404, '0x80040217', `Could not find an entity with name ${m[1]}.`);
      if (!path.includes('/Attributes')) return sendJson(res, 200, select(entityJson(e), sel));
      const cast = m[2];
      const expand = /OptionSet/.test(url.searchParams.get('$expand') ?? '');
      let attrs = e.attributes;
      if (cast) {
        const types = Object.entries(ODATA_TYPE).filter(([, v]) => v === cast).map(([k]) => k);
        if (!types.length) throw new HttpError(400, '0x80060888', `Unknown type cast ${cast}.`);
        attrs = attrs.filter((a) => types.includes(a.type));
      }
      if (m[3]) {
        const a = attrs.find((x) => x.logicalName === m![3]);
        if (!a) throw new HttpError(404, '0x80040217', `Could not find attribute ${m[3]} on ${e.logicalName}.`);
        return sendJson(res, 200, select(attrJson(e, a, cast, expand), sel));
      }
      return sendJson(res, 200, {
        '@odata.context': `${base}/$metadata#EntityDefinitions('${e.logicalName}')/Attributes`,
        value: attrs.map((a) => select(attrJson(e, a, cast, expand), sel)),
      });
    }

    // ---------- records
    if ((m = /^(\w+)(?:\(([0-9a-f-]{36})\))?$/i.exec(path))) {
      const e = bySet(m[1]);
      if (!e) throw new HttpError(404, '0x80060888', `Resource not found for the segment '${m[1]}'.`);
      const table = store.table(e.logicalName);
      const id = m[2]?.toLowerCase();
      if (id) {
        const rec = table.get(id);
        if (!rec) throw new HttpError(404, '0x80040217', `${e.logicalName} With Id = ${id} Does Not Exist`);
        if (method === 'GET') return sendJson(res, 200, { '@odata.context': `${base}/$metadata#${e.entitySetName}/$entity`, ...projectRecord(e, rec, sel, annotations) });
        if (method === 'PATCH') {
          store.update(e.logicalName, id, toColumns(e, await readJson(req)));
          res.writeHead(204, { 'odata-entityid': `${base}/${e.entitySetName}(${id})` });
          return void res.end();
        }
        if (method === 'DELETE') {
          table.delete(id);
          res.writeHead(204);
          return void res.end();
        }
        throw new HttpError(405, '0x80060888', `Method ${method} is not allowed on a record.`);
      }
      if (method === 'GET') {
        let rows = [...table.values()];
        const filter = url.searchParams.get('$filter');
        if (filter) {
          const clauses = parseFilter(filter);
          const known = new Set(e.attributes.map(colName));
          for (const [k] of clauses) if (!known.has(k)) throw new HttpError(400, '0x80060888', `Could not find a property named '${k}' on type 'Microsoft.Dynamics.CRM.${e.logicalName}'.`);
          rows = rows.filter((r) => clauses.every(([k, v]) => (r[k] ?? null) === v || (typeof v === 'string' && typeof r[k] === 'string' && String(r[k]).toLowerCase() === v.toLowerCase())));
        }
        const top = url.searchParams.get('$top');
        if (top !== null) {
          if (!/^\d+$/.test(top)) throw new HttpError(400, '0x80060888', `Invalid $top value '${top}'.`);
          rows = rows.slice(0, Number(top));
        }
        return sendJson(res, 200, { '@odata.context': `${base}/$metadata#${e.entitySetName}`, value: rows.map((r) => projectRecord(e, r, sel, annotations)) });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const newId = store.insert(e.logicalName, toColumns(e, body));
        const loc = `${base}/${e.entitySetName}(${newId})`;
        if (/return=representation/i.test(String(req.headers.prefer ?? ''))) {
          return sendJson(res, 201, projectRecord(e, table.get(newId)!, sel, annotations), { 'odata-entityid': loc });
        }
        res.writeHead(204, { 'odata-entityid': loc });
        return void res.end();
      }
      throw new HttpError(405, '0x80060888', `Method ${method} is not allowed on a collection.`);
    }
    throw new HttpError(404, '0x80060888', `Resource not found for the segment '${path}'.`);
  }

  async function handleUi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === '/' ) {
      res.writeHead(302, { location: listUrl('account') });
      return void res.end();
    }
    if (url.pathname === '/main.aspx') {
      const etn = url.searchParams.get('etn') ?? '';
      const e = byName(etn);
      if (!e) return sendHtml(res, 404, `<h1>Entity "${etn.replace(/[<>&"]/g, '')}" not found</h1>`);
      const pt = url.searchParams.get('pagetype');
      if (pt === 'entitylist') return sendHtml(res, 200, renderList(e, all()));
      if (pt === 'entityrecord') {
        const id = url.searchParams.get('id')?.toLowerCase();
        const rec = id ? store.table(etn).get(id) : undefined;
        if (id && !rec) return sendHtml(res, 404, '<h1>Record Is Unavailable</h1>');
        return sendHtml(res, 200, renderForm(e, all(), store, rec));
      }
      return sendHtml(res, 400, '<h1>Unsupported pagetype</h1>');
    }
    if (url.pathname === '/_mock/lookup') {
      const e = byName(url.searchParams.get('etn') ?? '');
      if (!e) throw new HttpError(404, 'notfound', 'unknown entity');
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const rows = [...store.table(e.logicalName).values()]
        .filter((r) => String(r[e.primaryName] ?? '').toLowerCase().startsWith(q))
        .sort((a, b) => String(a[e.primaryName]).localeCompare(String(b[e.primaryName])))
        .slice(0, 10)
        .map((r) => ({ id: String(r[e.primaryId]), name: String(r[e.primaryName] ?? ''), secondary: String(r.telephone1 ?? '') }));
      return sendJson(res, 200, rows);
    }
    if (url.pathname === '/_mock/view') {
      const e = byName(url.searchParams.get('etn') ?? '');
      if (!e) throw new HttpError(404, 'notfound', 'unknown entity');
      const cols = e.attributes.filter((a) => a.inView);
      const rows = [...store.table(e.logicalName).values()]
        .filter((r) => r.statecode !== 1)
        .sort((a, b) => String(a[e.primaryName]).localeCompare(String(b[e.primaryName])))
        .map((r) => ({
          id: String(r[e.primaryId]),
          url: recordUrl(e.logicalName, String(r[e.primaryId])),
          cells: Object.fromEntries(cols.map((a) => {
            const v = r[colName(a)];
            let text = v === null || v === undefined ? '' : String(v);
            if (a.type === 'Money' && typeof v === 'number') text = formatMoney(v);
            if (isLookup(a) && typeof v === 'string') text = store.nameOf(a.targets?.[0] ?? 'account', v) ?? '';
            return [a.logicalName, text];
          })),
        }));
      return sendJson(res, 200, { columns: cols.map((a) => a.logicalName), primary: e.primaryName, rows });
    }
    if (url.pathname === '/_mock/save' && req.method === 'POST') {
      const body = await readJson(req);
      const e = byName(String(body.etn ?? ''));
      if (!e) throw new HttpError(404, 'notfound', 'unknown entity');
      const values = (body.values ?? {}) as Record<string, RecordValue>;
      const cols: MockRecord = {};
      const missing: string[] = [];
      for (const a of e.attributes.filter((x) => x.onForm)) {
        if (!(a.logicalName in values)) continue;
        const v = values[a.logicalName];
        if ((v === null || v === '') && a.required === 'ApplicationRequired') missing.push(a.label ?? a.logicalName);
        cols[colName(a)] = isLookup(a) || v === null ? v : coerce(e, a, v);
      }
      for (const k of Object.keys(values)) {
        if (!e.attributes.some((a) => a.onForm && a.logicalName === k)) throw new HttpError(400, 'form', `Field ${k} is not on the form.`);
      }
      await new Promise((r) => setTimeout(r, saveDelay));
      if (missing.length) return sendJson(res, 400, { error: `${missing[0]}: Required fields must be filled in.` });
      let id = typeof body.id === 'string' ? body.id.toLowerCase() : '';
      if (id) {
        if (!store.update(e.logicalName, id, cols)) throw new HttpError(404, 'notfound', 'Record Is Unavailable');
      } else id = store.insert(e.logicalName, cols);
      return sendJson(res, 200, { id, name: String(store.table(e.logicalName).get(id)?.[e.primaryName] ?? '') });
    }
    if (url.pathname === '/_mock/stage' && req.method === 'POST') {
      const body = await readJson(req);
      const e = byName(String(body.etn ?? ''));
      const rec = e?.bpf ? store.table(e.logicalName).get(String(body.id ?? '').toLowerCase()) : undefined;
      if (!e?.bpf || !rec) return sendJson(res, 404, { error: 'Record Is Unavailable' });
      const stages = e.bpf.stages;
      const i = Math.max(0, stages.findIndex((s) => s.name === rec.stepname));
      if (i >= stages.length - 1) return sendJson(res, 400, { error: 'This is the last stage of the process.' });
      const missing = (stages[i].requires ?? [])
        .map((n) => e.attributes.find((a) => a.logicalName === n)!)
        .filter((a) => rec[colName(a)] === null || rec[colName(a)] === undefined)
        .map((a) => a.label ?? a.logicalName);
      if (missing.length) return sendJson(res, 400, { error: `Required steps are incomplete in stage ${stages[i].name}: ${missing.join(', ')}.` });
      store.update(e.logicalName, String(rec[e.primaryId]), { stepname: stages[i + 1].name });
      return sendJson(res, 200, { index: i + 1, stage: stages[i + 1].name });
    }
    sendHtml(res, 404, '<h1>Not found</h1>');
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const run = async () => {
      if (url.pathname === '/token' && req.method === 'POST') return handleToken(req, res);
      if (url.pathname.startsWith(API + '/')) return handleApi(req, res, url);
      return handleUi(req, res, url);
    };
    run().catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) {
        const headers: Record<string, string> = err.status === 401 ? { 'www-authenticate': 'Bearer authorization_uri=/token' } : {};
        return sendJson(res, err.status, { error: { code: err.code, message: err.message } }, headers);
      }
      sendJson(res, 500, { error: { code: '0x80040216', message: (err as Error).message } });
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 0;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    apiUrl: `${url}${API}`,
    tokenUrl: `${url}/token`,
    clientId,
    clientSecret,
    store,
    stats,
    setReleaseWave(on: boolean) {
      wave = on;
    },
    get releaseWave() {
      return wave;
    },
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

const isMain = process.argv[1] && /d365-mock[\\/]server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const s = await startD365Mock({
    port: Number(process.env.PORT ?? 4365),
    releaseWave: process.env.RELEASE_WAVE === '1',
    clientSecret: process.env.D365_MOCK_SECRET ?? 'local-dev-secret',
  });
  process.stdout.write(`D365 mock at ${s.url} (client id ${s.clientId}; secret from D365_MOCK_SECRET or "local-dev-secret")\n`);
}
