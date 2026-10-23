/**
 * The browser's own favicon fetch (full Chrome asks for /favicon.ico after
 * a page loads; the headless shell does not) is not page traffic: no request
 * events, and it never holds up networkidle, also when the app redirects it
 * (to a login page, say) and the redirect target hangs.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { ChromiumBrowserType } from '../../src/browser/chromium/browser.js';
import { findChromium } from '../../src/browser/launcher/find.js';
import type { Browser } from '../../src/browser/index.js';

// The Chromium driver itself (not the suite's browser alias): this checks a Chromium-only behaviour, also in the Firefox run.
const chromium = new ChromiumBrowserType();

/** Full Chrome (findChromium prefers it over the headless shell unless asked): the shell fetches no favicon. */
const fullChrome = (() => {
  try {
    const f = findChromium();
    return f.headlessShell ? undefined : f.executablePath;
  } catch {
    return undefined;
  }
})();

describe.skipIf(!fullChrome)('browser favicon fetch', () => {
  let server: Server;
  let base = '';
  let browser: Browser;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/favicon.ico') {
        res.writeHead(302, { location: '/login-hangs' });
        return res.end();
      }
      if (req.url === '/login-hangs') return undefined; // never answers
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<title>t</title><h1>hello</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: fullChrome });
  });
  afterAll(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('is invisible to request events and does not hold up networkidle', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const seen: string[] = [];
    page.on('request', (r) => seen.push(new URL(r.url()).pathname));
    await page.route('**/*', (route) => route.continue());
    await page.goto(base);
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
    expect(seen).toEqual(['/']);
    await ctx.close();
  });
});
