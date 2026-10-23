/** runJourneys: the top-level executor. */
import { bindJourney } from '../elements/bind.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Browser } from '../browser/index.js';
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
import { blockedByHook, expandExamples, hookJourneys, runAllHook, runWideValues } from './journey-hooks.js';
import { maskDeep } from './dom.js';
import { createRunExtensions } from './extensions.js';
import { resolveExamplesSources } from './examples-source.js';
import { attemptNetwork, cancelledJourney, noRowsJourney, runJourneyAttempt, type JourneyRunEnv } from './journey.js';
import { acquireBlocking, JourneyQueue } from './queue.js';
import type { RunOptions } from './types.js';
import { skippedStep } from './step.js';
import { CircuitBreaker, ENVIRONMENT_UNAVAILABLE, classifyEnvironmentFailure, runHealthChecks } from './reliability/health.js';
import { classifyFlake } from './reliability/flake.js';
import { handoffFor, planDependencies } from './reliability/dependencies.js';
import { ContextPool } from './reliability/context-pool.js';
import { installAppIdle } from './reliability/idle.js';
import { safeName } from './evidence.js';
import type { HealthCheckResult, RunHealth } from '../core/index.js';
import { driverFor, noDriverJourney, platformOf, type PlatformDriver } from './platform.js';
import { describeBrowser, expandBrowserMatrix, openBrowser, runBrowsers, type ResolvedBrowser } from './browsers.js';

/** Stand-in when every journey runs on a platform driver: using it is a bug, so it fails loudly. */
function noBrowser(): Browser {
  return new Proxy({} as Browser, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      throw new Error(`No browser was launched for this run (all journeys target native platforms); tried to use browser.${String(prop)}`);
    },
  });
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
  const evidence = new EvidenceWriter(vault, options.mask);
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
  const extensions = createRunExtensions(options, { runId, runDir, browserName: primaryBrowser.id, evidence, logger });
  // Cancelling releases a paused debugger so the run can reach its next step boundary.
  const disarm = () => options.debug?.disarm();
  options.signal?.addEventListener('abort', disarm, { once: true });
  // Non-web journeys (Platform: android/ios) run through a platform driver; the browser is launched only when needed.
  const webJourneys = [...journeys, ...hookJourneys(options)].filter((j) => platformOf(j, options) === 'web');
  const needsBrowser = webJourneys.length > 0;
  // Every browser the plan uses is launched (or attached to) up front; in a cross-browser run a browser
  // that cannot start turns only its own units into errors.
  const wanted = targets.filter((t, i) => i === 0 ? webJourneys.some((j) => !j.browser || j.browser === t.id) : webJourneys.some((j) => j.browser === t.id));
  const browsers = new Map<string, Browser>();
  const launchErrors = new Map<string, Error>();
  if (needsBrowser) {
    await Promise.all(wanted.map(async (t) => {
      try {
        browsers.set(t.id, await openBrowser(t, options));
      } catch (e) {
        launchErrors.set(t.id, e as Error);
      }
    }));
    if (!multiBrowser || launchErrors.size === wanted.length) {
      const first = launchErrors.values().next().value;
      if (first) {
        for (const b of browsers.values()) await b.close().catch(() => undefined);
        extensions?.close();
        throw first;
      }
    }
    for (const [id, e] of launchErrors) logger.error('browser did not start', { browser: id, message: e.message });
  }
  const browser = browsers.get(primaryBrowser.id) ?? (needsBrowser && browsers.size ? [...browsers.values()][0] : noBrowser());
  const usedDrivers = new Set<PlatformDriver>();
  const poolFor = (b: Browser) => options.reuseContext && needsBrowser
    ? new ContextPool(b, {
      acceptDownloads: true, ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.timezone ? { timezoneId: options.timezone } : {}), ...(options.locale ? { locale: options.locale } : {}),
      ...(options.clientCertificates?.some((c) => c.browser !== false) ? { clientCertificates: options.clientCertificates.filter((c, i, all) => c.browser !== false && all.findIndex((x) => x.browser !== false && x.origin === c.origin) === i).map((c) => ({ origin: c.origin, ...(c.pfx ? { pfx: c.pfx } : {}), ...(c.cert ? { cert: c.cert } : {}), ...(c.key ? { key: c.key } : {}), ...(c.passphrase !== undefined ? { passphrase: c.passphrase } : {}) })) } : {}),
    }, options.reliability?.appIdle ? (c) => installAppIdle(c, options.reliability!.appIdle === true ? {} : options.reliability!.appIdle as object) : undefined)
    : undefined;
  const contextPool = needsBrowser && browsers.has(primaryBrowser.id) ? poolFor(browser) : undefined;
  const env: JourneyRunEnv = {
    extensions, contextPool,
    runId, runDir, browser, browserName: primaryBrowser.id, evidence, logger, opts: options, store, stepTimeoutMs,
    locateTimeoutMs: options.locateTimeoutMs ?? Math.min(stepTimeoutMs, 5000),
    conditionTimeoutMs: options.conditionTimeoutMs ?? 5000,
    journeys: [...journeys, ...hookJourneys(options)],
    platformDriverUsed: (d) => usedDrivers.add(d),
  };
  // One run environment per browser of a cross-browser run (its own browser and context pool).
  const envs = new Map<string, JourneyRunEnv>([[primaryBrowser.id, env]]);
  for (const t of targets.slice(1)) {
    const b = browsers.get(t.id);
    if (b) envs.set(t.id, { ...env, browser: b, browserName: t.id, contextPool: poolFor(b) });
  }
  const envOf = (j: Journey): JourneyRunEnv => envs.get(j.browser ?? primaryBrowser.id) ?? { ...env, browserName: j.browser ?? env.browserName };
  // Web journeys run in browser contexts; others go to their platform driver (locks and retries apply to both).
  /**
   * One attempt on the journey's platform. `seed` holds the ledger values handed over by `Depends on:`
   * prerequisites: web journeys get them in the ledger; platform drivers (which have no ledger hook) get
   * them as journey variables (strings, JSON for objects).
   */
  // Run-wide values: the Returns: of setup (beforeAll) journeys, seeded into every journey (Depends on: values win).
  let runSeed: Record<string, unknown> = {};
  const runAttempt = async (j: Journey, attempt: number, handoff?: Record<string, unknown>): Promise<JourneyResult> => {
    const seed = Object.keys(runSeed).length ? { ...runSeed, ...(handoff ?? {}) } : handoff;
    const platform = platformOf(j, options);
    if (platform === 'web') {
      const failedLaunch = launchErrors.get(j.browser ?? primaryBrowser.id);
      if (failedLaunch) return browserDown(j, attempt, j.browser ?? primaryBrowser.id, failedLaunch);
      return runJourneyAttempt(j, attempt, envOf(j), seed);
    }
    const driver = driverFor(platform, options);
    if (!driver) return noDriverJourney(j, platform, attempt);
    usedDrivers.add(driver);
    const vars = seed ? Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : undefined;
    const r = await driver.runAttempt(vars ? { ...j, variables: { ...j.variables, ...vars } } : j, attempt, env);
    // Environment classification from the error text (drivers keep no browser network log), for the circuit breaker and triage.
    if ((r.status === 'failed' || r.status === 'error') && !r.reliability?.environment) {
      const reason = classifyEnvironmentFailure(r);
      if (reason) (r.reliability ??= {}).environment = { reason, evidence: [...r.evidence] };
    }
    return r;
  };
  const results: JourneyResult[] = new Array(journeys.length);
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
    tags: j.tags, requirements: j.requirements, risk: j.risk, attempt: 1, browser: envOf(j).browserName, ledger: {}, evidence: [],
    status: 'skipped', error: { message: reason, name },
  });
  const passed = (r: JourneyResult) => r.status === 'passed' || r.status === 'passed-healed';
  /** The final result of a journey: dependency handoff summary, and why it was flaky when a retry passed. */
  const finalize = async (j: Journey, attempts: JourneyResult[], summary?: Array<{ journeyId: string; status: string; handoff: string[] }>): Promise<JourneyResult> => {
    const r = attempts[attempts.length - 1];
    if (summary) (r.reliability ??= {}).dependsOn = summary;
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
          await settle(idx, cancelledJourney(j, envOf(j).browserName), false);
          continue;
        }
        if (item.lockError) {
          await settle(idx, { ...cancelledJourney(j, envOf(j).browserName), status: 'error', error: { message: item.lockError, name: 'LockTimeout' } }, true);
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
          await settle(idx, await finalize(j, attempts, ho?.summary), true);
        }
      } finally {
        await item.release();
      }
    }
  };
  try {
    const pre = await runAllHook('beforeAll', env);
    runSeed = runWideValues(options.hooks?.beforeAll ?? [], pre);
    if (Object.keys(runSeed).length) logger.info('run-wide values from setup journeys', { keys: Object.keys(runSeed) });
    const failedHook = pre.find((r) => r.status === 'failed' || r.status === 'error');
    if (failedHook) journeys.forEach((j, i) => { results[i] = blockedByHook(j, failedHook, envOf(j).browserName); });
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
      results.push(noRowsJourney(j, reason, env.browserName));
    }
    // Journeys whose Browsers: header leaves out every browser of this run.
    for (const { journey: j, reason } of matrix.excluded) results.push({ ...notRun(j, reason, 'NotOnThisBrowser'), browser: j.browsers?.join(',') });
    results.push(...(await runAllHook('afterAll', env, Object.keys(runSeed).length ? runSeed : undefined)));
  } finally {
    for (const e of envs.values()) await e.contextPool?.closeAll();
    for (const d of usedDrivers) await d.close?.().catch((e: unknown) => logger.warn('platform driver close failed', { driver: d.name, message: (e as Error).message }));
    // Launched browsers are closed; attached (remote) ones only lose the contexts this run created.
    for (const b of browsers.values()) await b.close().catch(() => undefined);
    extensions?.close();
    options.signal?.removeEventListener('abort', disarm);
  }

  const proposals = collectHealProposals({ runId, journeys: results }, journeys);
  if (proposals.proposals.length || proposals.rejected.length || proposals.improvements?.length) {
    await evidence.store('report', 'heal-proposals.json', JSON.stringify(proposals, null, 2), { description: 'heal proposals for review' });
  }
  await store.save();
  const evidenceHead = await evidence.flush();
  const finishedAt = nowIso();
  const run: RunResult = {
    runId, startedAt, finishedAt, durationMs: Date.now() - started, journeys: results, summary: summarize(results),
    environment: {
      node: process.version, platform: process.platform,
      browser: needsBrowser ? wanted.map((t) => t.id).join(',') : 'none',
      browserVersion: !needsBrowser ? 'not launched' : multiBrowser
        ? wanted.map((t) => `${t.id} ${browsers.get(t.id)?.version() ?? 'did not start'}`).join(', ')
        : browser.version(),
      ...(needsBrowser && wanted.some((t) => t.connect) ? { browserEndpoint: wanted.map((t) => `${t.id}: ${describeBrowser(t)}`).join(', ') } : {}),
      ...Object.assign({}, ...[...usedDrivers].map((d) => d.environment?.() ?? {})),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), fingerprintStore: store.path,
      ...vcs,
    },
    evidenceHead,
  };
  if (breaker?.open) {
    health.circuit = { ...breaker.open, notRun: results.filter((r) => r.error?.name === 'EnvironmentUnavailable').length };
  }
  if (health.preflight || health.circuit) run.health = health;
  if (multiBrowser) run.browsers = browserSummaries(results, wanted, browsers);
  // Ledgers can hold secrets (credentials, secret shared-store values): masked in the stored run.
  if (options.mask) for (const r of results) r.ledger = maskDeep(r.ledger, options.mask) as Record<string, unknown>;
  if (contextPool) run.environment.contextReuse = `${contextPool.created} created, ${contextPool.reused} reused`;
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  options.events?.emit({ type: 'run:end', runId });
  logger.info('run end', { runId, ...run.summary });
  return run;
}

/** Per-browser summaries of a cross-browser run (the combined one is RunResult.summary). */
function browserSummaries(results: JourneyResult[], wanted: ResolvedBrowser[], browsers: Map<string, Browser>): NonNullable<RunResult['browsers']> {
  const out: NonNullable<RunResult['browsers']> = {};
  for (const t of wanted) {
    const v = browsers.get(t.id)?.version();
    out[t.id] = { ...summarize(results.filter((r) => r.browser === t.id && !r.tags.includes('hook'))), ...(v ? { version: v } : {}) };
  }
  return out;
}

/** The result of a unit whose browser could not be launched or attached to. */
function browserDown(j: Journey, attempt: number, browser: string, e: Error): JourneyResult {
  const message = `browser ${browser} did not start: ${e.message.split('\n')[0]}`;
  return {
    journeyId: j.id, name: j.name, startedAt: nowIso(), durationMs: 0, steps: j.steps.map((s) => skippedStep(s, `not run: ${message}`)),
    tags: j.tags, requirements: j.requirements, risk: j.risk, attempt, browser, ledger: {}, evidence: [],
    status: 'error', error: { message, name: 'BrowserLaunchError' },
  };
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
  }));
  const evidenceHead = await c.evidence.flush();
  const run: RunResult = {
    runId: c.runId, startedAt: c.startedAt, finishedAt: nowIso(), durationMs: Date.now() - c.started, journeys: results, summary: summarize(results),
    environment: { node: process.version, platform: process.platform, browser: c.options.browser ?? 'chromium', ...(c.options.baseUrl ? { baseUrl: c.options.baseUrl } : {}), fingerprintStore: c.store.path, health: 'down' },
    evidenceHead, health: c.health,
  };
  await writeFile(join(c.runDir, 'run.json'), JSON.stringify(run, null, 2));
  c.options.events?.emit({ type: 'run:end', runId: c.runId });
  return run;
}
