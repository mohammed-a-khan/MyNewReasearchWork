/** runJourneys: the top-level executor. */
import { bindJourney } from '../elements/bind.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  EvidenceVault,
  silentLogger,
  summarize,
  NotSupportedError,
  nowIso,
  setDefaultLocale,
  setDefaultTimeZone,
  type Journey,
  type JourneyResult,
  type RunResult,
} from '../core/index.js';
import { collectRunVcs, runVcsEnvironment } from '../git/branch.js';
import { collectHealProposals } from '../heal/proposals.js';
import { FingerprintStore } from '../heal/store.js';
import { EvidenceWriter } from './evidence.js';
import { blockedByHook, expandExamples, hookJourneys, runAllHook, runWideValues, type HookAttempt } from './journey-hooks.js';
import { maskDeep } from './dom.js';
import { createRunExtensions } from './extensions.js';
import { resolveExamplesSources } from './examples-source.js';
import { attemptNetwork, cancelledJourney, noRowsJourney } from './journey.js';
import { acquireBlocking, JourneyQueue } from './queue.js';
import type { RunOptions } from './types.js';
import { skippedStep } from './step.js';
import { CircuitBreaker, ENVIRONMENT_UNAVAILABLE, runHealthChecks } from './reliability/health.js';
import { classifyFlake } from './reliability/flake.js';
import { handoffFor, planDependencies } from './reliability/dependencies.js';
import { safeName } from './evidence.js';
import type { HealthCheckResult, RunHealth } from '../core/index.js';
import { bddRecord } from './bdd-run.js';
import { bddAllJourneys, clearBddAllState } from './bdd-all.js';
import { RunCancelledError, registerPartialRunWriter } from './cancel.js';

/** Run the Gherkin BeforeAll / AfterAll hook journeys of a run's scenarios (tagged hook, bdd). */
async function runBddAllHooks(journeys: Journey[], kind: 'beforeAll' | 'afterAll', opts: RunOptions, run: HookAttempt): Promise<JourneyResult[]> {
  const out: JourneyResult[] = [];
  const teardown = kind === 'afterAll' && !!opts.signal?.aborted && !!opts.teardownOnCancel;
  for (const h of await bddAllJourneys(journeys, kind, opts.baseDir ?? process.cwd())) {
    if (!teardown && opts.signal?.aborted) break;
    opts.events?.emit({ type: 'journey:start', journeyId: h.id, name: h.name });
    const r = await run(h, 1, undefined, teardown);
    out.push(r);
    opts.events?.emit({ type: 'journey:end', journeyId: h.id, status: r.status });
  }
  return out;
}
import { describeBrowser, expandBrowserMatrix, runBrowsers, type ResolvedBrowser } from './browsers.js';
import { LocalAttemptRunner, wantedBrowsers, type AttemptRunner } from './attempts.js';
import { ProcessWorkerPool } from './workers/pool.js';
import { workerMode } from './workers/mode.js';

/**
 * A path as recorded in run.json (and so in JUnit properties and reports): relative to the project, the folder
 * that holds the output directory, with forward slashes, so a run never carries a machine's absolute paths.
 */
export function projectRelative(path: string, outputDir: string): string {
  const rel = relative(dirname(resolve(outputDir)), resolve(path));
  return (rel || '.').split('\\').join('/');
}

/** Default fingerprint store location for an output directory. */
export function defaultFingerprintStorePath(outputDir: string): string {
  return join(dirname(resolve(outputDir)), '.eztest', 'fingerprints.json');
}

function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
}


/** Browser launch options from run options (channel only applies to chromium). */
export function launchOptions(opts: RunOptions): { headless: boolean; executablePath?: string; channel?: string } {
  const kind = opts.browser ?? 'chromium';
  if (opts.channel && kind !== 'chromium') throw new NotSupportedError(`browser channel "${opts.channel}" with ${kind} (channels are for chromium: msedge, chrome, ...)`);
  return {
    headless: opts.headless ?? true,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    ...(opts.channel && !opts.executablePath && opts.channel !== 'chromium' ? { channel: opts.channel } : {}),
  };
}

/**
 * Run journeys and return the RunResult. Writes `<outputDir>/<runId>/` with
 * the hash-chained evidence manifest, `heal-proposals.json` (if any heals)
 * and `run.json`.
 */
export async function runJourneys(journeys: Journey[], options: RunOptions): Promise<RunResult> {
  if (!journeys.length) throw new Error('runJourneys: no journeys to run');
  // External Examples sources (data files, named queries) become inline rows; a source with no rows does not run.
  const sourced = await resolveExamplesSources(journeys, {
    baseDir: options.baseDir ?? process.cwd(), variables: options.variables ?? {}, ...(options.dataSourceResolver ? { resolver: options.dataSourceResolver } : {}),
  });
  journeys = expandExamples(sourced.journeys); // one journey per Examples row
  // Shared repository elements: bound up front (block conditions included); code journeys bind per step (step.ts).
  if (options.elements?.size) {
    const repo = options.elements;
    journeys = journeys.map((j) => bindJourney(j, repo).journey);
  }
  // Cross-browser runs: journey x browser units (`<id>@<browser>`); see browsers.ts.
  const targets = runBrowsers(options);
  const multiBrowser = targets.length > 1;
  const matrix = expandBrowserMatrix(journeys, targets.map((t) => t.id));
  journeys = matrix.journeys;
  if (!journeys.length && !matrix.excluded.length) throw new Error('runJourneys: no journeys to run');
  const ids = new Set<string>();
  for (const j of journeys) {
    if (ids.has(j.id)) throw new Error(`runJourneys: duplicate journey id "${j.id}"`);
    ids.add(j.id);
  }
  // The debugger drives one journey at a time.
  const concurrency = options.debug ? 1 : Math.max(1, Math.floor(options.concurrency ?? 1));
  const retries = Math.max(0, Math.floor(options.retries ?? 0));
  const logger = options.logger ?? silentLogger;
  const runId = options.runId ?? newRunId();
  const runDir = resolve(options.outputDir, runId);
  await mkdir(runDir, { recursive: true });
  const vault = new EvidenceVault(runDir);
  await vault.init();
  // Where the attempts run: this process (inline) or worker processes with their own browsers (docs/scale.md).
  const mode = workerMode(options, concurrency, logger);
  const evidence = new EvidenceWriter(vault, options.mask, mode.kind === 'process');
  const store = await FingerprintStore.open(options.fingerprintStore ?? defaultFingerprintStorePath(options.outputDir));
  // Timezone-pinned runs: expression date functions agree with the browser's clock.
  if (options.timezone) setDefaultTimeZone(options.timezone);
  if (options.locale) setDefaultLocale(options.locale);
  const stepTimeoutMs = options.stepTimeoutMs ?? 10_000;
  const started = Date.now();
  const startedAt = nowIso();
  // Commit, branch, author and dirty state of the code under test (branch-aware history, baselines and filters).
  const vcs = runVcsEnvironment(await collectRunVcs(options.baseDir ?? process.cwd()));
  options.events?.emit({ type: 'run:start', runId });
  logger.info('run start', { runId, journeys: journeys.length });

  // Pre-flight environment health: when the environment is down nothing runs and the run says so.
  const health: RunHealth = {};
  if (options.healthChecks?.length) {
    const checks = await runHealthChecks(options.healthChecks, { baseUrl: options.baseUrl, db: options.db });
    health.preflight = { ok: checks.every((c) => c.ok), checks };
    for (const c of checks) logger[c.ok ? 'info' : 'error']('health check', { name: c.name, ok: c.ok, message: c.message, ms: c.ms });
    if (!health.preflight.ok) return environmentDown(journeys, checks, { runId, runDir, startedAt, started, evidence, store, options, health });
  }

  const primaryBrowser = targets[0];
  const allJourneys = [...journeys, ...hookJourneys(options)];
  const extensions = mode.kind === 'inline' ? createRunExtensions(options, { runId, runDir, browserName: primaryBrowser.id, evidence, logger }) : undefined;
  // Cancelling releases a paused debugger so the run can reach its next step boundary.
  const disarm = () => options.debug?.disarm();
  options.signal?.addEventListener('abort', disarm, { once: true });
  let runner: AttemptRunner;
  let pool: ProcessWorkerPool | undefined;
  const wanted = wantedBrowsers(allJourneys, options, targets);
  const needsBrowser = wanted.length > 0;
  try {
    if (mode.kind === 'process') {
      pool = await ProcessWorkerPool.start({
        size: Math.max(1, Math.min(concurrency, journeys.length)), runId, runDir, fingerprintStore: store.path, stepTimeoutMs, targets, journeys: allJourneys,
        plan: mode.plan, ...(options.workerSetup ? { setup: options.workerSetup } : {}), evidence, logger, options,
      });
      runner = pool;
    } else {
      runner = await LocalAttemptRunner.open(options, { runId, runDir, evidence, logger, store, extensions, stepTimeoutMs, targets, journeys: allJourneys });
    }
  } catch (e) {
    extensions?.close();
    options.signal?.removeEventListener('abort', disarm);
    throw e;
  }
  // The run's cancel reaches the worker processes too.
  const onAbort = () => pool?.cancel(options.signal!);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  // The run environment of a journey: its browser's name (results of journeys that did not run carry it).
  const browserNameOf = (j: Journey): string => j.browser ?? primaryBrowser.id;
  // Run-wide values: the Returns: of setup (beforeAll) journeys, seeded into every journey (Depends on: values win).
  let runSeed: Record<string, unknown> = {};
  const runAttempt = (j: Journey, attempt: number, handoff?: Record<string, unknown>): Promise<JourneyResult> => {
    const seed = Object.keys(runSeed).length ? { ...runSeed, ...(handoff ?? {}) } : handoff;
    return runner.run(j, attempt, seed);
  };
  /** Hook journeys (setup/teardown, Gherkin BeforeAll/AfterAll) run through the same runner. */
  const hookAttempt = (h: Journey, attempt: number, seed: Record<string, unknown> | undefined, teardown: boolean) => runner.run(h, attempt, seed, { teardown });
  const results: JourneyResult[] = new Array(journeys.length);
  // Cancelled and unable to wind down (a second signal, the grace period ran out): run.json as it stands.
  const unregisterPartial = registerPartialRunWriter(() => {
    pool?.killNow();
    const now = Array.from(results, (r, i) => r ?? cancelledJourney(journeys[i], browserNameOf(journeys[i])));
    const partial: RunResult = {
      runId, startedAt, finishedAt: nowIso(), durationMs: Date.now() - started, journeys: now, summary: summarize(now),
      environment: { node: process.version, platform: process.platform, browser: targets.map((t) => t.id).join(','), ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) },
      cancelled: { reason: cancelReason(options.signal), at: nowIso(), partial: true },
    };
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(partial, null, 2));
  });
  // Dependencies (Depends on:): prerequisites first, dependents skipped when a prerequisite did not pass.
  const plan = planDependencies(journeys);
  const done = new Set<number>();
  const ready = (i: number) => plan.errors.has(i) || plan.prereqs[i].every((p) => done.has(p));
  // Workers take the next journey whose prerequisites are done and whose resource locks (if any) are free; see queue.ts.
  const queue = new JourneyQueue(journeys, options.locks, options.signal, ready);
  // Isolated retries: a failed journey is retried after the main pass, alone, instead of immediately.
  // A prerequisite of other journeys is retried inline, so its dependents see its final result.
  const isolated = options.retryStrategy === 'isolated' && retries > 0;
  const prerequisites = new Set(plan.prereqs.flat());
  const deferred: Array<{ idx: number; j: Journey; attempts: JourneyResult[]; seed?: Record<string, unknown>; summary?: Array<{ journeyId: string; status: string; handoff: string[] }> }> = [];
  // Circuit breaker: stop wasting time when the environment went down mid-run.
  const cb = options.circuitBreaker ?? {};
  const breaker = cb.enabled === false ? undefined : new CircuitBreaker(Math.max(1, cb.threshold ?? 3), async () => {
    if (options.healthChecks?.length) {
      const checks = await runHealthChecks(options.healthChecks, { baseUrl: options.baseUrl, db: options.db });
      const bad = checks.filter((c) => !c.ok);
      return { ok: bad.length === 0, reason: bad.map((c) => `${c.name}: ${c.message}`).join('; ') || 'health checks pass' };
    }
    if (!options.baseUrl) return { ok: false, reason: 'no health checks or baseUrl to probe' };
    const [c] = await runHealthChecks([{ name: 'baseUrl', url: options.baseUrl, status: Array.from({ length: 400 }, (_, k) => 100 + k) }], {});
    return { ok: c.ok, reason: `${c.name}: ${c.message}` };
  });
  const notRun = (j: Journey, reason: string, name: string): JourneyResult => ({
    journeyId: j.id, name: j.name, startedAt: nowIso(), durationMs: 0, steps: j.steps.map((s) => skippedStep(s, reason)),
    tags: j.tags, requirements: j.requirements, risk: j.risk, attempt: 1, browser: browserNameOf(j), ledger: {}, evidence: [],
    status: 'skipped', error: { message: reason, name }, ...(j.bdd ? { bdd: bddRecord(j, options.baseDir) } : {}),
  });
  const passed = (r: JourneyResult) => r.status === 'passed' || r.status === 'passed-healed';
  /** The final result of a journey: dependency handoff summary, and why it was flaky when a retry passed. */
  const finalize = async (j: Journey, attempts: JourneyResult[], summary?: Array<{ journeyId: string; status: string; handoff: string[] }>): Promise<JourneyResult> => {
    const r = attempts[attempts.length - 1];
    if (summary) (r.reliability ??= {}).dependsOn = summary;
    // Reports show each attempt of a retried journey and the difference between them.
    if (attempts.length > 1) {
      r.attempts = attempts.map((a) => {
        const bad = a.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
        return {
          attempt: a.attempt, status: a.status, startedAt: a.startedAt, durationMs: a.durationMs,
          ...(bad ? { failedStepId: bad.stepId } : {}), ...((bad?.error ?? a.error) ? { error: (bad?.error ?? a.error)!.message.slice(0, 1000) } : {}),
          steps: a.steps.map((s) => ({ stepId: s.stepId, intent: s.intent, status: s.status, durationMs: s.durationMs })),
        };
      });
    }
    const failed = attempts.slice(0, -1).filter((a) => !passed(a));
    const last = failed[failed.length - 1];
    if (last && passed(r)) {
      const flake = classifyFlake(last, r, attemptNetwork.get(last));
      const ref = await evidence.store('data', `journeys/${safeName(j.id)}/flake-cause.json`, JSON.stringify({ ...flake, failedAttempts: failed.map((f) => ({ attempt: f.attempt, status: f.status, error: f.error, steps: f.steps.filter((s) => s.status === 'failed').map((s) => ({ stepId: s.stepId, error: s.error, reliability: s.reliability })) })) }, null, 2), { journeyId: j.id, description: `flaky: ${flake.cause}` });
      flake.evidence = [ref.id, ...flake.evidence];
      (r.reliability ??= {}).flake = flake;
      r.evidence.push(ref.id);
      logger.warn('journey passed on retry', { journeyId: j.id, cause: flake.cause, reason: flake.reason });
    }
    return r;
  };
  /** A journey is finished: record it, let dependents go, feed the circuit breaker. */
  const settle = async (idx: number, r: JourneyResult, emitEnd: boolean) => {
    // A journey that was running when the run was cancelled: its failure is the cancel, not the product.
    if (cancelledBySignal(options.signal) && (r.status === 'failed' || r.status === 'error') && r.error?.name !== 'CancelledError') r = asCancelled(r, cancelReason(options.signal));
    results[idx] = r;
    done.add(idx);
    queue.changed();
    await store.save();
    if (emitEnd) options.events?.emit({ type: 'journey:end', journeyId: r.journeyId, status: r.status });
    if (breaker && r.status !== 'skipped' && (await breaker.report(r.journeyId, r.reliability?.environment?.reason))) logger.error('circuit breaker open: environment unavailable', { reason: breaker.open?.reason });
  };
  const worker = async () => {
    for (let item = await queue.next(); item; item = await queue.next()) {
      const { index: idx, journey: j } = item;
      try {
        if (options.signal?.aborted) {
          await settle(idx, cancelledJourney(j, browserNameOf(j)), false);
          continue;
        }
        if (item.lockError) {
          await settle(idx, { ...cancelledJourney(j, browserNameOf(j)), status: 'error', error: { message: item.lockError, name: 'LockTimeout' } }, true);
          continue;
        }
        if (breaker?.open) {
          await settle(idx, notRun(j, `${ENVIRONMENT_UNAVAILABLE} (${breaker.open.reason})`, 'EnvironmentUnavailable'), false);
          continue;
        }
        const planError = plan.errors.get(idx);
        if (planError) {
          await settle(idx, notRun(j, planError, 'DependencyNotMet'), false);
          continue;
        }
        const ho = plan.prereqs[idx].length ? handoffFor(j, plan.prereqs[idx].map((p) => ({ journey: journeys[p], result: results[p] }))) : undefined;
        if (ho?.blocked) {
          const r = notRun(j, ho.blocked, 'DependencyNotMet');
          r.reliability = { dependsOn: ho.summary };
          await settle(idx, r, false);
          continue;
        }
        options.events?.emit({ type: 'journey:start', journeyId: j.id, name: j.name });
        const inline = !isolated || prerequisites.has(idx);
        const attempts: JourneyResult[] = [];
        for (let attempt = 1; attempt <= (inline ? retries + 1 : 1); attempt++) {
          const r = await runAttempt(j, attempt, ho?.seed);
          attempts.push(r);
          if (passed(r) || r.status === 'skipped' || options.signal?.aborted) break;
          if (attempt <= retries && inline) logger.warn('journey failed, retrying', { journeyId: j.id, attempt });
        }
        const first = attempts[attempts.length - 1];
        if (!inline && (first.status === 'failed' || first.status === 'error') && !options.signal?.aborted) {
          results[idx] = first; // provisional, replaced after the isolated retries
          await store.save();
          deferred.push({ idx, j, attempts, ...(ho ? { seed: ho.seed, summary: ho.summary } : {}) });
        } else {
          await settle(idx, withLostLocks(await finalize(j, attempts, ho?.summary), item.locksLost?.(), logger), true);
        }
      } finally {
        await item.release();
      }
    }
  };
  try {
    const pre = await runAllHook('beforeAll', options, hookAttempt);
    runSeed = runWideValues(options.hooks?.beforeAll ?? [], pre);
    if (Object.keys(runSeed).length) logger.info('run-wide values from setup journeys', { keys: Object.keys(runSeed) });
    // Gherkin BeforeAll hooks: once per run, before the scenarios they apply to (src/runner/bdd-all.ts).
    if (!pre.some((r) => r.status === 'failed' || r.status === 'error')) pre.push(...(await runBddAllHooks(journeys, 'beforeAll', options, hookAttempt)));
    const failedHook = pre.find((r) => (r.status === 'failed' || r.status === 'error') && !r.tags.includes('bdd'));
    if (failedHook) journeys.forEach((j, i) => { results[i] = blockedByHook(j, failedHook, browserNameOf(j)); });
    else await Promise.all(Array.from({ length: Math.min(concurrency, journeys.length) }, worker));
    // Isolated retries run one at a time after everything else (no parallel interference).
    for (const d of deferred) {
      for (let attempt = 2; attempt <= retries + 1 && !options.signal?.aborted && !breaker?.open; attempt++) {
        logger.warn('journey failed, retrying in isolation', { journeyId: d.j.id, attempt });
        const release = options.locks ? await acquireBlocking(options.locks, d.j) : undefined;
        let r: JourneyResult;
        try {
          r = await runAttempt(d.j, attempt, d.seed);
        } finally {
          await release?.();
        }
        d.attempts.push(r);
        if (passed(r) || r.status === 'skipped') break;
      }
      await settle(d.idx, await finalize(d.j, d.attempts, d.summary), true);
    }
    results.unshift(...pre);
    for (const { journey: j, reason } of sourced.empty) {
      logger.warn('journey not run: no Examples rows', { journeyId: j.id, reason });
      results.push(noRowsJourney(j, reason, primaryBrowser.id));
    }
    // Journeys whose Browsers: header leaves out every browser of this run.
    for (const { journey: j, reason } of matrix.excluded) results.push({ ...notRun(j, reason, 'NotOnThisBrowser'), browser: j.browsers?.join(',') });
    // Gherkin AfterAll hooks: once, for the scenarios that ran.
    const ran = new Set(results.filter((r) => r && r.status !== 'skipped' && !r.steps.some((x) => x.error?.name === 'BeforeAllFailed')).map((r) => r.journeyId));
    results.push(...(await runBddAllHooks(journeys.filter((j) => ran.has(j.id)), 'afterAll', options, hookAttempt)));
    results.push(...(await runAllHook('afterAll', options, hookAttempt, Object.keys(runSeed).length ? runSeed : undefined)));
  } finally {
    clearBddAllState(runDir);
    await runner.close();
    extensions?.close();
    options.signal?.removeEventListener('abort', disarm);
    options.signal?.removeEventListener('abort', onAbort);
    unregisterPartial();
  }

  const proposals = collectHealProposals({ runId, journeys: results }, journeys);
  if (proposals.proposals.length || proposals.rejected.length || proposals.improvements?.length || proposals.unverified?.length) {
    await evidence.store('report', 'heal-proposals.json', JSON.stringify(proposals, null, 2), { description: 'heal proposals for review' });
  }
  await store.save();
  const evidenceHead = await evidence.flush();
  const finishedAt = nowIso();
  const versions = runner.versions();
  const run: RunResult = {
    runId, startedAt, finishedAt, durationMs: Date.now() - started, journeys: results, summary: summarize(results),
    environment: {
      node: process.version, platform: process.platform,
      browser: needsBrowser ? wanted.map((t) => t.id).join(',') : 'none',
      browserVersion: !needsBrowser ? 'not launched' : multiBrowser
        ? wanted.map((t) => `${t.id} ${versions.get(t.id) ?? 'did not start'}`).join(', ')
        : versions.get(primaryBrowser.id) ?? [...versions.values()].find(Boolean) ?? 'unknown',
      ...(needsBrowser && wanted.some((t) => t.connect) ? { browserEndpoint: wanted.map((t) => `${t.id}: ${describeBrowser(t)}`).join(', ') } : {}),
      ...runner.driverEnvironment(),
      ...(pool ? { workers: `${pool.size} processes${pool.restarts ? `, ${pool.restarts} restarted after a crash` : ''}` } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), fingerprintStore: projectRelative(store.path, options.outputDir),
      ...vcs,
    },
    evidenceHead,
  };
  if (breaker?.open) {
    health.circuit = { ...breaker.open, notRun: results.filter((r) => r.error?.name === 'EnvironmentUnavailable').length };
  }
  if (health.preflight || health.circuit) run.health = health;
  if (cancelledBySignal(options.signal)) run.cancelled = { reason: cancelReason(options.signal), at: nowIso() };
  if (multiBrowser) run.browsers = browserSummaries(results, wanted, versions);
  // Ledgers can hold secrets (credentials, secret shared-store values): masked in the stored run.
  if (options.mask) for (const r of results) r.ledger = maskDeep(r.ledger, options.mask) as Record<string, unknown>;
  const reuse = runner.contextReuse();
  if (reuse) run.environment.contextReuse = reuse;
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  options.events?.emit({ type: 'run:end', runId });
  logger.info('run end', { runId, ...run.summary });
  return run;
}

/** A journey whose resource locks were lost while it ran: recorded on its result (and logged), never silent. */
function withLostLocks(r: JourneyResult, lost: string[] | undefined, logger: { warn(m: string, d?: Record<string, unknown>): void }): JourneyResult {
  if (!lost?.length) return r;
  (r.reliability ??= {}).locksLost = lost;
  logger.warn('resource lock lost while the journey ran', { journeyId: r.journeyId, locks: lost });
  return r;
}

/** Was the run cancelled from outside (a signal, see cancel.ts), as opposed to stopped early (--max-failures)? */
function cancelledBySignal(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted && signal.reason instanceof RunCancelledError;
}

/** The reason of an aborted run signal ("SIGTERM", ...). */
function cancelReason(signal: AbortSignal | undefined): string {
  const r = signal?.reason;
  if (r instanceof RunCancelledError) return r.signal;
  if (typeof r === 'string') return r;
  return 'aborted';
}

/** A journey that was running when the run was cancelled: kept with its steps, recorded as cancelled. */
function asCancelled(r: JourneyResult, reason: string): JourneyResult {
  const was = r.error?.message ?? r.steps.find((s) => s.error)?.error?.message;
  return { ...r, status: 'skipped', error: { message: `Run cancelled (${reason}) while the journey was running${was ? `: ${was.split('\n')[0]}` : ''}`, name: 'CancelledError' } };
}

/** Per-browser summaries of a cross-browser run (the combined one is RunResult.summary). */
function browserSummaries(results: JourneyResult[], wanted: ResolvedBrowser[], versions: Map<string, string | undefined>): NonNullable<RunResult['browsers']> {
  const out: NonNullable<RunResult['browsers']> = {};
  for (const t of wanted) {
    const v = versions.get(t.id);
    out[t.id] = { ...summarize(results.filter((r) => r.browser === t.id && !r.tags.includes('hook'))), ...(v ? { version: v } : {}) };
  }
  return out;
}

interface DownCtx {
  runId: string;
  runDir: string;
  startedAt: string;
  started: number;
  evidence: EvidenceWriter;
  store: FingerprintStore;
  options: RunOptions;
  health: RunHealth;
}

/** The result of a run whose pre-flight health checks failed: nothing ran, the environment is the problem. */
async function environmentDown(journeys: Journey[], checks: HealthCheckResult[], c: DownCtx): Promise<RunResult> {
  const bad = checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.message}`).join('; ');
  const reason = `${ENVIRONMENT_UNAVAILABLE} (pre-flight health check failed: ${bad})`;
  const ref = await c.evidence.store('data', 'health-checks.json', JSON.stringify(checks, null, 2), { description: 'pre-flight environment health checks' });
  const results: JourneyResult[] = journeys.map((j) => ({
    journeyId: j.id, name: j.name, startedAt: nowIso(), durationMs: 0, steps: j.steps.map((s) => skippedStep(s, reason)),
    tags: j.tags, requirements: j.requirements, risk: j.risk, attempt: 1, browser: c.options.browser ?? 'chromium', ledger: {}, evidence: [ref.id],
    status: 'skipped', error: { message: reason, name: 'EnvironmentUnavailable' }, reliability: { environment: { reason: bad, evidence: [ref.id] } },
    ...(j.bdd ? { bdd: bddRecord(j, c.options.baseDir) } : {}),
  }));
  const evidenceHead = await c.evidence.flush();
  const run: RunResult = {
    runId: c.runId, startedAt: c.startedAt, finishedAt: nowIso(), durationMs: Date.now() - c.started, journeys: results, summary: summarize(results),
    environment: { node: process.version, platform: process.platform, browser: c.options.browser ?? 'chromium', ...(c.options.baseUrl ? { baseUrl: c.options.baseUrl } : {}), fingerprintStore: projectRelative(c.store.path, c.options.outputDir), health: 'down' },
    evidenceHead, health: c.health,
  };
  await writeFile(join(c.runDir, 'run.json'), JSON.stringify(run, null, 2));
  c.options.events?.emit({ type: 'run:end', runId: c.runId });
  return run;
}
