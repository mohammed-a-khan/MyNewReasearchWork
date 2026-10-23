/**
 * Oracle Fusion Cloud REST client: resource describe metadata (attribute
 * names, titles, types, mandatory/updatable, LOV references), collection
 * queries with the q= finder syntax (validated attribute names, quoted
 * literals), LOV values and user accounts with their roles.
 */
import { EzTestError } from '../../core/index.js';
import { AppHttp, type AuthHeader } from '../common/http.js';
import { didYouMean, normalizeLabel } from '../common/kit.js';

export interface OracleAttribute { name: string; type: string; title: string; mandatory: boolean; updatable: boolean; lov?: string }
export interface OracleResourceMeta { name: string; title: string; attributes: OracleAttribute[] }
export interface OracleResourceDef {
  /** REST resource name, e.g. purchaseOrders. */
  name: string;
  /** Path, e.g. /fscmRestApi/resources/11.13.18.05/purchaseOrders */
  path: string;
  /** Attribute users identify records by, e.g. OrderNumber. */
  key: string;
  /** UI pages that work on this resource (for impact), e.g. ["Create Purchase Order"]. */
  pages?: string[];
  /** Business name used in phrasings, e.g. "purchase order". */
  label?: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
export const assertOracleName = (s: string, what = 'attribute') => {
  if (!NAME.test(s)) throw new EzTestError(`Invalid Oracle REST ${what} "${s}"`, 'ORA_BAD_NAME');
  return s;
};
/** q=Attr='value';Other='x' (single quotes doubled). */
export function oracleQ(where: Record<string, string>): string {
  return Object.entries(where).map(([k, v]) => `${assertOracleName(k)}='${v.replace(/'/g, "''")}'`).join(';');
}

export interface OracleClientOptions { url: string; auth: AuthHeader; resources: OracleResourceDef[]; timeoutMs?: number; fetch?: typeof fetch }

export class OracleRestClient {
  readonly http: AppHttp;
  private readonly meta = new Map<string, Promise<OracleResourceMeta>>();
  constructor(readonly o: OracleClientOptions) {
    this.http = new AppHttp({
      baseUrl: o.url, auth: o.auth, product: 'Oracle Fusion', timeoutMs: o.timeoutMs, fetch: o.fetch,
      errorMessage: (b) => {
        const x = b as { title?: string; detail?: string } | undefined;
        return x?.detail ?? x?.title;
      },
    });
  }

  get resources(): OracleResourceDef[] {
    return this.o.resources;
  }

  resource(nameOrLabel: string): OracleResourceDef {
    const n = normalizeLabel(nameOrLabel);
    const r = this.o.resources.find((x) => x.name === nameOrLabel || x.name.toLowerCase() === n || (x.label && (normalizeLabel(x.label) === n || normalizeLabel(x.label) + 's' === n)));
    if (!r) throw new EzTestError(`Unknown Oracle REST resource "${nameOrLabel}".${didYouMean(nameOrLabel, this.o.resources.flatMap((x) => [x.name, x.label ?? '']).filter(Boolean))}`, 'ORA_UNKNOWN_RESOURCE');
    return r;
  }

  describe(resource: string): Promise<OracleResourceMeta> {
    const def = this.resource(resource);
    let p = this.meta.get(def.name);
    if (!p) {
      p = this.http.json<{ Resources: Record<string, { title?: string; attributes: Array<Record<string, unknown>> }> }>('GET', `${def.path}/describe`).then((b) => {
        const r = b.Resources?.[def.name] ?? Object.values(b.Resources ?? {})[0];
        if (!r) throw new EzTestError(`${def.name}/describe returned no resource`, 'ORA_BAD_DESCRIBE');
        return {
          name: def.name, title: String(r.title ?? def.name),
          attributes: r.attributes.map((a) => ({
            name: String(a.name), type: String(a.type), title: String(a.title ?? a.name), mandatory: a.mandatory === true, updatable: a.updatable !== false,
            ...(a.lov && typeof a.lov === 'object' && (a.lov as { childRef?: string }).childRef ? { lov: String((a.lov as { childRef: string }).childRef) } : {}),
          })),
        };
      });
      p.catch(() => this.meta.delete(def.name));
      this.meta.set(def.name, p);
    }
    return p;
  }

  clearCache(): void {
    this.meta.clear();
  }

  async attribute(resource: string, ref: string): Promise<OracleAttribute> {
    const m = await this.describe(resource);
    const hit = m.attributes.find((a) => a.name === ref) ?? m.attributes.find((a) => normalizeLabel(a.title) === normalizeLabel(ref));
    if (!hit) throw new EzTestError(`Oracle ${m.name} has no attribute "${ref}".${didYouMean(ref, m.attributes.map((a) => a.title))}`, 'ORA_UNKNOWN_FIELD');
    return hit;
  }

  async query(resource: string, o: { where?: Record<string, string>; fields?: string[]; limit?: number } = {}): Promise<{ q?: string; items: Array<Record<string, unknown>> }> {
    const def = this.resource(resource);
    const query: Record<string, string> = { onlyData: 'true' };
    const q = o.where && Object.keys(o.where).length ? oracleQ(o.where) : undefined;
    if (q) query.q = q;
    if (o.fields?.length) query.fields = o.fields.map((f) => assertOracleName(f)).join(',');
    if (o.limit) query.limit = String(o.limit);
    const b = await this.http.json<{ items: Array<Record<string, unknown>> }>('GET', def.path, { query });
    return { q, items: b.items ?? [] };
  }

  /** Values of an LOV resource referenced by an attribute (child resource in the same REST version). */
  async lovValues(resource: string, attr: OracleAttribute): Promise<string[]> {
    if (!attr.lov) return [];
    const def = this.resource(resource);
    const base = def.path.replace(/\/[^/]+$/, '');
    const b = await this.http.json<{ items: Array<Record<string, unknown>> }>('GET', `${base}/${encodeURIComponent(attr.lov)}`, { query: { onlyData: 'true', limit: '500' } });
    return (b.items ?? []).map((i) => String(Object.entries(i).find(([k]) => /Name$/.test(k))?.[1] ?? Object.values(i)[1] ?? ''));
  }

  /** Roles of a user account (hcmRestApi userAccounts, expanded). */
  async userRoles(username: string, path = '/hcmRestApi/resources/11.13.18.05/userAccounts'): Promise<string[] | undefined> {
    const b = await this.http.json<{ items: Array<{ Username: string; userAccountRoles?: Array<{ RoleCommonName: string }> }> }>('GET', path, { query: { q: oracleQ({ Username: username.toUpperCase() }), expand: 'userAccountRoles', onlyData: 'true' } });
    const acct = (b.items ?? []).find((a) => a.Username.toUpperCase() === username.toUpperCase());
    return acct ? (acct.userAccountRoles ?? []).map((r) => r.RoleCommonName) : undefined;
  }
}
