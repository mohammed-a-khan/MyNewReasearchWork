/** HOTP (RFC 4226) and TOTP (RFC 6238). */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EzTestError } from '../core/index.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const s = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!s) throw new EzTestError('TOTP secret is empty', 'TOTP_SECRET');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new EzTestError('TOTP secret is not valid base32', 'TOTP_SECRET');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface HotpOptions {
  digits?: number;
  algorithm?: TotpAlgorithm;
}

export interface TotpOptions extends HotpOptions {
  /** Time in ms since epoch, or a Date (default now). */
  time?: number | Date;
  /** Step in seconds (default 30). */
  step?: number;
  /** T0 in seconds (default 0). */
  epoch?: number;
}

function keyOf(secret: string | Uint8Array): Buffer {
  return typeof secret === 'string' ? base32Decode(secret) : Buffer.from(secret);
}

export function generateHotp(secret: string | Uint8Array, counter: number | bigint, o: HotpOptions = {}): string {
  const digits = o.digits ?? 6;
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new EzTestError('TOTP digits must be 6..10', 'TOTP_OPTIONS');
  const algorithm = o.algorithm ?? 'sha1';
  if (!['sha1', 'sha256', 'sha512'].includes(algorithm)) throw new EzTestError(`Unsupported TOTP algorithm ${algorithm}`, 'TOTP_OPTIONS');
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, keyOf(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = h.readUInt32BE(off) & 0x7fffffff;
  return (BigInt(bin) % 10n ** BigInt(digits)).toString().padStart(digits, '0');
}

export function totpCounter(o: TotpOptions = {}): bigint {
  const step = o.step ?? 30;
  if (!(step > 0)) throw new EzTestError('TOTP step must be positive', 'TOTP_OPTIONS');
  const ms = o.time === undefined ? Date.now() : o.time instanceof Date ? o.time.getTime() : o.time;
  const seconds = Math.floor(ms / 1000) - (o.epoch ?? 0);
  return BigInt(Math.floor(seconds / step));
}

/** Seconds left in the current TOTP window. */
export function totpSecondsRemaining(o: TotpOptions = {}): number {
  const step = o.step ?? 30;
  const ms = o.time === undefined ? Date.now() : o.time instanceof Date ? o.time.getTime() : o.time;
  const s = ms / 1000 - (o.epoch ?? 0);
  return step - (s % step);
}

/** TOTP code. `secret` is base32 text or raw key bytes. */
export function generateTotp(secret: string | Uint8Array, o: TotpOptions = {}): string {
  return generateHotp(secret, totpCounter(o), o);
}

/** The last code this process typed per secret (a hash of it, never the secret), with its window. */
const lastUsed = new Map<string, bigint>();
/** Markers of TOTP windows already used, shared by every EZTest process on this machine (workers, CLI runs). */
const WINDOWS_DIR = join(tmpdir(), 'ez-totp-windows');

/** Claim a window for a secret: false when any process already typed that window's code. */
async function claimWindow(key: string, counter: bigint): Promise<boolean> {
  await mkdir(WINDOWS_DIR, { recursive: true, mode: 0o700 });
  const file = join(WINDOWS_DIR, `${key.slice(0, 24)}-${counter}`);
  try {
    await writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    return true; // no shared marker possible (read-only temp): this process's memory still applies
  }
  // Markers of windows long past are no longer needed.
  for (const name of await readdir(WINDOWS_DIR).catch(() => [] as string[])) {
    const m = /^([0-9a-f]{24})-(\d+)$/.exec(name);
    if (m && m[1] === key.slice(0, 24) && BigInt(m[2]) < counter - 4n) await unlink(join(WINDOWS_DIR, name)).catch(() => undefined);
  }
  return true;
}

/**
 * A TOTP code that is safe to type now. Identity providers refuse a code that is about to expire, and most refuse
 * a code that was already used (Keycloak, Entra ID, Okta: "code reuse"), so this waits for the next window when
 * fewer than 3 seconds are left, or when an EZTest process on this machine already typed the current window's
 * code for this secret (two sign-ins, parallel workers, or a recording and its replay, within 30 seconds). The
 * windows used are marked in the temp folder by a hash of the secret, never the secret.
 */
export async function freshTotp(secret: string | Uint8Array, o: TotpOptions = {}): Promise<string> {
  const key = createHash('sha256').update(typeof secret === 'string' ? secret.replace(/[\s=-]/g, '').toUpperCase() : Buffer.from(secret)).digest('hex');
  const wait = (s: number) => new Promise((r) => setTimeout(r, Math.ceil(s * 1000) + 250));
  for (let tries = 0; ; tries++) {
    if (totpSecondsRemaining(o) < 3) await wait(totpSecondsRemaining(o));
    const counter = totpCounter(o);
    // With a fixed `time` (tests) there is no next window to wait for.
    if (o.time !== undefined || tries >= 3 || (lastUsed.get(key) !== counter && (await claimWindow(key, counter)))) {
      lastUsed.set(key, counter);
      return generateTotp(secret, o);
    }
    await wait(totpSecondsRemaining(o));
  }
}

/** Constant-time check of a code within +/- `window` steps (default 1). */
export function verifyTotp(code: string, secret: string | Uint8Array, o: TotpOptions & { window?: number } = {}): boolean {
  const digits = o.digits ?? 6;
  if (typeof code !== 'string' || !new RegExp(`^\\d{${digits}}$`).test(code)) return false;
  const c = totpCounter(o);
  const w = BigInt(o.window ?? 1);
  let ok = false;
  for (let i = -w; i <= w; i++) {
    if (c + i < 0n) continue;
    const expected = generateHotp(secret, c + i, o);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) ok = true;
  }
  return ok;
}
