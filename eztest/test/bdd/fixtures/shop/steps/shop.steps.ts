/**
 * Step definitions for the EZ Shop features (synthetic fixture of the native BDD tests).
 * UI, API and DB steps through eztest/sdk; a custom parameter type; the World.
 */
import { Given, When, Then, defineParameterType, type DataTable } from 'eztest/bdd';

interface ShopWorld {
  order?: string;
  quote?: { sku: string; name: string; qty: number; total: string };
}

defineParameterType({ name: 'money', regexp: /\d+\.\d\d/, transformer: (s: string) => Number(s) });

When('I order {int} {string} for {string}', async ({ ui, world }, qty: number, product: string, customer: string) => {
  await ui.open('/orders/new');
  await ui.select({ label: 'Customer' }, customer);
  await ui.select({ label: 'Product' }, product);
  await ui.fill({ label: 'Quantity' }, String(qty));
  await ui.click({ role: 'button', name: 'Submit order' }, { expect: { text: 'created' } });
  (world as ShopWorld).order = await ui.text('testid=order-number');
});

Then('the order total is {money}', async ({ expect }, total: number) => {
  await expect.ui.text('testid=order-total').toBe(total.toFixed(2));
});

Then('the database has {int} order(s) for {string}', async ({ db, expect, world }, n: number, customer: string) => {
  const count = await db.on('shop').sqlValue<number>`SELECT COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.name = ${customer}`;
  await expect(Number(count), `orders for ${customer}`).toBe(n);
  await expect((world as ShopWorld).order, 'order number from the UI').toMatch(/^ORD-\d+$/);
});

Then('the EU customers are:', async ({ db, expect }, table: DataTable) => {
  const rows = await db.query<{ name: string; credit_limit: number }>('CUSTOMERS_BY_REGION', { region: 'EU' });
  await expect.rows(rows.map((r) => ({ name: r.name, credit_limit: String(r.credit_limit) }))).toEqual(table.hashes(), { key: 'name' });
});

When('I request a quote for {int} of {string}', async ({ api, world }, qty: number, sku: string) => {
  const res = await api.post<ShopWorld['quote']>('/api/public/quote', { sku, qty }, { expectStatus: 200 });
  (world as ShopWorld).quote = res.body;
});

When('I post this quote request:', async ({ api, world }, body: string) => {
  const res = await api.post<ShopWorld['quote']>('/api/public/quote', JSON.parse(body), { expectStatus: 200 });
  (world as ShopWorld).quote = res.body;
});

Then('the quote total is {money}', async ({ expect, world }, total: number) => {
  await expect((world as ShopWorld).quote?.total, 'quote total').toBe(total.toFixed(2));
});

Then(/^the quote is for "([^"]+)"$/, async ({ expect, world }, name: string) => {
  await expect((world as ShopWorld).quote?.name, 'quoted product').toBe(name);
});

Given('the shop is open', async () => undefined);
