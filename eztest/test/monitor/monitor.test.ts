import { describe, it, expect, beforeEach } from '../support/testkit.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseJourney, summarize, type Journey, type JourneyResult, type JourneyStatus, type RunResult } from '../../src/core/index.js';
import {
  runMonitor,
  assertMonitorSafe,
  findWriteSteps,
  summarizeMonitorState,
  renderStatusPage,
  loadMonitorState,
  percentile,
  type MonitorAlert,
  type MonitorEvent,
} from '../../src/monitor/index.js';

const SECRET = 'abcdef0123456789abcdef0123456789';

function journey(id: string, extra: Partial<Parameters<typeof parseJourney>[0] & object> = {}, tags = ['monitor']): Journey {
  return parseJourney({
    id,
    name: `Journey ${id}`,
    tags,
    steps: [
      { id: 's1', intent: 'Open the dashboard', action: 'navigate', value: '/dashboard' },
      { id: 's2', intent: 'Check the orders grid', action: 'assert', postconditions: [{ type: 'pageContainsText', value: 'Recent orders' }] },
    ],
    ...extra,
  });
}

function jr(j: Journey, status: JourneyStatus, durationMs: number): JourneyResult {
  const failed = status === 'failed';
  return {
    journeyId: j.id,
    name: j.name,
    status,
    startedAt: new Date().toISOString(),
    durationMs,
    steps: [
      { stepId: 's1', intent: 'Open the dashboard', status: 'passed', startedAt: '', durationMs: 1, conditions: [], evidence: [] },
      {
        stepId: 's2',
        intent: 'Check the orders grid',
        status: failed ? 'failed' : 'passed',
        startedAt: '',
        durationMs: 1,
        conditions: [],
        evidence: [],
        error: failed ? { message: `grid missing; Authorization: Bearer ${SECRET}` } : undefined,
      },
    ],
    tags: j.tags,
    requirements: [],
    risk: 3,
    attempt: 1,
    ledger: {},
    evidence: [],
  };
}

let runNo = 0;
function runOf(results: JourneyResult[]): RunResult {
  runNo += 1;
  return {
    runId: `run-${runNo}`,
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    journeys: results,
    summary: summarize(results),
    environment: {},
  };
}

/** A fake runner that replays a scripted status sequence. */
function scripted(j: Journey, statuses: JourneyStatus[], durations?: number[]) {
  let i = 0;
  return async (): Promise<RunResult> => {
    const s = statuses[i];
    const d = durations?.[i] ?? 100;
    i += 1;
    if (s === undefined) throw new Error('script exhausted');
    return runOf([jr(j, s, d)]);
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eztest-monitor-'));
});

describe('monitor: alerts on state change only', () => {
  it('pass,pass,fail,fail,pass with flap guard 2 → exactly one down and one recovery', async () => {
    const j = journey('checkout');
    const alerts: MonitorAlert[] = [];
    const state = await runMonitor({
      journeys: [j],
      run: scripted(j, ['passed', 'passed', 'failed', 'failed', 'passed'], [100, 200, 300, 400, 500]),
      intervalMs: 5,
      iterations: 5,
      stateFile: join(dir, 'state.json'),
      outputDir: '/runs',
      failureThreshold: 2,
      triageHint: () => `product-bug: token=${SECRET}`,
      alerts: [{ type: 'callback', fn: (a) => void alerts.push(a) }],
    });
    expect(alerts.map((a) => a.kind)).toEqual(['down', 'recovered']);
    const down = alerts[0];
    expect(down.journeyId).toBe('checkout');
    expect(down.status).toBe('down');
    expect(down.consecutiveFailures).toBe(2);
    expect(down.failingStep?.stepId).toBe('s2');
    expect(down.runDir).toBe(join('/runs', 'run-' + (runNo - 1)));
    expect(down.triageHint).toContain('product-bug');
    expect(JSON.stringify(alerts)).not.toContain(SECRET);
    expect(down.text).toContain('DOWN');
    expect(alerts[1].status).toBe('up');

    const js = state.journeys.checkout;
    expect(js.health).toBe('up');
    expect(js.totalRuns).toBe(5);
    expect(js.passedRuns).toBe(3);
    expect(js.uptimePct).toBe(60);
    expect(js.p50Ms).toBe(300);
    expect(js.p95Ms).toBe(500);
    expect(state.runs).toBe(5);
    expect(state.alerts).toHaveLength(2);

    // persisted atomically and readable
    const persisted = await loadMonitorState(join(dir, 'state.json'), '');
    expect(persisted.journeys.checkout.uptimePct).toBe(60);
    expect(persisted.alerts.map((a) => a.kind)).toEqual(['down', 'recovered']);
  });

  it('a single failure (flap) never alerts; threshold 1 alerts immediately; continued failure does not repeat', async () => {
    const j = journey('flappy');
    const a1: MonitorAlert[] = [];
    await runMonitor({
      journeys: [j],
      run: scripted(j, ['passed', 'failed', 'passed', 'failed', 'passed']),
      intervalMs: 5,
      iterations: 5,
      stateFile: join(dir, 'a.json'),
      alerts: [{ type: 'callback', fn: (a) => void a1.push(a) }],
    });
    expect(a1).toEqual([]);

    const a2: MonitorAlert[] = [];
    const st = await runMonitor({
      journeys: [j],
      run: scripted(j, ['failed', 'failed', 'failed', 'passed-healed']),
      intervalMs: 5,
      iterations: 4,
      failureThreshold: 1,
      stateFile: join(dir, 'b.json'),
      alerts: [{ type: 'callback', fn: (a) => void a2.push(a) }],
    });
    expect(a2.map((a) => a.kind)).toEqual(['down', 'recovered']);
    expect(st.journeys.flappy.uptimePct).toBe(25);
  });

  it('state survives restarts: an outage spanning two monitor processes alerts once', async () => {
    const j = journey('restart');
    const stateFile = join(dir, 'r.json');
    const alerts: MonitorAlert[] = [];
    const cb = { type: 'callback' as const, fn: (a: MonitorAlert) => void alerts.push(a) };
    await runMonitor({ journeys: [j], run: scripted(j, ['passed', 'failed']), intervalMs: 5, iterations: 2, stateFile, alerts: [cb] });
    expect(alerts).toEqual([]);
    await runMonitor({ journeys: [j], run: scripted(j, ['failed', 'failed']), intervalMs: 5, iterations: 2, stateFile, alerts: [cb] });
    expect(alerts.map((a) => a.kind)).toEqual(['down']);
    const st = await loadMonitorState(stateFile, '');
    expect(st.journeys.restart.consecutiveFailures).toBe(3);
    expect(st.runs).toBe(4);
  });

  it('a runner that throws counts as a failure for every journey, without secrets', async () => {
    const j = journey('boom');
    const alerts: MonitorAlert[] = [];
    const st = await runMonitor({
      journeys: [j],
      run: async () => {
        throw new Error(`browser crashed; cookie: sid=${SECRET}`);
      },
      intervalMs: 5,
      iterations: 2,
      stateFile: join(dir, 'boom.json'),
      alerts: [{ type: 'callback', fn: (a) => void alerts.push(a) }],
    });
    expect(alerts).toHaveLength(1);
    expect(st.lastRunError).toContain('browser crashed');
    expect(JSON.stringify(st)).not.toContain(SECRET);
    expect(st.journeys.boom.health).toBe('down');
  });
});

describe('monitor: scheduling', () => {
  it('skips a tick while the previous run is still going and records the skip', async () => {
    const j = journey('slow');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const events: MonitorEvent['type'][] = [];
    const st = await runMonitor({
      journeys: [j],
      run: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return runOf([jr(j, 'passed', 10)]);
      },
      intervalMs: 10,
      iterations: 2,
      stateFile: join(dir, 'skip.json'),
      onEvent: (e) => {
        events.push(e.type);
        if (e.type === 'skip' && events.filter((x) => x === 'skip').length === 2) release();
      },
    });
    expect(st.ticks).toBe(4);
    expect(st.skippedTicks).toBe(2);
    expect(st.skips).toHaveLength(2);
    expect(st.skips[0].reason).toMatch(/still in progress/);
    expect(calls).toBe(2);
    expect(st.runs).toBe(2);
  });

  it('stops on abort', async () => {
    const j = journey('abort');
    const ac = new AbortController();
    let calls = 0;
    const st = await runMonitor({
      journeys: [j],
      run: async () => {
        calls += 1;
        if (calls === 3) ac.abort();
        return runOf([jr(j, 'passed', 10)]);
      },
      intervalMs: 5,
      signal: ac.signal,
      stateFile: join(dir, 'abort.json'),
    });
    expect(st.runs).toBe(3);
  });

  it('rejects bad options', async () => {
    const j = journey('x');
    const base = { journeys: [j], run: async () => runOf([]), stateFile: join(dir, 'x.json') };
    await expect(runMonitor({ ...base, intervalMs: 0, iterations: 1 })).rejects.toThrow(/intervalMs/);
    await expect(runMonitor({ ...base, intervalMs: 10 })).rejects.toThrow(/iterations or an AbortSignal/);
    await expect(runMonitor({ ...base, intervalMs: 10, iterations: 1, alerts: [{ type: 'webhook', url: 'ftp://x' }] })).rejects.toThrow(/Not supported/);
  });
});

describe('monitor: production-safety guard', () => {
  it('refuses untagged journeys unless explicitly allowed', () => {
    const j = journey('plain', {}, []);
    expect(() => assertMonitorSafe([j])).toThrow(/not tagged/);
    expect(() => assertMonitorSafe([j], { allowJourneys: ['plain'] })).not.toThrow();
    expect(() => assertMonitorSafe([journey('t', {}, ['@monitor-safe'])])).not.toThrow();
    expect(() => assertMonitorSafe([])).toThrow(/no journeys/);
  });

  it('flags write-like steps and requires allowWrites', async () => {
    const writer = journey('order', {
      steps: [
        { id: 'a', intent: 'Login', action: 'fill', value: 'bob', target: { description: 'Username', locators: [] } },
        { id: 'b', intent: 'Click "Sign in"', action: 'click', target: { description: 'Sign in button', locators: [] } },
        { id: 'c', intent: 'Enter quantity', action: 'fill', value: '2', target: { description: 'Quantity', locators: [] } },
        { id: 'd', intent: 'Click "Submit order"', action: 'click', target: { description: 'Submit order button', locators: [] } },
        { id: 'e', intent: 'Create via API', action: 'api', api: { method: 'POST', url: '/api/orders' } },
        { id: 'f', intent: 'Read orders', action: 'db', db: { connection: 'main', sql: 'SELECT * FROM orders' } },
        { id: 'g', intent: 'Wipe', action: 'db', db: { connection: 'main', sql: 'select 1; DELETE FROM orders' } },
        { id: 'h', intent: 'Read', action: 'api', api: { method: 'GET', url: '/api/orders' } },
      ],
    });
    const findings = findWriteSteps(writer);
    expect(findings.map((f) => f.stepId)).toEqual(['d', 'e', 'g']);
    expect(() => assertMonitorSafe([writer])).toThrow(/allowWrites/);
    expect(() => assertMonitorSafe([writer], { allowWrites: true })).not.toThrow();
    await expect(
      runMonitor({ journeys: [writer], run: async () => runOf([]), intervalMs: 5, iterations: 1, stateFile: join(dir, 'w.json') }),
    ).rejects.toThrow(/Refusing to monitor/);
  });
});

describe('monitor: webhook alerts', () => {
  it('POSTs a Slack/Teams-compatible JSON payload to a local server', async () => {
    const received: Array<{ headers: IncomingMessage['headers']; body: { text: string; eztest: MonitorAlert } }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const j = journey('hooked');
    try {
      const st = await runMonitor({
        journeys: [j],
        run: scripted(j, ['failed', 'failed', 'passed']),
        intervalMs: 20,
        iterations: 3,
        stateFile: join(dir, 'hook.json'),
        alerts: [
          { type: 'webhook', url, timeoutMs: 2000 },
          { type: 'webhook', url: 'http://127.0.0.1:1/unreachable', timeoutMs: 500, name: 'broken' },
        ],
      });
      expect(received).toHaveLength(2);
      expect(received[0].headers['content-type']).toBe('application/json');
      expect(received[0].body.text).toContain('DOWN');
      expect(received[0].body.eztest.failingStep?.stepId).toBe('s2');
      expect(received[1].body.eztest.kind).toBe('recovered');
      expect(JSON.stringify(received)).not.toContain(SECRET);
      expect(st.alerts[0].delivered).toEqual(['webhook#1']);
      expect(st.alerts[0].failed.map((f) => f.channel)).toEqual(['broken']);
    } finally {
      server.close();
    }
  });
});

describe('monitor: summaries and status page', () => {
  it('summarizes and renders escaped, self-contained HTML', async () => {
    const evil = journey('evil', { name: '<script>alert(1)</script> & "co"' });
    const ok = journey('ok');
    let n = 0;
    const st = await runMonitor({
      journeys: [evil, ok],
      run: async () => {
        n += 1;
        return runOf([jr(evil, 'failed', 50 * n), jr(ok, 'passed', 20)]);
      },
      intervalMs: 5,
      iterations: 2,
      stateFile: join(dir, 'page.json'),
    });
    const sum = summarizeMonitorState(st);
    expect(sum.overall).toBe('down');
    expect(sum.counts).toEqual({ up: 1, degraded: 0, down: 1, unknown: 0 });
    expect(sum.journeys[0].journeyId).toBe('evil');
    const html = renderStatusPage(st);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;');
    expect(html).not.toMatch(/<script|src=|href="http/);
    expect(html).toContain('Overall: Down');
    expect(html).not.toContain(SECRET);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    const raw = await readFile(join(dir, 'page.json'), 'utf8');
    expect(raw).not.toContain(SECRET);
  });
});
