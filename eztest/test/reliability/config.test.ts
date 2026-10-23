/** Reliability configuration: schema and engine wiring. */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { fastRunOptions } from '../../src/runner/index.js';

const RELIABILITY_CONFIG = {
  baseUrl: 'http://127.0.0.1:9',
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  healthChecks: [{ name: 'app', url: '/health', contains: 'ok' }, { api: '/api/status', status: 200 }, { db: 'crm' }],
  reliability: { appIdle: { timeoutMs: 5000, ignoreUrls: ['/poll'] }, slowMo: 0, circuitBreaker: { threshold: 2 }, sessionExpiry: { text: ['Sitzung abgelaufen'] }, reuseContext: true },
  lint: { translatedUi: true, rules: { 'hard-wait': 'error' }, maxWarnings: 0 },
  identity: {
    sessionRefreshMarginMinutes: 3,
    roles: { manager: { username: 'base', password: 'secret://env/MGR', loginUrl: '/login', successUrl: '/dashboard' } },
    pools: { manager: { accounts: [{ username: 'mgr1', password: 'secret://env/MGR1' }, { username: 'mgr2', password: 'secret://env/MGR2' }] } },
    lockout: { maxFailures: 2 },
  },
};

describe('reliability configuration', () => {
  it('validates with no unknown-key warnings and sensible defaults', () => {
    const { config, warnings } = validateConfig(RELIABILITY_CONFIG);
    expect(warnings).toEqual([]);
    expect(config.reliability).toMatchObject({ actionability: true, verifyFill: true, reresolve: true, suggestLocators: true, orphanSweep: true, circuitBreaker: { enabled: true, threshold: 2 } });
    expect(config.identity.lockout).toEqual({ maxFailures: 2, windowMinutes: 30, backoffMs: 2000 });
    expect(config.reliability.sessionExpiry).toMatchObject({ statuses: [401, 440], relogin: true });
    const d = validateConfig({}).config;
    expect(d.reliability.appIdle).toBe(false);
    expect(d.healthChecks).toEqual([]);
    expect(d.identity.pools).toEqual({});
    expect(() => validateConfig({ identity: { pools: { manager: { accounts: [] } } } })).toThrow();
  });

  it('the engine turns it into run options (pooled login, relogin, session expiry, health checks, time)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-relcfg-'));
    await mkdir(join(dir, 'journeys'));
    await writeFile(join(dir, 'eztest.config.json'), JSON.stringify(RELIABILITY_CONFIG));
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    const engine = await createEngine(loaded, { cwd: dir });
    try {
      const o = engine.runOptions;
      expect(o.reliability).toMatchObject({ actionability: true, appIdle: { timeoutMs: 5000, ignoreUrls: ['/poll'] }, verifyFill: true });
      expect(o.healthChecks).toHaveLength(3);
      expect(o.circuitBreaker).toMatchObject({ threshold: 2 });
      expect(o.sessionExpiry?.urls).toContain('/login'); // the role's sign-in page
      expect(o.sessionExpiry?.text).toEqual(['Sitzung abgelaufen']);
      expect(o).toMatchObject({ timezone: 'Europe/Berlin', locale: 'de-DE', reuseContext: true, suggestLocators: true });
      expect(typeof o.login).toBe('function');
      expect(typeof o.relogin).toBe('function');
      expect(typeof o.lifecycle?.journeyEnd).toBe('function');
      expect(engine.vault.roleNames().sort()).toEqual(['manager', 'manager#1', 'manager#2']);
    } finally {
      await engine.close();
    }
  });

  it('--fast keeps failure evidence and drops per-step overhead', () => {
    expect(fastRunOptions()).toEqual({ screenshots: 'on-failure', lenses: [], fingerprints: 'missing', passingLogs: false });
  });
});
