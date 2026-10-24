/**
 * SFTP and SSH on ssh2 (MIT, optional peer), and local folder file drops.
 * SSH commands run only when they match the host's allow-list; host keys are
 * checked strictly against .eztest/known_hosts (known-hosts.ts), or pinned by
 * SHA-256 fingerprint; local folders must be inside the project
 * or listed in files.allowFolders. Downloaded files land in the run directory
 * as evidence, shaped like browser downloads so "Read the download X as rows"
 * and document checks work on them.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';
import { globToRegExp } from '../insights/glob.js';
import { loadClient } from './bus/types.js';
import { checkHostKey, fingerprintOf } from './known-hosts.js';

type Any = any;

export interface SshTarget {
  host: string;
  port?: number;
  username: string;
  password?: string;
  /** Private key file (absolute or relative to baseDir) or PEM text. */
  privateKey?: string;
  passphrase?: string;
  hostKeySha256?: string;
  /** known_hosts file (absolute or relative to baseDir). Default .eztest/known_hosts. */
  knownHosts?: string;
  /** Accept and record the key of a host the known_hosts file does not list yet. Default false. */
  trustOnFirstUse?: boolean;
  root?: string;
}

export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
}

export interface ExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class SshSession {
  private conn?: Any;
  private sftpHandle?: Any;
  /** Why the connection broke after it was set up; the next operation reports it. */
  private lost?: EzTestError;

  constructor(readonly name: string, readonly target: SshTarget, readonly baseDir: string) {}

  /** The known_hosts file this session checks host keys against. */
  get knownHostsFile(): string {
    const k = this.target.knownHosts ?? join('.eztest', 'known_hosts');
    return isAbsolute(k) ? k : resolve(this.baseDir, k);
  }

  private async connect(): Promise<Any> {
    if (this.lost) {
      const e = this.lost;
      this.lost = undefined;
      throw e;
    }
    if (this.conn) return this.conn;
    const ssh2 = await loadClient('ssh2', 'SFTP/SSH');
    const t = this.target;
    let privateKey: Buffer | string | undefined;
    if (t.privateKey) privateKey = /-----BEGIN/.test(t.privateKey) ? t.privateKey : await readFile(isAbsolute(t.privateKey) ? t.privateKey : resolve(this.baseDir, t.privateKey));
    const want = t.hostKeySha256?.replace(/^SHA256:/, '').replace(/=+$/, '');
    const port = t.port ?? 22;
    let refused: string | undefined;
    // Strict host-key checking: the pinned fingerprint, else the known_hosts file.
    const hostVerifier = (key: Buffer): boolean => {
      if (want) {
        const got = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        if (got !== want) refused = `The host key of ${this.name} (${t.host}:${port}) is ${fingerprintOf(key)}, not the pinned hostKeySha256 SHA256:${want}`;
        return got === want;
      }
      const r = checkHostKey(this.knownHostsFile, t.host, port, key, { trustOnFirstUse: t.trustOnFirstUse, label: this.name });
      if (!r.ok) refused = r.reason;
      return r.ok;
    };
    const conn = new ssh2.Client();
    let ready = false;
    await new Promise<void>((res, rej) => {
      conn.on('ready', () => {
        ready = true;
        res();
      });
      conn.on('error', (e: Error) => {
        if (!ready) {
          rej(refused ? new EzTestError(refused, 'SSH_HOST_KEY') : new EzTestError(`SSH connection to ${this.name} (${t.host}) failed: ${e.message}`, 'SSH_CONNECT'));
          return;
        }
        // After setup: remember why, so the next operation fails with it instead of hanging or acting on a dead link.
        this.lost = new EzTestError(`The SSH connection to ${this.name} (${t.host}) was lost: ${e.message}`, 'SSH_LOST');
        if (this.conn === conn) {
          this.conn = undefined;
          this.sftpHandle = undefined;
        }
      });
      conn.on('close', () => {
        if (ready && this.conn === conn) {
          this.lost ??= new EzTestError(`The SSH connection to ${this.name} (${t.host}) was closed by the server`, 'SSH_LOST');
          this.conn = undefined;
          this.sftpHandle = undefined;
        }
      });
      conn.connect({
        host: t.host, port, username: t.username, readyTimeout: 20_000, hostVerifier,
        ...(t.password ? { password: t.password } : {}), ...(privateKey ? { privateKey } : {}), ...(t.passphrase ? { passphrase: t.passphrase } : {}),
      });
    });
    this.conn = conn;
    return conn;
  }

  private async sftp(): Promise<Any> {
    if (this.sftpHandle) return this.sftpHandle;
    const c = await this.connect();
    this.sftpHandle = await new Promise((res, rej) => c.sftp((e: Error | undefined, s: Any) => (e ? rej(new EzTestError(`SFTP on ${this.name}: ${e.message}`, 'SFTP')) : res(s))));
    return this.sftpHandle;
  }

  remote(p: string): string {
    if (p.startsWith('/') || !this.target.root) return p;
    return posix.join(this.target.root, p);
  }

  async upload(local: string, remotePath: string): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((res, rej) => s.fastPut(local, this.remote(remotePath), (e: Error | undefined) => (e ? rej(new EzTestError(`SFTP upload to ${this.name}:${remotePath} failed: ${e.message}`, 'SFTP')) : res())));
  }

  async download(remotePath: string, local: string): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((res, rej) => s.fastGet(this.remote(remotePath), local, (e: Error | undefined) => (e ? rej(new EzTestError(`SFTP download of ${this.name}:${remotePath} failed: ${e.message}`, 'SFTP')) : res())));
  }

  async list(dir: string): Promise<RemoteFile[]> {
    const s = await this.sftp();
    const d = this.remote(dir);
    const entries: Any[] = await new Promise((res, rej) => s.readdir(d, (e: Error | undefined, l: Any[]) => (e ? rej(new EzTestError(`SFTP list of ${this.name}:${dir} failed: ${e.message}`, 'SFTP')) : res(l))));
    return entries.map((x) => ({
      name: x.filename, path: posix.join(dir, x.filename), size: Number(x.attrs?.size ?? 0),
      modifiedAt: new Date(Number(x.attrs?.mtime ?? 0) * 1000).toISOString(), isDirectory: typeof x.attrs?.isDirectory === 'function' ? x.attrs.isDirectory() : false,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(remotePath: string): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((res, rej) => s.unlink(this.remote(remotePath), (e: Error | undefined) => (e ? rej(new EzTestError(`SFTP delete of ${this.name}:${remotePath} failed: ${e.message}`, 'SFTP')) : res())));
  }

  async exec(command: string, timeoutMs = 300_000): Promise<ExecResult> {
    const c = await this.connect();
    const started = Date.now();
    return new Promise((res, rej) => {
      c.exec(command, (e: Error | undefined, stream: Any) => {
        if (e) return rej(new EzTestError(`SSH command on ${this.name} failed to start: ${e.message}`, 'SSH_EXEC'));
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stream.close?.();
          rej(new EzTestError(`SSH command on ${this.name} did not finish within ${timeoutMs} ms`, 'SSH_TIMEOUT'));
        }, timeoutMs);
        stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        stream.on('close', (code: number | null, signal?: string) => {
          clearTimeout(timer);
          res({ exitCode: code, ...(signal ? { signal } : {}), stdout, stderr, durationMs: Date.now() - started });
        });
      });
    });
  }

  close(): void {
    const c = this.conn;
    this.conn = undefined;
    this.sftpHandle?.end?.();
    this.sftpHandle = undefined;
    this.lost = undefined;
    c?.end();
  }
}

/** True when a command is allowed by the host's allow-list (exact text, or a glob where * matches any run of characters). */
export function commandAllowed(command: string, allow: string[]): boolean {
  return allow.some((a) => a === command || new RegExp(`^${a.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command));
}

export function fileMatcher(pattern: string): RegExp {
  return globToRegExp(pattern);
}

/** A local folder the step may use: inside the project, or listed in files.allowFolders. */
export function allowedFolder(folder: string, baseDir: string, allow: string[]): string {
  const abs = isAbsolute(folder) ? folder : resolve(baseDir, folder);
  const inside = (root: string) => {
    const r = relative(root, abs);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  if (inside(baseDir) || allow.some((a) => inside(isAbsolute(a) ? a : resolve(baseDir, a)))) return abs;
  throw new EzTestError(`Folder ${folder} is outside the project; add it to files.allowFolders to use it`, 'FOLDER_NOT_ALLOWED');
}

export async function listLocal(folder: string): Promise<RemoteFile[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const out: RemoteFile[] = [];
  for (const e of entries) {
    const p = join(folder, e.name);
    const st = await stat(p).catch(() => undefined);
    if (!st) continue;
    out.push({ name: e.name, path: p, size: st.size, modifiedAt: st.mtime.toISOString(), isDirectory: e.isDirectory() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function copyLocal(src: string, folder: string, name?: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  const dest = join(folder, name ?? basename(src));
  await copyFile(src, dest);
  return dest;
}

export async function removeLocal(path: string): Promise<void> {
  await unlink(path);
}
