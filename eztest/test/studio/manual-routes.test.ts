/**
 * Test management and coverage routes over HTTP (no browser): the session
 * token and write rules, case preview/save validation and conflicts,
 * verdict validation (status, tester, notes for failures, attachment types and
 * magic bytes), ending a run, plans validation, reference-file confinement,
 * and the coverage endpoints without snapshots.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject, raw } from './helpers.js';

let studio: StudioHandle;
let project: string;
let c: ReturnType<typeof client>;

beforeAll(async () => {
  project = await copyShopProject();
  await mkdir(join(project, 'docs'), { recursive: true });
  await writeFile(join(project, 'docs', 'policy.txt'), 'Refunds within 30 days.');
  await writeFile(join(project, '.env'), 'SECRET=1');
  studio = await startStudio({ cwd: project, env: { ...process.env, SHOP_URL: 'http://127.0.0.1:9' }, watch: false });
  c = client(studio.port, studio.token);
});
afterAll(async () => studio?.close());

const model = { name: 'Check the refund policy', assignee: 'Quinn', requirements: ['POL-1'], steps: [{ instruction: 'Open the policy page', expected: ['It says 30 days'], attachments: ['docs/policy.txt'] }] };

describe('manual routes', () => {
  it('needs the session token; writes need confirm', async () => {
    expect((await raw(studio.port, '/api/manual/cases')).status).toBe(401);
    expect((await c.put('/api/manual/case', { case: model })).status).toBe(400);
  });

  it('previews, saves (refusing duplicates) and reads a case back into the form', async () => {
    const pv = await c.post('/api/manual/case/preview', { case: model });
    expect(pv.status, pv.body).toBe(200);
    expect(pv.json()).toMatchObject({ id: 'check-the-refund-policy', manualSteps: 1, kind: 'manual' });
    expect((await c.post('/api/manual/case/preview', { case: { name: 'x', steps: [{ automated: 'Frobnicate' }] } })).status).toBe(422);
    const saved = await c.put('/api/manual/case', { case: model, confirm: true });
    expect(saved.status, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ path: 'journeys/manual/check-the-refund-policy.ez', created: true });
    expect((await c.put('/api/manual/case', { case: model, confirm: true })).status).toBe(409);
    // the same id elsewhere is refused too
    expect((await c.put('/api/manual/case', { case: { ...model, name: 'Bob signs in', id: 'sales-rep-signs-in-with-mfa' }, confirm: true })).status).toBe(409);
    const read = (await c.get('/api/manual/case?path=journeys/manual/check-the-refund-policy.ez')).json();
    expect(read.model).toMatchObject({ name: 'Check the refund policy', assignee: 'Quinn', requirements: ['POL-1'] });
    expect(read.steps).toEqual([{ id: 'manual-open-the-policy-page', manual: true, text: 'Open the policy page', expected: ['It says 30 days'] }]);
    expect((await c.get('/api/manual/case?path=../outside.ez')).status).toBe(403);
    const list = (await c.get('/api/manual/cases')).json();
    expect(list.cases.map((x: { id: string }) => x.id)).toEqual(['check-the-refund-policy']);
    expect(list.testers).toEqual(['Quinn']);
  });

  it('serves reference files confined to the project, never sensitive ones', async () => {
    const ok = await c.get('/api/manual/reference?path=docs/policy.txt');
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('Refunds within 30 days.');
    expect(String(ok.headers['content-security-policy'])).toMatch(/^sandbox/);
    expect((await c.get('/api/manual/reference?path=.env')).status).toBe(403);
    expect((await c.get('/api/manual/reference?path=../../etc/passwd')).status).toBe(403);
    expect((await c.get('/api/manual/reference?path=eztest.config.yaml')).status).toBe(415);
  });

  it('validates verdicts and answers a waiting step; ending a run releases its steps', async () => {
    const run = await c.post('/api/manual/run', { journeys: ['check-the-refund-policy'], tester: 'Quinn' });
    expect(run.status, run.body).toBe(202);
    const id = run.json().id as string;
    let pending: Array<{ key: string; request: { instruction: string; attachments: string[] } }> = [];
    for (let i = 0; i < 100 && !pending.length; i++) {
      pending = (await c.get(`/api/manual/pending?run=${id}`)).json().pending;
      if (!pending.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending[0].request).toMatchObject({ instruction: 'Open the policy page', attachments: ['docs/policy.txt'] });
    const key = pending[0].key;
    const bad = async (body: Record<string, unknown>, status: number, msg: RegExp) => {
      const r = await c.post('/api/manual/verdict', { key, ...body });
      expect(r.status, r.body).toBe(status);
      expect(r.json().error).toMatch(msg);
    };
    await bad({ status: 'great', tester: 'Q' }, 400, /status must be/);
    await bad({ status: 'passed' }, 400, /tester name is required/);
    await bad({ status: 'failed', tester: 'Q' }, 400, /needs notes/);
    await bad({ status: 'passed', tester: 'Q', attachments: [{ name: 'x.exe', contentType: 'application/x-msdownload', data: 'AAAA' }] }, 415, /not accepted/);
    await bad({ status: 'passed', tester: 'Q', attachments: [{ name: 'x.png', contentType: 'image/png', data: Buffer.from('not a png').toString('base64') }] }, 400, /not a PNG/);
    expect((await c.post('/api/manual/verdict', { key: 'nope', status: 'passed', tester: 'Q' })).status).toBe(409);
    // the session view shows the waiting step
    const s = (await c.get(`/api/manual/session/${id}`)).json();
    expect(s.pending).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ id: 'check-the-refund-policy', type: 'manual' });
    // end the run: the step is recorded as not executed
    expect((await c.post('/api/manual/end', { runId: id })).json()).toMatchObject({ released: 1 });
    for (let i = 0; i < 100; i++) {
      if ((await c.get(`/api/manual/session/${id}`)).json().state === 'done') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const result = JSON.parse(await readFile(join(project, 'eztest-results', id, 'run.json'), 'utf8'));
    expect(result.journeys[0]).toMatchObject({ status: 'skipped', manual: { executed: 0, pending: 1 } });
    expect(result.journeys[0].steps[0].manual.verdict).toBe('pending');
  });

  it('validates and saves plans; a cycle run needs open cases', async () => {
    expect((await c.put('/api/manual/plans', { plans: { suites: [{ id: 'a b', name: 'x' }] }, confirm: true })).status).toBe(422);
    const ok = await c.put('/api/manual/plans', { plans: { suites: [{ id: 's', name: 'S', cases: ['check-the-refund-policy'] }], cycles: [{ id: 'c1', name: 'C1', suites: ['s'], state: 'closed' }] }, confirm: true });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json().progress[0]).toMatchObject({ total: 1, counts: { untested: 1 } });
    expect((await c.post('/api/manual/cycles/c1/run', { tester: 'Quinn' })).status).toBe(409);
    expect((await c.post('/api/manual/cycles/nope/run', {})).status).toBe(404);
    const d = (await c.get('/api/manual/dashboard?tester=Quinn')).json();
    expect(d.cycles).toEqual([]);
  });

  it('coverage endpoints answer without snapshots', async () => {
    const o = await c.get('/api/quality/coverage');
    expect(o.status, o.body).toBe(200);
    const ui = o.json().combined.dimensions.find((x: { id: string }) => x.id === 'ui');
    expect(ui.status).toBe('no-data');
    expect((await c.get('/api/quality/coverage/overlay?route=%2Fnope')).status).toBe(404);
    expect((await c.get('/api/quality/coverage/overlay')).status).toBe(400);
    expect((await c.get('/api/quality/coverage/trend')).json()).toMatchObject({ ui: [] });
    expect((await c.get('/api/quality/coverage/export.csv')).body.split('\n')[0]).toBe('page,role,element,count,tested,interactions,assertions,journeys');
  });
});
