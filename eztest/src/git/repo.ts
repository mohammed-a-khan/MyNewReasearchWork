/**
 * A thin, typed layer over the `git` command line for one working tree:
 * status, diffs (line and word level), stage/unstage, commit, branches,
 * pull/push, history, blame, conflicts and worktrees. Every call is an
 * argument array (see exec.ts); paths are confined to the repository.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertBranchName, assertSafePath, assertSafeRef, git, GitError, type GitExecOptions, type GitExecResult } from './exec.js';

export type StatusKind = 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

export interface StatusEntry {
  path: string;
  /** Previous path of a rename/copy. */
  from?: string;
  kind: StatusKind;
  /** Index (staged) status letter: M A D R C U or '.' */
  index: string;
  /** Working tree status letter: M A D U ? or '.' */
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}

export interface BranchStatus {
  head?: string;
  sha?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
}

export interface RepoStatus {
  branch: BranchStatus;
  entries: StatusEntry[];
  /** True while a merge/rebase/cherry-pick is in progress. */
  operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface BlameLine {
  line: number;
  text: string;
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  summary: string;
  /** True for lines not committed yet. */
  uncommitted: boolean;
}

export interface WordSegment {
  kind: ' ' | '+' | '-';
  text: string;
}

export interface WordDiffLine {
  oldNo?: number;
  newNo?: number;
  segments: WordSegment[];
  /** ' ' unchanged, '~' changed in place, '+' added line, '-' removed line. */
  kind: ' ' | '~' | '+' | '-';
}

export interface WordDiffHunk {
  header: string;
  lines: WordDiffLine[];
}

export interface BranchInfo {
  name: string;
  sha: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
}

export interface RunVcsInfo {
  commit?: string;
  branch?: string;
  author?: string;
  authorEmail?: string;
  dirty?: boolean;
  remote?: string;
}

const US = '\x1f';
const RS = '\x1e';

export class GitRepo {
  private constructor(
    readonly root: string,
    readonly gitDir: string,
    private readonly exec: Omit<GitExecOptions, 'cwd'> = {},
  ) {}

  /** Open the repository containing `cwd` (throws GIT_NOT_A_REPO when there is none). */
  static async open(cwd: string, opts: Omit<GitExecOptions, 'cwd'> = {}): Promise<GitRepo> {
    let top: string;
    let gitDir: string;
    try {
      [top, gitDir] = (await git(['rev-parse', '--show-toplevel', '--absolute-git-dir'], { ...opts, cwd })).stdout.trim().split('\n');
    } catch (e) {
      if (e instanceof GitError && e.code === 'GIT_MISSING') throw e;
      throw new GitError(`${cwd} is not inside a git repository`, (e as GitError).exitCode ?? null, (e as GitError).stderr ?? '', 'GIT_NOT_A_REPO');
    }
    return new GitRepo(resolve(top), resolve(gitDir), opts);
  }

  /** Initialise a new repository (used by tests and `eztest init`). */
  static async init(dir: string, opts: { branch?: string } = {}): Promise<GitRepo> {
    await git(['init', '-q', '-b', assertBranchName(opts.branch ?? 'main'), dir], { cwd: dir });
    return GitRepo.open(dir);
  }

  run(args: string[], o: Partial<GitExecOptions> = {}): Promise<GitExecResult> {
    return git(args, { ...this.exec, ...o, cwd: o.cwd ?? this.root });
  }

  /** A path relative to the repository root (absolute paths and paths from `cwd` accepted). */
  rel(p: string, from = this.root): string {
    const abs = isAbsolute(p) ? p : resolve(from, p);
    const r = relative(this.root, abs);
    if (r.startsWith('..') || isAbsolute(r)) throw new GitError(`Path is outside the repository: ${p}`, null, '', 'GIT_UNSAFE_PATH');
    return assertSafePath(r.split(sep).join('/') || '.');
  }

  private paths(ps: string[]): string[] {
    return ps.map((p) => this.rel(p));
  }

  // ------------------------------------------------------------------ state

  async headSha(): Promise<string | undefined> {
    try {
      return (await this.run(['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async currentBranch(): Promise<string | undefined> {
    const r = await this.run(['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [1] });
    return r.stdout.trim() || undefined;
  }

  async status(): Promise<RepoStatus> {
    const r = await this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    const parts = r.stdout.split('\0');
    const branch: BranchStatus = { ahead: 0, behind: 0, detached: false };
    const entries: StatusEntry[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (p.startsWith('# ')) {
        const [, key, ...rest] = p.split(' ');
        const v = rest.join(' ');
        if (key === 'branch.oid') branch.sha = v === '(initial)' ? undefined : v;
        else if (key === 'branch.head') {
          branch.detached = v === '(detached)';
          branch.head = branch.detached ? undefined : v;
        } else if (key === 'branch.upstream') branch.upstream = v;
        else if (key === 'branch.ab') {
          const m = /^\+(\d+) -(\d+)$/.exec(v);
          if (m) {
            branch.ahead = Number(m[1]);
            branch.behind = Number(m[2]);
          }
        }
        continue;
      }
      const type = p[0];
      if (type === '?' || type === '!') {
        entries.push({ path: p.slice(2), kind: type === '?' ? 'untracked' : 'ignored', index: '.', worktree: '?', staged: false, unstaged: true, conflicted: false });
        continue;
      }
      const f = p.split(' ');
      const xy = f[1];
      if (type === '1') {
        const path = f.slice(8).join(' ');
        entries.push(entry(path, 'changed', xy));
      } else if (type === '2') {
        const path = f.slice(9).join(' ');
        const from = parts[++i];
        entries.push({ ...entry(path, 'renamed', xy), from });
      } else if (type === 'u') {
        const path = f.slice(10).join(' ');
        entries.push({ ...entry(path, 'unmerged', xy), conflicted: true });
      }
    }
    return { branch, entries, operation: this.operation() };
  }

  private operation(): RepoStatus['operation'] {
    const gd = this.gitDir;
    if (existsSync(join(gd, 'MERGE_HEAD'))) return 'merge';
    if (existsSync(join(gd, 'rebase-merge')) || existsSync(join(gd, 'rebase-apply'))) return 'rebase';
    if (existsSync(join(gd, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    if (existsSync(join(gd, 'REVERT_HEAD'))) return 'revert';
    if (existsSync(join(gd, 'BISECT_LOG'))) return 'bisect';
    return undefined;
  }

  async isDirty(): Promise<boolean> {
    const r = await this.run(['status', '--porcelain', '--untracked-files=no']);
    return r.stdout.trim().length > 0;
  }

  /** Commit, branch, author and dirty state of the working tree (for run results). */
  async runInfo(): Promise<RunVcsInfo> {
    const sha = await this.headSha();
    const out: RunVcsInfo = { branch: await this.currentBranch(), dirty: await this.isDirty() };
    if (sha) {
      out.commit = sha;
      const r = await this.run(['log', '-1', `--format=%an${US}%ae`, sha]);
      const [an, ae] = r.stdout.trim().split(US);
      out.author = an;
      out.authorEmail = ae;
    }
    const remote = await this.remoteUrl().catch(() => undefined);
    if (remote) out.remote = remote;
    return out;
  }

  async remoteUrl(name = 'origin'): Promise<string | undefined> {
    assertSafeRef(name, 'remote');
    const r = await this.run(['remote', 'get-url', name], { okCodes: [2, 128] });
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** origin/HEAD's branch, else main or master if present, else the current branch. */
  async defaultBranch(): Promise<string | undefined> {
    const r = await this.run(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { okCodes: [1, 128] });
    const v = r.stdout.trim();
    if (v) return v.replace(/^origin\//, '');
    for (const b of ['main', 'master']) {
      const x = await this.run(['rev-parse', '--verify', '-q', `refs/heads/${b}`], { okCodes: [1] });
      if (x.code === 0) return b;
    }
    return this.currentBranch();
  }

  // ------------------------------------------------------------------ diff

  /** Unified diff of one file: working tree vs index (default), or index vs HEAD (staged). Untracked files diff against /dev/null. */
  async diff(path: string, opts: { staged?: boolean; context?: number } = {}): Promise<string> {
    const p = this.rel(path);
    const ctx = `-U${opts.context ?? 3}`;
    if (!opts.staged && (await this.isUntracked(p))) {
      return (await this.run(['diff', '--no-color', '--no-index', ctx, '--', '/dev/null', p], { okCodes: [1] })).stdout;
    }
    return (await this.run(['diff', '--no-color', ctx, ...(opts.staged ? ['--cached'] : []), '--', p])).stdout;
  }

  private async isUntracked(p: string): Promise<boolean> {
    const r = await this.run(['ls-files', '--error-unmatch', '--', p], { okCodes: [1] });
    return r.code !== 0 && existsSync(join(this.root, p));
  }

  /**
   * Word-level diff of one file, parsed from `git diff --word-diff=porcelain`.
   * Words are runs of non-space characters, so a changed quoted target or value
   * shows as one replaced word rather than a whole replaced line.
   */
  async wordDiff(path: string, opts: { staged?: boolean; context?: number; base?: string } = {}): Promise<WordDiffHunk[]> {
    const p = this.rel(path);
    const args = ['diff', '--no-color', `-U${opts.context ?? 3}`, '--word-diff=porcelain', '--word-diff-regex=[^[:space:]]+'];
    let text: string;
    if (opts.base) text = (await this.run([...args, assertSafeRef(opts.base), '--', p])).stdout;
    else if (!opts.staged && (await this.isUntracked(p))) text = (await this.run([...args, '--no-index', '--', '/dev/null', p], { okCodes: [1] })).stdout;
    else text = (await this.run([...args, ...(opts.staged ? ['--cached'] : []), '--', p])).stdout;
    return parseWordDiff(text);
  }

  // ------------------------------------------------------------------ index and commits

  async stage(paths: string[], opts: { force?: boolean } = {}): Promise<void> {
    if (!paths.length) return;
    await this.run(['add', ...(opts.force ? ['-f'] : []), '--', ...this.paths(paths)]);
  }

  async unstage(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const ps = this.paths(paths);
    if (await this.headSha()) await this.run(['restore', '--staged', '--', ...ps]);
    else await this.run(['rm', '--cached', '-q', '-r', '--', ...ps]);
  }

  /** Discard working-tree changes of tracked files (restore from the index). */
  async discard(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.run(['restore', '--worktree', '--', ...this.paths(paths)]);
  }

  /** Commit what is staged. The message goes through stdin, never the command line. */
  async commit(message: string, opts: { allowEmpty?: boolean; author?: string; noVerify?: boolean } = {}): Promise<string> {
    if (!message.trim()) throw new GitError('A commit message is required', null, '', 'GIT_INVALID');
    const args = ['commit', '-q', '-F', '-', '--cleanup=strip'];
    if (opts.allowEmpty) args.push('--allow-empty');
    if (opts.noVerify) args.push('--no-verify');
    if (opts.author) {
      if (!/^[^<>\n]+ <[^<>\s@]+@[^<>\s]+>$/.test(opts.author)) throw new GitError('author must look like "Name <email>"', null, '', 'GIT_INVALID');
      args.push(`--author=${opts.author}`);
    }
    await this.run(args, { input: message });
    return (await this.headSha())!;
  }

  // ------------------------------------------------------------------ branches

  async branches(): Promise<BranchInfo[]> {
    const fmt = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(HEAD)'].join(US);
    const r = await this.run(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes']);
    const out: BranchInfo[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [ref, sha, upstream, head] = line.split(US);
      if (ref.endsWith('/HEAD')) continue;
      const remote = ref.startsWith('refs/remotes/');
      out.push({ name: ref.replace(/^refs\/(heads|remotes)\//, ''), sha, remote, current: head === '*', ...(upstream ? { upstream } : {}) });
    }
    return out;
  }

  async createBranch(name: string, opts: { from?: string; checkout?: boolean } = {}): Promise<void> {
    assertBranchName(name);
    const from = opts.from ? [assertSafeRef(opts.from)] : [];
    if (opts.checkout) await this.run(['switch', '-c', name, ...from]);
    else await this.run(['branch', name, ...from]);
  }

  /** Switch branches. Refuses (by git's own rules) when local changes would be overwritten. */
  async switchBranch(name: string): Promise<void> {
    assertSafeRef(name, 'branch');
    await this.run(['switch', name]);
  }

  async pull(opts: { remote?: string; branch?: string; ffOnly?: boolean } = {}): Promise<{ output: string; conflicts: string[] }> {
    const args = ['pull', '--no-edit', ...(opts.ffOnly ? ['--ff-only'] : ['--no-rebase'])];
    if (opts.remote) args.push(assertSafeRef(opts.remote, 'remote'));
    if (opts.branch) args.push(assertSafeRef(opts.branch, 'branch'));
    try {
      const r = await this.run(args, { timeoutMs: 180_000 });
      return { output: (r.stdout + r.stderr).trim(), conflicts: [] };
    } catch (e) {
      const conflicts = await this.conflictedFiles();
      if (conflicts.length) return { output: (e as GitError).stderr.trim(), conflicts };
      throw e;
    }
  }

  async push(opts: { remote?: string; branch?: string; setUpstream?: boolean; force?: 'with-lease' } = {}): Promise<string> {
    const remote = assertSafeRef(opts.remote ?? 'origin', 'remote');
    const branch = opts.branch ?? (await this.currentBranch());
    if (!branch) throw new GitError('Cannot push a detached HEAD without a branch name', null, '', 'GIT_INVALID');
    const args = ['push', '--porcelain', ...(opts.setUpstream ? ['-u'] : []), ...(opts.force ? ['--force-with-lease'] : []), remote, assertSafeRef(branch, 'branch')];
    const r = await this.run(args, { timeoutMs: 180_000 });
    return (r.stdout + r.stderr).trim();
  }

  async fetch(remote = 'origin', ref?: string): Promise<void> {
    await this.run(['fetch', '-q', assertSafeRef(remote, 'remote'), ...(ref ? [assertSafeRef(ref)] : [])], { timeoutMs: 180_000 });
  }

  // ------------------------------------------------------------------ history

  async log(opts: { path?: string; max?: number; rev?: string } = {}): Promise<CommitInfo[]> {
    if (!(await this.headSha())) return [];
    const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join(US) + RS;
    const args = ['log', `--format=${fmt}`, `-n${Math.max(1, Math.min(opts.max ?? 50, 1000))}`];
    if (opts.rev) args.push(assertSafeRef(opts.rev));
    if (opts.path) args.push('--follow', '--', this.rel(opts.path));
    const r = await this.run(args);
    return r.stdout
      .split(RS)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [sha, shortSha, author, email, date, subject] = s.split(US);
        return { sha, shortSha, author, email, date, subject };
      });
  }

  /** `git blame --porcelain` of a file (working tree version: uncommitted lines are marked). */
  async blame(path: string, opts: { rev?: string } = {}): Promise<BlameLine[]> {
    const p = this.rel(path);
    if (!(await this.headSha())) return [];
    const r = await this.run(['blame', '--porcelain', ...(opts.rev ? [assertSafeRef(opts.rev)] : []), '--', p]);
    return parseBlamePorcelain(r.stdout);
  }

  /** Content of a file at a revision (`:1`/`:2`/`:3` stages allowed); undefined when it does not exist there. */
  async show(rev: string, path: string): Promise<string | undefined> {
    const spec = /^:[0-3]$/.test(rev) ? `${rev}:${this.rel(path)}` : `${assertSafeRef(rev)}:${this.rel(path)}`;
    const r = await this.run(['show', spec], { okCodes: [128] });
    return r.code === 0 ? r.stdout : undefined;
  }

  async revParse(rev: string): Promise<string> {
    return (await this.run(['rev-parse', '--verify', `${assertSafeRef(rev)}^{commit}`])).stdout.trim();
  }

  async mergeBase(a: string, b: string): Promise<string | undefined> {
    const r = await this.run(['merge-base', assertSafeRef(a), assertSafeRef(b)], { okCodes: [1] });
    return r.stdout.trim() || undefined;
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', assertSafeRef(a), assertSafeRef(b)], { okCodes: [1] });
    return r.code === 0;
  }

  /** Commits reachable from `bad` but not from `good`, oldest first (first-parent line). */
  async commitsBetween(good: string, bad: string): Promise<string[]> {
    const r = await this.run(['rev-list', '--first-parent', '--reverse', `${assertSafeRef(good)}..${assertSafeRef(bad)}`]);
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Files changed between two revisions (`base...head`). */
  async changedFiles(base: string, head = 'HEAD'): Promise<string[]> {
    const r = await this.run(['diff', '--name-only', '--no-renames', `${assertSafeRef(base)}...${assertSafeRef(head)}`, '--']);
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /** Staged files (added, copied, modified, renamed). */
  async stagedFiles(): Promise<string[]> {
    const r = await this.run(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
    return r.stdout.split('\0').filter(Boolean);
  }

  // ------------------------------------------------------------------ conflicts

  async conflictedFiles(): Promise<string[]> {
    const r = await this.run(['diff', '--name-only', '--diff-filter=U', '-z']);
    return r.stdout.split('\0').filter(Boolean);
  }

  /** The three versions of a conflicted file: base (:1), ours (:2), theirs (:3), plus the working copy with markers. */
  async conflictVersions(path: string): Promise<{ base?: string; ours?: string; theirs?: string; working: string }> {
    const p = this.rel(path);
    const { readFile } = await import('node:fs/promises');
    return {
      base: await this.show(':1', p),
      ours: await this.show(':2', p),
      theirs: await this.show(':3', p),
      working: existsSync(join(this.root, p)) ? await readFile(join(this.root, p), 'utf8') : '',
    };
  }

  // ------------------------------------------------------------------ worktrees and hooks

  async worktreeAdd(dir: string, rev: string): Promise<void> {
    await this.run(['worktree', 'add', '--detach', '-q', '-f', dir, assertSafeRef(rev)], { timeoutMs: 300_000 });
  }

  async worktreeRemove(dir: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', dir], { okCodes: [128] });
    await this.run(['worktree', 'prune']);
  }

  /** The hooks directory (honours core.hooksPath). */
  async hooksDir(): Promise<string> {
    const r = await this.run(['rev-parse', '--git-path', 'hooks']);
    return resolve(this.root, r.stdout.trim());
  }

  async config(key: string): Promise<string | undefined> {
    const r = await this.run(['config', '--get', key], { okCodes: [1] });
    return r.stdout.trim() || undefined;
  }
}

function entry(path: string, kind: StatusKind, xy: string): StatusEntry {
  const [x, y] = [xy[0], xy[1]];
  const conflicted = kind === 'unmerged' || x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
  return { path, kind, index: x, worktree: y, staged: x !== '.' && !conflicted, unstaged: y !== '.' && !conflicted, conflicted };
}

/** Parse `git diff --word-diff=porcelain` output into hunks of word segments. */
export function parseWordDiff(text: string): WordDiffHunk[] {
  const hunks: WordDiffHunk[] = [];
  let cur: WordDiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let segs: WordSegment[] = [];
  // In a hunk that only adds (or only removes) lines, a blank line is an added (removed) line too.
  let onlyAdds = false;
  let onlyRemoves = false;
  const flush = () => {
    if (!cur) return;
    if (!segs.length && (onlyAdds || onlyRemoves)) segs = [{ kind: onlyAdds ? '+' : '-', text: '' }];
    const hasOld = segs.some((s) => s.kind !== '+');
    const hasNew = segs.some((s) => s.kind !== '-');
    const changed = segs.some((s) => s.kind !== ' ');
    const kind: WordDiffLine['kind'] = !changed ? ' ' : !hasOld ? '+' : !hasNew ? '-' : '~';
    // An empty context line (blank line in the file) still occupies a line number.
    cur.lines.push({ kind, segments: segs, ...(hasOld || kind === ' ' ? { oldNo: oldNo } : {}), ...(hasNew || kind === ' ' ? { newNo: newNo } : {}) });
    if (hasOld || kind === ' ') oldNo++;
    if (hasNew || kind === ' ') newNo++;
    segs = [];
  };
  for (const line of text.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (h) {
      if (cur && segs.length) flush();
      cur = { header: line, lines: [] };
      hunks.push(cur);
      oldNo = Number(h[1]) || 1;
      newNo = Number(h[3]) || 1;
      onlyAdds = h[2] === '0';
      onlyRemoves = h[4] === '0';
      segs = [];
      continue;
    }
    if (!cur) continue;
    if (line === '~') {
      flush();
      continue;
    }
    const k = line[0];
    if (k === ' ' || k === '+' || k === '-') {
      const t = line.slice(1);
      const prev = segs[segs.length - 1];
      // git emits the whitespace between words as part of the context segments.
      if (prev && prev.kind === k) prev.text += t;
      else segs.push({ kind: k, text: t });
    }
  }
  if (cur && segs.length) flush();
  return hunks;
}

/** Parse `git blame --porcelain`. */
export function parseBlamePorcelain(text: string): BlameLine[] {
  const commits = new Map<string, { author: string; email: string; time: number; summary: string }>();
  const out: BlameLine[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const head = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(lines[i]);
    if (!head) {
      i++;
      continue;
    }
    const sha = head[1];
    const finalLine = Number(head[3]);
    const meta = commits.get(sha) ?? { author: '', email: '', time: 0, summary: '' };
    i++;
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const l = lines[i];
      if (l.startsWith('author ')) meta.author = l.slice(7);
      else if (l.startsWith('author-mail ')) meta.email = l.slice(12).replace(/^<|>$/g, '');
      else if (l.startsWith('author-time ')) meta.time = Number(l.slice(12));
      else if (l.startsWith('summary ')) meta.summary = l.slice(8);
      i++;
    }
    commits.set(sha, meta);
    const content = (lines[i] ?? '\t').slice(1);
    i++;
    const uncommitted = /^0+$/.test(sha);
    out.push({
      line: finalLine,
      text: content,
      sha,
      shortSha: sha.slice(0, 8),
      author: uncommitted ? 'Not committed yet' : meta.author,
      email: uncommitted ? '' : meta.email,
      date: meta.time ? new Date(meta.time * 1000).toISOString() : '',
      summary: uncommitted ? '' : meta.summary,
      uncommitted,
    });
  }
  return out.sort((a, b) => a.line - b.line);
}
