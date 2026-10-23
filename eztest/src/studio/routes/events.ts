/**
 * `GET /api/events`: the multiplexed SSE stream of the event hub.
 * Query: `topics=run,files` (default all), `since=<seq>` (default the
 * Last-Event-ID header, else 0, i.e. replay everything still buffered).
 */
import { streamHub } from '../events.js';
import { HttpError } from '../http.js';
import type { StudioRoute } from './route.js';

export const eventRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/events',
    summary: 'Multiplexed SSE stream of all topics with replay',
    handler({ req, res, app, query }) {
      const topics = (query.get('topics') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      for (const t of topics) if (!/^[\w.:-]{1,64}$/.test(t)) throw new HttpError(400, `Invalid topic "${t}"`);
      const sinceParam = query.get('since');
      const since = sinceParam !== null && sinceParam !== '' ? Number(sinceParam) : undefined;
      if (since !== undefined && (!Number.isInteger(since) || since < 0)) throw new HttpError(400, '"since" must be a sequence number');
      streamHub(app.hub, req, res, { topics, since });
    },
  },
];
