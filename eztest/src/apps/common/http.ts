/**
 * Authentication and HTTP for the packaged-app API clients. Credentials are
 * config values that may be `secret://store/key` references or ENC(...); they
 * are resolved through a SecretRegistry only when a request needs them and are
 * registered with the masker, so tokens and passwords never reach errors,
 * logs or evidence.
 *
 *   auth: { type: basic, username: svc_eztest, password: secret://vault/sn }
 *   auth: { type: oauth2, tokenUrl: https://.../oauth_token.do, clientId: ..., clientSecret: secret://vault/x }
 *   auth: { type: oauth2, grant: refresh_token, refreshToken: secret://vault/wd-refresh, ... }   # Workday API clients
 *   auth: { type: oauth2, grant: password, username: ..., password: secret://... }               # ServiceNow password grant
 */
import { z } from 'zod';
import { EzTestError } from '../../core/index.js';
import { defaultMasker, type SecretMasker } from '../../config/index.js';
import { SecretRegistry, isSecretRef, type SecretHandle } from '../../identity/handle.js';
import { OAuth2TokenProvider } from '../../identity/oauth.js';
import { ApiClient, type ApiResponse, type RequestOptions } from '../../surfaces/index.js';
import { reveal } from './kit.js';

export const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('basic'), username: z.string().min(1), password: z.string().min(1) }),
  z.object({
    type: z.literal('oauth2'),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    grant: z.enum(['client_credentials', 'refresh_token', 'password']).default('client_credentials'),
    refreshToken: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    scope: z.string().optional(),
    /** client_secret_basic instead of form fields. */
    authMethod: z.enum(['body', 'basic']).default('body'),
  }),
]);
export type AuthConfig = z.infer<typeof AuthSchema>;
export type AuthConfigInput = z.input<typeof AuthSchema>;

/** A role used by "Log in to <pack> as <role>" and the permission matrix. */
export const RoleUserSchema = z.object({
  /** Plain username or secret://ref. */
  username: z.string().min(1),
  /** secret://store/key (recommended), ENC(...), or a literal (tests only). */
  password: z.string().min(1),
});
export type RoleUser = z.infer<typeof RoleUserSchema>;

/** Produces the Authorization header for a request; `invalidate` after a 401. */
export interface AuthHeader {
  header(): Promise<string>;
  invalidate(): void;
}

class PasswordGrantProvider {
  private cached?: { token: string; exp: number };
  private inflight?: Promise<string>;
  constructor(
    private readonly o: { tokenUrl: string; clientId: string; clientSecret?: SecretHandle; username: SecretHandle | string; password: SecretHandle; scope?: string; fetch?: typeof fetch; masker: SecretMasker },
  ) {}
  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.exp) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => (this.inflight = undefined));
    return this.inflight;
  }
  invalidate(): void {
    this.cached = undefined;
  }
  private async fetchToken(): Promise<string> {
    const p = new URLSearchParams({ grant_type: 'password', client_id: this.o.clientId });
    const secret = this.o.clientSecret ? await this.o.clientSecret.resolve() : undefined;
    if (secret) p.set('client_secret', secret);
    p.set('username', typeof this.o.username === 'string' ? this.o.username : await this.o.username.resolve());
    p.set('password', await this.o.password.resolve());
    if (this.o.scope) p.set('scope', this.o.scope);
    const res = await (this.o.fetch ?? fetch)(this.o.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: p.toString() });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new EzTestError(this.o.masker.mask(`Token request failed (HTTP ${res.status}) ${String(body.error ?? 'no access_token')}${body.error_description ? `: ${String(body.error_description)}` : ''}`), 'OAUTH_TOKEN');
    }
    this.o.masker.add(body.access_token);
    const ttl = Number(body.expires_in ?? 1800);
    this.cached = { token: body.access_token, exp: Date.now() + Math.max(30, ttl - 60) * 1000 };
    return body.access_token;
  }
}

/** Build an AuthHeader from a config block; secrets resolve lazily through `registry`. */
export function createAuthHeader(cfg: AuthConfig, registry: SecretRegistry, label: string, o: { fetch?: typeof fetch } = {}): AuthHeader {
  const masker = registry.masker ?? defaultMasker;
  if (cfg.type === 'basic') {
    const user = isSecretRef(cfg.username) ? registry.handle(cfg.username) : cfg.username;
    const pass = registry.from(cfg.password, `${label}.password`);
    return {
      async header() {
        const u = typeof user === 'string' ? user : await user.resolve();
        const pw = await pass.resolve();
        const h = 'Basic ' + Buffer.from(`${u}:${pw}`).toString('base64');
        masker.add(h.slice(6));
        return h;
      },
      invalidate() {},
    };
  }
  const secret = cfg.clientSecret ? registry.from(cfg.clientSecret, `${label}.clientSecret`) : undefined;
  if (cfg.grant === 'password') {
    if (!cfg.username || !cfg.password) throw new EzTestError(`${label}.auth: the password grant needs username and password`, 'APP_CONFIG');
    const p = new PasswordGrantProvider({
      tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, clientSecret: secret, scope: cfg.scope, fetch: o.fetch, masker,
      username: isSecretRef(cfg.username) ? registry.handle(cfg.username) : cfg.username, password: registry.from(cfg.password, `${label}.password`),
    });
    return { header: async () => `Bearer ${await p.getToken()}`, invalidate: () => p.invalidate() };
  }
  if (cfg.grant === 'refresh_token' && !cfg.refreshToken) throw new EzTestError(`${label}.auth: the refresh_token grant needs refreshToken`, 'APP_CONFIG');
  const p = new OAuth2TokenProvider({
    tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, clientSecret: secret, grant: cfg.grant,
    refreshToken: cfg.refreshToken ? registry.from(cfg.refreshToken, `${label}.refreshToken`) : undefined,
    scope: cfg.scope, authMethod: cfg.authMethod, fetch: o.fetch, masker, defaultTtlSeconds: 1800,
  });
  return { header: async () => `Bearer ${await p.getToken()}`, invalidate: () => p.invalidate() };
}

/** Basic auth for a role user (permission matrix / describe-as-user). */
export function roleAuthHeader(u: RoleUser, registry: SecretRegistry, label: string): AuthHeader {
  return createAuthHeader({ type: 'basic', username: u.username, password: u.password }, registry, label);
}

export class AppApiError extends EzTestError {
  constructor(message: string, readonly status: number, code = 'APP_API_ERROR', readonly body?: unknown) {
    super(message, code, { status });
    this.name = 'AppApiError';
  }
}

export interface AppHttpOptions {
  baseUrl: string;
  auth: AuthHeader;
  /** Product name for error messages, e.g. "ServiceNow". */
  product: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  masker?: SecretMasker;
  /** Pull a readable message out of an error body. */
  errorMessage?: (body: unknown, res: ApiResponse) => string | undefined;
}

/** JSON/XML HTTP with lazy auth, one re-auth on 401, and masked error messages. */
export class AppHttp {
  readonly api: ApiClient;
  /** Requests sent (diagnostics/tests). */
  requests = 0;
  constructor(readonly o: AppHttpOptions) {
    this.api = new ApiClient({ baseUrl: o.baseUrl.replace(/\/*$/, '/'), headers: { accept: 'application/json', ...(o.headers ?? {}) }, timeoutMs: o.timeoutMs ?? 30_000, retry: false, fetch: o.fetch });
  }

  async request(method: string, path: string, r: Omit<RequestOptions, 'auth'> & { okStatuses?: number[] } = {}): Promise<ApiResponse> {
    const send = async () => {
      this.requests++;
      return this.api.request(method, path.replace(/^\/+/, ''), { ...r, auth: false, headers: { authorization: await this.o.auth.header(), ...(r.headers ?? {}) } });
    };
    let res = await send();
    if (res.status === 401) {
      this.o.auth.invalidate();
      res = await send();
    }
    if (!res.ok && !(r.okStatuses ?? []).includes(res.status)) {
      const masker = this.o.masker ?? defaultMasker;
      const msg = this.o.errorMessage?.(res.body, res) ?? (typeof res.body === 'string' ? res.body.slice(0, 300) : res.statusText);
      throw new AppApiError(masker.mask(`${this.o.product} ${method} ${path.split('?')[0]} failed (${res.status}): ${msg}`), res.status, 'APP_API_ERROR', res.body);
    }
    return res;
  }

  async json<T = unknown>(method: string, path: string, r: Omit<RequestOptions, 'auth'> & { okStatuses?: number[] } = {}): Promise<T> {
    return (await this.request(method, path, r)).body as T;
  }
}

/** Resolve a possibly-secret username. */
export async function usernameOf(u: RoleUser, registry: SecretRegistry): Promise<string> {
  return isSecretRef(u.username) ? registry.resolve(u.username) : u.username;
}

export function passwordHandle(u: RoleUser, registry: SecretRegistry, label: string): SecretHandle {
  return registry.from(u.password, label);
}

export { reveal };
