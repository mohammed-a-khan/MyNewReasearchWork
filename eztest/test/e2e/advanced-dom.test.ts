/** E2E (real Chromium): DOM queries, rich assertions, soft assertions, shadow DOM, page scripts and explicit waits. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { describeSteps, expectPasses, runEz } from './advanced-helpers.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

describe('DOM queries', () => {
  it('captures attributes, properties, CSS, boxes, counts, lists, tables, HTML, page info and states', async () => {
    const { j } = await expectPasses(server.url, `Journey: Queries
Open /lab/form
Capture the "href" attribute of the "Help" link as helpHref
Capture the "placeholder" property of the Name field as namePlaceholder
Capture the "color" css of #badge as badgeColor
Capture the bounding box of #badge as badgeBox
Capture the outer HTML of #badge as badgeHtml
Capture whether the Locked field is disabled as lockedDisabled
Capture the current URL as pageUrl
Capture the page title as pageTitle
Open /lab/table
Count css=td as cellCount
Capture the texts of css=tbody td:first-child as names
Capture the rows of the "Products" table as products
Capture the text of the "Products" table matching "Gadget\\s+(\\d+\\.\\d+)" as gadgetPrice
`);
    const L = j.ledger;
    expect(L.helpHref).toBe('/lab/help');
    expect(L.namePlaceholder).toBe('Your name');
    expect(L.badgeColor).toBe('rgb(200, 0, 0)');
    expect(L.badgeBox).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(String(L.badgeHtml)).toContain('class="badge active red"');
    expect(L.lockedDisabled).toBe(true);
    expect(String(L.pageUrl)).toContain('/lab/form');
    expect(L.pageTitle).toBe('Form lab');
    expect(L.cellCount).toBe(8);
    expect(L.names).toEqual(['Widget', 'Gadget', 'Doohickey', 'Thingamajig']);
    expect(L.products).toEqual([
      { Name: 'Widget', Price: '19.99' }, { Name: 'Gadget', Price: '49.50' }, { Name: 'Doohickey', Price: '5.25' }, { Name: 'Thingamajig', Price: '12.00' },
    ]);
    expect(L.gadgetPrice).toBe('49.50');
  });
});

describe('assertions', () => {
  it('checks attributes, CSS, states, classes, count comparisons, regex and sort order', async () => {
    await expectPasses(server.url, `Journey: Assertions
Open /lab/form
Expect the "Help" link has attribute "title"
Expect the "href" attribute of the "Help" link is "/lab/help"
Expect the "aria-expanded" attribute of the "Help" link is "false"
Expect the "data-kind" attribute of the Name field contains "pers"
Expect the Name field does not have attribute "disabled"
Expect the CSS "color" of #badge is "rgb(200, 0, 0)"
Expect #badge has class "active"
Expect #badge does not have class "inactive"
Expect the Locked field is disabled
Expect the Name field is enabled
Expect the Name field is editable
Expect the Reference field is read-only
Expect the "Accept terms" checkbox is unchecked
Expect #empty-box is empty
Expect #footer is not in the viewport
Expect the "Save" button is disabled
Type "Ada" into the Name field
  Expect the "Save" button is enabled
Check the "Accept terms" checkbox
  Expect the "Accept terms" checkbox is checked
Expect the text of #badge matches "^Prem"
Expect the value of the Reference field matches "REF-\\d"
Open /lab/table
Expect there are more than 3 rows in the "Products" table
Expect there are at least 4 rows in the "Products" table
Expect there are fewer than 5 rows in the "Products" table
Expect there are between 2 and 6 rows in the "Products" table
Expect there are exactly 8 css=td
Click the "Price" button
  Expect the "Price" column of the "Products" table is sorted ascending
Click the "Price" button
  Expect the "Price" column of the "Products" table is sorted descending
Click the "Name" button
  Expect css=tbody td:first-child are sorted ascending
  Expect the expression 'upper("ab") + len("cd") == "AB2"' is true
`);
  });

  it('soft assertions collect failures and let the journey continue; it still fails at the end', async () => {
    const { j } = await runEz(server.url, `Journey: Soft
Open /lab/form
Soft expect the page contains "Nope, not here"
Soft expect #badge has class "inactive"
Assert that the page contains "Form lab" [soft]
Type "x" into the Name field
  Expect the Name field has value "x"
`);
    expect(j.status).toBe('failed');
    expect(j.steps.map((s) => s.status), describeSteps(j)).toEqual(['passed', 'failed', 'failed', 'passed', 'passed']);
    expect(j.steps[1].soft).toBe(true);
  });

  it('pierces open shadow DOM with CSS and accessible locators', async () => {
    await expectPasses(server.url, `Journey: Shadow
Open /lab/shadow
Type "SAVE10" into the Coupon field
Click the "Apply coupon" button
  Expect testid=coupon-result has text "Applied SAVE10"
  Expect css=ez-coupon .result contains "SAVE10"
`);
  });
});

describe('page scripts (opt-in, run in the page)', () => {
  it('are refused unless security.allowPageScripts is on, with a clear explanation', async () => {
    const { j } = await runEz(server.url, `Journey: No scripts
Open /lab/form
Run JavaScript: return document.title`);
    expect(j.steps[1].error?.message).toMatch(/Page scripts are disabled.*allowPageScripts/);
  });

  it('run inline and file scripts in the page, on elements, with parameters, and capture results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-scripts-'));
    await writeFile(join(dir, 'sum.js'), 'return args.a * 1 + args.b * 1 + document.querySelectorAll("tbody tr").length;');
    const { j } = await expectPasses(server.url, `Journey: Scripts
Open /lab/table
Run JavaScript and store the result as title: return document.title
Run JavaScript: document.title.toUpperCase()
Run JavaScript on the "Products" table and store the result as rowCount: return element.querySelectorAll('tbody tr').length
Run script "sum.js" with a=2, b="3" and store the result as total
Run JavaScript: document.querySelector('h1').textContent = 'Changed by script'
  Expect the page contains "Changed by script"
`, { allowPageScripts: true, baseDir: dir });
    expect(j.ledger).toMatchObject({ title: 'Table lab', rowCount: 4, total: 9 });
  });
});

describe('explicit waits', () => {
  it('waits for load states, URLs, element states, text changes, responses and custom conditions', async () => {
    const { j } = await expectPasses(server.url, `Journey: Waits
Open /lab/events
Wait for the page to load
Wait for the network to be idle
Wait for the DOM content to load
Wait for the URL to match "/lab/(events|x)/"
Wait for the "Ready soon" button to be enabled
Wait for #spinner to be removed
Wait for the "Ready soon" button to be stable
Click the "Tick" button
Wait for the text of #ticker to change and store it as tick
Click the "Load slowly" button
Wait for the response to /lab/api/slow and store it as slow
  Expect #slow has text "Done after 800 ms"
Click the "Load orders" button
Wait until #orders has text "3 orders" within 5 seconds checking every 100 ms
Set variable n to 2
Wait until \${n} + 1 == 3 within 1 second
`);
    expect(String(j.ledger.tick)).toMatch(/^updated at \d+$/);
    expect(j.ledger.slow).toMatchObject({ status: 200, body: { message: 'Done after 800 ms' } });
  });

  it('a wait that never holds times out with what it was waiting for', async () => {
    const { j } = await runEz(server.url, `Journey: Wait timeout
Open /lab/events
Wait until #orders has text "never" within 500 ms`);
    expect(j.steps[1].error?.message).toMatch(/Timed out after 500 ms waiting for textEquals/);
  });
});
