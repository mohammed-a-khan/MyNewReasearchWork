/**
 * automationexercise.com from code: search, check every result matches, put two products in the cart in
 * different quantities, and check each line's total and the cart against the prices read on the product pages.
 */
import { expect, inRow, journey, step, ui } from '@eztech.com/eztest/sdk';

const rupees = (s: string) => Number(s.replace(/^[^0-9]+/, '').replace(/[^0-9.]/g, ''));

journey('Automation Exercise: the cart adds up', { tags: ['@automationexercise', '@code'], baseUrl: 'https://automationexercise.com' }, async () => {
  await ui.open('/products', { expect: { text: 'All Products' } });
  await ui.fill('the Search Product field', 'top');
  await ui.click('#submit_search', { expect: { text: 'Searched Products' } });
  const names = await ui.texts('css=.productinfo p');
  await expect(names.length, 'results for "top"').toBeGreaterThan(1);
  for (const n of names) await expect(n.toLowerCase(), 'every result is a top').toMatch(/top|tshirt|t-shirt|shirt/);

  const picks = [{ name: names[0], qty: 2 }, { name: names[1], qty: 1 }];
  const prices: Record<string, number> = {};
  for (const p of picks) {
    await step(`Add ${p.qty} x ${p.name}`, async () => {
      await ui.open('/products');
      await ui.fill('the Search Product field', 'top');
      await ui.click('#submit_search', { expect: { text: 'Searched Products' } });
      await ui.click(inRow(p.name, 'the "View Product" link'), { expect: { url: '/product_details/' } });
      prices[p.name] = rupees(await ui.text('css=.product-information span span'));
      await ui.fill('#quantity', String(p.qty));
      await ui.click('the "Add to cart" button', { expect: { text: 'Your product has been added to cart.' } });
      await ui.click('the "Continue Shopping" button');
    });
  }

  await ui.open('/view_cart', { expect: { text: 'Shopping Cart' } });
  const lines = await ui.table('#cart_info_table');
  for (const p of picks) {
    const line = lines.find((l) => (l.Description ?? '').includes(p.name));
    await expect(line, `cart line of ${p.name}`).toBeDefined();
    await expect(rupees(line!.Price), `price of ${p.name}`).toBe(prices[p.name]);
    await expect(Number(line!.Quantity), `quantity of ${p.name}`).toBe(p.qty);
    await expect(rupees(line!.Total), `total of ${p.name}`).toBe(prices[p.name] * p.qty);
  }
  const cartTotal = lines.reduce((s, l) => s + rupees(l.Total ?? '0'), 0);
  await expect(cartTotal).toBe(picks.reduce((s, p) => s + prices[p.name] * p.qty, 0));
});
