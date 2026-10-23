/**
 * Shared test data end to end through the engine (real browser contexts, the
 * .ez grammar): a value saved by one run is loaded by the next; parallel
 * workers of one run claim pool items without duplicates and a failing
 * journey gives its item back; Setup:/Teardown: journeys hand run-wide values
 * to every journey; secrets never reach the run results in clear text; the
 * results-server backend shares values and pools across "machines" (separate
 * projects on disk) with RBAC and the audit log.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { flattenStepResults, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { loadCodeJourneys } from '../../src/runner/code-journeys.js';
import { ResultsClient } from '../../src/server/index.js';
import { FileStoreBackend, ServerStoreBackend, SharedStore } from '../../src/store/index.js';
import { startTestServer, type TestServer } from '../server/helpers.js';

const KEY = 'store-key-for-tests-0123456789abcdef';

async function project(extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ez-store-e2e-'));
  await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ outputDir: 'results', healing: { enabled: false }, environment: 'sit', ...extra }));
  return dir;
}

async function run(dir: string, scripts: string[], o: { concurrency?: number; env?: Record<string, string>; out?: string[] } = {}): Promise<RunResult> {
  const engine = await createEngine(await loadConfig({ cwd: dir, environment: { ...o.env } }), {
    cwd: dir, runOptions: { stepTimeoutMs: 10_000, concurrency: o.concurrency ?? 1, screenshots: 'off' }, pipelineOut: (l) => o.out?.push(l),
  });
  try {
    return await engine.run(scripts.map((s) => parseEzScript(s)));
  } finally {
    await engine.close();
  }
}

const steps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');
const byId = (r: RunResult, id: string) => r.journeys.find((j) => j.journeyId === id)!;

describe('shared store through the engine (file backend)', () => {
  it('a value saved in one run is loaded in the next; a missing one fails clearly', async () => {
    const dir = await project();
    const r1 = await run(dir, [`Journey: Create order\nId: create\n\nSet variable orderId to "ORD-7"\nSave \${orderId} to the shared store as "pending-order" for 2 days\n`]);
    expect(steps(r1.journeys[0])).not.toMatch(/failed/);
    const r2 = await run(dir, [
      `Journey: Approve order\nId: approve\n\nLoad "pending-order" from the shared store as orderId\nExpect the expression "orderId == 'ORD-7'" is true\nDelete "pending-order" from the shared store\n`,
      `Journey: Missing value\nId: missing\n\nLoad "never-saved" from the shared store as x\n`,
      `Journey: Default value\nId: dflt\n\nLoad "never-saved" from the shared store as x or use "fallback"\nExpect the expression "x == 'fallback'" is true\n`,
    ]);
    expect(byId(r2, 'approve').status).toBe('passed');
    expect(byId(r2, 'missing').status).toBe('failed');
    expect(steps(byId(r2, 'missing'))).toMatch(/No "never-saved" in namespace "sit" of the shared store \(file: .*\.eztest\/store\)/);
    expect(byId(r2, 'dflt').status).toBe('passed');
    expect(JSON.parse(await readFile(join(dir, '.eztest', 'store', 'sit', 'values.json'), 'utf8')).entries).toEqual({});
  }, 120_000);

  it('parallel workers claim pool items without duplicates; a failed journey gives its item back', async () => {
    const dir = await project();
    const seed = new SharedStore({ backend: new FileStoreBackend(join(dir, '.eztest', 'store')), namespace: 'sit', env: {} });
    await seed.poolAdd('approvable-policies', ['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6']);
    const journeys = [1, 2, 3, 4].map((i) => `Journey: Approve ${i}\nId: approve-${i}\n\nExpect pool "approvable-policies" has at least 1 items\nTake one item from pool "approvable-policies" as policy\nSave \${policy} to the shared store as "taken-${i}"\n`);
    journeys.push('Journey: Fails after taking\nId: fails\n\nTake one item from pool "approvable-policies" as policy\nSave ${policy} to the shared store as "taken-by-failure"\nExpect the expression "1 == 2" is true\n');
    const r = await run(dir, journeys, { concurrency: 4 });
    for (const i of [1, 2, 3, 4]) expect(steps(byId(r, `approve-${i}`))).not.toMatch(/failed/);
    expect(byId(r, 'fails').status).toBe('failed');
    const taken = await Promise.all([1, 2, 3, 4].map(async (i) => (await seed.load(`taken-${i}`)).value));
    expect(new Set(taken).size).toBe(4);
    const failedItem = (await seed.load('taken-by-failure')).value;
    // 6 items - 4 consumed by passing journeys; the failed journey's item is back in the pool.
    const left = (await seed.backend.poolItems('sit', 'approvable-policies')).map((x) => x.value);
    expect(left.length).toBe(2);
    expect(left).toContain(failedItem);
    expect(left.every((x) => !x || !taken.includes(x))).toBe(true);
    expect((await seed.count('approvable-policies')).claimed).toBe(0);
  }, 120_000);

  it('Setup: Returns become run-wide values for every journey and the Teardown:', async () => {
    const dir = await project();
    const r = await run(dir, [
      'Setup: Seed reference data\nId: seed\nReturns: tenant\n\nSet variable tenant to "T-42"\n',
      'Journey: Uses tenant A\nId: a\nTags: @smoke\n\nExpect the expression "tenant == \'T-42\'" is true\n',
      'Journey: Uses tenant B\nId: b\n\nExpect the expression "tenant == \'T-42\'" is true\n',
      'Teardown: Clean up\nId: clean\n\nSave ${tenant} to the shared store as "cleaned-tenant"\n',
    ], { concurrency: 2 });
    expect(r.journeys.map((j) => `${j.journeyId}:${j.status}`)).toEqual(['seed:passed', 'a:passed', 'b:passed', 'clean:passed']);
    expect(byId(r, 'seed').tags).toContain('beforeAll');
    expect(byId(r, 'clean').tags).toContain('afterAll');
    expect(r.summary.total).toBe(4);
    const s = new SharedStore({ backend: new FileStoreBackend(join(dir, '.eztest', 'store')), namespace: 'sit', env: {} });
    expect((await s.load('cleaned-tenant')).value).toBe('T-42');
  }, 120_000);

  it('secret values are masked in the run results and pipeline values are exported', async () => {
    // The secret comes from the environment (as a CI secret would), never from the journey text.
    const dir = await project({ vars: { token: '${E2E_TOKEN}' } });
    const out: string[] = [];
    const r = await run(dir, [
      'Journey: Saves a secret\nId: secret\n\nSave ${token} to the shared store as "api-token" as a secret for the pipeline\nLoad "api-token" from the shared store as again\nExpect the expression "again == token" is true\n',
    ], { env: { EZTEST_STORE_KEY: KEY, TF_BUILD: 'True', E2E_TOKEN: 'tok-E2E-secret-77' }, out });
    expect(steps(r.journeys[0])).not.toMatch(/failed/);
    const runDir = join(dir, 'results', r.runId);
    const runJson = await readFile(join(runDir, 'run.json'), 'utf8');
    expect(runJson).not.toContain('tok-E2E-secret-77');
    expect(runJson).toContain('****');
    expect(await readFile(join(dir, '.eztest', 'store', 'sit', 'values.json'), 'utf8')).not.toContain('tok-E2E-secret-77');
    expect(out).toEqual(['##vso[task.setvariable variable=api_token;isOutput=true;issecret=true]tok-E2E-secret-77']);
    expect(await readFile(join(runDir, 'store-export.json'), 'utf8')).not.toContain('tok-E2E-secret-77');
  }, 120_000);
});

describe('shared store from code journeys (SDK)', () => {
  it('store.save, store.load, store.claim and store.add run as steps', async () => {
    const dir = await project();
    await mkdir(join(dir, 'journeys'), { recursive: true });
    const sdkUrl = new URL('../../src/sdk/index.ts', import.meta.url).href;
    await writeFile(join(dir, 'journeys', 'store.journey.mjs'), `import { journey, store, expect } from ${JSON.stringify(sdkUrl)};
journey('Uses the store from code', async () => {
  await store.add('accounts', { user: 'a1' }, { user: 'a2' });
  const acc = await store.claim('accounts');
  await store.save('claimed-account', acc, { ttl: '1 day', namespace: 'sit' });
  const again = await store.load('claimed-account');
  expect(again).toEqual(acc);
  expect(await store.load('nope', { default: 'dflt' })).toBe('dflt');
  expect(await store.available('accounts')).toBe(1);
  await store.delete('claimed-account');
});
`);
    const journeys = await loadCodeJourneys(join(dir, 'journeys', 'store.journey.mjs'), { cwd: dir });
    const engine = await createEngine(await loadConfig({ cwd: dir, environment: {} }), { cwd: dir, runOptions: { screenshots: 'off' } });
    let r: RunResult;
    try {
      r = await engine.run(journeys);
    } finally {
      await engine.close();
    }
    expect(steps(r.journeys[0])).not.toMatch(/failed/);
    expect(r.journeys[0].status).toBe('passed');
    expect(flattenStepResults(r.journeys[0].steps).map(({ result: x }) => x.intent)).toEqual(expect.arrayContaining(['Take one item from pool "accounts"', 'Load "claimed-account" from the shared store']));
    const s = new SharedStore({ backend: new FileStoreBackend(join(dir, '.eztest', 'store')), namespace: 'sit', env: {} });
    // The journey passed: its claimed account is consumed, the other stays.
    expect((await s.backend.poolItems('sit', 'accounts')).map((i) => i.value)).toHaveLength(1);
  }, 120_000);
});

describe('shared store on the results server', () => {
  let s: TestServer;
  let tester: string;
  let viewer: string;
  beforeAll(async () => {
    s = await startTestServer();
    tester = await s.token('ci', [{ project: 'payments', role: 'tester' }]);
    viewer = await s.token('viewer', [{ project: 'payments', role: 'viewer' }]);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });
  const server = () => ({ server: { url: s.url, token: '${EZTEST_SERVER_TOKEN}', project: 'payments', sharedState: false } });

  it('hands a value from a run on one machine to a run on another, audited', async () => {
    const machineA = await project(server());
    const machineB = await project(server());
    const r1 = await run(machineA, ['Journey: Create\nId: create\n\nSet variable orderId to "ORD-SRV-1"\nSave ${orderId} to the shared store as "pending-order" for 1 day\n'], { env: { EZTEST_SERVER_TOKEN: tester } });
    expect(steps(r1.journeys[0])).not.toMatch(/failed/);
    const r2 = await run(machineB, ['Journey: Approve\nId: approve\n\nLoad "pending-order" from the shared store as orderId\nExpect the expression "orderId == \'ORD-SRV-1\'" is true\n'], { env: { EZTEST_SERVER_TOKEN: tester } });
    expect(steps(r2.journeys[0])).not.toMatch(/failed/);
    const audit = await s.req('GET', '/api/audit?project=payments', { token: (await s.token('appr', [{ project: 'payments', role: 'approver' }])) });
    expect(audit.json.map((e: { action: string }) => e.action)).toContain('store.save');
    // Viewers read but cannot write.
    const v = new ResultsClient({ url: s.url, token: viewer, project: 'payments' });
    expect((await v.storeGet('sit', 'pending-order'))?.value).toBe('ORD-SRV-1');
    await expect(v.storePut({ namespace: 'sit', key: 'x', value: 1, createdAt: '', updatedAt: '' })).rejects.toThrow(/403|does not allow store.write/);
  }, 120_000);

  it('two machines claim from one pool atomically; secrets never reach the server in clear text', async () => {
    const a = new SharedStore({ backend: new ServerStoreBackend(new ResultsClient({ url: s.url, token: tester, project: 'payments' })), namespace: 'sit', env: { EZTEST_STORE_KEY: KEY } });
    const b = new SharedStore({ backend: new ServerStoreBackend(new ResultsClient({ url: s.url, token: tester, project: 'payments' })), namespace: 'sit', env: { EZTEST_STORE_KEY: KEY } });
    await a.poolAdd('accounts', Array.from({ length: 30 }, (_, i) => `ACC-${i}`));
    const claimAll = async (st: SharedStore, who: string) => {
      const got: string[] = [];
      for (let i = 0; ; i++) {
        try {
          got.push(String((await st.take('accounts', `${who}#${i}`)).value));
        } catch {
          return got;
        }
      }
    };
    const [x, y] = await Promise.all([claimAll(a, 'a'), claimAll(b, 'b')]);
    expect(x.length + y.length).toBe(30);
    expect(new Set([...x, ...y]).size).toBe(30);
    expect((await a.count('accounts')).available).toBe(0);
    await a.save('db-password', 'pw-SERVER-secret-9', { secret: true });
    expect((await b.load('db-password')).value).toBe('pw-SERVER-secret-9');
    const raw = await s.req('GET', '/api/projects/payments/store/sit/db-password', { token: tester });
    expect(raw.text).not.toContain('pw-SERVER-secret-9');
    expect(raw.json).toMatchObject({ secret: true, sealed: expect.stringMatching(/^EZS1:/) });
    const plain = await s.req('PUT', '/api/projects/payments/store/sit/bad', { token: tester, body: { secret: true, value: 'plain' } });
    expect(plain.status).toBe(400);
    const db = await readFile(join(s.dataDir, 'eztest.db'));
    expect(db.includes(Buffer.from('pw-SERVER-secret-9'))).toBe(false);
  }, 120_000);
});
