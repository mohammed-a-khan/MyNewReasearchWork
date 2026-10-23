/**
 * `eztest coverage`: coverage analytics in the terminal and CI.
 *
 *   eztest coverage [summary]           combined view (UI, requirements, API, risk, change, manual)
 *   eztest coverage ui [runDir...]      UI coverage map: pages, untested elements, unvisited links
 *   eztest coverage a11y                accessibility trend: new / fixed / persisting issues
 *
 * `--min <percent>` fails the command (exit 1) below a threshold, for CI gates.
 */
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Command } from 'commander';
import type { LoadedConfig } from '../config/index.js';
import { a11yIssuesOfRun, a11yTrend, combinedCoverageText, computeUiCoverage, projectCoverage, recentRuns, runTraceInputs, uiCoverageText, type UiCoverageReport } from '../analytics/index.js';
import { analyzeImpact, changedFilesFromGit, loadImpactMapping, loadQuarantine, quarantineStatus } from '../insights/index.js';
import { loadJourneys } from './journeys.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

const pctArg = (v: string): number => {
  const n = Number(String(v).replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('--min must be a percentage 0-100');
  return n / 100;
};

export function registerCoverageCommands(program: Command, io: CliIO, load: Loader): void {
  const withConfig = (c: Command) => c.option('-c, --config <file>').option('-e, --env <name>').option('--project <name>', 'project overlay (projects.<name>)');
  const cov = program.command('coverage').description('coverage analytics: one view of UI, requirement, API, risk, change and manual coverage (summary), the UI coverage map (ui), accessibility trends (a11y)');
  withConfig(cov.command('summary', { isDefault: true }))
    .description('one view of UI, requirement, API, risk, change and manual coverage, with the gaps')
    .option('--json', 'JSON output')
    .option('--changed-since <ref>', 'change coverage against a git ref (uses selection.impactMapping)')
    .option('--min <percent>', 'exit 1 when the overall coverage is below this percentage', pctArg)
    .action(async (o: { config?: string; env?: string; project?: string; json?: boolean; changedSince?: string; min?: number }) => {
      const loaded = await load(o);
      const cfg = loaded.config;
      const { journeys } = await loadJourneys([cfg.journeysDir], io.cwd);
      let impact;
      if (o.changedSince) {
        const files = await changedFilesFromGit({ cwd: io.cwd, base: o.changedSince });
        const mapping = await loadImpactMapping(resolve(io.cwd, cfg.selection.impactMapping));
        impact = files.length ? analyzeImpact(files, journeys.map((j) => ({ id: j.id, name: j.name, tags: j.tags, requirements: j.requirements, risk: j.risk })), mapping) : undefined;
      }
      let quarantined: string[] = [];
      try {
        quarantined = quarantineStatus(await loadQuarantine(resolve(io.cwd, '.eztest', 'quarantine.json'))).active.map((q) => q.journeyId);
      } catch {
        quarantined = [];
      }
      const r = await projectCoverage({ outputDir: resolve(io.cwd, cfg.outputDir), journeys, ui: cfg.coverage.ui, quarantined, ...(impact ? { impact } : {}) });
      if (o.json) io.out(JSON.stringify(loaded.masker.maskDeep(r), null, 2));
      else io.out(loaded.masker.mask(combinedCoverageText(r.combined)));
      if (o.min !== undefined && (r.combined.overall ?? 0) < o.min) {
        io.err(`coverage ${(100 * (r.combined.overall ?? 0)).toFixed(1)}% is below ${(o.min * 100).toFixed(1)}%`);
        process.exitCode = 1;
      }
    });

  withConfig(cov.command('ui'))
    .description('UI coverage map from time-travel trace snapshots: pages, interactive elements by role and name, untested elements, unvisited links')
    .argument('[runDirs...]', 'run directories (default: the latest result of every journey across recent runs)')
    .option('--last <n>', 'use only the newest n runs', (v) => parseInt(v, 10))
    .option('--all', 'list tested elements too')
    .option('--page <route>', 'only this route (e.g. /orders/:id)')
    .option('--json', 'JSON output')
    .option('-o, --out <file>', 'also write the JSON report to a file')
    .option('--min <percent>', 'exit 1 when UI coverage is below this percentage', pctArg)
    .action(async (dirs: string[], o: { config?: string; env?: string; project?: string; last?: number; all?: boolean; page?: string; json?: boolean; out?: string; min?: number }) => {
      const loaded = await load(o);
      const cfg = loaded.config;
      const { journeys } = await loadJourneys([cfg.journeysDir], io.cwd);
      let report: UiCoverageReport;
      if (dirs.length || o.last) {
        const runs = dirs.length ? dirs.map((d) => ({ dir: resolve(io.cwd, d), runId: basename(resolve(io.cwd, d)) })) : (await recentRuns(resolve(io.cwd, cfg.outputDir), o.last)).map((r) => ({ dir: r.dir, runId: r.runId }));
        const inputs = [];
        for (const r of runs) inputs.push(...(await runTraceInputs(r.dir, r.runId)));
        report = await computeUiCoverage(inputs, journeys, cfg.coverage.ui);
      } else {
        report = (await projectCoverage({ outputDir: resolve(io.cwd, cfg.outputDir), journeys, ui: cfg.coverage.ui })).ui;
      }
      if (o.page) report = { ...report, pages: report.pages.filter((p) => p.route === o.page) };
      if (o.out) await writeFile(resolve(io.cwd, o.out), JSON.stringify(loaded.masker.maskDeep(report), null, 2));
      if (o.json) io.out(JSON.stringify(loaded.masker.maskDeep(report), null, 2));
      else io.out(loaded.masker.mask(uiCoverageText(report, { untested: !o.all })));
      if (o.min !== undefined && report.totals.percent < o.min) {
        io.err(`UI coverage ${(report.totals.percent * 100).toFixed(1)}% is below ${(o.min * 100).toFixed(1)}%`);
        process.exitCode = 1;
      }
    });

  withConfig(cov.command('a11y'))
    .description('accessibility trend across runs: new, fixed and persisting issues by rule and component (accessibility.scopes)')
    .option('--last <n>', 'runs to compare (default 20)', (v) => parseInt(v, 10))
    .option('--json', 'JSON output')
    .action(async (o: { config?: string; env?: string; project?: string; last?: number; json?: boolean }) => {
      const loaded = await load(o);
      const cfg = loaded.config;
      const runs = (await recentRuns(resolve(io.cwd, cfg.outputDir), o.last ?? 20)).reverse();
      const issues = [];
      for (const r of runs) issues.push(await a11yIssuesOfRun(r.dir, r.runId, cfg.accessibility.scopes, { routes: cfg.coverage.ui.routes, startedAt: r.startedAt }));
      const t = a11yTrend(issues);
      if (o.json) return io.out(JSON.stringify(loaded.masker.maskDeep(t), null, 2));
      if (!t.points.length) return io.out('No accessibility scans in recent runs (add the a11y lens: lenses: [a11y] or --lens a11y).');
      for (const p of t.points) io.out(`${p.runId}  ${String(p.total).padStart(4)} issue(s)  +${p.new} new  -${p.fixed} fixed  (${Object.entries(p.byImpact).map(([k, v]) => `${k} ${v}`).join(', ')})`);
      if (t.latest) {
        io.out('');
        for (const i of t.latest.new) io.out(`NEW        ${i.ruleId} on ${i.route} at ${i.target} (${i.component})`);
        for (const i of t.latest.fixed) io.out(`FIXED      ${i.ruleId} on ${i.route} at ${i.target} (${i.component})`);
        io.out(`${t.latest.persisting.length} persisting issue(s)`);
      }
    });
}
