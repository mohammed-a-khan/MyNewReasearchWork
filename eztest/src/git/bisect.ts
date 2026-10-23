/**
 * `eztest bisect <journey> --good <sha> --bad <sha>`: find the first commit
 * that breaks a journey, for repositories where the application and the
 * tests live together.
 *
 * The search runs in a separate `git worktree` (the user's checkout is never
 * touched): for each candidate commit on the first-parent line between good
 * and bad, the worktree is checked out at that commit, optional setup
 * commands run there (e.g. `npm ci`, start the app), and the journey runs.
 * Exit code 0 = good, 125 = skip (untestable), anything else = bad, as with
 * `git bisect run`.
 *
 * Limits (also in docs/git.md): first-parent history only (merged branches
 * count as one step); commits whose build or setup fails are skipped; the
 * journey under test comes from the current checkout by default
 * (`journeyFrom: 'candidate'` uses each commit's own copy); environment state
 * outside the worktree (databases, external services) is not reset.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GitRepo, type CommitInfo } from './repo.js';

export type Verdict = 'good' | 'bad' | 'skip';

export interface BisectStep {
  sha: string;
  verdict: Verdict;
  durationMs: number;
  note?: string;
}

export interface BisectOptions {
  cwd: string;
  /** Journey path relative to the repository root. */
  journey: string;
  good: string;
  bad: string;
  /** Test one checkout. Default: run `command` (argv) in the worktree with the journey path appended. */
  test?: (ctx: { dir: string; sha: string; journey: string }) => Promise<Verdict>;
  /** argv of the test command (journey path appended), e.g. [node, eztest-cli, 'run']. */
  command?: string[];
  /** Commands (argv) run in the worktree before each test, e.g. [['npm','ci']]. A failure skips the commit. */
  setup?: string[][];
  /** Use the journey from the current checkout (default) or each candidate commit's own version. */
  journeyFrom?: 'current' | 'candidate';
  /** Verify that `good` passes and `bad` fails before searching (default true). */
  verifyEnds?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface BisectResult {
  firstBad?: CommitInfo;
  /** When skipped commits hide the answer: the range that contains it. */
  candidates?: string[];
  steps: BisectStep[];
  tested: number;
  total: number;
  status: 'found' | 'inconclusive' | 'good-is-bad' | 'bad-is-good' | 'no-commits';
}

function runArgv(argv: string[], cwd: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: 'ignore', env: { ...process.env, EZTEST_BISECT: '1' } });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => {
      clearTimeout(t);
      resolve(127);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(code ?? 1);
    });
  });
}

export async function bisectJourney(o: BisectOptions): Promise<BisectResult> {
  const repo = await GitRepo.open(o.cwd);
  const log = o.log ?? (() => undefined);
  const journey = repo.rel(o.journey, o.cwd);
  const good = await repo.revParse(o.good);
  const bad = await repo.revParse(o.bad);
  if (!(await repo.isAncestor(good, bad))) throw new Error(`${o.good} is not an ancestor of ${o.bad}`);
  const commits = await repo.commitsBetween(good, bad);
  const steps: BisectStep[] = [];
  if (!commits.length) return { steps, tested: 0, total: 0, status: 'no-commits' };
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  const tmpRoot = await mkdtemp(join(tmpdir(), 'eztest-bisect-'));
  const wt = join(tmpRoot, 'wt');
  const currentJourney = journey && existsSync(join(repo.root, journey)) ? join(repo.root, journey) : undefined;
  if ((o.journeyFrom ?? 'current') === 'current' && !currentJourney) throw new Error(`Journey not found in the current checkout: ${journey}`);
  await repo.worktreeAdd(wt, bad);
  const cache = new Map<string, Verdict>();
  const test = async (sha: string): Promise<Verdict> => {
    const hit = cache.get(sha);
    if (hit) return hit;
    const t0 = Date.now();
    let verdict: Verdict;
    let note: string | undefined;
    await repo.run(['checkout', '-q', '--detach', '-f', sha], { cwd: wt });
    if ((o.journeyFrom ?? 'current') === 'current') {
      await mkdir(dirname(join(wt, journey)), { recursive: true });
      await copyFile(currentJourney!, join(wt, journey));
    }
    if (!existsSync(join(wt, journey))) {
      verdict = 'skip';
      note = 'journey file does not exist at this commit';
    } else {
      verdict = 'good';
      for (const s of o.setup ?? []) {
        const code = await runArgv(s, wt, timeoutMs);
        if (code !== 0) {
          verdict = 'skip';
          note = `setup "${s.join(' ')}" exited ${code}`;
          break;
        }
      }
      if (verdict !== 'skip') {
        if (o.test) verdict = await o.test({ dir: wt, sha, journey });
        else {
          const code = await runArgv([...(o.command ?? ['npx', '--no-install', 'eztest', 'run']), journey], wt, timeoutMs);
          verdict = code === 0 ? 'good' : code === 125 ? 'skip' : 'bad';
          note = `exit ${code}`;
        }
      }
    }
    // Undo the copied journey so the next checkout is clean.
    await repo.run(['checkout', '-q', '-f', 'HEAD', '--', '.'], { cwd: wt, okCodes: [1] }).catch(() => undefined);
    cache.set(sha, verdict);
    steps.push({ sha, verdict, durationMs: Date.now() - t0, ...(note ? { note } : {}) });
    log(`${sha.slice(0, 10)} ${verdict}${note ? ` (${note})` : ''}`);
    return verdict;
  };
  try {
    if (o.verifyEnds !== false) {
      if ((await test(good)) === 'bad') return { steps, tested: steps.length, total: commits.length, status: 'good-is-bad' };
      if ((await test(bad)) === 'good') return { steps, tested: steps.length, total: commits.length, status: 'bad-is-good' };
    }
    // commits[] is oldest..newest and ends with bad; index -1 stands for good.
    let lo = -1;
    let hi = commits.length - 1;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      // Nearest testable commit to mid inside (lo, hi): mid, mid+1, mid-1, mid+2, ...
      let probe: number | undefined;
      let v: Verdict = 'skip';
      for (let d = 0; d < hi - lo; d++) {
        for (const c of d === 0 ? [mid] : [mid + d, mid - d]) {
          if (c <= lo || c >= hi) continue;
          v = await test(commits[c]);
          if (v !== 'skip') {
            probe = c;
            break;
          }
        }
        if (probe !== undefined) break;
      }
      if (probe === undefined) {
        return { steps, tested: steps.length, total: commits.length, status: 'inconclusive', candidates: commits.slice(lo + 1, hi + 1) };
      }
      if (v === 'bad') hi = probe;
      else lo = probe;
    }
    const info = (await repo.log({ rev: commits[hi], max: 1 }))[0];
    return { firstBad: info, steps, tested: steps.length, total: commits.length, status: 'found' };
  } finally {
    await repo.worktreeRemove(wt).catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
