/**
 * The record-then-run loop a new user goes through first: a project whose config points somewhere else
 * (`baseUrl: http://localhost:3000`, what `eztest init` writes), a login recorded on another site, an
 * expectation typed the way testers write it while the last field is still being typed, a click on a page
 * title. The recording must replay green with the project's own config.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { startRecording, type RecordingResult } from '../../src/recorder/index.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOGIN = `<!doctype html><title>OrangeHRM</title>
<form action="/web/index.php/auth/validate" method="post">
  <p><label for="u">Username</label> <input id="u" name="username"></p>
  <p><label for="p">Password</label> <input id="p" name="password" type="password"></p>
  <p><button type="submit">Login</button></p>
</form>`;
// The title bar wraps its <h6> in a div, and "Dashboard" is also a menu link, as on the real product.
const DASHBOARD = `<!doctype html><title>OrangeHRM</title>
<nav><a href="/web/index.php/dashboard/index">Dashboard</a> <a href="/web/index.php/admin/viewSystemUsers">Admin</a></nav>
<header><div class="oxd-topbar-header-title"><span><h6 class="oxd-text">Dashboard</h6></span></div></header>
<main><p>Time at Work</p></main>`;

let server: Server;
let site: string;
let result: RecordingResult;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'POST' && path === '/web/index.php/auth/validate') {
      res.writeHead(302, { location: '/web/index.php/dashboard/index' });
      return void res.end();
    }
    const body = path === '/web/index.php/auth/login' ? LOGIN : path.startsWith('/web/index.php/dashboard') ? DASHBOARD : undefined;
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  site = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

  const rec = await startRecording({
    url: `${site}/web/index.php/auth/login`,
    headless: true,
    name: 'orangehrm login',
    project: { baseUrl: 'http://localhost:3000' },
  });
  const page = rec.page;
  await page.getByLabel('Username').fill('Admin');
  await page.getByLabel('Password').fill('admin123');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL('**/dashboard/index');
  // A click on the title bar (a plain div around the heading), then an expectation in a tester's words.
  await page.locator('div.oxd-topbar-header-title').click();
  await rec.addExpectation('verify user lands on "Dashboard" screen');
  result = await rec.stop();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('record, then run, in a project that points elsewhere', () => {
  it('writes the recorded site as the Base URL and describes the title click in words', () => {
    const lines = result.ez.split('\n').map((l) => l.trim());
    expect(lines).toContain(`Base URL: ${site}`);
    expect(result.ez).not.toMatch(/css=/);
    expect(lines.some((l) => /^Click the "Dashboard" heading$/.test(l))).toBe(true);
    expect(lines.some((l) => /^Expect page contains "Dashboard"$/.test(l))).toBe(true);
  });

  it('attaches the expectation to the step just recorded, not to an earlier one', () => {
    const j = parseEzScript(result.ez, { source: 'recorded.ez' });
    const last = j.steps[j.steps.length - 1];
    expect(last.intent).toMatch(/Dashboard/);
    expect((last.postconditions ?? []).length).toBe(1);
    const open = j.steps[0];
    expect(open.postconditions ?? []).toEqual([]);
  });

  it('replays green with the project config, password supplied as a variable', async () => {
    const j = parseEzScript(result.ez, { source: 'recorded.ez' });
    const run = await runJourneys([j], {
      baseUrl: 'http://localhost:3000',
      outputDir: await mkdtemp(join(tmpdir(), 'ez-roundtrip-')),
      headless: true,
      variables: { password: 'admin123' },
    });
    const jr = run.journeys[0];
    expect(jr.steps.filter((s) => s.status === 'failed').map((s) => `${s.intent}: ${s.error?.message ?? ''}`)).toEqual([]);
    expect(jr.status).toBe('passed');
  });
});

describe('expectations in the words testers use', () => {
  it.each([
    ['user lands on "Dashboard" screen', 'Dashboard'],
    ['user lands on Dashboard', 'Dashboard'],
    ['I am on the Orders page', 'Orders'],
    ['user is redirected to Login', 'Login'],
    ['the "Dashboard" screen is displayed', 'Dashboard'],
    ['Orders page is shown', 'Orders'],
  ])('%s', async (text, value) => {
    const j = parseEzScript(`Journey: words\n\nOpen /\n  Expect ${text}\n`, { source: 'w.ez' });
    expect(j.steps[0].postconditions?.[0]).toEqual({ type: 'pageContainsText', value });
  });
});
