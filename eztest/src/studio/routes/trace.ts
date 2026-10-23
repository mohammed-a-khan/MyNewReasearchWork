/**
 * Studio routes for time-travel traces: list and read a run's traces, render
 * step snapshots as sandboxed self-contained HTML, fetch trace assets, export
 * bundles and diff two traces.
 * Mount under the Studio's authenticated `/api/` dispatcher.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffTraces, exportTraceBundle, listTraces, readTrace, readTraceAsset, renderSnapshot, runDirSource, traceFiles,
  type TraceFile, type TraceSource,
} from '../../runner/index.js';
import { HttpError, assertRunId } from '../runs.js';
import { confinePath } from '../security.js';
import { guarded, optInt, str, type RouteDef } from './types.js';

/** Content-Security-Policy for serving a rendered snapshot (no scripts, no network). */
export const SNAPSHOT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

const JOURNEY_ID = /^[A-Za-z0-9][\w.-]{0,120}$/;
const SEG = '([^/]+)';

export interface TraceRoutesOptions {
  /** Resolves the results directory (e.g. `outputDirOf(ctx)`). */
  outputDir(): Promise<string>;
  /** Project directory. */
  cwd: string;
  /** Extra masking for every JSON response (config SecretMasker). */
  masker?: { maskDeep<T>(v: T): T };
}

interface Opened {
  trace: TraceFile;
  source: TraceSource;
}

function journeyIdOk(id: string): string {
  if (!JOURNEY_ID.test(id) || id.includes('..')) throw new HttpError(400, 'Invalid journey id');
  return id;
}

function attemptOf(v: string): number {
  const n = optInt(v, 'attempt', 1, 1000);
  if (n === undefined) throw new HttpError(400, 'attempt is required');
  return n;
}

/** "runId/journeyId/attempt" */
function parseRef(v: string | null, name: string): { runId: string; journeyId: string; attempt: number } {
  const m = /^([^/]+)\/([^/]+)\/(\d+)$/.exec(v ?? '');
  if (!m) throw new HttpError(400, `"${name}" must be runId/journeyId/attempt`);
  assertRunId(m[1]);
  return { runId: m[1], journeyId: journeyIdOk(m[2]), attempt: attemptOf(m[3]) };
}

export function traceRoutes(opts: TraceRoutesOptions): RouteDef[] {
  const mask = <T>(v: T): T => (opts.masker ? opts.masker.maskDeep(v) : v);
  const route = (method: RouteDef['method'], path: RouteDef['path'], handler: RouteDef['handler']): RouteDef => ({ method, path, handler: guarded(handler) });

  async function runDir(runId: string): Promise<string> {
    assertRunId(runId);
    const dir = join(await opts.outputDir(), runId);
    if (!existsSync(dir)) throw new HttpError(404, `Run ${runId} not found`);
    return dir;
  }

  async function open(runId: string, journeyId: string, attempt: string): Promise<Opened> {
    const dir = await runDir(runId);
    try {
      return { trace: await readTrace(dir, journeyIdOk(journeyId), attemptOf(attempt)), source: runDirSource(dir) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Trace not found');
      throw e;
    }
  }

  async function snapshot(o: Opened, pos: string, phase: string) {
    const i = optInt(pos, 'step', 0, o.trace.steps.length - 1);
    if (i === undefined) throw new HttpError(400, 'step position is required');
    if (phase !== 'before' && phase !== 'after') throw new HttpError(400, 'phase must be before or after');
    const ref = o.trace.steps[i].snapshots[phase];
    if (!ref) throw new HttpError(404, `Step ${i} has no ${phase} snapshot`);
    const html = await renderSnapshot(o.source, o.trace, ref);
    return { body: html, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': SNAPSHOT_CSP } };
  }

  async function asset(o: Opened, path: string | null) {
    const p = str(path, 'path');
    if (!traceFiles(o.trace).includes(p)) throw new HttpError(404, 'Not a file of this trace');
    const data = await readTraceAsset(o.source, p);
    const type = /\.jpe?g(\.gz)?$/.test(p) ? 'image/jpeg' : /\.png(\.gz)?$/.test(p) ? 'image/png' : /\.json(\.gz)?$/.test(p) ? 'application/json' : /\.css(\.gz)?$/.test(p) ? 'text/css' : 'text/plain; charset=utf-8';
    return { body: data, contentType: type, headers: { 'Content-Security-Policy': SNAPSHOT_CSP } };
  }

  const base = `^\\/api\\/runs\\/${SEG}\\/traces\\/${SEG}\\/${SEG}`;
  return [
    route('GET', new RegExp(`^\\/api\\/runs\\/${SEG}\\/traces$`), async ({ params }) => ({ json: mask({ traces: await listTraces(await runDir(params[0])) }) })),
    route('GET', new RegExp(`${base}$`), async ({ params }) => ({ json: mask((await open(params[0], params[1], params[2])).trace) })),
    route('GET', new RegExp(`${base}\\/steps\\/(\\d+)\\/(before|after)$`), async ({ params }) => snapshot(await open(params[0], params[1], params[2]), params[3], params[4])),
    route('GET', new RegExp(`${base}\\/asset$`), async ({ params, query }) => asset(await open(params[0], params[1], params[2]), query.get('path'))),
    route('GET', new RegExp(`${base}\\/bundle$`), async ({ params }) => {
      const dir = await runDir(params[0]);
      const zip = await exportTraceBundle(dir, journeyIdOk(params[1]), attemptOf(params[2]));
      return { body: zip, contentType: 'application/zip', headers: { 'Content-Disposition': `attachment; filename="${params[1]}-${params[2]}.eztrace.zip"` } };
    }),
    route('GET', '/api/traces/diff', async ({ query }) => {
      const a = parseRef(query.get('a'), 'a');
      const b = parseRef(query.get('b'), 'b');
      const ta = await open(a.runId, a.journeyId, String(a.attempt));
      const tb = await open(b.runId, b.journeyId, String(b.attempt));
      return { json: mask(diffTraces(ta.trace, tb.trace)) };
    }),
  ];
}
