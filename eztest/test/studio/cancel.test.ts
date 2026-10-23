/**
 * Run cancellation: a real run against the EZ Shop demo app, cancelled in the
 * middle of a journey. The rest is recorded as skipped, nothing is analyzed,
 * the browser is closed and a new run can start right away.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { runJourneys } from '../../src/runner/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject, readSse, SHOP_ENV_KEYS, type SseEvent } from './helpers.js';

let app: DemoServer;
let studio: StudioHandle;
let project: string;
let c: ReturnType<typeof client>;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  project = await copyShopProject();
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = {
    SHOP_URL: app.url,
    SHOP_DB: join(project, 'shop.db'),
    SHOP_ALICE_PASSWORD: 'Wonderland#1',
    SHOP_ALICE_TOTP: DEMO_TOTP_SECRET,
    SHOP_BOB_PASSWORD: 'Builder#2',
    SHOP_API_CLIENT_SECRET: 'ez-client-secret',
  };
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  studio = await startStudio({ cwd: project, watch: false });
  c = client(studio.port, studio.token);
});

afterAll(async () => {
  await studio?.close();
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('run cancellation', () => {
  it('cancels a run mid-journey: remaining steps and journeys are skipped and the run ends as cancelled', async () => {
    const start = await c.post('/api/runs', { tags: ['orders', 'identity'], heal: false });
    expect(start.status).toBe(202);
    const { id } = start.json();
    let cancelSent = false;
    const events = await readSse(
      studio.port,
      `/api/runs/${id}/events`,
      studio.token,
      (e) => {
        // Cancel as soon as the first step of the first journey has finished.
        if (e.type === 'step:end' && !cancelSent) {
          cancelSent = true;
          void c.del(`/api/runs/${id}`).then((r) => {
            expect(r.status).toBe(202);
            expect(r.json()).toMatchObject({ id, state: 'cancelling' });
          });
        }
        return e.type === 'done';
      },
      180_000,
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('cancelling');
    expect(types).toContain('cancelled');
    expect(types).not.toContain('analysis');
    expect(events.at(-1)).toMatchObject({ type: 'done', state: 'cancelled' });
    const queued = events[0] as SseEvent;
    const totalSteps = (queued.journeys as Array<{ steps: unknown[] }>).reduce((n, j) => n + j.steps.length, 0);
    const ran = events.filter((e) => e.type === 'step:end').length;
    expect(ran).toBeGreaterThanOrEqual(1);
    expect(ran).toBeLessThan(totalSteps);

    // run.json records the cancellation; the browser was closed so a new run starts at once.
    const runJson = JSON.parse(await readFile(join(project, 'eztest-results', id, 'run.json'), 'utf8'));
    const cancelledJourneys = runJson.journeys.filter((j: { error?: { name: string } }) => j.error?.name === 'CancelledError');
    expect(cancelledJourneys.length).toBeGreaterThanOrEqual(1);
    for (const j of cancelledJourneys) expect(j.status).toBe('skipped');
    const skipped = runJson.journeys.flatMap((j: { steps: Array<{ status: string; error?: { message: string } }> }) => j.steps).filter((s: { error?: { message: string } }) => s.error?.message === 'not run: run cancelled');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((s: { status: string }) => s.status === 'skipped')).toBe(true);
    const list = (await c.get('/api/runs')).json();
    expect(list.active).toBeUndefined();
    expect(list.runs.find((r: { runId: string }) => r.runId === id)).toMatchObject({ cancelled: true });
    expect((await c.del(`/api/runs/${id}`)).status).toBe(404);
    const again = await c.post('/api/runs', { tags: ['identity'] });
    expect(again.status).toBe(202);
    const done = await readSse(studio.port, `/api/runs/${again.json().id}/events`, studio.token, (e) => e.type === 'done', 180_000);
    expect(done.at(-1)).toMatchObject({ state: 'done' });
  });

  it('runJourneys honours an already aborted signal without running a step', async () => {
    const journey = parseEzScript(`Journey: Never runs\nOpen ${app.url}/login\n`);
    const ac = new AbortController();
    ac.abort();
    const r = await runJourneys([journey], { outputDir: join(project, 'eztest-results'), signal: ac.signal });
    expect(r.journeys[0]).toMatchObject({ status: 'skipped', error: { name: 'CancelledError' } });
    expect(r.journeys[0].steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(r.summary).toMatchObject({ total: 1, skipped: 1, passed: 0 });
  });
});
