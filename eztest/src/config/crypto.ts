/**
 * Config value encryption: ENC(v1:<salt>:<iv>:<tag>:<ciphertext>) with
 * AES-256-GCM. The key is derived per value with scrypt from the master key
 * (EZTEST_MASTER_KEY) and a random salt embedded in the value. There is no
 * built-in key: without a master key, encrypted values cannot be read.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { EzTestError } from '../core/index.js';

const PREFIX = 'ENC(';
const VERSION = 'v1';
const AAD = Buffer.from('eztest:config:v1');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
export const MASTER_KEY_ENV = 'EZTEST_MASTER_KEY';
const MIN_MASTER_KEY_LENGTH = 16;

const ENC_RE = /^ENC\((v\d+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]*)\)$/;

export function isEncryptedValue(v: unknown): v is string {
  return typeof v === 'string' && v.trim().startsWith(PREFIX) && v.trim().endsWith(')');
}

function checkKey(masterKey: string | undefined): string {
  if (!masterKey) {
    throw new EzTestError(
      `Encrypted configuration values require a master key. Set ${MASTER_KEY_ENV}.`,
      'MASTER_KEY_MISSING',
    );
  }
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new EzTestError(
      `${MASTER_KEY_ENV} is too short (minimum ${MIN_MASTER_KEY_LENGTH} characters).`,
      'MASTER_KEY_WEAK',
    );
  }
  return masterKey;
}

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey.normalize('NFC'), salt, 32, SCRYPT);
}

/** Encrypt a plain value into the ENC(v1:...) form. */
export function encryptValue(plain: string, masterKey: string): string {
  const key = checkKey(masterKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, salt), iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC(${VERSION}:${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')})`;
}

/** Decrypt an ENC(v1:...) value. Throws (without revealing anything) on a wrong key or tampering. */
export function decryptValue(encrypted: string, masterKey: string | undefined): string {
  const m = ENC_RE.exec(encrypted.trim());
  if (!m) throw new EzTestError('Malformed encrypted value (expected ENC(v1:salt:iv:tag:data))', 'DECRYPT_MALFORMED');
  const [, version, saltB64, ivB64, tagB64, ctB64] = m;
  if (version !== VERSION) throw new EzTestError(`Unsupported encrypted value version ${version}`, 'DECRYPT_VERSION');
  const key = checkKey(masterKey);
  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new EzTestError('Malformed encrypted value (bad salt/iv/tag length)', 'DECRYPT_MALFORMED');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, salt), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new EzTestError('Could not decrypt value: wrong master key or the value was altered', 'DECRYPT_FAILED');
  }
}
