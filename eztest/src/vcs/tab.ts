/**
 * The data the EZTest pipeline results tab (integrations/azure-devops/web)
 * renders: decision, gates, failures with their journey line, heals awaiting
 * review and every journey's status. Small, masked (built from the run's
 * report, which EZTest already masked), and versioned.
 */
import { GitRepo } from '../git/repo.js';
import { buildPrSummary, fileOf, journeyFileIndex, loadRunForPr, stepLine } from './summary.js';

export interface TabData {
  format: 'eztest-tab';
  version: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  commit?: string;
  branch?: string;
  decision: 'GO' | 'GO_WITH_RISKS' | 'NO_GO';
  score?: number;
  summary: { total: number; passed: number; passedHealed: number; failed: number; skipped: number; errors: number };
  gates: Array<{ gate: string; status: string; summary: string }>;
  failures: Array<{ journeyId: string; name: string; step?: string; error: string; file?: string; line?: number; category?: string; confidence?: number }>;
  heals: Array<{ journeyId: string; name: string; step: string; from: string; to: string; tier: string; confidence: number; verified: boolean; file?: string; line?: number }>;
  journeys: Array<{ id: string; name: string; status: string; durationMs: number; attempt: number }>;
  buildUrl?: string;
}

export async function buildTabData(runDir: string, cwd: string, journeys: string[], o: { buildUrl?: string } = {}): Promise<{ data: TabData; markdown: string }> {
  const loaded = await loadRunForPr(runDir);
  let root = cwd;
  try {
    root = (await GitRepo.open(cwd)).root;
  } catch {
    // not a checkout
  }
  const files = await journeyFileIndex(root, cwd, journeys);
  const s = buildPrSummary({ ...loaded, files, buildUrl: o.buildUrl });
  const run = loaded.run;
  const verdict = new Map((loaded.triage?.verdicts ?? []).map((v) => [v.journeyId, v]));
  const failingStep = (steps: (typeof run.journeys)[number]['steps']): (typeof steps)[number] | undefined => {
    for (const st of steps) if (st.status === 'failed' || st.status === 'blocked') return failingStep(st.children ?? []) ?? st;
    return undefined;
  };
  const tests = run.journeys.filter((j) => !j.tags.includes('hook'));
  const data: TabData = {
    format: 'eztest-tab',
    version: 1,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(run.environment?.gitCommit ? { commit: run.environment.gitCommit } : {}),
    ...(run.environment?.gitBranch ? { branch: run.environment.gitBranch } : {}),
    decision: s.decision,
    ...(loaded.readiness ? { score: loaded.readiness.score } : {}),
    summary: run.summary,
    gates: (loaded.readiness?.gates ?? []).map((g) => ({ gate: g.gate, status: g.status, summary: g.summary })),
    failures: tests
      .filter((j) => j.status === 'failed' || j.status === 'error')
      .map((j) => {
        const st = failingStep(j.steps);
        const f = fileOf(files, j.journeyId);
        const v = verdict.get(j.journeyId);
        return {
          journeyId: j.journeyId,
          name: j.name,
          ...(st ? { step: st.intent } : {}),
          error: ((st?.error ?? j.error)?.message ?? j.status).slice(0, 2000),
          ...(f ? { file: f.path, line: st ? stepLine(f, st.stepId) : 1 } : {}),
          ...(v ? { category: v.category, confidence: v.confidence } : {}),
        };
      }),
    heals: tests.flatMap((j) => {
      const walk = (steps: (typeof j)['steps']): (typeof j)['steps'] => steps.flatMap((x) => [x, ...walk(x.children ?? [])]);
      return walk(j.steps)
        .filter((x) => x.heal)
        .map((x) => {
          const f = fileOf(files, j.journeyId);
          return {
            journeyId: j.journeyId,
            name: j.name,
            step: x.intent,
            from: x.heal!.original.map((l) => `${l.strategy}=${l.value}`).join(' / '),
            to: `${x.heal!.healed.strategy}=${x.heal!.healed.value}`,
            tier: x.heal!.tier,
            confidence: x.heal!.confidence,
            verified: x.heal!.verified,
            ...(f ? { file: f.path, line: stepLine(f, x.stepId) } : {}),
          };
        });
    }),
    journeys: tests.map((j) => ({ id: j.journeyId, name: j.name, status: j.status, durationMs: j.durationMs, attempt: j.attempt })),
    ...(o.buildUrl ? { buildUrl: o.buildUrl } : {}),
  };
  return { data, markdown: s.markdown };
}
