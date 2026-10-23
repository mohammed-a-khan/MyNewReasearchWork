/**
 * Mock server from an OpenAPI/Swagger spec (no recordings needed): every
 * request is matched to an operation and validated against the spec (an
 * invalid request gets 400 naming the rule it broke); the response is the
 * spec's example, or data synthesised from the response schema with a seeded
 * generator, so the same request gets the same body on every run. Clients pick
 * another documented response with `Prefer: code=404` or
 * `?__code=404`.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { emptyStore, type MockStore } from '../mocks/store.js';
import { generateValue } from './generate.js';
import { loadApiSpec, matchOperation, pathKnown, validateExchange, type ApiOperation, type ApiSpec } from './openapi.js';

export interface OpenApiMockOptions {
  spec: ApiSpec | string;
  port?: number;
  host?: string;
  seed?: string | number;
  /** Validate requests against the spec (default true). */
  validateRequests?: boolean;
  /** Use examples from the spec when present (default true). */
  useExamples?: boolean;
}

export interface OpenApiMock {
  url: string;
  port: number;
  spec: ApiSpec;
  stats: { served: number; rejected: number; unmatched: number };
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The response a mock gives for an operation: chosen status, content type and body. */
export function mockResponse(spec: ApiSpec, op: ApiOperation, opts: { seed?: string | number; useExamples?: boolean; status?: string; key?: string } = {}): { status: number; contentType?: string; body?: unknown } {
  const codes = Object.keys(op.responses);
  const pick = opts.status && op.responses[opts.status] ? opts.status : codes.filter((c) => /^2/.test(c)).sort()[0] ?? codes.find((c) => /^[13]/.test(c)) ?? codes[0];
  if (!pick) return { status: 200 };
  const res = op.responses[pick];
  const status = /^\d{3}$/.test(pick) ? Number(pick) : pick === 'default' ? 200 : Number(`${pick[0]}00`);
  const [ct, media] = Object.entries(res.content).find(([k]) => /json/.test(k)) ?? Object.entries(res.content)[0] ?? [];
  if (!ct || !media) return { status };
  if (opts.useExamples !== false) {
    if (media.example !== undefined) return { status, contentType: ct, body: media.example };
    const first = media.examples ? Object.values(media.examples)[0] : undefined;
    if (first !== undefined) return { status, contentType: ct, body: first };
  }
  // Seeded per operation and request key (e.g. the path), so /orders/1 and /orders/2 differ but each is stable.
  const body = generateValue(spec, media.schema, { seed: `${opts.seed ?? 42}|${op.id}|${opts.key ?? ''}`, useExamples: opts.useExamples });
  return { status, contentType: ct, body };
}

export async function createOpenApiMock(o: OpenApiMockOptions): Promise<OpenApiMock> {
  const spec = typeof o.spec === 'string' ? loadApiSpec(o.spec) : o.spec;
  const stats = { served: 0, rejected: 0, unmatched: 0 };
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, ct = 'application/json') => {
      const text = body === undefined ? '' : ct.includes('json') ? JSON.stringify(body) : String(body);
      res.writeHead(status, { 'content-type': ct, 'x-eztest-mock': 'openapi' });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://mock');
      const requested = url.searchParams.get('__code') ?? /code=(\d{3}|default)/.exec(String(req.headers.prefer ?? ''))?.[1];
      url.searchParams.delete('__code');
      const method = (req.method ?? 'GET').toUpperCase();
      const hit = matchOperation(spec, method, url.pathname + url.search);
      if (!hit) {
        stats.unmatched++;
        return send(pathKnown(spec, url.pathname) ? 405 : 404, { error: pathKnown(spec, url.pathname) ? 'method_not_allowed' : 'not_found', message: `no operation in ${spec.title || 'the spec'} for ${method} ${url.pathname}` });
      }
      const raw = await readBody(req);
      if (o.validateRequests !== false) {
        let body: unknown = raw === '' ? undefined : raw;
        const ct = String(req.headers['content-type'] ?? '');
        if (raw && /json/i.test(ct)) {
          try {
            body = JSON.parse(raw);
          } catch {
            stats.rejected++;
            return send(400, { error: 'invalid_request', violations: [{ rule: 'body', message: 'request body is not valid JSON' }] });
          }
        } else if (raw && /x-www-form-urlencoded/i.test(ct)) body = Object.fromEntries(new URLSearchParams(raw));
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]));
        const r = validateExchange(spec, { method, url: url.pathname + url.search, requestHeaders: headers, requestBody: body, requestContentType: ct || undefined }, { response: false });
        if (!r.valid) {
          stats.rejected++;
          return send(400, { error: 'invalid_request', operation: hit.operation.id, violations: r.violations.map((v) => ({ rule: v.kind, ...(v.pointer ? { at: v.pointer } : {}), message: v.message })) });
        }
      }
      const out = mockResponse(spec, hit.operation, { seed: o.seed, useExamples: o.useExamples, ...(requested ? { status: requested } : {}), key: `${url.pathname}${url.search}` });
      stats.served++;
      send(out.status, out.body, out.contentType ?? 'application/json');
    } catch (e) {
      send(500, { error: 'mock_error', message: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${o.host ?? '127.0.0.1'}:${port}`, port, spec, stats,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A mock store (eztest-mocks format) with one recording per GET operation, from examples or seeded data. */
export function mockStoreFromSpec(spec: ApiSpec, seed: string | number = 42): MockStore {
  const store = emptyStore(spec.servers[0]);
  for (const op of spec.operations) {
    if (op.method !== 'GET') continue;
    const path = op.path.replace(/\{([^}]+)\}/g, (_m, n: string) => {
      const p = op.parameters.find((x) => x.in === 'path' && x.name === n);
      return encodeURIComponent(String(p?.example ?? generateValue(spec, p?.schema, { seed: `${seed}|${op.id}|${n}` }, n)));
    });
    const base = spec.basePaths[0] ?? '';
    const out = mockResponse(spec, op, { seed, key: `${base}${path}` });
    store.recordings.push({
      id: op.id,
      request: { method: 'GET', path: `${base}${path}`, query: '', headers: {} },
      response: { status: out.status, headers: out.contentType ? { 'content-type': out.contentType } : {}, body: out.body === undefined ? '' : JSON.stringify(out.body), bodyEncoding: 'utf8' },
      recordedAt: new Date(0).toISOString(),
    });
  }
  return store;
}
