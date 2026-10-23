/**
 * Infrastructure monitors on the load test's timeline: host (this machine
 * or a remote EZTest host agent), JVM, databases and HTTP endpoint health.
 * Each monitor samples on its interval; every point carries the second of
 * the test it belongs to, so the report and the analysis line monitors up
 * with throughput, latency and active VUs.
 */
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { EzTestError } from '../../core/index.js';
import { connectDb, type DbClient } from '../../surfaces/db.js';
import type { MonitorSpec, Scenario } from '../model.js';
import { resolveConnection } from '../data.js';
import { HostMonitor } from './host.js';
import { JvmMonitor } from './jvm.js';
import { DbMonitor } from './db.js';

export interface MonitorPoint {
  t: number;
  at: number;
  values: Record<string, number>;
}

export interface MonitorSeries {
  name: string;
  type: MonitorSpec['type'];
  target?: string;
  points: MonitorPoint[];
  errors: string[];
  /** Latest top SQL (DB monitors). */
  topSql?: Array<{ sql: string; executions: number; totalMs: number; avgMs: number }>;
}

type Sampler = () => Promise<{ values: Record<string, number>; topSql?: MonitorSeries['topSql']; errors?: string[] }>;

export class MonitorRunner {
  readonly series: MonitorSeries[] = [];
  private timers: NodeJS.Timeout[] = [];
  private closers: Array<() => Promise<void>> = [];
  private startedAt = Date.now();
  private stopped = false;
  private readonly inflight = new Set<Promise<void>>();

  constructor(readonly specs: MonitorSpec[], private readonly scenario: Pick<Scenario, 'connections' | 'baseDir'>) {}

  async start(startedAt = Date.now()): Promise<void> {
    this.startedAt = startedAt;
    for (const spec of this.specs) {
      const s: MonitorSeries = { name: spec.name ?? defaultName(spec), type: spec.type, target: targetOf(spec), points: [], errors: [] };
      this.series.push(s);
      let sampler: Sampler;
      try {
        sampler = await this.samplerFor(spec);
      } catch (e) {
        s.errors.push((e as Error).message);
        continue;
      }
      let busy: Promise<void> | undefined;
      const tick = async () => {
        if (this.stopped || busy) return; // a slow sample is not overlapped by the next one
        busy = sample().finally(() => {
          this.inflight.delete(busy!);
          busy = undefined;
        });
        this.inflight.add(busy);
        await busy;
      };
      const sample = async () => {
        try {
          const r = await sampler();
          const at = Date.now();
          if (Object.keys(r.values).length) s.points.push({ t: Math.max(0, Math.floor((at - this.startedAt) / 1000)), at, values: r.values });
          else if (!(r.errors ?? []).length && s.errors.length < 20 && !s.errors.includes('a sample returned no values')) s.errors.push('a sample returned no values');
          if (r.topSql) s.topSql = r.topSql;
          for (const e of r.errors ?? []) if (s.errors.length < 20 && !s.errors.includes(e)) s.errors.push(e);
        } catch (e) {
          if (s.errors.length < 20) s.errors.push((e as Error).message);
        }
      };
      void tick();
      this.timers.push(setInterval(() => void tick(), spec.intervalMs));
    }
  }

  private async samplerFor(spec: MonitorSpec): Promise<Sampler> {
    switch (spec.type) {
      case 'host': {
        if (spec.url) {
          const url = spec.url.replace(/\/+$/, '');
          return async () => {
            const r = await fetch(`${url}/metrics`, { headers: spec.token ? { authorization: `Bearer ${spec.token}` } : {}, signal: AbortSignal.timeout(5000) });
            if (!r.ok) throw new EzTestError(`host agent ${url}: HTTP ${r.status}`, 'LOAD_MONITOR');
            return { values: ((await r.json()) as { values: Record<string, number> }).values };
          };
        }
        const m = new HostMonitor({ processes: spec.processes });
        await m.sample();
        return async () => ({ values: await m.sample() });
      }
      case 'jvm': {
        const m = new JvmMonitor({ pid: spec.pid, jstat: spec.jstat, jcmd: spec.jcmd });
        return async () => ({ values: await m.sample() });
      }
      case 'db': {
        const c = this.scenario.connections[spec.connection];
        if (!c) throw new EzTestError(`db monitor: unknown connection "${spec.connection}"`, 'LOAD_SCENARIO');
        const db: DbClient = await connectDb(`monitor:${spec.connection}`, resolveConnection(c, this.scenario.baseDir));
        this.closers.push(() => db.close());
        const m = new DbMonitor(db, { topSql: spec.topSql });
        await m.sample();
        return async () => m.sample();
      }
      case 'http':
        return async () => {
          const t0 = performance.now();
          try {
            const r = await fetch(spec.url, { signal: AbortSignal.timeout(spec.timeoutMs), redirect: 'manual' });
            await r.arrayBuffer();
            return { values: { up: r.status === spec.expectStatus ? 1 : 0, status: r.status, responseMs: Math.round((performance.now() - t0) * 10) / 10 } };
          } catch {
            return { values: { up: 0, status: 0, responseMs: Math.round((performance.now() - t0) * 10) / 10 } };
          }
        };
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // samples in flight belong to the test: let them land (bounded)
    await Promise.race([Promise.all([...this.inflight]), new Promise((r) => setTimeout(r, 5000))]);
    for (const c of this.closers) await c().catch(() => undefined);
    this.closers = [];
  }

  latest(): Array<{ name: string; type: string; values: Record<string, number>; t?: number }> {
    return this.series.map((s) => ({ name: s.name, type: s.type, values: s.points[s.points.length - 1]?.values ?? {}, t: s.points[s.points.length - 1]?.t }));
  }
}

function defaultName(spec: MonitorSpec): string {
  switch (spec.type) {
    case 'host':
      return spec.url ? `host ${new URL(spec.url).host}` : `host ${spec.name}`;
    case 'jvm':
      return `jvm ${spec.pid}`;
    case 'db':
      return `db ${spec.connection}`;
    case 'http':
      return `http ${spec.url}`;
  }
}

function targetOf(spec: MonitorSpec): string | undefined {
  if (spec.type === 'http') return spec.url;
  if (spec.type === 'db') return spec.connection;
  if (spec.type === 'host') return spec.url ?? 'local';
  return String(spec.pid);
}

/**
 * The host agent (`eztest load monitor-agent`): serves this machine's host
 * metrics (and JVM metrics by pid) to a controller. Bearer token required.
 */
export async function startMonitorAgent(o: { port: number; host?: string; token: string; processes?: string[] }): Promise<{ url: string; close(): Promise<void>; server: Server }> {
  if (!o.token || o.token.length < 16) throw new EzTestError('monitor agent: a token of at least 16 characters is required', 'LOAD_MONITOR');
  const host = new HostMonitor({ processes: o.processes });
  await host.sample();
  const jvms = new Map<string, JvmMonitor>();
  const expected = Buffer.from(`Bearer ${o.token}`);
  const server = createServer(async (req, res) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      let body: unknown;
      if (url.pathname === '/metrics') body = { values: await host.sample(), at: Date.now() };
      else if (url.pathname === '/jvm' && url.searchParams.get('pid')) {
        const pid = url.searchParams.get('pid')!;
        let m = jvms.get(pid);
        if (!m) jvms.set(pid, (m = new JvmMonitor({ pid })));
        body = { values: await m.sample(), at: Date.now() };
      } else if (url.pathname === '/healthz') body = { status: 'ok' };
      else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((r) => server.listen(o.port, o.host ?? '0.0.0.0', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://${o.host && o.host !== '0.0.0.0' ? o.host : '127.0.0.1'}:${port}`, server, close: () => new Promise((r) => server.close(() => r())) };
}

export { HostMonitor } from './host.js';
export { JvmMonitor, parseJstatGcutil, parseHeapInfo, countThreads } from './jvm.js';
export { DbMonitor } from './db.js';
