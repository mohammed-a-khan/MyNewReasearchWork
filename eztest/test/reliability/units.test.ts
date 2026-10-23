/** Unit tests of the reliability building blocks (no browser). */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateExpression, formatCurrency, parseLocaleDate, parseLocaleNumber, setDefaultTimeZone, uniqueValue, uniqueEmail, asciiDigits, stripBidi,
  type JourneyResult, type StepResult,
} from '../../src/core/index.js';
import { parseEzScript, journeyToEzScript } from '../../src/intent/index.js';
import { parseDependsOn, parseRequires } from '../../src/intent/requires.js';
import {
  CircuitBreaker, classifyEnvironmentFailure, classifyFlake, fillXPath, guardedAction, handoffFor, interpolateCandidate, planDependencies, runHealthChecks, xpathLiteral,
  takeReliability, type StepContext,
} from '../../src/runner/index.js';
import { HistoryStore, clusterAcrossRuns, normalizeMessage, scoreHistory, summarizeFlakeCauses, triageRun, withFlakeCauses, scoreFlakiness } from '../../src/insights/index.js';

// ------------------------------------------------------------------ XPath literals

describe('XPath literal escaping', () => {
  it('quotes with the other quote kind, and concat() for mixed quotes', () => {
    expect(xpathLiteral('plain')).toBe("'plain'");
    expect(xpathLiteral("Bob's")).toBe('"Bob\'s"');
    expect(xpathLiteral('say "hi"')).toBe('\'say "hi"\'');
    expect(xpathLiteral(`Bob's "best"`)).toBe(`concat('Bob', "'", 's "best"')`);
    expect(xpathLiteral(`'`)).toBe(`"'"`);
    expect(xpathLiteral(`'"'`)).toBe(`concat("'", '"', "'")`);
  });

  it('fills ${var} inside XPath string literals safely (and leaves code alone)', () => {
    const vars = { name: `Bob's "best" deal`, n: 2 };
    const fill = (t: string) => t.replace(/\$\{(\w+)\}/g, (_w, k: string) => String((vars as Record<string, unknown>)[k]));
    expect(fillXPath(`//a[text()='\${name}']`, fill)).toBe(`//a[text()=concat('Bob', "'", 's "best" deal')]`);
    expect(fillXPath(`(//tr)[\${n}]//td[.="x"]`, fill)).toBe(`(//tr)[2]//td[.='x']`);
    expect(interpolateCandidate({ strategy: 'xpath', value: `//button[normalize-space()='\${name}']` }, vars).value).toBe(`//button[normalize-space()=concat('Bob', "'", 's "best" deal')]`);
    // Non-XPath strategies are plain interpolation.
    expect(interpolateCandidate({ strategy: 'text', value: '${name}' }, vars).value).toBe(`Bob's "best" deal`);
  });

  it('Examples placeholders in XPath values are quoted safely too', async () => {
    const { expandExamples } = await import('../../src/runner/index.js');
    const j = parseEzScript(`Journey: Shelves\nOpen /\nClick xpath=//ul[@id='shelf']/li[label[.='<shelf>']]\n\nExamples:\n  | shelf |\n  | "Pots & Pans" |\n  | "Bob's shelf" |\n`);
    const [a, b] = expandExamples([j]);
    expect(a.steps[1].target!.locators[0].value).toBe(`//ul[@id='shelf']/li[label[.='Pots & Pans']]`);
    expect(b.steps[1].target!.locators[0].value).toBe(`//ul[@id='shelf']/li[label[.="Bob's shelf"]]`);
  });
});

// ------------------------------------------------------------------ locale and time

describe('locale-aware values', () => {
  it('parses numbers and amounts as written in many locales (incl. RTL digits and bidi marks)', () => {
    for (const [loc, v] of [['de-DE', 1234.5], ['fr-FR', -1234567.25], ['ar-EG', 1234.5], ['en-IN', 1234567], ['de-CH', 1234.5], ['en-US', 0.5], ['sv-SE', 98765.43]] as const) {
      expect(parseLocaleNumber(formatCurrency(v, 'EUR', loc), loc)).toBeCloseTo(v, 6);
      expect(parseLocaleNumber(new Intl.NumberFormat(loc).format(v), loc)).toBeCloseTo(v, 6);
    }
    expect(parseLocaleNumber('(1,234.00)', 'en-US')).toBe(-1234);
    expect(parseLocaleNumber('n/a', 'en-US')).toBeUndefined();
    expect(asciiDigits(String.fromCharCode(0x661, 0x662, 0x663))).toBe('123');
    expect(stripBidi(`${String.fromCharCode(0x200f)}12${String.fromCharCode(0x200e)}`)).toBe('12');
  });

  it('parses dates by the locale\'s day/month/year order and month names', () => {
    const d = new Date(Date.UTC(2026, 2, 1));
    for (const loc of ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'ar-EG', 'nl-NL']) {
      for (const style of ['short', 'medium', 'long'] as const) {
        expect(parseLocaleDate(new Intl.DateTimeFormat(loc, { dateStyle: style, timeZone: 'UTC' }).format(d), loc), `${loc} ${style}`).toBe('2026-03-01');
      }
    }
    expect(parseLocaleDate('31/02/2026', 'en-GB')).toBeUndefined();
  });

  it('expression functions format and parse by locale', () => {
    expect(evaluateExpression('parseLocaleNumber("1.234,50 €", "de-DE")', {})).toBe(1234.5);
    expect(evaluateExpression('formatCurrency(1234.5, "EUR", "de-DE")', {})).toBe(formatCurrency(1234.5, 'EUR', 'de-DE'));
    expect(evaluateExpression('parseLocaleDate("1. März 2026", "de-DE")', {})).toBe('2026-03-01');
  });

  describe('timezone-pinned expression functions', () => {
    afterEach(() => setDefaultTimeZone(undefined));
    it('today(), now() and format() use the pinned zone', () => {
      setDefaultTimeZone('Pacific/Kiritimati'); // UTC+14: "today" differs from UTC for most of the day
      const want = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
      expect(evaluateExpression('today()', {})).toBe(want);
      expect(String(evaluateExpression('now()', {}))).toMatch(/\+14:00$/);
      setDefaultTimeZone(undefined);
      expect(String(evaluateExpression('now()', {}))).toMatch(/Z$/);
      expect(() => setDefaultTimeZone('Mars/Olympus')).toThrow(/unknown time zone/);
    });
  });
});

// ------------------------------------------------------------------ unique data

describe('unique data across workers and shards', () => {
  it('never repeats within a process and respects maxLength', () => {
    const seen = new Set(Array.from({ length: 20_000 }, () => uniqueValue('ORD-')));
    expect(seen.size).toBe(20_000);
    const short = uniqueValue('C', 12);
    expect(short.length).toBeLessThanOrEqual(12);
    expect(uniqueEmail()).toMatch(/^t-[a-z0-9-]+@example\.test$/);
    expect(evaluateExpression('unique("INV-")', {})).toMatch(/^INV-/);
  });

  it('never repeats across parallel processes (4 workers x 2000 values)', async () => {
    const { spawn } = await import('node:child_process');
    const script = join(import.meta.dirname, 'fixtures', 'unique-worker.ts');
    const runWorker = (shard: string) => new Promise<string[]>((res, rej) => {
      const p = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, EZTEST_SHARD: shard }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('exit', (code) => (code === 0 ? res(JSON.parse(out) as string[]) : rej(new Error(`worker ${shard} exited ${code}`))));
    });
    const all = (await Promise.all(['0', '1', '1', '2'].map(runWorker))).flat(); // two workers share a shard index on purpose
    expect(all).toHaveLength(8000);
    expect(new Set(all).size).toBe(8000);
  }, 60_000);
});

// ------------------------------------------------------------------ Requires / Depends on

describe('Requires: and Depends on:', () => {
  it('parses every precondition kind and renders back', () => {
    const r = parseRequires(`db demo "SELECT id FROM customers WHERE region = 'EU'" has at least 2 rows; query "eligible" on crm has rows; api GET /api/health as manager returns 200; data Customer as buyer where region=EU, tier="gold"; variables TOKEN, KEY; that \${limit} > 100`);
    expect(r.map((p) => p.kind)).toEqual(['db', 'query', 'api', 'data', 'variable', 'variable', 'expr']);
    expect(r[0]).toMatchObject({ connection: 'demo', min: 2 });
    expect(r[3]).toMatchObject({ entity: 'Customer', as: 'buyer', where: { region: 'EU', tier: 'gold' } });
    expect(() => parseRequires('weather is nice')).toThrow(/unknown requirement/);
    const j = parseEzScript(`Journey: R\nRequires: db demo "SELECT 1" has rows\nDepends on: create-order with orderNumber, invoice; "Seed catalogue"\nOpen /\n`);
    expect(j.dependsOn).toEqual([{ journey: 'create-order', take: ['orderNumber', 'invoice'] }, { journey: 'Seed catalogue', take: [] }]);
    expect(parseEzScript(journeyToEzScript(j))).toEqual(j);
    expect(() => parseDependsOn('a with 1bad')).toThrow(/not a ledger key/);
  });

  it('orders prerequisites, rejects unknown prerequisites and cycles', () => {
    const mk = (id: string, deps: string[] = []) => parseEzScript(`Journey: ${id}\nId: ${id}\n${deps.length ? `Depends on: ${deps.join('; ')}\n` : ''}Open /\n`);
    const plan = planDependencies([mk('b', ['a']), mk('a'), mk('c', ['ghost']), mk('x', ['y']), mk('y', ['x'])]);
    expect(plan.prereqs[0]).toEqual([1]);
    expect(plan.errors.get(2)).toMatch(/depends on "ghost", which is not part of this run/);
    expect(plan.errors.get(3)).toMatch(/circular dependency/);
    expect(plan.errors.get(4)).toMatch(/circular dependency/);
  });

  it('hands over named ledger values, and blocks dependents of a failed prerequisite', () => {
    const a = parseEzScript('Journey: A\nId: a\nReturns: orderNumber\nOpen /\n');
    const b = parseEzScript('Journey: B\nId: b\nDepends on: a\nOpen /\n');
    const res = (status: JourneyResult['status'], ledger: Record<string, unknown> = {}): JourneyResult => ({ journeyId: 'a', name: 'A', status, startedAt: '', durationMs: 0, steps: [], tags: [], requirements: [], risk: 3, attempt: 1, ledger, evidence: [] });
    expect(handoffFor(b, [{ journey: a, result: res('passed', { orderNumber: 'ORD-1', other: 1 }) }])).toMatchObject({ seed: { orderNumber: 'ORD-1' }, summary: [{ journeyId: 'a', handoff: ['orderNumber'] }] });
    expect(handoffFor(b, [{ journey: a, result: res('failed') }]).blocked).toMatch(/depends on "a", which failed/);
    expect(handoffFor(b, [{ journey: a, result: res('passed') }]).blocked).toMatch(/did not produce "orderNumber"/);
  });
});

// ------------------------------------------------------------------ flake classification and scoring

const step = (o: Partial<StepResult>): StepResult => ({ stepId: 's1', intent: 'x', status: 'failed', startedAt: '', durationMs: 0, conditions: [], evidence: [], ...o });
const journey = (o: Partial<JourneyResult>): JourneyResult => ({ journeyId: 'j', name: 'J', status: 'failed', startedAt: '', durationMs: 0, steps: [], tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [], ...o });

describe('flake classifier', () => {
  it('names the cause from the failed attempt', () => {
    const c = (message: string) => classifyFlake(journey({ steps: [step({ error: { message } })] }), journey({ status: 'passed', attempt: 2 })).cause;
    expect(c('the "Save" button is covered by <div#cookie> (an overlay); the click would land on it')).toBe('overlay');
    expect(c('Element is not attached to the DOM')).toBe('detached');
    expect(c('API POST /api/orders returned 503')).toBe('network');
    expect(c('No available Customer where region=EU (all matches missing or leased)')).toBe('data');
    expect(c('post-condition failed: pageContainsText: not found')).toBe('timing');
    expect(c('something odd')).toBe('unknown');
  });

  it('prefers what the steps recorded (recoveries, overlay waits) over message text', () => {
    const failed = journey({ steps: [step({ error: { message: 'Timeout 5000ms exceeded' }, reliability: { waits: [{ cause: 'overlay', ms: 4900, detail: 'covered by <div.spinner>' }], recovered: [] } })] });
    const f = classifyFlake(failed, journey({ status: 'passed', attempt: 2 }));
    expect(f.cause).toBe('overlay');
    expect(f.reason).toMatch(/spinner/);
    const env = classifyFlake(journey({ steps: [step({ stepId: 'open', status: 'passed' }), step({ stepId: 'go', error: { message: 'no locator candidate matched exactly one element for the Go button' } })] }), undefined,
      [{ url: 'http://x/rel/env/a', status: 503, resourceType: 'document', stepId: 'open' }]);
    expect(env.cause).toBe('network');
    expect(env.reason).toMatch(/HTTP 503/);
  });

  it('retried passes make a journey flaky with a root-cause category', async () => {
    const outcomes = [
      { status: 'passed' as const, attempt: 1 }, { status: 'passed' as const, attempt: 2, flakeCause: 'overlay' as const },
      { status: 'passed' as const, attempt: 1 }, { status: 'passed' as const, attempt: 2, flakeCause: 'overlay' as const },
      { status: 'passed' as const, attempt: 2, flakeCause: 'timing' as const }, { status: 'passed' as const, attempt: 1 },
    ];
    const sum = summarizeFlakeCauses('j', outcomes);
    expect(sum).toMatchObject({ retriedPasses: 3, dominant: 'overlay' });
    const s = withFlakeCauses(scoreFlakiness('j', outcomes.map((o) => o.status)), sum);
    expect(s.state).toBe('flaky');
    expect(s.rootCause).toMatchObject({ cause: 'overlay', retriedPasses: 3 });
    expect(s.reasons[0]).toMatch(/passed only on retry 3 time/);

    // Through history: the runner's classification is stored with the outcome.
    const dir = await mkdtemp(join(tmpdir(), 'eztest-hist-'));
    const h = await HistoryStore.open(join(dir, 'history.json'));
    for (let i = 0; i < 6; i++) {
      h.record({ runId: `r${i}`, startedAt: `2026-01-0${i + 1}T00:00:00Z`, finishedAt: '', durationMs: 1, summary: { total: 1, passed: 1, passedHealed: 0, failed: 0, skipped: 0, errors: 0 }, environment: {},
        journeys: [journey({ status: 'passed', attempt: i % 2 ? 2 : 1, ...(i % 2 ? { reliability: { flake: { cause: 'detached', confidence: 0.9, reason: 'r', failedAttempt: 1, evidence: [] } } } : {}) })] });
    }
    const [score] = scoreHistory(h);
    expect(score.state).toBe('flaky');
    expect(score.rootCause?.cause).toBe('detached');
  });
});

// ------------------------------------------------------------------ environment health

describe('environment health', () => {
  let server: Server;
  let base = '';
  let up = true;
  afterEach(() => server?.close());
  const start = async () => {
    server = createServer((req, res) => {
      res.writeHead(up ? 200 : 503, { 'content-type': 'text/plain' });
      res.end(up ? 'OK ready' : 'down');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  };

  it('checks URLs, API status, DB pings, DNS and refused connections', async () => {
    await start();
    // A port nothing listens on.
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', () => r()));
    const closedPort = (tmp.address() as { port: number }).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    up = true;
    const db = { query: async (c: string) => (c === 'ok' ? [{ one: 1 }] : Promise.reject(new Error('ORA-12541: TNS:no listener'))) };
    const r = await runHealthChecks([
      { name: 'app', url: '/health', contains: 'ready' },
      { name: 'api', api: '/api/status', status: 200 },
      { name: 'db ok', db: 'ok' },
      { name: 'db down', db: 'down' },
      { name: 'dns', url: 'http://does-not-exist.invalid/', timeoutMs: 5000 },
      { name: 'refused', url: `http://127.0.0.1:${closedPort}/` },
    ], { baseUrl: base, db });
    expect(r.map((c) => `${c.name}:${c.ok}`)).toEqual(['app:true', 'api:true', 'db ok:true', 'db down:false', 'dns:false', 'refused:false']);
    expect(r[3].message).toMatch(/ORA-12541/);
    expect(r[4].message).toMatch(/DNS|ENOTFOUND|EAI_AGAIN|fetch failed/);
    expect(r[5].message).toMatch(/refused|ECONNREFUSED/);
    up = false;
    const [down] = await runHealthChecks([{ url: '/health' }], { baseUrl: base });
    expect(down).toMatchObject({ ok: false, message: expect.stringMatching(/HTTP 503/) });
  });

  it('classifies 5xx pages, gateway errors, DNS and refused connections as environment failures', () => {
    const failed = (message: string) => journey({ steps: [step({ error: { message } })] });
    expect(classifyEnvironmentFailure(failed('page.goto: net::ERR_NAME_NOT_RESOLVED at http://x'))).toMatch(/DNS/);
    expect(classifyEnvironmentFailure(failed('page.goto: net::ERR_CONNECTION_REFUSED'))).toMatch(/refused/);
    expect(classifyEnvironmentFailure(failed('page.goto: Timeout 30000ms exceeded. navigating to "http://x"'))).toMatch(/navigation timed out/);
    expect(classifyEnvironmentFailure(failed('API GET /x returned 503'))).toMatch(/gateway \/ service unavailable \(returned 503\)/);
    expect(classifyEnvironmentFailure(failed('post-condition failed'), [{ url: 'http://h/p?token=secret', status: 500, resourceType: 'document' }])).toBe('the page itself returned HTTP 500 (h/p)');
    expect(classifyEnvironmentFailure(failed('post-condition failed'), [{ url: 'http://h/api/x', status: 500, resourceType: 'xhr', stepId: 's1' }])).toBeUndefined();
    expect(classifyEnvironmentFailure(journey({ status: 'passed' }))).toBeUndefined();
  });

  it('the circuit breaker opens only when the probe confirms the outage', async () => {
    let probeOk = true;
    let probes = 0;
    const cb = new CircuitBreaker(2, async () => {
      probes++;
      return { ok: probeOk, reason: probeOk ? 'up' : 'HTTP 503' };
    });
    expect(await cb.report('a', 'HTTP 503')).toBe(false);
    expect(await cb.report('b', 'HTTP 503')).toBe(false); // probe says up: a product problem, keep going
    expect(probes).toBe(1);
    expect(await cb.report('c', undefined)).toBe(false);
    probeOk = false;
    await cb.report('d', 'HTTP 503');
    expect(await cb.report('e', 'HTTP 503')).toBe(true);
    expect(cb.open?.afterJourney).toBe('e');
  });

  it('triage calls data preconditions "data" and classified outages "environment"', () => {
    const run = {
      runId: 'r', startedAt: '', finishedAt: '', durationMs: 0, environment: {}, summary: { total: 2, passed: 0, passedHealed: 0, failed: 1, skipped: 0, errors: 1 },
      journeys: [
        journey({ journeyId: 'd', status: 'error', evidence: ['E-1'], error: { message: 'data problem: db demo query (0 row(s), at least 1 needed)', name: 'DataPrecondition' }, reliability: { preconditions: [{ check: 'db demo query', passed: false, message: '0 row(s)' }] } }),
        journey({ journeyId: 'e', evidence: ['E-2'], steps: [step({ error: { message: 'no locator candidate matched exactly one element for the Go button' }, evidence: ['E-2'] })], reliability: { environment: { reason: 'the page itself returned HTTP 503 (h/p)', evidence: ['E-2'] } } }),
      ],
    };
    const evidence = [{ id: 'E-1', kind: 'data' as const, path: 'a', sha256: 'x', createdAt: '', journeyId: 'd' }, { id: 'E-2', kind: 'network' as const, path: 'b', sha256: 'y', createdAt: '', journeyId: 'e' }];
    const t = triageRun({ run, evidence });
    expect(t.verdicts.find((v) => v.journeyId === 'd')?.category).toBe('data');
    expect(t.verdicts.find((v) => v.journeyId === 'e')?.category).toBe('environment');
  });
});

// ------------------------------------------------------------------ failure clustering across runs

describe('failure clustering across runs', () => {
  it('signatures survive generated ids, numbers, URLs and timings', () => {
    const a = normalizeMessage('no locator candidate matched exactly one element for #btn-8f3a2c91 (css=#btn-8f3a2c91: no match) at http://h/orders/123 after 5012 ms');
    const b = normalizeMessage('no locator candidate matched exactly one element for #btn-77aa01ce (css=#btn-77aa01ce: no match) at http://h/orders/987 after 498 ms');
    expect(a).toBe(b);
    expect(normalizeMessage('element ember1234 detached')).toBe(normalizeMessage('element ember98 detached'));
  });

  it('groups the same failure from different runs and journeys', () => {
    const run = (runId: string, startedAt: string, msgs: Array<[string, string]>) => ({
      runId, startedAt, journeys: msgs.map(([id, message]) => journey({ journeyId: id, steps: [step({ error: { message } })] })),
    });
    const clusters = clusterAcrossRuns([
      run('r1', '2026-01-01', [['a', 'API POST /api/orders/1001 returned 503 after 30001 ms'], ['b', 'Expected "Saved" but found "Error"']]),
      run('r2', '2026-01-02', [['c', 'API POST /api/orders/2002 returned 503 after 29870 ms']]),
      run('r3', '2026-01-03', [['a', 'API POST /api/orders/3 returned 503 after 31000 ms']]),
    ]);
    expect(clusters[0]).toMatchObject({ failures: 3, runs: ['r1', 'r2', 'r3'], journeys: ['a', 'c'], firstSeen: '2026-01-01', lastSeen: '2026-01-03' });
    expect(clusters).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ guard: detached re-resolve

describe('reliability guard', () => {
  it('re-resolves a target detached mid-action and retries once (recorded)', async () => {
    const step = parseEzScript('Journey: G\nOpen /\nClick the "Go" button\n').steps[1];
    let calls = 0;
    const loc = { tag: 'old' } as never;
    const fresh = { tag: 'new' } as never;
    const ctx = { journey: { id: 'g' } } as unknown as StepContext;
    const seen: unknown[] = [];
    await guardedAction(step, loc, ctx, { outputDir: '', reliability: { actionability: false } }, 1000, async (l) => {
      seen.push(l);
      if (++calls === 1) throw new Error('locator.click: Element is not attached to the DOM');
      return {};
    }, { reresolve: async () => fresh });
    expect(seen).toEqual([loc, fresh]);
    expect(takeReliability(ctx)?.recovered[0]).toMatchObject({ cause: 'detached' });
    // Other errors are not retried.
    await expect(guardedAction(step, loc, ctx, { outputDir: '', reliability: { actionability: false } }, 1000, async () => {
      throw new Error('Timeout 1000ms exceeded');
    }, { reresolve: async () => fresh })).rejects.toThrow(/Timeout/);
  });
});
