/**
 * Shared test data on the results server: the shared store (key/value per
 * project and namespace, with expiry), data pools (claimed atomically: one
 * row UPDATE guarded by "not claimed, or the claim expired") and deployment
 * test records. Secret values arrive sealed by the client and are stored as
 * they came. Every change is audited.
 */
import type { DeploymentRecord } from '../pipelines/types.js';
import type { NewPoolItem, PoolItem, PoolSummary, StoredEntry } from '../store/types.js';
import { isSealed } from '../store/cipher.js';
import type { AuditLog } from './audit.js';
import type { Principal } from './auth.js';
import { ServiceError } from './service.js';
import { num, optNum, optStr, type Store } from './store.js';

const KEY = /^[A-Za-z0-9_][\w.:@/-]{0,199}$/;
const NS = /^[A-Za-z0-9_][\w.-]{0,99}$/;
const MAX_VALUE = 256 * 1024;

export function checkStoreName(kind: string, v: unknown, re = KEY): string {
  if (typeof v !== 'string' || !re.test(v) || v.includes('..')) throw new ServiceError(400, `Invalid ${kind} "${String(v).slice(0, 60)}"`);
  return v;
}
const ns = (v: unknown) => checkStoreName('namespace', v, NS);

function encodeValue(b: { value?: unknown; sealed?: unknown; secret?: unknown }): { text: string; secret: boolean } {
  const secret = b.secret === true;
  if (secret && !isSealed(b.sealed)) throw new ServiceError(400, 'A secret value must be sealed by the client (EZS2:... or EZS1:...); the server never stores plain secrets');
  const text = secret ? String(b.sealed) : JSON.stringify(b.value ?? null);
  if (text.length > MAX_VALUE) throw new ServiceError(413, `Value too large (max ${MAX_VALUE / 1024} KB)`);
  return { text, secret };
}

function entryFromRow(r: Record<string, unknown>): StoredEntry {
  const secret = num(r.secret) === 1;
  const source = r.source ? (JSON.parse(String(r.source)) as StoredEntry['source']) : undefined;
  return {
    namespace: String(r.namespace), key: String(r.skey), ...(secret ? { sealed: String(r.value), secret: true } : { value: JSON.parse(String(r.value ?? 'null')) as unknown }),
    ...(num(r.pipeline) === 1 ? { pipeline: true } : {}), ...(optStr(r.expires_at) ? { expiresAt: optStr(r.expires_at) } : {}),
    createdAt: String(r.created_at ?? ''), updatedAt: String(r.updated_at ?? ''), ...(optStr(r.updated_by) ? { updatedBy: optStr(r.updated_by) } : {}), ...(source ? { source } : {}),
  };
}

function itemFromRow(r: Record<string, unknown>): PoolItem {
  const secret = num(r.secret) === 1;
  const exp = optNum(r.claim_expires);
  return {
    id: String(r.item_id), ...(secret ? { sealed: String(r.value), secret: true } : { value: JSON.parse(String(r.value ?? 'null')) as unknown }),
    addedAt: String(r.added_at ?? ''), ...(optStr(r.added_by) ? { addedBy: optStr(r.added_by) } : {}),
    ...(optStr(r.claim_owner) && exp !== undefined ? { claim: { owner: String(r.claim_owner), at: String(r.claim_at ?? ''), expiresAt: exp } } : {}),
  };
}

export class SharedDataRegistry {
  constructor(private readonly store: Store, private readonly audit: AuditLog, private readonly ensureProject: (p: string) => Promise<void>) {}

  // ---------------------------------------------------------------- key/value
  async list(project: string, namespace?: string): Promise<StoredEntry[]> {
    const rows = namespace
      ? await this.store.all('SELECT * FROM ez_store WHERE project = ? AND namespace = ?' + this.store.page('namespace, skey', 10_000), [project, ns(namespace)])
      : await this.store.all('SELECT * FROM ez_store WHERE project = ?' + this.store.page('namespace, skey', 10_000), [project]);
    return rows.map(entryFromRow);
  }

  async get(project: string, namespace: string, key: string): Promise<StoredEntry | undefined> {
    const r = await this.store.one('SELECT * FROM ez_store WHERE project = ? AND namespace = ? AND skey = ?', [project, ns(namespace), checkStoreName('key', key)]);
    return r ? entryFromRow(r) : undefined;
  }

  async put(project: string, namespace: string, key: string, b: Record<string, unknown>, who: Principal): Promise<StoredEntry> {
    ns(namespace);
    checkStoreName('key', key);
    const { text, secret } = encodeValue(b);
    const expiresAt = b.expiresAt === undefined || b.expiresAt === null || b.expiresAt === '' ? null : String(b.expiresAt);
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new ServiceError(400, 'expiresAt must be an ISO date');
    const source = b.source && typeof b.source === 'object' ? JSON.stringify(b.source).slice(0, 2000) : null;
    await this.ensureProject(project);
    const at = new Date().toISOString();
    const by = typeof b.updatedBy === 'string' && b.updatedBy ? `${who.id} (${b.updatedBy.slice(0, 200)})` : who.id;
    await this.store.tx(async (s) => {
      const n = await s.run('UPDATE ez_store SET value = ?, secret = ?, pipeline = ?, expires_at = ?, updated_at = ?, updated_by = ?, source = ? WHERE project = ? AND namespace = ? AND skey = ?', [
        text, secret ? 1 : 0, b.pipeline === true ? 1 : 0, expiresAt, at, by, source, project, namespace, key,
      ]);
      if (!n) {
        await s.run('INSERT INTO ez_store (project, namespace, skey, value, secret, pipeline, expires_at, created_at, updated_at, updated_by, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          project, namespace, key, text, secret ? 1 : 0, b.pipeline === true ? 1 : 0, expiresAt, at, at, by, source,
        ]);
      }
    });
    await this.audit.append({ actor: who.id, action: 'store.save', project, target: `${namespace}/${key}`, details: { secret, pipeline: b.pipeline === true, expiresAt } });
    return (await this.get(project, namespace, key))!;
  }

  async delete(project: string, namespace: string, key: string, who: Principal): Promise<boolean> {
    const n = await this.store.run('DELETE FROM ez_store WHERE project = ? AND namespace = ? AND skey = ?', [project, ns(namespace), checkStoreName('key', key)]);
    if (n) await this.audit.append({ actor: who.id, action: 'store.delete', project, target: `${namespace}/${key}` });
    return n > 0;
  }

  async purgeExpired(project: string, namespace: string | undefined, who: Principal): Promise<number> {
    const now = new Date().toISOString();
    const n = namespace
      ? await this.store.run('DELETE FROM ez_store WHERE project = ? AND namespace = ? AND expires_at IS NOT NULL AND expires_at <= ?', [project, ns(namespace), now])
      : await this.store.run('DELETE FROM ez_store WHERE project = ? AND expires_at IS NOT NULL AND expires_at <= ?', [project, now]);
    if (n) await this.audit.append({ actor: who.id, action: 'store.purge', project, target: namespace ?? '*', details: { purged: n } });
    return n;
  }

  // ---------------------------------------------------------------- pools
  async pools(project: string, namespace?: string): Promise<PoolSummary[]> {
    const now = Date.now();
    const rows = await this.store.all(
      `SELECT namespace, pool, COUNT(*) AS total, SUM(CASE WHEN claim_owner IS NOT NULL AND claim_expires > ? THEN 1 ELSE 0 END) AS claimed FROM ez_pool_items WHERE project = ?${namespace ? ' AND namespace = ?' : ''} GROUP BY namespace, pool`,
      namespace ? [now, project, ns(namespace)] : [now, project],
    );
    return rows.map((r) => ({ namespace: String(r.namespace), pool: String(r.pool), total: num(r.total), claimed: num(r.claimed), available: num(r.total) - num(r.claimed) }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.pool.localeCompare(b.pool));
  }

  async items(project: string, namespace: string, pool: string): Promise<PoolItem[]> {
    const rows = await this.store.all('SELECT * FROM ez_pool_items WHERE project = ? AND namespace = ? AND pool = ?' + this.store.page('added_at, item_id', 10_000), [project, ns(namespace), checkStoreName('pool', pool)]);
    return rows.map(itemFromRow);
  }

  async add(project: string, namespace: string, pool: string, body: { items?: unknown; by?: unknown }, who: Principal): Promise<{ added: number; skipped: number }> {
    ns(namespace);
    checkStoreName('pool', pool);
    if (!Array.isArray(body.items) || body.items.length > 10_000) throw new ServiceError(400, '"items" must be a list of at most 10000 items');
    await this.ensureProject(project);
    const at = new Date().toISOString();
    let added = 0;
    for (const raw of body.items as NewPoolItem[]) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') throw new ServiceError(400, 'Every pool item needs an id');
      const id = checkStoreName('item id', raw.id);
      const { text, secret } = encodeValue(raw);
      if (await this.store.tryInsert('INSERT INTO ez_pool_items (project, namespace, pool, item_id, value, secret, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [project, namespace, pool, id, text, secret ? 1 : 0, at, typeof body.by === 'string' ? body.by.slice(0, 300) : who.id])) added++;
    }
    const skipped = body.items.length - added;
    if (added) await this.audit.append({ actor: who.id, action: 'pool.add', project, target: `${namespace}/${pool}`, details: { added, skipped } });
    return { added, skipped };
  }

  /** Atomic across concurrent requests: each candidate is taken with one guarded UPDATE; the first that changes a row wins it. */
  async claim(project: string, namespace: string, pool: string, owner: string, leaseMs: number, who: Principal): Promise<PoolItem | undefined> {
    ns(namespace);
    checkStoreName('pool', pool);
    if (!owner || owner.length > 300) throw new ServiceError(400, 'owner is required (at most 300 characters)');
    const lease = Math.max(1000, Math.min(Number.isFinite(leaseMs) ? leaseMs : 1_800_000, 7 * 86_400_000));
    for (let round = 0; round < 5; round++) {
      const now = Date.now();
      const candidates = await this.store.all('SELECT item_id FROM ez_pool_items WHERE project = ? AND namespace = ? AND pool = ? AND (claim_owner IS NULL OR claim_expires <= ?)' + this.store.page('added_at, item_id', 25), [project, namespace, pool, now]);
      if (!candidates.length) return undefined;
      for (const c of candidates) {
        const n = await this.store.run('UPDATE ez_pool_items SET claim_owner = ?, claim_at = ?, claim_expires = ? WHERE project = ? AND namespace = ? AND pool = ? AND item_id = ? AND (claim_owner IS NULL OR claim_expires <= ?)', [
          owner, new Date(now).toISOString(), now + lease, project, namespace, pool, String(c.item_id), now,
        ]);
        if (n === 1) {
          await this.audit.append({ actor: who.id, action: 'pool.claim', project, target: `${namespace}/${pool}/${String(c.item_id)}`, details: { owner } });
          const r = await this.store.one('SELECT * FROM ez_pool_items WHERE project = ? AND namespace = ? AND pool = ? AND item_id = ?', [project, namespace, pool, String(c.item_id)]);
          return r ? itemFromRow(r) : undefined;
        }
      }
    }
    return undefined;
  }

  async release(project: string, namespace: string, pool: string, id: string, owner: string, who: Principal): Promise<boolean> {
    const n = await this.store.run('UPDATE ez_pool_items SET claim_owner = NULL, claim_at = NULL, claim_expires = NULL WHERE project = ? AND namespace = ? AND pool = ? AND item_id = ? AND claim_owner = ?', [project, ns(namespace), checkStoreName('pool', pool), id, owner]);
    if (n) await this.audit.append({ actor: who.id, action: 'pool.release', project, target: `${namespace}/${pool}/${id}`, details: { owner } });
    return n > 0;
  }

  async consume(project: string, namespace: string, pool: string, id: string, owner: string, who: Principal): Promise<boolean> {
    const n = await this.store.run('DELETE FROM ez_pool_items WHERE project = ? AND namespace = ? AND pool = ? AND item_id = ? AND claim_owner = ?', [project, ns(namespace), checkStoreName('pool', pool), id, owner]);
    if (n) await this.audit.append({ actor: who.id, action: 'pool.consume', project, target: `${namespace}/${pool}/${id}`, details: { owner } });
    return n > 0;
  }

  async remove(project: string, namespace: string, pool: string, id: string, who: Principal): Promise<boolean> {
    const n = await this.store.run('DELETE FROM ez_pool_items WHERE project = ? AND namespace = ? AND pool = ? AND item_id = ?', [project, ns(namespace), checkStoreName('pool', pool), id]);
    if (n) await this.audit.append({ actor: who.id, action: 'pool.remove', project, target: `${namespace}/${pool}/${id}` });
    return n > 0;
  }

  // ---------------------------------------------------------------- deployment test records
  async recordDeployment(project: string, b: Record<string, unknown>, who: Principal): Promise<DeploymentRecord> {
    const environment = checkStoreName('environment', b.environment, NS);
    const version = checkStoreName('version', b.version);
    const pipeline = checkStoreName('pipeline', b.pipeline, NS);
    const results = b.results as DeploymentRecord['results'] | undefined;
    if (!results || typeof results !== 'object' || typeof results.total !== 'number') throw new ServiceError(400, '"results" with the run counts is required');
    const recordedAt = new Date().toISOString();
    const id = b.id === undefined ? `${environment}:${version}:${typeof b.runId === 'string' ? b.runId : recordedAt}` : checkStoreName('id', b.id);
    const rec: DeploymentRecord = {
      ...(b as unknown as DeploymentRecord), id, environment, version, pipeline, recordedAt, recordedBy: who.id,
      selection: (b.selection as DeploymentRecord['selection']) ?? { journeys: [], total: results.total },
    };
    const data = JSON.stringify(rec);
    if (data.length > 2 * 1024 * 1024) throw new ServiceError(413, 'Deployment record too large');
    await this.ensureProject(project);
    await this.store.run('DELETE FROM ez_deployments WHERE project = ? AND id = ?', [project, id]);
    await this.store.run('INSERT INTO ez_deployments (project, id, recorded_at, environment, version, pipeline, decision, data, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      project, id, recordedAt, environment, version, pipeline, rec.readiness?.decision ?? null, data, who.id,
    ]);
    await this.audit.append({ actor: who.id, action: 'deployment.record', project, target: id, details: { environment, version, pipeline, decision: rec.readiness?.decision, total: results.total, failed: results.failed } });
    return rec;
  }

  async deployments(project: string, q: { environment?: string; version?: string; pipeline?: string; limit?: number } = {}): Promise<DeploymentRecord[]> {
    const where = ['project = ?'];
    const params: Array<string | number> = [project];
    if (q.environment) (where.push('environment = ?'), params.push(q.environment));
    if (q.version) (where.push('version = ?'), params.push(q.version));
    if (q.pipeline) (where.push('pipeline = ?'), params.push(q.pipeline));
    const rows = await this.store.all(`SELECT data FROM ez_deployments WHERE ${where.join(' AND ')}` + this.store.page('recorded_at DESC', q.limit ?? 500), params);
    return rows.map((r) => JSON.parse(String(r.data)) as DeploymentRecord);
  }
}
