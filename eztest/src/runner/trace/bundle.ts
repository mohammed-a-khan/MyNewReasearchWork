/**
 * Standalone trace bundles: one zip with a journey attempt's trace.json and
 * every file it references (snapshots, resources, bodies, screenshots), plus
 * `bundle.json` listing each file's SHA-256 from the Evidence Vault so the
 * bundle can be checked after it travelled.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../../core/index.js';
import { memorySource, readTrace, runDirSource, type TraceSource } from './read.js';
import { TRACE_FORMAT, type TraceFile } from './types.js';
import { readZip, writeZip } from './zip.js';

export const BUNDLE_FORMAT = 'eztest-trace-bundle';

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  createdAt: string;
  /** Path of trace.json inside the bundle. */
  trace: string;
  runId: string;
  journeyId: string;
  attempt: number;
  /** Every file in the bundle with its SHA-256 (from the evidence manifest when available). */
  files: Array<{ path: string; sha256: string; evidenceId?: string }>;
  /** Head of the run's evidence chain when the bundle was made. */
  evidenceHead?: string;
}

/** Every run-relative file a trace references. */
export function traceFiles(trace: TraceFile): string[] {
  const out = new Set<string>([`${trace.dir}/trace.json`]);
  for (const r of Object.values(trace.resources)) out.add(r.path);
  for (const s of trace.steps) {
    if (s.snapshots.before) out.add(s.snapshots.before.path);
    if (s.snapshots.after) out.add(s.snapshots.after.path);
    if (s.screenshot?.path) out.add(s.screenshot.path);
    if (s.screenshot?.viewportJpeg) out.add(s.screenshot.viewportJpeg);
    for (const n of s.network) {
      if (n.requestBody?.path) out.add(n.requestBody.path);
      if (n.responseBody?.path) out.add(n.responseBody.path);
    }
  }
  for (const n of trace.unattributed.network) {
    if (n.requestBody?.path) out.add(n.requestBody.path);
    if (n.responseBody?.path) out.add(n.responseBody.path);
  }
  return [...out];
}

/** Zip one journey attempt's trace (and optionally write it to `outFile`). */
export async function exportTraceBundle(runDir: string, journeyId: string, attempt = 1, outFile?: string): Promise<Buffer> {
  const trace = await readTrace(runDir, journeyId, attempt);
  const src = runDirSource(runDir);
  const manifestPath = join(runDir, 'evidence-manifest.jsonl');
  const known = new Map<string, { sha256: string; id: string }>();
  let head: string | undefined;
  if (existsSync(manifestPath)) {
    for (const line of (await readFile(manifestPath, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { path: string; sha256: string; id: string; entryHash: string };
      known.set(e.path, { sha256: e.sha256, id: e.id });
      head = e.entryHash;
    }
  }
  const entries: Array<{ name: string; data: Buffer }> = [];
  const files: BundleManifest['files'] = [];
  for (const p of traceFiles(trace)) {
    const data = await src.read(p).catch(() => undefined);
    if (!data) continue;
    entries.push({ name: p, data });
    const k = known.get(p);
    files.push({ path: p, sha256: sha256(data), ...(k ? { evidenceId: k.id } : {}) });
  }
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT, version: 1, createdAt: new Date().toISOString(), trace: `${trace.dir}/trace.json`,
    runId: trace.runId, journeyId: trace.journeyId, attempt: trace.attempt, files, evidenceHead: head,
  };
  const zip = writeZip([{ name: 'bundle.json', data: JSON.stringify(manifest, null, 2) }, ...entries]);
  if (outFile) await writeFile(outFile, zip);
  return zip;
}

export interface OpenedTrace {
  trace: TraceFile;
  source: TraceSource;
  /** Integrity problems (bundles only): files whose hash does not match bundle.json. */
  problems: string[];
}

/** Open a bundle produced by `exportTraceBundle`. */
export function readTraceBundle(zip: Buffer): OpenedTrace {
  const files = readZip(zip);
  const m = files.get('bundle.json');
  if (!m) throw new Error('Not an EZTest trace bundle (bundle.json missing)');
  const manifest = JSON.parse(m.toString('utf8')) as BundleManifest;
  if (manifest.format !== BUNDLE_FORMAT) throw new Error('Not an EZTest trace bundle');
  const problems: string[] = [];
  for (const f of manifest.files) {
    const b = files.get(f.path);
    if (!b) problems.push(`missing ${f.path}`);
    else if (sha256(b) !== f.sha256) problems.push(`altered ${f.path}`);
  }
  const t = files.get(manifest.trace);
  if (!t) throw new Error('Bundle has no trace.json');
  const trace = JSON.parse(t.toString('utf8')) as TraceFile;
  if (trace.format !== TRACE_FORMAT) throw new Error('Bundle trace.json is not an EZTest trace');
  return { trace: { ...trace, source: 'bundle' }, source: memorySource(files), problems };
}
