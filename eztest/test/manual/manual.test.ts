/**
 * Manual and hybrid test management without a browser: the .ez manual-case
 * format, the manual driver (verdicts, notes, attachments in the evidence
 * vault, blocked and ended runs, no tester attached), the terminal prompt,
 * suites / cycles / progress, the case editor model, converting a case to an
 * automated journey (grammar and recording), importing Excel/CSV and Azure
 * Test Plans cases as manual or hybrid, and a full manual run published to
 * Azure Test Plans.
 */
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { verifyEvidence, type RunResult } from '../../src/core/index.js';
import { journeyToEzScript, parseEzScript, parseIntent } from '../../src/intent/index.js';
import { runJourneys, journeyKind, isManualJourney, ManualRunEnded, type ManualStepRequest, type ManualVerdict } from '../../src/runner/index.js';
import {
  automateWithGrammar, automateWithRecording, caseFromJourney, cycleProgress, parsePlans, renderManualCase, stateOf, terminalManualProvider, type CaseInfo,
} from '../../src/manual/index.js';
import { importManualCsv } from '../../src/importers/index.js';
import { AdoClient, buildStepsXml, importTestCases, publishRun } from '../../src/alm-ado/index.js';
import { evaluateReadiness, readEvidenceManifest } from '../../src/insights/index.js';
import { solidPng } from '../insights/fixtures.js';
import { startMockAdoServer, type MockAdoServer } from '../alm-ado/mock-ado-server.js';

const CASE = `Journey: Refund a cancelled order
Id: refund-cancelled
Type: manual
Assignee: Quinn
Preconditions: An order ORD-<order> exists and is cancelled
Requirements: ORD-9
Tags: @orders @regression
Risk: 4

Manual: Open order "ORD-<order>" in the back office
  Expected: The status is Cancelled
  Attachment: docs/refund-policy.pdf
Manual: Press Refund and confirm
  Expected: A refund of <amount> is shown
  Expected: The customer gets an e-mail
Manual step: Check the ledger entry

Examples:
  | order | amount |
  | 1 | 49.50 |
`;

const out = () => mkdtemp(join(tmpdir(), 'eztest-manual-'));

/** A provider answering from a script of verdicts, recording every request. */
function scripted(answers: Array<ManualVerdict | 'end'>) {
  const asked: ManualStepRequest[] = [];
  return {
    asked,
    provider: {
      async verdict(r: ManualStepRequest): Promise<ManualVerdict> {
        asked.push(r);
        const a = answers.shift();
        if (!a || a === 'end') throw new ManualRunEnded();
        return a;
      },
    },
  };
}

describe('the manual case format', () => {
  it('parses Manual:, Expected:, Attachment: lines and the Type / Assignee / Preconditions headers, and renders back', () => {
    const j = parseEzScript(CASE);
    expect(j).toMatchObject({ id: 'refund-cancelled', type: 'manual', assignee: 'Quinn', preconditions: 'An order ORD-<order> exists and is cancelled', requirements: ['ORD-9'], risk: 4 });
    expect(j.steps.map((s) => [s.action, s.value])).toEqual([
      ['manual', 'Open order "ORD-<order>" in the back office'],
      ['manual', 'Press Refund and confirm'],
      ['manual', 'Check the ledger entry'],
    ]);
    expect(j.steps[0].args).toEqual({ expected: ['The status is Cancelled'], attachments: ['docs/refund-policy.pdf'] });
    expect(j.steps[1].args).toEqual({ expected: ['A refund of <amount> is shown', 'The customer gets an e-mail'] });
    expect(journeyKind(j)).toBe('manual');
    expect(isManualJourney(j)).toBe(true);
    const again = parseEzScript(journeyToEzScript(j));
    expect(again.steps).toEqual(j.steps);
    expect(again).toMatchObject({ type: 'manual', assignee: 'Quinn', preconditions: j.preconditions, examples: j.examples });
    expect(parseIntent('Manual: Check the printed invoice')).toMatchObject({ action: 'manual', value: 'Check the printed invoice' });
  });

  it('infers hybrid journeys, keeps Expect lines as automated checks and refuses contradictory types', () => {
    const h = parseEzScript(['Journey: Approve an order', 'Open /orders', 'Manual: Approve it in the back office', '  Expected: Approved', '  Expect the page contains "Approved"', 'Click the "Refresh" button'].join('\n'));
    expect(journeyKind(h)).toBe('hybrid');
    expect(isManualJourney(h)).toBe(false);
    expect(h.steps[1].postconditions).toEqual([{ type: 'pageContainsText', value: 'Approved' }]);
    expect(() => parseEzScript('Journey: X\nType: manual\nOpen /login\nManual: Look')).toThrow(/Type: manual journey "X" has automated steps/);
    expect(() => parseEzScript('Journey: X\nType: automated\nManual: Look')).toThrow(/use Type: hybrid/);
    expect(() => parseEzScript('Journey: X\nType: exploratory\nManual: Look')).toThrow(/Type must be manual, hybrid or automated/);
    expect(() => parseEzScript('Journey: X\nOpen /\nExpected: nothing')).toThrow(/cannot understand/);
  });
});

describe('the manual driver', () => {
  it('runs a manual case without a browser: verdicts, notes and attachments in the evidence vault, parameters filled in', async () => {
    const dir = await out();
    const s = scripted([
      { status: 'passed', tester: 'Quinn', attachments: [{ name: 'order.png', contentType: 'image/png', data: solidPng(4, 4, [0, 128, 0]) }] },
      { status: 'failed', tester: 'Quinn', notes: 'No refund line; token=abc123secret', actual: 'Error 500 on confirm' },
      { status: 'passed', tester: 'Quinn' },
    ]);
    const run = await runJourneys([parseEzScript(CASE)], { outputDir: dir, manual: s.provider, mask: (t) => t.replace(/abc123secret/g, '****') });
    expect(run.environment.browser).toBe('none');
    const j = run.journeys[0];
    expect(j.journeyId).toBe('refund-cancelled-1');
    expect(j.status).toBe('failed');
    expect(j.browser).toBe('manual');
    expect(j.manual).toEqual({ type: 'manual', executed: 3, pending: 0, testers: ['Quinn'], assignee: 'Quinn' });
    // the tester saw the filled-in parameters, expected results and references
    expect(s.asked.map((r) => [r.index, r.total, r.instruction])).toEqual([[1, 3, 'Open order "ORD-1" in the back office'], [2, 3, 'Press Refund and confirm'], [3, 3, 'Check the ledger entry']]);
    expect(s.asked[1].expected).toEqual(['A refund of 49.50 is shown', 'The customer gets an e-mail']);
    expect(s.asked[0]).toMatchObject({ attachments: ['docs/refund-policy.pdf'], hybrid: false, preconditions: 'An order ORD-1 exists and is cancelled', assignee: 'Quinn' });
    // a failed manual step does not stop the case: the tester records every step
    expect(j.steps.map((x) => [x.status, x.manual?.verdict])).toEqual([['passed', 'passed'], ['failed', 'failed'], ['passed', 'passed']]);
    expect(j.steps[1].manual).toMatchObject({ tester: 'Quinn', notes: 'No refund line; token=****', actual: 'Error 500 on confirm' });
    expect(j.steps[1].error?.message).toBe('manual step failed (Quinn): No refund line; token=****');
    // evidence: verdict JSON per step + the screenshot, hash-chained
    const ev = await readEvidenceManifest(join(dir, run.runId));
    const shot = ev.find((e) => e.id === j.steps[0].manual!.attachments[0])!;
    expect(shot).toMatchObject({ kind: 'screenshot', stepId: j.steps[0].stepId, journeyId: j.journeyId });
    expect(ev.filter((e) => e.path.endsWith('.manual.json')).map((e) => e.description)).toEqual(['manual verdict: passed by Quinn', 'manual verdict: failed by Quinn', 'manual verdict: passed by Quinn']);
    const verdictFile = await readFile(join(dir, run.runId, ev.find((e) => e.path.endsWith('.manual.json') && e.stepId === j.steps[1].stepId)!.path), 'utf8');
    expect(verdictFile).not.toContain('abc123secret');
    expect((await verifyEvidence(join(dir, run.runId))).ok).toBe(true);
    const onDisk = JSON.parse(await readFile(join(dir, run.runId, 'run.json'), 'utf8')) as RunResult;
    expect(onDisk.journeys[0].manual?.executed).toBe(3);
  });

  it('a blocked step blocks the rest; ending the run leaves the remaining steps not executed; without a tester nothing passes', async () => {
    const j = parseEzScript(CASE.replace(/\nExamples:[\s\S]*$/, '\n'));
    const blocked = await runJourneys([j], { outputDir: await out(), manual: scripted([{ status: 'blocked', tester: 'Quinn', notes: 'Back office is down' }]).provider });
    const b = blocked.journeys[0];
    expect(b.status).toBe('failed');
    expect(b.error).toMatchObject({ name: 'ManualBlocked', message: 'manual step blocked: Back office is down' });
    expect(b.steps.map((x) => x.status)).toEqual(['blocked', 'skipped', 'skipped']);
    expect(b.manual).toMatchObject({ executed: 1, pending: 2 });
    expect(stateOf([b])).toBe('blocked');

    const ended = await runJourneys([j], { outputDir: await out(), manual: scripted([{ status: 'passed', tester: 'Q' }, 'end']).provider });
    const e = ended.journeys[0];
    expect(e.steps.map((x) => [x.status, x.manual?.verdict])).toEqual([['passed', 'passed'], ['skipped', 'pending'], ['skipped', 'pending']]);
    expect(e.status).toBe('skipped');
    expect(e.manual).toMatchObject({ executed: 1, pending: 2 });
    expect(stateOf([e])).toBe('in-progress');

    const none = await runJourneys([j], { outputDir: await out() });
    expect(none.journeys[0].status).toBe('skipped');
    expect(none.journeys[0].steps.every((x) => x.status === 'skipped' && x.manual?.verdict === 'pending')).toBe(true);
    expect(none.journeys[0].steps[0].error?.message).toMatch(/no tester attached/);
    // readiness: the manualVerified gate blocks a run whose manual steps have no verdict
    const r = evaluateReadiness('version: 1\ngates:\n  manualVerified: true\n', { run: blocked, evidence: [] });
    expect(r.gates[0]).toMatchObject({ gate: 'manualVerified', status: 'fail', severity: 'blocker' });
    expect(r.decision).toBe('NO_GO');
  });

  it('asks in a terminal: verdict letters, notes and attachment paths (piped input)', async () => {
    const input = new PassThrough();
    const printed: string[] = [];
    const p = terminalManualProvider({ input, output: (t) => printed.push(t), tester: 'Tess' });
    const j = parseEzScript('Journey: T\nType: manual\nManual: Look at the logo\n  Expected: It is blue\nManual: Read the footer');
    input.write('x\np\n\n');
    input.write('f\nfooter says 2019\n\n');
    const run = await runJourneys([j], { outputDir: await out(), manual: p });
    p.close();
    expect(run.journeys[0].steps.map((s) => [s.manual?.verdict, s.manual?.notes, s.manual?.tester])).toEqual([['passed', undefined, 'Tess'], ['failed', 'footer says 2019', 'Tess']]);
    expect(printed.join('\n')).toContain('Manual step 1/2 of "T"');
    expect(printed.join('\n')).toContain('Expected: It is blue');
  });
});

describe('test cycles', () => {
  const cases: CaseInfo[] = [
    { id: 'refund', name: 'Refund', tags: ['orders'], type: 'manual', assignee: 'Quinn' },
    { id: 'cancel', name: 'Cancel', tags: ['orders'], type: 'hybrid' },
    { id: 'login', name: 'Login', tags: ['auth'], type: 'automated' },
  ];
  const plans = parsePlans({
    version: 1,
    suites: [{ id: 'orders', name: 'Orders', tags: ['orders'] }, { id: 'auth', name: 'Auth', cases: ['login'] }],
    cycles: [{ id: 'r26', name: 'Release 26.10', suites: ['orders', 'auth'], assignments: { cancel: 'Ravi' }, state: 'active', runs: ['run-a', 'run-b'] }],
  });
  const jr = (id: string, status: 'passed' | 'failed' | 'skipped', extra: Partial<RunResult['journeys'][number]> = {}) => ({
    journeyId: id, name: id, status, startedAt: '2026-10-20T10:00:00.000Z', durationMs: 1, steps: [{ stepId: 's', intent: 's', status: status === 'skipped' ? 'skipped' as const : status, startedAt: '', durationMs: 0, conditions: [], evidence: [] }],
    tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [], ...extra,
  });
  const runs: RunResult[] = [
    { runId: 'run-a', startedAt: '2026-10-20T10:00:00.000Z', finishedAt: '', durationMs: 0, summary: undefined as never, environment: {}, journeys: [jr('refund', 'failed', { manual: { type: 'manual', executed: 2, pending: 0, testers: ['Quinn'] } }), jr('login', 'passed')] },
    { runId: 'run-b', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '', durationMs: 0, summary: undefined as never, environment: {}, journeys: [jr('refund', 'passed', { manual: { type: 'manual', executed: 2, pending: 0, testers: ['Quinn'] } })] },
    { runId: 'run-other', startedAt: '2026-10-22T10:00:00.000Z', finishedAt: '', durationMs: 0, summary: undefined as never, environment: {}, journeys: [jr('cancel', 'failed')] },
  ];

  it('validates plans and computes progress by state, tester, suite and day from the cycle\'s runs only', () => {
    expect(() => parsePlans({ suites: [], cycles: [{ id: 'c', name: 'C', suites: ['nope'] }] })).toThrow(/unknown suite nope/);
    expect(() => parsePlans({ suites: [{ id: 'bad id', name: 'x' }] })).toThrow(/ids are letters/);
    const p = cycleProgress(plans.cycles[0], plans, cases, runs);
    expect(p.cases.map((c) => [c.id, c.state, c.assignee])).toEqual([['refund', 'passed', 'Quinn'], ['cancel', 'untested', 'Ravi'], ['login', 'passed', undefined]]);
    expect(p.counts).toMatchObject({ passed: 2, untested: 1 });
    expect(p.executedRatio).toBeCloseTo(2 / 3);
    expect(p.byAssignee.map((a) => [a.assignee, a.total, a.counts.passed])).toEqual([['(unassigned)', 1, 1], ['Quinn', 1, 1], ['Ravi', 1, 0]]);
    expect(p.bySuite.map((s) => [s.suite, s.total, s.counts.passed])).toEqual([['orders', 2, 1], ['auth', 1, 1]]);
    expect(p.burnup).toEqual([{ date: '2026-10-20', executed: 1, passed: 1 }, { date: '2026-10-21', executed: 2, passed: 2 }]);
  });
});

describe('authoring and converting cases', () => {
  it('renders the case editor model to .ez and reads it back', () => {
    const model = {
      name: 'Print the invoice', assignee: 'Quinn', requirements: ['INV-2'], tags: ['@docs'], risk: 4, preconditions: 'An order exists',
      steps: [
        { instruction: 'Open order <order> and press Print', expected: ['A PDF opens'], attachments: ['docs/sample.pdf'] },
        { automated: 'Click the "Download invoice" link', checks: ['the page contains "Invoice"'] },
      ],
      parameters: { columns: ['order'], rows: [['ORD-1'], ['ORD-2']] },
    };
    const { ez, journey } = renderManualCase(model);
    expect(ez).toContain('Type: hybrid');
    expect(ez).toContain('Manual: Open order <order> and press Print\n  Expected: A PDF opens\n  Attachment: docs/sample.pdf\nClick the "Download invoice" link\n  Expect the page contains "Invoice"');
    expect(journey.examples).toEqual([{ order: 'ORD-1' }, { order: 'ORD-2' }]);
    const back = caseFromJourney(journey);
    expect(back).toMatchObject({ name: 'Print the invoice', assignee: 'Quinn', requirements: ['INV-2'], tags: ['docs'], risk: 4, type: 'hybrid', parameters: model.parameters });
    expect(back.steps[0]).toMatchObject({ instruction: 'Open order <order> and press Print', expected: ['A PDF opens'], attachments: ['docs/sample.pdf'] });
    expect(back.steps[1]).toMatchObject({ automated: 'Click the "Download invoice" link', checks: ['page contains "Invoice"'] });
    expect(() => renderManualCase({ name: 'Broken', steps: [{ automated: 'Frobnicate the widget' }] })).toThrow(/cannot understand/);
  });

  it('converts a manual case through the grammar: what reads becomes automated, the rest stays manual (hybrid)', () => {
    const j = parseEzScript(['Journey: Sign in', 'Type: manual', 'Requirements: AUTH-1', '', 'Manual: Open /login', 'Manual: Type "bob" into the Username field', '  Expected: the Username field has value "bob"', 'Manual: Ask a colleague to approve the login', '  Expected: they nod'].join('\n'));
    const r = automateWithGrammar(j);
    expect(r.automated).toEqual(['Open /login', 'Type "bob" into the Username field']);
    expect(r.kept).toEqual(['Ask a colleague to approve the login']);
    expect(r.uncheckedExpectations).toEqual([]);
    expect(r.journey.id).toBe(j.id);
    expect(journeyKind(r.journey)).toBe('hybrid');
    expect(r.ez).toContain('# Manual: Type "bob" into the Username field\nType "bob" into the Username field\n  Expect the Username field has value "bob"');
    expect(r.ez).toContain('Manual: Ask a colleague to approve the login\n  Expected: they nod');
    expect(r.journey.requirements).toEqual(['AUTH-1']);
    // misreadings stay manual: "press" of something that is not a key, a "navigation" to a page by name
    const m = automateWithGrammar(parseEzScript('Journey: M\nType: manual\nManual: Press Refund and confirm\nManual: Go to the back office\nManual: Press Enter'));
    expect(m.kept).toEqual(['Press Refund and confirm', 'Go to the back office']);
    expect(m.automated).toEqual(['Press Enter']);
  });

  it('converts with recorded lines per manual step; unrecorded steps stay manual', () => {
    const j = parseEzScript('Journey: Cancel an order\nType: manual\nManual: Open the order\nManual: Press Cancel order\n  Expected: the page contains "cancelled"\nManual: Phone the customer');
    const [a, b] = j.steps;
    const r = automateWithRecording(j, [
      { stepId: a.id, lines: ['Open "http://127.0.0.1:4600/orders/1"'] },
      { stepId: b.id, lines: ['Click the "Cancel order" button', 'Expect the URL contains "cancelled=1"'] },
    ]);
    expect(r.automated).toEqual(['Open the order', 'Press Cancel order']);
    expect(r.kept).toEqual(['Phone the customer']);
    expect(r.journey.steps.map((s) => s.action)).toEqual(['navigate', 'click', 'manual']);
    expect(r.journey.steps[1].postconditions).toEqual([{ type: 'urlContains', value: 'cancelled=1' }, { type: 'pageContainsText', value: 'cancelled' }]);
    expect(() => automateWithRecording(j, [{ stepId: 'nope', lines: [] }])).toThrow(/No step "nope"/);
  });
});

describe('importing manual cases', () => {
  const CSV = readFileSync(fileURLToPath(new URL('../importers/fixtures/manual-tests.csv', import.meta.url)), 'utf8');

  it('Excel/CSV as manual cases (Manual: steps with expected results) or hybrid (automate what reads)', () => {
    const manual = importManualCsv(CSV, { manualMode: 'manual' });
    expect(manual.todo).toEqual([]);
    const bob = manual.converted[0];
    expect(bob.ez).toContain('Type: manual');
    expect(bob.ez).toContain('Manual: Click the "Sign in" button\n  Expected: The URL contains "/dashboard"\n  Expected: User is greeted warmly');
    expect(journeyKind(bob.journey!)).toBe('manual');
    expect(manual.converted[2].ez).toContain('Manual: Do the thing\n  Expected: It works');

    const hybrid = importManualCsv(CSV, { manualMode: 'hybrid' });
    expect(hybrid.todo).toEqual([]);
    const order = hybrid.converted[1];
    expect(order.ez).toMatch(/^Go to \/orders\/new/m);
    expect(order.ez).toContain('Manual: Pick a nice product\n  Expected: the page contains "New order"');
    expect(journeyKind(order.journey!)).toBe('hybrid');
    // default (automated) keeps TODO lines as before
    expect(importManualCsv(CSV).todo.length).toBeGreaterThan(0);
  });
});

describe('Azure Test Plans: import as manual, run, publish the result', () => {
  let ado: MockAdoServer;
  let c: AdoClient;
  beforeEach(async () => {
    ado = await startMockAdoServer();
    c = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: ado.pat }, sleep: async () => undefined });
  });
  afterEach(async () => ado.close());

  it('imports a test case as a manual case, runs it with a tester and publishes a manual result with step outcomes, notes and the screenshot', async () => {
    const story = ado.workItem('User Story', { 'System.Title': 'Refunds' });
    const tc = ado.workItem('Test Case', {
      'System.Title': 'Refund a cancelled order',
      'Microsoft.VSTS.TCM.Steps': buildStepsXml([{ action: 'Open the cancelled order in the back office', expected: 'Status is Cancelled' }, { action: 'Press Refund', expected: 'A refund line appears' }]),
    }, [{ rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${ado.collectionUrl}/_apis/wit/workItems/${story.id}` }]);
    const { planId, rootSuiteId } = ado.plan('Release');
    const suite = ado.suite(planId, rootSuiteId, 'Refunds', [tc.id]);
    const report = await importTestCases({ client: c, source: { planId, suiteId: suite }, manualMode: 'manual' });
    const conv = report.converted[0];
    expect(report.todo).toEqual([]);
    expect(conv.ez).toContain('Type: manual');
    expect(conv.ez).toContain('Manual: Open the cancelled order in the back office\n  Expected: Status is Cancelled');
    expect(conv.journey!.requirements).toEqual([String(story.id)]);

    const dir = await out();
    const run = await runJourneys([conv.journey!], {
      outputDir: dir,
      manual: scripted([
        { status: 'passed', tester: 'Quinn Tester', attachments: [{ name: 'status.png', contentType: 'image/png', data: solidPng(6, 6, [200, 0, 0]) }] },
        { status: 'failed', tester: 'Quinn Tester', notes: 'Refund button is disabled' },
      ]).provider,
    });
    expect(run.journeys[0].status).toBe('failed');
    const summary = await publishRun(run, { client: c, planId, suiteId: suite, resultEvidence: { runDir: join(dir, run.runId), kinds: ['screenshot'] } });
    expect(summary.results.map((r) => [r.testCaseId, r.outcome])).toEqual([[tc.id, 'Failed']]);
    const res = ado.state.results.get(summary.runId)![0];
    // a manual result: no automated test name, run by the tester, the tester's notes on the step
    expect(res.automatedTestName).toBeUndefined();
    expect(res).toMatchObject({ outcome: 'Failed', runBy: { displayName: 'Quinn Tester' } });
    expect(String(res.comment)).toContain('manual run in EZTest by Quinn Tester');
    const it = (res.iterationDetails as Array<{ actionResults: Array<{ outcome: string; comment?: string }> }>)[0];
    expect(it.actionResults.map((a) => a.outcome)).toEqual(['Passed', 'Failed']);
    expect(it.actionResults[1].comment).toBe('tester: Quinn Tester; Refund button is disabled');
    const att = ado.state.attachments.get(`${summary.runId}:${res.id}`)!;
    expect(att.map((a) => a.fileName)).toEqual([expect.stringMatching(/manual-1\.png$/)]);
    expect(ado.state.runs[0].state).toBe('Completed');
  });
});
