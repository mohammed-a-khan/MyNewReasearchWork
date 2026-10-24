/**
 * Browser-level regression tests for gaps the enterprise reference suite found
 * (examples/enterprise-reference/FINDINGS.md): page text inside frame blocks, virtualized
 * grids that cannot be scrolled, accessibility false positives, native form validation.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { parseIntent } from '../../src/intent/index.js';
import { Step } from '../../src/core/index.js';
import { evaluateConditionOnce } from '../../src/runner/index.js';
import { Ledger } from '../../src/runner/ledger.js';
import { locateWidget, readGridRows } from '../../src/runner/components/index.js';
import { nativeInvalidFields } from '../../src/runner/reliability/diagnose.js';
import { scanAccessibility } from '../../src/a11y/index.js';

const PAGES: Record<string, string> = {
  '/frame-host': '<!doctype html><html lang="en"><head><title>Host</title></head><body><h1>Main page</h1><iframe id="decl" title="Declaration" src="/frame-inner"></iframe></body></html>',
  '/frame-inner': '<!doctype html><html lang="en"><head><title>Inner</title></head><body><p>Declaration confirmed.</p></body></html>',
  // A virtualized ARIA grid whose viewport is not height-limited: only 5 of 100 rows are rendered and nothing scrolls.
  '/grid': `<!doctype html><html lang="en"><head><title>Grid</title></head><body>
    <div role="grid" aria-label="Claims" aria-rowcount="101">
      <div role="rowgroup"><div role="row" aria-rowindex="1"><div role="columnheader">Claim</div><div role="columnheader">Status</div></div></div>
      <div role="rowgroup">${Array.from({ length: 5 }, (_, i) => `<div role="row" aria-rowindex="${i + 2}"><div role="gridcell">CLM-${i}</div><div role="gridcell">Open</div></div>`).join('')}</div>
    </div></body></html>`,
  '/grid-complete': `<!doctype html><html lang="en"><head><title>Grid</title></head><body>
    <div role="grid" aria-label="Claims" aria-rowcount="4">
      <div role="rowgroup"><div role="row" aria-rowindex="1"><div role="columnheader">Claim</div></div></div>
      <div role="rowgroup">${Array.from({ length: 3 }, (_, i) => `<div role="row" aria-rowindex="${i + 2}"><div role="gridcell">CLM-${i}</div></div>`).join('')}</div>
    </div></body></html>`,
  '/form': `<!doctype html><html lang="en"><head><title>Form</title></head><body><main>
    <form id="a"><label for="sum">Sum insured</label><input id="sum" type="number" min="1000" step="1000" value="18500"><button>Calculate</button></form>
    <form id="b" novalidate><label for="name">Name</label><input id="name" required><button>Save</button></form>
    </main></body></html>`,
  '/date': `<!doctype html><html lang="en"><head><title>Date</title></head><body><main><h1>Claim</h1>
    <label for="d">Incident date</label><input id="d" type="date">
    <label for="amt">Amount</label><input id="amt">
    <button type="button">Submit</button>
    <iframe title="Loading frame" src="/slow"></iframe>
    </main></body></html>`,
};

let server: Server;
let base = '';
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/slow') {
      // Never answers during the test: the frame stays on its initial about:blank document.
      return;
    }
    res.writeHead(PAGES[path] ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[path] ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
});
afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const env = (frames?: string[]) => ({ page, ledger: new Ledger(), vars: () => ({}), interpolate: (s: string) => s, ...(frames ? { frames } : {}) });
const cond = (line: string) => Step.parse(parseIntent(line)).postconditions[0];

describe('FINDING: "the page contains" inside a frame block read the main page', () => {
  it('with a frame chain, page text is the frame\'s text', async () => {
    await page.goto(`${base}/frame-host`);
    await page.frameLocator('#decl').locator('p').waitFor();
    expect((await evaluateConditionOnce(cond('Expect the page contains "Declaration confirmed."'), env(['#decl']))).passed).toBe(true);
    expect((await evaluateConditionOnce(cond('Expect the page contains "Declaration confirmed."'), env())).passed).toBe(false);
    expect((await evaluateConditionOnce(cond('Expect the page contains "Main page"'), env())).passed).toBe(true);
  });
});

describe('FINDING: a virtualized grid that cannot be scrolled was read as complete', () => {
  it('reading fewer rows than aria-rowcount declares fails and says why', async () => {
    await page.goto(`${base}/grid`);
    const grid = await locateWidget(page, 'the Claims grid', 'grid');
    await expect(readGridRows(grid)).rejects.toThrow(/declares 100 data rows \(aria-rowcount\) but only 5 could be read: no scrollable viewport/);
  });

  it('a grid whose rows are all rendered still reads normally', async () => {
    await page.goto(`${base}/grid-complete`);
    const r = await readGridRows(await locateWidget(page, 'the Claims grid', 'grid'));
    expect(r.rows.length).toBe(3);
  });
});

describe('FINDING: a form that never submits because of native validation said nothing', () => {
  it('lists the fields the browser rejects, ignoring novalidate forms', async () => {
    await page.goto(`${base}/form`);
    const fields = await nativeInvalidFields(page);
    expect(fields.length).toBe(1);
    expect(fields[0]).toMatch(/^Sum insured: /);
  });
});

describe('FINDING: accessibility false positives', () => {
  it('Tab through the parts of <input type=date> is not a keyboard trap; a loading about:blank frame needs no lang', async () => {
    await page.goto(`${base}/date`, { waitUntil: 'domcontentloaded' });
    const r = await scanAccessibility(page, { rules: ['keyboard.trap', 'lang.page'], dynamic: { keyboard: true } });
    expect(r.violations.map((v) => v.ruleId)).toEqual([]);
  });
});
