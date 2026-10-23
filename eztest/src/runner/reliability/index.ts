/**
 * Reliability: the runner's defences against the everyday causes of flaky
 * and slow suites (see docs/reliability.md).
 */
export { xpathLiteral, fillXPath, splitXPathLiterals, hasPlaceholderInLiteral } from './xpath.js';
export { probeActionability, waitActionable, actionabilityMessage, POINTER_ACTIONS, INPUT_ACTIONS, type ActionabilityProbe, type ActionabilityResult, type BlockCause, type WaitActionableOptions } from './actionability.js';
export { appIdleInitScript, installAppIdle, appIdleState, waitForAppIdle, type AppIdleOptions, type IdleState, type IdleWaitResult } from './idle.js';
export { guardedAction, noteWait, noteRecovered, takeReliability, isDetachedError, causeOfBlock, type ReliabilityOptions, type GuardEnv } from './guard.js';
export { suggestImprovement, candidatesFromFingerprint, IMPROVE_BELOW, MIN_GAIN, type Improvement } from './improve.js';
export { runHealthChecks, classifyEnvironmentFailure, networkErrorText, CircuitBreaker, ENVIRONMENT_UNAVAILABLE, type HealthCheck, type HealthEnv, type NetLogEntry } from './health.js';
export { detectSessionExpiry, DEFAULT_EXPIRY_TEXT, type SessionExpiryOptions } from './session-expiry.js';
export { classifyFlake, causeFromRecords } from './flake.js';
export { diagnoseFailure, diagnosisHint, candidateCounts, similarElements, removeOutlines, type DiagnoseInput } from './diagnose.js';
export { planDependencies, handoffFor, type DependencyPlan, type Handoff } from './dependencies.js';
export { checkPreconditions, DataPreconditionError, DATA_PRECONDITION } from './preconditions.js';
export { ContextPool } from './context-pool.js';
export { evaluateLocaleCondition } from './locale-conditions.js';
export { fastRunOptions } from './fast.js';
