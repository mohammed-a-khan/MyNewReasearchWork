/**
 * Acceptance on automationexercise.com, an e-commerce practice site with ads and icon-font menus: search, a
 * product page, the cart and the contact form. Recorded with a visible browser, written by hand in .ez, and as a
 * code journey that checks the cart's arithmetic.
 *
 *   EZTEST_ONLINE=1 xvfb-run -a npm test -- test/acceptance/web/automationexercise
 */
import { beforeAll, describe, expect, it } from '../../support/testkit.js';
import { announce, bodyOf, click, DISPLAY, expectPassed, expectPlainEnglish, fill, ONLINE, record, replay, runProject, settle, siteDown } from './support.js';

const SITE = 'https://automationexercise.com';
announce('automationexercise.test.ts');

let down: string | undefined;
function needSite(ctx: { skip(note?: string): never }): void {
  if (down) {
    console.warn(`[acceptance/web] automationexercise skipped: ${down}`);
    ctx.skip(down);
  }
}

describe.skipIf(!ONLINE)('automationexercise.com', () => {
  beforeAll(async () => {
    down = await siteDown(SITE);
  }, 90_000);

  it.skipIf(!DISPLAY)('recorded: menu with icons, search, product, add to cart, view cart', async (ctx) => {
    needSite(ctx);
    const r = await record(`${SITE}/`, async (page, rec) => {
      await click(page, page.locator('a[href="/products"]'));
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/products');
      await fill(page, page.locator('#search_product'), 'jeans');
      await click(page, page.locator('#submit_search'));
      await expect.poll(() => page.getByText('Searched Products').isVisible(), { timeout: 30_000 }).toBe(true);
      await click(page, page.locator('.product-image-wrapper', { hasText: 'Soft Stretch Jeans' }).getByRole('link', { name: /View Product/ }));
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/product_details/');
      await click(page, page.getByRole('button', { name: /Add to cart/ }));
      await expect.poll(() => page.getByText('Your product has been added to cart.').isVisible(), { timeout: 30_000 }).toBe(true);
      await settle();
      await click(page, page.getByRole('link', { name: 'View Cart' }));
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/view_cart');
      await rec.addExpectation('the page contains "Soft Stretch Jeans"');
    });
    expectPlainEnglish(r);
    const lines = bodyOf(r);
    // The menu link has a cart icon glyph before its text; it is still "the Products link".
    expect(lines).toContain('Click the "Products" link');
    expect(lines).toContain('Type "jeans" into the Search Product field');
    expect(lines).toContain('Click the "View Product" link in the row containing "Soft Stretch Jeans"');
    expect(lines).toContain('Click the "Add to cart" button');
    expect(lines).toContain('Click the "View Cart" link');
    expectPassed(await replay(r));
  }, 300_000);

  it('written by hand: shop.ez', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('automationexercise', ['shop.ez']));
  }, 400_000);

  it('code journey: cart.journey.ts', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('automationexercise', ['cart.journey.ts']));
  }, 400_000);
});
