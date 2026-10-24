/**
 * The local file backend of the shared store (the default): `.eztest/store`.
 *
 *   <dir>/<namespace>/values.json            every key of the namespace
 *   <dir>/<namespace>/pools/<pool>.json      the items of one data pool
 *
 * Every change is a read-modify-write under an exclusive lock file (O_EXCL
 * create, stale locks of crashed processes are broken after 30 s) and is
 * written to a temporary file that is renamed over the old one, so parallel
 * workers, parallel processes and machines that share the directory never
 * lose a write or claim the same pool item twice.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EzTestError, sleep } from '../core/index.js';
import { isExpired, type NewPoolItem, type PoolItem, type PoolSummary, type StoreBackend, type StoredEntry } from './types.js';

const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

/** Run `fn` holding an exclusive lock on `file` (cross-process). */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let delay = 5;
  for (;;) {
    try {
      const h = await open(lock, 'wx');
      await h.writeFile(`${hostname()}:${process.pid}:${Date.now()}`);
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) {
          await unlink(lock).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (Date.now() > deadline) throw new EzTestError(`Shared store: could not lock ${file} within ${LOCK_WAIT_MS / 1000} s (remove ${lock} if no EZTest process is running)`, 'STORE_LOCK');
      await sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(100, delay * 2);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

async function readJson<T>(file: string, empty: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw new EzTestError(`Shared store file ${file} is not valid JSON: ${(e as Error).message}`, 'STORE_CORRUPT');
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

/** A file-system-safe, collision-free name for a key or pool. */
export function safeFileName(name: string): string {
  const plain = name.replace(/[^\w.-]/g, '_').slice(0, 80);
  return plain === name ? name : `${plain}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

/** A stable item id for a value (adding the same value twice while it is pooled is a no-op). */
export function itemIdFor(item: NewPoolItem): string {
  return item.id ?? createHash('sha256').update(JSON.stringify(item.value ?? item.sealed ?? null)).digest('hex').slice(0, 16);
}

interface ValuesFile { version: 1; entries: Record<string, StoredEntry> }
interface PoolFile { version: 1; pool: string; namespace: string; items: PoolItem[] }

const available = (i: PoolItem, now: number) => !i.claim || i.claim.expiresAt <= now;

export class FileStoreBackend implements StoreBackend {
  readonly name = 'file';
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  get description(): string {
    return this.dir;
  }

  private valuesFile(ns: string): string {
    return join(this.dir, safeFileName(ns), 'values.json');
  }

  private poolFile(ns: string, pool: string): string {
    return join(this.dir, safeFileName(ns), 'pools', `${safeFileName(pool)}.json`);
  }

  private async values(ns: string): Promise<ValuesFile> {
    return readJson<ValuesFile>(this.valuesFile(ns), { version: 1, entries: {} });
  }

  async put(e: StoredEntry): Promise<void> {
    const file = this.valuesFile(e.namespace);
    await withFileLock(file, async () => {
      const v = await this.values(e.namespace);
      const prev = v.entries[e.key];
      v.entries[e.key] = { ...e, createdAt: prev && !isExpired(prev) ? prev.createdAt : e.createdAt };
      await writeJsonAtomic(file, v);
    });
  }

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    return (await this.values(ns)).entries[key];
  }

  async delete(ns: string, key: string): Promise<boolean> {
    const file = this.valuesFile(ns);
    if (!existsSync(file)) return false;
    return withFileLock(file, async () => {
      const v = await this.values(ns);
      if (!(key in v.entries)) return false;
      delete v.entries[key];
      await writeJsonAtomic(file, v);
      return true;
    });
  }

  private async namespaces(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const out: string[] = [];
    for (const d of await readdir(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const v = await readJson<ValuesFile>(join(this.dir, d.name, 'values.json'), { version: 1, entries: {} });
      const first = Object.values(v.entries)[0];
      if (first) out.push(first.namespace);
      else {
        const pools = join(this.dir, d.name, 'pools');
        const files = existsSync(pools) ? (await readdir(pools)).filter((f) => f.endsWith('.json')) : [];
        const p = files[0] ? await readJson<PoolFile | undefined>(join(pools, files[0]), undefined) : undefined;
        out.push(p?.namespace ?? d.name);
      }
    }
    return [...new Set(out)].sort();
  }

  async list(ns?: string): Promise<StoredEntry[]> {
    const spaces = ns ? [ns] : await this.namespaces();
    const out: StoredEntry[] = [];
    for (const s of spaces) out.push(...Object.values((await this.values(s)).entries));
    return out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
  }

  async purgeExpired(ns?: string): Promise<number> {
    let n = 0;
    for (const s of ns ? [ns] : await this.namespaces()) {
      const file = this.valuesFile(s);
      if (!existsSync(file)) continue;
      n += await withFileLock(file, async () => {
        const v = await this.values(s);
        const gone = Object.values(v.entries).filter((e) => isExpired(e));
        for (const e of gone) delete v.entries[e.key];
        if (gone.length) await writeJsonAtomic(file, v);
        return gone.length;
      });
    }
    return n;
  }

  private async changePool<T>(ns: string, pool: string, fn: (p: PoolFile) => { result: T; changed: boolean }): Promise<T> {
    const file = this.poolFile(ns, pool);
    return withFileLock(file, async () => {
      const p = await readJson<PoolFile>(file, { version: 1, pool, namespace: ns, items: [] });
      const { result, changed } = fn(p);
      if (changed) await writeJsonAtomic(file, p);
      return result;
    });
  }

  async poolAdd(ns: string, pool: string, items: NewPoolItem[], by: string): Promise<{ added: number; skipped: number }> {
    const at = new Date().toISOString();
    return this.changePool(ns, pool, (p) => {
      let added = 0;
      for (const it of items) {
        const id = itemIdFor(it);
        if (p.items.some((x) => x.id === id)) continue;
        p.items.push({ id, ...(it.secret ? { sealed: it.sealed, secret: true } : { value: it.value }), addedAt: at, addedBy: by });
        added++;
      }
      return { result: { added, skipped: items.length - added }, changed: added > 0 };
    });
  }

  async poolClaim(ns: string, pool: string, owner: string, leaseMs: number): Promise<PoolItem | undefined> {
    const now = Date.now();
    return this.changePool(ns, pool, (p) => {
      const it = p.items.find((i) => available(i, now));
      if (!it) return { result: undefined, changed: false };
      it.claim = { owner, at: new Date(now).toISOString(), expiresAt: now + leaseMs };
      return { result: { ...it }, changed: true };
    });
  }

  async poolRelease(ns: string, pool: string, id: string, owner: string): Promise<boolean> {
    return this.changePool(ns, pool, (p) => {
      const it = p.items.find((i) => i.id === id && i.claim?.owner === owner);
      if (!it) return { result: false, changed: false };
      delete it.claim;
      return { result: true, changed: true };
    });
  }

  async poolConsume(ns: string, pool: string, id: string, owner: string): Promise<boolean> {
    return this.changePool(ns, pool, (p) => {
      const i = p.items.findIndex((x) => x.id === id && x.claim?.owner === owner);
      if (i < 0) return { result: false, changed: false };
      p.items.splice(i, 1);
      return { result: true, changed: true };
    });
  }

  async poolRemove(ns: string, pool: string, id: string): Promise<boolean> {
    return this.changePool(ns, pool, (p) => {
      const i = p.items.findIndex((x) => x.id === id);
      if (i < 0) return { result: false, changed: false };
      p.items.splice(i, 1);
      return { result: true, changed: true };
    });
  }

  async poolItems(ns: string, pool: string): Promise<PoolItem[]> {
    return (await readJson<PoolFile>(this.poolFile(ns, pool), { version: 1, pool, namespace: ns, items: [] })).items;
  }

  async pools(ns?: string): Promise<PoolSummary[]> {
    const out: PoolSummary[] = [];
    const now = Date.now();
    for (const s of ns ? [ns] : await this.namespaces()) {
      const dir = join(this.dir, safeFileName(s), 'pools');
      if (!existsSync(dir)) continue;
      for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json')).sort()) {
        const p = await readJson<PoolFile | undefined>(join(dir, f), undefined);
        if (!p) continue;
        const avail = p.items.filter((i) => available(i, now)).length;
        out.push({ namespace: p.namespace, pool: p.pool, available: avail, claimed: p.items.length - avail, total: p.items.length });
      }
    }
    return out;
  }
}
