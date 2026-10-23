/**
 * `eztest queries check`: prepare or describe every catalogue query against
 * the live database WITHOUT executing writes.
 *
 *   oracle   -> thin-mode statement parse (getStatementInfo): syntax, tables,
 *               columns and bind names; nothing is executed. DDL is skipped.
 *   postgres -> EXPLAIN (no ANALYZE) inside a READ ONLY transaction that is rolled back.
 *   mssql    -> sp_describe_first_result_set for reads, inside a rolled-back
 *               transaction; writes are reported as not checked.
 *   sqlite   -> EXPLAIN (compiles the statement; nothing runs).
 */
import type { DbClient } from '../surfaces/db.js';
import type { OracleDbClient } from '../surfaces/db-oracle.js';
import type { SqlDialect } from '../surfaces/db-sql.js';
import { isPlsql } from '../surfaces/db-sql.js';
import type { QueryCatalogue } from './catalogue.js';

export type QueryCheckStatus = 'ok' | 'error' | 'skipped';

export interface QueryCheckResult {
  name: string;
  connection?: string;
  status: QueryCheckStatus;
  /** How it was checked (or why it was skipped). */
  method: string;
  message?: string;
  columns?: string[];
  params: string[];
}

export interface QueryCheckOptions {
  /** Check against this connection (overrides each query's header connection). */
  connection?: string;
  /** Default connection for queries without a header connection. */
  defaultConnection?: string;
  /** Only these queries. */
  names?: string[];
  open(connection: string): Promise<DbClient>;
}

type StatementKind = 'read' | 'write' | 'ddl' | 'plsql';

export function statementKind(sql: string): StatementKind {
  if (isPlsql(sql)) return 'plsql';
  const s = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()+/, '');
  const first = /^([A-Za-z]+)/.exec(s)?.[1]?.toLowerCase() ?? '';
  if (['select', 'with', 'values', 'table', 'show'].includes(first)) return 'read';
  if (['insert', 'update', 'delete', 'merge', 'upsert', 'replace'].includes(first)) return 'write';
  if (['call', 'exec', 'execute'].includes(first)) return 'plsql';
  return 'ddl';
}

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('rollback');
  }
}

async function rolledBack<T>(client: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  try {
    await client.transaction(async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error('unreachable');
}

async function checkOne(client: DbClient, dialect: SqlDialect, sql: string, params: unknown[]): Promise<Pick<QueryCheckResult, 'status' | 'method' | 'message' | 'columns'>> {
  const kind = statementKind(sql);
  if (kind === 'ddl') return { status: 'skipped', method: 'not checked', message: 'DDL is never prepared by queries check (some databases execute DDL on parse)' };
  switch (dialect) {
    case 'oracle': {
      const d = await (client as OracleDbClient).describe(sql);
      if (!d.checked) return { status: 'skipped', method: 'oracle parse', message: `${d.statementType.toUpperCase()} is not parsed by the driver; only its binds were read` };
      return { status: 'ok', method: 'oracle parse (getStatementInfo, nothing executed)', columns: d.columns };
    }
    case 'postgres': {
      await rolledBack(client, async (tx) => {
        await tx.execute('SET TRANSACTION READ ONLY');
        await tx.query(`EXPLAIN ${sql}`, params as never);
      });
      return { status: 'ok', method: 'EXPLAIN in a read-only transaction, rolled back' };
    }
    case 'mssql': {
      if (kind !== 'read') return { status: 'skipped', method: 'not checked', message: 'SQL Server writes and procedure calls are not prepared by queries check' };
      const decl = params.map((_, i) => `@p${i + 1} nvarchar(4000)`).join(', ');
      const rows = await rolledBack(client, (tx) => tx.query('EXEC sp_describe_first_result_set @tsql = @p1, @params = @p2', [sql, decl || null] as never));
      return { status: 'ok', method: 'sp_describe_first_result_set, rolled back', columns: rows.map((r) => String((r as Record<string, unknown>).name ?? '')).filter(Boolean) };
    }
    default: {
      await client.query(`EXPLAIN ${sql}`, params as never);
      return { status: 'ok', method: 'EXPLAIN (compiled, not run)' };
    }
  }
}

/** Check catalogue queries: static problems first, then a live prepare/describe per query. */
export async function checkQueries(cat: QueryCatalogue, o: QueryCheckOptions): Promise<QueryCheckResult[]> {
  const out: QueryCheckResult[] = [];
  const clients = new Map<string, Promise<DbClient>>();
  const names = o.names?.length ? o.names : cat.names();
  for (const name of names) {
    const q = cat.get(name);
    const params = (() => {
      try {
        return cat.paramsOf(name).map((p) => p.name);
      } catch {
        return [];
      }
    })();
    const connection = o.connection ?? q.connection ?? o.defaultConnection;
    const base = { name, connection, params };
    const problems = cat.problemsOf(name);
    if (problems.length) {
      out.push({ ...base, status: 'error', method: 'static', message: problems.join('; ') });
      continue;
    }
    if (o.connection && q.connection && q.connection !== o.connection) {
      out.push({ ...base, connection: q.connection, status: 'skipped', method: 'filter', message: `runs on ${q.connection}` });
      continue;
    }
    if (!connection) {
      out.push({ ...base, status: 'skipped', method: 'no connection', message: 'the query has no "-- connection:" header; pass --connection' });
      continue;
    }
    try {
      if (!clients.has(connection)) clients.set(connection, o.open(connection));
      const client = await clients.get(connection)!;
      const compiled = cat.compile(name, {}, client.dialect, { lenient: true });
      out.push({ ...base, ...(await checkOne(client, client.dialect, compiled.sql, compiled.params)) });
    } catch (e) {
      out.push({ ...base, status: 'error', method: 'live', message: (e as Error).message });
    }
  }
  return out;
}
