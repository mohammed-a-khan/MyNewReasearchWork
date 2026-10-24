/** Quality Center: compare two runs (journey and step status changes, durations, readiness). */
import { HttpError, sendJson } from '../http.js';
import { assertRunId } from '../runs.js';
import { isDebugRunId } from '../../core/index.js';
import { compareRuns } from '../quality/analytics.js';
import { completedRuns } from '../quality/common.js';
import type { StudioRoute } from './route.js';

export const qualityCompareRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/compare',
    summary: 'Compare run ?a= (base) with ?b= (default: the two latest runs)',
    async handler({ res, app, query }) {
      const runs = await completedRuns(app);
      const b = query.get('b') ?? runs[0]?.runId;
      const a = query.get('a') ?? runs.find((r) => r.runId !== b)?.runId;
      const list = runs.slice(0, 100).map((r) => ({ runId: r.runId, startedAt: r.startedAt, summary: r.summary }));
      if (!a || !b) return sendJson(res, 200, { runs: list, comparison: null });
      assertRunId(a);
      assertRunId(b);
      if (isDebugRunId(a) || isDebugRunId(b)) throw new HttpError(400, 'Debug sessions are not compared');
      if (a === b) throw new HttpError(400, 'Pick two different runs');
      sendJson(res, 200, { runs: list, comparison: await compareRuns(app, a, b) });
    },
  },
];
