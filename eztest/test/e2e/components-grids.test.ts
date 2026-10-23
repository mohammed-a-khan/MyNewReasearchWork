/**
 * Grid component steps in real Chromium. The same .ez sentences run against
 * every grid library on the enterprise example app: real ag-Grid Community
 * and MUI X Data Grid, emulated Kendo / DevExtreme / PrimeNG / PrimeFaces /
 * Angular Material / Oracle JET / SAP UI5 DOM, and WAI-ARIA grids.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import type { EnterpriseApp } from '../../examples/enterprise-app/server.js';
import { componentEvidence, expectPasses, runEz, startApp, stepById } from './components-helpers.js';

let app: EnterpriseApp;
beforeAll(async () => {
  app = await startApp();
}, 120_000);
afterAll(async () => {
  await app?.close();
});

interface LibCase {
  lib: string;
  adapter: string;
  edit: boolean;
  sort: boolean;
  filter: boolean;
}

/** What each library offers (from its docs); the journey uses every capability the library has. */
const LIBS: LibCase[] = [
  { lib: 'kendo', adapter: 'kendo-grid', edit: true, sort: true, filter: true },
  { lib: 'devextreme', adapter: 'dx-data-grid', edit: true, sort: true, filter: true },
  { lib: 'primeng', adapter: 'primeng-table', edit: true, sort: true, filter: true },
  { lib: 'primefaces', adapter: 'primefaces-datatable', edit: false, sort: true, filter: false },
  { lib: 'material', adapter: 'mat-table', edit: true, sort: true, filter: true },
  { lib: 'jet', adapter: 'oj-table', edit: false, sort: true, filter: false },
  { lib: 'ui5', adapter: 'sap-m-table', edit: false, sort: false, filter: true },
  { lib: 'aria', adapter: 'aria-grid', edit: true, sort: true, filter: true },
];

function journey(c: LibCase): string {
  return [
    `Journey: Orders grid on ${c.lib}`,
    `Open /lib/${c.lib}?rows=60`,
    'In the Orders grid, click the row where Customer is "Fabrikam" and Status is "Open" [id=click-row]',
    'Expect the Orders grid to have 14 rows where Status is "Open" [id=count-open]',
    'Expect the Orders grid to have 60 rows',
    'Expect the Orders grid to have columns "Id", "Customer", "Region", "Status", "Amount" and "Order date" in this order',
    'Capture the Customer of the row where Id is "42" in the Orders grid as customer',
    'Expect ${customer} equals "Tailspin"',
    ...(c.edit ? ['Edit the Amount of the row where Id is "42" in the Orders grid to 150 [id=edit]', 'Expect the Amount of the row where Id is "42" in the Orders grid to be "150.00"'] : []),
    ...(c.sort ? ['Sort the Orders grid by Amount descending', 'Expect the Orders grid column Amount is sorted descending'] : []),
    'Capture all rows of the Orders grid as orders [id=read-all]',
    'Select the row where Id is "7" in the Orders grid [id=select]',
    ...(c.filter ? ['Filter the Orders grid where Region is "EU"', 'Expect the Orders grid to have 16 rows'] : []),
  ].join('\n');
}

describe('the same grid journey on every library', () => {
  it.each(LIBS)('$lib', { timeout: 240_000 }, async (c) => {
    const r = await expectPasses(app.url, journey(c));
    const click = await componentEvidence(r, 'click-row');
    expect(click.adapter).toBe(c.adapter);
    expect(click.row?.cells).toMatchObject({ Customer: 'Fabrikam', Status: 'Open' });
    expect(click.rowKey).toBeTruthy();
    const rows = stepById(r.j, 'read-all').captured?.orders as Array<Record<string, string>>;
    expect(rows).toHaveLength(60);
    expect(Object.keys(rows[0])).toEqual(['Id', 'Customer', 'Region', 'Status', 'Amount', 'Order date']);
    if (c.edit) {
      const e = await componentEvidence(r, 'edit');
      expect(e.verified).toMatch(/now shows "150\.00"/);
    }
  });
});

describe('real ag-Grid Community', () => {
  it('finds row 9,500 of 10,000 by value in the virtualized grid, edits it, and survives a column reorder', async () => {
    const r = await expectPasses(app.url, `
Journey: ag-Grid virtualization
Open /grid/aggrid
Click the row where Customer is "Zeta Logistics" in the Orders grid [id=find-9500 timeout=240s]
Click "Move Amount first"
Expect the Orders grid to have columns "Amount", "Customer" in this order
Edit the Amount of the first row where Id is "9500" in the Orders grid to 77 [id=edit-9500 timeout=240s]
Expect the Amount of the first row where Id is "9500" in the Orders grid to be "77.00" [timeout=240s]
Scroll the Orders grid to the first row where Id is "120"
`);
    const ev = await componentEvidence(r, 'find-9500');
    expect(ev.adapter).toBe('ag-grid');
    expect(ev.rowKey).toBe('9500');
    expect(ev.details).toMatchObject({ virtualized: true, scanned: 10_000 });
    console.log(`[perf] ag-Grid: strict find of row 9,500 by value scanned 10,000 rows in ${ev.ms} ms`);
  }, 600_000);

  it('reads all 10,000 virtualized rows within a bound and reports the timing', async () => {
    const r = await expectPasses(app.url, `
Journey: ag-Grid read all
Open /grid/aggrid
Capture all rows of the Orders grid as orders [id=read-all timeout=240s]
Expect the Orders grid to have 2498 rows where Status is "Open" [timeout=240s]
`);
    const ev = await componentEvidence(r, 'read-all');
    const rows = stepById(r.j, 'read-all').captured?.orders as Array<Record<string, string>>;
    expect(rows).toHaveLength(10_000);
    expect(rows[9499]).toMatchObject({ Id: '9500', Customer: 'Zeta Logistics' });
    const ms = Number(ev.details?.ms);
    console.log(`[perf] ag-Grid: read 10,000 virtualized rows in ${ms} ms`);
    // The bound is the step scan budget (the 240 s step timeout); the scan must finish inside it.
    expect(ms).toBeLessThan(240_000);
  }, 600_000);

  it('reads cells of off-screen columns (column virtualization)', async () => {
    const r = await expectPasses(app.url, `
Journey: ag-Grid wide
Open /grid/aggrid
Capture the Carrier of the row where Ref is "S-1150" in the Shipments grid as carrier
Expect \${carrier} equals "FedEx"
Expect the Shipments grid to have 50 rows where Carrier is "DHL"
`);
    expect(r.j.ledger.carrier).toBe('FedEx');
  }, 120_000);

  it('selects rows by values through the selection column and filters with the floating filter', async () => {
    await expectPasses(app.url, `
Journey: ag-Grid select and filter
Open /grid/aggrid?rows=500
Select the rows where Customer is "Contoso" and Status is "Open" in the Orders grid
Filter the Orders grid where Customer is "Wingtip"
Expect the Orders grid to have no rows where Customer is "Contoso"
`);
  }, 200_000);
});

describe('real MUI X Data Grid', () => {
  it('pages through 300 rows, edits, sorts and uses the toolbar quick filter', async () => {
    const r = await expectPasses(app.url, `
Journey: MUI grid
Open /mui
Click the row where Id is "250" in the Orders grid [id=find-250]
Expect the Orders grid to have 74 rows where Status is "Open"
Edit the Amount of the row where Id is "250" in the Orders grid to 99.5
Expect the Amount of the row where Id is "250" in the Orders grid to be "99.50"
Sort the Orders grid by Customer ascending
Filter the Orders grid where Region is "EU"
Expect the Orders grid to have a row where Id is "7"
`);
    const ev = await componentEvidence(r, 'find-250');
    expect(ev.adapter).toBe('mui-data-grid');
    expect(ev.details).toMatchObject({ page: 10, pages: 12 });
  }, 120_000);
});

describe('WAI-ARIA virtualized grid (10,000 rows)', () => {
  it('finds row 9,500 by value and keeps working after a column reorder', async () => {
    const r = await expectPasses(app.url, `
Journey: ARIA grid
Open /grid/aria
Click the first row where Customer is "Zeta Logistics" in the Orders grid [id=find timeout=240s]
Click "Move Amount first"
Expect the Orders grid to have columns "Amount", "Id" in this order
Edit the Amount of the first row where Id is "9500" in the Orders grid to 12.5 [timeout=240s]
Expect the Amount of the first row where Id is "9500" in the Orders grid to be "12.50" [timeout=240s]
`);
    const ev = await componentEvidence(r, 'find');
    expect(ev).toMatchObject({ adapter: 'aria-grid', rowKey: '9502' });
  }, 600_000);

  it('fails strictly: no row, several rows, unknown column', async () => {
    const none = await runEz(app.url, 'Journey: J\nOpen /lib/aria\nClick the row where Customer is "Nobody" in the Orders grid');
    expect(none.j.status).toBe('failed');
    expect(none.j.steps[1].error?.message).toMatch(/no row where Customer = "Nobody" \(read 60 rows/);
    const many = await runEz(app.url, 'Journey: J\nOpen /lib/aria\nClick the row where Status is "Open" in the Orders grid');
    expect(many.j.steps[1].error?.message).toMatch(/14 rows match where Status = "Open"/);
    const first = await expectPasses(app.url, 'Journey: J\nOpen /lib/aria\nClick the first row where Status is "Open" in the Orders grid');
    expect(first.j.status).toBe('passed');
    const col = await runEz(app.url, 'Journey: J\nOpen /lib/aria\nClick the row where Colour is "Red" in the Orders grid');
    expect(col.j.steps[1].error?.message).toMatch(/no column "Colour" \(columns: "Id", "Customer"/);
  }, 120_000);
});
