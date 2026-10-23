/**
 * Branch-aware results:
 *  - what every run records about the code it ran against (commit, branch,
 *    author, dirty state), with CI variables filling in the branch of a
 *    detached checkout;
 *  - per-branch visual baselines (`.eztest/baselines/branches/<branch>/`,
 *    seeded from the default branch's baselines) and promote-on-merge;
 *  - the branch of a run as stored in `RunResult.environment`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RunResult } from '../core/index.js';
import { GitRepo } from './repo.js';

/** Keys a run's `environment` carries (strings, like every other environment entry). */
export const RUN_VCS_KEYS = { commit: 'gitCommit', branch: 'gitBranch', author: 'gitAuthor', dirty: 'gitDirty', remote: 'gitRemote' } as const;

export interface RunVcs {
  commit?: string;
  branch?: string;
  author?: string;
  dirty?: boolean;
  remote?: string;
}

/** Strip refs/heads/ (and refs/pull/... for PR merge refs). */
function shortRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '') || undefined;
}

/** Branch from CI variables (PR source branch first): Azure Pipelines, GitHub Actions, GitLab CI, Bitbucket Pipelines, Jenkins. */
export function ciBranch(env: Record<string, string | undefined>): string | undefined {
  return (
    shortRef(env.SYSTEM_PULLREQUEST_SOURCEBRANCH) ??
    (env.BUILD_SOURCEBRANCH?.startsWith('refs/heads/') ? shortRef(env.BUILD_SOURCEBRANCH) : undefined) ??
    (env.GITHUB_HEAD_REF || undefined) ??
    (env.GITHUB_REF?.startsWith('refs/heads/') ? shortRef(env.GITHUB_REF) : undefined) ??
    env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ??
    env.CI_COMMIT_BRANCH ??
    env.BITBUCKET_BRANCH ??
    env.BRANCH_NAME ??
    env.GIT_BRANCH?.replace(/^origin\//, '') ??
    undefined
  );
}

/** Commit, branch, author and dirty state of the checkout at `cwd` (empty outside a repository or with EZTEST_GIT=off). */
export async function collectRunVcs(cwd: string, env: Record<string, string | undefined> = process.env): Promise<RunVcs> {
  if (/^(off|0|false|no)$/i.test(env.EZTEST_GIT ?? '')) return {};
  let repo: GitRepo;
  try {
    repo = await GitRepo.open(cwd, { timeoutMs: 10_000 });
  } catch {
    return {};
  }
  try {
    const info = await repo.runInfo();
    return {
      ...(info.commit ? { commit: info.commit } : {}),
      ...((info.branch ?? ciBranch(env)) ? { branch: info.branch ?? ciBranch(env) } : {}),
      ...(info.author ? { author: info.authorEmail ? `${info.author} <${info.authorEmail}>` : info.author } : {}),
      dirty: !!info.dirty,
      ...(info.remote ? { remote: stripUrlCredentials(info.remote) } : {}),
    };
  } catch {
    return {};
  }
}

export function stripUrlCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

/** The `environment` entries for a run. */
export function runVcsEnvironment(v: RunVcs): Record<string, string> {
  const out: Record<string, string> = {};
  if (v.commit) out[RUN_VCS_KEYS.commit] = v.commit;
  if (v.branch) out[RUN_VCS_KEYS.branch] = v.branch;
  if (v.author) out[RUN_VCS_KEYS.author] = v.author;
  if (v.dirty !== undefined) out[RUN_VCS_KEYS.dirty] = String(v.dirty);
  if (v.remote) out[RUN_VCS_KEYS.remote] = v.remote;
  return out;
}

/** Read what a run recorded about its code. */
export function runVcs(run: Pick<RunResult, 'environment'>): RunVcs {
  const e = run.environment ?? {};
  return {
    ...(e[RUN_VCS_KEYS.commit] ? { commit: e[RUN_VCS_KEYS.commit] } : {}),
    ...(e[RUN_VCS_KEYS.branch] ? { branch: e[RUN_VCS_KEYS.branch] } : {}),
    ...(e[RUN_VCS_KEYS.author] ? { author: e[RUN_VCS_KEYS.author] } : {}),
    ...(e[RUN_VCS_KEYS.dirty] !== undefined ? { dirty: e[RUN_VCS_KEYS.dirty] === 'true' } : {}),
    ...(e[RUN_VCS_KEYS.remote] ? { remote: e[RUN_VCS_KEYS.remote] } : {}),
  };
}

// ------------------------------------------------------------------ branch of a checkout, synchronously

/** The `.git` directory of a checkout (follows the `gitdir:` file of worktrees and submodules). */
/** The `.git` directory above `start` (following a worktree `.git` file), found without spawning git. */
export function gitDirOf(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const g = join(dir, '.git');
    if (existsSync(g)) {
      if (statSync(g).isDirectory()) return g;
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
      return m ? resolve(dir, m[1].trim()) : undefined;
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Current branch from `.git/HEAD` without spawning git (for synchronous callers); CI variables for detached checkouts. */
export function currentBranchSync(cwd: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.EZTEST_BRANCH) return env.EZTEST_BRANCH;
  const gd = gitDirOf(cwd);
  if (gd && existsSync(join(gd, 'HEAD'))) {
    const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gd, 'HEAD'), 'utf8'));
    if (m) return m[1].trim();
  }
  return ciBranch(env);
}

// ------------------------------------------------------------------ per-branch visual baselines

export function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '__').replace(/^\.+/, '_').slice(0, 120);
}

export interface BranchScopeOptions {
  /** The branch whose baselines are the shared ones (default: main). */
  defaultBranch?: string;
  branch?: string;
  env?: Record<string, string | undefined>;
}

/**
 * The baseline directory for the current branch: the shared directory on the
 * default branch (or when the branch is unknown), else
 * `<base>/branches/<branch>/`.
 */
export function branchBaselineDir(baseDir: string, cwd: string, o: BranchScopeOptions = {}): string {
  const branch = o.branch ?? currentBranchSync(cwd, o.env);
  if (!branch || branch === (o.defaultBranch ?? 'main')) return baseDir;
  return join(baseDir, 'branches', branchSlug(branch));
}

const isBaselineFile = (n: string) => /\.png$/i.test(n) || n === 'masks.json';

/** Copy the shared baselines a branch does not have yet into its directory (so a branch starts from the default branch's images). */
export async function seedBranchBaselines(baseDir: string, branchDir: string): Promise<string[]> {
  if (branchDir === baseDir || !existsSync(baseDir)) return [];
  await mkdir(branchDir, { recursive: true });
  const copied: string[] = [];
  for (const n of await readdir(baseDir)) {
    if (!isBaselineFile(n) || existsSync(join(branchDir, n))) continue;
    await copyFile(join(baseDir, n), join(branchDir, n));
    copied.push(n);
  }
  return copied;
}

/** Synchronous seeding, for code that builds lenses synchronously. */
export function seedBranchBaselinesSync(baseDir: string, branchDir: string): string[] {
  if (branchDir === baseDir || !existsSync(baseDir)) return [];
  mkdirSync(branchDir, { recursive: true });
  const copied: string[] = [];
  for (const n of readdirSync(baseDir)) {
    if (!isBaselineFile(n) || existsSync(join(branchDir, n))) continue;
    copyFileSync(join(baseDir, n), join(branchDir, n));
    copied.push(n);
  }
  return copied;
}

/**
 * Promote a branch's baselines into the shared directory (after its merge):
 * images that differ from the shared ones replace them; the branch directory
 * is removed unless `keep` is set.
 */
export async function promoteBranchBaselines(baseDir: string, branch: string, o: { keep?: boolean } = {}): Promise<{ promoted: string[]; branchDir: string }> {
  const dir = join(baseDir, 'branches', branchSlug(branch));
  if (!existsSync(dir)) return { promoted: [], branchDir: dir };
  const { readFile } = await import('node:fs/promises');
  const promoted: string[] = [];
  await mkdir(baseDir, { recursive: true });
  for (const n of await readdir(dir)) {
    if (!isBaselineFile(n)) continue;
    const src = join(dir, n);
    const dst = join(baseDir, n);
    if (existsSync(dst) && Buffer.compare(await readFile(src), await readFile(dst)) === 0) continue;
    await copyFile(src, dst);
    promoted.push(n);
  }
  if (!o.keep) await rm(dir, { recursive: true, force: true });
  return { promoted, branchDir: dir };
}

/** Branch directories under `<base>/branches/` (slugs). */
export async function branchBaselineSlugs(baseDir: string): Promise<string[]> {
  const d = join(baseDir, 'branches');
  if (!existsSync(d)) return [];
  return (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Promote every branch whose tip is merged into the default branch: its
 * baselines, and its history entries (relabelled to the default branch).
 */
export async function promoteMergedBranches(
  repo: GitRepo,
  o: { baselineDir: string; defaultBranch?: string; history?: { promote(from: string, to: string): number; save(): Promise<void> } },
): Promise<Array<{ branch: string; baselines: string[]; historyRuns: number }>> {
  const target = o.defaultBranch ?? (await repo.defaultBranch()) ?? 'main';
  const out: Array<{ branch: string; baselines: string[]; historyRuns: number }> = [];
  const bySlug = new Map((await repo.branches()).filter((b) => !b.remote).map((b) => [branchSlug(b.name), b]));
  for (const slug of await branchBaselineSlugs(o.baselineDir)) {
    const b = bySlug.get(slug);
    if (!b || b.name === target) continue;
    if (!(await repo.isAncestor(b.sha, target))) continue;
    const r = await promoteBranchBaselines(o.baselineDir, b.name);
    const historyRuns = o.history ? o.history.promote(b.name, target) : 0;
    out.push({ branch: b.name, baselines: r.promoted, historyRuns });
  }
  if (o.history && out.some((x) => x.historyRuns)) await o.history.save();
  return out;
}
