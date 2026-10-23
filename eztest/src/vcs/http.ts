/**
 * The small REST client the hosting providers (GitHub, GitLab, Bitbucket)
 * share: one pinned origin, HTTPS only (except localhost), the token only in
 * the Authorization header and redacted from every error, retries with
 * Retry-After for idempotent calls, and Link-header / `next` paging.
 */
import { EzTestError, sleep as coreSleep } from '../core/index.js';

export class VcsHttpError extends EzTestError {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    code = 'VCS_HTTP',
  ) {
    super(message, code, { status });
    this.name = 'VcsHttpError';
  }
}

export interface VcsHttpOptions {
  baseUrl: string;
  /** Header name and value carrying the credential, e.g. ['authorization', 'Bearer x'] or ['private-token', 'x']. */
  auth?: [string, string];
  /** Raw secrets to redact (token, password). */
  secrets?: string[];
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface VcsResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const RETRY = new Set([429, 500, 502, 503, 504]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export class VcsHttp {
  readonly origin: string;
  readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secrets: string[];

  constructor(private readonly o: VcsHttpOptions) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      throw new EzTestError(`Refusing to send credentials over plain HTTP to ${u.host}`, 'INVALID_INPUT');
    }
    this.origin = u.origin;
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? coreSleep;
    const raw = (o.secrets ?? []).filter((s) => s && s.length >= 4);
    this.secrets = [...raw, ...raw.map((s) => Buffer.from(s).toString('base64')), ...raw.map(encodeURIComponent)];
  }

  redact(s: string): string {
    let out = s;
    for (const sec of this.secrets) out = out.split(sec).join('***');
    return out.replace(/\b(Basic|Bearer|token)\s+[A-Za-z0-9+/=._~-]{8,}/g, '$1 ***');
  }

  url(path: string, query: Record<string, string | number | boolean | undefined> = {}): URL {
    const u = /^https?:\/\//.test(path) ? new URL(path) : new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (u.origin !== this.origin) throw new EzTestError(`Refusing to send credentials to a different origin (${u.origin})`, 'VCS_ORIGIN');
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  async request<T = unknown>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; idempotent?: boolean } = {}): Promise<VcsResponse<T>> {
    const m = method.toUpperCase();
    const u = this.url(path, opts.query);
    const safe = this.redact(`${m} ${u.pathname}${u.search}`);
    const retryable = IDEMPOTENT.has(m) || opts.idempotent;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 30_000);
      try {
        res = await this.f(u, {
          method: m,
          redirect: 'manual',
          signal: ac.signal,
          headers: {
            accept: 'application/json',
            'user-agent': this.o.userAgent ?? 'eztest',
            ...(this.o.auth ? { [this.o.auth[0]]: this.o.auth[1] } : {}),
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...this.o.extraHeaders,
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (e) {
        clearTimeout(t);
        if (retryable && attempt < (this.o.maxRetries ?? 3)) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new VcsHttpError(`${safe} failed: ${this.redact((e as Error).message)}`, 0, undefined, 'VCS_NETWORK');
      }
      clearTimeout(t);
      const secondaryLimit = res.status === 403 && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0');
      if ((RETRY.has(res.status) || secondaryLimit) && retryable && attempt < (this.o.maxRetries ?? 3)) {
        const ra = Number(res.headers.get('retry-after'));
        await res.arrayBuffer().catch(() => undefined);
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : 500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.status >= 300) {
        const msg = typeof data === 'object' && data ? ((data as { message?: string; error?: { message?: string } | string }).message ?? JSON.stringify((data as { error?: unknown }).error ?? data)) : String(data ?? '');
        throw new VcsHttpError(`${safe}: HTTP ${res.status} ${this.redact(String(msg).slice(0, 400))}`, res.status, data, res.status === 401 || res.status === 403 ? 'VCS_AUTH' : 'VCS_HTTP');
      }
      return { status: res.status, data: data as T, headers: res.headers };
    }
  }

  /** GET all pages: follows `Link: <...>; rel="next"` (GitHub, GitLab) or a body `next` URL (Bitbucket). */
  async getAll<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = this.url(path, query).toString();
    for (let i = 0; next && i < maxPages; i++) {
      const r: VcsResponse<unknown> = await this.request<unknown>('GET', next);
      const d = r.data as { values?: T[]; next?: string } | T[];
      if (Array.isArray(d)) out.push(...d);
      else if (d && Array.isArray(d.values)) out.push(...d.values);
      const link = r.headers.get('link');
      const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
      next = m?.[1] ?? (!Array.isArray(d) && d?.next ? d.next : undefined);
    }
    return out;
  }
}
