/**
 * Dynamics 365 / Power Apps model-driven adapter: Dataverse Web API client,
 * field resolver (label <-> logical name <-> UCI locators), D365 custom steps
 * and plain-English phrasings, and release-wave metadata impact analysis.
 */
export { DataverseClient, DataverseError, odataLiteral, buildFilter, FORMATTED_SUFFIX, type DataverseClientOptions, type DataverseRecord, type ODataScalar, type QueryOptions } from './client.js';
export {
  StaticMetadataSource, D365MetadataError, labelOf, parseAttributeJson, parseEntityJson,
  type AttributeMeta, type EntityMeta, type MetadataSource, type MetadataSnapshot, type OptionMeta,
} from './metadata.js';
export {
  FieldResolver, controlTypeFor, normalizeLabel, fieldLocatorCandidates, fieldContainerCandidate, lookupSelectors, lookupPrefix,
  webApiColumn, suggestLabels, assertDrivable, type D365ControlType, type ResolvedField,
} from './resolver.js';
export {
  D365UiError, readField, setField, readStages, readGrid, formNotifications, locateUnique, parseNumber, toIsoDate, parseTwoOption, valuesEqual,
  type DateFormat, type GridRow, type StageState,
} from './uci.js';
export { createD365Steps, dataverseEquals, D365_STEP_NAMES, type D365StepsOptions, type D365StepName } from './steps.js';
export { D365_INTENT_RULES, DEFAULT_D365_ENTITY_NAMES, createD365IntentRules, parseD365EzScript, parsePairs, pluralize, type D365IntentOptions } from './intents.js';
export {
  snapshotMetadata, diffMetadata, impactedJourneys,
  type AttributeChange, type AttributeChangeKind, type MetadataDiff, type ImpactReason, type D365ImpactedJourney,
} from './impact.js';
export { D365ConfigSchema, parseD365Config, d365TokenProvider, createD365Integration, type D365Config, type D365ConfigInput, type D365Integration } from './config.js';
