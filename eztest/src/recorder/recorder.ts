/**
 * startRecording / recordJourney: open the app in a real browser, capture what
 * the user does (through an exposed binding plus an init script that runs in
 * every document and frame) and turn it into a Journey and an `.ez` script.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type DialogClosed, type Download, type Frame, type Page, type Request } from '../browser/index.js';
import { NotSupportedError, sleep } from '../core/index.js';
import { parseCondition } from '../intent/index.js';
import { JourneyComposer, type ComposerEvent, type FramedPageEvent, type RecordingResult } from './compose.js';
import { pageScript, type PageEvent } from './page-script.js';

export interface RecorderOptions {
  /** Where recording starts (absolute, or relative to `baseUrl`). */
  url: string;
  /** Browser to launch when no `page` is given. Default chromium. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Default false: recording is normally interactive. */
  headless?: boolean;
  /** Origin recorded URLs are made relative to; also written to the journey. Default: the origin of `url`. */
  baseUrl?: string;
  /**
   * The project the journey is recorded for (Studio, `eztest record`). Without `baseUrl`, the recording's
   * origin is written to the journey (`Base URL:`) unless the project's baseUrl already points there, so a
   * journey with relative URLs replays in a project that has no baseUrl. Not given: nothing is written.
   */
  project?: { baseUrl?: string };
  /** Record on an existing page (the caller owns its browser; it is not closed on stop). */
  page?: Page;
  /** Journey name (default "Recorded journey on <path>") and id (default: slug of the name). */
  name?: string;
  id?: string;
  /** Default ["recorded"]. */
  tags?: string[];
  executablePath?: string;
  viewport?: { width: number; height: number };
  /** Called with each recorded line as it is captured (live CLI output). */
  onStep?: (line: string) => void;
}

/** Wait this long before committing events, so page events and navigations can be ordered by time. */
const SETTLE_MS = 120;
/** A navigation this soon after a click or key press in the page was started by it (a sign-in's redirect chain). */
const USER_NAV_WINDOW_MS = 5000;

async function launch(opts: RecorderOptions): Promise<Browser> {
  const kind = opts.browser ?? 'chromium';
  const type = kind === 'chromium' ? chromium : kind === 'firefox' ? firefox : kind === 'webkit' ? webkit : undefined;
  if (!type) throw new NotSupportedError(`browser "${String(kind)}"`);
  return type.launch({ headless: opts.headless ?? false, ...(opts.executablePath ? { executablePath: opts.executablePath } : {}) });
}

/**
 * The frames between the main frame and `frame`, outermost first, each named the way a tester names it: the
 * frame's name, id or title when that picks out one frame in its document, else a part of its address, else a
 * CSS selector. The runner looks a frame up the same way (name, id, title, aria-label, then src), so the first
 * frame it finds is this one.
 */
async function frameChain(frame: Frame): Promise<string[]> {
  const out: string[] = [];
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const handle = await f.frameElement();
    // No inner named functions, so it serializes cleanly into the page.
    const desc = await handle.evaluate((node) => {
      const el = node as Element;
      const root = el.getRootNode() as Document | ShadowRoot;
      const frames = Array.from(root.querySelectorAll('iframe,frame'));
      const plain = (v: string | null): v is string =>
        !!v && v.length <= 80 && !/["\\\n\r]/.test(v) && v.trim() === v && !/^(?:css\s*=|[#.[]|i?frame(?:$|[\s#.[:>~+]))/i.test(v);
      const count = (attr: string, v: string) => frames.filter((x) => (attr === 'id' ? x.id : x.getAttribute(attr)) === v).length;
      const name = el.getAttribute('name');
      if (plain(name) && count('name', name) === 1) return name;
      // A title reads better than a generated id ("Rich Text Area", not "mce_0_ifr").
      const title = el.getAttribute('title');
      if (plain(title) && count('title', title) === 1 && count('name', title) === 0 && count('id', title) === 0) return title;
      const id = el.id;
      if (plain(id) && count('id', id) === 1 && count('name', id) === 0) return id;
      const src = el.getAttribute('src') ?? '';
      let path = '';
      try {
        path = src && !/^(?:about|data|javascript|blob):/i.test(src) ? new URL(src, location.href).pathname : '';
      } catch {
        path = '';
      }
      if (plain(path) && path.length > 1 && frames.filter((x) => (x.getAttribute('src') ?? '').includes(path)).length === 1 &&
        count('name', path) + count('id', path) + count('title', path) === 0) return path;
      const tag = el.tagName.toLowerCase();
      if (root.querySelectorAll(tag).length === 1) return tag;
      let idx = 1;
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === el.tagName) idx++;
      const sel = `${tag}:nth-of-type(${idx})`;
      if (root.querySelectorAll(sel).length === 1) return sel;
      const parent = el.parentElement;
      const scoped = parent && parent.id && /^[A-Za-z][\w-]*$/.test(parent.id) ? `#${parent.id} > ${sel}` : '';
      return scoped && root.querySelectorAll(scoped).length === 1 ? scoped : `css=${sel}`;
    });
    await handle.dispose();
    out.unshift(desc);
  }
  return out;
}


/**
 * The files a person chose in a file input, as paths (relative to the working directory when inside it). The page
 * only sees file names; Chromium's DevTools protocol knows where each file came from. Undefined when the browser
 * cannot say (Firefox), so the recording keeps the names and says to edit them.
 */
async function chosenFilePaths(context: BrowserContext, page: Page, css: string, count: number): Promise<string[] | undefined> {
  if (css.includes('>>')) return undefined;
  let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
  try {
    cdp = await context.newCDPSession(page);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const { result } = (await cdp.send('Runtime.evaluate', { expression: `(document.querySelector(${JSON.stringify(css)}) || {}).files?.[${i}]` })) as { result: { objectId?: string } };
      if (!result.objectId) return undefined;
      const { path } = (await cdp.send('DOM.getFileInfo', { objectId: result.objectId })) as { path?: string };
      if (!path) return undefined;
      const rel = relative(process.cwd(), path);
      out.push((rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).split(sep).join('/'));
    }
    return out;
  } catch {
    return undefined;
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
}

/** frameChain, asked again shortly when the browser does not know the frame yet (a frameset still loading). */
async function frameChainWithRetry(frame: Frame): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await frameChain(frame);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(250);
    }
  }
}

/** Frames of ad networks: what happens in them is never a step. */
const AD_FRAME = /^https?:\/\/(?:[^/]*\.)?(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.(?:com|net)|pubmatic\.com|rubiconproject\.com)\//i;

const FLUSH_EXPR = 'window.__ezRecorder && window.__ezRecorder.flush ? window.__ezRecorder.flush() : []';
const DETACH_EXPR = 'window.__ezRecorder ? (window.__ezRecorder.binding = null, true) : false';

/** A recording in progress. Drive `page` (as a user, or programmatically), then call `stop()`. */
export class Recorder {
  private readonly queue: ComposerEvent[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped?: RecordingResult;
  private stopping?: Promise<RecordingResult>;
  /** When the person last clicked, pressed a key or submitted in the page (a navigation right after it is the page's). */
  private lastUserAction = 0;
  /** Every tab, window and popup of the recording, numbered in opening order (the main page is 1). */
  private readonly tabs = new Map<Page, number>();
  private tabCounter = 0;
  /** Tabs by when the person last used them, most recent last: an expectation is about the one in front. */
  private readonly recent: number[] = [];
  private touch(tab: number): void {
    const i = this.recent.indexOf(tab);
    if (i >= 0) this.recent.splice(i, 1);
    this.recent.push(tab);
  }
  private readonly detach: Array<() => void> = [];
  private readonly onNewPage = (p: Page) => {
    if (this.stopped || this.stopping || this.tabs.has(p)) return;
    const tab = this.track(p);
    this.touch(tab);
    const t = Date.now();
    this.enqueue({ kind: 'tab', op: 'open', tab, t });
    // A popup can have loaded its address before we started watching it.
    const url = p.url();
    if (/^(?:https?|file):/i.test(url)) this.enqueue({ kind: 'navigate', url, t: t + 1, byPage: true, tab });
  };

  /** Watch one page: its navigations, dialogs, downloads and closing. */
  private track(page: Page): number {
    const known = this.tabs.get(page);
    if (known) return known;
    const tab = ++this.tabCounter;
    this.tabs.set(page, tab);
    // Main-frame navigation requests: whether each was started by the page. A link or script carries a Referer; a
    // form post carries an Origin (sign-in pages send `Referrer-Policy: no-referrer`, so a Keycloak or Entra ID
    // sign-in and its redirect chain back to the app has no Referer at all); and a navigation right after the
    // person clicked or pressed a key in the page is the page's too. Only what is left is a URL typed by the person.
    const navRequests = new Map<string, boolean>();
    const onRequest = (req: Request) => {
      if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return;
      let first = req;
      for (let r = req.redirectedFrom(); r; r = r.redirectedFrom()) first = r;
      const h = first.headers();
      navRequests.set(req.url(), Boolean(h['referer']) || 'origin' in h || first.method() !== 'GET' || Date.now() - this.lastUserAction < USER_NAV_WINDOW_MS);
      if (navRequests.size > 50) navRequests.delete(navRequests.keys().next().value as string);
    };
    const onNav = (f: Frame) => {
      if (f !== page.mainFrame()) return;
      const url = f.url();
      // Same-document navigations (history API) have no request: the page started them.
      const byPage = navRequests.get(url) ?? true;
      navRequests.delete(url);
      this.enqueue({ kind: 'navigate', url, t: Date.now(), byPage, tab });
    };
    // Listening keeps a dialog open for the person to answer (the driver dismisses dialogs nobody watches).
    const onDialog = () => undefined;
    const onDialogClosed = (d: DialogClosed) => {
      this.enqueue({ kind: 'dialog', type: d.type, message: d.message, accepted: d.accepted, ...(d.userInput !== undefined ? { userInput: d.userInput } : {}), t: Date.now(), tab });
    };
    const onDownload = (d: Download) => this.enqueue({ kind: 'download', filename: d.suggestedFilename(), t: Date.now(), tab });
    const onClose = () => {
      const i = this.recent.indexOf(tab);
      if (i >= 0) this.recent.splice(i, 1);
      this.enqueue({ kind: 'tab', op: 'close', tab, t: Date.now() });
    };
    page.on('request', onRequest);
    page.on('framenavigated', onNav);
    page.on('dialog', onDialog);
    page.on('dialogclosed', onDialogClosed);
    page.on('download', onDownload);
    page.on('close', onClose);
    this.detach.push(() => {
      page.off('request', onRequest);
      page.off('framenavigated', onNav);
      page.off('dialog', onDialog);
      page.off('dialogclosed', onDialogClosed);
      page.off('download', onDownload);
      page.off('close', onClose);
    });
    return tab;
  }

  /** @internal use startRecording() */
  constructor(
    readonly page: Page,
    readonly context: BrowserContext,
    private readonly composer: JourneyComposer,
    private readonly ownedBrowser: Browser | undefined,
  ) {}

  /** @internal */
  async begin(url: string): Promise<void> {
    this.touch(this.track(this.page));
    this.context.on('page', this.onNewPage);
    this.composer.start(Date.now());
    await this.page.goto(url);
  }

  /** The open pages of the recording (tabs, windows, popups), the main page first. */
  get pages(): Page[] {
    return [...this.tabs.keys()].filter((p) => !p.isClosed());
  }

  /** @internal binding entry point */
  onPageEvent(source: { page: Page; frame: Frame }, payload: unknown): void {
    if (this.stopped || this.stopping) return;
    const ev = payload as PageEvent;
    if (!ev || typeof ev !== 'object' || typeof (ev as { kind?: unknown }).kind !== 'string') return;
    // Closing an ad (Google's full-screen vignette) is not part of the journey: the runner closes those itself.
    for (let f: Frame | null = source.frame; f; f = f.parentFrame()) if (AD_FRAME.test(f.url())) return;
    // A popup can report its first action before the context's "page" event reaches us.
    if (!this.tabs.has(source.page)) this.onNewPage(source.page);
    const tab = this.tabs.get(source.page) ?? 1;
    this.touch(tab);
    if (ev.kind !== 'fill') this.lastUserAction = Date.now();
    const p = (async () => {
      const framed: FramedPageEvent = { ...ev, tab };
      const inPage = (ev as { frameChain?: unknown }).frameChain;
      delete (framed as { frameChain?: unknown }).frameChain;
      if (source.frame !== source.page.mainFrame()) {
        try {
          // Named by the page itself when every parent is on the same origin; else asked of the browser.
          framed.frames = Array.isArray(inPage) && inPage.every((x) => typeof x === 'string') ? (inPage as string[]) : await frameChainWithRetry(source.frame);
        } catch (e) {
          this.composer.warn(`An action inside a frame was dropped: its frame could not be identified (${(e as Error).message}).`);
          return;
        }
      } else if (framed.kind === 'upload' && framed.files.length) {
        const paths = await chosenFilePaths(this.context, source.page, framed.el.css, framed.files.length);
        if (paths) framed.files = paths;
      }
      this.enqueue(framed);
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /**
   * Add an expectation as a post-condition of the last recorded step, e.g.
   * `the page contains "Saved"` or `Expect the URL contains "/orders"`.
   * Throws if the text is not a valid expectation.
   */
  addExpectation(text: string): Promise<void> {
    if (this.stopped || this.stopping) throw new Error('addExpectation: the recording has stopped');
    const body = text.trim().replace(/^(?:(?:then|and|also)\s+)?(?:expect|verify|assert|check|ensure|confirm)\s+(?:that\s+)?/i, '');
    if (!body) throw new Error('addExpectation: type what to expect, e.g. page contains "Dashboard"');
    const condition = parseCondition(body);
    // Typing still being settled in the page belongs before the expectation: flush it first, so the expectation
    // attaches to the step the user just did and not to the one before it.
    const done = (async () => {
      await this.flushPendingTyping();
      await Promise.all([...this.inflight].filter((p) => p !== done));
      this.enqueue({ kind: 'expect', condition, t: Date.now(), tab: this.recent[this.recent.length - 1] ?? 1 });
    })();
    this.inflight.add(done);
    void done.finally(() => this.inflight.delete(done));
    return done;
  }

  /** Ask every frame of every tab for typing it has not reported yet (and, when stopping, detach it). */
  private async flushPendingTyping(detach = false): Promise<void> {
    for (const [page, tab] of this.tabs) {
      if (page.isClosed()) continue;
      for (const frame of page.frames()) {
        try {
          const evs = (await frame.evaluate(FLUSH_EXPR)) as PageEvent[];
          const frames = frame === page.mainFrame() || !evs.length ? [] : await frameChain(frame);
          for (const ev of evs) this.enqueue({ ...ev, tab, ...(frames.length ? { frames } : {}) });
          if (detach) await frame.evaluate(DETACH_EXPR);
        } catch {
          // Frame detached or navigating: nothing pending there.
        }
      }
    }
    await sleep(SETTLE_MS);
  }

  /** Number of steps recorded so far (events still settling are not counted). */
  get stepCount(): number {
    return this.composer.stepCount;
  }

  /** The journey as recorded so far, without stopping. */
  async snapshot(): Promise<RecordingResult> {
    await Promise.all([...this.inflight]);
    this.drain(true);
    return this.composer.result();
  }

  /** Stop recording: flush pending typing, build the journey, close the browser if the recorder launched it. */
  stop(): Promise<RecordingResult> {
    if (this.stopped) return Promise.resolve(this.stopped);
    this.stopping ??= this.finish();
    return this.stopping;
  }

  private async finish(): Promise<RecordingResult> {
    // Binding calls already sent by the pages may still be on their way: flushing waits a moment for them.
    await this.flushPendingTyping(true);
    await Promise.all([...this.inflight]);
    this.context.off('page', this.onNewPage);
    for (const off of this.detach.splice(0)) off();
    if (this.timer) clearTimeout(this.timer);
    this.drain(true);
    const result = this.composer.result();
    this.stopped = result;
    if (this.ownedBrowser) await this.ownedBrowser.close().catch(() => undefined);
    return result;
  }

  private enqueue(ev: ComposerEvent): void {
    this.queue.push(ev);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain(false);
      }, SETTLE_MS);
    }
  }

  /** Apply settled events in time order (all of them when `all`). */
  private drain(all: boolean): void {
    const cutoff = all ? Number.POSITIVE_INFINITY : Date.now() - SETTLE_MS / 2;
    this.queue.sort((a, b) => a.t - b.t);
    let n = 0;
    while (n < this.queue.length && this.queue[n].t <= cutoff) n++;
    const ready = this.queue.splice(0, n);
    for (const ev of ready) {
      try {
        this.composer.apply(ev);
      } catch (e) {
        this.composer.warn(`A recorded ${ev.kind} could not be turned into a step: ${(e as Error).message}`);
      }
    }
    if (this.queue.length && !this.timer && !this.stopped) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain(false);
      }, SETTLE_MS);
    }
  }
}

/**
 * Start recording at `opts.url`. Without `opts.page` a browser is launched
 * (headed by default) and closed again by `stop()`.
 */
/** The Base URL to write into a recorded journey: its origin, unless the project already points there. */
export function journeyBaseUrl(origin: string, projectBaseUrl?: string): string | undefined {
  if (!projectBaseUrl) return origin;
  try {
    return new URL(projectBaseUrl).origin === origin ? undefined : origin;
  } catch {
    return origin;
  }
}

export async function startRecording(opts: RecorderOptions): Promise<Recorder> {
  let browser: Browser | undefined;
  let page: Page;
  if (opts.page) {
    page = opts.page;
  } else {
    browser = await launch(opts);
    const context = await browser.newContext(opts.viewport ? { viewport: opts.viewport } : {});
    page = await context.newPage();
  }
  const context = page.context();
  const base = opts.baseUrl ?? new URL(opts.url).origin;
  const startUrl = new URL(opts.url, base).toString();
  // Always say where the journey was recorded, unless the project already points there: without it, a journey of
  // relative steps cannot run anywhere (`Open /login` needs a base URL).
  const written = opts.baseUrl ?? journeyBaseUrl(new URL(startUrl).origin, opts.project?.baseUrl);
  const composer = new JourneyComposer({
    startUrl,
    ...(written ? { baseUrl: written } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.onStep ? { onStep: opts.onStep } : {}),
  });
  const binding = `__ezRec_${randomBytes(6).toString('hex')}`;
  const recorder = new Recorder(page, context, composer, browser);
  try {
    await context.exposeBinding(binding, (source, payload: unknown) => recorder.onPageEvent(source, payload));
    await context.addInitScript({ content: pageScript(binding) });
    await recorder.begin(startUrl);
  } catch (e) {
    if (browser) await browser.close().catch(() => undefined);
    throw e;
  }
  return recorder;
}

/**
 * Record until `until` resolves, or until the page/browser is closed when
 * `until` is "close" (interactive CLI use), then stop and return the result.
 */
export async function recordJourney(opts: RecorderOptions & { until: Promise<void> | 'close' }): Promise<RecordingResult> {
  const recorder = await startRecording(opts);
  if (opts.until === 'close') {
    await new Promise<void>((resolve) => {
      if (recorder.page.isClosed()) return resolve();
      recorder.page.once('close', () => resolve());
      recorder.context.browser()?.once('disconnected', () => resolve());
    });
  } else {
    try {
      await opts.until;
    } catch (e) {
      await recorder.stop().catch(() => undefined);
      throw e;
    }
  }
  return recorder.stop();
}
