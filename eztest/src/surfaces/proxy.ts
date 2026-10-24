/**
 * HTTP(S) through an HTTP proxy, on Node core only (our own CONNECT
 * tunnelling, no proxy library):
 *
 * - http:// targets are sent to the proxy in absolute form
 *   (`GET http://host/path HTTP/1.1`);
 * - https:// targets go through a `CONNECT host:443` tunnel, then TLS to the
 *   target inside it (the target's certificate is verified as usual, client
 *   certificates work through the tunnel);
 * - proxy credentials (`http://user:pass@proxy:3128`) are sent as
 *   Proxy-Authorization: Basic;
 * - NO_PROXY: a comma list of hosts (`example.com` also matches its
 *   subdomains, `.example.com` only them), `host:port`, IP addresses, IPv4
 *   CIDR ranges and `*`.
 *
 * `envProxyFetch` reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY (or the lower-case
 * names) on every call, so EZTest's API steps, OAuth token requests and Key
 * Vault lookups honour the environment's proxy without any setting (Node's own
 * fetch does not, unless started with NODE_USE_ENV_PROXY=1).
 */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { EzTestError } from '../core/index.js';

export interface ProxySettings {
  /** http://[user:pass@]host:port */
  url: string;
  /** Hosts that bypass the proxy (NO_PROXY syntax). */
  noProxy?: string[] | string;
}

/** TLS options for the target (client certificate, extra CA). */
export type TargetTls = Pick<ConnectionOptions, 'pfx' | 'cert' | 'key' | 'passphrase' | 'ca'>;

function list(v: string[] | string | undefined): string[] {
  return (Array.isArray(v) ? v : (v ?? '').split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

/** Does NO_PROXY exempt this URL? */
export function bypassesProxy(target: string | URL, noProxy: string[] | string | undefined): boolean {
  const u = typeof target === 'string' ? new URL(target) : target;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  for (const raw of list(noProxy)) {
    if (raw === '*') return true;
    let rule = raw;
    let rulePort: string | undefined;
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(rule);
    if (m) {
      rule = m[1];
      rulePort = m[2];
    }
    rule = rule.replace(/^\[|\]$/g, '');
    if (rulePort && rulePort !== port) continue;
    if (rule.includes('/') && isIP(host) === 4) {
      const [net, bits] = rule.split('/');
      const b = Number(bits);
      if (isIP(net) === 4 && b >= 0 && b <= 32) {
        const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
        if ((ipv4ToInt(host) & mask) === (ipv4ToInt(net) & mask)) return true;
      }
      continue;
    }
    if (rule.startsWith('.')) {
      if (host.endsWith(rule)) return true;
      continue;
    }
    if (host === rule || host.endsWith(`.${rule.replace(/^\*\./, '')}`)) return true;
  }
  return false;
}

/** The proxy for a URL from the environment, or undefined (none set, or NO_PROXY exempts it). */
export function envProxyFor(target: string | URL, env: Record<string, string | undefined> = process.env): ProxySettings | undefined {
  const u = typeof target === 'string' ? new URL(target) : target;
  const pick = (...names: string[]) => names.map((n) => env[n]).find((v) => v !== undefined && v.trim() !== '');
  const proxy = u.protocol === 'https:' ? pick('HTTPS_PROXY', 'https_proxy') : u.protocol === 'http:' ? pick('HTTP_PROXY', 'http_proxy') : undefined;
  if (!proxy) return undefined;
  const noProxy = pick('NO_PROXY', 'no_proxy');
  if (bypassesProxy(u, noProxy)) return undefined;
  return { url: proxy, ...(noProxy ? { noProxy } : {}) };
}

function proxyAuth(p: URL): Record<string, string> {
  if (!p.username) return {};
  return { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` };
}

function redact(p: URL): string {
  return `${p.protocol}//${p.host}`;
}

/** Open a CONNECT tunnel to host:port through the proxy; resolves with the raw socket. */
function tunnel(proxy: URL, host: string, port: number, signal?: AbortSignal | null): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const req = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)), method: 'CONNECT', path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...proxyAuth(proxy) },
    });
    const onAbort = () => req.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('connect', (res, socket) => {
      signal?.removeEventListener('abort', onAbort);
      if (res.statusCode !== 200) {
        socket.destroy();
        const why = res.statusCode === 407 ? 'proxy authentication required (check the user and password in the proxy URL)' : `${res.statusCode} ${res.statusMessage ?? ''}`.trim();
        reject(new EzTestError(`The proxy ${redact(proxy)} refused to open a tunnel to ${host}:${port}: ${why}`, res.statusCode === 407 ? 'PROXY_AUTH' : 'PROXY_REFUSED'));
        return;
      }
      resolve(socket);
    });
    req.once('error', (e) => reject(e.name === 'AbortError' ? e : new EzTestError(`Could not reach the proxy ${redact(proxy)}: ${e.message}`, 'PROXY_CONNECT')));
    req.end();
  });
}

/**
 * A raw socket to host:port through the HTTP proxy (CONNECT), for protocols other than plain
 * HTTP requests (WebSocket upgrades); TLS to the target, when wanted, runs over it.
 */
export function openProxyTunnel(settings: ProxySettings, host: string, port: number, signal?: AbortSignal): Promise<import('node:net').Socket> {
  const proxy = new URL(settings.url);
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') throw new EzTestError(`Proxy URL ${redact(proxy)}: use http://host:port (an HTTP CONNECT proxy)`, 'PROXY_CONFIG');
  return tunnel(proxy, host, port, signal);
}

function decoded(res: IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'deflate') return res.pipe(createInflate());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  return res;
}

/** One request (no redirects) through the proxy. */
async function send(proxy: URL, url: URL, method: string, headers: OutgoingHttpHeaders, body: Buffer | undefined, signal: AbortSignal | null | undefined, tls: TargetTls | undefined): Promise<IncomingMessage> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (url.protocol === 'https:') {
    const raw = await tunnel(proxy, url.hostname, port, signal);
    const secure = tlsConnect({ socket: raw, servername: isIP(url.hostname) ? undefined : url.hostname, ...(tls ?? {}) });
    await new Promise<void>((res, rej) => {
      secure.once('secureConnect', () => res());
      secure.once('error', (e) => rej(new EzTestError(`TLS to ${url.host} through the proxy failed: ${e.message}`, 'API_NETWORK')));
    });
    return new Promise((resolve, reject) => {
      const r = httpsRequest(url, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) }, createConnection: () => secure }, resolve);
      r.on('error', reject);
      if (signal) signal.addEventListener('abort', () => r.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
      r.end(body);
    });
  }
  // Plain HTTP: the absolute URL to the proxy.
  return new Promise((resolve, reject) => {
    const r = httpRequest({
      host: proxy.hostname, port: Number(proxy.port || 80), method, path: url.toString(),
      headers: { ...headers, host: url.host, ...proxyAuth(proxy), ...(body ? { 'content-length': String(body.length) } : {}) },
    }, resolve);
    r.on('error', (e) => reject(e.name === 'AbortError' ? e : new EzTestError(`Could not reach the proxy ${redact(proxy)}: ${e.message}`, 'PROXY_CONNECT')));
    if (signal) {
      if (signal.aborted) r.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      else signal.addEventListener('abort', () => r.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
    }
    r.end(body);
  });
}

/**
 * A fetch() that sends every request through `proxy` (except NO_PROXY hosts, which go direct with
 * the global fetch). Follows redirects like fetch; supports any body fetch supports and abort signals.
 */
export function createProxyFetch(settings: ProxySettings, o: { tls?: TargetTls; direct?: typeof fetch } = {}): typeof fetch {
  const proxy = new URL(settings.url);
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') throw new EzTestError(`Proxy URL ${redact(proxy)}: use http://host:port (an HTTP CONNECT proxy)`, 'PROXY_CONFIG');
  const direct = o.direct ?? globalThis.fetch;
  const proxyFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    if (bypassesProxy(req.url, settings.noProxy)) return direct(req);
    const signal = init?.signal ?? req.signal;
    let url = new URL(req.url);
    let method = req.method;
    let payload = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    headers['accept-encoding'] ??= 'gzip, deflate, br';
    for (let hop = 0; ; hop++) {
      const res = await send(proxy, url, method, headers, payload, signal, url.protocol === 'https:' ? o.tls : undefined);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && (init?.redirect ?? 'follow') === 'follow' && hop < 20) {
        res.resume();
        url = new URL(location, url);
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET';
          payload = undefined;
          delete headers['content-type'];
        }
        if (bypassesProxy(url, settings.noProxy)) return direct(url, { method, headers, body: payload as BodyInit | undefined, signal: signal ?? undefined });
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const c of decoded(res)) chunks.push(c as Buffer);
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || k === 'content-encoding' || k === 'content-length') continue;
        for (const x of Array.isArray(v) ? v : [v]) out.append(k, x);
      }
      const nullBody = method === 'HEAD' || status === 204 || status === 304 || status < 200;
      const response = new Response(nullBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers: out });
      Object.defineProperty(response, 'url', { value: url.toString() });
      return response;
    }
  };
  return proxyFetch as typeof fetch;
}

/**
 * fetch() that honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY of the environment at call time;
 * without a proxy for the URL it is the global fetch.
 */
export const envProxyFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  let p: ProxySettings | undefined;
  try {
    p = envProxyFor(url);
  } catch {
    p = undefined;
  }
  return p ? createProxyFetch(p)(input, init) : globalThis.fetch(input, init);
}) as typeof fetch;
