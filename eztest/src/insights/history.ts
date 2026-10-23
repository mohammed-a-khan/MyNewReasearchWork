/**
 * History store: a JSON file holding per-run journey outcomes. Flaky scoring,
 * triage and readiness read from it. Writes are atomic (tmp file + rename).
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FlakeCause, JourneyStatus, RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';

export interface JourneyOutcome {
  journeyId: string;
  status: JourneyStatus;
  durationMs: number;
  /** Root cause of a pass that needed a retry (see runner flake classifier). */
  flakeCause?: FlakeCause;
  /** Failure signature hash (see failureSignature) for failed journeys. */
  signature?: string;
  attempt: number;
}

export interface RunHistoryEntry {
  runId: string;
  startedAt: string;
  outcomes: JourneyOutcome[];
  /** Git branch the run tested (from the run's environment), for per-branch flaky scores. */
  branch?: string;
  /** Branch the entry was recorded on before `promote` relabelled it (promote-on-merge). */
  promotedFrom?: string;
}

export interface HistoryFile {
  version: 1;
  runs: RunHistoryEntry[];
}

export interface HistoryStoreOptions {
  /** Keep at most this many runs (oldest dropped). Default 200. */
  maxRuns?: number;
}

const STATUSES: ReadonlySet<string> = new Set(['passed', 'passed-healed', 'failed', 'skipped', 'error']);

function validate(data: unknown, path: string): HistoryFile {
  const bad = (why: string) => new EzTestError(`Invalid history file ${path}: ${why}`, 'HISTORY_INVALID');
  if (!data || typeof data !== 'object') throw bad('not an object');
  const d = data as Partial<HistoryFile>;
  if (d.version !== 1) throw bad(`unsupported version ${String(d.version)}`);
  if (!Array.isArray(d.runs)) throw bad('runs is not an array');
  for (const r of d.runs) {
    if (!r || typeof r.runId !== 'string' || typeof r.startedAt !== 'string' || !Array.isArray(r.outcomes)) {
      throw bad('malformed run entry');
    }
    for (const o of r.outcomes) {
      if (typeof o.journeyId !== 'string' || !STATUSES.has(o.status) || typeof o.durationMs !== 'number') {
        throw bad(`malformed outcome in run ${r.runId}`);
      }
    }
  }
  return d as HistoryFile;
}

export class HistoryStore {
  private data: HistoryFile = { version: 1, runs: [] };
  private loaded = false;
  readonly maxRuns: number;

  constructor(
    readonly path: string,
    opts: HistoryStoreOptions = {},
  ) {
    this.maxRuns = opts.maxRuns ?? 200;
    if (this.maxRuns < 1) throw new EzTestError('maxRuns must be >= 1', 'HISTORY_OPTIONS');
  }

  static async open(path: string, opts: HistoryStoreOptions = {}): Promise<HistoryStore> {
    const s = new HistoryStore(path, opts);
    await s.load();
    return s;
  }

  async load(): Promise<void> {
    if (existsSync(this.path)) {
      const text = await readFile(this.path, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new EzTestError(`History file ${this.path} is not valid JSON: ${(e as Error).message}`, 'HISTORY_INVALID');
      }
      this.data = validate(parsed, this.path);
    } else {
      this.data = { version: 1, runs: [] };
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    this.assertLoaded();
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new EzTestError('HistoryStore used before load()', 'HISTORY_NOT_LOADED');
  }

  /**
   * Append a run. `signatures` maps journeyId to a failure signature hash.
   * Recording the same runId twice replaces the earlier entry.
   */
  record(run: RunResult, signatures: Record<string, string> = {}): RunHistoryEntry {
    this.assertLoaded();
    if (run.journeys.length === 0) throw new EzTestError(`Run ${run.runId} has no journeys to record`, 'HISTORY_EMPTY_RUN');
    const branch = run.environment?.gitBranch;
    const entry: RunHistoryEntry = {
      runId: run.runId,
      startedAt: run.startedAt,
      ...(branch ? { branch } : {}),
      outcomes: run.journeys.map((j) => ({
        journeyId: j.journeyId,
        status: j.status,
        durationMs: j.durationMs,
        attempt: j.attempt,
        ...(signatures[j.journeyId] ? { signature: signatures[j.journeyId] } : {}),
        ...(j.reliability?.flake ? { flakeCause: j.reliability.flake.cause } : {}),
      })),
    };
    this.data.runs = this.data.runs.filter((r) => r.runId !== run.runId);
    this.data.runs.push(entry);
    this.data.runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (this.data.runs.length > this.maxRuns) this.data.runs = this.data.runs.slice(-this.maxRuns);
    return entry;
  }

  get runs(): readonly RunHistoryEntry[] {
    this.assertLoaded();
    return this.data.runs;
  }

  /** Branches seen in history (entries without a branch are not listed). */
  branches(): string[] {
    this.assertLoaded();
    return [...new Set(this.data.runs.map((r) => r.branch).filter((b): b is string => !!b))].sort();
  }

  /**
   * A read-only view of the runs of one branch (flaky scores per branch). With
   * `includeUnscoped`, runs recorded without a branch count too.
   */
  forBranch(branch: string, opts: { includeUnscoped?: boolean } = {}): HistoryStore {
    this.assertLoaded();
    const view = new HistoryStore(this.path, { maxRuns: this.maxRuns });
    view.data = { version: 1, runs: this.data.runs.filter((r) => r.branch === branch || (opts.includeUnscoped && !r.branch)) };
    view.loaded = true;
    view.save = async () => {
      throw new EzTestError('A branch view of the history is read-only', 'HISTORY_READONLY');
    };
    return view;
  }

  /** Relabel a merged branch's runs as runs of the target branch (promote-on-merge). Returns the number of runs moved. */
  promote(from: string, to: string): number {
    this.assertLoaded();
    let n = 0;
    for (const r of this.data.runs) {
      if (r.branch !== from) continue;
      r.branch = to;
      r.promotedFrom = from;
      n++;
    }
    return n;
  }

  journeyIds(): string[] {
    this.assertLoaded();
    const ids = new Set<string>();
    for (const r of this.data.runs) for (const o of r.outcomes) ids.add(o.journeyId);
    return [...ids].sort();
  }

  /** Outcomes for a journey, oldest first. When several attempts exist in one run, the last attempt counts. */
  outcomesFor(journeyId: string, limit?: number): Array<JourneyOutcome & { runId: string; startedAt: string }> {
    this.assertLoaded();
    const out: Array<JourneyOutcome & { runId: string; startedAt: string }> = [];
    for (const r of this.data.runs) {
      const mine = r.outcomes.filter((o) => o.journeyId === journeyId);
      if (mine.length === 0) continue;
      const last = mine.reduce((a, b) => (b.attempt >= a.attempt ? b : a));
      out.push({ ...last, runId: r.runId, startedAt: r.startedAt });
    }
    return limit !== undefined ? out.slice(-limit) : out;
  }
}
