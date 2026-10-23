/**
 * ServiceNow pack: UI16 forms and lists, Service Portal catalog items,
 * Table API cross-checks, dictionary snapshots, update-set and
 * upgrade-skipped impact, and a per-role ACL matrix.
 */
export { ServiceNowClient, assertSnName, snTerm, snQuery, isSysId, snValue, type SnField, type SnTable, type SnRecord, type SnCatalogItem, type SnVariable, type SnUpdateXml, type SnSkipped, type ServiceNowClientOptions } from './client.js';
export { createServiceNowSteps, serviceNowLogin, readMessages, SERVICENOW_STEP_NAMES, type ServiceNowStepsOptions, type ServiceNowStepName, type ServiceNowCredentialsProvider, type FieldState } from './steps.js';
export { createServiceNowIntentRules, SERVICENOW_INTENT_RULES, parseServiceNowEzScript } from './intents.js';
export { snapshotServiceNow, updateSetChanges, skippedUpgradeChanges, serviceNowScoper } from './impact.js';
export { serviceNowPermissionMatrix, type ServiceNowPermissionCheck, type ServiceNowPermissionUi } from './permissions.js';
export { ServiceNowConfigSchema, parseServiceNowConfig, createServiceNowIntegration, type ServiceNowConfig, type ServiceNowConfigInput, type ServiceNowIntegration } from './config.js';
