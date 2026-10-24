import { describe, it, expect } from '../support/testkit.js';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { JourneyStatus, RunResult } from '../../src/core/index.js';
import {
  HistoryStore,
  scoreFlakiness,
  scoreHistory,
  wilsonInterval,
  normalizeMessage,
  topFrames,
  failureSignature,
  weightedJaccard,
  clusterFailures,
  globMatch,
  urlMatches,
  loadRunArtifacts,
  triageRun,
  assertCitations,
  parseReadinessPolicy,
  evaluateReadiness,
  validateReadinessCitations,
  analyzeImpact,
  parseImpactMapping,
  changedFilesFromGit,
} from '../../src/insights/index.js';
import { makeRunFixture } from './fixtures.js';

const S = (s: string): JourneyStatus[] =>
  [...s].map((c) => (c === 'P' ? 'passed' : c === 'H' ? 'passed-healed' : c === 'F' ? 'failed' : 'skipped'));

describe('history store', () => {
  it('records runs, persists atomically and reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-hist-'));
    const path = join(dir, 'nested', 'history.json');
    const fx = await makeRunFixture();
    const store = await HistoryStore.open(path, { maxRuns: 3 });
    store.record(fx.run, { checkout: 'abc123' });
    for (let i = 0; i < 3; i++) store.record({ ...fx.run, runId: `r${i}`, startedAt: `2026-10-2${i + 1}T00:00:00Z` });
    await store.save();
    const again = await HistoryStore.open(path);
    expect(again.runs.length).toBe(3); // retention
    expect(again.journeyIds()).toContain('checkout');
    const outs = again.outcomesFor('checkout');
    expect(outs).toHaveLength(3);
    expect(outs[0].status).toBe('failed');
  });

  it('rejects corrupt files and empty runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-hist-'));
    const p = join(dir, 'h.json');
    await writeFile(p, '{"version":2,"runs":[]}');
    await expect(HistoryStore.open(p)).rejects.toThrow(/unsupported version/);
    await writeFile(p, 'not json');
    await expect(HistoryStore.open(p)).rejects.toThrow(/not valid JSON/);
    const s = await HistoryStore.open(join(dir, 'new.json'));
    const empty = { runId: 'x', startedAt: 'now', finishedAt: 'now', durationMs: 0, journeys: [], summary: { total: 0, passed: 0, passedHealed: 0, failed: 0, skipped: 0, errors: 0 }, environment: {} } as RunResult;
    expect(() => s.record(empty)).toThrow(/no journeys/);
  });
});

describe('flaky scoring', () => {
  it('wilson interval behaves', () => {
    const w = wilsonInterval(5, 10);
    expect(w.low).toBeGreaterThan(0.2);
    expect(w.high).toBeLessThan(0.8);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1, center: 0.5 });
    expect(() => wilsonInterval(3, 2)).toThrow();
  });

  it('labels new / stable / flaky / broken / recovering', () => {
    expect(scoreFlakiness('j', S('PFP')).state).toBe('new');
    expect(scoreFlakiness('j', S('PPPPPPPPPP')).state).toBe('stable');
    const flaky = scoreFlakiness('j', S('PFPPFPFPPFPF'));
    expect(flaky.state).toBe('flaky');
    expect(flaky.flips).toBeGreaterThan(5);
    expect(flaky.quarantine.recommended).toBe(true);
    const broken = scoreFlakiness('j', S('PPPPPFFFF'));
    expect(broken.state).toBe('broken');
    expect(broken.quarantine.recommended).toBe(false);
    expect(scoreFlakiness('j', S('PPPFFFFP')).state).toBe('recovering');
    expect(scoreFlakiness('j', S('PPPFFFFPPP')).state).toBe('stable');
  });

  it('never recommends quarantine below the sample minimum', () => {
    const s = scoreFlakiness('j', S('PFPFPF'), { minSamples: 5, quarantineMinSamples: 10 });
    expect(s.state).toBe('flaky');
    expect(s.quarantine.recommended).toBe(false);
    expect(s.quarantine.reason).toMatch(/6\/10 samples/);
  });

  it('tracks healed passes as a separate signal and ignores skips', () => {
    const s = scoreFlakiness('j', S('PPPPSSHHHH'));
    expect(s.state).toBe('stable');
    expect(s.samples).toBe(8);
    expect(s.healedPasses).toBe(4);
    expect(s.healingDependent).toBe(true);
    expect(s.healedTrendRising).toBe(true);
  });

  it('scores a history store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-hist-'));
    const store = await HistoryStore.open(join(dir, 'h.json'));
    const fx = await makeRunFixture();
    for (let i = 0; i < 6; i++) {
      const journeys = fx.run.journeys.map((j) => (j.journeyId === 'search' ? { ...j, status: (i % 2 ? 'passed' : 'failed') as JourneyStatus } : j));
      store.record({ ...fx.run, journeys, runId: `r${i}`, startedAt: `2026-10-1${i}T00:00:00Z` });
    }
    const scores = scoreHistory(store);
    expect(scores.find((s) => s.journeyId === 'search')!.state).toBe('flaky');
    expect(scores.find((s) => s.journeyId === 'checkout')!.state).toBe('broken');
    expect(scores.find((s) => s.journeyId === 'login')!.state).toBe('stable');
  });
});

describe('failure signatures and clustering', () => {
  it('normalizes incidental values', () => {
    const a = normalizeMessage('Timeout 5000ms waiting for "#btn-123" at https://x.io/a?b=1 order ORD-42 id 9f8e7d6c5b4a3f2e1d0c');
    expect(a).toBe(normalizeMessage('Timeout 3000ms waiting for "#btn-999" at https://y.io/zz order ORD-7 id aaaaaaaaaaaaaaaaaaaa'));
    expect(a).toContain('<duration>');
    expect(a).toContain('<url>');
    expect(() => failureSignature({ message: '  ' })).toThrow();
  });

  it('extracts top frames without line numbers', () => {
    const f = topFrames('Error: x\n    at foo (/a/b/src/x.ts:10:5)\n    at node:internal/process:1:1\n    at /a/b/src/y.ts:3:2');
    expect(f).toEqual(['foo@src/x.ts', '<anonymous>@src/y.ts']);
  });

  it('clusters similar failures with a medoid representative', () => {
    const items = [
      { id: 'a', message: "locator.click: Timeout 5000ms exceeded waiting for getByRole('button', { name: 'Save' })" },
      { id: 'b', message: "locator.click: Timeout 7000ms exceeded waiting for getByRole('button', { name: 'Submit' })" },
      { id: 'c', message: "locator.click: Timeout 3000ms exceeded waiting for getByRole('button', { name: 'Go' })" },
      { id: 'd', message: 'SqliteError: UNIQUE constraint failed: customers.email' },
    ];
    const cl = clusterFailures(items);
    expect(cl).toHaveLength(2);
    expect(cl[0].size).toBe(3);
    expect(cl[0].members.sort()).toEqual(['a', 'b', 'c']);
    expect(['a', 'b', 'c']).toContain(cl[0].representative.id);
    expect(cl[1].members).toEqual(['d']);
    const s1 = failureSignature(items[0]);
    const s2 = failureSignature(items[3]);
    expect(weightedJaccard(s1.tokens, s2.tokens)).toBeLessThan(0.2);
    expect(clusterFailures([])).toEqual([]);
  });
});

describe('glob', () => {
  it('matches paths and urls', () => {
    expect(globMatch('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a/c.ts')).toBe(false);
    expect(globMatch('docs/{a,b}.md', 'docs/b.md')).toBe(true);
    expect(urlMatches('127.0.0.1:4600/api/**', 'http://127.0.0.1:4600/api/orders')).toBe(true);
    expect(urlMatches('*.example.com', 'https://reports.example.com/x')).toBe(true);
    expect(urlMatches('*.example.com', 'https://example.org/x')).toBe(false);
  });
});

describe('triage', () => {
  it('classifies each failed journey with cited, existing evidence', async () => {
    const fx = await makeRunFixture();
    const art = await loadRunArtifacts(fx.runDir);
    expect(art.networkLogs).toHaveLength(1);
    expect(art.warnings).toEqual([]);
    const report = triageRun({ ...art, ownership: { owned: ['127.0.0.1:4600/**'] } });
    assertCitations(report, art.evidence);
    const by = Object.fromEntries(report.verdicts.map((v) => [v.journeyId, v]));
    expect(Object.keys(by).sort()).toEqual(['checkout', 'data-import', 'reports', 'search']);

    expect(by.checkout.category).toBe('product-bug');
    expect(by.checkout.evidence).toContain(fx.ids['checkout.net']);
    expect(by.checkout.status).toBe('decided');
    expect(by.checkout.reasons[0]).not.toContain('SECRET123'); // query strings never echoed

    expect(by.search.category).toBe('test-issue');
    expect(by.search.winner!.rule).toBe('heal-unverified');
    expect(by.search.evidence).not.toContain('E-999'); // non-existent id from the heal record is dropped

    expect(by.reports.category).toBe('environment');
    expect(by['data-import'].category).toBe('data');
    expect(report.counts['product-bug']).toBe(1);
    expect(report.clusters.length).toBeGreaterThan(0);
  });

  it('5xx on an external endpoint is environmental; without ownership it is low-confidence', async () => {
    const fx = await makeRunFixture();
    const art = await loadRunArtifacts(fx.runDir);
    const ext = triageRun({ ...art, ownership: { owned: ['api.mycorp.com/**'] } });
    const v = ext.verdicts.find((x) => x.journeyId === 'checkout')!;
    // network says environment (0.85), execution says product-bug (0.75): families disagree closely
    expect(v.category).toBe('environment');
    expect(v.status).toBe('needs-human');
    expect(v.secondOpinion!.category).toBe('product-bug');
  });

  it('history flaky signal yields flaky or needs-human', async () => {
    const fx = await makeRunFixture();
    const art = await loadRunArtifacts(fx.runDir);
    const flaky = [scoreFlakiness('data-import', S('PFPFPFPFPF'))];
    const r = triageRun({ ...art, flaky });
    const v = r.verdicts.find((x) => x.journeyId === 'data-import')!;
    expect(v.candidates.some((c) => c.category === 'flaky')).toBe(true);
    expect(v.status).toBe('needs-human');
  });

  it('"no such table" (the database lacks the schema: wrong file or connection, missing seed) is an environment issue, not unknown', async () => {
    const fx = await makeRunFixture();
    const art = await loadRunArtifacts(fx.runDir);
    const messages = ['SqliteError: no such table: orders', 'no such column: o.created_by', 'relation "orders" does not exist', 'ORA-00942: table or view does not exist', "Invalid object name 'dbo.Orders'.",
      'column "created_by" does not exist (SQLSTATE 42703)', 'column "x" of relation "orders" does not exist', 'ORA-00904: "CREATED_BY": invalid identifier', "Invalid column name 'created_by'."];
    for (const msg of messages) {
      const run = structuredClone(art.run);
      const j = run.journeys.find((x) => x.journeyId === 'data-import')!;
      const failed = j.steps.find((s) => s.status === 'failed' || s.status === 'blocked')!;
      failed.error = { message: `Query failed on connection "shop": ${msg}`, name: 'Error' };
      if (j.error) j.error = { message: msg, name: 'Error' };
      const v = triageRun({ ...art, run }).verdicts.find((x) => x.journeyId === 'data-import')!;
      expect(v.category, msg).toBe('environment');
      expect(v.winner!.rule, msg).toBe('db-schema-missing');
      expect(v.reasons[0], msg).toMatch(/database lacks a table or column/);
    }
  });

  it('a verdict without valid evidence is never "decided"', async () => {
    const fx = await makeRunFixture();
    const r = triageRun({ run: fx.run, evidence: [] });
    for (const v of r.verdicts) {
      expect(v.status).toBe('needs-human');
      expect(v.evidence).toEqual([]);
    }
    expect(() => triageRun({ run: { ...fx.run, journeys: [] }, evidence: [] })).toThrow(/no journeys/);
    expect(() => assertCitations({ ...r, verdicts: [{ ...r.verdicts[0], evidence: ['E-404'] }] }, fx.evidence)).toThrow(/unknown evidence/);
  });
});

const POLICY = `
version: 1
gates:
  noFailedCriticalJourneys: { minRisk: 5 }
  maxHealedRatio: 0.5
  minPassRate: { min: 0.5 }
  noOpenProductBugs: true
  a11yNoCritical: true
  requirementsCovered: { requirements: [REQ-1, REQ-2, REQ-9] }
scoring: { goMinScore: 80, noGoBelowScore: 20 }
`;

describe('release readiness', () => {
  it('produces NO_GO with cited reasons for the fixture run', async () => {
    const fx = await makeRunFixture();
    const art = await loadRunArtifacts(fx.runDir);
    const triage = triageRun({ ...art, ownership: { owned: ['127.0.0.1:4600/**'] } });
    const res = evaluateReadiness(POLICY, {
      run: fx.run,
      evidence: art.evidence,
      triage,
      a11y: [{ ruleId: 'label', impact: 'critical', journeyId: 'login', evidence: [fx.ids['login.s1']] }],
      now: new Date('2026-10-22T00:00:00Z'),
    });
    expect(res.decision).toBe('NO_GO');
    const g = Object.fromEntries(res.gates.map((x) => [x.gate, x]));
    expect(g.noFailedCriticalJourneys.status).toBe('fail');
    expect(g.noFailedCriticalJourneys.cites.journeys).toEqual(['checkout']);
    expect(g.noFailedCriticalJourneys.cites.evidence).toContain(fx.ids['checkout.s2']);
    expect(g.requirementsCovered.status).toBe('fail');
    expect(g.requirementsCovered.cites.requirements).toEqual(['REQ-9']);
    expect(g.noOpenProductBugs.status).toBe('fail');
    expect(g.a11yNoCritical.status).toBe('fail');
    for (const r of res.rationale.filter((x) => x.kind === 'violation')) {
      expect(r.cites.evidence.length + r.cites.journeys.length + r.cites.requirements.length).toBeGreaterThan(0);
    }
    expect(() => validateReadinessCitations(res, { run: fx.run, evidence: art.evidence })).not.toThrow();
    const tampered = structuredClone(res);
    tampered.rationale[1].cites.evidence.push('E-12345');
    expect(() => validateReadinessCitations(tampered, { run: fx.run, evidence: art.evidence })).toThrow(/unknown evidence/);
  });

  it('GO on a clean run, GO_WITH_RISKS with an approved waiver, and records exceptions', async () => {
    const fx = await makeRunFixture();
    const clean = { ...fx.run, journeys: fx.run.journeys.filter((j) => ['login', 'create-order'].includes(j.journeyId)) };
    const pol = `
gates:
  noFailedCriticalJourneys: true
  minPassRate: 0.9
  maxHealedRatio: 0.6
`;
    const go = evaluateReadiness(pol, { run: clean, evidence: fx.evidence });
    // (5 + 4 * 0.8) / 9 = 91.1: healed passes earn partial credit
    expect(go.score).toBeCloseTo(91.1, 1);
    expect(go.decision).toBe('GO');
    const go2 = evaluateReadiness(pol + 'scoring: { goMinScore: 95 }\n', { run: clean, evidence: fx.evidence });
    expect(go2.decision).toBe('GO_WITH_RISKS');

    const strict = `
gates:
  maxHealedRatio: 0.1
exceptions:
  - gate: maxHealedRatio
    approver: Jane Release-Manager
    reason: heal reviewed and accepted
    expires: 2027-01-01
  - gate: maxHealedRatio
    approver: Old Approver
    reason: stale
    expires: 2020-01-01
`;
    const w = evaluateReadiness(strict, { run: clean, evidence: fx.evidence, now: new Date('2026-10-22T00:00:00Z') });
    expect(w.gates[0].status).toBe('waived');
    expect(w.decision).toBe('GO_WITH_RISKS');
    expect(w.exceptionsApplied).toHaveLength(1);
    expect(w.exceptionsApplied[0].approver).toBe('Jane Release-Manager');
    expect(w.exceptionsIgnored[0].why).toMatch(/expired/);
  });

  it('rejects bad policies and treats missing inputs as no-data, never as pass', async () => {
    expect(() => parseReadinessPolicy('gates: { minPassRate: 0.9 }\nexceptions: [{ gate: minPassRate, approver: "", reason: x }]')).toThrow(/approver/);
    expect(() => parseReadinessPolicy('gates: { madeUpGate: true }')).toThrow(/Invalid readiness policy/);
    expect(() => parseReadinessPolicy('gates: {}')).toThrow(/no gates/);
    const fx = await makeRunFixture();
    const clean = { ...fx.run, journeys: fx.run.journeys.filter((j) => j.journeyId === 'login') };
    const r = evaluateReadiness('gates: { perfBudgets: true, docsReconciled: true, noOpenProductBugs: true }', { run: clean, evidence: fx.evidence });
    expect(r.gates.every((g) => g.status === 'no-data')).toBe(true);
    expect(r.decision).toBe('NO_GO'); // noOpenProductBugs is a blocker with no data
    const empty = evaluateReadiness('gates: { minPassRate: 0.5 }', { run: { ...fx.run, journeys: [] }, evidence: [] });
    expect(empty.decision).toBe('NO_GO');
    expect(() => evaluateReadiness('gates: { perfBudgets: true }', { run: clean, evidence: fx.evidence, perf: [{ metric: 'LCP', status: 'pass' }] })).toThrow(/cite/);
  });
});

describe('impact analysis', () => {
  const journeys = [
    { id: 'login', tags: ['@auth'], requirements: ['REQ-1'], risk: 5 },
    { id: 'create-order', tags: ['@orders'], requirements: ['REQ-2'], risk: 4 },
    { id: 'checkout', tags: ['@orders'], requirements: ['REQ-3'], risk: 5 },
    { id: 'search', tags: ['@search'], requirements: [], risk: 2 },
  ];
  const mapping = parseImpactMapping(`
mappings:
  - name: orders
    paths: ["src/orders/**", "api/orders.ts"]
    tags: ["@orders"]
  - name: auth
    paths: ["src/auth/**"]
    journeys: [login]
  - name: billing
    paths: ["src/billing/**"]
    requirements: [REQ-3]
  - name: legacy
    paths: ["src/legacy/**"]
    tags: ["@nobody"]
ignore: ["**/*.md"]
`);

  it('orders impacted journeys and reports uncovered areas', () => {
    const r = analyzeImpact(['src/orders/form.ts', 'src/billing/tax.ts', 'src/legacy/x.ts', 'src/unknown/y.ts', 'README.md'], journeys, mapping);
    expect(r.impacted.map((i) => i.journeyId)).toEqual(['checkout', 'create-order']);
    expect(r.impacted[0].via.map((v) => v.match).sort()).toEqual(['requirement', 'tag']);
    expect(r.ignoredFiles).toEqual(['README.md']);
    expect(r.uncovered).toEqual([
      { file: 'src/legacy/x.ts', reason: 'mapping-selects-no-journey', mappings: ['legacy'] },
      { file: 'src/unknown/y.ts', reason: 'no-mapping' },
    ]);
    expect(() => analyzeImpact([], journeys, mapping)).toThrow(/no changed files/);
  });

  it('reads changed files from git without a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-git-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@e.st');
    git('config', 'user.name', 'T');
    await mkdir(join(dir, 'src/auth'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), '1');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'feature');
    await writeFile(join(dir, 'src/auth/login.ts'), 'x');
    git('add', '.');
    git('commit', '-qm', 'change');
    const files = await changedFilesFromGit({ cwd: dir, base: 'main' });
    expect(files).toEqual(['src/auth/login.ts']);
    expect(analyzeImpact(files, journeys, mapping).impacted[0].journeyId).toBe('login');
    expect(() => changedFilesFromGit({ cwd: dir, base: '--output=/tmp/x' })).toThrow(/Unsafe/);
    expect(() => changedFilesFromGit({ cwd: dir, base: 'main; rm -rf /' })).toThrow(/Unsafe/);
    await expect(changedFilesFromGit({ cwd: dir, base: 'nope-branch' })).rejects.toThrow(/compares with "nope-branch", which this clone does not have: check the name, or fetch it first/);
    // No origin/main (a fresh clone of one branch, a shallow CI checkout): say how to fetch it, not git's text.
    await expect(changedFilesFromGit({ cwd: dir, base: 'origin/main' })).rejects.toThrow(/"origin\/main", which this clone does not have: fetch it first \(git fetch origin main; in CI check out with full history, e\.g\. fetch-depth: 0\)/);
    // Outside a git repository (git diff would print its --no-index usage text).
    const plain = await mkdtemp(join(tmpdir(), 'ez-nogit-'));
    const outside = changedFilesFromGit({ cwd: plain, base: 'origin/main' });
    await expect(outside).rejects.toThrow(/needs a git repository, and .* is not inside one/);
    await expect(outside).rejects.not.toThrow(/usage: git diff/);
    void readFile;
  });
});
