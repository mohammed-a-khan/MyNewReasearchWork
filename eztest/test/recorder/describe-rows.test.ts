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

  it('falls back when the row text is not unique, or there is no row', async () => {
    const bob = await describeElement(page.getByRole('button', { name: 'Edit' }).nth(1));
    expect(bob.descriptions[0]).toMatch(/^css=/);
    expect(bob.ambiguous).toBe(true);
    const save = await describeElement(page.getByRole('button', { name: 'Save' }).first());
    expect(save.descriptions[0]).toMatch(/^css=/);
  });
});
