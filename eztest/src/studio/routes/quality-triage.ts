/** Quality Center: triage board (clusters by signature), reclassification, Azure DevOps bugs. */
import { join } from 'node:path';
import { fileBug } from '../../alm-ado/index.js';
import { addTriageOverride, loadRunArtifacts, loadTriageOverrides, saveTriageOverrides, TRIAGE_CATEGORIES, triageRun, type TriageCategory } from '../../insights/index.js';
import { HttpError, sendJson, str } from '../http.js';
import { assertRunId } from '../runs.js';
import { flakyScores, personName, pickRun, publishQuality, qualityPaths, readJsonFile, requireConfirm } from '../quality/common.js';
import { atomicWrite } from '../quality/heals.js';
import { adoClient, adoStatus, journeyRouting, triageBoard, type FiledBug } from '../quality/triage.js';
import type { StudioRoute } from './route.js';

export const qualityTriageRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/triage',
    summary: 'Triage board of a run (?run=, default latest): failure clusters with classification and cited evidence',
    async handler({ res, app, query }) {
      const runId = await pickRun(app, query.get('run'));
      if (!runId) return sendJson(res, 200, { runId: null, cards: [], runs: [], counts: {} });
      sendJson(res, 200, await triageBoard(app, runId));
    },
  },
  {
    method: 'POST',
    path: '/api/quality/triage/reclassify',
    summary: 'Reclassify failures of a run with a reason (persisted; later runs with the same signature inherit it)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const runId = str(body.runId, 'runId');
      assertRunId(runId);
      const to = str(body.to, 'to') as TriageCategory;
      if (!TRIAGE_CATEGORIES.includes(to)) throw new HttpError(400, `"to" must be one of ${TRIAGE_CATEGORIES.join(', ')}`);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) throw new HttpError(400, 'A reason is required');
      const by = personName(body.by, 'reviewer');
      const journeyIds = Array.isArray(body.journeyIds) ? body.journeyIds.map(String) : [];
      if (!journeyIds.length) throw new HttpError(400, '"journeyIds" must list the failures to reclassify');
      const art = await loadRunArtifacts(join(await app.outputDir(), runId)).catch((e: Error) => {
        throw new HttpError(404, e.message);
      });
      const report = triageRun({ run: art.run, evidence: art.evidence, networkLogs: art.networkLogs, flaky: await flakyScores(app) });
      const paths = await qualityPaths(app);
      let file = await loadTriageOverrides(paths.overrides);
      const at = new Date().toISOString();
      for (const id of journeyIds) {
        const v = report.verdicts.find((x) => x.journeyId === id);
        if (!v) throw new HttpError(400, `${id} did not fail in ${runId}`);
        file = addTriageOverride(file, { runId, journeyId: id, signature: v.signature, from: v.category, to, reason, by, at });
      }
      await saveTriageOverrides(paths.overrides, file);
      publishQuality(app, 'triage', { action: 'reclassified', runId, to, count: journeyIds.length });
      sendJson(res, 200, { ok: true, count: journeyIds.length });
    },
  },
  {
    method: 'GET',
    path: '/api/quality/ado/status',
    summary: 'Whether Azure DevOps is configured for filing bugs, with a setup hint',
    async handler({ res, app }) {
      sendJson(res, 200, await adoStatus(app));
    },
  },
  {
    method: 'POST',
    path: '/api/quality/triage/file-bug',
    summary: 'File (or find the existing) Azure DevOps bug for a failure, with evidence attached',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const runId = str(body.runId, 'runId');
      assertRunId(runId);
      const journeyId = str(body.journeyId, 'journeyId');
      const { client } = await adoClient(app);
      const dir = join(await app.outputDir(), runId);
      const art = await loadRunArtifacts(dir).catch((e: Error) => {
        throw new HttpError(404, e.message);
      });
      const report = triageRun({ run: art.run, evidence: art.evidence, networkLogs: art.networkLogs, flaky: await flakyScores(app) });
      const v = report.verdicts.find((x) => x.journeyId === journeyId);
      const evidenceIds = Array.isArray(body.evidenceIds) ? body.evidenceIds.map(String) : v?.evidence;
      // Owner (CODEOWNERS) and area / iteration (ado.paths) of the journey.
      const routing = (await journeyRouting(app)).bugFields(journeyId, art.run.journeys.find((x) => x.journeyId === journeyId)?.tags ?? []);
      let r;
      try {
        r = await fileBug({ client, run: art.run, runDir: dir, journeyId, evidence: art.evidence, evidenceIds, ...routing, classification: v ? { category: typeof body.category === 'string' ? body.category : v.category, confidence: v.confidence, reasons: v.reasons } : undefined });
      } catch (e) {
        throw new HttpError(502, `Azure DevOps: ${(e as Error).message}`);
      }
      const paths = await qualityPaths(app);
      const cur = (await readJsonFile<{ bugs: FiledBug[] }>(paths.bugs))?.bugs ?? [];
      const by = typeof body.by === 'string' ? body.by : undefined;
      const rec: FiledBug = { runId, journeyId, signature: r.signature, id: r.id, url: r.url, action: r.action, at: new Date().toISOString(), ...(by ? { by } : {}) };
      await atomicWrite(paths.bugs, JSON.stringify({ version: 1, bugs: [...cur.filter((b) => !(b.id === r.id && b.journeyId === journeyId && b.runId === runId)), rec] }, null, 2) + '\n');
      publishQuality(app, 'triage', { action: 'bug', runId, journeyId, id: r.id });
      sendJson(res, 200, r);
    },
  },
];
