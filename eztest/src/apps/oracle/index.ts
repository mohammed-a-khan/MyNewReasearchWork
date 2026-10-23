/**
 * Oracle pack: Fusion Cloud Redwood and EBS OA Framework steps (fields,
 * LOVs, tables), Fusion REST cross-checks, quarterly-update impact and a
 * role / resource / page matrix.
 */
export { OracleRestClient, oracleQ, assertOracleName, type OracleAttribute, type OracleResourceMeta, type OracleResourceDef, type OracleClientOptions } from './client.js';
export { createOracleSteps, oracleLogin, ORACLE_STEP_NAMES, type OracleStepsOptions, type OracleStepName, type OracleCredentials } from './steps.js';
export { createOracleIntentRules, ORACLE_INTENT_RULES, parseOracleEzScript } from './intents.js';
export { snapshotOracle, featureListChanges, oracleScoper } from './impact.js';
export { OracleConfigSchema, parseOracleConfig, createOracleIntegration, type OracleConfig, type OracleConfigInput, type OracleIntegration, type OraclePermissionCheck } from './config.js';
