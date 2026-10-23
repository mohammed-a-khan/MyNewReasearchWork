/**
 * innerText is the same on both engines for drop-downs: Firefox's native
 * innerText leaves a rendered <select> out entirely, Chromium lists its
 * options. The driver adds the missing option texts, so "the page contains
 * <an option>" (and locator.innerText) behave alike.
 */
import { describe, expect, it } from '../support/testkit.js';
import { ChromiumBrowserType } from '../../src/browser/chromium/browser.js';
import { FirefoxBrowserType } from '../../src/browser/firefox/browser.js';
import { findFirefox } from '../../src/browser/firefox/launch.js';
import { findChromium } from '../../src/browser/launcher/find.js';

const has = (f: () => unknown) => {
  try {
    return !!f();
  } catch {
    return false;
  }
};

const HTML = `<p>Customer <select id=c><option>Contoso Ltd</option><option>Northwind  Traders</option></select></p>
<select id=hidden style="display:none"><option>Hidden option</option></select><p>after</p>`;

const engines = [
  { name: 'chromium', ok: has(() => findChromium()), make: () => new ChromiumBrowserType() },
  { name: 'firefox', ok: has(() => findFirefox()), make: () => new FirefoxBrowserType() },
];

describe('innerText with <select>', () => {
  for (const e of engines) {
    it.skipIf(!e.ok)(`${e.name}: lists the options of rendered selects only`, async () => {
      const browser = await (e.make() as ChromiumBrowserType).launch();
      try {
        const page = await (await browser.newContext()).newPage();
        await page.setContent(HTML);
        const body = await page.locator('body').innerText();
        expect(body).toContain('Customer');
        expect(body).toContain('Contoso Ltd');
        expect(body).toMatch(/Northwind\s+Traders/);
        expect(body).toContain('after');
        expect(body).not.toContain('Hidden option');
        expect((await page.locator('#c').innerText()).split('\n').map((s) => s.trim()).filter(Boolean)).toEqual(['Contoso Ltd', 'Northwind Traders']);
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
});
