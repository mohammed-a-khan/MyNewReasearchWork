/** Test data cleanup that survives crashes, account pools, lockout protection and pooled login. */
import { describe, expect, it } from '../support/testkit.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EzTestError, type JourneyResult } from '../../src/core/index.js';
import { CleanupJournal, DataFabric, LeaseRegistry, readJournal, sweepOrphans, type DataProvider, type DataRecord } from '../../src/data/index.js';
import { AccountPool, LockoutGuard, createPooledLogin, expandPoolRoles, type IdentityVault } from '../../src/identity/index.js';
import { parseEzScript } from '../../src/intent/index.js';

const tmp = (p: string) => mkdtemp(join(tmpdir(), `eztest-${p}-`));

/** An in-memory provider whose records live in a Map (so deletes can be observed). */
function memoryProvider(store: Map<string, DataRecord>, name = 'mem'): DataProvider {
  let n = 0;
  return {
    name,
    supports: (e) => e === 'Customer',
    async create(_e, values) {
      const rec = { id: `C${++n}-${Math.random().toString(36).slice(2, 6)}`, region: 'EU', ...values };
      store.set(String(rec.id), rec);
      return rec;
    },
    async delete(_e, rec) {
      if (!store.delete(String(rec.id))) throw new Error(`no record ${String(rec.id)}`);
    },
    idOf: (_e, rec) => String(rec.id),
  };
}

describe('cleanup journal and orphan sweep', () => {
  it('journals created records; a normal release deletes them and removes the journal', async () => {
    const dir = await tmp('journal');
    const store = new Map<string, DataRecord>();
    const fabric = new DataFabric({ providers: [memoryProvider(store)], leases: new LeaseRegistry({ dir: join(dir, 'leases') }), journal: new CleanupJournal(join(dir, 'cleanup')) });
    await fabric.resolve({ entity: 'Customer', as: 'c', strategy: 'create' });
    await fabric.resolve({ entity: 'Customer', as: 'd', strategy: 'create' });
    expect(store.size).toBe(2);
    const files = await readdir(join(dir, 'cleanup'));
    expect((await readJournal(join(dir, 'cleanup', files[0]))).length).toBe(2);
    await fabric.release();
    expect(store.size).toBe(0);
    expect(await readdir(join(dir, 'cleanup'))).toEqual([]);
  });

  it('records a crashed process created are deleted by the next run (real crash: the child process exits mid-run)', async () => {
    const dir = await tmp('crash');
    const cleanup = join(dir, 'cleanup');
    // A child process journals three records and dies without cleaning up.
    const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures', 'crashing-run.ts'), cleanup], { stdio: 'inherit' });
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(3);
    const left = (await readdir(cleanup)).filter((f) => f.endsWith('.jsonl'));
    expect(left).toHaveLength(1);
    // The next run: the owner process is gone, so its journal is an orphan.
    const removed: string[] = [];
    const report = await sweepOrphans(cleanup, async (e) => {
      removed.push(e.recordId);
      return true;
    });
    expect(report.journals).toBe(1);
    expect(removed.sort()).toEqual(['R1', 'R2', 'R3']);
    expect((await readdir(cleanup)).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
  });

  it('a live owner is left alone; failures are kept for a later sweep; two sweepers never double-delete', async () => {
    const dir = await tmp('sweep');
    const j = new CleanupJournal(dir, { owner: 'live-owner' });
    await j.record({ provider: 'mem', entity: 'Customer', recordId: 'A', record: { id: 'A' } });
    expect((await sweepOrphans(dir, async () => true)).journals).toBe(0); // this process is alive
    // Pretend the owner died; one record cannot be removed.
    const calls: string[] = [];
    const r = await sweepOrphans(dir, async (e) => {
      calls.push(e.recordId);
      throw new Error('FK constraint: still referenced');
    }, { isAlive: () => false, owner: 'sweeper-1' });
    expect(r.failed).toEqual([{ provider: 'mem', entity: 'Customer', recordId: 'A', error: 'FK constraint: still referenced' }]);
    const retry = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    expect(retry).toEqual(['sweeper-1-retry.jsonl']);
    // Two concurrent sweepers: each record is removed exactly once.
    for (let i = 0; i < 5; i++) {
      const o = new CleanupJournal(dir, { owner: `dead-${i}` });
      await o.record({ provider: 'mem', entity: 'Customer', recordId: `X${i}`, record: {} });
    }
    const seen: string[] = [];
    const remove = async (e: { recordId: string }) => {
      seen.push(e.recordId);
      return true;
    };
    await Promise.all([sweepOrphans(dir, remove, { isAlive: () => false }), sweepOrphans(dir, remove, { isAlive: () => false })]);
    expect(seen.sort()).toEqual(['A', 'X0', 'X1', 'X2', 'X3', 'X4']);
  });

  it('the data fabric sweeps orphans through its providers', async () => {
    const dir = await tmp('fabric-sweep');
    const store = new Map<string, DataRecord>();
    const crashed = new DataFabric({ providers: [memoryProvider(store)], leases: new LeaseRegistry({ dir: join(dir, 'l1') }), journal: new CleanupJournal(join(dir, 'cleanup'), { owner: 'crashed' }) });
    await crashed.resolve({ entity: 'Customer', as: 'c', strategy: 'create' });
    expect(store.size).toBe(1);
    // (no release: the "process" died)
    const next = new DataFabric({ providers: [memoryProvider(store)], leases: new LeaseRegistry({ dir: join(dir, 'l2') }) });
    const r = await next.sweepOrphans(join(dir, 'cleanup'), { isAlive: () => false });
    expect(r.removed).toHaveLength(1);
    expect(store.size).toBe(0);
  });
});

describe('account pools', () => {
  const pools = { manager: { accounts: [{ username: 'mgr1', password: 'secret://env/MGR1' }, { username: 'mgr2', password: 'secret://env/MGR2' }], waitSeconds: 3 } };

  it('leases one account per holder; parallel holders never share; a third waits for a release', async () => {
    const dir = await tmp('pool');
    // Two registries on one directory = two processes.
    const p1 = new AccountPool({ pools, leases: new LeaseRegistry({ dir }), pollMs: 50 });
    const p2 = new AccountPool({ pools, leases: new LeaseRegistry({ dir }), pollMs: 50 });
    const a = await p1.acquire('manager', 'run1:j1#1');
    const b = await p2.acquire('manager', 'run2:j7#1');
    expect(new Set([a.username, b.username]).size).toBe(2);
    expect(await p1.acquire('manager', 'run1:j1#1')).toBe(a); // same holder, same account
    const t0 = Date.now();
    setTimeout(() => void p1.release('run1:j1#1'), 400);
    const c = await p2.acquire('manager', 'run2:j8#1');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(c.username).toBe(a.username);
    expect(c.vaultRole).toBe(`manager#${c.index + 1}`);
  });

  it('fails clearly when the pool stays exhausted', async () => {
    const dir = await tmp('pool-x');
    const p = new AccountPool({ pools: { manager: { ...pools.manager, waitSeconds: 0 } }, leases: new LeaseRegistry({ dir }) });
    await p.acquire('manager', 'h1');
    await p.acquire('manager', 'h2');
    await expect(p.acquire('manager', 'h3')).rejects.toMatchObject({ code: 'ACCOUNT_POOL_EXHAUSTED' });
  });

  it('expands pooled accounts into vault roles', () => {
    const roles = expandPoolRoles({ manager: { username: 'x', password: 'y', loginUrl: '/login', successUrl: '/dashboard' } }, pools);
    expect(roles['manager#2']).toMatchObject({ username: 'mgr2', password: 'secret://env/MGR2', loginUrl: '/login', successUrl: '/dashboard' });
    expect(() => expandPoolRoles({}, pools)).toThrow(/no role "manager"/);
  });
});

describe('lockout protection', () => {
  it('backs off after failures, stops at the limit, alerts, and resets on success', async () => {
    const dir = await tmp('lockout');
    let now = 1_000_000;
    const alerts: string[] = [];
    const g = new LockoutGuard(join(dir, 'lockout.json'), { maxFailures: 3, windowMs: 60_000, backoffMs: 1000, now: () => now, onAlert: (m) => alerts.push(m) });
    expect(await g.check('dev/manager/bob')).toEqual({ allowed: true, waitMs: 0 });
    await g.recordFailure('dev/manager/bob', 'Invalid username or password');
    expect((await g.check('dev/manager/bob')).waitMs).toBe(1000);
    now += 300;
    await g.recordFailure('dev/manager/bob', 'Invalid username or password');
    expect((await g.check('dev/manager/bob')).waitMs).toBe(2000);
    await g.recordFailure('dev/manager/bob', 'Invalid username or password');
    const blocked = await new LockoutGuard(join(dir, 'lockout.json'), { maxFailures: 3, windowMs: 60_000, now: () => now }).check('dev/manager/bob'); // persisted
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/failed 3 times.*stopped trying so the account is not locked/);
    expect(alerts).toHaveLength(1);
    now += 61_000; // the window passed
    expect((await g.check('dev/manager/bob')).allowed).toBe(true);
    await g.recordFailure('dev/manager/bob', 'x');
    await g.recordSuccess('dev/manager/bob');
    expect(await g.check('dev/manager/bob')).toEqual({ allowed: true, waitMs: 0 });
  });
});

describe('pooled, guarded login', () => {
  function fakeVault(dir: string, fail = false) {
    const calls: string[] = [];
    const cleared: string[] = [];
    const vault = {
      environment: 'dev',
      sessionFile: (role: string) => join(dir, `${role}.json`),
      clearSession: async (role: string) => void cleared.push(role),
      signIn: async (_p: unknown, role: string) => {
        calls.push(role);
        if (fail) throw new EzTestError(`Role ${role}: login failed: Invalid username or password`, 'LOGIN_FAILED');
        await writeFile(join(dir, `${role}.json`), '{}');
        return { role, reused: false, url: '' };
      },
    } as unknown as IdentityVault;
    return { vault, calls, cleared };
  }
  const ctx = (journeyId: string, attempt = 1) => ({ runId: 'r1', attempt, journey: { id: journeyId } });

  it('signs each journey in as its own leased account, and releases it at journey end', async () => {
    const dir = await tmp('pooled');
    const { vault, calls } = fakeVault(dir);
    const pool = new AccountPool({ pools: { manager: { accounts: [{ username: 'mgr1', password: 'p' }, { username: 'mgr2', password: 'p' }] } }, leases: new LeaseRegistry({ dir: join(dir, 'leases') }) });
    const login = createPooledLogin({ vault, pool });
    await Promise.all([login.login({} as never, 'manager', ctx('a')), login.login({} as never, 'manager', ctx('b'))]);
    expect(new Set(calls)).toEqual(new Set(['manager#1', 'manager#2']));
    const result = { attempt: 1 } as JourneyResult;
    await login.journeyEnd(parseEzScript('Journey: a\nId: a\nOpen /\n'), result);
    expect(result.reliability?.account?.role).toBe('manager');
    // The account is free again for another journey.
    const pool2 = new AccountPool({ pools: { manager: { accounts: [{ username: 'mgr1', password: 'p' }, { username: 'mgr2', password: 'p' }], waitSeconds: 0 } }, leases: new LeaseRegistry({ dir: join(dir, 'leases') }) });
    await expect(pool2.acquire('manager', 'other')).resolves.toBeDefined();
  });

  it('refreshes a session before it expires, and relogin clears the same account\'s session', async () => {
    const dir = await tmp('refresh');
    const { vault, cleared } = fakeVault(dir);
    const login = createPooledLogin({ vault, maxAgeMs: 30 * 60_000, refreshMarginMs: 5 * 60_000 });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manager.json'), '{}');
    const old = new Date(Date.now() - 27 * 60_000); // 27 min old: inside the 5 min refresh margin
    await utimes(join(dir, 'manager.json'), old, old);
    expect((await login.sessionHealth('manager')).refreshDue).toBe(true);
    await login.login({} as never, 'manager', ctx('a'));
    expect(cleared).toEqual(['manager']);
    expect((await login.sessionHealth('manager')).refreshDue).toBe(false);
    await login.relogin({} as never, 'manager', ctx('a'));
    expect(cleared).toEqual(['manager', 'manager']);
  });

  it('stops logging in after repeated failures instead of locking the account', async () => {
    const dir = await tmp('guarded');
    const { vault, calls } = fakeVault(dir, true);
    const guard = new LockoutGuard(join(dir, 'lockout.json'), { maxFailures: 3, backoffMs: 0 });
    const login = createPooledLogin({ vault, guard });
    for (let i = 0; i < 3; i++) await expect(login.login({} as never, 'manager', ctx('a'))).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    await expect(login.login({} as never, 'manager', ctx('a'))).rejects.toMatchObject({ code: 'LOGIN_LOCKOUT_PROTECTION' });
    expect(calls).toHaveLength(3); // the fourth attempt never reached the identity provider
    expect(existsSync(join(dir, 'lockout.json'))).toBe(true);
  });
});
