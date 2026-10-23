import { describe, it, expect } from '../support/testkit.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EzTestConfigSchema, SecretMasker, encryptValue } from '../../src/config/index.js';
import { DbRegistry } from '../../src/surfaces/index.js';
import { createSecretRegistry, identityVaultFromConfig } from '../../src/identity/index.js';

describe('identity from config', () => {
  it('builds stores and roles from validated config, resolving env, file and ENC secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eztest-idcfg-'));
    try {
      const master = 'from-config-master-key-1';
      writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ alice: { totp: encryptValue('JBSWY3DPEHPK3PXP', master) } }));
      const config = EzTestConfigSchema.parse({
        baseUrl: 'http://127.0.0.1:9',
        environment: 'qa',
        identity: {
          secretStores: [{ type: 'file', path: 'secrets.json' }],
          roles: { rep: { username: 'alice', password: 'secret://env/ALICE_PW', totp: 'secret://file/alice.totp', loginUrl: '/login' } },
        },
        db: { connections: { mem: { driver: 'sqlite', file: ':memory:' } } },
      });
      const masker = new SecretMasker();
      const env = { ALICE_PW: 'Wonderland#1', EZTEST_MASTER_KEY: master };
      {
        const reg = createSecretRegistry(config.identity.secretStores, { cwd: dir, masker, env });
        expect(reg.storeNames().sort()).toEqual(['env', 'file']);
        expect(await reg.resolve('secret://env/ALICE_PW')).toBe('Wonderland#1');
        expect(await reg.resolve('secret://file/alice.totp')).toBe('JBSWY3DPEHPK3PXP');
        const vault = identityVaultFromConfig(config, { cwd: dir, registry: reg });
        expect(vault.roleNames()).toEqual(['rep']);
        expect(vault.environment).toBe('qa');
        expect(vault.sessionFile('rep')).toContain(join(dir, '.eztest/sessions'));
      }
      const dbs = new DbRegistry(config.db.connections);
      expect(await (await dbs.get('mem')).query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      await dbs.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
