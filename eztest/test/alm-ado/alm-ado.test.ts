import { describe, it, expect, beforeEach, afterEach } from '../support/testkit.js';
import { join } from 'node:path';
import type { JourneyResult, Logger } from '../../src/core/index.js';
import { summarize } from '../../src/core/index.js';
import { AdoClient, AdoAuthError, AdoError, parseAdoTags, publishRun, adoOutcome } from '../../src/alm-ado/index.js';
import { triageRun, loadRunArtifacts } from '../../src/insights/index.js';
import { writeReports } from '../../src/report/index.js';
import { makeRunFixture } from '../insights/fixtures.js';
import { startMockAdo, type MockAdo } from './mock-ado.js';

const PAT = 'patSECRETvalue1234567890abcdef';
let ado: MockAdo;
let sleeps: number[];
let logs: string[];

function client(token = PAT): AdoClient {
  const logger: Logger = {
    debug: (m, d) => logs.push(m + JSON.stringify(d ?? {})),
    info: (m, d) => logs.push(m + JSON.stringify(d ?? {})),
    warn: (m, d) => logs.push(m + JSON.stringify(d ?? {})),
    error: (m, d) => logs.push(m + JSON.stringify(d ?? {})),
  };
  return new AdoClient({ baseUrl: `${ado.url}/org`, project: 'proj', auth: { type: 'pat', token }, sleep: async (ms) => void sleeps.push(ms), logger });
}

beforeEach(async () => {
  ado = await startMockAdo(PAT);
  sleeps = [];
  logs = [];
  // plan 7 / suite 9: test cases 101..105 (paged 2 per page -> 3 pages)
  ado.state.points['7:9'] = [101, 102, 103, 104, 105].map((tc, i) => ({ id: 500 + i, testCaseReference: { id: tc } }));
});
afterEach(async () => {
  await ado.close();
});

describe('tag parsing', () => {
  it('parses single, list, plan and suite tags', () => {
    expect(parseAdoTags(['@TestCaseId:123', '@smoke', 'testcaseid:{4, 5}', '@TestPlanId:7', '@TestSuiteId=9'])).toEqual({ testCaseIds: [123, 4, 5], planId: 7, suiteId: 9 });
    expect(parseAdoTags(['@smoke'])).toEqual({ testCaseIds: [] });
    expect(() => parseAdoTags(['@TestCaseId:abc'])).toThrow(/positive integer/);
    expect(() => parseAdoTags(['@TestPlanId:1', '@TestPlanId:2'])).toThrow(/Conflicting/);
    expect(() => parseAdoTags(['@TestSuiteId:{1,2}'])).toThrow(/exactly one/);
  });
  it('maps outcomes', () => {
    expect(adoOutcome('passed-healed')).toBe('Passed');
    expect(adoOutcome('skipped')).toBe('NotExecuted');
    expect(adoOutcome('error')).toBe('Error');
  });
});

describe('ADO client', () => {
  it('pages with continuation tokens and honours Retry-After on GET', async () => {
    ado.faults.pointsRateLimitOnce = true;
    const pts = await client().getAll<{ id: number }>('/_apis/testplan/Plans/7/Suites/9/TestPoint');
    expect(pts.map((p) => p.id)).toEqual([500, 501, 502, 503, 504]);
    expect(sleeps).toEqual([2000]);
    const tokens = ado.requests.map((r) => new URL('http://x' + r.path).searchParams.get('continuationToken'));
    expect(tokens).toEqual([null, null, '2', '4']);
  });

  it('detects the 203 sign-in page as an auth failure and never leaks the token', async () => {
    const c = client('wrongTOKENwrongTOKEN123');
    const err = await c.request('GET', '/_apis/test/runs', { query: { planId: 7 } }).catch((e) => e);
    expect(err).toBeInstanceOf(AdoAuthError);
    expect(err.status).toBe(203);
    expect(String(err.message)).not.toContain('wrongTOKEN');
    expect(JSON.stringify(err)).not.toContain(Buffer.from(':wrongTOKENwrongTOKEN123').toString('base64'));
    expect(c.redact(`Authorization: Basic ${Buffer.from(':wrongTOKENwrongTOKEN123').toString('base64')} t=wrongTOKENwrongTOKEN123`)).toBe('Authorization: Basic *** t=***');
  });

  it('does not blindly retry a non-idempotent POST', async () => {
    ado.faults.bugFailOnce503 = true;
    const err = await client()
      .request('POST', '/_apis/wit/workitems/$Bug', { body: [], contentType: 'application/json-patch+json' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdoError);
    expect(err.code).toBe('ADO_RETRYABLE');
    expect(ado.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('refuses cross-origin URLs and plain http to remote hosts', async () => {
    await expect(client().request('GET', 'https://evil.example/_apis/x')).rejects.toThrow(/different origin/);
    expect(() => new AdoClient({ baseUrl: 'http://tfs.corp/tfs/Default', project: 'p', auth: { type: 'pat', token: 'x' } })).toThrow(/plain HTTP/);
    expect(() => new AdoClient({ org: 'o', project: 'p', auth: { type: 'bearer', token: '' } })).toThrow(/token/);
    const c = new AdoClient({ org: 'my org', project: 'Proj X', auth: { type: 'bearer', token: 'tok12345' }, apiVersion: '7.2-preview' });
    expect(c.projectUrl).toBe('https://dev.azure.com/my%20org/Proj%20X');
  });
});

describe('publishRun', () => {
  async function prepared() {
    const fx = await makeRunFixture();
    // put every mapped journey into plan 7 / suite 9
    const run = { ...fx.run, journeys: fx.run.journeys.map((j) => ({ ...j, tags: [...j.tags, '@TestPlanId:7', '@TestSuiteId:9'] })) };
    return { fx, run };
  }

  it('publishes results, attachments, completes the run and creates deduplicated bugs', async () => {
    const { fx, run } = await prepared();
    const art = await loadRunArtifacts(fx.runDir);
    const triage = triageRun({ ...art, ownership: { owned: ['127.0.0.1:4600/**'] } });
    const files = await writeReports(fx.runDir, run, { formats: ['html', 'junit'] });
    const summary = await publishRun(run, {
      client: client(),
      attachments: [{ path: files.html!, comment: 'EZTest HTML report' }, { path: files.junit! }],
      resultEvidence: { runDir: fx.runDir },
      bugs: { enabled: true, triage, categories: ['product-bug'], areaPath: 'Shop\\Orders' },
    });
    // 101 (login), 102+103 (create-order), 104 (checkout)
    expect(summary.results.map((r) => [r.journeyId, r.testCaseId, r.outcome])).toEqual([
      ['login', 101, 'Passed'],
      ['create-order', 102, 'Passed'],
      ['create-order', 103, 'Passed'],
      ['checkout', 104, 'Failed'],
    ]);
    expect(summary.unmapped.sort()).toEqual(['data-import', 'later', 'reports', 'search', 'xss<script>']);
    const posted = ado.state.results[summary.runId];
    expect(posted).toHaveLength(4);
    const healed = posted.find((r) => (r.testCase as { id: string }).id === '102')!;
    expect(healed.outcome).toBe('Passed');
    expect(healed.comment).toMatch(/^healed: s3 T1-fingerprint confidence=0.92 verified=true css=#submit-order -> css=#place-order/);
    expect(posted.find((r) => (r.testCase as { id: string }).id === '104')!.errorMessage).toContain('Post-condition failed');
    expect(ado.state.runs[0].state).toBe('Completed');
    expect(ado.state.attachments[`${summary.runId}:`].map((a) => a.fileName)).toEqual(['report.html', 'junit.xml']);
    const checkoutResult = summary.results.find((r) => r.journeyId === 'checkout')!;
    expect(ado.state.attachments[`${summary.runId}:${checkoutResult.resultId}`].map((a) => a.fileName)).toEqual([`${fx.ids['checkout.s2']}-checkout-s2.png`]);

    expect(summary.bugs).toHaveLength(1);
    expect(summary.bugs[0]).toMatchObject({ journeyId: 'checkout', action: 'created' });
    const bug = ado.state.bugs[0];
    expect(bug.tags).toContain(`ezsig-${summary.bugs[0].signature}`);
    expect(bug.relations).toEqual([expect.objectContaining({ rel: 'Microsoft.VSTS.Common.TestedBy-Forward', url: `${ado.url}/org/_apis/wit/workItems/104` })]);
    expect(bug.repro).toContain(fx.ids['checkout.s2']);

    // publishing again with a new run name dedups the bug by signature
    const again = await publishRun(run, { client: client(), runName: 'second', bugs: { enabled: true, triage, categories: ['product-bug'] } });
    expect(again.bugs[0]).toMatchObject({ action: 'deduped', id: bug.id });
    expect(ado.state.bugs).toHaveLength(1);

    // token never sent anywhere but the Authorization header, never logged
    expect(ado.requests.every((r) => !r.path.includes(PAT))).toBe(true);
    expect(logs.join('\n')).not.toContain(PAT);
  });

  it('recovers from lost responses without duplicating runs, results or bugs', async () => {
    const { run } = await prepared();
    ado.faults.pointsRateLimitOnce = true;
    ado.faults.createRunCommitThen500 = true;
    ado.faults.resultsCommitThen503 = true;
    ado.faults.bugFailOnce503 = true;
    const summary = await publishRun(run, { client: client(), batchSize: 2, bugs: { enabled: true } });
    expect(ado.state.runs).toHaveLength(1);
    expect(ado.state.results[summary.runId]).toHaveLength(4); // not 6
    expect(summary.results.every((r) => typeof r.resultId === 'number')).toBe(true);
    expect(summary.warnings.join('\n')).toMatch(/create run: transient failure, server already had it/);
    expect(summary.warnings.join('\n')).toMatch(/add results 1-2: transient failure, server already had it/);
    expect(summary.warnings.join('\n')).toMatch(/create bug for checkout: transient failure and not present on server/);
    // without triage every failed journey (4, all with distinct signatures) gets one bug; the 503 did not duplicate any
    expect(ado.state.bugs).toHaveLength(4);
    expect(new Set(ado.state.bugs.map((b) => b.tags)).size).toBe(4);
    const bugPosts = ado.requests.filter((r) => r.method === 'POST' && r.path.includes('$Bug'));
    expect(bugPosts).toHaveLength(5); // one failed with 503 and was re-sent after a WIQL check
    // every failed journey got exactly one bug per distinct signature
    const failedIds = run.journeys.filter((j: JourneyResult) => j.status === 'failed').map((j) => j.journeyId).sort();
    expect(summary.bugs.map((b) => b.journeyId).sort()).toEqual(failedIds);
    expect(sleeps).toContain(2000);
  });

  it('rejects unpublishable input and surfaces auth failures', async () => {
    const { run } = await prepared();
    await expect(publishRun({ ...run, journeys: [] }, { client: client() })).rejects.toThrow(/no journeys/);
    const untagged = { ...run, journeys: run.journeys.map((j) => ({ ...j, tags: [] })) };
    await expect(publishRun(untagged, { client: client() })).rejects.toThrow(/@TestCaseId/);
    const noPoints = { ...run, journeys: run.journeys.map((j) => ({ ...j, tags: ['@TestCaseId:999', '@TestPlanId:7', '@TestSuiteId:9'] })) };
    noPoints.summary = summarize(noPoints.journeys);
    await expect(publishRun(noPoints, { client: client() })).rejects.toThrow(/none of the test cases/);
    await expect(publishRun(run, { client: client('bad-token-value-xyz') })).rejects.toBeInstanceOf(AdoAuthError);
    void join;
  });
});
