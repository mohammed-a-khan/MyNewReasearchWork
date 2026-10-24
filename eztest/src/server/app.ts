/**
 * `eztest server`: the optional central results service for teams.
 *
 * Security model:
 * - Every request is anonymous unless it carries an API token
 *   (`Authorization: Bearer ezt_...`) or a session cookie from OIDC sign-in.
 * - Cookie-authenticated writes need the session's CSRF token (header
 *   `X-CSRF-Token`, or `_csrf` in a form) and a same-origin `Origin`.
 * - HTML pages carry a strict CSP (no scripts at all, styles from 'self');
 *   uploaded run files are served sandboxed.
 * - Sign-in and failed-token paths are rate limited per client address.
 * - Logs are structured JSON with no query strings, headers, cookies or tokens.
 * - TLS: pass `tls.cert`/`tls.key`, or terminate TLS at a proxy and set
 *   `trustProxy: true` (see docs/server.md).
 */
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, relative, isAbsolute } from 'node:path';
import type { AddressInfo } from 'node:net';
import { EZTEST_VERSION } from '../ops/version.js';
import { createJsonLogger, type JsonLogger } from '../ops/log.js';
import {
  can, clientAddress, cookieHeader, cookies, createSession, createToken, deleteSession, grantsForSubjects, isRole, listTokens, loadSession,
  principalFromToken, RateLimiter, revokeToken, roleFor, safeEqual, setGrant, sha256hex, subjectsOf, tokenGrants, CSRF_COOKIE, SESSION_COOKIE,
  type Action, type Grant, type Principal, type UserProfile,
} from './auth.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { ContractRegistry } from './contracts.js';
import { SharedDataRegistry } from './datastore.js';
import { OidcClient, OidcError, safeNext } from './oidc.js';
import { checkName, isStateKind, ResultsService, ServiceError } from './service.js';
import { Store, type DbConnectionSpec } from './store.js';
import { renderPage, SERVER_CSS, type UiContext } from './ui.js';

export interface ServerOptions {
  config: ServerConfig & { baseDir?: string };
  /** Bootstrap admin token (EZTEST_SERVER_BOOTSTRAP_TOKEN): lets the first admin create real tokens. Never stored. */
  bootstrapToken?: string;
  /** Override fetch for OIDC (tests). */
  fetch?: typeof fetch;
  logger?: JsonLogger;
  /** Run the periodic retention sweep (default true). */
  retentionTimer?: boolean;
}

export interface ServerHandle {
  url: string;
  port: number;
  service: ResultsService;
  store: Store;
  close(): Promise<void>;
}

const HTML_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'";
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Principal;
  session?: { id: string; csrf: string };
  ip: string;
}

type Handler = (c: Ctx) => Promise<unknown> | unknown;
interface Route {
  method: string;
  path: RegExp;
  handler: Handler;
  /** Writes without a JSON body (uploads). */
  raw?: boolean;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage, max = 64 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const type = String(req.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

export async function startResultsServer(o: ServerOptions): Promise<ServerHandle> {
  const cfg = o.config;
  const log = o.logger ?? createJsonLogger({ level: cfg.logLevel, base: { service: 'eztest-server' } });
  await mkdir(cfg.dataDir, { recursive: true });
  const dbSpec: DbConnectionSpec = cfg.database.driver === 'sqlite'
    ? { driver: 'sqlite', file: cfg.database.file ? resolve(cfg.baseDir ?? process.cwd(), cfg.database.file) : join(cfg.dataDir, 'eztest.db') }
    : (cfg.database as unknown as DbConnectionSpec);
  const store = await Store.open(dbSpec);
  const service = new ResultsService(store, cfg.dataDir, { maxUploadBytes: cfg.maxUploadMb * 1024 * 1024, retention: cfg.retention, ...(cfg.auditKeyFile ? { auditKeyFile: cfg.auditKeyFile } : {}) });
  const contracts = new ContractRegistry(store, service.audit, (p) => service.ensureProject(p));
  const shared = new SharedDataRegistry(store, service.audit, (p) => service.ensureProject(p));
  const bootstrapHash = o.bootstrapToken ? sha256hex(o.bootstrapToken) : undefined;
  const authLimiter = new RateLimiter(cfg.authRateLimit, cfg.authRateLimit);
  const secure = !!cfg.tls || (cfg.publicUrl?.startsWith('https:') ?? false);
  let oidc: OidcClient | undefined;
  let baseUrl = '';

  const principalFor = async (req: IncomingMessage, ip: string): Promise<{ who: Principal; session?: { id: string; csrf: string } }> => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      const p = await principalFromToken(store, token, bootstrapHash);
      if (!p) {
        if (!authLimiter.take(`token:${ip}`)) throw new HttpError(429, 'Too many failed authentication attempts');
        throw new HttpError(401, 'Invalid or expired token');
      }
      return { who: p };
    }
    const sid = cookies(req)[SESSION_COOKIE];
    if (sid) {
      const s = await loadSession(store, sid);
      if (s) {
        const profile = s.profile as unknown as UserProfile & { tokenId?: string };
        // Dashboard sessions opened with an API token keep that token's grants (and end when it is revoked).
        const grants = profile.tokenId ? await tokenGrants(store, profile.tokenId, !!bootstrapHash) : await grantsForSubjects(store, subjectsOf(profile), cfg.access);
        if (!grants) {
          await deleteSession(store, sid);
          return { who: { kind: 'anonymous', id: 'anonymous', name: 'anonymous', grants: cfg.anonymousRead ? [{ project: '*', role: 'viewer' }] : [] } };
        }
        return { who: { kind: 'user', id: s.subject, name: profile.name ?? profile.email ?? profile.sub, grants, csrf: s.csrf }, session: { id: sid, csrf: s.csrf } };
      }
    }
    const grants: Grant[] = cfg.anonymousRead ? [{ project: '*', role: 'viewer' }] : [];
    return { who: { kind: 'anonymous', id: 'anonymous', name: 'anonymous', grants } };
  };

  const need = (c: Ctx, project: string, action: Action) => {
    if (!can(c.who, project, action)) {
      if (c.who.kind === 'anonymous') throw new HttpError(401, 'Sign in or send an API token');
      throw new HttpError(403, `Your role on ${project} (${roleFor(c.who, project) ?? 'none'}) does not allow ${action}`);
    }
  };
  const project = (c: Ctx, i = 0) => checkName('project', c.params[i]);
  const visibleProjects = async (who: Principal) => (await service.projects()).filter((p) => can(who, p.project, 'read'));

  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, raw = false) =>
    routes.push({ method, path: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler, raw });

  // ---------------------------------------------------------------- health
  add('GET', '/healthz', () => ({ status: 'ok' }));
  add('GET', '/readyz', async () => {
    const ok = await store.ping();
    if (!ok) throw new HttpError(503, 'database unavailable');
    return { status: 'ready', database: store.dialect };
  });
  add('GET', '/api/version', () => ({ name: 'eztest-server', version: EZTEST_VERSION, apiVersion: 1 }));

  // ---------------------------------------------------------------- sign-in
  add('GET', '/auth/login', async (c) => {
    if (!authLimiter.take(`login:${c.ip}`)) throw new HttpError(429, 'Too many sign-in attempts');
    if (!oidc) throw new HttpError(404, 'OIDC sign-in is not configured');
    const { url } = await oidc.begin(c.url.searchParams.get('next') ?? '/ui');
    c.res.writeHead(302, { Location: url });
    c.res.end();
  });
  add('GET', '/auth/callback', async (c) => {
    if (!authLimiter.take(`login:${c.ip}`)) throw new HttpError(429, 'Too many sign-in attempts');
    if (!oidc) throw new HttpError(404, 'OIDC sign-in is not configured');
    const code = c.url.searchParams.get('code');
    const state = c.url.searchParams.get('state');
    if (!code || !state) throw new HttpError(400, c.url.searchParams.get('error') ? `Sign-in failed: ${c.url.searchParams.get('error')}` : 'Missing code or state');
    let r;
    try {
      r = await oidc.complete(code, state);
    } catch (e) {
      throw new HttpError(e instanceof OidcError ? 401 : 502, e instanceof OidcError ? e.message : 'Identity provider error');
    }
    const profile: UserProfile = { sub: r.claims.sub, email: r.claims.email, name: r.claims.name, groups: r.claims.groups };
    const subject = profile.email ? `user:${profile.email.toLowerCase()}` : `sub:${profile.sub}`;
    const s = await createSession(store, subject, profile, cfg.sessionHours * 3_600_000);
    await service.audit.append({ actor: subject, action: 'auth.login', details: { method: 'oidc' } });
    c.res.writeHead(302, { Location: r.next, 'Set-Cookie': cookieHeader(SESSION_COOKIE, s.id, { secure, maxAgeS: Math.round(cfg.sessionHours * 3600) }) });
    c.res.end();
  });
  add('POST', '/auth/token', async (c) => {
    // Sign in to the dashboards with an API token (when no OIDC provider is configured).
    if (!authLimiter.take(`login:${c.ip}`)) throw new HttpError(429, 'Too many sign-in attempts');
    const body = await readBody(c.req, 16 * 1024);
    const pre = cookies(c.req)[CSRF_COOKIE];
    if (!pre || typeof body._csrf !== 'string' || !safeEqual(pre, body._csrf)) throw new HttpError(403, 'CSRF check failed');
    const p = await principalFromToken(store, String(body.token ?? ''), bootstrapHash);
    if (!p) throw new HttpError(401, 'Invalid token');
    const s = await createSession(store, p.id, { sub: p.id, name: p.name, groups: [], tokenId: p.id.split(':')[1] }, cfg.sessionHours * 3_600_000);
    c.res.writeHead(303, { Location: safeNext(String(body.next ?? '/ui')), 'Set-Cookie': cookieHeader(SESSION_COOKIE, s.id, { secure, maxAgeS: Math.round(cfg.sessionHours * 3600) }) });
    c.res.end();
  });
  add('POST', '/auth/logout', async (c) => {
    if (c.session) await deleteSession(store, c.session.id);
    c.res.writeHead(303, { Location: '/login', 'Set-Cookie': cookieHeader(SESSION_COOKIE, '', { secure, maxAgeS: 0 }) });
    c.res.end();
  });
  add('GET', '/api/me', (c) => ({ id: c.who.id, kind: c.who.kind, name: c.who.name, grants: c.who.grants, csrf: c.session?.csrf }));

  // ---------------------------------------------------------------- projects and runs
  add('GET', '/api/projects', async (c) => visibleProjects(c.who));
  add('POST', '/api/projects/:p/runs', async (c) => {
    const p = project(c);
    need(c, p, 'run.publish');
    return service.beginRun(p, (await readBody(c.req)) as never, c.who);
  });
  add('PUT', '/api/projects/:p/runs/:id/files', async (c) => {
    const p = project(c);
    need(c, p, 'run.publish');
    return service.putFile(p, checkName('run id', c.params[1]), c.url.searchParams.get('path') ?? '', c.req);
  }, true);
  add('POST', '/api/projects/:p/runs/:id/complete', async (c) => {
    const p = project(c);
    need(c, p, 'run.publish');
    return service.completeRun(p, checkName('run id', c.params[1]), c.who);
  });
  add('GET', '/api/projects/:p/runs', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    return service.listRuns(p, Number(c.url.searchParams.get('limit') ?? 50), Number(c.url.searchParams.get('offset') ?? 0));
  });
  add('GET', '/api/projects/:p/runs/:id', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    const r = await service.getRun(p, checkName('run id', c.params[1]));
    if (!r) throw new HttpError(404, 'Unknown run');
    return r;
  });
  add('GET', '/api/projects/:p/runs/:id/journeys', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    return service.runJourneys(p, checkName('run id', c.params[1]), Number(c.url.searchParams.get('limit') ?? 500), Number(c.url.searchParams.get('offset') ?? 0));
  });
  add('GET', '/api/projects/:p/runs/:id/files', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    serveRunFile(c, service.runDir(p, checkName('run id', c.params[1])), c.url.searchParams.get('path') ?? 'report.html');
  });
  add('POST', '/api/projects/:p/runs/:id/sign', async (c) => {
    const p = project(c);
    need(c, p, 'readiness.sign');
    const b = await readBody(c.req);
    return service.signReadiness(p, checkName('run id', c.params[1]), String(b.note ?? ''), c.who);
  });
  add('PUT', '/api/projects/:p/runs/:id/pack', async (c) => {
    const p = project(c);
    need(c, p, 'pack.upload');
    return service.putPack(p, checkName('run id', c.params[1]), c.req, c.who);
  }, true);
  add('GET', '/api/projects/:p/runs/:id/pack', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    const f = service.packPath(p, checkName('run id', c.params[1]));
    if (!existsSync(f)) throw new HttpError(404, 'No evidence pack for this run');
    c.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${c.params[1]}.zip"`, 'Content-Security-Policy': FILE_CSP });
    createReadStream(f).pipe(c.res);
  });

  // ---------------------------------------------------------------- insights
  const read = (path: string, fn: (p: string, c: Ctx) => Promise<unknown>) =>
    add('GET', path, async (c) => {
      const p = project(c);
      need(c, p, 'read');
      return fn(p, c);
    });
  read('/api/projects/:p/history', async (p) => ({ version: 1, runs: await service.history(p) }));
  read('/api/projects/:p/durations', async (p, c) => service.durations(p, Number(c.url.searchParams.get('window') ?? 10)));
  read('/api/projects/:p/flaky', async (p) => service.flaky(p));
  read('/api/projects/:p/traceability', async (p) => service.traceability(p));
  read('/api/projects/:p/heals', async (p) => service.heals(p));
  add('GET', '/api/projects/:p/trends.csv', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${p}-trends.csv"` });
    c.res.end(await service.trendsCsv(p));
  });

  // ---------------------------------------------------------------- shared state
  add('GET', '/api/projects/:p/state/:kind', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    if (!isStateKind(c.params[1])) throw new HttpError(404, 'Unknown state kind');
    return service.getState(p, c.params[1]);
  });
  add('POST', '/api/projects/:p/state/:kind', async (c) => {
    const p = project(c);
    const kind = c.params[1];
    if (!isStateKind(kind)) throw new HttpError(404, 'Unknown state kind');
    need(c, p, kind === 'heal-decisions' ? 'heal.decide' : kind === 'quarantine' ? 'quarantine.change' : 'triage.override');
    const b = await readBody(c.req);
    if (b.upsert !== undefined && !Array.isArray(b.upsert)) throw new HttpError(400, '"upsert" must be a list');
    if (b.remove !== undefined && !Array.isArray(b.remove)) throw new HttpError(400, '"remove" must be a list');
    return service.changeState(p, kind, { upsert: b.upsert as unknown[] | undefined, remove: (b.remove as unknown[] | undefined)?.map(String) }, c.who);
  });

  // ---------------------------------------------------------------- locks
  add('POST', '/api/projects/:p/locks/:op', async (c) => {
    const p = project(c);
    need(c, p, 'lock.use');
    const b = await readBody(c.req);
    const key = String(b.key ?? '');
    if (c.params[1] === 'acquire') {
      const r = await service.acquireLock(p, key, String(b.owner ?? c.who.id).slice(0, 200), Number(b.ttlMs ?? 120_000));
      if ('holder' in r) {
        c.res.statusCode = 409;
        return { acquired: false, ...r };
      }
      return { acquired: true, ...r };
    }
    if (c.params[1] === 'renew') return { renewed: await service.renewLock(p, key, String(b.token ?? ''), Number(b.ttlMs ?? 120_000)) };
    if (c.params[1] === 'release') return { released: await service.releaseLock(p, key, String(b.token ?? '')) };
    throw new HttpError(404, 'Unknown lock operation');
  });

  // ---------------------------------------------------------------- shared test data and deployment records
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  add('GET', '/api/projects/:p/store', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    return shared.list(p, c.url.searchParams.get('namespace') ?? undefined);
  });
  add('GET', '/api/projects/:p/store/:ns/:key', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    const e = await shared.get(p, c.params[1], c.params[2]);
    if (!e) throw new HttpError(404, `No "${c.params[2]}" in namespace "${c.params[1]}"`);
    return e;
  });
  add('PUT', '/api/projects/:p/store/:ns/:key', async (c) => {
    const p = project(c);
    need(c, p, 'store.write');
    return shared.put(p, c.params[1], c.params[2], await readBody(c.req, 1024 * 1024), c.who);
  });
  add('DELETE', '/api/projects/:p/store/:ns/:key', async (c) => {
    const p = project(c);
    need(c, p, 'store.write');
    return { deleted: await shared.delete(p, c.params[1], c.params[2], c.who) };
  });
  add('POST', '/api/projects/:p/store-purge', async (c) => {
    const p = project(c);
    need(c, p, 'store.write');
    const b = await readBody(c.req, 16 * 1024);
    return { purged: await shared.purgeExpired(p, str(b.namespace) || undefined, c.who) };
  });
  add('GET', '/api/projects/:p/pools', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    return shared.pools(p, c.url.searchParams.get('namespace') ?? undefined);
  });
  add('GET', '/api/projects/:p/pools/:ns/:pool', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    return shared.items(p, c.params[1], c.params[2]);
  });
  add('POST', '/api/projects/:p/pools/:ns/:pool/:op', async (c) => {
    const p = project(c);
    need(c, p, 'store.write');
    const [, n, pool, op] = c.params;
    const b = await readBody(c.req, 16 * 1024 * 1024);
    if (op === 'items') return shared.add(p, n, pool, b, c.who);
    if (op === 'claim') {
      const item = await shared.claim(p, n, pool, str(b.owner), Number(b.leaseMs ?? 1_800_000), c.who);
      return item ? { claimed: true, item } : { claimed: false };
    }
    if (op === 'release') return { released: await shared.release(p, n, pool, str(b.id), str(b.owner), c.who) };
    if (op === 'consume') return { consumed: await shared.consume(p, n, pool, str(b.id), str(b.owner), c.who) };
    throw new HttpError(404, 'Unknown pool operation');
  });
  add('DELETE', '/api/projects/:p/pools/:ns/:pool/items/:id', async (c) => {
    const p = project(c);
    need(c, p, 'store.write');
    return { removed: await shared.remove(p, c.params[1], c.params[2], c.params[3], c.who) };
  });
  add('POST', '/api/projects/:p/deployments', async (c) => {
    const p = project(c);
    need(c, p, 'deployment.record');
    return shared.recordDeployment(p, await readBody(c.req, 4 * 1024 * 1024), c.who);
  });
  add('GET', '/api/projects/:p/deployments', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    const q = c.url.searchParams;
    return shared.deployments(p, { environment: q.get('environment') ?? undefined, version: q.get('version') ?? undefined, pipeline: q.get('pipeline') ?? undefined, limit: Number(q.get('limit') ?? 500) });
  });

  // ---------------------------------------------------------------- EZTest contracts
  add('POST', '/api/projects/:p/contracts', async (c) => {
    const p = project(c);
    need(c, p, 'run.publish');
    return contracts.publish(p, await readBody(c.req), c.who);
  });
  add('GET', '/api/projects/:p/contracts', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    const q = c.url.searchParams;
    return contracts.list(p, {
      provider: q.get('provider') ?? undefined, consumer: q.get('consumer') ?? undefined, branch: q.get('branch') ?? undefined,
      environment: q.get('environment') ?? undefined, withContracts: q.get('contracts') !== 'false',
    });
  });
  add('GET', '/api/projects/:p/contracts/:consumer/:provider/:version', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    const r = await contracts.get(p, c.params[1], c.params[2], c.params[3]);
    if (!r) throw new HttpError(404, 'Unknown contract');
    return r;
  });
  add('POST', '/api/projects/:p/verifications', async (c) => {
    const p = project(c);
    need(c, p, 'run.publish');
    return contracts.recordVerification(p, await readBody(c.req), c.who);
  });
  add('GET', '/api/projects/:p/verifications', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    return contracts.verifications(p, { provider: c.url.searchParams.get('provider') ?? undefined, providerVersion: c.url.searchParams.get('providerVersion') ?? undefined });
  });
  add('POST', '/api/projects/:p/releases', async (c) => {
    const p = project(c);
    need(c, p, 'contracts.release');
    return contracts.recordRelease(p, await readBody(c.req), c.who);
  });
  add('GET', '/api/projects/:p/releases', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    return contracts.releases(p);
  });
  add('GET', '/api/projects/:p/can-release', async (c) => {
    const p = project(c);
    need(c, p, 'read');
    const q = c.url.searchParams;
    return contracts.canRelease(p, { app: q.get('app'), version: q.get('version'), environment: q.get('environment') });
  });

  // ---------------------------------------------------------------- administration
  add('GET', '/api/audit', async (c) => {
    const p = c.url.searchParams.get('project') ?? undefined;
    if (p) need(c, checkName('project', p), 'audit.read');
    else need(c, '*', 'audit.read');
    return service.audit.list({ project: p, limit: Number(c.url.searchParams.get('limit') ?? 200), action: c.url.searchParams.get('action') ?? undefined });
  });
  add('POST', '/api/audit/rotate-key', async (c) => {
    need(c, '*', 'token.manage');
    return service.audit.rotateKey(c.who.id);
  });
  add('GET', '/api/audit/verify', async (c) => {
    need(c, '*', 'audit.read');
    return service.audit.verify();
  });
  add('GET', '/api/tokens', async (c) => {
    need(c, '*', 'token.manage');
    return listTokens(store);
  });
  add('POST', '/api/tokens', async (c) => {
    const b = await readBody(c.req);
    const grants = Array.isArray(b.grants) ? (b.grants as Array<Record<string, unknown>>) : [];
    if (!grants.length) throw new HttpError(400, 'A token needs at least one grant { project, role }');
    const clean: Grant[] = grants.map((g) => {
      if (!isRole(g.role)) throw new HttpError(400, `Unknown role ${String(g.role)}`);
      const proj = g.project === '*' ? '*' : checkName('project', String(g.project));
      need(c, proj, 'token.manage');
      return { project: proj, role: g.role };
    });
    const { token, record } = await createToken(store, { name: String(b.name ?? 'token').slice(0, 100), grants: clean, createdBy: c.who.id, expiresAt: typeof b.expiresAt === 'string' ? b.expiresAt : undefined });
    await service.audit.append({ actor: c.who.id, action: 'token.create', target: record.id, details: { name: record.name, grants: clean } });
    return { token, record };
  });
  add('DELETE', '/api/tokens/:id', async (c) => {
    need(c, '*', 'token.manage');
    const ok = await revokeToken(store, c.params[0]);
    if (ok) await service.audit.append({ actor: c.who.id, action: 'token.revoke', target: c.params[0] });
    return { revoked: ok };
  });
  add('PUT', '/api/projects/:p/access', async (c) => {
    const p = c.params[0] === '*' ? '*' : project(c);
    need(c, p, 'access.manage');
    const b = await readBody(c.req);
    const subject = String(b.subject ?? '');
    if (!/^(user:[^\s]+|sub:[^\s]+|group:[^\s]+|\*)$/.test(subject)) throw new HttpError(400, 'subject must be user:<email>, sub:<id>, group:<name> or *');
    if (!isRole(b.role)) throw new HttpError(400, 'role must be viewer, tester, approver or admin');
    await setGrant(store, { subject, project: p, role: b.role, by: c.who.id });
    await service.audit.append({ actor: c.who.id, action: 'access.grant', project: p, target: subject, details: { role: b.role } });
    return { subject, project: p, role: b.role };
  });
  add('PUT', '/api/projects/:p/retention', async (c) => {
    const p = project(c);
    need(c, p, 'retention.manage');
    const b = await readBody(c.req);
    const days = b.days === null ? null : Number(b.days);
    if (days !== null && (!Number.isInteger(days) || days < 1)) throw new HttpError(400, 'days must be a positive integer or null');
    await service.setRetention(p, days, c.who);
    return { project: p, days };
  });
  add('POST', '/api/retention/run', async (c) => {
    need(c, '*', 'retention.manage');
    return service.applyRetention(c.who);
  });

  // ---------------------------------------------------------------- web UI (read-only dashboards)
  add('GET', '/static/server.css', (c) => {
    c.res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    c.res.end(SERVER_CSS);
  });
  add('GET', '/', (c) => {
    c.res.writeHead(302, { Location: '/ui' });
    c.res.end();
  });
  const page = (path: string) =>
    add('GET', path, async (c) => {
      const ui: UiContext = { who: c.who, csrf: c.session?.csrf, oidc: !!oidc, service, params: c.params, query: c.url.searchParams, path: c.url.pathname };
      if (c.who.kind === 'anonymous' && !cfg.anonymousRead && path !== '/login') {
        c.res.writeHead(302, { Location: `/login?next=${encodeURIComponent(c.url.pathname)}` });
        c.res.end();
        return;
      }
      if (path === '/login') {
        // Pre-session CSRF token for the token sign-in form (double-submit cookie).
        const pre = cookies(c.req)[CSRF_COOKIE] ?? randomBytes(24).toString('base64url');
        ui.csrf = pre;
        c.res.setHeader('Set-Cookie', cookieHeader(CSRF_COOKIE, pre, { secure, maxAgeS: 3600 }));
      }
      const html = await renderPage(path, ui);
      if (html === undefined) throw new HttpError(404, 'Not found');
      if (typeof html === 'object') throw new HttpError(html.status, html.message);
      c.res.setHeader('Content-Security-Policy', HTML_CSP);
      send(c.res, 200, html, 'text/html; charset=utf-8');
    });
  page('/login');
  page('/ui');
  page('/ui/p/:p');
  page('/ui/p/:p/runs/:id');
  page('/ui/audit');

  // ---------------------------------------------------------------- dispatch
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const ip = clientAddress(req, cfg.trustProxy);
    let actor = 'anonymous';
    res.once('finish', () => log.info('request', { method: req.method, path: (req.url ?? '/').split('?')[0], status: res.statusCode, ms: Date.now() - started, actor }));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', API_CSP);
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://server.local');
    } catch {
      send(res, 400, { error: 'Bad request' });
      return;
    }
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    try {
      const matching = routes.filter((r) => r.path.test(url.pathname));
      const route = matching.find((r) => r.method === method);
      if (!route) throw new HttpError(matching.length ? 405 : 404, matching.length ? 'Method not allowed' : 'Not found');
      const params = (route.path.exec(url.pathname) ?? []).slice(1).map((s) => decodeURIComponent(s));
      const { who, session } = await principalFor(req, ip);
      actor = who.id;
      if (method !== 'GET' && session && who.kind === 'user') {
        // Cookie-authenticated write: same origin and the session CSRF token.
        const origin = req.headers.origin;
        if (origin && origin !== baseUrl && !(cfg.publicUrl && origin === new URL(cfg.publicUrl).origin)) throw new HttpError(403, 'Cross-origin request refused');
        const header = req.headers['x-csrf-token'];
        let token = typeof header === 'string' ? header : undefined;
        if (!token && String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded') && url.pathname === '/auth/logout') {
          const b = await readBody(req, 16 * 1024);
          token = typeof b._csrf === 'string' ? b._csrf : undefined;
        }
        if (!token || !safeEqual(token, session.csrf)) throw new HttpError(403, 'CSRF check failed');
      }
      const out = await route.handler({ req, res, url, params, who, session, ip });
      if (!res.headersSent && !res.writableEnded) send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError || e instanceof ServiceError ? e.status : 500;
      const message = status === 500 ? 'Internal error' : (e as Error).message;
      if (status === 500) log.error('request failed', { method, path: url.pathname, error: (e as Error).message });
      if (!res.headersSent) send(res, status, { error: message, ...((e as HttpError).extra ?? {}) });
      else res.end();
    }
  };

  let server: Server;
  if (cfg.tls) {
    const base = cfg.baseDir ?? process.cwd();
    server = createHttpsServer({ cert: await readFile(resolve(base, cfg.tls.cert)), key: await readFile(resolve(base, cfg.tls.key)) }, (q, s) => void handle(q, s));
  } else {
    server = createHttpServer((q, s) => void handle(q, s));
  }
  server.requestTimeout = 0; // large uploads
  server.headersTimeout = 30_000;
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(cfg.port, cfg.host, () => ok());
  });
  const port = (server.address() as AddressInfo).port;
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  baseUrl = `${cfg.tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const external = (cfg.publicUrl ?? baseUrl).replace(/\/$/, '');
  if (cfg.oidc) oidc = new OidcClient(cfg.oidc, `${external}/auth/callback`, o.fetch);

  let timer: NodeJS.Timeout | undefined;
  if (o.retentionTimer !== false && (cfg.retention.defaultDays || Object.keys(cfg.retention.projects).length)) {
    const system: Principal = { kind: 'token', id: 'system:retention', name: 'retention', grants: [{ project: '*', role: 'admin' }] };
    timer = setInterval(() => void service.applyRetention(system).catch((e: Error) => log.error('retention failed', { error: e.message })), cfg.retention.everyHours * 3_600_000);
    timer.unref();
  }
  log.info('server started', { url: baseUrl, database: store.dialect, oidc: !!oidc, tls: !!cfg.tls });
  return {
    url: baseUrl,
    port,
    service,
    store,
    async close() {
      if (timer) clearInterval(timer);
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await store.close();
    },
  };
}

function serveRunFile(c: Ctx, dir: string, rel: string): void {
  if (!rel || rel.includes('\0') || isAbsolute(rel) || rel.split('/').includes('..')) throw new HttpError(400, 'Invalid file path');
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  if (r.startsWith('..') || isAbsolute(r)) throw new HttpError(400, 'Invalid file path');
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, 'File not found (it may have been removed by the retention policy)');
  c.res.writeHead(200, { 'Content-Type': TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': FILE_CSP, 'Content-Length': statSync(abs).size });
  createReadStream(abs).pipe(c.res);
}

/** Load config from a file/flags and start (used by the CLI). */
export async function serveFromConfig(o: { file?: string; cwd?: string; env?: Record<string, string | undefined>; overrides?: Record<string, unknown> }): Promise<ServerHandle> {
  const config = await loadServerConfig(o);
  return startResultsServer({ config, bootstrapToken: (o.env ?? process.env).EZTEST_SERVER_BOOTSTRAP_TOKEN || undefined });
}
