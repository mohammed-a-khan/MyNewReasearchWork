/**
 * End to end against a REAL Oracle database: the example project
 * (examples/oracle-project) creates and seeds a fictional customer ledger,
 * then `eztest validate`, `queries list|check`, `doctor` and `run` execute a
 * journey that calls the EZ Shop API, logs in to the UI, and cross-checks
 * both against Oracle through catalogue queries. The Studio workbench's SQL
 * console and Queries panel are exercised on the same connection.
 *
 * Skipped unless EZTEST_ORACLE_URL is set (docs/databases.md).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import type { RunResult } from '../../src/core/index.js';
import { OracleDbClient } from '../../src/surfaces/index.js';
import { startStudio } from '../../src/studio/index.js';
import { ORACLE_SKIP, announceSkip, oracleEnv } from '../surfaces/db-env.js';
import { client } from '../studio/helpers.js';

const ora = oracleEnv();
announceSkip(!!ora, ORACLE_SKIP);
const EXAMPLE = resolve(__dirname, '../../examples/oracle-project');

async function cli(cwd: string, args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out, err, exitCode };
}

/** Run examples/oracle-project/setup.sql ("/" separates statements). */
async function setupLedger(db: OracleDbClient, file: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  const statements = text
    .split(/^\/\s*$/m)
    .map((s) => s.replace(/^(?:\s*--[^\n]*\n)+/, '').trim())
    .filter(Boolean);
  for (const s of statements) {
    if (/^commit$/i.test(s)) continue;
    await db.execute(s);
  }
}

describe.skipIf(!ora)(`Oracle end to end (examples/oracle-project)${ora ? '' : ` - ${ORACLE_SKIP}`}`, () => {
  let app: DemoServer;
  let project: string;
  let db: OracleDbClient;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'eztest-oracle-'));
    await cp(EXAMPLE, project, { recursive: true });
    app = await startDemoApp({ dbFile: join(project, 'shop.db') });
    const env: Record<string, string> = {
      SHOP_URL: app.url,
      SHOP_BOB_PASSWORD: 'Builder#2',
      SHOP_API_CLIENT_SECRET: 'ez-client-secret',
      SHOP_ORACLE_PASSWORD: ora!.password,
      ORACLE_HOST: ora!.host,
      ORACLE_SERVICE: ora!.serviceName,
      ORACLE_USER: ora!.user,
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    db = await OracleDbClient.connect({ ...ora! });
    await setupLedger(db, join(project, 'setup.sql'));
  });

  afterAll(async () => {
    await db?.execute('DROP TABLE ezt_ledger_customers PURGE').catch(() => undefined);
    await db?.close();
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('validates journeys, including catalogue references and params', async () => {
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.err).toEqual([]);
    expect(v.exitCode).toBe(0);
    await writeFile(join(project, 'journeys', 'broken.ez'), 'Journey: Broken refs\nRun query "CUSTOMERS_BY_REGION" on ledger with colour="red" as x\nRun query "NO_SUCH_QUERY" on ledger as y\n');
    const bad = await cli(project, ['validate', 'journeys']);
    expect(bad.exitCode).toBe(1);
    expect(bad.err.join('\n')).toContain('query "CUSTOMERS_BY_REGION" needs param "region"');
    expect(bad.err.join('\n')).toContain('has no param "colour"');
    expect(bad.err.join('\n')).toContain('Unknown query "NO_SUCH_QUERY"');
    await writeFile(join(project, 'journeys', 'broken.ez'), '');
    await (await import('node:fs/promises')).rm(join(project, 'journeys', 'broken.ez'));
  });

  it('lists and checks the catalogue against the live database, and doctor connects', async () => {
    const list = await cli(project, ['queries', 'list']);
    expect(list.out.join('\n')).toMatch(/CUSTOMERS_BY_REGION\s+ledger\s+\(region, min_limit=0\) Active customers/);
    expect(list.out.join('\n')).toContain('LEDGER_CUSTOMER_COUNT');
    const check = await cli(project, ['queries', 'check']);
    expect(check.err).toEqual([]);
    expect(check.exitCode).toBe(0);
    expect(check.out.at(-1)).toMatch(/6 checked: 6 ok, 0 error\(s\), 0 skipped/);
    // A broken query is caught by `check` (and fails it), without running anything.
    await writeFile(join(project, 'queries', 'BROKEN.sql'), '-- connection: ledger\nSELECT customer_nmae FROM ezt_ledger_customers WHERE region = :region\n');
    const broken = await cli(project, ['queries', 'check', '--json']);
    expect(broken.exitCode).toBe(1);
    expect(JSON.parse(broken.out.join('\n')).find((r: { name: string }) => r.name === 'BROKEN')).toMatchObject({ status: 'error', message: expect.stringMatching(/ORA-00904: "CUSTOMER_NMAE"/) });
    await (await import('node:fs/promises')).rm(join(project, 'queries', 'BROKEN.sql'));
    const doc = await cli(project, ['doctor']);
    expect(doc.out.join('\n')).toMatch(/db ledger\s+oracle ok \(\d+ ms\) \d+\.\d+.*\[thin mode, pool \d\/4\]/);
    expect(doc.out.join('\n')).toMatch(/queries\s+6 queries, 1 fragments/);
  });

  it('runs the journey: API and UI cross-checked against Oracle', async () => {
    const r = await cli(project, ['run', 'journeys']);
    const root = join(project, 'eztest-results');
    const dirs = (await readdir(root)).sort();
    const run = JSON.parse(await readFile(join(root, dirs[dirs.length - 1], 'run.json'), 'utf8')) as RunResult;
    const j = run.journeys[0];
    const failed = j.steps.filter((s) => s.status !== 'passed');
    expect(failed.map((s) => `${s.intent}: ${s.error?.message ?? s.status}`)).toEqual([]);
    expect(j.status).toBe('passed');
    expect(r.exitCode).toBe(0);
    expect(j.steps.length).toBe(11); // "Expect ${x} ..." lines attach to the step before; "Expect query ..." lines are steps
  });

  it('a changed ledger row makes the API <-> DB comparison fail with the cell named', async () => {
    await db.execute("UPDATE ezt_ledger_customers SET credit_limit = 26000 WHERE customer_id = 1");
    try {
      const r = await cli(project, ['run', 'journeys']);
      expect(r.exitCode).toBe(1);
      const root = join(project, 'eztest-results');
      const dirs = (await readdir(root)).sort();
      const run = JSON.parse(await readFile(join(root, dirs[dirs.length - 1], 'run.json'), 'utf8')) as RunResult;
      const cmp = run.journeys[0].steps.find((s) => s.intent.startsWith('Compare'));
      expect(cmp?.status).toBe('failed');
      expect(cmp?.error?.message).toMatch(/1 cell mismatches/);
    } finally {
      await db.execute('UPDATE ezt_ledger_customers SET credit_limit = 25000 WHERE customer_id = 1');
    }
  });

  it('Studio workbench: Oracle SQL console is read-only by default and the Queries panel runs catalogue queries', async () => {
    const studio = await startStudio({ cwd: project, watch: false, env: { ...process.env, EZTEST_MASTER_KEY: undefined } });
    try {
      const c = client(studio.port, studio.token);
      const ctx = (await c.get('/api/workbench/context')).json();
      expect(ctx.connections).toEqual([{ name: 'ledger', driver: 'oracle' }]);
      const read = (await c.post('/api/workbench/sql', { connection: 'ledger', sql: 'SELECT customer_name FROM ezt_ledger_customers WHERE region = :1 ORDER BY customer_id', params: ['EU'] })).json();
      expect(read).toMatchObject({ kind: 'read', enforced: 'READ ONLY transaction (rolled back)', columns: ['CUSTOMER_NAME'], rows: [{ CUSTOMER_NAME: 'Contoso Ltd' }, { CUSTOMER_NAME: 'Northwind Traders' }] });
      // writes are blocked by the console; a write hidden from the classifier would still hit READ ONLY
      const blocked = await c.post('/api/workbench/sql', { connection: 'ledger', sql: "UPDATE ezt_ledger_customers SET region = 'XX'" });
      expect(blocked.status).toBe(403);
      expect((await c.post('/api/workbench/sql', { connection: 'ledger', sql: 'BEGIN DELETE FROM ezt_ledger_customers; END;' })).status).toBe(403);
      // the write toggle works as before (enable + confirm)
      expect((await c.post('/api/workbench/sql/mode', { allowWrites: true, confirm: true })).json().writesEnabled).toBe(true);
      const w = (await c.post('/api/workbench/sql', { connection: 'ledger', sql: "UPDATE ezt_ledger_customers SET notes = 'touched' WHERE customer_id = 2", confirm: true })).json();
      expect(w).toMatchObject({ kind: 'write', rowsAffected: 1 });
      await c.post('/api/workbench/sql/mode', { allowWrites: false });

      const list = (await c.get('/api/workbench/queries')).json();
      expect(list.queries.map((q: { name: string }) => q.name)).toContain('CUSTOMERS_BY_REGION');
      const byRegion = list.queries.find((q: { name: string }) => q.name === 'CUSTOMERS_BY_REGION');
      expect(byRegion).toMatchObject({ connection: 'ledger', params: [{ name: 'region', type: 'any' }, { name: 'min_limit', type: 'number', default: 0 }] });
      expect(byRegion.sql).toContain("AND c.status = 'ACTIVE'");
      const ran = (await c.post('/api/workbench/queries/run', { name: 'CUSTOMERS_BY_REGION', binds: { region: '${r}', min_limit: '20000' }, variables: { r: 'EU' } })).json();
      expect(ran).toMatchObject({ kind: 'read', query: 'CUSTOMERS_BY_REGION', connection: 'ledger', rowCount: 1, rows: [{ CUSTOMER_ID: 1, CUSTOMER_NAME: 'Contoso Ltd', CREDIT_LIMIT: 25000 }] });
      expect((await c.post('/api/workbench/queries/run', { name: 'CUSTOMERS_BY_REGION', binds: {} })).status).toBe(400);
      const step = (await c.post('/api/workbench/step', { kind: 'query', query: 'CUSTOMERS_BY_REGION', connection: 'ledger', binds: { region: 'EU' }, captureAs: 'eu', assertions: [{ type: 'rows', value: 2 }] })).json();
      expect(step).toMatchObject({ ok: true, lines: ['Run query "CUSTOMERS_BY_REGION" on ledger with region="EU" and store the rows as eu', 'Expect the query eu returns 2 rows'] });
    } finally {
      await studio.close();
    }
  });
});
