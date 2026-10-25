/**
 * Sign-in without `fields:` on a form whose own label matches the username patterns: saucedemo's
 * `<form aria-label="Login">` holds inputs labelled only by aria-label and a `<input type=submit value=Login>`.
 * The username was looked up by label (/user ?name|e-?mail|login|user id/), the form came first, and
 * `fill` failed with "the element takes no typed text". Fields are now inputs that take text. Real browser,
 * a local copy of saucedemo's form.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from '../../src/browser/index.js';
import { SecretMasker } from '../../src/config/index.js';
import { IdentityVault, MemorySecretStore, SecretRegistry } from '../../src/identity/index.js';

const LOGIN = `<!doctype html><html><head><title>Swag Labs</title></head><body><div class="login_logo">Swag Labs</div>
<form aria-label="Login"><div class="form_group"><input class="input_error form_input" placeholder="Username" aria-label="Username" data-test="username" id="user-name" type="text" value="" name="user-name"></div>
<div class="form_group"><input class="input_error form_input" placeholder="Password" aria-label="Password" data-test="password" id="password" type="password" value="" name="password"></div>
<div class="error-message-container"></div><input class="submit-button btn_action" data-test="login-button" id="login-button" type="submit" value="Login" name="login-button"></form>
<div id="login_credentials"><h4>Accepted usernames are:</h4>standard_user</div>
<script>
document.querySelector('form').addEventListener('submit', function (e) {
  e.preventDefault();
  var u = document.getElementById('user-name').value, p = document.getElementById('password').value;
  if (u === 'standard_user' && p === 'secret_sauce') { document.cookie = 'session-username=' + u + '; path=/'; location.href = '/inventory.html'; }
  else document.querySelector('.error-message-container').innerHTML = '<h3 data-test="error">Epic sadface: Username and password do not match any user in this service</h3>';
});
</script></body></html>`;

let server: Server;
let base = '';
let browser: Browser;
let dir = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(path === '/inventory.html' ? '<!doctype html><title>Swag Labs</title><span class="title">Products</span>' : LOGIN);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  dir = mkdtempSync(join(tmpdir(), 'eztest-login-label-'));
});

afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const vault = (password: string) => new IdentityVault({
  baseUrl: base, environment: 'test', sessionDir: join(dir, password),
  registry: new SecretRegistry([new MemorySecretStore({ pw: password }, 'vault')], new SecretMasker()),
  roles: { shopper: { username: 'standard_user', password: 'secret://vault/pw', loginUrl: '/', successUrl: '/inventory.html' } },
});

describe('sign-in on a form labelled "Login" (saucedemo)', () => {
  it('finds the Username field, not the form, without fields:', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const r = await vault('secret_sauce').signIn(page, 'shopper');
    expect(r.reused).toBe(false);
    expect(new URL(page.url()).pathname).toBe('/inventory.html');
    await ctx.close();
  }, 60_000);

  it('a wrong password is reported with the page\'s message', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const err = await vault('wrong').signIn(page, 'shopper').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Username and password do not match/);
    expect((err as Error).message).not.toMatch(/takes no typed text/);
    await ctx.close();
  }, 60_000);
});
