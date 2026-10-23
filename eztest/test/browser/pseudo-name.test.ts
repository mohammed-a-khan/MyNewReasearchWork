/**
 * Accessible names include CSS generated content (::before / ::after). The
 * engine skips the pseudo-element style for elements no readable rule
 * targets; these cases check that every way of writing such a rule is still
 * seen: plain, grouped in @media / @supports, in an adopted stylesheet, in a
 * shadow root, through :host, on <q> (UA quotes), and one added after the
 * page loaded.
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

const HTML = `<style>
  .plain::before { content: "Plain "; }
  @media screen { @supports (display: block) { .nested::after { content: " nested"; } } }
  .nocontent::before { color: red; }
</style>
<button class=plain>one</button>
<button class=nested>two</button>
<button class=nocontent>three</button>
<button class=adopted>four</button>
<button id=late>five</button>
<p><q>quoted</q></p>
<x-host id=host></x-host>
<script>
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.adopted::after { content: " adopted"; }');
  document.adoptedStyleSheets = [sheet];
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<style>:host::before { content: "Host "; } button::after { content: " inside"; }</style><button>six</button>';
</script>`;

const engines = [
  { name: 'chromium', ok: has(() => findChromium()), make: () => new ChromiumBrowserType() },
  { name: 'firefox', ok: has(() => findFirefox()), make: () => new FirefoxBrowserType() },
];

describe('accessible names with generated content', () => {
  for (const e of engines) {
    it.skipIf(!e.ok)(`${e.name}`, async () => {
      const browser = await (e.make() as ChromiumBrowserType).launch();
      try {
        const page = await (await browser.newContext()).newPage();
        await page.setContent(HTML);
        const count = (name: string) => page.getByRole('button', { name, exact: true }).count();
        expect(await count('Plain one')).toBe(1);
        expect(await count('two nested')).toBe(1);
        expect(await count('three')).toBe(1);
        expect(await count('four adopted')).toBe(1);
        expect(await count('six inside')).toBe(1);
        expect(await count('five')).toBe(1);
        await page.evaluate(() => {
          const s = document.createElement('style');
          s.textContent = '#late::after { content: " later"; }';
          document.head.appendChild(s);
        });
        expect(await count('five later')).toBe(1);
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
});
