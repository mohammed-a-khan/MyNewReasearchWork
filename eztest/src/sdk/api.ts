/**
 * `api`: HTTP calls through the runner's API step (base URL resolution, role
 * tokens from the Identity Vault, mTLS client certificates, masked request and
 * response evidence). A status of 400 or more fails the step unless
 * `allowErrors` is set or `expectStatus` names the status you expect.
 */
import type { ApiCall } from '../core/index.js';
import { literal, literalDeep, run, show, tempKey, type ActionOptions } from './internal.js';
import { currentHost } from './runtime.js';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
  durationMs: number;
}

export interface ApiOptions extends Omit<ActionOptions, 'expect'> {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  /** Authorise with this Identity Vault role's API token. */
  asRole?: string;
  /** Present this named TLS client certificate (config api.clientCertificates). */
  clientCertificate?: string;
  /** Fail unless the response has this status (implies allowErrors for that status). */
  expectStatus?: number;
  /** Do not fail on 4xx/5xx; check `status` yourself. */
  allowErrors?: boolean;
  /** application/x-www-form-urlencoded body instead of JSON. */
  form?: Record<string, string>;
}

type Method = ApiCall['method'];

async function call<T>(method: Method, url: string, body: unknown, o: ApiOptions = {}): Promise<ApiResponse<T>> {
  const key = tempKey('api');
  const api: ApiCall = {
    method,
    url: literal(url),
    ...(o.headers ? { headers: literalDeep(o.headers) } : {}),
    ...(o.query ? { query: Object.fromEntries(Object.entries(o.query).map(([k, v]) => [k, literal(String(v))])) } : {}),
    ...(o.asRole ? { asRole: o.asRole } : {}),
    ...(o.clientCertificate ? { clientCertificate: o.clientCertificate } : {}),
    ...(o.form ? { form: literalDeep(o.form) } : {}),
    ...(body !== undefined && !o.form ? { body: literalDeep(body) } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  };
  const r = await run(
    {
      intent: o.intent ?? `Call API ${method} ${url}`,
      action: 'api',
      api,
      captureAs: key,
      ...(o.allowErrors ? { args: { allowErrors: true } } : {}),
      postconditions: o.expectStatus !== undefined ? [{ type: 'apiStatus', captureKey: key, status: o.expectStatus }] : [],
    },
    { ...o, intent: undefined },
  );
  currentHost().deleteVar(key);
  return r.captured?.[key] as ApiResponse<T>;
}

export const api = {
  get: <T = unknown>(url: string, o?: ApiOptions) => call<T>('GET', url, undefined, o),
  delete: <T = unknown>(url: string, o?: ApiOptions) => call<T>('DELETE', url, undefined, o),
  post: <T = unknown>(url: string, body?: unknown, o?: ApiOptions) => call<T>('POST', url, body, o),
  put: <T = unknown>(url: string, body?: unknown, o?: ApiOptions) => call<T>('PUT', url, body, o),
  patch: <T = unknown>(url: string, body?: unknown, o?: ApiOptions) => call<T>('PATCH', url, body, o),
  /** Any method. */
  request: <T = unknown>(method: Method, url: string, body?: unknown, o?: ApiOptions) => call<T>(method, url, body, o),
  /** A JSON path into a response body ($.a.b[0].c), or undefined. */
  path(res: ApiResponse | unknown, path: string): unknown {
    const body = res && typeof res === 'object' && 'body' in (res as object) ? (res as ApiResponse).body : res;
    return jsonPath(body, path);
  },
  /** Readable one-line form of a response, for logs. */
  describe(res: ApiResponse): string {
    return `${res.status} ${show(res.body, 120)}`;
  },
};

export type ApiSurface = typeof api;

/** Minimal JSON path: $, .key, ['key'], [n]. */
export function jsonPath(v: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, '').match(/[^.[\]'"]+|\[\d+\]/g) ?? [];
  let cur: unknown = v;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    const idx = /^\[(\d+)\]$/.exec(p);
    if (idx) cur = Array.isArray(cur) ? cur[Number(idx[1])] : undefined;
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}
