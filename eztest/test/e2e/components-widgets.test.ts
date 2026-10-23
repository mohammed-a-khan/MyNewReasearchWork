/**
 * Combo boxes, date pickers, trees, tabs, accordions, stacked dialogs and
 * toasts in real Chromium: one journey per library (real MUI; emulated
 * Kendo, DevExtreme, PrimeNG, PrimeFaces, Angular Material, Oracle JET,
 * SAP UI5 DOM; WAI-ARIA patterns), with locale-specific date formats.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import type { EnterpriseApp } from '../../examples/enterprise-app/server.js';
import { componentEvidence, expectPasses, runEz, startApp } from './components-helpers.js';

let app: EnterpriseApp;
beforeAll(async () => {
  app = await startApp();
}, 120_000);
afterAll(async () => {
  await app?.close();
});

interface WidgetCase {
  lib: string;
  path: string;
  combo: string;
  status?: string;
  multi?: string;
  date: string;
  tree?: string;
  treeSelect?: boolean;
  tabs: string;
}

const CASES: WidgetCase[] = [
  { lib: 'kendo', path: '/lib/kendo', combo: 'kendo-combobox', status: 'kendo-dropdownlist', multi: 'kendo-multiselect', date: 'kendo-datepicker', tree: 'kendo-treeview', treeSelect: true, tabs: 'kendo-tabstrip' },
  { lib: 'devextreme', path: '/lib/devextreme', combo: 'dx-selectbox', status: 'dx-selectbox', multi: 'dx-selectbox', date: 'dx-datebox', tree: 'dx-treeview', treeSelect: true, tabs: 'dx-tabs' },
  { lib: 'primeng', path: '/lib/primeng', combo: 'primeng-dropdown', status: 'primeng-dropdown', date: 'primeng-calendar', tree: 'primeng-tree', treeSelect: true, tabs: 'primeng-tabview' },
  { lib: 'primefaces', path: '/lib/primefaces', combo: 'pf-selectonemenu', status: 'pf-selectonemenu', date: 'aria-datepicker', tree: 'aria-tree', tabs: 'aria-tabs' },
  { lib: 'material', path: '/lib/material', combo: 'mat-select', status: 'mat-select', multi: 'mat-select', date: 'mat-datepicker', tree: 'mat-tree', tabs: 'mat-tab-group' },
  { lib: 'jet', path: '/lib/jet', combo: 'oj-select-single', date: 'aria-datepicker', tree: 'aria-tree', tabs: 'aria-tabs' },
  { lib: 'ui5', path: '/lib/ui5', combo: 'sap-m-select', status: 'sap-m-select', date: 'sap-m-datepicker', tree: 'sap-m-tree', treeSelect: true, tabs: 'sap-m-icontabbar' },
  { lib: 'aria', path: '/lib/aria', combo: 'aria-combobox', date: 'aria-datepicker', tree: 'aria-tree', treeSelect: true, tabs: 'aria-tabs' },
  { lib: 'mui (real)', path: '/mui', combo: 'mui-autocomplete', multi: 'mui-autocomplete', date: 'mui-date-picker', tabs: 'mui-tabs' },
];

function journey(c: WidgetCase, locale: string, dateText: string): string {
  return [
    `Journey: Widgets on ${c.lib} (${locale})`,
    `Open ${c.path}${c.path.includes('?') ? '&' : '?'}locale=${locale}`,
    'Choose "Berlin" in the City combobox [id=city]',
    'Expect the City combobox to show "Berlin"',
    ...(c.status ? ['Choose "Shipped" in the Status dropdown list [id=status]'] : []),
    ...(c.multi ? ['Choose "Logistics", "Sales" in the Skills multi-select [id=skills]', 'Expect the Skills multi-select to show "Logistics", "Sales"'] : []),
    `Pick ${dateText} in the Due date picker [id=date]`,
    'Expect the Due date picker to show 2027-03-15',
    'Pick 2027-04-02 in the Due date picker by typing [id=typed]',
    'Expect the Due date picker to show 2 April 2027',
    ...(c.tree ? ['Expand "Europe > Germany" in the Regions tree [id=tree]', 'Expect "Europe > Germany > Munich" in the Regions tree to be visible'] : []),
    ...(c.treeSelect ? ['Select "Europe > Germany > Berlin" in the Regions tree'] : []),
    'Open the "Billing" tab in the Settings tabs [id=tabs]',
    'Expect the "Billing" tab in the Settings tabs to be selected',
  ].join('\n');
}

describe('the same widget journey on every library', () => {
  it.each(CASES)('$lib (en-US)', { timeout: 180_000 }, async (c) => {
    const r = await expectPasses(app.url, journey(c, 'en-US', '15 March 2027'));
    expect((await componentEvidence(r, 'city')).adapter).toBe(c.combo);
    if (c.status) expect((await componentEvidence(r, 'status')).adapter).toBe(c.status);
    if (c.multi) expect((await componentEvidence(r, 'skills')).adapter).toBe(c.multi);
    const date = await componentEvidence(r, 'date');
    expect(date.adapter).toBe(c.date);
    if (c.tree) expect((await componentEvidence(r, 'tree')).adapter).toBe(c.tree);
    expect((await componentEvidence(r, 'tabs')).adapter).toBe(c.tabs);
  });
});

describe('locale date formats', () => {
  const DATED = CASES.filter((c) => ['kendo', 'devextreme', 'primeng', 'material', 'ui5', 'aria', 'mui (real)'].includes(c.lib));
  it.each(DATED)('$lib: the same picks work in de-DE (dd.MM.yyyy and German month names)', { timeout: 180_000 }, async (c) => {
    const r = await expectPasses(app.url, `
Journey: German dates on ${c.lib}
Open ${c.path}?locale=de-DE
Pick 15 March 2027 in the Due date picker [id=date]
Expect the Due date picker to show 15.03.2027
Pick 2027-04-02 in the Due date picker by typing [id=typed]
Expect the Due date picker to show 2027-04-02
`);
    const typed = await componentEvidence(r, 'typed');
    expect(typed.verified).toMatch(/02\.04\.2027|2\.4\.2027/);
    expect(typed.details?.locale).toBe('de-DE');
  });

  it('types in an explicit display format and uses the calendar only when asked', async () => {
    const r = await expectPasses(app.url, `
Journey: Formats
Open /lib/kendo?locale=en-US
Pick 2027-12-24 in the Due date picker using format "M/d/yyyy" [id=fmt]
Pick 2027-01-05 in the Due date picker using the calendar [id=cal]
Expect the Due date picker to show 5 January 2027
`);
    expect((await componentEvidence(r, 'fmt')).verified).toMatch(/typed "12\/24\/2027"/);
    expect((await componentEvidence(r, 'cal')).verified).toMatch(/calendar/);
  }, 120_000);
});

describe('combo boxes', () => {
  it('waits for async options and picks the exact one (not "Berlin Heights")', async () => {
    const r = await expectPasses(app.url, `
Journey: Async lookups
Open /mui
Choose "Berlin" in the City autocomplete [id=mui]
Open /lib/aria
Choose "Bern" in the City combobox [id=aria]
`);
    expect((await componentEvidence(r, 'mui')).verified).toMatch(/shows "Berlin"/);
    expect((await componentEvidence(r, 'aria')).verified).toMatch(/shows "Bern"/);
  }, 120_000);

  it('lists the options when the value does not exist', async () => {
    const r = await runEz(app.url, 'Journey: J\nOpen /lib/kendo\nChoose "Atlantis" in the Status dropdown list');
    expect(r.j.steps[1].error?.message).toMatch(/offers no option "Atlantis" \(options: "Open", "Shipped", "Closed", "On hold"\)/);
  }, 60_000);

  it('handles native <select> elements through the same phrasing', async () => {
    await expectPasses(app.url, `
Journey: Native
Open /lib/aria
Choose "Germany" in the Country select box [id=native]
Expect the Country select box to show "Germany"
Pick 15 March 2027 in the Start date field [id=native-date]
Expect the Start date field to show 2027-03-15
Open /mui
Choose "50" in the "Rows per page:" select box [id=mui-select]
Expect the "Rows per page:" select box to show "50"
`);
  }, 60_000);
});

describe('dialogs and toasts', () => {
  it.each(['kendo', 'devextreme', 'primeng', 'material', 'ui5', 'jet', 'aria'])('%s: stacked modals and a vanishing toast', { timeout: 120_000 }, async (lib) => {
    const r = await expectPasses(app.url, `
Journey: Dialogs on ${lib}
Open /lib/${lib}
Watch for toasts
Click "Edit order"
In the "Edit order" dialog, click "Delete" [id=open-confirm]
Expect 2 dialogs to be open
Expect the "Confirm delete" dialog to be open
In the top dialog, click "Cancel"
Expect the "Confirm delete" dialog to be closed
Expect 1 dialogs to be open
In the "Edit order" dialog, click "Delete"
In the "Confirm delete" dialog, click "Delete"
Expect 0 dialogs to be open
Expect a toast containing "deleted" [id=toast]
Click "Save"
Wait 1 second
Expect a toast saying "Order saved" [id=vanished]
Expect no toast containing "error"
`);
    expect((await componentEvidence(r, 'vanished')).verified).toMatch(/recorded; already gone/);
  });

  it('real MUI: stacked Dialogs, Escape closes only the top one, Snackbar', async () => {
    await expectPasses(app.url, `
Journey: MUI dialogs
Open /mui
Click "Edit order"
In the "Edit order" dialog, click "Delete"
Expect 2 dialogs to be open
Close the top dialog
Expect the "Edit order" dialog to be open
Close the "Edit order" dialog
Expect 0 dialogs to be open
Click "Save"
Expect a toast saying "Order saved"
`);
  }, 120_000);
});

describe('trees, tabs and accordions', () => {
  it('collapses again and reports missing nodes with their siblings', async () => {
    await expectPasses(app.url, `
Journey: Tree
Open /lib/kendo
Expand "Americas > USA" in the Regions tree
Collapse "Americas" in the Regions tree
`);
    const r = await runEz(app.url, 'Journey: J\nOpen /lib/kendo\nExpand "Europe > Italy" in the Regions tree');
    expect(r.j.steps[1].error?.message).toMatch(/no node "Italy" under "Europe" \(found: "Germany", "France", "Spain"\)/);
  }, 120_000);

  it('accordions: WAI-ARIA and real MUI', async () => {
    await expectPasses(app.url, `
Journey: Accordions
Open /lib/aria
Expand the "Payment" section in the Details accordion
Collapse the "Payment" section in the Details accordion
Open /mui
Expand the "Shipping" section in the Details accordion
`);
  }, 120_000);
});
