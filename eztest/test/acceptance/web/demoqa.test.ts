/**
 * Acceptance on demoqa.com (a site full of ads): alerts (also one that comes after 5 seconds), frames and nested
 * frames, new tabs and windows, a modal, select menus, a slider, a date picker, web tables and files. Recorded with a
 * visible browser, written by hand in .ez, and as code journeys; every one must replay green.
 *
 *   EZTEST_ONLINE=1 xvfb-run -a npm test -- test/acceptance/web/demoqa
 */
import { beforeAll, describe, expect, it } from '../../support/testkit.js';
import type { Page } from '../../../src/browser/index.js';
import { announce, bodyOf, click, DISPLAY, expectPassed, expectPlainEnglish, fill, ONLINE, record, replay, runProject, settle, siteDown } from './support.js';

const SITE = 'https://demoqa.com';
announce('demoqa.test.ts');

let down: string | undefined;
function needSite(ctx: { skip(note?: string): never }): void {
  if (down) {
    console.warn(`[acceptance/web] demoqa skipped: ${down}`);
    ctx.skip(down);
  }
}

/** The "Click me" button on the row of a label (demoqa has four buttons named "Click me"). */
const clickMe = (page: Page, label: string) => page.locator('.row', { hasText: label }).getByRole('button', { name: 'Click me' });

describe.skipIf(!ONLINE)('demoqa.com', () => {
  beforeAll(async () => {
    down = await siteDown(`${SITE}/alerts`);
  }, 90_000);

  describe.skipIf(!DISPLAY)('recorded by using the site', () => {
    it('four alert buttons named alike, a delayed alert, a confirm and a prompt', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/alerts`, async (page) => {
        page.on('dialog', (d) => setTimeout(() => void (d.type() === 'prompt' ? d.accept('Grace') : d.accept()).catch(() => undefined), 500));
        await click(page, clickMe(page, 'Click Button to see alert'));
        await settle(1200);
        await click(page, clickMe(page, 'alert will appear after 5 seconds'));
        await settle(7000);
        await click(page, clickMe(page, 'confirm box will appear'));
        await settle(1200);
        await click(page, clickMe(page, 'prompt box will appear'));
        await settle(1200);
      });
      expectPlainEnglish(r);
      const lines = bodyOf(r);
      // Four "Click me" buttons: each is named by the label next to it, in words.
      expect(lines.filter((l) => /^Click the "Click me" button /.test(l)).length).toBe(4);
      expect(lines).toContain('Accept the next confirm dialog');
      expect(lines).toContain('Answer the next prompt with "Grace"');
      expect(lines).toContain('  Expect an alert saying "This alert appeared after 5 seconds"');
      expectPassed(await replay(`${r.ez}\nExpect the page contains "You entered Grace"\nExpect the page contains "You selected Ok"\n`));
    }, 300_000);

    it('a new tab, a new window and frames', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/browser-windows`, async (page, rec) => {
        await click(page, page.getByRole('button', { name: 'New Tab' }));
        await expect.poll(() => page.context().pages().length, { timeout: 30_000 }).toBe(2);
        const tab = page.context().pages()[1];
        await tab.waitForLoadState('domcontentloaded');
        await rec.addExpectation('the page contains "This is a sample page"');
        await settle(1200);
        await tab.close();
        await settle(800);
        await page.goto(`${SITE}/frames`);
        await page.keyboard.down('Alt');
        await click(page, page.frameLocator('#frame1').getByRole('heading', { name: 'This is a sample page' }));
        await page.keyboard.up('Alt');
        await settle();
      });
      expectPlainEnglish(r);
      const lines = bodyOf(r);
      expect(lines.slice(0, 5)).toEqual([
        'Open /browser-windows',
        'Click the "New Tab" button and switch to the new tab',
        '  Expect URL contains "/sample"',
        '  Expect page contains "This is a sample page"',
        'Close the tab',
      ]);
      expect(lines).toContain('In frame "frame1"');
      expect(lines.some((l) => /Assert that the "This is a sample page" heading contains "This is a sample page"/.test(l))).toBe(true);
      expectPassed(await replay(r));
    }, 300_000);

    it('a registration form in a modal of a web table', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/webtables`, async (page, rec) => {
        await click(page, page.getByRole('button', { name: 'Add' }));
        await expect.poll(() => page.getByRole('dialog').isVisible(), { timeout: 30_000 }).toBe(true);
        await settle(800);
        await fill(page, page.getByPlaceholder('First Name'), 'Grace');
        await fill(page, page.getByPlaceholder('Last Name'), 'Hopper');
        await fill(page, page.getByPlaceholder('name@example.com'), 'grace@example.com');
        await fill(page, page.getByPlaceholder('Age'), '85');
        await fill(page, page.getByPlaceholder('Salary'), '9000');
        await fill(page, page.getByPlaceholder('Department'), 'Navy');
        await click(page, page.getByRole('button', { name: 'Submit' }));
        await expect.poll(() => page.getByText('grace@example.com').isVisible(), { timeout: 30_000 }).toBe(true);
        await rec.addExpectation('the page contains "grace@example.com"');
      });
      expectPlainEnglish(r);
      const lines = bodyOf(r);
      expect(lines).toContain('Type "Grace" into the First Name field');
      expect(lines).toContain('Type "grace@example.com" into the name@example.com field');
      expect(lines).toContain('Click the "Submit" button');
      expectPassed(await replay(r));
    }, 300_000);
  });

  describe('written by hand in .ez', () => {
    for (const file of ['alerts-frames-windows.ez', 'widgets.ez']) {
      it(file, async (ctx) => {
        needSite(ctx);
        expectPassed(await runProject('demoqa', [file]));
      }, 400_000);
    }
  });

  describe('code journeys', () => {
    it('web-tables.journey.ts', async (ctx) => {
      needSite(ctx);
      expectPassed(await runProject('demoqa', ['web-tables.journey.ts']));
    }, 400_000);
  });
});
