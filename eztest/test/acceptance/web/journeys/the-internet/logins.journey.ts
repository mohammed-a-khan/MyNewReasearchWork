/** Data-driven login (the-internet.herokuapp.com/login): one attempt per CSV row, each with the message it must show. */
import { data, expect, journey, step, ui } from '@eztech/eztest/sdk';

journey('Login attempts from a CSV file', { tags: ['@the-internet', '@code', '@data'], baseUrl: 'https://the-internet.herokuapp.com' }, async () => {
  const rows = (await data.rows('journeys/data/logins.csv')) as Array<{ username: string; password: string; outcome: string }>;
  await expect(rows.length, 'rows in logins.csv').toBe(3);
  for (const row of rows) {
    await step(`Log in as ${row.username}`, async () => {
      await ui.open('/login');
      await ui.fill('the Username field', row.username);
      await ui.fill('the Password field', row.password);
      await ui.click('the "Login" button', { expect: { text: row.outcome } });
      if (row.outcome.includes('secure area')) {
        await expect.ui.url().toContain('/secure');
        await ui.click('the "Logout" link', { expect: 'the URL contains "/login"' });
      } else {
        await expect.ui.url().toContain('/login');
      }
    });
  }
});
