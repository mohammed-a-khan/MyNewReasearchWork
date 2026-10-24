/**
 * Browser-level regression tests for gaps the enterprise reference suite found
 * (examples/enterprise-reference/FINDINGS.md): page text inside frame blocks, virtualized
 * grids that cannot be scrolled, accessibility false positives, native form validation, and (run with
 * `npm run test:firefox`) actions inside an iframe that is scrolled out of view.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { parseEzScript, parseIntent } from '../../src/intent/index.js';
import { Step } from '../../src/core/index.js';
import { evaluateConditionOnce } from '../../src/runner/index.js';
import { Ledger } from '../../src/runner/ledger.js';
import { locateWidget, readGridRows } from '../../src/runner/components/index.js';
import { nativeInvalidFields } from '../../src/runner/reliability/diagnose.js';
import { scanAccessibility } from '../../src/a11y/index.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runJourneys } from '../../src/runner/index.js';
import { FAST, tempDir } from '../runner/fixtures.js';

const PAGES: Record<string, string> = {
  '/frame-host': '<!doctype html><html lang="en"><head><title>Host</title></head><body><h1>Main page</h1><iframe id="decl" title="Declaration" src="/frame-inner"></iframe></body></html>',
  // An iframe below the fold: the checkbox is in view inside the frame, but the frame is not in the page's view.
  '/frame-below': '<!doctype html><html lang="en"><head><title>Below</title></head><body><div style="height:1500px">Claim form</div><iframe id="decl" title="Declaration" src="/frame-check"></iframe></body></html>',
  '/frame-check': '<!doctype html><html lang="en"><head><title>Check</title></head><body><label><input type="checkbox" id="agree"> I agree to the declaration</label></body></html>',
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

describe('FINDING: on Firefox, a checkbox in an iframe below the fold could not be checked', () => {
  it('scrolls the page so the frame, not only the element inside it, is in view', async () => {
    await page.goto(`${base}/frame-below`);
    const box = page.frameLocator('#decl').getByRole('checkbox', { name: 'I agree to the declaration' });
    await box.check({ timeout: 5000 });
    expect(await box.isChecked()).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
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

describe('FINDING: a browser killed mid-run (out of memory) aborted the whole run without results', () => {
  it('reports the journey it took down as an environment failure, relaunches the browser and runs the rest', async () => {
    const out = await tempDir('crash');
    const ok = (n: number) => parseEzScript(`Journey: After the crash ${n}\nOpen ${base}/frame-host\n  Expect the page contains "Main page"`);
    const victim = parseEzScript(`Journey: Browser dies\nOpen ${base}/frame-host\nRun step "kill-browser"\nOpen ${base}/grid-complete`);
    const run = await runJourneys([victim, ok(1), ok(2)], {
      ...FAST, baseUrl: base, outputDir: out, concurrency: 1,
      customSteps: { 'kill-browser': async (p) => { p.context().browser()!.process()!.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 500)); } },
    });
    expect(run.journeys.map((j) => [j.journeyId, j.status])).toEqual([['browser-dies', expect.stringMatching(/^(failed|error)$/)], ['after-the-crash-1', 'passed'], ['after-the-crash-2', 'passed']]);
    expect(run.journeys[0].reliability?.environment?.reason).toMatch(/crashed|connection dropped|has been closed/);
    expect(existsSync(join(out, run.runId, 'run.json'))).toBe(true);
  }, 120_000);
});

describe('FINDING: a long Firefox run grew the browser by ~30 MB per closed window until it was killed', () => {
  it('recycles the browser after recycleBrowserAfter journeys and closes the old one when its journeys end', async () => {
    const out = await tempDir('recycle');
    type B = { isConnected(): boolean };
    const seen: Array<{ browser: B; firstStillOpen: boolean }> = [];
    const js = [1, 2, 3, 4, 5].map((n) => parseEzScript(`Journey: Recycled ${n}\nOpen ${base}/frame-host\nRun step "note-browser"\n  Expect the page contains "Main page"`));
    const run = await runJourneys(js, {
      ...FAST, baseUrl: base, outputDir: out, concurrency: 1, recycleBrowserAfter: 2,
      customSteps: {
        'note-browser': async (p) => {
          const b = p.context().browser() as unknown as B;
          const first = seen[0]?.browser;
          seen.push({ browser: b, firstStillOpen: !!first && first !== b && first.isConnected() });
        },
      },
    });
    expect(run.journeys.map((j) => j.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    const used = [...new Set(seen.map((s) => s.browser))];
    expect(seen.map((s) => used.indexOf(s.browser))).toEqual([0, 0, 1, 1, 2]);
    // The first browser closed once its journeys had ended (concurrency 1: before journey 3 ran).
    expect(seen.slice(2).some((s) => s.firstStillOpen)).toBe(false);
  }, 120_000);
});
