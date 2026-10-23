/** Run routes: list, start, live events, detail and cancellation. */
import { streamLog } from '../events.js';
import { sendError, sendJson } from '../http.js';
import { assertRunId, listRuns, runDetail, type RunRequest } from '../runs.js';
import type { StudioRoute } from './route.js';

export const runRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/runs',
    summary: 'Past runs (newest first) and the active run',
    async handler({ res, app }) {
      const cur = app.runs.current;
      sendJson(res, 200, {
        runs: await listRuns(await app.outputDir()),
        active: cur ? { id: cur.id, state: cur.state, startedAt: cur.startedAt, journeys: cur.journeys } : undefined,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/runs',
    summary: 'Start a run (one at a time)',
    async handler({ res, app, body }) {
      const run = await app.runs.start(body as RunRequest);
      sendJson(res, 202, { id: run.id, events: `/api/runs/${run.id}/events` });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/runs\/([^/]+)\/events$/,
    summary: 'SSE log of one run started in this session (full replay)',
    handler({ req, res, app, params }) {
      const id = params[0];
      assertRunId(id);
      const run = app.runs.find(id);
      if (!run) return sendError(res, 404, 'No live events for this run (it is not running in this Studio session)');
      streamLog(req, res, run.events, (l) => app.runs.subscribe(run, l), (e) => e.type === 'done');
    },
  },
  {
    method: 'GET',
    path: /^\/api\/runs\/([^/]+)$/,
    summary: 'Run detail: results, evidence, verification, heal proposals, insights',
    async handler({ res, app, params }) {
      const id = params[0];
      assertRunId(id);
      const live = app.runs.find(id);
      if (live && (live.state === 'running' || live.state === 'cancelling' || live.state === 'analyzing')) {
        return sendJson(res, 200, { runId: id, state: live.state });
      }
      const detail = await runDetail(await app.outputDir(), id);
      sendJson(res, 200, { ...detail, live: live ? { state: live.state, result: live.result } : undefined });
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/runs\/([^/]+)$/,
    summary: 'Cancel the run in progress (stops at the next step; the rest is skipped)',
    handler({ res, app, params }) {
      const id = params[0];
      assertRunId(id);
      const run = app.runs.cancel(id);
      sendJson(res, 202, { id: run.id, state: run.state });
    },
  },
];
