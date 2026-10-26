/**
 * The report data model (ReportModel, version 2): everything the HTML report,
 * the JSON export, the CSV, the one-page summary, the comparison and the
 * notification cards show, computed once from a run and its insights.
 *
 * It is plain JSON (report.json carries it under `model`), so reports can be
 * rendered again later from report.json alone, for example after the run was
 * published to Azure DevOps and the links are known.
 *
 * The suite tree is generic: each test carries `suite` (a path of named
 * segments). A runner that knows a richer hierarchy (BDD feature / rule /
 * scenario outline) sets JourneyResult.suitePath and it is used as is;
 * otherwise the journey file's folders and file name are used, and failing
 * that the test's first tag.
 */
import type { EvidenceRef, JourneyResult, RunResult, StepResult } from '../core/index.js';
import { failureSignature, clusterFailures, type FlakyScore, type ReadinessResult, type TriageReport, type JourneyFailureTags, type RunHistoryEntry } from '../insights/index.js';
import type { ApiCoverageReport } from '../contracts/coverage.js';
import type { NetworkEntry } from '../perf/network.js';
import type { RunContext } from './context.js';
import { adoWeb, safeHttpUrl, type IntegrationsRecord } from './integrations.js';
import { healProposals, formatLocator, type HealProposal } from './model.js';
import { safeRelativeUrl } from './escape.js';
import { parseAdoTags } from '../alm-ado/tags.js';
import { categoriseFailure, FAILURE_CATEGORIES, type CategoryVerdict, type FailureCategory } from './categorise.js';
import { summariseLenses, type LensFile, type LensSummary } from './lenses.js';
import { configSnapshot } from './config-snapshot.js';
import { normalizeBrand, type ReportBrand } from './brand.js';
import { scenarioEntry } from './bdd.js';
import { failureHeadline } from './headline.js';

export const REPORT_MODEL_VERSION = 2 as const;

/** One state per test, mutually exclusive: what the donut and the filters count. */
export type TestState = 'passed' | 'healed' | 'flaky' | 'failed' | 'error' | 'skipped';
export const TEST_STATES: TestState[] = ['passed', 'healed', 'flaky', 'failed', 'error', 'skipped'];
export const STATE_LABEL: Record<TestState, string> = { passed: 'Passed', healed: 'Healed', flaky: 'Flaky', failed: 'Failed', error: 'Error', skipped: 'Skipped' };

/** Step status codes in the model: P passed, H passed-healed, F failed, S skipped, B blocked. */
export type StepCode = 'P' | 'H' | 'F' | 'S' | 'B';
const STEP_CODE: Record<StepResult['status'], StepCode> = { passed: 'P', 'passed-healed': 'H', failed: 'F', skipped: 'S', blocked: 'B' };

/** A step, with short keys (a run of 10,000 tests has ~100,000 of these). */
export interface StepModel {
  /** Intent (the step text). */
  n: string;
  s: StepCode;
  /** Duration, ms. */
  d: number;
  /** Start, ms after the test started. */
  t: number;
  /** Evidence ids (see ReportModel.evidence). */
  e?: string[];
  /** Error: name, message, stack, and the human headline of the message (headline.ts). */
  x?: { name?: string; message: string; stack?: string; headline?: string };
  /** Healing: tier, from, to, confidence, verified, reason, evidence ids, shared element. */
  h?: { tier: string; from: string[]; to: string; confidence: number; verified: boolean; reason: string; evidence: string[]; element?: string };
  /** Post-conditions: condition text, held, actual. */
  c?: Array<[string, boolean, string]>;
  /** Locator that resolved the target. */
  l?: string;
  /** Actor (multi-actor journeys). */
  a?: string;
  /** Loop iteration / retry attempt of a child. */
  i?: number;
  /** Branch of a block the child ran in. */
  b?: string;
  /** Soft assertion. */
  so?: 1;
  w?: string[];
  /** Failure diagnosis (expected / found, candidates, did-you-mean, console and network errors). */
  dg?: { expected: string; found: string; similar: string[]; consoleErrors: string[]; failedRequests: string[]; url?: string; screenshot?: string };
  /** DB rows captured by the step (masked), as a table. */
  db?: { key: string; columns: string[]; rows: unknown[][]; total: number };
  /** API exchanges of the step (masked bodies, truncated). */
  api?: Array<{ method: string; url: string; status: number; ms?: number; requestBody?: string; responseBody?: string; responseHeaders?: Record<string, string> }>;
  /** A verified, more robust locator suggestion. */
  im?: { suggested: string; reason: string };
  /** Manual step verdict. */
  m?: { verdict: string; tester?: string; actual?: string; notes?: string };
  /** Time-travel DOM snapshots of the step: keys into ReportModel.snapshots (before / after). */
  sn?: { b?: string; a?: string };
  /** What the healer tried when the step was not healed (tier by tier). */
  hn?: string[];
  /** Visual comparison: baseline, actual and diff images (data: URIs), with the result. */
  vd?: Array<{ key: string; message: string; ratio?: number; baseline?: string; actual?: string; diff?: string }>;
  ch?: StepModel[];
}

/** A request of the waterfall: method, URL, status, start (ms after the test started), duration, size, type, step number, failure, headers (masked). */
export interface NetRow {
  m: string;
  u: string;
  s?: number;
  st: number;
  d?: number;
  sz?: number;
  ty?: string;
  mime?: string;
  step?: number;
  f?: string;
  rq?: Record<string, string>;
  rs?: Record<string, string>;
  w?: { dnsMs?: number; connectMs?: number; waitMs?: number; receiveMs?: number };
}

/** An evidence entry: [kind index, relative URL or null, description, size bytes or null, ms after the run started or null, SHA-256, chain position, test index or -1, step number or 0]. */
export type EvidenceEntry = [number, string | null, string, number | null, number | null, string, number, number, number];

export interface AttemptModel {
  attempt: number;
  status: string;
  durationMs: number;
  failedStep?: string;
  error?: string;
  steps: Array<[string, StepCode, number]>;
}

export interface TestModel {
  id: string;
  name: string;
  state: TestState;
  /** The journey's own status (passed-healed, failed, ...). */
  status: JourneyResult['status'];
  durationMs: number;
  /** Start, ms after the run started. */
  startMs: number;
  tags: string[];
  requirements: string[];
  risk: number;
  attempt: number;
  browser?: string;
  owners: string[];
  file?: string;
  suite: string[];
  /** The error, with the human headline of its message (headline.ts); the raw message stays for the technical details. */
  error?: { name?: string; message: string; stack?: string; headline?: string };
  failedStep?: string;
  signature?: string;
  cluster?: string;
  failure?: { known: boolean; firstSeenRun?: string; firstSeenAt?: string; tags: string[]; streak?: number };
  triage?: { category: string; confidence: number; status: string; reasons: string[]; evidence: string[]; secondOpinion?: string };
  history?: { state: string; sequence: string; failRate: number; samples: number; reasons: string[]; flips?: number };
  /** Failure category (product, test, environment, data, flaky, needs review), why, and the suggested next step. */
  cat?: CategoryVerdict;
  flake?: { cause: string; reason: string; confidence: number };
  heals: number;
  ado?: { testCases: Array<{ id: number; url?: string }>; plan?: { id: number; url?: string }; suite?: { id: number; url?: string }; results: Array<{ testCaseId: number; resultId?: number; outcome?: string; url?: string }> };
  bugs: Array<{ system: 'ado' | 'jira'; id: string; url?: string; action: string }>;
  requirementLinks: Array<{ id: string; url?: string }>;
  row?: Record<string, string>;
  actors: string[];
  /** The video, its WebVTT chapters file and the chapters themselves (seconds), embedded so they work from file://. */
  video?: { src: string; chapters?: string; cues?: Array<[number, number, string]> };
  /** Every video of the test (one per attempt, actor or browser page). */
  videos?: Array<{ src: string; label: string; chapters?: string; cues?: Array<[number, number, string]> }>;
  /** Poster frame for the video: the failing step's screenshot, else the last one. */
  poster?: string;
  /** Why there is no video (the video policy). */
  videoNote?: string;
  /** Trace: the trace file (zip), Studio's time-travel link, the trace directory and a terminal command. */
  trace?: { file?: string; studio?: string; dir?: string; cmd?: string };
  /** Requests of the test (from the time-travel trace, else the browser network log): the waterfall. */
  waterfall?: NetRow[];
  attempts?: AttemptModel[];
  /** Network entries of the failing step (or the last ones before the failure). */
  network?: Array<{ method: string; url: string; status: number; ms?: number; failure?: string }>;
  /** Browser console: level, text, ms after the test started, step number, source location. */
  console?: Array<{ l: string; t: string; at?: number; step?: number; loc?: string; ig?: number }>;
  manual?: { type: string; testers: string[]; pending: number };
  /** A Gherkin scenario: its feature file and line, keyword, Examples row, and each step's keyword, text and binding (definition / ez / undefined / ambiguous, location). */
  gherkin?: { file: string; line: number; keyword: string; examples?: string; steps: Array<[string, string, string?, string?]> };
  steps: StepModel[];
}

export interface Kpis {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  flaky: number;
  healed: number;
  skipped: number;
  /** Passed (healed and flaky included) / executed (skipped excluded), 0..1. */
  passRate: number;
  durationMs: number;
}

export interface TrendPoint {
  runId: string;
  startedAt: string;
  passRate: number;
  durationMs: number;
  total: number;
  failed: number;
  current?: boolean;
  /** Tests that passed only on retry. */
  flaky?: number;
  readiness?: string;
}

export interface FailureGroup {
  signature: string;
  message: string;
  tests: string[];
  known: boolean;
  firstSeenRun?: string;
  firstSeenAt?: string;
  category?: string;
  /** Report category of the group's first test, and its suggested fix. */
  cat?: FailureCategory;
  fix?: string;
}

export interface ClusterModel {
  id: string;
  size: number;
  message: string;
  tests: string[];
  cohesion: number;
  category?: string;
  cat?: FailureCategory;
  fix?: string;
}

export interface ComparisonModel {
  baselineRunId: string;
  baselineStartedAt: string;
  newlyFailing: Array<{ id: string; name: string; before: string; after: string }>;
  fixed: Array<{ id: string; name: string; before: string; after: string }>;
  stillFailing: Array<{ id: string; name: string }>;
  slower: Array<{ id: string; name: string; beforeMs: number; afterMs: number; ratio: number }>;
  faster: Array<{ id: string; name: string; beforeMs: number; afterMs: number; ratio: number }>;
  added: Array<{ id: string; name: string; state: TestState }>;
  removed: Array<{ id: string; name: string }>;
  kpis: { before: Kpis; after: Kpis };
}

export interface VerdictModel {
  decision: 'GO' | 'GO_WITH_RISKS' | 'NO_GO';
  score?: number;
  /** policy: a readiness policy decided; built-in: no policy is configured, EZTest's default rule decided. */
  source: 'policy' | 'built-in';
  reasons: Array<{ kind: string; text: string; gate?: string; tests: string[]; requirements: string[]; evidence: string[] }>;
  gates: Array<{ gate: string; status: string; severity: string; summary: string }>;
  exceptions: Array<{ gate: string; approver: string; reason: string }>;
  browsers?: Record<string, { decision: string; score: number; failed: string[] }>;
}

export interface CoverageModel {
  risk?: { covered: number; total: number; ratio: number };
  requirements?: { total: number; passing: number; failing: number; notRun: number; uncovered: number; ratio: number; items: Array<{ id: string; state: 'passing' | 'failing' | 'not-run' | 'uncovered'; tests: string[]; url?: string; title?: string }> };
  api?: Array<{ title: string; version: string; operations: number; covered: number; ratio: number; statusRatio: number; violations: number }>;
  ui?: { percent: number; tested: number; elements: number; pages: number };
}

export interface IntegrationView {
  ado?: {
    configured: boolean;
    collectionUrl?: string;
    project?: string;
    publish?: IntegrationsRecord extends { ado?: infer A } ? (A extends { publish?: infer P } ? P : never) : never;
    bugs: Array<{ journeyId: string; id: number; url?: string; action: string }>;
    build?: { id?: string; number?: string; url?: string };
    release?: { name?: string; url?: string; environment?: string };
    requirementsCommented: Array<{ requirement: string; action: string; url?: string }>;
  };
  pullRequest?: IntegrationsRecord['pullRequest'];
  jira?: IntegrationsRecord['jira'];
  notifications: NonNullable<IntegrationsRecord['notifications']>;
  resultsServer?: IntegrationsRecord['resultsServer'];
  publishers: NonNullable<IntegrationsRecord['publishers']>;
  git?: { branch?: string; commit?: string; commitUrl?: string; repository?: string; repositoryUrl?: string; codeowners: boolean };
}

export interface ReportModel {
  format: 'eztest-report-model';
  version: typeof REPORT_MODEL_VERSION;
  generatedAt: string;
  title: string;
  /** Branding (white label): names, embedded logos, palette, labels, hidden sections (brand.ts). */
  brand: ReportBrand;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  context?: RunContext;
  kpis: Kpis;
  previous?: { runId: string; startedAt: string; kpis: Kpis };
  /** The readiness policy's decision: only when a policy ran and report.readiness is on (the secondary Policy tab). */
  verdict?: VerdictModel;
  trend: TrendPoint[];
  slowest: Array<{ id: string; name: string; durationMs: number; state: TestState }>;
  failureGroups: FailureGroup[];
  clusters: ClusterModel[];
  coverage: CoverageModel;
  comparison?: ComparisonModel;
  integrations: IntegrationView;
  healProposals: HealProposal[];
  browsers?: { names: string[]; perBrowser: Record<string, { total: number; passed: number; failed: number; skipped: number; version?: string; decision?: string; score?: number }>; grid: Array<{ unit: string; cells: Array<{ browser: string; id?: string; state?: TestState }>; only: string[] }> };
  /** Evidence kinds referenced by the evidence map (index = the number in each entry). */
  evidenceKinds: string[];
  /** Evidence id -> EvidenceEntry. */
  evidence: Record<string, EvidenceEntry>;
  /** Time-travel DOM snapshots (sanitised, self-contained HTML; scripts and network access removed) by key. */
  snapshots?: Record<string, string>;
  /** The run's video policy (config `video`): off, on or retain-on-failure. */
  videoPolicy?: string;
  evidenceHead?: string;
  health?: { preflight?: { ok: boolean; failed: string[] }; circuit?: { afterJourney: string; reason: string; notRun: number } };
  tests: TestModel[];
  /** Failing and flaky tests per failure category. */
  categories?: Partial<Record<FailureCategory, number>>;
  /** Accessibility, security and performance lens findings of the run. */
  lenses?: LensSummary;
  /** The effective configuration, flattened, secrets masked. */
  config?: Array<[string, string]>;
  /** Static extra sections (API coverage tables) as escaped HTML. */
  extraHtml?: string[];
  /** The Gherkin feature / rule / scenario section (escaped HTML), when the run has `.feature` scenarios. */
  featuresHtml?: string;
  /** Where links point (kept so the model can be re-linked after publishing). */
  linkConfig: Pick<ReportModelInput, 'ado' | 'jira'>;
  warnings: string[];
}

/** Branding as callers pass it (assets already loaded as data: URIs; see brand.ts loadBrand). */
export type ReportBranding = Partial<ReportBrand>;

export interface StepArtifacts {
  /** `${journeyId}\u0000${stepId}` -> API entries. */
  api: Map<string, NetworkEntry[]>;
  /** journeyId -> network entries of the journey's browser log. */
  network: Map<string, NetworkEntry[]>;
  /** journeyId -> browser console entries (level, text, time, step). */
  console: Map<string, Array<{ l: string; t: string; at?: number; stepId?: string; loc?: string; ig?: number }>>;
  /** journeyId -> video chapters [start s, end s, text]. */
  chapters?: Map<string, Array<[number, number, string]>>;
  /** Evidence id -> file size and chain position (from the manifest). */
  evidenceMeta?: Map<string, { size?: number; seq?: number }>;
  /** journeyId -> the time-travel trace: per-step heal notes and snapshot keys, the requests and console of the attempt. */
  traces?: Map<string, { steps: Map<string, { notes?: string[]; sn?: { b?: string; a?: string } }>; network: Array<NetRow & { stepId?: string }>; console: Array<{ l: string; t: string; at?: number; stepId?: string; loc?: string }>; dir: string }>;
  /** Snapshot key -> sanitised HTML. */
  snapshots?: Map<string, string>;
  /** `${journeyId}\u0000${stepId}` -> visual comparisons. */
  visual?: Map<string, NonNullable<StepModel['vd']>>;
  /** journeyId -> trace zip files (traces/*.zip), relative to the run directory. */
  traceZips?: Map<string, string[]>;
  /** Lens findings recorded per step (lens-<name>-<step>.json). */
  lenses?: LensFile[];
}

export interface ReportModelInput {
  title?: string;
  brand?: ReportBranding;
  triage?: TriageReport;
  readiness?: ReadinessResult;
  /** Show the readiness decision (report.readiness): without it the report carries no verdict. */
  showPolicy?: boolean;
  flaky?: FlakyScore[];
  evidence?: EvidenceRef[];
  apiCoverage?: ApiCoverageReport[];
  context?: RunContext;
  history?: readonly RunHistoryEntry[];
  /** How many runs the trend shows (default 20). */
  trendRuns?: number;
  failureTags?: JourneyFailureTags[];
  baseline?: RunResult;
  integrations?: IntegrationsRecord;
  /** Azure DevOps configured for this project (test case links work without a publish). */
  ado?: { collectionUrl?: string; project?: string; testPlanId?: number; testSuiteId?: number };
  jira?: { baseUrl?: string };
  owners?: Record<string, string[]>;
  files?: Record<string, string>;
  artifacts?: StepArtifacts;
  /** Studio URL for "open trace in Studio" links (default http://localhost:4400 when the run has traces). */
  studioUrl?: string;
  uiCoverage?: { percent: number; tested: number; elements: number; pages: number };
  requirementsCatalog?: Array<{ id: string; title?: string; url?: string }>;
  extraHtml?: string[];
  /** Statuses of the journeys that only passed on retry or were mixed in burn-in. */
  flakyIds?: Iterable<string>;
  /** The video policy (config `video`), to explain a missing video. */
  videoPolicy?: string;
  /** The effective configuration (masked into the report's Configuration section). */
  config?: unknown;
}

const PASS = (s: string) => s === 'passed' || s === 'passed-healed';

export function testState(j: JourneyResult, flakyIds?: Set<string>): TestState {
  if (j.status === 'failed') return 'failed';
  if (j.status === 'error') return 'error';
  if (j.status === 'skipped') return 'skipped';
  if ((j.attempt > 1 && PASS(j.status)) || j.reliability?.flake || flakyIds?.has(j.journeyId)) return 'flaky';
  return j.status === 'passed-healed' ? 'healed' : 'passed';
}

export function kpisOf(journeys: JourneyResult[], durationMs: number, flakyIds?: Set<string>): Kpis {
  const k: Kpis = { total: 0, passed: 0, failed: 0, errors: 0, flaky: 0, healed: 0, skipped: 0, passRate: 0, durationMs };
  for (const j of journeys) {
    if (j.tags.includes('hook')) continue;
    k.total++;
    const s = testState(j, flakyIds);
    if (s === 'passed') k.passed++;
    else if (s === 'healed') k.healed++;
    else if (s === 'flaky') k.flaky++;
    else if (s === 'failed') k.failed++;
    else if (s === 'error') k.errors++;
    else k.skipped++;
  }
  const executed = k.total - k.skipped;
  k.passRate = executed ? (k.passed + k.healed + k.flaky) / executed : 0;
  return k;
}

function historyKpis(e: RunHistoryEntry): { passRate: number; durationMs: number; total: number; failed: number; flaky: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let flaky = 0;
  let dur = 0;
  const last = new Map<string, (typeof e.outcomes)[number]>();
  for (const o of e.outcomes) {
    const cur = last.get(o.journeyId);
    if (!cur || o.attempt >= cur.attempt) last.set(o.journeyId, o);
  }
  for (const o of last.values()) {
    dur += o.durationMs;
    if (PASS(o.status)) {
      passed++;
      if (o.attempt > 1 || o.flakeCause) flaky++;
    } else if (o.status === 'skipped') skipped++;
    else failed++;
  }
  const executed = last.size - skipped;
  return { passRate: executed ? passed / executed : 0, durationMs: e.durationMs ?? dur, total: last.size, failed, flaky };
}

/** Pass rate and duration of the last `n` runs of history (oldest first), this run marked current. */
export function trendFromHistory(history: readonly RunHistoryEntry[], run: RunResult, k: Kpis, n = 20): TrendPoint[] {
  const pts: TrendPoint[] = history
    .filter((h) => h.runId !== run.runId)
    .map((h) => ({ runId: h.runId, startedAt: h.startedAt, ...historyKpis(h), ...(h.readiness ? { readiness: h.readiness } : {}) }));
  pts.push({ runId: run.runId, startedAt: run.startedAt, passRate: k.passRate, durationMs: k.durationMs, total: k.total, failed: k.failed + k.errors, flaky: k.flaky, current: true });
  pts.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return pts.slice(-n);
}

/** Row values of an Examples / data-driven journey ("Login [user=alice, role=admin]"). */
export function dataRowOf(name: string): Record<string, string> | undefined {
  const m = /\[([^\]]*=[^\]]*)\]\s*$/.exec(name);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const kv of m[1].split(/,\s*/)) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function condText(c: StepResult['conditions'][number]): string {
  const { type, ...rest } = c.condition as unknown as Record<string, unknown>;
  const args = Object.values(rest).filter((v) => typeof v === 'string' || typeof v === 'number').join(' ');
  return `${String(type)}${args ? ` ${args}` : ''}`.slice(0, 240);
}

const trunc = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

function dbTable(captured: Record<string, unknown> | undefined): StepModel['db'] {
  if (!captured) return undefined;
  for (const [key, v] of Object.entries(captured)) {
    const rows = Array.isArray(v) ? v : v && typeof v === 'object' && !Array.isArray(v) && !('status' in (v as object)) && Object.values(v as object).every((x) => x === null || typeof x !== 'object') ? [v] : undefined;
    if (!rows || !rows.length || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) continue;
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r as object)))].slice(0, 30);
    const shown = rows.slice(0, 50).map((r) => columns.map((c) => {
      const x = (r as Record<string, unknown>)[c];
      return x === null || typeof x !== 'object' ? x : JSON.stringify(x);
    }));
    return { key, columns, rows: shown, total: rows.length };
  }
  return undefined;
}

function stepModel(s: StepResult, testStart: number, art: StepArtifacts | undefined, journeyId: string): StepModel {
  const st = Date.parse(s.startedAt);
  const m: StepModel = { n: s.intent, s: STEP_CODE[s.status] ?? 'S', d: s.durationMs, t: Number.isFinite(st) && Number.isFinite(testStart) ? Math.max(0, st - testStart) : 0 };
  if (s.evidence.length) m.e = s.evidence;
  if (s.error) m.x = { ...(s.error.name ? { name: s.error.name } : {}), message: trunc(s.error.message, 4000)!, ...(s.error.stack ? { stack: trunc(s.error.stack, 4000) } : {}), headline: failureHeadline(s.error.message) };
  if (s.heal) m.h = { tier: s.heal.tier, from: s.heal.original.map(formatLocator), to: formatLocator(s.heal.healed), confidence: s.heal.confidence, verified: s.heal.verified, reason: s.heal.reason, evidence: s.heal.evidence, ...(s.heal.element ? { element: s.heal.element } : {}) };
  if (s.conditions.length) m.c = s.conditions.map((c) => [condText(c), c.passed, String(c.actual ?? c.message ?? '').slice(0, 300)]);
  if (s.usedLocator) m.l = formatLocator(s.usedLocator);
  if (s.actor) m.a = s.actor;
  if (s.iteration) m.i = s.iteration;
  if (s.branch && s.branch !== 'body') m.b = s.branch;
  if (s.soft) m.so = 1;
  if (s.warnings?.length) m.w = s.warnings;
  if (s.diagnosis) m.dg = { expected: s.diagnosis.expected, found: s.diagnosis.found, similar: s.diagnosis.similar.slice(0, 5).map((x) => `${x.locator} (${x.description})`), consoleErrors: s.diagnosis.consoleErrors.slice(0, 10), failedRequests: s.diagnosis.failedRequests.slice(0, 10), ...(s.diagnosis.url ? { url: s.diagnosis.url } : {}), ...(s.diagnosis.screenshot ? { screenshot: s.diagnosis.screenshot } : {}) };
  const db = dbTable(s.captured);
  if (db) m.db = db;
  const api = art?.api.get(`${journeyId}\u0000${s.stepId}`);
  if (api?.length) {
    m.api = api.slice(0, 5).map((a) => ({
      method: a.method, url: a.url, status: a.status, ...(typeof a.timing === 'number' ? { ms: a.timing } : a.timing?.duration !== undefined ? { ms: a.timing.duration } : {}),
      ...(a.requestBody !== undefined ? { requestBody: trunc(a.requestBody, 8000) } : {}), ...(a.responseBody !== undefined ? { responseBody: trunc(a.responseBody, 8000) } : {}),
      ...(a.responseHeaders ? { responseHeaders: a.responseHeaders } : {}),
    }));
  }
  if (s.improvement) m.im = { suggested: formatLocator(s.improvement.suggested), reason: s.improvement.reason };
  if (s.manual) m.m = { verdict: s.manual.verdict, ...(s.manual.tester ? { tester: s.manual.tester } : {}), ...(s.manual.actual ? { actual: s.manual.actual } : {}), ...(s.manual.notes ? { notes: s.manual.notes } : {}) };
  const tr = art?.traces?.get(journeyId)?.steps.get(s.stepId);
  if (tr?.sn) m.sn = tr.sn;
  if (tr?.notes?.length && !s.heal && (s.status === 'failed' || s.status === 'blocked')) m.hn = tr.notes;
  const vd = art?.visual?.get(`${journeyId}\u0000${s.stepId}`);
  if (vd?.length) m.vd = vd;
  if (s.children?.length) m.ch = s.children.map((c) => stepModel(c, testStart, art, journeyId));
  return m;
}

function allSteps(steps: StepResult[]): StepResult[] {
  return steps.flatMap((s) => [s, ...allSteps(s.children ?? [])]);
}

function failingStepOf(j: JourneyResult): StepResult | undefined {
  const walk = (list: StepResult[]): StepResult | undefined => {
    for (const s of list) {
      if ((s.status === 'failed' || s.status === 'blocked') && !s.soft) return (s.children?.length ? walk(s.children) : undefined) ?? s;
    }
    return undefined;
  };
  return walk(j.steps);
}

const commonDir = (files: string[]): string[] => {
  const parts = files.map((f) => f.split(/[\\/]/).slice(0, -1));
  if (!parts.length) return [];
  let n = 0;
  while (parts.every((p) => p[n] !== undefined && p[n] === parts[0][n])) n++;
  return parts[0].slice(0, n);
};

/** The unit a cross-browser result belongs to ("checkout@firefox" -> "checkout"). */
export function unitOf(j: Pick<JourneyResult, 'journeyId' | 'browser'>): string {
  return j.browser && j.journeyId.endsWith(`@${j.browser}`) ? j.journeyId.slice(0, -(j.browser.length + 1)) : j.journeyId;
}

function verdictOf(r: ReadinessResult): VerdictModel {
  return {
    decision: r.decision,
    score: r.score,
    source: 'policy',
    reasons: r.rationale.map((x) => ({ kind: x.kind, text: x.text, ...(x.gate ? { gate: x.gate } : {}), tests: x.cites.journeys, requirements: x.cites.requirements, evidence: x.cites.evidence })),
    gates: r.gates.map((g) => ({ gate: g.gate, status: g.status, severity: String(g.severity), summary: g.summary })),
    exceptions: r.exceptionsApplied.map((x) => ({ gate: String(x.gate), approver: String(x.approver), reason: String(x.reason) })),
    ...(r.browsers ? { browsers: r.browsers } : {}),
  };
}

/** Compare a run to a baseline run: newly failing, fixed, slower / faster (>= 1.5x and >= 500 ms), added and removed tests. */
export function compareRunResults(base: RunResult, cur: RunResult): ComparisonModel {
  const idx = (r: RunResult) => new Map(r.journeys.filter((j) => !j.tags.includes('hook')).map((j) => [j.journeyId, j]));
  const a = idx(base);
  const b = idx(cur);
  const FAIL = (s: string) => s === 'failed' || s === 'error';
  const out: ComparisonModel = {
    baselineRunId: base.runId, baselineStartedAt: base.startedAt, newlyFailing: [], fixed: [], stillFailing: [], slower: [], faster: [], added: [], removed: [],
    kpis: { before: kpisOf(base.journeys, base.durationMs), after: kpisOf(cur.journeys, cur.durationMs) },
  };
  for (const [id, j] of b) {
    const p = a.get(id);
    if (!p) {
      out.added.push({ id, name: j.name, state: testState(j) });
      continue;
    }
    if (FAIL(j.status) && !FAIL(p.status)) out.newlyFailing.push({ id, name: j.name, before: p.status, after: j.status });
    else if (!FAIL(j.status) && FAIL(p.status) && j.status !== 'skipped') out.fixed.push({ id, name: j.name, before: p.status, after: j.status });
    else if (FAIL(j.status) && FAIL(p.status)) out.stillFailing.push({ id, name: j.name });
    if (j.status !== 'skipped' && p.status !== 'skipped' && p.durationMs > 0) {
      const ratio = j.durationMs / p.durationMs;
      const row = { id, name: j.name, beforeMs: p.durationMs, afterMs: j.durationMs, ratio: Math.round(ratio * 100) / 100 };
      if (ratio >= 1.5 && j.durationMs - p.durationMs >= 500) out.slower.push(row);
      else if (ratio <= 1 / 1.5 && p.durationMs - j.durationMs >= 500) out.faster.push(row);
    }
  }
  for (const [id, p] of a) if (!b.has(id)) out.removed.push({ id, name: p.name });
  out.slower.sort((x, y) => y.ratio - x.ratio);
  out.faster.sort((x, y) => x.ratio - y.ratio);
  return out;
}

function evidenceMap(evidence: EvidenceRef[] | undefined, o: { t0: number; meta?: StepArtifacts['evidenceMeta']; where: (r: EvidenceRef) => [number, number] }): { kinds: string[]; map: Record<string, EvidenceEntry> } {
  const kinds: string[] = [];
  const kindIdx = new Map<string, number>();
  const map: Record<string, EvidenceEntry> = {};
  for (const [i, r] of (evidence ?? []).entries()) {
    let k = kindIdx.get(r.kind);
    if (k === undefined) {
      k = kinds.length;
      kinds.push(r.kind);
      kindIdx.set(r.kind, k);
    }
    const url = safeRelativeUrl(r.path) ?? null;
    const meta = o.meta?.get(r.id);
    const at = Date.parse(r.createdAt);
    const [test, step] = o.where(r);
    map[r.id] = [k, url, r.description ?? '', meta?.size ?? null, Number.isFinite(at) && Number.isFinite(o.t0) ? at - o.t0 : null, r.sha256 ?? '', meta?.seq ?? i + 1, test, step];
  }
  return { kinds, map };
}

/** Step numbers in pre-order (the order the report lists steps): stepId -> first number. */
function stepNumbers(steps: StepResult[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  const walk = (list: StepResult[]) => {
    for (const s of list) {
      n++;
      if (!out.has(s.stepId)) out.set(s.stepId, n);
      walk(s.children ?? []);
    }
  };
  walk(steps);
  return out;
}

function suiteOf(j: JourneyResult, file: string | undefined, root: string[], perFile?: Map<string, number>): string[] {
  const sp = j.suitePath;
  if (Array.isArray(sp) && sp.length) return sp.map((s) => s.name).filter(Boolean);
  // Gherkin scenarios: feature, then rule.
  if (j.bdd) return [j.bdd.feature.name || j.bdd.file, ...(j.bdd.rule ? [j.bdd.rule.name] : [])];
  if (file) {
    const parts = file.split(/[\\/]/);
    const rel = parts.slice(root.length);
    const base = rel.pop() ?? '';
    // A file with one journey is not a level of its own: the folder is the suite.
    const own = (perFile?.get(file) ?? 2) > 1 || rel.length === 0;
    return [...rel, ...(own ? [base.replace(/\.(ez|ya?ml|json|[cm]?[jt]s)$/i, '')] : [])].filter(Boolean);
  }
  const tag = j.tags.find((t) => !/^@?(TestCaseId|TestPlanId|TestSuiteId|hook|library)\b/i.test(t));
  return [tag ? tag.replace(/^@/, '') : 'Ungrouped'];
}

/** Build the report model of a run. */
export function buildReportModel(run: RunResult, input: ReportModelInput = {}): ReportModel {
  const t0 = Date.parse(run.startedAt);
  const flakySet = new Set(input.flakyIds ?? []);
  const results = run.journeys.filter((j) => !j.tags.includes('hook'));
  const k = kpisOf(run.journeys, run.durationMs, flakySet);
  const flakyMap = new Map((input.flaky ?? []).map((f) => [f.journeyId, f]));
  const triageMap = new Map((input.triage?.verdicts ?? []).map((v) => [v.journeyId, v]));
  const tagMap = new Map((input.failureTags ?? []).map((t) => [t.journeyId, t]));
  const testIdx = new Map(results.map((j, i) => [j.journeyId, i]));
  const stepNos = new Map(results.map((j) => [j.journeyId, stepNumbers(j.steps)]));
  const ev = evidenceMap(input.evidence, {
    t0, meta: input.artifacts?.evidenceMeta,
    where: (r) => {
      const ti = r.journeyId !== undefined ? testIdx.get(r.journeyId) : undefined;
      if (ti === undefined) return [-1, 0];
      return [ti, (r.stepId && stepNos.get(r.journeyId!)?.get(r.stepId)) || 0];
    },
  });
  const evRefs = new Map((input.evidence ?? []).map((r) => [r.id, r]));
  // The policy comes from the config at analysis time; videos in the run show recording was on (EZTEST_VIDEO).
  const runHasVideo = (input.evidence ?? []).some((r) => r.kind === 'video');
  const evByJourney = new Map<string, EvidenceRef[]>();
  for (const r of input.evidence ?? []) if (r.journeyId) evByJourney.set(r.journeyId, [...(evByJourney.get(r.journeyId) ?? []), r]);
  // failure signatures, first seen in history
  const history = [...(input.history ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const firstSeen = new Map<string, { runId: string; startedAt: string }>();
  for (const h of history) for (const o of h.outcomes) if (o.signature && !firstSeen.has(o.signature)) firstSeen.set(o.signature, { runId: h.runId, startedAt: h.startedAt });
  const files = input.files ?? {};
  const fileList = Object.values(files);
  const root = commonDir(fileList);
  const perFile = new Map<string, number>();
  for (const j of results) {
    const f = files[j.journeyId] ?? files[unitOf(j)];
    if (f) perFile.set(f, (perFile.get(f) ?? 0) + 1);
  }
  const fileFor = (id: string, unit: string) => files[id] ?? files[unit] ?? Object.entries(files).find(([k2]) => unit.startsWith(`${k2}-`))?.[1];
  const ownersFor = (id: string, unit: string) => input.owners?.[id] ?? input.owners?.[unit] ?? Object.entries(input.owners ?? {}).find(([k2]) => unit.startsWith(`${k2}-`))?.[1] ?? [];
  const hasTraceDir = (input.evidence ?? []).some((e) => e.kind === 'trace' || e.path.startsWith('trace/'));
  const studio = safeHttpUrl(input.studioUrl ?? (hasTraceDir ? 'http://localhost:4400' : undefined))?.replace(/\/+$/, '');

  const tests: TestModel[] = [];
  const failing: Array<{ id: string; message: string; stack?: string; name?: string }> = [];
  for (const j of results) {
    const unit = unitOf(j);
    const state = testState(j, flakySet);
    const start = Date.parse(j.startedAt);
    const f = failingStepOf(j);
    const err = f?.error ?? j.error;
    const file = fileFor(j.journeyId, unit);
    const fs = flakyMap.get(j.journeyId) ?? flakyMap.get(unit);
    const tv = triageMap.get(j.journeyId);
    const ft = tagMap.get(j.journeyId);
    let signature: string | undefined;
    let failure: TestModel['failure'];
    if ((state === 'failed' || state === 'error') && err) {
      signature = failureSignature({ message: err.message, stack: err.stack, name: err.name }).hash;
      const seen = firstSeen.get(signature);
      const known = !!seen && seen.runId !== run.runId;
      failure = { known, ...(known ? { firstSeenRun: seen!.runId, firstSeenAt: seen!.startedAt } : {}), tags: ft?.tags ?? [], ...(ft ? { streak: ft.failingStreak } : {}) };
      failing.push({ id: j.journeyId, message: err.message, stack: err.stack, name: err.name });
    }
    const evOf = (kind: string) => j.evidence.map((id) => evRefs.get(id)).find((r): r is EvidenceRef => !!r && r.kind === kind);
    const mine = evByJourney.get(j.journeyId) ?? [];
    const video = evOf('video') ?? mine.find((r) => r.kind === 'video');
    const chapters = evOf('video-chapters') ?? mine.find((r) => r.kind === 'video-chapters');
    const traceRef = evOf('trace') && /\.zip$/i.test(evOf('trace')!.path) ? evOf('trace') : mine.find((r) => r.kind === 'trace' && /\.zip$/i.test(r.path));
    const vsrc = video ? safeRelativeUrl(video.path) : undefined;
    // Every video of the journey: one per attempt (and per actor or page), with its chapters.
    const videos = mine.filter((r) => r.kind === 'video').map((r) => {
      const dir = r.path.split('/').slice(0, -1).join('/');
      const ch = mine.find((c) => c.kind === 'video-chapters' && c.path.startsWith(`${dir}/`));
      const att = /attempt-?(\d+)/i.exec(r.path)?.[1];
      const cues = ch ? input.artifacts?.chapters?.get(`${j.journeyId}\u0000${ch.id}`) ?? (ch === chapters ? input.artifacts?.chapters?.get(j.journeyId) : undefined) : undefined;
      return { src: safeRelativeUrl(r.path)!, label: `${att ? `Attempt ${att}` : 'Video'}${r.description && !/^video of the journey attempt$/i.test(r.description) ? ` - ${r.description}` : ''}`, ...(ch && safeRelativeUrl(ch.path) ? { chapters: safeRelativeUrl(ch.path)! } : {}), ...(cues?.length ? { cues } : {}) };
    }).filter((v) => v.src);
    // Poster: the failing step's screenshot, else the last screenshot of the test.
    const shotOf = (st: StepResult | undefined) => st?.evidence.map((id) => evRefs.get(id)).find((r) => r?.kind === 'screenshot');
    const lastShot = [...allSteps(j.steps)].reverse().map(shotOf).find(Boolean);
    const posterRef = shotOf(f) ?? lastShot;
    const poster = posterRef ? safeRelativeUrl(posterRef.path) : undefined;
    const tr = input.artifacts?.traces?.get(j.journeyId);
    const nums = stepNos.get(j.journeyId)!;
    const net = input.artifacts?.network.get(j.journeyId);
    let network: TestModel['network'];
    let waterfall: NetRow[] | undefined;
    const interesting = state === 'failed' || state === 'error' || state === 'flaky';
    if (interesting && tr?.network.length) {
      waterfall = tr.network.slice(0, 300).map(({ stepId, ...x }) => ({ ...x, ...(stepId && nums.get(stepId) ? { step: nums.get(stepId) } : {}) }));
    } else if (interesting && net?.length) {
      waterfall = net.slice(0, 300).map((x) => {
        const raw = x as NetworkEntry & { startedAt?: number | string; durationMs?: number; resourceType?: string };
        const at = typeof raw.startedAt === 'number' ? raw.startedAt : typeof raw.startedAt === 'string' ? Date.parse(raw.startedAt) : NaN;
        const dur = raw.durationMs ?? (typeof x.timing === 'number' ? x.timing : x.timing?.duration);
        return { m: x.method, u: x.url, ...(x.status ? { s: x.status } : {}), st: Number.isFinite(at) && Number.isFinite(start) ? Math.max(0, at - start) : 0, ...(dur !== undefined ? { d: dur } : {}), ...(raw.resourceType ? { ty: raw.resourceType } : {}), ...(x.failure ? { f: x.failure } : {}), ...(x.stepId && nums.get(x.stepId) ? { step: nums.get(x.stepId) } : {}), ...(x.requestHeaders ? { rq: x.requestHeaders } : {}), ...(x.responseHeaders ? { rs: x.responseHeaders } : {}) };
      });
    }
    if (net?.length && (state === 'failed' || state === 'error')) {
      const mineNet = f ? net.filter((x) => x.stepId === f.stepId) : [];
      const pick = (mineNet.length ? mineNet : net.slice(-15)).slice(-15);
      network = pick.map((x) => ({ method: x.method, url: x.url, status: x.status, ...(typeof x.timing === 'number' ? { ms: x.timing } : x.timing?.duration !== undefined ? { ms: x.timing.duration } : {}), ...(x.failure ? { failure: x.failure } : {}) }));
    }
    const rawCon = interesting ? (tr?.console.length ? tr.console : input.artifacts?.console.get(j.journeyId)) : undefined;
    const con = rawCon?.slice(-200).map(({ stepId, ...c }) => ({ ...c, ...(stepId && nums.get(stepId) ? { step: nums.get(stepId) } : {}) }));
    const zips = input.artifacts?.traceZips?.get(j.journeyId) ?? [];
    const traceFile = traceRef && safeRelativeUrl(traceRef.path) ? safeRelativeUrl(traceRef.path)! : zips[0] ? safeRelativeUrl(zips[0]) : undefined;
    const studioLink = studio && (traceRef || hasTraceDir || zips.length || tr) ? `${studio}/#/runs/${encodeURIComponent(run.runId)}/${encodeURIComponent(j.journeyId)}${f ? `/${encodeURIComponent(f.stepId)}` : ''}/trace` : undefined;
    const traceInfo = traceFile || studioLink || tr ? { ...(traceFile ? { file: traceFile } : {}), ...(studioLink ? { studio: studioLink } : {}), ...(tr ? { dir: tr.dir, cmd: `eztest trace steps <runDir> ${j.journeyId}` } : {}) } : undefined;
    const videoNote = vsrc ? undefined : runHasVideo && input.videoPolicy !== 'retain-on-failure' ? 'No video was recorded for this test (it did not open a browser page, or it ran outside the recorded attempt).' : input.videoPolicy === 'off' || !input.videoPolicy ? 'No video: recording is off (video: off in eztest.config.yaml; set video: on or retain-on-failure, or EZTEST_VIDEO=on).' : input.videoPolicy === 'retain-on-failure' ? (state === 'failed' || state === 'error' ? 'No video was kept for this test.' : 'No video: with video: retain-on-failure, videos are kept only for attempts that did not pass.') : 'No video was recorded for this test (it did not open a browser page).';
    const steps = j.steps.map((s) => stepModel(s, start, input.artifacts, j.journeyId));
    const actors = [...new Set(allSteps(j.steps).map((s) => s.actor).filter((a): a is string => !!a))];
    const row = dataRowOf(j.name);
    const attempts = (j as JourneyResult & { attempts?: Array<{ attempt: number; status: string; durationMs: number; failedStepId?: string; error?: string; steps: Array<{ stepId: string; intent?: string; status: StepResult['status']; durationMs: number }> }> }).attempts;
    tests.push({
      id: j.journeyId,
      name: j.name,
      state,
      status: j.status,
      durationMs: j.durationMs,
      startMs: Number.isFinite(start) && Number.isFinite(t0) ? Math.max(0, start - t0) : 0,
      tags: j.tags,
      requirements: j.requirements,
      risk: j.risk,
      attempt: j.attempt,
      ...(j.browser ? { browser: j.browser } : {}),
      owners: ownersFor(j.journeyId, unit),
      ...(file ? { file } : {}),
      suite: suiteOf(j, file, root, perFile),
      ...(err ? { error: { ...(err.name ? { name: err.name } : {}), message: trunc(err.message, 4000)!, ...(err.stack ? { stack: trunc(err.stack, 4000) } : {}), headline: failureHeadline(err.message) } } : {}),
      ...(f ? { failedStep: f.intent } : {}),
      ...(signature ? { signature } : {}),
      ...(failure ? { failure } : {}),
      ...(tv ? { triage: { category: tv.category, confidence: tv.confidence, status: tv.status, reasons: tv.reasons, evidence: tv.evidence, ...(tv.secondOpinion ? { secondOpinion: `${tv.secondOpinion.category} (${Math.round(tv.secondOpinion.confidence * 100)}%): ${tv.secondOpinion.reason}` } : {}) } } : {}),
      ...(fs && fs.samples ? { history: { state: fs.state, sequence: fs.sequence.slice(-30), failRate: fs.failRate, samples: fs.samples, reasons: fs.reasons, flips: fs.flips } } : {}),
      ...(j.reliability?.flake ? { flake: { cause: j.reliability.flake.cause, reason: j.reliability.flake.reason, confidence: j.reliability.flake.confidence } } : {}),
      heals: allSteps(j.steps).filter((s) => s.heal).length,
      bugs: [],
      requirementLinks: j.requirements.map((r) => ({ id: r })),
      ...(row ? { row } : {}),
      actors,
      ...(vsrc ? { video: { src: vsrc, ...(chapters && safeRelativeUrl(chapters.path) ? { chapters: safeRelativeUrl(chapters.path)! } : {}), ...(input.artifacts?.chapters?.get(j.journeyId)?.length ? { cues: input.artifacts.chapters.get(j.journeyId)! } : {}) } } : {}),
      ...(videos.length > 1 ? { videos } : {}),
      ...(poster && vsrc ? { poster } : {}),
      ...(videoNote ? { videoNote } : {}),
      ...(traceInfo ? { trace: traceInfo } : {}),
      ...(waterfall?.length ? { waterfall } : {}),
      ...(attempts?.length ? { attempts: attempts.map((a) => ({ attempt: a.attempt, status: a.status, durationMs: a.durationMs, ...(a.failedStepId ? { failedStep: a.failedStepId } : {}), ...(a.error ? { error: trunc(a.error, 600) } : {}), steps: a.steps.map((s) => [s.intent ?? s.stepId, STEP_CODE[s.status] ?? 'S', s.durationMs] as [string, StepCode, number]) })) } : {}),
      ...(network?.length ? { network } : {}),
      ...(con?.length ? { console: con } : {}),
      ...(j.manual ? { manual: { type: j.manual.type, testers: j.manual.testers, pending: j.manual.pending } } : {}),
      steps,
    });
  }

  // failure categories (triage when confident, else the report's rules)
  const categories: Partial<Record<FailureCategory, number>> = {};
  for (const t of tests) {
    const cat = categoriseFailure({ state: t.state, ...(t.error ? { error: t.error } : {}), ...(t.failedStep ? { failedStep: t.failedStep } : {}), ...(t.triage ? { triage: t.triage } : {}), ...(t.flake ? { flakeReason: t.flake.reason } : {}) });
    if (!cat) continue;
    t.cat = cat;
    categories[cat.c] = (categories[cat.c] ?? 0) + 1;
  }

  // failure groups (exact signature) and clusters (similar messages)
  const groups = new Map<string, FailureGroup>();
  for (const t of tests) {
    if (!t.signature) continue;
    const g = groups.get(t.signature) ?? { signature: t.signature, message: (t.error?.message ?? '').split('\n')[0].slice(0, 300), tests: [], known: !!t.failure?.known, ...(t.failure?.firstSeenRun ? { firstSeenRun: t.failure.firstSeenRun, firstSeenAt: t.failure.firstSeenAt } : {}), ...(t.triage ? { category: t.triage.category } : {}), ...(t.cat ? { cat: t.cat.c, fix: t.cat.fix } : {}) };
    g.tests.push(t.id);
    groups.set(t.signature, g);
  }
  const failureGroups = [...groups.values()].sort((a, b) => b.tests.length - a.tests.length || Number(a.known) - Number(b.known));
  const rawClusters = input.triage?.clusters?.length ? input.triage.clusters : failing.length ? clusterFailures(failing) : [];
  const byId = new Map(tests.map((t) => [t.id, t]));
  const clusters: ClusterModel[] = rawClusters
    .map((c, i) => ({ id: `C${i + 1}`, size: c.size, message: (c.representative.message ?? c.normalized).split('\n')[0].slice(0, 300), tests: c.members, cohesion: Math.round(c.cohesion * 100) / 100, ...(byId.get(c.members[0])?.triage ? { category: byId.get(c.members[0])!.triage!.category } : {}), ...(byId.get(c.members[0])?.cat ? { cat: byId.get(c.members[0])!.cat!.c, fix: byId.get(c.members[0])!.cat!.fix } : {}) }))
    .sort((a, b) => b.size - a.size);
  for (const c of clusters) for (const m of c.tests) {
    const t = byId.get(m);
    if (t) t.cluster = c.id;
  }

  // coverage
  const coverage: CoverageModel = {};
  const riskTotal = tests.reduce((n, t) => n + Math.max(0, t.risk || 0), 0);
  if (riskTotal > 0) {
    const covered = tests.filter((t) => t.state === 'passed' || t.state === 'healed' || t.state === 'flaky').reduce((n, t) => n + Math.max(0, t.risk || 0), 0);
    coverage.risk = { covered, total: riskTotal, ratio: covered / riskTotal };
  }
  const reqs = new Map<string, { tests: string[]; states: TestState[] }>();
  for (const t of tests) for (const r of t.requirements) {
    const x = reqs.get(r) ?? { tests: [], states: [] };
    x.tests.push(t.id);
    x.states.push(t.state);
    reqs.set(r, x);
  }
  for (const c of input.requirementsCatalog ?? []) if (!reqs.has(c.id)) reqs.set(c.id, { tests: [], states: [] });
  if (reqs.size) {
    const items: NonNullable<CoverageModel['requirements']>['items'] = [...reqs.entries()].map(([id, x]) => {
      const cat = input.requirementsCatalog?.find((c) => c.id === id);
      const state = !x.tests.length ? 'uncovered' : x.states.some((s) => s === 'failed' || s === 'error') ? 'failing' : x.states.every((s) => s === 'skipped') ? 'not-run' : 'passing';
      return { id, state, tests: x.tests, ...(safeHttpUrl(cat?.url) ? { url: safeHttpUrl(cat?.url) } : {}), ...(cat?.title ? { title: cat.title } : {}) } as NonNullable<CoverageModel['requirements']>['items'][number];
    }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const count = (s: string) => items.filter((i) => i.state === s).length;
    coverage.requirements = { total: items.length, passing: count('passing'), failing: count('failing'), notRun: count('not-run'), uncovered: count('uncovered'), ratio: items.length ? count('passing') / items.length : 0, items };
  }
  if (input.apiCoverage?.length) coverage.api = input.apiCoverage.map((c) => ({ title: c.spec.title, version: c.spec.version, operations: c.totals.operations, covered: c.totals.coveredOperations, ratio: c.totals.operationRatio, statusRatio: c.totals.statusRatio, violations: c.totals.violations }));
  if (input.uiCoverage) coverage.ui = input.uiCoverage;

  // previous run (from history)
  const prevEntry = history.filter((h) => h.runId !== run.runId && h.startedAt < run.startedAt).pop();
  let previous: ReportModel['previous'];
  if (prevEntry) {
    const hk = historyKpis(prevEntry);
    const pk: Kpis = { total: hk.total, passed: 0, failed: 0, errors: 0, flaky: 0, healed: 0, skipped: 0, passRate: hk.passRate, durationMs: hk.durationMs };
    const last = new Map<string, (typeof prevEntry.outcomes)[number]>();
    for (const o of prevEntry.outcomes) if (!last.get(o.journeyId) || o.attempt >= last.get(o.journeyId)!.attempt) last.set(o.journeyId, o);
    for (const o of last.values()) {
      if (o.status === 'passed') (o.attempt > 1 || o.flakeCause ? pk.flaky++ : pk.passed++);
      else if (o.status === 'passed-healed') (o.attempt > 1 || o.flakeCause ? pk.flaky++ : pk.healed++);
      else if (o.status === 'failed') pk.failed++;
      else if (o.status === 'error') pk.errors++;
      else pk.skipped++;
    }
    previous = { runId: prevEntry.runId, startedAt: prevEntry.startedAt, kpis: pk };
  }

  // Gherkin scenarios: feature file, keyword, Examples row and step bindings, for the test detail.
  const testById = results.some((j) => j.bdd) ? new Map(tests.map((x) => [x.id, x])) : undefined;
  for (const j of testById ? results : []) {
    if (!j.bdd) continue;
    const t = testById!.get(j.journeyId);
    if (!t) continue;
    const sc = scenarioEntry(j);
    t.gherkin = {
      file: j.bdd.file, line: sc.line, keyword: sc.keyword,
      ...(sc.examples ? { examples: `${sc.examples.name || 'Examples'}, row ${(sc.examples.row?.index ?? 0) + 1}` } : {}),
      steps: sc.steps.map((s): [string, string, string?, string?] => [s.keyword, s.text, ...(s.match ? [s.match] : []), ...(s.location ? [s.location] : [])] as [string, string, string?, string?]),
    };
  }

  // cross-browser matrix
  let browsers: ReportModel['browsers'];
  if (run.browsers && Object.keys(run.browsers).length >= 2) {
    const names = Object.keys(run.browsers);
    const perBrowser: NonNullable<ReportModel['browsers']>['perBrowser'] = {};
    for (const b of names) {
      const x = run.browsers[b];
      const rb = input.readiness?.browsers?.[b];
      perBrowser[b] = { total: x.total, passed: x.passed + x.passedHealed, failed: x.failed + x.errors, skipped: x.skipped, ...(x.version ? { version: x.version } : {}), ...(rb ? { decision: rb.decision, score: rb.score } : {}) };
    }
    const units = results.filter((j) => j.browser && names.includes(j.browser));
    const ids = [...new Set(units.map(unitOf))];
    const grid = ids.map((unit) => {
      const cells = names.map((b) => {
        const u = units.find((j) => j.browser === b && unitOf(j) === unit);
        return { browser: b, ...(u ? { id: u.journeyId, state: testState(u, flakySet) } : {}) };
      });
      const st = cells.map((c) => c.state).filter(Boolean) as TestState[];
      const ok = (s?: TestState) => s === 'passed' || s === 'healed' || s === 'flaky';
      const only = st.some(ok) && st.some((s) => !ok(s) && s !== 'skipped') ? cells.filter((c) => c.state && !ok(c.state) && c.state !== 'skipped').map((c) => c.browser) : [];
      return { unit, cells, only };
    });
    browsers = { names, perBrowser, grid };
  }

  const health: ReportModel['health'] = run.health
    ? {
        ...(run.health.preflight ? { preflight: { ok: run.health.preflight.ok, failed: run.health.preflight.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.message}`) } } : {}),
        ...(run.health.circuit ? { circuit: { afterJourney: run.health.circuit.afterJourney, reason: run.health.circuit.reason, notRun: run.health.circuit.notRun } } : {}),
      }
    : undefined;

  const lenses = input.artifacts?.lenses?.length ? summariseLenses(input.artifacts.lenses) : undefined;
  const brandWarnings: string[] = [];
  const brand = normalizeBrand(input.brand ?? {}, brandWarnings);
  const brandName = brand.name;
  const model: ReportModel = {
    format: 'eztest-report-model',
    version: REPORT_MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    title: input.title ?? `${brandName} test report`,
    brand,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    ...(input.context ? { context: input.context } : {}),
    kpis: k,
    ...(previous ? { previous } : {}),
    ...(input.readiness && input.showPolicy ? { verdict: verdictOf(input.readiness) } : {}),
    trend: trendFromHistory(history, run, k, input.trendRuns ?? 20),
    slowest: [...tests].filter((t) => t.state !== 'skipped').sort((a, b) => b.durationMs - a.durationMs).slice(0, 10).map((t) => ({ id: t.id, name: t.name, durationMs: t.durationMs, state: t.state })),
    failureGroups,
    clusters,
    coverage,
    ...(input.baseline ? { comparison: compareRunResults(input.baseline, run) } : {}),
    integrations: { notifications: [], publishers: [] },
    healProposals: healProposals(run),
    ...(browsers ? { browsers } : {}),
    evidenceKinds: ev.kinds,
    evidence: ev.map,
    ...(run.evidenceHead ? { evidenceHead: run.evidenceHead } : {}),
    ...(health && (health.preflight || health.circuit) ? { health } : {}),
    tests,
    ...(Object.keys(categories).length ? { categories: Object.fromEntries(FAILURE_CATEGORIES.filter((c) => categories[c]).map((c) => [c, categories[c]])) } : {}),
    ...(lenses ? { lenses } : {}),
    ...(input.config ? { config: configSnapshot(input.config) } : {}),
    ...(input.extraHtml?.length ? { extraHtml: input.extraHtml } : {}),
    linkConfig: { ...(input.ado ? { ado: input.ado } : {}), ...(input.jira ? { jira: input.jira } : {}) },
    ...(input.artifacts?.snapshots?.size ? { snapshots: Object.fromEntries(input.artifacts.snapshots) } : {}),
    ...(input.videoPolicy ? { videoPolicy: input.videoPolicy } : {}),
    warnings: brandWarnings,
  };
  return applyIntegrationLinks(model, input);
}

/**
 * Links from the integrations (Azure DevOps test cases, plan/suite, results and bugs; Jira bugs;
 * requirement work items; PR, notifications, results server, git). Used when the model is built and
 * again when integrations.json changed after publishing (the model is patched, not rebuilt).
 */
export function applyIntegrationLinks(model: ReportModel, input: Pick<ReportModelInput, 'integrations' | 'ado' | 'jira' | 'requirementsCatalog'>): ReportModel {
  const integ = input.integrations;
  const c = integ?.ado?.collectionUrl ?? input.ado?.collectionUrl;
  const p = integ?.ado?.project ?? input.ado?.project;
  const adoBase = c && p && safeHttpUrl(c) ? { collectionUrl: c, project: p } : undefined;
  const jiraBase = safeHttpUrl(integ?.jira?.baseUrl ?? input.jira?.baseUrl)?.replace(/\/+$/, '');
  const pub = integ?.ado?.publish;
  const bugsByJourney = new Map<string, TestModel['bugs']>();
  const addBug = (id: string, b: TestModel['bugs'][number]) => bugsByJourney.set(id, [...(bugsByJourney.get(id) ?? []), b]);
  for (const b of integ?.ado?.bugs ?? []) addBug(b.journeyId, { system: 'ado', id: String(b.id), url: safeHttpUrl(b.url) ?? (adoBase ? adoWeb.workItem(adoBase, b.id) : undefined), action: b.action });
  for (const b of integ?.jira?.bugs ?? []) addBug(b.journeyId, { system: 'jira', id: b.key, url: safeHttpUrl(b.url) ?? (jiraBase ? `${jiraBase}/browse/${encodeURIComponent(b.key)}` : undefined), action: b.action });
  const reqUrl = (r: string): string | undefined => {
    const cat = input.requirementsCatalog?.find((x) => x.id === r);
    const id = r.trim();
    return safeHttpUrl(cat?.url) ?? (adoBase && /^\d+$/.test(id) ? adoWeb.workItem(adoBase, id) : jiraBase && /^[A-Z][A-Z0-9]+-\d+$/.test(id) ? `${jiraBase}/browse/${id}` : undefined);
  };
  for (const t of model.tests) {
    let tags: ReturnType<typeof parseAdoTags> | undefined;
    try {
      tags = parseAdoTags(t.tags);
    } catch {
      tags = undefined;
    }
    const results = (pub?.results ?? []).filter((r) => r.journeyId === t.id || (r.journeyId !== t.id && t.id.startsWith(`${r.journeyId}-`)));
    if (tags && (tags.testCaseIds.length || results.length)) {
      const planId = tags.planId ?? pub?.planId ?? input.ado?.testPlanId;
      const suiteId = tags.suiteId ?? pub?.suiteId ?? input.ado?.testSuiteId;
      t.ado = {
        testCases: tags.testCaseIds.map((id) => ({ id, ...(adoBase ? { url: adoWeb.workItem(adoBase, id) } : {}) })),
        ...(planId ? { plan: { id: planId, ...(adoBase ? { url: adoWeb.testPlan(adoBase, planId) } : {}) } } : {}),
        ...(suiteId && planId ? { suite: { id: suiteId, ...(adoBase ? { url: adoWeb.testPlan(adoBase, planId, suiteId) } : {}) } } : {}),
        results: results.map((r) => {
          const url = safeHttpUrl(r.url) ?? (adoBase && pub?.runId && r.resultId ? adoWeb.testResult(adoBase, pub.runId, r.resultId) : undefined);
          return { testCaseId: r.testCaseId, ...(r.resultId ? { resultId: r.resultId } : {}), ...(r.outcome ? { outcome: r.outcome } : {}), ...(url ? { url } : {}) };
        }),
      };
    } else delete t.ado;
    t.bugs = bugsByJourney.get(t.id) ?? [];
    t.requirementLinks = t.requirements.map((r) => {
      const url = reqUrl(r);
      return { id: r, ...(url ? { url } : {}) };
    });
  }
  if (model.coverage.requirements) for (const it of model.coverage.requirements.items) {
    const url = reqUrl(it.id);
    if (url) it.url = url;
  }
  const ctx = model.context;
  const integrations: IntegrationView = {
    notifications: integ?.notifications ?? [],
    publishers: integ?.publishers ?? [],
    ...(integ?.pullRequest ? { pullRequest: { ...integ.pullRequest, url: safeHttpUrl(integ.pullRequest.url) } } : ctx?.pullRequest ? { pullRequest: { provider: ctx.repository?.provider ?? 'git', number: ctx.pullRequest.number, url: ctx.pullRequest.url, at: model.generatedAt } } : {}),
    ...(integ?.jira ? { jira: { ...integ.jira, baseUrl: jiraBase, bugs: integ.jira.bugs.map((b) => ({ ...b, url: safeHttpUrl(b.url) ?? (jiraBase ? `${jiraBase}/browse/${encodeURIComponent(b.key)}` : undefined) })) } } : {}),
    ...(integ?.resultsServer && safeHttpUrl(integ.resultsServer.url) ? { resultsServer: integ.resultsServer } : {}),
  };
  if (adoBase || integ?.ado) {
    integrations.ado = {
      configured: !!adoBase,
      ...(adoBase ? { collectionUrl: adoBase.collectionUrl, project: adoBase.project } : {}),
      ...(pub ? { publish: { ...pub, runUrl: safeHttpUrl(pub.runUrl) ?? (adoBase && pub.runId ? adoWeb.testRun(adoBase, pub.runId) : undefined) } } : {}),
      bugs: (integ?.ado?.bugs ?? []).map((b) => ({ journeyId: b.journeyId, id: b.id, action: b.action, url: safeHttpUrl(b.url) ?? (adoBase ? adoWeb.workItem(adoBase, b.id) : undefined) })),
      ...(integ?.ado?.build ? { build: { ...integ.ado.build, url: safeHttpUrl(integ.ado.build.url) } } : ctx?.build?.system === 'azure-pipelines' ? { build: { id: ctx.build.id, number: ctx.build.number, url: ctx.build.url } } : {}),
      ...(integ?.ado?.release ? { release: { ...integ.ado.release, url: safeHttpUrl(integ.ado.release.url) } } : ctx?.release ? { release: ctx.release } : {}),
      requirementsCommented: (integ?.ado?.requirementsCommented ?? []).map((r) => ({ ...r, url: safeHttpUrl(r.url) ?? (adoBase && /^\d+$/.test(r.requirement) ? adoWeb.workItem(adoBase, r.requirement) : undefined) })),
    };
  }
  const owners = model.tests.some((t) => t.owners.length > 0);
  if (ctx?.commit || ctx?.branch) {
    integrations.git = {
      ...(ctx.branch ? { branch: ctx.branch } : {}),
      ...(ctx.commit ? { commit: ctx.commit.sha, ...(ctx.commit.url ? { commitUrl: ctx.commit.url } : {}) } : {}),
      ...(ctx.repository?.name ? { repository: ctx.repository.name } : {}),
      ...(ctx.repository?.url ? { repositoryUrl: ctx.repository.url } : {}),
      codeowners: owners,
    };
  } else if (owners) integrations.git = { codeowners: true };
  model.integrations = integrations;
  return model;
}

/** What needs attention in a run, for the executive summary, the e-mail and the exports. */
export interface Attention {
  /** Failing tests whose error signature no earlier run in history had. */
  newFailures: TestModel[];
  /** Tests that passed in the baseline run and fail now. */
  regressions: TestModel[];
  /** Tests that failed in the baseline run and pass now. */
  fixed: Array<{ id: string; name: string }>;
  /** Tests that passed only on retry in this run, or flip between outcomes in history. */
  flaky: TestModel[];
  /** Tests at least 1.5 times (and 500 ms) slower than in the baseline. */
  slower: Array<{ id: string; name: string; beforeMs: number; afterMs: number; ratio: number }>;
}

export function attentionOf(m: ReportModel): Attention {
  const byId = new Map(m.tests.map((t) => [t.id, t]));
  const failing = (t: TestModel) => t.state === 'failed' || t.state === 'error';
  return {
    newFailures: m.tests.filter((t) => failing(t) && t.failure && !t.failure.known),
    regressions: (m.comparison?.newlyFailing ?? []).map((x) => byId.get(x.id)).filter((t): t is TestModel => !!t),
    fixed: (m.comparison?.fixed ?? []).map((x) => ({ id: x.id, name: x.name })),
    flaky: m.tests.filter((t) => t.state === 'flaky' || t.history?.state === 'flaky'),
    slower: (m.comparison?.slower ?? []).slice(0, 10),
  };
}

/** The flakiest tests from history: failure rate, flips and samples (most flips first). */
export function topFlakyOf(m: ReportModel, n = 10): Array<{ id: string; name: string; state: TestState; failRate: number; samples: number; failures: number; flips: number; sequence: string }> {
  return m.tests
    .filter((t) => t.history && t.history.samples >= 2 && (t.history.state === 'flaky' || (t.history.flips ?? 0) > 0 || t.state === 'flaky'))
    .map((t) => ({ id: t.id, name: t.name, state: t.state, failRate: t.history!.failRate, samples: t.history!.samples, failures: Math.round(t.history!.failRate * t.history!.samples), flips: t.history!.flips ?? 0, sequence: t.history!.sequence }))
    .sort((a, b) => b.flips - a.flips || b.failRate - a.failRate || a.name.localeCompare(b.name))
    .slice(0, n);
}
