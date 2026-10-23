/** Quality Center: Heal Review inbox (list, diff preview, accept, reject, undo). */
import { HttpError, sendJson } from '../http.js';
import { assertIdle, personName, publishQuality, requireConfirm } from '../quality/common.js';
import { collectHeals, parseHealRefs, planAccept, rejectHeals, undoDecision, writeAccept } from '../quality/heals.js';
import { qualitySummary } from '../quality/analytics.js';
import type { StudioRoute } from './route.js';

export const qualityHealRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/heals',
    summary: 'Verified heals across runs, deduplicated by journey, step and locator, with review status',
    async handler({ res, app, query }) {
      const runs = Math.min(200, Math.max(1, Number(query.get('runs') ?? 60) || 60));
      sendJson(res, 200, await collectHeals(app, { runs, run: query.get('run') ?? undefined }));
    },
  },
  {
    method: 'POST',
    path: '/api/quality/heals/preview',
    summary: 'Diff preview of accepting heals (nothing is written)',
    async handler({ res, app, body }) {
      const plan = await planAccept(app, parseHealRefs(body.items));
      sendJson(res, 200, {
        files: plan.files.map((f) => ({ path: f.path, existed: f.existed, diff: f.diff, unified: f.unified, beforeHash: f.beforeHash })),
        plans: plan.plans.map((p) => ({ journeyId: p.journeyId, stepId: p.stepId, method: p.method, summary: p.summary, notes: p.notes, newLine: p.newLine })),
        errors: plan.errors.map((e) => ({ journeyId: e.ref.journeyId, stepId: e.ref.stepId, error: e.error })),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/quality/heals/accept',
    summary: 'Accept heals: write the previewed changes (hash-checked), update the fingerprint store, record the decision',
    async handler({ res, app, body }) {
      requireConfirm(body);
      assertIdle(app);
      const reviewer = personName(body.reviewer);
      const expected = (body.expected ?? {}) as Record<string, string>;
      if (typeof expected !== 'object' || Array.isArray(expected)) throw new HttpError(400, '"expected" must map file paths to the hashes from the preview');
      const r = await writeAccept(app, parseHealRefs(body.items), expected, reviewer, typeof body.reason === 'string' ? body.reason : undefined);
      publishQuality(app, 'heals', { action: 'accepted', count: r.accepted.length, files: r.written });
      sendJson(res, 200, { written: r.written, accepted: r.accepted.length, methods: r.plans.map((p) => ({ journeyId: p.journeyId, stepId: p.stepId, method: p.method })), errors: r.errors.map((e) => ({ journeyId: e.ref.journeyId, stepId: e.ref.stepId, error: e.error })) });
    },
  },
  {
    method: 'POST',
    path: '/api/quality/heals/reject',
    summary: 'Reject heals: later heals at that tier for the step fail as a suspected regression',
    async handler({ res, app, body }) {
      requireConfirm(body);
      assertIdle(app);
      const reviewer = personName(body.reviewer);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) throw new HttpError(400, 'A reason is required to reject a heal');
      const r = await rejectHeals(app, parseHealRefs(body.items), reviewer, reason);
      publishQuality(app, 'heals', { action: 'rejected', count: r.rejected });
      sendJson(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/quality/heals/undo',
    summary: 'Remove a review decision (files already written are not reverted)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      assertIdle(app);
      const [ref] = parseHealRefs([body.item]);
      const removed = await undoDecision(app, ref);
      publishQuality(app, 'heals', { action: 'undone' });
      sendJson(res, 200, { removed });
    },
  },
  {
    method: 'GET',
    path: '/api/quality/summary',
    summary: 'Quality Center counts: heals to review (overall and per run), quarantine, latest run',
    async handler({ res, app }) {
      sendJson(res, 200, await qualitySummary(app));
    },
  },
];
