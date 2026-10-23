/** Synthetic run results for scale tests (no browser needed). */
import type { EvidenceRef, JourneyResult, RunResult, StepResult } from '../../src/core/index.js';
import { summarize } from '../../src/core/index.js';

export function syntheticRun(n: number, o: { stepsPerJourney?: number; runId?: string; seed?: number; failEvery?: number; healEvery?: number } = {}): { run: RunResult; evidence: EvidenceRef[] } {
  const steps = o.stepsPerJourney ?? 8;
  const evidence: EvidenceRef[] = [];
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  let ev = 0;
  const journeys: JourneyResult[] = [];
  for (let i = 0; i < n; i++) {
    const failed = o.failEvery ? i % o.failEvery === 0 : false;
    const healed = !failed && o.healEvery ? i % o.healEvery === 0 : false;
    const ss: StepResult[] = [];
    for (let k = 0; k < steps; k++) {
      const id = `E-${++ev}`;
      evidence.push({ id, kind: 'screenshot', path: `shots/j${i}/s${k}.png`, sha256: 'a'.repeat(64), journeyId: `journey-${i}`, stepId: `step-${k}`, createdAt: new Date(t0).toISOString() });
      const last = k === steps - 1;
      ss.push({
        stepId: `step-${k}`, intent: `Click the "Button ${k}" button on page ${i}`, status: failed && last ? 'failed' : healed && k === 2 ? 'passed-healed' : 'passed',
        startedAt: new Date(t0 + i * 1000 + k * 100).toISOString(), durationMs: 80 + ((i * 7 + k) % 50), conditions: [], evidence: [id],
        ...(failed && last ? { error: { message: `Expected "Order ${i} saved" but the page showed "Error 500"`, name: 'AssertionError' } } : {}),
        ...(healed && k === 2 ? { heal: { stepId: `step-${k}`, tier: 'T1-fingerprint' as const, original: [{ strategy: 'css' as const, value: `#btn-${k}` }], healed: { strategy: 'role' as const, value: 'button', name: `Button ${k}` }, confidence: 0.91, verified: true, reason: 'fingerprint match', evidence: [id] } } : {}),
      });
    }
    journeys.push({
      journeyId: `journey-${i}`, name: `Journey ${i}: order flow variant ${i % 37}`, status: failed ? 'failed' : healed ? 'passed-healed' : 'passed',
      startedAt: new Date(t0 + i * 1000).toISOString(), durationMs: 1000 + (i % 13) * 200, steps: ss, tags: ['regression', `area-${i % 9}`],
      requirements: [`REQ-${i % 120}`], risk: (i % 5) + 1, attempt: 1, browser: 'chromium', ledger: {}, evidence: [],
      ...(failed ? { error: { message: `Expected "Order ${i} saved"`, name: 'AssertionError' } } : {}),
    });
  }
  const run: RunResult = {
    runId: o.runId ?? `run-synthetic-${n}`, startedAt: new Date(t0).toISOString(), finishedAt: new Date(t0 + n * 1000).toISOString(), durationMs: n * 1000,
    journeys, summary: summarize(journeys), environment: { node: 'v22', platform: 'linux', browser: 'chromium' },
  };
  return { run, evidence };
}
