/**
 * Cancelled runs leave nothing behind: `eztest run` sent SIGTERM mid-run
 * closes its browsers, removes the temporary profiles and download folders,
 * writes run.json marked cancelled and exits 143; a library user's process
 * that gets SIGTERM has its browsers killed and profiles removed too; the
 * startup sweep removes stale directories of dead processes only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import type { RunResult } from '../../src/core/index.js';
import { ownerPidOf, sweepStaleTempDirs } from '../../src/browser/launcher/temp-dirs.js';
import { cancelExitCode } from '../../src/runner/cancel.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
const LEFTOVER = /^eztest-(?:profile|downloads|firefox-profile)-/;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/quick') res.end('<title>Quick</title><h1>Quick page</h1><button>Go</button>');
    // The "Later" button never appears: the journey waits on it until it is cancelled.
    else res.end('<title>Slow</title><h1>Slow page</h1>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Child {
  proc: ChildProcess;
  out: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor(re: RegExp, ms?: number): Promise<void>;
}

function start(args: string[], cwd: string, env: Record<string, string>): Child {
  const proc = spawn(process.execPath, ['--import', TSX, ...args], { cwd, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: string[] = [];
  const waiters: Array<{ re: RegExp; done: () => void }> = [];
  const onData = (d: Buffer) => {
    out.push(d.toString());
    const all = out.join('');
    for (const w of [...waiters]) if (w.re.test(all)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.done();
    }
  };
  proc.stdout!.on('data', onData);
  proc.stderr!.on('data', onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  return {
    proc,
    out,
    exited,
    waitFor: (re, ms = 45_000) =>
      new Promise<void>((resolve, reject) => {
        if (re.test(out.join(''))) return resolve();
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${re} in:\n${out.join('')}`)), ms);
        waiters.push({ re, done: () => (clearTimeout(t), resolve()) });
        void exited.then(() => setTimeout(() => reject(new Error(`process exited before ${re}:\n${out.join('')}`)), 50));
      }),
  };
}

async function project(): Promise<{ dir: string; tmp: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-cancel-'));
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  mkdirSync(join(dir, 'journeys'));
  writeFileSync(join(dir, 'eztest.config.yaml'), `baseUrl: ${base}\njourneysDir: journeys\noutputDir: eztest-results\nreporters: [json]\ntimeouts:\n  step: 60000\n`);
  writeFileSync(join(dir, 'journeys', 'a-quick.ez'), 'Journey: Quick one\nOpen /quick\n  Expect the page contains "Quick page"\n');
  writeFileSync(join(dir, 'journeys', 'b-slow.ez'), 'Journey: Slow one\nOpen /slow\nClick the "Later" button\n');
  writeFileSync(join(dir, 'journeys', 'c-never.ez'), 'Journey: Never started\nOpen /quick\n');
  return { dir, tmp };
}

function runJson(dir: string): RunResult {
  const root = join(dir, 'eztest-results');
  const runs = readdirSync(root).filter((d) => d.startsWith('run-')).sort();
  expect(runs.length).toBe(1);
  return JSON.parse(readFileSync(join(root, runs[0], 'run.json'), 'utf8')) as RunResult;
}

describe('cancelling a run', () => {
  it('SIGTERM mid-run: browsers closed, no temp dirs left, partial run.json marked cancelled, exit 143', async () => {
    const { dir, tmp } = await project();
    try {
      const c = start([join(ROOT, 'src/cli/bin.ts'), 'run', '--no-analyze'], dir, { TMPDIR: tmp });
      await c.waitFor(/> Slow one/);
      await new Promise((r) => setTimeout(r, 1500)); // the slow journey is waiting on the button
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n)).length).toBeGreaterThan(0); // the run's profile is there
      c.proc.kill('SIGTERM');
      const { code } = await c.exited;
      const text = c.out.join('');
      expect(code).toBe(143);
      expect(text).toMatch(/SIGTERM: cancelling the run/);
      expect(text).toMatch(/run cancelled by SIGTERM/);
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n))).toEqual([]);
      const run = runJson(dir);
      expect(run.cancelled).toMatchObject({ reason: 'SIGTERM' });
      const by = Object.fromEntries(run.journeys.map((j) => [j.journeyId, j]));
      expect(by['quick-one'].status).toBe('passed');
      expect(by['slow-one']).toMatchObject({ status: 'skipped', error: { name: 'CancelledError' } });
      expect(by['slow-one'].error!.message).toMatch(/Run cancelled \(SIGTERM\) while the journey was running/);
      expect(by['never-started']).toMatchObject({ status: 'skipped', error: { name: 'CancelledError' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a run that cannot wind down in the grace period is stopped with its partial results written', async () => {
    const { dir, tmp } = await project();
    try {
      const c = start([join(ROOT, 'src/cli/bin.ts'), 'run', '--no-analyze'], dir, { TMPDIR: tmp, EZTEST_CANCEL_GRACE_MS: '1' });
      await c.waitFor(/> Slow one/);
      await new Promise((r) => setTimeout(r, 1000));
      c.proc.kill('SIGINT');
      const { code } = await c.exited;
      expect(code).toBe(cancelExitCode('SIGINT'));
      expect(code).toBe(130);
      expect(c.out.join('')).toMatch(/SIGINT: stopping now; writing the partial results/);
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n))).toEqual([]);
      const run = runJson(dir);
      expect(run.cancelled).toMatchObject({ reason: 'SIGINT', partial: true });
      expect(run.journeys.find((j) => j.journeyId === 'quick-one')?.status).toBe('passed');
      expect(run.journeys.find((j) => j.journeyId === 'never-started')).toMatchObject({ status: 'skipped', error: { name: 'CancelledError' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a library user process killed with SIGTERM loses its browser and temporary profile, and dies of the signal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-cancel-lib-'));
    const tmp = join(dir, 'tmp');
    mkdirSync(tmp);
    try {
      const script = join(dir, 'script.mts');
      writeFileSync(script, `import { chromium } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/browser/index.ts')).href)};
const b = await chromium.launch();
const ctx = await b.newContext({ acceptDownloads: true });
await (await ctx.newPage()).setContent('<p>hi</p>');
console.log('READY ' + (b as any).process?.()?.pid);
setInterval(() => undefined, 1000);
`);
      const c = start([script], dir, { TMPDIR: tmp });
      await c.waitFor(/READY/);
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n)).length).toBeGreaterThan(0);
      c.proc.kill('SIGTERM');
      const { code, signal } = await c.exited;
      expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' });
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Two journeys that wait on a button that never appears (they run until cancelled) and one that cannot start before them. */
async function workersProject(): Promise<{ dir: string; tmp: string }> {
  const p = await project();
  writeFileSync(join(p.dir, 'journeys', 'a-quick.ez'), 'Journey: Slow two\nOpen /slow\nClick the "Later" button\n');
  return p;
}

describe('cancelling a run with process workers (--workers 2)', () => {
  it('SIGTERM mid-run: the workers stop, their browsers and temp dirs are gone, run.json is marked cancelled, exit 143', async () => {
    const { dir, tmp } = await workersProject();
    try {
      const c = start([join(ROOT, 'src/cli/bin.ts'), 'run', '--no-analyze', '--workers', '2'], dir, { TMPDIR: tmp });
      await c.waitFor(/> Slow one[\s\S]*> Slow two|> Slow two[\s\S]*> Slow one/, 120_000); // two workers start (engine + browser each) first
      await new Promise((r) => setTimeout(r, 1500)); // both journeys wait on the button, each in its own worker
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n)).length).toBeGreaterThan(1); // one browser profile per worker
      c.proc.kill('SIGTERM');
      const { code } = await c.exited;
      const text = c.out.join('');
      expect(code).toBe(143);
      expect(text).toMatch(/run cancelled by SIGTERM/);
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n))).toEqual([]);
      const run = runJson(dir);
      expect(run.cancelled).toMatchObject({ reason: 'SIGTERM' });
      expect(run.environment.workers).toBe('2 processes');
      const by = Object.fromEntries(run.journeys.map((j) => [j.journeyId, j]));
      for (const id of ['slow-one', 'slow-two']) {
        expect(by[id]).toMatchObject({ status: 'skipped', error: { name: 'CancelledError' } });
        expect(by[id].error!.message).toMatch(/Run cancelled \(SIGTERM\) while the journey was running/);
      }
      expect(by['never-started']).toMatchObject({ status: 'skipped', error: { name: 'CancelledError' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('a forced stop (grace period over) kills the workers and their browsers and writes the partial run', async () => {
    const { dir, tmp } = await workersProject();
    try {
      const c = start([join(ROOT, 'src/cli/bin.ts'), 'run', '--no-analyze', '--workers', '2'], dir, { TMPDIR: tmp, EZTEST_CANCEL_GRACE_MS: '1' });
      await c.waitFor(/> Slow one[\s\S]*> Slow two|> Slow two[\s\S]*> Slow one/, 120_000); // two workers start (engine + browser each) first
      await new Promise((r) => setTimeout(r, 1500));
      c.proc.kill('SIGINT');
      const { code } = await c.exited;
      expect(code).toBe(130);
      expect(c.out.join('')).toMatch(/SIGINT: stopping now; writing the partial results/);
      expect(readdirSync(tmp).filter((n) => LEFTOVER.test(n))).toEqual([]);
      const run = runJson(dir);
      expect(run.cancelled).toMatchObject({ reason: 'SIGINT', partial: true });
      expect(run.journeys.find((j) => j.journeyId === 'never-started')).toMatchObject({ status: 'skipped', error: { name: 'CancelledError' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('startup sweep of stale temp dirs', () => {
  it('removes old directories of dead processes only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eztest-sweep-'));
    try {
      const old = (Date.now() - 10 * 3_600_000) / 1000;
      const mk = (name: string, aged: boolean) => {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, 'file'), 'x');
        if (aged) utimesSync(join(root, name), old, old);
      };
      mk('eztest-profile-424242-aaaaaa', true); // dead owner, old: removed
      mk('eztest-downloads-424242-bbbbbb', true); // dead owner, old: removed
      mk('eztest-firefox-profile-111-cccccc', true); // live owner: kept
      mk('eztest-profile-424242-dddddd', false); // dead owner but recent: kept
      mk('eztest-profile-eeeeee', true); // older EZTest name without a pid, old: removed
      mk('other-tool-424242-ffffff', true); // not ours: kept
      expect(ownerPidOf('eztest-firefox-profile-111-cccccc')).toBe(111);
      expect(ownerPidOf('eztest-profile-eeeeee')).toBeUndefined();
      const removed = sweepStaleTempDirs({ root, maxAgeMs: 3_600_000, isAlive: (pid) => pid === 111 }).map((p) => p.slice(root.length + 1)).sort();
      expect(removed).toEqual(['eztest-downloads-424242-bbbbbb', 'eztest-profile-424242-aaaaaa', 'eztest-profile-eeeeee']);
      expect(readdirSync(root).sort()).toEqual(['eztest-firefox-profile-111-cccccc', 'eztest-profile-424242-dddddd', 'other-tool-424242-ffffff']);
      expect(existsSync(join(root, 'eztest-profile-424242-dddddd', 'file'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
