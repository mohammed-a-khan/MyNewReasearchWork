import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { inspect } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import {
  SecretHandle,
  SecretRegistry,
  EnvSecretStore,
  FileSecretStore,
  MemorySecretStore,
  ChainSecretStore,
  AzureKeyVaultSecretStore,
  OAuth2TokenProvider,
  azureAdTokenProvider,
} from '../../src/identity/index.js';
import { SecretMasker, encryptValue } from '../../src/config/index.js';
import { startDemoApp, DEMO_CLIENT, type DemoServer } from '../../examples/demo-app/server.js';

const MASTER = 'identity-test-master-key-123';

describe('SecretHandle', () => {
  it('never reveals the value when stringified, serialized or inspected', async () => {
    const masker = new SecretMasker();
    const reg = new SecretRegistry([new MemorySecretStore({ pw: 'Wonderland#1' }, 'mem')], masker);
    const h = reg.handle('secret://mem/pw');
    const outputs = [String(h), `${h}`, JSON.stringify({ h }), inspect(h), inspect({ nested: h }, { depth: 5, showHidden: true }), Object.keys(h).join(), JSON.stringify(Object.entries(h))];
    for (const o of outputs) expect(o).not.toContain('Wonderland');
    expect(JSON.parse(JSON.stringify(h))).toEqual({ ref: 'secret://mem/pw' });
    expect(masker.size).toBe(0); // not resolved yet
    expect(await h.resolve()).toBe('Wonderland#1');
    expect(masker.mask('x Wonderland#1')).toBe('x ****');
    expect(Object.isFrozen(h)).toBe(true);
  });

  it('literal and encrypted values become handles; missing secrets fail loudly', async () => {
    const masker = new SecretMasker();
    const reg = new SecretRegistry([], masker);
    const lit = reg.from('inline-pass-123', 'alice.password');
    expect(String(lit)).toMatch(/^\[secret secret:\/\/inline\/alice\.password-\d+\]$/);
    expect(masker.mask('inline-pass-123')).toBe('****');
    expect(await lit.resolve()).toBe('inline-pass-123');
    const enc = reg.from(encryptValue('enc-pass-456', MASTER), 'x', { EZTEST_MASTER_KEY: MASTER });
    expect(String(enc)).not.toContain('enc-pass');
    expect(await enc.resolve()).toBe('enc-pass-456');
    expect(masker.mask('enc-pass-456')).toBe('****');
    await expect(reg.handle('secret://nope/k').resolve()).rejects.toThrow(/Unknown secret store "nope"/);
    reg.register(new MemorySecretStore({}, 'mem'));
    await expect(reg.handle('secret://mem/absent').resolve()).rejects.toThrow(/secret:\/\/mem\/absent is not set/);
    expect(() => reg.handle('not-a-ref')).toThrow(/Invalid secret reference/);
    expect(() => new SecretHandle('bad', async () => 'x')).toThrow();
  });
});

describe('secret stores', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'eztest-secrets-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('EnvSecretStore reads with prefix', async () => {
    const s = new EnvSecretStore({ prefix: 'APP_', env: { APP_PW: 'pw-1', PW: 'no', APP_EMPTY: '' } });
    expect(await s.get('PW')).toBe('pw-1');
    expect(await s.get('EMPTY')).toBeUndefined();
    expect(await s.get('NOPE')).toBeUndefined();
  });

  it('FileSecretStore reads YAML/JSON with nested keys and ENC values', async () => {
    const yml = join(dir, 'secrets.yaml');
    writeFileSync(yml, `alice:\n  password: "${encryptValue('Wonderland#1', MASTER)}"\n  user: alice\nport: 5432\n`);
    const masker = new SecretMasker();
    const s = new FileSecretStore({ path: yml, masterKey: MASTER, masker });
    expect(await s.get('alice.password')).toBe('Wonderland#1');
    expect(await s.get('alice.user')).toBe('alice');
    expect(await s.get('port')).toBe('5432');
    expect(await s.get('missing')).toBeUndefined();
    expect(masker.mask('Wonderland#1')).toBe('****');
    const noKey = new FileSecretStore({ path: yml, masterKey: undefined });
    const prev = process.env.EZTEST_MASTER_KEY;
    delete process.env.EZTEST_MASTER_KEY;
    try {
      await expect(noKey.get('alice.password')).rejects.toThrow(/EZTEST_MASTER_KEY/);
    } finally {
      if (prev !== undefined) process.env.EZTEST_MASTER_KEY = prev;
    }
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"secret": "leaky-value",');
    const err = await new FileSecretStore({ path: bad }).get('secret').catch((e) => e);
    expect(err.message).toMatch(/not valid JSON/);
    expect(err.message).not.toContain('leaky');
    await expect(new FileSecretStore({ path: join(dir, 'none.json') }).get('x')).rejects.toThrow(/ENOENT/);
  });

  it('ChainSecretStore returns the first defined value', async () => {
    const c = new ChainSecretStore([new MemorySecretStore({ a: '1' }), new MemorySecretStore({ a: '2', b: '3' })]);
    expect(await c.get('a')).toBe('1');
    expect(await c.get('b')).toBe('3');
    expect(await c.get('z')).toBeUndefined();
    expect(() => new ChainSecretStore([])).toThrow();
  });
});

describe('AzureKeyVaultSecretStore against a mock Entra ID + Key Vault', () => {
  let server: Server;
  let base: string;
  const seen: Array<{ url: string; auth?: string; body?: string }> = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/tenant-1/oauth2/v2.0/token' && req.method === 'POST') {
        const p = new URLSearchParams(body);
        if (p.get('client_id') !== 'kv-client' || p.get('client_secret') !== 'kv-secret-value' || p.get('scope') !== 'https://vault.azure.net/.default') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_client', error_description: 'bad secret kv-secret-value' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'kv-access-token', token_type: 'Bearer', expires_in: 3600 }));
      }
      if (req.headers.authorization !== 'Bearer kv-access-token') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'Unauthorized' } }));
      }
      if (u.pathname === '/secrets/db-password' && u.searchParams.get('api-version') === '7.4') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ value: 'kv-db-pass', id: 'x' }));
      }
      if (u.pathname === '/secrets/forbidden') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'Forbidden', message: 'nope' } }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'SecretNotFound' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('acquires a client-credentials token and reads secrets', async () => {
    const masker = new SecretMasker();
    const tp = azureAdTokenProvider({ tenantId: 'tenant-1', clientId: 'kv-client', clientSecret: 'kv-secret-value', authorityUrl: base, masker });
    const kv = new AzureKeyVaultSecretStore({ vaultUrl: base, tokenProvider: tp, masker });
    expect(await kv.get('db-password')).toBe('kv-db-pass');
    expect(await kv.get('db-password')).toBe('kv-db-pass'); // cached
    expect(await kv.get('missing-one')).toBeUndefined();
    await expect(kv.get('forbidden')).rejects.toThrow(/HTTP 403 \(Forbidden\)/);
    await expect(kv.get('bad name!')).rejects.toThrow(/Invalid Key Vault secret name/);
    expect(tp.requests).toBe(1);
    expect(masker.mask('kv-db-pass kv-access-token kv-secret-value')).toBe('**** **** ****');
    expect(seen.filter((s) => s.url.startsWith('/secrets/db-password')).length).toBe(1);
  });

  it('reports token failures without leaking the client secret', async () => {
    const masker = new SecretMasker();
    const tp = azureAdTokenProvider({ tenantId: 'tenant-1', clientId: 'kv-client', clientSecret: 'wrong-secret-xyz', authorityUrl: base, masker });
    const kv = new AzureKeyVaultSecretStore({ vaultUrl: base, tokenProvider: tp });
    const err = await kv.get('db-password').catch((e) => e);
    expect(err.message).toMatch(/Token request failed \(HTTP 401\) invalid_client/);
    expect(err.message).not.toContain('wrong-secret-xyz');
    expect(() => new AzureKeyVaultSecretStore({ vaultUrl: 'http://vault.example.com', tokenProvider: tp })).toThrow(/https/);
  });
});

describe('OAuth2TokenProvider', () => {
  let demo: DemoServer;
  beforeAll(async () => {
    demo = await startDemoApp();
  });
  afterAll(() => demo.close());

  it('caches the demo app token and single-flights concurrent requests', async () => {
    let fetches = 0;
    const counting: typeof fetch = (input, init) => {
      fetches++;
      return fetch(input, init);
    };
    const p = new OAuth2TokenProvider({ tokenUrl: `${demo.url}/api/token`, clientId: DEMO_CLIENT.id, clientSecret: DEMO_CLIENT.secret, fetch: counting, masker: new SecretMasker() });
    const [a, b, c] = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(await p.getToken()).toBe(a);
    expect(fetches).toBe(1);
    const res = await fetch(`${demo.url}/api/customers`, { headers: { authorization: `Bearer ${a}` } });
    expect(res.status).toBe(200);
    p.invalidate();
    const d = await p.getToken();
    expect(d).not.toBe(a);
    expect(fetches).toBe(2);
  });

  it('refreshes after expiry minus skew', async () => {
    let now = 1_000_000;
    const p = new OAuth2TokenProvider({ tokenUrl: `${demo.url}/api/token`, clientId: DEMO_CLIENT.id, clientSecret: DEMO_CLIENT.secret, now: () => now, skewSeconds: 60 });
    const a = await p.getToken();
    now += (3600 - 61) * 1000;
    expect(await p.getToken()).toBe(a);
    now += 2000; // inside the skew window
    expect(await p.getToken()).not.toBe(a);
    expect(p.requests).toBe(2);
  });

  it('fails with the OAuth error code for bad credentials', async () => {
    const p = new OAuth2TokenProvider({ tokenUrl: `${demo.url}/api/token`, clientId: DEMO_CLIENT.id, clientSecret: 'wrong-client-secret' });
    const err = await p.getToken().catch((e) => e);
    expect(err.message).toMatch(/HTTP 401\) invalid_client/);
    expect(err.message).not.toContain('wrong-client-secret');
  });

  it('supports the refresh_token grant with rotation and basic client auth', async () => {
    const bodies: URLSearchParams[] = [];
    const auths: string[] = [];
    let n = 0;
    const fake: typeof fetch = async (_url, init) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      auths.push(String((init?.headers as Record<string, string>).authorization));
      n++;
      return new Response(JSON.stringify({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const p = new OAuth2TokenProvider({ tokenUrl: 'https://idp.test/token', clientId: 'c', clientSecret: 's3', grant: 'refresh_token', refreshToken: 'rt-0', authMethod: 'basic', fetch: fake });
    expect(await p.getToken()).toBe('at-1');
    expect(await p.getToken()).toBe('at-2'); // expires_in 0 -> not cached
    expect(bodies.map((b) => b.get('refresh_token'))).toEqual(['rt-0', 'rt-1']);
    expect(bodies[0].get('grant_type')).toBe('refresh_token');
    expect(bodies[0].get('client_secret')).toBeNull();
    expect(auths[0]).toBe('Basic ' + Buffer.from('c:s3').toString('base64'));
    expect(() => new OAuth2TokenProvider({ tokenUrl: 'https://idp.test/token', clientId: 'c', grant: 'refresh_token' })).toThrow(/refreshToken/);
  });
});
