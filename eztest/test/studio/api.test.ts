/**
 * Studio API: authentication, DNS-rebinding and origin guards, CSRF rules,
 * path confinement and the authoring endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject, raw } from './helpers.js';

let studio: StudioHandle;
let project: string;
let outside: string;
let c: ReturnType<typeof client>;

beforeAll(async () => {
  project = await copyShopProject();
  outside = await mkdtemp(join(tmpdir(), 'eztest-outside-'));
  await writeFile(join(outside, 'secret.ez'), 'Journey: outside\nOpen /\n');
  await writeFile(join(project, '.env'), 'SHOP_BOB_PASSWORD=Builder#2\n');
  await symlink(outside, join(project, 'journeys', 'linked'));
  await symlink(join(outside, 'secret.ez'), join(project, 'journeys', 'escape.ez'));
  studio = await startStudio({ cwd: project, env: { SHOP_LITERAL: 'x' } });
  c = client(studio.port, studio.token);
});

afterAll(async () => {
  await studio?.close();
  await rm(outside, { recursive: true, force: true });
});

describe('Studio security', () => {
  it('binds to 127.0.0.1 and hands out a tokenized URL', () => {
    expect(studio.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${studio.port}/\\?token=[0-9a-f]{64}$`));
    expect(studio.token).toHaveLength(64);
  });

  it('requires the token on every API call (401 without or with a wrong one)', async () => {
    expect((await raw(studio.port, '/api/journeys')).status).toBe(401);
    expect((await raw(studio.port, '/api/journeys', { headers: { 'x-eztest-token': 'f'.repeat(64) } })).status).toBe(401);
    expect((await raw(studio.port, '/api/grammar', { headers: { authorization: `Bearer ${studio.token}` } })).status).toBe(200);
    expect((await raw(studio.port, '/runs/x/run.json')).status).toBe(401);
  });

  it('serves the page only with the token, then sets an HttpOnly SameSite=Strict cookie', async () => {
    const denied = await raw(studio.port, '/');
    expect(denied.status).toBe(401);
    expect(denied.body).not.toContain(studio.token);
    const ok = await raw(studio.port, `/?token=${studio.token}`);
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(ok.headers['content-security-policy']).toMatch(/script-src 'self'/);
    // The cookie authenticates GET requests (page, SSE, images)...
    const viaCookie = await raw(studio.port, '/api/journeys', { headers: { cookie: `eztest_studio=${studio.token}` } });
    expect(viaCookie.status).toBe(200);
    // ...but never state-changing requests: those need the header (CSRF-safe).
    const csrf = await raw(studio.port, '/api/validate', {
      method: 'POST',
      headers: { cookie: `eztest_studio=${studio.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Journey: x\nOpen /\n' }),
    });
    expect(csrf.status).toBe(401);
  });

  it('rejects foreign Host headers (DNS rebinding) and foreign origins with 403', async () => {
    const h = { 'x-eztest-token': studio.token };
    expect((await raw(studio.port, '/api/journeys', { headers: { ...h, host: `evil.example:${studio.port}` } })).status).toBe(403);
    expect((await raw(studio.port, '/api/journeys', { headers: { ...h, host: `127.0.0.1:1` } })).status).toBe(403);
    expect((await raw(studio.port, `/?token=${studio.token}`, { headers: { host: 'attacker.test' } })).status).toBe(403);
    expect((await raw(studio.port, '/api/journeys', { headers: { ...h, host: `localhost:${studio.port}` } })).status).toBe(200);
    expect((await raw(studio.port, '/api/journeys', { headers: { ...h, origin: 'http://evil.example' } })).status).toBe(403);
    expect((await raw(studio.port, '/api/journeys', { headers: { ...h, origin: 'null' } })).status).toBe(403);
    expect((await raw(studio.port, '/api/journeys', { headers: { ...h, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await raw(studio.port, '/api/journeys', { headers: { ...h, origin: `http://127.0.0.1:${studio.port}` } })).status).toBe(200);
    const r = await raw(studio.port, '/api/journeys', { headers: h });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires a JSON content type on writes', async () => {
    const r = await raw(studio.port, '/api/validate', { method: 'POST', headers: { 'x-eztest-token': studio.token, 'content-type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(415);
  });

  it('refuses path traversal, absolute paths, symlink escapes, secrets and non-journey files', async () => {
    const bad = ['../outside.ez', 'journeys/../../x.ez', '/etc/passwd', join(outside, 'secret.ez'), 'journeys/linked/secret.ez', 'journeys/escape.ez', '.env', 'eztest.config.yaml', 'readiness-policy.yaml', 'templates/../.env'];
    for (const p of bad) {
      const r = await c.get(`/api/file?path=${encodeURIComponent(p)}`);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.status, p).toBeLessThan(500);
      expect(r.body).not.toContain('Builder#2');
    }
    for (const p of ['../evil.ez', 'journeys/linked/new.ez', '/tmp/evil.ez', 'journeys/x.sh', 'journeys/.hidden.ez', 'eztest-results/x.ez']) {
      const r = await c.put('/api/file', { path: p, content: 'Journey: evil\nOpen /\n' });
      expect(r.status, p).toBe(403);
    }
    expect(existsSync(join(outside, 'new.ez'))).toBe(false);
    expect((await c.get('/api/fs?dir=..')).status).toBe(403);
    expect((await c.get('/api/fs?dir=journeys%2Flinked')).status).toBe(403);
    const root = (await c.get('/api/fs?dir=.')).json();
    expect(root.entries.map((e: { name: string }) => e.name)).not.toContain('.env');
    expect((await c.post('/api/import/preview', { paths: ['../'] })).status).toBe(403);
    expect((await c.post('/api/import/preview', { paths: ['.env'] })).status).toBe(403);
  });

  it('refuses run-dir paths that escape the run directory', async () => {
    const outDir = join(project, 'eztest-results', 'run-fake');
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'run.json'), '{}');
    expect((await c.get('/runs/run-fake/run.json')).status).toBe(200);
    expect((await c.get('/runs/run-fake/..%2F..%2F.env')).status).toBeGreaterThanOrEqual(400);
    expect((await c.get('/runs/..%2F..%2Fetc/passwd')).status).toBeGreaterThanOrEqual(400);
    expect((await c.get('/runs/run-fake/%2Fetc%2Fpasswd')).status).toBe(403);
  });
});

describe('Studio authoring API', () => {
  it('lists journeys with tags, risk and requirements', async () => {
    const r = (await c.get('/api/journeys')).json();
    const login = r.journeys.find((j: { path: string }) => j.path === 'journeys/login-mfa.ez');
    expect(login).toMatchObject({ name: 'Sales rep signs in with MFA', tags: ['smoke', 'identity'], risk: 5, requirements: ['AUTH-1'], steps: 2 });
  });

  it('validates with line-numbered errors and suggestions (every bad line)', async () => {
    const content = ['Journey: Broken', 'Tags: @x', '', 'Opne /login', 'Click the "Sign in" button', 'Clik the Save button', 'Expect the frobnicator to wibble wobble'].join('\n');
    const r = (await c.post('/api/validate', { content, format: 'ez' })).json();
    expect(r.ok).toBe(false);
    const lines = r.errors.map((e: { line: number }) => e.line);
    expect(lines).toEqual([4, 6, 7]);
    expect(r.errors[0].suggestions).toContain('Open /login');
    expect(r.errors[1].suggestions.some((s: string) => s.startsWith('Click'))).toBe(true);
    expect(r.errors[0].message).toMatch(/line 4/);
    const good = (await c.post('/api/validate', { content: 'Journey: Fine\nOpen /login\nExpect the URL to contain "/login"\n', format: 'ez' })).json();
    expect(good).toMatchObject({ ok: true, journey: { name: 'Fine', steps: 1 } });
    const header = (await c.post('/api/validate', { content: 'Journey: X\nRisk: 9\nOpen /\n' })).json();
    expect(header.errors[0].line).toBe(2);
    const yaml = (await c.post('/api/validate', { content: 'name: Y\nsteps:\n  - Opne /x\n', format: 'yaml' })).json();
    expect(yaml.ok).toBe(false);
  });

  it('round-trips save and read, and creates journeys from a template', async () => {
    const content = 'Journey: Saved by studio\nTags: @studio\nOpen /login\n';
    const s = await c.put('/api/file', { path: 'journeys/studio/saved.ez', content });
    expect(s.status).toBe(200);
    expect(s.json()).toMatchObject({ saved: 'journeys/studio/saved.ez', validation: { ok: true } });
    const r = (await c.get('/api/file?path=journeys%2Fstudio%2Fsaved.ez')).json();
    expect(r).toMatchObject({ path: 'journeys/studio/saved.ez', format: 'ez', content });
    expect(await readFile(join(project, 'journeys/studio/saved.ez'), 'utf8')).toBe(content);
    expect((await c.put('/api/file', { path: 'journeys/studio/saved.ez', content, create: true })).status).toBe(409);

    const created = await c.post('/api/journeys', { path: 'journeys/new-one.ez', name: 'Brand new' });
    expect(created.status).toBe(201);
    expect(created.json().content).toMatch(/^Journey: Brand new/);
    expect((await c.post('/api/validate', { content: created.json().content })).json().ok).toBe(true);
    expect((await c.post('/api/journeys', { path: 'journeys/new-one.ez', name: 'Again' })).status).toBe(409);
    const y = await c.post('/api/journeys', { path: 'journeys/new-two.yaml', name: 'Yaml one' });
    expect(y.json().content).toMatch(/name: Yaml one/);
  });

  it('converts between .ez and YAML (preview only)', async () => {
    const ez = 'Journey: Convert me\nOpen /login\nClick the "Sign in" button\nExpect the URL to contain "/dashboard"\n';
    const y = (await c.post('/api/convert', { content: ez, from: 'ez', to: 'yaml' })).json();
    expect(y.content).toMatch(/name: Convert me/);
    const back = (await c.post('/api/convert', { content: y.content, from: 'yaml', to: 'ez' })).json();
    expect(back.content).toMatch(/Click the "Sign in" button/);
    expect(back.content).toMatch(/URL contains "\/dashboard"/);
    expect((await c.post('/api/convert', { content: 'nonsense', from: 'ez', to: 'yaml' })).status).toBe(422);
  });

  it('exposes grammar phrasings grouped by category', async () => {
    const r = (await c.get('/api/grammar')).json();
    const cats = r.groups.map((g: { category: string }) => g.category);
    expect(cats).toEqual(expect.arrayContaining(['Navigate', 'Click and mouse', 'Type', 'Assertions', 'Expect: Page text', 'Headers']));
    const all = r.groups.flatMap((g: { examples: Array<{ text: string }> }) => g.examples.map((e) => e.text));
    expect(all).toContain('Open /login');
    expect(all).toContain('Expect the page contains "Saved"');
    expect(r.groups.find((g: { category: string }) => g.category === 'Expect: Counts').examples.length).toBeGreaterThan(2);
  });

  it('shows settings with secrets masked and doctor info', async () => {
    const r = (await c.get('/api/settings')).json();
    expect(r.ok).toBe(true);
    expect(r.config.identity.roles.manager.password).toBe('secret://env/BOB_PASSWORD');
    expect(JSON.stringify(r)).not.toContain('Builder#2');
    expect(r.doctor.node).toMatch(/\d+\.\d+/);
    expect(r.doctor).toHaveProperty('chromium');
  });

  it('previews and writes an import inside the project', async () => {
    await mkdir(join(project, 'legacy'), { recursive: true });
    await writeFile(
      join(project, 'legacy', 'login.feature'),
      'Feature: Login\n  Scenario: Sign in\n    Given I open "/login"\n    When I click the "Sign in" button\n    Then I should see "Welcome"\n',
    );
    const p = await c.post('/api/import/preview', { paths: ['legacy'] });
    expect(p.status).toBe(200);
    expect(p.json().journeys[0]).toMatchObject({ kind: 'gherkin', runnable: true });
    expect(p.json().journeys[0].ez).toMatch(/Journey: Login - Sign in/);
    expect((await c.post('/api/import/write', { paths: ['legacy'], outDir: '../x' })).status).toBe(403);
    const w = await c.post('/api/import/write', { paths: ['legacy/login.feature'], outDir: 'journeys/imported' });
    expect(w.status).toBe(200);
    expect(w.json().written.ezFiles[0]).toMatch(/^journeys\/imported\/.+\.ez$/);
    expect(existsSync(join(project, w.json().written.ezFiles[0]))).toBe(true);
  });

  it('answers cancel of an unknown run with 404 and rejects bad run ids', async () => {
    const del = await c.del("/api/runs/run-nope"); expect(del.status, del.body).toBe(404);
    expect((await c.get('/api/runs/a%2F..%2Fb')).status).toBe(400);
    expect((await c.get('/api/runs/..')).status).toBe(404);
    expect((await c.get('/api/runs/run-missing')).status).toBe(404);
  });
});
