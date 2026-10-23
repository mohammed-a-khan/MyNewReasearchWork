/**
 * Managed app start (`webServer:` in config): start the application under
 * test before the run and stop it after. The command is spawned without a
 * shell (an argument list, or a string split on spaces with quotes honoured),
 * readiness is a URL that answers or a line of output matching a pattern, and
 * `reuseExisting` skips spawning when the URL already answers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export interface WebServerConfig {
  command: string | string[];
  url?: string;
  /** Regular expression matched against stdout/stderr lines. */
  waitFor?: string;
  timeoutSeconds?: number;
  reuseExisting?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

export interface WebServerHandle {
  reused: boolean;
  pid?: number;
  output(): string;
  stop(): Promise<void>;
}

/** Split a command line into arguments (no shell: quotes group words, nothing is expanded). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function answers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    await r.arrayBuffer().catch(() => undefined);
    return r.status < 500;
  } catch {
    return false;
  }
}

export async function startWebServer(cfg: WebServerConfig, o: { cwd: string; log?: (s: string) => void }): Promise<WebServerHandle> {
  if (!cfg.url && !cfg.waitFor) throw new Error('webServer needs "url" or "waitFor" to know when the app is ready');
  if (cfg.reuseExisting && cfg.url && (await answers(cfg.url))) {
    o.log?.(`webServer: ${cfg.url} already answers; reusing it`);
    return { reused: true, output: () => '', stop: async () => {} };
  }
  const argv = Array.isArray(cfg.command) ? cfg.command : splitCommand(cfg.command);
  if (!argv.length) throw new Error('webServer.command is empty');
  const child: ChildProcess = spawn(argv[0], argv.slice(1), {
    cwd: cfg.cwd ? resolve(o.cwd, cfg.cwd) : o.cwd, env: { ...process.env, ...(cfg.env ?? {}) }, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let out = '';
  let matched = false;
  const re = cfg.waitFor ? new RegExp(cfg.waitFor) : undefined;
  const onData = (d: Buffer) => {
    out = (out + d.toString()).slice(-20_000);
    if (re && re.test(out)) matched = true;
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code));
  const stop = async () => {
    if (exited !== undefined) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // gone
        }
        r();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  };
  const deadline = Date.now() + (cfg.timeoutSeconds ?? 60) * 1000;
  for (;;) {
    if (exited !== undefined) throw new Error(`webServer exited with code ${exited} before it was ready:\n${out.slice(-2000)}`);
    if ((re ? matched : true) && (!cfg.url || (await answers(cfg.url)))) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`webServer was not ready after ${cfg.timeoutSeconds ?? 60} s${cfg.url ? ` (${cfg.url})` : ''}:\n${out.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  o.log?.(`webServer: started ${argv[0]} (pid ${child.pid})`);
  return { reused: false, pid: child.pid, output: () => out, stop };
}
