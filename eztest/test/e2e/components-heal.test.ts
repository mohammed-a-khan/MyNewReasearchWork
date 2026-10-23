/**
 * Healing component steps: version 2 of the page renames the grid ("Orders"
 * becomes "Customer orders"), changes its classes, test id and heading, so
 * none of the step's locators resolve. The component tier finds the grid that
 * holds the row named by its cell values, and the runner accepts the heal
 * only because the step's own verification (row found by values, edit read
 * back) holds. A row that is gone is never "healed" onto another one.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createHealer } from '../../src/heal/index.js';
import type { EnterpriseApp } from '../../examples/enterprise-app/server.js';
import { componentEvidence, runEz, startApp, stepById, describeSteps } from './components-helpers.js';

let app: EnterpriseApp;
beforeAll(async () => {
  app = await startApp();
}, 120_000);
afterAll(async () => {
  await app?.close();
});

const JOURNEY = `
Journey: Heal grid
Id: heal-grid
Open /heal?v=\${v}
In the Orders grid, click the row where Customer is "Proseware" and Id is "1500" [id=pick]
Edit the Amount of the row where Id is "1500" in the Orders grid to 42 [id=edit]
Expect the Amount of the row where Id is "1500" in the Orders grid to be "42.00" [id=check]
`;

describe('component healing', () => {
  it('heals a renamed, restyled grid by finding the row by its values, verified by the read-back', async () => {
    const base = await mkdtemp(join(tmpdir(), 'eztest-heal-'));
    const outputDir = join(base, 'results');
    const healer = createHealer();
    const v1 = await runEz(app.url, JOURNEY, { outputDir, healer, variables: { v: '1' } });
    expect(v1.j.status, describeSteps(v1.j)).toBe('passed');

    const v2 = await runEz(app.url, JOURNEY, { outputDir, healer, variables: { v: '2' } });
    expect(v2.j.status, describeSteps(v2.j)).toBe('passed-healed');
    const pick = stepById(v2.j, 'pick');
    expect(pick.status).toBe('passed-healed');
    expect(pick.heal).toMatchObject({ tier: 'T2-semantic', verified: true });
    expect(pick.heal?.reason).toMatch(/component grid: .*holds the row where Customer equals "Proseware" and Id equals "1500"/);
    expect(pick.heal?.reason).toMatch(/row where Customer = "Proseware" and Id = "1500" found by its values/);
    expect(pick.usedLocator).toEqual({ strategy: 'testId', value: 'orders-table-v2' });
    // The edit and its check heal the same way and are verified by reading the cell back.
    expect(stepById(v2.j, 'edit').heal?.reason).toMatch(/now shows "42\.00"/);
    const ev = await componentEvidence(v2, 'edit');
    expect(ev).toMatchObject({ adapter: 'aria-grid', rowKey: '1502' });
    expect(ev.row?.cells).toMatchObject({ Id: '1500', Customer: 'Proseware' });
  }, 240_000);

  it('does not heal onto another row: a missing row fails the step', async () => {
    const outputDir = join(await mkdtemp(join(tmpdir(), 'eztest-heal-')), 'results');
    const healer = createHealer();
    const r = await runEz(app.url, `
Journey: Heal missing
Open /heal?v=2
Click the row where Id is "999999" in the Orders grid
`, { outputDir, healer });
    expect(r.j.status).toBe('failed');
    expect(r.j.steps[1].status).toBe('failed');
    expect(r.j.steps[1].heal).toBeUndefined();
    expect(r.j.steps[1].error?.message).toMatch(/healing found no candidate.*T2-component: .*confidence|healing found no candidate/);
  }, 120_000);

  it('without a healer the renamed grid fails with every candidate it tried', async () => {
    const r = await runEz(app.url, 'Journey: J\nOpen /heal?v=2\nClick the row where Id is "1500" in the Orders grid');
    expect(r.j.steps[1].error?.message).toMatch(/no locator candidate matched exactly one element for the Orders grid \(role=grid "Orders": no match/);
  }, 60_000);
});
