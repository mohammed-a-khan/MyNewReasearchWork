/**
 * Runs one journey attempt in its own BrowserContext: steps in order,
 * evidence per policy, console/network logs, optional trace.
 */
import { readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '../browser/index.js';
import {
  interpolate,
  journeyStatusFrom,
  nowIso,
  type Journey,
  type JourneyResult,
  type Logger,
  type Step,
  type StepResult,
} from '../core/index.js';
import { safeName, type EvidenceWriter } from './evidence.js';
import type { RunExtensions } from './extensions.js';
import { Ledger } from './ledger.js';
import { executeStepCore, skippedStep, type StepRuntime } from './step.js';
import { overlayHide, overlayStepStart } from './video-overlay.js';
import type { LensFinding, RunOptions, StepContext } from './types.js';
import { contextOptionsFor } from './browser-state.js';
import { executeStep, type FlowEnv, type FlowScope } from './flow.js';
import { hookStep, storeSessionEvidence } from './journey-hooks.js';
import { BrowserSession } from './session.js';
import { takeReliability } from './reliability/guard.js';
import { installAppIdle } from './reliability/idle.js';
import { checkPreconditions, DATA_PRECONDITION, DataPreconditionError } from './reliability/preconditions.js';
import { classifyEnvironmentFailure, type NetLogEntry } from './reliability/health.js';
import { detectSessionExpiry } from './reliability/session-expiry.js';
import { diagnoseFailure, diagnosisHint, removeOutlines } from './reliability/diagnose.js';
import type { ContextPool } from './reliability/context-pool.js';
import { actorSpec, isMultiActor, primaryActor, type ActorRuntime, type ActorSlot } from './actors.js';
import { driverFor, type PlatformDriver } from './platform.js';
import type { Emulation } from '../core/index.js';

/** Network log of each finished attempt (for the flake classifier); not serialised. */
export const attemptNetwork = new WeakMap<JourneyResult, NetLogEntry[]>();
import { runCodeJourney } from './code-host.js';
import { bddRecord } from './bdd-run.js';
import { applyJourneyClock, clockVars, usesClock } from './clock.js';
import { manualSummary } from './manual.js';

export interface JourneyRunEnv extends StepRuntime {
  runId: string;
  runDir: string;
  browser: Browser;
  browserName: string;
  evidence: EvidenceWriter;
  logger: Logger;
  /** All journeys of the run (callable with "Run journey"). */
  journeys?: Journey[];
  /** Opt-in time-travel trace / debugger (undefined when both are off). */
  extensions?: RunExtensions;
  /** Shared browser contexts (reuseContext), when enabled. */
  contextPool?: ContextPool;
  /** Called when a multi-actor journey runs a native actor on a platform driver (the run closes it at the end). */
  platformDriverUsed?: (driver: PlatformDriver) => void;
}

interface NetEntry {
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  startedAt: number;
  durationMs?: number;
  /** Same as durationMs; the field name the perf/insights network model reads. */
  timing?: number;
  failure?: string;
  journeyId: string;
  stepId?: string;
  /** Multi-actor journeys: whose session made the request. */
  actor?: string;
}

type ConsoleEntry = { type: string; text: string; at: string; actor?: string };

function attachLogs(page: Page, journeyId: string, currentStep: () => string | undefined, actor?: string) {
  const consoleLog: ConsoleEntry[] = [];
  const network: NetEntry[] = [];
  const pending: Array<Promise<void>> = [];
  // Popups and new tabs (and the pages of other actors) are logged into the same console/network logs.
  const attachAs = (p: Page, who: string | undefined, step: () => string | undefined) => wire(p, journeyId, step, consoleLog, network, pending, who);
  const attach = (p: Page) => attachAs(p, actor, currentStep);
  attach(page);
  return { consoleLog, network, attach, attachAs, settle: () => Promise.allSettled(pending) };
}

function wire(page: Page, journeyId: string, currentStep: () => string | undefined, consoleLog: ConsoleEntry[], network: NetEntry[], pending: Array<Promise<void>>, actor?: string): void {
  const who = actor ? { actor } : {};
  page.on('console', (m) => consoleLog.push({ type: m.type(), text: m.text(), at: nowIso(), ...who }));
  page.on('pageerror', (e) => consoleLog.push({ type: 'pageerror', text: e.message, at: nowIso(), ...who }));
  page.on('requestfinished', (req) => {
    pending.push(
      (async () => {
        const res = await req.response().catch(() => null);
        const t = req.timing();
        const durationMs = t.responseEnd >= 0 ? Math.round(t.responseEnd) : undefined;
        network.push({
          method: req.method(), url: req.url(), status: res?.status(), resourceType: req.resourceType(),
          startedAt: t.startTime, durationMs, timing: durationMs, journeyId, stepId: currentStep(), ...who,
        });
      })(),
    );
  });
  page.on('requestfailed', (req) => {
    network.push({
      method: req.method(), url: req.url(), resourceType: req.resourceType(), startedAt: req.timing().startTime,
      failure: req.failure()?.errorText, journeyId, stepId: currentStep(), ...who,
    });
  });
}

const CANCELLED = 'not run: run cancelled';
const cancelledFields = () => ({ status: 'skipped' as const, error: { message: 'Run cancelled', name: 'CancelledError' } });

/** The result of a journey that never started because the run was cancelled (RunOptions.signal). */
export function cancelledJourney(journey: Journey, browserName: string): JourneyResult {
  return {
    journeyId: journey.id, name: journey.name, startedAt: nowIso(), durationMs: 0, steps: journey.steps.map((s) => skippedStep(s, CANCELLED)),
    tags: journey.tags, requirements: journey.requirements, risk: journey.risk, attempt: 1, browser: browserName, ledger: {}, evidence: [], ...cancelledFields(),
    ...(journey.bdd ? { bdd: bddRecord(journey) } : {}),
  };
}

/** The result of a data-driven journey whose external Examples source produced no rows (or failed to load). */
export function noRowsJourney(journey: Journey, reason: string, browserName: string): JourneyResult {
  return {
    journeyId: journey.id, name: journey.name, startedAt: nowIso(), durationMs: 0, steps: journey.steps.map((s) => skippedStep(s, reason)),
    tags: journey.tags, requirements: journey.requirements, risk: journey.risk, attempt: 1, browser: browserName, ledger: {}, evidence: [],
    status: 'skipped', error: { message: reason, name: 'NoExamplesRows' },
    ...(journey.bdd ? { bdd: bddRecord(journey) } : {}),
  };
}

/**
 * Run one attempt of a journey. Never throws: infrastructure errors become an "error" journey.
 * `seed` pre-fills the ledger (values handed over by `Depends on:` prerequisites).
 */
/**
 * A journey's `Lenses:` header turns lenses on for that journey: the run's lenses, plus one instance
 * (from RunOptions.lensFactory) of each named lens the run does not have. "security:warn" records only.
 */
export function withJourneyLenses(journey: Journey, env: JourneyRunEnv): JourneyRunEnv {
  const have = new Set((env.opts.lenses ?? []).map((l) => l.name));
  const wanted = journey.lenses.filter((spec) => !have.has(spec.split(':')[0]));
  if (!wanted.length || !env.opts.lensFactory) return env;
  return { ...env, opts: { ...env.opts, lenses: [...(env.opts.lenses ?? []), ...wanted.map((spec) => env.opts.lensFactory!(spec))] } };
}

export async function runJourneyAttempt(journey: Journey, attempt: number, runEnv: JourneyRunEnv, seed?: Record<string, unknown>): Promise<JourneyResult> {
  const env = withJourneyLenses(journey, runEnv);
  const { opts, evidence } = env;
  const started = Date.now();
  const startedAt = nowIso();
  const jid = journey.id;
  const result: JourneyResult = {
    journeyId: jid, name: journey.name, status: 'error', startedAt, durationMs: 0, steps: [], tags: journey.tags,
    requirements: journey.requirements, risk: journey.risk, attempt, browser: env.browserName, ledger: {}, evidence: [],
    ...(journey.bdd ? { bdd: bddRecord(journey, opts.baseDir) } : {}),
  };
  const ledger = new Ledger();
  for (const [k, v] of Object.entries(seed ?? {})) ledger.set(k, v);
  const baseUrl = journey.baseUrl ?? opts.baseUrl;
  let clockContext: BrowserContext | undefined;
  // today() / now() follow the journey's browser clock once one is installed.
  const vars = (): Record<string, unknown> => ({ ...journey.variables, ...(opts.variables ?? {}), ...ledger.view(), ...clockVars(clockContext) });
  const videoMode = opts.video ?? 'off';
  const videoDir = join(env.runDir, 'videos', `${safeName(jid)}-attempt${attempt}`);
  // mTLS from the browser: one certificate per origin (the context option clientCertificates).
  const certs = (opts.clientCertificates ?? []).filter((c, i, all) => c.browser !== false && all.findIndex((x) => x.browser !== false && x.origin === c.origin) === i);
  // Multi-actor journeys (docs/multi-actor.md): every actor gets its own context; the primary actor's is this first one.
  const multi = isMultiActor(journey);
  const primaryName = primaryActor(journey);
  const pooled = env.contextPool !== undefined && ContextPoolEligible(journey, opts) && !multi;
  const newContext = (actorEmulation: Emulation | undefined, dir: string) => env.browser.newContext({
    acceptDownloads: true, ...(opts.viewport ? { viewport: opts.viewport } : {}),
    // Pinned run time zone / locale (a journey's own Timezone:/Locale: still wins below).
    ...(opts.timezone ? { timezoneId: opts.timezone } : {}), ...(opts.locale ? { locale: opts.locale } : {}),
    ...(videoMode !== 'off' ? { recordVideo: { dir } } : {}),
    ...(certs.length ? { clientCertificates: certs.map((c) => ({ origin: c.origin, ...(c.pfx ? { pfx: c.pfx } : {}), ...(c.cert ? { cert: c.cert } : {}), ...(c.key ? { key: c.key } : {}), ...(c.passphrase !== undefined ? { passphrase: c.passphrase } : {}) })) } : {}),
    ...contextOptionsFor(actorEmulation ? { ...(journey.emulation ?? {}), ...actorEmulation } : journey.emulation, vars()),
  });
  const context = pooled ? await env.contextPool!.acquire() : await newContext(multi ? actorSpec(journey, primaryName).emulation : undefined, videoDir);
  if (!pooled && opts.reliability?.appIdle) await installAppIdle(context, opts.reliability.appIdle === true ? {} : opts.reliability.appIdle);
  clockContext = context;
  await applyJourneyClock(journey, context);
  await (async () => opts.lifecycle?.journeyStart?.(journey, attempt))().catch((e: Error) => env.logger.warn('journey start hook failed', { journeyId: jid, message: e.message }));
  const traceRel = `traces/${safeName(jid)}-attempt${attempt}.zip`;
  const traceMode = opts.trace ? 'on' : (opts.traceMode ?? 'off');
  if (traceMode !== 'off') await context.tracing.start({ screenshots: true, snapshots: true, title: journey.name });
  const page = await context.newPage();
  if (pooled) env.contextPool!.track(page);
  let currentStepId: string | undefined;
  const logs = attachLogs(page, jid, () => currentStepId, multi ? primaryName : undefined);
  // Tabs, popups, frames, dialogs and recorded events; `ctx.page` is always the current tab.
  const session = new BrowserSession(context, page, {
    mask: opts.mask, logger: env.logger, dialogs: opts.dialogs,
    onNewPage: (p) => {
      logs.attach(p);
      if (pooled) env.contextPool!.track(p);
    },
  });
  const prefix = `journeys/${safeName(jid)}/attempt-${attempt}`;
  const meta = (stepId?: string, description?: string) => ({ journeyId: jid, ...(stepId ? { stepId } : {}), ...(description ? { description } : {}) });

  // ------------------------------------------------ actors: one slot per actor (the primary one owns the first context)
  const primarySlot: ActorSlot = { name: primaryName, spec: actorSpec(journey, primaryName), platform: 'web', context, session };
  const slots = new Map<string, ActorSlot>([[primaryName, primarySlot]]);
  const opening = new Map<string, Promise<{ slot: ActorSlot; created: boolean }>>();
  const actorVideoDir = (name: string) => join(videoDir, `actor-${safeName(name)}`);
  const openActor = async (name: string): Promise<{ slot: ActorSlot; created: boolean }> => {
    const spec = actorSpec(journey, name);
    const platform = spec.platform ?? 'web';
    const slot: ActorSlot = { name, spec, platform };
    if (platform === 'web') {
      const c = await newContext(spec.emulation, actorVideoDir(name));
      try {
        if (opts.reliability?.appIdle) await installAppIdle(c, opts.reliability.appIdle === true ? {} : opts.reliability.appIdle);
        if (traceMode !== 'off') await c.tracing.start({ screenshots: true, snapshots: true, title: `${journey.name} (${name})` });
        const p = await c.newPage();
        const step = () => slot.currentStepId;
        logs.attachAs(p, name, step);
        slot.context = c;
        slot.session = new BrowserSession(c, p, { mask: opts.mask, logger: env.logger, dialogs: opts.dialogs, onNewPage: (np) => logs.attachAs(np, name, step) });
      } catch (e) {
        await c.close().catch(() => undefined);
        throw e;
      }
      env.logger.info('actor joined', { journeyId: jid, actor: name });
    }
    slots.set(name, slot);
    return { slot, created: true };
  };
  // Labels go on steps of journeys with actors, and of code journeys from the moment a second actor joins.
  const labelled = () => multi || slots.size > 1;
  const actors: ActorRuntime = {
    primary: primaryName,
    get labelled() {
      return labelled();
    },
    // The debugger and the time-travel trace follow one page at a time: parallel branches run one after the other.
    sequentialParallel: !!opts.debug || !!opts.timeTravel?.enabled,
    get: (name) => slots.get(name),
    enter: async (name) => {
      const hit = slots.get(name);
      if (hit) return { slot: hit, created: false };
      const pending = opening.get(name);
      // Parallel branches entering the same new actor share one context; only the first one signs in.
      if (pending) return { slot: (await pending).slot, created: false };
      const p = openActor(name);
      opening.set(name, p);
      try {
        return await p;
      } catch (e) {
        opening.delete(name);
        throw e;
      }
    },
    runNative: async (slot, steps, view) => {
      const driver = driverFor(slot.platform, opts);
      if (!driver) return { steps: [], ledger: {}, evidence: [], error: `No driver for platform "${slot.platform}" (actor ${slot.name}): configure "mobile:" in eztest.config.yaml or pass RunOptions.platformDrivers` };
      env.platformDriverUsed?.(driver);
      const handed = Object.fromEntries(Object.entries(view).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
      const sub: Journey = {
        ...journey, id: `${jid}~${safeName(slot.name)}`, name: `${journey.name} (as ${slot.name})`, steps, platform: slot.platform as Journey['platform'],
        app: slot.spec.app ?? journey.app, capabilities: { ...(journey.capabilities ?? {}), ...(slot.spec.capabilities ?? {}) },
        variables: { ...journey.variables, ...handed }, actors: undefined, examples: undefined, examplesFrom: undefined, dependsOn: undefined, requires: undefined, data: [], code: undefined,
      };
      const r = await driver.runAttempt(sub, attempt, env);
      const ok = r.status === 'passed' || r.status === 'passed-healed';
      const failed = r.steps.find((x) => x.status === 'failed');
      return { steps: r.steps, ledger: r.ledger, evidence: r.evidence, ...(ok ? {} : { error: r.error?.message ?? failed?.error?.message ?? `actor ${slot.name}: ${r.status}` }) };
    },
  };
  const slotOf = (scope?: FlowScope): ActorSlot => slots.get(scope?.actor ?? primaryName) ?? primarySlot;

  const ctxFor = (step: Step, scope?: FlowScope): StepContext => {
    const j = scope?.journey ?? journey;
    const l = scope?.ledger ?? ledger;
    const v = scope && scope.ledger !== ledger
      ? (): Record<string, unknown> => ({ ...j.variables, ...(opts.variables ?? {}), ...(scope.params ?? {}), ...l.view(), ...clockVars(clockContext) })
      : vars;
    const slot = slotOf(scope);
    const s = slot.session ?? session;
    return {
      runId: env.runId, runDir: env.runDir, journey: j, step, get page() { return s.page; }, context: slot.context ?? context, ledger: l, attempt, baseUrl, logger: env.logger, evidence,
      vars: v, interpolate: (str: string) => interpolate(str, v()), session: s, ...(labelled() ? { actor: slot.name } : {}), rootJourneyId: journey.id,
    };
  };
  const jx = env.extensions?.startJourney({ journey, attempt, page, context, ledger, vars, ctxFor: (s) => ctxFor(s), runtime: env, browserName: env.browserName });
  // Every executed leaf step (top level, inside blocks and loops, in sub-journeys and hooks) goes through
  // the trace/debug extension. Top-level steps keep their journey index; others get unique indices after them.
  let extraIndex = journey.steps.length;
  const aux: StepAux = { console: logs.consoleLog, network: logs.network };
  const leafCore = async (step: Step, sc: FlowScope): Promise<StepResult> => {
    const slot = slotOf(sc);
    slot.currentStepId = step.id;
    const label = (sr: StepResult): StepResult => (labelled() ? { ...sr, actor: slot.name } : sr);
    if (!jx) return label(await runStep(step, ctxFor(step, sc), env, sc.prefix, meta, aux));
    const top = sc.ledger === ledger ? journey.steps.indexOf(step) : -1;
    const own = slot.session ?? session;
    // Trace, screencast and debugger show the acting actor's page.
    if (labelled()) jx.followPage(own.page);
    return label(await jx.runStep(top >= 0 ? top : extraIndex++, step, async (s) => {
      const sr = await runStep(s, ctxFor(s, sc), env, sc.prefix, meta, aux);
      // A step may have switched tabs: trace, screencast and debugger follow the current page.
      jx.followPage(own.page);
      return sr;
    }, labelled() ? slot.name : undefined));
  };
  // Session expired mid-journey: re-login once as the actor's role, go back and re-run the step.
  const leaf = async (step: Step, sc: FlowScope): Promise<StepResult> => {
    const since = Date.now();
    const slot = slotOf(sc);
    const own = slot.session ?? session;
    const startUrl = own.page.url();
    let sr = await leafCore(step, sc);
    const exp = opts.sessionExpiry;
    const relogin = opts.relogin ?? opts.login;
    const loginRole = slot.loginRole;
    if (sr.status === 'failed' && exp && exp.relogin !== false && loginRole && !slot.relogged && step.action !== 'login' && relogin) {
      const why = await detectSessionExpiry(own.page, exp, own.requests, since).catch(() => undefined);
      if (why) {
        slot.relogged = true;
        env.logger.warn('session expired mid-journey; signing in again', { journeyId: jid, stepId: step.id, reason: why });
        await relogin(own.page, loginRole, ctxFor(step, sc));
        if (/^https?:/.test(startUrl)) await own.page.goto(startUrl, { timeout: env.stepTimeoutMs }).catch(() => undefined);
        const ev = await evidence.store('log', `${sc.prefix}/${safeName(step.id)}.relogin.json`,
          JSON.stringify({ stepId: step.id, role: loginRole, reason: why, firstFailure: sr.error?.message, returnedTo: startUrl }, null, 2), meta(step.id, 'session expired: re-login'));
        const again = await leafCore(step, sc);
        again.warnings = [...(again.warnings ?? []), `session expired (${why}); signed in again as ${loginRole} and re-ran the step`];
        again.evidence.push(ev.id);
        again.reliability = { waits: again.reliability?.waits ?? [], recovered: [...(again.reliability?.recovered ?? []), { cause: 'environment', detail: `session expired (${why}); re-logged in as ${loginRole}` }] };
        (result.reliability ??= {}).relogins = [...(result.reliability.relogins ?? []), { stepId: step.id, role: loginRole, reason: why, evidence: ev.id }];
        sr = again;
      }
    }
    if (step.action === 'login' && sr.status === 'passed') slot.loginRole = step.value !== undefined ? interpolate(step.value, vars()) : journey.role;
    return sr;
  };
  const flow: FlowEnv = {
    opts, logger: env.logger, events: opts.events, stepTimeoutMs: env.stepTimeoutMs, journeys: env.journeys,
    leaf,
    ctx: (step, scope) => ctxFor(step, scope),
    onStep: (id) => { currentStepId = id; },
    // Code steps (eztest/sdk) that run in Node, and code step() groups, get trace and debugger hooks too.
    wrap: (step, exec) => (jx ? jx.runStep(extraIndex++, step, exec) : exec(step)),
    group: (step) => (jx ? jx.group(extraIndex++, step) : { before: async () => 'continue' as const, after: () => undefined }),
    actors,
  };
  const scope: FlowScope = { journey, ledger, prefix, depth: 0 };

  try {
    const missingLenses = journey.lenses.filter((n) => !(opts.lenses ?? []).some((l) => l.name === n.split(':')[0]));
    if (missingLenses.length) throw new Error(`Journey requires lens(es) not provided to the runner: ${missingLenses.join(', ')}`);
    // Data-state preconditions and data needs: a miss is a data problem, not a product failure.
    if (journey.requires?.length) (result.reliability ??= {}).preconditions = await checkPreconditions(journey.requires, ctxFor(journey.steps[0]), opts);
    if (journey.data.length) {
      if (!opts.data) throw new Error('Journey declares data needs but no data handler is configured (RunOptions.data)');
      for (const need of journey.data) {
        try {
          ledger.set(need.as, await opts.data(need, ctxFor(journey.steps[0])));
        } catch (e) {
          const why = (e as Error).message.split('\n')[0];
          throw new DataPreconditionError(`data problem: ${need.entity} as ${need.as}: ${why}`, [{ check: `data ${need.entity} as ${need.as}`, passed: false, message: why }]);
        }
      }
    }
    // A `Story:` journey opens its component story on the harness first; its args come from the journey variables
    // whose names the story declares (Examples rows set them). Visual/a11y lenses then apply to the mounted story.
    if (journey.story) {
      if (!opts.storyHarness) throw new Error(`Journey has a "Story:" header but no component harness is configured (run with "eztest stories" or RunOptions.storyHarness)`);
      // Args are the journey's own variables (Examples rows and the Variables header), not run-level variables.
      const storyArgs: Record<string, unknown> = { ...journey.variables };
      const url = opts.storyHarness.urlFor(journey.story.id, storyArgs);
      await session.page.goto(url, { timeout: env.stepTimeoutMs });
      await session.page.locator('#ez-root[data-ez-story-ready], #ez-root[data-ez-story-error]').first().waitFor({ timeout: env.stepTimeoutMs }).catch(() => undefined);
      const err = await session.page.locator('#ez-root').getAttribute('data-ez-story-error').catch(() => null);
      if (err) throw new Error(`story "${journey.story.id}" failed to mount: ${err}`);
    }
    let blocked: string | undefined;
    // A code journey (eztest/sdk) runs its function instead of walking `steps`; its SDK calls become the step results.
    const steps = [...(opts.hooks?.beforeEach ?? []).map((h) => hookStep('before-each', h)), ...(journey.code ? [] : journey.steps)];
    for (const step of steps) {
      currentStepId = step.id;
      if (!blocked && opts.signal?.aborted) blocked = CANCELLED;
      if (blocked) {
        result.steps.push(skippedStep(step, blocked));
        continue;
      }
      const sr = await executeStep(step, scope, flow);
      result.steps.push(sr);
      // Soft assertions record a failure but let the journey go on (it still fails at the end).
      if ((sr.status === 'failed' || sr.status === 'blocked') && !step.optional && !step.soft && !sr.soft) blocked = `not run: step "${step.id}" ${sr.status}`;
      // The tester ended a hybrid run at a manual step: the rest is not executed.
      if (sr.error?.name === 'ManualEnded') blocked = 'not run: the tester ended the manual run';
    }
    let codeStatus: Awaited<ReturnType<typeof runCodeJourney>> | undefined;
    if (journey.code && !blocked && !opts.signal?.aborted) {
      codeStatus = await runCodeJourney(journey, scope, flow);
      result.steps.push(...codeStatus.steps);
    }
    const hooksAfter = result.steps.length;
    if (!opts.signal?.aborted) for (const h of opts.hooks?.afterEach ?? []) result.steps.push(await executeStep(hookStep('after-each', h), scope, flow));
    result.status = journeyStatusFrom(result.steps);
    const manual = manualSummary(journey, result.steps);
    if (manual) result.manual = manual;
    // A code journey's status comes from its code (caught failures are handled, soft ones fail); hooks can still fail it.
    if (codeStatus) {
      const hooks = [...result.steps.slice(0, hooksAfter - codeStatus.steps.length), ...result.steps.slice(hooksAfter)];
      result.status = hooks.some((s) => s.status === 'failed' || s.status === 'blocked') ? 'failed' : codeStatus.status;
    }
    if (codeStatus?.error && !result.error) result.error = codeStatus.error;
    if (codeStatus && opts.signal?.aborted) Object.assign(result, cancelledFields());
    if (blocked === CANCELLED) Object.assign(result, cancelledFields());
  } catch (e) {
    const err = e as Error;
    result.status = 'error';
    result.error = { message: err.message, name: err.name };
    if (err instanceof DataPreconditionError) {
      result.error.name = DATA_PRECONDITION;
      if (err.results.length) (result.reliability ??= {}).preconditions = [...(result.reliability?.preconditions ?? []).filter((r) => r.passed), ...err.results];
      result.steps = journey.steps.map((s) => skippedStep(s, 'not run: data problem (see the journey error)'));
    }
    env.logger.error('journey error', { journeyId: jid, message: err.message });
  } finally {
    await logs.settle();
    await jx?.finish(result);
    // Finished requests (with step ids) plus the session's live records: a response the page never read
    // (an unconsumed fetch body) has a status in the session but no requestfinished event.
    const attemptLog = (): NetLogEntry[] => [
      ...logs.network,
      ...session.requests.filter((r) => r.status !== undefined || r.failure).map((r) => ({ method: r.method, url: r.url, status: r.status, resourceType: r.resourceType, failure: r.failure })),
    ];
    try {
      const passed = result.status === 'passed' || result.status === 'passed-healed' || result.status === 'skipped';
      // --fast keeps console/network logs only for attempts that did not pass.
      if (!passed || opts.passingLogs !== false) {
        result.evidence.push((await evidence.store('console', `${prefix}/console.json`, JSON.stringify(logs.consoleLog, null, 2), meta(undefined, 'browser console'))).id);
        const netRef = await evidence.store('network', `${prefix}/network.json`, JSON.stringify(logs.network, null, 2), meta(undefined, 'network log'));
        result.evidence.push(netRef.id);
        if (!passed && result.error?.name !== DATA_PRECONDITION) {
          // 5xx on the page, DNS, refused connections, navigation timeouts: the environment, not the product.
          const reason = classifyEnvironmentFailure(result, attemptLog());
          if (reason) (result.reliability ??= {}).environment = { reason, evidence: [netRef.id] };
        }
      }
      attemptNetwork.set(result, attemptLog());
      if (traceMode === 'on' || (traceMode !== 'off' && !passed)) {
        await context.tracing.stop({ path: join(env.runDir, traceRel) });
        result.evidence.push((await evidence.recordFile('trace', join(env.runDir, traceRel), meta(undefined, multi ? `browser trace (${primaryName})` : 'browser trace'))).id);
      } else if (traceMode !== 'off') {
        await context.tracing.stop(); // passed: the on-failure trace is discarded
      }
      result.evidence.push(...(await storeSessionEvidence(session, evidence, prefix, meta(undefined))));
      // The other actors: a trace and session evidence each, labelled with the actor.
      for (const slot of slots.values()) {
        if (slot === primarySlot || !slot.context || !slot.session) continue;
        const rel = `traces/${safeName(jid)}-attempt${attempt}-${safeName(slot.name)}.zip`;
        try {
          if (traceMode === 'on' || (traceMode !== 'off' && !passed)) {
            await slot.context.tracing.stop({ path: join(env.runDir, rel) });
            result.evidence.push((await evidence.recordFile('trace', join(env.runDir, rel), meta(undefined, `browser trace (${slot.name})`))).id);
          } else if (traceMode !== 'off') {
            await slot.context.tracing.stop();
          }
          result.evidence.push(...(await storeSessionEvidence(slot.session, evidence, `${prefix}/actor-${safeName(slot.name)}`, meta(undefined))));
        } catch (e) {
          env.logger.warn('could not keep actor evidence', { journeyId: jid, actor: slot.name, message: (e as Error).message });
        }
      }
    } finally {
      for (const slot of slots.values()) {
        if (slot === primarySlot || !slot.context) continue;
        await slot.session?.close().catch(() => undefined);
        await slot.context.close().catch(() => undefined);
      }
      await session.close().catch(() => undefined);
      if (pooled) await env.contextPool!.release(context);
      else await context.close().catch(() => undefined);
      await (async () => opts.lifecycle?.journeyEnd?.(journey, result))().catch((e: Error) => env.logger.warn('journey end hook failed', { journeyId: jid, message: e.message }));
    }
    // Videos are complete once the context is closed. retain-on-failure keeps them only for attempts that did not pass.
    if (videoMode !== 'off') {
      const passed = result.status === 'passed' || result.status === 'passed-healed' || result.status === 'skipped';
      try {
        if (videoMode === 'retain-on-failure' && passed) {
          await rm(videoDir, { recursive: true, force: true });
          await rmdir(join(env.runDir, 'videos')).catch(() => undefined); // only when no other video is kept
        }
        else {
          const files = (await readdir(videoDir).catch(() => [] as string[])).sort();
          for (const f of files.filter((x) => x.endsWith('.webm'))) {
            result.evidence.push((await evidence.recordFile('video', join(videoDir, f), meta(undefined, multi ? `video of the journey attempt (${primaryName})` : 'video of the journey attempt'))).id);
          }
          for (const slot of slots.values()) {
            if (slot === primarySlot || !slot.context) continue;
            const dir = actorVideoDir(slot.name);
            for (const f of (await readdir(dir).catch(() => [] as string[])).filter((x) => x.endsWith('.webm')).sort()) {
              result.evidence.push((await evidence.recordFile('video', join(dir, f), meta(undefined, `video of the journey attempt (${slot.name})`))).id);
            }
          }
          // Burned-in action overlays are in the frames; the per-step chapters travel as a WebVTT track beside the video.
          for (const f of files.filter((x) => x.endsWith('.chapters.vtt'))) {
            result.evidence.push((await evidence.recordFile('video-chapters', join(videoDir, f), meta(undefined, 'per-step video chapters (WebVTT)'))).id);
          }
        }
      } catch (e) {
        env.logger.warn('could not keep the journey video', { journeyId: jid, message: (e as Error).message });
      }
    }
  }
  result.ledger = ledger.toJSON();
  result.durationMs = Date.now() - started;
  return result;
}

/** Logs a step can look back at for its failure diagnosis. */
interface StepAux {
  console: ConsoleEntry[];
  network: NetEntry[];
}

/** May this journey run in a shared (reset) browser context? */
function ContextPoolEligible(journey: Journey, opts: RunOptions): boolean {
  // A clock leaves init scripts on its context: such journeys get a context of their own.
  return !!opts.reuseContext && !journey.emulation && !journey.clock && !usesClock(journey.steps) && (opts.video ?? 'off') === 'off' && !opts.trace && (opts.traceMode ?? 'off') === 'off' && !opts.timeTravel && !opts.debug;
}

async function runStep(
  step: Step,
  ctx: StepContext,
  env: JourneyRunEnv,
  prefix: string,
  meta: (stepId?: string, description?: string) => { journeyId: string; stepId?: string; description?: string },
  aux?: StepAux,
): Promise<StepResult> {
  const { opts, evidence } = env;
  const t0 = Date.now();
  const startedAt = nowIso();
  opts.events?.emit({ type: 'step:start', journeyId: ctx.journey.id, stepId: step.id, intent: step.intent, ...(ctx.actor ? { actor: ctx.actor } : {}) });
  // Burned-in video: a chapter mark and a caption for this step (the box is drawn once the target resolves).
  await overlayStepStart(ctx.page, step);
  // Multi-actor journeys: each actor's screenshots and failure snapshots go to its own folder and say whose they are.
  const at = ctx.actor ? `${prefix}/actor-${safeName(ctx.actor)}` : prefix;
  const whose = (d: string) => (ctx.actor ? `${d} (${ctx.actor})` : d);
  let sr: StepResult;
  try {
    const core = await executeStepCore(step, ctx, env);
    sr = { stepId: step.id, intent: step.intent, startedAt, durationMs: 0, ...core };
  } catch (e) {
    const err = e as Error;
    sr = {
      stepId: step.id, intent: step.intent, status: 'failed', startedAt, durationMs: 0, conditions: [], evidence: [],
      error: { message: err.message.split('\n')[0], name: err.name },
    };
  }

  // Lenses run after the step's own checks.
  for (const lens of opts.lenses ?? []) {
    if (!lens.afterStep || sr.status === 'failed') continue;
    let findings: LensFinding[];
    try {
      findings = (await lens.afterStep(ctx.page, step, ctx)).map((f) => ({ ...f, lens: f.lens ?? lens.name }));
    } catch (e) {
      findings = [{ lens: lens.name, severity: 'error', message: `lens failed: ${(e as Error).message}` }];
    }
    if (!findings.length) continue;
    const ref = await evidence.store('data', `${prefix}/lens-${safeName(lens.name)}-${safeName(step.id)}.json`, JSON.stringify(findings, null, 2), meta(step.id, `lens ${lens.name} findings`));
    sr.evidence.push(ref.id);
    const errors = findings.filter((f) => f.severity === 'error');
    if (errors.length) {
      sr.status = 'failed';
      sr.error = { message: `lens ${lens.name}: ${errors.map((f) => f.message).join('; ')}` };
    }
  }

  const rel = takeReliability(ctx);
  if (rel) sr.reliability = rel;
  // Failure diagnosis: expected vs found, candidate counts, "did you mean", console and network errors.
  if (sr.status === 'failed' && opts.diagnose !== false && aux && !step.optional) {
    const d = await diagnoseFailure({
      step, ctx, error: sr.error?.message ?? '', conditions: sr.conditions, console: aux.console, network: aux.network, since: t0,
      fingerprint: env.store.get(ctx.journey.id, step.id)?.fingerprint,
    });
    if (d) {
      sr.diagnosis = d;
      const hint = diagnosisHint(d);
      // Hints go on the runner's own generic failures; adapter/custom-step errors are already specific (the diagnosis is still attached).
      const generic = /^(?:no locator candidate matched|post-condition failed|suspected regression|[\w.]+: Timeout \d+ms exceeded|[\w.]+: timed out after \d+ ms|Timed out after)/.test(sr.error?.message ?? '');
      if (hint && generic && sr.error && !sr.error.message.includes('did you mean')) sr.error.message = `${sr.error.message}; ${hint}`;
    }
  }

  const failed = sr.status === 'failed';
  const shots = opts.screenshots ?? 'on-failure';
  // Hide the video overlay so it never appears in an evidence screenshot.
  if (!sr.surface) await overlayHide(ctx.page);
  // A desktop/terminal/screen surface stores its own screenshots and snapshots; the idle browser page has nothing to show.
  if (!sr.surface) try {
    if (shots === 'every-step' || ((shots === 'on-failure' || shots === 'before-assertions') && failed) || sr.heal) {
      const png = await ctx.page.screenshot({ fullPage: true, timeout: 5000 });
      const ref = await evidence.store('screenshot', `${at}/${safeName(step.id)}.png`, png, meta(step.id, whose(`screenshot after ${step.action}`)));
      sr.evidence.push(ref.id);
      if (sr.heal) sr.heal.evidence.push(ref.id);
      // The failure screenshot shows the diagnosis outlines (target matches or the nearest element).
      if (failed && sr.diagnosis) sr.diagnosis.screenshot = ref.id;
    }
    if (sr.diagnosis?.outlined) await removeOutlines(ctx.page);
    if (failed) {
      const aria = await ctx.page.locator('body').ariaSnapshot({ timeout: 5000 });
      sr.evidence.push((await evidence.store('aria', `${at}/${safeName(step.id)}.aria.yml`, aria, meta(step.id, whose('aria snapshot at failure')))).id);
      const html = await ctx.page.content();
      sr.evidence.push((await evidence.store('dom', `${at}/${safeName(step.id)}.html`, html, meta(step.id, whose('page HTML at failure')))).id);
    }
  } catch (e) {
    env.logger.warn('could not capture step evidence', { stepId: step.id, message: (e as Error).message });
  }
  sr.durationMs = Date.now() - t0;
  opts.events?.emit({ type: 'step:end', journeyId: ctx.journey.id, stepId: step.id, status: sr.status, durationMs: sr.durationMs });
  if (step.optional && sr.status === 'failed') {
    sr.status = 'skipped';
    sr.error = { message: `optional step failed: ${sr.error?.message ?? 'unknown'}` };
  }
  return sr;
}
