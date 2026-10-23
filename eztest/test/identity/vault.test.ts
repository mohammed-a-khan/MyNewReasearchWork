import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { chromium, type Browser } from '../../src/browser/index.js';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, statSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityVault, SecretRegistry, MemorySecretStore, addVirtualAuthenticator } from '../../src/identity/index.js';
import { SecretMasker } from '../../src/config/index.js';
import { NotSupportedError } from '../../src/core/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, DEMO_CLIENT, type DemoServer } from '../../examples/demo-app/server.js';

/** The native suite on Firefox (EZTEST_BROWSER=firefox): tests that only make sense on Chromium skip, saying why. */
const onFirefox = process.env.EZTEST_BROWSER === 'firefox';
const chromiumOnly = (title: string, reason: string) => (onFirefox ? `${title} [skipped on Firefox: ${reason}]` : title);

let demo: DemoServer;
let browser: Browser;
let dir: string;
let masker: SecretMasker;

function makeVault(extra: Partial<ConstructorParameters<typeof IdentityVault>[0]> = {}) {
  masker = new SecretMasker();
  const registry = new SecretRegistry(
    [new MemorySecretStore({ 'alice-password': 'Wonderland#1', 'alice-totp': DEMO_TOTP_SECRET, 'bob-password': 'wrong-password!', 'client-secret': DEMO_CLIENT.secret }, 'vault')],
    masker,
  );
  return new IdentityVault({
    baseUrl: demo.url,
    environment: 'test',
    sessionDir: dir,
    registry,
    sessionMaxAgeMs: 60_000,
    roles: {
      'sales-rep': {
        username: 'alice',
        password: 'secret://vault/alice-password',
        totp: 'secret://vault/alice-totp',
        loginUrl: '/login',
        flow: 'form',
        successUrl: '/dashboard',
        api: { tokenUrl: '/api/token', clientId: DEMO_CLIENT.id, clientSecret: 'secret://vault/client-secret' },
      },
      'bad-bob': { username: 'bob', password: 'secret://vault/bob-password', loginUrl: '/login', fields: { username: 'Username', password: '#password', submit: 'Sign in' } },
    },
    ...extra,
  });
}

beforeAll(async () => {
  demo = await startDemoApp();
  browser = await chromium.launch();
  dir = mkdtempSync(join(tmpdir(), 'eztest-sessions-'));
});
afterAll(async () => {
  await browser?.close();
  await demo?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('IdentityVault with real Chromium', () => {
  it('logs in as alice with TOTP, caches the session, and reuses it without UI login', async () => {
    const vault = makeVault();
    expect(await vault.contextOptionsFor('sales-rep')).toEqual({});

    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const posts1: string[] = [];
    page1.on('request', (r) => r.method() === 'POST' && posts1.push(new URL(r.url()).pathname));
    const first = await vault.signIn(page1, 'sales-rep');
    expect(first.reused).toBe(false);
    expect(new URL(page1.url()).pathname).toBe('/dashboard');
    expect(await page1.getByTestId('welcome-user').textContent()).toBe('alice');
    expect(posts1).toEqual(['/login', '/mfa']);
    await ctx1.close();

    const file = vault.sessionFile('sales-rep');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('Wonderland');
    const opts = await vault.contextOptionsFor('sales-rep');
    expect(opts.storageState).toBe(file);

    // second call through the runner-hook signature: no UI login
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    const posts2: string[] = [];
    page2.on('request', (r) => r.method() === 'POST' && posts2.push(new URL(r.url()).pathname));
    await vault.login(page2, 'sales-rep', { baseUrl: demo.url });
    await page2.goto(`${demo.url}/dashboard`);
    expect(new URL(page2.url()).pathname).toBe('/dashboard');
    expect(await page2.getByTestId('welcome-user').textContent()).toBe('alice');
    expect(posts2).toEqual([]);
    await ctx2.close();

    // contextOptionsFor lets a journey skip login entirely
    const ctx3 = await browser.newContext(opts);
    const page3 = await ctx3.newPage();
    await page3.goto(`${demo.url}/dashboard`);
    expect(new URL(page3.url()).pathname).toBe('/dashboard');
    await ctx3.close();

    // max age: an old session is not reused
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    expect(await vault.hasFreshSession('sales-rep')).toBe(false);
    expect(await vault.contextOptionsFor('sales-rep')).toEqual({});
  });

  it('re-validates a cached session with verifyUrl and falls back to UI login when stale', async () => {
    const vault = makeVault();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await vault.signIn(page, 'sales-rep');
    await ctx.close();
    const vault2 = new IdentityVault({
      baseUrl: demo.url,
      environment: 'test',
      sessionDir: dir,
      registry: vault.registry,
      roles: {
        'sales-rep': { username: 'alice', password: 'secret://vault/alice-password', totp: 'secret://vault/alice-totp', loginUrl: '/login', verifyUrl: '/dashboard' },
      },
    });
    // log out on the server so the cached cookie becomes invalid
    const ctxL = await browser.newContext({ storageState: vault2.sessionFile('sales-rep') });
    const pl = await ctxL.newPage();
    await pl.goto(`${demo.url}/logout`);
    await ctxL.close();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    const out = await vault2.signIn(page2, 'sales-rep');
    expect(out.reused).toBe(false);
    expect(new URL(page2.url()).pathname).toBe('/dashboard');
    await ctx2.close();
  });

  it('fails clearly on wrong credentials without leaking the password', async () => {
    const vault = makeVault();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const err = await vault.signIn(page, 'bad-bob').catch((e) => e);
    expect(err.code).toBe('LOGIN_FAILED');
    expect(err.message).toMatch(/Invalid username or password/);
    expect(err.message).not.toContain('wrong-password!');
    expect(masker.mask('wrong-password!')).toBe('****');
    expect(await vault.hasFreshSession('bad-bob')).toBe(false);
    await ctx.close();
    await expect(vault.signIn(page, 'nobody')).rejects.toThrow(/Unknown role "nobody"/);
  });

  it('provides API tokens per role', async () => {
    const vault = makeVault();
    const t1 = await vault.apiToken('sales-rep');
    expect(await vault.apiToken('sales-rep')).toBe(t1);
    const r = await fetch(`${demo.url}/api/orders`, { headers: { authorization: `Bearer ${t1}` } });
    expect(r.status).toBe(200);
    await expect(vault.apiToken('bad-bob')).rejects.toThrow(/no API credentials/);
  });

  it('rejects unsupported flows', () => {
    expect(() => makeVault({ roles: { x: { username: 'u', password: 'p-123', loginUrl: '/l', flow: 'saml' as 'form' } } })).toThrow(/not supported/);
  });
});

describe('WebAuthn virtual authenticator', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end('<!doctype html><title>passkey</title><p>passkey test</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    url = `http://localhost:${typeof a === 'object' && a ? a.port : 0}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it.skipIf(onFirefox)(chromiumOnly('registers a passkey on Chromium and exposes credentials (without private keys)', 'the WebAuthn virtual authenticator is a CDP feature'), async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url);
    const auth = await addVirtualAuthenticator(page, { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true });
    const created = await page.evaluate(async () => {
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: new Uint8Array(32),
          rp: { name: 'EZ Test', id: 'localhost' },
          user: { id: new Uint8Array([1, 2, 3, 4]), name: 'alice', displayName: 'Alice' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        },
      })) as PublicKeyCredential;
      return cred.type;
    });
    expect(created).toBe('public-key');
    const creds = await auth.getCredentials();
    expect(creds).toHaveLength(1);
    expect(creds[0].isResidentCredential).toBe(true);
    expect(creds[0].rpId).toBe('localhost');
    expect(Object.keys(creds[0])).not.toContain('privateKey');
    const got = await page.evaluate(async () => {
      const c = (await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', userVerification: 'required' } })) as PublicKeyCredential;
      return c.type;
    });
    expect(got).toBe('public-key');
    await auth.clearCredentials();
    expect(await auth.getCredentials()).toHaveLength(0);
    await auth.remove();
    await ctx.close();
  });

  it('throws NotSupportedError on non-Chromium browsers', async () => {
    const fakePage = { context: () => ({ browser: () => ({ browserType: () => ({ name: () => 'firefox' }) }) }) };
    await expect(addVirtualAuthenticator(fakePage as never)).rejects.toBeInstanceOf(NotSupportedError);
    const noCdp = { context: () => ({ browser: () => null, newCDPSession: async () => { throw new Error('no cdp'); } }) };
    await expect(addVirtualAuthenticator(noCdp as never)).rejects.toBeInstanceOf(NotSupportedError);
  });
});
