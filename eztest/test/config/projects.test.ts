import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptValue, listProjects, loadConfig, loadHolidays, parseHolidays, SecretMasker } from '../../src/config/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eztest-projects-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (p: string, text: string) => {
  mkdirSync(join(dir, p, '..'), { recursive: true });
  writeFileSync(join(dir, p), text);
};
const load = (o: { project?: string; env?: string; environment?: Record<string, string>; overrides?: Record<string, unknown> } = {}) =>
  loadConfig({ cwd: dir, masker: new SecretMasker(), environment: o.environment ?? {}, project: o.project, env: o.env, overrides: o.overrides });

describe('projects overlay', () => {
  beforeEach(() => {
    write('eztest.config.yaml', `
baseUrl: https://base.example.test
retries: 0
timeouts: { step: 1000 }
vars:
  APP: base
projects:
  shop:
    baseUrl: https://shop.example.test
    retries: 1
    timeouts: { navigation: 2000 }
    vars: { APP: shop }
    environments:
      dev:
        retries: 2
        concurrency: 3
  admin:
    baseUrl: \${ADMIN_URL}
`);
    write('config/dev.yaml', 'retries: 5\nconcurrency: 2\nheadless: false\nlogLevel: warn\n');
    write('config/shop/dev.yaml', 'concurrency: 4\n');
    write('.env.shop.dev', 'EZTEST_LOG_LEVEL=debug\n');
  });

  it('applies base < project < config/<env> < projects.<p>.environments.<env> < config/<p>/<env> < .env < EZTEST_* < CLI', async () => {
    const base = await load();
    expect(base.config).toMatchObject({ baseUrl: 'https://base.example.test', retries: 0, vars: { APP: 'base' } });
    expect(base.project).toBeUndefined();

    const shop = await load({ project: 'shop' });
    expect(shop.config).toMatchObject({ project: 'shop', baseUrl: 'https://shop.example.test', retries: 1, timeouts: { step: 1000, navigation: 2000 }, vars: { APP: 'shop' } });
    expect(shop.sources).toContain('projects.shop');

    const dev = await load({ project: 'shop', env: 'dev' });
    // config/dev.yaml (retries 5) < projects.shop.environments.dev (retries 2, concurrency 3) < config/shop/dev.yaml (concurrency 4) < .env.shop.dev
    expect(dev.config).toMatchObject({ retries: 2, concurrency: 4, headless: false, logLevel: 'debug', environment: 'dev' });
    expect(dev.sources.map((s) => s.replace(dir, ''))).toEqual([
      'defaults', '/eztest.config.yaml', 'projects.shop', '/config/dev.yaml', 'projects.shop.environments.dev', '/config/shop/dev.yaml', '/.env.shop.dev',
    ]);
    const top = await load({ project: 'shop', env: 'dev', environment: { EZTEST_CONCURRENCY: '7', EZTEST_PROJECT: 'admin' }, overrides: { concurrency: 9 } });
    expect(top.config.concurrency).toBe(9);
    expect(top.config.project).toBe('shop'); // the explicit project wins over EZTEST_PROJECT
  });

  it('takes the project from EZTEST_PROJECT, rejects unknown projects, and never interpolates other projects', async () => {
    // admin's ${ADMIN_URL} is unset: loading shop must not fail because of it.
    await expect(load({ project: 'shop' })).resolves.toBeTruthy();
    await expect(load({ environment: { EZTEST_PROJECT: 'admin' } })).rejects.toThrow(/ADMIN_URL\} is not set/);
    const admin = await load({ environment: { EZTEST_PROJECT: 'admin', ADMIN_URL: 'https://admin.example.test' } });
    expect(admin.config).toMatchObject({ project: 'admin', baseUrl: 'https://admin.example.test' });
    expect((admin.config.projects.admin as { baseUrl: string }).baseUrl).toBe('${ADMIN_URL}');
    await expect(load({ project: 'nope' })).rejects.toThrow(/Unknown project "nope" \(known: shop, admin\)/);
    await expect(load({ project: '../x' })).rejects.toThrow(/Invalid project name/);
    expect(listProjects({ cwd: dir, environment: {} })).toEqual(['admin', 'shop']);
  });
});

describe('config vars and shape normalisation', () => {
  it('resolves vars against each other and the environment (environment wins), decrypts ENC() vars, and exposes them for ${} interpolation', async () => {
    const key = 'master-key-for-tests-0123';
    write('eztest.config.yaml', `
vars:
  HOST: http://127.0.0.1:9
  BASE: \${HOST}/app
  UNRESOLVED: \${NOT_SET}/x
  API_PASSWORD: ${encryptValue('s3cret-pw', key)}
baseUrl: \${BASE}/
`);
    const masker = new SecretMasker();
    const l = await loadConfig({ cwd: dir, masker, environment: { EZTEST_MASTER_KEY: key } });
    expect(l.config.baseUrl).toBe('http://127.0.0.1:9/app/');
    expect(l.config.vars).toEqual({ HOST: 'http://127.0.0.1:9', BASE: 'http://127.0.0.1:9/app', UNRESOLVED: '${NOT_SET}/x', API_PASSWORD: 's3cret-pw' });
    expect(masker.mask('pw s3cret-pw')).toBe('pw ****');
    const env = await loadConfig({ cwd: dir, masker: new SecretMasker(), environment: { EZTEST_MASTER_KEY: key, HOST: 'https://h.example.test' } });
    expect(env.config.baseUrl).toBe('https://h.example.test/app/');
  });

  it('accepts browser: { name, channel } and db connections written with type:', async () => {
    write('eztest.config.yaml', `
browser: { name: chromium, channel: msedge }
db:
  connections:
    local: { type: sqlite, file: ./x.db }
  queries: { dir: sql }
video: retain-on-failure
screenshots: before-assertions
trace: { browser: on-failure }
waits: { loaders: [".spinner"] }
templates: { syntax: mustache }
dates: { holidays: ["2026-12-25"] }
`);
    const l = await load();
    expect(l.config).toMatchObject({
      browser: 'chromium', channel: 'msedge', db: { connections: { local: { driver: 'sqlite', file: './x.db' } }, queries: { dir: 'sql' } },
      video: 'retain-on-failure', screenshots: 'before-assertions', trace: { browser: 'on-failure' }, waits: { loaders: ['.spinner'], loaderTimeoutMs: 30000 },
      templates: { syntax: 'mustache' }, dates: { holidays: ['2026-12-25'], weekend: [0, 6] },
    });
    expect(l.warnings).toEqual([]);
  });

  it('validates client certificates and roles with a password rotation provider', async () => {
    write('eztest.config.yaml', `
api:
  clientCertificates:
    - { name: a, origin: https://api.example.test, cert: a.pem }
identity:
  roles:
    r: { username: u, loginUrl: /login, passwordRotation: { type: monthly-formula, prefix: secret://env/P } }
`);
    await expect(load()).rejects.toThrow(/needs "pfx" or both "cert" and "key"/);
    write('eztest.config.yaml', `
identity:
  roles:
    r: { username: u, loginUrl: /login }
`);
    await expect(load()).rejects.toThrow(/needs "password" or "passwordRotation"/);
  });
});

describe('holiday calendars', () => {
  it('reads YAML/JSON lists, { holidays: [...] }, { date } entries and one-date-per-line text', async () => {
    expect(parseHolidays('- 2026-12-25\n- 2026-01-01\n', 'h.yaml')).toEqual(['2026-12-25', '2026-01-01']);
    expect(parseHolidays(JSON.stringify({ holidays: [{ date: '2026-07-04', name: 'Independence Day' }] }), 'h.json')).toEqual(['2026-07-04']);
    expect(parseHolidays('date,name\n2026-05-25,Memorial Day\n# comment\n"2026-09-07",Labor\n', 'h.csv')).toEqual(['2026-05-25', '2026-09-07']);
    expect(() => parseHolidays('- 25/12/2026\n', 'h.yaml')).toThrow(/YYYY-MM-DD/);
    write('cal.txt', '2026-12-26\n2026-12-25\n2026-12-25\n');
    expect(await loadHolidays('cal.txt', dir)).toEqual(['2026-12-25', '2026-12-26']);
    await expect(loadHolidays('missing.txt', dir)).rejects.toThrow(/not found/);
  });
});
