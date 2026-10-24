/**
 * startRecording / recordJourney: open the app in a real browser, capture what
 * the user does (through an exposed binding plus an init script that runs in
 * every document and frame) and turn it into a Journey and an `.ez` script.
 */
import { randomBytes } from 'node:crypto';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Frame, type Page, type Request } from '../browser/index.js';
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

async function launch(opts: RecorderOptions): Promise<Browser> {
  const kind = opts.browser ?? 'chromium';
  const type = kind === 'chromium' ? chromium : kind === 'firefox' ? firefox : kind === 'webkit' ? webkit : undefined;
  if (!type) throw new NotSupportedError(`browser "${String(kind)}"`);
  return type.launch({ headless: opts.headless ?? false, ...(opts.executablePath ? { executablePath: opts.executablePath } : {}) });
}

/** Selector chain of the iframes between the main frame and `frame`. */
async function frameChain(frame: Frame): Promise<string[]> {
  const out: string[] = [];
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const handle = await f.frameElement();
    // A single expression (no inner named functions), so it serializes cleanly into the page.
    const sel = await handle.evaluate((node) =>
      (node as Element).id && /^[A-Za-z][\w-]*$/.test((node as Element).id) ? `iframe#${(node as Element).id}`
        : (node as Element).getAttribute('name') ? `iframe[name="${(node as Element).getAttribute('name')}"]`
          : (node as Element).getAttribute('title') ? `iframe[title="${(node as Element).getAttribute('title')}"]`
            : `iframe[src="${(node as Element).getAttribute('src') ?? ''}"]`);
    await handle.dispose();
    out.unshift(sel);
  }
  return out;
}

const FLUSH_EXPR = 'window.__ezRecorder && window.__ezRecorder.flush ? window.__ezRecorder.flush() : []';
const DETACH_EXPR = 'window.__ezRecorder ? (window.__ezRecorder.binding = null, true) : false';

/** A recording in progress. Drive `page` (as a user, or programmatically), then call `stop()`. */
export class Recorder {
  private readonly queue: ComposerEvent[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped?: RecordingResult;
  private stopping?: Promise<RecordingResult>;
  /** Main-frame navigation requests: whether each was started by the page (it carries a Referer). */
  private readonly navRequests = new Map<string, boolean>();
  private readonly onRequest = (req: Request) => {
    if (!req.isNavigationRequest() || req.frame() !== this.page.mainFrame()) return;
    let first = req;
    for (let r = req.redirectedFrom(); r; r = r.redirectedFrom()) first = r;
    this.navRequests.set(req.url(), Boolean(first.headers()['referer']));
    if (this.navRequests.size > 50) this.navRequests.delete(this.navRequests.keys().next().value as string);
  };
  private readonly onNav = (f: Frame) => {
    if (f !== this.page.mainFrame()) return;
    const url = f.url();
    // Same-document navigations (history API) have no request: the page started them.
    const byPage = this.navRequests.get(url) ?? true;
    this.navRequests.delete(url);
    this.enqueue({ kind: 'navigate', url, t: Date.now(), byPage });
  };

  /** @internal use startRecording() */
  constructor(
    readonly page: Page,
    readonly context: BrowserContext,
    private readonly composer: JourneyComposer,
    private readonly ownedBrowser: Browser | undefined,
  ) {}

  /** @internal */
  async begin(url: string): Promise<void> {
    this.page.on('request', this.onRequest);
    this.page.on('framenavigated', this.onNav);
    this.composer.start(Date.now());
    await this.page.goto(url);
  }

  /** @internal binding entry point */
  onPageEvent(source: { page: Page; frame: Frame }, payload: unknown): void {
    if (this.stopped || this.stopping) return;
    if (source.page !== this.page) {
      this.composer.warn('Actions in other tabs or popups are not recorded; record each page separately.');
      return;
    }
    const ev = payload as PageEvent;
    if (!ev || typeof ev !== 'object' || typeof (ev as { kind?: unknown }).kind !== 'string') return;
    const p = (async () => {
      const framed: FramedPageEvent = { ...ev };
      if (source.frame !== this.page.mainFrame()) {
        try {
          framed.frames = await frameChain(source.frame);
        } catch (e) {
          this.composer.warn(`An action inside a frame was dropped: its frame could not be identified (${(e as Error).message}).`);
          return;
        }
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
      this.enqueue({ kind: 'expect', condition, t: Date.now() });
    })();
    this.inflight.add(done);
    void done.finally(() => this.inflight.delete(done));
    return done;
  }

  /** Ask every frame for typing it has not reported yet (without detaching the recorder). */
  private async flushPendingTyping(): Promise<void> {
    if (this.page.isClosed()) return;
    for (const frame of this.page.frames()) {
      try {
        const evs = (await frame.evaluate(FLUSH_EXPR)) as PageEvent[];
        const frames = frame === this.page.mainFrame() ? [] : await frameChain(frame);
        for (const ev of evs) this.enqueue({ ...ev, ...(frames.length ? { frames } : {}) });
      } catch {
        // Frame detached or navigating: nothing pending there.
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
    if (!this.page.isClosed()) {
      for (const frame of this.page.frames()) {
        try {
          const evs = (await frame.evaluate(FLUSH_EXPR)) as PageEvent[];
          const frames = frame === this.page.mainFrame() ? [] : await frameChain(frame);
          for (const ev of evs) this.enqueue({ ...ev, ...(frames.length ? { frames } : {}) });
          await frame.evaluate(DETACH_EXPR);
        } catch {
          // Frame detached or navigating: nothing pending there.
        }
      }
      // Binding calls already sent by the page may still be on their way.
      await sleep(SETTLE_MS);
    }
    await Promise.all([...this.inflight]);
    this.page.off('framenavigated', this.onNav);
    this.page.off('request', this.onRequest);
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
  const written = opts.baseUrl ?? (opts.project ? journeyBaseUrl(new URL(startUrl).origin, opts.project.baseUrl) : undefined);
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
