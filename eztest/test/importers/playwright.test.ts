import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEzScript } from '../../src/intent/index.js';
import { describeLocator, globToRegex, importPlaywright } from '../../src/importers/index.js';
import { flatten, parseExpr, splitStatements, tokenize } from '../../src/importers/code.js';

const SPEC = readFileSync(fileURLToPath(new URL('./fixtures/bob-order.spec.js', import.meta.url)), 'utf8');

describe('Playwright Test importer', () => {
  const r = importPlaywright(SPEC, { file: 'bob-order.spec.js' });
  const ez = r.converted[0].ez;
  const j = r.journeys[0];

  it('maps test()/describe()/beforeEach() into one journey with title tags', () => {
    expect(r.converted).toHaveLength(1);
    expect(ez.split('\n').slice(1, 3)).toEqual(['Journey: EZ Shop orders - bob creates an order', 'Tags: @smoke']);
    expect(ez).toContain('# beforeEach\nOpen "/login"\nType "bob" into the "Username" field\nType "Builder#2" into the "Password" field\nClick the "Sign in" button\n  Expect the URL matches "\\/dashboard"\n# test');
  });

  it('produces exact locator targets with the original locator as the first candidate', () => {
    const byIntent = (i: string) => j.steps.find((s) => s.intent === i)!;
    expect(byIntent('Type "bob" into the "Username" field').target!.locators[0]).toMatchObject({ strategy: 'label', value: 'Username' });
    expect(byIntent('Click the "Sign in" button').target!.locators[0]).toMatchObject({ strategy: 'role', value: 'button', name: 'Sign in' });
    expect(byIntent('Select "Northwind Traders" from the dropdown with id "customer"').target!.locators).toEqual([{ strategy: 'css', value: '#customer' }]);
    expect(byIntent('Select "Gadget (49.50)" from the "Product" dropdown').value).toBe('Gadget (49.50)');
  });

  it('turns web-first assertions into post-conditions of the preceding action', () => {
    const submit = j.steps.find((s) => s.intent === 'Click the "Submit order" button')!;
    expect(submit.postconditions.map((c) => c.type)).toEqual(['textContains', 'textEquals', 'textEquals']);
    expect(submit.postconditions[0]).toMatchObject({ value: 'created', target: { locators: [{ strategy: 'role', value: 'status' }] } });
    expect(submit.postconditions[2]).toMatchObject({ value: '99.00', target: { locators: [{ strategy: 'testId', value: 'order-total' }] } });
    expect(ez).toContain('Type "2" into the "Quantity" field\n  Expect the "Quantity" field has value "2"');
    expect(ez).toContain('Open "/orders/new"\n  Expect the title contains "New order"');
    // getByText (not exact) keeps substring semantics via the "message" phrasing
    expect(ez).toContain('Assert that the "Download invoice" message is visible');
    const assertStep = j.steps.find((s) => s.action === 'assert')!;
    expect(assertStep.postconditions[0].type).toBe('visible');
    expect((assertStep.postconditions[0] as { target: { locators: unknown[] } }).target.locators[0]).toEqual({ strategy: 'text', value: 'Download invoice', exact: false });
  });

  it('lists every unconverted statement as a TODO line and report item', () => {
    expect(r.todo.map((t) => [t.line, t.reason.split(' ')[0]])).toEqual([[17, 'chained'], [29, 'chained'], [31, 'page.screenshot']]);
    expect(ez).toContain("# TODO (not converted): await page.getByRole('link', { name: 'New order' }).first().click()");
    expect(r.coverage).toEqual({ sourceSteps: 11, convertedSteps: 9, assertions: 9, convertedAssertions: 8 });
    expect(parseEzScript(ez)).toEqual(j);
  });

  it('handles legacy page API, keyboard, waits, captures, negation and soft expects', () => {
    const rr = importPlaywright(`
import { test, expect } from '@playwright/test';
test('misc', async ({ page }) => {
  await page.goto('https://shop.test/');
  await page.fill('#q', 'gadget');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/search?q=*');
  await page.locator('xpath=//li[1]').dblclick();
  await page.getByPlaceholder('Notes').fill("it's ok");
  await page.getByRole('checkbox', { name: 'Gift wrap' }).check();
  await page.getByTestId('spinner').waitFor({ state: 'hidden' });
  const total = await page.getByTestId('total').textContent();
  expect(total).toBe('10.00');
  await expect.soft(page.getByText('Error')).not.toBeVisible();
  await expect(page.locator('.row')).toHaveCount(3);
  await page.waitForTimeout(250);
  await page.getByLabel('Name').press('Control+A');
  await expect(page.getByRole('button', { name: /save/i })).toBeEnabled();
  for (const x of [1, 2]) { await page.click('#x'); }
});`, { file: 'misc.spec.ts' });
    const l = rr.converted[0].ez.split('\n').filter((x) => x && !x.startsWith('#') || x.startsWith('# TODO'));
    expect(l.slice(1)).toEqual([
      'Open "https://shop.test/"',
      'Type "gadget" into the field with id "q"',
      'Press Enter',
      `  Expect the URL matches "${globToRegex('**/search?q=*')}"`,
      'Double-click //li[1]',
      `Type "it's ok" into the "Notes" field`,
      'Check the "Gift wrap" checkbox',
      'Wait for testid=spinner to disappear',
      'Capture the text of testid=total as total',
      '  Expect ${total} equals "10.00"',
      '  Expect the "Error" message is hidden',
      '  Expect the number of .row is 3',
      'Wait 250 ms',
      'Press Control+A in the "Name" field',
      "# TODO (not converted): await expect(page.getByRole('button', { name: /save/i })).toBeEnabled()",
      "# TODO (not converted): for (const x of [1, 2]) { await page.click('#x'); }",
    ]);
    const jj = rr.journeys[0];
    expect(jj.steps.find((s) => s.intent.startsWith('Type "it'))!.target!.locators.map((c) => c.strategy)).toEqual(['label', 'placeholder', 'role']);
    expect(rr.todo.map((t) => t.reason)).toEqual(['role locator with a regular-expression name is not converted', 'control flow ("for") is not converted']);
  });

  it('describeLocator prefers a readable description whose first candidate is the original', () => {
    expect(describeLocator({ strategy: 'role', value: 'link', name: 'Orders' })).toBe('the "Orders" link');
    expect(describeLocator({ strategy: 'role', value: 'textbox', name: 'Email' })).toBe('role=textbox[name="Email"]');
    expect(describeLocator({ strategy: 'testId', value: 'x y' })).toBe('the element with test id "x y"');
    expect(describeLocator({ strategy: 'css', value: 'div.card > a' })).toBe('div.card > a');
    expect(describeLocator({ strategy: 'css', value: 'li:nth-child(2)' })).toBe('css=li:nth-child(2)');
    expect(describeLocator({ strategy: 'altText', value: 'Logo' })).toBe('the "Logo" image');
  });

  it('the source lexer/parser reads without executing', () => {
    const src = "await expect(page.getByRole('row', { name: `A` })).toHaveText(/x\\/y/i); // c\nconst a = \"q\" + 'r'";
    const toks = tokenize(src, 'js');
    const st = splitStatements(toks, 0, toks.length, 'js');
    expect(st).toHaveLength(2);
    const e = parseExpr(toks, st[0].start, st[0].end);
    const segs = flatten(e);
    expect(segs.map((s) => s.name)).toEqual(['expect', 'toHaveText']);
    expect(segs[1].args[0]).toEqual({ k: 're', source: 'x\\/y', flags: 'i' });
    expect(() => parseExpr(toks, 0, 3)).toThrow();
  });
});
