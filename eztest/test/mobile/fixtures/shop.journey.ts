/** A code journey (eztest/sdk) on a native Android app, for the mobile tests. Synthetic. */
import { journey, step, expect } from 'eztest/sdk';

journey('Code login on Android', { id: 'code-android-login', platform: 'android', app: 'com.shop.app' }, async ({ ui }) => {
  await step('Sign in', async () => {
    await ui.fill('the Username field', 'alice');
    await ui.click('the "Log in" button', { expect: 'an alert saying "Signed in as alice"' });
  });
  const status = await ui.text('id=status');
  await expect(status).toBe('Ready');
  await ui.screenshot('after-login');
});
