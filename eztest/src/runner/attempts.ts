/**
 * Journey attempts on this process's own browsers and platform drivers: the browsers of the run
 * (launched or attached up front), their context pools, relaunch after a browser crash, recycling,
 * and one attempt of a journey on its platform. `runJourneys` uses it directly for inline runs;
 * every process worker of a `workers: process` run (src/runner/workers) has one of its own.
 */
import type { Browser } from '../browser/index.js';
import { nowIso, type Journey, type JourneyResult, type Logger } from '../core/index.js';
import type { FingerprintStore } from '../heal/store.js';
import type { EvidenceWriter } from './evidence.js';
import type { RunExtensions } from './extensions.js';
import { hookJourneys } from './journey-hooks.js';
import { runJourneyAttempt, type JourneyRunEnv } from './journey.js';
import { driverFor, noDriverJourney, platformOf, type PlatformDriver } from './platform.js';
import { ContextPool } from './reliability/context-pool.js';
import { classifyEnvironmentFailure } from './reliability/health.js';
import { installAppIdle } from './reliability/idle.js';
import { skippedStep } from './step.js';
import { bddRecord } from './bdd-run.js';
import { openBrowser, type ResolvedBrowser } from './browsers.js';
import type { RunOptions } from './types.js';

/** Runs single journey attempts; the run's scheduler (run.ts) decides what runs when. */
export interface AttemptRunner {
  /**
   * One attempt. `seed` holds values handed over by `Depends on:` prerequisites and setup journeys.
   * `teardown`: run without the cancel signal (teardown hooks of a cancelled run, teardownOnCancel).
   */
  run(j: Journey, attempt: number, seed?: Record<string, unknown>, o?: { teardown?: boolean }): Promise<JourneyResult>;
  /** The browsers asked for, with their versions (undefined: did not start). */
  versions(): Map<string, string | undefined>;
  /** Platform-driver details for run.json. */
  driverEnvironment(): Record<string, string>;
  /** "N created, M reused" when contexts are reused. */
  contextReuse(): string | undefined;
  /** Stop: close contexts, drivers and browsers. */
  close(): Promise<void>;
}

/** Stand-in when every journey runs on a platform driver: using it is a bug, so it fails loudly. */
export function noBrowser(): Browser {
  return new Proxy({} as Browser, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      throw new Error(`No browser was launched for this run (all journeys target native platforms); tried to use browser.${String(prop)}`);
    },
  });
}

export interface LocalRunnerInit {
  runId: string;
  runDir: string;
  evidence: EvidenceWriter;
  logger: Logger;
  store: FingerprintStore;
  extensions?: RunExtensions;
  stepTimeoutMs: number;
  targets: ResolvedBrowser[];
  /** Every journey of the run (callable with "Run journey"). */
  journeys: Journey[];
  /** Browser launch extras (process workers do not let the browsers react to terminal signals themselves). */
  launch?: { handleSignals?: boolean };
}

/** The result of a unit whose browser died under it (the run launches it again for the next ones). */
export function browserCrashed(j: Journey, attempt: number, browser: string, e: Error): JourneyResult {
  const message = `browser ${browser} crashed: ${e.message.split('\n')[0]}`;
  return {
    journeyId: j.id, name: j.name, startedAt: nowIso(), durationMs: 0, steps: j.steps.map((s) => skippedStep(s, `not run: ${message}`)),
    tags: j.tags, requirements: j.requirements, risk: j.risk, attempt, browser, ledger: {}, evidence: [],
    status: 'error', error: { message, name: 'BrowserCrashed' },
    reliability: { environment: { reason: message, evidence: [] } },
  };
}

/** The result of a unit whose browser could not be launched or attached to. */
export function browserDown(j: Journey, attempt: number, browser: string, e: Error): JourneyResult {
  const message = `browser ${browser} did not start: ${e.message.split('\n')[0]}`;
  return {
    journeyId: j.id, name: j.name, startedAt: nowIso(), durationMs: 0, steps: j.steps.map((s) => skippedStep(s, `not run: ${message}`)),
    tags: j.tags, requirements: j.requirements, risk: j.risk, attempt, browser, ledger: {}, evidence: [],
    status: 'error', error: { message, name: 'BrowserLaunchError' }, ...(j.bdd ? { bdd: bddRecord(j) } : {}),
  };
}

/** The browsers a run needs, by target: the first one for journeys without a browser, the others for their units. */
export function wantedBrowsers(journeys: Journey[], options: RunOptions, targets: ResolvedBrowser[]): ResolvedBrowser[] {
  const web = [...journeys, ...hookJourneys(options)].filter((j) => platformOf(j, options) === 'web');
  return targets.filter((t, i) => i === 0 ? web.some((j) => !j.browser || j.browser === t.id) : web.some((j) => j.browser === t.id));
}

/** Attempts on this process's browsers and drivers. */
export class LocalAttemptRunner implements AttemptRunner {
  readonly env: JourneyRunEnv;
  readonly wanted: ResolvedBrowser[];
  private readonly browsers = new Map<string, Browser>();
  private readonly launchErrors = new Map<string, Error>();
  private readonly envs = new Map<string, JourneyRunEnv>();
  private readonly usedDrivers = new Set<PlatformDriver>();
  private readonly replacing = new Map<string, Promise<Error | undefined>>();
  private readonly startedOn = new Map<Browser, number>();
  private readonly inflight = new Map<Browser, number>();
  private readonly retired = new Set<Browser>();
  private readonly primary: ResolvedBrowser;

  private constructor(private readonly options: RunOptions, private readonly init: LocalRunnerInit, wanted: ResolvedBrowser[]) {
    this.wanted = wanted;
    this.primary = init.targets[0];
    this.env = undefined as unknown as JourneyRunEnv;
  }

  /**
   * Launch (or attach to) every browser the plan uses. A single-browser run whose browser does not start
   * throws; in a cross-browser run a browser that cannot start turns only its own units into errors.
   */
  static async open(options: RunOptions, init: LocalRunnerInit): Promise<LocalAttemptRunner> {
    const wanted = wantedBrowsers(init.journeys, options, init.targets);
    const r = new LocalAttemptRunner(options, init, wanted);
    await r.start();
    return r;
  }

  get needsBrowser(): boolean {
    return this.wanted.length > 0;
  }

  private launchOpts(): { headless?: boolean; handleSignals?: boolean } {
    return { headless: this.options.headless, ...(this.init.launch?.handleSignals === false ? { handleSignals: false } : {}) };
  }

  private async start(): Promise<void> {
    const { options, init } = this;
    const multiBrowser = init.targets.length > 1;
    if (this.needsBrowser) {
      await Promise.all(this.wanted.map(async (t) => {
        try {
          this.browsers.set(t.id, await openBrowser(t, this.launchOpts()));
        } catch (e) {
          this.launchErrors.set(t.id, e as Error);
        }
      }));
      if (!multiBrowser || this.launchErrors.size === this.wanted.length) {
        const first = this.launchErrors.values().next().value;
        if (first) {
          for (const b of this.browsers.values()) await b.close().catch(() => undefined);
          throw first;
        }
      }
      for (const [id, e] of this.launchErrors) init.logger.error('browser did not start', { browser: id, message: e.message });
    }
    const browser = this.browsers.get(this.primary.id) ?? (this.needsBrowser && this.browsers.size ? [...this.browsers.values()][0] : noBrowser());
    const contextPool = this.needsBrowser && this.browsers.has(this.primary.id) ? this.poolFor(browser) : undefined;
    const stepTimeoutMs = init.stepTimeoutMs;
    const env: JourneyRunEnv = {
      extensions: init.extensions, contextPool,
      runId: init.runId, runDir: init.runDir, browser, browserName: this.primary.id, evidence: init.evidence, logger: init.logger, opts: options, store: init.store, stepTimeoutMs,
      locateTimeoutMs: options.locateTimeoutMs ?? Math.min(stepTimeoutMs, 5000),
      conditionTimeoutMs: options.conditionTimeoutMs ?? 5000,
      journeys: init.journeys,
      platformDriverUsed: (d) => this.usedDrivers.add(d),
    };
    (this as { env: JourneyRunEnv }).env = env;
    // One run environment per browser of a cross-browser run (its own browser and context pool).
    this.envs.set(this.primary.id, env);
    for (const t of init.targets.slice(1)) {
      const b = this.browsers.get(t.id);
      if (b) this.envs.set(t.id, { ...env, browser: b, browserName: t.id, contextPool: this.poolFor(b) });
    }
  }

  private poolFor(b: Browser): ContextPool | undefined {
    const options = this.options;
    return options.reuseContext && this.needsBrowser
      ? new ContextPool(b, {
        acceptDownloads: true, ...(options.viewport ? { viewport: options.viewport } : {}),
        ...(options.timezone ? { timezoneId: options.timezone } : {}), ...(options.locale ? { locale: options.locale } : {}),
        ...(options.clientCertificates?.some((c) => c.browser !== false) ? { clientCertificates: options.clientCertificates.filter((c, i, all) => c.browser !== false && all.findIndex((x) => x.browser !== false && x.origin === c.origin) === i).map((c) => ({ origin: c.origin, ...(c.pfx ? { pfx: c.pfx } : {}), ...(c.cert ? { cert: c.cert } : {}), ...(c.key ? { key: c.key } : {}), ...(c.passphrase !== undefined ? { passphrase: c.passphrase } : {}) })) } : {}),
      }, options.reliability?.appIdle ? (c) => installAppIdle(c, options.reliability!.appIdle === true ? {} : options.reliability!.appIdle as object) : undefined)
      : undefined;
  }

  /** The run environment of a journey (its browser's, in a cross-browser run). */
  envOf(j: Journey): JourneyRunEnv {
    return this.envs.get(j.browser ?? this.primary.id) ?? { ...this.env, browserName: j.browser ?? this.env.browserName };
  }

  private recycleAfter(t: ResolvedBrowser): number {
    return t.connect ? 0 : this.options.recycleBrowserAfter ?? (t.engine === 'firefox' ? 15 : 0);
  }

  private closeIfDrained(b: Browser): void {
    if (this.retired.has(b) && !(this.inflight.get(b) ?? 0)) {
      this.retired.delete(b);
      void b.close().catch(() => undefined);
    }
  }

  /**
   * The browser a web journey starts on. Two cases replace it mid-run:
   * - it died (crash, out-of-memory kill): it is launched again for the journeys still to run, and the
   *   journeys it took down are environment failures, not product failures; the run goes on instead
   *   of aborting without results;
   * - it ran `recycleBrowserAfter` journeys (default 15 on Firefox, whose parent process keeps ~30 MB
   *   per closed window and was killed out of memory after ~45 journeys): new journeys start on a
   *   fresh browser and the old one closes when its last journey ends.
   */
  private replaceBrowser(id: string, why: 'crashed' | 'recycle'): Promise<Error | undefined> {
    let p = this.replacing.get(id);
    if (!p) {
      p = (async () => {
        const t = this.init.targets.find((x) => x.id === id);
        if (!t) return new Error(`browser ${id} disconnected`);
        const old = this.browsers.get(id);
        if (why === 'crashed') this.init.logger.error('browser disconnected mid-run, launching it again', { browser: id });
        else this.init.logger.info('recycling the browser', { browser: id, journeys: old ? this.startedOn.get(old) : 0 });
        try {
          const nb = await openBrowser(t, this.launchOpts());
          this.browsers.set(id, nb);
          const e = this.envs.get(id) as { browser: Browser; contextPool?: ContextPool } | undefined;
          if (e) {
            e.browser = nb;
            e.contextPool = this.poolFor(nb);
          }
          if (old && why === 'recycle') {
            this.retired.add(old);
            this.closeIfDrained(old);
          }
          return undefined;
        } catch (err) {
          return err as Error;
        } finally {
          this.replacing.delete(id);
        }
      })();
      this.replacing.set(id, p);
    }
    return p;
  }

  /** The browser for the next journey on `id` (relaunched or recycled first when needed). */
  private async browserFor(id: string): Promise<Browser | Error | undefined> {
    await this.replacing.get(id);
    const b = this.browsers.get(id);
    if (!b) return undefined;
    const t = this.init.targets.find((x) => x.id === id);
    if (!b.isConnected()) return (await this.replaceBrowser(id, 'crashed')) ?? this.browsers.get(id);
    const limit = t ? this.recycleAfter(t) : 0;
    if (limit > 0 && (this.startedOn.get(b) ?? 0) >= limit) return (await this.replaceBrowser(id, 'recycle')) ?? this.browsers.get(id);
    return b;
  }

  /**
   * One attempt on the journey's platform: web journeys run in browser contexts; others go to their
   * platform driver. `seed` reaches web journeys through the ledger and platform drivers (which have
   * no ledger hook) as journey variables (strings, JSON for objects).
   */
  async run(j: Journey, attempt: number, seed?: Record<string, unknown>, o: { teardown?: boolean } = {}): Promise<JourneyResult> {
    const options = this.options;
    const platform = platformOf(j, options);
    const strip = (e: JourneyRunEnv): JourneyRunEnv => (o.teardown ? { ...e, opts: { ...e.opts, signal: undefined } } : e);
    if (platform === 'web') {
      const id = j.browser ?? this.primary.id;
      const failedLaunch = this.launchErrors.get(id);
      if (failedLaunch) return browserDown(j, attempt, id, failedLaunch);
      const b = await this.browserFor(id);
      if (b instanceof Error) return browserDown(j, attempt, id, b);
      const base = this.envOf(j);
      // The journey stays on the browser it started on, even when the run moves on to a new one.
      const attemptEnv = strip(b && base.browser !== b ? { ...base, browser: b } : base);
      if (b) {
        this.startedOn.set(b, (this.startedOn.get(b) ?? 0) + 1);
        this.inflight.set(b, (this.inflight.get(b) ?? 0) + 1);
      }
      let r: JourneyResult;
      try {
        r = await runJourneyAttempt(j, attempt, attemptEnv, seed);
      } catch (e) {
        if (!b || b.isConnected()) throw e;
        r = browserCrashed(j, attempt, id, e as Error);
      } finally {
        if (b) {
          this.inflight.set(b, (this.inflight.get(b) ?? 1) - 1);
          this.closeIfDrained(b);
        }
      }
      if ((r.status === 'failed' || r.status === 'error') && b && !b.isConnected() && !r.reliability?.environment) {
        (r.reliability ??= {}).environment = { reason: `browser ${id} crashed during the journey`, evidence: [...r.evidence] };
      }
      return r;
    }
    const driver = driverFor(platform, options);
    if (!driver) return noDriverJourney(j, platform, attempt);
    this.usedDrivers.add(driver);
    const vars = seed ? Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : undefined;
    const r = await driver.runAttempt(vars ? { ...j, variables: { ...j.variables, ...vars } } : j, attempt, strip(this.env));
    // Environment classification from the error text (drivers keep no browser network log), for the circuit breaker and triage.
    if ((r.status === 'failed' || r.status === 'error') && !r.reliability?.environment) {
      const reason = classifyEnvironmentFailure(r);
      if (reason) (r.reliability ??= {}).environment = { reason, evidence: [...r.evidence] };
    }
    return r;
  }

  versions(): Map<string, string | undefined> {
    return new Map(this.wanted.map((t) => [t.id, this.browsers.get(t.id)?.version()]));
  }

  driverEnvironment(): Record<string, string> {
    return Object.assign({}, ...[...this.usedDrivers].map((d) => d.environment?.() ?? {})) as Record<string, string>;
  }

  contextReuse(): string | undefined {
    const p = this.env.contextPool;
    return p ? `${p.created} created, ${p.reused} reused` : undefined;
  }

  /** Context pool counters (process workers report them to the run). */
  contextCounts(): { created: number; reused: number } | undefined {
    const p = this.env.contextPool;
    return p ? { created: p.created, reused: p.reused } : undefined;
  }

  async close(): Promise<void> {
    for (const e of this.envs.values()) await e.contextPool?.closeAll();
    for (const d of this.usedDrivers) await d.close?.().catch((e: unknown) => this.init.logger.warn('platform driver close failed', { driver: d.name, message: (e as Error).message }));
    // Launched browsers are closed; attached (remote) ones only lose the contexts this run created.
    for (const b of [...this.browsers.values(), ...this.retired]) await b.close().catch(() => undefined);
  }
}
