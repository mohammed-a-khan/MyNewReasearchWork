/**
 * API calls through an HTTP CONNECT proxy, with EZTest's own tunnelling on
 * Node core, against our own local proxy server: http targets in absolute
 * form, https targets through CONNECT (TLS verified end to end, client
 * certificates included), proxy credentials, NO_PROXY, and the environment's
 * HTTPS_PROXY / HTTP_PROXY / NO_PROXY for API steps, OAuth token requests and
 * Key Vault lookups.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls, { type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { ApiClient, bypassesProxy, envProxyFor } from '../../src/surfaces/index.js';
import { AzureKeyVaultSecretStore, OAuth2TokenProvider } from '../../src/identity/index.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
};

/** A minimal HTTP proxy: CONNECT tunnels and absolute-form forwarding, with optional Basic auth. */
function startProxy(auth?: string): Promise<{ port: number; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const ok = (h: string | undefined) => !auth || h === `Basic ${Buffer.from(auth).toString('base64')}`;
  const server = createHttpServer((req, res) => {
    if (!ok(req.headers['proxy-authorization'])) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="ez"' });
      res.end();
      return;
    }
    seen.push(`${req.method} ${req.url}`);
    const u = new URL(req.url!);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const up = httpRequest({ host: u.hostname, port: u.port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  server.on('connect', (req, socket, head) => {
    if (!ok(req.headers['proxy-authorization'])) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ez"\r\n\r\n');
      return;
    }
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = String(req.url).split(':');
    const up = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return listen(server).then((port) => ({ port, seen, server }));
}

describe('NO_PROXY rules', () => {
  it('matches hosts, subdomains, ports, IPs, CIDR ranges and *', () => {
    const np = 'example.com, .internal.test, *.svc.local, api.acme:8443, 10.0.0.0/8, ::1';
    expect(bypassesProxy('https://example.com/x', np)).toBe(true);
    expect(bypassesProxy('https://a.b.example.com/x', np)).toBe(true);
    expect(bypassesProxy('https://notexample.com/x', np)).toBe(false);
    expect(bypassesProxy('https://internal.test/x', np)).toBe(false);
    expect(bypassesProxy('https://db.internal.test/x', np)).toBe(true);
    expect(bypassesProxy('http://x.svc.local/', np)).toBe(true);
    expect(bypassesProxy('https://api.acme:8443/', np)).toBe(true);
    expect(bypassesProxy('https://api.acme/', np)).toBe(false);
    expect(bypassesProxy('http://10.20.30.40/', np)).toBe(true);
    expect(bypassesProxy('http://11.0.0.1/', np)).toBe(false);
    expect(bypassesProxy('http://[::1]:8080/', np)).toBe(true);
    expect(bypassesProxy('https://anything/', '*')).toBe(true);
    expect(envProxyFor('https://svc.example/', { HTTPS_PROXY: 'http://p:3128' })).toEqual({ url: 'http://p:3128' });
    expect(envProxyFor('http://svc.example/', { https_proxy: 'http://p:3128' })).toBeUndefined();
    expect(envProxyFor('https://svc.example/', { HTTPS_PROXY: 'http://p:3128', NO_PROXY: 'svc.example' })).toBeUndefined();
  });
});

describe.skipIf(!hasOpenssl())('API calls through an HTTP CONNECT proxy', () => {
  let dir: string;
  let plain: Server;
  let secure: Server;
  let mutual: Server;
  let httpUrl: string;
  let httpsUrl: string;
  let mtlsUrl: string;
  let pfx: Buffer;
  const defaultCAs = tls.getCACertificates('default');
  const saved: Record<string, string | undefined> = {};
  const ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eztest-proxy-'));
    const o = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=EZTest Proxy Test CA');
    writeFileSync(join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
    o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
    o('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext');
    o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=ez-proxy-client');
    o('x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '2');
    o('pkcs12', '-export', '-inkey', 'client.key', '-in', 'client.pem', '-out', 'client.p12', '-passout', 'pass:p12pass');
    pfx = readFileSync(join(dir, 'client.p12'));
    const ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    tls.setDefaultCACertificates([...defaultCAs, ca]);
    const handler = (label: string) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/final' });
          res.end();
          return;
        }
        if (req.url?.startsWith('/oauth/token')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 }));
          return;
        }
        if (req.url?.startsWith('/secrets/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ value: `vault:${req.headers.authorization}` }));
          return;
        }
        const cn = (req.socket as TLSSocket).getPeerCertificate?.()?.subject?.CN;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ via: label, path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), ...(cn ? { cn } : {}) }));
      });
    };
    plain = createHttpServer(handler('http'));
    secure = createHttpsServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')) }, handler('https'));
    mutual = createHttpsServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')), ca, requestCert: true, rejectUnauthorized: true }, handler('mtls'));
    httpUrl = `http://127.0.0.1:${await listen(plain)}`;
    httpsUrl = `https://127.0.0.1:${await listen(secure)}`;
    mtlsUrl = `https://127.0.0.1:${await listen(mutual)}`;
    for (const k of ENV) saved[k] = process.env[k];
  });

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    tls.setDefaultCACertificates(defaultCAs);
    for (const s of [plain, secure, mutual]) await new Promise<void>((r) => s.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends http requests to the proxy in absolute form and https requests through a CONNECT tunnel', async () => {
    const p = await startProxy();
    try {
      const api = new ApiClient({ proxy: `http://127.0.0.1:${p.port}`, retry: false });
      const h = await api.post(`${httpUrl}/orders?x=1`, { json: { id: 7 } });
      expect(h.body).toMatchObject({ via: 'http', path: '/orders?x=1', method: 'POST', body: '{"id":7}' });
      const s = await api.get(`${httpsUrl}/secure`);
      expect(s.body).toMatchObject({ via: 'https', path: '/secure' });
      const r = await api.get(`${httpsUrl}/redirect`);
      expect(r.body).toMatchObject({ path: '/final' });
      const port = new URL(httpsUrl).port;
      expect(p.seen).toEqual([`POST ${httpUrl}/orders?x=1`, `CONNECT 127.0.0.1:${port}`, `CONNECT 127.0.0.1:${port}`, `CONNECT 127.0.0.1:${port}`]);
    } finally {
      p.server.close();
    }
  });

  it('presents a client certificate through the tunnel (mTLS end to end)', async () => {
    const p = await startProxy();
    try {
      const api = new ApiClient({ proxy: `http://127.0.0.1:${p.port}`, retry: false, clientCertificates: [{ origin: mtlsUrl, pfx, passphrase: 'p12pass' }] });
      expect((await api.get(`${mtlsUrl}/who`)).body).toMatchObject({ via: 'mtls', cn: 'ez-proxy-client' });
      expect(p.seen).toEqual([`CONNECT 127.0.0.1:${new URL(mtlsUrl).port}`]);
    } finally {
      p.server.close();
    }
  });

  it('authenticates to the proxy with the credentials in its URL, and says so when they are missing', async () => {
    const p = await startProxy('ez user:pa ss');
    try {
      const good = new ApiClient({ proxy: `http://${encodeURIComponent('ez user')}:${encodeURIComponent('pa ss')}@127.0.0.1:${p.port}`, retry: false });
      expect((await good.get(`${httpsUrl}/a`)).status).toBe(200);
      expect((await good.get(`${httpUrl}/b`)).status).toBe(200);
      const bad = new ApiClient({ proxy: `http://127.0.0.1:${p.port}`, retry: false });
      await expect(bad.get(`${httpsUrl}/a`)).rejects.toThrow(/refused to open a tunnel to 127\.0\.0\.1:\d+: proxy authentication required/);
      expect((await bad.get(`${httpUrl}/b`)).status).toBe(407);
    } finally {
      p.server.close();
    }
  });

  it('NO_PROXY hosts and proxy: false go direct', async () => {
    const p = await startProxy();
    try {
      const api = new ApiClient({ proxy: { url: `http://127.0.0.1:${p.port}`, noProxy: '127.0.0.1' }, retry: false });
      expect((await api.get(`${httpsUrl}/direct`)).body).toMatchObject({ via: 'https' });
      process.env.HTTPS_PROXY = `http://127.0.0.1:${p.port}`;
      process.env.NO_PROXY = '';
      process.env.no_proxy = '';
      expect((await new ApiClient({ proxy: false, retry: false }).get(`${httpsUrl}/direct`)).status).toBe(200);
      expect(p.seen).toEqual([]);
    } finally {
      p.server.close();
    }
  });

  it('honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY of the environment for API steps, OAuth tokens and Key Vault', async () => {
    const p = await startProxy();
    try {
      for (const k of ENV) delete process.env[k];
      process.env.HTTPS_PROXY = `http://127.0.0.1:${p.port}`;
      process.env.HTTP_PROXY = `http://127.0.0.1:${p.port}`;
      process.env.NO_PROXY = 'nothing.example';
      const api = new ApiClient({ retry: false });
      await api.get(`${httpsUrl}/env`);
      await api.get(`${httpUrl}/env-plain`);
      const oauth = new OAuth2TokenProvider({ tokenUrl: `${httpsUrl}/oauth/token`, clientId: 'c', clientSecret: 's' });
      expect(await oauth.getToken()).toBe('tok-123');
      const vault = new AzureKeyVaultSecretStore({ vaultUrl: httpsUrl, tokenProvider: oauth, cacheTtlMs: 0 });
      expect(await vault.get('db-password')).toBe('vault:Bearer tok-123');
      const port = new URL(httpsUrl).port;
      expect(p.seen).toEqual([`CONNECT 127.0.0.1:${port}`, `GET ${httpUrl}/env-plain`, `CONNECT 127.0.0.1:${port}`, `CONNECT 127.0.0.1:${port}`]);
      // NO_PROXY from the environment exempts the host.
      process.env.NO_PROXY = '127.0.0.0/8';
      await api.get(`${httpsUrl}/env-direct`);
      expect(p.seen).toHaveLength(4);
    } finally {
      for (const k of ENV) delete process.env[k];
      p.server.close();
    }
  });
});
