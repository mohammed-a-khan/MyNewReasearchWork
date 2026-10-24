/**
 * Studio › Project › Shared data and Quality › Deployments: the routes list,
 * edit, expire and delete shared store values (secrets never leave the
 * server in clear text), browse pools, add items and release a stuck claim;
 * the deployments view builds the version x environment matrix from the
 * deployment records; both pages render in a real Chromium, accessibly.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { FileStoreBackend, SharedStore } from '../../src/store/index.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';
import { client } from './helpers.js';

const KEY = 'studio-store-key-0123456789abcdef';
let project: string;
let studio: StudioHandle;
let browser: Browser;
let page: Page;
let store: SharedStore;

const record = (environment: string, version: string, decision: string, at: string, failed = 0) => ({
  id: `${environment}:${version}:run-${at}`, recordedAt: at, environment, version, pipeline: `deploy-${environment}`, runId: `run-${environment}-${version}`,
  ci: { system: 'azure', stage: `Test${environment.toUpperCase()}`, url: 'https://dev.azure.com/x/y/_build/results?buildId=1' },
  selection: { journeys: ['login', 'orders'], total: 2, tags: '@smoke' },
  results: { total: 2, passed: 2 - failed, passedHealed: 0, failed, skipped: 0, errors: 0 },
  readiness: { decision, failingGates: failed ? ['minPassRate'] : [] },
});

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'eztest-studio-store-'));
  await mkdir(join(project, 'journeys'));
  await writeFile(join(project, 'eztest.config.yaml'), toYaml({ outputDir: 'results', environment: 'sit', pipelines: { 'deploy-sit': { environment: 'sit' }, 'deploy-uat': { environment: 'uat' } } }));
  store = new SharedStore({ backend: new FileStoreBackend(join(project, '.eztest', 'store')), namespace: 'sit', env: { EZTEST_STORE_KEY: KEY } });
  await store.save('pending-order', { id: 'ORD-7' }, { ttlMs: 86_400_000, source: { journeyId: 'create-order', runId: 'run-1' } });
  await store.save('api-token', 'tok-STUDIO-secret-1', { secret: true });
  await store.save('old', 'x', { ttlMs: 1 });
  await store.poolAdd('approvable-policies', ['P-1', 'P-2', 'P-3']);
  await store.take('approvable-policies', 'crashed#1');
  for (const [env, ver, dec, at, failed] of [['sit', '1.0.1', 'GO', '2026-10-20T10:00:00.000Z', 0], ['uat', '1.0.1', 'GO_WITH_RISKS', '2026-10-20T12:00:00.000Z', 0], ['sit', '1.0.2', 'NO_GO', '2026-10-21T10:00:00.000Z', 1]] as const) {
    await mkdir(join(project, 'results', `run-${env}-${ver}`), { recursive: true });
    await writeFile(join(project, 'results', `run-${env}-${ver}`, 'deployment.json'), JSON.stringify(record(env, ver, dec, at, failed)));
  }
  studio = await startStudio({ cwd: project, watch: false, env: { ...process.env, EZTEST_STORE_KEY: KEY } });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(studio.url);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
});

describe('Studio shared data', () => {
  it('lists values (secrets masked) and pools; edits, expires, deletes and purges', async () => {
    const c = client(studio.port, studio.token);
    const v = (await c.get('/api/project/store')).json();
    expect(v.backend.name).toBe('file');
    expect(v.defaultNamespace).toBe('sit');
    expect(JSON.stringify(v)).not.toContain('tok-STUDIO-secret-1');
    expect(JSON.stringify(v)).not.toMatch(/EZS[12]:/);
    const byKey = Object.fromEntries(v.entries.map((e: { key: string }) => [e.key, e]));
    expect(byKey['pending-order']).toMatchObject({ value: { id: 'ORD-7' }, expired: false, source: { journeyId: 'create-order' } });
    expect(byKey['api-token']).toMatchObject({ value: '****', secret: true });
    expect(byKey.old.expired).toBe(true);
    expect(v.pools).toEqual([{ namespace: 'sit', pool: 'approvable-policies', available: 2, claimed: 1, total: 3 }]);

    expect((await c.post('/api/project/store/save', { namespace: 'sit', key: 'pending-order', value: '{"id":"ORD-8"}', json: true, ttl: '2 days' })).status).toBe(200);
    expect((await store.load('pending-order')).value).toEqual({ id: 'ORD-8' });
    expect((await c.post('/api/project/store/save', { namespace: 'uat', key: 'db-password', value: 'pw-from-studio', secret: true })).json().entry.value).toBe('****');
    expect((await store.load('db-password', { namespace: 'uat' })).value).toBe('pw-from-studio');
    expect((await c.post('/api/project/store/save', { namespace: 'sit', key: 'bad', value: '{oops', json: true })).status).toBe(400);
    expect((await c.post('/api/project/store/expire', { namespace: 'sit', key: 'pending-order' })).json()).toEqual({ expired: true });
    await expect(store.load('pending-order')).rejects.toThrow(/expired at/);
    expect((await c.post('/api/project/store/purge', {})).json().purged).toBe(2);
    expect((await c.post('/api/project/store/delete', { namespace: 'uat', key: 'db-password' })).json().deleted).toBe(true);
  });

  it('pools: items with claims, release a stuck claim, add and remove items', async () => {
    const c = client(studio.port, studio.token);
    const p = (await c.get('/api/project/store/pool?namespace=sit&pool=approvable-policies')).json();
    const claimed = p.items.find((i: { claimed: boolean }) => i.claimed);
    expect(claimed).toMatchObject({ value: 'P-1', claim: { owner: expect.stringMatching(/^crashed#1@/) } });
    expect((await c.post('/api/project/store/pool/release', { namespace: 'sit', pool: 'approvable-policies', id: claimed.id })).json().released).toBe(true);
    expect((await c.post('/api/project/store/pool/add', { namespace: 'sit', pool: 'approvable-policies', values: 'P-4\nP-5\nP-1' })).json()).toEqual({ added: 2, skipped: 1 });
    expect((await c.post('/api/project/store/pool/remove', { namespace: 'sit', pool: 'approvable-policies', id: claimed.id })).json().removed).toBe(true);
    expect(await store.count('approvable-policies')).toEqual({ available: 4, claimed: 0, total: 4 });
  });

  it('deployments: the version x environment matrix from the records', async () => {
    const c = client(studio.port, studio.token);
    const d = (await c.get('/api/quality/deployments')).json();
    expect(d.environments).toEqual(['sit', 'uat']);
    expect(d.versions).toEqual(['1.0.2', '1.0.1']);
    expect(d.matrix['1.0.1'].sit.readiness.decision).toBe('GO');
    expect(d.matrix['1.0.1'].uat.readiness.decision).toBe('GO_WITH_RISKS');
    expect(d.matrix['1.0.2'].uat).toBeUndefined();
    expect((await c.get('/api/quality/deployments?environment=uat')).json().records).toHaveLength(1);
  });

  it('renders the Shared data and Deployments pages', async () => {
    await page.goto(`${studio.origin}/#/project/shared-data`);
    await expect.poll(() => page.locator('body').textContent(), { timeout: 20_000 }).toMatch(/approvable-policies/);
    const text = (await page.locator('body').textContent()) ?? '';
    expect(text).toContain('Backend: file');
    expect(text).toContain('api-token');
    expect(text).toContain('****');
    expect(text).not.toContain('tok-STUDIO-secret-1');
    await page.locator('details summary').first().click();
    await expect.poll(() => page.locator('details').first().textContent(), { timeout: 10_000 }).toMatch(/P-4/);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousA11y(page, `shared-data-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${studio.origin}/#/quality/deployments`);
    await expect.poll(() => page.locator('#deployments-matrix').count(), { timeout: 20_000 }).toBe(1);
    const m = (await page.locator('#deployments-matrix').textContent()) ?? '';
    expect(m).toMatch(/1\.0\.2NO GO/);
    expect(m).toMatch(/not tested/);
    expect((await page.locator('#deployments-records').textContent()) ?? '').toMatch(/deploy-uat \(azure TestUAT\)/);
    await expectNoSeriousA11y(page, 'deployments');
  });
});
