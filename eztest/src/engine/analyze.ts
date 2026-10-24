/**
 * After-run analysis pipeline: history -> flaky scores -> triage -> readiness
 * -> reports. Used by `eztest run` and `eztest analyze <runDir>`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRunArtifacts, HistoryStore, scoreHistory, failureSignature, triageRun, loadReadinessPolicy, evaluateReadiness, loadQuarantine, quarantineStatus, readinessByBrowser } from '../insights/index.js';
import type { FlakyScore, TriageReport, ReadinessResult, QuarantineStatus } from '../insights/index.js';
import { writeReports, journeyFilesAndOwners, loadLogo, type ReportFormat, type ReportModelInput } from '../report/index.js';
import { readFile } from 'node:fs/promises';
import { isDebugRunId, type RunResult } from '../core/index.js';
import type { EzTestConfig } from '../config/index.js';
import { adoSettings } from '../alm-ado/config.js';
import { contractReadinessInputs } from '../contracts/readiness.js';
import { a11yReadinessInputs } from '../a11y/readiness.js';
import { docsReadinessInputs } from '../docs/readiness.js';
import { loadReadinessInputs } from '../load/readiness.js';
import { apiSecurityReadinessInput } from '../lenses/security-api.js';
import { failureTags, type JourneyFailureTags, type UiCoverageGateInput } from '../insights/index.js';
import { recordUiCoverage, a11yIssuesOfRun, a11yTrend, type UiCoverageOptions, type UiCoverageReport, type A11yScope } from '../analytics/index.js';
import type { Journey } from '../core/index.js';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

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
  /** Report branding and options (config report.*). */
  report?: { title?: string; name?: string; logo?: string; trendRuns?: number; baseline?: string; studioUrl?: string; brandColor?: string; videoPolicy?: string };
  /** Azure DevOps settings for test case / work item links (config ado.*). */
  ado?: ReportModelInput['ado'];
  /** Jira base URL for issue links. */
  jira?: ReportModelInput['jira'];
  /** Project directory (journey files, CODEOWNERS, .eztest/requirements-ado.json). Default: two levels above the run directory. */
  cwd?: string;
  /** Environment for the run context (default process.env). */
  env?: Record<string, string | undefined>;
  /** The effective configuration, shown in the report's Configuration section (secrets masked). */
  config?: unknown;
}

/** The project's name for the report: package.json "name", else the folder name, as words ("shop-project" -> "Shop project"). */
export function projectName(cwd: string): string {
  let raw = basename(resolve(cwd));
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name) raw = pkg.name.replace(/^@[^/]+\//, '');
  } catch {
    // no package.json
  }
  const words = raw.replace(/[-_.]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'EZTest';
}

/** The run in the same output directory that started last before `run` (the comparison baseline). */
async function previousRun(runDir: string, run: RunResult): Promise<RunResult | undefined> {
  const out = resolve(runDir, '..');
  let best: RunResult | undefined;
  // Studio debug sessions are never a comparison baseline.
  const names = (await readdir(out).catch(() => [] as string[])).filter((n) => n !== run.runId && !isDebugRunId(n)).sort().reverse().slice(0, 40);
  for (const name of names) {
    const p = join(out, name, 'run.json');
    if (name === run.runId || !existsSync(p)) continue;
    try {
      const r = JSON.parse(await readFile(p, 'utf8')) as RunResult;
      if (!Array.isArray(r.journeys) || !r.startedAt || r.startedAt >= run.startedAt) continue;
      if (!best || r.startedAt > best.startedAt) best = r;
    } catch {
      // not a run
    }
  }
  return best;
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

/** Report options from the project configuration: report.*, ado.* (links) and the Jira publisher's base URL. */
export function reportOptionsFromConfig(cfg: EzTestConfig, cwd: string, env: Record<string, string | undefined> = process.env): Pick<AnalyzeOptions, 'report' | 'ado' | 'jira' | 'cwd' | 'config'> {
  const s = adoSettings(cfg, env);
  const jira = (cfg.publishers as Array<{ use?: string; baseUrl?: unknown }>).find((p) => p.use === 'jira' && typeof p.baseUrl === 'string');
  return {
    cwd,
    config: cfg,
    report: { ...cfg.report, videoPolicy: cfg.video },
    ...(s.collectionUrl && s.project ? { ado: { collectionUrl: s.collectionUrl, project: s.project, ...(cfg.ado.testPlanId ? { testPlanId: cfg.ado.testPlanId } : {}), ...(cfg.ado.testSuiteId ? { testSuiteId: cfg.ado.testSuiteId } : {}) } } : {}),
    ...(jira ? { jira: { baseUrl: String(jira.baseUrl) } } : {}),
  };
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
      const prev = (await readdir(out)).filter((n) => n !== run.runId && !isDebugRunId(n) && existsSync(join(out, n, 'run.json'))).sort().reverse();
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

  if (readiness && opts.recordHistory !== false && store.annotate(run.runId, { readiness: readiness.decision, readinessScore: readiness.score })) await store.save();
  const cwd = opts.cwd ?? resolve(runDir, '..', '..');
  const rep = opts.report ?? {};
  let baseline: RunResult | undefined;
  try {
    if (rep.baseline && rep.baseline !== 'none' && rep.baseline !== 'previous') baseline = JSON.parse(await readFile(join(resolve(cwd, rep.baseline), 'run.json'), 'utf8')) as RunResult;
    else if (rep.baseline !== 'none') baseline = await previousRun(runDir, run);
  } catch (e) {
    warnings.push(`report baseline not loaded: ${(e as Error).message}`);
  }
  let logo: string | undefined;
  if (rep.logo) {
    try {
      logo = await loadLogo(resolve(cwd, rep.logo));
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  const fo = opts.journeys?.length ? await journeyFilesAndOwners(opts.journeys, cwd).catch(() => undefined) : undefined;
  let requirementsCatalog: ReportModelInput['requirementsCatalog'];
  const reqFile = join(cwd, '.eztest', 'requirements-ado.json');
  if (existsSync(reqFile)) {
    try {
      const r = JSON.parse(await readFile(reqFile, 'utf8')) as { requirements?: Array<{ id: number | string; title?: string; url?: string }> };
      requirementsCatalog = (r.requirements ?? []).map((x) => ({ id: String(x.id), ...(x.title ? { title: x.title } : {}), ...(x.url ? { url: x.url } : {}) }));
    } catch {
      // ignore an unreadable requirements list
    }
  }
  const reports = await writeReports(runDir, run, {
    formats: opts.formats ?? ['html', 'json', 'junit'],
    title: opts.title ?? rep.title ?? `${rep.name ?? projectName(cwd)} test report`,
    triage,
    flaky,
    readiness,
    evidence,
    ...(contractInputs.apiCoverage ? { apiCoverage: contractInputs.apiCoverage.map((c) => c.report) } : {}),
    history: scoped.runs,
    failureTags: tags,
    ...(baseline ? { baseline } : {}),
    brand: { name: rep.name ?? projectName(cwd), ...(logo ? { logo } : {}), ...(rep.brandColor ? { color: rep.brandColor } : {}) },
    ...(rep.videoPolicy ? { videoPolicy: rep.videoPolicy } : {}),
    ...(rep.trendRuns ? { trendRuns: rep.trendRuns } : {}),
    ...(rep.studioUrl ? { studioUrl: rep.studioUrl } : {}),
    ...(fo ? { files: fo.files, owners: fo.owners } : {}),
    ...(opts.ado ? { ado: opts.ado } : {}),
    ...(opts.jira ? { jira: opts.jira } : {}),
    ...(requirementsCatalog ? { requirementsCatalog } : {}),
    ...(ui ? { uiCoverage: { percent: ui.report.totals.percent, tested: ui.report.totals.tested, elements: ui.report.totals.elements, pages: ui.report.totals.pages } } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });
  return { runDir, triage, flaky, readiness, reports, warnings, quarantine: { ...qStatus, ignoredFailures }, ...(ui ? { uiCoverage: ui.report } : {}), failureTags: tags };
}
