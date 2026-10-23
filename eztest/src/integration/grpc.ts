/**
 * gRPC on @grpc/grpc-js + @grpc/proto-loader (Apache-2.0, optional peers):
 * unary and server-streaming calls from .proto files, status codes by name,
 * metadata, deadlines; and a gRPC mock server answering from declarative
 * responses (request field matching, streams, error statuses).
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { EzTestError } from '../core/index.js';
import { loadClient } from './bus/types.js';

type Any = any;

export interface GrpcServiceOptions {
  address: string;
  proto: string | string[];
  includeDirs?: string[];
  tls?: boolean;
  ca?: string;
  metadata?: Record<string, string>;
  timeoutMs?: number;
}

export interface GrpcCallResult {
  /** Response message (unary), or the list of messages (server streaming). */
  response: unknown;
  status: string;
  code: number;
  details: string;
  metadata: Record<string, string>;
  streaming: boolean;
}

async function libs(): Promise<{ grpc: Any; loader: Any }> {
  const grpc = await loadClient('@grpc/grpc-js', 'gRPC');
  const loader = await loadClient('@grpc/proto-loader', 'gRPC (.proto loading)');
  return { grpc, loader };
}

const LOAD_OPTS = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };

function metaRecord(md: Any): Record<string, string> {
  const out: Record<string, string> = {};
  const map = md?.getMap ? md.getMap() : {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) out[k] = Buffer.isBuffer(v) ? (v as Buffer).toString('base64') : String(v);
  return out;
}

/** "shop.Orders/Get" or "/shop.Orders/Get" -> service and method names. */
export function splitMethod(m: string): { service: string; method: string } {
  const t = m.replace(/^\//, '');
  const i = t.lastIndexOf('/');
  const j = t.lastIndexOf('.');
  if (i > 0) return { service: t.slice(0, i), method: t.slice(i + 1) };
  if (j > 0) return { service: t.slice(0, j), method: t.slice(j + 1) };
  throw new EzTestError(`gRPC method must look like "package.Service/Method" (got "${m}")`, 'GRPC_METHOD');
}

export class GrpcServiceClient {
  private client?: Any;
  private def?: Record<string, Any>;
  private grpc?: Any;

  constructor(readonly name: string, readonly opts: GrpcServiceOptions, readonly baseDir: string) {}

  private async init(): Promise<void> {
    if (this.client) return;
    const { grpc, loader } = await libs();
    this.grpc = grpc;
    const files = (Array.isArray(this.opts.proto) ? this.opts.proto : [this.opts.proto]).map((p) => resolve(this.baseDir, p));
    this.def = loader.loadSync(files, { ...LOAD_OPTS, includeDirs: (this.opts.includeDirs ?? []).map((d) => resolve(this.baseDir, d)) });
    const creds = this.opts.tls ? grpc.credentials.createSsl(this.opts.ca ? readFileSync(resolve(this.baseDir, this.opts.ca)) : undefined) : grpc.credentials.createInsecure();
    this.client = new grpc.Client(this.opts.address, creds);
  }

  /** Statuses by name and number (OK = 0, NOT_FOUND = 5, ...). */
  async statusName(code: number): Promise<string> {
    await this.init();
    return Object.entries(this.grpc.status as Record<string, number>).find(([, v]) => v === code)?.[0] ?? String(code);
  }

  async call(method: string, request: unknown, o: { metadata?: Record<string, string>; timeoutMs?: number } = {}): Promise<GrpcCallResult> {
    await this.init();
    const { service, method: m } = splitMethod(method);
    const svc = this.def![service];
    if (!svc) throw new EzTestError(`gRPC service "${service}" is not in ${String(this.opts.proto)} (known: ${Object.keys(this.def!).filter((k) => typeof this.def![k] === 'object' && !this.def![k].format).join(', ')})`, 'GRPC_METHOD');
    const md = svc[m];
    if (!md?.path) throw new EzTestError(`gRPC service "${service}" has no method "${m}" (methods: ${Object.keys(svc).join(', ')})`, 'GRPC_METHOD');
    if (md.requestStream) throw new EzTestError(`"${method}" is a client-streaming call; only unary and server-streaming calls are supported`, 'GRPC_METHOD');
    const grpc = this.grpc;
    const metadata = new grpc.Metadata();
    for (const [k, v] of Object.entries({ ...(this.opts.metadata ?? {}), ...(o.metadata ?? {}) })) metadata.add(k, v);
    const deadline = new Date(Date.now() + (o.timeoutMs ?? this.opts.timeoutMs ?? 30_000));
    const names = grpc.status as Record<string, number>;
    const name = (c: number) => Object.entries(names).find(([, v]) => v === c)?.[0] ?? String(c);
    let headers: Record<string, string> = {};
    if (!md.responseStream) {
      return new Promise((resolveP) => {
        const call = this.client.makeUnaryRequest(md.path, md.requestSerialize, md.responseDeserialize, request ?? {}, metadata, { deadline }, (err: Any, res: unknown) => {
          if (err) resolveP({ response: undefined, status: name(err.code), code: err.code, details: err.details ?? err.message, metadata: { ...headers, ...metaRecord(err.metadata) }, streaming: false });
          else resolveP({ response: res, status: 'OK', code: 0, details: '', metadata: headers, streaming: false });
        });
        call.on('metadata', (h: Any) => (headers = metaRecord(h)));
      });
    }
    return new Promise((resolveP) => {
      const items: unknown[] = [];
      const stream = this.client.makeServerStreamRequest(md.path, md.requestSerialize, md.responseDeserialize, request ?? {}, metadata, { deadline });
      stream.on('metadata', (h: Any) => (headers = metaRecord(h)));
      stream.on('data', (d: unknown) => items.push(d));
      let done = false;
      stream.on('status', (s: Any) => {
        if (done) return;
        done = true;
        resolveP({ response: items, status: name(s.code), code: s.code, details: s.details ?? '', metadata: { ...headers, ...metaRecord(s.metadata) }, streaming: true });
      });
      stream.on('error', () => undefined);
    });
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
  }
}

// ------------------------------------------------------------------ mock server

export interface GrpcMockResponse {
  /** Request fields that must be equal (string comparison) for this response to apply. */
  when?: Record<string, unknown>;
  response?: unknown;
  /** Server-streaming responses. */
  stream?: unknown[];
  /** Error status name or number (e.g. NOT_FOUND). */
  status?: string | number;
  message?: string;
  delayMs?: number;
}

export interface GrpcMockOptions {
  proto: string | string[];
  includeDirs?: string[];
  /** "package.Service/Method" -> responses, first match wins. */
  responses: Record<string, GrpcMockResponse[]>;
  port?: number;
  host?: string;
  baseDir?: string;
}

export interface GrpcMock {
  address: string;
  port: number;
  calls: Array<{ method: string; request: unknown }>;
  close(): Promise<void>;
}

function matches(req: unknown, when?: Record<string, unknown>): boolean {
  if (!when) return true;
  const r = (req ?? {}) as Record<string, unknown>;
  return Object.entries(when).every(([k, v]) => String(r[k]) === String(v));
}

export async function createGrpcMock(o: GrpcMockOptions): Promise<GrpcMock> {
  const { grpc, loader } = await libs();
  const base = o.baseDir ?? process.cwd();
  const files = (Array.isArray(o.proto) ? o.proto : [o.proto]).map((p) => resolve(base, p));
  const def = loader.loadSync(files, { ...LOAD_OPTS, includeDirs: (o.includeDirs ?? []).map((d) => resolve(base, d)) }) as Record<string, Any>;
  const server = new grpc.Server();
  const calls: GrpcMock['calls'] = [];
  const statusOf = (s: string | number | undefined) => (typeof s === 'number' ? s : s ? (grpc.status as Record<string, number>)[s.toUpperCase()] ?? grpc.status.UNKNOWN : grpc.status.OK);
  const services = new Map<string, Record<string, Any>>();
  for (const key of Object.keys(o.responses)) {
    const { service, method } = splitMethod(key);
    if (!def[service]?.[method]) throw new EzTestError(`gRPC mock: ${key} is not in the proto files`, 'GRPC_METHOD');
    (services.get(service) ?? services.set(service, {}).get(service)!)[method] = o.responses[key];
  }
  for (const [service, methods] of services) {
    const handlers: Record<string, Any> = {};
    for (const [method, responses] of Object.entries(methods)) {
      const md = def[service][method];
      const pick = (req: unknown) => (responses as GrpcMockResponse[]).find((r) => matches(req, r.when));
      if (md.responseStream) {
        handlers[method] = async (call: Any) => {
          calls.push({ method: `${service}/${method}`, request: call.request });
          const r = pick(call.request);
          if (r?.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
          if (!r || (r.status !== undefined && statusOf(r.status) !== grpc.status.OK)) {
            call.emit('error', { code: r ? statusOf(r.status) : grpc.status.UNIMPLEMENTED, details: r?.message ?? `no mock response for ${service}/${method}` });
            return;
          }
          for (const item of r.stream ?? (r.response !== undefined ? [r.response] : [])) call.write(item);
          call.end();
        };
      } else {
        handlers[method] = async (call: Any, cb: Any) => {
          calls.push({ method: `${service}/${method}`, request: call.request });
          const r = pick(call.request);
          if (r?.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
          if (!r) return cb({ code: grpc.status.UNIMPLEMENTED, details: `no mock response for ${service}/${method} matching the request` });
          const code = statusOf(r.status);
          if (code !== grpc.status.OK) return cb({ code, details: r.message ?? '' });
          cb(null, r.response ?? {});
        };
      }
    }
    server.addService(def[service], handlers);
  }
  const port: number = await new Promise((res, rej) => server.bindAsync(`${o.host ?? '127.0.0.1'}:${o.port ?? 0}`, grpc.ServerCredentials.createInsecure(), (e: Error | null, p: number) => (e ? rej(e) : res(p))));
  return {
    address: `${o.host ?? '127.0.0.1'}:${port}`, port, calls,
    close: () => new Promise<void>((r) => server.tryShutdown(() => r())),
  };
}
