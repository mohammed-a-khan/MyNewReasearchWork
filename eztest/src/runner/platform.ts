/**
 * The driver abstraction: where a journey runs.
 *
 * Web journeys run in browser contexts of EZTest's own driver (the built-in path in
 * run.ts / journey.ts). Any other platform (`Platform: android`, `ios`, and
 * later desktop targets) is executed by a registered PlatformDriver, which
 * runs one journey attempt end to end and returns its JourneyResult. The run
 * loop, retries, concurrency, hooks, cancellation, fingerprint store, Evidence
 * Vault and run.json stay shared, so every platform gets the same guarantees.
 *
 * Contract for a driver (see docs/mobile.md, "Writing a platform driver"):
 *  - `runAttempt` never throws: infrastructure errors become an "error" journey.
 *  - Steps are verified the same way as on the web: strict (exactly-one) target
 *    resolution, post-conditions polled, healing accepted only when the
 *    post-conditions (or action-implied checks) hold, `passed-healed` status
 *    with a HealRecord, and `env.store.recordSuccess/recordHeal` so heal
 *    proposals and the T0 cache work.
 *  - Evidence goes through `env.evidence` (hash-chained) under
 *    `journeys/<journeyId>/attempt-<n>/`; events go to `env.opts.events`.
 *  - `env.opts.signal` is honoured between steps.
 */
import type { Journey, JourneyResult, Logger } from '../core/index.js';
import type { FingerprintStore } from '../heal/store.js';
import type { EvidenceWriter } from './evidence.js';
import type { RunOptions } from './types.js';
import { isManualJourney, manualDriver } from './manual.js';
import { bddRecord } from './bdd-run.js';

/** A platform name: 'web' (built in), 'android', 'ios', or one a driver adds. */
export type PlatformName = 'web' | 'android' | 'ios' | (string & {});

/** What the run loop hands a platform driver for each journey attempt. */
export interface PlatformRunEnv {
  runId: string;
  runDir: string;
  evidence: EvidenceWriter;
  logger: Logger;
  opts: RunOptions;
  /** Shared fingerprint store (T0 cache, last good locators, fingerprints). */
  store: FingerprintStore;
  stepTimeoutMs: number;
  locateTimeoutMs: number;
  conditionTimeoutMs: number;
  /** All journeys of the run (callable with "Run journey"). */
  journeys?: Journey[];
}

export interface PlatformDriver {
  /** Driver name, e.g. "eztest-mobile". */
  readonly name: string;
  /** Platforms this driver runs, e.g. ['android', 'ios']. */
  readonly platforms: readonly string[];
  /** Run one attempt of a journey. Must not throw. */
  runAttempt(journey: Journey, attempt: number, env: PlatformRunEnv): Promise<JourneyResult>;
  /** Entries merged into run.json `environment` (server URL, cloud provider, ...). No secrets. */
  environment?(): Record<string, string>;
  /** Called once when the run ends (release device pools, connections). */
  close?(): Promise<void>;
}

const REGISTRY: PlatformDriver[] = [];

/**
 * Register a driver for every run in this process (RunOptions.platformDrivers
 * wins over the registry). Returns a function that removes it again.
 */
export function registerPlatformDriver(driver: PlatformDriver): () => void {
  REGISTRY.push(driver);
  return () => {
    const i = REGISTRY.indexOf(driver);
    if (i >= 0) REGISTRY.splice(i, 1);
  };
}

/** The platform a journey runs on: its `Platform:` header, else the run default, else web. */
export function platformOf(journey: Journey, opts: Pick<RunOptions, 'platform'>): PlatformName {
  // Manual test cases (only "Manual:" steps) need no browser: the built-in manual driver asks the tester.
  if (isManualJourney(journey)) return 'manual';
  return journey.platform ?? opts.platform ?? 'web';
}

/** The driver for a platform (run options first, then the registry); undefined for web or when none is registered. */
export function driverFor(platform: PlatformName, opts: Pick<RunOptions, 'platformDrivers'>): PlatformDriver | undefined {
  if (platform === 'web') return undefined;
  return [...(opts.platformDrivers ?? []), ...REGISTRY, manualDriver].find((d) => d.platforms.includes(platform));
}

/** The error result for a journey whose platform has no driver configured. */
export function noDriverJourney(journey: Journey, platform: string, attempt: number): JourneyResult {
  const message = `No driver for platform "${platform}": configure "mobile:" in eztest.config.yaml or pass RunOptions.platformDrivers`;
  return {
    journeyId: journey.id, name: journey.name, status: 'error', startedAt: new Date().toISOString(), durationMs: 0,
    steps: journey.steps.map((s) => ({ stepId: s.id, intent: s.intent, status: 'skipped', startedAt: new Date().toISOString(), durationMs: 0, conditions: [], evidence: [], error: { message: 'not run: no platform driver' } })),
    tags: journey.tags, requirements: journey.requirements, risk: journey.risk, attempt, browser: platform, ledger: {}, evidence: [],
    error: { message, name: 'NoPlatformDriver' },
    ...(journey.bdd ? { bdd: bddRecord(journey) } : {}),
  };
}
