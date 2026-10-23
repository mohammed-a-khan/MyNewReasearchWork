/**
 * Oracle Database on a REAL server (oracledb Thin mode). Skipped unless
 * EZTEST_ORACLE_URL (or EZTEST_ORACLE_HOST/USER/PASSWORD) is set; see
 * docs/databases.md for the docker command. Fictional data only.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OracleDbClient, DbError, DbRegistry, checkDbHealth, getColumn } from '../../src/surfaces/index.js';
import { bindSql } from '../../src/runner/data-steps.js';
import { QueryCatalogue, checkQueries, resolveQueryExamples } from '../../src/queries/index.js';
import { ORACLE_SKIP, announceSkip, oracleEnv } from './db-env.js';

const ora = oracleEnv();
announceSkip(!!ora, ORACLE_SKIP);

const T = 'ezt_u_items';
const LONG_NOTE = 'Fictional catalogue note. '.repeat(2000); // ~52 KB: a real CLOB, not a VARCHAR2

async function dropIfExists(c: OracleDbClient, kind: 'TABLE' | 'PROCEDURE', name: string): Promise<void> {
  await c.plsql(`BEGIN EXECUTE IMMEDIATE 'DROP ${kind} ${name}${kind === 'TABLE' ? ' PURGE' : ''}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE NOT IN (-942, -4043) THEN RAISE; END IF; END;`);
}

describe.skipIf(!ora)(`Oracle (live, thin mode)${ora ? '' : ` - ${ORACLE_SKIP}`}`, () => {
  let db: OracleDbClient;

  beforeAll(async () => {
    db = await OracleDbClient.connect({ ...ora!, name: 'ora', pool: { min: 1, max: 3 } });
    await dropIfExists(db, 'TABLE', T);
    await db.execute(`CREATE TABLE ${T} (
      id NUMBER(10) PRIMARY KEY, name VARCHAR2(80) NOT NULL, price NUMBER(10,2), big NUMBER(30),
      added DATE, stamp TIMESTAMP(3), notes CLOB, in_stock NUMBER(1), category VARCHAR2(20))`);
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO ${T} VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9)`, [1, 'Garden hose', 19.99, '123456789012345678901234567890', new Date(2026, 2, 1, 14, 5, 0), new Date('2026-03-01T14:05:00.123Z'), LONG_NOTE, true, 'garden']);
      await tx.execute(`INSERT INTO ${T} (id, name, price, added, in_stock, category) VALUES (2, 'Rain barrel', 54.5, TO_DATE('2026-03-05', 'YYYY-MM-DD'), 0, 'garden')`);
      await tx.execute(`INSERT INTO ${T} (id, name, price, added, in_stock, category) VALUES (3, 'Trowel', 7, SYSDATE - 400, 1, 'tools')`);
    });
    await db.execute(`CREATE OR REPLACE PROCEDURE ezt_u_stock(p_category IN VARCHAR2, p_count OUT NUMBER, p_names OUT VARCHAR2, p_rows OUT SYS_REFCURSOR) AS
      BEGIN
        SELECT COUNT(*), LISTAGG(name, ', ') WITHIN GROUP (ORDER BY id) INTO p_count, p_names FROM ${T} WHERE category = p_category;
        OPEN p_rows FOR SELECT id, name FROM ${T} WHERE category = p_category ORDER BY id;
      END;`);
  });

  afterAll(async () => {
    if (!db) return;
    await dropIfExists(db, 'PROCEDURE', 'ezt_u_stock');
    await dropIfExists(db, 'TABLE', T);
    await db.close();
  });

  it('connects in thin mode through a pool and serves concurrent queries', async () => {
    expect(db.thin).toBe(true);
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => db.query<{ N: number }>('SELECT :1 AS n FROM dual', [i])));
    expect(all.map((r) => r[0].N)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(db.poolStatus()).toMatchObject({ max: 3 });
    expect(db.poolStatus().open).toBeLessThanOrEqual(3);
    const p = await db.ping();
    expect(p.version).toMatch(/^\d+\.\d+/);
    expect((await checkDbHealth('ora', async () => db)).ok).toBe(true);
  });

  it('reports a wrong password and an unreachable host as clean errors', async () => {
    const bad = await OracleDbClient.connect({ ...ora!, password: 'wrong-password' });
    const err = await bad.query('SELECT 1 FROM dual').catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toMatch(/ORA-01017/);
    await bad.close();
    const h = await checkDbHealth('nowhere', () => OracleDbClient.connect({ host: '127.0.0.1', port: 1, serviceName: 'X', user: 'u', password: 'p' }).then((c) => c.query('SELECT 1 FROM dual').then(() => c)), 'oracle');
    expect(h).toMatchObject({ ok: false, dialect: 'oracle' });
  });

  it('binds positional and named values; injection strings stay plain values', async () => {
    expect(await db.query(`SELECT id FROM ${T} WHERE category = :1 AND price > :2 ORDER BY id`, ['garden', 20])).toEqual([{ ID: 2 }]);
    expect(await db.query(`SELECT id FROM ${T} WHERE name = :name`, { name: "Trowel' OR '1'='1" })).toEqual([]);
    expect(await db.query(`SELECT id FROM ${T} WHERE name = :name`, { name: 'Trowel' })).toEqual([{ ID: 3 }]);
    const evil = "x'); DROP TABLE ezt_u_items; --";
    await db.execute(`INSERT INTO ${T} (id, name) VALUES (:1, :2)`, [99, evil]);
    expect(await db.query(`SELECT name FROM ${T} WHERE id = 99`)).toEqual([{ NAME: evil }]);
    await db.execute(`DELETE FROM ${T} WHERE id = :1`, [99]);
    // ${var} in a step's SQL (and inside a quoted literal) becomes :1..:n
    const vars = { cat: 'garden', pattern: "Rain' OR 'x'='x" };
    const b = bindSql(`SELECT id FROM ${T} WHERE category = \${cat} AND name LIKE '%\${pattern}%'`, [], vars, 'oracle');
    expect(b.sql).toContain('category = :1 AND name LIKE :2');
    expect(await db.query(b.sql, b.params)).toEqual([]);
    const b2 = bindSql(`SELECT id FROM ${T} WHERE category = \${cat} AND name LIKE 'Rain%' ORDER BY id`, [], vars, 'oracle');
    expect(await db.query(b2.sql, b2.params)).toEqual([{ ID: 2 }]);
  });

  it('returns UPPER CASE columns with case-insensitive lookups and JSON-friendly types', async () => {
    const [r] = await db.query(`SELECT id, name, price, big, added, stamp, notes, in_stock, category, CAST(NULL AS VARCHAR2(5)) AS nothing, 1.5 AS "mixedCase" FROM ${T} WHERE id = 1`);
    expect(Object.keys(r)).toEqual(['ID', 'NAME', 'PRICE', 'BIG', 'ADDED', 'STAMP', 'NOTES', 'IN_STOCK', 'CATEGORY', 'NOTHING', 'mixedCase']);
    expect(r.name).toBe('Garden hose');
    expect(getColumn(r, 'Price')).toBe(19.99);
    expect(r.big).toBe('123456789012345678901234567890'); // beyond double precision: exact text
    expect(r.in_stock).toBe(1); // booleans bind as 1/0
    expect(r.added).toBeInstanceOf(Date);
    expect((r.added as Date).getHours()).toBe(14);
    expect(r.stamp).toBeInstanceOf(Date);
    expect(typeof r.notes).toBe('string');
    expect((r.notes as string).length).toBe(LONG_NOTE.length);
    expect(r.nothing).toBeNull();
    expect(r.MIXEDCASE).toBe(1.5);
    const asText = await OracleDbClient.connect({ ...ora!, fetchAsString: ['DATE', 'NUMBER', 'TIMESTAMP'] });
    try {
      const [t] = await asText.query(`SELECT added, price, stamp FROM ${T} WHERE id = 1`);
      expect(t).toEqual({ ADDED: '2026-03-01T14:05:00', PRICE: '19.99', STAMP: expect.stringMatching(/^2026-03-01T\d\d:05:00\.123$/) });
    } finally {
      await asText.close();
    }
  });

  it('passes Oracle syntax through: FETCH FIRST, DBMS_RANDOM, TO_DATE, SYSDATE, ROWNUM', async () => {
    const two = await db.query(`SELECT id FROM ${T} ORDER BY DBMS_RANDOM.VALUE FETCH FIRST 2 ROWS ONLY`);
    expect(two).toHaveLength(2);
    expect(await db.query(`SELECT id FROM ${T} ORDER BY id OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY`)).toEqual([{ ID: 2 }]);
    const recent = await db.query<{ ID: number }>(`SELECT id FROM ${T} WHERE added >= TO_DATE(:1, 'YYYY-MM-DD') AND added <= SYSDATE + 365 ORDER BY id`, ['2026-01-01']);
    expect(recent.map((x) => x.ID)).toEqual([1, 2]);
    expect(await db.query('SELECT COUNT(*) AS n FROM (SELECT 1 FROM dual CONNECT BY LEVEL <= 5) WHERE ROWNUM <= 3')).toEqual([{ N: 3 }]);
    expect(await db.query('SELECT 1 AS one FROM dual;')).toEqual([{ ONE: 1 }]); // trailing ";" tolerated
  });

  it('runs PL/SQL with OUT, IN OUT and REF CURSOR binds, and stored procedures', async () => {
    const r = await db.plsql('BEGIN :total := :a + :b; :msg := UPPER(:msg); END;', { a: 2, b: 40, total: { out: 'number' }, msg: { out: 'string', value: 'ok' } });
    expect(r.outBinds).toEqual({ total: 42, msg: 'OK' });
    const out = await db.callProcedure('ezt_u_stock', ['garden'], [{ name: 'count', type: 'number' }, { name: 'names' }, { name: 'rows', type: 'cursor' }]);
    expect(out.count).toBe(2);
    expect(out.NAMES).toBe('Garden hose, Rain barrel');
    expect(out.rows).toEqual([{ ID: 1, NAME: 'Garden hose' }, { ID: 2, NAME: 'Rain barrel' }]);
    await expect(db.callProcedure('ezt_u_stock; DROP TABLE x', [])).rejects.toThrow(/Invalid procedure name/);
  });

  it('read-only transactions block writes (ORA-01456) and always roll back', async () => {
    const rows = await db.readOnly((tx) => tx.query(`SELECT COUNT(*) AS n FROM ${T}`));
    expect(rows).toEqual([{ N: 3 }]);
    const err = await db.readOnly((tx) => tx.execute(`UPDATE ${T} SET price = 0`)).catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toMatch(/ORA-01456/);
    expect(await db.query(`SELECT COUNT(*) AS n FROM ${T} WHERE price = 0`)).toEqual([{ N: 0 }]);
  });

  it('commits and rolls back transactions', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(`UPDATE ${T} SET price = 1 WHERE id = 3`);
      expect(await tx.query(`SELECT price FROM ${T} WHERE id = 3`)).toEqual([{ PRICE: 1 }]);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.query(`SELECT price FROM ${T} WHERE id = 3`)).toEqual([{ PRICE: 7 }]);
    await db.transaction((tx) => tx.execute(`UPDATE ${T} SET price = 8 WHERE id = 3`));
    expect(await db.query(`SELECT price FROM ${T} WHERE id = 3`)).toEqual([{ PRICE: 8 }]);
    await db.execute(`UPDATE ${T} SET price = 7 WHERE id = 3`);
  });

  describe('named-query catalogue on Oracle', () => {
    let cwd: string;
    let cat: QueryCatalogue;
    const reg = () => new DbRegistry({ ora: { driver: 'oracle', ...ora! } });

    beforeAll(async () => {
      cwd = await mkdtemp(join(tmpdir(), 'eztest-ora-q-'));
      const w = async (f: string, text: string) => {
        await mkdir(join(cwd, 'queries', f, '..'), { recursive: true });
        await writeFile(join(cwd, 'queries', f), text);
      };
      await w('fragments/in_stock.sql', 'AND i.in_stock = 1');
      await w('ITEMS_BY_CATEGORY.sql', `-- connection: ora\n-- description: In-stock items of a category\n-- params: category, max_price:number = 1000\nSELECT i.id, i.name, i.price FROM ${T} i\n WHERE i.category = :category AND i.price <= :max_price\n {{> in_stock}}\n ORDER BY i.id`);
      await w('ITEM_BY_NAME.sql', `-- connection: ora\nSELECT id FROM ${T} WHERE name = :name OR UPPER(name) = UPPER(:name)`);
      await w('ANY_ITEM.sql', `-- connection: ora\nSELECT id, name FROM ${T} ORDER BY DBMS_RANDOM.VALUE FETCH FIRST 1 ROWS ONLY`);
      await w('BROKEN_COLUMN.sql', `-- connection: ora\nSELECT no_such_column FROM ${T}`);
      await w('BROKEN_TABLE.sql', '-- connection: ora\nSELECT * FROM ezt_no_such_table WHERE id = :id');
      await w('RENAME_ITEM.sql', `-- connection: ora\nUPDATE ${T} SET name = :name WHERE id = :id`);
      await w('MAKE_TABLE.sql', '-- connection: ora\nCREATE TABLE ezt_u_should_not_exist (x NUMBER)');
      cat = await QueryCatalogue.load({ cwd });
    });

    it('runs queries with fragments and named binds (repeated binds included)', async () => {
      const c = cat.compile('ITEMS_BY_CATEGORY', { binds: { category: 'garden' } }, 'oracle');
      expect(c.sql).toMatch(/i\.category = :1 AND i\.price <= :2\s+AND i\.in_stock = 1/);
      expect(await db.query(c.sql, c.params as never)).toEqual([{ ID: 1, NAME: 'Garden hose', PRICE: 19.99 }]);
      const n = cat.compile('ITEM_BY_NAME', { binds: { name: "trowel' OR 'a'='a" } }, 'oracle');
      expect(n.params).toEqual(["trowel' OR 'a'='a", "trowel' OR 'a'='a"]);
      expect(await db.query(n.sql, n.params as never)).toEqual([]);
      const ok = cat.compile('ITEM_BY_NAME', { binds: { name: 'trowel' } }, 'oracle');
      expect(await db.query(ok.sql, ok.params as never)).toEqual([{ ID: 3 }]);
      const any = cat.compile('ANY_ITEM', {}, 'oracle');
      expect(await db.query(any.sql, any.params as never)).toHaveLength(1);
    });

    it('queries check parses everything without executing, and catches broken queries', async () => {
      const r = reg();
      try {
        const results = await checkQueries(cat, { open: (n) => r.get(n) });
        const by = Object.fromEntries(results.map((x) => [x.name, x]));
        expect(by.ITEMS_BY_CATEGORY).toMatchObject({ status: 'ok', columns: ['ID', 'NAME', 'PRICE'] });
        expect(by.ANY_ITEM.status).toBe('ok');
        expect(by.RENAME_ITEM.status).toBe('ok'); // DML is parsed, never executed
        expect(by.BROKEN_COLUMN).toMatchObject({ status: 'error', message: expect.stringMatching(/ORA-00904/) });
        expect(by.BROKEN_TABLE).toMatchObject({ status: 'error', message: expect.stringMatching(/ORA-00942/) });
        expect(by.MAKE_TABLE.status).toBe('skipped');
        expect(await db.query("SELECT COUNT(*) AS n FROM user_tables WHERE table_name = 'EZT_U_SHOULD_NOT_EXIST'")).toEqual([{ N: 0 }]);
        expect(await db.query(`SELECT name FROM ${T} WHERE id = 1`)).toEqual([{ NAME: 'Garden hose' }]);
      } finally {
        await r.closeAll();
      }
    });

    it('resolves Examples rows from a query', async () => {
      const r = reg();
      try {
        const rows = await resolveQueryExamples('ITEMS_BY_CATEGORY', undefined, { category: '${cat}', max_price: 100 }, { catalogue: cat, open: (n) => r.get(n), vars: { cat: 'tools' } });
        expect(rows).toEqual([{ ID: '3', NAME: 'Trowel', PRICE: '7' }]);
        const lower = await resolveQueryExamples('ITEMS_BY_CATEGORY', 'ora', { category: 'garden' }, { catalogue: cat, open: (n) => r.get(n), keys: 'lower' });
        expect(lower).toEqual([{ id: '1', name: 'Garden hose', price: '19.99' }]);
        await expect(resolveQueryExamples('ITEMS_BY_CATEGORY', 'ora', {}, { catalogue: cat, open: (n) => r.get(n) })).rejects.toThrow(/needs param "category"/);
      } finally {
        await r.closeAll();
      }
    });
  });
});
