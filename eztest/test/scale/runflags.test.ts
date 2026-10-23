/**
 * Runner selection and burn-in flags (G20), watch mode (G21) and managed app
 * start (G22): unit tests, plus real runs against a deliberately flaky page.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEzScript } from '../../src/intent/index.js';
import { affectedJourneys, baseJourneyId, burnInVerdicts, failedFirst, lastFailedIds, lastStatuses, repeatJourneys, seededShuffle } from '../../src/scale/index.js';
import { splitCommand, startWebServer } from '../../src/ops/webserver.js';
import { watchAndRerun } from '../../src/cli/watch.js';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import type { RunHistoryEntry } from '../../src/insights/index.js';
import type { RunResult } from '../../src/core/index.js';
import { tempDir } from '../runner/fixtures.js';

const ez = (s: string) => parseEzScript(s);

describe('ordering and burn-in helpers', () => {
  const js = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ ...ez(`Journey: ${id}\nRisk: ${(i % 5) + 1}\n\nWait 1 ms\n`), id }));
  const hist: RunHistoryEntry[] = [
    { runId: 'r1', startedAt: '2026-10-01', outcomes: [{ journeyId: 'a', status: 'failed', durationMs: 1, attempt: 1 }, { journeyId: 'b', status: 'passed', durationMs: 1, attempt: 1 }] },
    { runId: 'r2', startedAt: '2026-10-02', outcomes: [{ journeyId: 'a', status: 'passed', durationMs: 1, attempt: 1 }, { journeyId: 'c-row1', status: 'error', durationMs: 1, attempt: 1 }, { journeyId: 'c-row2', status: 'passed', durationMs: 1, attempt: 1 }, { journeyId: 'd~rep2', status: 'failed', durationMs: 1, attempt: 1 }] },
  ];

  it('last failed comes from the most recent run; rows and repeats fold into their journey', () => {
    const withRows = js.map((j) => (j.id === 'c' ? { ...j, examples: [{ x: '1' }] } : j));
    expect(lastFailedIds(hist, withRows)).toEqual({ runId: 'r2', ids: ['c', 'd'] });
    expect([...lastStatuses(hist, ['a', 'b', 'c', 'd']).entries()]).toEqual([['a', 'passed'], ['b', 'passed'], ['c', 'error'], ['d', 'failed']]);
  });

  it('failed-first puts last failures first, then by risk, otherwise stable', () => {
    const last = lastStatuses(hist, js.map((j) => j.id));
    expect(failedFirst(js, last).map((j) => j.id)).toEqual(['d', 'c', 'e', 'b', 'a']);
  });

  it('shuffle is reproducible from its seed', () => {
    const a = seededShuffle(js, 'seed-42').map((j) => j.id);
    expect(seededShuffle(js, 'seed-42').map((j) => j.id)).toEqual(a);
    expect(a.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(seededShuffle(Array.from({ length: 30 }, (_, i) => i), 1)).not.toEqual(seededShuffle(Array.from({ length: 30 }, (_, i) => i), 2));
  });

  it('repeat-each copies journeys with groupable ids; burn-in verdicts', () => {
    const rep = repeatJourneys(js.slice(0, 2), 3, new Set(['a']));
    expect(rep.map((j) => j.id)).toEqual(['a', 'a~rep2', 'a~rep3', 'b']);
    expect(baseJourneyId('a~rep2')).toBe('a');
    expect(baseJourneyId('a~rep2-row1')).toBe('a-row1');
    const run = { journeys: [['a', 'passed'], ['a~rep2', 'failed'], ['a~rep3', 'passed'], ['b', 'passed'], ['b~rep2', 'passed'], ['c', 'failed'], ['c~rep2', 'failed']].map(([journeyId, status]) => ({ journeyId, status })) } as unknown as RunResult;
    expect(burnInVerdicts(run).map((v) => [v.journeyId, v.verdict, `${v.passed}/${v.runs}`])).toEqual([['a', 'flaky', '2/3'], ['b', 'stable', '2/2'], ['c', 'broken', '0/2']]);
  });

  it('watch: a changed library journey re-runs its callers, transitively', () => {
    const lib = ez('Journey: Log in\nId: login\nTags: @library\n\nOpen /login\n');
    const mid = ez('Journey: Open orders\nId: open-orders\nTags: @library\n\nRun journey "login"\nOpen /orders\n');
    const top = ez('Journey: Order\nId: order\n\nRun journey "open-orders.ez"\nClick the Save button\n');
    const other = ez('Journey: Other\nId: other\n\nOpen /\n');
    expect(affectedJourneys([lib], [lib, mid, top, other], new Map([['open-orders', '/p/journeys/open-orders.ez']])).sort()).toEqual(['login', 'open-orders', 'order']);
  });

  it('splits commands without a shell', () => {
    expect(splitCommand(`node "my server.js" --port 3000 '$HOME'`)).toEqual(['node', 'my server.js', '--port', '3000', '$HOME']);
  });
});

// A page that alternates OK / NOT OK, and one that always fails.
let flaky: Server;
let url = '';
let hits = 0;
beforeAll(async () => {
  flaky = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url?.startsWith('/flaky')) res.end(++hits % 2 ? '<p>OK</p>' : '<p>NOT READY</p>');
    else if (req.url?.startsWith('/broken')) res.end('<p>broken</p>');
    else res.end('<p>OK</p>');
  });
  await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => flaky.close(() => r())));

async function cli(cwd: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { ...process.env } };
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'eztest', ...args], { from: 'node' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

async function project(files: Record<string, string>): Promise<string> {
  const dir = await tempDir('runflags');
  await mkdir(join(dir, 'journeys'), { recursive: true });
  for (const [f, t] of Object.entries(files)) await writeFile(join(dir, 'journeys', f), t);
  await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: ${url}\nscreenshots: off\nheadless: true\ntimeouts: { step: 2000 }\n`);
  return dir;
}

const page = (id: string, path: string, risk = 3) => `Journey: ${id}\nId: ${id}\nRisk: ${risk}\n\nOpen ${path}\n  Expect the page contains "OK"\n`;

describe('CLI flags (real Chromium)', () => {
  it('--repeat-each marks an alternating journey flaky; --fail-on-flaky fails the run', async () => {
    const dir = await project({ 'f.ez': page('flaky-page', '/flaky'), 's.ez': page('steady', '/ok') });
    const r = await cli(dir, ['run', '--repeat-each', '4', '--fail-on-flaky', '--reporter', 'json']);
    expect(r.out).toMatch(/burn-in: flaky-page, steady run 4 times each/);
    expect(r.out).toMatch(/burn-in: flaky-page: 2\/4 passed -> flaky/);
    expect(r.out).toMatch(/burn-in: steady: 4\/4 passed -> stable/);
    expect(r.err).toMatch(/--fail-on-flaky: 1 flaky journey\(s\): flaky-page/);
    expect(r.code).toBe(1);
  }, 120_000);

  it('--max-failures 1 stops after the first failure; the rest are skipped. --last-failed then runs only that failure', async () => {
    const dir = await project({ '1.ez': page('b1', '/broken'), '2.ez': page('b2', '/broken'), '3.ez': page('b3', '/broken') });
    const r = await cli(dir, ['run', '--max-failures', '1', '--reporter', 'json']);
    expect(r.out).toMatch(/max failures reached \(1\)/);
    expect(r.out).toMatch(/3 journeys: 0 passed, 0 passed-healed, 1 failed, 2 skipped, 0 errors/);
    const last = await cli(dir, ['run', '--last-failed', '--plan']);
    expect(last.out).toMatch(/selection: Selected 1 of 3 journeys .*failed in run-/);
    expect(last.out).toMatch(/would run 1 journeys: b1$/m);
  }, 120_000);

  it('--retry-strategy isolated retries after the main pass and reports a pass-on-retry as flaky', async () => {
    hits = 1; // the next /flaky hit fails
    const dir = await project({ 'f.ez': page('flaky-page', '/flaky'), 's.ez': page('steady', '/ok') });
    const r = await cli(dir, ['run', '--retries', '1', '--retry-strategy', 'isolated', '--reporter', 'json']);
    expect(r.out).toMatch(/flaky: flaky-page passed only on retry/);
    expect(r.code).toBe(0);
    const runs = (await readdir(join(dir, 'eztest-results'))).filter((d) => d.startsWith('run-'));
    const run = JSON.parse(await readFile(join(dir, 'eztest-results', runs[0], 'run.json'), 'utf8')) as RunResult;
    expect(run.journeys.find((j) => j.journeyId === 'flaky-page')).toMatchObject({ status: 'passed', attempt: 2 });
  }, 120_000);

  it('--failed-first and --shuffle explain the order; --burn-in repeats only new journeys', async () => {
    const dir = await project({ 'a.ez': page('a', '/ok', 1), 'b.ez': page('b', '/ok', 5) });
    await mkdir(join(dir, '.eztest'), { recursive: true });
    await writeFile(join(dir, '.eztest', 'history.json'), JSON.stringify({ version: 1, runs: [{ runId: 'h1', startedAt: '2026-10-01T00:00:00Z', outcomes: [{ journeyId: 'a', status: 'failed', durationMs: 10, attempt: 1 }] }] }));
    const r = await cli(dir, ['run', '--plan', '--failed-first', '--shuffle', 'abc', '--burn-in', '3']);
    expect(r.out).toMatch(/order: shuffled with seed abc \(reproduce with --shuffle abc\)/);
    expect(r.out).toMatch(/order: failed first \(a\), then by risk/);
    expect(r.out).toMatch(/burn-in: b run 3 times each \(new or changed journeys/);
    expect(r.out).toMatch(/would run 4 journeys: a, b, b~rep2, b~rep3$/m);
  }, 60_000);
});

describe('managed app start (webServer)', () => {
  it('starts the app, waits until it answers, stops it; reuseExisting skips spawning', async () => {
    const dir = await tempDir('websrv');
    const script = join(dir, 'app.mjs');
    await writeFile(script, `import { createServer } from 'node:http';\nconst s = createServer((q, r) => r.end('<p>OK app</p>'));\ns.listen(Number(process.argv[2]), '127.0.0.1', () => console.log('listening'));\n`);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const appUrl = `http://127.0.0.1:${port}/`;
    const h = await startWebServer({ command: [process.execPath, script, String(port)], url: appUrl, waitFor: 'listening', timeoutSeconds: 20 }, { cwd: dir });
    expect(h.reused).toBe(false);
    expect(await (await fetch(appUrl)).text()).toBe('<p>OK app</p>');
    const again = await startWebServer({ command: 'false', url: appUrl, reuseExisting: true }, { cwd: dir });
    expect(again.reused).toBe(true);
    await h.stop();
    await expect(fetch(appUrl)).rejects.toThrow();
    await expect(startWebServer({ command: [process.execPath, '-e', 'process.exit(3)'], url: appUrl, timeoutSeconds: 5 }, { cwd: dir })).rejects.toThrow(/exited with code 3/);
  }, 60_000);

  it('eztest run starts the configured webServer from a clean shell', async () => {
    const dir = await tempDir('websrv-run');
    const script = join(dir, 'app.mjs');
    await writeFile(script, `import { createServer } from 'node:http';\ncreateServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<p>OK app</p>'); }).listen(Number(process.argv[2]), '127.0.0.1');\n`);
    const port = 20000 + Math.floor(Math.random() * 20000);
    await mkdir(join(dir, 'journeys'));
    await writeFile(join(dir, 'journeys', 'a.ez'), page('a', '/'));
    await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: http://127.0.0.1:${port}\nscreenshots: off\nwebServer:\n  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}, "${port}"]\n  url: http://127.0.0.1:${port}/\n`);
    const r = await cli(dir, ['run', '--reporter', 'json']);
    expect(r.out).toMatch(/webServer: started/);
    expect(r.out).toMatch(/1 journeys: 1 passed/);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(); // stopped after the run
  }, 60_000);
});

describe('watch mode', () => {
  it('re-runs the edited journey and its callers once per save', async () => {
    const dir = await tempDir('watch');
    await mkdir(join(dir, 'journeys'));
    await writeFile(join(dir, 'journeys', 'login.ez'), 'Journey: Log in\nId: login\nTags: @library\n\nOpen /login\n');
    await writeFile(join(dir, 'journeys', 'order.ez'), 'Journey: Order\nId: order\n\nRun journey "login"\nOpen /orders\n');
    await writeFile(join(dir, 'journeys', 'other.ez'), 'Journey: Other\nId: other\n\nOpen /\n');
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://x.test\n');
    const all = ['login', 'order', 'other'].map((f) => f);
    const { loadJourneys } = await import('../../src/cli/journeys.js');
    const { journeys } = await loadJourneys(['journeys'], dir);
    const calls: string[][] = [];
    const ac = new AbortController();
    const io: CliIO = { out: () => undefined, err: () => undefined, cwd: dir, env: {} };
    const watching = watchAndRerun(io, [], {}, () => ({ all: journeys, files: new Map() }), async (ids) => {
      calls.push(ids.sort());
    }, { signal: ac.signal, debounceMs: 100 });
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    await writeFile(join(dir, 'journeys', 'login.ez'), 'Journey: Log in\nId: login\nTags: @library\n\nOpen /signin\n');
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(calls[0]).toEqual(['login', 'order']);
    ac.abort();
    await watching;
    expect(all).toHaveLength(3);
  });
});
