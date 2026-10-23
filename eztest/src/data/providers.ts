/** Data providers: SQL tables, REST APIs and seeded synthetic data. */
import { EzTestError } from '../core/index.js';
import type { ApiClient, DbClient, SqlValue } from '../surfaces/index.js';
import { matchesAll, placeholder, quoteIdent, satisfyingValue, toSqlWhere, type Constraint } from './constraints.js';
import { Synthetic } from './synthetic.js';

export type DataRecord = Record<string, unknown>;

export interface DataProvider {
  readonly name: string;
  supports(entity: string): boolean;
  /** Candidate records matching the constraints, best first. */
  find?(entity: string, constraints: Constraint[], opts: { limit: number }): Promise<DataRecord[]>;
  /** Persist a new record; returns it as stored. */
  create?(entity: string, values: DataRecord, constraints: Constraint[]): Promise<DataRecord>;
  /** Build an in-memory record (nothing persisted, nothing to clean up). */
  generate?(entity: string, constraints: Constraint[]): Promise<DataRecord>;
  delete?(entity: string, record: DataRecord): Promise<void>;
  /** Stable identity of a record, used for leases and cleanup. */
  idOf(entity: string, record: DataRecord): string;
}

/** A default may be a literal, a synthetic generator name ("gen:company"), or a function of a Synthetic. */
export type DefaultSpec = unknown | ((s: Synthetic) => unknown);

function resolveDefault(spec: DefaultSpec, s: Synthetic): unknown {
  if (typeof spec === 'function') return (spec as (s: Synthetic) => unknown)(s);
  if (typeof spec === 'string' && spec.startsWith('gen:')) return s.byName(spec.slice(4));
  return spec;
}

/** Values for a new record: defaults, then values that satisfy each constraint. */
export function valuesFor(constraints: Constraint[], defaults: Record<string, DefaultSpec> = {}, s: Synthetic): DataRecord {
  const v: DataRecord = {};
  for (const [k, spec] of Object.entries(defaults)) v[k] = resolveDefault(spec, s);
  for (const c of constraints) {
    const sv = satisfyingValue(c);
    if (sv !== undefined) v[c.field] = sv;
  }
  return v;
}

const camelToSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

// ---------------------------------------------------------------- SQL

export interface SqlEntityMapping {
  table: string;
  /** Primary key column (default "id"). */
  key?: string;
  /** Field -> column (default: camelCase field -> snake_case column). */
  columns?: Record<string, string>;
  /** Defaults by field for created records. */
  defaults?: Record<string, DefaultSpec>;
  /** Column to order candidates by (default key). */
  orderBy?: string;
}

export class SqlDataProvider implements DataProvider {
  readonly name: string;
  private readonly synth: Synthetic;

  constructor(
    private readonly o: { db: DbClient; entities: Record<string, SqlEntityMapping>; name?: string; seed?: string | number },
  ) {
    this.name = o.name ?? `sql:${o.db.name}`;
    this.synth = new Synthetic(o.seed ?? `${this.name}-defaults`);
    for (const [e, m] of Object.entries(o.entities)) {
      quoteIdent(m.table, o.db.dialect);
      quoteIdent(m.key ?? 'id', o.db.dialect);
      if (!e) throw new EzTestError('Entity name is empty', 'DATA_CONFIG');
    }
  }

  supports(entity: string): boolean {
    return entity in this.o.entities;
  }

  private map(entity: string): SqlEntityMapping {
    const m = this.o.entities[entity];
    if (!m) throw new EzTestError(`${this.name} has no mapping for entity ${entity}`, 'DATA_UNKNOWN_ENTITY');
    return m;
  }

  private column(m: SqlEntityMapping, field: string): string {
    return m.columns?.[field] ?? camelToSnake(field);
  }

  /** Add field aliases (creditLimit) next to the raw columns (credit_limit). */
  private withAliases(m: SqlEntityMapping, row: DataRecord): DataRecord {
    const out: DataRecord = { ...row };
    for (const [field, col] of Object.entries(m.columns ?? {})) if (col in row && !(field in out)) out[field] = row[col];
    for (const col of Object.keys(row)) {
      const camel = col.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
      if (camel !== col && !(camel in out)) out[camel] = row[col];
    }
    return out;
  }

  async find(entity: string, constraints: Constraint[], opts: { limit: number }): Promise<DataRecord[]> {
    const m = this.map(entity);
    const d = this.o.db.dialect;
    const where = toSqlWhere(constraints, (f) => this.column(m, f), d);
    const order = quoteIdent(m.orderBy ?? m.key ?? 'id', d);
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit)));
    const table = quoteIdent(m.table, d);
    const sql =
      d === 'mssql'
        ? `SELECT TOP (${limit}) * FROM ${table} WHERE ${where.sql} ORDER BY ${order}`
        : `SELECT * FROM ${table} WHERE ${where.sql} ORDER BY ${order} LIMIT ${limit}`;
    const rows = await this.o.db.query(sql, where.params);
    return rows.map((r) => this.withAliases(m, r));
  }

  async create(entity: string, values: DataRecord, constraints: Constraint[]): Promise<DataRecord> {
    const m = this.map(entity);
    const d = this.o.db.dialect;
    // defaults < values that satisfy the constraints < explicit values
    const merged = { ...valuesFor(constraints, m.defaults, this.synth), ...values };
    const cols: string[] = [];
    const params: SqlValue[] = [];
    for (const [field, v] of Object.entries(merged)) {
      if (v === undefined) continue;
      cols.push(quoteIdent(this.column(m, field), d));
      params.push(v as SqlValue);
    }
    if (cols.length === 0) throw new EzTestError(`Nothing to insert for ${entity}`, 'DATA_CREATE');
    const table = quoteIdent(m.table, d);
    const ph = params.map((_, i) => placeholder(d, i + 1)).join(', ');
    let row: DataRecord | undefined;
    if (d === 'postgres') {
      row = (await this.o.db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, params))[0];
    } else if (d === 'mssql') {
      row = (await this.o.db.query(`INSERT INTO ${table} (${cols.join(', ')}) OUTPUT INSERTED.* VALUES (${ph})`, params))[0];
    } else {
      const r = await this.o.db.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, params);
      row = (await this.o.db.query(`SELECT * FROM ${table} WHERE rowid = ?`, [Number(r.lastInsertId)]))[0];
    }
    if (!row) throw new EzTestError(`Created ${entity} could not be read back`, 'DATA_CREATE');
    return this.withAliases(m, row);
  }

  async delete(entity: string, record: DataRecord): Promise<void> {
    const m = this.map(entity);
    const d = this.o.db.dialect;
    const key = m.key ?? 'id';
    const id = record[key];
    if (id === undefined || id === null) throw new EzTestError(`Cannot delete ${entity}: no ${key}`, 'DATA_DELETE');
    await this.o.db.execute(`DELETE FROM ${quoteIdent(m.table, d)} WHERE ${quoteIdent(key, d)} = ${placeholder(d, 1)}`, [id as SqlValue]);
  }

  idOf(entity: string, record: DataRecord): string {
    const key = this.map(entity).key ?? 'id';
    const id = record[key];
    if (id === undefined || id === null) throw new EzTestError(`${entity} record has no ${key}`, 'DATA_ID');
    return String(id);
  }
}

// ---------------------------------------------------------------- API

export interface ApiEntityMapping {
  /** GET path returning an array (or {items|value|data|results: []}). */
  listPath?: string;
  /** POST path for creation. */
  createPath?: string;
  /** DELETE path with {id}, e.g. "/api/customers/{id}". */
  deletePath?: string;
  idField?: string;
  defaults?: Record<string, DefaultSpec>;
}

export class ApiDataProvider implements DataProvider {
  readonly name: string;
  private readonly synth: Synthetic;

  constructor(private readonly o: { api: ApiClient; entities: Record<string, ApiEntityMapping>; name?: string; seed?: string | number }) {
    this.name = o.name ?? 'api';
    this.synth = new Synthetic(o.seed ?? `${this.name}-defaults`);
  }

  supports(entity: string): boolean {
    return entity in this.o.entities;
  }

  private map(entity: string): ApiEntityMapping {
    const m = this.o.entities[entity];
    if (!m) throw new EzTestError(`${this.name} has no mapping for entity ${entity}`, 'DATA_UNKNOWN_ENTITY');
    return m;
  }

  async find(entity: string, constraints: Constraint[], opts: { limit: number }): Promise<DataRecord[]> {
    const m = this.map(entity);
    if (!m.listPath) return [];
    const res = await this.o.api.get(m.listPath);
    if (!res.ok) throw new EzTestError(`${this.name}: GET ${m.listPath} returned ${res.status}`, 'DATA_API');
    const b = res.body as unknown;
    const list = Array.isArray(b)
      ? b
      : b && typeof b === 'object'
        ? ((['items', 'value', 'data', 'results'].map((k) => (b as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? undefined)
        : undefined;
    if (!list) throw new EzTestError(`${this.name}: GET ${m.listPath} did not return a list`, 'DATA_API');
    return (list.filter((r) => r && typeof r === 'object') as DataRecord[]).filter((r) => matchesAll(r, constraints)).slice(0, opts.limit);
  }

  async create(entity: string, values: DataRecord, constraints: Constraint[]): Promise<DataRecord> {
    const m = this.map(entity);
    if (!m.createPath) throw new EzTestError(`${this.name}: entity ${entity} has no createPath`, 'DATA_CONFIG');
    const body = { ...valuesFor(constraints, m.defaults, this.synth), ...values };
    const res = await this.o.api.post(m.createPath, { json: body });
    if (!res.ok) throw new EzTestError(`${this.name}: POST ${m.createPath} returned ${res.status}`, 'DATA_API');
    if (!res.body || typeof res.body !== 'object') throw new EzTestError(`${this.name}: POST ${m.createPath} returned no record`, 'DATA_API');
    return res.body as DataRecord;
  }

  async delete(entity: string, record: DataRecord): Promise<void> {
    const m = this.map(entity);
    if (!m.deletePath) throw new EzTestError(`${this.name}: entity ${entity} has no deletePath; created data cannot be cleaned up`, 'DATA_CONFIG');
    const path = m.deletePath.replace('{id}', encodeURIComponent(this.idOf(entity, record)));
    const res = await this.o.api.delete(path);
    if (!res.ok && res.status !== 404) throw new EzTestError(`${this.name}: DELETE ${path} returned ${res.status}`, 'DATA_API');
  }

  idOf(entity: string, record: DataRecord): string {
    const f = this.map(entity).idField ?? 'id';
    const id = record[f];
    if (id === undefined || id === null) throw new EzTestError(`${entity} record has no ${f}`, 'DATA_ID');
    return String(id);
  }
}

// ---------------------------------------------------------------- synthetic

export class SyntheticProvider implements DataProvider {
  readonly name: string;
  readonly synthetic: Synthetic;
  private counter = 0;

  constructor(private readonly o: { seed?: string | number; entities: Record<string, Record<string, DefaultSpec>>; name?: string }) {
    this.name = o.name ?? 'synthetic';
    this.synthetic = new Synthetic(o.seed ?? 42);
  }

  supports(entity: string): boolean {
    return entity in this.o.entities;
  }

  async generate(entity: string, constraints: Constraint[]): Promise<DataRecord> {
    const fields = this.o.entities[entity];
    if (!fields) throw new EzTestError(`${this.name} has no generator for entity ${entity}`, 'DATA_UNKNOWN_ENTITY');
    const rec: DataRecord = { id: `${entity.toLowerCase()}-${++this.counter}`, ...valuesFor(constraints, fields, this.synthetic) };
    if (!matchesAll(rec, constraints)) {
      throw new EzTestError(`${this.name}: generated ${entity} does not satisfy its constraints`, 'DATA_GENERATE');
    }
    return rec;
  }

  idOf(_entity: string, record: DataRecord): string {
    return String(record.id);
  }
}
