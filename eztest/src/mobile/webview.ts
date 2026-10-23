/**
 * Hybrid apps: a WebView (or Chrome on the device) attached over its DevTools
 * socket, forwarded to the host by EZTest's ADB client, and driven with the
 * Chrome DevTools Protocol. This is the WebView bridge seam: `CdpWebView` is a
 * small built-in implementation (WebSocket from Node, element access through
 * Runtime.evaluate / DOM input events); when the EZTest CDP browser driver
 * (src/browser) lands, `attachWebView` can hand the endpoint to it instead
 * without changing callers (they only use WebViewSession).
 *
 * Page-side code is fixed functions below; journey text is only ever passed
 * as JSON-encoded arguments, never spliced into code.
 */
import { DeviceError, type FindStrategy, type Rect, type WebViewSession } from './session.js';

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/** The DevTools targets behind a forwarded socket (GET /json/list). */
export async function listCdpTargets(httpBase: string): Promise<CdpTarget[]> {
  const res = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new DeviceError(`DevTools /json/list answered HTTP ${res.status}`, 'internal', res.status);
  return (await res.json()) as CdpTarget[];
}

/** Minimal CDP connection over a WebSocket. */
export class CdpConnection {
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new DeviceError(`DevTools: ${msg.error.message}`, 'internal'));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new DeviceError('DevTools connection closed', 'connection failed'));
      this.pending.clear();
    });
  }

  static open(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        reject(new DeviceError(`DevTools WebSocket ${url} did not open within ${timeoutMs} ms`, 'connection failed'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new DeviceError(`DevTools WebSocket ${url} failed to open`, 'connection failed'));
      });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceError(`DevTools ${method} timed out after ${timeoutMs} ms`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v as T); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

// ------------------------------------------------------------------ page-side functions (fixed code; arguments are JSON)
const FIND = `function(using, value) {
  var norm = function(s) { return (s || '').replace(/\\s+/g, ' ').trim(); };
  var all = Array.prototype.slice.call(document.querySelectorAll('*'));
  var out = [];
  if (using === 'css') out = Array.prototype.slice.call(document.querySelectorAll(value));
  else if (using === 'xpath') { var r = document.evaluate(value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); for (var i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i)); }
  else if (using === 'id') { var e = document.getElementById(value); if (e) out = [e]; }
  else if (using === 'accessibility id') out = all.filter(function(e) { return e.getAttribute('aria-label') === value; });
  else if (using === 'text' || using === 'text contains') {
    var match = function(s) { s = norm(s); return using === 'text' ? s === norm(value) : s.indexOf(norm(value)) >= 0; };
    out = all.filter(function(e) {
      if (['aria-label', 'title', 'placeholder', 'alt'].some(function(a) { return match(e.getAttribute(a)); })) return true;
      if ((e.tagName === 'INPUT' || e.tagName === 'BUTTON') && match(e.value)) return true;
      if (!match(e.innerText || e.textContent)) return false;
      return !Array.prototype.some.call(e.children, function(c) { return match(c.innerText || c.textContent); });
    });
  } else throw new Error('strategy ' + using + ' is not supported in a web view');
  window.__ezEls = window.__ezEls || [];
  return out.map(function(e) { var i = window.__ezEls.indexOf(e); if (i < 0) i = window.__ezEls.push(e) - 1; return i; });
}`;

const ELEMENT_OP = `function(index, op, arg) {
  var el = (window.__ezEls || [])[index];
  if (!el || !el.isConnected) return { stale: true };
  var r = el.getBoundingClientRect();
  var style = getComputedStyle(el);
  switch (op) {
    case 'rect': return { value: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } };
    case 'center': el.scrollIntoView({ block: 'center', inline: 'center' }); r = el.getBoundingClientRect(); return { value: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
    case 'text': return { value: ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) ? el.value : (el.innerText || el.textContent || '') };
    case 'attribute': return { value: el.getAttribute(arg) };
    case 'displayed': return { value: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' };
    case 'enabled': return { value: !el.disabled };
    case 'selected': return { value: !!(el.checked || el.selected) };
    case 'focus': el.focus(); return { value: true };
    case 'clear': el.focus(); if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } return { value: true };
    default: throw new Error('unknown element op ' + op);
  }
}`;

/** A web view driven over the DevTools Protocol. */
export class CdpWebView implements WebViewSession {
  private constructor(
    readonly name: string,
    private readonly cdp: CdpConnection,
    private readonly onClose?: () => Promise<void>,
  ) {}

  /** Attach to the first page target behind a forwarded DevTools endpoint (http://127.0.0.1:<port>). */
  static async attach(name: string, httpBase: string, onClose?: () => Promise<void>, urlHint?: string): Promise<CdpWebView> {
    const pages = (await listCdpTargets(httpBase)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const page = (urlHint ? pages.find((p) => p.url.includes(urlHint)) : undefined) ?? pages[0];
    if (!page) throw new DeviceError(`no page in web view ${name}`, 'no such context');
    // The target URL names the device-side host; talk to our forwarded port instead.
    const ws = new URL(page.webSocketDebuggerUrl!);
    const base = new URL(httpBase);
    ws.host = base.host;
    const cdp = await CdpConnection.open(ws.toString());
    await cdp.send('Runtime.enable');
    return new CdpWebView(name, cdp, onClose);
  }

  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const r = await this.cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>('Runtime.evaluate', {
      expression: `(${fn}).apply(null, ${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new DeviceError(`web view: ${r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text}`, 'invalid argument');
    return r.result.value as T;
  }

  private async op<T>(el: string, op: string, arg?: string): Promise<T> {
    const r = await this.call<{ stale?: boolean; value?: T }>(ELEMENT_OP, [Number(el.replace(/^w:/, '')), op, arg ?? null]);
    if (r.stale) throw new DeviceError(`stale element: ${el} is no longer in the web view`, 'stale element');
    return r.value as T;
  }

  async findElements(using: FindStrategy, value: string): Promise<string[]> {
    if (using === 'class' || using === 'predicate') throw new DeviceError(`strategy "${using}" is not supported in a web view`, 'not supported');
    return (await this.call<number[]>(FIND, [using, value])).map((i) => `w:${i}`);
  }

  async click(el: string): Promise<void> {
    const p = await this.op<{ x: number; y: number }>(el, 'center');
    for (const type of ['mousePressed', 'mouseReleased']) await this.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }

  async clear(el: string): Promise<void> { await this.op(el, 'clear'); }
  async type(el: string, text: string): Promise<void> {
    await this.op(el, 'focus');
    await this.cdp.send('Input.insertText', { text });
  }
  async text(el: string): Promise<string> { return String((await this.op<string>(el, 'text')) ?? ''); }
  async attribute(el: string, name: string): Promise<string | null> { return (await this.op<string | null>(el, 'attribute', name)) ?? null; }
  rect(el: string): Promise<Rect> { return this.op(el, 'rect'); }
  async displayed(el: string): Promise<boolean> { return Boolean(await this.op(el, 'displayed')); }
  async enabled(el: string): Promise<boolean> { return Boolean(await this.op(el, 'enabled')); }
  async selected(el: string): Promise<boolean> { return Boolean(await this.op(el, 'selected')); }
  async source(): Promise<string> { return this.call<string>('function() { return document.documentElement.outerHTML; }', []); }
  async url(): Promise<string> { return this.call<string>('function() { return location.href; }', []); }
  async title(): Promise<string> { return this.call<string>('function() { return document.title; }', []); }
  async navigate(url: string): Promise<void> {
    await this.cdp.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 300));
  }
  async back(): Promise<void> { await this.call('function() { history.back(); return true; }', []); }
  async close(): Promise<void> {
    this.cdp.close();
    await this.onClose?.();
  }
}
