/**
 * Workday API client: REST (/ccx/api/v1/{tenant}), WQL (/ccx/api/wql/v1/{tenant})
 * with data-source field metadata, SOAP Human_Resources Get_Workers with a
 * WS-Security UsernameToken (integration system user), and RaaS custom
 * reports (e.g. a "What's New in Workday" export). WQL is built from
 * validated aliases and quoted literals only.
 */
import { XMLParser } from 'fast-xml-parser';
import { EzTestError } from '../../core/index.js';
import type { SecretHandle } from '../../identity/handle.js';
import { escapeXml } from '../../surfaces/index.js';
import { AppHttp, type AuthHeader } from '../common/http.js';
import { didYouMean, normalizeLabel } from '../common/kit.js';

export interface WqlField { alias: string; descriptor: string; type: string }
export type WqlRow = Record<string, string>;

const ALIAS = /^[A-Za-z][A-Za-z0-9_]*$/;
export function assertAlias(s: string, what = 'field'): string {
  if (!ALIAS.test(s)) throw new EzTestError(`Invalid WQL ${what} "${s}"`, 'WD_BAD_NAME');
  return s;
}
export const wqlString = (v: string) => {
  if (/[\r\n]/.test(v)) throw new EzTestError('A WQL value cannot contain a line break', 'WD_BAD_QUERY');
  return `'${v.replace(/'/g, "''")}'`;
};

/** SELECT a, b FROM ds WHERE x = 'v' AND ... LIMIT n */
export function buildWql(dataSource: string, select: string[], where: Record<string, string> = {}, limit?: number): string {
  const cols = select.map((c) => assertAlias(c)).join(', ');
  const conds = Object.entries(where).map(([k, v]) => `${assertAlias(k)} = ${wqlString(v)}`);
  return `SELECT ${cols} FROM ${assertAlias(dataSource, 'data source')}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}${limit ? ` LIMIT ${Math.floor(limit)}` : ''}`;
}

const soapParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false });

/** Flatten a SOAP response element into leaf name -> text (first occurrence), plus Formatted_Name-style attributes. */
export function flattenXml(node: unknown, out: Record<string, string> = {}): Record<string, string> {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith('@_')) {
      if (!(k.slice(2) in out) && k !== '@_type' && !k.startsWith('@_xmlns')) out[k.slice(2)] = String(v);
      continue;
    }
    if (k === '#text') continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item && typeof item === 'object') {
        const t = (item as Record<string, unknown>)['#text'];
        if (t !== undefined && !(k in out)) out[k] = String(t);
        flattenXml(item, out);
      } else if (!(k in out)) out[k] = String(item ?? '');
    }
  }
  return out;
}

export interface WorkdayClientOptions {
  /** Services host, e.g. https://wd2-impl-services1.workday.com */
  baseUrl: string;
  tenant: string;
  auth: AuthHeader;
  /** Integration system user for SOAP (WS-Security). */
  isu?: { username: string; password: SecretHandle };
  soapVersion?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class WorkdayClient {
  readonly http: AppHttp;
  private readonly fieldCache = new Map<string, Promise<WqlField[]>>();
  constructor(readonly o: WorkdayClientOptions) {
    if (!/^[\w-]+$/.test(o.tenant)) throw new EzTestError(`Invalid Workday tenant "${o.tenant}"`, 'WD_CONFIG');
    this.http = new AppHttp({
      baseUrl: o.baseUrl, auth: o.auth, product: 'Workday', timeoutMs: o.timeoutMs, fetch: o.fetch,
      errorMessage: (b) => {
        const x = b as { error?: string; errors?: Array<{ error: string }> } | undefined;
        return x?.error ? [x.error, ...(x.errors ?? []).map((e) => e.error)].join(': ') : undefined;
      },
    });
  }

  get tenant(): string {
    return this.o.tenant;
  }

  async workers(search?: string): Promise<Array<Record<string, unknown>>> {
    const b = await this.http.json<{ data: Array<Record<string, unknown>> }>('GET', `ccx/api/v1/${this.o.tenant}/workers`, { query: search ? { search } : {} });
    return b.data ?? [];
  }

  fields(dataSource: string): Promise<WqlField[]> {
    let p = this.fieldCache.get(dataSource);
    if (!p) {
      p = this.http.json<{ data: WqlField[] }>('GET', `ccx/api/wql/v1/${this.o.tenant}/dataSources/${encodeURIComponent(assertAlias(dataSource, 'data source'))}/fields`).then((b) => b.data ?? []);
      p.catch(() => this.fieldCache.delete(dataSource));
      this.fieldCache.set(dataSource, p);
    }
    return p;
  }

  clearCache(): void {
    this.fieldCache.clear();
  }

  /** Field by descriptor (label) or alias. */
  async field(dataSource: string, ref: string): Promise<WqlField> {
    const fs = await this.fields(dataSource);
    const hit = fs.find((f) => f.alias === ref) ?? fs.find((f) => normalizeLabel(f.descriptor) === normalizeLabel(ref));
    if (!hit) throw new EzTestError(`Workday data source ${dataSource} has no field "${ref}".${didYouMean(ref, fs.map((f) => f.descriptor))}`, 'WD_UNKNOWN_FIELD');
    return hit;
  }

  /** Run WQL; instance values ({descriptor, id}) are returned as their descriptor. */
  async wql(dataSource: string, select: string[], where: Record<string, string> = {}, limit?: number): Promise<{ query: string; rows: WqlRow[] }> {
    const query = buildWql(dataSource, select, where, limit);
    const b = await this.http.json<{ data: Array<Record<string, unknown>> }>('GET', `ccx/api/wql/v1/${this.o.tenant}/data`, { query: { query } });
    const rows = (b.data ?? []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? String((v as { descriptor?: unknown }).descriptor ?? '') : String(v ?? '')])));
    return { query, rows };
  }

  /** SOAP Get_Workers for one Employee_ID, flattened. */
  async getWorker(employeeId: string): Promise<Record<string, string>> {
    if (!this.o.isu) throw new EzTestError('Workday SOAP needs workday.isu (integration system user)', 'WD_CONFIG');
    const user = escapeXml(this.o.isu.username);
    const pass = escapeXml(await this.o.isu.password.resolve());
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wd="urn:com.workday/bsvc"><soapenv:Header><wsse:Security soapenv:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><wsse:UsernameToken><wsse:Username>${user}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${pass}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>`
      + `<soapenv:Body><wd:Get_Workers_Request wd:version="${this.o.soapVersion ?? 'v42.0'}"><wd:Request_References wd:Skip_Non_Existing_Instances="false"><wd:Worker_Reference><wd:ID wd:type="Employee_ID">${escapeXml(employeeId)}</wd:ID></wd:Worker_Reference></wd:Request_References><wd:Response_Group><wd:Include_Personal_Information>true</wd:Include_Personal_Information><wd:Include_Employment_Information>true</wd:Include_Employment_Information></wd:Response_Group></wd:Get_Workers_Request></soapenv:Body></soapenv:Envelope>`;
    const res = await this.http.api.request('POST', `ccx/service/${this.o.tenant}/Human_Resources/${this.o.soapVersion ?? 'v42.0'}`, { body: envelope, auth: false, headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""' } });
    const doc = soapParser.parse(res.text) as Record<string, unknown>;
    const bodyEl = ((doc.Envelope as Record<string, unknown>)?.Body ?? {}) as Record<string, unknown>;
    if (bodyEl.Fault) {
      const f = bodyEl.Fault as Record<string, unknown>;
      throw new EzTestError(`Workday SOAP Get_Workers failed: ${String(f.faultstring ?? f.faultcode ?? 'fault')}`, 'WD_SOAP_FAULT');
    }
    const worker = (((bodyEl.Get_Workers_Response as Record<string, unknown>)?.Response_Data as Record<string, unknown>)?.Worker) as Record<string, unknown> | undefined;
    if (!worker) throw new EzTestError(`Workday has no worker with Employee_ID ${employeeId}`, 'WD_NOT_FOUND');
    return flattenXml(worker);
  }

  /** A RaaS custom report as JSON rows (Report_Entry). */
  async report(owner: string, name: string): Promise<Array<Record<string, string>>> {
    const b = await this.http.json<{ Report_Entry?: Array<Record<string, string>> }>('GET', `ccx/service/customreport2/${this.o.tenant}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { query: { format: 'json' } });
    return b.Report_Entry ?? [];
  }
}
