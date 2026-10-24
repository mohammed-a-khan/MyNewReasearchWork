/** Read-only run artifacts under `/runs/<runId>/<path>` (screenshots, reports, logs), with per-type CSP. */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ASSET_CSP, CONTENT_TYPES, REPORT_CSP, sendError } from '../http.js';
import { assertRunId } from '../runs.js';
import { PathError, confinePath, relPosix } from '../security.js';
import type { StudioRoute } from './route.js';

export const assetRoutes: StudioRoute[] = [
  {
    method: ['GET', 'HEAD'],
    path: /^\/runs\/([^/]+)\/(.+)$/,
    summary: 'Run artifacts (read-only)',
    async handler({ res, app, params, method }) {
      const [id, rel] = params;
      assertRunId(id);
      const runDir = join(await app.outputDir(), id);
      if (!existsSync(runDir)) return sendError(res, 404, 'Run not found');
      const abs = confinePath(runDir, rel);
      if (rel.split('/').some((p) => p.startsWith('.'))) throw new PathError('Hidden files are not served');
      if (!existsSync(abs) || !(await stat(abs)).isFile()) return sendError(res, 404, 'File not found');
      const ext = extname(abs).toLowerCase();
      const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
      const isReport = relPosix(runDir, abs) === 'report.html';
      res.setHeader('Content-Security-Policy', isReport ? REPORT_CSP : ASSET_CSP);
      // The run report is shown inside Studio's Results page (same origin only).
      if (isReport) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      if (!CONTENT_TYPES[ext]) res.setHeader('Content-Disposition', 'attachment');
      const data = await readFile(abs);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
      res.end(method === 'HEAD' ? undefined : data);
    },
  },
];
