/**
 * One naming scheme for EZTest environment variables (docs/configuration.md):
 * settings are EZTEST_<SECTION>__<KEY>; EZTEST_ADO_ORG_URL and
 * EZTEST_ADO_PROJECT are accepted names for ado.organizationUrl and ado.project,
 * without warnings.
 */
import { describe, expect, it } from '../support/testkit.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { tempDir } from '../runner/fixtures.js';

async function load(environment: Record<string, string>) {
  const dir = await tempDir('env-aliases');
  await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://localhost:3000\n');
  return loadConfig({ cwd: dir, environment });
}

describe('environment variable names', () => {
  it('EZTEST_ADO_ORG_URL and EZTEST_ADO_PROJECT set ado.organizationUrl and ado.project, with no warning', async () => {
    const l = await load({ EZTEST_ADO_ORG_URL: 'https://dev.azure.com/acme', EZTEST_ADO_PROJECT: 'Shop' });
    expect(l.config.ado).toMatchObject({ organizationUrl: 'https://dev.azure.com/acme', project: 'Shop' });
    expect([...l.warnings, ...(l.envWarnings ?? [])]).toEqual([]);
  });

  it('the canonical names work and win over the aliases; EZTEST_ADO__ORG_URL is accepted too', async () => {
    const l = await load({ EZTEST_ADO__ORGANIZATION_URL: 'https://dev.azure.com/canonical', EZTEST_ADO_ORG_URL: 'https://dev.azure.com/alias', EZTEST_ADO__PROJECT: 'P1', EZTEST_ADO_PROJECT: 'P2' });
    expect(l.config.ado).toMatchObject({ organizationUrl: 'https://dev.azure.com/canonical', project: 'P1' });
    expect([...l.warnings, ...(l.envWarnings ?? [])]).toEqual([]);
    const old = await load({ EZTEST_ADO__ORG_URL: 'https://dev.azure.com/old' });
    expect(old.config.ado.organizationUrl).toBe('https://dev.azure.com/old');
    expect(old.envWarnings ?? []).toEqual([]);
  });

  it('a variable that names no setting still warns, with the scheme in the message', async () => {
    const l = await load({ EZTEST_NOT_A_SETTING: 'x' });
    expect(l.envWarnings).toEqual([expect.stringMatching(/EZTEST_NOT_A_SETTING is not an EZTest setting .*EZTEST_ADO__ORGANIZATION_URL for ado\.organizationUrl/)]);
  });

  it('EZTEST_SECRET_* (the env secret store of eztest init) and a configured EZTEST_ prefix are secrets, not settings: no warning', async () => {
    const dir = await tempDir('env-secrets');
    await writeFile(join(dir, 'eztest.config.yaml'), [
      'baseUrl: http://localhost:3000',
      'identity:',
      '  secretStores:',
      '    - { type: env, prefix: EZTEST_SECRET_ }',
      '    - { type: env, name: creds, prefix: EZTEST_CREDS_ }',
      '',
    ].join('\n'));
    await writeFile(join(dir, '.env'), 'EZTEST_SECRET_WEB_CLERK_PASSWORD=from-dotenv\nEZTEST_CREDS_API_KEY=k\n');
    const l = await loadConfig({ cwd: dir, environment: { EZTEST_SECRET_WEB_DB_PASSWORD: 'from-process', EZTEST_CREDS__X: 'y' } });
    expect([...l.warnings, ...(l.envWarnings ?? [])]).toEqual([]);
    expect(l.variables.EZTEST_SECRET_WEB_CLERK_PASSWORD).toBe('from-dotenv');
    expect(l.variables.EZTEST_SECRET_WEB_DB_PASSWORD).toBe('from-process');
    // without a store of that prefix, the default prefix alone is exempt
    const plain = await load({ EZTEST_SECRET_X: 'x', EZTEST_CREDS_X: 'y' });
    expect(plain.envWarnings).toEqual([expect.stringMatching(/EZTEST_CREDS_X is not an EZTest setting/)]);
  });
});
