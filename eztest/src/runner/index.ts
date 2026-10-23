/**
 * The executor: runs Journeys in real browsers with strict locators,
 * declarative post-conditions, verified healing and a hash-chained evidence pack.
 */
export { runJourneys, defaultFingerprintStorePath, launchOptions } from './run.js';
export { createFetchApiHandler, resolveUrl, type FetchApiOptions } from './api.js';
export { resolveTarget, toLocator, rootFor, describeCandidate, interpolateCandidate, type LocatorRoot, type Resolution } from './locate.js';
export { evaluateConditions, evaluateConditionOnce, type ConditionEnv } from './conditions.js';
export { performAction, implicitCheck, needsTarget, TARGET_ACTIONS, type ActionOutcome } from './actions.js';
export { SUSPECTED_REGRESSION } from './step.js';
export { Ledger, type DownloadRecord } from './ledger.js';
export { EvidenceWriter } from './evidence.js';
export type {
  RunOptions, StepContext, LoginHandler, ApiHandler, ApiAuthProvider, ApiResponse, DbHandler, DataHandler,
  CompareDocumentHandler, CustomStepHandler, Lens, LensFinding, ScreenshotPolicy, RunHooks, ClientCertificate, RunLocks,
  BrowserTarget, RemoteBrowserConnect,
} from './types.js';
// Cross-browser runs and remote browsers (docs/browser-driver.md); multi-actor journeys (docs/multi-actor.md).
export {
  runBrowsers, resolveBrowserTarget, openBrowser, connectBrowser, expandBrowserMatrix, stripBrowser, browserOfId, describeBrowser, BROWSER_SEP,
  type ResolvedBrowser,
} from './browsers.js';
export { actorNames, primaryActor, isMultiActor, actorSpec, DEFAULT_ACTOR, type ActorRuntime, type ActorSlot } from './actors.js';
// Advanced engine: sessions (tabs, frames, dialogs, events), flow control, network, browser state, waits.
export { BrowserSession, type ConsoleRecord, type RequestRecord, type WsFrameRecord, type SessionOptions } from './session.js';
export { PageRegistry, urlMatches, frameSelectorCandidates, resolveFrameSelector, type PageEntry, type PageSelector } from './pages.js';
export { DialogManager, type DialogRecord, type DialogPlan, type DialogPolicy, type DialogKind } from './dialogs.js';
export { executeStep, flowConditionHolds, readDataRows, type FlowEnv, type FlowScope } from './flow.js';
export { expandExamples, hookStep } from './journey-hooks.js';
export { JourneyQueue, type QueueItem } from './queue.js';
export {
  resolveExamplesSources, loadExamplesRows, loadSourceRows, filterRows, rowToStrings, dataSourcePath, validateExamplesSource, DEFAULT_PLACEHOLDER,
  type DataSourceResolver, type DataSourceContext, type DataRow, type ResolvedExamples, type ExamplesIssue, type ExamplesIssueKind, type ValidateExamplesOptions,
} from './examples-source.js';
export { normalizeKey, NAMED_KEYS } from './input.js';
export { buildHar, THROTTLE_PROFILES } from './network.js';
export { contextOptionsFor, deviceByName } from './browser-state.js';
export { bindSql, procedureSql, interpolateDeep, readRowsFile } from './data-steps.js';
export { waitForLoaders, settleLoaders, DEFAULT_LOADER_SELECTORS, type LoaderWaitResult } from './waits.js';
export { PAGE_SCRIPTS_DISABLED } from './script.js';
export { evaluateAdvancedCondition, compareOp } from './conditions-advanced.js';
export { setStepHooks, clearStepHooks, stepHooksFor, type StepHooks } from './hooks.js';
export { createRunExtensions, RunExtensions, JourneyExtension } from './extensions.js';
export { registerPlatformDriver, platformOf, driverFor, noDriverJourney, type PlatformDriver, type PlatformRunEnv, type PlatformName } from './platform.js';
export { journeyKind, isManualJourney, manualStepCount, manualSummary, runManualStep, executeManualStep, manualDriver, ManualRunEnded, type JourneyKind, type ManualStepRequest, type ManualVerdict, type ManualVerdictStatus, type ManualVerdictProvider, type ManualAttachment } from './manual.js';
export * from './trace/index.js';
export * from './debug/index.js';
export { setActiveSurface, activeSurface, type StepInterceptor, type InterceptedStep, type InterceptorRuntime, type ConditionSurface } from './surface.js';
// Reliability: actionability, app idle, re-render safety, health checks, flake classifier, diagnosis, context reuse (docs/reliability.md).
export * from './reliability/index.js';
// Code journeys (eztest/sdk): loading TypeScript journeys and code steps, and running them.
export {
  loadCodeJourneys, loadCodeModule, resolveCodeTarget, parseCodeRef, isCodeJourneyFile, journeyFromRegistration, clearCodeCache, eztestModulePath,
  CODE_JOURNEY_RE, CODE_STEPS_RE, type LoaderKind, type CodeTarget,
} from './code-journeys.js';
export { runCodeJourney, runCodeStep } from './code-host.js';
