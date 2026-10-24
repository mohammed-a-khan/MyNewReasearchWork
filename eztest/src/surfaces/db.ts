/**
 * Database surface. Values are always bound as parameters, never spliced into SQL.
 *   sqlite   -> node:sqlite (built in); placeholders `?` or `:name`
 *   postgres -> `pg` (optional dependency, loaded on demand); placeholders `$1..$n`
 *   mssql    -> `mssql` (optional dependency, loaded on demand); placeholders `@p1..@pn` or `@name`
 *   oracle   -> `oracledb` Thin mode (optional dependency, loaded on demand); placeholders `:1..:n` or `:name`
 *               (see db-oracle.ts)
 *
 * Rows from postgres, mssql and oracle are case-insensitive for lookups (db-rows.ts).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** Why SQLite is not available in this Node.js, for the error that names it. */
export const SQLITE_NODE_REQUIREMENT = 'SQLite (node:sqlite) needs Node.js 22.13+ or 23.4+ (22.5 to 22.12: start Node with --experimental-sqlite)';

/**
 * node:sqlite, loaded only when SQLite is actually used (it prints an experimental warning on load). On a Node.js
 * without it (20.x, or 22.5-22.12 without the flag) this throws a clear error; everything else in EZTest still works.
 */
export function loadSqlite(): typeof import('node:sqlite') {
  const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  let mod: typeof import('node:sqlite') | undefined;
  try {
    mod = typeof get === 'function' ? (get.call(process, 'node:sqlite') as typeof import('node:sqlite') | undefined) : undefined;
  } catch {
    mod = undefined;
  }
  if (!mod?.DatabaseSync) throw new Error(`${SQLITE_NODE_REQUIREMENT}; this is Node.js ${process.versions.node}. Upgrade Node.js, or use another database driver (postgres, mssql, oracle).`);
  return mod;
}

/** Whether this Node.js has node:sqlite, from its version and flags (without loading it, which prints a warning). */
export function sqliteSupported(version = process.versions.node, flags: string[] = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)]): boolean {
  const [major, minor] = version.split('.').map(Number);
  if (major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13)) return true;
  return ((major === 22 && minor >= 5) || major === 23) && flags.includes('--experimental-sqlite');
}

function openSqlite(file: string): DatabaseSync {
  const mod = loadSqlite();
  const db = new mod.DatabaseSync(file);
  // Without a busy timeout, a write while the application under test holds the file's lock fails at
  // once with "database is locked": a race that shows up as flakiness in parallel runs.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

/** How long a statement waits for another connection's (or process's) write lock. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EzTestError, NotSupportedError } from '../core/index.js';
import { namedToPositional, type SqlDialect } from './db-sql.js';
import { caseInsensitiveRow } from './db-rows.js';
import type { OracleOptions } from './db-oracle.js';
import { mergeMssqlSettings, mssqlDriverConfig, type EntraTokenDeps, type MssqlSettings } from './db-mssql.js';

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | Date;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;
export type Row = Record<string, unknown>;

export interface ExecResult {
  rowsAffected: number;
  lastInsertId?: number | string;
}

export interface DbClient {
  readonly name: string;
  readonly dialect: SqlDialect;
  query<T extends Row = Row>(sql: string, params?: SqlParams): Promise<T[]>;
  execute(sql: string, params?: SqlParams): Promise<ExecResult>;
  /** Commit when fn resolves, roll back when it throws. */
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DbError extends EzTestError {
  constructor(message: string, code = 'DB_ERROR', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'DbError';
  }
}

/** Simple async mutex so a transaction on a single connection is never interleaved with other work. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    return release;
  }
}

function sqliteValue(v: SqlValue): SQLInputValue {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v as SQLInputValue;
}

function checkSql(sql: string): void {
  if (typeof sql !== 'string' || !sql.trim()) throw new DbError('SQL is empty', 'DB_EMPTY_SQL');
}

// ----------------------------------------------------------------- sqlite

export interface SqliteOptions {
  /** File path or ':memory:'. */
  file?: string;
  /** Use an existing connection (not closed by close() unless `own` is true). */
  database?: DatabaseSync;
  own?: boolean;
  name?: string;
}

export class SqliteDbClient implements DbClient {
  readonly dialect = 'sqlite' as const;
  readonly name: string;
  private readonly db: DatabaseSync;
  private readonly owns: boolean;
  private readonly mutex = new Mutex();
  private txDepth = 0;
  private closed = false;

  constructor(o: SqliteOptions) {
    if (o.database) {
      this.db = o.database;
      this.owns = o.own ?? false;
    } else if (o.file) {
      this.db = openSqlite(o.file);
      this.owns = true;
    } else throw new DbError('SqliteDbClient needs `file` or `database`', 'DB_CONFIG');
    this.name = o.name ?? 'sqlite';
  }

  private run<T>(fn: () => T): T {
    if (this.closed) throw new DbError(`Connection ${this.name} is closed`, 'DB_CLOSED');
    try {
      return fn();
    } catch (e) {
      throw new DbError(`[${this.name}] ${(e as Error).message}`, 'DB_QUERY');
    }
  }

  private bind(params?: SqlParams): { positional: SQLInputValue[]; named?: Record<string, SQLInputValue> } {
    if (!params) return { positional: [] };
    if (Array.isArray(params)) return { positional: params.map(sqliteValue) };
    const named: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) named[k] = sqliteValue(v);
    return { positional: [], named };
  }

  private queryNow<T extends Row>(sql: string, params?: SqlParams): T[] {
    checkSql(sql);
    return this.run(() => {
      const st = this.db.prepare(sql);
      const b = this.bind(params);
      return (b.named ? st.all(b.named, ...b.positional) : st.all(...b.positional)) as T[];
    });
  }

  private executeNow(sql: string, params?: SqlParams): ExecResult {
    checkSql(sql);
    return this.run(() => {
      const st = this.db.prepare(sql);
      const b = this.bind(params);
      const r = b.named ? st.run(b.named, ...b.positional) : st.run(...b.positional);
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    });
  }

  async query<T extends Row = Row>(sql: string, params?: SqlParams): Promise<T[]> {
    const release = await this.mutex.lock();
    try {
      return this.queryNow<T>(sql, params);
    } finally {
      release();
    }
  }

  async execute(sql: string, params?: SqlParams): Promise<ExecResult> {
    const release = await this.mutex.lock();
    try {
      return this.executeNow(sql, params);
    } finally {
      release();
    }
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const release = await this.mutex.lock();
    try {
      return await this.txInner(fn);
    } finally {
      release();
    }
  }

  private async txInner<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const depth = this.txDepth++;
    const sp = `ez_sp_${depth}`;
    this.run(() => this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`));
    const self = this;
    const tx: DbClient = {
      name: this.name,
      dialect: 'sqlite',
      query: async <R extends Row = Row>(sql: string, p?: SqlParams) => self.queryNow<R>(sql, p),
      execute: async (sql: string, p?: SqlParams) => self.executeNow(sql, p),
      transaction: <R>(inner: (t: DbClient) => Promise<R>) => self.txInner(inner),
      close: async () => {
        throw new DbError('Cannot close the connection inside a transaction', 'DB_TX_CLOSE');
      },
    };
    try {
      const out = await fn(tx);
      this.run(() => this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`));
      return out;
    } catch (e) {
      try {
        this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch (rb) {
        throw new DbError(`Rollback failed after error "${(e as Error).message}": ${(rb as Error).message}`, 'DB_ROLLBACK');
      }
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.owns) this.db.close();
  }
}

// ----------------------------------------------------------------- optional drivers

/**
 * Environment variables that point a driver at an installation outside this project
 * (a shared drivers folder, a CI image): the package directory, e.g.
 * EZTEST_PG_DRIVER=/opt/drivers/node_modules/pg.
 */
export const DRIVER_PATH_ENV: Record<string, string> = {
  pg: 'EZTEST_PG_DRIVER', mssql: 'EZTEST_MSSQL_DRIVER', oracledb: 'EZTEST_ORACLEDB_DRIVER', kafkajs: 'EZTEST_KAFKAJS_DRIVER', protobufjs: 'EZTEST_PROTOBUFJS_DRIVER',
};

/** The import specifier of a driver: its package name, or the entry file in the directory its EZTEST_*_DRIVER variable names. */
export function driverSpecifier(pkg: string, env: Record<string, string | undefined> = process.env): string {
  // "mssql/msnodesqlv8": the package "mssql", entry "msnodesqlv8" inside it.
  const [base, ...sub] = pkg.startsWith('@') ? [pkg.split('/').slice(0, 2).join('/'), ...pkg.split('/').slice(2)] : pkg.split('/');
  const dir = DRIVER_PATH_ENV[base] ? env[DRIVER_PATH_ENV[base]] : undefined;
  if (!dir) return pkg;
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve(resolvePath(dir, ...sub))).href;
  } catch (e) {
    throw new DbError(`${DRIVER_PATH_ENV[base]}=${dir} does not hold the "${pkg}" package: ${(e as Error).message.split('\n')[0]}`, 'DB_DRIVER_LOAD', { driver: pkg });
  }
}

/** Load an optional driver package, with an install hint when it is missing. */
export async function loadDriver(pkg: string, what: string): Promise<any> {
  const spec: string = driverSpecifier(pkg); // a variable keeps TypeScript from requiring the optional package's types
  try {
    const mod = await import(spec);
    return mod.default ?? mod;
  } catch (e) {
    const code = (e as { code?: string }).code;
    const msg = (e as Error).message ?? '';
    // Node reports ERR_MODULE_NOT_FOUND; bundlers/test runners (vite) report "Failed to load url"/"Cannot find package".
    const missing =
      code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /cannot find (package|module)|could not resolve|failed to (load url|resolve import)/i.test(msg);
    if (missing && msg.includes(pkg)) {
      throw new DbError(`${what} support needs the "${pkg}" package, which is not installed. Run: npm install ${pkg}`, 'DB_DRIVER_MISSING', {
        driver: pkg,
      });
    }
    throw new DbError(`Loading the "${pkg}" driver failed: ${(e as Error).message}`, 'DB_DRIVER_LOAD');
  }
}

export interface PostgresOptions {
  name?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
  max?: number;
  /** The loaded `pg` module (tests and bundlers); normally loaded on demand. */
  driverModule?: unknown;
}

export class PostgresDbClient implements DbClient {
  readonly dialect = 'postgres' as const;
  readonly name: string;
  private pool: any;

  private constructor(name: string, pool: any) {
    this.name = name;
    this.pool = pool;
  }

  static async connect(o: PostgresOptions): Promise<PostgresDbClient> {
    const pg = (o.driverModule as any) ?? (await loadDriver('pg', 'PostgreSQL'));
    const ssl = o.ssl === true ? { rejectUnauthorized: true } : o.ssl === false || o.ssl === undefined ? undefined : { rejectUnauthorized: true, ...o.ssl };
    const pool = new pg.Pool({
      connectionString: o.connectionString,
      host: o.host,
      port: o.port,
      database: o.database,
      user: o.user,
      password: o.password,
      ssl,
      max: o.max ?? 4,
    });
    return new PostgresDbClient(o.name ?? 'postgres', pool);
  }

  /**
   * The text and values pg sends: an array binds $1..$n as is; an object binds `:name` markers,
   * rewritten to $1..$n (string literals, quoted identifiers, comments and `::` casts are left alone).
   */
  static bind(sql: string, p?: SqlParams): { text: string; values: unknown[] } {
    if (!p) return { text: sql, values: [] };
    if (Array.isArray(p)) return { text: sql, values: p };
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) values[k.replace(/^[:@$]/, '')] = v;
    try {
      const r = namedToPositional(sql, values, 'postgres');
      return { text: r.sql, values: r.params };
    } catch (e) {
      throw new DbError(`PostgreSQL named binds: ${(e as Error).message} (binds given: ${Object.keys(values).join(', ') || 'none'})`, 'DB_BIND');
    }
  }

  private async on(target: any, sql: string, p?: SqlParams) {
    checkSql(sql);
    const { text, values } = PostgresDbClient.bind(sql, p);
    try {
      return await target.query(text, values);
    } catch (e) {
      const pe = e as { message?: string; code?: string; detail?: string; hint?: string };
      const extra = [pe.code ? `SQLSTATE ${pe.code}` : '', pe.detail ? `detail: ${pe.detail}` : '', pe.hint ? `hint: ${pe.hint}` : ''].filter(Boolean).join('; ');
      throw new DbError(`[${this.name}] ${pe.message ?? String(e)}${extra ? ` (${extra})` : ''}`, 'DB_QUERY', pe.code ? { sqlState: pe.code } : undefined);
    }
  }

  async query<T extends Row = Row>(sql: string, p?: SqlParams): Promise<T[]> {
    return ((await this.on(this.pool, sql, p)).rows as T[]).map((r) => caseInsensitiveRow(r));
  }
  async execute(sql: string, p?: SqlParams): Promise<ExecResult> {
    const r = await this.on(this.pool, sql, p);
    return { rowsAffected: r.rowCount ?? 0 };
  }
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
    const tx: DbClient = {
      name: this.name,
      dialect: 'postgres',
      query: async <R extends Row = Row>(sql: string, p?: SqlParams) => ((await this.on(conn, sql, p)).rows as R[]).map((r) => caseInsensitiveRow(r)),
      execute: async (sql: string, p?: SqlParams) => ({ rowsAffected: (await this.on(conn, sql, p)).rowCount ?? 0 }),
      transaction: () => {
        throw new NotSupportedError('nested PostgreSQL transactions (use SAVEPOINT explicitly)');
      },
      close: async () => {
        throw new DbError('Cannot close the connection inside a transaction', 'DB_TX_CLOSE');
      },
    };
    try {
      await conn.query('BEGIN');
      const out = await fn(tx);
      await conn.query('COMMIT');
      return out;
    } catch (e) {
      await conn.query('ROLLBACK');
      throw e;
    } finally {
      conn.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface MssqlOptions extends MssqlSettings {
  name?: string;
  /** The loaded `mssql` module (tests and bundlers); normally loaded on demand. */
  driverModule?: unknown;
  /** HTTP client and authority for `tokenSource: eztest` Entra tokens (tests). */
  entra?: EntraTokenDeps;
}

export class MssqlDbClient implements DbClient {
  readonly dialect = 'mssql' as const;
  readonly name: string;

  private constructor(
    name: string,
    private readonly sql: any,
    private readonly pool: any,
  ) {
    this.name = name;
  }

  static async connect(o: MssqlOptions): Promise<MssqlDbClient> {
    const { name, driverModule, entra, ...settings } = o;
    const merged = mergeMssqlSettings(settings);
    const { module, config } = mssqlDriverConfig(merged, entra);
    const mssql = (driverModule as any) ?? (await loadDriver(module, module === 'mssql' ? 'SQL Server' : 'SQL Server integrated (Kerberos) authentication'));
    const pool = new mssql.ConnectionPool(config);
    try {
      await pool.connect();
    } catch (e) {
      const err = e as Error & { code?: string; originalError?: { message?: string; errors?: Array<{ message?: string }> } };
      const inner = [err.originalError?.message, ...(err.originalError?.errors ?? []).map((x) => x.message)].filter((m): m is string => !!m && m !== err.message);
      throw new DbError(`[${name ?? 'mssql'}] cannot connect to SQL Server ${String(config.server)}: ${[err.message, ...inner].join('; ')}`, 'DB_CONNECT', { auth: (merged.authentication ?? { type: 'sql' }).type,...(err.code ? { driverCode: err.code } : {}) });
    }
    return new MssqlDbClient(name ?? 'mssql', mssql, pool);
  }

  private async on(target: any, sqlText: string, p?: SqlParams) {
    checkSql(sqlText);
    const req = new this.sql.Request(target);
    if (Array.isArray(p)) p.forEach((v, i) => req.input(`p${i + 1}`, v));
    else if (p) for (const [k, v] of Object.entries(p)) req.input(k.replace(/^@/, ''), v);
    try {
      return await req.query(sqlText);
    } catch (e) {
      // SQL Server reports the specific cause (e.g. "Invalid column name") in precedingErrors.
      const pre = ((e as { precedingErrors?: Array<{ message?: string }> }).precedingErrors ?? []).map((x) => x.message).filter(Boolean);
      throw new DbError(`[${this.name}] ${[...pre, (e as Error).message].join('; ')}`, 'DB_QUERY');
    }
  }

  async query<T extends Row = Row>(sqlText: string, p?: SqlParams): Promise<T[]> {
    return (((await this.on(this.pool, sqlText, p)).recordset ?? []) as T[]).map((r) => caseInsensitiveRow(r));
  }
  async execute(sqlText: string, p?: SqlParams): Promise<ExecResult> {
    const r = await this.on(this.pool, sqlText, p);
    return { rowsAffected: (r.rowsAffected as number[]).reduce((a, b) => a + b, 0) };
  }
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const t = new this.sql.Transaction(this.pool);
    await t.begin();
    const tx: DbClient = {
      name: this.name,
      dialect: 'mssql',
      query: async <R extends Row = Row>(s: string, p?: SqlParams) => (((await this.on(t, s, p)).recordset ?? []) as R[]).map((r) => caseInsensitiveRow(r)),
      execute: async (s: string, p?: SqlParams) => ({ rowsAffected: ((await this.on(t, s, p)).rowsAffected as number[]).reduce((a, b) => a + b, 0) }),
      transaction: () => {
        throw new NotSupportedError('nested SQL Server transactions');
      },
      close: async () => {
        throw new DbError('Cannot close the connection inside a transaction', 'DB_TX_CLOSE');
      },
    };
    try {
      const out = await fn(tx);
      await t.commit();
      return out;
    } catch (e) {
      await t.rollback();
      throw e;
    }
  }
  async close(): Promise<void> {
    await this.pool.close();
  }
}

// ----------------------------------------------------------------- registry

export type DbConnectionSpec =
  | { driver: 'sqlite'; file: string }
  | ({ driver: 'postgres' } & Omit<PostgresOptions, 'name'>)
  | ({ driver: 'mssql' } & Omit<MssqlOptions, 'name'>)
  | ({ driver: 'oracle' } & Omit<OracleOptions, 'name'>);

export async function connectDb(name: string, spec: DbConnectionSpec): Promise<DbClient> {
  switch (spec.driver) {
    case 'sqlite':
      return new SqliteDbClient({ file: spec.file, name });
    case 'postgres':
      return PostgresDbClient.connect({ ...spec, name });
    case 'mssql':
      return MssqlDbClient.connect({ ...spec, name });
    case 'oracle': {
      const { OracleDbClient } = await import('./db-oracle.js');
      return OracleDbClient.connect({ ...spec, name });
    }
    default:
      throw new NotSupportedError(`database driver "${(spec as { driver: string }).driver}"`);
  }
}

/** Named connections from config (`db.connections`), opened lazily and closed together. */
export interface DbRegistryOptions {
  /** Resolves secret references (secret://store/key) in password-like fields before connecting. */
  resolveSecret?: (ref: string) => Promise<string>;
}

const SECRET_FIELDS = ['password', 'walletPassword', 'connectionString', 'user'] as const;
/** Secret-bearing fields of a SQL Server `authentication` block. */
const AUTH_SECRET_FIELDS = ['clientSecret', 'token', 'clientId', 'tenantId'] as const;
/** secret://store/key inside a connection string (ADO.NET "Password=secret://vault/PW;" or a URL query value). */
const EMBEDDED_SECRET = /secret:\/\/[A-Za-z0-9_.-]+\/[^;&'"{}\s]+/g;

/** A connection spec with secret:// references in password-like fields (and inside a connection string) resolved. */
export async function resolveSpecSecrets(spec: DbConnectionSpec, resolveSecret?: (ref: string) => Promise<string>): Promise<DbConnectionSpec> {
  const out: Record<string, unknown> = { ...spec };
  const resolve = async (ref: string, field: string): Promise<string> => {
    if (!resolveSecret) throw new DbError(`Connection field "${field}" is a secret reference but no secret store is configured`, 'DB_CONFIG');
    return resolveSecret(ref);
  };
  for (const f of SECRET_FIELDS) {
    const v = out[f];
    if (typeof v === 'string' && v.startsWith('secret://') && !(f === 'connectionString' && /[;=?]/.test(v))) out[f] = await resolve(v, f);
  }
  const cs = out.connectionString;
  if (typeof cs === 'string' && EMBEDDED_SECRET.test(cs)) {
    EMBEDDED_SECRET.lastIndex = 0;
    const url = /^(?:mssql|sqlserver|postgres|postgresql):\/\//i.test(cs);
    let text = '';
    let at = 0;
    for (const m of cs.matchAll(EMBEDDED_SECRET)) {
      const value = await resolve(m[0], 'connectionString');
      // Keep the string parseable: URL values are percent-encoded, ADO.NET values with ; or quotes are braced.
      text += cs.slice(at, m.index) + (url ? encodeURIComponent(value) : /[;'"{}]|^\s|\s$/.test(value) ? `{${value.replace(/}/g, '}}')}}` : value);
      at = (m.index ?? 0) + m[0].length;
    }
    out.connectionString = text + cs.slice(at);
  }
  const auth = out.authentication;
  if (auth && typeof auth === 'object') {
    const a: Record<string, unknown> = { ...(auth as Record<string, unknown>) };
    for (const f of AUTH_SECRET_FIELDS) {
      const v = a[f];
      if (typeof v === 'string' && v.startsWith('secret://')) a[f] = await resolve(v, `authentication.${f}`);
    }
    out.authentication = a;
  }
  return out as DbConnectionSpec;
}

export class DbRegistry {
  private readonly clients = new Map<string, Promise<DbClient>>();

  constructor(
    private readonly specs: Record<string, DbConnectionSpec> = {},
    private readonly opts: DbRegistryOptions = {},
  ) {}

  /** The configured spec of a connection (secrets unresolved). */
  spec(name: string): DbConnectionSpec | undefined {
    return this.specs[name];
  }

  register(name: string, client: DbClient): void {
    this.clients.set(name, Promise.resolve(client));
  }

  names(): string[] {
    return [...new Set([...Object.keys(this.specs), ...this.clients.keys()])];
  }

  async get(name: string): Promise<DbClient> {
    const hit = this.clients.get(name);
    if (hit) return hit;
    const spec = this.specs[name];
    if (!spec) throw new DbError(`Unknown database connection "${name}". Known: ${this.names().join(', ') || '(none)'}`, 'DB_UNKNOWN_CONNECTION');
    const p = resolveSpecSecrets(spec, this.opts.resolveSecret).then((s) => connectDb(name, s));
    this.clients.set(name, p);
    p.catch(() => this.clients.delete(name));
    return p;
  }

  async closeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    const errors: string[] = [];
    for (const p of all) {
      try {
        await (await p).close();
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (errors.length) throw new DbError(`Closing connections failed: ${errors.join('; ')}`, 'DB_CLOSE');
  }
}

// ----------------------------------------------------------------- health

export interface DbHealth {
  name: string;
  dialect: SqlDialect;
  ok: boolean;
  latencyMs: number;
  version?: string;
  detail?: string;
  error?: string;
}

const VERSION_SQL: Record<SqlDialect, string> = {
  sqlite: 'SELECT sqlite_version() AS version',
  postgres: 'SELECT version() AS version',
  mssql: 'SELECT @@VERSION AS version',
  oracle: "SELECT banner_full AS version FROM v$version WHERE ROWNUM = 1",
};

/** Connect (if needed), run a trivial query and report the server version and latency. Never throws. */
export async function checkDbHealth(name: string, open: () => Promise<DbClient>, dialect: SqlDialect = 'sqlite'): Promise<DbHealth> {
  const t = Date.now();
  let client: DbClient | undefined;
  try {
    client = await open();
    const c = client as DbClient & { ping?: () => Promise<{ version: string; thin?: boolean }>; poolStatus?: () => { open: number; max: number } };
    if (c.ping) {
      const p = await c.ping();
      const pool = c.poolStatus?.();
      return { name, dialect: client.dialect, ok: true, latencyMs: Date.now() - t, version: p.version, detail: `${p.thin === false ? 'thick' : 'thin'} mode${pool ? `, pool ${pool.open}/${pool.max}` : ''}` };
    }
    let version: string | undefined;
    try {
      const r = await client.query(VERSION_SQL[client.dialect]);
      version = String(Object.values(r[0] ?? {})[0] ?? '').split('\n')[0];
    } catch {
      await client.query(client.dialect === 'oracle' ? 'SELECT 1 FROM dual' : 'SELECT 1');
    }
    return { name, dialect: client.dialect, ok: true, latencyMs: Date.now() - t, version };
  } catch (e) {
    return { name, dialect: client?.dialect ?? dialect, ok: false, latencyMs: Date.now() - t, error: (e as Error).message, ...(e instanceof DbError && e.code === 'DB_DRIVER_MISSING' ? { detail: 'driver missing' } : {}) };
  }
}
