/**
 * OAuth 2.0 token provider for API steps and EZTest's own calls.
 *
 * Grants:
 *   client_credentials                 (RFC 6749 4.4)
 *   password                           resource-owner password (RFC 6749 4.3)
 *   refresh_token                      a configured refresh token (RFC 6749 6)
 *   authorization_code + PKCE (S256)   the browser signs in (src/identity/vault.ts drives
 *                                      EZTest's own browser as a role); RFC 7636
 *   device_code                        RFC 8628: polling with authorization_pending /
 *                                      slow_down, approval reported through a callback
 *   jwt_bearer                         RFC 7523 2.1: a signed assertion as the grant
 * Client authentication: client_secret_basic, client_secret_post,
 * private_key_jwt (RFC 7523 2.2, a signed client assertion) or none.
 *
 * Tokens are cached until expiry minus a skew; concurrent callers share one
 * request. A token response's refresh_token is used (and rotated) when the
 * access token expires; if the refresh is refused, the original grant runs
 * again.
 */
import { createHash, createPrivateKey, createSign, randomBytes, type KeyObject } from 'node:crypto';
import { EzTestError } from '../core/index.js';
import { defaultMasker, type SecretMasker } from '../config/index.js';
import type { TokenProvider } from '../surfaces/index.js';
import { envProxyFetch } from '../surfaces/proxy.js';
import type { SecretHandle } from './handle.js';

export type SecretInput = string | SecretHandle | (() => Promise<string>);

async function reveal(v: SecretInput | undefined): Promise<string | undefined> {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return v();
  return v.resolve();
}

export type OAuthGrant = 'client_credentials' | 'refresh_token' | 'password' | 'authorization_code' | 'device_code' | 'jwt_bearer';
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' | 'none';

/** A key EZTest signs JWTs with (client assertions, JWT-bearer grants). */
export interface JwtSigningKey {
  /** PEM private key (PKCS#8 or PKCS#1 / SEC1), or a secret reference resolving to one. */
  privateKey: SecretInput;
  /** RS256 (default for RSA keys), PS256 or ES256 (default for EC P-256 keys). */
  alg?: 'RS256' | 'PS256' | 'ES256';
  kid?: string;
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface OAuth2Options {
  tokenUrl: string;
  clientId: string;
  clientSecret?: SecretInput;
  grant?: OAuthGrant;
  refreshToken?: SecretInput;
  scope?: string;
  audience?: string;
  extraParams?: Record<string, string>;
  /** 'body' sends client_id/secret as form fields; 'basic' uses HTTP Basic (RFC 6749 2.3.1). Older names of clientAuth. */
  authMethod?: 'body' | 'basic';
  /** Client authentication (default client_secret_post, or client_secret_basic with authMethod 'basic'; none without a secret). */
  clientAuth?: ClientAuthMethod;
  /** private_key_jwt: the client's key. */
  clientKey?: JwtSigningKey;
  /** password grant */
  username?: SecretInput;
  password?: SecretInput;
  /** jwt_bearer grant: the assertion's key and claims (iss defaults to the client id, aud to the token URL). */
  assertion?: JwtSigningKey & { issuer?: string; subject: string; audience?: string; ttlSeconds?: number; claims?: Record<string, unknown> };
  /** device_code grant */
  deviceAuthorizationUrl?: string;
  /** Called with the user code when a device code is issued (show it, or approve it in a browser). */
  onDeviceCode?: (info: DeviceCodeInfo) => void | Promise<void>;
  /** authorization_code grant: the authorize URL and redirect URI, and how the browser signs in. */
  authorizationCode?: {
    authorizeUrl: string;
    redirectUri: string;
    /** Extra authorize parameters (prompt, login_hint, ...). */
    params?: Record<string, string>;
    /** Open `url` in a browser, sign in, and return the URL the browser was redirected to (redirect_uri?code=...&state=...). */
    signIn: (url: string, redirectUri: string) => Promise<string>;
  };
  /** Refresh this many seconds before expiry (default 60). */
  skewSeconds?: number;
  /** Lifetime to assume when the server sends no expires_in (default: do not cache). */
  defaultTtlSeconds?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  masker?: SecretMasker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
  idToken?: string;
  /** How the token was obtained (the grant, or "refresh_token" for a refresh). */
  grant?: string;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** Sign a JWT (compact JWS) with a PEM key: RS256, PS256 or ES256. */
export function signJwt(claims: Record<string, unknown>, key: KeyObject | string, o: { alg?: 'RS256' | 'PS256' | 'ES256'; kid?: string } = {}): string {
  const k = typeof key === 'string' ? createPrivateKey(key) : key;
  const alg = o.alg ?? (k.asymmetricKeyType === 'ec' ? 'ES256' : 'RS256');
  if (alg === 'ES256' && k.asymmetricKeyType !== 'ec') throw new EzTestError('ES256 needs an EC (P-256) key', 'OAUTH_CONFIG');
  if (alg !== 'ES256' && k.asymmetricKeyType !== 'rsa' && k.asymmetricKeyType !== 'rsa-pss') throw new EzTestError(`${alg} needs an RSA key`, 'OAUTH_CONFIG');
  const head = b64url(JSON.stringify({ alg, typ: 'JWT', ...(o.kid ? { kid: o.kid } : {}) }));
  const body = b64url(JSON.stringify(claims));
  const signer = createSign('SHA256').update(`${head}.${body}`);
  const sig = alg === 'ES256' ? signer.sign({ key: k, dsaEncoding: 'ieee-p1363' }) : alg === 'PS256' ? signer.sign({ key: k, padding: 6, saltLength: 32 }) : signer.sign(k);
  return `${head}.${body}.${b64url(sig)}`;
}

/** PKCE (RFC 7636): a verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export class OAuth2TokenProvider implements TokenProvider {
  private cached?: TokenResponse;
  private inflight?: Promise<TokenResponse>;
  private rotatedRefresh?: string;
  /** Number of token requests actually sent (for diagnostics/tests). */
  requests = 0;
  /** The grants used, in order (diagnostics/tests). */
  readonly history: string[] = [];
  private readonly masker: SecretMasker;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: OAuth2Options) {
    new URL(o.tokenUrl);
    if (!o.clientId) throw new EzTestError('OAuth2 clientId is required', 'OAUTH_CONFIG');
    const grant = o.grant ?? 'client_credentials';
    if (grant === 'refresh_token' && !o.refreshToken) throw new EzTestError('refresh_token grant needs a refreshToken', 'OAUTH_CONFIG');
    if (grant === 'password' && (o.username === undefined || o.password === undefined)) throw new EzTestError('password grant needs a username and a password', 'OAUTH_CONFIG');
    if (grant === 'jwt_bearer' && !o.assertion) throw new EzTestError('jwt_bearer grant needs an assertion key and subject', 'OAUTH_CONFIG');
    if (grant === 'device_code' && !o.deviceAuthorizationUrl) throw new EzTestError('device_code grant needs a deviceAuthorizationUrl', 'OAUTH_CONFIG');
    if (grant === 'authorization_code' && !o.authorizationCode) throw new EzTestError('authorization_code grant needs an authorize URL, a redirect URI and a browser sign-in', 'OAUTH_CONFIG');
    if (o.clientAuth === 'private_key_jwt' && !o.clientKey) throw new EzTestError('private_key_jwt client authentication needs a clientKey', 'OAUTH_CONFIG');
    this.masker = o.masker ?? defaultMasker;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private fresh(t: TokenResponse | undefined): t is TokenResponse {
    if (!t || t.expiresAt === undefined) return false;
    return this.now() < t.expiresAt - (this.o.skewSeconds ?? 60) * 1000;
  }

  async getToken(): Promise<string> {
    return (await this.getTokenResponse()).accessToken;
  }

  async getTokenResponse(): Promise<TokenResponse> {
    if (this.fresh(this.cached)) return this.cached;
    if (!this.inflight) {
      this.inflight = this.obtain().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** A refresh with the last refresh token when there is one, else the configured grant. */
  private async obtain(): Promise<TokenResponse> {
    const grant = this.o.grant ?? 'client_credentials';
    if (this.rotatedRefresh && grant !== 'refresh_token') {
      try {
        return await this.request({ grant_type: 'refresh_token', refresh_token: this.rotatedRefresh }, 'refresh_token');
      } catch (e) {
        // A refused refresh (expired, revoked, rotated elsewhere): sign in again with the grant.
        if (!(e instanceof EzTestError && e.code === 'OAUTH_TOKEN')) throw e;
        this.rotatedRefresh = undefined;
      }
    }
    return this.fetchToken();
  }

  private async clientAuth(params: URLSearchParams, headers: Record<string, string>): Promise<void> {
    const secret = await reveal(this.o.clientSecret);
    if (secret) this.masker.add(secret);
    const method: ClientAuthMethod = this.o.clientAuth ?? (this.o.authMethod === 'basic' ? 'client_secret_basic' : secret ? 'client_secret_post' : 'none');
    if (method === 'client_secret_basic') {
      headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(secret ?? '')}`).toString('base64');
      return;
    }
    params.set('client_id', this.o.clientId);
    if (method === 'client_secret_post') {
      if (secret) params.set('client_secret', secret);
      return;
    }
    if (method === 'private_key_jwt') {
      const k = this.o.clientKey!;
      const pem = await reveal(k.privateKey);
      if (!pem) throw new EzTestError('private_key_jwt: the client key is empty', 'OAUTH_CONFIG');
      const now = Math.floor(this.now() / 1000);
      params.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      params.set('client_assertion', signJwt({ iss: this.o.clientId, sub: this.o.clientId, aud: this.o.tokenUrl, jti: randomBytes(16).toString('hex'), iat: now, exp: now + 120 }, pem, { alg: k.alg, kid: k.kid }));
    }
  }

  private async fetchToken(): Promise<TokenResponse> {
    const grant = this.o.grant ?? 'client_credentials';
    switch (grant) {
      case 'client_credentials':
        return this.request({ grant_type: 'client_credentials' }, grant);
      case 'refresh_token': {
        const rt = this.rotatedRefresh ?? (await reveal(this.o.refreshToken));
        if (!rt) throw new EzTestError('No refresh token available', 'OAUTH_CONFIG');
        this.masker.add(rt);
        return this.request({ grant_type: 'refresh_token', refresh_token: rt }, grant);
      }
      case 'password': {
        const username = (await reveal(this.o.username)) ?? '';
        const password = (await reveal(this.o.password)) ?? '';
        this.masker.add(password);
        return this.request({ grant_type: 'password', username, password }, grant);
      }
      case 'jwt_bearer': {
        const a = this.o.assertion!;
        const pem = await reveal(a.privateKey);
        if (!pem) throw new EzTestError('jwt_bearer: the assertion key is empty', 'OAUTH_CONFIG');
        const now = Math.floor(this.now() / 1000);
        const assertion = signJwt({ ...(a.claims ?? {}), iss: a.issuer ?? this.o.clientId, sub: a.subject, aud: a.audience ?? this.o.tokenUrl, jti: randomBytes(16).toString('hex'), iat: now, exp: now + (a.ttlSeconds ?? 300) }, pem, { alg: a.alg, kid: a.kid });
        return this.request({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }, grant, { clientAuth: !!(this.o.clientSecret || this.o.clientKey) });
      }
      case 'device_code':
        return this.deviceFlow();
      case 'authorization_code':
        return this.authorizationCodeFlow();
    }
  }

  private async deviceFlow(): Promise<TokenResponse> {
    const params = new URLSearchParams();
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    await this.clientAuth(params, headers);
    if (!params.has('client_id')) params.set('client_id', this.o.clientId);
    if (this.o.scope) params.set('scope', this.o.scope);
    if (this.o.audience) params.set('audience', this.o.audience);
    const { res, body } = await this.post(this.o.deviceAuthorizationUrl!, headers, params, 'Device authorization');
    if (!res.ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
      throw new EzTestError(this.masker.mask(`Device authorization failed (HTTP ${res.status}) ${String(body.error ?? 'no device_code in response')}${typeof body.error_description === 'string' ? `: ${body.error_description}` : ''}`), 'OAUTH_TOKEN', { status: res.status });
    }
    const deviceCode = body.device_code;
    this.masker.add(deviceCode);
    let interval = Math.max(1, Number(body.interval ?? 5));
    const expiresIn = Number(body.expires_in ?? 600);
    const info: DeviceCodeInfo = {
      userCode: body.user_code, verificationUri: String(body.verification_uri ?? body.verification_url ?? ''),
      ...(typeof body.verification_uri_complete === 'string' ? { verificationUriComplete: body.verification_uri_complete } : {}), expiresIn, interval,
    };
    if (!this.o.onDeviceCode) throw new EzTestError(`Device code ${info.userCode}: open ${info.verificationUri} and enter it (no approver is configured for this role)`, 'OAUTH_DEVICE');
    const approval = Promise.resolve(this.o.onDeviceCode(info));
    let approvalError: unknown;
    approval.catch((e) => (approvalError = e));
    const deadline = this.now() + expiresIn * 1000;
    for (;;) {
      await this.sleep(interval * 1000);
      if (approvalError) throw approvalError;
      try {
        return await this.request({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }, 'device_code');
      } catch (e) {
        const err = (e as EzTestError).details?.error;
        if (err === 'authorization_pending') {
          // keep polling
        } else if (err === 'slow_down') interval += 5; // RFC 8628 3.5
        else throw e;
      }
      if (this.now() > deadline) throw new EzTestError(`Device code ${info.userCode} was not approved within ${expiresIn} s`, 'OAUTH_DEVICE');
    }
  }

  private async authorizationCodeFlow(): Promise<TokenResponse> {
    const ac = this.o.authorizationCode!;
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const u = new URL(ac.authorizeUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.o.clientId);
    u.searchParams.set('redirect_uri', ac.redirectUri);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    if (this.o.scope) u.searchParams.set('scope', this.o.scope);
    if (this.o.audience) u.searchParams.set('audience', this.o.audience);
    for (const [k, v] of Object.entries(ac.params ?? {})) u.searchParams.set(k, v);
    const back = new URL(await ac.signIn(u.toString(), ac.redirectUri));
    if (back.searchParams.get('error')) throw new EzTestError(`Authorization failed: ${back.searchParams.get('error')}${back.searchParams.get('error_description') ? `: ${back.searchParams.get('error_description')}` : ''}`, 'OAUTH_AUTHORIZE');
    if (back.searchParams.get('state') !== state) throw new EzTestError('Authorization response state does not match the request (possible CSRF); no token requested', 'OAUTH_STATE');
    const code = back.searchParams.get('code');
    if (!code) throw new EzTestError('Authorization response has no code', 'OAUTH_AUTHORIZE');
    this.masker.add(code);
    return this.request({ grant_type: 'authorization_code', code, redirect_uri: ac.redirectUri, code_verifier: verifier }, 'authorization_code');
  }

  private async post(url: string, headers: Record<string, string>, params: URLSearchParams, what: string): Promise<{ res: Response; body: Record<string, unknown> }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30_000);
    let res: Response;
    let text: string;
    this.requests++;
    try {
      // The environment's proxy (HTTPS_PROXY / NO_PROXY) applies to token requests too.
      res = await (this.o.fetch ?? envProxyFetch)(url, { method: 'POST', headers, body: params.toString(), signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      throw new EzTestError(this.masker.mask(`${what} request to ${url} failed: ${(e as Error).message}`), 'OAUTH_NETWORK');
    } finally {
      clearTimeout(timer);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { res, body };
  }

  private async request(grantParams: Record<string, string>, label: string, o: { clientAuth?: boolean } = {}): Promise<TokenResponse> {
    const params = new URLSearchParams(grantParams);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (o.clientAuth !== false) await this.clientAuth(params, headers);
    if (this.o.scope && label !== 'authorization_code' && label !== 'refresh_token') params.set('scope', this.o.scope);
    if (this.o.audience && label !== 'refresh_token') params.set('audience', this.o.audience);
    for (const [k, v] of Object.entries(this.o.extraParams ?? {})) params.set(k, v);
    this.history.push(label);
    const { res, body } = await this.post(this.o.tokenUrl, headers, params, 'Token');
    if (!res.ok || typeof body.access_token !== 'string' || !body.access_token) {
      const err = typeof body.error === 'string' ? body.error : 'no access_token in response';
      const desc = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
      throw new EzTestError(this.masker.mask(`Token request failed (HTTP ${res.status}) ${err}${desc}`), 'OAUTH_TOKEN', { status: res.status, error: err });
    }
    const accessToken = body.access_token;
    this.masker.add(accessToken);
    if (typeof body.refresh_token === 'string') {
      this.rotatedRefresh = body.refresh_token;
      this.masker.add(body.refresh_token);
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : typeof body.expires_in === 'string' ? Number(body.expires_in) : this.o.defaultTtlSeconds;
    const t: TokenResponse = {
      accessToken,
      tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
      expiresAt: ttl !== undefined && Number.isFinite(ttl) ? this.now() + ttl * 1000 : undefined,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
      ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : {}),
      grant: label,
    };
    this.cached = t;
    return t;
  }
}

/** Microsoft Entra ID (Azure AD) client-credentials provider, e.g. for Key Vault. */
export function azureAdTokenProvider(o: {
  tenantId: string;
  clientId: string;
  clientSecret: SecretInput;
  scope?: string;
  authorityUrl?: string;
  fetch?: typeof fetch;
  masker?: SecretMasker;
}): OAuth2TokenProvider {
  if (!/^[A-Za-z0-9.-]+$/.test(o.tenantId)) throw new EzTestError('Invalid tenantId', 'OAUTH_CONFIG');
  const authority = (o.authorityUrl ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  return new OAuth2TokenProvider({
    tokenUrl: `${authority}/${o.tenantId}/oauth2/v2.0/token`,
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    scope: o.scope ?? 'https://vault.azure.net/.default',
    fetch: o.fetch,
    masker: o.masker,
  });
}
