/** Trace viewer data: the trace model (as served by the trace routes) and URL helpers per source. */
import { TOKEN } from '../../core/api.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotRef {
  phase: 'before' | 'after';
  path: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  target?: { nid: number; box: Box; tag: string; sensitive?: boolean; regionText?: string };
  text?: string;
  nodeCount: number;
  engine: string;
}

export interface TraceBody {
  text?: string;
  path?: string;
  size: number;
  truncated?: boolean;
  omitted?: string;
}

export interface NetworkEntry {
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

export interface ConsoleEntry {
  stepIndex: number;
  type: string;
  text: string;
  location?: string;
  at: string;
}

export interface Candidate {
  strategy: string;
  value: string;
  name?: string;
}

export interface TraceStep {
  index: number;
  execution: number;
  stepId: string;
  intent: string;
  action: string;
  value?: string;
  targetDescription?: string;
  status: string;
  error?: string;
  startedAt: string;
  durationMs: number;
  timings: { locateMs?: number; actMs?: number; verifyMs?: number; healMs?: number; snapshotMs?: number };
  locator: { used?: Candidate; usedDescription?: string; tried: Array<{ candidate: Candidate; description: string; count: number; error?: string }> };
  heal?: { attempts: Array<{ tier: string; locator: Candidate; description: string; confidence: number; reason: string; matches: number }>; notes: string[]; record?: { tier: string; confidence: number; verified: boolean; reason: string } };
  conditions: Array<{ type: string; text: string; expected?: string; actual?: string; passed: boolean; message?: string }>;
  snapshots: { before?: SnapshotRef; after?: SnapshotRef };
  network: NetworkEntry[];
  console: ConsoleEntry[];
  screenshot?: { evidenceId?: string; path?: string; viewportJpeg?: string };
  url: { before?: string; after?: string };
  edited?: boolean;
}

export interface TraceFile {
  format: string;
  version: number;
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
  unattributed: { network: NetworkEntry[]; console: ConsoleEntry[] };
  resources: Record<string, { path: string; contentType: string; size: number }>;
  dir: string;
}

export type TraceSource =
  | { kind: 'run'; runId: string; journeyId: string; attempt: number }
  | { kind: 'uploaded'; id: string; name: string; bundleKind: 'bundle' | 'browser'; problems: string[]; warnings: string[]; verified: boolean };

export function baseUrl(s: TraceSource): string {
  return s.kind === 'run'
    ? `/api/runs/${encodeURIComponent(s.runId)}/traces/${encodeURIComponent(s.journeyId)}/${s.attempt}`
    : `/api/traces/uploaded/${encodeURIComponent(s.id)}`;
}

export function snapshotUrl(s: TraceSource, pos: number, phase: 'before' | 'after'): string {
  return `${baseUrl(s)}/steps/${pos}/${phase}`;
}

export function assetUrl(s: TraceSource, path: string): string {
  return `${baseUrl(s)}/asset?path=${encodeURIComponent(path)}`;
}

export function bundleUrl(s: TraceSource): string | undefined {
  return s.kind === 'run' ? `${baseUrl(s)}/bundle` : undefined;
}

/** The API's reference to a trace (for inspect and diff routes). */
export function refOf(s: TraceSource): Record<string, unknown> {
  return s.kind === 'run' ? { runId: s.runId, journeyId: s.journeyId, attempt: s.attempt } : { uploaded: s.id };
}

/** Text of a trace asset (bodies stored as files). */
export async function assetText(s: TraceSource, path: string): Promise<string> {
  const r = await fetch(assetUrl(s, path), { headers: { 'X-EZTest-Token': TOKEN }, credentials: 'same-origin' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export const PHASES = [
  { key: 'locateMs', label: 'Locate', cls: 'ph-locate' },
  { key: 'actMs', label: 'Act', cls: 'ph-act' },
  { key: 'verifyMs', label: 'Verify', cls: 'ph-verify' },
  { key: 'healMs', label: 'Heal', cls: 'ph-heal' },
] as const;
