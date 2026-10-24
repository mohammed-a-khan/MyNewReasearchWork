/**
 * Options that used to be accepted and silently ignored now work or fail
 * clearly: recordHar writes a HAR on context close (the runner's HAR
 * builder), page.pause() hands off to the live debugger or throws,
 * strictSelectors makes handle queries need one match, and launch() rejects
 * logger / tracesDir.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser } from '../../src/browser/index.js';
import { DebugController } from '../../src/runner/index.js';
import type { Step } from '../../src/core/index.js';

let server: Server;
let base: string;
let browser: Browser;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/items')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: ['alpha', 'beta'] }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<title>Shop</title><ul><li>one</li><li>two</li></ul><p id="out"></p>
<script>fetch('/api/items?q=a').then((r) => r.json()).then((j) => { document.getElementById('out').textContent = j.items.join(','); });</script>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  dir = await mkdtemp(join(tmpdir(), 'eztest-silent-'));
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

async function visit(options: Record<string, unknown>): Promise<void> {
  const ctx = await browser.newContext(options as never);
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.getElementById('out')?.textContent === 'alpha,beta');
  await ctx.close();
}

describe('recordHar', () => {
  it('writes every request of the context, with text bodies, when the context closes', async () => {
    const path = join(dir, 'all', 'run.har');
    await visit({ recordHar: { path } });
    const har = JSON.parse(await readFile(path, 'utf8'));
    expect(har.log).toMatchObject({ version: '1.2', creator: { name: 'EZTest' } });
    const urls = har.log.entries.map((e: { request: { url: string } }) => e.request.url);
    expect(urls).toContain(`${base}/`);
    const api = har.log.entries.find((e: { request: { url: string } }) => e.request.url.includes('/api/items'));
    expect(api.response.status).toBe(200);
    expect(JSON.parse(api.response.content.text)).toEqual({ items: ['alpha', 'beta'] });
    expect(api.request.queryString).toEqual([{ name: 'q', value: 'a' }]);
  });

  it('urlFilter keeps matching requests only; content "omit" drops bodies', async () => {
    const path = join(dir, 'api.har');
    await visit({ recordHar: { path, urlFilter: /\/api\//, content: 'omit' } });
    const har = JSON.parse(await readFile(path, 'utf8'));
    expect(har.log.entries.length).toBe(1);
    expect(har.log.entries[0].request.url).toContain('/api/items');
    expect(har.log.entries[0].response.content.text).toBeUndefined();
  });

  it('rejects options it cannot honour', async () => {
    await expect(browser.newContext({ recordHar: { path: join(dir, 'x.har'), content: 'attach' } })).rejects.toThrow(/content "attach" is not supported/);
    await expect(browser.newContext({ recordHar: {} as never })).rejects.toThrow(/recordHar needs a path/);
  });
});

describe('page.pause()', () => {
  it('throws without a debugger instead of continuing', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await expect(page.pause()).rejects.toThrow(/page\.pause\(\) needs a live debugger: run the journey with `eztest debug` or from the Studio debugger/);
    await ctx.close();
  });

  it('pauses the attached debugger until it resumes', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const dbg = new DebugController();
    const step = { id: 's1', intent: 'Inspect the page', action: 'code' } as unknown as Step;
    dbg.attach({ journey: { id: 'j', name: 'J', steps: [step] } as never, attempt: 1, page, context: ctx, ledger: () => ({}), vars: () => ({}), conditionEnv: () => ({}) as never, runAdHoc: async () => ({}) as never });
    dbg.stepStarted(0, step);
    let resumed = false;
    const paused = page.pause().then(() => (resumed = true));
    const st = await dbg.waitForPause(5000);
    expect(st).toMatchObject({ status: 'paused', reason: 'page.pause()', stepIndex: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(resumed).toBe(false);
    dbg.resume();
    await paused;
    expect(resumed).toBe(true);
    dbg.detach();
    await expect(page.pause()).rejects.toThrow(/needs a live debugger/);
    await ctx.close();
  });
});

describe('strictSelectors', () => {
  it('handle queries need exactly one match when on, take the first when off', async () => {
    const off = await browser.newContext();
    const p1 = await off.newPage();
    await p1.setContent('<ul><li>one</li><li>two</li></ul>');
    expect(await (await p1.$('li'))!.textContent()).toBe('one');
    await off.close();
    const on = await browser.newContext({ strictSelectors: true });
    const p2 = await on.newPage();
    await p2.setContent('<ul><li>one</li><li>two</li></ul><p>x</p>');
    await expect(p2.$('li')).rejects.toThrow(/\$: The locator "li" matched 2 elements, but this needs exactly one.*strictSelectors is on/s);
    await expect(p2.$eval('li', (e) => e.textContent)).rejects.toThrow(/matched 2 elements/);
    expect(await p2.$eval('p', (e) => e.textContent)).toBe('x');
    await expect(p2.waitForSelector('li', { timeout: 1000 })).rejects.toThrow(/matched 2 elements/);
    await on.close();
  });
});

describe('launch options that are not supported', () => {
  it('logger and tracesDir are rejected with what to use instead', async () => {
    await expect(chromium.launch({ logger: {} })).rejects.toThrow(/"logger" option is not supported; set EZTEST_DEBUG/);
    await expect(chromium.launch({ tracesDir: dir })).rejects.toThrow(/"tracesDir" option is not supported/);
  });
});
