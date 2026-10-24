/**
 * Assurance, Workbench and Project pages in a real Chromium against the EZ
 * Shop demo app (with the invoice-total bug): the document viewer highlights
 * the total where it is printed and names the defect; a visual baseline is
 * approved and an ignore region saved; the a11y overlay outlines offending
 * elements; a REST call becomes a step that validates; SQL reads work and
 * writes are blocked; a role test login; environment switching; mock drift;
 * an evidence pack generated and verified; the accessibility engine on every page (light and
 * dark); and the pdf.js viewer under the real CSP.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, validateText, type StudioHandle } from '../../src/studio/index.js';
import { copyShopProject, SHOP_ENV_KEYS } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

const SHOTS = process.env.EZTEST_SCREENSHOT_DIR;

let app: DemoServer;
let fixture: Server;
let fixtureUrl: string;
let studio: StudioHandle;
let project: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let orderRun: string;
let a11yRun: string;
const pageErrors: string[] = [];
const saved: Record<string, string | undefined> = {};

const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-eztest-token': studio.token, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json()) as T;
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

async function runAndWait(journeys: string[], lenses: string[]): Promise<string> {
  const { id } = await api<{ id: string }>('POST', '/api/runs', { journeys, lenses });
  for (let i = 0; i < 240; i++) {
    const r = await api<{ active?: { id: string } }>('GET', '/api/runs');
    if (!r.active) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const runs = await api<{ runs: Array<{ runId: string }> }>('GET', '/api/runs');
  expect(runs.runs.some((r) => r.runId === id)).toBe(true);
  return id;
}

async function confirm(name: RegExp | string): Promise<void> {
  const dialog = page.getByRole('dialog').last();
  await expect.poll(() => dialog.isVisible()).toBe(true);
  await dialog.getByRole('button', { name, exact: typeof name === 'string' }).click();
}

const view = () => page.locator('.page:not([hidden]) .section-page:not([hidden])');
const lastToast = () => page.locator('.toast').last().textContent();

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `assurance-${name}.png`) });
}

beforeAll(async () => {
  project = await copyShopProject();
  app = await startDemoApp({ dbFile: join(project, 'shop.db'), bug: 'invoice-total' });
  // A page with known accessibility violations (the demo app has none) for the a11y overlay.
  fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><head><title>A11y fixture</title></head><body><main><h1>Fixture page</h1>' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" width="120" height="60">' +
      '<button style="width:80px;height:32px"></button><p style="color:#c8c8c8;background:#fff">Low contrast text</p><input type="text"></main></body></html>');
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', () => r()));
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  await writeFile(join(project, 'journeys', 'a11y-fixture.ez'), `Journey: Accessibility fixture\nTags: @a11y\n\nOpen ${fixtureUrl}/bad\nExpect the page to contain "Fixture page"\n`);
  await mkdir(join(project, 'config'), { recursive: true });
  await writeFile(join(project, 'config', 'staging.yaml'), '# Staging overrides\ntimeouts:\n  step: 20000\n');
  // A mock store whose recorded /api/customers response has a different shape than the live one.
  await mkdir(join(project, 'mocks'), { recursive: true });
  await writeFile(join(project, 'mocks', 'shop-api.json'), JSON.stringify({
    format: 'eztest-mocks', version: 1, target: 'http://placeholder.invalid',
    recordings: [{ id: 'rec-1', request: { method: 'GET', path: '/api/customers', query: '', headers: {} }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: 1, name: 'Contoso Ltd' }] }) } }],
  }, null, 2));
  const env: Record<string, string> = {
    SHOP_URL: app.url,
    SHOP_DB: join(project, 'shop.db'),
    SHOP_ALICE_PASSWORD: 'Wonderland#1',
    SHOP_ALICE_TOTP: DEMO_TOTP_SECRET,
    SHOP_BOB_PASSWORD: 'Builder#2',
    SHOP_API_CLIENT_SECRET: 'ez-client-secret',
  };
  for (const k of [...SHOP_ENV_KEYS, 'EZTEST_MASTER_KEY', 'EZTEST_ENV']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  studio = await startStudio({ cwd: project, recordHeadless: true });
  orderRun = await runAndWait(['create-an-order-and-verify-the-invoice-three-ways'], ['visual:warn', 'security:warn']);
  a11yRun = await runAndWait(['accessibility-fixture'], ['a11y:warn']);
  browser = await chromium.launch();
  // No bypassCSP: EZTest's accessibility engine runs through the driver, under the page's real CSP.
  context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(studio.url);
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await app?.close();
  await new Promise<void>((r) => (fixture ? fixture.close(() => r()) : r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Assurance viewers (Chromium)', () => {
  it('shows the invoice with the mismatch highlighted at the printed total and the verdict', async () => {
    await page.goto(`${studio.origin}/#/assurance/documents/${orderRun}`);
    await expect.poll(() => page.getByRole('heading', { name: 'Document checks', level: 1 }).isVisible()).toBe(true);
    const verdict = page.locator('[data-testid="verdict"]').first();
    await expect.poll(() => verdict.textContent(), { timeout: 30_000 }).toBe('Document generation defect');
    expect(await page.locator('.verdict-banner').first().textContent()).toMatch(/total: document generation defect \(UI and DB agree, the document differs\)/);
    // pdf.js rendered the page and the highlight sits on the total field.
    const total = page.locator('.hl[data-ref="total"]');
    await expect.poll(() => total.count(), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => page.locator('.pdfv-page canvas').first().evaluate((c) => (c as HTMLCanvasElement).width)).toBeGreaterThan(100);
    const box = await total.boundingBox();
    const pageBox = await page.locator('.pdfv-page').first().boundingBox();
    expect(box && pageBox && box.x > pageBox.x + pageBox.width / 2).toBe(true); // the total is printed on the right
    expect(await total.getAttribute('aria-label')).toMatch(/total: document generation defect/);
    // Field ledger: expected vs actual per source.
    const row = page.locator('table.ledger tr[data-ref="total"]');
    expect(await row.textContent()).toMatch(/148\.50.*158\.50.*148\.5/);
    expect(await row.getAttribute('class')).toMatch(/row-bad/);
    // Next mismatch (button and keyboard).
    await page.getByRole('button', { name: 'Next mismatch' }).click();
    await expect.poll(() => page.locator('.toolbar').first().textContent()).toMatch(/Mismatch 1 of 2/);
    await page.keyboard.press('n');
    await expect.poll(() => page.locator('.toolbar').first().textContent()).toMatch(/Mismatch 2 of 2/);
    // Line items tab.
    await page.getByRole('tab', { name: /Line items/ }).click();
    await expect.poll(() => page.locator('[role="tabpanel"]:not([hidden]) table').first().textContent()).toMatch(/SKU-200/);
    await checkA11y(page, 'documents');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('tab', { name: 'Field ledger' }).click();
    await shot('documents');
    await checkA11y(page, 'documents-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('adds Documents, Visual and Security tabs to the run detail', async () => {
    await page.goto(`${studio.origin}/#/runs/${orderRun}`);
    await expect.poll(() => page.getByRole('tab', { name: /Documents/ }).isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await page.getByRole('tab', { name: /Visual/ }).isVisible()).toBe(true);
    expect(await page.getByRole('tab', { name: /Security/ }).isVisible()).toBe(true);
    await page.getByRole('tab', { name: /Documents/ }).click();
    await expect.poll(() => page.locator('#run-detail .hl[data-ref="total"]').count(), { timeout: 30_000 }).toBe(1);
  });

  it('compares two PDFs side by side with synchronised viewers', async () => {
    const r = await api<{ documents: Array<{ journeyId: string }> }>('GET', `/api/assurance/documents/runs/${orderRun}`);
    expect(r.documents.length).toBe(1);
    await page.goto(`${studio.origin}/#/assurance/compare`);
    await expect.poll(() => page.getByRole('heading', { name: 'Compare documents', level: 1 }).isVisible()).toBe(true);
    // Document A: a run download; document B: none, reconciled against the document check instead.
    const a = page.getByRole('group', { name: 'Document A source' });
    await a.getByRole('button', { name: 'Run download' }).click();
    await view().getByLabel('Template').selectOption('templates/invoice.yaml');
    await view().getByLabel('Document check').selectOption('invoice-vs-order');
    await view().getByLabel('Query parameter orderNumber').fill('ORD-1');
    await page.getByRole('button', { name: 'Extract and compare' }).click();
    await expect.poll(() => page.locator('.compare-result [data-testid="verdict"]').textContent(), { timeout: 30_000 }).toMatch(/Document does not foot|Document generation defect|Line items/);
    await checkA11y(page, 'compare');
  });

  it('approves a new visual baseline and saves an ignore region', async () => {
    await page.goto(`${studio.origin}/#/assurance/visual/${orderRun}`);
    await expect.poll(() => page.locator('.vis-item').count(), { timeout: 20_000 }).toBeGreaterThan(3);
    const name = (await page.locator('.vis-viewer [data-name]').getAttribute('data-name'))!;
    expect(existsSync(join(project, '.eztest', 'baselines', `${name}.png`))).toBe(false);
    await checkA11y(page, 'visual');
    await page.getByRole('button', { name: 'Approve as new baseline' }).click();
    await confirm('Approve');
    await expect.poll(lastToast).toMatch(/Baseline approved.*recorded in \.eztest\/approvals\/.*chain verified/);
    expect(existsSync(join(project, '.eztest', 'baselines', `${name}.png`))).toBe(true);
    const approvals = readdirSync(join(project, '.eztest', 'approvals'));
    expect(approvals.length).toBe(1);
    const record = JSON.parse(readFileSync(join(project, '.eztest', 'approvals', approvals[0], 'approval.json'), 'utf8'));
    expect(record.approved[0].name).toBe(name);
    // Ignore region by keyboard coordinates.
    await page.getByText('Add an ignore region by coordinates (keyboard)').click();
    await view().getByLabel('Region x (pixels)').fill('10');
    await view().getByLabel('Region y (pixels)').fill('20');
    await view().getByLabel('Region width (pixels)').fill('200');
    await view().getByLabel('Region height (pixels)').fill('40');
    await page.getByRole('button', { name: 'Add region' }).click();
    await view().getByLabel('Label of new region 1').fill('clock');
    await page.getByRole('button', { name: 'Save ignore regions' }).click();
    await confirm('Save regions');
    await expect.poll(lastToast).toMatch(/Ignore regions saved/);
    const masks = JSON.parse(await readFile(join(project, '.eztest', 'baselines', 'masks.json'), 'utf8'));
    expect(masks[name]).toEqual([{ x: 10, y: 20, width: 200, height: 40, label: 'clock' }]);
    // Modes.
    await page.getByRole('button', { name: 'Onion skin' }).click();
    await page.getByRole('button', { name: 'Diff', exact: true }).click();
    await page.getByRole('button', { name: 'Slider' }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('visual');
    await checkA11y(page, 'visual-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('outlines the offending elements of accessibility violations on the screenshot', async () => {
    await page.goto(`${studio.origin}/#/assurance/a11y/${a11yRun}`);
    await expect.poll(() => page.locator('.rule').count(), { timeout: 20_000 }).toBeGreaterThan(1);
    const rules = await page.locator('.rule').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.rule));
    expect(rules).toEqual(expect.arrayContaining(['text-alt.img', 'name.button']));
    await expect.poll(() => page.locator('.a11y-box').count()).toBeGreaterThan(1);
    const img = page.locator('.a11y-box[data-rule="text-alt.img"]');
    expect(await img.count()).toBe(1);
    expect(await img.getAttribute('aria-label')).toMatch(/informative image has a text alternative/);
    // WCAG references and our own documentation link.
    expect(await page.locator('.rule[data-rule="text-alt.img"] .wcag').allTextContents()).toEqual(expect.arrayContaining(['SC 1.1.1', 'WCAG 2.0 A']));
    expect(await page.locator('.rule[data-rule="text-alt.img"] a').first().getAttribute('href')).toBe('https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html');
    // Filter by impact: hide critical.
    await page.locator('label').filter({ hasText: 'Critical' }).locator('input').uncheck();
    await expect.poll(() => page.locator('.a11y-box[data-rule="text-alt.img"]').count()).toBe(0);
    await page.locator('label').filter({ hasText: 'Critical' }).locator('input').check();
    // Export.
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    expect((await dl).suggestedFilename()).toBe(`a11y-${a11yRun}.csv`);
    await checkA11y(page, 'a11y');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('a11y');
    await checkA11y(page, 'a11y-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('lists security findings with remediation and runs the authorization matrix', async () => {
    await page.goto(`${studio.origin}/#/assurance/security/${orderRun}`);
    await expect.poll(() => page.locator('tr[data-finding="csp-missing"]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await page.locator('tr[data-finding="csp-missing"]').first().textContent()).toMatch(/Content-Security-Policy/);
    await expect.poll(() => page.locator('#authz').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Run matrix' }).click();
    await expect.poll(() => page.locator('#authz table.matrix').textContent(), { timeout: 20_000 }).toMatch(/allow \(200\)/);
    await checkA11y(page, 'security');
  });
});

describe('Workbench (Chromium)', () => {
  it('sends a REST call as a role, saves it as a step and the journey still validates', async () => {
    await page.goto(`${studio.origin}/#/workbench`);
    await expect.poll(() => page.getByRole('heading', { name: 'API & DB workbench' }).isVisible()).toBe(true);
    await expect.poll(() => page.locator('#wb-role option').count()).toBeGreaterThan(1);
    await page.locator('#wb-role').selectOption('manager');
    await page.locator('#wb-url').fill('/api/customers');
    await page.locator('#wb-send').click();
    await expect.poll(() => page.locator('#wb-status').textContent(), { timeout: 20_000 }).toMatch(/^200/);
    expect(await page.locator('#wb-body').textContent()).toMatch(/Contoso Ltd/);
    // The token never reaches the browser.
    await page.getByRole('tab', { name: 'Request' }).click();
    expect(await page.locator('#wb-response').textContent()).toMatch(/Bearer •••• \(token of role manager/);
    // JSONPath tester, then add it as an assertion.
    await page.getByRole('tab', { name: 'JSONPath' }).click();
    await page.locator('#wb-jsonpath').fill('$[0].name');
    await page.getByRole('button', { name: 'Evaluate' }).click();
    await expect.poll(() => page.locator('#wb-jsonpath-result').textContent()).toMatch(/"Contoso Ltd"/);
    await page.getByRole('button', { name: 'Add as assertion' }).click();
    await checkA11y(page, 'workbench');
    await page.locator('#wb-save-step').click();
    const preview = page.locator('#wb-step-preview');
    await expect.poll(() => preview.textContent()).toBe('Call API "GET /api/customers" as manager and store as response\nExpect the response response status is 200\nExpect response response "$[0].name" equals "Contoso Ltd"');
    await page.getByRole('dialog', { name: 'Save as step' }).getByLabel('Insert at the end of').selectOption('journeys/api-and-db.ez');
    await page.getByRole('button', { name: 'Insert into journey' }).click();
    await confirm('Insert');
    await expect.poll(lastToast).toMatch(/Inserted into journeys\/api-and-db\.ez: the journey validates \(\d+ steps\)/);
    const text = await readFile(join(project, 'journeys', 'api-and-db.ez'), 'utf8');
    expect(text).toContain('Call API "GET /api/customers" as manager and store as response');
    expect(validateText(text, 'ez').ok).toBe(true);
  });

  it('queries the demo SQLite read-only and blocks a write by default', async () => {
    await page.getByRole('tab', { name: 'SQL' }).click();
    await page.locator('#wb-conn').selectOption('shop');
    await page.locator('#wb-sql').fill('SELECT id, name FROM customers ORDER BY id');
    await page.locator('#wb-sql-run').click();
    await expect.poll(() => page.locator('#wb-sql-count').textContent(), { timeout: 20_000 }).toMatch(/3 row\(s\).*read-only SQLite connection/);
    expect(await page.locator('#wb-sql-result table').textContent()).toMatch(/Northwind Traders/);
    expect(await page.locator('#wb-sql-mode').textContent()).toBe('Read-only');
    await page.locator('#wb-sql').fill("DELETE FROM customers WHERE name = 'Contoso Ltd'");
    await page.locator('#wb-sql-run').click();
    await expect.poll(() => page.locator('#wb-sql-error').textContent()).toMatch(/Blocked\..*read-only/);
    const left = await api<{ rows: Array<{ n: number }> }>('POST', '/api/workbench/sql', { connection: 'shop', sql: 'SELECT COUNT(*) AS n FROM customers' });
    expect(left.rows[0].n).toBe(3);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('#wb-sql').fill('SELECT id, name, region, credit_limit FROM customers ORDER BY id');
    await page.locator('#wb-sql-run').click();
    await expect.poll(() => page.locator('#wb-sql-count').textContent()).toMatch(/3 row/);
    await shot('workbench');
    await checkA11y(page, 'workbench-sql-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });
});

describe('Project workspace (Chromium)', () => {
  it('switches the active environment and shows where each value comes from', async () => {
    await page.goto(`${studio.origin}/#/project/environments`);
    await expect.poll(() => page.locator('#env-active').textContent()).toMatch(/none/);
    await view().getByLabel('Environment', { exact: true }).selectOption('staging');
    await page.locator('#env-apply').click();
    await confirm('Switch');
    await expect.poll(() => page.locator('#env-active').textContent()).toBe('staging');
    const row = page.locator('tr[data-path="timeouts.step"]');
    await expect.poll(() => row.textContent()).toMatch(/20000.*config\/staging\.yaml/);
    expect(await page.locator('tr[data-path="baseUrl"]').textContent()).toMatch(/eztest\.config\.yaml.*interpolated from \$SHOP_URL/);
    expect(await page.locator('#env-values').textContent()).not.toContain('Builder#2');
    expect((await api<{ active: string }>('GET', '/api/project/environments')).active).toBe('staging');
    await checkA11y(page, 'environments');
    // Back to following EZTEST_ENV.
    await view().getByLabel('Environment', { exact: true }).selectOption('');
    await page.locator('#env-apply').click();
    await confirm('Switch');
    await expect.poll(() => page.locator('#env-active').textContent()).toMatch(/none/);
  });

  it('tests a role login headless, shows the TOTP code on click and keeps secrets out of the page', async () => {
    await page.goto(`${studio.origin}/#/project/identity`);
    await expect.poll(() => page.locator('#role-manager').isVisible()).toBe(true);
    const html = await page.content();
    for (const s of ['Builder#2', 'Wonderland#1', DEMO_TOTP_SECRET, 'ez-client-secret']) expect(html).not.toContain(s);
    expect(await page.locator('#role-sales-rep').textContent()).toMatch(/secret:\/\/env\/ALICE_PASSWORD/);
    await page.getByRole('button', { name: 'Test login for manager' }).click();
    const result = page.locator('[data-role="manager"] [data-testid="login-result"]');
    await expect.poll(() => result.textContent(), { timeout: 60_000 }).toMatch(/Login passed/);
    await expect.poll(() => page.locator('[data-role="manager"] img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Show TOTP code for sales-rep' }).click();
    await expect.poll(() => page.locator('#role-sales-rep .totp-code').textContent()).toMatch(/^\d{6}$/);
    await page.locator('#role-sales-rep').getByRole('button', { name: 'Hide' }).click();
    expect(await page.locator('#role-sales-rep .totp-code').count()).toBe(0);
    // ENC() needs EZTEST_MASTER_KEY on the server; it is not set here and the page says so.
    expect(await page.locator('#enc-nokey').textContent()).toMatch(/EZTEST_MASTER_KEY is not set/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('identity');
    await checkA11y(page, 'identity-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await checkA11y(page, 'identity');
  });

  it('detects drift between a recorded mock and the live service, and starts a replay server', async () => {
    await page.goto(`${studio.origin}/#/project/mocks`);
    await expect.poll(() => page.locator('#mock-server').isVisible(), { timeout: 20_000 }).toBe(true);
    await view().getByLabel('Target URL').fill(app.url);
    await view().getByLabel('Auth').selectOption('manager');
    await page.getByRole('button', { name: 'Run drift detection' }).click();
    await expect.poll(() => page.locator('#mock-drift').textContent(), { timeout: 20_000 }).toMatch(/1 drifted/);
    expect(await page.locator('#mock-drift table').textContent()).toMatch(/type-changed|items|missing|array/i);
    await page.getByRole('button', { name: 'Start replay server' }).click();
    await expect.poll(() => page.locator('#mock-server').textContent()).toMatch(/running.*http:\/\/127\.0\.0\.1:\d+/);
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec((await page.locator('#mock-server').textContent())!)![0];
    expect(await (await fetch(`${url}/api/customers`)).json()).toEqual({ items: [{ id: 1, name: 'Contoso Ltd' }] });
    await checkA11y(page, 'mocks');
    await page.getByRole('button', { name: 'Stop replay server' }).click();
    await expect.poll(() => page.locator('#mock-server').textContent()).toMatch(/stopped/);
  });

  it('generates a signed evidence pack and verifies it', async () => {
    await page.goto(`${studio.origin}/#/project/compliance`);
    await page.locator('#gen-key').click();
    await confirm('Generate');
    await expect.poll(() => page.locator('#key-fp').textContent()).toMatch(/\S{8,}/);
    await view().getByLabel('Run', { exact: true }).selectOption(orderRun);
    await view().getByLabel('Profile').selectOption('csa-part11');
    await page.locator('#signer-name').fill('Quinn Auditor');
    await page.getByRole('button', { name: 'Sign and generate pack' }).click();
    await confirm('Sign and generate');
    await expect.poll(() => page.locator('#pack-result').textContent(), { timeout: 60_000 }).toMatch(/Pack signed/);
    expect(await page.locator('#pack-trace').textContent()).toMatch(/ORD-1.*Create an order and verify the invoice three ways/);
    const packPath = `eztest-results/${orderRun}/evidence-pack-csa-part11.zip`;
    expect(existsSync(join(project, packPath))).toBe(true);
    await expect.poll(() => view().getByLabel('Pack in the project').inputValue()).toBe(packPath);
    await page.getByRole('button', { name: 'Verify pack' }).click();
    await expect.poll(() => page.locator('#verify-result').textContent(), { timeout: 30_000 }).toMatch(/VALID.*signature valid/);
    expect(await page.locator('#verify-trace').textContent()).toMatch(/ORD-7/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('compliance');
    await checkA11y(page, 'compliance-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('has no serious accessibility violations on every page (light and dark)', async () => {
    const pages: Array<[string, string]> = [
      ['#/assurance/documents', 'Document checks'], ['#/assurance/compare', 'Compare documents'], ['#/assurance/visual', 'Visual diff'],
      ['#/assurance/a11y', 'Accessibility'], ['#/assurance/security', 'Security'], ['#/workbench', 'API & DB workbench'],
      ['#/project/environments', 'Environments'], ['#/project/identity', 'Identities & roles'], ['#/project/data', 'Test data'],
      ['#/project/mocks', 'Mocks'], ['#/project/monitors', 'Monitors'], ['#/project/perf', 'Performance'], ['#/project/compliance', 'Compliance'],
    ];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [hash, title] of pages) {
        await page.goto(`${studio.origin}/${hash}`);
        await expect.poll(() => page.getByRole('heading', { name: title, level: 1 }).isVisible(), { timeout: 20_000 }).toBe(true);
        await expect.poll(() => page.locator('[aria-busy="true"]').count(), { timeout: 30_000 }).toBe(0);
        await checkA11y(page, `${hash}-${scheme}`);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    // Test data: release stale leases is guarded, synthetic preview masks.
    await page.goto(`${studio.origin}/#/project/data`);
    await page.getByRole('button', { name: 'Generate preview' }).click();
    await expect.poll(() => page.locator('#data-masked').textContent()).toMatch(/\*{4}/);
    expect(pageErrors).toEqual([]);
  }, 240_000); // 13 pages x 2 themes is heavy on a loaded CI agent

  it('renders the pdf.js viewer and every page under the real CSP without violations', async () => {
    const strict = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await strict.newPage();
    const problems: string[] = [];
    p.on('console', (m) => {
      if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text());
    });
    p.on('pageerror', (e) => problems.push(e.message));
    await p.goto(studio.url);
    await expect.poll(() => p.getByRole('heading', { name: 'Dashboard' }).isVisible()).toBe(true);
    await p.goto(`${studio.origin}/#/assurance/documents/${orderRun}`);
    await expect.poll(() => p.locator('.hl[data-ref="total"]').count(), { timeout: 30_000 }).toBe(1);
    // The canvas really has ink on it (text rendered with the self-hosted standard fonts).
    await expect.poll(() => p.locator('.pdfv-page canvas').first().evaluate((c) => {
      const cv = c as HTMLCanvasElement;
      const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return dark;
    }), { timeout: 20_000 }).toBeGreaterThan(200); // a blank canvas has none; the count scales with the page width
    for (const hash of ['#/assurance/visual', '#/assurance/a11y', '#/workbench', '#/project/monitors', '#/project/perf']) {
      await p.goto(`${studio.origin}/${hash}`);
      // Wait on state (the page heading and no pending loads), never on a fixed delay.
      await expect.poll(() => p.locator('.page:not([hidden]) h1').filter({ visible: true }).count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await expect.poll(() => p.locator('[aria-busy="true"]').count(), { timeout: 30_000 }).toBe(0);
    }
    await strict.close();
    expect(problems).toEqual([]);
  });
});
