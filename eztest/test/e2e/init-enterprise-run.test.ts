/**
 * What `eztest init --template enterprise` writes runs green: the scaffold, pointed at the small
 * application its README describes (test/e2e/fixtures/enterprise-sample-app.ts), passes
 * `eztest validate` and `eztest lint`, and `eztest run --project web -e dev` (the `npm test`
 * script) passes every sample: the .ez journey (one per data row of data/dev/orders.csv), the
 * Gherkin scenario with its step definitions and the shared step, and the code journey with its
 * screen model and API helper; each checks the database through the query catalogue, and the
 * report holds no verdict (readiness is opt-in). A second application added with --app validates too.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import type { RunResult } from '../../src/core/index.js';
import { startSampleApp, type SampleApp } from './fixtures/enterprise-sample-app.js';

const SQLITE = (() => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 23 || (maj === 23 && min >= 4) || (maj === 22 && min >= 13);
})();

async function cli(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => lines.push(s), err: (s) => lines.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: lines.join('\n'), code };
}

let project: string;
let app: SampleApp | undefined;
const ENV: Record<string, string> = {};
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!SQLITE) return;
  project = await mkdtemp(join(tmpdir(), 'eztest-enterprise-run-'));
  app = await startSampleApp({ dbFile: join(project, 'web.db'), username: 'clerk', password: 'Clerk#2026' });
  Object.assign(ENV, { WEB_BASE_URL: app.url, WEB_DB_FILE: join(project, 'web.db'), EZTEST_SECRET_WEB_CLERK_PASSWORD: 'Clerk#2026', EZTEST_ADO_ORG_URL: undefined, EZTEST_ADO_PROJECT: undefined });
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (project) await rm(project, { recursive: true, force: true }).catch(() => undefined);
});

describe('eztest init --template enterprise runs green', () => {
  it.skipIf(!SQLITE)('validate, lint, then npm test (run --project web -e dev): every sample passes, no verdict by default', async () => {
    const init = await cli(project, ['init', '--template', 'enterprise']);
    expect(init.code, init.out).toBe(0);

    const v = await cli(project, ['validate', '--project', 'web', '-e', 'dev']);
    expect(v.code, v.out).toBe(0);
    expect(v.out).toMatch(/place-order\.feature \(1 scenario; 4 steps with definitions, 1 EZTest phrasing\)/);

    const e = await cli(project, ['elements', 'unused', '--project', 'web', '-e', 'dev']);
    expect(e.code, e.out).toBe(0);
    expect(e.out).toMatch(/^0 unused elements$/m);

    const l = await cli(project, ['lint']);
    expect(l.code, l.out).toBe(0);
    expect(l.out).toMatch(/0 error\(s\), 0 warning\(s\), 0 info/);

    const r = await cli(project, ['run', '--project', 'web', '-e', 'dev']);
    const results = join(project, 'eztest-results');
    const runDir = join(results, (await readdir(results)).filter((d) => d.startsWith('run-')).sort().at(-1)!);
    const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunResult;
    const failed = run.journeys.filter((j) => j.status !== 'passed').map((j) => `${j.journeyId}: ${j.status} ${j.steps.find((s) => s.status === 'failed')?.error?.message ?? ''}`);
    expect(failed, r.out).toEqual([]);
    expect(r.code, r.out).toBe(0);
    expect(run.journeys.map((j) => j.journeyId).sort()).toEqual([
      'web-orders-order-from-api',
      'web-orders-place-order-bdd',
      'web-orders-place-order-bulk-order',
      'web-orders-place-order-small-order',
    ]);
    // Every sample stored its order; the journeys found them through the query catalogue.
    expect(app!.orders().map((o) => `${o.customer} x${o.quantity} = ${o.total}`).sort()).toEqual([
      'Contoso Ltd x2 = 25.00', 'Contoso Ltd x2 = 25.00', 'Contoso Ltd x2 = 25.00', 'Northwind Traders x40 = 500.00',
    ]);
    // No verdict by default: the report holds the results; a readiness policy is opt-in (eztest analyze --policy).
    const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as { insights: { readiness?: unknown } };
    expect(report.insights.readiness).toBeUndefined();

    // A second application: its own folder, project and scripts; both validate and the project still lints clean.
    const add = await cli(project, ['init', '--app', 'billing']);
    expect(add.code, add.out).toBe(0);
    expect(add.out).toMatch(/updated  eztest\.config\.yaml \(projects\.billing\)/);
    expect((await cli(project, ['validate', '--project', 'billing', '-e', 'dev'])).code).toBe(0);
    expect((await cli(project, ['validate', '--project', 'web', '-e', 'dev'])).code).toBe(0);
    const l2 = await cli(project, ['lint']);
    expect(l2.code, l2.out).toBe(0);
  }, 300_000);
});
