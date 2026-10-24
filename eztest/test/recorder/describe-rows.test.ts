/** The recorder names a repeated button by its row ("the "Edit" button in the row containing "Bob""), measured on the page. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { describeTarget } from '../../src/intent/index.js';
import { resolveTarget } from '../../src/runner/index.js';
import { describeElement } from '../../src/recorder/index.js';

const HTML = `<!doctype html><html><body>
<table aria-label="Customers"><tr><th>Name</th><th></th></tr>
<tr><td>Alice</td><td><button>Edit</button></td></tr>
<tr><td>Bob</td><td><button>Edit</button></td></tr>
<tr><td>Bob</td><td><button>Edit</button></td></tr>
</table>
<p><button>Save</button> <button>Save</button></p>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HTML);
});
afterAll(async () => {
  await browser?.close();
});

describe('recorder: repeated names in rows', () => {
  it('uses the row text when it picks out one element, and the description resolves to it', async () => {
    const edit = page.getByRole('button', { name: 'Edit' }).first();
    const t = await describeElement(edit);
    expect(t.descriptions[0]).toBe('the "Edit" button in the row containing "Alice"');
    expect(t.ambiguous).toBe(false);
    const res = await resolveTarget(page, describeTarget(t.descriptions[0]), {}, 500);
    expect(res.locator).toBeDefined();
    const h = await edit.elementHandle();
    expect(await res.locator!.evaluate((el, other) => el === other, h)).toBe(true);
  });

  it('falls back to the position in words when the row text is not unique, or there is no row', async () => {
    const bob = await describeElement(page.getByRole('button', { name: 'Edit' }).nth(1));
    expect(bob.descriptions[0]).toBe('the 2nd "Edit" button');
    expect(bob.ambiguous).toBe(true);
    const save = await describeElement(page.getByRole('button', { name: 'Save' }).first());
    expect(save.descriptions[0]).toBe('the 1st "Save" button');
    for (const [el, d] of [[page.getByRole('button', { name: 'Edit' }).nth(1), bob.descriptions[0]], [page.getByRole('button', { name: 'Save' }).first(), save.descriptions[0]]] as const) {
      const res = await resolveTarget(page, describeTarget(d), {}, 500);
      const h = await el.elementHandle();
      expect(await res.locator!.evaluate((x, other) => x === other, h)).toBe(true);
    }
  });

  it('names the table when the same rows are in two tables', async () => {
    const two = await browser.newPage();
    const table = (id: string) => `<table id="${id}"><tr><td>Smith</td><td><a href="#edit">edit</a></td></tr><tr><td>Bach</td><td><a href="#edit">edit</a></td></tr></table>`;
    await two.setContent(`<!doctype html><body>${table('first')}${table('second')}</body>`);
    const link = two.locator('#second a').nth(1);
    const t = await describeElement(link);
    expect(t.descriptions[0]).toBe('the "edit" link in the row containing "Bach" inside #second');
    const res = await resolveTarget(two, describeTarget(t.descriptions[0]), {}, 500);
    const h = await link.elementHandle();
    expect(await res.locator!.evaluate((x, other) => x === other, h)).toBe(true);
    await two.close();
  });

  it('names a repeated product card by its name', async () => {
    const shop = await browser.newPage();
    const card = (n: string) => `<div class="item"><div class="img"><img alt="${n}" src="data:,"></div><div class="desc"><a href="#">${n}</a><p>A fine product for everyday use, made to last.</p><button>Add to cart</button></div></div>`;
    await shop.setContent(`<!doctype html><body><div class="list">${card('Backpack')}${card('Bike Light')}${card('Onesie')}</div></body>`);
    const btn = shop.getByRole('button', { name: 'Add to cart' }).nth(1);
    const t = await describeElement(btn);
    expect(t.descriptions[0]).toBe('the "Add to cart" button in the row containing "Bike Light"');
    const res = await resolveTarget(shop, describeTarget(t.descriptions[0]), {}, 500);
    const h = await btn.elementHandle();
    expect(await res.locator!.evaluate((x, other) => x === other, h)).toBe(true);
    await shop.close();
  });
});
