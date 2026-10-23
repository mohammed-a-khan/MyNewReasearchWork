/**
 * Quarantine (exit codes, readiness, expiry), triage overrides, and the
 * traceability computation, CSV parsing and export.
 */
import { describe, expect, it } from '../support/testkit.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JourneyResult, RunResult } from '../../src/core/index.js';
import { summarize } from '../../src/core/index.js';
import {
  addTriageOverride,
  applyTriageOverrides,
  computeTraceability,
  evaluateReadiness,
  exitCodeWithQuarantine,
  loadQuarantine,
  parseRequirementsCsv,
  quarantineStatus,
  saveQuarantine,
  traceabilityToCsv,
  validateQuarantineEntry,
  type TriageReport,
  type TriageOverridesFile,
} from '../../src/insights/index.js';
import { exitCodeFor } from '../../src/cli/program.js';
import { tempDir } from '../runner/fixtures.js';

function jr(id: string, status: JourneyResult['status'], risk = 3, extra: Partial<JourneyResult> = {}): JourneyResult {
  return {
    journeyId: id, name: id, status, startedAt: '2026-10-01T00:00:00Z', durationMs: 100, tags: [], requirements: [], risk, attempt: 1, ledger: {}, evidence: ['E-1'],
    steps: [{ stepId: 's1', intent: 'Do it', status: status === 'passed-healed' ? 'passed-healed' : status === 'failed' ? 'failed' : 'passed', startedAt: '', durationMs: 10, conditions: [], evidence: ['E-1'], ...(status === 'failed' ? { error: { message: 'boom' } } : {}) }],
    ...extra,
  };
}

function run(journeys: JourneyResult[]): RunResult {
  return { runId: 'run-1', startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z', durationMs: 60_000, journeys, summary: summarize(journeys), environment: {} };
}

const evidence = [{ id: 'E-1', kind: 'screenshot' as const, path: 'a.png', sha256: 'x', createdAt: '' }];
const policy = `version: 1
gates:
  minPassRate: { min: 1 }
  noFailedCriticalJourneys: { minRisk: 4 }
`;

describe('quarantine', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const file = {
    version: 1 as const,
    entries: [
      { journeyId: 'flaky', reason: 'timeouts', owner: 'Ann', expires: '2026-10-12', createdAt: '' },
      { journeyId: 'old', reason: 'x', owner: 'Bo', expires: '2026-10-01', createdAt: '' },
      { journeyId: 'later', reason: 'y', owner: 'Cy', expires: '2026-12-31', createdAt: '' },
    ],
  };

  it('splits active, expired and expiring-soon entries with warnings', () => {
    const s = quarantineStatus(file, now);
    expect(s.active.map((e) => e.journeyId)).toEqual(['flaky', 'later']);
    expect(s.expired.map((e) => e.journeyId)).toEqual(['old']);
    expect(s.expiringSoon.map((e) => e.journeyId)).toEqual(['flaky']);
    expect(s.warnings.join('\n')).toMatch(/old .*expired on 2026-10-01; its failures count again/);
    expect(s.warnings.join('\n')).toMatch(/flaky .*expires on 2026-10-12/);
    // A bare date runs to the end of that day.
    expect(quarantineStatus(file, new Date('2026-10-12T23:00:00Z')).active.map((e) => e.journeyId)).toContain('flaky');
  });

  it('validates entries and round-trips the file', async () => {
    expect(validateQuarantineEntry({ journeyId: 'a' })).toEqual(['a reason is required', 'an owner is required', 'expires must be a date (YYYY-MM-DD)']);
    const dir = await tempDir('quar');
    const p = join(dir, '.eztest', 'quarantine.json');
    expect((await loadQuarantine(p)).entries).toEqual([]);
    await saveQuarantine(p, file);
    expect((await loadQuarantine(p)).entries).toHaveLength(3);
    await writeFile(p, JSON.stringify({ version: 1, entries: [{ journeyId: 'x' }] }));
    await expect(loadQuarantine(p)).rejects.toThrow(/reason is required/);
  });

  it('exit code ignores failures of quarantined journeys only', () => {
    const r = run([jr('ok', 'passed'), jr('flaky', 'failed')]);
    expect(exitCodeWithQuarantine(r)).toBe(1);
    expect(exitCodeWithQuarantine(r, ['flaky'])).toBe(0);
    expect(exitCodeFor(r, ['flaky'])).toBe(0);
    expect(exitCodeFor(r)).toBe(1);
    expect(exitCodeWithQuarantine(run([jr('ok', 'failed'), jr('flaky', 'failed')]), ['flaky'])).toBe(1);
    expect(exitCodeWithQuarantine(run([jr('flaky', 'error')]), ['flaky'])).toBe(0);
  });

  it('readiness does not count quarantined failures (and says so, with citations)', () => {
    const r = run([jr('ok', 'passed', 5), jr('flaky', 'failed', 5)]);
    const blocked = evaluateReadiness(policy, { run: r, evidence });
    expect(blocked.decision).toBe('NO_GO');
    const q = evaluateReadiness(policy, { run: r, evidence, quarantined: ['flaky'] });
    expect(q.decision).toBe('GO');
    expect(q.quarantineIgnored).toEqual(['flaky']);
    expect(q.rationale.some((x) => x.kind === 'info' && /1 quarantined journey failure\(s\) not counted: flaky/.test(x.text) && x.cites.journeys.includes('flaky'))).toBe(true);
    // A run made only of quarantined failures: no decision basis (NO_GO), but still a valid, cited result.
    const only = evaluateReadiness(policy, { run: run([jr('flaky', 'failed', 5)]), evidence, quarantined: ['flaky'] });
    expect(only.decision).toBe('NO_GO');
    expect(only.quarantineIgnored).toEqual(['flaky']);
    // A passing quarantined journey still counts normally.
    expect(evaluateReadiness(policy, { run: run([jr('ok', 'passed', 5), jr('flaky', 'passed', 5)]), evidence, quarantined: ['flaky'] }).quarantineIgnored).toBeUndefined();
  });

  it('readiness ignores triage product bugs of quarantined journeys', () => {
    const r = run([jr('ok', 'passed'), jr('flaky', 'failed')]);
    const triage: TriageReport = { runId: 'run-1', verdicts: [{ journeyId: 'flaky', journeyName: 'flaky', category: 'product-bug', confidence: 0.8, status: 'decided', reasons: ['x'], evidence: ['E-1'], candidates: [] }], clusters: [], counts: { 'product-bug': 1, 'test-issue': 0, environment: 0, data: 0, flaky: 0, unknown: 0 }, needsHuman: 0 };
    const p = 'version: 1\ngates:\n  noOpenProductBugs: true\n';
    expect(evaluateReadiness(p, { run: r, evidence, triage }).decision).toBe('NO_GO');
    expect(evaluateReadiness(p, { run: r, evidence, triage, quarantined: ['flaky'] }).gates[0].status).toBe('pass');
  });
});

describe('triage overrides', () => {
  const report = { runId: 'run-2', verdicts: [{ journeyId: 'a', journeyName: 'a', category: 'product-bug' as const, confidence: 0.7, status: 'decided' as const, reasons: [], evidence: [], signature: 'sig1', candidates: [] }] };
  it('applies an own override and inherits by signature from earlier runs only', () => {
    let f: TriageOverridesFile = { version: 1, overrides: [] };
    f = addTriageOverride(f, { runId: 'run-1', journeyId: 'a', signature: 'sig1', from: 'product-bug', to: 'environment', reason: 'db restore', by: 'Ann', at: '2026-10-01T00:00:00Z' });
    const starts: Record<string, string> = { 'run-1': '2026-10-01', 'run-2': '2026-10-02', 'run-0': '2026-09-01' };
    const v = applyTriageOverrides(report, f, (id) => starts[id]);
    expect(v[0]).toMatchObject({ category: 'environment', ruleCategory: 'product-bug', override: { inherited: true, by: 'Ann' } });
    // Not inherited backwards in time.
    expect(applyTriageOverrides({ ...report, runId: 'run-0' }, f, (id) => starts[id])[0].override).toBeUndefined();
    f = addTriageOverride(f, { runId: 'run-2', journeyId: 'a', from: 'product-bug', to: 'data', reason: 'seed', by: 'Bo', at: '2026-10-02T00:00:00Z' });
    expect(applyTriageOverrides(report, f)[0]).toMatchObject({ category: 'data', override: { inherited: false } });
    expect(() => addTriageOverride(f, { runId: 'r', journeyId: 'a', from: 'data', to: 'data', reason: ' ', by: 'x', at: '' })).toThrow(/reason/);
  });
});

describe('traceability', () => {
  const journeys = [
    { id: 'login', name: 'Login', requirements: ['AUTH-1'] },
    { id: 'order', name: 'Order', requirements: ['ORD-1', 'ORD-7'] },
    { id: 'order-alt', name: 'Order alt', requirements: ['ORD-7'] },
    { id: 'export', name: 'Export', requirements: ['EXP-1'] },
    { id: 'heal', name: 'Healed', requirements: ['UX-1'] },
    { id: 'misc', name: 'Misc', requirements: [] },
  ];
  const latest = {
    login: { status: 'passed' as const, runId: 'r1' },
    order: { status: 'failed' as const, runId: 'r1' },
    'order-alt': { status: 'passed' as const, runId: 'r1' },
    export: { status: 'failed' as const, runId: 'r1' },
    heal: { status: 'passed-healed' as const, runId: 'r1' },
  };

  it('computes coverage per requirement, gaps, untraced journeys and unknown ids', () => {
    const m = computeTraceability({ journeys, latest, quarantined: ['export'], requirements: [{ id: 'AUTH-1', title: 'Sign in' }, { id: 'ORD-1' }, { id: 'ORD-7' }, { id: 'PAY-9', title: 'Refunds' }, { id: 'EXP-1' }] });
    const by = Object.fromEntries(m.rows.map((r) => [r.requirement.id, r]));
    expect(by['AUTH-1'].coverage).toBe('covered-passing');
    expect(by['AUTH-1'].requirement.title).toBe('Sign in');
    expect(by['ORD-1'].coverage).toBe('covered-failing');
    expect(by['ORD-7'].coverage).toBe('covered-passing'); // one failing, one passing journey
    expect(by['ORD-7'].journeys.map((c) => c.journeyId)).toEqual(['order-alt', 'order']); // passing first
    expect(by['PAY-9']).toMatchObject({ coverage: 'uncovered', gap: 'no journey traces to this requirement' });
    expect(by['EXP-1'].coverage).toBe('covered-quarantined');
    expect(by['UX-1'].coverage).toBe('covered-healed');
    expect(m.unknownRequirements).toEqual(['UX-1']);
    expect(m.untracedJourneys).toEqual(['misc']);
    expect(m.totals).toMatchObject({ requirements: 6, gaps: 3, uncovered: 1, 'covered-failing': 1, 'covered-quarantined': 1 });
    expect(m.totals.coveragePct).toBeCloseTo(3 / 6);
  });

  it('marks not-run journeys and works without a requirements list', () => {
    const m = computeTraceability({ journeys: [{ id: 'new', name: 'New', requirements: ['N-1'] }], latest: {} });
    expect(m.rows[0]).toMatchObject({ coverage: 'not-run', journeys: [{ status: 'not-run' }] });
    expect(m.unknownRequirements).toEqual([]);
  });

  it('parses requirement CSVs with or without a header, quoted fields and BOM', () => {
    expect(parseRequirementsCsv('﻿ID,Title,State\nAUTH-1,"Sign in, with MFA",Active\nORD-1,Orders,New\nAUTH-1,dup,x\n')).toEqual([
      { id: 'AUTH-1', title: 'Sign in, with MFA', state: 'Active', source: 'csv' },
      { id: 'ORD-1', title: 'Orders', state: 'New', source: 'csv' },
    ]);
    expect(parseRequirementsCsv('R-1;First\nR-2;Second')).toEqual([
      { id: 'R-1', title: 'First', source: 'csv' },
      { id: 'R-2', title: 'Second', source: 'csv' },
    ]);
    expect(parseRequirementsCsv('Work Item ID\tSummary\n42\t"He said ""hi"""')).toEqual([{ id: '42', title: 'He said "hi"', source: 'csv' }]);
  });

  it('exports one CSV row per requirement x journey', () => {
    const m = computeTraceability({ journeys, latest, requirements: [{ id: 'PAY-9', title: 'Refunds, partial' }] });
    const csv = traceabilityToCsv(m).split('\r\n');
    expect(csv[0]).toBe('Requirement,Title,Coverage,Journey,Journey name,Latest status,Quarantined,Run,Gap');
    expect(csv).toContain('PAY-9,"Refunds, partial",uncovered,,,,,,no journey traces to this requirement');
    expect(csv.filter((l) => l.startsWith('ORD-7,'))).toHaveLength(2);
  });
});
