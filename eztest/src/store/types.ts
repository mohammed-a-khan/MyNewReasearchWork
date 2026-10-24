/**
 * Shared test data: types shared by the store runtime, its backends (local
 * files, the EZTest results server) and the pipeline export. See
 * docs/shared-data.md.
 */
import type { Journey, JourneyResult, Step } from '../core/index.js';
import type { ActionOutcome } from '../runner/actions.js';
import type { StepContext } from '../runner/types.js';

/** One value in the shared store. Secret values are only ever stored sealed (encrypted). */
export interface StoredEntry {
  namespace: string;
  key: string;
  /** The value (JSON) of a non-secret entry. */
  value?: unknown;
  /** The encrypted value of a secret entry (EZS2:..., older EZS1:...). */
  sealed?: string;
  secret?: boolean;
  /** Also exported to the CI pipeline (output variables and the export artifact). */
  pipeline?: boolean;
  /** ISO time after which the entry is expired (absent: never). */
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Who wrote it: a run and journey, a token or a person (server). */
  updatedBy?: string;
  source?: { runId?: string; journeyId?: string; host?: string };
}

/** One item of a data pool. An item is claimed by one journey at a time and consumed when that journey passes. */
export interface PoolItem {
  id: string;
  value?: unknown;
  sealed?: string;
  secret?: boolean;
  addedAt: string;
  addedBy?: string;
  claim?: { owner: string; at: string; expiresAt: number };
}

export interface PoolSummary {
  namespace: string;
  pool: string;
  /** Items no journey holds (or whose claim expired). */
  available: number;
  claimed: number;
  total: number;
}

export interface NewPoolItem {
  /** Default: a hash of the value, so adding the same value twice while it is in the pool is a no-op. */
  id?: string;
  value?: unknown;
  sealed?: string;
  secret?: boolean;
}

/** Where shared values live. Every operation is atomic across workers, processes and (for the server) machines. */
export interface StoreBackend {
  /** "file" or "server". */
  readonly name: string;
  /** Human description for messages, e.g. ".eztest/store" or "https://eztest.example.com (project payments)". */
  readonly description: string;
  put(e: StoredEntry): Promise<void>;
  /** The entry, also when it is expired (callers report "expired" rather than "missing"). */
  get(namespace: string, key: string): Promise<StoredEntry | undefined>;
  delete(namespace: string, key: string): Promise<boolean>;
  /** Every entry (of one namespace, or all), expired ones included. */
  list(namespace?: string): Promise<StoredEntry[]>;
  /** Remove expired entries; returns how many. */
  purgeExpired(namespace?: string): Promise<number>;
  poolAdd(namespace: string, pool: string, items: NewPoolItem[], by: string): Promise<{ added: number; skipped: number }>;
  /** Atomically claim one available item for `owner` for `leaseMs`; undefined when none is available. */
  poolClaim(namespace: string, pool: string, owner: string, leaseMs: number): Promise<PoolItem | undefined>;
  /** Give a claimed item back to the pool (only its owner can). */
  poolRelease(namespace: string, pool: string, id: string, owner: string): Promise<boolean>;
  /** Remove a claimed item for good (only its owner can). */
  poolConsume(namespace: string, pool: string, id: string, owner: string): Promise<boolean>;
  /** Remove an item regardless of claims (Studio, administration). */
  poolRemove(namespace: string, pool: string, id: string): Promise<boolean>;
  poolItems(namespace: string, pool: string): Promise<PoolItem[]>;
  pools(namespace?: string): Promise<PoolSummary[]>;
  /**
   * Replace a secret item's sealed value when it is still `from` (compare and swap; its claim is kept):
   * re-sealing older EZS1 items with the store's own salt. False when the item is gone or changed.
   */
  poolReseal?(namespace: string, pool: string, id: string, from: string, to: string): Promise<boolean>;
}

/** The runner's entry point for `store` steps (RunOptions.store). */
export interface StoreStepRuntime {
  perform(step: Step, ctx: StepContext): Promise<ActionOutcome>;
  /** Settle the pool claims of a finished journey attempt (consume on pass, release on failure). */
  journeyEnd?(journey: Journey, result: JourneyResult): Promise<void>;
}

/** The artifact `store-export.json`: values marked "for the pipeline", for a later stage (EZTEST_STORE_IMPORT). */
export interface StoreExport {
  kind: 'eztest-store-export';
  version: 1;
  createdAt: string;
  runId?: string;
  pipeline?: string;
  entries: Array<{ namespace: string; key: string; value?: unknown; sealed?: string; secret?: boolean; expiresAt?: string; variable: string }>;
}

export const KEY_RE = /^[A-Za-z0-9_][\w.:@/-]{0,199}$/;
export const NAMESPACE_RE = /^[A-Za-z0-9_][\w.-]{0,99}$/;

export function checkKey(kind: 'key' | 'pool', v: string): string {
  if (!KEY_RE.test(v)) throw new Error(`Invalid shared-store ${kind} "${v.slice(0, 60)}" (letters, digits and _ . : @ / -, at most 200)`);
  return v;
}

export function checkNamespace(v: string): string {
  if (!NAMESPACE_RE.test(v)) throw new Error(`Invalid shared-store namespace "${v.slice(0, 60)}" (letters, digits and _ . -)`);
  return v;
}

export const isExpired = (e: { expiresAt?: string }, now = Date.now()): boolean => !!e.expiresAt && Date.parse(e.expiresAt) <= now;

/** Pipeline variable name for a key: letters, digits and underscores (Azure Pipelines and GitHub Actions both accept these). */
export function variableName(key: string): string {
  const v = key.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(v) ? `_${v}` : v;
}

/** Environment variable a later stage can map an output variable into: EZTEST_STORE_<KEY>. */
export function envVariableName(key: string): string {
  return `EZTEST_STORE_${variableName(key).toUpperCase()}`;
}

/** "2 days", "3h", "90 minutes", "1 week", "30s" -> milliseconds. */
export function parseTtl(v: string | number): number {
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)?\s*$/i.exec(v);
  if (!m) throw new Error(`Invalid duration "${v}" (e.g. 2 days, 12h, 30 minutes)`);
  const n = Number(m[1]);
  const u = (m[2] ?? 'm').toLowerCase();
  const unit = /^ms|^milli/.test(u) ? 1 : /^s/.test(u) ? 1000 : /^m/.test(u) ? 60_000 : /^h/.test(u) ? 3_600_000 : /^d/.test(u) ? 86_400_000 : 604_800_000;
  return Math.round(n * unit);
}

/** 172800000 -> "2 days" (largest exact unit). */
export function ttlText(ms: number): string {
  const units: Array<[number, string]> = [[604_800_000, 'week'], [86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1000, 'second']];
  for (const [u, name] of units) if (ms >= u && ms % u === 0) return `${ms / u} ${name}${ms / u === 1 ? '' : 's'}`;
  return `${ms} ms`;
}
