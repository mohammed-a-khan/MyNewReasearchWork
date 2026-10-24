/**
 * Identity Vault: role-based credentials (as secret handles), browser form
 * login with TOTP, session caching (storageState per role + environment with a
 * max age) and API tokens per role.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, silentLogger, sleep, slugify, type Logger } from '../core/index.js';
import type { TokenProvider } from '../surfaces/index.js';
import { SecretHandle, SecretRegistry, isSecretRef } from './handle.js';
import { OAuth2TokenProvider } from './oauth.js';
import { freshTotp, type TotpAlgorithm } from './totp.js';

export interface RoleFields {
  /** Label text or selector. */
  username?: string;
  password?: string;
  totp?: string;
  submit?: string;
  totpSubmit?: string;
}

/** Login recipe of a role: the generic form login (default) or Microsoft Entra ID. */
export type RoleLogin =
  | { type: 'form' }
  | { type: 'entra'; tenantHint?: string; staySignedIn?: boolean; promptLogin?: boolean };

export interface RoleDefinition {
  /** Plain username, secret://ref, or handle. Plain usernames are not treated as secrets. Absent for an API-only role. */
  username?: string | SecretHandle;
  /** secret://ref, ENC(...), or handle. A plain string is wrapped as an inline secret. Absent for an API-only role. */
  password?: string | SecretHandle;
  /** Base32 TOTP seed: secret://ref, ENC(...), or handle. */
  totp?: string | SecretHandle;
  /** Where the browser signs in. Absent for an API-only role (only `api`). */
  loginUrl?: string;
  flow?: 'form';
  /** Login recipe (default: form). */
  login?: RoleLogin;
  fields?: RoleFields;
  /** Substring of the URL that proves login succeeded (or /regex/). */
  successUrl?: string;
  /** URL to open when reusing a cached session to confirm it is still valid. */
  verifyUrl?: string;
  /**
   * Buttons that answer an identity provider's pages between the credentials and the app (terms of use, notices):
   * default Accept, I accept, I agree, Agree, Continue. `[]` presses nothing.
   */
  interstitials?: string[];
  totpOptions?: { digits?: number; algorithm?: TotpAlgorithm; step?: number };
  /** API access for this role: an OAuth2 client config or any TokenProvider. */
  api?: RoleApi | TokenProvider;
}

/** OAuth 2.0 for a role's API calls (docs/api-contracts.md, "OAuth for API steps"). */
export interface RoleApi {
  tokenUrl: string;
  clientId: string;
  /** Not needed with clientAuth private_key_jwt or none (public clients). */
  clientSecret?: string | SecretHandle;
  scope?: string;
  audience?: string;
  /**
   * client_credentials (default); password (the role's username and password); authorization_code
   * (PKCE, EZTest's browser signs in as the role); device_code (approved in the browser as the
   * role); jwt_bearer (a signed assertion); refresh_token (a stored refresh token).
   */
  grant?: 'client_credentials' | 'password' | 'authorization_code' | 'device_code' | 'jwt_bearer' | 'refresh_token';
  clientAuth?: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' | 'none';
  /** private_key_jwt: the client's PEM key (secret reference), alg and kid. */
  clientKey?: { privateKey: string | SecretHandle; alg?: 'RS256' | 'PS256' | 'ES256'; kid?: string };
  /** jwt_bearer: the assertion key and claims. */
  assertion?: { privateKey: string | SecretHandle; subject: string; issuer?: string; audience?: string; alg?: 'RS256' | 'PS256' | 'ES256'; kid?: string };
  authorizeUrl?: string;
  redirectUri?: string;
  deviceAuthorizationUrl?: string;
  refreshToken?: string | SecretHandle;
  /** Refresh this many seconds before expiry (default 60). */
  skewSeconds?: number;
}

export interface IdentityVaultOptions {
  roles: Record<string, RoleDefinition>;
  registry?: SecretRegistry;
  environment?: string;
  sessionDir?: string;
  /** Max age of a cached session (default 30 min). */
  sessionMaxAgeMs?: number;
  baseUrl?: string;
  /** Per-step login timeout (default 15s). */
  timeoutMs?: number;
  logger?: Logger;
  /** Browser for OAuth sign-ins (authorization code, device approval); default: EZTest's headless Chromium. */
  launchBrowser?: () => Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
}

export interface LoginOutcome {
  role: string;
  /** True when a cached session was applied and no UI login happened. */
  reused: boolean;
  url: string;
  sessionFile?: string;
}

interface ResolvedRole {
  username: string | SecretHandle;
  password: SecretHandle;
  totp?: SecretHandle;
  def: RoleDefinition & { loginUrl: string };
}

/** Buttons an identity provider's in-between pages (terms, notices) are answered with by default. */
export const DEFAULT_INTERSTITIALS = ['Accept', 'I accept', 'I agree', 'Agree', 'Continue'];

/** Buttons near a sign-in form that are never its submit button. */
const NOT_SUBMIT = /restart|reset|forgot|cancel|back|sign ?up|register|create (an )?account|try another|another way|(show|hide) password/i;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SELECTOR_RE = /^(css=|xpath=|text=|role=|id=|data-testid=|internal:|\/\/|#|\.|\[)|^[a-z][a-z0-9-]*[#.[:]/i;

/**
 * `/regex/flags` is a pattern; anything else is a substring of the URL. Only valid RegExp flags
 * make a pattern, so a plain path like "/app/home" or "/portal/dashboard" stays a path.
 */
export function successMatches(url: string, spec: string): boolean {
  const m = /^\/(.+)\/([dgimsuyv]*)$/.exec(spec);
  if (m) {
    try {
      return new RegExp(m[1], m[2]).test(url);
    } catch {
      throw new EzTestError(`Invalid successUrl pattern ${spec}`, 'IDENTITY_CONFIG');
    }
  }
  return url.includes(spec);
}

export class IdentityVault {
  readonly environment: string;
  readonly sessionDir: string;
  readonly registry: SecretRegistry;
  private readonly roles = new Map<string, ResolvedRole>();
  /** Roles with only API credentials (`api:`): usable on API steps, never for a browser sign-in. */
  private readonly apiOnly = new Set<string>();
  private readonly tokens = new Map<string, TokenProvider>();
  private readonly maxAgeMs: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(private readonly o: IdentityVaultOptions) {
    this.environment = o.environment ?? 'default';
    this.sessionDir = resolve(o.sessionDir ?? '.eztest/sessions');
    this.registry = o.registry ?? new SecretRegistry();
    this.maxAgeMs = o.sessionMaxAgeMs ?? 30 * 60_000;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.logger = o.logger ?? silentLogger;
    for (const [name, given] of Object.entries(o.roles)) {
      let def = given;
      if (def.flow && def.flow !== 'form') throw new EzTestError(`Role ${name}: login flow "${def.flow}" is not supported`, 'IDENTITY_CONFIG');
      const browser = def.loginUrl !== undefined || def.username !== undefined || def.password !== undefined;
      if (!browser && def.api) {
        // An API-only (machine) role: OAuth2 client credentials for API steps, no browser sign-in.
        this.apiOnly.add(name);
        continue;
      }
      // A role that only signs in to an identity provider for API tokens (password, authorization
      // code, device code) needs no application login page of its own.
      const oauthOnly = def.api && !('getToken' in def.api) && ['password', 'authorization_code', 'device_code'].includes(def.api.grant ?? '');
      if (!def.loginUrl && oauthOnly) def = { ...def, loginUrl: (def.api as RoleApi).authorizeUrl ?? (def.api as RoleApi).tokenUrl };
      if (!def.loginUrl) throw new EzTestError(`Role ${name}: loginUrl is required`, 'IDENTITY_CONFIG');
      if (def.username === undefined) throw new EzTestError(`Role ${name}: username is required`, 'IDENTITY_CONFIG');
      if (def.password === undefined) throw new EzTestError(`Role ${name}: password is required`, 'IDENTITY_CONFIG');
      this.roles.set(name, {
        username: typeof def.username === 'string' && isSecretRef(def.username) ? this.registry.handle(def.username) : def.username,
        password: this.registry.from(def.password, `${name}.password`),
        totp: def.totp !== undefined ? this.registry.from(def.totp, `${name}.totp`) : undefined,
        def: { ...def, loginUrl: def.loginUrl },
      });
    }
  }

  roleNames(): string[] {
    return [...this.roles.keys(), ...this.apiOnly];
  }

  /** True for a role that has only API credentials (no browser sign-in). */
  isApiOnly(name: string): boolean {
    return this.apiOnly.has(name);
  }

  private role(name: string): ResolvedRole {
    const r = this.roles.get(name);
    if (!r && this.apiOnly.has(name)) {
      throw new EzTestError(
        `Role "${name}" is an API-only role (identity.roles.${name}.api: OAuth2 client credentials), so it cannot sign in to a browser. Use it on API steps ("... as ${name}"), or give it username, password and loginUrl.`,
        'IDENTITY_API_ONLY_ROLE',
      );
    }
    if (!r) throw new EzTestError(`Unknown role "${name}". Known roles: ${this.roleNames().join(', ') || '(none)'}`, 'IDENTITY_UNKNOWN_ROLE');
    return r;
  }

  // ------------------------------------------------------------- sessions

  sessionFile(role: string): string {
    const h = createHash('sha256').update(`${this.environment}\0${role}`).digest('hex').slice(0, 8);
    return join(this.sessionDir, `${slugify(this.environment)}--${slugify(role)}-${h}.json`);
  }

  async hasFreshSession(role: string): Promise<boolean> {
    this.role(role);
    try {
      const s = await stat(this.sessionFile(role));
      return Date.now() - s.mtimeMs < this.maxAgeMs;
    } catch {
      return false;
    }
  }

  /** `{ storageState }` for browser.newContext() when a fresh cached session exists, else `{}`. */
  async contextOptionsFor(role: string): Promise<{ storageState?: string }> {
    return (await this.hasFreshSession(role)) ? { storageState: this.sessionFile(role) } : {};
  }

  async clearSession(role: string): Promise<void> {
    await rm(this.sessionFile(role), { force: true });
  }

  private async saveSession(page: Page, role: string): Promise<string> {
    const state = await page.context().storageState();
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(role);
    // Unique per writer: parallel workers signing in the same role must not share a temp file.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await rename(tmp, file);
    return file;
  }

  /**
   * Apply the cached session and check it. Without `renew`, a redirect away from the app (the gateway sending the
   * browser to the identity provider) is not followed: the session is reported stale and nothing is signed in, so
   * parallel workers do not each go through the identity provider. With `renew` (one worker, under the role's
   * lock), the redirect is followed: when the identity provider still knows the user (single sign-on) and the
   * browser comes back to the app, the renewed session is saved for the others; otherwise the cache is dropped.
   */
  private async tryReuse(page: Page, role: string, r: ResolvedRole, base: string | undefined, renew = false): Promise<boolean> {
    if (!(await this.hasFreshSession(role))) return false;
    let state: { cookies?: Parameters<ReturnType<Page['context']>['addCookies']>[0]; origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> };
    try {
      state = JSON.parse(await readFile(this.sessionFile(role), 'utf8'));
    } catch {
      await this.clearSession(role);
      return false;
    }
    const ctx = page.context();
    if (state.cookies?.length) await ctx.addCookies(state.cookies);
    const origins = (state.origins ?? []).filter((o) => o.localStorage?.length);
    if (origins.length) {
      await ctx.addInitScript((list: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>) => {
        for (const o of list) {
          if (o.origin !== location.origin) continue;
          for (const { name, value } of o.localStorage) {
            try {
              localStorage.setItem(name, value);
            } catch {
              /* storage may be disabled */
            }
          }
        }
      }, origins);
    }
    // Never trust a cached session blindly: verify via verifyUrl, or via successUrl when it is a plain path.
    const su = r.def.successUrl;
    const verifyUrl = r.def.verifyUrl ?? (su && su.startsWith('/') && !(su.length > 1 && su.endsWith('/')) ? su : undefined);
    if (verifyUrl) {
      const target = this.url(verifyUrl, base);
      const origin = new URL(target).origin;
      let left: string | undefined;
      const hops: string[] = [];
      const onNav = (f: { url(): string; parentFrame(): unknown }) => {
        if (!f.parentFrame()) hops.push(f.url());
      };
      const leaving = (u: URL) => u.origin !== origin;
      const stop = async (route: { request(): { url(): string; isNavigationRequest(): boolean; frame(): unknown }; abort(): Promise<void>; continue(): Promise<void> }) => {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
          left ??= req.url();
          await route.abort();
        } else await route.continue();
      };
      page.on('framenavigated', onNav as never);
      if (!renew) await page.route(leaving, stop as never);
      try {
        await page.goto(target).catch((e: Error) => {
          if (!left) throw e;
        });
      } finally {
        page.off('framenavigated', onNav as never);
        if (!renew) await page.unroute(leaving, stop as never);
      }
      if (left) {
        this.logger.debug(`Cached session for role ${role}: the app sent the browser to ${new URL(left).origin}`);
        return false;
      }
      const why = await this.sessionRejected(page, target, r, base);
      if (why) {
        this.logger.info(`Cached session for role ${role} is no longer valid (${why}); signing in again`);
        await this.clearSession(role);
        await ctx.clearCookies();
        return false;
      }
      // Renewed on the way (the gateway sent the browser through the identity provider, which still knew the
      // user): the cookies changed, so the cache is refreshed for the other journeys. Seen by the cookies, not by
      // navigations: a redirect chain may commit no page on the provider's host.
      const cookieKey = (list: Array<{ name: string; domain?: string; path?: string; value: string }> | undefined) =>
        JSON.stringify((list ?? []).map((c) => `${c.domain}|${c.path ?? '/'}|${c.name}=${c.value}`).sort());
      const viaOtherHost = hops.some((u) => {
        try {
          return new URL(u).origin !== origin;
        } catch {
          return false;
        }
      });
      if (renew && (viaOtherHost || cookieKey((await ctx.storageState()).cookies) !== cookieKey(state.cookies))) {
        await this.saveSession(page, role);
        this.logger.info(`Role ${role}: the gateway session was renewed through single sign-on; session cached`);
      }
    }
    return true;
  }

  /**
   * Why opening `target` with a cached session shows it is no longer valid, or undefined. The app's own login page,
   * a redirect away from the app's origin (an SSO gateway or identity provider: NetScaler, F5, Keycloak, Entra ID)
   * and a visible password field all mean the session is gone.
   */
  private async sessionRejected(page: Page, target: string, r: ResolvedRole, base: string | undefined): Promise<string | undefined> {
    const now = page.url();
    let to: URL;
    let at: URL;
    try {
      to = new URL(target);
      at = new URL(now);
    } catch {
      return undefined;
    }
    if (at.origin !== to.origin) return `redirected to ${at.origin}${at.pathname}`;
    if (this.onLoginPage(now, r, base) && at.pathname !== to.pathname) return 'back on the login page';
    if (await this.passwordShown(page)) return 'a sign-in form is shown';
    return undefined;
  }

  private async passwordShown(page: Page): Promise<boolean> {
    const password = page.locator('input[type=password]').first();
    return (await password.count().catch(() => 0)) > 0 && (await password.isVisible().catch(() => false));
  }

  /**
   * Pages an identity provider shows between the credentials and the app: terms of use, a notice, "stay signed
   * in?". While the browser is still on the provider's host, a button named like one of the role's
   * `interstitials` (default: Accept, I accept, I agree, Agree, Continue) is pressed, a few pages deep. Nothing
   * else is clicked, and a sign-in form showing again stops it (a failed login is reported by the caller).
   */
  private async interstitials(page: Page, role: string, r: ResolvedRole, formUrl: string): Promise<void> {
    const names = r.def.interstitials ?? DEFAULT_INTERSTITIALS;
    if (!names.length) return;
    let form: URL;
    try {
      form = new URL(formUrl);
    } catch {
      return;
    }
    const re = new RegExp(`^\\s*(?:${names.map(escapeRegExp).join('|')})\\s*$`, 'i');
    const deadline = Date.now() + this.timeoutMs;
    let clicks = 0;
    let lastUrl = '';
    let since = Date.now();
    while (Date.now() < deadline && clicks < 5) {
      const url = page.url();
      if (url !== lastUrl) {
        lastUrl = url;
        since = Date.now();
      }
      if (r.def.successUrl && successMatches(url, r.def.successUrl)) return;
      let at: URL;
      try {
        at = new URL(url);
      } catch {
        return;
      }
      if (at.origin !== form.origin) return; // back at the app (or on to the next host): nothing to answer here
      if (!(await this.passwordShown(page))) {
        const button = page.getByRole('button', { name: re }).first();
        if ((await button.count().catch(() => 0)) && (await button.isVisible().catch(() => false))) {
          const label = ((await button.textContent().catch(() => '')) || (await button.getAttribute('value').catch(() => '')) || '').trim();
          this.logger.info(`Role ${role}: answered "${label}" on ${at.host}${at.pathname}`);
          await button.click({ timeout: this.timeoutMs });
          clicks++;
          await page.waitForURL((u) => u.toString() !== url, { timeout: this.timeoutMs, waitUntil: 'load' }).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() - since > 1500) return;
      await sleep(150);
    }
  }

  // ------------------------------------------------------------- login

  /** Runner hook compatible: `(page, role, ctx) => Promise<void>`. */
  login = async (page: Page, role: string, ctx?: unknown): Promise<void> => {
    await this.signIn(page, role, ctx);
  };

  /** Like login(), but reports whether a cached session was reused. */
  async signIn(page: Page, role: string, ctx?: unknown): Promise<LoginOutcome> {
    const r = this.role(role);
    const base = this.baseFrom(ctx);
    if (await this.tryReuse(page, role, r, base)) {
      this.logger.debug(`Role ${role}: reused cached session`);
      return { role, reused: true, url: page.url(), sessionFile: this.sessionFile(role) };
    }
    // One sign-in per role at a time, across workers and processes: the others wait and reuse its session, so a
    // parallel run signs in once (identity providers count logins, MFA prompts and concurrent sessions).
    const release = await this.lockRole(role);
    try {
      if (await this.tryReuse(page, role, r, base, true)) {
        this.logger.debug(`Role ${role}: reused the session another worker signed in`);
        return { role, reused: true, url: page.url(), sessionFile: this.sessionFile(role) };
      }
      return await this.freshSignIn(page, role, r, base);
    } finally {
      await release();
    }
  }

  /**
   * A lock file next to the role's session file (created exclusively). A lock older than the sign-in can take, or
   * held by a process that is gone, is taken over.
   */
  private async lockRole(role: string): Promise<() => Promise<void>> {
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const file = `${this.sessionFile(role)}.lock`;
    const staleMs = Math.max(this.timeoutMs * 8, 120_000);
    const deadline = Date.now() + staleMs;
    const me = `${process.pid} ${randomUUID()}`;
    for (;;) {
      try {
        await writeFile(file, me, { flag: 'wx', mode: 0o600 });
        return async () => {
          try {
            if ((await readFile(file, 'utf8')) === me) await rm(file, { force: true });
          } catch {
            /* already gone */
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const holder = await readFile(file, 'utf8').catch(() => '');
      const pid = Number(holder.split(' ')[0]);
      const age = await stat(file).then((st) => Date.now() - st.mtimeMs).catch(() => 0);
      let alive = true;
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      if (!alive || age > staleMs) await rm(file, { force: true });
      else if (Date.now() > deadline) throw new EzTestError(`Role ${role}: another sign-in held the lock ${file} for ${Math.round(age / 1000)} s`, 'LOGIN_LOCKED');
      else await sleep(200);
    }
  }

  private async freshSignIn(page: Page, role: string, r: ResolvedRole, base: string | undefined): Promise<LoginOutcome> {
    if (r.def.login?.type === 'entra') return this.entraSignIn(page, role, r, base, r.def.login);
    await page.goto(this.url(r.def.loginUrl, base));
    const formUrl = await this.enterCredentials(page, role, r);

    if (r.def.successUrl) {
      const spec = r.def.successUrl;
      // Wait for the app, but stop as soon as the sign-in page shows an error (a wrong password is reported at
      // once, with the identity provider's own words, instead of after the timeout).
      const deadline = Date.now() + this.timeoutMs;
      while (!successMatches(page.url(), spec)) {
        await this.failIfError(page, role);
        if (Date.now() > deadline) throw new EzTestError(`Role ${role}: login did not reach ${spec} (at ${page.url().split('?')[0]})`, 'LOGIN_FAILED');
        await page.waitForURL((u) => successMatches(u.toString(), spec), { timeout: 300 }).catch(() => undefined);
      }
    }
    await this.failIfError(page, role);
    // With a successUrl that matched, only a sign-in form still on screen means the login failed (an app may show
    // its start page at the form's own URL).
    const stillOnForm = this.onLoginPage(page.url(), r, base, formUrl) && (!r.def.successUrl || (await this.passwordShown(page)));
    if (stillOnForm) throw new EzTestError(`Role ${role}: still on the login page after sign-in (${page.url().split('?')[0]})`, 'LOGIN_FAILED');
    const sessionFile = await this.saveSession(page, role);
    this.logger.info(`Role ${role}: signed in, session cached`);
    return { role, reused: false, url: page.url(), sessionFile };
  }

  /** Fill the sign-in form on the current page: username (identifier-first too), password, submit, TOTP. Returns the form's URL. */
  private async enterCredentials(page: Page, role: string, r: ResolvedRole): Promise<string> {
    const f = r.def.fields ?? {};
    const user = await this.findField(page, this.usernameCandidates(page, f.username), this.timeoutMs);
    if (!user) throw new EzTestError(`Role ${role}: username field not found on ${page.url()}`, 'LOGIN_FIELD');
    // Where the form is: the app's login page, or an SSO gateway / identity provider the app redirected to.
    const formUrl = page.url();
    await user.fill(typeof r.username === 'string' ? r.username : await r.username.resolve());

    let pass = await this.findField(page, this.passwordCandidates(page, f.password), 1500);
    if (!pass) {
      // identifier-first flow: submit the username, then expect the password page
      await this.submit(page, this.submitCandidates(page, f.submit), f.submit ? undefined : user);
      pass = await this.findField(page, this.passwordCandidates(page, f.password), this.timeoutMs);
    }
    if (!pass) throw new EzTestError(`Role ${role}: password field not found on ${page.url()}`, 'LOGIN_FIELD');
    await pass.fill(await r.password.resolve());
    await this.submit(page, this.submitCandidates(page, f.submit), f.submit ? undefined : pass);

    if (r.totp) {
      const otp = await this.findField(page, this.totpCandidates(page, f.totp), this.timeoutMs);
      if (!otp) {
        await this.failIfError(page, role);
        throw new EzTestError(`Role ${role}: one-time code field not found on ${page.url()}`, 'LOGIN_FIELD');
      }
      await otp.fill(await freshTotp(await r.totp.resolve(), { ...r.def.totpOptions }));
      await this.submit(page, this.submitCandidates(page, f.totpSubmit ?? f.submit, true), f.totpSubmit ?? f.submit ? undefined : otp);
    }
    await this.interstitials(page, role, r, formUrl);
    return formUrl;
  }

  // ------------------------------------------------------------- OAuth in the browser

  /** A headless browser for OAuth sign-ins (EZTest's own driver), closed afterwards. */
  private async withBrowser<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const launch = this.o.launchBrowser ?? (async () => {
      const { chromium } = await import('../browser/index.js');
      const browser = await chromium.launch({ headless: true });
      return { newPage: async () => (await browser.newContext()).newPage(), close: () => browser.close() };
    });
    const b = await launch();
    try {
      return await fn(await b.newPage());
    } finally {
      await b.close().catch(() => undefined);
    }
  }

  /**
   * Authorization code + PKCE, headless: open the authorize URL, sign in as the role on the
   * identity provider's form (username, password, TOTP), and return the URL the browser was sent
   * back to (redirect_uri?code=...&state=...). The redirect is intercepted, so the redirect URI
   * need not serve anything.
   */
  async browserAuthorize(role: string, authorizeUrl: string, redirectUri: string): Promise<string> {
    const r = this.role(role);
    return this.withBrowser(async (page) => {
      let back: string | undefined;
      await page.route((u) => u.toString().startsWith(redirectUri), async (route) => {
        back = route.request().url();
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Signed in</title><p>EZTest: signed in.</p>' });
      });
      await page.goto(authorizeUrl).catch((e: Error) => {
        if (!back) throw e;
      });
      // A provider with a remembered session redirects at once; otherwise sign in.
      if (!back) await this.enterCredentials(page, role, r);
      const deadline = Date.now() + this.timeoutMs;
      while (!back && Date.now() < deadline) {
        await this.failIfError(page, role);
        await sleep(100);
      }
      if (!back) throw new EzTestError(`Role ${role}: the identity provider did not redirect to ${redirectUri} after sign-in (at ${page.url()})`, 'LOGIN_FAILED');
      this.logger.info(`Role ${role}: authorized in the browser (authorization code)`);
      return back;
    });
  }

  /**
   * Device code approval in the browser: open the verification page (with the code in the URL
   * when the provider gives one, else typing the code), sign in as the role and confirm.
   */
  async browserApproveDevice(role: string, info: { userCode: string; verificationUri: string; verificationUriComplete?: string }): Promise<void> {
    const r = this.role(role);
    await this.withBrowser(async (page) => {
      await page.goto(info.verificationUriComplete ?? info.verificationUri);
      if (!info.verificationUriComplete) {
        const code = await this.findField(page, [page.getByLabel(/code/i), page.locator('input[name*=code i]')], this.timeoutMs);
        if (!code) throw new EzTestError(`Role ${role}: no field for the device code on ${page.url()}`, 'LOGIN_FIELD');
        await code.fill(info.userCode);
        await this.submit(page, this.submitCandidates(page, undefined));
      }
      if (await this.findField(page, this.passwordCandidates(page, r.def.fields?.password), 1500).then(Boolean)) await this.enterCredentials(page, role, r);
      else if (await this.findField(page, this.usernameCandidates(page, r.def.fields?.username), 1500).then(Boolean)) await this.enterCredentials(page, role, r);
      const approve = await this.findField(page, [page.getByRole('button', { name: /approve|allow|authori[sz]e|confirm|continue|yes/i })], 3000);
      if (approve) await approve.click();
      await this.failIfError(page, role);
      this.logger.info(`Role ${role}: approved device code ${info.userCode} in the browser`);
    });
  }

  /**
   * Microsoft Entra ID recipe. Screens are handled in whatever order they appear:
   * account picker ("Pick an account": the role's tile, else "Use another account"),
   * identifier (loginfmt), password (passwd), one-time code (otc, when the role has a
   * TOTP seed), "Stay signed in?" (KMSI), until the app is reached.
   */
  private async entraSignIn(page: Page, role: string, r: ResolvedRole, base: string | undefined, login: Extract<RoleLogin, { type: 'entra' }>): Promise<LoginOutcome> {
    await page.goto(this.url(r.def.loginUrl, base));
    // prompt=login keeps a cached SSO/Kerberos session from skipping the credentials; domain_hint picks the tenant.
    const cur = new URL(page.url());
    if (/\/oauth2\/(?:v2\.0\/)?authorize$/.test(cur.pathname) || /\/authorize$/.test(cur.pathname)) {
      let changed = false;
      if ((login.promptLogin ?? true) && cur.searchParams.get('prompt') !== 'login') {
        cur.searchParams.set('prompt', 'login');
        changed = true;
      }
      if (login.tenantHint && !cur.searchParams.has('domain_hint')) {
        cur.searchParams.set('domain_hint', login.tenantHint);
        changed = true;
      }
      if (changed) await page.goto(cur.toString());
    }
    const username = typeof r.username === 'string' ? r.username : await r.username.resolve();
    const deadline = Date.now() + Math.max(this.timeoutMs * 4, 30_000);
    const seen = (sel: string) => page.locator(sel).first().isVisible().catch(() => false);
    const click = async (sel: string) => {
      const before = page.url();
      await page.locator(sel).first().click({ timeout: this.timeoutMs });
      await page.waitForURL((u) => u.toString() !== before, { timeout: 3000, waitUntil: 'load' }).catch(() => undefined);
    };
    let loginOrigin: string | undefined;
    let did = '';
    for (;;) {
      if (Date.now() > deadline) throw new EzTestError(`Role ${role}: Entra sign-in did not finish (at ${page.url()})`, 'LOGIN_FAILED');
      const err = page.locator('#usernameError, #passwordError, #idTD_Error, #idSpan_SAOTCC_Error_OTC, .alert-error, [role=alert]').first();
      if ((await err.count()) && (await err.isVisible().catch(() => false))) {
        const text = ((await err.textContent()) ?? '').trim().slice(0, 200);
        if (text) throw new EzTestError(this.registry.masker.mask(`Role ${role}: Entra sign-in failed: ${text}`), 'LOGIN_FAILED');
      }
      const url = page.url();
      if (r.def.successUrl && successMatches(url, r.def.successUrl)) break;
      let acted = '';
      if (await seen('#tilesHolder, [data-test-id="accountList"], .table[role=presentation] [data-test-id]')) {
        const tile = page.locator(`[data-test-id="${username.replace(/"/g, '')}"]`).first();
        if ((await tile.count()) && did !== 'picker') {
          await tile.click({ timeout: this.timeoutMs });
        } else {
          await page.locator('#otherTile, [data-test-id="otherTile"]').first().click({ timeout: this.timeoutMs });
        }
        acted = 'picker';
      } else if (await seen('input[name=loginfmt]:not([type=hidden])')) {
        loginOrigin ??= new URL(url).origin;
        if (did !== 'username') {
          await page.locator('input[name=loginfmt]').first().fill(username);
          await click('#idSIButton9, input[type=submit], button[type=submit]');
          acted = 'username';
        }
      } else if (await seen('input[name=passwd], input[type=password]')) {
        loginOrigin ??= new URL(url).origin;
        if (did !== 'password') {
          await page.locator('input[name=passwd], input[type=password]').first().fill(await r.password.resolve());
          await click('#idSIButton9, input[type=submit], button[type=submit]');
          acted = 'password';
        }
      } else if (await seen('input[name=otc], #idTxtBx_SAOTCC_OTC')) {
        if (!r.totp) throw new EzTestError(`Role ${role}: Entra asks for a one-time code but the role has no totp seed`, 'LOGIN_FIELD');
        if (did !== 'otc') {
          await page.locator('input[name=otc], #idTxtBx_SAOTCC_OTC').first().fill(await freshTotp(await r.totp.resolve(), { ...r.def.totpOptions }));
          await click('#idSubmit_SAOTCC_Continue, #idSIButton9, input[type=submit], button[type=submit]');
          acted = 'otc';
        }
      } else if (await seen('#KmsiCheckboxField, #KmsiDescription, [data-test-id="kmsi"]')) {
        if (did !== 'kmsi') {
          await click((login.staySignedIn ?? true) ? '#idSIButton9' : '#idBtn_Back');
          acted = 'kmsi';
        }
      } else if (!r.def.successUrl && loginOrigin && new URL(url).origin !== loginOrigin) {
        break;
      }
      if (acted) did = acted;
      await sleep(acted ? 50 : 150);
    }
    if (r.def.successUrl) await page.waitForURL((u) => successMatches(u.toString(), r.def.successUrl!), { timeout: this.timeoutMs });
    const sessionFile = await this.saveSession(page, role);
    this.logger.info(`Role ${role}: signed in (Entra), session cached`);
    return { role, reused: false, url: page.url(), sessionFile };
  }

  /** Bearer token for API calls as this role. */
  async apiToken(role: string): Promise<string> {
    return (await this.tokenProvider(role)).getToken();
  }

  async tokenProvider(role: string): Promise<TokenProvider> {
    const hit = this.tokens.get(role);
    if (hit) return hit;
    const api = this.apiOnly.has(role) ? this.o.roles[role].api : this.role(role).def.api;
    if (!api) throw new EzTestError(`Role ${role} has no API credentials configured`, 'IDENTITY_NO_API');
    const p: TokenProvider = 'getToken' in api ? api : this.oauthProvider(role, api);
    this.tokens.set(role, p);
    return p;
  }

  private oauthProvider(role: string, api: RoleApi): OAuth2TokenProvider {
    const grant = api.grant ?? 'client_credentials';
    const secret = (v: string | SecretHandle | undefined, label: string) => (v === undefined ? undefined : this.registry.from(v, `${role}.${label}`));
    const browserRole = (): ResolvedRole => {
      const r = this.roles.get(role);
      if (!r) throw new EzTestError(`Role ${role}: the ${grant} grant signs in with the role's username and password; give it username, password and loginUrl`, 'IDENTITY_CONFIG');
      return r;
    };
    const base = {
      tokenUrl: this.url(api.tokenUrl, this.o.baseUrl), clientId: api.clientId, clientSecret: secret(api.clientSecret, 'clientSecret'),
      scope: api.scope, audience: api.audience, masker: this.registry.masker, grant, ...(api.skewSeconds !== undefined ? { skewSeconds: api.skewSeconds } : {}),
      ...(api.clientAuth ? { clientAuth: api.clientAuth } : {}),
      ...(api.clientKey ? { clientKey: { privateKey: secret(api.clientKey.privateKey, 'clientKey')!, alg: api.clientKey.alg, kid: api.clientKey.kid } } : {}),
    };
    switch (grant) {
      case 'password': {
        const r = browserRole();
        return new OAuth2TokenProvider({ ...base, username: typeof r.username === 'string' ? r.username : r.username, password: r.password });
      }
      case 'authorization_code': {
        browserRole();
        if (!api.authorizeUrl || !api.redirectUri) throw new EzTestError(`Role ${role}: the authorization_code grant needs authorizeUrl and redirectUri`, 'IDENTITY_CONFIG');
        return new OAuth2TokenProvider({ ...base, authorizationCode: { authorizeUrl: this.url(api.authorizeUrl, this.o.baseUrl), redirectUri: api.redirectUri, signIn: (url, redirect) => this.browserAuthorize(role, url, redirect) } });
      }
      case 'device_code': {
        browserRole();
        if (!api.deviceAuthorizationUrl) throw new EzTestError(`Role ${role}: the device_code grant needs deviceAuthorizationUrl`, 'IDENTITY_CONFIG');
        return new OAuth2TokenProvider({ ...base, deviceAuthorizationUrl: this.url(api.deviceAuthorizationUrl, this.o.baseUrl), onDeviceCode: (info) => this.browserApproveDevice(role, info) });
      }
      case 'jwt_bearer': {
        if (!api.assertion) throw new EzTestError(`Role ${role}: the jwt_bearer grant needs an assertion (privateKey, subject)`, 'IDENTITY_CONFIG');
        const a = api.assertion;
        return new OAuth2TokenProvider({ ...base, assertion: { privateKey: secret(a.privateKey, 'assertionKey')!, subject: a.subject, issuer: a.issuer, audience: a.audience, alg: a.alg, kid: a.kid } });
      }
      case 'refresh_token':
        return new OAuth2TokenProvider({ ...base, refreshToken: secret(api.refreshToken, 'refreshToken') });
      default:
        return new OAuth2TokenProvider(base);
    }
  }

  // ------------------------------------------------------------- helpers

  private baseFrom(ctx: unknown): string | undefined {
    if (ctx && typeof ctx === 'object' && typeof (ctx as { baseUrl?: unknown }).baseUrl === 'string') return (ctx as { baseUrl: string }).baseUrl;
    return this.o.baseUrl;
  }

  private url(u: string, base: string | undefined): string {
    try {
      return new URL(u, base).toString();
    } catch {
      throw new EzTestError(`Cannot resolve URL "${u}" without a baseUrl`, 'IDENTITY_CONFIG');
    }
  }

  /**
   * True when `current` is the sign-in form: the page the credentials were typed on (`formUrl`, which may be an
   * identity provider on another host when the app redirected there), else the configured login URL. Origin and
   * path both count: behind an SSO gateway the login URL is the app itself (`/`), which the browser comes back to.
   */
  private onLoginPage(current: string, r: ResolvedRole, base: string | undefined, formUrl?: string): boolean {
    try {
      const at = new URL(current);
      const form = new URL(formUrl ?? this.url(r.def.loginUrl, base));
      return at.origin === form.origin && at.pathname === form.pathname;
    } catch {
      return false;
    }
  }

  private async failIfError(page: Page, role: string): Promise<void> {
    // Generic alerts, and the error text of identity providers' forms (Keycloak: #input-error, PatternFly pf-m-error).
    const alerts = page.locator('[role=alert], .error, .alert-danger, [aria-invalid=true] ~ .error-message, [id^="input-error"], .pf-m-error, .kc-feedback-text');
    const n = Math.min(await alerts.count().catch(() => 0), 10);
    for (let i = 0; i < n; i++) {
      const alert = alerts.nth(i);
      if (!(await alert.isVisible().catch(() => false))) continue;
      const text = ((await alert.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!text && i < n - 1) continue;
      throw new EzTestError(this.registry.masker.mask(`Role ${role}: login failed: ${text || 'error shown'}`), 'LOGIN_FAILED');
    }
  }

  private spec(page: Page, s: string): Locator[] {
    return SELECTOR_RE.test(s) ? [page.locator(s)] : [page.getByLabel(s, { exact: false }), page.getByPlaceholder(s), page.getByRole('textbox', { name: s })];
  }

  private usernameCandidates(page: Page, s?: string): Locator[] {
    if (s) return this.spec(page, s);
    return [
      page.locator('input[autocomplete=username]'),
      page.getByLabel(/user ?name|e-?mail|login|user id/i),
      page.locator('input[type=email]'),
      page.locator('input[name*=user i], input[id*=user i], input[name*=login i], input[name*=email i]'),
    ];
  }

  private passwordCandidates(page: Page, s?: string): Locator[] {
    if (s) return this.spec(page, s);
    return [page.locator('input[type=password]')];
  }

  private totpCandidates(page: Page, s?: string): Locator[] {
    if (s) return this.spec(page, s);
    return [
      page.locator('input[autocomplete=one-time-code]'),
      page.getByLabel(/code|otp|one-time|authenticator|verification|token/i),
      page.locator('input[name*=otp i], input[name*=totp i], input[name*=code i], input[id*=otp i]'),
      page.locator('input[inputmode=numeric]'),
    ];
  }

  private submitCandidates(page: Page, s?: string, totp = false): Locator[] {
    if (s) return SELECTOR_RE.test(s) ? [page.locator(s)] : [page.getByRole('button', { name: s }), page.getByText(s, { exact: true })];
    const names = totp ? /verify|continue|submit|confirm|sign in|log ?in/i : /sign in|log ?in|login|continue|next|submit/i;
    return [page.getByRole('button', { name: names }), page.locator('button[type=submit], input[type=submit]')];
  }

  private async buttonName(b: Locator): Promise<string> {
    return ((await b.getAttribute('aria-label').catch(() => null)) || (await b.textContent().catch(() => null)) || (await b.getAttribute('value').catch(() => null)) || '').trim();
  }

  /** Like findField, for buttons: every match of a candidate is looked at, and buttons that leave the flow are skipped. */
  private async findButton(page: Page, candidates: Locator[], timeoutMs: number): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const c of candidates) {
        try {
          const n = Math.min(await c.count(), 10);
          for (let i = 0; i < n; i++) {
            const b = c.nth(i);
            if ((await b.isVisible()) && !NOT_SUBMIT.test(await this.buttonName(b))) return b;
          }
        } catch {
          /* navigation in progress; poll again */
        }
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(100);
    }
  }

  private async findField(page: Page, candidates: Locator[], timeoutMs: number): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const c of candidates) {
        const first = c.first();
        try {
          if ((await first.count()) > 0 && (await first.isVisible())) return first;
        } catch {
          /* navigation in progress; poll again */
        }
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(100);
    }
  }

  /**
   * Press the form's submit button. Without a configured one, the submit button of the form that holds the field
   * just filled wins; otherwise a button named like sign in / continue / verify, never one that restarts or
   * leaves the flow (Keycloak's "Restart login" next to the user name, "Forgot password?", "Try another way").
   */
  private async submit(page: Page, candidates: Locator[], field?: Locator): Promise<void> {
    let btn: Locator | undefined;
    if (field) {
      const own = field.locator("xpath=ancestor::form[1]//*[self::button[not(@type) or @type='submit'] or self::input[@type='submit' or @type='image']]");
      const n = await own.count().catch(() => 0);
      for (let i = 0; i < n && !btn; i++) {
        const b = own.nth(i);
        if ((await b.isVisible().catch(() => false)) && !NOT_SUBMIT.test(await this.buttonName(b))) btn = b;
      }
    }
    btn ??= await this.findButton(page, candidates, this.timeoutMs);
    if (!btn) throw new EzTestError(`Submit button not found on ${page.url()}`, 'LOGIN_FIELD');
    const before = page.url();
    await btn.click();
    try {
      await page.waitForURL((u) => u.toString() !== before, { timeout: this.timeoutMs, waitUntil: 'load' });
    } catch {
      /* single-page flows may not navigate; field lookups that follow poll for the next state */
    }
  }
}
