/**
 * The virtual-user engine's protocols and options: HTTP/2 (h2c and TLS
 * with ALPN), TLS client certificates, cookies, Basic, Digest, NTLMv2 and
 * OAuth 2 authentication, network emulation (latency, bandwidth, loss),
 * WebSocket, SSE, gRPC, SQL and messaging users, data policies, think time,
 * pacing, conditions and loops.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { createGrpcMock, type GrpcMock } from '../../src/integration/index.js';
import { HttpClient, LoadTest, ntlmType2, ntowfv2, parseNtlmType3, DataPool, type LoadResults } from '../../src/load/index.js';
import { scenario } from './helpers.js';

const listen = (s: Server | http2.Http2Server | https.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const close = (s: { close(cb: () => void): void; closeAllConnections?: () => void }) => new Promise<void>((r) => {
  s.closeAllConnections?.();
  s.close(() => r());
});
const run = (s: Parameters<typeof scenario>[0], dir?: string): Promise<LoadResults> => new LoadTest(scenario(s, dir), { monitors: false }).run();

describe('HTTP/2 and TLS', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ez-load-tls-'));
    const ossl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=EZ Test CA']);
    ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
    await writeFile(join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    ossl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'san.ext']);
    ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=vu-client']);
    ossl(['x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '2']);
  });

  it('speaks HTTP/2 with prior knowledge (h2c) and over TLS with ALPN, presenting a client certificate', async () => {
    const h2c = http2.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ v: req.httpVersion, path: req.url }));
    });
    const p1 = await listen(h2c);
    const seen: string[] = [];
    const tls = http2.createSecureServer({ key: await readFile(join(dir, 'server.key')), cert: await readFile(join(dir, 'server.pem')), ca: await readFile(join(dir, 'ca.pem')), requestCert: true, rejectUnauthorized: true, allowHTTP1: true }, (req, res) => {
      seen.push(`${req.httpVersion}:${(req.socket as unknown as { getPeerCertificate(): { subject?: { CN?: string } } }).getPeerCertificate().subject?.CN}`);
      res.end('ok');
    });
    const p2 = await listen(tls);
    try {
      const c = new HttpClient({ http: '2', keepAlive: true, maxConnectionsPerHost: 6, timeoutMs: 5000, followRedirects: true, maxRedirects: 3, userAgent: 'x' });
      const r = await c.request({ method: 'GET', url: `http://127.0.0.1:${p1}/a?b=1` });
      expect(r.protocol).toBe('h2');
      expect(JSON.parse(r.body.toString()).v).toBe('2.0');
      const again = await c.request({ method: 'GET', url: `http://127.0.0.1:${p1}/b` });
      expect(again.reused).toBe(true);
      c.close();
      const res = await run({
        userPaths: { p: { actions: [{ request: { name: 'tls', url: `https://localhost:${p2}/x` } }] } },
        profile: { type: 'constant', vus: 2, duration: '1s' },
        options: { http: 'auto', tls: { cert: 'client.pem', key: 'client.key', ca: 'ca.pem' } },
      }, dir);
      expect(res.totals.errors).toBe(0);
      expect(res.totals.requests).toBeGreaterThan(4);
      expect(seen.every((s) => s === '2.0:vu-client')).toBe(true);
      // without the client certificate the server refuses
      const bad = await run({ userPaths: { p: { actions: [{ request: { url: `https://localhost:${p2}/x` } }] } }, profile: { type: 'constant', vus: 1, duration: '300ms' }, options: { http: '1.1', tls: { ca: 'ca.pem' } } }, dir);
      expect(bad.totals.errors).toBeGreaterThan(0);
    } finally {
      await close(h2c);
      await close(tls);
    }
  }, 60_000);
});

describe('authentication', () => {
  let srv: Server;
  let base: string;
  const nonces = new Map<string, number>();
  const ntlmChallenges = new Map<unknown, Buffer>();
  let ntlmOk = 0;
  beforeAll(async () => {
    srv = createServer(async (req: IncomingMessage, res) => {
      const auth = req.headers.authorization ?? '';
      const url = new URL(req.url ?? '/', 'http://x');
      const deny = (h: Record<string, string>) => {
        res.writeHead(401, h);
        res.end();
      };
      if (url.pathname === '/basic') {
        return auth === `Basic ${Buffer.from('ann:s3cret').toString('base64')}` ? res.end('ok') : deny({ 'www-authenticate': 'Basic realm="x"' });
      }
      if (url.pathname === '/digest') {
        const m = /^Digest (.*)$/.exec(auth);
        if (!m) {
          const nonce = randomBytes(8).toString('hex');
          nonces.set(nonce, 0);
          return deny({ 'www-authenticate': `Digest realm="ez", qop="auth", nonce="${nonce}", opaque="op1", algorithm=SHA-256` });
        }
        const f = Object.fromEntries([...m[1].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((x) => [x[1], x[2] ?? x[3]]));
        const H = (s: string) => createHash('sha256').update(s).digest('hex');
        const want = H(`${H(`ann:ez:s3cret`)}:${f.nonce}:${f.nc}:${f.cnonce}:auth:${H(`${req.method}:${f.uri}`)}`);
        const lastNc = nonces.get(f.nonce);
        if (lastNc === undefined || parseInt(f.nc, 16) <= lastNc || f.response !== want || f.opaque !== 'op1') return deny({ 'www-authenticate': 'Digest realm="ez", qop="auth", nonce="x", stale=true' });
        nonces.set(f.nonce, parseInt(f.nc, 16));
        return res.end('ok');
      }
      if (url.pathname === '/ntlm') {
        const m = /^NTLM (.+)$/.exec(auth);
        const b = m ? Buffer.from(m[1], 'base64') : undefined;
        if (!b) return deny({ 'www-authenticate': 'NTLM' });
        if (b.readUInt32LE(8) === 1) {
          const ch = randomBytes(8);
          ntlmChallenges.set(req.socket, ch);
          return deny({ 'www-authenticate': `NTLM ${ntlmType2(ch, Buffer.from([2, 0, 4, 0, 0x45, 0, 0x5a, 0, 0, 0, 0, 0]))}` });
        }
        const t3 = parseNtlmType3(m![1]);
        const ch = ntlmChallenges.get(req.socket);
        const key = ntowfv2('Pa55w0rd', t3.user, t3.domain);
        const proof = createHmac('md5', key).update(Buffer.concat([ch ?? Buffer.alloc(8), t3.nt.subarray(16)])).digest();
        if (!ch || !proof.equals(t3.nt.subarray(0, 16)) || t3.user !== 'ann' || t3.domain !== 'EZ') return deny({ 'www-authenticate': 'NTLM' });
        ntlmOk++;
        return res.end('ok');
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const p = new URLSearchParams(body);
        if (p.get('client_id') !== 'cid' || p.get('client_secret') !== 'csec') return deny({});
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ access_token: 'tok-123', expires_in: 600 }));
      }
      if (url.pathname === '/api') return auth === 'Bearer tok-123' ? res.end('ok') : deny({});
      if (url.pathname === '/setcookie') {
        res.setHeader('set-cookie', ['sid=abc; Path=/', 'gone=1; Max-Age=0']);
        return res.end('set');
      }
      if (url.pathname === '/needcookie') return req.headers.cookie === 'sid=abc' ? res.end('ok') : deny({});
      res.writeHead(404);
      res.end();
    });
    base = `http://127.0.0.1:${await listen(srv)}`;
  });
  afterAll(() => close(srv));

  const one = (url: string, auth?: Record<string, unknown>) => run({ baseUrl: base, userPaths: { p: { actions: [{ request: { url } }], ...(auth ? { auth } : {}) } } as never, profile: { type: 'constant', vus: 2, duration: '700ms' } });

  it('Basic, Digest (SHA-256, qop=auth, nonce counting), NTLMv2 and OAuth 2 client credentials', async () => {
    for (const [url, auth] of [
      ['/basic', { type: 'basic', username: 'ann', password: 's3cret' }],
      ['/digest', { type: 'digest', username: 'ann', password: 's3cret' }],
      ['/ntlm', { type: 'ntlm', username: 'ann', password: 'Pa55w0rd', domain: 'EZ' }],
      ['/api', { type: 'oauth2', tokenUrl: `${base}/token`, clientId: 'cid', clientSecret: 'csec' }],
    ] as const) {
      const r = await one(url, auth);
      expect({ url, errors: r.totals.errors, samples: r.errors.samples.map((s) => s.message) }).toEqual({ url, errors: 0, samples: [] });
      expect(r.totals.requests).toBeGreaterThan(3);
    }
    expect(ntlmOk).toBeGreaterThan(3);
    const wrong = await one('/basic', { type: 'basic', username: 'ann', password: 'nope' });
    expect(wrong.errors.byType['HTTP 401']).toBeGreaterThan(0);
  });

  it('keeps cookies per virtual user', async () => {
    const r = await run({ baseUrl: base, userPaths: { p: { init: [{ request: { url: '/setcookie' } }], actions: [{ request: { name: 'with cookie', url: '/needcookie' } }] } }, profile: { type: 'constant', vus: 3, duration: '600ms' } });
    expect(r.totals.errors).toBe(0);
    expect(r.names.find((n) => n.name === 'with cookie')!.count).toBeGreaterThan(3);
  });
});

describe('network emulation (EZTest connection shaper)', () => {
  let srv: Server;
  let base: string;
  beforeAll(async () => {
    const big = Buffer.alloc(100_000, 120);
    srv = createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-length': String(big.length) });
        res.end(big);
        return;
      }
      res.end('ok');
    });
    base = `http://127.0.0.1:${await listen(srv)}`;
  });
  afterAll(() => close(srv));

  it('adds latency per round trip, caps bandwidth and delays lost packets, per population', async () => {
    const r = await run({
      baseUrl: base, options: { keepAlive: true },
      userPaths: { lan: { actions: [{ request: { name: 'lan', url: '/s' } }] }, wan: { actions: [{ request: { name: 'wan', url: '/s' } }] }, big: { actions: [{ request: { name: 'big', url: '/big' } }] } },
      populations: [
        { name: 'lan', userPath: 'lan', share: 50, profile: { type: 'constant', vus: 4, duration: '2s' } },
        { name: 'wan', userPath: 'wan', share: 25, network: { latencyMs: 120 }, profile: { type: 'constant', vus: 8, duration: '2s' } },
        { name: 'dsl', userPath: 'big', share: 25, network: { latencyMs: 20, downloadKbps: 800 }, profile: { type: 'constant', vus: 4, duration: '2500ms' } },
      ],
    });
    expect(r.totals.errors).toBe(0);
    const lan = r.names.find((n) => n.name === 'lan')!;
    const wan = r.names.find((n) => n.name === 'wan')!;
    expect(lan.latency.p50).toBeLessThan(30);
    // a keep-alive request is one round trip: +120 ms (the first one also pays the TCP handshake)
    expect(wan.latency.min).toBeGreaterThanOrEqual(118);
    expect(wan.latency.p50).toBeLessThan(200);
    // 100 KB at 800 kbit/s is at least 1 s
    const big = r.names.find((n) => n.name === 'big')!;
    expect(big.latency.min).toBeGreaterThanOrEqual(950);
    const lossy = await run({ baseUrl: base, userPaths: { p: { actions: [{ request: { name: 'lossy', url: '/big' } }] } }, populations: [{ name: 'lossy', userPath: 'p', network: { latencyMs: 10, lossPercent: 10 }, profile: { type: 'constant', vus: 2, duration: '1500ms' } }] });
    // ~70 segments of 1460 bytes at 10% loss: practically every response waits for at least one 200 ms retransmission
    expect(lossy.names.find((n) => n.name === 'lossy')!.latency.p50).toBeGreaterThanOrEqual(200);
  }, 30_000);
});

describe('WebSocket, SSE, gRPC, SQL and messaging users', () => {
  let demo: DemoServer;
  let sse: Server;
  let sseUrl: string;
  let grpc: GrpcMock;
  let dir: string;
  beforeAll(async () => {
    demo = await startDemoApp();
    sse = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(`event: tick\ndata: {"n":${n},"status":"${n >= 3 ? 'done' : 'working'}"}\n\n`);
        if (n >= 3) {
          clearInterval(t);
          res.end();
        }
      }, 20);
      req.on('close', () => clearInterval(t));
    });
    sseUrl = `http://127.0.0.1:${await listen(sse)}`;
    dir = await mkdtemp(join(tmpdir(), 'ez-load-proto-'));
    await writeFile(join(dir, 'orders.proto'), 'syntax = "proto3";\npackage shop;\nservice Orders { rpc Get (GetOrder) returns (Order); }\nmessage GetOrder { int32 id = 1; }\nmessage Order { int32 id = 1; string status = 2; }\n');
    grpc = await createGrpcMock({ proto: 'orders.proto', baseDir: dir, responses: { 'shop.Orders/Get': [{ when: { id: 7 }, response: { id: 7, status: 'SHIPPED' } }, { status: 'NOT_FOUND', message: 'no' }] } });
    const db = new DatabaseSync(join(dir, 'shop.db'));
    db.exec('CREATE TABLE stock (sku TEXT, qty INTEGER); INSERT INTO stock VALUES (\'A\', 5), (\'B\', 0);');
    db.close();
  });
  afterAll(async () => {
    await demo?.close();
    await close(sse);
    await grpc?.close();
  });

  it('runs each protocol as timed requests with its own checks', async () => {
    const r = await run({
      buses: { mem: { type: 'memory' } },
      connections: { shop: { driver: 'sqlite', file: 'shop.db' } },
      userPaths: {
        p: {
          actions: [
            { ws: { name: 'ws echo', url: `${demo.url.replace('http', 'ws')}/lab/ws`, send: ['hello ${__vu}'], expect: ['welcome', 'echo: hello'] } },
            { sse: { name: 'sse until done', url: `${sseUrl}/events`, until: '"done"', extract: { var: 'last', json: '$.n' } } },
            { grpc: { name: 'grpc get', address: grpc.address, proto: 'orders.proto', method: 'shop.Orders/Get', request: { id: 7 } } },
            { sql: { name: 'sql stock', connection: 'shop', sql: 'SELECT qty FROM stock WHERE sku = ?', params: ['A'], captureAs: 'stock', minRows: 1 } },
            { if: { cond: 'stock.qty > 0 and last == 3', then: [{ message: { name: 'publish order', bus: 'mem', publish: { type: 'queue', destination: 'orders', payload: '{"vu":${__vu},"iter":${__iter}}' }, consume: { type: 'queue', destination: 'orders', contains: '"vu"' } } }], else: [{ grpc: { name: 'never', address: grpc.address, proto: 'orders.proto', method: 'shop.Orders/Get', request: { id: 1 } } }] } },
            { loop: { times: 2, actions: [{ set: { looped: 'yes ${__loop}' } }] } },
          ],
        },
      },
      profile: { type: 'constant', vus: 2, duration: '1500ms' },
    }, dir);
    expect(r.errors.samples).toEqual([]);
    for (const name of ['ws echo', 'sse until done', 'grpc get', 'sql stock', 'publish order']) expect(r.names.find((n) => n.name === name)?.count ?? 0).toBeGreaterThan(1);
    expect(r.names.find((n) => n.name === 'never')).toBeUndefined();
    expect(grpc.calls.every((c) => (c.request as { id: number }).id === 7)).toBe(true);
    // a gRPC status other than the expected one is an error with its own type
    const bad = await run({ userPaths: { p: { actions: [{ grpc: { name: 'missing', address: grpc.address, proto: 'orders.proto', method: 'shop.Orders/Get', request: { id: 1 } } }] } }, profile: { type: 'constant', vus: 1, duration: '300ms' } }, dir);
    expect(Object.keys(bad.errors.byType)).toContain('GRPC_NOT_FOUND');
  }, 60_000);
});

describe('parameterization, think time and pacing', () => {
  let srv: Server;
  let base: string;
  const seen: string[] = [];
  beforeAll(async () => {
    srv = createServer((req, res) => {
      seen.push(new URL(req.url ?? '/', 'http://x').searchParams.get('u') ?? '');
      res.end('ok');
    });
    base = `http://127.0.0.1:${await listen(srv)}`;
  });
  afterAll(() => close(srv));

  it('hands rows out by policy: unique per VU, per iteration, random; exhaustion stops VUs', async () => {
    const pool = new DataPool('d', [{ a: '1' }, { a: '2' }], { order: 'unique', scope: 'iteration', onExhausted: 'error' });
    expect([pool.take().a, pool.take().a]).toEqual(['1', '2']);
    expect(() => pool.take()).toThrow(/exhausted/);
    seen.length = 0;
    const rows = Array.from({ length: 5 }, (_, i) => ({ u: `user${i}` }));
    const r = await run({
      baseUrl: base,
      data: { users: { rows, order: 'unique', scope: 'vu', onExhausted: 'stopVu' } },
      userPaths: { p: { data: ['users'], actions: [{ request: { url: '/?u=${users.u}' } }] } },
      profile: { type: 'constant', vus: 8, duration: '800ms' },
    });
    // 5 unique rows for 8 VUs: 5 VUs run, 3 stop at start; every VU kept its own row
    expect(new Set(seen)).toEqual(new Set(rows.map((x) => x.u)));
    expect(r.totals.errors).toBe(0);
    seen.length = 0;
    await run({ baseUrl: base, data: { ids: { rows, order: 'sequential', scope: 'iteration' } }, userPaths: { p: { data: ['ids'], actions: [{ request: { url: '/?u=${ids.u}' } }] } }, profile: { type: 'constant', vus: 1, duration: '400ms' } });
    expect(seen.slice(0, 7)).toEqual(['user0', 'user1', 'user2', 'user3', 'user4', 'user0', 'user1']);
  });

  it('applies think times and pacing', async () => {
    const r = await run({ baseUrl: base, userPaths: { p: { actions: [{ request: { url: '/a' } }, { request: { url: '/b' } }], thinkTime: '200ms', pacing: '500ms' } }, profile: { type: 'constant', vus: 2, duration: '2s' } });
    const it = r.names.find((n) => n.kind === 'iteration')!;
    // pacing 500 ms per VU over 2 s: 4 iterations each
    expect(it.count).toBeGreaterThanOrEqual(7);
    expect(it.count).toBeLessThanOrEqual(10);
    expect(it.latency.p50).toBeGreaterThanOrEqual(200);
  });
});
