/**
 * Adaptive deadlines (src/runner/reliability/load.ts): a polling wait is extended in proportion to
 * the measured load, up to a bound, and says so on the step; nothing changes when the machine is
 * not loaded; event-loop starvation is measured, not assumed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { AdaptiveDeadline, adaptiveTimeout, overrideLoadReading, readLoad, startLoadSampling, type Extension } from '../../src/runner/reliability/load.js';
import { tempDir } from '../runner/fixtures.js';

const reading = (factor: number) => () => ({ factor, starved: 0, cpuBusy: 1, runQueue: factor });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => overrideLoadReading(undefined));

describe('AdaptiveDeadline', () => {
  it('extends a deadline in proportion to the load, once it is due, and records why', async () => {
    overrideLoadReading(reading(2));
    const ext: Extension[] = [];
    const d = new AdaptiveDeadline(300, { what: 'locate the Go button', onExtend: (e) => ext.push(e) });
    expect(await d.reached()).toBe(false);
    await wait(320);
    expect(await d.reached()).toBe(false); // due, but the machine is loaded: 600 ms instead of 300
    expect(ext).toEqual([{ what: 'locate the Go button', baseMs: 300, ms: 600, reason: 'CPUs 100% busy with 2.0 runnable tasks per CPU' }]);
    expect(d.remaining()).toBeGreaterThan(200);
    await wait(d.remaining() + 20);
    expect(await d.reached()).toBe(true);
    expect(ext.length).toBe(1);
  });

  it('is bounded (3x by default) and does nothing on an idle machine or when turned off', async () => {
    overrideLoadReading(reading(10));
    const capped = new AdaptiveDeadline(250, { what: 'x' });
    await wait(260);
    expect(await capped.reached()).toBe(false);
    expect(capped.extendedMs).toBe(750);
    overrideLoadReading(reading(1));
    const idle = new AdaptiveDeadline(250, { what: 'x' });
    await wait(260);
    expect(await idle.reached()).toBe(true);
    overrideLoadReading(reading(3));
    const off = new AdaptiveDeadline(250, { what: 'x', enabled: false });
    await wait(260);
    expect(await off.reached()).toBe(true);
    // Short waits (under 200 ms) are never stretched.
    const short = new AdaptiveDeadline(100, { what: 'x' });
    await wait(110);
    expect(await short.reached()).toBe(true);
  });

  it('scales the timeout of a wait inside the browser driver before it starts', async () => {
    overrideLoadReading(reading(2.5));
    const ext: Extension[] = [];
    expect(await adaptiveTimeout(4000, { what: 'click the Save button', onExtend: (e) => ext.push(e) })).toBe(10_000);
    expect(ext[0]).toMatchObject({ what: 'click the Save button', baseMs: 4000, ms: 10_000 });
    overrideLoadReading(reading(1));
    expect(await adaptiveTimeout(4000, { what: 'x' })).toBe(4000);
  });

  it('measures event-loop starvation (a blocked loop is time a wait did not have)', async () => {
    startLoadSampling();
    await wait(200);
    const from = performance.now();
    const end = Date.now() + 600;
    while (Date.now() < end) {
      // this process cannot run its timers: the sampler sees the ticks fire late
    }
    await wait(100);
    const r = await readLoad(from);
    expect(r.starved).toBeGreaterThan(0.5);
    expect(r.factor).toBeGreaterThan(2);
  });
});

describe('adaptive waits in a journey (real Chromium)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    // The button appears after 1.8 s (a slow page on a busy machine).
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<title>Slow</title><main id="m"></main><script>setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Go'; b.onclick = () => { document.title = 'Went'; }; document.getElementById('m').append(b); }, 1800);</script>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // inline: the load readings are replaced in this process (overrideLoadReading), not in a worker.
  const ez = 'Journey: Slow button\nOpen /\nClick the "Go" button\n  Expect the title is "Went"\n';
  const run = async () => (await runJourneys([parseEzScript(ez)], { baseUrl: base, outputDir: await tempDir('adaptive'), stepTimeoutMs: 5000, locateTimeoutMs: 1000, conditionTimeoutMs: 1000, screenshots: 'off', workers: 'inline' })).journeys[0];

  it('under load the locate wait is extended and the step passes, with a reliability note', async () => {
    overrideLoadReading(reading(3));
    const j = await run();
    expect(j.status).toBe('passed');
    const click = j.steps[1];
    expect(click.reliability?.extended?.[0]).toMatchObject({ what: 'locate the "Go" button', baseMs: 1000, ms: 3000 });
    expect(click.reliability!.extended![0].reason).toMatch(/runnable tasks per CPU/);
  }, 60_000);

  it('without load the same wait keeps its deadline (and fails, as it should)', async () => {
    overrideLoadReading(reading(1));
    const j = await run();
    expect(j.status).toBe('failed');
    expect(j.steps[1].reliability?.extended).toBeUndefined();
  }, 60_000);
});
