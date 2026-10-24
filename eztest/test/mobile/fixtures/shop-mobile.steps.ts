/** Step definitions for shop-mobile.feature (a native Android app, for the mobile tests). Synthetic. */
import { Then, When } from 'eztest/bdd';

When('I sign in on the device', async ({ ui }) => {
  await ui.click('the "Log in" button', { expect: 'an alert saying "Signed in as alice"' });
  await ui.screenshot('after-sign-in');
});

Then('the status reads {string}', async ({ ui, expect }, text: string) => {
  await expect(await ui.text('id=status')).toBe(text);
});
