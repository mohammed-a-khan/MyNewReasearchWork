/**
 * Run the `git` program itself: spawned without a shell, with an argument
 * array, never prompting (GIT_TERMINAL_PROMPT=0) so the user's credential
 * helper is the only source of credentials. Output is decoded as UTF-8 and
 * error text is passed through a redactor (remote URLs may embed tokens).
 */
import { spawn } from 'node:child_process';
import { EzTestError } from '../core/index.js';

export class GitError extends EzTestError {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    code = 'GIT_FAILED',
  ) {
    super(message, code, { exitCode });
    this.name = 'GitError';
  }
}

export interface GitExecOptions {
  cwd: string;
  /** Text written to stdin. */
  input?: string | Buffer;
  /** Extra environment (merged over process.env). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Exit codes that are not errors (e.g. 1 for `git diff --no-index`). */
  okCodes?: number[];
  /** Return raw bytes instead of text. */
  binary?: boolean;
  /** Path of the git executable (default "git"). */
  gitPath?: string;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  bytes?: Buffer;
}

/** Remove credentials embedded in URLs (https://user:token@host) and bearer/basic headers. */
export function redactGitText(s: string): string {
  return s
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(:[^@/\s]*)?@/gi, (_m, scheme: string) => `${scheme}***@`)
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/g, '$1 ***')
    .replace(/(extraheader\s*=?\s*["']?AUTHORIZATION:\s*)[^\s"']+(\s+[^\s"']+)?/gi, '$1***');
}

/** A ref, branch or revision a user typed: never an option, no whitespace or control characters. */
export function assertSafeRef(ref: string, what = 'ref'): string {
  if (/^@\{(?:u|upstream|push)\}$/.test(ref)) return ref;
  const ok =
    /^[A-Za-z0-9_][A-Za-z0-9._/@{}+-]*(?:[~^]\d*)*$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.lock') &&
    !/@\{(?!u\}|upstream\}|push\})/.test(ref);
  if (!ok) throw new GitError(`Unsafe git ${what}: ${JSON.stringify(ref)}`, null, '', 'GIT_UNSAFE_REF');
  return ref;
}

/** A new branch name: like a ref, but no revision suffixes. */
export function assertBranchName(name: string): string {
  assertSafeRef(name, 'branch name');
  if (/[~^{}@]/.test(name) || name === 'HEAD') throw new GitError(`Invalid branch name: ${JSON.stringify(name)}`, null, '', 'GIT_UNSAFE_REF');
  return name;
}

/** A path argument: relative, inside the repo, never an option. */
export function assertSafePath(p: string): string {
  if (!p || p.startsWith('-') || p.includes('\0')) throw new GitError(`Unsafe path: ${JSON.stringify(p)}`, null, '', 'GIT_UNSAFE_PATH');
  const norm = p.split('\\').join('/');
  if (norm.startsWith('/') || /^[A-Za-z]:\//.test(norm) || norm.split('/').includes('..')) throw new GitError(`Path must stay inside the repository: ${p}`, null, '', 'GIT_UNSAFE_PATH');
  return norm;
}

export function git(args: string[], opts: GitExecOptions): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.gitPath ?? 'git', args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_ASKPASS: process.env.GIT_ASKPASS ?? '',
        SSH_ASKPASS: process.env.SSH_ASKPASS ?? '',
        LC_ALL: 'C',
        LANG: 'C',
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '0',
        ...opts.env,
      },
    });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(opts.input);
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new GitError(`git could not be started: ${e.message}`, null, '', 'GIT_MISSING'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      const stdout = opts.binary ? '' : bytes.toString('utf8');
      const ok = code === 0 || (code !== null && (opts.okCodes ?? []).includes(code));
      if (!ok) {
        const what = args.filter((a) => !a.startsWith('-c') && !/^http\..*extraheader/i.test(a)).slice(0, 2).join(' ');
        const why = signal ? `killed (${signal}), timeout ${opts.timeoutMs ?? 60_000} ms` : `exited ${code}`;
        reject(new GitError(redactGitText(`git ${what} ${why}: ${err.trim().split('\n').slice(-6).join('\n')}`), code, redactGitText(err)));
        return;
      }
      resolve({ stdout, stderr: redactGitText(err), code: code ?? 0, ...(opts.binary ? { bytes } : {}) });
    });
  });
}
