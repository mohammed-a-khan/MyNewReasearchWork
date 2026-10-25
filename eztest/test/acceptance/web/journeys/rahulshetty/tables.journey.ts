/**
 * rahulshettyacademy.com/AutomationPractice from code: add up the Amount column of the fixed-header table and
 * compare it with the total the page prints; find the courses of one instructor in the other table.
 */
import { expect, journey, step, ui } from '@eztech.com/eztest/sdk';

journey('Practice page tables add up', { tags: ['@rahulshetty', '@code'], baseUrl: 'https://rahulshettyacademy.com' }, async () => {
  await ui.open('/AutomationPractice/', { expect: { text: 'Web Table Fixed header' } });

  const amounts = await step('Sum the Amount column', async () => {
    const rows = await ui.table('css=.tableFixHead table');
    await expect(rows.length).toBeGreaterThan(5);
    return rows.map((r) => Number(r.Amount));
  });
  const shown = await ui.text('css=.totalAmount', { intent: 'Read the printed total' });
  const printed = Number(shown.replace(/[^0-9]/g, ''));
  await expect(amounts.reduce((a, b) => a + b, 0), 'sum of the Amount column').toBe(printed);

  await step('Courses taught by Rahul Shetty cost what the table says', async () => {
    const courses = await ui.table('css=table[name=courses]');
    const his = courses.filter((c) => c.Instructor === 'Rahul Shetty');
    await expect(his.length).toBeGreaterThan(3);
    for (const c of his) await expect(Number.isFinite(Number(c.Price)) && Number(c.Price) >= 0, `price of ${c.Course}`).toBe(true);
    const cheapest = his.reduce((a, b) => (Number(b.Price) < Number(a.Price) ? b : a));
    await expect.ui.visible(`the "${cheapest.Course}" cell`);
  });
});
