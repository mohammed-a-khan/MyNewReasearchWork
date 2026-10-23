/**
 * EZTest results server (`eztest server`): an optional central service for
 * teams. Runs are published to it; it serves cross-team dashboards, shared
 * heal decisions / quarantine / triage overrides, cross-machine resource
 * locks, EZTest contracts (publish, verification results, releases,
 * can-release), an append-only audit log and evidence retention. Studio stays
 * local-first; the server is never required to run tests.
 */
export { startResultsServer, serveFromConfig, type ServerOptions, type ServerHandle } from './app.js';
export { loadServerConfig, ServerConfigSchema, type ServerConfig } from './config.js';
export { ResultsClient, ServerLockBackend, ServerRequestError, type ResultsClientOptions } from './client.js';
export { syncSharedState, localChanges, type SyncReport } from './shared-state.js';
export { ResultsService, ServiceError, STATE_KINDS, type StateKind, type RunRow } from './service.js';
export { AuditLog, auditHash, type AuditEntry } from './audit.js';
export { ROLES, PERMISSIONS, can, roleFor, createToken, listTokens, revokeToken, setGrant, RateLimiter, type Role, type Grant, type Principal, type Action } from './auth.js';
export { OidcClient, pkceChallenge, safeNext, type OidcConfig } from './oidc.js';
export { Store, dialectSql } from './store.js';
export { ContractRegistry, type ContractQuery } from './contracts.js';
export { SharedDataRegistry } from './datastore.js';
