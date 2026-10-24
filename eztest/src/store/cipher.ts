/**
 * Encryption of secret shared-store values: AES-256-GCM, a fresh IV per
 * value, the key derived once (scrypt) from the store key. Secrets are sealed
 * on the machine that saves them, so neither the store files, the results
 * server nor the pipeline export ever hold the plain value.
 *
 *   EZS1:<iv>:<tag>:<ciphertext>     (base64 parts)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { EzTestError } from '../core/index.js';

const PREFIX = 'EZS1:';
const AAD = Buffer.from('eztest:store:v1');
const SALT = Buffer.from('eztest-shared-store-v1');
const MIN_KEY = 16;
export const STORE_KEY_ENV = 'EZTEST_STORE_KEY';

export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);

export class StoreCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < MIN_KEY) throw new EzTestError(`The shared-store key is too short (at least ${MIN_KEY} characters)`, 'STORE_KEY_WEAK');
    this.key = scryptSync(secret.normalize('NFC'), SALT, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(JSON.stringify(value ?? null), 'utf8'), c.final()]);
    return `${PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  open(sealed: string): unknown {
    const [iv, tag, ct] = sealed.slice(PREFIX.length).split(':');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      d.setAAD(AAD);
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')) as unknown;
    } catch {
      throw new EzTestError('A secret shared-store value could not be decrypted: wrong store key (EZTEST_STORE_KEY / EZTEST_MASTER_KEY) or the value was changed', 'STORE_DECRYPT');
    }
  }
}

/** The store key: an explicit one, else EZTEST_STORE_KEY, else EZTEST_MASTER_KEY. */
export function storeKeyFrom(explicit: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  return explicit || env[STORE_KEY_ENV] || env.EZTEST_MASTER_KEY || undefined;
}
