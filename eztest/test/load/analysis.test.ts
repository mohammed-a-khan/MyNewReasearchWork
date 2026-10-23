/**
 * Automatic analysis: the response-time knee against load (synthetic and on
 * a real server that saturates), resource saturation correlated with
 * latency, baseline regressions and trends.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { compareRuns, detectKnee, loadLevels, LoadTest, saturation, trend, type MonitorSeries, type NameStats, type TimelinePoint } from '../../src/load/index.js';
import { scenario } from './helpers.js';

const point = (t: number, vus: number, p90: number, rps: number): TimelinePoint => ({ t, at: t * 1000, vus, requests: rps, rps, errors: 0, iterations: rps, started: rps, dropped: 0, bytesIn: 0, bytesOut: 0, latency: { mean: p90 * 0.8, p50: p90 * 0.7, p90, p95: p90 * 1.1, p99: p90 * 1.3, max: p90 * 1.5 }, rows: [], errorsByType: {}, populations: {} });

describe('knee and saturation (synthetic)', () => {
  it('finds the knee where p90 starts to climb and throughput stops scaling', () => {
    const tl: TimelinePoint[] = [];
    let t = 0;
    for (let vus = 10; vus <= 120; vus += 10) {
      const p90 = vus <= 60 ? 50 + vus * 0.2 : 62 + (vus - 60) * 6;
      const rps = Math.min(vus, 60) * 10;
      for (let k = 0; k < 3; k++) tl.push(point(t++, vus, p90, rps));
    }
    const knee = detectKnee(loadLevels(tl));
    expect(knee.found).toBe(true);
    expect(knee.load).toBeGreaterThanOrEqual(50);
    expect(knee.load).toBeLessThanOrEqual(70);
    expect(knee.slopeAfter!).toBeGreaterThan(knee.slopeBefore! * 3);
    // flat latency: no knee
    const flat = tl.map((p) => ({ ...p, latency: { ...p.latency!, p90: 50 + (p.t % 3) } }));
    expect(detectKnee(loadLevels(flat)).found).toBe(false);
  });

  it('flags a saturated, latency-correlated resource', () => {
    const tl = Array.from({ length: 30 }, (_, t) => point(t, 10 + t, 40 + (t > 15 ? (t - 15) * 30 : 0), 100));
    const monitors: MonitorSeries[] = [{ name: 'db host', type: 'host', points: tl.map((p) => ({ t: p.t, at: p.at, values: { cpuPercent: Math.min(99, 40 + p.t * 3), memUsedPercent: 50 } })), errors: [] }];
    const f = saturation(tl, monitors);
    const cpu = f.find((x) => x.metric === 'db host/cpuPercent');
    expect(cpu?.kind).toBe('saturation');
    expect(cpu?.severity).toBe('high');
    expect(f.some((x) => x.metric === 'db host/memUsedPercent')).toBe(false);
  });

  it('compares with a baseline and computes trends', () => {
    const n = (name: string, p95: number, errorRate = 0, throughput = 10): NameStats => ({ kind: 'transaction', name, count: 100, errors: errorRate * 100, errorRate, throughput, bytesIn: 0, bytesOut: 0, latency: { count: 100, min: 1, mean: p95 * 0.7, p50: p95 * 0.6, p75: p95 * 0.8, p90: p95 * 0.9, p95, p99: p95 * 1.2, p999: p95 * 1.3, max: p95 * 1.5, stdDev: 1 }, service: { count: 100, min: 1, mean: 1, p50: 1, p75: 1, p90: 1, p95: 1, p99: 1, p999: 1, max: 1, stdDev: 0 }, statusCodes: {}, errorsByType: {} });
    const c = compareRuns({ runId: 'a', names: [n('login', 200), n('search', 300), n('pay', 100)] }, { runId: 'b', names: [n('login', 210), n('search', 450), n('pay', 100, 0.05), n('new', 10)] });
    expect(c.rows.find((r) => r.name === 'login')!.verdict).toBe('unchanged');
    expect(c.rows.find((r) => r.name === 'search')!.verdict).toBe('regression');
    expect(c.rows.find((r) => r.name === 'pay')!.reasons.join()).toMatch(/error rate/);
    expect(c.rows.find((r) => r.name === 'new')!.verdict).toBe('new');
    expect(c.regressions).toBe(2);
    const tr = trend([100, 120, 140, 160].map((p95, i) => ({ runId: `r${i}`, at: '', scenario: 's', verdict: 'pass', rps: 10, errorRate: 0, p95, names: { 'transaction:search': { p95, errorRate: 0, count: 10 }, 'transaction:home': { p95: 50, errorRate: 0, count: 10 } } })));
    expect(tr.series.find((s) => s.name === 'transaction:search')).toMatchObject({ direction: 'worse', slope: 20 });
    expect(tr.series.find((s) => s.name === 'transaction:home')!.direction).toBe('flat');
  });
});

const SATURATING_SERVER = `
const http = require('node:http');
let inflight = 0;
// A pool of 10 workers: 5 ms per request up to 10 concurrent requests, then 25 ms more per extra request (queueing).
const s = http.createServer((req, res) => {
  inflight++;
  const ms = 5 + Math.max(0, inflight - 10) * 25;
  setTimeout(() => {
    inflight--;
    res.end('ok');
  }, ms);
});
s.keepAliveTimeout = 60000;
s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));
`;

describe('knee on a server that saturates', () => {
  let child: ChildProcess;
  let base: string;
  beforeAll(async () => {
    child = spawn(process.execPath, ['-e', SATURATING_SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise<number>((r) => child.stdout!.once('data', (b: Buffer) => r(Number(b.toString().trim()))));
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => {
    child?.kill();
  });

  it('reports the knee and the throughput plateau', async () => {
    // with little think time, concurrency follows the VUs: the server's pool of 10 saturates at about 10 VUs
    const r = await new LoadTest(scenario({ baseUrl: base, userPaths: { p: { actions: [{ request: { url: '/' } }, { think: '5ms' }] } }, profile: { type: 'step', from: 2, step: 2, every: '1500ms', to: 24, hold: '1500ms' } }), { monitors: false }).run();
    if (!r.analysis.knee.found) throw new Error(`no knee in ${JSON.stringify(r.analysis.knee)}`);
    expect(r.analysis.knee.load).toBeGreaterThanOrEqual(6);
    expect(r.analysis.knee.load).toBeLessThanOrEqual(16);
    expect(r.analysis.findings.some((f) => f.kind === 'knee')).toBe(true);
    expect(r.analysis.findings.some((f) => f.kind === 'throughput-plateau')).toBe(true);
  }, 60_000);
});
