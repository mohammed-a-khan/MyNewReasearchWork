/**
 * Service virtualization server: record (reverse proxy + capture), replay
 * (match recorded pairs, stateful sequences, templates) and passthrough, with
 * fault injection in every mode. Unmatched replay requests get a 501 with an
 * explanation, never a fabricated 200.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { EzTestError, NotSupportedError, sleep } from '../core/index.js';
import {
  bodyHash,
  decodeBody,
  emptyStore,
  encodeBody,
  isJsonContentType,
  loadStore,
  normalizeQuery,
  redactBody,
  saveStore,
  storableResponseHeaders,
  type MockStore,
  type Recording,
} from './store.js';
import { REDACTED, redactHeaders } from './redact.js';
import { corrupt, parseFaultRules, pickFault, seededRandom, type FaultRuleInput } from './faults.js';
import { renderTemplate } from './template.js';
import { existsSync } from 'node:fs';

export type MockMode = 'replay' | 'record' | 'passthrough';

export interface MatchOptions {
  /** Include the request body hash in the match key (default true). */
  body?: boolean;
  /** Query parameters ignored when matching (e.g. cache busters). */
  ignoreQueryParams?: string[];
  /** Header names whose values must also match (sensitive headers are redacted and cannot be used). */
  headers?: string[];
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  mode: MockMode;
  /** Upstream base URL (required for record and passthrough). */
  target?: string;
  /** Path to the JSON store. */
  store: string;
  faults?: FaultRuleInput[];
  /** Seed for fault probabilities (default 1). */
  seed?: number;
  match?: MatchOptions;
  /** What a stateful sequence does after its last recorded response (default "repeat-last"). */
  sequenceExhausted?: 'repeat-last' | 'cycle' | 'not-found';
  /** Upstream timeout in record/passthrough (default 30s). */
  upstreamTimeoutMs?: number;
}

export interface MockServer {
  url: string;
  port: number;
  mode: MockMode;
  /** Live list of recordings (recorded so far, or loaded for replay). */
  recordings: Recording[];
  /** Number of requests served per outcome. */
  stats: { replayed: number; unmatched: number; recorded: number; proxied: number; faulted: number };
  /** Reset stateful sequence positions. */
  resetSequences(): void;
  close(): Promise<void>;
}

interface Captured {
  method: string;
  path: string;
  search: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

interface Outgoing {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  delayMs?: number;
}

export function matchKey(
  r: { method: string; path: string; query: string; bodyHash?: string; headers?: Record<string, string> },
  m: MatchOptions = {},
): string {
  const parts = [r.method.toUpperCase(), r.path, normalizeQuery(r.query, m.ignoreQueryParams ?? [])];
  if (m.body !== false) parts.push(r.bodyHash ?? '-');
  for (const h of m.headers ?? []) parts.push(`${h.toLowerCase()}=${r.headers?.[h.toLowerCase()] ?? ''}`);
  return parts.join(' ');
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function headerValue(h: IncomingMessage['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function proxy(target: URL, c: Captured, timeoutMs: number): Promise<Outgoing & { rawHeaders: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(c.headers)) {
      if (v === undefined) continue;
      if (['host', 'connection', 'accept-encoding', 'content-length', 'transfer-encoding', 'keep-alive'].includes(k)) continue;
      headers[k] = v;
    }
    headers.host = target.host;
    if (c.body.length) headers['content-length'] = String(c.body.length);
    const basePath = target.pathname.replace(/\/$/, '');
    const fn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const up = fn(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: c.method,
        path: `${basePath}${c.path}${c.search}`,
        headers,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined || ['connection', 'transfer-encoding', 'keep-alive', 'content-length'].includes(k)) continue;
            out[k] = Array.isArray(v) ? v.join(', ') : v;
          }
          resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks), rawHeaders: res.headers });
        });
        res.on('error', reject);
      },
    );
    up.on('timeout', () => up.destroy(new Error(`upstream timeout after ${timeoutMs}ms`)));
    up.on('error', reject);
    up.end(c.body);
  });
}

function jsonError(status: number, payload: Record<string, unknown>): Outgoing {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-eztest-mock': 'error' },
    body: Buffer.from(JSON.stringify(payload, null, 2)),
  };
}

export async function createMockServer(opts: MockServerOptions): Promise<MockServer> {
  const mode = opts.mode;
  if (!['replay', 'record', 'passthrough'].includes(mode)) throw new NotSupportedError(`mock mode "${String(mode)}"`);
  const host = opts.host ?? '127.0.0.1';
  const match = opts.match ?? {};
  const faults = parseFaultRules(opts.faults);
  const rand = seededRandom(opts.seed ?? 1);
  const timeoutMs = opts.upstreamTimeoutMs ?? 30_000;
  const exhausted = opts.sequenceExhausted ?? 'repeat-last';

  let target: URL | undefined;
  if (mode !== 'replay') {
    if (!opts.target) throw new EzTestError(`Mock mode "${mode}" needs a target URL`, 'MOCK_TARGET_REQUIRED');
    target = new URL(opts.target);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new NotSupportedError(`target protocol ${target.protocol}`);
  }

  let store: MockStore;
  if (mode === 'replay') {
    store = await loadStore(opts.store);
    if (store.recordings.length === 0) throw new EzTestError(`Mock store ${opts.store} has no recordings to replay`, 'MOCK_STORE_EMPTY');
  } else if (mode === 'record') {
    store = existsSync(opts.store) ? await loadStore(opts.store) : emptyStore(opts.target);
    store.target = opts.target;
  } else {
    store = emptyStore(opts.target);
  }

  // Replay index: match key -> recordings in recorded order.
  const index = new Map<string, Recording[]>();
  const rebuildIndex = () => {
    index.clear();
    for (const r of store.recordings) {
      const k = matchKey(r.request, match);
      const list = index.get(k) ?? [];
      list.push(r);
      index.set(k, list);
    }
  };
  if (mode === 'replay') rebuildIndex();
  const positions = new Map<string, number>();

  const stats = { replayed: 0, unmatched: 0, recorded: 0, proxied: 0, faulted: 0 };
  let saveChain: Promise<void> = Promise.resolve();
  let saveError: Error | undefined;
  let nextId = store.recordings.length;
  const queueSave = () => {
    store.updatedAt = new Date().toISOString();
    saveChain = saveChain.then(() => saveStore(opts.store, store)).catch((e: Error) => {
      saveError = e;
    });
    return saveChain;
  };

  function replay(c: Captured): Outgoing {
    const ct = headerValue(c.headers, 'content-type');
    const reqHeaders = redactHeaders(c.headers as Record<string, string | string[] | undefined>);
    const probe = {
      method: c.method,
      path: c.path,
      query: normalizeQuery(c.search),
      bodyHash: bodyHash(c.body.length ? c.body.toString('utf8') : undefined, ct),
      headers: reqHeaders,
    };
    const key = matchKey(probe, match);
    const list = index.get(key);
    if (!list?.length) {
      stats.unmatched++;
      const samePath = store.recordings
        .filter((r) => r.request.path === c.path)
        .slice(0, 5)
        .map((r) => ({ id: r.id, method: r.request.method, query: r.request.query, bodyHash: r.request.bodyHash ?? null }));
      return jsonError(501, {
        error: 'eztest-mock-no-match',
        message: `No recorded response matches ${c.method} ${c.path}${probe.query ? `?${probe.query}` : ''}`,
        request: { method: c.method, path: c.path, query: probe.query, bodyHash: probe.bodyHash ?? null },
        candidatesOnSamePath: samePath,
        hint: 'Record this call (mode "record"), add a handwritten recording to the store, or relax matchers (match.body=false, match.ignoreQueryParams).',
      });
    }
    const pos = positions.get(key) ?? 0;
    let idx = pos;
    if (pos >= list.length) {
      if (exhausted === 'repeat-last') idx = list.length - 1;
      else if (exhausted === 'cycle') idx = pos % list.length;
      else {
        stats.unmatched++;
        return jsonError(501, {
          error: 'eztest-mock-sequence-exhausted',
          message: `All ${list.length} recorded responses for ${c.method} ${c.path} were already served`,
          hint: 'Record more calls, or use sequenceExhausted "repeat-last" / "cycle".',
        });
      }
    }
    positions.set(key, pos + 1);
    const rec = list[idx];
    stats.replayed++;
    const resCt = rec.response.headers['content-type'];
    const tplReq = { method: c.method, path: c.path, query: new URLSearchParams(c.search), headers: c.headers };
    let body = decodeBody(rec.response.body, rec.response.bodyEncoding);
    if (rec.response.bodyEncoding !== 'base64') {
      body = Buffer.from(renderTemplate(rec.response.body, tplReq, { json: isJsonContentType(resCt) }), 'utf8');
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec.response.headers)) {
      if (v === REDACTED) continue; // never replay a placeholder cookie / credential header
      headers[k] = renderTemplate(v, tplReq);
    }
    headers['x-eztest-mock'] = `replay; recording=${rec.id}; seq=${idx + 1}/${list.length}`;
    return { status: rec.response.status, headers, body, delayMs: rec.response.delayMs };
  }

  async function forward(c: Captured): Promise<Outgoing> {
    let up;
    try {
      up = await proxy(target!, c, timeoutMs);
    } catch (e) {
      return jsonError(502, { error: 'eztest-mock-upstream-failed', message: (e as Error).message });
    }
    stats.proxied++;
    if (mode === 'record') {
      const reqCt = headerValue(c.headers, 'content-type');
      const resCt = up.headers['content-type'];
      const reqBodyText = c.body.length ? c.body.toString('utf8') : undefined;
      const resEncoded = encodeBody(up.body, resCt);
      const rec: Recording = {
        id: `R-${++nextId}`,
        request: {
          method: c.method,
          path: c.path,
          query: normalizeQuery(c.search),
          headers: redactHeaders(c.headers as Record<string, string | string[] | undefined>),
          body: reqBodyText === undefined ? undefined : redactBody(reqBodyText, reqCt, '[REDACTED]'),
          bodyEncoding: reqBodyText === undefined ? undefined : 'utf8',
          bodyHash: bodyHash(reqBodyText, reqCt),
        },
        response: {
          status: up.status,
          headers: storableResponseHeaders(up.rawHeaders as Record<string, string | string[] | undefined>),
          // Token-like response fields become a fresh {{uuid}} per replay; the real value never reaches disk.
          body: resEncoded.bodyEncoding === 'utf8' ? redactBody(resEncoded.body, resCt, '{{uuid}}') : resEncoded.body,
          bodyEncoding: resEncoded.bodyEncoding,
        },
        recordedAt: new Date().toISOString(),
      };
      store.recordings.push(rec);
      stats.recorded++;
      await queueSave();
    }
    return { status: up.status, headers: { ...up.headers, 'x-eztest-mock': mode }, body: up.body };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://mock.local');
    const c: Captured = { method: (req.method ?? 'GET').toUpperCase(), path: u.pathname, search: u.search, headers: req.headers, body: await readAll(req) };
    const fault = pickFault(faults, c.method, c.path, rand);
    if (fault) stats.faulted++;
    if (fault?.drop) {
      req.socket.destroy();
      return;
    }
    if (fault?.latencyMs) await sleep(fault.latencyMs);
    const out = mode === 'replay' ? replay(c) : await forward(c);
    if (out.delayMs) await sleep(out.delayMs);
    let body = out.body;
    let status = out.status;
    if (fault?.status !== undefined) status = fault.status;
    if (fault?.corruptBody) body = corrupt(body);
    if (fault) out.headers['x-eztest-fault'] = [fault.drop ? 'drop' : '', fault.latencyMs ? `latency=${fault.latencyMs}` : '', fault.status ? `status=${fault.status}` : '', fault.corruptBody ? 'corrupt' : ''].filter(Boolean).join(';');
    out.headers['content-length'] = String(body.length);
    res.writeHead(status, out.headers);
    res.end(body);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) {
        const o = jsonError(500, { error: 'eztest-mock-internal', message: e.message });
        res.writeHead(o.status, o.headers);
        res.end(o.body);
      } else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const urlHost = host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? '127.0.0.1' : host;

  return {
    url: `http://${urlHost}:${port}`,
    port,
    mode,
    recordings: store.recordings,
    stats,
    resetSequences: () => positions.clear(),
    async close() {
      await saveChain;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (mode === 'record') await saveStore(opts.store, store);
      if (saveError) throw new EzTestError(`Mock store could not be saved: ${saveError.message}`, 'MOCK_STORE_WRITE');
    },
  };
}
