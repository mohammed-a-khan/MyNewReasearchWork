/**
 * The EZTest time-travel trace model. One `trace.json` per journey attempt
 * (`trace/<journeyId>-<attempt>/trace.json`) indexes per-step DOM snapshots,
 * network, console, action metadata and screenshots. Large blobs live in
 * files next to it or in the run-level resource store (`trace/resources/`),
 * content-addressed by SHA-256 so identical CSS, images and bodies are kept once.
 * Every file is registered in the Evidence Vault.
 */
import type { HealRecord, HealTier, LocatorCandidate, StepStatus } from '../../core/index.js';

export const TRACE_FORMAT = 'eztest-trace';
export const TRACE_VERSION = 1;

/** Opt-in time-travel capture (RunOptions.timeTravel / config `trace.timeTravel`). */
export interface TimeTravelOptions {
  enabled: boolean;
  /** DOM snapshots before and after each step. Default true. */
  dom?: boolean;
  /** Network requests and responses per step. Default true. */
  network?: boolean;
  /** Console messages and page errors per step. Default true. */
  console?: boolean;
  /** Viewport JPEG after each step (deduplicated). Default true. */
  screenshots?: boolean;
  /** Text/JSON bodies are kept up to this many bytes. Default 65536; 0 keeps no bodies. */
  maxBodyBytes?: number;
  /** Secret masker (config `SecretMasker`); every captured string goes through it. */
  masker?: { mask(text: string): string };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Highlight info for the element a step acted on. */
export interface SnapshotTarget {
  /** `data-ez-nid` of the element inside the snapshot HTML. */
  nid: number;
  /** Page coordinates (CSS px, document origin), including same-origin iframe offsets. */
  box: Box;
  tag: string;
  /** True when the element is a password/secret input (its value is redacted). */
  sensitive?: boolean;
  /** Visible text of the element's surrounding region (form, section, dialog...), masked. */
  regionText?: string;
}

export interface SnapshotRef {
  phase: 'before' | 'after';
  /** gzip-compressed self-contained HTML, path relative to the run directory. */
  path: string;
  sha256: string;
  bytes: number;
  url: string;
  title: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  target?: SnapshotTarget;
  /** Visible page text (masked, truncated), for diffs. */
  text?: string;
  nodeCount: number;
  /** Which serializer produced it ('native-source': a native app's page source drawn over its screenshot, src/mobile). */
  engine: 'in-page' | 'native-source' | 'browser-trace';
  capturedAt: string;
}

export interface TraceBody {
  /** Inline text (small bodies) ... */
  text?: string;
  /** ... or a resource path (relative to the run directory, gzip). */
  path?: string;
  size: number;
  truncated?: boolean;
  /** Bodies of non-text types are not kept. */
  omitted?: string;
}

export interface TraceNetworkEntry {
  stepIndex: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  failure?: string;
  startedAt: string;
  durationMs?: number;
  timing?: { dnsMs?: number; connectMs?: number; waitMs?: number; receiveMs?: number };
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: TraceBody;
  responseBody?: TraceBody;
  sizes?: { requestBody: number; responseBody: number; requestHeaders: number; responseHeaders: number };
  mimeType?: string;
}

export interface TraceConsoleEntry {
  stepIndex: number;
  type: string;
  text: string;
  location?: string;
  at: string;
}

export interface TriedLocator {
  candidate: LocatorCandidate;
  description: string;
  /** Match count; -1 when the locator was invalid. */
  count: number;
  error?: string;
}

export interface HealAttempt {
  tier: HealTier;
  locator: LocatorCandidate;
  description: string;
  confidence: number;
  reason: string;
  matches: number;
}

export interface TraceCondition {
  type: string;
  /** Plain-English form of the condition. */
  text: string;
  expected?: string;
  actual?: string;
  passed: boolean;
  message?: string;
}

export interface TraceStep {
  /** Index of the step in the journey. */
  index: number;
  /** 1 for the first execution; >1 when re-run from the debugger (edit-and-continue). */
  execution: number;
  stepId: string;
  intent: string;
  action: string;
  /** Interpolated value (masked; "****" for sensitive targets). */
  value?: string;
  targetDescription?: string;
  status: StepStatus;
  error?: string;
  startedAt: string;
  durationMs: number;
  timings: { locateMs?: number; actMs?: number; verifyMs?: number; healMs?: number; snapshotMs?: number };
  locator: { used?: LocatorCandidate; usedDescription?: string; tried: TriedLocator[] };
  heal?: { attempts: HealAttempt[]; notes: string[]; record?: HealRecord };
  conditions: TraceCondition[];
  snapshots: { before?: SnapshotRef; after?: SnapshotRef };
  network: TraceNetworkEntry[];
  console: TraceConsoleEntry[];
  /** Evidence id + path of the runner's step screenshot (if any), and the trace's own viewport JPEG. */
  screenshot?: { evidenceId?: string; path?: string; viewportJpeg?: string };
  url: { before?: string; after?: string };
  /** Set when the debugger replaced the step before running it. */
  edited?: boolean;
}

export interface TraceResource {
  path: string;
  contentType: string;
  size: number;
}

export interface TraceFile {
  format: typeof TRACE_FORMAT;
  version: typeof TRACE_VERSION;
  source: 'eztest' | 'bundle' | 'browser';
  runId: string;
  journeyId: string;
  journeyName: string;
  attempt: number;
  browser: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  viewport?: { width: number; height: number };
  steps: TraceStep[];
  /** Requests/console outside any step (e.g. data setup). */
  unattributed: { network: TraceNetworkEntry[]; console: TraceConsoleEntry[] };
  /** Resources referenced by snapshots, keyed by `ezres:` token (sha256 + extension). */
  resources: Record<string, TraceResource>;
  /** Directory of this trace, relative to the run directory. */
  dir: string;
}
