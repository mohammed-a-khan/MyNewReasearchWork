/**
 * After-run analysis pipeline: history -> flaky scores -> triage -> readiness
 * -> reports. Used by `eztest run` and `eztest analyze <runDir>`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRunArtifacts, HistoryStore, scoreHistory, failureSignature, triageRun, loadReadinessPolicy, evaluateReadiness, loadQuarantine, quarantineStatus, readinessByBrowser } from '../insights/index.js';
import type { FlakyScore, TriageReport, ReadinessResult, QuarantineStatus } from '../insights/index.js';
import { writeReports, type ReportFormat } from '../report/index.js';
import { contractReadinessInputs } from '../contracts/readiness.js';
import { a11yReadinessInputs } from '../a11y/readiness.js';
import { docsReadinessInputs } from '../docs/readiness.js';
import { loadReadinessInputs } from '../load/readiness.js';
import { apiSecurityReadinessInput } from '../lenses/security-api.js';
import { failureTags, type JourneyFailureTags, type UiCoverageGateInput } from '../insights/index.js';
import { recordUiCoverage, a11yIssuesOfRun, a11yTrend, type UiCoverageOptions, type UiCoverageReport, type A11yScope } from '../analytics/index.js';
import type { Journey } from '../core/index.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AnalyzeOptions {
  /** History file shared across runs (default <outputDir>/../.eztest/history.json). */
  historyPath?: string;
  /** Record this run into history (default true). */
  recordHistory?: boolean;
  /** Readiness policy YAML; when absent no readiness decision is made. */
  readinessPolicyPath?: string;
  formats?: ReportFormat[];
  title?: string;
  /** Quarantine file (default <outputDir>/../.eztest/quarantine.json). Quarantined failures do not block readiness. */
  quarantinePath?: string;
  /** Score flakiness from this branch's runs only (vcs.branchScope.history). */
  historyBranch?: string;
  /** Journey definitions of the run (assertion targets for the UI coverage map). */
  journeys?: Journey[];
  /** UI coverage map options (config coverage.ui), or false to skip it. Recorded only when the run has DOM snapshots. */
  uiCoverage?: UiCoverageOptions | false;
  /** Accessibility scopes (config accessibility.scopes) for the new-issue comparison. */
  a11yScopes?: A11yScope[];
}

export interface AnalyzeResult {
  runDir: string;
  triage: TriageReport;
  flaky: FlakyScore[];
  readiness?: ReadinessResult;
  reports: Partial<Record<ReportFormat, string>>;
  warnings: string[];
  /** Quarantine in force for this analysis, and the journeys whose failures it excused. */
  quarantine: QuarantineStatus & { ignoredFailures: string[] };
  /** UI coverage map of the run (when it recorded DOM snapshots). */
  uiCoverage?: UiCoverageReport;
  /** New-failure / always-failing / regressed / flaky tags of the run's failing journeys. */
  failureTags: JourneyFailureTags[];
}

export async function analyzeRun(runDir: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const artifacts = await loadRunArtifacts(runDir);
  const { run, evidence, networkLogs } = artifacts;
  const warnings = [...artifacts.warnings];

  const historyPath = opts.historyPath ?? resolve(runDir, '..', '..', '.eztest', 'history.json');
  const store = await HistoryStore.open(historyPath);
  if (opts.recordHistory !== false && run.journeys.length > 0) {
    const signatures: Record<string, string> = {};
    for (const j of run.journeys) {
      const failed = j.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
      const err = failed?.error ?? j.error;
      if (err) signatures[j.journeyId] = failureSignature({ message: err.message, stack: err.stack, name: err.name }).hash;
    }
    store.record(run, signatures);
    await store.save();
  }
  const scoped = opts.historyBranch ? store.forBranch(opts.historyBranch) : store;
  const flaky = scoped.journeyIds().length ? scoreHistory(scoped) : [];
  const triage = triageRun({ run, evidence, networkLogs, flaky });

  const qPath = opts.quarantinePath ?? resolve(runDir, '..', '..', '.eztest', 'quarantine.json');
  let qStatus: QuarantineStatus = { active: [], expired: [], expiringSoon: [], warnings: [] };
  try {
    qStatus = quarantineStatus(await loadQuarantine(qPath));
  } catch (e) {
    warnings.push((e as Error).message);
  }
  warnings.push(...qStatus.warnings);
  const quarantined = qStatus.active.map((q) => q.journeyId);
  const ignoredFailures = run.journeys.filter((j) => quarantined.includes(j.journeyId) && (j.status === 'failed' || j.status === 'error')).map((j) => j.journeyId);

  // API coverage (api.spec) and contract results recorded for this run feed the report and the contract gates.
  const contractInputs = await contractReadinessInputs(runDir, evidence);
  // EZTest Load results recorded in this run (or the run is a load run directory): the "load" gate.
  const loadInputs = await loadReadinessInputs(runDir, evidence);
  const apiSecurity = await apiSecurityReadinessInput(runDir, evidence);
  // Smart failure tags from history (the run is recorded above).
  const tags = failureTags(store.runs, run.runId);
  // UI coverage map from the run's DOM snapshots (time-travel traces), recorded as evidence.
  let ui: { report: UiCoverageReport; evidenceId?: string } | undefined;
  if (opts.uiCoverage !== false && existsSync(join(runDir, 'trace'))) {
    try {
      ui = await recordUiCoverage(runDir, run.runId, opts.journeys ?? [], opts.uiCoverage || {});
    } catch (e) {
      warnings.push(`UI coverage not recorded: ${(e as Error).message}`);
    }
  }
  const evidenceNow = ui?.evidenceId ? [...evidence, ...(await loadRunArtifacts(runDir)).evidence.filter((e) => e.id === ui!.evidenceId)] : evidence;
  const uiInput: UiCoverageGateInput | undefined = ui
    ? { percent: ui.report.totals.percent, tested: ui.report.totals.tested, total: ui.report.totals.elements, pages: ui.report.pages.map((p) => ({ route: p.route, percent: p.percent, tested: p.tested, total: p.total, journeys: p.journeys })), evidence: ui.evidenceId ? [ui.evidenceId] : [] }
    : undefined;
  // New accessibility issues against the previous run (in the same output directory) that scanned.
  let a11yNew: Array<{ ruleId: string; route: string; target: string; journeys: string[]; evidence: string[] }> | undefined;
  try {
    const now = await a11yIssuesOfRun(runDir, run.runId, opts.a11yScopes ?? [], { evidence });
    if (now.scannedSteps) {
      const out = resolve(runDir, '..');
      const prev = (await readdir(out)).filter((n) => n !== run.runId && existsSync(join(out, n, 'run.json'))).sort().reverse();
      for (const p of prev.slice(0, 20)) {
        const before = await a11yIssuesOfRun(join(out, p), p, opts.a11yScopes ?? []);
        if (!before.scannedSteps) continue;
        const t = a11yTrend([before, now]);
        a11yNew = (t.latest?.new ?? []).map((i) => ({ ruleId: i.ruleId, route: i.route, target: i.target, journeys: i.journeys, evidence: i.evidence }));
        break;
      }
    }
  } catch (e) {
    warnings.push(`accessibility trend not computed: ${(e as Error).message}`);
  }
  let readiness: ReadinessResult | undefined;
  if (opts.readinessPolicyPath) {
    if (!existsSync(opts.readinessPolicyPath)) {
      warnings.push(`Readiness policy not found: ${opts.readinessPolicyPath}`);
    } else {
      const policy = await loadReadinessPolicy(opts.readinessPolicyPath);
      const input = {
        run, evidence: evidenceNow, triage, flaky, quarantined, ...contractInputs, ...loadInputs, ...(apiSecurity ? { apiSecurity } : {}),
        ...(uiInput ? { uiCoverage: uiInput } : {}), failureTags: tags, ...(a11yNew ? { a11yNew } : {}),
        // Accessibility findings recorded by the a11y lens / "Check accessibility" steps feed a11yNoCritical.
        ...(await a11yReadinessInputs(runDir, evidence)),
        // The journeys' "Compare document" checks feed docsReconciled.
        ...(await docsReadinessInputs(runDir, evidence)),
      };
      readiness = evaluateReadiness(policy, input);
      // Cross-browser runs: a decision per browser next to the combined one.
      const perBrowser = readinessByBrowser(policy, input);
      if (perBrowser) readiness.browsers = perBrowser;
    }
  }

  const reports = await writeReports(runDir, run, {
    formats: opts.formats ?? ['html', 'json', 'junit'],
    title: opts.title,
    triage,
    flaky,
    readiness,
    evidence,
    ...(contractInputs.apiCoverage ? { apiCoverage: contractInputs.apiCoverage.map((c) => c.report) } : {}),
  });
  return { runDir, triage, flaky, readiness, reports, warnings, quarantine: { ...qStatus, ignoredFailures }, ...(ui ? { uiCoverage: ui.report } : {}), failureTags: tags };
}
