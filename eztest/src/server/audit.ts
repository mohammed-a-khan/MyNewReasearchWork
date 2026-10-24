/**
 * Append-only, keyed hash chain audit log. Every entry is an HMAC-SHA256 of
 * its own fields and the previous entry's hash, under a server secret that is
 * NOT in the database (a key file next to the data, see {@link AuditKeyring}).
 * Editing, deleting or reordering any entry breaks the chain from that point
 * on, and someone with write access to the database alone cannot forge a
 * valid chain, because they do not have the key. The server never updates or
 * deletes audit rows; `verify` recomputes the chain with the key.
 *
 * - The key is generated at the first start (`<dataDir>/audit-key.json`,
 *   mode 0600, or `auditKeyFile`), and can be rotated: old keys stay in the
 *   file to verify the entries they signed. An entry's hash names its key:
 *   `hmac-sha256:<keyId>:<hex>`.
 * - Entries written before the log was keyed (plain SHA-256 hashes) are still
 *   verified, with a warning: they prove order and integrity against
 *   accidents, not against someone who can write to the database.
 *
 * Recorded: runs published, heals accepted/rejected, readiness signed,
 * quarantine and triage changes, tokens and grants, retention runs, logins,
 * audit key rotations.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { num, optStr, type Store } from './store.js';

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  project?: string;
  target?: string;
  details?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export const AUDIT_GENESIS = '0'.repeat(64);

function canonical(e: Omit<AuditEntry, 'hash'>): string {
  return JSON.stringify([e.seq, e.prevHash, e.at, e.actor, e.action, e.project ?? null, e.target ?? null, e.details ?? null]);
}

/** The unkeyed hash of entries written before the audit log was keyed (verification of old chains only). */
export function auditHash(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonical(e)).digest('hex');
}

/** The keyed hash of an entry: `hmac-sha256:<keyId>:<hex>`. */
export function auditHmac(e: Omit<AuditEntry, 'hash'>, key: { id: string; secret: Buffer }): string {
  return `hmac-sha256:${key.id}:${createHmac('sha256', key.secret).update(canonical(e)).digest('hex')}`;
}

const KEYED = /^hmac-sha256:([\w-]+):([0-9a-f]{64})$/;
const LEGACY = /^[0-9a-f]{64}$/;

interface KeyFile {
  version: 1;
  current: string;
  keys: Record<string, { secret: string; createdAt: string; retiredAt?: string }>;
}

/**
 * The audit log's secrets, in a file outside the database (mode 0600). Created with a fresh
 * 256-bit key on first use; `rotate()` adds a new current key and keeps the old ones for
 * verification.
 */
export class AuditKeyring {
  private data: KeyFile;
  private mtime = 0;

  private constructor(readonly file: string, data: KeyFile) {
    this.data = data;
    this.mtime = this.fileTime();
  }

  private fileTime(): number {
    try {
      return statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Take over a rotation made by another process (`eztest server audit rotate-key` on the server
   * machine while the server runs): the file changed, so its keys and current key are read again.
   * Keys are only ever added, so nothing this process signed with is lost.
   */
  private refresh(): void {
    const t = this.fileTime();
    if (!t || t === this.mtime) return;
    try {
      const disk = JSON.parse(readFileSync(this.file, 'utf8')) as KeyFile;
      if (disk?.keys?.[disk.current]) {
        this.data = { ...disk, keys: { ...this.data.keys, ...disk.keys } };
        this.mtime = t;
      }
    } catch {
      // being replaced right now: keep what we have, read it next time
    }
  }

  /** Open the key file, creating it (with a new key) when it does not exist. */
  static open(file: string): AuditKeyring {
    if (existsSync(file)) {
      let data: KeyFile;
      try {
        data = JSON.parse(readFileSync(file, 'utf8')) as KeyFile;
      } catch (e) {
        throw new Error(`audit: the key file ${file} is not readable JSON (${(e as Error).message}); restore it from backup - without it the audit chain cannot be verified`);
      }
      if (!data?.keys?.[data.current]) throw new Error(`audit: the key file ${file} has no current key`);
      return new AuditKeyring(file, data);
    }
    const ring = new AuditKeyring(file, { version: 1, current: '', keys: {} });
    ring.addKey();
    return ring;
  }

  private addKey(): string {
    this.refresh();
    const id = `k${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const now = new Date().toISOString();
    const prev = this.data.keys[this.data.current];
    if (prev) prev.retiredAt = now;
    this.data.keys[id] = { secret: randomBytes(32).toString('base64'), createdAt: now };
    this.data.current = id;
    this.save();
    return id;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtime = this.fileTime();
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* not supported on this file system */
    }
  }

  current(): { id: string; secret: Buffer } {
    this.refresh();
    return { id: this.data.current, secret: Buffer.from(this.data.keys[this.data.current].secret, 'base64') };
  }

  get(id: string): { id: string; secret: Buffer } | undefined {
    if (!this.data.keys[id]) this.refresh();
    const k = this.data.keys[id];
    return k ? { id, secret: Buffer.from(k.secret, 'base64') } : undefined;
  }

  /** Start signing with a new key; the old ones stay for verification. Returns the new key id. */
  rotate(): string {
    return this.addKey();
  }

  ids(): string[] {
    return Object.keys(this.data.keys);
  }
}

/** Where a server keeps its audit key: `auditKeyFile`, else `<dataDir>/audit-key.json`. */
export function auditKeyFileFor(cfg: { dataDir: string; auditKeyFile?: string }): string {
  return cfg.auditKeyFile ?? join(cfg.dataDir, 'audit-key.json');
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  head: string;
  problems: string[];
  /** Not problems, but worth knowing (entries from before the log was keyed). */
  warnings: string[];
  /** Entries checked with a key, and unkeyed (older) ones. */
  keyed: number;
  legacy: number;
}

function fromRow(r: Record<string, unknown>): AuditEntry {
  return {
    seq: num(r.seq),
    at: String(r.at),
    actor: String(r.actor),
    action: String(r.action),
    project: optStr(r.project),
    target: optStr(r.target),
    details: r.details ? (JSON.parse(String(r.details)) as Record<string, unknown>) : undefined,
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

export class AuditLog {
  private tail: Promise<unknown> = Promise.resolve();
  private ring?: AuditKeyring;

  /** `keyFile`: the audit key file (see {@link auditKeyFileFor}); created with a new key when missing. */
  constructor(private readonly store: Store, readonly keyFile: string) {}

  private keys(): AuditKeyring {
    return (this.ring ??= AuditKeyring.open(this.keyFile));
  }

  /** Rotate the audit key: later entries are signed with a new key; the rotation itself is audited. */
  async rotateKey(actor: string): Promise<{ keyId: string }> {
    const previous = this.keys().current().id;
    const keyId = this.keys().rotate();
    await this.append({ actor, action: 'audit.key.rotate', details: { previous, current: keyId } });
    return { keyId };
  }

  /** Append an entry. Appends are serialised in-process; a concurrent writer elsewhere loses the primary-key race and retries. */
  append(e: { actor: string; action: string; project?: string; target?: string; details?: Record<string, unknown> }): Promise<AuditEntry> {
    const next = this.tail.then(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await this.store.one(`SELECT seq, hash FROM ez_audit${this.store.page('seq DESC', 1)}`);
        const base: Omit<AuditEntry, 'hash'> = {
          seq: last ? num(last.seq) + 1 : 1,
          at: new Date().toISOString(),
          actor: e.actor,
          action: e.action,
          project: e.project,
          target: e.target,
          details: e.details,
          prevHash: last ? String(last.hash) : AUDIT_GENESIS,
        };
        const entry: AuditEntry = { ...base, hash: auditHmac(base, this.keys().current()) };
        const ok = await this.store.tryInsert(
          'INSERT INTO ez_audit (seq, at, actor, action, project, target, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [entry.seq, entry.at, entry.actor, entry.action, entry.project ?? null, entry.target ?? null, entry.details ? JSON.stringify(entry.details) : null, entry.prevHash, entry.hash],
        );
        if (ok) return entry;
      }
      throw new Error('audit: could not append after 5 attempts (concurrent writers)');
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  async list(o: { project?: string; limit?: number; action?: string } = {}): Promise<AuditEntry[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (o.project) {
      where.push('project = ?');
      params.push(o.project);
    }
    if (o.action) {
      where.push('action = ?');
      params.push(o.action);
    }
    const rows = await this.store.all(`SELECT * FROM ez_audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${this.store.page('seq DESC', o.limit ?? 200)}`, params);
    return rows.map(fromRow);
  }

  /** Walk the whole chain, checking every keyed entry with its key. */
  async verify(): Promise<AuditVerification> {
    const rows = await this.store.all('SELECT * FROM ez_audit ORDER BY seq');
    const problems: string[] = [];
    let prev = AUDIT_GENESIS;
    let expected = 1;
    let keyed = 0;
    let legacy = 0;
    let lastLegacy = 0;
    const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    for (const r of rows) {
      const e = fromRow(r);
      if (e.seq !== expected) problems.push(`entry ${e.seq}: expected sequence ${expected} (an entry was removed or inserted)`);
      if (e.prevHash !== prev) problems.push(`entry ${e.seq}: chain broken (previous hash mismatch)`);
      const { hash, ...rest } = e;
      const k = KEYED.exec(hash);
      if (k) {
        keyed++;
        const key = this.keys().get(k[1]);
        if (!key) problems.push(`entry ${e.seq}: signed with audit key "${k[1]}", which is not in ${this.keyFile} (the key file was replaced, or the entry forged)`);
        else if (!same(auditHmac(rest, key), hash)) problems.push(`entry ${e.seq}: content altered or forged (keyed hash mismatch)`);
      } else if (LEGACY.test(hash)) {
        // Unkeyed entries are only valid before the first keyed one: one after it was written without the key.
        if (keyed) problems.push(`entry ${e.seq}: unkeyed hash after keyed entries (written without the audit key: forged)`);
        else {
          legacy++;
          lastLegacy = e.seq;
          if (auditHash(rest) !== hash) problems.push(`entry ${e.seq}: content altered (hash mismatch)`);
        }
      } else {
        problems.push(`entry ${e.seq}: hash "${hash.slice(0, 24)}..." is in no known format`);
      }
      prev = hash;
      expected = e.seq + 1;
    }
    const warnings = legacy
      ? [`entries 1-${lastLegacy} were written before the audit log was keyed: their chain is intact, but it proves integrity against accidents only, not against someone who could write to the database`]
      : [];
    return { ok: problems.length === 0, entries: rows.length, head: prev, problems, warnings, keyed, legacy };
  }
}
