/** Git hooks (installed and fired by real commits), pre-push impact, bisect in a worktree, and change requests built without touching the checkout. */
import { describe, expect, it } from '../support/testkit.js';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bisectJourney, git, HOOK_MARKER, installHooks, lintJourneyText, preCommit, prePushPlan, uninstallHooks } from '../../src/git/index.js';
import { proposeChange, type PullRequestInput, type VcsProvider } from '../../src/vcs/index.js';
import { tmpRepo } from './helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = [join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'bin.ts')];
const GOOD = 'Journey: Pay\nOpen /cart\nClick the "Pay" button\n  Expect the page contains "Paid"\n';

describe('git hooks', () => {
  it('installs a pre-commit hook that validates and lints the staged journeys on a real commit', async () => {
    const r = await tmpRepo('hooks');
    await r.write('README.md', 'x');
    await r.commit('init');
    // A hook that was there before keeps running first.
    await r.write('.git/hooks/pre-commit', '#!/bin/sh\necho "legacy hook ran"\n');
    const { chmod } = await import('node:fs/promises');
    await chmod(join(r.dir, '.git/hooks/pre-commit'), 0o755);
    const inst = await installHooks(r.dir, { command: CLI });
    expect(inst).toEqual([expect.objectContaining({ hook: 'pre-commit', action: 'kept-existing-as-pre-eztest' })]);
    const script = await readFile(join(r.dir, '.git/hooks/pre-commit'), 'utf8');
    expect(script).toContain(HOOK_MARKER);
    expect(statSync(join(r.dir, '.git/hooks/pre-commit')).mode & 0o111).toBeTruthy();
    expect((await installHooks(r.dir, { command: CLI }))[0].action).toBe('updated');

    await r.write('journeys/bad.ez', 'Journey: Bad\nOpen /cart\nClik the button\n');
    await r.run(['add', 'journeys/bad.ez']);
    const fail = await git(['commit', '-m', 'bad'], { cwd: r.dir, timeoutMs: 120_000 }).catch((e) => e);
    expect(fail.exitCode).toBe(1);
    expect(fail.stderr).toMatch(/error journeys\/bad\.ez:3 \[parse\]/);
    expect(await r.run(['log', '--oneline'])).not.toMatch(/bad/);

    await r.run(['rm', '--cached', '-q', 'journeys/bad.ez']);
    await r.write('journeys/pay.ez', GOOD + 'Click the "Receipt" link\n');
    await r.run(['add', 'journeys/pay.ez']);
    const ok = await git(['commit', '-m', 'pay'], { cwd: r.dir, timeoutMs: 120_000 });
    expect(ok.stdout + ok.stderr).toMatch(/legacy hook ran/);
    expect(ok.stdout + ok.stderr).toMatch(/warn  journeys\/pay\.ez:5 \[unverifiable-action\]/);
    expect(await r.run(['log', '--oneline', '-1'])).toMatch(/pay/);

    expect(await uninstallHooks(r.dir)).toEqual(['pre-commit']);
    expect(await readFile(join(r.dir, '.git/hooks/pre-commit'), 'utf8')).toContain('legacy hook ran');
  }, 180_000);

  it('lints the staged version, not the working copy; conflict markers and TODOs are reported', async () => {
    const r = await tmpRepo('lint');
    await r.write('journeys/pay.ez', GOOD);
    await r.run(['add', '.']);
    await r.write('journeys/pay.ez', 'broken now');
    expect((await preCommit(r.dir)).ok).toBe(true);
    expect(lintJourneyText('a.ez', `${GOOD}<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n`)).toEqual([expect.objectContaining({ rule: 'conflict-markers', line: 5, severity: 'error' })]);
    expect(lintJourneyText('a.ez', `${GOOD}# TODO (not converted): Reticulate\n`).map((i) => i.rule)).toEqual(['todo']);
    await r.write('journeys/pay.ez', `${GOOD}# TODO (not converted): Reticulate\n`);
    await r.run(['add', '.']);
    expect((await preCommit(r.dir)).ok).toBe(true);
    expect((await preCommit(r.dir, { strict: true })).ok).toBe(false);
    // YAML outside the journeys directory is not a journey
    await r.write('ci/pipeline.yaml', 'not: [a journey');
    await r.run(['add', '.']);
    expect((await preCommit(r.dir)).files).toEqual(['journeys/pay.ez']);
  });

  it('pre-push finds the journeys a push impacts: changed journeys and mapped app files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'eztest-remote-'));
    const r = await tmpRepo('push', { bare: join(base, 'origin.git') });
    await r.write('journeys/pay.ez', GOOD);
    await r.write('journeys/login.ez', 'Journey: Login\nTags: @auth\nOpen /login\n');
    await r.write('src/cart.ts', 'export {}\n');
    await r.write('impact.yaml', 'mappings:\n  - name: auth\n    paths: ["src/auth/**"]\n    tags: [auth]\n');
    await r.commit('init');
    await r.run(['push', '-q', '-u', 'origin', 'main']);
    expect((await prePushPlan(r.dir)).journeyFiles).toEqual([]);
    await r.write('journeys/pay.ez', GOOD.replace('"Paid"', '"Thanks"'));
    await r.write('src/auth/session.ts', 'export {}\n');
    await r.commit('change');
    const plan = await prePushPlan(r.dir, { mapping: join(r.dir, 'impact.yaml'), journeys: [{ id: 'login', file: 'journeys/login.ez', tags: ['auth'], requirements: [], risk: 3 }, { id: 'pay', file: 'journeys/pay.ez', tags: [], requirements: [], risk: 3 }] });
    expect(plan.base).toBe('origin/main');
    expect(plan.changedFiles.sort()).toEqual(['journeys/pay.ez', 'src/auth/session.ts']);
    expect(plan.journeyFiles).toEqual(['journeys/pay.ez', 'journeys/login.ez']);
  });
});

describe('bisect', () => {
  async function history() {
    const r = await tmpRepo('bisect');
    await r.write('journeys/status.ez', 'Journey: Status\nOpen /status\n  Expect the page contains "ok"\n');
    await r.write('app/status.txt', 'ok');
    const shas = [await r.commit('c1 good')];
    for (let i = 2; i <= 8; i++) {
      if (i === 3) await r.write('app/SKIP', 'build broken here');
      if (i === 4) await r.run(['rm', '-q', 'app/SKIP']);
      if (i === 5) await r.write('app/status.txt', 'broken');
      await r.write('app/log.txt', `change ${i}`);
      shas.push(await r.commit(`c${i}${i === 5 ? ' breaks status' : ''}`));
    }
    return { r, shas };
  }

  it('finds the first bad commit in a separate worktree, skipping untestable commits; the checkout is untouched', async () => {
    const { r, shas } = await history();
    await r.write('app/local-edit.txt', 'uncommitted work');
    const tested: string[] = [];
    const res = await bisectJourney({
      cwd: r.dir,
      journey: 'journeys/status.ez',
      good: shas[0],
      bad: 'HEAD',
      test: async ({ dir, sha }) => {
        tested.push(sha);
        expect(dir).not.toBe(r.dir);
        expect(await readFile(join(dir, 'journeys/status.ez'), 'utf8')).toContain('Journey: Status');
        if (existsSync(join(dir, 'app/SKIP'))) return 'skip';
        return (await readFile(join(dir, 'app/status.txt'), 'utf8')) === 'ok' ? 'good' : 'bad';
      },
    });
    expect(res.status).toBe('found');
    expect(res.firstBad!.sha).toBe(shas[4]);
    expect(res.firstBad!.subject).toBe('c5 breaks status');
    expect(res.total).toBe(7);
    expect(res.tested).toBeLessThan(7);
    expect(await r.repo.currentBranch()).toBe('main');
    expect(await readFile(join(r.dir, 'app/local-edit.txt'), 'utf8')).toBe('uncommitted work');
    expect((await r.run(['worktree', 'list'])).trim().split('\n')).toHaveLength(1);
  });

  it('runs a test command (argv, no shell) in the worktree and reports when good is already bad', async () => {
    const { r, shas } = await history();
    const script = "process.exit(require('fs').readFileSync('app/status.txt','utf8') === 'ok' ? 0 : 1)";
    const res = await bisectJourney({ cwd: r.dir, journey: 'journeys/status.ez', good: shas[1], bad: shas[7], command: [process.execPath, '-e', script] });
    expect(res.status).toBe('found');
    expect(res.firstBad!.sha).toBe(shas[4]);
    expect(res.steps.find((s) => s.sha === shas[1])!.note).toBe('exit 0');
    const wrong = await bisectJourney({ cwd: r.dir, journey: 'journeys/status.ez', good: shas[5], bad: shas[7], command: [process.execPath, '-e', script] });
    expect(wrong.status).toBe('good-is-bad');
    await expect(bisectJourney({ cwd: r.dir, journey: 'journeys/status.ez', good: shas[7], bad: shas[1], command: ['true'] })).rejects.toThrow(/not an ancestor/);
  });
});

describe('change requests', () => {
  it('commits the files on a new branch from origin/main, pushes it and opens a PR with CODEOWNERS reviewers; the checkout is untouched', async () => {
    const base = await mkdtemp(join(tmpdir(), 'eztest-cr-remote-'));
    const r = await tmpRepo('cr', { bare: join(base, 'origin.git') });
    await r.write('journeys/pay.ez', GOOD);
    await r.write('CODEOWNERS', '/journeys/ @alice qa@contoso.com\n');
    await r.commit('init');
    await r.run(['push', '-q', '-u', 'origin', 'main']);
    await r.repo.createBranch('work', { checkout: true });
    // The user has other work in progress: a staged file and an unstaged edit.
    await r.write('notes.txt', 'staged work');
    await r.run(['add', 'notes.txt']);
    const healed = GOOD.replace('Click the "Pay" button', 'Click the "Pay now" button [id=click-the-pay-button]');
    await r.write('journeys/pay.ez', healed);
    await r.write('.eztest/quarantine.json', '{"version":1,"entries":[]}\n');
    const calls: PullRequestInput[] = [];
    const provider = { kind: 'github', repo: { provider: 'github', host: 'github.com', owner: 'o', repo: 'r' }, async createPullRequest(p: PullRequestInput) { calls.push(p); return { number: 12, url: 'https://github.com/o/r/pull/12', reviewers: ['alice'], warnings: [] }; } } as unknown as VcsProvider;
    const res = await proposeChange({ cwd: r.dir, kind: 'heal', files: [join(r.dir, 'journeys/pay.ez'), '.eztest/quarantine.json'], title: 'Accept heal: Pay', body: 'Accepted in EZTest Studio by Ada.', target: 'main', provider, branch: 'eztest/heal-pay' });
    expect(res).toMatchObject({ branch: 'eztest/heal-pay', target: 'main', pushed: true, pr: { number: 12 } });
    expect(res.reviewers.map((x) => x.raw)).toEqual(['@alice', 'qa@contoso.com']);
    expect(calls[0]).toMatchObject({ source: 'eztest/heal-pay', target: 'main', title: 'Accept heal: Pay' });
    // remote branch: parent is origin/main, the tree has the healed file and the (ignored-by-default) quarantine file
    const remote = await git(['--git-dir', join(base, 'origin.git'), 'log', '--format=%s %P', '-1', 'eztest/heal-pay'], { cwd: base });
    expect(remote.stdout.trim()).toBe(`Accept heal: Pay ${(await r.run(['rev-parse', 'origin/main'])).trim()}`);
    expect((await git(['--git-dir', join(base, 'origin.git'), 'show', 'eztest/heal-pay:journeys/pay.ez'], { cwd: base })).stdout).toBe(healed);
    expect((await git(['--git-dir', join(base, 'origin.git'), 'show', 'eztest/heal-pay:.eztest/quarantine.json'], { cwd: base })).stdout).toContain('"entries"');
    // the user's checkout: same branch, same index, same working tree
    expect(await r.repo.currentBranch()).toBe('work');
    const st = await r.repo.status();
    expect(st.entries.find((e) => e.path === 'notes.txt')).toMatchObject({ staged: true });
    expect(st.entries.find((e) => e.path === 'journeys/pay.ez')).toMatchObject({ staged: false, unstaged: true });
    expect(await readFile(join(r.dir, 'journeys/pay.ez'), 'utf8')).toBe(healed);
    await expect(proposeChange({ cwd: r.dir, kind: 'heal', files: ['journeys/pay.ez'], title: 't', body: 'b', branch: 'eztest/heal-pay' })).rejects.toThrow(/already exists/);
    await writeFile(join(r.dir, 'journeys/pay.ez'), GOOD);
    await expect(proposeChange({ cwd: r.dir, kind: 'heal', files: ['journeys/pay.ez'], title: 't', body: 'b', target: 'main' })).rejects.toThrow(/nothing to propose/);
  });
});
