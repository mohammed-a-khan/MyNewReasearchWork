import { describe, expect, it } from '../support/testkit.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEzScript } from '../../src/intent/index.js';
import { JourneyQueue } from '../../src/runner/index.js';
import { FileLockBackend, JourneyLocker, resolveLockKeys } from '../../src/scale/index.js';
import type { Journey } from '../../src/core/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const ez = (s: string) => parseEzScript(s);

describe('Locks: header', () => {
  it('parses from .ez and YAML, renders back, and fills Examples placeholders', () => {
    const j = ez('Journey: Pay invoice\nLocks: account-<acct>, ledger\n\nWait 1 ms\n');
    expect(j.locks).toEqual(['account-<acct>', 'ledger']);
    expect(resolveLockKeys({ ...j, variables: { acct: '42' } })).toEqual(['account-42', 'ledger']);
    expect(resolveLockKeys({ locks: ['user-${user}'], variables: { user: 'bob' } })).toEqual(['user-bob']);
  });
});

describe('JourneyQueue with locks (one process, several workers)', () => {
  it('never runs two journeys holding the same key at once, and keeps other workers busy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-locks-'));
    const locker = new JourneyLocker({ backend: new FileLockBackend({ dir }), pollMs: 10 });
    const js: Journey[] = [
      ez('Journey: A1\nLocks: acct-1\n\nWait 1 ms\n'),
      ez('Journey: A2\nLocks: acct-1\n\nWait 1 ms\n'),
      ez('Journey: B\n\nWait 1 ms\n'),
      ez('Journey: A3\nLocks: acct-1, acct-2\n\nWait 1 ms\n'),
    ];
    const queue = new JourneyQueue(js, { tryAcquire: (j) => locker.tryAcquire(j), pollMs: 10 });
    const active = new Set<string>();
    const order: string[] = [];
    let overlap = false;
    const worker = async () => {
      for (let item = await queue.next(); item; item = await queue.next()) {
        const keys = locker.keys(item.journey);
        if (keys.some((k) => active.has(k))) overlap = true;
        keys.forEach((k) => active.add(k));
        order.push(item.journey.id);
        await new Promise((r) => setTimeout(r, 30));
        keys.forEach((k) => active.delete(k));
        await item.release();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    expect(overlap).toBe(false);
    expect([...order].sort()).toEqual(['a1', 'a2', 'a3', 'b']);
    // B (unlocked) did not wait behind the A journeys.
    expect(order.indexOf('b')).toBeLessThan(3);
  });

  it('gives up after the lock timeout and says who holds the key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-locks-t-'));
    const other = new FileLockBackend({ dir, owner: 'other-machine:123' });
    const held = await other.tryAcquire('acct-9');
    const locker = new JourneyLocker({ backend: new FileLockBackend({ dir, owner: 'me' }), pollMs: 10 });
    const queue = new JourneyQueue([ez('Journey: Blocked\nLocks: acct-9\n\nWait 1 ms\n')], { tryAcquire: (j) => locker.tryAcquire(j), pollMs: 10, timeoutMs: 100, describeHolders: (j) => locker.describeHolders(j) });
    const item = await queue.next();
    expect(item?.lockError).toMatch(/waiting for resource locks: acct-9 \(held by other-machine:123\)/);
    await held!.release();
  });
});

describe('locks across two parallel processes (real browser runs)', () => {
  it('two runners never execute journeys sharing a lock at the same time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-locks-x-'));
    const worker = join(here, 'fixtures', 'lock-worker.ts');
    const tsx = join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
    const start = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', tsx, worker, join(dir, 'locks'), join(dir, `out-${name}`), name, join(dir, `${name}.json`)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d: Buffer) => (err += d.toString()));
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${err.slice(-2000)}`))));
      });
    await Promise.all([start('p1'), start('p2')]);
    const r1 = JSON.parse(await readFile(join(dir, 'p1.json'), 'utf8')) as { times: Record<string, { start: number; end: number }>; statuses: string[][] };
    const r2 = JSON.parse(await readFile(join(dir, 'p2.json'), 'utf8')) as typeof r1;
    for (const r of [r1, r2]) expect(r.statuses.map((s) => s[1])).toEqual(['passed', 'passed']);
    const a = r1.times['p1-account-1'];
    const b = r2.times['p2-account-1'];
    // The two account-1 journeys ran one after the other (in either order), never overlapping.
    expect(a.end <= b.start || b.end <= a.start).toBe(true);
  }, 120_000);
});
