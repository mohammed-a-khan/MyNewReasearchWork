/**
 * Acceptance on rahulshettyacademy.com/AutomationPractice: radio buttons with broken labels, an autocomplete, a
 * dropdown, checkboxes, a hover menu, alerts that echo a typed name, an iframe and a new tab. Recorded with a
 * visible browser, written by hand in .ez, and as a code journey that adds up a table.
 *
 *   EZTEST_ONLINE=1 xvfb-run -a npm test -- test/acceptance/web/rahulshetty
 */
import { beforeAll, describe, expect, it } from '../../support/testkit.js';
import { announce, bodyOf, click, DISPLAY, expectPassed, expectPlainEnglish, fill, hover, ONLINE, record, replay, runProject, settle, siteDown } from './support.js';

const SITE = 'https://rahulshettyacademy.com/AutomationPractice/';
announce('rahulshetty.test.ts');

let down: string | undefined;
function needSite(ctx: { skip(note?: string): never }): void {
  if (down) {
    console.warn(`[acceptance/web] rahulshettyacademy skipped: ${down}`);
    ctx.skip(down);
  }
}

describe.skipIf(!ONLINE)('rahulshettyacademy.com practice page', () => {
  beforeAll(async () => {
    down = await siteDown(SITE);
  }, 90_000);

  it.skipIf(!DISPLAY)('recorded: radio, autocomplete, dropdown, checkbox, hover menu, alert, new tab', async (ctx) => {
    needSite(ctx);
    const r = await record(SITE, async (page, rec) => {
      page.on('dialog', (d) => setTimeout(() => void d.accept().catch(() => undefined), 500));
      await click(page, page.locator('input[value=radio2]'));
      await fill(page, page.locator('#autocomplete'), 'ind');
      await click(page, page.locator('.ui-menu-item div', { hasText: /^India$/ }));
      await page.locator('#dropdown-class-example').selectOption('option2');
      await click(page, page.locator('#checkBoxOption3'));
      await hover(page, page.locator('#mousehover'));
      await click(page, page.getByRole('link', { name: 'Top' }));
      await settle();
      await fill(page, page.locator('#name'), 'Ada');
      await click(page, page.locator('#alertbtn'));
      await settle(1200);
      await click(page, page.getByRole('link', { name: 'Open Tab' }));
      await expect.poll(() => page.context().pages().length, { timeout: 30_000 }).toBe(2);
      await rec.addExpectation('the URL contains "qaclickacademy"');
      await settle(1000);
      await click(page, page.getByRole('heading', { name: 'Practice Page' }));
    });
    expectPlainEnglish(r);
    const lines = bodyOf(r);
    expect(lines).toContain('Check the Radio2 radio button');
    expect(lines).toContain('Type "ind" into the Type to Select Countries field');
    expect(lines).toContain('Click the "India" text');
    expect(lines).toContain('Check the Option3 checkbox');
    expect(lines).toContain('Hover over the "Mouse Hover" button');
    expect(lines).toContain('Click the "Top" link');
    expect(lines).toContain('Accept the next alert');
    expect(lines).toContain('Click the "Open Tab" link and switch to the new tab');
    expect(lines).toContain('Switch back to the main tab');
    expectPassed(await replay(r));
  }, 300_000);

  it('written by hand: practice-page.ez', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('rahulshetty', ['practice-page.ez']));
  }, 400_000);

  it('code journey: tables.journey.ts', async (ctx) => {
    needSite(ctx);
    expectPassed(await runProject('rahulshetty', ['tables.journey.ts']));
  }, 400_000);
});
