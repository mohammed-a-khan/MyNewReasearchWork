/**
 * Turn files a Studio action wrote (an accepted heal, approved baselines, a
 * quarantine entry) into a branch, a commit and a pull request, without
 * touching the user's working tree, index or current branch:
 *
 *   temporary index (GIT_INDEX_FILE) <- read-tree <target branch>
 *   + hash-object -w / update-index for each file from the working tree
 *   -> write-tree -> commit-tree -> update-ref refs/heads/<new branch>
 *   -> git push origin <branch> (the user's credential helper)
 *   -> provider.createPullRequest(reviewers from CODEOWNERS of the files)
 */
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBranchName, GitError } from '../git/exec.js';
import { loadCodeowners, ownersOf, type Owner } from '../git/codeowners.js';
import { GitRepo } from '../git/repo.js';
import type { PullRequestResult, VcsProvider } from './types.js';

export type ChangeKind = 'heal' | 'baseline' | 'quarantine' | 'journey';

export interface ChangeRequestInput {
  cwd: string;
  kind: ChangeKind;
  /** Files to include (absolute, or relative to cwd); deleted files are removed in the commit. */
  files: string[];
  title: string;
  body: string;
  /** Branch to create (default eztest/<kind>-<timestamp>). */
  branch?: string;
  /** Branch the PR targets (default: the current branch's upstream branch, else the default branch). */
  target?: string;
  remote?: string;
  /** Push and open the PR (default true). false: only create the local branch and commit. */
  push?: boolean;
  provider?: VcsProvider;
  draft?: boolean;
  /** Extra reviewers besides the CODEOWNERS of the files. */
  reviewers?: Owner[];
  /** Commit author "Name <email>" (default: git config user.name / user.email). */
  author?: string;
}

export interface ChangeRequestResult {
  branch: string;
  target: string;
  commit: string;
  parent: string;
  files: string[];
  pushed: boolean;
  pr?: PullRequestResult;
  reviewers: Owner[];
  warnings: string[];
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

export async function proposeChange(i: ChangeRequestInput): Promise<ChangeRequestResult> {
  const repo = await GitRepo.open(i.cwd);
  const warnings: string[] = [];
  const remote = i.remote ?? 'origin';
  const files = [...new Set(i.files.map((f) => repo.rel(f, i.cwd)))];
  if (!files.length) throw new GitError('No files to propose', null, '', 'GIT_INVALID');
  const branch = assertBranchName(i.branch ?? `eztest/${i.kind}-${stamp()}`);
  if ((await repo.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { okCodes: [1] })).code === 0) throw new GitError(`Branch ${branch} already exists`, null, '', 'GIT_EXISTS');

  // Target branch and the commit the change is based on.
  let target = i.target;
  if (!target) {
    const up = await repo.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okCodes: [128] });
    target = up.code === 0 ? up.stdout.trim().replace(new RegExp(`^${remote}/`), '') : ((await repo.defaultBranch()) ?? 'main');
  }
  const hasRemote = !!(await repo.remoteUrl(remote));
  if (hasRemote && i.push !== false) await repo.fetch(remote, target).catch((e: Error) => warnings.push(`fetch ${remote} ${target} failed (${e.message.split('\n')[0]}); basing the change on the local branch`));
  let parent: string | undefined;
  for (const ref of [`refs/remotes/${remote}/${target}`, `refs/heads/${target}`, 'HEAD']) {
    const r = await repo.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { okCodes: [1, 128] });
    if (r.code === 0) {
      parent = r.stdout.trim();
      if (ref === 'HEAD') warnings.push(`${target} not found; the change is based on HEAD`);
      break;
    }
  }
  if (!parent) throw new GitError('The repository has no commit to base the change on', null, '', 'GIT_INVALID');

  // Build the tree in a private index so the user's index and working tree stay untouched.
  const tmp = await mkdtemp(join(tmpdir(), 'eztest-cr-'));
  const env = { GIT_INDEX_FILE: join(tmp, 'index') };
  let commit: string;
  try {
    await repo.run(['read-tree', parent], { env });
    for (const f of files) {
      const abs = join(repo.root, f);
      if (existsSync(abs)) {
        const sha = (await repo.run(['hash-object', '-w', '--', f])).stdout.trim();
        const mode = statSync(abs).mode & 0o111 ? '100755' : '100644';
        await repo.run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${f}`], { env });
      } else await repo.run(['update-index', '--force-remove', '--', f], { env });
    }
    const tree = (await repo.run(['write-tree'], { env })).stdout.trim();
    const parentTree = (await repo.run(['rev-parse', `${parent}^{tree}`])).stdout.trim();
    if (tree === parentTree) throw new GitError(`The files already match ${target}; nothing to propose`, null, '', 'GIT_NOTHING');
    const authorEnv: Record<string, string> = {};
    if (i.author) {
      const m = /^([^<>]+?)\s*<([^<>\s]+)>$/.exec(i.author);
      if (!m) throw new GitError('author must look like "Name <email>"', null, '', 'GIT_INVALID');
      Object.assign(authorEnv, { GIT_AUTHOR_NAME: m[1], GIT_AUTHOR_EMAIL: m[2] });
    }
    commit = (await repo.run(['commit-tree', tree, '-p', parent, '-F', '-'], { input: `${i.title}\n\n${i.body}\n`, env: authorEnv })).stdout.trim();
    await repo.run(['update-ref', `refs/heads/${branch}`, commit, '']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // Reviewers: CODEOWNERS of every file in the change.
  const co = await loadCodeowners(repo.root);
  const reviewers: Owner[] = [];
  for (const o of [...files.flatMap((f) => ownersOf(co, f)), ...(i.reviewers ?? [])]) if (!reviewers.some((r) => r.raw === o.raw)) reviewers.push(o);

  let pushed = false;
  let pr: PullRequestResult | undefined;
  if (i.push !== false) {
    if (!hasRemote) warnings.push(`no remote "${remote}"; the branch ${branch} was created locally only`);
    else {
      await repo.run(['push', '--porcelain', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 180_000 });
      pushed = true;
      if (i.provider) {
        pr = await i.provider.createPullRequest({ source: branch, target, title: i.title, description: i.body, reviewers, draft: i.draft });
        warnings.push(...pr.warnings);
      } else warnings.push('no hosting provider configured; push done, open the pull request by hand');
    }
  }
  return { branch, target, commit, parent, files, pushed, ...(pr ? { pr } : {}), reviewers, warnings };
}
