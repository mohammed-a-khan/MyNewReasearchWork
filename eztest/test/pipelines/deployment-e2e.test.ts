/**
 * The deployment record end to end: `eztest run --pipeline auto` inside a
 * (simulated) Azure Pipelines deployment job picks deploy-sit from the
 * environment, runs its journeys against the SIT config, keeps the
 * deployment test record on the results server, updates the test plan, tags
 * the build, comments on and links the build's work items in the Azure
 * DevOps mock, and uploads the build summary; deploy-uat then checks that
 * SIT passed for the same version (requires:), and NO_GO fails the run.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { buildProgram } from '../../src/cli/program.js';
import { ResultsClient } from '../../src/server/index.js';
import { startMockAdoServer, type MockAdoServer } from '../alm-ado/mock-ado-server.js';
import { startTestServer, type TestServer } from '../server/helpers.js';

let ado: MockAdoServer;
let srv: TestServer;
let token: string;
let dir: string;
let planId: number;
let suiteId: number;
let tcLogin: number;
let story: number;

async function cli(args: string[], env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

const azure = (o: Record<string, string>) => ({
  TF_BUILD: 'True', BUILD_REASON: 'IndividualCI', SYSTEM_COLLECTIONURI: ado.collectionUrl + '/', SYSTEM_TEAMPROJECT: 'proj',
  BUILD_SOURCEVERSION: '0123456789abcdef0123', BUILD_SOURCEBRANCH: 'refs/heads/main', EZTEST_SERVER_TOKEN: token, ADO_PAT: ado.pat, ...o,
});

beforeAll(async () => {
  ado = await startMockAdoServer();
  srv = await startTestServer();
  token = await srv.token('ci', [{ project: 'shop', role: 'tester' }]);
  tcLogin = ado.workItem('Test Case', { 'System.Title': 'Login' }).id;
  story = ado.workItem('User Story', { 'System.Title': 'Sign in' }).id;
  ado.configuration('Chrome', [], true);
  const p = ado.plan('SIT plan');
  planId = p.planId;
  suiteId = ado.suite(planId, p.rootSuiteId, 'SIT', [tcLogin]);
  dir = await mkdtemp(join(tmpdir(), 'ez-deploy-'));
  await mkdir(join(dir, 'journeys'));
  await mkdir(join(dir, 'config'));
  await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
    outputDir: 'results', healing: { enabled: false }, project: 'shop', reporters: ['html', 'json', 'junit'],
    readiness: { policyPath: 'readiness-policy.yaml' },
    server: { url: srv.url, token: '${EZTEST_SERVER_TOKEN}', project: 'shop', sharedState: false },
    ado: { organizationUrl: ado.collectionUrl, project: 'proj', pat: '${ADO_PAT}' },
    pipelines: {
      'deploy-sit': { environment: 'sit', tags: '@sit or @smoke', testPlan: planId, testSuite: suiteId, gate: 'readiness', ado: { commentWorkItems: true, linkWorkItems: true } },
      'deploy-uat': { environment: 'uat', tags: '@uat', requires: ['deploy-sit'], gate: 'readiness' },
    },
  }));
  await writeFile(join(dir, 'config', 'sit.yaml'), toYaml({ vars: { greeting: 'hello sit' } }));
  await writeFile(join(dir, 'config', 'uat.yaml'), toYaml({ vars: { greeting: 'hello uat' } }));
  await writeFile(join(dir, 'readiness-policy.yaml'), toYaml({ version: 1, gates: { minPassRate: { min: 1 } } }));
  await writeFile(join(dir, 'journeys', 'login.ez'), `Journey: Login\nId: login\nTags: @smoke @TestCaseId:${tcLogin}\n\nExpect the expression "greeting == 'hello sit'" is true\n`);
  await writeFile(join(dir, 'journeys', 'uat.ez'), 'Journey: UAT check\nId: uat-check\nTags: @uat\n\nExpect the expression "greeting == \'hello uat\'" is true\n');
  await writeFile(join(dir, 'journeys', 'other.ez'), 'Journey: Not in SIT\nId: other\nTags: @regression\n\nExpect the expression "1 == 2" is true\n');
}, 60_000);

afterAll(async () => {
  await ado?.close();
  await srv?.close();
});

describe('deployment test records', () => {
  it('deploy-sit in an Azure deployment job: record, test plan, build tags, summary and work items', async () => {
    ado.state.buildWorkItems.set(77, [story]);
    const r = await cli(['run', '--pipeline', 'auto'], azure({ SYSTEM_STAGENAME: 'TestSIT', ENVIRONMENT_NAME: 'sit', BUILD_BUILDID: '77', BUILD_BUILDNUMBER: '2026.10.23.1' }));
    expect(r.err).not.toMatch(/warning: (deployment|test plan|Azure)/);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/pipeline: deploy-sit \(azure deployment environment "sit"\), environment sit, tags @sit or @smoke, version 2026\.10\.23\.1/);
    expect(r.out).toMatch(/pipeline deploy-sit: 1 of 3 journeys by @sit or @smoke/);
    expect(r.out).toMatch(/readiness: GO/);
    expect(r.out).toMatch(/test plan \d+: 1 result\(s\) in test run \d+/);
    expect(r.out).toMatch(/##vso\[task\.uploadsummary\].*eztest-deployment\.md/);
    // The results server keeps the record.
    const client = new ResultsClient({ url: srv.url, token, project: 'shop' });
    const [rec] = await client.deployments({ environment: 'sit' });
    expect(rec).toMatchObject({
      environment: 'sit', version: '2026.10.23.1', pipeline: 'deploy-sit', app: 'shop',
      ci: { system: 'azure', stage: 'TestSIT', buildId: '77', commit: '0123456789abcdef0123', url: `${ado.collectionUrl}/proj/_build/results?buildId=77` },
      selection: { journeys: ['login'], total: 1, tags: '@sit or @smoke' },
      results: { total: 1, passed: 1, failed: 0 },
      readiness: { decision: 'GO' },
      testPlan: { planId, suiteId, results: 1 },
    });
    expect(rec.evidence?.testRunUrl).toMatch(/_testManagement\/runs\?runId=\d+/);
    expect(rec.recordedBy).toMatch(/^token:/);
    // Azure DevOps: test run with the result, build tags, a comment and a link on the build's work item.
    expect(ado.state.runs.some((x) => x.name === 'EZTest deploy-sit sit 2026.10.23.1')).toBe(true);
    expect(ado.state.buildTags.get(77)).toEqual(['eztest-sit', 'eztest-sit-GO']);
    const wi = ado.state.workItems.get(story)!;
    expect(wi.comments[0].text).toMatch(/EZTest sit 2026\.10\.23\.1: GO.*1 journeys: 1 passed/);
    expect(wi.relations.some((x) => x.rel === 'Hyperlink' && /buildId=77/.test(x.url))).toBe(true);
    // The run directory has the record and the summary.
    const runDir = /deployment record: sit 2026\.10\.23\.1 \((.*deployment\.json)\)/.exec(r.out)![1];
    expect(existsSync(runDir)).toBe(true);
    expect(await readFile(runDir.replace('deployment.json', 'eztest-deployment.md'), 'utf8')).toMatch(/## EZTest: sit 2026\.10\.23\.1: GO/);
    // `eztest deployments list` reads them back.
    const l = await cli(['deployments', 'list'], { EZTEST_SERVER_TOKEN: token, ADO_PAT: ado.pat });
    expect(l.out).toMatch(/sit\s+2026\.10\.23\.1\s+deploy-sit\s+GO\s+1\/1 passed/);
  }, 180_000);

  it('deploy-uat requires SIT to have passed for the same version', async () => {
    const blocked = await cli(['run', '--pipeline', 'deploy-uat'], azure({ BUILD_BUILDID: '78', BUILD_BUILDNUMBER: '2026.10.23.2' }));
    expect(blocked.exitCode).toBe(1);
    expect(blocked.err).toMatch(/requires deploy-sit to have passed for version 2026\.10\.23\.2:\n\s+"deploy-sit" has no deployment test record for version 2026\.10\.23\.2/);
    const ok = await cli(['run', '--pipeline', 'deploy-uat'], azure({ BUILD_BUILDID: '79', BUILD_BUILDNUMBER: '2026.10.23.1' }));
    expect(ok.out).toMatch(/requires: deploy-sit passed for version 2026\.10\.23\.1/);
    expect(ok.exitCode).toBe(0);
    const recs = await new ResultsClient({ url: srv.url, token, project: 'shop' }).deployments({ version: '2026.10.23.1' });
    expect(recs.map((x) => x.environment).sort()).toEqual(['sit', 'uat']);
  }, 180_000);

  it('NO_GO fails the pipeline run', async () => {
    await writeFile(join(dir, 'journeys', 'login.ez'), `Journey: Login\nId: login\nTags: @smoke @TestCaseId:${tcLogin}\n\nExpect the expression "greeting == 'something else'" is true\n`);
    const r = await cli(['run', '--pipeline', 'deploy-sit'], azure({ BUILD_BUILDID: '80', BUILD_BUILDNUMBER: '2026.10.23.3' }));
    expect(r.out).toMatch(/readiness: NO_GO/);
    expect(r.err).toMatch(/readiness gate: NO_GO for sit 2026\.10\.23\.3/);
    expect(r.exitCode).toBe(1);
    const [rec] = await new ResultsClient({ url: srv.url, token, project: 'shop' }).deployments({ version: '2026.10.23.3' });
    expect(rec.readiness?.decision).toBe('NO_GO');
    expect(ado.state.buildTags.get(80)).toEqual(['eztest-sit', 'eztest-sit-NO_GO']);
  }, 180_000);
});
