/**
 * Live view: JPEG frames of a page. Chromium uses CDP `Page.startScreencast`
 * with backpressure: Chromium sends the next frame only after an ack, acks
 * are delayed to cap the frame rate, and a frame is dropped (still acked)
 * when the consumer says it is busy. Firefox and WebKit fall back to periodic
 * screenshots.
 */
import type { CDPSession, Page } from '../../browser/index.js';
import { cdpFor } from './input.js';

export interface ScreencastFrame {
  /** Base64 JPEG. */
  data: string;
  /** Frame metadata: CSS viewport size, scroll offsets, page scale (map client clicks with it). */
  metadata: { deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number; offsetTop?: number; scrollOffsetX?: number; scrollOffsetY?: number; timestamp?: number };
  seq: number;
  at: number;
}

export interface ScreencastOptions {
  /** Frame-rate cap. Default 8. */
  maxFps?: number;
  /** JPEG quality 1..100. Default 60. */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Fallback (non-Chromium) screenshot interval. Default 500 ms. */
  fallbackIntervalMs?: number;
  /** "auto" (default): CDP screencast on Chromium, screenshots elsewhere; "screenshot": always poll screenshots. */
  mode?: 'auto' | 'screenshot';
  /** Return false when the consumer cannot take the frame now (it is dropped). */
  onFrame(frame: ScreencastFrame): boolean | void;
}

export interface ScreencastStats {
  mode: 'cdp' | 'screenshot' | 'stopped';
  delivered: number;
  dropped: number;
}

export class Screencast {
  private cdp?: CDPSession;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastSent = 0;
  private seq = 0;
  readonly stats: ScreencastStats = { mode: 'stopped', delivered: 0, dropped: 0 };
  private readonly onCdpFrame = (f: { data: string; metadata: ScreencastFrame['metadata']; sessionId: number }) => this.handleCdpFrame(f);

  constructor(
    readonly page: Page,
    private readonly opts: ScreencastOptions,
  ) {}

  private get interval(): number {
    return 1000 / Math.max(1, Math.min(30, this.opts.maxFps ?? 8));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const cdp = this.opts.mode === 'screenshot' ? undefined : await cdpFor(this.page);
    if (cdp) {
      this.cdp = cdp;
      this.stats.mode = 'cdp';
      cdp.on('Page.screencastFrame', this.onCdpFrame);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.opts.quality ?? 60,
        ...(this.opts.maxWidth ? { maxWidth: this.opts.maxWidth } : {}),
        ...(this.opts.maxHeight ? { maxHeight: this.opts.maxHeight } : {}),
        everyNthFrame: 1,
      });
      return;
    }
    this.stats.mode = 'screenshot';
    const every = Math.max(this.interval, this.opts.fallbackIntervalMs ?? 500);
    const tick = async () => {
      if (!this.running) return;
      try {
        const buf = await this.page.screenshot({ type: 'jpeg', quality: this.opts.quality ?? 60, timeout: 2000 });
        const vp = this.page.viewportSize();
        this.deliver(buf.toString('base64'), { deviceWidth: vp?.width, deviceHeight: vp?.height, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 });
      } catch {
        // page navigating or closed; try again next tick
      }
      if (this.running) this.timer = setTimeout(tick, every);
    };
    void tick();
  }

  private handleCdpFrame(f: { data: string; metadata: ScreencastFrame['metadata']; sessionId: number }): void {
    const cdp = this.cdp;
    if (!cdp || !this.running) return;
    const wait = Math.max(0, this.lastSent + this.interval - Date.now());
    if (wait > 0) this.stats.dropped++;
    else this.deliver(f.data, f.metadata);
    // Delaying the ack is the backpressure: Chromium waits for it before the next frame.
    setTimeout(() => {
      if (this.running) void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    }, Math.max(wait, this.interval));
  }

  private deliver(data: string, metadata: ScreencastFrame['metadata']): void {
    const ok = this.opts.onFrame({ data, metadata, seq: ++this.seq, at: Date.now() });
    if (ok === false) this.stats.dropped++;
    else {
      this.stats.delivered++;
      this.lastSent = Date.now();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stats.mode = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    if (this.cdp) {
      this.cdp.off('Page.screencastFrame', this.onCdpFrame);
      await this.cdp.send('Page.stopScreencast').catch(() => undefined);
    }
  }
}

/** Start a screencast on a page. */
export async function startScreencast(page: Page, opts: ScreencastOptions): Promise<Screencast> {
  const s = new Screencast(page, opts);
  await s.start();
  return s;
}
