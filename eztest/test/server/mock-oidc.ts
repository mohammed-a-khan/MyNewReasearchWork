/**
 * A small OAuth 2.0 / OpenID Connect provider for tests.
 *
 * - discovery, JWKS, authorize (signs the configured user in at once, or -
 *   with `loginForm` - shows a sign-in form a browser fills), token;
 * - grants: authorization_code (PKCE S256 required), client_credentials,
 *   password, refresh_token (rotated), device_code (RFC 8628, with
 *   authorization_pending / slow_down), JWT bearer (RFC 7523);
 * - client authentication: client_secret_basic, client_secret_post and
 *   private_key_jwt (RFC 7523 client assertions, checked against the
 *   client's registered public key, audience and replay);
 * - access tokens and ID tokens are RS256 JWTs (a key generated per
 *   instance, or `signingKey`).
 */
import { createHash, createPublicKey, createSign, createVerify, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockUser {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
}

export interface MockClient {
  /** client_secret_basic / client_secret_post */
  secret?: string;
  /** private_key_jwt (and the issuer of JWT-bearer assertions) */
  publicKey?: KeyObject | string;
}

export interface MockOidcOptions {
  /** Sign tokens with this key (PEM, PKCS#8) and kid instead of a fresh one. */
  signingKey?: { privateKey: string; kid: string };
  /** Audience of access tokens (default: the client id). */
  audience?: string;
  /** Render a sign-in form at /authorize instead of signing the user in at once; these are the accepted credentials. */
  loginForm?: { username: string; password: string };
  /** Users for the password grant: username -> password. */
  users?: Record<string, string>;
  /** Access-token lifetime in seconds (default 300). */
  accessTokenTtl?: number;
  /** Seconds a device-code client must wait between polls (default 1). */
  deviceInterval?: number;
}

export interface MockOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The user the next /authorize signs in. */
  user: MockUser;
  /** Tamper with the next ID token (tests). */
  tamper?: 'nonce' | 'audience' | 'expired' | 'signature' | 'issuer';
  tokenRequests: Array<Record<string, string>>;
  /** How each token request authenticated its client. */
  clientAuth: string[];
  /** Register (or replace) a client. */
  registerClient(id: string, c: MockClient): void;
  /** Approve a pending device code by its user code (what a person does at the verification page). */
  approveDevice(userCode: string): boolean;
  /** Decode (without verifying) a token this server issued. */
  claims(jwt: string): Record<string, unknown>;
  /** Revoke every refresh token (the next refresh fails with invalid_grant). */
  revokeRefreshTokens(): void;
  close(): Promise<void>;
}

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const unb64 = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

function verifyJwt(jwt: string, key: KeyObject): Record<string, unknown> | undefined {
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return undefined;
  const head = unb64(h);
  const alg = String(head.alg);
  const algo = alg === 'RS256' ? 'RSA-SHA256' : alg === 'ES256' ? 'SHA256' : alg === 'PS256' ? 'RSA-SHA256' : undefined;
  if (!algo) return undefined;
  const ok = createVerify(algo).update(`${h}.${p}`).verify(alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : alg === 'PS256' ? { key, padding: 6, saltLength: 32 } : key, Buffer.from(s, 'base64url'));
  return ok ? unb64(p) : undefined;
}

export async function startMockOidc(user: MockUser, opts: MockOidcOptions = {}): Promise<MockOidc> {
  const generated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = opts.signingKey ? opts.signingKey.privateKey : generated.privateKey;
  const publicKey = opts.signingKey ? createPublicKey(opts.signingKey.privateKey) : generated.publicKey;
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = opts.signingKey?.kid ?? randomBytes(4).toString('hex');
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string; clientId: string; scope: string; sub: string }>();
  const refresh = new Map<string, { clientId: string; sub: string; scope: string }>();
  const devices = new Map<string, { userCode: string; clientId: string; approved: boolean; lastPoll: number; scope: string }>();
  const seenJti = new Set<string>();
  const clients = new Map<string, MockClient>();
  let issuer = '';
  const state: MockOidc = {
    issuer: '', clientId: 'eztest-server', clientSecret: 's3cret-client', user, tokenRequests: [], clientAuth: [],
    registerClient: (id, c) => void clients.set(id, c),
    approveDevice: (userCode) => {
      for (const d of devices.values()) if (d.userCode === userCode) {
        d.approved = true;
        return true;
      }
      return false;
    },
    claims: (jwt) => unb64(jwt.split('.')[1]),
    revokeRefreshTokens: () => refresh.clear(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  clients.set(state.clientId, { secret: state.clientSecret });
  const sign = (payload: Record<string, unknown>, t?: MockOidc['tamper']) => {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid });
    const body = b64(payload);
    const s = createSign('RSA-SHA256').update(`${head}.${body}`).sign(t === 'signature' ? other.privateKey : privateKey).toString('base64url');
    return `${head}.${body}.${s}`;
  };
  const accessToken = (clientId: string, sub: string, scope: string) => {
    const now = Math.floor(Date.now() / 1000);
    return sign({ iss: issuer, aud: opts.audience ?? clientId, sub, client_id: clientId, scope, iat: now, exp: now + (opts.accessTokenTtl ?? 300), jti: randomBytes(8).toString('hex') });
  };
  const issue = (clientId: string, sub: string, scope: string, withRefresh: boolean, extra: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = { access_token: accessToken(clientId, sub, scope), token_type: 'Bearer', expires_in: opts.accessTokenTtl ?? 300, ...(scope ? { scope } : {}), ...extra };
    if (withRefresh) {
      const rt = randomBytes(16).toString('hex');
      refresh.set(rt, { clientId, sub, scope });
      out.refresh_token = rt;
    }
    return out;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const readForm = (cb: (f: Record<string, string>) => void) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => cb(Object.fromEntries(new URLSearchParams(body))));
    };
    /** The authenticated client id, or a reason. */
    const authenticate = (f: Record<string, string>): { id?: string; error?: string } => {
      const basic = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''));
      if (basic) {
        const [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map((x) => decodeURIComponent(x));
        state.clientAuth.push('client_secret_basic');
        return clients.get(id)?.secret !== undefined && clients.get(id)?.secret === secret ? { id } : { error: 'invalid_client' };
      }
      if (f.client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' && f.client_assertion) {
        state.clientAuth.push('private_key_jwt');
        let claims: Record<string, unknown>;
        try {
          claims = unb64(f.client_assertion.split('.')[1]);
        } catch {
          return { error: 'invalid_client' };
        }
        const id = String(claims.iss ?? '');
        const c = clients.get(id);
        if (!c?.publicKey) return { error: 'invalid_client' };
        const key = typeof c.publicKey === 'string' ? createPublicKey(c.publicKey) : c.publicKey;
        const v = verifyJwt(f.client_assertion, key);
        if (!v || v.sub !== id || (f.client_id && f.client_id !== id)) return { error: 'invalid_client' };
        const aud = Array.isArray(v.aud) ? v.aud : [v.aud];
        if (!aud.includes(`${issuer}/token`) && !aud.includes(issuer)) return { error: 'invalid_client' };
        if (typeof v.exp !== 'number' || v.exp < Date.now() / 1000) return { error: 'invalid_client' };
        if (!v.jti || seenJti.has(String(v.jti))) return { error: 'invalid_client' };
        seenJti.add(String(v.jti));
        return { id };
      }
      if (f.client_id) {
        state.clientAuth.push(f.client_secret !== undefined ? 'client_secret_post' : 'none');
        const c = clients.get(f.client_id);
        if (!c) return { error: 'invalid_client' };
        if (c.secret !== undefined && c.secret !== f.client_secret) return { error: 'invalid_client' };
        return { id: f.client_id };
      }
      return { error: 'invalid_client' };
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        device_authorization_endpoint: `${issuer}/device_authorization`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'client_credentials', 'password', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const p = url.searchParams;
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('state') || (!opts.loginForm && !p.get('nonce'))) return json(400, { error: 'invalid_request' });
      if (!clients.has(p.get('client_id') ?? '')) return json(400, { error: 'unauthorized_client' });
      if (opts.loginForm) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in to the test IdP</h1>
<form method="post" action="/login"><input type="hidden" name="q" value="${encodeURIComponent(url.search)}">
<label for="u">Username</label> <input id="u" name="username" autocomplete="username">
<label for="p">Password</label> <input id="p" name="password" type="password">
<button type="submit">Sign in</button></form></body></html>`);
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { challenge: p.get('code_challenge')!, nonce: p.get('nonce') ?? '', redirect: p.get('redirect_uri')!, clientId: p.get('client_id')!, scope: p.get('scope') ?? '', sub: state.user.sub });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      return readForm((f) => {
        const p = new URLSearchParams(decodeURIComponent(f.q ?? ''));
        if (!opts.loginForm || f.username !== opts.loginForm.username || f.password !== opts.loginForm.password) {
          res.writeHead(401, { 'content-type': 'text/html' });
          res.end('<!doctype html><p role="alert" class="error">Wrong username or password</p>');
          return;
        }
        const code = randomBytes(16).toString('hex');
        codes.set(code, { challenge: p.get('code_challenge')!, nonce: p.get('nonce') ?? '', redirect: p.get('redirect_uri')!, clientId: p.get('client_id')!, scope: p.get('scope') ?? '', sub: f.username });
        const back = new URL(p.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', p.get('state')!);
        res.writeHead(302, { location: back.toString() });
        res.end();
      });
    }
    // The verification page: a sign-in form (loginForm credentials) that approves the user code.
    if (url.pathname === '/device' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head><title>Activate device</title></head><body><h1>Activate your device</h1>
<form method="post" action="/device/approve">
<label for="c">Code</label> <input id="c" name="user_code" value="${(url.searchParams.get('user_code') ?? '').replace(/[^\w-]/g, '')}">
<label for="u">Username</label> <input id="u" name="username" autocomplete="username">
<label for="p">Password</label> <input id="p" name="password" type="password">
<button type="submit">Sign in and approve</button></form></body></html>`);
    }
    if (url.pathname === '/device/approve' && req.method === 'POST') {
      return readForm((f) => {
        const ok = opts.loginForm && f.username === opts.loginForm.username && f.password === opts.loginForm.password && state.approveDevice(f.user_code);
        res.writeHead(ok ? 200 : 401, { 'content-type': 'text/html' });
        res.end(ok ? '<!doctype html><p>Device approved. You can close this window.</p>' : '<!doctype html><p role="alert" class="error">Wrong code, username or password</p>');
      });
    }
    if (url.pathname === '/device_authorization' && req.method === 'POST') {
      return readForm((f) => {
        const a = authenticate(f);
        if (!a.id) return json(401, { error: 'invalid_client' });
        const deviceCode = randomBytes(16).toString('hex');
        const userCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
        devices.set(deviceCode, { userCode, clientId: a.id, approved: false, lastPoll: 0, scope: f.scope ?? '' });
        json(200, { device_code: deviceCode, user_code: userCode, verification_uri: `${issuer}/device`, verification_uri_complete: `${issuer}/device?user_code=${userCode}`, expires_in: 600, interval: opts.deviceInterval ?? 1 });
      });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      return readForm((f) => {
        state.tokenRequests.push(f);
        const a = authenticate(f);
        const grant = f.grant_type;
        if (grant === 'authorization_code') {
          if (!a.id) return json(401, { error: 'invalid_client' });
          const c = codes.get(f.code);
          codes.delete(f.code);
          if (!c || f.redirect_uri !== c.redirect || c.clientId !== a.id) return json(400, { error: 'invalid_grant' });
          const challenge = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
          if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          const now = Math.floor(Date.now() / 1000);
          const t = state.tamper;
          state.tamper = undefined;
          const sub = opts.loginForm ? c.sub : state.user.sub;
          const id = sign({
            iss: t === 'issuer' ? 'https://evil.example' : issuer, aud: t === 'audience' ? 'someone-else' : c.clientId, sub, email: state.user.email, name: state.user.name,
            groups: state.user.groups ?? [], nonce: t === 'nonce' ? 'wrong' : c.nonce, iat: now, exp: t === 'expired' ? now - 3600 : now + 300,
          }, t);
          // The original behaviour (an opaque access token) is kept for the results-server tests.
          if (!opts.loginForm) return json(200, { access_token: randomBytes(8).toString('hex'), token_type: 'Bearer', id_token: id, expires_in: 300 });
          return json(200, issue(c.clientId, sub, c.scope, true, { id_token: id }));
        }
        if (grant === 'client_credentials') {
          if (!a.id) return json(401, { error: 'invalid_client' });
          return json(200, issue(a.id, a.id, f.scope ?? '', false));
        }
        if (grant === 'password') {
          if (!a.id) return json(401, { error: 'invalid_client' });
          if (!opts.users || opts.users[f.username] === undefined || opts.users[f.username] !== f.password) return json(400, { error: 'invalid_grant', error_description: 'wrong username or password' });
          return json(200, issue(a.id, f.username, f.scope ?? '', true));
        }
        if (grant === 'refresh_token') {
          if (!a.id) return json(401, { error: 'invalid_client' });
          const r = refresh.get(f.refresh_token);
          if (!r || r.clientId !== a.id) return json(400, { error: 'invalid_grant', error_description: 'refresh token is not valid' });
          refresh.delete(f.refresh_token); // rotation: each refresh token works once
          return json(200, issue(a.id, r.sub, r.scope, true));
        }
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (!a.id) return json(401, { error: 'invalid_client' });
          const d = devices.get(f.device_code);
          if (!d || d.clientId !== a.id) return json(400, { error: 'invalid_grant' });
          const now = Date.now();
          const tooSoon = d.lastPoll && now - d.lastPoll < (opts.deviceInterval ?? 1) * 1000 - 50;
          d.lastPoll = now;
          if (!d.approved) return json(400, { error: tooSoon ? 'slow_down' : 'authorization_pending' });
          devices.delete(f.device_code);
          return json(200, issue(a.id, `device-user:${d.userCode}`, d.scope, true));
        }
        if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          let claims: Record<string, unknown> | undefined;
          try {
            claims = unb64(String(f.assertion ?? '').split('.')[1] ?? '');
          } catch {
            claims = undefined;
          }
          const c = claims ? clients.get(String(claims.iss)) : undefined;
          const key = c?.publicKey ? (typeof c.publicKey === 'string' ? createPublicKey(c.publicKey) : c.publicKey) : undefined;
          const v = key ? verifyJwt(String(f.assertion), key) : undefined;
          const aud = v ? (Array.isArray(v.aud) ? v.aud : [v.aud]) : [];
          if (!v || !aud.some((x) => x === `${issuer}/token` || x === issuer) || typeof v.exp !== 'number' || v.exp < Date.now() / 1000 || !v.sub) return json(400, { error: 'invalid_grant', error_description: 'assertion rejected' });
          return json(200, issue(String(v.iss), String(v.sub), f.scope ?? '', false));
        }
        json(400, { error: 'unsupported_grant_type' });
      });
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.issuer = issuer;
  return state;
}
