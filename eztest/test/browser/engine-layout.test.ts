/**
 * Page-side engine: the scoping and layout steps (section, row, layout) and
 * the driver's Locator API over them (getBySection, getByRow, below, above,
 * rightOf, leftOf, near), in a real browser.
 */
import type { Browser, Page } from '../../src/browser/index.js';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { launch, load, q } from './harness.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

const FORM = `
<style>
  body { font: 14px sans-serif; margin: 0; }
  .grid { display: grid; grid-template-columns: 120px 200px 120px 200px; gap: 8px 16px; padding: 10px; }
  span, input { height: 24px; box-sizing: border-box; }
</style>
<section id=billing>
  <div class=hd><h2 id=bh>Billing</h2></div>
  <div class=grid>
    <span id=l-email>Email</span><span></span><span id=l-phone>Phone</span><span></span>
    <input id=email><span></span><input id=phone><span></span>
    <span id=l-qty>Qty</span><input id=qty><span id=l-ref>Ref</span><input id=ref>
  </div>
</section>
<fieldset id=ship><legend>Shipping</legend><input id=ship-name aria-label="Name"></fieldset>
<div role=region aria-label="Notes" id=notes><input id=note aria-label="Name"></div>
<table id=orders>
  <caption>Orders</caption>
  <tr><th>Customer</th><th>Action</th></tr>
  <tr id=r1><td>Alice</td><td><button id=e1>Edit</button> <button id=d1>Delete</button></td></tr>
  <tr id=r2><td>Acme</td><td><button id=e2>Edit</button> <button id=d2>Delete</button></td></tr>
  <tr id=r3><td>Bob</td><td><button id=e3>Edit</button> <button id=d3>Delete</button></td></tr>
</table>
<div id=cards>
  <div class=card id=c1><b>Zed</b><button id=ce1>Open</button></div>
  <div class=card id=c2><b>Yan</b><button id=ce2>Open</button></div>
</div>`;

describe('section step', () => {
  it('finds headed containers, fieldsets by legend and named landmarks; innermost only', async () => {
    await load(page, FORM);
    expect(await q(page, [{ section: 'Billing' }])).toEqual(['billing']);
    expect(await q(page, [{ section: 'Shipping' }])).toEqual(['ship']);
    expect(await q(page, [{ section: 'Notes' }])).toEqual(['notes']);
    expect(await q(page, [{ section: 'Orders' }])).toEqual(['orders']);
    expect(await q(page, [{ section: 'Nope' }])).toEqual([]);
    // Scoping: the same label in two containers.
    expect(await q(page, [{ label: 'Name' }])).toEqual(['ship-name', 'note']);
    expect(await q(page, [{ section: 'Shipping' }, { label: 'Name' }])).toEqual(['ship-name']);
  });
});

describe('row step', () => {
  it('climbs from the text to the row-like ancestor (tr, repeated siblings)', async () => {
    await load(page, FORM);
    expect(await q(page, [{ row: 'Acme' }])).toEqual(['r2']);
    expect(await q(page, [{ row: 'Acme' }, { role: 'button', name: 'Edit', exact: true }])).toEqual(['e2']);
    expect(await q(page, [{ row: 'Yan' }, { role: 'button', name: 'Open' }])).toEqual(['ce2']);
    expect(await q(page, [{ row: 'Bob' }])).toEqual(['r3']);
    // A substring can hit several rows (the header "Action" too): strict mode then reports them.
    expect((await q(page, [{ row: 'A' }])).length).toBeGreaterThan(2);
  });
});

describe('layout step', () => {
  it('below / above / rightOf / leftOf keep the closest, aligned element', async () => {
    await load(page, FORM);
    const tb = { role: 'textbox' };
    expect(await q(page, [tb, { layout: 'below', anchor: [{ text: 'Email', exact: true }] }])).toEqual(['email']);
    expect(await q(page, [tb, { layout: 'below', anchor: [{ text: 'Phone', exact: true }] }])).toEqual(['phone']);
    expect(await q(page, [tb, { layout: 'rightOf', anchor: [{ text: 'Qty', exact: true }] }])).toEqual(['qty']);
    expect(await q(page, [tb, { layout: 'leftOf', anchor: [{ text: 'Ref', exact: true }] }])).toEqual(['qty']);
    expect(await q(page, [tb, { layout: 'above', anchor: [{ text: 'Qty', exact: true }] }])).toEqual(['email']);
    // Every element on that side when nearest is off.
    expect((await q(page, [{ css: '.grid input' }, { layout: 'below', anchor: [{ text: 'Email', exact: true }], nearest: false }])).sort()).toEqual(['email', 'phone', 'qty', 'ref']);
  });

  it('near honours maxDistance and never returns the anchor or its relatives', async () => {
    await load(page, FORM);
    // The Email field sits 8px above the Qty label, the Qty field 16px to its right.
    expect(await q(page, [{ css: 'input' }, { layout: 'near', anchor: [{ text: 'Qty', exact: true }] }])).toEqual(['email']);
    expect(await q(page, [{ css: 'input' }, { layout: 'near', anchor: [{ text: 'Qty', exact: true }], maxDistance: 20, nearest: false }])).toEqual(['email', 'qty']);
    expect(await q(page, [{ css: 'input' }, { layout: 'near', anchor: [{ text: 'Qty', exact: true }], maxDistance: 1 }])).toEqual([]);
    expect(await q(page, [{ css: '#qty' }, { layout: 'near', anchor: [{ css: '#qty' }] }])).toEqual([]);
  });

  it('rejects an unknown relation', async () => {
    await load(page, FORM);
    await expect(q(page, [{ css: 'input' }, { layout: 'diagonal', anchor: [{ css: 'span' }] }])).rejects.toThrow(/Unknown layout relation/);
  });
});

describe('Locator API', () => {
  it('getBySection, getByRow and the layout filters compose with strict actions', async () => {
    await load(page, FORM);
    await page.locator('section="Billing"').getByRole('textbox').below(page.getByText('Email', { exact: true })).fill('a@b.c');
    expect(await page.locator('#email').inputValue()).toBe('a@b.c');
    await page.getByRole('textbox').rightOf(page.getByText('Qty', { exact: true })).fill('3');
    expect(await page.locator('#qty').inputValue()).toBe('3');
    expect(await page.locator('body').getByRow('Acme').getByRole('button', { name: 'Delete' }).getAttribute('id')).toBe('d2');
    expect(await page.locator('row=Bob >> role=button[name="Edit"]').getAttribute('id')).toBe('e3');
    expect(await page.locator('body').getBySection('Shipping').getByLabel('Name').getAttribute('id')).toBe('ship-name');
    expect(await page.getByRole('button', { name: 'Edit' }).count()).toBe(3);
    expect(await page.getByRole('button', { name: 'Edit' }).below(page.getByText('Customer')).getAttribute('id')).toBe('e1');
    expect(page.getByRole('textbox').near(page.getByText('Qty')).toString()).toContain('near(');
  });
});
