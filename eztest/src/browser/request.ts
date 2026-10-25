/**
 * API requests that share a browser context's cookies (page.request /
 * context.request), performed from Node with fetch.
 */
import { FetchedResponse } from './chromium/network.js';
import { envProxyFetch } from '../surfaces/proxy.js';

export interface APIRequestOptions {
  headers?: Record<string, string>;
  data?: unknown;
  form?: Record<string, string | number | boolean>;
  params?: Record<string, string | number | boolean>;
  method?: string;
  timeout?: number;
  maxRedirects?: number;
  failOnStatusCode?: boolean;
}

interface CookieJar {
  cookies(urls?: string | string[]): Promise<Array<{ name: string; value: string }>>;
  addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>;
  extraHTTPHeaders(): Record<string, string>;
  baseURL(): string | undefined;
}

export class APIRequestContext {
  constructor(private readonly jar: CookieJar) {}

  async fetch(urlOrRequest: string | { url(): string; method(): string; headers(): Record<string, string>; postDataBuffer(): Buffer | null }, options: APIRequestOptions = {}): Promise<FetchedResponse> {
    const isReq = typeof urlOrRequest !== 'string';
    let url = isReq ? urlOrRequest.url() : urlOrRequest;
    const base = this.jar.baseURL();
    if (base) url = new URL(url, base).href;
    const u = new URL(url);
    for (const [k, v] of Object.entries(options.params ?? {})) u.searchParams.set(k, String(v));
    const headers: Record<string, string> = { ...this.jar.extraHTTPHeaders(), ...(isReq ? urlOrRequest.headers() : {}), ...(options.headers ?? {}) };
    const cookies = await this.jar.cookies(u.href);
    if (cookies.length && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    let body: BodyInit | undefined;
    if (options.form) {
      body = new URLSearchParams(Object.entries(options.form).map(([k, v]) => [k, String(v)]));
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (options.data !== undefined) {
      if (typeof options.data === 'string') body = options.data;
      else if (Buffer.isBuffer(options.data)) body = new Uint8Array(options.data);
      else {
        body = JSON.stringify(options.data);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
    } else if (isReq) {
      const b = urlOrRequest.postDataBuffer();
      body = b ? new Uint8Array(b) : undefined;
    }
    const method = options.method ?? (isReq ? urlOrRequest.method() : 'GET');
    let current = u.href;
    let res: globalThis.Response;
    let redirects = options.maxRedirects ?? 20;
    for (;;) {
      res = await envProxyFetch(current, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
      });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      if (setCookies.length) await this.storeCookies(current, setCookies);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc && redirects > 0) {
        redirects--;
        current = new URL(loc, current).href;
        const c = await this.jar.cookies(current);
        if (c.length) headers.cookie = c.map((x) => `${x.name}=${x.value}`).join('; ');
        continue;
      }
      break;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      h[k] = v;
    });
    const out = new FetchedResponse(res.status, res.statusText, h, buf, current);
    if (options.failOnStatusCode && !out.ok()) throw new Error(`${res.status} ${res.statusText}`);
    return out;
  }

  private async storeCookies(url: string, setCookies: string[]): Promise<void> {
    const cookies = setCookies.map((sc) => {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), url };
    }).filter((c) => c.name);
    if (cookies.length) await this.jar.addCookies(cookies).catch(() => undefined);
  }

  get(url: string, options: APIRequestOptions = {}): Promise<FetchedResponse> {
    return this.fetch(url, { ...options, method: 'GET' });
  }

  post(url: string, options: APIRequestOptions = {}): Promise<FetchedResponse> {
    return this.fetch(url, { ...options, method: 'POST' });
  }

  put(url: string, options: APIRequestOptions = {}): Promise<FetchedResponse> {
    return this.fetch(url, { ...options, method: 'PUT' });
  }

  patch(url: string, options: APIRequestOptions = {}): Promise<FetchedResponse> {
    return this.fetch(url, { ...options, method: 'PATCH' });
  }

  delete(url: string, options: APIRequestOptions = {}): Promise<FetchedResponse> {
    return this.fetch(url, { ...options, method: 'DELETE' });
  }

  head(url: string, options: APIRequestOptions = {}): Promise<FetchedResponse> {
    return this.fetch(url, { ...options, method: 'HEAD' });
  }

  async dispose(): Promise<void> {
    /* stateless */
  }
}
