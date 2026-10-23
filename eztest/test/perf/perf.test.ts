import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { chromium, type Browser } from '../../src/browser/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import {
  installWebVitals,
  collectWebVitals,
  WebVitalsCollector,
  evaluateBudgets,
  DEFAULT_VITAL_BUDGETS,
  runLoad,
  LatencyHistogram,
  percentile,
  type NetworkEntry,
} from '../../src/perf/index.js';

let demo: DemoServer;
let browser: Browser;

beforeAll(async () => {
  demo = await startDemoApp();
  demo.db.exec(`INSERT INTO orders (customer_id, created_by, status, total, created_at) VALUES (1, 'bob', 'Submitted', 19.99, '2026-10-01T00:00:00Z')`);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await demo?.close();
});

describe('web vitals', () => {
  it('collects LCP, FCP, TTFB, CLS and INP in real Chromium', async () => {
    const page = await browser.newPage();
    const c = new WebVitalsCollector();
    await c.install(page);
    await page.goto(demo.url + '/login');
    // a slow click handler produces a measurable interaction
    await page.evaluate(`document.querySelector('h1').addEventListener('click', function () { var t = performance.now(); while (performance.now() - t < 120) {} document.querySelector('h1').textContent += '!'; })`);
    await page.locator('h1').click();
    await page.waitForTimeout(300);
    const v = await c.collect(page);
    expect(v.url).toContain('/login');
    expect(v.FCP).toBeGreaterThan(0);
    expect(v.LCP).toBeGreaterThan(0);
    expect(v.TTFB).not.toBeNull();
    expect(v.TTFB!).toBeGreaterThanOrEqual(0);
    expect(v.CLS).toBeGreaterThanOrEqual(0);
    expect(v.interactions).toBeGreaterThanOrEqual(1);
    expect(v.INP).toBeGreaterThanOrEqual(100);
    const budgets = evaluateBudgets({ vitals: v }, { vitals: { ...DEFAULT_VITAL_BUDGETS, INP: { warn: 50, error: 100 } } });
    expect(budgets.items.find((i) => i.metric === 'INP')!.status).toBe('fail');
    expect(budgets.items.find((i) => i.metric === 'LCP')!.status).toBe('pass');
    expect(budgets.status).toBe('fail');
    await page.close();
  });

  it('refuses to collect when not installed', async () => {
    const page = await browser.newPage();
    await page.goto(demo.url + '/login');
    await expect(collectWebVitals(page)).rejects.toThrow(/not installed/);
    await installWebVitals(page);
    await page.close();
  });
});

describe('budgets', () => {
  const net: NetworkEntry[] = [
    ...Array.from({ length: 19 }, (_, i) => ({ method: 'GET', url: 'http://a.test/api/orders', status: 200, timing: 100 + i })),
    { method: 'GET', url: 'http://a.test/api/orders', status: 500, timing: 900 },
  ];
  it('evaluates API p50/p95/max/errorRate with warn/error thresholds', () => {
    const r = evaluateBudgets(
      { network: net },
      { api: [{ name: 'orders', match: 'a.test/api/**', method: 'GET', p50: { warn: 150 }, p95: { warn: 115, error: 500 }, max: { error: 800 }, errorRate: { warn: 0.01, error: 0.1 } }] },
      { journeyId: 'checkout' },
    );
    const by = Object.fromEntries(r.items.map((i) => [i.metric, i]));
    expect(by['orders p50'].status).toBe('pass');
    expect(by['orders p95'].status).toBe('warn');
    expect(by['orders max'].status).toBe('fail');
    expect(by['orders errorRate'].status).toBe('warn');
    expect(by['orders errorRate'].journeyId).toBe('checkout');
    expect(r.status).toBe('fail');
  });
  it('missing measurements are no-data, and empty budgets throw', () => {
    const r = evaluateBudgets({}, { vitals: { LCP: { warn: 1 } }, api: [{ match: 'x.test/**', p95: { error: 1 } }] });
    expect(r.items.every((i) => i.status === 'no-data')).toBe(true);
    expect(r.status).toBe('no-data');
    expect(() => evaluateBudgets({}, {})).toThrow(/no budgets/);
    expect(() => evaluateBudgets({}, { vitals: { LCP: { warn: 5, error: 1 } } })).toThrow(/warn threshold/);
  });
});

describe('histogram', () => {
  it('approximates percentiles within ~1% with bounded memory', () => {
    const h = new LatencyHistogram();
    const values = Array.from({ length: 20000 }, (_, i) => 1 + ((i * 7919) % 1000) / 3);
    for (const v of values) h.record(v);
    for (const p of [50, 90, 95, 99]) {
      const exact = percentile(values, p);
      expect(Math.abs(h.percentile(p) - exact) / exact).toBeLessThan(0.015);
    }
    expect(LatencyHistogram.footprintBytes).toBeLessThan(16_000);
    expect(() => new LatencyHistogram().percentile(50)).toThrow();
  });
});

describe('in-process load runner', () => {
  it('closed model against the demo app', async () => {
    const s = await runLoad({ request: { url: demo.url + '/login' }, vus: 4, durationMs: 400 });
    expect(s.model).toBe('closed');
    expect(s.iterations).toBeGreaterThan(10);
    expect(s.errorRate).toBe(0);
    const l = s.latencyMs;
    expect(l.min).toBeLessThanOrEqual(l.p50);
    expect(l.p50).toBeLessThanOrEqual(l.p90);
    expect(l.p90).toBeLessThanOrEqual(l.p95);
    expect(l.p95).toBeLessThanOrEqual(l.p99);
    expect(l.p99).toBeLessThanOrEqual(l.max);
  });

  it('open model with arrival rate, and error accounting', async () => {
    const s = await runLoad({ request: { url: demo.url + '/api/orders' }, arrivalRate: { perSecond: 50 }, durationMs: 500 });
    expect(s.model).toBe('open');
    expect(s.iterations).toBeGreaterThanOrEqual(20);
    expect(s.iterations).toBeLessThanOrEqual(30);
    expect(s.errorRate).toBe(1); // no token -> 401
    expect(s.errorSamples[0]).toBe('HTTP 401');
    const dropped = await runLoad({ iteration: () => new Promise((r) => setTimeout(r, 200)), arrivalRate: { perSecond: 100, maxInFlight: 2 }, durationMs: 200 });
    expect(dropped.dropped).toBeGreaterThan(10);
    const it3 = await runLoad({ iteration: async () => {}, iterations: 7, vus: 3 });
    expect(it3.iterations).toBe(7);
    await expect(runLoad({ request: { url: demo.url } })).rejects.toThrow(/durationMs or iterations/);
    await expect(runLoad({ durationMs: 10 })).rejects.toThrow(/exactly one/);
  });
});
