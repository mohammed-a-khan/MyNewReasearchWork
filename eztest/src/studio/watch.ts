/**
 * Watches the journeys directory so the Studio live-updates when files change
 * on disk (edited in another editor, pulled from git, written by an import).
 *
 * `fs.watch` only says "something changed", and its file names are not
 * reliable across platforms, so every notification triggers a debounced
 * rescan that diffs size and mtime per journey file. When recursive watching
 * is unavailable, or the directory does not exist yet, it polls instead.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { JOURNEY_EXTENSIONS, isSensitive, relPosix } from './security.js';

export interface FileChange {
  type: 'added' | 'changed' | 'removed';
  /** Project-relative POSIX path. */
  path: string;
}

export interface WatcherOptions {
  /** Project root (paths are reported relative to it). */
  cwd: string;
  /** Absolute directory to watch. */
  dir: string;
  onChange(changes: FileChange[]): void;
  /** Absolute paths whose contents are ignored (e.g. the results directory). */
  ignore?: string[];
  debounceMs?: number;
  pollMs?: number;
  /** Force polling (tests, network drives). */
  poll?: boolean;
}

type Snapshot = Map<string, string>;

const MAX_FILES = 20_000;

async function scan(cwd: string, dir: string, ignore: string[]): Promise<Snapshot> {
  const out: Snapshot = new Map();
  const walk = async (abs: string): Promise<void> => {
    if (out.size >= MAX_FILES || ignore.some((i) => abs === i || abs.startsWith(i + '/') || abs.startsWith(i + '\\'))) return;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const p = join(abs, d.name);
      const rel = relPosix(cwd, p);
      if (isSensitive(rel)) continue;
      if (d.isDirectory()) await walk(p);
      else if (d.isFile() && JOURNEY_EXTENSIONS.has(extname(d.name).toLowerCase())) {
        try {
          const s = await stat(p);
          out.set(rel, `${s.size}:${s.mtimeMs}`);
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  await walk(dir);
  return out;
}

function diff(before: Snapshot, after: Snapshot): FileChange[] {
  const changes: FileChange[] = [];
  for (const [p, sig] of after) {
    const old = before.get(p);
    if (old === undefined) changes.push({ type: 'added', path: p });
    else if (old !== sig) changes.push({ type: 'changed', path: p });
  }
  for (const p of before.keys()) if (!after.has(p)) changes.push({ type: 'removed', path: p });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export class JourneyWatcher {
  private snapshot: Snapshot = new Map();
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private scanning = false;
  private again = false;
  private closed = false;
  /** "watch" (native recursive) or "poll". */
  mode: 'watch' | 'poll' = 'poll';

  constructor(private readonly opts: WatcherOptions) {}

  async start(): Promise<this> {
    this.snapshot = await scan(this.opts.cwd, this.opts.dir, this.opts.ignore ?? []);
    this.attach();
    return this;
  }

  private attach(): void {
    if (this.closed) return;
    if (!this.opts.poll) {
      try {
        this.watcher = watch(this.opts.dir, { recursive: true }, () => this.schedule());
        this.watcher.on('error', () => {
          this.watcher?.close();
          this.watcher = undefined;
          this.startPolling();
        });
        this.mode = 'watch';
        return;
      } catch {
        // Missing directory or no recursive watch on this platform: poll.
      }
    }
    this.startPolling();
  }

  private startPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.mode = 'poll';
    this.pollTimer = setInterval(() => {
      void this.rescan().then(() => {
        // Upgrade to native watching once the directory exists.
        if (!this.opts.poll && !this.watcher) {
          try {
            this.watcher = watch(this.opts.dir, { recursive: true }, () => this.schedule());
            this.watcher.on('error', () => undefined);
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
            this.mode = 'watch';
          } catch {
            // keep polling
          }
        }
      });
    }, this.opts.pollMs ?? 1500);
    this.pollTimer.unref?.();
  }

  private schedule(): void {
    if (this.closed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.rescan(), this.opts.debounceMs ?? 120);
  }

  /** Rescan now and report differences (also used by tests). */
  async rescan(): Promise<FileChange[]> {
    if (this.scanning) {
      this.again = true;
      return [];
    }
    this.scanning = true;
    let changes: FileChange[] = [];
    try {
      const next = await scan(this.opts.cwd, this.opts.dir, this.opts.ignore ?? []);
      changes = diff(this.snapshot, next);
      this.snapshot = next;
    } finally {
      this.scanning = false;
    }
    if (changes.length && !this.closed) {
      try {
        this.opts.onChange(changes);
      } catch {
        // listener errors never stop watching
      }
    }
    if (this.again) {
      this.again = false;
      this.schedule();
    }
    return changes;
  }

  files(): string[] {
    return [...this.snapshot.keys()].sort();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.debounce);
    clearInterval(this.pollTimer);
    this.watcher?.close();
  }
}
