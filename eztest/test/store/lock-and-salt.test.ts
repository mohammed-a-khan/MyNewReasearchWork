/**
 * The file store's lock is held safely (a heartbeat keeps a long operation
 * from looking stale, a lock someone else holds is never removed, losing the
 * lock is an error), and secret values are sealed with the store's own
 * random salt, with older fixed-salt values migrated.
 */
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '../support/testkit.js';
import { FileStoreBackend, withFileLock } from '../../src/store/file.js';
import { StoreCipher, isLegacySealed } from '../../src/store/cipher.js';
import { SharedStore, STORE_SALT_KEY } from '../../src/store/runtime.js';

const KEY = 'a-long-enough-store-key-0123456789';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A value sealed the way older EZTest versions did (one fixed salt for every store). */
function legacySeal(value: unknown): string {
  const key = scryptSync(KEY.normalize('NFC'), Buffer.from('eztest-shared-store-v1'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('eztest:store:v1'));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return `EZS1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

describe('file store lock', () => {
  it('a long operation keeps its lock fresh (heartbeat): others wait instead of breaking it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-lock-'));
    const file = join(dir, 'values.json');
    const order: string[] = [];
    const o = { staleMs: 300, heartbeatMs: 50, waitMs: 5000 };
    const a = withFileLock(file, async () => {
      order.push('a:start');
      await wait(1000); // far longer than staleMs
      order.push('a:end');
    }, o);
    await wait(100);
    const b = withFileLock(file, async () => {
      order.push('b');
    }, o);
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('never removes a lock it does not own, and reports that it lost its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-lock-'));
    const file = join(dir, 'values.json');
    const lock = `${file}.lock`;
    const p = withFileLock(file, async () => {
      // Another process takes the lock over while this one still works.
      writeFileSync(lock, 'otherhost:4242:1700000000000:their-token');
      await wait(200);
      return 'done';
    }, { staleMs: 300, heartbeatMs: 50 });
    await expect(p).rejects.toThrow(/the lock on .*values\.json was taken over while this process held it/);
    // Their lock is still there.
    expect(readFileSync(lock, 'utf8')).toBe('otherhost:4242:1700000000000:their-token');
  });

  it('breaks the stale lock of a crashed process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-lock-'));
    const file = join(dir, 'values.json');
    const lock = `${file}.lock`;
    writeFileSync(lock, 'deadhost:1:1:gone');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(await withFileLock(file, async () => 'ran', { staleMs: 1000 })).toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('store cipher salt', () => {
  it('each store seals with its own random salt (kept in the store), so equal keys give different ciphertext keys', async () => {
    const s1 = new SharedStore({ backend: new FileStoreBackend(await mkdtemp(join(tmpdir(), 'ez-salt-'))), key: KEY });
    const s2 = new SharedStore({ backend: new FileStoreBackend(await mkdtemp(join(tmpdir(), 'ez-salt-'))), key: KEY });
    const e1 = await s1.save('token', 'top-secret', { secret: true });
    const e2 = await s2.save('token', 'top-secret', { secret: true });
    const salt = (sealed: string) => sealed.split(':')[1];
    expect(e1.sealed).toMatch(/^EZS2:[A-Za-z0-9+/=]{24}:/);
    expect(salt(e1.sealed!)).not.toBe(salt(e2.sealed!));
    const stored1 = (await s1.backend.get('default', STORE_SALT_KEY))!.value as { salt: string };
    expect(stored1.salt).toBe(salt(e1.sealed!));
    // The same store keeps using its salt; values open anywhere the key is known.
    const again = await s1.save('other', 'x', { secret: true });
    expect(salt(again.sealed!)).toBe(stored1.salt);
    expect(new StoreCipher(KEY).open(e2.sealed!)).toBe('top-secret');
    expect((await s1.load('token')).value).toBe('top-secret');
  });

  it('migrates values sealed with the old fixed salt: on load, and all at once', async () => {
    const backend = new FileStoreBackend(await mkdtemp(join(tmpdir(), 'ez-salt-')));
    const now = new Date().toISOString();
    for (const k of ['a', 'b', 'c']) await backend.put({ namespace: 'default', key: k, sealed: legacySeal(`old-${k}`), secret: true, createdAt: now, updatedAt: now });
    const store = new SharedStore({ backend, key: KEY });
    // Loading opens the old value and re-seals it with the store's salt.
    expect((await store.load('a')).value).toBe('old-a');
    expect((await backend.get('default', 'a'))!.sealed).toMatch(/^EZS2:/);
    expect(await store.migrateSealedValues()).toBe(2);
    for (const k of ['a', 'b', 'c']) {
      const e = (await backend.get('default', k))!;
      expect(isLegacySealed(e.sealed)).toBe(false);
      expect((await store.load(k)).value).toBe(`old-${k}`);
    }
    expect(await store.migrateSealedValues()).toBe(0);
  });

  it('migrates secret pool items in the old format too: claims are kept, a taken item is re-sealed', async () => {
    const backend = new FileStoreBackend(await mkdtemp(join(tmpdir(), 'ez-salt-pool-')));
    await backend.poolAdd('default', 'accounts', ['u1', 'u2', 'u3'].map((u) => ({ id: u, sealed: legacySeal({ user: u, password: `pw-${u}` }), secret: true })), 'test');
    await backend.poolAdd('default', 'plain', [{ id: 'p1', value: 'not secret' }], 'test');
    const store = new SharedStore({ backend, key: KEY });
    // u1 is claimed by a running journey while the migration runs: it keeps its claim.
    const held = await backend.poolClaim('default', 'accounts', 'journey-x#1', 60_000);
    expect(held?.id).toBe('u1');
    expect(await store.migrateSealedValues()).toBe(3);
    const items = await backend.poolItems('default', 'accounts');
    expect(items.map((i) => isLegacySealed(i.sealed))).toEqual([false, false, false]);
    expect(items.every((i) => i.sealed!.startsWith('EZS2:'))).toBe(true);
    expect(items.find((i) => i.id === 'u1')!.claim?.owner).toBe('journey-x#1');
    expect(new StoreCipher(KEY).open(items.find((i) => i.id === 'u2')!.sealed!)).toEqual({ user: 'u2', password: 'pw-u2' });
    expect(await store.migrateSealedValues()).toBe(0);
    // Taking an item that is still in the older format re-seals it.
    await backend.poolAdd('default', 'late', [{ id: 'l1', sealed: legacySeal('late-secret'), secret: true }], 'test');
    const taken = await store.take('late', 'j#1', { namespace: 'default' });
    expect(taken.value).toBe('late-secret');
    expect((await backend.poolItems('default', 'late'))[0].sealed).toMatch(/^EZS2:/);
  });

  it('re-seals pool items on the results server (compare and swap; the server never sees the value)', async () => {
    const { startTestServer, BOOT } = await import('../server/helpers.js');
    const { ResultsClient } = await import('../../src/server/client.js');
    const { ServerStoreBackend } = await import('../../src/store/server.js');
    const server = await startTestServer();
    try {
      const backend = new ServerStoreBackend(new ResultsClient({ url: server.url, token: BOOT, project: 'pay' }));
      await backend.poolAdd('default', 'accounts', ['s1', 's2'].map((u) => ({ id: u, sealed: legacySeal(`pw-${u}`), secret: true })), 'test');
      const store = new SharedStore({ backend, key: KEY });
      expect(await store.migrateSealedValues()).toBe(2);
      const items = await backend.poolItems('default', 'accounts');
      expect(items.every((i) => i.sealed!.startsWith('EZS2:'))).toBe(true);
      expect(new StoreCipher(KEY).open(items[0].sealed!)).toBe(`pw-${items[0].id}`);
      // A stale "from" changes nothing.
      expect(await backend.poolReseal('default', 'accounts', 's1', legacySeal('x'), items[0].sealed!)).toBe(false);
      const audit = (await server.req('GET', '/api/audit?project=pay&action=pool.reseal', { token: BOOT })).json as unknown[];
      expect(audit.length).toBe(2);
    } finally {
      await server.close();
    }
  });
});
