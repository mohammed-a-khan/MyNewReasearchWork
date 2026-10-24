/**
 * Project › Identities and roles: roles from the Identity Vault with their
 * secret references (values are never sent), a headless "test login" with a
 * screenshot, the current TOTP code on explicit request, session-cache status
 * and clearing, and ENC() encryption of a value with EZTEST_MASTER_KEY.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptValue, isEncryptedValue, MASTER_KEY_ENV, type LoadedConfig } from '../../config/index.js';
import { generateTotp, isSecretRef, totpSecondsRemaining } from '../../identity/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import { relPosix } from '../security.js';
import { vaultFor } from './assurance-shared.js';
import { rawConfigValue } from './project-environments.js';
import type { StudioRoute } from './route.js';

function describeSecret(app: StudioApp, path: string, effective: string | undefined): { kind: string; ref?: string; source?: string } {
  if (effective === undefined) return { kind: 'none' };
  const raw = rawConfigValue(app, path);
  const r = typeof raw?.value === 'string' ? raw.value : undefined;
  if (isSecretRef(effective)) return { kind: 'secret-ref', ref: effective, source: raw?.source };
  const enc: boolean = r !== undefined && isEncryptedValue(r as unknown);
  if (enc) return { kind: 'encrypted', ref: 'ENC(…)', source: raw?.source };
  if (r !== undefined && /\$\{[A-Za-z_]\w*/.test(r)) return { kind: 'env-var', ref: r.replace(/:-[^}]*\}/g, '}'), source: raw?.source };
  return { kind: 'plain', ref: 'plain text in config (prefer a secret:// reference or ENC())', source: raw?.source };
}

function roleOf(loaded: LoadedConfig, role: string) {
  const r = loaded.config.identity.roles[role];
  if (!r) throw new HttpError(404, `Unknown role "${role}"`);
  return r;
}

async function rolesView(app: StudioApp): Promise<Record<string, unknown>> {
  const loaded = await app.config();
  const c = loaded.config;
  const vault = vaultFor(app, loaded);
  const roles = [];
  for (const [name, r] of Object.entries(c.identity.roles)) {
    const file = vault.sessionFile(name);
    let session: Record<string, unknown> = { cached: false };
    if (existsSync(file)) {
      const st = await stat(file);
      const ageMs = Date.now() - st.mtimeMs;
      session = { cached: true, fresh: await vault.hasFreshSession(name), ageMs, savedAt: st.mtime.toISOString(), file: relPosix(app.cwd, file), maxAgeMinutes: c.identity.sessionMaxAgeMinutes };
    }
    roles.push({
      name,
      username: isSecretRef(r.username) ? { kind: 'secret-ref', ref: r.username } : { kind: 'plain', value: r.username },
      password: describeSecret(app, `identity.roles.${name}.password`, r.password),
      totp: r.totp ? describeSecret(app, `identity.roles.${name}.totp`, r.totp) : undefined,
      loginUrl: r.loginUrl,
      successUrl: r.successUrl,
      api: r.api ? { tokenUrl: r.api.tokenUrl, clientId: r.api.clientId, clientSecret: describeSecret(app, `identity.roles.${name}.api.clientSecret`, r.api.clientSecret), scope: r.api.scope } : undefined,
      session,
    });
  }
  return {
    environment: c.environment,
    baseUrl: c.baseUrl ? loaded.masker.mask(c.baseUrl) : undefined,
    sessionDir: c.identity.sessionDir,
    stores: [{ type: 'env', name: 'env', implicit: !c.identity.secretStores.some((s) => (s.name ?? s.type) === 'env') }, ...c.identity.secretStores.map((s) => ({ type: s.type, name: s.name ?? s.type, ...(s.type === 'env' ? { prefix: s.prefix } : s.type === 'file' ? { path: s.path } : s.type === 'azure-keyvault' ? { vaultUrl: s.vaultUrl } : s.type === 'hashicorp-vault' ? { vaultUrl: s.address } : s.type === 'cyberark-ccp' ? { vaultUrl: s.url } : s.type === 'aws-secrets-manager' ? { vaultUrl: s.endpoint ?? `aws:${s.region}` } : { vaultUrl: s.endpoint ?? `gcp:${s.project ?? ''}` }) }))].filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i),
    masterKey: !!app.ctx.env[MASTER_KEY_ENV],
    roles,
  };
}

let loginBusy = false;

async function testLogin(app: StudioApp, role: string, useCache: boolean): Promise<Record<string, unknown>> {
  if (loginBusy) throw new HttpError(409, 'A test login is already running');
  const loaded = await app.config();
  roleOf(loaded, role);
  loginBusy = true;
  const temp = useCache ? undefined : await mkdtemp(join(tmpdir(), 'eztest-login-'));
  const started = Date.now();
  const { chromium, firefox, webkit } = await import('../../browser/index.js');
  const engine = { chromium, firefox, webkit }[loaded.config.browser] ?? chromium;
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: loaded.config.baseUrl });
    const page = await context.newPage();
    const vault = vaultFor(app, loaded, temp ? { sessionDir: temp } : {});
    let ok = true;
    let error: string | undefined;
    let reused = false;
    try {
      const out = await vault.signIn(page, role, { baseUrl: loaded.config.baseUrl });
      reused = out.reused;
    } catch (e) {
      ok = false;
      error = loaded.masker.mask((e as Error).message);
    }
    let screenshot: string | undefined;
    try {
      screenshot = `data:image/png;base64,${(await page.screenshot({ timeout: 5000 })).toString('base64')}`;
    } catch {
      screenshot = undefined;
    }
    const url = loaded.masker.mask(page.url());
    return { ok, role, error, url, reused, durationMs: Date.now() - started, screenshot, cachedSession: useCache };
  } finally {
    await browser?.close().catch(() => undefined);
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    loginBusy = false;
  }
}

export const identityRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/identity',
    summary: 'Roles (secret references only, never values), secret stores and session cache status',
    async handler({ res, app }) {
      sendJson(res, 200, await rolesView(app));
    },
  },
  {
    method: 'POST',
    path: /^\/api\/project\/identity\/roles\/([\w.-]+)\/test-login$/,
    summary: 'Run the role login headless and return pass/fail with a screenshot',
    async handler({ res, app, params, body }) {
      sendJson(res, 200, await testLogin(app, params[0], body.useCache === true));
    },
  },
  {
    method: 'POST',
    path: /^\/api\/project\/identity\/roles\/([\w.-]+)\/totp$/,
    summary: 'The current TOTP code of a role (on explicit request)',
    async handler({ res, app, params }) {
      const loaded = await app.config();
      const r = roleOf(loaded, params[0]);
      if (!r.totp) throw new HttpError(404, `Role "${params[0]}" has no TOTP secret`);
      const vault = vaultFor(app, loaded);
      let secret: string;
      try {
        secret = isSecretRef(r.totp) ? await vault.registry.resolve(r.totp) : r.totp;
      } catch (e) {
        throw new HttpError(422, loaded.masker.mask((e as Error).message));
      }
      sendJson(res, 200, { role: params[0], code: generateTotp(secret), secondsRemaining: totpSecondsRemaining() });
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/project\/identity\/roles\/([\w.-]+)\/session$/,
    summary: 'Clear the cached browser session of a role',
    async handler({ res, app, params }) {
      const loaded = await app.config();
      roleOf(loaded, params[0]);
      await vaultFor(app, loaded).clearSession(params[0]);
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/project/identity/encrypt',
    summary: 'Encrypt a value into config-ready ENC(...) text with EZTEST_MASTER_KEY (server side)',
    handler({ res, app, body }) {
      const key = app.ctx.env[MASTER_KEY_ENV];
      if (!key) throw new HttpError(412, `${MASTER_KEY_ENV} is not set for the Studio process. Set it in the environment that starts "eztest studio", then try again.`, { masterKey: false });
      const value = typeof body.value === 'string' ? body.value : '';
      if (!value) throw new HttpError(400, 'Enter the value to encrypt');
      if (value.length > 10_000) throw new HttpError(400, 'The value is too long');
      try {
        sendJson(res, 200, { text: encryptValue(value, key) });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    },
  },
];
