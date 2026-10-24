/**
 * Acceptance on saucedemo.com: log in, sort, add to cart from product cards, check out, finish. Recorded with a
 * visible browser, written by hand in .ez, and as a code journey that checks the totals; all must replay green.
 *
 *   EZTEST_ONLINE=1 xvfb-run -a npm test -- test/acceptance/web/saucedemo
 */
import { beforeAll, describe, expect, it } from '../../support/testkit.js';
import { announce, bodyOf, click, DISPLAY, expectPassed, expectPlainEnglish, fill, ONLINE, record, replay, runProject, siteDown } from './support.js';

const SITE = 'https://www.saucedemo.com';
const PASSWORD = 'secret_sauce';
announce('saucedemo.test.ts');

let down: string | undefined;
function needSite(ctx: { skip(note?: string): never }): void {
  if (down) {
    console.warn(`[acceptance/web] saucedemo skipped: ${down}`);
    ctx.skip(down);
  }
}

describe.skipIf(!ONLINE)('saucedemo.com', () => {
  beforeAll(async () => {
    down = await siteDown(SITE);
  }, 90_000);

  it.skipIf(!DISPLAY)('recorded: login, two products from their cards, cart, checkout form, finish', async (ctx) => {
    needSite(ctx);
    const r = await record(`${SITE}/`, async (page, rec) => {
      await fill(page, page.getByPlaceholder('Username'), 'standard_user');
      await fill(page, page.getByPlaceholder('Password'), PASSWORD);
      await click(page, page.getByRole('button', { name: 'Login' }));
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/inventory.html');
      const card = (name: string) => page.locator('[data-test="inventory-item"]', { hasText: name });
      await click(page, card('Sauce Labs Backpack').getByRole('button', { name: 'Add to cart' }));
      await click(page, card('Sauce Labs Fleece Jacket').getByRole('button', { name: 'Add to cart' }));
      await rec.addExpectation('testid=shopping-cart-badge has text "2"');
      await click(page, page.locator('[data-test="shopping-cart-link"]'));
      await click(page, page.getByRole('button', { name: 'Checkout' }));
      await fill(page, page.getByPlaceholder('First Name'), 'Ada');
      await fill(page, page.getByPlaceholder('Last Name'), 'Lovelace');
      await fill(page, page.getByPlaceholder('Zip/Postal Code'), '10115');
      await click(page, page.getByRole('button', { name: 'Continue' }));
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('checkout-step-two');
      await rec.addExpectation('the page contains "Item total: $79.98"');
      await click(page, page.getByRole('button', { name: 'Finish' }));
      await expect.poll(() => page.getByText('Thank you for your order!').isVisible(), { timeout: 30_000 }).toBe(true);
      await rec.addExpectation('the page contains "Thank you for your order!"');
    });
    expectPlainEnglish(r);
    expect(r.ez).not.toContain(PASSWORD);
    const lines = bodyOf(r);
    expect(lines).toContain('Type "${password}" into the Password field');
    // The same button on every card: named by its card, not by a CSS path or a position.
    expect(lines).toContain('Click the "Add to cart" button in the row containing "Sauce Labs Backpack"');
    expect(lines).toContain('Click the "Add to cart" button in the row containing "Sauce Labs Fleece Jacket"');
    expect(lines).toContain('  Expect testid=shopping-cart-badge has text "2"');
    // The cart link's accessible name says what is in the cart; with two items that names it uniquely.
    expect(lines).toContain('Click the "Cart, 2 items" button');
    expectPassed(await replay(r, { password: PASSWORD }));
  }, 300_000);

  it('written by hand: checkout.ez', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('saucedemo', ['checkout.ez']));
  }, 400_000);

  it('code journey: cart-totals.journey.ts', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('saucedemo', ['cart-totals.journey.ts']));
  }, 400_000);
});
