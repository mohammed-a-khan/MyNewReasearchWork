/**
 * Plugin pages (registerStudioPage): GET /api/plugins/pages lists them (empty
 * without plugins) and GET /api/plugins/pages/<id> serves one page's HTML with
 * a script-free CSP, shown by the client in a frame.
 */
import { registries } from '../../plugins/registry.js';
import type { StudioRoute } from './route.js';
import { HttpError, sendJson } from '../http.js';

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export const pluginRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/plugins/pages',
    summary: 'pages contributed by plugins',
    handler: ({ res }) => sendJson(res, 200, registries.studioPages.list().map((p) => ({ id: p.id, title: p.title }))),
  },
  {
    method: 'GET',
    path: /^\/api\/plugins\/pages\/([A-Za-z0-9._-]+)$/,
    summary: 'one plugin page (HTML)',
    async handler(ctx) {
      const page = registries.studioPages.get(ctx.params[0]);
      if (!page) throw new HttpError(404, 'No such plugin page');
      const html = await page.render({ cwd: ctx.app.cwd, query: ctx.query });
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'SAMEORIGIN', 'Content-Length': Buffer.byteLength(html) });
      ctx.res.end(html);
    },
  },
];
