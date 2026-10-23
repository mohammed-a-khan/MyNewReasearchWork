/**
 * ServiceNow Table API client: records, the dictionary (sys_db_object,
 * sys_dictionary, sys_documentation, sys_choice with table inheritance),
 * catalog items and their variables, update sets (sys_update_set +
 * sys_update_xml) and upgrade history. Encoded queries are built from
 * validated field names and values; a value can never inject another term.
 */
import { EzTestError } from '../../core/index.js';
import { AppHttp, type AuthHeader } from '../common/http.js';
import { didYouMean, normalizeLabel } from '../common/kit.js';

export type SnRecord = Record<string, unknown>;

export interface SnChoice { value: string; label: string }
export interface SnField {
  element: string;
  label: string;
  /** internal_type: string, integer, boolean, reference, glide_date_time, journal_input, ... */
  type: string;
  mandatory: boolean;
  readOnly: boolean;
  reference?: string;
  maxLength: number;
  choices: SnChoice[];
  /** Table that defines the field (a parent for inherited fields). */
  table: string;
}
export interface SnTable { name: string; label: string; parents: string[]; fields: SnField[] }

export interface SnVariable { sysId: string; name: string; label: string; type: string; mandatory: boolean; choices: SnChoice[] }
export interface SnCatalogItem { sysId: string; name: string; variables: SnVariable[] }

export interface SnUpdateXml { sysId: string; name: string; type: string; targetName: string; action: string; payload: string }
export interface SnSkipped { fileName: string; type: string; targetName: string; disposition: string; resolution: string; upgrade: string }

const FIELD = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/;
const TABLE = /^[a-z_][a-z0-9_]*$/;

export function assertSnName(s: string, what: string): string {
  if (!FIELD.test(s)) throw new EzTestError(`Invalid ServiceNow ${what} "${s}"`, 'SN_BAD_NAME');
  return s;
}

/** One `field<op>value` term; values may not contain ^ or line breaks (they would start a new term). */
export function snTerm(field: string, value: string, op: '=' | '!=' | 'IN' | 'LIKE' | 'STARTSWITH' = '='): string {
  assertSnName(field, 'field');
  if (/[\^\r\n]/.test(value)) throw new EzTestError(`A ServiceNow query value cannot contain "^" or a line break: "${value}"`, 'SN_BAD_QUERY');
  return `${field}${op}${value}`;
}

/** AND of equality terms. */
export function snQuery(terms: Record<string, string>): string {
  const parts = Object.entries(terms).map(([k, v]) => snTerm(k, v));
  if (!parts.length) throw new EzTestError('Empty ServiceNow query', 'SN_BAD_QUERY');
  return parts.join('^');
}

const SYS_ID = /^[0-9a-f]{32}$/;
export const isSysId = (s: string) => SYS_ID.test(s);

const str = (v: unknown): string => (v && typeof v === 'object' && 'value' in (v as object) ? String((v as { value: unknown }).value ?? '') : String(v ?? ''));

export interface ServiceNowClientOptions {
  instanceUrl: string;
  auth: AuthHeader;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ServiceNowClient {
  readonly http: AppHttp;
  readonly instanceUrl: string;
  private readonly tables = new Map<string, Promise<SnTable>>();
  private tableList?: Promise<Array<{ name: string; label: string; parent: string }>>;

  constructor(o: ServiceNowClientOptions) {
    this.instanceUrl = o.instanceUrl.replace(/\/+$/, '');
    this.http = new AppHttp({
      baseUrl: this.instanceUrl, auth: o.auth, product: 'ServiceNow', timeoutMs: o.timeoutMs, fetch: o.fetch,
      errorMessage: (b) => {
        const e = (b as { error?: { message?: string; detail?: string } } | undefined)?.error;
        return e ? [e.message, e.detail].filter(Boolean).join(': ') : undefined;
      },
    });
  }

  /** GET /api/now/table/{table}. */
  async query(table: string, o: { query?: string; fields?: string[]; limit?: number; displayValue?: 'true' | 'false' | 'all' } = {}): Promise<SnRecord[]> {
    if (!TABLE.test(table)) throw new EzTestError(`Invalid ServiceNow table "${table}"`, 'SN_BAD_NAME');
    const q: Record<string, string> = { sysparm_exclude_reference_link: 'true' };
    if (o.query) q.sysparm_query = o.query;
    if (o.fields?.length) q.sysparm_fields = o.fields.map((f) => assertSnName(f, 'field')).join(',');
    if (o.limit) q.sysparm_limit = String(o.limit);
    if (o.displayValue) q.sysparm_display_value = o.displayValue;
    const b = await this.http.json<{ result: SnRecord[] }>('GET', `api/now/table/${table}`, { query: q });
    return b.result ?? [];
  }

  async get(table: string, sysId: string, o: { fields?: string[]; displayValue?: 'true' | 'false' | 'all' } = {}): Promise<SnRecord> {
    if (!isSysId(sysId)) throw new EzTestError(`Invalid sys_id "${sysId}"`, 'SN_BAD_ID');
    const q: Record<string, string> = { sysparm_exclude_reference_link: 'true' };
    if (o.fields?.length) q.sysparm_fields = o.fields.map((f) => assertSnName(f, 'field')).join(',');
    if (o.displayValue) q.sysparm_display_value = o.displayValue;
    return (await this.http.json<{ result: SnRecord }>('GET', `api/now/table/${assertSnName(table, 'table')}/${sysId}`, { query: q })).result;
  }

  async create(table: string, data: Record<string, string>): Promise<SnRecord> {
    return (await this.http.json<{ result: SnRecord }>('POST', `api/now/table/${assertSnName(table, 'table')}`, { json: data, query: { sysparm_exclude_reference_link: 'true' } })).result;
  }

  async update(table: string, sysId: string, data: Record<string, string>): Promise<SnRecord> {
    if (!isSysId(sysId)) throw new EzTestError(`Invalid sys_id "${sysId}"`, 'SN_BAD_ID');
    return (await this.http.json<{ result: SnRecord }>('PATCH', `api/now/table/${assertSnName(table, 'table')}/${sysId}`, { json: data, query: { sysparm_exclude_reference_link: 'true' } })).result;
  }

  // ---------------------------------------------------------------- dictionary

  private listTables(): Promise<Array<{ name: string; label: string; parent: string }>> {
    this.tableList ??= this.query('sys_db_object', { fields: ['name', 'label', 'super_class.name'] }).then((rows) =>
      rows.map((r) => ({ name: str(r.name), label: str(r.label), parent: str(r['super_class.name']) })),
    );
    return this.tableList;
  }

  /** Table by name or label ("incident", "Incident", "Change Request"). */
  async resolveTable(nameOrLabel: string): Promise<SnTable> {
    const all = await this.listTables();
    const n = normalizeLabel(nameOrLabel);
    const hit = all.find((t) => t.name === nameOrLabel || t.name === n.replace(/\s+/g, '_')) ?? all.find((t) => normalizeLabel(t.label) === n || normalizeLabel(t.label) + 's' === n);
    if (!hit) throw new EzTestError(`ServiceNow has no table "${nameOrLabel}".${didYouMean(nameOrLabel, all.flatMap((t) => [t.label, t.name]))}`, 'SN_UNKNOWN_TABLE');
    return this.describe(hit.name);
  }

  describe(table: string): Promise<SnTable> {
    let p = this.tables.get(table);
    if (!p) {
      p = this.loadTable(table);
      p.catch(() => this.tables.delete(table));
      this.tables.set(table, p);
    }
    return p;
  }

  private async loadTable(table: string): Promise<SnTable> {
    const all = await this.listTables();
    const chain: string[] = [];
    for (let t = all.find((x) => x.name === table); t && !chain.includes(t.name); t = all.find((x) => x.name === t!.parent)) chain.push(t.name);
    if (!chain.length) throw new EzTestError(`ServiceNow has no table "${table}"`, 'SN_UNKNOWN_TABLE');
    const inList = chain.join(',');
    const [dict, docs, choices] = await Promise.all([
      this.query('sys_dictionary', { query: `nameIN${inList}^elementISNOTEMPTY^active=true`, fields: ['name', 'element', 'column_label', 'internal_type', 'mandatory', 'read_only', 'reference', 'max_length', 'choice'] }),
      this.query('sys_documentation', { query: `nameIN${inList}^language=en`, fields: ['name', 'element', 'label'] }),
      this.query('sys_choice', { query: `nameIN${inList}^inactive=false`, fields: ['name', 'element', 'value', 'label', 'sequence'] }),
    ]);
    const label = (t: string, el: string, fallback: string) => str(docs.find((d) => str(d.name) === t && str(d.element) === el)?.label) || fallback;
    const fields = new Map<string, SnField>();
    for (const t of chain) {
      for (const d of dict.filter((x) => str(x.name) === t)) {
        const el = str(d.element);
        if (fields.has(el)) continue;
        fields.set(el, {
          element: el, label: label(t, el, str(d.column_label)), type: str(d.internal_type), mandatory: str(d.mandatory) === 'true', readOnly: str(d.read_only) === 'true',
          ...(str(d.reference) ? { reference: str(d.reference) } : {}), maxLength: Number(str(d.max_length)) || 0, table: t,
          choices: choices.filter((c) => str(c.element) === el && chain.includes(str(c.name))).filter((c, _i, arr) => {
            // Choices on the most specific table win.
            const own = arr.filter((x) => str(x.name) === t);
            return own.length ? str(c.name) === t : true;
          }).sort((a, b) => Number(str(a.sequence)) - Number(str(b.sequence))).map((c) => ({ value: str(c.value), label: str(c.label) })),
        });
      }
    }
    return { name: table, label: all.find((x) => x.name === table)!.label, parents: chain.slice(1), fields: [...fields.values()] };
  }

  /** Field by label or element name. */
  async resolveField(table: string, ref: string): Promise<SnField> {
    const t = await this.describe(table);
    const n = normalizeLabel(ref);
    const hits = t.fields.filter((f) => f.element === ref || normalizeLabel(f.label) === n);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const own = hits.filter((f) => f.element === ref);
      if (own.length === 1) return own[0];
      throw new EzTestError(`"${ref}" matches ${hits.length} fields on ${table}: ${hits.map((f) => f.element).join(', ')}`, 'SN_AMBIGUOUS');
    }
    throw new EzTestError(`Field "${ref}" not found on ${table}.${didYouMean(ref, t.fields.map((f) => f.label))}`, 'SN_UNKNOWN_FIELD');
  }

  /** Clear cached dictionary (after an update set commit). */
  clearCache(): void {
    this.tables.clear();
    this.tableList = undefined;
  }

  // ---------------------------------------------------------------- catalog

  async catalogItem(name: string): Promise<SnCatalogItem> {
    const items = await this.query('sc_cat_item', { query: `${snTerm('name', name)}^active=true`, fields: ['sys_id', 'name'], limit: 2 });
    if (items.length !== 1) throw new EzTestError(`ServiceNow has ${items.length} active catalog items named "${name}" (expected exactly one)`, items.length ? 'SN_AMBIGUOUS' : 'SN_NOT_FOUND');
    const sysId = str(items[0].sys_id);
    const [vars, choices] = await Promise.all([
      this.query('item_option_new', { query: snTerm('cat_item', sysId), fields: ['sys_id', 'name', 'question_text', 'type', 'mandatory', 'order'] }),
      this.query('question_choice', { query: snTerm('question.cat_item', sysId), fields: ['question', 'value', 'text'] }),
    ]);
    return {
      sysId, name: str(items[0].name),
      variables: vars.sort((a, b) => Number(str(a.order)) - Number(str(b.order))).map((v) => ({
        sysId: str(v.sys_id), name: str(v.name), label: str(v.question_text), type: str(v.type), mandatory: str(v.mandatory) === 'true',
        choices: choices.filter((c) => str(c.question) === str(v.sys_id)).map((c) => ({ value: str(c.value), label: str(c.text) })),
      })),
    };
  }

  // ---------------------------------------------------------------- update sets and upgrades

  async updateSet(nameOrSysId: string): Promise<{ sysId: string; name: string; state: string; updates: SnUpdateXml[] }> {
    const sets = await this.query('sys_update_set', { query: isSysId(nameOrSysId) ? snTerm('sys_id', nameOrSysId) : snTerm('name', nameOrSysId), fields: ['sys_id', 'name', 'state'], limit: 2 });
    if (sets.length !== 1) throw new EzTestError(`ServiceNow has ${sets.length} update sets named "${nameOrSysId}" (expected exactly one)`, sets.length ? 'SN_AMBIGUOUS' : 'SN_NOT_FOUND');
    const sysId = str(sets[0].sys_id);
    const rows = await this.query('sys_update_xml', { query: snTerm('update_set', sysId), fields: ['sys_id', 'name', 'type', 'target_name', 'action', 'payload'] });
    return {
      sysId, name: str(sets[0].name), state: str(sets[0].state),
      updates: rows.map((r) => ({ sysId: str(r.sys_id), name: str(r.name), type: str(r.type), targetName: str(r.target_name), action: str(r.action), payload: str(r.payload) })),
    };
  }

  /** Records an upgrade skipped because they were customised (disposition 4 by default). */
  async skippedRecords(o: { upgrade?: string; query?: string } = {}): Promise<SnSkipped[]> {
    const q = o.query ?? ['disposition=4', ...(o.upgrade ? [snTerm('upgrade_history', o.upgrade)] : [])].join('^');
    const rows = await this.query('sys_upgrade_history_log', { query: q, fields: ['file_name', 'type', 'target_name', 'disposition', 'resolution_status', 'upgrade_history'] });
    return rows.map((r) => ({ fileName: str(r.file_name), type: str(r.type), targetName: str(r.target_name), disposition: str(r.disposition), resolution: str(r.resolution_status), upgrade: str(r.upgrade_history) }));
  }

  /** sys_ui_action by sys_id (to name a skipped/updated UI action). */
  async uiAction(sysId: string): Promise<{ name: string; table: string; actionName: string } | undefined> {
    if (!isSysId(sysId)) return undefined;
    const r = await this.get('sys_ui_action', sysId, { fields: ['name', 'table', 'action_name'] }).catch(() => undefined);
    return r ? { name: str(r.name), table: str(r.table), actionName: str(r.action_name) } : undefined;
  }

  /** Child tables (from the configured list) that inherit from `table`. */
  async childTables(table: string, among: string[]): Promise<string[]> {
    const all = await this.listTables();
    const parentOf = (n: string) => all.find((x) => x.name === n)?.parent;
    return among.filter((t) => {
      for (let p = parentOf(t); p; p = parentOf(p)) if (p === table) return true;
      return false;
    });
  }
}

export const snValue = str;
