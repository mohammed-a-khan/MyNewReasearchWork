import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { SqliteDbClient, PostgresDbClient, MssqlDbClient, DbRegistry, compareRows, ApiClient, DbError } from '../../src/surfaces/index.js';

describe('SqliteDbClient', () => {
  let demo: DemoServer;
  let db: SqliteDbClient;
  beforeAll(async () => {
    demo = await startDemoApp();
    db = new SqliteDbClient({ database: demo.db, name: 'demo' });
  });
  afterAll(async () => {
    await db.close();
    await demo.close();
  });

  it('queries with positional and named parameters (no string substitution)', async () => {
    const rows = await db.query<{ name: string }>('SELECT name FROM customers WHERE region = ? AND credit_limit > ? ORDER BY id', ['EU', 10000]);
    expect(rows.map((r) => r.name)).toEqual(['Contoso Ltd', 'Northwind Traders']);
    const named = await db.query('SELECT id FROM customers WHERE name = :name', { name: "x' OR '1'='1" });
    expect(named).toEqual([]);
    await expect(db.query('  ')).rejects.toThrow(/empty/);
    await expect(db.query('SELECT * FROM nope')).rejects.toBeInstanceOf(DbError);
  });

  it('commits a transaction', async () => {
    const id = await db.transaction(async (tx) => {
      const r = await tx.execute('INSERT INTO customers (name, region, credit_limit) VALUES (?, ?, ?)', ['Tx Commit Co', 'APAC', 1]);
      return r.lastInsertId;
    });
    expect(await db.query('SELECT name FROM customers WHERE id = ?', [id as number])).toEqual([{ name: 'Tx Commit Co' }]);
    await db.execute('DELETE FROM customers WHERE id = ?', [id as number]);
  });

  it('really rolls back on error, including nested savepoints', async () => {
    const before = (await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM customers'))[0].n;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute('INSERT INTO customers (name, region, credit_limit) VALUES (?, ?, ?)', ['Rollback Co', 'EU', 1]);
        const inside = (await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM customers'))[0].n;
        expect(inside).toBe(before + 1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM customers'))[0].n).toBe(before);

    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO customers (name, region, credit_limit) VALUES (?, ?, ?)', ['Outer Co', 'EU', 1]);
      await expect(
        tx.transaction(async (inner) => {
          await inner.execute('INSERT INTO customers (name, region, credit_limit) VALUES (?, ?, ?)', ['Inner Co', 'EU', 1]);
          throw new Error('inner');
        }),
      ).rejects.toThrow('inner');
    });
    const names = (await db.query<{ name: string }>("SELECT name FROM customers WHERE name IN ('Outer Co','Inner Co')")).map((r) => r.name);
    expect(names).toEqual(['Outer Co']);
    await db.execute("DELETE FROM customers WHERE name = 'Outer Co'");
  });

  it('serializes other work behind an open transaction', async () => {
    const order: string[] = [];
    const tx = db.transaction(async (t) => {
      await t.execute('INSERT INTO customers (name, region, credit_limit) VALUES (?, ?, ?)', ['Serial Co', 'EU', 1]);
      await new Promise((r) => setTimeout(r, 50));
      order.push('tx');
      throw new Error('rollback');
    });
    const q = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM customers WHERE name = 'Serial Co'").then((r) => {
      order.push('query');
      return r[0].n;
    });
    await expect(tx).rejects.toThrow('rollback');
    expect(await q).toBe(0);
    expect(order).toEqual(['tx', 'query']);
  });

  it('binds booleans and dates', async () => {
    const r = await db.query<{ b: number; d: string }>('SELECT ? AS b, ? AS d', [true, new Date('2026-01-02T03:04:05Z')]);
    expect(r[0]).toEqual({ b: 1, d: '2026-01-02T03:04:05.000Z' });
  });
});

describe('optional drivers and registry', () => {
  it('fails clearly when pg / mssql are not installed', async () => {
    // The live suites point EZTEST_PG_DRIVER / EZTEST_MSSQL_DRIVER at drivers installed elsewhere.
    const saved = { pg: process.env.EZTEST_PG_DRIVER, ms: process.env.EZTEST_MSSQL_DRIVER };
    delete process.env.EZTEST_PG_DRIVER;
    delete process.env.EZTEST_MSSQL_DRIVER;
    try {
      const pg = await PostgresDbClient.connect({ host: 'localhost' }).catch((e) => e);
      expect(pg).toBeInstanceOf(DbError);
      expect(pg.code).toBe('DB_DRIVER_MISSING');
      expect(pg.message).toMatch(/npm install pg/);
      const ms = await MssqlDbClient.connect({ server: 'localhost' }).catch((e) => e);
      expect(ms.code).toBe('DB_DRIVER_MISSING');
      expect(ms.message).toMatch(/npm install mssql/);
      // A driver folder that holds no such package is named in the error.
      process.env.EZTEST_PG_DRIVER = '/nonexistent/node_modules/pg';
      const bad = await PostgresDbClient.connect({ host: 'localhost' }).catch((e) => e);
      expect(bad.code).toBe('DB_DRIVER_LOAD');
      expect(bad.message).toMatch(/EZTEST_PG_DRIVER=\/nonexistent\/node_modules\/pg does not hold the "pg" package/);
    } finally {
      if (saved.pg === undefined) delete process.env.EZTEST_PG_DRIVER;
      else process.env.EZTEST_PG_DRIVER = saved.pg;
      if (saved.ms !== undefined) process.env.EZTEST_MSSQL_DRIVER = saved.ms;
    }
  });
  it('PostgreSQL named binds become $1..$n; literals, casts and comments are left alone', () => {
    expect(PostgresDbClient.bind("SELECT * FROM t WHERE a = :a AND b::text = :b AND c = ':a' -- :zz\n AND d = :a", { a: 1, ':b': 'x' }))
      .toEqual({ text: "SELECT * FROM t WHERE a = $1 AND b::text = $2 AND c = ':a' -- :zz\n AND d = $3", values: [1, 'x', 1] });
    expect(PostgresDbClient.bind('SELECT $1', [5])).toEqual({ text: 'SELECT $1', values: [5] });
    expect(() => PostgresDbClient.bind('SELECT :missing', { other: 1 })).toThrow(/no value for bind :missing \(binds given: other\)/);
  });
  it('opens named connections lazily and rejects unknown names', async () => {
    const reg = new DbRegistry({ mem: { driver: 'sqlite', file: ':memory:' } });
    const c = await reg.get('mem');
    expect(await reg.get('mem')).toBe(c);
    await c.execute('CREATE TABLE t (x INTEGER)');
    await c.execute('INSERT INTO t VALUES (?)', [5]);
    expect(await c.query('SELECT x FROM t')).toEqual([{ x: 5 }]);
    await expect(reg.get('other')).rejects.toThrow(/Unknown database connection "other"/);
    await reg.closeAll();
    await expect(c.query('SELECT 1')).rejects.toThrow(/closed/);
  });
});

describe('compareRows', () => {
  it('fails when both sides are empty (nothing compared)', () => {
    const r = compareRows([], [], { key: 'id' });
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/nothing was compared/);
  });
  it('treats numbers and numeric strings as equal, with tolerance', () => {
    const r = compareRows([{ id: 1, total: 25000 }, { id: 2, total: 19.99 }], [{ id: '1', total: '25000.00' }, { id: 2, total: '19.989' }], {
      key: 'id',
      tolerance: { total: 0.01 },
    });
    expect(r.passed).toBe(true);
    expect(r.compared).toBe(2);
    const strict = compareRows([{ id: 2, total: 19.99 }], [{ id: 2, total: '19.989' }], { key: 'id' });
    expect(strict.passed).toBe(false);
  });
  it('compares dates as dates and never as numbers', () => {
    const ok = compareRows([{ id: 1, d: new Date('2026-01-05T00:00:00Z') }], [{ id: 1, d: '2026-01-05' }], { key: 'id' });
    expect(ok.passed).toBe(true);
    // parseFloat('2026-01-05') === parseFloat('2026-12-31') === 2026; we must not say equal
    const bad = compareRows([{ id: 1, d: '2026-01-05' }], [{ id: 1, d: '2026-12-31' }], { key: 'id' });
    expect(bad.passed).toBe(false);
    expect(bad.mismatches[0].reason).toBe('dates differ');
    const vsNum = compareRows([{ id: 1, d: '2026-01-05' }], [{ id: 1, d: 2026 }], { key: 'id' });
    expect(vsNum.passed).toBe(false);
  });
  it('reports missing, extra and duplicate keys, and cell mismatches', () => {
    const r = compareRows(
      [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 2, n: 'b2' }, { id: 4, n: 'd' }],
      [{ id: 1, n: 'A' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }],
      { key: 'id' },
    );
    expect(r.passed).toBe(false);
    expect(r.missing).toEqual(['4']);
    expect(r.extra).toEqual(['3']);
    expect(r.duplicates).toEqual([{ side: 'expected', key: '2' }]);
    expect(r.mismatches).toEqual([{ key: '1', column: 'n', expected: 'a', actual: 'A', reason: 'text differs' }]);
    expect(compareRows([{ id: 1, n: 'a' }], [{ id: 1, n: 'A' }], { key: 'id', ignoreCase: true }).passed).toBe(true);
  });
  it('handles composite keys, booleans, nulls, missing columns and typeAware=false', () => {
    expect(compareRows([{ a: 1, b: 'x', ok: true, z: null }], [{ a: '1', b: 'x', ok: 1, z: null }], { key: ['a', 'b'] }).passed).toBe(true);
    expect(compareRows([{ id: 1, z: null }], [{ id: 1, z: '' }], { key: 'id' }).passed).toBe(false);
    expect(compareRows([{ id: 1, v: 5 }], [{ id: 1 }], { key: 'id' }).mismatches[0].reason).toBe('column missing in actual');
    expect(compareRows([{ id: 1, v: 5 }], [{ id: 1, v: '5' }], { key: 'id', typeAware: false }).passed).toBe(false);
    expect(compareRows([{ id: 1 }], [{ id: 1 }], { key: 'id' }).passed).toBe(false); // no columns to compare
    expect(compareRows([{ v: 1 }], [{ v: 1 }], { key: 'id' }).passed).toBe(false); // key missing
  });
});

describe('UI vs API vs DB reconciliation sample', () => {
  it('API customers equal DB customers', async () => {
    const demo = await startDemoApp();
    try {
      const api = new ApiClient({ baseUrl: demo.url });
      const tok = await api.post<{ access_token: string }>('/api/token', { form: { grant_type: 'client_credentials', client_id: 'ez-client', client_secret: 'ez-client-secret' } });
      const apiRows = (await api.get<Record<string, unknown>[]>('/api/customers', { auth: { type: 'bearer', token: tok.body.access_token } })).body;
      const dbRows = await new SqliteDbClient({ database: demo.db }).query('SELECT id, name, region, CAST(credit_limit AS TEXT) AS credit_limit FROM customers');
      const r = compareRows(dbRows, apiRows, { key: 'id' });
      expect(r.summary).toBe('PASS: 3 rows x 3 columns equal');
    } finally {
      await demo.close();
    }
  });
});

