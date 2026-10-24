/**
 * Acceptance: an internal app behind a corporate single sign-on front door, the way enterprise apps are deployed
 * behind Citrix NetScaler, F5 or an SSO gateway. Real software in Docker (test/acceptance/enterprise/env/sso.sh):
 * oauth2-proxy (the gateway, sessions in Redis) in front of the Expenses app on http://app.ez.test:14180, and
 * Keycloak (the identity provider) on another host and port, http://gateway.ez.test:18180.
 *
 * Opening the app sends the browser to Keycloak's sign-in page; after the password (and a one-time code for
 * grace, a Terms page for linus on the first sign-in) the browser is sent back to the app with the gateway's
 * session cookie. The tests:
 *
 *   - record that sign-in in a visible browser, acting like a person (mouse and keyboard, under xvfb-run), and
 *     replay the recording with runJourneys (the password, and the TOTP secret for MFA, supplied at run time);
 *   - run hand-written .ez journeys: 20 journeys on 4 parallel workers sign in ONCE (Keycloak's own LOGIN events
 *     are counted), MFA, the Terms page, sign-out, a cached session that the gateway no longer honours, and a
 *     session that times out in the middle of a journey.
 *
 *   test/acceptance/enterprise/env/sso.sh up && xvfb-run -a npm test -- test/acceptance/enterprise/gateway-sso
 *
 * Skipped, with a message, when the gateway is not up; the recording tests also need a display.
 */
import { afterAll, beforeAll, describe, expect, it } from '../../support/testkit.js';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseEzScript } from '../../../src/intent/index.js';
import { base32Encode, freshTotp } from '../../../src/identity/totp.js';
import { startRecording, verifyRecording } from '../../../src/recorder/index.js';
import { runJourneys } from '../../../src/runner/index.js';
import { cli, failures, flat, humanClick, humanType, lastRun, urlUp } from './helpers.js';

const run = promisify(execFile);
const APP = (process.env.EZTEST_GATEWAY_APP_URL ?? 'http://app.ez.test:14180').replace(/\/$/, '');
const IDP = (process.env.EZTEST_GATEWAY_IDP_URL ?? 'http://gateway.ez.test:18180').replace(/\/$/, '');
const KC_ADMIN_PASSWORD = process.env.EZTEST_GATEWAY_KC_ADMIN_PASSWORD ?? 'EzKcAdmin_1';
const REDIS = process.env.EZTEST_GATEWAY_REDIS_CONTAINER ?? 'ez-sso-redis';
const DISPLAY = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
const FIXTURE = resolve(__dirname, 'fixtures/gateway');
const PASSWORDS = { ada: 'Ada#Gateway2026', grace: 'Grace#Gateway2026', linus: 'Linus#Gateway2026' };
/** grace's TOTP secret as Keycloak stores it (realm-corp.json); an authenticator app shows its base32 form. */
const GRACE_TOTP = base32Encode('EzGraceTotpSeed2026xyz').replace(/=+$/, '');

const skip = (await urlUp(`${APP}/ping`)) && (await urlUp(`${IDP}/realms/corp/.well-known/openid-configuration`))
  ? undefined
  : `the SSO gateway is not up at ${APP} / ${IDP}: run test/acceptance/enterprise/env/sso.sh up`;
if (skip) console.warn(`[acceptance] gateway SSO skipped: ${skip}`);
if (!skip && !DISPLAY) console.warn('[acceptance] gateway SSO: the recording tests are skipped without a display (run under xvfb-run -a)');

/** Keycloak's admin REST API: sign-in counts (LOGIN events), sessions, required actions. */
class KeycloakAdmin {
  private token = '';
  private at = 0;
  async auth(): Promise<void> {
    this.at = Date.now();
    const r = await fetch(`${IDP}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: KC_ADMIN_PASSWORD }) });
    this.token = ((await r.json()) as { access_token: string }).access_token;
  }
  async call(path: string, init: RequestInit = {}): Promise<unknown> {
    if (Date.now() - this.at > 30_000) await this.auth(); // admin tokens live 60 s
    const r = await fetch(`${IDP}/admin/realms/corp${path}`, { ...init, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`Keycloak admin ${init.method ?? 'GET'} ${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 || r.headers.get('content-length') === '0' ? undefined : r.json().catch(() => undefined);
  }
  async userId(username: string): Promise<string> {
    const [u] = (await this.call(`/users?username=${username}&exact=true`)) as Array<{ id: string }>;
    return u.id;
  }
  /** Successful sign-ins of a user at the identity provider since the events were cleared. */
  async logins(username: string): Promise<number> {
    const events = (await this.call(`/events?type=LOGIN&user=${await this.userId(username)}&max=1000`)) as unknown[];
    return events.length;
  }
  async requiredActions(username: string): Promise<string[]> {
    return ((await this.call(`/users/${await this.userId(username)}`)) as { requiredActions: string[] }).requiredActions;
  }
}

describe.skipIf(!!skip)('an app behind a corporate SSO gateway (oauth2-proxy + Keycloak, two hosts)', () => {
  const kc = new KeycloakAdmin();
  let project: string;
  const env: NodeJS.ProcessEnv = {
    ...process.env, GATEWAY_APP_URL: APP, SSO_ADA_PASSWORD: PASSWORDS.ada, SSO_GRACE_PASSWORD: PASSWORDS.grace, SSO_LINUS_PASSWORD: PASSWORDS.linus, SSO_GRACE_TOTP: GRACE_TOTP,
  };

  beforeAll(async () => {
    await kc.auth();
    // Count sign-ins with Keycloak's own events; start every user signed out, linus with the Terms still to accept.
    await kc.call('/events/config', { method: 'PUT', body: JSON.stringify({ eventsEnabled: true, enabledEventTypes: ['LOGIN', 'LOGIN_ERROR', 'LOGOUT', 'CODE_TO_TOKEN'], eventsExpiration: 3600 }) });
    await kc.call('/events', { method: 'DELETE' });
    for (const u of Object.keys(PASSWORDS)) await kc.call(`/users/${await kc.userId(u)}/logout`, { method: 'POST' });
    await kc.call(`/users/${await kc.userId('linus')}`, { method: 'PUT', body: JSON.stringify({ requiredActions: ['TERMS_AND_CONDITIONS'] }) });
    project = await mkdtemp(join(tmpdir(), 'eztest-accept-gateway-'));
    await cp(FIXTURE, project, { recursive: true });
  });

  afterAll(async () => {
    await kc.call('/events', { method: 'DELETE' }).catch(() => undefined);
  });

  describe.skipIf(!DISPLAY)('recorded like a person, replayed with runJourneys', () => {
    it('records the redirect to the identity provider, the sign-in and a form in the app; the replay passes', async () => {
      const rec = await startRecording({ url: `${APP}/`, name: 'Expense through the SSO gateway', viewport: { width: 1280, height: 860 } });
      const page = rec.page;
      try {
        // The app sent the browser to the identity provider on the other host.
        await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(`${IDP}/realms/corp/`);
        await humanClick(page, page.getByLabel('Username or email'));
        await humanType(page, 'ada');
        await humanClick(page, page.getByLabel('Password', { exact: true }));
        await humanType(page, PASSWORDS.ada);
        await humanClick(page, page.getByRole('button', { name: 'Sign In' }));
        await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(`${APP}/`);
        await humanClick(page, page.getByRole('link', { name: 'New expense' }));
        await humanClick(page, page.getByLabel('Description'));
        await humanType(page, 'Conference ticket');
        await humanClick(page, page.getByLabel('Amount'));
        await humanType(page, '199.00');
        // Pick the category from the keyboard after clicking its label (Firefox draws an open drop-down outside the
        // page, where automation's mouse and keys cannot reach; typing into the focused select works everywhere).
        await humanClick(page, page.locator('label[for=category]'));
        await humanType(page, 'M');
        // A date field takes its digits segment by segment (month, day, year here) from its first segment.
        const date = (await page.getByLabel('Date').boundingBox())!;
        await page.mouse.click(date.x + 12, date.y + date.height / 2);
        await humanType(page, '10012026');
        await humanClick(page, page.getByRole('button', { name: 'Submit expense' }));
        await expect.poll(() => page.getByRole('status').textContent().catch(() => ''), { timeout: 30_000 }).toContain('Conference ticket');
      } catch (e) {
        await rec.stop().catch(() => undefined);
        throw e;
      }
      const result = await rec.stop();
      const ez = result.ez;
      expect(ez).toContain(`Type "ada" into`);
      expect(ez).toMatch(/Type "\$\{password\}" into the Password field/);
      expect(ez).not.toContain(PASSWORDS.ada);
      expect(ez).toMatch(/Click the "New expense" link/);
      expect(ez).toMatch(/Type "Conference ticket" into the Description field/);
      expect(ez).toMatch(/Select "Meals" from the Category dropdown/);
      expect(ez).toMatch(/Type "2026-10-01" into the "Date" field/);
      // The sign-in's redirect chain (a form post to the identity provider, back to the app) is the page's doing,
      // not a URL the person opened: no "Open" of a one-time sign-in URL.
      expect(ez.match(/^Open /gm)).toHaveLength(1);
      // No one-time values of the sign-in (state, PKCE challenge, Keycloak session codes) are kept.
      expect(ez).not.toMatch(/session_code|tab_id|code_challenge|state=|client_data|execution=/);
      expect(result.variables).toEqual(['password']);

      // Replay the recording (runJourneys) and the saved .ez text, each in a fresh browser.
      const report = await verifyRecording(result, { variables: { password: PASSWORDS.ada }, outputDir: join(project, 'replay-1') });
      expect(report.failed).toEqual([]);
      const fromText = parseEzScript(ez, { source: 'recorded.ez' });
      const again = await runJourneys([fromText], { outputDir: join(project, 'replay-2'), baseUrl: result.baseUrl, variables: { password: PASSWORDS.ada } });
      expect(failures(again.journeys)).toEqual([]);
      expect(again.journeys[0].status).toBe('passed');
    }, 300_000);

    it('records an MFA sign-in: the one-time code becomes a step that computes a fresh code on replay', async () => {
      const rec = await startRecording({ url: `${APP}/expenses`, name: 'Approver with a one-time code', viewport: { width: 1280, height: 860 } });
      const page = rec.page;
      try {
        await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(`${IDP}/realms/corp/`);
        await humanClick(page, page.getByLabel('Username or email'));
        await humanType(page, 'grace');
        await humanClick(page, page.getByLabel('Password', { exact: true }));
        await humanType(page, PASSWORDS.grace);
        await humanClick(page, page.getByRole('button', { name: 'Sign In' }));
        // The authenticator app: the code of this 30-second window.
        const otp = page.locator('#otp');
        await expect.poll(() => otp.isVisible(), { timeout: 30_000 }).toBe(true);
        await humanClick(page, otp);
        await humanType(page, await freshTotp(GRACE_TOTP));
        await humanClick(page, page.locator('#kc-login'));
        await expect.poll(() => page.url(), { timeout: 30_000 }).toBe(`${APP}/expenses`);
      } catch (e) {
        await rec.stop().catch(() => undefined);
        throw e;
      }
      const result = await rec.stop();
      expect(result.ez).toMatch(/Type the one-time code from \$\{totpSecret\} into the One-time code field/);
      expect(result.ez.match(/^Open /gm)).toHaveLength(1);
      expect(result.ez).not.toMatch(/Type "\d{6}"/);
      expect(result.variables).toEqual(['password', 'totpSecret']);
      // The code typed while recording was used once; the replay types a new one (Keycloak refuses reuse).
      const report = await verifyRecording(result, { variables: { password: PASSWORDS.grace, totpSecret: GRACE_TOTP }, outputDir: join(project, 'replay-mfa') });
      expect(report.failed).toEqual([]);
    }, 300_000);
  });

  describe('hand-written .ez journeys in a project (eztest run)', () => {
    it('20 journeys on 4 parallel workers sign in once and reuse the session; MFA and a Terms page work', async () => {
      await kc.call('/events', { method: 'DELETE' });
      const r = await cli(project, ['run', 'journeys', '--grep', 'Submit an expense|one-time code|terms of use', '--workers', '4'], env);
      const { run: result } = await lastRun(project);
      expect(failures(result.journeys)).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(result.journeys.filter((j) => j.name.startsWith('Submit an expense'))).toHaveLength(20);
      // The identity provider saw one sign-in per user for the whole run.
      expect(await kc.logins('ada')).toBe(1);
      expect(await kc.logins('grace')).toBe(1);
      expect(await kc.logins('linus')).toBe(1);
      // linus accepted the Terms page on the way (Keycloak removed the required action).
      expect(await kc.requiredActions('linus')).toEqual([]);
      // Secrets never reach the results.
      const shown = JSON.stringify(result);
      for (const secret of [...Object.values(PASSWORDS), GRACE_TOTP]) expect(shown).not.toContain(secret);
    }, 600_000);

    it('a cached session the gateway no longer honours is not reused: sign-out, and a server-side time-out', async () => {
      // Sign-out: the journey ends the gateway and the identity provider sessions; the next journey signs in again.
      await kc.call('/events', { method: 'DELETE' });
      let r = await cli(project, ['run', 'journeys', '--grep', 'Signing out'], env);
      let { run: result } = await lastRun(project);
      expect(failures(result.journeys)).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(await kc.logins('ada')).toBe(0); // the cached session from the earlier run was reused for the sign-out
      r = await cli(project, ['run', 'journeys', '--grep', 'Submit an expense', '--workers', '2'], env);
      ({ run: result } = await lastRun(project));
      expect(failures(result.journeys)).toEqual([]);
      expect(await kc.logins('ada')).toBe(1);

      // A time-out on the gateway's side (its Redis sessions dropped): the cookies in the cached session file are
      // still there but worthless; the session check notices the redirect to the identity provider.
      await run('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL'], { timeout: 20_000 });
      r = await cli(project, ['run', 'journeys', '--grep', 'Submit an expense', '--workers', '2'], env);
      ({ run: result } = await lastRun(project));
      expect(failures(result.journeys)).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(await kc.logins('ada')).toBe(2);
    }, 600_000);

    it('a session that times out in the middle of a journey: the runner signs in again and the step goes on', async () => {
      const r = await cli(project, ['run', 'journeys', '--grep', 'times out mid-journey'], env);
      const { run: result } = await lastRun(project);
      const j = result.journeys[0];
      expect(j.status, failures(result.journeys).join('\n')).toBe('passed');
      expect(r.exitCode).toBe(0);
      // The re-login is on record: which step, why (the identity provider's sign-in page), as which role.
      expect(j.reliability?.relogins).toEqual([expect.objectContaining({ stepId: 'open-expenses', role: 'employee', reason: expect.stringMatching(/sign in to your account/i) })]);
      expect(flat(j.steps).filter((s) => s.intent === 'Open /expenses').at(-1)?.status).toBe('passed');
    }, 300_000);

    it('a wrong password at the identity provider fails with its message, and never shows the password', async () => {
      const wrong = { ...env, SSO_ADA_PASSWORD: 'Not-The-Password-1' };
      await writeFile(join(project, 'journeys', 'wrong.ez'), 'Journey: Wrong password at the identity provider\nRole: employee\n\nLog in\n');
      await rm(join(project, '.eztest', 'sessions'), { recursive: true, force: true }); // no cached session to reuse
      const r = await cli(project, ['run', 'journeys', '--grep', 'Wrong password'], wrong);
      expect(r.exitCode).toBe(1);
      const { run: result } = await lastRun(project);
      const msg = result.journeys[0].steps[0].error?.message ?? '';
      expect(msg).toMatch(/Role employee: login failed: Invalid username or password/);
      expect(JSON.stringify(result)).not.toContain('Not-The-Password-1');
    }, 300_000);
  });
});
