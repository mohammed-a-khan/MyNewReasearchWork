/**
 * EZTest Studio: a local web UI for testers who do not code. Browse and edit
 * journeys with live validation, run them with live progress, review results,
 * insights, record and import journeys. Local only (127.0.0.1), token-protected.
 */
export { startStudio, type StudioOptions, type StudioHandle } from './server.js';
export { validateEz, validateText, convertText, grammar, journeyTemplate, type ValidationResult, type ValidationIssue, type GrammarGroup, type JourneyFormat } from './authoring.js';
export { confinePath, confineJourneyPath, PathError } from './security.js';
export { Router, dispatch, type Route, type RouteContext as RouterContext, type Method } from './router.js';
export { EventHub, streamHub, type StudioTopics, type HubEvent, type TopicName, type TopicOptions } from './events.js';
export { StudioApp } from './app.js';
export { JourneyWatcher, type FileChange } from './watch.js';
export { buildClient, loadClient, type ClientBundle } from './bundle.js';
export { journeyModel, applySteps, type StepCard, type StepEdit, type JourneyModel } from './model.js';
export { explainLine, formatText, vocabulary } from './language.js';
export { HttpError } from './http.js';
export type { StudioRoute, StudioRouteContext } from './routes/index.js';
export { fromRouteDefs } from './routes/route.js';
export { DebugSessionManager, type DebugSession, type DebugStartRequest, type DebugSessionManagerOptions } from './debug-session.js';
export { debugRoutes } from './routes/debug.js';
export { DebugInsight } from './debug-insight.js';
export { debugToolRoutes } from './routes/debug-tools.js';
export { traceToolRoutes } from './routes/trace-tools.js';
export { traceRoutes, SNAPSHOT_CSP, type TraceRoutesOptions } from './routes/trace.js';
export { serveRoute } from './routes/node.js';
export {
  matchRoute, guarded, toHttpError,
  type RouteDef, type RouteContext, type RouteResponse, type RouteMethod, type SseSink, type SseMessage,
} from './routes/types.js';
