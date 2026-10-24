/** Insights (flaky scores, trend, failure clusters) and the dashboard summary. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listJourneys } from '../authoring.js';
import { sendJson } from '../http.js';
import { insights, listRuns } from '../runs.js';
import type { StudioRoute } from './route.js';

interface HealProposal {
  journeyId?: string;
  journeyName?: string;
  stepId?: string;
  intent?: string;
  tier?: string;
  confidence?: number;
  verified?: boolean;
  healed?: { strategy: string; value: string; name?: string };
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export const insightRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/insights',
    summary: 'Flaky scores, healed-pass trend and failure clusters of the latest run',
    async handler({ res, app }) {
      sendJson(res, 200, await insights(app.ctx, await app.outputDir()));
    },
  },
  {
    method: 'GET',
    path: '/api/dashboard',
    summary: 'Home: last run, trend, readiness, flakiest journeys, recent heals, counts',
    async handler({ res, app }) {
      const out = await app.outputDir();
      const [ins, runs, journeys, problems] = await Promise.all([
        insights(app.ctx, out),
        listRuns(out),
        listJourneys(app.cwd, await app.journeysDir()),
        app.problems(),
      ]);
      const lastRun = runs.find((r) => r.summary && !r.debug);
      let readiness: unknown;
      if (lastRun) {
        const report = await readJsonFile<{ insights?: { readiness?: { decision: string; score: number; rationale?: Array<{ text: string }> } } }>(
          join(out, lastRun.runId, 'report.json'),
        );
        const r = report?.insights?.readiness;
        if (r) readiness = { runId: lastRun.runId, decision: r.decision, score: r.score, rationale: (r.rationale ?? []).map((x) => x.text).slice(0, 6) };
      }
      const heals: Array<HealProposal & { runId: string; startedAt?: string }> = [];
      for (const r of runs.slice(0, 15)) {
        const hp = await readJsonFile<{ proposals?: HealProposal[] }>(join(out, r.runId, 'heal-proposals.json'));
        for (const p of hp?.proposals ?? []) heals.push({ ...p, runId: r.runId, startedAt: r.startedAt });
        if (heals.length >= 10) break;
      }
      const flaky = (ins.flaky as Array<{ journeyId: string; state: string; failRate: number; flipRate: number; healedRate: number; samples: number; sequence: string }>)
        .filter((f) => f.state !== 'stable' && f.state !== 'new')
        .sort((a, b) => b.flipRate + b.failRate - (a.flipRate + a.failRate))
        .slice(0, 6);
      sendJson(res, 200, {
        lastRun,
        runs: runs.length,
        trend: ins.trend,
        readiness,
        flaky,
        heals: heals.slice(0, 10),
        journeys: { total: journeys.length, broken: journeys.filter((j) => j.error).length, steps: journeys.reduce((n, j) => n + (j.steps ?? 0), 0) },
        problems: problems.reduce((n, f) => n + f.errors.length, 0),
        active: app.runs.current ? { id: app.runs.current.id, state: app.runs.current.state } : undefined,
        warnings: ins.warnings,
      });
    },
  },
];
