import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventBus, verifyEvidence, type EzEvent, type RunResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { createHealer } from '../../src/heal/index.js';
import { DEMO_CLIENT, startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { FAST, bobOrderJourney, demoDb, manifest, runDirOf, tempDir } from './fixtures.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp({ variant: 'a' });
});
afterAll(async () => {
  await server.close();
});

const LOGIN = `Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
  Expect the URL contains "/dashboard"`;

describe('runJourneys (real Chromium, demo app)', () => {
  it('bob logs in, creates an order, captures the order number and downloads the invoice', async () => {
    const out = await tempDir('runner');
    const events: EzEvent[] = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));
    const run = await runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir: out, events: bus, screenshots: 'every-step', trace: true });
    const j = run.journeys[0];
    expect(j.steps.map((s) => `${s.stepId}:${s.status}:${s.error?.message ?? ''}`)).toEqual(j.steps.map((s) => `${s.stepId}:passed:`));
    expect(j.status).toBe('passed');
    expect(run.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(String(j.ledger.orderNumber)).toMatch(/^ORD-\d+$/);
    const capture = j.steps.find((s) => s.stepId.startsWith('capture'))!;
    expect(capture.captured).toEqual({ orderNumber: j.ledger.orderNumber });
    expect(capture.conditions[0]).toMatchObject({ passed: true });

    const dir = runDirOf(out, run);
    const entries = await manifest(dir);
    const kinds = new Set(entries.map((e) => e.kind));
    for (const k of ['screenshot', 'download', 'console', 'network', 'trace']) expect(kinds.has(k as never)).toBe(true);
    const dl = j.ledger.invoice as { evidenceId: string; filename: string; size: number };
    expect(dl.filename).toMatch(/^INV-\d+\.pdf$/);
    expect(dl.size).toBeGreaterThan(500);
    expect(entries.find((e) => e.id === dl.evidenceId)?.kind).toBe('download');
    const pdf = await readFile(join(dir, entries.find((e) => e.id === dl.evidenceId)!.path));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const v = await verifyEvidence(dir);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(run.evidenceHead).toBe(v.head);
    const saved = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult;
    expect(saved.runId).toBe(run.runId);
    // Fingerprints and last-good locators were stored for healing next time.
    const store = JSON.parse(await readFile(run.environment.fingerprintStore, 'utf8')) as { steps: Record<string, { fingerprint?: { id?: string }; lastGood?: unknown }> };
    expect(store.steps['bob-order/click-the-sign-in-button'].fingerprint?.id).toBe('login-btn');
    expect(store.steps['bob-order/click-the-sign-in-button'].lastGood).toMatchObject({ strategy: 'role', value: 'button', name: 'Sign in' });
    // Events
    expect(events[0]).toEqual({ type: 'run:start', runId: run.runId });
    expect(events.at(-1)).toEqual({ type: 'run:end', runId: run.runId });
    expect(events.filter((e) => e.type === 'step:end')).toHaveLength(j.steps.length);
    // A row was really written.
    const n = (server.db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
    expect(n).toBeGreaterThan(0);
  });

  it('a failing assertion fails the journey with screenshot, aria and html evidence', async () => {
    const out = await tempDir('runner-fail');
    const j = parseEzScript(`Journey: Failing check\nOpen /login\nAssert that page contains "Welcome back, admiral"\nClick the "Sign in" button`);
    const run = await runJourneys([j], { ...FAST, conditionTimeoutMs: 800, baseUrl: server.url, outputDir: out });
    const jr = run.journeys[0];
    expect(jr.status).toBe('failed');
    expect(run.summary.failed).toBe(1);
    const failed = jr.steps[1];
    expect(failed.status).toBe('failed');
    expect(failed.conditions[0]).toMatchObject({ passed: false });
    expect(failed.error?.message).toContain('Welcome back, admiral');
    expect(jr.steps[2].status).toBe('skipped');
    const entries = await manifest(runDirOf(out, run));
    const stepKinds = entries.filter((e) => failed.evidence.includes(e.id)).map((e) => e.kind).sort();
    expect(stepKinds).toEqual(['aria', 'dom', 'screenshot']);
    expect((await verifyEvidence(runDirOf(out, run))).ok).toBe(true);
  });

  it('an assert step with no post-conditions fails (nothing passes on empty input)', async () => {
    const out = await tempDir('runner-empty');
    const run = await runJourneys(
      [{ id: 'empty', name: 'Empty assert', tags: [], data: [], variables: {}, requirements: [], risk: 3, lenses: [],
        steps: [{ id: 'a', intent: 'Assert nothing', action: 'assert', postconditions: [], optional: false }] }],
      { ...FAST, baseUrl: server.url, outputDir: out, screenshots: 'off' },
    );
    expect(run.journeys[0].steps[0].status).toBe('failed');
    expect(run.journeys[0].steps[0].error?.message).toMatch(/no post-conditions/);
  });

  it('strict locators: a description matching two elements is ambiguous and never "first match"', async () => {
    const out = await tempDir('runner-strict');
    const j = parseEzScript(`Journey: Ambiguous\n${LOGIN}\nClick the "New order" link\n  Expect the URL contains "/orders/new"`);
    const run = await runJourneys([j], { ...FAST, baseUrl: server.url, outputDir: out, healer: createHealer() });
    const step = run.journeys[0].steps[4];
    expect(step.status).toBe('failed');
    expect(step.error?.message).toContain('2 matches (ambiguous, skipped)');
    expect(step.error?.message).toMatch(/T2-semantic: ambiguous/);
    expect(step.heal).toBeUndefined();
  });

  it('api steps use the injected auth provider; missing auth or bad status fails', async () => {
    const out = await tempDir('runner-api');
    let tokenCalls = 0;
    const apiAuth = async () => {
      tokenCalls++;
      const res = await fetch(`${server.url}/api/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: DEMO_CLIENT.id, client_secret: DEMO_CLIENT.secret }),
      });
      const { access_token } = (await res.json()) as { access_token: string };
      return { authorization: `Bearer ${access_token}` };
    };
    const ok = parseEzScript(`Journey: API customers\nCall API "GET /api/customers" as manager and store as customers\n  Expect response customers status is 200`);
    const run = await runJourneys([ok], { ...FAST, baseUrl: server.url, outputDir: out, apiAuth });
    const s = run.journeys[0].steps[0];
    expect(s.status).toBe('passed');
    expect(tokenCalls).toBe(1);
    const body = (run.journeys[0].ledger.customers as { body: Array<{ name: string }> }).body;
    expect(body.map((c) => c.name)).toContain('Contoso Ltd');

    const noAuth = parseEzScript(`Journey: API no auth\nCall API "GET /api/customers" as manager and store as customers`);
    const r2 = await runJourneys([noAuth], { ...FAST, baseUrl: server.url, outputDir: out });
    expect(r2.journeys[0].steps[0].error?.message).toMatch(/needs an apiAuth provider/);

    const anon = parseEzScript(`Journey: API anonymous\nCall API "GET /api/customers" and store as customers`);
    const r3 = await runJourneys([anon], { ...FAST, baseUrl: server.url, outputDir: out });
    expect(r3.journeys[0].steps[0].status).toBe('failed');
    expect(r3.journeys[0].steps[0].error?.message).toMatch(/returned 401/);
  });

  it('db steps query the demo sqlite database through the injected handler', async () => {
    const out = await tempDir('runner-db');
    const j = parseEzScript(`Journey: DB check
Run query "SELECT name FROM customers WHERE region = ? ORDER BY id" on demo with params '["EU"]' as eu
  Expect query eu returns 2 rows
Verify \${eu.0.name} equals "Contoso Ltd"`);
    const run = await runJourneys([j], { ...FAST, baseUrl: server.url, outputDir: out, db: demoDb(server) });
    expect(run.journeys[0].steps.map((s) => s.status)).toEqual(['passed']);
    expect(run.journeys[0].steps[0].conditions.map((c) => [c.condition.type, c.passed])).toEqual([['dbRowCount', true], ['ledgerEquals', true]]);
    expect(run.journeys[0].ledger.eu).toEqual([{ name: 'Contoso Ltd' }, { name: 'Northwind Traders' }]);

    const noHandler = await runJourneys([j], { ...FAST, baseUrl: server.url, outputDir: out });
    expect(noHandler.journeys[0].steps[0].error?.message).toMatch(/No db handler configured/);
  });

  it('login, custom and data steps call injected handlers; unconfigured ones fail clearly', async () => {
    const out = await tempDir('runner-handlers');
    const j = parseEzScript(`Journey: Handlers
Use data Customer as buyer where region=EU
Log in as manager
  Expect the URL contains "/dashboard"
Run step "stamp" with label=hello
Verify \${stamp} equals "hello-Contoso Ltd"`);
    const run = await runJourneys([j], {
      ...FAST, baseUrl: server.url, outputDir: out,
      data: async (need) => {
        expect(need).toMatchObject({ entity: 'Customer', as: 'buyer', where: { region: 'EU' } });
        return server.db.prepare('SELECT * FROM customers WHERE region = ? ORDER BY id LIMIT 1').get(need.where.region) as Record<string, unknown>;
      },
      login: async (page, role) => {
        expect(role).toBe('manager');
        await page.goto(`${server.url}/login`);
        await page.fill('#username', 'bob');
        await page.fill('#password', 'Builder#2');
        await page.click('button[type=submit]');
      },
      customSteps: { stamp: async (_page, step, ctx) => ({ stamp: `${String(step.args?.label)}-${ctx.interpolate('${buyer.name}')}` }) },
    });
    // The Verify line is a post-condition of the custom step it follows.
    expect(run.journeys[0].steps.map((s) => `${s.status}${s.error ? ' ' + s.error.message : ''}`)).toEqual(['passed', 'passed', 'passed']);
    expect(run.journeys[0].steps[2].conditions[0]).toMatchObject({ passed: true, actual: 'hello-Contoso Ltd' });

    const bare = await runJourneys([parseEzScript('Journey: No login handler\nLog in as manager')], { ...FAST, baseUrl: server.url, outputDir: out });
    expect(bare.journeys[0].steps[0].error?.message).toMatch(/No login handler configured/);
  });

  it('runs journeys concurrently in separate contexts and retries failures with attempt numbers', async () => {
    const out = await tempDir('runner-conc');
    let calls = 0;
    const flaky = parseEzScript('Journey: Flaky\nRun step "flaky"');
    const other = parseEzScript(`Journey: Login only\n${LOGIN}`);
    const run = await runJourneys([flaky, other], {
      ...FAST, baseUrl: server.url, outputDir: out, concurrency: 2, retries: 1,
      customSteps: { flaky: async () => { calls++; if (calls === 1) throw new Error('first time fails'); } },
    });
    expect(run.journeys.map((j) => [j.journeyId, j.status, j.attempt])).toEqual([['flaky', 'passed', 2], ['login-only', 'passed', 1]]);
    expect(existsSync(join(out, run.runId, 'run.json'))).toBe(true);
  });
});
