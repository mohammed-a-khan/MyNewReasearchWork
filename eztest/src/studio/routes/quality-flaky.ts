/** Quality Center: flaky ranking with outcome strips, and quarantine (add, renew, remove). */
import { loadQuarantine, saveQuarantine, validateQuarantineEntry, type QuarantineEntry } from '../../insights/index.js';
import { HttpError, sendJson, str } from '../http.js';
import { flakyBoard } from '../quality/analytics.js';
import { nonTestJourneyIds, personName, publishQuality, qualityPaths, requireConfirm } from '../quality/common.js';
import type { StudioRoute } from './route.js';

export const qualityFlakyRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/flaky',
    summary: 'Flip-rate ranking with a per-journey outcome strip over the last N runs (?n=20), and the quarantine',
    async handler({ res, app, query }) {
      const n = Math.min(100, Math.max(5, Number(query.get('n') ?? 20) || 20));
      sendJson(res, 200, await flakyBoard(app, n));
    },
  },
  {
    method: 'POST',
    path: '/api/quality/quarantine',
    summary: 'Quarantine (or renew) a journey: reason, owner, expiry. Its failures stop failing runs and readiness',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const entry: QuarantineEntry = {
        journeyId: str(body.journeyId, 'journeyId'),
        reason: typeof body.reason === 'string' ? body.reason.trim() : '',
        owner: typeof body.owner === 'string' ? body.owner.trim() : '',
        expires: typeof body.expires === 'string' ? body.expires.trim() : '',
        createdAt: new Date().toISOString(),
        ...(typeof body.by === 'string' && body.by.trim() ? { createdBy: body.by.trim() } : {}),
        ...(typeof body.ticket === 'string' && body.ticket.trim() ? { ticket: body.ticket.trim() } : {}),
      };
      const problems = validateQuarantineEntry(entry);
      if (problems.length) throw new HttpError(400, problems.join('; '));
      if ((await nonTestJourneyIds(app)).has(entry.journeyId)) throw new HttpError(400, `${entry.journeyId} is a hook or @library journey, not a test; it cannot be quarantined`);
      if (Date.parse(`${entry.expires.slice(0, 10)}T23:59:59Z`) < Date.now()) throw new HttpError(400, 'The expiry date is in the past');
      const path = (await qualityPaths(app)).quarantine;
      const file = await loadQuarantine(path);
      file.entries = [...file.entries.filter((e) => e.journeyId !== entry.journeyId), entry];
      await saveQuarantine(path, file);
      publishQuality(app, 'quarantine', { action: 'added', journeyId: entry.journeyId });
      sendJson(res, 200, { ok: true, entry });
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/quality\/quarantine\/([^/]+)$/,
    summary: 'Un-quarantine a journey',
    async handler({ res, app, params, body }) {
      requireConfirm(body);
      personName(body.by, 'reviewer');
      const path = (await qualityPaths(app)).quarantine;
      const file = await loadQuarantine(path);
      const before = file.entries.length;
      file.entries = file.entries.filter((e) => e.journeyId !== params[0]);
      if (file.entries.length === before) throw new HttpError(404, `${params[0]} is not quarantined`);
      await saveQuarantine(path, file);
      publishQuality(app, 'quarantine', { action: 'removed', journeyId: params[0] });
      sendJson(res, 200, { ok: true });
    },
  },
];
