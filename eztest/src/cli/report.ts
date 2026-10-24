/**
 * `eztest report ...`: compare two runs, the cross-run trends dashboard,
 * render a run's reports again (with the links of integrations.json), and the
 * report.json schema.
 */
import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { CliIO } from './program.js';
import type { LoadedConfig } from '../config/index.js';
import { isDebugRunId } from '../core/index.js';
import { HistoryStore } from '../insights/index.js';
import { buildTrends, compareRunDirs, renderComparisonHtml, renderTrendsHtml, reportHrefFrom, rerenderReports, suitesFromRuns, REPORT_JSON_SCHEMA } from '../report/index.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

const hasConfig = (cwd: string, file?: string) => !!file || ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].some((f) => existsSync(join(cwd, f)));

export function registerReportCommands(program: Command, io: CliIO, load: Loader): void {
  const report = program.command('report').description('reports: compare two runs, cross-run trends, render again, the JSON schema');

  report
    .command('compare')
    .description('this run against a baseline run: newly failing, fixed, slower, new and removed tests (HTML and JSON)')
    .argument('<baselineRunDir>')
    .argument('<runDir>')
    .option('-o, --out <file>', 'HTML file (default: compare/<baseline>--<run>.html next to the run folders; the run folders are not written to)')
    .option('--json <file>', 'also write the comparison as JSON')
    .option('--fail-on-new-failures', 'exit 1 when a test fails now that passed in the baseline')
    .action(async (a: string, b: string, o: { out?: string; json?: string; failOnNewFailures?: boolean }) => {
      const baseDir = resolve(io.cwd, a);
      const runDir = resolve(io.cwd, b);
      // Studio debug sessions stop, skip and edit steps by hand: they are not compared.
      for (const d of [baseDir, runDir]) if (isDebugRunId(basename(d))) throw new Error(`${basename(d)} is a Studio debug session; debug sessions are not compared (choose run-... folders)`);
      const { comparison, run } = await compareRunDirs(baseDir, runDir);
      // Never inside a run folder: its files are the run's evidence.
      const out = o.out ? resolve(io.cwd, o.out) : join(dirname(runDir), 'compare', `${basename(baseDir)}--${basename(runDir)}.html`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, renderComparisonHtml(comparison, { runId: run.runId, runStartedAt: run.startedAt, runReport: reportHrefFrom(dirname(out), runDir), baselineReport: reportHrefFrom(dirname(out), baseDir) }));
      if (o.json) await writeFile(resolve(io.cwd, o.json), JSON.stringify({ format: 'eztest-comparison', version: 1, runId: run.runId, ...comparison }, null, 2));
      const c = comparison;
      io.out(`${c.baselineRunId} -> ${run.runId}: ${c.newlyFailing.length} newly failing, ${c.fixed.length} fixed, ${c.stillFailing.length} still failing, ${c.slower.length} slower, ${c.added.length} new, ${c.removed.length} removed`);
      for (const x of c.newlyFailing.slice(0, 20)) io.out(`  NEW FAIL ${x.id} (${x.before} -> ${x.after})`);
      io.out(`comparison: ${out}`);
      process.exitCode = o.failOnNewFailures && c.newlyFailing.length ? 1 : 0;
    });

  report
    .command('trends')
    .description('portfolio dashboard over many runs: pass-rate trend, flakiest and slowest tests, failure heat map, readiness history')
    .option('-c, --config <file>')
    .option('-e, --env <name>')
    .option('--history <file>', 'history file (default .eztest/history.json)')
    .option('--runs <n>', 'last n runs', (v) => parseInt(v, 10), 50)
    .option('--branch <name>', 'only runs of this branch')
    .option('-o, --out <file>', 'HTML file', 'eztest-trends.html')
    .option('--json <file>', 'also write the trends as JSON')
    .action(async (o: { config?: string; env?: string; history?: string; runs: number; branch?: string; out: string; json?: string }) => {
      const loaded = hasConfig(io.cwd, o.config) ? await load(o).catch(() => undefined) : undefined;
      const store = await HistoryStore.open(resolve(io.cwd, o.history ?? join('.eztest', 'history.json')));
      if (!store.runs.length) {
        io.err('No runs in history yet (eztest run records them in .eztest/history.json).');
        process.exitCode = 1;
        return;
      }
      const suites = await suitesFromRuns(resolve(io.cwd, loaded?.config.outputDir ?? 'eztest-results'));
      const t = buildTrends(store.runs, { runs: o.runs, branch: o.branch, ...(suites.size ? { suiteOf: (id: string) => suites.get(id) ?? suites.get(id.split('@')[0]) ?? id.split(/[-@]/)[0] } : {}) });
      const out = resolve(io.cwd, o.out);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, renderTrendsHtml(t, { brand: loaded?.config.report.name, title: loaded?.config.report.title ? `${loaded.config.report.title}: trends` : undefined }));
      if (o.json) await writeFile(resolve(io.cwd, o.json), JSON.stringify(t, null, 2));
      io.out(`${t.totals.runs} runs, ${t.totals.tests} tests, average pass rate ${(t.totals.avgPassRate * 100).toFixed(1)}%: ${out}`);
    });

  report
    .command('render')
    .description('render a run directory\'s reports again from its saved model, with the links of integrations.json')
    .argument('<runDir>')
    .action(async (runDir: string) => {
      const r = await rerenderReports(resolve(io.cwd, runDir));
      if (!Object.keys(r).length) {
        io.err(`No saved report model in ${runDir} (report-model.json); run eztest analyze ${runDir} first.`);
        process.exitCode = 1;
        return;
      }
      for (const [f, p] of Object.entries(r)) io.out(`report ${f}: ${p}`);
    });

  report
    .command('schema')
    .description('print the JSON Schema of report.json (version 2)')
    .action(() => io.out(JSON.stringify(REPORT_JSON_SCHEMA, null, 2)));
}
