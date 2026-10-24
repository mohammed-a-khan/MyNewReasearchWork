/**
 * OAuth 2.0 for API steps against a local OAuth/OIDC server
 * (test/server/mock-oidc.ts) that checks every grant: client credentials
 * with private_key_jwt, resource-owner password, JWT bearer, device code
 * (polling, slow_down, approval in EZTest's browser as a role),
 * authorization code + PKCE through EZTest's headless browser signing in as
 * a vault role, token caching, refresh-token rotation and re-login when a
 * refresh is refused. The journey test calls an API as the role.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { OAuth2TokenProvider, signJwt, pkcePair } from '../../src/identity/oauth.js';
import { IdentityVault } from '../../src/identity/vault.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { flattenStepResults } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { startMockOidc, type MockOidc } from '../server/mock-oidc.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = (k: { export(o: { type: 'pkcs8'; format: 'pem' }): string | Buffer }) => String(k.export({ type: 'pkcs8', format: 'pem' }));

describe('OAuth grants and client authentication (local OAuth server)', () => {
  let idp: MockOidc;
  beforeAll(async () => {
    idp = await startMockOidc({ sub: 'unused' }, { users: { alice: 'Wonder#1' }, deviceInterval: 1 });
    idp.registerClient('svc-jwt', { publicKey: rsa.publicKey });
    idp.registerClient('svc-ec', { publicKey: ec.publicKey });
    idp.registerClient('web', { secret: 'web-secret' });
    idp.registerClient('tv', {});
  });
  afterAll(() => idp.close());

  it('signs JWTs (RS256, ES256, PS256) and makes PKCE pairs', () => {
    for (const [alg, key] of [['RS256', pem(rsa.privateKey)], ['ES256', pem(ec.privateKey)], ['PS256', pem(rsa.privateKey)]] as const) {
      const jwt = signJwt({ sub: 'x' }, key, { alg, kid: 'k1' });
      expect(JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString())).toEqual({ alg, typ: 'JWT', kid: 'k1' });
    }
    expect(() => signJwt({}, pem(ec.privateKey), { alg: 'RS256' })).toThrow(/RS256 needs an RSA key/);
    const p = pkcePair();
    expect(p.verifier).toMatch(/^[\w-]{43}$/);
    expect(p.challenge).toMatch(/^[\w-]{43}$/);
  });

  it('client credentials with private_key_jwt (RSA and EC keys); the server verifies the assertion', async () => {
    for (const [id, key] of [['svc-jwt', pem(rsa.privateKey)], ['svc-ec', pem(ec.privateKey)]] as const) {
      const p = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: id, clientAuth: 'private_key_jwt', clientKey: { privateKey: key, kid: 'k1' }, scope: 'orders.read' });
      const t = await p.getTokenResponse();
      expect(idp.claims(t.accessToken)).toMatchObject({ sub: id, scope: 'orders.read' });
      expect(idp.clientAuth.at(-1)).toBe('private_key_jwt');
      const assertion = idp.tokenRequests.at(-1)!.client_assertion;
      expect(idp.claims(assertion)).toMatchObject({ iss: id, sub: id, aud: `${idp.issuer}/token` });
      expect(idp.tokenRequests.at(-1)!.client_secret).toBeUndefined();
    }
    // A key the server does not know is refused.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: 'svc-jwt', clientAuth: 'private_key_jwt', clientKey: { privateKey: pem(other.privateKey) } });
    await expect(bad.getToken()).rejects.toThrow(/Token request failed \(HTTP 401\) invalid_client/);
  });

  it('resource-owner password; tokens are cached, refreshed with a rotated refresh token, and re-obtained when a refresh is refused', async () => {
    let now = Date.now();
    const p = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: 'web', clientSecret: 'web-secret', clientAuth: 'client_secret_basic', grant: 'password', username: 'alice', password: 'Wonder#1', now: () => now });
    const a = await p.getToken();
    expect(idp.claims(a).sub).toBe('alice');
    expect(await p.getToken()).toBe(a); // cached
    expect(p.history).toEqual(['password']);
    now += 300_000; // past expiry minus skew
    const b = await p.getToken();
    expect(b).not.toBe(a);
    expect(p.history).toEqual(['password', 'refresh_token']);
    now += 300_000;
    idp.revokeRefreshTokens();
    const c = await p.getToken();
    expect(idp.claims(c).sub).toBe('alice');
    expect(p.history).toEqual(['password', 'refresh_token', 'refresh_token', 'password']);
    const wrong = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: 'web', clientSecret: 'web-secret', grant: 'password', username: 'alice', password: 'nope' });
    await expect(wrong.getToken()).rejects.toThrow(/invalid_grant: wrong username or password/);
    // Concurrent callers share one request.
    const q = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: 'web', clientSecret: 'web-secret', grant: 'password', username: 'alice', password: 'Wonder#1' });
    await Promise.all([q.getToken(), q.getToken(), q.getToken()]);
    expect(q.requests).toBe(1);
  });

  it('JWT bearer grant (RFC 7523): a signed assertion for a subject', async () => {
    const p = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: 'svc-jwt', grant: 'jwt_bearer', assertion: { privateKey: pem(rsa.privateKey), subject: 'batch-user-42' } });
    const t = await p.getToken();
    expect(idp.claims(t)).toMatchObject({ sub: 'batch-user-42' });
    expect(idp.tokenRequests.at(-1)!.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const forged = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: 'svc-jwt', grant: 'jwt_bearer', assertion: { privateKey: pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), subject: 'x' } });
    await expect(forged.getToken()).rejects.toThrow(/invalid_grant: assertion rejected/);
  });

  it('device code: polls with authorization_pending until approved; slow_down adds 5 s', async () => {
    const seen: string[] = [];
    const slept: number[] = [];
    const p = new OAuth2TokenProvider({
      tokenUrl: `${idp.issuer}/token`, clientId: 'tv', grant: 'device_code', deviceAuthorizationUrl: `${idp.issuer}/device_authorization`, scope: 'orders.read',
      onDeviceCode: (info) => {
        seen.push(info.userCode);
        setTimeout(() => idp.approveDevice(info.userCode), 1500);
      },
      sleep: (ms) => {
        slept.push(ms);
        return new Promise((r) => setTimeout(r, Math.min(ms, 1000)));
      },
    });
    const t = await p.getToken();
    expect(idp.claims(t).sub).toBe(`device-user:${seen[0]}`);
    const polls = idp.tokenRequests.filter((r) => r.grant_type === 'urn:ietf:params:oauth:grant-type:device_code');
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(slept[0]).toBe(1000);
    const never = new OAuth2TokenProvider({ tokenUrl: `${idp.issuer}/token`, clientId: 'tv', grant: 'device_code', deviceAuthorizationUrl: `${idp.issuer}/device_authorization` });
    await expect(never.getToken()).rejects.toThrow(/no approver is configured/);
  });
});

describe('Browser OAuth as a vault role (EZTest\'s headless Chromium)', () => {
  let idp: MockOidc;
  let api: Server;
  let apiUrl: string;
  beforeAll(async () => {
    idp = await startMockOidc({ sub: 'unused' }, { loginForm: { username: 'alice', password: 'Wonder#1' }, audience: 'orders-api' });
    idp.registerClient('spa', {}); // a public client: PKCE, no secret
    api = createServer((req, res) => {
      const tok = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      const claims = tok ? idp.claims(tok) : undefined;
      if (!claims || claims.aud !== 'orders-api') {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: claims.sub, scope: claims.scope }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => api.close(() => r()));
    await idp.close();
  });

  it('authorization code + PKCE: the browser fills the IdP form as the role; the redirect is intercepted; state and verifier checked', async () => {
    const vault = new IdentityVault({
      roles: { alice: { username: 'alice', password: 'Wonder#1', api: { tokenUrl: `${idp.issuer}/token`, clientId: 'spa', clientAuth: 'none', grant: 'authorization_code', authorizeUrl: `${idp.issuer}/authorize`, redirectUri: 'http://127.0.0.1:1/callback', scope: 'openid orders.read' } } },
      sessionDir: await mkdtemp(join(tmpdir(), 'eztest-oauth-')),
    });
    const tok = await vault.apiToken('alice');
    expect(idp.claims(tok)).toMatchObject({ sub: 'alice', aud: 'orders-api', scope: 'openid orders.read' });
    const req = idp.tokenRequests.at(-1)!;
    expect(req).toMatchObject({ grant_type: 'authorization_code', client_id: 'spa', redirect_uri: 'http://127.0.0.1:1/callback' });
    expect(req.code_verifier).toMatch(/^[\w-]{43}$/);
    expect(await vault.apiToken('alice')).toBe(tok); // cached: no second browser sign-in
    const bad = new IdentityVault({
      roles: { mallory: { username: 'alice', password: 'wrong', api: { tokenUrl: `${idp.issuer}/token`, clientId: 'spa', clientAuth: 'none', grant: 'authorization_code', authorizeUrl: `${idp.issuer}/authorize`, redirectUri: 'http://127.0.0.1:1/callback' } } },
      sessionDir: await mkdtemp(join(tmpdir(), 'eztest-oauth-')), timeoutMs: 3000,
    });
    await expect(bad.apiToken('mallory')).rejects.toThrow(/login failed: Wrong username or password/);
  }, 60_000);

  it('device code approved in the browser as the role', async () => {
    const dev = await startMockOidc({ sub: 'x' }, { loginForm: { username: 'alice', password: 'Wonder#1' }, deviceInterval: 1 });
    dev.registerClient('tv', {});
    try {
      // The verification page of this IdP is its sign-in form: signing in approves the code.
      const vault = new IdentityVault({
        roles: { alice: { username: 'alice', password: 'Wonder#1', api: { tokenUrl: `${dev.issuer}/token`, clientId: 'tv', clientAuth: 'none', grant: 'device_code', deviceAuthorizationUrl: `${dev.issuer}/device_authorization` } } },
        sessionDir: await mkdtemp(join(tmpdir(), 'eztest-oauth-')),
      });
      const tok = await vault.apiToken('alice');
      expect(String(dev.claims(tok).sub)).toMatch(/^device-user:/);
    } finally {
      await dev.close();
    }
  }, 60_000);

  it('a journey calls the API as the role; the token comes from the browser sign-in (config only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-oauth-j-'));
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
      outputDir: 'results', healing: { enabled: false },
      identity: {
        secretStores: [{ type: 'env', prefix: 'EZT_OAUTH_' }],
        roles: { alice: { username: 'alice', password: 'secret://env/ALICE_PW', api: { tokenUrl: `${idp.issuer}/token`, clientId: 'spa', clientAuth: 'none', grant: 'authorization_code', authorizeUrl: `${idp.issuer}/authorize`, redirectUri: 'http://127.0.0.1:1/cb', scope: 'orders.read' } } },
      },
    }));
    process.env.EZT_OAUTH_ALICE_PW = 'Wonder#1';
    try {
      const loaded = await loadConfig({ cwd: dir, environment: {} });
      const engine = await createEngine(loaded, { cwd: dir });
      try {
        const run = await engine.run([parseEzScript(`Journey: Orders as alice
Call API "GET ${apiUrl}/me" as alice and store as me
Expect response me "$.user" equals "alice"
Call API "GET ${apiUrl}/me" as alice and store as again
`)]);
        const j = run.journeys[0];
        expect(j.status, flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status} ${s.error?.message ?? ''}`).join('\n')).toBe('passed');
      } finally {
        await engine.close();
      }
    } finally {
      delete process.env.EZT_OAUTH_ALICE_PW;
    }
  }, 90_000);
});
