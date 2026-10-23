/**
 * Journeys from captured user sessions (gap G36). The capture snippet records
 * a real browsing session in Chromium (privacy-safe: no keystroke values
 * unless allow-listed, and then masked); HAR and rrweb inputs are normalised
 * the same way; sessions cluster into common paths, generate ranked .ez
 * journeys with assertions, and the coverage gap names paths no existing
 * journey covers. The generated journeys parse and replay.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import {
  captureSnippet, clusterSessions, coverageGap, generateJourneys, journeySignature, parseSession, pathOverlap, sessionSignature,
  type CaptureFile, type CapturedSession,
} from '../../src/sessions/index.js';

let app: Server;
let url = '';
let browser: Browser;

beforeAll(async () => {
  app = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    res.writeHead(200, { 'content-type': 'text/html' });
    if (path === '/' || path === '/shop') {
      res.end(`<!doctype html><title>Shop</title><h1>Shop</h1>
<a href="/product" id="go-product" data-testid="product-link">Blue Shoes</a>
<label>Email <input name="email" type="email"></label>
<label>Coupon <input name="coupon"></label>`);
    } else if (path === '/product') {
      res.end(`<!doctype html><title>Blue Shoes</title><h1>Blue Shoes</h1>
<button id="add" data-testid="add-to-cart">Add to cart</button>`);
    } else {
      res.end('<!doctype html><title>404</title>');
    }
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => app.close(() => r()));
});

/** Drive a real session with the capture snippet and return what it recorded. */
async function capture(allow: string[]): Promise<CaptureFile> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(captureSnippet({ allowValues: allow, autostart: true }));
  await page.goto(`${url}/shop`);
  await page.fill('input[name=email]', 'buyer@example.com');
  await page.fill('input[name=coupon]', 'SAVE10');
  await page.click('#go-product');
  await page.waitForURL('**/product');
  await page.click('#add');
  const file = (await page.evaluate('window.__ezCapture.flush()')) as CaptureFile;
  await ctx.close();
  return file;
}

describe('capture snippet (privacy)', () => {
  it('records which fields were used but no keystroke values unless allow-listed, and then masked', async () => {
    const file = await capture(['coupon']);
    expect(file.eztestCapture).toBe(1);
    const inputs = file.events.filter((e) => e.kind === 'input') as Array<{ target: { name?: string; label?: string }; value?: string; masked: boolean }>;
    const email = inputs.find((e) => e.target.label === 'Email' || e.target.name === 'Email')!;
    const coupon = inputs.find((e) => e.target.label === 'Coupon' || e.target.name === 'Coupon')!;
    expect(email.value).toBeUndefined(); // not allow-listed: value never left the page
    expect(coupon.value).toBe('xxxx##'); // allow-listed but masked to its shape
    expect(JSON.stringify(file)).not.toContain('buyer@example.com');
    expect(JSON.stringify(file)).not.toContain('SAVE10');
    // the navigation and click were recorded
    expect(file.events.some((e) => e.kind === 'navigate' && e.url.endsWith('/product'))).toBe(true);
    expect(file.events.some((e) => e.kind === 'click' && (e as { target: { testId?: string } }).target.testId === 'product-link')).toBe(true);
  }, 60_000);
});

describe('formats', () => {
  it('reads a HAR into navigations and API calls', () => {
    const har = {
      log: {
        entries: [
          { startedDateTime: '2026-01-01T00:00:00Z', _resourceType: 'document', request: { method: 'GET', url: `${url}/shop` }, response: { status: 200, content: { mimeType: 'text/html' } } },
          { startedDateTime: '2026-01-01T00:00:01Z', _resourceType: 'xhr', request: { method: 'POST', url: `${url}/api/cart` }, response: { status: 201 } },
          { startedDateTime: '2026-01-01T00:00:02Z', _resourceType: 'document', request: { method: 'GET', url: `${url}/product` }, response: { status: 200, content: { mimeType: 'text/html' } } },
        ],
      },
    };
    const s = parseSession(har, 'x.har', 'h1')!;
    expect(s.source).toBe('har');
    expect(s.events.map((e) => e.kind)).toEqual(['navigate', 'api', 'navigate']);
    expect(s.baseUrl).toBe(`${url}/shop`);
  });

  it('reads rrweb events: full snapshot + click + input resolve to the element', () => {
    const rrweb = [
      { type: 4, timestamp: 1, data: { href: 'https://app.test/shop' } },
      { type: 2, timestamp: 2, data: { node: { id: 1, type: 2, tagName: 'html', childNodes: [
        { id: 2, type: 2, tagName: 'body', childNodes: [
          { id: 3, type: 2, tagName: 'button', attributes: { 'data-testid': 'add-to-cart' }, childNodes: [{ id: 4, type: 3, textContent: 'Add to cart' }] },
          { id: 5, type: 2, tagName: 'input', attributes: { name: 'email', type: 'email' }, childNodes: [] },
        ] },
      ] } } },
      { type: 3, timestamp: 3, data: { source: 5, id: 5, text: 'secret' } },
      { type: 3, timestamp: 4, data: { source: 2, type: 2, id: 3 } },
    ];
    const s = parseSession(rrweb, 'x.json', 'r1')!;
    expect(s.source).toBe('rrweb');
    expect(s.events.map((e) => e.kind)).toEqual(['navigate', 'input', 'click']);
    const click = s.events.find((e) => e.kind === 'click') as { target: { testId?: string; name?: string } };
    expect(click.target.testId).toBe('add-to-cart');
    expect(JSON.stringify(s)).not.toContain('secret'); // rrweb input values are not kept
  });
});

describe('cluster, generate and coverage', () => {
  it('clusters by path, ranks by frequency, and generates replayable journeys with assertions', async () => {
    // Three users take the shop->product->add path; one only browses the shop.
    const a = parseSession(await capture(['coupon']), 'a.json', 'a')!;
    const b: CapturedSession = { ...a, id: 'b' };
    const c: CapturedSession = { ...a, id: 'c' };
    const browseOnly: CapturedSession = { id: 'd', source: 'eztest', baseUrl: `${url}/shop`, events: [{ kind: 'navigate', url: `${url}/shop`, title: 'Shop', t: 1 }] };
    const clusters = clusterSessions([a, b, c, browseOnly]);
    expect(clusters[0].count).toBe(3); // the checkout path is most frequent
    expect(clusters.length).toBe(2);
    const generated = generateJourneys(clusters, { namePrefix: 'Shop' });
    expect(generated[0].count).toBe(3);
    expect(generated[0].frequency).toBeCloseTo(0.75, 2);
    // allow-listed masked input becomes a Variables placeholder to fill
    expect(generated[0].ez).toMatch(/Variables: .*REPLACE_ME/);
    expect(generated[0].ez).toMatch(/Click the "Blue Shoes"/);
    expect(generated[0].ez).toMatch(/Expect the (URL|page)/);

    // the generated journey parses and replays against the app (after filling the masked values)
    const ez = generated[0].ez.replace(/REPLACE_ME/g, 'x');
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-sess-'));
    const run = await runJourneys([parseEzScript(ez)], { outputDir, baseUrl: url, stepTimeoutMs: 15_000, conditionTimeoutMs: 4000 });
    expect(run.journeys[0].status, run.journeys[0].error?.message).toMatch(/^passed/);
  }, 120_000);

  it('reports the coverage gap against existing journeys', async () => {
    const a = parseSession(await capture([]), 'a.json', 'a')!;
    const checkout: CapturedSession = { ...a, id: 'chk' };
    const search: CapturedSession = { id: 'srch', source: 'eztest', baseUrl: `${url}/shop`, events: [
      { kind: 'navigate', url: `${url}/shop`, title: 'Shop', t: 1 },
      { kind: 'input', target: { role: 'textbox', name: 'Search', label: 'Search' }, masked: true, t: 2 },
      { kind: 'click', target: { role: 'button', name: 'Go' }, t: 3 },
    ] };
    const clusters = clusterSessions([checkout, checkout, search]);
    const existing = parseEzScript(`Journey: Checkout
Open "/shop"
Type "a@b.com" into the "Email" field
Type "SAVE10" into the "Coupon" field
Click the "Blue Shoes" link
Click the "Add to cart" button
`);
    const gap = coverageGap(clusters, [existing]);
    // the checkout path is covered; the search path is a gap
    expect(gap.covered.some((c) => c.journeyId === 'checkout')).toBe(true);
    expect(gap.uncovered.some((u) => u.signature.includes('Search') || u.signature.includes('search'))).toBe(true);
    expect(gap.coverageRatio).toBeGreaterThan(0.5);
  }, 60_000);

  it('path overlap and signatures are stable', () => {
    expect(pathOverlap('navigate:/a > click:button:ok', 'navigate:/a > click:button:ok')).toBe(1);
    expect(pathOverlap('navigate:/a', 'navigate:/b')).toBe(0);
    const j = parseEzScript('Journey: j\nOpen "/shop"\nClick the "Add to cart" button\n');
    expect(journeySignature(j)).toContain('navigate:/shop');
    const s: CapturedSession = { id: 's', source: 'eztest', events: [{ kind: 'navigate', url: '/shop', t: 1 }, { kind: 'click', target: { role: 'button', name: 'Add to cart' }, t: 2 }] };
    expect(pathOverlap(sessionSignature(s), journeySignature(j))).toBe(1);
  });
});
