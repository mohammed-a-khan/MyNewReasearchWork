/**
 * Acceptance on practicetestautomation.com/practice-test-login: a wrong user, then a good login and log out.
 * Recorded with a visible browser, written by hand in .ez, and as a data-driven code journey (JSON).
 *
 *   EZTEST_ONLINE=1 xvfb-run -a npm test -- test/acceptance/web/practice-login
 */
import { beforeAll, describe, expect, it } from '../../support/testkit.js';
import { announce, bodyOf, click, DISPLAY, expectPassed, expectPlainEnglish, fill, ONLINE, record, replay, runProject, siteDown } from './support.js';

const SITE = 'https://practicetestautomation.com';
const PASSWORD = 'Password123';
announce('practice-login.test.ts');

let down: string | undefined;
function needSite(ctx: { skip(note?: string): never }): void {
  if (down) {
    console.warn(`[acceptance/web] practicetestautomation skipped: ${down}`);
    ctx.skip(down);
  }
}

describe.skipIf(!ONLINE)('practicetestautomation.com login', () => {
  beforeAll(async () => {
    down = await siteDown(`${SITE}/practice-test-login/`);
  }, 90_000);

  it.skipIf(!DISPLAY)('recorded: a wrong user, then a good login, an expectation, log out', async (ctx) => {
    needSite(ctx);
    const r = await record(`${SITE}/practice-test-login/`, async (page, rec) => {
      await fill(page, page.getByLabel('Username'), 'incorrectUser');
      await fill(page, page.getByLabel('Password'), PASSWORD);
      await click(page, page.getByRole('button', { name: 'Submit' }));
      await expect.poll(() => page.locator('#error').isVisible(), { timeout: 30_000 }).toBe(true);
      await rec.addExpectation('I see "Your username is invalid!"');
      await click(page, page.getByLabel('Username'));
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('student', { delay: 35 });
      await fill(page, page.getByLabel('Password'), PASSWORD);
      await click(page, page.getByRole('button', { name: 'Submit' }));
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('logged-in-successfully');
      await rec.addExpectation('user lands on "Logged In Successfully" screen');
      await click(page, page.getByRole('link', { name: 'Log out' }));
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('practice-test-login');
    });
    expectPlainEnglish(r);
    expect(r.ez).not.toContain(PASSWORD);
    expect(bodyOf(r)).toEqual([
      'Open /practice-test-login/',
      'Type "incorrectUser" into the Username field',
      'Type "${password}" into the Password field',
      'Click the "Submit" button',
      '  Expect page contains "Your username is invalid!"',
      'Type "student" into the Username field',
      'Type "${password}" into the Password field',
      'Click the "Submit" button',
      '  Expect URL contains "/logged-in-successfully/"',
      '  Expect page contains "Logged In Successfully"',
      'Click the "Log out" link',
      '  Expect URL contains "/practice-test-login/"',
    ]);
    expectPassed(await replay(r, { password: PASSWORD }));
  }, 300_000);

  it('written by hand: login.ez', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('practice', ['login.ez']));
  }, 400_000);

  it('code journey: logins.journey.ts (data-driven from JSON)', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('practice', ['logins.journey.ts']));
  }, 400_000);
});
