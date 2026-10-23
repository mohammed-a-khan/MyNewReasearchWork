/**
 * SAP Fiori pack against the SAP mock (examples/sap-mock): a real Chromium
 * drives the launchpad, Smart Fields, value helps and the message popover;
 * OData V2/V4 cross-checks; transport impact (QAS vs DEV) for Fiori and SAP
 * GUI journeys; the app/service role matrix. The mock emulates documented SAP
 * conventions; it is not SAP.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { SecretRegistry } from '../../src/identity/handle.js';
import { createSapIntegration, fioriLogin, parseFioriEzScript, parseTransport, ui5BoundControls, type SapIntegration } from '../../src/apps/sap/index.js';
import { startSapMock, type SapMockServer } from '../../examples/sap-mock/server.js';
import { PACK_SUITE_TIMEOUT_MS, allLines, runPack, stepLines } from './helpers.js';

let qas: SapMockServer;
let dev: SapMockServer;
let sap: SapIntegration;
let sapDev: SapIntegration;

const SERVICES = [
  { name: 'SD_SALESORDER_MANAGE_SRV', version: 2 as const, path: '/sap/opu/odata/sap/SD_SALESORDER_MANAGE_SRV' },
  { name: 'API_SALES_ORDER_SRV', version: 2 as const, path: '/sap/opu/odata/sap/API_SALES_ORDER_SRV' },
  { name: 'api_product', version: 4 as const, path: '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001' },
];
const APPS = [
  { title: 'Manage Sales Orders', intent: 'SalesOrder-manage', service: 'SD_SALESORDER_MANAGE_SRV', entitySet: 'C_SalesOrder', tcodes: ['VA02', 'VA03'], ui5App: 'ZSD_SO_MANAGE' },
  { title: 'Manage Products', intent: 'Product-manage', service: 'api_product', entitySet: 'Product', tcodes: ['MM02'] },
];

function integration(m: SapMockServer, source?: SapMockServer): SapIntegration {
  const u = m.users;
  return createSapIntegration({
    url: m.url, client: m.client,
    auth: { type: 'basic', username: u.integration.username, password: u.integration.password },
    users: { clerk: u.clerk, productManager: u.productManager, admin: u.admin },
    services: SERVICES, apps: APPS, timeoutMs: 8000,
    ...(source ? { source: { url: source.url, client: source.client, auth: { type: 'basic' as const, username: source.users.integration.username, password: source.users.integration.password } } } : {}),
  }, { secrets: new SecretRegistry() });
}

beforeAll(async () => {
  qas = await startSapMock({ system: 'QAS' });
  dev = await startSapMock({ system: 'DEV' });
  sap = integration(qas, dev);
  sapDev = integration(dev);
});
afterAll(async () => {
  await qas?.close();
  await dev?.close();
});

const CREATE = `
Journey: Create a standard order in Fiori
Id: fiori-create-order
Tags: @sap @fiori
Log in to SAP Fiori as clerk
Open the Fiori app "Manage Sales Orders"
Press the Fiori button "Create"
Set Fiori field "Sales Order Type" to "Standard Order"
Set Fiori field "Sales Organization" to "1710"
Set Fiori field "Sold-To Party" to "17100011" using the value help
Set Fiori field "Customer Reference" to "PO-EZ-1"
Set Fiori field "Requested Delivery Date" to "2026-12-24"
Save the Fiori object
Expect the Fiori toast to contain "created"
Expect Fiori field "Sales Order Type" to be "Standard Order (OR)"
Expect Fiori field "Sold-To Party" to be "Domestic Customer US 11"
Verify in SAP OData that A_SalesOrder "\${sap.key}" has SalesOrderType = "OR" and SoldToParty = "17100011" and "Customer Reference" = "PO-EZ-1" and "Requested Delivery Date" = "2026-12-24"
`;

describe('SAP Fiori pack against the SAP mock (real Chromium)', { timeout: PACK_SUITE_TIMEOUT_MS }, () => {
  it('parses Fiori phrasings into fiori.* steps and leaves the SAP GUI rung alone', () => {
    const j = parseFioriEzScript(CREATE);
    expect(j.steps.map((s) => s.handler)).toEqual([
      'fiori.login', 'fiori.openApp', 'fiori.press', 'fiori.setField', 'fiori.setField', 'fiori.setField', 'fiori.setField', 'fiori.setField',
      'fiori.save', 'fiori.expectMessage', 'fiori.expectField', 'fiori.expectField', 'fiori.verifyOData',
    ]);
    expect(j.steps[5].args).toEqual({ field: 'Sold-To Party', value: '17100011', valueHelp: true });
    const gui = parseFioriEzScript('Journey: g\nRun transaction "VA01"\nSet SAP field "Order Type" to "OR"\nPress SAP button "Save"\nSet Fiori filter "Sold-To Party" to "1"\nOpen the Fiori list item "4711"\nExpect the Fiori table to have 2 rows\nExpect the Fiori message popover to contain "x"\nExpect the Fiori tile "Manage Products" to be hidden');
    expect(gui.steps.map((s) => s.handler)).toEqual(['sap.transaction', 'sap.set', 'sap.press', 'fiori.setField', 'fiori.openItem', 'fiori.expectTable', 'fiori.expectMessage', 'fiori.expectTile']);
    expect(parseEzScript('Journey: w\nSet SAP field "Order Type" to "OR"').steps[0].handler).toBe('sap.set');
  });

  it('creates a sales order: OData-aware Smart Fields, ComboBox, value help dialog, DatePicker; cross-checked through the released API', async () => {
    const run = await runPack([parseFioriEzScript(CREATE)], sap.customSteps, qas.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const b = run.journeys[0].ledger.sap as Record<string, any>;
    expect(b.key).toBe('4713');
    expect(qas.data.orders.find((o) => o.SalesOrder === '4713')).toMatchObject({ SalesOrderType: 'OR', SoldToParty: '17100011', PurchaseOrderByCustomer: 'PO-EZ-1', RequestedDeliveryDate: '2026-12-24' });
    expect(b.odata.A_SalesOrder).toMatchObject({ SalesOrder: '4713', SoldToParty: '17100011' });
    expect(qas.stats.odata.at(-1)).toBe("GET API_SALES_ORDER_SRV/A_SalesOrder?sap-client=100&$format=json&$filter=SalesOrder+eq+'4713'&$select=SalesOrder,SalesOrderType,SoldToParty,PurchaseOrderByCustomer,RequestedDeliveryDate&$top=2");
  });

  it('filters the list report, opens an object, edits and saves it', async () => {
    const j = parseFioriEzScript(`
Journey: Change a customer reference
Id: fiori-edit
Log in to SAP Fiori as clerk
Open the Fiori app "Manage Sales Orders"
Set Fiori filter "Sold-To Party" to "17100002"
Press the Fiori button "Go"
Expect the Fiori table to have 1 row
Expect the Fiori table to contain "PO-GLOBEX-7"
Open the Fiori list item "4712"
Expect Fiori field "Customer Reference" to be read-only
Press the Fiori button "Edit"
Expect Fiori field "Sales Order" to be hidden
Expect Fiori field "Customer Reference" to be editable
Set Fiori field "Customer Reference" to "PO-GLOBEX-8"
Save the Fiori object
Expect the Fiori toast to contain "saved"
Expect Fiori field "Customer Reference" to be "PO-GLOBEX-8"
Verify in SAP OData that sales order "4712" has PurchaseOrderByCustomer = "PO-GLOBEX-8"
`);
    const run = await runPack([j], sap.customSteps, qas.url);
    expect(stepLines(run)).toEqual(allLines(run));
  });

  it('reports value help, option and backend errors (message popover) as the user would see them', async () => {
    const vh = parseFioriEzScript(`Journey: Vh\nId: vh\nLog in to SAP Fiori as clerk\nOpen the Fiori app "Manage Sales Orders"\nPress the Fiori button "Create"\nExpect the Fiori value help for "Sold-To Party" to contain "Inlandskunde DE 1"\nSet Fiori field "Sold-To Party" to "Domestic Customer US" using the value help`);
    const opt = parseFioriEzScript(`Journey: Opt\nId: opt\nLog in to SAP Fiori as clerk\nOpen the Fiori app "Manage Sales Orders"\nPress the Fiori button "Create"\nSet Fiori field "Sales Order Type" to "Credit Memo Request"`);
    const back = parseFioriEzScript(`Journey: Backend\nId: backend\nLog in to SAP Fiori as clerk\nOpen the Fiori app "Manage Sales Orders"\nPress the Fiori button "Create"\nSet Fiori field "Sales Order Type" to "OR"\nSet Fiori field "Sales Organization" to "1710"\nSet Fiori field "Sold-To Party" to "99999999"\nSave the Fiori object and expect the error "Customer 99999999 does not exist"\nExpect the Fiori message popover to contain "does not exist"\nSave the Fiori object`);
    const tile = parseFioriEzScript(`Journey: Tile\nId: tile\nLog in to SAP Fiori as clerk\nOpen the Fiori app "Manage Products"`);
    const run = await runPack([vh, opt, back, tile], sap.customSteps, qas.url);
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(0)).toBe('Fiori value help "Sold-To Party": no row matches "Domestic Customer US" exactly (rows: "17100001 / Domestic Customer US 1", "17100002 / Domestic Customer US 2", "17100011 / Domestic Customer US 11")');
    expect(run.journeys[2].steps.slice(0, -1).map((s) => s.status).every((s) => s === 'passed')).toBe(true);
    expect(err(2)).toBe('Fiori save failed: Customer 99999999 does not exist');
    expect(err(3)).toBe('The Fiori app "Manage Products" is not on this user\'s launchpad (tiles: "Manage Sales Orders")');
    // On QAS "Credit Memo Request" is a valid order type: the option step passes there.
    expect(stepLines(run, 1)).toEqual(allLines(run, 1));
    // On DEV (after the transports) the order type is gone and the PO number is mandatory and relabeled.
    const devRun = await runPack([opt, parseFioriEzScript(`Journey: Dev create\nId: dev-create\nLog in to SAP Fiori as clerk\nOpen the Fiori app "Manage Sales Orders"\nPress the Fiori button "Create"\nExpect Fiori field "Purchase Order Number" to be mandatory\nSet Fiori field "Sales Order Type" to "OR"\nSet Fiori field "Sales Organization" to "1710"\nSet Fiori field "Sold-To Party" to "17100001"\nSave the Fiori object and expect the error "Enter a purchase order number"`)], sapDev.customSteps, dev.url);
    expect(devRun.journeys[0].steps.find((s) => s.status === 'failed')?.error?.message).toBe('Fiori field "Sales Order Type" has no option "Credit Memo Request" (options: Standard Order (OR), Returns (RE))');
    expect(stepLines(devRun, 1)).toEqual(allLines(devRun, 1));
  });

  it('edits an OData V4 (Fiori elements) object and cross-checks it through V4', async () => {
    const j = parseFioriEzScript(`
Journey: Rename a product
Id: fiori-v4
Log in to SAP Fiori as productManager
Open the Fiori app "Manage Products"
Open the Fiori list item "TG11"
Press the Fiori button "Edit"
Set Fiori field "Product Description" to "Trading Good 11 (EZ)"
Set Fiori field "Material Group" to "L002"
Save the Fiori object
Verify in SAP OData that Product "TG11" has "Product Description" = "Trading Good 11 (EZ)" and ProductGroup = "L002"
`);
    const run = await runPack([j], sap.customSteps, qas.url);
    expect(stepLines(run)).toEqual(allLines(run));
    expect(qas.data.products[0]).toMatchObject({ ProductDescription: 'Trading Good 11 (EZ)', ProductGroup: 'L002' });
  });

  it('resolves fields through the page UI5 runtime (binding paths), not by guessing ids', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const page: Page = await (await browser.newContext()).newPage();
      const lp = `${qas.url}/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html?sap-client=100`;
      expect(await fioriLogin(page, lp, qas.users.clerk.username, qas.users.clerk.password, 8000)).toEqual({ ok: true });
      await page.goto(`${lp}#SalesOrder-manage&/C_SalesOrder('4711')`);
      await page.locator('.sapUxAPObjectPageLayout .sapUiForm').waitFor();
      const ctrls = await ui5BoundControls(page);
      expect(ctrls.map((c) => c.path)).toEqual(expect.arrayContaining(['SalesOrderType', 'SoldToParty', 'PurchaseOrderByCustomer']));
      expect(ctrls.find((c) => c.path === 'SoldToParty')).toMatchObject({ type: 'sap.ui.comp.smartfield.SmartField', inFilterBar: false });
    } finally {
      await browser.close();
    }
  });

  it('maps transports to the Fiori and SAP GUI journeys they break (QAS vs DEV)', async () => {
    const journeys = [
      parseFioriEzScript(CREATE),
      parseFioriEzScript(`Journey: Quick order\nId: quick-order\nLog in to SAP Fiori as clerk\nOpen the Fiori app "Manage Sales Orders"\nPress the Fiori button "Create"\nSet Fiori field "Sales Order Type" to "Standard Order"\nSet Fiori field "Sold-To Party" to "17100001"\nSave the Fiori object`),
      parseFioriEzScript(`Journey: Credit memo in SAP GUI\nId: gui-credit-memo\nRisk: 5\nConnect to SAP "ERP"\nLog on to SAP\nRun transaction "VA01"\nSet SAP field "VBAK-AUART" to "CR"\nSet SAP field "Customer Reference" to "RMA-1"\nPress SAP button "Save"`),
      parseFioriEzScript(`Journey: Product group\nId: product-group\nLog in to SAP Fiori as productManager\nOpen the Fiori app "Manage Products"\nOpen the Fiori list item "TG11"\nExpect Fiori field "Material Group" to be "L001"`),
      parseFioriEzScript(`Journey: Display only\nId: display\nRun transaction "MM03"`),
    ];
    const changes = await sap.changes({ transports: ['DEVK900123', 'DEVK900130'] });
    const report = sap.impact(changes, journeys);
    const by = Object.fromEntries(report.impacted.map((j) => [j.journeyId, j]));
    const why = (id: string) => by[id]?.reasons.map((r) => `${r.severity}:${r.change}:${r.matchedBy}:${r.matched}`) ?? [];
    expect(why('fiori-create-order')).toEqual(expect.arrayContaining(['breaking:field-relabeled:field:Customer Reference', 'review:ui-changed:object:C_SalesOrder']));
    expect(why('fiori-create-order').some((r) => r.includes('field-required'))).toBe(false);
    expect(why('quick-order')).toEqual(expect.arrayContaining(['breaking:field-required:creates-record:PurchaseOrderByCustomer']));
    expect(why('gui-credit-memo')).toEqual(expect.arrayContaining(['breaking:values-removed:value:CR', 'breaking:field-relabeled:field:Customer Reference', 'review:object-changed:object:VA01']));
    expect(why('product-group')).toEqual(expect.arrayContaining(['breaking:field-relabeled:field:Material Group']));
    expect(by.display).toBeUndefined();
    expect(report.impacted.map((j) => j.breaking)).toEqual([...report.impacted.map((j) => j.breaking)].sort((a, b) => b - a));
    const src = report.impacted.flatMap((j) => j.reasons.map((r) => r.source));
    expect(src.some((s) => s.startsWith('transport DEVK900123') && s.endsWith('R3TR DTEL BSTKD'))).toBe(true);
    expect(report.untested.map((c) => c.object)).toContain('PROG ZEZ_UNUSED_REPORT');

    // Offline: an E071 export without a second system still maps objects to journeys (review level).
    const offline = await sapDev.changes({ transports: [parseTransport('R3TR TRAN VA01\nR3TR TABU TVAK', 'DEVK900999')] });
    const off = sapDev.impact(offline, journeys);
    expect(off.impacted.find((j) => j.journeyId === 'gui-credit-memo')?.reasons.map((r) => r.matched)).toEqual(expect.arrayContaining(['VA01']));
  });

  it('diffs $metadata snapshots of two systems directly', async () => {
    const before = await sap.snapshot({ release: 'QAS' });
    const after = await sap.snapshot({ release: 'DEV', system: 'source' });
    const diff = await sap.changes({ before, after });
    expect(diff.map((c) => `${c.kind}:${c.object}.${c.field}`)).toEqual(expect.arrayContaining([
      'field-relabeled:C_SalesOrder.PurchaseOrderByCustomer', 'field-required:A_SalesOrder.PurchaseOrderByCustomer', 'values-removed:C_SalesOrder.SalesOrderType', 'field-relabeled:Product.ProductGroup',
    ]));
    expect(before.objects.C_SalesOrder.aliases).toEqual(expect.arrayContaining(['Manage Sales Orders', 'SalesOrder-manage', 'VA02']));
  });

  it('checks app and service access per role through OData (as each user) and the launchpad', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const pages: Record<string, Page> = {};
      const lp = `${qas.url}/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html?sap-client=100`;
      for (const r of ['clerk', 'productManager', 'admin'] as const) {
        pages[r] = await (await browser.newContext()).newPage();
        expect(await fioriLogin(pages[r], lp, qas.users[r].username, qas.users[r].password, 8000)).toEqual({ ok: true });
      }
      const ok = await sap.permissionMatrix([
        { app: 'Manage Sales Orders', expect: { clerk: 'visible', productManager: 'hidden', admin: 'visible' } },
        { app: 'Manage Products', expect: { clerk: 'hidden', productManager: 'visible' } },
        { service: 'api_product', entitySet: 'Product', expect: { clerk: 'none', productManager: 'read' } },
      ], { pages });
      expect(ok.violations).toEqual([]);
      expect(ok.results).toHaveLength(7);
      const bad = await sap.permissionMatrix([{ service: 'API_SALES_ORDER_SRV', expect: { productManager: 'read' } }]);
      expect(bad.violations.map((v) => `${v.user}:${v.subject}:${v.api}`)).toEqual(['productManager:service:API_SALES_ORDER_SRV:none']);
    } finally {
      await browser.close();
    }
  });
});
