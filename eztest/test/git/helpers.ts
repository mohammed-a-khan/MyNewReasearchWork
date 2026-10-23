/** Temporary git repositories for the git tests (real `git`, no mocks). */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../../src/git/exec.js';
import { GitRepo } from '../../src/git/repo.js';

export async function tmpRepo(name = 'repo', opts: { bare?: string } = {}): Promise<{ dir: string; repo: GitRepo; write(path: string, text: string): Promise<void>; commit(msg: string, author?: string): Promise<string>; run(args: string[]): Promise<string> }> {
  const base = await mkdtemp(join(tmpdir(), `eztest-git-${name}-`));
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main', dir], { cwd: base });
  for (const [k, v] of [
    ['user.name', 'Test User'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['init.defaultBranch', 'main'],
  ]) await git(['config', k, v], { cwd: dir });
  if (opts.bare) {
    await git(['init', '-q', '--bare', '-b', 'main', opts.bare], { cwd: base });
    await git(['remote', 'add', 'origin', opts.bare], { cwd: dir });
  }
  const repo = await GitRepo.open(dir);
  return {
    dir,
    repo,
    async write(path: string, text: string) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    },
    async commit(msg: string, author?: string) {
      await git(['add', '-A'], { cwd: dir });
      await git(['commit', '-q', '-m', msg, ...(author ? [`--author=${author}`] : [])], { cwd: dir });
      return (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    },
    async run(args: string[]) {
      return (await git(args, { cwd: dir })).stdout;
    },
  };
}
