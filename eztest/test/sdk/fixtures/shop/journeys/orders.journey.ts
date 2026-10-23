/**
 * Code journeys against the EZ Shop demo app (synthetic fixture for the SDK tests):
 * loops over DB rows, if/switch, nested steps, soft assertions, files, dates and
 * interop with .ez journeys.
 */
import { journey, step, expect, soft } from 'eztest/sdk';
import { Dashboard, Login, NewOrder, Order } from '../screens/shop.js';

type Customer = { id: number; name: string; credit_limit: number };

journey('Order for every EU customer', { id: 'orders-per-customer', tags: ['@sdk', '@orders'], requirements: ['REQ-SDK-1'], risk: 4 }, async ({ ui, db, files, dates, vars, log }) => {
  await step('Sign in', async () => {
    await ui.open('/login');
    await ui.fill(Login.username, 'bob');
    await ui.fill(Login.password, 'Builder#2');
    await ui.click(Login.signIn, { expect: { url: '/dashboard' } });
  });

  const customers = await db.query<Customer>('CUSTOMERS_BY_REGION', { region: 'EU' });
  await expect(customers.length, 'EU customers').toBeGreaterThan(1);
  const created: Array<Record<string, unknown>> = [];

  for (const c of customers) {
    await step(`Order for ${c.name}`, async () => {
      await ui.open('/orders/new');
      await ui.select(NewOrder.customer, c.name);
      // if/switch on data from the database
      let product: string;
      switch (true) {
        case c.credit_limit >= 20000: product = 'Gadget (49.50)'; break;
        case c.credit_limit >= 10000: product = 'Widget (19.99)'; break;
        default: product = 'Doohickey (5.25)';
      }
      await ui.select(NewOrder.product, product);
      const qty = c.credit_limit > 15000 ? 3 : 1;
      await ui.fill(NewOrder.quantity, qty);
      await ui.click(NewOrder.submit, { expect: { text: 'created' } });
      const number = await ui.text(Order.number);
      await expect.ui.text(Order.customer).toBe(c.name);
      if (qty > 1) log.info(`bulk order ${number}`);
      created.push({ order: number, customer: c.name, qty, due: dates.addBusinessDays('2026-10-23', 3) });
    });
  }

  vars.set('createdCount', created.length);
  await step('Export and re-read the orders', async () => {
    const path = await files.writeCsv('out/created-orders.csv', created);
    const back = await files.rows(path);
    await expect.rows(back).toHaveCount(customers.length);
    await expect.rows(back).toContainRow({ customer: 'Contoso Ltd', due: '2026-10-28' });
    const xlsx = await files.writeXlsx('out/created.xlsx', created, { sheet: 'Orders' });
    await expect.rows(await files.rows(xlsx, { sheet: 'Orders' })).toEqual(back, { key: 'order' });
  });
  await step('Cross-check the database', async () => {
    // Ad-hoc SQL: the value is a bound parameter, never spliced into the text.
    const mine = await db.on('shop').sqlValue<number>`SELECT COUNT(*) FROM orders WHERE created_by = ${'bob'}`;
    await expect(Number(mine), 'orders created by bob').toBe(customers.length);
    await expect.db('CUSTOMERS_BY_REGION', { region: 'EU' }).toHaveCount(customers.length);
  });
});

journey('Soft checks and a code error', { id: 'soft-and-error', tags: ['@sdk', '@negative'] }, async ({ ui, expect: e }) => {
  await ui.open('/login');
  await soft(async () => {
    await e(1 + 1, 'two').toBe(3);
    await e.ui.page().toContainText('Sign in to EZ Shop');
  });
  await e.soft('abc').toContain('z');
  await ui.fill(Login.username, 'still running after soft failures');
});

journey('Interop: code calls .ez', { id: 'code-calls-ez', tags: ['@sdk', '@interop'] }, async ({ ui, run, expect: e }) => {
  const out = await run('login-as', { user: 'bob', password: 'Builder#2' });
  await e(out.welcome, 'returned welcome').toBe('bob');
  await e.ui.visible(Dashboard.orders);
  await ui.click(Dashboard.orderLink('ORD-1'), { optional: true });
});

journey('Throws from code', { id: 'throws', tags: ['@negative'] }, async ({ ui }) => {
  await ui.open('/login');
  const n = 2;
  if (n > 1) throw new Error('business rule violated: n > 1');
});
