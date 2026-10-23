/**
 * Regression: page.setContent() on a page whose document hosts a frame in an
 * <object> (or <embed>), followed by content with an <iframe srcdoc>, used to
 * make Chromium's browser process exit ("Browser has been closed").
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser } from '../../src/browser/index.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

describe('setContent after an <object> frame', () => {
  for (const data of ['data:text/plain,hello', 'data:text/html,<p>hi</p>']) {
    it(`replaces a page with <object data="${data}"> by one with an <iframe srcdoc>`, async () => {
      const page = await browser.newPage();
      await page.setContent(`<object data="${data}" style="width:60px;height:30px"></object>`);
      await expect.poll(() => page.frames().length).toBe(2);
      await page.setContent('<iframe title="Inline" srcdoc="<p id=x>inside</p>"></iframe><p>after</p>');
      await expect.poll(() => page.frames().length).toBe(2);
      const inner = page.frames().find((f) => f !== page.mainFrame())!;
      await expect.poll(() => inner.evaluate('document.getElementById("x") && document.getElementById("x").textContent')).toBe('inside');
      expect(await page.locator('p').textContent()).toBe('after');
      expect(browser.isConnected()).toBe(true);
      // The page keeps working: a second rewrite and a navigation.
      await page.setContent('<p>again</p>');
      expect(await page.locator('p').textContent()).toBe('again');
      await page.close();
    });
  }
});
