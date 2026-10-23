/**
 * `eztest manual`: manual and hybrid test management from the terminal.
 *
 *   eztest manual list                       manual and hybrid cases, assignees, last result
 *   eztest manual progress [cycle]           test cycle progress (by state, tester, suite)
 *   eztest manual automate <file> [--write]  convert a manual case through the EZ grammar (hybrid where needed)
 *
 * Run manual steps with `eztest run <case> --manual prompt` or from Studio (Test management).
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { LoadedConfig } from '../config/index.js';
import { latestResults, recentRuns } from '../analytics/project.js';
import { loadJourneyFile } from '../intent/index.js';
import { automateWithGrammar } from '../manual/cases.js';
import { cycleProgress, cycleProgressText, loadPlans, type CaseInfo } from '../manual/plans.js';
import { journeyKind, manualStepCount } from '../runner/manual.js';
import { loadJourneys } from './journeys.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

export function registerManualCommands(program: Command, io: CliIO, load: Loader): void {
  const withConfig = (c: Command) => c.option('-c, --config <file>').option('-e, --env <name>').option('--project <name>', 'project overlay (projects.<name>)');
  const manual = program.command('manual').description('manual and hybrid test cases: list, cycle progress, convert to automated');

  withConfig(manual.command('list'))
    .description('manual and hybrid cases with their assignee and latest result')
    .option('--json', 'JSON output')
    .action(async (o: { config?: string; env?: string; project?: string; json?: boolean }) => {
      const cfg = (await load(o)).config;
      const { journeys } = await loadJourneys([cfg.journeysDir], io.cwd);
      const cases = journeys.filter((j) => journeyKind(j) !== 'automated');
      const { latest } = await latestResults(resolve(io.cwd, cfg.outputDir), cases);
      const rows = cases.map((j) => {
        const l = latest.get(j.id);
        return { id: j.id, name: j.name, type: journeyKind(j), assignee: j.assignee, manualSteps: manualStepCount(j), status: l?.results.map((r) => r.status).join('/') ?? 'not run', runId: l?.runId };
      });
      if (o.json) return io.out(JSON.stringify(rows, null, 2));
      if (!rows.length) return io.out('No manual or hybrid cases (write "Manual: ..." steps, or Type: manual).');
      for (const r of rows) io.out(`${r.type.padEnd(7)} ${r.id}  ${r.manualSteps} manual step(s)${r.assignee ? `  @${r.assignee}` : ''}  ${r.status}${r.runId ? ` (${r.runId})` : ''}`);
    });

  withConfig(manual.command('progress'))
    .description('progress of test cycles (manual.plansFile): executed, passed, failed, blocked per tester and suite')
    .argument('[cycle]', 'cycle id (default: every active cycle)')
    .option('--json', 'JSON output')
    .action(async (id: string | undefined, o: { config?: string; env?: string; project?: string; json?: boolean }) => {
      const cfg = (await load(o)).config;
      const plans = await loadPlans(resolve(io.cwd, cfg.manual.plansFile));
      const { journeys } = await loadJourneys([cfg.journeysDir], io.cwd);
      const all: CaseInfo[] = journeys.map((j) => ({ id: j.id, name: j.name, tags: j.tags, type: journeyKind(j), ...(j.assignee ? { assignee: j.assignee } : {}) }));
      const cycles = id ? plans.cycles.filter((c) => c.id === id) : plans.cycles.filter((c) => c.state === 'active');
      if (id && !cycles.length) throw new Error(`No cycle "${id}" in ${cfg.manual.plansFile} (cycles: ${plans.cycles.map((c) => c.id).join(', ') || 'none'})`);
      const runs = (await recentRuns(resolve(io.cwd, cfg.outputDir), 500)).map((r) => r.run);
      const progress = cycles.map((c) => cycleProgress(c, plans, all, runs));
      if (o.json) return io.out(JSON.stringify(progress, null, 2));
      if (!progress.length) return io.out('No active cycles.');
      io.out(progress.map(cycleProgressText).join('\n\n'));
    });

  withConfig(manual.command('automate'))
    .description('convert a manual case into an automated journey through the EZ grammar; steps it cannot read stay manual (hybrid)')
    .argument('<file>', 'the .ez case')
    .option('--write [file]', 'write the result (default: replace the case in place)')
    .action(async (file: string, o: { config?: string; env?: string; project?: string; write?: string | boolean }) => {
      const abs = resolve(io.cwd, file);
      const r = automateWithGrammar(await loadJourneyFile(abs));
      io.err(`automated ${r.automated.length} step(s), kept ${r.kept.length} manual, ${r.uncheckedExpectations.length} expected result(s) to check by hand`);
      if (o.write) {
        const to = typeof o.write === 'string' ? resolve(io.cwd, o.write) : abs;
        await writeFile(to, r.ez);
        io.err(`wrote ${to}`);
      } else io.out(r.ez);
    });
}
