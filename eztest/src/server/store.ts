/**
 * Results-server storage. Metadata lives in SQL (SQLite by default through the
 * built-in node:sqlite; PostgreSQL or SQL Server through the optional `pg` /
 * `mssql` drivers EZTest already uses for database steps). Run files
 * (evidence, reports) live on disk under the server's data directory.
 *
 * All SQL here is written with `?` markers and translated to the dialect's
 * markers; values are always bound, never spliced.
 */
import { connectDb, type DbClient, type DbConnectionSpec, type Row, type SqlValue } from '../surfaces/db.js';
import type { SqlDialect } from '../surfaces/db-sql.js';

export type { DbConnectionSpec };

/** `?` -> `$n` (postgres) / `@pn` (mssql). Only used on this module's own SQL (no `?` inside literals). */
export function dialectSql(sql: string, dialect: SqlDialect): string {
  if (dialect === 'sqlite') return sql;
  let n = 0;
  return sql.replace(/\?/g, () => (dialect === 'postgres' ? `$${++n}` : dialect === 'mssql' ? `@p${++n}` : `:${++n}`));
}

const TYPES: Record<SqlDialect, { key: string; text: string; int: string; big: string }> = {
  sqlite: { key: 'TEXT', text: 'TEXT', int: 'INTEGER', big: 'INTEGER' },
  postgres: { key: 'VARCHAR(300)', text: 'TEXT', int: 'INTEGER', big: 'BIGINT' },
  mssql: { key: 'NVARCHAR(300)', text: 'NVARCHAR(MAX)', int: 'INT', big: 'BIGINT' },
  oracle: { key: 'VARCHAR2(300)', text: 'CLOB', int: 'NUMBER(10)', big: 'NUMBER(19)' },
};

function ddl(d: SqlDialect): string[] {
  const t = TYPES[d];
  const K = t.key;
  return [
    `CREATE TABLE ez_meta (k ${K} NOT NULL PRIMARY KEY, v ${t.text})`,
    `CREATE TABLE ez_runs (project ${K} NOT NULL, run_id ${K} NOT NULL, started_at ${K} NOT NULL, finished_at ${K}, duration_ms ${t.big},
      total ${t.int}, passed ${t.int}, healed ${t.int}, failed ${t.int}, skipped ${t.int}, errors ${t.int},
      readiness ${K}, readiness_score ${t.int}, evidence_head ${K}, verified ${t.int}, state ${K}, branch ${K}, commit_sha ${K},
      uploaded_by ${K}, uploaded_at ${K}, files_bytes ${t.big}, evidence_deleted_at ${K}, signed ${t.int}, signed_by ${K}, signed_at ${K},
      data ${t.text}, PRIMARY KEY (project, run_id))`,
    `CREATE INDEX ez_runs_started ON ez_runs (project, started_at)`,
    `CREATE TABLE ez_journeys (project ${K} NOT NULL, run_id ${K} NOT NULL, journey_id ${K} NOT NULL, name ${t.text}, status ${K},
      duration_ms ${t.big}, risk ${t.int}, attempt ${t.int}, signature ${K}, started_at ${K}, requirements ${t.text}, tags ${t.text},
      PRIMARY KEY (project, run_id, journey_id))`,
    `CREATE INDEX ez_journeys_j ON ez_journeys (project, journey_id)`,
    `CREATE TABLE ez_heals (project ${K} NOT NULL, run_id ${K} NOT NULL, journey_id ${K} NOT NULL, step_id ${K} NOT NULL, tier ${K},
      confidence ${t.int}, verified ${t.int}, from_loc ${t.text}, to_loc ${t.text}, PRIMARY KEY (project, run_id, journey_id, step_id))`,
    `CREATE TABLE ez_state (project ${K} NOT NULL, kind ${K} NOT NULL, data ${t.text}, updated_at ${K}, updated_by ${K}, PRIMARY KEY (project, kind))`,
    `CREATE TABLE ez_audit (seq ${t.big} NOT NULL PRIMARY KEY, at ${K} NOT NULL, actor ${K} NOT NULL, action ${K} NOT NULL, project ${K},
      target ${t.text}, details ${t.text}, prev_hash ${K} NOT NULL, hash ${K} NOT NULL)`,
    `CREATE TABLE ez_tokens (id ${K} NOT NULL PRIMARY KEY, name ${K}, hash ${K} NOT NULL, created_by ${K}, created_at ${K},
      expires_at ${K}, revoked ${t.int}, last_used_at ${K}, grants ${t.text})`,
    `CREATE UNIQUE INDEX ez_tokens_hash ON ez_tokens (hash)`,
    `CREATE TABLE ez_grants (subject ${K} NOT NULL, project ${K} NOT NULL, role ${K} NOT NULL, granted_by ${K}, granted_at ${K}, PRIMARY KEY (subject, project))`,
    `CREATE TABLE ez_sessions (id_hash ${K} NOT NULL PRIMARY KEY, subject ${K} NOT NULL, profile ${t.text}, csrf ${K} NOT NULL,
      created_at ${K}, expires_at ${t.big} NOT NULL)`,
    `CREATE TABLE ez_locks (project ${K} NOT NULL, lock_key ${K} NOT NULL, owner ${K}, token ${K} NOT NULL, expires_at ${t.big} NOT NULL,
      PRIMARY KEY (project, lock_key))`,
    `CREATE TABLE ez_projects (project ${K} NOT NULL PRIMARY KEY, retention_days ${t.int}, created_at ${K})`,
  ];
}

/** Schema 2: EZTest contracts (published contracts, verification results, releases per environment). */
function ddlV2(d: SqlDialect): string[] {
  const t = TYPES[d];
  const K = t.key;
  return [
    `CREATE TABLE ez_contracts (project ${K} NOT NULL, consumer ${K} NOT NULL, provider ${K} NOT NULL, consumer_version ${K} NOT NULL, branch ${K},
      hash ${K} NOT NULL, data ${t.text}, published_at ${K}, published_by ${K}, PRIMARY KEY (project, consumer, provider, consumer_version))`,
    `CREATE INDEX ez_contracts_provider ON ez_contracts (project, provider)`,
    `CREATE TABLE ez_contract_verifications (project ${K} NOT NULL, provider ${K} NOT NULL, provider_version ${K} NOT NULL, hash ${K} NOT NULL,
      consumer ${K}, consumer_version ${K}, provider_branch ${K}, passed ${t.int}, data ${t.text}, verified_at ${K}, verified_by ${K},
      PRIMARY KEY (project, provider, provider_version, hash))`,
    `CREATE TABLE ez_releases (project ${K} NOT NULL, app ${K} NOT NULL, environment ${K} NOT NULL, version ${K} NOT NULL, released_at ${K}, released_by ${K},
      PRIMARY KEY (project, app, environment))`,
  ];
}

export const SCHEMA_VERSION = 2;

/** Thin SQL helper with dialect-aware markers and paging. */
export class Store {
  private constructor(readonly db: DbClient) {}

  get dialect(): SqlDialect {
    return this.db.dialect;
  }

  static async open(spec: DbConnectionSpec): Promise<Store> {
    const db = await connectDb('eztest-server', spec);
    const s = new Store(db);
    await s.migrate();
    return s;
  }

  static async fromClient(db: DbClient): Promise<Store> {
    const s = new Store(db);
    await s.migrate();
    return s;
  }

  private async migrate(): Promise<void> {
    let version = 0;
    try {
      const rows = await this.db.query(dialectSql('SELECT v FROM ez_meta WHERE k = ?', this.dialect), ['schema']);
      version = rows.length ? Number(rows[0].v) : 0;
    } catch {
      version = 0;
    }
    if (version >= SCHEMA_VERSION) return;
    await this.db.transaction(async (tx) => {
      const stmts = [...(version < 1 ? ddl(this.dialect) : []), ...(version < 2 ? ddlV2(this.dialect) : [])];
      for (const stmt of stmts) await tx.execute(stmt.replace(/\s+/g, ' '));
      await tx.execute(dialectSql(version < 1 ? 'INSERT INTO ez_meta (v, k) VALUES (?, ?)' : 'UPDATE ez_meta SET v = ? WHERE k = ?', this.dialect), [String(SCHEMA_VERSION), 'schema']);
    });
  }

  async all<T extends Row = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.query<T>(dialectSql(sql, this.dialect), params);
  }

  async one<T extends Row = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<number> {
    return (await this.db.execute(dialectSql(sql, this.dialect), params)).rowsAffected;
  }

  /** `ORDER BY ...` plus a row limit in the dialect's syntax. */
  page(orderBy: string, limit: number, offset = 0): string {
    const n = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const o = Math.max(0, Math.floor(offset));
    return this.dialect === 'mssql' || this.dialect === 'oracle'
      ? ` ORDER BY ${orderBy} OFFSET ${o} ROWS FETCH NEXT ${n} ROWS ONLY`
      : ` ORDER BY ${orderBy} LIMIT ${n} OFFSET ${o}`;
  }

  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return this.db.transaction(async (t) => fn(new Store(t)));
  }

  /** Insert, or report a primary-key conflict as `false` (portable "insert if absent"). */
  async tryInsert(sql: string, params: SqlValue[]): Promise<boolean> {
    try {
      await this.run(sql, params);
      return true;
    } catch (e) {
      if (/unique|duplicate|primary key|constraint/i.test((e as Error).message)) return false;
      throw e;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.all('SELECT k FROM ez_meta WHERE k = ?', ['schema']);
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
export const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
