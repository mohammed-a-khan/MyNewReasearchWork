/**
 * A Firefox page: one top-level WebDriver BiDi browsing context and its
 * descendants (frames). The page API (locators, delegation to the main
 * frame, waiting, events, routes and bindings bookkeeping) comes from ChromiumPage,
 * which holds the engine-independent page code; this class implements the
 * protocol halves with BiDi:
 *
 * - frame tree and document lifecycle from browsingContext.* events
 *   (contextCreated / navigationStarted / navigationCommitted /
 *   domContentLoaded / load / fragmentNavigated / historyUpdated / ...);
 * - worlds from script.realmCreated (main world, and our sandbox
 *   `__eztest_engine_world__` as the engine world);
 * - input through input.performActions, screenshots through
 *   browsingContext.captureScreenshot, PDF through browsingContext.print;
 * - dialogs (userPromptOpened / handleUserPrompt), console messages and page
 *   errors (log.entryAdded), file choosers (input.fileDialogOpened),
 *   bindings (script.addPreloadScript with a channel + script.message).
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ENGINE_WORLD_NAME } from '../injected/contract.js';
import { TargetClosedError, isClosedError } from '../errors.js';
import { dialogHandledMessage } from '../messages.js';
import { KEEP_NAMES_SHIM, deserializeValue, pageCodec, serializeArgument } from '../serializer.js';
import type { LifecycleEvent, ViewportSize } from '../types.js';
import { Deadline, sleep } from '../util.js';
import { ChromiumPage, ConsoleMessage, Dialog, FileChooser, Worker, remoteToText, type BindingEntry, type MediaOptions, type ScreenshotOptions, type TargetSession } from '../chromium/page.js';
import type { ChromiumFrame } from '../chromium/frame.js';
import type { ElementHandle, JSHandle } from '../chromium/handles.js';
import { WebSocket, type Response } from '../chromium/network.js';
import { debugLog } from '../debug.js';
import type { BidiConnection } from './connection.js';
import { isGoneBidiError } from './connection.js';
import { FirefoxFrame, PAGE_WORLD_NAME } from './frame.js';
import { FirefoxKeyboard, FirefoxMouse, FirefoxTouchscreen, type InputTarget } from './input.js';
import { FirefoxNetwork } from './network.js';
import { FirefoxRealm, exceptionToError, fromRemoteValue, remoteObjectOf, toLocalValue, type BidiValue } from './realm.js';
import { targetSessionUnavailable } from './stubs.js';
import type { FirefoxContext } from './browser.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CODEC = `(${pageCodec.toString()})()`;

/** Page-side source of a binding: window[name](...args) sends {name, seq, args} on the channel and awaits the answer. */
export function bindingPreload(name: string): string {
  return `function (send) { ${KEEP_NAMES_SHIM}
    const codec = ${CODEC};
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
      send({ name, seq, args: codec.ser(args) });
    });
  }`;
}

/**
 * Page-side WebSocket observer (BiDi has no WebSocket events): wraps the
 * page's WebSocket class so creation, frames sent / received, errors and
 * close are reported on a channel. The wrapper is a subclass of the original
 * (instanceof, prototype and behaviour unchanged).
 */
export function webSocketObserverPreload(): string {
  return `function (send) {
    const Orig = globalThis.WebSocket;
    if (typeof Orig !== 'function' || Orig.__ezObserved) return;
    let seq = 0;
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000))); return btoa(s); };
    const enc = (d) => {
      if (typeof d === 'string') return { t: 's', d };
      if (d instanceof ArrayBuffer) return { t: 'b', d: b64(new Uint8Array(d)) };
      if (ArrayBuffer.isView(d)) return { t: 'b', d: b64(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) };
      return { t: 's', d: String(d) };
    };
    class WebSocket extends Orig {
      constructor(url, protocols) {
        super(url, protocols);
        const id = ++seq;
        Object.defineProperty(this, '__ezId', { value: id });
        send({ e: 'open', id, url: this.url });
        this.addEventListener('message', (ev) => {
          if (typeof Blob !== 'undefined' && ev.data instanceof Blob) ev.data.arrayBuffer().then((buf) => send({ e: 'recv', id, p: enc(buf) }));
          else send({ e: 'recv', id, p: enc(ev.data) });
        });
        this.addEventListener('error', () => send({ e: 'error', id }));
        this.addEventListener('close', () => send({ e: 'close', id }));
      }
      send(data) {
        if (typeof Blob !== 'undefined' && data instanceof Blob) data.arrayBuffer().then((buf) => send({ e: 'sent', id: this.__ezId, p: enc(buf) }));
        else send({ e: 'sent', id: this.__ezId, p: enc(data) });
        return super.send(data);
      }
    }
    Object.defineProperty(WebSocket, '__ezObserved', { value: true });
    globalThis.WebSocket = WebSocket;
  }`;
}

/** Preload-script declaration for an init script source (statements). */
export function initScriptPreload(source: string): string {
  return `function () {\n${source}\n}`;
}

class FirefoxDialog extends Dialog {
  constructor(page: ChromiumPage, private readonly bidi: BidiConnection, private readonly contextId: string, type: string, message: string, defaultValue: string) {
    super(page, null, type, message, defaultValue);
  }
  override async accept(promptText?: string): Promise<void> {
    if (this.handled) throw new Error(dialogHandledMessage('accept'));
    this.handled = true;
    await this.bidi.send('browsingContext.handleUserPrompt', { context: this.contextId, accept: true, ...(promptText !== undefined ? { userText: promptText } : {}) }).catch(() => undefined);
  }
  override async dismiss(): Promise<void> {
    if (this.handled) throw new Error(dialogHandledMessage('dismiss'));
    this.handled = true;
    await this.bidi.send('browsingContext.handleUserPrompt', { context: this.contextId, accept: false }).catch(() => undefined);
  }
}

/** The input devices need the page before ChromiumPage's constructor returns: they go through this holder. */
interface Holder {
  page?: FirefoxPage;
}


/** An HTML5 drag the page is doing (FirefoxPage.watchDrag). */
type DragState = { active: boolean; source: Element | null; data: [string, string][]; effect: string; over: Element | null; accepted: boolean; dropped: boolean };
export class FirefoxPage extends ChromiumPage {
  readonly ffNetwork: FirefoxNetwork;
  /** Realms by id (all frames of this page, and workers). */
  readonly realms = new Map<string, FirefoxRealm>();
  private readonly pendingRealms = new Map<string, any[]>();
  private readonly bindingChannels = new Map<string, string>();
  private readonly preloadScripts: string[] = [];
  private readonly realmWorkers = new Map<string, Worker>();
  /** Internal: privileged overrides were set on this page (they must be reset when cleared). */
  hadOverrides = false;

  constructor(
    readonly ffCtx: FirefoxContext,
    readonly bidi: BidiConnection,
    contextId: string,
    opener: ChromiumPage | undefined,
    initialUrl: string,
  ) {
    const holder: Holder = {};
    const target: InputTarget = {
      performActions: (a) => holder.page!.performActions(a),
      syntheticKey: (t, i) => holder.page!.syntheticKey(t, i),
      insertText: (t) => holder.page!.insertTextAtCaret(t),
      viewport: () => holder.page!.viewportSize(),
      pointerLeft: (x, y, edge) => holder.page!.pointerLeft(x, y, edge),
      watchDrag: () => holder.page!.watchDrag(),
      dropIfDragging: (x, y) => holder.page!.dropIfDragging(x, y),
      endDrag: (x, y) => holder.page!.endDrag(x, y),
    };
    const slowMo = () => ffCtx.browser().slowMo;
    const keyboard = new FirefoxKeyboard(target, slowMo);
    const network = new FirefoxNetwork(holder as unknown as FirefoxPage, bidi);
    super(ffCtx, null, contextId, opener, {
      network,
      keyboard,
      mouse: new FirefoxMouse(target, keyboard, slowMo),
      touchscreen: new FirefoxTouchscreen(target, keyboard, () => !!ffCtx.options.hasTouch),
      mainSession: targetSessionUnavailable() as TargetSession,
    });
    holder.page = this;
    this.ffNetwork = network;
    (network as unknown as { page: FirefoxPage }).page = this;
    const main = new FirefoxFrame(this, contextId, bidi);
    this.frames_.set(contextId, main);
    this.mainFrame_ = main;
    main.onCommitted(initialUrl || 'about:blank', '', 'initial');
    main.onStoppedLoading(true);
  }

  ffContext(): FirefoxContext {
    return this.ffCtx;
  }

  /** Top-level browsing context id. */
  get contextId(): string {
    return this.targetId;
  }

  // ------------------------------------------------------------------ setup
  override async initialize(): Promise<void> {
    const sends: Array<Promise<unknown>> = [];
    if (this.viewport_) sends.push(this.applyFfViewport());
    sends.push(this.ffCtx.applyPageOverrides(this));
    sends.push(this.bidi.send('script.getRealms', { context: this.contextId }).then((r) => {
      for (const realm of r.realms ?? []) this.onRealmCreated(realm);
    }));
    sends.push(this.bidi.send('browsingContext.getTree', { root: this.contextId }).then((r) => {
      const visit = (node: any, parent: FirefoxFrame | undefined) => {
        const f = parent ? this.ensureFfFrame(node.context, parent.id, node.url) : (this.mainFrame() as FirefoxFrame);
        if (!parent && node.url && node.url !== f.url()) f.onCommitted(node.url, f.name(), f.loaderId || 'initial');
        for (const c of node.children ?? []) visit(c, f);
      };
      for (const c of r.contexts ?? []) visit(c, undefined);
    }));
    const results = await Promise.allSettled(sends);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed && (isClosedError(failed.reason) || isGoneBidiError(failed.reason))) throw new TargetClosedError();
    if (failed) debugLog('browser', `page setup: ${(failed.reason as Error).message}`);
    this.initialized = true;
    if (this.video_) await this.video_.start().catch(() => undefined);
  }

  private applyFfViewport(): Promise<unknown> {
    const o = this.context_.options;
    return this.bidi.send('browsingContext.setViewport', {
      context: this.contextId,
      viewport: this.viewport_ ? { width: this.viewport_.width, height: this.viewport_.height } : null,
      devicePixelRatio: o.deviceScaleFactor ?? null,
    });
  }

  // ------------------------------------------------------------------ frames and lifecycle (BiDi events, routed by the browser)
  private ensureFfFrame(id: string, parentId: string | undefined, url: string | undefined): FirefoxFrame {
    let f = this.frames_.get(id) as FirefoxFrame | undefined;
    if (f) return f;
    f = new FirefoxFrame(this, id, this.bidi);
    this.frames_.set(id, f);
    const parent = parentId ? this.frames_.get(parentId) : undefined;
    if (parent) {
      f.parent = parent;
      parent.children.add(f);
    }
    f.onCommitted(url || 'about:blank', '', 'initial');
    if (!url || url === 'about:blank' || url === 'about:srcdoc') f.onStoppedLoading(true);
    if (parent) this.emitEvent('frameattached', f);
    for (const r of this.pendingRealms.get(id) ?? []) this.onRealmCreated(r);
    this.pendingRealms.delete(id);
    this.notifyChange();
    return f;
  }

  /** Is this browsing context one of this page's frames? */
  ownsContext(id: string): boolean {
    return this.frames_.has(id);
  }

  onContextCreated(e: any): void {
    if (e.parent && this.frames_.has(e.parent)) this.ensureFfFrame(e.context, e.parent, e.url);
  }

  onContextDestroyed(e: any): void {
    if (e.context === this.contextId) {
      this.didClose();
      return;
    }
    const f = this.frames_.get(e.context);
    if (f) {
      this.detachFrame(f);
      this.notifyChange();
    }
  }

  private frameFor(e: any): FirefoxFrame | undefined {
    return this.frames_.get(e.context) as FirefoxFrame | undefined;
  }

  onNavigationStarted(e: any): void {
    if (!this.frameFor(e)) return;
    this.onStartedLoading();
  }

  onNavigationCommitted(e: any): void {
    const f = this.frameFor(e);
    if (!f) return;
    for (const c of [...f.children]) this.detachFrame(c);
    this.navEnds++;
    f.onCommitted(String(e.url), f.name(), e.navigation ?? `nav-${randomUUID()}`);
    this.emitEvent('framenavigated', f);
    for (const l of [...this.navListeners]) l(f, e.navigation ?? undefined);
    this.context_.onFrameNavigated(this, f);
    this.notifyChange();
  }

  onSameDocument(e: any): void {
    const f = this.frameFor(e);
    if (!f) return;
    this.navEnds++;
    f.onSameDocument(String(e.url));
    this.emitEvent('framenavigated', f);
    for (const l of [...this.navListeners]) l(f, undefined);
    this.notifyChange();
  }

  onLifecycleEvent(e: any, name: 'DOMContentLoaded' | 'load'): void {
    const f = this.frameFor(e);
    if (!f) return;
    const nav = e.navigation ?? f.loaderId;
    f.onLifecycle(nav, name);
    if (f === this.mainFrame_ && nav === f.loaderId) {
      if (name === 'load') this.emitEvent('load', this);
      else this.emitEvent('domcontentloaded', this);
    }
    if (name === 'load') this.updateFrameName(f);
    this.notifyChange();
  }

  onNavigationEnded(e: any, kind: 'failed' | 'aborted'): void {
    const f = this.frameFor(e);
    if (!f) return;
    this.navEnds++;
    const nav = e.navigation as string | undefined;
    if (nav && kind === 'failed' && !f.failedNavigations.has(nav)) {
      // The precise error text comes with network.fetchError; give it a moment.
      setTimeout(() => {
        if (!f.failedNavigations.has(nav)) f.failedNavigations.set(nav, 'net::ERR_FAILED');
        this.notifyChange();
      }, 50);
    }
    if (nav && kind === 'aborted' && !f.failedNavigations.has(nav) && !f.downloadNavigations.has(nav)) {
      setTimeout(() => {
        if (!f.failedNavigations.has(nav) && f.loaderId !== nav) f.failedNavigations.set(nav, 'net::ERR_ABORTED');
        this.notifyChange();
      }, 50);
    }
    this.notifyChange();
  }

  onDownloadWillBegin(e: any): void {
    const f = this.frameFor(e);
    if (f && e.navigation) f.downloadNavigations.add(e.navigation);
    if (f) this.downloadsByFrame.set(f.id, Date.now());
    this.navEnds++;
    this.notifyChange();
  }

  private updateFrameName(f: FirefoxFrame): void {
    const r = f.realm('engine') ?? f.realm('main');
    if (!r) return;
    void r.evaluate(() => window.name, [], true).then((n) => {
      if (typeof n === 'string') f.name_ = n;
    }, () => undefined);
  }

  // ------------------------------------------------------------------ realms
  onRealmCreated(e: any): void {
    if (this.realms.has(e.realm)) return;
    if (e.type === 'window') {
      const f = this.frames_.get(e.context) as FirefoxFrame | undefined;
      if (!f) {
        this.pendingRealms.set(e.context, [...(this.pendingRealms.get(e.context) ?? []), e]);
        return;
      }
      let world: 'main' | 'engine' | undefined;
      const noScript = this.context_.options.javaScriptEnabled === false;
      if (!e.sandbox) world = noScript ? undefined : 'main';
      else if (e.sandbox === ENGINE_WORLD_NAME) world = 'engine';
      else if (e.sandbox === PAGE_WORLD_NAME && noScript) world = 'main';
      if (!world) return;
      const realm = new FirefoxRealm(this.bidi, e.realm, e.context, f, world);
      this.realms.set(e.realm, realm);
      f.contextCreated(world, realm);
      if (world === 'main') this.updateFrameName(f);
      return;
    }
    if (e.type === 'dedicated-worker') this.onWorkerRealm(e);
  }

  /** A realm of this page's documents (used to route worker realms). */
  hasRealm(id: string): boolean {
    return this.realms.has(id);
  }

  private onWorkerRealm(e: any): void {
    const realm = new FirefoxRealm(this.bidi, e.realm, undefined, undefined, 'worker');
    this.realms.set(e.realm, realm);
    // A worker realm's origin is its script URL.
    const w = new Worker(null, String(e.origin ?? ''));
    w.attachContext(realm);
    (realm as unknown as { worker: unknown }).worker = w;
    this.realmWorkers.set(e.realm, w);
    this.workers_.set(e.realm, w);
    this.emitEvent('worker', w);
  }

  onRealmDestroyed(e: any): void {
    const realm = this.realms.get(e.realm);
    if (!realm) {
      for (const [k, list] of this.pendingRealms) this.pendingRealms.set(k, list.filter((x) => x.realm !== e.realm));
      return;
    }
    this.realms.delete(e.realm);
    realm.frame?.contextDestroyed(realm);
    realm.disposed = true;
    const w = this.realmWorkers.get(e.realm);
    if (w) {
      this.realmWorkers.delete(e.realm);
      this.workers_.delete(e.realm);
      w.emitEvent('close', w);
    }
  }

  // ------------------------------------------------------------------ page events
  onUserPrompt(e: any): void {
    const type = String(e.type ?? 'alert');
    this.openDialogs.set(this, { type, message: String(e.message ?? '') });
    const d = new FirefoxDialog(this, this.bidi, e.context, type, String(e.message ?? ''), String(e.defaultValue ?? ''));
    const listeners = this.listenerCount('dialog') + this.context_.listenerCount('dialog');
    if (!listeners) {
      void (type === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => undefined);
      return;
    }
    this.emitEvent('dialog', d);
    this.context_.emitEvent('dialog', d);
  }

  onUserPromptClosed(e: any): void {
    this.onDialogClosed(this, { result: e.accepted === true, ...(e.userText !== undefined ? { userInput: String(e.userText) } : {}) });
  }

  async onFileDialog(e: any): Promise<void> {
    const f = this.frameFor(e) ?? (this.mainFrame() as FirefoxFrame);
    if (!e.element?.sharedId) return;
    const ctx = (await f.context('main')) as FirefoxRealm;
    const el = ctx.handleFor({ type: 'node', sharedId: e.element.sharedId, value: { localName: 'input' } }) as ElementHandle;
    this.emitEvent('filechooser', new FileChooser(this, el, !!e.multiple));
  }

  onLogEntry(e: any): void {
    const realm = e.source?.realm ? this.realms.get(e.source.realm) : undefined;
    if (realm && realm.world === 'engine') return; // our own sandbox
    if (e.type === 'javascript') {
      if (e.level !== 'error') return;
      // Uncaught exceptions ("TypeError: ...", "uncaught exception: ...") are page errors; other script
      // errors the browser reports (a postMessage to the wrong origin ...) are console errors, as in Chromium.
      if (!/^(uncaught exception: |[\w$]+: |[\w$]+(Error|Exception)$)/.test(String(e.text ?? ''))) {
        const top = e.stackTrace?.callFrames?.[0];
        const msg = new ConsoleMessage('error', String(e.text ?? ''), [], { url: top?.url ?? '', lineNumber: top?.lineNumber ?? 0, columnNumber: top?.columnNumber ?? 0 }, this);
        this.emitEvent('console', msg);
        this.context_.emitEvent('console', msg);
        return;
      }
      const err = exceptionToError({ text: e.text, stackTrace: e.stackTrace });
      this.emitEvent('pageerror', err);
      this.context_.emitEvent('weberror', { page: () => this, error: () => err });
      return;
    }
    if (e.type !== 'console') return;
    const methods: Record<string, string> = { warn: 'warning', group: 'startGroup', groupCollapsed: 'startGroupCollapsed', groupEnd: 'endGroup' };
    const type = methods[e.method] ?? e.method ?? (e.level === 'warn' ? 'warning' : e.level ?? 'log');
    const args: BidiValue[] = e.args ?? [];
    const ctx = realm ?? (this.frameFor(e.source ?? {}) as FirefoxFrame | undefined)?.realm('main');
    const handles: JSHandle[] = ctx ? args.map((a) => ctx.handleFor(a)) : [];
    const text = args.length ? args.map((a) => remoteToText(remoteObjectOf(a))).join(' ') : String(e.text ?? '');
    const top = e.stackTrace?.callFrames?.[0];
    const msg = new ConsoleMessage(type, text, handles, { url: top?.url ?? '', lineNumber: top?.lineNumber ?? 0, columnNumber: top?.columnNumber ?? 0 }, this);
    if (realm?.world === 'worker') {
      const w = this.realmWorkers.get(realm.realmId);
      if (w) w.emitEvent('console', msg);
      return;
    }
    this.context_.tracing.onConsole(msg.type(), msg.text());
    this.emitEvent('console', msg);
    this.context_.emitEvent('console', msg);
  }

  private readonly sockets = new Map<string, WebSocket>();

  /** A message of the page-side WebSocket observer. */
  onWebSocketMessage(e: any): void {
    const m = fromRemoteValue(e.data) as { e: string; id: number; url?: string; p?: { t: string; d: string } } | undefined;
    if (!m) return;
    const key = `${e.source?.realm}:${m.id}`;
    if (m.e === 'open') {
      const ws = new WebSocket(String(m.url ?? ''));
      this.sockets.set(key, ws);
      this.emitWebSocket(ws);
      return;
    }
    const ws = this.sockets.get(key);
    if (!ws) return;
    if (m.e === 'sent' || m.e === 'recv') {
      const payload = m.p?.t === 'b' ? Buffer.from(m.p.d, 'base64') : String(m.p?.d ?? '');
      ws.emitEvent(m.e === 'sent' ? 'framesent' : 'framereceived', { payload });
    } else if (m.e === 'error') {
      ws.emitEvent('socketerror', 'WebSocket error');
    } else if (m.e === 'close') {
      ws.closed = true;
      this.sockets.delete(key);
      ws.emitEvent('close', ws);
    }
  }

  /** A message on one of the binding channels. */
  async onBindingMessage(channel: string, e: any): Promise<boolean> {
    const name = this.bindingChannels.get(channel) ?? this.ffCtx.bindingForChannel(channel);
    if (!name) return false;
    const payload = fromRemoteValue(e.data) as { name: string; seq: number; args: unknown } | undefined;
    if (!payload || payload.name !== name) return true;
    const entry = this.bindings.get(name) ?? this.context_.binding(name);
    const realm = this.realms.get(e.source?.realm) ?? (e.source?.context ? (this.frames_.get(e.source.context) as FirefoxFrame | undefined)?.realm('main') : undefined);
    if (!entry || !realm) return true;
    const args = deserializeValue(payload.args) as unknown[];
    let ok = true;
    let value: unknown;
    try {
      value = await entry.callback({ page: this, frame: realm.frame ?? this.mainFrame(), context: this.context_ }, ...args);
    } catch (err) {
      ok = false;
      value = { message: (err as Error).message, stack: (err as Error).stack };
    }
    const encoded = ok ? serializeArgument(value, () => false, []) : value;
    await this.bidi.send('script.callFunction', {
      functionDeclaration: 'function (seq, ok, v) { if (globalThis.__ezDeliver) globalThis.__ezDeliver(seq, ok, v); }',
      awaitPromise: false,
      target: { realm: realm.realmId },
      arguments: [toLocalValue(payload.seq), toLocalValue(ok), toLocalValue(encoded)],
    }).catch(() => undefined);
    return true;
  }

  // ------------------------------------------------------------------ input
  async performActions(actions: unknown[]): Promise<void> {
    if (this.closed) throw new TargetClosedError();
    try {
      await this.bidi.send('input.performActions', { context: this.contextId, actions });
    } catch (e) {
      if (/move target out of bounds/i.test((e as Error).message)) return;
      throw e;
    }
  }

  /** Frame whose document has the focus (following focused iframes down from the main frame). */
  private async focusedFrame(): Promise<ChromiumFrame> {
    let frame: ChromiumFrame = this.mainFrame();
    for (let depth = 0; depth < 10; depth++) {
      const h = await frame.inEngine((_e, _h) => {
        const a = document.activeElement;
        return a && (a.localName === 'iframe' || a.localName === 'frame') ? a : null;
      }, [], false).catch(() => null) as unknown as JSHandle | null;
      const el = h?.asElement();
      if (!el) {
        void h?.dispose();
        return frame;
      }
      const child = await el.contentFrame().catch(() => null);
      void el.dispose();
      if (!child) return frame;
      frame = child;
    }
    return frame;
  }

  async syntheticKey(type: 'keydown' | 'keyup', init: Record<string, unknown>): Promise<void> {
    const frame = await this.focusedFrame();
    await frame.inEngine((_e, h, t, i) => {
      const target = document.activeElement || document.body;
      if (target) h.dispatch(target, t, { bubbles: true, cancelable: true, composed: true, ...i });
    }, [type, init]);
  }

  async pointerLeft(x: number, y: number, edge: { x: number; y: number }): Promise<void> {
    await (this.mainFrame() as FirefoxFrame).inEngine((_e, _h, px, py, ex, ey) => {
      const under = document.elementFromPoint(ex as number, ey as number) || document.documentElement;
      const init = { clientX: px as number, clientY: py as number, screenX: px as number, screenY: py as number, relatedTarget: null, view: window };
      under.dispatchEvent(new MouseEvent('mouseout', { ...init, bubbles: true, cancelable: true, composed: true }));
      for (let el: Element | null = under; el; el = el.parentElement) el.dispatchEvent(new MouseEvent('mouseleave', { ...init, bubbles: false, cancelable: false }));
    }, [x, y, edge.x, edge.y]);
  }

  /** See InputTarget.watchDrag: records the dragged data and whether the element under the pointer accepts a drop. */
  async watchDrag(): Promise<void> {
    await (this.mainFrame() as FirefoxFrame).inEngine(() => {
      const w = window as unknown as { __ezDrag?: DragState };
      if (w.__ezDrag) return;
      const st: DragState = { active: false, source: null, data: [], effect: 'all', over: null, accepted: false, dropped: false };
      w.__ezDrag = st;
      // Bubble listeners on the window: they run after the page's own handlers (data set, dragover cancelled).
      window.addEventListener('dragstart', (e) => {
        const dt = e.dataTransfer;
        st.active = !e.defaultPrevented;
        st.source = e.target as Element;
        st.data = dt ? [...dt.types].filter((t) => t !== 'Files').map((t) => [t, dt.getData(t)] as [string, string]) : [];
        st.effect = dt?.effectAllowed ?? 'all';
        st.over = null;
        st.accepted = false;
        st.dropped = false;
      });
      window.addEventListener('dragover', (e) => {
        st.over = e.target as Element;
        st.accepted = e.defaultPrevented;
      });
      window.addEventListener('drop', () => { st.dropped = true; }, true);
      window.addEventListener('dragend', () => { st.active = false; }, true);
    }, []);
  }

  /** See InputTarget.dropIfDragging. */
  async dropIfDragging(x: number, y: number): Promise<void> {
    await (this.mainFrame() as FirefoxFrame).inEngine((_e, _h, px, py) => {
      const st = (window as unknown as { __ezDrag?: DragState }).__ezDrag;
      if (!st || !st.active || st.dropped || !st.accepted || !st.over) return;
      const under = document.elementFromPoint(px as number, py as number);
      if (!under || !(st.over === under || st.over.contains(under) || under.contains(st.over))) return;
      const dt = new DataTransfer();
      for (const [t, v] of st.data) dt.setData(t, v);
      try {
        dt.effectAllowed = st.effect as DataTransfer['effectAllowed'];
        dt.dropEffect = st.effect === 'copy' || st.effect === 'link' ? st.effect : 'move';
      } catch { /* read-only in some states */ }
      st.dropped = true;
      st.over.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, clientX: px as number, clientY: py as number, dataTransfer: dt }));
    }, [x, y]);
  }

  /** After the release: the "dragend" of a drag that Firefox ended without one. */
  async endDrag(x: number, y: number): Promise<void> {
    await (this.mainFrame() as FirefoxFrame).inEngine((_e, _h, px, py) => {
      const st = (window as unknown as { __ezDrag?: DragState }).__ezDrag;
      if (!st || !st.active) return;
      st.active = false;
      st.source?.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: false, composed: true, clientX: px as number, clientY: py as number }));
    }, [x, y]);
  }

  async insertTextAtCaret(text: string): Promise<boolean> {
    const frame = await this.focusedFrame();
    return frame.inEngine((_e, _h, t) => {
      const a = document.activeElement as HTMLElement | null;
      if (!a) return false;
      const editable = a.isContentEditable || a.localName === 'textarea' || (a.localName === 'input' && !/^(checkbox|radio|button|submit|reset|file|image|color|range|hidden)$/i.test((a as HTMLInputElement).type));
      if (!editable) return false;
      return document.execCommand('insertText', false, t);
    }, [text]).catch(() => false);
  }

  // ------------------------------------------------------------------ emulation
  override async setViewportSize(size: ViewportSize): Promise<void> {
    this.viewport_ = { width: size.width, height: size.height };
    await this.applyFfViewport();
  }

  override async emulateMedia(options: MediaOptions = {}): Promise<void> {
    for (const k of ['media', 'colorScheme', 'reducedMotion', 'forcedColors', 'contrast'] as const) {
      if (k in options) (this.media as Record<string, unknown>)[k] = options[k] ?? undefined;
    }
    await this.ffCtx.applyPageOverrides(this);
  }

  /** Media overrides of this page (emulateMedia), over the context options. */
  mediaOverrides(): MediaOptions {
    return this.media;
  }

  override async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    await this.applyExtraHeaders();
  }

  override async applyExtraHeaders(): Promise<void> {
    // The context's headers are set on the user context; the page's own on its browsing context (they merge in the browser).
    const list = Object.entries(this.extraHeaders).map(([name, value]) => ({ name, value: { type: 'string', value } }));
    await this.bidi.send('network.setExtraHeaders', { headers: list, contexts: [this.contextId] }).catch((e) => debugLog('browser', `setExtraHeaders: ${(e as Error).message}`));
  }

  override async broadcast(method: string): Promise<void> {
    throw new Error(`${method} is a Chrome DevTools Protocol command; it is not available in Firefox`);
  }

  // ------------------------------------------------------------------ scripts, bindings, routes
  override async addScriptToSessions(source: string): Promise<void> {
    const { script } = await this.bidi.send('script.addPreloadScript', { functionDeclaration: initScriptPreload(source), contexts: [this.contextId] });
    this.preloadScripts.push(script);
  }

  override async installBinding(entry: BindingEntry): Promise<void> {
    const channel = `ez-binding-${randomUUID()}`;
    this.bindingChannels.set(channel, entry.name);
    const fn = bindingPreload(entry.name);
    const arg = { type: 'channel', value: { channel, ownership: 'none' } };
    const { script } = await this.bidi.send('script.addPreloadScript', { functionDeclaration: fn, arguments: [arg], contexts: [this.contextId] });
    this.preloadScripts.push(script);
    await this.runInAllFrames(fn, [arg]);
  }

  /** Run a function (with channel arguments) in the main world of every current frame. */
  async runInAllFrames(fn: string, args: unknown[]): Promise<void> {
    await Promise.all(this.frames().map(async (f) => {
      try {
        const realm = (await f.context('main', 5000)) as FirefoxRealm;
        await this.bidi.send('script.callFunction', { functionDeclaration: fn, awaitPromise: false, target: { realm: realm.realmId }, arguments: args });
      } catch {
        /* frame went away */
      }
    }));
  }

  override async updateInterception(): Promise<void> {
    await this.ffCtx.ffBrowser().updateIntercepts();
  }

  // ------------------------------------------------------------------ navigation
  override async reload(options: { waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<Response | null> {
    const deadline = new Deadline(options.timeout ?? this.defaultNavigationTimeout());
    const frame = this.mainFrame();
    const nav = this.nextNavigation(frame, deadline);
    const res = await this.bidi.send('browsingContext.reload', { context: this.contextId, wait: 'none' });
    const loaderId = (await nav).loaderId ?? res.navigation;
    if (!loaderId) return null;
    await frame.waitForDocument(loaderId, options.waitUntil ?? 'load', deadline, 'page.reload');
    return this.network.documentResponse(loaderId);
  }

  private async traverse(delta: number, options: { waitUntil?: LifecycleEvent; timeout?: number }, api: string): Promise<Response | null> {
    const deadline = new Deadline(options.timeout ?? this.defaultNavigationTimeout());
    const frame = this.mainFrame();
    const nav = this.nextNavigation(frame, deadline);
    nav.catch(() => undefined);
    try {
      await this.bidi.send('browsingContext.traverseHistory', { context: this.contextId, delta });
    } catch (e) {
      if (/no such history entry/i.test((e as Error).message)) return null;
      throw e;
    }
    const { loaderId } = await nav;
    if (!loaderId) return null;
    await frame.waitForDocument(loaderId, options.waitUntil ?? 'load', deadline, api);
    return this.network.documentResponse(loaderId);
  }

  override goBack(options: { waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<Response | null> {
    return this.traverse(-1, options, 'page.goBack');
  }

  override goForward(options: { waitUntil?: LifecycleEvent; timeout?: number } = {}): Promise<Response | null> {
    return this.traverse(1, options, 'page.goForward');
  }

  // ------------------------------------------------------------------ page operations
  override async bringToFront(): Promise<void> {
    await this.bidi.send('browsingContext.activate', { context: this.contextId });
  }

  override async close(options: { runBeforeUnload?: boolean; reason?: string } = {}): Promise<void> {
    if (this.closed) return;
    const closed = new Promise<void>((r) => this.once('close', () => r()));
    await this.bidi.send('browsingContext.close', { context: this.contextId, promptUnload: !!options.runBeforeUnload }).catch(() => undefined);
    if (options.runBeforeUnload) return;
    await Promise.race([closed, sleep(5000)]);
    this.didClose();
  }

  /** Internal: the browsing context is gone. */
  markClosed(): void {
    this.didClose();
  }

  override async pdf(options: { path?: string; scale?: number; displayHeaderFooter?: boolean; headerTemplate?: string; footerTemplate?: string; printBackground?: boolean; landscape?: boolean; pageRanges?: string; format?: string; width?: string | number; height?: string | number; margin?: { top?: string | number; right?: string | number; bottom?: string | number; left?: string | number }; preferCSSPageSize?: boolean } = {}): Promise<Buffer> {
    const cm = (v: string | number | undefined, d: number): number => {
      if (v === undefined) return d;
      if (typeof v === 'number') return (v / 96) * 2.54;
      const m = /^([\d.]+)\s*(px|in|cm|mm)?$/.exec(v.trim());
      if (!m) return d;
      const n = Number(m[1]);
      const unit = m[2] ?? 'px';
      return unit === 'in' ? n * 2.54 : unit === 'cm' ? n : unit === 'mm' ? n / 10 : (n / 96) * 2.54;
    };
    const formats: Record<string, [number, number]> = { letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17], ledger: [17, 11], a0: [33.1, 46.8], a1: [23.4, 33.1], a2: [16.54, 23.4], a3: [11.7, 16.54], a4: [8.27, 11.7], a5: [5.83, 8.27], a6: [4.13, 5.83] };
    const f = formats[(options.format ?? 'letter').toLowerCase()] ?? formats.letter;
    const ranges = (options.pageRanges ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const r = await this.bidi.send('browsingContext.print', {
      context: this.contextId,
      background: !!options.printBackground,
      orientation: options.landscape ? 'landscape' : 'portrait',
      scale: options.scale ?? 1,
      shrinkToFit: !options.preferCSSPageSize,
      page: { width: cm(options.width, f[0] * 2.54), height: cm(options.height, f[1] * 2.54) },
      margin: { top: cm(options.margin?.top, 0), right: cm(options.margin?.right, 0), bottom: cm(options.margin?.bottom, 0), left: cm(options.margin?.left, 0) },
      ...(ranges.length ? { pageRanges: ranges } : {}),
    });
    const buf = Buffer.from(r.data as string, 'base64');
    if (options.path) await writeFile(options.path, buf);
    return buf;
  }

  // ------------------------------------------------------------------ screenshots
  override async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const frame = this.mainFrame();
    const type = options.type ?? (options.path && /\.jpe?g$/i.test(options.path) ? 'jpeg' : 'png');
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    let beyond = false;
    if (options.fullPage) {
      beyond = true;
    } else if (options.clip) {
      const vv = await frame.inEngine(() => {
        const v = window.visualViewport;
        return v ? { pageX: v.pageLeft, pageY: v.pageTop } : { pageX: window.scrollX, pageY: window.scrollY };
      });
      clip = { x: options.clip.x + vv.pageX, y: options.clip.y + vv.pageY, width: options.clip.width, height: options.clip.height, scale: 1 };
      beyond = true;
    }
    return this.capture({ type, quality: options.quality, clip, beyond, options, frame, path: options.path });
  }

  override async capture(o: { type: 'png' | 'jpeg'; quality?: number; clip?: { x: number; y: number; width: number; height: number; scale: number }; beyond: boolean; options: ScreenshotOptions; frame: ChromiumFrame; path?: string }): Promise<Buffer> {
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
        await this.mainFrame().inEngine((_e, h, r, color, style) => h.overlay(r, color, style), [rects, opts.maskColor ?? '#FF00FF', css.join('\n') || undefined]);
        cleanups.push(() => this.mainFrame().inEngine((_e, h) => h.removeOverlay()).catch(() => undefined));
      }
      const r = await this.bidi.send('browsingContext.captureScreenshot', {
        context: this.contextId,
        origin: o.beyond ? 'document' : 'viewport',
        format: o.type === 'jpeg' ? { type: 'image/jpeg', quality: Math.min(1, Math.max(0, (o.quality ?? 80) / 100)) } : { type: 'image/png' },
        ...(o.clip ? { clip: { type: 'box', x: o.clip.x, y: o.clip.y, width: o.clip.width, height: o.clip.height } } : {}),
      });
      const buf = Buffer.from(r.data as string, 'base64');
      if (o.path) await writeFile(o.path, buf);
      return buf;
    } finally {
      for (const c of cleanups.reverse()) await c();
    }
  }

  /**
   * Screencast frames for tracing and recordVideo: BiDi has no frame stream,
   * so the viewport is captured repeatedly (about 10 frames per second).
   */
  override async startScreencast(options: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number }, onFrame: (frame: { data: Buffer; timestamp: number; metadata: Record<string, number> }) => void): Promise<() => Promise<void>> {
    let running = true;
    const format = options.format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: (options.quality ?? 80) / 100 };
    const loop = (async () => {
      while (running && !this.closed) {
        const started = Date.now();
        try {
          const r = await this.bidi.send('browsingContext.captureScreenshot', { context: this.contextId, origin: 'viewport', format });
          if (!running) break;
          onFrame({ data: Buffer.from(r.data as string, 'base64'), timestamp: Date.now() / 1000, metadata: {} });
        } catch {
          if (this.closed) break;
        }
        await sleep(Math.max(10, 100 - (Date.now() - started)));
      }
    })();
    return async () => {
      running = false;
      await loop.catch(() => undefined);
    };
  }

  override cdpSession(): never {
    throw new Error('page.cdpSession: CDP sessions are not available in Firefox (WebDriver BiDi)');
  }
}
