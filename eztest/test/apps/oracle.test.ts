/**
 * Oracle pack against the Oracle mock (examples/oracle-mock): a real Chromium
 * drives Redwood (JET core-pack LOVs, editable lines table, toasts) and an EBS
 * OA Framework page (modal Search and Select LOV in an iframe); Fusion REST
 * cross-checks; 25C -> 25D quarterly-update impact; the role/resource/page
 * matrix. The mock emulates documented Oracle conventions; it is not Oracle.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { SecretRegistry } from '../../src/identity/handle.js';
import { parseCsvRows } from '../../src/apps/common/release-notes.js';
import { createOracleIntegration, oracleQ, parseOracleEzScript, type OracleIntegration } from '../../src/apps/oracle/index.js';
import { startOracleMock, type OracleMockServer } from '../../examples/oracle-mock/server.js';
import { PACK_SUITE_TIMEOUT_MS, allLines, runPack, stepLines } from './helpers.js';

let cur: OracleMockServer;
let next: OracleMockServer;
let ora: OracleIntegration;

const RESOURCES = [{ name: 'purchaseOrders', path: '/fscmRestApi/resources/11.13.18.05/purchaseOrders', key: 'OrderNumber', label: 'purchase order', pages: ['Create Purchase Order', 'Purchase Orders'] }];
const basic = (m: OracleMockServer) => ({ type: 'basic' as const, username: m.users.integration.username, password: m.users.integration.password });

beforeAll(async () => {
  cur = await startOracleMock({ update: '25C' });
  next = await startOracleMock({ update: '25D' });
  ora = createOracleIntegration({
    url: cur.url, ebsUrl: cur.url, auth: basic(cur),
    users: { buyer: cur.users.buyer, requester: cur.users.requester, viewer: cur.users.viewer },
    resources: RESOURCES, testPod: { url: next.url, auth: basic(next) }, timeoutMs: 8000,
  }, { secrets: new SecretRegistry() });
});
afterAll(async () => {
  await cur?.close();
  await next?.close();
});

const CREATE_PO = `
Journey: Create a purchase order in Redwood
Id: ora-create-po
Tags: @oracle @fusion
Log in to Oracle Fusion as buyer
Open the Oracle page "Create Purchase Order"
Expect Oracle field "Buyer" to be read-only
Expect Oracle field "Supplier" to be mandatory
Set Oracle field "Procurement BU" to "US1 Business Unit"
Set Oracle field "Supplier" to "Lee Supplies"
Set Oracle field "Supplier Site" to "Lee Dallas"
Set Oracle field "Description" to "Laptops for new hires"
Set Oracle field "Required Date" to "2026-12-01"
Press the Oracle button "Add Line"
Set Oracle table "Lines" row 1 column "Item" to 'AS92888 Laptop 15"'
Set Oracle table "Lines" row 1 column "Quantity" to "2"
Set Oracle table "Lines" row 1 column "Price" to "1500"
Press the Oracle button "Submit"
Expect the Oracle message to contain "submitted"
Expect Oracle field "Supplier" to be "Lee Supplies"
Expect the Oracle table "Lines" to contain "Laptop"
Verify in Oracle Fusion that purchase order "\${oracle.number}" has Supplier = "Lee Supplies" and "Supplier Site" = "Lee Dallas" and Status = "Pending Approval" and Total = "3000"
`;

describe('Oracle pack against the Oracle mock (real Chromium)', { timeout: PACK_SUITE_TIMEOUT_MS }, () => {
  it('parses Oracle phrasings for Fusion and EBS', () => {
    const j = parseOracleEzScript(CREATE_PO + 'Log in to Oracle EBS as requester\nOpen the Oracle EBS function "iProcurement > Non-Catalog Request"\nSet Oracle field "Category" to "X" using the list of values\nExpect the Oracle error to contain "x"\nExpect the Oracle table "Lines" to have 1 row\nExpect the Oracle page "Purchase Orders" to be unavailable');
    expect(j.steps.slice(-6).map((s) => [s.handler, s.args])).toEqual([
      ['oracle.login', { role: 'requester', system: 'ebs' }], ['oracle.navigate', { page: 'iProcurement > Non-Catalog Request', system: 'ebs' }],
      ['oracle.setField', { field: 'Category', value: 'X', lov: true }], ['oracle.expectMessage', { text: 'x', kind: 'error' }],
      ['oracle.expectTable', { table: 'Lines', count: 1 }], ['oracle.expectPage', { page: 'Purchase Orders', visible: false }],
    ]);
    expect(j.steps[10].args).toEqual({ table: 'Lines', row: 1, column: 'Item', value: 'AS92888 Laptop 15"' });
  });

  it('creates a purchase order on a Redwood page (LOVs, dependent LOV, editable table) and cross-checks it through REST', async () => {
    const run = await runPack([parseOracleEzScript(CREATE_PO)], ora.customSteps, cur.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const b = run.journeys[0].ledger.oracle as Record<string, any>;
    expect(b.number).toBe('1002');
    expect(cur.orders.find((p) => p.OrderNumber === '1002')).toMatchObject({ Supplier: 'Lee Supplies', SupplierSite: 'Lee Dallas', Total: 3000, lines: [{ Item: 'AS92888 Laptop 15"', Quantity: 2, Price: 1500 }] });
    expect(cur.stats.rest.at(-1)).toBe("purchaseOrders?onlyData=true&q=OrderNumber='1002'&fields=OrderNumber,Supplier,SupplierSite,Status,Total&limit=2");
  });

  it('reports Redwood validation, LOV and server errors as shown', async () => {
    const missing = parseOracleEzScript(`Journey: Missing\nId: missing\nLog in to Oracle Fusion as buyer\nOpen the Oracle page "Create Purchase Order"\nPress the Oracle button "Add Line"\nPress the Oracle button "Submit"\nExpect the Oracle error to contain "Enter a value."`);
    const lov = parseOracleEzScript(`Journey: Lov\nId: lov\nLog in to Oracle Fusion as buyer\nOpen the Oracle page "Create Purchase Order"\nSet Oracle field "Supplier" to "Lee"`);
    const server = parseOracleEzScript(`Journey: Server\nId: server\nLog in to Oracle Fusion as buyer\nOpen the Oracle page "Create Purchase Order"\nSet Oracle field "Procurement BU" to "UK Business Unit"\nSet Oracle field "Supplier" to "Advanced Corp"\nSet Oracle field "Supplier Site" to "Advanced HQ"\nPress the Oracle button "Add Line"\nSet Oracle table "Lines" row 1 column "Item" to "CM96713 Ergonomic Chair"\nSet Oracle table "Lines" row 1 column "Quantity" to "0"\nSet Oracle table "Lines" row 1 column "Price" to "300"\nPress the Oracle button "Submit"\nExpect the Oracle error to contain "quantity must be greater than zero"`);
    const denied = parseOracleEzScript(`Journey: Denied\nId: denied\nLog in to Oracle Fusion as requester\nOpen the Oracle page "Create Purchase Order"`);
    const run = await runPack([missing, lov, server, denied], ora.customSteps, cur.url);
    expect(stepLines(run, 0)).toEqual(allLines(run, 0));
    expect(stepLines(run, 2)).toEqual(allLines(run, 2));
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(1)).toBe('Oracle list of values "Supplier" has no value "Lee" (results: "Lee Supplies", "Lee Industrial Parts")');
    expect(err(3)).toBe('The Oracle Navigator has no "Create Purchase Order" for this user (pages: "Requisitions", "Me")');
  });

  it('submits an EBS OA Framework request: poplist, modal Search and Select LOV (iframe), message boxes', async () => {
    const j = parseOracleEzScript(`
Journey: EBS non-catalog request
Id: ebs-request
Tags: @oracle @ebs
Log in to Oracle EBS as requester
Open the Oracle EBS function "iProcurement > Non-Catalog Request"
Expect Oracle field "Category" to be mandatory
Set Oracle field "Item Description" to "Standing desk"
Set Oracle field "Quantity" to "0"
Press the Oracle button "Submit"
Expect the Oracle error to contain "Please enter a value for Category"
Expect the Oracle error to contain "Quantity must be a positive number"
Set Oracle field "Category" to "FURNITURE.CHAIRS" using the list of values
Set Oracle field "Quantity" to "1"
Set Oracle field "Unit of Measure" to "Each"
Set Oracle field "Unit Price" to "450"
Press the Oracle button "Submit"
Expect the Oracle confirmation to contain "has been submitted for approval"
`);
    const run = await runPack([j], ora.customSteps, cur.url);
    expect(stepLines(run)).toEqual(allLines(run));
    expect(cur.requisitions).toEqual([expect.objectContaining({ number: '14523', category: 'FURNITURE.CHAIRS', quantity: 1, uom: 'Each', price: 450, requester: 'PAT.STOCK' })]);
    expect((run.journeys[0].ledger.oracle as Record<string, unknown>).number).toBe('14523');
  });

  it('lists the journeys the 25D quarterly update breaks: pod comparison and the feature list', async () => {
    const features = parseCsvRows('Update,Product,Feature,Change_Type,Page,Field,New_Value,Description\n25D,Procurement,"Agent, not buyer",Field Renamed,Create Purchase Order,Buyer,Procurement Agent,"Buyer is now Procurement Agent"\n25D,Procurement,Redwood requisitions,UI Change,Requisitions,,,New Redwood page\n');
    expect(features[0].Feature).toBe('Agent, not buyer');
    const changes = await ora.changes({ features, update: '25D' });
    expect(changes.map((c) => `${c.kind}:${c.object}.${c.field ?? ''}`)).toEqual(expect.arrayContaining([
      'field-relabeled:purchaseOrders.Buyer', 'field-required:purchaseOrders.RequisitioningBU', 'values-removed:purchaseOrders.ProcurementBU', 'field-relabeled:page:Create Purchase Order.Buyer', 'ui-changed:page:Requisitions.',
    ]));
    const legacy = parseOracleEzScript(`Journey: Legacy BU\nId: legacy\nLog in to Oracle Fusion as buyer\nOpen the Oracle page "Create Purchase Order"\nSet Oracle field "Procurement BU" to "US1 Business Unit (Legacy)"\nSet Oracle field "Requisitioning BU" to "US1 Business Unit"`);
    const report = ora.impact(changes, [parseOracleEzScript(CREATE_PO), legacy]);
    const why = (id: string) => report.impacted.find((j) => j.journeyId === id)?.reasons.map((r) => `${r.severity}:${r.change}:${r.matchedBy}:${r.matched}`) ?? [];
    expect(why('ora-create-po')).toEqual(expect.arrayContaining(['breaking:field-relabeled:field:Buyer', 'breaking:field-required:creates-record:RequisitioningBU']));
    expect(why('legacy')).toEqual(expect.arrayContaining(['breaking:values-removed:value:US1 Business Unit (Legacy)']));
    expect(why('legacy').some((r) => r.includes('field-required'))).toBe(false);
  });

  it('checks job roles (userAccounts), REST access as each user and Navigator pages', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const pages: Record<string, Page> = {};
      for (const r of ['buyer', 'requester', 'viewer']) pages[r] = await (await browser.newContext()).newPage();
      const report = await ora.permissionMatrix([
        { role: 'Buyer', expect: { buyer: 'assigned', requester: 'not-assigned', viewer: 'not-assigned' } },
        { resource: 'purchaseOrders', expect: { buyer: 'read', requester: 'none' } },
        { page: 'Create Purchase Order', expect: { buyer: 'available', requester: 'unavailable', viewer: 'unavailable' } },
      ], { pages });
      expect(report.violations).toEqual([]);
      const bad = await ora.permissionMatrix([{ role: 'Buyer', expect: { requester: 'assigned' } }]);
      expect(bad.violations.map((v) => `${v.user}:${v.subject}:${v.api}`)).toEqual(['requester:role:Buyer:not-assigned']);
    } finally {
      await browser.close();
    }
  });

  it('builds q= finders from validated attributes and doubled quotes', () => {
    expect(oracleQ({ Supplier: "O'Neil Ltd", OrderNumber: '1' })).toBe("Supplier='O''Neil Ltd';OrderNumber='1'");
    expect(() => oracleQ({ "Supplier';x": 'y' })).toThrow(/Invalid Oracle REST attribute/);
  });
});
