/** Run directories with real hash-chained evidence, without a browser. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EvidenceVault, summarize, type JourneyResult, type RunResult } from '../../src/core/index.js';

/** A shard run directory with real evidence (hash-chained), without a browser. */
export async function fakeShardRun(outDir: string, runId: string, journeys: Array<{ id: string; status: JourneyResult['status']; ms?: number }>, startedAt: string): Promise<string> {
  const runDir = join(outDir, runId);
  const vault = new EvidenceVault(runDir);
  await vault.init();
  const results: JourneyResult[] = [];
  for (const j of journeys) {
    const shot = await vault.store('screenshot', `${j.id}/step-1.png`, Buffer.from(`png of ${j.id}`), { journeyId: j.id, stepId: 'step-1' });
    const dom = await vault.store('dom', `${j.id}/step-1.html`, `<p>${j.id}</p>`, { journeyId: j.id, stepId: 'step-1' });
    results.push({
      journeyId: j.id, name: `Journey ${j.id}`, status: j.status, startedAt, durationMs: j.ms ?? 1000, tags: [], requirements: [`REQ-${j.id}`], risk: 3, attempt: 1, ledger: {}, evidence: [dom.id],
      steps: [{ stepId: 'step-1', intent: 'Open "/"', status: j.status === 'passed' ? 'passed' : 'failed', startedAt, durationMs: j.ms ?? 1000, conditions: [], evidence: [shot.id, dom.id], ...(j.status === 'failed' ? { error: { message: 'Expected "Saved" on the page' } } : {}) }],
    });
  }
  const run: RunResult = {
    runId, startedAt, finishedAt: new Date(Date.parse(startedAt) + 5000).toISOString(), durationMs: 5000, journeys: results, summary: summarize(results),
    environment: { node: process.version, browser: 'chromium' }, evidenceHead: vault.headHash,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  return runDir;
}

