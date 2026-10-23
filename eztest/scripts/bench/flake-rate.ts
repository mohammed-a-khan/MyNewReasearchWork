/**
 * Flake-rate measurement: a deliberately timing-sensitive suite (random
 * hydration, re-render, slow XHR and overlay delays on the demo app's /rel
 * pages) run N times without retries, with the reliability features off
 * ("before") and on ("after"). Prints the failure rate per mode and per journey.
 *
 *   npx tsx scripts/bench/flake-rate.ts [runs=20] [out.json]
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { startDemoApp } from '../../examples/demo-app/server.js';

const SUITE = [
  `Journey: Checkout under load\nId: flaky-checkout\nOpen /rel/flaky?max=900\nType "Ann Lee" into the Card holder field\nClick the "Pay now" button\n  Expect the page contains "Paid by Ann Lee"\n`,
  `Journey: Checkout total\nId: flaky-total\nOpen /rel/flaky?max=900\nCapture the text of testid=total as total\n  Expect \${total} == "99.00"\n`,
  `Journey: Discount after hydration\nId: hydrate\nOpen /rel/hydrate?max=900\nClick the "Apply discount" button\n  Expect the page contains "Discount applied"\n`,
  `Journey: Profile re-render\nId: rerender\nOpen /rel/rerender?max=700\nType "Ann Lee" into the Full name field\nClick the "Greet" button\n  Expect the page contains "Hello, Ann Lee"\n`,
  `Journey: Basket total\nId: slow-total\nOpen /rel/slow?max=900\nCapture the text of testid=basket-total as total\n  Expect \${total} == "42.50"\n`,
  `Journey: Cookie banner\nId: overlay\nOpen /rel/overlay?max=1200\nClick the "Save" button\n  Expect the page contains "Saved"\n`,
  `Journey: Sliding confirm\nId: animate\nOpen /rel/animate\nClick the "Confirm" button\n  Expect the page contains "Confirmed"\n`,
  `Journey: Re-render after typing\nId: rerender-input\nOpen /rel/rerender?on=input&max=300\nType "Ann Lee" into the Full name field\nClick the "Greet" button\n  Expect the page contains "Hello, Ann Lee"\n`,
];

const ALL_MODES: Record<string, RunOptions['reliability']> = {
  /** Reliability layer off: the driver's auto-wait and EZTest's polled post-conditions only. */
  before: { actionability: false, appIdle: false, verifyFill: false, reresolve: false },
  /** The defaults: actionability, re-render safety (app idle off). */
  defaults: {},
  /** Defaults plus the opt-in app-idle check. */
  after: { appIdle: true },
};
const MODES = Object.fromEntries(Object.entries(ALL_MODES).filter(([k]) => !process.argv[4] || process.argv[4].split(',').includes(k)));

async function main(): Promise<void> {
  const runs = Number(process.argv[2] ?? 20);
  const outFile = process.argv[3];
  const server = await startDemoApp();
  const journeys = SUITE.map((t) => parseEzScript(t));
  const out = await mkdtemp(join(tmpdir(), 'eztest-flake-'));
  const result: Record<string, { executions: number; failures: number; rate: number; perJourney: Record<string, number>; seconds: number }> = {};
  try {
    for (const [mode, reliability] of Object.entries(MODES)) {
      const perJourney: Record<string, number> = Object.fromEntries(journeys.map((j) => [j.id, 0]));
      let failures = 0;
      const t0 = Date.now();
      for (let i = 0; i < runs; i++) {
        const r = await runJourneys(journeys, {
          baseUrl: server.url, outputDir: join(out, mode), concurrency: 4, retries: 0, reliability, suggestLocators: false,
          stepTimeoutMs: 5000, locateTimeoutMs: 3000, conditionTimeoutMs: 2000, screenshots: 'off', diagnose: false,
        });
        for (const j of r.journeys) {
          if (j.status === 'failed' || j.status === 'error') {
            failures++;
            perJourney[j.journeyId]++;
          }
        }
        process.stdout.write(`${mode} run ${i + 1}/${runs}: ${r.summary.failed + r.summary.errors} failed\n`);
      }
      const executions = runs * journeys.length;
      result[mode] = { executions, failures, rate: failures / executions, perJourney, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    }
  } finally {
    await server.close();
  }
  const summary = { runs, journeys: journeys.length, ...result };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (outFile) await writeFile(outFile, JSON.stringify(summary, null, 2));
}

await main();
