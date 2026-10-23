/**
 * Project › Mocks: recorded mock stores in the project (format
 * "eztest-mocks"), interactions with editable responses, fault rules
 * (latency, error status, corrupt body, dropped connection) kept next to the
 * store, replay servers started from the Studio, drift detection against the
 * real target (auth as a role, server side).
 */
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';

import {
  RecordedResponse,
  checkDrift,
  createMockServer,
  emptyStore,
  loadStore,
  normalizeQuery,
  parseFaultRules,
  redactJsonValue,
  saveStore,
  type FaultRuleInput,
  type MockServer,
  type MockStore,
} from '../../mocks/index.js';
import { encodeBody, isJsonContentType, storableResponseHeaders } from '../../mocks/store.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import { relPosix } from '../security.js';
import { findProjectFiles, projectPath, vaultFor } from './assurance-shared.js';
import type { StudioRoute } from './route.js';

const FAULTS_SUFFIX = '.faults.json';

function headersOf(r: Response): Record<string, string> {
  const out: Record<string, string> = {};
  r.headers.forEach((v, k) => (out[k] = v));
  return out;
}

interface FaultEntry extends Record<string, unknown> {
  enabled: boolean;
}

const servers = new WeakMap<StudioApp, Map<string, { server: MockServer; startedAt: string; faults: number }>>();

function serversOf(app: StudioApp): Map<string, { server: MockServer; startedAt: string; faults: number }> {
  let m = servers.get(app);
  if (!m) {
    m = new Map();
    servers.set(app, m);
    const map = m;
    app.onClose(async () => {
      for (const s of map.values()) await s.server.close().catch(() => undefined);
      map.clear();
    });
  }
  return m;
}

async function isStore(abs: string): Promise<boolean> {
  try {
    if ((await stat(abs)).size > 20 * 1024 * 1024) return false;
    const head = (await readFile(abs, 'utf8')).slice(0, 400);
    return /"format"\s*:\s*"eztest-mocks"/.test(head) || /"recordings"\s*:/.test(head);
  } catch {
    return false;
  }
}

function storePath(app: StudioApp, p: unknown): string {
  const abs = projectPath(app, p, { exts: ['.json'] });
  if (abs.endsWith(FAULTS_SUFFIX)) throw new HttpError(400, 'That is a fault rules file, not a store');
  return abs;
}

async function readFaults(abs: string): Promise<FaultEntry[]> {
  const f = abs.replace(/\.json$/i, FAULTS_SUFFIX);
  if (!existsSync(f)) return [];
  try {
    const raw = JSON.parse(await readFile(f, 'utf8')) as { rules?: unknown[] };
    return (raw.rules ?? []).filter((r): r is FaultEntry => !!r && typeof r === 'object').map((r) => ({ ...r, enabled: r.enabled !== false }));
  } catch {
    return [];
  }
}

function activeFaults(rules: FaultEntry[]): FaultRuleInput[] {
  return rules.filter((r) => r.enabled).map(({ enabled: _e, id: _i, ...rest }) => rest as unknown as FaultRuleInput);
}

function preview(body: string, enc: string | undefined): { text: string; truncated: boolean; binary: boolean } {
  if (enc === 'base64') return { text: `<binary, ${Math.round((body.length * 3) / 4)} bytes>`, truncated: false, binary: true };
  return { text: body.length > 20_000 ? body.slice(0, 20_000) : body, truncated: body.length > 20_000, binary: false };
}

async function storeView(app: StudioApp, abs: string): Promise<Record<string, unknown>> {
  const store = await loadStore(abs);
  const running = serversOf(app).get(abs);
  return {
    path: relPosix(app.cwd, abs),
    target: store.target,
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
    recordings: store.recordings.map((r) => ({
      id: r.id,
      request: { method: r.request.method, path: r.request.path, query: r.request.query, headers: r.request.headers, body: r.request.body ? preview(r.request.body, r.request.bodyEncoding) : undefined },
      response: { status: r.response.status, headers: r.response.headers, delayMs: r.response.delayMs, body: preview(r.response.body, r.response.bodyEncoding), bodyEncoding: r.response.bodyEncoding },
      recordedAt: r.recordedAt,
    })),
    faults: (await readFaults(abs)).map((f, i) => ({ id: i + 1, ...f })),
    server: running ? { url: running.server.url, port: running.server.port, startedAt: running.startedAt, stats: running.server.stats, faults: running.faults } : undefined,
  };
}

async function tokenFor(app: StudioApp, role: unknown): Promise<string | undefined> {
  if (typeof role !== 'string' || !role) return undefined;
  const loaded = await app.config();
  if (!loaded.config.identity.roles[role]?.api) throw new HttpError(400, `Role "${role}" has no API credentials`);
  return vaultFor(app, loaded).apiToken(role);
}

async function targetOf(app: StudioApp, store: MockStore, given: unknown): Promise<string> {
  const t = typeof given === 'string' && given ? given : store.target ?? (await app.config()).config.baseUrl;
  if (!t) throw new HttpError(400, 'No target URL: give one, or set "target" in the store / baseUrl in the configuration');
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new HttpError(400, 'The target must be an http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'The target must be an http(s) URL');
  return u.toString();
}

export const mockRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/mocks',
    summary: 'Mock stores in the project and running replay servers',
    async handler({ res, app }) {
      const files = await findProjectFiles(app, ['.json'], { maxDepth: 4 });
      const stores = [];
      for (const f of files) {
        if (f.path.endsWith(FAULTS_SUFFIX)) continue;
        const abs = projectPath(app, f.path);
        if (!(await isStore(abs))) continue;
        try {
          const s = await loadStore(abs);
          stores.push({ path: f.path, recordings: s.recordings.length, target: s.target, updatedAt: s.updatedAt, running: serversOf(app).has(abs), faults: (await readFaults(abs)).filter((x) => x.enabled).length });
        } catch (e) {
          stores.push({ path: f.path, error: (e as Error).message });
        }
      }
      const running = [...serversOf(app).entries()].map(([abs, s]) => ({ path: relPosix(app.cwd, abs), url: s.server.url, startedAt: s.startedAt, stats: s.server.stats }));
      sendJson(res, 200, { stores, running });
    },
  },
  {
    method: 'GET',
    path: '/api/project/mocks/store',
    summary: 'Interactions and fault rules of one mock store',
    async handler({ res, app, query }) {
      sendJson(res, 200, await storeView(app, storePath(app, query.get('path'))));
    },
  },
  {
    method: 'POST',
    path: '/api/project/mocks/store',
    summary: 'Create an empty mock store',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      if (existsSync(abs)) throw new HttpError(409, 'A file with that name already exists');
      const target = typeof body.target === 'string' && body.target ? body.target : undefined;
      await saveStore(abs, emptyStore(target));
      sendJson(res, 200, await storeView(app, abs));
    },
  },
  {
    method: 'PUT',
    path: '/api/project/mocks/recording',
    summary: 'Edit the recorded response of one interaction',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      const store = await loadStore(abs);
      const rec = store.recordings.find((r) => r.id === body.id);
      if (!rec) throw new HttpError(404, 'Interaction not found');
      if (rec.response.bodyEncoding === 'base64' && typeof (body.response as Record<string, unknown>)?.body === 'string') throw new HttpError(400, 'Binary bodies cannot be edited here');
      const parsed = RecordedResponse.safeParse({ ...rec.response, ...(body.response as Record<string, unknown>), bodyEncoding: rec.response.bodyEncoding });
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      if (isJsonContentType(parsed.data.headers['content-type']) && parsed.data.body) {
        try {
          JSON.parse(parsed.data.body);
        } catch {
          throw new HttpError(400, 'The body is not valid JSON but the content type says JSON');
        }
      }
      rec.response = parsed.data;
      store.updatedAt = new Date().toISOString();
      await saveStore(abs, store);
      sendJson(res, 200, await storeView(app, abs));
    },
  },
  {
    method: 'DELETE',
    path: '/api/project/mocks/recording',
    summary: 'Delete one interaction',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      const store = await loadStore(abs);
      const n = store.recordings.length;
      store.recordings = store.recordings.filter((r) => r.id !== body.id);
      if (store.recordings.length === n) throw new HttpError(404, 'Interaction not found');
      store.updatedAt = new Date().toISOString();
      await saveStore(abs, store);
      sendJson(res, 200, await storeView(app, abs));
    },
  },
  {
    method: 'PUT',
    path: '/api/project/mocks/faults',
    summary: 'Save the fault rules of a store (latency, status, corrupt body, drop; each can be toggled)',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      const rules = Array.isArray(body.rules) ? body.rules : [];
      const entries: FaultEntry[] = rules.map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        const e: FaultEntry = { enabled: o.enabled !== false, method: String(o.method ?? '*').toUpperCase(), path: String(o.path ?? '') };
        for (const k of ['latencyMs', 'status', 'probability'] as const) if (o[k] !== undefined && o[k] !== '' && o[k] !== null) e[k] = Number(o[k]);
        for (const k of ['corruptBody', 'drop'] as const) if (o[k] === true) e[k] = true;
        return e;
      });
      try {
        parseFaultRules(entries.map(({ enabled: _e, ...x }) => x as unknown as FaultRuleInput));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await writeFile(abs.replace(/\.json$/i, FAULTS_SUFFIX), JSON.stringify({ rules: entries }, null, 2) + '\n');
      sendJson(res, 200, await storeView(app, abs));
    },
  },
  {
    method: 'POST',
    path: '/api/project/mocks/capture',
    summary: 'Record GET interactions from the target into a store (auth as a role, secrets redacted)',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      const store = existsSync(abs) ? await loadStore(abs) : emptyStore();
      const target = await targetOf(app, store, body.target);
      const paths = (Array.isArray(body.paths) ? body.paths : []).map(String).map((p) => p.trim()).filter(Boolean);
      if (!paths.length || paths.length > 50) throw new HttpError(400, 'Give 1 to 50 paths to capture');
      const token = await tokenFor(app, body.role);
      const loaded = await app.config();
      const captured: Array<{ path: string; status: number }> = [];
      for (const p of paths) {
        if (!p.startsWith('/')) throw new HttpError(400, `Paths start with "/": ${p}`);
        const url = new URL(p, target);
        let r: Response;
        try {
          r = await fetch(url, { headers: { accept: 'application/json, */*', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000) });
        } catch (e) {
          throw new HttpError(502, loaded.masker.mask(`Capture of ${p} failed: ${(e as Error).message}`));
        }
        const bytes = Buffer.from(await r.arrayBuffer());
        const headers = storableResponseHeaders(headersOf(r));
        let enc = encodeBody(bytes, headers['content-type']);
        if (enc.bodyEncoding === 'utf8' && isJsonContentType(headers['content-type'])) {
          try {
            enc = { body: JSON.stringify(redactJsonValue(JSON.parse(enc.body))), bodyEncoding: 'utf8' };
          } catch {
            // keep as is
          }
        }
        enc.body = loaded.masker.mask(enc.body);
        const query = normalizeQuery(url.search.replace(/^\?/, ''));
        store.recordings = store.recordings.filter((x) => !(x.request.method === 'GET' && x.request.path === url.pathname && x.request.query === query));
        store.recordings.push({
          id: `rec-${Date.now().toString(36)}-${store.recordings.length + 1}`,
          request: { method: 'GET', path: url.pathname, query, headers: { accept: 'application/json, */*' } },
          response: { status: r.status, headers, ...enc },
          recordedAt: new Date().toISOString(),
        });
        captured.push({ path: p, status: r.status });
      }
      store.target ??= target;
      store.updatedAt = new Date().toISOString();
      await saveStore(abs, store);
      sendJson(res, 200, { captured, store: await storeView(app, abs) });
    },
  },
  {
    method: 'POST',
    path: '/api/project/mocks/server',
    summary: 'Start a replay server for a store (with its enabled fault rules)',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      const map = serversOf(app);
      if (map.has(abs)) throw new HttpError(409, 'A replay server is already running for this store');
      const port = body.port === undefined || body.port === '' ? 0 : Number(body.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HttpError(400, 'Invalid port');
      const faults = activeFaults(await readFaults(abs));
      let server: MockServer;
      try {
        server = await createMockServer({ mode: 'replay', store: abs, port, faults, host: '127.0.0.1' });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      map.set(abs, { server, startedAt: new Date().toISOString(), faults: faults.length });
      app.hub.publish('project', { type: 'mock-server', path: relPosix(app.cwd, abs), state: 'started', url: server.url });
      sendJson(res, 200, await storeView(app, abs));
    },
  },
  {
    method: 'DELETE',
    path: '/api/project/mocks/server',
    summary: 'Stop the replay server of a store',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      const s = serversOf(app).get(abs);
      if (!s) throw new HttpError(404, 'No replay server is running for this store');
      await s.server.close();
      serversOf(app).delete(abs);
      app.hub.publish('project', { type: 'mock-server', path: relPosix(app.cwd, abs), state: 'stopped' });
      sendJson(res, 200, await storeView(app, abs));
    },
  },
  {
    method: 'POST',
    path: '/api/project/mocks/drift',
    summary: 'Re-send recorded GETs to the real target and report response-shape drift',
    async handler({ res, app, body }) {
      const abs = storePath(app, body.path);
      const store = await loadStore(abs);
      const target = await targetOf(app, store, body.target);
      const token = await tokenFor(app, body.role);
      const loaded = await app.config();
      try {
        const r = await checkDrift(store, target, { auth: token ? { bearer: token } : undefined, timeoutMs: 15_000 });
        sendJson(res, 200, loaded.masker.maskDeep(r));
      } catch (e) {
        throw new HttpError(422, loaded.masker.mask((e as Error).message));
      }
    },
  },
];

