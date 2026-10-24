/**
 * Browser and BrowserContext over CDP, downloads, and the Chromium
 * BrowserType (launch / connectOverCDP / launchPersistentContext).
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync, type ReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debugLog } from '../debug.js';
import { TypedEmitter } from '../events.js';
import { TargetClosedError, isClosedError } from '../errors.js';
import { DOWNLOADS_OFF_TEXT, bindingTakenMessage, closedMessage } from '../messages.js';
import { routeFromHAR, type RouteFromHAROptions } from '../har.js';
import { launchChromiumProcess, resolveBrowserWsEndpoint, stderrTailOf, type LaunchedProcess } from '../launcher/launch.js';
import { findChromium } from '../launcher/find.js';
import { Tracing } from '../tracing.js';
import { APIRequestContext } from '../request.js';
import { CDPConnection, type CDPSession } from '../transport/connection.js';
import { WebSocketTransport } from '../transport/transport.js';
import type { BrowserContextOptions, ClientCertificate, Cookie, Geolocation, HTTPCredentials, LaunchOptions, SetCookie, StorageState, URLMatch } from '../types.js';
import { deferred, sleep, urlMatches, withTimeout, type Deferred } from '../util.js';
import { clientCertificateFetcher, type CertFetcher } from './client-certs.js';
import type { Vp8Encoder } from '../video/webm.js';
import type { ChromiumFrame } from './frame.js';
import type { ContinueOptions, Request, Response, RouteEntry, RouteHandlerFn } from './network.js';
import { ChromiumPage, bindingSource, initScriptSource, type BindingEntry, type ConsoleMessage, type Dialog, Worker } from './page.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------- downloads

export class Download {
  private readonly done: Deferred<'completed' | 'canceled'> = deferred();
  constructor(
    private readonly page_: ChromiumPage,
    private readonly url_: string,
    private readonly suggested: string,
    private readonly file: string,
    private readonly browser: ChromiumBrowser,
    private readonly guid: string,
    private readonly accepted: boolean,
  ) {}
  /** Internal: progress state from the browser. */
  onState(state: string): void {
    if (state === 'completed') this.done.resolve('completed');
    else if (state === 'canceled') this.done.resolve('canceled');
  }
  page(): ChromiumPage {
    return this.page_;
  }
  url(): string {
    return this.url_;
  }
  suggestedFilename(): string {
    return this.suggested;
  }
  async path(): Promise<string | null> {
    if (!this.accepted) throw new Error(DOWNLOADS_OFF_TEXT);
    const s = await this.done.promise;
    return s === 'completed' ? this.file : null;
  }
  async failure(): Promise<string | null> {
    if (!this.accepted) return DOWNLOADS_OFF_TEXT;
    const s = await this.done.promise;
    return s === 'completed' ? null : 'canceled';
  }
  async saveAs(path: string): Promise<void> {
    if (!this.accepted) throw new Error(DOWNLOADS_OFF_TEXT);
    const s = await this.done.promise;
    if (s !== 'completed') throw new Error('download.saveAs: the download did not complete (it was canceled or failed), so there is no file to save');
    await mkdir(dirname(path), { recursive: true });
    await copyFile(this.file, path);
  }
  async createReadStream(): Promise<ReadStream> {
    const p = await this.path();
    if (!p) throw new Error('download.createReadStream: the download did not complete, so there is no file to read');
    return createReadStream(p);
  }
  async delete(): Promise<void> {
    await this.done.promise.catch(() => undefined);
    await rm(this.file, { force: true });
  }
  async cancel(): Promise<void> {
    await this.browser.connection.root.send('Browser.cancelDownload', { guid: this.guid, browserContextId: this.page_.context().id }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------- context

const PERMISSIONS: Record<string, string[]> = {
  geolocation: ['geolocation'],
  midi: ['midi'],
  'midi-sysex': ['midiSysex'],
  notifications: ['notifications'],
  camera: ['videoCapture'],
  microphone: ['audioCapture'],
  'background-sync': ['backgroundSync'],
  'ambient-light-sensor': ['sensors'],
  accelerometer: ['sensors'],
  gyroscope: ['sensors'],
  magnetometer: ['sensors'],
  'clipboard-read': ['clipboardReadWrite'],
  'clipboard-write': ['clipboardSanitizedWrite'],
  'payment-handler': ['paymentHandler'],
  'storage-access': ['storageAccess'],
  'local-fonts': ['localFonts'],
  'persistent-storage': ['durableStorage'],
  'screen-wake-lock': ['wakeLockScreen'],
  'idle-detection': ['idleDetection'],
  'window-management': ['windowManagement'],
  'top-level-storage-access': ['topLevelStorageAccess'],
};

export interface ContextEvents {
  close: ChromiumContext;
  page: ChromiumPage;
  request: Request;
  response: Response;
  requestfinished: Request;
  requestfailed: Request;
  console: ConsoleMessage;
  dialog: Dialog;
  weberror: { page(): ChromiumPage; error(): Error };
  serviceworker: Worker;
  backgroundpage: ChromiumPage;
}

export class ChromiumContext extends TypedEmitter<ContextEvents> {
  readonly pages_ = new Set<ChromiumPage>();
  protected readonly pageWaiters = new Map<string, Deferred<ChromiumPage>>();
  protected readonly routes: RouteEntry[] = [];
  protected readonly initScripts: string[] = [];
  protected readonly bindings = new Map<string, BindingEntry>();
  protected extraHeaders: Record<string, string>;
  protected offline: boolean;
  protected credentials?: HTTPCredentials;
  protected geo?: Geolocation;
  private defaultTimeout_?: number;
  private defaultNavigationTimeout_?: number;
  protected closed = false;
  protected downloadsReady = false;
  readonly tracing: Tracing;
  readonly request: APIRequestContext;
  readonly serviceWorkers_ = new Set<Worker>();
  private readonly certFetcher?: CertFetcher;
  /** True for the browser's default context (connectOverCDP, persistent, Electron). */
  readonly isDefault: boolean;
  /** Owner page for browser.newPage() contexts (closed with the page). */
  ownerPage?: ChromiumPage;

  constructor(
    protected readonly browser_: ChromiumBrowser,
    readonly id: string | undefined,
    readonly options: BrowserContextOptions,
  ) {
    super();
    this.isDefault = id === undefined;
    this.extraHeaders = Object.fromEntries(Object.entries(options.extraHTTPHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.offline = !!options.offline;
    this.credentials = options.httpCredentials;
    this.geo = options.geolocation;
    this.tracing = new Tracing(this);
    this.request = new APIRequestContext(this);
    if (options.clientCertificates?.length) this.certFetcher = clientCertificateFetcher(options.clientCertificates, this);
  }

  protected override eventTimeout(): number {
    return this.defaultTimeout();
  }

  /** Internal: apply options that live in the browser (downloads, permissions, storage state). */
  async initialize(): Promise<void> {
    await this.applyDownloadBehavior();
    if (this.options.permissions?.length) await this.grantPermissions(this.options.permissions);
    if (this.options.storageState) await this.loadStorageState(this.options.storageState);
  }

  downloadBehaviorPending(): boolean {
    return !this.downloadsReady;
  }

  async applyDownloadBehavior(): Promise<void> {
    if (this.downloadsReady) return;
    this.downloadsReady = true;
    await this.browser_.connection.root.send('Browser.setDownloadBehavior', {
      behavior: this.options.acceptDownloads === false ? 'deny' : 'allowAndName',
      ...(this.id ? { browserContextId: this.id } : {}),
      downloadPath: this.browser_.downloadsDir,
      eventsEnabled: true,
    }).catch(() => undefined);
  }

  browser(): ChromiumBrowser {
    return this.browser_;
  }

  pages(): ChromiumPage[] {
    return [...this.pages_].filter((p) => p.initialized && !p.isClosed());
  }

  baseURL(): string | undefined {
    return this.options.baseURL;
  }

  userAgent(): string {
    return this.options.userAgent ?? this.browser_.defaultUserAgent();
  }

  extraHTTPHeaders(): Record<string, string> {
    return this.extraHeaders;
  }

  isOffline(): boolean {
    return this.offline;
  }

  httpCredentials(): HTTPCredentials | undefined {
    return this.credentials;
  }

  geolocation(): Geolocation | undefined {
    return this.geo;
  }

  routeEntries(): RouteEntry[] {
    return this.routes;
  }

  hasClientCertificates(): boolean {
    return !!this.certFetcher;
  }

  clientCertificateFor(url: string): ((req: Request, overrides: ContinueOptions, fulfill: (status: number, headers: Record<string, string>, body: Buffer) => Promise<void>) => Promise<void>) | undefined {
    return this.certFetcher?.(url);
  }

  initScriptSources(): string[] {
    return this.initScripts;
  }

  bindingCount(): number {
    return this.bindings.size;
  }

  bindingSources(): BindingEntry[] {
    return [...this.bindings.values()];
  }

  binding(name: string): BindingEntry | undefined {
    return this.bindings.get(name);
  }

  defaultTimeout(): number {
    return this.defaultTimeout_ ?? 30_000;
  }

  defaultNavigationTimeout(): number {
    return this.defaultNavigationTimeout_ ?? this.defaultTimeout_ ?? 30_000;
  }

  setDefaultTimeout(ms: number): void {
    this.defaultTimeout_ = ms;
  }

  setDefaultNavigationTimeout(ms: number): void {
    this.defaultNavigationTimeout_ = ms;
  }

  // ------------------------------------------------------------------ pages
  async newPage(): Promise<ChromiumPage> {
    if (this.closed) throw new TargetClosedError(closedMessage('browserContext.newPage'));
    if (this.ownerPage) throw new Error('This context belongs to browser.newPage() and holds one page; create a context with browser.newContext() to open more pages');
    const { targetId } = await this.browser_.connection.root.send('Target.createTarget', { url: 'about:blank', ...(this.id ? { browserContextId: this.id } : {}) });
    return this.waitForPage(targetId);
  }

  protected waitForPage(targetId: string): Promise<ChromiumPage> {
    const ready = [...this.pages_].find((p) => p.targetId === targetId && p.initialized);
    if (ready) return Promise.resolve(ready);
    let d = this.pageWaiters.get(targetId);
    if (!d) {
      d = deferred<ChromiumPage>();
      this.pageWaiters.set(targetId, d);
    }
    return withTimeout(d.promise, 30_000, () => 'Timed out waiting for the new page to start');
  }

  /** Internal: a page target attached. */
  async onPageAttached(session: CDPSession, info: any): Promise<void> {
    const opener = info.openerId ? this.browser_.pageByTargetId(info.openerId) : undefined;
    const page = new ChromiumPage(this, session, info.targetId, opener);
    this.pages_.add(page);
    try {
      await page.initialize();
    } catch (e) {
      if (!isClosedError(e)) debugLog('browser', `page init failed: ${(e as Error).message}`);
      if (page.isClosed()) {
        this.pages_.delete(page);
        return;
      }
    }
    const waiter = this.pageWaiters.get(info.targetId);
    if (waiter) {
      this.pageWaiters.delete(info.targetId);
      waiter.resolve(page);
    }
    this.emitEvent('page', page);
    if (opener) opener.emitEvent('popup', page);
  }

  onPageClosed(page: ChromiumPage): void {
    this.pages_.delete(page);
    if (this.ownerPage === page) void this.close();
  }

  onFrameNavigated(page: ChromiumPage, frame: ChromiumFrame): void {
    this.tracing.onNavigation(page, frame);
  }

  onNetworkEvent(name: string, r: Request | Response): void {
    this.tracing.onNetwork(name, r);
  }

  // ------------------------------------------------------------------ cookies and storage
  async cookies(urls?: string | string[]): Promise<Cookie[]> {
    const { cookies } = await this.browser_.connection.root.send('Storage.getCookies', this.id ? { browserContextId: this.id } : {});
    const list = (cookies as any[]).map(toCookie);
    const us = (typeof urls === 'string' ? [urls] : urls ?? []).map((u) => new URL(u));
    if (!us.length) return list;
    return list.filter((c) => us.some((u) => {
      const host = u.hostname;
      const domainOk = c.domain.startsWith('.') ? host === c.domain.slice(1) || host.endsWith(c.domain) : host === c.domain;
      const pathOk = u.pathname.startsWith(c.path);
      const secureOk = !c.secure || u.protocol === 'https:' || host === 'localhost';
      return domainOk && pathOk && secureOk;
    }));
  }

  async addCookies(cookies: SetCookie[]): Promise<void> {
    const out = cookies.map((c) => {
      if (!c.url && !(c.domain && c.path)) throw new Error(`addCookies: cookie "${c.name}" needs either a url or both a domain and a path`);
      const base: Record<string, unknown> = { name: c.name, value: c.value };
      if (c.url) {
        const u = new URL(c.url);
        base.domain = u.hostname;
        base.path = c.path ?? (u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/');
        base.secure = c.secure ?? u.protocol === 'https:';
      } else {
        base.domain = c.domain;
        base.path = c.path;
        if (c.secure !== undefined) base.secure = c.secure;
      }
      if (c.expires !== undefined && c.expires !== -1) base.expires = c.expires;
      if (c.httpOnly !== undefined) base.httpOnly = c.httpOnly;
      if (c.sameSite) base.sameSite = c.sameSite;
      if (c.partitionKey) base.partitionKey = { topLevelSite: c.partitionKey, hasCrossSiteAncestor: false };
      return base;
    });
    await this.browser_.connection.root.send('Storage.setCookies', { cookies: out, ...(this.id ? { browserContextId: this.id } : {}) });
  }

  async clearCookies(filter: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp } = {}): Promise<void> {
    const root = this.browser_.connection.root;
    const ctx = this.id ? { browserContextId: this.id } : {};
    const has = filter.name !== undefined || filter.domain !== undefined || filter.path !== undefined;
    if (!has) {
      await root.send('Storage.clearCookies', ctx);
      return;
    }
    const all = await this.cookies();
    const m = (v: string, f: string | RegExp | undefined) => f === undefined || (typeof f === 'string' ? v === f : f.test(v));
    const keep = all.filter((c) => !(m(c.name, filter.name) && m(c.domain, filter.domain) && m(c.path, filter.path)));
    await root.send('Storage.clearCookies', ctx);
    if (keep.length) await this.addCookies(keep.map((c) => ({ ...c, expires: c.expires })));
  }

  async storageState(options: { path?: string; indexedDB?: boolean } = {}): Promise<StorageState> {
    const cookies = await this.cookies();
    const origins = new Map<string, Array<{ name: string; value: string }>>();
    for (const page of this.pages()) {
      for (const frame of page.frames()) {
        const origin = (() => {
          try {
            const u = new URL(frame.url());
            return u.protocol.startsWith('http') ? u.origin : undefined;
          } catch {
            return undefined;
          }
        })();
        if (!origin || origins.has(origin)) continue;
        const items = await frame.evaluate(() => Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) ?? '' }))).catch(() => undefined);
        if (items) origins.set(origin, items as Array<{ name: string; value: string }>);
      }
    }
    const state: StorageState = { cookies, origins: [...origins].filter(([, l]) => l.length).map(([origin, localStorage]) => ({ origin, localStorage })) };
    if (options.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, JSON.stringify(state, null, 2));
    }
    return state;
  }

  protected async loadStorageState(s: string | StorageState): Promise<void> {
    const state: StorageState = typeof s === 'string' ? JSON.parse(await readFile(s, 'utf8')) : s;
    if (state.cookies?.length) await this.addCookies(state.cookies);
    const origins = (state.origins ?? []).filter((o) => o.localStorage?.length);
    if (!origins.length) return;
    // Visit each origin on a scratch page whose document we serve ourselves, and write localStorage there.
    const page = await this.newPage();
    try {
      await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>storage</title>' }));
      for (const o of origins) {
        await page.goto(new URL('/', o.origin).href, { waitUntil: 'domcontentloaded' });
        await page.evaluate((items: Array<{ name: string; value: string }>) => {
          for (const { name, value } of items) localStorage.setItem(name, value);
        }, o.localStorage);
      }
    } finally {
      await page.close();
    }
  }

  // ------------------------------------------------------------------ permissions and emulation
  async grantPermissions(permissions: string[], options: { origin?: string } = {}): Promise<void> {
    const mapped = new Set<string>();
    for (const p of permissions) {
      const m = PERMISSIONS[p];
      if (!m) throw new Error(`grantPermissions: "${p}" is not a permission EZTest knows (known: ${Object.keys(PERMISSIONS).join(', ')})`);
      m.forEach((x) => mapped.add(x));
    }
    await this.browser_.connection.root.send('Browser.grantPermissions', {
      permissions: [...mapped],
      ...(options.origin ? { origin: options.origin } : {}),
      ...(this.id ? { browserContextId: this.id } : {}),
    });
  }

  async clearPermissions(): Promise<void> {
    await this.browser_.connection.root.send('Browser.resetPermissions', this.id ? { browserContextId: this.id } : {});
  }

  async setGeolocation(geolocation: Geolocation | null): Promise<void> {
    if (geolocation) {
      const { latitude, longitude } = geolocation;
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error(`setGeolocation: latitude must be -90..90 and longitude -180..180 (got ${JSON.stringify(geolocation)})`);
    }
    this.geo = geolocation ?? undefined;
    for (const p of this.pages()) {
      await p.broadcast(geolocation ? 'Emulation.setGeolocationOverride' : 'Emulation.clearGeolocationOverride', geolocation ? { latitude: geolocation.latitude, longitude: geolocation.longitude, accuracy: geolocation.accuracy ?? 0 } : {}, true);
    }
  }

  async setOffline(offline: boolean): Promise<void> {
    this.offline = offline;
    for (const p of this.pages()) {
      await p.broadcast('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  }

  /** Throttle the network of every page (bytes per second, latency in ms); null restores it. */
  async setNetworkConditions(c: { latency?: number; downloadThroughput?: number; uploadThroughput?: number } | null): Promise<void> {
    for (const p of this.pages()) {
      await p.broadcast('Network.emulateNetworkConditions', {
        offline: this.offline,
        latency: c?.latency ?? 0,
        downloadThroughput: c?.downloadThroughput ?? -1,
        uploadThroughput: c?.uploadThroughput ?? -1,
      });
    }
  }

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    for (const p of this.pages()) await p.applyExtraHeaders();
  }

  async setHTTPCredentials(credentials: HTTPCredentials | null): Promise<void> {
    this.credentials = credentials ?? undefined;
    for (const p of this.pages()) await p.updateInterception();
  }

  // ------------------------------------------------------------------ scripts, bindings, routes
  async addInitScript(script: string | ((arg: any) => unknown) | { path?: string; content?: string }, arg?: unknown): Promise<void> {
    const source = await initScriptSource(script, arg);
    this.initScripts.push(source);
    for (const p of this.pages()) await p.addScriptToSessions(source);
  }

  async exposeBinding(name: string, callback: BindingEntry['callback'], _options: { handle?: boolean } = {}): Promise<void> {
    if (this.bindings.has(name)) throw new Error(bindingTakenMessage(name));
    for (const p of this.pages()) if (p.bindings.has(name)) throw new Error(bindingTakenMessage(name, ' on one of the pages'));
    const entry: BindingEntry = { name, callback, source: bindingSource(name) };
    this.bindings.set(name, entry);
    for (const p of this.pages()) await p.installBinding(entry);
  }

  async exposeFunction(name: string, fn: (...args: any[]) => unknown): Promise<void> {
    await this.exposeBinding(name, (_src, ...args) => fn(...args));
  }

  async route(url: URLMatch, handler: RouteHandlerFn, options: { times?: number } = {}): Promise<void> {
    this.routes.unshift({ url, handler, times: options.times, count: 0 });
    for (const p of this.pages()) await p.updateInterception();
  }

  async unroute(url: URLMatch, handler?: RouteHandlerFn): Promise<void> {
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i];
      const same = r.url === url || (r.url instanceof RegExp && url instanceof RegExp && r.url.source === url.source && r.url.flags === url.flags);
      if (same && (!handler || r.handler === handler)) this.routes.splice(i, 1);
    }
    for (const p of this.pages()) await p.updateInterception();
  }

  async unrouteAll(_options: { behavior?: string } = {}): Promise<void> {
    this.routes.splice(0);
    for (const p of this.pages()) await p.updateInterception();
  }

  async routeFromHAR(har: string, options: RouteFromHAROptions = {}): Promise<void> {
    await routeFromHAR(this, har, options);
  }

  /** A raw protocol session attached to a page's (or frame's) target. */
  async newCDPSession(target: ChromiumPage | ChromiumFrame): Promise<CDPSession> {
    let targetId: string;
    if (target instanceof ChromiumPage) targetId = target.targetId;
    else {
      const f = target as ChromiumFrame;
      targetId = f.session.isMain ? f.page().targetId : f.id;
    }
    const conn = this.browser_.connection;
    const { sessionId } = await conn.root.send('Target.attachToTarget', { targetId, flatten: true });
    const s = conn.session(sessionId);
    if (!s) throw new Error('Could not attach to the target');
    return s;
  }

  serviceWorkers(): Worker[] {
    return [...this.serviceWorkers_];
  }

  backgroundPages(): ChromiumPage[] {
    return [];
  }

  // ------------------------------------------------------------------ close
  async close(_options: { reason?: string } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pages = [...this.pages_];
    const videos = pages.map((p) => p.video()).filter((v): v is NonNullable<typeof v> => !!v);
    if (this.id) {
      await this.browser_.connection.root.send('Target.disposeBrowserContext', { browserContextId: this.id }).catch(() => undefined);
    } else {
      for (const p of pages) await p.close().catch(() => undefined);
    }
    // Pages see their sessions detach; wait for that (and for videos to be written).
    const deadline = Date.now() + 5000;
    while (pages.some((p) => !p.isClosed()) && Date.now() < deadline) await sleep(20);
    await Promise.all(videos.map((v) => v.finished().catch(() => undefined)));
    this.browser_.contextClosed(this);
    this.emitEvent('close', this);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function toCookie(c: any): Cookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.session || c.expires === undefined ? -1 : c.expires,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite === 'Strict' ? 'Strict' : c.sameSite === 'None' ? 'None' : 'Lax',
  };
}

// ---------------------------------------------------------------------- browser

export interface BrowserEvents {
  disconnected: ChromiumBrowser;
}

export class ChromiumBrowser extends TypedEmitter<BrowserEvents> {
  readonly contexts_ = new Map<string, ChromiumContext>();
  private defaultContext_?: ChromiumContext;
  private version_ = '';
  private userAgent_ = '';
  readonly downloadsDir: string;
  private readonly downloads = new Map<string, Download>();
  private closing?: Promise<void>;
  private connected = true;

  private constructor(
    readonly connection: CDPConnection,
    private readonly proc: LaunchedProcess | undefined,
    readonly slowMo: number,
    private readonly browserType_: ChromiumBrowserType,
    downloadsPath?: string,
  ) {
    super();
    this.downloadsDir = downloadsPath ?? mkdtempSync(join(tmpdir(), 'eztest-downloads-'));
    connection.on('disconnected', () => this.didDisconnect());
    const root = connection.root;
    root.on('Target.attachedToTarget', (e: any) => void this.onAttached(e));
    root.on('Browser.downloadWillBegin', (e: any) => this.onDownloadWillBegin(e));
    root.on('Browser.downloadProgress', (e: any) => this.downloads.get(e.guid)?.onState(e.state));
  }

  protected override closeEventName(): string | undefined {
    return 'disconnected';
  }

  /** Connect a CDP connection and set up auto-attach. */
  static async create(connection: CDPConnection, proc: LaunchedProcess | undefined, slowMo: number, type: ChromiumBrowserType, downloadsPath?: string): Promise<ChromiumBrowser> {
    const b = new ChromiumBrowser(connection, proc, slowMo, type, downloadsPath);
    const v = await connection.root.send('Browser.getVersion');
    b.version_ = String(v.product).replace(/^[^/]*\//, '');
    b.userAgent_ = String(v.userAgent).replace('HeadlessChrome/', 'Chrome/');
    await connection.root.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return b;
  }

  defaultUserAgent(): string {
    return this.userAgent_;
  }

  pageByTargetId(targetId: string): ChromiumPage | undefined {
    for (const c of this.allContexts()) for (const p of c.pages_) if (p.targetId === targetId) return p;
    return undefined;
  }

  private allContexts(): ChromiumContext[] {
    return [...this.contexts_.values(), ...(this.defaultContext_ ? [this.defaultContext_] : [])];
  }

  /** The default (non-incognito) context, created on first use. */
  defaultContext(): ChromiumContext {
    if (!this.defaultContext_) this.defaultContext_ = new ChromiumContext(this, undefined, { viewport: null });
    return this.defaultContext_;
  }

  private async onAttached(e: any): Promise<void> {
    const info = e.targetInfo;
    const session = this.connection.session(e.sessionId);
    if (!session) return;
    debugLog('browser', `attached ${info.type} ${info.targetId} ${info.url}`);
    if (info.type === 'page') {
      // A session we (or a user) attached manually to a page we already drive.
      if (this.pageByTargetId(info.targetId) || !e.waitingForDebugger && this.manualAttach(info.targetId)) return;
      const ctx = (info.browserContextId && this.contexts_.get(info.browserContextId)) || this.defaultContext();
      await ctx.onPageAttached(session, info);
      return;
    }
    if (info.type === 'service_worker') {
      const ctx = (info.browserContextId && this.contexts_.get(info.browserContextId)) || this.defaultContext();
      const w = new Worker(session, info.url);
      ctx.serviceWorkers_.add(w);
      session.on('disconnected', () => {
        ctx.serviceWorkers_.delete(w);
        w.emitEvent('close', w);
      });
      await session.send('Runtime.enable').catch(() => undefined);
      await session.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
      ctx.emitEvent('serviceworker', w);
      return;
    }
    await session.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
    if (e.waitingForDebugger) await session.detach().catch(() => undefined);
  }

  private readonly manualTargets = new Set<string>();
  /** Internal: a manual attach is in progress for this target. */
  private manualAttach(targetId: string): boolean {
    return this.manualTargets.has(targetId);
  }

  private onDownloadWillBegin(e: any): void {
    let page: ChromiumPage | undefined;
    for (const c of this.allContexts()) for (const p of c.pages_) if (p.frameById(e.frameId)) page = p;
    if (!page) return;
    const accepted = page.context().options.acceptDownloads !== false;
    const d = new Download(page, e.url, e.suggestedFilename, join(this.downloadsDir, e.guid), this, e.guid, accepted);
    this.downloads.set(e.guid, d);
    page.onDownload(d, e.frameId);
  }

  contextClosed(ctx: ChromiumContext): void {
    if (ctx.id) this.contexts_.delete(ctx.id);
  }

  // ------------------------------------------------------------------ public API
  async newContext(options: BrowserContextOptions = {}): Promise<ChromiumContext> {
    if (!this.connected) throw new TargetClosedError(closedMessage('browser.newContext'));
    const proxy = options.proxy;
    const { browserContextId } = await this.connection.root.send('Target.createBrowserContext', {
      disposeOnDetach: true,
      ...(proxy ? { proxyServer: proxy.server, ...(proxy.bypass ? { proxyBypassList: proxy.bypass } : {}) } : {}),
    });
    const ctx = new ChromiumContext(this, browserContextId, options);
    this.contexts_.set(browserContextId, ctx);
    await ctx.initialize();
    return ctx;
  }

  async newPage(options: BrowserContextOptions = {}): Promise<ChromiumPage> {
    const ctx = await this.newContext(options);
    const page = await ctx.newPage();
    ctx.ownerPage = page;
    return page;
  }

  contexts(): ChromiumContext[] {
    return [...(this.defaultContext_ && this.defaultContext_.pages().length ? [this.defaultContext_] : []), ...this.contexts_.values()];
  }

  version(): string {
    return this.version_;
  }

  isConnected(): boolean {
    return this.connected;
  }

  browserType(): ChromiumBrowserType {
    return this.browserType_;
  }

  /** A protocol session to the browser target itself. */
  async newBrowserCDPSession(): Promise<CDPSession> {
    const { targetInfos } = await this.connection.root.send('Target.getTargets');
    const browserTarget = (targetInfos as any[]).find((t) => t.type === 'browser');
    if (!browserTarget) return this.connection.root;
    const { sessionId } = await this.connection.root.send('Target.attachToTarget', { targetId: browserTarget.targetId, flatten: true });
    return this.connection.session(sessionId) ?? this.connection.root;
  }

  async close(_options: { reason?: string } = {}): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        for (const ctx of [...this.contexts_.values()]) await ctx.close().catch(() => undefined);
        if (this.proc) {
          await this.connection.root.send('Browser.close').catch(() => undefined);
          await this.proc.kill();
        } else {
          this.connection.close();
        }
        await rm(this.downloadsDir, { recursive: true, force: true }).catch(() => undefined);
        this.didDisconnect();
      })();
    }
    return this.closing;
  }

  private didDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emitEvent('disconnected', this);
  }

  private encoder?: Vp8Encoder;

  /**
   * VP8 encoding for recordVideo, done by this browser (WebCodecs in a scratch
   * page served on a secure origin we fulfill ourselves).
   */
  vp8Encoder(): Vp8Encoder | undefined {
    if (!this.connected) return undefined;
    if (!this.encoder) this.encoder = browserVp8Encoder(async () => this.newContext({ viewport: { width: 200, height: 100 } }));
    return this.encoder;
  }

  /** Internal: register a manual attach target id (newCDPSession). */
  noteManualAttach(targetId: string): void {
    this.manualTargets.add(targetId);
  }

  /** Internal: the browser process (undefined when connected over a WebSocket). */
  process(): LaunchedProcess['process'] | undefined {
    return this.proc?.process;
  }
}

/**
 * A VP8 encoder that runs in the browser under test: WebCodecs VideoEncoder in
 * a scratch page (its own context) on a secure origin whose document we serve.
 */
export function browserVp8Encoder(newContext: () => Promise<{ newPage(): Promise<ChromiumPage> }>): Vp8Encoder {
  let encoderPage: Promise<ChromiumPage> | undefined;
  return async (frames, size) => {
    if (!encoderPage) {
      encoderPage = (async () => {
        const ctx = await newContext();
        const p = await ctx.newPage();
        await p.route('https://eztest-encoder.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>encoder</title>' }));
        await p.goto('https://eztest-encoder.invalid/');
        return p;
      })();
      encoderPage.catch(() => {
        encoderPage = undefined;
      });
    }
    const page = await encoderPage;
    const t0 = frames[0].timestamp;
    await page.evaluate(({ width, height }) => {
      const w = window as unknown as Record<string, any>;
      const state: any = { chunks: [], error: null, n: 0 };
      state.canvas = new OffscreenCanvas(width, height);
      state.ctx2d = state.canvas.getContext('2d');
      state.enc = new (w.VideoEncoder)({
        output: (chunk: any) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          let s = '';
          for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
          state.chunks.push({ t: chunk.timestamp / 1000, key: chunk.type === 'key', d: btoa(s) });
        },
        error: (e: unknown) => { state.error = String(e); },
      });
      state.enc.configure({ codec: 'vp8', width, height, bitrate: 1_500_000, framerate: 25 });
      w.__ezEnc = state;
    }, size);
    const batch = 20;
    const list = [...frames, { png: frames[frames.length - 1].png, timestamp: frames[frames.length - 1].timestamp + 0.5 }];
    for (let i = 0; i < list.length; i += batch) {
      const part = list.slice(i, i + batch).map((f) => ({ b64: f.png.toString('base64'), t: (f.timestamp - t0) * 1000 }));
      await page.evaluate(async ({ items, start }) => {
        const st = (window as unknown as Record<string, any>).__ezEnc;
        for (let k = 0; k < items.length; k++) {
          const bin = atob(items[k].b64);
          const bytes = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          st.ctx2d.drawImage(bmp, 0, 0, st.canvas.width, st.canvas.height);
          bmp.close();
          const vf = new (window as unknown as Record<string, any>).VideoFrame(st.canvas, { timestamp: Math.round(items[k].t * 1000) });
          st.enc.encode(vf, { keyFrame: (start + k) % 50 === 0 });
          vf.close();
        }
      }, { items: part, start: i });
    }
    const out = await page.evaluate(async () => {
      const st = (window as unknown as Record<string, any>).__ezEnc;
      await st.enc.flush();
      st.enc.close();
      if (st.error) throw new Error(st.error);
      return st.chunks as Array<{ t: number; key: boolean; d: string }>;
    });
    return out.map((c) => ({ timeMs: c.t, key: c.key, data: Buffer.from(c.d, 'base64') }));
  };
}

// ---------------------------------------------------------------------- browser type

export interface ConnectOverCDPOptions {
  timeout?: number;
  slowMo?: number;
  headers?: Record<string, string>;
}

export class ChromiumBrowserType {
  name(): string {
    return 'chromium';
  }

  executablePath(): string {
    return findChromium().executablePath;
  }

  async launch(options: LaunchOptions = {}): Promise<ChromiumBrowser> {
    const proc = await launchChromiumProcess({
      executablePath: options.executablePath,
      channel: options.channel,
      headless: options.headless,
      args: options.args,
      ignoreDefaultArgs: options.ignoreDefaultArgs,
      env: options.env,
      chromiumSandbox: options.chromiumSandbox,
      proxy: options.proxy,
      devtools: options.devtools,
      timeout: options.timeout,
    });
    const connection = new CDPConnection(proc.transport);
    try {
      return await withTimeout(
        ChromiumBrowser.create(connection, proc, options.slowMo ?? 0, this, options.downloadsPath),
        options.timeout ?? 180_000,
        () => `browserType.launch: timed out after ${options.timeout ?? 180_000} ms waiting for the browser to start\n${stderrTailOf(proc)}`,
      );
    } catch (e) {
      await proc.kill().catch(() => undefined);
      const tail = stderrTailOf(proc);
      const err = e as Error;
      if (!err.message.includes('browserType.launch')) err.message = `browserType.launch: ${err.message}${tail ? `\nBrowser output:\n${tail}` : ''}`;
      throw err;
    }
  }

  /**
   * Attach to a running Chromium, Chrome or Edge over its DevTools endpoint (http(s)://host:port,
   * resolved via /json/version, or the browser's ws(s):// URL). `headers` go on the discovery
   * request and the WebSocket handshake. Closing the returned browser closes only the contexts
   * created through it and disconnects; the browser keeps running.
   */
  async connectOverCDP(endpointURL: string | { endpointURL?: string; wsEndpoint?: string }, options: ConnectOverCDPOptions = {}): Promise<ChromiumBrowser> {
    const url = typeof endpointURL === 'string' ? endpointURL : (endpointURL.wsEndpoint ?? endpointURL.endpointURL ?? '');
    const timeout = options.timeout ?? 30_000;
    const ws = await resolveBrowserWsEndpoint(url, options.headers, timeout);
    const transport = await WebSocketTransport.connect(ws, timeout, options.headers);
    const connection = new CDPConnection(transport);
    const b = await withTimeout(ChromiumBrowser.create(connection, undefined, options.slowMo ?? 0, this), timeout, () => `connectOverCDP: timed out after ${timeout} ms talking to the browser`).catch((e: unknown) => {
      transport.close();
      throw e;
    });
    b.defaultContext();
    await sleep(100); // let existing targets attach
    return b;
  }

  /** Launch with a persistent profile and return its default context. */
  async launchPersistentContext(userDataDir: string, options: LaunchOptions & BrowserContextOptions = {}): Promise<ChromiumContext> {
    const proc = await launchChromiumProcess({
      executablePath: options.executablePath,
      channel: options.channel,
      headless: options.headless,
      args: options.args,
      ignoreDefaultArgs: options.ignoreDefaultArgs,
      env: options.env,
      userDataDir: userDataDir || undefined,
      chromiumSandbox: options.chromiumSandbox,
      proxy: options.proxy,
    });
    const connection = new CDPConnection(proc.transport);
    const b = await ChromiumBrowser.create(connection, proc, options.slowMo ?? 0, this, options.downloadsPath);
    const ctx = b.defaultContext();
    Object.assign(ctx.options, options);
    await ctx.initialize();
    const page = await ctx.newPage();
    void page;
    ctx.on('close', () => void b.close());
    return ctx;
  }
}

export { randomUUID as _uuid };
export type { ClientCertificate };
