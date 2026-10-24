/**
 * EZTest's own WebSocket client (src/browser/transport/websocket.ts, used by
 * WsClient, the websocket steps and load tests) against a local RFC 6455
 * server that checks what arrives: handshake headers (Authorization,
 * cookies), subprotocols, a client certificate (mTLS), a CONNECT proxy,
 * ping / pong both ways, binary messages and close codes. The journey test
 * connects "using role" with a token from the identity vault.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { WsClient } from '../../src/surfaces/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { flattenStepResults } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { stepToText } from '../../src/intent/index.js';
import { startMockOidc, type MockOidc } from '../server/mock-oidc.js';
import { hasOpenssl, makeTestPki, startConnectProxy, startWsServer, type TestPki } from '../support/ws-server.js';

describe('WebSocket client: headers, subprotocols, binary, ping/pong, close', () => {
  let srv: Awaited<ReturnType<typeof startWsServer>>;
  beforeAll(async () => {
    srv = await startWsServer({
      protocols: ['chat.v2', 'graphql-transport-ws'],
      authorize: (req) => (req.url?.startsWith('/secure') && req.headers.authorization !== 'Bearer tok-123' ? 401 : undefined),
      onConnection: (c) => {
        c.send(JSON.stringify({ type: 'welcome', cookie: c.req.headers.cookie ?? null, tenant: c.req.headers['x-tenant'] ?? null, protocol: c.protocol }));
        c.onmessage = (data, binary) => {
          const text = data.toString();
          if (binary) return c.sendBinary(Buffer.from([...data].reverse()));
          if (text === 'ping-me') return c.ping(Buffer.from('srv-ping'));
          if (text === 'bye') return c.close(4001, 'done here');
          c.send(`echo:${text}`);
        };
      },
    });
  });
  afterAll(() => srv.close());

  it('sends custom headers and cookies on the handshake and negotiates a subprotocol', async () => {
    const c = await WsClient.connect(`${srv.url}/secure`, { headers: { Authorization: 'Bearer tok-123', Cookie: 'session=abc; theme=dark', 'X-Tenant': 'eu' }, protocols: ['graphql-transport-ws'] });
    const w = (await c.waitForMessage(() => true, 2000)).json();
    expect(w).toEqual({ type: 'welcome', cookie: 'session=abc; theme=dark', tenant: 'eu', protocol: 'graphql-transport-ws' });
    expect(c.protocol).toBe('graphql-transport-ws');
    const up = srv.upgrades.at(-1)!;
    expect(up.headers['sec-websocket-version']).toBe('13');
    expect(up.headers['sec-websocket-extensions']).toBeUndefined(); // no compression offered
    await c.close();
  });

  it('refusals are reported: a 401 handshake, and a server that picks no offered subprotocol', async () => {
    await expect(WsClient.connect(`${srv.url}/secure`, { headers: { Authorization: 'Bearer wrong' } })).rejects.toMatchObject({ code: 'WS_CONNECT', message: expect.stringMatching(/HTTP 401 \(the server refused the credentials/) });
    await expect(WsClient.connect(srv.url, { protocols: ['mqtt'] })).rejects.toThrow(/accepted none of the subprotocols mqtt/);
  });

  it('binary messages, pings both ways (round-trip times), and the server\'s close code and reason', async () => {
    const c = await WsClient.connect(srv.url);
    await c.waitForMessage(() => true, 2000);
    c.send(Uint8Array.from([1, 2, 3, 250]));
    const bin = await c.waitForMessage((m) => m.binary, 2000);
    expect(Array.from(bin.data as Uint8Array)).toEqual([250, 3, 2, 1]);
    c.ping();
    c.send('ping-me'); // the server pings us; the client answers with a pong
    await c.waitForMessage(() => false, 300).catch(() => undefined);
    expect(c.pingRoundTrips.length).toBe(1);
    c.send('bye');
    await new Promise((r) => setTimeout(r, 200));
    expect(c.isOpen).toBe(false);
    expect(c.closeInfo).toEqual({ code: 4001, reason: 'done here' });
    await expect(c.waitForMessage(() => true, 100)).rejects.toThrow(/closed/);
  });

  it('a keep-alive ping notices a server that stopped answering', async () => {
    const dead = await startWsServer({ ignorePings: true, onConnection: () => undefined });
    try {
      const c = await WsClient.connect(dead.url, { pingIntervalMs: 100 });
      await new Promise((r) => setTimeout(r, 450));
      expect(c.isOpen).toBe(false);
      expect(c.closeInfo?.reason).toBe('no pong from the server');
    } finally {
      await dead.close();
    }
  });
});

describe.skipIf(!hasOpenssl())('WebSocket client: client certificates and a proxy', () => {
  let pki: TestPki;
  let srv: Awaited<ReturnType<typeof startWsServer>>;
  beforeAll(async () => {
    pki = makeTestPki();
    srv = await startWsServer({ tls: { key: pki.serverKey, cert: pki.serverCert, ca: pki.ca, requestCert: true }, onConnection: (c) => c.send(`hello ${c.clientCertCn}`) });
  });
  afterAll(() => srv.close());

  it('wss:// with a client certificate (mTLS) and a private CA; without the certificate the server refuses', async () => {
    const c = await WsClient.connect(srv.url, { tls: { ca: pki.ca, cert: pki.clientCert, key: pki.clientKey } });
    expect((await c.waitForMessage(() => true, 2000)).text).toBe('hello eztest-ws-client');
    await c.close();
    await expect(WsClient.connect(srv.url, { tls: { ca: pki.ca }, timeoutMs: 3000 })).rejects.toThrow(/WebSocket connect failed/);
    await expect(WsClient.connect(srv.url, { tls: { cert: pki.clientCert, key: pki.clientKey }, timeoutMs: 3000 })).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
  });

  it('through an HTTP CONNECT proxy (explicit, and from HTTPS_PROXY), TLS end to end', async () => {
    const proxy = await startConnectProxy('ez:proxy-pw');
    try {
      const c = await WsClient.connect(srv.url, { proxy: { url: proxy.url }, tls: { ca: pki.ca, cert: pki.clientCert, key: pki.clientKey } });
      expect((await c.waitForMessage(() => true, 2000)).text).toBe('hello eztest-ws-client');
      await c.close();
      expect(proxy.seen).toEqual([`CONNECT 127.0.0.1:${srv.port}`]);
      const names = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
      const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
      for (const n of names) delete process.env[n];
      process.env.HTTPS_PROXY = proxy.url;
      try {
        const e = await WsClient.connect(srv.url, { tls: { ca: pki.ca, cert: pki.clientCert, key: pki.clientKey } });
        await e.waitForMessage(() => true, 2000);
        await e.close();
        expect(proxy.seen.length).toBe(2);
        // NO_PROXY exempts the host: no tunnel
        process.env.NO_PROXY = '127.0.0.1';
        const d = await WsClient.connect(srv.url, { tls: { ca: pki.ca, cert: pki.clientCert, key: pki.clientKey } });
        await d.close();
        expect(proxy.seen.length).toBe(2);
      } finally {
        for (const n of names) {
          if (saved[n] === undefined) delete process.env[n];
          else process.env[n] = saved[n];
        }
      }
      await expect(WsClient.connect(srv.url, { proxy: { url: proxy.url.replace('proxy-pw', 'bad') }, tls: { ca: pki.ca } })).rejects.toThrow(/proxy authentication required/);
    } finally {
      await proxy.close();
    }
  });
});

describe('websocket steps: using role, headers, protocol', () => {
  let idp: MockOidc;
  let srv: Awaited<ReturnType<typeof startWsServer>>;
  beforeAll(async () => {
    idp = await startMockOidc({ sub: 'x' }, { audience: 'quotes-api' });
    idp.registerClient('quotes-client', { secret: 'quotes-secret' });
    srv = await startWsServer({
      protocols: ['quotes.v1'],
      authorize: (req) => {
        const tok = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
        return tok && idp.claims(tok).aud === 'quotes-api' ? undefined : 401;
      },
      onConnection: (c) => {
        c.onmessage = (d) => c.send(JSON.stringify({ quote: d.toString(), tenant: c.req.headers['x-tenant'], protocol: c.protocol }));
      },
    });
  });
  afterAll(async () => {
    await srv.close();
    await idp.close();
  });

  it('parses and renders the options', () => {
    const j = parseEzScript('Journey: w\nConnect to websocket "/quotes" as feed using role trader with headers "X-Tenant" = "eu", "Cookie" = "a=1" with protocol "quotes.v1" with ping every 15 s\n');
    expect(j.steps[0].args).toEqual({ op: 'connect', url: '/quotes', socket: 'feed', asRole: 'trader', headers: { 'X-Tenant': 'eu', Cookie: 'a=1' }, protocols: ['quotes.v1'], pingIntervalMs: 15000 });
    expect(stepToText(j.steps[0])).toBe('Connect to websocket "/quotes" as feed using role trader with headers "X-Tenant" = "eu", "Cookie" = "a=1" with protocol "quotes.v1" with ping every 15 s');
    expect(() => parseEzScript('Journey: w\nConnect to websocket "/q" as feed with magic on\n')).toThrow(/Unknown websocket option/);
  });

  it('a journey connects with a bearer token for the role, sends and waits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-ws-'));
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
      outputDir: 'results', healing: { enabled: false },
      identity: { roles: { trader: { api: { tokenUrl: `${idp.issuer}/token`, clientId: 'quotes-client', clientSecret: 'quotes-secret' } } } },
    }));
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    const engine = await createEngine(loaded, { cwd: dir });
    try {
      const run = await engine.run([parseEzScript(`Journey: Quotes feed
Connect to websocket "${srv.url}/quotes" as feed using role trader with headers "X-Tenant" = "eu" with protocol "quotes.v1"
Send "ACME" on websocket feed
Wait for a websocket message containing "ACME" on feed and store it as q
Expect \${q.tenant} equals "eu"
Expect \${q.protocol} equals "quotes.v1"
Close websocket feed
`)]);
      const j = run.journeys[0];
      expect(j.status, flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status} ${s.error?.message ?? ''}`).join('\n')).toBe('passed');
      expect(idp.tokenRequests.at(-1)).toMatchObject({ grant_type: 'client_credentials', client_id: 'quotes-client' });
    } finally {
      await engine.close();
    }
  }, 60_000);
});
