/** A git checkout with journeys, and run directories (report.json) of a NO_GO and a GO run of them. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarize, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { tmpRepo } from '../git/helpers.js';

export const PAY = 'Journey: Pay by card\nTags: @payments\n\nOpen /cart\nClick the "Pay" button\n  Expect the page contains "Paid"\nType "4242" into the Card field\n';
export const LOGIN = 'Journey: Login\n\nClick the "Sign in" button\n  Expect the URL contains "/home"\n';

export async function prFixture(opts: { bare?: string } = {}) {
  const r = await tmpRepo('pr', opts);
  await r.write('journeys/pay.ez', PAY);
  await r.write('journeys/login.ez', LOGIN);
  const sha = await r.commit('journeys');
  const pay = parseEzScript(PAY, { source: 'pay.ez' });
  const login = parseEzScript(LOGIN, { source: 'login.ez' });
  const at = '2026-10-21T10:00:00.000Z';
  const mkRun = async (name: string, decision: 'GO' | 'NO_GO'): Promise<string> => {
    const failing = decision === 'NO_GO';
    const journeys: JourneyResult[] = [
      {
        journeyId: pay.id, name: pay.name, status: failing ? 'failed' : 'passed', startedAt: at, durationMs: 1000, tags: pay.tags, requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [],
        steps: [
          { stepId: pay.steps[0].id, intent: pay.steps[0].intent, status: 'passed', startedAt: at, durationMs: 10, conditions: [], evidence: [] },
          { stepId: pay.steps[1].id, intent: pay.steps[1].intent, status: failing ? 'failed' : 'passed', startedAt: at, durationMs: 10, conditions: [], evidence: [], ...(failing ? { error: { message: 'Post-condition failed: page does not contain "Paid" after 5000ms' } } : {}) },
        ],
      },
      {
        journeyId: login.id, name: login.name, status: failing ? 'passed-healed' : 'passed', startedAt: at, durationMs: 500, tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [],
        steps: [
          {
            stepId: login.steps[0].id, intent: login.steps[0].intent, status: failing ? 'passed-healed' : 'passed', startedAt: at, durationMs: 10, conditions: [], evidence: [],
            ...(failing ? { heal: { stepId: login.steps[0].id, tier: 'T1-fingerprint' as const, original: [{ strategy: 'role' as const, value: 'button', name: 'Sign in' }], healed: { strategy: 'testId' as const, value: 'login' }, confidence: 0.94, verified: true, reason: 'fp', evidence: [] } } : {}),
          },
        ],
      },
    ];
    const run: RunResult = { runId: `run-${name}`, startedAt: at, finishedAt: at, durationMs: 1500, journeys, summary: summarize(journeys), environment: { gitCommit: sha, gitBranch: 'feature/pay' } };
    const dir = join(r.dir, 'eztest-results', run.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.json'), JSON.stringify(run));
    const readiness = {
      decision, score: failing ? 40 : 95, runId: run.runId, evaluatedAt: at, rationale: [], exceptionsApplied: [], exceptionsIgnored: [],
      gates: [{ gate: 'critical-journeys', severity: 'blocker', status: failing ? 'fail' : 'pass', summary: failing ? '1 critical journey failed: pay-by-card' : 'ok', cites: { evidence: [], journeys: [], requirements: [] } }],
    };
    const triage = { verdicts: failing ? [{ journeyId: pay.id, journeyName: pay.name, category: 'product-bug', confidence: 0.8, status: 'decided', reasons: ['the page rendered but the text is missing'], evidence: [], candidates: [] }] : [], clusters: [] };
    await writeFile(join(dir, 'report.json'), JSON.stringify({ format: 'eztest-report', version: 1, generatedAt: at, run, insights: { readiness, triage } }));
    return dir;
  };
  return { r, sha, pay, login, noGo: await mkRun('nogo', 'NO_GO'), go: await mkRun('go', 'GO') };
}
