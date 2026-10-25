/**
 * ado.testCaseTag: custom test-id tags (`@TC-VISIT_1`) mapped to Azure DevOps test case ids through a map file,
 * when publishing a run (against the mock Azure DevOps server).
 */
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdoClient, loadTestCaseTagMap, mappedTestCase, parseAdoTags, publishRun } from '../../src/alm-ado/index.js';
import { makeRunFixture } from '../insights/fixtures.js';
import { startMockAdo, type MockAdo } from './mock-ado.js';

const PAT = 'patSECRETvalue1234567890abcdef';
let ado: MockAdo;
let dir: string;
beforeEach(async () => {
  ado = await startMockAdo(PAT);
  ado.state.points['7:9'] = [101, 102, 103].map((tc, i) => ({ id: 500 + i, testCaseReference: { id: tc } }));
  dir = await mkdtemp(join(tmpdir(), 'eztest-tc-map-'));
});
afterEach(async () => {
  await ado.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ado.testCaseTag', () => {
  it('maps custom test-id tags to test case ids, with or without the prefix in the map', async () => {
    await writeFile(join(dir, 'ado-cases.yaml'), 'TC-VISIT_1: 101\nVISIT_2: 102\n# a comment\nTC-PET_9: 103\n');
    const m = (await loadTestCaseTagMap({ pattern: '@TC-([A-Z0-9_]+)', map: 'ado-cases.yaml' }, dir))!;
    expect(mappedTestCase('@TC-VISIT_1', m)).toBe(101);
    expect(mappedTestCase('TC-VISIT_2', m)).toBe(102);
    expect(mappedTestCase('@TC-UNKNOWN', m)).toBeUndefined();
    expect(mappedTestCase('@smoke', m)).toBeUndefined();
    expect(parseAdoTags(['TC-VISIT_1', '@TestCaseId:103', 'smoke'], m).testCaseIds).toEqual([101, 103]);
    await writeFile(join(dir, 'bad.yaml'), 'TC-X: not-a-number\n');
    await expect(loadTestCaseTagMap({ pattern: '@TC-([A-Z0-9_]+)', map: 'bad.yaml' }, dir)).rejects.toThrow(/not a test case id/);
    expect(await loadTestCaseTagMap(undefined, dir)).toBeUndefined();
  });

  it('publishes results for journeys tagged only with custom test ids', async () => {
    await writeFile(join(dir, 'ado-cases.yaml'), 'TC-VISIT_1: 101\nTC-VISIT_2: 102\n');
    const testCaseTag = await loadTestCaseTagMap({ pattern: '@TC-([A-Z0-9_]+)', map: 'ado-cases.yaml' }, dir);
    const fx = await makeRunFixture();
    const tags: Record<string, string[]> = { login: ['TC-VISIT_1'], 'create-order': ['TC-VISIT_2'] };
    const run = {
      ...fx.run,
      journeys: fx.run.journeys.map((j) => ({ ...j, tags: [...j.tags.filter((t) => !/TestCaseId/i.test(t)), ...(tags[j.journeyId] ?? []), '@TestPlanId:7', '@TestSuiteId:9'] })),
    };
    const client = new AdoClient({ baseUrl: `${ado.url}/org`, project: 'proj', auth: { type: 'pat', token: PAT }, sleep: async () => undefined });
    const summary = await publishRun(run, { client, testCaseTag, stepResults: false });
    expect(summary.results.map((r) => [r.journeyId, r.testCaseId])).toEqual([['login', 101], ['create-order', 102]]);
    expect(ado.state.results[summary.runId]).toHaveLength(2);
    await rm(fx.runDir, { recursive: true, force: true });
  });
});
