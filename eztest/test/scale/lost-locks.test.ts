/**
 * Lost resource locks are surfaced, never swallowed: a results-server lock
 * whose renewal is refused (or that cannot be renewed before it expires) is
 * marked lost, a warning is raised, and the journey that held it records it.
 */
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '../support/testkit.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { FileLockBackend, JourneyLocker } from '../../src/scale/index.js';
import { ServerLockBackend, type ResultsClient } from '../../src/server/client.js';

function fakeClient(renew: () => Promise<{ renewed: boolean }>): ResultsClient {
  return {
    acquireLock: async () => ({ acquired: true, token: 'tok', expiresAt: Date.now() + 300 }),
    renewLock: renew,
    releaseLock: async () => ({ released: true }),
  } as unknown as ResultsClient;
}

function captureWarnings(): { warnings: string[]; stop(): void } {
  const warnings: string[] = [];
  const on = (w: Error) => {
    if (w.name === 'EZTestLockLost') warnings.push(w.message);
  };
  process.on('warning', on);
  return { warnings, stop: () => process.off('warning', on) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('lost locks', () => {
  it('a refused renewal on the results server loses the lock at once, with a warning', async () => {
    const w = captureWarnings();
    try {
      const h = (await new ServerLockBackend(fakeClient(async () => ({ renewed: false })), 'run-1', 3000).tryAcquire('ledger'))!;
      expect(h.lost?.()).toBeUndefined();
      await wait(1300);
      expect(h.lost?.()).toMatch(/lock "ledger" on the results server was lost while held: the server refused to renew it/);
      await wait(10);
      expect(w.warnings).toEqual([expect.stringMatching(/lock "ledger" on the results server was lost/)]);
      await h.release();
    } finally {
      w.stop();
    }
  });

  it('renewals that keep failing lose the lock once it would have expired (failures are not swallowed)', async () => {
    let calls = 0;
    const h = (await new ServerLockBackend(fakeClient(async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    }), 'run-1', 300).tryAcquire('ledger'))!;
    await wait(1300);
    expect(calls).toBeGreaterThan(0);
    expect(h.lost?.()).toMatch(/could not be renewed for \d+ ms \(ECONNREFUSED\) and has expired/);
    await h.release();
  });

  it('a renewal that succeeds keeps the lock', async () => {
    const h = (await new ServerLockBackend(fakeClient(async () => ({ renewed: true })), 'run-1', 3000).tryAcquire('ledger'))!;
    await wait(1200);
    expect(h.lost?.()).toBeUndefined();
    await h.release();
  });

  it('a file lease taken over by another holder is lost, and the journey that held it records it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-lost-'));
    const locker = new JourneyLocker({ backend: new FileLockBackend({ dir, ttlMs: 3000 }), pollMs: 10 });
    const j = parseEzScript('Journey: Pay\nLocks: ledger\n\nWait 1700 ms\n');
    const out = await mkdtemp(join(tmpdir(), 'ez-lost-run-'));
    const run = runJourneys([j], {
      outputDir: out, fingerprintStore: join(out, 'fp.json'),
      locks: { tryAcquire: (x) => locker.tryAcquire(x), pollMs: 10 },
    });
    // Another holder overwrites the lease file while the journey runs (once the run holds it: after its browser started).
    let leases: string[] = [];
    for (let i = 0; i < 200 && !leases.length; i++) {
      await wait(50);
      leases = (await readdir(dir)).filter((f) => f.endsWith('.lease'));
    }
    expect(leases.length).toBe(1);
    for (const f of leases) await writeFile(join(dir, f), JSON.stringify({ resource: 'lock:ledger', owner: 'someone-else', token: 'other', acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }));
    const r = await run;
    expect(r.journeys[0].reliability?.locksLost).toEqual([expect.stringMatching(/lock "ledger" was lost while held: another holder took the lease over/)]);
  }, 30_000);
});
