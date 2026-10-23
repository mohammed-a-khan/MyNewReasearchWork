/**
 * The virtual-user HTTP client of EZTest Load, on Node core only:
 * HTTP/1.1 with keep-alive pools (per VU, like a browser, or shared), HTTP/2
 * (prior knowledge for http://, ALPN for https://, or auto-negotiated),
 * cookies, redirects, TLS client certificates, authentication (Basic,
 * Digest, NTLM, Negotiate, OAuth 2, Bearer), network emulation through the
 * connection shaper, and a timing breakdown per request (DNS, connect,
 * TLS, send, wait/TTFB, receive).
 */
import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import http2, { type ClientHttp2Session } from 'node:http2';
import tls, { type ConnectionOptions } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { EzTestError } from '../../core/index.js';
import type { AuthSpec, LoadOptionsSpec } from '../model.js';
import { CookieJar } from './cookies.js';
import { basicHeader, DigestAuth, negotiateToken, ntlmType1, ntlmType3, parseChallenge, parseNtlmType2 } from './auth.js';
import type { ConnectionShaper } from './shaping.js';

export interface HttpTimings {
  dns: number;
  connect: number;
  tls: number;
  send: number;
  /** Time to first byte after the request was sent. */
  wait: number;
  receive: number;
  total: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  url: string;
  redirects: number;
  protocol: 'h1' | 'h2';
  timings: HttpTimings;
  bytesIn: number;
  bytesOut: number;
  reused: boolean;
}

export interface HttpRequestInit {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  followRedirects?: boolean;
}

export class HttpRequestError extends EzTestError {
  constructor(readonly type: string, message: string, readonly timings?: Partial<HttpTimings>) {
    super(message, 'LOAD_HTTP');
    this.name = 'HttpRequestError';
  }
}

export interface HttpClientOptions {
  http: '1.1' | '2' | 'auto';
  keepAlive: boolean;
  maxConnectionsPerHost: number;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  userAgent: string;
  tls?: LoadOptionsSpec['tls'];
  baseDir?: string;
  auth?: AuthSpec;
  shaper?: ConnectionShaper;
  /** Shared agents (options.sharedPool). */
  agents?: { http: http.Agent; https: https.Agent };
}

const errType = (e: NodeJS.ErrnoException): string => {
  const c = e.code ?? '';
  if (c) return c;
  if (/certificate|self.signed|CERT/i.test(e.message)) return 'TLS_CERT';
  return e.name === 'Error' ? 'NETWORK' : e.name;
};

function tlsFiles(t: HttpClientOptions['tls'], baseDir: string): ConnectionOptions {
  if (!t) return {};
  const f = (p?: string) => (p ? readFileSync(resolvePath(baseDir, p)) : undefined);
  return { cert: f(t.cert), key: f(t.key), pfx: f(t.pfx), passphrase: t.passphrase, ca: f(t.ca), rejectUnauthorized: !t.insecure };
}

/** Agents whose sockets go through the shaper when network emulation is on. */
export function createAgents(o: Pick<HttpClientOptions, 'keepAlive' | 'maxConnectionsPerHost' | 'shaper' | 'tls' | 'baseDir'>, maxSockets = o.maxConnectionsPerHost): { http: http.Agent; https: https.Agent } {
  const shaper = o.shaper?.active ? o.shaper : undefined;
  const tlsOpts = tlsFiles(o.tls, o.baseDir ?? process.cwd());
  const h = new http.Agent({ keepAlive: o.keepAlive, maxSockets, keepAliveMsecs: 30_000 });
  const s = new https.Agent({ keepAlive: o.keepAlive, maxSockets, keepAliveMsecs: 30_000, ...tlsOpts });
  if (shaper) {
    (h as unknown as { createConnection: unknown }).createConnection = (opts: { host: string; port: number }, cb: (e: Error | null, s?: Socket) => void) => {
      shaper.target(opts.host, Number(opts.port)).then((t) => cb(null, netConnect(t)), (e) => cb(e as Error));
      return undefined;
    };
    (s as unknown as { createConnection: unknown }).createConnection = (opts: ConnectionOptions & { host: string; port: number; servername?: string }, cb: (e: Error | null, s?: Socket) => void) => {
      shaper.target(opts.host, Number(opts.port)).then((t) => {
        const raw = netConnect(t);
        cb(null, tls.connect({ ...opts, socket: raw, servername: opts.servername ?? (/^\d+\.\d+\.\d+\.\d+$/.test(opts.host) ? undefined : opts.host) }));
      }, (e) => cb(e as Error));
      return undefined;
    };
  }
  return { http: h, https: s };
}

export class HttpClient {
  readonly cookies = new CookieJar();
  private readonly agents: { http: http.Agent; https: https.Agent };
  private readonly ownAgents: boolean;
  private readonly h2 = new Map<string, ClientHttp2Session>();
  private readonly alpn = new Map<string, 'h1' | 'h2'>();
  private digest?: DigestAuth;
  private oauth?: { token: string; expires: number };
  private negotiate?: string;
  private readonly tlsOpts: ConnectionOptions;
  /** Extra headers added to every request (e.g. a correlated Authorization). */
  readonly defaultHeaders: Record<string, string> = {};

  constructor(readonly o: HttpClientOptions) {
    this.ownAgents = !o.agents;
    // NTLM authenticates a connection: one socket per origin keeps the handshake on it.
    this.agents = o.agents ?? createAgents(o, o.auth?.type === 'ntlm' ? 1 : o.maxConnectionsPerHost);
    this.tlsOpts = tlsFiles(o.tls, o.baseDir ?? process.cwd());
    if (o.auth?.type === 'digest') this.digest = new DigestAuth(o.auth.username, o.auth.password);
  }

  async request(init: HttpRequestInit): Promise<HttpResponse> {
    const started = performance.now();
    let url = new URL(init.url);
    let method = init.method.toUpperCase();
    let body = init.body;
    let headers = init.headers ?? {};
    const follow = init.followRedirects ?? this.o.followRedirects;
    let redirects = 0;
    let bytesIn = 0;
    let bytesOut = 0;
    for (;;) {
      const res = await this.authorized(method, url, headers, body, init.timeoutMs ?? this.o.timeoutMs);
      bytesIn += res.bytesIn;
      bytesOut += res.bytesOut;
      const loc = res.headers.location;
      if (follow && res.status >= 300 && res.status < 400 && res.status !== 304 && typeof loc === 'string' && redirects < this.o.maxRedirects) {
        redirects++;
        url = new URL(loc, url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)));
        }
        continue;
      }
      const total = performance.now() - started;
      return { ...res, url: url.href, redirects, bytesIn, bytesOut, timings: { ...res.timings, total } };
    }
  }

  private async authHeader(method: string, url: URL): Promise<string | undefined> {
    const a = this.o.auth;
    if (!a) return undefined;
    switch (a.type) {
      case 'basic':
        return basicHeader(a.username, a.password);
      case 'bearer':
        return `Bearer ${a.token}`;
      case 'digest':
        return this.digest?.ready ? this.digest.header(method, url.pathname + url.search) : undefined;
      case 'negotiate':
        this.negotiate ??= await negotiateToken(a, url.hostname);
        return `Negotiate ${this.negotiate}`;
      case 'oauth2': {
        if (!this.oauth || this.oauth.expires < Date.now()) await this.fetchOauth(a);
        return `Bearer ${this.oauth!.token}`;
      }
      case 'ntlm':
        return undefined;
    }
  }

  private async fetchOauth(a: Extract<AuthSpec, { type: 'oauth2' }>): Promise<void> {
    const form = new URLSearchParams({ grant_type: a.grant, client_id: a.clientId });
    if (a.clientSecret) form.set('client_secret', a.clientSecret);
    if (a.scope) form.set('scope', a.scope);
    if (a.grant === 'password') {
      form.set('username', a.username ?? '');
      form.set('password', a.password ?? '');
    }
    const r = await this.once('POST', new URL(a.tokenUrl), { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, form.toString(), this.o.timeoutMs);
    let j: { access_token?: string; expires_in?: number } = {};
    try {
      j = JSON.parse(r.body.toString('utf8'));
    } catch {
      /* handled below */
    }
    if (r.status !== 200 || !j.access_token) throw new HttpRequestError('AUTH', `OAuth token request to ${a.tokenUrl} returned ${r.status}`);
    this.oauth = { token: j.access_token, expires: Date.now() + Math.max(5, (j.expires_in ?? 3600) - 30) * 1000 };
  }

  private async authorized(method: string, url: URL, headers: Record<string, string>, body: Buffer | string | undefined, timeoutMs: number) {
    const a = this.o.auth;
    const has = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
    const pre = has ? undefined : await this.authHeader(method, url);
    const h = pre ? { ...headers, authorization: pre } : headers;
    if (a?.type === 'ntlm' && !has) {
      const r1 = await this.once(method, url, { ...headers, authorization: `NTLM ${ntlmType1()}` }, body, timeoutMs);
      if (r1.status !== 401) return r1;
      const c = parseChallenge(r1.headers['www-authenticate'], 'NTLM');
      if (!c?.token) return r1;
      const t3 = ntlmType3({ user: a.username, password: a.password, domain: a.domain, workstation: a.workstation, type2: parseNtlmType2(c.token) });
      const r2 = await this.once(method, url, { ...headers, authorization: `NTLM ${t3}` }, body, timeoutMs);
      return { ...r2, bytesIn: r1.bytesIn + r2.bytesIn, bytesOut: r1.bytesOut + r2.bytesOut };
    }
    const r = await this.once(method, url, h, body, timeoutMs);
    if (r.status === 401 && a && !has) {
      if (a.type === 'digest' && this.digest?.accept(r.headers['www-authenticate'])) {
        const r2 = await this.once(method, url, { ...headers, authorization: this.digest.header(method, url.pathname + url.search) }, body, timeoutMs);
        return { ...r2, bytesIn: r.bytesIn + r2.bytesIn, bytesOut: r.bytesOut + r2.bytesOut };
      }
      if (a.type === 'oauth2') {
        this.oauth = undefined;
        const r2 = await this.once(method, url, { ...headers, authorization: (await this.authHeader(method, url))! }, body, timeoutMs);
        return { ...r2, bytesIn: r.bytesIn + r2.bytesIn, bytesOut: r.bytesOut + r2.bytesOut };
      }
    }
    return r;
  }

  private async protocolFor(url: URL): Promise<'h1' | 'h2'> {
    const v = this.o.http;
    if (v === '1.1') return 'h1';
    if (v === '2' && url.protocol === 'http:') return 'h2';
    if (url.protocol === 'http:') return 'h1';
    if (v === '2') return 'h2';
    const known = this.alpn.get(url.host);
    if (known) return known;
    const proto = await new Promise<'h1' | 'h2'>((resolve) => {
      const s = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, ALPNProtocols: ['h2', 'http/1.1'], ...this.tlsOpts }, () => {
        resolve(s.alpnProtocol === 'h2' ? 'h2' : 'h1');
        s.destroy();
      });
      s.on('error', () => resolve('h1'));
      s.setTimeout(this.o.timeoutMs, () => s.destroy());
    });
    this.alpn.set(url.host, proto);
    return proto;
  }

  private buildHeaders(url: URL, headers: Record<string, string>, body: Buffer | string | undefined): Record<string, string> {
    const out: Record<string, string> = { 'user-agent': this.o.userAgent, accept: '*/*', 'accept-encoding': 'identity', ...this.defaultHeaders };
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
    const cookie = this.cookies.header(url);
    if (cookie) out.cookie = out.cookie ? `${out.cookie}; ${cookie}` : cookie;
    if (body !== undefined) out['content-length'] = String(Buffer.byteLength(body));
    return out;
  }

  /** One request/response exchange (no redirects, no auth). */
  async once(method: string, url: URL, headers: Record<string, string>, body: Buffer | string | undefined, timeoutMs: number): Promise<Omit<HttpResponse, 'url' | 'redirects'>> {
    const proto = await this.protocolFor(url);
    const h = this.buildHeaders(url, headers, body);
    const r = proto === 'h2' ? await this.onceH2(method, url, h, body, timeoutMs) : await this.onceH1(method, url, h, body, timeoutMs);
    this.cookies.setFromResponse(url, r.headers['set-cookie'] as string | string[] | undefined);
    return r;
  }

  private onceH1(method: string, url: URL, headers: Record<string, string>, body: Buffer | string | undefined, timeoutMs: number): Promise<Omit<HttpResponse, 'url' | 'redirects'>> {
    const secure = url.protocol === 'https:';
    if (!secure && url.protocol !== 'http:') return Promise.reject(new HttpRequestError('PROTOCOL', `unsupported URL scheme ${url.protocol}`));
    const mod = secure ? https : http;
    const t0 = performance.now();
    const t = { lookup: t0, connect: t0, secure: t0, sent: t0, first: t0 };
    let reused = false;
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (type: string, message: string) => {
        if (done) return;
        done = true;
        reject(new HttpRequestError(type, message, { total: performance.now() - t0 }));
      };
      const req = mod.request(
        {
          method,
          host: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || (secure ? 443 : 80),
          path: url.pathname + url.search,
          headers: headers as OutgoingHttpHeaders,
          agent: secure ? this.agents.https : this.agents.http,
          ...(secure ? { servername: /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ? undefined : url.hostname } : {}),
        },
        (res: IncomingMessage) => {
          t.first = performance.now();
          const chunks: Buffer[] = [];
          let n = 0;
          res.on('data', (c: Buffer) => {
            chunks.push(c);
            n += c.length;
          });
          res.on('end', () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const end = performance.now();
            const connectStart = reused ? t0 : t.lookup;
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
              protocol: 'h1',
              reused,
              bytesIn: n + headerBytes(res.rawHeaders) + 17,
              bytesOut: (typeof body === 'string' ? Buffer.byteLength(body) : body?.length ?? 0) + headerBytesObj(headers) + method.length + url.pathname.length + url.search.length + 12,
              timings: {
                dns: reused ? 0 : t.lookup - t0,
                connect: reused ? 0 : Math.max(0, t.connect - connectStart),
                tls: reused || !secure ? 0 : Math.max(0, t.secure - t.connect),
                send: Math.max(0, t.sent - (reused ? t0 : secure ? t.secure : t.connect)),
                wait: Math.max(0, t.first - t.sent),
                receive: end - t.first,
                total: end - t0,
              },
            });
          });
          res.on('error', (e: NodeJS.ErrnoException) => fail(errType(e), e.message));
          res.on('aborted', () => fail('ECONNRESET', 'response aborted'));
        },
      );
      const timer = setTimeout(() => {
        fail('TIMEOUT', `no complete response within ${timeoutMs} ms`);
        req.destroy();
      }, timeoutMs);
      req.on('socket', (s: Socket) => {
        reused = (req as unknown as { reusedSocket?: boolean }).reusedSocket === true;
        if (reused) return;
        s.once('lookup', () => (t.lookup = performance.now()));
        s.once('connect', () => {
          t.connect = performance.now();
          if (t.lookup === t0) t.lookup = t0;
        });
        s.once('secureConnect', () => (t.secure = performance.now()));
      });
      req.on('finish', () => (t.sent = performance.now()));
      req.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(errType(e), e.message);
      });
      if (body !== undefined) req.end(body);
      else req.end();
    });
  }

  private async session(url: URL): Promise<{ s: ClientHttp2Session; fresh: boolean; t: { dns: number; connect: number; tls: number } }> {
    const key = url.origin;
    const existing = this.h2.get(key);
    if (existing && !existing.closed && !existing.destroyed) return { s: existing, fresh: false, t: { dns: 0, connect: 0, tls: 0 } };
    const t0 = performance.now();
    const times = { dns: 0, connect: 0, tls: 0 };
    const shaper = this.o.shaper?.active ? this.o.shaper : undefined;
    const target = shaper ? await shaper.target(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80))) : undefined;
    const s = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const session = http2.connect(url.origin, {
        ...this.tlsOpts,
        ...(target
          ? {
              createConnection: () => {
                const raw = netConnect(target);
                return url.protocol === 'https:' ? tls.connect({ ...this.tlsOpts, socket: raw, servername: url.hostname, ALPNProtocols: ['h2'] }) : raw;
              },
            }
          : {}),
      });
      session.once('connect', () => {
        times.connect = performance.now() - t0;
        resolve(session);
      });
      session.once('error', reject);
    });
    s.on('error', () => this.h2.delete(key));
    s.on('close', () => this.h2.delete(key));
    s.on('goaway', () => this.h2.delete(key));
    this.h2.set(key, s);
    return { s, fresh: true, t: times };
  }

  private async onceH2(method: string, url: URL, headers: Record<string, string>, body: Buffer | string | undefined, timeoutMs: number): Promise<Omit<HttpResponse, 'url' | 'redirects'>> {
    const t0 = performance.now();
    let sess: Awaited<ReturnType<HttpClient['session']>>;
    try {
      sess = await this.session(url);
    } catch (e) {
      throw new HttpRequestError(errType(e as NodeJS.ErrnoException), (e as Error).message, { total: performance.now() - t0 });
    }
    const { s, fresh } = sess;
    const hh: Record<string, string> = { ':method': method, ':path': url.pathname + url.search, ':scheme': url.protocol.slice(0, -1), ':authority': url.host };
    for (const [k, v] of Object.entries(headers)) if (!/^(connection|keep-alive|transfer-encoding|upgrade|host)$/i.test(k)) hh[k] = v;
    const tSend = performance.now();
    return new Promise((resolve, reject) => {
      let done = false;
      const stream = s.request(hh, { endStream: body === undefined });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new HttpRequestError('TIMEOUT', `no complete response within ${timeoutMs} ms`, { total: performance.now() - t0 }));
      }, timeoutMs);
      let status = 0;
      let resHeaders: Record<string, string | string[] | undefined> = {};
      let tFirst = tSend;
      let tSent = tSend;
      const chunks: Buffer[] = [];
      let n = 0;
      stream.on('response', (h) => {
        tFirst = performance.now();
        status = Number(h[':status']);
        resHeaders = Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(':'))) as Record<string, string | string[]>;
      });
      stream.on('data', (c: Buffer) => {
        chunks.push(c);
        n += c.length;
      });
      stream.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const end = performance.now();
        resolve({
          status,
          headers: resHeaders,
          body: Buffer.concat(chunks),
          protocol: 'h2',
          reused: !fresh,
          bytesIn: n + Object.entries(resHeaders).reduce((a, [k, v]) => a + k.length + String(v).length, 0),
          bytesOut: (body === undefined ? 0 : Buffer.byteLength(body)) + Object.entries(hh).reduce((a, [k, v]) => a + k.length + v.length, 0),
          timings: { dns: sess.t.dns, connect: sess.t.connect, tls: sess.t.tls, send: Math.max(0, tSent - tSend), wait: Math.max(0, tFirst - tSent), receive: end - tFirst, total: end - t0 },
        });
      });
      stream.on('error', (e: NodeJS.ErrnoException) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new HttpRequestError(errType(e), e.message, { total: performance.now() - t0 }));
      });
      if (body !== undefined) {
        stream.end(body, () => (tSent = performance.now()));
      }
    });
  }

  close(): void {
    if (this.ownAgents) {
      this.agents.http.destroy();
      this.agents.https.destroy();
    }
    for (const s of this.h2.values()) s.close();
    this.h2.clear();
  }
}

function headerBytes(raw: string[]): number {
  let n = 0;
  for (const x of raw) n += x.length + 2;
  return n;
}

function headerBytesObj(h: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(h)) n += k.length + v.length + 4;
  return n;
}

/** Header value as one string. */
export function headerValue(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v.join(', ') : v;
}
