/**
 * EZTest public API. One package, everything included:
 *
 *   import { runEzTest, parseEzScript, docs, insights } from 'eztest';
 *
 * Commonly used functions are exported at the top level; every module is
 * also available as a namespace (and as a subpath, e.g. 'eztest/docs').
 */
import { loadConfig, type LoadConfigOptions } from './config/index.js';
import { createEngine, analyzeRun, type AnalyzeResult } from './engine/index.js';
import type { Journey, RunResult } from './core/index.js';

// ---- the essentials, flat
export {
  parseJourney,
  safeParseJourney,
  EvidenceVault,
  verifyEvidence,
  EventBus,
  NotSupportedError,
  EzTestError,
  type Journey,
  type JourneyInput,
  type Step,
  type Condition,
  type Target,
  type RunResult,
  type JourneyResult,
  type StepResult,
  type StepStatus,
} from './core/index.js';
export { loadConfig, encryptValue, decryptValue, SecretMasker, type EzTestConfig, type LoadedConfig } from './config/index.js';
export { parseIntent, parseEzScript, journeyToEzScript, loadJourneyFile, describeTarget } from './intent/index.js';
export { runJourneys, type RunOptions } from './runner/index.js';
export { evaluateExpression, parseExpression } from './core/index.js';
export { SmtpSink, TwilioSmsProvider, MemorySmsProvider } from './messaging/index.js';
export { createHealer, type HealPolicy } from './heal/index.js';
export { createEngine, runWithConfig, analyzeRun, lensesFromConfig, documentCheckHandler, enableAddons } from './engine/index.js';
export { IdentityVault, generateTotp, verifyTotp, addVirtualAuthenticator } from './identity/index.js';
export { writeReports } from './report/index.js';
export { startRecording, recordJourney, verifyRecording } from './recorder/index.js';
export { startStudio } from './studio/index.js';
export { loadJourneys, filterJourneys, buildProgram } from './cli/index.js';

// ---- every module as a namespace
export * as core from './core/index.js';
export * as config from './config/index.js';
export * as intent from './intent/index.js';
export * as runner from './runner/index.js';
export * as heal from './heal/index.js';
export * as elements from './elements/index.js';
export * as identity from './identity/index.js';
export * as data from './data/index.js';
export * as messaging from './messaging/index.js';
export * as docs from './docs/index.js';
export * as surfaces from './surfaces/index.js';
export * as insights from './insights/index.js';
export * as analytics from './analytics/index.js';
export * as manual from './manual/index.js';
export * as report from './report/index.js';
export * as perf from './perf/index.js';
export * as load from './load/index.js';
export * as lenses from './lenses/index.js';
export * as a11y from './a11y/index.js';
export * as mobile from './mobile/index.js';
export * as ado from './alm-ado/index.js';
export * as git from './git/index.js';
export * as vcs from './vcs/index.js';
export * as engine from './engine/index.js';
export * as monitor from './monitor/index.js';
export * as evidencePack from './evidence-pack/index.js';
export * as mocks from './mocks/index.js';
export * as recorder from './recorder/index.js';
export * as d365 from './d365/index.js';
export * as salesforce from './salesforce/index.js';
export * as apps from './apps/index.js';
export * as importers from './importers/index.js';
export * as queries from './queries/index.js';
export * as studio from './studio/index.js';
export * as bdd from './bdd/index.js';
export * as lint from './lint/index.js';
export * as components from './runner/components/index.js';
export * as desktop from './desktop/index.js';
export * as legacy from './legacy/index.js';
export * as stories from './stories/index.js';
export * as sessions from './sessions/index.js';
export * as scale from './scale/index.js';
export * as server from './server/index.js';
export * as plugins from './plugins/index.js';
export * as ops from './ops/index.js';
export * as sdk from './sdk/index.js';

export interface RunEzTestOptions extends LoadConfigOptions {
  /** Journeys to run; when omitted they are loaded from config.journeysDir. */
  journeys?: Journey[];
  /** Run history/flaky/triage/readiness and write reports (default true). */
  analyze?: boolean;
}

/** One-call programmatic run: load config, run, analyze, report. */
export async function runEzTest(opts: RunEzTestOptions = {}): Promise<{ run: RunResult; analysis?: AnalyzeResult; runDir: string }> {
  const cwd = opts.cwd ?? process.cwd();
  const loaded = await loadConfig(opts);
  const { enableAddons } = await import('./engine/index.js');
  const addons = await enableAddons(loaded, { cwd });
  const { loadJourneys } = await import('./cli/journeys.js');
  const journeys = opts.journeys ?? (await loadJourneys([loaded.config.journeysDir], cwd)).journeys;
  const engine = await createEngine(loaded, { cwd, addons });
  let run: RunResult;
  try {
    run = await engine.run(journeys);
  } finally {
    await engine.close();
    addons.off();
  }
  const { join, resolve } = await import('node:path');
  const runDir = join(engine.runOptions.outputDir, run.runId);
  if (opts.analyze === false) return { run, runDir };
  const policy = loaded.config.readiness.policyPath;
  const analysis = await analyzeRun(runDir, {
    historyPath: resolve(cwd, '.eztest', 'history.json'),
    readinessPolicyPath: policy ? resolve(cwd, policy) : undefined,
  });
  return { run, analysis, runDir };
}
