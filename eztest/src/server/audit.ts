/**
 * Append-only, hash-chained audit log. Every entry hashes its own fields and
 * the previous entry's hash, so editing, deleting or reordering any entry
 * breaks the chain from that point on. The server never updates or deletes
 * audit rows; `verifyAudit` recomputes the chain.
 *
 * Recorded: runs published, heals accepted/rejected, readiness signed,
 * quarantine and triage changes, tokens and grants, retention runs, logins.
 */
import { createHash } from 'node:crypto';
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

export function auditHash(e: Omit<AuditEntry, 'hash'>): string {
  const canonical = JSON.stringify([e.seq, e.prevHash, e.at, e.actor, e.action, e.project ?? null, e.target ?? null, e.details ?? null]);
  return createHash('sha256').update(canonical).digest('hex');
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

  constructor(private readonly store: Store) {}

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
        const entry: AuditEntry = { ...base, hash: auditHash(base) };
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

  /** Walk the whole chain. */
  async verify(): Promise<{ ok: boolean; entries: number; head: string; problems: string[] }> {
    const rows = await this.store.all('SELECT * FROM ez_audit ORDER BY seq');
    const problems: string[] = [];
    let prev = AUDIT_GENESIS;
    let expected = 1;
    for (const r of rows) {
      const e = fromRow(r);
      if (e.seq !== expected) problems.push(`entry ${e.seq}: expected sequence ${expected} (an entry was removed or inserted)`);
      if (e.prevHash !== prev) problems.push(`entry ${e.seq}: chain broken (previous hash mismatch)`);
      const { hash, ...rest } = e;
      if (auditHash(rest) !== hash) problems.push(`entry ${e.seq}: content altered (hash mismatch)`);
      prev = hash;
      expected = e.seq + 1;
    }
    return { ok: problems.length === 0, entries: rows.length, head: prev, problems };
  }
}
