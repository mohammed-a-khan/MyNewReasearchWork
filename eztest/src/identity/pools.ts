/**
 * Authentication at scale.
 *
 *  - Account pools: N accounts per role, one leased per journey through the
 *    data fabric's lease registry (atomic, cross-process), so parallel workers
 *    never share a user, and two runs on one machine never collide.
 *  - Session pool: each pooled account has its own cached session (the
 *    Identity Vault caches per role; a pooled account is a virtual role
 *    "role#n"). Cached sessions are health-checked before use (verifyUrl) and
 *    refreshed *before* they expire, so they cannot run out mid-journey.
 *  - Lockout protection: repeated login failures for an account (wrong or
 *    rotated password) are counted in `.eztest/lockout.json`; attempts back off
 *    and, at the limit, EZTest stops trying and alerts instead of locking the
 *    account in the identity provider.
 *  - Re-login: the runner calls `relogin` when a session expired mid-journey;
 *    it clears the cached session of the same leased account and signs in again.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Page } from '../browser/index.js';
import { EzTestError, silentLogger, sleep, type Journey, type JourneyResult, type Logger } from '../core/index.js';
import type { LeaseRegistry, Lease } from '../data/lease.js';
import type { RoleDefinition } from './vault.js';
import type { IdentityVault } from './vault.js';

export interface PoolAccount {
  username: string;
  /** Secret reference (secret://...), ENC(...) or a handle-able string. */
  password: string;
  totp?: string;
}

export interface RolePool {
  accounts: PoolAccount[];
  /** How long to wait for a free account (default 60 s). */
  waitSeconds?: number;
}

/** The virtual role name of the n-th pooled account of a role. */
export const pooledRole = (role: string, index: number) => `${role}#${index + 1}`;

/** Role definitions for every pooled account (base role definition with the account's credentials). */
export function expandPoolRoles(roles: Record<string, RoleDefinition>, pools: Record<string, RolePool>): Record<string, RoleDefinition> {
  const out = { ...roles };
  for (const [role, pool] of Object.entries(pools)) {
    const base = roles[role];
    if (!base) throw new EzTestError(`identity.pools.${role}: there is no role "${role}" to pool (define it under identity.roles)`, 'IDENTITY_CONFIG');
    pool.accounts.forEach((a, i) => {
      out[pooledRole(role, i)] = { ...base, username: a.username, password: a.password, ...(a.totp ? { totp: a.totp } : {}) };
    });
  }
  return out;
}

// ------------------------------------------------------------------ account pool

export interface LeasedAccount {
  role: string;
  index: number;
  username: string;
  /** The vault role to sign in as (role#n). */
  vaultRole: string;
  lease: Lease;
}

export class AccountPool {
  private readonly held = new Map<string, LeasedAccount>();

  constructor(private readonly o: { pools: Record<string, RolePool>; leases: LeaseRegistry; environment?: string; pollMs?: number }) {}

  has(role: string): boolean {
    return !!this.o.pools[role]?.accounts.length;
  }

  /** The account a holder (journey attempt) leased for a role, if any. */
  heldBy(holder: string, role: string): LeasedAccount | undefined {
    return this.held.get(`${holder}\0${role}`);
  }

  /**
   * Lease a free account of `role` for `holder`. Accounts are tried starting at a
   * position derived from the holder, so workers spread over the pool; when all are
   * leased it waits (polling) up to waitSeconds, then fails with a clear message.
   */
  async acquire(role: string, holder: string): Promise<LeasedAccount> {
    const mine = this.heldBy(holder, role);
    if (mine) return mine;
    const pool = this.o.pools[role];
    if (!pool?.accounts.length) throw new EzTestError(`Role "${role}" has no account pool`, 'ACCOUNT_POOL');
    const n = pool.accounts.length;
    const start = createHash('sha1').update(holder).digest().readUInt32BE(0) % n;
    const deadline = Date.now() + (pool.waitSeconds ?? 60) * 1000;
    for (;;) {
      for (let k = 0; k < n; k++) {
        const index = (start + k) % n;
        const a = pool.accounts[index];
        const lease = await this.o.leases.tryAcquire(`account:${this.o.environment ?? 'default'}:${role}:${a.username}`);
        if (lease) {
          const got: LeasedAccount = { role, index, username: a.username, vaultRole: pooledRole(role, index), lease };
          this.held.set(`${holder}\0${role}`, got);
          return got;
        }
      }
      if (Date.now() >= deadline) {
        throw new EzTestError(`All ${n} account(s) of role "${role}" are in use by other workers; waited ${pool.waitSeconds ?? 60} s (add accounts to identity.pools.${role} or lower the worker count)`, 'ACCOUNT_POOL_EXHAUSTED');
      }
      await sleep(this.o.pollMs ?? 250);
    }
  }

  /** Release every account a holder leased. */
  async release(holder: string): Promise<number> {
    let n = 0;
    for (const [k, v] of [...this.held]) {
      if (!k.startsWith(`${holder}\0`)) continue;
      this.held.delete(k);
      if (await this.o.leases.release(v.lease)) n++;
    }
    return n;
  }
}

// ------------------------------------------------------------------ lockout protection

interface LockoutEntry {
  failures: number[];
  lastError?: string;
}

interface LockoutFile {
  version: 1;
  accounts: Record<string, LockoutEntry>;
}

export interface LockoutOptions {
  /** Failures within the window that stop further attempts. Default 3. */
  maxFailures?: number;
  windowMs?: number;
  /** First back-off after a failure; doubles with each further failure. Default 2000 ms. */
  backoffMs?: number;
  now?: () => number;
  logger?: Logger;
  /** Called when an account is protected from lockout (e.g. post to a channel). */
  onAlert?: (message: string) => void;
}

export interface LockoutCheck {
  allowed: boolean;
  /** Wait this long before trying (back-off after recent failures). */
  waitMs: number;
  reason?: string;
}

/** Counts login failures per account across runs and processes; atomic file writes. */
export class LockoutGuard {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly backoffMs: number;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string, private readonly o: LockoutOptions = {}) {
    this.maxFailures = o.maxFailures ?? 3;
    this.windowMs = o.windowMs ?? 30 * 60_000;
    this.backoffMs = o.backoffMs ?? 2000;
    this.now = o.now ?? Date.now;
  }

  private async read(): Promise<LockoutFile> {
    if (!existsSync(this.path)) return { version: 1, accounts: {} };
    try {
      const f = JSON.parse(await readFile(this.path, 'utf8')) as LockoutFile;
      return f.version === 1 && f.accounts ? f : { version: 1, accounts: {} };
    } catch {
      return { version: 1, accounts: {} };
    }
  }

  private async write(f: LockoutFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private recent(e: LockoutEntry | undefined): number[] {
    const since = this.now() - this.windowMs;
    return (e?.failures ?? []).filter((t) => t >= since);
  }

  /** May we try to log in as this account now? */
  async check(key: string): Promise<LockoutCheck> {
    const f = await this.read();
    const recent = this.recent(f.accounts[key]);
    if (recent.length >= this.maxFailures) {
      const msg = `login as ${key} failed ${recent.length} times in the last ${Math.round(this.windowMs / 60_000)} min${f.accounts[key]?.lastError ? ` (last: ${f.accounts[key].lastError})` : ''}; EZTest stopped trying so the account is not locked. Check the credentials (password rotated?), then delete its entry in ${this.path}`;
      return { allowed: false, waitMs: 0, reason: msg };
    }
    if (!recent.length) return { allowed: true, waitMs: 0 };
    const wait = this.backoffMs * 2 ** (recent.length - 1) - (this.now() - Math.max(...recent));
    return { allowed: true, waitMs: Math.max(0, wait) };
  }

  async recordFailure(key: string, error: string): Promise<number> {
    return this.serial(async () => {
      const f = await this.read();
      const e = f.accounts[key] ?? { failures: [] };
      e.failures = [...this.recent(e), this.now()];
      e.lastError = error.slice(0, 200);
      f.accounts[key] = e;
      await this.write(f);
      if (e.failures.length >= this.maxFailures) {
        const msg = `ALERT: login as ${key} failed ${e.failures.length} times; further attempts are blocked to protect the account from lockout`;
        (this.o.logger ?? silentLogger).error(msg);
        this.o.onAlert?.(msg);
      }
      return e.failures.length;
    });
  }

  async recordSuccess(key: string): Promise<void> {
    await this.serial(async () => {
      const f = await this.read();
      if (!f.accounts[key]) return;
      delete f.accounts[key];
      await this.write(f);
    });
  }

  /** Forget the failures of an account (after fixing its credentials). */
  async reset(key: string): Promise<void> {
    await this.recordSuccess(key);
  }
}

// ------------------------------------------------------------------ pooled, guarded login

export interface PooledLoginOptions {
  vault: IdentityVault;
  pool?: AccountPool;
  guard?: LockoutGuard;
  /** Session max age (the vault's) and how long before it a session is refreshed. */
  maxAgeMs?: number;
  refreshMarginMs?: number;
  logger?: Logger;
}

interface StepCtxLike {
  runId?: string;
  attempt?: number;
  journey?: { id: string };
}

const holderOf = (ctx: unknown, fallback = 'adhoc'): string => {
  const c = (ctx ?? {}) as StepCtxLike;
  return c.journey ? `${c.runId ?? ''}:${c.journey.id}#${c.attempt ?? 1}` : fallback;
};

const LOGIN_FAILURE_CODES = new Set(['LOGIN_FAILED', 'LOGIN_FIELD']);

export interface PooledLogin {
  login: (page: Page, role: string, ctx: unknown) => Promise<void>;
  /** Clear the session of the same (leased) account and sign in again. */
  relogin: (page: Page, role: string, ctx: unknown) => Promise<void>;
  /** Runner lifecycle hook: release the journey's account and note it on the result. */
  journeyEnd: (journey: Journey, result: JourneyResult) => Promise<void>;
  /** Session health of a role (or pooled account role). */
  sessionHealth: (vaultRole: string) => Promise<{ exists: boolean; ageMs?: number; refreshDue: boolean }>;
}

export function createPooledLogin(o: PooledLoginOptions): PooledLogin {
  const logger = o.logger ?? silentLogger;
  const maxAge = o.maxAgeMs ?? 30 * 60_000;
  const margin = o.refreshMarginMs ?? 5 * 60_000;
  const leasedFor = new Map<string, { role: string; account: string }>();

  const sessionHealth = async (vaultRole: string) => {
    try {
      const s = await stat(o.vault.sessionFile(vaultRole));
      const ageMs = Date.now() - s.mtimeMs;
      return { exists: true, ageMs, refreshDue: ageMs > Math.max(0, maxAge - margin) };
    } catch {
      return { exists: false, refreshDue: false };
    }
  };

  const resolveRole = async (role: string, ctx: unknown): Promise<{ vaultRole: string; username: string }> => {
    if (o.pool?.has(role)) {
      const holder = holderOf(ctx);
      const a = await o.pool.acquire(role, holder);
      leasedFor.set(holder, { role, account: a.username });
      return { vaultRole: a.vaultRole, username: a.username };
    }
    return { vaultRole: role, username: role };
  };

  const signIn = async (page: Page, role: string, ctx: unknown, fresh: boolean) => {
    const { vaultRole, username } = await resolveRole(role, ctx);
    // Refresh before expiry: a session close to its max age is replaced now, not mid-journey.
    const h = await sessionHealth(vaultRole);
    if (fresh || h.refreshDue) {
      if (h.refreshDue && !fresh) logger.info(`Role ${vaultRole}: cached session is ${Math.round((h.ageMs ?? 0) / 60_000)} min old; refreshing before it expires`);
      await o.vault.clearSession(vaultRole);
    }
    const key = `${o.vault.environment}/${role}/${username}`;
    if (o.guard) {
      const c = await o.guard.check(key);
      if (!c.allowed) throw new EzTestError(c.reason ?? `login as ${key} is blocked`, 'LOGIN_LOCKOUT_PROTECTION');
      if (c.waitMs > 0) {
        logger.warn(`Role ${role}: backing off ${c.waitMs} ms after a recent login failure`);
        await sleep(c.waitMs);
      }
    }
    try {
      await o.vault.signIn(page, vaultRole, ctx);
      await o.guard?.recordSuccess(key);
    } catch (e) {
      const code = (e as EzTestError).code;
      if (o.guard && LOGIN_FAILURE_CODES.has(code)) await o.guard.recordFailure(key, (e as Error).message);
      throw e;
    }
  };

  return {
    login: (page, role, ctx) => signIn(page, role, ctx, false),
    relogin: (page, role, ctx) => signIn(page, role, ctx, true),
    async journeyEnd(journey, result) {
      for (const [k, v] of [...leasedFor]) {
        if (!k.includes(`:${journey.id}#${result.attempt}`)) continue;
        (result.reliability ??= {}).account = { role: v.role, account: v.account };
        leasedFor.delete(k);
        await o.pool?.release(k);
      }
    },
    sessionHealth,
  };
}
