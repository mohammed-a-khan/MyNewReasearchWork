/**
 * EZTest's temporary directories (browser profiles, download folders) and
 * their cleanup.
 *
 * - Every directory is created as `<tmp>/eztest-<kind>-<pid>-XXXXXX`, so the
 *   process that owns it can be told from its name.
 * - The directories of the running process are tracked; they are removed on
 *   `close()`, on normal exit, and on SIGINT / SIGTERM / SIGHUP (see
 *   launch.ts, `handleSIG*` launch options).
 * - A process killed outright (SIGKILL, power loss) cannot clean up, so the
 *   next launch sweeps directories older than a few hours whose owning
 *   process is gone ({@link sweepStaleTempDirs}).
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugLog } from '../debug.js';

export type TempDirKind = 'profile' | 'downloads' | 'firefox-profile';

/** Name prefixes of the directories EZTest creates (and may sweep). */
export const TEMP_DIR_PREFIXES: readonly string[] = ['eztest-profile-', 'eztest-downloads-', 'eztest-firefox-profile-'];

const tracked = new Set<string>();

/** Create a tracked temporary directory `<tmp>/eztest-<kind>-<pid>-XXXXXX`. */
export function makeTempDir(kind: TempDirKind, root = tmpdir()): string {
  const dir = mkdtempSync(join(root, `eztest-${kind}-${process.pid}-`));
  tracked.add(dir);
  return dir;
}

/** Track a directory for removal at exit or on a signal; returns the untrack function. */
export function trackTempDir(dir: string): () => void {
  tracked.add(dir);
  return () => tracked.delete(dir);
}

/** Stop tracking a directory (it was removed, or handed to the user). */
export function untrackTempDir(dir: string): void {
  tracked.delete(dir);
}

/** The directories this process would remove at exit. */
export function trackedTempDirs(): string[] {
  return [...tracked];
}

/** Remove every tracked directory now (synchronously: usable from 'exit' and signal handlers). */
export function removeTrackedTempDirsSync(): void {
  for (const dir of tracked) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort: the sweep of a later run removes it */
    }
    tracked.delete(dir);
  }
}

/** The pid in an EZTest temp dir name (`eztest-profile-1234-abcdef`), or undefined for older names without one. */
export function ownerPidOf(name: string): number | undefined {
  for (const p of TEMP_DIR_PREFIXES) {
    if (!name.startsWith(p)) continue;
    const m = /^(\d+)-[^-]+$/.exec(name.slice(p.length));
    return m ? Number(m[1]) : undefined;
  }
  return undefined;
}

/** Is a process with this pid running? (EPERM means it runs under another user.) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepOptions {
  /** Directory to sweep. Default os.tmpdir(). */
  root?: string;
  /** Only directories last modified longer ago than this. Default EZTEST_TEMP_SWEEP_HOURS hours, else 6 hours. */
  maxAgeMs?: number;
  now?: number;
  /** Liveness check (tests). */
  isAlive?: (pid: number) => boolean;
}

/**
 * Remove stale EZTest temp directories: older than `maxAgeMs` AND whose owning
 * process is not running (directories with no pid in their name, from older
 * EZTest versions, count as unowned). Directories of live processes are never
 * touched. Returns the removed paths. EZTEST_TEMP_SWEEP=0 turns the sweep off.
 */
export function sweepStaleTempDirs(o: SweepOptions = {}): string[] {
  if (process.env.EZTEST_TEMP_SWEEP === '0') return [];
  const root = o.root ?? tmpdir();
  const hours = Number(process.env.EZTEST_TEMP_SWEEP_HOURS);
  const maxAgeMs = o.maxAgeMs ?? (Number.isFinite(hours) && hours >= 0 && process.env.EZTEST_TEMP_SWEEP_HOURS !== '' ? hours * 3_600_000 : 6 * 3_600_000);
  const now = o.now ?? Date.now();
  const alive = o.isAlive ?? pidAlive;
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!TEMP_DIR_PREFIXES.some((p) => name.startsWith(p))) continue;
    const dir = join(root, name);
    if (tracked.has(dir)) continue;
    const pid = ownerPidOf(name);
    if (pid !== undefined && (pid === process.pid || alive(pid))) continue;
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue; // another user's
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* in use or not ours to remove */
    }
  }
  if (removed.length) debugLog('browser', `removed ${removed.length} stale temp dir(s): ${removed.join(', ')}`);
  return removed;
}

let swept = false;
/** Sweep once per process (called by the first launch). */
export function sweepStaleTempDirsOnce(): void {
  if (swept) return;
  swept = true;
  try {
    sweepStaleTempDirs();
  } catch {
    /* never fail a launch over housekeeping */
  }
}
