/**
 * The Microsoft Entra ID login recipe against the demo app's mock Entra pages:
 * identifier-first, password, one-time code, "Stay signed in?", account picker and
 * prompt=login / domain_hint on the authorize URL. Also a role whose password comes
 * from a rotation provider.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '../../src/browser/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { SecretMasker } from '../../src/config/index.js';
import { IdentityVault, MemorySecretStore, SecretRegistry, identityVaultFromConfig } from '../../src/identity/index.js';
import { EzTestConfigSchema } from '../../src/config/index.js';
import { expectPasses, outDir } from './advanced-helpers.js';

describe('Entra ID login recipe (mock Entra pages)', () => {
  let app: DemoServer;
  let sessions: string;
  let browser: Browser;
  beforeAll(async () => {
    app = await startDemoApp();
    sessions = await mkdtemp(join(tmpdir(), 'eztest-entra-'));
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await rm(sessions, { recursive: true, force: true });
  });

  function vault(extra: Partial<ConstructorParameters<typeof IdentityVault>[0]> = {}): IdentityVault {
    const masker = new SecretMasker();
    const registry = new SecretRegistry([new MemorySecretStore({ alice: 'Wonderland#1', bob: 'Builder#2', totp: DEMO_TOTP_SECRET }, 'mem')], masker);
    return new IdentityVault({
      registry, baseUrl: app.url, sessionDir: join(sessions, Math.random().toString(36).slice(2)), timeoutMs: 8000,
      roles: {
        alice: { username: 'alice@ezshop.test', password: 'secret://mem/alice', totp: 'secret://mem/totp', loginUrl: '/entra/app', successUrl: '/dashboard', login: { type: 'entra', tenantHint: 'ezshop.test' } },
        bob: { username: 'bob@ezshop.test', password: 'secret://mem/bob', loginUrl: '/entra/app', successUrl: '/dashboard', login: { type: 'entra', staySignedIn: false, promptLogin: false } },
        wrong: { username: 'bob@ezshop.test', password: 'secret://mem/alice', loginUrl: '/entra/app', successUrl: '/dashboard', login: { type: 'entra' } },
      },
      ...extra,
    });
  }

  it('signs in through identifier, password, one-time code and "Stay signed in?" (with prompt=login and domain_hint)', async () => {
    const v = vault();
    const before = app.entra.authorizeLog.length;
    await expectPasses(app.url, 'Journey: Entra alice\nLog in as alice\nExpect the page contains "Welcome, alice"\n', { login: v.login, outputDir: await outDir('entra') });
    const log = app.entra.authorizeLog.slice(before);
    expect(log.at(-1)).toEqual({ prompt: 'login', domainHint: 'ezshop.test' });
    expect(app.entra.remembered.size).toBeGreaterThan(0); // answered Yes to "Stay signed in?"
  }, 60_000);

  it('handles the account picker when a remembered account exists, and answers No to "Stay signed in?"', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      // Remember bob in this browser first (Stay signed in = Yes), through the generic recipe.
      const v1 = vault();
      const remembered = app.entra.remembered.size;
      await v1.signIn(page, 'alice');
      expect(app.entra.remembered.size).toBe(remembered + 1);
      await ctx.clearCookies({ name: 'ezsid' });
      // bob: promptLogin false -> the picker appears; the recipe picks "Use another account" (bob is not remembered).
      const v2 = vault();
      const out = await v2.signIn(page, 'bob');
      expect(out.reused).toBe(false);
      expect(await page.textContent('[data-testid=welcome-user]')).toBe('bob');
      expect(app.entra.authorizeLog.at(-1)?.prompt).toBeNull();
      expect(app.entra.remembered.size).toBe(remembered + 1); // No -> not remembered
      // alice again without prompt=login: her own tile in the picker
      await ctx.clearCookies({ name: 'ezsid' });
      const v3 = vault({ sessionDir: join(sessions, 'picker'), roles: {
        alice: { username: 'alice@ezshop.test', password: 'secret://mem/alice', totp: 'secret://mem/totp', loginUrl: '/entra/app', successUrl: '/dashboard', login: { type: 'entra', promptLogin: false } },
      } });
      await v3.signIn(page, 'alice');
      expect(await page.textContent('[data-testid=welcome-user]')).toBe('alice');
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('reports a wrong password from the Entra page (masked)', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await expect(vault().signIn(page, 'wrong')).rejects.toThrow(/Entra sign-in failed: Your account or password is incorrect/);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('takes a role password from a configured rotation provider (monthly formula)', async () => {
    // The demo password "Builder#2" split as prefix + period + suffix with a custom format: no formula is built in.
    const cfg = EzTestConfigSchema.parse({
      baseUrl: app.url,
      identity: {
        sessionDir: join(sessions, 'rotation'),
        roles: {
          bob: {
            username: 'bob', loginUrl: '/login', successUrl: '/dashboard',
            passwordRotation: { type: 'monthly-formula', prefix: 'secret://env/BOB_PREFIX', suffix: 'secret://env/BOB_SUFFIX', format: '', rotatesOn: 'first-friday' },
          },
        },
      },
    });
    const masker = new SecretMasker();
    const v = identityVaultFromConfig(cfg, { masker, env: { BOB_PREFIX: 'Builder', BOB_SUFFIX: '#2' } });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await v.signIn(page, 'bob');
      expect(await page.textContent('[data-testid=welcome-user]')).toBe('bob');
      expect(masker.mask('pw Builder#2')).toBe('pw ****');
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
