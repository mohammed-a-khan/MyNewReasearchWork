/**
 * SLAs, the readiness "load" gate and CI exit codes through the CLI
 * (`eztest load run|gate|compare|validate|check|har|report|trend`), live
 * SLA evaluation with stopOnSlaFail, baseline regressions, the evidence
 * vault of a load run, and browser-level virtual users through EZTest's
 * own driver.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { buildProgram, type CliIO } from '../../src/cli/index.js';
import { verifyEvidence } from '../../src/core/index.js';
import { analyzeRun } from '../../src/engine/index.js';
import { LoadTest, readLoadResults, type LoadResults } from '../../src/load/index.js';
import { startLoadShop, type LoadShop } from '../../examples/load-shop/server.js';
import { scenario } from './helpers.js';

async function cli(cwd: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { ...process.env } };
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'eztest', ...args], { from: 'node' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

let srv: Server;
let base: string;
let delay = 20;
let dir: string;
beforeAll(async () => {
  srv = createServer((req, res) => setTimeout(() => {
    if (req.url === '/a') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessionId: `S-${Math.random().toString(16).slice(2, 10)}` }));
      return;
    }
    if (req.url?.startsWith('/b?s=')) {
      // only a session the server issued (not the recorded one) is accepted
      res.statusCode = /^\/b\?s=S-[0-9a-f]{8}$/.test(req.url) && !req.url.includes('7f3a9c11') ? 200 : 403;
    }
    res.end(req.url === '/fail' ? 'x' : 'ok');
  }, delay));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  dir = await mkdtemp(join(tmpdir(), 'ez-load-cli-'));
});
afterAll(() => new Promise<void>((r) => {
  srv.closeAllConnections();
  srv.close(() => r());
}));

const doc = (sla: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  version: 1, name: 'checkout api', baseUrl: base, requirements: ['REQ-PERF-1'],
  userPaths: { buyer: { actions: [{ transaction: { name: 'checkout', actions: [{ request: { name: 'POST /checkout', method: 'POST', url: '/checkout', json: { sku: 'A', vu: '${__vu}' } } }] } }], thinkTime: '10ms' } },
  profile: { type: 'constant', vus: 4, duration: '2s' },
  sla: [{ name: 'checkout speed', match: 'checkout', kind: 'transaction', ...sla }],
  ...extra,
});

describe('SLA verdicts gate readiness and CI', () => {
  it('a failing SLA exits 1, records NO_GO through the load gate, and cites the run\'s evidence', async () => {
    await writeFile(join(dir, 'fail.yaml'), toYaml(doc({ p95: { warn: 5, fail: 10 }, errorRate: { fail: 0.01 } })));
    await writeFile(join(dir, 'policy.yaml'), toYaml({ version: 1, gates: { load: true } }));
    const r = await cli(dir, ['load', 'run', 'fail.yaml', '-o', 'results', '--policy', 'policy.yaml', '-q']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/checkout api: FAIL/);
    expect(r.out).toMatch(/SLA FAIL: checkout speed checkout p95/);
    expect(r.out).toMatch(/readiness: NO_GO/);
    const runDir = join(dir, 'results', (await readdir(join(dir, 'results')))[0]);
    // the run directory is an EZTest run: a hash-chained evidence vault, run.json, report, readiness
    expect((await verifyEvidence(runDir)).ok).toBe(true);
    const rd = JSON.parse(await readFile(join(runDir, 'readiness.json'), 'utf8'));
    const gate = rd.gates.find((g: { gate: string }) => g.gate === 'load');
    expect(gate).toMatchObject({ status: 'fail', severity: 'blocker' });
    expect(gate.cites.evidence.length).toBeGreaterThan(0);
    expect(gate.summary).toMatch(/checkout p95/);
    const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    expect(run.journeys[0]).toMatchObject({ journeyId: 'load-checkout-api', status: 'failed', requirements: ['REQ-PERF-1'] });
    expect(existsSync(join(runDir, 'report.html'))).toBe(true);
    // the same decision from `eztest load gate` and from the standard analysis pipeline
    expect((await cli(dir, ['load', 'gate', runDir])).code).toBe(1);
    const a = await analyzeRun(runDir, { readinessPolicyPath: join(dir, 'policy.yaml'), recordHistory: false, formats: ['json'] });
    expect(a.readiness?.decision).toBe('NO_GO');
  }, 60_000);

  it('a passing SLA exits 0 with GO; warnings pass unless --fail-on-warn', async () => {
    await writeFile(join(dir, 'pass.yaml'), toYaml(doc({ p95: { warn: 5, fail: 2000 }, errorRate: { fail: 0.01 } })));
    const r = await cli(dir, ['load', 'run', 'pass.yaml', '-o', 'results-pass', '--policy', 'policy.yaml', '-q']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/checkout api: WARN/);
    expect(r.out).toMatch(/readiness: GO/);
    expect((await cli(dir, ['load', 'run', 'pass.yaml', '-o', 'results-pass', '--fail-on-warn', '-q'])).code).toBe(1);
  }, 60_000);

  it('stops early when an SLA fails live (stopOnSlaFail), and reports the live SLA events', async () => {
    const s = scenario(doc({ p95: { fail: 5 }, window: '1s' }, { stopOnSlaFail: true, profile: { type: 'constant', vus: 3, duration: '20s' } }) as Parameters<typeof scenario>[0]);
    const started = Date.now();
    const r = await new LoadTest(s, { monitors: false }).run();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stopReason).toMatch(/stopOnSlaFail/);
    expect(r.liveSla.some((e) => e.to === 'fail' && e.metric === 'p95')).toBe(true);
    expect(r.verdict).toBe('fail');
  }, 30_000);
});

describe('baseline comparison, trend and the other load commands', () => {
  it('detects a regression against a baseline and fails with --fail-on-regression', async () => {
    await writeFile(join(dir, 'cmp.yaml'), toYaml(doc({ p95: { fail: 5000 } }, { profile: { type: 'constant', vus: 4, duration: '2s' } })));
    delay = 10;
    expect((await cli(dir, ['load', 'run', 'cmp.yaml', '--run-dir', 'base-run', '-q'])).code).toBe(0);
    delay = 90;
    const r = await cli(dir, ['load', 'run', 'cmp.yaml', '--run-dir', 'slow-run', '--baseline', 'base-run', '--fail-on-regression', '-q']);
    delay = 20;
    expect(r.code).toBe(1);
    const slow: LoadResults = await readLoadResults(join(dir, 'slow-run'));
    expect(slow.comparison?.regressions).toBeGreaterThan(0);
    expect(slow.analysis.findings.some((f) => f.kind === 'regression' && /checkout/.test(f.title))).toBe(true);
    const cmp = await cli(dir, ['load', 'compare', 'base-run', 'slow-run']);
    expect(cmp.code).toBe(1);
    expect(cmp.out).toMatch(/regression\s+checkout/);
    const t = await cli(dir, ['load', 'trend', '--scenario', 'checkout api']);
    expect(t.out).toMatch(/run\(s\)/);
    expect(t.out).toMatch(/worse\s+transaction:checkout/);
    const rep = await cli(dir, ['load', 'report', 'slow-run']);
    expect(rep.out).toMatch(/report: .*report\.html/);
  }, 60_000);

  it('validate previews the curves, check replays each user path once', async () => {
    await writeFile(join(dir, 'mix.yaml'), toYaml({
      version: 1, name: 'mix', baseUrl: base, model: 'open',
      userPaths: { a: { actions: [{ request: '/a' }] }, b: { actions: [{ request: 'GET /b' }, { request: { url: '/fail', assert: [{ contains: 'ok' }] } }] } },
      populations: [{ name: 'a', userPath: 'a', share: 70, network: { latencyMs: 50 } }, { name: 'b', userPath: 'b', share: 30 }],
      profile: { type: 'step', from: 0, step: 10, every: '10s', to: 30 },
    }));
    const v = await cli(dir, ['load', 'validate', 'mix.yaml']);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/mix: open model, 2 user path\(s\), 2 population\(s\)/);
    expect(v.out).toMatch(/a \(a\): 70%, peak 21 iterations\/s/);
    expect(v.out).toMatch(/[▁▂▃▄▅▆▇█]{20,}/);
    const c = await cli(dir, ['load', 'check', 'mix.yaml']);
    expect(c.code).toBe(1);
    expect(c.out).toMatch(/a: OK/);
    expect(c.out).toMatch(/b: FAILED/);
    expect(c.out).toMatch(/does not contain "ok"/);
    const bad = await cli(dir, ['load', 'validate', 'nope.yaml']);
    expect(bad.code).toBe(2);
  });

  it('imports a HAR file into a scenario', async () => {
    const har = { log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [
      { startedDateTime: new Date().toISOString(), time: 3, request: { method: 'GET', url: `${base}/a`, headers: [] }, response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { text: '{"sessionId":"S-7f3a9c11"}' } } },
      { startedDateTime: new Date().toISOString(), time: 3, request: { method: 'GET', url: `${base}/b?s=S-7f3a9c11`, headers: [] }, response: { status: 200, headers: [], content: { text: 'ok' } } },
    ] } };
    await writeFile(join(dir, 'x.har'), JSON.stringify(har));
    const r = await cli(dir, ['load', 'har', 'x.har', '-o', 'load/har.yaml', '--vus', '2']);
    expect(r.out).toMatch(/1 correlated value/);
    const text = await readFile(join(dir, 'load/har.yaml'), 'utf8');
    expect(text).not.toContain('S-7f3a9c11');
    expect(text).toContain('${');
    expect((await cli(dir, ['load', 'check', 'load/har.yaml'])).code).toBe(0);
  });
});

describe('browser-level virtual users through EZTest\'s driver', () => {
  let shop: LoadShop;
  beforeAll(async () => {
    shop = await startLoadShop();
  });
  afterAll(() => shop?.close());

  it('runs a hybrid test: browser users log in and order while protocol users hit the API', async () => {
    const before = shop.stats.orders;
    const r = await new LoadTest(scenario({
      name: 'hybrid', baseUrl: shop.url,
      data: { users: { rows: [{ u: 'user1', p: 'pw-1' }, { u: 'user2', p: 'pw-2' }], order: 'unique', scope: 'vu' } },
      userPaths: {
        browserBuyer: {
          data: ['users'],
          actions: [
            { transaction: { name: 'login (browser)', actions: [
              { browser: { name: 'open login', goto: '/login' } },
              { browser: { fill: '#u', value: '${users.u}' } },
              { browser: { fill: '#pw', value: '${users.p}' } },
              { browser: { name: 'sign in', click: 'role=button[name="Sign in"]', expectUrl: '/orders/new' } },
            ] } },
            { transaction: { name: 'order (browser)', actions: [
              { browser: { fill: '#qty', value: '3' } },
              { browser: { name: 'place order', click: 'role=button[name="Place order"]', expectText: 'created' } },
              { browser: { capture: { selector: 'h1', var: 'orderTitle' } } },
            ] } },
          ],
        },
        api: { actions: [{ request: { name: 'token', method: 'POST', url: '/api/token', form: { client_id: 'shop-client', client_secret: 'shop-secret' }, extract: [{ var: 'tok', json: '$.access_token' }] } }] },
      },
      populations: [
        { name: 'browsers', userPath: 'browserBuyer', share: 50, profile: { type: 'constant', vus: 4, duration: '6s' } },
        { name: 'protocol', userPath: 'api', share: 50, profile: { type: 'constant', vus: 4, duration: '6s' } },
      ],
      options: { browser: { headless: true }, timeoutMs: 20_000 },
    }), { monitors: false }).run();
    expect(r.errors.samples).toEqual([]);
    expect(r.scenario.populations.find((p) => p.name === 'browsers')!.browser).toBe(true);
    const login = r.names.find((n) => n.name === 'login (browser)' && n.kind === 'transaction')!;
    const order = r.names.find((n) => n.name === 'order (browser)')!;
    expect(login.count).toBeGreaterThanOrEqual(2);
    expect(order.count).toBe(login.count);
    expect(shop.stats.orders - before).toBe(order.count);
    // browser steps are "page" samples, navigations also report the browser's TTFB
    expect(r.names.some((n) => n.kind === 'page' && n.name === 'place order')).toBe(true);
    expect(r.names.some((n) => n.name === 'open login (TTFB)')).toBe(true);
    expect(r.names.find((n) => n.name === 'token')!.count).toBeGreaterThan(20);
  }, 120_000);
});
