/**
 * Step definitions for the EZ Shop features: UI, API and database steps through
 * the EZTest SDK, a custom parameter type and the World.
 */
import { Given, When, Then, defineParameterType, setWorldConstructor, type DataTable } from '@mohammed-a-khan/eztest/bdd';

/** What the steps of one scenario share. A new World is made for every scenario attempt. */
class ShopWorld {
  readonly shopName: string;
  order?: string;
  quote?: { sku: string; name: string; qty: number; total: string };
  /** From the BeforeAll hook (steps/hooks.steps.ts). */
  widgetPrice?: string;
  constructor({ parameters }: { parameters: Record<string, unknown> }) {
    this.shopName = String(parameters.shopName ?? 'shop');
  }
}
setWorldConstructor(ShopWorld);

/** {money}: 148.50 -> 148.5 */
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

Then('the database has the order for {string}', async ({ db, expect, world }, customer: string) => {
  const id = Number(String((world as ShopWorld).order).replace(/^ORD-/, ''));
  const name = await db.on('shop').sqlValue<string>`SELECT c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ${id}`;
  await expect(name, `customer of ${(world as ShopWorld).order}`).toBe(customer);
});

Then('the EU customers are:', async ({ db, expect }, table: DataTable) => {
  const rows = await db.query<{ name: string; credit_limit: number }>('CUSTOMERS_BY_REGION', { region: 'EU' });
  await expect.rows(rows.map((r) => ({ name: r.name, credit_limit: String(r.credit_limit) }))).toEqual(table.hashes(), { key: 'name' });
});

When('I request a quote for {int} of {string}', async ({ api, world }, qty: number, sku: string) => {
  (world as ShopWorld).quote = (await api.post<ShopWorld['quote']>('/api/public/quote', { sku, qty }, { expectStatus: 200 })).body;
});

When('I post this quote request:', async ({ api, world }, body: string) => {
  (world as ShopWorld).quote = (await api.post<ShopWorld['quote']>('/api/public/quote', JSON.parse(body), { expectStatus: 200 })).body;
});

Then('the quote total is {money}', async ({ expect, world }, total: number) => {
  await expect((world as ShopWorld).quote?.total, 'quote total').toBe(total.toFixed(2));
});

// A regular expression works too; its groups arrive as strings.
Then(/^the quote is for "([^"]+)"$/, async ({ expect, world }, name: string) => {
  await expect((world as ShopWorld).quote?.name, 'quoted product').toBe(name);
});

// A named group converts the argument with that parameter type: count is a number.
Then(/^it costs (?<int>\d+) widget prices$/, async ({ expect, world }, count: number) => {
  const w = world as ShopWorld;
  await expect(Number(w.quote?.total), 'quote total').toBeCloseTo(count * Number(w.widgetPrice));
});

Given('the shop is open', async ({ api, expect }) => {
  const res = await api.post('/api/public/quote', { sku: 'SKU-100', qty: 1 }, { allowErrors: true });
  await expect(res.status, 'quote API status').toBe(200);
});
