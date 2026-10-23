/**
 * The Studio Performance workspace (EZTest Load) in a real Chromium driven
 * by EZTest's own driver: the design editor with its live curve preview,
 * the correlation assistant (HAR upload, framework packs, rule editor,
 * replay check), run control with the live dashboard (start, add VUs,
 * finish), results with analysis and the report, and accessibility checks on every section
 * in light and dark themes.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { startLoadShop, type LoadShop } from '../../examples/load-shop/server.js';
import { copyShopProject } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';


let shop: LoadShop;
let studio: StudioHandle;
let project: string;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-eztest-token': studio.token, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json()) as T;
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

/** A HAR of a sign-in against the Load Shop (made with plain fetch, the way a browser would export it). */
async function shopHar(): Promise<string> {
  const entries: unknown[] = [];
  const t = () => new Date().toISOString();
  const get = await fetch(`${shop.url}/login`);
  const html = await get.text();
  const cookie = (get.headers.get('set-cookie') ?? '').split(';')[0];
  entries.push({ startedDateTime: t(), time: 4, request: { method: 'GET', url: `${shop.url}/login`, headers: [] }, response: { status: 200, headers: [{ name: 'content-type', value: 'text/html' }, { name: 'set-cookie', value: get.headers.get('set-cookie') ?? '' }], content: { text: html } } });
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)![1];
  const body = `csrf_token=${encodeURIComponent(csrf)}&username=user1&password=pw-1`;
  const post = await fetch(`${shop.url}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body, redirect: 'manual' });
  entries.push({ startedDateTime: t(), time: 4, request: { method: 'POST', url: `${shop.url}/login`, headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }, { name: 'Cookie', value: cookie }], postData: { text: body } }, response: { status: post.status, headers: [{ name: 'location', value: post.headers.get('location') ?? '' }], content: { text: '' } } });
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'browser', version: '1' }, entries } });
}

beforeAll(async () => {
  shop = await startLoadShop();
  project = await copyShopProject();
  await mkdir(join(project, 'load'), { recursive: true });
  await writeFile(join(project, 'load', 'shop.yaml'), toYaml({
    version: 1, name: 'Shop browse', baseUrl: shop.url,
    userPaths: { browse: { actions: [{ transaction: { name: 'login page', actions: [{ request: { name: 'GET /login', url: '/login', assert: [{ contains: 'csrf_token' }] } }] } }, { transaction: { name: 'slow page', actions: [{ request: { name: 'GET /slow', url: '/slow?ms=30' } }] } }], thinkTime: '50ms' } },
    populations: [{ name: 'visitors', userPath: 'browse', share: 80 }, { name: 'mobile', userPath: 'browse', share: 20, network: { latencyMs: 40 } }],
    profile: { type: 'ramp', vus: 6, rampUp: '2s', plateau: '3s' },
    sla: [{ match: '*', kind: 'transaction', p95: { warn: 500, fail: 2000 }, errorRate: { fail: 0.05 } }],
    monitors: [{ type: 'host', name: 'generator', intervalMs: 1000 }],
  }));
  studio = await startStudio({ cwd: project, recordHeadless: true });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(studio.url);
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await shop?.close();
});

const h1 = (name: string) => page.getByRole('heading', { name, level: 1 });

describe('Performance workspace (Chromium)', () => {
  it('designs a scenario: populations, profile with a live curve preview, SLAs, saved to YAML', async () => {
    await page.goto(`${studio.origin}/#/load/design`);
    await expect.poll(() => h1('Design').isVisible(), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.locator('#load-preview .ld-chart svg').count(), { timeout: 20_000 }).toBe(1);
    expect(await page.locator('#load-preview svg').getAttribute('aria-label')).toMatch(/Virtual users over time: total latest 6/);
    // change the profile target and a population share: the preview follows
    const vus = page.getByLabel('Virtual users', { exact: true });
    await vus.fill('12');
    await expect.poll(() => page.locator('#load-preview svg').getAttribute('aria-label'), { timeout: 10_000 }).toMatch(/total latest 12/);
    await page.getByLabel('Share of population 2').fill('50');
    await expect.poll(() => page.locator('#load-preview').textContent(), { timeout: 10_000 }).toMatch(/mobile: 38\.5%/);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => (await readFile(join(project, 'load', 'shop.yaml'), 'utf8')).includes('vus: 12'), { timeout: 10_000 }).toBe(true);
    // the user path outline
    expect(await page.locator('.ld-outline').first().textContent()).toMatch(/transaction\s*login page/);
  }, 60_000);

  it('correlates a HAR upload, edits rules, saves a scenario and replays it once', async () => {
    await page.goto(`${studio.origin}/#/load/correlation`);
    await expect.poll(() => h1('Correlation assistant').isVisible(), { timeout: 20_000 }).toBe(true);
    const har = join(project, 'shop.har');
    await writeFile(har, await shopHar());
    await page.locator('#har-upload').setInputFiles(har);
    await page.getByRole('button', { name: 'Correlate' }).click();
    const table = page.getByRole('table', { name: 'Correlated values' });
    await expect.poll(() => table.textContent(), { timeout: 20_000 }).toMatch(/csrfToken/);
    // rule editor: add a project rule and see it listed
    await page.getByLabel('Rule name (header/cookie name)').fill('order id');
    await page.getByLabel('Expression', { exact: true }).fill('ORD-(\\d+)');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect.poll(() => page.getByRole('table', { name: 'Project correlation rules' }).textContent(), { timeout: 10_000 }).toMatch(/order id/);
    expect(await readFile(join(project, 'load', 'correlation-rules.yaml'), 'utf8')).toMatch(/order id/);
    await page.getByLabel('Save as').fill('load/from-har.yaml');
    await page.getByRole('button', { name: 'Save scenario' }).click();
    await expect.poll(() => page.getByRole('table', { name: 'Replay check' }).textContent(), { timeout: 30_000 }).toMatch(/POST \/login/);
    expect(await page.getByRole('table', { name: 'Replay check' }).textContent()).not.toMatch(/fail/i);
  }, 60_000);

  it('runs a load test with the live dashboard, adds VUs live, and lands in results', async () => {
    await page.goto(`${studio.origin}/#/load/run`);
    await expect.poll(() => h1('Run').isVisible(), { timeout: 20_000 }).toBe(true);
    const run = page.locator('#load-run');
    await run.getByLabel('Scenario', { exact: true }).selectOption('load/shop.yaml');
    await run.getByLabel('Duration override (seconds)').fill('6');
    await run.getByRole('button', { name: 'Start load test' }).click();
    await expect.poll(() => page.locator('#load-status').textContent(), { timeout: 20_000 }).toMatch(/running/);
    await expect.poll(() => page.locator('#load-dashboard .stat').count(), { timeout: 20_000 }).toBeGreaterThan(5);
    await run.getByRole('button', { name: 'Add VUs' }).click();
    await expect.poll(async () => Number((await api<{ active: { vus: number } }>('GET', '/api/load/active')).active.vus), { timeout: 15_000 }).toBeGreaterThan(12);
    expect(await page.getByRole('table', { name: 'Transactions and requests (last second)' }).textContent()).toMatch(/GET \/login/);
    await expect.poll(() => page.locator('#load-dashboard figure svg').first().getAttribute('aria-label')).toMatch(/Active virtual users: VUs latest/);
    await expect.poll(() => page.locator('#load-status').textContent(), { timeout: 30_000 }).toMatch(/Finished/);
    const runs = await api<{ runs: Array<{ runId: string; verdict: string; requests: number }> }>('GET', '/api/load/results');
    expect(runs.runs[0].requests).toBeGreaterThan(20);
    await page.goto(`${studio.origin}/#/load/results/${runs.runs[0].runId}`);
    await expect.poll(() => h1('Results').isVisible(), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => page.getByRole('table', { name: 'SLA results' }).textContent(), { timeout: 20_000 }).toMatch(/p95/);
    expect(await page.getByRole('table', { name: 'Transactions and requests' }).textContent()).toMatch(/slow page/);
    const report = await fetch(`${studio.origin}/runs/${runs.runs[0].runId}/report.html`, { headers: { 'x-eztest-token': studio.token } });
    expect(report.status).toBe(200);
    expect(await report.text()).toMatch(/Monitor: generator/);
  }, 120_000);

  it('has no serious accessibility violations on every section (light and dark)', async () => {
    const sections: Array<[string, string]> = [['#/load/design', 'Design'], ['#/load/correlation', 'Correlation assistant'], ['#/load/run', 'Run'], ['#/load/results', 'Results']];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [hash, title] of sections) {
        await page.goto(`${studio.origin}/${hash}`);
        await expect.poll(() => h1(title).isVisible(), { timeout: 20_000 }).toBe(true);
        await expect.poll(() => page.locator('[aria-busy="true"]').count(), { timeout: 30_000 }).toBe(0);
        await checkA11y(page, `${hash}-${scheme}`);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    expect(pageErrors).toEqual([]);
  }, 180_000);
});
