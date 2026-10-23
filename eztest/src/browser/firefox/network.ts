/**
 * Network events and interception for one Firefox page, from the WebDriver
 * BiDi network module:
 *
 * - network.beforeRequestSent / responseStarted / responseCompleted /
 *   fetchError become the same Request / Response objects (and page and
 *   context events) the CDP engine produces. Redirects keep the BiDi request
 *   id and raise its redirectCount: each hop is its own Request, linked with
 *   redirectedFrom / redirectedTo.
 * - Bodies come from a network data collector (network.addDataCollector +
 *   network.getData): response bodies, and request bodies (postData) where
 *   the browser collects them.
 * - Interception: the browser adds one network intercept (phase
 *   beforeRequestSent) while any context or page has routes; a blocked
 *   request runs the shared route chain (runRouteChain) with a backend that
 *   answers with network.continueRequest / provideResponse / failRequest.
 *   HTTP authentication (phase authRequired) answers with
 *   network.continueWithAuth.
 * - Error texts are reported with Chromium's net::ERR_* names where an
 *   equivalent exists, so messages read the same on both engines.
 *
 * networkidle follows the same rule as the CDP engine (see
 * chromium/network.ts).
 */
import { Request, Response, runRouteChain, type ContinueOptions, type Header, type RouteBackend } from '../chromium/network.js';
import type { CrFrame } from '../chromium/frame.js';
import { debugLog } from '../debug.js';
import type { BidiConnection } from './connection.js';
import { cdpUnavailable } from './stubs.js';
import type { FfPage } from './page.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NO_CDP = cdpUnavailable('Network') as never;

/** Firefox (NSS / necko) error names -> Chromium net error names. */
const NET_ERRORS: Record<string, string> = {
  NS_ERROR_CONNECTION_REFUSED: 'net::ERR_CONNECTION_REFUSED',
  NS_ERROR_PORT_ACCESS_NOT_ALLOWED: 'net::ERR_UNSAFE_PORT',
  deniedPortAccess: 'net::ERR_UNSAFE_PORT',
  NS_ERROR_UNKNOWN_HOST: 'net::ERR_NAME_NOT_RESOLVED',
  NS_ERROR_UNKNOWN_PROXY_HOST: 'net::ERR_PROXY_CONNECTION_FAILED',
  NS_ERROR_PROXY_CONNECTION_REFUSED: 'net::ERR_PROXY_CONNECTION_FAILED',
  NS_ERROR_NET_TIMEOUT: 'net::ERR_TIMED_OUT',
  NS_ERROR_NET_RESET: 'net::ERR_CONNECTION_RESET',
  NS_ERROR_NET_INTERRUPT: 'net::ERR_CONNECTION_CLOSED',
  NS_ERROR_NET_PARTIAL_TRANSFER: 'net::ERR_CONTENT_LENGTH_MISMATCH',
  NS_ERROR_OFFLINE: 'net::ERR_INTERNET_DISCONNECTED',
  NS_ERROR_DOCUMENT_NOT_CACHED: 'net::ERR_INTERNET_DISCONNECTED',
  NS_BINDING_ABORTED: 'net::ERR_ABORTED',
  NS_ERROR_ABORT: 'net::ERR_ABORTED',
  NS_ERROR_FAILURE: 'net::ERR_FAILED',
  NS_ERROR_MALFORMED_URI: 'net::ERR_INVALID_URL',
  NS_ERROR_UNKNOWN_PROTOCOL: 'net::ERR_UNKNOWN_URL_SCHEME',
  NS_ERROR_FILE_NOT_FOUND: 'net::ERR_FILE_NOT_FOUND',
  NS_ERROR_CORRUPTED_CONTENT: 'net::ERR_INVALID_RESPONSE',
  NS_ERROR_INVALID_CONTENT_ENCODING: 'net::ERR_CONTENT_DECODING_FAILED',
  NS_ERROR_REDIRECT_LOOP: 'net::ERR_TOO_MANY_REDIRECTS',
  NS_ERROR_CONTENT_BLOCKED: 'net::ERR_BLOCKED_BY_CLIENT',
  NS_ERROR_TRACKING_URI: 'net::ERR_BLOCKED_BY_CLIENT',
  NS_ERROR_DOM_BAD_URI: 'net::ERR_ACCESS_DENIED',
  SEC_ERROR_UNKNOWN_ISSUER: 'net::ERR_CERT_AUTHORITY_INVALID',
  SEC_ERROR_EXPIRED_CERTIFICATE: 'net::ERR_CERT_DATE_INVALID',
  SSL_ERROR_BAD_CERT_DOMAIN: 'net::ERR_CERT_COMMON_NAME_INVALID',
  MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT: 'net::ERR_CERT_AUTHORITY_INVALID',
};

/** route.abort reasons -> the error text the page's request reports (Chromium names). */
const ABORT_TEXT: Record<string, string> = {
  aborted: 'net::ERR_ABORTED', accessdenied: 'net::ERR_ACCESS_DENIED', addressunreachable: 'net::ERR_ADDRESS_UNREACHABLE',
  blockedbyclient: 'net::ERR_BLOCKED_BY_CLIENT', blockedbyresponse: 'net::ERR_BLOCKED_BY_RESPONSE', connectionaborted: 'net::ERR_CONNECTION_ABORTED',
  connectionclosed: 'net::ERR_CONNECTION_CLOSED', connectionfailed: 'net::ERR_CONNECTION_FAILED', connectionrefused: 'net::ERR_CONNECTION_REFUSED',
  connectionreset: 'net::ERR_CONNECTION_RESET', internetdisconnected: 'net::ERR_INTERNET_DISCONNECTED', namenotresolved: 'net::ERR_NAME_NOT_RESOLVED',
  timedout: 'net::ERR_TIMED_OUT', failed: 'net::ERR_FAILED',
};

/** A Firefox error text as a Chromium-style net error (unknown names are kept). */
export function netErrorText(firefoxText: string | undefined): string {
  const t = (firefoxText ?? '').trim();
  if (!t) return 'net::ERR_FAILED';
  // A security error names its cause inside the generic NSS wrapper error: prefer the cause.
  const name = /\b((?:SEC|SSL|MOZILLA_PKIX)_[A-Z0-9_]+)\b/.exec(t)?.[1] ?? /\b(NS_[A-Z0-9_]+|deniedPortAccess)\b/.exec(t)?.[1];
  if (name && NET_ERRORS[name]) return NET_ERRORS[name];
  return name ?? t;
}

/** BiDi headers ([{name, value: {type, value}}]) -> Header[]. */
export function headersFromBidi(list: any[] | undefined): Header[] {
  return (list ?? []).map((h) => ({ name: String(h.name), value: h.value?.type === 'base64' ? Buffer.from(h.value.value, 'base64').toString('latin1') : String(h.value?.value ?? '') }));
}

/** Header[] -> BiDi headers. */
export function headersToBidi(list: Header[]): Array<{ name: string; value: { type: 'string'; value: string } }> {
  return list.map((h) => ({ name: h.name, value: { type: 'string', value: h.value } }));
}

function resourceTypeOf(r: any): string {
  const dest = String(r.destination ?? '');
  const init = String(r.initiatorType ?? '');
  switch (dest) {
    case 'document': case 'iframe': case 'frame': case 'embed': case 'object': return 'document';
    case 'style': return 'stylesheet';
    case 'script': case 'worker': case 'sharedworker': case 'serviceworker': case 'audioworklet': case 'paintworklet': return 'script';
    case 'image': return 'image';
    case 'font': return 'font';
    case 'audio': case 'video': return 'media';
    case 'track': return 'texttrack';
    case 'manifest': return 'manifest';
    case 'report': return 'other';
  }
  if (init === 'xmlhttprequest') return 'xhr';
  if (init === 'fetch') return 'fetch';
  if (init === 'beacon') return 'ping';
  if (init === 'img' || init === 'image') return 'image';
  if (init === 'css') return 'stylesheet';
  if (init === 'script') return 'script';
  const accept = headersFromBidi(r.headers).find((h) => h.name.toLowerCase() === 'accept')?.value ?? '';
  if (accept.includes('text/event-stream')) return 'eventsource';
  if (init === 'other' && dest === '') return 'fetch';
  return 'other';
}

/** BiDi fetch timings (ms on the page's clock) -> the CDP-shaped timing our Request reports (ms from the start). */
function timingOf(t: any): Record<string, number> | undefined {
  if (!t) return undefined;
  const base = Number(t.fetchStart || t.requestTime || 0);
  const rel = (v: unknown) => (typeof v === 'number' && v > 0 && base > 0 ? v - base : -1);
  return {
    dnsStart: rel(t.dnsStart), dnsEnd: rel(t.dnsEnd), connectStart: rel(t.connectStart), sslStart: rel(t.tlsStart),
    connectEnd: rel(t.connectEnd), sendStart: rel(t.requestStart), receiveHeadersEnd: rel(t.responseStart),
  };
}

/** A BiDi request hop. */
interface FfRequest extends Request {
  bidiId: string;
  redirectCount: number;
  abortText?: string;
}

/** The engine-specific half of a route: BiDi network.* commands for one blocked request. */
export function bidiRouteBackend(bidi: BidiConnection, requestId: string, req: FfRequest, latency: () => number): RouteBackend {
  const wait = async () => {
    const ms = latency();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  };
  const ignoreGone = (e: Error) => {
    if (!/no such request|no such frame|has been closed|Browser has been closed/i.test(e.message)) throw e;
  };
  return {
    abort: async (reason) => {
      req.abortText = ABORT_TEXT[reason] ?? 'net::ERR_FAILED';
      await bidi.send('network.failRequest', { request: requestId }).catch(ignoreGone);
    },
    fulfill: async (status, headers, body) => {
      await wait();
      await bidi.send('network.provideResponse', {
        request: requestId,
        statusCode: status,
        reasonPhrase: STATUS_TEXT[status] ?? '',
        headers: headersToBidi(headers),
        body: { type: 'base64', value: body.toString('base64') },
      }).catch(ignoreGone);
    },
    continue: async (o: ContinueOptions) => {
      await wait();
      const params: Record<string, unknown> = { request: requestId };
      if (o.url !== undefined) params.url = o.url;
      if (o.method !== undefined) params.method = o.method;
      if (o.headers !== undefined) {
        const list = Object.entries(o.headers).filter(([, v]) => v !== undefined).map(([name, value]) => ({ name, value: String(value) }));
        params.headers = headersToBidi(list);
        // What actually goes out (CDP reports it as the request's raw headers; BiDi sends no new event).
        req.rawHeaders = list;
      }
      if (o.postData !== undefined) {
        const b = Buffer.isBuffer(o.postData) ? o.postData : Buffer.from(typeof o.postData === 'string' ? o.postData : JSON.stringify(o.postData));
        params.body = { type: 'base64', value: b.toString('base64') };
      }
      await bidi.send('network.continueRequest', params).catch(ignoreGone);
    },
  };
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 418: "I'm a teapot", 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

export class FfNetwork {
  private readonly requests = new Map<string, FfRequest>();
  private readonly documentRequests = new Map<string, Request>();
  private readonly inflight = new Map<FfRequest, number>();
  private lastActivity = Date.now();
  private readonly authAttempts = new Set<string>();
  /** Per-request event order (request bodies are fetched before the 'request' event). */
  private readonly ready = new Map<string, Promise<void>>();

  constructor(
    private readonly page: FfPage,
    private readonly bidi: BidiConnection,
  ) {}

  /** No request in flight for `quietMs` (requests pending for over 10 s count as long-polls). */
  isIdle(quietMs: number): boolean {
    const now = Date.now();
    for (const started of this.inflight.values()) if (now - started < 10_000) return false;
    return now - this.lastActivity >= quietMs;
  }

  documentResponse(navigationId: string): Response | null {
    let r = this.documentRequests.get(navigationId);
    while (r?.redirectedTo_) r = r.redirectedTo_;
    return r?.response_ ?? null;
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.page.notifyChange();
  }

  private frameFor(contextId: string | undefined): CrFrame | undefined {
    return contextId ? this.page.frameById(contextId) : undefined;
  }

  /**
   * Run a request's event handler in order: synchronously when nothing is pending for the
   * request (the WebSocket client delivers a burst of messages without a microtask in between,
   * so a deferred handler would fall behind the frame's lifecycle events), else after the pending
   * step (a request body being fetched).
   */
  private chain(id: string, fn: () => Promise<void> | void): void {
    const pending = this.ready.get(id);
    const fail = (e: unknown) => debugLog('browser', `network event failed: ${(e as Error).message}`);
    if (!pending) {
      let r: Promise<void> | void;
      try {
        r = fn();
      } catch (e) {
        fail(e);
        return;
      }
      if (r && typeof (r as Promise<void>).then === 'function') {
        const p = (r as Promise<void>).catch(fail).finally(() => {
          if (this.ready.get(id) === p) this.ready.delete(id);
        });
        this.ready.set(id, p);
      }
      return;
    }
    const next: Promise<void> = pending.then(fn, fn).catch(fail).finally(() => {
      if (this.ready.get(id) === next) this.ready.delete(id);
    });
    this.ready.set(id, next);
  }

  // -------------------------------------------------- events
  // Every event of a request goes through its per-request queue, in arrival order. Hops are
  // addressed by request id + redirectCount.

  private hop(e: any): FfRequest | undefined {
    return this.requests.get(`${e.request.request}:${e.redirectCount ?? 0}`);
  }

  onBeforeRequestSent(e: any): void {
    const id = String(e.request.request);
    this.chain(id, () => this.beforeRequestSent(e));
  }

  private beforeRequestSent(e: any): Promise<void> | void {
    const r = e.request;
    const id = String(r.request);
    const url = String(r.url);
    const count = Number(e.redirectCount ?? 0);
    const blocked = !!e.isBlocked && (e.intercepts?.length ?? 0) > 0;
    const existing = this.hop(e);
    if (existing) {
      // The same hop again (should not happen): only interception matters.
      if (blocked) void this.intercept(existing);
      return;
    }
    if (url.startsWith('data:') && r.destination !== 'document') {
      if (blocked) void this.bidi.send('network.continueRequest', { request: id }).catch(() => undefined);
      return;
    }
    const previous = count > 0 ? this.requests.get(`${id}:${count - 1}`) : undefined;
    if (previous) this.finish(previous, undefined);
    const isNav = !!e.navigation && resourceTypeOf(r) === 'document';
    const needsBody = (r.bodySize ?? 0) > 0 && !/^(GET|HEAD)$/i.test(String(r.method));
    if (needsBody) {
      return this.page.ffContext().requestBody(id).catch(() => undefined).then((post) => this.createHop(e, previous, isNav, post, blocked));
    }
    this.createHop(e, previous, isNav, undefined, blocked);
  }

  private createHop(e: any, previous: FfRequest | undefined, isNav: boolean, post: Buffer | undefined, blocked: boolean): void {
    const r = e.request;
    const id = String(r.request);
    const url = String(r.url);
    const count = Number(e.redirectCount ?? 0);
    const req = new Request(
      this, NO_CDP, `${id}:${count}`, url, String(r.method), headersFromBidi(r.headers), post, resourceTypeOf(r),
      this.frameFor(e.context), isNav, previous, (e.timestamp ?? Date.now()) / 1000, (e.timestamp ?? Date.now()) / 1000,
    ) as FfRequest;
    req.bidiId = id;
    req.redirectCount = count;
    req.timingInfo = timingOf(r.timings);
    req.loadBody = () => this.page.ffContext().responseBody(id);
    this.register(req, e.navigation);
    if (blocked) void this.intercept(req);
  }

  private register(req: FfRequest, navigation: string | null | undefined): void {
    this.requests.set(req.id, req);
    if (req.isNavigation && navigation && !this.documentRequests.has(navigation)) this.documentRequests.set(navigation, req);
    if (req.resourceType_ !== 'eventsource') this.inflight.set(req, Date.now());
    this.touch();
    this.page.emitRequestEvent('request', req);
  }

  onResponseStarted(e: any): void {
    this.chain(String(e.request.request), () => {
      const req = this.hop(e);
      if (!req) return;
      // After HTTP authentication the same hop answers again: the later response is the real one.
      const replaces = !!req.response_ && [401, 407].includes(req.response_.status()) && Number(e.response?.status) !== req.response_.status();
      if (req.response_ && !replaces) return;
      this.setResponse(req, e.response, replaces);
    });
  }

  private setResponse(req: FfRequest, r: any, replace = false): void {
    if (req.response_ && !replace) return;
    const res = new Response(req, Number(r.status), String(r.statusText ?? ''), headersFromBidi(r.headers), String(r.url ?? req.url_), undefined, undefined, false);
    res.encodedLength = Number(r.bodySize ?? r.bytesReceived ?? 0) || 0;
    req.response_ = res;
    req.responseDone.resolve(res);
    this.touch();
    this.page.emitRequestEvent('response', res);
  }

  onResponseCompleted(e: any): void {
    this.chain(String(e.request.request), () => {
      const req = this.hop(e);
      if (!req) return;
      if (!req.response_) this.setResponse(req, e.response);
      if (req.response_) req.response_.encodedLength = Number(e.response?.bodySize ?? e.response?.bytesReceived ?? req.response_.encodedLength) || 0;
      if (e.request?.timings) req.timingInfo = timingOf(e.request.timings);
      req.responseEndMs = Math.max(0, (e.timestamp ?? Date.now()) - req.wallTime);
      // A redirect hop is finished by the next hop's beforeRequestSent.
      const status = Number(e.response?.status ?? 0);
      if (status >= 300 && status < 400 && headersFromBidi(e.response?.headers).some((h) => h.name.toLowerCase() === 'location')) return;
      this.finish(req, undefined);
    });
  }

  onFetchError(e: any): void {
    this.chain(String(e.request.request), () => {
      const req = this.hop(e);
      if (!req) return;
      const text = req.abortText ?? netErrorText(e.errorText);
      debugLog('browser', `request failed ${req.url_}: ${e.errorText} -> ${text}`);
      req.failure_ = { errorText: text };
      const frame = this.page.frameById(String(e.context)) as unknown as { failedNavigations: Map<string, string>; lastFailure?: { text: string; at: number } } | undefined;
      if (frame && req.isNavigation) {
        if (e.navigation) frame.failedNavigations.set(e.navigation, text);
        frame.lastFailure = { text, at: Date.now() };
      }
      this.finish(req, text);
    });
  }

  private finish(req: FfRequest, failure: string | undefined): void {
    if (req.finished) return;
    req.finished = true;
    this.inflight.delete(req);
    this.touch();
    if (failure !== undefined) {
      req.response_?.finishedDone.resolve(new Error(failure));
      req.responseDone.resolve(req.response_ ?? null);
      this.page.emitRequestEvent('requestfailed', req);
    } else {
      req.response_?.finishedDone.resolve(null);
      req.responseDone.resolve(req.response_ ?? null);
      this.page.emitRequestEvent('requestfinished', req);
    }
    if (this.requests.size > 5000) {
      for (const [k, v] of this.requests) if (v.finished && this.requests.size > 4000) this.requests.delete(k);
    }
    if (this.ready.size > 5000) for (const k of [...this.ready.keys()].slice(0, 1000)) this.ready.delete(k);
  }

  // -------------------------------------------------- interception
  private async intercept(req: FfRequest): Promise<void> {
    const ctx = this.page.ffContext();
    const backend = bidiRouteBackend(this.bidi, req.bidiId, req, () => ctx.latency());
    const routed = this.page.routeEntries().length + ctx.routeEntries().length > 0 || ctx.hasClientCertificates();
    try {
      if (routed && !this.page.isClosed()) {
        req.routed = true;
        await runRouteChain(this.page, req, backend);
      } else {
        await backend.continue({});
      }
    } catch (e) {
      debugLog('browser', `interception of ${req.url_} failed: ${(e as Error).message}`);
      await backend.continue({}).catch(() => undefined);
    }
  }

  onAuthRequired(e: any): void {
    if (!e.isBlocked) return;
    const id = String(e.request.request);
    const creds = this.page.context().httpCredentials();
    let originOk = false;
    try {
      originOk = !!creds && (!creds.origin || new URL(String(e.request.url)).origin.toLowerCase() === creds.origin.toLowerCase());
    } catch {
      originOk = false;
    }
    if (creds && originOk && !this.authAttempts.has(id)) {
      this.authAttempts.add(id);
      void this.bidi.send('network.continueWithAuth', { request: id, action: 'provideCredentials', credentials: { type: 'password', username: creds.username, password: creds.password } }).catch(() => undefined);
      return;
    }
    // No (more) credentials: the page gets the 401 response, as in Chromium.
    void this.bidi.send('network.continueWithAuth', { request: id, action: 'cancel' }).catch(() => undefined);
  }
}
