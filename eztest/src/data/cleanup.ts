/**
 * Cleanup of created test data.
 *
 * CleanupRegistry: in-process undo actions, run in reverse order; every one is
 * attempted even when some fail.
 *
 * CleanupJournal: a durable record of every created record, written *before*
 * the run moves on (`.eztest/cleanup/<owner>.jsonl`, append-only). When the
 * record is deleted the journal says so. If the process crashes (killed CI
 * job, OOM, Ctrl+C) the journal survives, and the next run's orphan sweep
 * deletes what is left: journals whose owner process is gone (same host), or
 * that are older than a TTL (other hosts). Sweepers claim a journal by an
 * atomic rename, so two runs never sweep the same one.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface CleanupFailure {
  description: string;
  error: string;
}

export interface CleanupReport {
  ok: boolean;
  cleaned: string[];
  failures: CleanupFailure[];
}

export class CleanupRegistry {
  private entries: Array<{ description: string; undo: () => Promise<void> }> = [];

  add(description: string, undo: () => Promise<void>): void {
    this.entries.push({ description, undo });
  }

  get size(): number {
    return this.entries.length;
  }

  pending(): string[] {
    return this.entries.map((e) => e.description);
  }

  async runAll(mask: (s: string) => string = (s) => s): Promise<CleanupReport> {
    const list = this.entries.reverse();
    this.entries = [];
    const cleaned: string[] = [];
    const failures: CleanupFailure[] = [];
    for (const e of list) {
      try {
        await e.undo();
        cleaned.push(e.description);
      } catch (err) {
        failures.push({ description: e.description, error: mask(err instanceof Error ? err.message : String(err)) });
      }
    }
    return { ok: failures.length === 0, cleaned, failures };
  }
}

// ------------------------------------------------------------------ durable journal

export interface JournalEntry {
  id: string;
  provider: string;
  entity: string;
  recordId: string;
  /** The created record (what a provider needs to delete it). */
  record: Record<string, unknown>;
  createdAt: number;
  owner: string;
  host: string;
  pid: number;
}

type JournalLine = ({ op: 'add' } & JournalEntry) | { op: 'done'; id: string; at: number };

export interface CleanupJournalOptions {
  /** Owner label (default host-pid-random). */
  owner?: string;
  now?: () => number;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

export class CleanupJournal {
  readonly owner: string;
  readonly file: string;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private open = 0;

  constructor(readonly dir: string, o: CleanupJournalOptions = {}) {
    this.owner = o.owner ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.file = join(dir, `${safe(this.owner)}.jsonl`);
    this.now = o.now ?? Date.now;
  }

  private append(line: JournalLine): Promise<void> {
    const p = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Record a created record before anything else happens; returns its journal id. */
  async record(e: Omit<JournalEntry, 'id' | 'createdAt' | 'owner' | 'host' | 'pid'>): Promise<string> {
    const id = randomUUID();
    this.open++;
    await this.append({ op: 'add', id, ...e, createdAt: this.now(), owner: this.owner, host: hostname(), pid: process.pid });
    return id;
  }

  /** Mark a record as deleted. When nothing is left the journal file is removed. */
  async done(id: string): Promise<void> {
    await this.append({ op: 'done', id, at: this.now() });
    this.open = Math.max(0, this.open - 1);
    if (this.open === 0) {
      await this.chain;
      if ((await readJournal(this.file)).length === 0) await unlink(this.file).catch(() => undefined);
    }
  }

  /** Entries of this journal that were never marked done. */
  async pending(): Promise<JournalEntry[]> {
    await this.chain;
    return readJournal(this.file);
  }
}

/** Open (not done) entries of a journal file. */
export async function readJournal(file: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const open = new Map<string, JournalEntry>();
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let x: JournalLine;
    try {
      x = JSON.parse(l) as JournalLine;
    } catch {
      continue; // a torn last line from a crash
    }
    if (x.op === 'add') {
      const { op: _op, ...entry } = x;
      open.set(x.id, entry);
    } else if (x.op === 'done') open.delete(x.id);
  }
  return [...open.values()];
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepOptions {
  /** Journals from other hosts (or with no live owner info) are orphans after this age. Default 6 h. */
  staleAfterMs?: number;
  /** Test seam: is this owner still running? Default: same host and the pid is alive. */
  isAlive?: (e: Pick<JournalEntry, 'host' | 'pid' | 'owner'>) => boolean;
  /** Owner label of this sweeper (for the claimed / retry files). */
  owner?: string;
}

export interface SweepReport {
  journals: number;
  removed: Array<{ provider: string; entity: string; recordId: string }>;
  failed: Array<{ provider: string; entity: string; recordId: string; error: string }>;
}

/**
 * Delete what crashed runs left behind. `remove(entry)` deletes one record (return
 * false when no provider can delete it). Entries that could not be removed are kept in a
 * journal owned by this sweeper, so a later run tries again.
 */
export async function sweepOrphans(dir: string, remove: (e: JournalEntry) => Promise<boolean>, o: SweepOptions = {}): Promise<SweepReport> {
  const report: SweepReport = { journals: 0, removed: [], failed: [] };
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return report;
  }
  const staleAfter = o.staleAfterMs ?? 6 * 3600_000;
  const alive = o.isAlive ?? ((e) => e.host === hostname() && processAlive(e.pid));
  const me = safe(o.owner ?? `${hostname()}-${process.pid}-sweep-${randomUUID().slice(0, 6)}`);
  const leftovers: JournalEntry[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const entries = await readJournal(file);
    if (!entries.length) {
      await unlink(file).catch(() => undefined);
      continue;
    }
    const first = entries[0];
    const age = Date.now() - (await stat(file).then((s) => s.mtimeMs).catch(() => Date.now()));
    const orphaned = first.host === hostname() ? !alive(first) : age > staleAfter || !alive(first);
    if (!orphaned) continue;
    // Claim it atomically: only one sweeper wins the rename.
    const claimed = `${file}.claimed-${me}`;
    try {
      await rename(file, claimed);
    } catch {
      continue;
    }
    report.journals++;
    for (const e of entries.reverse()) {
      try {
        if (await remove(e)) report.removed.push({ provider: e.provider, entity: e.entity, recordId: e.recordId });
        else {
          report.failed.push({ provider: e.provider, entity: e.entity, recordId: e.recordId, error: 'no provider can delete it' });
          leftovers.push(e);
        }
      } catch (err) {
        report.failed.push({ provider: e.provider, entity: e.entity, recordId: e.recordId, error: (err as Error).message.split('\n')[0] });
        leftovers.push(e);
      }
    }
    await unlink(claimed).catch(() => undefined);
  }
  if (leftovers.length) {
    await mkdir(dir, { recursive: true });
    const retry = join(dir, `${me}-retry.jsonl`);
    await writeFile(retry, leftovers.map((e) => JSON.stringify({ op: 'add', ...e, owner: me, host: hostname(), pid: process.pid })).join('\n') + '\n', { mode: 0o600 });
  }
  return report;
}
