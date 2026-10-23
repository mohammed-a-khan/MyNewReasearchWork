/**
 * DataverseClient: metadata (cached) + record CRUD + OData queries against the
 * Dataverse Web API, authorised with a bearer token from a TokenProvider.
 * Tokens are only ever placed in the Authorization header; they never appear
 * in errors or log lines.
 */
import { EzTestError, silentLogger, type Logger } from '../core/index.js';
import { ApiClient, type ApiResponse, type RetryPolicy, type TokenProvider } from '../surfaces/index.js';
import {
  assertLogicalName,
  D365MetadataError,
  mergeAttributeDetails,
  parseAttributeJson,
  parseEntityJson,
  type AttributeMeta,
  type EntityMeta,
  type MetadataSource,
} from './metadata.js';

export interface DataverseClientOptions {
  /** Environment URL, e.g. https://contoso.crm.dynamics.com (the Web API path is appended). */
  url: string;
  apiVersion?: string;
  tokenProvider: TokenProvider;
  timeoutMs?: number;
  retry?: RetryPolicy | false;
  fetch?: typeof fetch;
  logger?: Logger;
}

export class DataverseError extends EzTestError {
  constructor(
    message: string,
    readonly status: number,
    readonly dataverseCode?: string,
  ) {
    super(message, 'DATAVERSE_ERROR', { status, dataverseCode });
    this.name = 'DataverseError';
  }
}

export type ODataScalar = string | number | boolean | null;
export type DataverseRecord = Record<string, unknown>;

export interface QueryOptions {
  /** Equality filters (joined with "and") or a raw OData $filter string. */
  filter?: Record<string, ODataScalar> | string;
  select?: string[];
  top?: number;
  /** Ask for OData.Community.Display.V1.FormattedValue annotations. */
  formatted?: boolean;
}

const FORMATTED_PREFER = 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"';
export const FORMATTED_SUFFIX = '@OData.Community.Display.V1.FormattedValue';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** OData literal for an equality filter. */
export function odataLiteral(v: ODataScalar): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new EzTestError(`Cannot filter on non-finite number ${v}`, 'DATAVERSE_BAD_QUERY');
    return String(v);
  }
  if (GUID.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

export function buildFilter(f: Record<string, ODataScalar>): string {
  const parts = Object.entries(f).map(([k, v]) => `${assertLogicalName(k, 'filter column')} eq ${odataLiteral(v)}`);
  if (!parts.length) throw new EzTestError('Empty filter', 'DATAVERSE_BAD_QUERY');
  return parts.join(' and ');
}

function assertGuid(id: string): string {
  if (!GUID.test(id)) throw new EzTestError(`Invalid record id "${id}" (expected a GUID)`, 'DATAVERSE_BAD_ID');
  return id.toLowerCase();
}

const ENTITY_SELECT = 'LogicalName,DisplayName,DisplayCollectionName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute';

export class DataverseClient implements MetadataSource {
  readonly api: ApiClient;
  readonly url: string;
  private readonly logger: Logger;
  private entityList?: Promise<EntityMeta[]>;
  private readonly entityCache = new Map<string, Promise<EntityMeta>>();
  private readonly attrCache = new Map<string, Promise<AttributeMeta[]>>();

  constructor(opts: DataverseClientOptions) {
    if (!opts.url) throw new EzTestError('DataverseClient needs the environment url', 'DATAVERSE_CONFIG');
    if (!opts.tokenProvider) throw new EzTestError('DataverseClient needs a tokenProvider', 'DATAVERSE_CONFIG');
    const root = opts.url.replace(/\/+$/, '').replace(/\/api\/data\/v[\d.]+$/i, '');
    this.url = root;
    this.logger = opts.logger ?? silentLogger;
    this.api = new ApiClient({
      baseUrl: `${root}/api/data/v${opts.apiVersion ?? '9.2'}/`,
      auth: { type: 'oauth2', tokenProvider: opts.tokenProvider },
      headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', accept: 'application/json' },
      timeoutMs: opts.timeoutMs ?? 30_000,
      retry: opts.retry,
      fetch: opts.fetch,
      logger: this.logger,
    });
  }

  private async call(method: string, path: string, o: { query?: Record<string, string>; json?: unknown; prefer?: string[] } = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (o.prefer?.length) headers.prefer = o.prefer.join(',');
    const res = await this.api.request(method, path, { query: o.query, json: o.json, headers });
    if (!res.ok) {
      const err = (res.body as { error?: { code?: string; message?: string } } | undefined)?.error;
      const msg = err?.message ?? (typeof res.body === 'string' ? res.body.slice(0, 300) : res.statusText);
      throw new DataverseError(`Dataverse ${method} ${path.split('?')[0]} failed (${res.status}): ${msg}`, res.status, err?.code);
    }
    return res;
  }

  private static values(res: ApiResponse): DataverseRecord[] {
    const v = (res.body as { value?: unknown } | undefined)?.value;
    if (!Array.isArray(v)) throw new DataverseError('Dataverse response has no "value" array', res.status);
    return v as DataverseRecord[];
  }

  /** Drop cached metadata (e.g. after a release wave / solution import). */
  clearCache(): void {
    this.entityList = undefined;
    this.entityCache.clear();
    this.attrCache.clear();
  }

  // ------------------------------------------------------------ metadata

  listEntities(): Promise<EntityMeta[]> {
    this.entityList ??= this.call('GET', 'EntityDefinitions', { query: { $select: ENTITY_SELECT } })
      .then((r) => DataverseClient.values(r).map(parseEntityJson))
      .catch((e: unknown) => {
        this.entityList = undefined;
        throw e;
      });
    return this.entityList;
  }

  async getEntity(logicalName: string): Promise<EntityMeta> {
    const n = assertLogicalName(logicalName, 'entity logical name');
    let p = this.entityCache.get(n);
    if (!p) {
      p = this.call('GET', `EntityDefinitions(LogicalName='${n}')`, { query: { $select: ENTITY_SELECT } })
        .then((r) => parseEntityJson(r.body as Record<string, unknown>))
        .catch((e: unknown) => {
          this.entityCache.delete(n);
          if (e instanceof DataverseError && e.status === 404) throw new D365MetadataError(`Dataverse has no entity "${n}"`, 'D365_UNKNOWN_ENTITY');
          throw e;
        });
      this.entityCache.set(n, p);
    }
    return p;
  }

  /** Attributes with display labels, types, required levels, choice options and lookup targets. */
  async getAttributes(logicalName: string): Promise<AttributeMeta[]> {
    const n = assertLogicalName(logicalName, 'entity logical name');
    let p = this.attrCache.get(n);
    if (!p) {
      p = this.loadAttributes(n).catch((e: unknown) => {
        this.attrCache.delete(n);
        if (e instanceof DataverseError && e.status === 404) throw new D365MetadataError(`Dataverse has no entity "${n}"`, 'D365_UNKNOWN_ENTITY');
        throw e;
      });
      this.attrCache.set(n, p);
    }
    return p;
  }

  private async loadAttributes(n: string): Promise<AttributeMeta[]> {
    const base = `EntityDefinitions(LogicalName='${n}')/Attributes`;
    const cast = (t: string, query: Record<string, string>) => this.call('GET', `${base}/Microsoft.Dynamics.CRM.${t}`, { query }).then(DataverseClient.values);
    const [all, picklists, statuses, states, booleans, lookups] = await Promise.all([
      this.call('GET', base, { query: { $select: 'LogicalName,DisplayName,AttributeType,RequiredLevel,IsPrimaryName' } }).then(DataverseClient.values),
      cast('PicklistAttributeMetadata', { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' }),
      cast('StatusAttributeMetadata', { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' }),
      cast('StateAttributeMetadata', { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' }),
      cast('BooleanAttributeMetadata', { $select: 'LogicalName', $expand: 'OptionSet($select=TrueOption,FalseOption)' }),
      cast('LookupAttributeMetadata', { $select: 'LogicalName,Targets' }),
    ]);
    const attrs = all.map(parseAttributeJson);
    const byName = new Map(attrs.map((a) => [a.logicalName, a]));
    for (const j of [...picklists, ...statuses, ...states, ...booleans, ...lookups]) {
      const a = byName.get(String(j.LogicalName));
      if (a) mergeAttributeDetails(a, j);
    }
    if (!attrs.length) throw new D365MetadataError(`Entity "${n}" returned no attributes`, 'D365_BAD_METADATA');
    return attrs;
  }

  async entitySetName(entity: string): Promise<string> {
    return (await this.getEntity(entity)).entitySetName;
  }

  // ------------------------------------------------------------ records

  async retrieve(entity: string, id: string, o: { select?: string[]; formatted?: boolean } = {}): Promise<DataverseRecord> {
    const set = await this.entitySetName(entity);
    const query: Record<string, string> = {};
    if (o.select?.length) query.$select = o.select.map((s) => assertLogicalName(s, 'column')).join(',');
    const res = await this.call('GET', `${set}(${assertGuid(id)})`, { query, prefer: o.formatted ? [FORMATTED_PREFER] : [] });
    return res.body as DataverseRecord;
  }

  /** Create a record; returns its id (from the OData-EntityId header). */
  async create(entity: string, data: DataverseRecord): Promise<string> {
    if (!data || !Object.keys(data).length) throw new EzTestError('create: no column values given', 'DATAVERSE_BAD_REQUEST');
    const set = await this.entitySetName(entity);
    const res = await this.call('POST', set, { json: data });
    const loc = res.header('odata-entityid') ?? '';
    const m = /\(([0-9a-f-]{36})\)\s*$/i.exec(loc);
    if (!m) throw new DataverseError('Create succeeded but no OData-EntityId header was returned', res.status);
    return m[1].toLowerCase();
  }

  async update(entity: string, id: string, data: DataverseRecord): Promise<void> {
    if (!data || !Object.keys(data).length) throw new EzTestError('update: no column values given', 'DATAVERSE_BAD_REQUEST');
    const set = await this.entitySetName(entity);
    await this.call('PATCH', `${set}(${assertGuid(id)})`, { json: data });
  }

  async delete(entity: string, id: string): Promise<void> {
    const set = await this.entitySetName(entity);
    await this.call('DELETE', `${set}(${assertGuid(id)})`);
  }

  async query(entity: string, o: QueryOptions = {}): Promise<DataverseRecord[]> {
    const set = await this.entitySetName(entity);
    const query: Record<string, string> = {};
    if (o.filter !== undefined) {
      const f = typeof o.filter === 'string' ? o.filter.trim() : buildFilter(o.filter);
      if (!f) throw new EzTestError('Empty $filter', 'DATAVERSE_BAD_QUERY');
      query.$filter = f;
    }
    if (o.select?.length) query.$select = o.select.map((s) => assertLogicalName(s, 'column')).join(',');
    if (o.top !== undefined) {
      if (!Number.isInteger(o.top) || o.top < 1) throw new EzTestError(`Invalid $top ${o.top}`, 'DATAVERSE_BAD_QUERY');
      query.$top = String(o.top);
    }
    const res = await this.call('GET', set, { query, prefer: o.formatted ? [FORMATTED_PREFER] : [] });
    return DataverseClient.values(res);
  }

  /** Records whose primary name equals `name` (case-insensitive, as Dataverse compares). */
  async findByName(entity: string, name: string, o: { formatted?: boolean; top?: number } = {}): Promise<DataverseRecord[]> {
    if (!name) throw new EzTestError('findByName: empty name', 'DATAVERSE_BAD_QUERY');
    const e = await this.getEntity(entity);
    return this.query(entity, { filter: { [e.primaryNameAttribute]: name }, formatted: o.formatted, top: o.top });
  }
}
