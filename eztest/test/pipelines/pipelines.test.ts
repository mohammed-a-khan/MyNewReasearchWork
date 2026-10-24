/**
 * Tests mapped to pipelines: tag expressions, the static selection with a
 * reason per journey, `pipelines explain` / `list` / `tags report` through
 * the CLI, CI stage and trigger detection from each system's variables (fake
 * environments), and run settings (environment, browsers, shards, impact).
 */
import { describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { buildProgram } from '../../src/cli/program.js';
import { PipelineEntrySchema } from '../../src/config/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import {
  detectCi, detectVersion, matchesTags, parseTagExpression, pipelineRunSettings, planPipeline, resolvePipeline, tagExpressionToText, tagsReport, TagExpressionError,
} from '../../src/pipelines/index.js';

const entry = (e: Record<string, unknown>) => PipelineEntrySchema.parse(e);
const PIPELINES = {
  pr: entry({ tags: '@smoke', impact: true, budget: '10m', browsers: ['chromium'], trigger: 'pr' }),
  nightly: entry({ tags: '@regression and not @quarantined', shards: 4, browsers: ['chromium', 'firefox'], trigger: 'schedule' }),
  'deploy-sit': entry({ environment: 'sit', tags: '@sit or @smoke', testPlan: 417, gate: 'readiness', stages: ['TestSIT'] }),
  'deploy-uat': entry({ environment: 'uat', tags: '@uat', requires: ['deploy-sit'], gate: 'readiness' }),
};

const j = (id: string, tags: string, extra = '') => parseEzScript(`Journey: ${id}\nId: ${id}\nTags: ${tags}\n${extra}\nSet variable x to 1\n`);
const JOURNEYS = [
  j('login', '@smoke @sit'),
  j('checkout', '@regression @payments', 'Risk: 5'),
  j('refund', '@regression @quarantined'),
  j('report', '@uat @regression', 'Browsers: firefox'),
  j('legacy', ''),
  j('helper', '@library'),
  parseEzScript('Setup: Seed data\nId: seed\nReturns: tenant\n\nSet variable tenant to "t"\n'),
];

describe('tag expressions', () => {
  it('and, or, not, parentheses, commas, prefixes', () => {
    const e = parseTagExpression('(@sit or @smoke) and not @slow');
    expect(matchesTags(e, ['sit'])).toBe(true);
    expect(matchesTags(e, ['SMOKE', 'slow'])).toBe(false);
    expect(matchesTags(e, ['uat'])).toBe(false);
    expect(matchesTags(parseTagExpression('@a, @b'), ['b'])).toBe(true);
    expect(matchesTags(parseTagExpression('@team-*'), ['team-payments'])).toBe(true);
    expect(matchesTags(parseTagExpression('!@x && @y'), ['y'])).toBe(true);
    expect(tagExpressionToText(e)).toBe('(@sit or @smoke) and not @slow');
  });
  it('explains malformed expressions', () => {
    expect(() => parseTagExpression('@a and')).toThrow(TagExpressionError);
    expect(() => parseTagExpression('(@a or @b')).toThrow(/missing "\)"/);
    expect(() => parseTagExpression('@a @b')).toThrow(/unexpected "@b"/);
  });
});

describe('pipeline selection', () => {
  it('selects by tags with a reason for every journey; setup journeys run around, library journeys never', () => {
    const p = planPipeline('nightly', PIPELINES.nightly, JOURNEYS);
    expect(p.selected.map((x) => x.id)).toEqual(['checkout', 'report']);
    expect(p.around.map((x) => x.id)).toEqual(['seed']);
    const why = Object.fromEntries(p.decisions.map((d) => [d.journeyId, d.reasons.join('; ')]));
    expect(why.refund).toMatch(/tags do not match @regression and not @quarantined \(has @regression, @quarantined\)/);
    expect(why.login).toMatch(/lacks @regression/);
    expect(why.helper).toMatch(/@library/);
    expect(why.seed).toMatch(/Setup: journey/);
    expect(why.report).toMatch(/runs on firefox only \(Browsers: header\)/);
    expect(p.dynamic).toEqual(['split into 4 shard(s) balanced by historical duration']);
  });

  it('drops journeys whose Browsers: header excludes the pipeline browsers, and applies risk', () => {
    const p = planPipeline('x', entry({ tags: '@regression', browsers: ['chromium'], risk: '>=4' }), JOURNEYS);
    expect(p.selected.map((x) => x.id)).toEqual(['checkout']);
    expect(p.decisions.find((d) => d.journeyId === 'report')!.reasons.join(' ')).toMatch(/Browsers: firefox excludes chromium/);
  });

  it('no selected journeys means no setup either', () => {
    const p = planPipeline('none', entry({ tags: '@nothing' }), JOURNEYS);
    expect(p.selected).toEqual([]);
    expect(p.around).toEqual([]);
  });

  it('tags report: journeys in no pipeline, untagged journeys, empty pipelines', () => {
    const r = tagsReport(JOURNEYS, { ...PIPELINES, empty: entry({ tags: '@nothing' }) });
    expect(r.untagged).toEqual(['legacy']);
    expect(r.inNoPipeline.sort()).toEqual(['legacy', 'refund']);
    expect(r.emptyPipelines).toEqual(['empty']);
    expect(r.pipelines.find((p) => p.name === 'deploy-sit')!.journeys).toBe(1);
    expect(r.tagCounts[0]).toEqual({ tag: 'regression', journeys: 3 });
  });

  it('run settings: environment, browsers, impact base, budget and the CI shard', () => {
    const azureShard = detectCi({ TF_BUILD: 'True', SYSTEM_JOBPOSITIONINPHASE: '2', SYSTEM_TOTALJOBSINPHASE: '4', BUILD_REASON: 'PullRequest', SYSTEM_PULLREQUEST_TARGETBRANCH: 'refs/heads/release/1' });
    expect(pipelineRunSettings(PIPELINES.pr, azureShard, {})).toEqual({ browsers: ['chromium'], changedSince: 'origin/release/1', budget: '10m' });
    expect(pipelineRunSettings(PIPELINES.pr, azureShard, { EZTEST_BASE_REF: 'origin/dev' }).changedSince).toBe('origin/dev');
    expect(pipelineRunSettings(PIPELINES.nightly, azureShard, {})).toEqual({ browsers: ['chromium', 'firefox'], shard: '2/4' });
    expect(pipelineRunSettings(PIPELINES['deploy-sit'], detectCi({}), {})).toEqual({ environment: 'sit' });
  });
});

describe('CI stage detection', () => {
  const cases: Array<[string, Record<string, string>, Partial<ReturnType<typeof detectCi>>, string]> = [
    ['Azure deployment job', { TF_BUILD: 'True', SYSTEM_STAGENAME: 'TestSIT', SYSTEM_JOBNAME: 'eztest', ENVIRONMENT_NAME: 'sit', BUILD_BUILDID: '77', BUILD_BUILDNUMBER: '20261023.4', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/contoso/', SYSTEM_TEAMPROJECT: 'Shop', BUILD_REASON: 'IndividualCI' },
      { system: 'azure', stage: 'TestSIT', environment: 'sit', reason: 'deploy', buildNumber: '20261023.4', url: 'https://dev.azure.com/contoso/Shop/_build/results?buildId=77' }, 'deploy-sit'],
    ['Azure schedule', { TF_BUILD: 'True', BUILD_REASON: 'Schedule', SYSTEM_STAGENAME: 'Regression' }, { system: 'azure', reason: 'schedule' }, 'nightly'],
    ['Azure pull request', { TF_BUILD: 'True', BUILD_REASON: 'PullRequest', SYSTEM_STAGENAME: 'Smoke', SYSTEM_PULLREQUEST_PULLREQUESTID: '12' }, { reason: 'pr', pullRequest: '12' }, 'pr'],
    ['Azure classic release', { TF_BUILD: 'True', RELEASE_ENVIRONMENTNAME: 'uat', RELEASE_RELEASEID: '9', BUILD_REASON: 'Manual' }, { environment: 'uat', reason: 'deploy', releaseId: '9' }, 'deploy-uat'],
    ['GitHub pull request', { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_JOB: 'smoke', GITHUB_BASE_REF: 'main', GITHUB_REF: 'refs/pull/5/merge', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '3' },
      { system: 'github', reason: 'pr', baseBranch: 'main', pullRequest: '5', url: 'https://github.com/o/r/actions/runs/3' }, 'pr'],
    ['GitHub job named like the entry', { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'deploy-uat' }, { job: 'deploy-uat', reason: 'manual' }, 'deploy-uat'],
    ['GitLab environment', { GITLAB_CI: 'true', CI_JOB_STAGE: 'test-sit', CI_JOB_NAME: 'eztest:sit', CI_ENVIRONMENT_NAME: 'sit', CI_PIPELINE_SOURCE: 'push', CI_NODE_INDEX: '1', CI_NODE_TOTAL: '3' },
      { system: 'gitlab', environment: 'sit', reason: 'deploy', shard: { index: 1, total: 3 } }, 'deploy-sit'],
    ['GitLab schedule', { GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'schedule', CI_JOB_STAGE: 'test' }, { reason: 'schedule' }, 'nightly'],
    ['Jenkins stage', { JENKINS_URL: 'http://j/', STAGE_NAME: 'deploy-sit', BUILD_NUMBER: '41' }, { system: 'jenkins', stage: 'deploy-sit', buildNumber: '41' }, 'deploy-sit'],
    ['Jenkins change request', { JENKINS_URL: 'http://j/', STAGE_NAME: 'Smoke', CHANGE_ID: '8', CHANGE_TARGET: 'main' }, { reason: 'pr', baseBranch: 'main' }, 'pr'],
    ['TeamCity with EZTEST_DEPLOY_ENVIRONMENT', { TEAMCITY_VERSION: '2024.03', TEAMCITY_BUILDCONF_NAME: 'EZTest UAT (after deployment)', EZTEST_DEPLOY_ENVIRONMENT: 'uat' }, { system: 'teamcity', environment: 'uat', reason: 'deploy' }, 'deploy-uat'],
    ['Bitbucket deployment', { BITBUCKET_BUILD_NUMBER: '5', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'sit', BITBUCKET_PARALLEL_STEP: '0', BITBUCKET_PARALLEL_STEP_COUNT: '2' }, { system: 'bitbucket', environment: 'sit', shard: { index: 1, total: 2 } }, 'deploy-sit'],
    ['CircleCI pull request', { CIRCLECI: 'true', CIRCLE_JOB: 'smoke', CIRCLE_PULL_REQUEST: 'https://github.com/o/r/pull/7', CIRCLE_NODE_INDEX: '3', CIRCLE_NODE_TOTAL: '4' }, { system: 'circleci', reason: 'pr', pullRequest: '7', shard: { index: 4, total: 4 } }, 'pr'],
    ['explicit stage on any system', { CIRCLECI: 'true', CIRCLE_JOB: 'tests', EZTEST_STAGE: 'TestSIT' }, { stage: 'TestSIT' }, 'deploy-sit'],
  ];
  for (const [name, env, want, pipeline] of cases) {
    it(`${name} -> ${pipeline}`, () => {
      const ci = detectCi(env);
      expect(ci).toMatchObject(want);
      expect(resolvePipeline('auto', PIPELINES, ci, env).name).toBe(pipeline);
    });
  }

  it('explains when nothing matches, and honours EZTEST_PIPELINE and names', () => {
    expect(() => resolvePipeline('auto', PIPELINES, detectCi({}), {})).toThrow(/no pipeline matches this machine \(not in CI\)/);
    expect(resolvePipeline('auto', PIPELINES, detectCi({}), { EZTEST_PIPELINE: 'nightly' }).name).toBe('nightly');
    expect(resolvePipeline('Deploy_SIT', PIPELINES, detectCi({}), {}).name).toBe('deploy-sit');
    expect(() => resolvePipeline('prod', PIPELINES, detectCi({}), {})).toThrow(/No pipeline "prod" \(configured: pr, nightly, deploy-sit, deploy-uat\)/);
  });

  it('version: EZTEST_APP_VERSION, the build number, a tag, the commit', () => {
    expect(detectVersion(detectCi({ TF_BUILD: 'True', BUILD_BUILDNUMBER: '1.2.3' }), { EZTEST_APP_VERSION: '9.9' })).toBe('9.9');
    expect(detectVersion(detectCi({ TF_BUILD: 'True', BUILD_BUILDNUMBER: '1.2.3' }), {})).toBe('1.2.3');
    expect(detectVersion(detectCi({ GITLAB_CI: 'true', CI_COMMIT_SHA: 'abcdef0123456789' }), { CI_COMMIT_TAG: 'v2' })).toBe('v2');
  });
});

describe('pipelines CLI', () => {
  async function project(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ez-pipelines-'));
    await mkdir(join(dir, 'journeys'));
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ pipelines: { pr: { tags: '@smoke', trigger: 'pr' }, 'deploy-sit': { environment: 'sit', tags: '@sit or @smoke', testPlan: 417 }, empty: { tags: '@nothing' } } }));
    await writeFile(join(dir, 'journeys', 'login.ez'), 'Journey: Login\nId: login\nTags: @smoke\n\nOpen /\n');
    await writeFile(join(dir, 'journeys', 'orders.ez'), 'Journey: Orders\nId: orders\nTags: @sit\n\nOpen /orders\n');
    await writeFile(join(dir, 'journeys', 'old.ez'), 'Journey: Old\nId: old\n\nOpen /old\n');
    await writeFile(join(dir, 'journeys', 'seed.ez'), 'Setup: Seed\nId: seed\n\nOpen /seed\n');
    return dir;
  }
  async function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const before = process.exitCode;
    process.exitCode = 0;
    await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = before;
    return { out: out.join('\n'), err: err.join('\n'), exitCode };
  }

  it('explain lists what would run, and why', async () => {
    const dir = await project();
    const r = await cli(dir, ['pipelines', 'explain', 'deploy-sit']);
    expect(r.out).toMatch(/^deploy-sit: environment sit · tags @sit or @smoke · test plan 417 · gate readiness/);
    expect(r.out).toMatch(/would run 2 journey\(s\) \(\+1 setup\/teardown\); 1 not selected/);
    expect(r.out).toMatch(/\+ login: tags match @sit or @smoke \(has @smoke; lacks @sit\)/);
    expect(r.out).toMatch(/\+ orders: tags match/);
    expect(r.out).toMatch(/- old: tags do not match @sit or @smoke \(lacks @sit, @smoke\)/);
    expect(r.out).toMatch(/~ seed: Setup: journey/);
    const auto = await cli(dir, ['pipelines', 'explain', 'auto', '--json'], { GITLAB_CI: 'true', CI_ENVIRONMENT_NAME: 'sit' });
    const j = JSON.parse(auto.out);
    expect(j).toMatchObject({ name: 'deploy-sit', how: 'gitlab deployment environment "sit"', settings: { environment: 'sit' } });
    expect(j.decisions.filter((d: { selected: boolean }) => d.selected).map((d: { journeyId: string }) => d.journeyId)).toEqual(['login', 'orders', 'seed']);
  });

  it('list and tags report', async () => {
    const dir = await project();
    const l = await cli(dir, ['pipelines', 'list']);
    expect(l.out.split('\n')).toEqual(expect.arrayContaining([expect.stringMatching(/^1\s+pr: trigger pr · tags @smoke/), expect.stringMatching(/^2\s+deploy-sit:/), expect.stringMatching(/^0\s+empty:/)]));
    const t = await cli(dir, ['tags', 'report', '--strict']);
    expect(t.out).toMatch(/untagged \(1\): old/);
    expect(t.out).toMatch(/in no pipeline \(1\): old/);
    expect(t.out).toMatch(/pipelines that select nothing: empty/);
    expect(t.exitCode).toBe(1);
    const json = JSON.parse((await cli(dir, ['tags', 'report', '--json'])).out);
    expect(json.journeys.find((x: { id: string }) => x.id === 'login').pipelines).toEqual(['pr', 'deploy-sit']);
  });
});
