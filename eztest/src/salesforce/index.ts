/**
 * Salesforce Lightning adapter: REST client (describe, CRUD, safe SOQL
 * builder), OAuth token provider, field resolver (label <-> API name <->
 * Lightning locators through open shadow DOM), `sf.*` custom steps and
 * plain-English phrasings, permission matrix (describe-as-user + UI) and
 * release impact analysis on describe snapshots.
 */
export { SalesforceTokenProvider, SalesforceAuthError, type SalesforceTokenOptions } from './auth.js';
export { SalesforceClient, SalesforceApiError, assertRecordId, type SalesforceClientOptions, type SalesforceRecord, type TabInfo } from './client.js';
export {
  StaticDescribeSource, SalesforceMetadataError, assertApiName, assertFieldPath, decodeValidFor, nameFieldOf, parseDescribe, parseGlobal,
  type DescribeSnapshot, type DescribeSource, type FieldMeta, type PicklistValueMeta, type SObjectDescribe, type SObjectMeta,
} from './metadata.js';
export {
  soql, SoqlBuilder, SoqlBuildError, soqlLiteral, soqlString, escapeSoqlString, escapeSoqlLike, resolveFieldPath,
  type SoqlCondition, type SoqlOperators, type SoqlScalar,
} from './soql.js';
export {
  SalesforceFieldResolver, controlFor, controlSelector, fieldLocatorCandidates, layoutItemSelectors, outputCandidates, assertDrivable,
  normalizeLabel, suggestLabels, type ResolvedSfField, type SfControl,
} from './resolver.js';
export {
  SalesforceUiError, locateUnique, openModal, waitForModal, modalErrors, formatModalErrors, readToasts, readControl, readOutput, setControl,
  readPath, readListView, readRelatedList, navTabs, searchAppLauncher, closeAppLauncher, loginWithPassword, currentObject, currentRecordId,
  parseNumber, parseBool, toIsoDate, valuesEqual, picklistLabel,
  type FieldIo, type ModalErrors, type PathState, type SfDateFormat, type TableRow, type Toast,
} from './lightning.js';
export {
  createSalesforceSteps, salesforceEquals, normalizeAccess, SALESFORCE_STEP_NAMES,
  type SalesforceStepsOptions, type SalesforceStepName, type SalesforceCredentials, type SalesforceCredentialsProvider, type FieldAccessLevel,
} from './steps.js';
export {
  SALESFORCE_INTENT_RULES, DEFAULT_SALESFORCE_OBJECT_NAMES, createSalesforceIntentRules, parseSalesforceEzScript, parseFieldPairs, pluralizeLabel,
  type SalesforceIntentOptions,
} from './intents.js';
export {
  runPermissionMatrix,
  type AccessLevel, type PermissionCheck, type PermissionMatrixOptions, type PermissionReport, type PermissionResult, type PermissionUiOptions,
} from './permissions.js';
export {
  snapshotDescribe, diffDescribe, impactedJourneys,
  type DescribeDiff, type FieldChange, type FieldChangeKind, type SalesforceImpactReason, type SalesforceImpactedJourney,
} from './impact.js';
export {
  SalesforceConfigSchema, parseSalesforceConfig, createSalesforceIntegration,
  type SalesforceConfig, type SalesforceConfigInput, type SalesforceIntegration, type SalesforceIntegrationOptions,
} from './config.js';
