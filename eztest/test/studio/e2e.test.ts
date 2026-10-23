/**
 * End to end: the EZ Shop demo app + Studio on a copy of the example project.
 * A run started through the API streams live events over SSE, is analyzed,
 * listed, and its screenshots are served read-only under /runs/<runId>/.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { join } from 'node:path';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject, raw, readSse, SHOP_ENV_KEYS, type SseEvent } from './helpers.js';

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
  // The identity env store reads process.env, as in the CLI end-to-end test.
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  studio = await startStudio({ cwd: project, recordHeadless: true });
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

describe('Studio end to end (shop project)', () => {
  it('runs journeys through the API with live SSE progress, analysis and readiness', async () => {
    const start = await c.post('/api/runs', { tags: ['smoke', 'api'], heal: true });
    expect(start.status).toBe(202);
    const { id } = start.json();
    expect(id).toMatch(/^run-/);

    // Only one run at a time; cancelling another id is a 404 (cancellation itself: cancel.test.ts).
    expect((await c.post('/api/runs', {})).status).toBe(409);
    const cancel = await c.del('/api/runs/run-not-this-one');
    expect(cancel.status).toBe(404);

    const events = await readSse(studio.port, `/api/runs/${id}/events`, studio.token, (e) => e.type === 'done', 180_000);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('queued');
    expect(types).toEqual(expect.arrayContaining(['run:start', 'journey:start', 'step:start', 'step:end', 'journey:end', 'run:end', 'analysis', 'done']));
    const stepEnds = events.filter((e) => e.type === 'step:end');
    expect(stepEnds.length).toBeGreaterThanOrEqual(3);
    expect(stepEnds.every((e) => ['passed', 'passed-healed'].includes(e.status))).toBe(true);
    const analysis = events.find((e) => e.type === 'analysis') as SseEvent;
    expect(analysis.summary).toMatchObject({ total: 3, failed: 0, errors: 0 });
    expect(analysis.readiness.decision).toBe('GO');
    expect(analysis.report).toBe(`/runs/${id}/report.html`);
    // Secrets never leave through the event stream.
    expect(JSON.stringify(events)).not.toContain('Wonderland#1');

    // A late subscriber gets the full replay.
    const replay = await readSse(studio.port, `/api/runs/${id}/events`, studio.token, (e) => e.type === 'done');
    expect(replay.map((e) => e.type)).toEqual(types);

    // Runs list and run detail.
    const list = (await c.get('/api/runs')).json();
    expect(list.active).toBeUndefined();
    expect(list.runs[0]).toMatchObject({ runId: id, hasReport: true, summary: { total: 3, failed: 0 } });
    const detail = (await c.get(`/api/runs/${id}`)).json();
    expect(detail.verification.ok).toBe(true);
    expect(detail.insights.readiness.decision).toBe('GO');
    expect(detail.run.journeys).toHaveLength(3);

    // Screenshots are served read-only with the right content type.
    const shot = Object.values(detail.evidence as Record<string, { kind: string; path: string }>).find((e) => e.kind === 'screenshot');
    expect(shot).toBeDefined();
    const img = await raw(studio.port, `/runs/${id}/${shot!.path}`, { headers: { cookie: `eztest_studio=${studio.token}` } });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-security-policy']).toMatch(/sandbox/);
    const report = await raw(studio.port, `/runs/${id}/report.html`, { headers: { cookie: `eztest_studio=${studio.token}` } });
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toMatch(/text\/html/);
    expect(report.headers['content-security-policy']).toMatch(/connect-src 'none'/);
    expect((await c.put(`/runs/${id}/run.json`, {})).status).toBe(405);

    // Insights now have history.
    const ins = (await c.get('/api/insights')).json();
    expect(ins.flaky.length).toBeGreaterThanOrEqual(3);
    expect(ins.trend.at(-1)).toMatchObject({ runId: id, total: 3 });
    expect(ins.latest.runId).toBe(id);
  });

  it('streams verified heals as passed-healed with their tier (renamed UI, variant b)', async () => {
    await app.close();
    app = await startDemoApp({ variant: 'b', dbFile: join(project, 'shop.db') });
    process.env.SHOP_URL = app.url;
    const { id } = (await c.post('/api/runs', { tags: ['orders'] })).json();
    const events = await readSse(studio.port, `/api/runs/${id}/events`, studio.token, (e) => e.type === 'done', 180_000);
    const heals = events.filter((e) => e.type === 'heal');
    expect(heals.length).toBeGreaterThan(0);
    expect(heals.every((h) => /^T\d-/.test(h.tier) && h.verified === true)).toBe(true);
    expect(events.some((e) => e.type === 'step:end' && e.status === 'passed-healed')).toBe(true);
    const analysis = events.find((e) => e.type === 'analysis') as SseEvent;
    expect(analysis.summary).toMatchObject({ failed: 0, passedHealed: 1 });
    const detail = (await c.get(`/api/runs/${id}`)).json();
    expect(detail.healProposals.proposals.length).toBeGreaterThan(0);
    expect(detail.healProposals.proposals[0].healed.value).toBeTruthy();
  });

  it('records a journey headlessly, streams recorded lines and saves it', async () => {
    const r = await c.post('/api/record', { url: `${app.url}/login`, name: 'Recorded in studio', tags: ['studio'] });
    expect(r.status).toBe(201);
    expect((await c.post('/api/record', { url: `${app.url}/login` })).status).toBe(409);
    await c.post('/api/record/expect', { text: 'the page contains "Sign in"' });
    const stop = await c.post('/api/record/stop', {});
    expect(stop.status).toBe(200);
    const result = stop.json().result;
    expect(result.ez).toMatch(/^Journey: Recorded in studio/m);
    expect(result.ez).toMatch(/\/login/);
    expect(result.ez).toMatch(/Sign in/);
    const events = await readSse(studio.port, '/api/record/events', studio.token, (e) => e.type === 'stopped');
    expect(events.map((e) => e.type)).toContain('started');
    expect(events.some((e) => e.type === 'line')).toBe(true);
    const save = await c.put('/api/file', { path: `journeys/${result.suggestedPath}`, content: result.ez, create: true });
    expect(save.status).toBe(200);
    expect(save.json().validation.ok).toBe(true);
    expect((await c.post('/api/record', { url: 'file:///etc/passwd' })).status).toBe(400);
  });
});
