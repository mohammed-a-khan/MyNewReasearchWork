/**
 * Acceptance on parabank.parasoft.com, a classic bank app whose forms have no <label>s: register, open an account,
 * transfer funds and check balances across pages. Recorded with a visible browser, written by hand in .ez, and as a
 * code journey that compares balances on every page; all must replay green.
 *
 *   EZTEST_ONLINE=1 xvfb-run -a npm test -- test/acceptance/web/parabank
 */
import { beforeAll, describe, expect, it } from '../../support/testkit.js';
import { announce, bodyOf, click, DISPLAY, expectPassed, expectPlainEnglish, fill, ONLINE, record, replay, runProject, siteDown } from './support.js';

const SITE = 'https://parabank.parasoft.com';
announce('parabank.test.ts');

let down: string | undefined;
function needSite(ctx: { skip(note?: string): never }): void {
  if (down) {
    console.warn(`[acceptance/web] parabank skipped: ${down}`);
    ctx.skip(down);
  }
}

describe.skipIf(!ONLINE)('parabank.parasoft.com', () => {
  beforeAll(async () => {
    down = await siteDown(`${SITE}/parabank/index.htm`);
  }, 90_000);

  it.skipIf(!DISPLAY)('recorded: registration in a form laid out as a table, a new account, a transfer', async (ctx) => {
    needSite(ctx);
    const user = `ezr${Date.now().toString(36)}`;
    const r = await record(`${SITE}/parabank/register.htm`, async (page, rec) => {
      const field = (id: string) => page.locator(`[id="${id}"]`);
      const form: Array<[string, string]> = [
        ['customer.firstName', 'Ada'], ['customer.lastName', 'Lovelace'], ['customer.address.street', '1 Analytical St'],
        ['customer.address.city', 'London'], ['customer.address.state', 'LDN'], ['customer.address.zipCode', '10115'],
        ['customer.phoneNumber', '5550100'], ['customer.ssn', '123-45-6789'], ['customer.username', user],
        ['customer.password', 'Secret#2026'], ['repeatedPassword', 'Secret#2026'],
      ];
      for (const [id, value] of form) await fill(page, field(id), value);
      await click(page, page.getByRole('button', { name: 'Register' }));
      await expect.poll(() => page.getByText('Your account was created successfully').isVisible(), { timeout: 30_000 }).toBe(true);
      await rec.addExpectation('the page contains "Your account was created successfully"');
      await click(page, page.getByRole('link', { name: 'Open New Account' }));
      await expect.poll(() => page.locator('#fromAccountId option').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      await click(page, page.getByRole('button', { name: 'Open New Account' }));
      await expect.poll(() => page.getByText('Account Opened!').isVisible(), { timeout: 30_000 }).toBe(true);
      await rec.addExpectation('the page contains "Account Opened!"');
      await click(page, page.getByRole('link', { name: 'Accounts Overview' }));
      await expect.poll(() => page.locator('#accountTable a').count(), { timeout: 30_000 }).toBe(2);
    });
    expectPlainEnglish(r);
    const lines = bodyOf(r);
    // No <label>s: the fields are named by the words before them, as a person reads the form.
    for (const line of ['Type "Ada" into the First Name field', 'Type "10115" into the Zip Code field', 'Type "5550100" into the "Phone #" field', `Type "${user}" into the Username field`]) {
      expect(lines).toContain(line);
    }
    expect(lines).toContain('Type "${password}" into the Password field');
    expect(lines).toContain('Type "${confirm}" into the Confirm field');
    expect(lines).toContain('Click the "Register" button');
    // A replay registers someone new: the recorded user name is the one value a tester changes.
    const again = r.ez.replaceAll(user, `${user}b`);
    expectPassed(await replay(again, { password: 'Secret#2026', confirm: 'Secret#2026' }));
  }, 300_000);

  it('written by hand: bank.ez', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('parabank', ['bank.ez']));
  }, 400_000);

  it('code journey: balances.journey.ts', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('parabank', ['balances.journey.ts']));
  }, 400_000);
});
