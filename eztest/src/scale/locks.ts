/**
 * Resource locks. A journey declares the shared entities it touches
 * (`Locks: account-123` in .ez, `locks:` in YAML/JSON); two journeys holding a
 * common lock key never run at the same time - not in two workers of one run,
 * and not in two shards on different machines.
 *
 * Backends:
 * - file: atomic lease files (O_EXCL create) in a directory, default
 *   `.eztest/locks`. Works across processes on one machine, and across
 *   machines when the directory is on a shared file system.
 * - server: leases held on the results server (`server.url`), for CI agents
 *   that share nothing but the network.
 *
 * Leases have a TTL and are renewed while held, so a crashed runner never
 * blocks the others for longer than the TTL.
 */
import type { Journey } from '../core/index.js';
import { LeaseRegistry, type Lease } from '../data/index.js';

export interface LockHandle {
  key: string;
  release(): Promise<void>;
  /** Why the lock was lost while held (renewal refused, or not renewed before it expired); undefined while it is held. */
  lost?(): string | undefined;
}

/** Report a lost lock once: a process warning (it reaches the console and CI logs). */
export function reportLostLock(reason: string): void {
  process.emitWarning(reason, 'EZTestLockLost');
}

export interface LockBackend {
  readonly name: string;
  /** Acquire one key now, or return undefined when someone else holds it. */
  tryAcquire(key: string): Promise<LockHandle | undefined>;
  /** Who holds a key (for messages). */
  holder?(key: string): Promise<string | undefined>;
}

export interface FileLockOptions {
  dir: string;
  ttlMs?: number;
  owner?: string;
}

/** Lease files in a directory (see LeaseRegistry), renewed every ttl/3 while held. */
export class FileLockBackend implements LockBackend {
  readonly name = 'file';
  private readonly registry: LeaseRegistry;

  constructor(o: FileLockOptions) {
    this.registry = new LeaseRegistry({ dir: o.dir, ttlMs: o.ttlMs ?? 120_000, owner: o.owner });
  }

  get owner(): string {
    return this.registry.owner;
  }

  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    let lease: Lease | undefined = await this.registry.tryAcquire(`lock:${key}`);
    if (!lease) return undefined;
    let lost: string | undefined;
    let lastRenewed = Date.now();
    let lastError = '';
    const timer = setInterval(() => {
      if (!lease || lost) return;
      void this.registry.renew(lease).then(
        (l) => {
          lease = l;
          lastRenewed = Date.now();
        },
        (e: Error & { code?: string }) => {
          lastError = e.message;
          // Someone else holds the lease file now, or it has not been renewed within its lifetime.
          if (e.code === 'LEASE_LOST' || Date.now() - lastRenewed >= this.registry.ttlMs) {
            lost = `lock "${key}" was lost while held: ${e.code === 'LEASE_LOST' ? 'another holder took the lease over' : `it could not be renewed for ${Date.now() - lastRenewed} ms (${lastError}) and expired`}; another run may be using the resource`;
            clearInterval(timer);
            reportLostLock(lost);
          }
        },
      );
    }, Math.max(1000, Math.floor(this.registry.ttlMs / 3)));
    timer.unref();
    return {
      key,
      lost: () => lost,
      release: async () => {
        clearInterval(timer);
        const l = lease;
        lease = undefined;
        if (l) await this.registry.release(l).catch(() => false);
      },
    };
  }

  async holder(key: string): Promise<string | undefined> {
    return (await this.registry.holder(`lock:${key}`))?.owner;
  }
}

/** Lock keys of a journey with `<column>` and `${var}` filled from its variables (Examples rows included). */
export function resolveLockKeys(journey: Pick<Journey, 'variables'> & { locks?: string[] }): string[] {
  const vars = journey.variables ?? {};
  const keys = (journey.locks ?? []).map((k) =>
    k
      .replace(/<([A-Za-z_][\w -]*)>/g, (w, n: string) => (n in vars ? vars[n] : w))
      .replace(/\$\{\s*([A-Za-z_][\w.]*)\s*\}/g, (w, n: string) => (n in vars ? vars[n] : w))
      .trim(),
  );
  return [...new Set(keys.filter(Boolean))].sort();
}

export interface JourneyLockerOptions {
  backend: LockBackend;
  /** Give up waiting for a journey's locks after this long (default 30 min). */
  timeoutMs?: number;
  /** How often to retry when the locks are held elsewhere (default 250 ms). */
  pollMs?: number;
}

/**
 * The runner-facing lock coordinator: all of a journey's keys or none.
 * Keys are acquired in sorted order (no deadlock between two journeys that
 * need overlapping sets), and keys already held inside this process are
 * checked first, without touching the backend.
 */
export class JourneyLocker {
  private readonly local = new Set<string>();
  readonly timeoutMs: number;
  readonly pollMs: number;

  constructor(readonly o: JourneyLockerOptions) {
    this.timeoutMs = o.timeoutMs ?? 30 * 60_000;
    this.pollMs = o.pollMs ?? 250;
  }

  keys(journey: Journey): string[] {
    return resolveLockKeys(journey as Journey & { locks?: string[] });
  }

  /**
   * Acquire every key, or none. Returns a release function (with `lost()`: the locks lost while
   * held), or undefined when any key is busy.
   */
  async tryAcquire(journey: Journey): Promise<((() => Promise<void>) & { lost?: () => string[] }) | undefined> {
    const keys = this.keys(journey);
    if (!keys.length) return async () => {};
    if (keys.some((k) => this.local.has(k))) return undefined;
    keys.forEach((k) => this.local.add(k));
    const held: LockHandle[] = [];
    try {
      for (const k of keys) {
        const h = await this.o.backend.tryAcquire(k);
        if (!h) {
          await Promise.all(held.map((x) => x.release()));
          keys.forEach((x) => this.local.delete(x));
          return undefined;
        }
        held.push(h);
      }
    } catch (e) {
      await Promise.all(held.map((x) => x.release().catch(() => undefined)));
      keys.forEach((x) => this.local.delete(x));
      throw e;
    }
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await Promise.all(held.map((x) => x.release().catch(() => undefined)));
      keys.forEach((x) => this.local.delete(x));
    };
    return Object.assign(release, { lost: () => held.map((h) => h.lost?.()).filter((x): x is string => !!x) });
  }

  async describeHolders(journey: Journey): Promise<string> {
    const out: string[] = [];
    for (const k of this.keys(journey)) {
      const who = this.local.has(k) ? 'another worker of this run' : await this.o.backend.holder?.(k);
      out.push(`${k}${who ? ` (held by ${who})` : ''}`);
    }
    return out.join(', ');
  }
}
