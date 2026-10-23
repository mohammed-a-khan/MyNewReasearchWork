/** Source Control routes on a real git checkout of the shop project: status, diffs, index, commits, branches, push/pull, blame, conflicts, branch filter, PR proposals. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../src/git/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject } from './helpers.js';

let project: string;
let remote: string;
let studio: StudioHandle;
let c: ReturnType<typeof client>;
const g = (args: string[]) => git(args, { cwd: project });

async function fabricateRun(id: string, startedAt: string, branch: string) {
  const dir = join(project, 'eztest-results', id);
  await mkdir(dir, { recursive: true });
  const j = { journeyId: 'login-mfa', name: 'Login', status: 'passed', startedAt, durationMs: 1, steps: [], tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [] };
  await writeFile(join(dir, 'run.json'), JSON.stringify({ runId: id, startedAt, finishedAt: startedAt, durationMs: 1, journeys: [j], summary: { total: 1, passed: 1, passedHealed: 0, failed: 0, skipped: 0, errors: 0 }, environment: { gitBranch: branch, gitCommit: 'a'.repeat(40) } }));
}

beforeAll(async () => {
  project = await copyShopProject();
  remote = join(await mkdtemp(join(tmpdir(), 'eztest-scm-remote-')), 'origin.git');
  await git(['init', '-q', '--bare', '-b', 'main', remote], { cwd: tmpdir() });
  await g(['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Studio User'], ['user.email', 'studio@example.com'], ['commit.gpgsign', 'false']]) await g(['config', k, v]);
  await writeFile(join(project, '.gitignore'), 'eztest-results/\n.eztest/\n');
  await g(['add', '-A']);
  await g(['commit', '-q', '-m', 'Shop project']);
  await g(['remote', 'add', 'origin', remote]);
  await fabricateRun('run-20261001-000000-aaaaaa', '2026-10-01T00:00:00.000Z', 'main');
  await fabricateRun('run-20261002-000000-bbbbbb', '2026-10-02T00:00:00.000Z', 'feature/x');
  // History as `eztest run` records it: each run with the branch it tested.
  await mkdir(join(project, '.eztest'), { recursive: true });
  const outcome = { journeyId: 'login-mfa', status: 'passed', durationMs: 1, attempt: 1 };
  await writeFile(join(project, '.eztest', 'history.json'), JSON.stringify({ version: 1, runs: [
    { runId: 'run-20261001-000000-aaaaaa', startedAt: '2026-10-01T00:00:00.000Z', branch: 'main', outcomes: [outcome] },
    { runId: 'run-20261002-000000-bbbbbb', startedAt: '2026-10-02T00:00:00.000Z', branch: 'feature/x', outcomes: [outcome] },
  ] }));
  studio = await startStudio({ cwd: project, env: { SHOP_URL: 'http://127.0.0.1:9' }, watch: false });
  c = client(studio.port, studio.token);
});

afterAll(async () => {
  await studio?.close();
});

describe('Source Control routes', () => {
  it('groups changes into journeys, queries and config, hides secrets, and diffs at word level', async () => {
    const journey = join(project, 'journeys', 'login-mfa.ez');
    const before = await readFile(journey, 'utf8');
    await writeFile(journey, before.replace('Log in as sales-rep', 'Log in as manager'));
    await mkdir(join(project, 'queries'), { recursive: true });
    await writeFile(join(project, 'queries', 'open-orders.sql'), 'SELECT * FROM orders WHERE status = :status\n');
    await writeFile(join(project, 'eztest.config.yaml'), (await readFile(join(project, 'eztest.config.yaml'), 'utf8')) + '\nretries: 1\n');
    await writeFile(join(project, '.env.local'), 'SECRET=1\n');
    const s = (await c.get('/api/scm/status')).json();
    expect(s.branch).toMatchObject({ head: 'main', detached: false });
    const by = Object.fromEntries(s.entries.map((e: { path: string; category: string; sensitive: boolean }) => [e.path, [e.category, e.sensitive]]));
    expect(by).toMatchObject({ 'journeys/login-mfa.ez': ['journey', false], 'queries/open-orders.sql': ['query', false], 'eztest.config.yaml': ['config', false], '.env.local': ['config', true] });
    expect((await c.get('/api/scm/diff?path=.env.local')).status).toBe(403);
    expect((await c.post('/api/scm/stage', { paths: ['.env.local'] })).status).toBe(403);
    expect((await c.get('/api/scm/diff?path=../etc/passwd')).status).toBe(403);
    const d = (await c.get('/api/scm/diff?path=journeys/login-mfa.ez')).json();
    const line = d.hunks.flatMap((h: { lines: unknown[] }) => h.lines).find((l: { kind: string }) => l.kind === '~');
    expect(line.segments).toEqual([{ kind: ' ', text: 'Log in as ' }, { kind: '-', text: 'sales-rep' }, { kind: '+', text: 'manager' }]);
    expect(d.unified).toContain('+Log in as manager');
  });

  it('stages, commits, shows history and blame by step, creates a branch and pushes it', async () => {
    expect((await c.post('/api/scm/commit', { message: 'nothing staged' })).status).toBe(400);
    expect((await c.post('/api/scm/stage', { paths: ['journeys/login-mfa.ez', 'queries/open-orders.sql'] })).status).toBe(200);
    expect((await c.post('/api/scm/unstage', { paths: ['queries/open-orders.sql'] })).status).toBe(200);
    const s = (await c.get('/api/scm/status')).json();
    expect(s.entries.find((e: { path: string }) => e.path === 'journeys/login-mfa.ez')).toMatchObject({ staged: true });
    expect(s.entries.find((e: { path: string }) => e.path === 'queries/open-orders.sql')).toMatchObject({ staged: false });
    const staged = (await c.get('/api/scm/diff?path=journeys/login-mfa.ez&staged=1')).json();
    expect(staged.unified).toContain('+Log in as manager');
    const r = (await c.post('/api/scm/commit', { message: 'Log in as manager\n\nThe sales-rep role is gone.' })).json();
    expect(r).toMatchObject({ files: 1, subject: 'Log in as manager' });
    const log = (await c.get('/api/scm/log?path=journeys/login-mfa.ez')).json();
    expect(log.commits.map((x: { subject: string }) => x.subject)).toEqual(['Log in as manager', 'Shop project']);
    const blame = (await c.get('/api/scm/blame?path=journeys/login-mfa.ez')).json();
    const l = blame.lines.find((x: { text: string }) => x.text.includes('Log in as manager'));
    expect(l).toMatchObject({ author: 'Studio User', summary: 'Log in as manager', stepId: 'log-in-as-manager' });
    expect(blame.lines[0].stepId).toBeUndefined(); // the "Journey:" header is not a step

    expect((await c.post('/api/scm/branch', { name: 'feature/journeys' })).json()).toEqual({ current: 'feature/journeys' });
    expect((await c.post('/api/scm/branch', { name: '--force' })).status).toBe(400);
    const push = await c.post('/api/scm/push');
    expect(push.status).toBe(200);
    expect((await git(['ls-remote', remote], { cwd: tmpdir() })).stdout).toContain('refs/heads/feature/journeys');
    expect((await c.get('/api/scm/status')).json().branch.upstream).toBe('origin/feature/journeys');
    expect((await c.post('/api/scm/pull')).json().conflicts).toEqual([]);
    const b = (await c.get('/api/scm/branches')).json();
    expect(b.current).toBe('feature/journeys');
    expect(b.branches.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['main', 'feature/journeys', 'origin/feature/journeys']));
    expect((await c.post('/api/scm/switch', { name: 'main' })).json()).toEqual({ current: 'main' });
  });

  it('shows a conflict in a journey, previews choices, refuses an invalid result and stages a valid one', async () => {
    const file = join(project, 'journeys', 'login-mfa.ez');
    await g(['checkout', '-q', '-b', 'other']);
    await writeFile(file, (await readFile(file, 'utf8')).replace('Log in as manager', 'Log in as admin'));
    await g(['commit', '-q', '-am', 'admin']);
    await g(['checkout', '-q', 'main']);
    await writeFile(file, (await readFile(file, 'utf8')).replace('Log in as manager', 'Log in as auditor'));
    await g(['commit', '-q', '-am', 'auditor']);
    await g(['merge', '--no-edit', 'other']).catch(() => undefined);
    const s = (await c.get('/api/scm/status')).json();
    expect(s.operation).toBe('merge');
    expect(s.conflicts).toEqual(['journeys/login-mfa.ez']);
    const cf = (await c.get('/api/scm/conflict?path=journeys/login-mfa.ez')).json();
    expect(cf.hunks).toHaveLength(1);
    expect(cf.hunks[0].ours).toEqual(['Log in as auditor']);
    expect(cf.hunks[0].theirs).toEqual(['Log in as admin']);
    const pv = (await c.post('/api/scm/resolve', { path: 'journeys/login-mfa.ez', choices: { 0: 'theirs' }, preview: true })).json();
    expect(pv.check).toMatchObject({ ok: true });
    expect((await c.post('/api/scm/resolve', { path: 'journeys/login-mfa.ez', choices: { 0: 'theirs' }, hash: cf.hash })).status).toBe(400); // needs confirm
    expect((await c.post('/api/scm/resolve', { path: 'journeys/login-mfa.ez', choices: { 0: 'theirs' }, hash: 'stale', confirm: true })).status).toBe(409);
    const bad = await c.post('/api/scm/resolve', { path: 'journeys/login-mfa.ez', choices: { 0: { text: 'Lgo ni as admin' } }, hash: cf.hash, confirm: true });
    expect(bad.status).toBe(422);
    expect(bad.json().error).toMatch(/not a valid journey/);
    const ok = (await c.post('/api/scm/resolve', { path: 'journeys/login-mfa.ez', choices: { 0: 'theirs' }, hash: cf.hash, confirm: true })).json();
    expect(ok.staged).toBe(true);
    expect((await c.get('/api/scm/status')).json().conflicts).toEqual([]);
    expect((await c.post('/api/scm/commit', { message: 'Merge other' })).status).toBe(200);
  });

  it('filters the Quality Center by branch', async () => {
    const all = (await c.get('/api/quality/flaky')).json();
    expect(all.runs.map((r: { runId: string }) => r.runId)).toHaveLength(2);
    expect((await c.post('/api/scm/branch-filter', { branch: 'feature/x' })).json()).toEqual({ branch: 'feature/x' });
    const one = (await c.get('/api/quality/flaky')).json();
    expect(one.runs.map((r: { runId: string }) => r.runId)).toEqual(['run-20261002-000000-bbbbbb']);
    expect((await c.get('/api/scm/status')).json().branchFilter).toBe('feature/x');
    await c.post('/api/scm/branch-filter', { branch: null });
    expect((await c.get('/api/quality/flaky')).json().runs).toHaveLength(2);
  });

  it('turns a quarantine change into a pull request proposal: branch + commit pushed without touching the checkout', async () => {
    await mkdir(join(project, '.eztest'), { recursive: true });
    await writeFile(join(project, '.eztest', 'quarantine.json'), JSON.stringify({ version: 1, entries: [{ journeyId: 'login-mfa', reason: 'flaky OTP', owner: 'qa', expires: '2099-01-01', createdAt: '2026-10-01' }] }));
    studio.app.hub.publish('quality', { type: 'quarantine', action: 'added', journeyId: 'login-mfa' });
    await expect.poll(async () => (await c.get('/api/scm/proposals')).json().proposals.length).toBe(1);
    const p = (await c.get('/api/scm/proposals')).json().proposals[0];
    expect(p).toMatchObject({ kind: 'quarantine', title: 'EZTest: quarantine login-mfa', files: ['.eztest/quarantine.json'] });
    expect((await c.post('/api/scm/propose', { id: p.id })).status).toBe(400); // needs confirm
    const r = (await c.post('/api/scm/propose', { id: p.id, confirm: true, by: 'Quinn' })).json();
    expect(r.pushed).toBe(true);
    expect(r.branch).toMatch(/^eztest\/quarantine-/);
    expect(r.warnings.join()).toMatch(/no hosting provider configured/);
    const shown = await git(['--git-dir', remote, 'show', `${r.branch}:.eztest/quarantine.json`], { cwd: tmpdir() });
    expect(shown.stdout).toContain('flaky OTP');
    expect((await git(['--git-dir', remote, 'log', '-1', '--format=%B', r.branch], { cwd: tmpdir() })).stdout).toContain('Requested by Quinn.');
    expect((await c.get('/api/scm/proposals')).json().proposals[0].done).toMatchObject({ branch: r.branch, pushed: true });
    expect((await c.get('/api/scm/status')).json().branch.head).toBe('main');
  });

  it('routes a journey to its CODEOWNERS owner and area path (triage cards and filed bugs)', async () => {
    const { journeyRouting } = await import('../../src/studio/quality/triage.js');
    await writeFile(join(project, 'CODEOWNERS'), '/journeys/ @qa-team qa@contoso.com\n');
    const cfg = join(project, 'eztest.config.yaml');
    await writeFile(cfg, `${await readFile(cfg, 'utf8')}\nado:\n  areaPath: Shop\n  paths:\n    - { journeys: "journeys/login*", areaPath: Shop\\Identity }\n`);
    const { journeyFiles } = await import('../../src/studio/quality/common.js');
    const id = (await journeyFiles(studio.app)).find((f) => f.path === 'journeys/login-mfa.ez')!.id;
    const r = await journeyRouting(studio.app);
    expect(r.ownersOf(id)).toEqual(['@qa-team', 'qa@contoso.com']);
    expect(r.ownersOf(`${id}-row-2`)).toEqual(['@qa-team', 'qa@contoso.com']); // an Examples row of it
    expect(r.bugFields(id, [])).toEqual({ assignedTo: 'qa@contoso.com', areaPath: 'Shop\\Identity' });
  });

  it('explains when the project is not a git repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'eztest-nogit-'));
    await writeFile(join(plain, 'eztest.config.yaml'), 'baseUrl: http://x\n');
    const s2 = await startStudio({ cwd: plain, watch: false });
    try {
      const r = await client(s2.port, s2.token).get('/api/scm/status');
      expect(r.status).toBe(412);
      expect(r.json().error).toMatch(/not inside a git repository/);
      // The status bar's summary answers 200 so pages without git log no errors.
      const s = await client(s2.port, s2.token).get('/api/scm/summary');
      expect(s.status).toBe(200);
      expect(s.json()).toMatchObject({ repo: false });
    } finally {
      await s2.close();
    }
  });
});
