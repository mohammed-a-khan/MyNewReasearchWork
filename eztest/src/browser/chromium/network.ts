/**
 * Network events and interception for one page (all of its target sessions):
 * Request / Response / Route / WebSocket objects, the request -> route
 * handler chain (Fetch domain), HTTP authentication, and the in-flight
 * request bookkeeping behind our `networkidle` rule.
 *
 * networkidle rule: the page has reached `load`, and no request (other than
 * EventSource streams and requests already pending for more than 10 s, which
 * are treated as long-polls) has been in flight for 500 ms.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { TypedEmitter } from '../events.js';
import type { CDPSession, ProtocolParams } from '../transport/connection.js';
import type { URLMatch } from '../types.js';
import { deferred, headersFromProtocol, headersToObject, mimeFor, urlMatches, type Deferred } from '../util.js';
import type { CrFrame } from './frame.js';
import type { CrPage } from './page.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Header {
  name: string;
  value: string;
}

export interface RequestTiming {
  startTime: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
}

function resourceTypeOf(cdpType: string | undefined): string {
  const t = (cdpType ?? 'Other').toLowerCase();
  const map: Record<string, string> = { xhr: 'xhr', fetch: 'fetch', document: 'document', stylesheet: 'stylesheet', image: 'image', media: 'media', font: 'font', script: 'script', texttrack: 'texttrack', eventsource: 'eventsource', websocket: 'websocket', manifest: 'manifest', ping: 'ping', prefetch: 'prefetch', preflight: 'preflight', cspviolationreport: 'other', signedexchange: 'other', other: 'other' };
  return map[t] ?? 'other';
}

export class Request {
  response_?: Response;
  failure_?: { errorText: string };
  redirectedTo_?: Request;
  rawHeaders?: Header[];
  responseEndMs = -1;
  finished = false;
  /** Fulfilled by a route (body known on our side). */
  fulfilledBody?: Buffer;
  readonly responseDone: Deferred<Response | null> = deferred();
  /** Set when this request was handed to route handlers. */
  routed = false;
  wallTime: number;
  timestamp: number;
  timingInfo?: any;

  /** Engine hook: fetch the response body (set by engines whose body comes from elsewhere than CDP). */
  loadBody?: () => Promise<Buffer>;

  constructor(
    readonly manager: NetworkManager | unknown,
    readonly session: CDPSession,
    readonly id: string,
    readonly url_: string,
    readonly method_: string,
    readonly headers_: Header[],
    readonly postData_: Buffer | undefined,
    readonly resourceType_: string,
    readonly frame_: CrFrame | undefined,
    readonly isNavigation: boolean,
    readonly redirectedFrom_: Request | undefined,
    wallTime: number | undefined,
    timestamp: number | undefined,
  ) {
    this.wallTime = (wallTime ?? Date.now() / 1000) * 1000;
    this.timestamp = timestamp ?? 0;
    if (redirectedFrom_) redirectedFrom_.redirectedTo_ = this;
  }

  url(): string {
    return this.url_;
  }

  method(): string {
    return this.method_;
  }

  headers(): Record<string, string> {
    return headersToObject(this.headers_.filter((h) => !h.name.startsWith(':')));
  }

  headersArray(): Header[] {
    return this.rawHeaders ?? this.headers_;
  }

  async allHeaders(): Promise<Record<string, string>> {
    if (!this.rawHeaders) await Promise.race([this.responseDone.promise, new Promise((r) => setTimeout(r, 1000))]);
    return headersToObject((this.rawHeaders ?? this.headers_).filter((h) => !h.name.startsWith(':')));
  }

  async headerValue(name: string): Promise<string | null> {
    const all = await this.allHeaders();
    return all[name.toLowerCase()] ?? null;
  }

  postData(): string | null {
    return this.postData_ ? this.postData_.toString('utf8') : null;
  }

  postDataBuffer(): Buffer | null {
    return this.postData_ ?? null;
  }

  postDataJSON(): unknown {
    const s = this.postData();
    if (s === null) return null;
    const ct = this.headers()['content-type'] ?? '';
    if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(s));
    return JSON.parse(s);
  }

  resourceType(): string {
    return this.resourceType_;
  }

  frame(): CrFrame {
    if (!this.frame_) throw new Error('Service Worker requests do not have an associated frame.');
    return this.frame_;
  }

  isNavigationRequest(): boolean {
    return this.isNavigation;
  }

  redirectedFrom(): Request | null {
    return this.redirectedFrom_ ?? null;
  }

  redirectedTo(): Request | null {
    return this.redirectedTo_ ?? null;
  }

  async response(): Promise<Response | null> {
    return this.responseDone.promise;
  }

  failure(): { errorText: string } | null {
    return this.failure_ ?? null;
  }

  serviceWorker(): null {
    return null;
  }

  timing(): RequestTiming {
    const t = this.timingInfo;
    const rel = (v: number | undefined) => (v === undefined || v < 0 ? -1 : v);
    if (!t) {
      return {
        startTime: this.wallTime, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1, connectEnd: -1,
        requestStart: -1, responseStart: -1, responseEnd: this.responseEndMs,
      };
    }
    return {
      startTime: this.wallTime,
      domainLookupStart: rel(t.dnsStart),
      domainLookupEnd: rel(t.dnsEnd),
      connectStart: rel(t.connectStart),
      secureConnectionStart: rel(t.sslStart),
      connectEnd: rel(t.connectEnd),
      requestStart: rel(t.sendStart),
      responseStart: rel(t.receiveHeadersEnd),
      responseEnd: this.responseEndMs,
    };
  }

  async sizes(): Promise<{ requestBodySize: number; requestHeadersSize: number; responseBodySize: number; responseHeadersSize: number }> {
    const res = this.response_;
    return {
      requestBodySize: this.postData_?.length ?? 0,
      requestHeadersSize: this.headers_.reduce((n, h) => n + h.name.length + h.value.length + 4, 0),
      responseBodySize: res?.encodedLength ?? 0,
      responseHeadersSize: res ? res.headersArrayRaw().reduce((n, h) => n + h.name.length + h.value.length + 4, 0) : 0,
    };
  }

  toString(): string {
    return `<Request url=${JSON.stringify(this.url_)} method=${this.method_}>`;
  }
}

export class Response {
  private raw_?: Header[];
  /** Set when the browser announced raw headers (Network.responseReceivedExtraInfo) that may arrive after the response. */
  private rawExpected_?: Deferred<void>;
  readonly finishedDone: Deferred<Error | null> = deferred();
  encodedLength = 0;

  get rawHeaders(): Header[] | undefined {
    return this.raw_;
  }

  set rawHeaders(h: Header[] | undefined) {
    this.raw_ = h;
    if (h) this.rawExpected_?.resolve();
  }

  /** The raw headers (with Set-Cookie and other headers the summary leaves out) will follow in an extra-info event. */
  expectRawHeaders(): void {
    if (!this.raw_ && !this.rawExpected_) this.rawExpected_ = deferred();
  }

  /** Wait (bounded) for announced raw headers; full Chrome often sends them after the response event. */
  private async rawReady(): Promise<void> {
    if (this.raw_ || !this.rawExpected_) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.rawExpected_.promise,
      this.finishedDone.promise.then(() => new Promise<void>((r) => { timer = setTimeout(r, 250); })),
      new Promise<void>((r) => { timer = setTimeout(r, 2000); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  constructor(
    readonly request_: Request,
    readonly status_: number,
    readonly statusText_: string,
    readonly headers_: Header[],
    readonly url_: string,
    readonly remote?: { ipAddress?: string; port?: number },
    readonly security?: any,
    readonly fromServiceWorker_ = false,
  ) {}

  url(): string {
    return this.url_;
  }

  status(): number {
    return this.status_;
  }

  statusText(): string {
    return this.statusText_;
  }

  ok(): boolean {
    return this.status_ === 0 || (this.status_ >= 200 && this.status_ <= 299);
  }

  headers(): Record<string, string> {
    return headersToObject(this.headers_);
  }

  headersArrayRaw(): Header[] {
    return this.rawHeaders ?? this.headers_;
  }

  async headersArray(): Promise<Header[]> {
    await this.rawReady();
    return this.headersArrayRaw();
  }

  async allHeaders(): Promise<Record<string, string>> {
    await this.rawReady();
    return headersToObject(this.headersArrayRaw());
  }

  async headerValue(name: string): Promise<string | null> {
    const vals = await this.headerValues(name);
    return vals.length ? vals.join(name.toLowerCase() === 'set-cookie' ? '\n' : ', ') : null;
  }

  async headerValues(name: string): Promise<string[]> {
    const n = name.toLowerCase();
    await this.rawReady();
    return this.headersArrayRaw().filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
  }

  request(): Request {
    return this.request_;
  }

  frame(): CrFrame {
    return this.request_.frame();
  }

  fromServiceWorker(): boolean {
    return this.fromServiceWorker_;
  }

  async finished(): Promise<Error | null> {
    return this.finishedDone.promise;
  }

  async serverAddr(): Promise<{ ipAddress: string; port: number } | null> {
    return this.remote?.ipAddress ? { ipAddress: this.remote.ipAddress, port: this.remote.port ?? 0 } : null;
  }

  async securityDetails(): Promise<Record<string, unknown> | null> {
    if (!this.security) return null;
    return {
      protocol: this.security.protocol,
      subjectName: this.security.subjectName,
      issuer: this.security.issuer,
      validFrom: this.security.validFrom,
      validTo: this.security.validTo,
    };
  }

  async body(): Promise<Buffer> {
    const req = this.request_;
    if (req.redirectedTo_) throw new Error('Response body is unavailable for redirect responses');
    const err = await this.finishedDone.promise;
    if (req.fulfilledBody) return req.fulfilledBody;
    if (err) throw err;
    if (req.loadBody) return req.loadBody();
    const r = await req.session.send('Network.getResponseBody', { requestId: req.id });
    return Buffer.from(r.body as string, r.base64Encoded ? 'base64' : 'utf8');
  }

  async text(): Promise<string> {
    return (await this.body()).toString('utf8');
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  toString(): string {
    return `<Response url=${JSON.stringify(this.url_)} status=${this.status_}>`;
  }
}

// ---------------------------------------------------------------------- routing

export interface FulfillOptions {
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | Buffer;
  json?: unknown;
  path?: string;
  /** Use an existing response (e.g. from route.fetch()). */
  response?: { status(): number; headers(): Record<string, string>; body(): Promise<Buffer> };
}

export interface ContinueOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string | Buffer | unknown;
}

type RouteOutcome = { kind: 'handled' } | { kind: 'fallback'; overrides: ContinueOptions };

const ABORT_REASONS: Record<string, string> = {
  aborted: 'Aborted', accessdenied: 'AccessDenied', addressunreachable: 'AddressUnreachable', blockedbyclient: 'BlockedByClient',
  blockedbyresponse: 'BlockedByResponse', connectionaborted: 'ConnectionAborted', connectionclosed: 'ConnectionClosed',
  connectionfailed: 'ConnectionFailed', connectionrefused: 'ConnectionRefused', connectionreset: 'ConnectionReset',
  internetdisconnected: 'InternetDisconnected', namenotresolved: 'NameNotResolved', timedout: 'TimedOut', failed: 'Failed',
};

/**
 * What a Route does in the browser: the engine-specific half of request
 * interception (CDP Fetch domain, WebDriver BiDi network.* commands).
 */
export interface RouteBackend {
  /** Fail the request; `reason` is a key of ABORT_REASONS (lower case). */
  abort(reason: string): Promise<void>;
  fulfill(status: number, headers: Header[], body: Buffer): Promise<void>;
  continue(overrides: ContinueOptions): Promise<void>;
}

/** The CDP Fetch-domain backend for one paused request. */
export function cdpRouteBackend(session: CDPSession, fetchRequestId: string, request: Request): RouteBackend {
  return {
    abort: async (reason) => {
      await session.send('Fetch.failRequest', { requestId: fetchRequestId, errorReason: ABORT_REASONS[reason] ?? 'Failed' }).catch(() => undefined);
    },
    fulfill: async (status, responseHeaders, body) => {
      await session.send('Fetch.fulfillRequest', {
        requestId: fetchRequestId,
        responseCode: status,
        responseHeaders,
        body: body.toString('base64'),
      }).catch((e: Error) => {
        if (!/Invalid InterceptionId|Target closed|has been closed/.test(e.message)) throw e;
      });
    },
    continue: (o) => continueRequest(session, fetchRequestId, o, request),
  };
}

export class Route {
  private done = false;
  /** Resolved with the handler's outcome. */
  readonly outcome: Deferred<RouteOutcome> = deferred();

  constructor(
    private readonly request_: Request,
    private readonly backend: RouteBackend,
    private readonly overrides: ContinueOptions,
  ) {}

  request(): Request {
    return this.request_;
  }

  private claim(api: string): void {
    if (this.done) throw new Error(`${api}: Route is already handled!`);
    this.done = true;
  }

  async abort(errorCode = 'failed'): Promise<void> {
    this.claim('route.abort');
    const reason = ABORT_REASONS[errorCode.toLowerCase()];
    if (!reason) throw new Error(`route.abort: Invalid error code "${errorCode}"`);
    await this.backend.abort(errorCode.toLowerCase());
    this.outcome.resolve({ kind: 'handled' });
  }

  async fulfill(options: FulfillOptions = {}): Promise<void> {
    this.claim('route.fulfill');
    let status = options.status ?? 200;
    let headers: Record<string, string> = {};
    let body: Buffer;
    if (options.response) {
      status = options.status ?? options.response.status();
      headers = { ...options.response.headers() };
      body = options.body !== undefined ? Buffer.from(options.body as string) : await options.response.body();
    } else if (options.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json));
      headers['content-type'] = 'application/json';
    } else if (options.path) {
      body = await readFile(options.path);
      headers['content-type'] = mimeFor(basename(options.path));
    } else if (typeof options.body === 'string') {
      body = Buffer.from(options.body, 'utf8');
      headers['content-type'] = 'text/plain';
    } else {
      body = options.body ?? Buffer.alloc(0);
    }
    for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = String(v);
    if (options.headers && !Object.keys(options.headers).some((k) => k.toLowerCase() === 'content-type') && !options.contentType && (options.body !== undefined || options.json !== undefined || options.path)) {
      // keep the inferred content type
    }
    if (options.contentType) headers['content-type'] = options.contentType;
    if (!('content-length' in headers) && !options.response) headers['content-length'] = String(body.length);
    else if (options.response) {
      delete headers['content-length'];
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
    }
    this.request_.fulfilledBody = body;
    const responseHeaders = Object.entries(headers).flatMap(([name, value]) => String(value).split('\n').map((v) => ({ name, value: v })));
    await this.backend.fulfill(status, responseHeaders, body);
    this.outcome.resolve({ kind: 'handled' });
  }

  async continue(options: ContinueOptions = {}): Promise<void> {
    this.claim('route.continue');
    await this.backend.continue({ ...this.overrides, ...stripUndefined(options) });
    this.outcome.resolve({ kind: 'handled' });
  }

  async fallback(options: ContinueOptions = {}): Promise<void> {
    this.claim('route.fallback');
    this.outcome.resolve({ kind: 'fallback', overrides: { ...this.overrides, ...stripUndefined(options) } });
  }

  /** Perform the request from Node (cookies of the page are not sent) and return the response. */
  async fetch(options: ContinueOptions & { timeout?: number } = {}): Promise<FetchedResponse> {
    const o = { ...this.overrides, ...stripUndefined(options) };
    const headers = o.headers ?? this.request_.headers();
    const method = o.method ?? this.request_.method();
    const post = o.postData !== undefined ? postDataBuffer(o.postData) : this.request_.postDataBuffer();
    const res = await fetch(o.url ?? this.request_.url(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' || !post ? undefined : new Uint8Array(post),
      redirect: 'manual',
      signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      h[k] = v;
    });
    return new FetchedResponse(res.status, res.statusText, h, buf, res.url || this.request_.url());
  }
}

export class FetchedResponse {
  constructor(
    private readonly status_: number,
    private readonly statusText_: string,
    private readonly headers_: Record<string, string>,
    private readonly body_: Buffer,
    private readonly url_: string,
  ) {}
  status(): number {
    return this.status_;
  }
  statusText(): string {
    return this.statusText_;
  }
  ok(): boolean {
    return this.status_ >= 200 && this.status_ <= 299;
  }
  url(): string {
    return this.url_;
  }
  headers(): Record<string, string> {
    return { ...this.headers_ };
  }
  headersArray(): Header[] {
    return Object.entries(this.headers_).map(([name, value]) => ({ name, value }));
  }
  async body(): Promise<Buffer> {
    return this.body_;
  }
  async text(): Promise<string> {
    return this.body_.toString('utf8');
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.body_.toString('utf8'));
  }
  async dispose(): Promise<void> {
    /* nothing to free */
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function postDataBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(JSON.stringify(v), 'utf8');
}

async function continueRequest(session: CDPSession, fetchRequestId: string, o: ContinueOptions, request: Request): Promise<void> {
  const params: ProtocolParams = { requestId: fetchRequestId };
  if (o.url !== undefined) params.url = o.url;
  if (o.method !== undefined) params.method = o.method;
  if (o.postData !== undefined) params.postData = postDataBuffer(o.postData).toString('base64');
  if (o.headers !== undefined) {
    params.headers = Object.entries(o.headers).filter(([, v]) => v !== undefined).map(([name, value]) => ({ name, value: String(value) }));
    // Keep request headers' original casing semantics: header names are case-insensitive.
  }
  void request;
  await session.send('Fetch.continueRequest', params).catch((e: Error) => {
    if (!/Invalid InterceptionId|Target closed|has been closed|Invalid state/.test(e.message)) throw e;
  });
}

export type RouteHandlerFn = (route: Route, request: Request) => unknown;

export interface RouteEntry {
  url: URLMatch;
  handler: RouteHandlerFn;
  times?: number;
  count: number;
}

/**
 * The request -> route handler chain, shared by the engines: page routes,
 * then context routes (last registered first), each handler fulfilling,
 * aborting, continuing or falling back to the next; then client
 * certificates; then the browser continues the request.
 */
export async function runRouteChain(page: CrPage, req: Request, backend: RouteBackend): Promise<void> {
  const ctx = page.context();
  // Client certificates: requests to configured origins are performed from Node.
  const cert = ctx.clientCertificateFor(req.url_);
  const handlers = [...page.routeEntries(), ...ctx.routeEntries()];
  let overrides: ContinueOptions = {};
  for (const entry of handlers) {
    if (!urlMatches(ctx.baseURL(), req.url_, entry.url)) continue;
    if (entry.times !== undefined && entry.count >= entry.times) continue;
    entry.count++;
    const route = new Route(req, backend, overrides);
    try {
      await entry.handler(route, req);
    } catch (err) {
      if (!route.outcome.settled) {
        // A throwing handler: let the request continue so the page does not hang, then report.
        await backend.continue(overrides);
        queueMicrotask(() => {
          throw err;
        });
        return;
      }
    }
    const out = await route.outcome.promise;
    if (out.kind === 'handled') return;
    overrides = out.overrides;
  }
  if (cert && !page.isClosed()) {
    try {
      await cert(req, overrides, async (status, headers, body) => {
        const responseHeaders = Object.entries(headers).flatMap(([name, value]) => String(value).split('\n').map((v) => ({ name, value: v })));
        req.fulfilledBody = body;
        await backend.fulfill(status, responseHeaders, body);
      });
      return;
    } catch (err) {
      await backend.abort('connectionfailed').catch(() => undefined);
      page.reportDriverWarning(`client certificate request to ${req.url_} failed: ${(err as Error).message}`);
      return;
    }
  }
  await backend.continue(overrides);
}

// ---------------------------------------------------------------------- websockets

export interface WebSocketEvents {
  close: WebSocket;
  framesent: { payload: string | Buffer };
  framereceived: { payload: string | Buffer };
  socketerror: string;
}

export class WebSocket extends TypedEmitter<WebSocketEvents> {
  closed = false;
  constructor(private readonly url_: string) {
    super();
  }
  url(): string {
    return this.url_;
  }
  isClosed(): boolean {
    return this.closed;
  }
}

// ---------------------------------------------------------------------- manager

/**
 * The browser's own favicon fetch (full Chrome asks for /favicon.ico; the
 * headless shell does not). It is not page traffic: it gets no request
 * events, is not routed and does not count for networkidle, as in Firefox
 * (browser.chrome.site_icons is off there). A page's own fetch of the same
 * URL has another resource type and is reported as usual.
 */
export function isBrowserFavicon(url: string, resourceType: string | undefined): boolean {
  if (resourceType !== undefined && resourceType !== 'Other') return false;
  try {
    return new URL(url).pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

interface PendingPause {
  event: any;
  session: CDPSession;
}

export class NetworkManager {
  private readonly requests = new Map<string, Request>();
  private readonly pausedByNetworkId = new Map<string, PendingPause>();
  private readonly extraInfo = new Map<string, Header[][]>();
  private readonly responseExtraInfo = new Map<string, Array<{ headers: Header[]; status?: number }>>();
  private readonly documentRequests = new Map<string, Request>();
  private readonly sockets = new Map<string, WebSocket>();
  private readonly inflight = new Map<string, number>();
  private lastActivity = Date.now();
  private readonly authAttempts = new Set<string>();
  private readonly ignored = new Set<string>();

  constructor(private readonly page: CrPage) {}

  /** No request in flight for `quietMs` (see the networkidle rule above). */
  isIdle(quietMs: number): boolean {
    const now = Date.now();
    for (const started of this.inflight.values()) if (now - started < 10_000) return false;
    return now - this.lastActivity >= quietMs;
  }

  documentResponse(loaderId: string): Response | null {
    const req = this.documentRequests.get(loaderId);
    let r = req;
    while (r?.redirectedTo_) r = r.redirectedTo_;
    return r?.response_ ?? null;
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.page.notifyChange();
  }

  private frameFor(frameId: string | undefined): CrFrame | undefined {
    return frameId ? this.page.frameById(frameId) : undefined;
  }

  // -------------------------------------------------- Network domain
  onRequestWillBeSent(session: CDPSession, e: any): void {
    if (e.request.url.startsWith('data:') && e.type !== 'Document') return;
    // The favicon fetch and every redirect hop of it (same requestId) stay invisible.
    if (this.ignored.has(e.requestId) || (isBrowserFavicon(e.request.url, e.type) && !this.requests.has(e.requestId))) {
      this.ignored.add(e.requestId);
      return;
    }
    let redirectedFrom: Request | undefined;
    const existing = this.requests.get(e.requestId);
    if (e.redirectResponse && existing) {
      this.handleResponse(existing, e.redirectResponse, e.timestamp, !!e.redirectHasExtraInfo);
      this.finish(existing, e.timestamp, undefined);
      redirectedFrom = existing;
    } else if (existing && !existing.finished && existing.url_ === e.request.url && !existing.response_) {
      // Already created from an interception event: nothing new.
      return;
    }
    const headers = headersFromProtocol(e.request.headers);
    let post: Buffer | undefined;
    if (e.request.postDataEntries) post = Buffer.concat((e.request.postDataEntries as Array<{ bytes?: string }>).map((x) => Buffer.from(x.bytes ?? '', 'base64')));
    else if (e.request.postData !== undefined) post = Buffer.from(e.request.postData, 'utf8');
    const isNav = e.type === 'Document' && e.requestId === e.loaderId;
    const req = new Request(
      this, session, e.requestId, e.request.url + (e.request.urlFragment ?? ''), e.request.method, headers, post, resourceTypeOf(e.type),
      this.frameFor(e.frameId), isNav, redirectedFrom, e.wallTime, e.timestamp,
    );
    this.register(req, e.loaderId);
    const info = this.extraInfo.get(e.requestId)?.shift();
    if (info) req.rawHeaders = info;
    // An interception event that arrived first for this hop.
    const paused = this.pausedByNetworkId.get(e.requestId);
    if (paused && paused.event.request.url + (paused.event.request.urlFragment ?? '') === req.url_) {
      this.pausedByNetworkId.delete(e.requestId);
      void this.route(req, paused.session, paused.event);
    }
  }

  private register(req: Request, loaderId: string | undefined): void {
    this.requests.set(req.id, req);
    if (req.isNavigation && loaderId) this.documentRequests.set(loaderId, req);
    if (req.resourceType_ !== 'eventsource') this.inflight.set(req.id, Date.now());
    this.touch();
    this.page.emitRequestEvent('request', req);
  }

  onRequestWillBeSentExtraInfo(e: any): void {
    if (this.ignored.has(e.requestId)) return;
    const headers = headersFromProtocol(e.headers);
    const req = this.requests.get(e.requestId);
    if (req && !req.rawHeaders && !req.response_) {
      req.rawHeaders = headers;
      return;
    }
    const q = this.extraInfo.get(e.requestId) ?? [];
    q.push(headers);
    this.extraInfo.set(e.requestId, q);
  }

  onResponseReceivedExtraInfo(e: any): void {
    if (this.ignored.has(e.requestId)) return;
    const headers = headersFromProtocol(e.headers);
    const req = this.requests.get(e.requestId);
    if (req?.response_ && !req.response_.rawHeaders) {
      req.response_.rawHeaders = headers;
      return;
    }
    // Raw headers of a redirect that arrive after the redirect was reported belong to the previous hop.
    const prev = req?.redirectedFrom_;
    if (req && !req.response_ && prev?.response_ && !prev.response_.rawHeaders && (e.statusCode === undefined || e.statusCode === prev.response_.status())) {
      prev.response_.rawHeaders = headers;
      return;
    }
    const q = this.responseExtraInfo.get(e.requestId) ?? [];
    q.push({ headers, status: e.statusCode });
    this.responseExtraInfo.set(e.requestId, q);
  }

  onResponseReceived(e: any): void {
    const req = this.requests.get(e.requestId);
    if (!req) return;
    this.handleResponse(req, e.response, e.timestamp, !!e.hasExtraInfo);
  }

  private handleResponse(req: Request, r: any, _timestamp: number, hasExtraInfo = false): void {
    if (req.response_) return;
    req.timingInfo = r.timing;
    const res = new Response(
      req, r.status, r.statusText ?? '', headersFromProtocol(r.headers), r.url ?? req.url_,
      { ipAddress: r.remoteIPAddress, port: r.remotePort }, r.securityDetails, !!r.fromServiceWorker,
    );
    const q = this.responseExtraInfo.get(req.id);
    if (q?.length && (q[0].status === undefined || q[0].status === r.status)) res.rawHeaders = q.shift()!.headers;
    else if (hasExtraInfo) res.expectRawHeaders();
    res.encodedLength = r.encodedDataLength ?? 0;
    req.response_ = res;
    req.responseDone.resolve(res);
    this.touch();
    this.page.emitRequestEvent('response', res);
  }

  onLoadingFinished(e: any): void {
    if (this.ignored.delete(e.requestId)) return;
    const req = this.requests.get(e.requestId);
    if (!req) return;
    if (req.response_) req.response_.encodedLength = e.encodedDataLength ?? req.response_.encodedLength;
    this.finish(req, e.timestamp, undefined);
  }

  onLoadingFailed(e: any): void {
    if (this.ignored.delete(e.requestId)) return;
    const req = this.requests.get(e.requestId);
    if (!req) return;
    req.failure_ = { errorText: e.errorText || (e.canceled ? 'net::ERR_ABORTED' : 'net::ERR_FAILED') };
    if (e.blockedReason && !e.errorText) req.failure_.errorText = `net::ERR_BLOCKED_BY_${String(e.blockedReason).toUpperCase()}`;
    this.finish(req, e.timestamp, req.failure_.errorText);
  }

  private finish(req: Request, timestamp: number | undefined, failure: string | undefined): void {
    if (req.finished) return;
    req.finished = true;
    const base = req.timingInfo?.requestTime ?? req.timestamp;
    if (timestamp && base) req.responseEndMs = (timestamp - base) * 1000;
    this.inflight.delete(req.id);
    if (this.requests.get(req.id) === req && failure !== undefined) this.requests.delete(req.id);
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
  }

  onServedFromCache(_e: any): void {
    /* timing only */
  }

  // -------------------------------------------------- WebSocket
  onWebSocketCreated(e: any): void {
    const ws = new WebSocket(e.url);
    this.sockets.set(e.requestId, ws);
    this.page.emitWebSocket(ws);
  }

  onWebSocketFrame(e: any, direction: 'framesent' | 'framereceived'): void {
    const ws = this.sockets.get(e.requestId);
    if (!ws) return;
    const r = e.response;
    const payload = r.opcode === 2 ? Buffer.from(r.payloadData, 'base64') : r.payloadData;
    ws.emitEvent(direction, { payload });
  }

  onWebSocketError(e: any): void {
    this.sockets.get(e.requestId)?.emitEvent('socketerror', e.errorMessage);
  }

  onWebSocketClosed(e: any): void {
    const ws = this.sockets.get(e.requestId);
    if (!ws) return;
    ws.closed = true;
    this.sockets.delete(e.requestId);
    ws.emitEvent('close', ws);
  }

  // -------------------------------------------------- Fetch domain (interception)
  onRequestPaused(session: CDPSession, e: any): void {
    const networkId = e.networkId as string | undefined;
    const url = e.request.url + (e.request.urlFragment ?? '');
    if ((networkId && this.ignored.has(networkId)) || (isBrowserFavicon(url, e.resourceType) && !(networkId && this.requests.has(networkId)))) {
      void session.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
      return;
    }
    if (networkId) {
      const req = this.requests.get(networkId);
      if (req && !req.routed && !req.finished && req.url_ === url && !req.response_) {
        void this.route(req, session, e);
        return;
      }
      this.pausedByNetworkId.set(networkId, { event: e, session });
      // If the Network event never comes (e.g. the request is invisible to the Network domain), route with a synthetic request.
      setTimeout(() => {
        const p = this.pausedByNetworkId.get(networkId);
        if (p !== undefined && p.event === e) {
          this.pausedByNetworkId.delete(networkId);
          void this.route(this.syntheticRequest(session, e, networkId), session, e);
        }
      }, 200);
      return;
    }
    void this.route(this.syntheticRequest(session, e, e.requestId), session, e);
  }

  private syntheticRequest(session: CDPSession, e: any, id: string): Request {
    const post = e.request.postDataEntries
      ? Buffer.concat((e.request.postDataEntries as Array<{ bytes?: string }>).map((x) => Buffer.from(x.bytes ?? '', 'base64')))
      : e.request.postData !== undefined ? Buffer.from(e.request.postData, 'utf8') : undefined;
    const req = new Request(
      this, session, id, e.request.url + (e.request.urlFragment ?? ''), e.request.method, headersFromProtocol(e.request.headers), post,
      resourceTypeOf(e.resourceType), this.frameFor(e.frameId), e.resourceType === 'Document' && !!this.frameFor(e.frameId), undefined, undefined, undefined,
    );
    if (!this.requests.has(id)) this.register(req, undefined);
    return req;
  }

  /** Run the route handler chain for a paused request. */
  private async route(req: Request, session: CDPSession, e: any): Promise<void> {
    req.routed = true;
    await runRouteChain(this.page, req, cdpRouteBackend(session, e.requestId as string, req));
  }

  onAuthRequired(session: CDPSession, e: any): void {
    const creds = this.page.context().httpCredentials();
    const key = e.requestId as string;
    let response: 'Default' | 'ProvideCredentials' | 'CancelAuth' = 'CancelAuth';
    if (creds && !this.authAttempts.has(key)) {
      const originOk = !creds.origin || new URL(e.request.url).origin.toLowerCase() === creds.origin.toLowerCase();
      if (originOk) {
        response = 'ProvideCredentials';
        this.authAttempts.add(key);
      }
    }
    void session.send('Fetch.continueWithAuth', {
      requestId: e.requestId,
      authChallengeResponse: response === 'ProvideCredentials' ? { response, username: creds!.username, password: creds!.password } : { response },
    }).catch(() => undefined);
  }
}
