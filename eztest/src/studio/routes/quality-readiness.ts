/** Quality Center: release readiness (live decision, policy editor with validation, sign-off). */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseReadinessPolicy } from '../../insights/index.js';
import { unifiedDiff } from '../../heal/index.js';
import { HttpError, sendJson, str } from '../http.js';
import { assertRunId } from '../runs.js';
import { personName, pickRun, publishQuality, requireConfirm, sha } from '../quality/common.js';
import { atomicWrite } from '../quality/heals.js';
import { decisionTrend, evaluateFor, policyFile, recordSignoff } from '../quality/readiness.js';
import type { StudioRoute } from './route.js';

function policyText(body: Record<string, unknown>): string {
  const t = str(body.text, 'text');
  if (t.length > 200_000) throw new HttpError(413, 'The policy is too large');
  return t;
}

export const qualityReadinessRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/readiness',
    summary: 'Readiness of a run (?run=, default latest): decision, gates, coverage, what would make it GO, sign-offs, trend',
    async handler({ res, app, query }) {
      const runId = await pickRun(app, query.get('run'));
      const trend = await decisionTrend(app);
      if (!runId) return sendJson(res, 200, { runId: null, trend, policy: { ...(await policyFile(app)), abs: undefined } });
      sendJson(res, 200, { ...(await evaluateFor(app, runId)), trend });
    },
  },
  {
    method: 'POST',
    path: '/api/quality/readiness/policy/validate',
    summary: 'Validate a policy draft and evaluate it against a run (nothing is written); returns the diff against the file',
    async handler({ res, app, body }) {
      const text = policyText(body);
      const pf = await policyFile(app);
      const current = pf.exists ? await readFile(pf.abs, 'utf8') : '';
      let error: string | undefined;
      try {
        parseReadinessPolicy(text);
      } catch (e) {
        error = (e as Error).message;
      }
      let preview: unknown;
      const runId = typeof body.runId === 'string' ? body.runId : undefined;
      if (!error && runId) {
        assertRunId(runId);
        const ev = await evaluateFor(app, runId, text);
        preview = ev.result ? { decision: ev.result.decision, score: ev.result.score, gates: ev.result.gates.map((g) => ({ gate: g.gate, status: g.status, severity: g.severity, summary: g.summary })) } : undefined;
      }
      sendJson(res, 200, { ok: !error, error, preview, path: pf.path, exists: pf.exists, diff: unifiedDiff(current, text), baseHash: pf.exists ? sha(current) : '' });
    },
  },
  {
    method: 'PUT',
    path: '/api/quality/readiness/policy',
    summary: 'Save the readiness policy (validated; refused if the file changed since it was loaded)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const text = policyText(body);
      try {
        parseReadinessPolicy(text);
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      const pf = await policyFile(app);
      const current = existsSync(pf.abs) ? await readFile(pf.abs, 'utf8') : '';
      if ((body.baseHash ?? '') !== (pf.exists ? sha(current) : '')) throw new HttpError(409, `${pf.path} changed since you loaded it; reload and re-apply your edits`);
      await atomicWrite(pf.abs, text);
      publishQuality(app, 'readiness', { action: 'policy-saved', path: pf.path });
      sendJson(res, 200, { ok: true, path: pf.path, hash: sha(text), configured: pf.configured });
    },
  },
  {
    method: 'POST',
    path: '/api/quality/readiness/signoff',
    summary: 'Record a named sign-off in the run evidence vault (ed25519-signed when a key is configured)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const runId = str(body.runId, 'runId');
      assertRunId(runId);
      const approver = personName(body.approver, 'approver');
      const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
      if (!comment) throw new HttpError(400, 'A comment is required');
      if (comment.length > 4000) throw new HttpError(400, 'The comment is too long');
      const r = await recordSignoff(app, runId, approver, comment, typeof body.decision === 'string' ? body.decision : undefined);
      publishQuality(app, 'readiness', { action: 'signoff', runId, evidenceId: r.evidenceId });
      sendJson(res, 200, r);
    },
  },
];
