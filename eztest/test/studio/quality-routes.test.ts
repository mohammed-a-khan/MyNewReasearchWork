/**
 * Quality Center routes over fabricated runs (no browser): heal inbox, accept
 * (hash-checked writes) and reject, triage reclassification and Azure DevOps
 * bugs (mock server: create, attachments, dedupe), quarantine validation,
 * readiness policy editing, compare, trends, traceability exports.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { EvidenceVault, summarize, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { HealDecisions } from '../../src/heal/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject } from './helpers.js';

const ORDER = 'create-an-order-and-verify-the-invoice-three-ways';
const LOGIN = 'sales-rep-signs-in-with-mfa';
const SUBMIT = 'click-the-submit-order-button';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const placeOrder = { strategy: 'role' as const, value: 'button', name: 'Place order', exact: true };

let studio: StudioHandle;
let project: string;
let c: ReturnType<typeof client>;
let ado: Server;
const adoReqs: Array<{ method: string; path: string; type?: string; size: number }> = [];
const adoBugs: Array<{ id: number; tags: string }> = [];

async function fabricate(runId: string, startedAt: string, journeys: Array<{ id: string; name: string; status: JourneyResult['status']; healed?: boolean; error?: string; risk?: number; tags?: string[] }>): Promise<void> {
  const dir = join(project, 'eztest-results', runId);
  const vault = new EvidenceVault(dir);
  await vault.init();
  const results: JourneyResult[] = [];
  for (const j of journeys) {
    const shot = await vault.store('screenshot', `screenshots/${j.id}.png`, PNG, { journeyId: j.id, stepId: SUBMIT, description: `${j.id} step` });
    const failed = j.status === 'failed';
    results.push({
      journeyId: j.id, name: j.name, status: j.status, startedAt, durationMs: j.status === 'failed' ? 3000 : 1200, tags: j.tags ?? ['orders'], requirements: j.id === ORDER ? ['ORD-1'] : ['AUTH-1'], risk: j.risk ?? 5, attempt: 1, ledger: {}, evidence: [],
      steps: [{
        stepId: SUBMIT, intent: 'Click the "Submit order" button', status: j.healed ? 'passed-healed' : failed ? 'failed' : 'passed', startedAt, durationMs: 300,
        conditions: [{ condition: { type: 'pageContainsText', value: 'created' }, passed: !failed }], evidence: [shot.id],
        ...(j.healed ? { heal: { stepId: SUBMIT, tier: 'T1-fingerprint' as const, original: [{ strategy: 'role' as const, value: 'button', name: 'Submit order', exact: true }], healed: placeOrder, confidence: 0.93, verified: true, reason: 'fingerprint score 0.93', evidence: [shot.id] } } : {}),
        ...(failed ? { error: { message: j.error ?? 'post-condition failed: pageContainsText: expected "created"' } } : {}),
      }],
    });
  }
  const run: RunResult = { runId, startedAt, finishedAt: startedAt, durationMs: 5000, journeys: results, summary: summarize(results), environment: {} };
  await writeFile(join(dir, 'run.json'), JSON.stringify(run, null, 2));
}

beforeAll(async () => {
  project = await copyShopProject();
  await fabricate('run-20261001-000000-aaaaaa', '2026-10-01T00:00:00.000Z', [{ id: ORDER, name: 'Create an order', status: 'passed' }, { id: LOGIN, name: 'Login', status: 'passed' }]);
  await fabricate('run-20261002-000000-bbbbbb', '2026-10-02T00:00:00.000Z', [{ id: ORDER, name: 'Create an order', status: 'passed-healed', healed: true }, { id: LOGIN, name: 'Login', status: 'passed' }]);
  await fabricate('run-20261003-000000-cccccc', '2026-10-03T00:00:00.000Z', [{ id: ORDER, name: 'Create an order', status: 'passed-healed', healed: true }, { id: LOGIN, name: 'Login', status: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:1' }, { id: 'seed-data', name: 'Seed data', status: 'passed', risk: 1, tags: ['hook', 'beforeAll'] }]);
  await writeFile(join(project, 'journeys', 'shared-login.ez'), 'Journey: Shared login\nTags: @library\nRequirements: LIB-1\nOpen /login\n');

  // A tiny Azure DevOps: WIQL (dedupe by tag), attachments, bug creation.
  ado = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url ?? '/', 'http://x');
    adoReqs.push({ method: req.method ?? '', path: u.pathname, type: req.headers['content-type'], size: body.length });
    res.setHeader('content-type', 'application/json');
    if (u.pathname.endsWith('/_apis/wit/wiql')) {
      const q = JSON.parse(body.toString()).query as string;
      const tag = /CONTAINS '([^']+)'/.exec(q)?.[1];
      return res.end(JSON.stringify({ workItems: adoBugs.filter((b) => tag && b.tags.includes(tag)).map((b) => ({ id: b.id })) }));
    }
    if (u.pathname.endsWith('/_apis/wit/attachments')) return res.end(JSON.stringify({ id: 'a1', url: `http://127.0.0.1/att/${u.searchParams.get('fileName')}` }));
    if (u.pathname.endsWith('/_apis/wit/workitems/$Bug')) {
      const ops = JSON.parse(body.toString()) as Array<{ path: string; value: unknown }>;
      const id = 500 + adoBugs.length;
      adoBugs.push({ id, tags: String(ops.find((o) => o.path === '/fields/System.Tags')?.value ?? '') });
      return res.end(JSON.stringify({ id, relations: ops.filter((o) => o.path === '/relations/-').map((o) => o.value) }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise<void>((r) => ado.listen(0, '127.0.0.1', r));
  studio = await startStudio({ cwd: project, env: { SHOP_URL: 'http://127.0.0.1:9' }, watch: false });
  c = client(studio.port, studio.token);
});

afterAll(async () => {
  await studio?.close();
  await new Promise((r) => ado?.close(r));
});

const item = { journeyId: ORDER, stepId: SUBMIT, healed: placeOrder, tier: 'T1-fingerprint', runId: 'run-20261003-000000-cccccc' };

describe('Quality routes', () => {
  it('lists heals deduplicated across runs with evidence and conditions', async () => {
    const r = (await c.get('/api/quality/heals')).json();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ journeyId: ORDER, stepId: SUBMIT, runCount: 2, status: 'pending', tier: 'T1-fingerprint', file: { path: 'journeys/create-order.ez' } });
    expect(r.items[0].evidence[0].url).toMatch(/^\/runs\/run-20261003-000000-cccccc\/screenshots\//);
    expect(r.items[0].conditions[0]).toMatchObject({ text: 'page contains "created"', passed: true });
    const s = (await c.get('/api/quality/summary')).json();
    expect(s.pendingHeals).toBe(1);
    expect(s.pendingByRun['run-20261002-000000-bbbbbb']).toBe(1);
  });

  it('previews then accepts with hash checks; refuses without confirm or with a stale preview', async () => {
    const p = (await c.post('/api/quality/heals/preview', { items: [item] })).json();
    expect(p.plans[0]).toMatchObject({ method: 'ez-phrase' });
    expect(p.files[0].path).toBe('journeys/create-order.ez');
    expect(p.files[0].diff.some((l: { kind: string; text: string }) => l.kind === '+' && l.text.includes('Place order'))).toBe(true);
    expect((await c.post('/api/quality/heals/accept', { items: [item], reviewer: 'A', expected: { 'journeys/create-order.ez': p.files[0].beforeHash } })).status).toBe(400);
    expect((await c.post('/api/quality/heals/accept', { items: [item], reviewer: 'A', expected: { 'journeys/create-order.ez': 'stale' }, confirm: true })).status).toBe(409);
    expect((await c.post('/api/quality/heals/accept', { items: [item], expected: {}, confirm: true })).status).toBe(400);
    const ok = await c.post('/api/quality/heals/accept', { items: [item], reviewer: 'Ann', expected: { 'journeys/create-order.ez': p.files[0].beforeHash }, confirm: true });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ written: ['journeys/create-order.ez'], accepted: 1 });
    expect(await readFile(join(project, 'journeys/create-order.ez'), 'utf8')).toContain(`Click the "Place order" button [id=${SUBMIT}]`);
    const after = (await c.get('/api/quality/heals')).json();
    expect(after.items[0].status).toBe('accepted');
    expect(after.items[0].decision).toMatchObject({ reviewer: 'Ann', decision: 'accepted' });
  });

  it('rejects with a reason and the healer store records it; undo removes the decision', async () => {
    const other = { ...item, healed: { strategy: 'css', value: '#place-order' } };
    expect((await c.post('/api/quality/heals/reject', { items: [other], reviewer: 'Bo', confirm: true })).status).toBe(400);
    expect((await c.post('/api/quality/heals/reject', { items: [{ ...other, tier: 'T9' }], reviewer: 'Bo', reason: 'x', confirm: true })).status).toBe(400);
    const r = await c.post('/api/quality/heals/reject', { items: [other], reviewer: 'Bo', reason: 'wrong form', confirm: true });
    expect(r.status, r.body).toBe(200);
    const d = await HealDecisions.open(join(project, '.eztest', 'heal-decisions.json'));
    expect(d.rejection(ORDER, SUBMIT, 'T1-fingerprint', { strategy: 'css', value: '#place-order' })?.reason).toBe('wrong form');
    expect((await c.post('/api/quality/heals/undo', { item: other, confirm: true })).json()).toEqual({ removed: true });
  });

  it('builds the triage board, reclassifies with a reason, and files ADO bugs (setup hint, then create + dedupe)', async () => {
    const b = (await c.get('/api/quality/triage')).json();
    expect(b.runId).toBe('run-20261003-000000-cccccc');
    expect(b.cards).toHaveLength(1);
    expect(b.cards[0]).toMatchObject({ category: 'environment', journeys: [{ journeyId: LOGIN }] });
    expect(b.cards[0].evidence[0].id).toMatch(/^E-\d+$/);
    expect((await c.post('/api/quality/triage/reclassify', { runId: b.runId, journeyIds: [LOGIN], to: 'nonsense', reason: 'x', by: 'A', confirm: true })).status).toBe(400);
    expect((await c.post('/api/quality/triage/reclassify', { runId: b.runId, journeyIds: [LOGIN], to: 'data', reason: '', by: 'A', confirm: true })).status).toBe(400);
    expect((await c.post('/api/quality/triage/reclassify', { runId: b.runId, journeyIds: [ORDER], to: 'data', reason: 'x', by: 'A', confirm: true })).status).toBe(400);
    expect((await c.post('/api/quality/triage/reclassify', { runId: b.runId, journeyIds: [LOGIN], to: 'data', reason: 'seed data reset', by: 'Ann', confirm: true })).status).toBe(200);
    expect((await c.get('/api/quality/triage')).json().cards[0]).toMatchObject({ category: 'data', ruleCategory: 'environment', override: { by: 'Ann', inherited: false } });

    const st = (await c.get('/api/quality/ado/status')).json();
    expect(st).toMatchObject({ configured: false, missing: ['ado.organizationUrl', 'ado.project', 'ado.pat'] });
    const no = await c.post('/api/quality/triage/file-bug', { runId: b.runId, journeyId: LOGIN, confirm: true });
    expect(no.status).toBe(412);
    expect(no.json().error).toMatch(/Azure DevOps is not configured/);

    const cfgPath = join(project, 'eztest.config.yaml');
    const port = (ado.address() as AddressInfo).port;
    await writeFile(cfgPath, `${await readFile(cfgPath, 'utf8')}\nado:\n  organizationUrl: http://127.0.0.1:${port}/org\n  project: proj\n  pat: test-pat-1234\n`);
    const created = await c.post('/api/quality/triage/file-bug', { runId: b.runId, journeyId: LOGIN, confirm: true });
    expect(created.status, created.body).toBe(200);
    expect(created.json()).toMatchObject({ id: 500, action: 'created', attachments: [expect.stringMatching(/^E-\d+-login|^E-\d+-sales-rep/)] });
    const upload = adoReqs.find((r) => r.path.endsWith('/_apis/wit/attachments'))!;
    expect(upload).toMatchObject({ type: 'application/octet-stream', size: PNG.length });
    const again = await c.post('/api/quality/triage/file-bug', { runId: b.runId, journeyId: LOGIN, confirm: true });
    expect(again.json()).toMatchObject({ id: 500, action: 'deduped' });
    expect(adoBugs).toHaveLength(1);
    expect((await c.get('/api/quality/triage')).json().cards[0].bugs[0]).toMatchObject({ id: 500 });
  });

  it('keeps hook and @library journeys out of flaky, quarantine, traceability, compare and trends', async () => {
    const f = (await c.get('/api/quality/flaky')).json();
    expect(f.rows.map((x: { journeyId: string }) => x.journeyId)).not.toContain('seed-data');
    expect(f.rows.map((x: { journeyId: string }) => x.journeyId)).not.toContain('shared-login');
    expect((await c.post('/api/quality/quarantine', { journeyId: 'seed-data', reason: 'x', owner: 'o', expires: '2099-01-01', confirm: true })).json().error).toMatch(/hook or @library/);
    const m = (await c.get('/api/quality/traceability')).json();
    expect(m.rows.map((x: { requirement: { id: string } }) => x.requirement.id)).not.toContain('LIB-1');
    const t = (await c.get('/api/quality/trends')).json();
    expect(t.points.at(-1).executed).toBe(2);
    const cmp = (await c.get('/api/quality/compare?a=run-20261001-000000-aaaaaa&b=run-20261003-000000-cccccc')).json().comparison;
    expect(cmp.journeys.map((j: { journeyId: string }) => j.journeyId)).not.toContain('seed-data');
  });

  it('validates quarantine entries and removes them', async () => {
    expect((await c.post('/api/quality/quarantine', { journeyId: LOGIN, reason: 'x', owner: 'o', expires: '2020-01-01', confirm: true })).status).toBe(400);
    expect((await c.post('/api/quality/quarantine', { journeyId: LOGIN, owner: 'o', expires: '2099-01-01', confirm: true })).status).toBe(400);
    expect((await c.post('/api/quality/quarantine', { journeyId: LOGIN, reason: 'flaky', owner: 'Olga', expires: '2099-01-01', confirm: true })).status).toBe(200);
    const f = (await c.get('/api/quality/flaky')).json();
    expect(f.rows.find((r: { journeyId: string }) => r.journeyId === LOGIN).quarantine).toMatchObject({ owner: 'Olga' });
    expect(f.rows.find((r: { journeyId: string }) => r.journeyId === LOGIN).strip.map((s: { status: string }) => s.status)).toEqual(['not-run', 'not-run', 'not-run'].slice(0, f.runs.length));
    const r = (await c.get('/api/quality/readiness')).json();
    expect(r.quarantine.active).toEqual([LOGIN]);
    expect(r.result.quarantineIgnored).toEqual([LOGIN]);
    expect((await c.del(`/api/quality/quarantine/${LOGIN}`, { by: 'Olga', confirm: true })).status).toBe(200);
    expect((await c.del(`/api/quality/quarantine/${LOGIN}`, { by: 'Olga', confirm: true })).status).toBe(404);
  });

  it('validates and saves the readiness policy with a conflict check', async () => {
    const bad = (await c.post('/api/quality/readiness/policy/validate', { text: 'version: 1\ngates:\n  minPassRate: { min: 7 }\n' })).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/minPassRate/);
    const text = 'version: 1\ngates:\n  minPassRate: { min: 0.5 }\n';
    const v = (await c.post('/api/quality/readiness/policy/validate', { text, runId: 'run-20261003-000000-cccccc' })).json();
    expect(v.ok).toBe(true);
    // Pass rate 50% meets the draft gate, but the risk-weighted score (45.5) is below the NO_GO floor.
    expect(v.preview.decision).toBe('NO_GO');
    expect(v.preview.gates).toEqual([{ gate: 'minPassRate', status: 'pass', severity: 'blocker', summary: expect.stringMatching(/50\.0%/) }]);
    expect(v.diff.some((l: { kind: string }) => l.kind === '+')).toBe(true);
    expect((await c.put('/api/quality/readiness/policy', { text, baseHash: 'stale', confirm: true })).status).toBe(409);
    expect((await c.put('/api/quality/readiness/policy', { text: 'gates: 7', baseHash: v.baseHash, confirm: true })).status).toBe(422);
    expect((await c.put('/api/quality/readiness/policy', { text, baseHash: v.baseHash, confirm: true })).status).toBe(200);
    expect(await readFile(join(project, 'readiness-policy.yaml'), 'utf8')).toBe(text);
    const r = (await c.get('/api/quality/readiness?run=run-20261003-000000-cccccc')).json();
    expect(r.result.decision).toBe('NO_GO');
    expect(r.toGo.map((t: { action: string }) => t.action).join('\n')).toMatch(/Raise the risk-weighted score from 45.5 to at least 90/);
    expect(r.coverage.byRisk[0]).toMatchObject({ risk: 5, total: 2 });
    expect(r.trend).toHaveLength(3);
  });

  it('compares runs, computes trends and exports traceability', async () => {
    const cmp = (await c.get('/api/quality/compare?a=run-20261001-000000-aaaaaa&b=run-20261003-000000-cccccc')).json().comparison;
    expect(cmp.counts).toMatchObject({ 'newly-failing': 1, 'newly-healed': 1 });
    expect(cmp.journeys[0]).toMatchObject({ journeyId: LOGIN, change: 'newly-failing' });
    expect(cmp.journeys[0].steps[0]).toMatchObject({ change: 'newly-failing', errorB: expect.stringMatching(/ECONNREFUSED/) });
    expect((await c.get('/api/quality/compare?a=run-20261001-000000-aaaaaa&b=run-20261001-000000-aaaaaa')).status).toBe(400);
    const t = (await c.get('/api/quality/trends')).json();
    expect(t.points.map((p: { passRate: number }) => p.passRate)).toEqual([1, 1, 0.5]);
    expect(t.points.map((p: { healRate: number }) => p.healRate)).toEqual([0, 0.5, 0.5]);
    expect(t.points[2].failures.data).toBe(1); // reclassified above
    expect(t.slowJourneys[0].journeyId).toBe(LOGIN);
    const x = await c.get('/api/quality/traceability/export.xlsx');
    expect(x.headers['content-disposition']).toMatch(/attachment; filename="traceability-.*\.xlsx"/);
    const html = await c.get('/api/quality/traceability/export.html');
    expect(html.headers['content-security-policy']).toMatch(/sandbox/);
    const m = (await c.get('/api/quality/traceability')).json();
    expect(m.rows.map((r: { requirement: { id: string }; coverage: string }) => [r.requirement.id, r.coverage])).toEqual([['AUTH-1', 'covered-failing'], ['ORD-1', 'covered-healed'], ['ORD-7', 'covered-healed']]);
    const wb = new ExcelJS.Workbook();
    const raw = await fetch(`${studio.origin}/api/quality/traceability/export.xlsx`, { headers: { 'x-eztest-token': studio.token } });
    await wb.xlsx.load(await raw.arrayBuffer());
    expect(wb.getWorksheet('Traceability')!.rowCount).toBe(4);
  });

  it('protects writes: JSON + token header required', async () => {
    const r = await fetch(`${studio.origin}/api/quality/quarantine`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-eztest-token': studio.token }, body: '{}' });
    expect(r.status).toBe(415);
    const r2 = await fetch(`${studio.origin}/api/quality/heals/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r2.status).toBe(401);
  });
});
