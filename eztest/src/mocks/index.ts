/**
 * Service virtualization: record / replay / passthrough mock server with
 * stateful sequences, templates, seeded fault injection, a drift guard against
 * the real service.
 */
export { createMockServer, matchKey, type MockServer, type MockServerOptions, type MockMode, type MatchOptions } from './server.js';
export {
  loadStore,
  saveStore,
  parseStore,
  emptyStore,
  normalizeQuery,
  bodyHash,
  canonicalJson,
  MockStore,
  Recording,
  RecordedRequest,
  RecordedResponse,
  type RecordingInput,
} from './store.js';
export { FaultRule, parseFaultRules, seededRandom, pickFault, type FaultRuleInput } from './faults.js';
export { renderTemplate, hasTemplateTokens, type TemplateRequest } from './template.js';
export { checkDrift, shapeOf, compareShapes, type Shape, type ShapeDifference, type DriftAuth, type DriftOptions, type DriftReport, type DriftResultItem } from './drift.js';
export {
  REDACTED,
  redactHeaders,
  redactText,
  redactJsonValue,
  redactFormBody,
  containsSecret,
  isSensitiveHeader,
  isSensitiveField,
} from './redact.js';
