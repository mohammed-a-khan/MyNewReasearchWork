/** Default API handler: fetch (through the environment's proxy) with baseUrl resolution and optional role auth. */
import { EzTestError, type ApiCall } from '../core/index.js';
import { selectClientCertificate, tlsFetchFor } from '../surfaces/api-tls.js';
import type { ApiAuthProvider, ApiHandler, ApiResponse, ClientCertificate, StepContext } from './types.js';
import { envProxyFetch } from '../surfaces/proxy.js';

export interface FetchApiOptions {
  /** Used when the call URL is relative and the step context has no baseUrl. */
  baseUrl?: string;
  /** Required for calls made `asRole`; returns e.g. `{ authorization: 'Bearer …' }`. */
  authHeaders?: ApiAuthProvider;
  timeoutMs?: number;
  /** mTLS: the certificate matching the call's origin (or named on the step) is presented. */
  clientCertificates?: ClientCertificate[];
}

/** Resolve a possibly-relative URL against a base. Relative URLs without a base are an error. */
export function resolveUrl(url: string, base?: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!base) throw new EzTestError(`Relative URL "${url}" needs a baseUrl (set it on the run or the journey)`, 'NO_BASE_URL');
  return new URL(url, base).toString();
}

/** Build the default fetch-based API handler. */
export function createFetchApiHandler(opts: FetchApiOptions = {}): ApiHandler {
  return async (call: ApiCall, ctx: StepContext): Promise<ApiResponse> => {
    const url = resolveUrl(call.url, ctx.baseUrl ?? opts.baseUrl);
    const headers: Record<string, string> = { ...(call.headers ?? {}) };
    if (call.asRole) {
      if (!opts.authHeaders) {
        throw new EzTestError(`API call as role "${call.asRole}" needs an apiAuth provider (none configured)`, 'NO_API_AUTH');
      }
      Object.assign(headers, await opts.authHeaders(call.asRole, ctx));
    }
    let body: BodyInit | undefined;
    if (call.body !== undefined && call.body !== null) {
      if (typeof call.body === 'string') body = call.body;
      else if (call.body instanceof FormData) {
        body = call.body; // fetch sets the multipart boundary
        for (const h of Object.keys(headers)) if (h.toLowerCase() === 'content-type') delete headers[h];
      } else if (call.body instanceof Uint8Array) body = call.body as unknown as BodyInit;
      else {
        body = JSON.stringify(call.body);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
    }
    const cert = selectClientCertificate(opts.clientCertificates, url, call.clientCertificate);
    const res = await (cert ? tlsFetchFor(cert) : envProxyFetch)(url, {
      method: call.method,
      headers,
      body,
      signal: AbortSignal.timeout(call.timeoutMs ?? opts.timeoutMs ?? 30_000),
    });
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, headers: outHeaders, body: parsed };
  };
}
