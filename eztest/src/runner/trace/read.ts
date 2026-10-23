/**
 * Reading traces back: from a run directory or a standalone bundle, all
 * through one `TraceSource` (path -> bytes),
 * plus rendering a snapshot as a self-contained HTML page.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { safeName } from '../evidence.js';
import { traceDirOf } from './recorder.js';
import { TRACE_ROOT } from './store.js';
import { TRACE_FORMAT, type SnapshotRef, type TraceFile } from './types.js';

/** Where trace files come from: path (relative to the run directory) -> bytes. */
export interface TraceSource {
  read(path: string): Promise<Buffer>;
}

/** A source over a run directory; paths can never escape it. */
export function runDirSource(runDir: string): TraceSource {
  const root = resolve(runDir);
  return {
    async read(p: string) {
      const abs = resolve(root, p);
      const rel = relative(root, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Trace path escapes the run directory: ${p}`);
      return readFile(abs);
    },
  };
}

/** A source over in-memory files (bundles, imports). */
export function memorySource(files: Map<string, Buffer>): TraceSource {
  return {
    async read(p: string) {
      const b = files.get(p);
      if (!b) throw Object.assign(new Error(`Trace file not found: ${p}`), { code: 'ENOENT' });
      return b;
    },
  };
}

function assertTrace(v: unknown, where: string): TraceFile {
  const t = v as TraceFile;
  if (!t || t.format !== TRACE_FORMAT || !Array.isArray(t.steps)) throw new Error(`${where} is not an EZTest trace`);
  return t;
}

/** Read `trace/<journeyId>-<attempt>/trace.json` from a run directory. */
export async function readTrace(runDir: string, journeyId: string, attempt = 1): Promise<TraceFile> {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  const path = `${traceDirOf(journeyId, attempt)}/trace.json`;
  return assertTrace(JSON.parse((await runDirSource(runDir).read(path)).toString('utf8')), path);
}

export interface TraceListItem {
  journeyId: string;
  journeyName: string;
  attempt: number;
  status: string;
  steps: number;
  durationMs: number;
  dir: string;
}

/** All traces in a run directory. */
export async function listTraces(runDir: string): Promise<TraceListItem[]> {
  const root = join(runDir, TRACE_ROOT);
  if (!existsSync(root)) return [];
  const out: TraceListItem[] = [];
  for (const d of await readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'resources') continue;
    const f = join(root, d.name, 'trace.json');
    if (!existsSync(f)) continue;
    try {
      const t = assertTrace(JSON.parse(await readFile(f, 'utf8')), f);
      out.push({ journeyId: t.journeyId, journeyName: t.journeyName, attempt: t.attempt, status: t.status, steps: t.steps.length, durationMs: t.durationMs, dir: t.dir });
    } catch {
      // not a trace
    }
  }
  return out.sort((a, b) => a.journeyId.localeCompare(b.journeyId) || a.attempt - b.attempt);
}

/** Read a trace file's bytes, gunzipping `.gz` files. */
export async function readTraceAsset(source: TraceSource, path: string): Promise<Buffer> {
  const b = await source.read(path);
  return path.endsWith('.gz') ? gunzipSync(b) : b;
}

/** The raw snapshot HTML (scripts already stripped, resources referenced as `ezres:`). */
export async function readSnapshotHtml(source: TraceSource, ref: SnapshotRef): Promise<string> {
  return (await readTraceAsset(source, ref.path)).toString('utf8');
}

export interface RenderOptions {
  /** Outline the step's target element. Default true. */
  highlight?: boolean;
}

/**
 * A snapshot as one self-contained HTML page: stylesheets and images from the
 * resource store inlined, a CSP that forbids scripts and network access, and
 * the target element outlined. Serve it in a sandboxed iframe.
 */
export async function renderSnapshot(source: TraceSource, trace: TraceFile, ref: SnapshotRef, opts: RenderOptions = {}): Promise<string> {
  const raw = await readSnapshotHtml(source, ref);
  const cache = new Map<string, Buffer | undefined>();
  const keys = [...new Set([...raw.matchAll(/ezres:([a-f0-9]{64}\.[a-z0-9]+)/g)].map((m) => m[1]))];
  for (const key of keys) {
    const r = trace.resources[key];
    cache.set(key, r ? await readTraceAsset(source, r.path).catch(() => undefined) : undefined);
  }
  let html = inlineResources(raw, trace, cache);
  const head =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
    (opts.highlight !== false && ref.target ? `<style>[data-ez-nid="${ref.target.nid}"]{outline:3px solid #e11d48!important;outline-offset:2px!important}</style>` : '');
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, (m) => m + head) : head + html;
  return html;
}

/** Replace `ezres:` references with inline styles / data URIs, recursing into iframe `srcdoc`. */
function inlineResources(input: string, trace: TraceFile, cache: Map<string, Buffer | undefined>): string {
  let html = input.replace(/\bsrcdoc="([^"]*)"/g, (_m, v: string) => `srcdoc="${escAttr(inlineResources(unescAttr(v), trace, cache))}"`);
  html = html.replace(/<link\b[^>]*\bhref="ezres:([a-f0-9]{64}\.[a-z0-9]+)"[^>]*>/g, (_m, key: string) => {
    const css = cache.get(key);
    return css ? `<style data-ez-res="${key}">${css.toString('utf8').replace(/<\/style/gi, '<\\/style')}</style>` : '';
  });
  return html.replace(/\b(src|href)="ezres:([a-f0-9]{64}\.[a-z0-9]+)"/g, (_m, attr: string, key: string) => {
    const b = cache.get(key);
    const type = trace.resources[key]?.contentType ?? 'application/octet-stream';
    return b ? `${attr}="data:${type};base64,${b.toString('base64')}"` : `${attr}=""`;
  });
}

function unescAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Trace directory name for a journey attempt (exported for routes and tools). */
export function traceDirName(journeyId: string, attempt: number): string {
  return `${safeName(journeyId)}-${attempt}`;
}
