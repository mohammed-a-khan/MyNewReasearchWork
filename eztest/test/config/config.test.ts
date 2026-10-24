import { describe, it, expect, beforeEach, afterEach, vi } from '../support/testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  encryptValue,
  decryptValue,
  parseDotenv,
  envToConfig,
  SecretMasker,
  createMaskedLogger,
  ConfigError,
  EzTestConfigSchema,
  validateConfig,
} from '../../src/config/index.js';

const MASTER = 'test-master-key-0123456789';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eztest-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('encryption', () => {
  it('round-trips with a random salt per value', () => {
    const a = encryptValue('s3cr3t-value', MASTER);
    const b = encryptValue('s3cr3t-value', MASTER);
    expect(a).toMatch(/^ENC\(v1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('s3cr3t');
    expect(decryptValue(a, MASTER)).toBe('s3cr3t-value');
    expect(decryptValue(b, MASTER)).toBe('s3cr3t-value');
  });
  it('fails clearly on wrong key, tampering and missing key', () => {
    const enc = encryptValue('hello-world', MASTER);
    expect(() => decryptValue(enc, 'another-master-key-xyz')).toThrow(/wrong master key or the value was altered/);
    const parts = enc.slice(4, -1).split(':');
    const ct = Buffer.from(parts[4], 'base64');
    ct[0] ^= 1;
    parts[4] = ct.toString('base64');
    expect(() => decryptValue(`ENC(${parts.join(':')})`, MASTER)).toThrow(/altered/);
    expect(() => decryptValue(enc, undefined)).toThrow(/EZTEST_MASTER_KEY/);
    expect(() => encryptValue('x', 'short')).toThrow(/too short/);
    expect(() => decryptValue('ENC(garbage)', MASTER)).toThrow(/Malformed/);
  });
});

describe('dotenv parser', () => {
  it('parses keys, comments, quotes and escapes', () => {
    const vars = parseDotenv(
      [
        '# comment',
        'A=1',
        'export B = two words # trailing comment',
        "C='literal $x \\n'",
        'D="line1\\nline2 \\"q\\""',
        'E=',
        'F="multi',
        'line"',
        'G=a#b',
      ].join('\n'),
    );
    expect(vars).toEqual({ A: '1', B: 'two words', C: 'literal $x \\n', D: 'line1\nline2 "q"', E: '', F: 'multi\nline', G: 'a#b' });
  });
  it('rejects malformed lines', () => {
    expect(() => parseDotenv('not a pair')).toThrow(/expected KEY=value/);
    expect(() => parseDotenv('A="open')).toThrow(/unterminated/);
  });
});

describe('env mapping', () => {
  it('maps EZTEST_* with nesting and schema-guided coercion', () => {
    const c = envToConfig({
      EZTEST_BASE_URL: 'http://x.test',
      EZTEST_CONCURRENCY: '4',
      EZTEST_HEADLESS: 'false',
      EZTEST_ADO__PROJECT: 'proj-x',
      EZTEST_TIMEOUTS__STEP: '5000',
      EZTEST_REPORTERS: 'json,junit',
      EZTEST_MASTER_KEY: 'never-in-config',
      OTHER: 'ignored',
    });
    expect(c).toEqual({
      baseUrl: 'http://x.test',
      concurrency: 4,
      headless: false,
      ado: { project: 'proj-x' },
      timeouts: { step: 5000 },
      reporters: ['json', 'junit'],
    });
    expect(() => envToConfig({ EZTEST_CONCURRENCY: 'many' })).toThrow(/must be a number/);
  });
});

describe('loadConfig layering', () => {
  it('applies defaults when nothing is configured', async () => {
    const r = await loadConfig({ cwd: dir, environment: {}, masker: new SecretMasker() });
    expect(r.config.browser).toBe('chromium');
    expect(r.config.timeouts.step).toBe(15000);
    expect(r.config.ado.enabled).toBe(false);
    expect(r.config.healing.requireVerification).toBe(true);
    expect(r.sources).toEqual(['defaults']);
    expect(r.warnings).toEqual([]);
  });

  it('merges file < env file < .env < EZTEST_* < overrides, interpolates and decrypts', async () => {
    const masker = new SecretMasker();
    const enc = encryptValue('db-pa55word', MASTER);
    writeFileSync(
      join(dir, 'eztest.config.yaml'),
      [
        'baseUrl: http://base.test',
        'concurrency: 2',
        'retries: 1',
        'outputDir: ${OUT_DIR:-results-default}',
        'ado:',
        '  project: ${ADO_PROJECT}',
        'db:',
        '  connections:',
        '    main:',
        '      driver: postgres',
        '      host: db.test',
        `      password: "${enc}"`,
        'mystery: 1',
        'healing:',
        '  bogus: true',
      ].join('\n'),
    );
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'staging.json'), JSON.stringify({ baseUrl: 'http://staging.test', retries: 2 }));
    writeFileSync(join(dir, '.env'), `ADO_PROJECT=from-dotenv\nEZTEST_RETRIES=3\nEZTEST_MASTER_KEY=${MASTER}\n`);
    writeFileSync(join(dir, '.env.staging'), 'EZTEST_CONCURRENCY=5\n');
    const r = await loadConfig({
      cwd: dir,
      env: 'staging',
      environment: { EZTEST_RETRIES: '4' },
      overrides: { headless: false },
      masker,
    });
    expect(r.config.baseUrl).toBe('http://staging.test');
    expect(r.config.concurrency).toBe(5);
    expect(r.config.retries).toBe(4);
    expect(r.config.headless).toBe(false);
    expect(r.config.outputDir).toBe('results-default');
    expect(r.config.ado.project).toBe('from-dotenv');
    expect(r.config.environment).toBe('staging');
    const main = r.config.db.connections.main;
    expect(main.driver === 'postgres' && main.password).toBe('db-pa55word');
    expect(masker.mask('pw=db-pa55word')).toBe('pw=****');
    expect(r.warnings.sort()).toEqual(['Unknown configuration key "healing.bogus" (ignored)', 'Unknown configuration key "mystery" (ignored)']);
    expect(r.sources.length).toBe(7);
  });

  it('errors clearly on invalid values with the path', async () => {
    writeFileSync(join(dir, 'eztest.config.json'), JSON.stringify({ concurrency: 0, browser: 'ie6', timeouts: { step: 'slow' } }));
    const err = await loadConfig({ cwd: dir, environment: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toMatch(/concurrency/);
    expect(err.message).toMatch(/browser/);
    expect(err.message).toMatch(/timeouts\.step/);
  });

  it('errors on encrypted values without a master key and on unset variables', async () => {
    const enc = encryptValue('abc-secret', MASTER);
    writeFileSync(join(dir, 'eztest.config.yaml'), `ado:\n  pat: "${enc}"\n  project: \${NOPE}\n`);
    const err = await loadConfig({ cwd: dir, environment: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toMatch(/ado\.pat: .*EZTEST_MASTER_KEY/);
    expect(err.message).toMatch(/ado\.project: .*NOPE/);
  });

  it('keeps EZTEST_* variables that are no setting apart from the config warnings', async () => {
    writeFileSync(join(dir, 'eztest.config.yaml'), 'baseUrl: http://x.test\n');
    const r = await loadConfig({ cwd: dir, environment: { EZTEST_BUILD_LABEL: 'nightly', EZTEST_ADO_ORG_URL: 'https://dev.azure.com/acme', EZTEST_ADO__PROJECT: 'p', EZTEST_ADO_PAT: 'x', EZTEST_ADO_PLAN: '7' } });
    expect(r.warnings).toEqual([]);
    // EZTEST_ADO_ORG_URL is an accepted name for ado.organizationUrl (no warning); EZTEST_BUILD_LABEL names nothing.
    expect(r.envWarnings).toEqual([expect.stringMatching(/^environment variable EZTEST_BUILD_LABEL is not an EZTest setting/)]);
    expect(r.config.ado.project).toBe('p');
    expect(r.config.ado.organizationUrl).toBe('https://dev.azure.com/acme');
  });

  it('errors on a missing explicit config file', async () => {
    await expect(loadConfig({ cwd: dir, configFile: 'nope.yaml', environment: {} })).rejects.toThrow(/not found/);
  });

  it('warns about removed testing-tool integrations with a migration hint instead of failing or dropping them silently', () => {
    const { config, warnings } = validateConfig({
      reporters: ['console', 'ctrf', 'junit'],
      email: { provider: 'mailpit', url: 'http://localhost:8025' },
      contracts: { dir: 'pacts', broker: { url: 'https://broker.example.com' }, pacticipant: 'web', canIDeploy: { environment: 'prod' }, provider: { name: 'api', messages: { 'order created': { dest: 'orders' } } } },
      publishers: [{ use: 'slack', webhook: 'x' }, { use: 'xray', projectKey: 'PAY' }],
    });
    expect(config.reporters).toEqual(['console', 'junit']);
    expect(config.email).toBeUndefined();
    expect(config.publishers.map((p) => p.use)).toEqual(['slack']);
    expect(config.contracts?.provider?.messageProducers).toEqual({ 'order created': { dest: 'orders', timeoutMs: 15_000 } });
    const text = warnings.join('\n');
    expect(text).toMatch(/"contracts\.broker" is no longer supported.*EZTest results server/);
    expect(text).toMatch(/"contracts\.pacticipant" .*contracts\.app/);
    expect(text).toMatch(/"contracts\.canIDeploy" .*contracts\.canRelease/);
    expect(text).toMatch(/"contracts\.provider\.messages" .*messageProducers/);
    expect(text).toMatch(/contracts\.dir is "pacts"/);
    expect(text).toMatch(/"email\.provider: mailpit" .*provider: sink/);
    expect(text).toMatch(/"reporters: ctrf" .*junit/);
    expect(text).toMatch(/"publishers\[1\]\.use: xray" .*Xray publisher was removed/);
    expect(text).not.toMatch(/Unknown configuration key/);
    expect(validateConfig({ email: { provider: 'mailhog', url: 'http://x' } }).warnings[0]).toMatch(/email\.provider: mailhog/);
    const renamed = validateConfig({ trace: { playwright: 'on-failure' } });
    expect(renamed.config.trace.browser).toBe('on-failure');
    expect(renamed.warnings[0]).toMatch(/"trace\.playwright" .*renamed to `trace\.browser`/);
  });

  it('validateConfig rejects empty-string required values', () => {
    expect(() => validateConfig({ outputDir: '' })).toThrow(/outputDir/);
    expect(EzTestConfigSchema.parse({}).identity.sessionMaxAgeMinutes).toBe(30);
  });
});

describe('SecretMasker', () => {
  it('masks registered values, their encoded forms, nested data and errors', () => {
    const m = new SecretMasker();
    m.add('Wonderland#1');
    m.add('ab'); // too short: ignored
    expect(m.mask('pw Wonderland#1 end')).toBe('pw **** end');
    expect(m.mask('password=Wonderland%231')).toBe('password=****');
    expect(m.mask('ab cd')).toBe('ab cd');
    expect(m.maskDeep({ a: ['x Wonderland#1'], n: 1 })).toEqual({ a: ['x ****'], n: 1 });
    const e = m.maskError(new Error('login failed for Wonderland#1'));
    expect(e.message).not.toContain('Wonderland');
    expect(m.mask('')).toBe('');
  });
  it('wraps a SecretStore so values are auto-registered', async () => {
    const m = new SecretMasker();
    const store = m.wrapStore({ name: 's', get: async (k) => (k === 'k' ? 'value-from-store' : undefined) });
    expect(await store.get('k')).toBe('value-from-store');
    expect(await store.get('missing')).toBeUndefined();
    expect(m.mask('got value-from-store')).toBe('got ****');
  });
  it('createMaskedLogger masks console output', () => {
    const m = new SecretMasker();
    m.add('top-secret-token');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const log = createMaskedLogger('debug', m);
      log.info('token is top-secret-token', { token: 'top-secret-token' });
      const line = String(spy.mock.calls[0][0]);
      expect(line).toContain('token is ****');
      expect(line).not.toContain('top-secret-token');
    } finally {
      spy.mockRestore();
    }
  });
});
