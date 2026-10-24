/**
 * `eztest run --pipeline pr` (impact: true, compared with origin/main) outside a
 * git repository, or in a clone without origin/main: a clear message, not git's
 * raw usage text.
 */
import { describe, expect, it } from '../support/testkit.js';
import { spawnSync } from 'node:child_process';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import { initProject } from '../../src/cli/init.js';
import { tempDir } from '../runner/fixtures.js';

async function cli(cwd: string, args: string[]): Promise<{ out: string; err: string; error?: Error }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { PATH: process.env.PATH } };
  process.exitCode = 0;
  let error: Error | undefined;
  try {
    await buildProgram(io).exitOverride().parseAsync(['node', 'eztest', ...args], { from: 'node' });
  } catch (e) {
    error = e as Error;
  }
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), error };
}

describe('--pipeline pr and git', () => {
  it('outside a git repository: says impact needs one and how to run without it', async () => {
    const dir = await tempDir('pr-outside');
    await initProject(dir);
    const r = await cli(dir, ['run', '--pipeline', 'pr', '--plan']);
    const text = `${r.error?.message ?? ''}\n${r.err}`;
    expect(text).toMatch(/needs a git repository, and .* is not inside one/);
    expect(text).not.toMatch(/usage: git diff|--no-index/);
  });

  it('in a clone without origin/main: says how to fetch it', async () => {
    const dir = await tempDir('pr-noremote');
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@e.st');
    git('config', 'user.name', 'T');
    await initProject(dir);
    git('add', '.');
    git('commit', '-qm', 'init');
    const r = await cli(dir, ['run', '--pipeline', 'pr', '--plan']);
    const text = `${r.error?.message ?? ''}\n${r.err}`;
    expect(text).toMatch(/"origin\/main", which this clone does not have: fetch it first \(git fetch origin main/);
    expect(text).not.toMatch(/fatal: ambiguous argument|usage: git/);
  });
});
