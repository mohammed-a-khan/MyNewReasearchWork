/** Time-travel trace: capture (opt-in via RunOptions.timeTravel), reading, bundles, EZTest browser traces (context.tracing zips) and diffs. */
export * from './types.js';
export { JourneyTraceRecorder, traceDirOf, resolveTimeTravel, SENSITIVE_DESC, isSensitiveInput, type RecorderInit, type ResolvedTimeTravel } from './recorder.js';
export { TraceResourceStore, TRACE_ROOT, RESOURCE_DIR, extFor, type StoredResource } from './store.js';
export { Redactor, REDACTED, SECRET_FIELD_RE, type Masker } from './redact.js';
export { serializePage, type RawSnapshot } from './serializer.js';
export {
  readTrace, listTraces, readTraceAsset, readSnapshotHtml, renderSnapshot, runDirSource, memorySource, traceDirName,
  type TraceSource, type TraceListItem, type RenderOptions,
} from './read.js';
export { exportTraceBundle, readTraceBundle, traceFiles, BUNDLE_FORMAT, type BundleManifest, type OpenedTrace } from './bundle.js';
export { readBrowserTrace, isBrowserTrace, type OpenedBrowserTrace, type BrowserTraceReadOptions } from './browser-trace.js';
export { diffTraces, diffText, diffNetwork, type TraceDiff, type StepDiff, type TextDiff, type NetworkDiff } from './diff.js';
export { writeZip, readZip, crc32, type ZipInput, type ZipLimits } from './zip.js';
