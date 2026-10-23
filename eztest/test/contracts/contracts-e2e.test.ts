/**
 * WP2 end to end against the EZ Shop demo app (always runs; no Docker):
 *  - G11: `eztest import` of the demo OpenAPI spec and of a Postman collection
 *    produces journeys that pass; with api.spec configured every API step is
 *    validated, a planted contract break (DEMO_BUG=api-contract) fails naming
 *    the JSON pointer; the run's API coverage lists untested operations and
 *    feeds the readiness gate; spec lint.
 *  - G13: a mock generated from the spec serves deterministic, schema-valid
 *    data and rejects an invalid request with 400 citing the rule.
 *  - G12: a consumer journey writes an EZTest contract (matchers from the
 *    spec); publish to the EZTest results server; provider verification with
 *    a provider state as a data hook; results recorded on the server; the
 *    provider is released; can-release YES; breaking the provider fails
 *    verification, an unverified provider version cannot be released, and
 *    readiness is NO_GO.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { buildProgram } from '../../src/cli/index.js';
import { analyzeRun } from '../../src/engine/index.js';
import { createOpenApiMock, loadApiSpec, readContractFile, validateExchange, type HttpExpectation } from '../../src/contracts/index.js';
import { startDemoApp, DEMO_CLIENT, type DemoServer } from '../../examples/demo-app/server.js';
import { startTestServer, type TestServer } from '../server/helpers.js';

const SPEC = resolve(__dirname, '../../examples/demo-app/openapi.yaml');
const ENV = { ...process.env, SHOP_BOB_PASSWORD: 'Builder#2', SHOP_API_CLIENT_SECRET: DEMO_CLIENT.secret };

async function cli(cwd: string, args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  try {
    await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: ENV }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  } catch (e) {
    err.push((e as Error).message);
    if (!process.exitCode) process.exitCode = 1;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

async function newestRun(dir: string): Promise<string> {
  const runs = (await readdir(join(dir, 'results'))).filter((r) => existsSync(join(dir, 'results', r, 'run.json'))).sort();
  return join(dir, 'results', runs[runs.length - 1]);
}

function seedOrder(demo: DemoServer, id = 1): void {
  demo.db.prepare("INSERT OR REPLACE INTO orders (id, customer_id, created_by, status, total, created_at) VALUES (?, 1, 'bob', 'Submitted', 99, '2026-01-15T09:30:00.000Z')").run(id);
  demo.db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(id);
  demo.db.prepare("INSERT INTO order_lines (order_id, sku, name, qty, unit_price, line_total) VALUES (?, 'SKU-200', 'Gadget', 2, 49.5, 99)").run(id);
}

async function project(demo: DemoServer, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-contract-'));
  await mkdir(join(dir, 'specs'), { recursive: true });
  await cp(SPEC, join(dir, 'specs', 'shop.yaml'));
  await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
    baseUrl: demo.url, outputDir: 'results', healing: { enabled: false }, reporters: ['json'], screenshots: 'off',
    identity: {
      secretStores: [{ type: 'env', prefix: 'SHOP_' }],
      roles: { manager: { loginUrl: '/login', username: 'bob', password: 'secret://env/BOB_PASSWORD', api: { tokenUrl: '/api/token', clientId: 'ez-client', clientSecret: 'secret://env/API_CLIENT_SECRET' } } },
    },
    api: { spec: 'specs/shop.yaml' },
    ...extra,
  }));
  return dir;
}

describe('OpenAPI import, spec conformance and API coverage (G11)', () => {
  let demo: DemoServer;
  let broken: DemoServer;
  let dir: string;

  beforeAll(async () => {
    demo = await startDemoApp();
    broken = await startDemoApp({ bug: 'api-contract' });
    seedOrder(demo);
    seedOrder(broken);
    dir = await project(demo);
  });
  afterAll(async () => {
    await demo?.close();
    await broken?.close();
  });

  it('lints the demo spec clean and flags a broken one', async () => {
    const ok = await cli(dir, ['contracts', 'lint', 'specs/shop.yaml']);
    expect(ok.exitCode, ok.out).toBe(0);
    expect(ok.out).toMatch(/0 error\(s\)/);
    await writeFile(join(dir, 'specs', 'bad.yaml'), 'openapi: 3.0.3\ninfo: { title: Bad, version: "1" }\npaths:\n  /items/{id}:\n    get:\n      responses: { "500": { description: boom } }\n');
    const bad = await cli(dir, ['contracts', 'lint', 'specs/bad.yaml']);
    expect(bad.exitCode).toBe(1);
    expect(bad.out).toMatch(/operation-id .*operationId is missing/);
    expect(bad.out).toMatch(/success-response/);
    expect(bad.out).toMatch(/path-params-declared .*id not declared/);
  });

  it('imports the spec into journeys that pass, with every step validated and coverage recorded', async () => {
    const imp = await cli(dir, ['import', 'specs/shop.yaml', '--kind', 'openapi', '--role', 'manager', '-o', 'journeys/api']);
    expect(imp.exitCode, imp.out + imp.err).toBe(0);
    expect(imp.out).toMatch(/imported 4 journeys/);
    const orders = await readFile(join(dir, 'journeys', 'api', 'ez-shop-api-orders.ez'), 'utf8');
    expect(orders).toContain('Call API "GET /api/orders/1" as manager and store as getOrder');
    expect(orders).toContain('Expect response getOrder conforms to OpenAPI "specs/shop.yaml"');
    const run = await cli(dir, ['run', 'journeys/api', '--no-analyze']);
    expect(run.exitCode, run.out + run.err).toBe(0);
    const runDir = await newestRun(dir);
    const cov = JSON.parse(await readFile(join(runDir, 'api-coverage.json'), 'utf8')) as { reports: Array<{ totals: Record<string, number>; operations: Array<{ id: string; covered: boolean; statuses: { missing: string[] } }> }> };
    const t = cov.reports[0].totals;
    expect(t.operations).toBe(5);
    expect(t.coveredOperations).toBe(5);
    expect(t.violations).toBe(0);
    expect(t.statusCodes).toBe(11);
    expect(t.coveredStatusCodes).toBe(5);
    expect(cov.reports[0].operations.find((o) => o.id === 'getOrder')!.statuses.missing).toEqual(['401', '404']);
  });

  it('fails a planted contract break naming the JSON pointer', async () => {
    const d2 = await project(broken);
    await cp(join(dir, 'journeys'), join(d2, 'journeys'), { recursive: true });
    const run = await cli(d2, ['run', 'journeys/api', '--grep', 'orders', '--no-analyze']);
    expect(run.exitCode).toBe(1);
    const result = JSON.parse(await readFile(join(await newestRun(d2), 'run.json'), 'utf8')) as { journeys: Array<{ steps: Array<{ status: string; error?: { message: string } }> }> };
    const failed = result.journeys[0].steps.find((s) => s.status === 'failed');
    expect(failed?.error?.message).toMatch(/GET \/api\/orders\/1 -> 200 breaks the API contract \(getOrder\): response \/created_by: required property is missing/);
  });

  it('reports untested operations and gates readiness on API coverage', async () => {
    await writeFile(join(dir, 'journeys', 'quote.ez'), 'Journey: Quote only\nCall API "POST /api/public/quote" with body \'{"sku":"SKU-100","qty":3}\' and store as q\n  Expect response q status is 200\n  Expect response q "$.total" equals "59.97"\n');
    await writeFile(join(dir, 'policy.yaml'), toYaml({ gates: { apiCoverage: { minOperations: 0.8 } } }));
    const run = await cli(dir, ['run', 'journeys/quote.ez', '--policy', 'policy.yaml']);
    const runDir = await newestRun(dir);
    const md = await readFile(join(runDir, 'api-coverage.md'), 'utf8');
    expect(md).toMatch(/\| Operations \| 1 \| 5 \| 20%/);
    expect(md).toMatch(/\*\*untested\*\* `GET \/api\/orders\/\{id\}` \(getOrder\)/);
    expect(run.out).toMatch(/NO_GO|GO_WITH_RISKS/);
    const a = await analyzeRun(runDir, { readinessPolicyPath: join(dir, 'policy.yaml'), recordHistory: false, formats: ['html', 'json'] });
    const gate = a.readiness!.gates.find((g) => g.gate === 'apiCoverage')!;
    expect(gate.status).toBe('fail');
    expect(gate.summary).toMatch(/operations 1\/5 \(20\.0%\) below 80\.0%; untested: getToken, listOrders, getOrder, listCustomers/);
    expect(gate.cites.evidence.length).toBeGreaterThan(0);
    expect(await readFile(join(runDir, 'report.html'), 'utf8')).toContain('API coverage: EZ Shop API');
    const c = await cli(dir, ['contract', 'coverage', runDir, '--min', '0.5']);
    expect(c.exitCode).toBe(1);
    expect(c.out).toContain('| Operations | 1 | 5 | 20% |');
  });

  it('serves a deterministic, schema-valid mock from the spec and rejects invalid requests (G13)', async () => {
    const spec = loadApiSpec(SPEC);
    const m1 = await createOpenApiMock({ spec, seed: 7 });
    const m2 = await createOpenApiMock({ spec, seed: 7 });
    try {
      const get = async (base: string) => (await fetch(`${base}/api/orders/42`)).json();
      const a = await get(m1.url);
      expect(await get(m2.url)).toEqual(a);
      expect(validateExchange(spec, { method: 'GET', url: '/api/orders/42', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: a }).violations).toEqual([]);
      const list = (await (await fetch(`${m1.url}/api/orders`)).json()) as unknown[];
      expect(Array.isArray(list) && list.length).toBe(2);
      const bad = await fetch(`${m1.url}/api/public/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'SKU-100', qty: 0 }) });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: 'invalid_request', operation: 'quote', violations: [{ rule: 'body', at: '/qty', message: '/qty: must be >= 1' }] });
      const nf = await fetch(`${m1.url}/api/orders/42`, { headers: { prefer: 'code=404' } });
      expect(nf.status).toBe(404);
      expect(validateExchange(spec, { method: 'GET', url: '/api/orders/42', status: 404, responseBody: await nf.json() }).valid).toBe(true);
    } finally {
      await m1.close();
      await m2.close();
    }
  });

  it('imports a Postman collection (folders, auth, tests, environment) into journeys that pass', async () => {
    const collection = {
      info: { _postman_id: 'b1', name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'baseUrl', value: demo.url }],
      item: [
        {
          name: 'Public', item: [{
            name: 'Quote two widgets',
            request: { method: 'POST', header: [{ key: 'Content-Type', value: 'application/json' }], url: { raw: '{{baseUrl}}/api/public/quote', host: ['{{baseUrl}}'], path: ['api', 'public', 'quote'] }, body: { mode: 'raw', raw: '{"sku":"{{sku}}","qty":2}' } },
            event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () {', '  pm.response.to.have.status(200);', '  var jsonData = pm.response.json();', '  pm.expect(jsonData.total).to.eql("39.98");', '  pm.expect(jsonData.name).to.include("Widg");', '  pm.environment.set("quoted", jsonData.sku);', '  pm.expect(pm.response.headers.get("x")).to.be.ok;', '});'] } }],
          }],
        },
        {
          name: 'Orders', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}' }] }, item: [{
            name: 'Get token', request: { method: 'POST', url: '{{baseUrl}}/api/token', body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'client_id', value: 'ez-client' }, { key: 'client_secret', value: '{{clientSecret}}' }] }, auth: { type: 'noauth' } },
            event: [{ listen: 'test', script: { exec: ['var jsonData = pm.response.json();', 'pm.environment.set("accessToken", jsonData.access_token);'] } }],
          }, {
            name: 'Get order 1', request: { method: 'GET', url: '{{baseUrl}}/api/orders/:id', header: [] },
            event: [{ listen: 'test', script: { exec: ['pm.response.to.have.status(200);', 'var jsonData = pm.response.json();', 'pm.expect(jsonData.lines[0].sku).to.eql("SKU-200");'] } }],
          }],
        },
      ],
    };
    (collection.item[1].item![1].request.url as unknown) = { raw: '{{baseUrl}}/api/orders/:id', variable: [{ key: 'id', value: '1' }] };
    await writeFile(join(dir, 'shop.postman_collection.json'), JSON.stringify(collection));
    await writeFile(join(dir, 'shop.postman_environment.json'), JSON.stringify({ values: [{ key: 'sku', value: 'SKU-100', enabled: true }, { key: 'clientSecret', value: 'not-copied', type: 'secret', enabled: true }] }));
    const imp = await cli(dir, ['import', 'shop.postman_collection.json', '--postman-env', 'shop.postman_environment.json', '-o', 'journeys/postman']);
    expect(imp.exitCode, imp.out + imp.err).toBe(0);
    const files = (await readdir(join(dir, 'journeys', 'postman'))).filter((f) => f.endsWith('.ez')).sort();
    expect(files).toEqual(['shop-orders.ez', 'shop-public.ez']);
    const pub = await readFile(join(dir, 'journeys', 'postman', 'shop-public.ez'), 'utf8');
    expect(pub).toContain('Variables: baseUrl=');
    expect(pub).toContain('sku="SKU-100"');
    expect(pub).not.toContain('not-copied');
    expect(pub).toContain('Expect response quoteTwoWidgets "$.total" equals "39.98"');
    expect(pub).toContain('Capture "$.sku" from quoteTwoWidgets as quoted');
    expect(pub).toMatch(/# TODO \(not converted\): pm\.expect\(pm\.response\.headers\.get\("x"\)\)\.to\.be\.ok;/);
    const orders = await readFile(join(dir, 'journeys', 'postman', 'shop-orders.ez'), 'utf8');
    expect(orders).toContain('with header "Authorization" = "Bearer ${accessToken}"');
    expect(orders).toContain('/api/orders/1');
    // The secret comes from the environment at run time, never from the collection.
    const withSecret = orders.replace(/^Variables: (.*)$/m, (_m, v: string) => `Variables: ${v}, clientSecret="${DEMO_CLIENT.secret}"`);
    await writeFile(join(dir, 'journeys', 'postman', 'shop-orders.ez'), withSecret);
    const run = await cli(dir, ['run', 'journeys/postman', '--no-analyze']);
    expect(run.exitCode, run.out + run.err).toBe(0);
  });
});

describe('EZTest contracts: consumer, provider and can-release through the results server (G12)', () => {
  let demo: DemoServer;
  let srv: TestServer;
  let dir: string;
  let dbFile: string;
  let testerToken: string;
  let releaseToken: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'eztest-contract-db-'));
    dbFile = join(base, 'shop.db');
    demo = await startDemoApp({ dbFile });
    srv = await startTestServer();
    testerToken = await srv.token('ci', [{ project: 'shop', role: 'tester' }]);
    releaseToken = await srv.token('release-manager', [{ project: 'shop', role: 'approver' }]);
    process.env.SHOP_SERVER_TOKEN = testerToken;
    dir = await project(demo, {
      db: { connections: { shop: { type: 'sqlite', file: dbFile } } },
      server: { url: srv.url, token: 'secret://env/SERVER_TOKEN', project: 'shop', sharedState: false },
      contracts: {
        dir: 'contracts', matchers: 'schema', app: 'shop-web', branch: 'main',
        provider: {
          name: 'ez-shop-api', baseUrl: demo.url, asRole: 'manager',
          states: {
            'order 1 exists': {
              sql: "INSERT OR REPLACE INTO orders (id, customer_id, created_by, status, total, created_at) VALUES (1, 1, 'bob', 'Submitted', $${total}, '2026-01-15T09:30:00.000Z')", on: 'shop',
              teardown: { sql: 'DELETE FROM orders WHERE id = 1', on: 'shop' },
            },
          },
        },
      },
    });
    seedOrder(demo);
    await mkdir(join(dir, 'journeys'), { recursive: true });
    await writeFile(join(dir, 'journeys', 'consumer.ez'), `Journey: Shop web consumer
Start a contract between consumer "shop-web" and provider "ez-shop-api"
Call API "POST /api/public/quote" with body '{"sku":"SKU-200","qty":2}' and store as quote
  Expect response quote "$.total" equals "99.00"
Given provider state "order 1 exists" with total=99
Call API "GET /api/orders/1" as manager and store as order
  Expect response order "$.lines[0].sku" equals "SKU-200"
Finish the contract
`);
  });
  afterAll(async () => {
    delete process.env.SHOP_SERVER_TOKEN;
    await demo?.close();
    await srv?.close();
  });

  it('writes the contract, publishes it, verifies with provider states, records the release and answers can-release', async () => {
    const run = await cli(dir, ['run', 'journeys/consumer.ez', '--no-analyze']);
    expect(run.exitCode, run.out + run.err).toBe(0);
    const contract = await readContractFile(join(dir, 'contracts', 'shop-web-ez-shop-api.contract.json'));
    expect(contract.expectations.map((e) => e.description)).toEqual(['Call API "POST /api/public/quote" with body \'{"sku":"SKU-200","qty":2}\' and store as quote', 'Call API "GET /api/orders/1" as manager and store as order']);
    const getOrder = contract.expectations[1] as HttpExpectation;
    expect(getOrder.given).toEqual([{ name: 'order 1 exists', params: { total: 99 } }]);
    expect(getOrder.request.headers ?? {}).not.toHaveProperty('authorization');
    // Matchers from the spec: integer ids, enum status as regex, date-time format.
    expect(getOrder.response.match?.['$.id']).toMatchObject({ matchers: [{ kind: 'integer' }] });
    expect(getOrder.response.match?.['$.status'].matchers[0]).toMatchObject({ kind: 'regex' });
    expect(getOrder.response.match?.['$.lines']).toMatchObject({ matchers: [{ kind: 'type', min: 1 }] });

    const pub = await cli(dir, ['contracts', 'publish', '--app-version', '1.0.0']);
    expect(pub.exitCode, pub.out + pub.err).toBe(0);
    expect(pub.out).toMatch(/^published shop-web 1\.0\.0 -> ez-shop-api/);

    // Provider verification against the running provider: contracts fetched from the server, state set up through SQL, results recorded on the server.
    demo.db.prepare('DELETE FROM orders WHERE id = 1').run();
    const ver = await cli(dir, ['contracts', 'verify', '--provider-version', '2.0.0', '--consumer-branch', 'main', '--publish']);
    expect(ver.exitCode, ver.out + ver.err).toBe(0);
    expect(ver.out).toMatch(/PASS shop-web -> ez-shop-api \(shop-web 1\.0\.0 \(results server\)\)/);
    expect((await srv.service.store.all('SELECT provider_version, passed FROM ez_contract_verifications'))).toEqual([{ provider_version: '2.0.0', passed: 1 }]);
    // The teardown removed the order again.
    expect(demo.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE id = 1').get()).toEqual({ n: 0 });

    const before = await cli(dir, ['contracts', 'can-release', '--app-version', '1.0.0', '--environment', 'production']);
    expect(before.exitCode).toBe(1);
    expect(before.out).toMatch(/ez-shop-api has no version released to production/);
    const refused = await cli(dir, ['contracts', 'record-release', '--app', 'ez-shop-api', '--app-version', '2.0.0', '--environment', 'production']);
    expect(refused.exitCode).toBe(1);
    expect(refused.err).toMatch(/does not allow contracts\.release/);
    process.env.SHOP_SERVER_TOKEN = releaseToken; // the release manager records releases
    const rec = await cli(dir, ['contracts', 'record-release', '--app', 'ez-shop-api', '--app-version', '2.0.0', '--environment', 'production']);
    expect(rec.exitCode, rec.err).toBe(0);
    const yes = await cli(dir, ['contracts', 'can-release', '--app-version', '1.0.0', '--environment', 'production']);
    expect(yes.exitCode, yes.out + yes.err).toBe(0);
    expect(yes.out).toMatch(/^YES: shop-web 1\.0\.0 to production/);
    expect((await cli(dir, ['contracts', 'record-release', '--app-version', '1.0.0', '--environment', 'production'])).exitCode).toBe(0);
    process.env.SHOP_SERVER_TOKEN = testerToken;
  });

  it('a broken provider fails verification, an unverified provider version cannot be released, and the readiness decision is NO_GO', async () => {
    const brokenDemo = await startDemoApp({ dbFile, bug: 'api-contract' });
    try {
      const cfg = (await readFile(join(dir, 'eztest.config.yaml'), 'utf8')).split(demo.url).join(brokenDemo.url);
      await writeFile(join(dir, 'eztest.config.yaml'), cfg);
      // A consumer run to attach the contract results to.
      const run = await cli(dir, ['run', 'journeys/consumer.ez', '--no-analyze']);
      expect(run.exitCode).toBe(1); // the planted break also fails the consumer's own spec validation
      const runDir = await newestRun(dir);
      const ver = await cli(dir, ['contracts', 'verify', 'contracts', '--run', runDir]);
      expect(ver.exitCode).toBe(1);
      expect(ver.out).toMatch(/FAIL Call API "GET \/api\/orders\/1" as manager and store as order \[given order 1 exists\]/);
      expect(ver.out).toMatch(/body \$\.created_by: is missing/);
      // shop-web 1.0.0 is in production; ez-shop-api 3.0.0 never verified its contract.
      const no = await cli(dir, ['contracts', 'can-release', '--app', 'ez-shop-api', '--app-version', '3.0.0', '--environment', 'production', '--run', runDir]);
      expect(no.exitCode).toBe(1);
      expect(no.out).toMatch(/^NO: ez-shop-api 3\.0\.0 to production .*ez-shop-api 3\.0\.0 has not verified the contract of shop-web 1\.0\.0/);
      await writeFile(join(dir, 'contracts-policy.yaml'), toYaml({ gates: { contracts: true } }));
      const a = await analyzeRun(runDir, { readinessPolicyPath: join(dir, 'contracts-policy.yaml'), recordHistory: false, formats: ['json'] });
      expect(a.readiness!.decision).toBe('NO_GO');
      const gate = a.readiness!.gates.find((g) => g.gate === 'contracts')!;
      expect(gate.status).toBe('fail');
      expect(gate.summary).toMatch(/contract shop-web -> ez-shop-api failed verification.*can-release ez-shop-api 3\.0\.0 to production: NO/);
      expect(gate.cites.evidence.length).toBe(1);
    } finally {
      await brokenDemo.close();
    }
  });

  it('refuses a Pact-format file with a clear message', async () => {
    await writeFile(join(dir, 'legacy.contract.json'), JSON.stringify({ consumer: { name: 'a' }, provider: { name: 'b' }, interactions: [], metadata: { pactSpecification: { version: '4.0' } } }));
    const r = await cli(dir, ['contracts', 'verify', 'legacy.contract.json']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toMatch(/not an EZTest contract \(format must be "eztest-contract"\)/);
  });
});
