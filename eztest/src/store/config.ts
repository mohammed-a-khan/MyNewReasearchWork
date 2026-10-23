/** The shared store from `store:` (and `server:`) configuration. */
import { resolve } from 'node:path';
import type { Logger } from '../core/index.js';
import type { EzTestConfig } from '../config/index.js';
import type { ResultsClient } from '../server/client.js';
import { FileStoreBackend } from './file.js';
import { SharedStore } from './runtime.js';
import { ServerStoreBackend } from './server.js';
import { parseTtl, type StoreBackend } from './types.js';

export interface StoreFromConfigOptions {
  cwd: string;
  /** The results server client (when `server.url` is configured). */
  client?: ResultsClient;
  /** Resolve `store.key` (secret://, ENC(...)). */
  resolveSecret?: (ref: string) => Promise<string>;
  addSecret?: (v: string) => void;
  env?: Record<string, string | undefined>;
  logger?: Logger;
}

export function storeBackendFor(config: Pick<EzTestConfig, 'store' | 'server'>, o: { cwd: string; client?: ResultsClient }): StoreBackend {
  const want = config.store.backend;
  if (want === 'server' || (want === 'auto' && o.client)) {
    if (!o.client) throw new Error('store.backend is "server" but no results server is configured (server.url)');
    return new ServerStoreBackend(o.client);
  }
  return new FileStoreBackend(resolve(o.cwd, config.store.dir));
}

export async function storeFromConfig(config: Pick<EzTestConfig, 'store' | 'server' | 'environment'>, o: StoreFromConfigOptions): Promise<SharedStore> {
  const s = config.store;
  let key: string | undefined;
  if (s.key) {
    key = /^secret:\/\/|^ENC\(/.test(s.key) && o.resolveSecret ? await o.resolveSecret(s.key) : s.key;
    if (key) o.addSecret?.(key);
  }
  return new SharedStore({
    backend: storeBackendFor(config, o),
    namespace: s.namespace ?? config.environment,
    ...(key ? { key } : {}),
    ...(s.defaultTtl ? { defaultTtlMs: parseTtl(s.defaultTtl) } : {}),
    claimTtlMs: parseTtl(s.claimTtl),
    releaseOnFailure: s.releaseOnFailure,
    pools: Object.fromEntries(Object.entries(s.pools).map(([name, p]) => [name, { ...p, ...(p.claimTtl ? { claimTtlMs: parseTtl(p.claimTtl) } : {}) }])),
    env: o.env ?? process.env,
    baseDir: o.cwd,
    ...(o.addSecret ? { addSecret: o.addSecret } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
  });
}
