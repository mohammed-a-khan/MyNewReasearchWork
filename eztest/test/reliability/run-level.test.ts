/**
 * Run-level reliability (real Chromium, demo app /rel pages): flaky retries
 * with a classified root cause, environment health and the circuit breaker,
 * data preconditions, dependencies with ledger handoff, mid-journey session
 * expiry, failure diagnosis, context reuse, locale/time and locator improvements.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '../../src/browser/index.js';
import type { RunResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { triageRun } from '../../src/insights/index.js';
import { collectHealProposals } from '../../src/heal/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { demoDb, manifest, tempDir } from '../runner/fixtures.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

const FAST: Partial<RunOptions> = { stepTimeoutMs: 2500, locateTimeoutMs: 1200, conditionTimeoutMs: 1200 };

async function run(ez: string[] | string, extra: Partial<RunOptions> = {}): Promise<RunResult & { dir: string }> {
  const out = await tempDir('rel-run');
  const list = (Array.isArray(ez) ? ez : [ez]).map((t) => parseEzScript(t));
  const r = await runJourneys(list, { baseUrl: server.url, outputDir: out, ...FAST, ...extra });
  return Object.assign(r, { dir: join(out, r.runId) });
}

describe('flaky retries carry their root cause', () => {
  it('an overlay on the first attempt: passed on retry, cause "overlay", evidence written', async () => {
    const r = await run('Journey: Overlay once\nId: overlay-once\nOpen /rel/overlay?ms=never&once=ov1\nClick the "Save" button\n  Expect the page contains "Saved"\n', { retries: 1 });
    const j = r.journeys[0];
    expect(j.status).toBe('passed');
    expect(j.attempt).toBe(2);
    expect(j.reliability?.flake).toMatchObject({ cause: 'overlay', failedAttempt: 1, failedStepId: j.steps[1].stepId });
    const ev = (await manifest(r.dir)).find((e) => e.id === j.reliability!.flake!.evidence[0]);
    expect(ev?.path).toMatch(/flake-cause\.json$/);
    const saved = JSON.parse(await readFile(join(r.dir, ev!.path), 'utf8'));
    expect(saved.failedAttempts[0].steps[0].error.message).toMatch(/covered by/);
  });

  it('a 503 on the first attempt: cause "network"', async () => {
    const r = await run('Journey: 503 once\nOpen /rel/env/page?fail=503&once=n1\nClick the "Go" button\n  Expect the page contains "Went"\n', { retries: 1 });
    expect(r.journeys[0].status).toBe('passed');
    expect(r.journeys[0].reliability?.flake?.cause).toBe('network');
    expect(r.journeys[0].reliability?.flake?.reason).toMatch(/HTTP 503/);
  });
});

describe('with resource locks and isolated retries', () => {
  it('dependencies, flake classification and the lock queue work together', async () => {
    const held = new Set<string>();
    let maxParallel = 0;
    const locks: RunOptions['locks'] = {
      pollMs: 20,
      async tryAcquire(j) {
        const key = j.tags.includes('shared') ? 'shared' : j.id;
        if (held.has(key)) return undefined;
        held.add(key);
        maxParallel = Math.max(maxParallel, [...held].length);
        return async () => void held.delete(key);
      },
    };
    const r = await run([
      'Journey: Uses total\nId: uses\nTags: @shared\nDepends on: prereq with total\nOpen /rel/slow?ms=0\n  Expect ${total} == "42.50"\n',
      'Journey: Prerequisite\nId: prereq\nTags: @shared\nOpen /rel/overlay?ms=never&once=lq1\nClick the "Save" button\n  Expect the page contains "Saved"\nOpen /rel/slow?ms=0\nCapture the text of testid=basket-total as total\n  Expect ${total} == "42.50"\n',
      'Journey: Independent\nId: independent\nOpen /rel/overlay?ms=never&once=lq2\nClick the "Save" button\n  Expect the page contains "Saved"\n',
    ], { concurrency: 3, retries: 1, retryStrategy: 'isolated', locks, reliability: { appIdle: true } });
    const by = Object.fromEntries(r.journeys.map((j) => [j.journeyId, j]));
    // The prerequisite was retried inline (its dependent needs its final result) and is classified as flaky.
    expect(by.prereq).toMatchObject({ status: 'passed', attempt: 2, reliability: { flake: { cause: 'overlay' } } });
    expect(by.uses).toMatchObject({ status: 'passed', ledger: { total: '42.50' } });
    expect(by.uses.reliability?.dependsOn).toEqual([{ journeyId: 'prereq', status: 'passed', handoff: ['total'] }]);
    // The independent journey was retried in isolation after the main pass, and classified too.
    expect(by.independent).toMatchObject({ status: 'passed', attempt: 2, reliability: { flake: { cause: 'overlay' } } });
    expect(held.size).toBe(0);
  });
});

describe('environment health', () => {
  it('a failing pre-flight check stops the run as an environment problem (nothing runs)', async () => {
    server.rel.envUp = false;
    try {
      const t0 = Date.now();
      const r = await run(['Journey: A\nOpen /rel/env/a\n', 'Journey: B\nOpen /rel/env/b\n'], { healthChecks: [{ name: 'app', url: '/rel/env/health' }, { name: 'db', db: 'demo' }], db: demoDb(server) });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.health?.preflight?.ok).toBe(false);
      expect(r.health?.preflight?.checks.map((c) => `${c.name}:${c.ok}`)).toEqual(['app:false', 'db:true']);
      expect(r.summary).toMatchObject({ total: 2, skipped: 2, failed: 0 });
      expect(r.journeys[0].error?.message).toMatch(/^not run: environment unavailable \(pre-flight health check failed: app: HTTP 503/);
    } finally {
      server.rel.envUp = true;
    }
  });

  it('the circuit breaker stops the run when the environment goes down mid-run', async () => {
    server.rel.envUp = true;
    const page = (n: number, then = '') => `Journey: Env ${n}\nId: env-${n}\nOpen /rel/env/p${n}${then}\nClick the "Go" button\n  Expect the page contains "Went"\n`;
    try {
      const r = await run([page(1, '?then=down'), page(2), page(3), page(4), page(5), page(6)], { circuitBreaker: { threshold: 2 }, healthChecks: [{ name: 'app', url: '/rel/env/health' }] });
      expect(r.health?.preflight?.ok).toBe(true);
      const statuses = r.journeys.map((j) => `${j.journeyId}:${j.status}`);
      expect(statuses).toEqual(['env-1:passed', 'env-2:failed', 'env-3:failed', 'env-4:skipped', 'env-5:skipped', 'env-6:skipped']);
      expect(r.journeys[1].reliability?.environment?.reason).toMatch(/HTTP 503/);
      expect(r.journeys[3].error?.message).toMatch(/^not run: environment unavailable/);
      expect(r.health?.circuit).toMatchObject({ afterJourney: 'env-3', notRun: 3 });
      // Triage: environment, not product bugs.
      const ev = await manifest(r.dir);
      const t = triageRun({ run: r, evidence: ev });
      expect(t.verdicts.map((v) => v.category)).toEqual(['environment', 'environment']);
    } finally {
      server.rel.envUp = true;
    }
  });
});

describe('data preconditions (Requires:)', () => {
  it('a missing data state is a data problem: steps not run, triage "data"', async () => {
    const r = await run(`Journey: Needs XX customers\nRequires: db demo "SELECT id FROM customers WHERE region = 'XX'" has rows; variable PAYMENT_KEY\nOpen /rel/customers?region=XX\n  Expect the page contains "Customers"\n`, { db: demoDb(server) });
    const j = r.journeys[0];
    expect(j.status).toBe('error');
    expect(j.error).toMatchObject({ name: 'DataPrecondition', message: expect.stringMatching(/^data problem: db demo .* \(0 row\(s\), at least 1 needed\); variable PAYMENT_KEY \(PAYMENT_KEY is not set\)/) });
    expect(j.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(triageRun({ run: r, evidence: await manifest(r.dir) }).verdicts[0].category).toBe('data');
  });

  it('when the data is there the journey runs (and ${vars} in the SQL are bound)', async () => {
    const r = await run(`Journey: Has EU customers\nVariables: region=EU\nRequires: db demo "SELECT id FROM customers WHERE region = \${region}" has at least 2 rows\nOpen /rel/customers?region=EU\n  Expect the page contains "Contoso"\n`, { db: demoDb(server) });
    expect(r.journeys[0].status).toBe('passed');
    expect(r.journeys[0].reliability?.preconditions).toEqual([expect.objectContaining({ passed: true, message: '2 row(s)' })]);
  });
});

describe('dependencies (Depends on:) with ledger handoff', () => {
  it('runs prerequisites first, hands over values, skips dependents of a failure', async () => {
    const r = await run([
      'Journey: Uses order\nId: uses-order\nDepends on: make-order with total\nOpen /rel/slow?ms=0\n  Expect ${total} == "42.50"\n',
      'Journey: Make order\nId: make-order\nOpen /rel/slow?ms=0\nCapture the text of testid=basket-total as total\n  Expect ${total} == "42.50"\n',
      'Journey: Broken prerequisite\nId: broken\nOpen /rel/slow?ms=0\n  Expect the page contains "Nope"\n',
      'Journey: Needs broken\nId: needs-broken\nDepends on: broken\nOpen /rel/slow?ms=0\n',
      'Journey: Needs ghost\nId: needs-ghost\nDepends on: ghost\nOpen /rel/slow?ms=0\n',
    ], { concurrency: 3, reliability: { appIdle: true } });
    const by = Object.fromEntries(r.journeys.map((j) => [j.journeyId, j]));
    expect(by['make-order'].status).toBe('passed');
    expect(by['uses-order'].status).toBe('passed');
    expect(by['uses-order'].ledger.total).toBe('42.50');
    expect(by['uses-order'].reliability?.dependsOn).toEqual([{ journeyId: 'make-order', status: 'passed', handoff: ['total'] }]);
    expect(Date.parse(by['uses-order'].startedAt)).toBeGreaterThanOrEqual(Date.parse(by['make-order'].startedAt) + by['make-order'].durationMs - 5);
    expect(by['needs-broken']).toMatchObject({ status: 'skipped', error: { message: expect.stringMatching(/^not run: depends on "broken", which failed/) } });
    expect(by['needs-ghost'].error?.message).toMatch(/not part of this run/);
  });
});

describe('session expired mid-journey', () => {
  async function login(page: Page, _role: string, ctx: { baseUrl?: string }, ttl?: number) {
    await page.goto(`${ctx.baseUrl}/rel/session/login`);
    await page.getByLabel('Username').fill('bob');
    await page.getByLabel('Password').fill('Builder#2');
    await page.evaluate((t) => { if (t) document.querySelector('form')!.action = `/rel/session/login?ttl=${t}`; }, ttl ?? 0);
    await Promise.all([page.waitForURL(/\/rel\/session\/area/), page.getByRole('button', { name: 'Sign in' }).click()]);
  }
  const EZ = 'Journey: Long session\nLog in as bob\nOpen /rel/session/area\n  Expect the page contains "Members area"\nWait 1.5 seconds\nGo to /rel/session/area/reports\n  Expect the page contains "Section /reports"\n';

  it('without detection the journey fails on the sign-in page', async () => {
    const r = await run(EZ, { login: (p, role, ctx) => login(p, role, ctx, 1000) });
    expect(r.journeys[0].status).toBe('failed');
  });

  it('with detection it signs in again once, returns, re-runs the step, and records it', async () => {
    let logins = 0;
    const r = await run(EZ, {
      login: (p, role, ctx) => login(p, role, ctx, ++logins === 1 ? 1000 : undefined),
      sessionExpiry: { urls: ['/rel/session/login'] },
    });
    const j = r.journeys[0];
    expect(j.status).toBe('passed');
    expect(logins).toBe(2);
    expect(j.reliability?.relogins).toEqual([expect.objectContaining({ role: 'bob', reason: expect.stringMatching(/sign-in page/) })]);
    const step = j.steps[3];
    expect(step.warnings?.[0]).toMatch(/session expired .* signed in again as bob/);
    expect((await manifest(r.dir)).find((e) => e.id === j.reliability!.relogins![0].evidence)?.path).toMatch(/relogin\.json$/);
  });
});

describe('failure diagnosis', () => {
  it('a missing target: candidates with counts, "did you mean", and an outlined screenshot', async () => {
    const r = await run('Journey: Wrong name\nOpen /rel/overlay?ms=0\nClick the "Save settings" button\n  Expect the page contains "Saved"\n');
    const s = r.journeys[0].steps[1];
    expect(s.status).toBe('failed');
    expect(s.error?.message).toMatch(/did you mean role=button "Save"/);
    const d = s.diagnosis!;
    expect(d.expected).toMatch(/exactly one element for the "Save settings" button/);
    expect(d.candidates.find((c) => c.locator.startsWith('role=button'))?.matches).toBe(0);
    expect(d.similar[0]).toMatchObject({ locator: 'role=button "Save"' });
    expect(d.outlined).toBe(1);
    const shot = (await manifest(r.dir)).find((e) => e.id === d.screenshot);
    expect(shot?.kind).toBe('screenshot');
    // The outline was removed before the DOM snapshot.
    const html = (await manifest(r.dir)).find((e) => e.kind === 'dom' && e.stepId === s.stepId)!;
    expect(await readFile(join(r.dir, html.path), 'utf8')).not.toMatch(/data-eztest-outline/);
  });

  it('console errors and failed calls during the step are in the diagnosis', async () => {
    const r = await run('Journey: Report\nOpen /rel/error-page\nClick the "Run report" button\n  Expect the page contains "Report done"\n');
    const d = r.journeys[0].steps[1].diagnosis!;
    expect(d.expected).toMatch(/pageContainsText = "Report done"/);
    expect(d.consoleErrors.join(' ')).toMatch(/ReportService failed/);
    expect(d.failedRequests.join(' ')).toMatch(/GET .*\/rel\/api\/broken -> HTTP 503/);
    expect(r.journeys[0].steps[1].error?.message).toMatch(/failed calls: GET .*broken -> HTTP 503/);
  });
});

describe('browser context reuse (opt-in)', () => {
  it('reuses one context and nothing leaks between journeys', async () => {
    const write = async (page: Page) => {
      await page.evaluate(async () => {
        localStorage.setItem('leak', 'ls');
        sessionStorage.setItem('leak', 'ss');
        document.cookie = 'leak=ck; path=/';
        await new Promise<void>((res) => { const r = indexedDB.open('leakdb', 1); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => res(); });
      });
      await page.context().grantPermissions(['geolocation']);
      return {};
    };
    const read = async (page: Page) => page.evaluate(async () => ({
      ls: localStorage.getItem('leak'), ss: sessionStorage.getItem('leak'), cookie: document.cookie,
      dbs: ((await indexedDB.databases?.()) ?? []).map((d) => d.name).join(','),
      perm: (await navigator.permissions.query({ name: 'geolocation' })).state,
    }));
    const r = await run([
      'Journey: Writer\nId: writer\nOpen /rel/animate\nRun step "write"\n',
      'Journey: Reader\nId: reader\nOpen /rel/animate\nRun step "read"\n',
    ], { reuseContext: true, customSteps: { write: (p) => write(p), read: (p) => read(p) } });
    expect(r.journeys.map((j) => j.status)).toEqual(['passed', 'passed']);
    expect(r.environment.contextReuse).toBe('1 created, 1 reused');
    expect(r.journeys[1].ledger).toMatchObject({ ls: null, ss: null, cookie: '', dbs: '', perm: 'prompt' });
  });

  it('a context that got an init script is not reused', async () => {
    const r = await run(['Journey: Taint\nOpen /rel/animate\nRun step "taint"\n', 'Journey: After\nOpen /rel/animate\nRun step "check"\n'], {
      reuseContext: true,
      customSteps: {
        taint: async (p) => void (await p.context().addInitScript('window.__tainted = 1')),
        check: async (p) => ({ tainted: await p.evaluate(() => (window as unknown as { __tainted?: number }).__tainted ?? 0) }),
      },
    });
    expect(r.environment.contextReuse).toBe('2 created, 0 reused');
    expect(r.journeys[1].ledger.tainted).toBe(0);
  });
});

describe('locale, time zone and RTL', () => {
  it('locale-aware assertions on numbers, amounts and dates', async () => {
    const r = await run('Journey: German invoice\nOpen /rel/locale?lang=de-DE\nExpect testid=amount shows the amount "1234.50" in EUR for locale de-DE\nExpect testid=units shows the number "1234567.891" for locale de-DE\nExpect testid=due shows the date "2026-03-01" for locale de-DE\n');
    // Expect lines are post-conditions of the Open step.
    expect(r.journeys[0].status).toBe('passed');
    expect(r.journeys[0].steps[0].conditions.map((c) => c.passed)).toEqual([true, true, true]);
    const bad = await run('Journey: Wrong amount\nOpen /rel/locale?lang=de-DE\nExpect testid=amount shows the amount "1234.00" in EUR for locale de-DE\n');
    expect(bad.journeys[0].steps[0].error?.message).toMatch(/shows ".*1\.234,50.*" = 1234\.5 in de-DE, expected 1234/);
  });

  it('a pinned locale and time zone apply to the browser (and assertions use the browser locale)', async () => {
    const r = await run('Journey: Pinned\nOpen /rel/locale\nExpect testid=amount shows the amount "1234.50" in EUR\nCapture the text of testid=clock as clock\n', { locale: 'fr-FR', timezone: 'Asia/Tokyo' });
    const { setDefaultTimeZone } = await import('../../src/core/index.js');
    setDefaultTimeZone(undefined);
    expect(r.journeys[0].status).toBe('passed');
    expect(r.journeys[0].ledger.clock).toBe('Asia/Tokyo -540');
  });

  it('right-to-left layout and Arabic-Indic digits', async () => {
    const r = await run('Journey: RTL\nOpen /rel/rtl\nExpect the page is right-to-left\nExpect testid=amount shows the amount "1234.50" in EGP for locale ar-EG\n');
    expect(r.journeys[0].status).toBe('passed');
    expect(r.journeys[0].steps[0].conditions.map((c) => c.passed)).toEqual([true, true]);
    const ltr = await run('Journey: LTR\nOpen /rel/animate\nExpect the page is right-to-left\n');
    expect(ltr.journeys[0].steps[0].error?.message).toMatch(/laid out ltr, expected rtl/);
  });
});

describe('locator improvements and XPath escaping (live page)', () => {
  it('suggests a verified test id for a weak XPath target, never applied, listed for review', async () => {
    const ez = "Journey: Weak target\nId: weak-target\nOpen /rel/weak\nClick xpath=//div[@class='row']/div[1]/button\n  Expect the page contains \"Order placed\"\n";
    const r = await run(ez);
    const s = r.journeys[0].steps[1];
    expect(s.status).toBe('passed');
    expect(s.usedLocator?.strategy).toBe('xpath'); // the journey's own locator was used
    expect(s.improvement).toMatchObject({ suggested: { strategy: 'testId', value: 'place-order' }, score: 95 });
    expect(s.improvement!.currentScore).toBeLessThan(40);
    const p = collectHealProposals(r, [parseEzScript(ez)]);
    expect(p.improvements).toEqual([expect.objectContaining({ journeyId: 'weak-target', suggested: { strategy: 'testId', value: 'place-order' } })]);
    expect(existsSync(join(r.dir, 'heal-proposals.json'))).toBe(true);
  });

  it('a value with both quote kinds is placed into an XPath with concat()', async () => {
    const r = await run('Journey: Quotes\nVariables: label=`Bob\'s "best" deal`\nOpen /rel/weak\nClick xpath=//button[normalize-space()=\'${label}\']\n  Expect the page contains "Deal chosen"\n');
    expect(r.journeys[0].steps[1].usedLocator?.value).toBe(`//button[normalize-space()=concat('Bob', "'", 's "best" deal')]`);
    expect(r.journeys[0].status).toBe('passed');
  });
});
