/**
 * Acceptance on the-internet.herokuapp.com: forms, alerts, frames and nested frames, a rich-text editor in an
 * iframe, multiple windows, hovers, drag and drop, context menu, keys, shadow DOM, tricky generated DOM, tables,
 * dynamic pages, uploads and downloads, basic auth. Recorded with a visible browser like a person, written by hand
 * in .ez, and as TypeScript code journeys; every one must replay green.
 *
 *   EZTEST_ONLINE=1 xvfb-run -a npm test -- test/acceptance/web/the-internet
 */
import { beforeAll, describe, expect, it } from '../../support/testkit.js';
import { join } from 'node:path';
import type { FileChooser, Page } from '../../../src/browser/index.js';
import { announce, bodyOf, click, DISPLAY, drag, expectPassed, expectPlainEnglish, fill, HERE, hover, ONLINE, record, replay, runProject, settle, siteDown, type } from './support.js';

const SITE = 'https://the-internet.herokuapp.com';
const PASSWORD = 'SuperSecretPassword!';
announce('the-internet.test.ts');

let down: string | undefined;
type Ctx = { skip(note?: string): never };
function needSite(ctx: Ctx): void {
  if (down) {
    console.warn(`[acceptance/web] the-internet skipped: ${down}`);
    ctx.skip(down);
  }
}

/** A person answering JavaScript dialogs: OK on alerts, Cancel on confirms, a name in prompts. */
function answerDialogs(page: Page, prompt = 'Ada'): void {
  page.on('dialog', (d) => {
    setTimeout(() => void (d.type() === 'prompt' ? d.accept(prompt) : d.type() === 'confirm' ? d.dismiss() : d.accept()).catch(() => undefined), 400);
  });
}

describe.skipIf(!ONLINE)('the-internet.herokuapp.com', () => {
  beforeAll(async () => {
    down = await siteDown(SITE);
  }, 90_000);

  describe.skipIf(!DISPLAY)('recorded by using the site', () => {
    it('form login: typed credentials, an expectation added while recording, logout', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/login`, async (page, rec) => {
        await fill(page, page.getByLabel('Username'), 'tomsmith');
        await fill(page, page.getByLabel('Password'), PASSWORD);
        await click(page, page.getByRole('button', { name: 'Login' }));
        await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/secure');
        await rec.addExpectation('verify I see "You logged into a secure area!"');
        await click(page, page.getByRole('link', { name: 'Logout' }));
        await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/login');
      });
      expectPlainEnglish(r);
      expect(r.ez).not.toContain(PASSWORD);
      expect(bodyOf(r)).toEqual([
        'Open /login',
        'Type "tomsmith" into the Username field',
        'Type "${password}" into the Password field',
        'Click the "Login" button',
        '  Expect URL contains "/secure"',
        '  Expect page contains "You logged into a secure area!"',
        'Click the "Logout" link',
        '  Expect URL contains "/login"',
      ]);
      expectPassed(await replay(r, { password: PASSWORD }));
    }, 300_000);

    it('JavaScript alert, confirm and prompt, answered by the person', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/javascript_alerts`, async (page) => {
        answerDialogs(page, 'Ada');
        for (const name of ['Click for JS Alert', 'Click for JS Confirm', 'Click for JS Prompt']) {
          await click(page, page.getByRole('button', { name }));
          await settle(1200);
        }
      });
      expectPlainEnglish(r);
      expect(bodyOf(r)).toEqual([
        'Open /javascript_alerts',
        'Accept the next alert',
        'Click the "Click for JS Alert" button',
        '  Expect an alert saying "I am a JS Alert"',
        'Dismiss the next confirm dialog',
        'Click the "Click for JS Confirm" button',
        '  Expect a confirm dialog saying "I am a JS Confirm"',
        'Answer the next prompt with "Ada"',
        'Click the "Click for JS Prompt" button',
        '  Expect a prompt dialog saying "I am a JS prompt"',
      ]);
      const run = await replay(`${r.ez}\nExpect the page contains "You entered: Ada"\n`);
      expectPassed(run);
    }, 300_000);

    it('nested frames and a rich-text editor in an iframe become In frame blocks', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/nested_frames`, async (page, rec) => {
        const middle = page.frameLocator('frame[name="frame-top"]').frameLocator('frame[name="frame-middle"]');
        await click(page, middle.locator('#content'));
        await rec.addExpectation('the page contains "MIDDLE"');
        await click(page, page.frameLocator('frame[name="frame-bottom"]').locator('body'));
        await page.goto(`${SITE}/iframe`);
        const editor = page.frameLocator('#mce_0_ifr').locator('body');
        await expect.poll(() => editor.getAttribute('contenteditable'), { timeout: 30_000 }).toBe('true');
        await settle(2000); // the editor's toolbar finishes drawing; a person waits for it too
        await click(page, editor);
        await page.keyboard.press('Control+A');
        await type(page, 'Typed by a person');
        await click(page, page.getByRole('heading', { name: /An iFrame containing/ }));
      });
      expectPlainEnglish(r);
      const lines = bodyOf(r);
      expect(lines).toContain('In frame "frame-top" > "frame-middle"');
      expect(lines).toContain('In frame "frame-bottom"');
      expect(lines).toContain('In frame "Rich Text Area"');
      expect(lines.some((l) => /^ {2}Type "Typed by a person" into the "Rich Text Area\. Press ALT-0 for help\." field$/.test(l))).toBe(true);
      expect(lines.filter((l) => l === 'End').length).toBe(3);
      const run = await replay(r);
      expectPassed(run);
    }, 300_000);

    it('a link that opens a new window: followed, checked there, closed, and back in the first window', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/windows`, async (page, rec) => {
        await click(page, page.getByRole('link', { name: 'Click Here' }));
        await expect.poll(() => page.context().pages().length, { timeout: 30_000 }).toBe(2);
        const popup = page.context().pages()[1];
        await popup.waitForLoadState('domcontentloaded');
        await rec.addExpectation('the page contains "New Window"');
        await click(popup, popup.getByRole('heading', { name: 'New Window' }));
        await settle(1500);
        await popup.close();
        await settle(800);
        await click(page, page.getByRole('heading', { name: 'Opening a new window' }));
      });
      expectPlainEnglish(r);
      expect(bodyOf(r)).toEqual([
        'Open /windows',
        'Click the "Click Here" link and switch to the new tab',
        '  Expect URL contains "/windows/new"',
        '  Expect page contains "New Window"',
        'Click the "New Window" heading',
        'Close the tab',
        'Click the "Opening a new window" heading',
      ]);
      expectPassed(await replay(r));
    }, 300_000);

    it('hover menus, drag and drop, a context menu and its alert', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/hovers`, async (page) => {
        await hover(page, page.getByAltText('User Avatar').nth(1));
        await click(page, page.locator('.figure').nth(1).getByRole('link', { name: 'View profile' }));
        await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/users/2');
        await page.goto(`${SITE}/drag_and_drop`);
        await drag(page, page.locator('#column-a'), page.locator('#column-b'));
        await expect.poll(() => page.locator('#column-a').textContent()).toContain('B');
        await page.goto(`${SITE}/context_menu`);
        answerDialogs(page);
        await click(page, page.locator('#hot-spot'), { button: 'right' });
        await settle(1200);
      });
      expectPlainEnglish(r);
      const lines = bodyOf(r);
      expect(lines.slice(0, 4)).toEqual([
        'Open /hovers',
        'Hover over the "User Avatar" image in the row containing "name: user2"',
        'Click the "View profile" link',
        '  Expect URL contains "/users/2"',
      ]);
      expect(lines).toContain('Drag #column-a to #column-b');
      expect(lines).toContain('Accept the next alert');
      expect(lines).toContain('Right-click #hot-spot');
      expect(lines).toContain('  Expect an alert saying "You selected a context menu"');
      expectPassed(await replay(`${r.ez}\nOpen /drag_and_drop\nDrag #column-a to #column-b\n  Expect the text of #column-a is "B"\n`));
    }, 300_000);

    it('keys, shadow DOM, checkboxes, a dropdown, a sorted table and generated ids', async (ctx) => {
      needSite(ctx);
      const r = await record(`${SITE}/key_presses`, async (page, rec) => {
        await click(page, page.locator('#target'));
        await page.keyboard.press('Tab');
        await settle();
        await rec.addExpectation('the page contains "You entered: TAB"');
        await page.goto(`${SITE}/shadowdom`);
        await page.keyboard.down('Alt');
        await click(page, page.locator('my-paragraph').first().locator('span'));
        await page.keyboard.up('Alt');
        await page.goto(`${SITE}/checkboxes`);
        await click(page, page.locator('#checkboxes input').first());
        await click(page, page.locator('#checkboxes input').nth(1));
        await page.goto(`${SITE}/dropdown`);
        await page.locator('#dropdown').selectOption('2');
        await page.goto(`${SITE}/tables`);
        await click(page, page.locator('#table1 th').filter({ hasText: 'Last Name' }));
        await click(page, page.locator('#table1 tr').filter({ hasText: 'Doe' }).getByRole('link', { name: 'edit' }));
        await page.goto(`${SITE}/challenging_dom`);
        await click(page, page.locator('table tr').filter({ hasText: 'Iuvaret7' }).getByRole('link', { name: 'delete' }));
      });
      expectPlainEnglish(r);
      const lines = bodyOf(r);
      expect(lines).toContain('Press Tab in #target');
      expect(lines).toContain('  Expect page contains "You entered: TAB"');
      expect(lines.some((l) => /Expect the 1st "Let's have some different text!" text contains "Let's have some different text!"/.test(l))).toBe(true);
      // No <label>s on these pages: the words next to the boxes and the heading before the list name them.
      expect(lines).toContain('Check the checkbox 1 checkbox');
      expect(lines).toContain('Uncheck the checkbox 2 checkbox');
      expect(lines).toContain('Select "Option 2" from the Dropdown List dropdown');
      expect(lines).toContain('Click the "edit" link in the row containing "Doe" inside #table1');
      expect(lines).toContain('Click the "delete" link in the row containing "Iuvaret7"');
      expectPassed(await replay(r));
    }, 300_000);

    it('slow pages, a field that becomes enabled, an upload chosen in the file dialog and a download', async (ctx) => {
      needSite(ctx);
      const file = join(HERE, 'journeys', 'the-internet', 'data', 'upload-me.txt');
      const r = await record(`${SITE}/dynamic_loading/1`, async (page, rec) => {
        await click(page, page.getByRole('button', { name: 'Start' }));
        await expect.poll(() => page.getByText('Hello World!').isVisible(), { timeout: 30_000 }).toBe(true);
        await rec.addExpectation('the page contains "Hello World!"');
        await page.goto(`${SITE}/dynamic_controls`);
        await click(page, page.getByRole('button', { name: 'Enable' }));
        await expect.poll(() => page.locator('#input-example input').isEnabled(), { timeout: 30_000 }).toBe(true);
        await fill(page, page.locator('#input-example input'), 'now enabled');
        await page.goto(`${SITE}/upload`);
        const chooser = page.waitForEvent('filechooser') as Promise<FileChooser>;
        await click(page, page.locator('#file-upload'));
        await (await chooser).setFiles(file);
        await click(page, page.getByRole('button', { name: 'Upload' }));
        await expect.poll(() => page.getByText('File Uploaded!').isVisible(), { timeout: 30_000 }).toBe(true);
        await page.goto(`${SITE}/download`);
        const link = page.locator('#content a').first();
        await click(page, link);
        await settle(2000);
      });
      expectPlainEnglish(r, [/css=input\[type="text"\]/]);
      const lines = bodyOf(r);
      expect(lines.slice(0, 3)).toEqual(['Open /dynamic_loading/1', 'Click the "Start" button', '  Expect page contains "Hello World!"']);
      expect(lines).toContain('Click the "Enable" button');
      if (process.env.EZTEST_BROWSER !== 'firefox') {
        // Chromium tells where the chosen file is, so the step needs no editing.
        expect(lines).toContain('Upload "test/acceptance/web/journeys/the-internet/data/upload-me.txt" to #file-upload');
      }
      expect(lines.some((l) => /^Download the "[^"]+" link as \w+$/.test(l))).toBe(true);
      const ez = process.env.EZTEST_BROWSER === 'firefox' ? r.ez.replace(/Upload "upload-me\.txt"/, `Upload "${file}"`) : r.ez;
      expectPassed(await replay(ez));
    }, 300_000);
  });

  describe('written by hand in .ez', () => {
    for (const file of ['login-and-auth.ez', 'alerts-frames-windows.ez', 'mouse-keys-dom.ez', 'dynamic-pages.ez', 'files.ez']) {
      it(file, async (ctx) => {
        needSite(ctx);
        expectPassed(await runProject('the-internet', [file]));
      }, 400_000);
    }
  });

  describe('code journeys', () => {
    for (const file of ['tables.journey.ts', 'logins.journey.ts', 'windows-frames.journey.ts']) {
      it(file, async (ctx) => {
        needSite(ctx);
        expectPassed(await runProject('the-internet', [file]));
      }, 400_000);
    }
  });
});
