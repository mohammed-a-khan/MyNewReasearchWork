import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { coverageEquivalence, importFiles, importGherkin, mergeReports, verifyImported, writeImported } from '../../src/importers/index.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAST = { stepTimeoutMs: 5000, locateTimeoutMs: 1500, conditionTimeoutMs: 3000 } as const;

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp({ variant: 'a' });
});
afterAll(async () => {
  await server.close();
});

describe('replay-verified conversion against the demo app (real Chromium)', () => {
  it('imports a Playwright spec and a Gherkin feature (bob logs in, creates an order) and every converted step passes', async () => {
    const report = await importFiles([join(FIX, 'bob-order.spec.js'), join(FIX, 'bob-order.feature')]);
    expect(report.journeys.map((j) => j.id)).toEqual([
      'ez-shop-orders-bob-creates-an-order',
      'ez-shop-orders-bob-orders-2-x-gadget-49-50',
      'ez-shop-orders-bob-orders-3-x-widget-19-99',
      'ez-shop-orders-sign-in-page-lists-credentials-fields',
    ]);
    // Nothing is verified until it runs.
    expect(report.converted.every((c) => c.verified === false)).toBe(true);
    expect(coverageEquivalence(report).journeys.every((j) => j.status === 'not-run')).toBe(true);

    const out = await mkdtemp(join(tmpdir(), 'eztest-import-replay-'));
    const v = await verifyImported(report, { ...FAST, baseUrl: server.url, outputDir: out, concurrency: 2 });
    for (const j of v.journeys) {
      expect(j.steps.map((s) => `${s.stepId}:${s.status}:${s.error ?? ''}`), j.name).toEqual(j.steps.map((s) => `${s.stepId}:passed:`));
      expect(j.verified).toBe(true);
    }
    expect(v.summary).toMatchObject({ journeys: 4, verifiedJourneys: 4, failedSteps: 0 });
    expect(v.summary.passedSteps).toBe(v.summary.steps);

    const pw = v.journeys.find((j) => j.journeyId === 'ez-shop-orders-bob-creates-an-order')!;
    expect(pw.steps.length).toBeGreaterThanOrEqual(10);
    const submit = pw.steps.find((s) => s.intent === 'Click the "Submit order" button')!;
    expect(submit).toMatchObject({ status: 'passed', conditions: 3, conditionsPassed: 3 });

    const eq = coverageEquivalence(report, v);
    const byId = new Map(eq.journeys.map((j) => [j.id, j]));
    // Converted with TODOs left over -> verified but partial; never "equivalent".
    expect(byId.get('ez-shop-orders-bob-creates-an-order')!.status).toBe('verified-partial');
    expect(byId.get('ez-shop-orders-bob-orders-2-x-gadget-49-50')!.status).toBe('verified-partial');
    expect(eq.totals.verifiedSteps).toBe(eq.totals.convertedSteps);
    expect(eq.totals.verifiedAssertions).toBe(eq.totals.convertedAssertions);
    expect(eq.ratios.verified).toBeCloseTo(eq.ratios.converted, 5);
    expect(eq.ratios.converted).toBeLessThan(1);
    expect(eq.needsWork.some((n) => n.includes('TODO'))).toBe(true);

    const written = await writeImported(report, join(out, 'journeys'), v);
    const md = await readFile(written.reportMd, 'utf8');
    expect(md).toContain('Verified by replay');
    expect(md).toContain('verified-partial');
    const json = JSON.parse(await readFile(written.reportJson, 'utf8'));
    expect(json.journeys.every((j: { verified: boolean }) => j.verified)).toBe(true);
    expect(json.verification.summary.verifiedJourneys).toBe(4);
  });

  it('a conversion whose behaviour differs from the app is reported as failed, never verified', async () => {
    const ok = importGherkin(
      `Feature: Clean\n  Scenario: Bob signs in\n    Given I open /login\n    When I type "bob" into the Username field\n    And I type "Builder#2" into the Password field\n    And I click the "Sign in" button\n    Then the URL contains "/dashboard"\n`,
      { file: 'clean.feature' },
    );
    const bad = importGherkin(
      `Feature: Wrong\n  Scenario: Bob expects a rejection\n    Given I open /login\n    When I type "bob" into the Username field\n    And I type "Builder#2" into the Password field\n    And I click the "Sign in" button\n    Then I should see "Access denied"\n`,
      { file: 'wrong.feature' },
    );
    const report = mergeReports([ok, bad]);
    const out = await mkdtemp(join(tmpdir(), 'eztest-import-replay-bad-'));
    const v = await verifyImported(report.journeys, { ...FAST, baseUrl: server.url, outputDir: out, concurrency: 2 });
    const eq = coverageEquivalence(report, v);
    const st = Object.fromEntries(eq.journeys.map((j) => [j.id, j.status]));
    expect(st).toEqual({ 'clean-bob-signs-in': 'equivalent', 'wrong-bob-expects-a-rejection': 'failed' });
    const wrong = v.journeys.find((j) => j.journeyId === 'wrong-bob-expects-a-rejection')!;
    expect(wrong.verified).toBe(false);
    expect(wrong.steps.find((s) => s.status === 'failed')!.error).toMatch(/Access denied/);
    expect(eq.needsWork.join('\n')).toMatch(/Bob expects a rejection.*replay failed/);
  });
});
