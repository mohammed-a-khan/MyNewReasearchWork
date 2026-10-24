/**
 * Regression tests for the gaps the enterprise reference suite (examples/enterprise-reference)
 * found in EZTest. Each describe names the finding in examples/enterprise-reference/FINDINGS.md.
 * These are unit level; the browser-level ones are in enterprise-findings-browser.test.ts.
 */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../../src/config/index.js';
import { IdentityVault, successMatches } from '../../src/identity/vault.js';
import { parseEzScript, parseIntent } from '../../src/intent/index.js';
import { stepToText } from '../../src/intent/ezscript.js';
import { apiSpecEntries, buildSpec, computeApiCoverage, createContractHook, urlUnder } from '../../src/contracts/index.js';
import { buildApiCall } from '../../src/runner/data-steps.js';
import { evaluateConditionOnce, expandExamples, type StepContext } from '../../src/runner/index.js';
import { withJourneyLenses } from '../../src/runner/journey.js';
import { Ledger } from '../../src/runner/ledger.js';
import { Step, type Journey, type RunResult } from '../../src/core/index.js';
import { Synthetic } from '../../src/data/synthetic.js';
import { SqliteDbClient, SQLITE_BUSY_TIMEOUT_MS } from '../../src/surfaces/db.js';
import { docsReadinessInputs } from '../../src/docs/readiness.js';
import { a11yReadinessInputs } from '../../src/a11y/readiness.js';
import { evaluateReadiness, parseReadinessPolicy } from '../../src/insights/index.js';
import { failureLines, libraryWith } from '../../src/cli/program.js';
import { isGoneBidiError } from '../../src/browser/firefox/connection.js';
import { triageJourney } from '../../src/insights/triage.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stringify as toYaml } from 'yaml';
import { buildProgram, type CliIO } from '../../src/cli/index.js';

const step = (line: string) => parseIntent(line);

describe('FINDING: an API-only machine role (OAuth2 client credentials) needs no browser sign-in', () => {
  it('the config schema accepts a role with only api:, and still requires browser fields when any is given', () => {
    const ok = validateConfig({ identity: { roles: { broker: { api: { tokenUrl: 'https://api.test/oauth/token', clientId: 'b', clientSecret: 'secret://env/X' } } } } });
    expect(ok.config.identity.roles.broker.username).toBeUndefined();
    expect(() => validateConfig({ identity: { roles: { half: { username: 'u', api: { tokenUrl: '/t', clientId: 'c', clientSecret: 's' } } } } })).toThrow(/loginUrl/);
    expect(() => validateConfig({ identity: { roles: { none: {} } } })).toThrow(/browser sign-in .* or API credentials/);
  });

  it('the vault lists the role, hands out API tokens for it, and explains why it cannot sign a browser in', async () => {
    const vault = new IdentityVault({ roles: { broker: { api: { getToken: async () => 'tok-1' } } } });
    expect(vault.roleNames()).toEqual(['broker']);
    expect(vault.isApiOnly('broker')).toBe(true);
    expect(await vault.apiToken('broker')).toBe('tok-1');
    await expect(vault.signIn({} as never, 'broker')).rejects.toThrow(/API-only role .* cannot sign in to a browser/);
  });
});

describe('FINDING: successUrl "/app/home" was read as the regex /app/ with flags "home"', () => {
  it('a plain path with two segments is a substring; /pattern/flags with real flags is a regex', () => {
    expect(successMatches('http://x/app/home', '/app/home')).toBe(true);
    expect(successMatches('http://x/portal/dashboard?x=1', '/portal/dashboard')).toBe(true);
    expect(successMatches('http://x/app/other', '/app/home')).toBe(false);
    expect(successMatches('http://x/ORDERS/1', '/orders\\/\\d+/i')).toBe(true);
  });
});

describe('FINDING: api.spec validated calls to every service against one service\'s spec', () => {
  const spec = buildSpec({
    openapi: '3.0.3', info: { title: 'Claims', version: '1' }, servers: [{ url: 'http://api.test' }],
    paths: { '/v1/claims': { post: { operationId: 'createClaim', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 1 } } } } } }, responses: { 201: { description: 'ok' }, 422: { description: 'invalid' } } } } },
  });
  const dir = mkdtemp(join(tmpdir(), 'ez-spec-'));
  const specFile = dir.then(async (d) => {
    const f = join(d, 'spec.json');
    await writeFile(f, JSON.stringify({
      openapi: '3.0.3', info: { title: 'Claims', version: '1' },
      paths: { '/v1/claims': { post: { operationId: 'createClaim', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 1 } } } } } }, responses: { 201: { description: 'ok' }, 422: { description: 'invalid' } } } } },
    }));
    return f;
  });
  const ctx = () => {
    const stored: string[] = [];
    return { stored, ctx: { journey: { id: 'j' }, ledger: new Ledger(), logger: { warn: () => undefined }, evidence: { store: async (_k: string, p: string) => (stored.push(p), { id: `E-${stored.length}` }) } } as unknown as StepContext };
  };
  const exchange = (url: string, status: number, body: unknown) => ({ call: { method: 'POST' as const, url, headers: { 'content-type': 'application/json' }, body }, url, response: { status, headers: {}, body: {}, durationMs: 1 }, step: Step.parse({ id: 's', intent: 's', action: 'api' }) });

  it('entries may be { file, baseUrl }; urlUnder is origin + path-prefix on segment boundaries', () => {
    expect(apiSpecEntries([' a.yaml'.trim(), { file: 'b.yaml', baseUrl: 'http://x' }])).toEqual([{ file: 'a.yaml' }, { file: 'b.yaml', baseUrl: 'http://x' }]);
    expect(urlUnder('http://api.test/v1/claims', 'http://api.test')).toBe(true);
    expect(urlUnder('http://api.test/v1x', 'http://api.test/v1')).toBe(false);
    expect(urlUnder('http://other.test/v1/claims', 'http://api.test')).toBe(false);
  });

  it('a call to another service is not validated (no evidence, no failure) when the spec is scoped', async () => {
    const hook = createContractHook({ specs: [{ file: await specFile, baseUrl: 'http://api.test' }] })!;
    const c = ctx();
    await hook(exchange('http://portal.test/health', 200, { a: 1 }), c.ctx);
    expect(c.stored).toEqual([]);
  });

  it('a negative test: an invalid request the provider refuses with a 4xx is evidence, not a contract break', async () => {
    const hook = createContractHook({ specs: [await specFile] })!;
    const c = ctx();
    await hook(exchange('http://api.test/v1/claims', 422, { amount: 0 }), c.ctx);
    expect(c.stored.length).toBe(1);
    // ... but an invalid request the provider ACCEPTS is still a break
    await expect(hook(exchange('http://api.test/v1/claims', 201, { amount: 0 }), ctx().ctx)).rejects.toThrow(/breaks the API contract/);
  });

  it('coverage does not count a call to an undocumented path as a contract violation', () => {
    const r = computeApiCoverage(spec, [{ method: 'POST', url: 'http://api.test/oauth/token', status: 401, violations: 1 }, { method: 'POST', url: 'http://api.test/v1/claims', status: 201, violations: 0 }]);
    expect(r.totals.violations).toBe(0);
    expect(r.totals.unmatchedCalls).toBe(1);
  });
});

describe('FINDING: API step grammar and bodies', () => {
  it('"as <role> with body ..." parses, and the role may also follow the options', () => {
    expect(step(`Call API "POST /v1/quotes" as broker with body '{"a":1}' and store as q`).api).toMatchObject({ asRole: 'broker', body: { a: 1 } });
    expect(step('Call API "POST /v1/quotes" with body from file "q.json" as broker and store as q').api).toMatchObject({ asRole: 'broker', bodyFile: 'q.json' });
  });

  it('an inline JSON body with ${number} placeholders is sent as JSON once the values are filled in', async () => {
    const s = Step.parse(step(`Call API "POST /v1/quotes" with body '{"sumInsured":\${sum},"region":"\${region}"}' and store as q`));
    const vars = { sum: 450000, region: 'COAST' };
    const ctx = { interpolate: (t: string) => t.replace(/\$\{(\w+)\}/g, (_w, k: string) => String(vars[k as keyof typeof vars])), vars: () => vars } as unknown as StepContext;
    const call = await buildApiCall(s, ctx, { outputDir: '.' });
    expect(call.body).toEqual({ sumInsured: 450000, region: 'COAST' });
  });
});

describe('FINDING: expectations on captured values', () => {
  const env = (vars: Record<string, unknown>, ledger = new Ledger()) => ({
    page: {} as never, ledger, vars: () => ({ ...vars, ...ledger.view() }), interpolate: (s: string) => s.replace(/\$\{([\w.]+)\}/g, (_w, k: string) => String((vars as Record<string, unknown>)[k] ?? ledger.get(k) ?? '')),
  });
  const cond = (line: string) => Step.parse(step(line)).postconditions[0];

  it('${a} == ${b} looks up journey variables too, and compares numbers as numbers', async () => {
    const ledger = new Ledger();
    ledger.set('row', { amount_claimed: 2450.7 });
    const r = await evaluateConditionOnce(cond('Expect ${row.amount_claimed} == ${amount}'), env({ amount: '2450.70' }, ledger));
    expect(r.passed).toBe(true);
  });

  it('${a} == <expression>: an unquoted right side with a call or arithmetic is evaluated', async () => {
    expect(cond('Expect ${payout} == round(number(approved) - number(excess), 2)')).toMatchObject({ type: 'expr' });
    expect(cond('Expect ${status} is Open')).toMatchObject({ type: 'ledgerEquals', expected: 'Open' });
    const r = await evaluateConditionOnce(cond('Expect ${payout} == round(number(approved) - number(excess), 2)'), env({ payout: '3100', approved: '3600', excess: '500' }));
    expect(r.passed).toBe(true);
  });

  it('${mail.text} contains "..." checks the value, not an element on the page', async () => {
    expect(cond('Expect ${mail.text} contains "CLM-1"')).toMatchObject({ type: 'expr' });
    const ok = await evaluateConditionOnce(cond('Expect ${mail.text} contains "CLM-${id}"'), env({ mail: { text: 'claim CLM-7 received' }, id: 7 }));
    expect(ok.passed).toBe(true);
    const no = await evaluateConditionOnce(cond('Expect ${mail.text} does not contain "rejected"'), env({ mail: { text: 'claim approved' } }));
    expect(no.passed).toBe(true);
  });

  it('"the URL does not contain" is an expectation', () => {
    const c = cond('Expect the URL does not contain "/app/home"') as { type: string; pattern: string };
    expect(c.type).toBe('urlMatches');
    expect(new RegExp(c.pattern).test('http://x/login/verify')).toBe(true);
    expect(new RegExp(c.pattern).test('http://x/app/home')).toBe(false);
  });
});

describe('FINDING: rows compared with a named query take named binds', () => {
  it('parses "with batch_id=..." into binds and renders it back', () => {
    const s = step('Expect rows paymentRows equal query "BATCH_PAYMENTS" on claims with batch_id="${jobId}" by key "payment_id"');
    expect(s.args).toMatchObject({ expectedQuery: { name: 'BATCH_PAYMENTS', connection: 'claims', binds: { batch_id: '${jobId}' } }, key: 'payment_id' });
    expect(stepToText(Step.parse(s))).toBe('Expect rows paymentRows equal query "BATCH_PAYMENTS" on claims with batch_id=${jobId} by key "payment_id"');
  });
});

describe('FINDING: Examples placeholders where the grammar needs a number', () => {
  it('the parse error says to use the ${column} expression form', () => {
    const src = 'Journey: S <code>\nCall API "GET /x" with errors allowed and store as r\nExpect the r response status is <code>\nExamples:\n  | code |\n  | 404 |\n';
    expect(() => parseEzScript(src)).toThrow(/Examples placeholders like <code> .*Expect \$\{response.status\} == \$\{code\}/);
  });
});

describe('FINDING: Data: constraints joined with "and"', () => {
  it('reads "where region=COAST and segment=DIRECT" as two constraints (quoted values keep their "and")', () => {
    const j = parseEzScript('Journey: D\nData: Customer as holder where region=COAST and segment=DIRECT; Firm as f where name="Smith and Co"\nOpen /\n');
    expect(j.data[0].where).toEqual({ region: 'COAST', segment: 'DIRECT' });
    expect(j.data[1].where).toEqual({ name: 'Smith and Co' });
  });
});

describe('FINDING: created test data needs config defaults and unique keys', () => {
  it('data.entities accepts defaults; the "unique" generator never repeats', () => {
    const { config } = validateConfig({ data: { entities: { Customer: { provider: 'sql', connection: 'c', table: 'customers', defaults: { id: 'gen:unique:C-T', segment: 'DIRECT' } } } } });
    expect(config.data.entities.Customer.defaults).toEqual({ id: 'gen:unique:C-T', segment: 'DIRECT' });
    const s = new Synthetic(1);
    const a = String(s.byName('unique:C-T'));
    expect(a.startsWith('C-T')).toBe(true);
    expect(s.byName('unique:C-T')).not.toBe(a);
  });
});

describe('FINDING: SQLite connections had no busy timeout (parallel writers fail at once)', () => {
  it('a file connection waits for locks', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ez-sqlite-'));
    const db = new SqliteDbClient({ file: join(d, 'x.db') });
    const [row] = await db.query('PRAGMA busy_timeout');
    expect(Object.values(row)[0]).toBe(SQLITE_BUSY_TIMEOUT_MS);
    await db.close();
  });
});

describe('FINDING: readiness gates for documents and clean accessibility scans', () => {
  const run = { runId: 'r', journeys: [{ journeyId: 'j1', status: 'passed', steps: [] }], summary: { total: 1, passed: 1, passedHealed: 0, failed: 0, skipped: 0, errors: 0 } } as unknown as RunResult;
  async function runDirWith(files: Record<string, unknown>): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'ez-ready-'));
    for (const [p, v] of Object.entries(files)) {
      await mkdir(join(d, p, '..'), { recursive: true });
      await writeFile(join(d, p), JSON.stringify(v));
    }
    return d;
  }

  it('"Compare document" checks feed docsReconciled (pass and fail, with citations)', async () => {
    const evidence = [
      { id: 'E-1', kind: 'data', path: 'compare/j1/s1.json', sha256: 'x', description: 'document comparison', journeyId: 'j1' },
      { id: 'E-2', kind: 'data', path: 'compare/j1/s2.json', sha256: 'x', description: 'document comparison', journeyId: 'j1' },
    ] as never;
    const dir = await runDirWith({
      'compare/j1/s1.json': { passed: true, details: { status: 'PASS', fields: [] } },
      'compare/j1/s2.json': { passed: false, details: { status: 'FAIL', fields: [{ name: 'payout', verdict: 'DB_DIFFERS', diagnosis: 'data defect' }], footing: { passed: false, message: 'lines do not add up' } } },
    });
    const { docs } = await docsReadinessInputs(dir, evidence);
    expect(docs?.reconciled).toBe(false);
    expect(docs?.mismatches?.[0].description).toMatch(/payout \(data defect\), footing \(lines do not add up\)/);
    const policy = parseReadinessPolicy('version: 1\ngates:\n  docsReconciled: true\n');
    const r = evaluateReadiness(policy, { run, evidence, triage: { verdicts: [], counts: {} } as never, flaky: [], docs });
    expect(r.gates.find((g) => g.gate === 'docsReconciled')?.status).toBe('fail');
  });

  it('a run whose accessibility scans are all clean passes a11yNoCritical (it used to abort the analysis)', async () => {
    const evidence = [{ id: 'E-9', kind: 'data', path: 'a11y/j1/lens-a11y-s.json', sha256: 'x', journeyId: 'j1' }] as never;
    const dir = await runDirWith({ 'a11y/j1/lens-a11y-s.json': [{ lens: 'a11y', details: { violations: [] } }] });
    const input = await a11yReadinessInputs(dir, evidence);
    const policy = parseReadinessPolicy('version: 1\ngates:\n  a11yNoCritical: true\n');
    const r = evaluateReadiness(policy, { run, evidence, triage: { verdicts: [], counts: {} } as never, flaky: [], ...input });
    expect(r.gates.find((g) => g.gate === 'a11yNoCritical')).toMatchObject({ status: 'pass' });
  });
});

describe('FINDING: CLI usability', () => {
  it('failureLines names the deepest failing step and its error for each failed journey', () => {
    const run = {
      journeys: [
        { journeyId: 'ok', status: 'passed', steps: [] },
        { journeyId: 'bad', status: 'failed', steps: [{ stepId: 'g', intent: 'In the frame', status: 'failed', error: { message: 'outer' }, children: [{ stepId: 'c', intent: 'Click Confirm', status: 'failed', error: { message: 'post-condition failed: page does not contain "x"\nmore' } }] }] },
      ],
    } as unknown as RunResult;
    expect(failureLines(run)).toEqual(['failures:', '  x bad at "Click Confirm": post-condition failed: page does not contain "x"']);
  });

  it('running a subfolder still finds @library sub-journeys elsewhere in the journeys dir', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ez-lib-'));
    await mkdir(join(d, 'journeys', 'lib'), { recursive: true });
    await writeFile(join(d, 'journeys', 'lib', 'helper.ez'), 'Journey: Helper\nId: helper\nTags: @library\nOpen /\n');
    const selected = [parseEzScript('Journey: Main\nId: main\nRun journey "helper"\n')];
    const lib = await libraryWith(selected, 'journeys', d);
    expect(lib.map((j) => j.id).sort()).toEqual(['helper', 'main']);
  });
});

describe('FINDING: a Lenses: header turns a lens on for that journey only', () => {
  it('adds a lens from the factory when the run does not have it (":warn" passed through)', () => {
    const journey = parseEzScript('Journey: L\nLenses: security:warn\nOpen /\n') as Journey;
    const made: string[] = [];
    const env = { opts: { outputDir: '.', lenses: [], lensFactory: (spec: string) => (made.push(spec), { name: spec.split(':')[0] }) } } as never;
    const out = withJourneyLenses(journey, env);
    expect(made).toEqual(['security:warn']);
    expect(out.opts.lenses?.map((l) => l.name)).toEqual(['security']);
    // Expanding Examples keeps the header
    expect(expandExamples([journey])[0].lenses).toEqual(['security:warn']);
  });
});

describe('FINDING: on Firefox, an action under a re-render failed with "realm is null" instead of retrying', () => {
  it('the remote agent\'s "realm is null" error means the realm is gone (retryable), like "no such frame"', () => {
    expect(isGoneBidiError({ error: 'unknown error', message: 'TypeError: can\'t access property "context", realm is null' })).toBe(true);
    expect(isGoneBidiError({ error: 'no such frame', message: '' })).toBe(true);
    expect(isGoneBidiError({ error: 'unknown error', message: 'TypeError: x is null' })).toBe(false);
  });
});

describe('FINDING: a wrong premium (captured value vs expected) was triaged "unknown, needs human"', () => {
  it('a failed value post-condition is a suspected product bug', () => {
    const msg = 'post-condition failed: ledgerEquals: premium.tax is "189", expected "160.65"; ledgerEquals: premium.totalPremium is "1527.75", expected "1499.4"';
    const step = { stepId: 'rate', intent: 'Run journey "expected-premium"', status: 'failed', durationMs: 1, conditions: [], evidence: ['E-1'], error: { message: msg } };
    const j = { journeyId: 'quote', name: 'Quote', status: 'failed', startedAt: '', durationMs: 1, steps: [step], tags: [], requirements: [], attempt: 1, ledger: {}, evidence: [] };
    const v = triageJourney(j as never, { run: { journeys: [j] } as never, evidence: [{ id: 'E-1', kind: 'screenshot', path: 'shots/rate.png', sha256: 'x', journeyId: 'quote', stepId: 'rate' }] as never });
    expect(v.category).toBe('product-bug');
    expect(v.winner?.rule).toBe('value-mismatch');
  });
});

describe('FINDING: eztest load run ignored the suite\'s .env, so ${env.SECRET} in a scenario was empty', () => {
  it('reads .env (and .env.<name> with -e) without overriding the real environment; baseUrl may come from it', async () => {
    const srv = createServer((req, res) => {
      res.statusCode = req.headers['x-secret'] === 'from-dotenv-uat' ? 200 : 401;
      res.end('ok');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const dir = await mkdtemp(join(tmpdir(), 'ez-load-env-'));
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      await writeFile(join(dir, '.env'), 'EZ_FINDING_LOAD_SECRET=from-dotenv\n');
      await writeFile(join(dir, '.env.uat'), `EZ_FINDING_LOAD_SECRET=from-dotenv-uat\nEZ_FINDING_LOAD_BASE=${base}\n`);
      await writeFile(join(dir, 'l.yaml'), toYaml({
        version: 1, name: 'env secret', baseUrl: '${env.EZ_FINDING_LOAD_BASE}', profile: { type: 'constant', vus: 1, duration: '1s' },
        userPaths: { u: { actions: [{ request: { name: 'GET /', method: 'GET', url: '/', headers: { 'x-secret': '${env.EZ_FINDING_LOAD_SECRET}' }, assert: [{ status: 200 }] } }], thinkTime: '50ms' } },
        sla: [{ name: 'no errors', match: '*', kind: 'request', errorRate: { fail: 0 } }],
      }));
      delete process.env.EZ_FINDING_LOAD_SECRET;
      const out: string[] = [];
      const io: CliIO = { out: (x) => out.push(x), err: (x) => out.push(x), cwd: dir, env: { ...process.env } };
      process.exitCode = 0;
      // .env.uat is read after .env and wins over it
      await buildProgram(io).parseAsync(['node', 'eztest', 'load', 'run', 'l.yaml', '-e', 'uat', '-o', 'results', '-q'], { from: 'node' });
      expect(out.join('\n')).toMatch(/env secret: PASS/);
      expect(Number(process.exitCode ?? 0)).toBe(0);
    } finally {
      process.exitCode = 0;
      delete process.env.EZ_FINDING_LOAD_SECRET;
      delete process.env.EZ_FINDING_LOAD_BASE;
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);
});
