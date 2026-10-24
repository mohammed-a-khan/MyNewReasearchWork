/**
 * Recording from the Studio: one recording at a time; recorded lines are
 * streamed to SSE listeners; stop returns the `.ez` script for saving.
 */
import { stringify as toYaml } from 'yaml';
import { startRecording, type Recorder, type RecordingResult } from '../recorder/index.js';
import { HttpError } from './http.js';
import type { EventHub, StudioEvent } from './events.js';

type Listener = (e: StudioEvent) => void;

/**
 * Why a visible (headed) browser cannot open here, or undefined: Linux and other X11/Wayland systems without
 * DISPLAY or WAYLAND_DISPLAY (a container, CI, an SSH session). Recording then needs `--record-headless`.
 */
export function noDisplayHint(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32' || platform === 'darwin') return undefined;
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return undefined;
  return 'No display found (DISPLAY and WAYLAND_DISPLAY are not set), so the recorder cannot open a visible browser here. Start the Studio with "eztest studio --record-headless" to record without a window, or run it where a display is available.';
}

export interface RecordStartRequest {
  url: string;
  name?: string;
  tags?: string[];
  headless?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
}

export interface RecordingSession {
  id: string;
  url: string;
  state: 'recording' | 'stopped';
  events: StudioEvent[];
  listeners: Set<Listener>;
  result?: { ez: string; yaml: string; steps: number; warnings: string[]; variables: string[]; suggestedPath: string };
}

export class RecordManager {
  private session?: RecordingSession;
  private recorder?: Recorder;
  private counter = 0;

  constructor(
    private readonly defaults: { headless?: boolean; project?: () => Promise<{ baseUrl?: string }>; env?: Record<string, string | undefined> } = {},
    private readonly hub?: EventHub,
  ) {}

  get current(): RecordingSession | undefined {
    return this.session;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const s = this.session;
    if (!s) return;
    const e: StudioEvent = { seq: s.events.length + 1, type, data };
    s.events.push(e);
    this.hub?.publish('recorder', { ...data, type, id: s.id });
    for (const l of s.listeners) {
      try {
        l(e);
      } catch {
        // ignore
      }
    }
  }

  subscribe(l: Listener): () => void {
    const s = this.session;
    if (!s) throw new HttpError(404, 'No recording');
    s.listeners.add(l);
    return () => s.listeners.delete(l);
  }

  async start(req: RecordStartRequest): Promise<RecordingSession> {
    if (this.session?.state === 'recording') throw new HttpError(409, 'A recording is already in progress');
    let u: URL;
    try {
      u = new URL(String(req.url));
    } catch {
      throw new HttpError(400, 'Enter an absolute http(s) URL to start recording, e.g. http://localhost:3000/login');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http and https URLs can be recorded');
    const tags = Array.isArray(req.tags) ? req.tags.map((t) => String(t).replace(/^@/, '')).filter(Boolean) : undefined;
    const session: RecordingSession = { id: `rec-${++this.counter}`, url: u.toString(), state: 'recording', events: [], listeners: new Set() };
    const previous = this.session;
    const headless = req.headless ?? this.defaults.headless ?? false;
    const hint = headless ? undefined : noDisplayHint(this.defaults.env);
    this.session = session;
    try {
      this.recorder = await startRecording({
        url: u.toString(),
        headless,
        project: await this.defaults.project?.().catch(() => ({})),
        browser: req.browser,
        name: req.name ? String(req.name) : undefined,
        tags,
        onStep: (line) => this.emit('line', { line }),
      });
    } catch (e) {
      this.session = previous;
      throw new HttpError(500, `Could not start recording: ${(e as Error).message.split('\n')[0]}${hint ? `. ${hint}` : ''}`);
    }
    // The user closing the browser window finishes the recording.
    this.recorder.page.once('close', () => {
      if (this.session === session && session.state === 'recording') void this.stop().catch(() => undefined);
    });
    this.emit('started', { url: session.url });
    return session;
  }

  /** Expectation typed in the Studio, added to the last recorded step. */
  expect(text: string): void {
    if (!this.recorder || this.session?.state !== 'recording') throw new HttpError(409, 'No recording in progress');
    try {
      this.recorder.addExpectation(String(text));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    // The recorder reports the attached expectation itself (onStep -> a "line" event); emitting it here too showed it twice.
  }

  async stop(): Promise<RecordingSession> {
    const s = this.session;
    if (!s || !this.recorder) throw new HttpError(409, 'No recording in progress');
    if (s.state === 'stopped') return s;
    const r: RecordingResult = await this.recorder.stop();
    s.state = 'stopped';
    const slug = r.journey.id.replace(/[^\w-]+/g, '-').slice(0, 60) || 'recorded';
    s.result = {
      ez: r.ez,
      yaml: toYaml(r.journey),
      steps: r.journey.steps.length,
      warnings: r.warnings,
      variables: r.variables,
      suggestedPath: r.ez ? `${slug}.ez` : `${slug}.yaml`,
    };
    this.emit('stopped', s.result);
    this.recorder = undefined;
    return s;
  }

  async close(): Promise<void> {
    if (this.recorder) await this.recorder.stop().catch(() => undefined);
  }
}
