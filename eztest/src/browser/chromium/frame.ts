/**
 * A frame: its document lifecycle, execution contexts (main world and the
 * driver's isolated engine world), navigation, and the frame-level API.
 */
import { readFile } from 'node:fs/promises';
import { ENGINE_WORLD_NAME } from '../injected/contract.js';
import { TimeoutError, TargetClosedError, isContextGoneError, rewriteError } from '../errors.js';
import { FRAME_GONE_TEXT, timeoutMessage, tooManyMatchesMessage } from '../messages.js';
import { FrameLocator, Locator, frameScope, type GetByRoleOptions, type LocatorOptions, type TextOptions } from '../locator.js';
import type { LifecycleEvent, URLMatch } from '../types.js';
import { Deadline, deferred, sleep, urlMatches, type Deferred } from '../util.js';
import * as actions from '../actions.js';
import type { ExecutionContext, World } from './exec-context.js';
import type { ElementHandle, JSHandle } from './handles.js';
import type { PageFunction } from '../eval-types.js';
import type { ChromiumPage, TargetSession } from './page.js';
import type { Response } from './network.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GotoOptions {
  waitUntil?: LifecycleEvent;
  timeout?: number;
  referer?: string;
}

export class ChromiumFrame {
  url_ = '';
  name_ = '';
  loaderId = '';
  parent?: ChromiumFrame;
  readonly children = new Set<ChromiumFrame>();
  detached = false;
  /** Lifecycle events reached, per document (loaderId). */
  protected readonly lifecycle = new Map<string, Set<string>>();
  protected readonly contexts: Partial<Record<World, ExecutionContext>> = {};
  protected readonly contextWaiters: Record<'main' | 'engine', Array<Deferred<ExecutionContext>>> = { main: [], engine: [] };
  private creatingEngineWorld?: Promise<unknown>;

  constructor(
    readonly _page: ChromiumPage,
    readonly id: string,
    /** The target session that owns this frame (page session, or an out-of-process iframe's session). */
    public session: TargetSession,
  ) {}

  // ------------------------------------------------------------------ tree and identity
  name(): string {
    return this.name_;
  }

  url(): string {
    return this.url_;
  }

  parentFrame(): ChromiumFrame | null {
    return this.parent ?? null;
  }

  childFrames(): ChromiumFrame[] {
    return [...this.children];
  }

  isDetached(): boolean {
    return this.detached;
  }

  /** The page this frame belongs to. */
  page(): ChromiumPage {
    return this._page;
  }

  /** The <iframe>/<frame> element hosting this frame (in the parent frame's main world). */
  async frameElement(): Promise<ElementHandle> {
    const h = await this.ownerElement('main');
    if (!h) throw new Error(FRAME_GONE_TEXT);
    return h;
  }

  /** Owner element in the parent frame, in the given world. */
  async ownerElement(world: 'main' | 'engine'): Promise<ElementHandle | undefined> {
    const parent = this.parent;
    if (!parent) return undefined;
    const { backendNodeId } = await parent.session.cdp.send('DOM.getFrameOwner', { frameId: this.id });
    const ctx = await parent.context(world);
    const { object } = await parent.session.cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: ctx.id });
    return ctx.createHandle(object) as ElementHandle;
  }

  /** Offset of this frame's viewport inside the top-level viewport (CSS px). */
  async viewportOffset(): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;
    for (let f: ChromiumFrame | undefined = this; f?.parent; f = f.parent) {
      const owner = await f.ownerElement('engine');
      if (!owner) break;
      const ctx = owner.context;
      const o = await ctx.callEngine((_e, h, el) => h.frameContentOffset(el), [owner]);
      await owner.dispose();
      x += o.x;
      y += o.y;
    }
    return { x, y };
  }

  // ------------------------------------------------------------------ lifecycle (driven by the page)
  onCommitted(url: string, name: string, loaderId: string | undefined): void {
    this.url_ = url;
    this.name_ = name;
    if (loaderId && loaderId !== this.loaderId) {
      for (const k of this.lifecycle.keys()) if (k !== loaderId) this.lifecycle.delete(k);
      this.loaderId = loaderId;
    }
    this.lifecycleSet(this.loaderId).add('commit');
  }

  onSameDocument(url: string): void {
    this.url_ = url;
  }

  onLifecycle(loaderId: string | undefined, name: string): void {
    const id = loaderId || this.loaderId;
    if (name === 'init') {
      this.lifecycle.set(id, new Set(['commit', 'init']));
      return;
    }
    const map: Record<string, LifecycleEvent> = { DOMContentLoaded: 'domcontentloaded', load: 'load' };
    const ev = map[name];
    if (ev) this.lifecycleSet(id).add(ev);
  }

  /**
   * Page.frameStoppedLoading: counts as loaded only for documents that never
   * reported lifecycle events (initial about:blank, some error pages). A real
   * document waits for its own load event: a "stopped" of the previous
   * navigation may arrive after the next one committed.
   */
  onStoppedLoading(force = false): void {
    const s = this.lifecycleSet(this.loaderId);
    if (s.has('init') && !force) return;
    s.add('domcontentloaded');
    s.add('load');
  }

  private lifecycleSet(loaderId: string): Set<string> {
    let s = this.lifecycle.get(loaderId);
    if (!s) this.lifecycle.set(loaderId, (s = new Set()));
    return s;
  }

  /** Has the current document reached `state`? */
  hasLifecycle(state: LifecycleEvent): boolean {
    if (state === 'networkidle') return this.hasLifecycle('load') && this._page.network.isIdle(500);
    return this.lifecycleSet(this.loaderId).has(state);
  }

  // ------------------------------------------------------------------ execution contexts
  contextCreated(world: World, ctx: ExecutionContext): void {
    if (world === 'worker') return;
    this.contexts[world] = ctx;
    for (const w of this.contextWaiters[world].splice(0)) w.resolve(ctx);
  }

  contextDestroyed(ctx: ExecutionContext): void {
    ctx.disposed = true;
    for (const w of ['main', 'engine'] as const) if (this.contexts[w] === ctx) delete this.contexts[w];
  }

  /** Drop all contexts (new document / session reset). */
  clearContexts(): void {
    for (const w of ['main', 'engine'] as const) {
      const c = this.contexts[w];
      if (c) c.disposed = true;
      delete this.contexts[w];
    }
  }

  /** The current execution context of a world, waiting for it (and creating the engine world) as needed. */
  async context(world: 'main' | 'engine', timeout = 30_000): Promise<ExecutionContext> {
    const existing = this.contexts[world];
    if (existing && !existing.disposed) return existing;
    if (this.detached) throw new Error(FRAME_GONE_TEXT);
    if (this._page.isClosed()) throw new TargetClosedError();
    const d = deferred<ExecutionContext>();
    this.contextWaiters[world].push(d);
    if (world === 'main') this.requestMainWorld();
    if (world === 'engine' && !this.creatingEngineWorld) {
      this.creatingEngineWorld = this.createEngineWorld()
        .catch(() => undefined)
        .finally(() => {
          this.creatingEngineWorld = undefined;
        });
    }
    const timer = setTimeout(() => d.reject(new TimeoutError(`Timed out waiting for the ${world} world of frame ${this.url_}`)), timeout);
    try {
      return await d.promise;
    } finally {
      clearTimeout(timer);
      const i = this.contextWaiters[world].indexOf(d);
      if (i >= 0) this.contextWaiters[world].splice(i, 1);
    }
  }

  /** Engine hook: the main world is waited for (it comes with the document); engines that must create it do so here. */
  protected requestMainWorld(): void {
    /* the main world arrives by itself */
  }

  /** Ask the browser for the engine world of the current document (it arrives as a context event). */
  protected async createEngineWorld(): Promise<unknown> {
    return this.session.cdp.send('Page.createIsolatedWorld', { frameId: this.id, worldName: ENGINE_WORLD_NAME, grantUniveralAccess: true });
  }

  /** Internal: reject context waiters (detach / close). */
  failWaiters(e: Error): void {
    for (const w of ['main', 'engine'] as const) for (const d of this.contextWaiters[w].splice(0)) d.reject(e);
  }

  /** Run an engine-world call, retrying once the document changes under it. */
  async inEngine<R>(fn: (engine: any, helpers: any, ...args: any[]) => R | Promise<R>, args: unknown[] = [], returnByValue = true): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      const ctx = await this.context('engine');
      try {
        return await ctx.callEngine(fn, args, returnByValue);
      } catch (e) {
        if (attempt < 5 && ((e as { contextGone?: boolean }).contextGone || isContextGoneError(e))) {
          await sleep(20);
          continue;
        }
        throw e;
      }
    }
  }

  // ------------------------------------------------------------------ evaluation
  /**
   * Run in the main world. When the document is replaced while the call is in
   * flight (a navigation committed), it is retried on the new document, once
   * the frame has one: callers mean "the page", not one particular document.
   */
  private async inMainWorld<T>(run: (ctx: ExecutionContext) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const ctx = await this.context('main');
      const loader = this.loaderId;
      try {
        return await run(ctx);
      } catch (e) {
        const gone = (e as { contextGone?: boolean }).contextGone || isContextGoneError(e);
        if (!gone || attempt >= 2 || this.detached) throw e;
        // Wait until the replaced context is known to be gone (or the next document committed).
        const deadline = Date.now() + 5000;
        while (!ctx.disposed && this.loaderId === loader && Date.now() < deadline) await sleep(20);
      }
    }
  }

  async evaluate<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    try {
      return (await this.inMainWorld((ctx) => ctx.evaluate(fn as any, [arg], true))) as R;
    } catch (e) {
      throw rewriteError(e as Error, 'frame.evaluate');
    }
  }

  async evaluateHandle<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg): Promise<JSHandle<R>> {
    return (await this.inMainWorld((ctx) => ctx.evaluate(fn as any, [arg], false))) as JSHandle<R>;
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const all = await this.$$(selector);
    if (all.length > 1 && this._page.context().options.strictSelectors) {
      for (const h of all) await h.dispose();
      throw new Error(`$: ${tooManyMatchesMessage(`"${selector}"`, all.length)} (strictSelectors is on for this context)`);
    }
    for (const h of all.slice(1)) await h.dispose();
    return all[0] ?? null;
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    return this.locator(selector).elementHandles();
  }

  async $eval<R, Arg = unknown>(selector: string, fn: (el: Element, arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    const el = await this.$(selector);
    if (!el) throw new Error(`$eval: nothing on the page matches the selector "${selector}"`);
    try {
      return await el.evaluate(fn as any, arg);
    } finally {
      await el.dispose();
    }
  }

  async $$eval<R, Arg = unknown>(selector: string, fn: (els: Element[], arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    return this.locator(selector).evaluateAll(fn as any, arg) as Promise<R>;
  }

  async waitForSelector(selector: string, options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number; strict?: boolean } = {}): Promise<ElementHandle | null> {
    const loc = this.locator(selector);
    const state = options.state ?? 'visible';
    const strict = options.strict ?? !!this._page.context().options.strictSelectors;
    await (strict ? loc : loc.first()).waitFor({ state, timeout: options.timeout });
    if (state === 'detached' || state === 'hidden') return null;
    return loc.first().elementHandle({ timeout: options.timeout });
  }

  async waitForFunction<R, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg, options: { timeout?: number; polling?: number | 'raf' } = {}): Promise<JSHandle<R>> {
    const deadline = new Deadline(options.timeout ?? this._page.defaultTimeout());
    const interval = typeof options.polling === 'number' ? options.polling : 16;
    for (;;) {
      try {
        const ctx = await this.context('main', deadline.remaining() || 1);
        const h = (await ctx.evaluate(fn as any, [arg], false)) as JSHandle<R>;
        const truthy = h.objectId ? true : !!h.primitiveValue();
        if (truthy) return h;
        await h.dispose();
      } catch (e) {
        if (!isContextGoneError(e) && !(e as { contextGone?: boolean }).contextGone) throw rewriteError(e as Error, 'page.waitForFunction');
      }
      if (deadline.expired()) throw new TimeoutError(timeoutMessage('page.waitForFunction', deadline.timeout, ['waiting for the function to return a truthy value']));
      await sleep(interval);
    }
  }

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }

  // ------------------------------------------------------------------ locators
  locator(selectorOrLocator: string | Locator, options?: LocatorOptions): Locator {
    return Locator.fromScope(frameScope(this), selectorOrLocator, options);
  }

  getByRole(role: string, options: GetByRoleOptions = {}): Locator {
    return Locator.root(frameScope(this)).getByRole(role, options);
  }

  getByText(text: string | RegExp, options: TextOptions = {}): Locator {
    return Locator.root(frameScope(this)).getByText(text, options);
  }

  getByLabel(text: string | RegExp, options: TextOptions = {}): Locator {
    return Locator.root(frameScope(this)).getByLabel(text, options);
  }

  getByPlaceholder(text: string | RegExp, options: TextOptions = {}): Locator {
    return Locator.root(frameScope(this)).getByPlaceholder(text, options);
  }

  getByAltText(text: string | RegExp, options: TextOptions = {}): Locator {
    return Locator.root(frameScope(this)).getByAltText(text, options);
  }

  getByTitle(text: string | RegExp, options: TextOptions = {}): Locator {
    return Locator.root(frameScope(this)).getByTitle(text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return Locator.root(frameScope(this)).getByTestId(testId);
  }

  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(frameScope(this), selector);
  }

  // ------------------------------------------------------------------ selector-based actions (legacy API)
  click(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.locator(selector).first().click(options);
  }

  dblclick(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.locator(selector).first().dblclick(options);
  }

  hover(selector: string, options?: actions.PointerOptions): Promise<void> {
    return this.locator(selector).first().hover(options);
  }

  tap(selector: string, options?: actions.PointerOptions): Promise<void> {
    return this.locator(selector).first().tap(options);
  }

  fill(selector: string, value: string, options?: actions.ActionOptions): Promise<void> {
    return this.locator(selector).first().fill(value, options);
  }

  type(selector: string, text: string, options?: actions.TypeOptions): Promise<void> {
    return this.locator(selector).first().type(text, options);
  }

  press(selector: string, key: string, options?: actions.TypeOptions): Promise<void> {
    return this.locator(selector).first().press(key, options);
  }

  focus(selector: string, options?: actions.ActionOptions): Promise<void> {
    return this.locator(selector).first().focus(options);
  }

  check(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.locator(selector).first().check(options);
  }

  uncheck(selector: string, options?: actions.ClickOptions): Promise<void> {
    return this.locator(selector).first().uncheck(options);
  }

  setChecked(selector: string, checked: boolean, options?: actions.ClickOptions): Promise<void> {
    return this.locator(selector).first().setChecked(checked, options);
  }

  selectOption(selector: string, values: actions.SelectValues, options?: actions.ActionOptions): Promise<string[]> {
    return this.locator(selector).first().selectOption(values, options);
  }

  setInputFiles(selector: string, files: Parameters<Locator['setInputFiles']>[0], options?: actions.ActionOptions): Promise<void> {
    return this.locator(selector).first().setInputFiles(files, options);
  }

  dispatchEvent(selector: string, type: string, eventInit?: Record<string, unknown>, options?: actions.ActionOptions): Promise<void> {
    return this.locator(selector).first().dispatchEvent(type, eventInit, options);
  }

  textContent(selector: string, options?: actions.ActionOptions): Promise<string | null> {
    return this.locator(selector).first().textContent(options);
  }

  innerText(selector: string, options?: actions.ActionOptions): Promise<string> {
    return this.locator(selector).first().innerText(options);
  }

  innerHTML(selector: string, options?: actions.ActionOptions): Promise<string> {
    return this.locator(selector).first().innerHTML(options);
  }

  getAttribute(selector: string, name: string, options?: actions.ActionOptions): Promise<string | null> {
    return this.locator(selector).first().getAttribute(name, options);
  }

  inputValue(selector: string, options?: actions.ActionOptions): Promise<string> {
    return this.locator(selector).first().inputValue(options);
  }

  isVisible(selector: string): Promise<boolean> {
    return this.locator(selector).first().isVisible();
  }

  isHidden(selector: string): Promise<boolean> {
    return this.locator(selector).first().isHidden();
  }

  isEnabled(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.locator(selector).first().isEnabled(options);
  }

  isDisabled(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.locator(selector).first().isDisabled(options);
  }

  isEditable(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.locator(selector).first().isEditable(options);
  }

  isChecked(selector: string, options?: actions.ActionOptions): Promise<boolean> {
    return this.locator(selector).first().isChecked(options);
  }

  // ------------------------------------------------------------------ document
  async content(): Promise<string> {
    return this.inEngine((_e, h) => h.content());
  }

  /** Engine hook: Chromium cannot rewrite a document that hosted an <object>/<embed> frame (see setContent). */
  protected objectFramesBreakRewrite(): boolean {
    return true;
  }

  async setContent(html: string, options: { waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<void> {
    const deadline = new Deadline(options.timeout ?? this._page.defaultNavigationTimeout());
    // Chromium bug: after a document hosted a frame in an <object>/<embed>, rewriting it
    // (document.open/write, or CDP Page.setDocumentContent) and then loading an
    // <iframe srcdoc> makes the browser process exit. Rewriting a fresh document from a new
    // navigation is safe, so start from an empty data: document in that case.
    if (this.objectFramesBreakRewrite()) {
      const hasObject = await this.inEngine(() => document.querySelector('object, embed') !== null).catch(() => false);
      if (hasObject) await this.goto('data:text/html,', { timeout: deadline.remaining() });
    }
    await this.inEngine((_e, h, s) => h.setContent(s), [html]);
    const want = options.waitUntil ?? 'load';
    for (;;) {
      const state = await this.inEngine(() => document.readyState).catch(() => 'loading');
      if (want === 'commit' || (want === 'domcontentloaded' && state !== 'loading') || state === 'complete') {
        if (want !== 'networkidle' || this._page.network.isIdle(500)) return;
      }
      if (deadline.expired()) throw new TimeoutError(timeoutMessage('page.setContent', deadline.timeout, ['waiting for the new content to finish loading']));
      await sleep(20);
    }
  }

  async title(): Promise<string> {
    return this.inEngine(() => document.title);
  }

  async addScriptTag(options: { url?: string; path?: string; content?: string; type?: string }): Promise<ElementHandle> {
    let content = options.content;
    if (options.path) content = `${await readFile(options.path, 'utf8')}\n//# sourceURL=${options.path.replace(/\n/g, '')}`;
    const ctx = await this.context('main');
    const h = (await ctx.evaluate(
      async (o: { url?: string; content?: string; type?: string }) => {
        const s = document.createElement('script');
        s.type = o.type || 'text/javascript';
        if (o.url) {
          s.src = o.url;
          const loaded = new Promise((res, rej) => {
            s.onload = res;
            s.onerror = () => rej(new Error('Loading script from ' + o.url + ' failed'));
          });
          document.head.appendChild(s);
          await loaded;
        } else {
          s.text = o.content || '';
          let error: unknown;
          const onError = (e: ErrorEvent) => { error = e.error; };
          window.addEventListener('error', onError);
          document.head.appendChild(s);
          window.removeEventListener('error', onError);
          if (error) throw error;
        }
        return s;
      },
      [{ url: options.url, content, type: options.type }],
      false,
    )) as ElementHandle;
    return h;
  }

  async addStyleTag(options: { url?: string; path?: string; content?: string }): Promise<ElementHandle> {
    let content = options.content;
    if (options.path) content = await readFile(options.path, 'utf8');
    const ctx = await this.context('main');
    return (await ctx.evaluate(
      async (o: { url?: string; content?: string }) => {
        if (o.url) {
          const l = document.createElement('link');
          l.rel = 'stylesheet';
          l.href = o.url;
          const p = new Promise((res, rej) => { l.onload = res; l.onerror = rej; });
          document.head.appendChild(l);
          await p;
          return l;
        }
        const s = document.createElement('style');
        s.textContent = o.content || '';
        document.head.appendChild(s);
        return s;
      },
      [{ url: options.url, content }],
      false,
    )) as ElementHandle;
  }

  // ------------------------------------------------------------------ navigation
  async goto(url: string, options: GotoOptions = {}): Promise<Response | null> {
    const tracing = this._page.context().tracing;
    if (tracing.isRecording()) return tracing.action(this._page, 'Frame', 'goto', { url }, () => this.gotoImpl(url, options));
    return this.gotoImpl(url, options);
  }

  private async gotoImpl(url: string, options: GotoOptions): Promise<Response | null> {
    const timeout = options.timeout ?? this._page.defaultNavigationTimeout();
    const waitUntil = options.waitUntil ?? 'load';
    const deadline = new Deadline(timeout);
    const base = this._page.context().baseURL();
    let target = url;
    if (base) {
      try {
        target = new URL(url, base).href;
      } catch {
        /* keep */
      }
    }
    const loaderId = await this.startNavigation(target, options.referer, deadline);
    if (!loaderId) {
      // Same-document navigation (fragment / history API): nothing to load.
      return null;
    }
    await this.waitForDocument(loaderId, waitUntil, deadline, 'page.goto', target);
    return this._page.network.documentResponse(loaderId);
  }

  /**
   * Start a navigation of this frame. Resolves with the id of the new
   * document (loaderId), or undefined for a same-document navigation; throws
   * "page.goto: ..." errors for navigations that fail to start.
   */
  protected async startNavigation(target: string, referer: string | undefined, _deadline: Deadline): Promise<string | undefined> {
    let result;
    try {
      result = await this.session.cdp.send('Page.navigate', { url: target, frameId: this.id, ...(referer ? { referrer: referer } : {}) });
    } catch (e) {
      const m = (e as Error).message;
      if (/Cannot navigate to invalid URL/.test(m)) throw new Error(`page.goto: "${target}" is not a URL the browser can open (give a full URL, or set baseURL for relative ones)`);
      throw rewriteError(e as Error, 'page.goto');
    }
    if (result.errorText) {
      if (result.errorText === 'net::ERR_ABORTED' && this._page.recentDownloadFor(this.id)) throw new Error(`page.goto: ${target} started a download instead of opening a page (use page.waitForEvent('download') to catch it)`);
      throw new Error(`page.goto: could not load ${target} (${result.errorText})`);
    }
    return result.loaderId as string | undefined;
  }

  /** Wait until the document `loaderId` (or a later one) is committed and reached `waitUntil`. */
  async waitForDocument(loaderId: string, waitUntil: LifecycleEvent, deadline: Deadline, api: string, url?: string): Promise<void> {
    let seen = false;
    await this._page.waitForCondition(() => {
      if (this.detached) throw new Error(`${api}: the navigation never finished because the page was closed or the frame was removed`);
      const failed = this.navigationError(loaderId, api, url);
      if (failed) throw failed;
      if (this.loaderId === loaderId) seen = true;
      if (!seen && this.loaderId !== loaderId) return false;
      return this.hasLifecycle(waitUntil);
    }, deadline, () => timeoutMessage(api, deadline.timeout, [`navigating to "${url ?? this.url_}", waiting until "${waitUntil}"`]));
  }

  /** Engine hook: an error for a navigation that failed after it started (BiDi reports these as events). */
  protected navigationError(_loaderId: string, _api: string, _url: string | undefined): Error | undefined {
    return undefined;
  }

  async waitForLoadState(state: LifecycleEvent = 'load', options: { timeout?: number } = {}): Promise<void> {
    const deadline = new Deadline(options.timeout ?? this._page.defaultNavigationTimeout());
    await this._page.waitForCondition(() => this.hasLifecycle(state), deadline, () => timeoutMessage('page.waitForLoadState', deadline.timeout, [`waiting for "${state}"`]));
  }

  async waitForURL(url: URLMatch, options: { timeout?: number; waitUntil?: LifecycleEvent } = {}): Promise<void> {
    const deadline = new Deadline(options.timeout ?? this._page.defaultNavigationTimeout());
    const base = this._page.context().baseURL();
    await this._page.waitForCondition(() => urlMatches(base, this.url_, url), deadline, () => timeoutMessage('page.waitForURL', deadline.timeout, [`waiting for the URL to match ${String(url)} (then "${options.waitUntil ?? 'load'}")`, `the page is at "${this.url_}"`]));
    const waitUntil = options.waitUntil ?? 'load';
    await this._page.waitForCondition(() => this.hasLifecycle(waitUntil), deadline, () => timeoutMessage('page.waitForURL', deadline.timeout, [`the URL matched; waiting for "${waitUntil}"`]));
  }

  /** Wait for the next navigation of this frame (new document or same-document). */
  async waitForNavigation(options: { url?: URLMatch; waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<Response | null> {
    const deadline = new Deadline(options.timeout ?? this._page.defaultNavigationTimeout());
    const nav = await this._page.nextNavigation(this, deadline, options.url);
    if (nav.loaderId) {
      await this.waitForDocument(nav.loaderId, options.waitUntil ?? 'load', deadline, 'page.waitForNavigation');
      return this._page.network.documentResponse(nav.loaderId);
    }
    return null;
  }
}
