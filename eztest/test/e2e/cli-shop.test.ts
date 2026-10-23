/**
 * End-to-end: the real `eztest run` command against the EZ Shop demo app using
 * the example project (identity with MFA, data, API, DB, documents, lenses,
 * triage, readiness and reports all wired through config).
 */
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer, type DemoOptions } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import { verifyEvidence, type RunResult } from '../../src/core/index.js';

const EXAMPLE = resolve(__dirname, '../../examples/shop-project');

interface CliRun {
  out: string[];
  err: string[];
  exitCode: number;
}

async function cli(cwd: string, args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env })
    .exitOverride()
    .parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out, err, exitCode };
}

async function latestRun(project: string): Promise<{ dir: string; run: RunResult }> {
  const root = join(project, 'eztest-results');
  const dirs = (await readdir(root)).sort();
  const dir = join(root, dirs[dirs.length - 1]);
  return { dir, run: JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult };
}

describe('eztest run (end to end, example shop project)', () => {
  let app: DemoServer | undefined;
  let project: string;
  const saved: Record<string, string | undefined> = {};

  async function start(opts: DemoOptions = {}) {
    project = await mkdtemp(join(tmpdir(), 'eztest-shop-'));
    await cp(EXAMPLE, project, { recursive: true });
    app = await startDemoApp({ ...opts, dbFile: join(project, 'shop.db') });
    const env: Record<string, string> = {
      SHOP_URL: app.url,
      SHOP_DB: join(project, 'shop.db'),
      SHOP_ALICE_PASSWORD: 'Wonderland#1',
      SHOP_ALICE_TOTP: DEMO_TOTP_SECRET,
      SHOP_BOB_PASSWORD: 'Builder#2',
      SHOP_API_CLIENT_SECRET: 'ez-client-secret',
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('validates, runs every journey green, writes reports and a valid evidence chain', async () => {
    await start();
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.exitCode).toBe(0);

    const r = await cli(project, ['run']);
    const { dir, run } = await latestRun(project);
    const text = r.out.join('\n');
    expect(run.summary).toMatchObject({ total: 3, failed: 0, errors: 0 });
    expect(r.exitCode).toBe(0);
    expect(text).toMatch(/readiness: GO/);
    for (const f of ['report.html', 'report.json', 'junit.xml']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const order = run.journeys.find((j) => j.name.startsWith('Create an order'))!;
    const check = order.ledger.invoiceCheck as { status: string; fields: Array<{ name: string; verdict: string }> };
    expect(check.status).toBe('PASS');
    expect(check.fields.every((f) => f.verdict === 'ALL_AGREE')).toBe(true);
    const ev = await cli(project, ['evidence', 'verify', dir]);
    expect(ev.out.join('\n')).toMatch(/^VALID/);
  });

  it('catches a document-generation defect three ways and fails the run (NO_GO)', async () => {
    await start({ bug: 'invoice-total' });
    const r = await cli(project, ['run', '--tags', 'orders']);
    const { run } = await latestRun(project);
    expect(r.exitCode).toBe(1);
    const order = run.journeys[0];
    expect(order.status).toBe('failed');
    const step = order.steps.find((s) => s.intent.startsWith('Compare document'))!;
    expect(step.status).toBe('failed');
    const report = await readFile(join((await latestRun(project)).dir, 'report.json'), 'utf8');
    expect(report).toContain('document generation defect');
    expect(r.out.join('\n')).toMatch(/readiness: NO_GO/);
  });

  it('heals renamed UI (variant b) as verified passed-healed steps with proposals', async () => {
    await start();
    expect((await cli(project, ['run', '--tags', 'orders'])).exitCode).toBe(0);
    await app!.close();
    app = await startDemoApp({ variant: 'b', dbFile: join(project, 'shop.db') });
    process.env.SHOP_URL = app.url;
    const r = await cli(project, ['run', '--tags', 'orders']);
    const { dir, run } = await latestRun(project);
    if (run.journeys[0].status !== 'passed-healed') {
      console.log(JSON.stringify(run.journeys[0].steps.map((s) => ({ i: s.intent, st: s.status, e: s.error?.message, h: s.heal, u: s.usedLocator })), null, 1));
    }
    expect(run.journeys[0].status).toBe('passed-healed');
    expect(r.exitCode).toBe(0);
    const proposals = JSON.parse(await readFile(join(dir, 'heal-proposals.json'), 'utf8')) as { proposals: unknown[] };
    expect(proposals.proposals.length).toBeGreaterThan(0);
    expect(r.out.join('\n')).toMatch(/healed via T\d/);
  });
});
