/** The Components grammar: every phrasing parses deterministically, renders back to .ez and round-trips through YAML/JSON. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '../support/testkit.js';
import YAML from 'yaml';
import { Journey, Step } from '../../src/core/index.js';
import {
  COMPONENT_RULES, INTENT_RULES, isComponentExpectation, journeyToEzScript, loadJourneyFile, parseEzScript, parseIntent, parseWhere, protectQuotes, stepToText, widgetNames, widgetTarget,
} from '../../src/intent/index.js';

const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
  ['In the Orders grid, click the row where Customer is "Contoso" and Status is "Open"', { widget: 'grid', op: 'clickRow', where: [{ column: 'Customer', op: 'equals', value: 'Contoso' }, { column: 'Status', op: 'equals', value: 'Open' }] }],
  ['In the Orders grid, double-click the first row where Amount > 100', { widget: 'grid', op: 'doubleClickRow', first: true, where: [{ column: 'Amount', op: 'gt', value: '100' }] }],
  ['In the Orders grid, click "Edit" in the row where Id is "42"', { widget: 'grid', op: 'clickInRow', name: 'Edit', where: [{ column: 'Id', op: 'equals', value: '42' }] }],
  ['Right-click the row where Id is "42" in the Orders data grid', { widget: 'grid', op: 'rightClickRow' }],
  ['Edit the Amount of the row where Id is "42" in the Orders grid to 150', { widget: 'grid', op: 'editCell', column: 'Amount' }, { value: '150' }],
  ['Set the "Order date" of the row where Id is "42" in the Orders grid to "2027-01-01"', { widget: 'grid', op: 'editCell', column: 'Order date' }, { value: '2027-01-01' }],
  ['Capture the Amount of the row where Id is "42" in the Orders grid as amount', { widget: 'grid', op: 'readCell', column: 'Amount' }, { captureAs: 'amount' }],
  ['Expect the Amount of the row where Id is "42" in the Orders grid to be "150.00"', { widget: 'grid', op: 'expectCell', match: 'equals' }, { value: '150.00' }],
  ['Expect the Notes of the row where Id is "42" in the Orders grid to be empty', { widget: 'grid', op: 'expectCell', match: 'empty' }],
  ['Expect the Orders grid to have 3 rows where Status is "Open"', { widget: 'grid', op: 'expectRows', count: 3, countOp: 'eq' }],
  ['Expect the Orders grid to have at least 2 rows where Region is not "EU"', { widget: 'grid', op: 'expectRows', count: 2, countOp: 'gte', where: [{ column: 'Region', op: 'notEquals', value: 'EU' }] }],
  ['Expect the Orders grid to have no rows where Status contains "hold"', { widget: 'grid', op: 'expectRows', count: 0, countOp: 'eq', where: [{ column: 'Status', op: 'contains', value: 'hold' }] }],
  ['Expect the Orders grid to have a row where Id is "7"', { widget: 'grid', op: 'expectRows', count: 1, countOp: 'gte' }],
  ['Expect the Orders grid to have 10000 rows', { widget: 'grid', op: 'expectRows', count: 10000 }],
  ['Sort the Orders grid by Amount descending', { widget: 'grid', op: 'sort', column: 'Amount', order: 'desc' }],
  ['Sort the Orders grid by "Order date"', { widget: 'grid', op: 'sort', column: 'Order date', order: 'asc' }],
  ['Filter the Orders grid where Region is "EU"', { widget: 'grid', op: 'filter', column: 'Region', match: 'equals' }, { value: 'EU' }],
  ['Filter the Orders grid where Customer contains "wood"', { widget: 'grid', op: 'filter', match: 'contains' }],
  ['Capture all rows of the Orders grid as orders', { widget: 'grid', op: 'readAll' }, { captureAs: 'orders' }],
  ['Capture all rows of the Orders grid where Status is "Open" as open', { widget: 'grid', op: 'readAll', where: [{ column: 'Status', op: 'equals', value: 'Open' }] }],
  ['Expect the Orders grid column Amount is sorted descending', { widget: 'grid', op: 'expectSorted', column: 'Amount', order: 'desc' }],
  ['Expect the Amount column of the Orders grid to be sorted ascending', { widget: 'grid', op: 'expectSorted', order: 'asc' }],
  ['Expect the Orders grid to have columns "Id", "Customer" and "Amount" in this order', { widget: 'grid', op: 'expectColumns', columns: ['Id', 'Customer', 'Amount'], ordered: true }],
  ['Select the rows where Status is "Open" in the Orders grid', { widget: 'grid', op: 'selectRows', all: true }],
  ['Select the row where Id is "7" in the Orders grid', { widget: 'grid', op: 'selectRows' }],
  ['Scroll the Orders grid to the row where Id is "9500"', { widget: 'grid', op: 'scrollToRow' }],
  ['Expand the row where Id is "42" in the Orders grid', { widget: 'grid', op: 'expandRow' }],
  ['Choose "Berlin" in the City combobox', { widget: 'combobox', op: 'choose', values: ['Berlin'] }],
  ['Choose "Logistics", "Sales" in the Skills multi-select', { widget: 'combobox', op: 'choose', values: ['Logistics', 'Sales'] }],
  ['Pick "O\'Brien & Sons" from the Customer lookup', { widget: 'combobox', op: 'choose', values: ["O'Brien & Sons"] }],
  ['Expect the City combobox to show "Berlin"', { widget: 'combobox', op: 'expect', values: ['Berlin'] }],
  ['Pick 15 March 2027 in the Due date picker', { widget: 'datepicker', op: 'pick', date: '15 March 2027' }],
  ['Pick 2027-03-15 in the Due date picker by typing', { widget: 'datepicker', op: 'pick', typing: true }],
  ['Pick 2027-03-15 in the Due date picker using format "dd.MM.yyyy"', { widget: 'datepicker', op: 'pick', format: 'dd.MM.yyyy' }],
  ['Pick ${due} in the Due date picker using the calendar', { widget: 'datepicker', op: 'pick', date: '${due}', calendar: true }],
  ['Set the Due date picker to tomorrow', { widget: 'datepicker', op: 'pick', date: 'tomorrow' }],
  ['Expect the Due date picker to show 15 March 2027', { widget: 'datepicker', op: 'expect' }],
  ['Expand "Europe > Germany" in the Regions tree', { widget: 'tree', op: 'expand', path: 'Europe > Germany' }],
  ['Collapse "Europe" in the Regions tree view', { widget: 'tree', op: 'collapse' }],
  ['Select "Europe > Germany > Berlin" in the Regions tree', { widget: 'tree', op: 'select' }],
  ['Expect "Europe > Germany" in the Regions tree to be expanded', { widget: 'tree', op: 'expect', state: 'expanded' }],
  ['Open the "Billing" tab in the Settings tabs', { widget: 'tabs', op: 'select', tab: 'Billing' }],
  ['Expect the "Billing" tab in the Settings tabs to be selected', { widget: 'tabs', op: 'expect' }],
  ['Expand the "Shipping" section in the Details accordion', { widget: 'accordion', op: 'expand', section: 'Shipping' }],
  ['In the "Confirm delete" dialog, click "Delete"', { widget: 'dialog', op: 'click', dialog: 'Confirm delete', name: 'Delete' }],
  ['In the top dialog, click "OK"', { widget: 'dialog', op: 'click', name: 'OK' }],
  ['Close the top dialog', { widget: 'dialog', op: 'close' }],
  ['Expect the "Confirm delete" dialog to be closed', { widget: 'dialog', op: 'expectClosed' }],
  ['Expect 2 dialogs to be open', { widget: 'dialog', op: 'expectCount', count: 2 }],
  ['Watch for toasts', { widget: 'toast', op: 'watch' }],
  ['Expect a toast saying "Order saved"', { widget: 'toast', op: 'expect', match: 'equals', text: 'Order saved' }],
  ['Expect no toast containing "error"', { widget: 'toast', op: 'expectNone', match: 'contains' }],
  ['Type "Hello" in the Notes editor', { widget: 'richtext', op: 'replace' }, { value: 'Hello' }],
  ['Append " more" to the Notes rich text editor', { widget: 'richtext', op: 'append' }],
  ['Clear the Notes editor', { widget: 'richtext', op: 'clear' }],
  ['Expect the Notes editor to be empty', { widget: 'richtext', op: 'expect', match: 'empty' }],
  ['Set the Price slider to 40', { widget: 'slider', op: 'set' }, { value: '40' }],
  ['Set the Price range slider to 20 and 80', { widget: 'slider', op: 'set', upper: '80' }, { value: '20' }],
  ['Expect the Price slider to be 40', { widget: 'slider', op: 'expect' }],
  ['Type "4111111111111111" into the Card number masked input', { widget: 'masked', op: 'type' }],
  ['Drop "a.pdf" onto the Attachments drop zone', { widget: 'dropzone', op: 'drop', files: ['a.pdf'] }],
  ['Upload "a.pdf" and "b.csv" to the Uploads drop zone', { widget: 'dropzone', op: 'drop', files: ['a.pdf', 'b.csv'] }],
  ['Expect the chart Revenue to have 12 points', { widget: 'chart', op: 'expectPoints', count: 12 }],
  ['Expect the Revenue chart series "2025" to have 12 points', { widget: 'chart', op: 'expectPoints', series: '2025' }],
  ['Expect the Revenue chart value for "Mar" to be 101', { widget: 'chart', op: 'expectValue', label: 'Mar' }, { value: '101' }],
  ['Capture the data of the Revenue chart as revenue', { widget: 'chart', op: 'capture' }, { captureAs: 'revenue' }],
  ['Capture all items of the News feed up to 100 as items', { widget: 'list', op: 'capture', max: 100 }],
  ['Expect the News feed to have 250 items in total', { widget: 'list', op: 'expectCount', count: 250 }],
];

describe('component phrasings', () => {
  it.each(CASES)('%s', (line, args, extra) => {
    const s = Step.parse(parseIntent(line));
    expect(s.action).toBe('component');
    expect(s.args).toMatchObject(args);
    if (extra) expect(s).toMatchObject(extra);
  });

  it('every component rule is in the "Components" category and its example parses', () => {
    expect(COMPONENT_RULES.length).toBeGreaterThanOrEqual(45);
    for (const r of COMPONENT_RULES) {
      expect(r.category).toBe('Components');
      expect(INTENT_RULES).toContain(r);
      expect(Step.parse(parseIntent(r.example)).action).toBe('component');
    }
  });

  it('keeps the classic meaning of lines that do not name a component', () => {
    const action = (l: string) => parseIntent(l).action;
    expect(action('Choose Contoso Ltd in the Customer dropdown')).toBe('select');
    expect(action('Capture the rows of the Orders table as orders')).toBe('query');
    expect(action('Drop file "a.pdf" onto the Drop zone')).toBe('upload');
    expect(action('Set the Quantity field to 2')).toBe('fill');
    expect(action('Type "bob" into the Username field')).toBe('fill');
    expect(action('Click the "Sign in" button')).toBe('click');
    expect(action('Open the Orders tab')).toBe('click');
    expect(action('Select "Gadget" from the Product dropdown')).toBe('select');
    expect(action('Dismiss the next dialog')).toBe('dialog');
  });
});

describe('component Expect lines', () => {
  it('are steps of their own, never post-conditions of the line before', () => {
    const j = parseEzScript(`Journey: J
Open /orders
Expect the Orders grid to have 3 rows where Status is "Open"
Click the "Refresh" button
Expect the "Confirm" dialog to be open
Expect the Orders table to have 2 rows`);
    expect(j.steps.map((s) => s.action)).toEqual(['navigate', 'component', 'click', 'component']);
    // The classic table count stays a post-condition of the click... of the dialog step before it.
    expect(j.steps[3].postconditions).toHaveLength(1);
    expect(isComponentExpectation('Expect the Orders grid to have 3 rows')).toBe(true);
    expect(isComponentExpectation('Expect the Orders table to have 3 rows')).toBe(false);
    expect(isComponentExpectation('Expect the page contains "x"')).toBe(false);
  });
});

describe('round trips', () => {
  const ez = `Journey: Components round trip
Open /lib/aria
${CASES.map(([l]) => l).join('\n')}`;

  it('renders back to .ez in its own wording and in canonical wording', () => {
    const j = parseEzScript(ez);
    const again = parseEzScript(journeyToEzScript(j));
    expect(again.steps).toEqual(j.steps);
    // Canonical wording: drop the intents, render with stepToText, parse again.
    const canonical = j.steps.map((s) => stepToText(s));
    const k = parseEzScript(`Journey: Canonical\n${canonical.join('\n')}`);
    expect(k.steps.map((s) => [s.action, s.args, s.value, s.captureAs, s.target?.locators])).toEqual(j.steps.map((s) => [s.action, s.args, s.value, s.captureAs, s.target?.locators]));
  });

  it('round-trips through JSON and YAML', async () => {
    const j = parseEzScript(ez);
    expect(Journey.parse(JSON.parse(JSON.stringify(j)))).toEqual(j);
    const dir = await mkdtemp(join(tmpdir(), 'eztest-comp-yaml-'));
    const file = join(dir, 'components.journey.yaml');
    await writeFile(file, YAML.stringify(JSON.parse(JSON.stringify(j))));
    const loaded = await loadJourneyFile(file);
    expect(loaded.steps).toEqual(j.steps);
  });

  it('accepts hand-written YAML component steps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-comp-yaml-'));
    const file = join(dir, 'orders.journey.yaml');
    await writeFile(file, `name: Orders by values
steps:
  - id: pick
    intent: Pick the Contoso order
    action: component
    target: { description: the Orders grid, locators: [{ strategy: testId, value: orders-grid }] }
    args:
      widget: grid
      op: clickRow
      where:
        - { column: Customer, value: Contoso }
        - { column: Status, op: equals, value: Open }
`);
    const j = await loadJourneyFile(file);
    expect(j.steps[0]).toMatchObject({ action: 'component', args: { widget: 'grid', op: 'clickRow' } });
    expect(stepToText(j.steps[0])).toBe('Click the row where Customer is "Contoso" and Status is "Open" in the Orders grid');
  });
});

describe('targets and conditions', () => {
  it('builds widget-aware locator candidates and handles ambiguous names', () => {
    const t = widgetTarget('the Orders grid', 'grid');
    expect(t.locators.slice(0, 4)).toEqual([
      { strategy: 'role', value: 'grid', name: 'Orders', exact: true },
      { strategy: 'role', value: 'treegrid', name: 'Orders', exact: true },
      { strategy: 'role', value: 'table', name: 'Orders', exact: true },
      { strategy: 'role', value: 'region', name: 'Orders', exact: true },
    ]);
    expect(widgetNames('the Due date picker', 'datepicker')).toEqual(['Due date', 'Due']);
    expect(widgetNames('the "Start" date picker', 'datepicker')).toEqual(['Start']);
    expect(widgetNames('the Price range slider', 'slider')).toEqual(['Price range', 'Price']);
    expect(widgetTarget('css=#orders', 'grid').locators).toEqual([{ strategy: 'css', value: '#orders' }]);
    expect(widgetTarget('testid=orders-grid', 'grid').locators).toEqual([{ strategy: 'testId', value: 'orders-grid' }]);
    const apos = widgetTarget("the O'Brien orders grid", 'grid').locators.find((l) => l.strategy === 'xpath');
    expect(apos?.value).toContain(`normalize-space(.)="O'Brien orders"`);
  });

  it('reads "the slider" as the one slider on the page, not a slider named "slider" (demoqa.com)', () => {
    expect(widgetTarget('the slider', 'slider').locators).toEqual([{ strategy: 'role', value: 'slider' }, { strategy: 'css', value: 'input[type=range]' }]);
    expect(widgetTarget('the editor', 'richtext').locators).toEqual([{ strategy: 'role', value: 'textbox' }, { strategy: 'css', value: '[contenteditable="true"]' }]);
    expect(widgetTarget('the Price slider', 'slider').locators[0]).toEqual({ strategy: 'role', value: 'slider', name: 'Price', exact: true });
  });

  it('parses row conditions', () => {
    const { text, quotes: q } = protectQuotes('Customer is Contoso and Amount >= 10 and Note is empty and "Order date" starts with 2026');
    expect(parseWhere(text, q)).toEqual([
      { column: 'Customer', op: 'equals', value: 'Contoso' },
      { column: 'Amount', op: 'gte', value: '10' },
      { column: 'Note', op: 'empty', value: '' },
      { column: 'Order date', op: 'startsWith', value: '2026' },
    ]);
    expect(() => parseWhere('Customer', q)).toThrow(/Expected a condition like Column is "value"/);
  });
});
