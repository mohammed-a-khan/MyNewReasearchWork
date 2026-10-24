/**
 * Studio's Results page shows the run report's analysis: readiness against
 * the previous run, what needs attention, failure categories with the
 * suggested next step and the report files (PDF, Excel, e-mail summary), and
 * a Report tab with the run's full HTML report in place - checked in a real
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
    expect(d.reportSummary.verdict.decision).toBe('NO_GO');
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

  it('shows readiness, what needs attention, categories with next steps and the report files on the Overview', async () => {
    await page.goto(`${studio.url}`);
    await page.goto(`${studio.origin}/#/runs/${runId}`);
    const s = page.locator('#run-report-summary');
    await expect.poll(() => s.isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await s.locator('.rr-v-decision').textContent()).toBe('NO GO');
    expect(await page.locator('#rr-attention').textContent()).toMatch(/New failures/);
    const cats = page.locator('#rr-categories');
    expect(await cats.textContent()).toMatch(/Test issue[\s\S]*1 test[\s\S]*Manager exports the customer list[\s\S]*Suggested next step: /);
    expect(await cats.getByRole('link', { name: 'Manager exports the customer list' }).getAttribute('href')).toBe(`#/runs/${runId}/manager-exports-the-customer-list`);
    const files = page.getByRole('group', { name: 'Report files' }).first();
    expect(await files.getByRole('link', { name: 'PDF report' }).getAttribute('href')).toBe(`/runs/${runId}/report.pdf`);
    expect(await files.getByRole('link', { name: 'Excel workbook' }).getAttribute('href')).toBe(`/runs/${runId}/report.xlsx`);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousA11y(page, `results-report-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('opens the full HTML report in the Report tab, with its tests, failure and categories', async () => {
    await page.getByRole('tab', { name: 'Report' }).click();
    const frame = page.frameLocator('#run-report-frame');
    await expect.poll(() => frame.locator('#summary-h').textContent(), { timeout: 30_000 }).toBe('Executive summary');
    expect(await frame.locator('#categories').textContent()).toMatch(/Test issue/);
    await expect.poll(() => frame.locator('#vinner .row[data-id]').count()).toBeGreaterThan(0);
    await frame.locator('#vinner .row[data-id="manager-exports-the-customer-list"]').click();
    await expect.poll(() => frame.locator('#detail .catbox').textContent()).toMatch(/Test issue[\s\S]*Suggested next step/);
    expect(pageErrors).toEqual([]);
  });
});
