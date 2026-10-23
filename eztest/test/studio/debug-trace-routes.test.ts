/**
 * Debug and trace Studio routes, called framework-agnostically (matchRoute +
 * handler) and through the node:http adapter, against a real debug run.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, request, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, type StudioContext } from '../../src/studio/runs.js';
import { DebugSessionManager, debugRoutes, matchRoute, serveRoute, traceRoutes, type RouteDef, type SseMessage } from '../../src/studio/index.js';
import { readZip } from '../../src/runner/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';

let app: DemoServer;
let dir: string;
let manager: DebugSessionManager;
let routes: RouteDef[];

beforeAll(async () => {
  app = await startDemoApp({ variant: 'a' });
  dir = await mkdtemp(join(tmpdir(), 'eztest-dbg-routes-'));
  await mkdir(join(dir, 'journeys'));
  await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: ${app.url}\njourneysDir: journeys\noutputDir: results\nhealing:\n  enabled: false\nreporters: [console]\n`);
  await writeFile(join(dir, 'journeys', 'login.ez'), `Journey: Login
Id: login
Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
  Expect the URL contains "/dashboard"
`);
  const ctx: StudioContext = { cwd: dir, env: {}, addons: { off() {} } };
  manager = new DebugSessionManager(ctx, { runOptions: { locateTimeoutMs: 1500, conditionTimeoutMs: 3000, stepTimeoutMs: 5000 } });
  routes = [...debugRoutes(manager), ...traceRoutes({ outputDir: async () => join(dir, 'results'), cwd: dir })];
});

afterAll(async () => {
  await manager.close();
  await app.close();
});

async function call(method: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; json?: any; body?: Buffer | string; headers?: Record<string, string>; sse?: (sink: any) => () => void }> {
  const url = new URL(path, 'http://x');
  const hit = matchRoute(routes, method, url.pathname);
  if (!hit) return { status: 404 };
  try {
    const out = await hit.route.handler({ method, path: url.pathname, params: hit.params, query: url.searchParams, body });
    if ('sse' in out) return { status: 200, sse: out.sse };
    if ('json' in out) return { status: out.status ?? 200, json: out.json };
    return { status: out.status ?? 200, body: out.body, headers: out.headers };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
}

describe('Studio debug + trace routes', () => {
  it('drives a debug session over JSON commands and SSE, then serves its trace', async () => {
    expect((await call('GET', '/api/debug/session')).json).toEqual({ state: 'idle' });
    expect((await call('POST', '/api/debug/command', { command: 'resume' })).status).toBe(404);
    expect((await call('POST', '/api/debug/sessions', { journey: 'nope' })).status).toBe(404);

    const started = await call('POST', '/api/debug/sessions', { journey: 'login', breakpoints: [{ stepId: 'click-the-sign-in-button' }] });
    expect(started.status).toBe(202);
    const id = started.json.id as string;
    expect((await call('POST', '/api/debug/sessions', { journey: 'login' })).status).toBe(409);
    const ctl = manager.require().controller;
    await ctl.waitForPause();
    const s0 = (await call('GET', '/api/debug/session')).json;
    expect(s0.debug).toMatchObject({ status: 'paused', stepIndex: 0, reason: 'pause' });
    expect((await call('POST', '/api/debug/command', { command: 'explode' })).status).toBe(400);
    expect((await call('POST', '/api/debug/command', { command: 'resume' })).status).toBe(200);
    await ctl.waitForPause();
    expect((await call('GET', '/api/debug/session')).json.debug).toMatchObject({ stepIndex: 3, reason: 'breakpoint bp-1' });

    // Breakpoints CRUD, with a condition written in .ez words.
    const bp = await call('POST', '/api/debug/breakpoints', { stepIndex: 2, condition: 'the page contains "Sign in"' });
    expect(bp.status).toBe(201);
    expect(bp.json.condition).toEqual({ type: 'pageContainsText', value: 'Sign in' });
    expect((await call('GET', '/api/debug/breakpoints')).json.breakpoints).toHaveLength(2);
    expect((await call('DELETE', `/api/debug/breakpoints/${bp.json.id}`)).status).toBe(200);
    expect((await call('DELETE', '/api/debug/breakpoints/bp-99')).status).toBe(404);

    // Picker, validation, ad-hoc evaluation, input.
    const page = ctl.page!;
    const box = (await page.locator('#username').boundingBox())!;
    const pick = await call('POST', '/api/debug/pick', { x: box.x + 5, y: box.y + 5 });
    expect(pick.json.candidates[0]).toMatchObject({ candidate: { strategy: 'testId', value: 'username' }, count: 1 });
    expect((await call('POST', '/api/debug/pick', { x: 'a', y: 1 })).status).toBe(400);
    expect((await call('POST', '/api/debug/validate', { target: 'the "Sign in" button' })).json).toMatchObject({ count: 1, highlighted: 1 });
    const ev = await call('POST', '/api/debug/evaluate', { step: 'Verify the page contains "Sign in to EZ Shop"' });
    expect(ev.json.result.status).toBe('passed');
    expect((await call('POST', '/api/debug/evaluate', { step: 'Gibberish line' })).status).toBe(400);
    expect((await call('POST', '/api/debug/input', { type: 'mouse', action: 'teleport', x: 1, y: 1 })).status).toBe(400);

    // Live frames over SSE (base64 JPEG), while input is forwarded.
    const frames: SseMessage[] = [];
    const fr = await call('GET', '/api/debug/frames?fps=10');
    const off = fr.sse!({ send: (m: SseMessage) => (frames.push(m), true), close() {} });
    for (let i = 0; i < 40 && frames.length < 1; i++) {
      await call('POST', '/api/debug/input', { type: 'mouse', action: 'move', x: 10 + i, y: 10 + i });
      await call('POST', '/api/debug/input', { type: 'wheel', x: 100, y: 100, deltaY: i % 2 ? 40 : -40 });
      await new Promise((r) => setTimeout(r, 50));
    }
    off();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ event: 'frame', data: { metadata: expect.any(Object) } });
    expect(Buffer.from((frames[0].data as { jpeg: string }).jpeg, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');

    // Edit the current step and retry through the edit route.
    const edit = await call('POST', '/api/debug/edit', { step: 'Click the "Sign in" button\n  Expect the URL contains "/dashboard"', retry: true });
    expect(edit.json.step).toMatchObject({ id: 'click-the-sign-in-button', action: 'click' });
    await manager.settle();
    const done = (await call('GET', '/api/debug/session')).json;
    expect(done).toMatchObject({ id, state: 'done', result: { status: 'passed' } });

    // Event replay over SSE ends with "done" and contains the debugger's events; no secrets.
    const msgs: SseMessage[] = [];
    let closed = false;
    (await call('GET', '/api/debug/events')).sse!({ send: (m: SseMessage) => (msgs.push(m), true), close: () => (closed = true) });
    const types = msgs.map((m) => (m.data as { type: string }).type);
    expect(types).toEqual(expect.arrayContaining(['queued', 'debug.paused', 'debug.resumed', 'debug.stepStarted', 'debug.stepEdited', 'done']));
    expect(closed).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain('Builder#2');

    // Trace routes for the debug run.
    const list = await call('GET', `/api/runs/${id}/traces`);
    expect(list.json.traces).toMatchObject([{ journeyId: 'login', attempt: 1, status: 'passed' }]);
    const trace = (await call('GET', `/api/runs/${id}/traces/login/1`)).json;
    expect(trace.steps.at(-1).edited).toBe(true);
    const snap = await call('GET', `/api/runs/${id}/traces/login/1/steps/1/after`);
    expect(snap.headers?.['Content-Security-Policy']).toMatch(/^sandbox/);
    expect(String(snap.body)).toMatch(/id="username"[^>]*value="bob"/);
    expect((await call('GET', `/api/runs/${id}/traces/login/1/steps/99/after`)).status).toBe(400);
    expect((await call('GET', `/api/runs/${id}/traces/..%2Fx/1`)).status).toBe(400);
    expect((await call('GET', `/api/runs/../traces/login/1`)).status).toBe(404);
    const jpeg = trace.steps[0].screenshot.viewportJpeg as string;
    const asset = await call('GET', `/api/runs/${id}/traces/login/1/asset?path=${encodeURIComponent(jpeg)}`);
    expect((asset.body as Buffer).subarray(0, 2).toString('hex')).toBe('ffd8');
    expect((await call('GET', `/api/runs/${id}/traces/login/1/asset?path=${encodeURIComponent('run.json')}`)).status).toBe(404);
    const bundle = await call('GET', `/api/runs/${id}/traces/login/1/bundle`);
    expect([...readZip(bundle.body as Buffer).keys()]).toContain('bundle.json');
    const diff = await call('GET', `/api/traces/diff?a=${id}/login/1&b=${id}/login/1`);
    expect(diff.json.summary.changedSteps).toBe(0);
    expect((await call('GET', '/api/traces/diff?a=x')).status).toBe(400);
  });

  it('has no trace import route, and serves routes through node:http', async () => {
    expect((await call('POST', '/api/traces/import', { path: 'pw-trace.zip' })).status).toBe(404);

    // The node:http adapter: JSON and SSE.
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void serveRoute(routes, req, res, url, {}).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const get = (path: string) =>
      new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
        }).on('error', reject).end();
      });
    try {
      const s = await get('/api/debug/session');
      expect(s.status).toBe(200);
      expect(JSON.parse(s.body).state).toBe('done');
      const sse = await get('/api/debug/events');
      expect(sse.type).toMatch(/text\/event-stream/);
      expect(sse.body).toMatch(/^retry: 2000/);
      expect(sse.body).toContain('"type":"done"');
      expect((await get('/api/nothing')).status).toBe(404);
      expect((await get('/api/runs/bad..id/traces')).status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
