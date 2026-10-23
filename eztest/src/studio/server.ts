/**
 * EZTest Studio HTTP server: a token-protected JSON API, one multiplexed SSE
 * event stream and the client bundle. Binds 127.0.0.1 by default, refuses
 * foreign Host/Origin headers, requires the session token on every API call
 * and confines all file access to the project directory.
 *
 * Endpoints live in feature modules under `routes/` and are dispatched by the
 * route registry (`router.ts`), which applies the access policy in one place.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { enableAddons } from '../engine/index.js';
import { StudioApp } from './app.js';
import { loadClient } from './bundle.js';
import { HttpError, baseHeaders, sendError, sendJson } from './http.js';
import { Router, dispatch } from './router.js';
import { DebugSessionManager } from './debug-session.js';
import { DebugInsight } from './debug-insight.js';
import { debugRoutes } from './routes/debug.js';
import { debugToolRoutes } from './routes/debug-tools.js';
import { traceToolRoutes } from './routes/trace-tools.js';
import { coreRoutes, type StudioRoute } from './routes/index.js';
import { fromRouteDefs } from './routes/route.js';
import { traceRoutes } from './routes/trace.js';
import type { RouteDef } from './routes/types.js';
import { loadStudioConfig } from './runs.js';
import { attachScm } from './scm.js';
import { TOKEN_HEADER, allowedHostnames, hostAllowed, newToken, originAllowed, PathError } from './security.js';

export interface StudioOptions {
  /** Project directory (where eztest.config.yaml lives). */
  cwd: string;
  /** Port; 0 (default) picks a free port. */
  port?: number;
  /** Interface to bind. Default 127.0.0.1. */
  host?: string;
  /** Open the default browser at the Studio URL. Default false. */
  openBrowser?: boolean;
  /** Environment used for config interpolation and secrets. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Launch recordings headless unless the request says otherwise (tests/CI). Default false. */
  recordHeadless?: boolean;
  /** Fixed token (tests). Default: random 256-bit. */
  token?: string;
  /** Watch the journeys directory for changes on disk. Default true. */
  watch?: boolean | { poll?: boolean; pollMs?: number };
  /** Extra route modules (feature add-ons); they take precedence over built-in routes with the same method and path. */
  routes?: StudioRoute[];
  /** Extra framework-agnostic route definitions (routes/types.ts), mounted with the same auth and body parsing. */
  routeDefs?: RouteDef[];
  /** Called once the services exist and before the server listens (register topics, cleanups, ...). */
  setup?: (app: StudioApp) => void | Promise<void>;
}

export interface StudioHandle {
  /** URL with the session token, to open in a browser. */
  url: string;
  /** Base URL without token. */
  origin: string;
  token: string;
  port: number;
  /** The Studio's services (event hub, run manager, watcher, ...). */
  app: StudioApp;
  close(): Promise<void>;
}

function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    const child = execFile(cmd, args, () => undefined);
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // no browser opener; the URL is printed by the CLI
  }
}

export async function startStudio(opts: StudioOptions): Promise<StudioHandle> {
  const cwd = realpathSync(resolve(opts.cwd));
  const host = opts.host ?? '127.0.0.1';
  const env = opts.env ?? process.env;
  const token = opts.token ?? newToken();
  if (token.length < 32) throw new Error('Studio token must be at least 32 characters');

  // Add-on phrasings (e.g. Dynamics 365) must be registered before journeys are parsed.
  let addons: { d365?: unknown; off(): void } = { off: () => {} };
  try {
    const loaded = await loadStudioConfig({ cwd, env, addons });
    addons = await enableAddons(loaded, { cwd });
  } catch {
    // Config problems are shown in Settings; the Studio still starts.
  }
  const app = new StudioApp({ cwd, env, token, recordHeadless: opts.recordHeadless, watch: opts.watch }, addons);
  const router = new Router<StudioApp>().add(coreRoutes(token)).add({
    method: 'GET',
    path: '/api/routes',
    summary: 'This list',
    handler: ({ res }) => sendJson(res, 200, { routes: router.list() }),
  });
  // Live debugger and time-travel trace (docs/studio-debug-trace.md).
  const debug = new DebugSessionManager(app.ctx);
  app.debug = debug;
  app.onClose(() => debug.close());
  const insight = new DebugInsight(debug);
  app.onClose(() => insight.close());
  router.add(fromRouteDefs([...debugRoutes(debug), ...debugToolRoutes(debug, insight), ...traceRoutes({ outputDir: () => app.outputDir(), cwd })]));
  router.add(traceToolRoutes(app));
  // Heal accepted / baselines approved / quarantine -> pull request proposals (docs/git.md).
  attachScm(app);
  if (opts.routeDefs?.length) router.add(fromRouteDefs(opts.routeDefs));
  if (opts.routes?.length) router.add(opts.routes);
  await opts.setup?.(app);
  await app.startWatching();
  // Warm the client bundle so the first page load is quick (errors surface on request).
  void loadClient().catch(() => undefined);

  let port = 0;
  let hostnames = allowedHostnames(host);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    baseHeaders(res);
    if (!hostAllowed(req, hostnames, port)) return sendError(res, 403, 'Forbidden host');
    if (!originAllowed(req, hostnames, port)) return sendError(res, 403, 'Forbidden origin');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      if (await dispatch(router, req, res, url, app, app)) return;
      if (url.pathname.startsWith('/api/')) {
        // Unknown endpoints still require the token, so they reveal nothing.
        const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
        if (isWrite && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
          return sendError(res, 415, 'Content-Type must be application/json');
        }
        if (!app.authed(req, !isWrite)) return sendError(res, 401, isWrite ? 'Missing or invalid session token header' : 'Missing or invalid session token');
        return sendError(res, 404, 'Unknown API endpoint');
      }
      if (url.pathname.startsWith('/runs/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Read-only');
        if (!app.authed(req, true)) return sendError(res, 401, 'Missing or invalid session token');
        return sendError(res, 404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
      return sendError(res, 404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return sendError(res, e.status, e.message, e.extra);
      if (e instanceof PathError) return sendError(res, e.status, e.message);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return sendError(res, 404, 'Not found');
      return sendError(res, 500, (e as Error).message ?? 'Internal error');
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolveListen());
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  hostnames = allowedHostnames(host);
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const origin = `http://${displayHost}:${port}`;
  const url = `${origin}/?token=${token}`;
  if (opts.openBrowser) openUrl(url);

  return {
    url,
    origin,
    token,
    port,
    app,
    async close() {
      await app.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export { TOKEN_HEADER };
