/**
 * The function API (eztest/components) used from code with a plain
 * driver page (eztest/browser), and a custom adapter registered for an in-house grid.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import * as C from '../../src/runner/components/index.js';
import type { EnterpriseApp } from '../../examples/enterprise-app/server.js';
import { resolve } from 'node:path';
import { loadCodeJourneys, runJourneys } from '../../src/runner/index.js';
import { flattenStepResults } from '../../src/core/index.js';
import { tempDir } from '../runner/fixtures.js';
import { TIMEOUTS, componentEvidence, expectPasses, startApp } from './components-helpers.js';

let app: EnterpriseApp;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  app = await startApp();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await app?.close();
});

describe('function API', () => {
  it('drives a grid, a combobox, a date picker, a tree, tabs and dialogs from code', async () => {
    await page.goto(`${app.url}/lib/kendo`);
    const orders = await C.locateWidget(page, 'the Orders grid', 'grid');
    const found = await C.findGridRow(orders, { Id: 42 });
    expect(found.row.cells).toMatchObject({ Customer: 'Tailspin' });
    expect(found.page).toBe(3);
    const edit = await C.editGridCell(orders, { Id: '42' }, 'Amount', 150);
    expect(edit).toMatchObject({ adapter: 'kendo-grid', library: 'kendo', rowKey: 'uid-42' });
    expect((await C.readGridCell(orders, [{ column: 'Id', value: '42' }], 'Amount')).value).toBe('150.00');
    expect((await C.countGridRows(orders, { Status: 'Open' })).count).toBe(14);
    const all = await C.readGridRows(orders);
    expect(all).toMatchObject({ total: 60, pages: 3, virtualized: false });
    expect((await C.gridColumns(orders)).map((c) => c.text)).toEqual(['Id', 'Customer', 'Region', 'Status', 'Amount', 'Order date']);
    await C.sortGrid(orders, 'Customer', 'desc');
    await C.expectGridSorted(orders, 'Customer', 'desc');

    const city = await C.locateWidget(page, 'the City combobox', 'combobox');
    expect((await C.chooseOptions(city, ['Berlin'])).adapter).toBe('kendo-combobox');
    expect(await C.readCombo(city)).toMatchObject({ text: 'Berlin', library: 'kendo' });

    const due = await C.locateWidget(page, 'the Due date picker', 'datepicker');
    expect((await C.pickDate(due, C.parseDateText('2027-03-15'))).value).toBe('2027-03-15');

    expect((await C.treeAction(await C.locateWidget(page, 'the Regions tree', 'tree'), C.treePath('Asia > Japan'), 'expand')).verified).toMatch(/is expanded/);
    expect((await C.selectTab(await C.locateWidget(page, 'the Settings tabs', 'tabs'), 'Security')).verified).toMatch(/"Security" is selected/);

    await page.click('#open-dialog');
    await C.clickInDialog(page, undefined, 'Delete');
    await C.expectDialog(page, undefined, { count: 2 });
    await C.closeDialog(page, 'Confirm delete');
    await C.closeDialog(page, 'Edit order');
    await C.expectDialog(page, 'Edit order', 'closed');
  }, 180_000);
});

describe('custom adapters', () => {
  it('an in-house grid gets a dialect of its own and is preferred over the built-in ones', async () => {
    const adapter = new C.DialectAdapter('grid', 'acme', 'ACME grid', 'emulated', {
      id: 'acme-grid', root: '.ez-grid', headerCell: '[role=columnheader]', colIdAttr: 'aria-colindex',
      row: '.ez-viewport [role=row]', rowClosest: '[role=row]', cell: '[role=gridcell]', rowIndexAttr: 'aria-rowindex', viewport: '.ez-viewport', editTrigger: 'dblclick',
    });
    const off = C.registerComponentAdapter(adapter);
    try {
      const r = await expectPasses(app.url, `
Journey: Custom adapter
Open /lib/aria
Click the row where Id is "42" in the Orders grid [id=pick]
`);
      expect((await componentEvidence(r, 'pick')).adapter).toBe('acme-grid');
    } finally {
      off();
    }
  }, 120_000);
});

describe('code journeys (eztest/sdk)', () => {
  it('ui.component runs component steps on the runner path, with evidence and read values', async () => {
    const file = resolve(__dirname, 'fixtures/components.journey.ts');
    const journeys = await loadCodeJourneys(file, { cwd: await tempDir('components-sdk') });
    const r = await runJourneys(journeys, { ...TIMEOUTS, baseUrl: app.url, outputDir: await tempDir('components-sdk-run') });
    const j = r.journeys[0];
    const steps = flattenStepResults(j.steps).map((x) => x.result);
    expect(j.status, steps.map((s) => `${s.status} ${s.intent}${s.error ? ` -- ${s.error.message}` : ''}`).join('\n')).toBe('passed');
    const intents = steps.map((s) => s.intent);
    expect(intents).toContain('Edit the Amount of the row where Id is "42" in the Orders grid to "150"');
    expect(intents).toContain('Read the Amount of the row where Id is "42" in the Orders grid');
    expect(intents).toContain('Close the "Edit order" dialog');
    expect(intents.some((t) => /Choose "Berlin" in the City combobox/.test(t))).toBe(true);
    expect(steps.filter((s) => s.evidence?.length && /grid|combobox|tree|dialog/i.test(s.intent)).length).toBeGreaterThan(3);
  }, 180_000);
});
