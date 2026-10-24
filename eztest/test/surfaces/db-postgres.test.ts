/**
 * PostgreSQL on a REAL server (pg). Skipped unless EZTEST_PG_URL is set (and
 * the pg driver loads: installed here, or EZTEST_PG_DRIVER); see
 * docs/databases.md for the docker command. Fictional data only.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresDbClient, DbError, DbRegistry, checkDbHealth, compareRows, getColumn } from '../../src/surfaces/index.js';
import { bindSql } from '../../src/runner/data-steps.js';
import { QueryCatalogue, checkQueries, resolveQueryExamples } from '../../src/queries/index.js';
import { DbMonitor, LoadTest } from '../../src/load/index.js';
import { PG_SKIP, announceSkip, pgDriverAvailable, pgEnv } from './db-env.js';
import { scenario } from '../load/helpers.js';

const pg = pgEnv();
const on = !!pg && (await pgDriverAvailable());
announceSkip(on, PG_SKIP);

const T = 'ezt_pg_items';

describe.skipIf(!on)(`PostgreSQL (live)${on ? '' : ` - ${PG_SKIP}`}`, () => {
  let db: PostgresDbClient;

  beforeAll(async () => {
    db = await PostgresDbClient.connect({ connectionString: pg!.connectionString, name: 'pg', max: 3 });
    await db.execute(`DROP TABLE IF EXISTS ${T}`);
    await db.execute(`CREATE TABLE ${T} (id integer PRIMARY KEY, name varchar(80) NOT NULL, price numeric(10,2), big numeric(30), added timestamptz, notes text, in_stock boolean, category varchar(20), tags jsonb)`);
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO ${T} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [1, 'Garden hose', 19.99, '123456789012345678901234567890', new Date('2026-03-01T14:05:00.123Z'), 'Fictional', true, 'garden', JSON.stringify({ colour: 'green' })]);
      await tx.execute(`INSERT INTO ${T} (id, name, price, added, in_stock, category) VALUES (:id, :name, :price, :added::timestamptz, :stock, :cat)`, { id: 2, name: 'Rain barrel', price: 54.5, added: '2026-03-05T00:00:00Z', stock: false, cat: 'garden' });
      await tx.execute(`INSERT INTO ${T} (id, name, price, added, in_stock, category) VALUES (3, 'Trowel', 7, now() - interval '400 days', true, 'tools')`);
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.execute(`DROP TABLE IF EXISTS ${T}`).catch(() => undefined);
    await db.close();
  });

  it('connects through a pool, serves concurrent queries and reports health', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => db.query<{ n: number }>('SELECT $1::int AS n', [i])));
    expect(all.map((r) => r[0].n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const h = await checkDbHealth('pg', async () => db);
    expect(h).toMatchObject({ ok: true, dialect: 'postgres', version: expect.stringMatching(/^PostgreSQL 1\d/) });
  });

  it('reports a wrong password and an unreachable server as clean errors', async () => {
    const bad = await PostgresDbClient.connect({ host: pg!.host, port: pg!.port, database: pg!.database, user: pg!.user, password: 'wrong-password' });
    const err = await bad.query('SELECT 1').catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toMatch(/password authentication failed for user "eztest".*SQLSTATE 28P01/);
    await bad.close();
    const h = await checkDbHealth('nowhere', async () => {
      const c = await PostgresDbClient.connect({ host: '127.0.0.1', port: 1, user: 'u', password: 'p' });
      try {
        await c.query('SELECT 1');
        return c;
      } catch (e) {
        await c.close();
        throw e;
      }
    }, 'postgres');
    expect(h).toMatchObject({ ok: false, dialect: 'postgres' });
  });

  it('binds $n and :name values; injection strings stay plain values; casts and literals are not binds', async () => {
    expect(await db.query(`SELECT id FROM ${T} WHERE category = $1 AND price > $2 ORDER BY id`, ['garden', 20])).toEqual([{ id: 2 }]);
    expect(await db.query(`SELECT id FROM ${T} WHERE name = :name`, { name: "Trowel' OR '1'='1" })).toEqual([]);
    expect(await db.query(`SELECT id FROM ${T} WHERE name = :name OR lower(name) = lower(:name)`, { name: 'trowel' })).toEqual([{ id: 3 }]);
    // ":x" inside a literal, "::" casts and comments are left alone
    expect(await db.query(`SELECT ':not_a_bind' AS lit, :n::int + 1 AS next -- :ignored`, { n: 41 })).toEqual([{ lit: ':not_a_bind', next: 42 }]);
    const evil = "x'); DROP TABLE ezt_pg_items; --";
    await db.execute(`INSERT INTO ${T} (id, name) VALUES (:id, :name)`, { id: 99, name: evil });
    expect(await db.query(`SELECT name FROM ${T} WHERE id = 99`)).toEqual([{ name: evil }]);
    await db.execute(`DELETE FROM ${T} WHERE id = $1`, [99]);
    await expect(db.query('SELECT :missing', { other: 1 })).rejects.toThrow(/no value for bind :missing/);
    // ${var} in a step's SQL (and inside a quoted literal) becomes $1..$n
    const vars = { cat: 'garden', pattern: "Rain' OR 'x'='x" };
    const b = bindSql(`SELECT id FROM ${T} WHERE category = \${cat} AND name LIKE '%\${pattern}%'`, [], vars, 'postgres');
    expect(b.sql).toContain('category = $1 AND name LIKE $2');
    expect(await db.query(b.sql, b.params)).toEqual([]);
    const b2 = bindSql(`SELECT id FROM ${T} WHERE category = \${cat} AND name LIKE 'Rain%' ORDER BY id`, [], vars, 'postgres');
    expect(await db.query(b2.sql, b2.params)).toEqual([{ id: 2 }]);
  });

  it('returns rows with case-insensitive lookups and pg types', async () => {
    const [r] = await db.query(`SELECT id, name, price, big, added, notes, in_stock, tags, NULL::text AS nothing, 1.5 AS "mixedCase" FROM ${T} WHERE id = 1`);
    expect(Object.keys(r)).toEqual(['id', 'name', 'price', 'big', 'added', 'notes', 'in_stock', 'tags', 'nothing', 'mixedCase']);
    expect(getColumn(r, 'NAME')).toBe('Garden hose');
    expect(r.price).toBe('19.99'); // numeric is exact text in pg
    expect(r.big).toBe('123456789012345678901234567890');
    expect(r.in_stock).toBe(true);
    expect(r.added).toBeInstanceOf(Date);
    expect((r.added as Date).toISOString()).toBe('2026-03-01T14:05:00.123Z');
    expect(r.tags).toEqual({ colour: 'green' });
    expect(r.nothing).toBeNull();
    expect(r.MIXEDCASE).toBe('1.5');
    // Typed compare: numeric text equals a JSON number, a timestamptz equals its ISO text.
    const api = [{ id: 1, name: 'Garden hose', price: 19.99, added: '2026-03-01T14:05:00.123Z' }];
    expect(compareRows(api, await db.query(`SELECT id, name, price, added FROM ${T} WHERE id = 1`), { key: 'id' }).summary).toBe('PASS: 1 rows x 3 columns equal');
  });

  it('commits and rolls back transactions', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(`UPDATE ${T} SET price = 1 WHERE id = :id`, { id: 3 });
      expect(await tx.query(`SELECT price FROM ${T} WHERE id = 3`)).toEqual([{ price: '1.00' }]);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.query(`SELECT price FROM ${T} WHERE id = 3`)).toEqual([{ price: '7.00' }]);
    await db.transaction((tx) => tx.execute(`UPDATE ${T} SET price = 8 WHERE id = 3`));
    expect(await db.query(`SELECT price FROM ${T} WHERE id = 3`)).toEqual([{ price: '8.00' }]);
    await db.execute(`UPDATE ${T} SET price = 7 WHERE id = 3`);
    // A failing statement aborts the transaction and is reported with its SQLSTATE.
    const err = await db.transaction((tx) => tx.execute(`INSERT INTO ${T} (id, name) VALUES (1, 'dup')`)).catch((e) => e);
    expect(err.message).toMatch(/duplicate key value violates unique constraint.*SQLSTATE 23505/);
  });

  describe('named-query catalogue on PostgreSQL', () => {
    let cwd: string;
    let cat: QueryCatalogue;
    const reg = () => new DbRegistry({ pg: { driver: 'postgres', connectionString: pg!.connectionString } });

    beforeAll(async () => {
      cwd = await mkdtemp(join(tmpdir(), 'eztest-pg-q-'));
      const w = async (f: string, text: string) => {
        await mkdir(join(cwd, 'queries', f, '..'), { recursive: true });
        await writeFile(join(cwd, 'queries', f), text);
      };
      await w('fragments/in_stock.sql', 'AND i.in_stock');
      await w('ITEMS_BY_CATEGORY.sql', `-- connection: pg\n-- description: In-stock items of a category\n-- params: category, max_price:number = 1000\nSELECT i.id, i.name, i.price FROM ${T} i\n WHERE i.category = :category AND i.price <= :max_price::numeric\n {{> in_stock}}\n ORDER BY i.id`);
      await w('ITEM_BY_NAME.sql', `-- connection: pg\nSELECT id FROM ${T} WHERE name = :name OR upper(name) = upper(:name)`);
      await w('BROKEN_COLUMN.sql', `-- connection: pg\nSELECT no_such_column FROM ${T}`);
      await w('BROKEN_TABLE.sql', '-- connection: pg\nSELECT * FROM ezt_no_such_table WHERE id = :id');
      await w('RENAME_ITEM.sql', `-- connection: pg\nUPDATE ${T} SET name = :name WHERE id = :id::int`);
      await w('MAKE_TABLE.sql', '-- connection: pg\nCREATE TABLE ezt_pg_should_not_exist (x int)');
      cat = await QueryCatalogue.load({ cwd });
    });

    it('runs queries with fragments and named binds (repeated binds included)', async () => {
      const c = cat.compile('ITEMS_BY_CATEGORY', { binds: { category: 'garden' } }, 'postgres');
      expect(c.sql).toMatch(/i\.category = \$1 AND i\.price <= \$2::numeric\s+AND i\.in_stock/);
      expect(await db.query(c.sql, c.params as never)).toEqual([{ id: 1, name: 'Garden hose', price: '19.99' }]);
      const n = cat.compile('ITEM_BY_NAME', { binds: { name: "trowel' OR 'a'='a" } }, 'postgres');
      expect(n.params).toEqual(["trowel' OR 'a'='a", "trowel' OR 'a'='a"]);
      expect(await db.query(n.sql, n.params as never)).toEqual([]);
      const ok = cat.compile('ITEM_BY_NAME', { binds: { name: 'trowel' } }, 'postgres');
      expect(await db.query(ok.sql, ok.params as never)).toEqual([{ id: 3 }]);
    });

    it('queries check EXPLAINs everything in a read-only transaction, and catches broken queries', async () => {
      const r = reg();
      try {
        const results = await checkQueries(cat, { open: (n) => r.get(n) });
        const by = Object.fromEntries(results.map((x) => [x.name, x]));
        expect(by.ITEMS_BY_CATEGORY).toMatchObject({ status: 'ok' });
        expect(by.RENAME_ITEM.status).toBe('ok'); // EXPLAIN of an UPDATE: planned, never executed
        expect(by.BROKEN_COLUMN).toMatchObject({ status: 'error', message: expect.stringMatching(/column "no_such_column" does not exist.*SQLSTATE 42703/) });
        expect(by.BROKEN_TABLE).toMatchObject({ status: 'error', message: expect.stringMatching(/relation "ezt_no_such_table" does not exist.*SQLSTATE 42P01/) });
        expect(by.MAKE_TABLE.status).toBe('skipped');
        expect(await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'ezt_pg_should_not_exist'")).toEqual([{ n: 0 }]);
        expect(await db.query(`SELECT name FROM ${T} WHERE id = 1`)).toEqual([{ name: 'Garden hose' }]);
      } finally {
        await r.closeAll();
      }
    });

    it('resolves Examples rows from a query', async () => {
      const r = reg();
      try {
        const rows = await resolveQueryExamples('ITEMS_BY_CATEGORY', undefined, { category: '${cat}', max_price: 100 }, { catalogue: cat, open: (n) => r.get(n), vars: { cat: 'tools' } });
        expect(rows).toEqual([{ id: '3', name: 'Trowel', price: '7.00' }]);
        await expect(resolveQueryExamples('ITEMS_BY_CATEGORY', 'pg', {}, { catalogue: cat, open: (n) => r.get(n) })).rejects.toThrow(/needs param "category"/);
      } finally {
        await r.closeAll();
      }
    });
  });

  it('load monitor: sessions, waits, throughput and top SQL from pg_stat views on the load timeline', async () => {
    await db.execute('CREATE EXTENSION IF NOT EXISTS pg_stat_statements').catch(() => undefined);
    const conn = { driver: 'postgres', connectionString: pg!.connectionString };
    const r = await new LoadTest(scenario({
      connections: { pg: conn, mon: conn },
      userPaths: { p: { actions: [{ sql: { name: 'pg query', connection: 'pg', sql: `SELECT count(*) AS n FROM ${T} WHERE category = 'garden'` } }], thinkTime: '50ms' } },
      profile: { type: 'constant', vus: 3, duration: '4s' },
      monitors: [{ type: 'db', name: 'postgres', connection: 'mon', intervalMs: 1000, topSql: 5 }],
    })).run();
    const m = r.monitors.find((x) => x.name === 'postgres')!;
    expect(r.names.find((n) => n.name === 'pg query')!.count).toBeGreaterThan(5);
    expect(m.errors).toEqual([]);
    expect(m.points.length).toBeGreaterThanOrEqual(2);
    const last = m.points[m.points.length - 1].values;
    expect(last.sessions).toBeGreaterThan(0);
    expect(last.throughputPerSec).toBeGreaterThan(0);
    // pg_stat_statements is loaded in the test container (shared_preload_libraries); elsewhere top SQL is simply empty.
    const hasStatements = (await db.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_stat_statements'"))[0].n === 1;
    if (hasStatements) expect(m.topSql?.length).toBeGreaterThan(0);
    // The monitor reads the views directly too.
    const s = await new DbMonitor(db).sample();
    expect(s.values.sessions).toBeGreaterThan(0);
  }, 90_000);
});
