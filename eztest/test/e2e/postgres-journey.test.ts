/**
 * End to end against a REAL PostgreSQL server: the example project
 * (examples/postgres-project) creates and seeds a fictional customer ledger,
 * then `eztest validate`, `queries list|check`, `doctor` and `run` execute
 * journeys that call the EZ Shop API, drive the UI, and cross-check both
 * against PostgreSQL through catalogue queries (named binds, casts, a
 * fragment), with one journey run per row of a query (Examples: from query).
 * A ledger that lacks a table the journeys use is triaged as an environment
 * problem (db-schema-missing), not a product bug.
 *
 * Skipped unless EZTEST_PG_URL is set and the pg driver loads (installed, or
 * EZTEST_PG_DRIVER); docs/databases.md.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import type { RunResult } from '../../src/core/index.js';
import { PostgresDbClient } from '../../src/surfaces/index.js';
import { loadRunArtifacts, triageRun } from '../../src/insights/index.js';
import { PG_SKIP, announceSkip, pgDriverAvailable, pgEnv } from '../surfaces/db-env.js';

const pg = pgEnv();
const on = !!pg && (await pgDriverAvailable());
announceSkip(on, PG_SKIP);
const EXAMPLE = resolve(__dirname, '../../examples/postgres-project');

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

async function lastRun(project: string): Promise<{ run: RunResult; dir: string }> {
  const root = join(project, 'eztest-results');
  const dirs = (await readdir(root)).sort();
  const dir = join(root, dirs[dirs.length - 1]);
  return { run: JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult, dir };
}

async function setupLedger(db: PostgresDbClient, file: string): Promise<void> {
  const text = (await readFile(file, 'utf8')).replace(/^\s*--[^\n]*$/gm, '');
  for (const s of text.split(/;\s*$/m).map((x) => x.trim()).filter(Boolean)) await db.execute(s);
}

describe.skipIf(!on)(`PostgreSQL end to end (examples/postgres-project)${on ? '' : ` - ${PG_SKIP}`}`, () => {
  let app: DemoServer;
  let project: string;
  let db: PostgresDbClient;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'eztest-pg-'));
    await cp(EXAMPLE, project, { recursive: true });
    app = await startDemoApp({ dbFile: join(project, 'shop.db') });
    const env: Record<string, string> = {
      SHOP_URL: app.url, SHOP_BOB_PASSWORD: 'Builder#2', SHOP_API_CLIENT_SECRET: 'ez-client-secret', SHOP_PG_PASSWORD: pg!.password,
      PG_HOST: pg!.host, PG_PORT: String(pg!.port), PG_DATABASE: pg!.database, PG_USER: pg!.user,
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    db = await PostgresDbClient.connect({ connectionString: pg!.connectionString });
    await setupLedger(db, join(project, 'setup.sql'));
  });

  afterAll(async () => {
    await db?.execute('DROP TABLE IF EXISTS ezt_ledger_customers, ezt_ledger_products').catch(() => undefined);
    await db?.close();
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('validates journeys, lists and checks the catalogue against the live database, and doctor connects', async () => {
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.err).toEqual([]);
    expect(v.exitCode).toBe(0);
    const list = await cli(project, ['queries', 'list']);
    expect(list.out.join('\n')).toMatch(/CUSTOMERS_BY_REGION\s+ledger\s+\(region, min_limit=0\) Active customers/);
    const check = await cli(project, ['queries', 'check']);
    expect(check.err).toEqual([]);
    expect(check.exitCode).toBe(0);
    expect(check.out.at(-1)).toMatch(/8 checked: 8 ok, 0 error\(s\), 0 skipped/);
    await writeFile(join(project, 'queries', 'BROKEN.sql'), '-- connection: ledger\nSELECT customer_nmae FROM ezt_ledger_customers WHERE region = :region\n');
    const broken = await cli(project, ['queries', 'check', '--json']);
    expect(broken.exitCode).toBe(1);
    expect(JSON.parse(broken.out.join('\n')).find((r: { name: string }) => r.name === 'BROKEN')).toMatchObject({ status: 'error', message: expect.stringMatching(/column "customer_nmae" does not exist/) });
    await rm(join(project, 'queries', 'BROKEN.sql'));
    const doc = await cli(project, ['doctor']);
    expect(doc.out.join('\n')).toMatch(/db ledger\s+postgres ok \(\d+ ms\) PostgreSQL 1\d/);
  });

  it('runs the journeys: API and UI cross-checked against PostgreSQL, one run per query row', async () => {
    const r = await cli(project, ['run', 'journeys']);
    const { run } = await lastRun(project);
    const failed = run.journeys.flatMap((j) => j.steps.filter((s) => s.status !== 'passed').map((s) => `${j.name}: ${s.intent}: ${s.error?.message ?? s.status}`));
    expect(failed).toEqual([]);
    expect(r.exitCode).toBe(0);
    // ledger-matches-shop once, orders-per-customer once per EU customer (Contoso, Northwind)
    expect(run.journeys).toHaveLength(3);
    const perCustomer = run.journeys.filter((j) => j.name.startsWith('An order for each EU ledger customer'));
    expect(perCustomer).toHaveLength(2);
    expect(perCustomer.every((j) => j.status === 'passed')).toBe(true);
    const compare = perCustomer[0].steps.find((s) => s.intent.startsWith('Compare'));
    expect(compare?.status).toBe('passed');
  });

  it('a changed ledger value makes the UI <-> DB and API <-> DB comparisons fail cell by cell', async () => {
    await db.execute("UPDATE ezt_ledger_products SET unit_price = 49.95 WHERE sku = 'SKU-200'");
    await db.execute('UPDATE ezt_ledger_customers SET credit_limit = 26000 WHERE customer_id = 1');
    try {
      const r = await cli(project, ['run', 'journeys']);
      expect(r.exitCode).toBe(1);
      const { run } = await lastRun(project);
      const steps = run.journeys.flatMap((j) => j.steps.filter((s) => s.intent.startsWith('Compare')));
      expect(steps.every((s) => s.status === 'failed')).toBe(true);
      const msgs = steps.map((s) => s.error?.message ?? '');
      // API <-> DB: one cell (Contoso's credit limit); UI <-> DB: two cells per order (Unit Price, Line Total)
      expect(msgs).toEqual([expect.stringMatching(/3 compared, 2 matched.*1 cell mismatches/), expect.stringMatching(/1 compared, 0 matched.*2 cell mismatches/), expect.stringMatching(/1 compared, 0 matched.*2 cell mismatches/)]);
    } finally {
      await db.execute("UPDATE ezt_ledger_products SET unit_price = 49.50 WHERE sku = 'SKU-200'");
      await db.execute('UPDATE ezt_ledger_customers SET credit_limit = 25000 WHERE customer_id = 1');
    }
  });

  it('a ledger without the table the journey uses is triaged as an environment problem (schema missing)', async () => {
    await db.execute('ALTER TABLE ezt_ledger_customers RENAME TO ezt_ledger_customers_moved');
    try {
      const r = await cli(project, ['run', 'journeys', '--grep', 'matches the shop']);
      expect(r.exitCode).toBe(1);
      const { run, dir } = await lastRun(project);
      const j = run.journeys.find((x) => x.name.includes('matches the shop'))!;
      const failed = j.steps.find((s) => s.status === 'failed')!;
      expect(failed.error?.message).toMatch(/relation "ezt_ledger_customers" does not exist/);
      const v = triageRun(await loadRunArtifacts(dir)).verdicts.find((x) => x.journeyId === j.journeyId)!;
      expect(v.category).toBe('environment');
      expect(v.winner?.rule).toBe('db-schema-missing');
    } finally {
      await db.execute('ALTER TABLE ezt_ledger_customers_moved RENAME TO ezt_ledger_customers');
    }
  });
});
