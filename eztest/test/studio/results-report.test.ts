/**
 * Studio's Results page opens a run on its report: the Report tab (first and
 * selected) shows the run's HTML report in place with its files (PDF, Excel,
 * e-mail summary), and Studio does not repeat the report's overview in tabs
 * of its own; there is no verdict anywhere by default - checked in a real
 * Chromium against a real run of the shop project with a failing journey,
 * light and dark, with EZTest's accessibility engine.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject, raw, readSse, SHOP_ENV_KEYS } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

let app: DemoServer;
let studio: StudioHandle;
let project: string;
let browser: Browser;
let page: Page;
let runId: string;
let c: ReturnType<typeof client>;
const saved: Record<string, string | undefined> = {};
const pageErrors: string[] = [];

beforeAll(async () => {
  project = await copyShopProject();
  await writeFile(join(project, 'journeys', 'export-customers.ez'), 'Journey: Manager exports the customer list\nTags: @smoke @customers\nRisk: 2\n\nLog in as manager\nOpen "/dashboard"\nClick the "Export customers" button [timeout=1500ms]\n');
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = { SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db'), SHOP_ALICE_PASSWORD: 'Wonderland#1', SHOP_ALICE_TOTP: DEMO_TOTP_SECRET, SHOP_BOB_PASSWORD: 'Builder#2', SHOP_API_CLIENT_SECRET: 'ez-client-secret' };
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  studio = await startStudio({ cwd: project, recordHeadless: true });
  c = client(studio.port, studio.token);
  const start = await c.post('/api/runs', { tags: ['identity', 'customers'], heal: false });
  expect(start.status, start.body).toBe(202);
  runId = start.json().id;
  await readSse(studio.port, `/api/runs/${runId}/events`, studio.token, (e) => e.type === 'done', 180_000);
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Studio Results: the run report', () => {
  it('serves the report analysis, the export files, and the report for framing by Studio only', async () => {
    const d = (await c.get(`/api/runs/${runId}`)).json();
    expect(d.exports.map((x: { format: string }) => x.format)).toEqual(expect.arrayContaining(['pdf', 'xlsx', 'email', 'summary', 'json']));
    expect(d.reportSummary.verdict).toBeUndefined();
    expect(d.reportSummary.categories).toEqual({ test: 1 });
    expect(d.reportSummary.failures[0]).toMatchObject({ id: 'manager-exports-the-customer-list', category: 'test', fix: expect.stringMatching(/locator/) });
    const rep = await raw(studio.port, `/runs/${runId}/report.html`, { headers: { cookie: `eztest_studio=${studio.token}` } });
    expect(rep.status).toBe(200);
    expect(rep.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(String(rep.headers['content-security-policy'])).toMatch(/frame-ancestors 'self'/);
    expect(String(rep.headers['content-security-policy'])).toMatch(/media-src 'self' blob:/);
    const pdf = await raw(studio.port, `/runs/${runId}/report.pdf`, { headers: { cookie: `eztest_studio=${studio.token}` } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.startsWith('%PDF-1.7')).toBe(true);
  });

  it('opens the run on its report, with the report files, no duplicated overview and no verdict', async () => {
    await page.goto(`${studio.url}`);
    await page.goto(`${studio.origin}/#/runs/${runId}`);
    const reportTab = page.getByRole('tab', { name: 'Report' });
    await expect.poll(() => reportTab.getAttribute('aria-selected'), { timeout: 30_000 }).toBe('true');
    const tabs = await page.locator('#run-detail [role=tab]').allTextContents();
    expect(tabs[0]).toMatch(/^Report/);
    expect(tabs.join(' ')).not.toMatch(/Overview|Screenshots|Triage/);
    expect(await page.locator('#run-detail').textContent()).not.toMatch(/readiness|NO GO/i);
    expect(await page.locator('#run-detail').textContent()).toMatch(/Evidence verified/);
    const files = page.getByRole('group', { name: 'Report files' }).first();
    expect(await files.getByRole('link', { name: 'PDF report' }).getAttribute('href')).toBe(`/runs/${runId}/report.pdf`);
    expect(await files.getByRole('link', { name: 'Excel workbook' }).getAttribute('href')).toBe(`/runs/${runId}/report.xlsx`);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousA11y(page, `results-report-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('shows the full report in place: its tabs, the failures by cause and the test detail', async () => {
    const frame = page.frameLocator('#run-report-frame');
    await expect.poll(() => frame.locator('#tab-overview').getAttribute('aria-selected'), { timeout: 30_000 }).toBe('true');
    await frame.locator('#tab-failures').click();
    expect(await frame.locator('#p-failures').textContent()).toMatch(/Test issue[\s\S]*Manager exports the customer list/);
    await frame.locator('#tab-tests').click();
    await expect.poll(() => frame.locator('#vinner .row[data-id]').count()).toBeGreaterThan(0);
    await frame.locator('#vinner .row[data-id="manager-exports-the-customer-list"]').click();
    await expect.poll(() => frame.locator('#detail .cause').textContent()).toMatch(/Test issue[\s\S]*Next step/);
    // A journey deep link in Studio opens the report on that test.
    await page.goto(`${studio.origin}/#/runs/${runId}/manager-exports-the-customer-list/x/report`);
    await expect.poll(() => page.frameLocator('#run-report-frame').locator('#d-title').textContent(), { timeout: 30_000 }).toBe('Manager exports the customer list');
    expect(pageErrors).toEqual([]);
  });
});
