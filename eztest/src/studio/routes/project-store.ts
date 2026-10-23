/**
 * Project › Shared data: the shared test data store and the data pools of the
 * project (local files or the results server, as configured): browse values
 * per namespace, edit, expire and delete them; browse pools, add items,
 * release a stuck claim, remove items. Secret values are never sent to the
 * browser, only "****".
 */
import { identityVaultFromConfig } from '../../identity/index.js';
import { MASK } from '../../config/masker.js';
import { ResultsClient } from '../../server/client.js';
import { storeFromConfig, parseTtl, isExpired, type SharedStore, type StoredEntry } from '../../store/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import type { StudioRoute } from './route.js';

async function openStore(app: StudioApp): Promise<SharedStore> {
  const loaded = await app.config();
  const s = loaded.config.server;
  const vault = identityVaultFromConfig(loaded.config, { cwd: app.cwd, masker: loaded.masker, env: { ...app.env, ...loaded.variables } });
  const resolveSecret = async (ref: string) => {
    const v = ref.startsWith('secret://') ? await vault.registry.resolve(ref) : ref;
    loaded.masker.add(v);
    return v;
  };
  let client: ResultsClient | undefined;
  if (s?.url) {
    const ref = s.token ?? (app.env.EZTEST_SERVER_TOKEN ? 'secret://env/EZTEST_SERVER_TOKEN' : undefined);
    client = new ResultsClient({ url: s.url, token: ref ? await resolveSecret(ref) : undefined, project: s.project ?? loaded.config.project ?? 'default', timeoutMs: Math.min(s.timeoutMs, 10_000) });
  }
  return storeFromConfig(loaded.config, { cwd: app.cwd, client, resolveSecret, addSecret: (v) => loaded.masker.add(v), env: { ...loaded.variables, ...app.env } });
}

const RESERVED = '__eztest';

function view(e: StoredEntry) {
  const { sealed: _sealed, value, ...rest } = e;
  return { ...rest, value: e.secret ? MASK : value, expired: isExpired(e) };
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${what} is required`);
  return v.trim();
};

/** A value typed in the Studio: JSON when it parses as an object, array, number, boolean or null; otherwise text. */
function typedValue(raw: unknown, asJson: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (asJson === true) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new HttpError(400, `The value is not valid JSON: ${(e as Error).message}`);
    }
  }
  return raw;
}

async function guarded<T>(app: StudioApp, fn: (s: SharedStore) => Promise<T>): Promise<T> {
  const s = await openStore(app);
  try {
    return await fn(s);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const loaded = await app.config();
    throw new HttpError(400, loaded.masker.mask((e as Error).message));
  }
}

export const storeRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/store',
    summary: 'Shared store values (secrets masked) and data pools, per namespace',
    async handler({ res, app }) {
      let s: SharedStore;
      try {
        s = await openStore(app);
      } catch (e) {
        sendJson(res, 200, { error: (e as Error).message, entries: [], pools: [], namespaces: [] });
        return;
      }
      try {
        const [entries, pools] = await Promise.all([s.backend.list(), s.backend.pools()]);
        const visible = entries.filter((e) => !e.key.startsWith(RESERVED));
        const namespaces = [...new Set([s.namespace, ...visible.map((e) => e.namespace), ...pools.map((p) => p.namespace)])].sort();
        sendJson(res, 200, { backend: { name: s.backend.name, description: s.backend.description }, defaultNamespace: s.namespace, namespaces, entries: visible.map(view), pools });
      } catch (e) {
        sendJson(res, 200, { backend: { name: s.backend.name, description: s.backend.description }, defaultNamespace: s.namespace, error: (await app.config()).masker.mask((e as Error).message), entries: [], pools: [], namespaces: [s.namespace] });
      }
    },
  },
  {
    method: 'POST',
    path: '/api/project/store/save',
    summary: 'Save (create or replace) a shared store value',
    async handler({ res, app, body }) {
      const e = await guarded(app, (s) => s.save(str(body.key, 'key'), typedValue(body.value, body.json), {
        namespace: str(body.namespace, 'namespace'), secret: body.secret === true, pipeline: body.pipeline === true,
        ...(typeof body.ttl === 'string' && body.ttl.trim() ? { ttlMs: parseTtl(body.ttl) } : {}), by: 'Studio',
      }));
      sendJson(res, 200, { entry: view(e) });
    },
  },
  {
    method: 'POST',
    path: '/api/project/store/expire',
    summary: 'Expire a value now (it stays visible as expired until purged)',
    async handler({ res, app, body }) {
      const ns = str(body.namespace, 'namespace');
      const key = str(body.key, 'key');
      await guarded(app, async (s) => {
        const e = await s.backend.get(ns, key);
        if (!e) throw new HttpError(404, `No "${key}" in namespace "${ns}"`);
        await s.backend.put({ ...e, expiresAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: 'Studio (expired)' });
      });
      sendJson(res, 200, { expired: true });
    },
  },
  {
    method: 'POST',
    path: '/api/project/store/delete',
    summary: 'Delete a shared store value',
    async handler({ res, app, body }) {
      const deleted = await guarded(app, (s) => s.delete(str(body.key, 'key'), { namespace: str(body.namespace, 'namespace') }));
      sendJson(res, 200, { deleted });
    },
  },
  {
    method: 'POST',
    path: '/api/project/store/purge',
    summary: 'Remove every expired value',
    async handler({ res, app, body }) {
      const purged = await guarded(app, (s) => s.backend.purgeExpired(typeof body.namespace === 'string' && body.namespace ? body.namespace : undefined));
      sendJson(res, 200, { purged });
    },
  },
  {
    method: 'GET',
    path: '/api/project/store/pool',
    summary: 'The items of one data pool (secret items masked), with their claims',
    async handler({ res, app, query }) {
      const ns = str(query.get('namespace'), 'namespace');
      const pool = str(query.get('pool'), 'pool');
      const items = await guarded(app, (s) => s.backend.poolItems(ns, pool));
      const now = Date.now();
      sendJson(res, 200, { namespace: ns, pool, items: items.map(({ sealed: _s, ...i }) => ({ ...i, value: i.secret ? MASK : i.value, claimed: !!i.claim && i.claim.expiresAt > now })) });
    },
  },
  {
    method: 'POST',
    path: '/api/project/store/pool/add',
    summary: 'Add items to a data pool (one per line, or a JSON list)',
    async handler({ res, app, body }) {
      const values = Array.isArray(body.values) ? body.values : typeof body.values === 'string' ? body.values.split(/\r?\n/).map((v) => v.trim()).filter(Boolean) : [];
      if (!values.length) throw new HttpError(400, 'Give at least one item');
      if (values.length > 10_000) throw new HttpError(400, 'At most 10000 items at a time');
      const r = await guarded(app, (s) => s.poolAdd(str(body.pool, 'pool'), values, { namespace: str(body.namespace, 'namespace'), secret: body.secret === true, by: 'Studio' }));
      sendJson(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/project/store/pool/release',
    summary: 'Release a claimed pool item (e.g. after a crashed run)',
    async handler({ res, app, body }) {
      const ns = str(body.namespace, 'namespace');
      const pool = str(body.pool, 'pool');
      const id = str(body.id, 'id');
      const released = await guarded(app, async (s) => {
        const it = (await s.backend.poolItems(ns, pool)).find((x) => x.id === id);
        if (!it) throw new HttpError(404, `No item ${id} in pool "${pool}"`);
        return it.claim ? s.backend.poolRelease(ns, pool, id, it.claim.owner) : false;
      });
      sendJson(res, 200, { released });
    },
  },
  {
    method: 'POST',
    path: '/api/project/store/pool/remove',
    summary: 'Remove an item from a data pool',
    async handler({ res, app, body }) {
      const removed = await guarded(app, (s) => s.backend.poolRemove(str(body.namespace, 'namespace'), str(body.pool, 'pool'), str(body.id, 'id')));
      sendJson(res, 200, { removed });
    },
  },
];
