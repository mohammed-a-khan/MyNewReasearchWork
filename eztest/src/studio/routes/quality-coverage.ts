/** Quality › Coverage: combined coverage, the UI coverage map with heat overlays, trends and exports. */
import { HttpError, sendJson } from '../http.js';
import { coverageCsv, coverageFor, coverageOverlay, coverageOverview, coveragePage, coverageTrend } from '../quality/coverage.js';
import { SNAPSHOT_CSP } from './trace.js';
import type { StudioRoute } from './route.js';

function route(q: URLSearchParams): string {
  const r = q.get('route');
  if (!r || r.length > 500) throw new HttpError(400, '"route" is required');
  return r;
}

export const qualityCoverageRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/coverage',
    summary: 'Combined coverage (UI, requirements, API, risk, change, manual), the UI coverage map and failure tags (?run= for one run)',
    async handler({ res, app, query }) {
      sendJson(res, 200, await coverageOverview(app, query.get('run') ?? undefined));
    },
  },
  {
    method: 'GET',
    path: '/api/quality/coverage/page',
    summary: 'One page of the UI coverage map: elements, journeys, representative snapshot (?route=)',
    async handler({ res, app, query }) {
      sendJson(res, 200, await coveragePage(app, route(query), query.get('run') ?? undefined));
    },
  },
  {
    method: 'GET',
    path: '/api/quality/coverage/overlay',
    summary: 'The page\'s DOM snapshot with the coverage heat overlay, as sandboxed HTML (?route=&focus=)',
    async handler({ res, app, query }) {
      const html = await coverageOverlay(app, route(query), { runId: query.get('run') ?? undefined, focus: query.get('focus') ?? undefined });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SNAPSHOT_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(html);
    },
  },
  {
    method: 'GET',
    path: '/api/quality/coverage/trend',
    summary: 'UI coverage and accessibility issues over recent runs (?n=20)',
    async handler({ res, app, query }) {
      const n = Math.min(100, Math.max(2, Number(query.get('n') ?? 20) || 20));
      sendJson(res, 200, await coverageTrend(app, n));
    },
  },
  {
    method: 'GET',
    path: /^\/api\/quality\/coverage\/export\.(csv|json)$/,
    summary: 'Export the UI coverage map (CSV: one row per element) or the whole coverage view (JSON)',
    async handler({ res, app, params, query }) {
      const c = await coverageFor(app, query.get('run') ?? undefined);
      const m = (await app.config().catch(() => undefined))?.masker;
      const stamp = new Date().toISOString().slice(0, 10);
      const csv = params[0] === 'csv';
      const data = Buffer.from(csv ? coverageCsv(m ? m.maskDeep(c) : c) : JSON.stringify(m ? m.maskDeep(c) : c, null, 2), 'utf8');
      res.writeHead(200, {
        'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': data.length,
        'Content-Disposition': `attachment; filename="coverage-${stamp}.${params[0]}"`,
      });
      res.end(data);
    },
  },
];
