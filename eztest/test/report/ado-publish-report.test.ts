/**
 * `eztest run` with ado.publishResults against EZTest's mock Azure DevOps:
 * the run is published (results, a bug for the failure), the publish result
 * and the links (test run, results, test cases, bug, build) land in
 * integrations.json and in the re-rendered report, that report is attached to
 * the ADO test run, and the Teams publisher posts the rich card linking it.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import { buildStepsXml } from '../../src/alm-ado/index.js';
import { startMockAdoServer } from '../alm-ado/mock-ado-server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function cli(cwd: string, args: string[], env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
  const s: Server = createServer(handler);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((c) => s.close(() => c())) })));
}

describe('eztest run with ado.publishResults', () => {
  it('publishes to Azure Test Plans and writes the ADO links into the report, which is attached to the test run', async () => {
    const ado = await startMockAdoServer();
    closers.push(ado.close);
    const app = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Shop</title><h1>Products</h1><p>3 products</p>');
    });
    closers.push(app.close);
    const posts: unknown[] = [];
    const hook = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(202);
      res.end();
    });
    closers.push(hook.close);

    const cfgId = ado.configuration('Chrome', [], true);
    const tcOk = ado.workItem('Test Case', { 'System.Title': 'Browse the catalogue', 'Microsoft.VSTS.TCM.Steps': buildStepsXml([{ action: 'Open /', expected: 'the page contains "Products"' }]) });
    const tcBad = ado.workItem('Test Case', { 'System.Title': 'Find the basket', 'Microsoft.VSTS.TCM.Steps': buildStepsXml([{ action: 'Open /', expected: 'the page contains "Basket"' }]) });
    const { planId, rootSuiteId } = ado.plan('Release 7');
    const suiteId = ado.suite(planId, rootSuiteId, 'Regression', [tcOk.id, tcBad.id], [cfgId]);

    const dir = await mkdtemp(join(tmpdir(), 'eztest-ado-report-'));
    await mkdir(join(dir, 'journeys'), { recursive: true });
    await writeFile(join(dir, 'journeys', 'browse.ez'), `Journey: Browse the catalogue\nId: browse\nTags: @TestCaseId:${tcOk.id}\nOpen "/"\n  Expect the page to contain "Products"\n`);
    await writeFile(join(dir, 'journeys', 'basket.ez'), `Journey: Find the basket\nId: basket\nTags: @TestCaseId:${tcBad.id}\nOpen "/"\n  Expect the page to contain "Basket" [timeout=800ms]\n`);
    await writeFile(join(dir, 'eztest.config.yaml'), [
      `baseUrl: ${app.url}`,
      'reporters: [console, html, json]',
      'screenshots: on-failure',
      'report:',
      '  name: Contoso Shop',
      'ado:',
      '  enabled: true',
      `  organizationUrl: ${ado.collectionUrl}`,
      '  project: proj',
      '  pat: secret://env/ADO_PAT',
      `  testPlanId: ${planId}`,
      `  testSuiteId: ${suiteId}`,
      '  publishResults: true',
      '  createBugs: true',
      'publishers:',
      '  - use: teams',
      `    webhook: ${hook.url}/teams`,
      '',
    ].join('\n'));
    const env = { ADO_PAT: ado.pat, BUILD_BUILDID: '4242', BUILD_BUILDNUMBER: '20261023.1', SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: `${ado.collectionUrl}/`, SYSTEM_TEAMPROJECT: 'proj', TF_BUILD: 'True' };
    const saved = process.env.ADO_PAT;
    process.env.ADO_PAT = ado.pat;
    let r;
    try {
      r = await cli(dir, ['run'], env);
    } finally {
      if (saved === undefined) delete process.env.ADO_PAT;
      else process.env.ADO_PAT = saved;
    }
    expect(r.out, r.err).toMatch(/azure devops: test run \d+ \(2 result\(s\), 1 bug\(s\), report attached\)/);
    const runs = (await readdir(join(dir, 'eztest-results'))).filter((n) => !n.startsWith('.'));
    const runDir = join(dir, 'eztest-results', runs[0]);
    const adoRun = ado.state.runs[0];
    expect(adoRun.state).toBe('Completed');

    // integrations.json: what was published, and why it is partial or not
    const integ = JSON.parse(await readFile(join(runDir, 'integrations.json'), 'utf8'));
    expect(integ.ado.publish).toMatchObject({ status: 'success', runId: adoRun.id, planId, suiteId });
    expect(integ.ado.publish.runUrl).toBe(`${ado.collectionUrl}/proj/_testManagement/runs?_a=runCharts&runId=${adoRun.id}`);
    expect(integ.ado.publish.results.map((x: { testCaseId: number; outcome: string }) => [x.testCaseId, x.outcome]).sort()).toEqual([[tcBad.id, 'Failed'], [tcOk.id, 'Passed']].sort());
    expect(integ.ado.bugs).toEqual([expect.objectContaining({ journeyId: 'basket', action: 'created', url: expect.stringMatching(/\/proj\/_workitems\/edit\/\d+$/) })]);
    expect(integ.ado.build).toMatchObject({ id: '4242', number: '20261023.1', url: `${ado.collectionUrl}/proj/_build/results?buildId=4242` });
    expect(integ.notifications).toEqual([expect.objectContaining({ channel: 'teams', ok: true })]);

    // the report carries the links (static sections and the embedded model)
    const html = await readFile(join(runDir, 'report.html'), 'utf8');
    expect(html).toContain(`href="${ado.collectionUrl}/proj/_testManagement/runs?_a=runCharts&amp;runId=${adoRun.id}"`);
    expect(html).toContain(`${ado.collectionUrl}/proj/_workitems/edit/${tcOk.id}`);
    expect(html).toContain('_build/results?buildId=4242');
    expect(html).toMatch(/Azure DevOps <span class="badge status b-passed">success<\/span>/);
    const model = JSON.parse(await readFile(join(runDir, 'report-model.json'), 'utf8'));
    const basket = model.tests.find((t: { id: string }) => t.id === 'basket');
    expect(basket.ado.testCases[0]).toEqual({ id: tcBad.id, url: `${ado.collectionUrl}/proj/_workitems/edit/${tcBad.id}` });
    expect(basket.ado.results[0]).toMatchObject({ testCaseId: tcBad.id, outcome: 'Failed', url: expect.stringContaining(`runId=${adoRun.id}&resultId=`) });
    expect(basket.bugs[0]).toMatchObject({ system: 'ado', action: 'created' });
    const json = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
    expect(json.version).toBe(2);
    expect(json.model.integrations.ado.publish.status).toBe('success');

    // the re-rendered report (with its links) is attached to the ADO test run
    const att = ado.state.attachments.get(`${adoRun.id}:`) ?? ado.state.attachments.get(String(adoRun.id)) ?? [...ado.state.attachments.entries()].find(([k]) => k.startsWith(`${adoRun.id}`) && !k.includes('/'))?.[1] ?? [];
    expect(att.map((a) => a.fileName)).toEqual(expect.arrayContaining(['report.html', 'summary.html', 'report.json']));

    // the Teams card links the report's ADO run and the build, and lists the failure
    const card = (posts[0] as { attachments: Array<{ content: Record<string, unknown> }> }).attachments[0].content as { version: string; body: Array<Record<string, unknown>>; actions: Array<{ title: string; url: string }> };
    expect(card.version).toBe('1.5');
    expect(card.actions.map((a) => a.title)).toEqual(expect.arrayContaining(['Azure DevOps test run', 'Build']));
    expect(JSON.stringify(card.body)).toContain('Find the basket');
    expect(JSON.stringify(card.body)).toContain('NO GO');
  }, 180_000);

  it('records a failed publish (and why) in the report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-ado-fail-'));
    const runDir = join(dir, 'eztest-results', 'run-1');
    await mkdir(runDir, { recursive: true });
    const { writeReports } = await import('../../src/report/index.js');
    const { makeRunFixture } = await import('../insights/fixtures.js');
    const fx = await makeRunFixture();
    await writeFile(join(runDir, 'run.json'), JSON.stringify(fx.run));
    await writeReports(runDir, fx.run, { formats: ['html', 'json'] });
    const ado = await startMockAdoServer();
    closers.push(ado.close);
    await writeFile(join(dir, 'eztest.config.yaml'), `ado:\n  organizationUrl: ${ado.collectionUrl}\n  project: proj\n  pat: secret://env/ADO_PAT\n`);
    const r = await cli(dir, ['ado', 'publish', 'eztest-results/run-1'], { ADO_PAT: ado.pat }).catch((e: Error) => ({ out: '', err: e.message, exitCode: 1 }));
    expect(r.exitCode).not.toBe(0);
    const integ = JSON.parse(await readFile(join(runDir, 'integrations.json'), 'utf8'));
    expect(integ.ado.publish.status).toBe('failed');
    expect(integ.ado.publish.reason).toMatch(/plan\/suite|test case|TestCaseId|no journey/i);
    const html = await readFile(join(runDir, 'report.html'), 'utf8');
    expect(html).toMatch(/Azure DevOps <span class="badge status b-failed">failed<\/span>/);
  }, 60_000);
});
