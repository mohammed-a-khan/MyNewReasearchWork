/**
 * Shared test data: a shared store (key/value with namespaces, expiry, secrets)
 * and data pools (items claimed once, atomically) shared across journeys,
 * suites, runs, machines and pipeline stages. See docs/shared-data.md.
 */
export * from './types.js';
export { StoreCipher, isSealed, storeKeyFrom, STORE_KEY_ENV } from './cipher.js';
export { FileStoreBackend, withFileLock, itemIdFor, safeFileName } from './file.js';
export { ServerStoreBackend } from './server.js';
export { SharedStore, resolveStoreValue, type SharedStoreOptions, type SaveOptions, type LoadResult, type PoolSettings } from './runtime.js';
export { formatOutputs, githubOutputLine, outputSystems, vsoEscapeData, vsoEscapeProperty, vsoSetVariable, type OutputEntry } from './pipeline.js';
export { STORE_RULES, storeStepToText, storeSugarIntent, isStoreExpectation } from './rules.js';
export { storeAction } from './action.js';
export { storeBackendFor, storeFromConfig, type StoreFromConfigOptions } from './config.js';
