/**
 * Tool overhead profile: N journeys (default 300) of a sign-in + order flow on
 * the demo app, run under several configurations, to see what EZTest itself
 * costs (screenshots, lenses, fingerprints, evidence) and what --fast and
 * context reuse save. Prints wall time, throughput and evidence volume.
 *
 *   npx tsx scripts/bench/perf-300.ts [journeys=300] [workers=4] [out.json] [configs=all|a,b,...]
 */
import { readdir, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEzScript } from '../../src/intent/index.js';
import { fastRunOptions, runJourneys, type RunOptions } from '../../src/runner/index.js';
import { lensesFromConfig } from '../../src/engine/index.js';
import { startDemoApp } from '../../examples/demo-app/server.js';

const journey = (n: number) => parseEzScript(`Journey: Order ${n}
Id: order-${n}
Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
  Expect the URL contains "/dashboard"
Go to /orders/new
Select "Gadget (49.50)" from the Product dropdown
Type "2" into the Quantity field
Click the "Submit order" button
  Expect the page contains "created"
`);

async function dirSize(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        files++;
        bytes += (await stat(p)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 300);
  const workers = Number(process.argv[3] ?? 4);
  const outFile = process.argv[4];
  const only = process.argv[5] && process.argv[5] !== 'all' ? new Set(process.argv[5].split(',')) : undefined;
  const server = await startDemoApp();
  const journeys = Array.from({ length: n }, (_, i) => journey(i + 1));
  const base = await mkdtemp(join(tmpdir(), 'eztest-perf-'));
  const configs: Record<string, Partial<RunOptions>> = {
    'full (every-step screenshots + a11y lens)': { screenshots: 'every-step', lenses: lensesFromConfig(['a11y:warn'], base) },
    'cli default (every-step screenshots)': { screenshots: 'every-step' },
    'on-failure screenshots': { screenshots: 'on-failure' },
    '--fast': { ...fastRunOptions() },
    '--fast + reuse context': { ...fastRunOptions(), reuseContext: true },
    '--fast, reliability guard off': { ...fastRunOptions(), reliability: { actionability: false, verifyFill: false, reresolve: false } },
  };
  const results: Array<Record<string, unknown>> = [];
  try {
    // Warm-up (browser download cache, JIT) so the first configuration is not penalised.
    await runJourneys(journeys.slice(0, Math.min(8, n)), { baseUrl: server.url, outputDir: join(base, 'warmup'), concurrency: workers });
    for (const [name, extra] of Object.entries(configs)) {
      if (only && ![...only].some((o) => name.includes(o))) continue;
      const outDir = join(base, name.replace(/[^\w]+/g, '-'));
      const t0 = Date.now();
      const r = await runJourneys(journeys, { baseUrl: server.url, outputDir: outDir, concurrency: workers, stepTimeoutMs: 10_000, ...extra });
      const seconds = (Date.now() - t0) / 1000;
      const size = await dirSize(join(outDir, r.runId));
      const row = {
        config: name, journeys: n, workers, seconds: Math.round(seconds * 10) / 10, journeysPerMinute: Math.round((n / seconds) * 60),
        passed: r.summary.passed + r.summary.passedHealed, failed: r.summary.failed + r.summary.errors, evidenceFiles: size.files, evidenceMB: Math.round(size.bytes / 1e5) / 10,
        ...(r.environment.contextReuse ? { contextReuse: r.environment.contextReuse } : {}),
      };
      results.push(row);
      await rm(outDir, { recursive: true, force: true }); // keep disk use bounded
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
  if (outFile) await writeFile(outFile, JSON.stringify(results, null, 2));
}

await main();
