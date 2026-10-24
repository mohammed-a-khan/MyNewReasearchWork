/** SecretStore implementations (core contract): env, file, Azure Key Vault, chain, memory. */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { EzTestError, type SecretStore } from '../core/index.js';
import { decryptValue, defaultMasker, isEncryptedValue, MASTER_KEY_ENV, type SecretMasker } from '../config/index.js';
import type { TokenProvider } from '../surfaces/index.js';
import { envProxyFetch } from '../surfaces/proxy.js';

export class EnvSecretStore implements SecretStore {
  readonly name: string;
  private readonly prefix: string;
  private readonly env: Record<string, string | undefined>;

  constructor(o: { prefix?: string; env?: Record<string, string | undefined>; name?: string } = {}) {
    this.prefix = o.prefix ?? '';
    this.env = o.env ?? process.env;
    this.name = o.name ?? 'env';
  }

  async get(key: string): Promise<string | undefined> {
    const v = this.env[this.prefix + key];
    return v === '' ? undefined : v;
  }
}

/** In-memory store, mostly for tests and programmatic setups. */
export class MemorySecretStore implements SecretStore {
  readonly name: string;
  private readonly values: Map<string, string>;
  constructor(values: Record<string, string> = {}, name = 'memory') {
    this.values = new Map(Object.entries(values));
    this.name = name;
  }
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/**
 * JSON or YAML file of secrets. Nested objects are addressed with dots
 * ("db.password"). Values may be ENC(...) and are decrypted on read with the master key.
 */
export class FileSecretStore implements SecretStore {
  readonly name: string;
  private data?: Promise<Map<string, string>>;
  private readonly masker: SecretMasker;

  constructor(private readonly o: { path: string; masterKey?: string; name?: string; masker?: SecretMasker }) {
    this.name = o.name ?? 'file';
    this.masker = o.masker ?? defaultMasker;
  }

  private load(): Promise<Map<string, string>> {
    if (!this.data) {
      this.data = (async () => {
        let text: string;
        try {
          text = await readFile(this.o.path, 'utf8');
        } catch (e) {
          throw new EzTestError(`Cannot read secrets file ${this.o.path}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`, 'SECRET_FILE');
        }
        let parsed: unknown;
        try {
          parsed = this.o.path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
        } catch {
          // never echo parser messages: they can quote file content
          throw new EzTestError(`Secrets file ${this.o.path} is not valid ${this.o.path.endsWith('.json') ? 'JSON' : 'YAML'}`, 'SECRET_FILE');
        }
        const map = new Map<string, string>();
        const walk = (v: unknown, prefix: string) => {
          if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, prefix ? `${prefix}.${k}` : k);
          else if (v !== null && v !== undefined && prefix) map.set(prefix, String(v));
        };
        walk(parsed, '');
        return map;
      })();
      this.data.catch(() => (this.data = undefined));
    }
    return this.data;
  }

  async get(key: string): Promise<string | undefined> {
    const raw = (await this.load()).get(key);
    if (raw === undefined) return undefined;
    if (isEncryptedValue(raw)) {
      const v = decryptValue(raw, this.o.masterKey ?? process.env[MASTER_KEY_ENV]);
      this.masker.add(v);
      return v;
    }
    this.masker.add(raw);
    return raw;
  }
}

/**
 * Azure Key Vault (REST): GET {vaultUrl}/secrets/{name}?api-version=7.4 with a
 * bearer token from the injected provider (see azureAdTokenProvider).
 */
export class AzureKeyVaultSecretStore implements SecretStore {
  readonly name: string;
  private readonly vaultUrl: string;
  private readonly cache = new Map<string, { value: string; at: number }>();
  private readonly masker: SecretMasker;

  constructor(
    private readonly o: {
      vaultUrl: string;
      tokenProvider: TokenProvider;
      apiVersion?: string;
      name?: string;
      /** Cache resolved values in memory for this long (default 5 min; 0 disables). */
      cacheTtlMs?: number;
      fetch?: typeof fetch;
      masker?: SecretMasker;
      timeoutMs?: number;
    },
  ) {
    const u = new URL(o.vaultUrl);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      throw new EzTestError('Key Vault URL must use https', 'KEYVAULT_CONFIG');
    }
    this.vaultUrl = o.vaultUrl.replace(/\/+$/, '');
    this.name = o.name ?? 'azure-keyvault';
    this.masker = o.masker ?? defaultMasker;
  }

  async get(key: string): Promise<string | undefined> {
    // Key Vault names: 1-127 chars, alphanumerics and dashes. Optional "/version".
    const m = /^([0-9A-Za-z-]{1,127})(?:\/([0-9A-Za-z]{1,64}))?$/.exec(key);
    if (!m) throw new EzTestError(`Invalid Key Vault secret name "${key}"`, 'KEYVAULT_NAME');
    const ttl = this.o.cacheTtlMs ?? 300_000;
    const hit = this.cache.get(key);
    if (hit && ttl > 0 && Date.now() - hit.at < ttl) return hit.value;

    const url = `${this.vaultUrl}/secrets/${encodeURIComponent(m[1])}${m[2] ? '/' + m[2] : ''}?api-version=${encodeURIComponent(this.o.apiVersion ?? '7.4')}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30_000);
    let res: Response;
    let text: string;
    try {
      const token = await this.o.tokenProvider.getToken();
      res = await (this.o.fetch ?? envProxyFetch)(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      if (e instanceof EzTestError) throw e;
      throw new EzTestError(this.masker.mask(`Key Vault request failed: ${(e as Error).message}`), 'KEYVAULT_NETWORK');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) this.o.tokenProvider.invalidate?.();
    if (res.status === 404) return undefined;
    if (!res.ok) {
      let code = '';
      try {
        code = String((JSON.parse(text) as { error?: { code?: string } }).error?.code ?? '');
      } catch {
        code = '';
      }
      throw new EzTestError(`Key Vault returned HTTP ${res.status}${code ? ` (${code})` : ''} for secret "${key}"`, 'KEYVAULT_HTTP', { status: res.status });
    }
    let value: unknown;
    try {
      value = (JSON.parse(text) as { value?: unknown }).value;
    } catch {
      value = undefined;
    }
    if (typeof value !== 'string') throw new EzTestError(`Key Vault response for "${key}" has no string value`, 'KEYVAULT_RESPONSE');
    this.masker.add(value);
    if (ttl > 0) this.cache.set(key, { value, at: Date.now() });
    return value;
  }
}

/** Ask each store in order; first defined value wins. */
export class ChainSecretStore implements SecretStore {
  readonly name: string;
  constructor(
    private readonly stores: SecretStore[],
    name = 'chain',
  ) {
    if (stores.length === 0) throw new EzTestError('ChainSecretStore needs at least one store', 'SECRET_STORE');
    this.name = name;
  }
  async get(key: string): Promise<string | undefined> {
    for (const s of this.stores) {
      const v = await s.get(key);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}
