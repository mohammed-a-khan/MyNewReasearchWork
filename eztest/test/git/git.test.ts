/** The git layer on real temporary repositories: status, word diffs, index, commits, branches, history, blame, conflicts, CODEOWNERS, run info, branch scope. */
import { describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeRef,
  branchBaselineDir,
  branchSlug,
  checkResolvedJourney,
  ciBranch,
  collectRunVcs,
  currentBranchSync,
  GitError,
  loadCodeowners,
  ownersOf,
  parseCodeowners,
  parseConflicts,
  promoteBranchBaselines,
  promoteMergedBranches,
  redactGitText,
  resolveConflicts,
  runVcs,
  runVcsEnvironment,
  seedBranchBaselines,
  assigneeFor,
} from '../../src/git/index.js';
import { HistoryStore } from '../../src/insights/index.js';
import type { RunResult } from '../../src/core/index.js';
import { tmpRepo } from './helpers.js';

const J1 = 'Journey: Checkout\nTags: @smoke\n\nOpen /cart\nClick the "Checkout" button\n  Expect the URL contains "/checkout"\nType "4242" into the Card field\n';

describe('repository operations', () => {
  it('status, word-level diff of a journey, stage / unstage, commit, log', async () => {
    const r = await tmpRepo();
    await r.write('journeys/checkout.ez', J1);
    await r.write('eztest.config.yaml', 'baseUrl: http://x\n');
    let s = await r.repo.status();
    expect(s.branch).toMatchObject({ head: 'main', detached: false });
    expect(s.entries.map((e) => [e.path, e.kind])).toEqual([['eztest.config.yaml', 'untracked'], ['journeys/checkout.ez', 'untracked']]);
    // untracked files diff against /dev/null
    const wd0 = await r.repo.wordDiff('journeys/checkout.ez');
    expect(wd0[0].lines.every((l) => l.kind === '+')).toBe(true);

    await r.repo.stage(['journeys/checkout.ez', 'eztest.config.yaml']);
    s = await r.repo.status();
    expect(s.entries.every((e) => e.staged && e.index === 'A')).toBe(true);
    await r.repo.unstage(['eztest.config.yaml']); // before the first commit: rm --cached
    expect((await r.repo.status()).entries.find((e) => e.path === 'eztest.config.yaml')!.kind).toBe('untracked');
    const sha1 = await r.repo.commit('Add checkout journey\n\nwith a card step');
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);

    await r.write('journeys/checkout.ez', J1.replace('Click the "Checkout" button', 'Click the "Pay now" button'));
    s = await r.repo.status();
    expect(s.entries.find((e) => e.path === 'journeys/checkout.ez')).toMatchObject({ kind: 'changed', worktree: 'M', unstaged: true, staged: false });
    const wd = await r.repo.wordDiff('journeys/checkout.ez');
    const changed = wd.flatMap((h) => h.lines).filter((l) => l.kind === '~');
    expect(changed).toHaveLength(1);
    expect(changed[0].oldNo).toBe(5);
    expect(changed[0].segments).toEqual([
      { kind: ' ', text: 'Click the ' },
      { kind: '-', text: '"Checkout"' },
      { kind: '+', text: '"Pay now"' },
      { kind: ' ', text: ' button' },
    ]);
    expect(await r.repo.diff('journeys/checkout.ez')).toContain('-Click the "Checkout" button\n+Click the "Pay now" button');
    await r.repo.stage(['journeys/checkout.ez']);
    expect(await r.repo.diff('journeys/checkout.ez', { staged: true })).toContain('+Click the "Pay now" button');
    await r.repo.unstage(['journeys/checkout.ez']);
    expect((await r.repo.status()).entries.find((e) => e.path === 'journeys/checkout.ez')).toMatchObject({ staged: false, unstaged: true });
    await r.repo.stage(['journeys/checkout.ez']);
    await r.repo.commit('Rename the checkout button');
    const log = await r.repo.log({ path: 'journeys/checkout.ez' });
    expect(log.map((c) => c.subject)).toEqual(['Rename the checkout button', 'Add checkout journey']);
    expect(log[1]).toMatchObject({ sha: sha1, author: 'Test User', email: 'test@example.com' });
    await expect(r.repo.commit('   ')).rejects.toThrow(/message is required/);
    expect(() => r.repo.rel('../outside.txt')).toThrow(/outside the repository/);
  });

  it('branches: create, switch, list; refuses unsafe names', async () => {
    const r = await tmpRepo();
    await r.write('a.ez', J1);
    await r.commit('one');
    await r.repo.createBranch('feature/pay', { checkout: true });
    expect(await r.repo.currentBranch()).toBe('feature/pay');
    await r.repo.switchBranch('main');
    const b = await r.repo.branches();
    expect(b.map((x) => [x.name, x.current])).toEqual([['feature/pay', false], ['main', true]]);
    for (const bad of ['-x', 'a..b', 'x y', '--force', 'a/', 'refs.lock']) expect(() => assertSafeRef(bad)).toThrow(GitError);
    await expect(r.repo.createBranch('HEAD')).rejects.toThrow(/Invalid branch name/);
    expect(assertSafeRef('HEAD~2')).toBe('HEAD~2');
    expect(assertSafeRef('@{u}')).toBe('@{u}');
  });

  it('blame tells who changed each step and when; uncommitted lines are marked', async () => {
    const r = await tmpRepo();
    await r.write('journeys/c.ez', J1);
    await r.commit('first', 'Alice <alice@example.com>');
    await r.write('journeys/c.ez', J1.replace('"4242"', '"4000 0000 0000 0002"'));
    await r.commit('decline card', 'Bob <bob@example.com>');
    await r.write('journeys/c.ez', J1.replace('"4242"', '"4000 0000 0000 0002"') + 'Expect the page contains "Declined"\n');
    const bl = await r.repo.blame('journeys/c.ez');
    expect(bl.map((l) => [l.line, l.author])).toEqual([
      [1, 'Alice'], [2, 'Alice'], [3, 'Alice'], [4, 'Alice'], [5, 'Alice'], [6, 'Alice'], [7, 'Bob'], [8, 'Not committed yet'],
    ]);
    expect(bl[6]).toMatchObject({ email: 'bob@example.com', summary: 'decline card', uncommitted: false });
    expect(bl[6].date).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(bl[7].uncommitted).toBe(true);
  });

  it('merge conflicts in an .ez file: parsed into hunks, resolved per hunk, validated before staging', async () => {
    const r = await tmpRepo();
    await r.write('journeys/c.ez', J1);
    await r.commit('base');
    await r.repo.createBranch('other', { checkout: true });
    await r.write('journeys/c.ez', J1.replace('"Checkout"', '"Buy"'));
    await r.commit('theirs');
    await r.repo.switchBranch('main');
    await r.write('journeys/c.ez', J1.replace('"Checkout"', '"Pay"'));
    await r.commit('ours');
    await r.run(['config', 'merge.conflictStyle', 'diff3']);
    await expect(r.run(['merge', '--no-edit', 'other'])).rejects.toThrow(/exited 1/);
    const st = await r.repo.status();
    expect(st.operation).toBe('merge');
    expect(st.entries.find((e) => e.path === 'journeys/c.ez')).toMatchObject({ kind: 'unmerged', conflicted: true });
    expect(await r.repo.conflictedFiles()).toEqual(['journeys/c.ez']);
    const v = await r.repo.conflictVersions('journeys/c.ez');
    expect(v.base).toBe(J1);
    expect(v.ours).toContain('"Pay"');
    expect(v.theirs).toContain('"Buy"');
    const p = parseConflicts(v.working);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]).toMatchObject({ ours: ['Click the "Pay" button'], base: ['Click the "Checkout" button'], theirs: ['Click the "Buy" button'], oursLabel: 'HEAD', theirsLabel: 'other' });
    expect(checkResolvedJourney('journeys/c.ez', v.working)).toEqual({ ok: false, error: 'conflict markers remain' });
    const both = resolveConflicts(p, { 0: 'both' });
    expect(both).toContain('Click the "Pay" button\nClick the "Buy" button');
    expect(checkResolvedJourney('journeys/c.ez', both)).toMatchObject({ ok: true, steps: 4 });
    expect(checkResolvedJourney('journeys/c.ez', resolveConflicts(p, { 0: { text: 'Clik teh thing' } })).ok).toBe(false);
    await writeFile(join(r.dir, 'journeys/c.ez'), resolveConflicts(p, { 0: 'theirs' }));
    await r.repo.stage(['journeys/c.ez']);
    expect(await r.repo.conflictedFiles()).toEqual([]);
  });

  it('records commit, branch, author and dirty state for runs; CI variables name the branch of a detached checkout', async () => {
    const r = await tmpRepo();
    await r.write('a.ez', J1);
    const sha = await r.commit('one', 'Alice <alice@example.com>');
    expect(await collectRunVcs(r.dir, {})).toEqual({ commit: sha, branch: 'main', author: 'Alice <alice@example.com>', dirty: false });
    await r.write('a.ez', J1 + '\n');
    await r.run(['checkout', '-q', '--detach']);
    const v = await collectRunVcs(r.dir, { BUILD_SOURCEBRANCH: 'refs/heads/release/1.2' });
    expect(v).toMatchObject({ commit: sha, branch: 'release/1.2', dirty: true });
    const env = runVcsEnvironment(v);
    expect(env).toMatchObject({ gitCommit: sha, gitBranch: 'release/1.2', gitDirty: 'true' });
    expect(runVcs({ environment: env } as RunResult)).toMatchObject({ commit: sha, branch: 'release/1.2', dirty: true });
    expect(await collectRunVcs(r.dir, { EZTEST_GIT: 'off' })).toEqual({});
    expect(await collectRunVcs(await mkdtemp(join(tmpdir(), 'nogit-')), {})).toEqual({});
    expect(ciBranch({ SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/feat/x', BUILD_SOURCEBRANCH: 'refs/pull/5/merge' })).toBe('feat/x');
    expect(ciBranch({ GITHUB_HEAD_REF: 'feat/y', GITHUB_REF: 'refs/pull/9/merge' })).toBe('feat/y');
    expect(ciBranch({ CI_COMMIT_BRANCH: 'main' })).toBe('main');
    expect(redactGitText('fatal: https://user:ghp_SECRET123@github.com/o/r.git not found')).toBe('fatal: https://***@github.com/o/r.git not found');
  });
});

describe('CODEOWNERS', () => {
  it('reads GitHub, GitLab (sections) and Azure Repos owners; last match wins; directories own their contents', async () => {
    const co = parseCodeowners(`# owners
*                         @org/qa
/journeys/                @alice
journeys/payments/**      @bob payments@contoso.com
*.yaml                    @carol
[Checkout] @org/checkout
/journeys/checkout/
^[Docs]
docs/ "[Shop]\\Doc Writers"
bad-owner-line            not-an-owner
`);
    expect(co.errors).toEqual([{ line: 10, message: 'unrecognised owner "not-an-owner"' }]);
    const o = (p: string) => ownersOf(co, p).map((x) => x.raw);
    expect(o('README.md')).toEqual(['@org/qa']);
    expect(o('journeys/login.ez')).toEqual(['@alice']);
    expect(o('journeys/payments/card.ez')).toEqual(['@bob', 'payments@contoso.com']);
    expect(o('journeys/payments/data.yaml')).toEqual(['@carol']);
    expect(o('journeys/checkout/pay.ez')).toEqual(['@alice', '@org/checkout']);
    expect(o('docs/x.md')).toEqual(['@org/qa', '[Shop]\\Doc Writers']);
    expect(ownersOf(co, 'docs/x.md').map((x) => x.kind)).toEqual(['team', 'group']);
    expect(assigneeFor(ownersOf(co, 'journeys/payments/card.ez'))).toBe('payments@contoso.com');
    expect(assigneeFor(ownersOf(co, 'journeys/login.ez'), { '@alice': 'alice@contoso.com' })).toBe('alice@contoso.com');
    const r = await tmpRepo();
    await r.write('.gitlab/CODEOWNERS', '*.ez @gitlab-user\n');
    expect((await loadCodeowners(r.dir)).file).toBe('.gitlab/CODEOWNERS');
    await r.write('.github/CODEOWNERS', '*.ez @github-user\n');
    const gh = await loadCodeowners(r.dir);
    expect(gh.file).toBe('.github/CODEOWNERS');
    expect(ownersOf(gh, 'deep/a.ez').map((x) => x.name)).toEqual(['github-user']);
  });
});

describe('branch-scoped baselines and history', () => {
  it('a branch compares against its own baselines, seeded from main, promoted after the merge', async () => {
    const r = await tmpRepo();
    await r.write('a.ez', J1);
    await r.commit('one');
    const base = join(r.dir, '.eztest', 'baselines');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'home.png'), 'main-home');
    await writeFile(join(base, 'cart.png'), 'main-cart');
    expect(branchBaselineDir(base, r.dir, { env: {} })).toBe(base);
    await r.repo.createBranch('feature/new-cart', { checkout: true });
    expect(currentBranchSync(r.dir, {})).toBe('feature/new-cart');
    const dir = branchBaselineDir(base, r.dir, { env: {} });
    expect(dir).toBe(join(base, 'branches', branchSlug('feature/new-cart')));
    expect(await seedBranchBaselines(base, dir)).toEqual(['cart.png', 'home.png']);
    await writeFile(join(dir, 'cart.png'), 'new-cart'); // approved on the branch
    expect(await readFile(join(base, 'cart.png'), 'utf8')).toBe('main-cart');

    const hist = await HistoryStore.open(join(r.dir, '.eztest', 'history.json'));
    const mk = (id: string, branch: string, status: 'passed' | 'failed'): RunResult => ({ runId: id, startedAt: `2026-10-0${id.slice(-1)}T00:00:00Z`, finishedAt: '', durationMs: 1, summary: { total: 1, passed: 0, passedHealed: 0, failed: 0, skipped: 0, errors: 0 }, environment: { gitBranch: branch }, journeys: [{ journeyId: 'cart', name: 'Cart', status, startedAt: '', durationMs: 1, steps: [], tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [] }] });
    hist.record(mk('r1', 'main', 'passed'));
    hist.record(mk('r2', 'feature/new-cart', 'failed'));
    hist.record(mk('r3', 'feature/new-cart', 'passed'));
    expect(hist.branches()).toEqual(['feature/new-cart', 'main']);
    expect(hist.forBranch('main').outcomesFor('cart').map((o) => o.runId)).toEqual(['r1']);
    await expect(hist.forBranch('main').save()).rejects.toThrow(/read-only/);

    // merge the branch, then promote what is merged
    await r.repo.switchBranch('main');
    await r.run(['merge', '-q', '--no-ff', '--no-edit', 'feature/new-cart']);
    const promoted = await promoteMergedBranches(r.repo, { baselineDir: base, history: hist });
    expect(promoted).toEqual([{ branch: 'feature/new-cart', baselines: ['cart.png'], historyRuns: 2 }]);
    expect(await readFile(join(base, 'cart.png'), 'utf8')).toBe('new-cart');
    expect(existsSync(dir)).toBe(false);
    const reread = await HistoryStore.open(join(r.dir, '.eztest', 'history.json'));
    expect(reread.forBranch('main').outcomesFor('cart').map((o) => o.runId)).toEqual(['r1', 'r2', 'r3']);
    expect(reread.runs.find((x) => x.runId === 'r2')!.promotedFrom).toBe('feature/new-cart');
    expect((await promoteBranchBaselines(base, 'nothing')).promoted).toEqual([]);
  });
});
