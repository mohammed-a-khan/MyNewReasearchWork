/**
 * Infrastructure monitors written for EZTest Load, on the load test's
 * timeline: the host (this machine, and a remote host agent), a JVM
 * (jstat/jcmd, when a JDK is installed), HTTP endpoint health, and
 * databases (Oracle and SQL Server live when the ez-oracle / ez-mssql
 * containers or EZTEST_ORACLE_URL / EZTEST_MSSQL_URL are available;
 * PostgreSQL's queries against a recording client).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DbMonitor, HostMonitor, LoadTest, parseDiskstats, parseHeapInfo, parseJstatGcutil, parseMeminfo, parseNetDev, parseProcStat, parseTypeperf, renderLoadReport, startMonitorAgent, countThreads,
} from '../../src/load/index.js';
import type { DbClient } from '../../src/surfaces/db.js';
import { loadMssql, mssqlEnv, oracleEnv } from '../surfaces/db-env.js';
import { scenario } from './helpers.js';

const portOpen = (port: number) => new Promise<boolean>((r) => {
  const s = connect({ host: '127.0.0.1', port }, () => {
    s.destroy();
    r(true);
  });
  s.on('error', () => r(false));
  s.setTimeout(1000, () => {
    s.destroy();
    r(false);
  });
});

describe('host metrics parsers', () => {
  it('parses /proc and typeperf output', () => {
    expect(parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3')).toEqual({ idle: 850, total: 1000 });
    expect(parseMeminfo('MemTotal:       16000000 kB\nMemFree:  1000 kB\nMemAvailable:    4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB')).toMatchObject({ totalKb: 16000000, availableKb: 4000000 });
    const d = parseDiskstats('   8       0 sda 100 0 2048 50 200 0 4096 80 0 300 130 0 0 0 0\n   8       1 sda1 1 0 8 1 1 0 8 1 0 1 1 0 0 0 0\n   7       0 loop0 1 0 2 0 0 0 0 0 0 0 0 0 0 0 0');
    expect(d).toEqual({ read: 2048 * 512, write: 4096 * 512, ticks: 300, devices: 1 });
    expect(parseNetDev('Inter-|   Receive\n face |bytes\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0')).toEqual({ rx: 1000, tx: 2000 });
    expect(parseTypeperf('"(PDH-CSV 4.0)","\\\\HOST\\Processor(_Total)\\% Processor Time","\\\\HOST\\Memory\\% Committed Bytes In Use"\n"10/23/2026 10:00:00.000","37.5","61.25"\n')).toEqual({ '\\Processor(_Total)\\% Processor Time': 37.5, '\\Memory\\% Committed Bytes In Use': 61.25 });
    expect(parseJstatGcutil('  S0     S1     E      O      M     CCS    YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT\n  0.00 100.00  42.86  13.21  97.31  91.27      3     0.012     0     0.000     2     0.003     0.015\n')).toMatchObject({ E: 42.86, O: 13.21, YGC: 3, FGC: 0 });
    expect(parseHeapInfo(' garbage-first heap   total 262144K, used 23456K [0x...]\n Metaspace       used 7000K, committed 7300K')).toEqual({ totalKb: 262144, usedKb: 23456, metaUsedKb: 7000 });
    expect(countThreads('"main" #1 prio=5\n   java.lang.Thread.State: RUNNABLE\n"Reference Handler" #2 daemon\n')).toBe(2);
  });

  it('samples this host (CPU after two samples, memory, load, network) and named processes', async () => {
    const m = new HostMonitor({ processes: ['node'] });
    await m.sample();
    await new Promise((r) => setTimeout(r, 300));
    const v = await m.sample();
    if (process.platform === 'linux') {
      expect(v.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(v.cpuPercent).toBeLessThanOrEqual(100);
      expect(v.memUsedPercent).toBeGreaterThan(0);
      expect(v.netRxKBps).toBeGreaterThanOrEqual(0);
      expect(v['proc.node.count']).toBeGreaterThanOrEqual(1);
      expect(v['proc.node.rssMb']).toBeGreaterThan(10);
    }
  });
});

describe('monitors on the load timeline', () => {
  let srv: Server;
  let base: string;
  let agent: Awaited<ReturnType<typeof startMonitorAgent>>;
  let jvm: ChildProcess | undefined;
  const hasJava = spawnSync('jstat', ['-help'], { stdio: 'ignore' }).status === 0 || spawnSync('jstat', ['-options'], { stdio: 'ignore' }).status === 0;
  beforeAll(async () => {
    srv = createServer((req, res) => setTimeout(() => res.end('ok'), 3));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    agent = await startMonitorAgent({ port: 0, host: '127.0.0.1', token: 'monitor-token-0123456789', processes: ['node'] });
    if (hasJava) {
      const dir = await mkdtemp(join(tmpdir(), 'ez-jvm-'));
      await writeFile(join(dir, 'Busy.java'), 'public class Busy { public static void main(String[] a) throws Exception { java.util.List<byte[]> l = new java.util.ArrayList<>(); for (int i = 0; i < 600; i++) { l.add(new byte[100_000]); if (l.size() > 50) l.clear(); Thread.sleep(50); } } }');
      jvm = spawn('java', ['-Xmx128m', join(dir, 'Busy.java')], { stdio: 'ignore' });
      // wait until jcmd lists it
      for (let i = 0; i < 60; i++) {
        const r = spawnSync('jcmd', ['-l'], { encoding: 'utf8' });
        if (r.stdout?.includes('Busy')) break;
        await new Promise((res) => setTimeout(res, 500));
      }
    }
  }, 60_000);
  afterAll(async () => {
    jvm?.kill();
    await agent?.close();
    await new Promise<void>((r) => {
      srv.closeAllConnections();
      srv.close(() => r());
    });
  });

  it('the remote host agent requires its token', async () => {
    expect((await fetch(`${agent.url}/metrics`)).status).toBe(401);
    const r = await fetch(`${agent.url}/metrics`, { headers: { authorization: 'Bearer monitor-token-0123456789' } });
    expect(r.status).toBe(200);
    expect(Object.keys(((await r.json()) as { values: Record<string, number> }).values)).toContain('memUsedPercent');
  });

  it('records host (local and remote), JVM and HTTP health on the same seconds as the load', async () => {
    const monitors: unknown[] = [
      { type: 'host', name: 'generator', processes: ['node'], intervalMs: 500 },
      { type: 'host', name: 'remote', url: agent.url, token: 'monitor-token-0123456789', intervalMs: 500 },
      { type: 'http', name: 'health', url: `${base}/health`, intervalMs: 500 },
    ];
    if (hasJava) monitors.push({ type: 'jvm', name: 'app jvm', pid: 'Busy', intervalMs: 700 });
    const r = await new LoadTest(scenario({ baseUrl: base, userPaths: { p: { actions: [{ request: { url: '/x' } }], thinkTime: '10ms' } }, profile: { type: 'ramp', vus: 6, rampUp: '2s', plateau: '4s' }, monitors: monitors as never })).run();
    const by = (n: string) => r.monitors.find((m) => m.name === n)!;
    const tMax = r.timeline[r.timeline.length - 1].t;
    for (const name of ['generator', 'remote', 'health']) {
      const s = by(name);
      expect({ name, errors: s.errors }).toEqual({ name, errors: [] });
      expect(s.points.length).toBeGreaterThanOrEqual(2);
      expect(s.points.every((p) => p.t >= 0 && p.t <= tMax + 1)).toBe(true);
    }
    expect(by('generator').points.some((p) => p.values.cpuPercent !== undefined)).toBe(true);
    expect(by('health').points.every((p) => p.values.up === 1)).toBe(true);
    if (hasJava) {
      const j = by('app jvm');
      expect(j.errors).toEqual([]);
      expect(j.points.length).toBeGreaterThanOrEqual(2);
      expect(j.points[j.points.length - 1].values.heapUsedMb).toBeGreaterThan(0);
      expect(j.points[j.points.length - 1].values.threads).toBeGreaterThan(3);
    }
    const html = renderLoadReport(r);
    expect(html).toContain('Monitor: generator');
    expect(html).toContain('Monitor: health');
  }, 60_000);
});

describe('database monitors', () => {
  it('PostgreSQL: sessions, waits, throughput and top SQL from pg_stat views', async () => {
    const queries: string[] = [];
    let counter = 1000;
    const fake: DbClient = {
      name: 'pg', dialect: 'postgres',
      async query(sql: string) {
        queries.push(sql);
        if (/pg_stat_activity WHERE backend_type/.test(sql)) return [{ total: '12', active: '3' }];
        if (/wait_event_type AS wclass/.test(sql)) return [{ wclass: 'Lock', wait_now: '2000' }];
        if (/pg_stat_database/.test(sql)) return [{ counter: String((counter += 50)) }];
        if (/pg_stat_statements/.test(sql)) return [{ sql_text: 'SELECT  * FROM orders WHERE id = $1', executions: '100', total_ms: '250' }];
        return [];
      },
      execute: async () => ({ rowsAffected: 0 }),
      transaction: async (fn) => fn(fake),
      close: async () => undefined,
    } as DbClient;
    const m = new DbMonitor(fake, { topSql: 3 });
    await m.sample();
    await new Promise((r) => setTimeout(r, 200));
    const s = await m.sample();
    expect(s.values).toMatchObject({ sessions: 12, activeSessions: 3, 'wait.Lock': 2000 });
    expect(s.values.throughputPerSec).toBeGreaterThan(100);
    expect(s.topSql[0]).toEqual({ sql: 'SELECT * FROM orders WHERE id = $1', executions: 100, totalMs: 250, avgMs: 2.5 });
  });

  // The monitor needs dictionary access (V$ views): EZTEST_ORACLE_MONITOR_URL, else the ez-oracle container's
  // SYSTEM account (docs/databases.md). The application user (EZTEST_ORACLE_URL) usually lacks it: then the
  // monitor must say so instead of producing no points silently.
  const oraUrl = (u: string) => {
    const x = new URL(u);
    return { host: x.hostname, port: Number(x.port || 1521), serviceName: decodeURIComponent(x.pathname.replace(/^\//, '')), user: decodeURIComponent(x.username), password: decodeURIComponent(x.password) };
  };
  const app = oracleEnv() ?? { host: '127.0.0.1', port: 1521, serviceName: 'FREEPDB1', user: 'eztest', password: 'EzTest_1' };
  const monitorUser = process.env.EZTEST_ORACLE_MONITOR_URL ? oraUrl(process.env.EZTEST_ORACLE_MONITOR_URL) : { host: app.host, port: app.port, serviceName: app.serviceName, user: 'system', password: 'EzOracle_1' };
  const oraConn = (c: typeof app) => ({ driver: 'oracle', host: c.host, port: c.port, serviceName: c.serviceName, user: c.user, password: c.password });
  it('Oracle (ez-oracle): sessions, wait classes and top SQL on the timeline', async (ctx) => {
    if (!(await portOpen(app.port))) return ctx.skip();
    const r = await new LoadTest(scenario({
      connections: { ora: oraConn(app), mon: oraConn(monitorUser) },
      userPaths: { p: { actions: [{ sql: { name: 'ora query', connection: 'ora', sql: 'SELECT COUNT(*) AS n FROM all_objects WHERE ROWNUM <= 500' } }], thinkTime: '50ms' } },
      profile: { type: 'constant', vus: 3, duration: '4s' },
      monitors: [{ type: 'db', name: 'oracle', connection: 'mon', intervalMs: 1000, topSql: 5 }],
    })).run();
    const m = r.monitors.find((x) => x.name === 'oracle')!;
    expect(r.names.find((n) => n.name === 'ora query')!.count).toBeGreaterThan(5);
    expect(m.errors).toEqual([]);
    expect(m.points.length).toBeGreaterThanOrEqual(2);
    expect(m.points[m.points.length - 1].values.sessions).toBeGreaterThan(0);
    expect(m.topSql?.length).toBeGreaterThan(0);
  }, 90_000);

  it('Oracle: a monitoring user without dictionary access is reported, not silent', async (ctx) => {
    if (!(await portOpen(app.port))) return ctx.skip();
    const r = await new LoadTest(scenario({
      connections: { ora: { ...oraConn(app), user: 'eztest', password: process.env.EZTEST_ORACLE_URL ? app.password : 'EzTest_1' } },
      userPaths: { p: { actions: [{ think: '100ms' }, { sql: { name: 'q', connection: 'ora', sql: 'SELECT 1 AS n FROM dual' } }] } },
      profile: { type: 'constant', vus: 1, duration: '2s' },
      monitors: [{ type: 'db', name: 'unprivileged', connection: 'ora', intervalMs: 1000 }],
    })).run();
    const m = r.monitors.find((x) => x.name === 'unprivileged')!;
    if (m.points.length) return ctx.skip(); // this user was granted dictionary access
    expect(m.errors[0]).toMatch(/cannot read the oracle statistics views: grant it SELECT_CATALOG_ROLE/);
    expect(m.errors.some((e) => /ORA-00942/.test(e))).toBe(true);
  }, 60_000);

  const ms = mssqlEnv() ?? { server: '127.0.0.1', port: 1433, database: 'master', user: 'sa', password: 'EzSql_Pass1', driverPath: process.env.EZTEST_MSSQL_DRIVER };
  it('SQL Server (ez-mssql): sessions, waits, batch requests and top SQL on the timeline', async (ctx) => {
    if (!(await portOpen(ms.port))) return ctx.skip();
    const driver = await loadMssql(ms.driverPath);
    if (!driver) {
      console.warn('[eztest] SQL Server monitor test skipped: the mssql package is not installed (EZTEST_MSSQL_DRIVER)');
      return ctx.skip();
    }
    const r = await new LoadTest(scenario({
      connections: { ms: { driver: 'mssql', server: ms.server, port: ms.port, database: ms.database, user: ms.user, password: ms.password, encrypt: true, trustServerCertificate: true, driverModule: driver } },
      userPaths: { p: { actions: [{ sql: { name: 'ms query', connection: 'ms', sql: 'SELECT COUNT(*) AS n FROM sys.objects' } }], thinkTime: '50ms' } },
      profile: { type: 'constant', vus: 3, duration: '4s' },
      monitors: [{ type: 'db', name: 'sqlserver', connection: 'ms', intervalMs: 1000, topSql: 5 }],
    })).run();
    const m = r.monitors.find((x) => x.name === 'sqlserver')!;
    expect(m.errors).toEqual([]);
    expect(m.points.length).toBeGreaterThanOrEqual(2);
    const last = m.points[m.points.length - 1].values;
    expect(last.sessions).toBeGreaterThan(0);
    expect(last.throughputPerSec).toBeGreaterThan(0);
    expect(Object.keys(last).some((k) => k.startsWith('wait.'))).toBe(true);
    expect(m.topSql?.length).toBeGreaterThan(0);
  }, 90_000);
});

