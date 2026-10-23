/**
 * End to end: code journeys (*.journey.ts, eztest/sdk) discovered and run by
 * `eztest run` against the EZ Shop demo app, side by side with .ez journeys.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyEvidence } from '../../src/core/index.js';
import { byId, cli, flat, latestRun, shopProject, tree } from './helpers.js';

let restore: (() => Promise<void>) | undefined;
afterEach(async () => {
  await restore?.();
  restore = undefined;
});

describe('code journeys through eztest run (real Chromium, demo app)', () => {
  it('loops over DB rows with if/switch, nested steps, files and dates; evidence chain holds', async () => {
    const p = await shopProject();
    restore = p.restore;
    const v = await cli(p.project, ['validate', 'journeys']);
    expect(v.err.join('\n')).toBe('');
    expect(v.out.join('\n')).toMatch(/orders\.journey\.ts \(4 code journeys/);

    const r = await cli(p.project, ['run', '--grep', 'orders-per-customer']);
    const { dir, run } = await latestRun(p.project);
    const j = byId(run, 'orders-per-customer');
    expect(j.status, tree(j.steps)).toBe('passed');
    expect(r.exitCode).toBe(0);
    expect(j.tags).toEqual(['sdk', 'orders']);
    expect(j.requirements).toEqual(['REQ-SDK-1']);
    expect(j.risk).toBe(4);
    // Top level: Sign in, the query, the count check, one group per EU customer, the export step.
    const top = j.steps.map((s) => s.intent);
    expect(top[0]).toBe('Sign in');
    expect(top).toContain('Order for Contoso Ltd');
    expect(top).toContain('Order for Northwind Traders');
    expect(top.some((t) => t.startsWith('Run query CUSTOMERS_BY_REGION'))).toBe(true);
    const contoso = j.steps.find((s) => s.intent === 'Order for Contoso Ltd')!;
    expect(contoso.children!.map((c) => c.intent)).toEqual([
      'Open /orders/new',
      'Select "Contoso Ltd" from Customer',
      'Select "Gadget (49.50)" from Product',
      'Type "3" into Quantity',
      'Click Submit order button',
      'Read the text of testid=order-number',
      'Expect the text of testid=order-customer to be "Contoso Ltd"',
    ]);
    // switch: Northwind (12000) gets a Widget, qty 1.
    const nw = j.steps.find((s) => s.intent === 'Order for Northwind Traders')!;
    expect(nw.children!.map((c) => c.intent)).toContain('Select "Widget (19.99)" from Product');
    expect(nw.children!.map((c) => c.intent)).toContain('Type "1" into Quantity');
    // Step ids come from source lines; call sites are kept.
    const click = contoso.children!.find((c) => c.intent.startsWith('Click'))!;
    expect(click.stepId).toMatch(/^L\d+$/);
    // Files and dates.
    expect(existsSync(join(p.project, 'out', 'created-orders.csv'))).toBe(true);
    const csv = await readFile(join(p.project, 'out', 'created-orders.csv'), 'utf8');
    expect(csv).toContain('Contoso Ltd');
    expect(csv).toContain('2026-10-28');
    expect(j.ledger.createdCount).toBe(2);
    // The database really has the orders.
    const n = (p.app.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_by = 'bob'").get() as { n: number }).n;
    expect(n).toBe(2);
    expect((await verifyEvidence(dir)).ok).toBe(true);
    const junit = await readFile(join(dir, 'junit.xml'), 'utf8');
    expect(junit).toContain('Order for every EU customer');
  });

  it('soft assertions record failures with evidence and the journey fails at the end; code errors point at the line', async () => {
    const p = await shopProject();
    restore = p.restore;
    const r = await cli(p.project, ['run', '--tags', 'negative']);
    expect(r.exitCode).toBe(1);
    const { run } = await latestRun(p.project);
    const soft = byId(run, 'soft-and-error');
    expect(soft.status, tree(soft.steps)).toBe('failed');
    const all = flat(soft.steps);
    const two = all.find((s) => s.intent.startsWith('Expect two to be'))!;
    expect(two.status).toBe('failed');
    expect(two.soft).toBe(true);
    expect(two.evidence.length).toBeGreaterThan(0);
    expect(two.error?.message).toMatch(/expected two to be 3/);
    expect(all.find((s) => s.intent.startsWith('Expect the page to contain'))!.status).toBe('passed');
    // The journey went on after the soft failures.
    expect(all.at(-1)!.intent).toMatch(/^Type "still running/);
    expect(all.at(-1)!.status).toBe('passed');

    const thrown = byId(run, 'throws');
    expect(thrown.status).toBe('failed');
    const err = thrown.steps.at(-1)!;
    expect(err.intent).toMatch(/^Code error at orders\.journey\.ts:\d+$/);
    expect(err.error?.message).toBe('business rule violated: n > 1');
    expect(err.evidence.length).toBe(1);
  });

  it('interop: code runs an .ez library journey, and .ez runs a code step', async () => {
    const p = await shopProject();
    restore = p.restore;
    const r = await cli(p.project, ['run', '--tags', 'interop']);
    const { run } = await latestRun(p.project);
    const c2e = byId(run, 'code-calls-ez');
    expect(c2e.status, tree(c2e.steps)).toBe('passed');
    const sub = c2e.steps.find((s) => s.intent.startsWith('Run journey "login-as"'))!;
    expect(sub.children!.length).toBeGreaterThanOrEqual(5);
    const e2c = byId(run, 'ez-calls-code');
    expect(e2c.status, tree(e2c.steps)).toBe('passed');
    const code = e2c.steps.find((s) => s.intent.startsWith('Run code'))!;
    expect(code.captured?.totals).toEqual({ count: 2, first: 'Contoso Ltd' });
    expect(code.children!.map((c) => c.intent)).toContain('Check the dashboard');
    expect(e2c.ledger.checkedBy).toBe('code');
    expect(r.exitCode).toBe(0);
  });
});
