/**
 * SAP OData V2/V4 client (metadata, queries, CSRF-protected writes) and the
 * ADT transport/dictionary reader used for transport impact. $metadata is
 * parsed into entity sets with labels (sap:label for V2, Common.Label for
 * V4), required flags, value lists (Common.ValueList / sap:value-list) and
 * create/update restrictions. Filters are built from validated property
 * names with quoted, escaped literals.
 */
import { XMLParser } from 'fast-xml-parser';
import { EzTestError } from '../../core/index.js';
import { AppApiError, AppHttp, type AuthHeader } from '../common/http.js';
import { didYouMean, normalizeLabel } from '../common/kit.js';

export interface ODataServiceDef { name: string; version: 2 | 4; path: string }
export interface ODataProperty {
  name: string;
  type: string;
  label: string;
  required: boolean;
  creatable: boolean;
  updatable: boolean;
  maxLength?: number;
  valueList?: { collection: string; fixed: boolean };
}
export interface ODataEntitySet { name: string; entityType: string; label: string; keys: string[]; properties: ODataProperty[] }
export interface ODataMetadata { service: string; version: 2 | 4; entitySets: Record<string, ODataEntitySet> }
export type ODataRow = Record<string, string>;

const ARRAYS = new Set(['Schema', 'EntityType', 'Property', 'PropertyRef', 'EntitySet', 'Annotations', 'Annotation', 'PropertyValue', 'NavigationProperty', 'tm:task', 'tm:abap_object', 'tm:key']);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => ARRAYS.has(name), parseAttributeValue: false, parseTagValue: false });

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertODataName(s: string, what: string): string {
  if (!NAME.test(s)) throw new EzTestError(`Invalid OData ${what} "${s}"`, 'SAP_BAD_NAME');
  return s;
}
/** An OData string literal ('it''s'). */
export function odataString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

type X = Record<string, unknown>;
const arr = (v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : v ? [v as X] : []);

/** Parse V2 or V4 $metadata XML. */
export function parseODataMetadata(xml: string, service: string): ODataMetadata {
  const doc = parser.parse(xml) as X;
  const edmx = doc['edmx:Edmx'] as X | undefined;
  if (!edmx) throw new EzTestError(`${service}: $metadata is not an EDMX document`, 'SAP_BAD_METADATA');
  const version: 2 | 4 = String(edmx['@_Version']).startsWith('4') ? 4 : 2;
  const schemas = arr((edmx['edmx:DataServices'] as X)?.Schema);
  const types = new Map<string, { label: string; keys: string[]; props: ODataProperty[] }>();
  const sets: Array<{ name: string; type: string }> = [];
  const anns: X[] = [];
  for (const s of schemas) {
    for (const et of arr(s.EntityType)) {
      const props = arr(et.Property).map((p): ODataProperty => {
        const vl = String(p['@_sap:value-list'] ?? '');
        return {
          name: String(p['@_Name']), type: String(p['@_Type']), label: String(p['@_sap:label'] ?? p['@_Name']),
          required: p['@_Nullable'] === 'false' && p['@_sap:creatable'] !== 'false', creatable: p['@_sap:creatable'] !== 'false', updatable: p['@_sap:updatable'] !== 'false',
          ...(p['@_MaxLength'] ? { maxLength: Number(p['@_MaxLength']) } : {}),
          ...(vl ? { valueList: { collection: '', fixed: vl === 'fixed-values' } } : {}),
        };
      });
      types.set(String(et['@_Name']), { label: String(et['@_sap:label'] ?? et['@_Name']), keys: arr((et.Key as X)?.PropertyRef).map((k) => String(k['@_Name'])), props });
    }
    const containers = arr(s.EntityContainer);
    for (const c of containers) for (const es of arr(c.EntitySet)) sets.push({ name: String(es['@_Name']), type: String(es['@_EntityType']).split('.').pop()! });
    anns.push(...arr(s.Annotations));
  }
  for (const a of anns) {
    const [typePart, prop] = String(a['@_Target']).split('/');
    const t = types.get(typePart.split('.').pop()!);
    if (!t) continue;
    for (const an of arr(a.Annotation)) {
      const term = String(an['@_Term']);
      if (!prop) {
        if (/Common\.v1\.Label$|\.Label$/.test(term) && an['@_String']) t.label = String(an['@_String']);
        continue;
      }
      const p = t.props.find((x) => x.name === prop);
      if (!p) continue;
      if (/Common\.v1\.Label$/.test(term)) p.label = String(an['@_String'] ?? p.label);
      else if (/Core\.V1\.Immutable$|Core\.V1\.Computed$/i.test(term)) p.updatable = false;
      else if (/Common\.v1\.ValueListWithFixedValues$/.test(term)) p.valueList = { collection: p.valueList?.collection ?? '', fixed: true };
      else if (/Common\.v1\.ValueList$/.test(term)) {
        const rec = (an.Record as X) ?? {};
        const cp = arr(rec.PropertyValue).find((v) => v['@_Property'] === 'CollectionPath');
        p.valueList = { collection: String(cp?.['@_String'] ?? ''), fixed: p.valueList?.fixed ?? false };
      }
    }
  }
  const entitySets: Record<string, ODataEntitySet> = {};
  for (const s of sets) {
    const t = types.get(s.type);
    if (t) entitySets[s.name] = { name: s.name, entityType: s.type, label: t.label, keys: t.keys, properties: t.props };
  }
  return { service, version, entitySets };
}

export interface TransportObject { pgmid: string; type: string; name: string; keys?: Array<{ table: string; key: string; action?: string }> }
export interface Transport { number: string; description: string; owner: string; status: string; target?: string; objects: TransportObject[] }

/** Parse a transport from ADT XML, a JSON E071 export ([{PGMID, OBJECT, OBJ_NAME}]) or "R3TR TABL VBAK" lines. */
export function parseTransport(text: string, number = 'TRANSPORT'): Transport {
  const t = text.trim();
  if (t.startsWith('<')) {
    const doc = parser.parse(t) as X;
    const req = ((doc['tm:root'] as X)?.['tm:request']) as X | undefined;
    if (!req) throw new EzTestError('Not an ADT transport request document', 'SAP_BAD_TRANSPORT');
    const all = (req['tm:all_objects'] as X | undefined)?.['tm:abap_object'] ?? arr(req['tm:task']).flatMap((k) => arr(k['tm:abap_object']));
    const seen = new Set<string>();
    const objects: TransportObject[] = [];
    for (const o of arr(all)) {
      const obj: TransportObject = { pgmid: String(o['@_tm:pgmid']), type: String(o['@_tm:type']), name: String(o['@_tm:name']) };
      const keys = arr(o['tm:key']).map((k) => ({ table: String(k['@_tm:table'] ?? ''), key: String(k['@_tm:tabkey'] ?? ''), ...(k['@_tm:action'] ? { action: String(k['@_tm:action']) } : {}) }));
      if (keys.length) obj.keys = keys;
      const id = `${obj.pgmid} ${obj.type} ${obj.name}`;
      if (!seen.has(id)) objects.push(obj);
      seen.add(id);
    }
    return { number: String(req['@_tm:number'] ?? number), description: String(req['@_tm:desc'] ?? ''), owner: String(req['@_tm:owner'] ?? ''), status: String(req['@_tm:status_text'] ?? req['@_tm:status'] ?? ''), target: req['@_tm:target'] ? String(req['@_tm:target']) : undefined, objects };
  }
  if (t.startsWith('[') || t.startsWith('{')) {
    const raw = JSON.parse(t) as unknown;
    const rows = (Array.isArray(raw) ? raw : ((raw as { objects?: unknown[] }).objects ?? [])) as Array<Record<string, string>>;
    return { number: (raw as { number?: string }).number ?? number, description: (raw as { description?: string }).description ?? '', owner: '', status: '', objects: rows.map((r) => ({ pgmid: r.PGMID ?? r.pgmid ?? 'R3TR', type: r.OBJECT ?? r.type, name: r.OBJ_NAME ?? r.name })) };
  }
  const objects = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [pgmid, type, ...name] = l.split(/[\s,;]+/);
    if (!type || !name.length) throw new EzTestError(`Expected "PGMID TYPE NAME", got "${l}"`, 'SAP_BAD_TRANSPORT');
    return { pgmid, type, name: name.join(' ') };
  });
  return { number, description: '', owner: '', status: '', objects };
}

export interface SapClientOptions {
  /** System URL, e.g. https://s4.example.com:44300 */
  url: string;
  /** sap-client (logon client), e.g. "100". */
  client?: string;
  auth: AuthHeader;
  services: ODataServiceDef[];
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class SapODataClient {
  readonly http: AppHttp;
  readonly url: string;
  private readonly meta = new Map<string, Promise<ODataMetadata>>();
  private csrf?: { token: string; cookie: string };

  constructor(readonly o: SapClientOptions) {
    this.url = o.url.replace(/\/+$/, '');
    this.http = new AppHttp({
      baseUrl: this.url, auth: o.auth, product: 'SAP', timeoutMs: o.timeoutMs, fetch: o.fetch,
      errorMessage: (b) => {
        const e = (b as { error?: { message?: { value?: string } | string; innererror?: { errordetails?: Array<{ message: string }> }; details?: Array<{ message: string }> } } | undefined)?.error;
        if (!e) return undefined;
        const main = typeof e.message === 'string' ? e.message : e.message?.value;
        const more = (e.innererror?.errordetails ?? e.details ?? []).map((d) => d.message).filter((m) => m && m !== main);
        return [main, ...more].filter(Boolean).join('; ');
      },
    });
  }

  get services(): ODataServiceDef[] {
    return this.o.services;
  }

  service(name: string): ODataServiceDef {
    const s = this.o.services.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) throw new EzTestError(`Unknown SAP OData service "${name}" (configured: ${this.o.services.map((x) => x.name).join(', ')})`, 'SAP_UNKNOWN_SERVICE');
    return s;
  }

  private q(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.o.client ? { 'sap-client': this.o.client } : {}), ...extra };
  }

  metadata(service: string): Promise<ODataMetadata> {
    const s = this.service(service);
    let p = this.meta.get(s.name);
    if (!p) {
      p = this.http.request('GET', `${s.path}/$metadata`, { query: this.q(), headers: { accept: 'application/xml' } }).then((r) => parseODataMetadata(r.text, s.name));
      p.catch(() => this.meta.delete(s.name));
      this.meta.set(s.name, p);
    }
    return p;
  }

  clearCache(): void {
    this.meta.clear();
  }

  /** Entity set by name or label, across the configured services (or one). */
  async entitySet(nameOrLabel: string, service?: string): Promise<{ service: ODataServiceDef; set: ODataEntitySet }> {
    const svcs = service ? [this.service(service)] : this.o.services;
    const n = normalizeLabel(nameOrLabel);
    const all: Array<{ service: ODataServiceDef; set: ODataEntitySet }> = [];
    for (const s of svcs) for (const set of Object.values((await this.metadata(s.name)).entitySets)) all.push({ service: s, set });
    const byName = all.filter((x) => x.set.name === nameOrLabel || x.set.name.toLowerCase() === n);
    if (byName.length === 1) return byName[0];
    const byLabel = all.filter((x) => normalizeLabel(x.set.label) === n || normalizeLabel(x.set.label) + 's' === n);
    // A released API (A_*) wins over UI services for cross-checks when labels collide.
    const pick = byLabel.length > 1 ? byLabel.filter((x) => /^A_/.test(x.set.name)) : byLabel;
    if (pick.length === 1) return pick[0];
    if (pick.length > 1 || byName.length > 1) throw new EzTestError(`"${nameOrLabel}" matches several entity sets: ${(pick.length ? pick : byName).map((x) => `${x.service.name}/${x.set.name}`).join(', ')}`, 'SAP_AMBIGUOUS');
    throw new EzTestError(`No OData entity set "${nameOrLabel}".${didYouMean(nameOrLabel, all.flatMap((x) => [x.set.name, x.set.label]))}`, 'SAP_UNKNOWN_ENTITY');
  }

  /** Property by label or name. */
  property(set: ODataEntitySet, ref: string): ODataProperty {
    const n = normalizeLabel(ref);
    const hit = set.properties.find((p) => p.name === ref) ?? set.properties.filter((p) => normalizeLabel(p.label) === n || p.name.toLowerCase() === n)[0];
    if (!hit) throw new EzTestError(`Property "${ref}" not found on ${set.name}.${didYouMean(ref, set.properties.map((p) => p.label))}`, 'SAP_UNKNOWN_FIELD');
    return hit;
  }

  private normalize(row: Record<string, unknown>): ODataRow {
    const out: ODataRow = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === '__metadata' || k.startsWith('@odata') || (v && typeof v === 'object')) continue;
      const m = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(String(v ?? ''));
      out[k] = m ? new Date(Number(m[1])).toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v);
    }
    return out;
  }

  async query(service: string, set: string, o: { filter?: Record<string, string>; select?: string[]; top?: number } = {}): Promise<ODataRow[]> {
    const s = this.service(service);
    const md = await this.metadata(s.name);
    const es = md.entitySets[assertODataName(set, 'entity set')];
    if (!es) throw new EzTestError(`${s.name} has no entity set ${set}`, 'SAP_UNKNOWN_ENTITY');
    const q: Record<string, string> = this.q(s.version === 2 ? { $format: 'json' } : {});
    const terms = Object.entries(o.filter ?? {}).map(([k, v]) => {
      if (!es.properties.some((p) => p.name === k)) throw new EzTestError(`${set} has no property ${k}`, 'SAP_UNKNOWN_FIELD');
      return `${k} eq ${odataString(v)}`;
    });
    if (terms.length) q.$filter = terms.join(' and ');
    if (o.select?.length) q.$select = o.select.map((x) => assertODataName(x, 'property')).join(',');
    if (o.top) q.$top = String(o.top);
    const b = await this.http.json<{ d?: { results?: Array<Record<string, unknown>> }; value?: Array<Record<string, unknown>> }>('GET', `${s.path}/${set}`, { query: q });
    return (s.version === 2 ? b.d?.results ?? [] : b.value ?? []).map((r) => this.normalize(r));
  }

  /** Values of a value-list property (key + text), for snapshots and value-help checks. */
  async valueList(service: string, set: string, prop: string): Promise<Array<{ key: string; text: string }>> {
    const md = await this.metadata(service);
    const p = md.entitySets[set]?.properties.find((x) => x.name === prop);
    if (!p?.valueList?.collection) return [];
    const rows = await this.query(service, p.valueList.collection);
    return rows.map((r) => {
      const vals = Object.values(r);
      return { key: vals[0] ?? '', text: vals[1] ?? '' };
    });
  }

  private async fetchCsrf(service: ODataServiceDef): Promise<{ token: string; cookie: string }> {
    const r = await this.http.request('GET', `${service.path}/`, { query: this.q(service.version === 2 ? { $format: 'json' } : {}), headers: { 'x-csrf-token': 'Fetch' } });
    const token = r.header('x-csrf-token');
    if (!token) throw new EzTestError(`${service.name}: no CSRF token returned`, 'SAP_CSRF');
    this.csrf = { token, cookie: (r.header('set-cookie') ?? '').split(/,(?=\s*\w+=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ') };
    return this.csrf;
  }

  /** POST/PATCH with a CSRF token (fetched once, refreshed on "CSRF token validation failed"). */
  async write(method: 'POST' | 'PATCH', service: string, path: string, data: Record<string, unknown>): Promise<ODataRow | undefined> {
    const s = this.service(service);
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = this.csrf ?? (await this.fetchCsrf(s));
      try {
        const r = await this.http.request(method, `${s.path}/${path}`, { query: this.q(), json: data, headers: { 'x-csrf-token': c.token, ...(c.cookie ? { cookie: c.cookie } : {}) } });
        const b = r.body as { d?: Record<string, unknown> } & Record<string, unknown>;
        return r.status === 204 || !b || typeof b !== 'object' ? undefined : this.normalize(s.version === 2 ? b.d ?? {} : b);
      } catch (e) {
        if (e instanceof AppApiError && e.status === 403 && /csrf/i.test(e.message) && attempt === 0) {
          this.csrf = undefined;
          continue;
        }
        throw e;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- ADT

  async transport(number: string): Promise<Transport> {
    if (!/^[A-Z0-9]{3}K\d{6}$/.test(number)) throw new EzTestError(`Invalid transport request number "${number}" (expected e.g. DEVK900123)`, 'SAP_BAD_TRANSPORT');
    const r = await this.http.request('GET', `sap/bc/adt/cts/transportrequests/${number}`, { query: this.q(), headers: { accept: 'application/vnd.sap.adt.transportorganizer.v1+xml' } });
    return parseTransport(r.text, number);
  }

  /** Field labels of a data element (short, medium, long, heading). */
  async dataElement(name: string): Promise<{ short: string; medium: string; long: string; heading: string } | undefined> {
    if (!/^[A-Z0-9_/]{1,30}$/i.test(name)) throw new EzTestError(`Invalid data element "${name}"`, 'SAP_BAD_NAME');
    const r = await this.http.request('GET', `sap/bc/adt/ddic/dataelements/${encodeURIComponent(name.toLowerCase())}`, { query: this.q(), okStatuses: [404] });
    if (r.status === 404) return undefined;
    const doc = parser.parse(r.text) as X;
    const de = ((doc['blue:wbobj'] as X)?.['dtel:dataElement'] ?? {}) as X;
    return { short: String(de['dtel:shortFieldLabel'] ?? ''), medium: String(de['dtel:mediumFieldLabel'] ?? ''), long: String(de['dtel:longFieldLabel'] ?? ''), heading: String(de['dtel:headingFieldLabel'] ?? '') };
  }
}
