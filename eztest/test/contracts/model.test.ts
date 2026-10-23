/**
 * EZTest contracts: the contract file format (JSON and YAML, matcher
 * shorthands), matcher inference, rule-based comparison, contracts from mock
 * stores, can-release, the results-server registry (publish, fetch,
 * verification results, releases) and the readiness gates.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canReleaseText, compareBody, compareMessage, compareResponse, contractFromMockStore, contractHash, contractToJson, evaluateApiCoverageGate, evaluateCanRelease,
  evaluateContractsGate, inferMatchers, isContractFile, parseContract, readContractFile, upsertExpectations, verificationText, type Contract, type Expectation, type HttpExpectation, type MessageExpectation,
} from '../../src/contracts/index.js';
import { emptyStore } from '../../src/mocks/index.js';
import { evaluateReadiness } from '../../src/insights/index.js';
import { ResultsClient, Store } from '../../src/server/index.js';
import type { RunResult } from '../../src/core/index.js';
import { startTestServer, type TestServer } from '../server/helpers.js';

const doc = (expectations: unknown[], extra: Record<string, unknown> = {}) => ({ format: 'eztest-contract', version: 1, consumer: 'web', provider: 'api', expectations, ...extra });

describe('contract files', () => {
  it('reads expectations with provider states, query strings and matcher shorthands', () => {
    const c = parseContract(doc([{
      description: 'get order', given: [{ state: 'order 42 exists', params: { id: 42 } }, 'a user'],
      request: { method: 'get', path: '/orders/42', query: 'a=1&a=2' },
      response: { status: 200, body: { id: 42, items: [{ sku: 'A1' }], status: 'new' }, match: { '$.id': 'integer', '$.items': { kind: 'type', min: 1 }, '$.status': { any: [{ kind: 'regex', regex: '^new$' }, { kind: 'regex', regex: '^paid$' }] }, '$.items[*].sku': ['type', { kind: 'regex', regex: '^[A-Z]\\d$' }] } },
    }]));
    const e = c.expectations[0] as HttpExpectation;
    expect(e).toMatchObject({ given: [{ name: 'order 42 exists', params: { id: 42 } }, { name: 'a user' }], request: { method: 'GET', query: { a: ['1', '2'] } } });
    expect(e.response.match).toEqual({
      '$.id': { matchers: [{ kind: 'integer' }] },
      '$.items': { matchers: [{ kind: 'type', min: 1 }] },
      '$.status': { combine: 'any', matchers: [{ kind: 'regex', regex: '^new$' }, { kind: 'regex', regex: '^paid$' }] },
      '$.items[*].sku': { matchers: [{ kind: 'type' }, { kind: 'regex', regex: '^[A-Z]\\d$' }] },
    });
    // The file form round-trips (shortest matcher forms).
    const json = contractToJson(c);
    expect((json.expectations as Array<{ response: { match: Record<string, unknown> } }>)[0].response.match['$.id']).toBe('integer');
    expect(parseContract(json)).toEqual(c);
  });

  it('refuses documents that are not EZTest contracts, with the reason', () => {
    expect(() => parseContract({ consumer: { name: 'c' }, provider: { name: 'p' }, interactions: [] })).toThrow(/not an EZTest contract \(format must be "eztest-contract"\)/);
    expect(() => parseContract({ ...doc([]), version: 2 })).toThrow(/unsupported contract version 2/);
    expect(() => parseContract(doc([{ request: { path: 'x' } }]))).toThrow(/request\.path must start with "\/"/);
    expect(() => parseContract(doc([{ request: { path: '/x' }, response: { match: { '$.a': 'fuzzy' } } }]))).toThrow(/unknown matcher kind "fuzzy"/);
    expect(() => parseContract(doc([{ request: { path: '/x' }, response: { match: { '$.a': { kind: 'regex', regex: '(' } } } }]))).toThrow(/invalid regex/);
    expect(() => parseContract(doc([{ description: 'd', request: { path: '/x' } }, { description: 'd', request: { path: '/y' } }]))).toThrow(/two expectations are both "d"/);
  });

  it('reads message expectations (Kafka, AMQP, MQTT, IBM MQ) and compares produced messages', () => {
    const c = parseContract(doc([
      { kind: 'message', description: 'invoice created', given: ['an order'], channel: { transport: 'kafka', destType: 'topic', dest: 'invoices' },
        message: { contents: { invoiceId: 'INV-1', orderId: 1 }, key: '1', headers: { type: 'invoice.created', trace: 't-1' }, match: { '$.invoiceId': { kind: 'regex', regex: '^INV-\\d+$' }, '$.orderId': 'integer' }, headerMatch: { trace: { kind: 'regex', regex: '^t-' } } } },
      ...['amqp', 'mqtt', 'ibmmq'].map((transport) => ({ kind: 'message', description: `on ${transport}`, channel: { transport, destType: 'queue', dest: 'q' }, message: { contents: 'text' } })),
      { description: 'and an HTTP one', request: { path: '/x' } },
    ]));
    expect(c.expectations.map((e) => e.kind ?? 'http')).toEqual(['message', 'message', 'message', 'message', 'http']);
    const m = c.expectations[0] as MessageExpectation;
    expect(m).toMatchObject({ given: [{ name: 'an order' }], channel: { transport: 'kafka', destType: 'topic', dest: 'invoices' }, message: { key: '1', match: { '$.orderId': { matchers: [{ kind: 'integer' }] } } } });
    expect(parseContract(contractToJson(c))).toEqual(c);
    expect(compareMessage(m.message, { contents: '{"invoiceId":"INV-77","orderId":77}', key: '1', headers: { Type: 'invoice.created', trace: 't-9' } })).toEqual([]);
    expect(compareMessage(m.message, { contents: { invoiceId: 'X', orderId: 1.5 }, key: '2', headers: { type: 'other' } }).map((x) => x.message)).toEqual([
      'message $.invoiceId: "X" does not match /^INV-\\d+$/', 'message $.orderId: expected an integer, got 1.5', 'key: expected "1", got "2"', 'header type: expected "invoice.created", got "other"', 'header trace: is missing',
    ]);
    expect(() => parseContract(doc([{ kind: 'message', channel: { transport: 'jms', dest: 'q' }, message: { contents: 1 } }]))).toThrow(/channel\.transport must be one of kafka, amqp, mqtt, ibmmq, memory/);
    expect(() => parseContract(doc([{ kind: 'message', channel: { transport: 'mqtt', dest: 'q' }, message: {} }]))).toThrow(/message\.contents is required/);
    expect(() => parseContract(doc([{ kind: 'grpc', request: { path: '/x' } }]))).toThrow(/kind must be "http" or "message"/);
    // The content hash covers message expectations, so can-release covers them too.
    expect(contractHash(c)).not.toBe(contractHash({ ...c, expectations: c.expectations.slice(1) }));
  });

  it('reads YAML files, merges expectations by description and states, and hashes content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-contract-'));
    await writeFile(join(dir, 'web-api.contract.yaml'), 'format: eztest-contract\nversion: 1\nconsumer: web\nprovider: api\nexpectations:\n  - description: ping\n    request: { method: GET, path: /ping }\n    response: { status: 204 }\n');
    expect(((await readContractFile(join(dir, 'web-api.contract.yaml'))).expectations[0] as HttpExpectation).response.status).toBe(204);
    expect(['a.contract.json', 'a.contract.yml', 'a.json'].map(isContractFile)).toEqual([true, true, false]);
    const mk = (status: number): Expectation => ({ description: 'get x', given: [], request: { method: 'GET', path: '/x' }, response: { status } });
    await upsertExpectations(dir, 'c', 'p', [mk(200)]);
    const r = await upsertExpectations(dir, 'c', 'p', [mk(404), { ...mk(200), description: 'other' }]);
    expect(r.file).toMatch(/c-p\.contract\.json$/);
    expect(r.replaced).toEqual(['get x']);
    const c = await readContractFile(r.file);
    expect(c.expectations.map((e) => `${e.description} ${(e as HttpExpectation).response.status}`)).toEqual(['get x 404', 'other 200']);
    expect(contractHash(c)).toMatch(/^[a-f0-9]{64}$/);
    expect(contractHash({ ...c, meta: { note: 'ignored' } })).toBe(contractHash(c));
    expect(contractHash({ ...c, expectations: c.expectations.slice(1) })).not.toBe(contractHash(c));
  });

  it('makes contracts from mock-store recordings', () => {
    const store = emptyStore();
    store.recordings.push({ id: '1', request: { method: 'GET', path: '/a', query: 'x=1', headers: {} }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[{"id":1}]}', bodyEncoding: 'utf8' }, recordedAt: '' });
    const c = contractFromMockStore(store, 'web', 'api');
    const e = c.expectations[0] as HttpExpectation;
    expect(e.description).toBe('GET /a?x=1 -> 200');
    expect(e.request.query).toEqual({ x: ['1'] });
    expect(e.response.match).toMatchObject({ '$.items': { matchers: [{ kind: 'type', min: 1 }] }, '$.items[*].id': { matchers: [{ kind: 'type' }] } });
  });
});

describe('matchers', () => {
  const body = { id: 1, name: 'Ann', tags: ['a', 'b'], lines: [{ sku: 'S1', qty: 2 }], meta: { at: '2026-01-01T00:00:00Z' } };
  const rules = inferMatchers(body);

  it('accepts different values of the same types (and extra keys), longer arrays like the first item', () => {
    expect(compareBody(body, { id: 9, name: 'Bob', tags: ['x'], lines: [{ sku: 'S2', qty: 5 }, { sku: 'S3', qty: 1, extra: true }], meta: { at: 'later' }, more: 1 }, rules)).toEqual([]);
  });

  it('reports missing keys, wrong types and empty arrays with paths', () => {
    const m = compareBody(body, { id: '9', tags: [], lines: [{ sku: 1, qty: 2 }], meta: {} }, rules).map((x) => x.message);
    expect(m).toEqual([
      'body $.id: expected a number, got string',
      'body $.name: is missing',
      'body $.tags: expected at least 1 item(s), got 0',
      'body $.lines[0].sku: expected a string, got number',
      'body $.meta.at: is missing',
    ]);
  });

  it('without matchers, values must be equal; regex, integer, include, eachValue, any and date matchers', () => {
    expect(compareBody({ a: 1 }, { a: 2 }, undefined).map((x) => x.message)).toEqual(['body $.a: expected 1, got 2']);
    const r = {
      '$.code': { matchers: [{ kind: 'regex' as const, regex: '^[A-Z]{3}$' }] }, '$.n': { matchers: [{ kind: 'integer' as const }] },
      '$.t': { matchers: [{ kind: 'include' as const, value: 'ell' }] }, '$.map': { matchers: [{ kind: 'eachValue' as const }] },
      '$.s': { combine: 'any' as const, matchers: [{ kind: 'regex' as const, regex: '^a$' }, { kind: 'regex' as const, regex: '^b$' }] }, '$.d': { matchers: [{ kind: 'date' as const }] },
    };
    const exp = { code: 'ABC', n: 1, t: 'hello', map: { k: { v: 1 } }, s: 'a', d: '2026-01-01' };
    expect(compareBody(exp, { code: 'XYZ', n: 3, t: 'yellow', map: { a: { v: 2 }, b: { v: 3 } }, s: 'b', d: '2027-12-31' }, r)).toEqual([]);
    expect(compareBody(exp, { code: 'xy', n: 1.5, t: 'no', map: { a: { w: 1 } }, s: 'c', d: 'soon' }, r).map((x) => x.message)).toEqual([
      'body $.code: "xy" does not match /^[A-Z]{3}$/', 'body $.n: expected an integer, got 1.5', 'body $.t: expected text including "ell", got "no"', 'body $.map.a.v: is missing',
      'body $.s: "c" does not match /^a$/', 'body $.s: "c" does not match /^b$/', 'body $.d: expected a date (YYYY-MM-DD), got "soon"',
    ]);
  });

  it('compares status, headers (content type parameters ignored, header matchers) and body', () => {
    const exp = { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'r-1' }, body: { ok: true }, match: inferMatchers({ ok: true }), headerMatch: { 'x-request-id': { matchers: [{ kind: 'regex' as const, regex: '^r-\\d+$' }] } } };
    expect(compareResponse(exp, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'r-77' }, body: { ok: false } })).toEqual([]);
    expect(compareResponse(exp, { status: 500, headers: { 'x-request-id': 'nope' }, body: 'x' }).map((m) => m.message)).toEqual(['status: expected 200, got 500', 'header Content-Type: is missing', 'header X-Request-Id: "nope" does not match /^r-\\d+$/', 'body $: expected an object, got string']);
  });

  it('prints verification results', () => {
    expect(verificationText({ consumer: 'c', provider: 'p', source: 'f', hash: 'h', passed: false, expectations: [{ description: 'd', kind: 'http', providerStates: ['s'], passed: false, mismatches: [{ path: 'status', message: 'status: expected 200, got 500' }], durationMs: 1 }] }))
      .toBe('FAIL c -> p (f)\n  FAIL d [given s]\n       status: expected 200, got 500');
  });
});

describe('can-release', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const contracts = [
    { consumer: 'web', provider: 'api', consumerVersion: 'w1', hash: 'H1', publishedAt: at(1) },
    { consumer: 'web', provider: 'api', consumerVersion: 'w2', hash: 'H2', publishedAt: at(2) },
    { consumer: 'mobile', provider: 'api', consumerVersion: 'm1', hash: 'M1', publishedAt: at(3) },
  ];
  it('as a consumer: the provider version released to the environment must have verified this content', () => {
    const base = { contracts, releases: [{ app: 'api', environment: 'prod', version: 'a7', releasedAt: at(4) }], verifications: [{ consumer: 'web', provider: 'api', hash: 'H1', providerVersion: 'a7', passed: true, verifiedAt: at(5) }] };
    expect(evaluateCanRelease({ ...base, app: 'web', version: 'w1', environment: 'prod' })).toMatchObject({ releasable: true, reason: 'all 1 contract check(s) passed' });
    const no = evaluateCanRelease({ ...base, app: 'web', version: 'w2', environment: 'prod' });
    expect(no.releasable).toBe(false);
    expect(no.checks[0].reason).toBe('api a7 has not verified the contract of web w2');
    expect(evaluateCanRelease({ ...base, app: 'web', version: 'w1', environment: 'test' }).checks[0].reason).toBe('api has no version released to test');
    const failedLater = evaluateCanRelease({ ...base, verifications: [...base.verifications, { consumer: 'web', provider: 'api', hash: 'H1', providerVersion: 'a7', passed: false, failed: ['get: status: expected 200, got 500'], verifiedAt: at(9) }], app: 'web', version: 'w1', environment: 'prod' });
    expect(failedLater.checks[0].reason).toBe('api a7 failed the contract of web w1 (get: status: expected 200, got 500)');
    expect(evaluateCanRelease({ ...base, app: 'reports', version: '1', environment: 'prod' })).toMatchObject({ releasable: true, reason: 'no contract involves reports 1 in prod', checks: [] });
  });

  it('as a provider: every consumer released to the environment must be satisfied by this version', () => {
    const releases = [{ app: 'web', environment: 'prod', version: 'w1', releasedAt: at(1) }, { app: 'mobile', environment: 'prod', version: 'm1', releasedAt: at(1) }];
    const verifications = [{ consumer: 'web', provider: 'api', hash: 'H1', providerVersion: 'a8', passed: true, verifiedAt: at(5) }];
    const r = evaluateCanRelease({ app: 'api', version: 'a8', environment: 'prod', contracts, releases, verifications });
    expect(r.releasable).toBe(false);
    expect(r.checks.map((c) => `${c.consumer}:${c.ok}`)).toEqual(['web:true', 'mobile:false']);
    expect(canReleaseText(r)).toMatch(/^NO: api a8 to prod - 1 of 2 contract check\(s\) failed: api a8 has not verified the contract of mobile m1\n  ok {3}web w1 -> api a8/);
  });
});

describe('the results server keeps contracts, verifications and releases', () => {
  let srv: TestServer;
  let client: ResultsClient;
  let viewer: ResultsClient;
  let releaser: ResultsClient;
  const contract = (status: number): Record<string, unknown> => contractToJson({ consumer: 'web', provider: 'api', expectations: [{ description: 'get order', given: [{ name: 'order 42 exists' }], request: { method: 'GET', path: '/orders/42' }, response: { status } }] } satisfies Contract);
  beforeAll(async () => {
    srv = await startTestServer();
    client = new ResultsClient({ url: srv.url, project: 'shop', token: await srv.token('ci', [{ project: 'shop', role: 'tester' }]) });
    viewer = new ResultsClient({ url: srv.url, project: 'shop', token: await srv.token('viewer', [{ project: 'shop', role: 'viewer' }]) });
    releaser = new ResultsClient({ url: srv.url, project: 'shop', token: await srv.token('release-manager', [{ project: 'shop', role: 'approver' }]) });
  });
  afterAll(async () => {
    await srv.close();
  });

  it('publish, fetch by branch and environment, verify by hash, release and can-release', async () => {
    const p1 = await client.publishContract(contract(200), 'w1', 'main');
    expect(p1).toMatchObject({ consumer: 'web', provider: 'api', consumerVersion: 'w1', branch: 'main', created: true });
    expect((await client.publishContract(contract(200), 'w1', 'main')).created).toBe(false);
    await expect(client.publishContract(contract(201), 'w1')).rejects.toThrow(/already published a different contract/);
    await client.publishContract(contract(200), 'w2', 'main'); // same content as w1
    await client.publishContract(contract(201), 'w3', 'feature-x');
    await expect(client.publishContract({ consumer: { name: 'web' }, interactions: [] }, 'w9')).rejects.toThrow(/not an EZTest contract/);
    await expect(viewer.publishContract(contract(200), 'w8')).rejects.toThrow(/does not allow run\.publish/);

    const main = await viewer.contracts({ provider: 'api', branch: 'main' });
    expect(main.map((c) => c.consumerVersion)).toEqual(['w2']);
    expect((parseContract(main[0].contract).expectations[0] as HttpExpectation).response.status).toBe(200);
    expect((await viewer.contracts({ provider: 'api' })).map((c) => c.consumerVersion)).toEqual(['w3']);

    await client.recordVerification({ provider: 'api', providerVersion: 'a7', hash: p1.hash, passed: true });
    await expect(client.recordVerification({ provider: 'api', providerVersion: 'a7', hash: 'f'.repeat(64), passed: true })).rejects.toThrow(/No contract with api has hash/);
    expect((await client.canRelease({ app: 'web', version: 'w2', environment: 'prod' })).checks[0].reason).toBe('api has no version released to prod');
    await expect(client.recordRelease({ app: 'api', version: 'a7', environment: 'prod' })).rejects.toThrow(/does not allow contracts\.release/);
    await releaser.recordRelease({ app: 'api', version: 'a7', environment: 'prod' });
    // w2 published the same content w1 did, so api a7's verification counts for it.
    expect(await client.canRelease({ app: 'web', version: 'w2', environment: 'prod' })).toMatchObject({ releasable: true });
    expect((await client.canRelease({ app: 'web', version: 'w3', environment: 'prod' })).releasable).toBe(false);
    await releaser.recordRelease({ app: 'web', version: 'w2', environment: 'prod' });
    expect((await viewer.contracts({ provider: 'api', environment: 'prod' })).map((c) => c.consumerVersion)).toEqual(['w2']);
    // As a provider: api a8 must satisfy web w2 (released to prod) before it can go out.
    expect((await client.canRelease({ app: 'api', version: 'a8', environment: 'prod' })).releasable).toBe(false);
    await client.recordVerification({ provider: 'api', providerVersion: 'a8', hash: p1.hash, passed: true, branch: 'main' });
    expect((await client.canRelease({ app: 'api', version: 'a8', environment: 'prod' })).releasable).toBe(true);
    expect((await client.releases()).map((r) => `${r.app}@${r.version}:${r.environment}`)).toEqual(['api@a7:prod', 'web@w2:prod']);
    const audit = await srv.req('GET', '/api/audit?project=shop', { token: await srv.token('auditor', [{ project: 'shop', role: 'approver' }]) });
    expect(audit.json.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['contract.publish', 'contract.verify', 'contract.release']));
    await expect(viewer.canRelease({ app: '../x', version: '1', environment: 'prod' })).rejects.toThrow(/Invalid app/);
  });
});

describe('results-server schema', () => {
  it('migrates a schema-1 database (before contracts) to schema 2 on open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-store-'));
    const file = join(dir, 'eztest.db');
    const fresh = await Store.open({ driver: 'sqlite', file });
    await fresh.run('INSERT INTO ez_projects (project, created_at) VALUES (?, ?)', ['kept', 'x']);
    for (const t of ['ez_contracts', 'ez_contract_verifications', 'ez_releases']) await fresh.run(`DROP TABLE ${t}`);
    await fresh.run("UPDATE ez_meta SET v = '1' WHERE k = 'schema'");
    await fresh.close();
    const upgraded = await Store.open({ driver: 'sqlite', file });
    try {
      expect(await upgraded.one("SELECT v FROM ez_meta WHERE k = 'schema'")).toEqual({ v: '2' });
      expect(await upgraded.all('SELECT * FROM ez_releases')).toEqual([]);
      expect(await upgraded.one('SELECT project FROM ez_projects')).toEqual({ project: 'kept' });
    } finally {
      await upgraded.close();
    }
  });
});

describe('contract readiness gates', () => {
  const run: RunResult = {
    runId: 'r1', startedAt: '', finishedAt: '', durationMs: 1, environment: {}, summary: { total: 1, passed: 1, passedHealed: 0, failed: 0, skipped: 0, errors: 0 },
    journeys: [{ journeyId: 'j1', name: 'J', status: 'passed', risk: 3, tags: [], requirements: [], steps: [], evidence: [], attempts: 1, startedAt: '', finishedAt: '', durationMs: 1 } as never],
  };
  const evidence = [{ id: 'E-1', kind: 'report' as const, path: 'contracts/api-coverage-1.json', sha256: 'x', createdAt: '' }];
  const report = (covered: number) => ({
    spec: { file: 's', title: 'Shop', version: '1' },
    totals: { operations: 5, coveredOperations: covered, operationRatio: covered / 5, statusCodes: 10, coveredStatusCodes: 5, statusRatio: 0.5, parameters: 2, coveredParameters: 2, parameterRatio: 1, calls: 3, unmatchedCalls: 0, violations: 0 },
    operations: [{ id: 'a', method: 'GET', path: '/a', tags: [], covered: true, calls: 1, statuses: { documented: [], covered: [], missing: [], seen: [], undocumented: [] }, parameters: { documented: [], exercised: [], missing: [] }, journeys: ['j1'], evidence: [], violations: 0 }, { id: 'b', method: 'GET', path: '/b', tags: [], covered: false, calls: 0, statuses: { documented: [], covered: [], missing: [], seen: [], undocumented: [] }, parameters: { documented: [], exercised: [], missing: [] }, journeys: [], evidence: [], violations: 0 }],
    unmatched: [],
  });

  it('apiCoverage passes, fails with the untested operations, or has no data', () => {
    expect(evaluateApiCoverageGate([{ report: report(5), evidence: ['E-1'] }], { minOperations: 0.8 }, new Set(['j1'])).status).toBe('pass');
    const f = evaluateApiCoverageGate([{ report: report(2), evidence: ['E-1'] }], { minOperations: 0.8, minStatusCodes: 0.6 }, new Set(['j1']));
    expect(f.status).toBe('fail');
    expect(f.summary).toMatch(/operations 2\/5 \(40\.0%\) below 80\.0%; untested: b\. Shop: status codes 5\/10 \(50\.0%\) below 60\.0%/);
    expect(evaluateApiCoverageGate(undefined, {}, new Set()).status).toBe('no-data');
  });

  it('feeds evaluateReadiness: a number shorthand, citations, and NO_GO from a failing contracts gate', () => {
    const r = evaluateReadiness({ version: 1, gates: { apiCoverage: 0.8, contracts: true }, scoring: { goMinScore: 90, noGoBelowScore: 50, healedPassCredit: 0.8, blockerPenalty: 30, riskPenalty: 10, waivedPenalty: 5 }, exceptions: [] }, {
      run, evidence: [...evidence, { id: 'E-2', kind: 'report', path: 'contracts/results-1.json', sha256: 'y', createdAt: '' }],
      apiCoverage: [{ report: report(5), evidence: ['E-1'] }],
      contracts: { verifications: [{ consumer: 'web', provider: 'api', passed: false, failed: ['get order: body $.id: is missing'] }], canRelease: { app: 'web', version: '1', environment: 'production', releasable: false, reason: '1 of 1 contract check(s) failed', checks: [] }, evidence: ['E-2'] },
    });
    expect(r.decision).toBe('NO_GO');
    expect(r.gates.map((g) => `${g.gate}:${g.status}`)).toEqual(['apiCoverage:pass', 'contracts:fail']);
    expect(r.gates[1].summary).toMatch(/contract web -> api failed verification \(get order: body \$\.id: is missing\); can-release web 1 to production: NO/);
    expect(r.gates[1].cites.evidence).toEqual(['E-2']);
    expect(evaluateContractsGate(undefined).status).toBe('no-data');
  });
});
