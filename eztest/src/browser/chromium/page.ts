/**
 * A page (tab / popup): its target sessions (the page itself plus
 * out-of-process iframes), frame tree, events, emulation, routing and the
 * page-level API.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { UTILITY_WORLD_NAME } from '../injected/contract.js';
import { TypedEmitter } from '../events.js';
import { TargetClosedError, TimeoutError, isClosedError } from '../errors.js';
import { FrameLocator, Locator, type GetByRoleOptions, type LocatorOptions, type TextOptions } from '../locator.js';
import { KEEP_NAMES_SHIM, functionSource, pageCodec, serializeArgument } from '../serializer.js';
import type { CDPSession } from '../transport/connection.js';
import type { LifecycleEvent, URLMatch, ViewportSize } from '../types.js';
import { Deadline, sleep, urlMatches } from '../util.js';
import * as actions from '../actions.js';
import { routeFromHAR, type RouteFromHAROptions } from '../har.js';
import type { CrBrowserContext } from './browser.js';
import { ExecutionContext, type RemoteObject } from './exec-context.js';
import { CrFrame, type GotoOptions } from './frame.js';
import type { ElementHandle, JSHandle } from './handles.js';
import type { PageFunction } from '../eval-types.js';
import { APIRequestContext } from '../request.js';
import { Keyboard, Mouse, Touchscreen } from './input.js';
import { NetworkManager, type Request, type Response, type RouteEntry, type RouteHandlerFn, type WebSocket } from './network.js';
import { Video } from './video.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------- small event objects

export class ConsoleMessage {
  constructor(
    private readonly type_: string,
    private readonly text_: string,
    private readonly args_: JSHandle[],
    private readonly location_: { url: string; lineNumber: number; columnNumber: number },
    private readonly page_: CrPage | null,
  ) {}
  type(): string {
    return this.type_;
  }
  text(): string {
    return this.text_;
  }
  args(): JSHandle[] {
    return this.args_;
  }
  location(): { url: string; lineNumber: number; columnNumber: number } {
    return this.location_;
  }
  page(): CrPage | null {
    return this.page_;
  }
  toString(): string {
    return this.text_;
  }
}

export class Dialog {
  protected handled = false;
  constructor(
    private readonly page_: CrPage,
    private readonly session: CDPSession | null,
    private readonly type_: string,
    private readonly message_: string,
    private readonly defaultValue_: string,
  ) {}
  type(): string {
    return this.type_;
  }
  message(): string {
    return this.message_;
  }
  defaultValue(): string {
    return this.defaultValue_;
  }
  page(): CrPage {
    return this.page_;
  }
  async accept(promptText?: string): Promise<void> {
    if (this.handled) throw new Error('Cannot accept dialog which is already handled!');
    this.handled = true;
    await this.session!.send('Page.handleJavaScriptDialog', { accept: true, ...(promptText !== undefined ? { promptText } : {}) });
  }
  async dismiss(): Promise<void> {
    if (this.handled) throw new Error('Cannot dismiss dialog which is already handled!');
    this.handled = true;
    await this.session!.send('Page.handleJavaScriptDialog', { accept: false });
  }
  /** Internal: whether accept/dismiss was called. */
  isHandled(): boolean {
    return this.handled;
  }
}

export interface WorkerEvents {
  close: Worker;
  console: ConsoleMessage;
}

export class Worker extends TypedEmitter<WorkerEvents> {
  context?: ExecutionContext;
  private readonly ready: Promise<ExecutionContext>;
  private resolveReady!: (c: ExecutionContext) => void;
  /** `session` is the worker's CDP session; other engines pass null and call attachContext(). */
  constructor(readonly session: CDPSession | null, private readonly url_: string) {
    super();
    this.ready = new Promise((r) => {
      this.resolveReady = r;
    });
    session?.on('Runtime.executionContextCreated', (e: any) => {
      if (this.context) return;
      this.attachContext(new ExecutionContext(session, e.context.id, undefined, 'worker', this));
    });
  }
  /** Internal: the worker's JavaScript context is known. */
  attachContext(ctx: ExecutionContext): void {
    if (this.context) return;
    this.context = ctx;
    this.resolveReady(ctx);
  }
  url(): string {
    return this.url_;
  }
  async evaluate<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    const ctx = await this.ready;
    return (await ctx.evaluate(fn as any, [arg], true)) as R;
  }
  async evaluateHandle<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg): Promise<JSHandle<R>> {
    const ctx = await this.ready;
    return (await ctx.evaluate(fn as any, [arg], false)) as JSHandle<R>;
  }
}

export class FileChooser {
  constructor(private readonly page_: CrPage, private readonly element_: ElementHandle, private readonly multiple: boolean) {}
  page(): CrPage {
    return this.page_;
  }
  element(): ElementHandle {
    return this.element_;
  }
  isMultiple(): boolean {
    return this.multiple;
  }
  setFiles(files: Parameters<ElementHandle['setInputFiles']>[0], options?: actions.ActionOptions): Promise<void> {
    return this.element_.setInputFiles(files, options);
  }
}

export interface PageEvents {
  close: CrPage;
  console: ConsoleMessage;
  crash: CrPage;
  dialog: Dialog;
  domcontentloaded: CrPage;
  download: import('./browser.js').Download;
  filechooser: FileChooser;
  frameattached: CrFrame;
  framedetached: CrFrame;
  framenavigated: CrFrame;
  load: CrPage;
  pageerror: Error;
  popup: CrPage;
  request: Request;
  requestfailed: Request;
  requestfinished: Request;
  response: Response;
  websocket: WebSocket;
  worker: Worker;
}

export interface ScreenshotOptions {
  path?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  omitBackground?: boolean;
  mask?: Locator[];
  maskColor?: string;
  animations?: 'disabled' | 'allow';
  caret?: 'hide' | 'initial';
  scale?: 'css' | 'device';
  style?: string;
  timeout?: number;
}

export interface MediaOptions {
  media?: 'screen' | 'print' | null;
  colorScheme?: 'light' | 'dark' | 'no-preference' | null;
  reducedMotion?: 'reduce' | 'no-preference' | null;
  forcedColors?: 'active' | 'none' | null;
  contrast?: 'more' | 'no-preference' | null;
}

// ---------------------------------------------------------------------- target sessions

/** One protocol session of a page: the page target or an out-of-process iframe. */
export class TargetSession {
  readonly contexts = new Map<number, ExecutionContext>();

  constructor(
    readonly page: CrPage,
    readonly cdp: CDPSession,
    readonly isMain: boolean,
  ) {
    this.wire();
  }

  private wire(): void {
    const s = this.cdp;
    const p = this.page;
    s.on('Page.frameAttached', (e: any) => p.onFrameAttached(this, e.frameId, e.parentFrameId));
    s.on('Page.frameNavigated', (e: any) => p.onFrameNavigated(this, e.frame, e.type));
    s.on('Page.navigatedWithinDocument', (e: any) => p.onSameDocument(e.frameId, e.url));
    s.on('Page.frameDetached', (e: any) => p.onFrameDetached(e.frameId, e.reason));
    s.on('Page.frameStoppedLoading', (e: any) => p.onStoppedLoading(e.frameId));
    s.on('Page.frameStartedLoading', () => p.onStartedLoading(true));
    s.on('Page.frameStartedNavigating', () => p.onStartedLoading(true));
    s.on('Page.frameRequestedNavigation', () => p.onStartedLoading(false));
    s.on('Page.frameClearedScheduledNavigation', () => p.onScheduledNavigationCleared());
    s.on('Page.downloadWillBegin', () => p.onNavigationSettled());
    s.on('Page.lifecycleEvent', (e: any) => p.onLifecycle(e.frameId, e.loaderId, e.name));
    s.on('Page.javascriptDialogOpening', (e: any) => p.onDialog(this, e));
    s.on('Page.fileChooserOpened', (e: any) => void p.onFileChooser(this, e));
    s.on('Runtime.executionContextCreated', (e: any) => this.onContextCreated(e.context));
    s.on('Runtime.executionContextDestroyed', (e: any) => this.onContextDestroyed(e.executionContextId));
    s.on('Runtime.executionContextsCleared', () => this.onContextsCleared());
    s.on('Runtime.consoleAPICalled', (e: any) => p.onConsole(this, e));
    s.on('Runtime.exceptionThrown', (e: any) => p.onException(e.exceptionDetails));
    s.on('Runtime.bindingCalled', (e: any) => void p.onBindingCalled(this, e));
    s.on('Log.entryAdded', (e: any) => p.onLogEntry(e.entry));
    const n = p.network;
    s.on('Network.requestWillBeSent', (e: any) => n.onRequestWillBeSent(s, e));
    s.on('Network.requestWillBeSentExtraInfo', (e: any) => n.onRequestWillBeSentExtraInfo(e));
    s.on('Network.responseReceived', (e: any) => n.onResponseReceived(e));
    s.on('Network.responseReceivedExtraInfo', (e: any) => n.onResponseReceivedExtraInfo(e));
    s.on('Network.loadingFinished', (e: any) => n.onLoadingFinished(e));
    s.on('Network.loadingFailed', (e: any) => n.onLoadingFailed(e));
    s.on('Network.requestServedFromCache', (e: any) => n.onServedFromCache(e));
    s.on('Network.webSocketCreated', (e: any) => n.onWebSocketCreated(e));
    s.on('Network.webSocketFrameSent', (e: any) => n.onWebSocketFrame(e, 'framesent'));
    s.on('Network.webSocketFrameReceived', (e: any) => n.onWebSocketFrame(e, 'framereceived'));
    s.on('Network.webSocketFrameError', (e: any) => n.onWebSocketError(e));
    s.on('Network.webSocketClosed', (e: any) => n.onWebSocketClosed(e));
    s.on('Fetch.requestPaused', (e: any) => n.onRequestPaused(s, e));
    s.on('Fetch.authRequired', (e: any) => n.onAuthRequired(s, e));
    s.on('Target.attachedToTarget', (e: any) => void p.onChildAttached(this, e));
    s.on('Inspector.targetCrashed', () => p.onCrash());
  }

  /** Contexts reported before their frame (the frame tree arrives later). */
  private readonly pendingContexts = new Map<string, any[]>();

  /** Internal: a frame appeared; attach contexts that were waiting for it. */
  flushPendingContexts(frameId: string): void {
    const list = this.pendingContexts.get(frameId);
    if (!list) return;
    this.pendingContexts.delete(frameId);
    for (const c of list) this.onContextCreated(c);
  }

  private onContextCreated(c: any): void {
    const frameId = c.auxData?.frameId as string | undefined;
    const frame = frameId ? this.page.frameById(frameId) : undefined;
    if (!frame) {
      if (frameId) this.pendingContexts.set(frameId, [...(this.pendingContexts.get(frameId) ?? []), c]);
      return;
    }
    let world: 'main' | 'utility' | undefined;
    if (c.auxData?.isDefault) world = 'main';
    else if (c.name === UTILITY_WORLD_NAME) world = 'utility';
    if (!world) return;
    const ctx = new ExecutionContext(this.cdp, c.id, frame, world);
    this.contexts.set(c.id, ctx);
    frame.contextCreated(world, ctx);
  }

  private onContextDestroyed(id: number): void {
    for (const [k, list] of this.pendingContexts) this.pendingContexts.set(k, list.filter((c) => c.id !== id));
    const ctx = this.contexts.get(id);
    if (!ctx) return;
    this.contexts.delete(id);
    ctx.frame?.contextDestroyed(ctx);
  }

  private onContextsCleared(): void {
    for (const ctx of this.contexts.values()) ctx.frame?.contextDestroyed(ctx);
    this.contexts.clear();
  }

  /** Enable domains and apply the page / context state, then resume the target. */
  async initialize(): Promise<void> {
    const s = this.cdp;
    const p = this.page;
    const ctx = p.context();
    // Everything is sent in order before the target is resumed: some targets (e.g. a tab opened
    // with noopener) answer only once they run, so nothing here may wait for an answer first.
    const sends: Array<Promise<unknown>> = [
      s.send('Page.enable'),
      s.send('Page.getFrameTree').then((r) => p.onFrameTree(this, r.frameTree)),
      s.send('Page.setLifecycleEventsEnabled', { enabled: true }),
      s.send('Runtime.enable'),
      s.send('Network.enable'),
      s.send('Page.addScriptToEvaluateOnNewDocument', { source: '', worldName: UTILITY_WORLD_NAME }),
      s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
    ];
    if (this.isMain) sends.push(s.send('Log.enable'));
    // File choosers become 'filechooser' events (there is no native dialog to show in automation).
    sends.push(s.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined));
    if (ctx.bindingCount() + p.bindings.size > 0) sends.push(s.send('Runtime.addBinding', { name: BINDING_NAME }));
    for (const src of [...ctx.initScriptSources(), ...p.initScripts]) sends.push(s.send('Page.addScriptToEvaluateOnNewDocument', { source: src }));
    for (const src of [...ctx.bindingSources(), ...p.bindings.values()].map((b) => b.source)) sends.push(s.send('Page.addScriptToEvaluateOnNewDocument', { source: src }));
    sends.push(...p.emulationCommands(this));
    sends.push(this.updateInterception());
    const resumed = s.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
    const results = await Promise.allSettled(sends);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed && isClosedError(failed.reason)) throw failed.reason;
    await resumed;
  }

  /** Enable / disable request interception according to routes, credentials and client certificates. */
  async updateInterception(): Promise<void> {
    const ctx = this.page.context();
    const routes = this.page.routeEntries().length + ctx.routeEntries().length > 0 || ctx.hasClientCertificates();
    const auth = !!ctx.httpCredentials();
    if (!routes && !auth) {
      await this.cdp.send('Fetch.disable').catch(() => undefined);
      return;
    }
    await this.cdp.send('Fetch.enable', { handleAuthRequests: auth, patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }
}

const BINDING_NAME = '__ezBinding';
const CODEC = `(${pageCodec.toString()})()`;

/** Init-script source that defines window[name] as a function calling back into Node. */
export function bindingSource(name: string): string {
  return `(() => { ${KEEP_NAMES_SHIM}
    const codec = ${CODEC};
    const binding = globalThis['${BINDING_NAME}'];
    if (typeof binding !== 'function') return;
    const state = globalThis.__ezBindingState || (globalThis.__ezBindingState = { seq: 0, pending: new Map() });
    if (!globalThis.__ezDeliver) globalThis.__ezDeliver = (seq, ok, value) => {
      const p = state.pending.get(seq);
      if (!p) return;
      state.pending.delete(seq);
      if (ok) p.resolve(codec.deser(value, []));
      else { const e = new Error(value && value.message || String(value)); if (value && value.stack) e.stack = value.stack; p.reject(e); }
    };
    const name = ${JSON.stringify(name)};
    globalThis[name] = (...args) => new Promise((resolve, reject) => {
      const seq = ++state.seq;
      state.pending.set(seq, { resolve, reject });
      binding(JSON.stringify({ name, seq, args: codec.ser(args) }));
    });
  })();`;
}

export interface BindingEntry {
  name: string;
  callback: (source: { page: CrPage; frame: CrFrame; context: CrBrowserContext }, ...args: any[]) => unknown;
  source: string;
}

// ---------------------------------------------------------------------- the page

export class CrPage extends TypedEmitter<PageEvents> {
  /**
   * The page's network bookkeeping. For Chromium the CDP NetworkManager; other
   * engines provide an object with the same isIdle / documentResponse members.
   */
  readonly network: NetworkManager;
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;
  readonly touchscreen: Touchscreen;
  /** The page target's CDP session (Chromium only). */
  readonly mainSession: TargetSession;
  private readonly sessions = new Map<string, TargetSession>();
  protected readonly frames_ = new Map<string, CrFrame>();
  protected mainFrame_?: CrFrame;
  protected closed = false;
  private readonly conditionWaiters = new Set<() => void>();
  protected readonly navListeners = new Set<(frame: CrFrame, loaderId: string | undefined) => void>();
  protected readonly workers_ = new Map<string, Worker>();
  readonly initScripts: string[] = [];
  readonly bindings = new Map<string, BindingEntry>();
  protected readonly routes: RouteEntry[] = [];
  protected extraHeaders: Record<string, string> = {};
  protected viewport_: ViewportSize | null;
  protected media: MediaOptions = {};
  private defaultTimeout_?: number;
  private defaultNavigationTimeout_?: number;
  protected readonly downloadsByFrame = new Map<string, number>();
  readonly video_?: Video;
  readonly opener_?: CrPage;
  initialized = false;

  /**
   * `session` is the page target's CDP session. Other engines subclass CrPage
   * (the engine-independent page API lives here) and pass `engine` instead:
   * their network manager and input devices.
   */
  constructor(
    protected readonly context_: CrBrowserContext,
    session: CDPSession | null,
    readonly targetId: string,
    opener: CrPage | undefined,
    engine?: { network: unknown; keyboard: Keyboard; mouse: Mouse; touchscreen: Touchscreen; mainSession: unknown },
  ) {
    super();
    this.opener_ = opener;
    this.viewport_ = context_.options.viewport === null ? null : { ...(context_.options.viewport ?? { width: 1280, height: 720 }) };
    if (engine || !session) {
      if (!engine) throw new Error('CrPage needs a CDP session or an engine');
      this.network = engine.network as NetworkManager;
      this.keyboard = engine.keyboard;
      this.mouse = engine.mouse;
      this.touchscreen = engine.touchscreen;
      this.mainSession = engine.mainSession as TargetSession;
    } else {
      this.network = new NetworkManager(this);
      this.keyboard = new Keyboard(() => this.mainSession.cdp, () => this.context_.browser().slowMo);
      this.mouse = new Mouse(() => this.mainSession.cdp, this.keyboard, () => this.context_.browser().slowMo);
      this.touchscreen = new Touchscreen(() => this.mainSession.cdp, this.keyboard, () => !!this.context_.options.hasTouch);
      this.mainSession = new TargetSession(this, session, true);
      this.sessions.set(session.sessionId!, this.mainSession);
      session.on('disconnected', () => this.didClose());
    }
    if (context_.options.recordVideo) this.video_ = new Video(this, context_.options.recordVideo);
  }

  protected override eventTimeout(): number {
    return this.defaultTimeout();
  }

  /** Set up the page target. */
  async initialize(): Promise<void> {
    await this.mainSession.initialize();
    this.initialized = true;
    if (this.video_) await this.video_.start().catch(() => undefined);
  }

  // ------------------------------------------------------------------ accessors
  context(): CrBrowserContext {
    return this.context_;
  }

  mainFrame(): CrFrame {
    if (!this.mainFrame_) throw new Error('Page has no main frame yet');
    return this.mainFrame_;
  }

  frames(): CrFrame[] {
    const out: CrFrame[] = [];
    const visit = (f: CrFrame) => {
      out.push(f);
      for (const c of f.children) visit(c);
    };
    if (this.mainFrame_) visit(this.mainFrame_);
    return out;
  }

  frame(sel: string | { name?: string; url?: URLMatch }): CrFrame | null {
    const s = typeof sel === 'string' ? { name: sel } : sel;
    return this.frames().find((f) => (s.name === undefined || f.name() === s.name) && (s.url === undefined || urlMatches(undefined, f.url(), s.url))) ?? null;
  }

  frameById(id: string): CrFrame | undefined {
    return this.frames_.get(id);
  }

  async waitForFrameById(id: string, timeout: number): Promise<CrFrame | null> {
    const deadline = new Deadline(timeout);
    while (!deadline.expired()) {
      const f = this.frames_.get(id);
      if (f) return f;
      await sleep(20);
    }
    return null;
  }

  url(): string {
    return this.mainFrame_?.url() ?? '';
  }

  isClosed(): boolean {
    return this.closed;
  }

  async opener(): Promise<CrPage | null> {
    return this.opener_ && !this.opener_.isClosed() ? this.opener_ : null;
  }

  workers(): Worker[] {
    return [...this.workers_.values()];
  }

  video(): Video | null {
    return this.video_ ?? null;
  }

  viewportSize(): ViewportSize | null {
    return this.viewport_ ? { ...this.viewport_ } : null;
  }

  defaultTimeout(): number {
    return this.defaultTimeout_ ?? this.context_.defaultTimeout();
  }

  defaultNavigationTimeout(): number {
    return this.defaultNavigationTimeout_ ?? this.defaultTimeout_ ?? this.context_.defaultNavigationTimeout();
  }

  setDefaultTimeout(ms: number): void {
    this.defaultTimeout_ = ms;
  }

  setDefaultNavigationTimeout(ms: number): void {
    this.defaultNavigationTimeout_ = ms;
  }

  /** API requests sharing this page's cookies. */
  get request(): APIRequestContext {
    return this.context_.request;
  }

  /** Raw protocol session of the page target (for code that needs CDP directly). */
  cdpSession(): CDPSession {
    return this.mainSession.cdp;
  }

  // ------------------------------------------------------------------ frame tree events
  onFrameTree(session: TargetSession, tree: any): void {
    const visit = (node: any, parent: CrFrame | undefined) => {
      const known = this.frames_.has(node.frame.id) && !!this.frames_.get(node.frame.id)!.loaderId;
      const f = this.ensureFrame(session, node.frame.id, parent?.id ?? node.frame.parentId);
      // Navigation events may have overtaken the tree: never go back to the older state.
      if (known) {
        for (const c of node.childFrames ?? []) visit(c, f);
        return;
      }
      const url = node.frame.url === ':' ? 'about:blank' : node.frame.url;
      f.onCommitted(url + (node.frame.urlFragment ?? ''), node.frame.name ?? '', node.frame.loaderId);
      // Documents that were already there when we attached are considered loaded.
      if (!url || url === 'about:blank' || session !== this.mainSession || this.initialized) f.onStoppedLoading(true);
      for (const c of node.childFrames ?? []) visit(c, f);
    };
    visit(tree, undefined);
    this.notifyChange();
  }

  private ensureFrame(session: TargetSession, id: string, parentId: string | undefined): CrFrame {
    let f = this.frames_.get(id);
    if (!f) {
      f = new CrFrame(this, id, session);
      this.frames_.set(id, f);
      const parent = parentId ? this.frames_.get(parentId) : undefined;
      if (parent) {
        f.parent = parent;
        parent.children.add(f);
      } else if (!this.mainFrame_) this.mainFrame_ = f;
      if (parent) this.emitEvent('frameattached', f);
      session.flushPendingContexts(id);
    } else {
      f.session = session;
    }
    return f;
  }

  onFrameAttached(session: TargetSession, frameId: string, parentFrameId: string): void {
    const existing = this.frames_.get(frameId);
    if (existing) {
      // An out-of-process frame moving back in-process.
      existing.session = session;
      return;
    }
    this.ensureFrame(session, frameId, parentFrameId);
    this.notifyChange();
  }

  onFrameNavigated(session: TargetSession, frame: any, _type: string): void {
    const f = this.ensureFrame(session, frame.id, frame.parentId);
    // A navigation replaces the document: forget the frame's children (they re-attach).
    for (const c of [...f.children]) this.detachFrame(c);
    // Execution contexts are dropped by Runtime.executionContextDestroyed, not here: Chromium keeps
    // the contexts of an initial empty document when its first navigation reuses the window.
    this.navEnds++;
    f.onCommitted(frame.url + (frame.urlFragment ?? ''), frame.name ?? '', frame.loaderId);
    this.emitEvent('framenavigated', f);
    for (const l of [...this.navListeners]) l(f, frame.loaderId);
    this.context_.onFrameNavigated(this, f);
    this.notifyChange();
  }

  onSameDocument(frameId: string, url: string): void {
    this.navEnds++;
    const f = this.frames_.get(frameId);
    if (!f) return;
    f.onSameDocument(url);
    this.emitEvent('framenavigated', f);
    for (const l of [...this.navListeners]) l(f, undefined);
    this.notifyChange();
  }

  onFrameDetached(frameId: string, reason: string): void {
    const f = this.frames_.get(frameId);
    if (!f) return;
    if (reason === 'swap') return; // becomes an out-of-process frame; the new session takes over
    this.detachFrame(f);
    this.notifyChange();
  }

  protected detachFrame(f: CrFrame): void {
    for (const c of [...f.children]) this.detachFrame(c);
    f.detached = true;
    f.clearContexts();
    f.failWaiters(new Error('Frame was detached'));
    f.parent?.children.delete(f);
    this.frames_.delete(f.id);
    this.emitEvent('framedetached', f);
  }

  /** Navigation counters (for waiting on navigations an action started). */
  navStarts = 0;
  navEnds = 0;

  onNavigationSettled(): void {
    this.navEnds++;
    this.notifyChange();
  }

  /** A navigation that was requested (a form submit, a link) has started loading since the request. */
  private loadingSinceRequest = true;

  onStartedLoading(loading = true): void {
    this.navStarts++;
    this.loadingSinceRequest = loading;
    this.notifyChange();
  }

  /**
   * Chromium clears a scheduled navigation both when it is cancelled and when it
   * turns into a real navigation (a form POST: requested, scheduled, started
   * loading, cleared). Only a cancelled one settles: a started one settles when
   * it commits, stops or fails, so the action waits for the response (and its
   * cookies) instead of letting the next step abort the request.
   */
  onScheduledNavigationCleared(): void {
    if (this.loadingSinceRequest) return;
    this.onNavigationSettled();
  }

  /**
   * After an input action: if it started a navigation within a short grace
   * period, wait until that navigation commits or stops (like a user would).
   */
  async waitForInitiatedNavigation(before: { starts: number; ends: number }, timeout: number): Promise<void> {
    const grace = new Deadline(15);
    try {
      await this.waitForCondition(() => this.navStarts > before.starts, grace, () => 'no navigation');
    } catch {
      return;
    }
    // Any commit / same-document navigation / stop after the action ends the wait.
    await this.waitForCondition(() => this.navEnds > before.ends, new Deadline(Math.min(timeout, 10_000)), () => 'navigation did not commit').catch(() => undefined);
  }

  onStoppedLoading(frameId: string): void {
    this.navEnds++;
    this.frames_.get(frameId)?.onStoppedLoading();
    this.notifyChange();
  }

  onLifecycle(frameId: string, loaderId: string, name: string): void {
    const f = this.frames_.get(frameId);
    if (!f) return;
    f.onLifecycle(loaderId, name);
    if (f === this.mainFrame_ && loaderId === f.loaderId) {
      if (name === 'load') this.emitEvent('load', this);
      if (name === 'DOMContentLoaded') this.emitEvent('domcontentloaded', this);
    }
    this.notifyChange();
  }

  // ------------------------------------------------------------------ child targets
  async onChildAttached(parent: TargetSession, e: any): Promise<void> {
    const info = e.targetInfo;
    const session = this.context_.browser().connection.session(e.sessionId);
    if (!session) return;
    if (info.type === 'iframe') {
      const ts = new TargetSession(this, session, false);
      this.sessions.set(e.sessionId, ts);
      session.on('disconnected', () => {
        this.sessions.delete(e.sessionId);
        // Frames owned by the gone session fall back to the parent session (if they still exist).
        for (const f of this.frames_.values()) if (f.session === ts) f.session = parent;
      });
      const existing = this.frames_.get(info.targetId);
      if (existing) existing.session = ts;
      await ts.initialize().catch(() => undefined);
      return;
    }
    if (info.type === 'worker') {
      const w = new Worker(session, info.url);
      this.workers_.set(e.sessionId, w);
      session.on('disconnected', () => {
        this.workers_.delete(e.sessionId);
        w.emitEvent('close', w);
      });
      session.on('Runtime.consoleAPICalled', (ev: any) => {
        const msg = this.consoleMessage(ev, w.context);
        w.emitEvent('console', msg);
      });
      await session.send('Runtime.enable').catch(() => undefined);
      await session.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
      this.emitEvent('worker', w);
      return;
    }
    // Anything else: let it run, we do not drive it.
    await session.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
    await session.detach().catch(() => undefined);
  }

  // ------------------------------------------------------------------ page events
  onDialog(session: TargetSession, e: any): void {
    const d = new Dialog(this, session.cdp, e.type, e.message, e.defaultPrompt ?? '');
    const listeners = this.listenerCount('dialog') + this.context_.listenerCount('dialog');
    if (!listeners) {
      // Nobody listens: dismiss (beforeunload is accepted so navigation / close proceed).
      void (e.type === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => undefined);
      return;
    }
    this.emitEvent('dialog', d);
    this.context_.emitEvent('dialog', d);
  }

  async onFileChooser(session: TargetSession, e: any): Promise<void> {
    const frame = this.frames_.get(e.frameId);
    if (!frame) return;
    const ctx = await frame.context('main');
    const { object } = await session.cdp.send('DOM.resolveNode', { backendNodeId: e.backendNodeId, executionContextId: ctx.id });
    const el = ctx.createHandle(object) as ElementHandle;
    this.emitEvent('filechooser', new FileChooser(this, el, e.mode === 'selectMultiple'));
  }

  private consoleMessage(e: any, ctx: ExecutionContext | undefined): ConsoleMessage {
    const args: JSHandle[] = ctx ? (e.args as RemoteObject[]).map((a) => ctx.createHandle(a)) : [];
    const text = (e.args as RemoteObject[]).map((a) => remoteToText(a)).join(' ');
    const top = e.stackTrace?.callFrames?.[0];
    const typeMap: Record<string, string> = { warning: 'warning' };
    return new ConsoleMessage(typeMap[e.type] ?? e.type, text, args, { url: top?.url ?? '', lineNumber: top?.lineNumber ?? 0, columnNumber: top?.columnNumber ?? 0 }, this);
  }

  onConsole(session: TargetSession, e: any): void {
    const ctx = session.contexts.get(e.executionContextId);
    if (ctx && ctx.world !== 'main') return; // our own utility world
    const msg = this.consoleMessage(e, ctx);
    this.context_.tracing.onConsole(msg.type(), msg.text());
    this.emitEvent('console', msg);
    this.context_.emitEvent('console', msg);
  }

  onLogEntry(entry: any): void {
    if (entry.source === 'worker' || entry.source === 'violation' || entry.source === 'intervention' || entry.source === 'recommendation') return;
    const msg = new ConsoleMessage(entry.level === 'warning' ? 'warning' : entry.level === 'verbose' ? 'debug' : entry.level, entry.text, [], { url: entry.url ?? '', lineNumber: entry.lineNumber ?? 0, columnNumber: 0 }, this);
    this.emitEvent('console', msg);
    this.context_.emitEvent('console', msg);
  }

  onException(details: any): void {
    const ex = details.exception as RemoteObject | undefined;
    let err: Error;
    if (ex?.subtype === 'error' && ex.description) {
      const first = ex.description.split('\n')[0].replace(/^Uncaught /, '');
      const m = /^([\w$]*(?:Error|Exception)|[A-Z][\w$]*)(?::\s?([\s\S]*))?$/.exec(first);
      err = new Error(m ? (m[2] ?? '') : first);
      err.name = m ? m[1] : 'Error';
      err.stack = ex.description;
    } else if (ex && 'value' in ex) {
      err = new Error(typeof ex.value === 'string' ? ex.value : JSON.stringify(ex.value));
      err.name = '';
      err.stack = '';
    } else {
      // No exception object (e.g. thrown from a timer): parse "Uncaught Name: message".
      const text = String(details.text ?? 'Uncaught exception').replace(/^Uncaught /, '');
      const m = /^([\w$]*(?:Error|Exception))(?::\s?([\s\S]*))?$/.exec(text);
      err = new Error(m ? (m[2] ?? '') : text);
      err.name = m ? m[1] : 'Error';
      const frames = (details.stackTrace?.callFrames ?? []) as Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }>;
      err.stack = [`${err.name}: ${err.message}`, ...frames.map((f) => `    at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)].join('\n');
    }
    this.emitEvent('pageerror', err);
    this.context_.emitEvent('weberror', { page: () => this, error: () => err });
  }

  async onBindingCalled(session: TargetSession, e: any): Promise<void> {
    if (e.name !== BINDING_NAME) return;
    let payload: { name: string; seq: number; args: unknown };
    try {
      payload = JSON.parse(e.payload);
    } catch {
      return;
    }
    const ctx = session.contexts.get(e.executionContextId);
    const entry = this.bindings.get(payload.name) ?? this.context_.binding(payload.name);
    if (!ctx || !entry) return;
    const { deserializeValue } = await import('../serializer.js');
    const args = deserializeValue(payload.args) as unknown[];
    let ok = true;
    let value: unknown;
    try {
      value = await entry.callback({ page: this, frame: ctx.frame!, context: this.context_ }, ...args);
    } catch (err) {
      ok = false;
      value = { message: (err as Error).message, stack: (err as Error).stack };
    }
    const encoded = ok ? serializeArgument(value, () => false, []) : value;
    await session.cdp
      .send('Runtime.callFunctionOn', {
        functionDeclaration: 'function (seq, ok, v) { if (globalThis.__ezDeliver) globalThis.__ezDeliver(seq, ok, v); }',
        executionContextId: e.executionContextId,
        arguments: [{ value: payload.seq }, { value: ok }, { value: encoded }],
      })
      .catch(() => undefined);
  }

  onCrash(): void {
    this.emitEvent('crash', this);
  }

  onDownload(download: import('./browser.js').Download, frameId: string): void {
    this.downloadsByFrame.set(frameId, Date.now());
    this.emitEvent('download', download);
  }

  recentDownloadFor(frameId: string): boolean {
    const t = this.downloadsByFrame.get(frameId);
    return !!t && Date.now() - t < 5000;
  }

  emitRequestEvent(name: 'request' | 'requestfinished' | 'requestfailed', r: Request): void;
  emitRequestEvent(name: 'response', r: Response): void;
  emitRequestEvent(name: 'request' | 'requestfinished' | 'requestfailed' | 'response', r: Request | Response): void {
    this.emitEvent(name as 'request', r as Request);
    this.context_.emitEvent(name as 'request', r as Request);
    this.context_.onNetworkEvent(name, r);
  }

  emitWebSocket(ws: WebSocket): void {
    this.emitEvent('websocket', ws);
  }

  reportDriverWarning(message: string): void {
    process.emitWarning(message, 'EZTestBrowserDriver');
  }

  protected didClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.frames_.values()) f.failWaiters(new TargetClosedError());
    this.notifyChange();
    this.context_.onPageClosed(this);
    void this.video_?.stop();
    this.emitEvent('close', this);
  }

  // ------------------------------------------------------------------ waiting helpers
  /** Re-run condition waiters (something changed). */
  notifyChange(): void {
    for (const w of [...this.conditionWaiters]) w();
  }

  /** Wait until `pred` is true (re-checked on page changes and every 100 ms). */
  waitForCondition(pred: () => boolean, deadline: Deadline, message: () => string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const poll = setInterval(() => check(), 100);
      const done = () => {
        this.conditionWaiters.delete(check);
        if (timer) clearTimeout(timer);
        clearInterval(poll);
      };
      const check = () => {
        try {
          if (pred()) {
            done();
            resolve();
            return;
          }
        } catch (e) {
          done();
          reject(e);
          return;
        }
        if (this.closed) {
          done();
          reject(new TargetClosedError());
        }
      };
      this.conditionWaiters.add(check);
      if (Number.isFinite(deadline.end)) {
        timer = setTimeout(() => {
          done();
          reject(new TimeoutError(message()));
        }, deadline.remaining());
      }
      check();
    });
  }

  /** Resolve on the next navigation of `frame` (optionally to a matching URL). */
  nextNavigation(frame: CrFrame, deadline: Deadline, url?: URLMatch): Promise<{ loaderId?: string }> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const listener = (f: CrFrame, loaderId: string | undefined) => {
        if (f !== frame) return;
        if (url !== undefined && !urlMatches(this.context_.baseURL(), f.url(), url)) return;
        cleanup();
        resolve({ loaderId });
      };
      const onClose = () => {
        cleanup();
        reject(new TargetClosedError());
      };
      const cleanup = () => {
        this.navListeners.delete(listener);
        this.off('close', onClose);
        if (timer) clearTimeout(timer);
      };
      this.navListeners.add(listener);
      this.on('close', onClose);
      if (Number.isFinite(deadline.end)) timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`page.waitForNavigation: Timeout ${deadline.timeout}ms exceeded.`));
      }, deadline.remaining());
    });
  }

  // ------------------------------------------------------------------ emulation
  emulationCommands(ts: TargetSession): Array<Promise<unknown>> {
    const o = this.context_.options;
    const s = ts.cdp;
    const out: Array<Promise<unknown>> = [];
    const headers = { ...this.context_.extraHTTPHeaders(), ...this.extraHeaders };
    if (Object.keys(headers).length) out.push(s.send('Network.setExtraHTTPHeaders', { headers }));
    if (this.context_.isOffline()) out.push(s.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }));
    const ua = this.context_.userAgent();
    out.push(s.send('Network.setUserAgentOverride', { userAgent: ua, ...(o.locale ? { acceptLanguage: o.locale } : {}) }));
    if (o.ignoreHTTPSErrors) out.push(s.send('Security.setIgnoreCertificateErrors', { ignore: true }));
    if (o.bypassCSP) out.push(s.send('Page.setBypassCSP', { enabled: true }));
    if (o.serviceWorkers === 'block') out.push(s.send('Network.setBypassServiceWorker', { bypass: true }));
    if (!ts.isMain) return out;
    out.push(s.send('Emulation.setFocusEmulationEnabled', { enabled: true }));
    out.push(this.applyViewport(s));
    if (o.hasTouch) out.push(s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }));
    out.push(s.send('Emulation.setUserAgentOverride', { userAgent: ua, ...(o.locale ? { acceptLanguage: o.locale } : {}) }));
    if (o.locale) out.push(s.send('Emulation.setLocaleOverride', { locale: o.locale }));
    if (o.timezoneId) out.push(s.send('Emulation.setTimezoneOverride', { timezoneId: o.timezoneId }));
    const geo = this.context_.geolocation();
    if (geo) out.push(s.send('Emulation.setGeolocationOverride', { latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy ?? 0 }));
    if (o.javaScriptEnabled === false) out.push(s.send('Emulation.setScriptExecutionDisabled', { value: true }));
    this.media = {
      colorScheme: o.colorScheme ?? undefined,
      reducedMotion: o.reducedMotion ?? undefined,
      forcedColors: o.forcedColors ?? undefined,
      contrast: o.contrast ?? undefined,
    };
    out.push(this.applyMedia());
    if (this.context_.downloadBehaviorPending()) out.push(this.context_.applyDownloadBehavior());
    return out;
  }

  private applyViewport(s: CDPSession): Promise<unknown> {
    const o = this.context_.options;
    if (!this.viewport_) return Promise.resolve();
    const mobile = !!o.isMobile;
    const screen = o.screen ?? this.viewport_;
    return s.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport_.width,
      height: this.viewport_.height,
      deviceScaleFactor: o.deviceScaleFactor ?? 1,
      mobile,
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenOrientation: mobile
        ? (this.viewport_.width > this.viewport_.height ? { angle: 90, type: 'landscapePrimary' } : { angle: 0, type: 'portraitPrimary' })
        : { angle: 0, type: 'landscapePrimary' },
    });
  }

  private applyMedia(): Promise<unknown> {
    const m = this.media;
    const features: Array<{ name: string; value: string }> = [
      { name: 'prefers-color-scheme', value: m.colorScheme ?? '' },
      { name: 'prefers-reduced-motion', value: m.reducedMotion ?? '' },
      { name: 'forced-colors', value: m.forcedColors ?? '' },
      { name: 'prefers-contrast', value: m.contrast ?? '' },
    ];
    return this.mainSession.cdp.send('Emulation.setEmulatedMedia', { media: m.media ?? '', features });
  }

  async setViewportSize(size: ViewportSize): Promise<void> {
    this.viewport_ = { width: size.width, height: size.height };
    await this.applyViewport(this.mainSession.cdp);
  }

  async emulateMedia(options: MediaOptions = {}): Promise<void> {
    for (const k of ['media', 'colorScheme', 'reducedMotion', 'forcedColors', 'contrast'] as const) {
      if (k in options) (this.media as Record<string, unknown>)[k] = options[k] ?? undefined;
    }
    await this.applyMedia();
  }

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    await this.applyExtraHeaders();
  }

  async applyExtraHeaders(): Promise<void> {
    const headers = { ...this.context_.extraHTTPHeaders(), ...this.extraHeaders };
    await Promise.all([...this.sessions.values()].map((s) => s.cdp.send('Network.setExtraHTTPHeaders', { headers }).catch(() => undefined)));
  }

  /** Send a command to every session of the page (main + out-of-process frames). */
  async broadcast(method: string, params: Record<string, unknown> = {}, mainOnly = false): Promise<void> {
    const targets = mainOnly ? [this.mainSession] : [...this.sessions.values()];
    await Promise.all(targets.map((s) => s.cdp.send(method, params).catch((e) => {
      if (!isClosedError(e)) throw e;
    })));
  }

  // ------------------------------------------------------------------ scripts and bindings
  async addInitScript(script: string | ((arg: any) => unknown) | { path?: string; content?: string }, arg?: unknown): Promise<void> {
    const source = await initScriptSource(script, arg);
    this.initScripts.push(source);
    await this.addScriptToSessions(source);
  }

  async addScriptToSessions(source: string): Promise<void> {
    await this.broadcast('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async exposeBinding(name: string, callback: BindingEntry['callback'], _options: { handle?: boolean } = {}): Promise<void> {
    if (this.bindings.has(name) || this.context_.binding(name)) throw new Error(`Function "${name}" has been already registered`);
    const entry: BindingEntry = { name, callback, source: bindingSource(name) };
    this.bindings.set(name, entry);
    await this.installBinding(entry);
  }

  async exposeFunction(name: string, fn: (...args: any[]) => unknown): Promise<void> {
    await this.exposeBinding(name, (_src, ...args) => fn(...args));
  }

  async installBinding(entry: BindingEntry): Promise<void> {
    await this.broadcast('Runtime.addBinding', { name: BINDING_NAME });
    await this.addScriptToSessions(entry.source);
    // Existing documents get the function right away.
    await Promise.all(this.frames().map(async (f) => {
      try {
        const ctx = await f.context('main', 5000);
        await ctx.session.send('Runtime.evaluate', { expression: entry.source, contextId: ctx.id });
      } catch {
        /* frame went away */
      }
    }));
  }

  // ------------------------------------------------------------------ routing
  routeEntries(): RouteEntry[] {
    return this.routes;
  }

  async route(url: URLMatch, handler: RouteHandlerFn, options: { times?: number } = {}): Promise<void> {
    this.routes.unshift({ url, handler, times: options.times, count: 0 });
    await this.updateInterception();
  }

  async unroute(url: URLMatch, handler?: RouteHandlerFn): Promise<void> {
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i];
      if (sameMatcher(r.url, url) && (!handler || r.handler === handler)) this.routes.splice(i, 1);
    }
    await this.updateInterception();
  }

  async unrouteAll(_options: { behavior?: 'wait' | 'ignoreErrors' | 'default' } = {}): Promise<void> {
    this.routes.splice(0);
    await this.updateInterception();
  }

  async routeFromHAR(har: string, options: RouteFromHAROptions = {}): Promise<void> {
    await routeFromHAR(this, har, options);
  }

  async updateInterception(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.updateInterception().catch(() => undefined)));
  }

  // ------------------------------------------------------------------ main-frame delegation
  evaluate<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    return this.mainFrame().evaluate(fn, arg).catch((e: Error) => {
      e.message = e.message.replace(/^frame\.evaluate:/, 'page.evaluate:');
      throw e;
    });
  }

  evaluateHandle<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg): Promise<JSHandle<R>> {
    return this.mainFrame().evaluateHandle(fn, arg);
  }

  $(selector: string): Promise<ElementHandle | null> {
    return this.mainFrame().$(selector);
  }

  $$(selector: string): Promise<ElementHandle[]> {
    return this.mainFrame().$$(selector);
  }

  $eval<R, Arg = unknown>(selector: string, fn: (el: Element, arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    return this.mainFrame()['$eval'](selector, fn, arg);
  }

  $$eval<R, Arg = unknown>(selector: string, fn: (els: Element[], arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    return this.mainFrame()['$$eval'](selector, fn, arg);
  }

  waitForSelector(selector: string, options?: Parameters<CrFrame['waitForSelector']>[1]): Promise<ElementHandle | null> {
    return this.mainFrame().waitForSelector(selector, options);
  }

  waitForFunction<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg, options?: { timeout?: number; polling?: number | 'raf' }): Promise<JSHandle<R>> {
    return this.mainFrame().waitForFunction(fn, arg, options);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }

  locator(selector: string | Locator, options?: LocatorOptions): Locator {
    return Locator.fromScope({ kind: 'page', page: this }, selector, options);
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return Locator.root({ kind: 'page', page: this }).getByRole(role, options);
  }

  getByText(text: string | RegExp, options?: TextOptions): Locator {
    return Locator.root({ kind: 'page', page: this }).getByText(text, options);
  }

  getByLabel(text: string | RegExp, options?: TextOptions): Locator {
    return Locator.root({ kind: 'page', page: this }).getByLabel(text, options);
  }

  getByPlaceholder(text: string | RegExp, options?: TextOptions): Locator {
    return Locator.root({ kind: 'page', page: this }).getByPlaceholder(text, options);
  }

  getByAltText(text: string | RegExp, options?: TextOptions): Locator {
    return Locator.root({ kind: 'page', page: this }).getByAltText(text, options);
  }

  getByTitle(text: string | RegExp, options?: TextOptions): Locator {
    return Locator.root({ kind: 'page', page: this }).getByTitle(text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return Locator.root({ kind: 'page', page: this }).getByTestId(testId);
  }

  frameLocator(selector: string): FrameLocator {
    return new FrameLocator({ kind: 'page', page: this }, selector);
  }

  click(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.mainFrame().click(selector, options);
  }

  dblclick(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.mainFrame().dblclick(selector, options);
  }

  hover(selector: string, options?: actions.PointerOptions): Promise<void> {
    return this.mainFrame().hover(selector, options);
  }

  tap(selector: string, options?: actions.PointerOptions): Promise<void> {
    return this.mainFrame().tap(selector, options);
  }

  fill(selector: string, value: string, options?: actions.ActionOptions): Promise<void> {
    return this.mainFrame().fill(selector, value, options);
  }

  type(selector: string, text: string, options?: actions.TypeOptions): Promise<void> {
    return this.mainFrame().type(selector, text, options);
  }

  press(selector: string, key: string, options?: actions.TypeOptions): Promise<void> {
    return this.mainFrame().press(selector, key, options);
  }

  focus(selector: string, options?: actions.ActionOptions): Promise<void> {
    return this.mainFrame().focus(selector, options);
  }

  check(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.mainFrame().check(selector, options);
  }

  uncheck(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.mainFrame().uncheck(selector, options);
  }

  setChecked(selector: string, checked: boolean, options?: actions.ClickOptions): Promise<void> {
    return this.mainFrame().setChecked(selector, checked, options);
  }

  selectOption(selector: string, values: actions.SelectValues, options?: actions.ActionOptions): Promise<string[]> {
    return this.mainFrame().selectOption(selector, values, options);
  }

  setInputFiles(selector: string, files: Parameters<Locator['setInputFiles']>[0], options?: actions.ActionOptions): Promise<void> {
    return this.mainFrame().setInputFiles(selector, files, options);
  }

  dispatchEvent(selector: string, type: string, eventInit?: Record<string, unknown>, options?: actions.ActionOptions): Promise<void> {
    return this.mainFrame().dispatchEvent(selector, type, eventInit, options);
  }

  textContent(selector: string, options?: actions.ActionOptions): Promise<string | null> {
    return this.mainFrame().textContent(selector, options);
  }

  innerText(selector: string, options?: actions.ActionOptions): Promise<string> {
    return this.mainFrame().innerText(selector, options);
  }

  innerHTML(selector: string, options?: actions.ActionOptions): Promise<string> {
    return this.mainFrame().innerHTML(selector, options);
  }

  getAttribute(selector: string, name: string, options?: actions.ActionOptions): Promise<string | null> {
    return this.mainFrame().getAttribute(selector, name, options);
  }

  inputValue(selector: string, options?: actions.ActionOptions): Promise<string> {
    return this.mainFrame().inputValue(selector, options);
  }

  isVisible(selector: string): Promise<boolean> {
    return this.mainFrame().isVisible(selector);
  }

  isHidden(selector: string): Promise<boolean> {
    return this.mainFrame().isHidden(selector);
  }

  isEnabled(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.mainFrame().isEnabled(selector, options);
  }

  isDisabled(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.mainFrame().isDisabled(selector, options);
  }

  isEditable(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.mainFrame().isEditable(selector, options);
  }

  isChecked(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.mainFrame().isChecked(selector, options);
  }

  async dragAndDrop(source: string, target: string, options: { timeout?: number; force?: boolean } = {}): Promise<void> {
    await this.locator(source).first().dragTo(this.locator(target).first(), options);
  }

  content(): Promise<string> {
    return this.mainFrame().content();
  }

  setContent(html: string, options?: { waitUntil?: LifecycleEvent; timeout?: number }): Promise<void> {
    return this.mainFrame().setContent(html, options);
  }

  title(): Promise<string> {
    return this.mainFrame().title();
  }

  addScriptTag(options: Parameters<CrFrame['addScriptTag']>[0]): Promise<ElementHandle> {
    return this.mainFrame().addScriptTag(options);
  }

  addStyleTag(options: Parameters<CrFrame['addStyleTag']>[0]): Promise<ElementHandle> {
    return this.mainFrame().addStyleTag(options);
  }

  // ------------------------------------------------------------------ navigation
  goto(url: string, options?: GotoOptions): Promise<Response | null> {
    return this.mainFrame().goto(url, options);
  }

  waitForURL(url: URLMatch, options?: { timeout?: number; waitUntil?: LifecycleEvent }): Promise<void> {
    return this.mainFrame().waitForURL(url, options);
  }

  waitForLoadState(state?: LifecycleEvent, options?: { timeout?: number }): Promise<void> {
    return this.mainFrame().waitForLoadState(state, options);
  }

  waitForNavigation(options?: { url?: URLMatch; waitUntil?: LifecycleEvent; timeout?: number }): Promise<Response | null> {
    return this.mainFrame().waitForNavigation(options);
  }

  async reload(options: { waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<Response | null> {
    const deadline = new Deadline(options.timeout ?? this.defaultNavigationTimeout());
    const frame = this.mainFrame();
    const nav = this.nextNavigation(frame, deadline);
    await this.mainSession.cdp.send('Page.reload', {});
    const { loaderId } = await nav;
    if (!loaderId) return null;
    await frame.waitForDocument(loaderId, options.waitUntil ?? 'load', deadline, 'page.reload');
    return this.network.documentResponse(loaderId);
  }

  private async history(delta: number, options: { waitUntil?: LifecycleEvent; timeout?: number }, api: string): Promise<Response | null> {
    const { currentIndex, entries } = await this.mainSession.cdp.send('Page.getNavigationHistory');
    const entry = entries[currentIndex + delta];
    if (!entry) return null;
    const deadline = new Deadline(options.timeout ?? this.defaultNavigationTimeout());
    const frame = this.mainFrame();
    const nav = this.nextNavigation(frame, deadline);
    await this.mainSession.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    const { loaderId } = await nav;
    if (!loaderId) return null;
    await frame.waitForDocument(loaderId, options.waitUntil ?? 'load', deadline, api);
    return this.network.documentResponse(loaderId);
  }

  goBack(options: { waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<Response | null> {
    return this.history(-1, options, 'page.goBack');
  }

  goForward(options: { waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<Response | null> {
    return this.history(1, options, 'page.goForward');
  }

  /** Wait for a request matching url / predicate. */
  async waitForRequest(match: URLMatch | ((r: Request) => boolean | Promise<boolean>), options: { timeout?: number } = {}): Promise<Request> {
    const pred = typeof match === 'function' && !(match instanceof RegExp)
      ? (r: Request) => (match as (r: Request) => boolean | Promise<boolean>)(r)
      : (r: Request) => urlMatches(this.context_.baseURL(), r.url(), match as URLMatch);
    return this.waitForEvent('request', { predicate: pred, timeout: options.timeout ?? this.defaultTimeout() });
  }

  async waitForResponse(match: URLMatch | ((r: Response) => boolean | Promise<boolean>), options: { timeout?: number } = {}): Promise<Response> {
    const pred = typeof match === 'function' && !(match instanceof RegExp)
      ? (r: Response) => (match as (r: Response) => boolean | Promise<boolean>)(r)
      : (r: Response) => urlMatches(this.context_.baseURL(), r.url(), match as URLMatch);
    return this.waitForEvent('response', { predicate: pred, timeout: options.timeout ?? this.defaultTimeout() });
  }

  // ------------------------------------------------------------------ page operations
  async bringToFront(): Promise<void> {
    await this.mainSession.cdp.send('Page.bringToFront');
  }

  async close(options: { runBeforeUnload?: boolean; reason?: string } = {}): Promise<void> {
    if (this.closed) return;
    const closed = new Promise<void>((r) => this.once('close', () => r()));
    if (options.runBeforeUnload) {
      await this.mainSession.cdp.send('Page.close').catch(() => undefined);
      return;
    }
    await this.context_.browser().connection.root.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
    await Promise.race([closed, sleep(5000)]);
  }

  async pause(): Promise<void> {
    /* No inspector: a no-op kept for API compatibility. */
  }

  async pdf(options: { path?: string; scale?: number; displayHeaderFooter?: boolean; headerTemplate?: string; footerTemplate?: string; printBackground?: boolean; landscape?: boolean; pageRanges?: string; format?: string; width?: string | number; height?: string | number; margin?: { top?: string | number; right?: string | number; bottom?: string | number; left?: string | number }; preferCSSPageSize?: boolean } = {}): Promise<Buffer> {
    const inch = (v: string | number | undefined, d: number): number => {
      if (v === undefined) return d;
      if (typeof v === 'number') return v / 96;
      const m = /^([\d.]+)\s*(px|in|cm|mm)?$/.exec(v.trim());
      if (!m) return d;
      const n = Number(m[1]);
      const unit = m[2] ?? 'px';
      return unit === 'in' ? n : unit === 'cm' ? n / 2.54 : unit === 'mm' ? n / 25.4 : n / 96;
    };
    const formats: Record<string, [number, number]> = { letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17], ledger: [17, 11], a0: [33.1, 46.8], a1: [23.4, 33.1], a2: [16.54, 23.4], a3: [11.7, 16.54], a4: [8.27, 11.7], a5: [5.83, 8.27], a6: [4.13, 5.83] };
    const f = formats[(options.format ?? 'letter').toLowerCase()] ?? formats.letter;
    const r = await this.mainSession.cdp.send('Page.printToPDF', {
      scale: options.scale ?? 1,
      displayHeaderFooter: !!options.displayHeaderFooter,
      headerTemplate: options.headerTemplate ?? '',
      footerTemplate: options.footerTemplate ?? '',
      printBackground: !!options.printBackground,
      landscape: !!options.landscape,
      pageRanges: options.pageRanges ?? '',
      paperWidth: inch(options.width, f[0]),
      paperHeight: inch(options.height, f[1]),
      marginTop: inch(options.margin?.top, 0),
      marginRight: inch(options.margin?.right, 0),
      marginBottom: inch(options.margin?.bottom, 0),
      marginLeft: inch(options.margin?.left, 0),
      preferCSSPageSize: !!options.preferCSSPageSize,
    });
    const buf = Buffer.from(r.data as string, 'base64');
    if (options.path) await writeFile(options.path, buf);
    return buf;
  }

  // ------------------------------------------------------------------ screenshots and screencast
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const s = this.mainSession.cdp;
    const frame = this.mainFrame();
    const type = options.type ?? (options.path && /\.jpe?g$/i.test(options.path) ? 'jpeg' : 'png');
    const metrics = await s.send('Page.getLayoutMetrics');
    const vv = metrics.cssVisualViewport ?? metrics.visualViewport ?? { pageX: 0, pageY: 0, clientWidth: 0, clientHeight: 0 };
    const dpr = this.context_.options.deviceScaleFactor ?? 1;
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    let beyond = false;
    if (options.fullPage) {
      const size = metrics.cssContentSize ?? metrics.contentSize;
      clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      beyond = true;
    } else if (options.clip) {
      clip = { x: options.clip.x + vv.pageX, y: options.clip.y + vv.pageY, width: options.clip.width, height: options.clip.height, scale: 1 };
      beyond = true;
    }
    if (options.scale === 'css' && dpr !== 1) {
      clip = clip ?? { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale: 1 };
      clip.scale = 1 / dpr;
    }
    return this.capture({ type, quality: options.quality, clip, beyond, options, frame, path: options.path });
  }

  /** Internal: capture with masks / styles / background options applied. */
  async capture(o: { type: 'png' | 'jpeg'; quality?: number; clip?: { x: number; y: number; width: number; height: number; scale: number }; beyond: boolean; options: ScreenshotOptions; frame: CrFrame; path?: string }): Promise<Buffer> {
    const s = this.mainSession.cdp;
    const opts = o.options;
    const cleanups: Array<() => Promise<unknown>> = [];
    try {
      const css: string[] = [];
      if ((opts.caret ?? 'hide') === 'hide') css.push('*, *::before, *::after { caret-color: transparent !important; }');
      if (opts.animations === 'disabled') css.push('*, *::before, *::after { animation-play-state: paused !important; transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; }');
      if (opts.style) css.push(opts.style);
      const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const m of opts.mask ?? []) rects.push(...(await m.boundingBoxesAll()));
      if (rects.length || css.length) {
        await this.mainFrame().utility((_e, h, r, color, style) => h.overlay(r, color, style), [rects, opts.maskColor ?? '#FF00FF', css.join('\n') || undefined]);
        cleanups.push(() => this.mainFrame().utility((_e, h) => h.removeOverlay()).catch(() => undefined));
      }
      if (opts.omitBackground) {
        await s.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        cleanups.push(() => s.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => undefined));
      }
      const r = await s.send('Page.captureScreenshot', {
        format: o.type,
        ...(o.type === 'jpeg' ? { quality: o.quality ?? 80 } : {}),
        ...(o.clip ? { clip: o.clip } : {}),
        captureBeyondViewport: o.beyond,
        fromSurface: true,
      });
      const buf = Buffer.from(r.data as string, 'base64');
      if (o.path) await writeFile(o.path, buf);
      return buf;
    } finally {
      for (const c of cleanups.reverse()) await c();
    }
  }

  /**
   * Start a screencast: `onFrame` receives each JPEG/PNG frame with its
   * timestamp (seconds). Returns a function that stops it.
   */
  async startScreencast(options: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number }, onFrame: (frame: { data: Buffer; timestamp: number; metadata: Record<string, number> }) => void): Promise<() => Promise<void>> {
    const s = this.mainSession.cdp;
    const listener = (e: any) => {
      void s.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
      onFrame({ data: Buffer.from(e.data, 'base64'), timestamp: e.metadata?.timestamp ?? Date.now() / 1000, metadata: e.metadata ?? {} });
    };
    s.on('Page.screencastFrame', listener);
    await s.send('Page.startScreencast', { format: options.format ?? 'jpeg', quality: options.quality ?? 80, maxWidth: options.maxWidth, maxHeight: options.maxHeight, everyNthFrame: options.everyNthFrame ?? 1 });
    return async () => {
      s.off('Page.screencastFrame', listener);
      await s.send('Page.stopScreencast').catch(() => undefined);
    };
  }

  /** Accessibility tree as YAML (see Locator.ariaSnapshot). */
  async ariaSnapshot(): Promise<string> {
    return this.locator('body').ariaSnapshot();
  }
}

export function remoteToText(a: RemoteObject): string {
  if (a.type === 'string') return String(a.value);
  if (a.type === 'undefined') return 'undefined';
  if (a.unserializableValue !== undefined) return a.unserializableValue;
  if (a.type === 'number' || a.type === 'boolean' || a.type === 'bigint') return String(a.value);
  if (a.subtype === 'null') return 'null';
  if (a.objectId) return `JSHandle@${a.subtype === 'node' ? 'node' : a.subtype === 'array' ? 'array' : a.subtype === 'error' ? 'error' : 'object'}`;
  return a.description ?? String(a.value);
}

export function sameMatcher(a: URLMatch, b: URLMatch): boolean {
  if (a === b) return true;
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  return false;
}

/** Source of an init script from a function, string, or {path|content}. */
export async function initScriptSource(script: string | ((arg: any) => unknown) | { path?: string; content?: string }, arg?: unknown): Promise<string> {
  if (typeof script === 'function') return `(() => { ${KEEP_NAMES_SHIM} return (${functionSource(script)})(${arg === undefined ? 'undefined' : JSON.stringify(arg)}); })()`;
  if (typeof script === 'string') return script;
  if (script.path) return `${await readFile(script.path, 'utf8')}\n//# sourceURL=${script.path.replace(/\n/g, '')}`;
  if (script.content !== undefined) return script.content;
  throw new Error('Either path or content property must be present');
}
