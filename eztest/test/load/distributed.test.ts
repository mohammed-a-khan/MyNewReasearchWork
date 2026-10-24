/**
 * Distributed EZTest Load: a controller and two load generators.
 * - in process: exact merges (counts, histograms), unique data slices,
 *   zone populations, live control, token authentication, mutual TLS;
 * - as local processes started through the CLI (`eztest load agent`);
 * - in Docker (the slim agent image), when Docker is available;
 * - merged results published to the results server (src/server).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LoadController, startAgent, writeLoadRun, type LoadResults } from '../../src/load/index.js';
import { ResultsClient } from '../../src/server/client.js';
import { startTestServer } from '../server/helpers.js';
import { scenario } from './helpers.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';

let srv: Server;
let base: string;
const hits: Array<{ user: string | null; agentPort: number }> = [];
beforeAll(async () => {
  srv = createServer((req, res) => {
    hits.push({ user: new URL(req.url ?? '/', 'http://x').searchParams.get('u'), agentPort: req.socket.remotePort ?? 0 });
    setTimeout(() => res.end('ok'), 5);
  });
  srv.keepAliveTimeout = 30_000;
  await new Promise<void>((r) => srv.listen(0, '0.0.0.0', () => r()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => {
  srv.closeAllConnections();
  srv.close(() => r());
}));

const users = Array.from({ length: 10 }, (_, i) => ({ u: `u${i}` }));
const shopScenario = (o: { vus?: number; duration?: string; target?: string } = {}) => scenario({
  name: 'distributed', baseUrl: o.target ?? base,
  data: { users: { rows: users, order: 'unique', scope: 'vu', onExhausted: 'stopVu' } },
  userPaths: {
    shop: { data: ['users'], actions: [{ transaction: { name: 'browse', actions: [{ request: { name: 'home', url: '/?u=${users.u}' } }] } }], thinkTime: '20ms' },
    api: { actions: [{ request: { name: 'api', url: '/api' } }], thinkTime: '20ms' },
  },
  populations: [
    { name: 'shoppers', userPath: 'shop', share: 60 },
    { name: 'eu-api', userPath: 'api', share: 40, zone: 'eu' },
  ],
  profile: { type: 'constant', vus: o.vus ?? 10, duration: o.duration ?? '3s' },
  sla: [{ match: 'home', kind: 'request', p95: { fail: 1000 }, errorRate: { fail: 0.01 } }],
});

describe('controller + 2 agents in process', () => {
  it('splits the load, slices unique data, routes zones, merges exactly and obeys live control', async () => {
    hits.length = 0;
    const c = new LoadController(shopScenario({ vus: 10 }), { agents: 2, listen: '127.0.0.1:0', token: TOKEN, startDelayMs: 500 });
    await c.listen();
    const a1 = startAgent({ controller: `127.0.0.1:${c.port}`, token: TOKEN, id: 'a1', zone: 'eu', once: true });
    const a2 = startAgent({ controller: `127.0.0.1:${c.port}`, token: TOKEN, id: 'a2', zone: 'us', once: true });
    let added = false;
    c.on('point', (p) => {
      if (!added && p.t >= 1) {
        added = true;
        c.addVus(2, 'shoppers');
      }
    });
    const r = await c.run();
    await Promise.all([a1.done, a2.done]);
    await c.close();
    expect(r.agents.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(r.totals.errors).toBe(0);
    // shoppers 6 VUs over two agents (3 + 3), eu-api 4 VUs only on the eu agent; +2 shoppers live
    const a1s = r.agents.find((a) => a.id === 'a1')!;
    const a2s = r.agents.find((a) => a.id === 'a2')!;
    expect(a1s.vus).toBeGreaterThanOrEqual(7);
    expect(a2s.vus).toBeLessThanOrEqual(4);
    expect(r.totals.maxVus).toBe(12);
    // exact merge: per-agent request counts add up to the merged totals and to what the server saw
    expect(a1s.requests + a2s.requests).toBe(r.totals.requests);
    expect(r.timeline.reduce((a, p) => a + p.requests, 0)).toBe(r.totals.requests);
    expect(hits.length).toBe(r.totals.requests);
    // unique rows: each shopper VU kept one row, and no row was used by two VUs (on either agent)
    const rowsUsed = new Set(hits.filter((h) => h.user).map((h) => h.user));
    expect(rowsUsed.size).toBeLessThanOrEqual(8);
    expect(rowsUsed.size).toBeGreaterThanOrEqual(6);
    expect(r.names.find((n) => n.name === 'api')!.count).toBeGreaterThan(10);
    expect(r.sla.status).toBe('pass');
  }, 60_000);

  it('agents with 2 generator threads each: the same split, exact merge and live control', async () => {
    hits.length = 0;
    const c = new LoadController(shopScenario({ vus: 10 }), { agents: 2, listen: '127.0.0.1:0', token: TOKEN, startDelayMs: 1500 });
    await c.listen();
    const a1 = startAgent({ controller: `127.0.0.1:${c.port}`, token: TOKEN, id: 'a1', zone: 'eu', once: true, generators: 2 });
    const a2 = startAgent({ controller: `127.0.0.1:${c.port}`, token: TOKEN, id: 'a2', zone: 'us', once: true, generators: 2 });
    let added = false;
    c.on('point', (p) => {
      if (!added && p.t >= 1) {
        added = true;
        c.addVus(2, 'shoppers');
      }
    });
    const r = await c.run();
    await Promise.all([a1.done, a2.done]);
    await c.close();
    expect(r.totals.errors).toBe(0);
    // shoppers 6 VUs over 4 generator threads (1 + 1 + 2 + 2), eu-api 4 on the eu agent's two threads; +2 shoppers live
    expect(r.totals.maxVus).toBe(12);
    const a1s = r.agents.find((a) => a.id === 'a1')!;
    const a2s = r.agents.find((a) => a.id === 'a2')!;
    expect(a1s.requests + a2s.requests).toBe(r.totals.requests);
    expect(r.timeline.reduce((a, p) => a + p.requests, 0)).toBe(r.totals.requests);
    expect(hits.length).toBe(r.totals.requests);
    const rowsUsed = new Set(hits.filter((h) => h.user).map((h) => h.user));
    expect(rowsUsed.size).toBeLessThanOrEqual(8);
    expect(rowsUsed.size).toBeGreaterThanOrEqual(6);
    expect(r.sla.status).toBe('pass');
  }, 60_000);

  it('rejects an agent with a wrong token', async () => {
    const c = new LoadController(shopScenario({ duration: '1s' }), { agents: 1, listen: '127.0.0.1:0', token: TOKEN, waitMs: 1500 });
    await c.listen();
    const bad = startAgent({ controller: `127.0.0.1:${c.port}`, token: 'wrong-token-0123456789', once: true, connectTimeoutMs: 2000 });
    await expect(c.run()).rejects.toThrow(/0 of 1 agent/);
    await expect(bad.done).rejects.toThrow();
    await c.close();
    expect(() => new LoadController(shopScenario(), { agents: 1 })).toThrow(/token or mutual TLS/);
  }, 20_000);

  it('authenticates agents with mutual TLS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-mtls-'));
    const ossl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=EZ Load CA']);
    for (const n of ['controller', 'agent']) {
      ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', `/CN=${n === 'controller' ? 'localhost' : 'agent-1'}`]);
      await writeFile(join(dir, `${n}.ext`), n === 'controller' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' : 'extendedKeyUsage=clientAuth\n');
      ossl(['x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${n}.pem`, '-days', '2', '-extfile', `${n}.ext`]);
    }
    const c = new LoadController(shopScenario({ vus: 2, duration: '1s' }), { agents: 1, listen: '127.0.0.1:0', tls: { cert: join(dir, 'controller.pem'), key: join(dir, 'controller.key'), ca: join(dir, 'ca.pem'), requireClientCert: true }, startDelayMs: 300 });
    await c.listen();
    const noCert = startAgent({ controller: `localhost:${c.port}`, tls: { ca: join(dir, 'ca.pem') }, once: true, connectTimeoutMs: 1000 });
    await expect(noCert.done).rejects.toThrow();
    const a = startAgent({ controller: `localhost:${c.port}`, tls: { ca: join(dir, 'ca.pem'), cert: join(dir, 'agent.pem'), key: join(dir, 'agent.key') }, once: true });
    const r = await c.run();
    await a.done;
    await c.close();
    expect(r.totals.requests).toBeGreaterThan(5);
    expect(r.totals.errors).toBe(0);
  }, 30_000);
});

function cliAgent(port: number, id: string, zone: string): ChildProcess {
  const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
  return spawn(process.execPath, ['--import', tsx, join(ROOT, 'src/cli/bin.ts'), 'load', 'agent', '--controller', `127.0.0.1:${port}`, '--id', id, '--zone', zone, '--once'], { env: { ...process.env, EZTEST_LOAD_TOKEN: TOKEN, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
}

const exited = (p: ChildProcess) => new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', (c) => r(c))));

describe('elastic scaling hook', () => {
  it('starts its agents through the scale-up command', async () => {
    const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
    const agentCmd = `"${process.execPath}" --import ${tsx} "${join(ROOT, 'src/cli/bin.ts')}" load agent --controller 127.0.0.1:{port} --once`;
    const c = new LoadController(shopScenario({ vus: 2, duration: '1500ms' }), { agents: 1, listen: '127.0.0.1:0', token: TOKEN, waitMs: 60_000, scaleUp: agentCmd, scaleDown: 'echo done-{runId}' });
    const logs: string[] = [];
    c.on('log', (l: string) => logs.push(l));
    const r = await c.run().catch((e: Error) => {
      throw new Error(`${e.message}\n${logs.join('\n')}`);
    });
    await c.close();
    expect(r.totals.requests).toBeGreaterThan(5);
    expect(logs.some((l) => l.startsWith('scale-up hook:') && l.includes(`127.0.0.1:${c.port}`))).toBe(true);
    expect(logs.some((l) => l === `scale-down hook: echo done-${r.runId}`)).toBe(true);
  }, 120_000);
});

describe('2 agents as local processes (eztest load agent), results to the results server', () => {
  it('runs, merges and publishes the run', async () => {
    hits.length = 0;
    const c = new LoadController(shopScenario({ vus: 8, duration: '3s' }), { agents: 2, listen: '127.0.0.1:0', token: TOKEN, waitMs: 90_000 });
    await c.listen();
    const procs = [cliAgent(c.port, 'p1', 'eu'), cliAgent(c.port, 'p2', 'us')];
    let stderr = '';
    for (const p of procs) p.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    let r: LoadResults;
    try {
      r = await c.run();
    } finally {
      await c.close();
    }
    expect(await Promise.all(procs.map(exited))).toEqual([0, 0]);
    expect(r.agents.map((a) => a.id).sort()).toEqual(['p1', 'p2']);
    expect(r.totals.errors).toBe(0);
    expect(r.agents.reduce((a, x) => a + x.requests, 0)).toBe(r.totals.requests);
    expect(hits.length).toBe(r.totals.requests);
    expect(stderr).toMatch(/registered/);
    // the merged run is an EZTest run directory: verify and publish it to the results server
    const dir = await mkdtemp(join(tmpdir(), 'ez-load-pub-'));
    const w = await writeLoadRun(r, { outputDir: dir });
    const server = await startTestServer();
    try {
      const client = new ResultsClient({ url: server.url, token: await server.token('ci', [{ project: 'perf', role: 'tester' }]), project: 'perf' });
      const pub = await client.publishRun(w.runDir, { meta: { kind: 'load' } });
      expect(pub.verified).toBe(true);
      expect(pub.uploaded).toBeGreaterThanOrEqual(3);
    } finally {
      await server.close();
    }
  }, 120_000);
});

const dockerOk = (() => {
  if (process.env.EZTEST_SKIP_DOCKER === '1') return false;
  const r = spawnSync('docker', ['image', 'inspect', 'node:22-bookworm-slim'], { stdio: 'ignore' });
  return r.status === 0;
})();
if (!dockerOk) console.warn('[eztest] Docker agent test skipped: docker or the node:22-bookworm-slim image is not available');

describe.skipIf(!dockerOk)('2 agents in Docker (slim agent image)', () => {
  const tag = `eztest-load-agent:test-${process.pid}`;
  afterAll(() => {
    spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' });
  });

  it('builds the agent image and runs a distributed test with two containers', async () => {
    const ctx = await mkdtemp(join(tmpdir(), 'ez-agent-img-'));
    execFileSync(process.execPath, [join(ROOT, 'scripts/build-load-agent.mjs'), join(ctx, 'dist-load-agent')], { stdio: 'ignore' });
    expect(existsSync(join(ctx, 'dist-load-agent', 'eztest-load-agent.mjs'))).toBe(true);
    const df = await readFile(join(ROOT, 'deploy/load-agent/Dockerfile'), 'utf8');
    await writeFile(join(ctx, 'Dockerfile'), df);
    execFileSync('docker', ['build', '-q', '-t', tag, ctx], { stdio: 'ignore', timeout: 300_000 });
    hits.length = 0;
    const port = (srv.address() as { port: number }).port;
    const c = new LoadController(shopScenario({ vus: 6, duration: '3s', target: `http://127.0.0.1:${port}` }), { agents: 2, listen: '127.0.0.1:0', token: TOKEN, waitMs: 90_000 });
    await c.listen();
    const names = [`ez-agent-a-${process.pid}`, `ez-agent-b-${process.pid}`];
    const procs = names.map((n, i) => spawn('docker', ['run', '--rm', '--name', n, '--network', 'host', '-e', `EZTEST_LOAD_CONTROLLER=127.0.0.1:${c.port}`, '-e', `EZTEST_LOAD_TOKEN=${TOKEN}`, '-e', `EZTEST_LOAD_AGENT_ID=docker-${i + 1}`, '-e', `EZTEST_LOAD_ZONE=${i ? 'us' : 'eu'}`, '-e', 'EZTEST_LOAD_ONCE=1', tag], { stdio: 'ignore' }));
    let r: LoadResults;
    try {
      r = await c.run();
    } finally {
      await c.close();
      for (const n of names) spawnSync('docker', ['rm', '-f', n], { stdio: 'ignore' });
    }
    await Promise.all(procs.map(exited));
    expect(r.agents.map((a) => a.id).sort()).toEqual(['docker-1', 'docker-2']);
    expect(r.totals.errors).toBe(0);
    expect(r.totals.requests).toBeGreaterThan(50);
    expect(hits.length).toBe(r.totals.requests);
  }, 400_000);
});
