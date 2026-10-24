/**
 * The results server's audit log is a keyed HMAC chain: the key lives in a
 * file outside the database (created on first use, mode 0600, rotatable), so
 * someone who can write to the database cannot re-chain a forged entry.
 * Chains written before keying still verify, with a warning.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, expect, it } from '../support/testkit.js';
import { AUDIT_GENESIS, AuditLog, auditHash, type AuditEntry } from '../../src/server/audit.js';
import { Store } from '../../src/server/store.js';

async function fresh(): Promise<{ dir: string; store: Store; keyFile: string; log: AuditLog }> {
  const dir = mkdtempSync(join(tmpdir(), 'eztest-audit-'));
  const store = await Store.open({ driver: 'sqlite', file: join(dir, 'server.db') } as never);
  const keyFile = join(dir, 'keys', 'audit-key.json');
  return { dir, store, keyFile, log: new AuditLog(store, keyFile) };
}

const rows = async (store: Store) => (await store.all('SELECT * FROM ez_audit ORDER BY seq')) as Array<Record<string, unknown>>;

describe('keyed audit chain', () => {
  it('signs every entry with the server key, kept outside the database (0600), and verifies with it', async () => {
    const { store, keyFile, log } = await fresh();
    try {
      for (let i = 0; i < 3; i++) await log.append({ actor: 'user:ada', action: 'heal.accept', project: 'pay', target: `j${i}` });
      const all = await rows(store);
      expect(all.map((r) => String(r.hash))).toEqual(all.map(() => expect.stringMatching(/^hmac-sha256:[\w-]+:[0-9a-f]{64}$/)));
      expect(String(all[0].prev_hash)).toBe(AUDIT_GENESIS);
      const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { current: string; keys: Record<string, { secret: string }> };
      expect(Buffer.from(key.keys[key.current].secret, 'base64')).toHaveLength(32);
      if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      // The secret is nowhere in the database.
      expect(JSON.stringify(await store.all('SELECT * FROM ez_audit'))).not.toContain(key.keys[key.current].secret);
      expect(await log.verify()).toMatchObject({ ok: true, entries: 3, keyed: 3, legacy: 0, problems: [], warnings: [] });
    } finally {
      await store.close();
    }
  });

  it('someone with only database access cannot forge: an edited entry re-chained without the key is caught', async () => {
    const { store, log } = await fresh();
    try {
      for (let i = 0; i < 3; i++) await log.append({ actor: 'user:ada', action: 'token.create', target: `t${i}` });
      // The attacker rewrites entry 2 and re-chains 2..3 with the hash they can compute (no key).
      const all = await rows(store);
      let prev = String(all[0].hash);
      for (const r of all.slice(1)) {
        const e: Omit<AuditEntry, 'hash'> = { seq: Number(r.seq), at: String(r.at), actor: Number(r.seq) === 2 ? 'mallory' : String(r.actor), action: String(r.action), target: r.target ? String(r.target) : undefined, prevHash: prev };
        const h = auditHash(e);
        await store.run('UPDATE ez_audit SET actor = ?, prev_hash = ?, hash = ? WHERE seq = ?', [e.actor, prev, h, e.seq]);
        prev = h;
      }
      const v = await log.verify();
      expect(v.ok).toBe(false);
      expect(v.problems).toEqual(expect.arrayContaining([expect.stringMatching(/entry 2: unkeyed hash after keyed entries \(written without the audit key: forged\)/)]));
      // ... and one signed with a key of their own is caught too.
      const forgedKey = createHash('sha256').update('guess').digest();
      const { auditHmac } = await import('../../src/server/audit.js');
      const r2 = (await rows(store))[1];
      const e2: Omit<AuditEntry, 'hash'> = { seq: 2, at: String(r2.at), actor: 'mallory', action: String(r2.action), target: String(r2.target), prevHash: String((await rows(store))[0].hash) };
      const current = String((await rows(store))[0].hash).split(':')[1];
      await store.run('UPDATE ez_audit SET hash = ? WHERE seq = ?', [auditHmac(e2, { id: current, secret: forgedKey }), 2]);
      expect((await log.verify()).problems).toEqual(expect.arrayContaining([expect.stringMatching(/entry 2: content altered or forged \(keyed hash mismatch\)/)]));
    } finally {
      await store.close();
    }
  });

  it('rotates the key: later entries use the new key, older ones still verify with theirs, a lost key is reported', async () => {
    const { store, keyFile, log } = await fresh();
    try {
      await log.append({ actor: 'user:ada', action: 'run.publish' });
      const before = String((await rows(store))[0].hash).split(':')[1];
      const { keyId } = await log.rotateKey('user:admin');
      expect(keyId).not.toBe(before);
      await log.append({ actor: 'user:ada', action: 'run.publish' });
      const all = await rows(store);
      expect(all.map((r) => String(r.hash).split(':')[1])).toEqual([before, keyId, keyId]);
      expect(all[1]).toMatchObject({ action: 'audit.key.rotate' });
      expect(JSON.parse(String(all[1].details))).toEqual({ previous: before, current: keyId });
      // A second process (another server, the CLI) reads the same key file.
      expect(await new AuditLog(store, keyFile).verify()).toMatchObject({ ok: true, keyed: 3 });
      // Losing the old key makes its entries unverifiable, and says so.
      const k = JSON.parse(readFileSync(keyFile, 'utf8')) as { keys: Record<string, unknown> };
      delete k.keys[before];
      writeFileSync(keyFile, JSON.stringify(k));
      const v = await new AuditLog(store, keyFile).verify();
      expect(v.ok).toBe(false);
      expect(v.problems[0]).toMatch(new RegExp(`entry 1: signed with audit key "${before}", which is not in .*audit-key\\.json`));
    } finally {
      await store.close();
    }
  });

  it('a chain written before keying still verifies, with a warning; its entries are still tamper-checked', async () => {
    const { store, log } = await fresh();
    try {
      // Two entries the way older servers wrote them (plain SHA-256 chain).
      let prev = AUDIT_GENESIS;
      for (const seq of [1, 2]) {
        const e: Omit<AuditEntry, 'hash'> = { seq, at: new Date().toISOString(), actor: 'user:old', action: 'run.publish', prevHash: prev };
        const h = auditHash(e);
        await store.run('INSERT INTO ez_audit (seq, at, actor, action, project, target, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [seq, e.at, e.actor, e.action, null, null, null, prev, h]);
        prev = h;
      }
      await log.append({ actor: 'user:new', action: 'run.publish' });
      const v = await log.verify();
      expect(v).toMatchObject({ ok: true, entries: 3, keyed: 1, legacy: 2, problems: [] });
      expect(v.warnings).toEqual([expect.stringMatching(/entries 1-2 were written before the audit log was keyed/)]);
      expect(String((await rows(store))[2].prev_hash)).toBe(prev);
      await store.run('UPDATE ez_audit SET actor = ? WHERE seq = ?', ['mallory', 1]);
      expect((await log.verify()).problems).toEqual(expect.arrayContaining([expect.stringMatching(/entry 1: content altered/)]));
    } finally {
      await store.close();
    }
  });
});
