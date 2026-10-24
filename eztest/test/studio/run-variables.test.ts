/**
 * A recorded login types `${password}` and the project does not set it. EZTest must not type the placeholder
 * (the app would answer "Invalid credentials" and the failure would look like the app's); the run fails with
 * MISSING_VARIABLE and says how to supply it. Supplied from the Studio Run page, `eztest run --var` or
 * `EZTEST_VAR_password`, the same journey passes, and the value never appears in results.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { buildProgram } from '../../src/cli/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, readSse } from './helpers.js';

const SECRET = 'Sup3r-s3cret!';
let site: Server;
let base: string;
const posted: string[] = [];
let dir: string;
let studio: StudioHandle;
let c: ReturnType<typeof client>;
let browser: Browser;
let page: Page;

const LOGIN = `<!doctype html><title>Login</title><form method="post" action="/login">
<label for="u">Username</label><input id="u" name="username"><label for="p">Password</label><input id="p" name="password" type="password">
<button type="submit">Login</button></form>`;

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.method === 'POST') {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        const pw = new URLSearchParams(b).get('password') ?? '';
        posted.push(pw);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(pw === SECRET ? '<h1>Welcome</h1>' : '<p>Invalid credentials</p>');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(LOGIN);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const a = site.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  dir = await mkdtemp(join(tmpdir(), 'eztest-run-vars-'));
  await mkdir(join(dir, 'journeys'));
  await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: ${base}\njourneysDir: journeys\noutputDir: results\nreporters: [json]\n`);
  await writeFile(
    join(dir, 'journeys', 'login.ez'),
    'Journey: Login\nId: login\nOpen "/"\nType "Admin" into the "Username" field\nType "${password}" into the "Password" field\nClick the "Login" button\n  Expect page contains "Welcome"\n',
  );
  await writeFile(join(dir, 'journeys', 'plain.ez'), 'Journey: Plain\nId: plain\nOpen "/"\n');
  studio = await startStudio({ cwd: dir, watch: false });
  c = client(studio.port, studio.token);
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await new Promise<void>((r) => site.close(() => r()));
});

async function runToEnd(body: Record<string, unknown>) {
  const start = await c.post('/api/runs', body);
  expect(start.status).toBe(202);
  const { id } = start.json();
  await readSse(studio.port, `/api/runs/${id}/events`, studio.token, (e) => e.type === 'done');
  return { id, detail: (await c.get(`/api/runs/${id}`)).json() };
}

async function resultsText(): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(json|html|txt|log|ndjson)$/.test(e.name)) out.push(await readFile(p, 'utf8'));
    }
  };
  await walk(join(dir, 'results'));
  return out.join('\n');
}

describe('run-time variables', () => {
  it('lists what the selected journeys need, secret names flagged', async () => {
    expect((await c.post('/api/runs/needs', { journeys: ['login'] })).json().variables).toEqual([{ name: 'password', secret: true, journeys: ['login'] }]);
    expect((await c.post('/api/runs/needs', { journeys: ['plain'] })).json().variables).toEqual([]);
  });

  it('without a value the run fails with MISSING_VARIABLE and never submits the placeholder', async () => {
    posted.length = 0;
    const { detail } = await runToEnd({ journeys: ['login'] });
    expect(posted).toEqual([]);
    const text = JSON.stringify(detail);
    expect(text).toMatch(/\$\{password\} has no value/);
    expect(text).toMatch(/--var password=/);
  });

  it('rejects malformed variables', async () => {
    expect((await c.post('/api/runs', { journeys: ['login'], variables: ['x'] })).status).toBe(400);
    expect((await c.post('/api/runs', { journeys: ['login'], variables: { 'not a name': 'x' } })).status).toBe(400);
    expect((await c.post('/api/runs', { journeys: ['login'], variables: { password: 1 } })).status).toBe(400);
  });

  it('with the value from the Run page API the journey passes and the value is masked', async () => {
    posted.length = 0;
    const { id, detail } = await runToEnd({ journeys: ['login'], variables: { password: SECRET } });
    expect(posted).toEqual([SECRET]);
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(JSON.stringify(detail)).toMatch(/"status":"passed"/);
    expect(JSON.stringify((await c.get('/api/runs')).json())).not.toContain(SECRET);
    expect(await resultsText()).not.toContain(SECRET);
    expect(id).toMatch(/^run-/);
  });

  it('the Run page shows a masked Variables field for the selected journey and runs with it', async () => {
    posted.length = 0;
    await page.goto(studio.url);
    await page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name: 'Run', exact: true }).click();
    await page.getByRole('group', { name: 'Journeys to run' }).getByRole('checkbox', { name: /Login/ }).check();
    const field = page.getByRole('group', { name: 'Variables' }).getByLabel('password');
    await expect.poll(() => field.isVisible()).toBe(true);
    expect(await field.getAttribute('type')).toBe('password');
    // Start without the value: the page asks for it instead of starting.
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.locator('#run-status').textContent()).toMatch(/Enter a value for password/);
    await field.fill(SECRET);
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.locator('#run-status').getAttribute('data-state'), { timeout: 60_000 }).toBe('complete');
    expect(posted).toEqual([SECRET]);
  });

  it('eztest run --var and EZTEST_VAR_<name> supply it on the command line', async () => {
    const cli = async (args: string[], env: NodeJS.ProcessEnv) => {
      const before = process.exitCode;
      process.exitCode = 0;
      await buildProgram({ out: () => undefined, err: () => undefined, cwd: dir, env }).exitOverride().parseAsync(['node', 'eztest', 'run', ...args]);
      const code = process.exitCode;
      process.exitCode = before;
      return code;
    };
    posted.length = 0;
    expect(await cli(['journeys/login.ez', '--var', `password=${SECRET}`], process.env)).toBe(0);
    expect(await cli(['journeys/login.ez'], { ...process.env, EZTEST_VAR_password: SECRET })).toBe(0);
    expect(posted).toEqual([SECRET, SECRET]);
    expect(await cli(['journeys/login.ez'], process.env)).not.toBe(0);
    expect(posted).toEqual([SECRET, SECRET]);
  });
});
