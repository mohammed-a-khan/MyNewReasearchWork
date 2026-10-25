/**
 * Request interception lifecycle (CDP Fetch domain): requests paused while routes were set, and answered after the
 * last route was removed (Fetch.disable), are released by the browser with the domain. Answering them then
 * (Fetch.continueRequest on a disabled domain) is not an error, and never an unhandled rejection that kills a
 * worker; a protocol error for a request of the current interception still is.
 *
 * Seen as "ProtocolError: Fetch.continueRequest: Fetch domain is not enabled" while a cached role session was
 * checked on a busy page (a dashboard that keeps requesting): the check routes requests leaving the app's origin
 * while it opens verifyUrl and unroutes afterwards.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { ChromiumBrowserType } from '../../src/browser/chromium/browser.js';
import type { Browser, Route } from '../../src/browser/index.js';

const chromium = new ChromiumBrowserType();

describe('routes removed while requests are paused', () => {
  let server: Server;
  let base = '';
  let browser: Browser;
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/busy') {
        // A dashboard that keeps requesting: images, scripts and fetches, all the time.
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><title>busy</title><h1>Dashboard</h1>
          ${Array.from({ length: 30 }, (_, i) => `<img src="/img/${i}.png">`).join('')}
          <script>
            let n = 0;
            setInterval(() => { for (let i = 0; i < 4; i++) fetch('/api/poll?' + (n++)).catch(() => {}); }, 5);
          </script>`);
      }
      if (path.startsWith('/img/')) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(Buffer.alloc(0));
        }, 5);
        return undefined;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ path }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
    process.on('unhandledRejection', onRejection);
  });
  afterAll(async () => {
    process.off('unhandledRejection', onRejection);
    await browser?.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('a handler that continues after unroute: no error, and the request completes', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/start`);
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    let continued: Error | 'ok' | undefined;
    const handler = async (route: Route) => {
      entered();
      await new Promise((r) => setTimeout(r, 300));
      try {
        await route.continue();
        continued = 'ok';
      } catch (e) {
        continued = e as Error;
      }
    };
    await page.route('**/slow', handler);
    const answer = page.evaluate(`fetch('/slow').then((r) => r.json())`);
    await inHandler;
    await page.unroute('**/slow', handler);
    expect(await answer).toEqual({ path: '/slow' });
    await page.waitForTimeout(400);
    expect(continued).toBe('ok');
    await ctx.close();
  });

  it('route, open a busy page and unroute, again and again (the cached-session check): no unhandled rejection', async () => {
    const before = rejections.length;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const origin = new URL(base).origin;
    const leaving = (u: URL) => u.origin !== origin;
    const stop = async (route: Route) => {
      if (route.request().isNavigationRequest()) await route.abort();
      else await route.continue();
    };
    for (let i = 0; i < 12; i++) {
      await page.route(leaving, stop);
      await page.goto(`${base}/busy`);
      await page.unroute(leaving, stop);
      await page.waitForTimeout(30);
    }
    // The page keeps working without interception.
    expect(await page.evaluate(`fetch('/after').then((r) => r.json())`)).toEqual({ path: '/after' });
    await page.waitForTimeout(500);
    const mine = rejections.slice(before).map((e) => String((e as Error)?.message ?? e));
    expect(mine).toEqual([]);
    await ctx.close();
  });

  it('a protocol error for a request of the current interception still reaches the caller', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/start`);
    let outcome: string | undefined;
    await page.route('**/bad', async (route) => {
      try {
        await route.continue({ headers: { 'bad header\n': 'v' } });
        outcome = 'no error';
      } catch (e) {
        outcome = (e as Error).message;
        await route.request().frame()?.page().unrouteAll();
      }
    });
    void page.evaluate(`fetch('/bad').catch(() => {})`);
    await page.waitForTimeout(600);
    expect(outcome).toMatch(/Fetch\.continueRequest/);
    await ctx.close();
  });
});
