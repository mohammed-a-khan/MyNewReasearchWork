/**
 * The browser session of one journey attempt: its pages (tabs, windows,
 * popups) and frames, dialogs, and the console / network / WebSocket events
 * every page produces. Steps, conditions and waits read from here; all text
 * is masked before it is stored, so secrets never reach evidence or reports.
 */
import type { BrowserContext, CDPSession, Page, Request, Response } from '../browser/index.js';
import { nowIso, type Logger } from '../core/index.js';
import type { WsClient } from '../surfaces/index.js';
import { DialogManager, type DialogPolicy } from './dialogs.js';
import { PageRegistry } from './pages.js';

export interface ConsoleRecord {
  type: string;
  text: string;
  url: string;
  at: string;
  seq: number;
}

export interface RequestRecord {
  seq: number;
  method: string;
  url: string;
  resourceType: string;
  /** Masked request headers. */
  headers: Record<string, string>;
  /** Masked request body (truncated). */
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  failure?: string;
  startedAt: number;
  durationMs?: number;
  /** Live objects (not serialised) for capturing bodies. */
  request: Request;
  response?: Response;
  /** Consumed by a "wait for the response" step. */
  consumed?: boolean;
}

export interface WsFrameRecord {
  seq: number;
  url: string;
  direction: 'sent' | 'received';
  payload: string;
  at: string;
  /** Journey socket name for frames of sockets opened by the test itself. */
  socket?: string;
}

export interface SessionOptions {
  mask?: (s: string) => string;
  logger: Logger;
  dialogs?: DialogPolicy;
  /** Called for each page opened after the first (popups, new tabs). */
  onNewPage?: (page: Page) => void;
}

const MAX_RECORDS = 5000;
const MAX_BODY = 64 * 1024;

export class BrowserSession {
  readonly pages: PageRegistry;
  readonly dialogs: DialogManager;
  readonly console: ConsoleRecord[] = [];
  readonly requests: RequestRecord[] = [];
  readonly wsFrames: WsFrameRecord[] = [];
  /** In-page event listeners installed by "Listen for" / "Wait for the X event" (key -> listener id). */
  readonly eventListeners = new Map<string, string>();
  /** Sockets opened by "Connect to websocket ... as name". */
  readonly sockets = new Map<string, WsClient>();
  /** Extra HTTP headers set by steps (merged into the context). */
  extraHeaders: Record<string, string> = {};
  /** Network routes installed by steps (mock, delay, block, headers), for "Stop mocking ...". */
  readonly routes: Array<{ id: number; url: string; op: string; matcher: (url: URL) => boolean; handler: (route: import('../browser/index.js').Route) => Promise<void> }> = [];
  /** Warnings not yet attached to a step result. */
  private pendingWarnings: string[] = [];
  private seq = 0;
  private cdp = new Map<Page, CDPSession>();
  readonly mask: (s: string) => string;
  /** Cleanup callbacks (routes, timers) run at close. */
  readonly cleanups: Array<() => Promise<void> | void> = [];

  constructor(
    readonly context: BrowserContext,
    first: Page,
    readonly opts: SessionOptions,
  ) {
    this.mask = opts.mask ?? ((s) => s);
    this.dialogs = new DialogManager(opts.dialogs ?? {}, this.mask, opts.logger, (m) => this.warn(m));
    this.pages = new PageRegistry(context, first, (p) => {
      this.attach(p);
      opts.onNewPage?.(p);
    });
    this.attach(first);
  }

  /** The current page. */
  get page(): Page {
    return this.pages.page;
  }

  /** The current frame chain. */
  get frames(): string[] {
    return this.pages.frames;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  /** Current event sequence number: events after this point have a larger seq. */
  get mark(): number {
    return this.seq;
  }

  warn(message: string): void {
    this.pendingWarnings.push(message);
    this.opts.logger.warn(message);
  }

  /** Warnings raised since the last call (attached to the step that was running). */
  takeWarnings(): string[] {
    return this.pendingWarnings.splice(0);
  }

  private attach(page: Page): void {
    this.dialogs.attach(page);
    page.on('console', (m) => this.push(this.console, { type: m.type(), text: this.mask(m.text()), url: page.url(), at: nowIso(), seq: this.nextSeq() }));
    page.on('pageerror', (e) => this.push(this.console, { type: 'pageerror', text: this.mask(e.message), url: page.url(), at: nowIso(), seq: this.nextSeq() }));
    page.on('request', (req) => {
      const post = req.postData();
      this.push(this.requests, {
        seq: this.nextSeq(), method: req.method(), url: req.url(), resourceType: req.resourceType(), headers: this.maskHeaders(req.headers()),
        ...(post ? { postData: this.mask(post.slice(0, MAX_BODY)) } : {}), startedAt: Date.now(), request: req,
      });
    });
    page.on('response', (res) => {
      const rec = this.find(res.request());
      if (!rec) return;
      rec.status = res.status();
      rec.response = res;
      rec.responseHeaders = this.maskHeaders(res.headers());
      rec.durationMs = Date.now() - rec.startedAt;
      // The headers actually sent (including ones added by "Set request header" routes).
      void res.request().allHeaders().then((h) => { rec.headers = this.maskHeaders(h); }, () => undefined);
    });
    page.on('requestfailed', (req) => {
      const rec = this.find(req);
      if (rec) rec.failure = req.failure()?.errorText ?? 'failed';
    });
    page.on('websocket', (ws) => {
      const url = ws.url();
      const rec = (direction: 'sent' | 'received') => (f: { payload: string | Buffer }) =>
        this.push(this.wsFrames, {
          seq: this.nextSeq(), url, direction, at: nowIso(),
          payload: this.mask(typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8')).slice(0, MAX_BODY),
        });
      ws.on('framesent', rec('sent'));
      ws.on('framereceived', rec('received'));
    });
  }

  private find(req: Request): RequestRecord | undefined {
    for (let i = this.requests.length - 1; i >= 0; i--) if (this.requests[i].request === req) return this.requests[i];
    return undefined;
  }

  private push<T>(list: T[], item: T): void {
    list.push(item);
    if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
  }

  /** Mask header values; credentials are always hidden. */
  maskHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      out[k] = /^(?:authorization|proxy-authorization|cookie|set-cookie)$/i.test(k) ? '****' : this.mask(v);
    }
    return out;
  }

  /** A Chrome DevTools Protocol session for the current page (Chromium only). */
  async cdpSession(what: string): Promise<CDPSession> {
    const page = this.page;
    const hit = this.cdp.get(page);
    if (hit) return hit;
    let s: CDPSession;
    try {
      s = await this.context.newCDPSession(page);
    } catch {
      throw new Error(`${what} needs Chromium (DevTools protocol); it is not available in this browser`);
    }
    this.cdp.set(page, s);
    return s;
  }

  /** JSON-safe snapshot of what was recorded (for evidence). */
  snapshot(): Record<string, unknown> {
    return {
      dialogs: this.dialogs.records,
      console: this.console,
      websocket: this.wsFrames,
      requests: this.requests.map(({ request: _r, response: _s, ...rest }) => rest),
      pages: this.pages.open.map((e) => ({ number: e.number, name: e.name, url: e.page.url() })),
    };
  }

  async close(): Promise<void> {
    for (const c of this.cleanups.splice(0)) {
      try {
        await c();
      } catch {
        /* best effort */
      }
    }
    for (const s of this.sockets.values()) await s.close().catch(() => undefined);
    this.sockets.clear();
    for (const s of this.cdp.values()) await s.detach().catch(() => undefined);
    this.cdp.clear();
  }
}
