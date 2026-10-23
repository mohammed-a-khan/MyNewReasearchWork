/** `eztest visual`: baseline branches (per git branch) and merging them into the main set. */
import type { Command } from 'commander';
import { relative, resolve } from 'node:path';
import type { CliIO } from '../cli/program.js';
import { branchDir, currentBranch, listBaselineBranches, mergeBaselineBranch } from './visual-baselines.js';

export function registerVisualCommands(program: Command, io: CliIO): void {
  const visual = program.command('visual').description('visual baselines: branches per git branch, merging');
  const dirOf = (o: { dir?: string }) => resolve(io.cwd, o.dir ?? '.eztest/baselines');
  visual
    .command('branches')
    .description('list baseline branches and the current branch')
    .option('--dir <dir>', 'baseline directory', '.eztest/baselines')
    .action(async (o: { dir?: string }) => {
      const dir = dirOf(o);
      const cur = currentBranch(io.cwd, io.env);
      io.out(`current branch: ${cur ?? '(none)'}${branchDir(dir, cur) ? '' : ' (uses the main baselines)'}`);
      for (const b of await listBaselineBranches(dir)) io.out(`${b.branch}  ${b.baselines.length} baseline(s)${b.baselines.length ? `: ${b.baselines.slice(0, 5).join(', ')}${b.baselines.length > 5 ? ', ...' : ''}` : ''}`);
    });
  visual
    .command('merge')
    .description("merge a branch's baselines into the main set (recorded in the approvals vault)")
    .argument('[branch]', 'branch (default: the current git branch)')
    .option('--dir <dir>', 'baseline directory', '.eztest/baselines')
    .option('--keep', 'keep the branch baselines after merging')
    .action(async (branch: string | undefined, o: { dir?: string; keep?: boolean }) => {
      const b = branch ?? currentBranch(io.cwd, io.env);
      if (!b) {
        io.err('No branch given and no git branch found.');
        process.exitCode = 1;
        return;
      }
      const r = await mergeBaselineBranch(dirOf(o), b, { keep: o.keep });
      for (const m of r.merged) io.out(`merged ${m.name}${m.previousSha256 ? ' (replaced)' : ' (new)'}`);
      io.out(`${r.merged.length} baseline(s) merged from ${b}; approval recorded in ${relative(io.cwd, r.vault)}`);
    });
}
