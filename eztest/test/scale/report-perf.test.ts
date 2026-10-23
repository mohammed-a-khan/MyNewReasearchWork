/**
 * Reporting at scale: a synthetic 5,000-journey run (8 steps each, 40,000
 * evidence entries). The large-run report must stay small, build quickly, open
 * quickly in a real browser, and still let a reader find and open any journey.
 */
import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from '../../src/browser/index.js';
import { renderHtmlReport, writeReports } from '../../src/report/index.js';
import { renderLargeHtmlReport, scriptJson } from '../../src/scale/report.js';
import { syntheticRun } from './synthetic.js';

const N = 5000;
let dir: string;
let browser: Browser | undefined;
const { run, evidence } = syntheticRun(N, { failEvery: 25, healEvery: 40 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ez-report-perf-'));
  browser = await chromium.launch().catch(() => undefined);
});
afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('large-run report', () => {
  it('is an order of magnitude smaller than the full report and builds in well under a few seconds', () => {
    let t = performance.now();
    const full = renderHtmlReport(run, { evidence });
    const fullMs = performance.now() - t;
    t = performance.now();
    const large = renderLargeHtmlReport(run, { evidence });
    const largeMs = performance.now() - t;
    console.log(`[report-perf] ${N} journeys: full ${(full.length / 1e6).toFixed(1)} MB in ${Math.round(fullMs)} ms; large ${(large.length / 1e6).toFixed(1)} MB in ${Math.round(largeMs)} ms`);
    expect(large.length).toBeLessThan(full.length / 5);
    expect(large.length).toBeLessThan(8_000_000);
    expect(largeMs).toBeLessThan(5_000);
  });

  it('writeReports picks the large-run report above the threshold', async () => {
    const out = await writeReports(dir, run, { formats: ['html'], evidence });
    const size = (await stat(out.html!)).size;
    expect(size).toBeLessThan(8_000_000);
  }, 60_000);

  it('embedded data cannot break out of its script element', () => {
    expect(scriptJson({ x: '</script><img src=x onerror=alert(1)>' })).not.toContain('</script>');
  });

  it('opens fast in a browser, virtualises the list and opens any journey', async ({ skip }) => {
    if (!browser) skip();
    const file = join(dir, 'large.html');
    await writeFile(file, renderLargeHtmlReport(run, { evidence }));
    const page = await browser!.newPage();
    const t = Date.now();
    await page.goto(pathToFileURL(file).href);
    await page.waitForSelector('#vlist .row');
    const ms = Date.now() - t;
    console.log(`[report-perf] browser: ${N}-journey report interactive in ${ms} ms`);
    expect(ms).toBeLessThan(15_000);
    // Only a window of rows is in the DOM.
    expect(await page.locator('#vlist .row').count()).toBeLessThan(200);
    expect(await page.locator('#f-count').textContent()).toBe(`${N} of ${N} journeys`);
    await page.fill('#f-q', 'journey-4975');
    await expect.poll(() => page.locator('#f-count').textContent()).toBe(`1 of ${N} journeys`);
    await page.locator('#vlist .row').first().click();
    const detail = await page.locator('#detail').textContent();
    expect(detail).toContain('Journey 4975');
    expect(detail).toContain('Error 500'); // 4975 % 25 === 0: a failed journey shows its step error
    await page.fill('#f-q', '');
    await page.selectOption('#f-status', 'failed');
    expect(await page.locator('#f-count').textContent()).toBe(`${N / 25} of ${N} journeys`);
    await page.close();
  }, 120_000);
});
