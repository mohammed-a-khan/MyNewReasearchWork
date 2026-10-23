/**
 * Studio › Project › API contracts and Messages: the routes report the spec
 * (lint), the run's API coverage, EZTest contract files (HTTP and message
 * expectations), the results server's contracts, verifications and releases,
 * and the masked message traffic;
 * the pages render them in a real Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { client } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';
import { contractHash, contractToJson, readContractFile } from '../../src/contracts/index.js';
import { ResultsClient } from '../../src/server/index.js';
import { startTestServer, type TestServer } from '../server/helpers.js';


const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

let demo: DemoServer;
let srv: TestServer;
let project: string;
let studio: StudioHandle;
let browser: Browser;
let page: Page;
let runId: string;
const SECRET = 'msg-secret-token-77';

beforeAll(async () => {
  demo = await startDemoApp();
  srv = await startTestServer();
  process.env.EZTEST_STUDIO_SRV_TOKEN = await srv.token('ci', [{ project: 'shop', role: 'tester' }]);
  project = await mkdtemp(join(tmpdir(), 'eztest-studio-contracts-'));
  await mkdir(join(project, 'specs'), { recursive: true });
  await cp(resolve(__dirname, '../../examples/demo-app/openapi.yaml'), join(project, 'specs', 'shop.yaml'));
  await writeFile(join(project, 'eztest.config.yaml'), toYaml({
    baseUrl: demo.url, outputDir: 'results', healing: { enabled: false }, vars: { partnerToken: SECRET },
    api: { spec: 'specs/shop.yaml' }, messaging: { brokers: { local: { type: 'memory' } } }, contracts: { dir: 'contracts' },
    server: { url: srv.url, token: 'secret://env/EZTEST_STUDIO_SRV_TOKEN', project: 'shop', sharedState: false },
  }));
  const engine = await createEngine(await loadConfig({ cwd: project, environment: {} }), { cwd: project });
  try {
    const run = await engine.run([parseEzScript(`Journey: Quote and notify
Start a contract between consumer "web" and provider "shop"
Call API "POST /api/public/quote" with body '{"sku":"SKU-100","qty":1}' and store as quote
Start listening on memory topic "quotes" as q
Publish message '{"total": "\${quote.body.total}", "auth": "\${partnerToken}"}' to memory topic "quotes"
Wait for a message in q where "$.total" = "19.99" within 2 s as notified
Finish the contract
`)]);
    expect(run.journeys[0].status).toBe('passed');
    runId = run.runId;
  } finally {
    await engine.close();
  }
  // What CI would have put on the results server: the contract, a verification and a release.
  const ci = new ResultsClient({ url: srv.url, project: 'shop', token: process.env.EZTEST_STUDIO_SRV_TOKEN });
  const contract = await readContractFile(join(project, 'contracts', 'web-shop.contract.json'));
  await ci.publishContract(contractToJson(contract), 'w1', 'main');
  await ci.recordVerification({ provider: 'shop', providerVersion: 's9', hash: contractHash(contract), passed: false, failed: ['quote: status: expected 200, got 500'] });
  const rm = new ResultsClient({ url: srv.url, project: 'shop', token: await srv.token('release-manager', [{ project: 'shop', role: 'approver' }]) });
  await rm.recordRelease({ app: 'shop', version: 's8', environment: 'production' });
  studio = await startStudio({ cwd: project, watch: false, env: { ...process.env } });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(studio.url);
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await demo?.close();
  await srv?.close();
  delete process.env.EZTEST_STUDIO_SRV_TOKEN;
});

describe('Studio API contracts and messages', () => {
  it('reports specs, coverage, contracts and masked messages', async () => {
    const c = client(studio.port, studio.token);
    const v = (await c.get('/api/project/contracts')).json();
    expect(v.specs[0]).toMatchObject({ file: 'specs/shop.yaml', title: 'EZ Shop API', operations: 5, lint: { error: 0 } });
    expect(v.run).toMatchObject({ runId, recorded: true });
    expect(v.run.coverage[0].totals).toMatchObject({ coveredOperations: 1, operations: 5 });
    expect(v.contracts[0]).toMatchObject({ file: 'contracts/web-shop.contract.json', consumer: 'web', provider: 'shop', expectations: [{ kind: 'http', request: 'POST /api/public/quote', status: 200 }, { kind: 'message', request: 'memory topic quotes' }] });
    expect(v.server).toMatchObject({ url: srv.url, project: 'shop', contracts: [{ consumer: 'web', consumerVersion: 'w1', branch: 'main', provider: 'shop' }], verifications: [{ provider: 'shop', providerVersion: 's9', passed: false }], releases: [{ app: 'shop', environment: 'production', version: 's8' }] });
    expect(v.server.contracts[0]).not.toHaveProperty('contract');
    const m = (await c.get(`/api/project/messages?run=${runId}`)).json();
    expect(m.messages.map((x: { direction: string }) => x.direction)).toEqual(['published', 'received']);
    expect(JSON.stringify(m)).not.toContain(SECRET);
    expect((await c.post('/api/project/contracts/lint', { path: 'specs/shop.yaml' })).json().passed).toBe(true);
    expect((await c.post('/api/project/contracts/lint', { path: '../outside.yaml' })).status).toBe(403);
  });

  it('renders the API contracts and Messages pages', async () => {
    await page.goto(`${studio.origin}/#/project/contracts`);
    await expect.poll(() => page.locator('body').textContent(), { timeout: 20_000 }).toMatch(/API coverage: EZ Shop API/);
    const text = (await page.locator('body').textContent()) ?? '';
    expect(text).toMatch(/1\/5operations \(20%\)/);
    expect(text).toContain('untested');
    expect(text).toContain('web -> shop');
    expect(text).toContain('Results server: shop');
    expect(text).toMatch(/web w1/);
    expect(text).toMatch(/shop s9/);
    expect(text).toContain('quote: status: expected 200, got 500');
    expect(text).toMatch(/productions8/);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await checkA11y(page, `contracts-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${studio.origin}/#/project/messages`);
    await expect.poll(() => page.locator('body').textContent(), { timeout: 20_000 }).toContain('"total": "19.99"');
    const msgs = (await page.locator('body').textContent()) ?? '';
    expect(msgs).toMatch(/publishedmemory quotes/);
    expect(msgs).not.toContain(SECRET);
    await checkA11y(page, 'messages');
  });
});
