/**
 * PR integration for every host through the common provider interface, against
 * mock GitHub, GitLab, Bitbucket and Azure DevOps servers: status / check with
 * annotations on the failing journey lines, the summary comment updated in
 * place on re-runs, PRs with CODEOWNERS reviewers, and provider detection.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdoClient } from '../../src/alm-ado/index.js';
import { git } from '../../src/git/index.js';
import {
  AzureReposProvider,
  BitbucketProvider,
  buildPrSummary,
  COMMENT_MARKER,
  detectCi,
  GitHubProvider,
  GitLabProvider,
  gitlabCodeQuality,
  parseRemoteUrl,
  proposeChange,
  reportPullRequest,
  resolveProvider,
  VcsHttpError,
} from '../../src/vcs/index.js';
import { startMockAdoServer } from '../alm-ado/mock-ado-server.js';
import { mockBitbucket, mockGitHub, mockGitLab } from './mock-hosts.js';
import { prFixture } from './fixture.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const GH_TOKEN = 'ghs_TESTtoken0123456789';

describe('detection', () => {
  it('parses remote URLs of every host (https, ssh, scp-like, on-prem ADO)', () => {
    expect(parseRemoteUrl('https://github.com/acme/shop.git')).toEqual({ provider: 'github', host: 'github.com', owner: 'acme', repo: 'shop' });
    expect(parseRemoteUrl('git@github.com:acme/shop.git')).toMatchObject({ provider: 'github', owner: 'acme', repo: 'shop' });
    expect(parseRemoteUrl('https://gitlab.com/acme/web/shop.git')).toEqual({ provider: 'gitlab', host: 'gitlab.com', owner: 'acme/web', repo: 'shop', project: 'acme/web/shop' });
    expect(parseRemoteUrl('ssh://git@git.corp.example:2222/team/app.git', { 'git.corp.example': 'gitlab' })).toMatchObject({ provider: 'gitlab', project: 'team/app' });
    expect(parseRemoteUrl('git@bitbucket.org:acme/shop.git')).toMatchObject({ provider: 'bitbucket', owner: 'acme', repo: 'shop' });
    expect(parseRemoteUrl('https://contoso@dev.azure.com/contoso/Shop%20Web/_git/shop-ui')).toEqual({ provider: 'azure-devops', host: 'dev.azure.com', owner: 'contoso', project: 'Shop Web', repo: 'shop-ui', collectionUrl: 'https://dev.azure.com/contoso' });
    expect(parseRemoteUrl('git@ssh.dev.azure.com:v3/contoso/Shop/shop-ui')).toMatchObject({ provider: 'azure-devops', owner: 'contoso', project: 'Shop', repo: 'shop-ui' });
    expect(parseRemoteUrl('https://contoso.visualstudio.com/Shop/_git/shop-ui')).toMatchObject({ provider: 'azure-devops', owner: 'contoso', collectionUrl: 'https://contoso.visualstudio.com' });
    expect(parseRemoteUrl('https://tfs.corp.example/tfs/DefaultCollection/Shop/_git/shop-ui')).toMatchObject({ provider: 'azure-devops', project: 'Shop', repo: 'shop-ui', collectionUrl: 'https://tfs.corp.example/tfs/DefaultCollection' });
    expect(parseRemoteUrl('https://example.com/x/y.git')).toBeUndefined();
  });

  it('reads the commit, branch and PR from each CI', () => {
    expect(detectCi({ TF_BUILD: 'True', BUILD_REPOSITORY_PROVIDER: 'TfsGit', SYSTEM_PULLREQUEST_PULLREQUESTID: '17', SYSTEM_PULLREQUEST_SOURCECOMMITID: 'abc', SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/feat', SYSTEM_PULLREQUEST_TARGETBRANCH: 'refs/heads/main', SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: 'https://dev.azure.com/contoso/', SYSTEM_TEAMPROJECT: 'Shop', BUILD_BUILDID: '9' })).toMatchObject({ ci: 'azure-pipelines', provider: 'azure-devops', pr: 17, sha: 'abc', branch: 'feat', targetBranch: 'main', buildUrl: 'https://dev.azure.com/contoso/Shop/_build/results?buildId=9' });
    expect(detectCi({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/5/merge', GITHUB_SHA: 'm', GITHUB_HEAD_REF: 'feat', GITHUB_REPOSITORY: 'acme/shop', GITHUB_RUN_ID: '3' })).toMatchObject({ provider: 'github', pr: 5, branch: 'feat', buildUrl: 'https://github.com/acme/shop/actions/runs/3' });
    expect(detectCi({ GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '8', CI_COMMIT_SHA: 's', CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat' })).toMatchObject({ provider: 'gitlab', pr: 8, sha: 's', branch: 'feat' });
    expect(detectCi({ BITBUCKET_BUILD_NUMBER: '4', BITBUCKET_PR_ID: '2', BITBUCKET_COMMIT: 'c', BITBUCKET_BRANCH: 'feat' })).toMatchObject({ provider: 'bitbucket', pr: 2, sha: 'c' });
    expect(detectCi({})).toEqual({});
  });

  it('picks the provider from the remote and the CI token; a missing token says what to set', async () => {
    const f = await prFixture();
    await f.r.run(['remote', 'add', 'origin', 'https://github.com/acme/shop.git']);
    const r = await resolveProvider({ cwd: f.r.dir, env: { GITHUB_TOKEN: GH_TOKEN } });
    expect(r.provider.kind).toBe('github');
    expect(r.repo).toMatchObject({ owner: 'acme', repo: 'shop' });
    await expect(resolveProvider({ cwd: f.r.dir, env: {} })).rejects.toThrow(/GITHUB_TOKEN/);
    expect((await resolveProvider({ cwd: f.r.dir, env: { GITLAB_CI: 'true', CI_PROJECT_PATH: 'acme/web/shop', GITLAB_TOKEN: 'glpat-x' } })).provider.kind).toBe('gitlab');
  });
});

describe('the PR summary', () => {
  it('lists failures with their journey line, heals awaiting review and the gates; NO_GO fails, GO_WITH_RISKS is configurable', async () => {
    const f = await prFixture();
    const { loadRunForPr, journeyFileIndex } = await import('../../src/vcs/index.js');
    const files = await journeyFileIndex(f.r.dir, f.r.dir, ['journeys']);
    const s = buildPrSummary({ ...(await loadRunForPr(f.noGo)), files, reportUrl: 'https://ci/report.html' });
    expect(s).toMatchObject({ decision: 'NO_GO', state: 'failure' });
    expect(s.description).toBe('EZTest: NO_GO (score 40) - 1/2 passed, 1 healed, 1 failed');
    expect(s.markdown).toContain('### EZTest: NO_GO');
    expect(s.markdown).toContain('| Pay by card `journeys/pay.ez:5` | Click the "Pay" button | Post-condition failed: page does not contain "Paid" after 5000ms | product-bug (80%) |');
    expect(s.markdown).toContain('#### Heals awaiting review (1)');
    expect(s.markdown).toContain('| critical-journeys | fail | 1 critical journey failed: pay-by-card |');
    expect(s.annotations).toEqual([
      expect.objectContaining({ path: 'journeys/pay.ez', line: 5, level: 'failure' }),
      expect.objectContaining({ path: 'journeys/login.ez', line: 3, level: 'warning' }),
    ]);
    const risky = buildPrSummary({ run: (await loadRunForPr(f.go)).run, policy: { goWithRisks: 'failure' }, readiness: { decision: 'GO_WITH_RISKS', score: 70, runId: 'x', gates: [], rationale: [], exceptionsApplied: [], exceptionsIgnored: [], evaluatedAt: '' } });
    expect(risky.state).toBe('failure');
    expect(gitlabCodeQuality(s.annotations)[0]).toMatchObject({ check_name: 'eztest', severity: 'major', location: { path: 'journeys/pay.ez', lines: { begin: 5 } } });
  });
});

describe('GitHub', () => {
  it('posts a check run with annotations and one comment, both updated in place on a re-run', async () => {
    const gh = await mockGitHub(GH_TOKEN);
    closers.push(gh.close);
    const f = await prFixture();
    const p = new GitHubProvider({ repo: { provider: 'github', host: 'github.com', owner: 'acme', repo: 'shop' }, token: GH_TOKEN, apiUrl: gh.url, sleep: async () => undefined });
    gh.state.comments.set(5, [{ id: 1, body: 'LGTM' }, { id: 2, body: 'nit' }, { id: 3, body: 'another' }]);
    const r1 = await reportPullRequest({ provider: p, runDir: f.noGo, cwd: f.r.dir, pr: 5 });
    expect(r1.status).toMatchObject({ kind: 'check-run', annotations: 2 });
    expect(gh.state.checkRuns).toHaveLength(1);
    expect(gh.state.checkRuns[0]).toMatchObject({ name: 'EZTest', head_sha: f.sha, status: 'completed', conclusion: 'failure' });
    expect(gh.state.checkRuns[0].annotationsSeen).toEqual([
      expect.objectContaining({ path: 'journeys/pay.ez', start_line: 5, end_line: 5, annotation_level: 'failure' }),
      expect.objectContaining({ path: 'journeys/login.ez', start_line: 3, annotation_level: 'warning' }),
    ]);
    expect(r1.comment!.action).toBe('created');
    const r2 = await reportPullRequest({ provider: p, runDir: f.go, cwd: f.r.dir, pr: 5 });
    expect(gh.state.checkRuns).toHaveLength(1);
    expect(gh.state.checkRuns[0].conclusion).toBe('success');
    expect(r2.comment).toEqual({ id: r1.comment!.id, action: 'updated' });
    const mine = gh.state.comments.get(5)!.filter((c) => c.body.includes(COMMENT_MARKER));
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toContain('### EZTest: GO');
    // the comment list was paged (2 per page)
    expect(gh.reqs.filter((x) => x.path.endsWith('/issues/5/comments') && x.method === 'GET').length).toBeGreaterThanOrEqual(4);
    expect((await reportPullRequest({ provider: p, runDir: f.go, cwd: f.r.dir, pr: 5 })).comment!.action).toBe('unchanged');
  });

  it('falls back to a commit status when the token cannot create checks; opens PRs with user and team reviewers; never leaks the token', async () => {
    const gh = await mockGitHub(GH_TOKEN, { checksForbidden: true });
    closers.push(gh.close);
    const f = await prFixture();
    const p = new GitHubProvider({ repo: { provider: 'github', host: 'github.com', owner: 'acme', repo: 'shop' }, token: GH_TOKEN, apiUrl: gh.url, sleep: async () => undefined });
    const r = await reportPullRequest({ provider: p, runDir: f.noGo, cwd: f.r.dir, comment: false });
    expect(r.status).toMatchObject({ kind: 'commit-status' });
    expect(r.warnings.join()).toMatch(/check runs not available/);
    expect(gh.state.statuses[0]).toMatchObject({ sha: f.sha, body: { state: 'failure', context: 'EZTest' } });
    const pr = await p.createPullRequest({ source: 'eztest/heal-1', target: 'main', title: 'Heal', description: 'x', reviewers: [{ raw: '@alice', kind: 'user', name: 'alice' }, { raw: '@acme/qa', kind: 'team', name: 'acme/qa' }, { raw: 'x@y.com', kind: 'email', name: 'x@y.com' }] });
    expect(pr).toMatchObject({ reviewers: ['alice', 'acme/qa'] });
    expect(pr.warnings).toEqual(['reviewer x@y.com is not a GitHub user or team; not requested']);
    expect(gh.state.pulls[0]).toMatchObject({ head: 'eztest/heal-1', base: 'main', reviewers: ['alice'], team_reviewers: ['qa'] });
    expect((await p.createPullRequest({ source: 'eztest/heal-1', target: 'main', title: 'Heal', description: 'x' })).number).toBe(pr.number);
    const bad = new GitHubProvider({ repo: { provider: 'github', host: 'github.com', owner: 'acme', repo: 'shop' }, token: 'ghs_WRONGwrongWRONG99', apiUrl: gh.url });
    const e = await bad.upsertComment(1, COMMENT_MARKER, 'x').catch((x) => x);
    expect(e).toBeInstanceOf(VcsHttpError);
    expect(e.code).toBe('VCS_AUTH');
    expect(e.message).not.toContain('WRONG');
  });
});

describe('GitLab', () => {
  it('posts a commit status, MR line discussions (reused on re-runs) and one MR note updated in place', async () => {
    const gl = await mockGitLab('glpat-TEST123456');
    closers.push(gl.close);
    const f = await prFixture();
    const p = new GitLabProvider({ repo: { provider: 'gitlab', host: 'gitlab.com', owner: 'acme/web', repo: 'shop', project: 'acme/web/shop' }, token: 'glpat-TEST123456', apiUrl: `${gl.url}/api/v4` });
    const r1 = await reportPullRequest({ provider: p, runDir: f.noGo, cwd: f.r.dir, pr: 8 });
    expect(gl.state.statuses[0]).toMatchObject({ sha: f.sha, query: { state: 'failed', name: 'EZTest' } });
    expect(r1.status!.annotations).toBe(2);
    expect(gl.state.discussions.get(8)!.map((d) => (d.notes[0].position as { new_line: number; new_path: string }).new_path + ':' + (d.notes[0].position as { new_line: number }).new_line)).toEqual(['journeys/pay.ez:5', 'journeys/login.ez:3']);
    await reportPullRequest({ provider: p, runDir: f.noGo, cwd: f.r.dir, pr: 8 });
    expect(gl.state.discussions.get(8)).toHaveLength(2);
    const r2 = await reportPullRequest({ provider: p, runDir: f.go, cwd: f.r.dir, pr: 8 });
    expect(gl.state.statuses.at(-1)!.query.state).toBe('success');
    expect(r2.comment).toEqual({ id: r1.comment!.id, action: 'updated' });
    expect(gl.state.notes.get(8)!.filter((n) => n.body.includes(COMMENT_MARKER))).toHaveLength(1);
    const mr = await p.createPullRequest({ source: 'eztest/q', target: 'main', title: 'Quarantine', description: 'd', reviewers: [{ raw: '@alice', kind: 'user', name: 'alice' }, { raw: 'bob@contoso.com', kind: 'email', name: 'bob@contoso.com' }, { raw: '@acme/qa', kind: 'team', name: 'acme/qa' }] });
    expect(mr.reviewers).toEqual(['alice', 'bob']);
    expect(gl.state.mrs[0]).toMatchObject({ source_branch: 'eztest/q', target_branch: 'main', reviewer_ids: [7, 8] });
    expect(mr.warnings[0]).toMatch(/groups cannot be MR reviewers/);
  });
});

describe('Bitbucket', () => {
  it('posts a build status, a Code Insights report with annotations, one PR comment updated in place, PRs with reviewers', async () => {
    const bb = await mockBitbucket('bbtoken-TEST123456');
    closers.push(bb.close);
    const f = await prFixture();
    const p = new BitbucketProvider({ repo: { provider: 'bitbucket', host: 'bitbucket.org', owner: 'acme', repo: 'shop' }, token: 'bbtoken-TEST123456', apiUrl: `${bb.url}/2.0` });
    bb.state.comments.set(3, [{ id: 1, content: { raw: 'a' }, deleted: false }, { id: 2, content: { raw: 'b' }, deleted: false }, { id: 4, content: { raw: 'c' }, deleted: false }]);
    const r1 = await reportPullRequest({ provider: p, runDir: f.noGo, cwd: f.r.dir, pr: 3, reportUrl: 'https://ci/report' });
    expect(bb.state.statuses[0]).toMatchObject({ sha: f.sha, body: { key: 'EZTEST', state: 'FAILED', url: 'https://ci/report' } });
    expect(r1.status).toMatchObject({ kind: 'code-insights', annotations: 2 });
    const rep = bb.state.reports.get(`${f.sha}:eztest`)!;
    expect(rep.report).toMatchObject({ report_type: 'TEST', result: 'FAILED', reporter: 'EZTest' });
    expect(rep.annotations).toEqual([expect.objectContaining({ path: 'journeys/pay.ez', line: 5, severity: 'HIGH' }), expect.objectContaining({ path: 'journeys/login.ez', line: 3, severity: 'MEDIUM' })]);
    const r2 = await reportPullRequest({ provider: p, runDir: f.go, cwd: f.r.dir, pr: 3 });
    expect(r2.comment).toEqual({ id: r1.comment!.id, action: 'updated' });
    expect(bb.state.reports.get(`${f.sha}:eztest`)!.annotations).toEqual([]);
    expect(bb.state.comments.get(3)!.filter((c) => c.content.raw.includes(COMMENT_MARKER))).toHaveLength(1);
    const pr = await p.createPullRequest({ source: 'eztest/b', target: 'main', title: 'Baselines', description: 'd', reviewers: [{ raw: '@bob', kind: 'user', name: 'bob' }, { raw: '@zed', kind: 'user', name: 'zed' }] });
    expect(pr.reviewers).toEqual(['bob']);
    expect(bb.state.prs[0].reviewers).toEqual([{ account_id: '557058:bbbb' }]);
    expect(pr.warnings).toEqual(['reviewer @zed is not a member of workspace acme']);
  });
});

describe('Azure Repos', () => {
  it('posts the PR status (EZTest: NO_GO / GO), a summary thread and line threads, updated in place and resolved when fixed', async () => {
    const ado = await startMockAdoServer();
    closers.push(ado.close);
    const repoId = ado.repo('shop-ui');
    ado.state.pullRequests.push({ pullRequestId: 77, repositoryId: repoId, sourceRefName: 'refs/heads/feature/pay', targetRefName: 'refs/heads/main', title: 'Pay', description: '', isDraft: false, status: 'active', reviewers: [] });
    const c = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: ado.pat } });
    const p = new AzureReposProvider(c, { repo: 'shop-ui' });
    const f = await prFixture();
    // No PR number given: found from the run's branch.
    const r1 = await reportPullRequest({ provider: p, runDir: f.noGo, cwd: f.r.dir });
    expect(r1.pr).toBe(77);
    expect(ado.state.prStatuses[0]).toMatchObject({ pr: 77, body: { state: 'failed', description: 'EZTest: NO_GO (score 40) - 1/2 passed, 1 healed, 1 failed', context: { name: 'EZTest', genre: 'eztest' } } });
    const threads = () => ado.state.threads.get(`${repoId}:77`)!;
    expect(threads()).toHaveLength(3);
    const summary = threads().find((t) => t.comments[0].content.includes(COMMENT_MARKER))!;
    expect(summary.status).toBe('active');
    const lines = threads().filter((t) => t.threadContext);
    expect(lines.map((t) => t.threadContext)).toEqual([
      { filePath: '/journeys/pay.ez', rightFileStart: { line: 5, offset: 1 }, rightFileEnd: { line: 5, offset: 1 } },
      { filePath: '/journeys/login.ez', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } },
    ]);
    // Re-run green: same threads, summary resolved, line threads fixed; no new threads.
    const r2 = await reportPullRequest({ provider: p, runDir: f.go, cwd: f.r.dir });
    expect(r2.comment).toEqual({ id: summary.id, action: 'updated' });
    expect(ado.state.prStatuses.at(-1)!.body.state).toBe('succeeded');
    expect(threads()).toHaveLength(3);
    expect(threads().find((t) => t.id === summary.id)!.status).toBe('closed');
    expect(threads().filter((t) => t.threadContext).map((t) => t.status)).toEqual(['fixed', 'fixed']);
    // Outside a PR: a commit status.
    const r3 = await reportPullRequest({ provider: p, runDir: f.go, cwd: f.r.dir, ci: { branch: 'no-pr' } });
    expect(r3.status!.kind).toBe('commit-status');
    expect(ado.state.commitStatuses[0]).toMatchObject({ sha: f.sha, body: { state: 'succeeded' } });
  });

  it('an accepted heal becomes a branch, a commit and a PR in Azure Repos with reviewers from CODEOWNERS', async () => {
    const ado = await startMockAdoServer();
    closers.push(ado.close);
    const repoId = ado.repo('shop-ui');
    ado.state.identities.push({ id: 'id-alice', providerDisplayName: 'Alice', filterValues: ['alice@contoso.com'] }, { id: 'id-qa', providerDisplayName: '[proj]\\QA', filterValues: ['[proj]\\QA'] });
    const base = await mkdtemp(join(tmpdir(), 'eztest-ado-remote-'));
    const f = await prFixture({ bare: join(base, 'origin.git') });
    await f.r.write('.azuredevops/CODEOWNERS', '/journeys/ alice@contoso.com "[proj]\\QA" @nobody\n');
    await f.r.commit('owners');
    await f.r.run(['push', '-q', '-u', 'origin', 'main']);
    await f.r.write('journeys/login.ez', 'Journey: Login\n\nClick the "Sign in" button [id=click-the-sign-in-button]\n  Expect the URL contains "/home"\n');
    const p = new AzureReposProvider(new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: ado.pat } }), { repo: 'shop-ui' });
    const res = await proposeChange({ cwd: f.r.dir, kind: 'heal', files: ['journeys/login.ez'], title: 'EZTest: accept heal of Login / Sign in', body: 'Reviewed in EZTest Studio.', provider: p, target: 'main' });
    expect(res.pushed).toBe(true);
    expect(res.pr!.url).toBe(`${ado.collectionUrl}/proj/_git/shop-ui/pullrequest/${res.pr!.number}`);
    expect(res.pr!.reviewers).toEqual(['Alice', '[proj]\\QA']);
    expect(res.warnings).toEqual(['reviewer @nobody not found in Azure DevOps']);
    expect(ado.state.pullRequests.at(-1)).toMatchObject({ repositoryId: repoId, sourceRefName: `refs/heads/${res.branch}`, targetRefName: 'refs/heads/main', reviewers: [{ id: 'id-alice' }, { id: 'id-qa' }] });
    const ls = await git(['ls-remote', join(base, 'origin.git')], { cwd: base });
    expect(ls.stdout).toContain(`refs/heads/${res.branch}`);
    expect(await f.r.repo.currentBranch()).toBe('main');
  });
});
