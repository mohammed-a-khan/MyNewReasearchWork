/**
 * SalesforceClient: describe (cached) + sObject CRUD + SOQL (through the safe
 * builder only) + tabs, against the REST API, authorised with a bearer token
 * from a TokenProvider. Tokens only ever go into the Authorization header and
 * never appear in errors or logs.
 */
import { EzTestError, silentLogger, type Logger } from '../core/index.js';
import { ApiClient, type ApiResponse, type RetryPolicy, type TokenProvider } from '../surfaces/index.js';
import {
  assertApiName,
  assertFieldPath,
  nameFieldOf,
  parseDescribe,
  parseGlobal,
  SalesforceMetadataError,
  type DescribeSource,
  type SObjectDescribe,
  type SObjectMeta,
} from './metadata.js';
import { soql, type SoqlBuilder } from './soql.js';

export interface SalesforceClientOptions {
  /** Instance URL, e.g. https://acme.my.salesforce.com */
  instanceUrl: string;
  apiVersion?: string;
  tokenProvider: TokenProvider;
  timeoutMs?: number;
  retry?: RetryPolicy | false;
  fetch?: typeof fetch;
  logger?: Logger;
}

/** A REST API error: HTTP status plus Salesforce errorCode(s) and fields. */
export class SalesforceApiError extends EzTestError {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly fields: string[] = [],
    readonly errors: Array<{ errorCode?: string; message?: string; fields?: string[] }> = [],
  ) {
    super(message, 'SF_API_ERROR', { status, errorCode, fields });
    this.name = 'SalesforceApiError';
  }
}

export type SalesforceRecord = Record<string, unknown> & { Id?: string; attributes?: { type: string; url: string } };

export interface TabInfo {
  label: string;
  name: string;
  sobjectName?: string;
  url?: string;
}

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export function assertRecordId(id: string): string {
  if (typeof id !== 'string' || !SF_ID.test(id)) throw new EzTestError(`Invalid Salesforce record id "${String(id)}"`, 'SF_BAD_ID');
  return id;
}

export class SalesforceClient implements DescribeSource {
  readonly api: ApiClient;
  readonly instanceUrl: string;
  readonly apiVersion: string;
  private readonly logger: Logger;
  private global?: Promise<SObjectMeta[]>;
  private readonly describes = new Map<string, Promise<SObjectDescribe>>();

  constructor(opts: SalesforceClientOptions) {
    if (!opts?.instanceUrl) throw new EzTestError('SalesforceClient needs the instanceUrl', 'SF_CONFIG');
    if (!opts.tokenProvider) throw new EzTestError('SalesforceClient needs a tokenProvider', 'SF_CONFIG');
    this.apiVersion = opts.apiVersion ?? '61.0';
    if (!/^\d{2,3}\.0$/.test(this.apiVersion)) throw new EzTestError(`Invalid Salesforce API version "${this.apiVersion}"`, 'SF_CONFIG');
    this.instanceUrl = opts.instanceUrl.replace(/\/+$/, '').replace(/\/services\/data\/v[\d.]+$/i, '');
    this.logger = opts.logger ?? silentLogger;
    this.api = new ApiClient({
      baseUrl: `${this.instanceUrl}/services/data/v${this.apiVersion}/`,
      auth: { type: 'oauth2', tokenProvider: opts.tokenProvider },
      headers: { accept: 'application/json' },
      timeoutMs: opts.timeoutMs ?? 30_000,
      retry: opts.retry,
      fetch: opts.fetch,
      logger: this.logger,
    });
  }

  private async call(method: string, path: string, o: { query?: Record<string, string>; json?: unknown } = {}): Promise<ApiResponse> {
    const res = await this.api.request(method, path, { query: o.query, json: o.json });
    if (!res.ok) {
      const list = Array.isArray(res.body) ? (res.body as Array<{ errorCode?: string; message?: string; fields?: string[] }>) : [];
      const first = list[0];
      const msg = list.length ? list.map((e) => `${e.errorCode ? `${e.errorCode}: ` : ''}${e.message ?? ''}`).join('; ') : typeof res.body === 'string' ? res.body.slice(0, 300) : res.statusText;
      throw new SalesforceApiError(`Salesforce ${method} ${path.split('?')[0]} failed (${res.status}): ${msg}`, res.status, first?.errorCode, first?.fields ?? [], list);
    }
    return res;
  }

  /** Drop cached describes (e.g. after a release or a deployment). */
  clearCache(): void {
    this.global = undefined;
    this.describes.clear();
  }

  // ------------------------------------------------------------ metadata

  describeGlobal(): Promise<SObjectMeta[]> {
    this.global ??= this.call('GET', 'sobjects')
      .then((r) => parseGlobal(r.body as Record<string, unknown>))
      .catch((e: unknown) => {
        this.global = undefined;
        throw e;
      });
    return this.global;
  }

  async describe(objectName: string): Promise<SObjectDescribe> {
    const n = assertApiName(objectName, 'sObject name');
    const key = n.toLowerCase();
    let p = this.describes.get(key);
    if (!p) {
      p = this.call('GET', `sobjects/${n}/describe`)
        .then((r) => parseDescribe(r.body as Record<string, unknown>))
        .catch((e: unknown) => {
          this.describes.delete(key);
          if (e instanceof SalesforceApiError && e.status === 404) throw new SalesforceMetadataError(`sObject "${n}" does not exist or is not accessible`, 'SF_UNKNOWN_OBJECT', { object: n });
          throw e;
        });
      this.describes.set(key, p);
    }
    return p;
  }

  /** Tabs visible to the authenticated user (REST `tabs` resource). */
  async tabs(): Promise<TabInfo[]> {
    const r = await this.call('GET', 'tabs');
    if (!Array.isArray(r.body)) throw new SalesforceApiError('Salesforce tabs response is not an array', r.status);
    return (r.body as Array<Record<string, unknown>>).map((t) => ({
      label: String(t.label ?? ''),
      name: String(t.name ?? ''),
      ...(typeof t.sobjectName === 'string' ? { sobjectName: t.sobjectName } : {}),
      ...(typeof t.url === 'string' ? { url: t.url } : {}),
    }));
  }

  // ------------------------------------------------------------ records

  async create(objectName: string, data: Record<string, unknown>): Promise<string> {
    if (!data || !Object.keys(data).length) throw new EzTestError('create: no field values given', 'SF_BAD_REQUEST');
    for (const k of Object.keys(data)) assertApiName(k, 'field name');
    const res = await this.call('POST', `sobjects/${assertApiName(objectName, 'sObject name')}`, { json: data });
    const id = (res.body as { id?: unknown }).id;
    if (typeof id !== 'string') throw new SalesforceApiError('Create succeeded but returned no id', res.status);
    return id;
  }

  async retrieve(objectName: string, id: string, fields?: string[]): Promise<SalesforceRecord> {
    const query: Record<string, string> = {};
    if (fields?.length) query.fields = fields.map((f) => assertApiName(f, 'field name')).join(',');
    const res = await this.call('GET', `sobjects/${assertApiName(objectName, 'sObject name')}/${assertRecordId(id)}`, { query });
    return res.body as SalesforceRecord;
  }

  async update(objectName: string, id: string, data: Record<string, unknown>): Promise<void> {
    if (!data || !Object.keys(data).length) throw new EzTestError('update: no field values given', 'SF_BAD_REQUEST');
    for (const k of Object.keys(data)) assertApiName(k, 'field name');
    await this.call('PATCH', `sobjects/${assertApiName(objectName, 'sObject name')}/${assertRecordId(id)}`, { json: data });
  }

  async delete(objectName: string, id: string): Promise<void> {
    await this.call('DELETE', `sobjects/${assertApiName(objectName, 'sObject name')}/${assertRecordId(id)}`);
  }

  /**
   * Run a SOQL query built with soql(): object and field names are validated
   * against this user's describe metadata and every literal is typed and
   * escaped. Follows nextRecordsUrl until done (or `maxRecords`).
   */
  async query<T extends SalesforceRecord = SalesforceRecord>(q: SoqlBuilder, o: { maxRecords?: number } = {}): Promise<T[]> {
    if (!q || typeof (q as Partial<SoqlBuilder>).compile !== 'function') {
      throw new EzTestError('SalesforceClient.query takes a soql() builder; raw SOQL strings are not accepted', 'SF_BAD_SOQL');
    }
    const text = await q.compile(this);
    let res = await this.call('GET', 'query', { query: { q: text } });
    const out: T[] = [];
    for (;;) {
      const b = res.body as { records?: unknown; done?: boolean; nextRecordsUrl?: string };
      if (!Array.isArray(b.records)) throw new SalesforceApiError('SOQL response has no records array', res.status);
      out.push(...(b.records as T[]));
      if (b.done !== false || !b.nextRecordsUrl || (o.maxRecords !== undefined && out.length >= o.maxRecords)) break;
      const m = /\/services\/data\/v[\d.]+\/(query\/[A-Za-z0-9-]+)$/.exec(b.nextRecordsUrl);
      if (!m) throw new SalesforceApiError(`Unexpected nextRecordsUrl ${b.nextRecordsUrl}`, res.status);
      res = await this.call('GET', m[1]);
    }
    return o.maxRecords !== undefined ? out.slice(0, o.maxRecords) : out;
  }

  /** Records whose name field equals `name` (Salesforce compares case-insensitively). */
  async findByName(objectName: string, name: string, o: { fields?: string[]; limit?: number } = {}): Promise<SalesforceRecord[]> {
    if (!name) throw new EzTestError('findByName: empty name', 'SF_BAD_SOQL');
    const d = await this.describe(objectName);
    const nf = nameFieldOf(d);
    const fields = ['Id', nf.name, ...(o.fields ?? [])];
    for (const f of fields) assertFieldPath(f);
    return this.query(soql(d.name).select(fields).where({ [nf.name]: name }).limit(o.limit ?? 10));
  }
}
