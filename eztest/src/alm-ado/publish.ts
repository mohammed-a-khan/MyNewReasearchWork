/**
 * Publish an EZTest run to Azure Test Plans:
 *   test points (plan/suite, configuration) -> create run (build, release,
 *   owner) -> results in batches of 100 -> per-step action results and
 *   iterations (one per Examples row) -> attachments (run files, screenshots
 *   and traces per result, on the failing step) -> complete run -> flaky
 *   marking -> optional bugs (dedup by failure signature, linked to the test
 *   case and requirements, assigned from CODEOWNERS).
 * POSTs are never blindly retried: after a transient failure we look up what
 * the server already has (run by name, results by test point, attachment by
 * file name, bug by signature tag) and only send what is missing.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { EvidenceKind, EvidenceRef, JourneyResult, RunResult, StepResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { failureSignature, readEvidenceManifest, type FlakyScore, type TriageCategory, type TriageReport } from '../insights/index.js';
import { escapeHtml } from '../report/escape.js';
import { AdoClient } from './client.js';
import { actionPath, parseStepsXml, type TcStep } from './steps.js';
import { parseAdoTags } from './tags.js';
import { getWorkItems, workItemApiUrl } from './workitems.js';

export type AdoOutcome = 'Passed' | 'Failed' | 'NotExecuted' | 'Error' | 'Blocked';

export function adoOutcome(status: JourneyResult['status']): AdoOutcome {
  switch (status) {
    case 'passed':
    case 'passed-healed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'error':
      return 'Error';
    case 'skipped':
      return 'NotExecuted';
  }
}

export function stepOutcome(status: StepResult['status']): AdoOutcome {
  return status === 'passed' || status === 'passed-healed' ? 'Passed' : status === 'failed' ? 'Failed' : status === 'blocked' ? 'Blocked' : 'NotExecuted';
}

const SEVERITY: Record<AdoOutcome, number> = { Passed: 0, NotExecuted: 1, Blocked: 2, Failed: 3, Error: 4 };
const worst = (a: AdoOutcome, b: AdoOutcome) => (SEVERITY[b] > SEVERITY[a] ? b : a);

export interface PipelineLinks {
  buildId?: number;
  buildNumber?: string;
  buildPlatform?: string;
  buildFlavor?: string;
  releaseUri?: string;
  releaseEnvironmentUri?: string;
  /** Display name recorded as the run's owner and each result's runner. */
  owner?: string;
  /** Branch the run tested (flaky marking is per branch). */
  branch?: string;
}

/** Build, release and owner of the current Azure Pipelines job (from its predefined variables). */
export function pipelineLinksFromEnv(env: Record<string, string | undefined> = process.env): PipelineLinks {
  const n = Number(env.BUILD_BUILDID);
  return {
    ...(Number.isFinite(n) && n > 0 ? { buildId: n } : {}),
    ...(env.BUILD_BUILDNUMBER ? { buildNumber: env.BUILD_BUILDNUMBER } : {}),
    ...(env.RELEASE_RELEASEURI ? { releaseUri: env.RELEASE_RELEASEURI } : {}),
    ...(env.RELEASE_ENVIRONMENTURI ? { releaseEnvironmentUri: env.RELEASE_ENVIRONMENTURI } : {}),
    ...((env.BUILD_REQUESTEDFOR ?? env.RELEASE_REQUESTEDFOR) ? { owner: env.BUILD_REQUESTEDFOR ?? env.RELEASE_REQUESTEDFOR } : {}),
    ...((env.SYSTEM_PULLREQUEST_SOURCEBRANCH ?? env.BUILD_SOURCEBRANCH) ? { branch: env.SYSTEM_PULLREQUEST_SOURCEBRANCH ?? env.BUILD_SOURCEBRANCH } : {}),
  };
}

export interface PublishOptions {
  client: AdoClient;
  planId?: number;
  suiteId?: number;
  runName?: string;
  /** @deprecated use links.buildId */
  buildId?: number;
  /** Build / release / owner links (pipelineLinksFromEnv() in Azure Pipelines). */
  links?: PipelineLinks;
  /** Test configuration the results belong to (selects the test point of that configuration). */
  configurationId?: number;
  /** Files (report.html, junit.xml, evidence pack...) to attach to the test run. */
  attachments?: Array<{ path: string; comment?: string }>;
  /** Attach each journey's evidence files (from the run dir manifest) to its results; failing-step files go on the step. */
  resultEvidence?: { runDir: string; kinds?: EvidenceKind[]; maxPerResult?: number };
  maxAttachmentBytes?: number;
  batchSize?: number;
  /** Per-step action results and iterations from the test cases' steps (default true). */
  stepResults?: boolean;
  /** Mark results flaky through the flaky-test API: retried-then-passed journeys and these flaky scores. */
  flaky?: { enabled: boolean; scores?: FlakyScore[] };
  bugs?: {
    enabled: boolean;
    /** With triage, only these categories produce bugs. Default product-bug and unknown. */
    categories?: TriageCategory[];
    triage?: TriageReport;
    areaPath?: string;
    iterationPath?: string;
    /** Area/iteration per journey (overrides areaPath/iterationPath). */
    pathsFor?: (journeyId: string, tags: string[]) => { areaPath?: string; iterationPath?: string };
    extraTags?: string[];
    /** Assigned To for a journey's bug (e.g. from CODEOWNERS). */
    assignTo?: (journeyId: string) => string | undefined;
    /** Link bugs to the requirements (numeric `Requirements:` ids) the journey traces to (default true). */
    linkRequirements?: boolean;
  };
}

export interface PublishedResult {
  journeyId: string;
  testCaseId: number;
  pointId: number;
  resultId?: number;
  outcome: AdoOutcome;
  /** Journey ids of the Examples rows published as iterations of this result. */
  iterations?: string[];
  healedSteps?: number;
  flaky?: boolean;
}

export interface PublishSummary {
  runId: number;
  runName: string;
  results: PublishedResult[];
  unmapped: string[];
  missingPoints: Array<{ journeyId: string; testCaseId: number }>;
  attachments: Array<{ fileName: string; resultId?: number; action: 'uploaded' | 'already-present'; iterationId?: number; actionPath?: string }>;
  bugs: Array<{ journeyId: string; signature: string; id: number; action: 'created' | 'deduped' }>;
  stepResults: { results: number; actions: number };
  flakyMarked: number[];
  warnings: string[];
}

interface TestPoint {
  id: number;
  testCaseReference?: { id: number };
  testCase?: { id: number | string };
  configuration?: { id: number | string; name?: string };
}

interface AdoRun {
  id: number;
  name: string;
  state?: string;
}

interface AdoResult {
  id: number;
  testPoint?: { id: string | number };
  testCase?: { id: string | number };
  automatedTestName?: string;
  testCaseReferenceId?: number;
}

function healText(s: StepResult): string {
  const h = s.heal!;
  return `${s.stepId} ${h.tier} confidence=${h.confidence.toFixed(2)} verified=${h.verified} ${h.original.map((o) => `${o.strategy}=${o.value}`).join('|')} -> ${h.healed.strategy}=${h.healed.value}`;
}

function allSteps(steps: StepResult[]): StepResult[] {
  return steps.flatMap((s) => [s, ...allSteps(s.children ?? [])]);
}

function healComment(j: JourneyResult): string | undefined {
  const heals = allSteps(j.steps).filter((s) => s.heal);
  if (j.status !== 'passed-healed' && heals.length === 0) return undefined;
  return `healed: ${heals.map(healText).join('; ')}`.slice(0, 1000);
}

function failing(j: JourneyResult) {
  return j.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
}

function wiqlString(s: string): string {
  return s.replace(/'/g, "''");
}

async function recoverOrRetry<T>(
  label: string,
  attempt: () => Promise<T>,
  lookup: () => Promise<T | undefined>,
  warnings: string[],
  maxAttempts = 3,
): Promise<{ value: T; recovered: boolean }> {
  for (let i = 1; ; i++) {
    try {
      return { value: await attempt(), recovered: false };
    } catch (e) {
      if (!AdoClient.isTransient(e) || i >= maxAttempts) throw e;
      const found = await lookup();
      if (found !== undefined) {
        warnings.push(`${label}: transient failure, server already had it; not re-sent`);
        return { value: found, recovered: true };
      }
      warnings.push(`${label}: transient failure and not present on server; re-sending (attempt ${i + 1})`);
    }
  }
}

const norm = (s: string) => s.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Which ADO step each journey step belongs to: same text first (test cases
 * created from journeys carry the step's text), then position when both have
 * the same number of steps.
 */
export function mapStepsToActions(steps: StepResult[], actions: TcStep[]): Map<string, TcStep> {
  const out = new Map<string, TcStep>();
  const free = new Set(actions);
  // An action's text with its @parameters (and <placeholders>) as wildcards: Examples rows fill them in.
  const pattern = (a: TcStep) => new RegExp(`^${norm(a.action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/@[\w-]+|<[\w -]+>/g, '.+?')}$`);
  const pass = (match: (s: StepResult, a: TcStep) => boolean) => {
    for (const s of steps) {
      if (out.has(s.stepId)) continue;
      const a = actions.find((x) => free.has(x) && match(s, x));
      if (a) {
        out.set(s.stepId, a);
        free.delete(a);
      }
    }
  };
  pass((s, a) => norm(a.action) === norm(s.intent));
  pass((s, a) => pattern(a).test(norm(s.intent)));
  // Same number of steps (e.g. a case imported from manual text): what is left aligns by position.
  if (steps.length === actions.length) {
    steps.forEach((s, i) => {
      if (out.has(s.stepId) || !free.has(actions[i])) return;
      out.set(s.stepId, actions[i]);
      free.delete(actions[i]);
    });
  }
  return out;
}

/** Row values from an expanded Examples journey's name ("Search [term=laptop, n=3]"). */
function rowParams(name: string): Array<{ name: string; value: string }> {
  const m = /\[([^\]]*=[^\]]*)\]\s*$/.exec(name);
  if (!m) return [];
  return m[1].split(/,\s*/).map((kv) => kv.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => ({ name: k.trim(), value: v.join('=').trim() }));
}

export async function publishRun(run: RunResult, opts: PublishOptions): Promise<PublishSummary> {
  const c = opts.client;
  if (!run.journeys.length) throw new EzTestError('publishRun: run has no journeys', 'INVALID_INPUT');
  const batchSize = opts.batchSize ?? 100;
  if (batchSize < 1 || batchSize > 100) throw new EzTestError('batchSize must be 1..100', 'INVALID_INPUT');
  const warnings: string[] = [];
  const links: PipelineLinks = { ...(opts.buildId ? { buildId: opts.buildId } : {}), ...opts.links };

  // ---- map journeys to test cases / plan / suite (Examples rows of one test case become iterations)
  const planIds = new Set<number>();
  const mapped: Array<{ j: JourneyResult; testCaseId: number; suiteId: number }> = [];
  const unmapped: string[] = [];
  for (const j of run.journeys) {
    if (j.tags.includes('hook')) continue;
    const t = parseAdoTags(j.tags);
    const plan = t.planId ?? opts.planId;
    const suite = t.suiteId ?? opts.suiteId;
    if (t.testCaseIds.length === 0) {
      unmapped.push(j.journeyId);
      continue;
    }
    if (!plan || !suite) throw new EzTestError(`Journey ${j.journeyId} has test cases but no plan/suite (tags or options)`, 'INVALID_INPUT');
    planIds.add(plan);
    for (const tc of t.testCaseIds) mapped.push({ j, testCaseId: tc, suiteId: suite });
  }
  if (mapped.length === 0) throw new EzTestError('publishRun: no journey carries an @TestCaseId tag; nothing to publish', 'INVALID_INPUT');
  if (planIds.size !== 1) throw new EzTestError(`publishRun: journeys span several test plans (${[...planIds].join(', ')}); publish one plan per run`, 'INVALID_INPUT');
  const planId = [...planIds][0];

  // ---- test points (of the run's configuration when one is given)
  const pointBySuiteCase = new Map<string, number>();
  for (const suiteId of new Set(mapped.map((m) => m.suiteId))) {
    const points = await c.getAll<TestPoint>(`/_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestPoint`);
    for (const p of points) {
      const tc = Number(p.testCaseReference?.id ?? p.testCase?.id);
      if (!tc) continue;
      if (opts.configurationId !== undefined && p.configuration && Number(p.configuration.id) !== opts.configurationId) continue;
      if (!pointBySuiteCase.has(`${suiteId}:${tc}`)) pointBySuiteCase.set(`${suiteId}:${tc}`, p.id);
    }
  }
  const missingPoints: PublishSummary['missingPoints'] = [];
  const groups = new Map<string, { testCaseId: number; pointId: number; js: JourneyResult[] }>();
  for (const m of mapped) {
    const pid = pointBySuiteCase.get(`${m.suiteId}:${m.testCaseId}`);
    if (pid === undefined) {
      missingPoints.push({ journeyId: m.j.journeyId, testCaseId: m.testCaseId });
      continue;
    }
    const k = `${pid}:${m.testCaseId}`;
    const g = groups.get(k) ?? { testCaseId: m.testCaseId, pointId: pid, js: [] };
    g.js.push(m.j);
    groups.set(k, g);
  }
  const toPublish = [...groups.values()];
  if (toPublish.length === 0) throw new EzTestError('publishRun: none of the test cases has a test point in the given suite(s)', 'ADO_NO_POINTS');

  // ---- create (or recover) the run
  const runName = opts.runName ?? `EZTest ${run.runId}`;
  const findRun = async (): Promise<AdoRun | undefined> => {
    const runs = await c.getAll<AdoRun>('/_apis/test/runs', { planId, automated: true, includeRunDetails: true, $top: 100 });
    return runs.find((r) => r.name === runName && r.state !== 'Completed' && r.state !== 'Aborted');
  };
  let adoRun = await findRun();
  if (adoRun) warnings.push(`reusing in-progress run ${adoRun.id} named "${runName}"`);
  else {
    adoRun = (
      await recoverOrRetry(
        'create run',
        async () =>
          (
            await c.request<AdoRun>('POST', '/_apis/test/runs', {
              body: {
                name: runName,
                plan: { id: String(planId) },
                automated: true,
                state: 'InProgress',
                startedDate: run.startedAt,
                ...(links.buildId ? { build: { id: String(links.buildId) } } : {}),
                ...(links.buildPlatform ? { buildPlatform: links.buildPlatform } : {}),
                ...(links.buildFlavor ? { buildFlavor: links.buildFlavor } : {}),
                ...(links.releaseUri ? { releaseUri: links.releaseUri } : {}),
                ...(links.releaseEnvironmentUri ? { releaseEnvironmentUri: links.releaseEnvironmentUri } : {}),
                ...(links.owner ? { owner: { displayName: links.owner } } : {}),
                ...(opts.configurationId !== undefined ? { configurationIds: [opts.configurationId] } : {}),
                comment: `EZTest run ${run.runId}${run.environment?.gitCommit ? ` at ${run.environment.gitCommit.slice(0, 10)}${run.environment.gitBranch ? ` (${run.environment.gitBranch})` : ''}` : ''}`,
              },
            })
          ).data,
        findRun,
        warnings,
      )
    ).value;
  }
  const runId = adoRun.id;

  // ---- results in batches
  const existing = async (): Promise<AdoResult[]> => {
    const out: AdoResult[] = [];
    for (let skip = 0; ; skip += 1000) {
      const r = await c.request<{ value: AdoResult[] }>('GET', `/_apis/test/Runs/${runId}/results`, { query: { $top: 1000, $skip: skip } });
      out.push(...(r.data?.value ?? []));
      if ((r.data?.value ?? []).length < 1000) return out;
    }
  };
  const keyOf = (pointId: number | string | undefined, tc: number | string | undefined) => `${pointId}:${tc}`;
  const resultIds = new Map<string, number>();
  const refIds = new Map<number, number>();
  const remember = (r: AdoResult) => {
    resultIds.set(keyOf(r.testPoint?.id, r.testCase?.id), r.id);
    if (r.testCaseReferenceId) refIds.set(r.id, r.testCaseReferenceId);
  };
  for (const r of await existing()) remember(r);
  const pending = toPublish.filter((p) => !resultIds.has(keyOf(p.pointId, p.testCaseId)));
  if (pending.length < toPublish.length) warnings.push(`${toPublish.length - pending.length} result(s) already present in run ${runId}; not re-sent`);

  const body = (p: (typeof toPublish)[number]) => {
    const outcome = p.js.map((j) => adoOutcome(j.status)).reduce(worst);
    const firstBad = p.js.find((j) => adoOutcome(j.status) === outcome && outcome !== 'Passed') ?? p.js[0];
    const f = failing(firstBad);
    const err = f?.error ?? firstBad.error;
    const started = Math.min(...p.js.map((j) => Date.parse(j.startedAt)).filter(Number.isFinite));
    const duration = p.js.reduce((n, j) => n + j.durationMs, 0);
    const heals = p.js.map(healComment).filter(Boolean);
    const retried = p.js.filter((j) => j.attempt > 1);
    const comment = [
      heals.length ? `${heals.join(' | ')} | outcome: ${outcome === 'Passed' ? 'passed with healed step(s) awaiting review in EZTest' : outcome.toLowerCase()}` : undefined,
      retried.length ? `re-run: ${retried.map((j) => `${j.journeyId} ${j.status} on attempt ${j.attempt}`).join(', ')}` : undefined,
      p.js.length > 1 ? `${p.js.length} iterations (Examples rows)` : undefined,
    ].filter(Boolean).join(' | ');
    const base = p.js[0];
    // Manual cases executed by a tester are published as manual results, run by that tester; hybrid ones stay automated.
    const manualCase = base.manual?.type === 'manual';
    const tester = p.js.flatMap((j) => j.manual?.testers ?? [])[0];
    const manualNote = manualCase ? `manual run in EZTest${tester ? ` by ${tester}` : ''}${p.js.some((j) => (j.manual?.pending ?? 0) > 0) ? '; some steps not executed' : ''}` : undefined;
    return {
      testPoint: { id: String(p.pointId) },
      testCase: { id: String(p.testCaseId) },
      testCaseTitle: p.js.length > 1 ? base.name.replace(/\s*\[[^\]]*\]\s*$/, '') : base.name,
      ...(manualCase ? {} : {
        automatedTestName: `eztest.${p.js.length > 1 ? commonPrefix(p.js.map((j) => j.journeyId)) : base.journeyId}`,
        automatedTestType: 'EZTest',
        automatedTestStorage: run.environment?.gitRemote ?? 'eztest',
      }),
      outcome,
      state: 'Completed',
      durationInMs: duration,
      startedDate: Number.isFinite(started) ? new Date(started).toISOString() : base.startedAt,
      completedDate: Number.isFinite(started) ? new Date(started + duration).toISOString() : undefined,
      errorMessage: err ? err.message.slice(0, 4000) : undefined,
      stackTrace: err?.stack?.slice(0, 4000),
      comment: [manualNote, comment].filter(Boolean).join(' | ').slice(0, 1000) || undefined,
      ...(links.buildId ? { build: { id: String(links.buildId) } } : {}),
      ...(links.owner ? { runBy: { displayName: links.owner }, owner: { displayName: links.owner } } : {}),
      ...(manualCase && tester ? { runBy: { displayName: tester } } : {}),
      ...(opts.configurationId !== undefined ? { configuration: { id: String(opts.configurationId) } } : {}),
    };
  };
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const created = await recoverOrRetry(
      `add results ${i + 1}-${i + batch.length}`,
      async () => {
        const stillMissing = batch.filter((p) => !resultIds.has(keyOf(p.pointId, p.testCaseId)));
        const r = await c.request<{ value: AdoResult[] }>('POST', `/_apis/test/Runs/${runId}/results`, { body: stillMissing.map(body) });
        return r.data?.value ?? [];
      },
      async () => {
        const all = await existing();
        for (const r of all) remember(r);
        return batch.every((p) => resultIds.has(keyOf(p.pointId, p.testCaseId))) ? all : undefined;
      },
      warnings,
    );
    for (const r of created.value) remember(r);
  }
  const results: PublishedResult[] = toPublish.map((p) => ({
    journeyId: p.js[0].journeyId,
    testCaseId: p.testCaseId,
    pointId: p.pointId,
    resultId: resultIds.get(keyOf(p.pointId, p.testCaseId)),
    outcome: p.js.map((j) => adoOutcome(j.status)).reduce(worst),
    ...(p.js.length > 1 ? { iterations: p.js.map((j) => j.journeyId) } : {}),
    ...(p.js.some((j) => allSteps(j.steps).some((s) => s.heal)) ? { healedSteps: p.js.reduce((n, j) => n + allSteps(j.steps).filter((s) => s.heal).length, 0) } : {}),
  }));

  // ---- per-step action results and iterations
  const stepMaps = new Map<number, Map<string, TcStep>[]>();
  const stepResults = { results: 0, actions: 0 };
  if (opts.stepResults !== false) {
    try {
      const tcs = await getWorkItems(c, [...new Set(toPublish.map((p) => p.testCaseId))], { fields: ['System.Id', 'Microsoft.VSTS.TCM.Steps'] });
      const actionsOf = new Map(tcs.map((w) => [w.id, parseStepsXml(String(w.fields['Microsoft.VSTS.TCM.Steps'] ?? '')).filter((x): x is TcStep => x.kind === 'step')]));
      const updates: Array<Record<string, unknown>> = [];
      for (const p of toPublish) {
        const resultId = resultIds.get(keyOf(p.pointId, p.testCaseId));
        const actions = actionsOf.get(p.testCaseId) ?? [];
        if (!resultId || !actions.length) continue;
        const maps = p.js.map((j) => mapStepsToActions(j.steps, actions));
        stepMaps.set(resultId, maps);
        const iterationDetails = p.js.map((j, i) => {
          const map = maps[i];
          const started = Date.parse(j.startedAt);
          const actionResults = j.steps
            .filter((s) => map.has(s.stepId))
            .map((s) => {
              const a = map.get(s.stepId)!;
              const st = Date.parse(s.startedAt);
              return {
                actionPath: actionPath(a.id),
                iterationId: i + 1,
                stepIdentifier: String(a.id),
                outcome: stepOutcome(s.status),
                durationInMs: s.durationMs,
                ...(Number.isFinite(st) ? { startedDate: new Date(st).toISOString(), completedDate: new Date(st + s.durationMs).toISOString() } : {}),
                ...(s.error ? { errorMessage: s.error.message.slice(0, 1000) } : {}),
                ...(s.heal ? { comment: `healed (${s.heal.verified ? 'verified' : 'unverified'}, awaiting review): ${healText(s)}`.slice(0, 1000) } : {}),
                ...(s.manual && (s.manual.notes || s.manual.actual || s.manual.tester) ? { comment: [s.manual.tester ? `tester: ${s.manual.tester}` : '', s.manual.actual ? `observed: ${s.manual.actual}` : '', s.manual.notes ?? ''].filter(Boolean).join('; ').slice(0, 1000) } : {}),
              };
            });
          stepResults.actions += actionResults.length;
          const f = failing(j);
          return {
            id: i + 1,
            outcome: adoOutcome(j.status),
            durationInMs: j.durationMs,
            ...(Number.isFinite(started) ? { startedDate: j.startedAt, completedDate: new Date(started + j.durationMs).toISOString() } : {}),
            ...((f?.error ?? j.error) ? { errorMessage: (f?.error ?? j.error)!.message.slice(0, 1000) } : {}),
            comment: p.js.length > 1 ? j.name.slice(0, 500) : undefined,
            actionResults,
            parameters: rowParams(j.name).map((x) => ({ parameterName: x.name, value: x.value, iterationId: i + 1 })),
          };
        });
        updates.push({ id: resultId, iterationDetails });
        stepResults.results++;
      }
      for (let i = 0; i < updates.length; i += batchSize) {
        await c.request('PATCH', `/_apis/test/Runs/${runId}/results`, { body: updates.slice(i, i + batchSize), idempotent: true });
      }
    } catch (e) {
      warnings.push(`step results not published: ${(e as Error).message}`);
      stepResults.results = 0;
      stepResults.actions = 0;
    }
  }

  // ---- attachments
  const maxBytes = opts.maxAttachmentBytes ?? 25 * 1024 * 1024;
  const attachments: PublishSummary['attachments'] = [];
  const attach = async (absPath: string, fileName: string, resultId?: number, comment?: string, where: { iterationId?: number; actionPath?: string } = {}) => {
    const size = (await stat(absPath)).size;
    if (size > maxBytes) {
      warnings.push(`attachment ${fileName} skipped: ${size} bytes exceeds ${maxBytes}`);
      return;
    }
    const base = resultId ? `/_apis/test/Runs/${runId}/Results/${resultId}/attachments` : `/_apis/test/Runs/${runId}/attachments`;
    const lookup = async () => {
      const r = await c.request<{ value: Array<{ fileName: string }> }>('GET', base);
      return (r.data?.value ?? []).some((a) => a.fileName === fileName) ? true : undefined;
    };
    if (await lookup()) {
      attachments.push({ fileName, resultId, action: 'already-present', ...where });
      return;
    }
    const stream = (await readFile(absPath)).toString('base64');
    const query = where.iterationId ? { iterationId: where.iterationId, ...(where.actionPath ? { actionPath: where.actionPath } : {}) } : undefined;
    const r = await recoverOrRetry(
      `attach ${fileName}`,
      async () => {
        await c.request('POST', base, { body: { stream, fileName, attachmentType: 'GeneralAttachment', comment }, ...(query ? { query } : {}) });
        return false;
      },
      lookup,
      warnings,
    );
    attachments.push({ fileName, resultId, action: r.recovered ? 'already-present' : 'uploaded', ...where });
  };
  for (const a of opts.attachments ?? []) await attach(a.path, basename(a.path), undefined, a.comment);
  if (opts.resultEvidence) {
    const runDir = opts.resultEvidence.runDir;
    const manifest = await readEvidenceManifest(runDir);
    const kinds = opts.resultEvidence.kinds ?? ['screenshot'];
    const max = opts.resultEvidence.maxPerResult ?? 5;
    for (const p of toPublish) {
      const resultId = resultIds.get(keyOf(p.pointId, p.testCaseId));
      if (!resultId) continue;
      const maps = stepMaps.get(resultId);
      let n = 0;
      for (const [i, j] of p.js.entries()) {
        const stepOf = new Map<string, StepResult>();
        for (const s of allSteps(j.steps)) for (const e of s.evidence) stepOf.set(e, s);
        const ids = new Set([...j.evidence, ...allSteps(j.steps).flatMap((s) => s.evidence)]);
        const evs: EvidenceRef[] = manifest.filter((e) => ids.has(e.id) && kinds.includes(e.kind));
        for (const ev of evs) {
          if (n >= max) break;
          const abs = resolve(runDir, ev.path);
          const rel = relative(runDir, abs);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new EzTestError(`evidence path escapes run dir: ${ev.path}`, 'PATH_ESCAPE');
          const s = stepOf.get(ev.id);
          const a = s && maps?.[i]?.get(s.stepId);
          await attach(join(runDir, rel), `${ev.id}-${basename(ev.path)}`, resultId, ev.description, maps ? { iterationId: i + 1, ...(a ? { actionPath: actionPath(a.id) } : {}) } : {});
          n++;
        }
      }
    }
  }

  // ---- complete the run (PATCH of state is idempotent)
  await c.request('PATCH', `/_apis/test/runs/${runId}`, { body: { state: 'Completed', completedDate: run.finishedAt }, idempotent: true });

  // ---- flaky marking (Azure Test Plans flaky test management; per branch)
  const flakyMarked: number[] = [];
  if (opts.flaky?.enabled) {
    const flakyIds = new Set((opts.flaky.scores ?? []).filter((s) => s.state === 'flaky').map((s) => s.journeyId));
    const branch = links.branch ?? (run.environment?.gitBranch ? `refs/heads/${run.environment.gitBranch}` : undefined);
    if (refIds.size === 0) for (const r of await existing().catch(() => [])) remember(r);
    for (const [k, p] of [...groups.entries()]) {
      const isFlaky = p.js.some((j) => (j.attempt > 1 && (j.status === 'passed' || j.status === 'passed-healed')) || flakyIds.has(j.journeyId) || flakyIds.has(j.journeyId.replace(/-[^-]+$/, '')));
      if (!isFlaky) continue;
      const resultId = resultIds.get(k);
      const ref = resultId ? refIds.get(resultId) : undefined;
      const pr = results.find((r) => r.resultId === resultId);
      if (pr) pr.flaky = true;
      if (!ref) {
        warnings.push(`flaky: result ${resultId} has no testCaseReferenceId; not marked`);
        continue;
      }
      try {
        await c.request('PATCH', `${c.testResultsUrl}/${encodeURIComponent(c.project)}/_apis/testresults/results/resultmetadata/${ref}`, {
          preview: 'preview.4',
          body: { flakyIdentifiers: [{ branchName: branch ?? '', isFlaky: true }] },
          idempotent: true,
        });
        flakyMarked.push(resultId!);
      } catch (e) {
        warnings.push(`flaky marking is not available (${(e as Error).message.slice(0, 160)}); results are commented as re-runs instead`);
        break;
      }
    }
  }

  // ---- bugs
  const bugs: PublishSummary['bugs'] = [];
  if (opts.bugs?.enabled) {
    const cats = opts.bugs.categories ?? ['product-bug', 'unknown'];
    const triage = opts.bugs.triage;
    const bySig = new Map<string, number>();
    for (const j of run.journeys) {
      if (j.status !== 'failed' && j.status !== 'error') continue;
      if (triage) {
        const v = triage.verdicts.find((x) => x.journeyId === j.journeyId);
        if (!v || !cats.includes(v.category)) continue;
      }
      const f = failing(j);
      const err = f?.error ?? j.error;
      const message = err?.message ?? `Journey ${j.journeyId} ${j.status} at step ${f?.stepId ?? '?'}`;
      const sig = failureSignature({ message, stack: err?.stack, name: err?.name });
      const sigTag = `ezsig-${sig.hash}`;
      const known = bySig.get(sig.hash);
      if (known) {
        bugs.push({ journeyId: j.journeyId, signature: sig.hash, id: known, action: 'deduped' });
        continue;
      }
      const findBug = async (): Promise<number | undefined> => {
        const q = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') AND [System.Tags] CONTAINS '${wiqlString(sigTag)}' ORDER BY [System.Id]`;
        const r = await c.request<{ workItems: Array<{ id: number }> }>('POST', '/_apis/wit/wiql', { body: { query: q }, idempotent: true });
        return r.data?.workItems?.[0]?.id;
      };
      const existingBug = await findBug();
      if (existingBug !== undefined) {
        bySig.set(sig.hash, existingBug);
        bugs.push({ journeyId: j.journeyId, signature: sig.hash, id: existingBug, action: 'deduped' });
        continue;
      }
      const tcIds = parseAdoTags(j.tags).testCaseIds;
      const evidence = [...(f?.evidence ?? []), ...j.evidence];
      const repro = `<p><b>Journey:</b> ${escapeHtml(j.name)} (<code>${escapeHtml(j.journeyId)}</code>), EZTest run ${escapeHtml(run.runId)}${run.environment?.gitCommit ? `, commit <code>${escapeHtml(run.environment.gitCommit.slice(0, 12))}</code>${run.environment.gitBranch ? ` on <code>${escapeHtml(run.environment.gitBranch)}</code>` : ''}` : ''}</p>
<ol>${j.steps.map((s) => `<li>[${escapeHtml(s.status)}] ${escapeHtml(s.intent)}</li>`).join('')}</ol>
<p><b>Failure:</b></p><pre>${escapeHtml(message.slice(0, 2000))}</pre>
<p><b>Evidence ids:</b> ${escapeHtml([...new Set(evidence)].join(', ') || 'none')}</p><p><b>Signature:</b> ${escapeHtml(sig.hash)}</p>`;
      const ops: Array<Record<string, unknown>> = [
        { op: 'add', path: '/fields/System.Title', value: `[EZTest] ${j.name}: ${sig.normalized}`.slice(0, 250) },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: repro },
        { op: 'add', path: '/fields/System.Tags', value: ['eztest', sigTag, ...(opts.bugs.extraTags ?? [])].join('; ') },
      ];
      const paths = opts.bugs.pathsFor?.(j.journeyId, j.tags) ?? {};
      const area = paths.areaPath ?? opts.bugs.areaPath;
      const iteration = paths.iterationPath ?? opts.bugs.iterationPath;
      if (area) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: area });
      if (iteration) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: iteration });
      const assignee = opts.bugs.assignTo?.(j.journeyId);
      if (assignee) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignee });
      if (links.buildNumber) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Build.FoundIn', value: links.buildNumber });
      for (const tc of tcIds) {
        ops.push({ op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Forward', url: `${c.collectionUrl}/_apis/wit/workItems/${tc}`, attributes: { comment: 'EZTest failing test case' } } });
      }
      if (opts.bugs.linkRequirements !== false) {
        for (const r of j.requirements.filter((x) => /^\d+$/.test(x.trim()))) {
          ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Related', url: workItemApiUrl(c, Number(r)), attributes: { comment: 'EZTest: failing journey traces to this requirement' } } });
        }
      }
      const created = await recoverOrRetry(
        `create bug for ${j.journeyId}`,
        async () => (await c.request<{ id: number }>('POST', '/_apis/wit/workitems/$Bug', { body: ops, contentType: 'application/json-patch+json' })).data.id,
        findBug,
        warnings,
      );
      bySig.set(sig.hash, created.value);
      bugs.push({ journeyId: j.journeyId, signature: sig.hash, id: created.value, action: created.recovered ? 'deduped' : 'created' });
    }
  }

  return { runId, runName, results, unmapped, missingPoints, attachments, bugs, stepResults, flakyMarked, warnings };
}

function commonPrefix(ids: string[]): string {
  let p = ids[0] ?? '';
  for (const id of ids) while (!id.startsWith(p)) p = p.slice(0, -1);
  return p.replace(/-+$/, '') || ids[0];
}
