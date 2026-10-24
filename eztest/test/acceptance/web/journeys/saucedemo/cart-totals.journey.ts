/**
 * Sauce Demo from code: read every product's price on the inventory page, put the three cheapest in the cart,
 * and check that the overview's item total, tax and total match what was read before.
 */
import { expect, inRow, journey, step, ui, vars } from '@eztech/eztest/sdk';

const price = (s: string) => Number(s.replace(/[^0-9.]/g, ''));

journey('Sauce Demo: the checkout adds up', { tags: ['@saucedemo', '@code'], baseUrl: 'https://www.saucedemo.com', variables: { password: 'secret_sauce' } }, async () => {
  await ui.open('/');
  await ui.fill('the Username field', 'standard_user');
  await ui.fill('the Password field', vars.text('password'));
  await ui.click('the "Login" button', { expect: { url: '/inventory.html', text: 'Sauce Labs Backpack' } });

  const products = await step('Read every product and its price', async () => {
    const names = await ui.texts('testid=inventory-item-name');
    const prices = (await ui.texts('testid=inventory-item-price')).map(price);
    await expect(names.length).toBe(6);
    await expect(prices.length).toBe(names.length);
    return names.map((name, i) => ({ name, price: prices[i] }));
  });
  const cheapest = [...products].sort((a, b) => a.price - b.price).slice(0, 3);

  for (const p of cheapest) {
    await ui.click(inRow(p.name, 'the "Add to cart" button'), { expect: { visible: inRow(p.name, 'the "Remove" button') } });
  }
  await expect.ui.text('testid=shopping-cart-badge').toBe(String(cheapest.length));

  // The app changes the address before it draws the cart: wait for the cart itself before reading it.
  await ui.click('testid=shopping-cart-link', { expect: { url: '/cart.html', text: 'Your Cart' } });
  const inCart = await ui.texts('testid=inventory-item-name');
  await expect([...inCart].sort()).toEqual(cheapest.map((p) => p.name).sort());

  await ui.click('the "Checkout" button');
  await ui.fill('the First Name field', 'Grace');
  await ui.fill('the Last Name field', 'Hopper');
  await ui.fill('the Zip/Postal Code field', '20500');
  await ui.click('the "Continue" button', { expect: { url: '/checkout-step-two.html' } });

  const itemTotal = price(await ui.text('testid=subtotal-label'));
  const tax = price(await ui.text('testid=tax-label'));
  const total = price(await ui.text('testid=total-label'));
  const expected = cheapest.reduce((s, p) => s + p.price, 0);
  await expect(itemTotal, 'item total').toBeCloseTo(expected, 2);
  await expect(tax, 'tax is 8%').toBeCloseTo(Math.round(expected * 8) / 100, 2);
  await expect(total, 'total').toBeCloseTo(itemTotal + tax, 2);

  await ui.click('the "Finish" button', { expect: { text: 'Thank you for your order!' } });
});
