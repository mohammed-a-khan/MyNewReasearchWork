/**
 * Reporting at scale: a synthetic 10,000-test run (8 steps each, 80,000
 * evidence entries). The report must stay within its size and build-time
 * budget, open quickly in a real browser, keep only a window of rows in the
 * DOM, and still let a reader search, filter and open any test.
 */
import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from '../../src/browser/index.js';
import { buildReportModel, renderEmailHtml, renderReportModelHtml, renderReportPdf, renderReportXlsx, writeReports } from '../../src/report/index.js';
import { scriptJson } from '../../src/scale/report.js';
import { syntheticRun } from './synthetic.js';

const N = 10_000;
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

describe('report of a 10,000-test run', () => {
  it('builds within its time and size budget', () => {
    const t = performance.now();
    const model = buildReportModel(run, { evidence });
    const html = renderReportModelHtml(model);
    const ms = performance.now() - t;
    console.log(`[report-perf] ${N} tests: ${(html.length / 1e6).toFixed(1)} MB in ${Math.round(ms)} ms`);
    expect(html.length).toBeLessThan(24_000_000);
    expect(html.length / N).toBeLessThan(2400);
    expect(ms).toBeLessThan(8_000);
  });

  it('writeReports writes it (with the JSON, CSV and summary) in a few seconds', async () => {
    const t = performance.now();
    const out = await writeReports(dir, run, { formats: ['html', 'json'], evidence, context: { browsers: [], devices: [], eztestVersion: 'x', node: 'v22', machine: { os: 'linux' }, startedAt: run.startedAt, finishedAt: run.finishedAt, timeZone: 'UTC', extra: {} } });
    console.log(`[report-perf] writeReports: ${Math.round(performance.now() - t)} ms, html ${((await stat(out.html!)).size / 1e6).toFixed(1)} MB, json ${((await stat(out.json!)).size / 1e6).toFixed(1)} MB`);
    expect(performance.now() - t).toBeLessThan(20_000);
  }, 60_000);

  it('writes the PDF, Excel and e-mail exports of the 10,000 tests within their budget', async () => {
    const model = buildReportModel(run, { evidence });
    let t = performance.now();
    const xlsx = await renderReportXlsx(model);
    const xlsxMs = performance.now() - t;
    t = performance.now();
    const pdf = renderReportPdf(model);
    const pdfMs = performance.now() - t;
    t = performance.now();
    const mail = renderEmailHtml(model);
    const mailMs = performance.now() - t;
    console.log(`[report-perf] xlsx ${(xlsx.length / 1e6).toFixed(1)} MB in ${Math.round(xlsxMs)} ms; pdf ${(pdf.length / 1e6).toFixed(1)} MB in ${Math.round(pdfMs)} ms; e-mail ${Math.round(mail.length / 1024)} KiB in ${Math.round(mailMs)} ms`);
    expect(xlsxMs).toBeLessThan(6_000);
    expect(pdfMs).toBeLessThan(8_000);
    expect(mailMs).toBeLessThan(1_000);
    // The e-mail stays small whatever the run size (top failures only).
    expect(mail.length).toBeLessThan(120_000);
  }, 60_000);

  it('embedded data cannot break out of its script element', () => {
    expect(scriptJson({ x: '</script><img src=x onerror=alert(1)>' })).not.toContain('</script>');
  });

  it('a 5,000-test report is interactive within 2 seconds', async ({ skip }) => {
    if (!browser) skip();
    const small = syntheticRun(5000, { failEvery: 25, healEvery: 40 });
    const d5 = join(dir, 'r5000');
    await writeReports(d5, small.run, { formats: ['html'], evidence: small.evidence, context: { browsers: [], devices: [], eztestVersion: 'x', node: 'v22', machine: { os: 'linux' }, startedAt: small.run.startedAt, finishedAt: small.run.finishedAt, timeZone: 'UTC', extra: {} } });
    const page = await browser!.newPage();
    // Warm the browser once (process start-up is not the report's time).
    await page.goto('about:blank');
    const t = Date.now();
    await page.goto(pathToFileURL(join(d5, 'report.html')).href + '#tests');
    await page.waitForSelector('#vlist .row');
    const ms = Date.now() - t;
    console.log(`[report-perf] browser: 5000-test report interactive in ${ms} ms`);
    expect(ms).toBeLessThan(2_000);
    await page.close();
  }, 120_000);

  it('opens fast in a browser, virtualises the list, searches, filters and opens any test', async ({ skip }) => {
    if (!browser) skip();
    const page = await browser!.newPage();
    const t = Date.now();
    await page.goto(pathToFileURL(join(dir, 'report.html')).href + '#tests');
    await page.waitForSelector('#vlist .row');
    const ms = Date.now() - t;
    console.log(`[report-perf] browser: ${N}-test report interactive in ${ms} ms`);
    expect(ms).toBeLessThan(15_000);
    await page.selectOption('#group', 'none');
    expect(await page.locator('#vlist .row').count()).toBeLessThan(100);
    expect(await page.locator('#count').textContent()).toBe('Showing all');
    const s = Date.now();
    await page.fill('#q', 'journey-9975');
    await expect.poll(() => page.locator('#count').textContent()).toBe('1 shown for "journey-9975"');
    console.log(`[report-perf] search over ${N} tests: ${Date.now() - s} ms`);
    await page.locator('#vlist .row').first().click();
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Journey 9975: order flow variant 22');
    expect(await page.locator('#detail').textContent()).toContain('Error 500'); // 9975 % 25 === 0: a failed test shows its step error
    await page.fill('#q', '');
    await page.locator('.fchip[data-state="failed"]').click();
    await expect.poll(() => page.locator('#count').textContent()).toBe(`${N / 25} shown`);
    // scrolling far down renders the rows there
    await page.locator('.fchip[data-state="all"]').click();
    await page.locator('#vlist').evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(() => page.locator('#vlist .row').last().textContent()).toContain('Journey 9999');
    expect(await page.locator('#vlist .row').count()).toBeLessThan(100);
    // a permalink deep in the run
    await page.goto(pathToFileURL(join(dir, 'report.html')).href + '#tests/journey-7777');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Journey 7777: order flow variant 7');
    await page.close();
  }, 120_000);
});
