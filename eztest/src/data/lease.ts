/**
 * File-based lease registry: a record found for one run/worker is leased so
 * parallel journeys (threads, processes, even machines sharing a directory)
 * never use the same record. Acquisition is atomic (O_EXCL create); renewals
 * are atomic (write temp + rename); expired leases can be taken over.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile, mkdir, rmdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';

export interface Lease {
  resource: string;
  owner: string;
  token: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface LeaseRegistryOptions {
  dir: string;
  /** Lease lifetime (default 15 min). */
  ttlMs?: number;
  /** Owner label (default host:pid:random). */
  owner?: string;
  now?: () => number;
}

const STEAL_LOCK_STALE_MS = 10_000;

export class LeaseRegistry {
  readonly dir: string;
  readonly owner: string;
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly held = new Map<string, Lease>();

  constructor(o: LeaseRegistryOptions) {
    this.dir = resolve(o.dir);
    this.ttlMs = o.ttlMs ?? 15 * 60_000;
    if (!(this.ttlMs > 0)) throw new EzTestError('Lease ttlMs must be positive', 'LEASE_CONFIG');
    this.owner = o.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.now = o.now ?? Date.now;
  }

  private fileFor(resource: string): string {
    return join(this.dir, createHash('sha256').update(resource).digest('hex').slice(0, 40) + '.lease');
  }

  /** Leases currently held by this registry instance. */
  heldLeases(): Lease[] {
    return [...this.held.values()];
  }

  private async read(file: string): Promise<Lease | 'unreadable' | undefined> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    try {
      const l = JSON.parse(text) as Lease;
      return typeof l.token === 'string' && typeof l.expiresAt === 'number' ? l : 'unreadable';
    } catch {
      return 'unreadable'; // being written right now, or corrupt
    }
  }

  /** Current lease on a resource, if any and not expired. */
  async holder(resource: string): Promise<Lease | undefined> {
    const l = await this.read(this.fileFor(resource));
    return l && l !== 'unreadable' && l.expiresAt > this.now() ? l : undefined;
  }

  async tryAcquire(resource: string): Promise<Lease | undefined> {
    if (!resource) throw new EzTestError('Lease resource is empty', 'LEASE_CONFIG');
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(resource);
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.now();
      const lease: Lease = { resource, owner: this.owner, token: randomUUID(), acquiredAt: now, expiresAt: now + this.ttlMs };
      try {
        const fh = await open(file, 'wx', 0o600);
        try {
          await fh.writeFile(JSON.stringify(lease));
        } finally {
          await fh.close();
        }
        this.held.set(resource, lease);
        return lease;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (!(await this.takeOverIfExpired(file))) return undefined;
    }
    return undefined;
  }

  /** Remove an expired lease file under a short exclusive steal lock. Returns true if removed. */
  private async takeOverIfExpired(file: string): Promise<boolean> {
    const current = await this.read(file);
    if (current === undefined) return true; // released meanwhile: retry the create
    if (current !== 'unreadable' && current.expiresAt > this.now()) return false;
    if (current === 'unreadable') {
      try {
        const s = await stat(file);
        if (this.now() - s.mtimeMs < this.ttlMs) return false; // probably mid-write
      } catch {
        return true;
      }
    }
    const lock = file + '.steal';
    try {
      await mkdir(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > STEAL_LOCK_STALE_MS) await rmdir(lock).catch(() => undefined);
      } catch {
        /* lock vanished */
      }
      return false;
    }
    try {
      const again = await this.read(file);
      const sameExpired =
        again === undefined ||
        (again === 'unreadable' && current === 'unreadable') ||
        (again !== 'unreadable' && current !== 'unreadable' && again.token === current.token && again.expiresAt <= this.now());
      if (!sameExpired) return false;
      await unlink(file).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      return true;
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }

  /** Extend a lease we hold (atomic write). Throws if it was lost. */
  async renew(lease: Lease): Promise<Lease> {
    const file = this.fileFor(lease.resource);
    const cur = await this.read(file);
    if (!cur || cur === 'unreadable' || cur.token !== lease.token) {
      this.held.delete(lease.resource);
      throw new EzTestError(`Lease on ${lease.resource} was lost`, 'LEASE_LOST');
    }
    const next: Lease = { ...lease, expiresAt: this.now() + this.ttlMs };
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, file);
    this.held.set(lease.resource, next);
    return next;
  }

  /** Release a lease if we still hold it. Returns false when it had already been lost. */
  async release(lease: Lease): Promise<boolean> {
    this.held.delete(lease.resource);
    const file = this.fileFor(lease.resource);
    const cur = await this.read(file);
    if (!cur || cur === 'unreadable' || cur.token !== lease.token) return false;
    try {
      await unlink(file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  async releaseAll(): Promise<number> {
    let n = 0;
    for (const l of [...this.held.values()]) if (await this.release(l)) n++;
    return n;
  }
}
