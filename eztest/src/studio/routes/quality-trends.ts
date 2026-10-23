/** Quality Center: trends and analytics over recent runs. */
import { sendJson } from '../http.js';
import { trends } from '../quality/analytics.js';
import type { StudioRoute } from './route.js';

export const qualityTrendRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/trends',
    summary: 'Pass, heal and flaky rates, mean duration, failures by classification, slowest journeys and steps, tags and areas (?n=30)',
    async handler({ res, app, query }) {
      const n = Math.min(200, Math.max(2, Number(query.get('n') ?? 30) || 30));
      sendJson(res, 200, await trends(app, n));
    },
  },
];
