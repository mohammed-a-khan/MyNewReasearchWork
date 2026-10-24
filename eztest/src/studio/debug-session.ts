/**
 * Debug sessions from the Studio: start a debug run of one journey (one
 * session at a time), hold its DebugController, fan its events out to SSE
 * listeners (with replay for late subscribers) and share one live-view
 * screencast between frame listeners. WebSocket-free: commands are JSON
 * POSTs, events and frames are SSE.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '../browser/index.js';
import { EventBus, type EzEvent } from '../core/index.js';
import { createMaskedLogger, type SecretMasker } from '../config/index.js';
import { createEngine } from '../engine/index.js';
import { loadJourneys, bddOptionsFrom, defaultJourneyPaths } from '../cli/journeys.js';
import { DebugController, SENSITIVE_DESC, Screencast, type BreakpointInput, type ScreencastFrame } from '../runner/index.js';
import type { RunOptions } from '../runner/index.js';
import { HttpError, loadStudioConfig, type StudioContext, type StudioEvent } from './runs.js';

export interface DebugStartRequest {
  /** Journey id to debug. */
  journey: string;
  breakpoints?: BreakpointInput[];
  /** Default true. */
  pauseOnFailure?: boolean;
  /** Pause before the first step. Default true. */
  pauseAtStart?: boolean;
  /** Also record a time-travel trace. Default true. */
  timeTravel?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
  headed?: boolean;
}

export interface DebugSession {
  id: string;
  journeyId: string;
  /** stopped: Stop ended the run early (the remaining steps were not run; teardown hooks ran). */
  state: 'running' | 'done' | 'stopped' | 'error';
  startedAt: string;
  controller: DebugController;
  events: StudioEvent[];
  result?: Record<string, unknown>;
  /** Cancels the run when Stop is pressed. */
  abort: AbortController;
  stopRequested?: boolean;
}

type Listener = (e: StudioEvent) => void;
type FrameListener = (f: ScreencastFrame) => boolean | void;

export interface DebugSessionManagerOptions {
  /** Extra runner options (tests: shorter timeouts). */
  runOptions?: Partial<RunOptions>;
  /** Live-view frame-rate cap. Default 8. */
  maxFps?: number;
}

export class DebugSessionManager {
  private session?: DebugSession;
  private readonly listeners = new Set<Listener>();
  private readonly frameListeners = new Set<FrameListener>();
  private cast?: Screencast;
  private offPage?: () => void;
  private masker?: SecretMasker;
  private done?: Promise<void>;

  constructor(
    private readonly ctx: StudioContext,
    private readonly opts: DebugSessionManagerOptions = {},
  ) {}

  get current(): DebugSession | undefined {
    return this.session;
  }

  get active(): DebugSession | undefined {
    return this.session?.state === 'running' ? this.session : undefined;
  }

  /** The running session, or 404/409 style errors. */
  require(): DebugSession {
    if (!this.session) throw new HttpError(404, 'No debug session');
    return this.session;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const s = this.session;
    if (!s) return;
    const masked = s.controller.maskDeep(this.masker ? this.masker.maskDeep(data) : data);
    const e: StudioEvent = { seq: s.events.length + 1, type, data: masked };
    s.events.push(e);
    if (s.events.length > 5000) s.events.splice(0, s.events.length - 5000);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener never breaks the session
      }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Start a debug run of one journey in the background. */
  async start(req: DebugStartRequest): Promise<DebugSession> {
    if (this.active) throw new HttpError(409, `A debug session is already running (${this.active.id})`);
    if (typeof req.journey !== 'string' || !req.journey) throw new HttpError(400, '"journey" must be a journey id');
    const overrides: Record<string, unknown> = { concurrency: 1, retries: 0 };
    if (req.browser !== undefined) {
      if (!['chromium', 'firefox', 'webkit'].includes(req.browser)) throw new HttpError(400, 'browser must be chromium, firefox or webkit');
      overrides.browser = req.browser;
    }
    if (req.headed) overrides.headless = false;
    const loaded = await loadStudioConfig(this.ctx, overrides);
    const { journeys, errors } = await loadJourneys(defaultJourneyPaths(loaded.config, this.ctx.cwd), this.ctx.cwd, { bdd: bddOptionsFrom(loaded.config) });
    const journey = journeys.find((j) => j.id === req.journey);
    if (!journey) {
      const err = errors.length ? ` (some journeys do not parse: ${errors.map((e) => e.file).join(', ')})` : '';
      throw new HttpError(404, `No journey with id "${req.journey}"${err}`);
    }
    const controller = new DebugController({
      breakpoints: req.breakpoints,
      pauseOnFailure: req.pauseOnFailure ?? true,
      pauseAtStart: req.pauseAtStart ?? true,
      masker: loaded.masker,
    });
    for (const s of journey.steps) {
      if (s.value !== undefined && !s.value.includes('${') && SENSITIVE_DESC.test(s.target?.description ?? '')) controller.learnSecret(s.value);
    }
    const id = `debug-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
    const abort = new AbortController();
    const session: DebugSession = { id, journeyId: journey.id, state: 'running', startedAt: new Date().toISOString(), controller, events: [], abort };
    this.session = session;
    this.masker = loaded.masker;
    this.emit('queued', { sessionId: id, journey: { id: journey.id, name: journey.name, steps: journey.steps.map((s) => ({ id: s.id, intent: s.intent })) } });
    const events = new EventBus();
    events.on((e: EzEvent) => this.emit(e.type, { ...e } as Record<string, unknown>));
    this.offPage = controller.onPage((page) => void this.followPage(page));

    this.done = (async () => {
      try {
        const engine = await createEngine(loaded, {
          cwd: this.ctx.cwd,
          addons: this.ctx.addons as never,
          logger: createMaskedLogger('error', loaded.masker),
          runOptions: {
            events,
            runId: id,
            debug: controller,
            // Stop cancels the run; teardown and cleanup hooks still run.
            signal: abort.signal,
            teardownOnCancel: true,
            screenshots: 'on-failure',
            ...(req.timeTravel === false ? {} : { timeTravel: { ...loaded.config.trace.timeTravel, enabled: true, masker: loaded.masker } }),
            ...this.opts.runOptions,
          },
        });
        try {
          const result = await engine.run([journey]);
          session.result = { runId: result.runId, summary: result.summary, status: result.journeys[0]?.status, steps: result.journeys[0]?.steps.map((s) => ({ stepId: s.stepId, status: s.status })) };
        } finally {
          await engine.close();
        }
        session.state = session.stopRequested ? 'stopped' : 'done';
        this.emit('done', { sessionId: id, state: session.state, ...session.result });
      } catch (e) {
        session.state = 'error';
        this.emit('session-error', { message: (e as Error).message });
        this.emit('done', { sessionId: id, state: 'error' });
      } finally {
        this.offPage?.();
        await this.stopCast();
      }
    })();
    return session;
  }

  /**
   * Stop the debug run: the paused (or next) step and the rest of the journey are not executed; teardown and
   * cleanup hooks still run. The session ends as "stopped".
   */
  async stop(): Promise<void> {
    const s = this.active;
    if (!s) return;
    s.stopRequested = true;
    this.emit('stopping', { sessionId: s.id });
    // Release the pause with "abort" first: cancelling first would release it with "continue" (the run disarms
    // the debugger on abort) and the paused step would run.
    s.controller.abort();
    s.abort.abort();
    await this.done;
  }

  /** Wait for the current session to end. */
  async settle(): Promise<void> {
    await this.done;
  }

  // ------------------------------------------------------------ live view

  /** Receive live-view frames; the screencast runs while anyone listens. */
  subscribeFrames(l: FrameListener): () => void {
    this.frameListeners.add(l);
    if (this.frameListeners.size === 1) void this.followPage(this.session?.controller.page);
    return () => {
      this.frameListeners.delete(l);
      if (!this.frameListeners.size) void this.stopCast();
    };
  }

  private async followPage(page: Page | undefined): Promise<void> {
    await this.stopCast();
    if (!page || !this.frameListeners.size) return;
    const cast = new Screencast(page, {
      maxFps: this.opts.maxFps ?? 8,
      quality: 60,
      onFrame: (f) => {
        let taken = false;
        for (const l of this.frameListeners) {
          try {
            if (l(f) !== false) taken = true;
          } catch {
            // ignore
          }
        }
        return taken;
      },
    });
    this.cast = cast;
    await cast.start().catch(() => undefined);
  }

  private async stopCast(): Promise<void> {
    const c = this.cast;
    this.cast = undefined;
    await c?.stop().catch(() => undefined);
  }

  /** Stop everything (Studio shutdown). */
  async close(): Promise<void> {
    this.frameListeners.clear();
    await this.stop().catch(() => undefined);
    await this.stopCast();
  }
}
