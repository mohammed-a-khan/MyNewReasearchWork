/**
 * Correlation: framework rule packs on captured traffic, and the full loop
 * on the Load Shop demo app: record a browser session through EZTest's own
 * driver (login with CSRF, an order form with CSRF and an ASP.NET-style
 * __VIEWSTATE, the order page whose id comes from a redirect), generate
 * the correlated user path, parameterize unique users per VU, and run it
 * under load with no errors. Also HAR import and EZTest journeys (API
 * steps at protocol level).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoadShop, type LoadShop } from '../../examples/load-shop/server.js';
import { startDemoApp, DEMO_CLIENT, type DemoServer } from '../../examples/demo-app/server.js';
import { Journey } from '../../src/core/index.js';
import { generateUserPath, importHar, journeyToUserPath, LoadTest, recordBrowserTraffic, FRAMEWORK_RULES, type NetworkEntry } from '../../src/load/index.js';
import { scenario } from './helpers.js';

const html = (body: string): Pick<NetworkEntry, 'responseHeaders' | 'responseBody'> => ({ responseHeaders: { 'content-type': 'text/html' }, responseBody: `<html><body>${body}</body></html>` });

describe('framework correlation rules', () => {
  it('ASP.NET ViewState/EventValidation, JSF ViewState, SAP x-csrf-token, Salesforce and Dynamics 365 tokens', () => {
    const entries: NetworkEntry[] = [
      { method: 'GET', url: 'https://app.test/Default.aspx', status: 200, ...html('<form><input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUKMTY3NzA0NTA0Mg9kFgICAw==" /><input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="/wEdAAKZ1c+XyZ9Zq" /></form>') },
      { method: 'POST', url: 'https://app.test/Default.aspx', status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: `__VIEWSTATE=${encodeURIComponent('/wEPDwUKMTY3NzA0NTA0Mg9kFgICAw==')}&__EVENTVALIDATION=${encodeURIComponent('/wEdAAKZ1c+XyZ9Zq')}&btn=Go`, ...html('<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="-1234567890123456789:987654321" />') },
      { method: 'POST', url: 'https://app.test/faces/page.xhtml', status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'javax.faces.ViewState=-1234567890123456789%3A987654321&x=1', responseHeaders: { 'x-csrf-token': 'Zk9-sapCsrf_77AbC==' }, responseBody: '' },
      { method: 'POST', url: 'https://app.test/sap/opu/odata/SRV/Orders', status: 201, requestHeaders: { 'x-csrf-token': 'Zk9-sapCsrf_77AbC==', 'content-type': 'application/json' }, requestBody: '{"a":1}', ...html('<input type="hidden" name="com.salesforce.visualforce.ViewState" id="com.salesforce.visualforce.ViewState" value="i:AAAAWXsidCI6IjAwRDV" /><script>var x = {"WRPCTokenUrl":"/AppWebServices/x.asmx?CRMWRPCToken=Q9hAB3sToken&CRMWRPCTokenTimeStamp=638123"}</script>') },
      { method: 'POST', url: 'https://app.test/apex/page', status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'com.salesforce.visualforce.ViewState=i%3AAAAAWXsidCI6IjAwRDV&CRMWRPCToken=Q9hAB3sToken&CRMWRPCTokenTimeStamp=638123', responseBody: '' },
    ];
    const g = generateUserPath(entries);
    const by = (v: string) => g.correlations.find((c) => c.variable === v);
    expect(by('viewState')?.framework).toBe('aspnet');
    expect(by('eventValidation')?.usedBy).toEqual([1]);
    expect(by('jsfViewState')?.framework).toBe('jsf');
    expect(by('sapCsrfToken')?.kind).toBe('header');
    expect(by('sfViewState')?.framework).toBe('salesforce');
    expect(by('crmWrpcToken')?.framework).toBe('d365');
    expect(by('crmWrpcTokenTimeStamp')?.framework).toBe('d365');
    const doc = JSON.stringify(g.path);
    for (const secret of ['/wEPDwUKMTY3', 'Zk9-sapCsrf', 'i%3AAAAAWX', 'Q9hAB3sToken', '-1234567890123456789%3A']) expect(doc).not.toContain(secret);
    expect(doc).toContain('${__urlencode(viewState)}');
    expect(doc).toContain('"x-csrf-token":"${sapCsrfToken}"');
    for (const pack of ['aspnet', 'jsf', 'salesforce', 'd365', 'sap', 'generic']) expect(FRAMEWORK_RULES[pack].length).toBeGreaterThan(0);
  });

  it('applies project rules from the rule editor and can exclude a candidate', () => {
    const entries: NetworkEntry[] = [
      { method: 'GET', url: 'https://x.test/a', status: 200, responseHeaders: { 'content-type': 'text/plain' }, responseBody: 'session=<<AbC123xyz>>;' },
      { method: 'GET', url: 'https://x.test/b?s=AbC123xyz', status: 200 },
    ];
    const g = generateUserPath(entries, { rules: [{ name: 'my session', from: 'body', boundary: { left: '<<', right: '>>' }, var: 'mySession', enabled: true }] });
    expect(g.correlations[0]).toMatchObject({ variable: 'mySession', kind: 'boundary', rule: 'my session' });
    expect(JSON.stringify(g.path)).toContain('/b?s=${mySession}');
    const none = generateUserPath(entries, { rules: [{ name: 'my session', from: 'body', boundary: { left: '<<', right: '>>' }, var: 'mySession', enabled: true }], exclude: ['my session'], rulesOnly: true });
    expect(none.correlations).toEqual([]);
    expect(none.candidates[0].reason).toBe('excluded');
  });
});

describe('Load Shop: browser recording -> correlated user path -> load', () => {
  let shop: LoadShop;
  let dir: string;
  beforeAll(async () => {
    shop = await startLoadShop();
    dir = await mkdtemp(join(tmpdir(), 'ez-load-corr-'));
  });
  afterAll(() => shop?.close());

  it('records with EZTest\'s driver, correlates CSRF, ViewState and the order id, and passes under load', async () => {
    const entries = await recordBrowserTraffic({
      url: `${shop.url}/login`,
      drive: async (page) => {
        await page.locator('#u').fill('user1');
        await page.locator('#pw').fill('pw-1');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForURL(/orders\/new/);
        await page.locator('#qty').fill('2');
        await page.getByRole('button', { name: 'Place order' }).click();
        await page.getByText(/Order ORD-\d+ created/).waitFor();
      },
    });
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.some((e) => e.responseBody?.includes('csrf_token'))).toBe(true);
    const g = generateUserPath(entries, { name: 'load shop', parameters: { user1: 'users.username', 'pw-1': 'users.password' }, thinkTime: { fixed: 0.05 } });
    const vars = g.correlations.map((c) => c.variable);
    expect(vars).toContain('csrfToken');
    expect(vars).toContain('viewState');
    expect(g.correlations.some((c) => c.rule === 'id in redirect')).toBe(true);
    const doc = JSON.stringify(g.path);
    expect(doc).toContain('${__urlencode(users.username)}');
    expect(doc).not.toMatch(/shopsid=[a-f0-9]{8}/);
    const rows = Array.from({ length: 40 }, (_, i) => ({ username: `user${i + 1}`, password: `pw-${i + 1}` }));
    await writeFile(join(dir, 'users.csv'), 'username,password\n' + rows.map((r) => `${r.username},${r.password}`).join('\n') + '\n');
    const s = scenario({
      name: 'load shop orders', baseUrl: g.baseUrl,
      userPaths: { buyer: { ...(g.path as { actions: unknown[] }), data: ['users'] } },
      data: { users: { file: 'users.csv', order: 'unique', scope: 'vu', onExhausted: 'error' } },
      profile: { type: 'constant', vus: 8, duration: '4s' },
      sla: [{ match: '*', kind: 'request', errorRate: { fail: 0 } }],
    }, dir);
    const before = { ...shop.stats };
    const r = await new LoadTest(s, { monitors: false }).run();
    const its = r.names.find((n) => n.kind === 'iteration')!;
    expect(r.errors.samples).toEqual([]);
    expect(r.totals.errors).toBe(0);
    expect(its.count).toBeGreaterThan(8);
    expect(shop.stats.orders - before.orders).toBe(its.count);
    expect(shop.stats.rejectedCsrf - before.rejectedCsrf).toBe(0);
    expect(shop.stats.rejectedViewState - before.rejectedViewState).toBe(0);
    expect(r.verdict).toBe('pass');
  }, 120_000);
});

describe('other user path sources', () => {
  let demo: DemoServer;
  beforeAll(async () => {
    demo = await startDemoApp();
  });
  afterAll(() => demo?.close());

  it('imports a HAR file and correlates its OAuth token', async () => {
    const tokRes = await fetch(`${demo.url}/api/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=${DEMO_CLIENT.id}&client_secret=${DEMO_CLIENT.secret}` });
    const tokBody = await tokRes.text();
    const token = JSON.parse(tokBody).access_token as string;
    const har = {
      log: {
        version: '1.2', creator: { name: 'browser', version: '1' }, pages: [{ id: 'p1', title: 'api' }],
        entries: [
          { pageref: 'p1', startedDateTime: new Date().toISOString(), time: 5, request: { method: 'POST', url: `${demo.url}/api/token`, headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }], postData: { text: `grant_type=client_credentials&client_id=${DEMO_CLIENT.id}&client_secret=${DEMO_CLIENT.secret}` } }, response: { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], content: { text: tokBody } } },
          { pageref: 'p1', startedDateTime: new Date().toISOString(), time: 5, request: { method: 'GET', url: `${demo.url}/api/orders`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }, response: { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], content: { text: '[]' } } },
        ],
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'ez-har-'));
    await writeFile(join(dir, 'session.har'), JSON.stringify(har));
    const g = await importHar(join(dir, 'session.har'));
    expect(g.correlations.find((c) => c.variable === 'accessToken')).toBeTruthy();
    expect(JSON.stringify(g.path)).not.toContain(token);
    expect(g.env).toContain('EZ_CLIENT_SECRET');
    const prev = process.env.EZ_CLIENT_SECRET;
    process.env.EZ_CLIENT_SECRET = DEMO_CLIENT.secret;
    try {
      const r = await new LoadTest(scenario({ baseUrl: g.baseUrl, userPaths: { api: g.path as { actions: unknown[] } }, profile: { type: 'constant', vus: 2, duration: '1500ms' } }), { monitors: false }).run();
      expect(r.totals.errors).toBe(0);
      expect(r.totals.requests).toBeGreaterThan(4);
    } finally {
      if (prev === undefined) delete process.env.EZ_CLIENT_SECRET;
      else process.env.EZ_CLIENT_SECRET = prev;
    }
  });

  it('turns an EZTest journey\'s API steps into protocol-level requests', async () => {
    const j = Journey.parse({
      id: 'orders-api', name: 'Orders API', variables: { secret: DEMO_CLIENT.secret },
      steps: [
        { id: 's1', intent: 'Get a token', action: 'api', captureAs: 'tok', api: { method: 'POST', url: `${demo.url}/api/token`, form: { grant_type: 'client_credentials', client_id: DEMO_CLIENT.id, client_secret: '${secret}' } }, postconditions: [{ type: 'apiStatus', captureKey: 'tok', status: 200 }] },
        { id: 's2', intent: 'List orders', action: 'api', captureAs: 'orders', api: { method: 'GET', url: `${demo.url}/api/orders`, headers: { authorization: 'Bearer ${tok.body.access_token}' } } },
      ],
    });
    const { path, browser } = journeyToUserPath(j);
    expect(browser).toBe(false);
    const r = await new LoadTest(scenario({ userPaths: { api: path }, profile: { type: 'constant', vus: 3, duration: '1500ms' } }), { monitors: false }).run();
    expect(r.errors.samples).toEqual([]);
    expect(r.names.find((n) => n.name === 'List orders')!.count).toBeGreaterThan(3);
  });
});
