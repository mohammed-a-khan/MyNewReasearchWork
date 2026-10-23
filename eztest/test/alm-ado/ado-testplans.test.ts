/**
 * Azure Test Plans end to end against the mock: import manual test cases into
 * .ez (steps, expected results, shared steps, parameters), create and update
 * test cases from journeys (associated automation, @TestCaseId write-back),
 * suites by tag and query, configurations, and publishing with step results,
 * iterations, attachments, heals, build links, flaky marking, bugs linked to
 * test cases and requirements, and requirement comments.
 */
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdoClient,
  addTestCaseTag,
  buildStepsXml,
  commentOnRequirements,
  ensureConfiguration,
  ensureQuerySuite,
  importTestCases,
  parseStepsXml,
  publishRun,
  queryRequirements,
  requirementsWiql,
  resolveConfiguration,
  syncJourneys,
  syncSuiteByTag,
  testCaseWiql,
} from '../../src/alm-ado/index.js';
import { EvidenceVault, summarize, type JourneyResult, type RunResult, type StepResult } from '../../src/core/index.js';
import { writeImported } from '../../src/importers/index.js';
import { loadJourneyFile, parseEzScript } from '../../src/intent/index.js';
import { solidPng } from '../insights/fixtures.js';
import { startMockAdoServer, type MockAdoServer } from './mock-ado-server.js';

let ado: MockAdoServer;
let c: AdoClient;
beforeEach(async () => {
  ado = await startMockAdoServer();
  c = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: ado.pat }, sleep: async () => undefined });
});
afterEach(async () => ado.close());

const steps = (xs: Array<[string, string?]>) => buildStepsXml(xs.map(([action, expected]) => ({ action, expected })));

describe('import manual test cases', () => {
  async function seed() {
    const story = ado.workItem('User Story', { 'System.Title': 'Customers can search the catalogue', 'System.AreaPath': 'Shop\\Catalogue' });
    const login = ado.workItem('Shared Steps', { 'System.Title': 'Log in', 'Microsoft.VSTS.TCM.Steps': steps([['Open /login'], ['Click the "Sign in" button', 'Verify the URL contains "/dashboard"']]) });
    const terms = ado.workItem('Shared Parameter', {
      'System.Title': 'Search terms',
      'Microsoft.VSTS.TCM.Parameters': '<parameterSet><paramNames><param>searchTerm</param></paramNames><paramData lastId="2"><dataRow id="1"><kvp key="searchTerm" value="laptop"/></dataRow><dataRow id="2"><kvp key="searchTerm" value="desk &amp; chair"/></dataRow></paramData></parameterSet>',
    });
    // Steps as ADO stores them: HTML inside XML, a shared steps reference, a parameter, an unknown domain step.
    const searchXml = `<steps id="0" last="5"><compref id="2" ref="${login.id}" /><step id="3" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Type "@term" into the Search field&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;Verify the page contains "results"&lt;/P&gt;</parameterizedString><description/></step><step id="4" type="ActionStep"><parameterizedString isformatted="true">&lt;P&gt;Reticulate the splines&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true"></parameterizedString><description/></step></steps>`;
    const search = ado.workItem(
      'Test Case',
      {
        'System.Title': 'Search the catalogue',
        'System.Tags': 'smoke; catalogue',
        'Microsoft.VSTS.Common.Priority': 1,
        'Microsoft.VSTS.TCM.Steps': searchXml,
        'Microsoft.VSTS.TCM.Parameters': '<parameters><param name="term" bind="default"/></parameters>',
        'Microsoft.VSTS.TCM.LocalDataSource': JSON.stringify({ parameterMap: [{ localParamName: 'term', sharedParameterName: 'searchTerm', sharedParameterDataSetId: terms.id }], sharedParameterDataSetIds: [terms.id], rowMappingType: 0 }),
      },
      [{ rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${ado.collectionUrl}/_apis/wit/workItems/${story.id}` }],
    );
    const cart = ado.workItem('Test Case', {
      'System.Title': 'Change the quantity in the cart',
      'Microsoft.VSTS.TCM.Steps': steps([['Open /cart'], ['Fill the Quantity field with @qty', 'the Quantity field has value "@qty"']]),
      'Microsoft.VSTS.TCM.Parameters': '<parameters><param name="qty" bind="default"/></parameters>',
      'Microsoft.VSTS.TCM.LocalDataSource': '<NewDataSet><xs:schema id="NewDataSet"/><Table1><qty>1</qty></Table1><Table1><qty>2</qty></Table1></NewDataSet>',
    });
    const cfg = ado.configuration('Windows 10 + Chrome', [], true);
    const { planId, rootSuiteId } = ado.plan('Shop regression');
    const regression = ado.suite(planId, rootSuiteId, 'Regression', [search.id], [cfg]);
    const nested = ado.suite(planId, regression, 'Cart', [cart.id], [cfg]);
    return { story, login, terms, search, cart, planId, regression, nested };
  }

  it('imports a suite (and its child suites) with shared steps, parameters, requirements and TODOs linked back', async () => {
    const s = await seed();
    const report = await importTestCases({ client: c, source: { planId: s.planId, suiteId: s.regression } });
    expect(report.converted.map((x) => x.name)).toEqual(['Search the catalogue', 'Change the quantity in the cart']);
    const search = report.converted[0].ez;
    expect(search).toContain(`Tags: @TestCaseId:${s.search.id} @TestPlanId:${s.planId} @TestSuiteId:${s.regression} @smoke @catalogue`);
    expect(search).toContain(`Requirements: ${s.story.id}`);
    expect(search).toContain('Risk: 5');
    expect(search).toContain(`# Shared steps #${s.login.id}: Log in`);
    expect(search).toMatch(/^Open \/login/m);
    expect(search).toMatch(/^Click the "Sign in" button.*\n  Expect the URL contains "\/dashboard"/m);
    expect(search).toMatch(/^Type "<term>" into the Search field.*\n  Expect the page contains "results"/m);
    expect(search).toContain(`# TODO (not converted): Reticulate the splines (test case #${s.search.id} step 3: ${ado.collectionUrl}/proj/_workitems/edit/${s.search.id})`);
    expect(search).toMatch(/Examples:\n {2}\| term \|\n {2}\| laptop \|\n {2}\| desk & chair \|/);
    const j = parseEzScript(search, { source: 'search.ez' });
    expect(j.examples).toEqual([{ term: 'laptop' }, { term: 'desk & chair' }]);
    expect(j.tags).toContain(`TestSuiteId:${s.regression}`);
    expect(report.todo).toHaveLength(1);
    expect(report.todo[0].file).toBe(`${ado.collectionUrl}/proj/_workitems/edit/${s.search.id}`);

    const cart = report.converted[1];
    expect(cart.ez).toContain(`@TestSuiteId:${s.nested}`);
    expect(cart.journey?.examples).toEqual([{ qty: '1' }, { qty: '2' }]);
    expect(cart.ez).toMatch(/Fill the Quantity field with <qty>.*\n {2}Expect the Quantity field has value "<qty>"/);

    // written as files that load like any other journey
    const out = await mkdtemp(join(tmpdir(), 'eztest-adoimp-'));
    const w = await writeImported(report, out);
    expect(w.ezFiles).toHaveLength(2);
    expect((await loadJourneyFile(w.ezFiles[0])).name).toBe('Search the catalogue');
  });

  it('imports from a WIQL query, a saved query path and explicit ids', async () => {
    const s = await seed();
    const byTag = await importTestCases({ client: c, source: { wiql: testCaseWiql({ tag: 'smoke' }) } });
    expect(byTag.converted.map((x) => x.name)).toEqual(['Search the catalogue']);
    expect(byTag.converted[0].ez).not.toContain('@TestPlanId');
    ado.state.savedQueries.set('Shared Queries/Cart', { id: '11111111-2222-3333-4444-555555555555', path: 'Shared Queries/Cart', wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND [System.Tags] CONTAINS 'nothing'" });
    expect((await importTestCases({ client: c, source: { savedQuery: 'Shared Queries/Cart' } })).converted).toEqual([]);
    const ids = await importTestCases({ client: c, source: { ids: [s.cart.id, s.story.id] } });
    expect(ids.converted.map((x) => x.name)).toEqual(['Change the quantity in the cart']);
    expect(ids.warnings.join('\n')).toMatch(/is a User Story, not a Test Case/);
  });
});

describe('journeys to test cases', () => {
  async function project() {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-adosync-'));
    await mkdir(join(dir, 'journeys'), { recursive: true });
    return dir;
  }

  it('creates test cases with ADO steps, parameters and associated automation, writes @TestCaseId back, then updates in place', async () => {
    const story = ado.workItem('User Story', { 'System.Title': 'Search' });
    const cfg = ado.configuration('Chrome', [], true);
    const { planId, rootSuiteId } = ado.plan('P');
    const suite = ado.suite(planId, rootSuiteId, 'Automated');
    const dir = await project();
    const file = join(dir, 'journeys', 'search.ez');
    const text = `Journey: Search for products\nTags: @smoke\nRequirements: ${story.id}\nRisk: 4\n\nOpen /search\nType "<term>" into the Search field\n  Expect the page contains "results"\nClick the "Go" button\n  Expect the URL contains "q="\n\nExamples:\n  | term |\n  | laptop |\n  | desk |\n`;
    await writeFile(file, text);
    await writeFile(join(dir, 'journeys', 'lib.ez'), 'Journey: Shared login\nTags: @library\nOpen /login\n');
    const files = [{ path: file, rel: 'journeys/search.ez' }, { path: join(dir, 'journeys', 'lib.ez'), rel: 'journeys/lib.ez' }];

    const dry = await syncJourneys({ client: c, files, planId, suiteId: suite, dryRun: true });
    expect(dry.items).toEqual([expect.objectContaining({ action: 'would-create', file: 'journeys/search.ez' })]);
    expect(dry.items[0].change!.unified).toContain('+Tags: @smoke @TestCaseId:<new id>');
    expect(dry.warnings.join('\n')).toMatch(/@library journeys are not test cases/);
    expect(ado.state.workItems.size).toBe(1);

    const r = await syncJourneys({ client: c, files, planId, suiteId: suite, configurationIds: [cfg], writeBack: true, areaPath: 'Shop\\Search', paths: [{ tag: 'smoke', iterationPath: 'Shop\\Sprint 1' }] });
    const item = r.items[0];
    expect(item.action).toBe('created');
    const tc = ado.state.workItems.get(item.testCaseId!)!;
    expect(await readFile(file, 'utf8')).toContain(`Tags: @smoke @TestCaseId:${tc.id}`);
    expect(tc.fields).toMatchObject({
      'System.WorkItemType': 'Test Case',
      'System.Title': 'Search for products',
      'System.Tags': 'eztest; smoke',
      'System.AreaPath': 'Shop\\Search',
      'System.IterationPath': 'Shop\\Sprint 1',
      'Microsoft.VSTS.TCM.AutomatedTestName': 'eztest.search-for-products',
      'Microsoft.VSTS.TCM.AutomatedTestStorage': 'journeys/search.ez',
      'Microsoft.VSTS.TCM.AutomatedTestType': 'EZTest',
      'Microsoft.VSTS.TCM.AutomationStatus': 'Automated',
      'Microsoft.VSTS.Common.Priority': '2',
    });
    expect(String(tc.fields['Microsoft.VSTS.TCM.AutomatedTestId'])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseStepsXml(String(tc.fields['Microsoft.VSTS.TCM.Steps']))).toEqual([
      { id: 2, kind: 'step', action: 'Open /search', expected: '', type: 'ActionStep' },
      { id: 3, kind: 'step', action: 'Type "@term" into the Search field', expected: 'page contains "results"', type: 'ValidateStep' },
      { id: 4, kind: 'step', action: 'Click the "Go" button', expected: 'URL contains "q="', type: 'ValidateStep' },
    ]);
    expect(tc.fields['Microsoft.VSTS.TCM.Parameters']).toBe('<parameters><param name="term" bind="default" /></parameters>');
    expect(String(tc.fields['Microsoft.VSTS.TCM.LocalDataSource'])).toContain('<Table1><term>laptop</term></Table1><Table1><term>desk</term></Table1>');
    expect(tc.relations).toEqual([expect.objectContaining({ rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${ado.collectionUrl}/_apis/wit/workItems/${story.id}` })]);
    expect(ado.state.suites.find((x) => x.id === suite)!.testCases).toEqual([tc.id]);
    expect(ado.state.points.filter((p) => p.suiteId === suite).map((p) => p.configuration.id)).toEqual([cfg]);

    // Again: nothing changed.
    const again = await syncJourneys({ client: c, files: files.slice(0, 1), planId, suiteId: suite });
    expect(again.items[0]).toMatchObject({ action: 'unchanged', testCaseId: tc.id });
    // Edit a step: the test case is updated in place (same id, steps changed, revision bumped).
    const rev = tc.rev;
    await writeFile(file, (await readFile(file, 'utf8')).replace('Click the "Go" button', 'Click the "Search" button'));
    const upd = await syncJourneys({ client: c, files: files.slice(0, 1) });
    expect(upd.items[0]).toMatchObject({ action: 'updated', testCaseId: tc.id, changedFields: ['Microsoft.VSTS.TCM.Steps'] });
    expect(String(ado.state.workItems.get(tc.id)!.fields['Microsoft.VSTS.TCM.Steps'])).toContain('Click the &amp;quot;Search&amp;quot; button');
    expect(ado.state.workItems.get(tc.id)!.rev).toBe(rev + 1);
  });

  it('writes the tag into YAML and JSON journeys and .ez files without a Tags header', () => {
    expect(addTestCaseTag('a.ez', 'Journey: A\nId: a\n\nOpen /\n', 7)).toBe('Journey: A\nId: a\nTags: @TestCaseId:7\n\nOpen /\n');
    expect(addTestCaseTag('a.yaml', 'name: A # keep\ntags: [smoke]\nsteps:\n  - Open /\n', 7)).toBe('name: A # keep\ntags: [ smoke, TestCaseId:7 ]\nsteps:\n  - Open /\n');
    expect(JSON.parse(addTestCaseTag('a.json', '{"name":"A","steps":["Open /"]}', 7)).tags).toEqual(['TestCaseId:7']);
    expect(addTestCaseTag('a.ez', 'Journey: A\nTags: @TestCaseId:7\n', 7)).toBe('Journey: A\nTags: @TestCaseId:7\n');
    expect(addTestCaseTag('a.ez', 'Journey: A\nTags: @smoke   # fast ones\n', 9)).toBe('Journey: A\nTags: @smoke @TestCaseId:9   # fast ones\n');
  });

  it('builds suites by tag (pruned) and by query, and maps browsers to configurations', async () => {
    const { planId, rootSuiteId } = ado.plan('P');
    const a = ado.workItem('Test Case', { 'System.Title': 'A', 'System.Tags': 'smoke' }).id;
    const b = ado.workItem('Test Case', { 'System.Title': 'B' }).id;
    const r1 = await syncSuiteByTag(c, { planId, tag: '@smoke', journeys: [{ tags: ['smoke'], testCaseIds: [a] }, { tags: ['smoke'], testCaseIds: [b] }] });
    expect(r1).toMatchObject({ created: true, added: [a, b], removed: [] });
    expect(ado.state.suites.find((s) => s.id === r1.suiteId)).toMatchObject({ name: '@smoke', parentSuite: { id: rootSuiteId } });
    const r2 = await syncSuiteByTag(c, { planId, tag: 'smoke', journeys: [{ tags: ['smoke'], testCaseIds: [a] }, { tags: [], testCaseIds: [b] }], prune: true });
    expect(r2).toMatchObject({ suiteId: r1.suiteId, created: false, added: [], removed: [b] });

    const wiql = testCaseWiql({ tag: 'smoke' });
    expect((await ensureQuerySuite(c, planId, 'Smoke (query)', wiql)).action).toBe('created');
    expect((await ensureQuerySuite(c, planId, 'Smoke (query)', wiql)).action).toBe('unchanged');
    const q = await ensureQuerySuite(c, planId, 'Smoke (query)', testCaseWiql({ tag: 'smoke', state: 'Ready' }));
    expect(q.action).toBe('updated');

    const ff = await ensureConfiguration(c, 'Firefox on Linux', { Browser: 'Firefox', 'Operating System': 'Linux' });
    expect(ff.created).toBe(true);
    expect(ado.state.variables.map((v) => v.name)).toEqual(['Browser', 'Operating System']);
    expect((await ensureConfiguration(c, 'firefox on linux')).created).toBe(false);
    expect((await resolveConfiguration(c, { firefox: 'Firefox on Linux', sit: 42 }, ['uat', 'firefox']))!.id).toBe(ff.configuration.id);
    expect((await resolveConfiguration(c, { firefox: 'Firefox on Linux', sit: 42 }, ['sit', 'firefox']))!.id).toBe(42);
    await expect(resolveConfiguration(c, { chromium: 'Nope' }, ['chromium'])).rejects.toThrow(/does not exist/);
  });
});

describe('publishing to Test Plans', () => {
  const t0 = Date.parse('2026-10-21T09:00:00Z');
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  const st = (p: Partial<StepResult> & Pick<StepResult, 'stepId' | 'intent' | 'status'>): StepResult => ({ startedAt: iso(0), durationMs: 100, conditions: [], evidence: [], ...p });

  it('publishes iterations with per-step action results, attachments on the failing step, heals, links, flaky marking, bugs and requirement comments', async () => {
    const story = ado.workItem('User Story', { 'System.Title': 'Search' });
    const chrome = ado.configuration('Chrome', [], true);
    const firefox = ado.configuration('Firefox');
    const tc = ado.workItem('Test Case', { 'System.Title': 'Search', 'Microsoft.VSTS.TCM.Steps': steps([['Open /search'], ['Type "@term" into the Search field', 'page contains "results"'], ['Click the "Go" button', 'URL contains "q="']]) });
    const tc2 = ado.workItem('Test Case', { 'System.Title': 'Login', 'Microsoft.VSTS.TCM.Steps': steps([['Open /login']]) });
    const { planId, rootSuiteId } = ado.plan('P');
    const suite = ado.suite(planId, rootSuiteId, 'S', [tc.id, tc2.id], [chrome, firefox]);

    const runDir = await mkdtemp(join(tmpdir(), 'eztest-adopub-'));
    const vault = new EvidenceVault(runDir);
    await vault.init();
    const shot = (await vault.store('screenshot', 'screenshots/desk-s3.png', solidPng(20, 10, [255, 0, 0]), { journeyId: 'search-desk', stepId: 'click-go', description: 'failing step' })).id;
    const ok = (await vault.store('screenshot', 'screenshots/laptop-s2.png', solidPng(20, 10, [0, 255, 0]), { journeyId: 'search-laptop', stepId: 'type-term' })).id;
    const trace = (await vault.store('trace', 'traces/desk.zip', Buffer.from('PK fake trace'), { journeyId: 'search-desk', description: 'trace bundle' })).id;
    const pack = join(runDir, 'evidence-pack.zip');
    await writeFile(pack, 'PK fake pack');
    const tags = [`TestCaseId:${tc.id}`, `TestPlanId:${planId}`, `TestSuiteId:${suite}`];
    const journeys: JourneyResult[] = [
      {
        journeyId: 'search-laptop', name: 'Search [term=laptop]', status: 'passed-healed', startedAt: iso(0), durationMs: 900, tags, requirements: [String(story.id)], risk: 3, attempt: 1, ledger: {}, evidence: [],
        steps: [
          st({ stepId: 'open-search', intent: 'Open /search', status: 'passed' }),
          st({ stepId: 'type-term', intent: 'Type "laptop" into the Search field', status: 'passed-healed', evidence: [ok], heal: { stepId: 'type-term', tier: 'T1-fingerprint', original: [{ strategy: 'label', value: 'Search' }], healed: { strategy: 'testId', value: 'q' }, confidence: 0.91, verified: true, reason: 'fp', evidence: [ok] } }),
          st({ stepId: 'click-go', intent: 'Click the "Go" button', status: 'passed' }),
        ],
      },
      {
        journeyId: 'search-desk', name: 'Search [term=desk]', status: 'failed', startedAt: iso(1000), durationMs: 1200, tags, requirements: [String(story.id)], risk: 3, attempt: 1, ledger: {}, evidence: [trace],
        steps: [
          st({ stepId: 'open-search', intent: 'Open /search', status: 'passed' }),
          st({ stepId: 'type-term', intent: 'Type "desk" into the Search field', status: 'passed' }),
          st({ stepId: 'click-go', intent: 'Click the "Go" button', status: 'failed', evidence: [shot], error: { message: 'Post-condition failed: URL does not contain "q="' } }),
        ],
      },
      {
        journeyId: 'login', name: 'Login', status: 'passed', startedAt: iso(3000), durationMs: 300, tags: [`TestCaseId:${tc2.id}`, `TestPlanId:${planId}`, `TestSuiteId:${suite}`], requirements: [], risk: 3, attempt: 2, ledger: {}, evidence: [],
        steps: [st({ stepId: 'open-login', intent: 'Open /login', status: 'passed' })],
      },
    ];
    const run: RunResult = {
      runId: 'run-20261021-090000-abcdef', startedAt: iso(0), finishedAt: iso(5000), durationMs: 5000, journeys, summary: summarize(journeys),
      environment: { browser: 'firefox', gitCommit: 'a1b2c3d4e5f6a7b8c9d0', gitBranch: 'feature/search' },
    };
    const summary = await publishRun(run, {
      client: c,
      configurationId: firefox,
      links: { buildId: 42, buildNumber: '20261021.3', releaseUri: 'vstfs:///ReleaseManagement/Release/7', releaseEnvironmentUri: 'vstfs:///ReleaseManagement/Environment/9', owner: 'Ada Lovelace' },
      attachments: [{ path: pack, comment: 'EZTest evidence pack' }],
      resultEvidence: { runDir, kinds: ['screenshot', 'trace'] },
      flaky: { enabled: true },
      bugs: { enabled: true, assignTo: (id) => (id === 'search-desk' ? 'owner@contoso.com' : undefined) },
    });

    // one result per test case: the two Examples rows are its iterations, on the Firefox point
    expect(summary.results.map((r) => [r.testCaseId, r.outcome, r.iterations ?? []])).toEqual([[tc.id, 'Failed', ['search-laptop', 'search-desk']], [tc2.id, 'Passed', []]]);
    const firefoxPoint = ado.state.points.find((p) => p.suiteId === suite && p.testCaseReference.id === tc.id && p.configuration.id === firefox)!;
    const results = ado.state.results.get(summary.runId)!;
    const r1 = results.find((r) => (r.testCase as { id: string }).id === String(tc.id))!;
    expect(r1.testPoint).toEqual({ id: String(firefoxPoint.id) });
    expect(r1).toMatchObject({ outcome: 'Failed', build: { id: '42' }, runBy: { displayName: 'Ada Lovelace' }, configuration: { id: String(firefox) }, testCaseTitle: 'Search' });
    expect(String(r1.comment)).toMatch(/^healed: type-term T1-fingerprint confidence=0\.91 verified=true label=Search -> testId=q \| outcome: failed/);
    const iterations = r1.iterationDetails as Array<{ id: number; outcome: string; actionResults: Array<{ actionPath: string; outcome: string; comment?: string; iterationId: number }>; parameters: unknown[] }>;
    expect(iterations.map((i) => [i.id, i.outcome])).toEqual([[1, 'Passed'], [2, 'Failed']]);
    expect(iterations[0].actionResults.map((a) => [a.actionPath, a.outcome])).toEqual([['00000002', 'Passed'], ['00000003', 'Passed'], ['00000004', 'Passed']]);
    expect(iterations[0].actionResults[1].comment).toMatch(/^healed \(verified, awaiting review\)/);
    expect(iterations[1].actionResults.map((a) => a.outcome)).toEqual(['Passed', 'Passed', 'Failed']);
    expect(iterations[0].parameters).toEqual([{ parameterName: 'term', value: 'laptop', iterationId: 1 }]);
    expect(summary.stepResults).toEqual({ results: 2, actions: 7 });

    // attachments: run files, and the failing step's screenshot on iteration 2 / action 00000004
    const runAtt = ado.state.attachments.get(`${summary.runId}:`)!;
    expect(runAtt.map((a) => a.fileName)).toEqual(['evidence-pack.zip']);
    const resAtt = ado.state.attachments.get(`${summary.runId}:${r1.id}`)!;
    expect(resAtt.map((a) => [a.fileName, a.iterationId, a.actionPath])).toEqual([
      [`${ok}-laptop-s2.png`, '1', '00000003'],
      [`${shot}-desk-s3.png`, '2', '00000004'],
      [`${trace}-desk.zip`, '2', undefined],
    ]);

    // the run links to the build and release, has an owner, records the commit
    expect(ado.state.runs[0]).toMatchObject({ build: { id: '42' }, releaseUri: 'vstfs:///ReleaseManagement/Release/7', releaseEnvironmentUri: 'vstfs:///ReleaseManagement/Environment/9', owner: { displayName: 'Ada Lovelace' }, configurationIds: [firefox], state: 'Completed' });
    expect(String(ado.state.runs[0].comment)).toContain('a1b2c3d4e5 (feature/search)');

    // the re-run pass is marked flaky through the flaky-test API, per branch
    const r2 = results.find((r) => (r.testCase as { id: string }).id === String(tc2.id))!;
    expect(String(r2.comment)).toMatch(/re-run: login passed on attempt 2/);
    expect(ado.state.flaky).toEqual([{ testCaseReferenceId: r2.testCaseReferenceId, body: { flakyIdentifiers: [{ branchName: 'refs/heads/feature/search', isFlaky: true }] } }]);
    expect(summary.flakyMarked).toEqual([r2.id]);

    // the bug links the failing test case and the requirement, and is assigned from CODEOWNERS
    expect(summary.bugs).toEqual([expect.objectContaining({ journeyId: 'search-desk', action: 'created' })]);
    const bug = ado.state.workItems.get(summary.bugs[0].id)!;
    expect(bug.fields['System.AssignedTo']).toBe('owner@contoso.com');
    expect(bug.fields['Microsoft.VSTS.Build.FoundIn']).toBe('20261021.3');
    expect(bug.relations.map((r) => r.rel)).toEqual(['Microsoft.VSTS.Common.TestedBy-Forward', 'System.LinkTypes.Related']);
    expect(bug.relations[1].url).toBe(`${ado.collectionUrl}/_apis/wit/workItems/${story.id}`);

    // requirement summary comment, updated in place
    const cm = await commentOnRequirements(c, run, { published: summary });
    expect(cm).toEqual([{ requirement: story.id, commentId: expect.any(Number), action: 'created' }]);
    expect(ado.state.workItems.get(story.id)!.comments[0].text).toMatch(/journeys for this requirement are failing.*feature\/search/);
    expect((await commentOnRequirements(c, run, { published: summary }))[0].action).toBe('unchanged');
    expect(ado.state.workItems.get(story.id)!.comments).toHaveLength(1);
  });

  it('still publishes when the server lacks step results or the flaky API (with warnings)', async () => {
    const tc = ado.workItem('Test Case', { 'System.Title': 'A', 'Microsoft.VSTS.TCM.Steps': steps([['Open /']]) });
    const { planId, rootSuiteId } = ado.plan('P');
    const suite = ado.suite(planId, rootSuiteId, 'S', [tc.id]);
    ado.faults.resultsPatch404 = true;
    ado.faults.flakyApi404 = true;
    const j: JourneyResult = { journeyId: 'a', name: 'A', status: 'passed', startedAt: iso(0), durationMs: 10, tags: [`TestCaseId:${tc.id}`], requirements: [], risk: 3, attempt: 3, ledger: {}, evidence: [], steps: [st({ stepId: 'open', intent: 'Open /', status: 'passed' })] };
    const run: RunResult = { runId: 'r1', startedAt: iso(0), finishedAt: iso(10), durationMs: 10, journeys: [j], summary: summarize([j]), environment: {} };
    const s = await publishRun(run, { client: c, planId, suiteId: suite, flaky: { enabled: true } });
    expect(s.results[0].outcome).toBe('Passed');
    expect(s.warnings.join('\n')).toMatch(/step results not published/);
    expect(s.warnings.join('\n')).toMatch(/flaky marking is not available/);
    expect(ado.state.runs[0].state).toBe('Completed');
  });
});

describe('requirements for traceability', () => {
  it('pulls requirements by WIQL with every page, type, area and iteration', async () => {
    for (let i = 0; i < 205; i++) ado.workItem(i % 2 ? 'User Story' : 'Product Backlog Item', { 'System.Title': `R${i}`, 'System.AreaPath': i < 200 ? 'Shop\\Web' : 'Other', 'System.IterationPath': 'Shop\\S1' });
    ado.workItem('Bug', { 'System.Title': 'not a requirement', 'System.AreaPath': 'Shop\\Web' });
    const reqs = await queryRequirements(c, { wiql: requirementsWiql({ area: 'Shop\\Web' }) });
    expect(reqs).toHaveLength(200);
    expect(reqs[0]).toMatchObject({ title: 'R0', type: 'Product Backlog Item', area: 'Shop\\Web', iteration: 'Shop\\S1', source: 'ado' });
    expect(reqs[0].url).toMatch(/\/_workitems\/edit\/\d+$/);
    expect(ado.requests.filter((r) => r.path.endsWith('/workitemsbatch'))).toHaveLength(1);
  });
});
