/** practicetestautomation.com: the login page driven from a JSON file of cases, one reported step per case. */
import { expect, files, journey, step, ui } from '@eztech.com/eztest/sdk';

interface Case { case: string; username: string; password: string; message: string; url: string }

journey('Practice login: every case in logins.json', { tags: ['@practice', '@code', '@data'], baseUrl: 'https://practicetestautomation.com' }, async () => {
  const cases = (await files.readJson('journeys/data/logins.json')) as Case[];
  await expect(cases.length).toBe(3);
  let passed = 0;
  for (const c of cases) {
    await step(`Login: ${c.case}`, async () => {
      await ui.open('/practice-test-login/');
      await ui.fill('the Username field', c.username);
      await ui.fill('the Password field', c.password);
      await ui.click('the "Submit" button', { expect: { text: c.message, url: c.url } });
      if (c.case === 'valid') {
        await expect(await ui.title()).toContain('Logged In Successfully');
        await ui.click('the "Log out" link', { expect: { url: '/practice-test-login/' } });
      } else {
        await expect(await ui.text('#error')).toBe(c.message);
      }
      passed++;
    });
  }
  await expect(passed, 'cases run').toBe(cases.length);
});
