/**
 * Database transactions around steps: `In a transaction on clinic` ... `End` in `.ez`, and
 * `db.transaction(async (tx) => ...)` / `db.executeAll([...])` in code. Every query and execute
 * step inside runs on one connection of the alias in one transaction: committed when the block
 * passes, rolled back when a step fails (or the code throws). The statements (SQL and the number
 * of bound values, never the values) and the outcome are kept as evidence.
 *
 * The open transaction travels with the async call chain (AsyncLocalStorage), so the DB step
 * handler finds it for the steps of the block, also inside sub-journeys and code steps, and
 * parallel branches outside the block are not affected.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EzTestError } from '../core/index.js';
import type { DbHandler, DbQueryParams } from './types.js';

/** One open transaction: queries on its connection. */
export interface TxHandle {
  connection: string;
  query(sql: string, params: DbQueryParams): Promise<Array<Record<string, unknown>>>;
  /** What ran inside, in order. */
  statements: Array<{ sql: string; params: number; rows: number; at: string }>;
}

const store = new AsyncLocalStorage<Map<string, TxHandle>>();

/** The transaction open for a connection alias in the current call chain, if any. */
export function activeTransaction(connection: string): TxHandle | undefined {
  return store.getStore()?.get(connection);
}

export interface TransactionOutcome<T> {
  value?: T;
  error?: unknown;
  committed: boolean;
  statements: TxHandle['statements'];
}

/**
 * Run `fn` with a transaction open on `connection`: commit when it resolves, roll back when it throws.
 * Never throws itself: the outcome says what happened.
 */
export async function runInTransaction<T>(db: DbHandler | undefined, connection: string, fn: () => Promise<T>): Promise<TransactionOutcome<T>> {
  const statements: TxHandle['statements'] = [];
  if (!db) return { error: new EzTestError('No db handler configured (RunOptions.db)', 'NO_HANDLER'), committed: false, statements };
  if (!db.transaction) return { error: new EzTestError('This db handler has no transactions (run through the EZTest engine)', 'NOT_SUPPORTED'), committed: false, statements };
  if (!connection) return { error: new EzTestError('A transaction needs a connection alias ("In a transaction on <alias>")', 'MISSING_VALUE'), committed: false, statements };
  if (activeTransaction(connection)) return { error: new EzTestError(`A transaction on ${connection} is already open here (nested transactions are not supported)`, 'DB_TX_NESTED'), committed: false, statements };
  let value: T | undefined;
  let inner: unknown;
  try {
    await db.transaction(connection, async (tx) => {
      const handle: TxHandle = {
        connection,
        statements,
        async query(sql, params) {
          const rows = await tx.query(sql, params);
          statements.push({ sql, params: Array.isArray(params) ? params.length : 0, rows: rows.length, at: new Date().toISOString() });
          return rows;
        },
      };
      const map = new Map(store.getStore() ?? []);
      map.set(connection, handle);
      try {
        value = await store.run(map, fn);
      } catch (e) {
        inner = e;
        throw e;
      }
    });
    return { value, committed: true, statements };
  } catch (e) {
    return { error: inner ?? e, committed: false, statements };
  }
}

/** The evidence text of a transaction. */
export function transactionEvidence(connection: string, o: TransactionOutcome<unknown>, mask: (s: string) => string = (s) => s): string {
  return JSON.stringify({
    connection,
    outcome: o.committed ? 'committed' : 'rolled back',
    ...(o.error ? { error: mask(o.error instanceof Error ? o.error.message : String(o.error)) } : {}),
    statements: o.statements.map((s) => ({ ...s, sql: mask(s.sql) })),
  }, null, 2);
}
