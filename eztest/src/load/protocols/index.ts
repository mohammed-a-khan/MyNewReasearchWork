/**
 * Non-HTTP virtual-user actions: WebSocket, Server-Sent Events, gRPC
 * (EZTest's gRPC client), SQL (EZTest's database drivers) and messaging
 * (EZTest's bus drivers). Each returns an outcome the VU times and records.
 */
import http from 'node:http';
import https from 'node:https';
import { EzTestError } from '../../core/index.js';
import { WsClient } from '../../surfaces/ws.js';
import { GrpcServiceClient } from '../../integration/grpc.js';
import { BrokerSchema } from '../../integration/config.js';
import { createBusDriver } from '../../integration/runtime.js';
import type { BusDriver } from '../../integration/bus/types.js';
import { connectDb, type DbClient } from '../../surfaces/db.js';
import { queryPath } from '../../surfaces/jsonpath.js';
import type { Action } from '../model.js';
import { resolveConnection } from '../data.js';
import { render, renderDeep, type TemplateScope } from '../template.js';

export interface ProtocolOutcome {
  ok: boolean;
  errorType?: string;
  message?: string;
  bytesIn: number;
  bytesOut: number;
  vars?: Array<[string, unknown]>;
}

/** Process-wide clients shared by VUs (database pools, buses, gRPC channels). */
export class ProtocolPools {
  private readonly dbs = new Map<string, Promise<DbClient>>();
  private readonly buses = new Map<string, BusDriver>();
  private readonly grpc = new Map<string, GrpcServiceClient>();

  constructor(private readonly o: { connections: Record<string, Record<string, unknown>>; buses: Record<string, Record<string, unknown>>; baseDir: string }) {}

  db(name: string): Promise<DbClient> {
    let p = this.dbs.get(name);
    if (!p) {
      const c = this.o.connections[name];
      if (!c) throw new EzTestError(`unknown connection "${name}"`, 'LOAD_SCENARIO');
      p = connectDb(name, resolveConnection(c, this.o.baseDir));
      this.dbs.set(name, p);
    }
    return p;
  }

  bus(name: string): BusDriver {
    let d = this.buses.get(name);
    if (!d) {
      const raw = this.o.buses[name];
      if (!raw) throw new EzTestError(`unknown bus "${name}"`, 'LOAD_SCENARIO');
      d = createBusDriver(name, BrokerSchema.parse(raw), this.o.baseDir);
      this.buses.set(name, d);
    }
    return d;
  }

  grpcClient(address: string, proto: string | string[], tls?: boolean): GrpcServiceClient {
    const key = `${address}|${String(proto)}|${tls ? 1 : 0}`;
    let c = this.grpc.get(key);
    if (!c) {
      c = new GrpcServiceClient(address, { address, proto, tls }, this.o.baseDir);
      this.grpc.set(key, c);
    }
    return c;
  }

  async close(): Promise<void> {
    for (const p of this.dbs.values()) await p.then((d) => d.close()).catch(() => undefined);
    for (const b of this.buses.values()) await b.close().catch(() => undefined);
    for (const g of this.grpc.values()) g.close();
    this.dbs.clear();
    this.buses.clear();
    this.grpc.clear();
  }
}

const fail = (errorType: string, message: string, bytesIn = 0, bytesOut = 0): ProtocolOutcome => ({ ok: false, errorType, message, bytesIn, bytesOut });

export async function runWs(spec: Extract<Action, { kind: 'ws' }>['spec'], scope: TemplateScope, timeoutDefault: number): Promise<ProtocolOutcome> {
  const timeout = spec.timeoutMs ?? timeoutDefault;
  let ws: WsClient;
  try {
    ws = await WsClient.connect(render(spec.url, scope), { timeoutMs: timeout });
  } catch (e) {
    return fail('WS_CONNECT', (e as Error).message);
  }
  let out = 0;
  let inn = 0;
  try {
    for (const m of spec.send ?? []) {
      const t = render(m, scope);
      out += Buffer.byteLength(t);
      ws.send(t);
    }
    for (const want of spec.expect ?? []) {
      const w = render(want, scope);
      const m = await ws.waitForMessage((x) => x.text.includes(w), timeout).catch(() => undefined);
      if (!m) return fail('WS_EXPECT', `no WebSocket message containing "${w.slice(0, 60)}" within ${timeout} ms`, inn, out);
      inn += Buffer.byteLength(m.text);
    }
    return { ok: true, bytesIn: inn, bytesOut: out };
  } finally {
    await ws.close().catch(() => undefined);
  }
}

export function runSse(spec: Extract<Action, { kind: 'sse' }>['spec'], scope: TemplateScope, timeoutDefault: number, headers: Record<string, string> = {}): Promise<ProtocolOutcome> {
  const url = new URL(render(spec.url, scope));
  const timeout = spec.timeoutMs ?? timeoutDefault;
  const until = spec.until !== undefined ? render(spec.until, scope) : undefined;
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let bytes = 0;
    let events = 0;
    let buf = '';
    let settled = false;
    const finish = (o: ProtocolOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(o);
    };
    const req = mod.request(url, { headers: { accept: 'text/event-stream', ...headers, ...Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, render(v, scope)])) } }, (res) => {
      if ((res.statusCode ?? 0) >= 400) return finish(fail(`HTTP ${res.statusCode}`, `SSE ${url.pathname} returned ${res.statusCode}`));
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        buf += chunk;
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data && !/^event:/m.test(block)) continue;
          events++;
          let vars: Array<[string, unknown]> | undefined;
          if (spec.extract) {
            let v: unknown;
            if (spec.extract.json) {
              try {
                v = queryPath(JSON.parse(data), spec.extract.json)[0];
              } catch {
                v = undefined;
              }
            } else if (spec.extract.regex) v = new RegExp(spec.extract.regex).exec(data)?.[1];
            else v = data;
            if (v !== undefined) vars = [[spec.extract.var, v]];
          }
          if ((until !== undefined && data.includes(until)) || (spec.maxEvents !== undefined && events >= spec.maxEvents) || (until === undefined && spec.maxEvents === undefined)) {
            return finish({ ok: true, bytesIn: bytes, bytesOut: 0, vars });
          }
        }
      });
      res.on('end', () => finish(until !== undefined ? fail('SSE_EXPECT', `stream ended before an event containing "${until}"`, bytes) : { ok: true, bytesIn: bytes, bytesOut: 0 }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => finish(fail(e.code ?? 'NETWORK', e.message, bytes)));
    const timer = setTimeout(() => finish(fail('TIMEOUT', `SSE: no matching event within ${timeout} ms`, bytes)), timeout);
    req.end();
  });
}

export async function runGrpc(spec: Extract<Action, { kind: 'grpc' }>['spec'], scope: TemplateScope, pools: ProtocolPools, timeoutDefault: number): Promise<ProtocolOutcome> {
  const c = pools.grpcClient(render(spec.address, scope), spec.proto, spec.tls);
  const request = renderDeep(spec.request ?? {}, scope);
  const r = await c.call(spec.method, request, { metadata: spec.metadata ? Object.fromEntries(Object.entries(spec.metadata).map(([k, v]) => [k, render(v, scope)])) : undefined, timeoutMs: spec.timeoutMs ?? timeoutDefault });
  const size = Buffer.byteLength(JSON.stringify(r.response ?? null));
  if (r.status !== spec.expectStatus) return fail(`GRPC_${r.status}`, `${spec.method} returned ${r.status}${r.details ? `: ${r.details}` : ''}`, size, Buffer.byteLength(JSON.stringify(request)));
  return { ok: true, bytesIn: size, bytesOut: Buffer.byteLength(JSON.stringify(request)), vars: [[`${spec.name ?? 'grpc'}_response`, r.response]] };
}

export async function runSql(spec: Extract<Action, { kind: 'sql' }>['spec'], scope: TemplateScope, pools: ProtocolPools): Promise<ProtocolOutcome> {
  const db = await pools.db(spec.connection);
  const params = (spec.params ?? []).map((p) => (typeof p === 'string' ? render(p, scope) : p));
  const rows = await db.query(spec.sql, params);
  if (spec.minRows !== undefined && rows.length < spec.minRows) return fail('SQL_ROWS', `query returned ${rows.length} row(s), expected at least ${spec.minRows}`);
  const vars: Array<[string, unknown]> = [];
  if (spec.captureAs && rows[0]) for (const [k, v] of Object.entries(rows[0])) vars.push([`${spec.captureAs}.${k}`, v]);
  if (spec.captureAs) vars.push([spec.captureAs, rows[0] ?? {}], [`${spec.captureAs}_count`, rows.length]);
  return { ok: true, bytesIn: Buffer.byteLength(JSON.stringify(rows)), bytesOut: Buffer.byteLength(spec.sql), vars };
}

export async function runMessage(spec: Extract<Action, { kind: 'message' }>['spec'], scope: TemplateScope, pools: ProtocolPools, timeoutDefault: number): Promise<ProtocolOutcome> {
  const d = pools.bus(spec.bus);
  let out = 0;
  let inn = 0;
  const c = spec.consume;
  const sub = c ? await d.subscribe({ type: c.type, name: render(c.destination, scope) }, { fromTimestamp: Date.now() - 1000 }) : undefined;
  try {
    if (spec.publish) {
      const p = spec.publish;
      const payload = render(p.payload, scope);
      out += Buffer.byteLength(payload);
      await d.publish({ type: p.type, name: render(p.destination, scope), ...(p.routingKey ? { routingKey: render(p.routingKey, scope) } : {}) }, { payload, ...(p.key ? { key: render(p.key, scope) } : {}), headers: p.headers });
    }
    if (c && sub) {
      const want = c.contains !== undefined ? render(c.contains, scope) : undefined;
      const m = await sub.next((x) => (want === undefined ? true : x.payload.includes(want)), c.timeoutMs ?? timeoutDefault);
      if (!m) return fail('MESSAGE_TIMEOUT', `no message${want ? ` containing "${want}"` : ''} on ${c.destination}`, inn, out);
      inn += Buffer.byteLength(m.payload);
      return { ok: true, bytesIn: inn, bytesOut: out, vars: [[`${spec.name ?? 'message'}_payload`, m.payload]] };
    }
    return { ok: true, bytesIn: inn, bytesOut: out };
  } finally {
    await sub?.close().catch(() => undefined);
  }
}
