/**
 * Project › Performance: Web Vitals per step (from the perf lens), network
 * timings per step (from the runner's network evidence), budgets (project
 * `perf-budgets.yaml` or the Core Web Vitals defaults) with violations.
 * Load testing is the Performance workspace (routes/load.ts, EZTest Load).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PerfLensResult } from '../../lenses/index.js';
import {
  DEFAULT_VITAL_BUDGETS,
  entryDuration,
  evaluateBudgets,
  normalizeNetworkLog,
  percentile,
  type NetworkEntry,
  type PerfBudgets,
} from '../../perf/index.js';
import type { StudioApp } from '../app.js';
import { sendJson } from '../http.js';
import { lensFindings, loadRun, masker, readRunJson, type LoadedRun } from './assurance-shared.js';
import type { StudioRoute } from './route.js';

async function budgetsOf(app: StudioApp): Promise<{ budgets: PerfBudgets; source: string; error?: string }> {
  for (const f of ['perf-budgets.yaml', 'perf-budgets.yml', 'perf-budgets.json']) {
    const p = join(app.cwd, f);
    if (!existsSync(p)) continue;
    try {
      const raw = f.endsWith('.json') ? JSON.parse(await readFile(p, 'utf8')) : parseYaml(await readFile(p, 'utf8'));
      const b = (raw ?? {}) as PerfBudgets;
      return { budgets: { vitals: b.vitals ?? DEFAULT_VITAL_BUDGETS, api: Array.isArray(b.api) ? b.api : [] }, source: f };
    } catch (e) {
      return { budgets: { vitals: DEFAULT_VITAL_BUDGETS }, source: 'Core Web Vitals defaults', error: `${f}: ${(e as Error).message}` };
    }
  }
  return { budgets: { vitals: DEFAULT_VITAL_BUDGETS }, source: 'Core Web Vitals defaults' };
}

/** Browser network logs and API step logs of a run, normalized. */
async function runNetwork(r: LoadedRun, journeyId?: string): Promise<NetworkEntry[]> {
  const out: NetworkEntry[] = [];
  for (const e of r.evidence.values()) {
    if (e.kind !== 'network') continue;
    if (journeyId && e.journeyId && e.journeyId !== journeyId) continue;
    const raw = await readRunJson<unknown>(r, e.path);
    if (!raw) continue;
    try {
      const list = normalizeNetworkLog(raw).map((x) => ({ ...x, journeyId: x.journeyId ?? e.journeyId, stepId: x.stepId ?? e.stepId }));
      out.push(...list);
    } catch {
      // not a network log
    }
  }
  return out.sort((a, b) => (typeof a.timing === 'object' ? a.timing.startTime ?? 0 : 0) - (typeof b.timing === 'object' ? b.timing.startTime ?? 0 : 0));
}

export const perfRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: /^\/api\/project\/perf\/runs\/([^/]+)$/,
    summary: 'Web Vitals and network timings per step with budget evaluation',
    async handler({ res, app, params }) {
      const r = await loadRun(app, params[0]);
      const { budgets, source, error } = await budgetsOf(app);
      const vitalsSteps = await lensFindings<PerfLensResult>(r, 'perf');
      const network = await runNetwork(r);
      const steps = [];
      for (const j of r.run.journeys) {
        for (const s of j.steps) {
          const v = vitalsSteps.find((x) => x.journeyId === j.journeyId && x.stepId === s.stepId)?.findings.find((f) => f.details && typeof f.details === 'object' && 'vitals' in f.details)?.details;
          const net = network.filter((n) => n.journeyId === j.journeyId && n.stepId === s.stepId);
          const durs = net.map(entryDuration).filter((d): d is number => typeof d === 'number');
          const evaluated = v ? evaluateBudgets({ vitals: v.vitals }, { vitals: budgets.vitals ?? DEFAULT_VITAL_BUDGETS }) : undefined;
          steps.push({
            journeyId: j.journeyId, journeyName: j.name, stepId: s.stepId, intent: s.intent, status: s.status, durationMs: s.durationMs,
            vitals: v?.vitals, budget: evaluated,
            network: { requests: net.length, failed: net.filter((n) => n.status >= 400 || n.status === 0).length, p50: durs.length ? percentile(durs, 50) : null, p95: durs.length ? percentile(durs, 95) : null, max: durs.length ? Math.max(...durs) : null, slowest: [...net].sort((a, b) => (entryDuration(b) ?? 0) - (entryDuration(a) ?? 0)).slice(0, 3).map((n) => ({ method: n.method, url: n.url, status: n.status, ms: entryDuration(n) })) },
          });
        }
      }
      const api = budgets.api?.length ? evaluateBudgets({ network }, { api: budgets.api }) : undefined;
      const violations = steps.flatMap((s) => (s.budget?.items ?? []).filter((i) => i.status === 'fail' || i.status === 'warn').map((i) => ({ ...i, journeyId: s.journeyId, stepId: s.stepId, intent: s.intent })));
      sendJson(res, 200, (await masker(app)).maskDeep({
        runId: r.id, budgetsSource: source, budgetsError: error, budgets, steps, api, violations,
        hasVitals: vitalsSteps.length > 0, requests: network.length,
      }));
    },
  },
];
