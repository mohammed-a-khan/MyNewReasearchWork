/**
 * Generic OpenID Connect sign-in for people: authorization code flow with
 * PKCE (S256), `state` and `nonce`. The ID token is verified locally against
 * the provider's JWKS (RS256/PS256/ES256 via node:crypto), including issuer,
 * audience, expiry and nonce. No SDK dependency.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Confidential clients only; public clients rely on PKCE alone. */
  clientSecret?: string;
  /** Default "openid email profile". */
  scopes?: string;
  /** Claim holding group names (default "groups"). */
  groupsClaim?: string;
  /** Accepted clock skew in seconds (default 60). */
  clockSkewS?: number;
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

export interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  createdAt: number;
}

export interface IdClaims {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
  raw: Record<string, unknown>;
}

export class OidcError extends Error {}

const b64url = (b: Buffer) => b.toString('base64url');
export const pkceChallenge = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

type Fetch = typeof fetch;

export class OidcClient {
  private discovery?: Promise<OidcDiscovery>;
  private keys?: { at: number; byKid: Map<string, KeyObject>; all: KeyObject[] };
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    readonly cfg: OidcConfig,
    readonly redirectUri: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async get<T>(url: string): Promise<T> {
    const r = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new OidcError(`OIDC: GET ${url} returned ${r.status}`);
    return (await r.json()) as T;
  }

  discover(): Promise<OidcDiscovery> {
    this.discovery ??= this.get<OidcDiscovery>(`${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`).then((d) => {
      if (d.issuer.replace(/\/$/, '') !== this.cfg.issuer.replace(/\/$/, '')) throw new OidcError(`OIDC: discovery issuer ${d.issuer} does not match ${this.cfg.issuer}`);
      return d;
    });
    this.discovery.catch(() => (this.discovery = undefined));
    return this.discovery;
  }

  /** Start a login: the URL to redirect the browser to. `next` must be a local path. */
  async begin(next: string): Promise<{ url: string; state: string }> {
    const d = await this.discover();
    const now = Date.now();
    for (const [k, p] of this.pending) if (now - p.createdAt > 10 * 60_000) this.pending.delete(k);
    if (this.pending.size > 5000) throw new OidcError('Too many pending sign-ins; try again shortly');
    const login: PendingLogin = { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)), next: safeNext(next), createdAt: now };
    this.pending.set(login.state, login);
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('scope', this.cfg.scopes ?? 'openid email profile');
    u.searchParams.set('state', login.state);
    u.searchParams.set('nonce', login.nonce);
    u.searchParams.set('code_challenge', pkceChallenge(login.verifier));
    u.searchParams.set('code_challenge_method', 'S256');
    return { url: u.toString(), state: login.state };
  }

  /** Finish a login from the callback's `code` and `state`. Each state is single-use. */
  async complete(code: string, state: string): Promise<{ claims: IdClaims; next: string }> {
    const login = this.pending.get(state);
    this.pending.delete(state);
    if (!login || Date.now() - login.createdAt > 10 * 60_000) throw new OidcError('Unknown or expired sign-in state');
    const d = await this.discover();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: login.verifier, client_id: this.cfg.clientId });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.cfg.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')}`;
    const r = await this.fetchFn(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new OidcError(`Token endpoint returned ${r.status}`);
    const tokens = (await r.json()) as { id_token?: string };
    if (!tokens.id_token) throw new OidcError('Token response has no id_token');
    const claims = await this.verifyIdToken(tokens.id_token, login.nonce);
    return { claims, next: login.next };
  }

  private async jwks(force = false): Promise<NonNullable<OidcClient['keys']>> {
    if (this.keys && !force && Date.now() - this.keys.at < 10 * 60_000) return this.keys;
    const d = await this.discover();
    const set = await this.get<{ keys: Array<JsonWebKey & { kid?: string; use?: string }> }>(d.jwks_uri);
    const byKid = new Map<string, KeyObject>();
    const all: KeyObject[] = [];
    for (const k of set.keys ?? []) {
      if (k.use && k.use !== 'sig') continue;
      try {
        const ko = createPublicKey({ key: k, format: 'jwk' });
        all.push(ko);
        if (k.kid) byKid.set(k.kid, ko);
      } catch {
        // unsupported key type: skip
      }
    }
    this.keys = { at: Date.now(), byKid, all };
    return this.keys;
  }

  async verifyIdToken(jwt: string, nonce: string): Promise<IdClaims> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new OidcError('ID token is not a JWT');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const sig = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const alg = header.alg ?? '';
    if (!['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'].includes(alg)) throw new OidcError(`ID token algorithm "${alg}" is not accepted`);
    const hash = `sha${alg.slice(2)}`;
    const check = (key: KeyObject) =>
      alg.startsWith('RS')
        ? cryptoVerify(hash, data, key, sig)
        : alg.startsWith('PS')
          ? cryptoVerify(hash, data, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }, sig)
          : cryptoVerify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    let keys = await this.jwks();
    let candidates = header.kid ? [keys.byKid.get(header.kid)].filter((k): k is KeyObject => !!k) : keys.all;
    if (!candidates.length && header.kid) {
      keys = await this.jwks(true); // key rotation
      candidates = [keys.byKid.get(header.kid)].filter((k): k is KeyObject => !!k);
    }
    if (!candidates.some((k) => { try { return check(k); } catch { return false; } })) throw new OidcError('ID token signature is invalid');

    const skew = (this.cfg.clockSkewS ?? 60) * 1000;
    const now = Date.now();
    const iss = String(payload.iss ?? '').replace(/\/$/, '');
    if (iss !== this.cfg.issuer.replace(/\/$/, '')) throw new OidcError('ID token issuer mismatch');
    const aud = payload.aud;
    if (!(aud === this.cfg.clientId || (Array.isArray(aud) && aud.includes(this.cfg.clientId)))) throw new OidcError('ID token audience mismatch');
    if (Array.isArray(aud) && aud.length > 1 && payload.azp !== this.cfg.clientId) throw new OidcError('ID token authorized party mismatch');
    if (typeof payload.exp !== 'number' || payload.exp * 1000 + skew < now) throw new OidcError('ID token expired');
    if (typeof payload.iat === 'number' && payload.iat * 1000 - skew > now) throw new OidcError('ID token issued in the future');
    if (payload.nonce !== nonce) throw new OidcError('ID token nonce mismatch');
    if (typeof payload.sub !== 'string' || !payload.sub) throw new OidcError('ID token has no subject');
    const g = payload[this.cfg.groupsClaim ?? 'groups'];
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      groups: Array.isArray(g) ? g.map(String) : typeof g === 'string' ? [g] : [],
      raw: payload,
    };
  }
}

/** Only same-site relative paths are allowed as post-login destinations (no open redirects). */
export function safeNext(next: string | undefined | null): string {
  if (!next || typeof next !== 'string') return '/ui';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\r\n]/.test(next)) return '/ui';
  return next;
}
