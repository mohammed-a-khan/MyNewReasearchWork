/**
 * The Studio route registry. Feature modules (`routes/<feature>.ts`) export
 * route definitions; the router matches them and applies one access policy:
 *
 * - `auth: 'session'` (default): reads accept the session token as a header,
 *   bearer token or cookie; writes need a JSON content type and the token in a
 *   header (a cookie alone never authorizes a write, so CSRF cannot either).
 * - `auth: 'public'`: no token (static assets, the login-gated page itself).
 *
 * Host/Origin checks run before any route, in the server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendError } from './http.js';

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteContext<App = unknown> {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: Method;
  /** Decoded capture groups of a RegExp path (empty for string paths). */
  params: string[];
  /** Parsed JSON body for writes, `{}` for reads. */
  body: Record<string, unknown>;
  query: URLSearchParams;
  app: App;
}

export interface Route<App = unknown> {
  method: Method | Method[];
  /** Exact pathname, or a RegExp matched against the pathname (capture groups become `params`). */
  path: string | RegExp;
  auth?: 'session' | 'public';
  /** Skip JSON body parsing (e.g. a handler that streams). */
  rawBody?: boolean;
  /** Short description, listed by `GET /api/routes` for discoverability. */
  summary?: string;
  handler(ctx: RouteContext<App>): unknown | Promise<unknown>;
}

export interface Match<App> {
  route: Route<App>;
  params: string[];
}

export class Router<App> {
  private readonly routes: Array<Route<App>> = [];

  /** Register one or more routes. Later registrations win over earlier ones for the same method and path. */
  add(...routes: Array<Route<App> | Array<Route<App>>>): this {
    for (const r of routes.flat()) this.routes.unshift(r);
    return this;
  }

  list(): Array<{ method: string[]; path: string; summary?: string }> {
    return [...this.routes].reverse().map((r) => ({ method: methods(r), path: String(r.path), summary: r.summary }));
  }

  /** Find the route for a request; `allowed` lists methods registered for the path when none matches the method. */
  match(method: string, pathname: string): { hit?: Match<App>; allowed: string[] } {
    const allowed = new Set<string>();
    const m = method === 'HEAD' ? ['HEAD', 'GET'] : [method];
    for (const r of this.routes) {
      const params = matchPath(r.path, pathname);
      if (!params) continue;
      const rm = methods(r);
      if (rm.some((x) => m.includes(x))) return { hit: { route: r, params }, allowed: [] };
      rm.forEach((x) => allowed.add(x));
    }
    return { allowed: [...allowed] };
  }
}

function methods(r: Route<unknown>): string[] {
  return Array.isArray(r.method) ? r.method : [r.method];
}

function matchPath(path: string | RegExp, pathname: string): string[] | undefined {
  if (typeof path === 'string') return path === pathname ? [] : undefined;
  const m = path.exec(pathname);
  if (!m || m[0] !== pathname) return undefined;
  return m.slice(1).map((g) => {
    if (g === undefined) return '';
    try {
      return decodeURIComponent(g);
    } catch {
      throw new HttpError(400, 'Bad path encoding');
    }
  });
}

export interface AuthCheck {
  /** True when the request carries the session token (cookie allowed only when `allowCookie`). */
  authed(req: IncomingMessage, allowCookie: boolean): boolean;
}

/**
 * Apply the access policy and run a matched route. Returns false when nothing
 * matched (and nothing was sent), so the caller can fall through.
 */
export async function dispatch<App>(
  router: Router<App>,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  app: App,
  auth: AuthCheck,
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase() as Method;
  const { hit, allowed } = router.match(method, url.pathname);
  if (!hit) {
    if (!allowed.length) return false;
    res.setHeader('Allow', allowed.join(', '));
    sendError(res, 405, url.pathname.startsWith('/runs/') ? 'Read-only' : 'Method not allowed');
    return true;
  }
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if ((hit.route.auth ?? 'session') === 'session') {
    if (isWrite) {
      const ct = String(req.headers['content-type'] ?? '');
      if (!/^application\/json\b/i.test(ct)) {
        sendError(res, 415, 'Content-Type must be application/json');
        return true;
      }
      if (!auth.authed(req, false)) {
        sendError(res, 401, 'Missing or invalid session token header');
        return true;
      }
    } else if (!auth.authed(req, true)) {
      sendError(res, 401, 'Missing or invalid session token');
      return true;
    }
  }
  const body = isWrite && !hit.route.rawBody ? await readJson(req) : {};
  await hit.route.handler({ req, res, url, method, params: hit.params, body, query: url.searchParams, app });
  if (!res.writableEnded && !res.headersSent) sendError(res, 500, 'Route sent no response');
  return true;
}
