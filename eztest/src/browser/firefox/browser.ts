/**
 * Firefox Browser and BrowserContext over WebDriver BiDi, and the Firefox
 * BrowserType (launch / launchPersistentContext).
 *
 * - A BrowserContext is a BiDi user context (browser.createUserContext):
 *   its own cookies, storage, permissions and per-context emulation
 *   (emulation.* with `userContexts`), preload scripts and data collector.
 * - Pages are top-level browsing contexts, each in its own window so every
 *   page is the active tab of its window (no background throttling).
 * - The browser keeps one BiDi session with a global event subscription and
 *   routes events to pages by browsing context.
 * - Emulation that BiDi has no command for (color scheme, reduced motion,
 *   forced colors, print media, touch, JavaScript off) is set on the
 *   browsing context from Firefox's privileged scope, which EZTest enables
 *   for the Firefox it launches (`--remote-allow-system-access`).
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync, type ReadStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debugLog } from '../debug.js';
import { TypedEmitter } from '../events.js';
import { TargetClosedError } from '../errors.js';
import type { BrowserContextOptions, Cookie, Geolocation, HTTPCredentials, LaunchOptions, SetCookie, URLMatch } from '../types.js';
import { deferred, sleep, withTimeout, type Deferred } from '../util.js';
import { CrBrowserContext, Download, browserVp8Encoder, type CrBrowser } from '../chromium/browser.js';
import { initScriptSource, type BindingEntry } from '../chromium/page.js';
import type { RouteHandlerFn } from '../chromium/network.js';
import type { Vp8Encoder } from '../video/webm.js';
import { BidiConnection, isGoneBidiError } from './connection.js';
import { WebSocketTransport } from '../transport/transport.js';
import { launchFirefoxProcess, findFirefox, type LaunchedFirefox, type FirefoxLaunchOptions } from './launch.js';
import { FfPage, bindingPreload, initScriptPreload, webSocketObserverPreload } from './page.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const EVENTS = [
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
  'browsingContext.navigationStarted',
  'browsingContext.navigationCommitted',
  'browsingContext.fragmentNavigated',
  'browsingContext.historyUpdated',
  'browsingContext.domContentLoaded',
  'browsingContext.load',
  'browsingContext.navigationFailed',
  'browsingContext.navigationAborted',
  'browsingContext.downloadWillBegin',
  'browsingContext.downloadEnd',
  'browsingContext.userPromptOpened',
  'script.realmCreated',
  'script.realmDestroyed',
  'script.message',
  'log.entryAdded',
  'network.beforeRequestSent',
  'network.responseStarted',
  'network.responseCompleted',
  'network.fetchError',
  'network.authRequired',
  'input.fileDialogOpened',
];

// ---------------------------------------------------------------------- downloads

export class FfDownload extends Download {
  private filePath?: string;
  private readonly finishedState: Deferred<'completed' | 'canceled'> = deferred();

  constructor(page: FfPage, url: string, suggested: string, browser: FfBrowser, private readonly acceptedDownloads: boolean) {
    super(page, url, suggested, '', browser as unknown as CrBrowser, randomUUID(), acceptedDownloads);
  }

  /** Internal: downloadEnd. */
  onEnd(status: string, filepath: string | undefined): void {
    this.filePath = filepath ?? undefined;
    const s = status === 'complete' && filepath ? 'completed' : 'canceled';
    this.finishedState.resolve(s);
    this.onState(s);
  }

  override async path(): Promise<string | null> {
    if (!this.acceptedDownloads) throw new Error('Pass { acceptDownloads: true } when you are creating your browser context.');
    const s = await this.finishedState.promise;
    return s === 'completed' ? (this.filePath ?? null) : null;
  }

  override async failure(): Promise<string | null> {
    if (!this.acceptedDownloads) return 'Pass { acceptDownloads: true } when you are creating your browser context.';
    const s = await this.finishedState.promise;
    return s === 'completed' ? null : 'canceled';
  }

  override async saveAs(path: string): Promise<void> {
    const p = await this.path();
    if (!p) throw new Error('Download was canceled');
    await mkdir(dirname(path), { recursive: true });
    await copyFile(p, path);
  }

  override async createReadStream(): Promise<ReadStream> {
    const p = await this.path();
    if (!p) throw new Error('Download failed');
    return createReadStream(p);
  }

  override async delete(): Promise<void> {
    const s = await this.finishedState.promise.catch(() => 'canceled');
    if (s === 'completed' && this.filePath) await rm(this.filePath, { force: true });
  }

  override async cancel(): Promise<void> {
    // WebDriver BiDi has no command to cancel a running download.
  }
}

// ---------------------------------------------------------------------- context

const PERMISSION_NAMES = new Set([
  'geolocation', 'midi', 'midi-sysex', 'notifications', 'camera', 'microphone', 'background-sync', 'ambient-light-sensor', 'accelerometer', 'gyroscope',
  'magnetometer', 'clipboard-read', 'clipboard-write', 'payment-handler', 'storage-access', 'local-fonts', 'persistent-storage', 'screen-wake-lock',
  'idle-detection', 'window-management', 'top-level-storage-access', 'push',
]);

function toCookie(c: any): Cookie {
  const value = c.value?.type === 'base64' ? Buffer.from(c.value.value, 'base64').toString('utf8') : String(c.value?.value ?? '');
  const ss = String(c.sameSite ?? '').toLowerCase();
  return {
    name: c.name,
    value,
    domain: c.domain,
    path: c.path,
    expires: typeof c.expiry === 'number' ? c.expiry : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ss === 'strict' ? 'Strict' : ss === 'none' ? 'None' : 'Lax',
  };
}

export class FfBrowserContext extends CrBrowserContext {
  private collector?: string;
  private collectsRequests = false;
  private latencyMs = 0;
  private readonly channelBindings = new Map<string, string>();
  private readonly grants: Array<{ permissions: string[]; origin?: string }> = [];
  private readonly grantedOrigins = new Map<string, Set<string>>();
  private readonly preloadScripts: string[] = [];

  constructor(
    private readonly ffBrowser_: FfBrowser,
    /** BiDi user context id ('default' for the browser's default context). */
    readonly userContext: string,
    options: BrowserContextOptions,
  ) {
    super(ffBrowser_ as unknown as CrBrowser, userContext === 'default' ? undefined : userContext, options);
  }

  private get bidi(): BidiConnection {
    return this.ffBrowser_.bidi;
  }

  ffBrowser(): FfBrowser {
    return this.ffBrowser_;
  }

  private scope(): { userContexts: string[] } {
    return { userContexts: [this.userContext] };
  }

  /** Apply what lives in the browser: data collector, downloads, emulation, headers, permissions, storage state. */
  override async initialize(): Promise<void> {
    const o = this.options;
    const optional = (p: Promise<unknown>, what: string) => p.catch((e) => debugLog('browser', `${what}: ${(e as Error).message}`));
    const steps: Array<Promise<unknown>> = [
      this.addCollector(),
      this.applyDownloadBehavior(),
      optional(this.applyEmulation(), 'emulation'),
      this.applyContextHeaders(),
      this.observeWebSockets(),
    ];
    await Promise.all(steps);
    if (o.permissions?.length) await this.grantPermissions(o.permissions);
    if (o.storageState) await this.loadStorageState(o.storageState);
  }

  /** Internal: the channel of this context's page-side WebSocket observer. */
  readonly webSocketChannel = `ez-websocket-${randomUUID()}`;

  /** BiDi has no WebSocket events: a preload script reports the page's WebSockets (see webSocketObserverPreload). */
  private async observeWebSockets(): Promise<void> {
    const { script } = await this.bidi.send('script.addPreloadScript', {
      functionDeclaration: webSocketObserverPreload(),
      arguments: [{ type: 'channel', value: { channel: this.webSocketChannel, ownership: 'none', serializationOptions: { maxObjectDepth: 3 } } }],
      ...this.scope(),
    }).catch((e) => {
      debugLog('browser', `WebSocket observer: ${(e as Error).message}`);
      return { script: undefined };
    });
    if (script) this.preloadScripts.push(script);
  }

  private async addCollector(): Promise<void> {
    const add = (dataTypes: string[]) => this.bidi.send('network.addDataCollector', { dataTypes, maxEncodedDataSize: 20 * 1024 * 1024, ...this.scope() });
    try {
      this.collector = (await add(['response', 'request'])).collector;
      this.collectsRequests = true;
    } catch {
      try {
        this.collector = (await add(['response'])).collector;
      } catch (e) {
        debugLog('browser', `network.addDataCollector: ${(e as Error).message}`);
      }
    }
  }

  /** Internal: the response body of a request (from the data collector). */
  async responseBody(requestId: string): Promise<Buffer> {
    if (!this.collector) throw new Error('Response bodies are not available in this Firefox (no network.addDataCollector)');
    const r = await this.bidi.send('network.getData', { dataType: 'response', request: requestId, collector: this.collector });
    const b = r.bytes;
    return b?.type === 'base64' ? Buffer.from(b.value, 'base64') : Buffer.from(String(b?.value ?? ''), 'utf8');
  }

  /** Internal: the request body (postData) of a request, when the browser collects it. */
  async requestBody(requestId: string): Promise<Buffer | undefined> {
    if (!this.collector || !this.collectsRequests) return undefined;
    const r = await this.bidi.send('network.getData', { dataType: 'request', request: requestId, collector: this.collector });
    const b = r.bytes;
    if (!b) return undefined;
    return b.type === 'base64' ? Buffer.from(b.value, 'base64') : Buffer.from(String(b.value ?? ''), 'utf8');
  }

  override async applyDownloadBehavior(): Promise<void> {
    if (this.downloadsReady) return;
    this.downloadsReady = true;
    await this.bidi.send('browser.setDownloadBehavior', {
      downloadBehavior: this.options.acceptDownloads === false ? { type: 'denied' } : { type: 'allowed', destinationFolder: this.ffBrowser_.downloadsDir },
      ...this.scope(),
    }).catch((e) => debugLog('browser', `setDownloadBehavior: ${(e as Error).message}`));
  }

  private async applyEmulation(): Promise<void> {
    const o = this.options;
    const optional = (method: string, params: Record<string, unknown>) =>
      this.bidi.send(method, { ...params, ...this.scope() }).catch((e) => debugLog('browser', `${method}: ${(e as Error).message}`));
    const steps: Array<Promise<unknown>> = [];
    if (o.locale) steps.push(optional('emulation.setLocaleOverride', { locale: o.locale }));
    if (o.timezoneId) steps.push(this.bidi.send('emulation.setTimezoneOverride', { timezone: o.timezoneId, ...this.scope() }).catch((e) => {
      if (/invalid argument/i.test((e as Error).message)) throw new Error(`Invalid timezone ID: ${o.timezoneId}`);
    }));
    if (o.userAgent) steps.push(optional('emulation.setUserAgentOverride', { userAgent: o.userAgent }));
    if (this.geo) steps.push(this.applyGeolocation());
    if (this.offline) steps.push(optional('emulation.setNetworkConditions', { networkConditions: { type: 'offline' } }));
    if (o.screen) steps.push(optional('emulation.setScreenSettingsOverride', { screenArea: { width: o.screen.width, height: o.screen.height } }));
    await Promise.all(steps);
  }

  private applyGeolocation(): Promise<unknown> {
    const g = this.geo;
    return this.bidi.send('emulation.setGeolocationOverride', {
      coordinates: g ? { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy ?? 0 } : null,
      ...this.scope(),
    });
  }

  private async applyContextHeaders(): Promise<void> {
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.options.locale && !('accept-language' in headers)) headers['accept-language'] = acceptLanguage(this.options.locale);
    const list = Object.entries(headers).map(([name, value]) => ({ name, value: { type: 'string', value } }));
    if (!list.length && !this.headersApplied) return;
    this.headersApplied = true;
    await this.bidi.send('network.setExtraHeaders', { headers: list, ...this.scope() }).catch((e) => debugLog('browser', `setExtraHeaders: ${(e as Error).message}`));
  }

  private headersApplied = false;

  /** Internal: privileged per-page emulation (media features, touch, JavaScript). */
  async applyPageOverrides(page: FfPage): Promise<void> {
    const o = this.options;
    const m = page.mediaOverrides();
    const pick = <T>(k: keyof typeof m, ctxValue: T | null | undefined): T | null | undefined => (k in m ? (m[k] as T | null | undefined) : ctxValue);
    const want = {
      colorScheme: pick<string>('colorScheme', o.colorScheme),
      reducedMotion: pick<string>('reducedMotion', o.reducedMotion),
      forcedColors: pick<string>('forcedColors', o.forcedColors),
      media: pick<string>('media', undefined),
      touch: o.hasTouch ? 'enabled' : undefined,
      javaScript: o.javaScriptEnabled === false ? false : undefined,
    };
    const needed = Object.entries(want).some(([, v]) => v !== undefined && v !== null) || page.hadOverrides;
    if (!needed) return;
    page.hadOverrides = true;
    const ok = await this.ffBrowser_.chromeCall(
      `(id, o) => {
        let bc = null;
        for (const path of ["chrome://remote/content/shared/NavigableManager.sys.mjs", "chrome://remote/content/shared/TabManager.sys.mjs"]) {
          try {
            const mod = ChromeUtils.importESModule(path);
            const m = mod.NavigableManager || mod.TabManager;
            if (m && typeof m.getBrowsingContextById === "function") { bc = m.getBrowsingContextById(id); break; }
          } catch (e) {}
        }
        if (!bc) return "no browsing context";
        const errors = [];
        const set = (k, v) => { try { bc[k] = v; } catch (e) { errors.push(k + ": " + e.message); } };
        set("prefersColorSchemeOverride", o.colorScheme === "dark" || o.colorScheme === "light" ? o.colorScheme : "none");
        set("prefersReducedMotionOverride", o.reducedMotion === "reduce" || o.reducedMotion === "no-preference" ? o.reducedMotion : "none");
        set("forcedColorsOverride", o.forcedColors === "active" ? "active" : o.forcedColors === "none" ? "none" : "no-override");
        set("mediumOverride", o.media === "print" || o.media === "screen" ? o.media : "");
        if (o.touch) { set("touchEventsOverride", "enabled"); try { bc.setRDMPaneMaxTouchPoints(1); } catch (e) {} }
        if (o.javaScript === false) set("allowJavascript", false);
        return errors.join("; ");
      }`,
      [page.contextId, want],
    );
    if (ok) debugLog('browser', `page overrides: ${ok}`);
  }

  // ------------------------------------------------------------------ pages
  override async newPage(): Promise<FfPage> {
    if (this.closed) throw new TargetClosedError('browserContext.newPage: Target page, context or browser has been closed');
    if (this.ownerPage) throw new Error('Please use browser.newContext() for multi-page scripts');
    const { context } = await this.bidi.send('browsingContext.create', { type: 'window', userContext: this.userContext });
    return (await this.waitForPage(context)) as FfPage;
  }

  /** Internal: a top-level browsing context of this user context appeared. */
  async onTopLevelCreated(e: any): Promise<void> {
    const opener = e.originalOpener ? this.ffBrowser_.pageByContext(e.originalOpener) : undefined;
    const page = new FfPage(this, this.bidi, e.context, opener, e.url);
    this.pages_.add(page);
    this.ffBrowser_.registerPage(page);
    try {
      await page.initialize();
    } catch (err) {
      debugLog('browser', `page init failed: ${(err as Error).message}`);
      if (page.isClosed()) {
        this.pages_.delete(page);
        return;
      }
    }
    const waiter = this.pageWaiters.get(e.context);
    if (waiter) {
      this.pageWaiters.delete(e.context);
      waiter.resolve(page);
    }
    this.emitEvent('page', page);
    if (opener) opener.emitEvent('popup', page);
  }

  // ------------------------------------------------------------------ cookies
  private partition(): Record<string, unknown> {
    return { partition: { type: 'storageKey', userContext: this.userContext } };
  }

  override async cookies(urls?: string | string[]): Promise<Cookie[]> {
    const { cookies } = await this.bidi.send('storage.getCookies', this.partition());
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

  override async addCookies(cookies: SetCookie[]): Promise<void> {
    for (const c of cookies) {
      if (!c.url && !(c.domain && c.path)) throw new Error(`Cookie should have a url or a domain/path pair`);
      const cookie: Record<string, unknown> = { name: c.name, value: { type: 'string', value: c.value } };
      if (c.url) {
        const u = new URL(c.url);
        cookie.domain = u.hostname;
        cookie.path = c.path ?? (u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/');
        cookie.secure = c.secure ?? u.protocol === 'https:';
      } else {
        cookie.domain = c.domain;
        cookie.path = c.path;
        if (c.secure !== undefined) cookie.secure = c.secure;
      }
      if (c.expires !== undefined && c.expires !== -1) cookie.expiry = Math.round(c.expires);
      if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly;
      if (c.sameSite) cookie.sameSite = c.sameSite.toLowerCase();
      await this.bidi.send('storage.setCookie', { cookie, ...this.partition() });
    }
  }

  override async clearCookies(filter: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp } = {}): Promise<void> {
    const has = filter.name !== undefined || filter.domain !== undefined || filter.path !== undefined;
    if (!has) {
      await this.bidi.send('storage.deleteCookies', this.partition());
      return;
    }
    const m = (v: string, f: string | RegExp | undefined) => f === undefined || (typeof f === 'string' ? v === f : f.test(v));
    for (const c of await this.cookies()) {
      if (!(m(c.name, filter.name) && m(c.domain, filter.domain) && m(c.path, filter.path))) continue;
      await this.bidi.send('storage.deleteCookies', { filter: { name: c.name, domain: c.domain, path: c.path }, ...this.partition() });
    }
  }

  // ------------------------------------------------------------------ permissions and emulation
  override async grantPermissions(permissions: string[], options: { origin?: string } = {}): Promise<void> {
    for (const p of permissions) if (!PERMISSION_NAMES.has(p)) throw new Error(`Unknown permission: ${p}`);
    this.grants.push({ permissions: [...permissions], ...(options.origin ? { origin: new URL(options.origin).origin } : {}) });
    const origins = new Set<string>();
    if (options.origin) origins.add(new URL(options.origin).origin);
    else for (const page of this.pages()) for (const f of page.frames()) {
      const o = originOf(f.url());
      if (o) origins.add(o);
    }
    for (const origin of origins) await this.applyGrants(origin, true);
  }

  /** Internal: before a document of `url` loads, grant the permissions given without an origin. */
  async prepareOrigin(url: string): Promise<void> {
    const origin = originOf(url);
    if (origin && this.grants.length) await this.applyGrants(origin, false);
  }

  private async applyGrants(origin: string, force: boolean): Promise<void> {
    const done = this.grantedOrigins.get(origin) ?? new Set<string>();
    this.grantedOrigins.set(origin, done);
    for (const g of this.grants) {
      if (g.origin && g.origin !== origin) continue;
      for (const name of g.permissions) {
        if (done.has(name) && !force) continue;
        done.add(name);
        for (const n of name === 'midi-sysex' ? ['midi'] : [name]) {
          await this.bidi.send('permissions.setPermission', { descriptor: { name: n }, state: 'granted', origin, userContext: this.userContext })
            .catch((e) => debugLog('browser', `setPermission ${n} ${origin}: ${(e as Error).message}`));
        }
      }
    }
  }

  override async clearPermissions(): Promise<void> {
    const granted = [...this.grantedOrigins];
    this.grants.splice(0);
    this.grantedOrigins.clear();
    for (const [origin, names] of granted) {
      for (const name of names) {
        await this.bidi.send('permissions.setPermission', { descriptor: { name }, state: 'prompt', origin, userContext: this.userContext }).catch(() => undefined);
      }
    }
  }

  override async setGeolocation(geolocation: Geolocation | null): Promise<void> {
    if (geolocation) {
      const { latitude, longitude } = geolocation;
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error(`Invalid geolocation ${JSON.stringify(geolocation)}`);
    }
    this.geo = geolocation ?? undefined;
    await this.applyGeolocation();
  }

  override async setOffline(offline: boolean): Promise<void> {
    this.offline = offline;
    await this.bidi.send('emulation.setNetworkConditions', { networkConditions: offline ? { type: 'offline' } : null, ...this.scope() });
  }

  /**
   * Network throttling: Firefox's BiDi has no throughput emulation; latency
   * is emulated by holding each request for `latency` ms before it goes out.
   */
  override async setNetworkConditions(c: { latency?: number; downloadThroughput?: number; uploadThroughput?: number } | null): Promise<void> {
    this.latencyMs = Math.max(0, c?.latency ?? 0);
    if ((c?.downloadThroughput ?? -1) > 0 || (c?.uploadThroughput ?? -1) > 0) {
      process.emitWarning('Firefox: download / upload throughput limits are not supported (only latency is emulated)', 'EZTestBrowserDriver');
    }
    await this.ffBrowser_.updateIntercepts();
  }

  /** Internal: emulated latency (ms). */
  latency(): number {
    return this.latencyMs;
  }

  override async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.headersApplied = true;
    await this.applyContextHeaders();
  }

  override async setHTTPCredentials(credentials: HTTPCredentials | null): Promise<void> {
    this.credentials = credentials ?? undefined;
  }

  /** Internal: does any request of this context need the network intercept? */
  needsInterception(): boolean {
    return this.routeEntries().length > 0 || this.hasClientCertificates() || this.latencyMs > 0 || this.pages().some((p) => p.routeEntries().length > 0);
  }

  // ------------------------------------------------------------------ scripts, bindings, routes
  override async addInitScript(script: string | ((arg: any) => unknown) | { path?: string; content?: string }, arg?: unknown): Promise<void> {
    const source = await initScriptSource(script, arg);
    this.initScripts.push(source);
    const { script: id } = await this.bidi.send('script.addPreloadScript', { functionDeclaration: initScriptPreload(source), ...this.scope() });
    this.preloadScripts.push(id);
  }

  override async exposeBinding(name: string, callback: BindingEntry['callback'], _options: { handle?: boolean } = {}): Promise<void> {
    if (this.bindings.has(name)) throw new Error(`Function "${name}" has been already registered`);
    for (const p of this.pages()) if (p.bindings.has(name)) throw new Error(`Function "${name}" has been already registered in one of the pages`);
    const entry: BindingEntry = { name, callback, source: '' };
    this.bindings.set(name, entry);
    const channel = `ez-binding-${randomUUID()}`;
    this.channelBindings.set(channel, name);
    const fn = bindingPreload(name);
    const arg = { type: 'channel', value: { channel, ownership: 'none' } };
    const { script } = await this.bidi.send('script.addPreloadScript', { functionDeclaration: fn, arguments: [arg], ...this.scope() });
    this.preloadScripts.push(script);
    for (const p of this.pages()) await (p as FfPage).runInAllFrames(fn, [arg]);
  }

  /** Internal: binding name of a context-level channel. */
  bindingForChannel(channel: string): string | undefined {
    return this.channelBindings.get(channel);
  }

  override async route(url: URLMatch, handler: RouteHandlerFn, options: { times?: number } = {}): Promise<void> {
    await super.route(url, handler, options);
    await this.ffBrowser_.updateIntercepts();
  }

  override async unroute(url: URLMatch, handler?: RouteHandlerFn): Promise<void> {
    await super.unroute(url, handler);
    await this.ffBrowser_.updateIntercepts();
  }

  override async unrouteAll(options: { behavior?: string } = {}): Promise<void> {
    await super.unrouteAll(options);
    await this.ffBrowser_.updateIntercepts();
  }

  override async newCDPSession(_target: unknown): Promise<never> {
    throw new Error('browserContext.newCDPSession: CDP sessions are not available in Firefox (WebDriver BiDi)');
  }

  override pages(): FfPage[] {
    return super.pages() as FfPage[];
  }

  // ------------------------------------------------------------------ close
  override async close(_options: { reason?: string } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pages = [...this.pages_] as FfPage[];
    const videos = pages.map((p) => p.video()).filter((v): v is NonNullable<typeof v> => !!v);
    // What this context registered in the browser goes first, while the user context still exists:
    // a data collector (it holds every response body it collected) or preload script left behind by
    // a removed user context is never freed, and a long run grows the browser by tens of MB per context.
    const collector = this.collector;
    this.collector = undefined;
    await Promise.all([
      ...(collector ? [this.bidi.send('network.removeDataCollector', { collector }).catch(() => undefined)] : []),
      ...this.preloadScripts.splice(0).map((script) => this.bidi.send('script.removePreloadScript', { script }).catch(() => undefined)),
    ]);
    if (this.userContext !== 'default') {
      await this.bidi.send('browser.removeUserContext', { userContext: this.userContext }).catch(() => undefined);
    } else {
      for (const p of pages) await p.close().catch(() => undefined);
    }
    const deadline = Date.now() + 5000;
    while (pages.some((p) => !p.isClosed()) && Date.now() < deadline) await sleep(20);
    for (const p of pages) p.markClosed();
    await Promise.all(videos.map((v) => v.finished().catch(() => undefined)));
    this.ffBrowser_.contextClosed(this);
    this.emitEvent('close', this);
  }
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Accept-Language for a locale: "de-DE" -> "de-DE,de;q=0.9". */
export function acceptLanguage(locale: string): string {
  const base = locale.split(/[-_]/)[0];
  return base && base !== locale ? `${locale},${base};q=0.9` : locale;
}

// ---------------------------------------------------------------------- browser

export interface FfBrowserEvents {
  disconnected: FfBrowser;
}

export class FfBrowser extends TypedEmitter<FfBrowserEvents> {
  readonly contexts_ = new Map<string, FfBrowserContext>();
  private defaultContext_?: FfBrowserContext;
  private readonly pagesByContext = new Map<string, FfPage>();
  private readonly downloads = new Map<string, FfDownload>();
  private version_ = '';
  private userAgent_ = '';
  readonly downloadsDir: string;
  private closing?: Promise<void>;
  private connected = true;
  private routeIntercept?: string;
  private cspIntercept?: string;
  private interceptUpdate: Promise<void> = Promise.resolve();
  private chromeContext?: string;
  private systemAccess = true;
  private encoder?: Vp8Encoder;
  /** Default-context pages count only for persistent launches. */
  usesDefaultContext = false;

  private constructor(
    readonly bidi: BidiConnection,
    private readonly proc: LaunchedFirefox | undefined,
    readonly slowMo: number,
    private readonly browserType_: FirefoxBrowserType,
    downloadsPath?: string,
  ) {
    super();
    this.downloadsDir = downloadsPath ?? mkdtempSync(join(tmpdir(), 'eztest-downloads-'));
    bidi.on('disconnected', () => this.didDisconnect());
    this.wire();
  }

  protected override closeEventName(): string | undefined {
    return 'disconnected';
  }

  static async create(bidi: BidiConnection, proc: LaunchedFirefox | undefined, slowMo: number, type: FirefoxBrowserType, options: { downloadsPath?: string; persistent?: boolean } = {}): Promise<FfBrowser> {
    const b = new FfBrowser(bidi, proc, slowMo, type, options.downloadsPath);
    b.usesDefaultContext = !!options.persistent;
    const s = await bidi.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false, unhandledPromptBehavior: { default: 'ignore', file: 'dismiss' } } } });
    b.version_ = String(s.capabilities?.browserVersion ?? '');
    b.userAgent_ = String(s.capabilities?.userAgent ?? '');
    // Subscribe to everything this Firefox knows of our event list (older versions lack some events).
    const events = [...EVENTS];
    for (let i = 0; i < EVENTS.length; i++) {
      try {
        await bidi.send('session.subscribe', { events });
        break;
      } catch (e) {
        const bad = /(\S+) is not a valid event name/.exec((e as Error).message)?.[1];
        if (!bad || !events.includes(bad)) throw e;
        debugLog('browser', `event ${bad} is not supported by this Firefox`);
        events.splice(events.indexOf(bad), 1);
      }
    }
    // HTTP authentication is always answered by us (credentials, or cancel: the page sees the 401).
    await bidi.send('network.addIntercept', { phases: ['authRequired'] }).catch((e) => debugLog('browser', `auth intercept: ${(e as Error).message}`));
    if (options.persistent) {
      const ctx = b.defaultContext();
      const tree = await bidi.send('browsingContext.getTree', { maxDepth: 0 });
      for (const c of tree.contexts ?? []) if (!b.pagesByContext.has(c.context)) await ctx.onTopLevelCreated({ context: c.context, url: c.url, userContext: 'default' });
    }
    return b;
  }

  // ------------------------------------------------------------------ event routing
  private wire(): void {
    const on = (m: string, fn: (e: any) => void) => this.bidi.on(m, (e: any) => {
      try {
        fn(e);
      } catch (err) {
        debugLog('browser', `${m} handler failed: ${(err as Error).message}`);
      }
    });
    const page = (e: any) => this.pageOwning(e.context);
    on('browsingContext.contextCreated', (e) => {
      if (!e.parent) {
        const ctx = e.userContext === 'default' ? (this.usesDefaultContext ? this.defaultContext() : undefined) : this.contexts_.get(e.userContext);
        if (ctx && !this.pagesByContext.has(e.context)) void ctx.onTopLevelCreated(e);
        return;
      }
      const p = this.pageOwning(e.parent);
      if (p) {
        p.onContextCreated(e);
        this.pagesByContext.set(e.context, p);
      }
    });
    on('browsingContext.contextDestroyed', (e) => {
      const p = page(e);
      if (!p) return;
      p.onContextDestroyed(e);
      this.pagesByContext.delete(e.context);
    });
    on('browsingContext.navigationStarted', (e) => {
      const p = page(e);
      if (!p) return;
      p.onNavigationStarted(e);
    });
    on('browsingContext.navigationCommitted', (e) => page(e)?.onNavigationCommitted(e));
    on('browsingContext.fragmentNavigated', (e) => page(e)?.onSameDocument(e));
    on('browsingContext.historyUpdated', (e) => page(e)?.onSameDocument(e));
    on('browsingContext.domContentLoaded', (e) => page(e)?.onLifecycleEvent(e, 'DOMContentLoaded'));
    on('browsingContext.load', (e) => page(e)?.onLifecycleEvent(e, 'load'));
    on('browsingContext.navigationFailed', (e) => page(e)?.onNavigationEnded(e, 'failed'));
    on('browsingContext.navigationAborted', (e) => page(e)?.onNavigationEnded(e, 'aborted'));
    on('browsingContext.downloadWillBegin', (e) => this.onDownloadWillBegin(e));
    on('browsingContext.downloadEnd', (e) => this.onDownloadEnd(e));
    on('browsingContext.userPromptOpened', (e) => {
      const p = page(e);
      if (p) p.onUserPrompt(e);
      else void this.bidi.send('browsingContext.handleUserPrompt', { context: e.context, accept: e.type === 'beforeunload' }).catch(() => undefined);
    });
    on('script.realmCreated', (e) => {
      if (e.type === 'window') {
        page(e)?.onRealmCreated(e);
        return;
      }
      const owner = (e.owners ?? []).map((r: string) => [...new Set(this.pagesByContext.values())].find((p) => p.hasRealm(r))).find(Boolean) as FfPage | undefined;
      owner?.onRealmCreated(e);
    });
    on('script.realmDestroyed', (e) => {
      for (const p of new Set(this.pagesByContext.values())) if (p.hasRealm(e.realm)) p.onRealmDestroyed(e);
    });
    on('script.message', (e) => {
      const p = e.source?.context ? this.pageOwning(e.source.context) : undefined;
      if (!p) return;
      if (e.channel === p.ffContext().webSocketChannel) p.onWebSocketMessage(e);
      else void p.onBindingMessage(e.channel, e);
    });
    on('log.entryAdded', (e) => {
      const ctxId = e.source?.context;
      const p = ctxId ? this.pageOwning(ctxId) : [...new Set(this.pagesByContext.values())].find((x) => x.hasRealm(e.source?.realm));
      p?.onLogEntry(e);
    });
    on('network.beforeRequestSent', (e) => {
      const p = page(e);
      if (p) {
        if (e.navigation && e.request?.destination === 'document') void p.ffContext().prepareOrigin(String(e.request.url));
        p.ffNetwork.onBeforeRequestSent(e);
      } else if (e.isBlocked) {
        void this.bidi.send('network.continueRequest', { request: e.request.request }).catch(() => undefined);
      }
    });
    on('network.responseStarted', (e) => {
      const p = page(e);
      if (e.isBlocked) this.continueResponse(e, !!p?.context().options.bypassCSP);
      p?.ffNetwork.onResponseStarted(e);
    });
    on('network.responseCompleted', (e) => page(e)?.ffNetwork.onResponseCompleted(e));
    on('network.fetchError', (e) => page(e)?.ffNetwork.onFetchError(e));
    on('network.authRequired', (e) => {
      const p = page(e);
      if (p) p.ffNetwork.onAuthRequired(e);
      else if (e.isBlocked) void this.bidi.send('network.continueWithAuth', { request: e.request.request, action: 'cancel' }).catch(() => undefined);
    });
    on('input.fileDialogOpened', (e) => void page(e)?.onFileDialog(e));
  }

  /** A response held by the CSP intercept: let it through, without CSP headers for bypassCSP contexts. */
  private continueResponse(e: any, stripCsp: boolean): void {
    const params: Record<string, unknown> = { request: e.request.request };
    if (stripCsp) {
      const headers = (e.response?.headers ?? []) as Array<{ name: string; value: unknown }>;
      const value = (h: { value: unknown }) => String((h.value as { value?: unknown })?.value ?? '');
      // A CSP frame-ancestors directive overrides X-Frame-Options; without the CSP the page must stay frameable as it was.
      const framed = headers.some((h) => /^content-security-policy$/i.test(h.name) && /frame-ancestors/i.test(value(h)));
      params.headers = headers.filter((h) => !/^content-security-policy(-report-only)?$/i.test(h.name) && !(framed && /^x-frame-options$/i.test(h.name)));
    }
    void this.bidi.send('network.continueResponse', params).catch(() => undefined);
  }

  /** The page a browsing context (top-level or frame) belongs to. */
  pageOwning(contextId: string | undefined): FfPage | undefined {
    if (!contextId) return undefined;
    const p = this.pagesByContext.get(contextId);
    if (p) return p;
    for (const x of new Set(this.pagesByContext.values())) if (x.ownsContext(contextId)) return x;
    return undefined;
  }

  pageByContext(contextId: string): FfPage | undefined {
    return this.pagesByContext.get(contextId);
  }

  registerPage(page: FfPage): void {
    this.pagesByContext.set(page.contextId, page);
    page.once('close', () => {
      for (const [k, v] of this.pagesByContext) if (v === page) this.pagesByContext.delete(k);
    });
  }

  private onDownloadWillBegin(e: any): void {
    const page = this.pageOwning(e.context);
    if (!page) return;
    page.onDownloadWillBegin(e);
    const accepted = page.context().options.acceptDownloads !== false;
    const d = new FfDownload(page, String(e.url), String(e.suggestedFilename ?? ''), this, accepted);
    if (e.navigation) this.downloads.set(e.navigation, d);
    page.onDownload(d, e.context);
  }

  private onDownloadEnd(e: any): void {
    const d = this.downloads.get(e.navigation);
    if (!d) return;
    this.downloads.delete(e.navigation);
    d.onEnd(String(e.status), e.filepath ?? undefined);
  }

  // ------------------------------------------------------------------ interception
  /** Keep the request intercept in line with what the contexts need (routes, latency). */
  updateIntercepts(): Promise<void> {
    this.interceptUpdate = this.interceptUpdate.then(async () => {
      const live = [...this.allContexts()].filter((c) => !c.isClosed());
      const need = live.some((c) => c.needsInterception());
      // bypassCSP: responses pass through us and lose their Content-Security-Policy headers.
      const csp = live.some((c) => !!c.options.bypassCSP);
      if (csp && !this.cspIntercept) {
        const r = await this.bidi.send('network.addIntercept', { phases: ['responseStarted'] });
        this.cspIntercept = r.intercept;
      } else if (!csp && this.cspIntercept) {
        const id = this.cspIntercept;
        this.cspIntercept = undefined;
        await this.bidi.send('network.removeIntercept', { intercept: id }).catch(() => undefined);
      }
      if (need && !this.routeIntercept) {
        const r = await this.bidi.send('network.addIntercept', { phases: ['beforeRequestSent'] });
        this.routeIntercept = r.intercept;
      } else if (!need && this.routeIntercept) {
        const id = this.routeIntercept;
        this.routeIntercept = undefined;
        await this.bidi.send('network.removeIntercept', { intercept: id }).catch(() => undefined);
      }
    }).catch((e) => debugLog('browser', `intercept: ${(e as Error).message}`));
    return this.interceptUpdate;
  }

  // ------------------------------------------------------------------ privileged scope
  /**
   * Run a function in Firefox's privileged (chrome) scope. Returns its result,
   * or undefined when the browser was not started with system access.
   */
  async chromeCall(fn: string, args: unknown[]): Promise<unknown> {
    if (!this.systemAccess) return undefined;
    const { toLocalValue, fromRemoteValue } = await import('./realm.js');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!this.chromeContext) {
          const tree = await this.bidi.send('browsingContext.getTree', { 'moz:scope': 'chrome', maxDepth: 0 });
          this.chromeContext = tree.contexts?.[0]?.context;
          if (!this.chromeContext) return undefined;
        }
        const r = await this.bidi.send('script.callFunction', { functionDeclaration: fn, awaitPromise: true, target: { context: this.chromeContext }, arguments: args.map(toLocalValue) });
        if (r.type === 'exception') throw new Error(r.exceptionDetails?.text ?? 'chrome call failed');
        return fromRemoteValue(r.result);
      } catch (e) {
        const m = (e as Error).message;
        if (/System access is required|moz:scope|invalid argument/i.test(m)) {
          this.systemAccess = false;
          process.emitWarning('Firefox was started without system access: color scheme, reduced motion, forced colors, print media, touch and JavaScript emulation are not available', 'EZTestBrowserDriver');
          return undefined;
        }
        if (isGoneBidiError(e) && attempt === 0) {
          this.chromeContext = undefined;
          continue;
        }
        throw e;
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------------ public API
  defaultUserAgent(): string {
    return this.userAgent_;
  }

  private allContexts(): FfBrowserContext[] {
    return [...this.contexts_.values(), ...(this.defaultContext_ ? [this.defaultContext_] : [])];
  }

  defaultContext(): FfBrowserContext {
    if (!this.defaultContext_) this.defaultContext_ = new FfBrowserContext(this, 'default', { viewport: null });
    return this.defaultContext_;
  }

  contextClosed(ctx: FfBrowserContext): void {
    if (ctx.userContext !== 'default') this.contexts_.delete(ctx.userContext);
    void this.updateIntercepts();
  }

  async newContext(options: BrowserContextOptions = {}): Promise<FfBrowserContext> {
    if (!this.connected) throw new TargetClosedError('browser.newContext: Target page, context or browser has been closed');
    const params: Record<string, unknown> = {};
    if (options.ignoreHTTPSErrors) params.acceptInsecureCerts = true;
    if (options.proxy) params.proxy = bidiProxy(options.proxy);
    const { userContext } = await this.bidi.send('browser.createUserContext', params);
    const ctx = new FfBrowserContext(this, userContext, options);
    this.contexts_.set(userContext, ctx);
    if (options.bypassCSP || ctx.needsInterception()) await this.updateIntercepts();
    await ctx.initialize();
    return ctx;
  }

  async newPage(options: BrowserContextOptions = {}): Promise<FfPage> {
    const ctx = await this.newContext(options);
    const page = await ctx.newPage();
    ctx.ownerPage = page;
    return page;
  }

  contexts(): FfBrowserContext[] {
    return [...(this.defaultContext_ && this.defaultContext_.pages().length ? [this.defaultContext_] : []), ...this.contexts_.values()];
  }

  version(): string {
    return this.version_;
  }

  isConnected(): boolean {
    return this.connected;
  }

  browserType(): FirefoxBrowserType {
    return this.browserType_;
  }

  async newBrowserCDPSession(): Promise<never> {
    throw new Error('browser.newBrowserCDPSession: CDP sessions are not available in Firefox (WebDriver BiDi)');
  }

  async close(_options: { reason?: string } = {}): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        for (const ctx of [...this.contexts_.values()]) await ctx.close().catch(() => undefined);
        if (this.proc) {
          await withTimeout(this.bidi.send('browser.close'), 5000, () => 'browser.close timed out').catch(() => undefined);
          await this.proc.kill();
        } else {
          await this.bidi.send('session.end').catch(() => undefined);
          this.bidi.close();
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
    for (const p of new Set(this.pagesByContext.values())) p.markClosed();
    this.emitEvent('disconnected', this);
  }

  /** VP8 encoding for recordVideo (WebCodecs in a scratch page of this browser). */
  vp8Encoder(): Vp8Encoder | undefined {
    if (!this.connected) return undefined;
    if (!this.encoder) this.encoder = browserVp8Encoder(async () => this.newContext({ viewport: { width: 200, height: 100 } }));
    return this.encoder;
  }

  /** Internal: the browser process (undefined when connected to a running Firefox). */
  process(): LaunchedFirefox['process'] | undefined {
    return this.proc?.process;
  }

  /** Internal: CrBrowserContext compatibility (no CDP targets in Firefox). */
  pageByTargetId(id: string): FfPage | undefined {
    return this.pagesByContext.get(id);
  }
}

/** BiDi proxy configuration for a context proxy option. */
export function bidiProxy(proxy: { server: string; bypass?: string }): Record<string, unknown> {
  const raw = /^[a-z0-9+.-]+:\/\//i.test(proxy.server) ? proxy.server : `http://${proxy.server}`;
  const u = new URL(raw);
  const hostPort = `${u.hostname}:${u.port || (u.protocol.startsWith('socks') ? '1080' : u.protocol === 'https:' ? '443' : '80')}`;
  const noProxy = (proxy.bypass ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (u.protocol.startsWith('socks')) {
    return { proxyType: 'manual', socksProxy: hostPort, socksVersion: u.protocol === 'socks4:' ? 4 : 5, ...(noProxy.length ? { noProxy } : {}) };
  }
  return { proxyType: 'manual', httpProxy: hostPort, sslProxy: hostPort, ...(noProxy.length ? { noProxy } : {}) };
}

// ---------------------------------------------------------------------- browser type

export interface FirefoxLaunchExtras {
  /** Firefox preferences written to the profile's user.js (over EZTest's defaults). */
  firefoxUserPrefs?: Record<string, string | number | boolean>;
}

export class FirefoxBrowserType {
  name(): string {
    return 'firefox';
  }

  executablePath(): string {
    return findFirefox().executablePath;
  }

  private processOptions(options: LaunchOptions & FirefoxLaunchExtras, userDataDir?: string): FirefoxLaunchOptions {
    const args = [...(options.args ?? [])];
    // Emulation that BiDi lacks (color scheme, touch, JavaScript off ...) runs in Firefox's privileged scope.
    if (process.env.EZTEST_FIREFOX_SYSTEM_ACCESS !== '0' && !args.includes('--remote-allow-system-access')) args.push('--remote-allow-system-access');
    return {
      executablePath: options.executablePath,
      channel: options.channel,
      headless: options.headless,
      args,
      ignoreDefaultArgs: options.ignoreDefaultArgs,
      env: options.env,
      timeout: options.timeout,
      devtools: options.devtools,
      proxy: options.proxy,
      userPrefs: options.firefoxUserPrefs,
      ...(userDataDir ? { userDataDir } : {}),
    };
  }

  async launch(options: LaunchOptions & FirefoxLaunchExtras = {}): Promise<FfBrowser> {
    const proc = await launchFirefoxProcess(this.processOptions(options));
    const bidi = new BidiConnection(proc.transport);
    try {
      return await withTimeout(
        FfBrowser.create(bidi, proc, options.slowMo ?? 0, this, { downloadsPath: options.downloadsPath }),
        options.timeout ?? 180_000,
        () => `browserType.launch: Timeout ${options.timeout ?? 180_000}ms exceeded.\n${proc.stderrTail.slice(-15).join('\n')}`,
      );
    } catch (e) {
      await proc.kill().catch(() => undefined);
      const err = e as Error;
      if (!err.message.includes('browserType.launch')) err.message = `browserType.launch: ${err.message}${proc.stderrTail.length ? `\nBrowser output:\n${proc.stderrTail.slice(-15).join('\n')}` : ''}`;
      throw err;
    }
  }

  /** Launch with a persistent profile directory and return its default context. */
  async launchPersistentContext(userDataDir: string, options: LaunchOptions & BrowserContextOptions & FirefoxLaunchExtras = {}): Promise<FfBrowserContext> {
    const dir = userDataDir || mkdtempSync(join(tmpdir(), 'eztest-firefox-profile-'));
    await mkdir(dir, { recursive: true });
    const proc = await launchFirefoxProcess(this.processOptions(options, dir));
    const bidi = new BidiConnection(proc.transport);
    const b = await FfBrowser.create(bidi, proc, options.slowMo ?? 0, this, { downloadsPath: options.downloadsPath, persistent: true });
    const ctx = b.defaultContext();
    Object.assign(ctx.options, options);
    await ctx.initialize();
    if (options.viewport) for (const p of ctx.pages()) await p.setViewportSize(options.viewport);
    if (!ctx.pages().length) await ctx.newPage();
    ctx.on('close', () => void b.close());
    return ctx;
  }

  /**
   * Attach to a running Firefox over WebDriver BiDi, the remote protocol built into Firefox (start
   * it with `--remote-debugging-port=<port>`). `endpoint` is ws://host:port (the /session path is
   * added) or the full ws(s):// URL of a BiDi endpoint. Firefox accepts one BiDi session at a time.
   * Closing the returned browser removes only the user contexts created through it and ends the
   * session; Firefox keeps running.
   */
  async connectOverBiDi(endpoint: string, options: { headers?: Record<string, string>; timeout?: number; slowMo?: number; downloadsPath?: string } = {}): Promise<FfBrowser> {
    const timeout = options.timeout ?? 30_000;
    const u = new URL(endpoint);
    if (u.protocol === 'http:' || u.protocol === 'https:') u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/session';
    const transport = await WebSocketTransport.connect(u.toString(), timeout, options.headers);
    const bidi = new BidiConnection(transport);
    try {
      return await withTimeout(
        FfBrowser.create(bidi, undefined, options.slowMo ?? 0, this, { downloadsPath: options.downloadsPath }),
        timeout,
        () => `firefox.connectOverBiDi: Timeout ${timeout}ms exceeded starting a WebDriver BiDi session`,
      );
    } catch (e) {
      bidi.close();
      const err = e as Error;
      if (/session not created|maximum number of active sessions/i.test(err.message)) err.message = `firefox.connectOverBiDi: ${err.message} (Firefox allows one WebDriver BiDi session at a time; is another client attached?)`;
      throw err;
    }
  }

  /** Same as connectOverBiDi (Firefox's own protocol; there is no other wire protocol to connect with). */
  async connect(endpoint: string | { wsEndpoint: string }, options: { headers?: Record<string, string>; timeout?: number; slowMo?: number } = {}): Promise<FfBrowser> {
    return this.connectOverBiDi(typeof endpoint === 'string' ? endpoint : endpoint.wsEndpoint, options);
  }

  async connectOverCDP(): Promise<never> {
    throw new Error('firefox.connectOverCDP: Firefox is driven over WebDriver BiDi, not the Chrome DevTools Protocol');
  }
}
