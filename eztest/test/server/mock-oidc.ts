/**
 * A small OpenID Connect provider for tests: discovery, authorize (signs the
 * configured user in at once), token (checks PKCE S256 and the client secret)
 * and JWKS. ID tokens are RS256-signed with a key generated per instance.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockUser {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
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
  close(): Promise<void>;
}

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export async function startMockOidc(user: MockUser): Promise<MockOidc> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(4).toString('hex');
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string; clientId: string }>();
  let issuer = '';
  const state: MockOidc = {
    issuer: '', clientId: 'eztest-server', clientSecret: 's3cret-client', user, tokenRequests: [],
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  const sign = (payload: Record<string, unknown>, t?: MockOidc['tamper']) => {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid });
    const body = b64(payload);
    const s = createSign('RSA-SHA256').update(`${head}.${body}`).sign(t === 'signature' ? other.privateKey : privateKey).toString('base64url');
    return `${head}.${body}.${s}`;
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('nonce') || !p.get('state')) return json(400, { error: 'invalid_request' });
      if (p.get('client_id') !== state.clientId) return json(400, { error: 'unauthorized_client' });
      const code = randomBytes(16).toString('hex');
      codes.set(code, { challenge: p.get('code_challenge')!, nonce: p.get('nonce')!, redirect: p.get('redirect_uri')!, clientId: p.get('client_id')! });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        state.tokenRequests.push(f);
        const auth = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        if (auth !== `${state.clientId}:${state.clientSecret}`) return json(401, { error: 'invalid_client' });
        const c = codes.get(f.code);
        codes.delete(f.code);
        if (!c || f.grant_type !== 'authorization_code' || f.redirect_uri !== c.redirect) return json(400, { error: 'invalid_grant' });
        const challenge = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
        if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const now = Math.floor(Date.now() / 1000);
        const t = state.tamper;
        state.tamper = undefined;
        const id = sign({
          iss: t === 'issuer' ? 'https://evil.example' : issuer, aud: t === 'audience' ? 'someone-else' : c.clientId, sub: state.user.sub, email: state.user.email, name: state.user.name,
          groups: state.user.groups ?? [], nonce: t === 'nonce' ? 'wrong' : c.nonce, iat: now, exp: t === 'expired' ? now - 3600 : now + 300,
        }, t);
        return json(200, { access_token: randomBytes(8).toString('hex'), token_type: 'Bearer', id_token: id, expires_in: 300 });
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.issuer = issuer;
  return state;
}
