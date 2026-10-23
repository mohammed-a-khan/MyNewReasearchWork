/**
 * Results server: ingest with evidence verification, the RBAC matrix, OIDC
 * sign-in (PKCE) against a mock provider, CSRF, rate limiting, the
 * hash-chained audit log (tamper detection), retention that keeps signed
 * packs, shared state, locks and the dashboards.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultsClient, ServerLockBackend } from '../../src/server/index.js';
import { localChanges } from '../../src/server/shared-state.js';
import { fakeShardRun } from '../scale/fixtures-run.js';
import { BOOT, startTestServer, type TestServer } from './helpers.js';
import { startMockOidc, type MockOidc } from './mock-oidc.js';

let s: TestServer;
let oidc: MockOidc;
const tokens: Record<string, string> = {};
let runsDir: string;

beforeAll(async () => {
  oidc = await startMockOidc({ sub: 'u-123', email: 'Rita@Example.com', name: 'Rita Reviewer', groups: ['qa-leads'] });
  s = await startTestServer({
    oidc: { issuer: oidc.issuer, clientId: oidc.clientId, clientSecret: oidc.clientSecret },
    access: [{ subject: 'group:qa-leads', project: 'payments', role: 'approver' }],
    authRateLimit: 30,
  });
  for (const role of ['viewer', 'tester', 'approver', 'admin']) tokens[role] = await s.token(`${role}-token`, [{ project: 'payments', role }]);
  tokens.other = await s.token('other-project', [{ project: 'claims', role: 'admin' }]);
  runsDir = await mkdtemp(join(tmpdir(), 'ez-server-runs-'));
}, 60_000);

afterAll(async () => {
  await s?.close();
  await oidc?.close();
});

const client = (role: string, project = 'payments') => new ResultsClient({ url: s.url, token: tokens[role], project });

describe('health and version', () => {
  it('answers health and readiness without authentication', async () => {
    expect((await s.req('GET', '/healthz')).json).toEqual({ status: 'ok' });
    expect((await s.req('GET', '/readyz')).json).toMatchObject({ status: 'ready', database: 'sqlite' });
    expect((await s.req('GET', '/api/version')).json).toMatchObject({ name: 'eztest-server', apiVersion: 1 });
  });

  it('sets strict security headers', async () => {
    const r = await s.req('GET', '/login');
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'; style-src 'self'/);
    expect(r.headers.get('content-security-policy')).not.toMatch(/script-src/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('ingest', () => {
  it('publishes a run directory, verifies its evidence chain and indexes journeys', async () => {
    const dir = await fakeShardRun(runsDir, 'run-ingest-1', [{ id: 'login', status: 'passed' }, { id: 'pay', status: 'failed' }], new Date().toISOString());
    await writeFile(join(dir, 'report.html'), '<html>report</html>');
    const r = await client('tester').publishRun(dir, { analysis: { readiness: { decision: 'NO_GO', score: 40 } }, meta: { branch: 'main', commit: 'abc123' } });
    expect(r).toMatchObject({ runId: 'run-ingest-1', verified: true, problems: [] });
    expect(r.uploaded).toBe(5); // 4 evidence files + report.html
    const runs = (await s.req('GET', '/api/projects/payments/runs', { token: tokens.viewer })).json;
    expect(runs[0]).toMatchObject({ runId: 'run-ingest-1', verified: true, readiness: 'NO_GO', branch: 'main', summary: { total: 2, failed: 1 } });
    const js = (await s.req('GET', '/api/projects/payments/runs/run-ingest-1/journeys', { token: tokens.viewer })).json;
    expect(js.map((j: { journeyId: string; status: string }) => `${j.journeyId}:${j.status}`)).toEqual(['login:passed', 'pay:failed']);
    const file = await s.req('GET', '/api/projects/payments/runs/run-ingest-1/files?path=report.html', { token: tokens.viewer });
    expect(file.text).toBe('<html>report</html>');
    expect(file.headers.get('content-security-policy')).toMatch(/^sandbox/);
    // Republishing a complete run is refused.
    await expect(client('tester').publishRun(dir)).rejects.toThrow(/already published/);
  });

  it('rejects evidence that does not match the manifest and paths outside the run', async () => {
    const dir = await fakeShardRun(runsDir, 'run-ingest-2', [{ id: 'a', status: 'passed' }], new Date().toISOString());
    const run = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'run.json'), 'utf8'));
    const manifest = await (await import('node:fs/promises')).readFile(join(dir, 'evidence-manifest.jsonl'), 'utf8');
    const begin = await s.req('POST', '/api/projects/payments/runs', { token: tokens.tester, body: { run, manifest } });
    expect(begin.status).toBe(200);
    const forged = await s.req('PUT', '/api/projects/payments/runs/run-ingest-2/files?path=a/step-1.png', { token: tokens.tester, raw: 'forged bytes' });
    expect(forged.status).toBe(422);
    expect((await s.req('PUT', '/api/projects/payments/runs/run-ingest-2/files?path=../../etc/passwd', { token: tokens.tester, raw: 'x' })).status).toBe(400);
    expect((await s.req('PUT', '/api/projects/payments/runs/run-ingest-2/files?path=notes.txt', { token: tokens.tester, raw: 'x' })).status).toBe(400);
    const done = await s.req('POST', '/api/projects/payments/runs/run-ingest-2/complete', { token: tokens.tester, body: {} });
    expect(done.json.verified).toBe(false);
    expect(done.json.problems.join(' ')).toMatch(/file missing/);
  });
});

describe('RBAC matrix', () => {
  const decision = { journeyId: 'pay', stepId: 'click-pay', decision: 'accepted', tier: 'T1-fingerprint', locator: { strategy: 'role', value: 'button', name: 'Pay' }, reviewer: 'Rita', decidedAt: '2026-10-22T00:00:00Z' };
  const quarantine = { journeyId: 'pay', reason: 'payment sandbox flaky', owner: 'team-pay', expires: '2099-01-01', createdAt: '2026-10-22T00:00:00Z' };
  const override = { runId: 'run-ingest-1', journeyId: 'pay', from: 'unknown', to: 'environment', reason: 'sandbox down', by: 'Tom', at: '2026-10-22T00:00:00Z' };
  const actions: Array<[string, (t: string) => Promise<number>, string]> = [
    ['read runs', (t) => s.req('GET', '/api/projects/payments/runs', { token: t }).then((r) => r.status), 'viewer'],
    ['publish a run', (t) => s.req('POST', '/api/projects/payments/runs', { token: t, body: { run: { runId: `run-rbac-${Math.random().toString(36).slice(2, 8)}`, journeys: [], startedAt: new Date().toISOString() }, manifest: '' } }).then((r) => r.status), 'tester'],
    ['override triage', (t) => s.req('POST', '/api/projects/payments/state/triage-overrides', { token: t, body: { upsert: [override] } }).then((r) => r.status), 'tester'],
    ['use locks', (t) => s.req('POST', '/api/projects/payments/locks/release', { token: t, body: { key: 'k', token: 'x' } }).then((r) => r.status), 'tester'],
    ['accept a heal', (t) => s.req('POST', '/api/projects/payments/state/heal-decisions', { token: t, body: { upsert: [decision] } }).then((r) => r.status), 'approver'],
    ['change quarantine', (t) => s.req('POST', '/api/projects/payments/state/quarantine', { token: t, body: { upsert: [quarantine] } }).then((r) => r.status), 'approver'],
    ['sign readiness', (t) => s.req('POST', '/api/projects/payments/runs/run-ingest-1/sign', { token: t, body: { note: 'ok' } }).then((r) => r.status), 'approver'],
    ['read the project audit log', (t) => s.req('GET', '/api/audit?project=payments', { token: t }).then((r) => r.status), 'approver'],
    ['set retention', (t) => s.req('PUT', '/api/projects/payments/retention', { token: t, body: { days: 400 } }).then((r) => r.status), 'admin'],
    ['grant access', (t) => s.req('PUT', '/api/projects/payments/access', { token: t, body: { subject: 'user:new@example.com', role: 'viewer' } }).then((r) => r.status), 'admin'],
  ];
  const rank = ['viewer', 'tester', 'approver', 'admin'];

  it.each(actions)('%s: allowed from %s up, denied below and for other projects', async (_name, act, min) => {
    for (const role of rank) {
      const status = await act(tokens[role]);
      if (rank.indexOf(role) >= rank.indexOf(min)) expect(status, `${role}`).toBeLessThan(400);
      else expect(status, `${role}`).toBe(403);
    }
    expect(await act(tokens.other)).toBe(403);
    expect(await act('')).toBe(401);
  });

  it('only a global admin creates tokens; an invalid token is refused', async () => {
    expect((await s.req('POST', '/api/tokens', { token: tokens.admin, body: { name: 'x', grants: [{ project: '*', role: 'admin' }] } })).status).toBe(403);
    expect((await s.req('POST', '/api/tokens', { token: tokens.admin, body: { name: 'x', grants: [{ project: 'payments', role: 'viewer' }] } })).status).toBe(200);
    expect((await s.req('GET', '/api/projects/payments/runs', { token: 'ezt_nope_nope' })).status).toBe(401);
    expect((await s.req('GET', '/api/projects', { token: tokens.other })).json.map((p: { project: string }) => p.project)).not.toContain('payments');
  });
});

describe('OIDC sign-in (authorization code + PKCE) and CSRF', () => {
  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const start = await s.req('GET', '/auth/login?next=/ui/p/payments');
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.origin).toBe(oidc.issuer);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const idp = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(idp.headers.get('location')!);
    const done = await s.req('GET', `${callback.pathname}${callback.search}`);
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/ui/p/payments');
    const setCookie = done.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const cookie = setCookie.split(';')[0];
    const me = await s.req('GET', '/api/me', { cookie });
    return { cookie, csrf: me.json.csrf };
  }

  it('signs a person in, maps their group to a role, and sends the PKCE verifier', async () => {
    const { cookie } = await signIn();
    const me = await s.req('GET', '/api/me', { cookie });
    expect(me.json).toMatchObject({ kind: 'user', id: 'user:rita@example.com', name: 'Rita Reviewer', grants: [{ project: 'payments', role: 'approver' }] });
    const last = oidc.tokenRequests[oidc.tokenRequests.length - 1];
    expect(last.code_verifier.length).toBeGreaterThanOrEqual(43);
    const page = await s.req('GET', '/ui/p/payments', { cookie });
    expect(page.status).toBe(200);
    expect(page.text).toContain('Run history');
    expect(page.text).toContain('run-ingest-1');
    expect(page.text).not.toMatch(/<script/i);
  });

  it('rejects tampered ID tokens and replayed state', async () => {
    for (const tamper of ['nonce', 'audience', 'expired', 'signature', 'issuer'] as const) {
      const start = await s.req('GET', '/auth/login');
      oidc.tamper = tamper;
      const idp = await fetch(new URL(start.headers.get('location')!), { redirect: 'manual' });
      const cb = new URL(idp.headers.get('location')!);
      const r = await s.req('GET', `${cb.pathname}${cb.search}`);
      expect(r.status, tamper).toBe(401);
      expect(r.headers.get('set-cookie')).toBeNull();
      // The state is single-use.
      expect((await s.req('GET', `${cb.pathname}${cb.search}`)).status).toBe(401);
    }
  });

  it('cookie-authenticated writes need the CSRF token and a same-origin request', async () => {
    const { cookie, csrf } = await signIn();
    const body = { upsert: [{ journeyId: 'pay', reason: 'r', owner: 'o', expires: '2099-01-01', createdAt: '2026-10-22T00:00:00Z' }] };
    expect((await s.req('POST', '/api/projects/payments/state/quarantine', { cookie, body })).status).toBe(403);
    expect((await s.req('POST', '/api/projects/payments/state/quarantine', { cookie, body, headers: { 'x-csrf-token': 'wrong' } })).status).toBe(403);
    expect((await s.req('POST', '/api/projects/payments/state/quarantine', { cookie, body, headers: { 'x-csrf-token': csrf, origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await s.req('POST', '/api/projects/payments/state/quarantine', { cookie, body, headers: { 'x-csrf-token': csrf } });
    expect(ok.status).toBe(200);
    // The audit log names the person.
    const audit = (await s.req('GET', '/api/audit?project=payments&action=quarantine.change', { token: tokens.approver })).json;
    expect(audit.some((e: { actor: string }) => e.actor === 'user:rita@example.com')).toBe(true);
  });

  it('rate-limits sign-in attempts per client', async () => {
    const t = await startTestServer({ authRateLimit: 3 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await t.req('GET', '/api/projects', { token: `ezt_bad_${i}` })).status);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toContain(429);
      // Logs never contain tokens or query strings.
      const all = t.logs.join('\n');
      expect(all).not.toContain('ezt_bad_');
      expect(all).not.toContain(BOOT);
    } finally {
      await t.close();
    }
  });
});

describe('audit log', () => {
  it('records who accepted heals, signed readiness and changed quarantine, and detects tampering', async () => {
    const audit = (await s.req('GET', '/api/audit?limit=500', { token: BOOT })).json as Array<{ action: string; actor: string; target?: string }>;
    const actions = new Set(audit.map((e) => e.action));
    for (const a of ['run.publish', 'heal.accept', 'quarantine.add', 'readiness.sign', 'triage.override', 'token.create', 'access.grant', 'retention.set', 'auth.login']) expect(actions, a).toContain(a);
    const heal = audit.find((e) => e.action === 'heal.accept')!;
    expect(heal.actor).toMatch(/^token:.*:(approver|admin)-token$/);
    const v = await s.req('GET', '/api/audit/verify', { token: BOOT });
    expect(v.json).toMatchObject({ ok: true });

    // Tamper with one row directly in the database: the chain breaks there.
    await s.store.run('UPDATE ez_audit SET actor = ? WHERE seq = ?', ['mallory', 2]);
    const bad = (await s.req('GET', '/api/audit/verify', { token: BOOT })).json;
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatch(/entry 2: content altered/);
    const page = await s.req('GET', '/ui/audit', { cookie: await tokenCookie(BOOT) });
    expect(page.text).toContain('Chain BROKEN');
  });

  it('detects a deleted entry', async () => {
    const t = await startTestServer();
    try {
      for (let i = 0; i < 3; i++) await t.token(`t${i}`, [{ project: 'p', role: 'viewer' }]);
      expect((await t.req('GET', '/api/audit/verify', { token: BOOT })).json.ok).toBe(true);
      await t.store.run('DELETE FROM ez_audit WHERE seq = ?', [2]);
      const v = (await t.req('GET', '/api/audit/verify', { token: BOOT })).json;
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toMatch(/entry 3: expected sequence 2/);
    } finally {
      await t.close();
    }
  });
});

async function tokenCookie(token: string): Promise<string> {
  const login = await s.req('GET', '/login');
  const pre = login.headers.get('set-cookie')!.split(';')[0];
  const csrf = pre.split('=')[1];
  const r = await s.req('POST', '/auth/token', { cookie: pre, raw: new URLSearchParams({ token, _csrf: decodeURIComponent(csrf), next: '/ui' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  expect(r.status).toBe(303);
  return r.headers.get('set-cookie')!.split(';')[0];
}

describe('dashboards', () => {
  it('serves read-only, script-free, accessible pages; sign-in with a token needs the pre-session CSRF value', async () => {
    const cookie = await tokenCookie(tokens.viewer);
    const projects = await s.req('GET', '/ui', { cookie });
    expect(projects.text).toContain('href="/ui/p/payments"');
    expect(projects.text).toMatch(/<caption>/);
    const run = await s.req('GET', '/ui/p/payments/runs/run-ingest-1?status=failed', { cookie });
    expect(run.text).toContain('Journeys (1)');
    expect(run.text).toContain('Open the full HTML report');
    const csv = await s.req('GET', '/api/projects/payments/trends.csv', { cookie });
    expect(csv.text.split('\n')[0]).toMatch(/^run_id,started_at,duration_ms,total,passed/);
    // Without the CSRF value, a token sign-in is refused.
    expect((await s.req('POST', '/auth/token', { raw: new URLSearchParams({ token: tokens.viewer }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(403);
    // Anonymous visitors are sent to sign in.
    expect((await s.req('GET', '/ui')).headers.get('location')).toBe('/login?next=%2Fui');
  });

  it('flaky trends, durations, history and traceability come from published runs', async () => {
    const c = client('viewer');
    const d = await c.durations();
    expect(d.known.login).toBe(1000);
    const h = await c.history();
    expect(h[0].outcomes.length).toBeGreaterThan(0);
    const tr = (await s.req('GET', '/api/projects/payments/traceability', { token: tokens.viewer })).json;
    expect(tr.find((x: { requirement: string }) => x.requirement === 'REQ-pay')).toMatchObject({ covered: false });
  });
});

describe('shared state and locks', () => {
  it('sync keeps unpushed local edits over the server copy and pushes them when allowed', () => {
    const base = { version: 1, entries: [{ journeyId: 'a', reason: 'r', owner: 'o', expires: '2099-01-01', createdAt: 'x' }] };
    const local = { version: 1, entries: [{ journeyId: 'b', reason: 'r', owner: 'o', expires: '2099-01-01', createdAt: 'x' }] };
    expect(localChanges('quarantine', local, base)).toEqual({ upsert: [local.entries[0]], remove: ['a'] });
    expect(localChanges('quarantine', undefined, base)).toEqual({ upsert: [], remove: [] });
  });

  it('server locks: one holder at a time, released and expired leases can be taken', async () => {
    const a = new ServerLockBackend(client('tester'), 'machine-a', 2000);
    const b = new ServerLockBackend(client('tester'), 'machine-b', 2000);
    const h = await a.tryAcquire('account-123');
    expect(h).toBeTruthy();
    expect(await b.tryAcquire('account-123')).toBeUndefined();
    expect(await b.holder('account-123')).toBe('machine-a');
    await h!.release();
    const h2 = await b.tryAcquire('account-123');
    expect(h2).toBeTruthy();
    await h2!.release();
  });
});

describe('retention', () => {
  it('deletes evidence older than the project policy but keeps signed packs and signed runs without a pack', async () => {
    const t = await startTestServer({ retention: { defaultDays: 30 } });
    try {
      const tester = await t.token('t', [{ project: 'ret', role: 'approver' }]);
      const c = new ResultsClient({ url: t.url, token: tester, project: 'ret' });
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const dir = await mkdtemp(join(tmpdir(), 'ez-ret-'));
      for (const id of ['run-old-plain', 'run-old-signed', 'run-old-packed']) await c.publishRun(await fakeShardRun(dir, id, [{ id: 'a', status: 'passed' }], old));
      await c.publishRun(await fakeShardRun(dir, 'run-new', [{ id: 'a', status: 'passed' }], new Date().toISOString()));
      await c.signReadiness('run-old-signed', 'release 1.2');
      await c.signReadiness('run-old-packed', 'release 1.1');
      const zip = join(dir, 'pack.zip');
      await writeFile(zip, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]));
      await c.uploadPack('run-old-packed', zip);
      const r = (await t.req('POST', '/api/retention/run', { token: BOOT })).json;
      expect(r.deleted.map((x: { runId: string }) => x.runId).sort()).toEqual(['run-old-packed', 'run-old-plain']);
      expect(r.keptSigned.map((x: { runId: string }) => x.runId)).toEqual(['run-old-signed']);
      expect(existsSync(join(t.dataDir, 'runs/ret/run-old-plain'))).toBe(false);
      expect(existsSync(join(t.dataDir, 'runs/ret/run-old-signed/run.json'))).toBe(true);
      expect(existsSync(join(t.dataDir, 'runs/ret/run-new/run.json'))).toBe(true);
      expect(existsSync(join(t.dataDir, 'packs/ret/run-old-packed.zip'))).toBe(true);
      const pack = await t.req('GET', '/api/projects/ret/runs/run-old-packed/pack', { token: tester });
      expect(pack.status).toBe(200);
      // Metadata stays; the dashboard says the evidence expired.
      const runs = (await t.req('GET', '/api/projects/ret/runs', { token: tester })).json as Array<{ runId: string; evidenceDeletedAt?: string }>;
      expect(runs.find((x) => x.runId === 'run-old-plain')?.evidenceDeletedAt).toBeTruthy();
      expect((await t.req('GET', '/api/audit?project=ret&action=retention.apply', { token: BOOT })).json[0].details.deletedRuns).toBe(2);
      // A per-project override wins over the default.
      await t.req('PUT', '/api/projects/ret/retention', { token: BOOT, body: { days: 3650 } });
      expect((await t.req('POST', '/api/retention/run', { token: BOOT })).json.deleted).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
