/**
 * Clicks that navigate late: the click waits for a navigation the page starts
 * after async work (a 200 ms fetch, then `window.location = ...`), within the
 * context's navigation window; a navigation that never commits fails the
 * click instead of being ignored; a click that navigates nowhere stays quick.
 * Runs on Chromium and, with EZTEST_BROWSER=firefox, on Firefox.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser } from '../../src/browser/index.js';

let server: Server;
let base: string;
let browser: Browser;
const hanging: ServerResponse[] = [];

const START = `<title>Start</title>
<button id="fetch-then-go">Fetch, then go</button>
<button id="timer-then-go">Wait, then go</button>
<button id="stay">Stay</button>
<button id="hang">Go to a page that never answers</button>
<p id="note"></p>
<script>
  document.getElementById('fetch-then-go').onclick = async () => {
    const r = await fetch('/slow-api');
    const j = await r.json();
    window.location.href = '/next?from=' + j.from;
  };
  document.getElementById('timer-then-go').onclick = async () => {
    await new Promise((r) => setTimeout(r, 200));
    window.location.href = '/next?from=timer';
  };
  document.getElementById('stay').onclick = () => { document.getElementById('note').textContent = 'stayed'; };
  document.getElementById('hang').onclick = () => { window.location.href = '/hang'; };
</script>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow-api') {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ from: 'fetch' }));
      }, 200);
      return;
    }
    if (req.url === '/hang') {
      hanging.push(res); // never answered
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/next')) res.end(`<title>Next</title><h1>Arrived ${new URL(req.url, 'http://x').searchParams.get('from')}</h1>`);
    else res.end(START);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  for (const r of hanging) r.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('clicks that navigate late', () => {
  it('waits for a navigation started after 200 ms of async work (fetch, then window.location)', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (let i = 0; i < 3; i++) {
      await page.goto(`${base}/`);
      await page.locator('#fetch-then-go').click();
      // No wait of our own: the click has waited for the navigation to commit.
      expect(page.url()).toBe(`${base}/next?from=fetch`);
      expect(await page.evaluate(() => document.title)).toBe('Next');
    }
    await ctx.close();
  });

  it('waits for a timer-delayed navigation within a configured navigation window', async () => {
    const ctx = await browser.newContext({ navigationWindow: 600 });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await page.locator('#timer-then-go').click();
    expect(page.url()).toBe(`${base}/next?from=timer`);
    expect(await page.evaluate(() => document.title)).toBe('Next');
    await ctx.close();
  });

  it('a click that starts no navigation returns after the short quiet window', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    const t0 = Date.now();
    await page.locator('#stay').click();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await page.locator('#note').textContent()).toBe('stayed');
    expect(page.url()).toBe(`${base}/`);
    await ctx.close();
  });

  it('a navigation that never commits fails the click (no longer swallowed); noWaitAfter opts out', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await expect(page.locator('#hang').click({ timeout: 1500 })).rejects.toThrow(/locator\.click: the action started a navigation that did not finish loading within 1500 ms .*noWaitAfter/s);
    await page.goto(`${base}/`);
    await page.locator('#hang').click({ timeout: 1500, noWaitAfter: true });
    await ctx.close();
  });
});
