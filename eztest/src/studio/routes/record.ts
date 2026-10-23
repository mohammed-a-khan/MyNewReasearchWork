/** Recorder routes: status, start, live lines, add an expectation, stop. */
import { streamLog } from '../events.js';
import { sendError, sendJson, str, strList } from '../http.js';
import type { StudioRoute } from './route.js';

export const recordRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/record',
    summary: 'Recorder status and recorded lines',
    handler({ res, app }) {
      const s = app.recorder.current;
      sendJson(
        res,
        200,
        s ? { id: s.id, state: s.state, url: s.url, lines: s.events.filter((e) => e.type === 'line').map((e) => e.data.line), result: s.result } : { state: 'idle' },
      );
    },
  },
  {
    method: 'POST',
    path: '/api/record',
    summary: 'Start recording in a new browser window',
    async handler({ res, app, body }) {
      const s = await app.recorder.start({
        url: str(body.url, 'url'),
        name: typeof body.name === 'string' ? body.name : undefined,
        tags: strList(body.tags),
        headless: typeof body.headless === 'boolean' ? body.headless : undefined,
      });
      sendJson(res, 201, { id: s.id, state: s.state });
    },
  },
  {
    method: 'GET',
    path: '/api/record/events',
    summary: 'SSE log of the current recording',
    handler({ req, res, app }) {
      const s = app.recorder.current;
      if (!s) return sendError(res, 404, 'No recording');
      streamLog(req, res, s.events, (l) => app.recorder.subscribe(l), (e) => e.type === 'stopped');
    },
  },
  {
    method: 'POST',
    path: '/api/record/expect',
    summary: 'Add an expectation to the last recorded step',
    handler({ res, app, body }) {
      app.recorder.expect(str(body.text, 'text'));
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/record/stop',
    summary: 'Stop recording and return the journey',
    async handler({ res, app }) {
      const s = await app.recorder.stop();
      sendJson(res, 200, { id: s.id, state: s.state, result: s.result });
    },
  },
];
