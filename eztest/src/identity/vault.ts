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
import { generateTotp, totpSecondsRemaining, type TotpAlgorithm } from './totp.js';

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
  /** Plain username, secret://ref, or handle. Plain usernames are not treated as secrets. */
  username: string | SecretHandle;
  /** secret://ref, ENC(...), or handle. A plain string is wrapped as an inline secret. */
  password: string | SecretHandle;
  /** Base32 TOTP seed: secret://ref, ENC(...), or handle. */
  totp?: string | SecretHandle;
  loginUrl: string;
  flow?: 'form';
  /** Login recipe (default: form). */
  login?: RoleLogin;
  fields?: RoleFields;
  /** Substring of the URL that proves login succeeded (or /regex/). */
  successUrl?: string;
  /** URL to open when reusing a cached session to confirm it is still valid. */
  verifyUrl?: string;
  totpOptions?: { digits?: number; algorithm?: TotpAlgorithm; step?: number };
  /** API access for this role: an OAuth2 client config or any TokenProvider. */
  api?: { tokenUrl: string; clientId: string; clientSecret: string | SecretHandle; scope?: string; audience?: string } | TokenProvider;
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
  def: RoleDefinition;
}

const SELECTOR_RE = /^(css=|xpath=|text=|role=|id=|data-testid=|internal:|\/\/|#|\.|\[)|^[a-z][a-z0-9-]*[#.[:]/i;

function successMatches(url: string, spec: string): boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(spec);
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
    for (const [name, def] of Object.entries(o.roles)) {
      if (def.flow && def.flow !== 'form') throw new EzTestError(`Role ${name}: login flow "${def.flow}" is not supported`, 'IDENTITY_CONFIG');
      if (!def.loginUrl) throw new EzTestError(`Role ${name}: loginUrl is required`, 'IDENTITY_CONFIG');
      this.roles.set(name, {
        username: typeof def.username === 'string' && isSecretRef(def.username) ? this.registry.handle(def.username) : def.username,
        password: this.registry.from(def.password, `${name}.password`),
        totp: def.totp !== undefined ? this.registry.from(def.totp, `${name}.totp`) : undefined,
        def,
      });
    }
  }

  roleNames(): string[] {
    return [...this.roles.keys()];
  }

  private role(name: string): ResolvedRole {
    const r = this.roles.get(name);
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

  private async tryReuse(page: Page, role: string, r: ResolvedRole, base: string | undefined): Promise<boolean> {
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
      await page.goto(this.url(verifyUrl, base));
      if (this.onLoginPage(page.url(), r, base)) {
        this.logger.info(`Cached session for role ${role} is no longer valid; signing in again`);
        await this.clearSession(role);
        await ctx.clearCookies();
        return false;
      }
    }
    return true;
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
    if (r.def.login?.type === 'entra') return this.entraSignIn(page, role, r, base, r.def.login);
    const f = r.def.fields ?? {};
    await page.goto(this.url(r.def.loginUrl, base));

    const user = await this.findField(page, this.usernameCandidates(page, f.username), this.timeoutMs);
    if (!user) throw new EzTestError(`Role ${role}: username field not found on ${page.url()}`, 'LOGIN_FIELD');
    await user.fill(typeof r.username === 'string' ? r.username : await r.username.resolve());

    let pass = await this.findField(page, this.passwordCandidates(page, f.password), 1500);
    if (!pass) {
      // identifier-first flow: submit the username, then expect the password page
      await this.submit(page, this.submitCandidates(page, f.submit));
      pass = await this.findField(page, this.passwordCandidates(page, f.password), this.timeoutMs);
    }
    if (!pass) throw new EzTestError(`Role ${role}: password field not found on ${page.url()}`, 'LOGIN_FIELD');
    await pass.fill(await r.password.resolve());
    await this.submit(page, this.submitCandidates(page, f.submit));

    if (r.totp) {
      const otp = await this.findField(page, this.totpCandidates(page, f.totp), this.timeoutMs);
      if (!otp) {
        await this.failIfError(page, role);
        throw new EzTestError(`Role ${role}: one-time code field not found on ${page.url()}`, 'LOGIN_FIELD');
      }
      const opts = { ...r.def.totpOptions };
      if (totpSecondsRemaining(opts) < 3) await sleep(totpSecondsRemaining(opts) * 1000 + 250);
      await otp.fill(generateTotp(await r.totp.resolve(), opts));
      await this.submit(page, this.submitCandidates(page, f.totpSubmit ?? f.submit, true));
    }

    if (r.def.successUrl) {
      const spec = r.def.successUrl;
      try {
        await page.waitForURL((u) => successMatches(u.toString(), spec), { timeout: this.timeoutMs });
      } catch {
        await this.failIfError(page, role);
        throw new EzTestError(`Role ${role}: login did not reach ${spec} (at ${page.url()})`, 'LOGIN_FAILED');
      }
    }
    await this.failIfError(page, role);
    if (this.onLoginPage(page.url(), r, base)) throw new EzTestError(`Role ${role}: still on the login page after sign-in`, 'LOGIN_FAILED');
    const sessionFile = await this.saveSession(page, role);
    this.logger.info(`Role ${role}: signed in, session cached`);
    return { role, reused: false, url: page.url(), sessionFile };
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
          const opts = { ...r.def.totpOptions };
          if (totpSecondsRemaining(opts) < 3) await sleep(totpSecondsRemaining(opts) * 1000 + 250);
          await page.locator('input[name=otc], #idTxtBx_SAOTCC_OTC').first().fill(generateTotp(await r.totp.resolve(), opts));
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
    const r = this.role(role);
    const hit = this.tokens.get(role);
    if (hit) return hit;
    const api = r.def.api;
    if (!api) throw new EzTestError(`Role ${role} has no API credentials configured`, 'IDENTITY_NO_API');
    const p: TokenProvider =
      'getToken' in api
        ? api
        : new OAuth2TokenProvider({
            tokenUrl: this.url(api.tokenUrl, this.o.baseUrl),
            clientId: api.clientId,
            clientSecret: this.registry.from(api.clientSecret, `${role}.clientSecret`),
            scope: api.scope,
            audience: api.audience,
            masker: this.registry.masker,
          });
    this.tokens.set(role, p);
    return p;
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

  private onLoginPage(current: string, r: ResolvedRole, base: string | undefined): boolean {
    try {
      return new URL(current).pathname === new URL(this.url(r.def.loginUrl, base)).pathname;
    } catch {
      return false;
    }
  }

  private async failIfError(page: Page, role: string): Promise<void> {
    const alert = page.locator('[role=alert], .error, .alert-danger, [aria-invalid=true] ~ .error-message').first();
    if ((await alert.count()) && (await alert.isVisible())) {
      const text = ((await alert.textContent()) ?? '').trim().slice(0, 200);
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

  private async submit(page: Page, candidates: Locator[]): Promise<void> {
    const btn = await this.findField(page, candidates, this.timeoutMs);
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
