/**
 * UI coverage on the demo app, end to end with EZTest's own browser driver:
 * `eztest run --time-travel` records DOM snapshots; the coverage map lists
 * "Cancel order" as untested on /orders/:id; adding a journey that clicks it
 * raises coverage; the CLI report, the --min gate, the uiCoverage readiness
 * gate (citing the recorded ui-coverage evidence) and the a11y trend.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import { verifyEvidence, type RunResult } from '../../src/core/index.js';
import { loadUiCoverage, type UiCoverageReport } from '../../src/analytics/index.js';
import { copyShopProject, SHOP_ENV_KEYS } from '../studio/helpers.js';

let app: DemoServer;
let project: string;
const saved: Record<string, string | undefined> = {};

async function cli(args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd: project, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

async function lastRun(): Promise<{ run: RunResult; dir: string }> {
  const { readdir } = await import('node:fs/promises');
  const out = join(project, 'eztest-results');
  const runs = (await readdir(out)).filter((n) => n.startsWith('run-')).sort();
  const dir = join(out, runs[runs.length - 1]);
  return { run: JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult, dir };
}

beforeAll(async () => {
  project = await copyShopProject();
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = {
    SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db'), SHOP_ALICE_PASSWORD: 'Wonderland#1', SHOP_ALICE_TOTP: DEMO_TOTP_SECRET, SHOP_BOB_PASSWORD: 'Builder#2', SHOP_API_CLIENT_SECRET: 'ez-client-secret',
  };
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  // The coverage gate and the manual gate join the demo's readiness policy.
  await writeFile(join(project, 'readiness-policy.yaml'), 'version: 1\ngates:\n  noFailedCriticalJourneys: { minRisk: 4 }\n  uiCoverage: { min: 0.2, severity: risk }\n  noNewFailures: true\n');
});

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('UI coverage on the demo app', () => {
  let first: UiCoverageReport;

  it('records the map at analysis: Cancel order is untested on /orders/:id', async () => {
    const r = await cli(['run', '--time-travel', '--tags', 'orders']);
    expect(r.err).not.toMatch(/error:/);
    expect(r.out).toMatch(/UI coverage: \d+\/\d+ elements/);
    const { run, dir } = await lastRun();
    expect(run.journeys[0].status).toBe('passed');
    const rec = (await loadUiCoverage(dir))!;
    expect(rec.evidenceId).toMatch(/^E-\d+$/);
    expect((await verifyEvidence(dir)).ok).toBe(true);
    first = rec;
    const order = rec.pages.find((p) => p.route === '/orders/:id')!;
    expect(order).toBeTruthy();
    expect(order.elements.find((e) => e.label === 'Cancel order')).toMatchObject({ role: 'button', tested: false });
    expect(order.elements.find((e) => e.label === 'Download invoice')).toMatchObject({ role: 'link', tested: true });
    const neworder = rec.pages.find((p) => p.route === '/orders/new')!;
    expect(neworder.elements.filter((e) => e.tested).map((e) => e.label)).toEqual(expect.arrayContaining(['Product', 'Quantity', 'Submit order']));
    expect(neworder.elements.find((e) => e.label === 'Customer')).toMatchObject({ role: 'combobox', tested: false });
    // readiness cites the recorded map
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as { insights: { readiness: { gates: Array<{ gate: string; status: string; cites: { evidence: string[] } }> } } };
    const gate = report.insights.readiness.gates.find((g) => g.gate === 'uiCoverage')!;
    expect(gate.status, JSON.stringify(gate)).toBe("pass");
    expect(gate.cites.evidence).toEqual([rec.evidenceId]);

    const text = await cli(['coverage', 'ui']);
    expect(text.out).toMatch(/\/orders\/:id\s+\d+\/\d+/);
    expect(text.out).toMatch(/UNTESTED\s+button\s+Cancel order/);
    expect((await cli(['coverage', 'ui', '--min', '99'])).exitCode).toBe(1);
  }, 240_000);

  it('a journey that clicks Cancel order raises coverage', async () => {
    await writeFile(join(project, 'journeys', 'cancel-order.ez'), [
      'Journey: Cancel an order', 'Tags: @orders', 'Requirements: ORD-9', '', 'Log in as manager', 'Go to /orders/new', 'Click the "Submit order" button',
      '  Expect the page to contain "created"', 'Click the "Cancel order" button', '  Expect the page to contain "cancelled"', '',
    ].join('\n'));
    const r = await cli(['run', '--time-travel', '--tags', 'orders']);
    expect(r.err).not.toMatch(/error:/);
    const { run, dir } = await lastRun();
    expect(run.journeys.map((j) => [j.journeyId, j.status])).toEqual(expect.arrayContaining([['cancel-an-order', 'passed']]));
    const rec = (await loadUiCoverage(dir))!;
    const order = rec.pages.find((p) => p.route === '/orders/:id')!;
    expect(order.elements.find((e) => e.label === 'Cancel order')).toMatchObject({ tested: true, journeys: ['cancel-an-order'] });
    const before = first.pages.find((p) => p.route === '/orders/:id')!;
    expect(order.tested).toBeGreaterThan(before.tested);
    expect(rec.totals.percent).toBeGreaterThan(first.totals.percent);

    // the combined view: UI, requirements, risk (and no API data in this project)
    const json = JSON.parse((await cli(['coverage', '--json'])).out) as { combined: { dimensions: Array<{ id: string; status: string; covered: number; total: number }> }; ui: UiCoverageReport };
    const dims = Object.fromEntries(json.combined.dimensions.map((d) => [d.id, d]));
    expect(dims.ui.total).toBeGreaterThan(0);
    expect(dims.requirements.total).toBeGreaterThan(0);
    expect(dims.risk.covered).toBeGreaterThan(0);
    expect(json.ui.pages.find((p) => p.route === '/orders/:id')!.elements.find((e) => e.label === 'Cancel order')!.tested).toBe(true);

    // accessibility lens results (a11y:warn in the demo config) give a trend
    const a = await cli(['coverage', 'a11y']);
    expect(a.out).toMatch(/run-\S+\s+\d+ issue\(s\)/);
  }, 240_000);
});
