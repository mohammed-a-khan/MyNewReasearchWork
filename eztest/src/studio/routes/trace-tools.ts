/**
 * Trace viewer helpers on top of `routes/trace.ts`:
 *
 * - `GET  /api/traces/journey/:journeyId`  runs that hold a trace of this journey (newest first), for "compare with";
 * - `POST /api/traces/upload`              open a trace bundle or an EZTest browser trace sent by the browser
 *                                          (`{ name, data: base64 }`); both are checked against their SHA-256 lists;
 * - `POST /api/runs/:runId/browser-trace`  open a run's per-attempt browser trace (`{ path }` of a `trace`
 *                                          evidence file, the zip `context.tracing` wrote) in the viewer;
 * - `GET  /api/traces/uploaded/:id[/steps/:pos/(before|after)|/asset?path=]`  read an uploaded trace;
 * - `POST /api/traces/inspect[/hit|/pick]`  element picking on a static snapshot: the snapshot is loaded in a
 *                                          headless page (no network, scripts already stripped) and the live
 *                                          debugger's candidate ranking runs against it.
 *
 * Uploads and inspection pages are kept in memory (a few at a time).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '../../browser/index.js';
import { pageFunction } from '../../heal/fingerprint.js';
import {
  pickElement, readBrowserTrace, readTrace, readTraceAsset, readTraceBundle, readZip, isBrowserTrace, renderSnapshot, runDirSource, traceDirName, traceFiles,
  type TraceFile, type TraceSource,
} from '../../runner/index.js';
import { readEvidenceManifest } from '../../insights/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendError, sendJson } from '../http.js';
import { assertRunId, listRuns } from '../runs.js';
import { HIT_AT } from './debug-tools.js';
import type { StudioRoute } from './route.js';
import { SNAPSHOT_CSP } from './trace.js';

const MAX_UPLOAD = 64 * 1024 * 1024;
const JOURNEY_ID = /^[A-Za-z0-9][\w.-]{0,120}$/;

interface Opened {
  trace: TraceFile;
  source: TraceSource;
}

interface Uploaded extends Opened {
  id: string;
  name: string;
  kind: 'bundle' | 'browser';
  problems: string[];
  warnings: string[];
}

interface InspectPage {
  id: string;
  context: BrowserContext;
  page: Page;
  width: number;
  height: number;
}

type Ref = { runId: string; journeyId: string; attempt: number } | { uploaded: string };

const DOC_HEIGHT = pageFunction<null, number>('() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)');

function journeyIdOk(id: unknown): string {
  if (typeof id !== 'string' || !JOURNEY_ID.test(id) || id.includes('..')) throw new HttpError(400, 'Invalid journey id');
  return id;
}

function intIn(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `"${name}" must be an integer between ${min} and ${max}`);
  return n;
}

function finite(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `"${name}" must be a number`);
  return v;
}

async function readBody(ctx: { req: import('node:http').IncomingMessage }): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of ctx.req) {
    size += (c as Buffer).length;
    if (size > MAX_UPLOAD * 1.4) throw new HttpError(413, 'Trace file too large (64 MB at most)');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

function sendSnapshot(res: import('node:http').ServerResponse, html: string): void {
  const data = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Content-Security-Policy': SNAPSHOT_CSP, 'Cache-Control': 'no-store' });
  res.end(data);
}

function assetType(p: string): string {
  return /\.jpe?g(\.gz)?$/.test(p) ? 'image/jpeg' : /\.png(\.gz)?$/.test(p) ? 'image/png' : /\.json(\.gz)?$/.test(p) ? 'application/json' : 'text/plain; charset=utf-8';
}

export function traceToolRoutes(app: StudioApp): StudioRoute[] {
  const uploads = new Map<string, Uploaded>();
  let uploadSeq = 0;
  const inspected = new Map<string, InspectPage>();
  let inspectSeq = 0;
  let browser: Promise<Browser> | undefined;

  app.onClose(async () => {
    for (const p of inspected.values()) await p.context.close().catch(() => undefined);
    inspected.clear();
    const b = browser;
    browser = undefined;
    if (b) await (await b.catch(() => undefined))?.close().catch(() => undefined);
  });

  async function runDir(runId: string): Promise<string> {
    assertRunId(runId);
    const dir = join(await app.outputDir(), runId);
    if (!existsSync(dir)) throw new HttpError(404, `Run ${runId} not found`);
    return dir;
  }

  async function open(ref: Ref): Promise<Opened> {
    if ('uploaded' in ref) {
      const u = uploads.get(ref.uploaded);
      if (!u) throw new HttpError(404, 'Uploaded trace not found (uploads are kept in memory; open the file again)');
      return u;
    }
    const dir = await runDir(ref.runId);
    try {
      return { trace: await readTrace(dir, journeyIdOk(ref.journeyId), ref.attempt), source: runDirSource(dir) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Trace not found');
      throw e;
    }
  }

  function refOf(v: unknown): Ref {
    const r = (v ?? {}) as Record<string, unknown>;
    if (typeof r.uploaded === 'string') return { uploaded: r.uploaded };
    if (typeof r.runId !== 'string') throw new HttpError(400, '"source" must be { runId, journeyId, attempt } or { uploaded }');
    return { runId: r.runId, journeyId: journeyIdOk(r.journeyId), attempt: intIn(r.attempt ?? 1, 'attempt', 1, 1000) };
  }

  function mask<T>(v: T, masker?: { maskDeep<X>(x: X): X }): T {
    return masker ? masker.maskDeep(v) : v;
  }

  async function register(up: Omit<Uploaded, 'id'>): Promise<Record<string, unknown>> {
    const id = `up-${++uploadSeq}`;
    uploads.set(id, { ...up, id });
    if (uploads.size > 8) uploads.delete(uploads.keys().next().value as string);
    return mask({ id, name: up.name, kind: up.kind, problems: up.problems, warnings: up.warnings, verified: up.problems.length === 0, trace: up.trace }, await masker());
  }

  async function openZip(zip: Buffer, name: string): Promise<Omit<Uploaded, 'id'>> {
    if (isBrowserTrace(readZip(zip))) {
      const b = await readBrowserTrace(zip, { masker: await masker() });
      return { trace: b.trace, source: b.source, name, kind: 'browser', problems: b.problems, warnings: b.warnings };
    }
    const b = readTraceBundle(zip);
    return { ...b, name, kind: 'bundle', warnings: [] };
  }

  async function masker() {
    try {
      return (await app.config()).masker;
    } catch {
      return undefined;
    }
  }

  async function launch(): Promise<Browser> {
    browser ??= chromium.launch({ headless: true });
    try {
      return await browser;
    } catch (e) {
      browser = undefined;
      throw new HttpError(503, `Cannot start a headless browser for snapshot inspection: ${(e as Error).message}`);
    }
  }

  function inspectPage(id: unknown): InspectPage {
    const p = typeof id === 'string' ? inspected.get(id) : undefined;
    if (!p) throw new HttpError(404, 'Inspection expired: open the snapshot in pick mode again');
    return p;
  }

  return [
    {
      method: 'GET',
      path: /^\/api\/traces\/journey\/([^/]+)$/,
      summary: 'Runs holding a trace of a journey (newest first)',
      async handler({ res, app: a, params }) {
        const journeyId = journeyIdOk(params[0]);
        const out = await a.outputDir();
        const runs: Array<{ runId: string; attempt: number; status: string; startedAt?: string; durationMs: number; steps: number }> = [];
        for (const r of (await listRuns(out)).slice(0, 200)) {
          for (let attempt = 1; attempt <= 5; attempt++) {
            const f = join(out, r.runId, 'trace', traceDirName(journeyId, attempt), 'trace.json');
            if (!existsSync(f)) break;
            try {
              const t = JSON.parse(await readFile(f, 'utf8')) as TraceFile;
              runs.push({ runId: r.runId, attempt, status: t.status, startedAt: t.startedAt ?? r.startedAt, durationMs: t.durationMs, steps: t.steps.length });
            } catch {
              // unreadable trace: skip
            }
          }
        }
        sendJson(res, 200, { journeyId, runs });
      },
    },
    {
      method: 'POST',
      path: '/api/traces/upload',
      rawBody: true,
      summary: 'Open an EZTest trace bundle ({ name, data: base64 })',
      async handler(ctx) {
        const body = await readBody(ctx);
        if (typeof body.data !== 'string' || !body.data) throw new HttpError(400, '"data" must be the base64 file content');
        const name = typeof body.name === 'string' ? body.name.slice(0, 200) : 'trace.zip';
        const zip = Buffer.from(body.data, 'base64');
        if (zip.length > MAX_UPLOAD) throw new HttpError(413, 'Trace file too large (64 MB at most)');
        let up: Omit<Uploaded, 'id'>;
        try {
          up = await openZip(zip, name);
        } catch (e) {
          return sendError(ctx.res, 422, `Cannot open ${name}: not an EZTest trace bundle or browser trace (${(e as Error).message})`);
        }
        sendJson(ctx.res, 201, await register(up));
      },
    },
    {
      method: 'POST',
      path: /^\/api\/runs\/([^/]+)\/browser-trace$/,
      summary: "Open a run's per-attempt browser trace ({ path } of a trace evidence file) in the viewer",
      async handler({ res, params, body }) {
        const dir = await runDir(params[0]);
        const path = typeof body.path === 'string' ? body.path : '';
        const ev = (await readEvidenceManifest(dir).catch(() => [])).find((e) => e.kind === 'trace' && e.path === path && /\.zip$/i.test(e.path));
        if (!ev) return sendError(res, 404, `No browser trace ${JSON.stringify(path.slice(0, 200))} in run ${params[0]}`);
        const zip = await readFile(join(dir, ev.path));
        let up: Omit<Uploaded, 'id'>;
        try {
          up = await openZip(zip, `${params[0]}/${ev.path}`);
        } catch (e) {
          return sendError(res, 422, `Cannot open ${ev.path}: ${(e as Error).message}`);
        }
        sendJson(res, 201, await register(up));
      },
    },
    {
      method: 'GET',
      path: /^\/api\/traces\/uploaded\/([^/]+)$/,
      async handler({ res, params }) {
        const u = uploads.get(params[0]);
        if (!u) return sendError(res, 404, 'Uploaded trace not found');
        sendJson(res, 200, mask({ id: u.id, name: u.name, kind: u.kind, problems: u.problems, warnings: u.warnings, verified: !u.problems.length, trace: u.trace }, await masker()));
      },
    },
    {
      method: 'GET',
      path: /^\/api\/traces\/uploaded\/([^/]+)\/steps\/(\d+)\/(before|after)$/,
      async handler({ res, params }) {
        const o = await open({ uploaded: params[0] });
        const i = intIn(params[1], 'step', 0, Math.max(0, o.trace.steps.length - 1));
        const ref = o.trace.steps[i]?.snapshots[params[2] as 'before' | 'after'];
        if (!ref) return sendError(res, 404, `Step ${i} has no ${params[2]} snapshot`);
        sendSnapshot(res, await renderSnapshot(o.source, o.trace, ref));
      },
    },
    {
      method: 'GET',
      path: /^\/api\/traces\/uploaded\/([^/]+)\/asset$/,
      async handler({ res, params, query }) {
        const o = await open({ uploaded: params[0] });
        const p = query.get('path') ?? '';
        if (!traceFiles(o.trace).includes(p)) return sendError(res, 404, 'Not a file of this trace');
        const data = await readTraceAsset(o.source, p);
        res.writeHead(200, { 'Content-Type': assetType(p), 'Content-Length': data.length, 'Content-Security-Policy': SNAPSHOT_CSP });
        res.end(data);
      },
    },
    {
      method: 'POST',
      path: '/api/traces/inspect',
      summary: 'Load a step snapshot in a headless page for element picking',
      async handler({ res, body }) {
        const o = await open(refOf(body.source));
        const pos = intIn(body.pos, 'pos', 0, Math.max(0, o.trace.steps.length - 1));
        const phase = body.phase === 'after' ? 'after' : 'before';
        const ref = o.trace.steps[pos]?.snapshots[phase];
        if (!ref) return sendError(res, 404, `Step ${pos} has no ${phase} snapshot`);
        const html = await renderSnapshot(o.source, o.trace, ref, { highlight: false });
        const b = await launch();
        const width = Math.max(320, Math.min(2560, Math.round(ref.viewport?.width || 1280)));
        const vh = Math.max(240, Math.min(2000, Math.round(ref.viewport?.height || 800)));
        const context = await b.newContext({ viewport: { width, height: vh }, deviceScaleFactor: 1, bypassCSP: true, serviceWorkers: 'block' });
        try {
          await context.route('**/*', (r) => r.abort());
          const page = await context.newPage();
          await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
          const docH = await page.evaluate(DOC_HEIGHT, null).catch(() => vh);
          const height = Math.max(vh, Math.min(8000, Math.round(docH)));
          if (height !== vh) await page.setViewportSize({ width, height });
          const shot = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 15_000 });
          const id = `insp-${++inspectSeq}`;
          inspected.set(id, { id, context, page, width, height });
          while (inspected.size > 3) {
            const old = inspected.values().next().value as InspectPage;
            inspected.delete(old.id);
            await old.context.close().catch(() => undefined);
          }
          sendJson(res, 201, { id, width, height, image: shot.toString('base64'), target: ref.target?.box ?? null });
        } catch (e) {
          await context.close().catch(() => undefined);
          throw e;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/traces/inspect/hit',
      async handler({ res, body }) {
        const p = inspectPage(body.id);
        const hit = await p.page.evaluate(HIT_AT, { x: finite(body.x, 'x'), y: finite(body.y, 'y') }).catch(() => null);
        sendJson(res, 200, { hit: mask(hit, await masker()) });
      },
    },
    {
      method: 'POST',
      path: '/api/traces/inspect/pick',
      async handler({ res, body }) {
        const p = inspectPage(body.id);
        try {
          const r = await pickElement(p.page, { x: finite(body.x, 'x'), y: finite(body.y, 'y') });
          sendJson(res, 200, mask(r, await masker()));
        } catch (e) {
          if ((e as { code?: string }).code === 'NOT_FOUND') return sendError(res, 404, (e as Error).message);
          throw e;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/traces/inspect/close',
      async handler({ res, body }) {
        const p = typeof body.id === 'string' ? inspected.get(body.id) : undefined;
        if (p) {
          inspected.delete(p.id);
          await p.context.close().catch(() => undefined);
        }
        sendJson(res, 200, { ok: true });
      },
    },
  ];
}
