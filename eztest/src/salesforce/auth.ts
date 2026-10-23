/**
 * Salesforce OAuth 2.0 token provider: username-password flow (per user role,
 * used for describe-as-user permission checks) and client-credentials flow
 * (integration user). Tokens are cached (Salesforce returns no expires_in, so
 * a session lifetime is assumed), refreshed single-flight, invalidated after a
 * 401, and registered with the secret masker. Secrets and tokens never appear
 * in error messages.
 */
import { EzTestError } from '../core/index.js';
import { defaultMasker, type SecretMasker } from '../config/index.js';
import type { SecretInput } from '../identity/oauth.js';
import type { TokenProvider } from '../surfaces/index.js';

export interface SalesforceTokenOptions {
  /** e.g. https://login.salesforce.com/services/oauth2/token (or My Domain). */
  tokenUrl: string;
  clientId: string;
  clientSecret: SecretInput;
  grant: 'password' | 'client_credentials';
  username?: string;
  password?: SecretInput;
  /** Assumed session lifetime (Salesforce sends no expires_in). Default 900s. */
  sessionSeconds?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  masker?: SecretMasker;
  now?: () => number;
}

async function reveal(v: SecretInput | undefined): Promise<string | undefined> {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return v();
  return v.resolve();
}

export class SalesforceAuthError extends EzTestError {
  constructor(message: string, readonly status?: number, readonly oauthError?: string) {
    super(message, 'SF_AUTH', { status, oauthError });
    this.name = 'SalesforceAuthError';
  }
}

export class SalesforceTokenProvider implements TokenProvider {
  private cached?: { token: string; instanceUrl?: string; expiresAt: number };
  private inflight?: Promise<string>;
  /** Token requests actually sent (diagnostics/tests). */
  requests = 0;
  /** instance_url returned with the last token. */
  instanceUrl?: string;
  private readonly masker: SecretMasker;
  private readonly now: () => number;

  constructor(private readonly o: SalesforceTokenOptions) {
    try {
      new URL(o.tokenUrl);
    } catch {
      throw new EzTestError(`Invalid Salesforce tokenUrl "${o.tokenUrl}"`, 'SF_CONFIG');
    }
    if (!o.clientId) throw new EzTestError('Salesforce OAuth needs a clientId (connected app consumer key)', 'SF_CONFIG');
    if (o.grant === 'password' && (!o.username || o.password === undefined)) {
      throw new EzTestError('Salesforce password flow needs username and password', 'SF_CONFIG');
    }
    this.masker = o.masker ?? defaultMasker;
    this.now = o.now ?? Date.now;
  }

  get username(): string | undefined {
    return this.o.username;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const params = new URLSearchParams({ grant_type: this.o.grant, client_id: this.o.clientId });
    const secret = await reveal(this.o.clientSecret);
    if (!secret) throw new EzTestError('Salesforce clientSecret is empty', 'SF_CONFIG');
    this.masker.add(secret);
    params.set('client_secret', secret);
    if (this.o.grant === 'password') {
      const pw = await reveal(this.o.password);
      if (!pw) throw new EzTestError(`Salesforce password for ${this.o.username} is empty`, 'SF_CONFIG');
      this.masker.add(pw);
      params.set('username', this.o.username!);
      params.set('password', pw);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30_000);
    const who = this.o.grant === 'password' ? ` for ${this.o.username}` : '';
    let res: Response;
    let text: string;
    this.requests++;
    try {
      res = await (this.o.fetch ?? fetch)(this.o.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: params.toString(),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      throw new SalesforceAuthError(this.masker.mask(`Salesforce token request${who} failed: ${(e as Error).message}`));
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
      const e = typeof body.error === 'string' ? body.error : 'no access_token in response';
      const d = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
      throw new SalesforceAuthError(this.masker.mask(`Salesforce token request${who} failed (HTTP ${res.status}) ${e}${d}`), res.status, typeof body.error === 'string' ? body.error : undefined);
    }
    const token = body.access_token;
    this.masker.add(token);
    this.instanceUrl = typeof body.instance_url === 'string' ? body.instance_url : undefined;
    this.cached = { token, instanceUrl: this.instanceUrl, expiresAt: this.now() + (this.o.sessionSeconds ?? 900) * 1000 };
    return token;
  }
}
