/**
 * Sortable data tables (the-internet.herokuapp.com/tables): read every row, compute with the values, sort by a
 * column and check the order, and compare what one table shows with the other.
 */
import { expect, journey, step, ui } from '@eztech.com/eztest/sdk';

const money = (s: string) => Number(s.replace(/[^0-9.]/g, ''));

journey('Tables: totals, sorting and two tables that must agree', { tags: ['@the-internet', '@code'], baseUrl: 'https://the-internet.herokuapp.com' }, async () => {
  await ui.open('/tables', { expect: { text: 'Data Tables' } });

  const first = await step('Read the first table', () => ui.table('#table1'));
  await expect(first.length, 'rows in table 1').toBe(4);
  const total = first.reduce((sum, row) => sum + money(row.Due), 0);
  await expect(total, 'total due').toBeCloseTo(251, 2);
  const biggest = first.reduce((a, b) => (money(b.Due) > money(a.Due) ? b : a));
  await expect(`${biggest['First Name']} ${biggest['Last Name']}`, 'who owes the most').toBe('Jason Doe');

  await step('Sort by Due and check the order', async () => {
    await ui.click('the "Due" text inside #table1');
    const dues = (await ui.table('#table1')).map((r) => money(r.Due));
    await expect(dues).toEqual([...dues].sort((a, b) => a - b));
    await ui.click('the "Due" text inside #table1');
    const desc = (await ui.table('#table1')).map((r) => money(r.Due));
    await expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });

  await step('The second table lists the same people with the same dues', async () => {
    const second = await ui.table('#table2');
    const key = (r: Record<string, string>) => `${r.Email}=${money(r.Due)}`;
    await expect(second.map(key).sort()).toEqual(first.map(key).sort());
  });

  // A row picked by what it shows, not by its position.
  await ui.click('the "edit" link in the row containing "fbach@yahoo.com" inside #table2', { expect: { url: '#edit' } });
});
