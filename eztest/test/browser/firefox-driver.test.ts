/**
 * EZTest browser driver on Firefox (WebDriver BiDi, src/browser/firefox)
 * against a real Firefox and the demo app: launch, evaluate, input, network
 * and routing, dialogs, downloads, frames, popups, screenshots, cookies,
 * emulation, the selector engine and actionability. Mirrors driver.test.ts.
 *
 * The browser tests run when a Firefox is found (EZTEST_FIREFOX_PATH, the
 * EZTest cache, or an installed Firefox); the unit tests always run.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { firefox, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { adoptSharedCertificates, findFirefox, firefoxCommandLine, firefoxPreferences, firefoxChannelCandidates, userJs, cachedFirefoxBuilds } from '../../src/browser/firefox/launch.js';
import { webdriverKeyValue } from '../../src/browser/firefox/input.js';
import { netErrorText, headersFromBidi } from '../../src/browser/firefox/network.js';
import { toLocalValue, fromRemoteValue } from '../../src/browser/firefox/realm.js';
import { acceptLanguage, bidiProxy } from '../../src/browser/firefox/browser.js';
import { firefoxArchiveName, firefoxDownloadUrl, parseSha512Sums, verifySha512 } from '../../src/browser/firefox/install.js';
import { resolveKey } from '../../src/browser/input/us-layout.js';
import { SimpleWebSocket } from '../../src/browser/transport/websocket.js';
import { readZip } from '../../src/runner/trace/zip.js';
import { readBrowserTrace } from '../../src/runner/trace/browser-trace.js';
import type { BrowserTraceManifest } from '../../src/browser/trace-format.js';
import { runJourneys } from '../../src/runner/index.js';
import { FAST, bobOrderJourney, tempDir } from '../runner/fixtures.js';

const executable = (() => {
  try {
    return findFirefox().executablePath;
  } catch {
    return undefined;
  }
})();

describe('firefox launcher, preferences and keys (no browser needed)', () => {
  it('builds a command line and an automation profile', () => {
    const args = firefoxCommandLine({ headless: true, args: ['--lang=de'] }, '/tmp/p');
    expect(args).toEqual(expect.arrayContaining(['--remote-debugging-port=0', '--profile', '/tmp/p', '--headless', '--no-remote', '--lang=de', 'about:blank']));
    expect(firefoxCommandLine({ headless: false, args: ['https://x.test/'] }, '/p')).not.toContain('about:blank');
    expect(firefoxCommandLine({ ignoreDefaultArgs: true }, '/p')).not.toContain('--no-remote');
    const prefs = firefoxPreferences({ proxy: { server: 'proxy.local:3128', bypass: 'localhost' }, userPrefs: { 'test.pref': 7 } });
    expect(prefs).toMatchObject({
      'remote.active-protocols': 1,
      'toolkit.telemetry.enabled': false,
      'app.update.disabledForTesting': true,
      'browser.startup.homepage_override.mstone': 'ignore',
      'datareporting.policy.dataSubmissionEnabled': false,
      'network.proxy.type': 1,
      'network.proxy.http': 'proxy.local',
      'network.proxy.http_port': 3128,
      'network.proxy.no_proxies_on': 'localhost',
      'test.pref': 7,
    });
    expect(userJs({ a: 'x"y', b: true, c: 3 })).toBe('user_pref("a", "x\\"y");\nuser_pref("b", true);\nuser_pref("c", 3);\n');
    expect(firefoxChannelCandidates('firefox-esr', 'linux')).toContain('/usr/lib/firefox-esr/firefox-esr');
    expect(firefoxChannelCandidates('nightly', 'darwin')[0]).toBe('/Applications/Firefox Nightly.app/Contents/MacOS/firefox');
    expect(() => findFirefox({ executablePath: '/nope/firefox' })).toThrow(/not found/);
    expect(() => findFirefox({ channel: 'chrome' })).toThrow(/Unknown Firefox channel/);
    expect(cachedFirefoxBuilds(join(tmpdir(), 'no-such-cache-dir'))).toEqual([]);
  });

  it('follows the machine proxy from the environment, as Chromium does, and connects directly without one', () => {
    const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
    const saved = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) delete process.env[k];
      expect(firefoxPreferences({})['network.proxy.type']).toBe(0);
      process.env.HTTPS_PROXY = 'http://proxy.corp:3128';
      expect(firefoxPreferences({})['network.proxy.type']).toBe(5);
      expect(firefoxPreferences({ proxy: { server: 'other:8080' } })['network.proxy.type']).toBe(1);
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  it('starts a temporary profile from the shared NSS certificate database (a TLS-inspecting proxy CA)', () => {
    const db = mkdtempSync(join(tmpdir(), 'eztest-nssdb-'));
    const profile = mkdtempSync(join(tmpdir(), 'eztest-ffprofile-'));
    try {
      expect(adoptSharedCertificates(profile, { EZTEST_NSSDB: db }, 'linux')).toBe(false);
      writeFileSync(join(db, 'cert9.db'), 'certs');
      writeFileSync(join(db, 'key4.db'), 'keys');
      expect(adoptSharedCertificates(profile, { EZTEST_NSSDB: db }, 'linux')).toBe(true);
      expect(readFileSync(join(profile, 'cert9.db'), 'utf8')).toBe('certs');
      expect(readFileSync(join(profile, 'key4.db'), 'utf8')).toBe('keys');
      expect(adoptSharedCertificates(profile, { HOME: db }, 'win32')).toBe(false);
    } finally {
      rmSync(db, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it('maps layout keys to WebDriver key values', () => {
    const key = (k: string, shift = false) => {
      const r = resolveKey(k)!;
      return webdriverKeyValue(r.def, shift || r.shifted, k);
    };
    expect(key('a')).toBe('a');
    expect(key('a', true)).toBe('A');
    expect(key('A')).toBe('A');
    expect(key('!')).toBe('!');
    expect(key('Enter')).toBe('');
    expect(key('NumpadEnter')).toBe('');
    expect(key('Shift')).toBe('');
    expect(key('ShiftRight')).toBe('');
    expect(key('Control')).toBe('');
    expect(key('Meta')).toBe('');
    expect(key('Backspace')).toBe('');
    expect(key('ArrowLeft')).toBe('');
    expect(key('F12')).toBe('');
    expect(key('Numpad5')).toBe('');
    expect(key(' ')).toBe(' ');
    expect(key('CapsLock')).toBeUndefined();
    expect(webdriverKeyValue({ code: '', keyCode: 0, key: '✓', location: 0, text: '✓' }, false, '✓')).toBe('✓');
  });

  it('converts values, headers, errors and proxies', () => {
    expect(toLocalValue({ a: [1, 'x', null, true] })).toEqual({ type: 'object', value: [['a', { type: 'array', value: [{ type: 'number', value: 1 }, { type: 'string', value: 'x' }, { type: 'null' }, { type: 'boolean', value: true }] }]] });
    expect(fromRemoteValue({ type: 'object', value: [['n', { type: 'number', value: 'NaN' }], ['b', { type: 'bigint', value: '5' }]] })).toEqual({ n: NaN, b: 5n });
    expect(headersFromBidi([{ name: 'A', value: { type: 'string', value: '1' } }, { name: 'B', value: { type: 'base64', value: Buffer.from('2').toString('base64') } }])).toEqual([{ name: 'A', value: '1' }, { name: 'B', value: '2' }]);
    expect(netErrorText('NS_ERROR_CONNECTION_REFUSED')).toBe('net::ERR_CONNECTION_REFUSED');
    expect(netErrorText('unknown error: Error: NS_ERROR_UNKNOWN_HOST')).toBe('net::ERR_NAME_NOT_RESOLVED');
    expect(netErrorText('NS_ERROR_SOMETHING_NEW')).toBe('NS_ERROR_SOMETHING_NEW');
    expect(netErrorText('NS_ERROR_GENERATE_FAILURE(NS_ERROR_MODULE_SECURITY, SEC_ERROR_UNKNOWN_ISSUER)')).toBe('net::ERR_CERT_AUTHORITY_INVALID');
    expect(acceptLanguage('de-DE')).toBe('de-DE,de;q=0.9');
    expect(bidiProxy({ server: 'http://p.local:8080', bypass: 'a.test, b.test' })).toEqual({ proxyType: 'manual', httpProxy: 'p.local:8080', sslProxy: 'p.local:8080', noProxy: ['a.test', 'b.test'] });
    expect(bidiProxy({ server: 'socks5://s.local:1080' })).toMatchObject({ socksProxy: 's.local:1080', socksVersion: 5 });
  });

  it('frames WebSocket messages (RFC 6455 client frames: FIN, masked, 7/16/64-bit lengths)', () => {
    for (const n of [5, 300, 70_000]) {
      const payload = Buffer.alloc(n, 0x61);
      const f = SimpleWebSocket.frame(0x1, payload);
      expect(f[0]).toBe(0x81);
      expect(f[1] & 0x80).toBe(0x80);
      const len7 = f[1] & 0x7f;
      const [len, off] = len7 === 126 ? [f.readUInt16BE(2), 4] : len7 === 127 ? [Number(f.readBigUInt64BE(2)), 10] : [len7, 2];
      expect(len).toBe(n);
      const mask = f.subarray(off, off + 4);
      const body = Buffer.from(f.subarray(off + 4));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      expect(body.equals(payload)).toBe(true);
    }
  });

  it('downloads from the Mozilla archive and verifies the release SHA512SUMS', () => {
    expect(firefoxArchiveName('140.4.0esr', 'linux', 'x64')).toBe('firefox-140.4.0esr.tar.xz');
    expect(firefoxArchiveName('128.0', 'linux', 'x64')).toBe('firefox-128.0.tar.bz2');
    expect(firefoxArchiveName('140.4.0esr', 'darwin', 'arm64')).toBe('Firefox 140.4.0esr.dmg');
    expect(firefoxArchiveName('140.4.0esr', 'win32', 'x64')).toBe('Firefox Setup 140.4.0esr.exe');
    expect(firefoxDownloadUrl('140.4.0esr', { platform: 'linux', arch: 'x64', locale: 'en-US' })).toEqual({
      url: 'https://archive.mozilla.org/pub/firefox/releases/140.4.0esr/linux-x86_64/en-US/firefox-140.4.0esr.tar.xz',
      sumsUrl: 'https://archive.mozilla.org/pub/firefox/releases/140.4.0esr/SHA512SUMS',
      sumsKey: 'linux-x86_64/en-US/firefox-140.4.0esr.tar.xz',
    });
    expect(firefoxDownloadUrl('140.4.0esr', { platform: 'darwin', arch: 'arm64', base: 'https://mirror.test/firefox/' }).url).toBe('https://mirror.test/firefox/releases/140.4.0esr/mac/en-US/Firefox%20140.4.0esr.dmg');
    expect(firefoxDownloadUrl('140.4.0esr', { platform: 'win32', arch: 'arm64' }).sumsKey).toBe('win64-aarch64/en-US/Firefox Setup 140.4.0esr.exe');
    const body = Buffer.from('firefox archive bytes');
    const sha = createHash('sha512').update(body).digest('hex');
    const sums = parseSha512Sums(`${sha}  linux-x86_64/en-US/firefox-140.4.0esr.tar.xz\n${'0'.repeat(128)}  mac/en-US/Firefox 140.4.0esr.dmg\n`);
    expect(sums.get('linux-x86_64/en-US/firefox-140.4.0esr.tar.xz')).toBe(sha);
    expect(sums.get('mac/en-US/Firefox 140.4.0esr.dmg')).toBe('0'.repeat(128));
    expect(verifySha512(body, sha)).toBe(true);
    expect(() => verifySha512(body, '0'.repeat(128))).toThrow(/SHA-512 mismatch/);
  });
});

let demo: DemoServer;
let browser: Browser;
const tmp = mkdtempSync(join(tmpdir(), 'ez-ff-driver-'));

describe.skipIf(!executable)('firefox driver', () => {
  beforeAll(async () => {
    demo = await startDemoApp();
    browser = await firefox.launch();
  }, 120_000);

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

  describe('launch', () => {
    it('reports its version, and closing removes the temporary profile and kills the process group', async () => {
      const b = await firefox.launch();
      expect(b.version()).toMatch(/^\d+\.\d+/);
      const proc = b.process()!;
      const i = proc.spawnargs.indexOf('--profile');
      const profile = proc.spawnargs[i + 1];
      expect(existsSync(join(profile, 'user.js'))).toBe(true);
      await b.close();
      expect(b.isConnected()).toBe(false);
      expect(existsSync(profile)).toBe(false);
      expect(() => process.kill(proc.pid!, 0)).toThrow();
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
        expect(await page.evaluate('var x1 = 4; x1 * 2')).toBe(8);
        const cyc = await page.evaluate(() => {
          const o: Record<string, unknown> = { a: 1, m: new Map([[1, 'x']]), s: new Set([2]), url: new URL('http://a.test/b') };
          o.self = o;
          return o;
        });
        expect((cyc as { self: unknown }).self).toBe(cyc);
        expect((cyc as { m: Map<number, string> }).m.get(1)).toBe('x');
        await expect(page.evaluate(() => {
          throw new TypeError('boom');
        })).rejects.toThrow(/boom/);
        const err = await page.evaluate(() => {
          throw new RangeError('range!');
        }).catch((e: Error) => e);
        expect((err as Error).name).toBe('RangeError');
        // Handles: properties, JSON values, disposal.
        const obj = await page.evaluateHandle(() => ({ a: 1, el: document.getElementById('p'), nested: { b: 2 } }));
        const props = await obj.getProperties();
        expect(await props.get('a')!.jsonValue()).toBe(1);
        expect(props.get('el')!.asElement()).not.toBeNull();
        expect(await props.get('nested')!.jsonValue()).toEqual({ b: 2 });
        await obj.dispose();
        // The page cannot see the driver's engine world.
        expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>).__eztestEngine)).toBe('undefined');
      });
    });

    it('fires mouseout and mouseleave when the mouse leaves the page (exit-intent popups)', async () => {
      await withPage(async (page) => {
        await page.setContent(`<!doctype html><p style="height:400px">page</p><script>
          window.left = [];
          document.documentElement.addEventListener('mouseleave', (e) => left.push('leave ' + e.clientY));
          document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) left.push('out ' + e.clientY); });
        </script>`);
        await page.mouse.move(100, 200);
        await page.mouse.move(100, -5);
        expect(await page.evaluate(() => (window as unknown as { left: string[] }).left)).toEqual(['out -5', 'leave -5']);
        await page.mouse.move(100, -20);
        expect(await page.evaluate(() => (window as unknown as { left: string[] }).left.length)).toBe(2);
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
        await page.getByLabel('Notes').press('Control+A');
        await page.keyboard.press('Backspace');
        expect(await page.getByLabel('Notes').inputValue()).toBe('');
        await page.setContent('<div style="height:3000px">tall</div>');
        await page.mouse.move(100, 100);
        await page.mouse.wheel(0, 500);
        await page.waitForFunction(() => window.scrollY > 0);
        await page.setContent('<button id=b ondblclick="this.textContent=\'dbl\'" oncontextmenu="event.preventDefault(); this.dataset.ctx=1">x</button>');
        await page.locator('#b').dblclick();
        expect(await page.locator('#b').textContent()).toBe('dbl');
        await page.locator('#b').click({ button: 'right' });
        expect(await page.locator('#b').getAttribute('data-ctx')).toBe('1');
        await page.setContent('<div id=h style="width:100px;height:100px" onmouseenter="this.textContent=\'in\'"></div>');
        await page.locator('#h').hover();
        expect(await page.locator('#h').textContent()).toBe('in');
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
        await page.setContent('<button disabled>Off</button><input id=ro readonly value=x>');
        await expect(page.getByRole('button').click({ timeout: 400 })).rejects.toThrow(/timed out after 400 ms/);
        expect(await page.getByRole('button').isDisabled()).toBe(true);
        expect(await page.locator('#ro').isEditable()).toBe(false);
      });
    });

    it('runs the selector engine: roles, names, labels, text, shadow DOM, xpath', async () => {
      await withPage(async (page) => {
        await page.setContent(`<nav aria-label="Main"><a href="#a">Home</a></nav>
          <label for=email>Email address</label><input id=email placeholder="you@example.com">
          <h2>Orders</h2><table><tr><th>Id</th></tr><tr><td>42</td></tr></table>
          <div id=host></div><img alt="Company logo" src="data:,"><span title="tip">t</span><div data-testid=card>card</div>
          <script>host.attachShadow({mode:'open'}).innerHTML = '<button>Inside shadow</button>';</script>`);
        expect(await page.getByRole('navigation', { name: 'Main' }).count()).toBe(1);
        expect(await page.getByRole('link', { name: 'Home' }).count()).toBe(1);
        expect(await page.getByLabel('Email address').getAttribute('id')).toBe('email');
        expect(await page.getByPlaceholder('you@example.com').count()).toBe(1);
        expect(await page.getByRole('heading', { level: 2 }).textContent()).toBe('Orders');
        expect(await page.getByRole('cell', { name: '42' }).count()).toBe(1);
        expect(await page.getByRole('button', { name: 'Inside shadow' }).count()).toBe(1);
        expect(await page.getByAltText('Company logo').count()).toBe(1);
        expect(await page.getByTitle('tip').textContent()).toBe('t');
        expect(await page.getByTestId('card').textContent()).toBe('card');
        expect(await page.locator('xpath=//h2').textContent()).toBe('Orders');
        expect(await page.getByText('Orders').count()).toBe(1);
        expect(await page.locator('body').ariaSnapshot()).toContain('heading "Orders"');
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

    it('init scripts, exposed functions, console messages, page errors and workers', async () => {
      await withPage(async (page, ctx) => {
        await ctx.addInitScript(() => {
          (window as unknown as Record<string, unknown>).fromCtx = 'ctx';
        });
        await page.addInitScript((v) => {
          (window as unknown as Record<string, unknown>).fromPage = v;
        }, 'page');
        await ctx.exposeFunction('ctxAdd', (a: number, b: number) => a + b);
        await page.exposeBinding('who', ({ page: p }, x: string) => `${x}@${p === page}`);
        const logs: string[] = [];
        page.on('console', (m) => logs.push(`${m.type()}:${m.text()}`));
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(`${e.name}:${e.message}`));
        await page.goto(`${demo.url}/login`);
        expect(await page.evaluate(() => [(window as any).fromCtx, (window as any).fromPage])).toEqual(['ctx', 'page']);
        expect(await page.evaluate(() => (window as any).ctxAdd(2, 3))).toBe(5);
        expect(await page.evaluate(() => (window as any).who('me'))).toBe('me@true');
        await page.evaluate(() => {
          console.log('hello', 5);
          console.warn('careful');
          setTimeout(() => {
            throw new Error('async boom');
          }, 0);
        });
        await expect.poll(() => logs).toEqual(expect.arrayContaining(['log:hello 5', 'warning:careful']));
        await expect.poll(() => errors).toContain('Error:async boom');
        const [worker] = await Promise.all([
          page.waitForEvent('worker'),
          page.evaluate(() => {
            (window as unknown as { w: Worker }).w = new Worker(URL.createObjectURL(new Blob(['self.answer = 42;'], { type: 'text/javascript' })));
          }),
        ]);
        expect(worker.url()).toMatch(/^blob:/);
        // Firefox's BiDi lists worker realms but does not (yet) evaluate in them: the error says so.
        const answer = await worker.evaluate(() => (self as unknown as { answer: number }).answer).catch((e: Error) => e.message);
        expect(answer === 42 || /does not run scripts in worker realms/.test(String(answer))).toBe(true);
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
        await expect.poll(() => failed).toContain('net::ERR_FAILED');
        expect(seen).toContain('GET /login');
        const [req] = await Promise.all([
          page.waitForRequest('**/lab/api/echo'),
          page.evaluate(() => fetch('/lab/api/echo', { method: 'POST', body: 'payload=1' })),
        ]);
        expect(req.method()).toBe('POST');
        expect(req.postData()).toBe('payload=1');
        const closed = createServer();
        await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
        const port = (closed.address() as { port: number }).port;
        await new Promise((r) => closed.close(r));
        await expect(page.goto(`http://127.0.0.1:${port}/`)).rejects.toThrow(/net::ERR_CONNECTION_REFUSED/);
        await expect(page.goto('http://127.0.0.1:9/')).rejects.toThrow(/net::ERR_UNSAFE_PORT/);
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
        await page.unrouteAll();
        await ctx.unrouteAll();
        const r = await page.goto(`${demo.url}/login`);
        expect(r!.status()).toBe(200);
      });
    });

    it('observes WebSockets: creation, frames both ways and close', async () => {
      // A tiny echo server (RFC 6455 handshake, unmasked server frames, text only).
      const server = createServer();
      server.on('upgrade', (req, socket) => {
        const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.on('data', (d: Buffer) => {
          const opcode = d[0] & 0x0f;
          const len = d[1] & 0x7f;
          const mask = d.subarray(2, 6);
          const text = Buffer.from(d.subarray(6, 6 + len).map((b, i) => b ^ mask[i & 3])).toString('utf8');
          if (opcode === 0x8) {
            socket.end();
            return;
          }
          const reply = Buffer.from(`echo:${text}`);
          socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      try {
        await withPage(async (page) => {
          await page.goto(`${demo.url}/login`);
          const frames: string[] = [];
          // Listen from creation on: the first frame goes out as soon as the socket opens.
          page.on('websocket', (w) => {
            w.on('framesent', (f) => frames.push(`sent:${f.payload}`));
            w.on('framereceived', (f) => frames.push(`recv:${f.payload}`));
          });
          const [ws] = await Promise.all([
            page.waitForEvent('websocket'),
            page.evaluate((p) => {
              const s = new WebSocket(`ws://127.0.0.1:${p}/`);
              (window as unknown as { s: WebSocket }).s = s;
              s.onopen = () => s.send('hi');
            }, port),
          ]);
          expect(ws.url()).toBe(`ws://127.0.0.1:${port}/`);
          await expect.poll(() => frames).toEqual(['sent:hi', 'recv:echo:hi']);
          expect(await page.evaluate(() => (window as unknown as { s: WebSocket }).s instanceof WebSocket)).toBe(true);
          await Promise.all([ws.waitForEvent('close'), page.evaluate(() => (window as unknown as { s: WebSocket }).s.close())]);
        });
      } finally {
        server.close();
      }
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
        expect(await page.evaluate(() => document.cookie)).toContain('k=v');
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
        await withPage(async (page) => {
          expect((await page.goto(authUrl))!.status()).toBe(401);
        });
      } finally {
        server.close();
      }
    });
  });

  describe('emulation', () => {
    it('applies locale, timezone, user agent, geolocation, color scheme and viewport', async () => {
      await withPage(async (page, ctx) => {
        await page.goto(`${demo.url}/login`);
        const env = await page.evaluate(() => ({
          lang: Intl.DateTimeFormat().resolvedOptions().locale,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ua: navigator.userAgent,
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
          w: innerWidth,
          h: innerHeight,
        }));
        expect(env).toEqual({ lang: 'de-DE', tz: 'Asia/Tokyo', ua: 'EZTest-UA/1.0', dark: true, w: 500, h: 400 });
        const echoed = await page.evaluate(() => fetch('/lab/api/echo').then((r) => r.text()));
        expect(echoed.toLowerCase()).toContain('de-de');
        await ctx.grantPermissions(['geolocation']);
        await ctx.setGeolocation({ latitude: 48.85, longitude: 2.35 });
        const pos = await page.evaluate(() => new Promise<number[]>((res, rej) => navigator.geolocation.getCurrentPosition((p) => res([p.coords.latitude, p.coords.longitude]), (e) => rej(new Error(e.message)))));
        expect(pos).toEqual([48.85, 2.35]);
        await page.emulateMedia({ colorScheme: 'light' });
        expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(false);
        await page.emulateMedia({ media: 'print' });
        expect(await page.evaluate(() => matchMedia('print').matches)).toBe(true);
        await page.emulateMedia({ media: null, reducedMotion: 'reduce' });
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
        await page.setViewportSize({ width: 320, height: 200 });
        expect(await page.evaluate(() => innerWidth)).toBe(320);
      }, { locale: 'de-DE', timezoneId: 'Asia/Tokyo', userAgent: 'EZTest-UA/1.0', colorScheme: 'dark', viewport: { width: 500, height: 400 } });
      await withPage(async (page) => {
        await page.goto(`${demo.url}/login`);
        expect(await page.evaluate(() => typeof (window as unknown as { ezRan?: number }).ezRan)).toBe('undefined');
        await page.setContent('<p id=p>static</p><script>document.getElementById("p").textContent = "ran"</script>');
        expect(await page.locator('#p').textContent()).toBe('static');
      }, { javaScriptEnabled: false });
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

    it('works inside nested frames and cross-site iframes', async () => {
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
      await withPage(async (page) => {
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
        expect(await frame.evaluate(() => location.host)).toBe('inner.test');
        expect(await (await frame.frameElement()).getAttribute('id')).toBe('x');
      });
    });

    it('navigates back, forward, reloads and waits for load states', async () => {
      await withPage(async (page) => {
        await page.goto(`${demo.url}/login`);
        await page.goto(`${demo.url}/lab/keys`);
        await page.goBack();
        expect(page.url()).toMatch(/\/login$/);
        await page.goForward();
        expect(page.url()).toMatch(/\/lab\/keys$/);
        const r = await page.reload();
        expect(r!.status()).toBe(200);
        await page.goto(`${demo.url}/login#part`);
        expect(page.url()).toMatch(/#part$/);
        await page.evaluate(() => history.pushState({}, '', '/pushed'));
        await page.waitForURL('**/pushed');
        await page.goto(`${demo.url}/login`, { waitUntil: 'networkidle' });
        expect(await page.title()).not.toBe('');
      });
    });
  });

  describe('screenshots, PDF, video and tracing', () => {
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
        await page.evaluate(() => window.scrollTo(0, 500));
        const scrolledEl = PNG.sync.read(await page.locator('#a').screenshot());
        expect([...scrolledEl.data.subarray(0, 3)]).toEqual([0, 255, 0]);
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 50 });
        expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        const pdf = await page.pdf();
        expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      }, { viewport: { width: 400, height: 300 } });
    });

    it('records a WebM video that the browser can play', async () => {
      const dir = join(tmp, 'video');
      let path = '';
      await withPage(async (page) => {
        await page.setContent('<h1 id=h>0</h1><script>let i=0;setInterval(()=>h.textContent=++i,30)</script>');
        await page.waitForTimeout(800);
        path = await page.video()!.path();
      }, { recordVideo: { dir }, viewport: { width: 320, height: 240 } });
      expect(readdirSync(dir).filter((f) => f.endsWith('.webm'))).toHaveLength(1);
      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    });

    it('writes a trace archive of actions, snapshots and network', async () => {
      const zip = join(tmp, 'trace.zip');
      await withPage(async (page, ctx) => {
        await ctx.tracing.start({ screenshots: true, snapshots: true, title: 'firefox trace' });
        await page.goto(`${demo.url}/login`);
        await page.getByLabel('Username').fill('bob');
        await ctx.tracing.stop({ path: zip });
      });
      const files = readZip(readFileSync(zip));
      // EZTest's own layout: a hashed manifest, actions, network, console, frames, snapshots, resources.
      const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as BrowserTraceManifest;
      expect(manifest).toMatchObject({ format: 'eztest-browser-trace', version: 1, title: 'firefox trace' });
      expect(files.has('trace.trace')).toBe(false);
      expect([...files.keys()].filter((k) => k !== 'manifest.json').sort()).toEqual(manifest.files.map((f) => f.path).sort());
      const actions = files.get('actions.jsonl')!.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as { api: string; before?: string; after?: string });
      expect(actions.map((a) => a.api.split('.').pop())).toEqual(['goto', 'fill']);
      expect(files.has(actions[1].after!)).toBe(true);
      // Studio's viewer opens it: steps with snapshots that mark the target.
      const opened = await readBrowserTrace(zip);
      expect(opened.problems).toEqual([]);
      expect(opened.trace).toMatchObject({ source: 'browser', journeyName: 'firefox trace', browser: 'firefox' });
      expect(opened.trace.steps.map((st) => st.action)).toEqual(['goto', 'fill']);
      expect(opened.trace.steps[1].snapshots.after?.target?.nid).toBeGreaterThan(0);
    });

    it('says clearly what needs the Chrome DevTools Protocol', async () => {
      await withPage(async (page, ctx) => {
        expect(() => page.cdpSession()).toThrow(/not available in Firefox/);
        await expect(ctx.newCDPSession(page)).rejects.toThrow(/not available in Firefox/);
      });
    });
  });
});

describe.skipIf(!executable)('runner with browser: firefox', () => {
  it('runs a journey end to end on Firefox', async () => {
    const server = await startDemoApp({ variant: 'a' });
    try {
      const out = await tempDir('ff-runner');
      const run = await runJourneys([bobOrderJourney()], { ...FAST, browser: 'firefox', baseUrl: server.url, outputDir: out, screenshots: 'every-step', trace: true });
      const j = run.journeys[0];
      expect(j.steps.map((s) => `${s.stepId}:${s.status}:${s.error?.message ?? ''}`)).toEqual(j.steps.map((s) => `${s.stepId}:passed:`));
      expect(run.environment.browser).toMatch(/firefox/i);
      expect(String(j.ledger.orderNumber)).toMatch(/^ORD-\d+$/);
    } finally {
      await server.close();
    }
  });
});
