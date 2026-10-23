/**
 * Test management routes (#/manual): manual and hybrid cases, guided manual
 * runs and verdicts, suites / cycles / assignments, dashboards, and
 * converting a manual case into an automated journey.
 */
import { writeFile } from 'node:fs/promises';
import { HttpError, sendJson, str, strList } from '../http.js';
import {
  automateCase, caseInput, cycleRunSelection, dashboard, listCases, plansOverview, previewCase, readCase, recordCycleRun, referenceFile, runSession, saveCase,
  verdictInput, writePlans,
} from '../manual-service.js';
import type { StudioRoute } from './route.js';

function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw new HttpError(400, 'Writes need "confirm": true');
}

async function startRun(app: Parameters<StudioRoute['handler']>[0]['app'], body: Record<string, unknown>, ids: string[]) {
  const cycle = typeof body.cycle === 'string' && body.cycle ? body.cycle : undefined;
  const tester = typeof body.tester === 'string' && body.tester.trim() ? body.tester.trim().slice(0, 120) : undefined;
  const run = await app.runs.start({
    journeys: ids, heal: body.heal === false ? false : undefined, headed: body.headed === true,
    ...(body.timeTravel === true ? { timeTravel: true } : {}), ...(cycle ? { cycle } : {}), ...(tester ? { tester } : {}),
  });
  if (cycle) await recordCycleRun(app, cycle, run.id);
  app.hub.publish('manual', { type: 'run-started', runId: run.id, ...(cycle ? { cycle } : {}), journeys: ids });
  return run;
}

export const manualRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/manual/cases',
    summary: 'Manual and hybrid cases with assignee and latest result',
    async handler({ res, app }) {
      sendJson(res, 200, await listCases(app));
    },
  },
  {
    method: 'GET',
    path: '/api/manual/case',
    summary: 'A case read into the editor form (and its .ez)',
    async handler({ res, app, query }) {
      sendJson(res, 200, await readCase(app, query.get('path')));
    },
  },
  {
    method: 'POST',
    path: '/api/manual/case/preview',
    summary: 'Render the editor form as .ez (validated by the parser)',
    async handler({ res, body }) {
      sendJson(res, 200, previewCase(caseInput(body.case)));
    },
  },
  {
    method: 'PUT',
    path: '/api/manual/case',
    summary: 'Save a case as .ez (new file under journeysDir/manual.casesDir, or replace "path")',
    async handler({ res, app, body }) {
      requireConfirm(body);
      sendJson(res, 200, await saveCase(app, caseInput(body.case), typeof body.path === 'string' && body.path ? body.path : undefined));
    },
  },
  {
    method: 'POST',
    path: '/api/manual/run',
    summary: 'Start a guided run of cases (manual steps wait for verdicts in #/manual/run/<runId>)',
    async handler({ res, app, body }) {
      const ids = strList(body.journeys) ?? [];
      if (!ids.length) throw new HttpError(400, 'Choose at least one case');
      const run = await startRun(app, body, ids);
      sendJson(res, 202, { id: run.id, state: run.state });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/manual\/session\/([^/]+)$/,
    summary: 'Guided run state: plan, step statuses, verdicts, pending manual steps',
    async handler({ res, app, params }) {
      sendJson(res, 200, await runSession(app, params[0]));
    },
  },
  {
    method: 'GET',
    path: '/api/manual/pending',
    summary: 'Manual steps waiting for a verdict (all runs, or ?run=)',
    async handler({ res, app, query }) {
      const m = (await app.config().catch(() => undefined))?.masker;
      const list = app.manual.pending(query.get('run') ?? undefined);
      sendJson(res, 200, { pending: m ? m.maskDeep(list) : list });
    },
  },
  {
    method: 'POST',
    path: '/api/manual/verdict',
    summary: 'Give the verdict of a waiting manual step (status, tester, notes, observed result, attachments as base64)',
    async handler({ res, app, body }) {
      const key = str(body.key, 'key');
      const v = verdictInput(body);
      if (!app.manual.answer(key, v)) throw new HttpError(409, 'This step is no longer waiting (answered elsewhere, or the run ended)');
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/manual/end',
    summary: 'End a guided run: remaining manual steps are recorded as not executed',
    async handler({ res, app, body }) {
      const runId = str(body.runId, 'runId');
      sendJson(res, 200, { ok: true, released: app.manual.end(runId) });
    },
  },
  {
    method: 'GET',
    path: '/api/manual/reference',
    summary: 'A reference file named by an Attachment: line (images, PDF, text)',
    async handler({ res, app, query }) {
      const f = await referenceFile(app, query.get('path'));
      res.writeHead(200, {
        'Content-Type': f.type, 'Content-Length': f.data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        'Content-Disposition': `inline; filename="${f.name.replace(/"/g, '')}"`,
      });
      res.end(f.data);
    },
  },
  {
    method: 'GET',
    path: '/api/manual/plans',
    summary: 'Suites, cycles, assignments and the progress of every cycle',
    async handler({ res, app }) {
      sendJson(res, 200, await plansOverview(app));
    },
  },
  {
    method: 'PUT',
    path: '/api/manual/plans',
    summary: 'Save suites, cycles and assignments (manual.plansFile)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      await writePlans(app, body.plans);
      sendJson(res, 200, await plansOverview(app));
    },
  },
  {
    method: 'POST',
    path: /^\/api\/manual\/cycles\/([^/]+)\/run$/,
    summary: 'Run a cycle\'s open cases (assigned to "tester" when given; only: open | failed | all)',
    async handler({ res, app, params, body }) {
      const only = body.only === 'all' || body.only === 'failed' ? body.only : 'open';
      const tester = typeof body.tester === 'string' ? body.tester.trim() : '';
      const ids = await cycleRunSelection(app, params[0], { ...(body.onlyMine === true && tester ? { tester } : {}), only });
      const run = await startRun(app, { ...body, cycle: params[0] }, ids);
      sendJson(res, 202, { id: run.id, state: run.state, journeys: ids });
    },
  },
  {
    method: 'GET',
    path: '/api/manual/dashboard',
    summary: 'Active cycles\' progress and a tester\'s open assignments (?tester=)',
    async handler({ res, app, query }) {
      sendJson(res, 200, await dashboard(app, query.get('tester') ?? undefined));
    },
  },
  {
    method: 'POST',
    path: '/api/manual/automate',
    summary: 'Convert a manual case to an automated journey (method grammar | recording); write: true replaces the case',
    async handler({ res, app, body }) {
      const method = body.method === 'recording' ? 'recording' : 'grammar';
      const recorded = Array.isArray(body.recorded)
        ? (body.recorded as unknown[]).map((r) => {
            const x = (r ?? {}) as Record<string, unknown>;
            return { stepId: str(x.stepId, 'stepId'), lines: (strList(x.lines) ?? []).slice(0, 500) };
          })
        : [];
      const r = await automateCase(app, body.path, method, recorded);
      if (body.write === true) {
        requireConfirm(body);
        const target = typeof body.to === 'string' && body.to ? await app.journeyPath(body.to) : await app.journeyPath(r.path);
        await writeFile(target, r.ez);
        app.hub.publish('manual', { type: 'automated', path: app.rel(target), id: r.id });
        return sendJson(res, 200, { ...r, written: app.rel(target) });
      }
      sendJson(res, 200, r);
    },
  },
];
