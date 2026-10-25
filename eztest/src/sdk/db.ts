/**
 * `db`: databases through the runner's DB step. Two ways only, both with bound
 * parameters (SQL text is never built from values):
 *
 *  - a named query from the catalogue (`db.queries`, one `.sql` file per name,
 *    `:name` binds): `await db.query('OVERDUE_INVOICES', { region: 'EU' })`;
 *  - a tagged template whose `${values}` become bind parameters in the
 *    connection's dialect: ``await db.on('shop').sql`SELECT * FROM t WHERE id = ${id}` ``.
 *
 * Rows come back with case-insensitive column lookup (Oracle returns UPPER CASE
 * names), and values are masked like every other captured value.
 */
import type { DbQuery } from '../core/index.js';
import { literal, run, show, tempKey } from './internal.js';
import { callSite } from './callsite.js';
import { currentHost } from './runtime.js';
import type { Row } from './types.js';

export type BindValue = string | number | boolean | null;

export interface DbOptions {
  /** Connection alias (db.connections); default: the query's `-- connection:` header, or the surface's `db.on(alias)`. */
  connection?: string;
  intent?: string;
  timeoutMs?: number;
}

type Capture = NonNullable<DbQuery['capture']>;

async function runQuery(q: Omit<DbQuery, 'connection'> & { connection?: string }, intent: string, o: DbOptions, vars?: Record<string, unknown>): Promise<unknown> {
  const host = currentHost('db');
  const key = tempKey('db');
  if (vars) for (const [k, v] of Object.entries(vars)) host.setVar(k, v);
  try {
    const r = await run(
      { intent: o.intent ?? intent, action: 'db', db: { ...q, connection: q.connection ?? o.connection ?? '', sql: q.sql ?? '' }, captureAs: key },
      { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) },
    );
    return r.captured?.[key];
  } finally {
    host.deleteVar(key);
    if (vars) for (const k of Object.keys(vars)) host.deleteVar(k);
  }
}

function binds(params: Record<string, BindValue> | undefined): Record<string, BindValue> | undefined {
  if (!params) return undefined;
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? literal(v) : v]));
}

function named(name: string, params: Record<string, BindValue> | BindValue[] | undefined, capture: Capture, o: DbOptions, connection?: string): Promise<unknown> {
  if (typeof name !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(name)) {
    throw new TypeError(`db.query needs a catalogue query name (letters, digits, _ . -), got ${show(name)}; for ad-hoc SQL use the db.sql\`...\` tagged template`);
  }
  const positional = Array.isArray(params) ? params.map((v) => (typeof v === 'string' ? literal(v) : v)) : undefined;
  const b = Array.isArray(params) ? undefined : binds(params);
  return runQuery(
    { query: name, sql: '', capture, ...(b ? { binds: b } : {}), ...(positional ? { params: positional } : {}), ...(connection ?? o.connection ? { connection: connection ?? o.connection } : {}) },
    `Run query ${name}${params && Object.keys(params).length ? ` with ${show(params, 80)}` : ''}`,
    o,
  );
}

function isTemplate(strings: unknown): strings is TemplateStringsArray {
  return Array.isArray(strings) && Array.isArray((strings as unknown as { raw?: unknown }).raw);
}

/** Build bound SQL from a tagged template: each `${value}` is a parameter, never text. */
function templateQuery(strings: TemplateStringsArray, values: unknown[], capture: Capture, o: DbOptions, connection?: string): Promise<unknown> {
  if (!isTemplate(strings)) throw new TypeError('db.sql must be used as a tagged template: db.sql`SELECT ... WHERE id = ${id}`');
  const ns = tempKey('sqlp');
  let sql = strings[0];
  const vars: Record<string, unknown> = {};
  values.forEach((v, i) => {
    vars[`${ns}_${i}`] = v instanceof Date ? v.toISOString() : v;
    sql += `\${${ns}_${i}}${strings[i + 1]}`;
  });
  const conn = connection ?? o.connection;
  if (!conn) throw new TypeError('db.sql needs a connection: db.on("alias").sql`...` or { connection } in db.withOptions');
  return runQuery({ sql, capture, connection: conn }, `Run SQL on ${conn}: ${strings.join('?').replace(/\s+/g, ' ').trim().slice(0, 100)}`, o, vars);
}

function surface(connection?: string, base: DbOptions = {}) {
  return {
    /** Rows of a catalogue query. */
    async query<T extends object = Row>(name: string, params?: Record<string, BindValue> | BindValue[], o: DbOptions = {}): Promise<T[]> {
      return ((await named(name, params, 'rows', { ...base, ...o }, connection)) ?? []) as T[];
    },
    /**
     * Rows of a catalogue query as `{ rows, rowCount }` (the result shape many database helpers
     * return, handy for migrated code). Parameters may be named (`{ region }`) or positional (`[a, b]`).
     */
    async execute<T extends object = Row>(name: string, params?: Record<string, BindValue> | BindValue[], o: DbOptions = {}): Promise<{ rows: T[]; rowCount: number }> {
      const rows = ((await named(name, params, 'rows', { ...base, ...o }, connection)) ?? []) as T[];
      return { rows, rowCount: rows.length };
    },
    /** The first row (fails when there is none). */
    async row<T extends object = Row>(name: string, params?: Record<string, BindValue> | BindValue[], o: DbOptions = {}): Promise<T> {
      return (await named(name, params, 'row', { ...base, ...o }, connection)) as T;
    },
    /** The first cell of the first row (fails when there is no row). */
    async value<T = unknown>(name: string, params?: Record<string, BindValue> | BindValue[], o: DbOptions = {}): Promise<T> {
      return (await named(name, params, 'cell', { ...base, ...o }, connection)) as T;
    },
    /** How many rows the query returns. */
    async count(name: string, params?: Record<string, BindValue> | BindValue[], o: DbOptions = {}): Promise<number> {
      return Number(await named(name, params, 'count', { ...base, ...o }, connection));
    },
    /** Ad-hoc SQL as a tagged template; values are bound. */
    async sql<T extends object = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
      return ((await templateQuery(strings, values, 'rows', base, connection)) ?? []) as T[];
    },
    /** Like sql`...` but the first cell of the first row. */
    async sqlValue<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
      return (await templateQuery(strings, values, 'cell', base, connection)) as T;
    },
    /** Call a stored procedure (Oracle OUT parameters supported); returns rows or OUT values. */
    async procedure<T = unknown>(name: string, params: BindValue[] = [], out?: Array<{ name: string; type?: 'string' | 'number' | 'date' | 'clob' | 'cursor' | 'boolean' }>, o: DbOptions = {}): Promise<T> {
      const conn = connection ?? o.connection ?? base.connection;
      if (!conn) throw new TypeError('db.procedure needs a connection: db.on("alias").procedure(...)');
      const v = await runQuery(
        { procedure: name, sql: '', params: params.map((p) => (typeof p === 'string' ? literal(p) : p)), connection: conn, ...(out ? { out: out.map((x) => ({ name: x.name, type: x.type ?? 'string' })) } : {}) },
        `Call procedure ${name} on ${conn}`,
        { ...base, ...o },
      );
      return v as T;
    },
  };
}

type Surface = ReturnType<typeof surface>;

/** One statement of `db.executeAll`: a catalogue query and its values. */
export type Statement = { query: string; params?: Record<string, BindValue> | BindValue[] } | [string, (Record<string, BindValue> | BindValue[])?];

export interface TransactionOptions {
  /** Connection alias the transaction runs on (default: the surface's `db.on(alias)`). */
  connection?: string;
}

interface TransactionSurface {
  /**
   * Run `fn` in one transaction: every query and execute on the connection inside (through `tx` or `db`)
   * shares it. Committed when `fn` resolves, rolled back when a step fails or `fn` throws. The statements
   * are the evidence of the commit (or rollback) step.
   */
  transaction<T>(fn: (tx: Surface) => Promise<T>, o?: TransactionOptions): Promise<T>;
  /** Run catalogue queries in order in one transaction; returns each one's rows. */
  executeAll<T extends object = Row>(statements: Statement[], o?: TransactionOptions): Promise<Array<{ rows: T[]; rowCount: number }>>;
}

export interface DbSurface extends Surface, TransactionSurface {
  /** The same surface bound to a connection alias. */
  on(connection: string): Surface & TransactionSurface;
}

function transactions(bound?: string): TransactionSurface {
  const conn = (o?: TransactionOptions) => {
    const c = o?.connection ?? bound;
    if (!c) throw new TypeError('db.transaction needs a connection: db.transaction(fn, { connection: "alias" }) or db.on("alias").transaction(fn)');
    return c;
  };
  const transaction = async <T>(fn: (tx: Surface) => Promise<T>, o?: TransactionOptions): Promise<T> => {
    const c = conn(o);
    const host = currentHost('db.transaction');
    if (!host.transaction) throw new TypeError("db.transaction needs EZTest's runner");
    const tx = surface(c);
    return host.transaction(c, () => fn(tx), callSite());
  };
  return {
    transaction,
    async executeAll<T extends object = Row>(statements: Statement[], o?: TransactionOptions) {
      if (!Array.isArray(statements)) throw new TypeError('db.executeAll needs a list of statements: [{ query: "INSERT_VISIT", params: { ... } }, ...]');
      return transaction(async (tx) => {
        const out: Array<{ rows: T[]; rowCount: number }> = [];
        for (const st of statements) {
          const [name, params] = Array.isArray(st) ? st : [st.query, st.params];
          out.push(await tx.execute<T>(name, params));
        }
        return out;
      }, o);
    },
  };
}

export const db: DbSurface = {
  ...surface(),
  ...transactions(),
  on: (connection: string) => ({ ...surface(connection), ...transactions(connection) }),
};
