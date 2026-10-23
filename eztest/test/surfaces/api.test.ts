import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { startDemoApp, DEMO_CLIENT, type DemoServer } from '../../examples/demo-app/server.js';
import {
  ApiClient,
  ApiError,
  parseRetryAfter,
  expectStatus,
  expectHeader,
  expectJsonPath,
  expectSchema,
  expectResponseTime,
  validateSchema,
  AssertionFailure,
  getPath,
  queryPath,
  type TokenProvider,
} from '../../src/surfaces/index.js';
import { NotSupportedError } from '../../src/core/index.js';
import { startMock, json, type MockServer } from './mock-server.js';

let demo: DemoServer;
beforeAll(async () => {
  demo = await startDemoApp();
  demo.db.prepare('INSERT INTO orders (customer_id, created_by, status, total, created_at) VALUES (?, ?, ?, ?, ?)').run(1, 'bob', 'Submitted', 39.98, '2026-01-02T10:00:00.000Z');
  demo.db.prepare('INSERT INTO order_lines (order_id, sku, name, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)').run(1, 'SKU-100', 'Widget', 2, 19.99, 39.98);
});
afterAll(() => demo.close());

async function demoToken(api: ApiClient): Promise<string> {
  const r = await api.post<{ access_token: string }>('/api/token', {
    form: { grant_type: 'client_credentials', client_id: DEMO_CLIENT.id, client_secret: DEMO_CLIENT.secret },
  });
  expectStatus(r, 200);
  return r.body.access_token;
}

describe('ApiClient against the demo app', () => {
  it('gets a token, lists orders with bearer auth, validates schema and paths', async () => {
    const api = new ApiClient({ baseUrl: demo.url });
    const token = await demoToken(api);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    const authed = api.with({ auth: { type: 'bearer', token } });
    const r = await authed.get('/api/orders');
    expectStatus(r, 200);
    expectStatus(r, '2xx');
    expectHeader(r, 'content-type', /application\/json/);
    expectResponseTime(r, 5000);
    expectJsonPath(r, '$[0].customer', 'Contoso Ltd');
    expectJsonPath(r, '$[0].total', 39.98);
    expectSchema(r, {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'customer', 'status', 'total'],
        properties: { id: { type: 'integer' }, customer: { type: 'string' }, status: { enum: ['Submitted'] }, total: { type: 'number' } },
      },
    });
    const one = await authed.get('/api/orders/1');
    expect(getPath(one.body, '$.lines[0].sku')).toBe('SKU-100');
    expect(getPath(one.body, '$.lines[*].qty')).toEqual([2]);
    const missing = await authed.get('/api/orders/999');
    expect(() => expectStatus(missing, 200)).toThrow(AssertionFailure);
    expectStatus(missing, 404);
  });

  it('gets 401 without a token and with a bad client secret', async () => {
    const api = new ApiClient({ baseUrl: demo.url });
    const r = await api.get('/api/orders');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthorized' });
    const bad = await api.post('/api/token', { form: { grant_type: 'client_credentials', client_id: 'x', client_secret: 'y' } });
    expect(bad.status).toBe(401);
  });

  it('uses an OAuth2 token provider and re-acquires once after a 401', async () => {
    const api = new ApiClient({ baseUrl: demo.url });
    let calls = 0;
    let invalidated = 0;
    let cached: string | undefined = 'stale-token-not-valid';
    const provider: TokenProvider = {
      async getToken() {
        calls++;
        if (!cached) cached = await demoToken(api);
        return cached;
      },
      invalidate() {
        invalidated++;
        cached = undefined;
      },
    };
    const r = await api.get('/api/customers', { auth: { type: 'oauth2', tokenProvider: provider } });
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBe(3);
    expect(invalidated).toBe(1);
    expect(calls).toBe(2);
  });
});

describe('ApiClient retries, timeouts, auth and bodies', () => {
  let mock: MockServer;
  const counters = new Map<string, number>();
  beforeAll(async () => {
    mock = await startMock(async (req, body, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const n = (counters.get(u.pathname + req.method) ?? 0) + 1;
      counters.set(u.pathname + req.method, n);
      if (u.pathname === '/flaky') return n < 3 ? json(res, 503, { n }) : json(res, 200, { n });
      if (u.pathname === '/rate') return n < 2 ? json(res, 429, {}, { 'retry-after': '0' }) : json(res, 200, { n });
      if (u.pathname === '/always503') return json(res, 503, { n });
      if (u.pathname === '/slow') {
        await new Promise((r) => setTimeout(r, 500));
        return json(res, 200, {});
      }
      if (u.pathname === '/echo') {
        return json(res, 200, { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body });
      }
      json(res, 404, {});
    });
  });
  afterAll(() => mock.close());

  const noSleep = { sleep: async () => {}, random: () => 0.5 };

  it('retries idempotent GET on 503 with backoff and succeeds', async () => {
    const delays: number[] = [];
    const api = new ApiClient({ baseUrl: mock.url, random: () => 1, sleep: async (ms) => void delays.push(ms), retry: { max: 3, baseDelayMs: 100 } });
    const r = await api.get('/flaky');
    expect(r.status).toBe(200);
    expect(r.attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('never retries a non-idempotent POST', async () => {
    const api = new ApiClient({ baseUrl: mock.url, ...noSleep, retry: { max: 5 } });
    const before = mock.requests.filter((q) => q.url === '/always503' && q.method === 'POST').length;
    const r = await api.post('/always503', { json: { a: 1 } });
    expect(r.status).toBe(503);
    expect(r.attempts).toBe(1);
    expect(mock.requests.filter((q) => q.url === '/always503' && q.method === 'POST').length - before).toBe(1);
  });

  it('honors Retry-After on 429 and gives up after max retries', async () => {
    const delays: number[] = [];
    const api = new ApiClient({ baseUrl: mock.url, sleep: async (ms) => void delays.push(ms), retry: { max: 2 } });
    const r = await api.get('/rate');
    expect(r.status).toBe(200);
    expect(delays).toEqual([0]);
    const r2 = await api.put('/always503', { json: {} });
    expect(r2.status).toBe(503);
    expect(r2.attempts).toBe(3);
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('times out with a clear error', async () => {
    const api = new ApiClient({ baseUrl: mock.url, timeoutMs: 100, retry: false });
    const err = await api.get('/slow').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('API_TIMEOUT');
  });

  it('reports network errors with masked URL', async () => {
    const api = new ApiClient({ baseUrl: 'http://127.0.0.1:1', retry: false, masker: { mask: (s) => s.replace('hunter22', '****') } });
    const err = await api.get('/x', { query: { key: 'hunter22' } }).catch((e) => e);
    expect(err.code).toBe('API_NETWORK');
    expect(err.message).not.toContain('hunter22');
  });

  it('sends basic auth, api key in query, form and multipart bodies', async () => {
    const api = new ApiClient({ baseUrl: mock.url, headers: { 'x-default': 'd' } });
    const b = await api.get<{ headers: Record<string, string> }>('/echo', { auth: { type: 'basic', username: 'u', password: 'p' } });
    expect(b.body.headers.authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
    expect(b.body.headers['x-default']).toBe('d');
    const k = await api.get<{ query: Record<string, string> }>('/echo', { auth: { type: 'apiKey', name: 'api_key', value: 'k1', in: 'query' }, query: { a: 1 } });
    expect(k.body.query).toEqual({ a: '1', api_key: 'k1' });
    const f = await api.post<{ body: string; headers: Record<string, string> }>('/echo', { form: { x: 'a b', y: 2 } });
    expect(f.body.body).toBe('x=a+b&y=2');
    expect(f.body.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const m = await api.post<{ body: string; headers: Record<string, string> }>('/echo', {
      multipart: { note: 'hi', file: { filename: 'a.txt', content: 'file-content', contentType: 'text/plain' } },
    });
    expect(m.body.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(m.body.body).toContain('filename="a.txt"');
    expect(m.body.body).toContain('file-content');
    await expect(api.get('/echo', { json: {} })).rejects.toThrow(/cannot have a body/);
  });

  it('throws NotSupportedError for proxy and disabled TLS verification', () => {
    expect(() => new ApiClient({ proxy: 'http://proxy:8080' })).toThrow(NotSupportedError);
    expect(() => new ApiClient({ rejectUnauthorized: false })).toThrow(NotSupportedError);
    expect(() => new ApiClient().resolveUrl('/relative')).toThrow(/baseUrl/);
  });
});

describe('JSON path and schema', () => {
  const doc = { a: { b: [{ c: 1 }, { c: 2 }] }, 'weird key': true, list: [[1, 2], [3]] };
  it('gets definite and wildcard paths', () => {
    expect(getPath(doc, '$.a.b[0].c')).toBe(1);
    expect(getPath(doc, '$.a.b[-1].c')).toBe(2);
    expect(getPath(doc, '$.a.b[*].c')).toEqual([1, 2]);
    expect(getPath(doc, "$['weird key']")).toBe(true);
    expect(getPath(doc, '$.list[*][0]')).toEqual([1, 3]);
    expect(getPath(doc, '$.nope.x')).toBeUndefined();
    expect(queryPath(doc, '$.a.*')).toHaveLength(1);
    expect(() => getPath(doc, '$.a[?(@.x)]')).toThrow(/unsupported selector/);
  });
  it('validates with formats and reports precise errors', () => {
    const schema = { type: 'object', required: ['email', 'when'], properties: { email: { type: 'string', format: 'email' }, when: { type: 'string', format: 'date-time' } } };
    expect(validateSchema({ email: 'a@b.co', when: '2026-01-01T00:00:00Z' }, schema).valid).toBe(true);
    const bad = validateSchema({ email: 'nope', when: 'yesterday' }, schema);
    expect(bad.valid).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/\/email must match format "email"/);
    expect(() => validateSchema({}, {})).toThrow(/non-empty/);
    const s2020 = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', prefixItems: [{ type: 'number' }] };
    expect(validateSchema([1], s2020).valid).toBe(true);
    expect(validateSchema(['x'], s2020).valid).toBe(false);
  });
  it('expectJsonPath fails on missing path and wrong value', () => {
    expect(() => expectJsonPath(doc, '$.a.x')).toThrow(/not found/);
    expect(() => expectJsonPath(doc, '$.a.b[0].c', 5)).toThrow(/expected 5, got 1/);
  });
});
