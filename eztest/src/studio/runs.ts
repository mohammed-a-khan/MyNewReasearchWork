/**
 * Runs from the Studio: start one run at a time in-process, stream its events
 * to any number of SSE listeners (with replay for late subscribers), analyze
 * it afterwards, and read past runs from the output directory.
 */
import { neededVariables, type NeededVariable } from './run-variables.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BROWSER_ENGINES, BROWSER_TARGET_RE, BROWSER_TARGETS, EventBus, isBrowserEngine, isDebugRunId, verifyEvidence, type EzEvent, type RunResult } from '../core/index.js';
import { loadConfig, createMaskedLogger, type LoadedConfig, type SecretMasker } from '../config/index.js';
import { createEngine, analyzeRun, lensesFromConfig, enableAddons, a11yLensOptions, type AnalyzeResult } from '../engine/index.js';
import { journeyKind, type ManualVerdictProvider } from '../runner/manual.js';
import { expandExamples } from '../runner/journey-hooks.js';
import type { Journey } from '../core/index.js';
import { loadJourneys, filterJourneys, bddOptionsFrom, defaultJourneyPaths } from '../cli/journeys.js';
import { expandBrowserMatrix } from '../runner/browsers.js';
import { HistoryStore, scoreHistory, loadRunArtifacts, triageRun, readEvidenceManifest } from '../insights/index.js';
import { attentionOf, readReportModel, REPORT_FILES, type ReportFormat } from '../report/index.js';
import { reportOptionsFromConfig } from '../engine/analyze.js';
import { HttpError } from './http.js';
import type { EventHub, StudioEvent } from './events.js';

export { HttpError, type StudioEvent };

export interface RunRequest {
  /** Journey ids to run (default: all, filtered by tags). */
  journeys?: string[];
  tags?: string[];
  browser?: (typeof BROWSER_ENGINES)[number];
  /** Cross-browser run: every journey on each of these (chromium, firefox, msedge, chrome); overrides `browser`. */
  browsers?: string[];
  headed?: boolean;
  workers?: number;
  retries?: number;
  heal?: boolean;
  lenses?: string[];
  /** Record DOM snapshots per step (time-travel trace), e.g. for the UI coverage map. */
  timeTravel?: boolean;
  /** Test cycle this run executes (recorded in the cycle's run list). */
  cycle?: string;
  /** Tester running the manual steps (shown in the guided runner). */
  tester?: string;
  /** Run-time values for ${name} placeholders (a recorded password); secret-sounding names are masked, nothing is stored. */
  variables?: Record<string, string>;
}

type Listener = (e: StudioEvent) => void;

export interface RunPlanJourney {
  id: string;
  name: string;
  type: 'automated' | 'manual' | 'hybrid';
  assignee?: string;
  preconditions?: string;
  steps: Array<{ id: string; intent: string; manual: boolean; instruction?: string; expected?: string[]; attachments?: string[]; depth: number }>;
}

/** The plan of journeys (Examples rows expanded) as the guided runner shows it. */
export function runPlan(journeys: Journey[]): RunPlanJourney[] {
  return expandExamples(journeys).map((j) => {
    const steps: RunPlanJourney['steps'] = [];
    const walk = (list: Journey['steps'], depth: number) => {
      for (const s of list) {
        const a = (s.args ?? {}) as { expected?: string[]; attachments?: string[] };
        steps.push({ id: s.id, intent: s.intent, manual: s.action === 'manual', depth, ...(s.action === 'manual' ? { instruction: s.value ?? '', expected: a.expected ?? [], attachments: a.attachments ?? [] } : {}) });
        walk(s.steps ?? [], depth + 1);
        walk(s.else ?? [], depth + 1);
        walk(s.catch ?? [], depth + 1);
      }
    };
    walk(j.steps, 0);
    return { id: j.id, name: j.name, type: journeyKind(j), ...(j.assignee ? { assignee: j.assignee } : {}), ...(j.preconditions ? { preconditions: j.preconditions } : {}), steps };
  });
}

export type RunState = 'running' | 'cancelling' | 'analyzing' | 'done' | 'cancelled' | 'error';

export interface ActiveRun {
  id: string;
  state: RunState;
  startedAt: string;
  /** The request that started the run (for the UI's "run again"). */
  request: RunRequest;
  journeys: Array<{ id: string; name: string; steps: number }>;
  /** Steps of every journey (manual ones with their instruction and expected results), for the guided runner. */
  plan: RunPlanJourney[];
  events: StudioEvent[];
  listeners: Set<Listener>;
  result?: Record<string, unknown>;
  abort: AbortController;
}

const RUN_ID = /^[A-Za-z0-9][\w.-]{0,120}$/;

export function assertRunId(id: string): void {
  if (!RUN_ID.test(id) || id.includes('..')) throw new HttpError(400, 'Invalid run id');
}

function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
}

export interface StudioContext {
  cwd: string;
  env: Record<string, string | undefined>;
  addons: { d365?: unknown; off(): void };
}

export async function loadStudioConfig(ctx: StudioContext, overrides: Record<string, unknown> = {}): Promise<LoadedConfig> {
  return loadConfig({ cwd: ctx.cwd, environment: ctx.env, overrides });
}

function positiveInt(v: unknown, name: string, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, `${name} must be an integer between 0 and ${max}`);
  return n;
}

export class RunManager {
  private active?: ActiveRun;
  private readonly recent = new Map<string, ActiveRun>();

  constructor(
    private readonly ctx: StudioContext,
    private readonly hub?: EventHub,
    /** Verdicts for manual steps (the Studio's guided runner). */
    private readonly manual?: ManualVerdictProvider,
  ) {}

  get current(): ActiveRun | undefined {
    const s = this.active?.state;
    return s === 'running' || s === 'cancelling' || s === 'analyzing' ? this.active : undefined;
  }

  /** Runs started in this Studio session, newest first. */
  list(): ActiveRun[] {
    return [...this.recent.values()].reverse();
  }

  /**
   * Cancel the run in progress. The runner stops at the next step boundary,
   * records what did not run as skipped and closes the browser; the run then
   * ends with a `done` event whose state is `cancelled`.
   */
  cancel(id: string): ActiveRun {
    const run = this.current;
    if (!run || run.id !== id) throw new HttpError(404, 'No run in progress with this id');
    if (run.state === 'running') {
      run.state = 'cancelling';
      run.abort.abort();
      this.emit(run, 'cancelling', { runId: id });
    }
    return run;
  }

  find(id: string): ActiveRun | undefined {
    return this.recent.get(id);
  }

  private emit(run: ActiveRun, type: string, data: Record<string, unknown>, masker?: SecretMasker): void {
    const e: StudioEvent = { seq: run.events.length + 1, type, data: masker ? masker.maskDeep(data) : data };
    run.events.push(e);
    this.hub?.publish('run', { ...e.data, type, runId: run.id });
    for (const l of run.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener never breaks the run
      }
    }
  }

  subscribe(run: ActiveRun, l: Listener): () => void {
    run.listeners.add(l);
    return () => run.listeners.delete(l);
  }

  /** Validate the request, load journeys and start the run in the background. */
  /** Variables the selected journeys need that the project does not supply (the Run page asks for them). */
  async needs(req: Pick<RunRequest, 'journeys' | 'tags'>): Promise<NeededVariable[]> {
    const loaded = await loadStudioConfig(this.ctx, {});
    const cfg = loaded.config;
    const { journeys: all } = await loadJourneys(defaultJourneyPaths(cfg, this.ctx.cwd), this.ctx.cwd, { bdd: bddOptionsFrom(cfg) });
    const picked = filterJourneys(all, { tags: req.tags?.length ? req.tags : undefined, ids: req.journeys?.length ? req.journeys : undefined });
    return neededVariables(picked, cfg.vars);
  }

  async start(req: RunRequest): Promise<ActiveRun> {
    if (this.current) throw new HttpError(409, `A run is already in progress (${this.current.id})`);
    const overrides: Record<string, unknown> = {};
    if (req.browser !== undefined) {
      if (!isBrowserEngine(req.browser)) throw new HttpError(400, `browser must be ${BROWSER_ENGINES.join(' or ')}`);
      overrides.browser = req.browser;
    }
    if (req.browsers !== undefined) {
      if (!Array.isArray(req.browsers) || req.browsers.some((b) => typeof b !== 'string' || !BROWSER_TARGET_RE.test(b))) {
        throw new HttpError(400, `browsers must be a list of ${BROWSER_TARGETS.join(', ')} (or a chrome/msedge channel such as msedge-beta)`);
      }
      if (new Set(req.browsers).size !== req.browsers.length) throw new HttpError(400, 'browsers lists a browser twice');
      if (req.browsers.length) overrides.browsers = req.browsers;
    }
    if (req.headed) overrides.headless = false;
    const workers = positiveInt(req.workers, 'workers', 16);
    if (workers) overrides.concurrency = workers;
    const retries = positiveInt(req.retries, 'retries', 5);
    if (retries !== undefined) overrides.retries = retries;
    if (req.heal === false) overrides.healing = { enabled: false };
    const lenses = Array.isArray(req.lenses) ? req.lenses.map(String) : undefined;
    if (lenses) {
      for (const l of lenses) if (!/^(?:a11y|security|visual|perf)(?::warn)?$/.test(l)) throw new HttpError(400, `Unknown lens "${l}"`);
      overrides.lenses = lenses;
    }

    if (req.variables !== undefined) {
      if (!req.variables || typeof req.variables !== 'object' || Array.isArray(req.variables)) throw new HttpError(400, 'variables must be an object of name: value');
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.variables)) {
        if (!/^[A-Za-z_][\w]*$/.test(k)) throw new HttpError(400, `variables: "${k}" is not a variable name`);
        if (typeof v !== 'string') throw new HttpError(400, `variables.${k} must be text`);
        if (v !== '') vars[k] = v;
      }
      if (Object.keys(vars).length) overrides.vars = vars;
    }
    const loaded = await loadStudioConfig(this.ctx, overrides);
    const cfg = loaded.config;
    const { journeys: all, errors } = await loadJourneys(defaultJourneyPaths(cfg, this.ctx.cwd), this.ctx.cwd, { bdd: bddOptionsFrom(cfg) });
    if (errors.length) throw new HttpError(422, `Some journeys do not parse: ${errors.map((e) => `${e.file}: ${e.message}`).join('; ')}`);
    const tags = Array.isArray(req.tags) ? req.tags.map(String) : undefined;
    const ids = Array.isArray(req.journeys) ? req.journeys.map(String) : undefined;
    const picked = filterJourneys(all, { tags, ids: ids?.length ? ids : undefined });
    if (picked.length === 0) throw new HttpError(400, 'No journeys matched the selection');
    // A cross-browser run shows (and runs) one journey x browser unit per browser, ids ending in @<browser>.
    const names = (cfg.browsers ?? []).map((b) => (typeof b === 'string' ? b : b.name).toLowerCase());
    const matrix = expandBrowserMatrix(picked, names);
    const journeys = [...matrix.journeys, ...matrix.excluded.map((x) => x.journey)];

    const id = newRunId();
    const run: ActiveRun = {
      id, state: 'running', startedAt: new Date().toISOString(), request: req.variables ? { ...req, variables: Object.fromEntries(Object.keys(req.variables).map((k) => [k, '****'])) } : req, events: [], listeners: new Set(), abort: new AbortController(),
      journeys: journeys.map((j) => ({ id: j.id, name: j.name, steps: j.steps.length })),
      plan: runPlan(journeys),
    };
    this.active = run;
    this.recent.set(id, run);
    if (this.recent.size > 20) this.recent.delete(this.recent.keys().next().value as string);
    this.emit(run, 'queued', { runId: id, journeys: journeys.map((j) => ({ id: j.id, name: j.name, steps: j.steps.map((s) => ({ id: s.id, intent: s.intent })) })) });

    void this.execute(run, loaded, journeys, lenses).catch(async (e: unknown) => {
      run.state = 'error';
      const message = loaded.masker.mask((e as Error)?.message ?? String(e));
      run.result = { runId: id, error: message };
      // Keep the failed run in the Results history with its error (it may have no run.json).
      await writeRunError(resolve(this.ctx.cwd, cfg.outputDir), { runId: id, startedAt: run.startedAt, finishedAt: new Date().toISOString(), error: message, journeys: run.journeys.length }).catch(() => undefined);
      this.emit(run, 'run-error', { message });
      this.emit(run, 'done', { runId: id, state: 'error', error: message });
    });
    return run;
  }

  private async execute(run: ActiveRun, loaded: LoadedConfig, journeys: Awaited<ReturnType<typeof loadJourneys>>['journeys'], lenses?: string[]): Promise<void> {
    const cfg = loaded.config;
    const masker = loaded.masker;
    const events = new EventBus();
    events.on((e: EzEvent) => this.emit(run, e.type, { ...e } as Record<string, unknown>, masker));
    const engine = await createEngine(loaded, {
      cwd: this.ctx.cwd,
      addons: this.ctx.addons as never,
      logger: createMaskedLogger('error', masker),
      runOptions: {
        events,
        runId: run.id,
        screenshots: 'every-step',
        lenses: lensesFromConfig(lenses ?? cfg.lenses, this.ctx.cwd, { branchBaselines: cfg.vcs.branchScope.baselines, defaultBranch: cfg.vcs.branchScope.defaultBranch, a11y: a11yLensOptions(cfg) }),
        signal: run.abort.signal,
        // Manual steps pause for a verdict in the guided runner (#/manual/run/<runId>).
        ...(this.manual ? { manual: this.manual } : {}),
        ...(run.request.timeTravel ? { timeTravel: { ...cfg.trace.timeTravel, enabled: true, masker } } : {}),
      },
    });
    let result: RunResult;
    try {
      result = await engine.run(journeys);
    } finally {
      await engine.close();
    }
    const runDir = join(engine.runOptions.outputDir, result.runId);
    this.emit(run, 'run:summary', { runId: result.runId, summary: result.summary });
    if (run.abort.signal.aborted) {
      // A cancelled run is kept on disk (run.json, evidence) but not analyzed, so it never skews history.
      run.result = { runId: result.runId, summary: result.summary, cancelled: true };
      run.state = 'cancelled';
      this.emit(run, 'cancelled', { runId: result.runId, summary: result.summary });
      this.emit(run, 'done', { runId: result.runId, state: 'cancelled' });
      return;
    }
    run.state = 'analyzing';
    let analysis: AnalyzeResult | undefined;
    try {
      const policy = cfg.readiness.policyPath;
      const formats = cfg.reporters.filter((r: string) => ['html', 'json', 'junit'].includes(r)) as ReportFormat[];
      analysis = await analyzeRun(runDir, {
        historyPath: resolve(this.ctx.cwd, '.eztest', 'history.json'),
        readinessPolicyPath: policy ? resolve(this.ctx.cwd, policy) : undefined,
        formats: formats.length ? (formats.includes('html') ? formats : [...formats, 'html']) : ['html', 'json'],
        ...(cfg.vcs.branchScope.history && result.environment?.gitBranch ? { historyBranch: result.environment.gitBranch } : {}),
        journeys, uiCoverage: cfg.coverage.ui, a11yScopes: cfg.accessibility.scopes,
        ...reportOptionsFromConfig(cfg, this.ctx.cwd),
      });
    } catch (e) {
      this.emit(run, 'warning', { message: `Analysis failed: ${(e as Error).message}` }, masker);
    }
    const summary = {
      runId: result.runId,
      summary: result.summary,
      triage: analysis?.triage.verdicts.map((v) => ({ journeyId: v.journeyId, journeyName: v.journeyName, category: v.category, confidence: v.confidence, status: v.status, reasons: v.reasons })) ?? [],
      readiness: analysis?.readiness ? { decision: analysis.readiness.decision, score: analysis.readiness.score, rationale: analysis.readiness.rationale.map((r) => r.text) } : undefined,
      warnings: analysis?.warnings ?? [],
      report: analysis?.reports.html ? `/runs/${encodeURIComponent(result.runId)}/report.html` : undefined,
      ...(result.browsers ? { browsers: result.browsers } : {}),
      ...(analysis?.readiness?.browsers ? { readinessByBrowser: analysis.readiness.browsers } : {}),
    };
    run.result = summary;
    run.state = 'done';
    this.emit(run, 'analysis', summary, masker);
    this.emit(run, 'done', { runId: result.runId, state: 'done' });
  }
}

// ------------------------------------------------------------------ past runs

export async function outputDirOf(ctx: StudioContext): Promise<string> {
  try {
    const l = await loadStudioConfig(ctx);
    return resolve(ctx.cwd, l.config.outputDir);
  } catch {
    return resolve(ctx.cwd, 'eztest-results');
  }
}

/** Written into the run folder when a Studio run fails before it could finish (no or partial run.json). */
export const RUN_ERROR_FILE = 'run-error.json';

export interface RunErrorRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  error: string;
  journeys: number;
}

export async function writeRunError(outputDir: string, rec: RunErrorRecord): Promise<void> {
  assertRunId(rec.runId);
  const dir = join(outputDir, rec.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, RUN_ERROR_FILE), JSON.stringify(rec, null, 2));
}

async function readRunError(dir: string): Promise<RunErrorRecord | undefined> {
  const f = join(dir, RUN_ERROR_FILE);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(await readFile(f, 'utf8')) as RunErrorRecord;
  } catch {
    return undefined;
  }
}

export interface RunListItem {
  runId: string;
  /** "error": the run failed before it finished; `error` says why. */
  state?: 'error';
  /** Studio debug sessions (run ids "debug-..."): shown in Results, left out of the quality analytics. */
  debug?: boolean;
  startedAt?: string;
  durationMs?: number;
  summary?: RunResult['summary'];
  hasReport: boolean;
  /** True when the run was cancelled from the Studio. */
  cancelled?: boolean;
  error?: string;
  /** Git branch and commit the run tested (branch filters). */
  branch?: string;
  commit?: string;
}

export async function listRuns(outputDir: string): Promise<RunListItem[]> {
  if (!existsSync(outputDir)) return [];
  const out: RunListItem[] = [];
  for (const name of await readdir(outputDir)) {
    if (!RUN_ID.test(name)) continue;
    const dir = join(outputDir, name);
    if (!(await stat(dir)).isDirectory()) continue;
    const runJson = join(dir, 'run.json');
    const failed = await readRunError(dir);
    const debug = isDebugRunId(name) || undefined;
    const errored = failed ? { state: 'error' as const, error: failed.error } : {};
    if (!existsSync(runJson)) {
      if (failed) out.push({ runId: name, startedAt: failed.startedAt, durationMs: Date.parse(failed.finishedAt) - Date.parse(failed.startedAt), hasReport: false, ...errored, ...(debug ? { debug } : {}) });
      continue;
    }
    try {
      const run = JSON.parse(await readFile(runJson, 'utf8')) as RunResult;
      const cancelled = run.journeys?.some((j) => j.error?.name === 'CancelledError') || undefined;
      const branch = run.environment?.gitBranch;
      const commit = run.environment?.gitCommit;
      out.push({ runId: name, startedAt: run.startedAt, durationMs: run.durationMs, summary: run.summary, hasReport: existsSync(join(dir, 'report.html')), cancelled, ...errored, ...(debug ? { debug } : {}), ...(branch ? { branch } : {}), ...(commit ? { commit } : {}) });
    } catch (e) {
      out.push({ runId: name, hasReport: false, error: `run.json unreadable: ${(e as Error).message}`, ...(debug ? { debug } : {}) });
    }
  }
  return out.sort((a, b) => (b.startedAt ?? b.runId).localeCompare(a.startedAt ?? a.runId));
}

export async function runDetail(outputDir: string, runId: string, masker?: SecretMasker): Promise<Record<string, unknown>> {
  assertRunId(runId);
  const dir = join(outputDir, runId);
  const runJson = join(dir, 'run.json');
  const failed = await readRunError(dir);
  if (!existsSync(runJson)) {
    if (failed) return { runId, state: 'error', error: masker ? masker.mask(failed.error) : failed.error, startedAt: failed.startedAt, finishedAt: failed.finishedAt };
    throw new HttpError(404, `Run ${runId} not found`);
  }
  const run = JSON.parse(await readFile(runJson, 'utf8')) as RunResult;
  const evidence = await readEvidenceManifest(dir);
  const evidenceMap: Record<string, { kind: string; path: string; description?: string }> = {};
  for (const e of evidence) evidenceMap[e.id] = { kind: e.kind, path: e.path, description: e.description };
  const verification = await verifyEvidence(dir);
  let healProposals: unknown;
  const hp = join(dir, 'heal-proposals.json');
  if (existsSync(hp)) healProposals = JSON.parse(await readFile(hp, 'utf8'));
  let insights: unknown;
  const rj = join(dir, 'report.json');
  if (existsSync(rj)) {
    try {
      insights = (JSON.parse(await readFile(rj, 'utf8')) as { insights?: unknown }).insights;
    } catch {
      insights = undefined;
    }
  }
  const base = `/runs/${encodeURIComponent(runId)}/`;
  const exportLabels: Array<[ReportFormat, string]> = [['pdf', 'PDF report'], ['xlsx', 'Excel workbook'], ['email', 'E-mail summary'], ['summary', 'One-page summary'], ['json', 'JSON'], ['junit', 'JUnit XML'], ['csv', 'CSV']];
  const exportsList = exportLabels.filter(([f]) => existsSync(join(dir, REPORT_FILES[f]))).map(([f, label]) => ({ format: f, label, href: `${base}${REPORT_FILES[f]}` }));
  // The report's run-level analysis (categories, what needs attention, quality lenses) for the overview.
  let reportSummary: Record<string, unknown> | undefined;
  try {
    const m = await readReportModel(dir);
    if (m) {
      const a = attentionOf(m);
      const pick = (list: Array<{ id: string; name: string }>) => list.slice(0, 20).map((t) => ({ id: t.id, name: t.name }));
      reportSummary = {
        ...(m.verdict ? { verdict: { decision: m.verdict.decision, ...(m.verdict.score !== undefined ? { score: m.verdict.score } : {}), source: m.verdict.source } } : {}),
        kpis: m.kpis,
        ...(m.previous ? { previous: { runId: m.previous.runId, kpis: m.previous.kpis } } : {}),
        categories: m.categories ?? {},
        failures: m.tests.filter((t) => t.cat).slice(0, 50).map((t) => ({ id: t.id, name: t.name, state: t.state, category: t.cat!.c, why: t.cat!.why, fix: t.cat!.fix, known: t.failure?.known ?? true, failedStep: t.failedStep, error: (t.error?.message ?? '').split('\n')[0].slice(0, 300) })),
        attention: { newFailures: pick(a.newFailures), regressions: pick(a.regressions), flaky: pick(a.flaky), fixed: pick(a.fixed), slower: pick(a.slower) },
        ...(m.lenses ? { lenses: { a11y: m.lenses.a11y?.counts, security: m.lenses.security?.counts, perf: m.lenses.perf?.metrics.filter((x) => x.status === 'fail' || x.status === 'warn').map((x) => x.metric) } } : {}),
        trend: m.trend.map((t) => ({ runId: t.runId, passRate: t.passRate, durationMs: t.durationMs, current: !!t.current })),
      };
    }
  } catch {
    reportSummary = undefined;
  }
  const detail = {
    run,
    evidence: evidenceMap,
    verification: { ok: verification.ok, entries: verification.entries, problems: verification.problems },
    healProposals,
    insights,
    report: existsSync(join(dir, 'report.html')) ? `/runs/${encodeURIComponent(runId)}/report.html` : undefined,
    exports: exportsList,
    ...(reportSummary ? { reportSummary } : {}),
    ...(failed ? { state: 'error', error: failed.error } : {}),
  };
  return masker ? masker.maskDeep(detail) : detail;
}

// ------------------------------------------------------------------ insights

export async function insights(ctx: StudioContext, outputDir: string): Promise<Record<string, unknown>> {
  const historyPath = resolve(ctx.cwd, '.eztest', 'history.json');
  const warnings: string[] = [];
  let flaky: ReturnType<typeof scoreHistory> = [];
  const trend: Array<{ runId: string; startedAt: string; total: number; passed: number; healed: number; failed: number; healedRatio: number }> = [];
  try {
    const store = await HistoryStore.open(historyPath);
    if (store.journeyIds().length) flaky = scoreHistory(store);
    for (const r of store.runs.slice(-30)) {
      const total = r.outcomes.length;
      const healed = r.outcomes.filter((o) => o.status === 'passed-healed').length;
      const passed = r.outcomes.filter((o) => o.status === 'passed').length;
      const failed = r.outcomes.filter((o) => o.status === 'failed' || o.status === 'error').length;
      trend.push({ runId: r.runId, startedAt: r.startedAt, total, passed, healed, failed, healedRatio: total ? healed / total : 0 });
    }
  } catch (e) {
    warnings.push(`History could not be read: ${(e as Error).message}`);
  }
  let latest: Record<string, unknown> | undefined;
  const runs = await listRuns(outputDir);
  const last = runs.find((r) => r.summary && !r.debug);
  if (last) {
    try {
      const art = await loadRunArtifacts(join(outputDir, last.runId));
      const t = triageRun({ run: art.run, evidence: art.evidence, networkLogs: art.networkLogs, flaky });
      latest = {
        runId: last.runId,
        summary: art.run.summary,
        clusters: t.clusters.map((c) => ({ id: c.id, size: c.size, members: c.members, message: c.normalized, cohesion: c.cohesion })),
        verdicts: t.verdicts.map((v) => ({ journeyId: v.journeyId, category: v.category, confidence: v.confidence, status: v.status, reason: v.reasons[0] ?? '' })),
      };
    } catch (e) {
      warnings.push(`Latest run could not be analyzed: ${(e as Error).message}`);
    }
  }
  return {
    flaky: flaky.map((f) => ({
      journeyId: f.journeyId, state: f.state, samples: f.samples, failRate: f.failRate, flipRate: f.flipRate, healedRate: f.healedRate,
      healedTrendRising: f.healedTrendRising, sequence: f.sequence, quarantine: f.quarantine,
    })),
    trend,
    latest,
    warnings,
  };
}

export { enableAddons };
