/**
 * OAuth2 token provider: client_credentials and refresh_token grants, cached
 * until expiry minus a skew, with single-flight refresh (concurrent callers
 * share one token request).
 */
import { EzTestError } from '../core/index.js';
import { defaultMasker, type SecretMasker } from '../config/index.js';
import type { TokenProvider } from '../surfaces/index.js';
import type { SecretHandle } from './handle.js';

export type SecretInput = string | SecretHandle | (() => Promise<string>);

async function reveal(v: SecretInput | undefined): Promise<string | undefined> {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return v();
  return v.resolve();
}

export interface OAuth2Options {
  tokenUrl: string;
  clientId: string;
  clientSecret?: SecretInput;
  grant?: 'client_credentials' | 'refresh_token';
  refreshToken?: SecretInput;
  scope?: string;
  audience?: string;
  extraParams?: Record<string, string>;
  /** 'body' sends client_id/secret as form fields; 'basic' uses HTTP Basic (RFC 6749 2.3.1). */
  authMethod?: 'body' | 'basic';
  /** Refresh this many seconds before expiry (default 60). */
  skewSeconds?: number;
  /** Lifetime to assume when the server sends no expires_in (default: do not cache). */
  defaultTtlSeconds?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  masker?: SecretMasker;
  now?: () => number;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
}

export class OAuth2TokenProvider implements TokenProvider {
  private cached?: TokenResponse;
  private inflight?: Promise<TokenResponse>;
  private rotatedRefresh?: string;
  /** Number of token requests actually sent (for diagnostics/tests). */
  requests = 0;
  private readonly masker: SecretMasker;
  private readonly now: () => number;

  constructor(private readonly o: OAuth2Options) {
    new URL(o.tokenUrl);
    if (!o.clientId) throw new EzTestError('OAuth2 clientId is required', 'OAUTH_CONFIG');
    if ((o.grant ?? 'client_credentials') === 'refresh_token' && !o.refreshToken) {
      throw new EzTestError('refresh_token grant needs a refreshToken', 'OAUTH_CONFIG');
    }
    this.masker = o.masker ?? defaultMasker;
    this.now = o.now ?? Date.now;
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
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<TokenResponse> {
    const grant = this.o.grant ?? 'client_credentials';
    const params = new URLSearchParams({ grant_type: grant });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const secret = await reveal(this.o.clientSecret);
    if (secret) this.masker.add(secret);
    if ((this.o.authMethod ?? 'body') === 'basic') {
      headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(secret ?? '')}`).toString('base64');
    } else {
      params.set('client_id', this.o.clientId);
      if (secret) params.set('client_secret', secret);
    }
    if (grant === 'refresh_token') {
      const rt = this.rotatedRefresh ?? (await reveal(this.o.refreshToken));
      if (!rt) throw new EzTestError('No refresh token available', 'OAUTH_CONFIG');
      this.masker.add(rt);
      params.set('refresh_token', rt);
    }
    if (this.o.scope) params.set('scope', this.o.scope);
    if (this.o.audience) params.set('audience', this.o.audience);
    for (const [k, v] of Object.entries(this.o.extraParams ?? {})) params.set(k, v);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30_000);
    let res: Response;
    let text: string;
    this.requests++;
    try {
      res = await (this.o.fetch ?? fetch)(this.o.tokenUrl, { method: 'POST', headers, body: params.toString(), signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      throw new EzTestError(this.masker.mask(`Token request to ${this.o.tokenUrl} failed: ${(e as Error).message}`), 'OAUTH_NETWORK');
    } finally {
      clearTimeout(timer);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!res.ok || typeof body.access_token !== 'string' || !body.access_token) {
      const err = typeof body.error === 'string' ? body.error : 'no access_token in response';
      const desc = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
      throw new EzTestError(this.masker.mask(`Token request failed (HTTP ${res.status}) ${err}${desc}`), 'OAUTH_TOKEN', { status: res.status });
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
