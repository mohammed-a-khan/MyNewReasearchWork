/**
 * EZTest Load engine accuracy: percentiles against a server with a known
 * latency distribution, coordinated omission, ramp (closed model) and
 * arrival-rate (open model) accuracy, HDR histogram precision and merges.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { Histogram, LoadTest, profileCurve, apportion, type LoadResults } from '../../src/load/index.js';
import { latencyServer, latencyServerProcess, scenario, exactPercentile } from './helpers.js';

describe('HDR histogram', () => {
  it('reports percentiles within its precision and merges losslessly', () => {
    const h = new Histogram(3);
    const values = Array.from({ length: 50_000 }, (_, i) => 100 + ((i * 7919) % 250_000));
    for (const v of values) h.recordUs(v);
    for (const p of [50, 90, 95, 99, 99.9]) {
      const exact = exactPercentile(values, p);
      expect(Math.abs(h.percentileUs(p) - exact) / exact).toBeLessThan(0.001 + 1e-9);
    }
    const a = new Histogram();
    const b = new Histogram();
    values.forEach((v, i) => (i % 2 ? a : b).recordUs(v));
    a.add(Histogram.decode(b.encode()));
    expect(a.count).toBe(h.count);
    expect(a.percentileUs(99)).toBe(h.percentileUs(99));
    expect(a.max).toBe(h.max);
    expect(h.footprintBytes).toBeLessThan(200_000);
  });

  it('corrects coordinated omission when asked', () => {
    const h = new Histogram();
    for (let i = 0; i < 99; i++) h.recordUs(1000);
    h.recordCorrected(1_000_000, 10_000); // one 1 s stall with an expected 10 ms interval
    expect(h.count).toBe(99 + 100);
    expect(h.percentileUs(75)).toBeGreaterThan(400_000);
  });
});

describe('profiles', () => {
  it('builds ramp, step, peak, soak and custom curves', () => {
    const ramp = profileCurve({ type: 'ramp', vus: 10, rampUp: '10s', plateau: '5s', rampDown: '5s' });
    expect(ramp.at(5000)).toBe(5);
    expect(ramp.at(12_000)).toBe(10);
    expect(ramp.at(17_500)).toBe(5);
    expect(ramp.durationMs).toBe(20_000);
    const step = profileCurve({ type: 'step', from: 0, step: 5, every: '10s', to: 15, hold: '10s' });
    expect(step.at(5000)).toBe(0);
    expect(step.at(10_000)).toBe(5);
    expect(step.at(25_000)).toBe(10);
    expect(step.at(35_000)).toBe(15);
    const peak = profileCurve({ type: 'peak', base: 2, peak: 20, duration: '60s', peakEvery: '20s', peakFor: '5s' });
    expect(peak.at(10_000)).toBe(2);
    expect(peak.at(17_000)).toBe(20);
    const soak = profileCurve({ type: 'soak', vus: 50, duration: '2h', rampUp: '5m' }, 'closed');
    expect(soak.at(3_600_000)).toBe(50);
    const custom = profileCurve({ type: 'custom', points: [{ at: 0, value: 0 }, { at: '10s', value: 100 }, { at: '20s', value: 0 }] }, 'open');
    expect(custom.integral(20_000) / 1000).toBe(1000);
    expect(apportion(10, [70, 30])).toEqual([7, 3]);
    expect(apportion(5, [1, 1, 1])).toEqual([2, 2, 1]);
    expect(() => profileCurve({ type: 'constant', duration: '1s' })).toThrow(/needs vus/);
  });
});

describe('engine accuracy against a server with known latency', () => {
  // 30% 50 ms, 50% 150 ms, 15% 300 ms, 5% 600 ms  ->  p50 150, p90 300, p99 600, mean 165
  const delays = [...Array(6).fill(50), ...Array(10).fill(150), ...Array(3).fill(300), 600];
  let srv: Awaited<ReturnType<typeof latencyServerProcess>>;
  let r: LoadResults;
  let server: number[];
  beforeAll(async () => {
    // The server runs in its own process and records how long it really took to answer each request.
    srv = await latencyServerProcess(delays);
    const s = scenario({
      baseUrl: srv.url,
      userPaths: { p: { actions: [{ request: { name: 'known', url: '/x' } }] } },
      profile: { type: 'constant', vus: 20, duration: '6s' },
      options: { thinkTimeFactor: 0 },
    });
    r = await new LoadTest(s, { monitors: false }).run();
    server = await srv.measured();
  }, 60_000);
  afterAll(() => srv?.close());

  it('measures p50/p90/p99 and the mean within a tight tolerance', () => {
    const n = r.names.find((x) => x.name === 'known')!;
    expect(n.count).toBeGreaterThan(200);
    expect(n.errors).toBe(0);
    expect(server.length).toBeGreaterThanOrEqual(n.count);
    // 1) against the server's own measurement of each answer: the client adds only the loopback round trip
    const mean = server.reduce((a, b) => a + b, 0) / server.length;
    // the tolerance is 5 ms or 5%, plus the generator's own measured event-loop delay (its health on a
    // shared, busy machine: time the process was not scheduled is time no clock could read)
    const lag = r.totals.generatorLag.medianMs;
    const close = (measured: number, truth: number) => {
      expect(measured).toBeGreaterThanOrEqual(truth - 0.5);
      expect(measured - truth).toBeLessThanOrEqual(Math.max(5, truth * 0.05) + lag);
    };
    expect(lag).toBeGreaterThanOrEqual(0);
    close(n.latency.p50, exactPercentile(server, 50));
    close(n.latency.p90, exactPercentile(server, 90));
    close(n.latency.p99, exactPercentile(server, 99));
    // the mean carries the scheduling noise of a busy machine in its tail: a looser bound
    expect(n.latency.mean - mean).toBeLessThanOrEqual(Math.max(5, mean * 0.1) + r.totals.generatorLag.worstMs);
    expect(n.latency.mean).toBeGreaterThanOrEqual(mean - 0.5);
    // 2) against the nominal distribution (the server's timers can only be late)
    expect(n.latency.p50).toBeGreaterThanOrEqual(150);
    expect(n.latency.p90).toBeGreaterThanOrEqual(300);
    expect(n.latency.p99).toBeGreaterThanOrEqual(600);
    expect(n.latency.p50).toBeLessThan(300);
    expect(n.latency.p90).toBeLessThan(600);
    expect(r.totals.requests).toBe(n.count);
    // per-second timeline adds up
    expect(r.timeline.reduce((a, p) => a + p.requests, 0)).toBe(n.count);
    expect(Math.max(...r.timeline.map((p) => p.vus))).toBe(20);
  });
});

describe('coordinated omission', () => {
  it('counts the queueing behind a stall as latency (open model), unlike the service time', async () => {
    const srv = await latencyServer([5], { stallAt: 40, stallMs: 1000 });
    try {
      const s = scenario({
        baseUrl: srv.url, model: 'open',
        userPaths: { p: { actions: [{ request: { name: 'r', url: '/x' } }] } },
        profile: { type: 'constant', rate: 50, duration: '4s' },
        options: { maxVus: 1, thinkTimeFactor: 0 },
      });
      const r = await new LoadTest(s, { monitors: false }).run();
      const n = r.names.find((x) => x.name === 'r')!;
      expect(n.count).toBeGreaterThan(180);
      expect(r.totals.dropped).toBe(0);
      // ~50 arrivals waited behind the 1 s stall: about a quarter of the samples are slow from their intended start
      expect(n.latency.p90).toBeGreaterThan(300);
      expect(n.latency.max).toBeGreaterThan(950);
      // the service time (what a naive tool reports) hides it
      expect(n.service.p90).toBeLessThan(n.latency.p90 / 3);
    } finally {
      await srv.close();
    }
  }, 30_000);
});

describe('load model accuracy', () => {
  let srv: Awaited<ReturnType<typeof latencyServer>>;
  beforeAll(async () => {
    srv = await latencyServer([2]);
  });
  afterAll(() => srv?.close());

  it('ramps virtual users along the curve (closed model)', async () => {
    const s = scenario({
      baseUrl: srv.url,
      userPaths: { p: { actions: [{ request: { url: '/x' } }, { think: '100ms' }] } },
      profile: { type: 'ramp', vus: 20, rampUp: '4s', plateau: '2s', rampDown: '2s' },
      options: { gracefulStop: '2s' },
    });
    const r = await new LoadTest(s, { monitors: false }).run();
    const curve = profileCurve(s.profile!, 'closed');
    const errs = r.timeline.filter((p) => p.t < 7).map((p) => Math.abs(p.vus - Math.round(curve.at((p.t + 1) * 1000))));
    expect(errs.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...errs)).toBeLessThanOrEqual(1);
    expect(r.totals.maxVus).toBe(20);
  }, 30_000);

  it('starts iterations at the arrival rate (open model), constant and ramping', async () => {
    const s = scenario({
      baseUrl: srv.url, model: 'open',
      userPaths: { p: { actions: [{ request: { url: '/x' } }] } },
      populations: [
        { name: 'steady', userPath: 'p', share: 50, profile: { type: 'constant', rate: 60, duration: '4s' } },
        { name: 'ramping', userPath: 'p', share: 50, profile: { type: 'ramp', rate: 100, rampUp: '4s' } },
      ],
    });
    const r = await new LoadTest(s, { monitors: false }).run();
    // shares halve each population: 30/s for 4 s = 120, ramp to 50/s over 4 s = 100
    expect(Math.abs(r.totals.iterations - 220)).toBeLessThanOrEqual(3);
    const perSec = r.timeline.filter((p) => p.t < 4).map((p) => p.started);
    // seconds 0..3: steady 30 + ramp (6.25, 18.75, 31.25, 43.75)
    [36.25, 48.75, 61.25, 73.75].forEach((want, i) => expect(Math.abs(perSec[i] - want)).toBeLessThanOrEqual(2));
    expect(r.totals.dropped).toBe(0);
  }, 30_000);
});
