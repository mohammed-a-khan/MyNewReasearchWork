/** Quality Center: requirements traceability matrix, requirement lists (CSV / ADO query) and exports. */
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseRequirementsCsv } from '../../insights/index.js';
import { HttpError, sendJson, str } from '../http.js';
import { publishQuality, qualityPaths, requireConfirm } from '../quality/common.js';
import { atomicWrite } from '../quality/heals.js';
import { fetchAdoRequirements, traceability, traceabilityHtml, traceabilityToCsv, traceabilityXlsx } from '../quality/traceability.js';
import type { StudioRoute } from './route.js';

function download(res: import('node:http').ServerResponse, name: string, type: string, data: Buffer | string): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${name}"`,
    // An exported HTML page is a download, never rendered inside the Studio origin.
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(buf);
}

export const qualityTraceabilityRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/traceability',
    summary: 'Requirements x journeys x latest status, with coverage gaps',
    async handler({ res, app }) {
      sendJson(res, 200, await traceability(app));
    },
  },
  {
    method: 'GET',
    path: /^\/api\/quality\/traceability\/export\.(csv|xlsx|html)$/,
    summary: 'Export the traceability matrix as CSV, XLSX or HTML',
    async handler({ res, app, params }) {
      const m = await traceability(app);
      const stamp = new Date().toISOString().slice(0, 10);
      if (params[0] === 'csv') return download(res, `traceability-${stamp}.csv`, 'text/csv; charset=utf-8', traceabilityToCsv(m));
      if (params[0] === 'xlsx') return download(res, `traceability-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await traceabilityXlsx(m));
      return download(res, `traceability-${stamp}.html`, 'text/html; charset=utf-8', traceabilityHtml(m));
    },
  },
  {
    method: 'PUT',
    path: '/api/quality/traceability/requirements',
    summary: 'Save the requirements list (CSV text) to .eztest/requirements.csv',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const csv = str(body.csv, 'csv');
      if (csv.length > 2_000_000) throw new HttpError(413, 'The list is too large');
      const reqs = parseRequirementsCsv(csv);
      if (!reqs.length) throw new HttpError(422, 'No requirement ids found (first column, or a column named id / requirement / key)');
      const p = (await qualityPaths(app)).requirementsCsv;
      await atomicWrite(p, csv.endsWith('\n') ? csv : `${csv}\n`);
      publishQuality(app, 'traceability', { action: 'requirements', count: reqs.length });
      sendJson(res, 200, { ok: true, count: reqs.length, path: app.rel(p) });
    },
  },
  {
    method: 'DELETE',
    path: '/api/quality/traceability/requirements',
    summary: 'Remove the saved requirement lists (CSV and cached ADO results)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const p = await qualityPaths(app);
      for (const f of [p.requirementsCsv, p.requirementsAdo]) if (existsSync(f)) await unlink(f);
      publishQuality(app, 'traceability', { action: 'requirements-cleared' });
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/quality/traceability/ado',
    summary: 'Load requirements from an Azure DevOps WIQL query (cached in .eztest/requirements-ado.json)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const r = await fetchAdoRequirements(app, str(body.query, 'query'));
      await atomicWrite((await qualityPaths(app)).requirementsAdo, JSON.stringify(r, null, 2) + '\n');
      publishQuality(app, 'traceability', { action: 'ado', count: r.requirements.length });
      sendJson(res, 200, { ok: true, count: r.requirements.length });
    },
  },
];
