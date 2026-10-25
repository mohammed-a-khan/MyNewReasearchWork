/**
 * Reports for Gherkin scenarios: the feature / rule / scenario hierarchy
 * (JSON, HTML, the large-run HTML) and JUnit with one suite per feature.
 */
import { describe, expect, it } from '../support/testkit.js';
import type { JourneyResult, RunResult, StepResult } from '../../src/core/index.js';
import { bddHierarchy, buildJsonReport, buildReportModel, renderHtmlReport, renderJUnit, worstStatus } from '../../src/report/index.js';
import { renderLargeHtmlReport } from '../../src/scale/report.js';

const step = (line: number, text: string, status: StepResult['status'], match: 'definition' | 'ez' | 'undefined' = 'ez'): StepResult => ({
  stepId: `L${line}`, intent: `Given ${text}`, status, startedAt: '2026-10-23T00:00:00Z', durationMs: 5, conditions: [], evidence: [],
  gherkin: { kind: 'step', keyword: 'Given', text, line, match, ...(match === 'definition' ? { location: 'steps/a.steps.ts:3' } : {}) },
  ...(status === 'failed' ? { error: { message: `${text} failed` } } : {}),
});

function journey(id: string, status: JourneyResult['status'], bdd: JourneyResult['bdd'], steps: StepResult[]): JourneyResult {
  return { journeyId: id, name: bdd?.scenario.name ?? id, status, startedAt: '2026-10-23T00:00:00Z', durationMs: 100, steps, tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [], ...(bdd ? { bdd } : {}) };
}

const run: RunResult = {
  runId: 'run-1', startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z', durationMs: 1000, environment: { node: 'v22' },
  summary: { total: 4, passed: 2, passedHealed: 0, failed: 1, skipped: 0, errors: 0 } as RunResult['summary'],
  journeys: [
    journey('plain', 'passed', undefined, [{ ...step(1, 'x', 'passed'), gherkin: undefined }]),
    journey('b--refund', 'failed', { file: 'features/billing.feature', feature: { name: 'Billing', line: 1 }, rule: { name: 'Refunds', line: 10 }, scenario: { name: 'Refund', line: 12, keyword: 'Scenario' } }, [step(13, 'a refund', 'failed', 'undefined'), step(14, 'it is paid', 'skipped')]),
    journey('b--invoice', 'passed', { file: 'features/billing.feature', feature: { name: 'Billing', line: 1 }, scenario: { name: 'Invoice', line: 3, keyword: 'Scenario' } }, [step(4, 'an invoice', 'passed', 'definition')]),
    journey('a--login-1', 'passed', { file: 'features/a.feature', feature: { name: 'Login', line: 1 }, scenario: { name: 'Login as bob', line: 2, keyword: 'Scenario Outline' }, examples: { name: 'Users', line: 5, row: { line: 7, index: 0 } } }, [step(3, 'I log in', 'passed')]),
  ],
};
run.summary.total = 4;

describe('BDD reports', () => {
  it('groups scenarios by feature (file order) and rule, with counts and the worst status', () => {
    const h = bddHierarchy(run)!;
    expect(h.features.map((f) => [f.file, f.name, f.status])).toEqual([['features/a.feature', 'Login', 'passed'], ['features/billing.feature', 'Billing', 'failed']]);
    const billing = h.features[1];
    expect(billing.scenarios.map((s) => s.name)).toEqual(['Invoice']);
    expect(billing.rules.map((r) => [r.name, r.status, r.scenarios.map((s) => s.name)])).toEqual([['Refunds', 'failed', ['Refund']]]);
    expect(billing.counts).toEqual({ passed: 1, passedHealed: 0, failed: 1, skipped: 0, errors: 0 });
    expect(billing.rules[0].scenarios[0].steps).toEqual([
      { keyword: 'Given', text: 'a refund', line: 13, status: 'failed', durationMs: 5, match: 'undefined', error: 'a refund failed' },
      { keyword: 'Given', text: 'it is paid', line: 14, status: 'skipped', durationMs: 5, match: 'ez' },
    ]);
    expect(h.features[0].scenarios[0]).toMatchObject({ line: 7, examples: { name: 'Users', row: { index: 0 } } });
    expect(h.totals).toMatchObject({ features: 2, rules: 1, scenarios: 3, steps: 4, passed: 2, failed: 1 });
    expect(bddHierarchy({ ...run, journeys: [run.journeys[0]] })).toBeUndefined();
    expect(worstStatus(['passed', 'skipped'])).toBe('passed');
    expect(worstStatus(['skipped', 'skipped'])).toBe('skipped');
    expect(worstStatus(['passed-healed', 'failed', 'passed'])).toBe('failed');
  });

  it('JSON and HTML carry the hierarchy; the large-run report has the feature table', () => {
    expect(buildJsonReport(run).bdd?.features.length).toBe(2);
    expect(buildJsonReport({ ...run, journeys: [run.journeys[0]] }).bdd).toBeUndefined();
    // The report groups the Tests tab by feature and rule (the suite path); each scenario's detail has its
    // feature file and line, and each step its keyword and binding.
    const m = buildReportModel(run);
    const refund = m.tests.find((t) => t.gherkin && t.suite.includes('Refunds'))!;
    expect(refund.suite).toEqual(expect.arrayContaining(['Billing', 'Refunds']));
    expect(refund.gherkin).toMatchObject({ file: 'features/billing.feature', keyword: expect.any(String) });
    expect(refund.gherkin!.steps[0]).toEqual(['Given', 'a refund', 'undefined']);
    expect(m.tests.flatMap((t) => t.gherkin?.steps ?? [])).toContainEqual(expect.arrayContaining(['definition', 'steps/a.steps.ts:3']));
    expect(renderHtmlReport(run)).toContain('"gherkin":');
    expect(renderLargeHtmlReport(run)).toContain('<h2 id="bdd-h">Features</h2>');
  });

  it('JUnit: one suite per feature, scenarios as test cases, the feature (and rule) as classname', () => {
    const x = renderJUnit(run);
    expect(x.match(/<testsuite /g)?.length).toBe(3);
    expect(x).toMatch(/<testsuite name="run-1" tests="1" failures="0"/);
    expect(x).toMatch(/<testsuite name="Login" tests="1" failures="0" errors="0" skipped="0"/);
    expect(x).toMatch(/<testsuite name="Billing" tests="2" failures="1" errors="0" skipped="0"/);
    expect(x).toContain('<testcase name="Refund" classname="Billing.Refunds"');
    expect(x).toContain('<testcase name="Invoice" classname="Billing"');
    expect(x).toContain('<testcase name="plain" classname="eztest.plain"');
    expect(x).toContain('<property name="eztest.feature.file" value="features/billing.feature"/>');
    // Without Gherkin scenarios the report keeps its single suite.
    const plain = renderJUnit({ ...run, journeys: [run.journeys[0]] });
    expect(plain.match(/<testsuite /g)?.length).toBe(1);
  });
});
