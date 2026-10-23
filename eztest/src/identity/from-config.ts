/** Build secret registries and an Identity Vault from validated EZTest config. */
import { resolve } from 'node:path';
import { EzTestError, type Logger } from '../core/index.js';
import { defaultMasker, MASTER_KEY_ENV, type EzTestConfig, type SecretMasker, type SecretStoreConfig } from '../config/index.js';
import { SecretRegistry } from './handle.js';
import { azureAdTokenProvider } from './oauth.js';
import { AzureKeyVaultSecretStore, EnvSecretStore, FileSecretStore } from './stores.js';
import { IdentityVault, type RoleDefinition } from './vault.js';
import { createPasswordRotationProvider, rotationHandle } from './rotation.js';
import { expandPoolRoles } from './pools.js';
import { registries } from '../plugins/registry.js';

export function createSecretRegistry(
  stores: SecretStoreConfig[],
  o: { cwd?: string; masker?: SecretMasker; env?: Record<string, string | undefined> } = {},
): SecretRegistry {
  const masker = o.masker ?? defaultMasker;
  const env = o.env ?? process.env;
  const reg = new SecretRegistry([], masker);
  // The env store is always available as secret://env/NAME unless configured otherwise.
  if (!stores.some((s) => (s.name ?? s.type) === 'env')) reg.register(new EnvSecretStore({ env }));
  for (const s of stores) {
    switch (s.type) {
      case 'env':
        reg.register(new EnvSecretStore({ prefix: s.prefix, env, name: s.name ?? 'env' }));
        break;
      case 'file':
        reg.register(new FileSecretStore({ path: resolve(o.cwd ?? process.cwd(), s.path), name: s.name ?? 'file', masker, masterKey: env[MASTER_KEY_ENV] }));
        break;
      case 'azure-keyvault': {
        // clientSecret may itself be a reference to another (earlier) store
        const secret = s.clientSecret.startsWith('secret://') ? () => reg.resolve(s.clientSecret) : s.clientSecret;
        masker.add(typeof secret === 'string' ? secret : undefined);
        const tp = azureAdTokenProvider({ tenantId: s.tenantId, clientId: s.clientId, clientSecret: secret, authorityUrl: s.authorityUrl, masker });
        reg.register(new AzureKeyVaultSecretStore({ vaultUrl: s.vaultUrl, tokenProvider: tp, name: s.name ?? 'azure-keyvault', masker }));
        break;
      }
      default:
        throw new EzTestError(`Unknown secret store type ${(s as { type: string }).type}`, 'SECRET_STORE');
    }
  }
  // Secret stores contributed by plugins: secret://<store name>/<key>.
  for (const s of registries.secretStores.list()) if (!stores.some((c) => (c.name ?? c.type) === s.name)) reg.register(s);
  return reg;
}

export function identityVaultFromConfig(
  config: EzTestConfig,
  o: { cwd?: string; masker?: SecretMasker; registry?: SecretRegistry; logger?: Logger; env?: Record<string, string | undefined> } = {},
): IdentityVault {
  const registry = o.registry ?? createSecretRegistry(config.identity.secretStores, o);
  const roles: Record<string, RoleDefinition> = {};
  for (const [name, r] of Object.entries(config.identity.roles)) {
    const { passwordRotation, password, ...rest } = r;
    let pw: RoleDefinition['password'];
    if (passwordRotation) pw = rotationHandle(createPasswordRotationProvider(passwordRotation, { registry, role: name }), registry, name);
    else if (password !== undefined) pw = password;
    else throw new EzTestError(`Role ${name}: needs "password" or "passwordRotation"`, 'IDENTITY_CONFIG');
    roles[name] = { ...rest, password: pw };
  }
  return new IdentityVault({
    // Account pools: every pooled account is a role of its own (role#1, role#2, ...) with its own cached session.
    roles: Object.keys(config.identity.pools).length ? expandPoolRoles(roles, config.identity.pools) : roles,
    registry,
    environment: config.environment,
    baseUrl: config.baseUrl,
    sessionDir: resolve(o.cwd ?? process.cwd(), config.identity.sessionDir),
    sessionMaxAgeMs: config.identity.sessionMaxAgeMinutes * 60_000,
    timeoutMs: config.timeouts.step,
    logger: o.logger,
  });
}
