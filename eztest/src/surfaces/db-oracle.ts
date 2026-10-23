/**
 * Oracle Database client on `oracledb` in Thin mode (pure JavaScript: no
 * Instant Client, no native code). `oracledb` is an optional peer dependency,
 * loaded on first use.
 *
 * - Binds: positional `:1..:n` (arrays) or named `:name` (objects). Values are
 *   always bound, never spliced into SQL.
 * - Rows: objects keyed by the column names Oracle returns (usually UPPER
 *   CASE), wrapped so lookups ignore case (row.account_id === row.ACCOUNT_ID).
 * - Types: NUMBER -> number (or a string when a double would lose precision),
 *   DATE/TIMESTAMP -> Date, CLOB/NCLOB -> string, BLOB -> Buffer, NULL -> null.
 *   `fetchAsString` returns chosen types as text instead.
 * - PL/SQL: `BEGIN ... END;` blocks with OUT binds (`plsql`) and stored
 *   procedure calls (`callProcedure`).
 * - `readOnly(fn)`: runs fn inside SET TRANSACTION READ ONLY and always rolls back.
 */
import { NotSupportedError } from '../core/index.js';
import { DbError, loadDriver, type DbClient, type ExecResult, type Row, type SqlParams, type SqlValue } from './db.js';
import { caseInsensitiveRow } from './db-rows.js';
import { isPlsql, oracleStatement } from './db-sql.js';

export type OracleFetchAsString = 'NUMBER' | 'DATE' | 'TIMESTAMP' | 'CLOB' | 'NCLOB' | 'JSON' | 'RAW';

export interface OracleOptions {
  name?: string;
  host?: string;
  port?: number;
  serviceName?: string;
  sid?: string;
  /** Easy Connect string or a full descriptor; wins over host/port/serviceName/sid. */
  connectString?: string;
  user?: string;
  password?: string;
  pool?: { min?: number; max?: number; increment?: number; timeoutSeconds?: number };
  /** Directory with the wallet (ewallet.pem) for mTLS / Autonomous Database. */
  walletLocation?: string;
  walletPassword?: string;
  /** Directory with tnsnames.ora (for TNS aliases in connectString). */
  configDir?: string;
  /** Return these types as strings instead of numbers/Dates/objects. */
  fetchAsString?: OracleFetchAsString[];
  /** Per round-trip timeout. */
  callTimeoutMs?: number;
  /** The loaded `oracledb` module (tests and bundlers); normally loaded on demand. */
  driverModule?: unknown;
}

/** An OUT (or IN OUT) bind of a PL/SQL block. */
export interface OracleOutBind {
  out: 'string' | 'number' | 'date' | 'clob' | 'cursor' | 'boolean';
  /** IN OUT: the value passed in. */
  value?: SqlValue;
  /** Max length of a string OUT bind (default 32767). */
  maxSize?: number;
}

export type OracleBinds = Array<SqlValue | OracleOutBind> | Record<string, SqlValue | OracleOutBind>;

/** Build the connect string from host/port/serviceName or SID. */
export function oracleConnectString(o: Pick<OracleOptions, 'connectString' | 'host' | 'port' | 'serviceName' | 'sid'>): string {
  if (o.connectString) return o.connectString;
  if (!o.host) throw new DbError('Oracle connection needs connectString, or host with serviceName or sid', 'DB_CONFIG');
  const port = o.port ?? 1521;
  if (o.serviceName) return `${o.host}:${port}/${o.serviceName}`;
  if (o.sid) return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${o.host})(PORT=${port}))(CONNECT_DATA=(SID=${o.sid})))`;
  throw new DbError('Oracle connection needs serviceName or sid (or a connectString)', 'DB_CONFIG');
}

/** NUMBER text -> number when a double holds it exactly enough, otherwise the exact text. */
export function oracleNumber(s: string | null): number | string | null {
  if (s === null || s === undefined) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (/^-?\d+$/.test(s)) return Number.isSafeInteger(n) ? n : s;
  const digits = s.replace(/^[-+]/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length <= 15 ? n : s;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** A DATE/TIMESTAMP (no zone) as ISO-like local text: 2026-03-01T14:05:00 (fraction kept when present). */
function localIso(d: Date): string {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ms = d.getMilliseconds();
  return ms ? `${base}.${pad(ms, 3)}` : base;
}

function errText(e: unknown): string {
  return (e as Error)?.message?.split('\n')[0] ?? String(e);
}

export class OracleDbClient implements DbClient {
  readonly dialect = 'oracle' as const;
  readonly name: string;

  private constructor(
    name: string,
    private readonly ora: any,
    private readonly pool: any,
    private readonly o: OracleOptions,
  ) {
    this.name = name;
  }

  static async connect(o: OracleOptions): Promise<OracleDbClient> {
    const ora = o.driverModule ?? (await loadDriver('oracledb', 'Oracle'));
    // Thin mode is the default as long as initOracleClient() is never called; EZTest never calls it.
    let pool: any;
    try {
      pool = await ora.createPool({
        user: o.user,
        password: o.password,
        connectString: oracleConnectString(o),
        poolMin: o.pool?.min ?? 0,
        poolMax: o.pool?.max ?? 4,
        poolIncrement: o.pool?.increment ?? 1,
        poolTimeout: o.pool?.timeoutSeconds ?? 60,
        ...(o.walletLocation ? { walletLocation: o.walletLocation, configDir: o.configDir ?? o.walletLocation } : o.configDir ? { configDir: o.configDir } : {}),
        ...(o.walletPassword ? { walletPassword: o.walletPassword } : {}),
      });
    } catch (e) {
      if (e instanceof DbError) throw e;
      throw new DbError(`[${o.name ?? 'oracle'}] cannot create the Oracle pool: ${errText(e)}`, 'DB_CONNECT');
    }
    return new OracleDbClient(o.name ?? 'oracle', ora, pool, o);
  }

  /** Whether the driver runs in Thin mode (pure JavaScript). */
  get thin(): boolean {
    return this.ora.thin !== false;
  }

  /** Pool statistics (open / in use). */
  poolStatus(): { open: number; inUse: number; min: number; max: number } {
    return { open: this.pool.connectionsOpen, inUse: this.pool.connectionsInUse, min: this.pool.poolMin, max: this.pool.poolMax };
  }

  private fetchTypeHandler() {
    const ora = this.ora;
    const asString = new Set(this.o.fetchAsString ?? []);
    return (meta: { dbType: unknown }) => {
      const t = meta.dbType;
      if (t === ora.DB_TYPE_NUMBER || t === ora.DB_TYPE_BINARY_INTEGER) {
        return { type: ora.STRING, converter: asString.has('NUMBER') ? undefined : oracleNumber };
      }
      if (t === ora.DB_TYPE_CLOB || t === ora.DB_TYPE_NCLOB) return { type: ora.STRING };
      if (t === ora.DB_TYPE_BLOB) return { type: ora.BUFFER };
      if (t === ora.DB_TYPE_DATE && asString.has('DATE')) return { converter: (d: Date | null) => (d ? localIso(d) : d) };
      if ((t === ora.DB_TYPE_TIMESTAMP || t === ora.DB_TYPE_TIMESTAMP_LTZ) && asString.has('TIMESTAMP')) return { converter: (d: Date | null) => (d ? localIso(d) : d) };
      if (t === ora.DB_TYPE_TIMESTAMP_TZ && asString.has('TIMESTAMP')) return { converter: (d: Date | null) => (d ? d.toISOString() : d) };
      if (t === ora.DB_TYPE_JSON && asString.has('JSON')) return { converter: (v: unknown) => (v === null ? v : JSON.stringify(v)) };
      if (t === ora.DB_TYPE_RAW && asString.has('RAW')) return { converter: (b: Buffer | null) => (b ? b.toString('hex').toUpperCase() : b) };
      return undefined;
    };
  }

  private bindValue(v: SqlValue | OracleOutBind): unknown {
    const ora = this.ora;
    if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array) && 'out' in v) {
      const o = v as OracleOutBind;
      const type = { string: ora.STRING, number: ora.NUMBER, date: ora.DATE, clob: ora.CLOB, cursor: ora.CURSOR, boolean: ora.DB_TYPE_BOOLEAN }[o.out];
      if (!type) throw new DbError(`Unknown OUT bind type "${o.out}"`, 'DB_BIND');
      return {
        dir: o.value === undefined ? ora.BIND_OUT : ora.BIND_INOUT,
        type,
        ...(o.value !== undefined ? { val: this.bindValue(o.value) } : {}),
        ...(o.out === 'string' ? { maxSize: o.maxSize ?? 32767 } : {}),
      };
    }
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v);
    return v;
  }

  private binds(p?: OracleBinds | SqlParams): unknown {
    if (!p) return [];
    if (Array.isArray(p)) return p.map((v) => this.bindValue(v));
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [k.replace(/^:/, ''), this.bindValue(v)]));
  }

  private async run(conn: any, sql: string, p: OracleBinds | SqlParams | undefined, autoCommit: boolean): Promise<any> {
    if (typeof sql !== 'string' || !sql.trim()) throw new DbError('SQL is empty', 'DB_EMPTY_SQL');
    if (this.o.callTimeoutMs) conn.callTimeout = this.o.callTimeoutMs;
    try {
      return await conn.execute(oracleStatement(sql), this.binds(p), {
        outFormat: this.ora.OUT_FORMAT_OBJECT,
        autoCommit,
        fetchTypeHandler: this.fetchTypeHandler(),
      });
    } catch (e) {
      throw new DbError(`[${this.name}] ${errText(e)}`, 'DB_QUERY', { oracleCode: (e as { errorNum?: number }).errorNum });
    }
  }

  private async withConn<T>(fn: (conn: any) => Promise<T>): Promise<T> {
    let conn: any;
    try {
      conn = await this.pool.getConnection();
    } catch (e) {
      throw new DbError(`[${this.name}] cannot connect: ${errText(e)}`, 'DB_CONNECT');
    }
    try {
      return await fn(conn);
    } finally {
      await conn.close().catch(() => undefined);
    }
  }

  private static rowsOf<T extends Row>(r: any): T[] {
    return ((r.rows ?? []) as T[]).map((x) => caseInsensitiveRow(x));
  }

  private txClient(conn: any): DbClient {
    return {
      name: this.name,
      dialect: 'oracle',
      query: async <R extends Row = Row>(sql: string, p?: SqlParams) => OracleDbClient.rowsOf<R>(await this.run(conn, sql, p, false)),
      execute: async (sql: string, p?: SqlParams) => {
        const r = await this.run(conn, sql, p, false);
        return { rowsAffected: r.rowsAffected ?? 0, ...(r.lastRowid ? { lastInsertId: r.lastRowid } : {}) };
      },
      transaction: () => {
        throw new NotSupportedError('nested Oracle transactions (use SAVEPOINT explicitly)');
      },
      close: async () => {
        throw new DbError('Cannot close the connection inside a transaction', 'DB_TX_CLOSE');
      },
    };
  }

  async query<T extends Row = Row>(sql: string, p?: SqlParams): Promise<T[]> {
    return this.withConn(async (c) => OracleDbClient.rowsOf<T>(await this.run(c, sql, p, true)));
  }

  async execute(sql: string, p?: SqlParams): Promise<ExecResult> {
    return this.withConn(async (c) => {
      const r = await this.run(c, sql, p, true);
      return { rowsAffected: r.rowsAffected ?? 0, ...(r.lastRowid ? { lastInsertId: r.lastRowid } : {}) };
    });
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.withConn(async (conn) => {
      try {
        const out = await fn(this.txClient(conn));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => undefined);
        throw e;
      }
    });
  }

  /**
   * Run fn in a READ ONLY transaction that is always rolled back. DML inside
   * fails with ORA-01456. A table created moments before the snapshot can
   * raise ORA-01466 ("table definition has changed"); that is retried briefly.
   */
  async readOnly<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.withConn(async (conn) => {
          await conn.rollback().catch(() => undefined);
          await this.run(conn, 'SET TRANSACTION READ ONLY', [], false);
          try {
            return await fn(this.txClient(conn));
          } finally {
            await conn.rollback().catch(() => undefined);
          }
        });
      } catch (e) {
        if (attempt >= 5 || !(e instanceof DbError) || !/ORA-01466/.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /**
   * Run a PL/SQL block (or any statement) with IN, OUT and IN OUT binds.
   * OUT values come back by name (or position "1".."n" for arrays); a REF
   * CURSOR OUT bind comes back as rows.
   */
  async plsql(sql: string, binds: OracleBinds = [], o: { autoCommit?: boolean } = {}): Promise<{ outBinds: Record<string, unknown>; rows: Row[]; rowsAffected: number }> {
    return this.withConn(async (conn) => {
      const r = await this.run(conn, sql, binds, o.autoCommit ?? true);
      const raw = r.outBinds ?? {};
      const entries: Array<[string, unknown]> = Array.isArray(raw) ? raw.map((v: unknown, i: number) => [String(i + 1), v]) : Object.entries(raw);
      const outBinds: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        if (v && typeof v === 'object' && typeof (v as { getRows?: unknown }).getRows === 'function') {
          const rs = v as { getRows(n: number): Promise<Row[]>; close(): Promise<void> };
          try {
            outBinds[k] = (await rs.getRows(100_000)).map((x) => caseInsensitiveRow(x));
          } finally {
            await rs.close().catch(() => undefined);
          }
        } else outBinds[k] = v;
      }
      return { outBinds: caseInsensitiveRow(outBinds), rows: OracleDbClient.rowsOf(r), rowsAffected: r.rowsAffected ?? 0 };
    });
  }

  /** Call a stored procedure: IN params first, then the named OUT params. */
  async callProcedure(name: string, params: SqlValue[] = [], outs: Array<{ name: string; type?: OracleOutBind['out'] }> = []): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*){0,2}$/.test(name)) throw new DbError(`Invalid procedure name "${name}"`, 'BAD_SQL');
    const binds: Record<string, SqlValue | OracleOutBind> = {};
    const marks: string[] = [];
    params.forEach((v, i) => {
      binds[`p${i + 1}`] = v;
      marks.push(`:p${i + 1}`);
    });
    for (const o of outs) {
      if (!/^[A-Za-z_]\w*$/.test(o.name)) throw new DbError(`Invalid OUT parameter name "${o.name}"`, 'BAD_SQL');
      binds[`o_${o.name}`] = { out: o.type ?? 'string' };
      marks.push(`:o_${o.name}`);
    }
    const r = await this.plsql(`BEGIN ${name}(${marks.join(', ')}); END;`, binds);
    return caseInsensitiveRow(Object.fromEntries(outs.map((o) => [o.name, r.outBinds[`o_${o.name}`]])));
  }

  /**
   * Parse a statement without executing it (thin-mode statement info): checks
   * syntax, tables and columns of SQL, and returns its bind names and columns.
   * DDL is neither parsed nor executed; PL/SQL is only scanned for binds.
   */
  async describe(sql: string): Promise<{ statementType: string; bindNames: string[]; columns: string[]; checked: boolean }> {
    return this.withConn(async (conn) => {
      try {
        const info = await conn.getStatementInfo(oracleStatement(sql));
        const types: Record<number, string> = { 1: 'select', 2: 'update', 3: 'delete', 4: 'insert', 5: 'create', 6: 'drop', 7: 'alter', 8: 'begin', 9: 'declare', 10: 'call', 16: 'merge' };
        const statementType = types[info.statementType] ?? String(info.statementType);
        return {
          statementType,
          bindNames: (info.bindNames ?? []) as string[],
          columns: ((info.metaData ?? []) as Array<{ name: string }>).map((m) => m.name),
          checked: !['create', 'drop', 'alter'].includes(statementType) && !isPlsql(sql),
        };
      } catch (e) {
        throw new DbError(`[${this.name}] ${errText(e)}`, 'DB_PARSE', { oracleCode: (e as { errorNum?: number }).errorNum });
      }
    });
  }

  /** Round-trip check: server version and latency. */
  async ping(): Promise<{ ok: true; version: string; latencyMs: number; thin: boolean }> {
    const t = Date.now();
    return this.withConn(async (conn) => {
      await this.run(conn, 'SELECT 1 FROM dual', [], false);
      return { ok: true, version: String(conn.oracleServerVersionString ?? ''), latencyMs: Date.now() - t, thin: this.thin };
    });
  }

  async close(): Promise<void> {
    await this.pool.close(0);
  }
}
