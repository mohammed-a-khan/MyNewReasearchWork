/**
 * TLS client certificates for browser contexts.
 *
 * Chromium has no protocol command to present a client certificate, so
 * requests to a configured origin are intercepted (Fetch domain) and
 * performed from Node with the certificate, and the browser is answered with
 * the response (Fetch.fulfillRequest). Consequences (documented in
 * docs/browser-driver.md):
 *  - the server certificate is verified by Node's trust store (system CAs plus
 *    NODE_EXTRA_CA_CERTS / tls.setDefaultCACertificates), not the browser's;
 *  - responses are buffered (no streaming), HTTP/1.1 only;
 *  - WebSockets and requests the Fetch domain cannot intercept (e.g. some
 *    service-worker traffic) are not covered.
 */
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { ClientCertificate } from '../types.js';
import type { ChromiumContext } from './browser.js';
import type { ContinueOptions, Request } from './network.js';

export type CertHandler = (req: Request, overrides: ContinueOptions, fulfill: (status: number, headers: Record<string, string>, body: Buffer) => Promise<void>) => Promise<void>;
export type CertFetcher = (url: string) => CertHandler | undefined;

function normOrigin(o: string): string {
  try {
    const u = new URL(o);
    return u.origin.toLowerCase();
  } catch {
    return o.toLowerCase().replace(/\/+$/, '');
  }
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  const e = (encoding ?? '').toLowerCase().trim();
  if (e === 'gzip' || e === 'x-gzip') return gunzipSync(body);
  if (e === 'deflate') return inflateSync(body);
  if (e === 'br') return brotliDecompressSync(body);
  return body;
}

export function clientCertificateFetcher(certs: ClientCertificate[], ctx: ChromiumContext): CertFetcher {
  const byOrigin = new Map<string, ClientCertificate>();
  for (const c of certs) byOrigin.set(normOrigin(c.origin), c);
  return (url: string) => {
    let origin: string;
    try {
      origin = new URL(url).origin.toLowerCase();
    } catch {
      return undefined;
    }
    const cert = byOrigin.get(origin);
    if (!cert) return undefined;
    return async (req, overrides, fulfill) => {
      const target = new URL(overrides.url ?? req.url());
      const headers: Record<string, string> = { ...req.headers(), ...(overrides.headers ?? {}) };
      for (const k of Object.keys(headers)) if (k.startsWith(':')) delete headers[k];
      const cookies = await ctx.cookies([target.href]).catch(() => []);
      const cookieHeader = (cookies as Array<{ name: string; value: string }>).map((c) => `${c.name}=${c.value}`).join('; ');
      if (cookieHeader) headers.cookie = cookieHeader;
      headers['accept-encoding'] = 'gzip, deflate, br';
      const body = overrides.postData !== undefined
        ? Buffer.isBuffer(overrides.postData) ? overrides.postData : Buffer.from(typeof overrides.postData === 'string' ? overrides.postData : JSON.stringify(overrides.postData))
        : req.postDataBuffer() ?? undefined;
      const tlsOpts = {
        ...(cert.pfx || cert.pfxPath ? { pfx: cert.pfx ?? readFileSync(cert.pfxPath!) } : {}),
        ...(cert.cert || cert.certPath ? { cert: cert.cert ?? readFileSync(cert.certPath!) } : {}),
        ...(cert.key || cert.keyPath ? { key: cert.key ?? readFileSync(cert.keyPath!) } : {}),
        ...(cert.passphrase !== undefined ? { passphrase: cert.passphrase } : {}),
        rejectUnauthorized: !ctx.options.ignoreHTTPSErrors,
      };
      const res = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
        const r = httpsRequest(target, { method: overrides.method ?? req.method(), headers, ...tlsOpts }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on('data', (c: Buffer) => chunks.push(c));
          resp.on('end', () => {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(resp.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join('\n') : String(v);
            const raw = Buffer.concat(chunks);
            const decoded = decode(raw, h['content-encoding']);
            delete h['content-encoding'];
            delete h['transfer-encoding'];
            h['content-length'] = String(decoded.length);
            resolve({ status: resp.statusCode ?? 500, headers: h, body: decoded });
          });
          resp.on('error', reject);
        });
        r.on('error', reject);
        r.setTimeout(60_000, () => r.destroy(new Error('client certificate request timed out')));
        if (body) r.write(body);
        r.end();
      });
      await fulfill(res.status, res.headers, res.body);
    };
  };
}
