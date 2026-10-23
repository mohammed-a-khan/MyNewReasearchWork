/**
 * Azure DevOps REST client.
 *  - PAT (Basic) or bearer auth; dev.azure.com or on-prem collection URL
 *  - retries with Retry-After only for GET/HEAD/PUT/DELETE or calls marked idempotent
 *  - 203 / HTML responses are treated as an authentication failure (sign-in page)
 *  - the token (raw and base64 forms) is redacted from every error and log line
 *  - continuation-token paging
 */
import type { Logger } from '../core/index.js';
import { EzTestError, silentLogger, sleep as coreSleep } from '../core/index.js';

/** A source of short-lived bearer tokens (Microsoft Entra ID service principal, workload identity, managed identity). */
export interface AccessTokenProvider {
  /** e.g. "service-principal", "workload-identity", "managed-identity". */
  readonly kind: string;
  getToken(): Promise<{ token: string; expiresAt: number }>;
}

export type AdoAuth = { type: 'pat'; token: string } | { type: 'bearer'; token: string } | { type: 'provider'; provider: AccessTokenProvider };

export interface AdoClientOptions {
  /** Organization for https://dev.azure.com/{org}. Ignored when baseUrl is set. */
  org?: string;
  project: string;
  /** Collection URL, e.g. https://tfs.contoso.com/tfs/DefaultCollection (on-prem) or https://dev.azure.com/myorg. */
  baseUrl?: string;
  auth: AdoAuth;
  apiVersion?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  maxRetryAfterMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /**
   * Other origins the credentials may go to. On dev.azure.com the identity
   * (vssps.dev.azure.com) and test results (vstmr.dev.azure.com) hosts are
   * added automatically.
   */
  extraOrigins?: string[];
  /** Called with each new provider token, e.g. to register it with the run's secret masker. */
  onSecret?: (secret: string) => void;
}

export class AdoError extends EzTestError {
  constructor(
    message: string,
    readonly status: number,
    code = 'ADO_ERROR',
  ) {
    super(message, code, { status });
    this.name = 'AdoError';
  }
}

export class AdoAuthError extends AdoError {
  constructor(message: string, status: number) {
    super(message, status, 'ADO_AUTH');
    this.name = 'AdoAuthError';
  }
}

export interface AdoRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  /** Mark a non-GET call safe to retry (e.g. WIQL query, PATCH of run state). */
  idempotent?: boolean;
  /** Preview suffix for APIs that need one, e.g. "preview.1" -> api-version=7.1-preview.1. */
  preview?: string;
  /** A full api-version for this call (overrides the client's version and `preview`). */
  apiVersion?: string;
}

export interface AdoResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class AdoClient {
  readonly collectionUrl: string;
  readonly projectUrl: string;
  readonly apiVersion: string;
  readonly project: string;
  /** "pat", "bearer" or the token provider's kind. */
  readonly authKind: string;
  private authHeader: string | undefined;
  private tokenExpiresAt = 0;
  private readonly provider?: AccessTokenProvider;
  private readonly onSecret?: (s: string) => void;
  private readonly secrets: string[];
  private readonly origins: Set<string>;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;
  private readonly o: Required<Pick<AdoClientOptions, 'maxRetries' | 'retryBaseMs' | 'maxRetryAfterMs' | 'timeoutMs'>>;

  constructor(opts: AdoClientOptions) {
    if (opts.auth?.type !== 'provider' && !opts.auth?.token) throw new EzTestError('AdoClient: auth token is required', 'INVALID_INPUT');
    if (opts.auth?.type === 'provider' && !opts.auth.provider) throw new EzTestError('AdoClient: a token provider is required', 'INVALID_INPUT');
    if (!opts.project) throw new EzTestError('AdoClient: project is required', 'INVALID_INPUT');
    const base = opts.baseUrl ?? (opts.org ? `https://dev.azure.com/${encodeURIComponent(opts.org)}` : undefined);
    if (!base) throw new EzTestError('AdoClient: org or baseUrl is required', 'INVALID_INPUT');
    const u = new URL(base);
    if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      throw new EzTestError('AdoClient: refusing to send credentials over plain HTTP to a non-local host', 'INVALID_INPUT');
    }
    this.collectionUrl = base.replace(/\/+$/, '');
    this.project = opts.project;
    this.projectUrl = `${this.collectionUrl}/${encodeURIComponent(opts.project)}`;
    this.apiVersion = opts.apiVersion ?? '7.1';
    this.secrets = [];
    this.onSecret = opts.onSecret;
    if (opts.auth.type === 'provider') {
      this.provider = opts.auth.provider;
      this.authKind = opts.auth.provider.kind;
    } else {
      const b64 = Buffer.from(`:${opts.auth.token}`).toString('base64');
      this.authHeader = opts.auth.type === 'pat' ? `Basic ${b64}` : `Bearer ${opts.auth.token}`;
      this.authKind = opts.auth.type;
      this.secrets.push(...[opts.auth.token, b64, encodeURIComponent(opts.auth.token)].filter((s) => s.length >= 4));
    }
    this.origins = new Set([u.origin, ...(opts.extraOrigins ?? []).map((o) => new URL(o).origin)]);
    if (u.hostname === 'dev.azure.com') for (const h of ['vssps', 'vstmr', 'vsrm']) this.origins.add(`https://${h}.dev.azure.com`);
    else if (u.hostname.endsWith('.visualstudio.com')) {
      const org = u.hostname.split('.')[0];
      for (const h of ['vssps', 'vstmr', 'vsrm']) this.origins.add(`https://${org}.${h}.visualstudio.com`);
    }
    this.f = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? coreSleep;
    this.log = opts.logger ?? silentLogger;
    this.o = {
      maxRetries: opts.maxRetries ?? 4,
      retryBaseMs: opts.retryBaseMs ?? 500,
      maxRetryAfterMs: opts.maxRetryAfterMs ?? 60_000,
      timeoutMs: opts.timeoutMs ?? 60_000,
    };
  }

  /** Remove the token in any form from a string. */
  redact(s: string): string {
    let out = s;
    for (const sec of this.secrets) out = out.split(sec).join('***');
    return out.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/g, '$1 ***');
  }

  /** Identity host (vssps) of this organisation: the collection itself on Azure DevOps Server. */
  get identityUrl(): string {
    const u = new URL(this.collectionUrl);
    if (u.hostname === 'dev.azure.com') return `https://vssps.dev.azure.com${u.pathname}`;
    if (u.hostname.endsWith('.visualstudio.com')) return `https://${u.hostname.split('.')[0]}.vssps.visualstudio.com`;
    return this.collectionUrl;
  }

  /** Test results host (vstmr) of this organisation, for the flaky-test metadata API. */
  get testResultsUrl(): string {
    const u = new URL(this.collectionUrl);
    if (u.hostname === 'dev.azure.com') return `https://vstmr.dev.azure.com${u.pathname}`;
    if (u.hostname.endsWith('.visualstudio.com')) return `https://${u.hostname.split('.')[0]}.vstmr.visualstudio.com`;
    return this.collectionUrl;
  }

  /** Collection-level URL (no project), for APIs such as identities and work item links. */
  collection(path: string): string {
    return `${this.collectionUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private url(path: string, query: AdoRequestOptions['query'] = {}, version?: string): URL {
    const u = /^https?:\/\//.test(path) ? new URL(path) : new URL(`${this.projectUrl}${path.startsWith('/') ? '' : '/'}${path}`);
    if (!this.origins.has(u.origin)) {
      throw new EzTestError(`Refusing to send ADO credentials to a different origin (${u.origin})`, 'ADO_ORIGIN');
    }
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    if (!u.searchParams.has('api-version')) u.searchParams.set('api-version', version ?? this.apiVersion);
    return u;
  }

  /** The Authorization header, refreshing a provider's token 5 minutes before it expires. */
  private async header(force = false): Promise<string> {
    if (!this.provider) return this.authHeader!;
    if (force || !this.authHeader || Date.now() > this.tokenExpiresAt - 5 * 60_000) {
      const t = await this.provider.getToken();
      if (!t.token) throw new AdoAuthError(`ADO: the ${this.provider.kind} token provider returned no token`, 0);
      this.authHeader = `Bearer ${t.token}`;
      this.tokenExpiresAt = t.expiresAt;
      if (!this.secrets.includes(t.token)) {
        this.secrets.push(t.token);
        this.onSecret?.(t.token);
      }
    }
    return this.authHeader;
  }

  private retryDelay(res: Response | undefined, attempt: number): number {
    const ra = res?.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(ra) - Date.now();
      if (Number.isFinite(ms)) return Math.min(this.o.maxRetryAfterMs, Math.max(0, ms));
    }
    return Math.min(this.o.maxRetryAfterMs, this.o.retryBaseMs * 2 ** attempt);
  }

  async request<T = unknown>(method: string, path: string, opts: AdoRequestOptions = {}): Promise<AdoResponse<T>> {
    const m = method.toUpperCase();
    const url = this.url(path, opts.query, opts.apiVersion ?? (opts.preview ? `${this.apiVersion.replace(/-preview.*$/, '')}-${opts.preview}` : undefined));
    const retryable = IDEMPOTENT_METHODS.has(m) || opts.idempotent === true;
    const safeUrl = this.redact(`${url.pathname}${url.search}`);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const authorization = await this.header();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.o.timeoutMs);
      let res: Response | undefined;
      try {
        res = await this.f(url, {
          method: m,
          headers: {
            authorization,
            accept: 'application/json',
            ...(opts.body !== undefined ? { 'content-type': opts.contentType ?? 'application/json' } : {}),
          },
          // Binary bodies (e.g. work item attachments, application/octet-stream) are sent as-is.
          body: opts.body === undefined ? undefined : opts.body instanceof Uint8Array ? (opts.body as unknown as BodyInit) : JSON.stringify(opts.body),
          redirect: 'manual',
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = this.redact((e as Error).message ?? String(e));
        if (retryable && attempt < this.o.maxRetries) {
          const d = this.retryDelay(undefined, attempt);
          this.log.warn(`ADO ${m} ${safeUrl} network error, retrying in ${d} ms`, { error: msg });
          await this.sleep(d);
          continue;
        }
        throw new AdoError(`ADO ${m} ${safeUrl} failed: ${msg}`, 0, 'ADO_NETWORK');
      }
      clearTimeout(timer);
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 203 || (res.status >= 200 && res.status < 300 && /text\/html/i.test(ct)) || (res.status >= 300 && res.status < 400)) {
        await res.arrayBuffer().catch(() => undefined);
        throw new AdoAuthError(`ADO ${m} ${safeUrl}: received a sign-in page (HTTP ${res.status}); the token is invalid, expired or lacks scope`, res.status);
      }
      if (res.status === 401 && this.provider && !refreshed) {
        // A provider token may have been revoked or rotated early: fetch a new one once.
        await res.arrayBuffer().catch(() => undefined);
        refreshed = true;
        await this.header(true);
        attempt--;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => '');
        throw new AdoAuthError(`ADO ${m} ${safeUrl}: HTTP ${res.status} ${this.redact(text.slice(0, 300))}`, res.status);
      }
      if (RETRYABLE_STATUS.has(res.status) && retryable && attempt < this.o.maxRetries) {
        const d = this.retryDelay(res, attempt);
        await res.arrayBuffer().catch(() => undefined);
        this.log.warn(`ADO ${m} ${safeUrl} HTTP ${res.status}, retrying in ${d} ms (attempt ${attempt + 1}/${this.o.maxRetries})`);
        await this.sleep(d);
        continue;
      }
      const text = await res.text();
      if (res.status >= 400) {
        let msg = text.slice(0, 500);
        try {
          msg = (JSON.parse(text) as { message?: string }).message ?? msg;
        } catch {
          /* raw text */
        }
        throw new AdoError(`ADO ${m} ${safeUrl}: HTTP ${res.status} ${this.redact(msg)}`, res.status, RETRYABLE_STATUS.has(res.status) ? 'ADO_RETRYABLE' : 'ADO_ERROR');
      }
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new AdoError(`ADO ${m} ${safeUrl}: response is not JSON`, res.status, 'ADO_BAD_RESPONSE');
        }
      }
      return { status: res.status, data: data as T, headers: res.headers };
    }
  }

  /** GET every page by following x-ms-continuationtoken. Returns the concatenated `value` arrays. */
  async getAll<T>(path: string, query: AdoRequestOptions['query'] = {}, maxPages = 1000, extra: Pick<AdoRequestOptions, 'preview' | 'apiVersion'> = {}): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request<{ value?: T[] }>('GET', path, { ...extra, query: { ...query, continuationToken: token } });
      out.push(...(res.data?.value ?? []));
      token = res.headers.get('x-ms-continuationtoken') ?? undefined;
      if (!token) return out;
      if (seen.has(token)) throw new AdoError('ADO paging returned a repeated continuation token', res.status, 'ADO_PAGING');
      seen.add(token);
    }
    throw new AdoError(`ADO paging exceeded ${maxPages} pages`, 0, 'ADO_PAGING');
  }

  /** Whether an error is a transient failure that a recovery check may follow. */
  static isTransient(e: unknown): boolean {
    return e instanceof AdoError && (e.code === 'ADO_RETRYABLE' || e.code === 'ADO_NETWORK');
  }
}
