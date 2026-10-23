/**
 * mTLS for EZTest's own HTTP calls: a fetch-compatible function that presents a
 * TLS client certificate (PKCS#12 or PEM cert + key) through a Node https.Agent.
 * Certificates are matched to a request by origin, or chosen by name on a step
 * ("with client certificate \"name\""). Certificate verification of the server is
 * never disabled; an extra CA bundle can be trusted per certificate.
 */
import { Agent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { EzTestError } from '../core/index.js';

export interface TlsClientCertificate {
  name?: string;
  /** https://host[:port] */
  origin: string;
  pfx?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
  ca?: Buffer;
}

/** Normalised origin: lower-case host, default port dropped. */
export function originOf(u: string | URL): string {
  const url = typeof u === 'string' ? new URL(u) : u;
  return url.origin.toLowerCase();
}

/**
 * The certificate for a request: by name when one is asked for (unknown names are an
 * error), otherwise the first whose origin equals the request's origin.
 */
export function selectClientCertificate<T extends { name?: string; origin: string }>(certs: readonly T[] | undefined, url: string, name?: string): T | undefined {
  if (name) {
    const hit = (certs ?? []).find((c) => c.name === name);
    if (!hit) throw new EzTestError(`No client certificate named "${name}" (config api.clientCertificates; known: ${(certs ?? []).map((c) => c.name).filter(Boolean).join(', ') || 'none'})`, 'CLIENT_CERT_UNKNOWN');
    return hit;
  }
  if (!certs?.length || !/^https:/i.test(url)) return undefined;
  const o = originOf(url);
  return certs.find((c) => originOf(c.origin) === o);
}

const AGENTS = new WeakMap<TlsClientCertificate, Agent>();

function agentFor(c: TlsClientCertificate): Agent {
  let a = AGENTS.get(c);
  if (!a) {
    a = new Agent({ keepAlive: false, ...(c.pfx ? { pfx: c.pfx } : {}), ...(c.cert ? { cert: c.cert } : {}), ...(c.key ? { key: c.key } : {}), ...(c.passphrase !== undefined ? { passphrase: c.passphrase } : {}), ...(c.ca ? { ca: c.ca } : {}) });
    AGENTS.set(c, a);
  }
  return a;
}

function tlsError(e: unknown): EzTestError {
  const msg = (e as Error).message ?? String(e);
  if (/mac verify failure|bad decrypt|wrong passphrase|PKCS12/i.test(msg)) return new EzTestError('Client certificate could not be loaded: wrong passphrase or not a PKCS#12 file', 'CLIENT_CERT_INVALID');
  return new EzTestError(`TLS request failed: ${msg}`, 'API_NETWORK');
}

/**
 * A fetch() that sends https requests with the client certificate (other URLs go to
 * the global fetch). Supports any body fetch supports, abort signals and redirects.
 */
export function createTlsFetch(cert: TlsClientCertificate): typeof fetch {
  const tlsFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    if (!/^https:/i.test(req.url)) return fetch(req);
    const signal = init?.signal ?? req.signal;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
    let url = new URL(req.url);
    let method = req.method;
    let payload = body;
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    for (let hop = 0; ; hop++) {
      const res = await new Promise<IncomingMessage>((resolveRes, reject) => {
        const r = httpsRequest(url, { method, headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) }, agent: agentFor(cert) }, resolveRes);
        r.on('error', (e) => reject(tlsError(e)));
        if (signal) {
          if (signal.aborted) r.destroy(new Error('aborted'));
          else signal.addEventListener('abort', () => r.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
        }
        r.end(payload);
      });
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && (init?.redirect ?? 'follow') === 'follow' && hop < 10) {
        res.resume();
        url = new URL(location, url);
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET';
          payload = undefined;
          delete headers['content-type'];
        }
        if (url.protocol !== 'https:' || originOf(url) !== originOf(cert.origin)) {
          return fetch(url, { method, headers, body: payload as BodyInit | undefined, signal: signal ?? undefined });
        }
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const x of Array.isArray(v) ? v : [v]) out.append(k, x);
      }
      const nullBody = method === 'HEAD' || status === 204 || status === 304;
      const response = new Response(nullBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers: out });
      Object.defineProperty(response, 'url', { value: url.toString() });
      return response;
    }
  };
  return tlsFetch as typeof fetch;
}

/** fetch per certificate, cached. */
export function tlsFetchFor(cert: TlsClientCertificate): typeof fetch {
  let f = FETCHES.get(cert);
  if (!f) {
    f = createTlsFetch(cert);
    FETCHES.set(cert, f);
  }
  return f;
}
const FETCHES = new WeakMap<TlsClientCertificate, typeof fetch>();
