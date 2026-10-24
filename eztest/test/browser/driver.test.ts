/**
 * EZTest browser driver (src/browser) against real Chromium and the demo app:
 * transport, launch, evaluate, input, network, dialogs, downloads,
 * frames / out-of-process iframes, popups, screenshots, video and tracing.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { chromium, devices, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { PipeTransport } from '../../src/browser/transport/transport.js';
import { CDPConnection } from '../../src/browser/transport/connection.js';
import { chromiumCommandLine, defaultChromiumArgs, sandboxFromEnv } from '../../src/browser/launcher/launch.js';
import { isBrowserFavicon } from '../../src/browser/chromium/network.js';
import { channelCandidates, findChromium } from '../../src/browser/launcher/find.js';
import { verifyArchive, crc32c } from '../../src/browser/launcher/install.js';
import { extractZip } from '../../src/browser/launcher/unzip.js';
import { writeZip } from '../../src/browser/zip-writer.js';
import { parseSelector } from '../../src/browser/selector-parser.js';
import { globToRegex, urlMatches } from '../../src/browser/util.js';
import { resolveKey } from '../../src/browser/input/us-layout.js';
import { muxWebM } from '../../src/browser/video/webm.js';
import { readZip } from '../../src/runner/trace/zip.js';
import { readBrowserTrace } from '../../src/runner/trace/browser-trace.js';
import type { BrowserTraceManifest } from '../../src/browser/trace-format.js';

let demo: DemoServer;
let browser: Browser;
const tmp = mkdtempSync(join(tmpdir(), 'ez-driver-'));

beforeAll(async () => {
  demo = await startDemoApp();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await demo?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function withPage<T>(fn: (page: Page, ctx: BrowserContext) => Promise<T>, options: Parameters<Browser['newContext']>[0] = {}): Promise<T> {
  const ctx = await browser.newContext(options);
  try {
    return await fn(await ctx.newPage(), ctx);
  } finally {
    await ctx.close();
  }
}

describe('transport', () => {
  it('frames NUL-delimited messages split across chunks', () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const t = new PipeTransport(out, input);
    const got: string[] = [];
    t.onmessage = (m) => got.push(m);
    input.write(Buffer.from('{"a":1}\0{"b"'));
    input.write(Buffer.from(':2}\0'));
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
    const sent: Buffer[] = [];
    out.on('data', (d: Buffer) => sent.push(d));
    t.send('{"id":1}');
    expect(Buffer.concat(sent).toString()).toBe('{"id":1}\0');
  });

  it('correlates responses, routes session events and rejects pending calls on close', async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const conn = new CDPConnection(new PipeTransport(out, input));
    out.on('data', (d: Buffer) => {
      for (const raw of d.toString().split('\0').filter(Boolean)) {
        const m = JSON.parse(raw);
        if (m.method === 'Echo.ok') input.write(`${JSON.stringify({ id: m.id, result: { v: m.params.v } })}\0`);
        if (m.method === 'Echo.fail') input.write(`${JSON.stringify({ id: m.id, error: { message: 'nope' } })}\0`);
      }
    });
    expect(await conn.root.send('Echo.ok', { v: 7 })).toEqual({ v: 7 });
    await expect(conn.root.send('Echo.fail')).rejects.toThrow(/Echo.fail.*nope/);
    input.write(`${JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: { type: 'page', targetId: 'T1' }, waitingForDebugger: false } })}\0`);
    const s = conn.session('S1')!;
    const events: unknown[] = [];
    s.on('Page.loadEventFired', (e) => events.push(e));
    input.write(`${JSON.stringify({ sessionId: 'S1', method: 'Page.loadEventFired', params: { timestamp: 1 } })}\0`);
    expect(events).toEqual([{ timestamp: 1 }]);
    const pending = conn.root.send('Never.answered');
    conn.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});

describe('launch', () => {
  it('finds a browser and builds a safe command line', () => {
    const found = findChromium();
    expect(existsSync(found.executablePath)).toBe(true);
    const args = chromiumCommandLine({ headless: true, args: ['--lang=de'] }, found, '/tmp/profile');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--lang=de');
    expect(args.some((a) => a.startsWith('--headless'))).toBe(true);
    // No sandbox override unless running as root.
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    expect(args.includes('--no-sandbox')).toBe(root);
    expect(chromiumCommandLine({ chromiumSandbox: true }, found, '/p')).not.toContain('--no-sandbox');
    expect(defaultChromiumArgs()).not.toContain('--no-sandbox');
    // EZTEST_CHROMIUM_SANDBOX (set to 0 in the Docker image, whose user is not root).
    // The browser's own favicon fetch is not page traffic; a page's fetch of it is.
    expect([isBrowserFavicon('http://a.test/favicon.ico', 'Other'), isBrowserFavicon('http://a.test/favicon.ico', 'Fetch'), isBrowserFavicon('http://a.test/x/favicon.ico', 'Other')]).toEqual([true, false, false]);
    expect([sandboxFromEnv(undefined), sandboxFromEnv(''), sandboxFromEnv('0'), sandboxFromEnv('false'), sandboxFromEnv('1'), sandboxFromEnv('true')]).toEqual([undefined, undefined, false, false, true, true]);
    expect(channelCandidates('msedge', 'linux')).toEqual(['/opt/microsoft/msedge/msedge']);
    expect(channelCandidates('chrome', 'darwin')[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(() => findChromium({ executablePath: '/nope/chrome' })).toThrow(/not found/);
  });

  it('reports its version, and closing removes the temporary profile and kills the process group', async () => {
    const b = await chromium.launch();
    expect(b.version()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const proc = b.process()!;
    const profile = (proc.spawnargs.find((a) => a.startsWith('--user-data-dir=')) ?? '').slice('--user-data-dir='.length);
    expect(existsSync(profile)).toBe(true);
    await b.close();
    expect(b.isConnected()).toBe(false);
    expect(existsSync(profile)).toBe(false);
    expect(() => process.kill(proc.pid!, 0)).toThrow();
  });

  it('verifies downloads by the storage server checksums and extracts zips with modes', async () => {
    const body = Buffer.from('chrome archive');
    const md5 = (await import('node:crypto')).createHash('md5').update(body).digest('base64');
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32c(body));
    expect(verifyArchive(body, `crc32c=${c.toString('base64')},md5=${md5}`)).toEqual(['crc32c', 'md5']);
    expect(() => verifyArchive(body, 'md5=AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(/mismatch/);
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
    const zip = writeZip([{ name: 'a/b.txt', data: Buffer.from('hello') }]);
    const dir = join(tmp, 'unz');
    await extractZip(zip, dir);
    expect(readFileSync(join(dir, 'a/b.txt'), 'utf8')).toBe('hello');
  });
});

describe('selectors, URL matching and keyboard layout', () => {
  it('parses selector strings into engine chains', () => {
    expect(parseSelector('button.primary')).toEqual([{ css: 'button.primary' }]);
    expect(parseSelector('xpath=//a')).toEqual([{ xpath: '//a' }]);
    expect(parseSelector('//div')).toEqual([{ xpath: '//div' }]);
    expect(parseSelector('text="Save"')).toEqual([{ text: 'Save', exact: true }]);
    expect(parseSelector('role=button[name="Go"] >> nth=1')).toEqual([{ role: 'button', name: 'Go' }, { nth: 1 }]);
    expect(parseSelector('li:has-text("Bravo"):visible')).toEqual([{ css: 'li' }, { hasText: 'Bravo' }, { visible: true }]);
  });

  it('matches globs, regexes and predicates', () => {
    expect(globToRegex('**/api/*').test('http://x/a/api/orders')).toBe(true);
    expect(globToRegex('**/api/*').test('http://x/a/api/orders/1')).toBe(false);
    expect(urlMatches(undefined, 'http://x/dashboard', '**/dashboard')).toBe(true);
    expect(urlMatches('http://x/', 'http://x/login', '/login')).toBe(true);
    expect(urlMatches(undefined, 'http://x/a', /a$/)).toBe(true);
    expect(urlMatches(undefined, 'http://x/a', (u) => u.pathname === '/a')).toBe(true);
  });

  it('knows the US layout', () => {
    expect(resolveKey('a')!.def).toMatchObject({ code: 'KeyA', keyCode: 65 });
    expect(resolveKey('A')).toMatchObject({ shifted: true });
    expect(resolveKey('!')!.def.code).toBe('Digit1');
    expect(resolveKey('Enter')!.def.text).toBe('\r');
    expect(resolveKey('Shift')!.def.code).toBe('ShiftLeft');
  });

  it('has device descriptors', () => {
    expect(devices['iPhone 13']).toMatchObject({ isMobile: true, hasTouch: true, deviceScaleFactor: 3, viewport: { width: 390 } });
    expect(devices['Pixel 7 landscape'].viewport.width).toBeGreaterThan(devices['Pixel 7 landscape'].viewport.height);
    expect(devices['Desktop Chrome'].isMobile).toBe(false);
  });
});

describe('pages, evaluation and input', () => {
  it('evaluates with handles, special values, dates and regexps in both worlds', async () => {
    await withPage(async (page) => {
      await page.setContent('<p id=p>hi</p>');
      const v = await page.evaluate((a) => ({ n: a.n + 1, d: a.d.getTime(), r: a.r.test('abc'), inf: Infinity, nan: NaN, neg: -0, u: undefined, big: BigInt(5) }), { n: 1, d: new Date(5), r: /b/ });
      expect(v).toEqual({ n: 2, d: 5, r: true, inf: Infinity, nan: NaN, neg: -0, u: undefined, big: 5n });
      const handle = await page.$('#p');
      expect(await page.evaluate((el) => (el as Element).textContent, handle)).toBe('hi');
      expect(await page.evaluate('1 + 2')).toBe(3);
      expect(await page.evaluate('() => 7')).toBe(7);
      const cyc = await page.evaluate(() => {
        const o: Record<string, unknown> = { a: 1 };
        o.self = o;
        return o;
      });
      expect((cyc as { self: unknown }).self).toBe(cyc);
      await expect(page.evaluate(() => {
        throw new TypeError('boom');
      })).rejects.toThrow(/boom/);
      // The page cannot see the driver's engine world.
      expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>).__eztestEngine)).toBe('undefined');
    });
  });

  it('types with the keyboard (modifiers, chords) and drives mouse, wheel and touch', async () => {
    await withPage(async (page) => {
      await page.goto(`${demo.url}/lab/keys`);
      await page.getByLabel('Search').pressSequentially('Ab!');
      expect(await page.getByLabel('Search').inputValue()).toBe('Ab!');
      expect(await page.locator('#input-count').textContent()).toBe('3');
      await page.keyboard.press('Control+K');
      expect(await page.locator('#last-key').textContent()).toBe('Control+K');
      await page.keyboard.down('Shift');
      expect(await page.locator('#shift').textContent()).toBe('down');
      await page.keyboard.up('Shift');
      await page.getByLabel('Notes').fill('line1');
      await page.getByLabel('Notes').press('Enter');
      await page.keyboard.insertText('line2 ✓');
      expect(await page.getByLabel('Notes').inputValue()).toBe('line1\nline2 ✓');
      await page.setContent('<div style="height:3000px">tall</div>');
      await page.mouse.move(100, 100);
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(() => window.scrollY > 0);
    });
    await withPage(async (page) => {
      await page.goto(`${demo.url}/lab/touch`);
      await page.locator('#tap-target').tap();
      expect(await page.locator('#touch-state').textContent()).toBe('Tapped');
    }, { hasTouch: true });
  });

  it('auto-waits, is strict, and reports what blocks an action', async () => {
    await withPage(async (page) => {
      await page.setContent(`<button id=a>One</button><button id=b>Two</button>
        <div id=late></div><script>setTimeout(() => { late.innerHTML = '<button id=c onclick="this.textContent=\\'done\\'">Late</button>'; }, 300)</script>
        <div id=cover style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>`);
      await expect(page.locator('button').click({ timeout: 500 })).rejects.toThrow(/locator\('button'\) matched 2 elements, but this needs exactly one.*1\) .*2\) .*Narrow it down/s);
      await expect(page.locator('#a').click({ timeout: 600 })).rejects.toThrow(/covers the element and would receive the pointer event/);
      await page.evaluate(() => document.getElementById('cover')!.remove());
      await page.getByRole('button', { name: 'Late' }).click();
      expect(await page.locator('#c').textContent()).toBe('done');
      expect(await page.getByRole('button').count()).toBe(3);
      expect(await page.locator('button').nth(1).innerText()).toBe('Two');
      expect(await page.locator('button').filter({ hasText: /^One$/ }).count()).toBe(1);
    });
  });

  it('checks, selects, uploads files and dispatches events', async () => {
    await withPage(async (page) => {
      await page.setContent(`<label><input type=checkbox id=t> Accept</label>
        <select id=s><option value=r>Red</option><option value=g>Green</option></select>
        <input type=file id=f multiple><p id=n></p><script>f.onchange = () => n.textContent = [...f.files].map(x => x.name + ':' + x.size).join(',')</script>
        <div id=d></div><script>d.addEventListener('hello', (e) => d.textContent = e.detail)</script>`);
      await page.getByLabel('Accept').check();
      expect(await page.locator('#t').isChecked()).toBe(true);
      await page.getByLabel('Accept').setChecked(false);
      expect(await page.locator('#t').isChecked()).toBe(false);
      expect(await page.locator('#s').selectOption('Green')).toEqual(['g']);
      const file = join(tmp, 'up.txt');
      writeFileSync(file, 'abc');
      await page.locator('#f').setInputFiles(file);
      expect(await page.locator('#n').textContent()).toBe('up.txt:3');
      await page.locator('#f').setInputFiles({ name: 'mem.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2]) });
      expect(await page.locator('#n').textContent()).toBe('mem.bin:2');
      await page.locator('#d').dispatchEvent('hello', { detail: 'hi' });
      expect(await page.locator('#d').textContent()).toBe('hi');
    });
  });
});

describe('clicks that submit a form', () => {
  it('wait for the POST and its redirect to commit, so an immediate navigation keeps the session cookie', async () => {
    // A form POST in Chromium is requested, scheduled, started and then "cleared"; the click must wait for the commit.
    await withPage(async (page) => {
      for (let i = 0; i < 5; i++) {
        await page.context().clearCookies();
        await page.goto(`${demo.url}/login`);
        await page.getByLabel('Username').fill('bob');
        await page.getByLabel('Password').fill('Builder#2');
        await page.getByRole('button', { name: 'Sign in' }).click();
        expect(new URL(page.url()).pathname, `attempt ${i + 1}`).toBe('/dashboard');
        await page.goto(`${demo.url}/orders/new`);
        expect(new URL(page.url()).pathname, `attempt ${i + 1}`).toBe('/orders/new');
      }
    });
  });
});

describe('network', () => {
  it('reports requests and responses with bodies, timing, redirects and failures', async () => {
    await withPage(async (page) => {
      const seen: string[] = [];
      page.on('request', (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
      const failed: string[] = [];
      page.on('requestfailed', (r) => failed.push(r.failure()?.errorText ?? ''));
      const res = await page.goto(`${demo.url}/login`);
      expect(res!.status()).toBe(200);
      expect(await res!.text()).toContain('Sign in');
      expect(res!.request().timing().startTime).toBeGreaterThan(0);
      const redirect = await page.goto(`${demo.url}/dashboard`);
      expect(redirect!.url()).toMatch(/\/login/);
      expect(redirect!.request().redirectedFrom()?.url()).toMatch(/\/dashboard$/);
      await page.route('**/blocked', (r) => r.abort());
      await page.evaluate((u) => fetch(u).catch(() => 'x'), `${demo.url}/blocked`);
      await expect.poll(() => failed.length).toBeGreaterThan(0);
      expect(seen).toContain('GET /login');
    });
  });

  it('routes: fulfill, continue with overrides, fallback chains, times, unroute', async () => {
    await withPage(async (page, ctx) => {
      await page.goto(`${demo.url}/login`);
      await ctx.route('**/api/x', (r) => r.fulfill({ json: { from: 'context' } }));
      await page.route('**/api/x', (r) => r.fallback({ headers: { 'x-added': '1' } }));
      expect(await page.evaluate(() => fetch('/api/x').then((r) => r.json()))).toEqual({ from: 'context' });
      await page.route('**/api/once', (r) => r.fulfill({ body: 'first' }), { times: 1 });
      await page.route('**/api/once', (r) => r.fulfill({ body: 'later' }));
      // Last registered wins: 'later' handles everything, the times-limited one is never reached.
      expect(await page.evaluate(() => fetch('/api/once').then((r) => r.text()))).toBe('later');
      await page.unroute('**/api/once');
      let header: string | undefined;
      await page.route('**/lab/api/echo**', async (r) => {
        header = r.request().headers()['x-test'];
        await r.continue({ headers: { ...r.request().headers(), 'x-test': 'yes' } });
      });
      const echoed = await page.evaluate(() => fetch('/lab/api/echo', { headers: { 'x-test': 'no' } }).then((r) => r.text()));
      expect(header).toBe('no');
      expect(echoed).toContain('yes');
    });
  });

  it('replays a HAR file', async () => {
    const har = join(tmp, 'x.har');
    writeFileSync(har, JSON.stringify({ log: { version: '1.2', entries: [{ request: { method: 'GET', url: 'http://har.test/data' }, response: { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], content: { text: '{"ok":true}', mimeType: 'application/json' } } }] } }));
    await withPage(async (page) => {
      await page.routeFromHAR(har);
      const r = await page.goto('http://har.test/data');
      expect(await r!.json()).toEqual({ ok: true });
      await expect(page.goto('http://har.test/missing')).rejects.toThrow(/ERR_FAILED/);
    });
  });

  it('extra headers, offline, HTTP auth, cookies and storage state', async () => {
    const state = join(tmp, 'state.json');
    await withPage(async (page, ctx) => {
      await ctx.setExtraHTTPHeaders({ 'x-extra': 'e1' });
      await page.goto(`${demo.url}/login`);
      const h = await page.evaluate(() => fetch('/lab/api/echo').then((r) => r.text()));
      expect(h).toContain('e1');
      await ctx.addCookies([{ name: 'k', value: 'v', url: demo.url }]);
      expect((await ctx.cookies(demo.url)).find((c) => c.name === 'k')?.value).toBe('v');
      await page.evaluate(() => localStorage.setItem('ls', '1'));
      await ctx.storageState({ path: state });
      await ctx.clearCookies({ name: 'k' });
      expect((await ctx.cookies()).some((c) => c.name === 'k')).toBe(false);
      await ctx.setOffline(true);
      await expect(page.evaluate(() => fetch('/login').then(() => 'online', () => 'offline'))).resolves.toBe('offline');
      await ctx.setOffline(false);
    });
    await withPage(async (page, ctx) => {
      expect((await ctx.cookies()).find((c) => c.name === 'k')?.value).toBe('v');
      await page.goto(`${demo.url}/login`);
      expect(await page.evaluate(() => localStorage.getItem('ls'))).toBe('1');
    }, { storageState: state });
    const server = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth === `Basic ${Buffer.from('u:p').toString('base64')}`) res.end('<p id=ok>welcome</p>');
      else {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' });
        res.end('denied');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const authUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      await withPage(async (page) => {
        expect((await page.goto(authUrl))!.status()).toBe(200);
        expect(await page.locator('#ok').textContent()).toBe('welcome');
      }, { httpCredentials: { username: 'u', password: 'p' } });
      await withPage(async (page) => {
        expect((await page.goto(authUrl))!.status()).toBe(401);
      }, { httpCredentials: { username: 'u', password: 'wrong' } });
    } finally {
      server.close();
    }
  });
});

describe('dialogs, downloads, popups and frames', () => {
  it('handles alert / confirm / prompt and auto-dismisses unhandled ones', async () => {
    await withPage(async (page) => {
      await page.goto(`${demo.url}/lab/dialogs`);
      await page.getByRole('button', { name: 'Delete order' }).click();
      expect(await page.locator('#confirm-result').textContent()).toBe('Kept');
      const seen: string[] = [];
      const closed: Array<{ type: string; message: string; accepted: boolean; userInput?: string }> = [];
      page.on('dialogclosed', (c) => closed.push(c));
      page.on('dialog', async (d) => {
        seen.push(`${d.type()}:${d.message()}:${d.defaultValue()}`);
        if (d.type() === 'prompt') await d.accept('Ada');
        else await d.accept();
      });
      await page.getByRole('button', { name: 'Delete order' }).click();
      await page.getByRole('button', { name: 'Enter name' }).click();
      expect(await page.locator('#confirm-result').textContent()).toBe('Deleted');
      expect(await page.locator('#prompt-result').textContent()).toBe('Hello Ada');
      expect(seen).toEqual(['confirm:Delete the order?:', 'prompt:Your name?:guest']);
      // How each dialog was answered, whoever answered it (the policy, the test or a person).
      await expect.poll(() => closed.length).toBe(2);
      expect(closed).toEqual([
        { type: 'confirm', message: 'Delete the order?', accepted: true },
        { type: 'prompt', message: 'Your name?', accepted: true, userInput: 'Ada' },
      ]);
    });
  });

  it('downloads files and saves them', async () => {
    await withPage(async (page) => {
      await page.goto(`${demo.url}/lab/upload`);
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Download CSV report').click()]);
      expect(download.suggestedFilename()).toBe('report.csv');
      const target = join(tmp, 'saved.csv');
      await download.saveAs(target);
      expect(readFileSync(target, 'utf8').length).toBeGreaterThan(0);
      expect(await download.failure()).toBeNull();
    }, { acceptDownloads: true });
  });

  it('follows popups and their close', async () => {
    await withPage(async (page, ctx) => {
      await page.goto(`${demo.url}/lab/tabs`);
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-popup').click()]);
      await popup.waitForLoadState();
      expect(await popup.title()).toBe('Help popup');
      expect(await popup.opener()).toBe(page);
      expect(ctx.pages()).toContain(popup);
      await Promise.all([popup.waitForEvent('close'), popup.getByRole('button', { name: 'Send back' }).click()]);
      expect(popup.isClosed()).toBe(true);
      expect(await page.locator('#popup-result').textContent()).toBe('Popup says hi');
    });
  });

  it('a click whose handler closes the page resolves (the close can beat the input acknowledgement)', async () => {
    await withPage(async (page) => {
      await page.goto(`${demo.url}/lab/tabs`);
      // The page closes on mousedown ("Close now") or on click ("Send back"), while the input command is
      // still in flight; repeated, so the race between the close and the acknowledgement goes both ways.
      for (let i = 0; i < 6; i++) {
        for (const name of ['Close now', 'Send back']) {
          const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-popup').click()]);
          await popup.waitForLoadState();
          await Promise.all([popup.waitForEvent('close'), popup.getByRole('button', { name }).click()]);
          expect(popup.isClosed()).toBe(true);
        }
      }
      expect(await page.locator('#popup-result').textContent()).toBe('Popup says hi');
    });
  });

  it('works inside nested frames and out-of-process iframes', async () => {
    await withPage(async (page) => {
      await page.goto(`${demo.url}/lab/frames`);
      const pay = page.frameLocator('iframe[name="payment"]');
      await pay.getByLabel('Card number').fill('4111111111111111');
      await pay.getByRole('button', { name: 'Pay now' }).click();
      await expect.poll(() => page.locator('#status').textContent()).toBe('Paid with card ending 1111');
      await pay.frameLocator('#verify-frame').getByRole('button', { name: 'Verify' }).click();
      expect(await pay.frameLocator('#verify-frame').locator('#v').textContent()).toBe('Verified');
      expect(page.frames().map((f) => f.name())).toEqual(['', 'payment', 'verify']);
    });
  });

  it('drives out-of-process (cross-site) iframes', async () => {
    // Site isolation is forced on (the headless shell does not isolate sites by default).
    const isolated = await chromium.launch({ args: ['--site-per-process'] });
    try {
      const page = await isolated.newPage();
      // (Both sites are public names served by routes: a public page may not frame 127.0.0.1.)
      await page.route('http://outer.test/', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>outer</h1><iframe id=x src="http://inner.test/pay" style="margin-left:50px"></iframe>' }));
      await page.route('http://inner.test/pay', (r) => r.fulfill({ contentType: 'text/html', body: '<label for=card>Card number</label><input id=card><button>Pay now</button>' }));
      await page.goto('http://outer.test/');
      const x = page.frameLocator('#x');
      await x.getByLabel('Card number').fill('1234');
      expect(await x.getByLabel('Card number').inputValue()).toBe('1234');
      const box = await x.getByRole('button', { name: 'Pay now' }).boundingBox();
      expect(box!.x).toBeGreaterThan(50);
      const frame = page.frames().find((f) => f.url() === 'http://inner.test/pay')!;
      expect(frame.parentFrame()).toBe(page.mainFrame());
      expect(frame.session.isMain).toBe(false); // out-of-process
      expect(await frame.evaluate(() => location.host)).toBe('inner.test');
    } finally {
      await isolated.close();
    }
  });
});

describe('screenshots, screencast, video and tracing', () => {
  it('captures viewport, full page, clip, element and masks', async () => {
    await withPage(async (page) => {
      await page.setContent('<style>body{margin:0}</style><div id=a style="width:100px;height:50px;background:#00ff00"></div><div style="height:2000px"></div>');
      const vp = PNG.sync.read(await page.screenshot());
      expect([vp.width, vp.height]).toEqual([400, 300]);
      const full = PNG.sync.read(await page.screenshot({ fullPage: true }));
      expect(full.height).toBeGreaterThanOrEqual(2050);
      const el = PNG.sync.read(await page.locator('#a').screenshot());
      expect([el.width, el.height]).toEqual([100, 50]);
      expect([...el.data.subarray(0, 3)]).toEqual([0, 255, 0]);
      const masked = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 50 }, mask: [page.locator('#a')] }));
      expect([...masked.data.subarray(0, 3)]).toEqual([255, 0, 255]);
    }, { viewport: { width: 400, height: 300 } });
  });

  it('streams screencast frames and records a WebM video that the browser can play', async () => {
    const dir = join(tmp, 'video');
    let path = '';
    await withPage(async (page) => {
      const frames: number[] = [];
      const stop = await page.startScreencast({ format: 'jpeg' }, (f) => frames.push(f.data.length));
      await page.setContent('<h1 id=h>0</h1><script>let i=0;setInterval(()=>h.textContent=++i,30)</script>');
      await page.waitForTimeout(600);
      await stop();
      expect(frames.length).toBeGreaterThan(0);
      path = await page.video()!.path();
    }, { recordVideo: { dir }, viewport: { width: 320, height: 240 } });
    expect(readdirSync(dir).filter((f) => f.endsWith('.webm'))).toHaveLength(1);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    await withPage(async (page) => {
      await page.setContent('<video id=v muted></video>');
      const info = await page.evaluate(async (b64) => {
        const v = document.getElementById('v') as HTMLVideoElement;
        v.src = `data:video/webm;base64,${b64}`;
        await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('cannot decode')); });
        return { w: v.videoWidth, h: v.videoHeight };
      }, bytes.toString('base64'));
      expect(info.w).toBeGreaterThan(0);
    });
    expect(muxWebM([], { width: 2, height: 2 }).length).toBeGreaterThan(40);
  });

  it('writes a trace archive of actions, snapshots and network', async () => {
    const zip = join(tmp, 'trace.zip');
    await withPage(async (page, ctx) => {
      await ctx.tracing.start({ screenshots: true, snapshots: true, title: 'driver trace' });
      await page.goto(`${demo.url}/login`);
      await page.getByLabel('Username').fill('bob');
      await ctx.tracing.stop({ path: zip });
    });
    const files = readZip(readFileSync(zip));
    // EZTest's own layout: a hashed manifest, actions, network, console, frames, snapshots, resources.
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as BrowserTraceManifest;
    expect(manifest).toMatchObject({ format: 'eztest-browser-trace', version: 1, title: 'driver trace' });
    expect(files.has('trace.trace')).toBe(false);
    expect([...files.keys()].filter((k) => k !== 'manifest.json').sort()).toEqual(manifest.files.map((f) => f.path).sort());
    const actions = files.get('actions.jsonl')!.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as { api: string; before?: string; after?: string });
    expect(actions.map((a) => a.api.split('.').pop())).toEqual(['goto', 'fill']);
    expect(files.has(actions[1].after!)).toBe(true);
    // Studio's viewer opens it: steps with snapshots that mark the target.
    const opened = await readBrowserTrace(zip);
    expect(opened.problems).toEqual([]);
    expect(opened.trace).toMatchObject({ source: 'browser', journeyName: 'driver trace', browser: 'chromium' });
    expect(opened.trace.steps.map((st) => st.action)).toEqual(['goto', 'fill']);
    expect(opened.trace.steps[1].snapshots.after?.target?.nid).toBeGreaterThan(0);
  });
});
