/**
 * Several generator processes per load generator (docs/load.md, "Generators"): the same accuracy
 * as one generator against a server that measures itself, VU counts and arrival rates that add
 * up exactly, arrivals spread like one generator's (not N at the same instant), coordinated
 * omission still counted, and exact interval merging.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { Histogram } from '../../src/load/histogram.js';
import { mergeIntervals, MetricsCollector } from '../../src/load/metrics.js';
import { LoadTest, profileCurve, type LoadResults } from '../../src/load/index.js';
import { exactPercentile, latencyServer, latencyServerProcess, scenario } from './helpers.js';

/** A server that keeps the arrival time (ms, high resolution) of every request. */
async function arrivalServer(): Promise<{ url: string; arrivals: number[]; close(): Promise<void> }> {
  const arrivals: number[] = [];
  const server: Server = createServer((req, res) => {
    arrivals.push(performance.now());
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' });
    res.end('{}');
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    arrivals,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

describe('generator processes: accuracy against a server with known latency', () => {
  const delays = [...Array(6).fill(50), ...Array(10).fill(150), ...Array(3).fill(300), 600];
  let srv: Awaited<ReturnType<typeof latencyServerProcess>>;
  let r: LoadResults;
  let server: number[];
  beforeAll(async () => {
    srv = await latencyServerProcess(delays);
    const s = scenario({
      baseUrl: srv.url,
      userPaths: { p: { actions: [{ request: { name: 'known', url: '/x' } }] } },
      profile: { type: 'constant', vus: 20, duration: '6s' },
      options: { thinkTimeFactor: 0 },
    });
    r = await new LoadTest(s, { monitors: false, generators: 3 }).run();
    server = await srv.measured();
  }, 60_000);
  afterAll(() => srv?.close());

  it('merges the generators exactly: counts match the server, percentiles match its own measurement', () => {
    const n = r.names.find((x) => x.name === 'known')!;
    expect(r.generators).toBe(3);
    expect(n.count).toBeGreaterThan(200);
    expect(n.errors).toBe(0);
    // every request the generators recorded was answered by the server (it may count a few the graceful stop cut off)
    expect(server.length).toBeGreaterThanOrEqual(n.count);
    expect(server.length - n.count).toBeLessThanOrEqual(20);
    const lag = r.totals.generatorLag.medianMs;
    const close = (measured: number, truth: number) => {
      expect(measured).toBeGreaterThanOrEqual(truth - 0.5);
      expect(measured - truth).toBeLessThanOrEqual(Math.max(5, truth * 0.05) + lag);
    };
    close(n.latency.p50, exactPercentile(server, 50));
    close(n.latency.p90, exactPercentile(server, 90));
    close(n.latency.p99, exactPercentile(server, 99));
    expect(r.totals.requests).toBe(n.count);
    expect(r.timeline.reduce((a, p) => a + p.requests, 0)).toBe(n.count);
    // 20 VUs over 3 generators (7 + 7 + 6): the merged count is exactly the profile's
    expect(Math.max(...r.timeline.map((p) => p.vus))).toBe(20);
    expect(r.totals.maxVus).toBe(20);
  });
});

describe('generator processes: load model', () => {
  let srv: Awaited<ReturnType<typeof latencyServer>>;
  beforeAll(async () => {
    srv = await latencyServer([2]);
  });
  afterAll(() => srv?.close());

  it('closed model: the generators\' VUs add up to the curve every second', async () => {
    const s = scenario({
      baseUrl: srv.url,
      userPaths: { p: { actions: [{ request: { url: '/x' } }, { think: '100ms' }] } },
      profile: { type: 'ramp', vus: 21, rampUp: '4s', plateau: '2s', rampDown: '2s' },
      options: { gracefulStop: '2s' },
    });
    const r = await new LoadTest(s, { monitors: false, generators: 4 }).run();
    const curve = profileCurve(s.profile!, 'closed');
    const errs = r.timeline.filter((p) => p.t < 7).map((p) => Math.abs(p.vus - Math.round(curve.at((p.t + 1) * 1000))));
    expect(errs.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...errs)).toBeLessThanOrEqual(1);
    expect(r.totals.maxVus).toBe(21);
  }, 30_000);

  it('open model: the arrival rate is exact and arrivals interleave like one generator\'s', async () => {
    const a = await arrivalServer();
    try {
      const s = scenario({
        baseUrl: a.url, model: 'open',
        userPaths: { p: { actions: [{ request: { url: '/x' } }] } },
        profile: { type: 'constant', rate: 80, duration: '4s' },
      });
      const r = await new LoadTest(s, { monitors: false, generators: 4 }).run();
      expect(Math.abs(r.totals.iterations - 320)).toBeLessThanOrEqual(2);
      expect(r.totals.dropped).toBe(0);
      for (const p of r.timeline.filter((x) => x.t < 4)) expect(Math.abs(p.started - 80)).toBeLessThanOrEqual(3);
      expect(a.arrivals.length).toBe(r.totals.requests);
      // 80/s from 4 generators: one arrival every 12.5 ms. Phased generators keep that spacing; unphased ones
      // would send 4 requests at the same instant every 50 ms (3 of every 4 gaps near 0).
      const gaps = a.arrivals.slice(1).map((t, i) => t - a.arrivals[i]).sort((x, y) => x - y);
      const tight = gaps.filter((g) => g < 2).length / gaps.length;
      expect(tight).toBeLessThan(0.3);
      expect(gaps[Math.floor(gaps.length / 2)]).toBeGreaterThan(6);
    } finally {
      await a.close();
    }
  }, 30_000);

  it('coordinated omission: the queue behind a stall on one generator still counts as latency', async () => {
    const stall = await latencyServer([5], { stallAt: 40, stallMs: 1000 });
    try {
      const s = scenario({
        baseUrl: stall.url, model: 'open',
        userPaths: { p: { actions: [{ request: { name: 'r', url: '/x' } }] } },
        profile: { type: 'constant', rate: 50, duration: '4s' },
        options: { maxVus: 2, thinkTimeFactor: 0 },
      });
      const r = await new LoadTest(s, { monitors: false, generators: 2 }).run();
      const n = r.names.find((x) => x.name === 'r')!;
      expect(n.count).toBeGreaterThan(180);
      expect(r.totals.dropped).toBe(0);
      // one generator's single VU sat behind the 1 s stall: ~25 of its arrivals waited, measured from their intended start
      expect(n.latency.p95).toBeGreaterThan(300);
      expect(n.latency.max).toBeGreaterThan(950);
      expect(n.service.p95).toBeLessThan(n.latency.p95 / 3);
    } finally {
      await stall.close();
    }
  }, 30_000);
});

describe('interval merge', () => {
  it('is exact: merging per-generator seconds equals recording every sample in one collector', () => {
    const one = new MetricsCollector();
    const parts = [new MetricsCollector(), new MetricsCollector(), new MetricsCollector()];
    for (let i = 0; i < 3000; i++) {
      const s = { name: i % 7 ? 'a' : 'b', kind: 'request' as const, population: 'p', ok: i % 13 !== 0, latencyUs: 1000 + ((i * 7919) % 250_000), bytesIn: 10 };
      one.record(s);
      parts[i % 3].record(s);
    }
    const merged = mergeIntervals(parts.map((m) => m.drainInterval(0, 1)));
    const single = one.drainInterval(0, 3);
    expect(merged.vus).toBe(3);
    for (const k of single.keys) {
      const m = merged.keys.find((x) => x.k === k.k && x.name === k.name)!;
      expect({ n: m.n, e: m.e, bin: m.bin }).toEqual({ n: k.n, e: k.e, bin: k.bin });
      const a = Histogram.decode(m.h);
      const b = Histogram.decode(k.h);
      for (const p of [50, 90, 99, 99.9]) expect(a.percentileUs(p)).toBe(b.percentileUs(p));
      expect([a.count, a.min, a.max, a.sum]).toEqual([b.count, b.min, b.max, b.sum]);
    }
  });
});
