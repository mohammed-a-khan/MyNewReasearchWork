/**
 * The Studio's services, shared by every route module as `ctx.app`: project
 * paths and config, the run and record managers, the event hub, the file
 * watcher and the live problems index.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { LoadedConfig } from '../config/index.js';
import { formatOf, listJourneys, validateText, type ValidationIssue } from './authoring.js';
import { extraFeatureDirs } from './bdd.js';
import type { DebugSessionManager } from './debug-session.js';
import { EventHub } from './events.js';
import { RecordManager } from './record.js';
import { RunManager, loadStudioConfig, outputDirOf, type StudioContext } from './runs.js';
import { confineJourneyPath, confinePath, relPosix, requestToken, tokenMatches } from './security.js';
import { JourneyWatcher, type FileChange } from './watch.js';
import { ManualHub } from './manual-hub.js';
import { str } from './http.js';

export interface StudioAppOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  token: string;
  recordHeadless?: boolean;
  /** Watch the journeys directory for changes on disk. Default true. */
  watch?: boolean | { poll?: boolean; pollMs?: number };
}

export class StudioApp {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly ctx: StudioContext;
  readonly hub = new EventHub();
  readonly runs: RunManager;
  readonly recorder: RecordManager;
  /** Manual steps waiting for a tester's verdict (the guided runner answers them). */
  readonly manual: ManualHub;
  watcher?: JourneyWatcher;
  /** Watchers of feature folders outside the journeys folder. */
  private featureWatchers: JourneyWatcher[] = [];
  /** The live debugger's session manager (set by the server). */
  debug?: DebugSessionManager;
  private readonly problemsIndex = new Map<string, ValidationIssue[]>();
  private problemsReady?: Promise<void>;
  private readonly cleanups: Array<() => void | Promise<void>> = [];

  constructor(
    private readonly opts: StudioAppOptions,
    addons: StudioContext['addons'],
  ) {
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.ctx = { cwd: opts.cwd, env: opts.env, addons };
    this.manual = new ManualHub(this.hub);
    this.runs = new RunManager(this.ctx, this.hub, this.manual);
    this.recorder = new RecordManager({ headless: opts.recordHeadless, project: async () => ({ baseUrl: (await this.config()).config.baseUrl }) }, this.hub);
  }

  /** True when the request carries the session token (the cookie counts only for reads). */
  authed(req: IncomingMessage, allowCookie: boolean): boolean {
    return tokenMatches(this.opts.token, requestToken(req, { allowCookie }));
  }

  config(): Promise<LoadedConfig> {
    return loadStudioConfig(this.ctx);
  }

  async journeysDir(): Promise<string> {
    try {
      return (await this.config()).config.journeysDir;
    } catch {
      return 'journeys';
    }
  }

  outputDir(): Promise<string> {
    return outputDirOf(this.ctx);
  }

  /** Resolve a user-supplied journey path (confined, journey extension, not in the results directory). */
  async journeyPath(p: unknown): Promise<string> {
    const out = await this.outputDir();
    return confineJourneyPath(this.cwd, str(p, 'path'), { outputDir: relative(this.cwd, out) || undefined });
  }

  confine(p: string): string {
    return confinePath(this.cwd, p);
  }

  rel(abs: string): string {
    return relPosix(this.cwd, abs);
  }

  /** Register a cleanup that runs when the Studio closes (feature modules use this for their own resources). */
  onClose(fn: () => void | Promise<void>): void {
    this.cleanups.push(fn);
  }

  /** Start the file watcher; changes are published on the `files` and `problems` topics. */
  async startWatching(): Promise<void> {
    if (this.opts.watch === false) return;
    const dir = resolve(this.cwd, await this.journeysDir());
    const extra = typeof this.opts.watch === 'object' ? this.opts.watch : {};
    this.watcher = await new JourneyWatcher({
      cwd: this.cwd,
      dir,
      ignore: [await this.outputDir()],
      onChange: (changes) => void this.filesChanged(changes),
      ...extra,
    }).start();
    for (const d of await extraFeatureDirs(this)) {
      this.featureWatchers.push(await new JourneyWatcher({ cwd: this.cwd, dir: resolve(this.cwd, d), ignore: [await this.outputDir()], onChange: (changes) => void this.filesChanged(changes), ...extra }).start());
    }
  }

  private async filesChanged(changes: FileChange[]): Promise<void> {
    for (const c of changes) this.hub.publish('files', c);
    for (const c of changes) {
      const errors = c.type === 'removed' ? [] : await this.validateFile(c.path);
      if (errors.length) this.problemsIndex.set(c.path, errors);
      else this.problemsIndex.delete(c.path);
      this.hub.publish('problems', { type: 'file', path: c.path, errors });
    }
  }

  private async validateFile(rel: string): Promise<ValidationIssue[]> {
    try {
      const abs = resolve(this.cwd, rel);
      if (!existsSync(abs)) return [];
      return validateText(await readFile(abs, 'utf8'), formatOf(abs)).errors;
    } catch (e) {
      return [{ message: (e as Error).message, suggestions: [] }];
    }
  }

  /** Validation problems of every journey file, kept current by the watcher. */
  async problems(): Promise<Array<{ path: string; errors: ValidationIssue[] }>> {
    this.problemsReady ??= (async () => {
      const dir = await this.journeysDir();
      for (const j of await listJourneys(this.cwd, dir, await extraFeatureDirs(this))) {
        const errors = await this.validateFile(j.path);
        if (errors.length) this.problemsIndex.set(j.path, errors);
      }
    })();
    await this.problemsReady;
    return [...this.problemsIndex.entries()].map(([path, errors]) => ({ path, errors })).sort((a, b) => a.path.localeCompare(b.path));
  }

  async close(): Promise<void> {
    this.watcher?.close();
    for (const w of this.featureWatchers) w.close();
    const cur = this.runs.current;
    if (cur?.state === 'running') this.runs.cancel(cur.id);
    this.manual.close();
    for (const fn of this.cleanups.reverse()) await Promise.resolve(fn()).catch(() => undefined);
    await this.recorder.close();
    this.ctx.addons.off();
  }
}
