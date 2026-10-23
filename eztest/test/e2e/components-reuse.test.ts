/**
 * The add-ons' grids through the component interface: the Dynamics 365 UCI
 * view grid and the Salesforce lightning-datatable (inside an open shadow
 * root) answer the same plain-English grid phrasings, using the selectors the
 * D365 and Salesforce add-ons already rely on.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { startD365Mock, type D365MockServer } from '../../examples/d365-mock/server.js';
import { listUrl } from '../../examples/d365-mock/ui.js';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
import { loginWithPassword } from '../../src/salesforce/index.js';
import { componentEvidence, expectPasses } from './components-helpers.js';

let d365: D365MockServer;
let sf: SalesforceMockServer;
beforeAll(async () => {
  d365 = await startD365Mock();
  sf = await startSalesforceMock();
}, 60_000);
afterAll(async () => {
  await d365?.close();
  await sf?.close();
});

describe('add-on grids through the component adapters', () => {
  it('Dynamics 365: the view grid', async () => {
    const r = await expectPasses(d365.url, `
Journey: D365 view
Open ${listUrl('account')}
Expect the Active Accounts grid to have a row where Account Name is "Fabrikam Holdings"
Capture the Main Phone of the row where Account Name is "Fabrikam" in the Active Accounts grid as phone [id=read]
Expect \${phone} equals "555-0111"
Capture all rows of the Active Accounts grid as accounts
`);
    const ev = await componentEvidence(r, 'read');
    expect(ev.adapter).toBe('d365-grid');
    expect(ev.rowKey).toMatch(/^row-/);
  }, 120_000);

  it('Salesforce: the list view lightning-datatable (shadow DOM)', async () => {
    const r = await expectPasses(sf.url, `
Journey: Salesforce list view
Log in as admin
Open /lightning/o/Account/list?filterName=Recent
Expect the Recently Viewed grid to have 3 rows
Capture the Account Phone of the row where Account Name is "Initech" in the Recently Viewed grid as phone [id=read]
Expect \${phone} equals "555-0103"
In the Recently Viewed grid, click "Show actions for Globex" in the row where Account Name is "Globex"
`, { login: async (page) => {
      const res = await loginWithPassword(page, sf.url, sf.users.admin.username, sf.users.admin.password, 8000);
      if (!res.ok) throw new Error(res.error);
    } });
    const ev = await componentEvidence(r, 'read');
    expect(ev.adapter).toBe('lightning-datatable');
    expect(ev.rowKey).toBeTruthy();
  }, 120_000);
});
