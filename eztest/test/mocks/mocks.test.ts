import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startDemoApp, DEMO_CLIENT, type DemoServer } from '../../examples/demo-app/server.js';
import {
  createMockServer,
  checkDrift,
  loadStore,
  saveStore,
  emptyStore,
  renderTemplate,
  normalizeQuery,
  redactText,
  seededRandom,
  type MockStore,
} from '../../src/mocks/index.js';

async function tokenVia(base: string): Promise<{ status: number; json: { access_token?: string; token_type?: string } }> {
  const res = await fetch(`${base}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: DEMO_CLIENT.id, client_secret: DEMO_CLIENT.secret }).toString(),
  });
  return { status: res.status, json: (await res.json()) as { access_token?: string } };
}

function rawGet(url: string): Promise<{ ok: true; status: number } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    const req = request(url, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: true, status: res.statusCode ?? 0 }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, code: e.code ?? e.message }));
    req.end();
  });
}

function handStore(): MockStore {
  const s = emptyStore();
  s.recordings.push(
    {
      id: 'H-1',
      request: { method: 'GET', path: '/api/hello', query: '', headers: {} },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"path":"{{request.path}}","name":"{{request.query.name}}","id":"{{uuid}}","n":1}',
        bodyEncoding: 'utf8',
      },
      recordedAt: new Date().toISOString(),
    },
  );
  return s;
}

describe('mocks: record against the demo app, replay without it', () => {
  let demo: DemoServer;
  let dir: string;
  let storePath: string;
  let liveCustomers: unknown;
  let liveToken: string;

  beforeAll(async () => {
    demo = await startDemoApp();
    dir = await mkdtemp(join(tmpdir(), 'eztest-mocks-'));
    storePath = join(dir, 'store.json');
  });
  let demoClosed = false;
  afterAll(async () => {
    if (!demoClosed) await demo?.close();
  });

  it('records token + customers through the proxy, redacting secrets', async () => {
    const rec = await createMockServer({ mode: 'record', target: demo.url, store: storePath });
    expect(rec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const tok = await tokenVia(rec.url);
    expect(tok.status).toBe(200);
    liveToken = tok.json.access_token!;
    expect(liveToken).toMatch(/^[a-f0-9]{32}$/);
    const res = await fetch(`${rec.url}/api/customers`, { headers: { authorization: `Bearer ${liveToken}` } });
    expect(res.status).toBe(200);
    liveCustomers = await res.json();
    expect(Array.isArray(liveCustomers)).toBe(true);
    // a second, query-carrying call to check normalization
    await fetch(`${rec.url}/api/orders?b=2&a=1`, { headers: { authorization: `Bearer ${liveToken}` } });
    await rec.close();

    const raw = await readFile(storePath, 'utf8');
    expect(raw).not.toContain(liveToken);
    expect(raw).not.toContain(DEMO_CLIENT.secret);
    const store = await loadStore(storePath);
    expect(store.recordings).toHaveLength(3);
    const [t, c, o] = store.recordings;
    expect(t.request.method).toBe('POST');
    expect(t.request.body).toContain('client_secret=%5BREDACTED%5D');
    expect(JSON.parse(t.response.body).access_token).toBe('{{uuid}}');
    expect(c.request.headers.authorization).toBe('[REDACTED]');
    expect(JSON.parse(c.response.body)).toEqual(liveCustomers);
    expect(o.request.query).toBe('a=1&b=2');
  });

  it('replays the same responses with the demo app stopped', async () => {
    demoClosed = true;
    await demo.close();
    const down = await rawGet(`${demo.url}/api/customers`);
    expect(down.ok).toBe(false);

    const rep = await createMockServer({ mode: 'replay', store: storePath });
    const tok = await tokenVia(rep.url);
    expect(tok.status).toBe(200);
    expect(tok.json.token_type).toBe('Bearer');
    expect(tok.json.access_token).toMatch(/^[0-9a-f-]{36}$/); // fresh {{uuid}}, never the recorded secret
    const res = await fetch(`${rep.url}/api/customers`, { headers: { authorization: `Bearer ${tok.json.access_token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-eztest-mock')).toContain('replay; recording=R-2');
    expect(await res.json()).toEqual(liveCustomers);
    // query order does not matter
    const o = await fetch(`${rep.url}/api/orders?a=1&b=2`);
    expect(o.status).toBe(200);
    expect(rep.stats.replayed).toBe(3);
    await rep.close();
  });

  it('answers unmatched requests with 501 and a helpful message, never a fake 200', async () => {
    const rep = await createMockServer({ mode: 'replay', store: storePath });
    const res = await fetch(`${rep.url}/api/customers?page=2`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; message: string; hint: string; candidatesOnSamePath: unknown[] };
    expect(body.error).toBe('eztest-mock-no-match');
    expect(body.message).toContain('GET /api/customers?page=2');
    expect(body.candidatesOnSamePath).toHaveLength(1);
    expect(body.hint).toMatch(/record/i);
    const wrongMethod = await fetch(`${rep.url}/api/customers`, { method: 'DELETE' });
    expect(wrongMethod.status).toBe(501);
    expect(rep.stats.unmatched).toBe(2);
    await rep.close();
  });

  it('detects drift after a recording shape is mutated', async () => {
    const live = await startDemoApp();
    try {
      // Shape is identical against a fresh live app
      const clean = await checkDrift(storePath, live.url, {
        auth: { clientCredentials: { tokenPath: '/api/token', clientId: DEMO_CLIENT.id, clientSecret: DEMO_CLIENT.secret } },
      });
      expect(clean.checked).toBe(2);
      expect(clean.skippedNonGet).toBe(1);
      expect(clean.results.map((r) => r.outcome)).toEqual(['ok', 'ok']);
      expect(clean.ok).toBe(true);

      const store = await loadStore(storePath);
      const cust = store.recordings.find((r) => r.request.path === '/api/customers')!;
      const rows = JSON.parse(cust.response.body) as Array<Record<string, unknown>>;
      cust.response.body = JSON.stringify(rows.map(({ region, ...r }) => ({ ...r, area: region, credit_limit: String(r.credit_limit) })));
      await saveStore(storePath, store);

      const tok = await tokenVia(live.url);
      const report = await checkDrift(storePath, live.url, { auth: { bearer: tok.json.access_token! } });
      expect(report.ok).toBe(false);
      expect(report.drifted).toBe(1);
      const item = report.results.find((r) => r.path === '/api/customers')!;
      expect(item.outcome).toBe('drift');
      expect(item.differences).toEqual(
        expect.arrayContaining([
          { path: '$[].area', kind: 'missing-key', expected: 'string' },
          { path: '$[].region', kind: 'extra-key', actual: 'string' },
          { path: '$[].credit_limit', kind: 'type-changed', expected: 'string', actual: 'number' },
        ]),
      );

      // Without auth the live service answers 401: reported as status drift, not silently OK
      const noAuth = await checkDrift(storePath, live.url);
      expect(noAuth.results.every((r) => r.differences.some((d) => d.kind === 'status-changed'))).toBe(true);
    } finally {
      await live.close();
    }
  });
});

describe('mocks: sequences, templates, faults', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eztest-mocks2-'));
  });

  it('serves stateful sequences in order and repeats the last', async () => {
    const s = emptyStore();
    for (const [i, status] of ['pending', 'processing', 'shipped'].entries()) {
      s.recordings.push({
        id: `S-${i + 1}`,
        request: { method: 'GET', path: '/api/orders/7', query: '', headers: {} },
        response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }), bodyEncoding: 'utf8' },
        recordedAt: new Date().toISOString(),
      });
    }
    const p = join(dir, 'seq.json');
    await saveStore(p, s);
    const m = await createMockServer({ mode: 'replay', store: p });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push(((await (await fetch(`${m.url}/api/orders/7`)).json()) as { status: string }).status);
    expect(seen).toEqual(['pending', 'processing', 'shipped', 'shipped']);
    m.resetSequences();
    expect(((await (await fetch(`${m.url}/api/orders/7`)).json()) as { status: string }).status).toBe('pending');
    await m.close();

    const strict = await createMockServer({ mode: 'replay', store: p, sequenceExhausted: 'not-found' });
    for (let i = 0; i < 3; i++) expect((await fetch(`${strict.url}/api/orders/7`)).status).toBe(200);
    expect((await fetch(`${strict.url}/api/orders/7`)).status).toBe(501);
    await strict.close();
  });

  it('renders templates by plain token replacement, JSON-escaped', async () => {
    const p = join(dir, 'tpl.json');
    await saveStore(p, handStore());
    const m = await createMockServer({ mode: 'replay', store: p, match: { ignoreQueryParams: ['name'] } });
    const res = await fetch(`${m.url}/api/hello?name=${encodeURIComponent('Ann "the" <b>')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; name: string; id: string; n: number };
    expect(body).toMatchObject({ path: '/api/hello', name: 'Ann "the" <b>', n: 1 });
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    await m.close();
    expect(renderTemplate('{{constructor}} {{request.method}}', { method: 'GET', path: '/', query: new URLSearchParams(), headers: {} })).toBe('{{constructor}} GET');
  });

  it('injects latency, status overrides, corruption and dropped connections', async () => {
    const p = join(dir, 'faults.json');
    const s = handStore();
    s.recordings.push({ ...s.recordings[0], id: 'H-2', request: { ...s.recordings[0].request, path: '/api/slow' } });
    s.recordings.push({ ...s.recordings[0], id: 'H-3', request: { ...s.recordings[0].request, path: '/api/broken' } });
    s.recordings.push({ ...s.recordings[0], id: 'H-4', request: { ...s.recordings[0].request, path: '/api/garbled' } });
    await saveStore(p, s);
    const m = await createMockServer({
      mode: 'replay',
      store: p,
      faults: [
        { path: '/api/slow', latencyMs: 250 },
        { path: '/api/broken', status: 503 },
        { path: '/api/garbled', corruptBody: true },
        { path: '/api/drop/**', drop: true },
      ],
    });
    const t0 = Date.now();
    const slow = await fetch(`${m.url}/api/slow`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    expect(slow.status).toBe(200);
    const broken = await fetch(`${m.url}/api/broken`);
    expect(broken.status).toBe(503);
    expect(broken.headers.get('x-eztest-fault')).toBe('status=503');
    const garbled = await (await fetch(`${m.url}/api/garbled`)).text();
    expect(() => JSON.parse(garbled)).toThrow();
    const dropped = await rawGet(`${m.url}/api/drop/x`);
    expect(dropped.ok).toBe(false);
    expect(m.stats.faulted).toBe(4);
    await m.close();
  });

  it('applies probabilistic faults deterministically with a seed', async () => {
    const p = join(dir, 'prob.json');
    await saveStore(p, handStore());
    const pattern = async () => {
      const m = await createMockServer({ mode: 'replay', store: p, seed: 42, faults: [{ path: '/api/**', status: 500, probability: 0.5 }] });
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push((await fetch(`${m.url}/api/hello`)).status);
      await m.close();
      return out;
    };
    const a = await pattern();
    const b = await pattern();
    expect(a).toEqual(b);
    expect(a).toContain(500);
    expect(a).toContain(200);
    const r = seededRandom(7);
    expect([r(), r()]).toEqual((() => { const q = seededRandom(7); return [q(), q()]; })());
  });

  it('refuses bad configuration instead of silently doing nothing', async () => {
    const p = join(dir, 'empty.json');
    await saveStore(p, emptyStore());
    await expect(createMockServer({ mode: 'replay', store: p })).rejects.toThrow(/no recordings/);
    await expect(createMockServer({ mode: 'replay', store: join(dir, 'missing.json') })).rejects.toThrow(/not found/);
    await expect(createMockServer({ mode: 'record', store: p })).rejects.toThrow(/target/);
    await expect(createMockServer({ mode: 'bogus' as never, store: p })).rejects.toThrow(/Not supported/);
    await expect(createMockServer({ mode: 'replay', store: p, faults: [{ path: '/x' }] })).rejects.toThrow(/effect/);
    await writeFile(join(dir, 'gets.json'), JSON.stringify({ recordings: [{ id: 'P', request: { method: 'POST', path: '/x' }, response: { status: 200 } }] }));
    await expect(checkDrift(join(dir, 'gets.json'), 'http://127.0.0.1:1')).rejects.toThrow(/no GET recordings/);
  });

  it('normalizes queries and redacts token-looking text', () => {
    expect(normalizeQuery('?b=2&a=1&a=0')).toBe('a=0&a=1&b=2');
    const t = redactText('Authorization: Bearer abcdef0123456789abcdef0123456789 and {"access_token":"xyz123"} eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl');
    expect(t).not.toMatch(/abcdef0123/);
    expect(t).not.toContain('xyz123');
    expect(t).not.toContain('eyJhbGciOi');
  });
});
