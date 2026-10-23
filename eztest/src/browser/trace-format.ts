/**
 * EZTest's browser trace format: the per-attempt archive `context.tracing`
 * writes (traces/<journey>-attempt<n>.zip in a run directory). It is EZTest's
 * own layout and schema; Studio opens it in the time-travel viewer
 * (src/runner/trace/browser-trace.ts reads it).
 *
 *   manifest.json        { format: "eztest-browser-trace", version: 1, title, browser, platform, startedAt,
 *                          viewport, counts, files: [{ path, sha256, bytes }] }   (every other file, hashed)
 *   actions.jsonl        one BrowserTraceAction per line, in start order
 *   network.jsonl        one BrowserTraceRequest per line
 *   console.jsonl        one BrowserTraceConsole per line
 *   frames.jsonl         one BrowserTraceFrame per line (screencast JPEGs)
 *   snapshots/<id>-<phase>.json   a BrowserTraceSnapshot (DOM tree, URL, viewport)
 *   resources/<sha256>   response bodies and screencast frames, by content hash
 *
 * Times are milliseconds since the trace started (`startedAt`).
 */
export const BROWSER_TRACE_FORMAT = 'eztest-browser-trace';
export const BROWSER_TRACE_VERSION = 1;
export const BROWSER_TRACE_MANIFEST = 'manifest.json';

export interface BrowserTraceManifest {
  format: typeof BROWSER_TRACE_FORMAT;
  version: typeof BROWSER_TRACE_VERSION;
  title?: string;
  browser: string;
  platform: string;
  startedAt: string;
  durationMs: number;
  viewport?: { width: number; height: number };
  counts: { actions: number; requests: number; console: number; frames: number; snapshots: number; resources: number };
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface BrowserTraceAction {
  id: string;
  /** "Page.goto", "Locator.fill", "Frame.click", ... */
  api: string;
  page: string;
  params: Record<string, unknown>;
  startMs: number;
  endMs: number;
  /** Snapshot files (snapshots/<id>-before.json, ...-after.json). */
  before?: string;
  after?: string;
  error?: string;
}

export interface BrowserTraceRequest {
  startMs: number;
  durationMs: number;
  startedAt: string;
  resourceType: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: { text: string; contentType: string };
  /** -1 when the request failed. */
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  responseBody?: { resource: string; size: number; contentType: string };
}

export interface BrowserTraceConsole {
  atMs: number;
  type: string;
  text: string;
}

export interface BrowserTraceFrame {
  atMs: number;
  page: string;
  resource: string;
  width: number;
  height: number;
}

/** A DOM element in a snapshot; text nodes are plain strings. */
export interface BrowserTraceNode {
  tag: string;
  attrs: Record<string, string>;
  /** Live form state the attributes do not show. */
  state?: { value?: string; checked?: boolean; selected?: boolean; scrollTop?: number; scrollLeft?: number };
  /** The element the action targeted. */
  target?: boolean;
  children: Array<BrowserTraceNode | string>;
}

export interface BrowserTraceSnapshot {
  action: string;
  phase: 'before' | 'after';
  url: string;
  title: string;
  doctype?: string;
  viewport: { width: number; height: number };
  dom: BrowserTraceNode;
  atMs: number;
}
