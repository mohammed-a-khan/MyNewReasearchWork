/**
 * Studio debug sessions (debug-... run folders) stay visible in Results with a
 * "debug" badge, but are left out of history, triage, readiness, compare,
 * flaky and trends, in the Studio and on the CLI.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '../../src/browser/index.js';
import { buildProgram } from '../../src/cli/program.js';
import { analyzeRun } from '../../src/engine/index.js';
import { HistoryStore } from '../../src/insights/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, readSse } from './helpers.js';

let site: Server;
let studio: StudioHandle;
let dir: string;
let c: ReturnType<typeof client>;
let runId: string;
let debugId: string;
let browser: Browser | undefined;

beforeAll(async () => {
  site = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Welcome</h1></main></body></html>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  dir = await mkdtemp(join(tmpdir(), 'eztest-debug-analytics-'));
  await mkdir(join(dir, 'journeys'));
  await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: http://127.0.0.1:${(site.address() as AddressInfo).port}\njourneysDir: journeys\noutputDir: results\nreporters: [console, json]\nvideo: off\n`);
  await writeFile(join(dir, 'journeys', 'home.ez'), 'Journey: Home\nId: home\nOpen "/"\n  Expect the page to contain "Welcome"\n');
  studio = await startStudio({ cwd: dir, watch: false });
  c = client(studio.port, studio.token);

  // A normal run (analyzed, recorded in history) ...
  const start = await c.post('/api/runs', {});
  runId = start.json().id;
  await readSse(studio.port, `/api/runs/${runId}/events`, studio.token, (e) => e.type === 'done');
  // ... and a debug session of the same journey.
  const dbg = await c.post('/api/debug/sessions', { journey: 'home', pauseAtStart: false, timeTravel: false });
  debugId = dbg.json().id;
  for (let i = 0; i < 300 && (await c.get('/api/debug/session')).json().state === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  // `eztest analyze` of the debug folder must not put it into the history either.
  await analyzeRun(join(dir, 'results', debugId), { historyPath: join(dir, '.eztest', 'history.json'), formats: ['json'] });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  site.close();
});

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  process.exitCode = 0;
  let error: Error | undefined;
  try {
    await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir, env: { PATH: process.env.PATH } }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  } catch (e) {
    error = e as Error;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code, error };
}

describe('debug sessions and analytics', () => {
  it('Results lists the debug session with a debug flag; the history never has it', async () => {
    expect(debugId).toMatch(/^debug-/);
    expect((await readdir(join(dir, 'results'))).sort()).toEqual(expect.arrayContaining([runId, debugId]));
    const runs = (await c.get('/api/runs')).json().runs as Array<{ runId: string; debug?: boolean }>;
    expect(runs.find((r) => r.runId === debugId)).toMatchObject({ debug: true });
    expect(runs.find((r) => r.runId === runId)?.debug).toBeUndefined();
    const history = await HistoryStore.open(join(dir, '.eztest', 'history.json'));
    expect(history.runs.map((r) => r.runId)).toEqual([runId]);
  });

  it('the Studio quality pages leave it out: triage, readiness, compare, flaky, trends, dashboard', async () => {
    expect((await c.get('/api/quality/triage')).json().runId).toBe(runId);
    expect((await c.get('/api/quality/readiness')).json().runId).toBe(runId);
    expect((await c.get(`/api/quality/triage?run=${debugId}`)).status).toBe(400);
    expect((await c.get(`/api/quality/readiness?run=${debugId}`)).status).toBe(400);
    const cmp = (await c.get('/api/quality/compare')).json();
    expect(cmp.runs.map((r: { runId: string }) => r.runId)).toEqual([runId]);
    expect((await c.get(`/api/quality/compare?a=${runId}&b=${debugId}`)).status).toBe(400);
    for (const path of ['/api/quality/flaky', '/api/quality/trends', '/api/quality/summary', '/api/dashboard', '/api/insights']) {
      const r = await c.get(path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).not.toContain(debugId);
    }
  });

  it('the CLI leaves it out: report compare refuses it, report trends and eztest trends do not count it', async () => {
    const cmp = await cli(['report', 'compare', `results/${runId}`, `results/${debugId}`]);
    expect(String(cmp.error?.message ?? cmp.err)).toMatch(/is a Studio debug session; debug sessions are not compared/);
    const t = await cli(['report', 'trends', '-o', 'trends.html', '--json', 'trends.json']);
    expect(t.out).toMatch(/^1 runs, /);
    expect(await readFile(join(dir, 'trends.json'), 'utf8')).not.toContain(debugId);
    const csv = await cli(['trends', '-o', 'trends.csv']);
    expect(csv.code).toBe(0);
    expect(await readFile(join(dir, 'trends.csv'), 'utf8')).not.toContain(debugId);
  });

  it('the Results page shows the "debug" badge', async () => {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(studio.url);
    await page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name: 'Results', exact: true }).click();
    const grid = page.getByRole('grid', { name: /Past runs/ });
    await expect.poll(() => grid.getByRole('row').count()).toBe(3);
    const debugRow = grid.getByRole('row').filter({ hasText: debugId });
    expect(await debugRow.locator('.tag-debug').textContent()).toBe('debug');
    expect(await grid.getByRole('row').filter({ hasText: runId }).locator('.tag-debug').count()).toBe(0);
  });
});
