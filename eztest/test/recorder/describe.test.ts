/** In-page name/description computation on a small HTML fixture (real Chromium, setContent). */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Locator, type Page } from '../../src/browser/index.js';
import { describeTarget } from '../../src/intent/index.js';
import { resolveTarget } from '../../src/runner/index.js';
import { buildTarget, describeElement, inspectElement, type ElementInfo } from '../../src/recorder/index.js';

const HTML = `<!doctype html><html><body>
<nav aria-label="Main"><a href="/orders">Orders</a></nav>
<form>
  <p><label for="email">Email address</label> <input id="email" type="email"></p>
  <p><label>Remember me <input type="checkbox" id="rem"></label></p>
  <p><input type="checkbox" aria-label="Newsletter"></p>
  <p><input placeholder="Search products"></p>
  <p><label for="country">Country</label> <select id="country"><option>France</option><option>Spain</option></select></p>
  <p><label for="note">A note</label> <input id="note"></p>
  <p><label for="pw">Password</label> <input id="pw" type="password"></p>
  <p><button type="submit"><span>Save</span> changes</button> <input type="submit" value="Go"></p>
  <p><button type="button">Delete</button> <button type="button">Delete</button> <button type="button" data-testid="delete-3">Delete</button></p>
  <p><a href="/inv.pdf">Download invoice</a> <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Company logo"></p>
  <div role="button" tabindex="0">Custom action</div>
  <p>Total: <span data-testid="total">42.00</span></p>
  <div class="a"><span>dup</span></div><div class="b"><span>dup</span></div>
  <p><span>One of a kind</span></p>
  <h2>Shipping</h2>
</form>
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

/** The first description must locate exactly this element through the runner's own resolution. */
async function expectRoundTrip(loc: Locator, description: string): Promise<void> {
  const res = await resolveTarget(page, describeTarget(description), {}, 500);
  expect(res.locator, `${description}: ${res.notes.join('; ')}`).toBeDefined();
  const handle = await loc.elementHandle();
  expect(await res.locator!.evaluate((el, other) => el === other, handle)).toBe(true);
}

const CASES: Array<[string, (p: Page) => Locator, string]> = [
  ['text field by label', (p) => p.locator('#email'), 'the Email address field'],
  ['wrapped checkbox', (p) => p.locator('#rem'), 'the Remember me checkbox'],
  ['aria-label checkbox', (p) => p.getByRole('checkbox', { name: 'Newsletter' }), 'the Newsletter checkbox'],
  ['placeholder-only field', (p) => p.getByPlaceholder('Search products'), 'the "Search products" field'],
  ['select', (p) => p.locator('#country'), 'the Country dropdown'],
  ['label starting with an article is quoted', (p) => p.locator('#note'), 'the "A note" field'],
  ['password field', (p) => p.locator('#pw'), 'the Password field'],
  ['button with nested text', (p) => p.locator('button[type=submit]'), 'the "Save changes" button'],
  ['input submit', (p) => p.locator('input[type=submit]'), 'the "Go" button'],
  ['link', (p) => p.getByText('Download invoice'), 'the "Download invoice" link'],
  ['image', (p) => p.locator('img'), 'the "Company logo" image'],
  ['custom role=button', (p) => p.getByText('Custom action'), 'the "Custom action" button'],
  ['testid element', (p) => p.getByTestId('total'), 'testid=total'],
  ['unique text', (p) => p.getByText('One of a kind'), 'the "One of a kind" text'],
  ['heading', (p) => p.getByRole('heading'), 'the "Shipping" heading'],
];

describe('element description (in-page computation)', () => {
  for (const [title, get, want] of CASES) {
    it(`${title} -> ${want}`, async () => {
      const loc = get(page);
      const t = await describeElement(loc);
      expect(t.descriptions[0]).toBe(want);
      expect(t.ambiguous).toBe(false);
      await expectRoundTrip(loc, t.descriptions[0]);
    });
  }

  it('computes role, accessible name, label, test id and counts', async () => {
    const info = await inspectElement(page.locator('#email'));
    expect(info).toMatchObject({ tag: 'input', type: 'email', role: 'textbox', name: 'Email address', label: 'Email address', id: 'email', field: true, secret: false });
    expect(info.counts.label).toBe(1);
    const btn = await inspectElement(page.locator('button[type=submit]'));
    expect(btn).toMatchObject({ role: 'button', name: 'Save changes', field: false });
    expect(btn.counts.roleName).toBe(1);
  });

  it('orders locator candidates role+name, label, testId, id, css', async () => {
    const t = await describeElement(page.locator('#email'));
    expect(t.candidates.map((c) => c.strategy)).toEqual(['role', 'label', 'css', 'css']);
    expect(t.candidates[0]).toEqual({ strategy: 'role', value: 'textbox', name: 'Email address', exact: true });
    expect(t.candidates[2]).toEqual({ strategy: 'css', value: '#email' });
  });

  it('disambiguates a duplicated name with a unique CSS path, or the test id when there is one', async () => {
    const first = await describeElement(page.getByRole('button', { name: 'Delete' }).first());
    expect(first.ambiguous).toBe(true);
    expect(first.note).toBe('button "Delete" matches 3 elements; recorded the 1st');
    expect(first.descriptions[0]).toBe('the 1st "Delete" button');
    await expectRoundTrip(page.getByRole('button', { name: 'Delete' }).first(), first.descriptions[0]);

    const third = await describeElement(page.getByTestId('delete-3'));
    expect(third.ambiguous).toBe(true);
    expect(third.descriptions[0]).toBe('testid=delete-3');

    // The same words twice: say which one in words first, keep the CSS path as the fallback.
    const dup = await describeElement(page.locator('div.b span'));
    expect(dup.descriptions).toEqual(['the 2nd "dup" text', 'css=div.b span']);
    await expectRoundTrip(page.locator('div.b span'), dup.descriptions[0]);
    await expectRoundTrip(page.locator('div.b span'), dup.descriptions[1]);
  });

  it('never reads a password value', async () => {
    await page.locator('#pw').fill('Sup3r-Secret!');
    const info = await inspectElement(page.locator('#pw'));
    expect(info.secret).toBe(true);
    expect(JSON.stringify(info)).not.toContain('Sup3r-Secret!');
  });

  it('builds descriptions from reported info without a page (pure)', () => {
    const info: ElementInfo = {
      key: 'k', tag: 'select', role: 'combobox', name: 'Ship to', label: 'Ship to', classes: [], css: 'select#ship', id: 'ship',
      field: false, secret: false, counts: { roleName: 1, label: 1, placeholder: 0, placeholderAsLabel: 0, text: 0, testId: 0, id: 1 },
    };
    // The quoted form follows the unquoted one: inside a whole line the unquoted words can read as another phrasing.
    expect(buildTarget(info).descriptions).toEqual(['the Ship to dropdown', 'the "Ship to" dropdown', '#ship', 'css=select#ship']);
    expect(buildTarget({ ...info, counts: { ...info.counts, label: 2 } })).toMatchObject({ ambiguous: true, descriptions: ['#ship', 'css=select#ship'] });
  });
});

describe('URL expectations leave out one-time path segments', () => {
  it.each([
    ['/web/index.php/auth/changeWeakPassword/resetCode/YeC8lO2aCUIXfpRWA3uofw', '/web/index.php/auth/changeWeakPassword/resetCode/'],
    ['/web/index.php/dashboard/index', '/web/index.php/dashboard/index'],
    ['/orders/58213907/edit', '/orders/'],
    ['/u/3f2a9c1b-1234-4abc-9def-0123456789ab/profile', '/u/'],
    ['/a/ChangeWeakPasswordPage', '/a/ChangeWeakPasswordPage'],
    ['/pim/viewPersonalDetails/empNumber/7', '/pim/viewPersonalDetails/empNumber/'],
    ['/api/v2/items', '/api/v2/items'],
    ['/commit/9fceb02d0ae598e95dc970b74767f19372d61af8', '/commit/'],
  ])('%s', async (path, want) => {
    const { stablePath } = await import('../../src/recorder/compose.js');
    expect(stablePath(path)).toBe(want);
  });
});
