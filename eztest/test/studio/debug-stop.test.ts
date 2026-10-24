/**
 * Stop in the Studio debugger aborts the journey: the paused step and every
 * later one (here a destructive "delete everything" request) are not
 * executed, the session ends as "stopped", and the afterEach cleanup and
 * afterAll teardown hooks still run. Real browser, local site that records
 * every request.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioContext } from '../../src/studio/runs.js';
import { DebugSessionManager, debugRoutes, matchRoute } from '../../src/studio/index.js';

let server: Server;
let dir: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/favicon.ico') hits.push(path);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><head><title>${path}</title></head><body><main><h1>Page ${path}</h1></main></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), 'eztest-dbg-stop-'));
  await mkdir(join(dir, 'journeys'));
  await mkdir(join(dir, 'hooks'));
  await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: ${url}
journeysDir: journeys
outputDir: results
healing:
  enabled: false
reporters: [console]
hooks:
  afterEach: [hooks/cleanup.ez]
  afterAll: [hooks/teardown.ez]
`);
  await writeFile(join(dir, 'hooks', 'cleanup.ez'), 'Journey: Cleanup\nId: cleanup\nOpen "/cleanup"\n');
  await writeFile(join(dir, 'hooks', 'teardown.ez'), 'Journey: Teardown\nId: teardown\nOpen "/teardown"\n');
  await writeFile(join(dir, 'journeys', 'wipe.ez'), `Journey: Wipe the shop
Id: wipe
Open "/start"
Open "/review"
Open "/destroy-everything"
Open "/after-destroy"
`);
});

afterAll(() => server.close());

describe('Studio debugger Stop', () => {
  it('does not run the paused or later steps, ends "stopped", and still runs cleanup and teardown hooks', async () => {
    const ctx: StudioContext = { cwd: dir, env: {}, addons: { off() {} } };
    const manager = new DebugSessionManager(ctx, { runOptions: { locateTimeoutMs: 1500, conditionTimeoutMs: 3000, stepTimeoutMs: 10_000 } });
    const routes = debugRoutes(manager);
    const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
      const hit = matchRoute(routes, method, path)!;
      return (await hit.route.handler({ method, path, params: hit.params, query: new URLSearchParams(), body })) as { status?: number; json: any };
    };
    try {
      const started = await call('POST', '/api/debug/sessions', { journey: 'wipe', pauseAtStart: false, breakpoints: [{ stepIndex: 1 }], timeTravel: false });
      expect(started.status).toBe(202);
      const ctl = manager.require().controller;
      const paused = await ctl.waitForPause(60_000);
      expect(paused).toMatchObject({ status: 'paused', stepIndex: 1, phase: 'before-step' });
      expect(hits).toContain('/start');
      expect(hits).not.toContain('/review');

      const stop = await call('POST', '/api/debug/stop');
      expect(stop.json).toMatchObject({ ok: true, state: 'stopped' });

      // Nothing after the pause was executed, the cleanup and teardown hooks were.
      expect(hits).not.toContain('/review');
      expect(hits).not.toContain('/destroy-everything');
      expect(hits).not.toContain('/after-destroy');
      expect(hits).toContain('/cleanup');
      expect(hits).toContain('/teardown');
      expect(hits.indexOf('/cleanup')).toBeLessThan(hits.indexOf('/teardown'));

      const s = (await call('GET', '/api/debug/session')).json;
      expect(s.state).toBe('stopped');
      const steps = s.result.steps as Array<{ stepId: string; status: string }>;
      expect(steps.filter((x) => !x.stepId.startsWith('after-each')).map((x) => x.status)).toEqual(['passed', 'skipped', 'skipped', 'skipped']);
      expect(steps.some((x) => x.stepId.startsWith('after-each') && x.status === 'passed')).toBe(true);
      expect(manager.require().events.at(-1)).toMatchObject({ type: 'done', data: { state: 'stopped' } });
    } finally {
      await manager.close();
    }
  }, 120_000);
});
