/**
 * ApiClient: a thin, honest HTTP client on global fetch.
 * - retries only idempotent methods, with exponential backoff + jitter, honoring Retry-After
 * - timeouts via AbortController
 * - auth: bearer, basic, API key (header/query), OAuth2 via an injected token provider
 * - secrets in errors/logs are masked when a masker is supplied
 * Options EZTest does not implement (proxy, disabling TLS verification) throw NotSupportedError.
 */
import { EzTestError, NotSupportedError, silentLogger, sleep, type Logger } from '../core/index.js';
import { selectClientCertificate, tlsFetchFor, type TlsClientCertificate } from './api-tls.js';

/** Anything that hands out access tokens (see identity OAuth2TokenProvider). */
export interface TokenProvider {
  getToken(): Promise<string>;
  /** Drop a cached token (called once after a 401). */
  invalidate?(): void;
}

export type ApiAuth =
  | { type: 'bearer'; token: string | (() => Promise<string>) }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; name: string; value: string; in?: 'header' | 'query' }
  | { type: 'oauth2'; tokenProvider: TokenProvider };

export interface RetryPolicy {
  /** Extra attempts after the first (default 2). */
  max?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  statuses?: number[];
  retryOnNetworkError?: boolean;
  /** Retry-After values longer than this stop retrying (default 30s). */
  maxRetryAfterMs?: number;
}

export interface Masker {
  mask(s: string): string;
}

export interface ApiClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: ApiAuth;
  timeoutMs?: number;
  retry?: RetryPolicy | false;
  /** Not implemented yet: throws NotSupportedError when set. */
  proxy?: string;
  /** TLS verification cannot be disabled through EZTest: `false` throws NotSupportedError. */
  rejectUnauthorized?: boolean;
  fetch?: typeof fetch;
  /** TLS client certificates (mTLS); the one whose origin matches the request is presented. */
  clientCertificates?: TlsClientCertificate[];
  masker?: Masker;
  logger?: Logger;
  /** Injectable for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MultipartFile {
  filename: string;
  content: Uint8Array | string;
  contentType?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | Array<string | number | boolean>>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string | number | boolean>;
  multipart?: Record<string, string | MultipartFile>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  retry?: RetryPolicy | false;
  /** Override the client auth for this call; `false` sends no auth. */
  auth?: ApiAuth | false;
  /** Present this named client certificate (from ApiClientOptions.clientCertificates). */
  clientCertificate?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504];

export interface ApiResponse<T = unknown> {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  statusText: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  text: string;
  /** Parsed JSON when the response is JSON, otherwise the text. */
  body: T;
  durationMs: number;
  attempts: number;
  header(name: string): string | undefined;
}

export class ApiError extends EzTestError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  readonly baseUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(private readonly opts: ApiClientOptions = {}) {
    if (opts.proxy !== undefined) {
      throw new NotSupportedError('ApiClient proxy option (configure HTTPS_PROXY at the process level instead)');
    }
    if (opts.rejectUnauthorized === false) {
      throw new NotSupportedError('disabling TLS certificate verification');
    }
    if (opts.baseUrl) new URL(opts.baseUrl); // validate early
    this.baseUrl = opts.baseUrl;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.logger = opts.logger ?? silentLogger;
  }

  /** A new client sharing options, with some overridden. */
  with(overrides: Partial<ApiClientOptions>): ApiClient {
    return new ApiClient({ ...this.opts, ...overrides, headers: { ...this.opts.headers, ...overrides.headers } });
  }

  get<T = unknown>(path: string, o?: RequestOptions) {
    return this.request<T>('GET', path, o);
  }
  post<T = unknown>(path: string, o?: RequestOptions) {
    return this.request<T>('POST', path, o);
  }
  put<T = unknown>(path: string, o?: RequestOptions) {
    return this.request<T>('PUT', path, o);
  }
  patch<T = unknown>(path: string, o?: RequestOptions) {
    return this.request<T>('PATCH', path, o);
  }
  delete<T = unknown>(path: string, o?: RequestOptions) {
    return this.request<T>('DELETE', path, o);
  }
  head(path: string, o?: RequestOptions) {
    return this.request('HEAD', path, o);
  }
  options(path: string, o?: RequestOptions) {
    return this.request('OPTIONS', path, o);
  }

  resolveUrl(path: string, query?: RequestOptions['query']): URL {
    let url: URL;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) url = new URL(path);
    else if (this.baseUrl) {
      const base = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
      url = new URL(path.replace(/^\//, ''), base);
    } else throw new ApiError(`Relative URL "${path}" needs a baseUrl`, 'API_NO_BASE_URL');
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
      else url.searchParams.append(k, String(v));
    }
    return url;
  }

  private mask(s: string): string {
    return this.opts.masker ? this.opts.masker.mask(s) : s;
  }

  async request<T = unknown>(method: HttpMethod | string, path: string, o: RequestOptions = {}): Promise<ApiResponse<T>> {
    const m = method.toUpperCase();
    const url = this.resolveUrl(path, o.query);
    const bodies = [o.json !== undefined, o.form !== undefined, o.multipart !== undefined, o.body !== undefined].filter(Boolean).length;
    if (bodies > 1) throw new ApiError('Use only one of json, form, multipart or body', 'API_BAD_REQUEST');
    if (bodies && (m === 'GET' || m === 'HEAD')) throw new ApiError(`${m} requests cannot have a body`, 'API_BAD_REQUEST');

    const policy = o.retry === false || this.opts.retry === false ? undefined : { ...this.opts.retry, ...(o.retry || {}) };
    const maxRetries = policy && IDEMPOTENT_METHODS.has(m) ? (policy.max ?? 2) : 0;
    const retryStatuses = new Set(policy?.statuses ?? DEFAULT_RETRY_STATUSES);
    const baseDelay = policy?.baseDelayMs ?? 200;
    const maxDelay = policy?.maxDelayMs ?? 5000;
    const maxRetryAfter = policy?.maxRetryAfterMs ?? 30_000;
    const random = this.opts.random ?? Math.random;
    const wait = this.opts.sleep ?? sleep;
    const timeoutMs = o.timeoutMs ?? this.opts.timeoutMs ?? 30_000;
    const auth = o.auth === false ? undefined : (o.auth ?? this.opts.auth);

    const started = performance.now();
    let attempt = 0;
    let reauthed = false;
    for (;;) {
      attempt++;
      const { headers, body, finalUrl } = await this.build(url, o, auth);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      let text: string;
      try {
        const cert = this.opts.fetch ? undefined : selectClientCertificate(this.opts.clientCertificates, finalUrl.toString(), o.clientCertificate);
        res = await (cert ? tlsFetchFor(cert) : this.fetchImpl)(finalUrl, { method: m, headers, body, signal: ctrl.signal, redirect: 'follow' });
        text = m === 'HEAD' ? '' : await res.text();
      } catch (e) {
        clearTimeout(timer);
        const timedOut = ctrl.signal.aborted;
        if (attempt <= maxRetries && (policy?.retryOnNetworkError ?? true)) {
          const d = backoff(attempt, baseDelay, maxDelay, random);
          this.logger.debug(`${m} ${this.mask(url.pathname)} ${timedOut ? 'timed out' : 'network error'}, retry ${attempt} in ${d}ms`);
          await wait(d);
          continue;
        }
        if (timedOut) {
          throw new ApiError(`${m} ${this.mask(url.toString())} timed out after ${timeoutMs}ms (attempts: ${attempt})`, 'API_TIMEOUT', { attempts: attempt });
        }
        const cause = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
        throw new ApiError(`${m} ${this.mask(url.toString())} failed: ${this.mask(cause)} (attempts: ${attempt})`, 'API_NETWORK', { attempts: attempt });
      }
      clearTimeout(timer);

      if (res.status === 401 && auth?.type === 'oauth2' && auth.tokenProvider.invalidate && !reauthed) {
        reauthed = true;
        auth.tokenProvider.invalidate();
        attempt--;
        continue;
      }
      if (attempt <= maxRetries && retryStatuses.has(res.status)) {
        const ra = parseRetryAfter(res.headers.get('retry-after'));
        if (ra === undefined || ra <= maxRetryAfter) {
          const d = ra ?? backoff(attempt, baseDelay, maxDelay, random);
          this.logger.debug(`${m} ${this.mask(url.pathname)} -> ${res.status}, retry ${attempt} in ${d}ms`);
          await wait(d);
          continue;
        }
      }
      return makeResponse<T>(m, url.toString(), res, text, performance.now() - started, attempt);
    }
  }

  private async build(url: URL, o: RequestOptions, auth: ApiAuth | undefined) {
    const headers = new Headers(this.opts.headers);
    for (const [k, v] of Object.entries(o.headers ?? {})) headers.set(k, v);
    const finalUrl = new URL(url);
    if (auth) {
      switch (auth.type) {
        case 'bearer': {
          const t = typeof auth.token === 'function' ? await auth.token() : auth.token;
          headers.set('authorization', `Bearer ${t}`);
          break;
        }
        case 'basic':
          headers.set('authorization', 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64'));
          break;
        case 'apiKey':
          if ((auth.in ?? 'header') === 'header') headers.set(auth.name, auth.value);
          else finalUrl.searchParams.set(auth.name, auth.value);
          break;
        case 'oauth2':
          headers.set('authorization', `Bearer ${await auth.tokenProvider.getToken()}`);
          break;
        default:
          throw new NotSupportedError(`auth type ${(auth as { type: string }).type}`);
      }
    }
    let body: BodyInit | undefined;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else if (o.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(o.form)) p.append(k, String(v));
      body = p.toString();
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
    } else if (o.multipart) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(o.multipart)) {
        if (typeof v === 'string') fd.append(k, v);
        else fd.append(k, new Blob([typeof v.content === 'string' ? v.content : new Uint8Array(v.content)], { type: v.contentType ?? 'application/octet-stream' }), v.filename);
      }
      body = fd; // fetch sets the multipart boundary
      headers.delete('content-type');
    } else if (o.body !== undefined) {
      body = typeof o.body === 'string' ? o.body : new Uint8Array(o.body);
    }
    if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain, */*');
    return { headers, body, finalUrl };
  }
}

function backoff(attempt: number, base: number, max: number, random: () => number): number {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2)); // "equal jitter"
}

/** Retry-After: delta-seconds or an HTTP date. Returns ms, or undefined if absent/invalid. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const d = Date.parse(t);
  if (Number.isNaN(d)) return undefined;
  return Math.max(0, d - now);
}

function makeResponse<T>(method: string, url: string, res: Response, text: string, durationMs: number, attempts: number): ApiResponse<T> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  let body: unknown = text;
  const ct = headers['content-type'] ?? '';
  if (/[/+]json\b/i.test(ct) && text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text; // malformed JSON stays as text; assertions will report it
    }
  }
  return {
    method,
    url,
    status: res.status,
    ok: res.ok,
    statusText: res.statusText,
    headers,
    text,
    body: body as T,
    durationMs: Math.round(durationMs * 100) / 100,
    attempts,
    header: (name: string) => headers[name.toLowerCase()],
  };
}
