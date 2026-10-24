/**
 * Process workers (workers: process, docs/scale.md): journeys run in worker processes with their
 * own browsers. A journey that kills its process is an environment failure of that journey only:
 * the worker is replaced and the others finish; the evidence chain of the run stays valid; a
 * CPU-bound code step blocks only its own worker. Through the engine: Setup: run-wide values,
 * Depends on: handoff, the shared store and its pools, and pipeline outputs work across workers.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { verifyEvidence, flattenStepResults, type Journey, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { loadCodeJourneys, runJourneys } from '../../src/runner/index.js';
import { planTransfer } from '../../src/runner/workers/protocol.js';
import { FileStoreBackend, SharedStore } from '../../src/store/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { BOB_ORDER_EZ, FAST, runDirOf, tempDir } from './fixtures.js';

let server: DemoServer;
let code: Journey[];
beforeAll(async () => {
  server = await startDemoApp({ variant: 'a' });
  code = await loadCodeJourneys(resolve(__dirname, 'fixtures/workers/crash.journey.ts'), { cwd: await tempDir('workers-cache') });
});
afterAll(async () => {
  await server.close();
});

const bob = (n: number): Journey => ({ ...parseEzScript(BOB_ORDER_EZ), id: `bob-${n}`, name: `Bob order ${n}` });
const byId = (r: RunResult, id: string) => r.journeys.find((j) => j.journeyId === id)!;
const steps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

describe('process workers (real Chromium, demo app)', () => {
  it('a journey that aborts its process is an environment failure; the worker restarts and the run completes with a valid evidence chain', async () => {
    const out = await tempDir('workers-crash');
    const journeys = [bob(1), code.find((j) => j.id === 'crashes')!, bob(2), bob(3), code.find((j) => j.id === 'burns')!, bob(4)];
    const run = await runJourneys(journeys, { ...FAST, baseUrl: server.url, outputDir: out, concurrency: 3, workers: 'process', screenshots: 'on-failure' });
    for (const n of [1, 2, 3, 4]) expect(byId(run, `bob-${n}`).status, steps(byId(run, `bob-${n}`))).toBe('passed');
    expect(byId(run, 'burns').status).toBe('passed');
    const crashed = byId(run, 'crashes');
    expect(crashed.status).toBe('error');
    expect(crashed.error).toMatchObject({ name: 'WorkerCrashed' });
    expect(crashed.error!.message).toMatch(/worker process running the journey crashed \(signal SIGABRT\)/);
    expect(crashed.reliability?.environment?.reason).toMatch(/worker process crashed/);
    expect(crashed.evidence.length).toBe(1);
    expect(run.environment.workers).toMatch(/^3 processes, 1 restarted after a crash$/);
    const dir = runDirOf(out, run);
    const v = await verifyEvidence(dir);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(run.evidenceHead).toBe(v.head);
    // The crash note is evidence of the crashed journey; each order's invoice download is evidence of its own journey.
    const manifest = (await readFile(join(dir, 'evidence-manifest.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { journeyId?: string; kind: string; path: string });
    expect(manifest.filter((e) => e.journeyId === 'crashes').map((e) => e.path)).toEqual(['journeys/crashes/worker-crash.txt']);
    for (const n of [1, 2, 3, 4]) expect(manifest.filter((e) => e.journeyId === `bob-${n}` && e.kind === 'download').length).toBe(1);
    expect(new Set(manifest.map((e) => e.path)).size).toBe(manifest.length);
  }, 180_000);

  it('a run that cannot rebuild its handlers in a worker stays inline and says why', async () => {
    const out = await tempDir('workers-inline');
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (m: string) => void warnings.push(m) };
    const run = await runJourneys([bob(9)], { ...FAST, baseUrl: server.url, outputDir: out, workers: 'process', logger, customSteps: { 'my step': async () => undefined } });
    expect(run.journeys[0].status).toBe('passed');
    expect(run.environment.workers).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/process workers not used, journeys run inline: these run options cannot be rebuilt in a worker process: customSteps/);
    expect(planTransfer({ outputDir: 'x', baseUrl: 'y', concurrency: 2, events: undefined, customSteps: {} }).blocked).toEqual([]);
  }, 60_000);
});

describe('process workers through the engine', () => {
  it('Setup: values, Depends on: handoff, shared-store pools and pipeline outputs work across worker processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-workers-engine-'));
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ outputDir: 'results', healing: { enabled: false }, environment: 'sit', concurrency: 3, workers: 'process', store: { pipelineOutputs: true } }));
    const seed = new SharedStore({ backend: new FileStoreBackend(join(dir, '.eztest', 'store')), namespace: 'sit', env: {} });
    await seed.poolAdd('accounts', ['A-1', 'A-2', 'A-3', 'A-4']);
    const scripts = [
      'Setup: Seed reference data\nId: seed\nReturns: tenant\n\nSet variable tenant to "T-42"\n',
      'Journey: Creates an order\nId: create\nReturns: orderNumber\n\nSet variable orderNumber to "ORD-${tenant}"\n',
      'Journey: Approves it\nId: approve\nDepends on: create with orderNumber\n\nExpect the expression "orderNumber == \'ORD-T-42\'" is true\nSave ${orderNumber} to the shared store as "approved" for the pipeline\n',
      ...[1, 2, 3].map((i) => `Journey: Uses an account ${i}\nId: account-${i}\n\nExpect the expression "tenant == 'T-42'" is true\nTake one item from pool "accounts" as acc\nSave \${acc} to the shared store as "acc-${i}"\n`),
      'Teardown: Clean up\nId: clean\n\nSave ${tenant} to the shared store as "cleaned"\n',
    ];
    const lines: string[] = [];
    const engine = await createEngine(await loadConfig({ cwd: dir, environment: {} }), { cwd: dir, runOptions: { stepTimeoutMs: 10_000, screenshots: 'off' }, pipelineOut: (l) => lines.push(l) });
    let r: RunResult;
    try {
      r = await engine.run(scripts.map((s) => parseEzScript(s)));
    } finally {
      await engine.close();
    }
    expect(r.journeys.map((j) => `${j.journeyId}:${j.status}`).sort()).toEqual(['account-1:passed', 'account-2:passed', 'account-3:passed', 'approve:passed', 'clean:passed', 'create:passed', 'seed:passed']);
    expect(byId(r, 'approve').reliability?.dependsOn?.[0]).toMatchObject({ journeyId: 'create', status: 'passed', handoff: ['orderNumber'] });
    expect(r.environment.workers).toBe('3 processes');
    const taken = await Promise.all([1, 2, 3].map(async (i) => (await seed.load(`acc-${i}`)).value));
    expect(new Set(taken).size).toBe(3);
    expect((await seed.count('accounts')).claimed).toBe(0);
    expect((await seed.load('cleaned')).value).toBe('T-42');
    const exp = JSON.parse(await readFile(join(dir, 'results', r.runId, 'store-export.json'), 'utf8')) as { entries: Array<{ key: string; value: unknown }> };
    expect(exp.entries.map((e) => `${e.key}=${String(e.value)}`)).toEqual(['approved=ORD-T-42']);
    expect((await verifyEvidence(join(dir, 'results', r.runId))).ok).toBe(true);
  }, 180_000);
});
