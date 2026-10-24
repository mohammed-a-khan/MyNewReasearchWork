/**
 * The results-server backend of the shared store: values and pools live on the
 * EZTest results server, so journeys on different machines, CI agents and
 * pipeline stages share them. The server enforces RBAC (read: viewer; write,
 * claim: tester), audits every change and claims pool items atomically.
 */
import type { ResultsClient } from '../server/client.js';
import { itemIdFor } from './file.js';
import type { NewPoolItem, PoolItem, PoolSummary, StoreBackend, StoredEntry } from './types.js';

export class ServerStoreBackend implements StoreBackend {
  readonly name = 'server';

  constructor(private readonly client: ResultsClient) {}

  get description(): string {
    return `${this.client.base} (project ${this.client.project})`;
  }

  async put(e: StoredEntry): Promise<void> {
    await this.client.storePut(e);
  }

  get(namespace: string, key: string): Promise<StoredEntry | undefined> {
    return this.client.storeGet(namespace, key);
  }

  delete(namespace: string, key: string): Promise<boolean> {
    return this.client.storeDelete(namespace, key);
  }

  list(namespace?: string): Promise<StoredEntry[]> {
    return this.client.storeList(namespace);
  }

  purgeExpired(namespace?: string): Promise<number> {
    return this.client.storePurge(namespace);
  }

  poolAdd(namespace: string, pool: string, items: NewPoolItem[], by: string): Promise<{ added: number; skipped: number }> {
    return this.client.poolAdd(namespace, pool, items.map((i) => ({ ...i, id: itemIdFor(i) })), by);
  }

  poolClaim(namespace: string, pool: string, owner: string, leaseMs: number): Promise<PoolItem | undefined> {
    return this.client.poolClaim(namespace, pool, owner, leaseMs);
  }

  poolRelease(namespace: string, pool: string, id: string, owner: string): Promise<boolean> {
    return this.client.poolRelease(namespace, pool, id, owner);
  }

  poolConsume(namespace: string, pool: string, id: string, owner: string): Promise<boolean> {
    return this.client.poolConsume(namespace, pool, id, owner);
  }

  poolRemove(namespace: string, pool: string, id: string): Promise<boolean> {
    return this.client.poolRemove(namespace, pool, id);
  }

  poolReseal(namespace: string, pool: string, id: string, from: string, to: string): Promise<boolean> {
    return this.client.poolReseal(namespace, pool, id, from, to);
  }

  poolItems(namespace: string, pool: string): Promise<PoolItem[]> {
    return this.client.poolItems(namespace, pool);
  }

  pools(namespace?: string): Promise<PoolSummary[]> {
    return this.client.pools(namespace);
  }
}
