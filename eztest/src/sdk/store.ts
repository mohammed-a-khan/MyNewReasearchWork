/**
 * `store`: the shared test data store and data pools from code journeys. Each
 * call is a `store` step (reported, traced, in the evidence) exactly like the
 * `.ez` phrasings:
 *
 * ```ts
 * await store.save('pending-order', order.id, { ttl: '2 days', namespace: 'sit' });
 * const id = await store.load<string>('pending-order', { default: 'ORD-0' });
 * const policy = await store.claim<Policy>('approvable-policies');   // released if the journey fails
 * ```
 */
import { currentHost } from './runtime.js';
import { run, show, tempKey } from './internal.js';
import { parseTtl } from '../store/types.js';

export interface StoreSaveOptions {
  namespace?: string;
  /** Expiry: "2 days", "12h", or milliseconds. */
  ttl?: string | number;
  /** Also hand the value to the CI pipeline (output variables, store-export.json). */
  pipeline?: boolean;
  /** Encrypt at rest and mask everywhere. */
  secret?: boolean;
}

async function captured<T>(key: string, step: Parameters<typeof run>[0], intent: string): Promise<T> {
  await run({ ...step, intent, captureAs: key, postconditions: [] });
  const host = currentHost('store');
  const v = host.getVar(key) as T;
  host.deleteVar(key);
  return v;
}

export const store = {
  /** Save a value to the shared store (visible to other journeys, runs, machines and pipeline stages). */
  async save(key: string, value: unknown, o: StoreSaveOptions = {}): Promise<void> {
    await run({
      action: 'store', intent: `Save ${o.secret ? '****' : show(value)} to the shared store as ${JSON.stringify(key)}`, postconditions: [],
      args: { op: 'save', key, value, raw: true, ...(o.namespace ? { namespace: o.namespace } : {}), ...(o.ttl !== undefined ? { ttlMs: parseTtl(o.ttl) } : {}), ...(o.pipeline ? { pipeline: true } : {}), ...(o.secret ? { secret: true } : {}) },
    });
  },
  /** Load a value; fails clearly when it is missing or expired, unless a default is given. */
  async load<T = unknown>(key: string, o: { namespace?: string; default?: T } = {}): Promise<T> {
    return captured<T>(tempKey('store'), { action: 'store', intent: '', args: { op: 'load', key, ...(o.namespace ? { namespace: o.namespace } : {}), ...(o.default !== undefined ? { default: o.default } : {}) } }, `Load ${JSON.stringify(key)} from the shared store`);
  },
  async delete(key: string, o: { namespace?: string } = {}): Promise<void> {
    await run({ action: 'store', intent: `Delete ${JSON.stringify(key)} from the shared store`, postconditions: [], args: { op: 'delete', key, ...(o.namespace ? { namespace: o.namespace } : {}) } });
  },
  /** Add items to a data pool (each consumed once). */
  async add(pool: string, ...values: unknown[]): Promise<void> {
    await run({ action: 'store', intent: `Add ${values.length === 1 ? show(values[0]) : `${values.length} items`} to pool ${JSON.stringify(pool)}`, postconditions: [], args: { op: 'poolAdd', pool, value: values, each: true, raw: true } });
  },
  /** Claim one item of a pool for this journey: consumed when it passes, released when it fails (unless keep). */
  async claim<T = unknown>(pool: string, o: { namespace?: string; keep?: boolean } = {}): Promise<T> {
    return captured<T>(tempKey('pool'), { action: 'store', intent: '', args: { op: 'poolTake', pool, ...(o.namespace ? { namespace: o.namespace } : {}), ...(o.keep ? { keep: true } : {}) } }, `Take one item from pool ${JSON.stringify(pool)}`);
  },
  /** Free items in a pool. */
  async available(pool: string, o: { namespace?: string } = {}): Promise<number> {
    return captured<number>(tempKey('pool'), { action: 'store', intent: '', args: { op: 'poolCount', pool, ...(o.namespace ? { namespace: o.namespace } : {}) } }, `Count the items of pool ${JSON.stringify(pool)}`);
  },
};

export type StoreSurface = typeof store;
