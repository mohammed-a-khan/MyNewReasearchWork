/**
 * Secret handles: opaque references (secret://store/key) that are resolved
 * only at the moment of use. Printing, logging or serializing a handle never
 * reveals its value.
 */
import { inspect } from 'node:util';
import { EzTestError, type SecretStore } from '../core/index.js';
import { defaultMasker, isEncryptedValue, decryptValue, MASTER_KEY_ENV, type SecretMasker } from '../config/index.js';

const REF_RE = /^secret:\/\/([A-Za-z0-9_.-]+)\/(.+)$/;

export function isSecretRef(v: unknown): v is string {
  return typeof v === 'string' && REF_RE.test(v);
}

export function parseSecretRef(ref: string): { store: string; key: string } {
  const m = REF_RE.exec(ref);
  if (!m) throw new EzTestError(`Invalid secret reference "${ref}" (expected secret://store/key)`, 'SECRET_REF');
  return { store: m[1], key: m[2] };
}

export class SecretHandle {
  readonly ref: string;
  readonly #resolve: () => Promise<string | undefined>;

  constructor(ref: string, resolver: () => Promise<string | undefined>) {
    parseSecretRef(ref);
    this.ref = ref;
    this.#resolve = resolver;
    Object.freeze(this);
  }

  /** Fetch the value now. Throws if the secret does not exist or is empty. */
  async resolve(): Promise<string> {
    const v = await this.#resolve();
    if (v === undefined || v === null || v === '') throw new EzTestError(`Secret ${this.ref} is not set`, 'SECRET_MISSING', { ref: this.ref });
    return v;
  }

  toString(): string {
    return `[secret ${this.ref}]`;
  }
  toJSON(): { ref: string } {
    return { ref: this.ref };
  }
  [inspect.custom](): string {
    return this.toString();
  }
  get [Symbol.toStringTag](): string {
    return 'SecretHandle';
  }
}

export function isSecretHandle(v: unknown): v is SecretHandle {
  return v instanceof SecretHandle;
}

/**
 * Registry of named secret stores. Hands out handles; every resolved value is
 * registered with the masker before it is returned.
 */
export class SecretRegistry {
  private readonly stores = new Map<string, SecretStore>();
  private inlineCount = 0;
  private readonly inline = new Map<string, string>();

  constructor(
    stores: SecretStore[] = [],
    readonly masker: SecretMasker = defaultMasker,
  ) {
    for (const s of stores) this.register(s);
  }

  register(store: SecretStore, name = store.name): this {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new EzTestError(`Invalid secret store name "${name}"`, 'SECRET_STORE');
    this.stores.set(name, store);
    return this;
  }

  storeNames(): string[] {
    return [...this.stores.keys()];
  }

  handle(ref: string): SecretHandle {
    const { store, key } = parseSecretRef(ref);
    return new SecretHandle(ref, async () => {
      if (store === 'inline') return this.inline.get(key);
      const s = this.stores.get(store);
      if (!s) throw new EzTestError(`Unknown secret store "${store}" in ${ref}`, 'SECRET_STORE', { ref });
      const v = await s.get(key);
      if (v !== undefined) this.masker.add(v);
      return v;
    });
  }

  /** Wrap a literal value in a handle (value registered with the masker immediately). */
  literal(value: string, label = 'value'): SecretHandle {
    this.masker.add(value);
    const key = `${label.replace(/[^A-Za-z0-9_.-]/g, '_')}-${++this.inlineCount}`;
    this.inline.set(key, value);
    return this.handle(`secret://inline/${key}`);
  }

  /**
   * Turn a config value into a handle: secret://... refs resolve via stores,
   * ENC(...) values are decrypted lazily with EZTEST_MASTER_KEY, anything else is wrapped as a literal.
   */
  from(value: string | SecretHandle, label?: string, env: Record<string, string | undefined> = process.env): SecretHandle {
    if (value instanceof SecretHandle) return value;
    if (isSecretRef(value)) return this.handle(value);
    if (isEncryptedValue(value)) {
      const key = `${(label ?? 'enc').replace(/[^A-Za-z0-9_.-]/g, '_')}-${++this.inlineCount}`;
      return new SecretHandle(`secret://inline/${key}`, async () => {
        const v = decryptValue(value, env[MASTER_KEY_ENV]);
        this.masker.add(v);
        return v;
      });
    }
    return this.literal(value, label);
  }

  async resolve(ref: string): Promise<string> {
    return this.handle(ref).resolve();
  }
}
