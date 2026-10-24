/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as authenticator apps implement it. */
import { createHmac, randomInt } from 'node:crypto';

function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error('invalid base32 secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Accepts the current code and one step either side (clock drift). */
export function totpValid(secret: string, code: string, now = Date.now()): boolean {
  const c = Math.floor(now / 30_000);
  return [c - 1, c, c + 1].some((x) => totpAt(secret, x) === code.trim());
}

/** A six-digit one-time code for e-mailed links. */
export const oneTimeCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
