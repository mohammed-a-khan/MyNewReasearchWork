/**
 * Transactions through the engine's database handler on every driver: the statements inside one
 * `runInTransaction` (what `In a transaction on <alias>` and `db.transaction` use) share one connection of the
 * alias, commit together, and roll back together when one fails. SQLite always runs; PostgreSQL, SQL Server,
 * Oracle, MariaDB and MySQL run against live servers when their environment is set (docs/databases.md,
 * test/acceptance/enterprise/env/mysql.sh), and are skipped with a message otherwise.
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { createEngine, type Engine } from '../../src/engine/index.js';
import { activeTransaction, runInTransaction } from '../../src/runner/db-tx.js';
import type { DbHandler } from '../../src/runner/types.js';
import { mssqlEnv, oracleEnv, pgEnv } from './db-env.js';

interface Target {
  label: string;
  connection: Record<string, unknown>;
  skip?: string;
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function targets(): Target[] {
  const e = process.env;
  const pg = pgEnv();
  const ms = mssqlEnv();
  const ora = oracleEnv();
  return [
    { label: 'SQLite', connection: { driver: 'sqlite', file: ':file:' } },
    pg ? { label: 'PostgreSQL', connection: { driver: 'postgres', connectionString: pg.connectionString } } : { label: 'PostgreSQL', connection: {}, skip: 'set EZTEST_PG_URL (+ EZTEST_PG_DRIVER)' },
    ms ? { label: 'SQL Server', connection: { driver: 'mssql', connectionString: e.EZTEST_MSSQL_URL, trustServerCertificate: true } } : { label: 'SQL Server', connection: {}, skip: 'set EZTEST_MSSQL_URL (+ EZTEST_MSSQL_DRIVER)' },
    ora ? { label: 'Oracle', connection: { driver: 'oracle', connectString: `${ora.host}:${ora.port}/${ora.serviceName}`, user: ora.user, password: ora.password } } : { label: 'Oracle', connection: {}, skip: 'set EZTEST_ORACLE_URL' },
    e.EZTEST_MARIADB_URL ? { label: 'MariaDB', connection: { driver: 'mariadb', connectionString: e.EZTEST_MARIADB_URL } } : { label: 'MariaDB', connection: {}, skip: 'set EZTEST_MARIADB_URL (test/acceptance/enterprise/env/mysql.sh env)' },
    e.EZTEST_MYSQL_URL ? { label: 'MySQL', connection: { driver: 'mysql', connectionString: e.EZTEST_MYSQL_URL } } : { label: 'MySQL', connection: {}, skip: 'set EZTEST_MYSQL_URL (test/acceptance/enterprise/env/mysql.sh env)' },
  ];
}

const T = 'ezt_tx_visits';

async function engineFor(t: Target): Promise<{ engine: Engine; db: DbHandler }> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-tx-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queries'));
  await writeFile(join(dir, 'queries', 'INSERT_TX_VISIT.sql'), `-- connection: clinic\n-- params: visit_id, reason\nINSERT INTO ${T} (visit_id, reason) VALUES (:visit_id, :reason)\n`);
  await writeFile(join(dir, 'queries', 'TX_VISITS.sql'), `-- connection: clinic\nSELECT visit_id FROM ${T} ORDER BY visit_id\n`);
  const connection = { ...t.connection, ...(t.connection.file === ':file:' ? { file: join(dir, 'clinic.db') } : {}) };
  await writeFile(join(dir, 'eztest.config.yaml'), `db:\n  connections:\n    clinic: ${JSON.stringify(connection)}\n  queries:\n    dir: queries\n`);
  const engine = await createEngine(await loadConfig({ cwd: dir, environment: {} }), { cwd: dir });
  return { engine, db: engine.runOptions.db! };
}

async function exec(db: DbHandler, name: string, binds: Record<string, string> = {}): Promise<Array<Record<string, unknown>>> {
  const c = await db.namedQuery!(name, '', { binds });
  const tx = activeTransaction(c.connection);
  return tx ? tx.query(c.sql, c.params as never) : db.query(c.connection, c.sql, c.params as never);
}

for (const t of targets()) {
  describe.skipIf(!!t.skip)(`transactions on ${t.label}${t.skip ? ` (skipped: ${t.skip})` : ''}`, () => {
    it('commits the statements of a transaction together and rolls them back together on a failure', async () => {
      const { engine, db } = await engineFor(t);
      try {
        await db.query('clinic', `DROP TABLE ${T}`, []).catch(() => undefined);
        await db.query('clinic', `CREATE TABLE ${T} (visit_id VARCHAR(40) PRIMARY KEY, reason VARCHAR(80) NOT NULL)`, []);
        const ok = await runInTransaction(db, 'clinic', async () => {
          await exec(db, 'INSERT_TX_VISIT', { visit_id: 'V-1', reason: 'check-up' });
          await exec(db, 'INSERT_TX_VISIT', { visit_id: 'V-2', reason: 'x-ray' });
          // Inside the transaction its own rows are visible.
          return (await exec(db, 'TX_VISITS')).length;
        });
        expect(ok.committed).toBe(true);
        expect(ok.value).toBe(2);
        expect(ok.statements.map((s) => s.params)).toEqual([2, 2, 0]);
        const bad = await runInTransaction(db, 'clinic', async () => {
          await exec(db, 'INSERT_TX_VISIT', { visit_id: 'V-3', reason: 'dental' });
          await exec(db, 'INSERT_TX_VISIT', { visit_id: 'V-3', reason: 'the same id again' });
        });
        expect(bad.committed).toBe(false);
        expect(String((bad.error as Error).message)).not.toBe('');
        expect(bad.statements.length).toBe(1);
        const rows = await exec(db, 'TX_VISITS');
        expect(rows.map((r) => String(Object.values(r)[0]))).toEqual(['V-1', 'V-2']);
        // A transaction on the same alias cannot be opened inside another one.
        const nested = await runInTransaction(db, 'clinic', () => runInTransaction(db, 'clinic', async () => 1).then((o) => { if (o.error) throw o.error; }));
        expect(String((nested.error as Error).message)).toMatch(/already open/);
      } finally {
        await db.query('clinic', `DROP TABLE ${T}`, []).catch(() => undefined);
        await engine.close();
      }
    });
  });
}
