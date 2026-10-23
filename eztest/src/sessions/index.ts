/**
 * Journeys from captured user sessions (gap G36): an opt-in, privacy-safe
 * capture snippet, readers for the EZTest capture format plus HAR and
 * rrweb-style event JSON, clustering of sessions into common paths, `.ez`
 * journey generation with assertions ranked by frequency, and a coverage gap
 * against the journeys a project already has. Deterministic, no AI.
 */
export * from './model.js';
export * from './formats.js';
export * from './generate.js';
export { captureSnippet, type CaptureSnippetOptions } from './capture.js';
