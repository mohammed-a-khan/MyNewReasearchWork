/**
 * Root cause of the flaky "checks related lists and list views" test: "Create
 * a new <object>" and the access check read the list view's New button right
 * after the URL said "list view", before Lightning had rendered the header,
 * and so reported "No New button" whenever the page was slow. They now wait
 * for the header. This mock renders the header late on purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { parseSalesforceEzScript } from '../../src/salesforce/index.js';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
import { runSf, stepLines } from './fixtures.js';

let mock: SalesforceMockServer;
beforeAll(async () => {
  mock = await startSalesforceMock({ listHeaderDelayMs: 900 });
});
afterAll(async () => {
  await mock?.close();
});

describe('a slow list view header', () => {
  it('"Create a new" waits for the header and its New button instead of failing on an empty header', async () => {
    const js = ['Account', 'Opportunity'].map((o) => parseSalesforceEzScript(`Journey: Slow org ${o}\nId: slow-${o.toLowerCase()}\nLog in to Salesforce as admin\nCreate a new ${o}\n`));
    const run = await runSf(mock, js);
    for (const i of [0, 1]) expect(stepLines(run, i)).toEqual(run.journeys[i].steps.map((s) => `${s.stepId}:passed`));
  });
});
