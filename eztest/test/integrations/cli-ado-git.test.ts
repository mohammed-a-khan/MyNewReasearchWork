/** The CLI wiring: eztest ado (import, sync, publish, requirements, summary, whoami), eztest pr report, eztest git owners / promote, eztest hooks. */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import { buildStepsXml } from '../../src/alm-ado/index.js';
import { startMockAdoServer } from '../alm-ado/mock-ado-server.js';
import { mockGitHub } from '../vcs/mock-hosts.js';
import { prFixture } from '../vcs/fixture.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function cli(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('eztest ado', () => {
  it('imports a suite, syncs journeys (dry run, then write), publishes a run, pulls requirements and checks credentials', async () => {
    const ado = await startMockAdoServer();
    closers.push(ado.close);
    const f = await prFixture();
    await writeFile(join(f.r.dir, 'eztest.config.yaml'), `baseUrl: http://127.0.0.1:9\nado:\n  organizationUrl: ${ado.collectionUrl}\n  project: proj\n  pat: secret://env/ADO_PAT\n`);
    const env = { ADO_PAT: ado.pat };
    const cfg = ado.configuration('Chrome', [], true);
    const tc = ado.workItem('Test Case', { 'System.Title': 'Browse the catalogue', 'Microsoft.VSTS.TCM.Steps': buildStepsXml([{ action: 'Open /catalogue', expected: 'the page contains "Products"' }]) });
    const { planId, rootSuiteId } = ado.plan('P');
    const suite = ado.suite(planId, rootSuiteId, 'S', [tc.id], [cfg]);
    ado.workItem('User Story', { 'System.Title': 'Browse', 'System.AreaPath': 'Shop' });

    const who = await cli(f.r.dir, ['ado', 'whoami'], env);
    expect(who.out).toMatch(/^pat: EZTest Bot \(.*project proj, api-version 7\.1\)$/);
    expect(who.out).not.toContain(ado.pat);

    const imp = await cli(f.r.dir, ['ado', 'import', '--plan', String(planId), '--suite', String(suite)], env);
    expect(imp.out).toMatch(/imported 1 test case\(s\): 1\/1 steps, 1\/1 expected results converted; 0 TODO/);
    const ez = await readFile(join(f.r.dir, 'journeys', 'imported', 'browse-the-catalogue.ez'), 'utf8');
    expect(ez).toContain(`Tags: @TestCaseId:${tc.id} @TestPlanId:${planId} @TestSuiteId:${suite}`);

    const dry = await cli(f.r.dir, ['ado', 'sync', 'journeys/pay.ez', '--dry-run'], env);
    expect(dry.out).toMatch(/would-create +journeys\/pay\.ez/);
    expect(dry.out).toContain('+Tags: @payments @TestCaseId:<new id>');
    const wrote = await cli(f.r.dir, ['ado', 'sync', 'journeys/pay.ez', '--write', '--plan', String(planId), '--suite', String(suite)], env);
    const id = Number(/created +journeys\/pay\.ez -> test case (\d+)/.exec(wrote.out)![1]);
    expect(await readFile(join(f.r.dir, 'journeys', 'pay.ez'), 'utf8')).toContain(`Tags: @payments @TestCaseId:${id}`);
    expect(ado.state.suites.find((s) => s.id === suite)!.testCases).toEqual([tc.id, id]);

    // publish the fixture's run (its journey now maps to the new test case)
    const run = JSON.parse(await readFile(join(f.noGo, 'run.json'), 'utf8'));
    run.journeys[0].tags = [`TestCaseId:${id}`];
    await writeFile(join(f.noGo, 'run.json'), JSON.stringify(run));
    const pub = await cli(f.r.dir, ['ado', 'publish', f.noGo, '--plan', String(planId), '--suite', String(suite)], { ...env, BUILD_BUILDID: '99', BUILD_REQUESTEDFOR: 'Pipeline' });
    const summary = JSON.parse(pub.out);
    expect(summary.results).toEqual([expect.objectContaining({ testCaseId: id, outcome: 'Failed' })]);
    expect(summary.stepResults.results).toBe(1);
    expect(ado.state.runs[0]).toMatchObject({ build: { id: '99' }, owner: { displayName: 'Pipeline' } });

    const req = await cli(f.r.dir, ['ado', 'requirements', '--area', 'Shop'], env);
    expect(req.out).toMatch(/^1 requirement\(s\) -> \.eztest\/requirements-ado\.json$/);
    expect(JSON.parse(await readFile(join(f.r.dir, '.eztest', 'requirements-ado.json'), 'utf8')).requirements[0]).toMatchObject({ title: 'Browse', source: 'ado' });
  }, 120_000);

  it('writes the results tab data and build summary; gates outside a pipeline with plain output', async () => {
    const f = await prFixture();
    const r = await cli(f.r.dir, ['ado', 'summary', f.noGo]);
    expect(r.out).toMatch(/^NO_GO: /);
    const tab = JSON.parse(await readFile(join(f.noGo, 'eztest-tab.json'), 'utf8'));
    expect(tab).toMatchObject({ format: 'eztest-tab', decision: 'NO_GO', score: 40, branch: 'feature/pay' });
    expect(tab.failures[0]).toMatchObject({ file: 'journeys/pay.ez', line: 5, category: 'product-bug' });
    expect(tab.heals[0]).toMatchObject({ file: 'journeys/login.ez', line: 3, to: 'testId=login' });
    expect(await readFile(join(f.noGo, 'eztest-summary.md'), 'utf8')).toContain('### EZTest: NO_GO');
    const g = await cli(f.r.dir, ['ado', 'gate', f.noGo]);
    expect(g.exitCode).toBe(1);
    expect(g.err).toMatch(/^FAIL EZTest readiness NO_GO \(score 40\)/);
    expect((await cli(f.r.dir, ['ado', 'gate', f.go])).out).toMatch(/^PASS/);
  });
});

describe('eztest pr / git / hooks', () => {
  it('reports to a GitHub PR from the remote and token; lists owners; installs hooks; promotes baselines', async () => {
    const gh = await mockGitHub('ghs_CLItoken123456');
    closers.push(gh.close);
    const f = await prFixture();
    await f.r.run(['remote', 'add', 'origin', 'git@github.com:acme/shop.git']);
    await writeFile(join(f.r.dir, 'eztest.config.yaml'), `baseUrl: http://127.0.0.1:9\nvcs:\n  apiUrl: ${gh.url}\n  token: secret://env/GH\n`);
    const r = await cli(f.r.dir, ['pr', 'report', f.noGo, '--pr', '5'], { GH: 'ghs_CLItoken123456' });
    expect(r.out).toMatch(/^github: EZTest: NO_GO .*; check-run posted \(2 annotation\(s\)\); comment created on #5$/);
    expect(gh.state.checkRuns[0].conclusion).toBe('failure');

    await writeFile(join(f.r.dir, 'CODEOWNERS'), 'journeys/ @acme/qa\n');
    expect((await cli(f.r.dir, ['git', 'owners', 'journeys/pay.ez', 'README.md'])).out).toBe('journeys/pay.ez: @acme/qa\nREADME.md: (no owner)');

    const h = await cli(f.r.dir, ['hooks', 'install', '--pre-push', '--command', 'npx --no-install eztest', '--strict']);
    expect(h.out).toMatch(/installed +pre-commit/);
    expect(h.out).toMatch(/installed +pre-push/);
    expect(await readFile(join(f.r.dir, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('exec npx --no-install eztest hooks run pre-commit --strict "$@"');
    expect((await cli(f.r.dir, ['hooks', 'uninstall'])).out).toBe('removed pre-commit, pre-push');

    const shared = join(f.r.dir, '.eztest', 'baselines');
    await mkdir(join(shared, 'branches', 'feature__x'), { recursive: true });
    await writeFile(join(shared, 'branches', 'feature__x', 'home.png'), 'x');
    expect((await cli(f.r.dir, ['git', 'promote', '--branch', 'feature/x'])).out).toBe('feature/x -> main: 1 baseline(s), 0 history run(s)');
    expect(existsSync(join(shared, 'home.png'))).toBe(true);
  }, 60_000);
});
