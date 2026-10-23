/**
 * Safe SOQL builder. User text never reaches SOQL unescaped:
 *  - object / field names are validated as API names (and, with compile(),
 *    against describe metadata, following one or more relationship hops);
 *  - values become literals of the field's type: strings are quoted with
 *    every SOQL escape applied, dates/numbers/booleans are validated and
 *    emitted unquoted, ids must look like Salesforce ids;
 *  - LIKE helpers (contains/startsWith/endsWith) escape % and _ in user text.
 *
 *   soql('Account').select('Id', 'Name', 'Owner.Name').where({ Name: "O'Brien" }).limit(5)
 */
import { EzTestError } from '../core/index.js';
import { assertApiName, assertFieldPath, SalesforceMetadataError, type DescribeSource, type FieldMeta, type SObjectDescribe } from './metadata.js';

export class SoqlBuildError extends EzTestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SF_BAD_SOQL', details);
    this.name = 'SoqlBuildError';
  }
}

export type SoqlScalar = string | number | boolean | null | Date;
export interface SoqlOperators {
  eq?: SoqlScalar;
  ne?: SoqlScalar;
  lt?: SoqlScalar;
  lte?: SoqlScalar;
  gt?: SoqlScalar;
  gte?: SoqlScalar;
  /** Raw LIKE pattern: % and _ are wildcards (escape user text with escapeSoqlLike). */
  like?: string;
  /** LIKE '%text%' with text escaped. */
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  in?: SoqlScalar[];
  notIn?: SoqlScalar[];
}
export type SoqlCondition = SoqlScalar | SoqlOperators;

const OPS: Record<keyof SoqlOperators, string> = {
  eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE', contains: 'LIKE', startsWith: 'LIKE', endsWith: 'LIKE', in: 'IN', notIn: 'NOT IN',
};

const ESC: Record<string, string> = { '\\': '\\\\', "'": "\\'", '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/** Escape text for use inside a SOQL string literal (without the quotes). */
export function escapeSoqlString(s: string): string {
  if (typeof s !== 'string') throw new SoqlBuildError(`Expected a string, got ${typeof s}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0007\u000b\u000e-\u001f]/.test(s)) throw new SoqlBuildError('SOQL string values cannot contain control characters');
  return s.replace(/[\\'"\n\r\t\b\f]/g, (c) => ESC[c]);
}

/** A quoted, escaped SOQL string literal. */
export function soqlString(s: string): string {
  return `'${escapeSoqlString(s)}'`;
}

/** Escape text for a LIKE pattern: string escapes plus \% and \_. */
export function escapeSoqlLike(s: string): string {
  return escapeSoqlString(s).replace(/[%_]/g, (c) => `\\${c}`);
}

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const NUMERIC_TYPES = new Set(['currency', 'double', 'int', 'percent', 'long']);
const DATE_TYPES = new Set(['date']);
const DATETIME_TYPES = new Set(['datetime']);

function validDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Render one value as a SOQL literal; `field` (from describe) decides the literal type. */
export function soqlLiteral(v: SoqlScalar, field?: Pick<FieldMeta, 'name' | 'type'>): string {
  const where = field ? ` for ${field.name} (${field.type})` : '';
  if (v === null) return 'null';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new SoqlBuildError(`Invalid Date${where}`);
    if (field && DATE_TYPES.has(field.type)) return v.toISOString().slice(0, 10);
    return v.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const type = field?.type;
  if (type && NUMERIC_TYPES.has(type)) {
    const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
    if (!NUMBER.test(s)) throw new SoqlBuildError(`"${String(v)}" is not a number${where}`);
    if (type === 'int' && s.includes('.')) throw new SoqlBuildError(`"${String(v)}" is not an integer${where}`);
    return s;
  }
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase();
    throw new SoqlBuildError(`"${String(v)}" is not a boolean${where}`);
  }
  if (type && DATE_TYPES.has(type)) {
    if (typeof v === 'string' && validDate(v.trim())) return v.trim();
    throw new SoqlBuildError(`"${String(v)}" is not a date (YYYY-MM-DD)${where}`);
  }
  if (type && DATETIME_TYPES.has(type)) {
    if (typeof v === 'string' && ISO_DATETIME.test(v.trim())) return v.trim();
    throw new SoqlBuildError(`"${String(v)}" is not an ISO-8601 datetime${where}`);
  }
  if (type === 'id' || type === 'reference') {
    if (typeof v === 'string' && SF_ID.test(v)) return soqlString(v);
    throw new SoqlBuildError(`"${String(v)}" is not a Salesforce id${where}`);
  }
  if (type) return soqlString(String(v));
  // No metadata: infer from the JS type.
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SoqlBuildError(`Cannot use non-finite number ${v} in SOQL`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return soqlString(v);
}

interface Clause {
  path: string;
  op: string;
  value: SoqlScalar | SoqlScalar[];
  likeMode?: 'raw' | 'contains' | 'startsWith' | 'endsWith';
}

/** Resolves a field path to its describe metadata (and canonical spelling). */
export type FieldTyper = (path: string) => { path: string; field: FieldMeta };

export class SoqlBuilder {
  private readonly fields: string[] = [];
  private readonly clauses: Clause[] = [];
  private order?: { path: string; dir: 'ASC' | 'DESC'; nulls?: 'FIRST' | 'LAST' };
  private max?: number;

  constructor(readonly object: string) {
    assertApiName(object, 'sObject name');
  }

  select(...fields: Array<string | string[]>): this {
    for (const f of fields.flat()) {
      assertFieldPath(f, 'SELECT field');
      if (!this.fields.some((x) => x.toLowerCase() === f.toLowerCase())) this.fields.push(f);
    }
    return this;
  }

  /** AND-ed conditions: `{ Name: 'Acme', Amount: { gt: 1000 }, StageName: { in: ['A', 'B'] } }`. */
  where(conds: Record<string, SoqlCondition>): this {
    if (!conds || typeof conds !== 'object' || Array.isArray(conds)) throw new SoqlBuildError('where() expects an object of field conditions');
    const entries = Object.entries(conds);
    if (!entries.length) throw new SoqlBuildError('where() needs at least one condition');
    for (const [path, c] of entries) {
      assertFieldPath(path, 'WHERE field');
      if (c !== null && typeof c === 'object' && !(c instanceof Date)) {
        const ops = Object.entries(c) as Array<[keyof SoqlOperators, unknown]>;
        if (!ops.length) throw new SoqlBuildError(`Empty condition for ${path}`);
        for (const [k, v] of ops) {
          if (!(k in OPS)) throw new SoqlBuildError(`Unknown SOQL operator "${String(k)}" for ${path}`);
          if (k === 'in' || k === 'notIn') {
            if (!Array.isArray(v) || !v.length) throw new SoqlBuildError(`${k} for ${path} needs a non-empty array`);
            this.clauses.push({ path, op: OPS[k], value: v as SoqlScalar[] });
          } else if (k === 'like' || k === 'contains' || k === 'startsWith' || k === 'endsWith') {
            if (typeof v !== 'string' || !v) throw new SoqlBuildError(`${k} for ${path} needs a non-empty string`);
            this.clauses.push({ path, op: 'LIKE', value: v, likeMode: k === 'like' ? 'raw' : k });
          } else {
            if (v === null && k !== 'eq' && k !== 'ne') throw new SoqlBuildError(`null can only be compared with eq/ne (${path})`);
            this.clauses.push({ path, op: OPS[k], value: v as SoqlScalar });
          }
        }
      } else this.clauses.push({ path, op: '=', value: c as SoqlScalar });
    }
    return this;
  }

  orderBy(path: string, dir: 'ASC' | 'DESC' = 'ASC', nulls?: 'FIRST' | 'LAST'): this {
    assertFieldPath(path, 'ORDER BY field');
    if (dir !== 'ASC' && dir !== 'DESC') throw new SoqlBuildError(`Invalid sort direction ${String(dir)}`);
    if (nulls !== undefined && nulls !== 'FIRST' && nulls !== 'LAST') throw new SoqlBuildError(`Invalid NULLS ${String(nulls)}`);
    this.order = { path, dir, nulls };
    return this;
  }

  limit(n: number): this {
    if (!Number.isInteger(n) || n < 1 || n > 50_000) throw new SoqlBuildError(`Invalid LIMIT ${n} (1..50000)`);
    this.max = n;
    return this;
  }

  /** Paths used anywhere in the query (for metadata validation). */
  paths(): string[] {
    return [...new Set([...this.fields, ...this.clauses.map((c) => c.path), ...(this.order ? [this.order.path] : [])])];
  }

  private render(object: string, typer?: FieldTyper): string {
    if (!this.fields.length) throw new SoqlBuildError('SOQL needs at least one SELECT field');
    const t = (p: string) => (typer ? typer(p) : { path: p, field: undefined as FieldMeta | undefined });
    const parts = [`SELECT ${this.fields.map((f) => t(f).path).join(', ')} FROM ${object}`];
    if (this.clauses.length) {
      const conds = this.clauses.map((c) => {
        const { path, field } = t(c.path);
        if (c.op === 'IN' || c.op === 'NOT IN') return `${path} ${c.op} (${(c.value as SoqlScalar[]).map((v) => soqlLiteral(v, field)).join(', ')})`;
        if (c.op === 'LIKE') {
          if (field && !['string', 'textarea', 'picklist', 'phone', 'email', 'url', 'multipicklist', 'combobox'].includes(field.type)) {
            throw new SoqlBuildError(`LIKE is not supported on ${field.name} (${field.type})`);
          }
          const s = String(c.value);
          const body = c.likeMode === 'raw' ? escapeSoqlString(s) : escapeSoqlLike(s);
          const pat = c.likeMode === 'contains' ? `%${body}%` : c.likeMode === 'startsWith' ? `${body}%` : c.likeMode === 'endsWith' ? `%${body}` : body;
          return `${path} LIKE '${pat}'`;
        }
        return `${path} ${c.op} ${soqlLiteral(c.value as SoqlScalar, field)}`;
      });
      parts.push(`WHERE ${conds.join(' AND ')}`);
    }
    if (this.order) parts.push(`ORDER BY ${t(this.order.path).path} ${this.order.dir}${this.order.nulls ? ` NULLS ${this.order.nulls}` : ''}`);
    if (this.max !== undefined) parts.push(`LIMIT ${this.max}`);
    return parts.join(' ');
  }

  /** Build with syntax-level validation only (API-name shape; literals typed from JS values). */
  toSoql(): string {
    return this.render(this.object);
  }

  toString(): string {
    return this.toSoql();
  }

  /**
   * Validate the object and every field path against describe metadata
   * (following relationships), type every literal by its field, then build.
   */
  async compile(source: DescribeSource): Promise<string> {
    const base = await source.describe(this.object);
    const resolved = new Map<string, { path: string; field: FieldMeta }>();
    for (const p of this.paths()) resolved.set(p.toLowerCase(), await resolveFieldPath(source, base, p));
    return this.render(base.name, (p) => resolved.get(p.toLowerCase())!);
  }
}

/** Start a SOQL query on `object`. */
export function soql(object: string): SoqlBuilder {
  return new SoqlBuilder(object);
}

/** Resolve `Rel.Field` paths against describe metadata; returns the canonical path and the leaf field. */
export async function resolveFieldPath(source: DescribeSource, base: SObjectDescribe, path: string): Promise<{ path: string; field: FieldMeta }> {
  const parts = assertFieldPath(path);
  let cur = base;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i === parts.length - 1) {
      const f = cur.fields.find((x) => x.name.toLowerCase() === p.toLowerCase());
      if (!f) {
        throw new SalesforceMetadataError(`No field "${p}" on ${cur.name}${i ? ` (in path ${path})` : ''}`, 'SF_UNKNOWN_FIELD', { object: cur.name, field: p });
      }
      out.push(f.name);
      return { path: out.join('.'), field: f };
    }
    const rel = cur.fields.find((x) => x.type === 'reference' && x.relationshipName?.toLowerCase() === p.toLowerCase());
    if (!rel) throw new SalesforceMetadataError(`No relationship "${p}" on ${cur.name} (in path ${path})`, 'SF_UNKNOWN_FIELD', { object: cur.name, field: p });
    if ((rel.referenceTo ?? []).length !== 1) {
      throw new SalesforceMetadataError(`Relationship ${cur.name}.${p} is polymorphic (${(rel.referenceTo ?? []).join(', ')}); use TYPEOF instead`, 'SF_POLYMORPHIC');
    }
    out.push(rel.relationshipName!);
    cur = await source.describe(rel.referenceTo![0]);
  }
  throw new SalesforceMetadataError(`Invalid field path "${path}"`, 'SF_BAD_NAME');
}
