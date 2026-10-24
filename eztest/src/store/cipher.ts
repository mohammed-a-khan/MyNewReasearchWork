/**
 * Encryption of secret shared-store values: AES-256-GCM, a fresh IV per
 * value, the key derived (scrypt) from the store key and the store's own
 * random salt. Secrets are sealed on the machine that saves them, so neither
 * the store files, the results server nor the pipeline export ever hold the
 * plain value.
 *
 *   EZS2:<salt>:<iv>:<tag>:<ciphertext>     (base64 parts; the salt is the store's)
 *   EZS1:<iv>:<tag>:<ciphertext>            (older values: one fixed salt for every store)
 *
 * Each store gets a random 16-byte salt the first time it seals a value
 * (kept in the store itself, see SharedStore), so the same store key gives a
 * different encryption key in every store and a precomputed dictionary for
 * one is useless for another. The salt travels in every value, so a value can
 * be opened anywhere the key is known. EZS1 values still open; the store
 * re-seals them as EZS2 (`SharedStore.migrateSealedValues`, and on load).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { EzTestError } from '../core/index.js';

const PREFIX_V2 = 'EZS2:';
const PREFIX_V1 = 'EZS1:';
const AAD = Buffer.from('eztest:store:v1');
/** The single salt older (EZS1) values were sealed with; used to open them only. */
const LEGACY_SALT = Buffer.from('eztest-shared-store-v1');
const MIN_KEY = 16;
export const STORE_KEY_ENV = 'EZTEST_STORE_KEY';

export const isSealed = (v: unknown): v is string => typeof v === 'string' && (v.startsWith(PREFIX_V2) || v.startsWith(PREFIX_V1));

/** A value sealed in the older format (fixed salt), which the store re-seals. */
export const isLegacySealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX_V1);

/** A fresh random store salt. */
export function newStoreSalt(): Buffer {
  return randomBytes(16);
}

export class StoreCipher {
  private readonly secret: string;
  private readonly keys = new Map<string, Buffer>();
  /** The salt new values are sealed with (the store's). */
  readonly salt: Buffer;

  /** `salt`: the store's salt for sealing (default: a fresh random one, e.g. for a one-off seal). */
  constructor(secret: string, salt: Buffer = newStoreSalt()) {
    if (secret.length < MIN_KEY) throw new EzTestError(`The shared-store key is too short (at least ${MIN_KEY} characters)`, 'STORE_KEY_WEAK');
    if (salt.length < 16) throw new EzTestError('The shared-store salt is too short (16 bytes or more)', 'STORE_KEY_WEAK');
    this.secret = secret.normalize('NFC');
    this.salt = salt;
  }

  private key(salt: Buffer): Buffer {
    const id = salt.toString('base64');
    let k = this.keys.get(id);
    if (!k) {
      k = scryptSync(this.secret, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      this.keys.set(id, k);
    }
    return k;
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key(this.salt), iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(JSON.stringify(value ?? null), 'utf8'), c.final()]);
    return `${PREFIX_V2}${this.salt.toString('base64')}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  open(sealed: string): unknown {
    let salt: Buffer;
    let iv: string;
    let tag: string;
    let ct: string;
    if (sealed.startsWith(PREFIX_V2)) {
      let s: string;
      [s, iv, tag, ct] = sealed.slice(PREFIX_V2.length).split(':');
      salt = Buffer.from(s ?? '', 'base64');
    } else {
      [iv, tag, ct] = sealed.slice(PREFIX_V1.length).split(':');
      salt = LEGACY_SALT;
    }
    try {
      const d = createDecipheriv('aes-256-gcm', this.key(salt), Buffer.from(iv, 'base64'));
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
