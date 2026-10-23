/** The route registry: matching, params, precedence, 405s, the access policy, RouteDef mounting and extension routes. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { HttpError, Router, startStudio, type RouteDef, type StudioHandle, type StudioRoute } from '../../src/studio/index.js';
import { sendJson } from '../../src/studio/http.js';
import { client, copyShopProject, raw } from './helpers.js';

describe('Router', () => {
  it('matches string and RegExp paths, decodes params and lets later routes win', () => {
    const r = new Router<null>();
    const a = { method: 'GET', path: '/x', handler: () => 'a' } as const;
    const b = { method: 'GET', path: /^\/items\/([^/]+)\/(.+)$/, handler: () => 'b' } as const;
    const c = { method: 'GET', path: '/x', handler: () => 'c' } as const;
    r.add(a, b).add(c);
    expect(r.match('GET', '/x').hit?.route).toBe(c);
    expect(r.match('GET', '/items/a%20b/c/d').hit?.params).toEqual(['a b', 'c/d']);
    expect(r.match('HEAD', '/x').hit?.route).toBe(c);
    // The RegExp must match the whole path.
    expect(r.match('GET', '/items/a').hit).toBeUndefined();
    expect(r.match('POST', '/x')).toEqual({ allowed: ['GET'] });
    expect(r.match('GET', '/nope')).toEqual({ allowed: [] });
    expect(() => r.match('GET', '/items/%E0%A4%A/x')).toThrow(HttpError);
    expect(r.list().map((x) => x.path)).toEqual(['/x', String(b.path), '/x']);
  });
});

describe('Studio route registry (server)', () => {
  let studio: StudioHandle;
  let c: ReturnType<typeof client>;
  const extra: StudioRoute[] = [
    { method: 'GET', path: '/api/ext/hello', handler: ({ res }) => sendJson(res, 200, { hello: 'world' }) },
    { method: 'POST', path: /^\/api\/ext\/echo\/([\w-]+)$/, handler: ({ res, params, body }) => sendJson(res, 200, { id: params[0], body }) },
    { method: 'GET', path: '/ext/public', auth: 'public', handler: ({ res }) => sendJson(res, 200, { open: true }) },
    // Overrides a core route.
    { method: 'GET', path: '/api/topics', handler: ({ res }) => sendJson(res, 200, { overridden: true }) },
  ];
  const defs: RouteDef[] = [
    { method: 'GET', path: /^\/api\/def\/(\d+)$/, handler: ({ params, query }) => ({ json: { n: Number(params[0]), q: query.get('q') } }) },
    { method: 'POST', path: '/api/def/body', handler: ({ body }) => ({ status: 201, json: body }) },
    { method: 'GET', path: '/api/def/text', handler: () => ({ body: 'hi', contentType: 'text/plain; charset=utf-8', headers: { 'X-Def': '1' } }) },
    { method: 'GET', path: '/api/def/fail', handler: () => { throw new HttpError(409, 'busy'); } },
    {
      method: 'GET',
      path: '/api/def/sse',
      handler: () => ({
        sse: (sink) => {
          sink.send({ id: 1, event: 'tick', data: { n: 1 } });
          sink.close();
          return () => undefined;
        },
      }),
    },
  ];

  beforeAll(async () => {
    studio = await startStudio({ cwd: await copyShopProject(), routes: extra, routeDefs: defs, watch: false });
    c = client(studio.port, studio.token);
  });
  afterAll(async () => studio?.close());

  it('serves extension routes with the session policy', async () => {
    expect((await raw(studio.port, '/api/ext/hello')).status).toBe(401);
    expect((await c.get('/api/ext/hello')).json()).toEqual({ hello: 'world' });
    expect((await raw(studio.port, '/api/ext/hello', { headers: { cookie: `eztest_studio=${studio.token}` } })).status).toBe(200);
    const echo = await c.post('/api/ext/echo/abc', { x: 1 });
    expect(echo.json()).toEqual({ id: 'abc', body: { x: 1 } });
    // Writes: JSON content type first (415), then the token header (cookie alone is refused).
    expect((await raw(studio.port, '/api/ext/echo/abc', { method: 'POST', headers: { 'x-eztest-token': studio.token, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await raw(studio.port, '/api/ext/echo/abc', { method: 'POST', headers: { cookie: `eztest_studio=${studio.token}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await raw(studio.port, '/api/ext/echo/abc', { method: 'POST', headers: { 'x-eztest-token': studio.token, 'content-type': 'application/json' }, body: '[1]' })).status).toBe(400);
    expect((await raw(studio.port, '/ext/public')).json()).toEqual({ open: true });
    expect((await c.get('/api/topics')).json()).toEqual({ overridden: true });
  });

  it('answers wrong methods with 405 + Allow, unknown API paths with 404 after auth, and keeps Host checks', async () => {
    const r = await c.put('/api/ext/hello', {});
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('GET');
    expect((await raw(studio.port, '/api/nothing-here')).status).toBe(401);
    expect((await c.get('/api/nothing-here')).status).toBe(404);
    expect((await raw(studio.port, '/api/ext/hello', { headers: { 'x-eztest-token': studio.token, host: 'evil.test' } })).status).toBe(403);
  });

  it('mounts framework-agnostic RouteDefs (json, body, errors, SSE) behind the same auth', async () => {
    expect((await raw(studio.port, '/api/def/1')).status).toBe(401);
    expect((await c.get('/api/def/42?q=z')).json()).toEqual({ n: 42, q: 'z' });
    const b = await c.post('/api/def/body', { a: 1 });
    expect(b.status).toBe(201);
    expect(b.json()).toEqual({ a: 1 });
    const t = await c.get('/api/def/text');
    expect(t.body).toBe('hi');
    expect(t.headers['x-def']).toBe('1');
    const f = await c.get('/api/def/fail');
    expect(f.status).toBe(409);
    expect(f.json().error).toBe('busy');
    const s = await c.get('/api/def/sse');
    expect(s.headers['content-type']).toMatch(/text\/event-stream/);
    expect(s.body).toContain('id: 1\nevent: tick\ndata: {"n":1}');
  });

  it('mounts the debugger and trace routes', async () => {
    expect((await c.get('/api/debug/session')).json()).toMatchObject({ state: 'idle' });
    expect((await c.get('/api/runs/run-none/traces')).status).toBeGreaterThanOrEqual(200);
    const list = (await c.get('/api/routes')).json().routes.map((r: { path: string }) => r.path);
    expect(list).toEqual(expect.arrayContaining(['/api/journeys', '/api/events', '/api/debug/session', '/api/ext/hello']));
  });
});
