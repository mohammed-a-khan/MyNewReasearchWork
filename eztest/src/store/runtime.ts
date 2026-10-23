/**
 * The shared test data runtime: what `Save ... to the shared store`, `Load
 * ...`, `Delete ...`, data pools and the SDK's `store.*` do, on top of a
 * backend (local files or the results server).
 *
 * - Values carry a namespace (default: the environment), an optional expiry
 *   and flags: `secret` (sealed with the store key, masked everywhere) and
 *   `pipeline` (exported to CI output variables and `store-export.json`).
 * - `Load` looks in the backend; a key this run did not write is looked up
 *   in the pipeline import (EZTEST_STORE_IMPORT) first and in
 *   EZTEST_STORE_<KEY> last, so a later pipeline stage can receive values on
 *   an agent that shares nothing with the stage that saved them.
 * - Pool items are claimed for the journey attempt that took them: consumed
 *   when it passes, released when it fails (unless `releaseOnFailure: false`
 *   or the step says "and keep it"), and free again when a crashed run's
 *   claim expires.
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EzTestError, interpolate, silentLogger, type Journey, type JourneyResult, type Logger, type Step } from '../core/index.js';
import { MASK } from '../config/masker.js';
import type { ActionOutcome } from '../runner/actions.js';
import { loadSourceRows } from '../runner/examples-source.js';
import type { StepContext } from '../runner/types.js';
import { StoreCipher, isSealed, storeKeyFrom } from './cipher.js';
import { itemIdFor } from './file.js';
import { formatOutputs } from './pipeline.js';
import {
  checkKey, checkNamespace, envVariableName, isExpired, ttlText, variableName,
  type NewPoolItem, type StoreBackend, type StoreExport, type StoredEntry, type StoreStepRuntime,
} from './types.js';

export interface PoolSettings {
  /** Seed the pool from this data file (csv, xlsx, json) the first time it is used; each row becomes an item. */
  from?: string;
  sheet?: string;
  /** Use this column's value as the item instead of the whole row. */
  column?: string;
  namespace?: string;
  /** Release a claimed item when its journey fails (default: the store's setting, true). */
  releaseOnFailure?: boolean;
  /** How long a claim holds before a crashed run's item is free again. */
  claimTtlMs?: number;
}

export interface SharedStoreOptions {
  backend: StoreBackend;
  /** Default namespace (the environment, e.g. "sit"). */
  namespace?: string;
  /** Key for secret values (default EZTEST_STORE_KEY, then EZTEST_MASTER_KEY). */
  key?: string;
  /** Expiry of values saved without "for <duration>" (default: never). */
  defaultTtlMs?: number;
  /** Claim lease (default 30 minutes). */
  claimTtlMs?: number;
  releaseOnFailure?: boolean;
  pools?: Record<string, PoolSettings>;
  /** Pipeline exports to read values from (default EZTEST_STORE_IMPORT, path-list separated). */
  importFiles?: string[];
  env?: Record<string, string | undefined>;
  /** Register a secret with the run's masker. */
  addSecret?: (v: string) => void;
  baseDir?: string;
  logger?: Logger;
}

export interface SaveOptions {
  namespace?: string;
  ttlMs?: number;
  pipeline?: boolean;
  secret?: boolean;
  by?: string;
  source?: StoredEntry['source'];
}

export interface LoadResult {
  value: unknown;
  from: 'store' | 'import' | 'environment' | 'default';
  entry?: StoredEntry;
}

interface Claim { namespace: string; pool: string; id: string; owner: string; keep: boolean }

const RESERVED = '__eztest';

const toText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** `${name}` alone keeps the variable's type (an object stays an object); anything else is interpolated text. */
export function resolveStoreValue(expr: string, vars: Record<string, unknown>): unknown {
  const m = /^\$\{([A-Za-z_][\w.]*)\}$/.exec(expr.trim());
  if (m) {
    let cur: unknown = vars;
    for (const part of m[1].split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    if (cur === undefined) throw new EzTestError(`\${${m[1]}} is not set, so there is nothing to save`, 'UNKNOWN_VARIABLE');
    return cur;
  }
  return interpolate(expr, vars, { strict: true });
}

function readImports(files: string[]): Map<string, StoreExport['entries'][number]> {
  const out = new Map<string, StoreExport['entries'][number]>();
  for (const f of files) {
    if (!existsSync(f)) throw new EzTestError(`EZTEST_STORE_IMPORT: ${f} does not exist (download the previous stage's store-export.json artifact first)`, 'STORE_IMPORT');
    let doc: StoreExport;
    try {
      doc = JSON.parse(readFileSync(f, 'utf8')) as StoreExport;
    } catch (e) {
      throw new EzTestError(`EZTEST_STORE_IMPORT: ${f} is not valid JSON: ${(e as Error).message}`, 'STORE_IMPORT');
    }
    if (doc.kind !== 'eztest-store-export' || !Array.isArray(doc.entries)) throw new EzTestError(`EZTEST_STORE_IMPORT: ${f} is not an EZTest store export`, 'STORE_IMPORT');
    for (const e of doc.entries) out.set(`${e.namespace}\u0000${e.key}`, e);
  }
  return out;
}

export class SharedStore implements StoreStepRuntime {
  readonly backend: StoreBackend;
  readonly namespace: string;
  private readonly env: Record<string, string | undefined>;
  private readonly secretKey?: string;
  private cipherInstance?: StoreCipher;
  private readonly imports: Map<string, StoreExport['entries'][number]>;
  private readonly written = new Set<string>();
  private readonly claims = new Map<string, Claim[]>();
  private readonly exported = new Map<string, StoreExport['entries'][number]>();
  private readonly seeded = new Map<string, Promise<void>>();
  private readonly logger: Logger;

  constructor(readonly o: SharedStoreOptions) {
    this.backend = o.backend;
    this.namespace = checkNamespace(o.namespace ?? 'default');
    this.env = o.env ?? process.env;
    this.secretKey = storeKeyFrom(o.key, this.env);
    this.logger = o.logger ?? silentLogger;
    const files = o.importFiles ?? (this.env.EZTEST_STORE_IMPORT ? this.env.EZTEST_STORE_IMPORT.split(/[;,]|:(?![\\/])/).map((s) => s.trim()).filter(Boolean) : []);
    this.imports = readImports(files.map((f) => resolve(o.baseDir ?? process.cwd(), f)));
  }

  private cipher(): StoreCipher {
    if (!this.secretKey) throw new EzTestError('Secret shared-store values need a key: set EZTEST_STORE_KEY (or EZTEST_MASTER_KEY), at least 16 characters, on every machine that saves or loads them', 'STORE_KEY_MISSING');
    return (this.cipherInstance ??= new StoreCipher(this.secretKey));
  }

  private secret(v: unknown): void {
    const t = toText(v);
    if (t) this.o.addSecret?.(t);
  }

  private ns(namespace?: string): string {
    return checkNamespace(namespace ?? this.namespace);
  }

  private open(e: { value?: unknown; sealed?: string; secret?: boolean }): unknown {
    if (!e.secret) return e.value;
    if (!isSealed(e.sealed)) throw new EzTestError('A secret shared-store value is not sealed', 'STORE_DECRYPT');
    const v = this.cipher().open(e.sealed);
    this.secret(v);
    return v;
  }

  // ---------------------------------------------------------------- key/value
  async save(key: string, value: unknown, o: SaveOptions = {}): Promise<StoredEntry> {
    checkKey('key', key);
    if (key.startsWith(RESERVED)) throw new EzTestError(`Shared-store keys starting with "${RESERVED}" are reserved`, 'STORE_KEY');
    const namespace = this.ns(o.namespace);
    const ttl = o.ttlMs ?? this.o.defaultTtlMs;
    const now = new Date();
    if (o.secret) this.secret(value);
    const entry: StoredEntry = {
      namespace, key, ...(o.secret ? { sealed: this.cipher().seal(value), secret: true } : { value }),
      ...(o.pipeline ? { pipeline: true } : {}), ...(ttl ? { expiresAt: new Date(now.getTime() + ttl).toISOString() } : {}),
      createdAt: now.toISOString(), updatedAt: now.toISOString(), ...(o.by ? { updatedBy: o.by } : {}), ...(o.source ? { source: o.source } : {}),
    };
    await this.backend.put(entry);
    this.written.add(`${namespace}\u0000${key}`);
    if (o.pipeline) {
      this.exported.set(`${namespace}\u0000${key}`, {
        namespace, key, variable: variableName(key), ...(o.secret ? { sealed: entry.sealed, secret: true } : { value }), ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      });
    }
    return entry;
  }

  async load(key: string, o: { namespace?: string; default?: unknown } = {}): Promise<LoadResult> {
    checkKey('key', key);
    const namespace = this.ns(o.namespace);
    const id = `${namespace}\u0000${key}`;
    const imported = this.written.has(id) ? undefined : this.imports.get(id);
    if (imported && !isExpired(imported)) return { value: this.open(imported), from: 'import' };
    const e = await this.backend.get(namespace, key);
    if (e && !isExpired(e)) return { value: this.open(e), from: 'store', entry: e };
    const envName = envVariableName(key);
    const fromEnv = this.env[envName];
    if (!e && fromEnv !== undefined && fromEnv !== '' && !/^\$\(|^\$\[/.test(fromEnv)) {
      let value: unknown = fromEnv;
      if (/^\s*[[{]/.test(fromEnv)) {
        try {
          value = JSON.parse(fromEnv);
        } catch {
          // keep the text
        }
      }
      if (isSealed(value)) value = this.cipher().open(value);
      return { value, from: 'environment' };
    }
    if (o.default !== undefined) return { value: o.default, from: 'default' };
    const where = `namespace "${namespace}" of the shared store (${this.backend.name}: ${this.backend.description})`;
    if (e) {
      const by = e.source?.journeyId ? ` by journey "${e.source.journeyId}"${e.source.runId ? ` in ${e.source.runId}` : ''}` : e.updatedBy ? ` by ${e.updatedBy}` : '';
      throw new EzTestError(`"${key}" in ${where} expired at ${e.expiresAt} (saved${by} at ${e.updatedAt}). Save it again, or add: or use "<default>"`, 'STORE_EXPIRED');
    }
    throw new EzTestError(`No "${key}" in ${where}. A journey must save it first (Save \${value} to the shared store as "${key}"), or add: or use "<default>"`, 'STORE_MISSING');
  }

  async delete(key: string, o: { namespace?: string } = {}): Promise<boolean> {
    checkKey('key', key);
    const namespace = this.ns(o.namespace);
    this.written.add(`${namespace}\u0000${key}`);
    this.exported.delete(`${namespace}\u0000${key}`);
    return this.backend.delete(namespace, key);
  }

  // ---------------------------------------------------------------- pools
  private settings(pool: string): PoolSettings {
    return this.o.pools?.[pool] ?? {};
  }

  private poolNs(pool: string, namespace?: string): string {
    return this.ns(namespace ?? this.settings(pool).namespace);
  }

  async poolAdd(pool: string, values: unknown[], o: { namespace?: string; secret?: boolean; by?: string } = {}): Promise<{ added: number; skipped: number }> {
    checkKey('pool', pool);
    const items: NewPoolItem[] = values.map((value) => {
      if (o.secret) {
        this.secret(value);
        return { id: itemIdFor({ value }), sealed: this.cipher().seal(value), secret: true };
      }
      return { value };
    });
    return this.backend.poolAdd(this.poolNs(pool, o.namespace), pool, items, o.by ?? `${hostname()}:${process.pid}`);
  }

  /** Seed a pool from a data file once (per file content), however many runs and machines use it. */
  async seed(pool: string, file: string, o: { namespace?: string; sheet?: string; column?: string; secret?: boolean } = {}): Promise<{ added: number; skipped: number; already?: boolean }> {
    const rows = await loadSourceRows({ from: file, ...(o.sheet ? { sheet: o.sheet } : {}) }, { baseDir: this.o.baseDir });
    const values = rows.map((r) => (o.column ? r[o.column] : Object.keys(r).length === 1 ? Object.values(r)[0] : r));
    if (o.column && values.some((v) => v === undefined)) throw new EzTestError(`Pool "${pool}": column "${o.column}" is not in ${file}`, 'BAD_DATA');
    const namespace = this.poolNs(pool, o.namespace);
    const marker = `${RESERVED}.seed.${itemIdFor({ value: [pool, values] })}`;
    if (await this.backend.get(namespace, marker)) return { added: 0, skipped: values.length, already: true };
    const r = await this.poolAdd(pool, values, { namespace, secret: o.secret });
    const now = new Date().toISOString();
    await this.backend.put({ namespace, key: marker, value: { pool, file, rows: values.length }, createdAt: now, updatedAt: now });
    return r;
  }

  private ensureSeeded(pool: string, namespace?: string): Promise<void> {
    const s = this.settings(pool);
    if (!s.from) return Promise.resolve();
    const id = `${this.poolNs(pool, namespace)}\u0000${pool}`;
    let p = this.seeded.get(id);
    if (!p) {
      p = this.seed(pool, s.from, { namespace, sheet: s.sheet, column: s.column }).then(() => undefined);
      this.seeded.set(id, p);
      p.catch(() => this.seeded.delete(id));
    }
    return p;
  }

  async count(pool: string, o: { namespace?: string } = {}): Promise<{ available: number; claimed: number; total: number }> {
    checkKey('pool', pool);
    await this.ensureSeeded(pool, o.namespace);
    const ns = this.poolNs(pool, o.namespace);
    const s = (await this.backend.pools(ns)).find((p) => p.pool === pool);
    return s ? { available: s.available, claimed: s.claimed, total: s.total } : { available: 0, claimed: 0, total: 0 };
  }

  /** Claim one item for `attempt` (a journey attempt key). Throws when the pool has nothing available. */
  async take(pool: string, attempt: string, o: { namespace?: string; keep?: boolean; owner?: string } = {}): Promise<{ id: string; value: unknown; secret?: boolean }> {
    checkKey('pool', pool);
    await this.ensureSeeded(pool, o.namespace);
    const namespace = this.poolNs(pool, o.namespace);
    const owner = o.owner ?? `${attempt}@${hostname()}:${process.pid}`;
    const ttl = this.settings(pool).claimTtlMs ?? this.o.claimTtlMs ?? 30 * 60_000;
    const item = await this.backend.poolClaim(namespace, pool, owner, ttl);
    if (!item) {
      const s = (await this.backend.pools(namespace)).find((p) => p.pool === pool);
      throw new EzTestError(
        s?.total
          ? `Pool "${pool}" (namespace "${namespace}") has no free item: all ${s.total} are claimed by other journeys. Add more items or run fewer journeys on it in parallel`
          : `Pool "${pool}" (namespace "${namespace}") is empty. Add items first (Add \${value} to pool "${pool}"), or seed it from a data file (store.pools.${pool}.from)`,
        'POOL_EMPTY',
      );
    }
    const list = this.claims.get(attempt) ?? [];
    list.push({ namespace, pool, id: item.id, owner, keep: !!o.keep });
    this.claims.set(attempt, list);
    return { id: item.id, value: this.open(item), ...(item.secret ? { secret: true } : {}) };
  }

  /** Settle the claims of an attempt: consumed when it passed, otherwise released (or consumed when so configured). */
  async settle(attempt: string, passed: boolean): Promise<void> {
    const list = this.claims.get(attempt);
    if (!list?.length) return;
    this.claims.delete(attempt);
    for (const c of list) {
      const release = !passed && !c.keep && (this.settings(c.pool).releaseOnFailure ?? this.o.releaseOnFailure ?? true);
      try {
        if (release) await this.backend.poolRelease(c.namespace, c.pool, c.id, c.owner);
        else await this.backend.poolConsume(c.namespace, c.pool, c.id, c.owner);
      } catch (e) {
        this.logger.warn('pool claim not settled (it frees itself when the claim expires)', { pool: c.pool, item: c.id, message: (e as Error).message });
      }
    }
  }

  async journeyEnd(journey: Journey, result: JourneyResult): Promise<void> {
    await this.settle(`${journey.id}#${result.attempt}`, result.status === 'passed' || result.status === 'passed-healed');
  }

  /** Release every claim not settled yet (cancelled runs, journeys that never reached their end). */
  async releaseOutstanding(): Promise<void> {
    for (const k of [...this.claims.keys()]) await this.settle(k, false);
  }

  // ---------------------------------------------------------------- pipeline export
  pipelineExport(o: { runId?: string; pipeline?: string } = {}): StoreExport {
    return { kind: 'eztest-store-export', version: 1, createdAt: new Date().toISOString(), ...(o.runId ? { runId: o.runId } : {}), ...(o.pipeline ? { pipeline: o.pipeline } : {}), entries: [...this.exported.values()] };
  }

  /**
   * Write `store-export.json` (into the run directory and the output directory) and hand the values
   * marked "for the pipeline" to the CI system: Azure Pipelines output variables
   * (`##vso[task.setvariable ...;isOutput=true]`) and GitHub Actions step outputs ($GITHUB_OUTPUT).
   */
  async finish(o: { runDir?: string; outputDir?: string; runId?: string; pipeline?: string; out?: (line: string) => void }): Promise<{ file?: string; entries: number }> {
    const exp = this.pipelineExport(o);
    if (!exp.entries.length) return { entries: 0 };
    const json = JSON.stringify(exp, null, 2);
    const files = [o.runDir && join(o.runDir, 'store-export.json'), o.outputDir && join(o.outputDir, 'store-export.json')].filter((x): x is string => !!x);
    for (const f of files) {
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, json);
    }
    const plain = exp.entries.map((e) => ({ ...e, plain: e.secret ? toText(this.open(e)) : toText(e.value) }));
    const f = formatOutputs(plain, this.env);
    for (const line of f.lines) o.out?.(line);
    if (f.githubOutput && this.env.GITHUB_OUTPUT) await appendFile(this.env.GITHUB_OUTPUT, f.githubOutput);
    return { file: files[files.length - 1], entries: exp.entries.length };
  }

  // ---------------------------------------------------------------- steps
  async perform(step: Step, ctx: StepContext): Promise<ActionOutcome> {
    const a = (step.args ?? {}) as Record<string, unknown>;
    const op = String(a.op ?? '');
    const I = (v: unknown) => (typeof v === 'string' ? ctx.interpolate(v) : v);
    const str = (v: unknown) => (v === undefined ? undefined : String(I(v)));
    const namespace = str(a.namespace);
    const attempt = `${ctx.rootJourneyId ?? ctx.journey.id}#${ctx.attempt}`;
    const shown = (k: string, v: unknown, secret?: boolean) => ({ [k]: secret ? MASK : v });
    switch (op) {
      case 'save': {
        const key = String(I(a.key));
        const value = a.raw ? a.value : resolveStoreValue(String(a.value ?? ''), ctx.vars());
        const e = await this.save(key, value, {
          namespace, ttlMs: a.ttlMs === undefined ? undefined : Number(a.ttlMs), pipeline: a.pipeline === true, secret: a.secret === true,
          by: `${ctx.runId}/${ctx.rootJourneyId ?? ctx.journey.id}`, source: { runId: ctx.runId, journeyId: ctx.rootJourneyId ?? ctx.journey.id, host: hostname() },
        });
        ctx.logger.info('shared store: saved', { key, namespace: e.namespace, expiresAt: e.expiresAt, pipeline: e.pipeline, secret: e.secret });
        return { captured: { stored: { key, namespace: e.namespace, ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}), ...(e.pipeline ? { pipeline: true } : {}), ...(e.secret ? { value: MASK } : {}) } } };
      }
      case 'load': {
        const key = String(I(a.key));
        const r = await this.load(key, { namespace, ...(a.default !== undefined ? { default: I(a.default) } : {}) });
        const as = step.captureAs ?? key;
        ctx.ledger.set(as, r.value);
        const secret = r.entry?.secret || (r.from === 'import' && this.imports.get(`${this.ns(namespace)}\u0000${key}`)?.secret);
        return { captured: { ...shown(as, r.value, !!secret), from: r.from } };
      }
      case 'delete': {
        const key = String(I(a.key));
        return { captured: { deleted: await this.delete(key, { namespace }) } };
      }
      case 'poolAdd': {
        const pool = String(I(a.pool));
        const value = a.raw ? a.value : resolveStoreValue(String(a.value ?? ''), ctx.vars());
        const values = a.each === true && Array.isArray(value) ? value : [value];
        const r = await this.poolAdd(pool, values, { namespace, secret: a.secret === true, by: `${ctx.runId}/${ctx.rootJourneyId ?? ctx.journey.id}` });
        return { captured: { pool, ...r } };
      }
      case 'poolSeed': {
        const pool = String(I(a.pool));
        const r = await this.seed(pool, String(I(a.file)), { namespace, sheet: str(a.sheet), column: str(a.column), secret: a.secret === true });
        return { captured: { pool, ...r } };
      }
      case 'poolTake': {
        const pool = String(I(a.pool));
        const r = await this.take(pool, attempt, { namespace, keep: a.keep === true, owner: `${ctx.runId}:${attempt}@${hostname()}:${process.pid}` });
        const as = step.captureAs ?? 'item';
        ctx.ledger.set(as, r.value);
        return { captured: { ...shown(as, r.value, r.secret), poolItem: r.id } };
      }
      case 'poolCount': {
        const pool = String(I(a.pool));
        const c = await this.count(pool, { namespace });
        const min = a.min === undefined ? undefined : Number(I(a.min));
        const max = a.max === undefined ? undefined : Number(I(a.max));
        if (step.captureAs) ctx.ledger.set(step.captureAs, c.available);
        if (min !== undefined && c.available < min) throw new EzTestError(`Pool "${pool}" has ${c.available} free item(s) (${c.claimed} claimed), expected at least ${min}`, 'POOL_LOW');
        if (max !== undefined && c.available > max) throw new EzTestError(`Pool "${pool}" has ${c.available} free item(s), expected at most ${max}`, 'POOL_HIGH');
        return { captured: { pool, ...c } };
      }
      default:
        throw new EzTestError(`Unknown shared-store operation "${op}"`, 'BAD_STEP');
    }
  }
}

export { ttlText };
